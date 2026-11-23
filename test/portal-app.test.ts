// The portal SPA as the daemon serves it (portal-app.ts), against a mkdtemp
// dist: never the real web/dist, so the root suite needs no web build.
import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { buildIsStale, createPortalApp, PORTAL_APP_CSP, PORTAL_ASSET_CSP, UNBUILT_TEXT } from "../portal-app.ts"

const root = mkdtempSync(join(tmpdir(), "candy-portal-app-"))
afterAll(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

const INDEX = `<!doctype html><html><head><script type="module" src="/assets/index-ab12.js"></script></head><body><div id="root"></div></body></html>`
const dist = join(root, "dist")
mkdirSync(join(dist, "assets"), { recursive: true })
writeFileSync(join(dist, "index.html"), INDEX)
writeFileSync(join(dist, "assets", "index-ab12.js"), "console.log('app')")
writeFileSync(join(dist, "assets", "index-ab12.css"), "body{margin:0}")
writeFileSync(join(dist, "assets", "evil.html"), "<script>alert(1)</script>")

const app = createPortalApp({ dir: dist })
const get = (path: string, headers: Record<string, string> = {}, method = "GET") => {
  const url = new URL(path, "https://portal.localhost")
  return { req: new Request(url, { method, headers: { host: "portal.localhost", ...headers } }), url }
}
const page = (path: string, headers: Record<string, string> = {}, method = "GET") => {
  const { req, url } = get(path, headers, method)
  return app.serve(req, url, true)
}
const asset = (path: string, headers: Record<string, string> = {}, a = app) => {
  const { req, url } = get(path, headers)
  return a.serve(req, url, false)
}
const NAV = { "sec-fetch-mode": "navigate", accept: "text/html" }

describe("app pages", () => {
  it("a navigation to /sites/x gets index.html, no-cache, the page CSP and XFO DENY", async () => {
    const res = await page("/sites/x", NAV)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX)
    expect(res.headers.get("Content-Type")).toStartWith("text/html")
    expect(res.headers.get("Cache-Control")).toBe("no-cache")
    expect(res.headers.get("Content-Security-Policy")).toBe(PORTAL_APP_CSP)
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'")
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin")
    expect(res.headers.get("ETag")).toBeTruthy()
  })

  it("a fetch-style GET (no Sec-Fetch-Mode) of /settings/daemon is index.html with 200, not a 307", async () => {
    const res = await page("/settings/daemon")
    expect(res.status).toBe(200)
    expect(res.headers.get("Location")).toBeNull()
    expect(await res.text()).toBe(INDEX)
    expect(res.headers.get("Cache-Control")).toBe("no-cache")
    expect(res.headers.get("Content-Security-Policy")).toBe(PORTAL_APP_CSP)
  })

  it("revalidates by ETag and answers HEAD without a body, either way it is asked", async () => {
    const etag = (await page("/sites/x", NAV)).headers.get("ETag")!
    for (const h of [NAV, {}]) {
      const res = await page("/network", { ...h, "if-none-match": etag })
      expect(res.status).toBe(304)
      expect(res.headers.get("Cache-Control")).toBe("no-cache")
      const head = await page("/machine/services", h, "HEAD")
      expect(head.status).toBe(200)
      expect(await head.text()).toBe("")
    }
  })

  it("picks up a build that lands after the first request, with no restart", async () => {
    const later = join(root, "later")
    const told: number[] = []
    const a = createPortalApp({ dir: later, onUnbuilt: () => told.push(1) })
    const { req, url } = get("/sites", NAV)
    expect((await a.serve(req, url, true)).status).toBe(503)
    mkdirSync(later)
    writeFileSync(join(later, "index.html"), INDEX)
    const again = get("/sites", NAV)
    expect((await a.serve(again.req, again.url, true)).status).toBe(200)
    expect(told.length).toBe(1)
  })
})

describe("/assets/*", () => {
  it("an exact hashed file is immutable", async () => {
    const res = await asset("/assets/index-ab12.js")
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
    expect(res.headers.get("Content-Type")).toStartWith("application/javascript")
    expect(await res.text()).toBe("console.log('app')")
    expect((await asset("/assets/index-ab12.css")).headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
  })

  it("every asset carries a sandboxing document CSP (an SVG or XML opened directly runs nothing)", async () => {
    for (const p of ["/assets/index-ab12.js", "/assets/index-ab12.css"]) {
      const csp = (await asset(p)).headers.get("Content-Security-Policy") ?? ""
      expect(csp).toBe(PORTAL_ASSET_CSP)
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("sandbox")
      expect(csp).toContain("frame-ancestors 'none'")
    }
  })

  it("a missing one is 404 no-store", async () => {
    const res = await asset("/assets/gone-0000.js")
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("a navigation to a missing /assets/x.js is 404 no-store, not HTML", async () => {
    const res = await asset("/assets/x.js", NAV)
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get("Content-Type") ?? "").not.toContain("text/html")
    expect(await res.text()).not.toContain("<html")
  })

  it("an HTML file placed under assets/ is never immutable", async () => {
    for (const h of [{}, NAV]) {
      const res = await asset("/assets/evil.html", h)
      expect(res.status).toBe(404)
      expect(res.headers.get("Cache-Control")).toBe("no-store")
      expect(await res.text()).not.toContain("<script>")
    }
  })

  it("never answers a path outside /assets/, and refuses traversal", async () => {
    expect((await asset("/index.html")).status).toBe(404)
    expect((await asset("/assets/../index.html")).status).toBe(404)
    expect((await asset("/assets/%2e%2e/index.html")).status).toBe(404)
  })
})

describe("no build", () => {
  const told: string[] = []
  const missing = createPortalApp({ dir: join(root, "nope"), onUnbuilt: () => told.push("x") })

  it("a missing dist is a 503 whose body names no path and no user", async () => {
    const { req, url } = get("/sites/x", NAV)
    const res = await missing.serve(req, url, true)
    expect(res.status).toBe(503)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get("Retry-After")).toBe("5")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
    const body = await res.text()
    expect(body).toContain(UNBUILT_TEXT)
    expect(body).not.toContain("<script")
    expect(body).not.toContain(root)
    expect(body).not.toContain("/home")
    expect(body).not.toContain("web/dist")
    expect(body).not.toContain("bun run")
    const me = userInfo().username
    if (me.length > 2) expect(body).not.toContain(me)
    expect(told.length).toBeGreaterThan(0)
    expect(await missing.unbuilt().text()).toBe(body)
  })

  it("a missing dist answers /assets/* with 404 no-store", async () => {
    const res = await asset("/assets/index-ab12.js", {}, missing)
    expect(res.status).toBe(404)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("a dist without index.html is the 503 page too", async () => {
    const empty = join(root, "empty")
    mkdirSync(empty)
    const a = createPortalApp({ dir: empty })
    const { req, url } = get("/sites", NAV)
    expect((await a.serve(req, url, true)).status).toBe(503)
  })

  it("canRead returning false is the 503 page, never the file", async () => {
    const asked: string[] = []
    const locked = createPortalApp({ dir: dist, canRead: p => { asked.push(p); return false } })
    for (const h of [NAV, {}]) {
      const { req, url } = get("/sites/x", h)
      const res = await locked.serve(req, url, true)
      expect(res.status).toBe(503)
      expect(await res.text()).not.toContain('id="root"')
    }
    const js = await asset("/assets/index-ab12.js", {}, locked)
    expect(js.status).toBe(404)
    expect(await js.text()).not.toContain("console.log")
    expect(asked.length).toBeGreaterThan(0)
  })
})

describe("buildIsStale", () => {
  const web = join(root, "web")
  const src = join(web, "src")
  const index = join(web, "dist", "index.html")
  mkdirSync(join(src, "pages"), { recursive: true })
  mkdirSync(join(web, "dist"), { recursive: true })
  writeFileSync(join(src, "pages", "a.tsx"), "x")
  writeFileSync(index, INDEX)
  const at = (path: string, sec: number) => utimesSync(path, sec, sec)

  it("is true only when something under src is newer than dist/index.html", async () => {
    for (const p of [src, join(src, "pages"), join(src, "pages", "a.tsx")]) at(p, 1000)
    at(index, 2000)
    expect(await buildIsStale(src, index)).toBe(false)
    at(join(src, "pages", "a.tsx"), 3000)
    expect(await buildIsStale(src, index)).toBe(true)
  })

  it("skips node_modules, and gives up (not stale) past the entry limit", async () => {
    at(join(src, "pages", "a.tsx"), 1000)
    mkdirSync(join(src, "node_modules"), { recursive: true })
    writeFileSync(join(src, "node_modules", "dep.js"), "x")
    at(join(src, "node_modules", "dep.js"), 5000)
    for (const p of [src, join(src, "pages"), join(src, "node_modules")]) at(p, 1000)
    expect(await buildIsStale(src, index)).toBe(false)
    at(join(src, "pages", "a.tsx"), 3000)
    expect(await buildIsStale(src, index, 1)).toBe(false)
  })

  it("is false with no build or no source", async () => {
    expect(await buildIsStale(src, join(root, "none", "index.html"))).toBe(false)
    expect(await buildIsStale(join(root, "no-src"), index)).toBe(false)
  })
})

describe("page-token rejection marker", () => {
  it("the daemon marks its token 401 with X-Candy-Token: invalid (the SPA retries only that 401)", async () => {
    const daemon = await Bun.file(join(import.meta.dir, "..", "daemon.ts")).text()
    const at = daemon.indexOf("const unauthorizedResponse = ")
    expect(at).toBeGreaterThan(-1)
    const def = daemon.slice(at, daemon.indexOf("\n\n", at))
    expect(def).toContain(`"Invalid or expired token. Refresh required."`)
    expect(def).toContain(`"X-Candy-Token": "invalid"`)
  })
})
