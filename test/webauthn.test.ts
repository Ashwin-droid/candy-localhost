import { describe, expect, it } from "bun:test"
import {
  CborError, WebAuthnError, decodeCbor, decodeCborPrefix, parseAuthenticatorData, parseCoseKey, importCoseKey,
  derToRawEcdsa, parseClientData, newChallenge, registrationOptions, authenticationOptions,
  verifyRegistration, verifyAssertion,
  SUPPORTED_ALGS, FLAG, CHALLENGE_BYTES, DEFAULT_TIMEOUT_MS, MAX_CLIENT_DATA_BYTES, MAX_AUTH_DATA_BYTES,
  MAX_CREDENTIAL_ID_BYTES, MAX_SIGNATURE_BYTES, MAX_USER_HANDLE_BYTES, CBOR_LIMITS,
  type CborValue, type CoseAlg, type StoredCredentialKey, type RegistrationVerdict,
} from "../webauthn.ts"

// ---------------------------------------------------------------------------
// A software authenticator: real WebCrypto keys, real signatures, a test-only
// CBOR encoder. Base64url here goes through Buffer, independent of the
// module's own helpers, so the two cross-check each other.

const RP = "portal.localhost"
const ORIGIN = "https://portal.localhost"
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url")
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"))
const enc = new TextEncoder()
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b))
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const u8 = (...b: number[]) => new Uint8Array(b)

type Enc = number | string | Uint8Array | boolean | null | Enc[] | Map<number | string, Enc>
const head = (major: number, n: number): Uint8Array => {
  const m = major << 5
  if (n < 24) return u8(m | n)
  if (n < 0x100) return u8(m | 24, n)
  if (n < 0x10000) return u8(m | 25, n >> 8, n & 255)
  if (n < 0x100000000) return u8(m | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255)
  const hi = Math.floor(n / 0x100000000), lo = n >>> 0
  return u8(m | 27, (hi >>> 24) & 255, (hi >> 16) & 255, (hi >> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >> 16) & 255, (lo >> 8) & 255, lo & 255)
}
const cbor = (v: Enc): Uint8Array => {
  if (v === false) return u8(0xf4)
  if (v === true) return u8(0xf5)
  if (v === null) return u8(0xf6)
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === "string") { const b = enc.encode(v); return cat(head(3, b.length), b) }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v)
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor))
  const parts: Uint8Array[] = [head(5, v.size)]
  for (const [k, x] of v) parts.push(cbor(k), cbor(x))
  return cat(...parts)
}

/** raw r‖s (WebCrypto) → DER, with the 00 pad when the high bit is set. */
const rawToDer = (raw: Uint8Array): Uint8Array => {
  const int = (b: Uint8Array) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.subarray(i)
    if (v[0] & 0x80) v = cat(u8(0), v)
    return cat(u8(0x02, v.length), v)
  }
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)))
  return cat(u8(0x30, body.length), body)
}

type Alg = -7 | -257 | -8
class SoftAuthenticator {
  counter = 0
  userHandle = rand(32)
  aaguid = rand(16)
  private constructor(readonly alg: number, readonly keys: CryptoKeyPair, readonly cose: Uint8Array, readonly credId: Uint8Array) {}

  static async create(alg: Alg, opts: { rsaBits?: number; credIdLen?: number } = {}) {
    const credId = rand(opts.credIdLen ?? 32)
    if (alg === -7) {
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair
      const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
      const cose = cbor(new Map<number, Enc>([[1, 2], [3, -7], [-1, 1], [-2, unb64(jwk.x!)], [-3, unb64(jwk.y!)]]))
      return new SoftAuthenticator(alg, keys, cose, credId)
    }
    if (alg === -257) {
      const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: opts.rsaBits ?? 2048, publicExponent: u8(1, 0, 1), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair
      const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey)
      const cose = cbor(new Map<number, Enc>([[1, 3], [3, -257], [-1, unb64(jwk.n!)], [-2, unb64(jwk.e!)]]))
      return new SoftAuthenticator(alg, keys, cose, credId)
    }
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
    const cose = cbor(new Map<number, Enc>([[1, 1], [3, -8], [-1, 6], [-2, raw]]))
    return new SoftAuthenticator(alg, keys, cose, credId)
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    if (this.alg === -7) return rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, data)))
    if (this.alg === -257) return new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.keys.privateKey, data))
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.keys.privateKey, data))
  }

  static clientData(type: string, challenge: string, origin: string, extra: Record<string, unknown> = {}) {
    return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false, ...extra }))
  }

  static async authData(o: { rpId: string; flags: number; counter: number; attested?: Uint8Array; ext?: Uint8Array }) {
    const c = o.counter >>> 0
    return cat(await sha256(enc.encode(o.rpId)), u8(o.flags, (c >>> 24) & 255, (c >> 16) & 255, (c >> 8) & 255, c & 255), o.attested ?? new Uint8Array(0), o.ext ?? new Uint8Array(0))
  }

  async register(o: {
    challenge: string; origin?: string; rpId?: string; flags?: number; extra?: Record<string, unknown>; type?: string
    fmt?: string; attStmt?: Map<string, Enc>; cose?: Uint8Array; authCredId?: Uint8Array; id?: string; rawId?: string
    ext?: Uint8Array; transports?: unknown; attObj?: (m: Map<string, Enc>) => Map<string, Enc>
  }) {
    const authCredId = o.authCredId ?? this.credId
    const cose = o.cose ?? this.cose
    const attested = cat(this.aaguid, u8(authCredId.length >> 8, authCredId.length & 255), authCredId, cose)
    const ad = await SoftAuthenticator.authData({
      rpId: o.rpId ?? RP, flags: o.flags ?? (FLAG.UP | FLAG.UV | FLAG.AT), counter: this.counter, attested, ext: o.ext,
    })
    let m = new Map<string, Enc>([["fmt", o.fmt ?? "none"], ["attStmt", o.attStmt ?? new Map()], ["authData", ad]])
    if (o.attObj) m = o.attObj(m)
    const cd = SoftAuthenticator.clientData(o.type ?? "webauthn.create", o.challenge, o.origin ?? ORIGIN, o.extra)
    const id = b64(this.credId)
    return {
      id: o.id ?? id, rawId: o.rawId ?? id, type: "public-key",
      response: { clientDataJSON: b64(cd), attestationObject: b64(cbor(m)), transports: o.transports ?? ["internal", "hybrid"] },
      authenticatorAttachment: "platform", clientExtensionResults: {},
    }
  }

  async assert(o: {
    challenge: string; origin?: string; rpId?: string; flags?: number; extra?: Record<string, unknown>; type?: string
    counter?: number; userHandle?: string | null; tamperSig?: boolean; tamperAuthData?: boolean; tamperClientData?: boolean
    signWith?: SoftAuthenticator; id?: string; ext?: Uint8Array; attested?: Uint8Array
  }) {
    this.counter = o.counter ?? this.counter + 1
    const ad = await SoftAuthenticator.authData({ rpId: o.rpId ?? RP, flags: o.flags ?? (FLAG.UP | FLAG.UV), counter: this.counter, ext: o.ext, attested: o.attested })
    const cd = SoftAuthenticator.clientData(o.type ?? "webauthn.get", o.challenge, o.origin ?? ORIGIN, o.extra)
    const sig = await (o.signWith ?? this).sign(cat(ad, await sha256(cd)))
    if (o.tamperSig) sig[sig.length - 1] ^= 1
    if (o.tamperAuthData) ad[36] ^= 0x40 // a counter byte: signed, but not a flag
    const cdOut = o.tamperClientData ? enc.encode(new TextDecoder().decode(cd).replace("false", "false ")) : cd
    const id = o.id ?? b64(this.credId)
    return {
      id, rawId: id, type: "public-key",
      response: {
        clientDataJSON: b64(cdOut), authenticatorData: b64(ad), signature: b64(sig),
        userHandle: o.userHandle === undefined ? b64(this.userHandle) : o.userHandle,
      },
      authenticatorAttachment: "platform", clientExtensionResults: {},
    }
  }
}

const codeOf = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === "function" ? p() : p)
    return "ok"
  } catch (err) {
    if (err instanceof WebAuthnError) return err.code
    if (err instanceof CborError) return "cbor"
    return `other: ${(err as Error)?.message}`
  }
}

const reg = (response: unknown, challenge: string, over: { origin?: string; rpId?: string } = {}) =>
  verifyRegistration({ response, expectedChallenge: challenge, expectedOrigin: over.origin ?? ORIGIN, expectedRpId: over.rpId ?? RP })
const asrt = (response: unknown, challenge: string, credential: StoredCredentialKey, over: { origin?: string; rpId?: string } = {}) =>
  verifyAssertion({ response, expectedChallenge: challenge, expectedOrigin: over.origin ?? ORIGIN, expectedRpId: over.rpId ?? RP, credential })

/** Registers `a` and returns the stored-credential view of the verdict. */
const enroll = async (a: SoftAuthenticator): Promise<{ v: RegistrationVerdict; stored: StoredCredentialKey }> => {
  const ch = newChallenge()
  const v = await reg(await a.register({ challenge: ch }), ch)
  return { v, stored: { id: v.credentialId, publicKey: v.publicKey, alg: v.alg, signCount: v.signCount } }
}

const ALGS: [string, Alg][] = [["ES256", -7], ["RS256", -257], ["Ed25519", -8]]
const auths = new Map<Alg, SoftAuthenticator>()
const authFor = async (alg: Alg) => {
  if (!auths.has(alg)) auths.set(alg, await SoftAuthenticator.create(alg))
  return auths.get(alg)!
}

// ---------------------------------------------------------------------------

describe("happy paths (real crypto)", () => {
  for (const [name, alg] of ALGS) {
    it(`${name}: registers and then asserts`, async () => {
      const a = await SoftAuthenticator.create(alg)
      const ch = newChallenge()
      const v = await reg(await a.register({ challenge: ch, flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.BE | FLAG.BS }), ch)
      expect(v.alg).toBe(alg)
      expect(v.credentialId).toBe(b64(a.credId))
      expect(v.publicKey).toBe(b64(a.cose))
      expect(v.signCount).toBe(0)
      expect(v.aaguid).toBe(Buffer.from(a.aaguid).toString("hex"))
      expect(v.aaguid).toMatch(/^[0-9a-f]{32}$/)
      expect(v.backupEligible).toBe(true)
      expect(v.backedUp).toBe(true)
      expect(v.transports).toEqual(["internal", "hybrid"])

      const stored: StoredCredentialKey = { id: v.credentialId, publicKey: v.publicKey, alg: v.alg, signCount: v.signCount }
      const ch2 = newChallenge()
      const r = await asrt(await a.assert({ challenge: ch2, flags: FLAG.UP | FLAG.UV | FLAG.BE }), ch2, stored)
      expect(r).toEqual({ credentialId: v.credentialId, newSignCount: 1, userHandle: b64(a.userHandle), backedUp: false })
    })
  }

  it("ES256 verifies across many signatures (DER high-bit padding and short integers)", async () => {
    const a = await authFor(-7)
    const { stored } = await enroll(a)
    let s = { ...stored, signCount: a.counter }
    for (let i = 0; i < 40; i++) {
      const ch = newChallenge()
      const r = await asrt(await a.assert({ challenge: ch }), ch, s)
      s = { ...s, signCount: r.newSignCount }
    }
    expect(s.signCount).toBe(a.counter)
  })

  it("a null or missing userHandle comes back as null", async () => {
    const a = await authFor(-8)
    const { stored } = await enroll(a)
    const ch = newChallenge()
    expect((await asrt(await a.assert({ challenge: ch, userHandle: null, counter: 10 }), ch, { ...stored, signCount: 9 })).userHandle).toBeNull()
    const ch2 = newChallenge()
    const resp = await a.assert({ challenge: ch2, counter: 11 })
    delete (resp.response as Record<string, unknown>).userHandle
    expect((await asrt(resp, ch2, { ...stored, signCount: 10 })).userHandle).toBeNull()
  })

  it("accepts a packed attestation without verifying it (D8), and authenticator extensions", async () => {
    const a = await authFor(-7)
    const ch = newChallenge()
    const attStmt = new Map<string, Enc>([["alg", -7], ["sig", rand(70)], ["x5c", [rand(300)]]])
    const ext = cbor(new Map<string, Enc>([["credProtect", 2]]))
    const v = await reg(await a.register({ challenge: ch, fmt: "packed", attStmt, ext, flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.ED }), ch)
    expect(v.alg).toBe(-7)
  })

  it("ignores unknown clientData members (Chrome's decoy key)", async () => {
    const a = await authFor(-7)
    const ch = newChallenge()
    const v = await reg(await a.register({ challenge: ch, extra: { other_keys_can_be_added_here: "do not compare clientDataJSON against a template" } }), ch)
    expect(v.alg).toBe(-7)
  })

  it("filters transports to /^[a-z-]{1,16}$/, deduped, at most 8; non-arrays become []", async () => {
    const a = await authFor(-7)
    const ch = newChallenge()
    const many = ["usb", "USB", "nfc", "x".repeat(17), 7, "ble", "usb", "a", "b", "c", "d", "e", "f"]
    expect((await reg(await a.register({ challenge: ch, transports: many }), ch)).transports).toEqual(["usb", "nfc", "ble", "a", "b", "c", "d", "e"])
    const ch2 = newChallenge()
    expect((await reg(await a.register({ challenge: ch2, transports: "usb" }), ch2)).transports).toEqual([])
  })
})

describe("verifyRegistration: one failure per code", () => {
  const regCode = async (o: Parameters<SoftAuthenticator["register"]>[0] extends infer T ? Partial<T> : never, over: { origin?: string; rpId?: string; challenge?: string } = {}, alg: Alg = -7) => {
    const a = await authFor(alg)
    const ch = newChallenge()
    return codeOf(reg(await a.register({ challenge: ch, ...o }), over.challenge ?? ch, over))
  }

  it("wrong challenge → challenge", async () => {
    expect(await regCode({}, { challenge: newChallenge() })).toBe("challenge")
  })
  it("challenge that differs in length → challenge", async () => {
    const ch = newChallenge()
    const a = await authFor(-7)
    expect(await codeOf(reg(await a.register({ challenge: ch + "A" }), ch))).toBe("challenge")
  })
  it("origin https://portal.candy vs expected https://portal.localhost → origin", async () => {
    expect(await regCode({ origin: "https://portal.candy" })).toBe("origin")
  })
  it("origin with a port or trailing slash → origin (exact compare)", async () => {
    expect(await regCode({ origin: "https://portal.localhost:443" })).toBe("origin")
    expect(await regCode({ origin: "https://portal.localhost/" })).toBe("origin")
    expect(await regCode({ origin: "http://portal.localhost" })).toBe("origin")
  })
  it("rpIdHash for another host → rp_id", async () => {
    expect(await regCode({ rpId: "portal.candy" })).toBe("rp_id")
    expect(await regCode({ rpId: "localhost" })).toBe("rp_id")
  })
  it("UP off → user_present", async () => {
    expect(await regCode({ flags: FLAG.UV | FLAG.AT })).toBe("user_present")
  })
  it("UV off → user_verified", async () => {
    expect(await regCode({ flags: FLAG.UP | FLAG.AT })).toBe("user_verified")
  })
  it("AT off → malformed", async () => {
    // without AT the attested bytes are trailing garbage
    expect(await regCode({ flags: FLAG.UP | FLAG.UV })).toBe("malformed")
  })
  it("BS without BE → malformed", async () => {
    expect(await regCode({ flags: FLAG.UP | FLAG.UV | FLAG.AT | FLAG.BS })).toBe("malformed")
  })
  it("crossOrigin: true → cross_origin", async () => {
    expect(await regCode({ extra: { crossOrigin: true } })).toBe("cross_origin")
  })
  it("topOrigin present (even null) → cross_origin", async () => {
    expect(await regCode({ extra: { topOrigin: "https://evil.example" } })).toBe("cross_origin")
    expect(await regCode({ extra: { topOrigin: null } })).toBe("cross_origin")
  })
  it("crossOrigin of the wrong type → malformed", async () => {
    expect(await regCode({ extra: { crossOrigin: "true" } })).toBe("malformed")
  })
  it("clientData type webauthn.get on a registration → type", async () => {
    expect(await regCode({ type: "webauthn.get" })).toBe("type")
  })
  it("id/rawId mismatch → malformed", async () => {
    expect(await regCode({ rawId: b64(rand(32)) })).toBe("malformed")
  })
  it("rawId not the credential id in authData → credential_id", async () => {
    const other = b64(rand(32))
    expect(await regCode({ id: other, rawId: other })).toBe("credential_id")
    expect(await regCode({ authCredId: rand(32) })).toBe("credential_id")
  })
  it("unsupported alg (-35, ES384) → algorithm", async () => {
    const cose = cbor(new Map<number, Enc>([[1, 2], [3, -35], [-1, 2], [-2, rand(48)], [-3, rand(48)]]))
    expect(await regCode({ cose })).toBe("algorithm")
  })
  it("RSA 1024 → key", async () => {
    const a = await SoftAuthenticator.create(-257, { rsaBits: 1024 })
    const ch = newChallenge()
    expect(await codeOf(reg(await a.register({ challenge: ch }), ch))).toBe("key")
  })
  it("an off-curve EC point → key", async () => {
    const cose = cbor(new Map<number, Enc>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(2)]]))
    expect(await regCode({ cose })).toBe("key")
  })
  it("fmt none with a non-empty attStmt → attestation", async () => {
    expect(await regCode({ attStmt: new Map<string, Enc>([["sig", rand(8)]]) })).toBe("attestation")
  })
  it("attestationObject: extra member, missing member, wrong types → malformed", async () => {
    expect(await regCode({ attObj: m => new Map([...m, ["extra", 1]]) })).toBe("malformed")
    expect(await regCode({ attObj: m => new Map([...m].filter(([k]) => k !== "attStmt")) })).toBe("malformed")
    expect(await regCode({ attObj: m => new Map([...m].map(([k, v]) => [k, k === "authData" ? b64(v as Uint8Array) : v])) })).toBe("malformed")
    expect(await regCode({ fmt: "" })).toBe("malformed")
    expect(await regCode({ fmt: "x".repeat(33) })).toBe("malformed")
  })
  it("attestationObject with trailing bytes → malformed", async () => {
    const a = await authFor(-7)
    const ch = newChallenge()
    const r = await a.register({ challenge: ch })
    r.response.attestationObject = b64(cat(unb64(r.response.attestationObject), u8(0)))
    expect(await codeOf(reg(r, ch))).toBe("malformed")
  })
  it("a tampered authData byte inside the COSE key → algorithm, key or malformed, never ok", async () => {
    const a = await authFor(-7)
    for (const at of [55 + 32 + 1, 55 + 32 + 4, 55 + 32 + 10]) {
      const ch = newChallenge()
      const r = await a.register({ challenge: ch })
      const obj = unb64(r.response.attestationObject)
      const m = decodeCbor(obj) as Map<string, CborValue>
      const ad = (m.get("authData") as Uint8Array).slice()
      ad[at] ^= 0xff
      r.response.attestationObject = b64(cbor(new Map<string, Enc>([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]])))
      expect(["algorithm", "key", "malformed"]).toContain(await codeOf(reg(r, ch)))
    }
  })
  it("hostile shapes → malformed", async () => {
    const a = await authFor(-7)
    const ch = newChallenge()
    const good = await a.register({ challenge: ch })
    const variants: unknown[] = [
      null, undefined, "x", 1, [], {},
      { ...good, type: "public-key " },
      { ...good, id: 5, rawId: 5 },
      { ...good, response: null },
      { ...good, response: { ...good.response, clientDataJSON: 7 } },
      { ...good, response: { ...good.response, attestationObject: null } },
      { ...good, id: good.id + "=", rawId: good.rawId + "=" },              // padding
      { ...good, id: "", rawId: "" },                                       // empty id
      { ...good, id: "A".repeat(1400), rawId: "A".repeat(1400) },           // > 1023 bytes
      { ...good, response: { ...good.response, clientDataJSON: good.response.clientDataJSON + "=" } },
      { ...good, response: { ...good.response, clientDataJSON: good.response.clientDataJSON.replace(/./, "+") } },
      { ...good, response: { ...good.response, attestationObject: "" } },
      { ...good, response: { ...good.response, attestationObject: "A".repeat(30_000) } },
    ]
    for (const v of variants) expect(await codeOf(reg(v, ch))).toBe("malformed")
  })
  it("a non-canonical base64url id (non-zero trailing bits) → malformed", async () => {
    const a = await SoftAuthenticator.create(-8, { credIdLen: 31 })   // 31 bytes → 42 chars, 2 spare bits
    const ch = newChallenge()
    const r = await a.register({ challenge: ch })
    const last = r.id[r.id.length - 1]
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const bumped = r.id.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]
    expect(Buffer.from(bumped, "base64url").equals(Buffer.from(r.id, "base64url"))).toBe(true) // Buffer is lenient
    expect(await codeOf(reg({ ...r, id: bumped, rawId: bumped }, ch))).toBe("malformed")
  })
  it("clientDataJSON hostile contents → malformed", async () => {
    const a = await authFor(-7)
    const ch = newChallenge()
    const good = await a.register({ challenge: ch })
    const cds = [
      enc.encode("not json"),
      enc.encode("[1,2]"),
      enc.encode("null"),
      enc.encode(JSON.stringify({ type: "webauthn.create", challenge: 5, origin: ORIGIN })),
      enc.encode(JSON.stringify({ type: "webauthn.create", challenge: ch })),
      u8(0xff, 0xfe, 0x7b, 0x7d),                                            // invalid UTF-8
      enc.encode(JSON.stringify({ type: "webauthn.create", challenge: ch, origin: ORIGIN, pad: "x".repeat(MAX_CLIENT_DATA_BYTES) })),
    ]
    for (const cd of cds) {
      expect(await codeOf(reg({ ...good, response: { ...good.response, clientDataJSON: b64(cd) } }, ch))).toBe("malformed")
    }
  })
  it("fails closed on empty expectations", async () => {
    const a = await authFor(-7)
    const r = await a.register({ challenge: "" })
    expect(await codeOf(verifyRegistration({ response: r, expectedChallenge: "", expectedOrigin: ORIGIN, expectedRpId: RP }))).toBe("challenge")
    const ch = newChallenge()
    const r2 = await a.register({ challenge: ch, origin: "" })
    expect(await codeOf(verifyRegistration({ response: r2, expectedChallenge: ch, expectedOrigin: "", expectedRpId: RP }))).toBe("origin")
    expect(await codeOf(verifyRegistration({ response: r2, expectedChallenge: ch, expectedOrigin: ORIGIN, expectedRpId: "" }))).toBe("rp_id")
  })
})

describe("verifyAssertion: one failure per code", () => {
  const setup = async (alg: Alg = -7) => {
    const a = await SoftAuthenticator.create(alg)
    const { stored } = await enroll(a)
    return { a, stored }
  }

  it("wrong challenge → challenge", async () => {
    const { a, stored } = await setup()
    expect(await codeOf(asrt(await a.assert({ challenge: newChallenge() }), newChallenge(), stored))).toBe("challenge")
  })
  it("origin https://portal.candy vs expected https://portal.localhost → origin", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, origin: "https://portal.candy" }), ch, stored))).toBe("origin")
  })
  it("a credential registered on portal.candy, presented on portal.localhost → rp_id", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, rpId: "portal.candy" }), ch, stored))).toBe("rp_id")
  })
  it("UP off → user_present", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, flags: FLAG.UV }), ch, stored))).toBe("user_present")
  })
  it("UV off → user_verified", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, flags: FLAG.UP }), ch, stored))).toBe("user_verified")
  })
  it("AT on in an assertion → malformed", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    const attested = cat(a.aaguid, u8(0, a.credId.length), a.credId, a.cose)
    expect(await codeOf(asrt(await a.assert({ challenge: ch, flags: FLAG.UP | FLAG.UV | FLAG.AT, attested }), ch, stored))).toBe("malformed")
  })
  it("crossOrigin: true or topOrigin → cross_origin", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, extra: { crossOrigin: true } }), ch, stored))).toBe("cross_origin")
    const ch2 = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch2, extra: { topOrigin: ORIGIN } }), ch2, stored))).toBe("cross_origin")
  })
  it("clientData type webauthn.create on an assertion → type", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, type: "webauthn.create" }), ch, stored))).toBe("type")
  })
  it("a different credential id than the stored one → credential_id", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, id: b64(rand(32)) }), ch, stored))).toBe("credential_id")
  })
  it("id/rawId mismatch → malformed", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    const r = await a.assert({ challenge: ch })
    expect(await codeOf(asrt({ ...r, rawId: b64(rand(32)) }, ch, stored))).toBe("malformed")
  })
  for (const [name, alg] of ALGS) {
    it(`${name}: a tampered signature → signature`, async () => {
      const { a, stored } = await setup(alg)
      const ch = newChallenge()
      expect(await codeOf(asrt(await a.assert({ challenge: ch, tamperSig: true }), ch, stored))).toBe("signature")
    })
    it(`${name}: a tampered authData byte → signature`, async () => {
      const { a, stored } = await setup(alg)
      const ch = newChallenge()
      expect(await codeOf(asrt(await a.assert({ challenge: ch, tamperAuthData: true }), ch, stored))).toBe("signature")
    })
    it(`${name}: tampered clientDataJSON (same challenge/origin) → signature`, async () => {
      const { a, stored } = await setup(alg)
      const ch = newChallenge()
      expect(await codeOf(asrt(await a.assert({ challenge: ch, tamperClientData: true }), ch, stored))).toBe("signature")
    })
    it(`${name}: signed by the wrong key → signature`, async () => {
      const { a, stored } = await setup(alg)
      const other = await SoftAuthenticator.create(alg)
      const ch = newChallenge()
      expect(await codeOf(asrt(await a.assert({ challenge: ch, signWith: other }), ch, stored))).toBe("signature")
    })
  }
  it("an ES256 signature that isn't strict DER (raw r‖s) → signature", async () => {
    const { a, stored } = await setup(-7)
    const ch = newChallenge()
    const r = await a.assert({ challenge: ch })
    const der = unb64(r.response.signature)
    r.response.signature = b64(derToRawEcdsa(der))
    expect(await codeOf(asrt(r, ch, stored))).toBe("signature")
  })
  it("the stored key under a different alg → key; a garbage stored key → key", async () => {
    const { a, stored } = await setup(-7)
    const ch = newChallenge()
    const r = await a.assert({ challenge: ch })
    expect(await codeOf(asrt(r, ch, { ...stored, alg: -8 }))).toBe("key")
    expect(await codeOf(asrt(r, ch, { ...stored, publicKey: "!!" }))).toBe("key")
    expect(await codeOf(asrt(r, ch, { ...stored, publicKey: b64(cbor(new Map([[1, 2]]))) }))).toBe("algorithm")
    expect(await codeOf(asrt(r, ch, { ...stored, signCount: -1 }))).toBe("key")
    expect(await codeOf(asrt(r, ch, null as unknown as StoredCredentialKey))).toBe("key")
  })
  it("counter: stored 5 / new 5 and new 3 → counter; new 6 ok", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch, counter: 5 }), ch, { ...stored, signCount: 5 }))).toBe("counter")
    const ch2 = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch2, counter: 3 }), ch2, { ...stored, signCount: 5 }))).toBe("counter")
    const ch3 = newChallenge()
    expect((await asrt(await a.assert({ challenge: ch3, counter: 6 }), ch3, { ...stored, signCount: 5 })).newSignCount).toBe(6)
  })
  it("counter 0/0 accepted (no-counter authenticators); stored 7 / new 0 rejected; 0 → n accepted", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    expect((await asrt(await a.assert({ challenge: ch, counter: 0 }), ch, { ...stored, signCount: 0 })).newSignCount).toBe(0)
    const ch2 = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch2, counter: 0 }), ch2, { ...stored, signCount: 7 }))).toBe("counter")
    const ch3 = newChallenge()
    expect((await asrt(await a.assert({ challenge: ch3, counter: 0xffffffff }), ch3, { ...stored, signCount: 0 })).newSignCount).toBe(0xffffffff)
  })
  it("a replayed assertion fails on the counter once the store moved it", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    const r = await a.assert({ challenge: ch })
    const v = await asrt(r, ch, stored)
    expect(await codeOf(asrt(r, ch, { ...stored, signCount: v.newSignCount }))).toBe("counter")
  })
  it("signature, userHandle and authData bounds → malformed", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    const r = await a.assert({ challenge: ch })
    const variants = [
      { ...r.response, signature: "" },
      { ...r.response, signature: b64(rand(MAX_SIGNATURE_BYTES + 1)) },
      { ...r.response, signature: 5 },
      { ...r.response, userHandle: "" },
      { ...r.response, userHandle: b64(rand(MAX_USER_HANDLE_BYTES + 1)) },
      { ...r.response, userHandle: 12 },
      { ...r.response, authenticatorData: b64(rand(36)) },
      { ...r.response, authenticatorData: b64(rand(MAX_AUTH_DATA_BYTES + 1)) },
      { ...r.response, authenticatorData: b64(cat(unb64(r.response.authenticatorData), u8(0))) },
      { ...r.response, authenticatorData: undefined },
    ]
    for (const response of variants) expect(await codeOf(asrt({ ...r, response }, ch, stored))).toBe("malformed")
  })
  it("a userHandle of exactly 64 bytes is accepted and echoed", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    const uh = b64(rand(64))
    expect((await asrt(await a.assert({ challenge: ch, userHandle: uh }), ch, stored)).userHandle).toBe(uh)
  })
  it("an assertion with an extension map is accepted; a non-map extension is malformed", async () => {
    const { a, stored } = await setup()
    const ch = newChallenge()
    const ext = cbor(new Map<string, Enc>([["devicePubKey", rand(8)]]))
    expect((await asrt(await a.assert({ challenge: ch, flags: FLAG.UP | FLAG.UV | FLAG.ED, ext }), ch, stored)).newSignCount).toBe(a.counter)
    const ch2 = newChallenge()
    expect(await codeOf(asrt(await a.assert({ challenge: ch2, flags: FLAG.UP | FLAG.UV | FLAG.ED, ext: cbor([1]) }), ch2, stored))).toBe("malformed")
  })
})

describe("parseClientData", () => {
  it("returns the parsed fields and the raw bytes", () => {
    const raw = SoftAuthenticator.clientData("webauthn.get", "abc", ORIGIN)
    const cd = parseClientData(b64(raw), "webauthn.get")
    expect(cd).toEqual({ type: "webauthn.get", challenge: "abc", origin: ORIGIN, crossOrigin: false, raw })
  })
  it("rejects a clientDataJSON longer than MAX_CLIENT_DATA_BYTES before decoding", () => {
    expect(() => parseClientData("A".repeat(Math.ceil(MAX_CLIENT_DATA_BYTES * 4 / 3) + 4), "webauthn.get")).toThrow(WebAuthnError)
  })
})

describe("parseAuthenticatorData", () => {
  const base = async (flags: number, rest: Uint8Array = new Uint8Array(0), counter = 0x01020304) =>
    SoftAuthenticator.authData({ rpId: RP, flags, counter, attested: rest })

  it("parses flags and a big-endian counter", async () => {
    const ad = parseAuthenticatorData(await base(FLAG.UP | FLAG.UV | FLAG.BE | FLAG.BS, undefined, 0xfffffffe))
    expect(ad).toMatchObject({ up: true, uv: true, be: true, bs: true, at: false, ed: false, signCount: 0xfffffffe, attested: null, extensions: null })
    expect(ad.rpIdHash).toEqual(await sha256(enc.encode(RP)))
  })
  it("returns the exact COSE bytes it consumed", async () => {
    const a = await authFor(-8)
    const ad = parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(0, 32), a.credId, a.cose)))
    expect(ad.attested!.publicKey).toEqual(a.cose)
    expect(ad.attested!.credentialId).toEqual(a.credId)
    expect(ad.attested!.aaguid).toEqual(a.aaguid)
  })
  it("ignores RFU flag bits", async () => {
    expect(parseAuthenticatorData(await base(FLAG.UP | 0x02 | 0x20)).up).toBe(true)
  })
  it("rejects truncated, oversized and trailing input", async () => {
    const a = await authFor(-8)
    const good = await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(0, 32), a.credId, a.cose))
    for (let n = 0; n < good.length; n += 7) {
      expect(await codeOf(() => parseAuthenticatorData(good.slice(0, n)))).toBe("malformed")
    }
    expect(await codeOf(() => parseAuthenticatorData(cat(good, u8(0))))).toBe("malformed")
    const noEd = cat(await base(FLAG.UP), u8(0xa0))
    expect(await codeOf(() => parseAuthenticatorData(noEd))).toBe("malformed") // no ED, leftover
    expect(await codeOf(() => parseAuthenticatorData(new Uint8Array(MAX_AUTH_DATA_BYTES + 1), MAX_AUTH_DATA_BYTES))).toBe("malformed")
    expect(await codeOf(() => parseAuthenticatorData("x" as unknown as Uint8Array))).toBe("malformed")
  })
  it("credential id length: 0, over 1023, or more than what is left → malformed", async () => {
    const a = await authFor(-8)
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(0, 0), a.cose))))).toBe("malformed")
    const big = MAX_CREDENTIAL_ID_BYTES + 1
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(big >> 8, big & 255), rand(big), a.cose))))).toBe("malformed")
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(0xff, 0xff), a.credId))))).toBe("malformed")
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(0, 32), a.credId))))).toBe("malformed")
  })
  it("a credential id of exactly 1023 bytes is fine", async () => {
    const a = await authFor(-8)
    const id = rand(MAX_CREDENTIAL_ID_BYTES)
    const ad = parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(3, 255), id, a.cose)))
    expect(ad.attested!.credentialId.length).toBe(MAX_CREDENTIAL_ID_BYTES)
  })
  it("ED: one map ending exactly at the end", async () => {
    const ext = cbor(new Map<string, Enc>([["credProtect", 2]]))
    expect(parseAuthenticatorData(await base(FLAG.UP | FLAG.ED, ext)).extensions).toEqual(new Map([["credProtect", 2]]))
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.ED, cat(ext, ext))))).toBe("malformed")
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.ED)))).toBe("malformed")
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.ED, cbor("x"))))).toBe("malformed")
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.ED, u8(0xbf, 0xff))))).toBe("malformed") // indefinite map
  })
  it("a COSE key that is not a map → malformed", async () => {
    const a = await authFor(-8)
    expect(await codeOf(async () => parseAuthenticatorData(await base(FLAG.UP | FLAG.AT, cat(a.aaguid, u8(0, 32), a.credId, cbor([1, 2])))))).toBe("malformed")
  })
})

describe("COSE keys", () => {
  const cose = (entries: [number, Enc][]) => cbor(new Map<number, Enc>(entries))
  const pcode = (b: Uint8Array) => codeOf(() => parseCoseKey(b))

  it("parses the three supported kinds", async () => {
    expect(parseCoseKey((await authFor(-7)).cose)).toMatchObject({ alg: -7, kty: 2, raw: null, jwk: { kty: "EC", crv: "P-256" } })
    expect(parseCoseKey((await authFor(-257)).cose)).toMatchObject({ alg: -257, kty: 3, raw: null, jwk: { kty: "RSA", e: "AQAB" } })
    const ed = parseCoseKey((await authFor(-8)).cose)
    expect(ed.alg).toBe(-8)
    expect(ed.kty).toBe(1)
    expect(ed.jwk).toBeNull()
    expect(ed.raw!.length).toBe(32)
  })
  it("algorithm: missing alg, unknown alg, kty mismatch, wrong curve", async () => {
    expect(await pcode(cose([[1, 2], [-1, 1], [-2, rand(32)], [-3, rand(32)]]))).toBe("algorithm")
    expect(await pcode(cose([[1, 2], [3, -35], [-1, 2], [-2, rand(48)], [-3, rand(48)]]))).toBe("algorithm")
    expect(await pcode(cose([[1, 1], [3, -7], [-1, 1], [-2, rand(32)], [-3, rand(32)]]))).toBe("algorithm")
    expect(await pcode(cose([[1, 2], [3, -7], [-1, 2], [-2, rand(32)], [-3, rand(32)]]))).toBe("algorithm")
    expect(await pcode(cose([[1, 1], [3, -8], [-1, 4], [-2, rand(32)]]))).toBe("algorithm")   // X25519 curve
    expect(await pcode(cose([[1, 2], [3, -8], [-1, 6], [-2, rand(32)]]))).toBe("algorithm")
    expect(await pcode(cose([[1, 3], [3, -7], [-1, rand(256)], [-2, u8(1, 0, 1)]]))).toBe("algorithm")
    expect(await pcode(cose([[1, 2], [3, "ES256"]]))).toBe("algorithm")
  })
  it("key: bad coordinates, missing kty, bad RSA modulus or exponent, not CBOR", async () => {
    expect(await pcode(cose([[1, 2], [3, -7], [-1, 1], [-2, rand(31)], [-3, rand(32)]]))).toBe("key")
    expect(await pcode(cose([[1, 2], [3, -7], [-1, 1], [-2, rand(32)]]))).toBe("key")
    expect(await pcode(cose([[3, -7], [-1, 1], [-2, rand(32)], [-3, rand(32)]]))).toBe("key")
    expect(await pcode(cose([[1, 1], [3, -8], [-1, 6], [-2, rand(33)]]))).toBe("key")
    const n = rand(256); n[0] |= 0x80
    expect(await pcode(cose([[1, 3], [3, -257], [-1, n], [-2, u8(1, 0, 1)]]))).toBe("ok")
    expect(await pcode(cose([[1, 3], [3, -257], [-1, cat(u8(0), n)], [-2, u8(1, 0, 1)]]))).toBe("key")   // leading zero
    const short = n.slice(); short[0] = 0x01                                                            // 2041 bits
    expect(await pcode(cose([[1, 3], [3, -257], [-1, short], [-2, u8(1, 0, 1)]]))).toBe("key")
    expect(await pcode(cose([[1, 3], [3, -257], [-1, rand(128)], [-2, u8(1, 0, 1)]]))).toBe("key")     // 1024
    expect(await pcode(cose([[1, 3], [3, -257], [-1, cat(u8(0x80), rand(512))], [-2, u8(1, 0, 1)]]))).toBe("key") // > 4096
    expect(await pcode(cose([[1, 3], [3, -257], [-1, n], [-2, u8(1)]]))).toBe("key")                  // e = 1
    expect(await pcode(cose([[1, 3], [3, -257], [-1, n], [-2, u8(1, 0, 0)]]))).toBe("key")            // even
    expect(await pcode(cose([[1, 3], [3, -257], [-1, n], [-2, u8(0, 1, 0, 1)]]))).toBe("key")         // leading zero
    expect(await pcode(cose([[1, 3], [3, -257], [-1, n], [-2, u8(1, 0, 0, 0, 1)]]))).toBe("key")      // 5 bytes
    expect(await pcode(u8(0xff))).toBe("key")
    expect(await pcode(cbor([1, 2]))).toBe("key")
    expect(await pcode(cat((await authFor(-8)).cose, u8(0)))).toBe("key")                             // trailing byte
  })
  it("importCoseKey: off-curve point → key, good keys import verify-only", async () => {
    expect(await codeOf(importCoseKey(cose([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]])))).toBe("key")
    for (const [, alg] of ALGS) {
      const { key, alg: got } = await importCoseKey((await authFor(alg)).cose)
      expect(got).toBe(alg)
      expect(key.usages).toEqual(["verify"])
      expect(key.extractable).toBe(false)
    }
  })
  it("ignores extra labels, key_ops included", async () => {
    const a = await authFor(-8)
    const m = decodeCbor(a.cose) as Map<number, Enc>
    m.set(4, ["sign"]); m.set(2, rand(4))
    expect((await importCoseKey(cbor(m))).alg).toBe(-8)
  })
})

describe("derToRawEcdsa", () => {
  const der = (r: number[], s: number[], extraTotal = 0) => {
    const body = [0x02, r.length, ...r, 0x02, s.length, ...s]
    return u8(0x30, body.length + extraTotal, ...body)
  }
  const r32 = Array.from({ length: 32 }, (_, i) => i + 1)
  const dcode = (b: Uint8Array) => codeOf(() => derToRawEcdsa(b))

  it("converts and left-pads short integers", () => {
    const out = derToRawEcdsa(der([0x01], [0x7f, 0x02]))
    expect(out.length).toBe(64)
    expect(out[31]).toBe(1)
    expect(out.subarray(0, 31).every(b => b === 0)).toBe(true)
    expect([out[62], out[63]]).toEqual([0x7f, 0x02])
  })
  it("strips the single 00 pad of a high-bit integer", () => {
    const hi = [0x80, ...r32.slice(1)]
    const out = derToRawEcdsa(der([0x00, ...hi], r32))
    expect(Array.from(out.subarray(0, 32))).toEqual(hi)
    expect(Array.from(out.subarray(32))).toEqual(r32)
  })
  it("round-trips WebCrypto's raw signatures through the test encoder", async () => {
    const a = await authFor(-7)
    for (let i = 0; i < 20; i++) {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.keys.privateKey, rand(16)))
      expect(derToRawEcdsa(rawToDer(raw))).toEqual(raw)
    }
  })
  it("rejects non-minimal, negative, zero, wrong total length, 34-byte integers and junk", async () => {
    expect(await dcode(der([0x00, 0x01], r32))).toBe("signature")                     // non-minimal pad
    expect(await dcode(der([0x00, 0x00, 0x80], r32))).toBe("signature")
    expect(await dcode(der([0x80, ...r32.slice(1)], r32))).toBe("signature")         // negative
    expect(await dcode(der([0x00], r32))).toBe("signature")                           // zero
    expect(await dcode(der(r32, r32, 1))).toBe("signature")                           // total too long
    expect(await dcode(der(r32, r32, -1))).toBe("signature")                          // total too short
    expect(await dcode(der([0x00, 0x80, ...r32], r32))).toBe("signature")            // 34 bytes
    expect(await dcode(der([0x01, ...r32], r32))).toBe("signature")                  // 33 bytes, no pad
    expect(await dcode(cat(der(r32, r32), u8(0)))).toBe("signature")                  // trailing
    expect(await dcode(u8(0x31, 6, 2, 1, 1, 2, 1, 1))).toBe("signature")              // SET, not SEQUENCE
    expect(await dcode(u8(0x30, 6, 3, 1, 1, 2, 1, 1))).toBe("signature")              // not INTEGER
    expect(await dcode(u8(0x30, 0x81, 6, 2, 1, 1, 2, 1, 1))).toBe("signature")        // long form for a short length
    expect(await dcode(u8(0x30, 6, 2, 1, 1, 2, 1))).toBe("signature")                 // truncated
    expect(await dcode(new Uint8Array(0))).toBe("signature")
    expect(await dcode(rand(64))).toBe("signature")
    expect(await dcode(der([0x01], [0x01]))).toBe("ok")
  })
})

describe("CBOR decoder", () => {
  const ccode = (b: Uint8Array, l?: Partial<typeof CBOR_LIMITS>) => codeOf(() => decodeCbor(b, l))

  it("decodes the supported subset", () => {
    const v = decodeCbor(cbor(new Map<number | string, Enc>([
      [1, 2], [-1, -100], ["s", "héllo"], ["b", u8(1, 2)], ["a", [true, false, null, 0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, Number.MAX_SAFE_INTEGER]],
    ])))
    expect(v).toEqual(new Map<number | string, CborValue>([
      [1, 2], [-1, -100], ["s", "héllo"], ["b", u8(1, 2)], ["a", [true, false, null, 0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, Number.MAX_SAFE_INTEGER]],
    ]))
  })
  it("keeps map wire order and distinguishes 1 from \"1\"", () => {
    const m = decodeCbor(cbor(new Map<number | string, Enc>([["z", 1], [1, 2], ["1", 3]]))) as Map<number | string, CborValue>
    expect([...m.keys()]).toEqual(["z", 1, "1"])
  })
  it("decodeCborPrefix reports where the item ends", async () => {
    const b = cat(u8(9, 9), cbor([1, "x"]), u8(0xff))
    expect(decodeCborPrefix(b, 2)).toEqual({ value: [1, "x"], end: 2 + 4 })
    expect(await codeOf(() => decodeCborPrefix(b, b.length))).toBe("cbor")
    expect(await codeOf(() => decodeCborPrefix(b, -1))).toBe("cbor")
    expect(await codeOf(() => decodeCborPrefix(b, 1.5))).toBe("cbor")
  })
  it("rejects indefinite lengths, tags, floats, undefined and other simple values", async () => {
    for (const b of [
      u8(0x9f, 0x01, 0xff), u8(0xbf, 0xff), u8(0x5f, 0x41, 0x00, 0xff), u8(0x7f, 0xff),
      u8(0xc0, 0x60), u8(0xd8, 0x18, 0x40), u8(0xc2, 0x41, 0x01),
      u8(0xf9, 0x3c, 0x00), u8(0xfa, 0, 0, 0, 0), u8(0xfb, 0, 0, 0, 0, 0, 0, 0, 0),
      u8(0xf7), u8(0xf0), u8(0xf8, 0x20), u8(0xff),
      u8(0x1c), u8(0x1d), u8(0x1e), u8(0x1f),
    ]) expect(await ccode(b)).toBe("cbor")
  })
  it("rejects non-minimal integers and lengths", async () => {
    for (const b of [
      u8(0x18, 0x17), u8(0x19, 0x00, 0xff), u8(0x1a, 0, 0, 0xff, 0xff), u8(0x1b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff),
      u8(0x38, 0x00), u8(0x58, 0x01, 0xaa), u8(0x78, 0x00), u8(0x98, 0x00), u8(0xb8, 0x00),
    ]) expect(await ccode(b)).toBe("cbor")
    expect(await ccode(u8(0x18, 0x18))).toBe("ok")
  })
  it("rejects integers beyond MAX_SAFE_INTEGER (both signs)", async () => {
    expect(await ccode(u8(0x1b, 0x00, 0x20, 0, 0, 0, 0, 0, 0))).toBe("cbor")          // 2^53
    expect(await ccode(u8(0x1b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe("cbor")
    expect(await ccode(u8(0x3b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff))).toBe("cbor") // -2^53
    expect(decodeCbor(u8(0x3b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe))).toBe(-Number.MAX_SAFE_INTEGER)
  })
  it("rejects duplicate map keys and non-int/text keys", async () => {
    expect(await ccode(u8(0xa2, 0x01, 0x01, 0x01, 0x02))).toBe("cbor")
    expect(await ccode(u8(0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02))).toBe("cbor")
    expect(await ccode(u8(0xa1, 0x41, 0x00, 0x01))).toBe("cbor")       // bstr key
    expect(await ccode(u8(0xa1, 0x80, 0x01))).toBe("cbor")             // array key
    expect(await ccode(u8(0xa1, 0xf6, 0x01))).toBe("cbor")             // null key
  })
  it("depth: 8 nested arrays ok, 9 rejected", async () => {
    const nest = (n: number) => cat(new Uint8Array(n).fill(0x81), u8(0x00))
    expect(await ccode(nest(8))).toBe("ok")
    expect(await ccode(nest(9))).toBe("cbor")
    const maps = (n: number): Enc => n === 0 ? 0 : new Map<number, Enc>([[1, maps(n - 1)]])
    expect(await ccode(cbor(maps(8)))).toBe("ok")
    expect(await ccode(cbor(maps(9)))).toBe("cbor")
  })
  it("a bstr declaring 2^32 bytes in a 10-byte input throws at once and allocates nothing big", () => {
    const b = u8(0x5b, 0, 0, 0, 1, 0, 0, 0, 0, 0)
    const t = performance.now()
    expect(() => decodeCbor(b)).toThrow(CborError)
    expect(() => decodeCbor(u8(0x7a, 0xff, 0xff, 0xff, 0xff, 0x61))).toThrow(CborError)
    expect(performance.now() - t).toBeLessThan(50)
  })
  it("an array declaring 1e6 items (or a map of 1e6 pairs) throws before looping", () => {
    const t = performance.now()
    expect(() => decodeCbor(u8(0x9a, 0x00, 0x0f, 0x42, 0x40, 0x00))).toThrow(CborError)
    expect(() => decodeCbor(u8(0xba, 0x00, 0x0f, 0x42, 0x40, 0x00, 0x00))).toThrow(CborError)
    expect(performance.now() - t).toBeLessThan(50)
  })
  it("the running item count is capped at maxItems", async () => {
    expect(await ccode(cbor(new Array(511).fill(0)))).toBe("ok")               // 1 + 511
    expect(await ccode(cbor(new Array(512).fill(0)))).toBe("cbor")
    expect(await ccode(cbor([new Array(300).fill(0), new Array(300).fill(0)]))).toBe("cbor")
    expect(await ccode(cbor(new Array(20).fill(0)), { maxItems: 10 })).toBe("cbor")
  })
  it("input larger than maxBytes is rejected", async () => {
    expect(await ccode(cbor(new Uint8Array(CBOR_LIMITS.maxBytes)))).toBe("cbor")
    expect(await ccode(cbor(new Uint8Array(CBOR_LIMITS.maxBytes - 3)))).toBe("ok")
  })
  it("truncated input at every cut point is rejected", async () => {
    const full = cbor(new Map<number | string, Enc>([["fmt", "none"], ["attStmt", new Map()], ["authData", rand(100)], ["n", [1, 300, 70000, 2 ** 40]]]))
    for (let n = 0; n < full.length; n++) expect(await ccode(full.slice(0, n))).toBe("cbor")
  })
  it("trailing bytes are rejected by decodeCbor", async () => {
    expect(await ccode(u8(0x01, 0x00))).toBe("cbor")
  })
  it("invalid UTF-8 in a text string is rejected; a BOM is kept", async () => {
    expect(await ccode(u8(0x62, 0xc3, 0x28))).toBe("cbor")
    expect(await ccode(u8(0x63, 0xed, 0xa0, 0x80))).toBe("cbor")               // lone surrogate
    expect(decodeCbor(u8(0x63, 0xef, 0xbb, 0xbf))).toBe("﻿")
  })
  it("byte strings are copies, not views of the input", () => {
    const b = u8(0x42, 1, 2)
    const v = decodeCbor(b) as Uint8Array
    b[1] = 9
    expect(Array.from(v)).toEqual([1, 2])
  })
  it("random garbage never escapes as anything but CborError", () => {
    for (let i = 0; i < 2000; i++) {
      const b = rand(1 + (i % 40))
      try { decodeCbor(b) } catch (err) { expect(err).toBeInstanceOf(CborError) }
    }
  })
})

describe("options", () => {
  it("newChallenge: 32 random bytes, b64url, never repeats", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const c = newChallenge()
      expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(unb64(c).length).toBe(CHALLENGE_BYTES)
      seen.add(c)
    }
    expect(seen.size).toBe(100)
  })
  it("registrationOptions has the pinned shape", () => {
    const challenge = newChallenge()
    const userHandle = b64(rand(32))
    const id = b64(rand(16))
    const o = registrationOptions({
      rpId: RP, rpName: "candy", userHandle, userName: "ashwin", displayName: "ashwin", challenge,
      exclude: [{ id, transports: ["internal", "BAD", "hybrid"] }, { id }],
    })
    expect(o).toEqual({
      rp: { id: RP, name: "candy" },
      user: { id: userHandle, name: "ashwin", displayName: "ashwin" },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      timeout: DEFAULT_TIMEOUT_MS,
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: [{ type: "public-key", id, transports: ["internal", "hybrid"] }, { type: "public-key", id }],
      extensions: { credProps: true },
    })
    expect(o.pubKeyCredParams.map(p => p.alg)).toEqual([...SUPPORTED_ALGS])
    expect(registrationOptions({ rpId: RP, rpName: "candy", userHandle, userName: "a", displayName: "a", challenge, exclude: [], timeoutMs: 5000 }).timeout).toBe(5000)
  })
  it("registrationOptions refuses bad handles, challenges and ids", () => {
    const ok = { rpId: RP, rpName: "candy", userHandle: b64(rand(32)), userName: "a", displayName: "a", challenge: newChallenge(), exclude: [] as { id: string }[] }
    for (const bad of [
      { userHandle: "" }, { userHandle: b64(rand(65)) }, { userHandle: "a=" }, { challenge: "short" }, { challenge: "" },
      { rpId: "" }, { exclude: [{ id: "" }] }, { exclude: [{ id: "+/" }] },
    ]) expect(() => registrationOptions({ ...ok, ...bad })).toThrow(WebAuthnError)
  })
  it("authenticationOptions is discoverable-only with UV required", () => {
    const challenge = newChallenge()
    expect(authenticationOptions({ rpId: RP, challenge })).toEqual({
      challenge, rpId: RP, timeout: DEFAULT_TIMEOUT_MS, userVerification: "required", allowCredentials: [],
    })
    expect(() => authenticationOptions({ rpId: RP, challenge: "x" })).toThrow(WebAuthnError)
  })
  it("exports the pinned constants", () => {
    expect(SUPPORTED_ALGS).toEqual([-8, -7, -257] as CoseAlg[])
    expect(FLAG).toEqual({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 })
    expect(CBOR_LIMITS).toEqual({ maxDepth: 8, maxItems: 512, maxBytes: 16_384 })
  })
})
