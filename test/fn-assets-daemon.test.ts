// The daemon's routing decision for functions with static assets
// (routeFunctionRequest in fn-daemon.ts), without starting a daemon or binding a port.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AssetServer } from "../fn-assets.ts"
import { loadFnProjectConfig } from "../fn-config.ts"
import {
  fnAssetsPlan, fnAssetsSummary, fnLaunchEnv, fnShimProject, fnSummaryOf, FnRoutingCache, logAssetResponse, normalizeFnSettings, routeFunctionRequest,
} from "../fn-daemon.ts"
import { bundleDeploy, pruneDeploys, type DeployInfo } from "../fn-deploy.ts"
import { checkToolResult, runFnTool } from "../fn-tool.ts"
import { assetsFromEnv, configFromEnv } from "../fn-host.ts"
import { FnLog } from "../fn-log.ts"
import { FnRuntime } from "../fn-runtime.ts"

const ROOT = "/tmp/claude-1000/candy-fn-build/assets-c/test"
const FIXTURES = join(import.meta.dir, "fixtures")
let spaDir = ""
let spa: AssetServer
let stat: AssetServer

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  // A copy of fn-spa plus an /api file, to show worker-first beats a matching asset
  spaDir = join(ROOT, "fn-spa")
  cpSync(join(FIXTURES, "fn-spa"), spaDir, { recursive: true })
  writeFileSync(join(spaDir, "dist/api/me"), "a file that must never be served\n")
  const spaCfg = await loadFnProjectConfig(spaDir)
  const staticCfg = await loadFnProjectConfig(join(FIXTURES, "fn-static"))
  spa = await AssetServer.open(spaCfg.assets!, { mode: "dev" })
  stat = await AssetServer.open(staticCfg.assets!, { mode: "dev" })
})
afterAll(() => {
  spa?.close()
  stat?.close()
  rmSync(ROOT, { recursive: true, force: true })
})

const nav = (path: string, init: RequestInit = {}) =>
  new Request(`https://spa.localhost${path}`, { ...init, headers: { "sec-fetch-mode": "navigate", accept: "text/html", ...(init.headers as Record<string, string> ?? {}) } })

// A worker stand-in that records what reached it
const recorder = () => {
  const seen: { url: string; rule: string | null }[] = []
  return {
    seen,
    worker: async (req: Request, rule: string | null) => {
      seen.push({ url: req.url, rule })
      return Response.json({ worker: true, path: new URL(req.url).pathname })
    },
  }
}

describe("SPA with run_worker_first [/api/*, !/api/docs/*]", () => {
  it("sends an /api navigation to the worker, not index.html", async () => {
    const w = recorder()
    const r = await routeFunctionRequest(nav("/api/users"), { assets: spa, hasWorker: true, worker: w.worker })
    expect(r.kind).toBe("worker")
    expect(r.rule).toBe("worker-first:/api/*")
    expect(w.seen).toEqual([{ url: "https://spa.localhost/api/users", rule: "worker-first:/api/*" }])
    expect(await r.response.json()).toEqual({ worker: true, path: "/api/users" })
  })

  it("sends an /api path that is also a file to the worker", async () => {
    const w = recorder()
    const r = await routeFunctionRequest(new Request("https://spa.localhost/api/me"), { assets: spa, hasWorker: true, worker: w.worker })
    expect(r.kind).toBe("worker")
    expect(w.seen.length).toBe(1)
    expect(await r.response.text()).not.toContain("must never be served")
  })

  it("answers a non-api navigation with index.html and launches no instance", async () => {
    let launches = 0
    const rt = new FnRuntime({
      name: "spa", socketPath: join(ROOT, "spa.sock"), hot: 0, max: 1,
      launch: async () => { launches++; throw new Error("must not launch") },
    })
    const r = await routeFunctionRequest(nav("/dashboard/settings"), {
      assets: spa, hasWorker: true, worker: req => rt.handle(req, { clientIp: "127.0.0.1", host: "spa.localhost" }),
    })
    expect(r.kind).toBe("asset")
    expect(r.rule).toBe("spa-navigate")
    expect(r.response.status).toBe(200)
    expect(await r.response.text()).toContain("<")
    expect(launches).toBe(0)
    expect(rt.instances()).toEqual([])
    await rt.close()
  })

  it("serves !/api/docs/* as an asset", async () => {
    const w = recorder()
    const r = await routeFunctionRequest(nav("/api/docs/"), { assets: spa, hasWorker: true, worker: w.worker })
    expect(r.kind).toBe("asset")
    expect(r.response.status).toBe(200)
    expect(r.response.headers.get("content-type")).toContain("text/html")
    expect(w.seen).toEqual([])
  })

  it("lets HEAD, Range and If-None-Match reach the asset router", async () => {
    const w = recorder()
    const first = await routeFunctionRequest(new Request("https://spa.localhost/assets/app.js"), { assets: spa, hasWorker: true, worker: w.worker })
    const etag = first.response.headers.get("etag")!
    expect(etag).toBeTruthy()
    const head = await routeFunctionRequest(new Request("https://spa.localhost/assets/app.js", { method: "HEAD" }), { assets: spa, hasWorker: true, worker: w.worker })
    expect(head.response.status).toBe(200)
    expect(await head.response.text()).toBe("")
    const cond = await routeFunctionRequest(new Request("https://spa.localhost/assets/app.js", { headers: { "if-none-match": etag } }), { assets: spa, hasWorker: true, worker: w.worker })
    expect(cond.response.status).toBe(304)
    const range = await routeFunctionRequest(new Request("https://spa.localhost/assets/app.js", { headers: { range: "bytes=0-3" } }), { assets: spa, hasWorker: true, worker: w.worker })
    expect(range.response.status).toBe(206)
    expect((await range.response.arrayBuffer()).byteLength).toBe(4)
    expect(w.seen).toEqual([])
  })

  it("records the _redirects rule on a redirect", async () => {
    const r = await routeFunctionRequest(new Request("https://spa.localhost/old"), { assets: spa, hasWorker: true, worker: recorder().worker })
    expect(r.kind).toBe("redirect")
    expect(r.response.status).toBe(301)
    expect(r.rule).toBe("/old / 301")
  })

  it("sends a POST past the assets to the worker", async () => {
    const w = recorder()
    const r = await routeFunctionRequest(new Request("https://spa.localhost/form", { method: "POST", body: "x" }), { assets: spa, hasWorker: true, worker: w.worker })
    expect(r.kind).toBe("worker")
    expect(w.seen.length).toBe(1)
  })
})

describe("assets-only function (no main)", () => {
  it("serves the nearest 404.html with status 404 and never spawns", async () => {
    let launches = 0
    const rt = new FnRuntime({
      name: "static", socketPath: join(ROOT, "static.sock"), hot: 0, max: 1,
      launch: async () => { launches++; throw new Error("must not launch") },
    })
    const worker = (req: Request) => rt.handle(req, { clientIp: "127.0.0.1", host: "static.localhost" })
    const miss = await routeFunctionRequest(new Request("https://static.localhost/nope"), { assets: stat, hasWorker: false, worker })
    expect(miss.kind).toBe("notfound")
    expect(miss.response.status).toBe(404)
    expect(miss.rule).toBe("404-page")
    expect(await miss.response.text()).toContain("<")
    const hit = await routeFunctionRequest(new Request("https://static.localhost/about"), { assets: stat, hasWorker: false, worker })
    expect(hit.kind).toBe("asset")
    expect(hit.response.status).toBe(200)
    const post = await routeFunctionRequest(new Request("https://static.localhost/about", { method: "POST", body: "x" }), { assets: stat, hasWorker: false, worker })
    expect(post.response.status).toBe(405)
    expect(launches).toBe(0)
    await rt.close()
  })

  it("answers 404 without an asset server and without calling the worker", async () => {
    const w = recorder()
    const r = await routeFunctionRequest(new Request("https://x.localhost/"), { assets: null, hasWorker: false, worker: w.worker })
    expect(r.response.status).toBe(404)
    expect(w.seen).toEqual([])
  })
})

describe("without assets", () => {
  it("goes straight to the worker with the request untouched", async () => {
    const w = recorder()
    const req = new Request("https://plain.localhost/a?b=1")
    const r = await routeFunctionRequest(req, { assets: null, hasWorker: true, worker: w.worker })
    expect(r.kind).toBe("worker")
    expect(w.seen).toEqual([{ url: "https://plain.localhost/a?b=1", rule: null }])
  })
})

describe("launch env and summaries", () => {
  it("keeps an assets-only fn (entry null) in servers.json, but not a missing entry", () => {
    expect(normalizeFnSettings({ entry: null, max: 2 })).toEqual({ entry: null, max: 2 })
    expect(normalizeFnSettings({ max: 2 })).toBe(null)
  })

  it("carries the assets dir and mode to the shim", () => {
    const dev = fnLaunchEnv({ stateDir: "/s", project: {}, secretKeys: [], assets: { dir: "/home/u/app/dist", mode: "dev" } })
    expect(dev.CANDY_FN_ASSETS_DIR).toBe("/home/u/app/dist")
    expect(dev.CANDY_FN_ASSETS_MODE).toBe("dev")
    const snap = fnLaunchEnv({ stateDir: "/s", project: {}, secretKeys: [], assets: { dir: "/s/deploys/20260101120000-0123abcd/assets", mode: "snapshot" } })
    expect(snap.CANDY_FN_ASSETS_MODE).toBe("snapshot")
    const none = fnLaunchEnv({ stateDir: "/s", project: {}, secretKeys: [] })
    expect(none.CANDY_FN_ASSETS_DIR).toBeUndefined()
    expect(none.CANDY_FN_ASSETS_MODE).toBeUndefined()
  })

  it("summarizes the assets config for the server list", () => {
    expect(fnAssetsSummary(null)).toBe(null)
    expect(fnAssetsSummary(spa.cfg)).toEqual({
      directory: join(spaDir, "dist"), binding: "ASSETS", notFound: "single-page-application",
      html: "auto-trailing-slash", runWorkerFirst: ["/api/*", "!/api/docs/*"],
    })
  })
})

describe("request log", () => {
  it("logs asset hits as kind asset with the rule and no body", async () => {
    const log = new FnLog(join(ROOT, "log", "spa.sqlite"))
    const req = nav("/dashboard")
    const r = await routeFunctionRequest(req, { assets: spa, hasWorker: true, worker: recorder().worker })
    logAssetResponse(log, { requestId: "a1", fn: "spa", host: "spa.localhost", req, clientIp: "127.0.0.1", rule: r.rule, startedAt: performance.now() }, r.response)
    const d = log.get("a1")!
    expect(d.kind).toBe("asset")
    expect(d.rule).toBe("spa-navigate")
    expect(d.status).toBe(200)
    expect(d.resBody.kind).toBe("omitted")
    expect(d.resBytes).toBeGreaterThan(0)
    expect(log.query()[0]).toMatchObject({ id: "a1", kind: "asset", rule: "spa-navigate" })
    log.close()
  })
})

// A pinned deploy routes with the config recorded in it, not the live project config, so a
// rollback also rolls back run_worker_first (and the shim's env.ASSETS matches).
describe("pinned deploys use their recorded assets config", () => {
  const FIX = "/tmp/claude-1000/candy-fn-build/assets-fix/rollback"
  let src = ""
  let state = ""
  const opened: AssetServer[] = []
  beforeAll(() => {
    rmSync(FIX, { recursive: true, force: true })
    mkdirSync(FIX, { recursive: true })
    src = join(FIX, "src")
    state = join(FIX, "state")
    cpSync(join(FIXTURES, "fn-spa"), src, { recursive: true })
    // An /api file: worker-first decides whether it's ever served
    writeFileSync(join(src, "dist/api/me"), "the api file\n")
  })
  afterAll(async () => {
    opened.forEach(s => s.close())
    await pruneDeploys(state, 0).catch(() => {})
    rmSync(FIX, { recursive: true, force: true })
  })

  // What the daemon does: resolve as the user, check the result, plan, open, route
  const pin = async (id: string, live: Awaited<ReturnType<typeof loadFnProjectConfig>>) => {
    const info = checkToolResult("resolve", await runFnTool("resolve", { stateDir: state, id }), { stateDir: state }) as DeployInfo
    const plan = fnAssetsPlan(live, info)
    const server = await AssetServer.open(plan.config!, { mode: plan.mode })
    opened.push(server)
    const route = async (path: string) => {
      const w = recorder()
      const r = await routeFunctionRequest(new Request(`https://spa.localhost${path}`), { assets: server, hasWorker: plan.hasWorker, worker: w.worker })
      return r.kind === "worker" ? "worker" : (await r.response.text()).trim()
    }
    return { info, plan, route }
  }

  it("rollback switches run_worker_first back, whatever the live config says", async () => {
    const cfg = await loadFnProjectConfig(src)
    const deploy = (runWorkerFirst: boolean | string[]) =>
      bundleDeploy({ name: "spa", srcDir: src, main: cfg.main, stateDir: state, gitRev: null, assets: { ...cfg.assets!, runWorkerFirst } })
    const a = await deploy(["/api/*"])
    const b = await deploy(false)
    // The live project now says worker-first for everything
    const live = { ...cfg, assets: { ...cfg.assets!, runWorkerFirst: true } }

    const atB = await pin(b.id, live)
    expect(atB.plan.source).toBe("deploy")
    expect(atB.plan.config!.runWorkerFirst).toBe(false)
    expect(await atB.route("/api/me")).toBe("the api file")

    // Roll back to a
    const atA = await pin(a.id, live)
    expect(atA.plan.config!.runWorkerFirst).toEqual(["/api/*"])
    expect(atA.plan.config!.directory).toBe(join(a.dir, "assets"))
    expect(await atA.route("/api/me")).toBe("worker")
    expect(await atA.route("/")).toContain("<")

    // The shim gets the same assets block, so env.ASSETS behaves like the deploy
    const env = fnLaunchEnv({ stateDir: state, project: fnShimProject(live, atA.plan), secretKeys: [], assets: { dir: atA.plan.config!.directory, mode: "snapshot" } })
    const shim = assetsFromEnv(configFromEnv(env.CANDY_FN_CONFIG), env.CANDY_FN_ASSETS_DIR, env.CANDY_FN_ASSETS_MODE)!
    expect(shim.config).toEqual(atA.plan.config!)
    expect(shim.mode).toBe("snapshot")
    // Dev still uses the live config
    const dev = fnAssetsPlan(live, null)
    expect(dev).toMatchObject({ source: "live", mode: "dev" })
    expect(fnShimProject(live, dev)).toBe(live)
  })

  it("falls back to the live config only for a deploy that didn't record its routing", () => {
    const live = { main: "src/index.ts", assets: { directory: "/home/u/f/dist", binding: "ASSETS", notFound: "404-page" as const, html: "none" as const, runWorkerFirst: true } }
    const dir = `${state}/deploys/20260101120000-0123abcd`
    const old: DeployInfo = { id: "20260101120000-0123abcd", createdAt: 1, entry: `${dir}/worker.js`, dir, source: src, gitRev: null, size: 1, main: "src/index.ts", assets: `${dir}/assets` }
    expect(fnAssetsPlan(live, old)).toEqual({
      hasWorker: true, mode: "snapshot", source: "live-fallback",
      config: { directory: `${dir}/assets`, binding: "ASSETS", notFound: "404-page", html: "none", runWorkerFirst: true },
    })
    expect(fnAssetsPlan({ main: null, assets: null }, old)).toMatchObject({ source: "default", config: { runWorkerFirst: false, notFound: "none" } })
    // A deploy without assets gives the shim no assets block, even if the live project has one
    const plan = fnAssetsPlan(live, { ...old, assets: null })
    expect(plan.config).toBe(null)
    expect(fnShimProject(live, plan).assets).toBe(null)
  })
})

describe("dev before the first build", () => {
  it("a missing asset folder is empty: /api/* and misses still reach the worker", async () => {
    const dir = join(ROOT, "unbuilt")
    cpSync(join(FIXTURES, "fn-spa"), dir, { recursive: true })
    rmSync(join(dir, "dist"), { recursive: true, force: true })
    const cfg = await loadFnProjectConfig(dir)
    const server = await AssetServer.open(cfg.assets!, { mode: "dev" })
    try {
      const w = recorder()
      const api = await routeFunctionRequest(nav("/api/users"), { assets: server, hasWorker: true, worker: w.worker })
      expect([api.kind, api.rule]).toEqual(["worker", "worker-first:/api/*"])
      const page = await routeFunctionRequest(nav("/dashboard"), { assets: server, hasWorker: true, worker: w.worker })
      expect(page.kind).toBe("worker")
      // vite build: picked up on the next request, no reopen
      cpSync(join(FIXTURES, "fn-spa", "dist"), join(dir, "dist"), { recursive: true })
      const built = await routeFunctionRequest(nav("/dashboard"), { assets: server, hasWorker: true, worker: w.worker })
      expect([built.kind, built.rule]).toEqual(["asset", "spa-navigate"])
      expect(w.seen.map(x => new URL(x.url).pathname)).toEqual(["/api/users", "/dashboard"])
    } finally {
      server.close()
    }
  })
})

describe("routing details through the daemon's router", () => {
  it("a 200 rewrite onto a worker-first path reaches the worker with the rewritten URL", async () => {
    const dir = join(ROOT, "rewrite")
    cpSync(join(FIXTURES, "fn-spa"), dir, { recursive: true })
    writeFileSync(join(dir, "dist/api/data.json"), "{}")
    writeFileSync(join(dir, "dist/_redirects"), "/app/* /api/:splat 200\n")
    const server = await AssetServer.open((await loadFnProjectConfig(dir)).assets!, { mode: "dev" })
    try {
      const w = recorder()
      for (const p of ["/app/data.json", "/app/me"]) {
        const r = await routeFunctionRequest(nav(p), { assets: server, hasWorker: true, worker: w.worker })
        expect([r.kind, r.rule]).toEqual(["worker", "worker-first:/api/*"])
      }
      expect(w.seen).toEqual([
        { url: "https://spa.localhost/api/data.json", rule: "worker-first:/api/*" },
        { url: "https://spa.localhost/api/me", rule: "worker-first:/api/*" },
      ])
    } finally {
      server.close()
    }
  })

  it("private: asset hits on a password-protected domain aren't publicly cacheable", async () => {
    const r = await routeFunctionRequest(nav("/"), { assets: spa, hasWorker: true, private: true, worker: recorder().worker })
    expect(r.kind).toBe("asset")
    expect(r.response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate")
    const pub = await routeFunctionRequest(nav("/"), { assets: spa, hasWorker: true, worker: recorder().worker })
    expect(pub.response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate")
  })
})

describe("routing cache", () => {
  const routing = () => ({ closed: 0, close() { this.closed++ } })

  it("a function removed while its project config loads gets no stored routing", async () => {
    const cache = new FnRoutingCache<ReturnType<typeof routing>>(r => r.close())
    let current = true
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const opened: ReturnType<typeof routing>[] = []
    const pending = cache.get("f", async () => {
      await gate // fnProject's await
      return { key: "k", open: async () => { const r = routing(); opened.push(r); return r } }
    }, () => current)
    current = false // removed meanwhile
    cache.reset("f")
    release()
    const r = await pending
    await Bun.sleep(0)
    expect(opened).toEqual([r])
    expect(r.closed).toBe(1) // its watcher doesn't leak
    expect(cache.current("f")).toBeUndefined()
  })

  it("reuses a routing per key, closes the old one on a new key, retries a failure", async () => {
    const cache = new FnRoutingCache<ReturnType<typeof routing>>(r => r.close())
    let opens = 0
    const get = (key: string, fail = false) => cache.get("f", async () => ({ key, open: async () => { opens++; if (fail) throw new Error("x"); return routing() } }), () => true)
    const a = await get("1")
    expect(await get("1")).toBe(a)
    expect(cache.current("f")).toBe(a)
    const b = await get("2")
    await Bun.sleep(0)
    expect([a.closed, b.closed]).toEqual([1, 0])
    await expect(get("3", true)).rejects.toThrow("x")
    await Bun.sleep(0)
    expect(cache.current("f")).toBeUndefined()
    await get("3")
    expect(opens).toBe(4)
  })
})

describe("fnSummaryOf", () => {
  const live = { main: null, assets: { directory: "/home/u/f/dist", binding: null, notFound: "none" as const, html: "none" as const, runWorkerFirst: false } }
  const pinned = { directory: "/s/deploys/d1/assets", binding: "ASSETS", notFound: "single-page-application" as const, html: "auto-trailing-slash" as const, runWorkerFirst: ["/api/*"] }

  it("shows the pinned deploy's routing, not the live config", () => {
    const s = fnSummaryOf({ entry: null, deploy: "d1" }, { hasWorker: true, deploy: "d1", assetsConfig: pinned }, live)
    expect(s).toMatchObject({ entry: null, deploy: "d1", hasWorker: true, source: "deploy:d1", assets: { directory: pinned.directory, runWorkerFirst: ["/api/*"] } })
  })

  it("hasWorker follows the routing, not a stale entry", () => {
    // entry null from when it was assets-only; the user has since added main
    const s = fnSummaryOf({ entry: null }, { hasWorker: true, deploy: null, assetsConfig: live.assets }, { ...live, main: "src/index.ts" })
    expect([s.hasWorker, s.source, s.entry]).toEqual([true, "live", null])
    expect(fnSummaryOf({ entry: "a.ts" }, { hasWorker: false, deploy: null, assetsConfig: null }, null).hasWorker).toBe(false)
  })

  it("falls back to the live project config when the routing couldn't open", () => {
    const s = fnSummaryOf({ entry: null }, null, { ...live, main: "src/index.ts" })
    expect([s.hasWorker, s.source, s.assets?.directory]).toEqual([true, null, "/home/u/f/dist"])
  })
})
