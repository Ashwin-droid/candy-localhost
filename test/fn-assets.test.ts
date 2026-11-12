import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { chmodSync, cpSync, linkSync, renameSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  AssetServer, compilePattern, contentTypeFor, globMatch, loadAssetsConfig, matchRunWorkerFirst, modeAllows, normalizePath,
  parseAssetsIgnore, parseHeaders, parseRedirects, readVerified, snapshotAssets, userCanRead, validateRunWorkerFirst,
  type AssetsConfig, type HtmlHandling, type NotFoundHandling,
} from "../fn-assets.ts"

const BASE = "/tmp/claude-1000/candy-fn-build/assets"
mkdirSync(BASE, { recursive: true })
const FIXTURE = join(import.meta.dir, "fixtures", "fn-assets")

// Fixture copy plus symlinks git can't hold: one inside, two escaping the directory.
const site = (): string => {
  const dir = mkdtempSync(join(BASE, "site-"))
  cpSync(FIXTURE, dir, { recursive: true })
  const outside = mkdtempSync(join(BASE, "outside-"))
  writeFileSync(join(outside, "secret.html"), "outside secret")
  symlinkSync(join(dir, "about.html"), join(dir, "inside-link.html"))
  symlinkSync(join(outside, "secret.html"), join(dir, "escape.html"))
  symlinkSync(outside, join(dir, "escdir"))
  return dir
}

const cfgFor = (dir: string, over: Partial<AssetsConfig> = {}): AssetsConfig => ({
  directory: dir, binding: null, notFound: "none", html: "auto-trailing-slash", runWorkerFirst: false, ...over,
})

const ORIGIN = "http://site.localhost"
const req = (path: string, init: RequestInit & { navigate?: boolean } = {}) => {
  const headers = new Headers(init.headers)
  if (init.navigate) headers.set("Sec-Fetch-Mode", "navigate")
  return new Request(path.startsWith("http") ? path : ORIGIN + path, { ...init, headers })
}

const servers: AssetServer[] = []
const open = async (dir: string, over: Partial<AssetsConfig> = {}, opts: Partial<Parameters<typeof AssetServer.open>[1]> = {}) => {
  const s = await AssetServer.open(cfgFor(dir, over), { mode: "dev", ...opts })
  servers.push(s)
  return s
}
afterAll(() => servers.forEach(s => s.close()))

const text = async (r: Response | undefined) => (r ? await r.text() : "")

let DIR = ""
beforeAll(() => {
  DIR = site()
})

// What a no-worker request resolves to: [status, body or Location].
const resolveAs = async (s: AssetServer, path: string, hasWorker = false) => {
  const r = await s.route(req(path), { hasWorker })
  if (r.kind === "worker") return ["worker"]
  const res = r.response!
  if (res.status === 307 || res.status === 301 || res.status === 302 || res.status === 308) return [res.status, res.headers.get("location")]
  return [res.status, (await res.text()).trim()]
}

describe("html_handling (Cloudflare's table)", () => {
  const table: Record<HtmlHandling, [string, unknown[]][]> = {
    "auto-trailing-slash": [
      ["/", [200, "<h1>home</h1>"]],
      ["/index.html", [307, "/"]],
      ["/index", [307, "/"]],
      ["/about", [200, "<h1>about</h1>"]],
      ["/about.html", [307, "/about"]],
      ["/about/", [307, "/about"]],
      ["/blog", [307, "/blog/"]],
      ["/blog/", [200, "<h1>blog</h1>"]],
      ["/blog/index.html", [307, "/blog/"]],
      ["/blog/index", [307, "/blog/"]],
      ["/blog.html", [307, "/blog/"]],
      ["/blog/post", [200, "<h1>post</h1>"]],
      ["/blog/post.html", [307, "/blog/post"]],
      ["/both", [200, "<h1>both file</h1>"]],
      ["/both/", [200, "<h1>both dir</h1>"]],
      ["/both.html", [307, "/both"]],
      ["/both/index.html", [307, "/both/"]],
      ["/docs/guide", [307, "/docs/guide/"]],
      ["/app.js", [200, "console.log('app')"]],
      ["/missing", [404, ""]],
    ],
    "force-trailing-slash": [
      ["/", [200, "<h1>home</h1>"]],
      ["/index.html", [307, "/"]],
      ["/about", [307, "/about/"]],
      ["/about/", [200, "<h1>about</h1>"]],
      ["/about.html", [307, "/about/"]],
      ["/blog", [307, "/blog/"]],
      ["/blog/", [200, "<h1>blog</h1>"]],
      ["/blog/index.html", [307, "/blog/"]],
      ["/blog/index", [307, "/blog/"]],
      ["/both/", [200, "<h1>both dir</h1>"]],
      ["/both.html", [200, "<h1>both file</h1>"]],
      ["/both", [307, "/both/"]],
      ["/app.js", [200, "console.log('app')"]],
      ["/missing/", [404, ""]],
    ],
    "drop-trailing-slash": [
      ["/", [200, "<h1>home</h1>"]],
      ["/index.html", [307, "/"]],
      ["/index", [307, "/"]],
      ["/about", [200, "<h1>about</h1>"]],
      ["/about/", [307, "/about"]],
      ["/about.html", [307, "/about"]],
      ["/blog", [200, "<h1>blog</h1>"]],
      ["/blog/", [307, "/blog"]],
      ["/blog/index.html", [307, "/blog"]],
      ["/blog/index", [307, "/blog"]],
      ["/both", [200, "<h1>both file</h1>"]],
      ["/both/", [307, "/both"]],
      ["/both/index.html", [200, "<h1>both dir</h1>"]],
      ["/app.js", [200, "console.log('app')"]],
    ],
    none: [
      ["/", [404, ""]],
      ["/index.html", [200, "<h1>home</h1>"]],
      ["/about", [404, ""]],
      ["/about.html", [200, "<h1>about</h1>"]],
      ["/blog/", [404, ""]],
      ["/blog/index.html", [200, "<h1>blog</h1>"]],
    ],
  }
  for (const [mode, rows] of Object.entries(table) as [HtmlHandling, [string, unknown[]][]][]) {
    describe(mode, () => {
      for (const [path, want] of rows) {
        it(`${path} → ${want.join(" ")}`, async () => {
          const s = await open(DIR, { html: mode })
          expect(await resolveAs(s, path)).toEqual(want)
        })
      }
    })
  }

  it("keeps the query string on canonical 307s", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/about.html?x=1&y=2"), { hasWorker: false })
    expect(r.kind).toBe("redirect")
    expect(r.rule).toBe("html_handling")
    expect(r.response!.headers.get("location")).toBe("/about?x=1&y=2")
  })

  it("collapses repeated slashes with a 307", async () => {
    const s = await open(DIR)
    expect(await resolveAs(s, "//blog//post")).toEqual([307, "/blog/post"])
  })

  it("decodes percent-encoding and never resolves dot segments", async () => {
    const s = await open(DIR)
    expect(await resolveAs(s, "/%61bout")).toEqual([200, "<h1>about</h1>"])
    expect(await resolveAs(s, "/blog/%2e%2e/secret.txt")).toEqual([404, ""])
    expect(normalizePath("/a/%2e%2e/b")).toBeNull()
    expect(normalizePath("/a%00")).toBeNull()
  })
})

describe("not_found_handling", () => {
  it("none: empty 404", async () => {
    const s = await open(DIR, { notFound: "none" })
    const r = await s.route(req("/nope"), { hasWorker: false })
    expect(r.kind).toBe("notfound")
    expect(r.response!.status).toBe(404)
    expect(await text(r.response)).toBe("")
  })

  it("404-page: nearest 404.html walking up, with status 404", async () => {
    const s = await open(DIR, { notFound: "404-page" })
    expect(await resolveAs(s, "/nope")).toEqual([404, "<h1>root 404</h1>"])
    expect(await resolveAs(s, "/docs/nope")).toEqual([404, "<h1>docs 404</h1>"])
    expect(await resolveAs(s, "/docs/guide/deep/nope")).toEqual([404, "<h1>docs 404</h1>"])
    expect(await resolveAs(s, "/blog/nope")).toEqual([404, "<h1>root 404</h1>"])
    const r = await s.route(req("/docs/x"), { hasWorker: false })
    expect(r.kind).toBe("notfound")
    expect(r.rule).toBe("404-page")
    expect(r.response!.headers.get("content-type")).toBe("text/html; charset=utf-8")
  })

  it("404-page never answers 304 for the 404 body", async () => {
    const s = await open(DIR, { notFound: "404-page" })
    const first = await s.route(req("/nope"), { hasWorker: false })
    const etag = first.response!.headers.get("etag")!
    const again = await s.route(req("/nope", { headers: { "If-None-Match": etag } }), { hasWorker: false })
    expect(again.response!.status).toBe(404)
  })

  it("single-page-application: index.html with 200 for unknown paths", async () => {
    const s = await open(DIR, { notFound: "single-page-application" })
    expect(await resolveAs(s, "/app/settings/profile")).toEqual([200, "<h1>home</h1>"])
    expect(await resolveAs(s, "/about")).toEqual([200, "<h1>about</h1>"])
  })

  it("with a worker, misses go to the worker (not_found_handling applies only without one)", async () => {
    for (const notFound of ["none", "404-page", "single-page-application"] as NotFoundHandling[]) {
      const s = await open(DIR, { notFound })
      expect((await s.route(req("/nope"), { hasWorker: true })).kind).toBe("worker")
    }
  })

  it("SPA + worker: navigations get index.html without the worker", async () => {
    const s = await open(DIR, { notFound: "single-page-application" })
    const nav = await s.route(req("/dashboard", { navigate: true }), { hasWorker: true })
    expect(nav.kind).toBe("asset")
    expect(nav.rule).toBe("spa-navigate")
    expect(await text(nav.response)).toBe("<h1>home</h1>\n")
    expect((await s.route(req("/dashboard"), { hasWorker: true })).kind).toBe("worker")
    expect((await s.route(req("/dashboard", { navigate: true, method: "POST" }), { hasWorker: true })).kind).toBe("worker")
  })

  it("404-page + worker: navigations still go to the worker", async () => {
    const s = await open(DIR, { notFound: "404-page" })
    expect((await s.route(req("/dashboard", { navigate: true }), { hasWorker: true })).kind).toBe("worker")
  })
})

describe("run_worker_first: SPA with an API", () => {
  const spa = (rwf: boolean | string[]) => open(DIR, { notFound: "single-page-application", runWorkerFirst: rwf })

  it("an /api/* navigation goes to the worker, not index.html", async () => {
    const s = await spa(["/api/*"])
    const r = await s.route(req("/api/me", { navigate: true }), { hasWorker: true })
    expect(r).toEqual({ kind: "worker", rule: "worker-first:/api/*" })
  })

  it("an /api/* fetch goes to the worker", async () => {
    const s = await spa(["/api/*"])
    expect((await s.route(req("/api/me"), { hasWorker: true })).kind).toBe("worker")
    expect((await s.route(req("/api/me?x=1", { method: "POST", body: "{}" }), { hasWorker: true })).kind).toBe("worker")
  })

  it("an /api/* path that matches a real file still goes to the worker", async () => {
    const s = await spa(["/api/*"])
    const r = await s.route(req("/api/status.json"), { hasWorker: true })
    expect(r.kind).toBe("worker")
    expect(r.rule).toBe("worker-first:/api/*")
  })

  it("runs before _redirects", async () => {
    const s = await spa(["/api/*"])
    expect((await s.route(req("/api/redir"), { hasWorker: true })).kind).toBe("worker")
    const plain = await spa(false)
    expect((await plain.route(req("/api/redir"), { hasWorker: true })).kind).toBe("redirect")
  })

  it("a negated subpath goes back to the assets", async () => {
    const s = await spa(["/api/*", "!/api/docs/*"])
    const docs = await s.route(req("/api/docs/", { navigate: true }), { hasWorker: true })
    expect(docs.kind).toBe("asset")
    expect(await text(docs.response)).toBe("<h1>api docs</h1>\n")
    // A missing negated path is an ordinary miss: SPA navigation gets the shell.
    const nav = await s.route(req("/api/docs/missing", { navigate: true }), { hasWorker: true })
    expect(nav.rule).toBe("spa-navigate")
    expect((await s.route(req("/api/users"), { hasWorker: true })).kind).toBe("worker")
  })

  it("non-/api navigations still get index.html", async () => {
    const s = await spa(["/api/*"])
    const r = await s.route(req("/settings", { navigate: true }), { hasWorker: true })
    expect(r.kind).toBe("asset")
    expect(await text(r.response)).toBe("<h1>home</h1>\n")
    expect((await s.route(req("/about"), { hasWorker: true })).kind).toBe("asset")
  })

  it("true sends everything to the worker, real files included", async () => {
    const s = await spa(true)
    for (const p of ["/", "/about", "/app.js", "/anything"]) {
      expect(await s.route(req(p, { navigate: true }), { hasWorker: true })).toEqual({ kind: "worker", rule: "worker-first" })
    }
  })

  it("true still leaves env.ASSETS.fetch serving files", async () => {
    const s = await spa(true)
    const res = await s.fetchAsset(req("/about"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("<h1>about</h1>\n")
    expect((await s.fetchAsset(ORIGIN + "/api/status.json")).status).toBe(200)
  })

  it("false keeps every path asset-first", async () => {
    const s = await spa(false)
    const r = await s.route(req("/api/status.json"), { hasWorker: true })
    expect(r.kind).toBe("asset")
    const nav = await s.route(req("/api/me", { navigate: true }), { hasWorker: true })
    expect(nav.rule).toBe("spa-navigate") // the trap run_worker_first exists to avoid
  })

  it("patterns with no worker are a config error (500), never a silent asset fallback", async () => {
    const s = await spa(["/api/*"])
    const r = await s.route(req("/api/status.json"), { hasWorker: false })
    expect(r.kind).toBe("notfound")
    expect(r.rule).toBe("worker-first:/api/*")
    expect(r.response!.status).toBe(500)
    expect((await s.route(req("/about"), { hasWorker: false })).response!.status).toBe(200)
  })

  it("matches on the path only: * crosses /, no * is exact, exclusions win", () => {
    expect(matchRunWorkerFirst(["/api/*"], "/api/a/b/c")).toBe("/api/*")
    expect(matchRunWorkerFirst(["/api/*"], "/api/")).toBe("/api/*")
    expect(matchRunWorkerFirst(["/api/*"], "/api")).toBeNull()
    expect(matchRunWorkerFirst(["/api/*"], "/apiary")).toBeNull()
    expect(matchRunWorkerFirst(["/login"], "/login")).toBe("/login")
    expect(matchRunWorkerFirst(["/login"], "/login/")).toBeNull()
    expect(matchRunWorkerFirst(["/*.json"], "/a/b.json")).toBe("/*.json")
    expect(matchRunWorkerFirst(["!/api/docs/*", "/api/*"], "/api/docs/x")).toBeNull()
    expect(matchRunWorkerFirst(["/api/*", "!/api/docs/*"], "/api/docs/")).toBeNull()
    expect(matchRunWorkerFirst(["!/x"], "/y")).toBeNull()
    expect(matchRunWorkerFirst(true, "/x")).toBe("true")
    expect(matchRunWorkerFirst(false, "/x")).toBeNull()
  })

  it("ignores the query and can't be dodged with percent-encoding", async () => {
    const s = await spa(["/api/*"])
    expect((await s.route(req("/api/x?y=/z"), { hasWorker: true })).kind).toBe("worker")
    expect((await s.route(req("/%61pi/status.json"), { hasWorker: true })).kind).toBe("worker")
    expect((await s.route(req("//api/status.json"), { hasWorker: true })).kind).toBe("worker")
  })

  it("validation: bad patterns are errors, not warnings", () => {
    expect(validateRunWorkerFirst(["/api/*", "!/api/docs/*"])).toEqual(["/api/*", "!/api/docs/*"])
    expect(() => validateRunWorkerFirst(["api/*"])).toThrow(/invalid pattern/)
    expect(() => validateRunWorkerFirst(["!api"])).toThrow(/invalid pattern/)
    expect(() => validateRunWorkerFirst([42])).toThrow(/invalid pattern/)
    expect(() => validateRunWorkerFirst("/api/*")).toThrow(/boolean or an array/)
    expect(() => validateRunWorkerFirst(Array.from({ length: 101 }, (_, i) => `/p${i}`))).toThrow(/max 100/)
    expect(() => loadAssetsConfig({ directory: ".", run_worker_first: ["/ok", "bad"] }, DIR)).toThrow(/"bad"/)
  })
})

describe("_redirects", () => {
  it("parses rules, defaults to 302 and reports bad lines", () => {
    const { rules, warnings } = parseRedirects(readFileSync(join(FIXTURE, "_redirects"), "utf8"))
    expect(rules.find(r => r.from === "/home")).toMatchObject({ to: "/", status: 302 })
    expect(rules.find(r => r.from === "/old")).toMatchObject({ to: "/about", status: 301, line: 2 })
    expect(warnings.some(w => w.includes("/bad-line") || w.includes(":12:"))).toBe(true)
    expect(warnings.some(w => w.includes("418"))).toBe(true)
    expect(warnings.some(w => w.includes("domain-level"))).toBe(true)
  })

  it("enforces limits: 2000 static, 100 dynamic, 1000 chars, no duplicate static", () => {
    const lines = [
      ...Array.from({ length: 2001 }, (_, i) => `/s${i} /t`),
      ...Array.from({ length: 101 }, (_, i) => `/d${i}/* /t`),
      `/long /${"x".repeat(1000)}`,
      "/s0 /other",
    ]
    const { rules, warnings } = parseRedirects(lines.join("\n"))
    expect(rules.filter(r => r.from.startsWith("/s")).length).toBe(2000)
    expect(rules.filter(r => r.from.startsWith("/d")).length).toBe(100)
    expect(rules.some(r => r.from === "/long")).toBe(false)
    expect(warnings.some(w => w.includes("duplicate"))).toBe(true)
    expect(warnings.some(w => w.includes("static rule limit"))).toBe(true)
    expect(warnings.some(w => w.includes("dynamic rule limit"))).toBe(true)
  })

  it("rejects 200 rewrites to other origins", () => {
    expect(parseRedirects("/x https://evil.test/ 200").warnings[0]).toMatch(/same site/)
    expect(parseRedirects("/x https://ok.test/ 301").rules).toHaveLength(1)
  })

  it("redirects with status and passes the query through", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/old?a=1"), { hasWorker: false })
    expect(r.kind).toBe("redirect")
    expect(r.response!.status).toBe(301)
    expect(r.response!.headers.get("location")).toBe("/about?a=1")
    expect(r.rule).toBe("/old /about 301")
    expect(await resolveAs(s, "/home")).toEqual([302, "/"])
  })

  it("keeps a query in the destination instead of the request's", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/q?z=9"), { hasWorker: false })
    expect(r.response!.headers.get("location")).toBe("/about?from=q")
  })

  it("placeholders and splats", async () => {
    const s = await open(DIR)
    expect(await resolveAs(s, "/blog/post/old")).toEqual([308, "/blog/post"])
    expect(await resolveAs(s, "/news/2024/hello")).toEqual([302, "/blog/2024/hello"])
  })

  it("static rules win over dynamic ones regardless of order", async () => {
    const dir = site()
    writeFileSync(join(dir, "_redirects"), "/a/* /dynamic 302\n/a/b /static 302\n")
    const s = await open(dir)
    expect(await resolveAs(s, "/a/b")).toEqual([302, "/static"])
    expect(await resolveAs(s, "/a/c")).toEqual([302, "/dynamic"])
  })

  it("apply before assets", async () => {
    const dir = site()
    writeFileSync(join(dir, "_redirects"), "/about /blog/ 301\n")
    const s = await open(dir)
    expect(await resolveAs(s, "/about")).toEqual([301, "/blog/"])
  })

  it("200 rewrites serve the target asset at the original URL", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/shop/cart/items"), { hasWorker: false })
    expect(r.kind).toBe("rewrite")
    expect(r.rule).toBe("/shop/* /index.html 200")
    expect(r.response!.status).toBe(200)
    expect(await text(r.response)).toBe("<h1>home</h1>\n")
    expect(r.response!.headers.get("x-frame-options")).toBe("DENY") // _headers by the original URL
    const about = await s.route(req("/rewrite-about"), { hasWorker: false })
    expect(await text(about.response)).toBe("<h1>about</h1>\n")
  })

  it("a 200 rewrite to a non-asset path goes to the worker with the rewritten request", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/fn/a/b?x=1"), { hasWorker: true })
    expect(r.kind).toBe("worker")
    expect(r.rule).toBe("/fn/* /dynamic/:splat 200")
    expect(r.request!.url).toBe(`${ORIGIN}/dynamic/a/b?x=1`)
  })

  it("a 200 rewrite to a non-asset path without a worker is a 404", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/fn/a"), { hasWorker: false })
    expect(r.kind).toBe("notfound")
    expect(r.response!.status).toBe(404)
  })

  it("a rule that redirects to itself is skipped", async () => {
    const s = await open(DIR)
    expect(await resolveAs(s, "/loop")).toEqual([404, ""])
  })

  it("edits apply on the next request in dev (no watcher)", async () => {
    const dir = site()
    const s = await open(dir)
    expect(await resolveAs(s, "/fresh")).toEqual([404, ""])
    writeFileSync(join(dir, "_redirects"), "/fresh /about 301\n# changed size\n")
    expect(await resolveAs(s, "/fresh")).toEqual([301, "/about"])
  })
})

describe("_headers", () => {
  it("parses patterns, values and detaches, with warnings for bad lines", () => {
    const { rules, warnings } = parseHeaders("  X-Orphan: 1\n/a\n  X-A: 1\n  ! X-B\n  bad line\nnot-a-path\n  X-C: 2\n")
    expect(rules).toEqual([{ pattern: "/a", set: [["X-A", "1"]], unset: ["X-B"], line: 2 }])
    expect(warnings.length).toBe(3)
  })

  it("limits rules to 100", () => {
    const t = Array.from({ length: 101 }, (_, i) => `/p${i}\n  X: ${i}`).join("\n")
    const { rules, warnings } = parseHeaders(t)
    expect(rules.length).toBe(100)
    expect(warnings[0]).toMatch(/100 rule limit/)
  })

  it("merges matching rules, joins repeats with ', ', detaches earlier ones", async () => {
    const s = await open(DIR)
    const blog = (await s.route(req("/blog/post"), { hasWorker: false })).response!
    expect(blog.headers.get("x-multi")).toBe("a, b")
    expect(blog.headers.get("x-frame-options")).toBeNull()
    expect(blog.headers.get("x-slug")).toBe("post")
    const about = (await s.route(req("/about"), { hasWorker: false })).response!
    expect(about.headers.get("x-frame-options")).toBe("DENY")
    expect(about.headers.get("x-multi")).toBe("a")
  })

  it("a rule replaces a default header like Cache-Control", async () => {
    const s = await open(DIR)
    const js = (await s.route(req("/app.js"), { hasWorker: false })).response!
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  })

  it("host patterns with placeholders", async () => {
    const s = await open(DIR)
    const r = (await s.route(req("https://shop.example.test/about"), { hasWorker: false })).response!
    expect(r.headers.get("x-sub")).toBe("shop")
    expect((await s.route(req("/about"), { hasWorker: false })).response!.headers.get("x-sub")).toBeNull()
  })

  it("applies to 404 pages but not to redirects or worker responses", async () => {
    const s = await open(DIR, { notFound: "404-page" })
    const nf = (await s.route(req("/nope"), { hasWorker: false })).response!
    expect(nf.headers.get("x-frame-options")).toBe("DENY")
    const redir = (await s.route(req("/old"), { hasWorker: false })).response!
    expect(redir.headers.get("x-frame-options")).toBeNull()
    expect((await s.route(req("/nope"), { hasWorker: true })).response).toBeUndefined()
  })
})

describe(".assetsignore", () => {
  it("gitignore syntax", () => {
    const ig = parseAssetsIgnore("# c\n*.log\n/root-only.txt\nbuild/\n!keep.log\ndocs/**/draft-*.md\n\\#hash\nsrc/*.map\n")
    expect(ig("a.log")).toBe(true)
    expect(ig("deep/x/a.log")).toBe(true)
    expect(ig("keep.log")).toBe(false)
    expect(ig("root-only.txt")).toBe(true)
    expect(ig("sub/root-only.txt")).toBe(false)
    expect(ig("build/a.js")).toBe(true)
    expect(ig("x/build/a.js")).toBe(true)
    expect(ig("build")).toBe(false) // dir-only pattern doesn't hit a file named build
    expect(ig("docs/draft-1.md")).toBe(true)
    expect(ig("docs/a/b/draft-1.md")).toBe(true)
    expect(ig("#hash")).toBe(true)
    expect(ig("src/a.map")).toBe(true)
    expect(ig("src/x/a.map")).toBe(false)
    expect(ig("index.html")).toBe(false)
  })

  it("can't re-include a file under an ignored directory", () => {
    const ig = parseAssetsIgnore("build/\n!build/keep.js\n")
    expect(ig("build/keep.js")).toBe(true)
  })

  it("ignored files and control files are never served", async () => {
    const s = await open(DIR, { notFound: "none", html: "none" })
    for (const p of ["/secret.txt", "/debug.log", "/drafts/wip.html", "/_headers", "/_redirects", "/.assetsignore"]) {
      expect(await resolveAs(s, p)).toEqual([404, ""])
    }
    expect(await resolveAs(s, "/nested/_headers")).toEqual([200, "nested control file name is an ordinary asset"])
  })
})

describe("responses", () => {
  it("content types", () => {
    expect(contentTypeFor("/a.html")).toBe("text/html; charset=utf-8")
    expect(contentTypeFor("/a.js")).toBe("application/javascript; charset=utf-8")
    expect(contentTypeFor("/a.json")).toBe("application/json; charset=utf-8")
    expect(contentTypeFor("/a.css")).toBe("text/css; charset=utf-8")
    expect(contentTypeFor("/a.PNG")).toBe("image/png")
    expect(contentTypeFor("/a.woff2")).toBe("font/woff2")
    expect(contentTypeFor("/a.bin")).toBe("application/octet-stream")
    expect(contentTypeFor("/.env")).toBe("application/octet-stream")
  })

  it("strong ETag, Cache-Control default, Content-Length", async () => {
    const s = await open(DIR)
    const r = (await s.route(req("/style.css"), { hasWorker: false })).response!
    const body = "body{color:red}\n"
    const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)
    expect(r.headers.get("etag")).toBe(`"${hash}"`)
    expect(r.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate")
    expect(r.headers.get("content-length")).toBe(String(body.length))
    expect(r.headers.get("content-type")).toBe("text/css; charset=utf-8")
  })

  it("If-None-Match → 304 (strong, weak, list, *)", async () => {
    const s = await open(DIR)
    const etag = (await s.route(req("/style.css"), { hasWorker: false })).response!.headers.get("etag")!
    for (const inm of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const r = (await s.route(req("/style.css", { headers: { "If-None-Match": inm } }), { hasWorker: false })).response!
      expect(r.status).toBe(304)
      expect(r.headers.get("etag")).toBe(etag)
      expect(await r.text()).toBe("")
    }
    const miss = (await s.route(req("/style.css", { headers: { "If-None-Match": '"nope"' } }), { hasWorker: false })).response!
    expect(miss.status).toBe(200)
  })

  it("skips Cache-Control with Authorization", async () => {
    const s = await open(DIR)
    const r = (await s.route(req("/style.css", { headers: { Authorization: "Bearer x" } }), { hasWorker: false })).response!
    expect(r.headers.get("cache-control")).toBeNull()
  })

  it("HEAD has headers and no body", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/blob.bin", { method: "HEAD" }), { hasWorker: false })
    expect(r.kind).toBe("asset")
    expect(r.response!.status).toBe(200)
    expect(r.response!.headers.get("content-length")).toBe("10")
    expect(await r.response!.text()).toBe("")
  })

  it("single Range → 206, suffix and open ranges, 416, multi-range → 200", async () => {
    const s = await open(DIR)
    const get = async (range: string) => (await s.route(req("/blob.bin", { headers: { Range: range } }), { hasWorker: false })).response!
    let r = await get("bytes=2-5")
    expect(r.status).toBe(206)
    expect(r.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(r.headers.get("content-length")).toBe("4")
    expect(r.headers.get("cache-control")).toBeNull()
    expect(await r.text()).toBe("2345")
    r = await get("bytes=-3")
    expect(await r.text()).toBe("789")
    r = await get("bytes=7-")
    expect(await r.text()).toBe("789")
    r = await get("bytes=8-100")
    expect(r.headers.get("content-range")).toBe("bytes 8-9/10")
    r = await get("bytes=20-30")
    expect(r.status).toBe(416)
    expect(r.headers.get("content-range")).toBe("bytes */10")
    r = await get("bytes=0-1,4-5")
    expect(r.status).toBe(200)
    expect(await r.text()).toBe("0123456789")
  })

  it("methods: 405 without a worker, worker with one", async () => {
    const s = await open(DIR)
    const r = await s.route(req("/about", { method: "POST", body: "x" }), { hasWorker: false })
    expect(r.response!.status).toBe(405)
    expect(r.response!.headers.get("allow")).toBe("GET, HEAD")
    expect((await s.route(req("/missing", { method: "DELETE" }), { hasWorker: false })).response!.status).toBe(404)
    expect((await s.route(req("/about", { method: "POST", body: "x" }), { hasWorker: true })).kind).toBe("worker")
  })

  it("streams large files without changing their bytes", async () => {
    const dir = site()
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 7)
    writeFileSync(join(dir, "big.bin"), big)
    const s = await open(dir)
    const r = (await s.route(req("/big.bin"), { hasWorker: false })).response!
    expect(r.headers.get("content-length")).toBe(String(big.length))
    expect(new Uint8Array(await r.arrayBuffer()).length).toBe(big.length)
  })
})

describe("safety", () => {
  it("refuses symlinks that escape the asset directory, allows ones inside", async () => {
    const s = await open(DIR, { html: "none" }, { index: true })
    expect(await resolveAs(s, "/escape.html")).toEqual([404, ""])
    expect(await resolveAs(s, "/escdir/secret.html")).toEqual([404, ""])
    expect(await resolveAs(s, "/inside-link.html")).toEqual([200, "<h1>about</h1>"])
    expect(s.warnings.some(w => w.includes("/escape.html") && w.includes("symlink"))).toBe(true)
  })

  it("canRead gates every file", async () => {
    const s = await open(DIR, {}, { canRead: p => !p.endsWith("about.html") })
    expect(await resolveAs(s, "/about")).toEqual([404, ""])
    expect(await resolveAs(s, "/blog/")).toEqual([200, "<h1>blog</h1>"])
  })

  it("canRead hides an unreadable _redirects", async () => {
    const s = await open(DIR, {}, { canRead: p => !p.endsWith("_redirects") })
    expect(await resolveAs(s, "/old")).toEqual([404, ""])
    expect(s.warnings.some(w => w.includes("_redirects is not readable"))).toBe(true)
  })

  it("modeAllows: owner, then group, then other bits", () => {
    const st = (mode: number) => ({ uid: 1000, gid: 100, mode })
    expect(modeAllows(st(0o400), 1000, [], 4)).toBe(true)
    expect(modeAllows(st(0o044), 1000, [100], 4)).toBe(false) // owner bits win for the owner
    expect(modeAllows(st(0o040), 2000, [100], 4)).toBe(true)
    expect(modeAllows(st(0o004), 2000, [100], 4)).toBe(false) // group bits win for a member
    expect(modeAllows(st(0o004), 2000, [5], 4)).toBe(true)
    expect(modeAllows(st(0o001), 2000, [], 1)).toBe(true)
    expect(modeAllows(st(0o004), 2000, [], 1)).toBe(false)
  })

  it("userCanRead checks the file's read bit and every parent's search bit", () => {
    const dir = mkdtempSync(join(BASE, "perm-"))
    const sub = join(dir, "sub")
    mkdirSync(sub)
    const f = join(sub, "f.txt")
    writeFileSync(f, "x")
    const me = process.getuid!()
    const other = me + 12345
    chmodSync(f, 0o600)
    expect(userCanRead(f, me, [])).toBe(true)
    expect(userCanRead(f, other, [])).toBe(false)
    chmodSync(f, 0o644)
    // Readable by others only if no ancestor (e.g. a 0700 /tmp/claude-<uid>) blocks the search.
    const chain: string[] = []
    for (let d = sub; d !== "/"; d = join(d, "..")) chain.push(d)
    const open = chain.every(d => (statSync(d).mode & 0o001) !== 0)
    expect(userCanRead(f, other, [])).toBe(open)
    chmodSync(sub, 0o700)
    expect(userCanRead(f, other, [])).toBe(false)
    expect(userCanRead(f, me, [])).toBe(true)
    chmodSync(sub, 0o755)
    chmodSync(f, 0o044)
    expect(userCanRead(f, me, [])).toBe(false)
    expect(userCanRead(join(dir, "nope"), me, [])).toBe(false)
    expect(userCanRead(sub, me, [])).toBe(false) // directories aren't files
    expect(userCanRead(f, 0, [])).toBe(true)
  })

  it("userCanRead follows symlinks but checks the target too", () => {
    const dir = mkdtempSync(join(BASE, "perm-link-"))
    writeFileSync(join(dir, "t.txt"), "x")
    chmodSync(join(dir, "t.txt"), 0o000)
    symlinkSync(join(dir, "t.txt"), join(dir, "l.txt"))
    expect(userCanRead(join(dir, "l.txt"), process.getuid!(), [])).toBe(false)
  })
})

describe("dev index", () => {
  it("lazy stat: new, changed and deleted files show up on the next request", async () => {
    const dir = site()
    const s = await open(dir)
    expect(await resolveAs(s, "/new")).toEqual([404, ""])
    writeFileSync(join(dir, "new.html"), "v1")
    expect(await resolveAs(s, "/new")).toEqual([200, "v1"])
    const e1 = (await s.route(req("/new"), { hasWorker: false })).response!.headers.get("etag")
    writeFileSync(join(dir, "new.html"), "version 2")
    const r2 = (await s.route(req("/new"), { hasWorker: false })).response!
    expect(await r2.text()).toBe("version 2")
    expect(r2.headers.get("etag")).not.toBe(e1)
    rmSync(join(dir, "new.html"))
    expect(await resolveAs(s, "/new")).toEqual([404, ""])
  })

  it("the watcher rebuilds the index after a debounce", async () => {
    const dir = site()
    const s = await open(dir, {}, { index: true, watch: true })
    expect(s.files().some(f => f.path === "/later.txt")).toBe(false)
    expect(s.files().some(f => f.path === "/about.html" && f.hash)).toBe(true)
    writeFileSync(join(dir, "later.txt"), "hi")
    for (let i = 0; i < 40 && !s.files().some(f => f.path === "/later.txt"); i++) await Bun.sleep(25)
    expect(s.files().some(f => f.path === "/later.txt")).toBe(true)
    s.close()
  })

  it("index excludes ignored, control and escaping files", async () => {
    const s = await open(DIR, {}, { index: true })
    const paths = s.files().map(f => f.path)
    expect(paths).toContain("/inside-link.html")
    expect(paths).toContain("/nested/_headers")
    for (const p of ["/secret.txt", "/debug.log", "/drafts/wip.html", "/_headers", "/_redirects", "/.assetsignore", "/escape.html", "/escdir/secret.html"]) {
      expect(paths).not.toContain(p)
    }
  })

  it("oversized files are skipped with a warning", async () => {
    const dir = site()
    writeFileSync(join(dir, "huge.bin"), "")
    const fd = Bun.file(join(dir, "huge.bin"))
    await Bun.write(fd, new Uint8Array(25 * 1024 * 1024 + 1))
    const s = await open(dir, { html: "none" }, { index: true })
    expect(await resolveAs(s, "/huge.bin")).toEqual([404, ""])
    expect(s.warnings.some(w => w.includes("huge.bin"))).toBe(true)
    await expect(snapshotAssets(cfgFor(dir), join(mkdtempSync(join(BASE, "snap-")), "assets"))).rejects.toThrow(/byte limit/)
  })
})

describe("snapshotAssets", () => {
  it("writes a read-only filtered copy and a manifest, and serves the same from it", async () => {
    const dest = join(mkdtempSync(join(BASE, "deploy-")), "assets")
    const cfg = cfgFor(DIR, { notFound: "404-page" })
    const out = await snapshotAssets(cfg, dest)
    expect(out.manifestPath).toBe(join(dest, "..", "assets-manifest.json"))
    const m = JSON.parse(readFileSync(out.manifestPath, "utf8"))
    expect(m.files["/about.html"]).toMatchObject({ size: 15, type: "text/html; charset=utf-8" })
    expect(m.files["/about.html"].hash).toHaveLength(32)
    expect(m.files["/inside-link.html"]).toBeDefined()
    for (const p of ["/secret.txt", "/_redirects", "/_headers", "/.assetsignore", "/escape.html", "/drafts/wip.html"]) expect(m.files[p]).toBeUndefined()
    expect(m.redirects.some((r: { from: string }) => r.from === "/old")).toBe(true)
    expect(m.headers.length).toBe(5)
    expect(out.files).toBe(Object.keys(m.files).length)
    expect(out.bytes).toBeGreaterThan(0)
    expect(existsSync(join(dest, "_redirects"))).toBe(false)
    expect(existsSync(join(dest, "secret.txt"))).toBe(false)
    expect(statSync(join(dest, "about.html")).mode & 0o777).toBe(0o444)
    expect(statSync(join(dest, "blog")).mode & 0o777).toBe(0o555)
    expect(statSync(dest).mode & 0o777).toBe(0o555)
    expect(statSync(join(dest, "inside-link.html")).isFile()).toBe(true)

    const snap = await AssetServer.open({ ...cfg, directory: dest }, { mode: "snapshot" })
    servers.push(snap)
    const dev = await open(DIR, { notFound: "404-page" })
    for (const p of ["/", "/about", "/about.html", "/blog", "/blog/post/old", "/news/x", "/nope", "/docs/nope", "/secret.txt", "/shop/x"]) {
      expect(await resolveAs(snap, p)).toEqual(await resolveAs(dev, p))
    }
    const a = (await snap.route(req("/blog/post"), { hasWorker: false })).response!
    const b = (await dev.route(req("/blog/post"), { hasWorker: false })).response!
    expect([...a.headers]).toEqual([...b.headers])
  })

  it("refuses a non-empty destination", async () => {
    const dest = mkdtempSync(join(BASE, "full-"))
    writeFileSync(join(dest, "x"), "x")
    await expect(snapshotAssets(cfgFor(DIR), dest)).rejects.toThrow(/not empty/)
  })
})

// In root mode the function's user owns deploys/, so a snapshot must be checked like dev at serve time.
describe("snapshot tampering", () => {
  const FIX = "/tmp/claude-1000/candy-fn-build/assets-fix/tamper"
  mkdirSync(FIX, { recursive: true })
  const snapshot = async (opts: { canRead?(p: string): boolean } = {}) => {
    const dest = join(mkdtempSync(join(FIX, "deploy-")), "assets")
    await snapshotAssets(cfgFor(DIR, { html: "none" }), dest)
    // Make the read-only copy editable, as its owner could.
    for (const d of [dest, join(dest, "blog")]) chmodSync(d, 0o755)
    const s = await AssetServer.open(cfgFor(dest, { html: "none" }), { mode: "snapshot", ...opts })
    servers.push(s)
    const outside = mkdtempSync(join(FIX, "victim-"))
    writeFileSync(join(outside, "shadow"), "root:secret")
    mkdirSync(join(outside, "blog"))
    writeFileSync(join(outside, "blog", "post.html"), "outside post")
    return { dest, s, outside }
  }

  it("serves an untouched snapshot", async () => {
    const { s } = await snapshot()
    expect(await resolveAs(s, "/about.html")).toEqual([200, "<h1>about</h1>"])
    expect(await resolveAs(s, "/blog/post.html")).toEqual([200, (readFileSync(join(FIXTURE, "blog", "post.html"), "utf8")).trim()])
  })

  it("refuses a file replaced by a symlink out of the directory", async () => {
    const { dest, s, outside } = await snapshot()
    rmSync(join(dest, "about.html"), { force: true })
    symlinkSync(join(outside, "shadow"), join(dest, "about.html"))
    expect(await resolveAs(s, "/about.html")).toEqual([404, ""])
  })

  it("refuses a parent directory replaced by a symlink out of the directory", async () => {
    const { dest, s, outside } = await snapshot()
    chmodSync(join(dest, "blog"), 0o755)
    rmSync(join(dest, "blog"), { recursive: true, force: true })
    symlinkSync(join(outside, "blog"), join(dest, "blog"))
    expect(await resolveAs(s, "/blog/post.html")).toEqual([404, ""])
  })

  it("refuses a file replaced after the snapshot, bigger or same size", async () => {
    const { dest, s } = await snapshot()
    rmSync(join(dest, "about.html"), { force: true })
    writeFileSync(join(dest, "about.html"), "<h1>about</h1> and much more")
    expect(await resolveAs(s, "/about.html")).toEqual([404, ""])
    rmSync(join(dest, "about.html"), { force: true })
    writeFileSync(join(dest, "about.html"), "<h1>ABOUT</h1>\n") // same 15 bytes, other content
    expect(await resolveAs(s, "/about.html")).toEqual([404, ""])
    rmSync(join(dest, "about.html"), { force: true })
    writeFileSync(join(dest, "about.html"), "<h1>about</h1>\n") // the deployed bytes again
    expect(await resolveAs(s, "/about.html")).toEqual([200, "<h1>about</h1>"])
  })

  it("refuses a swap between lookup and serve (fd is checked, not the path)", async () => {
    let swap: (() => void) | null = null
    const { dest, s, outside } = await snapshot({ canRead: () => {
      const f = swap
      swap = null
      f?.()
      return true
    } })
    swap = () => {
      rmSync(join(dest, "about.html"), { force: true })
      symlinkSync(join(outside, "shadow"), join(dest, "about.html"))
    }
    expect(await resolveAs(s, "/about.html")).toEqual([404, ""])
    swap = () => {
      rmSync(join(dest, "blog"), { recursive: true, force: true })
      symlinkSync(join(outside, "blog"), join(dest, "blog"))
    }
    expect(await resolveAs(s, "/blog/post.html")).toEqual([404, ""])
  })

  it("applies canRead in snapshot mode", async () => {
    const { s } = await snapshot({ canRead: p => !p.endsWith("about.html") })
    expect(await resolveAs(s, "/about.html")).toEqual([404, ""])
    expect((await resolveAs(s, "/index.html"))[0]).toBe(200)
  })

  it("ignores malformed manifest entries", async () => {
    const { dest } = await snapshot()
    const mp = join(dest, "..", "assets-manifest.json")
    const m = JSON.parse(readFileSync(mp, "utf8"))
    chmodSync(mp, 0o644)
    m.files["/../../etc/passwd"] = { hash: "x", size: 1, type: "text/plain" }
    m.files["/about.html"].type = "text/html; evil"
    writeFileSync(mp, JSON.stringify(m))
    const s = await AssetServer.open(cfgFor(dest, { html: "none" }), { mode: "snapshot" })
    servers.push(s)
    expect(s.files().map(f => f.path)).not.toContain("/../../etc/passwd")
    const r = (await s.route(req("/about.html"), { hasWorker: false })).response!
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8")
  })
})

describe("loadAssetsConfig", () => {
  it("defaults and resolution", () => {
    const { config, warnings } = loadAssetsConfig({ directory: "./fn-assets" }, join(import.meta.dir, "fixtures"))
    expect(config).toEqual({ directory: FIXTURE, binding: null, notFound: "none", html: "auto-trailing-slash", runWorkerFirst: false })
    expect(warnings).toEqual([])
  })

  it("all fields", () => {
    const { config } = loadAssetsConfig({ directory: FIXTURE, binding: "ASSETS", not_found_handling: "single-page-application", html_handling: "drop-trailing-slash", run_worker_first: ["/api/*"] }, "/")
    expect(config).toMatchObject({ binding: "ASSETS", notFound: "single-page-application", html: "drop-trailing-slash", runWorkerFirst: ["/api/*"] })
  })

  it("errors and warnings", () => {
    expect(() => loadAssetsConfig({}, "/")).toThrow(/directory is required/)
    expect(() => loadAssetsConfig(null, "/")).toThrow()
    expect(() => loadAssetsConfig({ directory: ".", binding: "bad-name" }, "/")).toThrow(/binding/)
    expect(() => loadAssetsConfig({ directory: ".", not_found_handling: "spa" }, "/")).toThrow(/not_found_handling/)
    expect(() => loadAssetsConfig({ directory: ".", html_handling: "auto" }, "/")).toThrow(/html_handling/)
    const { warnings } = loadAssetsConfig({ directory: "./missing", extra: 1 }, BASE)
    expect(warnings.some(w => w.includes("assets.extra"))).toBe(true)
    expect(warnings.some(w => w.includes("does not exist"))).toBe(true)
  })

  it("a missing directory is an empty asset set until it appears", async () => {
    const dir = join(mkdtempSync(join(BASE, "late-")), "dist")
    const s = await open(dir, { notFound: "single-page-application", runWorkerFirst: ["/api/*"] })
    expect(s.attached).toBe(false)
    expect((await s.route(req("/api/me"), { hasWorker: true })).kind).toBe("worker")
    expect((await s.route(req("/app", { navigate: true }), { hasWorker: true })).kind).toBe("worker")
    expect(await resolveAs(s, "/")).toEqual([404, ""])
    mkdirSync(dir)
    writeFileSync(join(dir, "index.html"), "built")
    writeFileSync(join(dir, "_redirects"), "/old /new 301\n")
    expect(await resolveAs(s, "/")).toEqual([200, "built"])
    expect(await resolveAs(s, "/old")).toEqual([301, "/new"])
    expect(s.attached).toBe(true)
  })

  it("a snapshot of a missing directory fails", async () => {
    await expect(snapshotAssets(cfgFor(join(BASE, "does-not-exist")), join(mkdtempSync(join(BASE, "snap-")), "assets"))).rejects.toThrow(/does not exist/)
  })
})

describe("pattern matching never backtracks", () => {
  const LONG = 64 * 1024
  const paths = ["/a".repeat(LONG / 2), "/" + "a".repeat(LONG - 1), "/" + "-".repeat(LONG - 1), "/" + "a-".repeat(LONG / 2 - 1) + "/x"]

  it("run_worker_first globs: a 64 KB path against worst-case patterns", () => {
    const rwf = ["/*/*/*/*.json", "/" + "*a".repeat(40) + "b", "/*-*-*-*-*-*-*-*-x", "!/*/*/*/*/*/*/*.php"]
    const t = performance.now()
    for (const p of paths) expect(matchRunWorkerFirst(rwf, p)).toBeNull()
    expect(performance.now() - t).toBeLessThan(50)
  })

  it("_redirects and _headers: a 64 KB path through route()", async () => {
    const dir = mkdtempSync(join(BASE, "redos-"))
    writeFileSync(join(dir, "index.html"), "x")
    // One splat each (more are refused) plus placeholders that would backtrack as [^/]+ regexes
    writeFileSync(join(dir, "_redirects"), [
      "/*/:a/:b/:c.php /legacy 301",
      "/:a-:b-:c-:d-:e-:f-x /legacy 301",
      "/*-:a-:b-:c-x /legacy 301",
      "/pre:a:b:c:d* /legacy 301",
    ].join("\n"))
    writeFileSync(join(dir, "_headers"), "/*-:a-:b-:c-:d-x\n  X: y\n/:a:b:c:d:e/*\n  X: z\n")
    const s = await open(dir, { runWorkerFirst: ["/*/*/*/*.json", "/" + "*a".repeat(40) + "b"] })
    const t = performance.now()
    for (const p of paths) {
      const r = await s.route(req(p), { hasWorker: false })
      expect(r.kind).toBe("notfound")
    }
    expect(performance.now() - t).toBeLessThan(50)
  })

  it("globMatch: literal prefix, suffix and ordered middles", () => {
    expect(globMatch("/api/*", "/api/x/y")).toBe(true)
    expect(globMatch("/api/*", "/api")).toBe(false) // literal: use ["/api", "/api/*"]
    expect(globMatch("/api/*", "/api/")).toBe(true)
    expect(globMatch("/*.json", "/a/b.json")).toBe(true)
    expect(globMatch("/a*b*c", "/abc")).toBe(true)
    expect(globMatch("/a*b*c", "/acb")).toBe(false)
    expect(globMatch("/a*a", "/a")).toBe(false) // prefix and suffix can't overlap
    expect(globMatch("/x", "/x")).toBe(true)
    expect(globMatch("/x", "/xy")).toBe(false)
  })

  it("compilePattern captures like the greedy regex it replaces", () => {
    expect(compilePattern("/blog/:year-:month/*")!("/blog/2024-01-02/a/b")).toEqual({ year: "2024-01", month: "02", splat: "a/b" })
    expect(compilePattern("/*/:id/edit")!("/a/b/7/edit")).toEqual({ splat: "a/b", id: "7" })
    expect(compilePattern("/*.json")!("/a/b.json")).toEqual({ splat: "a/b" })
    expect(compilePattern("/*")!("/")).toEqual({ splat: "" })
    expect(compilePattern("/x/:a")!("/x/")).toBeNull()
    expect(compilePattern("/x/:a")!("/x/a/b")).toBeNull()
    expect(compilePattern("/*/*")).toBeNull()
  })

  it("more than one * is a warning that drops the rule", () => {
    const r = parseRedirects("/*/*.php /x 301\n/ok/* /y 301")
    expect(r.rules.map(x => x.from)).toEqual(["/ok/*"])
    expect(r.warnings[0]).toMatch(/_redirects:1: more than one \*/)
    const h = parseHeaders("/*/*.css\n  X: 1\n/ok/*\n  Y: 2")
    expect(h.rules.map(x => x.pattern)).toEqual(["/ok/*"])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/_headers:1: more than one \*/)
  })
})

describe("splats are substituted encoded", () => {
  const siteWith = async (redirects: string, over: Partial<AssetsConfig> = {}) => {
    const dir = mkdtempSync(join(BASE, "splat-"))
    mkdirSync(join(dir, "api"))
    writeFileSync(join(dir, "index.html"), "<shell>")
    writeFileSync(join(dir, "api", "data.json"), "{}")
    writeFileSync(join(dir, "_redirects"), redirects)
    return open(dir, over)
  }

  it("no open redirect, no throw on non-ASCII or spaces", async () => {
    const s = await siteWith("/old/* /:splat 301\n/u/* /x/:splat 302\n/p* /:splat 301\n")
    expect(await resolveAs(s, "/old/%5Cevil.com")).toEqual([301, "/%5Cevil.com"])
    expect(await resolveAs(s, "/old/%E2%9C%93")).toEqual([301, "/%E2%9C%93"])
    expect(await resolveAs(s, "/u/a%20b")).toEqual([302, "/x/a%20b"])
    // A splat that starts with "/" can't make the path rule protocol-relative
    expect(await resolveAs(s, "/p/evil.com")).toEqual([301, "/evil.com"])
  })

  it("a rewrite never leaves the site", async () => {
    expect(parseRedirects("/x //evil.test/ 200").rules).toEqual([])
    // "/\\host" is "//host" to a URL parser
    const s = await siteWith("/r/* /:splat 200\n/bs /\\evil.test/x 200\n")
    const r = await s.route(req("/r/%5Cevil.test/x"), { hasWorker: true })
    expect(r.kind).toBe("worker")
    expect(r.request?.url).toBe(ORIGIN + "/%5Cevil.test/x")
    const bs = await s.route(req("/bs"), { hasWorker: true })
    expect([bs.kind, bs.response?.status, bs.request]).toEqual(["notfound", 500, undefined])
  })

  it("a 200 rewrite onto a run_worker_first path goes to the worker", async () => {
    const s = await siteWith("/app/* /api/:splat 200\n", { notFound: "single-page-application", runWorkerFirst: ["/api/*", "!/api/docs/*"] })
    for (const nav of [false, true]) {
      for (const p of ["/app/data.json", "/app/me"]) {
        const r = await s.route(req(p, { navigate: nav }), { hasWorker: true })
        expect(r.kind).toBe("worker")
        expect(r.rule).toBe("worker-first:/api/*")
        expect(r.request?.url).toBe(ORIGIN + p.replace("/app/", "/api/"))
      }
    }
    // No worker: the same 500 a direct request gets, never the asset
    const direct = await s.route(req("/api/data.json"), { hasWorker: false })
    const rewritten = await s.route(req("/app/data.json"), { hasWorker: false })
    expect([direct.response?.status, rewritten.response?.status]).toEqual([500, 500])
    expect(rewritten.rule).toBe("worker-first:/api/*")
    // env.ASSETS ignores run_worker_first
    expect(await (await s.fetchAsset(ORIGIN + "/app/data.json")).text()).toBe("{}")
  })
})

describe("no main: methods other than GET and HEAD", () => {
  it("405 on an asset or a redirect rule, 404 otherwise", async () => {
    const dir = mkdtempSync(join(BASE, "post-"))
    writeFileSync(join(dir, "index.html"), "x")
    writeFileSync(join(dir, "_redirects"), "/old /index.html 301\n/rw/* /nothing/:splat 200\n")
    const s = await open(dir)
    for (const p of ["/index.html", "/old", "/rw/a"]) {
      const res = (await s.route(req(p, { method: "POST" }), { hasWorker: false })).response!
      expect([p, res.status, res.headers.get("allow")]).toEqual([p, 405, "GET, HEAD"])
    }
    expect((await s.route(req("/missing", { method: "POST" }), { hasWorker: false })).response!.status).toBe(404)
    expect((await s.route(req("/old"), { hasWorker: false })).response!.status).toBe(301)
  })
})

describe("password-protected domains", () => {
  it("assets and redirects say Cache-Control: private unless _headers says otherwise", async () => {
    const dir = mkdtempSync(join(BASE, "priv-"))
    writeFileSync(join(dir, "index.html"), "x")
    writeFileSync(join(dir, "app.js"), "js")
    writeFileSync(join(dir, "_headers"), "/app.js\n  Cache-Control: no-store\n")
    writeFileSync(join(dir, "_redirects"), "/old / 301\n")
    const s = await open(dir)
    const cc = async (p: string, priv: boolean, init: RequestInit = {}) =>
      (await s.route(req(p, init), { hasWorker: false, private: priv })).response!.headers.get("cache-control")
    expect(await cc("/", true)).toBe("private, max-age=0, must-revalidate")
    expect(await cc("/", true, { headers: { Range: "bytes=0-0" } })).toBe("private, max-age=0, must-revalidate")
    expect(await cc("/old", true)).toBe("private, max-age=0, must-revalidate")
    expect(await cc("/app.js", true)).toBe("no-store")
    expect(await cc("/", false)).toBe("public, max-age=0, must-revalidate")
    expect(await cc("/old", false)).toBeNull()
  })
})

describe("root reads of user-controlled files", () => {
  const FIX = mkdtempSync(join(BASE, "verified-"))
  const anywhere = { inside: () => true } // as if the realpath check had passed just before a swap

  it("never follows a swapped-in symlink or blocks on a device or FIFO", async () => {
    const dir = mkdtempSync(join(FIX, "d-"))
    symlinkSync("/dev/zero", join(dir, "zero-link"))
    symlinkSync("/dev", join(dir, "devdir"))
    Bun.spawnSync(["mkfifo", join(dir, "fifo")])
    const t = performance.now()
    expect(await readVerified(join(dir, "zero-link"), 1024, { inside: p => p.startsWith(dir) })).toEqual({ error: "outside" })
    // A parent dir swapped for a symlink: O_NOFOLLOW doesn't cover it, the fd check does
    expect(await readVerified(join(dir, "devdir", "zero"), 1024, anywhere)).toEqual({ error: "special" })
    expect(await readVerified(join(dir, "devdir", "zero"), 1024, { inside: p => p.startsWith(dir) })).toEqual({ error: "outside" })
    expect(await readVerified(join(dir, "fifo"), 1024, anywhere)).toEqual({ error: "special" })
    expect(performance.now() - t).toBeLessThan(1000)
  })

  it("refuses a file the user couldn't read, and anything over the cap", async () => {
    const dir = mkdtempSync(join(FIX, "d-"))
    writeFileSync(join(dir, "shadow"), "root:secret")
    chmodSync(join(dir, "shadow"), 0o600)
    const other = process.getuid!() + 1
    expect(await readVerified(join(dir, "shadow"), 1024, { ...anywhere, canRead: p => userCanRead(p, other, []) })).toEqual({ error: "unreadable" })
    writeFileSync(join(dir, "big"), "x".repeat(2048))
    expect(await readVerified(join(dir, "big"), 1024, anywhere)).toEqual({ error: "large" })
    expect(await readVerified(join(dir, "big"), 4096, anywhere)).toBe("x".repeat(2048))
    expect(await readVerified(join(dir, "missing"), 1024, anywhere)).toBeNull()
  })

  it("_redirects swapped for /dev/zero or an owner-only file is ignored with a warning", async () => {
    const dir = mkdtempSync(join(FIX, "site-"))
    writeFileSync(join(dir, "index.html"), "x")
    symlinkSync("/dev/zero", join(dir, "_redirects"))
    writeFileSync(join(dir, "_headers"), "/*\n  X: 1\n")
    chmodSync(join(dir, "_headers"), 0o600)
    const other = process.getuid!() + 1
    const s = await open(dir, {}, { canRead: p => !p.endsWith("_headers") || userCanRead(p, other, []) })
    expect(await resolveAs(s, "/")).toEqual([200, "x"])
    expect(s.warnings.some(w => w.includes("_redirects is a symlink out"))).toBe(true)
    expect(s.warnings.some(w => w.includes("_headers is not readable"))).toBe(true)
  })

  it("a deploy manifest swapped for /dev/zero is not read", async () => {
    const dest = join(mkdtempSync(join(FIX, "deploy-")), "assets")
    await snapshotAssets(cfgFor(DIR, { html: "none" }), dest)
    const mp = join(dest, "..", "assets-manifest.json")
    renameSync(mp, mp + ".bak")
    symlinkSync("/dev/zero", mp)
    const t = performance.now()
    const s = await AssetServer.open(cfgFor(dest, { html: "none" }), { mode: "snapshot" })
    servers.push(s)
    expect(performance.now() - t).toBeLessThan(1000)
    expect(s.warnings.some(w => w.includes("no usable assets-manifest.json"))).toBe(true)
    // A hard link to another file is a regular file, but not the manifest's own path
    const outside = mkdtempSync(join(FIX, "victim-"))
    writeFileSync(join(outside, "m.json"), "{}")
    expect(await readVerified(join(outside, "m.json"), 1024, { inside: p => p === mp })).toEqual({ error: "outside" })
  })

  it("the index hashes from a checked fd", async () => {
    const dir = mkdtempSync(join(FIX, "idx-"))
    writeFileSync(join(dir, "a.txt"), "a")
    Bun.spawnSync(["mkfifo", join(dir, "fifo")])
    const s = await open(dir, {}, { index: true, canRead: p => !p.endsWith("b.txt") })
    expect(s.files().map(f => [f.path, !!f.hash])).toEqual([["/a.txt", true]])
  })
})
