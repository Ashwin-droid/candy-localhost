import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadFnProjectConfig, parseJsonc, resolveMainInside, stripJsonc } from "../fn-config.ts"

const BASE = "/tmp/claude-1000/candy-fn-build/assets-a/config"
mkdirSync(BASE, { recursive: true })

// A fresh function folder with the given files.
const project = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(BASE, "cfg-"))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const FIXTURE = join(import.meta.dir, "fixtures", "fn-hello")

describe("jsonc", () => {
  it("strips comments and trailing commas but not string contents", () => {
    const src = `{
      // line comment
      "url": "http://x/*not a comment*/", /* block
      comment */ "a": [1, 2,],
      "quote": "say \\"hi\\", // still text",
    }`
    expect(parseJsonc(src)).toEqual({ url: "http://x/*not a comment*/", a: [1, 2], quote: 'say "hi", // still text' })
  })

  it("keeps line numbers through block comments", () => {
    expect(stripJsonc("/*a\nb*/1").split("\n").length).toBe(2)
  })

  it("rejects an unterminated block comment", () => {
    expect(() => stripJsonc("{ /* oops }")).toThrow("unterminated")
  })
})

describe("loadFnProjectConfig", () => {
  it("reads the sample function's candy.fn.json", async () => {
    const cfg = await loadFnProjectConfig(FIXTURE)
    expect(cfg.main).toBe("index.ts")
    expect(cfg.vars).toEqual({ GREETING: "hello from candy" })
    expect(cfg.kv).toEqual([])
    expect(cfg.source).toBe(join(FIXTURE, "candy.fn.json"))
    expect(cfg.warnings).toEqual([])
    expect(cfg.assets).toBeNull()
  })

  it("reads the wrangler.jsonc subset and warns about the rest", async () => {
    const cfg = await loadFnProjectConfig(join(FIXTURE, "bindings"))
    expect(cfg.main).toBe("src/index.ts")
    expect(cfg.vars).toEqual({ GREETING: "hi", LIMITS: '{"max":3}' })
    expect(cfg.kv).toEqual(["KV"])
    expect(cfg.d1).toEqual(["DB"])
    expect(cfg.crons).toEqual(["*/5 * * * *", "0 3 * * *"])
    // name, $schema and compatibility_date are skipped quietly; routes is not.
    expect(cfg.warnings.some(w => w.includes('"routes"'))).toBe(true)
    expect(cfg.warnings.some(w => w.includes("LIMITS"))).toBe(true)
    expect(cfg.warnings.some(w => w.includes('"name"') || w.includes("compatibility_date"))).toBe(false)
  })

  it("takes the first match and says which files it ignored", async () => {
    const dir = project({
      "candy.fn.json": `{ "main": "a.ts" }`,
      "wrangler.toml": `main = "b.ts"`,
      "a.ts": "",
      "b.ts": "",
    })
    const cfg = await loadFnProjectConfig(dir)
    expect(cfg.main).toBe("a.ts")
    expect(cfg.warnings).toContain("candy.fn.json takes precedence; ignoring wrangler.toml")
  })

  it("reads wrangler.json and wrangler.toml", async () => {
    const json = await loadFnProjectConfig(project({ "wrangler.json": `{ "main": "w.ts", "kv_namespaces": [{ "binding": "CACHE" }] }`, "w.ts": "" }))
    expect(json.main).toBe("w.ts")
    expect(json.kv).toEqual(["CACHE"])

    const toml = await loadFnProjectConfig(project({
      "wrangler.toml": `
main = "src/worker.ts"
name = "demo"
[vars]
GREETING = "hey"
PORT = 8080
[[kv_namespaces]]
binding = "KV"
id = "abc"
[[d1_databases]]
binding = "DB"
[triggers]
crons = ["0 * * * *"]
[env.staging]
vars = { A = "1" }
`,
      "src/worker.ts": "",
    }))
    expect(toml.main).toBe("src/worker.ts")
    expect(toml.vars).toEqual({ GREETING: "hey", PORT: "8080" })
    expect(toml.kv).toEqual(["KV"])
    expect(toml.d1).toEqual(["DB"])
    expect(toml.crons).toEqual(["0 * * * *"])
    expect(toml.warnings.some(w => w.includes('"env"'))).toBe(true)
  })

  it("accepts short forms in candy.fn.json only", async () => {
    const cfg = await loadFnProjectConfig(project({ "candy.fn.json": `{ "main": "i.ts", "kv": ["KV"], "d1": [{ "binding": "DB" }], "crons": ["@daily"] }`, "i.ts": "" }))
    expect([cfg.kv, cfg.d1, cfg.crons]).toEqual([["KV"], ["DB"], ["@daily"]])

    const w = await loadFnProjectConfig(project({ "wrangler.json": `{ "main": "i.ts", "kv": ["KV"] }`, "i.ts": "" }))
    expect(w.kv).toEqual([])
    expect(w.warnings.some(x => x.includes('"kv"'))).toBe(true)
  })

  it("finds a default entry when there is no config", async () => {
    const cfg = await loadFnProjectConfig(project({ "src/index.ts": "export default {}" }))
    expect(cfg).toEqual({ main: "src/index.ts", assets: null, vars: {}, kv: [], d1: [], crons: [], warnings: [], source: null })

    const empty = await loadFnProjectConfig(project({ "README.md": "" }))
    expect(empty.main).toBe("")
    expect(empty.warnings[0]).toContain("no main set")
  })

  it("warns when main does not exist yet", async () => {
    const cfg = await loadFnProjectConfig(project({ "candy.fn.json": `{ "main": "./src/../later.ts" }` }))
    expect(cfg.main).toBe("later.ts")
    expect(cfg.warnings).toContain('main "later.ts" does not exist yet')
  })

  it("rejects bad configs", async () => {
    const bad: [string, string][] = [
      [`{ "main": "../escape.ts" }`, "outside the function folder"],
      [`{ "main": "/etc/passwd" }`, "outside the function folder"],
      [`{ "main": "." }`, "outside the function folder"],
      [`{ "main": 5 }`, "main must be a string"],
      [`{ "kv": ["bad-name"] }`, "invalid binding name"],
      [`{ "kv": ["1KV"] }`, "invalid binding name"],
      [`{ "kv": [{ "id": "x" }] }`, '"binding"'],
      [`{ "d1_databases": {} }`, "must be an array"],
      [`{ "vars": { "A": "1" }, "kv": ["A"] }`, "defined twice"],
      [`{ "kv": ["X"], "d1": ["X"] }`, "defined twice"],
      [`{ "triggers": { "crons": ["not a cron"] } }`, "triggers.crons[0]"],
      [`{ "crons": [5] }`, "must be a string"],
      [`{ "vars": { "bad name": "x" } }`, "invalid name"],
      [`[1, 2]`, "top level must be an object"],
      [`{ "main": `, "candy.fn.json:"],
    ]
    for (const [text, msg] of bad) {
      const dir = project({ "candy.fn.json": text })
      await expect(loadFnProjectConfig(dir)).rejects.toThrow(msg)
    }
    await expect(loadFnProjectConfig(project({ "wrangler.toml": `main = ` }))).rejects.toThrow("wrangler.toml:")
  })

  it("rejects a main that symlinks out of the folder", async () => {
    const outside = project({ "secret.ts": "" })
    const dir = project({ "candy.fn.json": `{ "main": "link.ts" }` })
    symlinkSync(join(outside, "secret.ts"), join(dir, "link.ts"))
    await expect(loadFnProjectConfig(dir)).rejects.toThrow("symlink")
    expect(() => resolveMainInside(dir, "a\0b")).toThrow("NUL")
  })
})

const SPA = join(import.meta.dir, "fixtures", "fn-spa")
const STATIC = join(import.meta.dir, "fixtures", "fn-static")

describe("assets", () => {
  it("reads the SPA fixture's wrangler assets block", async () => {
    const cfg = await loadFnProjectConfig(SPA)
    expect(cfg.main).toBe("src/index.ts")
    expect(cfg.assets).toEqual({
      directory: join(SPA, "dist"), binding: "ASSETS", notFound: "single-page-application",
      html: "auto-trailing-slash", runWorkerFirst: ["/api/*", "!/api/docs/*"],
    })
    expect(cfg.warnings).toEqual([])
  })

  it("makes an assets-only project with main null, without probing default entries", async () => {
    const cfg = await loadFnProjectConfig(STATIC)
    expect(cfg.main).toBeNull()
    expect(cfg.assets).toMatchObject({ directory: join(STATIC, "public"), notFound: "404-page", binding: null, runWorkerFirst: false })
    expect(cfg.warnings).toEqual([])

    // A stray index.js next to an assets-only config stays a file, not a worker
    const dir = project({ "candy.fn.json": `{ "assets": { "directory": "site" } }`, "site/index.html": "", "index.js": "" })
    expect((await loadFnProjectConfig(dir)).main).toBeNull()
  })

  it("keeps the error for a project with neither main nor assets", async () => {
    const cfg = await loadFnProjectConfig(project({ "candy.fn.json": `{ "vars": { "A": "1" } }` }))
    expect(cfg.main).toBe("")
    expect(cfg.assets).toBeNull()
    expect(cfg.warnings[0]).toContain("no main set")
  })

  it("reads assets from wrangler.toml and passes fn-assets warnings through", async () => {
    const cfg = await loadFnProjectConfig(project({
      "wrangler.toml": `main = "w.ts"\n[assets]\ndirectory = "./out"\nhtml_handling = "none"\ncolor = "red"\n`,
      "w.ts": "",
    }))
    expect(cfg.assets).toMatchObject({ directory: expect.stringMatching(/\/out$/), html: "none" })
    expect(cfg.warnings.some(w => w.includes("assets.color"))).toBe(true)
    expect(cfg.warnings.some(w => w.includes("does not exist"))).toBe(true)
    expect(cfg.warnings.some(w => w.includes('"assets"'))).toBe(false)
  })

  it("rejects bad assets blocks", async () => {
    const bad: [string, string][] = [
      [`{ "main": "i.ts", "assets": "public" }`, "assets must be an object"],
      [`{ "main": "i.ts", "assets": {} }`, "assets.directory is required"],
      [`{ "main": "i.ts", "assets": { "directory": "p", "not_found_handling": "spa" } }`, "not_found_handling"],
      [`{ "main": "i.ts", "assets": { "directory": "p", "html_handling": 1 } }`, "html_handling"],
      [`{ "main": "i.ts", "assets": { "directory": "p", "binding": "bad-name" } }`, "assets.binding"],
      [`{ "main": "i.ts", "assets": { "directory": "p", "run_worker_first": ["api/*"] } }`, "run_worker_first"],
      [`{ "main": "i.ts", "assets": { "directory": "p", "run_worker_first": "yes" } }`, "run_worker_first"],
      [`{ "main": "i.ts", "assets": { "directory": "../elsewhere" } }`, "inside the function folder"],
      [`{ "main": "i.ts", "assets": { "directory": "/etc" } }`, "inside the function folder"],
      [`{ "main": "i.ts", "assets": { "directory": "." } }`, "inside the function folder"],
      [`{ "main": "i.ts", "assets": { "directory": "p/\\u0007x" } }`, "control characters"],
      [`{ "main": "i.ts", "vars": { "ASSETS": "x" }, "assets": { "directory": "p", "binding": "ASSETS" } }`, "defined twice"],
      [`{ "assets": { "directory": "p", "run_worker_first": true } }`, "needs a main"],
      [`{ "assets": { "directory": "p", "run_worker_first": ["/api/*"] } }`, "needs a main"],
      [`{ "assets": { "directory": "p" }, "crons": ["@daily"] }`, "crons need a main"],
    ]
    for (const [text, msg] of bad) {
      const dir = project({ "candy.fn.json": text, "i.ts": "", "p/index.html": "" })
      await expect(loadFnProjectConfig(dir)).rejects.toThrow(msg)
    }
  })

  it("allows exclusion-only run_worker_first and warns about a binding without a main", async () => {
    const cfg = await loadFnProjectConfig(project({ "candy.fn.json": `{ "assets": { "directory": "p", "binding": "ASSETS", "run_worker_first": ["!/x/*"] } }`, "p/a.txt": "" }))
    expect(cfg.main).toBeNull()
    expect(cfg.warnings.some(w => w.includes("no effect without a main"))).toBe(true)
  })

  it("rejects an assets directory that symlinks out of the folder", async () => {
    const outside = project({ "site/index.html": "" })
    const dir = project({ "candy.fn.json": `{ "assets": { "directory": "pub" } }` })
    symlinkSync(join(outside, "site"), join(dir, "pub"))
    await expect(loadFnProjectConfig(dir)).rejects.toThrow("symlink")
    // A symlink that stays inside is fine
    const ok = project({ "candy.fn.json": `{ "assets": { "directory": "pub" } }`, "real/index.html": "" })
    symlinkSync(join(realpathSync(ok), "real"), join(ok, "pub"))
    expect((await loadFnProjectConfig(ok)).assets?.directory).toBe(join(ok, "pub"))
  })
})
