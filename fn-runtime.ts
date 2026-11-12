// Daemon side of one function: the unix socket its instances dial in on, the
// instance pool, and turning an incoming Request into a dispatch (plus the
// request log). How an instance is launched is injected, so the daemon passes
// its launchSpec path and tests pass a plain `bun fn-host.ts` spawn.

import { chmod, chown, mkdir, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { FnConnection, FnCrashedError, FnThrewError, FnUnavailableError, type CaptureHooks } from "./fn-dispatch.ts"
import { FnPool, type FnInstanceHandle } from "./fn-pool.ts"
import type { FnLog, LogLine } from "./fn-log.ts"
import type { HelloPayload } from "./fn-protocol.ts"

export interface FnLaunched {
  pid: number | null
  kill(): void
  exited: Promise<unknown>
}

export interface FnRuntimeOpts {
  name: string
  socketPath: string
  // Root mode: the socket belongs to the function's user (0600), so only it can dial in
  socketOwner?: { uid: number; gid: number } | null
  hot: number
  max: number
  startTimeoutMs?: number
  perInstanceConcurrency?: number
  launch(instance: { id: string; token: string; socketPath: string }): Promise<FnLaunched>
  // The current request log, or null when fn.log is false
  log?(): FnLog | null
}

export interface FnRequestMeta {
  clientIp: string
  host: string
  requestId?: string
  // Error stacks go into 500 bodies only on .localhost (the owner's own machine)
  showStack?: boolean
  // Why the request skipped the assets (a run_worker_first pattern, a _redirects rewrite), for the log
  rule?: string | null
}

// LOG frames can trail the response (waitUntil work); keep routing them this long
const LOG_SINK_GRACE_MS = 60_000
const DISPATCH_RETRIES = 3

const timingSafeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex")

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Pending {
  token: string
  resolve(conn: FnConnection): void
  reject(e: Error): void
}

export class FnRuntime {
  readonly name: string
  readonly socketPath: string
  readonly pool: FnPool
  private listener: ReturnType<typeof Bun.listen> | null = null
  private pending = new Map<string, Pending>()  // instance id -> token + ready promise
  private served = new WeakSet<FnConnection>()  // instances that took a request (for cold/warm)
  private logSinks = new Map<string, (log: LogLine) => void>()
  private closed = false

  constructor(private opts: FnRuntimeOpts) {
    this.name = opts.name
    this.socketPath = opts.socketPath
    this.pool = new FnPool(opts.name, {
      hot: opts.hot,
      max: opts.max,
      perInstanceConcurrency: opts.perInstanceConcurrency,
      startTimeoutMs: opts.startTimeoutMs,
      spawn: () => this.spawn(),
    })
  }

  // Listen on the socket. A stale file from a previous daemon is removed first.
  async listen(): Promise<void> {
    if (this.listener) return
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o711 })
    await unlink(this.socketPath).catch(() => {})
    this.listener = Bun.listen<{ conn: FnConnection }>({
      unix: this.socketPath,
      socket: {
        open: socket => {
          socket.data = { conn: this.connectionFor(socket) }
        },
        data: (socket, chunk) => socket.data.conn.feed(new Uint8Array(chunk)),
        drain: socket => socket.data.conn.flush(),
        close: socket => socket.data?.conn.close(),
        error: socket => socket.data?.conn.close(),
      },
    })
    await chmod(this.socketPath, 0o600)
    if (this.opts.socketOwner) await chown(this.socketPath, this.opts.socketOwner.uid, this.opts.socketOwner.gid)
  }

  private connectionFor(socket: { write(b: Uint8Array): number; end(): void; pause?(): void; resume?(): void }): FnConnection {
    let conn!: FnConnection
    conn = new FnConnection(socket, {
      onHello: (h: HelloPayload) => {
        // One token per spawned instance, good for one HELLO
        const p = typeof h.instance === "string" ? this.pending.get(h.instance) : undefined
        if (!p || typeof h.token !== "string" || !timingSafeEqual(p.token, h.token)) return false
        this.pending.delete(h.instance)
        // The pool wants `ready` to settle after onHello has returned true
        queueMicrotask(() => p.resolve(conn))
        return true
      },
      onLog: (requestId, log) => {
        if (requestId) this.logSinks.get(requestId)?.(log as LogLine)
      },
    })
    return conn
  }

  private async spawn(): Promise<FnInstanceHandle> {
    if (this.closed) throw new Error(`fn "${this.name}" is shut down`)
    await this.listen()
    const id = `${this.name}-${randomHex(4)}`
    const token = randomHex(32)
    let resolve!: (c: FnConnection) => void, reject!: (e: Error) => void
    const ready = new Promise<FnConnection>((res, rej) => { resolve = res; reject = rej })
    ready.catch(() => {})
    this.pending.set(id, { token, resolve, reject })
    let launched: FnLaunched
    try {
      launched = await this.opts.launch({ id, token, socketPath: this.socketPath })
    } catch (e) {
      this.pending.delete(id)
      throw e
    }
    const exited = launched.exited.finally(() => {
      // Died before dialing in: fail `ready` so the pool stops waiting
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        p.reject(new Error("instance exited before saying HELLO"))
      }
    })
    exited.catch(() => {})
    return { id, pid: launched.pid, conn: null, ready, hot: false, startedAt: Date.now(), kill: () => launched.kill(), exited }
  }

  // Serve one request: wait for an instance, dispatch, and turn failures into responses.
  async handle(req: Request, meta: FnRequestMeta): Promise<Response> {
    const arrived = performance.now()
    const requestId = meta.requestId ?? crypto.randomUUID()
    const url = new URL(req.url)
    for (let attempt = 0; ; attempt++) {
      let h: FnInstanceHandle
      try {
        h = await this.pool.acquire()
      } catch (e) {
        return fnError(503, `fn ${this.name}: ${errText(e)}`, requestId)
      }
      const conn = h.conn!
      const cold = !this.served.has(conn)
      this.served.add(conn)
      const capture = this.beginCapture(requestId, req, url, meta, h.id, cold, performance.now() - arrived)
      try {
        return await conn.dispatch(req, { requestId, clientIp: meta.clientIp, capture })
      } catch (e) {
        this.logSinks.delete(requestId)
        // Nothing reached that instance (it said BYE meanwhile): try another
        if (e instanceof FnUnavailableError && attempt < DISPATCH_RETRIES) continue
        if (e instanceof FnThrewError) {
          const detail = meta.showStack && e.fnStack ? `\n\n${e.fnStack}` : ""
          return fnError(500, `fn ${this.name} threw: ${e.message}${detail}`, requestId, "text")
        }
        if (e instanceof FnCrashedError) return fnError(502, `fn ${this.name}: ${e.message}`, requestId)
        if (req.signal.aborted) return new Response(null, { status: 499 })
        return fnError(502, `fn ${this.name}: ${errText(e)}`, requestId)
      }
    }
  }

  private beginCapture(requestId: string, req: Request, url: URL, meta: FnRequestMeta, instance: string, cold: boolean, queuedMs: number): CaptureHooks | undefined {
    const log = this.opts.log?.()
    if (!log) return undefined
    let hooks: ReturnType<FnLog["begin"]>
    try {
      hooks = log.begin({
        requestId,
        fn: this.name,
        host: meta.host,
        method: req.method,
        url: url.pathname + url.search,
        clientIp: meta.clientIp,
        reqHeaders: [...req.headers],
        instance,
        cold,
        queuedMs,
        kind: "worker",
        rule: meta.rule ?? null,
      })
    } catch (e) {
      console.error(`[fn] ${this.name}: request log failed: ${errText(e)}`)
      return undefined
    }
    this.logSinks.set(requestId, l => hooks.addLog(l))
    return {
      onRequestChunk: b => hooks.onRequestChunk?.(b),
      onResponseHead: (s, hs) => hooks.onResponseHead?.(s, hs),
      onResponseChunk: b => hooks.onResponseChunk?.(b),
      onEnd: (outcome, err) => {
        hooks.onEnd?.(outcome, err)
        setTimeout(() => this.logSinks.delete(requestId), LOG_SINK_GRACE_MS).unref?.()
      },
    }
  }

  instances() {
    return this.pool.instances()
  }

  setLimits(l: { hot?: number; max?: number }) {
    this.pool.setLimits(l)
  }

  // Replace every instance (they finish what they're serving) without failing
  // queued requests: they go to fresh instances, e.g. on new code. Resolves
  // once the old instances are gone.
  async restart(limits?: { hot?: number; max?: number }): Promise<void> {
    await this.pool.restart(limits)
  }

  // Stop every instance and fail what is queued; hot ones stay down until the next request
  async stop(): Promise<void> {
    await this.pool.drainAll()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.drainAll()
    for (const p of this.pending.values()) p.reject(new Error(`fn "${this.name}" is shut down`))
    this.pending.clear()
    try { this.listener?.stop(true) } catch {}
    this.listener = null
    await unlink(this.socketPath).catch(() => {})
  }
}

const fnError = (status: number, error: string, requestId: string, kind: "json" | "text" = "json"): Response => {
  const headers = { "X-Candy": "fn", "X-Candy-Request-Id": requestId, "Cache-Control": "no-store" }
  return kind === "text"
    ? new Response(error + "\n", { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } })
    : Response.json({ error, requestId }, { status, headers })
}
