import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Only help and argument errors: these exit before the CLI talks to the daemon.
const CLI = join(import.meta.dir, "..", "cli.ts")
// Point auth at nothing so a check that slipped past validation fails loudly
// instead of reaching the real daemon.
const env = { ...process.env, CANDY_SECRET_FILE: "/nonexistent/candy-secret", HOME: "/nonexistent", NO_COLOR: "1" }

const run = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe("candy fn CLI", () => {
  it("prints fn help", () => {
    for (const args of [["fn"], ["fn", "help"], ["fn", "--help"], ["fn", "requests", "--help"]]) {
      const r = run(...args)
      expect(r.code).toBe(0)
      for (const sub of ["add", "deploy", "rollback", "deploys", "instances", "set", "requests", "request", "tail", "replay", "kv", "d1"]) {
        expect(r.out).toContain(`candy fn\x1b[0m ${sub}`)
      }
      expect(r.out).toContain('"run_worker_first": ["/api/*"]')
    }
  })

  it("lists fn in the main help", () => {
    const r = run("help")
    expect(r.code).toBe(0)
    expect(r.out).toContain("add <name> [path]")
  })

  it("rejects bad arguments before calling the daemon", () => {
    const cases: [string[], RegExp][] = [
      [["fn", "nope"], /Unknown fn command: nope/],
      [["fn", "add"], /Usage: candy fn add/],
      [["fn", "add", "x", "--hot", "-1"], /--hot must be a whole number/],
      [["fn", "set", "x"], /Usage: candy fn set/],
      [["fn", "set", "x", "--log", "loud"], /--log must be full, meta or off/],
      [["fn", "set", "x", "--hot", "5", "--max", "2"], /--hot cannot be more than --max/],
      [["fn", "requests"], /Usage: candy fn requests/],
      [["fn", "requests", "x", "--since", "soon"], /--since takes a duration/],
      [["fn", "requests", "x", "--status", "teapot"], /--status takes a code/],
      [["fn", "request"], /Usage: candy fn request/],
      [["fn", "replay", "x"], /Usage: candy fn replay/],
      [["fn", "kv", "x"], /Usage: candy fn kv/],
      [["fn", "kv", "x", "frob"], /kv takes get, put, list or delete/],
      [["fn", "kv", "x", "put", "k"], /put <key> <value>/],
      [["fn", "d1", "x"], /Usage: candy fn d1/],
    ]
    for (const [args, re] of cases) {
      const r = run(...args)
      expect(r.code).toBe(1)
      expect(r.err).toMatch(re)
      expect(r.err).not.toContain("Could not authenticate")
    }
  })
})

// Against a throwaway daemon stub on an ephemeral port (never 9999)
describe("candy fn CLI against a stub daemon", () => {
  const dir = "/tmp/claude-1000/candy-fn-build/fix/cli"
  let server: ReturnType<typeof Bun.serve>
  const ESC = "\x1b"
  const detail = {
    id: "r1", ts: Date.now(), method: "POST", url: "/api", path: "/api", status: 500, outcome: "threw",
    host: "hello.localhost", clientIp: "1.2.3.4", instance: "hello-1", cold: true, queuedMs: 1, ttfbMs: null, totalMs: 3,
    error: { message: "boom", stack: "Error: boom\n    at fetch" },
    reqHeaders: [["x-evil", `${ESC}]52;c;cHduZWQ=\x07`]],
    resHeaders: [],
    reqBody: { kind: "text", contentType: "text/plain", text: `hi ${ESC}[2J there`, size: 12, truncated: false, sha256: null },
    resBody: { kind: "binary", contentType: "image/png", text: null, size: 10, truncated: false, sha256: "abcd" },
    logs: [{ level: "log", text: `log ${ESC}]0;title\x07`, ts: Date.now() }],
    logsTruncated: false,
  }

  const siteFn = {
    entry: null, deploy: null, hot: 0, max: 4, linger: 30, log: true, hasWorker: false, source: "live",
    assets: { directory: "/srv/site/dist", binding: null, notFound: "single-page-application", html: "auto-trailing-slash", runWorkerFirst: false },
  }

  beforeAll(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/secret`, "stub-secret\n")
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/mcp/auth") return Response.json({ apiKey: "k" })
        if (req.headers.get("x-candy-api-key") !== "k") return Response.json({ error: "unauthorized" }, { status: 401 })
        if (path === "/fn/request") return Response.json(detail)
        if (path === "/fn/replay") return Response.json({ status: 200, headers: [], body: { kind: "omitted", size: 5 }, requestId: "r9" })
        if (path === "/fn/requests") return Response.json({ success: true, requests: [
          { id: "a1", ts: Date.now(), method: "GET", path: "/app/x", status: 200, outcome: "ok", cold: false, instance: "", totalMs: 1, kind: "asset", rule: "spa-navigate" },
          { id: "w1", ts: Date.now(), method: "GET", path: "/api/me", status: 200, outcome: "ok", cold: true, instance: "site-1", totalMs: 9, kind: "worker", rule: "worker-first:/api/*" },
          { id: "e1", ts: Date.now(), method: "GET", path: "/evil", status: 302, outcome: "ok", cold: false, instance: "", totalMs: 1, kind: "asset", rule: `/evil ${ESC}]0;t\x07 302` },
        ] })
        // grown: added assets-only, main added to the project since; entry stays null, the routing has a worker
        if (path === "/fn/instances") return Response.json({ success: true, instances: [], fn: new URL(req.url).searchParams.get("name") === "grown" ? { ...siteFn, hasWorker: true } : { ...siteFn } })
        if (path === "/fn/deploys") return Response.json({ success: true, current: "d1", fn: { ...siteFn }, deploys: [
          { id: "d1", createdAt: Date.now(), entry: null, assets: "/state/deploys/d1/assets", size: 0, gitRev: null, source: "/srv/site", main: null },
        ] })
        if (path === "/status") return Response.json({ pid: 1, routeCount: 1, portalCount: 0 })
        if (path === "/configs") return Response.json({ success: true, configs: {
          site: { cwd: "/srv/site", cmd: "", fn: { ...siteFn } },
          grown: { cwd: "/srv/grown", cmd: "", fn: { ...siteFn, hasWorker: true } },
          api: { cwd: "/srv/api", cmd: "fn-host.ts src/index.ts", fn: { ...siteFn, entry: "src/index.ts", hasWorker: true, assets: { ...siteFn.assets, binding: "ASSETS", runWorkerFirst: ["/api/*", "!/api/docs/*"] } } },
        } })
        if (path === "/routes") return Response.json({ hello: { target: { fn: "hello" }, isRestricted: false }, web: { target: 3000 } })
        return Response.json({ error: "not found" }, { status: 404 })
      },
    })
  })
  afterAll(() => {
    server?.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  const runAsync = async (...args: string[]) => {
    const p = Bun.spawn(["bun", CLI, ...args], {
      env: { ...env, CANDY_SECRET_FILE: `${dir}/secret`, CANDY_API_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe", stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out, err }
  }

  it("prints a request whose function threw, with its bodies", async () => {
    const r = await runAsync("fn", "request", "r1", "--name", "hello")
    expect(r.code).toBe(0)
    expect(r.out).toContain("boom")
    expect(r.out).toContain("at fetch")
    expect(r.out).toContain("(binary, 10 bytes, sha256 abcd)")
    expect(r.out).toContain("hi \\x1b[2J there")
  })

  it("never prints escape sequences from logged data", async () => {
    const r = await runAsync("fn", "request", "r1", "--name", "hello")
    // Only the CLI's own colour codes (ESC[...m) may appear
    const stray = r.out.replace(/\x1b\[[0-9;]*m/g, "")
    expect(stray).not.toContain(ESC)
    expect(stray).not.toContain("\x07")
    expect(r.out).toContain("\\x1b]52;c;")
  })

  it("prints omitted bodies from a replay", async () => {
    const r = await runAsync("fn", "replay", "hello", "r1")
    expect(r.code).toBe(0)
    expect(r.out).toContain("(not logged: meta mode, 5 bytes)")
  })

  it("shows kind and rule in the request list, escaped", async () => {
    const r = await runAsync("fn", "requests", "site")
    expect(r.code).toBe(0)
    expect(r.out).toContain("ROUTE")
    expect(r.out).toMatch(/\/app\/x.*asset.*spa-navigate/)
    expect(r.out).toMatch(/\/api\/me.*worker-first:\/api\/\*/)
    const stray = r.out.replace(/\x1b\[[0-9;]*m/g, "")
    expect(stray).not.toContain(ESC)
    expect(r.out).toContain("\\x1b]0;t")
  })

  it("shows an assets-only function's instances and deploys", async () => {
    const i = await runAsync("fn", "instances", "site")
    expect(i.code).toBe(0)
    expect(i.out).toContain("assets-only")
    expect(i.out).toContain("/srv/site/dist")
    expect(i.out).toContain("SPA")
    const d = await runAsync("fn", "deploys", "site")
    expect(d.code).toBe(0)
    expect(d.out).toContain("ASSETS")
    expect(d.out).toMatch(/d1.*assets-only.*yes/)
  })

  it("decides assets-only from hasWorker, not a stale entry", async () => {
    const i = await runAsync("fn", "instances", "grown")
    expect(i.code).toBe(0)
    expect(i.out).not.toContain("assets-only")
    expect(i.out).toContain("no instances running")
    const r = await runAsync("list")
    const grown = r.out.replace(/\x1b\[[0-9;]*m/g, "").split(/\n(?=\S)/).find(b => b.includes("grown"))!
    expect(grown).toBeDefined()
    expect(grown).not.toContain("assets-only")
  })

  it("lists assets and run_worker_first patterns", async () => {
    const r = await runAsync("list")
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/site[\s\S]*assets-only[\s\S]*\/srv\/site\/dist/)
    expect(r.out).toContain("src/index.ts")
    expect(r.out).toContain("/api/* !/api/docs/*")
    expect(r.out).toContain("env.ASSETS")
  })

  it("lists a function route as fn", async () => {
    const r = await runAsync("routes")
    expect(r.out).toContain("hello.localhost")
    expect(r.out).not.toContain("[object Object]")
    expect(r.out).toMatch(/hello\.localhost\S* -> fn/)
    expect(r.out).toMatch(/web\.localhost\S* -> :3000/)
  })
})
