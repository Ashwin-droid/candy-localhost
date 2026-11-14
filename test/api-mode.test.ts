// A request for an API-mode server's host is the server's, whatever its method
// or path: held while the server starts, then forwarded unchanged. The daemon
// must never answer one itself (a 404 on POST /oauth/token made claude.ai drop
// its login for a server that had only been idle-stopped).
import { afterAll, describe, expect, it } from "bun:test"
import { apiHoldSeconds, createApiModeGate, type ApiModeProcess } from "../api-mode.ts"
import { fnRequestHeaders } from "../fn-daemon.ts"

const BOUND = "wa.example.test"
interface Binding { fqdn: string; protected: boolean }
interface Seen { method: string; path: string; body: string; headers: Record<string, string> }

const servers: { stop(force?: boolean): unknown }[] = []
afterAll(() => { for (const s of servers) s.stop(true) })

/** The app behind candy: says back exactly what reached it. */
const startApp = () => {
  const app = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const seen: Seen = { method: req.method, path: u.pathname + u.search, body: await req.text(), headers: Object.fromEntries(req.headers) }
      return Response.json(seen, { status: req.method === "OPTIONS" ? 200 : 207, headers: { "X-App": "wa" } })
    },
  })
  servers.push(app)
  return app
}

type StartMode = "ok" | "never" | "throws" | "exits"
/** A stopped API-mode server "wa" behind a stand-in for the daemon's port, with the real gate in front of the daemon's own answer. */
const setup = (opts: { protectedDomain?: boolean; holdMs?: number; start?: StartMode; startDelay?: number } = {}) => {
  const state = { starts: 0, proc: undefined as ApiModeProcess | undefined }
  const gate = createApiModeGate<{ id: string }, Binding>({
    isPortal: req => (req.headers.get("host") || "").startsWith("portal."),
    binding: host => host.replace(/:\d+$/, "") === BOUND ? { serverName: "wa", binding: { fqdn: BOUND, protected: !!opts.protectedDomain } } : null,
    localName: host => host.replace(/:\d+$/, "").replace(/\.(localhost|candy)$/, ""),
    config: name => name === "wa" ? { id: "cfg_wa" } : null,
    isProtected: b => b.protected,
    authorize: async () => null,
    process: () => state.proc,
    start: async () => {
      state.starts++
      if (opts.start === "throws") throw new Error("Refusing to start: no such folder")
      const proc: ApiModeProcess = { status: "starting", port: null, exitCode: null, detectedPorts: [], lastActivity: 0 }
      state.proc = proc
      if (opts.start === "exits") setTimeout(() => { proc.status = "errored"; proc.exitCode = 1 }, 100)
      else if (opts.start !== "never") setTimeout(() => { proc.port = startApp().port; proc.status = "running" }, opts.startDelay ?? 400)
      return proc
    },
    upstreamHeaders: (src, protectedDomain) => fnRequestHeaders(src, { stripCredentials: protectedDomain }),
    fetchUpstream: (target, init) => fetch(target, init),
    listening: async () => true,
    holdMs: opts.holdMs ?? 60_000,
  })
  // What the daemon's own router would say if the request got past the gate
  const daemon = Bun.serve({
    port: 0,
    async fetch(req) {
      return (await gate(req, new URL(req.url))) ?? new Response("Not found", { status: 404, headers: { "X-Daemon": "own-answer" } })
    },
  })
  servers.push(daemon)
  const send = (host: string, method: string, path: string, body?: string) => fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method,
    body,
    headers: {
      Host: host,
      Authorization: "Bearer app-token-123",
      Cookie: "sid=abc",
      "X-App-Header": "Kept As Sent",
      ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
  })
  return { state, send }
}

const REQUESTS: [method: string, path: string, body?: string][] = [
  ["POST", "/oauth/token", "grant_type=refresh_token&refresh_token=R1"],
  ["POST", "/oauth/register", '{"client_name":"Claude","redirect_uris":["https://claude.ai/cb"]}'],
  ["GET", "/oauth/authorize?response_type=code&client_id=C1&name=MixedCase"],
  ["POST", "/auth/login", '{"user":"someone","password":"x","name":"MixedCase"}'],
  ["GET", "/configs"],
  ["GET", "/candy/registry"],
  ["GET", "/candy-auth/x"],
  ["GET", "/candy-auth/check"],
  ["POST", "/candy-auth/login", "password=theirs"],
  ["GET", "/"],
  ["POST", "/mcp", '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'],
  ["OPTIONS", "/mcp"],
  ["DELETE", "/process/stop/wa?name=Wa"],
  ["GET", "/login?next=/"],
]

describe("stopped API-mode server", () => {
  for (const host of [BOUND, "wa.localhost", "wa.candy"]) {
    it(`${host}: every request starts it once and arrives unchanged`, async () => {
      const { state, send } = setup()
      const responses = await Promise.all(REQUESTS.map(([method, path, body]) => send(host, method, path, body)))
      expect(state.starts).toBe(1)
      for (const [i, res] of responses.entries()) {
        const [method, path, body] = REQUESTS[i]
        const label = `${method} ${path}`
        expect(res.headers.get("X-Daemon"), label).toBeNull()
        expect(res.headers.get("X-App"), label).toBe("wa")
        expect(res.status, label).toBe(method === "OPTIONS" ? 200 : 207)
        const seen = await res.json() as Seen
        expect(seen.method, label).toBe(method)
        expect(seen.path, label).toBe(path)
        expect(seen.body, label).toBe(body ?? "")
        expect(seen.headers.host, label).toBe(host)
        expect(seen.headers.authorization, label).toBe("Bearer app-token-123")
        expect(seen.headers.cookie, label).toBe("sid=abc")
        expect(seen.headers["x-app-header"], label).toBe("Kept As Sent")
        if (body !== undefined) expect(seen.headers["content-type"], label).toBe("application/x-www-form-urlencoded")
      }
      // Now running: straight through, still one start
      const again = await send(host, "POST", "/oauth/token", "grant_type=x")
      expect(again.status).toBe(207)
      expect(state.starts).toBe(1)
    })
  }

  it("waits out a slow cold start", async () => {
    const { state, send } = setup({ startDelay: 2500 })
    const res = await send(BOUND, "POST", "/oauth/token", "grant_type=x")
    expect(res.status).toBe(207)
    expect(state.starts).toBe(1)
  })

  it("a protected bound domain keeps only candy's check and login", async () => {
    const { state, send } = setup({ protectedDomain: true })
    expect((await send(BOUND, "GET", "/candy-auth/check")).headers.get("X-Daemon")).toBe("own-answer")
    expect((await send(BOUND, "POST", "/candy-auth/login", "password=x")).headers.get("X-Daemon")).toBe("own-answer")
    expect(state.starts).toBe(0)
    expect((await send(BOUND, "GET", "/candy-auth/x")).headers.get("X-App")).toBe("wa")
    expect((await send(BOUND, "GET", "/candy-auth/login")).headers.get("X-App")).toBe("wa")
    expect(state.starts).toBe(1)
  })

  it("other hosts are not its business", async () => {
    const { state, send } = setup()
    for (const host of ["portal.localhost", "other.localhost", "localhost:9999", "100.64.0.1:9999"]) {
      expect((await send(host, "POST", "/oauth/token", "x")).headers.get("X-Daemon"), host).toBe("own-answer")
    }
    expect(state.starts).toBe(0)
  })

  for (const start of ["never", "throws", "exits"] as StartMode[]) {
    it(`start ${start}: 503 with Retry-After, never 404`, async () => {
      const { state, send } = setup({ start, holdMs: 400 })
      const responses = await Promise.all([send(BOUND, "POST", "/oauth/token", "grant_type=x"), send("wa.localhost", "GET", "/")])
      for (const res of responses) {
        expect(res.status).toBe(503)
        expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0)
        expect(res.headers.get("X-Candy")).toBe("api-mode")
      }
      // A start that was refused outright is tried again by the next request
      if (start !== "throws") expect(state.starts).toBe(1)
    })
  }

  it("holds for at least a minute, 90s unless set", () => {
    expect(apiHoldSeconds(undefined)).toBe(90)
    expect(apiHoldSeconds("")).toBe(90)
    expect(apiHoldSeconds("junk")).toBe(90)
    expect(apiHoldSeconds("10")).toBe(60)
    expect(apiHoldSeconds("300")).toBe(300)
  })
})

describe("controlFetch (daemon.ts)", () => {
  it("runs the API-mode gate before any route of its own", async () => {
    const source = await Bun.file(new URL("../daemon.ts", import.meta.url)).text()
    const start = source.indexOf("async function controlFetch(")
    const gate = source.indexOf("const apiAnswer = await apiModeGate(req, url)", start)
    expect(start).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(start)
    const before = source.slice(start, gate).split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
    // Ahead of it: only the peer check, candy's own host (its MCP paths, else the passkey
    // ceremonies), the public MCP host and functions (other hosts)
    expect(before.match(/\breturn\b/g)?.length).toBe(5)
    expect(before).toContain("return await candyHostRoutes.handle(")
    expect(before).toContain('return new Response("Forbidden", { status: 403 })')
    expect(before).toContain("return await handlePublicMcp(")
    expect(before).toContain("return await serveFunction(")
    expect(before).not.toContain("lowerRequestNames(")
    expect(before).not.toContain("req.method")
    // and the tailnet API isn't served on a site's host
    expect(source.slice(gate)).toContain('const isCandyApi = !siteHost && url.pathname.startsWith("/candy/")')
  })
})
