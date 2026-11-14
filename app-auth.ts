// Delegated app login, daemon side (part D of SDK_AUTH_DESIGN.md).
//
// An app on candy sends the browser to the portal's /app-auth/authorize. That
// request is checked here (return_to must be an https address candy itself
// routes to the same site), parked under a short id, and after the user
// approves on the portal a one-shot JWE is minted with the site's own key and
// POSTed back to return_to (OIDC-style form_post).
//
// Pure logic and stores; daemon.ts wires the routes. Keys never leave the
// daemon except to the site's own process (env / LoadCredential) or to the
// owner's API key (`mayFetchSiteKey`).
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  generateKey, sealClaims, randomB64url, b64urlEncode, b64urlDecode,
  KID_RE, MAX_RING_KEYS, STATE_RE, NONCE_RE, SITE_RE, USER_RE, DEFAULT_TTL_S, KEY_BYTES,
} from "./jwe.ts"
import type { JweKey, AppClaims } from "./jwe.ts"
import { CALLBACK_PATH } from "./sdk-auth.ts"
import { SealedIds } from "./sealed-ids.ts"

export const ROTATION_OVERLAP_MS = 10 * 60_000      // a retired key stays in the ring this long
export const MAX_SITES = 2000
export const CONSENT_TTL_MS = 30 * 24 * 60 * 60_000
export const MAX_CONSENTS = 5000
export const PENDING_TTL_MS = 10 * 60_000
/** Used request ids remembered (until they expire) so each is single use */
export const MAX_PENDING_USED = 10_000
export const MAX_RETURN_TO = 2048
export const AUTHZ_BAD_RETURN = `return_to must be https://<a candy site's host>${CALLBACK_PATH}, with no port, user name, query or #fragment.`
export const AUTHZ_NOT_SITE = "That address isn't a candy site."
export const AUTHZ_SITE_MISMATCH = "return_to doesn't belong to the site that asked."
export const AUTHZ_BAD_STATE = "state must be 16 to 256 characters of A-Z, a-z, 0-9, _ or -."
export const AUTHZ_BAD_NONCE = "nonce must be 16 to 128 characters of A-Z, a-z, 0-9, _ or -."
export const AUTHZ_DUPLICATE = "Each parameter may appear only once."
export const AUTHZ_EXPIRED = "This sign-in request expired. Go back to the app and try again."
export const AUTHZ_CHANGED = "This site changed hands since it asked. Go back to the app and try again."

const MAX_SITE_LENGTH = 128
const MAX_IP_LENGTH = 64
// A host name as candy routes it: lower-case labels, no trailing dot, no port
const HOSTNAME_RE = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/
const PORTAL_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
// Control characters (C0, DEL, C1), whitespace of any kind, and backslash
const BAD_RETURN_CHARS = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff\\]/

export interface StoredKey { kid: string; key: string /* b64url */; created: number; retiredAt: number | null }
/**
 * keys[0] is current. `created` / `rotatedAt` (ms) describe the ring itself;
 * they are optional on load (older files) and always written.
 */
export interface SiteRing { owner: string; keys: StoredKey[]; created?: number; rotatedAt?: number | null }
export interface AuthorizeRequest {
  id: string; site: string; owner: string
  returnTo: string; returnHost: string
  state: string; nonce: string | null
  issuer: string            // "https://<portal host this arrived on>"
  ip: string; created: number
}
export interface FormPost { action: string; fields: Record<string, string> }
export interface SiteLookup {
  siteOfHost(host: string): string | null     // canonical site name candy routes this https host to; null for portal, shortcut, tunnel or unknown hosts
  ownerOf(site: string): string | null        // null when the name isn't in use
}
export type HostKind = "local" | "tailnet" | "domain"   // .localhost | .candy | bound domain

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0
const isSite = (s: unknown): s is string => typeof s === "string" && s.length >= 1 && s.length <= MAX_SITE_LENGTH && SITE_RE.test(s)
const isUser = (s: unknown): s is string => typeof s === "string" && USER_RE.test(s)
const randomSuffix = () => randomB64url(6)

// Write to a private temp file, then rename over the old one: readers see the
// old or the new file, never half of one. Same as PortalSessions.save.
const atomicWrite = (file: string, data: unknown, what: string) => {
  const tmp = `${file}.${process.pid}.${randomSuffix()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: "wx" })
    chmodSync(tmp, 0o600)  // umask can't loosen it, but be explicit
    renameSync(tmp, file)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    console.error(`\x1b[33mCould not save ${what} to ${file}: ${(e as Error).message}\x1b[0m`)
  }
}

// Reads a JSON state file unless its mode has any of `badBits` set or someone
// other than us owns it. "missing" = no file / unreadable / corrupt.
const readGuarded = (file: string, badBits: number): { raw: unknown } | "missing" | "unsafe" => {
  let st
  try { st = statSync(file) } catch { return "missing" }
  if ((st.mode & badBits) !== 0) return "unsafe"
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  if (uid !== null && st.uid !== uid) return "unsafe"
  try { return { raw: JSON.parse(readFileSync(file, "utf8")) } } catch { return "missing" }
}

const decodeKey = (b64: string): Uint8Array | null => {
  try {
    const k = b64urlDecode(b64)
    return k.length === KEY_BYTES ? k : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Site keys

export class AppKeyStore {
  private bySite = new Map<string, SiteRing>()
  private now: () => number
  private overlapMs: number
  private _discarded = false

  constructor(private file: string | null, opts: { now?: () => number; overlapMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.overlapMs = opts.overlapMs ?? ROTATION_OVERLAP_MS
    this.load()
  }

  /** true when load found a file readable or writable by group/other (or not ours) and threw it away */
  get discarded(): boolean { return this._discarded }

  /**
   * The site's live ring, creating it when missing. When the stored ring
   * belongs to another owner the whole ring is replaced (`created` and
   * `replaced` both true): a name reused by another unix user must not
   * inherit keys. Throws on an invalid site/owner or past MAX_SITES.
   */
  ensure(site: string, owner: string): { ring: JweKey[]; created: boolean; replaced: boolean } {
    if (!isSite(site)) throw new Error("invalid site name")
    if (!isUser(owner)) throw new Error("invalid owner")
    const existing = this.bySite.get(site)
    if (existing && existing.owner === owner) {
      return { ring: this.live(existing), created: false, replaced: false }
    }
    if (!existing && this.bySite.size >= MAX_SITES) throw new Error("too many sites with auth keys")
    const r = this.freshRing(owner)
    this.bySite.set(site, r)
    this.save()
    return { ring: toRing(r), created: true, replaced: !!existing }
  }

  /** Live keys, current first. Prunes keys retired more than overlapMs ago. null if missing or another owner's. */
  ring(site: string, owner: string): JweKey[] | null {
    const r = this.bySite.get(site)
    if (!r || r.owner !== owner) return null
    return this.live(r)
  }

  current(site: string, owner: string): JweKey | null {
    return this.ring(site, owner)?.[0] ?? null
  }

  /**
   * A new current key; the previous current one is retired now and stays
   * accepted for overlapMs. At most MAX_RING_KEYS kept. A missing ring, or one
   * owned by someone else, is replaced by a fresh one (the same as `ensure`
   * would do): the result is always a ring owned by `owner`.
   */
  rotate(site: string, owner: string): JweKey[] {
    const r = this.bySite.get(site)
    if (!r || r.owner !== owner) {
      this.ensure(site, owner)
      return this.ring(site, owner)!
    }
    const now = this.now()
    this.prune(r, now)
    const old = r.keys.map(k => k.retiredAt === null ? { ...k, retiredAt: now } : k)
    const fresh = generateKey()
    r.keys = [{ kid: fresh.kid, key: b64urlEncode(fresh.key), created: now, retiredAt: null }, ...old.filter(k => k.kid !== fresh.kid)].slice(0, MAX_RING_KEYS)
    r.rotatedAt = now
    this.save()
    return toRing(r)
  }

  drop(site: string): boolean {
    const had = this.bySite.delete(site)
    if (had) this.save()
    return had
  }

  info(site: string): { owner: string; kid: string; created: number; rotatedAt: number | null } | null {
    const r = this.bySite.get(site)
    if (!r) return null
    return { owner: r.owner, kid: r.keys[0].kid, created: r.created ?? r.keys[0].created, rotatedAt: r.rotatedAt ?? null }
  }

  sites(): string[] { return [...this.bySite.keys()].sort() }

  get size(): number { return this.bySite.size }

  private freshRing(owner: string): SiteRing {
    const now = this.now()
    const k = generateKey()
    return { owner, created: now, rotatedAt: null, keys: [{ kid: k.kid, key: b64urlEncode(k.key), created: now, retiredAt: null }] }
  }

  private prune(r: SiteRing, now: number): boolean {
    const before = r.keys.length
    r.keys = r.keys.filter(k => k.retiredAt === null || now - k.retiredAt <= this.overlapMs)
    return r.keys.length !== before
  }

  private live(r: SiteRing): JweKey[] {
    if (this.prune(r, this.now())) this.save()
    return toRing(r)
  }

  private load() {
    if (!this.file) return
    const got = readGuarded(this.file, 0o077)
    if (got === "unsafe") {
      // The keys may have been read by someone else: never use them
      this._discarded = true
      return
    }
    if (got === "missing") return
    const sites = (got.raw as { sites?: unknown })?.sites
    if (!sites || typeof sites !== "object" || Array.isArray(sites)) return
    const now = this.now()
    for (const [site, v] of Object.entries(sites as Record<string, unknown>)) {
      if (this.bySite.size >= MAX_SITES) break
      if (!isSite(site)) continue
      const r = parseRing(v)
      if (!r) continue
      this.prune(r, now)
      this.bySite.set(site, r)
    }
  }

  private save() {
    if (!this.file) return
    const sites: Record<string, SiteRing> = {}
    for (const [site, r] of this.bySite) sites[site] = { owner: r.owner, created: r.created ?? r.keys[0].created, rotatedAt: r.rotatedAt ?? null, keys: r.keys }
    atomicWrite(this.file, { version: 1, sites }, "app auth keys")
  }
}

// A retired key carries its retirement time (unix s): the SDK accepts it only
// for tokens issued before then, so a leaked key stops working everywhere
// within a token lifetime of a rotation, however long an app keeps its ring
const toRing = (r: SiteRing): JweKey[] => r.keys.map(k => ({
  kid: k.kid, key: decodeKey(k.key)!, ...(k.retiredAt !== null ? { retired: Math.floor(k.retiredAt / 1000) } : {}),
}))

// A stored ring, or null when anything about it is off
const parseRing = (v: unknown): SiteRing | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!isUser(o.owner)) return null
  if (!Array.isArray(o.keys) || o.keys.length < 1 || o.keys.length > MAX_RING_KEYS) return null
  const kids = new Set<string>()
  const keys: StoredKey[] = []
  for (let i = 0; i < o.keys.length; i++) {
    const e = o.keys[i] as Record<string, unknown> | null
    if (!e || typeof e !== "object") return null
    if (typeof e.kid !== "string" || !KID_RE.test(e.kid) || kids.has(e.kid)) return null
    if (typeof e.key !== "string" || !decodeKey(e.key)) return null
    if (!finite(e.created)) return null
    // Only the current key is unretired
    if (i === 0 ? e.retiredAt !== null : !finite(e.retiredAt)) return null
    kids.add(e.kid)
    keys.push({ kid: e.kid, key: e.key, created: e.created, retiredAt: e.retiredAt as number | null })
  }
  const created = finite(o.created) ? o.created : keys[0].created
  const rotatedAt = finite(o.rotatedAt) ? o.rotatedAt : null
  return { owner: o.owner, keys, created, rotatedAt }
}

// ---------------------------------------------------------------------------
// Remembered consent: per user + site, and only while the site has the same owner

interface Consent { user: string; site: string; owner: string; at: number }

export class ConsentStore {
  private byKey = new Map<string, Consent>()
  private now: () => number
  private ttlMs: number

  constructor(private file: string | null, opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? CONSENT_TTL_MS
    this.load()
  }

  /** Same owner as when given, and younger than the ttl. */
  has(user: string, site: string, owner: string): boolean {
    const c = this.byKey.get(keyOf(user, site))
    if (!c || c.owner !== owner) return false
    return this.fresh(c, this.now())
  }

  /** Refreshes `at` (and the owner); the oldest beyond MAX_CONSENTS goes. */
  remember(user: string, site: string, owner: string): void {
    if (!isUser(user)) throw new Error("invalid user")
    if (!isSite(site)) throw new Error("invalid site name")
    if (!isUser(owner)) throw new Error("invalid owner")
    const k = keyOf(user, site)
    this.byKey.delete(k)  // re-insert so Map order stays oldest first
    this.byKey.set(k, { user, site, owner, at: this.now() })
    while (this.byKey.size > MAX_CONSENTS) this.byKey.delete(this.byKey.keys().next().value!)
    this.save()
  }

  revoke(user: string, site: string): boolean {
    const had = this.byKey.delete(keyOf(user, site))
    if (had) this.save()
    return had
  }

  dropSite(site: string): number {
    return this.dropWhere(c => c.site === site)
  }

  dropUser(user: string): number {
    return this.dropWhere(c => c.user === user)
  }

  /** The user's live consents, oldest first. */
  list(user: string): { site: string; owner: string; at: number }[] {
    const now = this.now()
    return [...this.byKey.values()].filter(c => c.user === user && this.fresh(c, now)).map(({ site, owner, at }) => ({ site, owner, at }))
  }

  get size(): number { return this.byKey.size }

  private fresh(c: Consent, now: number): boolean {
    return now - c.at < this.ttlMs
  }

  private dropWhere(f: (c: Consent) => boolean): number {
    let n = 0
    for (const [k, c] of this.byKey) if (f(c)) { this.byKey.delete(k); n++ }
    if (n) this.save()
    return n
  }

  private load() {
    if (!this.file) return
    // Anyone else able to write the file could plant consents: don't trust it
    const got = readGuarded(this.file, 0o022)
    if (got === "missing" || got === "unsafe") return
    const list = (got.raw as { consents?: unknown })?.consents
    if (!Array.isArray(list)) return
    const now = this.now()
    const all: Consent[] = []
    for (const e of list) {
      if (!e || typeof e !== "object") continue
      const r = e as Record<string, unknown>
      if (!isUser(r.user) || !isSite(r.site) || !isUser(r.owner) || !finite(r.at)) continue
      if (r.at > now + 5 * 60_000) continue   // from the future: clock trouble or tampering
      const c: Consent = { user: r.user, site: r.site, owner: r.owner, at: r.at }
      if (!this.fresh(c, now)) continue
      all.push(c)
    }
    // Oldest first; a later entry for the same user + site wins
    all.sort((a, b) => a.at - b.at)
    for (const c of all) {
      const k = keyOf(c.user, c.site)
      this.byKey.delete(k)
      this.byKey.set(k, c)
    }
    while (this.byKey.size > MAX_CONSENTS) this.byKey.delete(this.byKey.keys().next().value!)
  }

  private save() {
    if (!this.file) return
    atomicWrite(this.file, { version: 1, consents: [...this.byKey.values()] }, "app auth consents")
  }
}

const keyOf = (user: string, site: string) => `${user}\n${site}`

// ---------------------------------------------------------------------------
// Parked authorize requests: stateless (sealed-ids.ts)
//
// The parked request is its own id, sealed with a key only this process has.
// Parking stores nothing, so no number of parks (a curl loop, or <img> tags on
// any web page, all arriving as loopback through Caddy) can push out anyone
// else's request. Only taken ids are remembered, until they expire.

type ParkedPayload = Omit<AuthorizeRequest, "id">

export class PendingRequests {
  private ids: SealedIds<ParkedPayload>
  private now: () => number
  private ttlMs: number

  constructor(opts: { now?: () => number; ttlMs?: number; maxUsed?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? PENDING_TTL_MS
    this.ids = new SealedIds<ParkedPayload>("candy app-auth pending v1", { now: this.now, maxUsed: opts.maxUsed ?? MAX_PENDING_USED })
  }

  /** The request, sealed into a fresh id. Stores nothing. */
  park(r: Omit<AuthorizeRequest, "id" | "created">): AuthorizeRequest {
    const created = this.now()
    const p: ParkedPayload = {
      site: r.site, owner: r.owner, returnTo: r.returnTo, returnHost: r.returnHost,
      state: r.state, nonce: r.nonce, issuer: r.issuer, ip: String(r.ip).slice(0, MAX_IP_LENGTH), created,
    }
    return { id: this.ids.seal(p, created + this.ttlMs), ...p }
  }

  /** Does not consume. null if not ours, used, or expired. */
  get(id: unknown): AuthorizeRequest | null {
    const o = this.ids.open(id)
    if (!o || this.ids.expired(o) || this.ids.isUsed(o.jti)) return null
    return toRequest(id as string, o.payload)
  }

  /** Single use: gone after this, whatever the outcome. */
  take(id: unknown): AuthorizeRequest | null {
    const o = this.ids.open(id)
    if (!o || this.ids.isUsed(o.jti)) return null
    this.ids.markUsed(o.jti, o.expires)
    if (this.ids.expired(o)) return null
    return toRequest(id as string, o.payload)
  }

  /** Forgets used ids that expired. */
  sweep(): number { return this.ids.sweep() }

  /** Used ids still remembered. */
  get size(): number { return this.ids.usedCount }
}

const toRequest = (id: string, p: ParkedPayload): AuthorizeRequest | null => {
  if (!p || typeof p !== "object" || !isSite(p.site) || !isUser(p.owner) || typeof p.returnTo !== "string") return null
  return {
    id, site: p.site, owner: p.owner, returnTo: p.returnTo, returnHost: p.returnHost,
    state: p.state, nonce: p.nonce ?? null, issuer: p.issuer, ip: p.ip, created: p.created,
  }
}

// ---------------------------------------------------------------------------
// Request checks

type AuthorizeOk = { ok: true; site: string; owner: string; returnTo: string; returnHost: string; state: string; nonce: string | null }
type AuthorizeFail = { ok: false; status: 400 | 404; error: string }

/**
 * Checks GET /app-auth/authorize. return_to must be exactly
 * https://<host>/_candy/auth/callback (default port, no userinfo, query or
 * fragment) on a host candy routes to an existing site; the stored returnTo
 * is the normalized `url.href`.
 */
export const validateAuthorize = (params: URLSearchParams, look: SiteLookup): AuthorizeOk | AuthorizeFail => {
  for (const k of ["return_to", "state", "nonce", "site"]) {
    if (params.getAll(k).length > 1) return { ok: false, status: 400, error: AUTHZ_DUPLICATE }
  }
  const raw = params.get("return_to")
  const bad: AuthorizeFail = { ok: false, status: 400, error: AUTHZ_BAD_RETURN }
  if (raw === null || raw.length === 0 || raw.length > MAX_RETURN_TO) return bad
  // Literal https:// and no characters that URL parsers drop, fold or disagree on
  if (!/^https:\/\//i.test(raw) || BAD_RETURN_CHARS.test(raw)) return bad
  let url: URL
  try { url = new URL(raw) } catch { return bad }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") return bad
  if (raw.includes("#")) return bad   // an empty fragment ("…#") leaves url.hash empty
  const host = url.hostname
  if (!HOSTNAME_RE.test(host)) return bad   // IPv6 literals, trailing dots, odd characters
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf(".") + 1))) return bad   // IPv4 literal: never a candy site
  if (url.href.length > MAX_RETURN_TO) return bad
  // Exactly the SDK's callback (an OAuth-style exact redirect match): a token
  // POSTed to any other path of the site could be leaked by whatever is there
  // (a 307 to elsewhere, a proxy, a page that echoes its body)
  if (url.href !== `https://${host}${CALLBACK_PATH}` || raw.includes("?")) return bad

  const notSite: AuthorizeFail = { ok: false, status: 404, error: AUTHZ_NOT_SITE }
  const site = look.siteOfHost(host)
  if (!isSite(site)) return notSite
  const owner = look.ownerOf(site)
  if (!isUser(owner)) return notSite

  const asked = params.get("site")
  if (asked !== null && asked !== site) return { ok: false, status: 400, error: AUTHZ_SITE_MISMATCH }

  const state = params.get("state")
  if (state === null || !STATE_RE.test(state)) return { ok: false, status: 400, error: AUTHZ_BAD_STATE }
  const nonce = params.get("nonce")
  if (nonce !== null && !NONCE_RE.test(nonce)) return { ok: false, status: 400, error: AUTHZ_BAD_NONCE }

  return { ok: true, site, owner, returnTo: url.href, returnHost: host, state, nonce }
}

/**
 * Re-checks a parked request just before minting: the site must still be
 * owned by whoever owned it when the app asked, and return_to's host must
 * still route to it.
 */
export const recheckRequest = (r: AuthorizeRequest, look: SiteLookup): { ok: true } | { ok: false; status: 404 | 409; error: string } => {
  const owner = look.ownerOf(r.site)
  if (owner === null) return { ok: false, status: 404, error: AUTHZ_EXPIRED }
  if (owner !== r.owner) return { ok: false, status: 409, error: AUTHZ_CHANGED }
  const site = look.siteOfHost(r.returnHost)
  if (site === null) return { ok: false, status: 404, error: AUTHZ_EXPIRED }
  if (site !== r.site) return { ok: false, status: 409, error: AUTHZ_CHANGED }
  return { ok: true }
}

/** The one-shot login assertion for `req.site`, sealed with that site's key. */
export const mintAppToken = async (o: {
  req: AuthorizeRequest; user: string; amr: "pam" | "passkey"; sessionCreated: number /* ms */
  key: JweKey; now: number /* ms */; ttlS?: number
}): Promise<{ token: string; claims: AppClaims }> => {
  if (o.amr !== "pam" && o.amr !== "passkey") throw new Error("invalid amr")
  const iat = Math.floor(o.now / 1000)
  const claims: AppClaims = {
    iss: o.req.issuer,
    aud: o.req.site,
    sub: o.user,
    amr: [o.amr],
    iat,
    exp: iat + (o.ttlS ?? DEFAULT_TTL_S),
    auth_time: Math.floor(o.sessionCreated / 1000),
    jti: randomB64url(16),
    state: o.req.state,
    ...(o.req.nonce !== null ? { nonce: o.req.nonce } : {}),
    dest: o.req.returnTo,
  }
  const token = await sealClaims(claims, o.key)   // validates the claims' shape first
  return { token, claims }
}

export const successReturn = (r: AuthorizeRequest, token: string): FormPost =>
  ({ action: r.returnTo, fields: { candy_token: token, state: r.state } })

export const errorReturn = (r: AuthorizeRequest, error: "access_denied"): FormPost => {
  if (error !== "access_denied") throw new Error("unsupported error")
  return { action: r.returnTo, fields: { error, state: r.state } }
}

export const hostKind = (host: string): HostKind => {
  const h = host.toLowerCase().replace(/\.$/, "")
  if (h === "localhost" || h.endsWith(".localhost")) return "local"
  if (h === "candy" || h.endsWith(".candy")) return "tailnet"
  return "domain"
}

/** What the consent page shows (its CANDY_VARS). Never contains the state, nonce or any key. */
export const consentView = (r: AuthorizeRequest, user: string, remembered: boolean, amr: "pam" | "passkey") => ({
  request: r.id,
  site: r.site,
  owner: r.owner,
  ownerIsYou: r.owner === user,
  user,
  returnHost: r.returnHost,
  returnOrigin: new URL(r.returnTo).origin,
  hostKind: hostKind(r.returnHost),
  remembered,
  amr,
})

/**
 * Who may fetch a site's key ring through /sdk/auth/keys: its owner's API key
 * only. Never a portal login (keys never reach a browser), never an OAuth
 * token, no superuser override.
 */
export const mayFetchSiteKey = (auth: { user: string; via: "portal" | "apikey" | "oauth" } | null, owner: string): boolean =>
  !!auth && auth.via === "apikey" && typeof auth.user === "string" && isUser(owner) && auth.user === owner

/** Accepted issuers for the SDK: "https://<host>" per portal host, lower case, deduped. Hosts with a port, path or odd characters are skipped. */
export const issuersFor = (portalHosts: readonly string[]): string[] => {
  const out: string[] = []
  for (const h of portalHosts) {
    if (typeof h !== "string") continue
    const host = h.trim().toLowerCase().replace(/\.$/, "")
    if (!host || host.length > 253 || !PORTAL_HOST_RE.test(host)) continue
    const iss = "https://" + host
    if (!out.includes(iss)) out.push(iss)
  }
  return out
}
