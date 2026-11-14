import { describe, expect, it, spyOn } from "bun:test"
import {
  JWE_ALG, JWE_ENC, JWE_TYP, KEY_BYTES, IV_BYTES, TAG_BYTES, MAX_TOKEN_LENGTH, MAX_HEADER_BYTES,
  MAX_PLAINTEXT_BYTES, MAX_RING_KEYS, DEFAULT_TTL_S, MAX_TTL_S, CLOCK_SKEW_S,
  KID_RE, USER_RE, STATE_RE, NONCE_RE, JTI_RE, SITE_RE,
  JweError, b64urlEncode, b64urlDecode, randomB64url, generateKey,
  encryptCompact, decryptCompact, sealClaims, openClaims, validateClaims,
  formatKeyRing, parseKeyRing,
  type AppClaims, type JweKey, type JweErrorCode,
} from "../jwe.ts"

const enc = new TextEncoder()
const dec = new TextDecoder()

// Fixed vector: frozen format. Independently checked with Python's
// cryptography AESGCM (header JSON, empty 2nd segment, AAD = header segment).
const VEC_KEY: JweKey = { kid: "test-kid-0001", key: Uint8Array.from({ length: 32 }, (_, i) => i) }
const VEC_IV = Uint8Array.from({ length: 12 }, (_, i) => 0xa0 + i)
const VEC_PLAIN = '{"hello":"candy"}'
const VEC_TOKEN = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoidGVzdC1raWQtMDAwMSIsInR5cCI6IkpXVCJ9"
  + "..oKGio6Slpqeoqaqr.nToUSCmnbZ1YR-SyaR65_A0.p7NI4HjDnIJPN2FT2EyYZg"

const NOW = 1_800_000_000
const ISS = "https://portal.localhost"
const ISSUERS = [ISS, "https://portal.candy"]

const claims = (over: Partial<Record<keyof AppClaims, unknown>> = {}): AppClaims => ({
  iss: ISS,
  aud: "notes",
  sub: "ashwin",
  amr: ["pam"],
  iat: NOW,
  exp: NOW + DEFAULT_TTL_S,
  auth_time: NOW - 3600,
  jti: "jti-aaaaaaaaaaaaaaaa",
  state: "state-aaaaaaaaaaaaaaaa",
  nonce: "nonce-aaaaaaaaaaaaaaaa",
  dest: "https://notes.localhost/_candy/auth/callback",
  ...over,
} as AppClaims)

const code = async (p: Promise<unknown> | (() => unknown)): Promise<JweErrorCode | "ok" | string> => {
  try {
    await (typeof p === "function" ? p() : p)
    return "ok"
  } catch (e) {
    if (e instanceof JweError) return e.code
    return `other:${(e as Error).name}`
  }
}

/** Encrypt with an arbitrary header segment, bypassing encryptCompact's own header. */
const rawToken = async (header: string | object, key: Uint8Array, plaintext: Uint8Array | string, iv = VEC_IV): Promise<string> => {
  const h = typeof header === "string" ? header : b64urlEncode(enc.encode(JSON.stringify(header)))
  const ck = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"])
  const pt = typeof plaintext === "string" ? enc.encode(plaintext) : plaintext
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(h) }, ck, pt))
  return [h, "", b64urlEncode(iv), b64urlEncode(sealed.subarray(0, -16)), b64urlEncode(sealed.subarray(-16))].join(".")
}
const hdr = (o: Record<string, unknown> = {}) => ({ alg: "dir", enc: "A256GCM", kid: VEC_KEY.kid, typ: "JWT", ...o })

const B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const flipChar = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1)
const segs = (t: string) => t.split(".")


describe("constants", () => {
  it("match the contract", () => {
    expect([JWE_ALG, JWE_ENC, JWE_TYP]).toEqual(["dir", "A256GCM", "JWT"])
    expect([KEY_BYTES, IV_BYTES, TAG_BYTES]).toEqual([32, 12, 16])
    expect([MAX_TOKEN_LENGTH, MAX_HEADER_BYTES, MAX_PLAINTEXT_BYTES, MAX_RING_KEYS]).toEqual([4096, 256, 2048, 4])
    expect([DEFAULT_TTL_S, MAX_TTL_S, CLOCK_SKEW_S]).toEqual([60, 300, 30])
  })
  it("regexes accept and refuse the expected samples", () => {
    expect(KID_RE.test("abcdEFGH")).toBe(true)
    expect(KID_RE.test("abcdEFG")).toBe(false)
    expect(KID_RE.test("a".repeat(33))).toBe(false)
    expect(KID_RE.test("abcd.EFGH")).toBe(false)
    for (const u of ["ashwin", "claude", "_svc", "a.b-c", "machine$"]) expect(USER_RE.test(u)).toBe(true)
    for (const u of ["", "1abc", "a b", "a/b", "a".repeat(33), "root\n"]) expect(USER_RE.test(u)).toBe(false)
    for (const s of ["notes", "my-app", "a.b", "a_", "x"]) expect(SITE_RE.test(s)).toBe(true)
    for (const s of ["Notes", "-a", "a-", ".a", "a..b", "_a", "a b", ""]) expect(SITE_RE.test(s)).toBe(false)
    expect(STATE_RE.test("a".repeat(16))).toBe(true)
    expect(STATE_RE.test("a".repeat(15))).toBe(false)
    expect(STATE_RE.test("a".repeat(257))).toBe(false)
    expect(NONCE_RE.test("a".repeat(129))).toBe(false)
    expect(JTI_RE.test("a".repeat(65))).toBe(false)
  })
})

describe("JweError", () => {
  it("is an Error with a code", () => {
    const e = new JweError("decrypt")
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe("decrypt")
    expect(e.name).toBe("JweError")
    expect(new JweError("claims", "x").message).toBe("x")
  })
})

describe("base64url", () => {
  it("round-trips every length and matches Buffer's base64url", () => {
    for (let n = 0; n < 70; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n))
      const s = b64urlEncode(b)
      expect(s).toBe(Buffer.from(b).toString("base64url"))
      expect(b64urlDecode(s)).toEqual(b)
    }
    expect(b64urlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8")
  })
  it("decodes the empty string to no bytes", () => {
    expect(b64urlDecode("")).toEqual(new Uint8Array(0))
  })
  it("refuses padding, standard-alphabet chars, whitespace and bad lengths", async () => {
    for (const s of ["AA==", "AAA=", "+/AA", "AA/A", "AA A", " AAA", "AAAA\n", "A", "AAAAA", "AA.A", "ÄAAA", "AA\u0000A"]) {
      expect(await code(() => b64urlDecode(s))).toBe("malformed")
    }
  })
  it("refuses non-canonical trailing bits", async () => {
    expect(b64urlDecode("AA")).toEqual(new Uint8Array([0]))
    expect(await code(() => b64urlDecode("AB"))).toBe("malformed")
    expect(await code(() => b64urlDecode("AAB"))).toBe("malformed")
    expect(b64urlDecode("AAE")).toEqual(new Uint8Array([0, 1]))
    // every 2- and 3-char tail that decodes must re-encode to itself
    for (const a of B64CHARS) for (const b of B64CHARS) {
      const s = "A" + a + b
      try { expect(b64urlEncode(b64urlDecode(s))).toBe(s) } catch (e) { expect((e as JweError).code).toBe("malformed") }
    }
  })
  it("refuses non-strings", async () => {
    for (const v of [null, undefined, 1, {}, ["AAAA"]]) expect(await code(() => b64urlDecode(v as never))).toBe("malformed")
  })
  it("encode refuses non-bytes", async () => {
    expect(await code(() => b64urlEncode("abc" as never))).toBe("other:TypeError")
  })
})

describe("randomB64url / generateKey", () => {
  it("random strings have the right length and differ", () => {
    const a = randomB64url(24)
    expect(a).toHaveLength(32)
    expect(b64urlDecode(a)).toHaveLength(24)
    expect(randomB64url(24)).not.toBe(a)
    expect(randomB64url(16)).toHaveLength(22)
  })
  it("refuses bad sizes", async () => {
    for (const n of [0, -1, 1.5, NaN, 1025, "8"]) expect(await code(() => randomB64url(n as never))).toBe("other:RangeError")
  })
  it("generateKey: 12-char kid, 32 random bytes, fresh each time", () => {
    const a = generateKey()
    const b = generateKey()
    expect(a.kid).toHaveLength(12)
    expect(KID_RE.test(a.kid)).toBe(true)
    expect(a.key).toBeInstanceOf(Uint8Array)
    expect(a.key.length).toBe(32)
    expect(a.kid).not.toBe(b.kid)
    expect(a.key).not.toEqual(b.key)
  })
})

describe("encryptCompact / decryptCompact", () => {
  it("produces the frozen fixed vector", async () => {
    expect(await encryptCompact(enc.encode(VEC_PLAIN), VEC_KEY, { iv: VEC_IV })).toBe(VEC_TOKEN)
    const { header, plaintext } = await decryptCompact(VEC_TOKEN, [VEC_KEY])
    expect(header).toEqual({ alg: "dir", enc: "A256GCM", kid: "test-kid-0001", typ: "JWT" })
    expect(dec.decode(plaintext)).toBe(VEC_PLAIN)
  })
  it("header is exactly {alg,enc,kid,typ} in that order and the 2nd segment is empty", async () => {
    const t = await encryptCompact(enc.encode("x"), VEC_KEY)
    const s = segs(t)
    expect(s).toHaveLength(5)
    expect(s[1]).toBe("")
    expect(dec.decode(b64urlDecode(s[0]))).toBe('{"alg":"dir","enc":"A256GCM","kid":"test-kid-0001","typ":"JWT"}')
    expect(b64urlDecode(s[2])).toHaveLength(IV_BYTES)
    expect(b64urlDecode(s[4])).toHaveLength(TAG_BYTES)
    expect(b64urlDecode(s[3])).toHaveLength(1)
  })
  it("round-trips arbitrary bytes up to the plaintext cap", async () => {
    const k = generateKey()
    for (const n of [1, 15, 16, 17, 1000, MAX_PLAINTEXT_BYTES]) {
      const p = crypto.getRandomValues(new Uint8Array(n))
      const { plaintext } = await decryptCompact(await encryptCompact(p, k), [k])
      expect(plaintext).toEqual(p)
    }
  })
  it("never reuses an IV", async () => {
    const k = generateKey()
    const p = enc.encode("same")
    const ivs = new Set<string>()
    for (let i = 0; i < 50; i++) ivs.add(segs(await encryptCompact(p, k))[2])
    expect(ivs.size).toBe(50)
  })
  it("refuses an empty or oversized plaintext, a bad iv override and bad keys", async () => {
    const k = generateKey()
    expect(await code(encryptCompact(new Uint8Array(0), k))).toBe("malformed")
    expect(await code(encryptCompact(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), k))).toBe("malformed")
    expect(await code(encryptCompact("x" as never, k))).toBe("malformed")
    expect(await code(encryptCompact(enc.encode("x"), k, { iv: new Uint8Array(11) }))).toBe("malformed")
    expect(await code(encryptCompact(enc.encode("x"), k, { iv: new Uint8Array(16) }))).toBe("malformed")
    expect(await code(encryptCompact(enc.encode("x"), { kid: k.kid, key: new Uint8Array(16) }))).toBe("malformed")
    expect(await code(encryptCompact(enc.encode("x"), { kid: "short", key: k.key }))).toBe("malformed")
    expect(await code(encryptCompact(enc.encode("x"), null as never))).toBe("malformed")
  })

  describe("malformed tokens", () => {
    const k = VEC_KEY
    const [H, , IV, CT, TAG] = segs(VEC_TOKEN)
    const j = (...p: string[]) => p.join(".")
    const cases: [string, unknown][] = [
      ["number", 42],
      ["null", null],
      ["undefined", undefined],
      ["object", { toString: () => VEC_TOKEN }],
      ["empty", ""],
      ["4 segments", j(H, "", IV, CT)],
      ["6 segments", j(H, "", IV, CT, TAG, "")],
      ["3 segments", j(H, IV, CT)],
      ["non-empty encrypted key", j(H, "AAAA", IV, CT, TAG)],
      ["empty header", j("", "", IV, CT, TAG)],
      ["empty iv", j(H, "", "", CT, TAG)],
      ["empty ciphertext", j(H, "", IV, "", TAG)],
      ["empty tag", j(H, "", IV, CT, "")],
      ["padded tag", j(H, "", IV, CT, TAG + "==")],
      ["std alphabet in ct", j(H, "", IV, CT.replace(/-/, "+"), TAG)],
      ["whitespace in iv", j(H, "", IV + " ", CT, TAG)],
      ["non-canonical iv tail", j(H, "", IV, CT, TAG.slice(0, -1) + "h")],
      ["iv 11 bytes", j(H, "", b64urlEncode(new Uint8Array(11)), CT, TAG)],
      ["iv 13 bytes", j(H, "", b64urlEncode(new Uint8Array(13)), CT, TAG)],
      ["tag 15 bytes", j(H, "", IV, CT, b64urlEncode(new Uint8Array(15)))],
      ["tag 17 bytes", j(H, "", IV, CT, b64urlEncode(new Uint8Array(17)))],
      ["ciphertext over cap", j(H, "", IV, b64urlEncode(new Uint8Array(MAX_PLAINTEXT_BYTES + 1)), TAG)],
      ["header not JSON", j(b64urlEncode(enc.encode("not json")), "", IV, CT, TAG)],
      ["header JSON array", j(b64urlEncode(enc.encode('["dir"]')), "", IV, CT, TAG)],
      ["header JSON null", j(b64urlEncode(enc.encode("null")), "", IV, CT, TAG)],
      ["header JSON string", j(b64urlEncode(enc.encode('"dir"')), "", IV, CT, TAG)],
      ["header invalid UTF-8", j(b64urlEncode(new Uint8Array([0x7b, 0xff, 0x7d])), "", IV, CT, TAG)],
      ["header over 256 bytes", j(b64urlEncode(enc.encode(JSON.stringify(hdr({ kid: "a".repeat(300) })))), "", IV, CT, TAG)],
      ["header missing typ", j(b64urlEncode(enc.encode('{"alg":"dir","enc":"A256GCM","kid":"test-kid-0001"}')), "", IV, CT, TAG)],
      ["header missing kid", j(b64urlEncode(enc.encode('{"alg":"dir","enc":"A256GCM","typ":"JWT"}')), "", IV, CT, TAG)],
      ["kid too short", j(b64urlEncode(enc.encode(JSON.stringify(hdr({ kid: "short" })))), "", IV, CT, TAG)],
      ["kid with dot", j(b64urlEncode(enc.encode(JSON.stringify(hdr({ kid: "test.kid.0001" })))), "", IV, CT, TAG)],
      ["kid number", j(b64urlEncode(enc.encode(JSON.stringify(hdr({ kid: 12345678 })))), "", IV, CT, TAG)],
      ["header reordered", j(b64urlEncode(enc.encode('{"enc":"A256GCM","alg":"dir","kid":"test-kid-0001","typ":"JWT"}')), "", IV, CT, TAG)],
      ["header with whitespace", j(b64urlEncode(enc.encode('{"alg":"dir", "enc":"A256GCM","kid":"test-kid-0001","typ":"JWT"}')), "", IV, CT, TAG)],
      ["header duplicate key", j(b64urlEncode(enc.encode('{"alg":"none","alg":"dir","enc":"A256GCM","kid":"test-kid-0001","typ":"JWT"}')), "", IV, CT, TAG)],
      ["lots of dots", ".".repeat(4000)],
    ]
    for (const [name, t] of cases) {
      it(name, async () => {
        expect(await code(decryptCompact(t as string, [k]))).toBe("malformed")
      })
    }

    it("checks the length before splitting or decoding (4097 chars)", async () => {
      const big = VEC_TOKEN + "A".repeat(MAX_TOKEN_LENGTH + 1 - VEC_TOKEN.length)
      expect(big).toHaveLength(4097)
      const imp = spyOn(crypto.subtle, "importKey")
      const split = spyOn(String.prototype, "split")
      try {
        expect(await code(decryptCompact(big, [k]))).toBe("malformed")
        expect(imp).not.toHaveBeenCalled()
        expect(split).not.toHaveBeenCalled()
      } finally {
        imp.mockRestore()
        split.mockRestore()
      }
      // a 4096-char token gets past the length check (and then fails on structure)
      expect(await code(decryptCompact("A".repeat(MAX_TOKEN_LENGTH), [k]))).toBe("malformed")
    })

    it("never reaches WebCrypto for a malformed token", async () => {
      const imp = spyOn(crypto.subtle, "importKey")
      const dc = spyOn(crypto.subtle, "decrypt")
      try {
        for (const [, t] of cases) await code(decryptCompact(t as string, [k]))
        expect(imp).not.toHaveBeenCalled()
        expect(dc).not.toHaveBeenCalled()
      } finally {
        imp.mockRestore()
        dc.mockRestore()
      }
    })
  })

  describe("unsupported headers", () => {
    const cases: [string, object][] = [
      ['alg "none"', hdr({ alg: "none" })],
      ['alg "RSA-OAEP"', hdr({ alg: "RSA-OAEP" })],
      ['alg "A256KW"', hdr({ alg: "A256KW" })],
      ["alg number", hdr({ alg: 1 })],
      ['enc "A128GCM"', hdr({ enc: "A128GCM" })],
      ['enc "A256CBC-HS512"', hdr({ enc: "A256CBC-HS512" })],
      ['typ "JOSE"', hdr({ typ: "JOSE" })],
      ["extra zip", hdr({ zip: "DEF" })],
      ["extra crit", hdr({ crit: ["exp"] })],
      ["extra jku", hdr({ jku: "https://evil.example/jwks" })],
      ["extra jwk", hdr({ jwk: { kty: "oct" } })],
      ["extra x5u", hdr({ x5u: "https://evil.example/x" })],
      ["extra cty", hdr({ cty: "JWT" })],
    ]
    for (const [name, h] of cases) {
      it(name, async () => {
        // a properly encrypted token: the header itself is the only problem
        const t = await rawToken(h, VEC_KEY.key, "{}")
        expect(await code(decryptCompact(t, [VEC_KEY]))).toBe("unsupported")
      })
    }
    it("a correctly encrypted canonical header still decrypts (control)", async () => {
      const t = await rawToken(hdr(), VEC_KEY.key, VEC_PLAIN)
      expect(t).toBe(VEC_TOKEN)
    })
  })

  describe("keys", () => {
    it("unknown kid", async () => {
      expect(await code(decryptCompact(VEC_TOKEN, [generateKey()]))).toBe("unknown_kid")
      expect(await code(decryptCompact(VEC_TOKEN, []))).toBe("unknown_kid")
    })
    it("looks keys up by kid only, never by trying every key", async () => {
      const sameBytesOtherKid = { kid: "other-kid-01", key: VEC_KEY.key }
      const dc = spyOn(crypto.subtle, "decrypt")
      try {
        expect(await code(decryptCompact(VEC_TOKEN, [generateKey(), sameBytesOtherKid, generateKey()]))).toBe("unknown_kid")
        expect(dc).not.toHaveBeenCalled()
      } finally {
        dc.mockRestore()
      }
    })
    it("wrong key under the right kid → decrypt", async () => {
      expect(await code(decryptCompact(VEC_TOKEN, [{ kid: VEC_KEY.kid, key: new Uint8Array(32) }]))).toBe("decrypt")
    })
    it("rotation: [new, old] opens both, [new] refuses old", async () => {
      const oldK = generateKey()
      const newK = generateKey()
      const tOld = await encryptCompact(enc.encode("old"), oldK)
      const tNew = await encryptCompact(enc.encode("new"), newK)
      expect(dec.decode((await decryptCompact(tOld, [newK, oldK])).plaintext)).toBe("old")
      expect(dec.decode((await decryptCompact(tNew, [newK, oldK])).plaintext)).toBe("new")
      expect(await code(decryptCompact(tOld, [newK]))).toBe("unknown_kid")
    })
    it("a broken ring is a programming error, not a token error", async () => {
      expect(await code(decryptCompact(VEC_TOKEN, null as never))).toBe("other:TypeError")
      expect(await code(decryptCompact(VEC_TOKEN, [{ kid: VEC_KEY.kid, key: new Uint8Array(16) }]))).toBe("other:TypeError")
    })
  })

  describe("tampering", () => {
    it("header with another kid whose key is the same bytes → decrypt (AAD covers the header)", async () => {
      const twin: JweKey = { kid: "test-kid-0002", key: VEC_KEY.key }
      const h2 = segs(await encryptCompact(enc.encode("x"), twin))[0]
      const t = [h2, ...segs(VEC_TOKEN).slice(1)].join(".")
      // the two header segments differ by a single character
      const h1 = segs(VEC_TOKEN)[0]
      expect([...h1].filter((c, i) => c !== h2[i])).toHaveLength(1)
      expect(await code(decryptCompact(t, [twin, VEC_KEY]))).toBe("decrypt")
    })
    it("flipping any one character of any segment never yields a valid token", async () => {
      const ring = [VEC_KEY, { kid: "test-kid-0002", key: VEC_KEY.key }, { kid: "test-kid-0003", key: VEC_KEY.key }]
      const allowed = new Set(["malformed", "unsupported", "unknown_kid", "decrypt"])
      for (let i = 0; i < VEC_TOKEN.length; i++) {
        if (VEC_TOKEN[i] === ".") continue
        const c = await code(decryptCompact(flipChar(VEC_TOKEN, i), ring))
        expect(allowed.has(c)).toBe(true)
      }
    })
    it("flipping a byte of iv, ciphertext or tag → decrypt", async () => {
      const s = segs(VEC_TOKEN)
      for (const idx of [2, 3, 4]) {
        const bytes = b64urlDecode(s[idx])
        for (let b = 0; b < bytes.length; b++) {
          const m = bytes.slice()
          m[b] ^= 0x01
          const t = s.map((x, i) => i === idx ? b64urlEncode(m) : x).join(".")
          expect(await code(decryptCompact(t, [VEC_KEY]))).toBe("decrypt")
        }
      }
    })
    it("truncated tokens never decrypt", async () => {
      const allowed = new Set(["malformed", "decrypt"])
      for (let n = 0; n < VEC_TOKEN.length; n++) {
        const c = await code(decryptCompact(VEC_TOKEN.slice(0, n), [VEC_KEY]))
        expect(allowed.has(c)).toBe(true)
      }
    })
    it("a decrypt error carries no detail", async () => {
      try {
        await decryptCompact(VEC_TOKEN, [{ kid: VEC_KEY.kid, key: new Uint8Array(32) }])
        throw new Error("should fail")
      } catch (e) {
        expect((e as JweError).message).toBe("decryption failed")
      }
    })
  })
})

describe("validateClaims", () => {
  it("accepts a valid object and returns a fresh copy in canonical order", () => {
    const c = claims()
    const v = validateClaims(c)
    expect(v).toEqual(c)
    expect(v).not.toBe(c)
    expect(Object.keys(v)).toEqual(["iss", "aud", "sub", "amr", "iat", "exp", "auth_time", "jti", "state", "nonce", "dest"])
    expect(v.amr).not.toBe(c.amr)
  })
  it("nonce is optional; an undefined nonce counts as absent", () => {
    const { nonce: _, ...rest } = claims()
    expect(Object.hasOwn(validateClaims(rest), "nonce")).toBe(false)
    expect(Object.hasOwn(validateClaims(claims({ nonce: undefined })), "nonce")).toBe(false)
  })
  it("accepts amr passkey, a machine user and the edges of the TTL and auth_time", () => {
    expect(validateClaims(claims({ amr: ["passkey"] })).amr).toEqual(["passkey"])
    expect(validateClaims(claims({ sub: "build$" })).sub).toBe("build$")
    expect(() => validateClaims(claims({ exp: NOW + MAX_TTL_S }))).not.toThrow()
    expect(() => validateClaims(claims({ exp: NOW + 1 }))).not.toThrow()
    expect(() => validateClaims(claims({ auth_time: NOW + CLOCK_SKEW_S }))).not.toThrow()
    expect(() => validateClaims(claims({ auth_time: 0 }))).not.toThrow()
    expect(() => validateClaims(claims({ iss: "https://portal.example.com:8443" }))).not.toThrow()
  })

  const bads: [string, unknown][] = [
    ["array", [claims()]],
    ["null", null],
    ["string", JSON.stringify(claims())],
    ["unknown claim", { ...claims(), admin: true }],
    ["__proto__ claim from JSON", JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(claims()).slice(1)}`)],
    ["iss http", claims({ iss: "http://portal.localhost" })],
    ["iss with path", claims({ iss: "https://portal.localhost/" })],
    ["iss with userinfo", claims({ iss: "https://a@portal.localhost" })],
    ["iss not a URL", claims({ iss: "portal" })],
    ["iss empty", claims({ iss: "" })],
    ["iss number", claims({ iss: 1 })],
    ["aud uppercase", claims({ aud: "Notes" })],
    ["aud with slash", claims({ aud: "notes/x" })],
    ["aud 129 chars", claims({ aud: "a".repeat(129) })],
    ["aud empty", claims({ aud: "" })],
    ["aud array", claims({ aud: ["notes"] })],
    ["sub empty", claims({ sub: "" })],
    ["sub with space", claims({ sub: "ash win" })],
    ["sub starts with digit", claims({ sub: "1ashwin" })],
    ["sub number", claims({ sub: 0 })],
    ["amr empty", claims({ amr: [] })],
    ["amr two", claims({ amr: ["pam", "passkey"] })],
    ["amr unknown", claims({ amr: ["pwd"] })],
    ["amr string", claims({ amr: "pam" })],
    ["iat negative", claims({ iat: -1 })],
    ["iat float", claims({ iat: NOW + 0.5 })],
    ["iat string", claims({ iat: String(NOW) })],
    ["iat unsafe", claims({ iat: 2 ** 53, exp: 2 ** 53 + 2 })],
    ["exp NaN", claims({ exp: NaN })],
    ["exp Infinity", claims({ exp: Infinity })],
    ["exp == iat", claims({ exp: NOW })],
    ["exp < iat", claims({ exp: NOW - 1 })],
    ["exp - iat = 301", claims({ exp: NOW + MAX_TTL_S + 1 })],
    ["auth_time after iat + skew", claims({ auth_time: NOW + CLOCK_SKEW_S + 1 })],
    ["auth_time missing", (() => { const c: Record<string, unknown> = { ...claims() }; delete c.auth_time; return c })()],
    ["auth_time float", claims({ auth_time: 1.5 })],
    ["jti short", claims({ jti: "a".repeat(15) })],
    ["jti bad chars", claims({ jti: "a".repeat(16) + "!" })],
    ["state short", claims({ state: "a".repeat(15) })],
    ["state with dot", claims({ state: "a".repeat(16) + "." })],
    ["nonce null", claims({ nonce: null })],
    ["nonce short", claims({ nonce: "short" })],
    ["dest http", claims({ dest: "http://notes.localhost/cb" })],
    ["dest userinfo", claims({ dest: "https://user:pw@notes.localhost/cb" })],
    ["dest relative", claims({ dest: "/cb" })],
    ["dest javascript", claims({ dest: "javascript:alert(1)" })],
    ["dest with newline", claims({ dest: "https://notes.localhost/\ncb" })],
    ["dest with tab", claims({ dest: "https://notes\t.localhost/cb" })],
    ["dest with backslash", claims({ dest: "https://notes.localhost\\@evil.example/" })],
    ["dest over 2048", claims({ dest: "https://notes.localhost/" + "a".repeat(2048) })],
  ]
  for (const [name, c] of bads) {
    it(`refuses ${name}`, async () => {
      expect(await code(() => validateClaims(c))).toBe("claims")
    })
  }
  for (const k of ["iss", "aud", "sub", "amr", "iat", "exp", "auth_time", "jti", "state", "dest"] as const) {
    it(`refuses a missing ${k}`, async () => {
      const c: Record<string, unknown> = { ...claims() }
      delete c[k]
      expect(await code(() => validateClaims(c))).toBe("claims")
    })
  }
})

describe("sealClaims / openClaims", () => {
  const key = generateKey()
  const open = (t: string, o: Partial<{ aud: string; issuers: string[]; now: number; skewS: number }> = {}, ring: JweKey[] = [key]) =>
    openClaims(t, ring, { aud: "notes", issuers: ISSUERS, now: NOW, ...o })

  // Review finding: a retired key stayed usable in a running app forever.
  // The ring now says when a key was retired; it opens only older tokens.
  it("a retired key opens tokens issued up to its retirement (+ skew), and none once those are dead", async () => {
    const retired = NOW - 10
    const ring = [generateKey(), { ...key, retired }]
    const before = await sealClaims(claims({ iat: NOW - 20, exp: NOW + 40, auth_time: NOW - 20 }), key)
    expect((await open(before, {}, ring)).iat).toBe(NOW - 20)
    const edge = await sealClaims(claims({ iat: retired + CLOCK_SKEW_S, exp: retired + CLOCK_SKEW_S + 60, auth_time: retired }), key)
    expect((await open(edge, { now: retired + CLOCK_SKEW_S }, ring)).sub).toBeDefined()
    const after = await sealClaims(claims({ iat: retired + CLOCK_SKEW_S + 1, exp: retired + CLOCK_SKEW_S + 61, auth_time: retired }), key)
    expect(await code(open(after, { now: retired + CLOCK_SKEW_S + 1 }, ring))).toBe("unknown_kid")
    // Long after: the key is skipped outright, even for a token claiming an old iat
    const old = await sealClaims(claims({ iat: retired - 1, exp: retired - 1 + MAX_TTL_S, auth_time: retired - 1 }), key)
    expect(await code(open(old, { now: retired + MAX_TTL_S + CLOCK_SKEW_S }, ring))).toBe("unknown_kid")
    // Without `retired` the same key still works (the current key)
    expect((await open(before, {}, [key])).iat).toBe(NOW - 20)
  })

  it("round trip", async () => {
    const c = claims()
    const t = await sealClaims(c, key)
    expect(t.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH)
    expect(await open(t)).toEqual(c)
    expect(await open(t, { issuers: ["https://portal.candy", ISS] })).toEqual(c)
  })
  it("defaults now to the clock", async () => {
    const now = Math.floor(Date.now() / 1000)
    const t = await sealClaims(claims({ iat: now, exp: now + 60, auth_time: now }), key)
    expect((await openClaims(t, [key], { aud: "notes", issuers: ISSUERS })).sub).toBe("ashwin")
    const old = await sealClaims(claims(), key)
    const c = await code(openClaims(old, [key], { aud: "notes", issuers: ISSUERS }))
    expect(["ok", "expired", "not_yet_valid"]).toContain(c)
  })
  it("sealClaims validates before encrypting", async () => {
    const enc = spyOn(crypto.subtle, "encrypt")
    try {
      expect(await code(sealClaims(claims({ aud: "BAD" }), key))).toBe("claims")
      expect(await code(sealClaims({ ...claims(), extra: 1 } as never, key))).toBe("claims")
      expect(enc).not.toHaveBeenCalled()
    } finally {
      enc.mockRestore()
    }
  })
  it("sealClaims refuses claims over the plaintext cap", async () => {
    const c = claims({ dest: "https://notes.localhost/" + "a".repeat(2000), state: "s".repeat(256), nonce: "n".repeat(128) })
    expect(() => validateClaims(c)).not.toThrow()
    expect(await code(sealClaims(c, key))).toBe("claims")
  })
  it("sealClaims serializes only known claims in canonical order", async () => {
    const t = await sealClaims({ dest: claims().dest, ...claims() }, key)
    const { plaintext } = await decryptCompact(t, [key])
    expect(Object.keys(JSON.parse(dec.decode(plaintext)))).toEqual(["iss", "aud", "sub", "amr", "iat", "exp", "auth_time", "jti", "state", "nonce", "dest"])
  })

  it("exp/skew boundaries", async () => {
    const t = await sealClaims(claims(), key)
    const exp = NOW + DEFAULT_TTL_S
    expect((await open(t, { now: exp + CLOCK_SKEW_S - 1 })).sub).toBe("ashwin")
    expect(await code(open(t, { now: exp + CLOCK_SKEW_S }))).toBe("expired")
    expect(await code(open(t, { now: exp + 10_000 }))).toBe("expired")
    expect((await open(t, { now: exp - 1, skewS: 0 })).sub).toBe("ashwin")
    expect(await code(open(t, { now: exp, skewS: 0 }))).toBe("expired")
  })
  it("iat/skew boundaries", async () => {
    const t = await sealClaims(claims(), key)
    expect((await open(t, { now: NOW - CLOCK_SKEW_S })).sub).toBe("ashwin")
    expect(await code(open(t, { now: NOW - CLOCK_SKEW_S - 1 }))).toBe("not_yet_valid")
    expect(await code(open(t, { now: NOW - 1, skewS: 0 }))).toBe("not_yet_valid")
  })
  it("exp - iat = 301 is refused even when sealed by hand", async () => {
    const c = { ...claims(), exp: NOW + MAX_TTL_S + 1 }
    const t = await encryptCompact(enc.encode(JSON.stringify(c)), key)
    expect(await code(open(t, { now: NOW }))).toBe("claims")
  })
  it("wrong audience", async () => {
    const t = await sealClaims(claims(), key)
    expect(await code(open(t, { aud: "other" }))).toBe("audience")
    expect(await code(open(t, { aud: "" }))).toBe("audience")
    expect(await code(open(t, { aud: "Notes" }))).toBe("audience")
  })
  it("wrong issuer", async () => {
    const t = await sealClaims(claims(), key)
    expect(await code(open(t, { issuers: ["https://portal.candy"] }))).toBe("issuer")
    expect(await code(open(t, { issuers: [] }))).toBe("issuer")
    expect(await code(open(t, { issuers: ["https://portal.localhost/"] }))).toBe("issuer")
  })
  it("check order: decrypt → validate → expired → not_yet_valid → audience → issuer", async () => {
    // expired beats audience and issuer
    const t = await sealClaims(claims(), key)
    expect(await code(open(t, { now: NOW + 10_000, aud: "other", issuers: [] }))).toBe("expired")
    expect(await code(open(t, { now: NOW - 10_000, aud: "other", issuers: [] }))).toBe("not_yet_valid")
    expect(await code(open(t, { aud: "other", issuers: [] }))).toBe("audience")
    // unknown kid / decrypt before claims
    expect(await code(open(t, {}, [generateKey()]))).toBe("unknown_kid")
    expect(await code(open(t, {}, [{ kid: key.kid, key: new Uint8Array(32) }]))).toBe("decrypt")
    // shape before time
    const bad = await encryptCompact(enc.encode(JSON.stringify({ ...claims(), extra: 1, exp: 1, iat: 0 })), key)
    expect(await code(open(bad))).toBe("claims")
  })
  it("a token for site A is useless at site B (per-site key and aud)", async () => {
    const keyA = generateKey()
    const keyB = generateKey()
    const tA = await sealClaims(claims({ aud: "site-a" }), keyA)
    expect(await code(openClaims(tA, [keyB], { aud: "site-b", issuers: ISSUERS, now: NOW }))).toBe("unknown_kid")
    // even if B somehow shared A's key, the aud check still refuses it
    expect(await code(openClaims(tA, [keyA], { aud: "site-b", issuers: ISSUERS, now: NOW }))).toBe("audience")
  })
  it("decrypted plaintext that isn't UTF-8 JSON of a claims object → claims", async () => {
    for (const p of [new Uint8Array([0xff, 0xfe]), enc.encode("not json"), enc.encode("[1]"), enc.encode("null"), enc.encode('"x"'), enc.encode("1")]) {
      const t = await encryptCompact(p, key)
      expect(await code(open(t))).toBe("claims")
    }
  })
  it("an unknown claim is refused after decryption", async () => {
    const t = await encryptCompact(enc.encode(JSON.stringify({ ...claims(), role: "admin" })), key)
    expect(await code(open(t))).toBe("claims")
  })
  it("is stateless: the same token opens twice (replay protection is the SDK's jti cache)", async () => {
    const t = await sealClaims(claims(), key)
    const a = await open(t)
    const b = await open(t)
    expect(a.jti).toBe(b.jti)
  })
  it("refuses a bad expect object", async () => {
    const t = await sealClaims(claims(), key)
    expect(await code(openClaims(t, [key], null as never))).toBe("other:TypeError")
    expect(await code(openClaims(t, [key], { aud: "notes" } as never))).toBe("other:TypeError")
    expect(await code(openClaims(t, [key], { aud: "notes", issuers: ISSUERS, now: NOW, skewS: -1 }))).toBe("other:TypeError")
    expect(await code(openClaims(t, [key], { aud: "notes", issuers: ISSUERS, now: NOW, skewS: 1.5 }))).toBe("other:TypeError")
    expect(await code(openClaims(t, [key], { aud: "notes", issuers: ISSUERS, now: NaN }))).toBe("other:TypeError")
  })
  it("hostile token inputs come back as JweErrors, not crashes", async () => {
    for (const t of [null, 1, {}, "", ".", "....", "a.b.c.d.e", "x".repeat(MAX_TOKEN_LENGTH + 1)]) {
      expect(await code(open(t as string))).toBe("malformed")
    }
  })
})

describe("formatKeyRing / parseKeyRing", () => {
  it("round trip, current key first", () => {
    const ring = [generateKey(), generateKey(), generateKey(), generateKey()]
    const s = formatKeyRing(ring)
    expect(s.split(",")).toHaveLength(4)
    expect(s.startsWith(ring[0].kid + ":")).toBe(true)
    expect(parseKeyRing(s)).toEqual(ring)
    expect(parseKeyRing(formatKeyRing([VEC_KEY]))).toEqual([VEC_KEY])
    expect(formatKeyRing([VEC_KEY])).toBe("test-kid-0001:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
  })
  it("carries a retired key's retirement time (unix s) as a third field", () => {
    const cur = generateKey(), old = { ...generateKey(), retired: 1_800_000_123 }
    const s = formatKeyRing([cur, old])
    expect(s).toBe(`${cur.kid}:${b64urlEncode(cur.key)},${old.kid}:${b64urlEncode(old.key)}:1800000123`)
    expect(parseKeyRing(s)).toEqual([cur, old])
    for (const bad of [":", ":-1", ":1.5", ":01", ":1e9", ":x", ":1234567890123", ": 1", ":1:2"]) {
      expect(() => parseKeyRing(`${formatKeyRing([cur])}${bad}`)).toThrow()
    }
    expect(() => formatKeyRing([{ ...cur, retired: -1 }])).toThrow()
    expect(() => formatKeyRing([{ ...cur, retired: 1.5 }])).toThrow()
  })
  it("trims surrounding whitespace (a trailing newline from a file)", () => {
    const s = formatKeyRing([VEC_KEY])
    expect(parseKeyRing(`  ${s}\n`)).toEqual([VEC_KEY])
  })
  const k1 = formatKeyRing([VEC_KEY])
  const k2 = formatKeyRing([generateKey()])
  const key43 = k1.split(":")[1]
  const rejects: [string, unknown][] = [
    ["non-string", 42],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "  \n"],
    ["5 keys", [1, 2, 3, 4, 5].map(() => formatKeyRing([generateKey()])).join(",")],
    ["duplicate kid", `${k1},${k1}`],
    ["trailing comma", `${k1},`],
    ["leading comma", `,${k1}`],
    ["space after comma", `${k1}, ${k2}`],
    ["inner space", k1.replace(":", ": ")],
    ["no colon", k1.replace(":", "")],
    ["two colons", `${k1}:x`],
    ["bad kid", `short:${key43}`],
    ["kid with dot", `test.kid.0001:${key43}`],
    ["empty kid", `:${key43}`],
    ["key 31 bytes", `test-kid-0001:${b64urlEncode(new Uint8Array(31))}`],
    ["key 33 bytes", `test-kid-0001:${b64urlEncode(new Uint8Array(33))}`],
    ["key empty", "test-kid-0001:"],
    ["key padded", `${k1}=`],
    ["key std base64", `test-kid-0001:${Buffer.from(new Uint8Array(32).fill(0xfb)).toString("base64").replace(/=+$/, "")}`],
    ["key non-canonical", k1.slice(0, -1) + "9"],  // last of 43 chars must have its 2 low bits zero
    ["huge", "a".repeat(100_000)],
  ]
  for (const [name, s] of rejects) {
    it(`parse refuses ${name}`, async () => {
      expect(await code(() => parseKeyRing(s as string))).toBe("malformed")
    })
  }
  it("error messages never contain key material", () => {
    const secret = b64urlEncode(new Uint8Array(31).fill(7))
    try {
      parseKeyRing(`test-kid-0001:${secret}`)
      throw new Error("should fail")
    } catch (e) {
      expect((e as Error).message).not.toContain(secret)
    }
  })
  it("format refuses an empty, oversized, duplicate or broken ring", async () => {
    const k = generateKey()
    expect(await code(() => formatKeyRing([]))).toBe("malformed")
    expect(await code(() => formatKeyRing([1, 2, 3, 4, 5].map(() => generateKey())))).toBe("malformed")
    expect(await code(() => formatKeyRing([k, k]))).toBe("malformed")
    expect(await code(() => formatKeyRing([{ kid: k.kid, key: new Uint8Array(31) }]))).toBe("malformed")
    expect(await code(() => formatKeyRing([{ kid: "bad kid!", key: k.key }]))).toBe("malformed")
    expect(await code(() => formatKeyRing(null as never))).toBe("malformed")
  })
})
