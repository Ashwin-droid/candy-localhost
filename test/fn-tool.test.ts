import { afterAll, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { checkDeployInfo, checkProjectConfig, checkToolResult, runFnTool } from "../fn-tool.ts"

const ROOT = join(import.meta.dir, "..")
const HELLO = join(import.meta.dir, "fixtures", "fn-hello")
const BASE = "/tmp/claude-1000/candy-fn-build/assets-a/tool"
mkdirSync(BASE, { recursive: true })
const tmp = mkdtempSync(join(BASE, "t-"))
// Deploy snapshots are read-only on purpose; make them writable to clean up
afterAll(async () => {
  await Bun.spawn(["chmod", "-R", "u+w", tmp]).exited
  rmSync(tmp, { recursive: true, force: true })
})

// The daemon runs this as the function's user in root mode: JSON in on stdin, JSON out
const runCli = async (op: string, args: unknown) => {
  const proc = Bun.spawn(["bun", join(ROOT, "fn-tool.ts"), op], { stdin: new Blob([JSON.stringify(args)]), stdout: "pipe", stderr: "pipe" })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, ...JSON.parse(out.trim().split("\n").pop()!) }
}

describe("fn-tool", () => {
  it("reads the project config and checks an explicit entry", async () => {
    const cfg = await runFnTool("config", { dir: HELLO }) as any
    expect(cfg).toMatchObject({ main: "index.ts", vars: { GREETING: "hello from candy" } })
    expect((await runFnTool("config", { dir: join(HELLO, "bindings"), entry: "src/index.ts" }) as any).main).toBe("src/index.ts")
    await expect(runFnTool("config", { dir: HELLO, entry: "../../../etc/passwd" })).rejects.toThrow("outside")
  })

  it("does KV get/put/list/delete and D1 queries in the state folder", async () => {
    const stateDir = join(tmp, "state")
    expect(await runFnTool("kv", { stateDir, binding: "KV", op: "get", key: "a" })).toEqual({ value: null })
    await runFnTool("kv", { stateDir, binding: "KV", op: "put", key: "a", value: "1" })
    await runFnTool("kv", { stateDir, binding: "KV", op: "put", key: "ab", value: "2" })
    expect(await runFnTool("kv", { stateDir, binding: "KV", op: "get", key: "a" })).toEqual({ value: "1" })
    expect(((await runFnTool("kv", { stateDir, binding: "KV", op: "list", prefix: "a", limit: 1 })) as any).keys).toEqual([{ name: "a" }])
    await runFnTool("kv", { stateDir, binding: "KV", op: "delete", key: "a" })
    expect(await runFnTool("kv", { stateDir, binding: "KV", op: "get", key: "a" })).toEqual({ value: null })
    await expect(runFnTool("kv", { stateDir, binding: "../x", op: "get", key: "a" })).rejects.toThrow("invalid binding")
    await expect(runFnTool("kv", { stateDir, binding: "KV", op: "drop" })).rejects.toThrow("op must be")

    await runFnTool("d1", { stateDir, binding: "DB", sql: "CREATE TABLE t (x INTEGER)" })
    await runFnTool("d1", { stateDir, binding: "DB", sql: "INSERT INTO t VALUES (?), (?)", params: [1, 2] })
    const res = await runFnTool("d1", { stateDir, binding: "DB", sql: "SELECT x FROM t ORDER BY x" }) as any
    expect(res.results).toEqual([{ x: 1 }, { x: 2 }])
    expect(res.success).toBe(true)
    await expect(runFnTool("d1", { stateDir, binding: "DB", sql: "SELECT nope FROM t" })).rejects.toThrow("D1_ERROR")
  })

  it("bundles, lists, resolves and prunes deploys", async () => {
    const src = join(tmp, "src")
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, "index.ts"), `export default { fetch: () => new Response("v1") }\n`)
    const stateDir = join(tmp, "fnstate")
    const d = await runFnTool("deploy", { name: "t", srcDir: src, main: "index.ts", stateDir }) as any
    expect(d.id).toMatch(/^\d{14}-[0-9a-f]{8}$/)
    expect(d.entry).toBe(join(stateDir, "deploys", d.id, "worker.js"))
    expect(((await runFnTool("deploys", { stateDir })) as any[]).map(x => x.id)).toEqual([d.id])
    expect(((await runFnTool("resolve", { stateDir, id: d.id })) as any).id).toBe(d.id)
    expect(await runFnTool("resolve", { stateDir, id: "../../etc" })).toBeNull()
    expect(await runFnTool("prune", { stateDir, keep: 1, pinned: d.id })).toEqual([])
  })

  it("runs as a CLI with JSON on stdin and a JSON answer", async () => {
    const ok = await runCli("config", { dir: HELLO })
    expect(ok).toMatchObject({ code: 0, ok: true, result: { main: "index.ts" } })
    const bad = await runCli("nope", {})
    expect(bad).toMatchObject({ code: 1, ok: false, error: 'unknown fn-tool op "nope"' })
  })
})

// In root mode fn-tool runs as the function's user, who controls that process
describe("checking fn-tool results", () => {
  const good = { id: "20260101120000-0123abcd", createdAt: 1, entry: "/var/lib/candy/f/deploys/20260101120000-0123abcd/worker.js", dir: "/var/lib/candy/f/deploys/20260101120000-0123abcd", source: "/home/u/f", gitRev: "abc1234", size: 10, main: "index.ts", assets: null }

  it("accepts real deploy info and drops anything extra", () => {
    expect(checkDeployInfo({ ...good, extra: "<img>" })).toEqual(good)
    expect(checkDeployInfo({ ...good, gitRev: null })).toEqual({ ...good, gitRev: null })
  })

  it("refuses ids, paths and strings that could inject markup or log lines", () => {
    expect(checkDeployInfo({ ...good, id: "x&#39;);fetch(1)//" })).toBe(null)
    expect(checkDeployInfo({ ...good, id: 'x" onmouseover="alert(1)' })).toBe(null)
    expect(checkDeployInfo({ ...good, main: "a\nFAKE AUDIT LINE" })).toBe(null)
    expect(checkDeployInfo({ ...good, entry: "relative/worker.js" })).toBe(null)
    expect(checkDeployInfo({ ...good, gitRev: "<b>" })).toBe(null)
    expect(checkDeployInfo({ ...good, createdAt: "soon" })).toBe(null)
  })

  it("filters deploy lists and rejects bad single results", () => {
    expect(checkToolResult("deploys", [good, { ...good, id: "evil" }, null])).toEqual([good])
    expect(() => checkToolResult("deploys", "nope")).toThrow("bad result")
    expect(() => checkToolResult("deploy", { ...good, id: "evil" })).toThrow("bad deploy info")
    expect(checkToolResult("resolve", null)).toBe(null)
    expect(() => checkToolResult("resolve", { id: 1 })).toThrow("bad deploy info")
    expect(checkToolResult("kv", { value: "anything" })).toEqual({ value: "anything" })
  })

  it("checks project configs", () => {
    const cfg = { main: "src/index.ts", vars: { A: "1" }, kv: ["KV"], d1: ["DB"], crons: ["*/5 * * * *"], warnings: ["odd\u001b[31m key"], source: "/srv/f/candy.fn.json", extra: 1 }
    expect(checkProjectConfig(cfg)).toEqual({ main: "src/index.ts", assets: null, vars: { A: "1" }, kv: ["KV"], d1: ["DB"], crons: ["*/5 * * * *"], warnings: ["odd [31m key"], source: "/srv/f/candy.fn.json" })
    expect(() => checkProjectConfig({ ...cfg, main: "a\nb" })).toThrow("bad main")
    expect(() => checkProjectConfig({ ...cfg, kv: ["bad name"] })).toThrow("bad kv")
    expect(() => checkProjectConfig({ ...cfg, vars: { A: 1 } })).toThrow("bad var")
  })

  it("is applied to what runFnTool returns", async () => {
    const cfg = checkToolResult("config", await runFnTool("config", { dir: HELLO })) as any
    expect(cfg.main).toBe("index.ts")
  })
})

const SPA = join(import.meta.dir, "fixtures", "fn-spa")
const STATIC = join(import.meta.dir, "fixtures", "fn-static")

describe("fn-tool with assets", () => {
  const dir = "/var/lib/candy/f/deploys/20260101120000-0123abcd"
  const deploy = { id: "20260101120000-0123abcd", createdAt: 1, entry: `${dir}/worker.js`, dir, source: "/home/u/f", gitRev: null, size: 10, main: "src/index.ts", assets: `${dir}/assets` }
  const assets = { directory: "/home/u/f/dist", binding: "ASSETS", notFound: "single-page-application", html: "auto-trailing-slash", runWorkerFirst: ["/api/*", "!/api/docs/*"] }
  const cfg = { main: "src/index.ts", assets, vars: {}, kv: [], d1: [], crons: [], warnings: [], source: "/home/u/f/wrangler.jsonc" }

  it("checks the recorded assets routing like the live config", () => {
    const assetsConfig = { binding: "ASSETS", notFound: "single-page-application", html: "none", runWorkerFirst: ["/api/*"] }
    expect(checkDeployInfo({ ...deploy, assetsConfig })).toEqual({ ...deploy, assetsConfig })
    expect(checkDeployInfo({ ...deploy, assetsConfig: { ...assetsConfig, extra: 1, directory: "/etc" } })).toEqual({ ...deploy, assetsConfig })
    // Older manifests: absent or null is fine (the daemon falls back to the live config)
    expect(checkDeployInfo({ ...deploy, assetsConfig: null })).toEqual(deploy)
    for (const bad of [
      { notFound: "spa" }, { html: "auto" }, { binding: "bad-name" }, { binding: undefined }, { runWorkerFirst: ["api/*"] },
      { runWorkerFirst: "yes" }, { runWorkerFirst: ["/a\n"] }, { runWorkerFirst: Array(101).fill("/x") },
    ]) {
      expect(checkDeployInfo({ ...deploy, assetsConfig: { ...assetsConfig, ...bad } })).toBe(null)
    }
    expect(checkDeployInfo({ ...deploy, assetsConfig: "none" })).toBe(null)
    // Routing without an assets dir makes no sense
    expect(checkDeployInfo({ ...deploy, assets: null, assetsConfig })).toBe(null)
    expect(() => checkToolResult("resolve", { ...deploy, assetsConfig: { ...assetsConfig, html: 1 } })).toThrow("bad deploy info")
  })

  it("checks deploy info paths against the snapshot dir", () => {
    expect(checkDeployInfo(deploy)).toEqual(deploy)
    expect(checkDeployInfo({ ...deploy, entry: null, main: "", size: 0 })).toEqual({ ...deploy, entry: null, main: "", size: 0 })
    expect(checkDeployInfo({ ...deploy, assets: undefined })).toEqual({ ...deploy, assets: null })
    for (const bad of [
      { assets: "/etc" }, { assets: `${dir}/assets/..` }, { assets: `${dir}/assets/` }, { assets: `${dir}/../x/assets` }, { assets: `${dir}/assets\n` }, { assets: 5 },
      { entry: "/home/u/f/evil.js" }, { entry: `${dir}/../20260101120000-0123abcd/worker.js` },
      { entry: null, assets: null },
      { dir: "/var/lib/candy/f/deploys/20260101120000-0123abce", entry: null, assets: null },
      { dir: "/tmp/x/20260101120000-0123abcd", entry: "/tmp/x/20260101120000-0123abcd/worker.js", assets: null },
    ]) expect(checkDeployInfo({ ...deploy, ...bad })).toBe(null)
    // With the op's stateDir, the snapshot must be that function's
    expect(checkToolResult("deploy", deploy, { stateDir: "/var/lib/candy/f" })).toEqual(deploy)
    expect(() => checkToolResult("deploy", deploy, { stateDir: "/var/lib/candy/g" })).toThrow("bad deploy info")
    expect(checkToolResult("deploys", [deploy], { stateDir: "/var/lib/candy/g" })).toEqual([])
  })

  it("checks the assets config strictly", () => {
    expect(checkProjectConfig(cfg)).toEqual(cfg)
    expect(checkProjectConfig({ ...cfg, main: null, assets: { ...assets, runWorkerFirst: false, binding: null } }, "/home/u/f/")).toMatchObject({ main: null })
    const bad: [Record<string, unknown>, string][] = [
      [{ main: null, assets: null }, "bad main"],
      [{ main: null, assets: undefined }, "bad main"],
      [{ assets: "dist" }, "bad assets"],
      [{ assets: { ...assets, directory: "dist" } }, "assets.directory"],
      [{ assets: { ...assets, directory: "/home/u/f" } }, "assets.directory"],
      [{ assets: { ...assets, directory: "/home/u/other" } }, "assets.directory"],
      [{ assets: { ...assets, directory: "/home/u/f/../other" } }, "assets.directory"],
      [{ assets: { ...assets, directory: "/home/u/f/di\u001bst" } }, "assets.directory"],
      [{ assets: { ...assets, binding: "a b" } }, "assets.binding"],
      [{ assets: { ...assets, binding: undefined } }, "assets.binding"],
      [{ assets: { ...assets, notFound: "spa" } }, "assets.notFound"],
      [{ assets: { ...assets, html: "<b>" } }, "assets.html"],
      [{ assets: { ...assets, runWorkerFirst: ["api/*"] } }, "assets.runWorkerFirst"],
      [{ assets: { ...assets, runWorkerFirst: ["/api/\u0001"] } }, "assets.runWorkerFirst"],
      [{ assets: { ...assets, runWorkerFirst: "true" } }, "assets.runWorkerFirst"],
      [{ assets: { ...assets, runWorkerFirst: Array(101).fill("/a") } }, "assets.runWorkerFirst"],
      [{ source: null }, "assets.directory"],
      [{ source: "wrangler.jsonc" }, "bad source"],
    ]
    for (const [patch, msg] of bad) expect(() => checkProjectConfig({ ...cfg, ...patch })).toThrow(msg)
    // With the dir the daemon asked about, the config must come from there
    expect(() => checkProjectConfig(cfg, "/home/u/g")).toThrow("bad source")
    expect(() => checkProjectConfig({ ...cfg, source: null }, "/home/u/g")).toThrow("assets.directory")
  })

  it("reads the fixtures' configs through the checks", async () => {
    const spa = checkToolResult("config", await runFnTool("config", { dir: SPA }), { dir: SPA }) as any
    expect(spa.main).toBe("src/index.ts")
    expect(spa.assets).toMatchObject({ directory: join(SPA, "dist"), binding: "ASSETS", runWorkerFirst: ["/api/*", "!/api/docs/*"] })
    const st = checkToolResult("config", await runFnTool("config", { dir: STATIC }), { dir: STATIC }) as any
    expect(st).toMatchObject({ main: null, assets: { directory: join(STATIC, "public"), notFound: "404-page" } })
  })

  it("deploys assets, reading them from the project when the daemon doesn't pass them", async () => {
    const stateDir = join(tmp, "assets-state")
    const d = checkToolResult("deploy", await runFnTool("deploy", { name: "s", srcDir: STATIC, main: null, stateDir }), { stateDir }) as any
    expect(d.entry).toBeNull()
    expect(d.assets).toBe(join(stateDir, "deploys", d.id, "assets"))

    const cfgSpa = await runFnTool("config", { dir: SPA }) as any
    const viaCli = await runCli("deploy", { name: "spa", srcDir: SPA, main: cfgSpa.main, stateDir, assets: cfgSpa.assets })
    expect(viaCli.ok).toBe(true)
    const spa = checkToolResult("deploy", viaCli.result, { stateDir }) as any
    expect(spa.entry).toBe(join(spa.dir, "worker.js"))
    expect(spa.assets).toBe(join(spa.dir, "assets"))

    // A passed config is checked too: it must stay inside srcDir
    await expect(runFnTool("deploy", { name: "s", srcDir: STATIC, main: null, stateDir, assets: { ...cfgSpa.assets } })).rejects.toThrow("assets.directory")
    await expect(runFnTool("deploy", { name: "s", srcDir: STATIC, main: null, stateDir, assets: null })).rejects.toThrow("main is required")

    const ids = ((await runFnTool("deploys", { stateDir })) as any[]).map(x => x.id)
    expect(ids.sort()).toEqual([d.id, spa.id].sort())
    // Read-only asset trees prune like any snapshot
    const pruned = await runFnTool("prune", { stateDir, keep: 1 }) as string[]
    expect(pruned.length).toBe(1)
    const left = ((await runFnTool("deploys", { stateDir })) as any[]).map(x => x.id)
    expect([...left, ...pruned].sort()).toEqual(ids.sort())
    expect(existsSync(join(stateDir, "deploys", pruned[0]))).toBe(false)
  })
})
