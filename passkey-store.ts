// Passkeys for portal login (see "C. passkey-store.ts" in SDK_AUTH_DESIGN.md).
//
// Three parts:
//  - PasskeyStore: the registered credentials (public keys only) and one
//    stable random user handle per unix user, in a root-only 0600 file.
//  - ChallengeStore: single-use WebAuthn challenges, memory only.
//  - The orchestrators the daemon's routes call: passkey login, registration,
//    rename and delete. Every WebAuthn call is injected (WebAuthnImpl), so
//    this module never needs webauthn.ts at runtime.
//
// A passkey only ever logs in the account it was registered for (its name
// and uid: a name reused by a new account never inherits one), only on the
// portal host (rpId) it was registered on, and only while that account is
// still allowed to log in, PAM's account checks included. Adding or deleting
// one needs a recent password login: a session that came from a passkey can't
// add more passkeys, and isn't a superuser until the password is entered again.
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { timingSafeEqual } from "node:crypto"
import { SoftLockout, logSafe } from "./portal-auth.ts"
import { SealedIds } from "./sealed-ids.ts"
import type { CoseAlg, CreationOptionsJSON, RequestOptionsJSON, RegistrationVerdict, AssertionVerdict, StoredCredentialKey } from "./webauthn.ts"

export const MAX_PER_USER_RP = 10          // passkeys per user per rpId
export const MAX_PER_USER = 25             // per user across rpIds
export const MAX_PASSKEYS = 1000           // whole store
export const MAX_NAME_LENGTH = 64
export const CHALLENGE_TTL_MS = 5 * 60_000
/** Used challenge ids remembered until they expire (challenges themselves are stateless) */
export const MAX_CHALLENGES = 10_000
export const RECENT_PAM_MS = 10 * 60_000
/** A passkey session of a sudoer is a superuser only this long after re-entering the password */
export const SUPERUSER_PAM_MS = 60 * 60_000
export const PASSKEY_FAILURE_FLOOR_MS = 1000
export const PASSKEY_FAILED = "That passkey didn't work. Try again, or log in with your password."
export const PASSKEY_SLOWED = "Too many failed passkey logins. Try again in a moment."
export const PASSKEY_NEEDS_PASSWORD = "Enter your password again to change passkeys."
export const PASSKEY_LIMIT = "You have the most passkeys allowed here. Remove one first."
export const PASSKEY_EXISTS = "That passkey is already registered."
export const PASSKEY_EXPIRED = "That request expired. Try again."
export const PASSKEY_NOT_FOUND = "No such passkey."
/** Not in the design's list: the browser's answer to a registration didn't verify. */
export const PASSKEY_INVALID = "That passkey couldn't be registered. Try again."
/** A pamAt this far in the future (clock skew) still counts; further is refused. */
export const PAM_FUTURE_SKEW_MS = 60_000

export interface PasskeyRecord {
  id: string            // credential id, b64url (unique across the store)
  user: string          // USER_RE
  uid: number           // the account's uid when it was registered: a new account with the same name doesn't get it
  rpId: string          // portal host it was registered on, e.g. "portal.localhost"
  publicKey: string     // b64url COSE bytes; public keys only, never private material
  alg: CoseAlg
  signCount: number
  name: string          // label, 1..64 printable chars
  created: number; lastUsed: number | null   // ms
  aaguid: string        // 32 hex
  backupEligible: boolean; backedUp: boolean
  transports: string[]
}
export interface PasskeyView { id: string; name: string; rpId: string; created: number; lastUsed: number | null; backedUp: boolean; alg: "ES256" | "RS256" | "EdDSA"; here: boolean }
export type ChallengeKind = "login" | "register"
export interface Challenge { id: string; challenge: string; kind: ChallengeKind; rpId: string; origin: string; key: string; sessionId: string | null; user: string | null; expires: number }
export interface WebAuthnImpl {
  newChallenge(): string
  registrationOptions(o: { rpId: string; rpName: string; userHandle: string; userName: string; displayName: string; challenge: string; exclude: { id: string; transports?: string[] }[] }): CreationOptionsJSON
  authenticationOptions(o: { rpId: string; challenge: string }): RequestOptionsJSON
  verifyRegistration(i: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string }): Promise<RegistrationVerdict>
  verifyAssertion(i: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string; credential: StoredCredentialKey }): Promise<AssertionVerdict>
}
export interface SessionAuthState { id: string; user: string; amr: "pam" | "passkey"; pamAt: number | null }

// ----------------------------------------------------------------------------
// Validation helpers
// ----------------------------------------------------------------------------

const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i     // same as portal-session.ts
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const AAGUID_RE = /^[0-9a-f]{32}$/
const TRANSPORT_RE = /^[a-z-]{1,16}$/
const MAX_TRANSPORTS = 8
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const RP_ID_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`)
const MAX_RP_ID_LENGTH = 253
const MAX_CREDENTIAL_ID_BYTES = 1023                // webauthn.ts MAX_CREDENTIAL_ID_BYTES
/** b64url of 1023 bytes is 1364 chars; anything longer is refused before a lookup. */
export const MAX_CREDENTIAL_ID_CHARS = 1400
const MAX_PUBLIC_KEY_BYTES = 2048                   // RSA-4096 COSE is ~550 bytes
const USER_HANDLE_BYTES = 32
const MAX_CHALLENGE_LENGTH = 512
const MAX_HANDLES = 10_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_SIGN_COUNT = 0xffff_ffff                  // a 4-byte counter in authData
const ALGS: readonly number[] = [-7, -257, -8]
const ALG_NAME: Record<number, PasskeyView["alg"]> = { [-7]: "ES256", [-257]: "RS256", [-8]: "EdDSA" }

const randomB64 = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const sameString = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** Canonical unpadded base64url decoding to minBytes..maxBytes; the decoded length, or -1. */
const b64urlBytes = (s: unknown, minBytes: number, maxBytes: number): number => {
  if (typeof s !== "string" || s.length === 0 || s.length > Math.ceil(maxBytes * 4 / 3) || s.length % 4 === 1 || !B64URL_RE.test(s)) return -1
  const bytes = Buffer.from(s, "base64url")
  // Canonical: unused trailing bits must be zero, so one id has one spelling
  if (bytes.toString("base64url") !== s) return -1
  return bytes.length >= minBytes && bytes.length <= maxBytes ? bytes.length : -1
}

export const isRpId = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= MAX_RP_ID_LENGTH && RP_ID_RE.test(s)

/** The only origin a portal rpId is used from: https on the default port. */
const originMatches = (rpId: string, origin: unknown): boolean => typeof origin === "string" && origin === `https://${rpId}`

const isCredentialId = (s: unknown): s is string =>
  typeof s === "string" && s.length <= MAX_CREDENTIAL_ID_CHARS && b64urlBytes(s, 1, MAX_CREDENTIAL_ID_BYTES) > 0

const isUserHandle = (s: unknown): s is string => b64urlBytes(s, USER_HANDLE_BYTES, USER_HANDLE_BYTES) === USER_HANDLE_BYTES

// Bidi overrides, line/paragraph separators: printable-looking text only
const UNSAFE_CHARS = /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu

/** A passkey label: control and bidi characters stripped, trimmed, at most 64 characters. Empty → "Passkey". */
export const cleanPasskeyName = (v: unknown): string => {
  if (typeof v !== "string") return "Passkey"
  // Bound the work first; a code point is at most 2 code units
  const s = [...v.slice(0, MAX_NAME_LENGTH * 8).replace(UNSAFE_CHARS, "").trim()].slice(0, MAX_NAME_LENGTH).join("").trim()
  return s || "Passkey"
}

const cleanTransports = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const t of v) if (typeof t === "string" && TRANSPORT_RE.test(t) && !out.includes(t) && out.length < MAX_TRANSPORTS) out.push(t)
  return out
}

/** A full, clean record from untrusted input, or null. */
const toRecord = (e: unknown): PasskeyRecord | null => {
  if (!isObject(e)) return null
  if (!isCredentialId(e.id)) return null
  if (typeof e.user !== "string" || !USER_RE.test(e.user)) return null
  if (!isUid(e.uid)) return null
  if (!isRpId(e.rpId)) return null
  if (b64urlBytes(e.publicKey, 1, MAX_PUBLIC_KEY_BYTES) < 0) return null
  if (typeof e.alg !== "number" || !ALGS.includes(e.alg)) return null
  if (!Number.isSafeInteger(e.signCount) || (e.signCount as number) < 0 || (e.signCount as number) > MAX_SIGN_COUNT) return null
  if (!finite(e.created) || e.created < 0) return null
  if (e.lastUsed !== null && (!finite(e.lastUsed) || e.lastUsed < 0)) return null
  if (typeof e.aaguid !== "string" || !AAGUID_RE.test(e.aaguid)) return null
  if (typeof e.backupEligible !== "boolean" || typeof e.backedUp !== "boolean") return null
  // Backed up without being backup-eligible is not a state WebAuthn allows
  if (e.backedUp && !e.backupEligible) return null
  const transports = cleanTransports(e.transports)
  if (!transports) return null
  return {
    id: e.id, user: e.user, uid: e.uid, rpId: e.rpId, publicKey: e.publicKey as string, alg: e.alg as CoseAlg,
    signCount: e.signCount as number, name: cleanPasskeyName(e.name), created: e.created, lastUsed: e.lastUsed as number | null,
    aaguid: e.aaguid, backupEligible: e.backupEligible, backedUp: e.backedUp, transports,
  }
}

const copy = (r: PasskeyRecord): PasskeyRecord => ({ ...r, transports: [...r.transports] })

const isUid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff_fffe

// ----------------------------------------------------------------------------
// PasskeyStore
// ----------------------------------------------------------------------------

type AddResult = { ok: true; record: PasskeyRecord } | { ok: false; error: string }

export class PasskeyStore {
  private byId = new Map<string, PasskeyRecord>()
  private handles = new Map<string, { handle: string; uid: number }>()   // user → handle, for that uid
  private handleUsers = new Map<string, string>()   // handle → user
  private now: () => number

  constructor(private file: string | null, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
    this.load()
  }

  /**
   * The account's stable WebAuthn user handle (32 random bytes, b64url),
   * created and saved on first use. A different uid under the same name is
   * another account: it gets a new handle, and the old account's passkeys go.
   */
  userHandle(user: string, uid: number): string {
    if (typeof user !== "string" || !USER_RE.test(user)) throw new Error("invalid user name")
    if (!isUid(uid)) throw new Error("invalid uid")
    const have = this.handles.get(user)
    if (have && have.uid === uid) return have.handle
    if (have) this.dropAccount(user)
    let h: string
    do h = randomB64(USER_HANDLE_BYTES)
    while (this.handleUsers.has(h))
    this.handles.set(user, { handle: h, uid })
    this.handleUsers.set(h, user)
    this.save()
    return h
  }

  /** The uid the user's handle was made for, or null. */
  handleUid(user: string): number | null {
    return this.handles.get(user)?.uid ?? null
  }

  /** The user a handle belongs to; never creates one. */
  userForHandle(handle: string): string | null {
    if (!isUserHandle(handle)) return null
    return this.handleUsers.get(handle) ?? null
  }

  get(id: string): PasskeyRecord | null {
    if (typeof id !== "string") return null
    const r = this.byId.get(id)
    return r ? copy(r) : null
  }

  /** The user's passkeys (on `rpId` when given), oldest first. */
  list(user: string, rpId?: string): PasskeyRecord[] {
    const out: PasskeyRecord[] = []
    for (const r of this.byId.values()) if (r.user === user && (rpId === undefined || r.rpId === rpId)) out.push(copy(r))
    return out.sort((a, b) => a.created - b.created)
  }

  view(r: PasskeyRecord, currentRpId: string): PasskeyView {
    return { id: r.id, name: r.name, rpId: r.rpId, created: r.created, lastUsed: r.lastUsed, backedUp: r.backedUp, alg: ALG_NAME[r.alg]!, here: r.rpId === currentRpId }
  }

  /** Throws on a record that isn't valid; PASSKEY_EXISTS / PASSKEY_LIMIT as results. */
  add(input: Omit<PasskeyRecord, "created" | "lastUsed">): AddResult {
    const r = toRecord({ ...input, created: this.now(), lastUsed: null })
    if (!r) throw new Error("invalid passkey record")
    if (this.byId.has(r.id)) return { ok: false, error: PASSKEY_EXISTS }
    if (this.atLimit(r.user, r.rpId)) return { ok: false, error: PASSKEY_LIMIT }
    this.byId.set(r.id, r)
    this.save()
    return { ok: true, record: copy(r) }
  }

  /** Whether `user` may not add one more passkey on `rpId` (per rpId, per user, or the whole store). */
  atLimit(user: string, rpId: string): boolean {
    if (this.byId.size >= MAX_PASSKEYS) return true
    let mine = 0, here = 0
    for (const r of this.byId.values()) {
      if (r.user !== user) continue
      mine++
      if (r.rpId === rpId) here++
    }
    return mine >= MAX_PER_USER || here >= MAX_PER_USER_RP
  }

  /**
   * Records a use. The counter only moves forward (strictly greater, or 0 → 0
   * for authenticators without one); anything else returns false and changes nothing.
   */
  touch(id: string, newSignCount: number, backedUp: boolean): boolean {
    const r = typeof id === "string" ? this.byId.get(id) : undefined
    if (!r) return false
    if (!Number.isSafeInteger(newSignCount) || newSignCount < 0 || newSignCount > MAX_SIGN_COUNT) return false
    if (!(newSignCount > r.signCount || (r.signCount === 0 && newSignCount === 0))) return false
    r.signCount = newSignCount
    r.backedUp = backedUp === true && r.backupEligible
    r.lastUsed = this.now()
    this.save()
    return true
  }

  /** null when there is no such passkey of that user's. */
  rename(user: string, id: string, name: string): PasskeyRecord | null {
    const r = typeof id === "string" ? this.byId.get(id) : undefined
    if (!r || r.user !== user) return null
    r.name = cleanPasskeyName(name)
    this.save()
    return copy(r)
  }

  /** Only that user's passkey. */
  remove(user: string, id: string): boolean {
    const r = typeof id === "string" ? this.byId.get(id) : undefined
    if (!r || r.user !== user) return false
    this.byId.delete(id)
    this.save()
    return true
  }

  /** Every passkey of `user`. Returns how many. The user handle stays, so it never changes. */
  removeUser(user: string): number {
    let n = 0
    for (const [id, r] of this.byId) if (r.user === user) { this.byId.delete(id); n++ }
    if (n) this.save()
    return n
  }

  /** The account is gone (or is another account now): its passkeys and its handle. Returns how many passkeys. */
  dropAccount(user: string): number {
    let n = 0
    for (const [id, r] of this.byId) if (r.user === user) { this.byId.delete(id); n++ }
    const h = this.handles.get(user)
    if (h) { this.handles.delete(user); this.handleUsers.delete(h.handle) }
    if (n || h) this.save()
    return n
  }

  /** What `user` has under any uid but `uid` (an earlier account with that name): its passkeys and handle. Returns how many passkeys. */
  dropOtherUids(user: string, uid: number): number {
    let n = 0
    for (const [id, r] of this.byId) if (r.user === user && r.uid !== uid) { this.byId.delete(id); n++ }
    const h = this.handles.get(user)
    const dropHandle = !!h && h.uid !== uid
    if (dropHandle) { this.handles.delete(user); this.handleUsers.delete(h!.handle) }
    if (n || dropHandle) this.save()
    return n
  }

  /** Every account the store knows (a handle or a passkey), with the uids it has for it. */
  accounts(): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>()
    const add = (user: string, uid: number) => { if (!out.has(user)) out.set(user, new Set()); out.get(user)!.add(uid) }
    for (const [user, h] of this.handles) add(user, h.uid)
    for (const r of this.byId.values()) add(r.user, r.uid)
    return out
  }

  get size(): number { return this.byId.size }

  private load() {
    if (!this.file) return
    let raw: unknown
    try {
      const st = statSync(this.file)
      // Anyone else able to write the file could plant a credential: don't trust it
      if (!st.isFile() || (st.mode & 0o022) !== 0 || st.size > MAX_FILE_BYTES) return
      raw = JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      return  // missing or corrupt: start empty
    }
    if (!isObject(raw)) return
    if (isObject(raw.handles)) {
      for (const [user, v] of Object.entries(raw.handles)) {
        if (this.handles.size >= MAX_HANDLES) break
        // { handle, uid }; a handle without a uid (an older file) can't be tied to an account: dropped
        if (!USER_RE.test(user) || !isObject(v) || !isUserHandle(v.handle) || !isUid(v.uid) || this.handleUsers.has(v.handle)) continue
        this.handles.set(user, { handle: v.handle, uid: v.uid })
        this.handleUsers.set(v.handle, user)
      }
    }
    if (!Array.isArray(raw.credentials)) return
    for (const e of raw.credentials) {
      if (this.byId.size >= MAX_PASSKEYS) break
      const r = toRecord(e)
      if (!r || this.byId.has(r.id) || this.atLimit(r.user, r.rpId)) continue
      this.byId.set(r.id, r)
    }
  }

  // Private temp file, then rename over the old one: readers see the old or the new file, never half of one
  private save() {
    if (!this.file) return
    const body = JSON.stringify({ version: 1, handles: Object.fromEntries(this.handles), credentials: [...this.byId.values()] })
    const tmp = `${this.file}.${process.pid}.${randomB64(6)}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, body, { mode: 0o600, flag: "wx" })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch (e) {
      try { unlinkSync(tmp) } catch {}
      console.error(`\x1b[33mCould not save passkeys to ${this.file}: ${(e as Error).message}\x1b[0m`)
    }
  }
}

// ----------------------------------------------------------------------------
// ChallengeStore
// ----------------------------------------------------------------------------

// Stateless (sealed-ids.ts): the challenge is its own id, sealed with a key
// only this process has, so issuing one stores nothing. Login challenges are
// public and every local browser is the same loopback address: with a table,
// a few calls from one local user pushed out everyone else's pending login.
// Only used ids are remembered, until they expire, so each is single use.
type ChallengePayload = Omit<Challenge, "id" | "expires">

export class ChallengeStore {
  private ids: SealedIds<ChallengePayload>
  private now: () => number
  private ttlMs: number

  constructor(opts: { now?: () => number; ttlMs?: number; maxUsed?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? CHALLENGE_TTL_MS
    this.ids = new SealedIds<ChallengePayload>("candy passkey challenge v1", { now: this.now, maxUsed: opts.maxUsed ?? MAX_CHALLENGES })
  }

  issue(c: Omit<Challenge, "id" | "expires">): Challenge {
    if (c.kind !== "login" && c.kind !== "register") throw new Error("invalid challenge kind")
    if (typeof c.challenge !== "string" || !c.challenge || c.challenge.length > MAX_CHALLENGE_LENGTH) throw new Error("invalid challenge")
    const p: ChallengePayload = { challenge: c.challenge, kind: c.kind, rpId: c.rpId, origin: c.origin, key: c.key, sessionId: c.sessionId, user: c.user }
    const expires = this.now() + this.ttlMs
    return { id: this.ids.seal(p, expires), ...p, expires }
  }

  /** Single use: any take uses it up, including one of the wrong kind or after it expired. */
  take(id: unknown, kind: ChallengeKind): Challenge | null {
    const o = this.ids.open(id)
    if (!o || this.ids.isUsed(o.jti)) return null
    this.ids.markUsed(o.jti, o.expires)
    const p = o.payload
    if (!isObject(p) || p.kind !== kind || this.ids.expired(o)) return null
    return { id: id as string, challenge: p.challenge, kind: p.kind, rpId: p.rpId, origin: p.origin, key: p.key, sessionId: p.sessionId, user: p.user, expires: o.expires }
  }

  /** Forgets used ids that expired. */
  sweep(): number { return this.ids.sweep() }

  /** Used ids still remembered. */
  get size(): number { return this.ids.usedCount }
}

// ----------------------------------------------------------------------------
// Policy helpers and orchestrators
// ----------------------------------------------------------------------------

/** A password login within the last RECENT_PAM_MS (and not from the future, past a little clock skew). */
export const mayManagePasskeys = (s: Pick<SessionAuthState, "pamAt">, now: number): boolean =>
  s.pamAt !== null && finite(s.pamAt) && now - s.pamAt <= RECENT_PAM_MS && s.pamAt - now <= PAM_FUTURE_SKEW_MS

/**
 * Whether a portal session may act as a superuser (the account still has to
 * be a sudoer). A password login may; a passkey login only within
 * SUPERUSER_PAM_MS of re-entering the password (/auth/reauth): root-level
 * actions never rest on a (possibly synced) passkey alone.
 */
export const mayActAsSuperuser = (s: Pick<SessionAuthState, "amr" | "pamAt">, now: number): boolean => {
  if (s.amr === "pam") return true
  return s.pamAt !== null && finite(s.pamAt) && now - s.pamAt <= SUPERUSER_PAM_MS && s.pamAt - now <= PAM_FUTURE_SKEW_MS
}

/** All of loopback is one address, like loginKeys in portal-auth.ts. */
export const passkeyLoginKey = (ip: string, loopback: boolean): string => loopback ? "passkey:ip:loopback" : `passkey:ip:${ip}`

export interface PasskeyDeps {
  store: PasskeyStore; challenges: ChallengeStore; webauthn: WebAuthnImpl
  soft: SoftLockout                     // its own instance, not the PAM one
  loginUsers(): Promise<string[]>
  /** The account's current uid (getent passwd), or null when there is no such account */
  uidOf(user: string): Promise<number | null>
  /** PAM's account stage for `user` (pam_acct_mgmt, no password): expired passwords, pam_access, nologin... */
  accountOk(user: string): Promise<boolean>
  isSuperuser(user: string): Promise<boolean>
  isLoopback(ip: string): boolean
  audit(action: "AUTH_LOGIN" | "AUTH_FAIL" | "PASSKEY_ADD" | "PASSKEY_DELETE" | "PASSKEY_RENAME" | "PASSKEY_COUNTER" | "PASSKEY_DROP", details: string): void
  now(): number; sleep(ms: number): Promise<void>
}

const checkPortal = (rpId: string, origin: string) => {
  // The daemon passes rpId = the portal host and origin = "https://" + host; anything else is a bug there
  if (!isRpId(rpId) || !originMatches(rpId, origin)) throw new Error("invalid passkey rpId or origin")
}

const errorCode = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code
  return typeof code === "string" ? logSafe(code) : "verify failed"
}

export const startPasskeyLogin = (d: PasskeyDeps, i: { rpId: string; origin: string; ip: string }):
  { ok: true; challengeId: string; publicKey: RequestOptionsJSON } | { ok: false; status: 429; body: { error: string; retryAfter: number } } => {
  checkPortal(i.rpId, i.origin)
  const key = passkeyLoginKey(i.ip, d.isLoopback(i.ip))
  const wait = d.soft.wait(key)
  if (wait > 0) return { ok: false, status: 429, body: { error: PASSKEY_SLOWED, retryAfter: Math.max(1, Math.ceil(wait / 1000)) } }
  const challenge = d.webauthn.newChallenge()
  const ch = d.challenges.issue({ challenge, kind: "login", rpId: i.rpId, origin: i.origin, key, sessionId: null, user: null })
  return { ok: true, challengeId: ch.id, publicKey: d.webauthn.authenticationOptions({ rpId: i.rpId, challenge }) }
}

/**
 * One passkey login. Every failure gets the same 401 body after the same
 * floor time; only the soft lockout (nothing checked) is a 429. The attempt
 * is counted before anything is checked and cleared on success, so parallel
 * attempts can't outrun the lockout.
 */
export const attemptPasskeyLogin = async (d: PasskeyDeps, i: { challengeId: unknown; credential: unknown; rpId: string; origin: string; ip: string }):
  Promise<{ ok: true; user: string; superuser: boolean; credentialId: string } | { ok: false; status: 401 | 429; body: { error: string; retryAfter?: number } }> => {
  const start = d.now()
  const key = passkeyLoginKey(i.ip, d.isLoopback(i.ip))
  const wait = d.soft.wait(key)
  if (wait > 0) return { ok: false, status: 429, body: { error: PASSKEY_SLOWED, retryAfter: Math.max(1, Math.ceil(wait / 1000)) } }
  // Synchronous with the check above: the next parallel attempt already sees this one
  d.soft.fail(key)

  let who = `(unknown) from ${logSafe(String(i.ip))}`
  const failed = async (why: string) => {
    d.audit("AUTH_FAIL", `${who} (passkey: ${why})`)
    await d.sleep(Math.max(0, start + PASSKEY_FAILURE_FLOOR_MS - d.now()))
    return { ok: false as const, status: 401 as const, body: { error: PASSKEY_FAILED } }
  }

  try {
    if (!isRpId(i.rpId) || !originMatches(i.rpId, i.origin)) return failed("bad portal host")
    const ch = d.challenges.take(i.challengeId, "login")
    if (!ch) return failed("no such challenge")
    if (ch.rpId !== i.rpId || ch.origin !== i.origin) return failed("challenge for another host")

    const id = isObject(i.credential) ? i.credential.id : undefined
    if (!isCredentialId(id)) return failed("malformed credential")
    const record = d.store.get(id)
    if (!record) return failed("unknown credential")
    who = `${logSafe(record.user)} from ${logSafe(String(i.ip))}`
    if (record.rpId !== i.rpId) return failed(`registered on ${logSafe(record.rpId)}`)

    let verdict: AssertionVerdict
    try {
      verdict = await d.webauthn.verifyAssertion({
        response: i.credential, expectedChallenge: ch.challenge, expectedOrigin: i.origin, expectedRpId: i.rpId,
        credential: { id: record.id, publicKey: record.publicKey, alg: record.alg, signCount: record.signCount },
      })
    } catch (e) {
      if (errorCode(e) === "counter") d.audit("PASSKEY_COUNTER", `${logSafe(record.user)}: credential ${record.id} counter did not move forward from ${record.signCount}, from ${logSafe(String(i.ip))}`)
      return failed(errorCode(e))
    }
    if (!verdict || verdict.credentialId !== record.id) return failed("credential id mismatch")

    // The authenticator's user handle must be this account's: a credential is never moved between users
    const handle = verdict.userHandle
    if (typeof handle !== "string" || !handle) return failed("no user handle")
    const owner = d.store.userForHandle(handle)
    if (owner === null || !sameString(owner, record.user)) return failed("user handle of another account")

    const users = await d.loginUsers().catch(() => [] as string[])
    if (!users.includes(record.user)) return failed("account may not log in")
    // The same account, not just the same name: a name reused by a new account doesn't inherit passkeys
    const uid = await d.uidOf(record.user).catch(() => null)
    if (uid === null || uid !== record.uid || d.store.handleUid(record.user) !== uid) return failed("account changed since the passkey was added")
    // What pam_acct_mgmt refuses for a password login (an expired password, pam_access, pam_time...) it refuses here too
    if (!(await d.accountOk(record.user).catch(() => false))) return failed("account check")

    if (!d.store.touch(record.id, verdict.newSignCount, verdict.backedUp)) {
      d.audit("PASSKEY_COUNTER", `${logSafe(record.user)}: credential ${record.id} counter ${record.signCount} -> ${logSafe(String(verdict.newSignCount))} from ${logSafe(String(i.ip))}`)
      return failed("counter")
    }

    d.soft.clear(key)
    const superuser = await d.isSuperuser(record.user).catch(() => false)
    d.audit("AUTH_LOGIN", `${who} (passkey ${logSafe(record.name)})${superuser ? " (superuser)" : ""}`)
    return { ok: true, user: record.user, superuser, credentialId: record.id }
  } catch {
    return failed("error")
  }
}

type Refusal<S> = { ok: false; status: S; body: { error: string; reauth?: true } }
const needsPassword = (): Refusal<403> => ({ ok: false, status: 403, body: { error: PASSKEY_NEEDS_PASSWORD, reauth: true } })

export const startRegistration = async (d: PasskeyDeps, i: { rpId: string; origin: string; session: SessionAuthState }):
  Promise<{ ok: true; challengeId: string; publicKey: CreationOptionsJSON } | Refusal<403 | 409>> => {
  checkPortal(i.rpId, i.origin)
  if (!mayManagePasskeys(i.session, d.now())) return needsPassword()
  const user = i.session.user
  const uid = await d.uidOf(user).catch(() => null)
  if (uid === null) return needsPassword()
  // Before the limit check: a handle for an older account of this name drops that account's passkeys
  const userHandle = d.store.userHandle(user, uid)
  if (d.store.atLimit(user, i.rpId)) return { ok: false, status: 409, body: { error: PASSKEY_LIMIT } }
  const challenge = d.webauthn.newChallenge()
  const ch = d.challenges.issue({ challenge, kind: "register", rpId: i.rpId, origin: i.origin, key: `session:${i.session.id}`, sessionId: i.session.id, user })
  const exclude = d.store.list(user, i.rpId).map(r => r.transports.length ? { id: r.id, transports: r.transports } : { id: r.id })
  const publicKey = d.webauthn.registrationOptions({ rpId: i.rpId, rpName: "candy", userHandle, userName: user, displayName: user, challenge, exclude })
  return { ok: true, challengeId: ch.id, publicKey }
}

export const finishRegistration = async (d: PasskeyDeps, i: { challengeId: unknown; credential: unknown; name: unknown; rpId: string; origin: string; session: SessionAuthState }):
  Promise<{ ok: true; record: PasskeyRecord } | Refusal<400 | 403 | 409>> => {
  // Checked before the challenge is taken: after a re-entered password the same answer can still be sent
  if (!mayManagePasskeys(i.session, d.now())) return needsPassword()
  const expired: Refusal<400> = { ok: false, status: 400, body: { error: PASSKEY_EXPIRED } }
  const ch = d.challenges.take(i.challengeId, "register")
  if (!ch) return expired
  if (ch.sessionId !== i.session.id || ch.user !== i.session.user || ch.rpId !== i.rpId || ch.origin !== i.origin) return expired
  if (!isRpId(i.rpId) || !originMatches(i.rpId, i.origin)) return expired

  let v: RegistrationVerdict
  try {
    v = await d.webauthn.verifyRegistration({ response: i.credential, expectedChallenge: ch.challenge, expectedOrigin: i.origin, expectedRpId: i.rpId })
  } catch {
    return { ok: false, status: 400, body: { error: PASSKEY_INVALID } }
  }
  const name = cleanPasskeyName(i.name)
  // Tied to the account the options were made for (its handle's uid)
  const uid = await d.uidOf(i.session.user).catch(() => null)
  if (uid === null || d.store.handleUid(i.session.user) !== uid) return expired
  let added: AddResult
  try {
    added = d.store.add({
      id: v.credentialId, user: i.session.user, uid, rpId: i.rpId, publicKey: v.publicKey, alg: v.alg, signCount: v.signCount,
      name, aaguid: v.aaguid, backupEligible: v.backupEligible, backedUp: v.backedUp, transports: v.transports,
    })
  } catch {
    return { ok: false, status: 400, body: { error: PASSKEY_INVALID } }
  }
  if (!added.ok) return { ok: false, status: 409, body: { error: added.error } }
  d.audit("PASSKEY_ADD", `${logSafe(i.session.user)}: ${logSafe(added.record.name)} on ${i.rpId} (credential ${added.record.id})`)
  return { ok: true, record: added.record }
}

/** The record `id` names, if the session's user may act on it (theirs, or a superuser acting for its owner). */
const ownRecord = (d: PasskeyDeps, id: unknown, user: string, superuser: boolean, actingUser?: string): PasskeyRecord | null => {
  if (!isCredentialId(id)) return null
  const r = d.store.get(id)
  if (!r) return null
  if (r.user === user) return r
  return superuser && typeof actingUser === "string" && actingUser === r.user ? r : null
}

export const deletePasskey = (d: PasskeyDeps, i: { id: unknown; session: SessionAuthState; superuser: boolean; actingUser?: string }):
  { ok: true } | Refusal<403 | 404> => {
  if (!mayManagePasskeys(i.session, d.now())) return needsPassword()
  const r = ownRecord(d, i.id, i.session.user, i.superuser, i.actingUser)
  if (!r || !d.store.remove(r.user, r.id)) return { ok: false, status: 404, body: { error: PASSKEY_NOT_FOUND } }
  const actor = r.user === i.session.user ? logSafe(r.user) : `${logSafe(i.session.user)} for ${logSafe(r.user)}`
  d.audit("PASSKEY_DELETE", `${actor}: ${logSafe(r.name)} on ${r.rpId}`)
  return { ok: true }
}

/**
 * Not in the design's list (F would call store.rename directly): a label
 * change, scoped to the session's own passkeys and audited. A label is
 * cosmetic, so it doesn't need a recent password.
 */
export const renamePasskey = (d: PasskeyDeps, i: { id: unknown; name: unknown; session: SessionAuthState }):
  { ok: true; record: PasskeyRecord } | Refusal<404> => {
  const r = ownRecord(d, i.id, i.session.user, false)
  const renamed = r && d.store.rename(i.session.user, r.id, cleanPasskeyName(i.name))
  if (!renamed) return { ok: false, status: 404, body: { error: PASSKEY_NOT_FOUND } }
  d.audit("PASSKEY_RENAME", `${logSafe(i.session.user)}: ${logSafe(r!.name)} -> ${logSafe(renamed.name)} on ${renamed.rpId}`)
  return { ok: true, record: renamed }
}

/**
 * Drops the passkeys (and handle) of every account that is gone or is now a
 * different account under the same name (its uid changed). The daemon runs
 * it periodically and when a user leaves the candy group. Returns the users dropped.
 */
export const prunePasskeyAccounts = async (d: Pick<PasskeyDeps, "store" | "uidOf" | "audit">): Promise<string[]> => {
  const dropped: string[] = []
  for (const [user, uids] of d.store.accounts()) {
    let uid: number | null
    try { uid = await d.uidOf(user) } catch { continue }   // can't tell now: keep (login checks the uid anyway)
    if (uid !== null && uids.size === 1 && uids.has(uid)) continue
    const n = uid === null ? d.store.dropAccount(user) : d.store.dropOtherUids(user, uid)
    d.audit("PASSKEY_DROP", uid === null
      ? `${logSafe(user)}: account gone, ${n} passkey(s) removed`
      : `${logSafe(user)}: ${n} passkey(s) of an earlier account with this name removed`)
    dropped.push(user)
  }
  return dropped
}
