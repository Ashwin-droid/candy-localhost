// OAuth 2.1 authorization server for the public MCP endpoint.
//
// The unusual part: nobody types a password. An authorization request that
// arrives on the public host is parked here, and the browser is sent to a
// consent page on a private (tailnet-only) host. Being able to reach that
// page at all is the proof of identity. Approving there yields a one-time
// `grant`, which the browser carries back to the public host to finish the
// flow. The grant is what ties "someone on the tailnet said yes" to "this
// browser on the public side", so it is random, single-use and short-lived.
//
//   public  /authorize  -> startAuthorization()  -> requestId
//   private consent page -> getRequest(), decide() -> grant
//   public  /authorize/complete -> complete()     -> redirect back to the client
//   public  /token      -> token()
//   public  /mcp        -> verifyAccessToken()
//
// This module is pure protocol state and logic. The HTTP layer parses the
// request, calls one method, and sends what comes back:
//   - Result with `redirect` set  -> 302 to it (success or error alike)
//   - Result error without redirect -> show `status` + error to the person;
//     never redirect, because the redirect URI was not verified
//   - token() -> send `status` and `body` as JSON, with Cache-Control: no-store
//   - registerClient() success -> 201 with `client` as JSON
//
// What the MCP authorization spec expects and where it lives here:
//   public clients only (no client secrets), PKCE S256 mandatory, dynamic
//   client registration (RFC 7591), server metadata (RFC 8414), protected
//   resource metadata (RFC 9728), resource indicators (RFC 8707), `iss` in
//   the authorization response (RFC 9207), loopback redirects on any port
//   (RFC 8252), refresh token rotation with reuse detection (OAuth 2.1).
//
// Secrets (grants, codes, tokens) are never stored: only their sha256 hex
// hash is kept, and a presented secret is hashed and looked up by that hash.
// Where two secrets are compared directly, the comparison is constant-time.

import { timingSafeEqual } from "node:crypto"

// ----------------------------------------------------------------------------
// Lifetimes and limits
// ----------------------------------------------------------------------------

const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

export const REQUEST_LIFETIME_MS = 10 * MINUTE   // time to reach the consent page and decide
export const GRANT_LIFETIME_MS = 2 * MINUTE      // time to carry the grant back to the public host
export const CODE_LIFETIME_MS = 60 * SECOND
export const ACCESS_LIFETIME_MS = 60 * MINUTE
export const REFRESH_LIFETIME_MS = 30 * DAY
export const FAMILY_LIFETIME_MS = 90 * DAY       // one approval never lasts longer than this
export const MAX_CLIENTS = 100
export const MAX_PENDING = 50
export const MAX_REDIRECT_URIS = 10
export const MAX_STATE_LENGTH = 2048

const MAX_URI_LENGTH = 2048
const MAX_NAME_LENGTH = 100
const MAX_APPROVER_LENGTH = 200
const MAX_SECRET_LENGTH = 512   // anything longer cannot be one of ours; don't even hash it
const MAX_CODES = 100
// A redeemed code is remembered this long so that a second presentation can
// be recognised as a replay (and the tokens it produced revoked).
const CODE_REPLAY_MEMORY_MS = 10 * MINUTE
// Per approval ("family") we keep only this many rotated-away refresh tokens
// and live access tokens, so a client refreshing in a tight loop cannot grow
// memory or the persisted file without bound.
const MAX_ROTATED_PER_FAMILY = 10
const MAX_ACCESS_PER_FAMILY = 5
// lastUsedAt only moves in steps this big, so that ordinary API traffic
// doesn't turn into a disk write (onChange) per request.
const LAST_USED_RESOLUTION_MS = 5 * MINUTE
const SWEEP_INTERVAL_MS = MINUTE

const DEFAULT_CLIENT_NAME = "Unnamed client"
const GRANT_TYPES = ["authorization_code", "refresh_token"]
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface StoredClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  createdAt: number            // ms
  lastUsedAt: number | null    // ms, coarse (see LAST_USED_RESOLUTION_MS)
}

export interface StoredRefresh {
  hash: string                 // sha256 hex of the refresh token; the token itself is never kept
  clientId: string
  familyId: string             // every token descending from one approval shares this
  approver: string | null
  issuedAt: number             // ms
  expiresAt: number            // ms
  familyStartedAt: number      // ms, when the approval was turned into the first tokens
  rotated: boolean             // already exchanged for a newer one; seeing it again means theft
}

/** JSON-serializable. Token values appear only as sha256 hex hashes. */
export interface OAuthPersisted { clients: StoredClient[]; refreshTokens: StoredRefresh[] }

export interface OAuthOptions {
  issuer: string
  resource: string
  now?: () => number /* ms */
  persisted?: OAuthPersisted | null
  onChange?: (state: OAuthPersisted) => void
}

export type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; error_description: string; redirect?: string }

interface PendingRequest {
  clientId: string
  redirectUri: string          // exactly as the client sent it (loopback port included)
  challenge: string
  state: string | null
  createdAt: number
  expiresAt: number
  decided: boolean
  allow: boolean
  approver: string | null
  grantHash: string | null
}

interface AuthCode {
  clientId: string
  redirectUri: string
  challenge: string
  approver: string | null
  expiresAt: number
  forgetAt: number             // when the record itself is dropped (later than expiresAt once redeemed)
  redeemed: boolean
  familyId: string | null      // set on redemption, so a replay knows what to revoke
}

interface AccessToken {
  clientId: string
  familyId: string
  approver: string | null
  expiresAt: number
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** `bytes` of OS randomness as base64url. 32 bytes = 256 bits. */
const randomToken = (bytes: number): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")

const sha256 = (s: string): Buffer => Buffer.from(new Bun.CryptoHasher("sha256").update(s).digest())
const sha256Hex = (s: string): string => sha256(s).toString("hex")

/** Constant-time equality. Both sides are hashed first so lengths always match. */
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b))

const fail = (status: number, error: string, error_description: string, redirect?: string) =>
  ({ ok: false as const, status, error, error_description, ...(redirect ? { redirect } : {}) })

const oauthError = (status: number, error: string, error_description: string) =>
  ({ status, body: { error, error_description } })

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

/** Trim, drop control characters, cap the length. Returns "" for anything that isn't a string. */
const cleanText = (v: unknown, max: number): string => {
  if (typeof v !== "string") return ""
  const cleaned = v.slice(0, max * 10).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()
  return [...cleaned].slice(0, max).join("").trim()
}

/**
 * The value of a parameter that must appear exactly once. null when it is
 * missing, empty, repeated or longer than `max` -- all of which are simply
 * "not a usable value" to the caller.
 */
const single = (p: URLSearchParams, name: string, max: number): string | null => {
  const all = p.getAll(name)
  if (all.length !== 1) return null
  const v = all[0]
  return v.length > 0 && v.length <= max ? v : null
}

const parseUrl = (s: string): URL | null => {
  try { return new URL(s) } catch { return null }
}

const isLoopbackHttp = (u: URL): boolean => u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)

/**
 * Which redirect URIs a client may register. The code is delivered to this
 * URI, so it must be somewhere only the client can read:
 *   - https anywhere
 *   - plain http only on this machine's loopback (native apps, RFC 8252)
 *   - a private-use scheme, which by convention is a reversed domain name and
 *     so contains a dot (com.example.app:/cb). The dot rule also keeps out
 *     javascript:, data:, file: and friends without needing a deny list.
 * No fragment (OAuth forbids it) and no embedded credentials.
 */
const validRedirectUri = (v: unknown): v is string => {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_URI_LENGTH) return false
  if (v.includes("#") || /[\u0000- \u007f-\u009f]/.test(v)) return false
  const u = parseUrl(v)
  if (!u || u.username || u.password) return false
  if (u.protocol === "https:") return u.hostname.length > 0
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname)
  return u.protocol.includes(".")
}

/**
 * Exact string match against the registered list. The one exception, from
 * RFC 8252: a native app listening on loopback picks a free port at runtime,
 * so for http loopback URIs everything except the port must match.
 */
const redirectUriAllowed = (presented: string, registered: string[]): boolean => {
  if (registered.includes(presented)) return true
  if (presented.includes("#")) return false
  const p = parseUrl(presented)
  if (!p || !isLoopbackHttp(p) || p.username || p.password) return false
  return registered.some(r => {
    const u = parseUrl(r)
    return !!u && isLoopbackHttp(u) && u.hostname === p.hostname && u.pathname === p.pathname && u.search === p.search
  })
}

const withParams = (uri: string, params: Record<string, string | null>): string => {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v)
  return u.toString()
}

const stripSlash = (s: string): string => s.replace(/\/$/, "")

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

// ----------------------------------------------------------------------------
// Server
// ----------------------------------------------------------------------------

export class OAuthServer {
  private issuer: string
  private resource: string
  private now: () => number
  private onChange: ((state: OAuthPersisted) => void) | undefined

  // Maps keep insertion order, which is what "oldest" means below.
  private clients = new Map<string, StoredClient>()
  private refresh = new Map<string, StoredRefresh>()   // by token hash
  private access = new Map<string, AccessToken>()      // by token hash; memory only
  private pending = new Map<string, PendingRequest>()  // by request id
  private codes = new Map<string, AuthCode>()          // by code hash
  private lastSweep = 0

  constructor(opts: OAuthOptions) {
    this.issuer = stripSlash(String(opts?.issuer ?? ""))
    this.resource = String(opts?.resource ?? "")
    this.now = typeof opts?.now === "function" ? opts.now : Date.now
    this.onChange = typeof opts?.onChange === "function" ? opts.onChange : undefined
    try { this.load(opts?.persisted) } catch { /* a corrupt file means starting empty, not crashing */ }
  }

  /** Takes whatever was on disk and keeps only the entries that are well-formed. */
  private load(state: OAuthPersisted | null | undefined) {
    if (!state || typeof state !== "object") return
    const now = this.now()
    for (const c of Array.isArray(state.clients) ? state.clients : []) {
      if (this.clients.size >= MAX_CLIENTS) break
      if (!c || typeof c.clientId !== "string" || !c.clientId || typeof c.clientName !== "string") continue
      if (!Array.isArray(c.redirectUris) || !c.redirectUris.every(validRedirectUri) || !finite(c.createdAt)) continue
      this.clients.set(c.clientId, {
        clientId: c.clientId,
        clientName: c.clientName,
        redirectUris: [...c.redirectUris],
        createdAt: c.createdAt,
        lastUsedAt: finite(c.lastUsedAt) ? c.lastUsedAt : null,
      })
    }
    for (const r of Array.isArray(state.refreshTokens) ? state.refreshTokens : []) {
      if (!r || typeof r.hash !== "string" || !SHA256_HEX.test(r.hash)) continue
      if (typeof r.clientId !== "string" || !this.clients.has(r.clientId) || typeof r.familyId !== "string") continue
      if (!finite(r.issuedAt) || !finite(r.expiresAt) || !finite(r.familyStartedAt) || r.expiresAt <= now) continue
      this.refresh.set(r.hash, {
        hash: r.hash,
        clientId: r.clientId,
        familyId: r.familyId,
        approver: typeof r.approver === "string" ? r.approver : null,
        issuedAt: r.issuedAt,
        expiresAt: r.expiresAt,
        familyStartedAt: r.familyStartedAt,
        rotated: r.rotated === true,
      })
    }
  }

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------

  /** RFC 9728: tells a client which authorization server guards this resource. */
  protectedResourceMetadata(): object {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
    }
  }

  /** RFC 8414. */
  authorizationServerMetadata(): object {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: [...GRANT_TYPES],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    }
  }

  // --------------------------------------------------------------------------
  // Dynamic client registration (RFC 7591)
  // --------------------------------------------------------------------------

  /**
   * Anyone on the internet can call this, so a registration is worth nothing
   * by itself: it only names a set of redirect URIs. Whatever the client asks
   * for, it is a public client with no secret.
   */
  registerClient(body: unknown): Result<{ client: object }> {
    try {
      this.maybeSweep()
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return fail(400, "invalid_client_metadata", "Registration body must be a JSON object")
      }
      const meta = body as Record<string, unknown>
      const uris = meta.redirect_uris
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
        return fail(400, "invalid_redirect_uri", `redirect_uris must be an array of 1 to ${MAX_REDIRECT_URIS} URIs`)
      }
      if (!uris.every(validRedirectUri)) {
        return fail(400, "invalid_redirect_uri",
          "Each redirect URI must be https, http on localhost, or a private-use scheme, with no fragment")
      }
      if (this.clients.size >= MAX_CLIENTS && !this.evictIdleClient()) {
        return fail(400, "invalid_client_metadata", "Client limit reached and every registered client is in use")
      }

      const now = this.now()
      const client: StoredClient = {
        clientId: randomToken(18),
        clientName: cleanText(meta.client_name, MAX_NAME_LENGTH) || DEFAULT_CLIENT_NAME,
        redirectUris: [...new Set(uris)],
        createdAt: now,
        lastUsedAt: null,
      }
      this.clients.set(client.clientId, client)
      this.changed()
      return {
        ok: true,
        client: {
          client_id: client.clientId,
          client_id_issued_at: Math.floor(now / 1000),
          redirect_uris: [...client.redirectUris],
          client_name: client.clientName,
          grant_types: [...GRANT_TYPES],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      }
    } catch {
      return fail(400, "invalid_client_metadata", "Malformed registration request")
    }
  }

  /**
   * Makes room for a new registration by dropping the client that has gone
   * unused the longest. A client someone has approved (live refresh token)
   * is never dropped, and neither is one in the middle of being approved --
   * otherwise a burst of junk registrations could cancel a real sign-in.
   */
  private evictIdleClient(): boolean {
    const now = this.now()
    const inUse = new Set<string>()
    for (const r of this.refresh.values()) if (!r.rotated && r.expiresAt > now) inUse.add(r.clientId)
    for (const p of this.pending.values()) if (p.expiresAt > now) inUse.add(p.clientId)
    for (const c of this.codes.values()) if (!c.redeemed && c.expiresAt > now) inUse.add(c.clientId)

    let victim: StoredClient | null = null
    for (const c of this.clients.values()) {
      if (inUse.has(c.clientId)) continue
      if (!victim || (c.lastUsedAt ?? c.createdAt) < (victim.lastUsedAt ?? victim.createdAt)) victim = c
    }
    if (!victim) return false
    this.dropClient(victim.clientId)
    return true
  }

  // --------------------------------------------------------------------------
  // Authorization: park, decide, complete
  // --------------------------------------------------------------------------

  /**
   * Validates an authorization request and parks it for the consent page.
   *
   * Order matters. Until the client and its redirect URI are verified, errors
   * are shown to the person and never redirected: sending a browser to a URI
   * we haven't checked would make this server an open redirector. After that,
   * errors go back to the client via its redirect URI, as OAuth prescribes.
   */
  startAuthorization(params: URLSearchParams): Result<{ requestId: string }> {
    try {
      if (!(params instanceof URLSearchParams)) return fail(400, "invalid_request", "Malformed authorization request")
      this.maybeSweep()

      const clientId = single(params, "client_id", MAX_SECRET_LENGTH)
      const client = clientId ? this.clients.get(clientId) : undefined
      if (!client) return fail(400, "invalid_client", "Unknown client_id")

      const redirectUri = single(params, "redirect_uri", MAX_URI_LENGTH)
      if (!redirectUri || !redirectUriAllowed(redirectUri, client.redirectUris)) {
        return fail(400, "invalid_request", "redirect_uri does not match a registered redirect URI")
      }

      // An oversized or repeated state can't be echoed back, so the error goes without it.
      const states = params.getAll("state")
      const stateOk = states.length === 0 || (states.length === 1 && states[0].length <= MAX_STATE_LENGTH)
      const state = stateOk && states.length === 1 ? states[0] : null
      const bounce = (error: string, description: string) =>
        fail(302, error, description, withParams(redirectUri, { error, error_description: description, state, iss: this.issuer }))

      if (!stateOk) return bounce("invalid_request", `state must appear once and be at most ${MAX_STATE_LENGTH} characters`)
      if (params.getAll("response_type").length !== 1) return bounce("invalid_request", "response_type is required")
      if (params.get("response_type") !== "code") return bounce("unsupported_response_type", "Only response_type=code is supported")

      // PKCE is not optional: these are public clients, so the code alone must be useless to a thief.
      const challenge = single(params, "code_challenge", 128)
      if (!challenge || !PKCE_CHALLENGE.test(challenge)) {
        return bounce("invalid_request", "code_challenge is required: 43 to 128 base64url characters")
      }
      if (single(params, "code_challenge_method", 16) !== "S256") {
        return bounce("invalid_request", "code_challenge_method must be S256")
      }

      // RFC 8707: a token minted here is only good for our one resource. A
      // client asking for a different one is confused or being tricked.
      if (!this.resourceOk(params)) return bounce("invalid_target", "resource does not match this server")

      const now = this.now()
      const requestId = randomToken(18)
      this.pending.set(requestId, {
        clientId: client.clientId,
        redirectUri,
        challenge,
        state,
        createdAt: now,
        expiresAt: now + REQUEST_LIFETIME_MS,
        decided: false,
        allow: false,
        approver: null,
        grantHash: null,
      })
      this.trimPending()
      return { ok: true, requestId }
    } catch {
      return fail(400, "invalid_request", "Malformed authorization request")
    }
  }

  private resourceOk(params: URLSearchParams): boolean {
    const want = stripSlash(this.resource)
    return params.getAll("resource").every(r => r.length <= MAX_URI_LENGTH && stripSlash(r) === want)
  }

  /**
   * Starting a request is unauthenticated, so the parking lot has a hard cap.
   * Requests nobody has decided yet go first (oldest first): one that a person
   * has already approved is worth more than one that may be noise.
   */
  private trimPending() {
    while (this.pending.size > MAX_PENDING) {
      let victim: string | null = null
      for (const [id, p] of this.pending) if (!p.decided) { victim = id; break }
      victim ??= this.pending.keys().next().value ?? null
      if (victim === null) break
      this.pending.delete(victim)
    }
  }

  /** A live pending request, or null. Expired ones are dropped on the way. */
  private livePending(requestId: unknown): PendingRequest | null {
    if (typeof requestId !== "string" || requestId.length > MAX_SECRET_LENGTH) return null
    const p = this.pending.get(requestId)
    if (!p) return null
    if (p.expiresAt <= this.now() || !this.clients.has(p.clientId)) {
      this.pending.delete(requestId)
      return null
    }
    return p
  }

  /** What the consent page needs to show. */
  getRequest(requestId: string): { clientId: string; clientName: string; redirectUri: string; createdAt: number; expiresAt: number; decided: boolean } | null {
    try {
      this.maybeSweep()
      const p = this.livePending(requestId)
      if (!p) return null
      return {
        clientId: p.clientId,
        clientName: this.clients.get(p.clientId)!.clientName,
        redirectUri: p.redirectUri,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        decided: p.decided,
      }
    } catch {
      return null
    }
  }

  /**
   * Called from the private consent page. The caller is trusted because of
   * where it can be reached from, not because of anything in the arguments.
   * A request can be decided once; the returned grant is the only way to
   * finish it, and only for the next two minutes.
   */
  decide(requestId: string, allow: boolean, approver?: string): Result<{ grant: string }> {
    try {
      this.maybeSweep()
      if (typeof allow !== "boolean") return fail(400, "invalid_request", "allow must be true or false")
      const p = this.livePending(requestId)
      if (!p) return fail(404, "invalid_request", "Unknown or expired authorization request")
      if (p.decided) return fail(409, "invalid_request", "This authorization request was already decided")

      const grant = randomToken(32)
      p.decided = true
      p.allow = allow
      p.approver = cleanText(approver, MAX_APPROVER_LENGTH) || null
      p.grantHash = sha256Hex(grant)
      p.expiresAt = this.now() + GRANT_LIFETIME_MS
      return { ok: true, grant }
    } catch {
      return fail(400, "invalid_request", "Malformed decision")
    }
  }

  /**
   * Back on the public host: trades the grant for the redirect to the client.
   * A wrong grant leaves the request untouched -- request ids travel in URLs,
   * and someone who merely saw one must not be able to cancel the sign-in.
   */
  complete(requestId: string, grant: string): Result<{ redirect: string }> {
    try {
      this.maybeSweep()
      const p = this.livePending(requestId)
      if (!p) return fail(404, "invalid_request", "Unknown or expired authorization request")
      if (!p.decided || !p.grantHash) return fail(409, "invalid_request", "This authorization request has not been decided yet")
      if (typeof grant !== "string" || grant.length > MAX_SECRET_LENGTH || !sameSecret(sha256Hex(grant), p.grantHash)) {
        return fail(403, "access_denied", "Invalid grant")
      }
      this.pending.delete(requestId)

      if (!p.allow) {
        const description = "The request was denied"
        return {
          ok: true,
          redirect: withParams(p.redirectUri, { error: "access_denied", error_description: description, state: p.state, iss: this.issuer }),
        }
      }

      const now = this.now()
      const code = randomToken(32)
      this.codes.set(sha256Hex(code), {
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        challenge: p.challenge,
        approver: p.approver,
        expiresAt: now + CODE_LIFETIME_MS,
        forgetAt: now + CODE_LIFETIME_MS,
        redeemed: false,
        familyId: null,
      })
      while (this.codes.size > MAX_CODES) this.codes.delete(this.codes.keys().next().value!)
      return { ok: true, redirect: withParams(p.redirectUri, { code, state: p.state, iss: this.issuer }) }
    } catch {
      return fail(400, "invalid_request", "Malformed completion request")
    }
  }

  // --------------------------------------------------------------------------
  // Token endpoint
  // --------------------------------------------------------------------------

  /** Returns the status and JSON body to send. Errors follow RFC 6749 section 5.2. */
  token(form: URLSearchParams): { status: number; body: object } {
    try {
      if (!(form instanceof URLSearchParams)) return oauthError(400, "invalid_request", "Malformed token request")
      this.maybeSweep()
      const grantType = single(form, "grant_type", 64)
      if (!grantType) return oauthError(400, "invalid_request", "grant_type is required")
      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        return oauthError(400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported")
      }
      const clientId = single(form, "client_id", MAX_SECRET_LENGTH)
      if (!clientId) return oauthError(400, "invalid_request", "client_id is required")
      const client = this.clients.get(clientId)
      if (!client) return oauthError(401, "invalid_client", "Unknown client_id")
      if (!this.resourceOk(form)) return oauthError(400, "invalid_target", "resource does not match this server")

      return grantType === "authorization_code" ? this.redeemCode(form, client) : this.rotateRefresh(form, client)
    } catch {
      return oauthError(400, "invalid_request", "Malformed token request")
    }
  }

  private redeemCode(form: URLSearchParams, client: StoredClient): { status: number; body: object } {
    const code = single(form, "code", MAX_SECRET_LENGTH)
    const redirectUri = single(form, "redirect_uri", MAX_URI_LENGTH)
    const verifier = single(form, "code_verifier", 128)
    if (!code || !redirectUri || !verifier) {
      return oauthError(400, "invalid_request", "code, redirect_uri and code_verifier are required")
    }
    const bad = () => oauthError(400, "invalid_grant", "Authorization code is invalid, expired or already used")

    const now = this.now()
    const hash = sha256Hex(code)
    const entry = this.codes.get(hash)
    if (!entry) return bad()

    // Seeing a code twice means it leaked: one of the two presenters is not
    // the client. We can't tell which, so everything it produced is revoked.
    if (entry.redeemed) {
      if (entry.familyId) this.revokeFamily(entry.familyId)
      this.codes.delete(hash)
      return bad()
    }
    if (entry.expiresAt <= now) {
      this.codes.delete(hash)
      return bad()
    }
    // Failures below leave the code usable: none of them can be passed by
    // guessing (the verifier has 256 bits), and the code dies in 60s anyway.
    if (entry.clientId !== client.clientId || entry.redirectUri !== redirectUri) return bad()
    if (!PKCE_VERIFIER.test(verifier)) return oauthError(400, "invalid_grant", "code_verifier does not match the code_challenge")
    if (!sameSecret(sha256(verifier).toString("base64url"), entry.challenge)) {
      return oauthError(400, "invalid_grant", "code_verifier does not match the code_challenge")
    }

    const familyId = randomToken(18)
    entry.redeemed = true
    entry.familyId = familyId
    entry.forgetAt = now + CODE_REPLAY_MEMORY_MS
    return this.issueTokens(client, familyId, now, entry.approver)
  }

  private rotateRefresh(form: URLSearchParams, client: StoredClient): { status: number; body: object } {
    const token = single(form, "refresh_token", MAX_SECRET_LENGTH)
    if (!token) return oauthError(400, "invalid_request", "refresh_token is required")
    const bad = () => oauthError(400, "invalid_grant", "Refresh token is invalid, expired or revoked")

    const now = this.now()
    const hash = sha256Hex(token)
    const entry = this.refresh.get(hash)
    if (!entry || entry.clientId !== client.clientId) return bad()
    if (entry.expiresAt <= now) {
      this.refresh.delete(hash)
      this.changed()
      return bad()
    }
    // A refresh token is used exactly once. If an old one shows up again,
    // either the client or a thief is holding a stale copy, and the other one
    // holds the live token. Ending the whole family forces a fresh approval.
    if (entry.rotated) {
      this.revokeFamily(entry.familyId)
      return bad()
    }

    entry.rotated = true
    return this.issueTokens(client, entry.familyId, entry.familyStartedAt, entry.approver)
  }

  private issueTokens(client: StoredClient, familyId: string, familyStartedAt: number, approver: string | null) {
    const now = this.now()
    const accessToken = randomToken(32)
    const refreshToken = randomToken(32)
    this.access.set(sha256Hex(accessToken), { clientId: client.clientId, familyId, approver, expiresAt: now + ACCESS_LIFETIME_MS })
    const refreshHash = sha256Hex(refreshToken)
    this.refresh.set(refreshHash, {
      hash: refreshHash,
      clientId: client.clientId,
      familyId,
      approver,
      issuedAt: now,
      // Rotation keeps a session alive, but not forever: an approval is
      // re-confirmed by a person at least every 90 days.
      expiresAt: Math.min(now + REFRESH_LIFETIME_MS, familyStartedAt + FAMILY_LIFETIME_MS),
      familyStartedAt,
      rotated: false,
    })
    this.trimFamily(familyId)
    client.lastUsedAt = now
    this.changed()
    return {
      status: 200,
      body: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_LIFETIME_MS / 1000,
        refresh_token: refreshToken,
      },
    }
  }

  /** Keeps one family from piling up rotated refresh tokens or access tokens; oldest go first. */
  private trimFamily(familyId: string) {
    const rotated: string[] = []
    for (const r of this.refresh.values()) if (r.familyId === familyId && r.rotated) rotated.push(r.hash)
    for (const hash of rotated.slice(0, Math.max(0, rotated.length - MAX_ROTATED_PER_FAMILY))) this.refresh.delete(hash)

    const live: string[] = []
    for (const [hash, a] of this.access) if (a.familyId === familyId) live.push(hash)
    for (const hash of live.slice(0, Math.max(0, live.length - MAX_ACCESS_PER_FAMILY))) this.access.delete(hash)
  }

  private revokeFamily(familyId: string) {
    let removed = false
    for (const [hash, r] of this.refresh) if (r.familyId === familyId) { this.refresh.delete(hash); removed = true }
    for (const [hash, a] of this.access) if (a.familyId === familyId) this.access.delete(hash)
    if (removed) this.changed()
  }

  // --------------------------------------------------------------------------
  // Resource server side
  // --------------------------------------------------------------------------

  /** Who a bearer token belongs to, or null if it isn't a live token of ours. */
  verifyAccessToken(token: string): { clientId: string; clientName: string; approver: string | null; expiresAt: number } | null {
    try {
      this.maybeSweep()
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_SECRET_LENGTH) return null
      const hash = sha256Hex(token)
      const entry = this.access.get(hash)
      if (!entry) return null
      const now = this.now()
      const client = this.clients.get(entry.clientId)
      if (entry.expiresAt <= now || !client) {
        this.access.delete(hash)
        return null
      }
      if (client.lastUsedAt === null || now - client.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
        client.lastUsedAt = now
        this.changed()
      }
      return { clientId: client.clientId, clientName: client.clientName, approver: entry.approver, expiresAt: entry.expiresAt }
    } catch {
      return null
    }
  }

  // --------------------------------------------------------------------------
  // Administration
  // --------------------------------------------------------------------------

  /** `activeGrants` counts approvals that can still be refreshed. */
  listClients(): { clientId: string; clientName: string; createdAt: number; lastUsedAt: number | null; activeGrants: number }[] {
    try {
      this.maybeSweep()
      const now = this.now()
      const grants = new Map<string, number>()
      for (const r of this.refresh.values()) {
        if (!r.rotated && r.expiresAt > now) grants.set(r.clientId, (grants.get(r.clientId) ?? 0) + 1)
      }
      return [...this.clients.values()].map(c => ({
        clientId: c.clientId,
        clientName: c.clientName,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        activeGrants: grants.get(c.clientId) ?? 0,
      }))
    } catch {
      return []
    }
  }

  /** Deletes the client and everything that hangs off it. False if there was no such client. */
  revokeClient(clientId: string): boolean {
    try {
      if (typeof clientId !== "string" || !this.clients.has(clientId)) return false
      this.dropClient(clientId)
      this.changed()
      return true
    } catch {
      return false
    }
  }

  private dropClient(clientId: string) {
    this.clients.delete(clientId)
    for (const [k, v] of this.refresh) if (v.clientId === clientId) this.refresh.delete(k)
    for (const [k, v] of this.access) if (v.clientId === clientId) this.access.delete(k)
    for (const [k, v] of this.pending) if (v.clientId === clientId) this.pending.delete(k)
    for (const [k, v] of this.codes) if (v.clientId === clientId) this.codes.delete(k)
  }

  /** The panic button: every client, token, pending request and code is gone. */
  revokeAll(): void {
    this.clients.clear()
    this.refresh.clear()
    this.access.clear()
    this.pending.clear()
    this.codes.clear()
    this.changed()
  }

  // --------------------------------------------------------------------------
  // Housekeeping and persistence
  // --------------------------------------------------------------------------

  /**
   * Drops everything that has expired. Each lookup already checks the expiry
   * of the thing it touches; this catches what nobody ever came back for.
   * It also runs by itself at most once a minute from the public methods, so
   * calling it on a timer is optional.
   */
  sweep(): void {
    try {
      const now = this.now()
      this.lastSweep = now
      for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k)
      for (const [k, v] of this.codes) if (v.forgetAt <= now) this.codes.delete(k)
      for (const [k, v] of this.access) if (v.expiresAt <= now) this.access.delete(k)
      let removed = false
      for (const [k, v] of this.refresh) if (v.expiresAt <= now) { this.refresh.delete(k); removed = true }
      if (removed) this.changed()
    } catch { /* never let housekeeping break a request */ }
  }

  private maybeSweep() {
    const now = this.now()
    // The second test covers a clock that jumped backwards.
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS || now < this.lastSweep) this.sweep()
  }

  /** What to write to disk. Access tokens, pending requests and codes are deliberately absent. */
  persisted(): OAuthPersisted {
    return {
      clients: [...this.clients.values()].map(c => ({ ...c, redirectUris: [...c.redirectUris] })),
      refreshTokens: [...this.refresh.values()].map(r => ({ ...r })),
    }
  }

  /** Saving is the caller's job and its failures are the caller's to report; they must not turn into a failed login. */
  private changed() {
    if (!this.onChange) return
    try { this.onChange(this.persisted()) } catch { /* see above */ }
  }
}
