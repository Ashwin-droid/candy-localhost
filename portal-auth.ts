// Portal login and per-user authorization: the pure parts, wired up in
// daemon.ts (see "Portal Login (PAM)" in AUTH_DESIGN.md).
//
//   classifyRoute   which class a control route is in (the table lives in daemon.ts)
//   guardRequest    login / superuser decision for one request
//   sameOrigin      Origin (or Referer) check for state-changing portal requests
//   PageTokens      the per-page CANDY_TOKEN chain, tied to a login session
//   attemptLogin    POST /auth/login: lockouts, equal-time failures, audit
//   userScopedFetch makes in-process MCP calls act as one user
import type { AsyncLocalStorage } from "node:async_hooks"

export type RouteClass = "public" | "user" | "superuser"
/** [method or "*", path, class]. A path ending in "/*" matches anything below it, never the bare prefix. */
export type RouteRule = readonly [string, string, RouteClass]

export interface RequestAuth {
  user: string
  superuser: boolean
  via: "portal" | "apikey" | "oauth"
  sessionId?: string   // portal only
}

export const classifyRoute = (table: readonly RouteRule[], method: string, path: string): RouteClass | null => {
  const m = method === "HEAD" ? "GET" : method
  for (const [rm, rp, cls] of table) {
    if (rm !== "*" && rm !== m) continue
    if (rp.endsWith("/*")) {
      const prefix = rp.slice(0, -1)
      if (path.startsWith(prefix) && path.length > prefix.length) return cls
    } else if (rp === path) return cls
  }
  return null
}

/** The superuser override, or the owner itself. No one else, and no owner-of-the-daemon exception. */
export const mayActOn = (auth: RequestAuth | null, owner: string): boolean =>
  !!auth && (auth.superuser || auth.user === owner)

/** A same-origin path to come back to after logging in, or "/". */
export const safeNext = (next: string | null | undefined): string => {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/"
  if (/[\u0000-\u001f\\]/.test(next) || next.length > 1024) return "/"
  try {
    const u = new URL(next, "https://portal.invalid")
    if (u.origin !== "https://portal.invalid") return "/"
    if (u.pathname === "/login") return "/"
    const out = u.pathname + u.search
    // "/.//evil.com" normalizes to "//evil.com": protocol-relative, so check again
    if (out.startsWith("//") || out.startsWith("/\\") || new URL(out, "https://portal.invalid").origin !== "https://portal.invalid") return "/"
    return out
  } catch {
    return "/"
  }
}

export const wantsHtml = (method: string, accept: string | null): boolean =>
  (method === "GET" || method === "HEAD") && /text\/html/.test(accept || "")

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 302; location: string }
  | { ok: false; status: 401 | 403 | 404; error: string }

/**
 * Login and class checks for a portal-host or control request. Fails closed:
 * a route missing from the table is a 404 whoever asks.
 */
export const guardRequest = (o: {
  cls: RouteClass | null
  auth: RequestAuth | null
  portalHost: boolean
  html: boolean
  path: string
  search: string
}): GuardResult => {
  if (!o.cls) return { ok: false, status: 404, error: "not found" }
  if (o.cls === "public") return { ok: true }
  if (!o.auth) {
    if (o.portalHost && o.html) return { ok: false, status: 302, location: `/login?next=${encodeURIComponent(safeNext(o.path + o.search))}` }
    return { ok: false, status: 401, error: "login required" }
  }
  if (o.cls === "superuser" && !o.auth.superuser) {
    return { ok: false, status: 403, error: o.auth.via === "portal" ? "Only a superuser can do that." : "Only a superuser, logged in to the portal, can do that." }
  }
  return { ok: true }
}

/**
 * An exact portal origin: https, the default port, a portal host. Browsers
 * don't scope cookies by port, so http://portal.localhost:5555 is another
 * site entirely and must never count as the portal.
 */
export const isPortalOrigin = (origin: string | null | undefined, isPortalHost: (host: string) => boolean): boolean => {
  if (!origin || origin === "null") return false
  try {
    const u = new URL(origin)
    return u.protocol === "https:" && u.port === "" && u.username === "" && u.password === "" && isPortalHost(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

const originOf = (value: string | null): URL | null => {
  if (!value || value === "null") return null
  try { return new URL(value) } catch { return null }
}

/**
 * The request comes from a page on the portal itself: Origin (or, without
 * one, Referer) is an exact portal origin (isPortalOrigin) for the same host
 * the request is for. Missing both fails.
 */
export const sameOrigin = (headers: Headers, isPortalHost: (host: string) => boolean): boolean => {
  const host = (headers.get("host") || "").toLowerCase().replace(/:443$/, "")
  const from = originOf(headers.get("origin")) ?? originOf(headers.get("referer"))
  if (!from || !host) return false
  if (!isPortalOrigin(from.origin, isPortalHost)) return false
  return from.host.toLowerCase() === host
}

// ----------------------------------------------------------------------------
// Page tokens: one rolling chain per page load, each tied to a login session.
// Token format: chainId:value. The current and the previous token stay valid
// for /token refreshes; only the current one is accepted by consume().
// ----------------------------------------------------------------------------

interface Chain { tokens: string[]; session: string; created: number }

/** Page loads one login keeps tokens for; older pages need a reload. */
export const MAX_CHAINS_PER_SESSION = 32

export class PageTokens {
  private chains = new Map<string, Chain>()
  constructor(private now: () => number = Date.now, private maxAgeMs = 24 * 60 * 60 * 1000) {}

  mint(sessionId: string): string {
    // Oldest first (Maps keep insertion order): one login can't grow this without bound
    let mine = 0
    for (const c of this.chains.values()) if (c.session === sessionId) mine++
    for (const [id, c] of this.chains) {
      if (mine < MAX_CHAINS_PER_SESSION) break
      if (c.session === sessionId) { this.chains.delete(id); mine-- }
    }
    const chainId = crypto.randomUUID()
    const token = `${chainId}:${crypto.randomUUID()}`
    this.chains.set(chainId, { tokens: [token], session: sessionId, created: this.now() })
    return token
  }

  private chainFor(token: unknown, sessionId: string | null | undefined): Chain | null {
    if (typeof token !== "string" || !sessionId || token.length > 200) return null
    const parts = token.split(":")
    if (parts.length !== 2) return null
    const chain = this.chains.get(parts[0])
    if (!chain || chain.session !== sessionId) return null
    if (this.now() - chain.created > this.maxAgeMs) {
      this.chains.delete(parts[0])
      return null
    }
    return chain
  }

  /** True (and rolls the chain) when `token` is the current one of a chain minted for this session. */
  consume(token: unknown, sessionId: string | null | undefined): boolean {
    const chain = this.chainFor(token, sessionId)
    if (!chain || chain.tokens[chain.tokens.length - 1] !== token) return false
    const chainId = (token as string).split(":")[0]
    if (chain.tokens.length >= 2) chain.tokens.shift()
    chain.tokens.push(`${chainId}:${crypto.randomUUID()}`)
    return true
  }

  /** The chain's current token, given its current or previous one. */
  refresh(token: unknown, sessionId: string | null | undefined): string | null {
    const chain = this.chainFor(token, sessionId)
    if (!chain || !chain.tokens.includes(token as string)) return null
    return chain.tokens[chain.tokens.length - 1]
  }

  dropSession(sessionId: string): void {
    for (const [id, c] of this.chains) if (c.session === sessionId) this.chains.delete(id)
  }

  /** Drops chains that are too old or whose login has ended. */
  sweep(sessionAlive: (id: string) => boolean): void {
    const now = this.now()
    for (const [id, c] of this.chains) if (now - c.created > this.maxAgeMs || !sessionAlive(c.session)) this.chains.delete(id)
  }

  get size(): number { return this.chains.size }
}

// ----------------------------------------------------------------------------
// Login
// ----------------------------------------------------------------------------

/**
 * Every failure takes at least this long, so its timing says nothing about why
 * it failed. Above PAM's own failure delay: the helper's denied path measured
 * p99 2.5s (pam_unix), and pam_faildelay's 3s ±25% can reach 3.75s.
 */
export const LOGIN_FAILURE_FLOOR_MS = 4500
export const LOGIN_FAILED = "Wrong username or password."
/** Every slot is taken: nothing was checked, so it must not read like a wrong password. */
export const LOGIN_BUSY = "busy, try again"
export const LOGIN_USER_SLOWED = "Too many failed logins for this account. Try again in a moment."
export const LOGIN_UNAVAILABLE = "Portal login isn't set up on this machine: /etc/pam.d/candy is missing. Run install-service.sh as root."
const MAX_USER_LENGTH = 64
const MAX_PASSWORD_LENGTH = 4096
/** PAM helpers running at once, across everyone. */
export const MAX_PAM_IN_FLIGHT = 4
/** The longest the soft (per user, loopback) lockout ever makes anyone wait. */
export const SOFT_DELAY_CAP_MS = 30_000
const SOFT_FREE_FAILURES = 3
const MAX_SOFT_KEYS = 10_000

/**
 * A growing delay after failures (3 free, then 7.5s, 15s, capped at 30s).
 * Used where a hard lock would let someone else lock a person out: per
 * user (from anywhere), and for loopback, which is every browser on this machine.
 */
export class SoftLockout {
  private state = new Map<string, { count: number; until: number }>()
  constructor(private now: () => number = Date.now) {}

  static delayFor(count: number): number {
    if (count < SOFT_FREE_FAILURES) return 0
    // Starts above the failure floor, or the first step would pass unnoticed
    return Math.min(SOFT_DELAY_CAP_MS, 7500 * 2 ** (count - SOFT_FREE_FAILURES))
  }

  /** Milliseconds until `key` may try again (0: now). */
  wait(key: string): number {
    const s = this.state.get(key)
    return s ? Math.max(0, s.until - this.now()) : 0
  }

  fail(key: string): number {
    const s = this.state.get(key) ?? { count: 0, until: 0 }
    this.state.delete(key)  // re-insert: the Map stays oldest-first
    s.count++
    const delay = SoftLockout.delayFor(s.count)
    s.until = this.now() + delay
    this.state.set(key, s)
    while (this.state.size > MAX_SOFT_KEYS) this.state.delete(this.state.keys().next().value!)
    return delay
  }

  /** Undoes one fail() (the attempt never reached a verdict). */
  refund(key: string): void {
    const s = this.state.get(key)
    if (!s) return
    s.count--
    if (s.count <= 0) this.state.delete(key)
    else if (SoftLockout.delayFor(s.count) === 0) s.until = 0
  }

  clear(key: string): void { this.state.delete(key) }
  get size(): number { return this.state.size }
}

/**
 * Who is talking to PAM right now: one attempt per user and per address at a
 * time, and MAX_PAM_IN_FLIGHT helpers overall. Otherwise a burst of parallel
 * guesses all pass the lockout check before the first failure is counted.
 */
export class LoginSlots {
  private users = new Set<string>()
  private ips = new Set<string>()
  private running = 0
  constructor(private max = MAX_PAM_IN_FLIGHT) {}

  acquire(user: string, ip: string): (() => void) | null {
    const u = user.toLowerCase()
    if (this.running >= this.max || this.users.has(u) || this.ips.has(ip)) return null
    this.users.add(u)
    this.ips.add(ip)
    this.running++
    let released = false
    return () => {
      if (released) return
      released = true
      this.users.delete(u)
      this.ips.delete(ip)
      this.running--
    }
  }

  get inFlight(): number { return this.running }
}

export interface LoginDeps {
  pamReady(): boolean
  loginUsers(): Promise<string[]>
  verifyPassword(user: string, password: string): Promise<{ ok: boolean; reason: "ok" | "denied" | "account" | "unavailable" | "timeout" }>
  isSuperuser(user: string): Promise<boolean>
  /** The persisted Fibonacci grudges (hard lock), used per non-loopback address. */
  blocked(key: string): Promise<{ blocked: boolean; retryAfter: number }>
  fail(key: string): Promise<{ retryAfter: number }>
  clear(key: string): Promise<void>
  /** Undo one fail(): the attempt was counted up front but PAM never answered. */
  refund?(key: string): Promise<void>
  audit(action: "AUTH_LOGIN" | "AUTH_FAIL", details: string): void
  serverError(message: string): void
  now(): number
  sleep(ms: number): Promise<void>
  /** Loopback is every browser on this machine; it gets the soft lockout, never the hard one. */
  isLoopback?(ip: string): boolean
  slots?: LoginSlots
  soft?: SoftLockout
}

export type LoginOutcome =
  | { ok: true; user: string; superuser: boolean }
  | { ok: false; status: number; body: { error: string; retryAfter?: number } }

/**
 * Per address (hard grudge, or soft on loopback) and per user (always soft).
 * All of 127/8 and ::1 is one address: any local process can bind 127.0.0.N,
 * so rotating them must not buy more guesses. The user key has no address in
 * it for the same reason; its delay is capped, so it can't lock anyone out.
 */
export const loginKeys = (user: string, ip: string, loopback = false) => {
  const where = loopback ? "loopback" : ip
  return { ip: `portal:ip:${where}`, user: `portal:user:${user.toLowerCase()}`, slot: where }
}

/** For logs: printable and short, whatever someone typed. */
export const logSafe = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_USER_LENGTH)

// Deps that don't bring their own slots and soft lockout still get one set each,
// so concurrency is bounded whoever calls attemptLogin
const defaults = new WeakMap<LoginDeps, { slots: LoginSlots; soft: SoftLockout }>()
const stateOf = (deps: LoginDeps) => {
  let d = defaults.get(deps)
  if (!d) defaults.set(deps, d = { slots: deps.slots ?? new LoginSlots(), soft: deps.soft ?? new SoftLockout(() => deps.now()) })
  return d
}

/**
 * One login attempt. An unknown user, a wrong password, a right password on a
 * blocked account and a PAM problem all get the same 401 body after the same
 * floor time. Answers that checked no password are told apart (429): the
 * caller's address lockout, the account's soft delay (retryAfter), and busy
 * slots ("busy, try again"), so a right password never reads as a wrong one.
 *
 * The attempt is counted as a failure before PAM is asked and refunded on
 * success, and only one attempt per user and per address runs at a time, so
 * parallel guesses can't outrun the lockout.
 */
export const attemptLogin = async (deps: LoginDeps, input: { user: unknown; password: unknown; ip: string }): Promise<LoginOutcome> => {
  const start = deps.now()
  if (!deps.pamReady()) return { ok: false, status: 503, body: { error: LOGIN_UNAVAILABLE } }
  const { slots, soft } = stateOf(deps)
  const user = typeof input.user === "string" ? input.user.slice(0, MAX_USER_LENGTH + 1) : ""
  const password = typeof input.password === "string" && input.password.length <= MAX_PASSWORD_LENGTH ? input.password : ""
  const localIp = deps.isLoopback?.(input.ip) ?? false
  const keys = loginKeys(user, input.ip, localIp)
  const who = `${logSafe(user) || "(none)"} from ${logSafe(input.ip)}`

  const floor = () => deps.sleep(Math.max(0, start + LOGIN_FAILURE_FLOOR_MS - deps.now()))
  const failIp = async (): Promise<number> => localIp ? Math.ceil(soft.fail(keys.ip) / 1000) : (await deps.fail(keys.ip)).retryAfter
  const failed = async (why: string, retryAfter = 0): Promise<LoginOutcome> => {
    deps.audit("AUTH_FAIL", `${who} (${why})`)
    await floor()
    return { ok: false, status: 401, body: retryAfter > 0 ? { error: LOGIN_FAILED, retryAfter } : { error: LOGIN_FAILED } }
  }

  const hard = localIp ? null : await deps.blocked(keys.ip)
  const ipWait = hard ? (hard.blocked ? Math.max(1, hard.retryAfter) : 0) : Math.ceil(soft.wait(keys.ip) / 1000)
  if (ipWait > 0) {
    deps.audit("AUTH_FAIL", `${who} (address locked out)`)
    await floor()
    return { ok: false, status: 429, body: { error: "Too many failed logins from this address.", retryAfter: ipWait } }
  }

  const known = user.length > 0 && user.length <= MAX_USER_LENGTH && (await deps.loginUsers().catch(() => [] as string[])).includes(user)
  if (!known) return failed("unknown user", await failIp())
  // Not a failure of this caller's: say so (no PAM, nothing counted), so a
  // right password is never answered with "wrong password"
  const userWait = Math.ceil(soft.wait(keys.user) / 1000)
  if (userWait > 0) return { ok: false, status: 429, body: { error: LOGIN_USER_SLOWED, retryAfter: userWait } }

  const release = slots.acquire(user, keys.slot)
  if (!release) return { ok: false, status: 429, body: { error: LOGIN_BUSY } }
  let result: Awaited<ReturnType<LoginDeps["verifyPassword"]>>
  let retryAfter = 0
  try {
    // Counted before PAM is asked, refunded below if it never gives a verdict
    retryAfter = await failIp()
    soft.fail(keys.user)
    try {
      result = await deps.verifyPassword(user, password)
    } catch {
      result = { ok: false, reason: "unavailable" }
    }
  } finally {
    release()
  }
  if (result.ok) {
    if (localIp) soft.clear(keys.ip)
    else await deps.clear(keys.ip)
    soft.clear(keys.user)
    const superuser = await deps.isSuperuser(user).catch(() => false)
    deps.audit("AUTH_LOGIN", `${who}${superuser ? " (superuser)" : ""}`)
    return { ok: true, user, superuser }
  }
  if (result.reason === "unavailable" || result.reason === "timeout") {
    if (localIp) soft.refund(keys.ip)
    else await deps.refund?.(keys.ip)
    soft.refund(keys.user)
    deps.serverError(`PAM ${result.reason} checking ${who}`)
    return failed(`PAM ${result.reason}`)
  }
  // "account": the password was right but PAM's account check refused (expired, locked)
  return failed(result.reason === "account" ? "account refused by PAM" : "wrong password", retryAfter)
}

// ----------------------------------------------------------------------------
// In-process MCP calls as one user
// ----------------------------------------------------------------------------

/**
 * A fetch that, inside `store.run(user, ...)`, rewrites calls to the daemon
 * (`origin`) to carry that user's API key, and answers the secret exchange
 * (/mcp/auth) with it. The public MCP endpoint runs mcp.ts in the daemon's
 * process, so this is how its tools act as the user who approved the client.
 * Outside a run, fetch is untouched.
 */
export const userScopedFetch = (
  base: typeof fetch,
  store: AsyncLocalStorage<string>,
  origin: string,
  keyFor: (user: string) => string,
): typeof fetch => {
  const scoped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const user = store.getStore()
    if (user === undefined) return base(input, init)
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (url.origin !== new URL(origin).origin) return base(req)
    const key = keyFor(user)
    if (url.pathname === "/mcp/auth") return Response.json({ apiKey: key, user })
    const headers = new Headers(req.headers)
    headers.set("X-Candy-API-Key", key)
    return base(new Request(req, { headers }))
  }) as typeof fetch
  return Object.assign(scoped, { preconnect: (base as any).preconnect })
}

// ----------------------------------------------------------------------------
// Shortcut hosts: <name>.k|kill.<tld> stops a site, <name>.p|portal.<tld>
// opens a public tunnel to it. The login cookie lives on the portal host only,
// so the shortcut host just sends the browser to a confirmation page there.
// ----------------------------------------------------------------------------

export type ShortcutAction = "kill" | "portal"

export interface ShortcutHost {
  action: ShortcutAction
  name: string           // the first label, <name>
  label: string | null   // the optional host label between the action and the TLD
  tld: "localhost" | "candy"
}

/** Which shortcut a host is, or null. A :port is ignored. */
export const parseShortcutHost = (host: string): ShortcutHost | null => {
  const h = host.replace(/:\d+$/, "").toLowerCase()
  const m = h.match(/^([a-z0-9-]+)\.(kill|k|portal|p)(?:\.([a-z0-9-]+))?\.(localhost|candy)$/)
  if (!m) return null
  return { action: m[2] === "kill" || m[2] === "k" ? "kill" : "portal", name: m[1], label: m[3] ?? null, tld: m[4] as "localhost" | "candy" }
}

/** The confirmation page on the portal host for a shortcut. */
export const shortcutConfirmUrl = (action: ShortcutAction, name: string, tld: "localhost" | "candy"): string =>
  `https://portal.${tld}/go/${action}?name=${encodeURIComponent(name)}`

// ----------------------------------------------------------------------------
// Site page tokens: what a site's own page (starting, crashed) needs to start
// or restart that one site. Minted into the page by the daemon, bound to the
// site's name and that page load, short-lived. An Origin header alone proves
// nothing: curl can send any Origin it likes.
// ----------------------------------------------------------------------------

export const SITE_TOKEN_TTL_MS = 15 * 60 * 1000
const MAX_SITE_TOKENS = 5000

export class SiteTokens {
  private tokens = new Map<string, { name: string; expires: number }>()
  constructor(private now: () => number = Date.now, private ttlMs = SITE_TOKEN_TTL_MS) {}

  mint(name: string): string {
    const token = `site_${crypto.randomUUID()}`
    this.tokens.set(token, { name, expires: this.now() + this.ttlMs })
    while (this.tokens.size > MAX_SITE_TOKENS) this.tokens.delete(this.tokens.keys().next().value!)
    return token
  }

  /** True when `token` was minted for `name` and hasn't expired. A page may press Restart more than once. */
  check(token: unknown, name: string): boolean {
    if (typeof token !== "string" || token.length > 100) return false
    const t = this.tokens.get(token)
    if (!t) return false
    if (this.now() >= t.expires) {
      this.tokens.delete(token)
      return false
    }
    return t.name === name
  }

  /** Ends every token for `name`: once the site is up, its starting page has nothing left to do. */
  dropName(name: string): void {
    for (const [k, t] of this.tokens) if (t.name === name) this.tokens.delete(k)
  }

  sweep(): void {
    const now = this.now()
    for (const [k, t] of this.tokens) if (now >= t.expires) this.tokens.delete(k)
  }

  get size(): number { return this.tokens.size }
}

// ----------------------------------------------------------------------------
// The caller's address
// ----------------------------------------------------------------------------

/**
 * Who is really on the other end. X-Forwarded-For and Cf-Connecting-Ip are
 * only believed from the daemon's own Caddy (`viaCaddy`: the request carries
 * the per-boot proxy tag Caddy adds); anyone else talking to :9999 directly
 * gets their socket address. From Caddy, the last X-Forwarded-For entry is
 * the one Caddy appended itself (its peer), and Cf-Connecting-Ip counts only
 * when that peer is loopback (cloudflared).
 */
export const clientIp = (o: {
  peer: string
  viaCaddy: boolean
  xff: string | null
  cf: string | null
  isLoopback: (ip: string) => boolean
  normalize: (ip: string) => string
}): string => {
  const peer = o.normalize(o.peer || "unknown")
  if (!o.viaCaddy) return peer
  const hops = (o.xff || "").split(",").map(s => s.trim()).filter(Boolean)
  const last = hops.length ? o.normalize(hops[hops.length - 1]) : peer
  const cf = o.cf?.trim()
  if (cf && o.isLoopback(last) && /^[0-9a-fA-F:.]{2,45}$/.test(cf)) return o.normalize(cf)
  return /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : peer
}

// ----------------------------------------------------------------------------
// Audit log
// ----------------------------------------------------------------------------

/** One audit field on one line: control characters (newlines too) can't start a forged entry. */
export const auditSafe = (s: unknown): string =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)

/**
 * The audit actor for a request: always the authenticated user. X-Candy-Actor
 * (e.g. "AI" from the MCP server) is only a label after it, never a name.
 */
export const auditActor = (auth: RequestAuth | null, label: string | null | undefined, fallback = "System"): string => {
  const base = !auth ? fallback : auth.via === "portal" ? "Portal" : auth.via === "oauth" ? "MCP" : "API"
  const clean = typeof label === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(label) ? label : null
  return auth ? `${auth.user}:${clean ?? base}` : base
}

// ----------------------------------------------------------------------------
// A list worth caching for a while (login eligibility)
// ----------------------------------------------------------------------------

export const cachedList = <T>(load: () => Promise<T[]>, ttlMs: number, now: () => number = Date.now): (() => Promise<T[]>) => {
  let value: T[] | null = null
  let at = 0
  let pending: Promise<T[]> | null = null
  return async () => {
    if (value && now() - at < ttlMs) return value
    if (!pending) {
      pending = load().then(v => { value = v; at = now(); return v }).finally(() => { pending = null })
    }
    return pending
  }
}

/** The header that carries the login's session secret, next to the cookie. */
export const SESSION_HEADER = "X-Candy-Session"
