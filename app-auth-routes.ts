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
//   POST /app-auth/fresh               user     portal login + page token: a passkey stamp that re-authenticates this login for one request (max_age)
//   GET  /app-auth/sites               user     sites with keys, the caller's own (mayUse)
//   POST /app-auth/rotate              user     a new key for one of the caller's sites
//   GET  /app-auth/consents            user     the caller's remembered approvals
//   POST /app-auth/consents/revoke     user     forget one
//   POST /sdk/auth/keys                user     the owner's API key only: the site's key ring
//   GET  /auth/passkey/start           public   portal only: a login stamp, 302 to the candy host
//   POST /auth/passkey/finish          public   portal only, Origin = the candy host: redeem the login code, make the session
//   POST /auth/reauth                  user     portal login + page token: re-enter the password
//   GET  /passkeys                     user     portal login: the passkeys page (portal shell)
//   GET  /passkeys/list                user     the caller's passkeys (portal, or an API key)
//   POST /passkeys/enroll/start        user     portal login + page token + recent password: an enroll stamp (the popup's URL)
//   POST /passkeys/rename              user     portal login + page token
//   POST /passkeys/delete              user     portal login + page token + recent password
//
// The WebAuthn ceremonies themselves run on candy's own host, candy.<zone>
// (candy-host.ts); these routes only send the browser there with a stamp and
// take it back. No bound domain: no passkeys (the start routes are 404s).
//
// Never logged or audited: a token, a key, a state or nonce, a password, a stamp or a login code.
import {
  consentView, errorReturn, freshKey, freshnessOk, mayFetchSiteKey, mintAppToken, recheckRequest, successReturn, validateAuthorize,
  AUTHZ_EXPIRED, AUTHZ_NEEDS_FRESH, type AppKeyStore, type AuthorizeRequest, type ConsentStore, type PendingRequests, type SiteLookup,
} from "./app-auth.ts"
import { formatKeyRing, type JweKey } from "./jwe.ts"
import {
  deletePasskey, mayManagePasskeys, passkeyLoginKey, renamePasskey,
  PASSKEY_LIMIT, PASSKEY_NEEDS_PASSWORD, RECENT_PAM_MS, type PasskeyDeps, type SessionAuthState,
} from "./passkey-store.ts"
import { logSafe, safeNext, type LoginOutcome, type RequestAuth } from "./portal-auth.ts"
import { lowerName } from "./caddy-config.ts"
import {
  addressKey, fromCandyHost, isCookieValue, newCookieValue, readCookie, sha256b64, TicketsBusy,
  CODE_FIELD, COOKIE_MAX_AGE_S, PASSKEY_BIND_COOKIE, PASSKEYS_NEED_DOMAIN, STAMP_PARAM, type PasskeyTickets,
} from "./candy-host.ts"

/** Every path `handle` answers; daemon.ts dispatches these after its guard. */
export const APP_AUTH_ROUTES: readonly string[] = [
  "/app-auth/authorize", "/app-auth/consent", "/app-auth/decision", "/app-auth/fresh", "/app-auth/sites", "/app-auth/rotate",
  "/app-auth/consents", "/app-auth/consents/revoke", "/sdk/auth/keys",
  "/auth/passkey/start", "/auth/passkey/finish", "/auth/reauth",
  "/passkeys", "/passkeys/list", "/passkeys/enroll/start", "/passkeys/rename", "/passkeys/delete",
]

/** The one portal route a page on the candy host may POST to (its Origin is the candy host, not the portal). */
export const PASSKEY_FINISH_PATH = "/auth/passkey/finish"

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
  /** candy.<zone>, the passkey rpId and ceremony host; null while no domain is bound (no passkeys) */
  candyHost(): string | null
  /** Stamps (portal -> candy host) and login codes (candy host -> portal) */
  tickets: PasskeyTickets
  sessions: {
    create(user: string, meta: { ip?: string; ua?: string }, opts: { amr: "pam" | "passkey" }): { id: string; cookie: string; secret: string }
    get(cookie: string | null | undefined, secret: string | null | undefined): { id: string } | null
    byId(id: string): { id: string; user: string; enrollSeq: number } | null
    destroy(id: string): boolean
    markPam(id: string, freshFor?: string | null): number | null
    markAuth(id: string, method: "pam" | "passkey", freshFor?: string | null): number | null
    clearFresh(id: string): void
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
const MAX_FORM_BYTES = 8 * 1024

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
const nonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url")
const pageCsp = (n: string) => `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
const PAGE_STYLE = `:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:#eceef2;color:#1a1d33;font:15px/1.5 system-ui,sans-serif}main{max-width:420px}h1{font-size:18px;margin:0 0 6px}p{margin:0 0 12px;color:#555b75}a{color:#d42a47}@media (prefers-color-scheme:dark){body{background:#10121a;color:#e7e9f2}p{color:#a3a8c0}a{color:#ff5d78}}`

/** A small portal page with one message and an optional link (portal origin only). */
const messagePage = (title: string, text: string, link: { href: string; label: string } | null, status: number, extra: Record<string, string> = {}): Response => {
  const n = nonce()
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · candy</title><style nonce="${n}">${PAGE_STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ""}</main></body></html>`
  return new Response(body, { status, headers: { ...HTML_HEADERS, "Content-Security-Policy": pageCsp(n), ...extra } })
}

/** An urlencoded form body, at most MAX_FORM_BYTES; anything else is empty. */
const readFormBody = async (req: Request): Promise<URLSearchParams> => {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers.get("content-type") || "")) return new URLSearchParams()
  const bytes = await readCapped(req, MAX_FORM_BYTES)
  if (!bytes) return new URLSearchParams()
  try { return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { return new URLSearchParams() }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * A JSON object body, at most MAX_AUTH_BODY_BYTES; anything else is {} (each
 * route then refuses what's missing). Counted while it streams in: a chunked
 * body has no Content-Length, and is cut off (never buffered) past `max`.
 */
/** The body's bytes, at most `max` (counted while it streams; cut off, never buffered, past it); null when too big or unreadable. */
const readCapped = async (req: Request, max: number): Promise<Uint8Array | null> => {
  const declared = req.headers.get("content-length")
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > max)) {
    req.body?.cancel().catch(() => {})
    return null
  }
  if (!req.body) return new Uint8Array(0)
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
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  return bytes
}

export const readJsonBody = async (req: Request, max = MAX_AUTH_BODY_BYTES): Promise<Record<string, unknown>> => {
  const bytes = await readCapped(req, max)
  if (!bytes || bytes.length === 0) return {}
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
  const freshState = (auth: RequestAuth) => ({ authAt: auth.authAt ?? auth.sessionCreated ?? 0, freshFor: auth.freshFor ?? null })

  // A parked request this login may re-authenticate for: ours, live, asked on this portal host
  const pendingHere = (id: unknown, ctx: AuthRouteContext): AuthorizeRequest | null => {
    const r = d.pending.get(id)
    return r && r.issuer === `https://${ctx.host}` ? r : null
  }

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
      state: v.state, nonce: v.nonce, issuer: `https://${ctx.host}`, ip: ctx.ip, maxAge: v.maxAge,
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
    const fresh = { needed: !freshnessOk(r, freshState(auth), d.now()), passkeys: d.candyHost() !== null }
    return htmlPage("app-consent.html", d.pageTokens.mint(auth.sessionId!), consentView(r, auth.user, remembered, auth.authMethod ?? auth.amr ?? "pam", fresh))
  }

  const decision = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = ctx.auth
    if (!ctx.portalHost || auth?.via !== "portal") return notFound(ctx)
    const body = await readJsonBody(req)
    const expired = () => json(ctx, { error: AUTHZ_EXPIRED }, 404)
    // Answered on the portal host it was asked on (the token's issuer)
    const peek = d.pending.get(body.request)
    if (!peek || peek.issuer !== `https://${ctx.host}`) return expired()
    // The app asked for a recent authentication (max_age) this login doesn't have:
    // authenticate again first (the request stays parked). A denial needs none.
    if (body.approve === true && !freshnessOk(peek, freshState(auth), d.now())) {
      return json(ctx, { error: AUTHZ_NEEDS_FRESH, fresh: true }, 401)
    }
    const r: AuthorizeRequest | null = d.pending.take(body.request, auth.user)
    if (!r) return expired()
    const still = recheckRequest(r, d.site)
    if (!still.ok) return json(ctx, { error: still.error }, still.status)
    const who = `${logSafe(auth.user)} -> ${r.site} at ${r.returnHost}`
    if (body.approve !== true) {
      d.audit("APP_AUTH_DENY", who, ctx.actor)
      return json(ctx, errorReturn(r, "access_denied"))
    }
    const ring = await ringFor(r.site, r.owner, ctx.actor)
    // amr and auth_time: the latest authentication (the fresh one, when the app asked for max_age)
    const amr = auth.authMethod ?? auth.amr ?? "pam"
    const authAt = auth.authAt ?? auth.sessionCreated ?? d.now()
    // Whether the account is a sudoer, asked now (never a value cached in the session)
    const superuser = await d.passkeys.isSuperuser(auth.user).catch(() => false)
    const { token, claims } = await mintAppToken({ req: r, user: auth.user, amr, authAt, superuser, key: ring[0], now: d.now() })
    // A fresh authentication made for this request is used up by it
    if (auth.freshFor && auth.freshFor === freshKey(r.id)) d.sessions.clearFresh(auth.sessionId!)
    if (body.remember === true) d.consents.remember(auth.user, r.site, r.owner)
    // The jti and kid identify the token; the token itself is never written anywhere
    const age = r.maxAge === null ? "" : `, max_age ${r.maxAge}`
    d.audit("APP_AUTH_GRANT", `${who} (${amr}${superuser ? ", superuser" : ""}${age})${body.remember === true ? ", remembered" : ""}, kid ${ring[0].kid}, jti ${claims.jti}`, ctx.actor)
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
  // The ceremonies run on the candy host (candy-host.ts). The portal mints the
  // stamp that sends the browser there, and redeems the login code it brings back.

  // An address locked out of password logins is locked out of passkey logins too
  const addressWait = async (ip: string): Promise<number> => {
    const hard = await d.addressWait(ip)
    const soft = Math.ceil(d.passkeys.soft.wait(passkeyLoginKey(ip, d.passkeys.isLoopback(ip))) / 1000)
    return Math.max(hard, soft)
  }

  // Stamps are counted per asking address (all of loopback is one): a share each, never all of them
  const mintBy = (ctx: AuthRouteContext) => addressKey(ctx.ip, d.passkeys.isLoopback(ctx.ip))
  const busyText = "Too many passkey attempts right now. Try again in a few minutes."
  const busyJson = (ctx: AuthRouteContext, e: TicketsBusy) =>
    json(ctx, { error: busyText, retryAfter: e.retryAfterS }, e.why === "owner" ? 429 : 503, { "Retry-After": String(e.retryAfterS) })

  const bindCookie = (value: string) => `${PASSKEY_BIND_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${COOKIE_MAX_AGE_S}`

  // GET /auth/passkey/start?next=: the login page's "Use a passkey". A login
  // stamp (names no one), bound to this browser by a cookie the login code
  // must come back with, then off to the candy host.
  const passkeyStart = async (req: Request, url: URL, ctx: AuthRouteContext): Promise<Response> => {
    const candy = d.candyHost()
    if (!ctx.portalHost || !candy) return notFound(ctx)
    const next = safeNext(url.searchParams.get("next"))
    const back = { href: `/login?next=${encodeURIComponent(next)}&with=password`, label: "Log in with your password" }
    const wait = await addressWait(ctx.ip)
    if (wait > 0) return messagePage("Too many failed logins", `Too many failed logins from this address. Try again in ${wait} seconds.`, back, 429, { "Retry-After": String(wait) })
    const had = readCookie(req.headers.get("cookie"), PASSKEY_BIND_COOKIE)
    const cookie = isCookieValue(had) ? had : newCookieValue()
    let stamp: string
    try {
      stamp = d.tickets.mintStamp({
        purpose: "login", host: candy, portal: ctx.host, next, bind: sha256b64(cookie), user: null, sessionId: null, pamAt: null, name: null,
      }, mintBy(ctx))
    } catch (e) {
      if (!(e instanceof TicketsBusy)) throw e
      return messagePage("Too many passkey attempts", busyText, back, e.why === "owner" ? 429 : 503, { "Retry-After": String(e.retryAfterS) })
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://${candy}/passkey/login?${STAMP_PARAM}=${encodeURIComponent(stamp)}`,
        "Set-Cookie": bindCookie(cookie), ...NO_STORE, "Referrer-Policy": "no-referrer",
      },
    })
  }

  // POST /app-auth/fresh {request}: the app asked for max_age and this login is
  // older. A login stamp that, instead of making a new session, re-authenticates
  // this one (same user only) for this one parked request. Same lockouts as a login.
  const freshStart = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const candy = d.candyHost()
    if (!candy) return json(ctx, { error: PASSKEYS_NEED_DOMAIN }, 404)
    const body = await readJsonBody(req)
    const r = pendingHere(body.request, ctx)
    if (!r) return json(ctx, { error: AUTHZ_EXPIRED }, 404)
    const wait = await addressWait(ctx.ip)
    if (wait > 0) return json(ctx, { error: "Too many failed logins from this address.", retryAfter: wait }, 429)
    const had = readCookie(req.headers.get("cookie"), PASSKEY_BIND_COOKIE)
    const cookie = isCookieValue(had) ? had : newCookieValue()
    const next = safeNext(`/app-auth/consent?request=${encodeURIComponent(r.id)}`)
    let stamp: string
    try {
      stamp = d.tickets.mintStamp({
        purpose: "login", host: candy, portal: ctx.host, next, bind: sha256b64(cookie), user: null, sessionId: null, pamAt: null, name: null,
        fresh: { sessionId: auth.sessionId!, request: freshKey(r.id) },
      }, mintBy(ctx))
    } catch (e) {
      if (e instanceof TicketsBusy) return busyJson(ctx, e)
      throw e
    }
    return json(ctx, { url: `https://${candy}/passkey/login?${STAMP_PARAM}=${encodeURIComponent(stamp)}` }, 200, { "Set-Cookie": bindCookie(cookie) })
  }

  // POST /auth/passkey/finish (a form the candy host's page submits): the
  // one-time login code becomes a portal session, exactly as /auth/login makes
  // one. The secret reaches this origin's storage through a tiny page, never a URL.
  const passkeyFinish = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const candy = d.candyHost()
    if (!ctx.portalHost || !candy) return notFound(ctx)
    if (!fromCandyHost(req.headers, candy)) return json(ctx, { error: "Cross-site request refused." }, 403)
    const form = await readFormBody(req)
    const codes = form.getAll(CODE_FIELD)
    const code = codes.length === 1 ? d.tickets.takeCode(codes[0]) : null
    const next = code ? safeNext(code.next) : "/"
    const again = (why: string) => {
      d.audit("AUTH_FAIL", `passkey login code from ${logSafe(ctx.ip)} refused: ${why}`, "Portal")
      return messagePage("That didn't work", "This passkey login expired or was opened in another browser. Try again.", { href: `/login?next=${encodeURIComponent(next)}`, label: "Back to log in" }, 400)
    }
    if (!code) return again("unknown, used or expired")
    if (code.host !== candy || code.portal !== ctx.host) return again(`made for ${logSafe(code.portal)}`)
    const bind = readCookie(req.headers.get("cookie"), PASSKEY_BIND_COOKIE)
    if (!isCookieValue(bind) || sha256b64(bind) !== code.bind) return again("another browser")
    const users = await d.passkeys.loginUsers().catch(() => [] as string[])
    if (!users.includes(code.user)) return again(`${logSafe(code.user)} may not log in`)
    if (code.fresh) {
      // Re-authenticating a live login for one app request: that login's own user only
      const live = d.sessions.byId(code.fresh.sessionId)
      if (!live) return again("the login it was for ended")
      if (live.user !== code.user) return again(`a passkey of ${logSafe(code.user)} for ${logSafe(live.user)}'s login`)
      if (d.sessions.markAuth(live.id, "passkey", code.fresh.request) === null) return again("the login it was for ended")
      d.audit("AUTH_REAUTH", `${logSafe(code.user)} from ${logSafe(ctx.ip)} (passkey, for an app)`, "Portal")
      const n = nonce()
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Back to candy</title><style nonce="${n}">${PAGE_STYLE}</style></head><body><main><p>Back to candy…</p></main>`
        + `<script nonce="${n}">location.replace(${scriptJson(next)})</script></body></html>`
      return new Response(html, { headers: { ...HTML_HEADERS, "Content-Security-Policy": pageCsp(n) } })
    }
    const { cookie, secret } = d.sessions.create(code.user, { ip: ctx.ip, ua: ctx.userAgent }, { amr: "passkey" })
    const n = nonce()
    // Same as the login page after /auth/login: the secret goes to this exact origin's storage, then on to `next`
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Logging in · candy</title><style nonce="${n}">${PAGE_STYLE}</style></head><body><main><p id="msg">Logging you in…</p></main>`
      + `<script nonce="${n}">(function(){var s=${scriptJson(secret)},n=${scriptJson(next)},ok=false;try{localStorage.setItem('candy_session',s);ok=localStorage.getItem('candy_session')===s}catch(e){}if(!ok){document.getElementById('msg').textContent='This browser blocks storage, which the portal needs to stay logged in.';return}location.replace(n)})()</script></body></html>`
    const headers = new Headers({ ...HTML_HEADERS, "Content-Security-Policy": pageCsp(n) })
    headers.append("Set-Cookie", d.sessionCookie(cookie, ctx.https))
    headers.append("Set-Cookie", `${PASSKEY_BIND_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`)
    return new Response(html, { headers })
  }

  const portalLogin = (ctx: AuthRouteContext): RequestAuth | null =>
    ctx.portalHost && ctx.auth?.via === "portal" && ctx.auth.sessionId ? ctx.auth : null

  const reauth = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const body = await readJsonBody(req)
    // Always the session's own account: the body's user (if any) is ignored
    // For an app's max_age: the request this password re-authenticates for (bound to it)
    const forRequest = body.request === undefined ? null : pendingHere(body.request, ctx)
    if (body.request !== undefined && !forRequest) return json(ctx, { error: AUTHZ_EXPIRED }, 404)
    const out = await d.passwordLogin({ user: auth.user, password: body.password, ip: ctx.ip })
    if (!out.ok) return json(ctx, out.body, out.status)
    const at = d.sessions.markPam(auth.sessionId!, forRequest ? freshKey(forRequest.id) : null)
    if (at === null) return json(ctx, { error: "login required" }, 401, { "X-Candy-Login": "required" })
    d.audit("AUTH_REAUTH", `${logSafe(auth.user)} from ${logSafe(ctx.ip)}${forRequest ? ` (for ${forRequest.site})` : ""}`, ctx.actor)
    return json(ctx, { pamUntil: at + RECENT_PAM_MS })
  }

  const passkeysPage = async (ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    return htmlPage("portal-passkeys.html", d.pageTokens.mint(auth.sessionId!), {
      user: auth.user, superuser: auth.superuser, candyHost: d.candyHost(), pamUntil: pamUntil(auth),
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
    const candy = d.candyHost() ?? ""
    return json(ctx, { passkeys: store.list(user).map(r => store.view(r, candy)) })
  }

  // POST /passkeys/enroll/start {name?}: an enroll stamp for this login (recent
  // password required), and the candy-host URL the passkeys page opens as a popup
  const enrollStart = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const candy = d.candyHost()
    if (!candy) return json(ctx, { error: PASSKEYS_NEED_DOMAIN }, 404)
    const s = session(auth)
    if (!mayManagePasskeys(s, d.now())) return json(ctx, { error: PASSKEY_NEEDS_PASSWORD, reauth: true }, 403)
    if (d.passkeys.store.atLimit(auth.user)) return json(ctx, { error: PASSKEY_LIMIT }, 409)
    const body = await readJsonBody(req)
    const live = d.sessions.byId(s.id)
    if (!live) return json(ctx, { error: "login required" }, 401, { "X-Candy-Login": "required" })
    let stamp: string
    try {
      stamp = d.tickets.mintStamp({
        purpose: "enroll", host: candy, portal: ctx.host, next: "/passkeys", bind: null,
        user: auth.user, sessionId: s.id, pamAt: s.pamAt, name: typeof body.name === "string" ? body.name : null,
        seq: live.enrollSeq,
      }, mintBy(ctx))
    } catch (e) {
      if (e instanceof TicketsBusy) return busyJson(ctx, e)
      throw e
    }
    return json(ctx, { url: `https://${candy}/passkey/enroll?${STAMP_PARAM}=${encodeURIComponent(stamp)}`, origin: `https://${candy}` })
  }

  const rename = async (req: Request, ctx: AuthRouteContext): Promise<Response> => {
    const auth = portalLogin(ctx)
    if (!auth) return notFound(ctx)
    const body = await readJsonBody(req)
    const out = renamePasskey(d.passkeys, { id: body.id, name: body.name, session: session(auth) })
    if (!out.ok) return json(ctx, out.body, out.status)
    return json(ctx, { passkey: d.passkeys.store.view(out.record, d.candyHost() ?? "") })
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
      case "POST /app-auth/fresh": return freshStart(req, ctx)
      case "GET /app-auth/sites": return ctx.auth ? sites(ctx) : null
      case "POST /app-auth/rotate": return ctx.auth ? rotate(req, ctx) : null
      case "GET /app-auth/consents": return ctx.auth ? consentList(ctx) : null
      case "POST /app-auth/consents/revoke": return ctx.auth ? revoke(req, ctx) : null
      case "POST /sdk/auth/keys": return keyFetch(req, ctx)
      case "GET /auth/passkey/start": return passkeyStart(req, url, ctx)
      case "POST /auth/passkey/finish": return passkeyFinish(req, ctx)
      case "POST /auth/reauth": return reauth(req, ctx)
      case "GET /passkeys": return passkeysPage(ctx)
      case "GET /passkeys/list": return ctx.auth ? passkeyList(url, ctx) : null
      case "POST /passkeys/enroll/start": return enrollStart(req, ctx)
      case "POST /passkeys/rename": return rename(req, ctx)
      case "POST /passkeys/delete": return remove(req, ctx)
    }
    return null
  }

  return { handle }
}
