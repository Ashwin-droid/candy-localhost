import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MANIFEST_KEYS, MAX_DEPENDS, checkSiteManifest, emptyManifest, findDependencyLoop, loadSiteManifest, normalizeManifest } from "../manifest.ts"
import { loadFnProjectConfig } from "../fn-config.ts"
import { checkToolResult, runFnTool } from "../fn-tool.ts"

const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "candy-manifest-"))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

describe("candy.json", () => {
  it("a site without one asks for nothing", async () => {
    expect(await loadSiteManifest(project({}))).toEqual(emptyManifest())
    expect(emptyManifest()).toEqual({ auth: false, depends: [], publish: false, idle: false, events: [], subscribe: [], service: false, warnings: [], source: null })
  })

  it("reads auth and depends, comments and all", async () => {
    const dir = project({ "candy.json": `{
      // sign in with candy
      "auth": true,
      "depends": ["db", "Queue", "db"],
      "publish": true,
    }` })
    const m = await loadSiteManifest(dir)
    expect(m).toEqual({ auth: true, depends: ["db", "queue"], publish: true, idle: false, events: [], subscribe: [], service: false, warnings: [], source: join(dir, "candy.json") })
    expect(normalizeManifest({}).publish).toBe(false)
    expect(normalizeManifest({ depends: "db" }).depends).toEqual(["db"])
    expect(normalizeManifest({}).auth).toBe(false)
  })

  it("refuses values it can't use, so a typo never quietly turns a feature off", () => {
    for (const bad of [{ auth: "yes" }, { auth: 1 }, { publish: "all" }, { publish: ["bob"] }, { depends: 5 }, { depends: [1] }, { depends: ["a b"] }, { depends: ["../x"] }, { depends: ["-a"] }, { depends: [""] }, [], null, "x"]) {
      expect(() => normalizeManifest(bad)).toThrow(/candy\.json/)
    }
    expect(() => normalizeManifest({ depends: Array.from({ length: MAX_DEPENDS + 1 }, (_, i) => `s${i}`) })).toThrow(/at most/)
    expect(normalizeManifest({ depends: Array.from({ length: MAX_DEPENDS }, (_, i) => `s${i}`) }).depends.length).toBe(MAX_DEPENDS)
  })

  it("names the file when it doesn't parse", async () => {
    await expect(loadSiteManifest(project({ "candy.json": `{ "auth": ` }))).rejects.toThrow(/^candy\.json: /)
  })

  it("what another process says a manifest is gets checked again", () => {
    expect(checkSiteManifest({ auth: true, depends: ["db"], warnings: ["a\u001b[31mb"], source: "/srv/x/candy.json", extra: 1 }))
      .toEqual({ auth: true, depends: ["db"], publish: false, idle: false, events: [], subscribe: [], service: false, warnings: ["a [31mb"], source: "/srv/x/candy.json" })
    expect(checkSiteManifest({ auth: false, depends: [], publish: true }).publish).toBe(true)
    expect(() => checkSiteManifest({ auth: false, depends: [], publish: 1 })).toThrow()
    expect(() => checkSiteManifest({ auth: "true", depends: [] })).toThrow()
    expect(() => checkSiteManifest({ auth: true, depends: ["../etc"] })).toThrow()
    expect(() => checkSiteManifest(null)).toThrow()
    expect(checkSiteManifest({ auth: false, depends: [], source: "a\nb" }).source).toBeNull()
  })

  it("fn-tool reads it for any site, and the daemon checks the answer", async () => {
    const dir = project({ "candy.json": `{ "auth": true, "depends": ["db"] }` })
    const out = await runFnTool("manifest", { dir })
    expect(checkToolResult("manifest", out, { dir })).toMatchObject({ auth: true, depends: ["db"] })
    expect(() => checkToolResult("manifest", { auth: 1 }, { dir })).toThrow()
  })
})

describe("depends loops", () => {
  const graph = (o: Record<string, string[]>) => new Map(Object.entries(o))
  it("finds a circle back through any path", () => {
    expect(findDependencyLoop("a", graph({ a: ["b"], b: ["c"], c: [] }))).toBeNull()
    expect(findDependencyLoop("a", graph({ a: ["a"] }))).toBe("a -> a")
    expect(findDependencyLoop("a", graph({ a: ["b"], b: ["a"] }))).toBe("a -> b -> a")
    expect(findDependencyLoop("a", graph({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] }))).toBeNull()   // a diamond is fine
    expect(findDependencyLoop("a", graph({ a: ["b"], b: ["c"], c: ["b"] }))).toBe("b -> c -> b")
    expect(findDependencyLoop("a", graph({ a: ["gone"] }))).toBeNull()
  })
})

describe("candy.json as a function's config", () => {
  it("holds the function keys and the shared ones together", async () => {
    const dir = project({ "candy.json": `{ "main": "i.ts", "kv": ["KV"], "auth": true, "depends": ["db"] }`, "i.ts": "" })
    const cfg = await loadFnProjectConfig(dir)
    expect(cfg.main).toBe("i.ts")
    expect(cfg.kv).toEqual(["KV"])
    expect(cfg.warnings).toEqual([])
    expect(cfg.source).toBe(join(dir, "candy.json"))
    expect(await loadSiteManifest(dir)).toMatchObject({ auth: true, depends: ["db"] })
  })

  it("a candy.json with only shared keys is still the function's config (default entry)", async () => {
    const dir = project({ "candy.json": `{ "auth": true }`, "index.ts": "" })
    const cfg = await loadFnProjectConfig(dir)
    expect(cfg.main).toBe("index.ts")
    expect(cfg.warnings).toEqual([])
  })

  it("fn-config's shared keys are the manifest's", () => {
    const src = readFileSync(join(import.meta.dir, "..", "fn-config.ts"), "utf8")
    expect(src).toContain(`const SHARED_KEYS = new Set([${MANIFEST_KEYS.map(k => `"${k}"`).join(", ")}])`)
  })
})

describe("the daemon and candy.json", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "daemon.ts"), "utf8")
  it("sign in needs \"auth\": true: no key at launch, no tokens, no key fetch without it", () => {
    expect(daemon).toContain(`const isAuthSite = (name: string): boolean => serverConfigs.has(name) && !isReserved(name) && manifestNow(name)?.auth === true`)
    expect(daemon).toContain(`const appAuth = !cron && name && manifest?.auth ? appAuthLaunch(name, configUser(config)) : null`)
    expect(daemon.split("await refreshManifests()   // which sites have").length).toBe(3)
  })
  it("reads the file as the site's user, never as root", () => {
    expect(daemon).toContain(`m = await fnTool<SiteManifest>(config, 'manifest', { dir: config.cwd })`)
    expect(daemon).not.toMatch(/Bun\.file\([^)]*MANIFEST_FILE/)
  })
  it("a held site is skipped by the idle check, before its own limit is looked at", () => {
    const kill = daemon.slice(daemon.indexOf("const killIdleServers"), daemon.indexOf("setInterval(() => { sampleActivity()"))
    expect(kill.indexOf("if (isHeld(name))")).toBeGreaterThan(0)
    expect(kill.indexOf("if (isHeld(name))")).toBeLessThan(kill.indexOf("proc.config.ttl"))
  })
  it("dependencies come up before the launch, for servers, functions and cron runs", () => {
    for (const [fn, launch] of [
      ["const spawnProcessNow = async", "await launchSpec(config, undefined, name)"],
      ["const launchFnInstance = async", "await launchSpec(config, undefined, name, instance)"],
      ["const runCronJob = async", "await launchSpec(config, { job: job.name"],
    ]) {
      const body = daemon.slice(daemon.indexOf(fn))
      expect(body.indexOf("startDependencies(name, config)")).toBeGreaterThan(0)
      expect(body.indexOf("startDependencies(name, config)")).toBeLessThan(body.indexOf(launch))
    }
  })
  it("another user's site can only be depended on when its owner published it", () => {
    const start = daemon.slice(daemon.indexOf("const startDependencies = async"), daemon.indexOf("const fnStateDirProblem"))
    expect(start).toContain("if (nameOwner(dep) === owner || ownerIsSuper) continue")
    expect(start).toContain("?.publish === true")
    expect(start.indexOf("is not published")).toBeLessThan(start.indexOf("await startDependency(dep, name)"))
  })
  it("a tree starts leaves first: each dependency's own start brings up its dependencies before it launches", () => {
    const dep = daemon.slice(daemon.indexOf("const startDependency = async"), daemon.indexOf("const startDependencies = async"))
    expect(dep).toContain("await spawnProcess(dep, 'System')")
    const spawn = daemon.slice(daemon.indexOf("const spawnProcessNow = async"))
    expect(spawn.indexOf("await startDependencies(name, config)")).toBeLessThan(spawn.indexOf("processes.set(name, managed)"))
  })
  it("a stop someone asked for stops the dependents first; idle stops and restarts don't", () => {
    expect(daemon).toMatch(/const alsoStopped = await stopDependents\(name, actor\)\s+const success = await stopSite\(name, actor\)/)
    const idle = daemon.slice(daemon.indexOf("const killIdleServers"), daemon.indexOf("setInterval(() => { sampleActivity()"))
    expect(idle).not.toContain("stopDependents")
    const restart = daemon.slice(daemon.indexOf("const restartProcess = async"), daemon.indexOf("const restartProcess = async") + 600)
    expect(restart).not.toContain("stopDependents")
  })
})
