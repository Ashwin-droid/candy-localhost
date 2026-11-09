import { describe, expect, it } from "bun:test"
import { JtiBloom, JWT_AUDIENCE, readCredential, signJwt, stripCandyCredentials, verifyJwt, type JwtContext } from "../server-auth.ts"

const SECRET = "s".repeat(40)
const NOW = 1_800_000_000
const STARTED = NOW - 600

const ctx = (over: Partial<JwtContext> = {}): JwtContext => ({
  secret: SECRET,
  site: "wa",
  now: NOW,
  serverStartedAt: STARTED,
  bloom: new JtiBloom(NOW - 3600),
  ...over,
})
const claims = (over: Record<string, unknown> = {}) => ({ aud: JWT_AUDIENCE, sub: "wa.candy", iat: NOW - 10, exp: NOW + 300, ...over })
const check = (c: Record<string, unknown>, over: Partial<JwtContext> = {}) => verifyJwt(signJwt(c, SECRET), ctx(over))

describe("JWT server auth", () => {
  it("accepts a valid token with each HMAC algorithm", () => {
    for (const alg of ["HS256", "HS384", "HS512"] as const) {
      expect(verifyJwt(signJwt(claims(), SECRET, alg), ctx()).ok).toBe(true)
    }
  })

  it("rejects a wrong secret, alg none and tampered claims", () => {
    expect(verifyJwt(signJwt(claims(), "x".repeat(40)), ctx())).toMatchObject({ ok: false, guess: true })
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.`
    expect(verifyJwt(none, ctx())).toMatchObject({ ok: false, guess: true })
    const [h, , s] = signJwt(claims(), SECRET).split(".")
    const forged = `${h}.${Buffer.from(JSON.stringify(claims({ sub: "other.candy" }))).toString("base64url")}.${s}`
    expect(verifyJwt(forged, ctx())).toMatchObject({ ok: false, error: "Bad token signature" })
  })

  it("checks aud and sub", () => {
    expect(check(claims({ aud: "something else" })).ok).toBe(false)
    expect(check(claims({ aud: ["x", JWT_AUDIENCE] })).ok).toBe(true)
    expect(check(claims({ sub: "wa" })).ok).toBe(false)
    expect(check(claims({ sub: "other.candy" })).ok).toBe(false)
  })

  it("requires exp in the future and at most an hour away", () => {
    expect(check(claims({ exp: undefined })).ok).toBe(false)
    expect(check(claims({ exp: NOW })).ok).toBe(false)
    expect(check(claims({ exp: NOW + 3600 })).ok).toBe(true)
    expect(check(claims({ exp: NOW + 3601 }))).toMatchObject({ ok: false, error: "exp is more than one hour away" })
  })

  it("honours nbf", () => {
    expect(check(claims({ nbf: NOW + 60 })).ok).toBe(false)
    expect(check(claims({ nbf: NOW })).ok).toBe(true)
  })

  it("requires iat after the server started, or just now for a cold start", () => {
    expect(check(claims({ iat: undefined })).ok).toBe(false)
    expect(check(claims({ iat: NOW + 60 })).ok).toBe(false)
    expect(check(claims({ iat: STARTED - 60 })).ok).toBe(false)
    expect(check(claims({ iat: STARTED - 3 })).ok).toBe(true)  // 5s grace around the start
    // Server not running yet: the token must be minted within the last 5s
    expect(check(claims({ iat: NOW - 4 }), { serverStartedAt: null }).ok).toBe(true)
    expect(check(claims({ iat: NOW - 6 }), { serverStartedAt: null }).ok).toBe(false)
  })

  it("makes tokens with a jti single-use, and leaves others reusable", () => {
    const bloom = new JtiBloom(NOW - 3600)
    const once = signJwt(claims({ jti: "abc" }), SECRET)
    expect(verifyJwt(once, ctx({ bloom })).ok).toBe(true)
    expect(verifyJwt(once, ctx({ bloom }))).toMatchObject({ ok: false, error: "Token already used (jti)" })
    expect(verifyJwt(signJwt(claims({ jti: "abd" }), SECRET), ctx({ bloom })).ok).toBe(true)
    const reusable = signJwt(claims(), SECRET)
    expect(verifyJwt(reusable, ctx({ bloom })).ok).toBe(true)
    expect(verifyJwt(reusable, ctx({ bloom })).ok).toBe(true)
  })

  it("refuses a used token replayed after a reset in the same second", () => {
    const bloom = new JtiBloom(NOW - 3600)
    const t = signJwt(claims({ jti: "same-second", iat: NOW }), SECRET)
    expect(verifyJwt(t, ctx({ bloom })).ok).toBe(true)
    bloom.reset(NOW)  // server went down within the same second
    expect(verifyJwt(t, ctx({ bloom, serverStartedAt: null })).ok).toBe(false)
    // A token minted in the next second works again
    expect(verifyJwt(signJwt(claims({ jti: "next", iat: NOW + 1 }), SECRET), ctx({ bloom, now: NOW + 1, serverStartedAt: null })).ok).toBe(true)
  })

  it("refuses tokens issued before the filter was last cleared", () => {
    const bloom = new JtiBloom(NOW - 3600)
    const t = signJwt(claims({ jti: "replay-me", iat: NOW - 2 }), SECRET)
    expect(verifyJwt(t, ctx({ bloom, serverStartedAt: null })).ok).toBe(true)
    bloom.reset(NOW)  // server went down
    expect(verifyJwt(t, ctx({ bloom, serverStartedAt: null }))).toMatchObject({ ok: false })
  })
})

describe("credentials on requests", () => {
  const basic = (pw: string) => `Basic ${Buffer.from(`any:${pw}`).toString("base64")}`

  it("reads JWTs and Basic from X-Candy-Auth, and Basic from Authorization", () => {
    const jwt = signJwt(claims(), SECRET)
    expect(readCredential(new Headers({ "X-Candy-Auth": jwt }))).toEqual({ kind: "jwt", token: jwt })
    expect(readCredential(new Headers({ "X-Candy-Auth": `Bearer ${jwt}` }))).toEqual({ kind: "jwt", token: jwt })
    expect(readCredential(new Headers({ "X-Candy-Auth": basic("p:w") }))).toEqual({ kind: "basic", password: "p:w" })
    expect(readCredential(new Headers({ Authorization: basic("pw") }))).toEqual({ kind: "basic", password: "pw" })
    expect(readCredential(new Headers({ Authorization: "Bearer app-oauth-token" }))).toBeNull()
  })

  it("reads X-Auth-Token as a JWT or a bare password", () => {
    const jwt = signJwt(claims(), SECRET)
    expect(readCredential(new Headers({ "X-Auth-Token": jwt }))).toEqual({ kind: "jwt", token: jwt })
    expect(readCredential(new Headers({ "X-Auth-Token": `Bearer ${jwt}` }))).toEqual({ kind: "jwt", token: jwt })
    expect(readCredential(new Headers({ "X-Auth-Token": "hunter2.with.dots" }))).toEqual({ kind: "basic", password: "hunter2.with.dots" })
    expect(readCredential(new Headers({ "X-Auth-Token": basic("pw") }))).toEqual({ kind: "basic", password: "pw" })
    // X-Candy-Auth wins when both are sent
    expect(readCredential(new Headers({ "X-Candy-Auth": jwt, "X-Auth-Token": "pw" }))).toEqual({ kind: "jwt", token: jwt })
  })

  it("strips candy credentials but keeps the app's own bearer token", () => {
    const h = new Headers({ "X-Candy-Auth": "a.b.c", "X-Auth-Token": "pw", "X-Candy-Verified": "n", Authorization: "Bearer app" })
    stripCandyCredentials(h)
    expect([...h.keys()]).toEqual(["authorization"])
    const b = new Headers({ Authorization: basic("pw") })
    stripCandyCredentials(b)
    expect(b.has("authorization")).toBe(false)
  })
})

describe("IP allowlists", () => {
  const { ipAllowed, ipInCidr, parseCidr } = require("../server-auth.ts")

  it("matches IPv4 and IPv6 CIDRs", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true)
    expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false)
    expect(ipInCidr("203.0.113.7", "203.0.113.7")).toBe(true)
    expect(ipInCidr("::ffff:203.0.113.7", "203.0.113.0/24")).toBe(true)
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true)
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false)
    expect(ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false)
  })

  it("rejects bad entries", () => {
    for (const bad of ["", "10.0.0.256", "10.0.0.0/33", "1.2.3", "2001:db8::/129", "x", "10.0.0.0/8/1", "1::2::3"]) {
      expect(parseCidr(bad)).toBeNull()
    }
  })

  it("always lets Tailscale and this machine through", () => {
    expect(ipAllowed("100.101.102.103", [])).toBe(true)
    expect(ipAllowed("fd7a:115c:a1e0:ab12::1", [])).toBe(true)
    expect(ipAllowed("127.0.0.1", [])).toBe(true)
    expect(ipAllowed("::1", [])).toBe(true)
    expect(ipAllowed("203.0.113.9", [])).toBe(false)
    expect(ipAllowed("203.0.113.9", ["203.0.113.0/24"])).toBe(true)
    expect(ipAllowed("100.128.0.1", [])).toBe(false)  // just outside 100.64.0.0/10
  })
})
