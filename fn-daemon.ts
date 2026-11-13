// Pure pieces of the daemon's function support (see FUNCTIONS_DESIGN.md), kept
// out of daemon.ts so they can be unit-tested without starting a daemon:
// settings validation, socket paths, request header sanitising, and how a
// function launch and an fn-tool run are put together.

import { stripCandyCredentials } from "./server-auth.ts"
import { PROXY_TAG_HEADER } from "./caddy-config.ts"
import { isDeployId, type DeployInfo } from "./fn-deploy.ts"
import type { AssetsConfig, AssetsRouting, RouteOptions, RouteResult } from "./fn-assets.ts"
import type { FnLog } from "./fn-log.ts"

export interface FnSettings {
  entry: string | null     // module path relative to cwd (validated to stay inside it); null = assets only
  deploy?: string          // pinned deploy id; absent = live dev code
  hot?: number             // warm instances kept up (default 0)
  max?: number             // cap on concurrent instances (default 4)
  linger?: number          // seconds an idle instance waits for the next request (default 30)
  log?: false | "meta"     // request log off or metadata only; absent = full
}

export const FN_DEFAULT_MAX = 4
export const FN_MAX_INSTANCES = 64
export const FN_DEFAULT_LINGER_S = 30
export const FN_MAX_LINGER_S = 600

const CONTROL = /[\x00-\x1f\x7f]/

// A stored `fn` block, or null when it is unusable. Bad optional fields are dropped.
export const normalizeFnSettings = (raw: unknown): FnSettings | null => {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  // null is an assets-only function; a missing or broken entry is unusable
  if (r.entry !== null && (typeof r.entry !== "string" || !r.entry || r.entry.length > 1024 || CONTROL.test(r.entry))) return null
  const fn: FnSettings = { entry: r.entry as string | null }
  if (isDeployId(r.deploy)) fn.deploy = r.deploy
  if (Number.isInteger(r.hot) && (r.hot as number) >= 0 && (r.hot as number) <= FN_MAX_INSTANCES) fn.hot = r.hot as number
  if (Number.isInteger(r.max) && (r.max as number) >= 1 && (r.max as number) <= FN_MAX_INSTANCES) fn.max = r.max as number
  if (Number.isInteger(r.linger) && (r.linger as number) >= 0 && (r.linger as number) <= FN_MAX_LINGER_S) fn.linger = r.linger as number
  if (r.log === false || r.log === "meta") fn.log = r.log
  return fn
}

export const fnLimits = (fn: Pick<FnSettings, "hot" | "max">) => {
  const max = fn.max ?? FN_DEFAULT_MAX
  return { max, hot: Math.min(fn.hot ?? 0, max) }
}

export const fnFileName = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_")

// Unix socket paths are limited to 108 bytes, so long names get a hashed file
// name. Those live in h/, which no plain name can reach (<name>.sock is a file
// in the top folder), so one user's name can't be another's hash.
export const fnSocketPath = (dir: string, name: string): string => {
  const plain = `${dir}/${fnFileName(name)}.sock`
  if (plain.length < 100) return plain
  return `${dir}/h/${new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 24)}.sock`
}

// Headers a function sees: no hop-by-hop headers, never candy's own
// verification marker or Caddy's proxy tag, and on a password-protected domain none of the
// visitor's candy credentials (the function must not be able to replay them).
export const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"]
export const fnRequestHeaders = (src: Headers, opts: { stripCredentials: boolean }): Headers => {
  const headers = new Headers(src)
  for (const h of HOP_BY_HOP) headers.delete(h)
  headers.delete("x-candy-verified")
  // The daemon strips it on arrival; this keeps it out even if that changes
  headers.delete(PROXY_TAG_HEADER)
  if (opts.stripCredentials) stripCandyCredentials(headers)
  return headers
}

// Which function a request is for, decided before any daemon route: every
// path on a function's host (/fn/*, /process/* included) is the function's,
// except a bound domain's login pages (/candy-auth/*).
export const fnTargetForRequest = <B>(
  host: string,
  path: string,
  look: {
    binding(host: string): { serverName: string; binding: B } | null
    localName(host: string): string | null  // <name>.localhost / .candy, else null
    isFn(name: string): boolean
  },
): { name: string; binding: B | null } | null => {
  const clean = host.replace(/:\d+$/, "").toLowerCase()
  if (!clean) return null
  const bound = look.binding(clean)
  if (bound) {
    if (!look.isFn(bound.serverName) || path.startsWith("/candy-auth/")) return null
    return { name: bound.serverName, binding: bound.binding }
  }
  if (!clean.endsWith(".localhost") && !clean.endsWith(".candy")) return null
  const name = look.localName(clean)
  return name && look.isFn(name) ? { name, binding: null } : null
}

// argv after `bash -c 'exec "$@"' candy`: bun, the shim, the entry, and for a
// cron run `--scheduled <expr>` (fixed by candy, never user text in a shell)
export const fnLaunchArgs = (o: { bun: string; moduleDir: string; entry: string; cronArgs?: string[] }): string[] =>
  [o.bun, `${o.moduleDir}/fn-host.ts`, o.entry, ...(o.cronArgs ?? [])]

export const fnLaunchEnv = (o: {
  stateDir: string
  project: unknown
  secretKeys: string[]
  lingerS?: number
  instance?: { id: string; token: string; socketPath: string }
  // The shim's env.ASSETS: the live directory in dev, the deploy's assets/ when pinned
  assets?: { dir: string; mode: "dev" | "snapshot" } | null
}): Record<string, string> => {
  const env: Record<string, string> = {
    CANDY_FN_STATE: o.stateDir,
    CANDY_FN_CONFIG: JSON.stringify(o.project),
    CANDY_FN_SECRET_KEYS: o.secretKeys.join(","),
    CANDY_FN_LINGER_MS: String((o.lingerS ?? FN_DEFAULT_LINGER_S) * 1000),
  }
  if (o.assets) {
    env.CANDY_FN_ASSETS_DIR = o.assets.dir
    env.CANDY_FN_ASSETS_MODE = o.assets.mode
  }
  if (o.instance) {
    env.CANDY_FN_SOCKET = o.instance.socketPath
    env.CANDY_FN_TOKEN = o.instance.token
    env.CANDY_FN_INSTANCE = o.instance.id
  }
  return env
}

// Root mode: run fn-tool as the function's user, with a clean env. `bun` is
// a fixed binary chosen by the daemon, never one found through the user's PATH.
export const fnToolCommand = (o: {
  account: { uid: number; gid: number; name: string; home: string }
  bun: string
  moduleDir: string
  op: string
  path?: string
}): string[] => {
  if (!Number.isInteger(o.account.uid) || o.account.uid === 0) throw new Error("fn-tool never runs as root")
  return [
    "setpriv", `--reuid=${o.account.uid}`, `--regid=${o.account.gid}`, "--init-groups", "--",
    "env", "-i", `HOME=${o.account.home}`, `USER=${o.account.name}`, `LOGNAME=${o.account.name}`,
    `PATH=${o.path ?? "/usr/local/bin:/usr/bin:/bin"}`,
    o.bun, `${o.moduleDir}/fn-tool.ts`, o.op,
  ]
}

// A bun binary root can hand to fn-tool: the daemon's own when it sits outside
// any user's home (users can't swap it), else null (fall back to a system bun)
export const pinnedBun = (execPath: string, candidates: string[], exists: (p: string) => boolean): string | null => {
  const inHome = (p: string) => /^\/(home|root)\//.test(p)
  for (const p of [execPath, ...candidates]) if (p && p.startsWith("/") && !inHome(p) && exists(p)) return p
  return null
}

// ---- Static assets (see FUNCTIONS_DESIGN.md "Static assets") ----

// A deploy snapshot made before the project dropped its assets block still serves its files, with defaults
export const FN_DEFAULT_ASSETS: AssetsRouting = { binding: null, notFound: "none", html: "auto-trailing-slash", runWorkerFirst: false }

export interface FnAssetsPlan {
  hasWorker: boolean
  config: AssetsConfig | null // what the daemon's router and the shim's env.ASSETS both use
  mode: "dev" | "snapshot"
  // deploy: recorded in the deploy; live: dev; live-fallback / default: a deploy whose manifest
  // didn't record its routing, served with the live config (or defaults), which the caller logs
  source: "live" | "deploy" | "live-fallback" | "default" | null
}

// Which assets config serves a function. A pinned deploy routes with the config recorded in it
// (checked by fn-tool's checkDeployInfo), so rolling back also rolls back not_found_handling,
// html_handling, run_worker_first and the binding; dev uses the live project config.
export const fnAssetsPlan = (project: { main: string | null; assets?: AssetsConfig | null }, deploy: DeployInfo | null): FnAssetsPlan => {
  if (!deploy) {
    const config = project.assets ?? null
    return { hasWorker: !!project.main, config, mode: "dev", source: config ? "live" : null }
  }
  const hasWorker = !!deploy.entry
  if (!deploy.assets) return { hasWorker, config: null, mode: "snapshot", source: null }
  if (deploy.assetsConfig) return { hasWorker, config: { ...deploy.assetsConfig, directory: deploy.assets }, mode: "snapshot", source: "deploy" }
  const live = project.assets
  const routing: AssetsRouting = live
    ? { binding: live.binding, notFound: live.notFound, html: live.html, runWorkerFirst: live.runWorkerFirst }
    : FN_DEFAULT_ASSETS
  return { hasWorker, config: { ...routing, directory: deploy.assets }, mode: "snapshot", source: live ? "live-fallback" : "default" }
}

// The project config handed to the shim (CANDY_FN_CONFIG): with a pinned deploy its assets block is
// the deploy's, so env.ASSETS (binding name, html/not_found handling) behaves like the deploy.
export const fnShimProject = <P extends { assets?: AssetsConfig | null }>(project: P, plan: FnAssetsPlan): P =>
  plan.mode === "snapshot" ? { ...project, assets: plan.config } : project

// What the server list and /fn/* show of a function's assets
export const fnAssetsSummary = (a: AssetsConfig | null | undefined) =>
  a ? { directory: a.directory, binding: a.binding, notFound: a.notFound, html: a.html, runWorkerFirst: a.runWorkerFirst } : null

export interface FnRouted {
  response: Response
  // "worker" when the function answered; otherwise what the asset router decided
  kind: RouteResult["kind"]
  rule: string | null
}

// The routing decision for one request, made before any instance is touched.
// With assets, the router decides: files, redirects and 404s are answered
// here (no instance, no port); only "worker" reaches `worker()`, with the
// rewritten request when a 200 _redirects rule pointed at a non-asset path.
// Without assets, everything goes to the worker.
export const routeFunctionRequest = async (
  req: Request,
  o: {
    assets: { route(req: Request, opts: RouteOptions): Promise<RouteResult> } | null
    hasWorker: boolean
    // a password-protected domain: asset responses must not land in a shared cache
    private?: boolean
    worker(req: Request, rule: string | null): Promise<Response>
  },
): Promise<FnRouted> => {
  if (!o.assets) {
    if (!o.hasWorker) return { response: new Response(null, { status: 404 }), kind: "notfound", rule: null }
    return { response: await o.worker(req, null), kind: "worker", rule: null }
  }
  const r = await o.assets.route(req, { hasWorker: o.hasWorker, private: o.private })
  const rule = r.rule ?? null
  if (r.kind !== "worker") return { response: r.response ?? new Response(null, { status: 404 }), kind: r.kind, rule }
  // Keep the original's method, headers, body and abort signal; only the URL is rewritten
  const target = r.request && r.request.url !== req.url
    ? new Request(r.request.url, {
        method: req.method, headers: req.headers, body: req.body, signal: req.signal, redirect: "manual",
        // @ts-ignore streaming request bodies
        duplex: "half",
      })
    : req
  return { response: await o.worker(target, rule), kind: "worker", rule }
}

// One asset hit in the request log: meta only (no bodies), plus the rule
export const logAssetResponse = (
  log: Pick<FnLog, "begin"> | null,
  meta: { requestId: string; fn: string; host: string; req: Request; clientIp: string; rule: string | null; startedAt: number },
  res: Response,
) => {
  if (!log) return
  try {
    const url = new URL(meta.req.url)
    const hooks = log.begin({
      requestId: meta.requestId, fn: meta.fn, host: meta.host, method: meta.req.method, url: url.pathname + url.search,
      clientIp: meta.clientIp, reqHeaders: [...meta.req.headers], instance: "", cold: false,
      queuedMs: performance.now() - meta.startedAt, kind: "asset", rule: meta.rule,
    })
    hooks.onResponseHead?.(res.status, [...res.headers])
    hooks.onEnd?.("ok")
  } catch (e) {
    console.error(`[fn] ${meta.fn}: request log failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// One routing per function, opened on first use and reopened when what it was opened from (the
// key) changes. prepare() may await (the project config); a function removed or replaced during
// that await must not get a routing stored for it: whatever was opened is closed instead, and only
// the request that asked still uses it.
export class FnRoutingCache<R> {
  private entries = new Map<string, { key: string; ready: Promise<R>; value?: R }>()
  constructor(private closeRouting: (r: R) => void) {}

  async get(name: string, prepare: () => Promise<{ key: string; open(): Promise<R> }>, stillCurrent: () => boolean): Promise<R> {
    const { key, open } = await prepare()
    const cur = this.entries.get(name)
    if (cur && cur.key === key) return cur.ready
    const ready = open()
    if (!stillCurrent()) {
      ready.then(r => this.closeRouting(r), () => {})
      return ready
    }
    const entry: { key: string; ready: Promise<R>; value?: R } = { key, ready }
    this.entries.set(name, entry)
    // The old one keeps answering requests already routed to it; only its watcher stops
    cur?.ready.then(r => this.closeRouting(r), () => {})
    // A failure (deploy gone, bad config) is retried on the next request
    ready.then(r => { entry.value = r }, () => { if (this.entries.get(name) === entry) this.entries.delete(name) })
    return ready
  }

  // What is routing right now, if it has been opened
  current(name: string): R | undefined {
    return this.entries.get(name)?.value
  }

  reset(name: string) {
    const cur = this.entries.get(name)
    this.entries.delete(name)
    cur?.ready.then(r => this.closeRouting(r), () => {})
  }
}

export interface FnRoutingState {
  hasWorker: boolean
  deploy: string | null // the deploy it was opened for
  assetsConfig: AssetsConfig | null
}

// What the server list and /fn/* show of a function, from the routing actually in use: a pinned
// deploy's own assets config and worker, not the live project's. `entry` is for display only;
// `hasWorker` decides "assets-only". Without a routing (it failed to open) the live project
// config stands in and `source` is null.
export const fnSummaryOf = (
  fn: FnSettings,
  routing: FnRoutingState | null,
  live: { main: string | null; assets?: AssetsConfig | null } | null,
) => ({
  entry: fn.entry,
  deploy: fn.deploy ?? null,
  hot: fnLimits(fn).hot,
  max: fnLimits(fn).max,
  linger: fn.linger ?? FN_DEFAULT_LINGER_S,
  log: fn.log === undefined ? true : fn.log,
  hasWorker: routing ? routing.hasWorker : live ? !!live.main : fn.entry !== null,
  source: routing ? (routing.deploy ? `deploy:${routing.deploy}` : "live") : null,
  assets: fnAssetsSummary(routing ? routing.assetsConfig : live?.assets),
})
