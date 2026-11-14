// Compact JWE for delegated app login: `dir` + `A256GCM`, WebCrypto only.
// See section A of SDK_AUTH_DESIGN.md; that section is the contract.
//
// A token is BASE64URL(header) "." "" "." BASE64URL(iv) "." BASE64URL(ct) "." BASE64URL(tag).
// The header is always exactly {"alg":"dir","enc":"A256GCM","kid":…,"typ":"JWT"},
// the AAD is the header segment as it appears in the token, and the plaintext
// is the UTF-8 JSON of AppClaims. Pure: no imports, no I/O. Imported by the
// daemon (app-auth.ts) and by apps (sdk-auth.ts, also inside function sandboxes).

export const JWE_ALG = "dir"
export const JWE_ENC = "A256GCM"
export const JWE_TYP = "JWT"
export const KEY_BYTES = 32
export const IV_BYTES = 12
export const TAG_BYTES = 16
export const MAX_TOKEN_LENGTH = 4096        // chars; checked before any decoding
export const MAX_HEADER_BYTES = 256
export const MAX_PLAINTEXT_BYTES = 2048
export const MAX_RING_KEYS = 4
export const DEFAULT_TTL_S = 60
export const MAX_TTL_S = 300               // exp - iat larger than this: rejected
export const CLOCK_SKEW_S = 30
export const KID_RE = /^[A-Za-z0-9_-]{8,32}$/
export const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i      // same as portal-session.ts
export const STATE_RE = /^[A-Za-z0-9_-]{16,256}$/
export const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
export const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/
export const SITE_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/  // daemon's SAFE_NAME; also length 1..128

const MAX_SITE_LENGTH = 128
const MAX_DEST_LENGTH = 2048
const MAX_ISS_LENGTH = 256
const MAX_RANDOM_BYTES = 1024
// Any longer and the decoded header can't fit in MAX_HEADER_BYTES
const MAX_HEADER_SEGMENT = Math.ceil(MAX_HEADER_BYTES * 4 / 3)
const B64URL_RE = /^[A-Za-z0-9_-]*$/
// C0 controls, space, DEL and backslash: never part of a URL we minted
const URL_BAD_CHAR_RE = /[\u0000- \u007f\\]/

export type Amr = "pam" | "passkey"
/**
 * key.length === 32. `retired` (unix s) is set on a key that was rotated out:
 * it opens only tokens issued (iat) at or before then, so it is useless
 * MAX_TTL_S + CLOCK_SKEW_S after the rotation, wherever a copy of the ring is.
 */
export interface JweKey { kid: string; key: Uint8Array; retired?: number }
export interface JweHeader { alg: "dir"; enc: "A256GCM"; kid: string; typ: "JWT" }
export interface AppClaims {
  iss: string          // portal origin, e.g. "https://portal.localhost"
  aud: string          // site name, e.g. "notes"
  sub: string          // unix user (USER_RE)
  amr: [Amr]           // exactly one entry
  iat: number          // unix seconds, integer
  exp: number          // unix seconds, integer, iat < exp <= iat + MAX_TTL_S
  auth_time: number    // unix seconds of the user's latest authentication (a fresh one when the app asked for max_age)
  superuser: boolean   // whether the account is a sudoer, checked when the token was made
  jti: string          // JTI_RE
  state: string        // STATE_RE, echoed from the authorize request
  nonce?: string       // NONCE_RE, echoed when the request had one
  dest: string         // the exact return_to URL (https, <= 2048 chars)
}

export type JweErrorCode =
  | "malformed" | "unsupported" | "unknown_kid" | "decrypt"
  | "expired" | "not_yet_valid" | "audience" | "issuer" | "claims"

export class JweError extends Error {
  constructor(readonly code: JweErrorCode, message?: string) {
    super(message ?? code)
    this.name = "JweError"
  }
}

// ---------------------------------------------------------------------------
// base64url (strict, canonical)

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const B64_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < B64_ALPHABET.length; i++) B64_INDEX[B64_ALPHABET.charCodeAt(i)] = i

/** base64url without padding. */
export const b64urlEncode = (bytes: Uint8Array): string => {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("b64urlEncode: expected a Uint8Array")
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

/**
 * Strict base64url: only [A-Za-z0-9_-], no padding, length % 4 !== 1, and
 * canonical (unused trailing bits are zero, so re-encoding gives the input).
 * Anything else throws JweError("malformed").
 */
export const b64urlDecode = (s: string): Uint8Array => {
  if (typeof s !== "string" || !B64URL_RE.test(s) || s.length % 4 === 1) {
    throw new JweError("malformed", "bad base64url")
  }
  const out = new Uint8Array(Math.floor(s.length * 3 / 4))
  let o = 0
  let i = 0
  for (; i + 3 < s.length; i += 4) {
    const n = (B64_INDEX[s.charCodeAt(i)] << 18) | (B64_INDEX[s.charCodeAt(i + 1)] << 12)
      | (B64_INDEX[s.charCodeAt(i + 2)] << 6) | B64_INDEX[s.charCodeAt(i + 3)]
    out[o++] = n >> 16
    out[o++] = (n >> 8) & 255
    out[o++] = n & 255
  }
  const rest = s.length - i
  if (rest === 2) {
    const a = B64_INDEX[s.charCodeAt(i)]
    const b = B64_INDEX[s.charCodeAt(i + 1)]
    if (b & 15) throw new JweError("malformed", "non-canonical base64url")
    out[o++] = (a << 2) | (b >> 4)
  } else if (rest === 3) {
    const a = B64_INDEX[s.charCodeAt(i)]
    const b = B64_INDEX[s.charCodeAt(i + 1)]
    const c = B64_INDEX[s.charCodeAt(i + 2)]
    if (c & 3) throw new JweError("malformed", "non-canonical base64url")
    out[o++] = (a << 2) | (b >> 4)
    out[o++] = ((b & 15) << 4) | (c >> 2)
  }
  return out
}

/** `bytes` random bytes from crypto.getRandomValues, base64url. */
export const randomB64url = (bytes: number): string => {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RANDOM_BYTES) {
    throw new RangeError("randomB64url: bytes must be an integer in 1..1024")
  }
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** A fresh site key: kid = 12 random base64url chars, key = 32 random bytes. */
export const generateKey = (): JweKey => ({
  kid: randomB64url(9),
  key: crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
})

// ---------------------------------------------------------------------------
// keys and rings

const checkKey = (k: JweKey, what: string): void => {
  if (!k || typeof k !== "object" || typeof k.kid !== "string" || !KID_RE.test(k.kid)) {
    throw new JweError("malformed", `${what}: bad kid`)
  }
  if (!(k.key instanceof Uint8Array) || k.key.length !== KEY_BYTES) {
    throw new JweError("malformed", `${what}: key must be ${KEY_BYTES} bytes`)
  }
  if (k.retired !== undefined && !isRetired(k.retired)) throw new JweError("malformed", `${what}: bad retired time`)
}

const MAX_RETIRED_DIGITS = 12
const isRetired = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && String(v).length <= MAX_RETIRED_DIGITS

const checkRing = (ring: readonly JweKey[], what: string): void => {
  if (!Array.isArray(ring) || ring.length < 1 || ring.length > MAX_RING_KEYS) {
    throw new JweError("malformed", `${what}: 1..${MAX_RING_KEYS} keys`)
  }
  const seen = new Set<string>()
  for (const k of ring) {
    checkKey(k, what)
    if (seen.has(k.kid)) throw new JweError("malformed", `${what}: duplicate kid`)
    seen.add(k.kid)
  }
}

/** "<kid>:<b64url key>[:<retired unix s>],…", current key first. Validates the ring first. */
export const formatKeyRing = (ring: readonly JweKey[]): string => {
  checkRing(ring, "formatKeyRing")
  return ring.map(k => `${k.kid}:${b64urlEncode(k.key)}${k.retired !== undefined ? `:${k.retired}` : ""}`).join(",")
}

/**
 * Inverse of formatKeyRing. Surrounding whitespace is trimmed; nothing else is
 * tolerated (no spaces around commas, no empty entries). Throws JweError("malformed").
 * Error messages never contain key material.
 */
export const parseKeyRing = (s: string): JweKey[] => {
  if (typeof s !== "string") throw new JweError("malformed", "key ring: not a string")
  const t = s.trim()
  // MAX_RING_KEYS entries of at most 32 + 1 + 43 + 1 + 12 chars, plus commas
  if (t.length === 0 || t.length > MAX_RING_KEYS * 89 + MAX_RING_KEYS) {
    throw new JweError("malformed", "key ring: bad length")
  }
  const parts = t.split(",")
  if (parts.length > MAX_RING_KEYS) throw new JweError("malformed", "key ring: too many keys")
  const ring: JweKey[] = []
  for (const p of parts) {
    const f = p.split(":")
    if (f.length !== 2 && f.length !== 3) throw new JweError("malformed", "key ring: bad entry")
    const [kid, enc] = f
    if (!KID_RE.test(kid)) throw new JweError("malformed", "key ring: bad kid")
    let retired: number | undefined
    if (f.length === 3) {
      if (!/^(0|[1-9][0-9]{0,11})$/.test(f[2])) throw new JweError("malformed", "key ring: bad retired time")
      retired = Number(f[2])
    }
    let key: Uint8Array
    try {
      key = b64urlDecode(enc)
    } catch {
      throw new JweError("malformed", "key ring: bad key encoding")
    }
    if (key.length !== KEY_BYTES) throw new JweError("malformed", `key ring: key must be ${KEY_BYTES} bytes`)
    ring.push(retired === undefined ? { kid, key } : { kid, key, retired })
  }
  checkRing(ring, "key ring")
  return ring
}

// ---------------------------------------------------------------------------
// compact JWE

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const headerSegment = (kid: string): string =>
  b64urlEncode(utf8.encode(JSON.stringify({ alg: JWE_ALG, enc: JWE_ENC, kid, typ: JWE_TYP })))

const importAes = (raw: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage])

/** Encrypt `plaintext` (1..MAX_PLAINTEXT_BYTES) under `key`. A fresh random IV every call; `opts.iv` is for tests only. */
export const encryptCompact = async (plaintext: Uint8Array, key: JweKey, opts?: { iv?: Uint8Array }): Promise<string> => {
  checkKey(key, "encryptCompact")
  if (!(plaintext instanceof Uint8Array) || plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new JweError("malformed", `encryptCompact: plaintext must be 1..${MAX_PLAINTEXT_BYTES} bytes`)
  }
  let iv: Uint8Array
  if (opts?.iv !== undefined) {
    if (!(opts.iv instanceof Uint8Array) || opts.iv.length !== IV_BYTES) {
      throw new JweError("malformed", `encryptCompact: iv must be ${IV_BYTES} bytes`)
    }
    iv = opts.iv
  } else {
    iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  }
  const h = headerSegment(key.kid)
  const ck = await importAes(key.key, "encrypt")
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8.encode(h), tagLength: TAG_BYTES * 8 }, ck, plaintext))
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  return `${h}..${b64urlEncode(iv)}.${b64urlEncode(ct)}.${b64urlEncode(tag)}`
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const HEADER_KEYS = ["alg", "enc", "kid", "typ"] as const

const parseHeader = (seg: string): JweHeader => {
  if (seg.length > MAX_HEADER_SEGMENT) throw new JweError("malformed", "header too large")
  const bytes = b64urlDecode(seg)
  if (bytes.length > MAX_HEADER_BYTES) throw new JweError("malformed", "header too large")
  let h: unknown
  try {
    h = JSON.parse(strictUtf8.decode(bytes))
  } catch {
    throw new JweError("malformed", "header is not JSON")
  }
  if (!isPlainObject(h)) throw new JweError("malformed", "header is not an object")
  const keys = Object.keys(h)
  // zip, crit, jku, jwk, x5u, epk, …: anything we don't do is refused outright
  if (keys.some(k => !(HEADER_KEYS as readonly string[]).includes(k))) {
    throw new JweError("unsupported", "unsupported header parameter")
  }
  if (keys.length !== HEADER_KEYS.length) throw new JweError("malformed", "header is missing a parameter")
  if (h.alg !== JWE_ALG) throw new JweError("unsupported", "unsupported alg")
  if (h.enc !== JWE_ENC) throw new JweError("unsupported", "unsupported enc")
  if (h.typ !== JWE_TYP) throw new JweError("unsupported", "unsupported typ")
  if (typeof h.kid !== "string" || !KID_RE.test(h.kid)) throw new JweError("malformed", "bad kid")
  // Only the exact serialization we mint: no duplicate keys, other order or whitespace
  if (headerSegment(h.kid) !== seg) throw new JweError("malformed", "non-canonical header")
  return { alg: JWE_ALG, enc: JWE_ENC, kid: h.kid, typ: JWE_TYP }
}

/**
 * Decrypt a compact JWE with the ring key named by its kid (never by trying
 * every key). Every check runs before WebCrypto sees the token.
 */
export const decryptCompact = async (token: string, ring: readonly JweKey[]): Promise<{ header: JweHeader; plaintext: Uint8Array }> => {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) throw new JweError("malformed", "bad token")
  const segs = token.split(".")
  if (segs.length !== 5) throw new JweError("malformed", "a token has 5 segments")
  const [hSeg, ekSeg, ivSeg, ctSeg, tagSeg] = segs
  if (ekSeg !== "") throw new JweError("malformed", "encrypted key must be empty")
  if (!hSeg || !ivSeg || !ctSeg || !tagSeg) throw new JweError("malformed", "empty segment")
  const header = parseHeader(hSeg)
  const iv = b64urlDecode(ivSeg)
  const ct = b64urlDecode(ctSeg)
  const tag = b64urlDecode(tagSeg)
  if (iv.length !== IV_BYTES) throw new JweError("malformed", "bad iv length")
  if (tag.length !== TAG_BYTES) throw new JweError("malformed", "bad tag length")
  if (ct.length < 1 || ct.length > MAX_PLAINTEXT_BYTES) throw new JweError("malformed", "bad ciphertext length")
  if (!Array.isArray(ring)) throw new TypeError("decryptCompact: ring must be an array")
  const k = ring.find(r => r && r.kid === header.kid)
  if (!k) throw new JweError("unknown_kid", "unknown key id")
  if (!(k.key instanceof Uint8Array) || k.key.length !== KEY_BYTES) {
    throw new TypeError(`decryptCompact: ring key must be ${KEY_BYTES} bytes`)
  }
  const sealed = new Uint8Array(ct.length + TAG_BYTES)
  sealed.set(ct, 0)
  sealed.set(tag, ct.length)
  let plain: ArrayBuffer
  try {
    const ck = await importAes(k.key, "decrypt")
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: utf8.encode(hSeg), tagLength: TAG_BYTES * 8 }, ck, sealed)
  } catch {
    throw new JweError("decrypt", "decryption failed")
  }
  return { header, plaintext: new Uint8Array(plain) }
}

// ---------------------------------------------------------------------------
// claims

const CLAIM_KEYS = ["iss", "aud", "sub", "amr", "iat", "exp", "auth_time", "superuser", "jti", "state", "nonce", "dest"] as const
const REQUIRED_CLAIMS = CLAIM_KEYS.filter(k => k !== "nonce")

const bad = (what: string): never => { throw new JweError("claims", `bad claim: ${what}`) }
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max

const httpsUrl = (s: string): URL | null => {
  if (URL_BAD_CHAR_RE.test(s)) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null
  return u
}

/**
 * Shape check only (no time, aud or iss policy). Returns a fresh object with
 * the claims in canonical order; throws JweError("claims"). A `nonce` whose
 * value is undefined counts as absent (JSON drops it anyway).
 */
export const validateClaims = (c: unknown): AppClaims => {
  if (!isPlainObject(c)) bad("not an object")
  const o = c as Record<string, unknown>
  for (const k of Object.keys(o)) {
    if (!(CLAIM_KEYS as readonly string[]).includes(k)) bad("unknown claim")
  }
  for (const k of REQUIRED_CLAIMS) if (!Object.hasOwn(o, k)) bad(`missing ${k}`)
  const { iss, aud, sub, amr, iat, exp, auth_time, superuser, jti, state, nonce, dest } = o
  if (!str(iss, MAX_ISS_LENGTH)) bad("iss")
  const issUrl = httpsUrl(iss as string)
  if (!issUrl || issUrl.origin !== iss) bad("iss")
  if (!str(aud, MAX_SITE_LENGTH) || !SITE_RE.test(aud as string)) bad("aud")
  if (typeof sub !== "string" || !USER_RE.test(sub)) bad("sub")
  if (!Array.isArray(amr) || amr.length !== 1 || (amr[0] !== "pam" && amr[0] !== "passkey")) bad("amr")
  if (!isTime(iat)) bad("iat")
  if (!isTime(exp)) bad("exp")
  if (!isTime(auth_time)) bad("auth_time")
  if ((exp as number) <= (iat as number) || (exp as number) - (iat as number) > MAX_TTL_S) bad("exp")
  if ((auth_time as number) > (iat as number) + CLOCK_SKEW_S) bad("auth_time")
  if (typeof superuser !== "boolean") bad("superuser")
  if (typeof jti !== "string" || !JTI_RE.test(jti)) bad("jti")
  if (typeof state !== "string" || !STATE_RE.test(state)) bad("state")
  if (nonce !== undefined && (typeof nonce !== "string" || !NONCE_RE.test(nonce))) bad("nonce")
  if (!str(dest, MAX_DEST_LENGTH) || !httpsUrl(dest as string)) bad("dest")
  const out: AppClaims = {
    iss: iss as string, aud: aud as string, sub: sub as string, amr: [(amr as Amr[])[0]],
    iat: iat as number, exp: exp as number, auth_time: auth_time as number, superuser: superuser as boolean,
    jti: jti as string, state: state as string, dest: dest as string,
  }
  if (nonce !== undefined) out.nonce = nonce as string
  // keep the serialization order of CLAIM_KEYS
  return Object.fromEntries(CLAIM_KEYS.filter(k => k in out).map(k => [k, out[k]])) as unknown as AppClaims
}

/** Validate, then encrypt the claims under `key`. Throws JweError("claims") for a bad shape. */
export const sealClaims = async (claims: AppClaims, key: JweKey): Promise<string> => {
  const c = validateClaims(claims)
  const plaintext = utf8.encode(JSON.stringify(c))
  if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new JweError("claims", "claims too large")
  return encryptCompact(plaintext, key)
}

/**
 * decrypt → validate → expired → not_yet_valid → audience → issuer.
 * `now` is unix seconds.
 */
export const openClaims = async (token: string, ring: readonly JweKey[], expect: {
  aud: string
  issuers: readonly string[]
  now?: number
  skewS?: number
}): Promise<AppClaims> => {
  if (!expect || typeof expect.aud !== "string" || !Array.isArray(expect.issuers)) {
    throw new TypeError("openClaims: expect.aud and expect.issuers are required")
  }
  const now = expect.now ?? Math.floor(Date.now() / 1000)
  const skew = expect.skewS ?? CLOCK_SKEW_S
  if (!Number.isFinite(now)) throw new TypeError("openClaims: bad now")
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_TTL_S) throw new TypeError("openClaims: bad skewS")
  // A retired key is gone once no token it may open (iat <= retired) can still be live
  const usable = Array.isArray(ring) ? ring.filter(k => !(k && k.retired !== undefined && now >= k.retired + MAX_TTL_S + skew)) : ring
  const { header, plaintext } = await decryptCompact(token, usable)
  let raw: unknown
  try {
    raw = JSON.parse(strictUtf8.decode(plaintext))
  } catch {
    throw new JweError("claims", "claims are not UTF-8 JSON")
  }
  const c = validateClaims(raw)
  // Made with a retired key after it was retired: not something the portal does
  const used = usable.find(k => k && k.kid === header.kid)
  if (used?.retired !== undefined && c.iat > used.retired + skew) throw new JweError("unknown_kid", "key retired before this token was made")
  if (now >= c.exp + skew) throw new JweError("expired", "token expired")
  if (c.iat > now + skew) throw new JweError("not_yet_valid", "token not yet valid")
  if (c.aud !== expect.aud) throw new JweError("audience", "token is for another site")
  if (!expect.issuers.includes(c.iss)) throw new JweError("issuer", "unknown issuer")
  return c
}
