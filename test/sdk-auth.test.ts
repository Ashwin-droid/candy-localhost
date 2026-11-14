import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAppAuth, portalForHost, requestOrigin, safeAppPath, redirectAfterLogin, ReplayCache,
  LOGIN_PATH, CALLBACK_PATH, STATE_COOKIE, STATE_COOKIE_MAX_AGE_S, CREDENTIAL_NAME, ENV, DEFAULT_ISSUERS,
  MAX_CALLBACK_BODY, MAX_COOKIE_LENGTH, REFETCH_MIN_INTERVAL_MS, MAX_REPLAY_ENTRIES, RING_REFRESH_MS,
  sealStateCookie, type AppAuthOptions, type ReplayStore,
} from "../sdk-auth.ts"
import {
  generateKey, sealClaims, CLOCK_SKEW_S, formatKeyRing, randomB64url, b64urlEncode, b64urlDecode, encryptCompact,
  type AppClaims, type JweKey,
} from "../jwe.ts"

const T0 = 1_800_000_000_000          // ms
const SITE = "notes"
const ORIGIN = "https://notes.localhost"
const DEST = ORIGIN + CALLBACK_PATH
const PORTAL = "https://portal.localhost"
const CLEAR = `${STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`

const clock = (start = T0) => {
  let t = start
  const now = () => t
  return { now, advance: (ms: number) => { t += ms }, set: (ms: number) => { t = ms } }
}

const ringOf = (...keys: JweKey[]) => formatKeyRing(keys)

// The key the last makeAuth used: the state cookies the tests build are MAC'd with it, as login() does
let cookieKey: JweKey = generateKey()
const makeAuth = (key: JweKey, o: Partial<AppAuthOptions> = {}, c = clock()) => {
  cookieKey = key
  return { c, auth: createAppAuth({ site: SITE, keys: ringOf(key), env: {}, now: c.now, ...o }) }
}

// Mints a token the way app-auth.ts (D) does
const mint = async (key: JweKey, over: Partial<AppClaims> = {}, nowMs = T0): Promise<{ token: string; claims: AppClaims }> => {
  const iat = Math.floor(nowMs / 1000)
  const claims: AppClaims = {
    iss: PORTAL, aud: SITE, sub: "claude", amr: ["pam"], iat, exp: iat + 60, auth_time: iat - 100, superuser: false,
    jti: randomB64url(16), state: "S".repeat(32), nonce: "N".repeat(32), dest: DEST, ...over,
  }
  for (const k of Object.keys(claims) as (keyof AppClaims)[]) if (claims[k] === undefined) delete claims[k]
  return { token: await sealClaims(claims, key), claims }
}

const cookieValue = (o: { v?: number; s?: string; n?: string; d?: string; x?: string; t?: number; m?: unknown } = {}, key = cookieKey) =>
  sealStateCookie({ v: 1, s: "S".repeat(32), n: "N".repeat(32), d: DEST, x: "/after?x=1", t: T0, ...o }, key, SITE)

const callback = async (body: string, o: { cookie?: string | null; method?: string; type?: string; host?: string; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { host: o.host ?? "notes.localhost", "content-type": o.type ?? "application/x-www-form-urlencoded", ...o.headers }
  const cookie = o.cookie === undefined ? `${STATE_COOKIE}=${await cookieValue()}` : o.cookie
  if (cookie !== null) headers.cookie = cookie
  const method = o.method ?? "POST"
  return new Request(`http://notes.localhost${CALLBACK_PATH}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body })
}
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()

const decodeCookie = (setCookie: string) => {
  const value = setCookie.split(";")[0].slice(STATE_COOKIE.length + 1)
  return JSON.parse(new TextDecoder().decode(b64urlDecode(value.split(".")[0])))
}

describe("constants", () => {
  it("match the design", () => {
    expect(LOGIN_PATH).toBe("/_candy/auth/login")
    expect(CALLBACK_PATH).toBe("/_candy/auth/callback")
    expect(STATE_COOKIE).toBe("__Host-candy_auth")
    expect(STATE_COOKIE_MAX_AGE_S).toBe(600)
    expect(CREDENTIAL_NAME).toBe("candy-auth-keys")
    expect(ENV).toEqual({ site: "CANDY_AUTH_SITE", url: "CANDY_AUTH_URL", issuers: "CANDY_AUTH_ISSUERS", keys: "CANDY_AUTH_KEYS" })
    expect(DEFAULT_ISSUERS).toEqual(["https://portal.localhost", "https://portal.candy"])
    expect(MAX_CALLBACK_BODY).toBe(8192)
    expect(MAX_COOKIE_LENGTH).toBe(3000)
    expect(REFETCH_MIN_INTERVAL_MS).toBe(30_000)
    expect(MAX_REPLAY_ENTRIES).toBe(10_000)
  })
})

describe("createAppAuth options", () => {
  const key = generateKey()

  it("needs a site name", () => {
    expect(() => createAppAuth({ env: {}, keys: ringOf(key) })).toThrow("candy auth: no site name")
    expect(() => createAppAuth({ env: { CANDY_AUTH_SITE: "" } })).toThrow("candy auth: no site name")
  })

  it("refuses an invalid site name", () => {
    for (const site of ["Notes", "-x", "a..b", "a/b", "x".repeat(129), "a b", "_x"]) {
      expect(() => createAppAuth({ env: {}, site })).toThrow()
    }
  })

  it("reads site, portal and issuers from env", () => {
    const a = createAppAuth({ env: { CANDY_AUTH_SITE: "blog", CANDY_AUTH_URL: "https://portal.candy", CANDY_AUTH_ISSUERS: " https://portal.candy , https://portal.box.candy " } })
    expect(a.site).toBe("blog")
    expect(a.loginUrl({ returnTo: `https://blog.example.com${CALLBACK_PATH}`, state: "s".repeat(16) })).toStartWith("https://portal.candy/app-auth/authorize?")
  })

  it("refuses a portal or issuer that isn't a bare https origin", () => {
    for (const portal of ["http://portal.localhost", "https://portal.localhost/x", "https://portal.localhost:8443", "https://u@portal.localhost", "https://portal.localhost?x", "javascript:alert(1)", "portal.localhost"]) {
      expect(() => createAppAuth({ env: {}, site: SITE, portal })).toThrow()
      expect(() => createAppAuth({ env: {}, site: SITE, issuers: [portal] })).toThrow()
    }
    expect(() => createAppAuth({ env: {}, site: SITE, issuers: [] })).toThrow("no issuers")
    expect(() => createAppAuth({ env: {}, site: SITE, portal: "https://portal.localhost/" })).not.toThrow()
  })
})

describe("loginUrl", () => {
  const { auth } = makeAuth(generateKey())
  const state = "s".repeat(20), nonce = "n".repeat(20)

  it("builds the authorize URL with return_to, state, nonce in order", () => {
    const u = auth.loginUrl({ returnTo: DEST, state, nonce })
    expect(u).toBe(`${PORTAL}/app-auth/authorize?return_to=${encodeURIComponent(DEST)}&state=${state}&nonce=${nonce}`)
    expect([...new URL(u).searchParams.keys()]).toEqual(["return_to", "state", "nonce"])
  })

  it("leaves out a missing nonce and takes a portal override", () => {
    const u = new URL(auth.loginUrl({ returnTo: DEST, state, portal: "https://portal.candy" }))
    expect(u.origin).toBe("https://portal.candy")
    expect(u.searchParams.has("nonce")).toBe(false)
  })

  it("throws on a bad portal, returnTo, state or nonce", () => {
    expect(() => auth.loginUrl({ returnTo: DEST, state, portal: "http://portal.localhost" })).toThrow()
    expect(() => auth.loginUrl({ returnTo: DEST, state, portal: "https://portal.localhost/evil" })).toThrow()
    expect(() => auth.loginUrl({ returnTo: "http://notes.localhost/cb", state })).toThrow()
    expect(() => auth.loginUrl({ returnTo: "https://u:p@notes.localhost/cb", state })).toThrow()
    expect(() => auth.loginUrl({ returnTo: DEST, state: "short" })).toThrow()
    expect(() => auth.loginUrl({ returnTo: DEST, state: "x".repeat(16) + "&evil=1" })).toThrow()
    expect(() => auth.loginUrl({ returnTo: DEST, state, nonce: "bad nonce here!!" })).toThrow()
  })

  it("refuses a returnTo that isn't exactly the callback (the portal refuses it too)", () => {
    for (const bad of [`${ORIGIN}/cb`, `${ORIGIN}${CALLBACK_PATH}?x=1`, `${ORIGIN}${CALLBACK_PATH}?`, `${ORIGIN}${CALLBACK_PATH}#x`,
      `${ORIGIN}${CALLBACK_PATH}/`, `${ORIGIN}:8443${CALLBACK_PATH}`, `${ORIGIN}/some/redirect?to=https://evil.example`]) {
      expect(() => auth.loginUrl({ returnTo: bad, state })).toThrow("returnTo must be")
    }
  })
})

describe("login", () => {
  const req = (path: string, host = "notes.localhost") => new Request(`http://${host}${path}`, { headers: { host } })

  it("sets the state cookie with the exact attributes and redirects to the portal", async () => {
    const { auth } = makeAuth(generateKey())
    const res = await auth.login(req(`${LOGIN_PATH}?next=${encodeURIComponent("/notes/1?tab=a")}`))
    expect(res.status).toBe(302)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    const set = res.headers.get("set-cookie")!
    expect(set).toMatch(new RegExp(`^${STATE_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600$`))
    const c = decodeCookie(set)
    expect(c.v).toBe(1)
    expect(c.d).toBeUndefined()    // where the token may arrive is the callback URL itself, never the cookie
    expect(c.x).toBe("/notes/1?tab=a")
    expect(c.t).toBe(T0)
    expect(c.s).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(c.n).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.origin + loc.pathname).toBe(`${PORTAL}/app-auth/authorize`)
    expect(loc.searchParams.get("return_to")).toBe(DEST)
    expect(loc.searchParams.get("state")).toBe(c.s)
    expect(loc.searchParams.get("nonce")).toBe(c.n)
  })

  it("uses fresh state and nonce every time", async () => {
    const { auth } = makeAuth(generateKey())
    const a = decodeCookie((await auth.login(req(LOGIN_PATH))).headers.get("set-cookie")!)
    const b = decodeCookie((await auth.login(req(LOGIN_PATH))).headers.get("set-cookie")!)
    expect(a.s).not.toBe(b.s)
    expect(a.n).not.toBe(b.n)
  })

  it("sanitizes next", async () => {
    const { auth } = makeAuth(generateKey())
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "/.//evil.com", LOGIN_PATH, CALLBACK_PATH]) {
      const res = await auth.login(req(`${LOGIN_PATH}?next=${encodeURIComponent(bad)}`))
      expect(decodeCookie(res.headers.get("set-cookie")!).x).toBe("/")
    }
    const res = await auth.login(req(`${LOGIN_PATH}?next=/ignored`), { next: "/given" })
    expect(decodeCookie(res.headers.get("set-cookie")!).x).toBe("/given")
  })

  it("picks the portal for the host: .localhost, .candy, else the configured one", async () => {
    const { auth } = makeAuth(generateKey(), { portal: "https://portal.box.candy" })
    const portalOf = async (host: string, o?: { portal?: string }) => new URL((await auth.login(req(LOGIN_PATH, host), o)).headers.get("location")!).origin
    expect(await portalOf("notes.localhost")).toBe("https://portal.localhost")
    expect(await portalOf("notes.candy")).toBe("https://portal.candy")
    expect(await portalOf("notes.example.com")).toBe("https://portal.box.candy")
    expect(await portalOf("notes.example.com", { portal: "https://portal.candy" })).toBe("https://portal.candy")
  })

  it("lower-cases the host and strips :443", async () => {
    const { auth } = makeAuth(generateKey())
    const res = await auth.login(new Request(`http://x${LOGIN_PATH}`, { headers: { host: "Notes.LocalHost:443" } }))
    expect(new URL(res.headers.get("location")!).searchParams.get("return_to")).toBe(DEST)
  })

  it("answers 400 without a cookie for a missing or odd Host", async () => {
    const { auth } = makeAuth(generateKey())
    for (const host of ["notes.localhost:3000", "evil.com/x", "a b", "[::1]", "x".repeat(260)]) {
      const res = await auth.login(new Request(`http://x${LOGIN_PATH}`, { headers: { host } }))
      expect(res.status).toBe(400)
      expect(res.headers.get("set-cookie")).toBeNull()
    }
  })

  it("drops next rather than overflow the cookie", async () => {
    const { auth } = makeAuth(generateKey())
    // A 1024-char next fits; the cookie stays under the cap either way
    const res = await auth.login(req(LOGIN_PATH), { next: "/" + "a".repeat(1023) })
    const set = res.headers.get("set-cookie")!
    expect(set.split(";")[0].length).toBeLessThanOrEqual(MAX_COOKIE_LENGTH + STATE_COOKIE.length + 1)
    expect(decodeCookie(set).x).toBe("/" + "a".repeat(1023))
  })
})

describe("full round trip", () => {
  it("login → token minted like D → callback → user", async () => {
    const key = generateKey()
    const { auth, c } = makeAuth(key)
    const res = await auth.login(new Request(`http://notes.localhost${LOGIN_PATH}?next=/inbox`, { headers: { host: "notes.localhost" } }))
    const cookie = res.headers.get("set-cookie")!.split(";")[0]
    const loc = new URL(res.headers.get("location")!)
    c.advance(5_000)
    const { token } = await mint(key, { state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")!, dest: loc.searchParams.get("return_to")!, amr: ["passkey"] }, c.now())
    let seen: unknown = null
    const out = await auth.handle(await callback(form({ candy_token: token, state: loc.searchParams.get("state")! }), { cookie }), (u) => {
      seen = u
      return redirectAfterLogin(u.next, "sid=fresh; Path=/; Secure; HttpOnly; SameSite=Lax")
    })
    expect(out!.status).toBe(303)
    expect(out!.headers.get("location")).toBe("/inbox")
    expect(out!.headers.getSetCookie()).toEqual(["sid=fresh; Path=/; Secure; HttpOnly; SameSite=Lax", CLEAR])
    const u = seen as { user: string; amr: string[]; authTime: number; next: string; claims: AppClaims; ok?: unknown; clearCookie?: unknown }
    expect(u.user).toBe("claude")
    expect(u.amr).toEqual(["passkey"])
    expect(u.next).toBe("/inbox")
    expect(u.authTime).toBe((Math.floor(c.now() / 1000) - 100) * 1000)
    expect(u.claims.aud).toBe(SITE)
    expect("clearCookie" in u).toBe(false)
    expect("ok" in u).toBe(false)
  })

  it("handleCallback returns the user, next and clearCookie", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    const { token } = await mint(key)
    const r = await auth.handleCallback(await callback(form({ candy_token: token, state: "S".repeat(32) })))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.user).toBe("claude")
    expect(r.amr).toEqual(["pam"])
    expect(r.next).toBe("/after?x=1")
    expect(r.clearCookie).toBe(CLEAR)
  })

  it("a token from portal.candy is accepted with the default issuers", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    const { token } = await mint(key, { iss: "https://portal.candy" })
    expect((await auth.verify(token)).ok).toBe(true)
  })

  it("appends clearCookie even to an immutable-looking redirect", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    const { token } = await mint(key)
    const out = await auth.handle(await callback(form({ candy_token: token, state: "S".repeat(32) })), () => Response.redirect("https://notes.localhost/home", 302))
    expect(out!.status).toBe(302)
    expect(out!.headers.getSetCookie()).toEqual([CLEAR])
  })
})

describe("callback failures", () => {
  const key = generateKey()
  const S = "S".repeat(32)

  const expectFail = async (req: Request, status: number, error: string, auth = makeAuth(key).auth) => {
    const r = await auth.handleCallback(req)
    expect(r.ok).toBe(false)
    if (r.ok) return r
    expect(r.status).toBe(status as 400)
    expect(r.error).toBe(error as "state")
    expect(r.clearCookie).toBe(CLEAR)
    return r
  }

  it("replay: the same token twice → replay", async () => {
    const { auth } = makeAuth(key)
    const { token } = await mint(key)
    expect((await auth.handleCallback(await callback(form({ candy_token: token, state: S })))).ok).toBe(true)
    await expectFail(await callback(form({ candy_token: token, state: S })), 401, "replay", auth)
  })

  it("another site's ring → unknown_kid", async () => {
    const other = generateKey()
    const { token } = await mint(other)
    await expectFail(await callback(form({ candy_token: token, state: S })), 401, "unknown_kid")
  })

  it("same kid, wrong aud → audience", async () => {
    const { token } = await mint(key, { aud: "blog" })
    await expectFail(await callback(form({ candy_token: token, state: S })), 401, "audience")
  })

  it("an issuer not in the list → issuer", async () => {
    const { token } = await mint(key, { iss: "https://portal.evil.com" })
    await expectFail(await callback(form({ candy_token: token, state: S })), 401, "issuer")
  })

  it("expired → expired; issued in the future → not_yet_valid", async () => {
    const old = await mint(key, {}, T0 - 91_000)          // exp = T0-31s, + 30s skew → past
    await expectFail(await callback(form({ candy_token: old.token, state: S })), 401, "expired")
    const edge = await mint(key, {}, T0 - 89_000)         // exp + skew = T0 + 1s → still ok
    expect((await makeAuth(key).auth.handleCallback(await callback(form({ candy_token: edge.token, state: S })))).ok).toBe(true)
    const future = await mint(key, {}, T0 + 60_000)
    await expectFail(await callback(form({ candy_token: future.token, state: S })), 401, "not_yet_valid")
  })

  it("missing state cookie → 400 state", async () => {
    const { token } = await mint(key)
    await expectFail(await callback(form({ candy_token: token, state: S }), { cookie: null }), 400, "state")
    await expectFail(await callback(form({ candy_token: token, state: S }), { cookie: "other=1" }), 400, "state")
  })

  it("mismatched or missing form state → 403 state", async () => {
    const { token } = await mint(key)
    await expectFail(await callback(form({ candy_token: token, state: "X".repeat(32) })), 403, "state")
    await expectFail(await callback(form({ candy_token: token })), 403, "state")
  })

  it("two state cookies are ambiguous → 400 state", async () => {
    const { token } = await mint(key)
    const v = await cookieValue()
    await expectFail(await callback(form({ candy_token: token, state: S }), { cookie: `${STATE_COOKIE}=${v}; ${STATE_COOKIE}=${v}` }), 400, "state")
  })

  it("a stale, future, tampered, oversized or wrong-version cookie → 400 state", async () => {
    const { token } = await mint(key)
    const body = form({ candy_token: token, state: S })
    const bad = [
      await cookieValue({ t: T0 - 600_001 }),
      await cookieValue({ t: T0 + 60_000 }),
      await cookieValue({ v: 2 }),
      await cookieValue({ s: "short" }),
      await cookieValue({ n: "bad nonce!!!!!!!!!!!" }),
      await cookieValue({ t: 1.5 }),
      (await cookieValue()).slice(0, -3) + "!!!",
      (await cookieValue()) + "A",                            // not canonical b64url
      "A".repeat(MAX_COOKIE_LENGTH + 1),
      b64urlEncode(new TextEncoder().encode("[1,2]")),
      b64urlEncode(new Uint8Array([0xff, 0xfe, 0x00])),
      "",
    ]
    for (const v of bad) await expectFail(await callback(body, { cookie: `${STATE_COOKIE}=${v}` }), 400, "state")
    // A cookie exactly 600s old is still fine
    expect((await makeAuth(key).auth.handleCallback(await callback(body, { cookie: `${STATE_COOKIE}=${await cookieValue({ t: T0 - 600_000 })}` }))).ok).toBe(true)
  })

  it("a cookie whose next is unsafe is sanitized, not trusted", async () => {
    const { token } = await mint(key)
    const r = await makeAuth(key).auth.handleCallback(await callback(form({ candy_token: token, state: S }), { cookie: `${STATE_COOKIE}=${await cookieValue({ x: "//evil.com" })}` }))
    expect(r.ok && r.next).toBe("/")
  })

  it("dest mismatch → dest", async () => {
    const { token } = await mint(key, { dest: "https://notes.localhost/other" })
    await expectFail(await callback(form({ candy_token: token, state: S })), 401, "dest")
  })

  // Review finding: dest was compared with the cookie's `d`, which whoever
  // POSTs can set in their own browser. A token leaked from another path of
  // the site (minted for that path) must not log anyone in at the callback.
  it("a forged state cookie naming the token's dest doesn't help: dest is where the token arrived", async () => {
    const leakedAt = "https://notes.localhost/some/redirect?to=https://evil.example"
    const { token } = await mint(key, { dest: leakedAt })
    const forged = await cookieValue({ d: leakedAt, x: "/" })
    const r = await expectFail(await callback(form({ candy_token: token, state: S }), { cookie: `${STATE_COOKIE}=${forged}` }), 401, "dest")
    expect(r.message).not.toContain(token)
  })

  it("dest is compared with the host the callback was reached on", async () => {
    // Minted for notes.localhost, POSTed to the same app reached as notes.candy
    const { token } = await mint(key)
    await expectFail(await callback(form({ candy_token: token, state: S }), { host: "notes.candy" }), 401, "dest")
    // handleCallback called from another path than the callback
    const other = new Request("http://notes.localhost/elsewhere", {
      method: "POST", body: form({ candy_token: token, state: S }),
      headers: { host: "notes.localhost", "content-type": "application/x-www-form-urlencoded", cookie: `${STATE_COOKIE}=${await cookieValue()}` },
    })
    await expectFail(other, 401, "dest")
  })

  it("nonce mismatch or missing → nonce", async () => {
    const a = await mint(key, { nonce: "M".repeat(32) })
    await expectFail(await callback(form({ candy_token: a.token, state: S })), 401, "nonce")
    const b = await mint(key, { nonce: undefined })
    await expectFail(await callback(form({ candy_token: b.token, state: S })), 401, "nonce")
  })

  it("a token whose state differs from the cookie → state", async () => {
    const { token } = await mint(key, { state: "Z".repeat(32) })
    await expectFail(await callback(form({ candy_token: token, state: S })), 401, "state")
  })

  it("error=access_denied → 403 denied, and other errors aren't echoed", async () => {
    const r = await expectFail(await callback(form({ error: "access_denied", state: S })), 403, "denied")
    expect(r.message).toBe("You cancelled signing in.")
    const r2 = await expectFail(await callback(form({ error: "<script>x</script>", state: S })), 403, "denied")
    expect(r2.message).not.toContain("script")
    // An error with the wrong state is a state failure first
    await expectFail(await callback(form({ error: "access_denied", state: "X".repeat(32) })), 403, "state")
  })

  it("GET or another method → 400 bad_request", async () => {
    await expectFail(await callback("", { method: "GET" }), 400, "bad_request")
    await expectFail(await callback(form({ candy_token: "x", state: S }), { method: "PUT" }), 400, "bad_request")
  })

  it("a token in the query string is never read", async () => {
    const { token } = await mint(key)
    const req = new Request(`http://notes.localhost${CALLBACK_PATH}?candy_token=${token}&state=${S}`, {
      method: "POST", headers: { host: "notes.localhost", "content-type": "application/x-www-form-urlencoded", cookie: `${STATE_COOKIE}=${await cookieValue()}` }, body: "",
    })
    await expectFail(req, 403, "state")
  })

  it("wrong content type → 400 bad_request", async () => {
    const { token } = await mint(key)
    for (const type of ["application/json", "text/plain", "multipart/form-data; boundary=x", ""]) {
      await expectFail(await callback(form({ candy_token: token, state: S }), { type }), 400, "bad_request")
    }
    // Parameters on the right type are fine
    expect((await makeAuth(key).auth.handleCallback(await callback(form({ candy_token: token, state: S }), { type: "Application/X-WWW-Form-Urlencoded; charset=UTF-8" }))).ok).toBe(true)
  })

  it("a 9000-byte body → 400 bad_request (declared or streamed)", async () => {
    const big = form({ candy_token: "a".repeat(9000), state: S })
    await expectFail(await callback(big), 400, "bad_request")
    // No Content-Length: counted while reading
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) { for (let i = 0; i < 10; i++) ctl.enqueue(new Uint8Array(1000).fill(0x61)); ctl.close() },
    })
    const req = new Request(`http://notes.localhost${CALLBACK_PATH}`, {
      method: "POST", headers: { host: "notes.localhost", "content-type": "application/x-www-form-urlencoded", cookie: `${STATE_COOKIE}=${await cookieValue()}` }, body: stream,
    })
    expect(req.headers.get("content-length")).toBeNull()
    await expectFail(req, 400, "bad_request")
    // A lying Content-Length
    await expectFail(await callback(form({ candy_token: "x", state: S }), { headers: { "content-length": "99999999999999" } }), 400, "bad_request")
  })

  it("duplicated fields → 400 bad_request", async () => {
    const { token } = await mint(key)
    await expectFail(await callback(`candy_token=${token}&state=${S}&state=${S}`), 400, "bad_request")
    await expectFail(await callback(`candy_token=${token}&candy_token=${token}&state=${S}`), 400, "bad_request")
  })

  it("invalid UTF-8 in the body → 400 bad_request", async () => {
    const req = new Request(`http://notes.localhost${CALLBACK_PATH}`, {
      method: "POST", headers: { host: "notes.localhost", "content-type": "application/x-www-form-urlencoded", cookie: `${STATE_COOKIE}=${await cookieValue()}` },
      body: new Uint8Array([0x73, 0x3d, 0xff, 0xfe]),
    })
    await expectFail(req, 400, "bad_request")
  })

  it("missing candy_token → malformed", async () => {
    await expectFail(await callback(form({ state: S })), 401, "malformed")
  })

  it("never echoes the token or key in messages or responses", async () => {
    const { auth } = makeAuth(key)
    const { token } = await mint(key, { aud: "blog" })
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BA" : "AA")
    const keyText = b64urlEncode(key.key)
    for (const t of [token, tampered, token + "x", "a.b.c.d.e"]) {
      const r = await auth.handleCallback(await callback(form({ candy_token: t, state: S })))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message).not.toContain(t)
        expect(r.message).not.toContain(keyText)
      }
      const res = (await auth.handle(await callback(form({ candy_token: t, state: S })), () => new Response("no")))!
      const text = await res.text()
      expect(text).not.toContain(t)
      expect(text).not.toContain(keyText)
      expect(res.headers.get("content-type")).toStartWith("text/plain")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.getSetCookie()).toEqual([CLEAR])
    }
  })
})

describe("verify: hostile tokens", () => {
  const key = generateKey()

  it("rejects wrong types, truncated, oversized and tampered tokens", async () => {
    const { auth } = makeAuth(key)
    const { token } = await mint(key)
    expect((await auth.verify(123 as unknown as string)).ok).toBe(false)
    expect((await auth.verify(null as unknown as string)).ok).toBe(false)
    const r1 = await auth.verify("")
    expect(!r1.ok && r1.error).toBe("malformed")
    const r2 = await auth.verify(token.slice(0, token.length - 10))
    expect(r2.ok).toBe(false)
    const r3 = await auth.verify("a".repeat(4097))
    expect(!r3.ok && r3.error).toBe("malformed")
    const r4 = await auth.verify(token.split(".").slice(0, 4).join("."))
    expect(!r4.ok && r4.error).toBe("malformed")
    // Flip a ciphertext byte → decrypt
    const parts = token.split(".")
    const ct = b64urlDecode(parts[3])
    ct[0] ^= 1
    parts[3] = b64urlEncode(ct)
    const r5 = await auth.verify(parts.join("."))
    expect(!r5.ok && r5.error).toBe("decrypt")
    // Flip a tag byte → decrypt
    const p2 = token.split(".")
    const tag = b64urlDecode(p2[4])
    tag[15] ^= 0x80
    p2[4] = b64urlEncode(tag)
    const r6 = await auth.verify(p2.join("."))
    expect(!r6.ok && r6.error).toBe("decrypt")
    // The untouched token still works afterwards (failures don't burn its jti)
    expect((await auth.verify(token)).ok).toBe(true)
  })

  it("rejects alg none / other enc as unsupported", async () => {
    const { auth } = makeAuth(key)
    const hdr = (h: object) => b64urlEncode(new TextEncoder().encode(JSON.stringify(h)))
    const { token } = await mint(key)
    const [, , iv, ct, tag] = token.split(".")
    const none = [hdr({ alg: "none", enc: "A256GCM", kid: key.kid, typ: "JWT" }), "", iv, ct, tag].join(".")
    const r = await auth.verify(none)
    expect(!r.ok && r.error).toBe("unsupported")
    const a128 = [hdr({ alg: "dir", enc: "A128GCM", kid: key.kid, typ: "JWT" }), "", iv, ct, tag].join(".")
    const r2 = await auth.verify(a128)
    expect(!r2.ok && r2.error).toBe("unsupported")
  })

  it("rejects a token with valid encryption but bad claims", async () => {
    const { auth } = makeAuth(key)
    const t = await encryptCompact(new TextEncoder().encode(JSON.stringify({ sub: "root" })), key)
    const r = await auth.verify(t)
    expect(!r.ok && r.error).toBe("claims")
  })

  it("expect.state/nonce/dest are checked only when given", async () => {
    const { auth } = makeAuth(key)
    const a = await mint(key)
    expect((await auth.verify(a.token)).ok).toBe(true)
    const b = await mint(key)
    const r = await auth.verify(b.token, { state: "other".repeat(4) })
    expect(!r.ok && r.error).toBe("state")
    const r2 = await auth.verify(b.token, { dest: "https://notes.localhost/x" })
    expect(!r2.ok && r2.error).toBe("dest")
    const r3 = await auth.verify(b.token, { nonce: "o".repeat(20) })
    expect(!r3.ok && r3.error).toBe("nonce")
    // None of those burned the jti: replay is checked last
    expect((await auth.verify(b.token, { state: "S".repeat(32), nonce: "N".repeat(32), dest: DEST })).ok).toBe(true)
    const again = await auth.verify(b.token)
    expect(!again.ok && again.error).toBe("replay")
  })

  it("uses an injected (async) replay store; a throwing store fails closed", async () => {
    const calls: [string, number][] = []
    const store: ReplayStore = { checkAndRecord: async (jti, exp) => { calls.push([jti, exp]); return true } }
    const { auth } = makeAuth(key, { replay: store })
    const { token, claims } = await mint(key)
    expect((await auth.verify(token)).ok).toBe(true)
    expect((await auth.verify(token)).ok).toBe(true)        // the store said "first time" twice
    expect(calls).toEqual([[claims.jti, (claims.exp + 30) * 1000], [claims.jti, (claims.exp + 30) * 1000]])
    const broken = makeAuth(key, { replay: { checkAndRecord: () => { throw new Error("down") } } }).auth
    const r = await broken.verify((await mint(key)).token)
    expect(!r.ok && r.error).toBe("replay")
  })
})

describe("key resolution", () => {
  const optKey = generateKey(), credKey = generateKey(), envKey = generateKey(), fetchKey = generateKey()
  const dir = mkdtempSync(join(tmpdir(), "sdk-auth-"))
  const credDir = join(dir, "creds")
  const { mkdirSync } = require("node:fs") as typeof import("node:fs")
  mkdirSync(credDir)
  writeFileSync(join(credDir, CREDENTIAL_NAME), ringOf(credKey) + "\n")

  const works = async (auth: ReturnType<typeof createAppAuth>, key: JweKey) => (await auth.verify((await mint(key)).token)).ok

  it("option beats credential file beats env beats fetch", async () => {
    let fetched = 0
    const fetchKeys = async () => { fetched++; return ringOf(fetchKey) }
    const env = { CREDENTIALS_DIRECTORY: credDir, CANDY_AUTH_KEYS: ringOf(envKey) }
    const base = { site: SITE, now: clock().now, fetchKeys }

    const a = createAppAuth({ ...base, env, keys: ringOf(optKey) })
    expect(await works(a, optKey)).toBe(true)
    expect(fetched).toBe(0)
    // A kid outside the configured ring triggers the refetch (and the fetched ring doesn't have it either)
    expect(await works(a, credKey)).toBe(false)
    expect(fetched).toBe(1)
    fetched = 0

    const b = createAppAuth({ ...base, env })
    expect(await works(b, credKey)).toBe(true)

    const c = createAppAuth({ ...base, env: { CANDY_AUTH_KEYS: ringOf(envKey) } })
    expect(await works(c, envKey)).toBe(true)
    expect(fetched).toBe(0)

    const d = createAppAuth({ ...base, env: {} })
    expect(await works(d, fetchKey)).toBe(true)
    expect(fetched).toBe(1)
    // Cached: no more fetches
    expect(await works(d, fetchKey)).toBe(true)
    expect(fetched).toBe(1)
  })

  it("uses the default file reader with CREDENTIALS_DIRECTORY (trailing slash ok)", async () => {
    const a = createAppAuth({ site: SITE, now: clock().now, env: { CREDENTIALS_DIRECTORY: credDir + "/" } })
    expect(await works(a, credKey)).toBe(true)
  })

  it("skips a malformed or missing source and goes to the next", async () => {
    const reads: string[] = []
    const a = createAppAuth({
      site: SITE, now: clock().now,
      env: { CREDENTIALS_DIRECTORY: "/nope", CANDY_AUTH_KEYS: ringOf(envKey) },
      readFile: (p) => { reads.push(p); return "garbage:!!" },
      keys: "not a ring",
    })
    expect(await works(a, envKey)).toBe(true)
    expect(reads).toEqual([`/nope/${CREDENTIAL_NAME}`])
  })

  it("nothing configured → no_keys; a failing fetch → no_keys without detail", async () => {
    const a = createAppAuth({ site: SITE, env: {}, now: clock().now })
    const r = await a.verify((await mint(envKey)).token)
    expect(!r.ok && r.error).toBe("no_keys")
    const secret = ringOf(fetchKey)
    const b = createAppAuth({ site: SITE, env: {}, now: clock().now, fetchKeys: async () => { throw new Error(secret) } })
    const r2 = await b.verify((await mint(envKey)).token)
    expect(!r2.ok && r2.error).toBe("no_keys")
    expect(!r2.ok && r2.message).not.toContain(secret)
    const c = createAppAuth({ site: SITE, env: {}, now: clock().now, fetchKeys: async () => "bogus:" + "x".repeat(10) })
    const r3 = await c.verify((await mint(envKey)).token)
    expect(!r3.ok && r3.error).toBe("no_keys")
  })

  it("refetches on unknown_kid at most once per 30s", async () => {
    const c = clock()
    const oldKey = generateKey(), newKey = generateKey(), newer = generateKey()
    let ring = ringOf(newKey, oldKey)
    let fetched = 0
    const a = createAppAuth({ site: SITE, env: { CANDY_AUTH_KEYS: ringOf(oldKey) }, now: c.now, fetchKeys: async () => { fetched++; return ring } })
    expect(await works(a, oldKey)).toBe(true)
    expect(fetched).toBe(0)
    // Rotated: unknown kid → one fetch → ok
    expect((await a.verify((await mint(newKey, {}, c.now())).token)).ok).toBe(true)
    expect(fetched).toBe(1)
    // Another unknown kid within 30s: no fetch
    ring = ringOf(newer, newKey)
    c.advance(REFETCH_MIN_INTERVAL_MS - 1)
    const r = await a.verify((await mint(newer, {}, c.now())).token)
    expect(!r.ok && r.error).toBe("unknown_kid")
    expect(fetched).toBe(1)
    // After 30s: fetched again
    c.advance(1)
    expect((await a.verify((await mint(newer, {}, c.now())).token)).ok).toBe(true)
    expect(fetched).toBe(2)
    // A random kid never in any ring: one fetch per 30s, still unknown_kid
    c.advance(REFETCH_MIN_INTERVAL_MS)
    const stranger = generateKey()
    for (let i = 0; i < 5; i++) {
      const x = await a.verify((await mint(stranger, {}, c.now())).token)
      expect(!x.ok && x.error).toBe("unknown_kid")
    }
    expect(fetched).toBe(3)
  })

  // Review finding: a retired key stayed in a running app forever (only
  // unknown_kid refetched, and a refetch kept the old key)
  it("refreshes the ring every RING_REFRESH_MS, so a key the daemon pruned leaves the app too", async () => {
    const c = clock()
    const oldKey = generateKey(), newKey = generateKey()
    let ring = ringOf(oldKey)
    let fetched = 0
    const a = createAppAuth({ site: SITE, env: { CANDY_AUTH_KEYS: ringOf(oldKey) }, now: c.now, fetchKeys: async () => { fetched++; return ring } })
    expect(await works(a, oldKey)).toBe(true)
    expect(fetched).toBe(0)
    // The daemon rotated and later pruned the old key; no token with the new kid came in
    ring = ringOf(newKey)
    c.advance(RING_REFRESH_MS - 1)
    expect((await a.verify((await mint(oldKey, {}, c.now())).token)).ok).toBe(true)
    expect(fetched).toBe(0)
    c.advance(1)
    const r = await a.verify((await mint(oldKey, {}, c.now())).token)
    expect(!r.ok && r.error).toBe("unknown_kid")
    expect(fetched).toBeGreaterThanOrEqual(1)
    expect((await a.verify((await mint(newKey, {}, c.now())).token)).ok).toBe(true)
  })

  it("a retired key in the ring opens only tokens issued before it was retired", async () => {
    const c = clock()
    const cur = generateKey(), old = generateKey()
    const retired = Math.floor(T0 / 1000)
    const a = createAppAuth({ site: SITE, env: {}, keys: ringOf(cur, { ...old, retired }), now: c.now })
    // In flight at the rotation: still fine
    expect((await a.verify((await mint(old, {}, T0 - 5_000)).token)).ok).toBe(true)
    // Made with the old key after the rotation (a leaked key): refused, whatever the app's ring says
    c.advance(120_000)
    const forged = await a.verify((await mint(old, { sub: "root" }, T0 + 120_000)).token)
    expect(!forged.ok && forged.error).toBe("unknown_kid")
    expect((await a.verify((await mint(cur, {}, c.now())).token)).ok).toBe(true)
  })

  it("concurrent verifies share one fetch", async () => {
    let fetched = 0
    const k = generateKey()
    const a = createAppAuth({ site: SITE, env: {}, now: clock().now, fetchKeys: async () => { fetched++; await Bun.sleep(5); return ringOf(k) } })
    const tokens = await Promise.all([1, 2, 3, 4].map(() => mint(k)))
    const out = await Promise.all(tokens.map(t => a.verify(t.token)))
    expect(out.every(r => r.ok)).toBe(true)
    expect(fetched).toBe(1)
  })

  it("cleans up", () => { rmSync(dir, { recursive: true, force: true }) })
})

describe("ReplayCache", () => {
  it("is single use until the entry expires", () => {
    const c = clock()
    const r = new ReplayCache(10, c.now)
    expect(r.checkAndRecord("j1", T0 + 1000)).toBe(true)
    expect(r.checkAndRecord("j1", T0 + 1000)).toBe(false)
    expect(r.size).toBe(1)
    c.advance(1000)
    expect(r.checkAndRecord("j1", T0 + 5000)).toBe(true)
  })

  it("refuses empty or non-string jti", () => {
    const r = new ReplayCache()
    expect(r.checkAndRecord("", T0)).toBe(false)
    expect(r.checkAndRecord(5 as unknown as string, T0)).toBe(false)
  })

  it("drops expired entries first, then evicts the one expiring soonest", () => {
    const c = clock()
    const r = new ReplayCache(3, c.now)
    r.checkAndRecord("a", T0 + 10)
    r.checkAndRecord("b", T0 + 5000)
    r.checkAndRecord("c", T0 + 3000)
    c.advance(20)                            // "a" expired
    expect(r.checkAndRecord("d", T0 + 9000)).toBe(true)
    expect(r.size).toBe(3)
    expect(r.checkAndRecord("b", T0 + 5000)).toBe(false)
    // Full of live entries: "c" (soonest) goes
    expect(r.checkAndRecord("e", T0 + 9000)).toBe(true)
    expect(r.size).toBe(3)
    expect(r.checkAndRecord("c", T0 + 3000)).toBe(true)
  })

  it("stays bounded", () => {
    const r = new ReplayCache(100, () => T0)
    for (let i = 0; i < 1000; i++) r.checkAndRecord("j" + i, T0 + 60_000 + i)
    expect(r.size).toBe(100)
    expect(() => new ReplayCache(0)).toThrow()
  })
})

describe("handle", () => {
  const key = generateKey()

  it("routes login and callback, ignores everything else", async () => {
    const { auth } = makeAuth(key)
    const never = () => { throw new Error("no") }
    expect(await auth.handle(new Request("http://notes.localhost/", { headers: { host: "notes.localhost" } }), never)).toBeNull()
    expect(await auth.handle(new Request("http://notes.localhost/_candy/auth/loginx", { headers: { host: "notes.localhost" } }), never)).toBeNull()
    const login = (await auth.handle(new Request(`http://notes.localhost${LOGIN_PATH}`, { headers: { host: "notes.localhost" } }), never))!
    expect(login.status).toBe(302)
    const post = (await auth.handle(new Request(`http://notes.localhost${LOGIN_PATH}`, { method: "POST", headers: { host: "notes.localhost" } }), never))!
    expect(post.status).toBe(405)
    const get = (await auth.handle(await callback("", { method: "GET" }), never))!
    expect(get.status).toBe(400)
    expect(get.headers.getSetCookie()).toEqual([CLEAR])
  })

  it("works as a Workers-style fetch handler", async () => {
    const env = { CANDY_AUTH: createAppAuth({ site: SITE, env: { CANDY_AUTH_KEYS: ringOf(key) }, now: () => T0 }) }
    const worker = {
      async fetch(request: Request, e: typeof env) {
        const r = await e.CANDY_AUTH.handle(request, (u) => redirectAfterLogin(u.next, `sid=${u.user}`))
        if (r) return r
        return new Response("app")
      },
    }
    expect(await (await worker.fetch(new Request("http://notes.localhost/x", { headers: { host: "notes.localhost" } }), env)).text()).toBe("app")
    const { token } = await mint(key)
    const res = await worker.fetch(await callback(form({ candy_token: token, state: "S".repeat(32) })), env)
    expect(res.status).toBe(303)
    expect(res.headers.getSetCookie()).toEqual(["sid=claude", CLEAR])
  })
})

describe("helpers", () => {
  it("portalForHost", () => {
    expect(portalForHost("notes.localhost", "https://f")).toBe("https://portal.localhost")
    expect(portalForHost("NOTES.LOCALHOST:443", "https://f")).toBe("https://portal.localhost")
    expect(portalForHost("a.b.localhost", "https://f")).toBe("https://portal.localhost")
    expect(portalForHost("notes.candy", "https://f")).toBe("https://portal.candy")
    expect(portalForHost("notes.box.candy", "https://f")).toBe("https://portal.candy")
    // A bound domain (or anything else) goes to the tailnet portal, never a public host
    expect(portalForHost("notes.example.com", "https://f")).toBe("https://portal.candy")
    expect(portalForHost("notes.example.com", "https://portal.localhost")).toBe("https://portal.candy")
    expect(portalForHost("notes.example.com", "https://portal.candy")).toBe("https://portal.candy")
    expect(portalForHost("notes.example.com", "https://portal.box.candy")).toBe("https://portal.box.candy")
    expect(portalForHost("notes.example.com", "https://candy.example.com")).toBe("https://portal.candy")
    expect(portalForHost("notes.example.com", "https://portal.evil.com")).toBe("https://portal.candy")
    expect(portalForHost("notes.example.com", "https://portal.candy:8443")).toBe("https://portal.candy")
    expect(portalForHost("localhost.evil.com", "https://f")).toBe("https://portal.candy")
    expect(portalForHost("evilcandy", "https://f")).toBe("https://portal.candy")
    expect(portalForHost("", "https://f")).toBe("https://portal.candy")
  })

  it("safeAppPath", () => {
    for (const bad of ["//evil", "/\\evil", "https://x", "http://x/y", "javascript:alert(1)", "evil", "", "/.//evil.com", "/a\nb", "/a\u0000", "/a\\b",
      "/" + "a".repeat(1024), LOGIN_PATH, CALLBACK_PATH + "?x=1", null, undefined, 5, ["/x"], {}]) {
      expect(safeAppPath(bad)).toBe("/")
    }
    expect(safeAppPath("/")).toBe("/")
    expect(safeAppPath("/a/b?c=d&e=f")).toBe("/a/b?c=d&e=f")
    expect(safeAppPath("/a#frag")).toBe("/a")
    expect(safeAppPath("/a/../b")).toBe("/b")
    expect(safeAppPath("/%2F%2Fevil.com")).toBe("/%2F%2Fevil.com")
  })

  it("requestOrigin", () => {
    const r = (host?: string) => new Request("http://x/", { headers: host === undefined ? {} : { host } })
    expect(requestOrigin(r("Notes.Localhost"))).toBe("https://notes.localhost")
    expect(requestOrigin(r("notes.localhost:443"))).toBe("https://notes.localhost")
    expect(requestOrigin(r("my_site.example.com"))).toBe("https://my_site.example.com")
    for (const bad of ["notes.localhost:8443", "a b", "a/b", "a@b", "-a.com", "a..b", "[::1]", "x".repeat(254)]) {
      expect(() => requestOrigin(r(bad))).toThrow()
    }
    const noHost = new Request("http://x/")
    noHost.headers.delete("host")
    if (!noHost.headers.get("host")) expect(() => requestOrigin(noHost)).toThrow()
  })

  it("redirectAfterLogin", () => {
    const res = redirectAfterLogin("/inbox?x=1", ["a=1", "b=2"])
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/inbox?x=1")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"])
    expect(redirectAfterLogin("//evil.com").headers.get("location")).toBe("/")
    expect(redirectAfterLogin("/x", "c=3").headers.getSetCookie()).toEqual(["c=3"])
    expect(redirectAfterLogin("/x").headers.getSetCookie()).toEqual([])
  })
})

// max_age: the app's freshness demand, kept in its own cookie; superuser in the result
describe("maxAge and superuser", () => {
  const start = async (auth: ReturnType<typeof createAppAuth>, o: { maxAge?: number } = {}) => {
    const res = await auth.login(new Request(`http://notes.localhost${LOGIN_PATH}?next=/pay`, { headers: { host: "notes.localhost" } }), o)
    return { res, cookie: res.headers.get("set-cookie")!.split(";")[0], loc: new URL(res.headers.get("location")!) }
  }
  const back = async (auth: ReturnType<typeof createAppAuth>, key: JweKey, s: Awaited<ReturnType<typeof start>>, over: Partial<AppClaims>, nowMs: number) => {
    const { token } = await mint(key, { state: s.loc.searchParams.get("state")!, nonce: s.loc.searchParams.get("nonce")!, dest: s.loc.searchParams.get("return_to")!, ...over }, nowMs)
    return auth.handleCallback(await callback(form({ candy_token: token, state: s.loc.searchParams.get("state")! }), { cookie: s.cookie }))
  }

  it("puts max_age in the authorize URL and the state cookie; refuses out-of-range values", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    const s = await start(auth, { maxAge: 300 })
    expect(s.loc.searchParams.get("max_age")).toBe("300")
    expect(decodeCookie(s.res.headers.get("set-cookie")!).m).toBe(300)
    expect((await start(auth)).loc.searchParams.has("max_age")).toBe(false)
    expect(auth.loginUrl({ returnTo: DEST, state: "S".repeat(16), maxAge: 0 })).toContain("max_age=0")
    for (const bad of [-1, 86401, 1.5, NaN]) {
      expect(() => auth.loginUrl({ returnTo: DEST, state: "S".repeat(16), maxAge: bad })).toThrow()
      expect(() => createAppAuth({ site: SITE, keys: ringOf(key), env: {}, maxAge: bad })).toThrow()
    }
    // A default on createAppAuth, used by handle()
    const d = createAppAuth({ site: SITE, keys: ringOf(key), env: {}, now: () => T0, maxAge: 60 })
    const r = await d.handle(new Request(`http://notes.localhost${LOGIN_PATH}`, { headers: { host: "notes.localhost" } }), () => new Response("x"))
    expect(new URL(r!.headers.get("location")!).searchParams.get("max_age")).toBe("60")
    const per = await d.handle(new Request(`http://notes.localhost${LOGIN_PATH}`, { headers: { host: "notes.localhost" } }), () => new Response("x"), { maxAge: 0 })
    expect(new URL(per!.headers.get("location")!).searchParams.get("max_age")).toBe("0")
  })

  it("a token whose auth_time is older than the cookie's maxAge is stale_auth, even if the browser stripped max_age", async () => {
    const key = generateKey()
    const { auth, c } = makeAuth(key)
    const s = await start(auth, { maxAge: 60 })
    c.advance(5_000)
    // auth_time 10 minutes ago: the portal never saw max_age (stripped), so it didn't force a fresh login
    const nowS = Math.floor(c.now() / 1000)
    const stale = await back(auth, key, s, { auth_time: nowS - 600 }, c.now())
    expect(stale).toMatchObject({ ok: false, status: 401, error: "stale_auth" })
    // within maxAge + skew: fine
    const s2 = await start(auth, { maxAge: 60 })
    expect((await back(auth, key, s2, { auth_time: nowS - 60 - CLOCK_SKEW_S }, c.now())).ok).toBe(true)
  })

  it("maxAge 0: only an authentication made after this sign-in started", async () => {
    const key = generateKey()
    const { auth, c } = makeAuth(key)
    const s = await start(auth, { maxAge: 0 })
    const startedS = Math.floor(c.now() / 1000)
    c.advance(120_000)
    expect((await back(auth, key, s, { auth_time: startedS - CLOCK_SKEW_S - 1 }, c.now()))).toMatchObject({ ok: false, error: "stale_auth" })
    const s2 = await start(auth, { maxAge: 0 })
    c.advance(120_000)
    expect((await back(auth, key, s2, { auth_time: Math.floor(c.now() / 1000) - 60 }, c.now())).ok).toBe(true)
  })

  it("verify(token, { maxAge }) checks it explicitly; a stale token doesn't burn its jti", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    const { token } = await mint(key, { auth_time: Math.floor(T0 / 1000) - 3600 })
    expect(await auth.verify(token, { maxAge: 60 })).toMatchObject({ ok: false, error: "stale_auth" })
    expect(await auth.verify(token, { maxAge: 3600 })).toMatchObject({ ok: true })
  })

  it("returns superuser from the token", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    expect(await auth.verify((await mint(key, { superuser: true })).token)).toMatchObject({ ok: true, user: "claude", superuser: true })
    expect(await auth.verify((await mint(key, { superuser: false })).token)).toMatchObject({ ok: true, superuser: false })
  })

  it("a cookie with a bad m is not ours", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    const { token } = await mint(key)
    const r = await auth.handleCallback(await callback(form({ candy_token: token, state: "S".repeat(32) }), { cookie: `${STATE_COOKIE}=${await cookieValue({ m: -5 } as any)}` }))
    expect(r).toMatchObject({ ok: false, error: "state" })
  })
})

// Review finding (sdk-maxage.ts): the state cookie was plain base64, so the browser
// could drop m (maxAge) or back-date t and pass a stale login through handleCallback.
describe("the state cookie is authenticated", () => {
  const startLogin = async (auth: ReturnType<typeof createAppAuth>, o: { maxAge?: number } = {}) => {
    const res = await auth.login(new Request(`http://notes.localhost${LOGIN_PATH}`, { headers: { host: "notes.localhost" } }), o)
    const raw = res.headers.get("set-cookie")!.split(";")[0].slice(STATE_COOKIE.length + 1)
    return { loc: new URL(res.headers.get("location")!), raw }
  }
  const staleToken = async (key: JweKey, loc: URL, nowMs: number) =>
    (await mint(key, { state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")!, dest: loc.searchParams.get("return_to")!, auth_time: Math.floor(nowMs / 1000) - 6 * 86400 }, nowMs)).token
  const post = (token: string, state: string, cookie: string) => new Request(`https://notes.localhost${CALLBACK_PATH}`, {
    method: "POST", headers: { host: "notes.localhost", "content-type": "application/x-www-form-urlencoded", cookie: `${STATE_COOKIE}=${cookie}` },
    body: form({ candy_token: token, state }),
  })
  const edit = (raw: string, f: (o: any) => void) => {
    const [body] = raw.split(".")
    const o = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
    f(o)
    return [b64urlEncode(new TextEncoder().encode(JSON.stringify(o))), ...raw.split(".").slice(1)].join(".")
  }

  it("the PoC: dropping m from the cookie is refused (state), and the app's default maxAge holds anyway", async () => {
    const key = generateKey()
    const { auth, c } = makeAuth(key, { maxAge: 60 })
    const { loc, raw } = await startLogin(auth)
    const token = await staleToken(key, loc, c.now())
    const forged = edit(raw, o => { delete o.m })
    expect(await auth.handleCallback(post(token, loc.searchParams.get("state")!, forged))).toMatchObject({ ok: false, status: 400, error: "state" })
    // An unsigned cookie of the old format is refused too
    const unsigned = raw.split(".")[0]
    expect(await auth.handleCallback(post(token, loc.searchParams.get("state")!, unsigned))).toMatchObject({ ok: false, error: "state" })
    // The genuine cookie with the stale token: stale_auth
    expect(await auth.handleCallback(post(token, loc.searchParams.get("state")!, raw))).toMatchObject({ ok: false, error: "stale_auth" })
  })

  it("the default maxAge is enforced even when the cookie (genuinely) has no m", async () => {
    const key = generateKey()
    const { c } = makeAuth(key)
    const plain = createAppAuth({ site: SITE, keys: ringOf(key), env: {}, now: c.now })
    const { loc, raw } = await startLogin(plain)                      // made without maxAge
    const strict = createAppAuth({ site: SITE, keys: ringOf(key), env: {}, now: c.now, maxAge: 60 })
    expect(await strict.handleCallback(post(await staleToken(key, loc, c.now()), loc.searchParams.get("state")!, raw))).toMatchObject({ ok: false, error: "stale_auth" })
  })

  it("back-dating t is refused, and maxAge 0 needs auth_time at or after the signed start", async () => {
    const key = generateKey()
    const { auth, c } = makeAuth(key)
    const { loc, raw } = await startLogin(auth, { maxAge: 0 })
    const backdated = edit(raw, o => { o.t -= 7 * 86400_000 })
    const state = loc.searchParams.get("state")!
    const old = (await mint(key, { state, nonce: loc.searchParams.get("nonce")!, dest: loc.searchParams.get("return_to")!, auth_time: Math.floor(c.now() / 1000) - 1 }, c.now())).token
    expect(await auth.handleCallback(post(old, state, backdated))).toMatchObject({ ok: false, error: "state" })
    expect(await auth.handleCallback(post(old, state, raw))).toMatchObject({ ok: false, error: "stale_auth" })
    const fresh = (await mint(key, { state, nonce: loc.searchParams.get("nonce")!, dest: loc.searchParams.get("return_to")!, auth_time: Math.floor(c.now() / 1000) }, c.now())).token
    expect((await auth.handleCallback(post(fresh, state, raw))).ok).toBe(true)
  })

  it("a cookie MAC'd with another site's key, or another key, is refused; one made before a rotation still works", async () => {
    const key = generateKey()
    const { auth, c } = makeAuth(key)
    const { loc, raw } = await startLogin(auth)
    const state = loc.searchParams.get("state")!
    const tok = async () => (await mint(key, { state, nonce: loc.searchParams.get("nonce")!, dest: loc.searchParams.get("return_to")! }, c.now())).token
    const other = generateKey()
    const foreign = await sealStateCookie(JSON.parse(new TextDecoder().decode(b64urlDecode(raw.split(".")[0]))), { ...other, kid: key.kid }, SITE)
    expect(await auth.handleCallback(post(await tok(), state, foreign))).toMatchObject({ ok: false, error: "state" })
    const otherSite = await sealStateCookie(JSON.parse(new TextDecoder().decode(b64urlDecode(raw.split(".")[0]))), key, "other")
    expect(await auth.handleCallback(post(await tok(), state, otherSite))).toMatchObject({ ok: false, error: "state" })
    // Rotated: ring [new, old] still opens a cookie made with old
    const rotated = createAppAuth({ site: SITE, keys: ringOf(generateKey(), key), env: {}, now: c.now })
    expect((await rotated.handleCallback(post(await tok(), state, raw))).ok).toBe(true)
  })

  it("verify(token, { maxAge: 0 }) without a start is always stale (it can't know when the sign-in began)", async () => {
    const key = generateKey()
    const { auth } = makeAuth(key)
    expect(await auth.verify((await mint(key, { auth_time: Math.floor(T0 / 1000) })).token, { maxAge: 0 })).toMatchObject({ ok: false, error: "stale_auth" })
  })

  it("login without any key answers 503 and sets no cookie", async () => {
    const auth = createAppAuth({ site: SITE, env: {} })
    const res = await auth.login(new Request(`http://notes.localhost${LOGIN_PATH}`, { headers: { host: "notes.localhost" } }))
    expect(res.status).toBe(503)
    expect(res.headers.get("set-cookie")).toBeNull()
  })
})
