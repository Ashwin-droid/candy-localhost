// Server-to-server auth for API-mode sites on bound domains.
//
// Callers are programs, not people, so there is no login page. A request
// carries one of:
//   - the domain's password: HTTP Basic (any username) in `Authorization`,
//     or in `X-Candy-Auth` / `X-Auth-Token` as `Basic …` or as the bare password
//   - an HS256/384/512 JWT signed with the domain's JWT secret, in
//     `X-Candy-Auth` or `X-Auth-Token` (a `Bearer ` prefix is accepted)
// X-Auth-Token and X-Candy-Auth leave `Authorization` free for the app's own auth.
//
// JWT claims:
//   aud  must be (or include) "Candy API Authorization Service"
//   sub  must be "<site>.candy"
//   exp  required, in the future, at most one hour away
//   nbf  optional, not in the future
//   iat  required, not in the future, and not before the server started
//        (or, for a server that isn't running yet, at most 5 seconds old)
//   jti  optional; when present the token is single-use (replay protection)
//
// Replay protection is a Bloom filter of sha3-512(jti), one per site. It is
// cleared when the server goes down, and every token must have been issued
// after that moment, so a cleared filter can never let an old jti back in.

import { createHmac, timingSafeEqual } from "node:crypto"

export const JWT_AUDIENCE = "Candy API Authorization Service"
export const MAX_TOKEN_LIFETIME_S = 3600
export const CLOCK_SKEW_S = 5

// ----------------------------------------------------------------------------
// Bloom filter
// ----------------------------------------------------------------------------

const BLOOM_BITS = 1 << 23  // 1 MiB; ~1e-9 false positives at 100k tokens
const BLOOM_HASHES = 10     // 10 x 32-bit slices of the 64-byte digest

export class JtiBloom {
  private bits: Uint8Array | null = null
  /** Unix seconds when the filter was last cleared; tokens issued earlier are refused. */
  epoch: number

  constructor(epoch: number) {
    this.epoch = epoch
  }

  /**
   * The server went down at `downAt` (unix seconds). Forget every jti, and
   * refuse tokens issued in that second or earlier: iat has 1s resolution,
   * so a token used just before the reset could carry iat == downAt.
   */
  reset(downAt: number) {
    this.bits = null
    this.epoch = downAt + 1
  }

  private indexes(jti: string): number[] {
    const digest = new Bun.CryptoHasher("sha3-512").update(jti).digest()
    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
    const out: number[] = []
    for (let i = 0; i < BLOOM_HASHES; i++) out.push(view.getUint32(i * 4) % BLOOM_BITS)
    return out
  }

  /** Records the jti. Returns false if it was (probably) seen before. */
  claim(jti: string): boolean {
    const idx = this.indexes(jti)
    this.bits ??= new Uint8Array(BLOOM_BITS / 8)
    const bits = this.bits
    const seen = idx.every(i => (bits[i >> 3] & (1 << (i & 7))) !== 0)
    if (seen) return false
    for (const i of idx) bits[i >> 3] |= 1 << (i & 7)
    return true
  }
}

// ----------------------------------------------------------------------------
// JWT
// ----------------------------------------------------------------------------

const HMAC_ALGS: Record<string, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }

const b64urlDecode = (s: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  return Buffer.from(s, "base64url")
}

const b64urlJson = (s: string): any => {
  const buf = b64urlDecode(s)
  if (!buf) return null
  try {
    const value = JSON.parse(buf.toString("utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export interface JwtContext {
  secret: string
  site: string             // server name; sub must be `${site}.candy`
  now: number              // unix seconds
  serverStartedAt: number | null  // unix seconds, or null if the server isn't running
  bloom: JtiBloom
}

// `guess` marks failures that don't prove the caller knows the secret
// (bad signature, garbage); only those count toward brute-force lockout.
export type AuthResult = { ok: true; via: "basic" | "jwt" } | { ok: false; error: string; guess?: boolean }

export const verifyJwt = (token: string, ctx: JwtContext): AuthResult => {
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, error: "Malformed token", guess: true }
  const [h, p, s] = parts

  const header = b64urlJson(h)
  const alg = header && typeof header.alg === "string" ? HMAC_ALGS[header.alg] : undefined
  if (!alg) return { ok: false, error: "Token must be signed with HS256, HS384 or HS512", guess: true }

  const sig = b64urlDecode(s)
  const expected = createHmac(alg, ctx.secret).update(`${h}.${p}`).digest()
  if (!sig || sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return { ok: false, error: "Bad token signature", guess: true }
  }

  const claims = b64urlJson(p)
  if (!claims) return { ok: false, error: "Malformed token claims" }

  const aud = claims.aud
  if (!(aud === JWT_AUDIENCE || (Array.isArray(aud) && aud.includes(JWT_AUDIENCE)))) {
    return { ok: false, error: `aud must be "${JWT_AUDIENCE}"` }
  }
  if (claims.sub !== `${ctx.site}.candy`) {
    return { ok: false, error: `sub must be "${ctx.site}.candy"` }
  }

  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v)
  const { now } = ctx
  if (!num(claims.exp)) return { ok: false, error: "exp is required" }
  if (claims.exp <= now) return { ok: false, error: "Token expired" }
  if (claims.exp - now > MAX_TOKEN_LIFETIME_S) return { ok: false, error: "exp is more than one hour away" }
  if (claims.nbf !== undefined) {
    if (!num(claims.nbf)) return { ok: false, error: "nbf must be a number" }
    if (claims.nbf > now + CLOCK_SKEW_S) return { ok: false, error: "Token not valid yet (nbf)" }
  }

  if (!num(claims.iat)) return { ok: false, error: "iat is required" }
  if (claims.iat > now + CLOCK_SKEW_S) return { ok: false, error: "iat is in the future" }
  // Issued after the server started, or just now if this request is what starts it
  const floor = Math.max(ctx.bloom.epoch, (ctx.serverStartedAt ?? now) - CLOCK_SKEW_S)
  if (claims.iat < floor) return { ok: false, error: "Token was issued before the server started. Mint a new one." }

  if (claims.jti !== undefined) {
    if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.length > 512) {
      return { ok: false, error: "jti must be a non-empty string" }
    }
    if (!ctx.bloom.claim(claims.jti)) return { ok: false, error: "Token already used (jti)" }
  }

  return { ok: true, via: "jwt" }
}

/** Mint a token (for `candy auth token` and tests). */
export const signJwt = (claims: Record<string, unknown>, secret: string, alg: "HS256" | "HS384" | "HS512" = "HS256"): string => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
  const head = enc({ alg, typ: "JWT" })
  const body = enc(claims)
  const sig = createHmac(HMAC_ALGS[alg], secret).update(`${head}.${body}`).digest("base64url")
  return `${head}.${body}.${sig}`
}

// ----------------------------------------------------------------------------
// Reading credentials off a request
// ----------------------------------------------------------------------------

export type Credential = { kind: "basic"; password: string } | { kind: "jwt"; token: string } | null

const parseBasic = (value: string): Credential => {
  const raw = value.replace(/^Basic\s+/i, "").trim()
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8")
    const colon = decoded.indexOf(":")
    if (colon === -1) return null
    return { kind: "basic", password: decoded.slice(colon + 1) }
  } catch {
    return null
  }
}

// A JWT is three base64url parts whose first part is a JSON object
const looksLikeJwt = (value: string): boolean => {
  const parts = value.split(".")
  return parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]*$/.test(p)) && b64urlJson(parts[0]) !== null
}

const CREDENTIAL_HEADERS = ["x-candy-auth", "x-auth-token"]

export const readCredential = (headers: Headers): Credential => {
  for (const name of CREDENTIAL_HEADERS) {
    const value = headers.get(name)?.trim()
    if (!value) continue
    if (/^Basic\s/i.test(value)) return parseBasic(value)
    const bare = value.replace(/^Bearer\s+/i, "")
    return looksLikeJwt(bare) ? { kind: "jwt", token: bare } : { kind: "basic", password: value }
  }
  const authz = headers.get("authorization")?.trim()
  if (authz && /^Basic\s/i.test(authz)) return parseBasic(authz)
  return null
}

/** Headers that carry candy credentials and must not reach the app. */
export const stripCandyCredentials = (headers: Headers) => {
  for (const name of CREDENTIAL_HEADERS) headers.delete(name)
  headers.delete("x-candy-verified")
  const authz = headers.get("authorization")
  if (authz && /^Basic\s/i.test(authz.trim())) headers.delete("authorization")
}

// ----------------------------------------------------------------------------
// IP allowlists for public domains
// ----------------------------------------------------------------------------
// When a domain's allowlist is on, only listed IPs/CIDRs, Tailscale addresses
// and this machine itself get through. Refusals don't count as failed logins.

export const TAILSCALE_RANGES = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"]

const parseIpv4 = (ip: string): bigint | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = (n << 8n) | BigInt(Number(p))
  }
  return n
}

const parseIpv6 = (ip: string): bigint | null => {
  let addr = ip.toLowerCase().replace(/%.*$/, "")
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const n = parseIpv4(v4[1])
    if (n === null) return null
    addr = addr.slice(0, -v4[1].length) + `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`
  }
  const halves = addr.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail]
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

type ParsedIp = { v: 4 | 6; n: bigint }

export const parseIp = (raw: string): ParsedIp | null => {
  const ip = raw.trim().replace(/^\[|\]$/g, "")
  const v4 = parseIpv4(ip.replace(/^::ffff:/i, ""))
  if (v4 !== null) return { v: 4, n: v4 }
  const v6 = parseIpv6(ip)
  return v6 === null ? null : { v: 6, n: v6 }
}

/** Parses "1.2.3.4", "10.0.0.0/8", "2001:db8::/32". Returns null if invalid. */
export const parseCidr = (raw: string): { v: 4 | 6; base: bigint; bits: number } | null => {
  const [addr, len, extra] = raw.trim().split("/")
  if (extra !== undefined) return null
  const ip = parseIp(addr)
  if (!ip) return null
  const max = ip.v === 4 ? 32 : 128
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null
  const shift = BigInt(max - bits)
  return { v: ip.v, base: (ip.n >> shift) << shift, bits }
}

export const ipInCidr = (ip: string, cidr: string): boolean => {
  const a = parseIp(ip)
  const c = parseCidr(cidr)
  if (!a || !c || a.v !== c.v) return false
  const shift = BigInt((c.v === 4 ? 32 : 128) - c.bits)
  return (a.n >> shift) === (c.base >> shift)
}

export const isLoopback = (ip: string): boolean =>
  ipInCidr(ip, "127.0.0.0/8") || ipInCidr(ip, "::1/128")

/** Allowed if on the list, a Tailscale address, or this machine. */
export const ipAllowed = (ip: string, allowlist: string[]): boolean =>
  isLoopback(ip) || [...TAILSCALE_RANGES, ...allowlist].some(cidr => ipInCidr(ip, cidr))
