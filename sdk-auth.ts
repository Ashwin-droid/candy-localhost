// "Sign in with candy", the app side. An app hosted on candy sends the browser
// to the portal, the user logs in there (PAM or passkey) and approves the app,
// and the browser comes back with a one-shot JWE that only this site's key opens.
// Spec: SDK_AUTH_DESIGN.md, section E.
//
// Works in a plain Bun server and inside a candy function (fn-host loads it in
// the sandbox), so it imports nothing daemon-side: jwe.ts only.
//
//   const auth = createAppAuth()
//   const r = await auth.handle(request, (u) => {
//     // issue a FRESH session id here (no session fixation), then:
//     return redirectAfterLogin(u.next, `sid=${newSessionFor(u.user)}; Path=/; Secure; HttpOnly; SameSite=Lax`)
//   })
//   if (r) return r
//   // ...; send unauthenticated users to /_candy/auth/login?next=/where
import { readFileSync } from "node:fs"
import {
  openClaims, parseKeyRing, JweError, randomB64url, b64urlEncode, b64urlDecode,
  STATE_RE, NONCE_RE, SITE_RE, CLOCK_SKEW_S,
  type JweErrorCode, type Amr, type AppClaims, type JweKey,
} from "./jwe.ts"

export const LOGIN_PATH = "/_candy/auth/login"
export const CALLBACK_PATH = "/_candy/auth/callback"
export const STATE_COOKIE = "__Host-candy_auth"
export const STATE_COOKIE_MAX_AGE_S = 600
export const CREDENTIAL_NAME = "candy-auth-keys"          // $CREDENTIALS_DIRECTORY/<this>
export const ENV = { site: "CANDY_AUTH_SITE", url: "CANDY_AUTH_URL", issuers: "CANDY_AUTH_ISSUERS", keys: "CANDY_AUTH_KEYS" } as const
export const DEFAULT_ISSUERS = ["https://portal.localhost", "https://portal.candy"]
export const MAX_CALLBACK_BODY = 8192
export const MAX_COOKIE_LENGTH = 3000
export const REFETCH_MIN_INTERVAL_MS = 30_000
/** With a fetchKeys, the ring is fetched again once it is this old (shorter than the daemon's 10 min rotation overlap) */
export const RING_REFRESH_MS = 5 * 60_000
export const MAX_REPLAY_ENTRIES = 10_000

const DEFAULT_PORTAL = "https://portal.localhost"
const MAX_SITE_LENGTH = 128
const MAX_NEXT_LENGTH = 1024
const MAX_DEST_LENGTH = 2048
const MAX_CREDENTIAL_BYTES = 8192

export type AuthErrorCode = JweErrorCode | "replay" | "state" | "nonce" | "dest" | "no_keys" | "denied" | "bad_request"
export interface AuthUser { user: string; amr: Amr[]; authTime: number /* ms */; claims: AppClaims }
export type VerifyResult = ({ ok: true } & AuthUser) | { ok: false; error: AuthErrorCode; message: string }
export type CallbackResult =
  | ({ ok: true; next: string; clearCookie: string } & AuthUser)
  | { ok: false; status: 400 | 401 | 403; error: AuthErrorCode; message: string; clearCookie: string }

export interface ReplayStore { checkAndRecord(jti: string, expiresAtMs: number): boolean | Promise<boolean> }  // true = first time

// Messages are fixed per code: they never carry the token, a key or a claim value.
const MESSAGES: Record<AuthErrorCode, string> = {
  malformed: "The sign-in token is malformed.",
  unsupported: "The sign-in token uses an unsupported format.",
  unknown_kid: "The sign-in token was made with a key this app doesn't have.",
  decrypt: "The sign-in token could not be decrypted.",
  expired: "The sign-in token expired. Try signing in again.",
  not_yet_valid: "The sign-in token isn't valid yet. Check this machine's clock.",
  audience: "The sign-in token is for another site.",
  issuer: "The sign-in token comes from a portal this app doesn't trust.",
  claims: "The sign-in token has invalid contents.",
  replay: "That sign-in token was already used. Try signing in again.",
  state: "The sign-in doesn't match this browser. Try signing in again.",
  nonce: "The sign-in token doesn't match this sign-in attempt.",
  dest: "The sign-in token was made for another address.",
  no_keys: "This app has no candy auth key.",
  denied: "Signing in was cancelled.",
  bad_request: "Bad sign-in request.",
}

const fail = (error: AuthErrorCode, message?: string): { ok: false; error: AuthErrorCode; message: string } =>
  ({ ok: false, error, message: message ?? MESSAGES[error] })

// Constant-time for equal lengths; lengths aren't secret here
const sameString = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The jti cache. Per process (D11): a function pool or a multi-process app
 * accepts a token once per process. The __Host- state cookie is what stops a
 * token being used from another browser; plug in a shared store for more.
 */
export class ReplayCache implements ReplayStore {
  private seen = new Map<string, number>()

  constructor(private readonly max: number = MAX_REPLAY_ENTRIES, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("ReplayCache: max must be a positive integer")
  }

  checkAndRecord(jti: string, expiresAtMs: number): boolean {
    if (typeof jti !== "string" || jti.length === 0) return false
    const now = this.now()
    const known = this.seen.get(jti)
    if (known !== undefined && known > now) return false
    this.seen.delete(jti)
    if (this.seen.size >= this.max) this.sweep(now)
    if (this.seen.size >= this.max) {
      // Full of live entries: drop the one that expires soonest
      let soonest: string | null = null
      let at = Infinity
      for (const [k, exp] of this.seen) if (exp < at) { at = exp; soonest = k }
      if (soonest !== null) this.seen.delete(soonest)
    }
    this.seen.set(jti, Number.isFinite(expiresAtMs) ? expiresAtMs : now)
    return true
  }

  private sweep(now: number): void {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k)
  }

  get size(): number { return this.seen.size }
}

export interface AppAuthOptions {
  site?: string                                    // default env CANDY_AUTH_SITE; required in the end (throws "candy auth: no site name")
  portal?: string                                  // fallback portal origin; default env CANDY_AUTH_URL, else "https://portal.localhost"
  issuers?: string[]                               // default env CANDY_AUTH_ISSUERS (comma list), else DEFAULT_ISSUERS
  keys?: string                                    // a ring string (formatKeyRing); default credential file, then env CANDY_AUTH_KEYS
  fetchKeys?: (site: string) => Promise<string>    // fetches the ring again (sdk.ts supplies the daemon fetcher); used when none is configured, or on unknown_kid
  replay?: ReplayStore                             // default new ReplayCache()
  env?: Record<string, string | undefined>         // default process.env
  readFile?: (path: string) => string | null       // default: readFileSync utf8, null on error
  now?: () => number
}

export interface AppAuth {
  readonly site: string
  loginUrl(o: { returnTo: string; state: string; nonce?: string; portal?: string }): string
  login(request: Request, o?: { next?: string; portal?: string }): Promise<Response>
  verify(token: string, expect?: { state?: string; nonce?: string; dest?: string }): Promise<VerifyResult>
  handleCallback(request: Request): Promise<CallbackResult>
  handle(request: Request, onLogin: (u: AuthUser & { next: string }, request: Request) => Response | Promise<Response>): Promise<Response | null>
}

// "https://host" with nothing else: no path, query, fragment, port or userinfo
const portalOrigin = (value: string, what: string): string => {
  let u: URL
  try { u = new URL(value) } catch { throw new Error(`candy auth: ${what} must be an https:// origin`) }
  const bare = value.replace(/\/$/, "")
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash
    || (u.pathname !== "/" && u.pathname !== "") || bare.toLowerCase() !== u.origin) {
    throw new Error(`candy auth: ${what} must be an https:// origin with no path or port`)
  }
  return u.origin
}

// Host names a candy site can have: lower-case DNS-ish labels (site names allow "_")
const HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/

/** "https://" + the Host header, lower case, ":443" stripped. Throws on a missing or invalid Host (any other port included). */
export const requestOrigin = (request: Request): string => {
  const raw = request.headers.get("host")
  if (!raw) throw new Error("candy auth: the request has no Host header")
  let host = raw.trim().toLowerCase()
  if (host.endsWith(":443")) host = host.slice(0, -4)
  if (host.length === 0 || host.length > 253 || !HOST_RE.test(host)) throw new Error("candy auth: the request's Host header is not a host name candy serves")
  return `https://${host}`
}

/** The portal for a site host: *.localhost → https://portal.localhost; *.candy → https://portal.candy; else fallback. */
export const portalForHost = (host: string, fallback: string): string => {
  const h = String(host || "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
  if (h === "localhost" || h.endsWith(".localhost")) return "https://portal.localhost"
  if (h === "candy" || h.endsWith(".candy")) return "https://portal.candy"
  return fallback
}

/** A same-origin path (+ query) to go to after login; "/" for anything else. Own copy of portal-auth safeNext. */
export const safeAppPath = (next: unknown): string => {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/"
  if (/[\u0000-\u001f\u007f\\]/.test(next) || next.length > MAX_NEXT_LENGTH) return "/"
  try {
    const base = "https://app.invalid"
    const u = new URL(next, base)
    if (u.origin !== base) return "/"
    // Never loop back into the sign-in itself
    if (u.pathname === LOGIN_PATH || u.pathname === CALLBACK_PATH) return "/"
    const out = u.pathname + u.search
    // "/.//evil.com" normalizes to "//evil.com": protocol-relative, so check again
    if (out.startsWith("//") || out.startsWith("/\\") || new URL(out, base).origin !== base) return "/"
    return out
  } catch {
    return "/"
  }
}

/** 303 to a same-origin path after login, with the app's own session cookie(s). */
export const redirectAfterLogin = (next: string, setCookie?: string | string[]): Response => {
  const headers = new Headers({ Location: safeAppPath(next), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
  for (const c of setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]) headers.append("Set-Cookie", c)
  return new Response(null, { status: 303, headers })
}

const stateCookie = (value: string): string =>
  `${STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${STATE_COOKIE_MAX_AGE_S}`
const CLEAR_COOKIE = `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`

// What this browser started: state, nonce, where to go after, when. Not where
// the token may arrive: that is the callback URL itself (handleCallback)
interface StateCookie { s: string; n: string; x: string; t: number }

// https://<host>/_candy/auth/callback exactly: the only return_to the portal accepts
const isCallbackUrl = (s: string): boolean => {
  try {
    const u = new URL(s)
    return u.href === `${u.origin}${CALLBACK_PATH}` && !u.port && !s.includes("?") && !s.includes("#")
  } catch {
    return false
  }
}

const isHttpsUrl = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_DEST_LENGTH) return false
  try {
    const u = new URL(s)
    return u.protocol === "https:" && !u.username && !u.password
  } catch {
    return false
  }
}

// Every __Host-candy_auth value in the Cookie header(s)
const cookieValues = (request: Request): string[] => {
  const out: string[] = []
  const header = request.headers.get("cookie") || ""
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === STATE_COOKIE) out.push(part.slice(eq + 1).trim())
  }
  return out
}

const readStateCookie = (request: Request, nowMs: number): StateCookie | null => {
  const values = cookieValues(request)
  if (values.length !== 1) return null              // none, or ambiguous
  const raw = values[0]
  if (raw.length === 0 || raw.length > MAX_COOKIE_LENGTH) return null
  try {
    const obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b64urlDecode(raw)))
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj.v !== 1) return null
    const { s, n, x, t } = obj
    if (typeof s !== "string" || !STATE_RE.test(s)) return null
    if (typeof n !== "string" || !NONCE_RE.test(n)) return null
    if (typeof x !== "string") return null
    if (!Number.isSafeInteger(t) || t < 0) return null
    if (nowMs - t > STATE_COOKIE_MAX_AGE_S * 1000 || t > nowMs + CLOCK_SKEW_S * 1000) return null
    return { s, n, x: safeAppPath(x), t }
  } catch {
    return null
  }
}

// The form body, at most MAX_CALLBACK_BODY bytes: Content-Length first, then counted
const readFormBody = async (request: Request): Promise<URLSearchParams | null> => {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
  if (type !== "application/x-www-form-urlencoded") return null
  const declared = request.headers.get("content-length")
  if (declared !== null && (!/^\d{1,10}$/.test(declared.trim()) || Number(declared.trim()) > MAX_CALLBACK_BODY)) return null
  const chunks: Uint8Array[] = []
  let total = 0
  if (request.body) {
    const reader = request.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_CALLBACK_BODY) {
          reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    } catch {
      return null
    }
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  let text: string
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return null }
  return new URLSearchParams(text)
}

const one = (form: URLSearchParams, key: string): string | null | undefined => {
  const all = form.getAll(key)
  if (all.length > 1) return undefined               // duplicated: refuse
  return all.length ? all[0] : null
}

const plain = (status: number, message: string, extra: Record<string, string> = {}): Response =>
  new Response(message + "\n", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra },
  })

const defaultEnv = (): Record<string, string | undefined> =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}

const defaultReadFile = (path: string): string | null => {
  try {
    const text = readFileSync(path, "utf8")
    return text.length > MAX_CREDENTIAL_BYTES ? null : text
  } catch {
    return null
  }
}

const tryRing = (s: string | null | undefined): JweKey[] | null => {
  if (typeof s !== "string" || s.trim() === "") return null
  try {
    const ring = parseKeyRing(s)
    return ring.length ? ring : null
  } catch {
    return null                                       // never echo the string: it holds key bytes
  }
}

export const createAppAuth = (opts: AppAuthOptions = {}): AppAuth => {
  const env = opts.env ?? defaultEnv()
  const now = opts.now ?? Date.now
  const readFile = opts.readFile ?? defaultReadFile
  const replay = opts.replay ?? new ReplayCache(MAX_REPLAY_ENTRIES, now)
  const fetchKeys = opts.fetchKeys

  const site = (opts.site ?? env[ENV.site] ?? "").trim()
  if (!site) throw new Error("candy auth: no site name")
  if (site.length > MAX_SITE_LENGTH || !SITE_RE.test(site)) throw new Error("candy auth: invalid site name")

  const fallbackPortal = portalOrigin(opts.portal ?? env[ENV.url] ?? DEFAULT_PORTAL, "portal")
  const issuerList = opts.issuers ?? (env[ENV.issuers] ? env[ENV.issuers]!.split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_ISSUERS)
  const issuers = [...new Set(issuerList.map(i => portalOrigin(i, "issuer")))]
  if (issuers.length === 0) throw new Error("candy auth: no issuers")

  // Keys, lazily: options, systemd credential, env, then the daemon
  let ring: JweKey[] | null = null
  let ringAt = 0
  let resolving: Promise<JweKey[] | null> | null = null
  let lastFetch = -Infinity
  let fetching: Promise<JweKey[] | null> | null = null

  const fetchRing = (): Promise<JweKey[] | null> => {
    if (!fetchKeys) return Promise.resolve(null)
    if (fetching) return fetching
    if (now() - lastFetch < REFETCH_MIN_INTERVAL_MS) return Promise.resolve(null)
    lastFetch = now()
    fetching = (async () => {
      try { return tryRing(await fetchKeys(site)) } catch { return null }
    })().finally(() => { fetching = null })
    return fetching
  }

  const staticRing = (): JweKey[] | null => {
    const fromOpts = tryRing(opts.keys)
    if (fromOpts) return fromOpts
    const dir = env.CREDENTIALS_DIRECTORY
    if (dir) {
      const fromCredential = tryRing(readFile(`${dir.replace(/\/+$/, "")}/${CREDENTIAL_NAME}`))
      if (fromCredential) return fromCredential
    }
    return tryRing(env[ENV.keys])
  }

  const setRing = (r: JweKey[]) => { ring = r; ringAt = now() }

  const getRing = async (): Promise<JweKey[] | null> => {
    if (ring) {
      // Take the daemon's current view now and then, so a key it pruned (a
      // rotation after a leak) leaves this process too, not only on restart
      if (fetchKeys && now() - ringAt >= RING_REFRESH_MS) {
        const fresh = await fetchRing()
        if (fresh) setRing(fresh)
      }
      return ring
    }
    if (!resolving) {
      resolving = (async () => staticRing() ?? await fetchRing())().finally(() => { resolving = null })
    }
    const r = await resolving
    if (r && !ring) setRing(r)
    return ring
  }

  const open = async (token: string, keys: JweKey[]): Promise<AppClaims | AuthErrorCode> => {
    try {
      return await openClaims(token, keys, { aud: site, issuers, now: Math.floor(now() / 1000) })
    } catch (e) {
      return e instanceof JweError ? e.code : "malformed"
    }
  }

  const verify: AppAuth["verify"] = async (token, expect = {}) => {
    if (typeof token !== "string" || token.length === 0) return fail("malformed")
    const keys = await getRing()
    if (!keys) return fail("no_keys")
    let claims = await open(token, keys)
    if (claims === "unknown_kid" && fetchKeys) {
      // The key was rotated since we loaded the ring: fetch it again, at most every 30s
      const fresh = await fetchRing()
      if (fresh) {
        setRing(fresh)
        claims = await open(token, fresh)
      }
    }
    if (typeof claims === "string") return fail(claims)
    if (expect.state !== undefined && !sameString(claims.state, expect.state)) return fail("state")
    if (expect.nonce !== undefined && (typeof claims.nonce !== "string" || !sameString(claims.nonce, expect.nonce))) return fail("nonce")
    if (expect.dest !== undefined && claims.dest !== expect.dest) return fail("dest")
    // Last, so a token that fails another check doesn't burn its jti
    let first = false
    try { first = await replay.checkAndRecord(claims.jti, (claims.exp + CLOCK_SKEW_S) * 1000) } catch { first = false }
    if (!first) return fail("replay")
    return { ok: true, user: claims.sub, amr: [...claims.amr], authTime: claims.auth_time * 1000, claims }
  }

  const loginUrl: AppAuth["loginUrl"] = (o) => {
    const portal = portalOrigin(o.portal ?? fallbackPortal, "portal")
    if (!isHttpsUrl(o.returnTo) || !isCallbackUrl(o.returnTo)) throw new Error(`candy auth: returnTo must be https://<this site's host>${CALLBACK_PATH}`)
    if (typeof o.state !== "string" || !STATE_RE.test(o.state)) throw new Error("candy auth: invalid state")
    if (o.nonce !== undefined && (typeof o.nonce !== "string" || !NONCE_RE.test(o.nonce))) throw new Error("candy auth: invalid nonce")
    const q = new URLSearchParams({ return_to: o.returnTo, state: o.state })
    if (o.nonce !== undefined) q.set("nonce", o.nonce)
    return `${portal}/app-auth/authorize?${q}`
  }

  const login: AppAuth["login"] = async (request, o = {}) => {
    let origin: string
    try { origin = requestOrigin(request) } catch { return plain(400, MESSAGES.bad_request) }
    const host = origin.slice("https://".length)
    const returnTo = origin + CALLBACK_PATH
    const state = randomB64url(24)
    const nonce = randomB64url(24)
    let next = safeAppPath(o.next ?? new URL(request.url).searchParams.get("next"))
    const encode = (x: string) => b64urlEncode(new TextEncoder().encode(JSON.stringify({ v: 1, s: state, n: nonce, x, t: now() })))
    let value = encode(next)
    if (value.length > MAX_COOKIE_LENGTH) { next = "/"; value = encode(next) }
    const location = loginUrl({ returnTo, state, nonce, portal: o.portal ?? portalForHost(host, fallbackPortal) })
    return new Response(null, {
      status: 302,
      headers: { Location: location, "Set-Cookie": stateCookie(value), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    })
  }

  const handleCallback: AppAuth["handleCallback"] = async (request) => {
    const no = (status: 400 | 401 | 403, error: AuthErrorCode, message?: string): CallbackResult =>
      ({ ok: false, status, error, message: message ?? MESSAGES[error], clearCookie: CLEAR_COOKIE })
    if (request.method !== "POST") return no(400, "bad_request")
    const form = await readFormBody(request)
    if (!form) return no(400, "bad_request")
    const formState = one(form, "state")
    const token = one(form, "candy_token")
    const error = one(form, "error")
    if (formState === undefined || token === undefined || error === undefined) return no(400, "bad_request")
    const cookie = readStateCookie(request, now())
    if (!cookie) return no(400, "state")
    if (formState === null || !sameString(formState, cookie.s)) return no(403, "state")
    if (error !== null) return no(403, "denied", error === "access_denied" ? "You cancelled signing in." : MESSAGES.denied)
    // dest must be the URL this token actually arrived at. Never a value from
    // the cookie: whoever POSTs here can send any cookie from their own browser
    let arrivedAt: string
    try {
      const u = new URL(request.url)
      arrivedAt = requestOrigin(request) + u.pathname + u.search
    } catch {
      return no(400, "bad_request")
    }
    const r = await verify(token ?? "", { state: cookie.s, nonce: cookie.n, dest: arrivedAt })
    if (!r.ok) return no(401, r.error, r.message)
    return { ok: true, user: r.user, amr: r.amr, authTime: r.authTime, claims: r.claims, next: cookie.x, clearCookie: CLEAR_COOKIE }
  }

  const handle: AppAuth["handle"] = async (request, onLogin) => {
    let path: string
    try { path = new URL(request.url).pathname } catch { return null }
    if (path === LOGIN_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed.", { Allow: "GET" })
      return login(request)
    }
    if (path !== CALLBACK_PATH) return null
    const r = await handleCallback(request)
    if (!r.ok) return plain(r.status, r.message, { "Set-Cookie": r.clearCookie })
    const { ok: _ok, clearCookie, ...user } = r
    const res = await onLogin(user, request)
    const headers = new Headers(res.headers)
    headers.append("Set-Cookie", clearCookie)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }

  return { site, loginUrl, login, verify, handleCallback, handle }
}
