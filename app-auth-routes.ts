// The portal routes for "Sign in with candy" and passkeys (section F of
// SDK_AUTH_DESIGN.md). daemon.ts runs its guard first (ROUTE_TABLE class,
// login, sameOrigin and the page token for state-changing portal requests),
// then hands these paths to `handle`. Everything the daemon owns is injected,
// so test/app-auth-flow.test.ts drives the same code with real stores, real
// keys and a software authenticator.
//
//   GET  /app-auth/authorize           public   portal only: check, park, 302 to the consent page
//   GET  /app-auth/consent             user     portal login: the consent page (portal shell)
//   POST /app-auth/decision            user     portal login + page token: mint and hand back a form POST
//   GET  /app-auth/sites               user     sites with keys, the caller's own (mayUse)
//   POST /app-auth/rotate              user     a new key for one of the caller's sites
//   GET  /app-auth/consents            user     the caller's remembered approvals
//   POST /app-auth/consents/revoke     user     forget one
//   POST /sdk/auth/keys                user     the owner's API key only: the site's key ring
//   POST /auth/passkey/options         public   portal only: a login challenge
//   POST /auth/passkey                 public   portal only: passkey login, same session as /auth/login
//   POST /auth/reauth                  user     portal login + page token: re-enter the password
//   GET  /passkeys                     user     portal login: the passkeys page (portal shell)
//   GET  /passkeys/list                user     the caller's passkeys (portal, or an API key)
//   POST /passkeys/register/options    user     portal login + page token + recent password
//   POST /passkeys/register            user     portal login + page token + recent password
//   POST /passkeys/rename              user     portal login + page token
//   POST /passkeys/delete              user     portal login + page token + recent password
//
// Never logged or audited: a token, a key, a state or nonce, a password.
import {
  consentView, errorReturn, mayFetchSiteKey, mintAppToken, recheckRequest, successReturn, validateAuthorize,
  AUTHZ_EXPIRED, type AppKeyStore, type AuthorizeRequest, type ConsentStore, type PendingRequests, type SiteLookup,
} from "./app-auth.ts"
import { formatKeyRing, type JweKey } from "./jwe.ts"
import {
  attemptPasskeyLogin, deletePasskey, finishRegistration, renamePasskey, startPasskeyLogin, startRegistration,
  RECENT_PAM_MS, SUPERUSER_PAM_MS, type PasskeyDeps, type SessionAuthState,
} from "./passkey-store.ts"
import { logSafe, type LoginOutcome, type RequestAuth } from "./portal-auth.ts"
import { lowerName } from "./caddy-config.ts"

/** Every path `handle` answers; daemon.ts dispatches these after its guard. */
export const APP_AUTH_ROUTES: readonly string[] = [
  "/app-auth/authorize", "/app-auth/consent", "/app-auth/decision", "/app-auth/sites", "/app-auth/rotate",
  "/app-auth/consents", "/app-auth/consents/revoke", "/sdk/auth/keys",
  "/auth/passkey/options", "/auth/passkey", "/auth/reauth",
  "/passkeys", "/passkeys/list", "/passkeys/register/options", "/passkeys/register", "/passkeys/rename", "/passkeys/delete",
]

/** JSON bodies on these routes are small; a passkey response is the largest (attestation ≤ 16 KB as base64url). */
export const MAX_AUTH_BODY_BYTES = 64 * 1024

export interface AuthRouteContext {
  auth: RequestAuth | null
  /** isPortalRequest(req): a portal host, reached as the portal */
  portalHost: boolean
  /** The Host header, lower case, ":443" dropped */
  host: string
  ip: string
  userAgent: string
  https: boolean
  cors: Record<string, string>
  /** The audit actor for this request (auditActor) */
  actor: string
}

export interface AuthRouteDeps {
  appKeys: AppKeyStore
  consents: ConsentStore
  pending: PendingRequests
  passkeys: PasskeyDeps
  sessions: {
    create(user: string, meta: { ip?: string; ua?: string }, opts: { amr: "pam" | "passkey" }): { id: string; cookie: string; secret: string }
    get(cookie: string | null | undefined, secret: string | null | undefined): { id: string } | null
    destroy(id: string): boolean
    markPam(id: string): number | null
  }
  pageTokens: { mint(sessionId: string): string; dropSession(sessionId: string): void }
  site: SiteLookup
  /** May this login act on the site `name` (its user, or a superuser) */
  mayUse(auth: RequestAuth | null, name: string): boolean
  /** POST /auth/login's checks (attemptLogin with the daemon's LoginDeps) */
  passwordLogin(input: { user: unknown; password: unknown; ip: string }): Promise<LoginOutcome>
  /** Seconds the password login's address lockout has left for `ip` (0: none); passkey logins honour it too */
  addressWait(ip: string): Promise<number>
  /** The site an SDK key fetch names ({name} or {configId}), or null */
  siteForKeyFetch(body: { name?: unknown; configId?: unknown }): string | null
  /** Portal origins tokens may come from, and the portal apps should send users to */
  issuers(): string[]
  portalUrl(): string
  /** A site's ring changed (rotated, or replaced for a new owner): rewrite its credential file, restart its function. Returns the running servers that still hold the old ring. */
  keysChanged(site: string, ring: JweKey[]): Promise<string[]>
  /** public/<file> as text */
  page(file: string): Promise<string>
  /** The <script> a portal page gets: page token, CANDY_VARS, session fetch patch */
  pageScript(token: string | null, vars: unknown): string
  readSessionCookie(cookieHeader: string | null): string | null
  sessionCookie(value: string, secure: boolean): string
  sessionHeader: string
  audit(action: string, details: string, actor: string): void
  now(): number
}

const NO_STORE = { "Cache-Control": "no-store" }
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * A JSON object body, at most MAX_AUTH_BODY_BYTES; anything else is {} (each
 * route then refuses what's missing). Counted while it streams in: a chunked
 * body has no Content-Length, and is cut off (never buffered) past `max`.
 */
export const readJsonBody = async (req: Request, max = MAX_AUTH_BODY_BYTES): Promise<Record<string, unknown>> => {
  const declared = req.headers.get("content-length")
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > max)) {
    req.body?.cancel().catch(() => {})
    return {}
  }
  if (!req.body) return {}
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = req.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        reader.cancel().catch(() => {})
        return {}
      }
      chunks.push(value)
    }
  } catch {
    return {}
  }
  if (total === 0) return {}
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  try {
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return isObject(v) ? v : {}
  } catch {
    return {}
  }
}

export const createAuthRoutes = (d: AuthRouteDeps) => {
  const json = (ctx: AuthRouteContext, body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...ctx.cors, ...NO_STORE, ...extra } })
  const notFound = (ctx: AuthRouteContext) => json(ctx, { error: "not found" }, 404)

  // A portal page: the file with the page script in front of its first <script>
  const htmlPage = async (file: string, token: string | null, vars: unknown, status = 200): Promise<Response> => {
    const raw = await d.page(file)
    return new Response(raw.replace("<script>", `${d.pageScript(token, vars)}<script>`), { status, headers: HTML_HEADERS })
  }

  const session = (auth: RequestAuth): SessionAuthState => ({
    id: auth.sessionId!, user: auth.user, amr: auth.amr ?? "pam", pamAt: auth.pamAt ?? null,
  })
  const pamUntil = (auth: RequestAuth): number | null => {
    const at = auth.pamAt
    if (typeof at !== "number") return null
    const until = at + RECENT_PAM_MS
    return until > d.now() ? until : null
  }

  // A ring for the site as its current owner has it; a ring left by a previous
  // owner is replaced, and their users' approvals go with it
  const ringFor = async (site: string, owner: string, actor: string): Promise<JweKey[]> => {
    const { ring, replaced } = d.appKeys.ensure(site, owner)
    if (replaced) {
      const n = d.consents.dropSite(site)
      d.audit("APP_AUTH_RESET", `${site}: now run by ${owner}, new key, ${n} approval(s) dropped`, actor)
      await d.keysChanged(site, ring).catch(() => [])
    }
    return ring
  }

  // --- Delegated login ---------------------------------------------------

  const authorize = async (url: URL, ctx: AuthRouteContext): Promise<Response> => {
    if (!ctx.portalHost) return notFound(ctx)
    const v = validateAuthorize(url.searchParams, d.site)
    // An error page, never a redirect: a bad return_to must not bounce anywhere
    if (!v.ok) return htmlPage("app-consent.html", null, { error: v.error }, v.status)
    const parked = d.pending.park({
      site: v.site, owner: v.owner, returnTo: v.returnTo, returnHost: v.returnHost,
      state: v.state, nonce: v.nonce, issuer: `https://${ctx.host}`, ip: ctx.ip,
    })
    return new Response(null, {
      status: 302,
      headers: { Location: `/app-auth/consent?request=${encodeURIComponent(parked.id)}`, ...NO_STORE, "Referrer-Policy": "no-referrer" },
    })
  }

  const consentPage = async (url: URL, ctx: AuthRouteContext): Promise<Response> => {
    const auth = ctx.auth
    if (!ctx.portalHost || auth?.via !== "portal") return notFound(ctx)
    const r = d.pending.get(url.searchParams.get("request"))
    if (!r || r.issuer !== `https://${ctx.host}`) return htmlPage("app-consent.html", null, { error: AUTHZ_EXPIRED }, 404)
    const still = recheckRequest(r, d.site)
    if (!still.ok) return htmlPage("app-consent.html", null, { error: still.error }, still.status)
    const remembered = d.consents.has(auth.user, r.site, r.owner)
    return htmlPage("app-consent.html", d.pageTokens.mint(auth.sessionId!), consentView(r, auth.user, remembered, auth.amr ?? "pam"))
  }

  const decision = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = ctx.auth
    if (!ctx.portalHost || auth?.via !== "portal") return notFound(ctx)
    const body = await readJsonBody(req)
    const expired = () => json(ctx, { error: AUTHZ_EXPIRED }, 404)
    // Answered on the portal host it was asked on (the token's issuer)
    const peek = d.pending.get(body.request)
    if (!peek || peek.issuer !== `https://${ctx.host}`) return expired()
    const r: AuthorizeRequest | null = d.pending.take(body.request)
    if (!r) return expired()
    const still = recheckRequest(r, d.site)
    if (!still.ok) return json(ctx, { error: still.error }, still.status)
    const who = `${logSafe(auth.user)} -> ${r.site} at ${r.returnHost}`
    if (body.approve !== true) {
      d.audit("APP_AUTH_DENY", who, ctx.actor)
      return json(ctx, errorReturn(r, "access_denied"))
    }
    const ring = await ringFor(r.site, r.owner, ctx.actor)
    const amr = auth.amr ?? "pam"
    const { token, claims } = await mintAppToken({
      req: r, user: auth.user, amr, sessionCreated: auth.sessionCreated ?? d.now(), key: ring[0], now: d.now(),
    })
    if (body.remember === true) d.consents.remember(auth.user, r.site, r.owner)
    // The jti and kid identify the token; the token itself is never written anywhere
    d.audit("APP_AUTH_GRANT", `${who} (${amr})${body.remember === true ? ", remembered" : ""}, kid ${ring[0].kid}, jti ${claims.jti}`, ctx.actor)
    return json(ctx, successReturn(r, token))
  }

  const sites = (ctx: AuthRouteContext): Response => {
    const list = []
    for (const site of d.appKeys.sites()) {
      if (!d.mayUse(ctx.auth, site)) continue
      const info = d.appKeys.info(site)
      if (info) list.push({ site, owner: info.owner, kid: info.kid, created: info.created, rotatedAt: info.rotatedAt })
    }
    return json(ctx, { sites: list })
  }

  const rotate = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const body = await readJsonBody(req)
    // Names are lower case (the daemon's lowerRequestNames patches req.json, which readJsonBody doesn't use)
    const name = typeof body.name === "string" ? lowerName(body.name) : ""
    const owner = name ? d.site.ownerOf(name) : null
    if (!owner) return json(ctx, { error: `There's no site called ${logSafe(name) || "(none)"}.` }, 404)
    if (!d.mayUse(ctx.auth, name)) return json(ctx, { error: `${name} belongs to ${owner}. Only they can rotate its key.` }, 403)
    const had = d.appKeys.info(name)
    if (had && had.owner !== owner) {
      const n = d.consents.dropSite(name)
      d.audit("APP_AUTH_RESET", `${name}: now run by ${owner}, new key, ${n} approval(s) dropped`, ctx.actor)
    }
    const ring = d.appKeys.rotate(name, owner)
    const restartNeeded = await d.keysChanged(name, ring)
    d.audit("APP_AUTH_KEY_ROTATE", `${name}: kid ${ring[0].kid}`, ctx.actor)
    return json(ctx, { site: name, kid: ring[0].kid, restartNeeded })
  }

  const consentList = (ctx: AuthRouteContext): Response => json(ctx, { consents: d.consents.list(ctx.auth!.user) })

  const revoke = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const body = await readJsonBody(req)
    const site = typeof body.site === "string" ? lowerName(body.site) : ""
    const revoked = !!site && d.consents.revoke(ctx.auth!.user, site)
    if (revoked) d.audit("APP_AUTH_REVOKE", `${logSafe(ctx.auth!.user)} -> ${site}`, ctx.actor)
    return json(ctx, { revoked })
  }

  // The site's key ring for its owner's own process (sdk.ts): never a portal
  // login (keys never reach a browser), never OAuth, no superuser override
  const keyFetch = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const body = await readJsonBody(req)
    const site = d.siteForKeyFetch(body)
    const owner = site ? d.site.ownerOf(site) : null
    if (!site || !owner) return json(ctx, { error: "No such site." }, 404)
    if (!mayFetchSiteKey(ctx.auth, owner)) return json(ctx, { error: `${site} belongs to ${owner}. Only they can read its auth key.` }, 403)
    const ring = await ringFor(site, owner, ctx.actor)
    d.audit("APP_AUTH_KEY_FETCH", `${site}: kid ${ring[0].kid}`, ctx.actor)
    return json(ctx, { site, keys: formatKeyRing(ring), issuers: d.issuers(), portal: d.portalUrl() })
  }

  // --- Passkeys ----------------------------------------------------------

  const rp = (ctx: AuthRouteContext) => ({ rpId: ctx.host, origin: `https://${ctx.host}` })

  // An address locked out of password logins is locked out of passkey logins too
  const addressLocked = async (ctx: AuthRouteContext): Promise<Response | null> => {
    const wait = await d.addressWait(ctx.ip)
    return wait > 0 ? json(ctx, { error: "Too many failed logins from this address.", retryAfter: wait }, 429) : null
  }

  const passkeyOptions = async (ctx: AuthRouteContext): Promise<Response> => {
    if (!ctx.portalHost) return notFound(ctx)
    const locked = await addressLocked(ctx)
    if (locked) return locked
    let out: ReturnType<typeof startPasskeyLogin>
    try { out = startPasskeyLogin(d.passkeys, { ...rp(ctx), ip: ctx.ip }) }
    catch { return json(ctx, { error: "Passkeys don't work on this address." }, 400) }
    if (!out.ok) return json(ctx, out.body, out.status)
    return json(ctx, { challengeId: out.challengeId, publicKey: out.publicKey })
  }

  const passkeyLogin = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    if (!ctx.portalHost) return notFound(ctx)
    const locked = await addressLocked(ctx)
    if (locked) return locked
    const body = await readJsonBody(req)
    const out = await attemptPasskeyLogin(d.passkeys, { challengeId: body.challengeId, credential: body.credential, ...rp(ctx), ip: ctx.ip })
    if (!out.ok) return json(ctx, out.body, out.status)
    // Exactly like /auth/login: a fresh session id, never one handed in
    const old = d.sessions.get(d.readSessionCookie(req.headers.get("cookie")), req.headers.get(d.sessionHeader))
    if (old) { d.sessions.destroy(old.id); d.pageTokens.dropSession(old.id) }
    const { cookie, secret } = d.sessions.create(out.user, { ip: ctx.ip, ua: ctx.userAgent }, { amr: "passkey" })
    // A passkey session is never a superuser on its own (mayActAsSuperuser): a
    // sudoer re-enters the password (/auth/reauth) for that
    const extra = out.superuser ? { superuserNeedsPassword: true } : {}
    return json(ctx, { user: out.user, superuser: false, ...extra, session: secret }, 200, { "Set-Cookie": d.sessionCookie(cookie, ctx.https) })
  }

  const portalLogin = (ctx: AuthRouteContext): RequestAuth | null =>
    ctx.portalHost && ctx.auth?.via === "portal" && ctx.auth.sessionId ? ctx.auth : null

  const reauth = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const body = await readJsonBody(req)
    // Always the session's own account: the body's user (if any) is ignored
    const out = await d.passwordLogin({ user: auth.user, password: body.password, ip: ctx.ip })
    if (!out.ok) return json(ctx, out.body, out.status)
    const at = d.sessions.markPam(auth.sessionId!)
    if (at === null) return json(ctx, { error: "login required" }, 401, { "X-Candy-Login": "required" })
    d.audit("AUTH_REAUTH", `${logSafe(auth.user)} from ${logSafe(ctx.ip)}`, ctx.actor)
    return json(ctx, { pamUntil: at + RECENT_PAM_MS, superuserUntil: at + SUPERUSER_PAM_MS })
  }

  const passkeysPage = async (ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    return htmlPage("portal-passkeys.html", d.pageTokens.mint(auth.sessionId!), {
      user: auth.user, superuser: auth.superuser, rpId: ctx.host, pamUntil: pamUntil(auth),
    })
  }

  const passkeyList = (url: URL, ctx: AuthRouteContext): Response => {
    const auth = ctx.auth!
    const asked = url.searchParams.get("user")
    // Someone else's list: a superuser's portal login only
    if (asked !== null && asked !== auth.user && !(auth.via === "portal" && auth.superuser)) {
      return json(ctx, { error: "Only a superuser, logged in to the portal, can see another user's passkeys." }, 403)
    }
    const user = asked ?? auth.user
    const store = d.passkeys.store
    return json(ctx, { passkeys: store.list(user).map(r => store.view(r, ctx.host)) })
  }

  const registerOptions = async (ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    let out: Awaited<ReturnType<typeof startRegistration>>
    try { out = await startRegistration(d.passkeys, { ...rp(ctx), session: session(auth) }) }
    catch { return json(ctx, { error: "Passkeys don't work on this address." }, 400) }
    if (!out.ok) return json(ctx, out.body, out.status)
    return json(ctx, { challengeId: out.challengeId, publicKey: out.publicKey })
  }

  const register = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const body = await readJsonBody(req)
    const out = await finishRegistration(d.passkeys, { challengeId: body.challengeId, credential: body.credential, name: body.name, ...rp(ctx), session: session(auth) })
    if (!out.ok) return json(ctx, out.body, out.status)
    return json(ctx, { passkey: d.passkeys.store.view(out.record, ctx.host) })
  }

  const rename = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const body = await readJsonBody(req)
    const out = renamePasskey(d.passkeys, { id: body.id, name: body.name, session: session(auth) })
    if (!out.ok) return json(ctx, out.body, out.status)
    return json(ctx, { passkey: d.passkeys.store.view(out.record, ctx.host) })
  }

  const remove = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const body = await readJsonBody(req)
    const actingUser = typeof body.user === "string" ? body.user : undefined
    const out = deletePasskey(d.passkeys, { id: body.id, session: session(auth), superuser: auth.superuser, actingUser })
    if (!out.ok) return json(ctx, out.body, out.status)
    return json(ctx, { deleted: true })
  }

  /** The answer for one of APP_AUTH_ROUTES, or null when the method doesn't match (the caller 404s). */
  const handle = async (req: Request, url: URL, ctx: AuthRouteContext): Promise<Response | null> => {
    const m = req.method === "HEAD" ? "GET" : req.method
    const route = `${m} ${url.pathname}`
    switch (route) {
      case "GET /app-auth/authorize": return authorize(url, ctx)
      case "GET /app-auth/consent": return consentPage(url, ctx)
      case "POST /app-auth/decision": return decision(req, ctx)
      case "GET /app-auth/sites": return ctx.auth ? sites(ctx) : null
      case "POST /app-auth/rotate": return ctx.auth ? rotate(req, ctx) : null
      case "GET /app-auth/consents": return ctx.auth ? consentList(ctx) : null
      case "POST /app-auth/consents/revoke": return ctx.auth ? revoke(req, ctx) : null
      case "POST /sdk/auth/keys": return keyFetch(req, ctx)
      case "POST /auth/passkey/options": return passkeyOptions(ctx)
      case "POST /auth/passkey": return passkeyLogin(req, ctx)
      case "POST /auth/reauth": return reauth(req, ctx)
      case "GET /passkeys": return passkeysPage(ctx)
      case "GET /passkeys/list": return ctx.auth ? passkeyList(url, ctx) : null
      case "POST /passkeys/register/options": return registerOptions(ctx)
      case "POST /passkeys/register": return register(req, ctx)
      case "POST /passkeys/rename": return rename(req, ctx)
      case "POST /passkeys/delete": return remove(req, ctx)
    }
    return null
  }

  return { handle }
}
