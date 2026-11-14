// Minimal WebAuthn relying party (see "B. webauthn.ts" in SDK_AUTH_DESIGN.md).
//
// Pure and WebCrypto only: no imports. It verifies passkey registrations
// (attestation "none"; other formats are accepted but their statement is
// ignored, D8) and assertions for ES256, RS256 and Ed25519. Every input comes
// from a browser and is hostile until proven otherwise, so every length is
// bounded and checked before anything is allocated: CBOR is hand-rolled and
// strict (no tags, floats or indefinite lengths), ECDSA signatures are strict
// DER, and each failed step throws a WebAuthnError naming that step.

export type CoseAlg = -7 | -257 | -8                     // ES256, RS256, EdDSA (Ed25519)
export const SUPPORTED_ALGS: readonly CoseAlg[] = [-8, -7, -257]   // preference order in pubKeyCredParams
export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const
export const CHALLENGE_BYTES = 32
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_CLIENT_DATA_BYTES = 4096
export const MAX_ATTESTATION_BYTES = 16_384
export const MAX_AUTH_DATA_BYTES = 4096
export const MAX_CREDENTIAL_ID_BYTES = 1023
export const MAX_SIGNATURE_BYTES = 1024
export const MAX_USER_HANDLE_BYTES = 64
export const MIN_RSA_BITS = 2048
export const MAX_RSA_BITS = 4096
export const CBOR_LIMITS = { maxDepth: 8, maxItems: 512, maxBytes: 16_384 } as const

export type CborValue = number | string | Uint8Array | boolean | null | CborValue[] | Map<number | string, CborValue>
export class CborError extends Error {
  constructor(message = "invalid CBOR") {
    super(message)
    this.name = "CborError"
  }
}

export type WebAuthnErrorCode =
  | "malformed" | "type" | "challenge" | "origin" | "cross_origin" | "rp_id"
  | "user_present" | "user_verified" | "credential_id" | "algorithm" | "key"
  | "signature" | "counter" | "attestation"
export class WebAuthnError extends Error {
  constructor(readonly code: WebAuthnErrorCode, message?: string) {
    super(message ?? code)
    this.name = "WebAuthnError"
  }
}

export interface ClientData { type: string; challenge: string; origin: string; crossOrigin: boolean; raw: Uint8Array }
export interface AttestedCredential { aaguid: Uint8Array; credentialId: Uint8Array; publicKey: Uint8Array /* the exact COSE bytes */ }
export interface AuthenticatorData {
  rpIdHash: Uint8Array; flags: number
  up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean
  signCount: number; attested: AttestedCredential | null; extensions: CborValue | null
}

// Browser JSON (PublicKeyCredential.toJSON() shape; every binary field is base64url)
export interface RegistrationResponseJSON {
  id: string; rawId: string; type: "public-key"
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] }
  authenticatorAttachment?: string | null; clientExtensionResults?: Record<string, unknown>
}
export interface AuthenticationResponseJSON {
  id: string; rawId: string; type: "public-key"
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null }
  authenticatorAttachment?: string | null; clientExtensionResults?: Record<string, unknown>
}
export interface CreationOptionsJSON {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: { type: "public-key"; alg: CoseAlg }[]
  timeout: number
  attestation: "none"
  authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "required" }
  excludeCredentials: { type: "public-key"; id: string; transports?: string[] }[]
  extensions: { credProps: true }
}
export interface RequestOptionsJSON {
  challenge: string; rpId: string; timeout: number
  userVerification: "required"; allowCredentials: []   // discoverable only
}
export interface RegistrationVerdict {
  credentialId: string      // b64url
  publicKey: string         // b64url of the COSE key bytes
  alg: CoseAlg
  signCount: number
  aaguid: string            // 32 lowercase hex chars
  backupEligible: boolean
  backedUp: boolean
  transports: string[]      // from the response, filtered to /^[a-z-]{1,16}$/, at most 8
}
export interface AssertionVerdict { credentialId: string; newSignCount: number; userHandle: string | null; backedUp: boolean }
export interface StoredCredentialKey { id: string; publicKey: string; alg: CoseAlg; signCount: number }

// ---------------------------------------------------------------------------
// base64url (private, strict: no padding, canonical)

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) t[B64_ALPHABET.charCodeAt(i)] = i
  return t
})()
const B64URL_RE = /^[A-Za-z0-9_-]*$/

const b64url = (bytes: Uint8Array): string => {
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64_ALPHABET[n >> 18] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63] + B64_ALPHABET[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64_ALPHABET[n >> 18] + B64_ALPHABET[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64_ALPHABET[n >> 18] + B64_ALPHABET[(n >> 12) & 63] + B64_ALPHABET[(n >> 6) & 63]
  }
  return out
}

/** Characters needed to carry `bytes` bytes, unpadded. */
const b64Chars = (bytes: number) => Math.ceil(bytes * 4 / 3)

/**
 * Strict base64url decode, or null. Only [A-Za-z0-9_-], no "=", never a
 * length of 1 mod 4, and canonical: the unused trailing bits are zero, so each
 * byte string has exactly one accepted spelling. `maxBytes` is checked on the
 * string length before decoding.
 */
const unb64url = (s: unknown, maxBytes: number): Uint8Array | null => {
  if (typeof s !== "string" || s.length > b64Chars(maxBytes) || s.length % 4 === 1 || !B64URL_RE.test(s)) return null
  const out = new Uint8Array(Math.floor(s.length * 3 / 4))
  let o = 0
  let i = 0
  for (; i + 3 < s.length; i += 4) {
    const n = (B64_INDEX[s.charCodeAt(i)] << 18) | (B64_INDEX[s.charCodeAt(i + 1)] << 12) | (B64_INDEX[s.charCodeAt(i + 2)] << 6) | B64_INDEX[s.charCodeAt(i + 3)]
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255
  }
  const rest = s.length - i
  if (rest === 2) {
    const a = B64_INDEX[s.charCodeAt(i)], b = B64_INDEX[s.charCodeAt(i + 1)]
    if (b & 15) return null
    out[o++] = (a << 2) | (b >> 4)
  } else if (rest === 3) {
    const a = B64_INDEX[s.charCodeAt(i)], b = B64_INDEX[s.charCodeAt(i + 1)], c = B64_INDEX[s.charCodeAt(i + 2)]
    if (c & 3) return null
    out[o++] = (a << 2) | (b >> 4)
    out[o++] = ((b & 15) << 4) | (c >> 2)
  }
  return out.length > maxBytes ? null : out
}

const randomB64url = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Constant-time for equal lengths; the length itself is not secret. */
const stringsEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
const utf8 = new TextEncoder()
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------------------
// CBOR (RFC 8949 subset, decode only)

type Limits = { maxDepth: number; maxItems: number; maxBytes: number }

const limitsOf = (l?: Partial<typeof CBOR_LIMITS>): Limits => {
  const out = { ...CBOR_LIMITS, ...(l ?? {}) }
  for (const k of ["maxDepth", "maxItems", "maxBytes"] as const) {
    if (!Number.isSafeInteger(out[k]) || out[k] < 0) throw new CborError(`bad limit ${k}`)
  }
  return out
}

class CborReader {
  pos: number
  items = 0
  constructor(readonly bytes: Uint8Array, start: number, readonly limits: Limits) { this.pos = start }

  private left() { return this.bytes.length - this.pos }

  private byte(): number {
    if (this.pos >= this.bytes.length) throw new CborError("truncated")
    return this.bytes[this.pos++]
  }

  /** The argument of a head with additional info `ai`: minimal, and a safe integer. */
  private argument(ai: number): number {
    if (ai < 24) return ai
    if (ai > 27) throw new CborError(ai === 31 ? "indefinite length" : "reserved additional info")
    const size = 1 << (ai - 24)                 // 1, 2, 4, 8 bytes
    if (size > this.left()) throw new CborError("truncated")
    let v = 0
    for (let i = 0; i < size; i++) v = v * 256 + this.bytes[this.pos++]
    // Above 2^53 the multiply-add loses bits; anything over MAX_SAFE_INTEGER is
    // refused either way, so the imprecision can only ever be on refused input.
    if (v > Number.MAX_SAFE_INTEGER) throw new CborError("integer too large")
    const min = ai === 24 ? 24 : ai === 25 ? 0x100 : ai === 26 ? 0x10000 : 0x100000000
    if (v < min) throw new CborError("non-minimal encoding")
    return v
  }

  private count(n: number) {
    this.items += n
    if (this.items > this.limits.maxItems) throw new CborError("too many items")
  }

  read(depth: number): CborValue {
    this.count(1)
    const head = this.byte()
    const major = head >> 5
    const ai = head & 31
    switch (major) {
      case 0: return this.argument(ai)
      case 1: {
        const n = this.argument(ai)
        const v = -1 - n
        if (!Number.isSafeInteger(v)) throw new CborError("integer too large")
        return v
      }
      case 2:
      case 3: {
        const len = this.argument(ai)
        // the bomb check: a declared length never exceeds what is actually there
        if (len > this.left()) throw new CborError("truncated")
        const start = this.pos
        this.pos += len
        if (major === 2) return this.bytes.slice(start, this.pos)
        try {
          return utf8Strict.decode(this.bytes.subarray(start, this.pos))
        } catch {
          throw new CborError("invalid UTF-8")
        }
      }
      case 4: {
        if (depth > this.limits.maxDepth) throw new CborError("too deep")
        const n = this.argument(ai)
        if (n > this.left()) throw new CborError("truncated")
        if (this.items + n > this.limits.maxItems) throw new CborError("too many items")
        const out: CborValue[] = []
        for (let i = 0; i < n; i++) out.push(this.read(depth + 1))
        return out
      }
      case 5: {
        if (depth > this.limits.maxDepth) throw new CborError("too deep")
        const n = this.argument(ai)
        if (n * 2 > this.left()) throw new CborError("truncated")
        if (this.items + n * 2 > this.limits.maxItems) throw new CborError("too many items")
        const out = new Map<number | string, CborValue>()
        for (let i = 0; i < n; i++) {
          const k = this.read(depth + 1)
          if (typeof k !== "number" && typeof k !== "string") throw new CborError("map key must be int or text")
          if (out.has(k)) throw new CborError("duplicate map key")
          out.set(k, this.read(depth + 1))
        }
        return out
      }
      case 6: throw new CborError("tags are not supported")
      default: {
        if (ai === 20) return false
        if (ai === 21) return true
        if (ai === 22) return null
        throw new CborError(ai >= 25 && ai <= 27 ? "floats are not supported" : "unsupported simple value")
      }
    }
  }
}

/** Decodes one CBOR item starting at `offset`; `end` is the offset just past it. */
export const decodeCborPrefix = (bytes: Uint8Array, offset: number, limits?: Partial<typeof CBOR_LIMITS>): { value: CborValue; end: number } => {
  if (!(bytes instanceof Uint8Array)) throw new CborError("not bytes")
  const l = limitsOf(limits)
  if (bytes.length > l.maxBytes) throw new CborError("input too large")
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) throw new CborError("truncated")
  const r = new CborReader(bytes, offset, l)
  const value = r.read(1)
  return { value, end: r.pos }
}

/** Decodes exactly one CBOR item spanning the whole input; trailing bytes are an error. */
export const decodeCbor = (bytes: Uint8Array, limits?: Partial<typeof CBOR_LIMITS>): CborValue => {
  const { value, end } = decodeCborPrefix(bytes, 0, limits)
  if (end !== bytes.length) throw new CborError("trailing bytes")
  return value
}

// ---------------------------------------------------------------------------
// authenticatorData

const AUTH_DATA_MIN = 37

/**
 * rpIdHash[32] | flags[1] | signCount[4 BE] | (AT: aaguid[16] | credIdLen[2 BE]
 * | credId | COSE key) | (ED: CBOR map). Exact length: nothing may follow.
 * `maxBytes` defaults to MAX_ATTESTATION_BYTES (registration); assertions
 * pass MAX_AUTH_DATA_BYTES.
 */
export const parseAuthenticatorData = (bytes: Uint8Array, maxBytes: number = MAX_ATTESTATION_BYTES): AuthenticatorData => {
  if (!(bytes instanceof Uint8Array) || bytes.length < AUTH_DATA_MIN || bytes.length > Math.min(maxBytes, MAX_ATTESTATION_BYTES)) {
    throw new WebAuthnError("malformed", "authenticatorData length")
  }
  const flags = bytes[32]
  const signCount = ((bytes[33] << 24) >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36]
  const at = (flags & FLAG.AT) !== 0
  const ed = (flags & FLAG.ED) !== 0
  let pos = AUTH_DATA_MIN
  let attested: AttestedCredential | null = null
  let extensions: CborValue | null = null
  try {
    if (at) {
      if (bytes.length - pos < 18) throw new WebAuthnError("malformed", "attested credential data truncated")
      const aaguid = bytes.slice(pos, pos + 16)
      const idLen = (bytes[pos + 16] << 8) | bytes[pos + 17]
      pos += 18
      if (idLen < 1 || idLen > MAX_CREDENTIAL_ID_BYTES || idLen > bytes.length - pos) {
        throw new WebAuthnError("malformed", "credential id length")
      }
      const credentialId = bytes.slice(pos, pos + idLen)
      pos += idLen
      if (pos >= bytes.length) throw new WebAuthnError("malformed", "credential public key missing")
      const { value, end } = decodeCborPrefix(bytes, pos)
      if (!(value instanceof Map)) throw new WebAuthnError("malformed", "credential public key is not a map")
      attested = { aaguid, credentialId, publicKey: bytes.slice(pos, end) }
      pos = end
    }
    if (ed) {
      if (pos >= bytes.length) throw new WebAuthnError("malformed", "extensions missing")
      const { value, end } = decodeCborPrefix(bytes, pos)
      if (!(value instanceof Map)) throw new WebAuthnError("malformed", "extensions are not a map")
      extensions = value
      pos = end
    }
  } catch (err) {
    if (err instanceof CborError) throw new WebAuthnError("malformed", `authenticatorData: ${err.message}`)
    throw err
  }
  if (pos !== bytes.length) throw new WebAuthnError("malformed", "trailing bytes in authenticatorData")
  return {
    rpIdHash: bytes.slice(0, 32), flags,
    up: (flags & FLAG.UP) !== 0, uv: (flags & FLAG.UV) !== 0,
    be: (flags & FLAG.BE) !== 0, bs: (flags & FLAG.BS) !== 0,
    at, ed, signCount, attested, extensions,
  }
}

// ---------------------------------------------------------------------------
// COSE keys

const COSE_KTY = 1, COSE_ALG = 3
const KTY_OKP = 1, KTY_EC2 = 2, KTY_RSA = 3

const bstr = (m: Map<number | string, CborValue>, label: number): Uint8Array | null => {
  const v = m.get(label)
  return v instanceof Uint8Array ? v : null
}

const bitLength = (n: Uint8Array) => n.length === 0 ? 0 : (n.length - 1) * 8 + (32 - Math.clz32(n[0]))

/**
 * A COSE_Key (RFC 9052/9053) to a JWK (EC2, RSA) or raw bytes (OKP). Throws
 * "algorithm" for anything but ES256/P-256, RS256 and EdDSA/Ed25519 (or a kty
 * that doesn't match the alg), "key" for bad or missing key material.
 */
export const parseCoseKey = (cose: Uint8Array): { alg: CoseAlg; kty: 1 | 2 | 3; jwk: JsonWebKey | null; raw: Uint8Array | null } => {
  let m: CborValue
  try {
    m = decodeCbor(cose)
  } catch {
    throw new WebAuthnError("key", "COSE key is not valid CBOR")
  }
  if (!(m instanceof Map)) throw new WebAuthnError("key", "COSE key is not a map")
  const alg = m.get(COSE_ALG)
  const kty = m.get(COSE_KTY)
  if (typeof alg !== "number") throw new WebAuthnError("algorithm", "COSE alg missing")
  if (typeof kty !== "number") throw new WebAuthnError("key", "COSE kty missing")
  if (alg === -7) {
    if (kty !== KTY_EC2) throw new WebAuthnError("algorithm", "ES256 needs kty EC2")
    if (m.get(-1) !== 1) throw new WebAuthnError("algorithm", "ES256 needs crv P-256")
    const x = bstr(m, -2), y = bstr(m, -3)
    if (!x || !y || x.length !== 32 || y.length !== 32) throw new WebAuthnError("key", "EC2 coordinates")
    return { alg, kty: KTY_EC2, jwk: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y), ext: true }, raw: null }
  }
  if (alg === -257) {
    if (kty !== KTY_RSA) throw new WebAuthnError("algorithm", "RS256 needs kty RSA")
    const n = bstr(m, -1), e = bstr(m, -2)
    if (!n || n.length < MIN_RSA_BITS / 8 || n.length > MAX_RSA_BITS / 8 || n[0] === 0) throw new WebAuthnError("key", "RSA modulus")
    const bits = bitLength(n)
    if (bits < MIN_RSA_BITS || bits > MAX_RSA_BITS) throw new WebAuthnError("key", "RSA modulus size")
    // e: 1..4 bytes, minimal, odd and at least 3 (e = 1 makes every "signature" its own message)
    if (!e || e.length < 1 || e.length > 4 || e[0] === 0 || (e[e.length - 1] & 1) === 0 || (e.length === 1 && e[0] < 3)) {
      throw new WebAuthnError("key", "RSA exponent")
    }
    return { alg, kty: KTY_RSA, jwk: { kty: "RSA", n: b64url(n), e: b64url(e), alg: "RS256", ext: true }, raw: null }
  }
  if (alg === -8) {
    if (kty !== KTY_OKP) throw new WebAuthnError("algorithm", "EdDSA needs kty OKP")
    if (m.get(-1) !== 6) throw new WebAuthnError("algorithm", "EdDSA needs crv Ed25519")
    const x = bstr(m, -2)
    if (!x || x.length !== 32) throw new WebAuthnError("key", "Ed25519 public key")
    return { alg, kty: KTY_OKP, jwk: null, raw: x }
  }
  throw new WebAuthnError("algorithm", `unsupported COSE alg ${alg}`)
}

/** parseCoseKey, then a verify-only CryptoKey. An off-curve point or a key WebCrypto refuses → "key". */
export const importCoseKey = async (cose: Uint8Array): Promise<{ alg: CoseAlg; key: CryptoKey }> => {
  const p = parseCoseKey(cose)
  try {
    if (p.alg === -7) return { alg: p.alg, key: await crypto.subtle.importKey("jwk", p.jwk!, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) }
    if (p.alg === -257) return { alg: p.alg, key: await crypto.subtle.importKey("jwk", p.jwk!, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]) }
    return { alg: p.alg, key: await crypto.subtle.importKey("raw", p.raw!, { name: "Ed25519" }, false, ["verify"]) }
  } catch {
    throw new WebAuthnError("key", "public key rejected by WebCrypto")
  }
}

// ---------------------------------------------------------------------------
// ECDSA DER → raw r‖s

/**
 * Strict DER `30 len 02 rlen r 02 slen s` to `r‖s`, each left-padded to `size`.
 * Integers are positive, minimal, non-zero and at most `size` bytes once the
 * single 00 pad is removed. Anything else → "signature".
 */
export const derToRawEcdsa = (der: Uint8Array, size = 32): Uint8Array => {
  const bad = (why: string): never => { throw new WebAuthnError("signature", `DER: ${why}`) }
  if (!(der instanceof Uint8Array) || !Number.isSafeInteger(size) || size < 1 || size > 66) bad("input")
  let pos = 0
  const len = (): number => {
    if (pos >= der.length) bad("truncated")
    const b = der[pos++]
    if (b < 0x80) return b
    if (b !== 0x81) bad("length form")             // nothing this small needs more than one length byte
    if (pos >= der.length) bad("truncated")
    const v = der[pos++]
    if (v < 0x80) bad("non-minimal length")
    return v
  }
  const int = (): Uint8Array => {
    if (pos >= der.length || der[pos++] !== 0x02) bad("expected INTEGER")
    const n = len()
    if (n < 1 || n > size + 1 || n > der.length - pos) bad("integer length")
    let v = der.subarray(pos, pos + n)
    pos += n
    if (v[0] & 0x80) bad("negative integer")
    if (v[0] === 0x00) {
      if (v.length === 1) bad("zero integer")
      if (!(v[1] & 0x80)) bad("non-minimal integer")
      v = v.subarray(1)
    }
    if (v.length > size) bad("integer too large")
    return v
  }
  if (der.length < 8 || der[pos++] !== 0x30) bad("expected SEQUENCE")
  const total = len()
  if (total !== der.length - pos) bad("sequence length")
  const r = int()
  const s = int()
  if (pos !== der.length) bad("trailing bytes")
  const out = new Uint8Array(size * 2)
  out.set(r, size - r.length)
  out.set(s, size * 2 - s.length)
  return out
}

// ---------------------------------------------------------------------------
// clientDataJSON

/**
 * Decodes and checks clientDataJSON: at most MAX_CLIENT_DATA_BYTES of strict
 * UTF-8 JSON, an object whose `type` is `type` ("type"), with string
 * `challenge` and `origin`. `crossOrigin: true` or any `topOrigin` →
 * "cross_origin" (checked here so no caller can forget it). Other members
 * (Chrome adds a decoy one) are ignored. Challenge and origin are compared by
 * the verify functions.
 */
export const parseClientData = (b64: string, type: "webauthn.create" | "webauthn.get"): ClientData => {
  const raw = unb64url(b64, MAX_CLIENT_DATA_BYTES)
  if (!raw || raw.length === 0) throw new WebAuthnError("malformed", "clientDataJSON encoding")
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Strict.decode(raw))
  } catch {
    throw new WebAuthnError("malformed", "clientDataJSON is not JSON")
  }
  if (!isRecord(parsed)) throw new WebAuthnError("malformed", "clientDataJSON is not an object")
  if (parsed.type !== type) throw new WebAuthnError("type", "clientData type")
  if (typeof parsed.challenge !== "string" || typeof parsed.origin !== "string") {
    throw new WebAuthnError("malformed", "clientData challenge/origin")
  }
  if (parsed.crossOrigin !== undefined && typeof parsed.crossOrigin !== "boolean") {
    throw new WebAuthnError("malformed", "clientData crossOrigin")
  }
  if (parsed.crossOrigin === true || Object.hasOwn(parsed, "topOrigin")) {
    throw new WebAuthnError("cross_origin", "cross-origin ceremony")
  }
  return { type: parsed.type, challenge: parsed.challenge, origin: parsed.origin, crossOrigin: false, raw }
}

// ---------------------------------------------------------------------------
// Options

export const newChallenge = (): string => randomB64url(CHALLENGE_BYTES)

const TRANSPORT_RE = /^[a-z-]{1,16}$/
const MAX_TRANSPORTS = 8
const cleanTransports = (t: unknown): string[] => {
  if (!Array.isArray(t)) return []
  const out: string[] = []
  for (const v of t) {
    if (typeof v === "string" && TRANSPORT_RE.test(v) && !out.includes(v)) out.push(v)
    if (out.length >= MAX_TRANSPORTS) break
  }
  return out
}

const timeoutOf = (ms: number | undefined) =>
  ms !== undefined && Number.isSafeInteger(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS

const needB64 = (v: unknown, min: number, max: number, what: string): string => {
  const b = unb64url(v, max)
  if (!b || b.length < min) throw new WebAuthnError("malformed", `${what} must be base64url of ${min}..${max} bytes`)
  return v as string
}
const needText = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 256) throw new WebAuthnError("malformed", `${what} must be a non-empty string`)
  return v
}

export const registrationOptions = (o: {
  rpId: string; rpName: string; userHandle: string; userName: string; displayName: string
  challenge: string; exclude: { id: string; transports?: string[] }[]; timeoutMs?: number
}): CreationOptionsJSON => ({
  rp: { id: needText(o.rpId, "rpId"), name: needText(o.rpName, "rpName") },
  user: {
    id: needB64(o.userHandle, 1, MAX_USER_HANDLE_BYTES, "userHandle"),
    name: needText(o.userName, "userName"),
    displayName: needText(o.displayName, "displayName"),
  },
  challenge: needB64(o.challenge, 16, 64, "challenge"),
  pubKeyCredParams: SUPPORTED_ALGS.map(alg => ({ type: "public-key" as const, alg })),
  timeout: timeoutOf(o.timeoutMs),
  attestation: "none",
  authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  excludeCredentials: (o.exclude ?? []).map(c => {
    const id = needB64(c.id, 1, MAX_CREDENTIAL_ID_BYTES, "exclude id")
    const transports = cleanTransports(c.transports)
    return transports.length ? { type: "public-key" as const, id, transports } : { type: "public-key" as const, id }
  }),
  extensions: { credProps: true },
})

export const authenticationOptions = (o: { rpId: string; challenge: string; timeoutMs?: number }): RequestOptionsJSON => ({
  challenge: needB64(o.challenge, 16, 64, "challenge"),
  rpId: needText(o.rpId, "rpId"),
  timeout: timeoutOf(o.timeoutMs),
  userVerification: "required",
  allowCredentials: [],
})

// ---------------------------------------------------------------------------
// Verification

const checkExpected = (i: { expectedChallenge: unknown; expectedOrigin: unknown; expectedRpId: unknown }) => {
  // caller errors, but fail closed: an empty expectation must never match
  if (typeof i.expectedChallenge !== "string" || i.expectedChallenge.length < 16) throw new WebAuthnError("challenge", "no expected challenge")
  if (typeof i.expectedOrigin !== "string" || !i.expectedOrigin) throw new WebAuthnError("origin", "no expected origin")
  if (typeof i.expectedRpId !== "string" || !i.expectedRpId) throw new WebAuthnError("rp_id", "no expected rpId")
}

/** The common shape: type, id === rawId, id canonical b64url of 1..1023 bytes. Returns the raw id. */
const checkCredentialShape = (r: unknown): { cred: Record<string, unknown>; resp: Record<string, unknown>; rawId: Uint8Array } => {
  if (!isRecord(r) || r.type !== "public-key" || typeof r.id !== "string" || typeof r.rawId !== "string" || !isRecord(r.response)) {
    throw new WebAuthnError("malformed", "credential shape")
  }
  if (r.id !== r.rawId) throw new WebAuthnError("malformed", "id and rawId differ")
  const rawId = unb64url(r.id, MAX_CREDENTIAL_ID_BYTES)
  if (!rawId || rawId.length < 1) throw new WebAuthnError("malformed", "credential id")
  return { cred: r, resp: r.response, rawId }
}

const checkClientData = (cd: ClientData, i: { expectedChallenge: string; expectedOrigin: string }) => {
  if (!stringsEqual(cd.challenge, i.expectedChallenge)) throw new WebAuthnError("challenge", "challenge mismatch")
  if (cd.origin !== i.expectedOrigin) throw new WebAuthnError("origin", "origin mismatch")
}

const checkAuthData = async (ad: AuthenticatorData, rpId: string) => {
  if (!bytesEqual(ad.rpIdHash, await sha256(utf8.encode(rpId)))) throw new WebAuthnError("rp_id", "rpIdHash mismatch")
  if (!ad.up) throw new WebAuthnError("user_present", "user not present")
  if (!ad.uv) throw new WebAuthnError("user_verified", "user not verified")
  if (ad.bs && !ad.be) throw new WebAuthnError("malformed", "backed up but not backup eligible")
}

/**
 * Verifies a navigator.credentials.create() response (toJSON shape). The
 * attestation statement is only looked at for fmt "none" (it must be empty);
 * other formats are accepted unverified (D8): we never rely on attestation.
 */
export const verifyRegistration = async (i: {
  response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string
}): Promise<RegistrationVerdict> => {
  checkExpected(i)
  // 1. shape
  const { cred, resp, rawId } = checkCredentialShape(i.response)
  if (typeof resp.clientDataJSON !== "string" || typeof resp.attestationObject !== "string") {
    throw new WebAuthnError("malformed", "response fields")
  }
  // 2. clientData
  const cd = parseClientData(resp.clientDataJSON, "webauthn.create")
  checkClientData(cd, i)
  // 3. attestation object
  const attBytes = unb64url(resp.attestationObject, MAX_ATTESTATION_BYTES)
  if (!attBytes || attBytes.length === 0) throw new WebAuthnError("malformed", "attestationObject encoding")
  let att: CborValue
  try {
    att = decodeCbor(attBytes)
  } catch (err) {
    throw new WebAuthnError("malformed", `attestationObject: ${(err as Error).message}`)
  }
  if (!(att instanceof Map) || att.size !== 3) throw new WebAuthnError("malformed", "attestationObject shape")
  const fmt = att.get("fmt"), attStmt = att.get("attStmt"), authDataBytes = att.get("authData")
  if (typeof fmt !== "string" || fmt.length < 1 || fmt.length > 32 || !(attStmt instanceof Map) || !(authDataBytes instanceof Uint8Array)) {
    throw new WebAuthnError("malformed", "attestationObject members")
  }
  if (fmt === "none" && attStmt.size !== 0) throw new WebAuthnError("attestation", "fmt none with a statement")
  // 4. authenticatorData
  const ad = parseAuthenticatorData(authDataBytes, MAX_ATTESTATION_BYTES)
  await checkAuthData(ad, i.expectedRpId)
  if (!ad.at || !ad.attested) throw new WebAuthnError("malformed", "no attested credential data")
  // 5. the credential id the authenticator bound is the one the browser reports
  if (!bytesEqual(ad.attested.credentialId, rawId)) throw new WebAuthnError("credential_id", "credential id mismatch")
  // 6. key
  const { alg } = await importCoseKey(ad.attested.publicKey)
  if (!SUPPORTED_ALGS.includes(alg)) throw new WebAuthnError("algorithm", "unsupported algorithm")
  // 7.
  return {
    credentialId: cred.id as string,
    publicKey: b64url(ad.attested.publicKey),
    alg,
    signCount: ad.signCount,
    aaguid: hex(ad.attested.aaguid),
    backupEligible: ad.be,
    backedUp: ad.bs,
    transports: cleanTransports(resp.transports),
  }
}

const isSignCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 0xffffffff

/** Verifies a navigator.credentials.get() response against a stored credential. */
export const verifyAssertion = async (i: {
  response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string
  credential: StoredCredentialKey
}): Promise<AssertionVerdict> => {
  checkExpected(i)
  const stored = i.credential
  if (!isRecord(stored) || typeof stored.id !== "string" || typeof stored.publicKey !== "string" || !isSignCount(stored.signCount)) {
    throw new WebAuthnError("key", "stored credential")
  }
  // 1. shape
  const { cred, resp } = checkCredentialShape(i.response)
  if (!stringsEqual(cred.id as string, stored.id)) throw new WebAuthnError("credential_id", "not the stored credential")
  if (typeof resp.clientDataJSON !== "string" || typeof resp.authenticatorData !== "string" || typeof resp.signature !== "string") {
    throw new WebAuthnError("malformed", "response fields")
  }
  const signature = unb64url(resp.signature, MAX_SIGNATURE_BYTES)
  if (!signature || signature.length < 1) throw new WebAuthnError("malformed", "signature encoding")
  let userHandle: string | null = null
  if (resp.userHandle !== undefined && resp.userHandle !== null) {
    const uh = unb64url(resp.userHandle, MAX_USER_HANDLE_BYTES)
    if (!uh || uh.length < 1) throw new WebAuthnError("malformed", "userHandle")
    userHandle = resp.userHandle as string
  }
  // 2. clientData
  const cd = parseClientData(resp.clientDataJSON, "webauthn.get")
  checkClientData(cd, i)
  // 3. authenticatorData
  const adBytes = unb64url(resp.authenticatorData, MAX_AUTH_DATA_BYTES)
  if (!adBytes) throw new WebAuthnError("malformed", "authenticatorData encoding")
  const ad = parseAuthenticatorData(adBytes, MAX_AUTH_DATA_BYTES)
  await checkAuthData(ad, i.expectedRpId)
  if (ad.at) throw new WebAuthnError("malformed", "attested credential data in an assertion")
  // 4. signature over authData ‖ SHA-256(clientDataJSON)
  const coseBytes = unb64url(stored.publicKey, MAX_ATTESTATION_BYTES)
  if (!coseBytes || coseBytes.length === 0) throw new WebAuthnError("key", "stored public key encoding")
  const { alg, key } = await importCoseKey(coseBytes)
  if (alg !== stored.alg) throw new WebAuthnError("key", "stored alg does not match the key")
  const signed = concat(adBytes, await sha256(cd.raw))
  let ok = false
  try {
    if (alg === -7) ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRawEcdsa(signature, 32), signed)
    else if (alg === -257) ok = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signed)
    else ok = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, signed)
  } catch (err) {
    if (err instanceof WebAuthnError) throw err
    ok = false
  }
  if (!ok) throw new WebAuthnError("signature", "bad signature")
  // 5. counter: 0/0 means "no counter" (synced passkeys); otherwise it must grow
  const n = ad.signCount
  if (!(stored.signCount === 0 && n === 0) && !(n > stored.signCount)) {
    throw new WebAuthnError("counter", `sign counter did not increase (${stored.signCount} → ${n})`)
  }
  return { credentialId: stored.id, newSignCount: n, userHandle, backedUp: ad.bs }
}
