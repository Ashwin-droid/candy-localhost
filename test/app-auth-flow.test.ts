// End to end: "Sign in with candy" and passkeys, through the real route
// handlers (app-auth-routes.ts, and candy-host.ts for candy's own host, where
// every passkey ceremony runs) with real stores, real keys, the real SDK
// (sdk-auth.ts) and a software authenticator doing real ES256.
//
// daemon.ts can't be imported (it starts the daemon), so its part is played by
// a small harness that runs the same checks in the same order as controlFetch:
// the portal shell for PORTAL_PAGES, requestAuth, guardRequest with
// ROUTE_TABLE, sameOrigin + the page token (TOKENLESS_ROUTES excepted), the
// /sdk/ API-key rule. ROUTE_TABLE, PORTAL_PAGES and TOKENLESS_ROUTES are read
// from daemon.ts, so the harness follows the daemon's real configuration.
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppKeyStore, ConsentStore, PendingRequests, AUTHZ_BAD_RETURN, AUTHZ_CHANGED, AUTHZ_EXPIRED, AUTHZ_NOT_SITE, type SiteLookup } from "../app-auth.ts"
import { APP_AUTH_ROUTES, createAuthRoutes, MAX_AUTH_BODY_BYTES, PASSKEY_FINISH_PATH, readJsonBody, type AuthRouteContext } from "../app-auth-routes.ts"
import {
  createCandyHost, fromCandyHost, PasskeyTickets, CANDY_HOST_ROUTES, CEREMONY_COOKIE, CODE_FIELD, ENROLL_SESSION_GONE,
  PASSKEY_BIND_COOKIE, PASSKEYS_NEED_DOMAIN, STAMP_EXPIRED, STAMP_PARAM,
} from "../candy-host.ts"
import { openClaims, parseKeyRing } from "../jwe.ts"
import { ChallengeStore, PasskeyStore, PASSKEY_FAILED, PASSKEY_NEEDS_PASSWORD, type PasskeyDeps } from "../passkey-store.ts"
import {
  attemptLogin, classifyRoute, guardRequest, LoginSlots, PageTokens, sameOrigin, SESSION_HEADER, SoftLockout, wantsHtml,
  type LoginDeps, type RequestAuth, type RouteClass, type RouteRule,
} from "../portal-auth.ts"
import { PortalSessions, readSessionCookie, sessionCookieHeader } from "../portal-session.ts"
import { CALLBACK_PATH, createAppAuth, LOGIN_PATH, redirectAfterLogin, STATE_COOKIE, type AppAuth } from "../sdk-auth.ts"
import * as webauthn from "../webauthn.ts"
import { redactBody } from "../fn-log.ts"
import { caddyGlobalBlock, LOG_REDACTED_QUERY_PARAMS } from "../caddy-config.ts"
import { authFromEnv, checkReservedBindings, type HostConfig } from "../fn-host.ts"

const root = join(import.meta.dir, "..")
const daemonSrc = await Bun.file(join(root, "daemon.ts")).text()

// ---------------------------------------------------------------------------
// The daemon's configuration, read from daemon.ts

const parseTable = (): RouteRule[] => {
  const text = daemonSrc.slice(daemonSrc.indexOf("// route-table:begin"), daemonSrc.indexOf("// route-table:end"))
  const rules: RouteRule[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*\["([A-Z]+|\*)", "([^"]+)", "(public|user|superuser)"\],\s*$/)
    if (m) rules.push([m[1], m[2], m[3] as RouteClass])
  }
  return rules
}
const setFromDaemon = (name: string): Set<string> => {
  const m = daemonSrc.match(new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\)`))
  if (!m) throw new Error(`${name} not found in daemon.ts`)
  return new Set(JSON.parse(m[1]))
}
const ROUTE_TABLE = parseTable()
const PORTAL_PAGES = setFromDaemon("PORTAL_PAGES")
const TOKENLESS_ROUTES = setFromDaemon("TOKENLESS_ROUTES")

// ---------------------------------------------------------------------------
// b64url, CBOR (encoder, test only), DER

const b64u = (b: Uint8Array | ArrayBuffer): string => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url")
const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"))
const sha256 = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", b))
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>
const head = (major: number, n: number): number[] =>
  n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : n < 65536 ? [(major << 5) | 25, n >> 8, n & 255] : [(major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]
const cbor = (v: Cbor): number[] => {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === "string") { const b = new TextEncoder().encode(v); return [...head(3, b.length), ...b] }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v]
  const out = head(5, v.size)
  for (const [k, x] of v) out.push(...cbor(k), ...cbor(x))
  return out
}
const derInt = (b: Uint8Array): number[] => {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  let x = [...b.slice(i)]
  if (x[0] & 0x80) x = [0, ...x]
  return [0x02, x.length, ...x]
}
const rawToDer = (raw: Uint8Array): Uint8Array => {
  const r = derInt(raw.slice(0, 32)), s = derInt(raw.slice(32))
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s])
}

// ---------------------------------------------------------------------------
// A software authenticator: discoverable ES256 credentials, UV always

interface SoftCredential { id: Uint8Array; keys: CryptoKeyPair; rpId: string; userHandle: string; counter: number }

class SoftAuthenticator {
  creds: SoftCredential[] = []

  async create(o: webauthn.CreationOptionsJSON, origin: string): Promise<webauthn.RegistrationResponseJSON> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
    const id = crypto.getRandomValues(new Uint8Array(32))
    const cred: SoftCredential = { id, keys, rpId: o.rp.id, userHandle: o.user.id, counter: 0 }
    const cose = new Uint8Array(cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x!)], [-3, unb64u(jwk.y!)]])))
    const authData = concat(
      await sha256(new TextEncoder().encode(o.rp.id)),
      new Uint8Array([0x01 | 0x04 | 0x40]), new Uint8Array(4),
      new Uint8Array(16), new Uint8Array([0, id.length]), id, cose,
    )
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin, crossOrigin: false }))
    const att = new Uint8Array(cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])))
    this.creds.push(cred)
    return { id: b64u(id), rawId: b64u(id), type: "public-key", response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ["internal"] } }
  }

  /** An assertion with the first credential for this rpId (or `use`), its counter moved forward by `step`. */
  async get(o: webauthn.RequestOptionsJSON, origin: string, opt: { use?: SoftCredential; step?: number; asRpId?: string } = {}): Promise<webauthn.AuthenticationResponseJSON> {
    const cred = opt.use ?? this.creds.find(c => c.rpId === (opt.asRpId ?? o.rpId))
    if (!cred) throw new Error("no credential for " + o.rpId)
    cred.counter += opt.step ?? 1
    const counter = new Uint8Array(4)
    new DataView(counter.buffer).setUint32(0, cred.counter)
    const authData = concat(await sha256(new TextEncoder().encode(cred.rpId)), new Uint8Array([0x01 | 0x04]), counter)
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin, crossOrigin: false }))
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, cred.keys.privateKey, concat(authData, await sha256(clientData))))
    return {
      id: b64u(cred.id), rawId: b64u(cred.id), type: "public-key",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(rawToDer(raw)), userHandle: cred.userHandle },
    }
  }
}

// ---------------------------------------------------------------------------
// The machine: users, sites, the daemon's stores

const USERS = ["ashwin", "claude", "mallory"]
const PASSWORDS: Record<string, string> = { ashwin: "pw-ashwin", claude: "pw-claude", mallory: "pw-mallory" }
const SUPERUSERS = new Set(["ashwin"])
let uids: Map<string, number>
let accountDenied: Set<string>
const PORTALS = new Set(["portal.localhost", "portal.candy"])
const isPortal = (h: string) => PORTALS.has(h)
// candy.<zone>: the passkey rpId and ceremony host (candyHost() in daemon.ts)
const CANDY = "candy.example.com"
const CANDY_ORIGIN = `https://${CANDY}`
let candyOn = true
const candyHost = () => candyOn ? CANDY : null

let dir: string
let loginUsers: string[]
let owners: Map<string, string>           // site -> owner
let hosts: Map<string, string>            // https host -> site
let apiKeys: Map<string, string>          // API key -> user
let audits: [string, string][]
let lockedIps: Map<string, number>
let keysChangedCalls: string[]
let appKeys: AppKeyStore
let consents: ConsentStore
let pending: PendingRequests
let sessions: PortalSessions
let pageTokens: PageTokens
let passkeyDeps: PasskeyDeps
let routes: ReturnType<typeof createAuthRoutes>
let tickets: PasskeyTickets
let candyRoutes: ReturnType<typeof createCandyHost>
let clock: { now: number }

const siteLookup: SiteLookup = {
  siteOfHost: (h: string) => (isPortal(h) || h.includes(":")) ? null : hosts.get(h) ?? null,
  ownerOf: (s: string) => owners.get(s) ?? null,
}

const loginDeps = (): LoginDeps => ({
  pamReady: () => true,
  loginUsers: async () => loginUsers,
  verifyPassword: async (u, p) => PASSWORDS[u] === p ? { ok: true, reason: "ok" } : { ok: false, reason: "denied" },
  isSuperuser: async u => SUPERUSERS.has(u),
  blocked: async () => ({ blocked: false, retryAfter: 0 }),
  fail: async () => ({ retryAfter: 0 }),
  clear: async () => {},
  audit: (a, d) => { audits.push([a, d]) },
  serverError: () => {},
  now: () => clock.now,
  sleep: async () => {},
  isLoopback: ip => ip.startsWith("127."),
  slots: new LoginSlots(),
  soft: new SoftLockout(() => clock.now),
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "candy-app-auth-flow-"))
  clock = { now: Date.now() }
  loginUsers = [...USERS]
  uids = new Map([["ashwin", 1000], ["claude", 1001], ["mallory", 1002]])
  accountDenied = new Set()
  owners = new Map([["notes", "claude"], ["other", "mallory"]])
  hosts = new Map([["notes.localhost", "notes"], ["notes.candy", "notes"], ["notes.example.com", "notes"], ["other.localhost", "other"]])
  apiKeys = new Map([["key-claude", "claude"], ["key-mallory", "mallory"], ["key-ashwin", "ashwin"]])
  audits = []
  lockedIps = new Map()
  keysChangedCalls = []
  const now = () => clock.now
  appKeys = new AppKeyStore(join(dir, "app-auth-keys.json"), { now })
  consents = new ConsentStore(join(dir, "app-auth-consent.json"), { now })
  pending = new PendingRequests({ now })
  sessions = new PortalSessions(join(dir, "portal-sessions.json"), { now })
  pageTokens = new PageTokens(now)
  passkeyDeps = {
    store: new PasskeyStore(join(dir, "passkeys.json"), { now }),
    challenges: new ChallengeStore({ now }),
    webauthn,
    soft: new SoftLockout(now),
    loginUsers: async () => loginUsers,
    uidOf: async u => uids.get(u) ?? null,
    accountOk: async u => !accountDenied.has(u),
    isSuperuser: async u => SUPERUSERS.has(u),
    isLoopback: ip => ip.startsWith("127."),
    audit: (a, d) => { audits.push([a, d]) },
    now,
    sleep: async () => {},
  }
  candyOn = true
  SUPERUSERS.clear(); SUPERUSERS.add("ashwin")
  tickets = new PasskeyTickets({ now })
  candyRoutes = createCandyHost({
    host: candyHost, tickets, passkeys: passkeyDeps, isPortalHost: isPortal,
    session: id => sessions.byId(id),
    enrolled: id => { sessions.bumpEnroll(id) },
    addressWait: async ip => lockedIps.get(ip) ?? 0,
    page: () => Bun.file(join(root, "public", "passkey-host.html")).text(),
    audit: (a, d) => { audits.push([a, d]) },
    now,
  })
  const deps = loginDeps()
  routes = createAuthRoutes({
    appKeys, consents, pending, passkeys: passkeyDeps, candyHost, tickets, sessions, pageTokens, site: siteLookup,
    mayUse: (auth, name) => !!auth && (auth.superuser || owners.get(name) === auth.user),
    passwordLogin: input => attemptLogin(deps, input),
    addressWait: async ip => lockedIps.get(ip) ?? 0,
    siteForKeyFetch: body => typeof body.name === "string" && owners.has(body.name) ? body.name : null,
    issuers: () => ["https://portal.localhost", "https://portal.candy"],
    portalUrl: () => "https://portal.localhost",
    keysChanged: async site => { keysChangedCalls.push(site); return [] },
    page: file => Bun.file(join(root, "public", file)).text(),
    pageScript: (token, vars) => `<script>window.CANDY_TOKEN=${JSON.stringify(token)};window.CANDY_VARS=${JSON.stringify(vars)};</script>`,
    readSessionCookie,
    sessionCookie: sessionCookieHeader,
    sessionHeader: SESSION_HEADER,
    audit: (a, d) => { audits.push([a, d]) },
    now,
  })
})
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

// ---------------------------------------------------------------------------
// The daemon's request path for these routes (controlFetch, in order)

const requestAuthOf = (req: Request, portalHost: boolean): RequestAuth | null => {
  const key = req.headers.get("X-Candy-API-Key")
  if (key) {
    const user = apiKeys.get(key)
    return user ? { user, superuser: false, via: "apikey" } : null
  }
  if (!portalHost) return null
  const s = sessions.get(readSessionCookie(req.headers.get("cookie")), req.headers.get(SESSION_HEADER))
  if (!s || !loginUsers.includes(s.user)) return null
  // As daemon.ts requestAuth: a sudoer is a superuser however the login was made
  return {
    user: s.user, superuser: SUPERUSERS.has(s.user), via: "portal", sessionId: s.id, amr: s.amr, pamAt: s.pamAt, sessionCreated: s.created,
    authAt: s.authAt, authMethod: s.authMethod, freshFor: s.freshFor,
  }
}

const daemon = async (req: Request, ip = "127.0.0.1"): Promise<Response> => {
  const url = new URL(req.url)
  const host = (req.headers.get("host") || "").toLowerCase().replace(/:443$/, "")
  // candy's own host: before anything else, by Host, never falling through (as controlFetch does)
  if (host === CANDY) return candyOn ? candyRoutes.handle(req, url, { ip }) : new Response("Not found", { status: 404 })
  const portalHost = isPortal(host)
  if (portalHost && PORTAL_PAGES.has(url.pathname) && !req.headers.get(SESSION_HEADER) && wantsHtml(req.method, req.headers.get("accept"))) {
    return new Response("<!doctype html><title>shell</title>", { headers: { "Content-Type": "text/html", "X-Test": "shell" } })
  }
  const auth = requestAuthOf(req, portalHost)
  const verdict = guardRequest({
    cls: classifyRoute(ROUTE_TABLE, req.method, url.pathname), auth, portalHost,
    html: wantsHtml(req.method, req.headers.get("accept")) && !req.headers.get(SESSION_HEADER), path: url.pathname, search: url.search,
  })
  if (!verdict.ok) {
    if (verdict.status === 302) return new Response(null, { status: 302, headers: { Location: verdict.location } })
    return Response.json({ error: verdict.error }, { status: verdict.status, headers: verdict.status === 401 ? { "X-Candy-Login": "required" } : {} })
  }
  if (portalHost && req.method !== "GET" && req.method !== "HEAD") {
    const fromOwnHost = url.pathname === PASSKEY_FINISH_PATH && fromCandyHost(req.headers, candyHost())
    if (!fromOwnHost && !sameOrigin(req.headers, isPortal)) return Response.json({ error: "Cross-site request refused." }, { status: 403 })
    if (auth?.via === "portal" && !TOKENLESS_ROUTES.has(url.pathname) && !pageTokens.consume(req.headers.get("X-Candy-Token"), auth.sessionId)) {
      return Response.json({ error: "Invalid or expired token. Refresh required." }, { status: 401 })
    }
  }
  if (url.pathname.startsWith("/sdk/") && auth?.via !== "apikey") return Response.json({ error: "Invalid or expired token. Refresh required." }, { status: 401 })
  if (!APP_AUTH_ROUTES.includes(url.pathname)) return Response.json({ error: "not found" }, { status: 404 })
  const ctx: AuthRouteContext = { auth, portalHost, host, ip, userAgent: "test", https: true, cors: {}, actor: auth ? `${auth.user}:test` : "Portal" }
  return (await routes.handle(req, url, ctx)) ?? Response.json({ error: "not found" }, { status: 404 })
}

// ---------------------------------------------------------------------------
// Apps on candy, using the real SDK

const logins: { site: string; user: string; amr: string[]; superuser?: boolean; authTime?: number }[] = []
const appClock = { offset: 0 }
const makeApp = (site: string, keyOf: string): AppAuth => createAppAuth({
  site,
  env: {},
  // The apps' clock is the machine's (the portal's test clock), plus an offset for skew tests
  now: () => clock.now + appClock.offset,
  // The SDK's daemon fetch: the owner's API key, through the daemon's /sdk/auth/keys
  fetchKeys: async s => {
    const res = await daemon(new Request("http://localhost:9999/sdk/auth/keys", {
      method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": keyOf, "Content-Type": "application/json" }, body: JSON.stringify({ name: s }),
    }))
    if (!res.ok) throw new Error(`key fetch ${res.status}`)
    return (await res.json()).keys
  },
})
let apps: Map<string, AppAuth>
beforeEach(() => {
  appClock.offset = 0
  logins.length = 0
  apps = new Map([["notes", makeApp("notes", "key-claude")], ["other", makeApp("other", "key-mallory")]])
})
const appServer = async (req: Request): Promise<Response> => {
  const host = (req.headers.get("host") || "").toLowerCase()
  const site = hosts.get(host)
  const auth = site ? apps.get(site) : undefined
  if (!auth) return new Response("no such app", { status: 404 })
  // Tests ask for a freshness demand with ?want_max_age= on the app's login path
  const wanted = new URL(req.url).searchParams.get("want_max_age")
  const r = await auth.handle(req, u => {
    logins.push({ site: auth.site, user: u.user, amr: u.amr, superuser: u.superuser, authTime: u.authTime })
    // A fresh app session id on every login
    return redirectAfterLogin(u.next, `sid=${crypto.randomUUID()}; Path=/; Secure; HttpOnly; SameSite=Lax`)
  }, wanted !== null ? { maxAge: Number(wanted) } : {})
  return r ?? new Response(`${site} home`)
}

// ---------------------------------------------------------------------------
// A browser: cookies per host, the portal's session secret in its storage

class Browser {
  jar = new Map<string, Map<string, string>>()
  secret = new Map<string, string>()   // portal host -> localStorage candy_session
  ip = "127.0.0.1"

  async fetch(target: string, init: { method?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string>; origin?: string; html?: boolean; withSecret?: boolean } = {}): Promise<Response> {
    const url = new URL(target)
    const host = url.host
    const headers: Record<string, string> = { host, ...(init.headers ?? {}) }
    const cookies = this.jar.get(host)
    if (cookies?.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ")
    if (init.html) headers.accept = "text/html"
    if (init.origin) headers.origin = init.origin
    if (init.withSecret !== false && isPortal(host) && this.secret.has(host) && init.withSecret) headers[SESSION_HEADER] = this.secret.get(host)!
    let body: string | undefined
    if (init.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(init.json) }
    if (init.form) { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(init.form).toString() }
    const req = new Request(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body })
    const res = isPortal(host) || host === CANDY ? await daemon(req, this.ip) : await appServer(req)
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";")
      const i = pair.indexOf("=")
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim()
      const jar = this.jar.get(host) ?? new Map<string, string>()
      this.jar.set(host, jar)
      if (attrs.some(a => /^\s*max-age=0\s*$/i.test(a)) || value === "") jar.delete(name)
      else jar.set(name, value)
    }
    return res
  }

  /** A portal page as the shell gets it: with the session secret. */
  async page(target: string): Promise<{ res: Response; token: string | null; vars: any }> {
    const res = await this.fetch(target, { html: true, withSecret: true })
    const html = await res.text()
    const token = html.match(/window\.CANDY_TOKEN=("[^"]*"|null);/)?.[1]
    const vars = html.match(/window\.CANDY_VARS=(.*?);<\/script>/)?.[1]
    return { res, token: token ? JSON.parse(token) : null, vars: vars ? JSON.parse(vars) : null }
  }

  /** A state-changing POST from a portal page (Origin, page token, session secret). */
  async post(portal: string, path: string, token: string | null, json: unknown): Promise<Response> {
    return this.fetch(`https://${portal}${path}`, {
      method: "POST", json, origin: `https://${portal}`, withSecret: true, headers: token ? { "X-Candy-Token": token } : {},
    })
  }

  /** What POST /auth/login does on success (daemon.ts): a fresh PAM session, cookie, secret in storage. */
  pamLogin(user: string, portal = "portal.localhost") {
    const { cookie, secret } = sessions.create(user, { ip: this.ip, ua: "test" })
    const jar = this.jar.get(portal) ?? new Map<string, string>()
    jar.set("candy_portal", cookie)
    this.jar.set(portal, jar)
    this.secret.set(portal, secret)
  }

  /** The consent page's script: build <form method=POST> from {action, fields} and submit it. */
  async submitForm(post: { action: string; fields: Record<string, string> }, portal = "portal.localhost"): Promise<Response> {
    return this.fetch(post.action, { method: "POST", form: post.fields, origin: `https://${portal}` })
  }
}

/** The whole delegated flow up to the consent page. Returns the parked request id. */
const startAppLogin = async (b: Browser, appHost = "notes.localhost", next = "/x", maxAge?: number): Promise<{ authorize: string; request: string }> => {
  const start = await b.fetch(`https://${appHost}${LOGIN_PATH}?next=${encodeURIComponent(next)}${maxAge !== undefined ? `&want_max_age=${maxAge}` : ""}`)
  expect(start.status).toBe(302)
  const authorize = start.headers.get("location")!
  const az = await b.fetch(authorize)
  expect(az.status).toBe(302)
  const consentUrl = az.headers.get("location")!
  expect(consentUrl).toMatch(/^\/app-auth\/consent\?request=[A-Za-z0-9_-]{40,}$/)
  return { authorize, request: new URL(consentUrl, "https://x").searchParams.get("request")! }
}

const decide = async (b: Browser, request: string, approve = true, remember = true, portal = "portal.localhost") => {
  const page = await b.page(`https://${portal}/app-auth/consent?request=${request}`)
  expect(page.res.status).toBe(200)
  const res = await b.post(portal, "/app-auth/decision", page.token, { request, approve, remember })
  return { page, res, body: await res.json() as any }
}

// ===========================================================================

describe("the daemon dispatches every route in this module", () => {
  it("each path is classified in ROUTE_TABLE and matched in controlFetch", () => {
    const control = daemonSrc.slice(daemonSrc.indexOf("async function controlFetch("))
    for (const path of APP_AUTH_ROUTES) {
      expect(ROUTE_TABLE.some(([, p]) => p === path)).toBe(true)
      expect(control).toContain(`url.pathname === "${path}"`)
    }
    // The key fetch is answered only after the /sdk/ API-key check
    const sdkCheck = control.indexOf(`url.pathname.startsWith("/sdk/") && auth?.via !== "apikey"`)
    expect(sdkCheck).toBeGreaterThan(0)
    expect(control.indexOf(`url.pathname === "/sdk/auth/keys"`)).toBeGreaterThan(sdkCheck)
    // And all of them after the guard
    const guard = control.indexOf("classifyRoute(ROUTE_TABLE, req.method, url.pathname)")
    expect(control.indexOf(`url.pathname === "/app-auth/authorize"`)).toBeGreaterThan(guard)
  })

  it("classes: authorize and passkey login public, the rest need a login", () => {
    const cls = (m: string, p: string) => classifyRoute(ROUTE_TABLE, m, p)
    expect(cls("GET", "/app-auth/authorize")).toBe("public")
    expect(cls("GET", "/auth/passkey/start")).toBe("public")
    expect(cls("POST", "/auth/passkey/finish")).toBe("public")
    // The old per-portal-host ceremony routes are gone
    for (const [m, p] of [["POST", "/auth/passkey/options"], ["POST", "/auth/passkey"], ["POST", "/passkeys/register/options"], ["POST", "/passkeys/register"]]) expect(cls(m, p)).toBeNull()
    for (const [m, p] of [["GET", "/app-auth/consent"], ["POST", "/app-auth/decision"], ["POST", "/app-auth/fresh"], ["POST", "/app-auth/rotate"], ["POST", "/sdk/auth/keys"],
      ["POST", "/auth/reauth"], ["GET", "/passkeys"], ["POST", "/passkeys/enroll/start"], ["POST", "/passkeys/delete"]]) {
      expect(cls(m, p)).toBe("user")
    }
    // A GET never mints a token
    expect(cls("GET", "/app-auth/decision")).toBeNull()
    expect(PORTAL_PAGES.has("/app-auth/consent") && PORTAL_PAGES.has("/passkeys")).toBe(true)
    expect([...TOKENLESS_ROUTES].filter(p => p.includes("passkey") || p.includes("app-auth")).sort()).toEqual(["/auth/passkey/finish"])
  })
})

describe("delegated login (PAM session)", () => {
  it("app -> portal -> login -> consent -> form POST back -> the SDK returns the user", async () => {
    const b = new Browser()
    const { authorize, request } = await startAppLogin(b)
    const az = new URL(authorize)
    expect(az.origin).toBe("https://portal.localhost")
    expect(az.searchParams.get("return_to")).toBe(`https://notes.localhost${CALLBACK_PATH}`)
    expect(b.jar.get("notes.localhost")?.has(STATE_COOKIE)).toBe(true)

    // Not logged in: the navigation gets the shell, and the shell's request a 401 (-> /login)
    const shell = await b.fetch(`https://portal.localhost/app-auth/consent?request=${request}`, { html: true })
    expect(shell.headers.get("X-Test")).toBe("shell")
    const noLogin = await b.fetch(`https://portal.localhost/app-auth/consent?request=${request}`, { html: true, headers: { [SESSION_HEADER]: "nope" } })
    expect(noLogin.status).toBe(401)

    b.pamLogin("ashwin")
    const { page, res, body } = await decide(b, request)
    expect(page.vars).toMatchObject({ request, site: "notes", owner: "claude", ownerIsYou: false, user: "ashwin", returnHost: "notes.localhost", hostKind: "local", remembered: false, amr: "pam" })
    expect(JSON.stringify(page.vars)).not.toContain(az.searchParams.get("state")!)
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(body.action).toBe(`https://notes.localhost${CALLBACK_PATH}`)
    expect(Object.keys(body.fields).sort()).toEqual(["candy_token", "state"])

    const back = await b.submitForm(body)
    expect(back.status).toBe(303)
    expect(back.headers.get("location")).toBe("/x")
    expect(logins).toMatchObject([{ site: "notes", user: "ashwin", amr: ["pam"], superuser: true }])
    // The state cookie is gone, the app's own session is set
    expect(b.jar.get("notes.localhost")?.has(STATE_COOKIE)).toBe(false)
    expect(b.jar.get("notes.localhost")?.has("sid")).toBe(true)

    // Audited without the token, the key or the state
    const grant = audits.find(([a]) => a === "APP_AUTH_GRANT")!
    expect(grant[1]).toContain("ashwin -> notes at notes.localhost (pam, superuser)")
    const all = JSON.stringify(audits)
    expect(all).not.toContain(body.fields.candy_token)
    expect(all).not.toContain(body.fields.state)
    expect(audits.some(([a]) => a === "APP_AUTH_KEY_FETCH")).toBe(true)
  })

  it("remembers consent per user and site: the next page says remembered, and the token still needs the POST", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    const first = await startAppLogin(b)
    expect((await b.submitForm((await decide(b, first.request, true, true)).body)).status).toBe(303)
    const second = await startAppLogin(b, "notes.localhost", "/y")
    const page = await b.page(`https://portal.localhost/app-auth/consent?request=${second.request}`)
    expect(page.vars).toMatchObject({ remembered: true, ownerIsYou: true })
    const res = await b.post("portal.localhost", "/app-auth/decision", page.token, { request: second.request, approve: true, remember: true })
    expect((await b.submitForm(await res.json() as any)).headers.get("location")).toBe("/y")
    expect(logins.map(l => l.user)).toEqual(["claude", "claude"])
    // Another user hasn't approved it
    expect(consents.has("ashwin", "notes", "claude")).toBe(false)
    // Revoked: asked again
    const rv = await b.post("portal.localhost", "/app-auth/consents/revoke", (await b.page("https://portal.localhost/passkeys")).token, { site: "notes" })
    expect(await rv.json()).toEqual({ revoked: true })
    const third = await startAppLogin(b)
    expect((await b.page(`https://portal.localhost/app-auth/consent?request=${third.request}`)).vars.remembered).toBe(false)
  })

  it("cancel goes back with error=access_denied, and the app says so", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const { request } = await startAppLogin(b)
    const { body } = await decide(b, request, false)
    expect(body.fields).toEqual({ error: "access_denied", state: expect.any(String) })
    const back = await b.submitForm(body)
    expect(back.status).toBe(403)
    expect(await back.text()).toContain("cancelled")
    expect(logins).toEqual([])
    expect(audits.some(([a]) => a === "APP_AUTH_DENY")).toBe(true)
  })

  it("works for a bound domain and the .candy name, never on a port", async () => {
    const b = new Browser()
    b.pamLogin("ashwin", "portal.candy")
    const { request } = await startAppLogin(b, "notes.candy")
    const { body, page } = await decide(b, request, true, false, "portal.candy")
    expect(page.vars.hostKind).toBe("tailnet")
    expect(body.action).toBe(`https://notes.candy${CALLBACK_PATH}`)
    expect((await b.submitForm(body, "portal.candy")).status).toBe(303)
    // The token's issuer is the portal host it was minted on
    const ring = appKeys.ring("notes", "claude")!
    expect(ring.length).toBe(1)
  })
})

describe("delegated login: refusals (threat model)", () => {
  const authorizeWith = async (b: Browser, returnTo: string, extra = "") =>
    b.fetch(`https://portal.localhost/app-auth/authorize?return_to=${encodeURIComponent(returnTo)}&state=${"s".repeat(20)}${extra}`)

  it("open redirect: return_to must route to a candy site; a bad one is an error page, never a redirect", async () => {
    const b = new Browser()
    for (const [rt, status, error] of [
      [`https://evil.example${CALLBACK_PATH}`, 404, AUTHZ_NOT_SITE],
      ["https://notes.localhost/cb", 400, AUTHZ_BAD_RETURN],
      [`https://notes.localhost${CALLBACK_PATH}?next=/x`, 400, AUTHZ_BAD_RETURN],
      ["http://notes.localhost/cb", 400, AUTHZ_BAD_RETURN],
      ["https://notes.localhost:8443/cb", 400, AUTHZ_BAD_RETURN],
      ["https://user@notes.localhost/cb", 400, AUTHZ_BAD_RETURN],
      ["https://notes.localhost/cb#x", 400, AUTHZ_BAD_RETURN],
      [`https://portal.localhost${CALLBACK_PATH}`, 404, AUTHZ_NOT_SITE],
      [`https://notes.k.localhost${CALLBACK_PATH}`, 404, AUTHZ_NOT_SITE],
      [`https://x.trycloudflare.com${CALLBACK_PATH}`, 404, AUTHZ_NOT_SITE],
      ["javascript:alert(1)", 400, AUTHZ_BAD_RETURN],
      ["//evil.example/cb", 400, AUTHZ_BAD_RETURN],
    ] as const) {
      const res = await authorizeWith(b, rt)
      expect(res.status).toBe(status)
      expect(res.headers.get("location")).toBeNull()
      expect(res.headers.get("content-type")).toContain("text/html")
      expect(await res.text()).toContain(JSON.stringify({ error }))
    }
    expect(pending.size).toBe(0)
  })

  it("authorize is portal-only", async () => {
    const res = await daemon(new Request("http://localhost:9999/app-auth/authorize?return_to=x", { headers: { host: "localhost:9999" } }))
    expect(res.status).toBe(404)
  })

  it("a token for site A is useless at site B", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const { request } = await startAppLogin(b)
    const { body } = await decide(b, request)
    const token = body.fields.candy_token
    // B's key can't open it, and A's key with B's audience fails too
    expect((await apps.get("other")!.verify(token)).error).toBe("unknown_kid")
    const ringA = appKeys.ring("notes", "claude")!
    await expect(openClaims(token, ringA, { aud: "other", issuers: ["https://portal.localhost"] })).rejects.toMatchObject({ code: "audience" })
    // POSTed to B's callback: no state cookie there
    const atB = await b.fetch(`https://other.localhost${CALLBACK_PATH}`, { method: "POST", form: body.fields, origin: "https://portal.localhost" })
    expect(atB.status).toBe(400)
    expect(logins).toEqual([])
  })

  it("replay: a token works once; a second POST, or the same token again, fails", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const { request } = await startAppLogin(b)
    const { body } = await decide(b, request)
    const cookie = b.jar.get("notes.localhost")!.get(STATE_COOKIE)!
    expect((await b.submitForm(body)).status).toBe(303)
    // The cookie was cleared: a resubmit has no state
    expect((await b.submitForm(body)).status).toBe(400)
    // Even with the old cookie put back, the jti is spent
    b.jar.get("notes.localhost")!.set(STATE_COOKIE, cookie)
    const again = await b.submitForm(body)
    expect(again.status).toBe(401)
    expect(await again.text()).not.toContain(body.fields.candy_token)
    expect(logins.length).toBe(1)
  })

  it("login CSRF: an attacker's token POSTed into a victim's browser fails the state check", async () => {
    const attacker = new Browser()
    attacker.pamLogin("mallory")
    const { request } = await startAppLogin(attacker)
    const { body } = await decide(attacker, request)
    const victim = new Browser()
    expect((await victim.submitForm(body)).status).toBe(400)
    // A victim that has its own login in flight: state mismatch
    await startAppLogin(victim)
    expect((await victim.submitForm(body)).status).toBe(403)
    expect(logins).toEqual([])
  })

  it("the token never travels in a URL", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const { authorize, request } = await startAppLogin(b)
    expect(authorize).not.toContain("candy_token")
    const { body } = await decide(b, request)
    const back = await b.submitForm(body)
    expect(back.headers.get("location")).not.toContain(body.fields.candy_token)
  })

  it("CSRF on the decision: Origin, page token, session secret, POST only", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const { request } = await startAppLogin(b)
    const page = await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    const send = (init: Parameters<Browser["fetch"]>[1]) => b.fetch("https://portal.localhost/app-auth/decision", { method: "POST", json: { request, approve: true }, ...init })
    expect((await send({ withSecret: true, headers: { "X-Candy-Token": page.token! } })).status).toBe(403)   // no Origin
    expect((await send({ withSecret: true, origin: "https://notes.localhost", headers: { "X-Candy-Token": page.token! } })).status).toBe(403)
    expect((await send({ withSecret: true, origin: "https://portal.localhost:8443", headers: { "X-Candy-Token": page.token! } })).status).toBe(403)
    expect((await send({ withSecret: true, origin: "https://portal.localhost" })).status).toBe(401)   // no page token
    expect((await send({ origin: "https://portal.localhost", headers: { "X-Candy-Token": page.token! } })).status).toBe(401)   // cookie without the secret
    // A page token from another login
    const other = new Browser()
    other.pamLogin("mallory")
    const otherPage = await other.page("https://portal.localhost/passkeys")
    expect((await send({ withSecret: true, origin: "https://portal.localhost", headers: { "X-Candy-Token": otherPage.token! } })).status).toBe(401)
    // GET never mints
    expect((await b.fetch(`https://portal.localhost/app-auth/decision?request=${request}`, { withSecret: true })).status).toBe(404)
    // Still parked: the refusals above consumed nothing
    expect(pending.get(request)).not.toBeNull()
    expect((await b.post("portal.localhost", "/app-auth/decision", page.token, { request, approve: true })).status).toBe(200)
  })

  it("an API key can't approve, and a parked request is single use and bound to its portal host", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    b.pamLogin("ashwin", "portal.candy")
    const { request } = await startAppLogin(b)
    const api = await daemon(new Request("http://localhost:9999/app-auth/decision", {
      method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": "key-ashwin", "content-type": "application/json" }, body: JSON.stringify({ request, approve: true }),
    }))
    expect(api.status).toBe(404)
    // Asked on portal.localhost, answered on portal.candy: no
    const elsewhere = await b.page(`https://portal.candy/app-auth/consent?request=${request}`)
    expect(elsewhere.res.status).toBe(404)
    expect(elsewhere.vars).toEqual({ error: AUTHZ_EXPIRED })
    const tokenCandy = (await b.page("https://portal.candy/passkeys")).token
    expect((await b.post("portal.candy", "/app-auth/decision", tokenCandy, { request, approve: true })).status).toBe(404)
    const first = await decide(b, request)
    expect(first.res.status).toBe(200)
    const again = await b.post("portal.localhost", "/app-auth/decision", (await b.page("https://portal.localhost/passkeys")).token, { request, approve: true })
    expect(again.status).toBe(404)
    expect((await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)).vars).toEqual({ error: AUTHZ_EXPIRED })
  })

  it("a site that changed hands since it asked gets nothing; the new owner gets a new key and no old approvals", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const first = await startAppLogin(b)
    expect((await decide(b, first.request, true, true)).res.status).toBe(200)
    const oldKid = appKeys.info("notes")!.kid
    expect(consents.has("ashwin", "notes", "claude")).toBe(true)

    const second = await startAppLogin(b)
    owners.set("notes", "mallory")
    const page = await b.page(`https://portal.localhost/app-auth/consent?request=${second.request}`)
    expect(page.res.status).toBe(409)
    expect(page.vars).toEqual({ error: AUTHZ_CHANGED })

    // mallory's app asks: a fresh ring, and ashwin's approval of claude's site doesn't carry over
    apps.set("notes", makeApp("notes", "key-mallory"))
    const third = await startAppLogin(b)
    const d = await decide(b, third.request, true, false)
    expect(d.page.vars).toMatchObject({ owner: "mallory", remembered: false })
    expect(appKeys.info("notes")!.kid).not.toBe(oldKid)
    expect(consents.has("ashwin", "notes", "claude")).toBe(false)
    expect(audits.some(([a, x]) => a === "APP_AUTH_RESET" && x.startsWith("notes:"))).toBe(true)
    expect((await b.submitForm(d.body)).status).toBe(303)
  })
})

describe("site keys: fetch and rotation", () => {
  const keyFetch = (key: string | null, body: unknown, portal = false) => daemon(new Request(portal ? "https://portal.localhost/sdk/auth/keys" : "http://localhost:9999/sdk/auth/keys", {
    method: "POST",
    headers: { host: portal ? "portal.localhost" : "localhost:9999", "content-type": "application/json", ...(portal ? { origin: "https://portal.localhost" } : {}), ...(key ? { "X-Candy-API-Key": key } : {}) },
    body: JSON.stringify(body),
  }))

  it("only the owner's API key gets the ring; never a portal login, never another user (superuser included)", async () => {
    const ok = await keyFetch("key-claude", { name: "notes" })
    expect(ok.status).toBe(200)
    const got = await ok.json() as any
    expect(got).toMatchObject({ site: "notes", issuers: ["https://portal.localhost", "https://portal.candy"], portal: "https://portal.localhost" })
    expect(parseKeyRing(got.keys).length).toBe(1)
    expect(ok.headers.get("Cache-Control")).toBe("no-store")
    expect((await keyFetch("key-mallory", { name: "notes" })).status).toBe(403)
    expect((await keyFetch("key-ashwin", { name: "notes" })).status).toBe(403)
    expect((await keyFetch(null, { name: "notes" })).status).toBe(401)
    expect((await keyFetch("key-claude", { name: "nope" })).status).toBe(404)
    // A portal login (even a superuser's) never gets a key: the /sdk/ rule
    const b = new Browser()
    b.pamLogin("ashwin")
    const portal = await b.fetch("https://portal.localhost/sdk/auth/keys", { method: "POST", json: { name: "notes" }, origin: "https://portal.localhost", withSecret: true, headers: { "X-Candy-Token": (await b.page("https://portal.localhost/passkeys")).token! } })
    expect(portal.status).toBe(401)
    // Never audited with the key
    expect(JSON.stringify(audits)).not.toContain(got.keys.split(":")[1])
  })

  it("rotation: the app's old ring meets a new kid, refetches once, and still verifies", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    // The app loads its ring on the first login
    const first = await startAppLogin(b)
    expect((await b.submitForm((await decide(b, first.request)).body)).status).toBe(303)
    const oldKid = appKeys.info("notes")!.kid

    const rot = await daemon(new Request("http://localhost:9999/app-auth/rotate", {
      method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": "key-claude", "content-type": "application/json" }, body: JSON.stringify({ name: "notes" }),
    }))
    expect(rot.status).toBe(200)
    const r = await rot.json() as any
    expect(r.site).toBe("notes")
    expect(r.kid).not.toBe(oldKid)
    expect(keysChangedCalls).toEqual(["notes"])
    expect(appKeys.ring("notes", "claude")!.map(k => k.kid)).toEqual([r.kid, oldKid])
    // Not someone else's site
    const no = await daemon(new Request("http://localhost:9999/app-auth/rotate", {
      method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": "key-mallory", "content-type": "application/json" }, body: JSON.stringify({ name: "notes" }),
    }))
    expect(no.status).toBe(403)

    // Past the SDK's refetch interval: the new kid is fetched on demand
    appClock.offset = 31_000
    const second = await startAppLogin(b)
    expect((await b.submitForm((await decide(b, second.request)).body)).status).toBe(303)
    expect(logins.length).toBe(2)

    // The sites list shows only your own
    const list = await daemon(new Request("http://localhost:9999/app-auth/sites", { headers: { host: "localhost:9999", "X-Candy-API-Key": "key-mallory" } }))
    expect((await list.json() as any).sites).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Passkey ceremonies, the way the pages drive them: the portal sends the
// browser to candy's own host with a stamp, the ceremony runs there, and a
// login comes back to the portal as a form POST with a one-time code

interface Step { status: number; res: Response; stage: "start" | "page" | "options" | "verify" | "finish"; stamp?: string; post?: { action: string; fields: Record<string, string> } }
interface PkOpts { portal?: string; next?: string; use?: SoftCredential; step?: number; asOrigin?: string; asRpId?: string; stopAt?: "verify" }

const candyPost = (b: Browser, path: string, json: unknown) => b.fetch(`${CANDY_ORIGIN}${path}`, { method: "POST", json, origin: CANDY_ORIGIN })

/** The login page's "Use a passkey", the candy host's page, and the form POST back. */
const passkeyLogin = async (b: Browser, auth: SoftAuthenticator, o: PkOpts = {}): Promise<Step> => {
  const portal = o.portal ?? "portal.localhost"
  const start = await b.fetch(`https://${portal}/auth/passkey/start?next=${encodeURIComponent(o.next ?? "/")}`)
  if (start.status !== 302) return { status: start.status, res: start, stage: "start" }
  return passkeyCeremony(b, auth, start.headers.get("location")!, { ...o, portal })
}

/** From the candy-host URL on: page, options, the authenticator, verify, the form POST to the portal. */
const passkeyCeremony = async (b: Browser, auth: SoftAuthenticator, href: string, o: PkOpts & { portal: string }): Promise<Step> => {
  const loc = new URL(href)
  expect(loc.origin).toBe(CANDY_ORIGIN)
  const stamp = loc.searchParams.get(STAMP_PARAM)!
  const page = await b.fetch(loc.href, { html: true })
  if (page.status !== 200) return { status: page.status, res: page, stage: "page", stamp }
  const opts = await candyPost(b, "/passkey/login/options", { stamp })
  if (opts.status !== 200) return { status: opts.status, res: opts, stage: "options", stamp }
  const { challengeId, publicKey } = await opts.json() as any
  const credential = await auth.get(publicKey, o.asOrigin ?? CANDY_ORIGIN, { use: o.use, step: o.step, asRpId: o.asRpId })
  const verify = await candyPost(b, "/passkey/login/verify", { stamp, challengeId, credential })
  if (verify.status !== 200 || o.stopAt === "verify") return { status: verify.status, res: verify, stage: "verify", stamp }
  const post = await verify.json() as { action: string; fields: Record<string, string> }
  const finish = await b.fetch(post.action, { method: "POST", form: post.fields, origin: CANDY_ORIGIN })
  if (finish.status === 200) {
    // What the finish page's script does: the secret into this origin's storage
    const m = (await finish.clone().text()).match(/var s=("[^"]*")/)
    if (m) b.secret.set(o.portal, JSON.parse(m[1]))
  }
  return { status: finish.status, res: finish, stage: "finish", stamp, post }
}

/** The passkeys page's "Add a passkey": enroll/start, then the popup on the candy host. */
const enroll = async (b: Browser, auth: SoftAuthenticator, o: { portal?: string; name?: string; origin?: string; rpId?: string } = {}): Promise<Step> => {
  const portal = o.portal ?? "portal.localhost"
  const page = await b.page(`https://${portal}/passkeys`)
  const start = await b.post(portal, "/passkeys/enroll/start", page.token, { name: o.name ?? "Laptop" })
  if (start.status !== 200) return { status: start.status, res: start, stage: "start" }
  const { url, origin } = await start.json() as any
  expect(origin).toBe(CANDY_ORIGIN)
  const stamp = new URL(url).searchParams.get(STAMP_PARAM)!
  const pg = await b.fetch(url, { html: true })
  if (pg.status !== 200) return { status: pg.status, res: pg, stage: "page", stamp }
  const opts = await candyPost(b, "/passkey/enroll/options", { stamp })
  if (opts.status !== 200) return { status: opts.status, res: opts, stage: "options", stamp }
  const { challengeId, publicKey } = await opts.json() as any
  const pk = o.rpId ? { ...publicKey, rp: { ...publicKey.rp, id: o.rpId } } : publicKey
  const credential = await auth.create(pk, o.origin ?? CANDY_ORIGIN)
  const verify = await candyPost(b, "/passkey/enroll/verify", { stamp, challengeId, credential })
  return { status: verify.status, res: verify, stage: "verify", stamp }
}

/** A browser logged in with the password that has enrolled one passkey (rpId: the candy host). */
const enrolled = async (user = "claude"): Promise<{ b: Browser; auth: SoftAuthenticator }> => {
  const b = new Browser()
  b.pamLogin(user)
  const auth = new SoftAuthenticator()
  const e = await enroll(b, auth)
  expect(e.status).toBe(200)
  return { b, auth }
}

describe("passkeys on the candy host", () => {
  it("enroll in a popup on the candy host after a password login, log in with it in a new browser, sign in to an app (amr passkey)", async () => {
    const auth = new SoftAuthenticator()
    const b = new Browser()
    b.pamLogin("claude")
    const page = await b.page("https://portal.localhost/passkeys")
    expect(page.vars).toMatchObject({ user: "claude", candyHost: CANDY })
    expect(page.vars.pamUntil).toBeGreaterThan(Date.now())
    const e = await enroll(b, auth, { name: "Laptop" })
    expect(e.status).toBe(200)
    expect(await e.res.json()).toEqual({ added: true, name: "Laptop" })
    const [rec] = passkeyDeps.store.list("claude")
    expect(rec).toMatchObject({ rpId: CANDY, name: "Laptop" })
    expect(audits.some(([a, x]) => a === "PASSKEY_ADD" && x.includes("claude") && x.includes(CANDY))).toBe(true)
    // The candy host got its own claim cookie, and nothing of the portal's
    expect(b.jar.get(CANDY)?.has(CEREMONY_COOKIE)).toBe(true)
    expect(b.jar.get(CANDY)?.has("candy_portal")).toBe(false)

    // A new browser logs in with the passkey alone
    const fresh = new Browser()
    const login = await passkeyLogin(fresh, auth, { next: "/passkeys" })
    expect(login.stage).toBe("finish")
    expect(login.status).toBe(200)
    expect(login.post!.action).toBe(`https://portal.localhost${PASSKEY_FINISH_PATH}`)
    expect(Object.keys(login.post!.fields)).toEqual([CODE_FIELD])
    const html = await login.res.text()
    // The secret reaches the portal origin's storage through the page, never a URL; then on to next
    expect(html).toContain("localStorage.setItem('candy_session'")
    expect(html).toContain(`n="/passkeys"`)
    expect(login.res.headers.get("cache-control")).toBe("no-store")
    expect(login.res.headers.get("content-security-policy")).toContain("script-src 'nonce-")
    const s = sessions.get(fresh.jar.get("portal.localhost")!.get("candy_portal"), fresh.secret.get("portal.localhost"))!
    expect(s).toMatchObject({ user: "claude", amr: "passkey", pamAt: null, authMethod: "passkey" })
    expect(audits.some(([a, x]) => a === "AUTH_LOGIN" && x.includes("(passkey Laptop)"))).toBe(true)
    // The binding cookie is used up
    expect(fresh.jar.get("portal.localhost")?.has(PASSKEY_BIND_COOKIE)).toBe(false)

    // ...and signs in to an app: the token says passkey
    const { request } = await startAppLogin(fresh)
    const d = await decide(fresh, request)
    expect(d.page.vars.amr).toBe("passkey")
    expect((await fresh.submitForm(d.body)).status).toBe(303)
    expect(logins.at(-1)).toMatchObject({ site: "notes", user: "claude", amr: ["passkey"], superuser: false })

    // The list, from the portal and from the CLI's API key, never with key material
    const listed = await fresh.fetch("https://portal.localhost/passkeys/list", { withSecret: true })
    expect((await listed.json() as any).passkeys).toMatchObject([{ name: "Laptop", rpId: CANDY, here: true }])
    const cli = await daemon(new Request("http://localhost:9999/passkeys/list", { headers: { host: "localhost:9999", "X-Candy-API-Key": "key-claude" } }))
    const body = await cli.json() as any
    expect(body.passkeys[0]).toMatchObject({ name: "Laptop", here: true })
    expect(JSON.stringify(body)).not.toContain("publicKey")
  })

  it("the same passkey works from every portal host: the rpId is always the candy host", async () => {
    const { auth } = await enrolled()
    const viaCandy = new Browser()
    const r = await passkeyLogin(viaCandy, auth, { portal: "portal.candy" })
    expect(r.status).toBe(200)
    expect(r.post!.action).toBe(`https://portal.candy${PASSKEY_FINISH_PATH}`)
    expect(viaCandy.jar.get("portal.candy")?.has("candy_portal")).toBe(true)
  })

  it("a passkey session can't add or delete passkeys until the password is entered again", async () => {
    const { auth } = await enrolled()
    const viaKey = new Browser()
    expect((await passkeyLogin(viaKey, auth)).status).toBe(200)
    expect((await viaKey.page("https://portal.localhost/passkeys")).vars.pamUntil).toBeNull()
    const refused = await enroll(viaKey, new SoftAuthenticator())
    expect(refused.stage).toBe("start")
    expect(refused.status).toBe(403)
    expect(await refused.res.json()).toEqual({ error: PASSKEY_NEEDS_PASSWORD, reauth: true })
    const id = passkeyDeps.store.list("claude")[0].id
    expect((await viaKey.post("portal.localhost", "/passkeys/delete", (await viaKey.page("https://portal.localhost/passkeys")).token, { id })).status).toBe(403)

    // Reauth: a wrong password is refused like a login; the body's user is ignored; the right one opens the window
    expect((await viaKey.post("portal.localhost", "/auth/reauth", (await viaKey.page("https://portal.localhost/passkeys")).token, { password: "nope", user: "ashwin" })).status).toBe(401)
    expect((await viaKey.post("portal.localhost", "/auth/reauth", (await viaKey.page("https://portal.localhost/passkeys")).token, { password: PASSWORDS.ashwin, user: "ashwin" })).status).toBe(401)
    const ok = await viaKey.post("portal.localhost", "/auth/reauth", (await viaKey.page("https://portal.localhost/passkeys")).token, { password: PASSWORDS.claude })
    expect(ok.status).toBe(200)
    expect((await ok.json() as any).pamUntil).toBeGreaterThan(Date.now())
    expect(audits.some(([a]) => a === "AUTH_REAUTH")).toBe(true)
    expect((await enroll(viaKey, new SoftAuthenticator(), { name: "Phone" })).status).toBe(200)

    // Delete: theirs only (another user's is a 404, not a 403)
    const mallory = new Browser()
    mallory.pamLogin("mallory")
    expect((await mallory.post("portal.localhost", "/passkeys/delete", (await mallory.page("https://portal.localhost/passkeys")).token, { id })).status).toBe(404)
    const gone = await viaKey.post("portal.localhost", "/passkeys/delete", (await viaKey.page("https://portal.localhost/passkeys")).token, { id })
    expect(await gone.json()).toEqual({ deleted: true })
    expect((await passkeyLogin(new Browser(), auth, { use: auth.creds[0] })).status).toBe(401)
  })

  it("refusals: a replayed counter, an account that may not log in, a locked-out address", async () => {
    const { auth } = await enrolled()
    expect((await passkeyLogin(new Browser(), auth)).status).toBe(200)
    // A cloned authenticator: the counter goes backwards
    const clone = await passkeyLogin(new Browser(), auth, { step: -1 })
    expect(clone).toMatchObject({ stage: "verify", status: 401 })
    expect(await clone.res.json()).toEqual({ error: PASSKEY_FAILED })
    expect(audits.some(([a]) => a === "PASSKEY_COUNTER")).toBe(true)
    // The account left the login list
    loginUsers = loginUsers.filter(u => u !== "claude")
    expect((await passkeyLogin(new Browser(), auth)).status).toBe(401)
    loginUsers = [...USERS]
    // An address locked out of password logins: no stamp at all, and the candy host refuses too
    const b = new Browser()
    const pending = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    lockedIps.set("127.0.0.1", 42)
    const locked = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    expect(locked.status).toBe(429)
    expect(locked.headers.get("retry-after")).toBe("42")
    const page = await b.fetch(pending.headers.get("location")!, { html: true })
    expect(page.status).toBe(200)
    const stamp = new URL(pending.headers.get("location")!).searchParams.get(STAMP_PARAM)
    const opts = await candyPost(b, "/passkey/login/options", { stamp })
    expect(opts.status).toBe(429)
    expect(await opts.json()).toMatchObject({ retryAfter: 42 })
    lockedIps.clear()
    // Passkey failures slow this address down (its own soft lockout): the start route says so
    for (let i = 0; i < 5; i++) await passkeyLogin(new Browser(), auth, { asOrigin: "https://evil.example" })
    expect((await new Browser().fetch("https://portal.localhost/auth/passkey/start?next=/")).status).toBe(429)
  })

  it("an assertion or a registration made for the portal host (the old model) is refused", async () => {
    const { auth } = await enrolled()
    // origin = the portal host
    const o = await passkeyLogin(new Browser(), auth, { asOrigin: "https://portal.localhost" })
    expect(o).toMatchObject({ stage: "verify", status: 401 })
    // rpId = the portal host (an authenticator holding a portal.localhost credential)
    const old = new SoftAuthenticator()
    const b = new Browser()
    b.pamLogin("claude")
    const r = await enroll(b, old, { rpId: "portal.localhost", origin: "https://portal.localhost" })
    expect(r).toMatchObject({ stage: "verify", status: 400 })
    expect(passkeyDeps.store.list("claude")).toHaveLength(1)
    const p = await passkeyLogin(new Browser(), old, { asRpId: "portal.localhost" })
    expect(p).toMatchObject({ stage: "verify", status: 401 })
  })

  it("passkey routes that need a portal login are 404 to an API key", async () => {
    for (const path of ["/passkeys/enroll/start", "/passkeys/rename", "/passkeys/delete", "/auth/reauth", "/app-auth/fresh"]) {
      const res = await daemon(new Request(`http://localhost:9999${path}`, {
        method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": "key-claude", "content-type": "application/json" }, body: "{}",
      }))
      expect(res.status).toBe(404)
    }
  })

  it("no bound domain: no passkeys (start, enroll, fresh and the candy host are 404s; the page says why)", async () => {
    const { b, auth } = await enrolled()
    candyOn = false
    expect((await new Browser().fetch("https://portal.localhost/auth/passkey/start?next=/")).status).toBe(404)
    const e = await enroll(b, new SoftAuthenticator())
    expect(e).toMatchObject({ stage: "start", status: 404 })
    expect(await e.res.json()).toEqual({ error: PASSKEYS_NEED_DOMAIN })
    expect((await b.page("https://portal.localhost/passkeys")).vars.candyHost).toBeNull()
    expect((await new Browser().fetch(`${CANDY_ORIGIN}/passkey/login?${STAMP_PARAM}=x`, { html: true })).status).toBe(404)
    // What /login and /auth/users say (daemon.ts): passkeys only with a candy host
    expect(daemonSrc).toContain("passkeys: candyHost() !== null")
    expect(daemonSrc).toContain("const passkeysOn = candyHost() !== null")
    candyOn = true
    expect((await passkeyLogin(new Browser(), auth)).status).toBe(200)
  })
})

describe("the candy host: a stamp or nothing", () => {
  const headersOfAPortalLogin = (b: Browser) => ({
    cookie: `candy_portal=${b.jar.get("portal.localhost")!.get("candy_portal")}`,
    [SESSION_HEADER]: b.secret.get("portal.localhost")!,
    "X-Candy-API-Key": "key-ashwin",
  })

  it("without a stamp everything is 404, and no challenge is ever issued", async () => {
    const b = new Browser()
    for (const [m, p] of CANDY_HOST_ROUTES) {
      const res = m === "GET"
        ? await b.fetch(`${CANDY_ORIGIN}${p}`, { html: true })
        : await candyPost(b, p, {})
      expect(res.status).toBe(404)
      expect(res.headers.get("set-cookie")).toBeNull()
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      expect(JSON.stringify(await res.text())).not.toContain("challenge")
    }
    // garbage, empty or two stamps
    for (const q of [`${STAMP_PARAM}=x`, `${STAMP_PARAM}=`, `${STAMP_PARAM}=a&${STAMP_PARAM}=b`]) {
      expect((await b.fetch(`${CANDY_ORIGIN}/passkey/login?${q}`, { html: true })).status).toBe(404)
    }
  })

  it("anything not in its route table is 404: the portal, the control API, sites, MCP; a portal cookie, API key or session header changes nothing", async () => {
    const owner = new Browser()
    owner.pamLogin("ashwin")
    const paths = ["/", "/login", "/auth/me", "/auth/users", "/auth/login", "/auth/passkey/start", "/auth/passkey/finish", "/configs", "/passkeys", "/passkeys/list",
      "/app-auth/authorize", "/app-auth/consent", "/sdk/auth/keys", "/mcp", "/.well-known/oauth-authorization-server", "/favicon.svg", "/passkey", "/passkey/login/", "/passkey/login/x", "/candy-auth/check"]
    for (const path of paths) {
      for (const method of ["GET", "POST", "DELETE", "OPTIONS"]) {
        const res = await daemon(new Request(`${CANDY_ORIGIN}${path}`, { method, headers: { host: CANDY, origin: CANDY_ORIGIN, accept: "text/html", ...headersOfAPortalLogin(owner) }, body: method === "POST" ? "{}" : undefined }))
        expect([path, method, res.status]).toEqual([path, method, 404])
      }
    }
    // A route in the table with the wrong method
    expect((await daemon(new Request(`${CANDY_ORIGIN}/passkey/login/options`, { headers: { host: CANDY } }))).status).toBe(404)
    // A POST that isn't from the page itself
    const { b } = await enrolled()
    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const loc = new URL(start.headers.get("location")!)
    await b.fetch(loc.href, { html: true })
    const stamp = loc.searchParams.get(STAMP_PARAM)
    for (const origin of ["https://portal.localhost", "https://evil.example", "null"]) {
      expect((await b.fetch(`${CANDY_ORIGIN}/passkey/login/options`, { method: "POST", json: { stamp }, origin })).status).toBe(404)
    }
    expect((await candyPost(b, "/passkey/login/options", { stamp })).status).toBe(200)
  })

  it("the ceremony page: strict headers, a nonce'd CSP whose only form target is the stamp's portal, no external resources", async () => {
    const b = new Browser()
    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/x")
    expect(start.headers.get("referrer-policy")).toBe("no-referrer")
    expect(start.headers.get("set-cookie")).toContain(`${PASSKEY_BIND_COOKIE}=`)
    expect(start.headers.get("set-cookie")).toContain("SameSite=None")
    const page = await b.fetch(start.headers.get("location")!, { html: true })
    expect(page.status).toBe(200)
    const csp = page.headers.get("content-security-policy")!
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/)
    expect(csp).toContain("form-action https://portal.localhost;")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(page.headers.get("referrer-policy")).toBe("strict-origin")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("set-cookie")).toContain(`${CEREMONY_COOKIE}=`)
    const html = await page.text()
    expect(html).not.toMatch(/https?:\/\/(fonts|cdn)/)
    expect(html).not.toMatch(/<(link|script)[^>]+(src|href)="(https?:)?\/\//)
    expect(html).not.toContain("<script>")   // every script carries the nonce
    expect(html).toContain("history.replaceState(null, '', location.pathname)")
    const vars = JSON.parse(html.match(/window\.CANDY_PASSKEY=(.*?);<\/script>/)![1])
    expect(vars).toEqual({ purpose: "login", state: "ready", fresh: false, candy: CANDY_ORIGIN, portal: "https://portal.localhost", next: "/x", user: null, name: null })
    // the stamp is never in the page body
    expect(html).not.toContain(new URL(start.headers.get("location")!).searchParams.get(STAMP_PARAM)!)
  })

  it("a stamp is single use: after verify, it opens nothing", async () => {
    const { auth } = await enrolled()
    const b = new Browser()
    const r = await passkeyLogin(b, auth, { stopAt: "verify" })
    expect(r.status).toBe(200)
    expect((await candyPost(b, "/passkey/login/options", { stamp: r.stamp })).status).toBe(404)
    const again = await candyPost(b, "/passkey/login/verify", { stamp: r.stamp, challengeId: "x", credential: {} })
    expect(again.status).toBe(404)
    expect(await again.json()).toEqual({ error: STAMP_EXPIRED, expired: true })
    const page = await b.fetch(`${CANDY_ORIGIN}/passkey/login?${STAMP_PARAM}=${r.stamp}`, { html: true })
    expect(page.status).toBe(404)
    expect(await page.text()).toContain('"state":"expired"')
  })

  it("a cancelled prompt can try again with the same stamp (options are not single use)", async () => {
    const { auth } = await enrolled()
    const b = new Browser()
    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const loc = new URL(start.headers.get("location")!)
    await b.fetch(loc.href, { html: true })
    const stamp = loc.searchParams.get(STAMP_PARAM)!
    expect((await candyPost(b, "/passkey/login/options", { stamp })).status).toBe(200)   // cancelled
    const o = await candyPost(b, "/passkey/login/options", { stamp })
    const { challengeId, publicKey } = await o.json() as any
    const v = await candyPost(b, "/passkey/login/verify", { stamp, challengeId, credential: await auth.get(publicKey, CANDY_ORIGIN) })
    expect(v.status).toBe(200)
  })

  it("an expired stamp: the page says so (with the way back), options and verify are 404", async () => {
    const b = new Browser()
    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/x")
    const href = start.headers.get("location")!
    expect((await b.fetch(href, { html: true })).status).toBe(200)
    clock.now += 5 * 60_000
    const page = await b.fetch(href, { html: true })
    expect(page.status).toBe(404)
    expect(await page.text()).toContain('"state":"expired"')
    expect((await candyPost(b, "/passkey/login/options", { stamp: new URL(href).searchParams.get(STAMP_PARAM) })).status).toBe(404)
  })

  it("an enroll stamp doesn't open the login ceremony, and a login stamp doesn't enroll", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    const page = await b.page("https://portal.localhost/passkeys")
    const { url } = await (await b.post("portal.localhost", "/passkeys/enroll/start", page.token, {})).json() as any
    const enrollStamp = new URL(url).searchParams.get(STAMP_PARAM)!
    expect((await b.fetch(`${CANDY_ORIGIN}/passkey/login?${STAMP_PARAM}=${enrollStamp}`, { html: true })).status).toBe(404)
    expect((await b.fetch(url, { html: true })).status).toBe(200)
    expect((await candyPost(b, "/passkey/login/options", { stamp: enrollStamp })).status).toBe(404)
    expect((await candyPost(b, "/passkey/login/verify", { stamp: enrollStamp })).status).toBe(404)
    // ...and the wrong-purpose tries didn't burn it (checked before anything is used up)
    expect((await candyPost(b, "/passkey/enroll/options", { stamp: enrollStamp })).status).toBe(200)

    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const loginStamp = new URL(start.headers.get("location")!).searchParams.get(STAMP_PARAM)!
    expect((await b.fetch(`${CANDY_ORIGIN}/passkey/enroll?${STAMP_PARAM}=${loginStamp}`, { html: true })).status).toBe(404)
    expect((await candyPost(b, "/passkey/enroll/options", { stamp: loginStamp })).status).toBe(404)
  })

  it("a stamp belongs to the browser that opened it first; a copied one is useless elsewhere", async () => {
    const { auth } = await enrolled()
    const victim = new Browser()
    const start = await victim.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const href = start.headers.get("location")!
    expect((await victim.fetch(href, { html: true })).status).toBe(200)
    const thief = new Browser()
    const page = await thief.fetch(href, { html: true })
    expect(page.status).toBe(404)
    expect(await page.text()).toContain('"state":"elsewhere"')
    const stamp = new URL(href).searchParams.get(STAMP_PARAM)
    expect((await candyPost(thief, "/passkey/login/options", { stamp })).status).toBe(404)
    expect((await candyPost(thief, "/passkey/login/verify", { stamp })).status).toBe(404)
    // ...and the thief's tries didn't burn it
    const done = await passkeyCeremony(victim, auth, href, { portal: "portal.localhost" })
    expect(done.status).toBe(200)
  })

  it("a stamp goes back only to a portal host: one naming anything else opens nothing", async () => {
    const forged = tickets.mintStamp({ purpose: "login", host: CANDY, portal: "evil.example.com", next: "/", bind: "x", user: null, sessionId: null, pamAt: null, name: null }, "ip:203.0.113.1")
    expect((await new Browser().fetch(`${CANDY_ORIGIN}/passkey/login?${STAMP_PARAM}=${forged}`, { html: true })).status).toBe(404)
    // minted for another candy host (the zone changed): nothing
    const other = tickets.mintStamp({ purpose: "login", host: "candy.old.example", portal: "portal.localhost", next: "/", bind: "x", user: null, sessionId: null, pamAt: null, name: null }, "ip:203.0.113.1")
    expect((await new Browser().fetch(`${CANDY_ORIGIN}/passkey/login?${STAMP_PARAM}=${other}`, { html: true })).status).toBe(404)
  })

  it("the login code: single use, 60 seconds, its own portal host, the browser that started, and only from the candy host", async () => {
    const { auth } = await enrolled()
    const code = async (b: Browser) => {
      const r = await passkeyLogin(b, auth, { stopAt: "verify" })
      expect(r.status).toBe(200)
      return await r.res.json() as { action: string; fields: Record<string, string> }
    }
    const finish = (b: Browser, post: { action: string; fields: Record<string, string> }, origin = CANDY_ORIGIN, action = post.action) =>
      b.fetch(action, { method: "POST", form: post.fields, origin })
    const sessionsOf = () => sessions.list().filter(s => s.user === "claude").length
    const before = sessionsOf()

    // Reuse
    const b1 = new Browser()
    const p1 = await code(b1)
    expect((await finish(b1, p1)).status).toBe(200)
    const reuse = await finish(b1, p1)
    expect(reuse.status).toBe(400)
    expect(sessionsOf()).toBe(before + 1)

    // Expiry
    const b2 = new Browser()
    const p2 = await code(b2)
    clock.now += 61_000
    expect((await finish(b2, p2)).status).toBe(400)

    // Another portal host than the one it was minted for
    const b3 = new Browser()
    const p3 = await code(b3)
    b3.jar.set("portal.candy", new Map(b3.jar.get("portal.localhost")))
    expect((await finish(b3, p3, CANDY_ORIGIN, `https://portal.candy${PASSKEY_FINISH_PATH}`)).status).toBe(400)

    // Another browser (no binding cookie: a stolen code)
    const b4 = new Browser()
    const p4 = await code(b4)
    expect((await finish(new Browser(), p4)).status).toBe(400)

    // Not from the candy host's page
    const b5 = new Browser()
    const p5 = await code(b5)
    for (const origin of ["https://portal.localhost", "https://evil.example", "null"]) {
      expect((await finish(b5, p5, origin)).status).toBe(403)
    }
    expect(sessionsOf()).toBe(before + 1)
    expect(audits.filter(([a, x]) => a === "AUTH_FAIL" && x.includes("login code")).length).toBeGreaterThanOrEqual(4)
    // Nothing in the audit log holds a stamp or a code
    const logged = JSON.stringify(audits)
    for (const p of [p1, p2, p3, p4, p5]) expect(logged).not.toContain(p.fields[CODE_FIELD])
  })

  it("enroll needs the portal login it came from, still live, still allowed, with a recent password", async () => {
    // The portal session ended between the stamp and the ceremony
    const b = new Browser()
    b.pamLogin("claude")
    const page = await b.page("https://portal.localhost/passkeys")
    const { url } = await (await b.post("portal.localhost", "/passkeys/enroll/start", page.token, {})).json() as any
    expect((await b.fetch(url, { html: true })).status).toBe(200)
    const stamp = new URL(url).searchParams.get(STAMP_PARAM)
    const sid = sessions.get(b.jar.get("portal.localhost")!.get("candy_portal"), b.secret.get("portal.localhost"))!.id
    sessions.destroy(sid)
    const o = await candyPost(b, "/passkey/enroll/options", { stamp })
    expect(o.status).toBe(403)
    expect(await o.json()).toEqual({ error: ENROLL_SESSION_GONE })

    // The password is no longer recent (8 minutes when the stamp was made, 11 when used)
    const c = new Browser()
    c.pamLogin("claude")
    clock.now += 8 * 60_000
    const cp = await c.page("https://portal.localhost/passkeys")
    const s2 = await (await c.post("portal.localhost", "/passkeys/enroll/start", cp.token, {})).json() as any
    expect((await c.fetch(s2.url, { html: true })).status).toBe(200)
    clock.now += 3 * 60_000
    const o2 = await candyPost(c, "/passkey/enroll/options", { stamp: new URL(s2.url).searchParams.get(STAMP_PARAM) })
    expect(o2.status).toBe(403)
    expect(await o2.json()).toMatchObject({ reauth: true })

    // The account left the login list after the stamp was made
    const d = new Browser()
    d.pamLogin("claude")
    const dp = await d.page("https://portal.localhost/passkeys")
    const s3 = await (await d.post("portal.localhost", "/passkeys/enroll/start", dp.token, {})).json() as any
    expect((await d.fetch(s3.url, { html: true })).status).toBe(200)
    const s3stamp = new URL(s3.url).searchParams.get(STAMP_PARAM)
    const o3 = await candyPost(d, "/passkey/enroll/options", { stamp: s3stamp })
    const { challengeId, publicKey } = await o3.json() as any
    loginUsers = loginUsers.filter(u => u !== "claude")
    const v3 = await candyPost(d, "/passkey/enroll/verify", { stamp: s3stamp, challengeId, credential: await new SoftAuthenticator().create(publicKey, CANDY_ORIGIN) })
    expect(v3.status).toBe(403)
    expect(passkeyDeps.store.list("claude")).toEqual([])
  })

  it("a finished enrollment voids every other enroll stamp of that login (its session's enroll sequence)", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    const stampUrl = async () => {
      const page = await b.page("https://portal.localhost/passkeys")
      return (await (await b.post("portal.localhost", "/passkeys/enroll/start", page.token, {})).json() as any).url as string
    }
    const first = await stampUrl(), second = await stampUrl()
    expect((await b.fetch(second, { html: true })).status).toBe(200)
    expect((await enroll(b, new SoftAuthenticator())).status).toBe(200)   // a third stamp, finished
    void first
    const o = await candyPost(b, "/passkey/enroll/options", { stamp: new URL(second).searchParams.get(STAMP_PARAM) })
    expect(o.status).toBe(403)
    expect(await o.json()).toEqual({ error: ENROLL_SESSION_GONE })
    // A new one works
    expect((await enroll(b, new SoftAuthenticator(), { name: "Phone" })).status).toBe(200)
  })

  it("a locked-out address can't spend stamps: the lockout comes before the stamp is used up", async () => {
    const { auth } = await enrolled()
    const b = new Browser()
    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const href = start.headers.get("location")!
    await b.fetch(href, { html: true })
    const stamp = new URL(href).searchParams.get(STAMP_PARAM)
    const { challengeId, publicKey } = await (await candyPost(b, "/passkey/login/options", { stamp })).json() as any
    const credential = await auth.get(publicKey, CANDY_ORIGIN)
    lockedIps.set("127.0.0.1", 30)
    expect((await candyPost(b, "/passkey/login/verify", { stamp, challengeId, credential })).status).toBe(429)
    lockedIps.clear()
    // Not burned: the same stamp still works
    expect((await candyPost(b, "/passkey/login/verify", { stamp, challengeId, credential })).status).toBe(200)
  })

  it("one address gets only a share of stamps: past it, the start route says 429 with Retry-After", async () => {
    const b = new Browser()
    let last: Response | null = null
    for (let i = 0; i < 80; i++) {
      last = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
      if (last.status !== 302) break
    }
    expect(last!.status).toBe(429)
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0)
    // Another address is unaffected
    const other = new Browser()
    other.ip = "100.64.0.9"
    expect((await other.fetch("https://portal.localhost/auth/passkey/start?next=/")).status).toBe(302)
  })

  it("an enroll stamp adds the passkey to its own user only, and a challenge from one ceremony can't finish another", async () => {
    const a = new Browser(), m = new Browser()
    a.pamLogin("claude")
    m.pamLogin("mallory")
    const stampOf = async (b: Browser) => {
      const page = await b.page("https://portal.localhost/passkeys")
      const { url } = await (await b.post("portal.localhost", "/passkeys/enroll/start", page.token, {})).json() as any
      expect((await b.fetch(url, { html: true })).status).toBe(200)
      return new URL(url).searchParams.get(STAMP_PARAM)!
    }
    const sa = await stampOf(a), sm = await stampOf(m)
    const oa = await (await candyPost(a, "/passkey/enroll/options", { stamp: sa })).json() as any
    expect(oa.publicKey.user.name).toBe("claude")
    expect(oa.publicKey.rp.id).toBe(CANDY)
    // claude's challenge answered under mallory's stamp
    const credential = await new SoftAuthenticator().create(oa.publicKey, CANDY_ORIGIN)
    const v = await candyPost(m, "/passkey/enroll/verify", { stamp: sm, challengeId: oa.challengeId, credential })
    expect(v.status).toBe(400)
    expect(passkeyDeps.store.list("mallory")).toEqual([])
    expect(passkeyDeps.store.list("claude")).toEqual([])
  })
})

describe("nothing logs the token", () => {
  it("the function request log redacts candy_token in the callback's form body and in a URL", () => {
    const body = redactBody("candy_token=eyJhbGciOi.x.y.z&state=abc", "application/x-www-form-urlencoded")
    expect(body).not.toContain("eyJhbGciOi")
    expect(body).toContain("state=abc")
  })

  it("Caddy's access log drops candy_token, and the passkey stamp and login code parameters", () => {
    for (const q of ["candy_token", STAMP_PARAM, CODE_FIELD]) expect(LOG_REDACTED_QUERY_PARAMS as readonly string[]).toContain(q)
    const block = caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/var/log/caddy/access.log" })
    expect(block).toContain("request>uri query {")
    expect(block).toContain("delete candy_token")
    expect(block).toContain(`delete ${STAMP_PARAM}`)
    expect(block).toContain(`delete ${CODE_FIELD}`)
  })

  it("the stamp is the only secret in a URL (once); the login code only ever goes in a POST body", async () => {
    const { auth } = await enrolled()
    const r = await passkeyLogin(new Browser(), auth, { stopAt: "verify" })
    const post = await r.res.json() as any
    expect(new URL(post.action).search).toBe("")
    const html = await Bun.file(join(root, "public", "passkey-host.html")).text()
    expect(html).toContain("form.method = 'POST'")
  })

  it("oversized bodies are refused before parsing", async () => {
    const { b } = await enrolled()
    const start = await b.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const href = start.headers.get("location")!
    await b.fetch(href, { html: true })
    const stamp = new URL(href).searchParams.get(STAMP_PARAM)
    const big = await candyPost(b, "/passkey/login/options", { stamp, pad: "x".repeat(MAX_AUTH_BODY_BYTES) })
    expect(big.status).toBe(404)
    const fin = await b.fetch(`https://portal.localhost${PASSKEY_FINISH_PATH}`, { method: "POST", form: { [CODE_FIELD]: "x".repeat(9000) }, origin: CANDY_ORIGIN })
    expect(fin.status).toBe(400)
  })
})

describe("functions: env.CANDY_AUTH", () => {
  it("reads the ring from the unit's credential first, then CANDY_AUTH_KEYS", () => {
    const files: Record<string, string> = { "/creds/candy-auth-keys": "fromfile" }
    const read = (p: string) => files[p] ?? null
    expect(authFromEnv({}, read)).toBeNull()
    expect(authFromEnv({ CANDY_AUTH_SITE: "notes", CREDENTIALS_DIRECTORY: "/creds", CANDY_AUTH_KEYS: "fromenv" }, read)).toEqual({ site: "notes", keys: "fromfile" })
    expect(authFromEnv({ CANDY_AUTH_SITE: "notes", CANDY_AUTH_KEYS: "fromenv", CANDY_AUTH_URL: "https://portal.candy", CANDY_AUTH_ISSUERS: "https://portal.localhost,https://portal.candy" }, read))
      .toEqual({ site: "notes", keys: "fromenv", portal: "https://portal.candy", issuers: ["https://portal.localhost", "https://portal.candy"] })
  })

  it("refuses a var, secret or binding named CANDY_AUTH", () => {
    const cfg = (o: Partial<HostConfig>): HostConfig => ({ main: "index.ts", vars: {}, kv: [], d1: [], crons: [], warnings: [], source: null, assets: null, ...o })
    expect(() => checkReservedBindings(cfg({}), [])).not.toThrow()
    expect(() => checkReservedBindings(cfg({ vars: { CANDY_AUTH: "x" } }), [])).toThrow("CANDY_AUTH is reserved for candy auth")
    expect(() => checkReservedBindings(cfg({}), ["CANDY_AUTH"])).toThrow()
    expect(() => checkReservedBindings(cfg({ kv: ["CANDY_AUTH"] }), [])).toThrow()
    expect(() => checkReservedBindings(cfg({ d1: ["CANDY_AUTH"] }), [])).toThrow()
  })

  it("a Workers-style handler signs users in with env.CANDY_AUTH", async () => {
    // What fn-host builds: createAppAuth from what the daemon handed the instance
    const ring = await (await daemon(new Request("http://localhost:9999/sdk/auth/keys", {
      method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": "key-claude", "content-type": "application/json" }, body: JSON.stringify({ name: "notes" }),
    }))).json() as any
    const spec = authFromEnv({ CANDY_AUTH_SITE: "notes", CANDY_AUTH_KEYS: ring.keys, CANDY_AUTH_ISSUERS: ring.issuers.join(",") }, () => null)!
    const env = { CANDY_AUTH: createAppAuth({ site: spec.site, issuers: spec.issuers, keys: spec.keys!, env: {} }) }
    const worker = {
      async fetch(request: Request, e: typeof env) {
        const r = await e.CANDY_AUTH.handle(request, u => { logins.push({ site: "fn", user: u.user, amr: u.amr }); return redirectAfterLogin(u.next) })
        return r ?? new Response("hello")
      },
    }
    // The function is notes' app now: every request for its host goes to the worker
    apps.set("notes", { site: "notes", handle: (req: Request) => worker.fetch(req, env) } as unknown as AppAuth)
    const b = new Browser()
    b.pamLogin("ashwin")
    const { request } = await startAppLogin(b, "notes.localhost", "/w")
    const { body } = await decide(b, request)
    const back = await b.submitForm(body)
    expect(back.status).toBe(303)
    expect(back.headers.get("location")).toBe("/w")
    expect(logins.at(-1)).toEqual({ site: "fn", user: "ashwin", amr: ["pam"] })
  })
})

describe("sdk.ts appAuth()", () => {
  it("inside a function it is env.CANDY_AUTH (fn-host's object); elsewhere it needs a site", async () => {
    const { appAuth } = await import("../sdk.ts")
    const key = Symbol.for("candy.appAuth")
    const g = globalThis as Record<symbol, unknown>
    const fromHost = createAppAuth({ site: "notes", env: {} })
    g[key] = fromHost
    try {
      expect(appAuth()).toBe(fromHost)
    } finally {
      delete g[key]
    }
    const saved = process.env.CANDY_AUTH_SITE
    delete process.env.CANDY_AUTH_SITE
    try {
      expect(() => appAuth()).toThrow("pass appAuth({ site:")
      const own = appAuth({ site: "notes", env: {} })
      expect(own.site).toBe("notes")
    } finally {
      if (saved !== undefined) process.env.CANDY_AUTH_SITE = saved
    }
  })
})

// ===========================================================================
// Review findings, end to end through the routes

describe("review findings (routes)", () => {
  const authOf = (b: Browser, portal = "portal.localhost") =>
    requestAuthOf(new Request(`https://${portal}/auth/me`, { headers: { host: portal, cookie: `candy_portal=${b.jar.get(portal)!.get("candy_portal")}`, [SESSION_HEADER]: b.secret.get(portal)! } }), true)

  it("a passkey session of a sudoer is a superuser straight away; a non-sudoer's still isn't", async () => {
    const { auth } = await enrolled("ashwin")
    const pk = new Browser()
    expect((await passkeyLogin(pk, auth)).status).toBe(200)
    expect(authOf(pk)).toMatchObject({ user: "ashwin", superuser: true, amr: "passkey", pamAt: null })
    // A superuser route (ROUTE_TABLE) with no password re-entered: past the guard (the harness has no handler: 404)
    const system = (br: Browser) => br.fetch("https://portal.localhost/system/stats", { withSecret: true })
    expect((await system(pk)).status).toBe(404)
    clock.now += 61 * 60_000                                // no hour-long window either
    expect((await system(pk)).status).toBe(404)
    // A non-sudoer's passkey session is refused
    const { auth: auth2 } = await enrolled("claude")
    const pk2 = new Browser()
    expect((await passkeyLogin(pk2, auth2)).status).toBe(200)
    expect(authOf(pk2)).toMatchObject({ user: "claude", superuser: false })
    const refused = await system(pk2)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: "Only a superuser can do that." })
  })

  it("a passkey of an earlier account with the same name, or of an account PAM refuses, logs in no one", async () => {
    const { auth } = await enrolled()
    accountDenied.add("claude")                             // passwd -e claude
    expect((await passkeyLogin(new Browser(), auth)).status).toBe(401)
    accountDenied.clear()
    uids.set("claude", 4242)                                // userdel + useradd claude
    expect((await passkeyLogin(new Browser(), auth)).status).toBe(401)
    uids.set("claude", 1001)
    expect((await passkeyLogin(new Browser(), auth)).status).toBe(200)
  })

  it("passkey login stamps and options from the same (loopback) address don't push out a pending login", async () => {
    const { auth } = await enrolled()
    const victim = new Browser()
    const start = await victim.fetch("https://portal.localhost/auth/passkey/start?next=/")
    const href = start.headers.get("location")!
    await victim.fetch(href, { html: true })
    const stamp = new URL(href).searchParams.get(STAMP_PARAM)
    const { challengeId, publicKey } = await (await candyPost(victim, "/passkey/login/options", { stamp })).json() as any
    const attacker = new Browser()
    for (let i = 0; i < 50; i++) {
      const s = await attacker.fetch("https://portal.localhost/auth/passkey/start?next=/")
      expect(s.status).toBe(302)
      await attacker.fetch(s.headers.get("location")!, { html: true })
      expect((await candyPost(attacker, "/passkey/login/options", { stamp: new URL(s.headers.get("location")!).searchParams.get(STAMP_PARAM) })).status).toBe(200)
    }
    const res = await candyPost(victim, "/passkey/login/verify", { stamp, challengeId, credential: await auth.get(publicKey, CANDY_ORIGIN) })
    expect(res.status).toBe(200)
  })

  it("authorize floods from the same address don't push out a parked sign-in", async () => {
    const b = new Browser()
    b.pamLogin("ashwin")
    const victim = await startAppLogin(b)
    const flood = new Browser()
    const az = `https://portal.localhost/app-auth/authorize?return_to=${encodeURIComponent(`https://notes.localhost${CALLBACK_PATH}`)}&state=${"a".repeat(20)}`
    for (let i = 0; i < 200; i++) expect((await flood.fetch(az)).status).toBe(302)
    const d = await decide(b, victim.request)
    expect(d.res.status).toBe(200)
    expect((await b.submitForm(d.body)).status).toBe(303)
  })

  it("rotate and revoke take a name in any case, like every other command", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    expect((await b.submitForm((await decide(b, (await startAppLogin(b)).request)).body)).status).toBe(303)
    const rot = await daemon(new Request("http://localhost:9999/app-auth/rotate", {
      method: "POST", headers: { host: "localhost:9999", "X-Candy-API-Key": "key-claude", "content-type": "application/json" }, body: JSON.stringify({ name: "Notes" }),
    }))
    expect(rot.status).toBe(200)
    expect((await rot.json() as any).site).toBe("notes")
    expect(consents.has("claude", "notes", "claude")).toBe(true)
    const rv = await b.post("portal.localhost", "/app-auth/consents/revoke", (await b.page("https://portal.localhost/passkeys")).token, { site: "NOTES" })
    expect(await rv.json()).toEqual({ revoked: true })
    expect(consents.has("claude", "notes", "claude")).toBe(false)
  })

  it("readJsonBody stops reading a chunked body past the cap instead of buffering it", async () => {
    let pulled = 0
    const chunk = new Uint8Array(16 * 1024).fill(0x20)
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled += chunk.byteLength; if (pulled > 64 * 1024 * 1024) c.close(); else c.enqueue(chunk) },
    })
    const req = new Request("https://portal.localhost/auth/passkey", { method: "POST", body, duplex: "half" } as RequestInit)
    expect(req.headers.get("content-length")).toBeNull()
    expect(await readJsonBody(req)).toEqual({})
    expect(pulled).toBeLessThanOrEqual(MAX_AUTH_BODY_BYTES + 4 * chunk.byteLength)
    // Within the cap, streamed: read normally; a declared length over it: not read at all
    const small = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"a":')); c.enqueue(new TextEncoder().encode("1}")); c.close() } })
    expect(await readJsonBody(new Request("https://x/", { method: "POST", body: small, duplex: "half" } as RequestInit))).toEqual({ a: 1 })
    expect(await readJsonBody(new Request("https://x/", { method: "POST", body: "{}", headers: { "content-length": String(MAX_AUTH_BODY_BYTES + 1) } }))).toEqual({})
  })
})

// ===========================================================================
// max_age (freshness) and the superuser claim

describe("max_age: the app asks for a recent authentication", () => {
  const MIN = 60_000
  const claimsOfLast = () => logins.at(-1)!

  it("is honoured with a live session and remembered consent: a fresh passkey first, bound to this request", async () => {
    const { b, auth } = await enrolled()                     // claude, password login now, has a passkey
    // First sign-in: approve and remember
    expect((await b.submitForm((await decide(b, (await startAppLogin(b)).request)).body)).status).toBe(303)
    clock.now += 10 * MIN
    const { request } = await startAppLogin(b, "notes.localhost", "/pay", 300)
    const page = await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    expect(page.vars).toMatchObject({ remembered: true, fresh: { needed: true, passkeys: true, maxAge: 300 } })
    // Nothing is minted until the user authenticates again (the request stays parked)
    const early = await b.post("portal.localhost", "/app-auth/decision", page.token, { request, approve: true, remember: true })
    expect(early.status).toBe(401)
    expect(await early.json()).toMatchObject({ fresh: true })
    // The consent page's passkey hop: a stamp for this session and request
    const fp = await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    const f = await b.post("portal.localhost", "/app-auth/fresh", fp.token, { request })
    expect(f.status).toBe(200)
    const { url } = await f.json() as any
    const done = await passkeyCeremony(b, auth, url, { portal: "portal.localhost" })
    expect(done.status).toBe(200)
    // No new session: the same login, re-authenticated
    const html = await done.res.text()
    expect(html).not.toContain("localStorage")
    expect(html).toContain(`/app-auth/consent?request=${request}`)
    expect(done.res.headers.get("set-cookie")).toBeNull()
    const s = sessions.get(b.jar.get("portal.localhost")!.get("candy_portal"), b.secret.get("portal.localhost"))!
    expect(s).toMatchObject({ user: "claude", amr: "pam", authMethod: "passkey", authAt: clock.now })
    // Now the remembered consent goes through, and the token describes the fresh authentication
    const d = await decide(b, request)
    expect(d.page.vars.fresh.needed).toBe(false)
    expect(d.res.status).toBe(200)
    expect((await b.submitForm(d.body)).status).toBe(303)
    expect(claimsOfLast()).toMatchObject({ user: "claude", amr: ["passkey"], authTime: Math.floor(clock.now / 1000) * 1000 })
    // ...and it was used up: another request with max_age=0 asks again
    expect(sessions.byId(s.id)!.freshFor).toBeNull()
  })

  it("the password works too: /auth/reauth bound to the request; amr pam", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    clock.now += 30 * MIN
    const { request } = await startAppLogin(b, "notes.localhost", "/x", 60)
    const page = await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    expect(page.vars.fresh).toMatchObject({ needed: true })
    // a reauth for a request that isn't parked here is refused before the password is checked
    expect((await b.post("portal.localhost", "/auth/reauth", page.token, { password: PASSWORDS.claude, request: "nope" })).status).toBe(404)
    const p2 = await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    expect((await b.post("portal.localhost", "/auth/reauth", p2.token, { password: PASSWORDS.claude, request })).status).toBe(200)
    const d = await decide(b, request, true, false)
    expect(d.res.status).toBe(200)
    expect((await b.submitForm(d.body)).status).toBe(303)
    expect(claimsOfLast()).toMatchObject({ amr: ["pam"], authTime: Math.floor(clock.now / 1000) * 1000 })
  })

  it("max_age within the session's last authentication needs nothing more", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    clock.now += 2 * MIN
    const { request } = await startAppLogin(b, "notes.localhost", "/x", 300)
    const d = await decide(b, request)
    expect(d.page.vars.fresh.needed).toBe(false)
    expect((await b.submitForm(d.body)).status).toBe(303)
  })

  it("max_age=0 always asks again, and a fresh authentication for request A doesn't satisfy request B", async () => {
    const { b, auth } = await enrolled()
    // Even right after logging in
    const a = await startAppLogin(b, "notes.localhost", "/a", 0)
    const bReq = await startAppLogin(b, "other.localhost", "/b", 0)
    expect((await b.page(`https://portal.localhost/app-auth/consent?request=${a.request}`)).vars.fresh.needed).toBe(true)
    const fp = await b.page(`https://portal.localhost/app-auth/consent?request=${a.request}`)
    const { url } = await (await b.post("portal.localhost", "/app-auth/fresh", fp.token, { request: a.request })).json() as any
    expect((await passkeyCeremony(b, auth, url, { portal: "portal.localhost" })).status).toBe(200)
    // B: still needed, and its decision is refused
    const pb = await b.page(`https://portal.localhost/app-auth/consent?request=${bReq.request}`)
    expect(pb.vars.fresh.needed).toBe(true)
    expect((await b.post("portal.localhost", "/app-auth/decision", pb.token, { request: bReq.request, approve: true })).status).toBe(401)
    // A: fine, once
    const da = await decide(b, a.request)
    expect(da.res.status).toBe(200)
    expect((await b.submitForm(da.body)).status).toBe(303)
    // A third request with max_age=0 asks again
    const c = await startAppLogin(b, "notes.localhost", "/c", 0)
    expect((await b.page(`https://portal.localhost/app-auth/consent?request=${c.request}`)).vars.fresh.needed).toBe(true)
  })

  it("one user's passkey can't re-authenticate another user's login", async () => {
    const { b } = await enrolled("claude")
    const { auth: ashwinKey } = await enrolled("ashwin")
    const { request } = await startAppLogin(b, "notes.localhost", "/x", 0)
    const fp = await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    const { url } = await (await b.post("portal.localhost", "/app-auth/fresh", fp.token, { request })).json() as any
    const r = await passkeyCeremony(b, ashwinKey, url, { portal: "portal.localhost" })
    expect(r.status).toBe(400)
    const s = sessions.get(b.jar.get("portal.localhost")!.get("candy_portal"), b.secret.get("portal.localhost"))!
    expect(s.freshFor).toBeNull()
    expect(s.authMethod).toBe("pam")
    expect((await b.page(`https://portal.localhost/app-auth/consent?request=${request}`)).vars.fresh.needed).toBe(true)
  })

  it("a browser that strips max_age gets a token the SDK refuses (stale_auth): the app keeps max_age in its own cookie", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    clock.now += 30 * MIN
    const start = await b.fetch(`https://notes.localhost${LOGIN_PATH}?next=/pay&want_max_age=60`)
    const authorize = new URL(start.headers.get("location")!)
    expect(authorize.searchParams.get("max_age")).toBe("60")
    authorize.searchParams.delete("max_age")
    const az = await b.fetch(authorize.href)
    const request = new URL(az.headers.get("location")!, "https://x").searchParams.get("request")!
    const d = await decide(b, request)
    expect(d.page.vars.fresh.needed).toBe(false)              // the portal never heard of it
    const back = await b.submitForm(d.body)
    expect(back.status).toBe(401)
    expect(await back.text()).toContain("recent sign-in")
    expect(logins).toEqual([])
  })

  it("an out-of-range max_age is refused at authorize (an error page, never a redirect)", async () => {
    const b = new Browser()
    for (const v of ["86401", "-1", "1.5", "x", ""]) {
      const az = `https://portal.localhost/app-auth/authorize?return_to=${encodeURIComponent(`https://notes.localhost${CALLBACK_PATH}`)}&state=${"a".repeat(20)}&max_age=${encodeURIComponent(v)}`
      const res = await b.fetch(az)
      expect(res.status).toBe(400)
      expect(res.headers.get("location")).toBeNull()
    }
  })

  it("the fresh passkey route: only for a request parked on this portal host, with the address lockout", async () => {
    const b = new Browser()
    b.pamLogin("claude")
    const p = await b.page("https://portal.localhost/passkeys")
    expect((await b.post("portal.localhost", "/app-auth/fresh", p.token, { request: "nope" })).status).toBe(404)
    const { request } = await startAppLogin(b, "notes.localhost", "/x", 0)
    b.pamLogin("claude", "portal.candy")
    const pc = await b.page("https://portal.candy/passkeys")
    expect((await b.post("portal.candy", "/app-auth/fresh", pc.token, { request })).status).toBe(404)
    lockedIps.set("127.0.0.1", 9)
    const pl = await b.page("https://portal.localhost/passkeys")
    expect((await b.post("portal.localhost", "/app-auth/fresh", pl.token, { request })).status).toBe(429)
  })
})

describe("the superuser claim", () => {
  it("is true for a sudoer and false otherwise, checked when the token is made", async () => {
    const a = new Browser()
    a.pamLogin("ashwin")
    expect((await a.submitForm((await decide(a, (await startAppLogin(a)).request)).body)).status).toBe(303)
    expect(logins.at(-1)).toMatchObject({ user: "ashwin", superuser: true })
    const c = new Browser()
    c.pamLogin("claude")
    expect((await c.submitForm((await decide(c, (await startAppLogin(c)).request)).body)).status).toBe(303)
    expect(logins.at(-1)).toMatchObject({ user: "claude", superuser: false })
    // Removed from sudoers between the consent page and the decision: the token says so
    const { request } = await startAppLogin(a)
    const page = await a.page(`https://portal.localhost/app-auth/consent?request=${request}`)
    SUPERUSERS.delete("ashwin")
    const res = await a.post("portal.localhost", "/app-auth/decision", page.token, { request, approve: true, remember: true })
    expect((await a.submitForm(await res.json() as any)).status).toBe(303)
    expect(logins.at(-1)).toMatchObject({ user: "ashwin", superuser: false })
    expect(audits.some(([act, d]) => act === "APP_AUTH_GRANT" && d.includes("ashwin") && d.includes("superuser"))).toBe(true)
  })

  it("the consent page says the site learns whether the account is an administrator", async () => {
    const html = await Bun.file(join(root, "public", "app-consent.html")).text()
    expect(html).toContain("whether the account is an administrator")
  })
})
