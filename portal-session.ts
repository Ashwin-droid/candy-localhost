// Portal login sessions (see "Portal Login (PAM)" in AUTH_DESIGN.md).
//
// The browser holds a random cookie value; only its sha256 is kept, in memory
// and on disk, so a leaked session file grants nothing. Sessions end after
// `idleMs` without a request or `maxMs` after login, whichever comes first.
// The superuser flag is deliberately not stored: callers recompute it per
// request, so losing sudo takes effect without anyone logging out.
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "candy_portal"
export const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_MS = 7 * 24 * 60 * 60 * 1000
export const COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60
export const MAX_SESSIONS = 1000
/** Logins one account keeps; the oldest goes first. */
export const MAX_SESSIONS_PER_USER = 20
// lastSeen moves on every request; the file only follows it in steps this big
const SLIDE_PERSIST_MS = 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_COOKIE_LENGTH = 128
const MAX_META_LENGTH = 200
const SHA256_HEX = /^[0-9a-f]{64}$/
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/
const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i

export type SessionAmr = "pam" | "passkey"
/**
 * amr: how the login was made. pamAt: when the password was last checked for
 * this session (the login itself, or POST /auth/reauth), null for a passkey
 * login that never re-entered it. Passkey management needs a recent one.
 */
export interface PortalSession { id: string; user: string; created: number; lastSeen: number; amr: SessionAmr; pamAt: number | null }
export interface SessionOptions { idleMs?: number; maxMs?: number; now?: () => number }

// hash: sha256 of the cookie. secretHash: sha256 of the session secret the
// login page keeps in port-scoped storage and sends as X-Candy-Session.
interface Stored extends PortalSession { hash: string; secretHash: string; ip: string; ua: string; savedLastSeen: number }

const randomB64 = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
const sha256Hex = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex")
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const clip = (v: unknown) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_META_LENGTH) : ""

export class PortalSessions {
  private byHash = new Map<string, Stored>()
  private idleMs: number
  private maxMs: number
  private now: () => number

  constructor(private file: string | null, opts: SessionOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS
    this.now = opts.now ?? Date.now
    this.load()
  }

  /**
   * A new session for `user`. `cookie` goes in the HttpOnly cookie and `secret`
   * to the login page's JS; neither is stored. Both are needed for every
   * request: browsers send the portal's cookie to any port on its host, but
   * localStorage stays with the exact origin.
   */
  create(user: string, meta: { ip?: string; ua?: string } = {}, opts: { amr?: SessionAmr } = {}): { id: string; cookie: string; secret: string } {
    if (!USER_RE.test(user)) throw new Error("invalid user name")
    const amr = opts.amr ?? "pam"
    if (amr !== "pam" && amr !== "passkey") throw new Error("invalid amr")
    const now = this.now()
    const cookie = randomB64(32)
    const secret = randomB64(32)
    const s: Stored = { id: randomB64(18), user, created: now, lastSeen: now, amr, pamAt: amr === "pam" ? now : null, hash: sha256Hex(cookie), secretHash: sha256Hex(secret), ip: clip(meta.ip), ua: clip(meta.ua), savedLastSeen: now }
    this.byHash.set(s.hash, s)
    // Oldest first: Maps keep insertion order. Per user, so one account can't push everyone else out.
    let mine = 0
    for (const o of this.byHash.values()) if (o.user === user) mine++
    for (const [hash, o] of this.byHash) {
      if (mine <= MAX_SESSIONS_PER_USER) break
      if (o.user === user) { this.byHash.delete(hash); mine-- }
    }
    while (this.byHash.size > MAX_SESSIONS) this.byHash.delete(this.byHash.keys().next().value!)
    this.save()
    return { id: s.id, cookie, secret }
  }

  /**
   * The live session for a cookie value and its session secret, sliding its
   * idle timer; null when either is missing or wrong, or the session expired.
   */
  get(cookieValue: string | null | undefined, secret: string | null | undefined): PortalSession | null {
    if (typeof cookieValue !== "string" || !cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null
    if (typeof secret !== "string" || !secret || secret.length > MAX_COOKIE_LENGTH) return null
    const hash = sha256Hex(cookieValue)
    const s = this.byHash.get(hash)
    if (!s || !sameHash(s.secretHash, sha256Hex(secret))) return null
    const now = this.now()
    if (this.expired(s, now)) {
      this.byHash.delete(hash)
      this.save()
      return null
    }
    s.lastSeen = Math.max(s.lastSeen, now)
    if (s.lastSeen - s.savedLastSeen >= SLIDE_PERSIST_MS) this.save()
    return { id: s.id, user: s.user, created: s.created, lastSeen: s.lastSeen, amr: s.amr, pamAt: s.pamAt }
  }

  /**
   * The password was just checked again for this session (POST /auth/reauth):
   * pamAt = now, saved. Returns it, or null when there is no such live session.
   */
  markPam(id: string): number | null {
    const now = this.now()
    for (const s of this.byHash.values()) {
      if (s.id !== id) continue
      if (this.expired(s, now)) return null
      s.pamAt = now
      this.save()
      return now
    }
    return null
  }

  /** Whether a session id is still live (no sliding). For tying page tokens to a login. */
  alive(id: string): boolean {
    const now = this.now()
    for (const s of this.byHash.values()) if (s.id === id) return !this.expired(s, now)
    return false
  }

  destroy(id: string): boolean {
    for (const [hash, s] of this.byHash) {
      if (s.id !== id) continue
      this.byHash.delete(hash)
      this.save()
      return true
    }
    return false
  }

  /** Ends every session of `user`, e.g. when they leave the candy group. Returns how many. */
  destroyUser(user: string): number {
    let n = 0
    for (const [hash, s] of this.byHash) if (s.user === user) { this.byHash.delete(hash); n++ }
    if (n) this.save()
    return n
  }

  /** Drops expired sessions. Returns how many. */
  sweep(): number {
    const now = this.now()
    let n = 0
    for (const [hash, s] of this.byHash) if (this.expired(s, now)) { this.byHash.delete(hash); n++ }
    if (n) this.save()
    return n
  }

  list(): (PortalSession & { ip: string; ua: string })[] {
    return [...this.byHash.values()].map(({ id, user, created, lastSeen, amr, pamAt, ip, ua }) => ({ id, user, created, lastSeen, amr, pamAt, ip, ua }))
  }

  get size(): number { return this.byHash.size }

  private expired(s: Stored, now: number): boolean {
    return now - s.lastSeen >= this.idleMs || now - s.created >= this.maxMs
  }

  private load() {
    if (!this.file) return
    let raw: unknown
    try {
      // Anyone else able to write the file could plant sessions: don't trust it
      if ((statSync(this.file).mode & 0o022) !== 0) return
      raw = JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      return  // missing or corrupt: start empty
    }
    const list = (raw as { sessions?: unknown })?.sessions
    if (!Array.isArray(list)) return
    const now = this.now()
    const ids = new Set<string>()
    for (const e of list.slice(-MAX_SESSIONS)) {
      if (!e || typeof e !== "object") continue
      const r = e as Record<string, unknown>
      if (typeof r.hash !== "string" || !SHA256_HEX.test(r.hash)) continue
      // Logins from before the session secret existed can't be used any more
      if (typeof r.secretHash !== "string" || !SHA256_HEX.test(r.secretHash)) continue
      if (typeof r.id !== "string" || !ID_RE.test(r.id) || ids.has(r.id)) continue
      if (typeof r.user !== "string" || !USER_RE.test(r.user)) continue
      if (!finite(r.created) || !finite(r.lastSeen)) continue
      if (r.created > now + CLOCK_SKEW_MS || r.lastSeen > now + CLOCK_SKEW_MS || r.lastSeen < r.created) continue
      // Sessions from before amr existed were all password logins
      let amr: SessionAmr
      let pamAt: number | null
      if (r.amr === undefined) { amr = "pam"; pamAt = r.created }
      else if (r.amr === "pam" || r.amr === "passkey") {
        amr = r.amr
        if (r.pamAt === null && amr === "passkey") pamAt = null
        else if (finite(r.pamAt) && r.pamAt >= r.created && r.pamAt <= now + CLOCK_SKEW_MS) pamAt = r.pamAt
        else continue
      } else continue
      const s: Stored = { id: r.id, user: r.user, created: r.created, lastSeen: r.lastSeen, amr, pamAt, hash: r.hash, secretHash: r.secretHash, ip: clip(r.ip), ua: clip(r.ua), savedLastSeen: r.lastSeen }
      if (this.expired(s, now)) continue
      ids.add(s.id)
      this.byHash.set(s.hash, s)
    }
  }

  // Write to a private temp file, then rename over the old one: readers see the old or the new file, never half of one
  private save() {
    if (!this.file) return
    const sessions = [...this.byHash.values()].map(s => {
      s.savedLastSeen = s.lastSeen
      return { id: s.id, hash: s.hash, secretHash: s.secretHash, user: s.user, created: s.created, lastSeen: s.lastSeen, amr: s.amr, pamAt: s.pamAt, ip: s.ip, ua: s.ua }
    })
    const tmp = `${this.file}.${process.pid}.${randomB64(6)}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, JSON.stringify({ version: 2, sessions }), { mode: 0o600, flag: "wx" })
      chmodSync(tmp, 0o600)  // umask can't loosen it, but be explicit
      renameSync(tmp, this.file)
    } catch (e) {
      try { unlinkSync(tmp) } catch {}
      console.error(`\x1b[33mCould not save portal sessions to ${this.file}: ${(e as Error).message}\x1b[0m`)
    }
  }
}

/** The candy_portal cookie's value from a Cookie header, or null. */
export const readSessionCookie = (cookieHeader: string | null | undefined): string | null => {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim() || null
  }
  return null
}

export const sessionCookieHeader = (value: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`

export const clearSessionCookieHeader = (secure: boolean): string =>
  `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`
