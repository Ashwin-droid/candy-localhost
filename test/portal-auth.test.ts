import { describe, expect, it } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  attemptLogin, classifyRoute, guardRequest, logSafe, loginKeys, mayActOn, PageTokens, parseShortcutHost, safeNext, sameOrigin,
  shortcutConfirmUrl, userScopedFetch, wantsHtml, LOGIN_FAILED, LOGIN_FAILURE_FLOOR_MS, LOGIN_UNAVAILABLE,
  type LoginDeps, type RequestAuth, type RouteRule,
} from "../portal-auth.ts"

const TABLE: RouteRule[] = [
  ["GET", "/login", "public"],
  ["POST", "/auth/login", "public"],
  ["GET", "/", "user"],
  ["*", "/fn/*", "user"],
  ["DELETE", "/config/*", "user"],
  ["POST", "/config", "user"],
  ["POST", "/shutdown", "superuser"],
  ["*", "/lan/adguard", "superuser"],
]

const alice: RequestAuth = { user: "alice", superuser: false, via: "portal", sessionId: "s1" }
const root: RequestAuth = { user: "bob", superuser: true, via: "portal", sessionId: "s2" }
const key: RequestAuth = { user: "bob", superuser: false, via: "apikey" }

describe("classifyRoute", () => {
  it("matches exact paths by method", () => {
    expect(classifyRoute(TABLE, "GET", "/login")).toBe("public")
    expect(classifyRoute(TABLE, "POST", "/login")).toBeNull()
    expect(classifyRoute(TABLE, "HEAD", "/")).toBe("user")
    expect(classifyRoute(TABLE, "POST", "/config")).toBe("user")
    expect(classifyRoute(TABLE, "GET", "/config")).toBeNull()
    expect(classifyRoute(TABLE, "POST", "/shutdown")).toBe("superuser")
  })

  it("matches prefixes below them, never the bare prefix", () => {
    expect(classifyRoute(TABLE, "GET", "/fn/requests")).toBe("user")
    expect(classifyRoute(TABLE, "POST", "/fn/deploy")).toBe("user")
    expect(classifyRoute(TABLE, "GET", "/fn/")).toBeNull()
    expect(classifyRoute(TABLE, "GET", "/fn")).toBeNull()
    expect(classifyRoute(TABLE, "DELETE", "/config/web/cfg_1")).toBe("user")
    expect(classifyRoute(TABLE, "POST", "/config/web")).toBeNull()
  })

  it("'*' matches any method", () => {
    for (const m of ["GET", "POST", "DELETE"]) expect(classifyRoute(TABLE, m, "/lan/adguard")).toBe("superuser")
  })

  it("leaves everything else unclassified", () => {
    for (const p of ["/unknown", "/login/", "/shutdownx", "//", "/LOGIN"]) expect(classifyRoute(TABLE, "GET", p)).toBeNull()
  })
})

describe("guardRequest", () => {
  const g = (o: Partial<Parameters<typeof guardRequest>[0]>) =>
    guardRequest({ cls: "user", auth: null, portalHost: true, html: false, path: "/x", search: "", ...o })

  it("denies routes missing from the table, even for superusers", () => {
    expect(g({ cls: null, auth: root })).toEqual({ ok: false, status: 404, error: "not found" })
  })

  it("lets public routes through without a login", () => {
    expect(g({ cls: "public" })).toEqual({ ok: true })
  })

  it("sends browsers on the portal to the login page, keeping where they were", () => {
    expect(g({ html: true, path: "/", search: "?tab=fn" })).toEqual({ ok: false, status: 302, location: "/login?next=%2F%3Ftab%3Dfn" })
  })

  it("answers API calls and non-portal hosts with 401 login required", () => {
    expect(g({})).toEqual({ ok: false, status: 401, error: "login required" })
    expect(g({ html: true, portalHost: false })).toMatchObject({ status: 401 })
  })

  it("lets anyone logged in use user routes", () => {
    for (const auth of [alice, root, key]) expect(g({ auth })).toEqual({ ok: true })
  })

  it("keeps superuser routes to superusers; API keys never are", () => {
    expect(g({ cls: "superuser", auth: alice })).toMatchObject({ ok: false, status: 403 })
    expect(g({ cls: "superuser", auth: key })).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("portal") })
    expect(g({ cls: "superuser", auth: root })).toEqual({ ok: true })
  })
})

describe("mayActOn", () => {
  it("is the owner or a superuser, nobody else", () => {
    expect(mayActOn(alice, "alice")).toBe(true)
    expect(mayActOn(alice, "bob")).toBe(false)
    expect(mayActOn(root, "alice")).toBe(true)
    expect(mayActOn(key, "bob")).toBe(true)
    expect(mayActOn(key, "alice")).toBe(false)
    expect(mayActOn(null, "alice")).toBe(false)
  })
})

describe("safeNext", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/")).toBe("/")
    expect(safeNext("/oauth/consent?request=abc")).toBe("/oauth/consent?request=abc")
  })
  it("refuses anything that could leave the portal", () => {
    for (const bad of [null, undefined, "", "https://evil.example/", "//evil.example", "/\\evil.example", "javascript:alert(1)", "evil", "/\u0000x", "/login", "/login?next=/x", "/" + "a".repeat(2000)]) {
      expect(safeNext(bad)).toBe("/")
    }
  })
})

describe("wantsHtml", () => {
  it("is a browser navigation", () => {
    expect(wantsHtml("GET", "text/html,application/xhtml+xml")).toBe(true)
    expect(wantsHtml("GET", "application/json")).toBe(false)
    expect(wantsHtml("GET", null)).toBe(false)
    expect(wantsHtml("POST", "text/html")).toBe(false)
  })
})

describe("sameOrigin", () => {
  const portal = (h: string) => h === "portal.localhost" || h === "portal.candy"
  const h = (o: Record<string, string>) => new Headers(o)

  it("accepts a portal page posting to its own host", () => {
    expect(sameOrigin(h({ host: "portal.localhost", origin: "https://portal.localhost" }), portal)).toBe(true)
    expect(sameOrigin(h({ host: "portal.candy:443", origin: "https://portal.candy" }), portal)).toBe(true)
  })
  it("falls back to Referer without Origin", () => {
    expect(sameOrigin(h({ host: "portal.localhost", referer: "https://portal.localhost/login?next=/" }), portal)).toBe(true)
  })
  it("refuses other sites, other portal hosts and missing headers", () => {
    expect(sameOrigin(h({ host: "portal.localhost", origin: "https://evil.localhost" }), portal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost", origin: "https://portal.candy" }), portal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost", origin: "null" }), portal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost" }), portal)).toBe(false)
    expect(sameOrigin(h({ host: "app.localhost", origin: "https://app.localhost" }), portal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost", origin: "https://portal.localhost.evil.example" }), portal)).toBe(false)
  })
})

describe("PageTokens", () => {
  it("mints a chain that only its own session can use", () => {
    const t = new PageTokens()
    const tok = t.mint("s1")
    expect(t.consume(tok, "s2")).toBe(false)
    expect(t.consume(tok, null)).toBe(false)
    expect(t.consume(tok, "s1")).toBe(true)
  })

  it("rolls: a token is good once, then refresh hands out the next", () => {
    const t = new PageTokens()
    const first = t.mint("s1")
    expect(t.consume(first, "s1")).toBe(true)
    expect(t.consume(first, "s1")).toBe(false)
    const next = t.refresh(first, "s1")!
    expect(next).not.toBe(first)
    expect(t.refresh(first, "s2")).toBeNull()
    expect(t.consume(next, "s1")).toBe(true)
    // only the current and the previous token are remembered
    expect(t.refresh(first, "s1")).toBeNull()
  })

  it("ends with the login", () => {
    const t = new PageTokens()
    const a = t.mint("s1")
    const b = t.mint("s2")
    t.dropSession("s1")
    expect(t.consume(a, "s1")).toBe(false)
    expect(t.consume(b, "s2")).toBe(true)
    const c = t.mint("s3")
    t.sweep(id => id !== "s3")
    expect(t.consume(c, "s3")).toBe(false)
  })

  it("expires old chains", () => {
    const clock = { t: 0 }
    const t = new PageTokens(() => clock.t, 1000)
    const a = t.mint("s1")
    clock.t = 1001
    expect(t.consume(a, "s1")).toBe(false)
    expect(t.size).toBe(0)
  })

  it("ignores junk", () => {
    const t = new PageTokens()
    t.mint("s1")
    for (const junk of [null, 7, "", "a:b:c", "x".repeat(500), "nochain:value"]) {
      expect(t.consume(junk, "s1")).toBe(false)
      expect(t.refresh(junk, "s1")).toBeNull()
    }
  })
})

// ----------------------------------------------------------------------------
// Login. pam.ts and superuser.ts are stubbed: attemptLogin gets them as deps.
// ----------------------------------------------------------------------------

type Reason = "ok" | "denied" | "account" | "unavailable" | "timeout"
const makeDeps = (over: Partial<LoginDeps> & { passwords?: Record<string, string>; reasons?: Record<string, Reason> } = {}) => {
  const clock = { t: 1_000_000 }
  const grudges = new Map<string, { count: number; blockedUntil: number }>()
  const audit: [string, string][] = []
  const errors: string[] = []
  const pamCalls: string[] = []
  const passwords = over.passwords ?? { alice: "right", bob: "hunter2" }
  const deps: LoginDeps = {
    pamReady: () => true,
    loginUsers: async () => Object.keys(passwords),
    verifyPassword: async (user, password) => {
      pamCalls.push(user)
      clock.t += 50
      const forced = over.reasons?.[user]
      if (forced) return { ok: forced === "ok", reason: forced }
      return passwords[user] === password ? { ok: true, reason: "ok" } : { ok: false, reason: "denied" }
    },
    isSuperuser: async user => user === "bob",
    // the daemon's Fibonacci grudges: 3 free failures, then locked
    blocked: async k => {
      const g = grudges.get(k)
      return g && g.blockedUntil > clock.t ? { blocked: true, retryAfter: Math.ceil((g.blockedUntil - clock.t) / 1000) } : { blocked: false, retryAfter: 0 }
    },
    fail: async k => {
      const g = grudges.get(k) ?? { count: 0, blockedUntil: 0 }
      g.count++
      if (g.count >= 3) g.blockedUntil = clock.t + 3600_000
      grudges.set(k, g)
      return { retryAfter: g.count >= 3 ? 3600 : 0 }
    },
    clear: async k => { grudges.delete(k) },
    refund: async k => {
      const g = grudges.get(k)
      if (!g) return
      if (--g.count <= 0) grudges.delete(k)
      else if (g.count < 3) g.blockedUntil = 0
    },
    audit: (a, d) => { audit.push([a, d]) },
    serverError: m => { errors.push(m) },
    now: () => clock.t,
    sleep: async ms => { clock.t += ms },
    ...over,
  }
  return { deps, clock, grudges, audit, errors, pamCalls }
}

const timed = async (env: ReturnType<typeof makeDeps>, input: { user: unknown; password: unknown; ip?: string }) => {
  const start = env.clock.t
  const out = await attemptLogin(env.deps, { ip: "100.64.0.9", ...input })
  return { out, took: env.clock.t - start }
}

describe("attemptLogin", () => {
  it("logs in with the right password and says whether it's a superuser", async () => {
    const env = makeDeps()
    const { out, took } = await timed(env, { user: "alice", password: "right" })
    expect(out).toEqual({ ok: true, user: "alice", superuser: false })
    expect(took).toBeLessThan(LOGIN_FAILURE_FLOOR_MS)
    expect((await timed(env, { user: "bob", password: "hunter2" })).out).toEqual({ ok: true, user: "bob", superuser: true })
    expect(env.audit.map(a => a[0])).toEqual(["AUTH_LOGIN", "AUTH_LOGIN"])
    expect(env.audit[1][1]).toContain("superuser")
  })

  it("gives unknown users, wrong passwords, refused accounts and PAM trouble the same answer and time", async () => {
    const cases: [string, Parameters<typeof makeDeps>[0], string][] = [
      ["unknown user", {}, "mallory"],
      ["wrong password", {}, "alice"],
      ["account refused", { reasons: { alice: "account" } }, "alice"],
      ["pam unavailable", { reasons: { alice: "unavailable" } }, "alice"],
      ["pam timeout", { reasons: { alice: "timeout" } }, "alice"],
      ["pam throws", { verifyPassword: async () => { throw new Error("boom") } }, "alice"],
    ]
    for (const [what, over, user] of cases) {
      const env = makeDeps(over)
      const { out, took } = await timed(env, { user, password: "nope" })
      expect(out, what).toEqual({ ok: false, status: 401, body: { error: LOGIN_FAILED } })
      expect(took, what).toBe(LOGIN_FAILURE_FLOOR_MS)
      expect(env.audit.map(a => a[0]), what).toEqual(["AUTH_FAIL"])
    }
  })

  it("audits why it failed, without the password", async () => {
    const env = makeDeps({ reasons: { bob: "account" } })
    await timed(env, { user: "mallory", password: "s3cret-guess" })
    await timed(env, { user: "alice", password: "s3cret-guess" })
    await timed(env, { user: "bob", password: "s3cret-guess" })
    const lines = env.audit.map(a => a[1])
    expect(lines[0]).toContain("unknown user")
    expect(lines[1]).toContain("wrong password")
    expect(lines[2]).toContain("account refused")
    for (const l of lines) {
      expect(l).toContain("100.64.0.9")
      expect(l).not.toContain("s3cret-guess")
    }
  })

  it("logs PAM problems as server errors and doesn't hold them against anyone", async () => {
    const env = makeDeps({ reasons: { alice: "timeout" } })
    for (let i = 0; i < 5; i++) await timed(env, { user: "alice", password: "x" })
    expect(env.errors.length).toBe(5)
    expect(env.grudges.size).toBe(0)
  })

  it("never asks PAM about unknown users", async () => {
    const env = makeDeps()
    await timed(env, { user: "root", password: "x" })
    await timed(env, { user: "", password: "x" })
    await timed(env, { user: { $ne: 1 }, password: "x" })
    expect(env.pamCalls).toEqual([])
  })

  // Review finding 7: per user+address and soft, so nobody can lock an account for everyone
  it("slows a username down per address after 3 failures, without locking it for other addresses", async () => {
    const env = makeDeps()
    const ip = "127.0.0.1"
    env.deps.isLoopback = (a: string) => a === "127.0.0.1"
    for (let i = 0; i < 3; i++) await timed(env, { user: "alice", password: "bad", ip })
    env.pamCalls.length = 0
    // the same address, right password, inside the delay: the same failure, PAM isn't asked
    const { out, took } = await timed(env, { user: "alice", password: "right", ip })
    expect(out.ok).toBe(false)
    expect(took).toBe(LOGIN_FAILURE_FLOOR_MS)
    expect(env.pamCalls).toEqual([])
    // another address isn't affected
    expect((await timed(env, { user: "alice", password: "right", ip: "10.0.0.99" })).out.ok).toBe(true)
    // and the delay never goes past 30s
    env.clock.t += 30_000
    expect((await timed(env, { user: "alice", password: "right", ip })).out.ok).toBe(true)
  })

  it("locks an address after 3 failures and tells that caller when to retry", async () => {
    const env = makeDeps()
    expect((await timed(env, { user: "mallory", password: "x" })).out).toMatchObject({ status: 401, body: { error: LOGIN_FAILED } })
    expect((await timed(env, { user: "nobody", password: "x" })).out).toMatchObject({ status: 401 })
    const third = await timed(env, { user: "alice", password: "x" })
    expect(third.out).toEqual({ ok: false, status: 401, body: { error: LOGIN_FAILED, retryAfter: 3600 } })
    const locked = await timed(env, { user: "alice", password: "right" })
    expect(locked.out).toMatchObject({ ok: false, status: 429, body: { retryAfter: expect.any(Number) } })
    expect(locked.took).toBe(LOGIN_FAILURE_FLOOR_MS)
    // another address is unaffected
    expect((await timed(env, { user: "bob", password: "hunter2", ip: "100.64.0.10" })).out.ok).toBe(true)
  })

  it("doesn't fill the grudge file with made-up usernames", async () => {
    const env = makeDeps()
    for (const u of ["a1", "a2", "a3"]) await timed(env, { user: u, password: "x", ip: `10.1.0.${u}` })
    expect([...env.grudges.keys()].every(k => k.startsWith("portal:ip:"))).toBe(true)
  })

  it("clears both counters on success", async () => {
    const env = makeDeps()
    await timed(env, { user: "alice", password: "bad" })
    await timed(env, { user: "alice", password: "bad" })
    await timed(env, { user: "alice", password: "right" })
    expect(env.grudges.size).toBe(0)
  })

  it("fails closed with an explanation when the PAM service is missing", async () => {
    const env = makeDeps({ pamReady: () => false })
    const { out } = await timed(env, { user: "alice", password: "right" })
    expect(out).toEqual({ ok: false, status: 503, body: { error: LOGIN_UNAVAILABLE } })
    expect(env.pamCalls).toEqual([])
  })

  it("treats huge or odd passwords as wrong", async () => {
    const env = makeDeps({ passwords: { alice: "x".repeat(5000) } })
    expect((await timed(env, { user: "alice", password: "x".repeat(5000) })).out.ok).toBe(false)
    expect((await timed(env, { user: "alice", password: 42 })).out.ok).toBe(false)
  })

  it("keys per address (loopback as one) and per lower-cased username", () => {
    expect(loginKeys("Alice", "1.2.3.4")).toEqual({ ip: "portal:ip:1.2.3.4", user: "portal:user:alice", slot: "1.2.3.4" })
    // every loopback address is one
    expect(loginKeys("Alice", "127.0.0.9", true)).toEqual({ ip: "portal:ip:loopback", user: "portal:user:alice", slot: "loopback" })
    expect(logSafe("a\nb\u0000c")).toBe("a?b?c")
  })
})

describe("userScopedFetch", () => {
  const ORIGIN = "http://localhost:9999"
  const setup = () => {
    const seen: Request[] = []
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init))
      return new Response("ok")
    }) as typeof fetch
    const store = new AsyncLocalStorage<string>()
    const scoped = userScopedFetch(base, store, ORIGIN, u => `oauth_${u}`)
    return { seen, store, scoped }
  }

  it("leaves fetch alone outside a run", async () => {
    const { seen, scoped } = setup()
    await scoped(`${ORIGIN}/configs`, { headers: { "X-Candy-API-Key": "mcp_owner" } })
    expect(seen[0].headers.get("X-Candy-API-Key")).toBe("mcp_owner")
  })

  it("puts the user's key on daemon calls inside a run", async () => {
    const { seen, store, scoped } = setup()
    await store.run("alice", async () => {
      await scoped(`${ORIGIN}/configs`, { headers: { "X-Candy-API-Key": "mcp_owner" } })
      await scoped(`${ORIGIN}/process/stop/web`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })
    })
    expect(seen.map(r => r.headers.get("X-Candy-API-Key"))).toEqual(["oauth_alice", "oauth_alice"])
    expect(seen[1].method).toBe("POST")
    expect(await seen[1].text()).toBe("{}")
  })

  it("answers the secret exchange with the user's key", async () => {
    const { seen, store, scoped } = setup()
    const res = await store.run("bob", () => scoped(`${ORIGIN}/mcp/auth`, { method: "POST", body: '{"secret":"owner"}' }))
    expect(await res.json()).toEqual({ apiKey: "oauth_bob", user: "bob" })
    expect(seen.length).toBe(0)
  })

  it("never sends the key anywhere else", async () => {
    const { seen, store, scoped } = setup()
    await store.run("alice", () => scoped("https://api.cloudflare.com/x"))
    await store.run("alice", () => scoped("http://localhost:3000/"))
    expect(seen.map(r => r.headers.get("X-Candy-API-Key"))).toEqual([null, null])
  })
})

describe("shortcut hosts", () => {
  it("parses kill and tunnel shortcuts on both TLDs", () => {
    expect(parseShortcutHost("foo.k.localhost")).toEqual({ action: "kill", name: "foo", label: null, tld: "localhost" })
    expect(parseShortcutHost("foo.kill.localhost:443")).toEqual({ action: "kill", name: "foo", label: null, tld: "localhost" })
    expect(parseShortcutHost("Foo.P.Candy")).toEqual({ action: "portal", name: "foo", label: null, tld: "candy" })
    expect(parseShortcutHost("foo.portal.box.candy")).toEqual({ action: "portal", name: "foo", label: "box", tld: "candy" })
  })

  it("ignores everything else", () => {
    for (const h of ["foo.localhost", "portal.localhost", "k.localhost", "foo.k.example.com", "foo.x.localhost", "a.b.k.localhost", ""]) {
      expect(parseShortcutHost(h)).toBeNull()
    }
  })

  it("sends the browser to the portal host of the same TLD", () => {
    expect(shortcutConfirmUrl("kill", "foo", "localhost")).toBe("https://portal.localhost/go/kill?name=foo")
    expect(shortcutConfirmUrl("portal", "foo.box", "candy")).toBe("https://portal.candy/go/portal?name=foo.box")
    expect(shortcutConfirmUrl("kill", "a&b=c", "localhost")).toBe("https://portal.localhost/go/kill?name=a%26b%3Dc")
  })

  it("comes back to the confirmation after logging in", () => {
    // The guard keeps the query in ?next=, and safeNext keeps it after login
    const g = guardRequest({ cls: "user", auth: null, portalHost: true, html: true, path: "/go/kill", search: "?name=foo" })
    expect(g).toEqual({ ok: false, status: 302, location: `/login?next=${encodeURIComponent("/go/kill?name=foo")}` })
    expect(safeNext("/go/kill?name=foo")).toBe("/go/kill?name=foo")
  })
})
