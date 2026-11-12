import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assetsFromEnv, checkAssetsBinding, configFromEnv, createAssetsBinding, headerPairs, loadHandler, LogBudget, MAX_REQUEST_LOG_LINES, parseHostArgs, secretsFromEnv } from "../fn-host.ts"
import { AssetServer, type AssetsConfig } from "../fn-assets.ts"

const ROOT = join(import.meta.dir, "..")
const HOST = join(ROOT, "fn-host.ts")
const FIXTURE = join(import.meta.dir, "fixtures", "fn-hello")
const BASE = "/tmp/claude-1000/candy-fn-build/phase1b"
mkdirSync(BASE, { recursive: true })

describe("loadHandler", () => {
  const req = new Request("http://x.localhost/")

  it("accepts a { fetch, scheduled } default export", async () => {
    const h = loadHandler({ default: { fetch: () => new Response("a"), scheduled: () => {} } })
    expect(await (h.fetch!(req, {}, {}) as Response).text()).toBe("a")
    expect(typeof h.scheduled).toBe("function")
  })

  it("binds class-based apps like Hono to themselves", async () => {
    class App {
      name = "app"
      fetch(_req: Request) { return new Response(this.name) }
    }
    const h = loadHandler({ default: new App() })
    expect(await (h.fetch!(req, {}, {}) as Response).text()).toBe("app")
    expect(h.scheduled).toBeUndefined()
  })

  it("wraps a bare function and passes env and ctx through", async () => {
    const h = loadHandler({ default: (_r: Request, env: { A: string }, ctx: { id: number }) => new Response(`${env.A}${ctx.id}`) })
    expect(await (h.fetch!(req, { A: "x" }, { id: 1 }) as Response).text()).toBe("x1")
  })

  it("takes the module itself when there is no default export", async () => {
    const h = loadHandler({ fetch: () => new Response("named") })
    expect(await (h.fetch!(req, {}, {}) as Response).text()).toBe("named")
  })

  it("loads the sample fixture", async () => {
    const h = loadHandler(await import(join(FIXTURE, "index.ts")))
    const res = (await h.fetch!(new Request("http://x/json?a=1"), {}, { waitUntil() {} })) as Response
    expect(await res.json()).toMatchObject({ path: "/json", query: { a: "1" } })
  })

  it("rejects anything else with a clear message", () => {
    expect(() => loadHandler({})).toThrow("got an object with keys: (none)")
    expect(() => loadHandler({ default: { get: () => {} } })).toThrow("keys: get")
    expect(() => loadHandler({ default: 42 })).toThrow("got number")
    expect(() => loadHandler(null)).toThrow("got null")
    expect(() => loadHandler({ default: { fetch: "nope" } })).toThrow("export default { fetch }")
  })
})

describe("host helpers", () => {
  it("parses argv", () => {
    expect(parseHostArgs(["src/index.ts"])).toEqual({ entry: "src/index.ts", scheduled: null })
    expect(parseHostArgs(["w.js", "--scheduled", "*/5 * * * *"])).toEqual({ entry: "w.js", scheduled: "*/5 * * * *" })
    expect(() => parseHostArgs([])).toThrow("usage")
    expect(() => parseHostArgs(["a", "--scheduled"])).toThrow("cron expression")
    expect(() => parseHostArgs(["a", "b"])).toThrow("unexpected")
  })

  it("reads config and secrets from env", () => {
    expect(configFromEnv(undefined)).toMatchObject({ vars: {}, kv: [], d1: [], crons: [] })
    expect(configFromEnv(JSON.stringify({ vars: { A: "1" }, kv: ["KV"] }))).toMatchObject({ vars: { A: "1" }, kv: ["KV"], d1: [] })
    expect(secretsFromEnv(" API_KEY, MISSING ,,DB_URL", { API_KEY: "k", DB_URL: "u", OTHER: "o" })).toEqual({ API_KEY: "k", DB_URL: "u" })
    expect(secretsFromEnv(undefined, { A: "1" })).toEqual({})
  })

  it("caps console output per request with one final notice", () => {
    const b = new LogBudget()
    let sent = 0
    let last: { level: string; text: string } | null = null
    for (let i = 0; i < MAX_REQUEST_LOG_LINES + 50; i++) {
      for (const e of b.take({ level: "log", text: `line ${i}`, ts: i })) { sent++; last = e }
    }
    expect(sent).toBe(MAX_REQUEST_LOG_LINES + 1)
    expect(last).toMatchObject({ level: "warn", text: "[candy] console output for this request truncated" })
    const big = new LogBudget()
    expect(big.take({ level: "log", text: "x".repeat(300 * 1024), ts: 0 })[0].text).toContain("truncated")
    expect(big.take({ level: "log", text: "after", ts: 1 })).toEqual([])
  })

  it("keeps each Set-Cookie separate", () => {
    const h = new Headers({ "content-type": "text/plain" })
    h.append("set-cookie", "a=1, b")
    h.append("set-cookie", "c=2")
    expect(headerPairs(h)).toEqual([["content-type", "text/plain"], ["set-cookie", "a=1, b"], ["set-cookie", "c=2"]])
  })
})

// --- end to end against a fake daemon on a unix socket ---

const SIBLINGS = ["fn-protocol.ts", "fn-bindings.ts", "fn-cron.ts", "fn-console.ts"]
const haveSiblings = SIBLINGS.every(f => existsSync(join(ROOT, f)))
// Loaded lazily so the unit tests above still run while sibling modules are being written.
const proto = haveSiblings ? await import("../fn-protocol.ts") : (null as never)

type F = { type: number; streamId: number; payload: Uint8Array }
const children: Bun.Subprocess[] = []
afterAll(() => { for (const c of children) c.kill() })

class FakeDaemon {
  frames: F[] = []
  closed = false
  private wake: (() => void) | null = null
  private sock: Bun.Socket | null = null
  private connected: Promise<void>
  private server: Bun.UnixSocketListener<undefined>
  readonly path: string

  constructor(dir: string) {
    this.path = join(dir, "fn.sock")
    const decoder = new proto.FrameDecoder()
    let onOpen!: () => void
    this.connected = new Promise(r => { onOpen = r })
    this.server = Bun.listen({
      unix: this.path,
      socket: {
        open: s => { this.sock = s; onOpen() },
        data: (_s, chunk) => {
          this.frames.push(...decoder.push(new Uint8Array(chunk)))
          this.wake?.()
        },
        close: () => { this.closed = true; this.wake?.() },
      },
    })
  }

  // Removes and returns the first frame matching `pred`.
  async take(pred: (f: F) => boolean, ms = 5000): Promise<F> {
    const deadline = Date.now() + ms
    while (true) {
      const i = this.frames.findIndex(pred)
      if (i >= 0) return this.frames.splice(i, 1)[0]
      if (Date.now() > deadline) throw new Error(`timed out; have frames ${this.frames.map(f => `${f.type}@${f.streamId}`).join(" ")}`)
      await new Promise<void>(r => { this.wake = r; setTimeout(r, 50) })
    }
  }

  async hello(hot = false, window?: number) {
    await this.connected
    const f = await this.take(f => f.type === proto.Frame.HELLO)
    this.send(proto.encodeJsonFrame(proto.Frame.HELLO_ACK, 0, { hot, ...(window ? { window } : {}) }))
    return proto.decodeJson<{ token: string; instance: string; version: number }>(f.payload)
  }

  send(b: Uint8Array) { this.sock!.write(b) }

  request(sid: number, path: string, opts: { method?: string; headers?: [string, string][]; body?: string[] } = {}) {
    const method = opts.method ?? "GET"
    this.send(proto.encodeJsonFrame(proto.Frame.REQ_HEAD, sid, {
      method, url: `http://hello.localhost${path}`, headers: opts.headers ?? [["host", "hello.localhost"]], clientIp: "10.0.0.9", requestId: `req-${sid}`,
    }))
    for (const chunk of opts.body ?? []) this.send(proto.encodeFrame(proto.Frame.REQ_BODY, sid, new TextEncoder().encode(chunk)))
    this.send(proto.encodeFrame(proto.Frame.REQ_END, sid))
  }

  // Collects RES_HEAD, the body and RES_END (or ERR) for one stream.
  async response(sid: number) {
    const on = (t: number) => (f: F) => f.streamId === sid && (f.type === t || f.type === proto.Frame.ERR)
    const head = await this.take(on(proto.Frame.RES_HEAD))
    if (head.type === proto.Frame.ERR) return { err: proto.decodeJson<{ message: string; stack?: string }>(head.payload) }
    const { status, headers } = proto.decodeJson<{ status: number; headers: [string, string][] }>(head.payload)
    const chunks: Uint8Array[] = []
    while (true) {
      const f = await this.take(f => f.streamId === sid && [proto.Frame.RES_BODY, proto.Frame.RES_END, proto.Frame.ERR].includes(f.type as never))
      if (f.type !== proto.Frame.RES_BODY) break
      chunks.push(f.payload)
    }
    return { status, headers, chunks, text: Buffer.concat(chunks).toString() }
  }

  stop() { this.server.stop(true) }
}

const spawnHost = (dir: string, entry: string, env: Record<string, string> = {}, extra: string[] = []) => {
  const child = Bun.spawn(["bun", HOST, entry, ...extra], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CANDY_FN_STATE: join(dir, "state"), CANDY_FN_LINGER_MS: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  return child
}

const exitOf = (child: Bun.Subprocess, ms = 5000) =>
  Promise.race([child.exited, Bun.sleep(ms).then(() => "timeout" as const)])

describe.skipIf(!haveSiblings)("fn-host end to end", () => {
  const helloEnv = async (dir: string) => ({
    CANDY_FN_TOKEN: "tok-123",
    CANDY_FN_INSTANCE: "i-1",
    CANDY_FN_CONFIG: JSON.stringify(await (await import("../fn-config.ts")).loadFnProjectConfig(FIXTURE)),
  })

  it("serves requests over the socket, then says BYE and exits when idle", async () => {
    const dir = mkdtempSync(join(BASE, "e2e-"))
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, join(FIXTURE, "index.ts"), {
      ...(await helloEnv(dir)), CANDY_FN_SOCKET: d.path, CANDY_FN_SECRET_KEYS: "SECRET", SECRET: "s3",
    })
    const hello = await d.hello()
    expect(hello).toEqual({ token: "tok-123", instance: "i-1", version: proto.PROTOCOL_VERSION, window: proto.INITIAL_WINDOW })

    d.request(1, "/")
    d.request(3, "/echo", { method: "POST", headers: [["content-type", "text/plain"]], body: ["chunk one, ", "chunk two"] })
    d.request(5, "/json?x=1")
    d.request(7, "/secret")
    d.request(9, "/cookies")
    d.request(11, "/stream")
    d.request(13, "/log")
    d.request(15, "/throw")
    d.request(17, "/big")

    expect(await d.response(1)).toMatchObject({ status: 200, text: "hello from candy\n" })
    expect(await d.response(3)).toMatchObject({ status: 200, text: "chunk one, chunk two" })
    expect(JSON.parse((await d.response(5)).text!)).toMatchObject({ query: { x: "1" }, ip: "10.0.0.9" })
    expect((await d.response(7)).text).toBe("set")
    expect((await d.response(9)).headers!.filter(([k]) => k === "set-cookie")).toEqual([["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"]])
    expect((await d.response(11)).text).toBe("data: tick 0\n\ndata: tick 1\n\ndata: tick 2\n\n")

    expect((await d.response(13)).text).toBe("logged")
    const log1 = proto.decodeJson<{ level: string; text: string }>((await d.take(f => f.type === proto.Frame.LOG && f.streamId === 13)).payload)
    const log2 = proto.decodeJson<{ level: string; text: string }>((await d.take(f => f.type === proto.Frame.LOG && f.streamId === 13)).payload)
    expect([log1, log2]).toMatchObject([{ level: "log", text: "hello from /log" }, { level: "warn", text: "careful" }])

    expect((await d.response(15)).err).toMatchObject({ message: "boom" })

    const big = await d.response(17)
    expect(big.chunks!.reduce((n, c) => n + c.length, 0)).toBe(3 * 1024 * 1024)
    expect(big.chunks!.every(c => c.length <= 64 * 1024)).toBe(true)

    const bye = await d.take(f => f.type === proto.Frame.BYE)
    expect(proto.decodeJson(bye.payload)).toEqual({ reason: "idle" })
    // A request that raced the BYE is still served before BYE_ACK.
    d.request(19, "/")
    expect((await d.response(19)).text).toBe("hello from candy\n")
    d.send(proto.encodeJsonFrame(proto.Frame.BYE_ACK, 0, {}))
    expect(await exitOf(child)).toBe(0)
    d.stop()
  }, 20000)

  it("waits for waitUntil and honours CANCEL before going idle", async () => {
    const dir = mkdtempSync(join(BASE, "e2e-"))
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, join(FIXTURE, "index.ts"), { ...(await helloEnv(dir)), CANDY_FN_SOCKET: d.path })
    await d.hello()

    d.request(1, "/hang")
    await Bun.sleep(100)
    d.send(proto.encodeFrame(proto.Frame.CANCEL, 1))
    d.request(3, "/wait")
    expect((await d.response(3)).text).toBe("waiting")
    // The waitUntil log arrives before BYE: the instance isn't idle until it settles.
    await d.take(f => f.type === proto.Frame.LOG && f.streamId === 3)
    expect(d.frames.some(f => f.type === proto.Frame.BYE)).toBe(false)
    await d.take(f => f.type === proto.Frame.BYE)
    // Nothing was sent back for the cancelled stream.
    expect(d.frames.filter(f => f.streamId === 1)).toEqual([])
    d.send(proto.encodeJsonFrame(proto.Frame.BYE_ACK, 0, {}))
    expect(await exitOf(child)).toBe(0)
    d.stop()
  }, 20000)

  it("stays up when hot and exits on DRAIN", async () => {
    const dir = mkdtempSync(join(BASE, "e2e-"))
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, join(FIXTURE, "index.ts"), { ...(await helloEnv(dir)), CANDY_FN_SOCKET: d.path })
    await d.hello(true)
    d.request(1, "/")
    expect((await d.response(1)).status).toBe(200)
    await Bun.sleep(1300)
    expect(d.frames.some(f => f.type === proto.Frame.BYE)).toBe(false)
    expect(await exitOf(child, 10)).toBe("timeout")
    d.send(proto.encodeJsonFrame(proto.Frame.DRAIN, 0, {}))
    expect(await exitOf(child)).toBe(0)
    d.stop()
  }, 20000)

  it("exits when the daemon goes away, and drains on SIGTERM", async () => {
    const dir = mkdtempSync(join(BASE, "e2e-"))
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, join(FIXTURE, "index.ts"), { ...(await helloEnv(dir)), CANDY_FN_SOCKET: d.path })
    await d.hello(true)
    d.stop()
    expect(await exitOf(child)).not.toBe("timeout")

    const dir2 = mkdtempSync(join(BASE, "e2e-"))
    const d2 = new FakeDaemon(dir2)
    const child2 = spawnHost(dir2, join(FIXTURE, "index.ts"), { ...(await helloEnv(dir2)), CANDY_FN_SOCKET: d2.path })
    await d2.hello(true)
    d2.request(1, "/wait")
    await d2.response(1)
    child2.kill("SIGTERM")
    expect(proto.decodeJson(( await d2.take(f => f.type === proto.Frame.BYE)).payload)).toEqual({ reason: "sigterm" })
    expect(await exitOf(child2)).toBe(0)
    // waitUntil work finished before the exit.
    expect(await new Response(child2.stdout).text()).toContain("waitUntil done")
    d2.stop()
  }, 20000)

  it("answers every request with ERR when the module fails to load", async () => {
    const dir = mkdtempSync(join(BASE, "e2e-"))
    writeFileSync(join(dir, "bad.ts"), "export default { nothing: true }\n")
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, "bad.ts", { CANDY_FN_SOCKET: d.path, CANDY_FN_TOKEN: "t" })
    await d.hello()
    d.request(1, "/")
    expect((await d.response(1)).err!.message).toContain("export default { fetch }")
    await d.take(f => f.type === proto.Frame.BYE)
    d.send(proto.encodeJsonFrame(proto.Frame.BYE_ACK, 0, {}))
    expect(await exitOf(child)).toBe(0)
    d.stop()
  }, 20000)

  it("runs scheduled() with KV/D1 bindings and no socket", async () => {
    const { loadFnProjectConfig } = await import("../fn-config.ts")
    const fnDir = join(FIXTURE, "bindings")
    const cfg = await loadFnProjectConfig(fnDir)
    const dir = mkdtempSync(join(BASE, "sched-"))
    const env = { CANDY_FN_CONFIG: JSON.stringify(cfg), CANDY_FN_STATE: join(dir, "state") }
    const ok = Bun.spawn(["bun", HOST, cfg.main, "--scheduled", "*/5 * * * *"], { cwd: fnDir, env: { PATH: process.env.PATH ?? "", ...env }, stderr: "pipe" })
    children.push(ok)
    expect(await exitOf(ok, 10000)).toBe(0)

    const { Database } = await import("bun:sqlite")
    const db = new Database(join(dir, "state", "d1-DB.sqlite"), { readonly: true })
    expect(db.query("SELECT cron FROM ticks").all()).toEqual([{ cron: "*/5 * * * *" }])
    db.close()

    const fail = Bun.spawn(["bun", HOST, cfg.main, "--scheduled", "fail"], { cwd: fnDir, env: { PATH: process.env.PATH ?? "", ...env }, stderr: "pipe" })
    children.push(fail)
    expect(await exitOf(fail, 10000)).toBe(1)
    expect(await new Response(fail.stderr).text()).toContain("scheduled failure")

    // A function with no scheduled() handler fails loudly.
    const none = Bun.spawn(["bun", HOST, join(FIXTURE, "index.ts"), "--scheduled", "@daily"], { cwd: dir, env: { PATH: process.env.PATH ?? "", ...env }, stderr: "pipe" })
    children.push(none)
    expect(await exitOf(none, 10000)).toBe(1)
    expect(await new Response(none.stderr).text()).toContain("no scheduled() handler")
  }, 30000)
})

// Flow control (HELLO_ACK.window), log caps and shutdown when the daemon goes away
describe.skipIf(!haveSiblings)("fn-host flow control and shutdown", () => {
  const FLOW_APP = `
const enc = new TextEncoder()
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    if (url.pathname === "/big") return new Response(new Uint8Array(1024 * 1024).fill(98))
    if (url.pathname === "/slow-read") {
      await Bun.sleep(300)
      return new Response(String((await req.arrayBuffer()).byteLength))
    }
    if (url.pathname === "/spam") {
      for (let i = 0; i < 2000; i++) console.log("spam " + i)
      return new Response("spammed")
    }
    if (url.pathname === "/late") {
      ctx.waitUntil(Bun.sleep(500).then(() => console.log("late done")))
      return new Response("ok")
    }
    return new Response("?", { status: 404 })
  },
}
`
  const setup = async (window?: number) => {
    const dir = mkdtempSync(join(BASE, "flow-"))
    writeFileSync(join(dir, "app.js"), FLOW_APP)
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, "app.js", { CANDY_FN_SOCKET: d.path, CANDY_FN_TOKEN: "t" })
    await d.hello(false, window)
    return { d, child }
  }

  it("sends a response body only as far as the daemon granted", async () => {
    const W = 100 * 1024
    const { d, child } = await setup(W)
    d.request(1, "/big")
    await d.take(f => f.type === proto.Frame.RES_HEAD && f.streamId === 1)
    const bodyBytes = async () => {
      await Bun.sleep(150)
      let n = 0
      for (let i = d.frames.findIndex(f => f.type === proto.Frame.RES_BODY && f.streamId === 1); i >= 0; i = d.frames.findIndex(f => f.type === proto.Frame.RES_BODY && f.streamId === 1)) {
        n += d.frames.splice(i, 1)[0].payload.length
      }
      return n
    }
    expect(await bodyBytes()).toBe(W)
    d.send(proto.encodeJsonFrame(proto.Frame.WINDOW, 1, { bytes: 50 * 1024 }))
    expect(await bodyBytes()).toBe(50 * 1024)
    d.send(proto.encodeJsonFrame(proto.Frame.WINDOW, 1, { bytes: 4 * 1024 * 1024 }))
    let rest = 0
    for (;;) {
      const f = await d.take(f => f.streamId === 1 && (f.type === proto.Frame.RES_BODY || f.type === proto.Frame.RES_END))
      if (f.type === proto.Frame.RES_END) break
      rest += f.payload.length
    }
    expect(rest).toBe(1024 * 1024 - W - 50 * 1024)
    child.kill()
    d.stop()
  }, 20000)

  it("grants request-body credit only as the handler reads", async () => {
    const { d, child } = await setup(1024 * 1024)
    const chunk = "x".repeat(32 * 1024)
    d.request(1, "/slow-read", { method: "POST", body: [chunk, chunk, chunk] })
    await Bun.sleep(150)
    // The handler hasn't read yet: no credit went back
    expect(d.frames.some(f => f.type === proto.Frame.WINDOW)).toBe(false)
    expect((await d.response(1)).text).toBe(String(3 * chunk.length))
    const granted = d.frames.filter(f => f.type === proto.Frame.WINDOW && f.streamId === 1)
      .reduce((n, f) => n + proto.decodeJson<{ bytes: number }>(f.payload).bytes, 0)
    expect(granted).toBe(3 * chunk.length)
    child.kill()
    d.stop()
  }, 20000)

  it("caps console lines per request", async () => {
    const { d, child } = await setup()
    d.request(1, "/spam")
    expect((await d.response(1)).text).toBe("spammed")
    await Bun.sleep(200)
    const logs = d.frames.filter(f => f.type === proto.Frame.LOG && f.streamId === 1)
    expect(logs.length).toBe(MAX_REQUEST_LOG_LINES + 1)
    expect(proto.decodeJson<{ text: string }>(logs.at(-1)!.payload).text).toContain("truncated")
    child.kill()
    d.stop()
  }, 20000)

  it("finishes waitUntil work when the daemon goes away", async () => {
    const { d, child } = await setup()
    d.request(1, "/late")
    expect((await d.response(1)).text).toBe("ok")
    d.stop()
    expect(await exitOf(child, 5000)).toBe(0)
    expect(await new Response(child.stdout).text()).toContain("late done")
  }, 20000)
})

// --- env.ASSETS binding ---

const ASSETS_BASE = "/tmp/claude-1000/candy-fn-build/assets-b"
mkdirSync(ASSETS_BASE, { recursive: true })

// A small SPA: dist/ with an index, a script and a nested page.
const makeSpa = () => {
  const dir = mkdtempSync(join(ASSETS_BASE, "spa-"))
  mkdirSync(join(dir, "dist", "docs"), { recursive: true })
  writeFileSync(join(dir, "dist", "index.html"), "<h1>spa</h1>\n")
  writeFileSync(join(dir, "dist", "app.js"), "console.log('app')\n")
  writeFileSync(join(dir, "dist", "docs", "index.html"), "<h1>docs</h1>\n")
  return dir
}
const assetsCfg = (dir: string, over: Partial<AssetsConfig> = {}): AssetsConfig => ({
  directory: join(dir, "dist"), binding: "ASSETS", notFound: "single-page-application", html: "auto-trailing-slash", runWorkerFirst: true, ...over,
})

describe("assets binding helpers", () => {
  const base = configFromEnv(undefined)

  it("takes the directory and mode from the daemon", () => {
    expect(assetsFromEnv(base, "/x", "dev")).toBeNull()
    const cfg = { ...base, assets: assetsCfg("/p") }
    expect(assetsFromEnv(cfg, undefined, undefined)).toMatchObject({ config: { directory: "/p/dist" }, mode: "dev" })
    // A deploy serves its snapshot, not the live directory
    expect(assetsFromEnv(cfg, "/state/deploys/d1/assets", "snapshot")).toMatchObject({ config: { directory: "/state/deploys/d1/assets", binding: "ASSETS" }, mode: "snapshot" })
    expect(() => assetsFromEnv(cfg, "/x", "prod")).toThrow("dev or snapshot")
  })

  it("refuses a binding name that is already taken", () => {
    const cfg = { ...base, assets: assetsCfg("/p") }
    expect(() => checkAssetsBinding(cfg, [])).not.toThrow()
    expect(() => checkAssetsBinding({ ...cfg, vars: { ASSETS: "1" } }, [])).toThrow("assets binding ASSETS has the same name as a var")
    expect(() => checkAssetsBinding(cfg, ["ASSETS"])).toThrow("a secret")
    expect(() => checkAssetsBinding({ ...cfg, kv: ["ASSETS"] }, [])).toThrow("a KV binding")
    expect(() => checkAssetsBinding({ ...cfg, d1: ["ASSETS"] }, [])).toThrow("a D1 binding")
    expect(() => checkAssetsBinding({ ...cfg, assets: { ...cfg.assets, binding: null } }, ["ASSETS"])).not.toThrow()
  })

  it("opens lazily, resolves relative URLs and ignores run_worker_first", async () => {
    const dir = makeSpa()
    const opens: { mode: string }[] = []
    const b = createAssetsBinding(assetsCfg(dir), "dev", (c, o) => { opens.push(o); return AssetServer.open(c, o) })
    expect(b.opened).toBe(false)
    expect(opens).toEqual([])
    const [a, js] = await Promise.all([b.binding.fetch("/"), b.binding.fetch("app.js")])
    // Two concurrent first calls share one open
    expect(opens).toEqual([{ mode: "dev" }])
    expect(await a.text()).toBe("<h1>spa</h1>\n")
    expect(await js.text()).toContain("app")
    // SPA fallback, even though run_worker_first is true
    expect(await (await b.binding.fetch(new URL("http://elsewhere/some/route"))).text()).toBe("<h1>spa</h1>\n")
    const docs = await b.binding.fetch(new Request("http://hello.localhost/docs/index.html"))
    expect(docs.status).toBe(307)
    expect(docs.headers.get("location")).toBe("/docs/")
    const head = await b.binding.fetch("/app.js", { method: "HEAD" })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(b.opened).toBe(true)
    b.close()
    expect(b.opened).toBe(false)
    await expect(b.binding.fetch("/")).rejects.toThrow("closed")
  })

  it("a missing directory answers 404 until it appears", async () => {
    const dir = mkdtempSync(join(ASSETS_BASE, "late-"))
    const opens: { mode: string }[] = []
    const b = createAssetsBinding(assetsCfg(dir), "snapshot", (c, o) => { opens.push(o); return AssetServer.open(c, o) })
    expect((await b.binding.fetch("/")).status).toBe(404)
    mkdirSync(join(dir, "dist"))
    writeFileSync(join(dir, "dist", "index.html"), "late\n")
    expect(await (await b.binding.fetch("/")).text()).toBe("late\n")
    expect(opens).toEqual([{ mode: "snapshot" }])
    b.close()
  })

  it("retries a failed open", async () => {
    let n = 0
    const b = createAssetsBinding(assetsCfg(makeSpa()), "dev", (c, o) => (n++ === 0 ? Promise.reject(new Error("boom")) : AssetServer.open(c, o)))
    await expect(b.binding.fetch("/")).rejects.toThrow("boom")
    expect((await b.binding.fetch("/")).status).toBe(200)
    b.close()
  })
})

describe.skipIf(!haveSiblings)("fn-host with env.ASSETS", () => {
  const APP = `
export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname === "/api/env") {
      return Response.json({
        keys: Object.keys(env).sort(),
        leaked: Object.keys(process.env).filter(k => k.startsWith("CANDY_FN_ASSETS")),
      })
    }
    if (url.pathname === "/api/rel") return env.ASSETS.fetch("app.js")
    // Everything else: the worker runs first and hands off to the assets
    return env.ASSETS.fetch(req)
  },
  async scheduled(event, env) {
    console.log("asset:" + (await (await env.ASSETS.fetch("/")).text()).trim())
  },
}
`
  const setup = (over: Partial<AssetsConfig> = {}, extraCfg: Record<string, unknown> = {}) => {
    const dir = makeSpa()
    writeFileSync(join(dir, "app.js"), APP)
    const cfg = { main: join(dir, "app.js"), vars: { A: "1" }, kv: [], d1: [], crons: [], warnings: [], source: null, assets: assetsCfg(dir, over), ...extraCfg }
    return { dir, cfg }
  }

  it("serves files through the binding and hides the asset env vars", async () => {
    const { dir, cfg } = setup()
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, "app.js", {
      CANDY_FN_SOCKET: d.path, CANDY_FN_TOKEN: "t", CANDY_FN_CONFIG: JSON.stringify(cfg),
      CANDY_FN_ASSETS_DIR: join(dir, "dist"), CANDY_FN_ASSETS_MODE: "dev",
    })
    await d.hello()
    d.request(1, "/")
    d.request(3, "/app.js")
    d.request(5, "/deep/link")
    d.request(7, "/api/rel")
    d.request(9, "/api/env")
    expect(await d.response(1)).toMatchObject({ status: 200, text: "<h1>spa</h1>\n" })
    const js = await d.response(3)
    expect(js.text).toContain("app")
    expect(js.headers!.find(([k]) => k === "content-type")?.[1]).toContain("javascript")
    expect((await d.response(5)).text).toBe("<h1>spa</h1>\n")
    expect((await d.response(7)).text).toContain("app")
    expect(JSON.parse((await d.response(9)).text!)).toEqual({ keys: ["A", "ASSETS"], leaked: [] })
    await d.take(f => f.type === proto.Frame.BYE)
    d.send(proto.encodeJsonFrame(proto.Frame.BYE_ACK, 0, {}))
    expect(await exitOf(child)).toBe(0)
    d.stop()
  }, 20000)

  it("serves a deploy's snapshot directory instead of assets.directory", async () => {
    const { dir, cfg } = setup()
    const snap = join(dir, "deploys", "d1", "assets")
    mkdirSync(snap, { recursive: true })
    writeFileSync(join(snap, "index.html"), "<h1>snapshot</h1>\n")
    const d = new FakeDaemon(dir)
    const child = spawnHost(dir, "app.js", {
      CANDY_FN_SOCKET: d.path, CANDY_FN_TOKEN: "t", CANDY_FN_CONFIG: JSON.stringify(cfg),
      CANDY_FN_ASSETS_DIR: snap, CANDY_FN_ASSETS_MODE: "snapshot",
    })
    await d.hello()
    d.request(1, "/")
    expect((await d.response(1)).text).toBe("<h1>snapshot</h1>\n")
    child.kill()
    d.stop()
  }, 20000)

  it("has the binding in --scheduled runs", async () => {
    const { dir, cfg } = setup()
    const child = spawnHost(dir, "app.js", { CANDY_FN_CONFIG: JSON.stringify(cfg), CANDY_FN_ASSETS_DIR: join(dir, "dist"), CANDY_FN_ASSETS_MODE: "dev" }, ["--scheduled", "@daily"])
    expect(await exitOf(child, 10000)).toBe(0)
    expect(await new Response(child.stdout).text()).toContain("asset:<h1>spa</h1>")
  }, 20000)

  it("fails startup on a name clash or a null main", async () => {
    const { dir, cfg } = setup({}, { kv: ["ASSETS"] })
    const clash = spawnHost(dir, "app.js", { CANDY_FN_CONFIG: JSON.stringify(cfg) }, ["--scheduled", "@daily"])
    expect(await exitOf(clash, 10000)).toBe(2)
    expect(await new Response(clash.stderr).text()).toContain("assets binding ASSETS has the same name as a KV binding")

    const secret = spawnHost(dir, "app.js", { CANDY_FN_CONFIG: JSON.stringify({ ...cfg, kv: [] }), CANDY_FN_SECRET_KEYS: "ASSETS", ASSETS: "x" }, ["--scheduled", "@daily"])
    expect(await exitOf(secret, 10000)).toBe(2)
    expect(await new Response(secret.stderr).text()).toContain("a secret")

    const noMain = spawnHost(dir, "app.js", { CANDY_FN_CONFIG: JSON.stringify({ ...cfg, kv: [], main: null }) }, ["--scheduled", "@daily"])
    expect(await exitOf(noMain, 10000)).toBe(2)
    expect(await new Response(noMain.stderr).text()).toContain("no main")
  }, 30000)
})
