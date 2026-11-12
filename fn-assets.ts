// Workers Static Assets for candy functions: the daemon serves the files itself, no process, no port.
// Behavior follows Cloudflare's asset-worker (html_handling, not_found_handling, run_worker_first,
// _redirects, _headers, .assetsignore). Pure apart from reading the asset directory.
import { closeSync, constants as FS, fstat, open as openCb, read as readCb, watch, realpathSync, statSync, type FSWatcher, type Stats } from "node:fs"
import { chmod, mkdir, readdir, readlink, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"

export type NotFoundHandling = "none" | "404-page" | "single-page-application"
export type HtmlHandling = "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none"

export interface AssetsConfig {
  directory: string // absolute
  binding: string | null
  notFound: NotFoundHandling
  html: HtmlHandling
  runWorkerFirst: boolean | string[]
}

// The routing half of the config, as a deploy's manifest.json records it.
export type AssetsRouting = Omit<AssetsConfig, "directory">

export interface RedirectRule { from: string; to: string; status: number; line: number }
export interface HeaderRule { pattern: string; set: [string, string][]; unset: string[]; line: number }

export interface RouteResult {
  kind: "asset" | "redirect" | "rewrite" | "worker" | "notfound"
  response?: Response
  request?: Request
  rule?: string
}

const NOT_FOUND_MODES: NotFoundHandling[] = ["none", "404-page", "single-page-application"]
const HTML_MODES: HtmlHandling[] = ["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"]
const BINDING_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/i

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES = 100_000
export const CF_FILES_WARNING = 20_000
export const MAX_STATIC_REDIRECTS = 2000
export const MAX_DYNAMIC_REDIRECTS = 100
export const MAX_REDIRECT_LINE = 1000
export const MAX_HEADER_RULES = 100
export const MAX_HEADER_LINE = 2000
export const MAX_WORKER_FIRST_RULES = 100
const MAX_CONTROL_FILE = 1024 * 1024
const WATCH_DEBOUNCE_MS = 100

// Root-level control files: parsed, never served or snapshotted (wrangler skips them on upload too).
const CONTROL_FILES = new Set(["_headers", "_redirects", ".assetsignore"])
const CACHE_CONTROL = "public, max-age=0, must-revalidate"
// Behind a password a shared cache must not keep the files (or the redirects) for everyone.
const PRIVATE_CACHE_CONTROL = "private, max-age=0, must-revalidate"
const MAX_MANIFEST = 64 * 1024 * 1024
const REDIRECT_CODES = new Set([200, 301, 302, 303, 307, 308])
const KNOWN_KEYS = new Set(["directory", "binding", "not_found_handling", "html_handling", "run_worker_first"])

// ---------- config ----------

// Throws on anything that would change routing if guessed (bad modes, bad run_worker_first patterns).
export function loadAssetsConfig(raw: unknown, dir: string): { config: AssetsConfig; warnings: string[] } {
  const warnings: string[] = []
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("assets must be an object")
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(r)) if (!KNOWN_KEYS.has(k)) warnings.push(`assets.${k} is not supported and was ignored`)
  if (typeof r.directory !== "string" || !r.directory.trim()) throw new Error("assets.directory is required")
  const directory = resolve(dir, r.directory)
  try {
    if (!statSync(directory).isDirectory()) warnings.push(`assets.directory ${directory} is not a directory`)
  } catch {
    warnings.push(`assets.directory ${directory} does not exist`)
  }
  let binding: string | null = null
  if (r.binding !== undefined && r.binding !== null) {
    if (typeof r.binding !== "string" || !BINDING_NAME.test(r.binding)) throw new Error(`assets.binding ${JSON.stringify(r.binding)} is not a valid binding name`)
    binding = r.binding
  }
  const notFound = (r.not_found_handling ?? "none") as NotFoundHandling
  if (!NOT_FOUND_MODES.includes(notFound)) throw new Error(`assets.not_found_handling must be one of ${NOT_FOUND_MODES.join(", ")}`)
  const html = (r.html_handling ?? "auto-trailing-slash") as HtmlHandling
  if (!HTML_MODES.includes(html)) throw new Error(`assets.html_handling must be one of ${HTML_MODES.join(", ")}`)
  const runWorkerFirst = validateRunWorkerFirst(r.run_worker_first ?? false)
  return { config: { directory, binding, notFound, html, runWorkerFirst }, warnings }
}

// Bad patterns fail loudly: silently dropping "/api/*" would serve index.html to API navigations.
export function validateRunWorkerFirst(v: unknown): boolean | string[] {
  if (typeof v === "boolean") return v
  if (!Array.isArray(v)) throw new Error("assets.run_worker_first must be a boolean or an array of route patterns")
  if (v.length > MAX_WORKER_FIRST_RULES) throw new Error(`assets.run_worker_first has ${v.length} patterns (max ${MAX_WORKER_FIRST_RULES})`)
  const bad: string[] = []
  for (const p of v) {
    if (typeof p !== "string" || !(p.startsWith("/") || p.startsWith("!/")) || p.length > MAX_REDIRECT_LINE || /[\s?#]/.test(p)) bad.push(JSON.stringify(p))
  }
  if (bad.length) throw new Error(`assets.run_worker_first: invalid pattern(s) ${bad.join(", ")} (must start with / or !/, no spaces, ? or #)`)
  return [...v] as string[]
}

// `*` matches anything, slashes included. Plain string search, no regex: the path is the
// visitor's and a `.*` per star backtracks n^k on the daemon's only thread. Leftmost placement
// of each middle literal is enough for a match to exist when all wildcards are `*`.
export function globMatch(pattern: string, path: string): boolean {
  const parts = pattern.split("*")
  if (parts.length === 1) return pattern === path
  const head = parts[0]
  const tail = parts[parts.length - 1]
  const end = path.length - tail.length
  if (end < head.length || !path.startsWith(head) || !path.endsWith(tail)) return false
  let pos = head.length
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) continue
    const at = path.indexOf(parts[i], pos)
    if (at < 0 || at + parts[i].length > end) return false
    pos = at + parts[i].length
  }
  return true
}

// Returns the pattern that sent the path to the worker, "true" for run_worker_first: true, or null.
// Matched on the decoded, slash-collapsed path so "/%61pi/x" can't dodge "/api/*" into the assets.
export function matchRunWorkerFirst(rwf: boolean | string[], path: string): string | null {
  if (rwf === true) return "true"
  if (!rwf) return null
  let hit: string | null = null
  for (const p of rwf) {
    if (p.startsWith("!")) {
      if (globMatch(p.slice(1), path)) return null // exclusions win
    } else if (!hit && globMatch(p, path)) hit = p
  }
  return hit
}

// ---------- _redirects ----------

export function parseRedirects(text: string): { rules: RedirectRule[]; warnings: string[] } {
  const rules: RedirectRule[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let statics = 0
  let dynamics = 0
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    const t = raw.trim()
    if (!t || t.startsWith("#")) return
    if (t.length > MAX_REDIRECT_LINE) return warnings.push(`_redirects:${line}: longer than ${MAX_REDIRECT_LINE} characters, ignored`)
    const parts = t.split(/\s+/)
    const hash = parts.findIndex(p => p.startsWith("#"))
    if (hash >= 0) parts.length = hash // trailing comment
    if (parts.length < 2 || parts.length > 3) return warnings.push(`_redirects:${line}: expected "from to [status]", ignored`)
    const [from, to] = parts
    const status = parts[2] === undefined ? 302 : Number(parts[2])
    if (!REDIRECT_CODES.has(status)) return warnings.push(`_redirects:${line}: status ${parts[2]} is not one of 200, 301, 302, 303, 307, 308, ignored`)
    if (!from.startsWith("/")) return warnings.push(`_redirects:${line}: "from" must be a path starting with / (domain-level redirects are not supported), ignored`)
    if (status === 200 && (!to.startsWith("/") || to.startsWith("//"))) return warnings.push(`_redirects:${line}: 200 rewrites must point at a path on the same site, ignored`)
    if (tooManySplats(from)) return warnings.push(`_redirects:${line}: more than one * in "${from}" (Cloudflare allows one), ignored`)
    const dynamic = isDynamic(from)
    if (dynamic) {
      if (dynamics >= MAX_DYNAMIC_REDIRECTS) return warnings.push(`_redirects:${line}: over the ${MAX_DYNAMIC_REDIRECTS} dynamic rule limit, ignored`)
      dynamics++
    } else {
      if (seen.has(from)) return warnings.push(`_redirects:${line}: duplicate rule for ${from}, ignored`)
      if (statics >= MAX_STATIC_REDIRECTS) return warnings.push(`_redirects:${line}: over the ${MAX_STATIC_REDIRECTS} static rule limit, ignored`)
      seen.add(from)
      statics++
    }
    rules.push({ from, to, status, line })
  })
  return { rules, warnings }
}

const isDynamic = (pattern: string) => pattern.includes("*") || /:[A-Za-z_]/.test(pattern)

const tooManySplats = (pattern: string) => pattern.indexOf("*") !== pattern.lastIndexOf("*")

// A segment token: literal text, or a wildcard (`:name` takes 1+ characters, the splat 0+).
// name null: not captured (a repeated name).
type Tok = { lit: string } | { name: string | null; min: number }
type Groups = Record<string, string>
export type RuleMatcher = (path: string) => Groups | null

// `*` → :splat (greedy, crosses /), `:name` → one path segment. Matched without regex, segment by
// segment: placeholders and literals can't cross a "/", so with one splat every segment's place
// in the path is fixed and each check is a linear scan. null for more than one `*`.
export function compilePattern(pattern: string): RuleMatcher | null {
  if (tooManySplats(pattern)) return null
  const names = new Set<string>(["splat"])
  const seg = (s: string): Tok[] => {
    const out: Tok[] = []
    let lit = ""
    for (let i = 0; i < s.length;) {
      const m = s[i] === ":" ? /^:([A-Za-z_]\w*)/.exec(s.slice(i)) : null
      if (!m) {
        lit += s[i++]
        continue
      }
      if (lit) out.push({ lit })
      lit = ""
      out.push({ name: names.has(m[1]) ? null : m[1], min: 1 })
      names.add(m[1])
      i += m[0].length
    }
    if (lit) out.push({ lit })
    return out
  }
  const star = pattern.indexOf("*")
  if (star < 0) {
    const segs = pattern.split("/").map(seg)
    return path => {
      const s = path.split("/")
      if (s.length !== segs.length) return null
      const g: Groups = {}
      return segs.every((t, i) => matchSegment(t, s[i], g)) ? g : null
    }
  }
  const before = pattern.slice(0, star).split("/").map(seg)
  const after = pattern.slice(star + 1).split("/").map(seg)
  const head = before.pop()! // the splat's segment, up to the star
  const tail = after.shift()! // and from it
  const SPLAT: Tok = { name: "splat", min: 0 }
  return path => {
    const s = path.split("/")
    const p = before.length
    const q = after.length
    if (p + q >= s.length) return null
    const g: Groups = {}
    for (let i = 0; i < p; i++) if (!matchSegment(before[i], s[i], g)) return null
    for (let i = 0; i < q; i++) if (!matchSegment(after[i], s[s.length - q + i], g)) return null
    const mid = s.slice(p, s.length - q)
    if (mid.length === 1) return matchSegment([...head, SPLAT, ...tail], mid[0], g) ? g : null
    if (!matchSegment([...head, SPLAT], mid[0], g)) return null
    const first = g.splat
    if (!matchSegment([SPLAT, ...tail], mid[mid.length - 1], g)) return null
    g.splat = [first, ...mid.slice(1, -1), g.splat].join("/")
    return g
  }
}

// One segment against literals and wildcards. Leading literals are a prefix; the rest are placed
// right to left at their rightmost fit (lastIndexOf), which is both enough for a match to exist and
// what a greedy regex would capture: earlier wildcards get the most. Linear, no backtracking.
function matchSegment(toks: Tok[], s: string, g: Groups): boolean {
  let lo = 0
  let k = 0
  for (; k < toks.length; k++) {
    const t = toks[k]
    if (!("lit" in t)) break
    if (!s.startsWith(t.lit, lo)) return false
    lo += t.lit.length
  }
  if (k === toks.length) return lo === s.length
  let end = s.length
  let pending: { name: string | null; min: number }[] = []
  let need = 0
  // pending is right to left; the leftmost wildcard takes whatever the others don't need
  const assign = (start: number) => {
    let e = end
    pending.forEach((w, i) => {
      const from = i === pending.length - 1 ? start : e - w.min
      if (w.name) g[w.name] = s.slice(from, e)
      e = from
    })
    pending = []
    need = 0
  }
  for (let i = toks.length - 1; i >= k; i--) {
    const t = toks[i]
    if (!("lit" in t)) {
      pending.push(t)
      need += t.min
      continue
    }
    let at: number
    if (!pending.length) {
      at = end - t.lit.length
      if (at < lo || s.slice(at, end) !== t.lit) return false
    } else {
      const max = end - need - t.lit.length
      at = max < lo ? -1 : s.lastIndexOf(t.lit, max)
      if (at < lo) return false
      assign(at + t.lit.length)
    }
    end = at
  }
  if (end - lo < need) return false
  assign(lo)
  return true
}

// Captures go into URLs and header values: percent-encode them, or a decoded "\" or "//" in a
// splat becomes an open redirect and a non-ASCII one an invalid header.
const substitute = (s: string, groups: Record<string, string | undefined>) =>
  s.replace(/:([A-Za-z_]\w*)/g, (m, n) => (groups[n] === undefined ? m : encodePath(groups[n]!)))

// ---------- _headers ----------

export function parseHeaders(text: string): { rules: HeaderRule[]; warnings: string[] } {
  const rules: HeaderRule[] = []
  const warnings: string[] = []
  let cur: HeaderRule | null = null
  let dropped = false
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1
    if (!raw.trim() || raw.trim().startsWith("#")) return
    if (raw.length > MAX_HEADER_LINE) return warnings.push(`_headers:${line}: longer than ${MAX_HEADER_LINE} characters, ignored`)
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim()
      if (!pattern.startsWith("/") && !/^https?:\/\//.test(pattern)) {
        cur = null
        dropped = true
        return warnings.push(`_headers:${line}: expected a path pattern starting with / or https://, ignored`)
      }
      if (tooManySplats(pattern)) {
        cur = null
        dropped = true
        return warnings.push(`_headers:${line}: more than one * in "${pattern}" (Cloudflare allows one), ignored`)
      }
      if (rules.length >= MAX_HEADER_RULES) {
        cur = null
        dropped = true
        return warnings.push(`_headers:${line}: over the ${MAX_HEADER_RULES} rule limit, ignored`)
      }
      cur = { pattern, set: [], unset: [], line }
      dropped = false
      rules.push(cur)
      return
    }
    if (!cur) {
      if (!dropped) warnings.push(`_headers:${line}: header line before any path pattern, ignored`)
      return
    }
    const t = raw.trim()
    if (t.startsWith("!")) {
      const name = t.slice(1).trim()
      if (!HEADER_NAME.test(name)) return warnings.push(`_headers:${line}: invalid header name to detach, ignored`)
      cur.unset.push(name)
      return
    }
    const colon = t.indexOf(":")
    const name = colon > 0 ? t.slice(0, colon).trim() : ""
    if (!HEADER_NAME.test(name)) return warnings.push(`_headers:${line}: expected "Name: value", ignored`)
    cur.set.push([name, t.slice(colon + 1).trim()])
  })
  return { rules, warnings }
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

// ---------- .assetsignore (gitignore syntax) ----------

export function parseAssetsIgnore(text: string): (relPath: string) => boolean {
  const pats: { re: RegExp; neg: boolean; dirOnly: boolean }[] = []
  for (let raw of text.split(/\r?\n/)) {
    raw = raw.replace(/(?<!\\)\s+$/, "")
    if (!raw || raw.startsWith("#")) continue
    let neg = false
    if (raw.startsWith("!")) {
      neg = true
      raw = raw.slice(1)
    } else if (raw.startsWith("\\!") || raw.startsWith("\\#")) raw = raw.slice(1)
    const dirOnly = raw.endsWith("/")
    if (dirOnly) raw = raw.slice(0, -1)
    if (!raw) continue
    const anchored = raw.includes("/")
    if (raw.startsWith("/")) raw = raw.slice(1)
    const body = gitGlob(raw)
    pats.push({ re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), neg, dirOnly })
  }
  const test = (p: string, isDir: boolean) => {
    let out = false
    for (const x of pats) if ((!x.dirOnly || isDir) && x.re.test(p)) out = !x.neg
    return out
  }
  return (relPath: string) => {
    const segs = relPath.replace(/^\/+/, "").split("/").filter(Boolean)
    // A file under an ignored directory can't be re-included, same as git.
    for (let i = 1; i < segs.length; i++) if (test(segs.slice(0, i).join("/"), true)) return true
    return test(segs.join("/"), false)
  }
}

function gitGlob(g: string): string {
  let s = ""
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*" && g[i + 1] === "*") {
      const atStart = i === 0 || g[i - 1] === "/"
      if (atStart && g[i + 2] === "/") { s += "(?:.*/)?"; i += 2; continue }
      if (atStart && i + 2 === g.length) { s += ".*"; i++; continue }
      s += "[^/]*"
      i++
    } else if (c === "*") s += "[^/]*"
    else if (c === "?") s += "[^/]"
    else if (c === "\\" && i + 1 < g.length) s += escapeRe(g[++i])
    else if (c === "[") {
      const end = g.indexOf("]", i + 2)
      if (end < 0) { s += "\\["; continue }
      let cls = g.slice(i + 1, end)
      if (cls.startsWith("!")) cls = "^" + cls.slice(1)
      s += `[${cls.replace(/\\/g, "\\\\")}]`
      i = end
    } else s += escapeRe(c)
  }
  return s
}

// ---------- content types ----------

const TEXT = "; charset=utf-8"
const TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  xml: "text/xml", ics: "text/calendar", vtt: "text/vtt",
  js: "application/javascript", mjs: "application/javascript", cjs: "application/javascript",
  json: "application/json", map: "application/json", webmanifest: "application/manifest+json",
  jsonld: "application/ld+json", wasm: "application/wasm", pdf: "application/pdf", zip: "application/zip",
  gz: "application/gzip", tar: "application/x-tar", rss: "application/rss+xml", atom: "application/atom+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", opus: "audio/opus",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m3u8: "application/vnd.apple.mpegurl",
}

export function contentTypeFor(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  const t = dot > 0 ? TYPES[base.slice(dot + 1).toLowerCase()] : undefined
  if (!t) return "application/octet-stream"
  return t.startsWith("text/") || t === "application/javascript" || t === "application/json" || t === "image/svg+xml" ? t + TEXT : t
}

// ---------- permissions ----------

// bit: 4 read, 1 search. Owner bits apply to the owner even when group/other would allow more.
export const modeAllows = (st: { uid: number; gid: number; mode: number }, uid: number, gids: number[], bit: number) =>
  st.uid === uid ? (st.mode & (bit << 6)) !== 0 : gids.includes(st.gid) ? (st.mode & (bit << 3)) !== 0 : (st.mode & bit) !== 0

// Could uid (with gids) open this file? Read bit on the file plus search bit on every parent,
// along both the path as given and its realpath (a symlink hop doesn't grant access).
export function userCanRead(path: string, uid: number, gids: number[]): boolean {
  if (uid === 0) return true
  try {
    const real = realpathSync(path)
    const st = statSync(real)
    if (!st.isFile() || !modeAllows(st, uid, gids, 4)) return false
    for (const p of new Set([resolve(path), real])) {
      for (let d = dirname(p); ; d = dirname(d)) {
        if (!modeAllows(statSync(d), uid, gids, 1)) return false
        if (d === "/" || d === dirname(d)) break
      }
    }
    return true
  } catch {
    return false
  }
}

// ---------- server ----------

// manifestHash: what the snapshot recorded; checked against the bytes actually opened at serve time.
interface Entry { path: string; real: string; size: number; mtimeMs: number; hash?: string; type: string; manifestHash?: string }
interface Intent { entry: Entry; status: 200 | 404; redirect: string | null }
type Exists = (p: string) => Promise<Entry | null>

interface CompiledRedirect { rule: RedirectRule; match: RuleMatcher | null }
interface CompiledHeader { rule: HeaderRule; match: RuleMatcher; host: boolean }

interface Manifest {
  version: 1
  files: Record<string, { hash: string; size: number; type: string }>
  headers: HeaderRule[]
  redirects: RedirectRule[]
  warnings: string[]
}

export const MANIFEST_NAME = "assets-manifest.json"
// The manifest sits next to the snapshot's assets dir so it can never shadow a user file.
export const manifestPathFor = (assetsDir: string) => join(dirname(assetsDir), MANIFEST_NAME)

export interface RouteOptions {
  hasWorker: boolean
  // Password-protected domain: responses say Cache-Control: private unless _headers says otherwise
  private?: boolean
}

export interface OpenOptions {
  mode: "dev" | "snapshot"
  canRead?(path: string): boolean
  // Walk and hash the tree up front (files(), snapshots). Serving never needs it: dev lookups stat
  // the disk and snapshots read the manifest, so the daemon and the shim leave it off.
  index?: boolean
  watch?: boolean // keep the index current; only with index
}

export class AssetServer {
  readonly cfg: AssetsConfig
  private root = ""
  private attaching: Promise<boolean> | null = null
  private mode: "dev" | "snapshot"
  private indexed: boolean
  private watchTree: boolean
  private canRead?: (path: string) => boolean
  private index = new Map<string, Entry>()
  // Hash of an opened file keyed by dev:ino:size:mtime:ctime, so serve-time verification is paid once per version.
  private fdHashes = new Map<string, string>()
  private ignore: (rel: string) => boolean = () => false
  private staticRedirects = new Map<string, CompiledRedirect>()
  private dynamicRedirects: CompiledRedirect[] = []
  private headerRules: CompiledHeader[] = []
  private controlStamp = new Map<string, string>()
  private controlWarnings = new Map<string, string[]>()
  private indexWarnings: string[] = []
  private indexErrors: string[] = []
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private constructor(cfg: AssetsConfig, opts: OpenOptions) {
    this.cfg = cfg
    this.mode = opts.mode
    this.canRead = opts.canRead
    this.indexed = !!opts.index
    this.watchTree = !!opts.index && !!opts.watch && opts.mode === "dev"
  }

  // A missing directory (dev before the first build) is an empty asset set, not an error: every
  // lookup misses until it appears, and each request checks again.
  static async open(cfg: AssetsConfig, opts: OpenOptions): Promise<AssetServer> {
    const s = new AssetServer(cfg, opts)
    await s.attach()
    return s
  }

  /** Whether the asset directory exists (has been found). */
  get attached(): boolean {
    return this.root !== ""
  }

  private attach(): Promise<boolean> {
    if (this.root || this.closed) return Promise.resolve(!!this.root)
    this.attaching ??= this.tryAttach().finally(() => { this.attaching = null })
    return this.attaching
  }

  private async tryAttach(): Promise<boolean> {
    let root: string
    try {
      root = await realpath(this.cfg.directory)
      if (!(await stat(root)).isDirectory()) return false
    } catch {
      return false
    }
    this.root = root
    if (this.mode === "snapshot") {
      if (await this.loadManifest()) return true
      this.mode = "dev" // no manifest: serve the tree like dev, minus the watcher
      this.watchTree = false
      this.indexWarnings.push(`no usable ${MANIFEST_NAME} next to ${this.cfg.directory}, serving the directory as is`)
    }
    if (!this.indexed) {
      await this.refreshControl(true)
      return true
    }
    await this.rebuild()
    if (this.watchTree && !this.closed) {
      try {
        this.watcher = watch(root, { recursive: true }, () => this.schedule())
        this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null })
      } catch {
        // No watcher: lookups still stat the disk, so edits still show up.
      }
    }
    return true
  }

  get warnings(): string[] {
    return [...[...this.controlWarnings.values()].flat(), ...this.indexWarnings, ...this.indexErrors]
  }

  // Indexed files, for listings and snapshots.
  files(): { path: string; size: number; type: string; hash?: string }[] {
    return [...this.index.values()].map(e => ({ path: e.path, size: e.size, type: e.type, hash: e.hash }))
  }

  close() {
    this.closed = true
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.rebuild().catch(() => {})
    }, WATCH_DEBOUNCE_MS)
  }

  // ----- routing -----

  async route(req: Request, opts: RouteOptions): Promise<RouteResult> {
    const url = new URL(req.url)
    const path = normalizePath(url.pathname)
    const wf = path === null ? null : matchRunWorkerFirst(this.cfg.runWorkerFirst, path)
    const r = wf ? workerFirst(wf, opts.hasWorker) : await this.assetRoute(req, url, path, opts.hasWorker, false, !!opts.private)
    // Redirects and bare 404/405s too: a shared cache must not replay them past the password.
    // File responses (they carry an ETag) got theirs in respond(), where _headers can change it.
    const res = r.response
    if (opts.private && res && !res.headers.has("etag") && !res.headers.has("cache-control")) res.headers.set("Cache-Control", PRIVATE_CACHE_CONTROL)
    return r
  }

  async fetchAsset(req: Request | string | URL): Promise<Response> {
    const r = req instanceof Request ? req : new Request(String(req))
    const url = new URL(r.url)
    const res = await this.assetRoute(r, url, normalizePath(url.pathname), false, true, false)
    return res.response ?? new Response(null, { status: 404 })
  }

  // binding: env.ASSETS, which never reaches the worker and ignores run_worker_first.
  private async assetRoute(req: Request, url: URL, path: string | null, hasWorker: boolean, binding: boolean, priv: boolean): Promise<RouteResult> {
    const method = req.method.toUpperCase()
    const isRead = method === "GET" || method === "HEAD"
    // Cloudflare's router only asks the assets about GET/HEAD when there's a worker.
    if (hasWorker && !isRead) return { kind: "worker" }
    if (path === null || !(await this.attach())) return this.miss(req, hasWorker, url, priv)
    await this.refreshControl()

    const redirect = this.matchRedirect(path, url.search)
    if (redirect) {
      const { rule, dest } = redirect
      const ruleText = `${rule.from} ${rule.to} ${rule.status}`
      // No worker to hand other methods to: a rule's path answers only GET and HEAD.
      if (!isRead) return { kind: "notfound", rule: ruleText, response: methodNotAllowed() }
      if (rule.status !== 200) {
        const location = dest.includes("?") ? dest : dest + url.search // query strings pass through
        return { kind: "redirect", rule: ruleText, response: new Response(null, { status: rule.status, headers: { Location: location } }) }
      }
      const target = new URL(dest, url)
      // A rewrite is served as this site; it never fetches from, or points the worker at, another one.
      if (target.origin !== url.origin) return { kind: "notfound", rule: ruleText, response: textResponse(500, "this rewrite's target is not on this site") }
      if (!target.search) target.search = url.search
      const tpath = normalizePath(target.pathname)
      const rewritten = new Request(target.toString(), req)
      // A rewrite onto a run_worker_first path goes to the worker, like a request for it would.
      const wf = binding || tpath === null ? null : matchRunWorkerFirst(this.cfg.runWorkerFirst, tpath)
      if (wf) {
        const r = workerFirst(wf, hasWorker)
        return r.kind === "worker" ? { ...r, request: rewritten } : r
      }
      const intent = tpath === null ? null : await this.intent(tpath, hasWorker ? "none" : this.cfg.notFound, this.exists)
      if (intent) {
        // A rewrite serves whatever html_handling resolves to, without the canonical 307.
        const response = await this.serve(req, url, intent.entry, intent.status, priv)
        return { kind: intent.status === 404 ? "notfound" : "rewrite", rule: ruleText, response }
      }
      const miss = await this.miss(rewritten, hasWorker, url, priv)
      if (miss.kind === "worker") return { kind: "worker", request: rewritten, rule: ruleText }
      return { ...miss, rule: ruleText }
    }

    const intent = await this.intent(path, hasWorker ? "none" : this.cfg.notFound, this.exists)
    if (!intent) return this.miss(req, hasWorker, url, priv)
    if (!isRead) return { kind: "notfound", rule: "method", response: methodNotAllowed() }
    const raw = decodePath(url.pathname)
    if (intent.redirect || raw !== path) {
      const location = encodePath(intent.redirect ?? path) + url.search
      return { kind: "redirect", rule: "html_handling", response: new Response(null, { status: 307, headers: { Location: location } }) }
    }
    const response = await this.serve(req, url, intent.entry, intent.status, priv)
    if (intent.status === 404) return { kind: "notfound", rule: "404-page", response }
    return { kind: "asset", response }
  }

  private async miss(req: Request, hasWorker: boolean, url: URL, priv: boolean): Promise<RouteResult> {
    if (!hasWorker) return { kind: "notfound", response: new Response(null, { status: 404 }) }
    const m = req.method.toUpperCase()
    // SPA + worker: browser navigations get the app shell without waking the function.
    if (this.cfg.notFound === "single-page-application" && (m === "GET" || m === "HEAD") && req.headers.get("sec-fetch-mode") === "navigate") {
      const e = await this.exists("/index.html")
      if (e) return { kind: "asset", rule: "spa-navigate", response: await this.serve(req, url, e, 200, priv) }
    }
    return { kind: "worker" }
  }

  private matchRedirect(path: string, search: string): { rule: RedirectRule; dest: string } | null {
    const hit = (c: CompiledRedirect, groups: Record<string, string | undefined>) => {
      let dest = substitute(c.rule.to, groups)
      // A path rule stays a path: a splat starting with "/" must not turn "/:splat" into "//host".
      if (c.rule.to.startsWith("/") && !c.rule.to.startsWith("//")) dest = dest.replace(/^\/+/, "/")
      // A redirect onto itself would loop forever; let the asset lookup have it.
      const q = dest.indexOf("?")
      if (c.rule.status !== 200 && normalizePath(q < 0 ? dest : dest.slice(0, q)) === path && (q < 0 || dest.slice(q) === search)) return null
      return { rule: c.rule, dest }
    }
    const s = this.staticRedirects.get(path)
    if (s) {
      const r = hit(s, {})
      if (r) return r
    }
    for (const c of this.dynamicRedirects) {
      const groups = c.match!(path)
      if (!groups) continue
      const r = hit(c, groups)
      if (r) return r
    }
    return null
  }

  // ----- serving -----

  private async serve(req: Request, url: URL, entry: Entry, status: 200 | 404, priv = false): Promise<Response> {
    const opened = await this.openVerified(entry)
    // Gone or swapped between lookup and serve: answer like a miss, never with the other file.
    if (!opened) return new Response(null, { status: 404 })
    const { fh, size, hash } = opened
    let res: Response
    try {
      res = this.respond(req, url, entry, status, fh, size, hash, priv)
    } catch (e) {
      fh.close()
      throw e
    }
    if (res.body === null) fh.close() // HEAD/304/416: the stream owns it otherwise
    return res
  }

  private respond(req: Request, url: URL, entry: Entry, status: 200 | 404, fh: Fd, size: number, hash: string, priv: boolean): Response {
    const etag = `"${hash}"`
    const h = new Headers({ "Content-Type": entry.type, ETag: etag })
    if (priv) h.set("Cache-Control", PRIVATE_CACHE_CONTROL)
    else if (!req.headers.has("authorization") && !req.headers.has("range")) h.set("Cache-Control", CACHE_CONTROL)
    this.applyHeaders(h, url)
    const head = req.method.toUpperCase() === "HEAD"
    if (status === 200 && etagMatches(req.headers.get("if-none-match"), hash)) {
      h.delete("Content-Length")
      return new Response(null, { status: 304, headers: h })
    }
    const range = status === 200 ? parseRange(req.headers.get("range"), size) : null
    if (range === "unsatisfiable") {
      h.set("Content-Range", `bytes */${size}`)
      h.delete("Content-Type")
      return new Response(null, { status: 416, headers: h })
    }
    if (range) {
      const [start, end] = range
      h.set("Content-Range", `bytes ${start}-${end}/${size}`)
      h.set("Content-Length", String(end - start + 1))
      return new Response(head ? null : fdBody(fh, start, end), { status: 206, headers: h })
    }
    h.set("Content-Length", String(size))
    return new Response(head || size === 0 ? null : fdBody(fh, 0, size - 1), { status, headers: h })
  }

  // The lookup's realpath check alone is racy: in root mode the function's user owns the asset
  // tree (deploys/ included) and could swap a file or a parent dir for a symlink to e.g. /etc/shadow
  // right after it. So open first (no final-component follow), then check what the fd really is:
  // a regular file within limits whose own path (/proc/self/fd) is inside the root, readable by the
  // user, and for snapshots the exact bytes the manifest recorded. The body is streamed from that fd.
  private async openVerified(entry: Entry): Promise<{ fh: Fd; size: number; hash: string } | null> {
    let fh: Fd
    try {
      // NONBLOCK so a FIFO swapped in can't hang the daemon on open.
      fh = await Fd.open(entry.real, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | FS.O_NOCTTY)
    } catch {
      return null
    }
    try {
      const st = await fh.stat()
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error("not a servable file")
      // A size change means the snapshot was modified after deploy. Refuse it rather than re-hash:
      // snapshots are immutable by contract, and serving a tampered file under the deploy's name is wrong.
      if (entry.manifestHash !== undefined && st.size !== entry.size) throw new Error("size changed")
      const real = await fdRealPath(fh, entry.real, st)
      if (!real || !this.inside(real)) throw new Error("outside the asset directory")
      if (this.canRead && !this.canRead(real)) throw new Error("not readable by the function's user")
      const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
      let hash = this.fdHashes.get(stamp)
      if (!hash) {
        hash = await hashHandle(fh, st.size)
        if (this.fdHashes.size >= MAX_FILES) this.fdHashes.clear()
        this.fdHashes.set(stamp, hash)
      }
      // Same size, different bytes: still not the file that was deployed.
      if (entry.manifestHash !== undefined && hash !== entry.manifestHash) throw new Error("content changed")
      return { fh, size: st.size, hash }
    } catch {
      fh.close()
      return null
    }
  }

  // First rule to set a name replaces the default; later rules append (", "). `! Name` deletes,
  // defaults included, which is how Cloudflare's own matcher behaves.
  private applyHeaders(h: Headers, url: URL) {
    const set = new Set<string>()
    for (const c of this.headerRules) {
      const groups = c.match(c.host ? url.host + decodePath(url.pathname) : (normalizePath(url.pathname) ?? url.pathname))
      if (!groups) continue
      for (const [name, value] of c.rule.set) {
        const v = substitute(value, groups)
        const k = name.toLowerCase()
        if (set.has(k)) h.append(name, v)
        else {
          h.set(name, v)
          set.add(k)
        }
      }
      for (const name of c.rule.unset) {
        h.delete(name)
        set.delete(name.toLowerCase())
      }
    }
  }

  // ----- lookup -----

  // Dev always stats the disk (the index is a cache that can lag the watcher's debounce).
  // Snapshots take the file list from the manifest but still check the disk like dev: the deploy
  // dir belongs to the function's user, so a file may have been swapped for a symlink since.
  private exists: Exists = async (p: string) => {
    if (!this.root || !p.startsWith("/") || p.endsWith("/")) return null
    if (this.mode === "snapshot") {
      const m = this.index.get(p)
      if (!m) return null
      const e = await this.statEntry(m.real, p)
      if (!e || e.size !== m.size) return null
      if (this.canRead && !this.canRead(e.real)) return null
      return { ...e, size: m.size, type: m.type, manifestHash: m.manifestHash }
    }
    const rel = p.slice(1)
    const e = await this.statEntry(join(this.root, rel), p)
    // .assetsignore globs are regexes: only run them on paths that exist, never on any visitor path
    if (!e || this.hidden(rel)) return null
    if (e.size > MAX_FILE_BYTES) return null
    if (this.canRead && !this.canRead(e.real)) return null
    return e
  }

  private hidden(rel: string): boolean {
    return CONTROL_FILES.has(rel) || this.ignore(rel)
  }

  private async statEntry(abs: string, urlPath: string): Promise<Entry | null> {
    let real: string
    try {
      real = await realpath(abs)
    } catch {
      return null
    }
    if (!this.inside(real)) return null // symlink out of the asset dir
    let st: Stats
    try {
      st = await stat(real)
    } catch {
      return null
    }
    if (!st.isFile()) return null
    return { path: urlPath, real, size: st.size, mtimeMs: st.mtimeMs, type: contentTypeFor(urlPath) }
  }

  private inside(real: string) {
    return real === this.root || real.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep)
  }

  // Port of Cloudflare's asset-worker getIntent: exact table per html_handling mode.
  private async intent(path: string, notFound: NotFoundHandling, exists: Exists, skipRedirects = false): Promise<Intent | null> {
    const ok = (entry: Entry): Intent => ({ entry, status: 200, redirect: null })
    const safe = async (file: string, dest: string): Promise<Intent | null> => {
      if (skipRedirects) return null
      if (await exists(dest)) return null
      const target = await this.intent(dest, notFound, exists, true)
      const f = await exists(file)
      // Cloudflare compares eTags; we compare the resolved file, which is the same thing without hashing.
      if (target && f && target.status === 200 && target.entry.real === f.real) return { entry: target.entry, status: 200, redirect: dest }
      return null
    }
    let r: Intent | null
    let e: Entry | null
    const exact = await exists(path)
    switch (this.cfg.html) {
      case "none":
        if (exact) return ok(exact)
        break

      case "auto-trailing-slash":
        if (path.endsWith("/index")) {
          if (exact) return ok(exact)
          if ((r = await safe(`${path}.html`, path.slice(0, -"index".length)))) return r
          if ((r = await safe(`${path.slice(0, -"/index".length)}.html`, path.slice(0, -"/index".length)))) return r
        } else if (path.endsWith("/index.html")) {
          if ((r = await safe(path, path.slice(0, -"index.html".length)))) return r
          if ((r = await safe(`${path.slice(0, -"/index.html".length)}.html`, path.slice(0, -"/index.html".length)))) return r
        } else if (path === "/") {
          if ((e = await exists("/index.html"))) return ok(e)
        } else if (path.endsWith("/")) {
          if ((e = await exists(`${path}index.html`))) return ok(e)
          if ((r = await safe(`${path.slice(0, -1)}.html`, path.slice(0, -1)))) return r
        } else if (path.endsWith(".html")) {
          if ((r = await safe(path, path.slice(0, -".html".length)))) return r
          if ((r = await safe(`${path.slice(0, -".html".length)}/index.html`, `${path.slice(0, -".html".length)}/`))) return r
        }
        if (exact) return ok(exact)
        if ((e = await exists(`${path}.html`))) return ok(e)
        if ((r = await safe(`${path}/index.html`, `${path}/`))) return r
        break

      case "force-trailing-slash":
        if (path.endsWith("/index")) {
          if (exact) return ok(exact)
          if ((r = await safe(`${path}.html`, path.slice(0, -"index".length)))) return r
          if ((r = await safe(`${path.slice(0, -"/index".length)}.html`, path.slice(0, -"index".length)))) return r
        } else if (path.endsWith("/index.html")) {
          if ((r = await safe(path, path.slice(0, -"index.html".length)))) return r
          if ((r = await safe(`${path.slice(0, -"/index.html".length)}.html`, path.slice(0, -"index.html".length)))) return r
        } else if (path.endsWith("/")) {
          if ((e = await exists(`${path}index.html`))) return ok(e)
          if ((e = await exists(`${path.slice(0, -1)}.html`))) return ok(e)
        } else if (path.endsWith(".html")) {
          if ((r = await safe(path, `${path.slice(0, -".html".length)}/`))) return r
          if (exact) return ok(exact) // both /foo.html and /foo/index.html: /foo.html stays reachable as is
          if ((r = await safe(`${path.slice(0, -".html".length)}/index.html`, `${path.slice(0, -".html".length)}/`))) return r
        }
        if (exact) return ok(exact)
        if ((r = await safe(`${path}.html`, `${path}/`))) return r
        if ((r = await safe(`${path}/index.html`, `${path}/`))) return r
        break

      case "drop-trailing-slash":
        if (path.endsWith("/index")) {
          if (exact) return ok(exact)
          if (path === "/index") {
            if ((r = await safe("/index.html", "/"))) return r
          } else if ((r = await safe(`${path.slice(0, -"/index".length)}.html`, path.slice(0, -"/index".length)))) return r
          else if ((r = await safe(`${path}.html`, path.slice(0, -"/index".length)))) return r
        } else if (path === "/index.html") {
          if ((r = await safe("/index.html", "/"))) return r
        } else if (path.endsWith("/index.html")) {
          if ((r = await safe(path, path.slice(0, -"/index.html".length)))) return r
          if (exact) return ok(exact) // both /foo.html and /foo/index.html: keep /foo/index.html reachable
          if ((r = await safe(`${path.slice(0, -"/index.html".length)}.html`, path.slice(0, -"/index.html".length)))) return r
        } else if (path === "/") {
          if ((e = await exists("/index.html"))) return ok(e)
        } else if (path.endsWith("/")) {
          if ((r = await safe(`${path}index.html`, path.slice(0, -1)))) return r
          if ((r = await safe(`${path.slice(0, -1)}.html`, path.slice(0, -1)))) return r
        } else if (path.endsWith(".html")) {
          if ((r = await safe(path, path.slice(0, -".html".length)))) return r
          if ((r = await safe(`${path.slice(0, -".html".length)}/index.html`, path.slice(0, -".html".length)))) return r
        }
        if (exact) return ok(exact)
        if ((e = await exists(`${path}.html`))) return ok(e)
        if ((e = await exists(`${path}/index.html`))) return ok(e)
        break
    }
    return this.notFound(path, notFound, exists)
  }

  private async notFound(path: string, mode: NotFoundHandling, exists: Exists): Promise<Intent | null> {
    if (mode === "single-page-application") {
      const e = await exists("/index.html")
      return e ? { entry: e, status: 200, redirect: null } : null
    }
    if (mode === "404-page") {
      // Nearest 404.html walking up from the requested path.
      for (let cwd = path; cwd;) {
        cwd = cwd.slice(0, cwd.lastIndexOf("/"))
        const e = await exists(`${cwd}/404.html`)
        if (e) return { entry: e, status: 404, redirect: null }
      }
    }
    return null
  }

  // ----- control files and index -----

  private async readControl(name: string): Promise<string | null> {
    const r = await readVerified(join(this.root, name), MAX_CONTROL_FILE, { inside: real => this.inside(real), canRead: this.canRead })
    if (typeof r === "string" || r === null) return r
    const why = { outside: "is a symlink out of the asset directory", large: `is larger than ${MAX_CONTROL_FILE} bytes`, unreadable: "is not readable by the function's user", special: "is not a regular file" }[r.error]
    this.controlWarnings.set(name, [`${name} ${why}, ignored`])
    return null
  }

  // Cheap per-request stat of the three control files in dev, so edits apply on the next request
  // even if the watcher is off or hasn't fired yet.
  private async refreshControl(force = false) {
    if (this.mode === "snapshot") return
    for (const name of CONTROL_FILES) {
      const st = await stat(join(this.root, name)).catch(() => null)
      const stamp = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "-"
      if (!force && this.controlStamp.get(name) === stamp) continue
      this.controlStamp.set(name, stamp)
      this.controlWarnings.delete(name)
      const text = st ? await this.readControl(name).catch(() => null) : null
      if (name === "_redirects") this.setRedirects(text ? parseRedirects(text) : { rules: [], warnings: [] })
      else if (name === "_headers") this.setHeaders(text ? parseHeaders(text) : { rules: [], warnings: [] })
      else this.ignore = text ? parseAssetsIgnore(text) : () => false
    }
  }

  private setRedirects(p: { rules: RedirectRule[]; warnings: string[] }) {
    this.staticRedirects.clear()
    this.dynamicRedirects = []
    for (const rule of p.rules) {
      // Manifest rules are user-written JSON: take only the shape parseRedirects produces
      if (typeof rule?.from !== "string" || typeof rule.to !== "string" || !REDIRECT_CODES.has(rule.status)) continue
      if (!isDynamic(rule.from)) {
        if (!this.staticRedirects.has(rule.from)) this.staticRedirects.set(rule.from, { rule, match: null })
        continue
      }
      const match = compilePattern(rule.from)
      if (match) this.dynamicRedirects.push({ rule, match })
    }
    if (p.warnings.length) this.controlWarnings.set("_redirects", p.warnings)
  }

  private setHeaders(p: { rules: HeaderRule[]; warnings: string[] }) {
    this.headerRules = []
    for (const rule of p.rules) {
      if (typeof rule?.pattern !== "string" || !Array.isArray(rule.set) || !Array.isArray(rule.unset)) continue
      const host = /^https?:\/\//.test(rule.pattern)
      const match = compilePattern(host ? rule.pattern.replace(/^https?:\/\//, "") : rule.pattern)
      if (match) this.headerRules.push({ rule, host, match })
    }
    if (p.warnings.length) this.controlWarnings.set("_headers", p.warnings)
  }

  private async loadManifest(): Promise<boolean> {
    let m: Manifest
    try {
      // User-owned in root mode: read it like a control file, never through a swapped-in symlink or device
      const path = manifestPathFor(this.root)
      const text = await readVerified(path, MAX_MANIFEST, { inside: real => real === path, canRead: this.canRead })
      if (typeof text !== "string") return false
      m = JSON.parse(text)
      if (!m || typeof m !== "object") return false
    } catch {
      return false
    }
    for (const [p, f] of Object.entries(m.files ?? {})) {
      // The manifest is user-writable in root mode: take only well-formed entries, and derive the
      // type from the path rather than trusting it.
      if (normalizePath(p) !== p || p.endsWith("/") || CONTROL_FILES.has(p.slice(1))) continue
      if (!f || typeof f.hash !== "string" || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) continue
      const real = join(this.root, p.slice(1))
      if (!this.inside(real)) continue
      this.index.set(p, { path: p, real, size: f.size, mtimeMs: 0, hash: f.hash, type: contentTypeFor(p), manifestHash: f.hash })
    }
    this.setRedirects({ rules: Array.isArray(m.redirects) ? m.redirects : [], warnings: [] })
    this.setHeaders({ rules: Array.isArray(m.headers) ? m.headers : [], warnings: [] })
    this.indexWarnings = Array.isArray(m.warnings) ? m.warnings.filter(w => typeof w === "string") : []
    return true
  }

  // Walks the tree: follows symlinks that stay inside, refuses ones that escape, hashes each file
  // (cached by inode stamp in openVerified, so a rebuild only rehashes what changed).
  private async rebuild() {
    await this.refreshControl(true)
    const index = new Map<string, Entry>()
    const warnings: string[] = []
    const errors: string[] = []
    const seenDirs = new Set<string>([this.root])
    const walk = async (dirReal: string, rel: string) => {
      let ents
      try {
        ents = await readdir(dirReal, { withFileTypes: true })
      } catch {
        warnings.push(`cannot read ${rel || "/"}, skipped`)
        return
      }
      ents.sort((a, b) => (a.name < b.name ? -1 : 1))
      for (const d of ents) {
        if (this.closed) return
        const childRel = rel ? `${rel}/${d.name}` : d.name
        if (this.hidden(childRel)) continue
        const abs = join(dirReal, d.name)
        let real = abs
        if (d.isSymbolicLink()) {
          try {
            real = await realpath(abs)
          } catch {
            continue // dangling
          }
          if (!this.inside(real)) {
            warnings.push(`/${childRel} is a symlink out of the asset directory, not served`)
            continue
          }
        }
        const st = await stat(real).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) {
          if (seenDirs.has(real)) continue // symlink loop
          seenDirs.add(real)
          await walk(real, childRel)
          continue
        }
        if (!st.isFile()) continue
        if (st.size > MAX_FILE_BYTES) {
          errors.push(`/${childRel} is ${st.size} bytes, over the ${MAX_FILE_BYTES} byte limit, not served`)
          continue
        }
        if (this.canRead && !this.canRead(real)) continue
        if (index.size >= MAX_FILES) {
          errors.push(`more than ${MAX_FILES} files, the rest are not indexed`)
          return
        }
        const e: Entry = { path: `/${childRel}`, real, size: st.size, mtimeMs: st.mtimeMs, type: contentTypeFor(childRel) }
        // Hashed from a checked fd like serving: the path may have been swapped since the stat
        const opened = await this.openVerified(e)
        if (!opened) continue
        e.hash = opened.hash
        opened.fh.close()
        index.set(e.path, e)
      }
    }
    await walk(this.root, "")
    if (index.size > CF_FILES_WARNING) warnings.push(`${index.size} files: Cloudflare's limit is ${CF_FILES_WARNING} per Worker`)
    this.index = index
    this.indexWarnings = warnings
    this.indexErrors = [...new Set(errors)]
  }

  /** @internal for snapshotAssets */
  async snapshotData() {
    return {
      root: this.root,
      entries: [...this.index.values()],
      errors: this.indexErrors,
      redirects: [...this.staticRedirects.values(), ...this.dynamicRedirects].map(c => c.rule).sort((a, b) => a.line - b.line),
      headers: this.headerRules.map(c => c.rule),
    }
  }
}

// ---------- snapshot ----------

// Copies the filtered tree into destDir (the deploy's assets/ dir), read-only, and writes the
// manifest next to it. Oversized files and file-count overflow fail the deploy; bad rule lines are warnings.
export async function snapshotAssets(cfg: AssetsConfig, destDir: string): Promise<{ manifestPath: string; files: number; bytes: number; warnings: string[] }> {
  const server = await AssetServer.open(cfg, { mode: "dev", index: true })
  try {
    if (!server.attached) throw new Error(`assets directory ${cfg.directory} does not exist or is not a directory`)
    const data = await server.snapshotData()
    if (data.errors.length) throw new Error(`assets: ${data.errors.join("; ")}`)
    const existing = await readdir(destDir).catch(() => [] as string[])
    if (existing.length) throw new Error(`snapshot destination ${destDir} is not empty`)
    await mkdir(destDir, { recursive: true })
    const files: Manifest["files"] = {}
    const dirs = new Set<string>([destDir])
    let bytes = 0
    for (const e of data.entries) {
      const out = join(destDir, e.path.slice(1))
      for (let d = dirname(out); d.length > destDir.length; d = dirname(d)) dirs.add(d)
      await mkdir(dirname(out), { recursive: true })
      await Bun.write(out, Bun.file(e.real)) // streamed copy, symlinks resolved
      await chmod(out, 0o444)
      const st = await stat(out)
      // Hash the copy: the source may have changed since the index was built.
      const hash = await hashFile(out)
      files[e.path] = { hash, size: st.size, type: e.type }
      bytes += st.size
    }
    // Deepest first, so a read-only parent never blocks a child chmod.
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) await chmod(d, 0o555)
    const manifest: Manifest = { version: 1, files, headers: data.headers, redirects: data.redirects, warnings: server.warnings }
    const manifestPath = manifestPathFor(destDir)
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    await chmod(manifestPath, 0o444)
    return { manifestPath, files: Object.keys(files).length, bytes, warnings: server.warnings }
  } finally {
    server.close()
  }
}

// ---------- helpers ----------

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

// Cloudflare decodes per segment and keeps a segment as is if it isn't valid percent-encoding.
function decodePath(p: string): string {
  return p.split("/").map(seg => {
    try {
      return decodeURIComponent(seg)
    } catch {
      return seg
    }
  }).join("/")
}

// Decoded, with repeated slashes collapsed; null for NUL or dot segments (never a file).
export function normalizePath(raw: string): string | null {
  const p = decodePath(raw).replace(/\/+/g, "/")
  if (!p.startsWith("/") || p.includes("\0")) return null
  if (p.split("/").some(s => s === "." || s === "..")) return null
  return p
}

function encodePath(p: string): string {
  return p.split("/").map(seg => encodeURIComponent(seg).replace(/%(40|3A|21|24|26|27|28|29|2A|2B|2C|3B|3D)/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))).join("/")
}

const methodNotAllowed = () => new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } })

const textResponse = (status: number, text: string) =>
  new Response(text + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } })

function workerFirst(pattern: string, hasWorker: boolean): RouteResult {
  const rule = pattern === "true" ? "worker-first" : `worker-first:${pattern}`
  if (hasWorker) return { kind: "worker", rule }
  // Caught at add/deploy; still never fall through to assets the user said aren't first.
  return { kind: "notfound", rule, response: textResponse(500, "run_worker_first is set but this function has no main") }
}

function etagMatches(header: string | null, hash: string): boolean {
  if (!header) return false
  return header.split(",").some(t => {
    const v = t.trim()
    return v === "*" || v === `"${hash}"` || v === `W/"${hash}"`
  })
}

// Single range only; multi-range and junk fall back to the full body, like most servers.
function parseRange(header: string | null, size: number): [number, number] | "unsatisfiable" | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === "" && m[2] === "")) return null
  let start: number
  let end: number
  if (m[1] === "") {
    const n = Number(m[2])
    if (n === 0) return "unsatisfiable"
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)
    if (m[2] !== "" && Number(m[2]) < start) return null
  }
  if (start >= size) return "unsatisfiable"
  return [start, end]
}

// A raw fd closed exactly once: explicitly when a body ends or is cancelled, or by the finalizer
// when a response is dropped unread (a FileHandle would throw on GC instead).
class Fd {
  private closed = false
  constructor(readonly fd: number) {}
  static open(path: string, flags: number): Promise<Fd> {
    return new Promise((ok, fail) => openCb(path, flags, (err, fd) => (err ? fail(err) : ok(new Fd(fd)))))
  }
  stat(): Promise<Stats> {
    return new Promise((ok, fail) => fstat(this.fd, (err, st) => (err ? fail(err) : ok(st))))
  }
  read(buf: Uint8Array, off: number, len: number, pos: number): Promise<{ bytesRead: number }> {
    if (this.closed) return Promise.reject(new Error("fd closed"))
    return new Promise((ok, fail) => readCb(this.fd, buf, off, len, pos, (err, bytesRead) => (err ? fail(err) : ok({ bytesRead }))))
  }
  close() {
    if (this.closed) return
    this.closed = true
    try {
      closeSync(this.fd)
    } catch {}
  }
}
const fdFinalizer = new FinalizationRegistry<Fd>(fd => fd.close())

// Where an open fd really points. /proc/self/fd names the opened inode itself, so a later swap of the
// path can't fool it; the stat comparison makes sure that name still is the same inode (not unlinked,
// not replaced), which is what canRead and the containment check then look at.
async function fdRealPath(fh: Fd, fallback: string, st: Stats): Promise<string | null> {
  let real: string
  try {
    real = await readlink(`/proc/self/fd/${fh.fd}`)
  } catch {
    real = await realpath(fallback).catch(() => "") // no /proc: same check, by path
  }
  if (!real.startsWith("/")) return null
  const now = await stat(real).catch(() => null)
  if (!now || now.dev !== st.dev || now.ino !== st.ino) return null
  return real
}

// Reads a small file the user controls (a control file, a deploy's manifest) the way openVerified
// serves one: open without following a final symlink or blocking on a FIFO, then check the fd itself
// (regular file within `cap`, real path where expected, readable by the user) and read at most `cap`
// bytes from it. A swap between any check and the read can't point root at another file or a device.
export async function readVerified(
  path: string,
  cap: number,
  check: { inside(real: string): boolean; canRead?(real: string): boolean },
): Promise<string | null | { error: "outside" | "large" | "unreadable" | "special" }> {
  let real: string
  try {
    real = await realpath(path) // symlinks that stay inside are fine; the fd check below decides
  } catch {
    return null
  }
  if (!check.inside(real)) return { error: "outside" }
  let fh: Fd
  try {
    fh = await Fd.open(real, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | FS.O_NOCTTY)
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ELOOP" ? { error: "outside" } : null
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return { error: "special" }
    if (st.size > cap) return { error: "large" }
    const at = await fdRealPath(fh, real, st)
    if (!at || !check.inside(at)) return { error: "outside" }
    if (check.canRead && !check.canRead(at)) return { error: "unreadable" }
    // Bounded even if it grows after the fstat: one byte past the cap means too large
    const buf = new Uint8Array(Math.min(st.size, cap) + 1)
    let n = 0
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (bytesRead === 0) break
      n += bytesRead
    }
    if (n > cap) return { error: "large" }
    return new TextDecoder().decode(buf.subarray(0, n))
  } finally {
    fh.close()
  }
}

async function hashHandle(fh: Fd, size: number): Promise<string> {
  const h = new Bun.CryptoHasher("sha256")
  const buf = new Uint8Array(Math.min(Math.max(size, 1), FD_CHUNK))
  for (let pos = 0; pos < size; ) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos)
    if (bytesRead === 0) throw new Error("file shrank while hashing")
    h.update(buf.subarray(0, bytesRead))
    pos += bytesRead
  }
  return h.digest("hex").slice(0, 32)
}

const FD_CHUNK = 256 * 1024

// Streams [start, end] of an already verified fd and closes it when done or cancelled.
function fdBody(fh: Fd, start: number, end: number): ReadableStream<Uint8Array> {
  let pos = start
  const done = () => {
    fdFinalizer.unregister(fh)
    fh.close()
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        if (pos > end) {
          done()
          return c.close()
        }
        const n = Math.min(FD_CHUNK, end - pos + 1)
        const buf = new Uint8Array(n)
        const { bytesRead } = await fh.read(buf, 0, n, pos)
        if (bytesRead === 0) {
          done()
          return c.error(new Error("asset file shrank while serving"))
        }
        pos += bytesRead
        c.enqueue(bytesRead === n ? buf : buf.subarray(0, bytesRead))
      } catch (e) {
        done()
        c.error(e)
      }
    },
    cancel: () => done(),
  })
  fdFinalizer.register(stream, fh, fh)
  return stream
}

async function hashFile(p: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(p).stream()) h.update(chunk)
  return h.digest("hex").slice(0, 32)
}
