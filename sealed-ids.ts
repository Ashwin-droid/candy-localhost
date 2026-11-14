// Stateless one-shot ids. The record itself is the id: JSON sealed with
// AES-256-GCM under a key that lives only in this process, so nobody can read
// or forge one, and issuing one stores nothing. Only ids that were used are
// remembered (until they expire), which makes them single use.
//
// Used for parked "Sign in with candy" requests (app-auth.ts) and WebAuthn
// challenges (passkey-store.ts): a flood of new ones can't push out anyone
// else's, because there is no table of pending ones to push them out of.
// A daemon restart forgets the key, and every outstanding id with it.
//
// The used set never evicts a live entry (review finding: evicting the
// soonest-expiring one let a flood of cheap ids make an earlier one usable
// again). When it is full of live entries it fails closed: markUsed returns
// false and the caller must treat the id as unusable. Each entry has an owner
// (an address, a user), and one owner may hold only a share of the set, so a
// single caller can't fill it for everyone.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const IV_BYTES = 12
const TAG_BYTES = 16
const JTI_BYTES = 12
const B64URL_RE = /^[A-Za-z0-9_-]+$/
export const DEFAULT_MAX_ID_CHARS = 4096
export const DEFAULT_MAX_USED = 10_000
/** The share of a LiveSet one owner may hold, by default */
export const DEFAULT_OWNER_SHARE = 0.05

export interface Opened<T> { jti: string; expires: number; payload: T }

export type AddResult = "ok" | "full" | "owner"

/**
 * Keys with an expiry and an owner, bounded overall and per owner. Never
 * evicts a live entry: when full (or the owner is at its share) `add` refuses.
 */
export class LiveSet<V = true> {
  private map = new Map<string, { value: V; expires: number; owner: string }>()
  private owners = new Map<string, number>()
  readonly max: number
  readonly maxPerOwner: number

  constructor(private now: () => number, max = DEFAULT_MAX_USED, maxPerOwner?: number) {
    this.max = Math.max(1, max)
    this.maxPerOwner = Math.max(1, maxPerOwner ?? Math.ceil(this.max * DEFAULT_OWNER_SHARE))
  }

  /** The live entry, or undefined. */
  get(key: string): { value: V; expires: number; owner: string } | undefined {
    const e = this.map.get(key)
    return e && e.expires > this.now() ? e : undefined
  }

  /** Adds (or keeps) a live entry. "full": no room overall; "owner": this owner holds its share. Expired entries make room first. */
  add(key: string, value: V, expires: number, owner = ""): AddResult {
    const now = this.now()
    if (expires <= now) return "ok"            // nothing to remember: it's refused anyway
    if (this.get(key)) return "ok"
    this.drop(key)
    if (this.map.size >= this.max || (this.owners.get(owner) ?? 0) >= this.maxPerOwner) this.sweep()
    if (this.map.size >= this.max) return "full"
    if ((this.owners.get(owner) ?? 0) >= this.maxPerOwner) return "owner"
    this.map.set(key, { value, expires, owner })
    this.owners.set(owner, (this.owners.get(owner) ?? 0) + 1)
    return "ok"
  }

  /** Whether `owner` could add one more right now (after forgetting expired entries). */
  room(owner = ""): AddResult {
    if (this.map.size >= this.max || (this.owners.get(owner) ?? 0) >= this.maxPerOwner) this.sweep()
    if (this.map.size >= this.max) return "full"
    if ((this.owners.get(owner) ?? 0) >= this.maxPerOwner) return "owner"
    return "ok"
  }

  private drop(key: string) {
    const e = this.map.get(key)
    if (!e) return
    this.map.delete(key)
    const n = (this.owners.get(e.owner) ?? 1) - 1
    if (n > 0) this.owners.set(e.owner, n)
    else this.owners.delete(e.owner)
  }

  /** Forgets expired entries; how many. */
  sweep(): number {
    const now = this.now()
    let n = 0
    for (const [k, e] of this.map) if (e.expires <= now) { this.drop(k); n++ }
    return n
  }

  get size(): number { return this.map.size }
}

export class SealedIds<T> {
  private key: Buffer
  private aad: Buffer
  private used: LiveSet
  private now: () => number
  private maxUsed: number
  private maxChars: number

  /** `context` separates the uses: an id sealed for one never opens in another. */
  constructor(context: string, opts: { now?: () => number; maxUsed?: number; maxPerOwner?: number; maxChars?: number; key?: Uint8Array } = {}) {
    this.key = opts.key ? Buffer.from(opts.key) : randomBytes(32)
    if (this.key.length !== 32) throw new Error("SealedIds: key must be 32 bytes")
    this.aad = Buffer.from(context, "utf8")
    this.now = opts.now ?? Date.now
    this.maxUsed = Math.max(1, opts.maxUsed ?? DEFAULT_MAX_USED)
    this.used = new LiveSet(this.now, this.maxUsed, opts.maxPerOwner)
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_ID_CHARS
  }

  /** A fresh id for `payload`, valid until `expires` (ms). Throws if it would be longer than maxChars. */
  seal(payload: T, expires: number): string {
    const iv = randomBytes(IV_BYTES)
    const c = createCipheriv("aes-256-gcm", this.key, iv)
    c.setAAD(this.aad)
    const body = Buffer.from(JSON.stringify({ j: randomBytes(JTI_BYTES).toString("base64url"), e: expires, p: payload }), "utf8")
    const ct = Buffer.concat([c.update(body), c.final()])
    const id = Buffer.concat([iv, ct, c.getAuthTag()]).toString("base64url")
    if (id.length > this.maxChars) throw new Error("SealedIds: record too large")
    return id
  }

  /** The id's record when it is ours and intact, whether or not it expired or was used. null otherwise. */
  open(id: unknown): Opened<T> | null {
    if (typeof id !== "string" || id.length === 0 || id.length > this.maxChars || !B64URL_RE.test(id)) return null
    const raw = Buffer.from(id, "base64url")
    if (raw.length < IV_BYTES + TAG_BYTES + 1 || raw.toString("base64url") !== id) return null
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES))
      d.setAAD(this.aad)
      d.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
      const plain = Buffer.concat([d.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), d.final()])
      const o = JSON.parse(plain.toString("utf8"))
      if (!o || typeof o.j !== "string" || typeof o.e !== "number" || !Number.isFinite(o.e)) return null
      return { jti: o.j, expires: o.e, payload: o.p as T }
    } catch {
      return null
    }
  }

  expired(o: Opened<T>): boolean { return this.now() >= o.expires }

  isUsed(jti: string): boolean {
    return this.used.get(jti) !== undefined
  }

  /**
   * Remembers `jti` as used until `expires`, on `owner`'s account. false when
   * that can't be recorded (full of live entries, or the owner holds its
   * share): the caller must then refuse the id, never accept it unrecorded.
   */
  markUsed(jti: string, expires: number, owner = ""): boolean {
    return this.used.add(jti, true, expires, owner) === "ok"
  }

  /** Whether `owner` could use one more id now ("ok"), or why not. For refusing to issue ids that couldn't be used. */
  room(owner = ""): AddResult { return this.used.room(owner) }

  /** Forgets used ids that expired; how many. */
  sweep(): number { return this.used.sweep() }

  /** How many used ids are remembered. */
  get usedCount(): number { return this.used.size }
}
