// End to end: FnRuntime (the daemon's socket + pool + dispatch) driving real
// `bun fn-host.ts` instances, without the daemon itself. Nothing here binds a
// TCP port; the shim only dials the runtime's unix socket.
import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs"
import { join } from "node:path"
import { FnRuntime, type FnLaunched } from "../fn-runtime.ts"
import { FnLog } from "../fn-log.ts"
import { loadFnProjectConfig } from "../fn-config.ts"
import { runFnTool } from "../fn-tool.ts"

const ROOT = join(import.meta.dir, "..")
const HOST = join(ROOT, "fn-host.ts")
const HELLO = join(import.meta.dir, "fixtures", "fn-hello")
const BINDINGS = join(HELLO, "bindings")
const BASE = "/tmp/claude-1000/candy-fn-build/integrate/e2e"
mkdirSync(BASE, { recursive: true })
const dirs: string[] = []
const runtimes: FnRuntime[] = []

afterAll(async () => {
  for (const rt of runtimes) await rt.close().catch(() => {})
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface Spawned { pid: number; proc: ReturnType<typeof Bun.spawn>; stderr: Promise<string> }

// A runtime whose instances are plain child processes of this test
const setup = async (opts: { dir: string; entry: string; hot?: number; max?: number; lingerMs?: number; log?: boolean }) => {
  const tmp = mkdtempSync(join(BASE, "rt-"))
  dirs.push(tmp)
  const cfg = await loadFnProjectConfig(opts.dir)
  const children: Spawned[] = []
  const log = opts.log === false ? null : new FnLog(join(tmp, "log.sqlite"))
  const rt = new FnRuntime({
    name: "hello",
    socketPath: join(tmp, "fn.sock"),
    hot: opts.hot ?? 0,
    max: opts.max ?? 4,
    startTimeoutMs: 10_000,
    log: () => log,
    launch: async ({ id, token, socketPath }): Promise<FnLaunched> => {
      const proc = Bun.spawn(["bun", HOST, opts.entry], {
        cwd: opts.dir,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          CANDY_FN_SOCKET: socketPath,
          CANDY_FN_TOKEN: token,
          CANDY_FN_INSTANCE: id,
          CANDY_FN_STATE: join(tmp, "state"),
          CANDY_FN_CONFIG: JSON.stringify(cfg),
          CANDY_FN_LINGER_MS: String(opts.lingerMs ?? 0),
        },
        stdout: "ignore",
        stderr: "pipe",
      })
      children.push({ pid: proc.pid, proc, stderr: new Response(proc.stderr).text() })
      return { pid: proc.pid, kill: () => proc.kill(), exited: proc.exited }
    },
  })
  runtimes.push(rt)
  await rt.listen()
  return { rt, log, children, tmp }
}

const req = (path: string, init?: RequestInit) => new Request(`http://hello.localhost${path}`, init)
const meta = { clientIp: "127.0.0.1", host: "hello.localhost" }

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(20)
  }
}

// TCP sockets in LISTEN state owned by a pid: socket inodes from /proc/<pid>/fd
// matched against /proc/<pid>/net/tcp{,6}
const listeningTcp = (pid: number): number[] => {
  const inodes = new Set<string>()
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)
      if (m) inodes.add(m[1])
    } catch {}
  }
  const ports: number[] = []
  for (const file of ["tcp", "tcp6"]) {
    let text = ""
    try { text = readFileSync(`/proc/${pid}/net/${file}`, "utf8") } catch { continue }
    for (const line of text.split("\n").slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10) continue
      if (f[3] === "0A" && inodes.has(f[9])) ports.push(parseInt(f[1].split(":")[1], 16))
    }
  }
  return ports
}

describe("fn end to end", () => {
  it("serves GET, streamed POST, SSE and a throwing route, and logs them", async () => {
    const { rt, log } = await setup({ dir: HELLO, entry: "index.ts", hot: 1 })
    await rt.pool.ensureHot()

    const res = await rt.handle(req("/"), meta)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("hello from candy\n")

    const json = await (await rt.handle(req("/json?a=1"), meta)).json()
    expect(json).toMatchObject({ path: "/json", query: { a: "1" }, ip: "127.0.0.1" })

    // Request body arrives as a stream of chunks and is echoed back
    const enc = new TextEncoder()
    const parts = ["one,", "two,", "three"]
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const p = parts.shift()
        if (p === undefined) return c.close()
        c.enqueue(enc.encode(p))
        await Bun.sleep(5)
      },
    })
    const echo = await rt.handle(req("/echo", { method: "POST", body, headers: { "content-type": "text/plain" }, duplex: "half" } as RequestInit), meta)
    expect(await echo.text()).toBe("one,two,three")

    const sse = await rt.handle(req("/stream"), meta)
    expect(sse.headers.get("content-type")).toBe("text/event-stream")
    expect(await sse.text()).toBe("data: tick 0\n\ndata: tick 1\n\ndata: tick 2\n\n")

    const boom = await rt.handle(req("/throw"), { ...meta, showStack: true })
    expect(boom.status).toBe(500)
    const text = await boom.text()
    expect(text).toContain("boom")
    expect(text).toContain("index.ts")  // the fn's own stack, on .localhost
    const quiet = await rt.handle(req("/throw"), meta)
    expect(await quiet.text()).not.toContain("index.ts")

    // console output inside a request comes back as LOG frames on its row
    const logged = await rt.handle(req("/log"), meta)
    expect(await logged.text()).toBe("logged")
    await Bun.sleep(100)
    const rows = log!.query({ limit: 50 })
    const logRow = rows.find(r => r.path === "/log")!
    const detail = log!.get(logRow.id)!
    expect(detail.logs.map(l => [l.level, l.text])).toEqual([["log", "hello from /log"], ["warn", "careful"]])
    expect(rows.find(r => r.path === "/throw")).toMatchObject({ status: 500, outcome: "threw" })
    expect(rows.find(r => r.path === "/echo")).toMatchObject({ status: 200, outcome: "ok", reqBytes: 13 })
    expect(log!.get(rows.find(r => r.path === "/echo")!.id)!.reqBody.text).toBe("one,two,three")
  }, 30_000)

  it("TTL 0: an instance exits once its response is done", async () => {
    const { rt, children } = await setup({ dir: HELLO, entry: "index.ts" })
    const res = await rt.handle(req("/"), meta)
    expect(await res.text()).toBe("hello from candy\n")
    expect(children).toHaveLength(1)
    // BYE after the first-request grace, then exit 0
    expect(await children[0].proc.exited).toBe(0)
    await waitFor(() => rt.instances().length === 0)
    // The next request cold-starts a new one
    expect(await (await rt.handle(req("/"), meta)).text()).toBe("hello from candy\n")
    expect(children).toHaveLength(2)
  }, 20_000)

  it("a hot instance stays up after its requests and opens no TCP port", async () => {
    const { rt, children } = await setup({ dir: HELLO, entry: "index.ts", hot: 1 })
    await rt.pool.ensureHot()
    expect(await (await rt.handle(req("/"), meta)).text()).toBe("hello from candy\n")
    await Bun.sleep(1500)  // past the shim's first-request grace
    expect(children).toHaveLength(1)
    expect(existsSync(`/proc/${children[0].pid}`)).toBe(true)
    expect(rt.instances()).toMatchObject([{ hot: true, ready: true, inflight: 0 }])
    expect(listeningTcp(children[0].pid)).toEqual([])
    await rt.close()
    expect(await children[0].proc.exited).toBe(0)
  }, 20_000)

  it("requests racing an instance's BYE are all served", async () => {
    const { rt, children } = await setup({ dir: HELLO, entry: "index.ts", max: 2 })
    // Back to back: each one can land while the previous instance is saying BYE
    for (let i = 0; i < 12; i++) {
      const res = await rt.handle(req(`/json?i=${i}`), meta)
      expect(res.status).toBe(200)
      expect((await res.json()).query.i).toBe(String(i))
      if (i % 3 === 2) await Bun.sleep(1000 + (i % 2) * 30)  // around the BYE moment
    }
    // A burst on a cold function starts one instance, not max
    const before = children.length
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => rt.handle(req(`/json?b=${i}`), meta)))
    expect(burst.every(r => r.status === 200)).toBe(true)
    expect(children.length - before).toBeLessThanOrEqual(1)
    for (const c of children) expect(await c.proc.exited).toBe(0)
  }, 40_000)

  it("lingers before BYE when fn.linger is set", async () => {
    const { rt, children } = await setup({ dir: HELLO, entry: "index.ts", lingerMs: 1500 })
    await (await rt.handle(req("/"), meta)).text()
    const t0 = Date.now()
    await Bun.sleep(900)  // linger timer still running
    expect(existsSync(`/proc/${children[0].pid}`)).toBe(true)
    // Served warm by the same instance
    await (await rt.handle(req("/"), meta)).text()
    expect(children).toHaveLength(1)
    expect(await children[0].proc.exited).toBe(0)
    // The timer restarted at the second idle, so it lived well past the first expiry
    expect(Date.now() - t0).toBeGreaterThan(2000)
  }, 20_000)

  it("KV and D1 bindings work through the transport, and --scheduled writes to D1", async () => {
    const { rt, tmp } = await setup({ dir: BINDINGS, entry: "src/index.ts", log: false })
    expect(await (await rt.handle(req("/count"), meta)).json()).toEqual({ count: 1, greeting: "hi" })
    expect(await (await rt.handle(req("/count"), meta)).json()).toEqual({ count: 2, greeting: "hi" })
    expect(await (await rt.handle(req("/ticks"), meta)).json()).toEqual({ ticks: 0 })

    // A cron run is a one-shot `fn-host.ts <entry> --scheduled <expr>`, no socket
    const cfg = await loadFnProjectConfig(BINDINGS)
    const run = Bun.spawn(["bun", HOST, "src/index.ts", "--scheduled", "*/5 * * * *"], {
      cwd: BINDINGS,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CANDY_FN_STATE: join(tmp, "state"), CANDY_FN_CONFIG: JSON.stringify(cfg) },
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(await run.exited).toBe(0)
    expect(await (await rt.handle(req("/ticks"), meta)).json()).toEqual({ ticks: 1 })

    // The daemon's own view of the bindings (fn-tool, as the fn's user)
    expect(await runFnTool("kv", { stateDir: join(tmp, "state"), binding: "KV", op: "get", key: "count" })).toEqual({ value: "2" })
    const d1 = await runFnTool("d1", { stateDir: join(tmp, "state"), binding: "DB", sql: "SELECT cron FROM ticks WHERE cron = ?", params: ["*/5 * * * *"] }) as any
    expect(d1.results).toEqual([{ cron: "*/5 * * * *" }])
  }, 30_000)

  it("a wrong token is refused and the request fails to start cleanly", async () => {
    const tmp = mkdtempSync(join(BASE, "rt-"))
    dirs.push(tmp)
    const rt = new FnRuntime({
      name: "bad",
      socketPath: join(tmp, "fn.sock"),
      hot: 0,
      max: 1,
      startTimeoutMs: 3000,
      launch: async ({ id, socketPath }) => {
        const proc = Bun.spawn(["bun", HOST, "index.ts"], {
          cwd: HELLO,
          env: { PATH: process.env.PATH ?? "", CANDY_FN_SOCKET: socketPath, CANDY_FN_TOKEN: "wrong", CANDY_FN_INSTANCE: id, CANDY_FN_STATE: join(tmp, "state") },
          stdout: "ignore",
          stderr: "ignore",
        })
        return { pid: proc.pid, kill: () => proc.kill(), exited: proc.exited }
      },
    })
    runtimes.push(rt)
    const res = await rt.handle(req("/"), meta)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain("exited before saying HELLO")
  }, 15_000)
})
