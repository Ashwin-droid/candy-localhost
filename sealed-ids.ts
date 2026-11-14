// Stateless one-shot ids. The record itself is the id: JSON sealed with
// AES-256-GCM under a key that lives only in this process, so nobody can read
// or forge one, and issuing one stores nothing. Only ids that were used are
// remembered (until they expire), which makes them single use.
//
// Used for parked "Sign in with candy" requests (app-auth.ts) and WebAuthn
// challenges (passkey-store.ts): a flood of new ones can't push out anyone
// else's, because there is no table of pending ones to push them out of.
// A daemon restart forgets the key, and every outstanding id with it.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const IV_BYTES = 12
const TAG_BYTES = 16
const JTI_BYTES = 12
const B64URL_RE = /^[A-Za-z0-9_-]+$/
export const DEFAULT_MAX_ID_CHARS = 4096
export const DEFAULT_MAX_USED = 10_000

export interface Opened<T> { jti: string; expires: number; payload: T }

export class SealedIds<T> {
  private key: Buffer
  private aad: Buffer
  private used = new Map<string, number>()   // jti -> expires (ms)
  private now: () => number
  private maxUsed: number
  private maxChars: number

  /** `context` separates the uses: an id sealed for one never opens in another. */
  constructor(context: string, opts: { now?: () => number; maxUsed?: number; maxChars?: number; key?: Uint8Array } = {}) {
    this.key = opts.key ? Buffer.from(opts.key) : randomBytes(32)
    if (this.key.length !== 32) throw new Error("SealedIds: key must be 32 bytes")
    this.aad = Buffer.from(context, "utf8")
    this.now = opts.now ?? Date.now
    this.maxUsed = Math.max(1, opts.maxUsed ?? DEFAULT_MAX_USED)
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
    const exp = this.used.get(jti)
    return exp !== undefined && exp > this.now()
  }

  /** Remembers `jti` as used until `expires`. When full of live entries, the one expiring soonest goes. */
  markUsed(jti: string, expires: number): void {
    const now = this.now()
    if (expires <= now) return            // expired ids are refused anyway
    this.used.delete(jti)
    if (this.used.size >= this.maxUsed) this.sweep()
    if (this.used.size >= this.maxUsed) {
      let soonest: string | null = null
      let at = Infinity
      for (const [k, e] of this.used) if (e < at) { at = e; soonest = k }
      if (soonest !== null) this.used.delete(soonest)
    }
    this.used.set(jti, expires)
  }

  /** Forgets used ids that expired; how many. */
  sweep(): number {
    const now = this.now()
    let n = 0
    for (const [k, e] of this.used) if (e <= now) { this.used.delete(k); n++ }
    return n
  }

  /** How many used ids are remembered. */
  get usedCount(): number { return this.used.size }
}
