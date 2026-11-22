import { describe, expect, it } from "bun:test"
import { EventQueue, SubClientStore, subAccess, eventData, parseSubscription, EVENT_NAME, MAX_EVENT_BYTES, type CandyEvent } from "../events.ts"
import { normalizeManifest, checkSiteManifest } from "../manifest.ts"
import { generateKey, formatKeyRing, encryptCompact } from "../jwe.ts"
import { mintServiceToken, openServiceToken, SERVICE_HEADER, SERVICE_TTL_S } from "../service-auth.ts"
import { createRuntime, readRuntime, RUNTIME_HEADER, type RuntimeRecord } from "../sdk-runtime.ts"

const ev = (id: string, time = Date.now()): CandyEvent => ({ id, from: "ci", event: "built", data: { n: 1 }, time })

describe("events", () => {
  it("names and subscriptions", () => {
    expect(EVENT_NAME.test("order.created")).toBe(true)
    expect(EVENT_NAME.test("Order")).toBe(false)
    expect(EVENT_NAME.test("a:b")).toBe(false)
    expect(parseSubscription("ci:built")).toEqual({ site: "ci", event: "built" })
    expect(parseSubscription("built")).toBeNull()
    expect(parseSubscription(":built")).toBeNull()
    expect(parseSubscription("ci:")).toBeNull()
  })

  it("data must be JSON and small", () => {
    expect(eventData({ a: 1 })).toEqual({ json: `{"a":1}` })
    expect(eventData(undefined)).toEqual({ json: "null" })
    expect(eventData("x".repeat(MAX_EVENT_BYTES))).toHaveProperty("error")
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(eventData(loop)).toEqual({ error: "event data must be JSON" })
  })

  it("the queue is bounded, per subscriber, and forgets old events", () => {
    let now = 1000
    const q = new EventQueue(() => now, 2, 500)
    expect(q.push("web", ev("1", now))).toBe(0)
    expect(q.push("web", ev("2", now))).toBe(0)
    expect(q.push("web", ev("3", now))).toBe(1)
    expect(q.pending("web")).toBe(2)
    expect(q.pending("other")).toBe(0)
    expect(q.take("web").map(e => e.id)).toEqual(["2", "3"])
    expect(q.take("web")).toEqual([])
    q.push("web", ev("4", now))
    now += 501
    expect(q.take("web")).toEqual([])
  })

  it("candy.json: idle, service, pub and sub", () => {
    const m = normalizeManifest({ idle: true, service: true, pub: ["Announce", { event: "built", auth: "strict", "auth-users": ["bob", "bob", "carol"] }, { event: "open", auth: "none" }], sub: "ci:built" })
    expect(m).toMatchObject({ idle: true, service: true, sub: ["ci:built"] })
    expect(m.pub).toEqual([
      { event: "announce", auth: "lax", users: [] },   // a bare name: lax, the owner's own sites
      { event: "built", auth: "strict", users: ["bob", "carol"] },
      { event: "open", auth: "none", users: [] },
    ])
    expect(normalizeManifest({ pub: { event: "one", "auth-users": "bob" } }).pub).toEqual([{ event: "one", auth: "lax", users: ["bob"] }])
    expect(() => normalizeManifest({ idle: "yes" })).toThrow(`"idle" must be true or false`)
    expect(() => normalizeManifest({ pub: ["a b"] })).toThrow(`"pub"[0] needs an "event" name`)
    expect(() => normalizeManifest({ pub: ["a", "a"] })).toThrow(`lists "a" twice`)
    expect(() => normalizeManifest({ pub: [{ event: "a", auth: "open" }] })).toThrow(`"none", "lax" or "strict"`)
    expect(() => normalizeManifest({ pub: [{ event: "a", auth: "none", "auth-users": ["bob"] }] })).toThrow("does nothing")
    expect(() => normalizeManifest({ pub: [{ event: "a", "auth-users": ["Bob Smith"] }] })).toThrow("unix user names")
    expect(() => normalizeManifest({ pub: [{ event: "a", users: ["bob"] }] })).toThrow(`has no "users"`)
    expect(() => normalizeManifest({ pub: [7] })).toThrow("must be an event name or")
    expect(() => normalizeManifest({ sub: ["built"] })).toThrow(`must be "<site>:<event>"`)
    expect(() => normalizeManifest({ sub: ["Bad_Site!:built"] })).toThrow(`must be "<site>:<event>"`)
    expect(() => normalizeManifest({ pub: Array.from({ length: 33 }, (_, i) => `e${i}`) })).toThrow("at most 32")
    // What fn-tool hands back is checked the same way, and comes out the same
    expect(checkSiteManifest({ ...m, source: null })).toMatchObject({ pub: m.pub, sub: m.sub, idle: true, service: true })
    expect(() => checkSiteManifest({ sub: ["nope"] })).toThrow()
    expect(() => checkSiteManifest({ pub: [{ event: "a", auth: "king", users: [] }] })).toThrow()
  })
})

describe("who may subscribe", () => {
  it("none: anyone. lax: the owner and the listed users. strict: those, once approved", () => {
    expect(subAccess({ auth: "none", users: [] }, "alice", "mallory", null)).toBe("ok")
    const lax = { auth: "lax" as const, users: ["bob"] }
    expect(subAccess(lax, "alice", "alice", null)).toBe("ok")
    expect(subAccess(lax, "alice", "bob", null)).toBe("ok")
    expect(subAccess(lax, "alice", "mallory", null)).toBe("user")
    expect(subAccess(lax, "alice", "bob", "rejected")).toBe("ok")   // decisions only count in strict
    const strict = { auth: "strict" as const, users: ["bob"] }
    expect(subAccess(strict, "alice", "alice", null)).toBe("pending")   // the owner's own apps too
    expect(subAccess(strict, "alice", "bob", "approved")).toBe("ok")
    expect(subAccess(strict, "alice", "bob", "rejected")).toBe("rejected")
    expect(subAccess(strict, "alice", "bob", "revoked")).toBe("revoked")
    expect(subAccess(strict, "alice", "mallory", "approved")).toBe("user")   // an approval never beats the user list
  })

  it("a decision is for one event, and for an app as run by one user", () => {
    const store = new SubClientStore(null, () => 5)
    store.set("ci", "built", "web", "bob", "approved")
    expect(store.decision("ci", "built", "web", "bob")).toBe("approved")
    expect(store.decision("ci", "deployed", "web", "bob")).toBeNull()   // another event of the same publisher
    expect(store.decision("ci", "built", "web", "mallory")).toBeNull()  // the name in other hands starts over
    expect(store.decision("other", "built", "web", "bob")).toBeNull()
    expect(store.decided("ci")).toEqual([{ event: "built", app: "web", user: "bob", status: "approved", at: 5 }])
    const again = new SubClientStore(JSON.parse(JSON.stringify(store)))
    expect(again.decision("ci", "built", "web", "bob")).toBe("approved")
    expect(new SubClientStore({ ci: { "built web": { user: "bob", status: "king", at: 1 } } }).decision("ci", "built", "web", "bob")).toBeNull()
    store.set("web", "ready", "ci", "alice", "rejected")
    store.set("ci", "built", "api", "bob", "approved")
    store.dropSite("web")
    expect(store.decision("ci", "built", "web", "bob")).toBeNull()
    expect(store.decision("ci", "built", "api", "bob")).toBe("approved")
    expect(store.decided("web")).toEqual([])
  })
})

describe("server-to-server tokens", () => {
  const key = generateKey()
  it("name the calling app and its user, for one site only", async () => {
    const { token, expiresAt } = await mintServiceToken({ key, target: "db-api", app: "web", user: "ashwin", now: 1_000_000 })
    expect(expiresAt).toBe(1_000_000 + SERVICE_TTL_S * 1000)
    expect(await openServiceToken(token, [key], { site: "db-api", now: 1_000_000 })).toEqual({ app: "web", user: "ashwin", issuedAt: 1_000_000, expiresAt })
    await expect(openServiceToken(token, [key], { site: "other", now: 1_000_000 })).rejects.toMatchObject({ code: "audience" })
    await expect(openServiceToken(token, [key], { site: "db-api", now: 1_000_000 + (SERVICE_TTL_S + 31) * 1000 })).rejects.toMatchObject({ code: "expired" })
    await expect(openServiceToken(token, [generateKey()], { site: "db-api" })).rejects.toThrow()
    await expect(mintServiceToken({ key, target: "db-api", app: "web", user: "not a user" })).rejects.toThrow("invalid user")
  })

  it("a token of another kind under the same key is refused", async () => {
    const signIn = await encryptCompact(new TextEncoder().encode(JSON.stringify({ iss: "candy", aud: "db-api", sub: "ashwin", iat: 1000, exp: 1060, jti: "a".repeat(22) })), key)
    await expect(openServiceToken(signIn, [key], { site: "db-api", now: 1_000_000 })).rejects.toMatchObject({ code: "claims" })
  })
})

describe("the runtime client", () => {
  const key = generateKey()
  const record: RuntimeRecord = { token: "tok", site: "db-api", url: "http://daemon", serviceKeys: formatKeyRing([key]) }

  it("reads the record from the env, and nothing outside candy", () => {
    expect(readRuntime({})).toBeNull()
    expect(readRuntime({ CANDY_RUNTIME: "{" })).toBeNull()
    expect(readRuntime({ CANDY_RUNTIME: JSON.stringify(record) })).toEqual(record)
    expect(() => createRuntime(null).site).toThrow("not started by candy")
  })

  it("publishes and asks for tokens as its site, caching a token until it is nearly over", async () => {
    const calls: { url: string; token: string | null; body: unknown }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, token: new Headers(init.headers).get(RUNTIME_HEADER), body: JSON.parse(String(init.body)) })
      if (url.endsWith("/runtime/publish")) return Response.json({ id: "e1", delivered: ["web"] })
      if (url.endsWith("/runtime/service-token")) return Response.json({ token: `t${calls.length}`, expiresAt: Date.now() + 300_000 })
      return Response.json({ error: "nope" }, { status: 403 })
    }) as unknown as typeof fetch
    const rt = createRuntime(record, fetcher)
    expect(await rt.publish("built", { ok: true })).toEqual({ id: "e1", delivered: ["web"] })
    expect(calls[0]).toEqual({ url: "http://daemon/runtime/publish", token: "tok", body: { event: "built", data: { ok: true } } })
    const first = await rt.serviceToken("web")
    expect(await rt.serviceToken("web")).toBe(first)
    expect(await rt.serviceHeaders("web")).toEqual({ [SERVICE_HEADER]: first })
    expect(calls.filter(c => c.url.endsWith("/service-token")).length).toBe(1)
  })

  it("says who a request is from, or null", async () => {
    const rt = createRuntime(record)
    const { token } = await mintServiceToken({ key, target: "db-api", app: "web", user: "ashwin" })
    expect(await rt.verifyService(new Request("http://x/", { headers: { [SERVICE_HEADER]: token } }))).toMatchObject({ app: "web", user: "ashwin" })
    expect(await rt.verifyService(token)).toMatchObject({ app: "web" })
    expect(await rt.verifyService(new Request("http://x/"))).toBeNull()
    expect(await rt.verifyService("garbage")).toBeNull()
    const wrongSite = await mintServiceToken({ key, target: "elsewhere", app: "web", user: "ashwin" })
    expect(await rt.verifyService(wrongSite.token)).toBeNull()
    await expect(createRuntime({ ...record, serviceKeys: undefined }).verifyService(token)).rejects.toThrow(`"service": true`)
  })

  it("hands each event to the handler, in order, and reconnects", async () => {
    let connects = 0
    const fetcher = (async () => {
      connects++
      const lines = connects === 1 ? `${JSON.stringify({ candy: "subscriptions", subscriptions: [{ subscription: "ci:built", site: "ci", event: "built", status: "denied" }] })}\n${JSON.stringify(ev("1"))}\n\n${JSON.stringify(ev("2"))}\n` : `${JSON.stringify(ev("3"))}\n`
      return new Response(lines, { headers: { "Content-Type": "application/x-ndjson" } })
    }) as unknown as typeof fetch
    const got: string[] = []
    const done = Promise.withResolvers<void>()
    const statuses: string[] = []
    const sub = createRuntime(record, fetcher).subscribe(e => { got.push(e.id); if (e.id === "3") done.resolve() }, { onStatus: s => statuses.push(...s.map(x => `${x.subscription} ${x.status}`)) })
    await done.promise
    sub.close()
    expect(got).toEqual(["1", "2", "3"])
    expect(statuses).toEqual(["ci:built denied"])
  })
})
