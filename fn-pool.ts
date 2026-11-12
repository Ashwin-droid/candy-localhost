// Instance pool for one function: TTL-0 lifecycle, hot instances, least-loaded
// routing (see FUNCTIONS_DESIGN.md, "Lifecycle: TTL 0 by default").
// Spawning is injected so the scheduling here is testable without processes.

import type { FnConnection } from "./fn-dispatch.ts"

export type FnInstanceHandle = {
  id: string
  pid: number | null
  conn: FnConnection | null  // null until HELLO
  ready: Promise<FnConnection>
  hot: boolean
  startedAt: number
  kill(): void
  // Optional: resolves when the process exits. The connection closing is
  // treated as exit too, so this only matters for a process that dies
  // without its socket closing (or before it ever dialed in).
  exited?: Promise<unknown>
}

export interface FnPoolOpts {
  hot: number
  max: number
  perInstanceConcurrency?: number
  spawn(): Promise<FnInstanceHandle>
  startTimeoutMs?: number
  // First hot-respawn delay after a quick crash; doubles up to 30s
  backoffBaseMs?: number
}

export interface FnInstanceInfo {
  id: string
  pid: number | null
  hot: boolean
  inflight: number
  startedAt: number
  ready: boolean
}

const MAX_BACKOFF_MS = 30_000
// An instance that lived this long before dying resets the crash backoff
const HEALTHY_UPTIME_MS = 10_000
// A handed-out handle counts as load until the caller dispatches on it
const RESERVATION_MS = 2_000
const DRAIN_TIMEOUT_MS = 30_000

interface Slot {
  seq: number
  h: FnInstanceHandle | null  // null while spawn() is pending
  conn: FnConnection | null
  hot: boolean
  startedAt: number
  // Handles given out but not dispatched on yet, oldest first
  reservations: Reservation[]
  offs: (() => void)[]
  timer: ReturnType<typeof setTimeout> | null
  gone: boolean
  // Settles once the instance said HELLO or failed to start
  started: Promise<void>
  markStarted: () => void
  closed: Promise<void>
  markClosed: () => void
}

interface Reservation {
  release(): void
}

interface Waiter {
  resolve(h: FnInstanceHandle): void
  reject(e: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class FnPool {
  private hot: number
  private max: number
  private conc: number
  private startTimeoutMs: number
  private backoffBaseMs: number
  private slots: Slot[] = []
  private leaving = new Set<Slot>()
  private waiters: Waiter[] = []
  private seq = 0
  private failures = 0
  private respawnTimer: ReturnType<typeof setTimeout> | null = null
  private hotSuspended = false
  private pumping = false

  constructor(readonly name: string, private opts: FnPoolOpts) {
    this.max = Math.max(1, Math.floor(opts.max))
    this.hot = clampHot(opts.hot, this.max)
    this.conc = Math.max(1, Math.floor(opts.perInstanceConcurrency ?? 32))
    this.startTimeoutMs = opts.startTimeoutMs ?? 15_000
    this.backoffBaseMs = opts.backoffBaseMs ?? 500
  }

  acquire(): Promise<FnInstanceHandle> {
    // A request after a stop brings the hot instances back
    if (this.hotSuspended) {
      this.hotSuspended = false
      this.topUpHot()
    }
    return new Promise<FnInstanceHandle>((resolve, reject) => {
      const w: Waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          this.removeWaiter(w)
          const starting = this.slots.some(s => !s.conn)
          reject(new Error(starting
            ? `fn "${this.name}" did not start within ${this.startTimeoutMs}ms`
            : `fn "${this.name}": no instance free within ${this.startTimeoutMs}ms (${this.slots.length}/${this.max} instances busy)`))
        }, this.startTimeoutMs),
      }
      this.waiters.push(w)
      this.pump()
    })
  }

  async ensureHot(): Promise<void> {
    this.hotSuspended = false
    await Promise.all(this.topUpHot().map(s => s.started))
  }

  setLimits(l: { hot?: number; max?: number }): void {
    if (l.max !== undefined) this.max = Math.max(1, Math.floor(l.max))
    if (l.hot !== undefined || l.max !== undefined) this.hot = clampHot(l.hot ?? this.hot, this.max)

    // Demoted hot instances drain and exit; new non-hot ones serve on demand
    let hotLive = this.slots.filter(s => s.hot)
    for (const s of hotLive.slice(this.hot).reverse()) {
      s.hot = false
      if (s.h) s.h.hot = false
      if (s.conn) {
        s.conn.hot = false
        s.conn.drain()
        this.retire(s)
      }
    }
    hotLive = this.slots.filter(s => s.hot)
    if (!this.hotSuspended && hotLive.length < this.hot) this.topUpHot()
    this.pump()
  }

  async drainAll(): Promise<void> {
    this.hotSuspended = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new Error(`fn "${this.name}" is stopping`))
    }
    this.retireAll()
    await this.awaitLeaving()
  }

  // New code or settings: every current instance finishes what it serves and
  // exits, while queued and new requests go to fresh instances (no 503s).
  // Hot instances are replaced at once. Resolves when the old ones are gone.
  async restart(limits?: { hot?: number; max?: number }): Promise<void> {
    this.hotSuspended = false
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    this.respawnTimer = null
    const old = this.retireAll()
    if (limits) this.setLimits(limits)
    this.topUpHot()
    this.pump()
    await this.awaitLeaving(old)
  }

  // Takes every instance out of routing: started ones drain, starting ones are killed
  private retireAll(): Set<Slot> {
    for (const s of [...this.slots]) {
      // Not replaced through scheduleRespawn: the caller decides about hot ones
      s.hot = false
      if (s.h) s.h.hot = false
      if (s.conn && !s.conn.isClosed) {
        s.conn.drain()
        this.retire(s)
      } else {
        // Not started yet: kill it outright, nothing is in flight there
        s.h?.kill()
        this.instanceGone(s, null, false)
      }
    }
    return new Set(this.leaving)
  }

  private async awaitLeaving(only?: Set<Slot>): Promise<void> {
    const pending = [...(only ?? this.leaving)].filter(s => this.leaving.has(s))
    if (!pending.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(r => { timer = setTimeout(r, DRAIN_TIMEOUT_MS) })
    await Promise.race([Promise.all(pending.map(s => s.closed)), timeout])
    clearTimeout(timer)
    for (const s of pending) if (this.leaving.has(s)) s.h?.kill()
  }

  instances(): FnInstanceInfo[] {
    return this.slots.filter(s => s.h).map(s => ({
      id: s.h!.id,
      pid: s.h!.pid,
      hot: s.hot,
      inflight: s.conn?.inflight ?? 0,
      startedAt: s.startedAt,
      ready: !!s.conn?.ready,
    }))
  }

  // ---- scheduling ----

  private load(s: Slot): number {
    return (s.conn?.inflight ?? 0) + s.reservations.length
  }

  private pickReady(): Slot | null {
    let best: Slot | null = null
    for (const s of this.slots) {
      if (!s.conn?.ready) continue
      const l = this.load(s)
      if (l >= this.conc) continue
      // Ties go to hot instances so non-hot ones get idle and exit sooner
      if (!best || l < this.load(best) || (l === this.load(best) && s.hot && !best.hot)) best = s
    }
    return best
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.waiters.length) {
        const s = this.pickReady()
        if (!s) break
        const w = this.waiters.shift()!
        clearTimeout(w.timer)
        this.reserve(s)
        w.resolve(s.h!)
      }
      // Instances still starting will take up to `conc` waiters each, so a
      // burst of cold requests spawns one instance, not `max`.
      const starting = this.slots.filter(s => !s.conn).length
      let need = this.waiters.length - starting * this.conc
      while (need > 0 && this.slots.length < this.max) {
        this.spawnSlot(this.slots.filter(s => s.hot).length < this.hot && !this.hotSuspended)
        need -= this.conc
      }
    } finally {
      this.pumping = false
    }
  }

  // Each reservation releases once: on dispatch (oldest first) or after its
  // own timeout, never someone else's
  private reserve(s: Slot): void {
    const hold = s.conn!.holdBye()
    let done = false
    const r: Reservation = {
      release: () => {
        if (done) return
        done = true
        clearTimeout(timer)
        const i = s.reservations.indexOf(r)
        if (i >= 0) s.reservations.splice(i, 1)
        hold()
      },
    }
    const timer = setTimeout(r.release, RESERVATION_MS)
    s.reservations.push(r)
  }

  private unreserve(s: Slot): void {
    s.reservations[0]?.release()
  }

  private removeWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w)
    if (i >= 0) this.waiters.splice(i, 1)
  }

  // ---- lifecycle ----

  private topUpHot(): Slot[] {
    const out: Slot[] = []
    while (this.slots.filter(s => s.hot).length < this.hot && this.slots.length < this.max) {
      out.push(this.spawnSlot(true))
    }
    return out
  }

  private spawnSlot(hot: boolean): Slot {
    let markClosed!: () => void, markStarted!: () => void
    const s: Slot = {
      seq: ++this.seq, h: null, conn: null, hot, startedAt: Date.now(),
      reservations: [], offs: [], timer: null, gone: false,
      started: new Promise<void>(r => { markStarted = r }), markStarted: () => markStarted(),
      closed: new Promise<void>(r => { markClosed = r }), markClosed: () => markClosed(),
    }
    this.slots.push(s)
    s.timer = setTimeout(() => {
      s.h?.kill()
      this.instanceGone(s, new Error(`fn "${this.name}" did not say HELLO within ${this.startTimeoutMs}ms`), true)
    }, this.startTimeoutMs)

    this.opts.spawn().then(h => {
      if (s.gone) { h.kill(); return }
      s.h = h
      h.hot = s.hot
      s.startedAt = h.startedAt || s.startedAt
      h.exited?.then(() => {
        const early = !s.conn
        this.instanceGone(s, early ? new Error(`fn "${this.name}" exited before saying HELLO`) : null, early)
      }, () => {})
      h.ready.then(conn => this.instanceReady(s, conn), e => {
        this.instanceGone(s, new Error(`fn "${this.name}" failed to start: ${errMsg(e)}`), true)
      })
    }, e => {
      this.instanceGone(s, new Error(`fn "${this.name}" failed to spawn: ${errMsg(e)}`), true)
    })
    return s
  }

  private instanceReady(s: Slot, conn: FnConnection): void {
    if (s.gone) return
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    s.conn = conn
    if (s.h) s.h.conn = conn
    s.markStarted()
    conn.ack(s.hot)
    s.offs.push(
      conn.on("bye", () => this.retire(s)),
      conn.on("close", () => this.instanceGone(s, null, false)),
      conn.on("load", () => this.pump()),
      conn.on("dispatch", () => this.unreserve(s)),
    )
    if (conn.isClosed) return this.instanceGone(s, null, false)
    if (conn.byeSeen) this.retire(s)
    this.pump()
  }

  // Out of routing (BYE, DRAIN, demotion) but still alive until it closes
  private retire(s: Slot): void {
    const i = this.slots.indexOf(s)
    if (i < 0) return
    this.slots.splice(i, 1)
    this.leaving.add(s)
    if (s.hot) {
      // A hot instance that says BYE is going away; replace it now
      s.hot = false
      this.scheduleRespawn(s, false)
    }
    this.pump()
  }

  private instanceGone(s: Slot, err: Error | null, failedStart: boolean): void {
    if (s.gone) return
    s.gone = true
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    for (const off of s.offs.splice(0)) off()
    for (const r of [...s.reservations]) r.release()
    const wasRouted = this.slots.includes(s)
    this.slots = this.slots.filter(x => x !== s)
    this.leaving.delete(s)
    s.markStarted()
    s.markClosed()

    if (wasRouted && s.hot) this.scheduleRespawn(s, failedStart)

    if (failedStart && err) {
      // Nothing left that could serve the queue: fail it rather than retry in a loop
      const canServe = this.slots.some(x => !x.conn || x.conn.ready)
      if (!canServe) {
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer)
          w.reject(err)
        }
        console.error(`[fn] ${err.message}`)
      }
    }
    this.pump()
  }

  private scheduleRespawn(s: Slot, failedStart: boolean): void {
    if (this.hotSuspended) return
    const uptime = Date.now() - s.startedAt
    if (failedStart || uptime < HEALTHY_UPTIME_MS) this.failures++
    else this.failures = 0
    if (this.respawnTimer) return
    const delay = this.failures === 0 ? 0 : Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * 2 ** (this.failures - 1))
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      if (!this.hotSuspended) this.topUpHot()
    }, delay)
  }
}

function clampHot(hot: number, max: number): number {
  return Math.max(0, Math.min(Math.floor(hot || 0), max))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
