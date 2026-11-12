import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PUBLIC_HIDDEN_TOOLS, TOOLS, handlePublicRequest, handleRequest, routeTargetText } from "../mcp.ts"

const DAEMON = "http://localhost:9999"

interface Call { path: string; method: string; headers: Record<string, string>; body: any }

const realFetch = globalThis.fetch
const savedSecretFile = process.env.CANDY_SECRET_FILE
let dir = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "candy-mcp-test-"))
  writeFileSync(join(dir, "secret"), "dummy-secret\n")
  process.env.CANDY_SECRET_FILE = join(dir, "secret")
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(() => {
  if (savedSecretFile === undefined) delete process.env.CANDY_SECRET_FILE
  else process.env.CANDY_SECRET_FILE = savedSecretFile
  rmSync(dir, { recursive: true, force: true })
})

/** Replace fetch with a fake daemon; returns the calls it saw (minus the key exchange). */
const stubDaemon = (respond: (call: Call) => unknown = () => ({ success: true })): Call[] => {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url)
    if (!url.startsWith(DAEMON)) throw new Error(`unexpected fetch to ${url}`)
    const path = url.slice(DAEMON.length)
    if (path === "/mcp/auth") return Response.json({ apiKey: "k" })
    const call: Call = {
      path,
      method: (init.method || "GET").toUpperCase(),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    return Response.json(respond(call))
  }) as typeof fetch
  return calls
}

const callTool = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  const text: string = res!.result.content[0].text
  try { return JSON.parse(text) } catch { return text }
}

describe("tool definitions", () => {
  test("every tool has a name, description and object inputSchema", () => {
    expect(TOOLS.length).toBeGreaterThan(0)
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^candy_[a-z][a-z0-9_]*$/)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe("object")
      expect(typeof tool.inputSchema.properties).toBe("object")
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean")
    }
  })

  test("names are unique", () => {
    const names = TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test("required fields exist in properties", () => {
    for (const tool of TOOLS) {
      for (const field of (tool.inputSchema as any).required ?? []) {
        expect(Object.keys(tool.inputSchema.properties)).toContain(field)
      }
    }
  })

  test("no tool takes a password", () => {
    for (const tool of TOOLS) {
      expect(Object.keys(tool.inputSchema.properties).map(k => k.toLowerCase())).not.toContain("password")
    }
  })

  test("every listed tool is dispatched", async () => {
    stubDaemon(() => ({}))
    for (const tool of TOOLS) {
      const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: { action: "list", name: "x" } } })
      expect(res?.error).toBeUndefined()
    }
  })
})

describe("protocol", () => {
  test("initialize echoes a supported protocol version", async () => {
    for (const version of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
      const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } })
      expect(res!.result.protocolVersion).toBe(version)
    }
  })

  test("initialize falls back to 2025-06-18", async () => {
    const unknown = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })
    expect(unknown!.result.protocolVersion).toBe("2025-06-18")
    const missing = await handleRequest({ jsonrpc: "2.0", id: 2, method: "initialize" })
    expect(missing!.result.protocolVersion).toBe("2025-06-18")
    expect(missing!.id).toBe(2)
  })

  test("serverInfo version matches package.json", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json()
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res!.result.serverInfo).toEqual({ name: "candy-localhost", version: pkg.version })
    expect(res!.result.capabilities.tools).toBeDefined()
  })

  test("tools/list returns the tools", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: "a", method: "tools/list" })
    expect(res!.id).toBe("a")
    expect(res!.result.tools).toBe(TOOLS)
  })

  test("ping answers with an empty result", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 7, method: "ping" })
    expect(res).toEqual({ jsonrpc: "2.0", id: 7, result: {} })
  })

  test("notifications get no response", async () => {
    expect(await handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull()
    expect(await handleRequest({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull()
  })

  test("unknown method and unknown tool are errors", async () => {
    const method = await handleRequest({ jsonrpc: "2.0", id: 1, method: "nope/nothing" })
    expect(method!.error!.code).toBe(-32601)
    const tool = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "candy_nope" } })
    expect(tool!.error!.code).toBe(-32601)
  })
})

describe("daemon calls", () => {
  test("sends the exchanged API key", async () => {
    const calls = stubDaemon()
    await callTool("candy_status")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: "/status", method: "GET" })
    expect(calls[0].headers["x-candy-api-key"]).toBe("k")
    expect(calls[0].headers["x-candy-actor"]).toBeUndefined()
  })

  test("candy_register passes api and user", async () => {
    const calls = stubDaemon()
    await callTool("candy_register", { name: "app", cwd: "/srv/app", cmd: "bun dev", api: true, user: "alice" })
    expect(calls[0]).toMatchObject({ path: "/config", method: "POST", body: { name: "app", cwd: "/srv/app", cmd: "bun dev", api: true, user: "alice" } })
    expect(calls[0].headers["x-candy-actor"]).toBe("AI")
  })

  test("candy_register leaves api and user out by default", async () => {
    const calls = stubDaemon()
    await callTool("candy_register", { name: "app", cwd: "/srv/app", cmd: "bun dev" })
    expect(calls[0].body).toEqual({ name: "app", cwd: "/srv/app", cmd: "bun dev" })
  })

  test("candy_start passes a configId", async () => {
    const calls = stubDaemon()
    await callTool("candy_start", { name: "app", configId: "cfg2" })
    expect(calls[0]).toMatchObject({ path: "/process/start/app", method: "POST", body: { configId: "cfg2" } })
    await callTool("candy_start", { name: "app" })
    expect(calls[1].body).toBeUndefined()
  })

  test("candy_deregister with a configId removes one variant and leaves another running", async () => {
    const calls = stubDaemon(call => call.path === "/processes" ? { processes: { app: { configId: "cfg1" } } } : { success: true })
    await callTool("candy_deregister", { name: "app", configId: "cfg2" })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /processes", "DELETE /config/app/cfg2"])
  })

  test("candy_deregister without a configId stops, then removes", async () => {
    const calls = stubDaemon()
    await callTool("candy_deregister", { name: "app" })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["POST /process/stop/app", "DELETE /config/app"])
  })

  test("candy_config set_api, set_port, users, list", async () => {
    const calls = stubDaemon()
    await callTool("candy_config", { action: "set_api", name: "app", configId: "cfg1", api: false })
    expect(calls[0]).toMatchObject({ path: "/config/api", method: "POST", body: { name: "app", configId: "cfg1", api: false } })
    await callTool("candy_config", { action: "set_port", name: "app", port: 5173 })
    expect(calls[1]).toMatchObject({ path: "/process/port/app", method: "POST", body: { port: 5173 } })
    expect(calls[1].headers["x-candy-actor"]).toBe("AI")
    await callTool("candy_config", { action: "users" })
    expect(calls[2]).toMatchObject({ path: "/users", method: "GET" })
    await callTool("candy_config", { action: "list" })
    expect(calls[3]).toMatchObject({ path: "/configs", method: "GET" })
  })

  test("candy_config validates before calling the daemon", async () => {
    const calls = stubDaemon()
    expect((await callTool("candy_config", { action: "set_api", name: "app" })).error).toBeString()
    expect((await callTool("candy_config", { action: "set_port", name: "app", port: "x" })).error).toBeString()
    expect(calls).toHaveLength(0)
  })

  test("candy_status stats, traffic, activity", async () => {
    const calls = stubDaemon()
    await callTool("candy_status", { action: "stats" })
    await callTool("candy_status", { action: "traffic", name: "app", count: 5 })
    await callTool("candy_status", { action: "activity", count: 99999 })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /stats", "GET /traffic/app?count=5", "GET /logs?count=500"])
  })

  test("candy_route rename", async () => {
    const calls = stubDaemon()
    const text = await callTool("candy_route", { action: "rename", name: "old", newName: "new" })
    expect(calls[0]).toMatchObject({ path: "/rename", method: "POST", body: { oldName: "old", newName: "new" } })
    expect(text).toContain("old.localhost -> new.localhost")
  })

  test("candy_route lan_publish modes", async () => {
    const calls = stubDaemon(() => ({ lanIp: "192.168.0.2", httpsUrl: "https://host.ts.net:8443" }))
    await callTool("candy_route", { action: "lan_publish", name: "app" })
    expect(calls[0]).toMatchObject({ path: "/lan", method: "POST" })
    expect(calls[0].body).toEqual({ name: "app", publish: true })
    expect(calls[0].headers["x-candy-actor"]).toBe("AI")

    await callTool("candy_route", { action: "lan_publish", name: "app", https: "domain" })
    expect(calls[1].body).toEqual({ name: "app", publish: true, https: "domain" })

    // a port implies Tailscale mode
    await callTool("candy_route", { action: "lan_publish", name: "app", port: 8443 })
    expect(calls[2].body).toEqual({ name: "app", publish: true, https: "tailscale", port: 8443 })

    await callTool("candy_route", { action: "lan_publish", name: "app", https: false, port: 8443 })
    expect(calls[3].body).toEqual({ name: "app", publish: true, https: false })

    await callTool("candy_route", { action: "lan_unpublish", name: "app", https: true })
    expect(calls[4].body).toEqual({ name: "app", publish: false })

    expect(await callTool("candy_route", { action: "lan_publish", name: "app", https: "yes" })).toContain("Error")
    expect(calls).toHaveLength(5)
  })

  test("candy_route lan_list and AdGuard status / unlink", async () => {
    const calls = stubDaemon(() => ({ configured: false }))
    await callTool("candy_route", { action: "lan_list" })
    await callTool("candy_route", { action: "adguard_status" })
    await callTool("candy_route", { action: "adguard_unlink" })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(["GET /lan", "GET /lan/adguard", "POST /lan/adguard"])
    expect(calls[2].body).toEqual({ remove: true })
  })

  test("candy_route add with a port or a URL target", async () => {
    const calls = stubDaemon()
    await callTool("candy_route", { action: "add", name: "x", port: 3000, persistent: true })
    expect(calls[0]).toMatchObject({ path: "/register", method: "POST", body: { name: "x", port: 3000, persistent: true } })
    await callTool("candy_route", { action: "add", name: "y", target: "http://10.0.0.5:8080" })
    expect(calls[1].body).toEqual({ name: "y", target: "http://10.0.0.5:8080", persistent: false })
  })

  test("candy_domain auth actions", async () => {
    const calls = stubDaemon()
    await callTool("candy_domain", { action: "auth_status" })
    expect(calls[0]).toMatchObject({ path: "/auth/status", method: "GET" })

    await callTool("candy_domain", { action: "auth_generate_jwt", subdomain: "app" })
    expect(calls[1]).toMatchObject({ path: "/auth/set", method: "POST", body: { subdomain: "app", jwtSecret: "generate" } })

    await callTool("candy_domain", { action: "auth_token", domain: "app.example.com", ttl: 60, once: true })
    expect(calls[2]).toMatchObject({ path: "/auth/token", method: "POST", body: { domain: "app.example.com", ttl: 60, jti: true } })

    await callTool("candy_domain", { action: "auth_clear", subdomain: "app", which: "password" })
    expect(calls[3]).toMatchObject({ path: "/auth/clear", method: "POST", body: { subdomain: "app", which: "password" } })
    expect(calls[3].headers["x-candy-actor"]).toBe("AI")
  })

  test("candy_domain auth_clear needs an explicit which and a domain", async () => {
    const calls = stubDaemon()
    expect((await callTool("candy_domain", { action: "auth_clear", subdomain: "app" })).error).toBeString()
    expect((await callTool("candy_domain", { action: "auth_clear", which: "all" })).error).toBeString()
    expect(calls).toHaveLength(0)
  })

  test("candy_domain never forwards a password", async () => {
    const calls = stubDaemon()
    await callTool("candy_domain", { action: "auth_generate_jwt", subdomain: "app", password: "hunter2", jwtSecret: "mine" })
    expect(calls[0].body).toEqual({ subdomain: "app", jwtSecret: "generate" })
  })

  test("candy_domain allowlist", async () => {
    const calls = stubDaemon()
    await callTool("candy_domain", { action: "allowlist", subdomain: "app", add: ["10.0.0.0/8"], remove: ["1.2.3.4"] })
    expect(calls[0]).toMatchObject({ path: "/domains/allowlist", method: "POST", body: { subdomain: "app", add: ["10.0.0.0/8"], remove: ["1.2.3.4"] } })
    await callTool("candy_domain", { action: "allowlist", subdomain: "app", enabled: false })
    expect(calls[1].body).toEqual({ subdomain: "app", enabled: false })
    expect((await callTool("candy_domain", { action: "allowlist", subdomain: "app" })).error).toBeString()
    expect(calls).toHaveLength(2)
  })

  test("candy_domain bind and unbind keep their shapes", async () => {
    const calls = stubDaemon()
    await callTool("candy_domain", { action: "bind", subdomain: "app", serverName: "app" })
    expect(calls[0]).toMatchObject({ path: "/domains/bind", method: "POST", body: { subdomain: "app", serverName: "app", force: false } })
    await callTool("candy_domain", { action: "unbind", subdomain: "app" })
    expect(calls[1]).toMatchObject({ path: "/domains/unbind/app", method: "DELETE" })
  })

  test("candy_servers reports variants, user, api and detected ports", async () => {
    stubDaemon(call => call.path === "/configs"
      ? { configs: { app: { id: "a", cwd: "/a", cmd: "one", user: "u", api: false, count: 2, lan: true, lanHttps: null,
          variants: [{ id: "a", cwd: "/a", cmd: "one", user: "u", api: false }, { id: "b", cwd: "/b", cmd: "two", user: "u", api: true }] } } }
      : { processes: { app: { status: "running", port: 3000, pid: 42, configId: "b", detectedPorts: [3000, 3001] } } })
    const { servers } = await callTool("candy_servers")
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ name: "app", status: "running", port: 3000, configId: "b", cwd: "/b", cmd: "two", api: true, user: "u", detectedPorts: [3000, 3001], lan: true })
    expect(servers[0].variants).toHaveLength(2)
  })

  test("candy_servers includes a function's fn summary with its assets", async () => {
    const assets = { directory: "/srv/site/dist", binding: null, notFound: "single-page-application", html: "auto-trailing-slash", runWorkerFirst: ["/api/*"] }
    stubDaemon(call => call.path === "/configs"
      ? { configs: {
          site: { id: "s", cwd: "/srv/site", cmd: "", api: true, count: 1, fn: { entry: null, deploy: null, hot: 0, max: 4, linger: 30, log: true, assets } },
          app: { id: "a", cwd: "/a", cmd: "one", count: 1, fn: null },
        } }
      : { processes: {} })
    const { servers } = await callTool("candy_servers")
    expect(servers.find((s: any) => s.name === "site").fn).toEqual({ entry: null, deploy: null, hot: 0, max: 4, linger: 30, log: true, assets })
    expect(servers.find((s: any) => s.name === "app").fn).toBeUndefined()
  })

  test("a daemon error is passed back", async () => {
    globalThis.fetch = (async (input: any) => String(input).endsWith("/mcp/auth")
      ? Response.json({ apiKey: "k" })
      : Response.json({ error: "No binding found for 'nope'" }, { status: 404 })) as typeof fetch
    const res = await callTool("candy_domain", { action: "auth_token", subdomain: "nope" })
    expect(res).toMatchObject({ error: "No binding found for 'nope'", status: 404 })
  })
})

describe("function tools", () => {
  const FN_TOOLS = ["candy_fn_add", "candy_fn_deploy", "candy_fn_rollback", "candy_fn_deploys", "candy_fn_instances",
    "candy_fn_settings", "candy_fn_requests", "candy_fn_request", "candy_fn_replay", "candy_fn_kv", "candy_fn_d1"]

  test("all are listed, and the read-only ones say so", () => {
    const byName = new Map(TOOLS.map(t => [t.name, t]))
    for (const name of FN_TOOLS) expect(byName.has(name)).toBe(true)
    for (const name of ["candy_fn_deploys", "candy_fn_instances", "candy_fn_requests", "candy_fn_request"]) {
      expect(byName.get(name)!.annotations.readOnlyHint).toBe(true)
    }
    for (const name of ["candy_fn_add", "candy_fn_deploy", "candy_fn_rollback", "candy_fn_settings", "candy_fn_replay", "candy_fn_kv", "candy_fn_d1"]) {
      expect(byName.get(name)!.annotations.readOnlyHint).toBe(false)
    }
  })

  test("descriptions explain static assets and run_worker_first", () => {
    const desc = (n: string) => TOOLS.find(t => t.name === n)!.description
    expect(desc("candy_fn_add")).toContain("run_worker_first")
    expect(desc("candy_fn_add")).toContain('["/api/*"]')
    expect(desc("candy_fn_add")).toContain("assets-only")
    expect(desc("candy_fn_requests")).toContain("kind")
    expect(desc("candy_fn_requests")).toContain("worker-first:/api/*")
    expect(desc("candy_fn_deploys")).toContain("assets")
    expect(desc("candy_servers")).toContain("runWorkerFirst")
  })

  test("candy_fn_requests passes kind and rule through", async () => {
    const rows = [
      { id: "a1", path: "/app", status: 200, kind: "asset", rule: "spa-navigate" },
      { id: "w1", path: "/api/me", status: 200, kind: "worker", rule: "worker-first:/api/*" },
    ]
    stubDaemon(() => ({ success: true, requests: rows }))
    const res = await callTool("candy_fn_requests", { name: "site" })
    expect(res.requests).toEqual(rows)
  })

  test("every one needs a name before calling the daemon", async () => {
    const calls = stubDaemon()
    for (const name of FN_TOOLS) expect((await callTool(name, {})).error).toBe("name is required")
    expect(calls).toHaveLength(0)
  })

  test("candy_fn_add posts the contract body as the AI", async () => {
    const calls = stubDaemon(() => ({ success: true, name: "hello", url: "https://hello.localhost" }))
    const res = await callTool("candy_fn_add", { name: "hello", cwd: "/srv/hello", entry: "src/index.ts", user: "alice", envFile: "/srv/hello/.env", hot: 1, max: 3 })
    expect(calls[0]).toMatchObject({ path: "/fn/add", method: "POST", body: { name: "hello", cwd: "/srv/hello", entry: "src/index.ts", user: "alice", envFile: "/srv/hello/.env", hot: 1, max: 3 } })
    expect(calls[0].headers["x-candy-actor"]).toBe("AI")
    expect(calls[0].headers["x-candy-api-key"]).toBe("k")
    expect(res.url).toBe("https://hello.localhost")

    await callTool("candy_fn_add", { name: "bare", cwd: "/srv/bare" })
    expect(calls[1].body).toEqual({ name: "bare", cwd: "/srv/bare" })

    expect((await callTool("candy_fn_add", { name: "x" })).error).toBeString()
    expect((await callTool("candy_fn_add", { name: "x", cwd: "/x", hot: -1 })).error).toBeString()
    expect(calls).toHaveLength(2)
  })

  test("deploy, rollback, dev and the read-only lists", async () => {
    const calls = stubDaemon(() => ({ success: true }))
    await callTool("candy_fn_deploy", { name: "hello" })
    await callTool("candy_fn_rollback", { name: "hello" })
    await callTool("candy_fn_rollback", { name: "hello", id: "20260101000000-abcd1234" })
    await callTool("candy_fn_rollback", { name: "hello", id: "ignored", dev: true })
    await callTool("candy_fn_deploys", { name: "hello world" })
    await callTool("candy_fn_instances", { name: "hello" })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "POST /fn/deploy", "POST /fn/rollback", "POST /fn/rollback", "POST /fn/dev",
      "GET /fn/deploys?name=hello+world", "GET /fn/instances?name=hello",
    ])
    expect(calls[0].body).toEqual({ name: "hello" })
    expect(calls[1].body).toEqual({ name: "hello" })
    expect(calls[2].body).toEqual({ name: "hello", id: "20260101000000-abcd1234" })
    expect(calls[3].body).toEqual({ name: "hello" })
    expect(calls[4].headers["x-candy-actor"]).toBeUndefined()
  })

  test("candy_fn_settings sends only what changes and checks log", async () => {
    const calls = stubDaemon()
    await callTool("candy_fn_settings", { name: "hello", hot: 2 })
    await callTool("candy_fn_settings", { name: "hello", max: 8, log: "meta" })
    await callTool("candy_fn_settings", { name: "hello", log: false })
    expect(calls.map(c => c.body)).toEqual([{ name: "hello", hot: 2 }, { name: "hello", max: 8, log: "meta" }, { name: "hello", log: false }])
    expect(calls[0]).toMatchObject({ path: "/fn/settings", method: "POST" })
    expect((await callTool("candy_fn_settings", { name: "hello" })).error).toBeString()
    expect((await callTool("candy_fn_settings", { name: "hello", log: "full" })).error).toBeString()
    expect((await callTool("candy_fn_settings", { name: "hello", max: "lots" })).error).toBeString()
    expect(calls).toHaveLength(3)
  })

  test("candy_fn_requests builds the query and turns a duration into a time", async () => {
    const calls = stubDaemon(() => ({ requests: [] }))
    const before = Date.now()
    await callTool("candy_fn_requests", { name: "hello", status: "5xx", path: "/api", since: "1h", limit: 9999 })
    const q = new URL(calls[0].path, DAEMON).searchParams
    expect(new URL(calls[0].path, DAEMON).pathname).toBe("/fn/requests")
    expect(q.get("name")).toBe("hello")
    expect(q.get("status")).toBe("5xx")
    expect(q.get("path")).toBe("/api")
    expect(q.get("limit")).toBe("500")
    const since = Number(q.get("since"))
    expect(since).toBeGreaterThanOrEqual(before - 3_600_000)
    expect(since).toBeLessThanOrEqual(Date.now() - 3_600_000)

    await callTool("candy_fn_requests", { name: "hello", since: 1700000000000, before: 1700000100000 })
    const q2 = new URL(calls[1].path, DAEMON).searchParams
    expect([q2.get("since"), q2.get("before"), q2.get("limit"), q2.has("status")]).toEqual(["1700000000000", "1700000100000", "50", false])

    expect((await callTool("candy_fn_requests", { name: "hello", since: "yesterday" })).error).toBeString()
    expect(calls).toHaveLength(2)
  })

  test("candy_fn_request returns bodies as text and cuts huge ones", async () => {
    const huge = "x".repeat(100_000)
    const calls = stubDaemon(() => ({
      id: "r1", method: "POST", url: "https://hello.localhost/api", status: 500,
      reqHeaders: [["authorization", "[redacted]"]],
      reqBody: '{"msg":"hi"}', resBody: huge,
      binaryBody: { size: 10, sha256: "ab" },
      logs: [{ level: "error", text: "boom", ts: 1 }],
    }))
    const text: string = await callTool("candy_fn_request", { name: "hello", id: "r1" })
    expect(calls[0]).toMatchObject({ path: "/fn/request?name=hello&id=r1", method: "GET" })
    expect(text).toContain('--- reqBody ---\n{"msg":"hi"}')
    expect(text).toContain("--- resBody ---\nxxx")
    expect(text).toContain("more characters cut")
    expect(text.length).toBeLessThan(30_000)
    // the metadata stays JSON, binary body markers included
    const meta = JSON.parse(text.slice(0, text.indexOf("\n\n---")))
    expect(meta).toMatchObject({ id: "r1", status: 500, binaryBody: { size: 10, sha256: "ab" } })
    expect(meta.reqBody).toBeUndefined()

    expect((await callTool("candy_fn_request", { name: "hello" })).error).toBeString()
  })

  test("candy_fn_request formats a request whose function threw (error is an object)", async () => {
    // The real fn-log RequestDetail shape
    stubDaemon(() => ({
      id: "r2", method: "POST", url: "/api", status: 500, outcome: "threw",
      error: { message: "boom", stack: "Error: boom\n    at fetch" },
      reqBody: { kind: "text", contentType: "application/json", text: '{"a":1}', size: 7, truncated: false, sha256: null },
      resBody: { kind: "binary", contentType: "image/png", text: null, size: 10, truncated: false, sha256: "ab" },
      logs: [],
    }))
    const text: string = await callTool("candy_fn_request", { name: "hello", id: "r2" })
    expect(typeof text).toBe("string")
    expect(text).toContain('--- reqBody ---\n{"a":1}')
    const meta = JSON.parse(text.slice(0, text.indexOf("\n\n---")))
    expect(meta.error).toEqual({ message: "boom", stack: "Error: boom\n    at fetch" })
    // binary bodies stay as metadata
    expect(meta.resBody).toMatchObject({ kind: "binary", sha256: "ab" })
  })

  test("candy_fn_request passes a daemon error back unchanged", async () => {
    globalThis.fetch = (async (input: any) => String(input).endsWith("/mcp/auth")
      ? Response.json({ apiKey: "k" })
      : Response.json({ success: false, error: "no such request" }, { status: 404 })) as typeof fetch
    expect(await callTool("candy_fn_request", { name: "hello", id: "nope" })).toMatchObject({ error: "no such request", status: 404 })
  })

  test("candy_fn_replay posts and shows the response body as text", async () => {
    const calls = stubDaemon(() => ({ status: 200, headers: [["content-type", "text/plain"]], body: "fixed!", requestId: "r2" }))
    const text: string = await callTool("candy_fn_replay", { name: "hello", id: "r1", allowPartial: true })
    expect(calls[0]).toMatchObject({ path: "/fn/replay", method: "POST", body: { name: "hello", id: "r1", allowPartial: true } })
    expect(calls[0].headers["x-candy-actor"]).toBe("AI")
    expect(text).toContain('"requestId": "r2"')
    expect(text).toEndWith("--- body ---\nfixed!")
    await callTool("candy_fn_replay", { name: "hello", id: "r1" })
    expect(calls[1].body).toEqual({ name: "hello", id: "r1" })
  })

  test("candy_fn_kv ops", async () => {
    const calls = stubDaemon(() => ({ success: true }))
    await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "get", key: "a", value: "ignored" })
    await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "put", key: "a", value: "1" })
    await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "list", prefix: "user:", limit: 10, key: "ignored" })
    await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "delete", key: "a" })
    expect(calls.every(c => c.path === "/fn/kv" && c.method === "POST")).toBe(true)
    expect(calls.map(c => c.body)).toEqual([
      { name: "hello", binding: "KV", op: "get", key: "a" },
      { name: "hello", binding: "KV", op: "put", key: "a", value: "1" },
      { name: "hello", binding: "KV", op: "list", prefix: "user:", limit: 10 },
      { name: "hello", binding: "KV", op: "delete", key: "a" },
    ])
    expect((await callTool("candy_fn_kv", { name: "hello", op: "get", key: "a" })).error).toBeString()
    expect((await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "drop" })).error).toBeString()
    expect((await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "get" })).error).toBeString()
    expect((await callTool("candy_fn_kv", { name: "hello", binding: "KV", op: "put", key: "a" })).error).toBeString()
    expect(calls).toHaveLength(4)
  })

  test("candy_fn_d1 sends sql and params", async () => {
    const calls = stubDaemon(() => ({ results: [{ n: 1 }], success: true, meta: { changes: 0 } }))
    const res = await callTool("candy_fn_d1", { name: "hello", binding: "DB", sql: "SELECT ? AS n", params: [1] })
    expect(calls[0]).toMatchObject({ path: "/fn/d1", method: "POST", body: { name: "hello", binding: "DB", sql: "SELECT ? AS n", params: [1] } })
    expect(res.results).toEqual([{ n: 1 }])
    await callTool("candy_fn_d1", { name: "hello", binding: "DB", sql: "SELECT 1" })
    expect(calls[1].body).toEqual({ name: "hello", binding: "DB", sql: "SELECT 1" })
    expect((await callTool("candy_fn_d1", { name: "hello", binding: "DB" })).error).toBeString()
    expect((await callTool("candy_fn_d1", { name: "hello", binding: "DB", sql: "x", params: "1" })).error).toBeString()
    expect(calls).toHaveLength(2)
  })
})

describe("public MCP endpoint", () => {
  test("hides request logs, replay, KV and D1 from tools/list", async () => {
    const res = await handlePublicRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    const names: string[] = res!.result.tools.map((t: { name: string }) => t.name)
    for (const hidden of PUBLIC_HIDDEN_TOOLS) expect(names).not.toContain(hidden)
    expect(names).toContain("candy_fn_deploys")
    expect(names.length).toBe(TOOLS.length - PUBLIC_HIDDEN_TOOLS.size)
  })

  test("refuses those tools in tools/call without reaching the daemon", async () => {
    const calls = stubDaemon(() => ({ requests: [{ id: "secret traffic" }] }))
    for (const name of ["candy_fn_requests", "candy_fn_request", "candy_fn_replay", "candy_fn_kv", "candy_fn_d1"]) {
      const res = await handlePublicRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: { name: "hello", id: "r1" } } })
      expect(res).toMatchObject({ id: 7, error: { code: -32601 } })
    }
    expect(calls).toHaveLength(0)
    // Other tools still work
    stubDaemon(() => ({ instances: [] }))
    const ok = await handlePublicRequest({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "candy_fn_instances", arguments: { name: "hello" } } })
    expect(ok!.result.content[0].text).toContain("instances")
  })
})

describe("route targets", () => {
  test("prints functions as fn, not [object Object]", () => {
    expect(routeTargetText({ fn: "hello" })).toBe("fn")
    expect(routeTargetText(3000)).toBe(":3000")
    expect(routeTargetText("http://10.0.0.2:80")).toBe("http://10.0.0.2:80")
  })
})
