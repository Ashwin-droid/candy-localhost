// Host shim for candy functions: `bun fn-host.ts <entry> [--scheduled <cron>]`.
// It never listens on anything. It dials the daemon's socket (CANDY_FN_SOCKET), says HELLO,
// and serves the requests the daemon multiplexes over that one connection.
//
// Sibling modules are imported lazily inside main() so tests can import loadHandler on its own.
import { isAbsolute, join, resolve } from "node:path"
import { readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import type { FnProjectConfig } from "./fn-config.ts"
import type { AssetsConfig, AssetServer } from "./fn-assets.ts"

export type FetchHandler = (req: Request, env: Record<string, unknown>, ctx: unknown) => unknown
export type ScheduledHandler = (event: unknown, env: Record<string, unknown>, ctx: unknown) => unknown
export interface FnHandler {
  fetch?: FetchHandler
  scheduled?: ScheduledHandler
}

// Response bodies are cut into frames this big, well under MAX_FRAME_PAYLOAD.
const BODY_CHUNK = 64 * 1024
const SHUTDOWN_WAIT_MS = 30_000
const HELLO_ACK_TIMEOUT_MS = 15_000
// A cold instance is spawned for a request, so give that request a moment to arrive before saying BYE.
const FIRST_REQUEST_GRACE_MS = 1_000
// Console output sent per request (same limits the daemon's request log keeps)
export const MAX_REQUEST_LOG_LINES = 1000
export const MAX_REQUEST_LOG_BYTES = 256 * 1024

const describe = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v)

// Accepts a module namespace or its default export: `{ fetch, scheduled }` objects, Hono apps
// (an object with a .fetch method, possibly a class instance) or a bare fetch function.
export const loadHandler = (mod: unknown): FnHandler => {
  let target: unknown = mod
  if (target && typeof target === "object" && "default" in target && (target as { default: unknown }).default !== undefined) {
    target = (target as { default: unknown }).default
  }
  if (typeof target === "function") {
    const fn = target as FetchHandler
    return { fetch: (req, env, ctx) => fn(req, env, ctx) }
  }
  if (target && typeof target === "object") {
    const obj = target as Record<string, unknown>
    // Bind to the object: Hono and class-based apps rely on `this`.
    const handler: FnHandler = {}
    if (typeof obj.fetch === "function") handler.fetch = (obj.fetch as FetchHandler).bind(obj)
    if (typeof obj.scheduled === "function") handler.scheduled = (obj.scheduled as ScheduledHandler).bind(obj)
    if (handler.fetch || handler.scheduled) return handler
    throw new Error(`function module must export default { fetch } (or a Hono app or a function); got an object with keys: ${Object.keys(obj).join(", ") || "(none)"}`)
  }
  throw new Error(`function module must export default { fetch } (or a Hono app or a function); got ${describe(target)}`)
}

export interface HostArgs {
  entry: string
  scheduled: string | null
}

export const parseHostArgs = (argv: string[]): HostArgs => {
  let entry: string | null = null
  let scheduled: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--scheduled") {
      const v = argv[++i]
      if (v === undefined) throw new Error("--scheduled needs a cron expression")
      scheduled = v
    } else if (entry === null) entry = a
    else throw new Error(`unexpected argument: ${a}`)
  }
  if (!entry) throw new Error("usage: fn-host.ts <entry> [--scheduled <cron>]")
  return { entry, scheduled }
}

// `assets` is optional here so this also reads configs from before assets were wired up.
export type HostConfig = FnProjectConfig & { assets?: AssetsConfig | null }

const EMPTY_CONFIG: HostConfig = { main: "", vars: {}, kv: [], d1: [], crons: [], warnings: [], source: null, assets: null }

export const configFromEnv = (raw: string | undefined): HostConfig => {
  if (!raw) return { ...EMPTY_CONFIG }
  const parsed = JSON.parse(raw) as Partial<HostConfig>
  return { ...EMPTY_CONFIG, ...parsed }
}

// --- env.ASSETS ---

// Relative URLs given to env.ASSETS.fetch resolve against this; the host part is never looked at.
export const ASSETS_ORIGIN = "http://assets.local/"
export type AssetsMode = "dev" | "snapshot"

// The daemon names the directory to serve (a deploy's snapshot overrides assets.directory) and the mode.
export const assetsFromEnv = (cfg: HostConfig, dir: string | undefined, mode: string | undefined): { config: AssetsConfig; mode: AssetsMode } | null => {
  if (!cfg.assets) return null
  if (mode !== undefined && mode !== "" && mode !== "dev" && mode !== "snapshot") throw new Error(`CANDY_FN_ASSETS_MODE must be dev or snapshot, got ${JSON.stringify(mode)}`)
  return { config: { ...cfg.assets, directory: dir || cfg.assets.directory }, mode: mode === "snapshot" ? "snapshot" : "dev" }
}

// The binding would silently shadow (or be shadowed by) another env entry, so refuse to start instead.
export const checkAssetsBinding = (cfg: HostConfig, secretKeys: string[]): void => {
  const name = cfg.assets?.binding
  if (!name) return
  const clash = [
    Object.hasOwn(cfg.vars ?? {}, name) && "a var",
    secretKeys.includes(name) && "a secret",
    (cfg.kv ?? []).includes(name) && "a KV binding",
    (cfg.d1 ?? []).includes(name) && "a D1 binding",
  ].filter(Boolean)
  if (clash.length) throw new Error(`assets binding ${name} has the same name as ${clash.join(" and ")}; rename one of them`)
}

export interface AssetsBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

// env[binding]: an asset lookup only. It never calls the worker and ignores run_worker_first.
// The AssetServer opens on first use: most requests to a cold instance never touch it,
// and indexing a big tree on every spawn would cost each of them.
export const createAssetsBinding = (
  config: AssetsConfig,
  mode: AssetsMode,
  open: (cfg: AssetsConfig, opts: { mode: AssetsMode }) => Promise<AssetServer> =
    async (cfg, opts) => (await import("./fn-assets.ts")).AssetServer.open(cfg, opts),
): { binding: AssetsBinding; close(): void; readonly opened: boolean } => {
  let server: AssetServer | null = null
  let opening: Promise<AssetServer> | null = null
  let closed = false
  const get = (): Promise<AssetServer> => {
    if (server) return Promise.resolve(server)
    // No index or watcher: lookups stat the disk (dev) or read the manifest (snapshot).
    opening ??= open(config, { mode }).then(
      s => {
        if (closed) { s.close(); throw new Error("assets binding is closed") }
        server = s
        return s
      },
      e => {
        // A failed open (a missing directory is not one) is retried on the next call.
        opening = null
        throw e
      },
    )
    return opening
  }
  const binding: AssetsBinding = {
    async fetch(input, init) {
      if (closed) throw new Error("assets binding is closed")
      const req = input instanceof Request
        ? (init ? new Request(input, init) : input)
        : new Request(new URL(String(input), ASSETS_ORIGIN), init)
      return (await get()).fetchAsset(req)
    },
  }
  return {
    binding: Object.freeze(binding),
    close() {
      closed = true
      server?.close()
      server = null
    },
    get opened() { return server !== null },
  }
}

// --- env.CANDY_AUTH: Sign in with candy (SDK_AUTH_DESIGN.md) ---

export const CANDY_AUTH_BINDING = "CANDY_AUTH"
// $CREDENTIALS_DIRECTORY/<this> (sdk-auth.ts CREDENTIAL_NAME; not imported here, the shim loads sdk-auth lazily)
const AUTH_CREDENTIAL = "candy-auth-keys"
const MAX_RING_TEXT = 8192

export interface AuthSpec { site: string; portal?: string; issuers?: string[]; keys: string | null }

// What the daemon handed this instance for candy auth: the site from env, the
// ring from the unit's credential file (sandboxed) or CANDY_AUTH_KEYS. null
// when the daemon gave no site (a cron run, or a manual start).
export const authFromEnv = (env: Record<string, string | undefined>, readFile: (path: string) => string | null): AuthSpec | null => {
  const site = env.CANDY_AUTH_SITE?.trim()
  if (!site) return null
  const dir = env.CREDENTIALS_DIRECTORY
  const fromFile = dir ? readFile(`${dir.replace(/\/+$/, "")}/${AUTH_CREDENTIAL}`) : null
  const raw = (fromFile ?? env.CANDY_AUTH_KEYS ?? "").trim()
  const issuers = env.CANDY_AUTH_ISSUERS?.split(",").map(x => x.trim()).filter(Boolean)
  return {
    site,
    ...(env.CANDY_AUTH_URL ? { portal: env.CANDY_AUTH_URL } : {}),
    ...(issuers?.length ? { issuers } : {}),
    keys: raw && raw.length <= MAX_RING_TEXT ? raw : null,
  }
}

// A small regular file's text, or null (missing, too big, unreadable)
const readSmallFile = (path: string): string | null => {
  try {
    const st = statSync(path)
    return st.isFile() && st.size <= MAX_RING_TEXT ? readFileSync(path, "utf8") : null
  } catch {
    return null
  }
}

// env.CANDY_AUTH is candy's: a var, secret or binding by that name would shadow it, so refuse to start
export const checkReservedBindings = (cfg: HostConfig, secretKeys: string[]): void => {
  const name = CANDY_AUTH_BINDING
  const clash = Object.hasOwn(cfg.vars ?? {}, name) || secretKeys.includes(name) || (cfg.kv ?? []).includes(name)
    || (cfg.d1 ?? []).includes(name) || cfg.assets?.binding === name
  if (clash) throw new Error(`${name} is reserved for candy auth`)
}

// Secrets are named by CANDY_FN_SECRET_KEYS and read from the process env (filled from envFile).
export const secretsFromEnv = (keys: string | undefined, env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const key of (keys ?? "").split(",").map(k => k.trim()).filter(Boolean)) {
    const v = env[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

// Workers serialise multi-value Set-Cookie separately; Headers iteration may join others with ", ".
export const headerPairs = (h: Headers): [string, string][] => {
  const out: [string, string][] = []
  for (const [k, v] of h) if (k !== "set-cookie") out.push([k, v])
  for (const c of h.getSetCookie()) out.push(["set-cookie", c])
  return out
}

// Idle linger before BYE (fn.linger, sent as CANDY_FN_LINGER_MS). Unset means the 30s default; 0 exits at once.
export const DEFAULT_LINGER_MS = 30_000
export const parseLingerMs = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === "") return DEFAULT_LINGER_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 600_000) : DEFAULT_LINGER_MS
}

const errorInfo = (e: unknown): { message: string; stack?: string } =>
  e instanceof Error ? { message: e.message || e.name, stack: e.stack } : { message: String(e) }

const log = (msg: string) => console.error(`[candy fn-host] ${msg}`)


const importEntry = async (entry: string): Promise<unknown> => {
  const abs = isAbsolute(entry) ? entry : resolve(process.cwd(), entry)
  return import(pathToFileURL(abs).href)
}

// Per-request console budget: once spent, one final notice and nothing more.
// Returns the entries to actually send for one console call.
export class LogBudget {
  private lines = 0
  private bytes = 0
  private cut = false
  take<T extends { text: string; level: string; ts: number }>(entry: T): T[] {
    if (this.cut) return []
    const size = entry.text.length
    if (this.lines + 1 > MAX_REQUEST_LOG_LINES || this.bytes + size > MAX_REQUEST_LOG_BYTES) {
      this.cut = true
      return [{ ...entry, level: "warn", text: "[candy] console output for this request truncated" }]
    }
    this.lines++
    this.bytes += size
    return [entry]
  }
}

interface Inflight {
  requestId: string
  // Request body: frames queue here until the handler reads them (pull), so a
  // slow reader holds back the daemon through flow control, not our memory
  body: { queue: Uint8Array[]; ended: boolean; error: unknown; wake: (() => void) | null } | null
  abort: AbortController
  cancelled: boolean
  // Set while the response body streams, so CANCEL can unblock a pending read (SSE).
  stopBody?: () => void
  // Flow control: response bytes we may still send, and its waiter
  credit: number
  creditWake: (() => void) | null
}

async function main(): Promise<void> {
  let args: HostArgs
  try {
    args = parseHostArgs(process.argv.slice(2))
  } catch (e) {
    log((e as Error).message)
    process.exit(2)
  }

  // Read what the daemon handed us, then hide it from the function's own code.
  const socketPath = process.env.CANDY_FN_SOCKET
  const token = process.env.CANDY_FN_TOKEN ?? ""
  const instance = process.env.CANDY_FN_INSTANCE ?? String(process.pid)
  // The daemon always sets this; the fallback keeps a manual run from writing into the code folder.
  const stateDir = process.env.CANDY_FN_STATE ?? join(tmpdir(), "candy-fn-state")
  let cfg: HostConfig
  let assets: ReturnType<typeof assetsFromEnv>
  const secretKeys = (process.env.CANDY_FN_SECRET_KEYS ?? "").split(",").map(k => k.trim()).filter(Boolean)
  try {
    cfg = configFromEnv(process.env.CANDY_FN_CONFIG)
    // An assets-only function has no main; the daemon serves it without ever starting us.
    if ((cfg.main as string | null) === null) throw new Error("this function has no main (assets only), so there is nothing to run")
    assets = assetsFromEnv(cfg, process.env.CANDY_FN_ASSETS_DIR, process.env.CANDY_FN_ASSETS_MODE)
    checkAssetsBinding(cfg, secretKeys)
    checkReservedBindings(cfg, secretKeys)
  } catch (e) {
    log(`bad CANDY_FN_CONFIG: ${(e as Error).message}`)
    process.exit(2)
  }
  const secrets = secretsFromEnv(process.env.CANDY_FN_SECRET_KEYS, process.env)
  const lingerMs = parseLingerMs(process.env.CANDY_FN_LINGER_MS)
  // Candy auth's ring: read before any of the function's code runs, then out of process.env
  const authSpec = authFromEnv(process.env, readSmallFile)
  for (const k of ["CANDY_FN_TOKEN", "CANDY_FN_SOCKET", "CANDY_FN_CONFIG", "CANDY_FN_SECRET_KEYS", "CANDY_FN_LINGER_MS", "CANDY_FN_ASSETS_DIR", "CANDY_FN_ASSETS_MODE", "CANDY_AUTH_KEYS"]) delete process.env[k]

  const [{ buildEnv, closeBindings }, { ExecutionContext, runScheduled }] = await Promise.all([
    import("./fn-bindings.ts"),
    import("./fn-cron.ts"),
  ])

  // Workers don't die on a stray rejection from background work; neither do we.
  process.on("unhandledRejection", e => log(`unhandled rejection: ${errorInfo(e).stack ?? errorInfo(e).message}`))
  process.on("uncaughtException", e => log(`uncaught exception: ${e.stack ?? e.message}`))

  let handler: FnHandler | null = null
  let loadError: unknown = null
  try {
    handler = loadHandler(await importEntry(args.entry))
  } catch (e) {
    loadError = e
    log(`failed to load ${args.entry}: ${errorInfo(e).stack ?? errorInfo(e).message}`)
  }

  const env = buildEnv(cfg, stateDir, secrets)
  // env.CANDY_AUTH: `const r = await env.CANDY_AUTH.handle(request, onLogin); if (r) return r`
  if (authSpec) {
    try {
      const { createAppAuth } = await import("./sdk-auth.ts")
      const auth = createAppAuth({ site: authSpec.site, portal: authSpec.portal, issuers: authSpec.issuers, ...(authSpec.keys ? { keys: authSpec.keys } : {}) })
      env[CANDY_AUTH_BINDING] = auth
      // sdk.ts appAuth() inside this function returns the same object
      ;(globalThis as Record<symbol, unknown>)[Symbol.for("candy.appAuth")] = auth
    } catch (e) {
      log(`candy auth is off: ${(e as Error).message}`)
    }
  }
  // Also present in --scheduled runs: a cron handler may read files too.
  const assetsBinding = assets?.config.binding ? createAssetsBinding(assets.config, assets.mode) : null
  if (assetsBinding) env[assets!.config.binding!] = assetsBinding.binding
  const finish = (code: number): never => {
    try { assetsBinding?.close() } catch {}
    try { closeBindings(env) } catch {}
    process.exit(code)
  }

  if (args.scheduled !== null) {
    if (!handler) finish(1)
    try {
      await runScheduled(handler!, env, args.scheduled)
      finish(0)
    } catch (e) {
      log(`scheduled run failed: ${errorInfo(e).stack ?? errorInfo(e).message}`)
      finish(1)
    }
  }

  if (!socketPath) {
    log("CANDY_FN_SOCKET is not set; fn-host is started by the candy daemon")
    finish(2)
  }

  const [{ encodeFrame, encodeJsonFrame, FrameDecoder, decodeJson, Frame, PROTOCOL_VERSION, INITIAL_WINDOW }, { installConsoleCapture }] = await Promise.all([
    import("./fn-protocol.ts"),
    import("./fn-console.ts"),
  ])

  // --- outbound writes with backpressure ---
  let sock: { write(b: Uint8Array): number; end(): void } | null = null
  const outQueue: Uint8Array[] = []
  let writableWaiters: (() => void)[] = []
  const flush = () => {
    while (sock && outQueue.length) {
      const head = outQueue[0]
      const n = sock.write(head)
      if (n < head.length) {
        outQueue[0] = head.subarray(Math.max(n, 0))
        return
      }
      outQueue.shift()
    }
    const waiters = writableWaiters
    writableWaiters = []
    for (const w of waiters) w()
  }
  const send = (bytes: Uint8Array) => {
    // Nobody to send to once the daemon is gone
    if (!sock) return
    outQueue.push(bytes)
    if (outQueue.length === 1) flush()
  }
  const writable = (): Promise<void> => (outQueue.length === 0 ? Promise.resolve() : new Promise(r => writableWaiters.push(r)))

  // --- instance state ---
  const inflight = new Map<number, Inflight>()
  const streamOf = new Map<string, number>() // requestId → stream id, for LOG frames
  const logBudgets = new Map<string, LogBudget>()
  // Set by HELLO_ACK.window: the daemon grants response credit per stream
  let flow = false
  let resWindow = 0
  let background = 0 // requests whose waitUntil work hasn't settled
  let hot = false
  let acked = false
  let byeSent = false
  let byeAcked = false
  let draining = false
  let exiting = false
  let firstRequestSeen = false
  let graceOver = false
  // Linger: once idle, wait lingerMs for another request before saying BYE
  let lingerTimer: ReturnType<typeof setTimeout> | null = null
  let lingerOver = false
  const stopLinger = () => {
    if (lingerTimer) clearTimeout(lingerTimer)
    lingerTimer = null
    lingerOver = false
  }

  const capture = installConsoleCapture((requestId, entry) => {
    const sid = streamOf.get(requestId)
    if (sid === undefined || !sock || exiting) return
    // A logging loop must not flood the socket: the daemon keeps only so much anyway
    for (const e of logBudgets.get(requestId)?.take(entry) ?? [entry]) send(encodeJsonFrame(Frame.LOG, sid, e))
  })

  const exitWhenFlushed = async (code: number) => {
    if (exiting) return
    exiting = true
    await Promise.race([writable(), Bun.sleep(2_000)])
    try { sock?.end() } catch {}
    finish(code)
  }

  const idle = () => inflight.size === 0 && background === 0

  const checkIdle = () => {
    if (exiting || !idle()) return
    if (draining || byeAcked) return void exitWhenFlushed(0)
    if (hot || !acked || byeSent) return
    if (!firstRequestSeen && !graceOver) return
    if (lingerMs > 0 && !lingerOver) {
      lingerTimer ??= setTimeout(() => { lingerTimer = null; lingerOver = true; checkIdle() }, lingerMs)
      return
    }
    byeSent = true
    send(encodeJsonFrame(Frame.BYE, 0, { reason: "idle" }))
  }
  // Checks run on the next tick so frames that arrived in the same chunk are seen first.
  const scheduleIdleCheck = () => setTimeout(checkIdle, 0)

  const beginShutdown = (why: string) => {
    if (draining) return
    draining = true
    // On SIGTERM tell the daemon to stop routing here; after DRAIN it already knows.
    if (why !== "drain" && !byeSent && sock) {
      byeSent = true
      send(encodeJsonFrame(Frame.BYE, 0, { reason: why }))
    }
    setTimeout(() => {
      log(`gave up waiting for ${inflight.size} request(s) and ${background} waitUntil batch(es) after ${SHUTDOWN_WAIT_MS / 1000}s`)
      void exitWhenFlushed(0)
    }, SHUTDOWN_WAIT_MS)
    checkIdle()
  }
  process.on("SIGTERM", () => beginShutdown("sigterm"))

  const reject503 = (sid: number) => {
    send(encodeJsonFrame(Frame.RES_HEAD, sid, { status: 503, statusText: "Service Unavailable", headers: [["content-type", "text/plain; charset=utf-8"]] }))
    send(encodeFrame(Frame.RES_BODY, sid, new TextEncoder().encode("function instance is shutting down\n")))
    send(encodeFrame(Frame.RES_END, sid))
  }

  const streamResponse = async (sid: number, st: Inflight, res: Response) => {
    send(encodeJsonFrame(Frame.RES_HEAD, sid, { status: res.status, statusText: res.statusText, headers: headerPairs(res.headers) }))
    if (res.body) {
      const reader = res.body.getReader()
      st.stopBody = () => { reader.cancel().catch(() => {}) }
      try {
        while (true) {
          if (st.cancelled) {
            await reader.cancel().catch(() => {})
            return
          }
          const { done, value } = await reader.read()
          if (done) break
          if (st.cancelled) {
            await reader.cancel().catch(() => {})
            return
          }
          const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          for (let off = 0; off < bytes.length;) {
            // Flow control: wait until the daemon's reader has room for this stream
            while (flow && st.credit <= 0 && !st.cancelled) await new Promise<void>(r => { st.creditWake = r })
            if (st.cancelled) break
            const n = flow ? Math.min(BODY_CHUNK, st.credit, bytes.length - off) : Math.min(BODY_CHUNK, bytes.length - off)
            // Copy: the frame outlives this chunk, and the stream may reuse its buffer.
            send(encodeFrame(Frame.RES_BODY, sid, bytes.slice(off, off + n)))
            if (flow) st.credit -= n
            off += n
            await writable()
            if (st.cancelled) break
          }
        }
      } catch (e) {
        // Headers are out, so the daemon turns this into a broken body rather than a 500.
        if (!st.cancelled) {
          log(`response body for ${st.requestId} failed: ${errorInfo(e).stack ?? errorInfo(e).message}`)
          send(encodeJsonFrame(Frame.ERR, sid, errorInfo(e)))
        }
        return
      }
    }
    if (!st.cancelled) send(encodeFrame(Frame.RES_END, sid))
  }

  const handleRequest = async (sid: number, head: { method: string; url: string; headers: [string, string][]; clientIp?: string; requestId: string }) => {
    firstRequestSeen = true
    const hasBody = head.method !== "GET" && head.method !== "HEAD"
    const st: Inflight = { requestId: head.requestId, body: null, abort: new AbortController(), cancelled: false, credit: resWindow, creditWake: null }
    inflight.set(sid, st)
    streamOf.set(head.requestId, sid)
    logBudgets.set(head.requestId, new LogBudget())

    const headers = new Headers(head.headers)
    if (head.clientIp && !headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", head.clientIp)
    let body: ReadableStream<Uint8Array> | null = null
    if (hasBody) {
      const q: NonNullable<Inflight["body"]> = { queue: [], ended: false, error: null, wake: null }
      st.body = q
      // Pull-based: a frame is handed over only when the handler reads, and
      // only then does the daemon get the credit to send more
      body = new ReadableStream<Uint8Array>({
        pull: async controller => {
          for (;;) {
            const chunk = q.queue.shift()
            if (chunk) {
              if (!st.cancelled && sock) send(encodeJsonFrame(Frame.WINDOW, sid, { bytes: chunk.length }))
              controller.enqueue(chunk)
              return
            }
            if (q.error) return controller.error(q.error)
            if (q.ended) return controller.close()
            await new Promise<void>(r => { q.wake = r })
            q.wake = null
          }
        },
        cancel: () => { q.queue = []; q.ended = true },
      }, { highWaterMark: 0 })
    }
    const url = new URL(head.url, `http://${headers.get("host") ?? "localhost"}`)
    const req = new Request(url, { method: head.method, headers, body, signal: st.abort.signal, duplex: "half" } as RequestInit)
    const ctx = new ExecutionContext()

    try {
      if (!handler?.fetch) throw loadError ?? new Error("this function has no fetch handler")
      const fetchFn = handler.fetch
      const res = await capture.run(head.requestId, () => fetchFn(req, env, ctx))
      if (!(res instanceof Response)) throw new Error(`fetch handler returned ${describe(res)}, not a Response`)
      if (!st.cancelled) await streamResponse(sid, st, res)
    } catch (e) {
      const info = errorInfo(e)
      if (!st.cancelled) {
        log(`${head.method} ${url.pathname} threw: ${info.stack ?? info.message}`)
        send(encodeJsonFrame(Frame.ERR, sid, info))
      }
    } finally {
      inflight.delete(sid)
    }

    background++
    try {
      // Loop: a waitUntil callback can queue more waitUntil work.
      do {
        await ctx.settled().catch(e => log(`waitUntil for ${head.requestId} failed: ${errorInfo(e).message}`))
      } while (ctx.pending > 0)
    } finally {
      background--
      streamOf.delete(head.requestId)
      logBudgets.delete(head.requestId)
      scheduleIdleCheck()
    }
  }

  const wakeBody = (q: NonNullable<Inflight["body"]>) => {
    const w = q.wake
    q.wake = null
    w?.()
  }

  const cancelInflight = (st: Inflight) => {
    if (st.cancelled) return
    st.cancelled = true
    const err = new DOMException("The client disconnected", "AbortError")
    if (st.body && !st.body.ended) {
      st.body.error = err
      wakeBody(st.body)
    }
    st.abort.abort(err)
    st.stopBody?.()
    const wake = st.creditWake
    st.creditWake = null
    wake?.()
  }

  const onFrame = (type: number, sid: number, payload: Uint8Array) => {
    switch (type) {
      case Frame.HELLO_ACK: {
        const ack = decodeJson<{ hot?: boolean; window?: number }>(payload)
        hot = !!ack.hot
        acked = true
        if (Number.isInteger(ack.window) && ack.window! > 0) {
          flow = true
          resWindow = ack.window!
        }
        clearTimeout(helloTimer)
        setTimeout(() => { graceOver = true; checkIdle() }, FIRST_REQUEST_GRACE_MS)
        scheduleIdleCheck()
        return
      }
      case Frame.REQ_HEAD: {
        // After BYE_ACK the daemon routes nothing new here; until then every REQ_HEAD is served.
        if (draining || byeAcked || inflight.has(sid)) return reject503(sid)
        // A request during the linger is served warm; the timer restarts at the next idle
        stopLinger()
        void handleRequest(sid, decodeJson(payload))
        return
      }
      case Frame.REQ_BODY: {
        const q = inflight.get(sid)?.body
        if (!q || q.ended) return
        // Copy: the decoder's buffer is reused for later frames.
        q.queue.push(payload.slice())
        wakeBody(q)
        return
      }
      case Frame.REQ_END: {
        const q = inflight.get(sid)?.body
        if (!q) return
        q.ended = true
        wakeBody(q)
        return
      }
      case Frame.CANCEL: {
        const st = inflight.get(sid)
        if (st) cancelInflight(st)
        return
      }
      case Frame.WINDOW: {
        const st = inflight.get(sid)
        if (!st) return
        const { bytes } = decodeJson<{ bytes?: number }>(payload)
        if (!Number.isInteger(bytes) || bytes! <= 0) return
        st.credit += bytes!
        const wake = st.creditWake
        st.creditWake = null
        wake?.()
        return
      }
      case Frame.BYE_ACK:
        byeAcked = true
        checkIdle()
        return
      case Frame.DRAIN:
        beginShutdown("drain")
        return
      default:
        log(`ignoring unexpected frame type ${type} on stream ${sid}`)
    }
  }

  const decoder = new FrameDecoder()
  let helloTimer: Timer | undefined
  try {
    const s = await Bun.connect({
      unix: socketPath!,
      socket: {
        data(_s, chunk) {
          let frames
          try {
            frames = decoder.push(new Uint8Array(chunk))
          } catch (e) {
            log(`protocol error from daemon: ${(e as Error).message}`)
            return void exitWhenFlushed(1)
          }
          for (const f of frames) {
            try {
              onFrame(f.type, f.streamId, f.payload)
            } catch (e) {
              log(`bad frame type ${f.type} on stream ${f.streamId}: ${(e as Error).message}`)
            }
          }
        },
        drain() { flush() },
        close() {
          if (exiting) return
          sock = null
          outQueue.length = 0
          flush()  // releases anyone waiting to write
          // The daemon restarts us on the next request; a clean exit only if we were done anyway.
          if (!draining && !byeAcked) log("daemon connection closed")
          if (idle()) {
            exiting = true
            finish(draining || byeAcked ? 0 : 1)
          }
          // In-flight responses have nowhere to go, but waitUntil work (KV/D1
          // writes after the response) still gets its shutdown grace
          for (const st of inflight.values()) cancelInflight(st)
          if (!draining) {
            draining = true
            setTimeout(() => {
              log(`daemon gone; gave up waiting for ${inflight.size} request(s) and ${background} waitUntil batch(es) after ${SHUTDOWN_WAIT_MS / 1000}s`)
              exiting = true
              finish(1)
            }, SHUTDOWN_WAIT_MS)
          }
          scheduleIdleCheck()
        },
        error(_s, e) { log(`socket error: ${e.message}`) },
      },
    })
    sock = s
  } catch (e) {
    log(`cannot connect to ${socketPath}: ${(e as Error).message}`)
    finish(1)
  }

  // window: we do per-stream flow control (request bodies arrive as we grant room)
  send(encodeJsonFrame(Frame.HELLO, 0, { token, instance, version: PROTOCOL_VERSION, window: INITIAL_WINDOW }))
  helloTimer = setTimeout(() => {
    if (acked) return
    log(`no HELLO_ACK from the daemon within ${HELLO_ACK_TIMEOUT_MS / 1000}s`)
    void exitWhenFlushed(1)
  }, HELLO_ACK_TIMEOUT_MS)
}

if (import.meta.main) {
  main().catch(e => {
    log(`fatal: ${errorInfo(e).stack ?? errorInfo(e).message}`)
    process.exit(1)
  })
}
