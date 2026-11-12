import { afterAll, describe, expect, it } from "bun:test"
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { bundleDeploy, gitRevOf, listDeploys, pruneDeploys, resolveDeploy } from "../fn-deploy.ts"
import { AssetServer, MANIFEST_NAME } from "../fn-assets.ts"
import { loadFnProjectConfig } from "../fn-config.ts"

const base = "/tmp/claude-1000/candy-fn-build/assets-a/deploy"
await mkdir(base, { recursive: true })
const roots: string[] = []

async function fixture(greeting = "hi"): Promise<{ src: string; state: string }> {
  const root = await mkdtemp(join(base, "t-"))
  roots.push(root)
  const src = join(root, "src")
  await mkdir(join(src, "lib"), { recursive: true })
  await writeFile(join(src, "lib", "greet.ts"), `export const greet = (n: string): string => "${greeting} " + n\n`)
  await writeFile(join(src, "index.ts"), `import { greet } from "./lib/greet"\nexport default { fetch: () => new Response(greet("there")) }\n`)
  return { src, state: join(root, "state") }
}

const tick = () => Bun.sleep(5)

afterAll(async () => {
  // Snapshots are read-only; pruning to 0 unlocks and removes them
  for (const r of roots) {
    await pruneDeploys(join(r, "state"), 0).catch(() => {})
    await rm(r, { recursive: true, force: true })
  }
})

describe("bundleDeploy", () => {
  it("bundles a relative import into one worker.js with a manifest", async () => {
    const { src, state } = await fixture()
    const d = await bundleDeploy({ name: "hello", srcDir: src, main: "index.ts", stateDir: state, gitRev: "abc1234" })

    expect(d.id).toMatch(/^\d{14}-[0-9a-f]{8}$/)
    expect(d.dir).toBe(join(state, "deploys", d.id))
    expect(d.entry).toBe(join(d.dir, "worker.js"))
    expect(d.main).toBe("index.ts")
    expect(d.source).toBe(src)
    expect(d.gitRev).toBe("abc1234")
    expect(d.assets).toBeNull()

    expect((await readdir(d.dir)).sort()).toEqual(["manifest.json", "worker.js", "worker.js.map"])
    const code = await readFile(d.entry, "utf8")
    expect(code).toContain("there")
    expect(code).toContain("sourceMappingURL=worker.js.map")
    expect(d.size).toBe(Buffer.byteLength(code))
    const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 8)
    expect(d.id.endsWith(hash)).toBe(true)

    const manifest = JSON.parse(await readFile(join(d.dir, "manifest.json"), "utf8"))
    expect(manifest).toEqual({
      id: d.id, createdAt: d.createdAt, main: "index.ts", source: src, gitRev: "abc1234", size: d.size,
      files: ["manifest.json", "worker.js", "worker.js.map"], assets: null,
    })

    // The bundle runs on its own, with the import inlined
    const mod = await import(d.entry!)
    expect(await (await mod.default.fetch()).text()).toBe("hi there")

    // Read-only snapshot
    expect((await stat(d.dir)).mode & 0o777).toBe(0o555)
    expect((await stat(d.entry!)).mode & 0o777).toBe(0o444)
    // No temp dirs left behind
    expect(await readdir(join(state, "deploys"))).toEqual([d.id])
  })

  it("throws with Bun's build logs on a build error", async () => {
    const { src, state } = await fixture()
    await writeFile(join(src, "index.ts"), `import { nope } from "./missing-module"\nexport default { fetch: () => new Response(nope) }\n`)
    const err = await bundleDeploy({ name: "broken", srcDir: src, main: "index.ts", stateDir: state, gitRev: null }).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain("build failed")
    expect(err.message).toContain("missing-module")
    expect(await listDeploys(state)).toEqual([])
    expect(await readdir(join(state, "deploys"))).toEqual([])
  })

  it("rejects a main outside srcDir", async () => {
    const { src, state } = await fixture()
    await expect(bundleDeploy({ name: "x", srcDir: src, main: "../escape.ts", stateDir: state, gitRev: null })).rejects.toThrow(/outside/)
  })

  it("reads the git rev when not given", async () => {
    const { src, state } = await fixture()
    expect(await gitRevOf(src)).toBeNull()
    const d = await bundleDeploy({ name: "x", srcDir: src, main: "index.ts", stateDir: state })
    expect(d.gitRev).toBeNull()

    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", src, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode
    if (git("init", "-q") !== 0) return  // no git on this machine
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    expect(await gitRevOf(src)).toMatch(/^[0-9a-f]{4,}$/)
  })
})

describe("listDeploys / pruneDeploys / resolveDeploy", () => {
  it("lists newest first and prunes all but N, keeping the pinned one", async () => {
    const { src, state } = await fixture()
    const ids: string[] = []
    for (const g of ["a", "b", "c", "d", "e"]) {
      await writeFile(join(src, "lib", "greet.ts"), `export const greet = (n: string): string => "${g} " + n\n`)
      ids.push((await bundleDeploy({ name: "x", srcDir: src, main: "index.ts", stateDir: state, gitRev: null })).id)
      await tick()
    }
    expect(new Set(ids).size).toBe(5)
    expect((await listDeploys(state)).map(d => d.id)).toEqual([...ids].reverse())

    const removed = await pruneDeploys(state, 2, ids[0])
    expect(removed.sort()).toEqual([ids[1], ids[2]].sort())
    expect((await listDeploys(state)).map(d => d.id)).toEqual([ids[4], ids[3], ids[0]])
    expect(await resolveDeploy(state, ids[1])).toBeNull()
    expect((await resolveDeploy(state, ids[0]))?.entry).toBe(join(state, "deploys", ids[0], "worker.js"))
  })

  it("lists nothing when there is no deploys dir", async () => {
    const { state } = await fixture()
    expect(await listDeploys(state)).toEqual([])
    expect(await pruneDeploys(state, 1)).toEqual([])
  })

  it("rejects ids that are not the generated shape", async () => {
    const { src, state } = await fixture()
    const d = await bundleDeploy({ name: "x", srcDir: src, main: "index.ts", stateDir: state, gitRev: null })
    expect((await resolveDeploy(state, d.id))?.id).toBe(d.id)
    for (const bad of ["", "..", "../deploys", `${d.id}/..`, `../${d.id}`, d.id.toUpperCase() + "X", "2026111212000-abcdef12", "20261112120000-ABCDEF12", "20261112120000-abcdef1"]) {
      expect(await resolveDeploy(state, bad)).toBeNull()
    }
    // A well-formed id that doesn't exist
    expect(await resolveDeploy(state, "20000101000000-00000000")).toBeNull()
  })
})

const SPA = join(import.meta.dir, "fixtures", "fn-spa")
const STATIC = join(import.meta.dir, "fixtures", "fn-static")

// A writable copy of a fixture, with its loaded config
async function copyOf(fixtureDir: string) {
  const root = await mkdtemp(join(base, "a-"))
  roots.push(root)
  const src = join(root, "src")
  await cp(fixtureDir, src, { recursive: true })
  return { src, state: join(root, "state"), cfg: await loadFnProjectConfig(src) }
}

async function treeOf(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...await treeOf(join(dir, e.name), `${prefix}${e.name}/`))
    else out.push(prefix + e.name)
  }
  return out.sort()
}

describe("bundleDeploy with assets", () => {
  it("snapshots the SPA's filtered asset tree next to worker.js, read-only", async () => {
    const { src, state, cfg } = await copyOf(SPA)
    const d = await bundleDeploy({ name: "spa", srcDir: src, main: cfg.main, stateDir: state, gitRev: null, assets: cfg.assets })

    expect(d.entry).toBe(join(d.dir, "worker.js"))
    expect(d.assets).toBe(join(d.dir, "assets"))
    expect(d.assetsConfig).toEqual({ binding: "ASSETS", notFound: "single-page-application", html: "auto-trailing-slash", runWorkerFirst: ["/api/*", "!/api/docs/*"] })
    expect((await readdir(d.dir)).sort()).toEqual(["assets", MANIFEST_NAME, "manifest.json", "worker.js", "worker.js.map"])
    // .assetsignore (*.map, drafts/) and the control files are left out
    expect(await treeOf(d.assets!)).toEqual(["api/docs/index.html", "assets/app.js", "index.html"])

    const manifest = JSON.parse(await readFile(join(d.dir, "manifest.json"), "utf8"))
    expect(manifest.assets).toEqual({
      source: join(src, "dist"), binding: "ASSETS", notFound: "single-page-application", html: "auto-trailing-slash",
      runWorkerFirst: ["/api/*", "!/api/docs/*"], files: 3, bytes: expect.any(Number),
    })
    expect(manifest.files).toEqual(["assets", MANIFEST_NAME, "manifest.json", "worker.js", "worker.js.map"])
    const am = JSON.parse(await readFile(join(d.dir, MANIFEST_NAME), "utf8"))
    expect(am.redirects.length).toBe(2)
    expect(am.headers.length).toBe(2)

    // Read-only all the way down
    for (const p of [d.dir, d.assets!, join(d.assets!, "assets")]) expect((await stat(p)).mode & 0o777).toBe(0o555)
    for (const p of ["manifest.json", MANIFEST_NAME, "worker.js", "assets/index.html", "assets/assets/app.js"]) {
      expect((await stat(join(d.dir, p))).mode & 0o777).toBe(0o444)
    }

    // The snapshot serves on its own with the deploy's config pointed at it
    const server = await AssetServer.open({ ...cfg.assets!, directory: d.assets! }, { mode: "snapshot" })
    try {
      const r = await server.route(new Request("http://spa.localhost/assets/app.js"), { hasWorker: true })
      expect(r.kind).toBe("asset")
      expect(await r.response!.text()).toContain("fn-spa app")
      expect(r.response!.headers.get("x-frame-options")).toBe("DENY")
      expect((await server.route(new Request("http://spa.localhost/api/me"), { hasWorker: true })).kind).toBe("worker")
    } finally {
      server.close()
    }

    expect(await resolveDeploy(state, d.id)).toEqual(d)
    expect(await listDeploys(state)).toEqual([d])
  })

  it("reports the recorded routing, and leaves it out for a manifest that lacks it", async () => {
    const { src, state, cfg } = await copyOf(STATIC)
    const d = await bundleDeploy({ name: "static", srcDir: src, main: null, stateDir: state, gitRev: null, assets: cfg.assets })
    expect(d.assetsConfig).toEqual({ binding: cfg.assets!.binding, notFound: "404-page", html: cfg.assets!.html, runWorkerFirst: cfg.assets!.runWorkerFirst })
    const mp = join(d.dir, "manifest.json")
    const m = JSON.parse(await readFile(mp, "utf8"))
    delete m.assets.runWorkerFirst
    await chmod(mp, 0o644)
    await writeFile(mp, JSON.stringify(m))
    const old = await resolveDeploy(state, d.id)
    expect(old?.assets).toBe(join(d.dir, "assets"))
    expect(old && "assetsConfig" in old).toBe(false)
  })

  it("deploys an assets-only project without Bun.build", async () => {
    const { src, state, cfg } = await copyOf(STATIC)
    expect(cfg.main).toBeNull()
    const d = await bundleDeploy({ name: "static", srcDir: src, main: null, stateDir: state, gitRev: null, assets: cfg.assets })
    expect(d.entry).toBeNull()
    expect(d.main).toBe("")
    expect(d.size).toBe(0)
    expect(d.assets).toBe(join(d.dir, "assets"))
    expect((await readdir(d.dir)).sort()).toEqual(["assets", MANIFEST_NAME, "manifest.json"])
    expect(await treeOf(d.assets!)).toEqual(["404.html", "about.html", "blog/post.html", "index.html", "style.css"])
    const manifest = JSON.parse(await readFile(join(d.dir, "manifest.json"), "utf8"))
    expect(manifest).toMatchObject({ main: null, size: 0, assets: { files: 5, notFound: "404-page" } })
    expect(await resolveDeploy(state, d.id)).toEqual(d)
  })

  it("gives a new id when an asset, _headers or the routing config changes", async () => {
    const { src, state, cfg } = await copyOf(STATIC)
    const deploy = (assets = cfg.assets) => bundleDeploy({ name: "s", srcDir: src, main: null, stateDir: state, gitRev: null, assets })
    const sha = (id: string) => id.slice(-8)
    const a = await deploy()
    await writeFile(join(src, "public", "about.html"), "changed")
    const b = await deploy()
    await writeFile(join(src, "public", "_headers"), "/*\n  X-Test: 1\n")
    const c = await deploy()
    const d = await deploy({ ...cfg.assets!, html: "none" })
    expect(new Set([a, b, c, d].map(x => sha(x.id))).size).toBe(4)
  })

  it("reuses an identical snapshot and cleans up the read-only temp tree", async () => {
    const { src, state, cfg } = await copyOf(SPA)
    const first = await bundleDeploy({ name: "spa", srcDir: src, main: cfg.main, stateDir: state, gitRev: null, assets: cfg.assets })
    const second = await bundleDeploy({ name: "spa", srcDir: src, main: cfg.main, stateDir: state, gitRev: null, assets: cfg.assets })
    // Same content within the same second gives the same id (unless the clock ticked over in between)
    if (second.id === first.id) expect(second).toEqual(first)
    expect((await readdir(join(state, "deploys"))).filter(n => n.startsWith(".tmp-"))).toEqual([])
  })

  it("prunes snapshots with read-only asset trees", async () => {
    const { src, state, cfg } = await copyOf(STATIC)
    const ids: string[] = []
    for (const v of ["1", "2", "3"]) {
      await writeFile(join(src, "public", "v.txt"), v)
      ids.push((await bundleDeploy({ name: "s", srcDir: src, main: null, stateDir: state, gitRev: null, assets: cfg.assets })).id)
    }
    expect((await pruneDeploys(state, 1)).sort()).toEqual([ids[0], ids[1]].sort())
    expect(await readdir(join(state, "deploys"))).toEqual([ids[2]])
  })

  it("refuses nothing to deploy, an assets dir outside the source, and leaves nothing behind on failure", async () => {
    const { src, state, cfg } = await copyOf(SPA)
    await expect(bundleDeploy({ name: "x", srcDir: src, main: null, stateDir: state, gitRev: null })).rejects.toThrow("nothing to deploy")
    await expect(bundleDeploy({ name: "x", srcDir: src, main: null, stateDir: state, gitRev: null, assets: { ...cfg.assets!, directory: "/etc" } })).rejects.toThrow("outside")
    await expect(bundleDeploy({ name: "x", srcDir: src, main: null, stateDir: state, gitRev: null, assets: { ...cfg.assets!, directory: src } })).rejects.toThrow("outside")
    await expect(bundleDeploy({ name: "x", srcDir: src, main: null, stateDir: state, gitRev: null, assets: { ...cfg.assets!, directory: join(src, "missing") } })).rejects.toThrow("does not exist")

    // A build error after nothing was written, and an oversized asset after the worker was built
    await writeFile(join(src, "src", "index.ts"), `import "./nope"\n`)
    await expect(bundleDeploy({ name: "x", srcDir: src, main: cfg.main, stateDir: state, gitRev: null, assets: cfg.assets })).rejects.toThrow("build failed")
    await writeFile(join(src, "src", "index.ts"), `export default { fetch: () => new Response("ok") }\n`)
    await writeFile(join(src, "dist", "big.bin"), Buffer.alloc(25 * 1024 * 1024 + 1))
    await expect(bundleDeploy({ name: "x", srcDir: src, main: cfg.main, stateDir: state, gitRev: null, assets: cfg.assets })).rejects.toThrow("byte limit")
    expect(await readdir(join(state, "deploys"))).toEqual([])
  })
})
