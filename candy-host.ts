// candy's own public host, candy.<zone> (SDK_AUTH_DESIGN.md, "Passkeys on
// the candy host"). It is the one WebAuthn rpId: the portal hosts
// (portal.candy, portal.localhost) use Caddy's local CA, and browsers refuse
// WebAuthn on a page with a certificate error, so a passkey ceremony always
// happens here, on a real certificate through the Cloudflare tunnel, and the
// browser comes back to the portal afterwards.
//
// This host is on the public internet, so it serves almost nothing:
//
//   GET  /passkey/enroll           the ceremony page (adding a passkey, in a popup from the portal)
//   POST /passkey/enroll/options   creation options
//   POST /passkey/enroll/verify    stores the passkey for the stamped portal login
//   GET  /passkey/login            the ceremony page (logging in)
//   POST /passkey/login/options    request options
//   POST /passkey/login/verify     checks the assertion, hands back a one-time login code for the portal
//
// and only with a **stamp**: a sealed, single-use, 5-minute ticket the daemon
// mints when a request arrives on a portal host (tailnet or loopback only), so
// reaching the portal is the tailnet check. Without a valid stamp everything
// here is a 404 and no challenge is ever issued. It never reads the portal
// cookie, an API key or the session header, never serves the control API,
// pages, sites or anything else, and the daemon dispatches it before its
// guard by Host, like the public MCP host (which may share this host: then
// /mcp and its OAuth paths stay MCP's, isPublicMcpPath).
//
// The first time a stamp's page is opened, the stamp is claimed by that
// browser (a random cookie on this host, CEREMONY_COOKIE): a stamp copied
// from a log, a history entry or over a shoulder afterwards is useless in
// another browser. A login ends with a one-time code (60 s, single use) bound
// to the portal host and to a cookie the portal set in the browser that
// started (PASSKEY_BIND_COOKIE), which the page POSTs to the portal's
// /auth/passkey/finish; the portal makes the session there. This host never
// mints app tokens, never holds consent and never makes a portal session.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { candyHostFor, CANDY_SUBDOMAIN, isZoneName } from "./caddy-config.ts"
import { logSafe, safeNext } from "./portal-auth.ts"
import { LiveSet, SealedIds } from "./sealed-ids.ts"
import {
  attemptPasskeyLogin, cleanPasskeyName, finishRegistration, mayManagePasskeys, startPasskeyLogin, startRegistration,
  PASSKEY_NEEDS_PASSWORD, type PasskeyDeps,
} from "./passkey-store.ts"

export { candyHostFor, CANDY_SUBDOMAIN }

export const STAMP_TTL_MS = 5 * 60_000
export const LOGIN_CODE_TTL_MS = 60_000
/** The stamp's query parameter on the way to the candy host (Caddy's access log drops it). */
export const STAMP_PARAM = "candy_stamp"
/** The login code's form field on the way back to the portal (a POST body, never a URL). */
export const CODE_FIELD = "candy_code"
/** On the candy host: which browser opened a stamp's page first. */
export const CEREMONY_COOKIE = "__Host-candy_ceremony"
/** On the portal: the browser that started a passkey login; the login code must come back to it. */
export const PASSKEY_BIND_COOKIE = "__Host-candy_passkey"
export const COOKIE_MAX_AGE_S = 10 * 60
const COOKIE_VALUE_RE = /^[A-Za-z0-9_-]{43}$/     // 32 random bytes, b64url
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i   // portal-session.ts

export const STAMP_EXPIRED = "This link expired or was already used. Go back and try again."
export const PASSKEYS_NEED_DOMAIN = "Passkeys need a bound domain: the passkey check runs on candy.<your domain>, which has a real certificate. Set one up with candy domain config; until then, log in with your password."
export const ENROLL_SESSION_GONE = "Your portal login ended. Log in again, then add the passkey from the passkeys page."

export type StampPurpose = "enroll" | "login"
export interface StampPayload {
  purpose: StampPurpose
  /** The candy host it was minted for: a zone change voids it */
  host: string
  /** The portal host to go back to (a portal host when minted, checked again when used) */
  portal: string
  /** Where on the portal afterwards: a safeNext path */
  next: string
  /** login: SHA-256 (b64url) of the PASSKEY_BIND_COOKIE the portal set in this browser */
  bind: string | null
  /** enroll only: the portal login it came from, and when its password was last checked */
  user: string | null
  sessionId: string | null
  pamAt: number | null
  name: string | null
  /**
   * login only, optional: an app asked for a fresh authentication (max_age).
   * The passkey then re-authenticates this portal session (same user only)
   * for that one parked request (app-auth.ts freshKey), instead of making a new session.
   */
  fresh?: FreshBinding | null
  /**
   * enroll only: the session's enroll sequence when the stamp was made
   * (PortalSessions.enrollSeq). A finished enrollment moves it on, so every
   * other enroll stamp of that login is void, whatever any memory holds.
   */
  seq?: number
  /** The address that asked for it (addressKey): its share of the stamp sets */
  by?: string
}
export interface FreshBinding { sessionId: string; request: string }
export interface LoginCodePayload { user: string; host: string; portal: string; next: string; bind: string; credential: string; fresh: FreshBinding | null; by?: string }
const FRESH_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const isFresh = (f: unknown): f is FreshBinding =>
  !!f && typeof f === "object" && typeof (f as FreshBinding).sessionId === "string" && !!(f as FreshBinding).sessionId
  && typeof (f as FreshBinding).request === "string" && FRESH_KEY_RE.test((f as FreshBinding).request)

export type StampCheck =
  | { ok: true; jti: string; expires: number; stamp: StampPayload }
  /** Not ours, tampered, another purpose or another candy host: nothing to say about it */
  | { ok: false; why: "invalid" }
  /** Ours, but no longer usable: the page can still point back to its portal */
  | { ok: false; why: "expired" | "used" | "elsewhere"; stamp: StampPayload }

export const sha256b64 = (s: string): string => createHash("sha256").update(s, "utf8").digest("base64url")
export const newCookieValue = (): string => randomBytes(32).toString("base64url")
export const isCookieValue = (v: unknown): v is string => typeof v === "string" && COOKIE_VALUE_RE.test(v)
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** The request comes from a page on the candy host: Origin is exactly https://<candy host>. */
export const fromCandyHost = (headers: Headers, candyHost: string | null): boolean =>
  !!candyHost && headers.get("origin") === `https://${candyHost}`

/** One cookie's value from a Cookie header, or null. */
export const readCookie = (header: string | null | undefined, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null
  }
  return null
}

/** Thrown by mintStamp when no more stamps may be made right now ("owner": this address holds its share; "full": everyone together). */
export class TicketsBusy extends Error {
  constructor(readonly why: "owner" | "full", readonly retryAfterS: number) { super(`passkey stamps: ${why}`) }
}

/** Live stamps one address may hold at once (all of loopback is one address), and in all. */
export const MAX_STAMPS_PER_ADDRESS = 64
export const MAX_LIVE_STAMPS = 10_000
/** Stamp pages one candy-host address may claim per stamp lifetime */
export const MAX_CLAIMS_PER_ADDRESS = 64

/** The owner key for an address: all of loopback is one (like loginKeys). */
export const addressKey = (ip: string, loopback: boolean): string => loopback ? "loopback" : `ip:${ip}`

/**
 * Stamps and login codes: sealed ids (sealed-ids.ts), stateless, single use.
 * Only minted stamps (counted per address), used ids and stamp claims are
 * remembered, until they expire. None of these sets ever evicts a live entry
 * (review finding: a flood of cheap login stamps pushed a victim's used or
 * claimed enroll stamp out, and it became usable in the attacker's browser).
 * When full they fail closed: no new stamps (TicketsBusy), and a stamp whose
 * use or claim can't be recorded is unusable.
 */
export class PasskeyTickets {
  private stamps: SealedIds<StampPayload>
  private codes: SealedIds<LoginCodePayload>
  private minted: LiveSet                                   // one entry per live stamp, owned by the minting address
  private claims: LiveSet<string>                           // stamp jti -> ceremony cookie hash, owned by the claiming address
  private now: () => number
  private stampTtl: number
  private codeTtl: number

  constructor(opts: { now?: () => number; stampTtlMs?: number; codeTtlMs?: number; maxUsed?: number; maxPerAddress?: number; maxClaimsPerAddress?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.stampTtl = opts.stampTtlMs ?? STAMP_TTL_MS
    this.codeTtl = opts.codeTtlMs ?? LOGIN_CODE_TTL_MS
    const max = opts.maxUsed ?? MAX_LIVE_STAMPS
    const per = opts.maxPerAddress ?? MAX_STAMPS_PER_ADDRESS
    this.stamps = new SealedIds<StampPayload>("candy passkey stamp v1", { now: this.now, maxUsed: max, maxPerOwner: per })
    this.codes = new SealedIds<LoginCodePayload>("candy passkey login code v1", { now: this.now, maxUsed: max, maxPerOwner: per })
    this.minted = new LiveSet(this.now, max, per)
    this.claims = new LiveSet<string>(this.now, max, opts.maxClaimsPerAddress ?? MAX_CLAIMS_PER_ADDRESS)
  }

  /**
   * A new stamp, counted against the address that asked for it (`by`, see
   * addressKey). Throws TicketsBusy when that address holds its share, or
   * when stamps couldn't be used up any more; throws Error on a payload the
   * daemon should never make.
   */
  mintStamp(p: StampPayload, by: string): string {
    if (p.purpose !== "enroll" && p.purpose !== "login") throw new Error("stamp: bad purpose")
    if (!isZoneName(p.host) || !isZoneName(p.portal)) throw new Error("stamp: bad host")
    if (safeNext(p.next) !== p.next) throw new Error("stamp: bad next")
    if (typeof by !== "string" || !by) throw new Error("stamp: no address")
    if (p.purpose === "login") {
      if (typeof p.bind !== "string" || !p.bind || p.user !== null || p.sessionId !== null) throw new Error("stamp: a login stamp names no one")
      if (p.fresh != null && !isFresh(p.fresh)) throw new Error("stamp: bad fresh binding")
    } else {
      if (typeof p.user !== "string" || !USER_RE.test(p.user) || typeof p.sessionId !== "string" || !p.sessionId) throw new Error("stamp: an enroll stamp needs its login")
      if (typeof p.pamAt !== "number" || !Number.isFinite(p.pamAt) || p.bind !== null || p.fresh != null) throw new Error("stamp: bad enroll stamp")
      if (!Number.isSafeInteger(p.seq) || (p.seq as number) < 0) throw new Error("stamp: an enroll stamp needs its session's enroll sequence")
    }
    const expires = this.now() + this.stampTtl
    const retry = Math.ceil(this.stampTtl / 1000)
    // A stamp that couldn't be used up later is never handed out
    const usable = this.stamps.room(by)
    if (usable !== "ok") throw new TicketsBusy(usable, retry)
    const counted = this.minted.add(randomBytes(12).toString("base64url"), true, expires, by)
    if (counted !== "ok") throw new TicketsBusy(counted, retry)
    const payload: StampPayload = {
      purpose: p.purpose, host: p.host, portal: p.portal, next: p.next, bind: p.bind,
      user: p.user, sessionId: p.sessionId, pamAt: p.pamAt, name: p.name === null ? null : cleanPasskeyName(p.name),
      fresh: p.fresh ? { sessionId: p.fresh.sessionId, request: p.fresh.request } : null,
      seq: p.purpose === "enroll" ? p.seq : undefined, by,
    }
    return this.stamps.seal(payload, expires)
  }

  private open(id: unknown, purpose: StampPurpose, host: string, consume: boolean): StampCheck {
    const o = this.stamps.open(id)
    if (!o || typeof o.payload !== "object" || o.payload === null) return { ok: false, why: "invalid" }
    let used = this.stamps.isUsed(o.jti)
    // Any take of an intact stamp uses it up, of the wrong purpose included. If
    // that can't be recorded, the stamp is unusable (fail closed), never used unrecorded.
    if (consume && !used && !this.stamps.markUsed(o.jti, o.expires, typeof o.payload.by === "string" ? o.payload.by : "")) used = true
    const p = o.payload
    if (p.purpose !== purpose || p.host !== host) return { ok: false, why: "invalid" }
    if (used) return { ok: false, why: "used", stamp: p }
    if (this.stamps.expired(o)) return { ok: false, why: "expired", stamp: p }
    return { ok: true, jti: o.jti, expires: o.expires, stamp: p }
  }

  /** The stamp, if usable; uses nothing up (the page and its options). */
  checkStamp(id: unknown, purpose: StampPurpose, host: string): StampCheck { return this.open(id, purpose, host, false) }

  /** The stamp, if usable; single use from here on (verify). */
  takeStamp(id: unknown, purpose: StampPurpose, host: string): StampCheck { return this.open(id, purpose, host, true) }

  /**
   * The first browser to open a stamp's page claims it (by the hash of its
   * ceremony cookie), on the account of the address it came from. "claimed":
   * now it's this one's; "same": already this one's; "elsewhere": another
   * browser opened it first; "busy": the claim couldn't be recorded (this
   * address claimed too many, or everything is full): the stamp is unusable here.
   */
  claim(jti: string, cookieHash: string, expires: number, by = ""): "claimed" | "same" | "elsewhere" | "busy" {
    const have = this.claims.get(jti)
    if (have) return same(have.value, cookieHash) ? "same" : "elsewhere"
    return this.claims.add(jti, cookieHash, expires, by) === "ok" ? "claimed" : "busy"
  }

  /** Whether the stamp was claimed by the browser with this cookie hash. */
  claimedBy(jti: string, cookieHash: string | null): boolean {
    const have = this.claims.get(jti)
    return !!have && cookieHash !== null && same(have.value, cookieHash)
  }

  mintCode(p: LoginCodePayload): string {
    if (!USER_RE.test(p.user) || !p.bind || safeNext(p.next) !== p.next || (p.fresh !== null && !isFresh(p.fresh))) throw new Error("login code: bad payload")
    return this.codes.seal({ user: p.user, host: p.host, portal: p.portal, next: p.next, bind: p.bind, credential: p.credential, fresh: p.fresh, by: p.by ?? "" }, this.now() + this.codeTtl)
  }

  /** Single use: any take of an intact code uses it up. null when not ours, used, expired, or its use can't be recorded. */
  takeCode(id: unknown): LoginCodePayload | null {
    const o = this.codes.open(id)
    if (!o || this.codes.isUsed(o.jti)) return null
    if (typeof o.payload !== "object" || o.payload === null) return null
    if (!this.codes.markUsed(o.jti, o.expires, typeof o.payload.by === "string" ? o.payload.by : "")) return null
    if (this.codes.expired(o)) return null
    return { ...o.payload, fresh: isFresh(o.payload.fresh) ? o.payload.fresh : null }
  }

  sweep(): number {
    return this.stamps.sweep() + this.codes.sweep() + this.minted.sweep() + this.claims.sweep()
  }
}

// ----------------------------------------------------------------------------
// The host's routes
// ----------------------------------------------------------------------------

/** Everything the candy host answers (besides the public MCP paths when it shares the host). Anything else: 404. */
export const CANDY_HOST_ROUTES: readonly (readonly [string, string])[] = [
  ["GET", "/passkey/enroll"],
  ["POST", "/passkey/enroll/options"],
  ["POST", "/passkey/enroll/verify"],
  ["GET", "/passkey/login"],
  ["POST", "/passkey/login/options"],
  ["POST", "/passkey/login/verify"],
]

/** handlePublicMcp's paths (daemon.ts), for when the public MCP endpoint uses the candy subdomain. */
const PUBLIC_MCP_PATHS = new Set([
  "/mcp", "/register", "/authorize", "/authorize/complete", "/token",
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp",
])
export const isPublicMcpPath = (pathname: string): boolean => PUBLIC_MCP_PATHS.has(pathname.replace(/\/+$/, "") || "/")

/** Headers on every answer from this host. */
export const CANDY_HOST_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
}

/** The ceremony page's CSP: its own nonce'd script and style, fetches to itself, and one form POST: to the stamp's portal. */
export const pageCsp = (nonce: string, portalOrigin: string): string =>
  `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; ` +
  `form-action ${portalOrigin}; frame-ancestors 'none'; base-uri 'none'`

export interface CandyHostDeps {
  /** candy.<zone>, or null while no domain is bound (then everything here is a 404) */
  host(): string | null
  tickets: PasskeyTickets
  passkeys: PasskeyDeps
  isPortalHost(host: string): boolean
  /** A live portal session by id, not slid (PortalSessions.byId) */
  session(id: string): { id: string; user: string; amr: "pam" | "passkey"; pamAt: number | null; enrollSeq: number } | null
  /** A passkey was added for this session: move its enroll sequence on (PortalSessions.bumpEnroll), voiding every other enroll stamp */
  enrolled(id: string): void
  /** Seconds the password login's address lockout has left for this address (0: none) */
  addressWait(ip: string): Promise<number>
  /** public/passkey-host.html */
  page(): Promise<string>
  audit(action: string, details: string): void
  now(): number
}

/** ip: who is asking, as the daemon could prove it (through the tunnel: the visitor's address; anything else: loopback) */
export interface CandyHostContext { ip: string }

const MAX_BODY = 64 * 1024

const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  const declared = req.headers.get("content-length")
  if (declared !== null && (!/^\d{1,15}$/.test(declared.trim()) || Number(declared.trim()) > MAX_BODY)) return {}
  if (!req.body) return {}
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY) { reader.cancel().catch(() => {}); return {} }
      chunks.push(value)
    }
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")

export const createCandyHost = (d: CandyHostDeps) => {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CANDY_HOST_HEADERS })
  const notFound = () => new Response("Not found", { status: 404, headers: { ...CANDY_HOST_HEADERS, "Content-Type": "text/plain; charset=utf-8" } })
  const expired = () => json({ error: STAMP_EXPIRED, expired: true }, 404)

  // The page, with the stamp's (non-secret) facts for its links. The stamp itself stays in the URL the page strips.
  const render = async (vars: Record<string, unknown>, portalOrigin: string, status: number, setCookie?: string): Promise<Response> => {
    const nonce = randomBytes(18).toString("base64url")
    const raw = await d.page()
    const html = raw
      .replace(/<style>/g, `<style nonce="${nonce}">`)
      .replace(/<script>/g, `<script nonce="${nonce}">`)
      .replace(`<script nonce="${nonce}">`, `<script nonce="${nonce}">window.CANDY_PASSKEY=${scriptJson(vars)};</script><script nonce="${nonce}">`)
    const headers: Record<string, string> = {
      ...CANDY_HOST_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": pageCsp(nonce, portalOrigin),
      // Not no-referrer: a POST navigation under no-referrer carries "Origin: null",
      // and the portal's /auth/passkey/finish checks that the code came from here.
      // The stamp is gone from the URL before anything is sent; strict-origin sends the origin only.
      "Referrer-Policy": "strict-origin",
    }
    if (setCookie) headers["Set-Cookie"] = setCookie
    return new Response(html, { status, headers })
  }

  const portalOk = (s: StampPayload) => d.isPortalHost(s.portal)
  const pageVars = (host: string, s: StampPayload, state: "ready" | "expired" | "elsewhere" | "busy") => ({
    purpose: s.purpose, state, fresh: !!s.fresh, candy: `https://${host}`, portal: `https://${s.portal}`, next: s.next,
    user: s.purpose === "enroll" ? s.user : null, name: s.purpose === "enroll" ? s.name : null,
  })

  const ownerOf = (ip: string) => addressKey(ip, d.passkeys.isLoopback(ip))

  const page = async (req: Request, url: URL, host: string, purpose: StampPurpose, ctx: CandyHostContext): Promise<Response> => {
    const raw = url.searchParams.getAll(STAMP_PARAM)
    if (raw.length !== 1) return notFound()
    const c = d.tickets.checkStamp(raw[0], purpose, host)
    if (!c.ok && c.why === "invalid") return notFound()
    const stamp = c.ok ? c.stamp : (c as { stamp: StampPayload }).stamp
    if (!portalOk(stamp)) return notFound()
    const portalOrigin = `https://${stamp.portal}`
    if (!c.ok) return render(pageVars(host, stamp, "expired"), portalOrigin, 404)
    // The first browser to open it claims it; nobody else can use it afterwards
    const had = readCookie(req.headers.get("cookie"), CEREMONY_COOKIE)
    const cookie = isCookieValue(had) ? had : newCookieValue()
    const claim = d.tickets.claim(c.jti, sha256b64(cookie), c.expires, ownerOf(ctx.ip))
    if (claim === "elsewhere") return render(pageVars(host, stamp, "elsewhere"), portalOrigin, 404)
    // The claim couldn't be recorded: unusable here, never usable unclaimed (fail closed)
    if (claim === "busy") return render(pageVars(host, stamp, "busy"), portalOrigin, 503)
    const setCookie = cookie !== had ? `${CEREMONY_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}` : undefined
    return render(pageVars(host, stamp, "ready"), portalOrigin, 200, setCookie)
  }

  // A stamp the page may act on: usable, of this purpose and host, for a portal
  // host, and claimed by this very browser
  const usable = (req: Request, c: StampCheck): (StampCheck & { ok: true }) | null => {
    if (!c.ok || !portalOk(c.stamp)) return null
    const cookie = readCookie(req.headers.get("cookie"), CEREMONY_COOKIE)
    if (!isCookieValue(cookie) || !d.tickets.claimedBy(c.jti, sha256b64(cookie))) return null
    return c
  }

  const addressLocked = async (ip: string): Promise<Response | null> => {
    const wait = await d.addressWait(ip)
    return wait > 0 ? json({ error: "Too many failed logins from this address.", retryAfter: wait }, 429) : null
  }

  // The enroll stamp's portal login, still there, still the same account, no
  // passkey added since the stamp was made (its enroll sequence), still allowed to log in
  const enrollSession = async (s: StampPayload) => {
    const live = s.sessionId ? d.session(s.sessionId) : null
    if (!live || live.user !== s.user || live.enrollSeq !== s.seq) return null
    const users = await d.passkeys.loginUsers().catch(() => [] as string[])
    if (!users.includes(live.user)) return null
    return live
  }

  const options = async (req: Request, host: string, purpose: StampPurpose, ctx: CandyHostContext): Promise<Response> => {
    const body = await readJson(req)
    const c = usable(req, d.tickets.checkStamp(body.stamp, purpose, host))
    if (!c) return expired()
    const rp = { rpId: host, origin: `https://${host}` }
    const locked = await addressLocked(ctx.ip)
    if (locked) return locked
    if (purpose === "login") {
      const out = startPasskeyLogin(d.passkeys, { ...rp, ip: ctx.ip, bind: c.jti })
      if (!out.ok) return json(out.body, out.status)
      return json({ challengeId: out.challengeId, publicKey: out.publicKey })
    }
    const live = await enrollSession(c.stamp)
    if (!live) return json({ error: ENROLL_SESSION_GONE }, 403)
    if (!mayManagePasskeys({ pamAt: c.stamp.pamAt }, d.now())) return json({ error: PASSKEY_NEEDS_PASSWORD, reauth: true }, 403)
    const out = await startRegistration(d.passkeys, { ...rp, session: { id: live.id, user: live.user, amr: live.amr, pamAt: live.pamAt }, bind: c.jti })
    if (!out.ok) return json(out.body, out.status)
    return json({ challengeId: out.challengeId, publicKey: out.publicKey })
  }

  const verify = async (req: Request, host: string, purpose: StampPurpose, ctx: CandyHostContext): Promise<Response> => {
    const body = await readJson(req)
    // Checked (and claimed by this browser) before it is used up, so a stranger can't burn someone's stamp
    if (!usable(req, d.tickets.checkStamp(body.stamp, purpose, host))) return expired()
    // The address lockout before the stamp is used up: a locked-out address can't spend stamps at all
    const locked = await addressLocked(ctx.ip)
    if (locked) return locked
    const c = usable(req, d.tickets.takeStamp(body.stamp, purpose, host))
    if (!c) return expired()
    const s = c.stamp
    const rp = { rpId: host, origin: `https://${host}` }
    if (purpose === "login") {
      const out = await attemptPasskeyLogin(d.passkeys, { challengeId: body.challengeId, credential: body.credential, ...rp, ip: ctx.ip, bind: c.jti })
      if (!out.ok) return json(out.body, out.status)
      const code = d.tickets.mintCode({ user: out.user, host, portal: s.portal, next: s.next, bind: s.bind!, credential: out.credentialId, fresh: s.fresh ?? null, by: s.by })
      // A form POST to the portal: the code never goes into a URL
      return json({ action: `https://${s.portal}/auth/passkey/finish`, fields: { [CODE_FIELD]: code } })
    }
    const live = await enrollSession(s)
    if (!live) return json({ error: ENROLL_SESSION_GONE }, 403)
    if (!mayManagePasskeys({ pamAt: s.pamAt }, d.now())) return json({ error: PASSKEY_NEEDS_PASSWORD, reauth: true }, 403)
    const out = await finishRegistration(d.passkeys, {
      challengeId: body.challengeId, credential: body.credential, name: s.name, ...rp,
      session: { id: live.id, user: live.user, amr: live.amr, pamAt: live.pamAt }, bind: c.jti,
    })
    if (!out.ok) return json(out.body, out.status)
    // Every other enroll stamp of this login is void now (it can't be flooded away: it's on the session)
    d.enrolled(live.id)
    return json({ added: true, name: out.record.name })
  }

  /** Every request for the candy host. Always an answer: nothing here falls through to the daemon. */
  const handle = async (req: Request, url: URL, ctx: CandyHostContext): Promise<Response> => {
    const host = d.host()
    const asked = (req.headers.get("host") || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
    if (!host || asked !== host) return notFound()
    const m = req.method === "HEAD" ? "GET" : req.method
    if (!CANDY_HOST_ROUTES.some(([rm, rp]) => rm === m && rp === url.pathname)) return notFound()
    const purpose: StampPurpose = url.pathname.startsWith("/passkey/enroll") ? "enroll" : "login"
    if (m === "GET") return page(req, url, host, purpose, ctx)
    // Only the page itself posts here
    if (req.headers.get("origin") !== `https://${host}`) return notFound()
    try {
      return url.pathname.endsWith("/options") ? await options(req, host, purpose, ctx) : await verify(req, host, purpose, ctx)
    } catch (e) {
      d.audit("PASSKEY_HOST_ERROR", `${url.pathname} from ${logSafe(ctx.ip)}: ${logSafe(String((e as Error)?.message ?? e))}`)
      return json({ error: "Something went wrong. Go back and try again." }, 500)
    }
  }

  return { handle }
}
