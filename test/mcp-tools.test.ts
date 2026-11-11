import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TOOLS, handleRequest } from "../mcp.ts"

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
      expect(tool.name).toMatch(/^candy_[a-z_]+$/)
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

  test("a daemon error is passed back", async () => {
    globalThis.fetch = (async (input: any) => String(input).endsWith("/mcp/auth")
      ? Response.json({ apiKey: "k" })
      : Response.json({ error: "No binding found for 'nope'" }, { status: 404 })) as typeof fetch
    const res = await callTool("candy_domain", { action: "auth_token", subdomain: "nope" })
    expect(res).toMatchObject({ error: "No binding found for 'nope'", status: 404 })
  })
})
