// The portal SPA (web/, built to web/dist by the owner) as the daemon serves it
// on the portal host. Two fn-assets resolvers on the same directory, with the
// daemon in the worker's place:
//   pages    every ROUTE_TABLE "app" path: index.html (spa-navigate for a
//            navigation, the binding fetch for fetch()/curl), no-cache, the
//            page CSP, XFO DENY. No login: the page holds no data or token
//            (those come from POST /portal/boot)
//   assets   /assets/*: exact, non-HTML files only, immutable; anything else is
//            404 no-store. A miss never becomes index.html
// Missing or unreadable dist: the built-in 503 page, which names no path, user
// or command (it is reachable without a login). The daemon logs the details.
// daemon.ts creates one and calls serve() only after its guard, on a portal host.
import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { AssetServer, contentTypeFor, type AssetsConfig } from "./fn-assets.ts"

export interface PortalAppOptions {
  /** The built SPA: join(import.meta.dir, "web", "dist") in the daemon */
  dir: string
  /** Serve only what this says the owner could read (root mode); as fn-assets' OpenOptions.canRead */
  canRead?: (path: string) => boolean
  /** A page request found no build (missing dir, no index.html, or unreadable); the daemon audits it once per boot */
  onUnbuilt?: () => void
}

export interface PortalApp {
  /** page: the path's ROUTE_TABLE class is "app"; otherwise it is an /assets/* request */
  serve(req: Request, url: URL, page: boolean): Promise<Response>
  /** The 503 page shown while there is no build */
  unbuilt(): Response
  readonly CSP: string
}

/** Every SPA page response. The bundle has no inline script or style (React sets style through the CSSOM). */
export const PORTAL_APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"

/** Every /assets/* response: a document CSP that only bites when an asset is opened as a page */
export const PORTAL_ASSET_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox"

/** The exact text of the 503 page (no path, user or command: it is served without a login) */
export const UNBUILT_TEXT = "The portal isn't built yet. See the daemon log."

const UNBUILT_STYLE = ":root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:#f4f5f7;color:#16181d;font:15px/1.5 system-ui,sans-serif}main{max-width:420px}h1{font-size:18px;margin:0 0 6px}p{margin:0;color:#5b6070}@media (prefers-color-scheme:dark){body{background:#101114;color:#e8e9ed}p{color:#a2a6b3}}"
const UNBUILT_STYLE_HASH = createHash("sha256").update(UNBUILT_STYLE).digest("base64")
const UNBUILT_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>candy</title><style>${UNBUILT_STYLE}</style></head><body><main><h1>candy</h1><p>${UNBUILT_TEXT}</p></main></body></html>`
const UNBUILT_CSP = `default-src 'none'; style-src 'sha256-${UNBUILT_STYLE_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`

const unbuilt = (): Response => new Response(UNBUILT_HTML, {
  status: 503,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "5",
    "Content-Security-Policy": UNBUILT_CSP,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  },
})

const assetMiss = (): Response => new Response("not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } })

// A placeholder origin for the binding fetch of /index.html (fetchAsset only reads the path)
const SHELL_URL = "http://portal.invalid/index.html"

export function createPortalApp(o: PortalAppOptions): PortalApp {
  const base = { directory: o.dir, binding: null, runWorkerFirst: false } as const
  // html "none": auto-trailing-slash would 307 /index.html to /, turning every
  // non-navigation GET of an app path into a redirect
  const PAGES_CFG: AssetsConfig = { ...base, notFound: "single-page-application", html: "none" }
  const ASSETS_CFG: AssetsConfig = { ...base, notFound: "none", html: "none" }
  // "dev": stat per lookup, so a rebuild shows on the next request; a missing dir is retried per request
  const opener = (cfg: AssetsConfig) => {
    let p: Promise<AssetServer> | null = null
    return (): Promise<AssetServer> => {
      p ??= AssetServer.open(cfg, { mode: "dev", canRead: o.canRead }).catch(e => { p = null; throw e })
      return p
    }
  }
  const pages = opener(PAGES_CFG)
  const assets = opener(ASSETS_CFG)

  const servePage = async (req: Request): Promise<Response> => {
    let res: Response
    let attached: boolean
    try {
      const app = await pages()
      const r = await app.route(req, { hasWorker: true })
      // spa-navigate's index.html, an exact file, or route()'s 307 to the normalised path (same origin)
      if (r.kind !== "worker" && r.response) res = r.response
      else {
        // fetch(), curl, prefetch: the same index.html through the binding path, keeping
        // the method (HEAD), the ETag revalidation and a Range
        const headers = new Headers()
        for (const h of ["if-none-match", "range"]) {
          const v = req.headers.get(h)
          if (v !== null) headers.set(h, v)
        }
        res = await app.fetchAsset(new Request(SHELL_URL, { method: req.method === "HEAD" ? "HEAD" : "GET", headers }))
      }
      attached = app.attached
    } catch {
      o.onUnbuilt?.()
      return unbuilt()
    }
    if (res.status === 404 || res.status >= 500 || !attached) {
      res.body?.cancel().catch(() => {})
      o.onUnbuilt?.()
      return unbuilt()
    }
    // A _headers file in dist can't replace these: the daemon sets them last
    const h = res.headers
    h.set("Cache-Control", "no-cache")   // revalidates by ETag; the page holds no data
    h.set("Content-Security-Policy", PORTAL_APP_CSP)
    h.set("Referrer-Policy", "same-origin")
    h.set("X-Frame-Options", "DENY")
    return res
  }

  const serveAsset = async (req: Request, url: URL): Promise<Response> => {
    // An HTML file is never an asset (a 304 carries no Content-Type to tell by)
    if (!url.pathname.startsWith("/assets/") || contentTypeFor(url.pathname).startsWith("text/html")) return assetMiss()
    let res: Response | undefined
    try {
      const app = await assets()
      // notFound "none" and no worker: a miss is a bare 404, whatever Sec-Fetch-Mode says
      res = (await app.route(req, { hasWorker: false })).response
    } catch {
      return assetMiss()
    }
    const type = res?.headers.get("Content-Type") ?? ""
    if (!res || ![200, 206, 304].includes(res.status) || type.toLowerCase().startsWith("text/html")) {
      res?.body?.cancel().catch(() => {})
      return assetMiss()
    }
    res.headers.set("Cache-Control", "public, max-age=31536000, immutable")
    // Ignored on script/style/font/image subresources; an asset opened as a document (an SVG, an XML
    // file) becomes inert and sandboxed, away from the portal origin's localStorage
    res.headers.set("Content-Security-Policy", PORTAL_ASSET_CSP)
    return res
  }

  return {
    serve: (req, url, page) => page ? servePage(req) : serveAsset(req, url),
    unbuilt,
    CSP: PORTAL_APP_CSP,
  }
}

/** Entries the staleness walk looks at before it gives up (and answers "not stale") */
export const STALE_WALK_LIMIT = 5000

/**
 * Whether web/src has changed since web/dist was built: the newest mtime under
 * `srcDir` is later than `distIndex`'s. lstat only (a symlink is looked at, never
 * followed), node_modules skipped, at most STALE_WALK_LIMIT entries (more: false).
 * No build, or no source: false (the 503 page covers a missing build).
 */
export async function buildIsStale(srcDir: string, distIndex: string, limit = STALE_WALK_LIMIT): Promise<boolean> {
  let built: number
  try {
    const st = await lstat(distIndex)
    if (!st.isFile()) return false
    built = st.mtimeMs
  } catch {
    return false
  }
  let seen = 0
  const stack = [srcDir]
  while (stack.length) {
    const dir = stack.pop()!
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (const name of names) {
      if (name === "node_modules") continue
      if (++seen > limit) return false
      const path = join(dir, name)
      let st
      try { st = await lstat(path) } catch { continue }
      if (st.mtimeMs > built) return true
      if (st.isDirectory()) stack.push(path)
    }
  }
  return false
}
