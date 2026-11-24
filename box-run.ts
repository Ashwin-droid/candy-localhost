// Running boxes: one process per box (in production `systemd-run --wait --pipe ...` from
// boxRunCommand in box.ts), its stdin/stdout relayed over a unix socket the site connects to,
// and the tail of its stderr kept for when it ends.
//
// Nothing here knows about systemd beyond reading systemd-run's summary lines, so it runs plain
// commands like `cat` just as well: that is how it is tested, without root.
//
// The socket is the box's stdin and stdout as one byte stream, one client at a time. A client
// that goes away leaves the box running with its stdin open, so the site can reconnect and pick
// up where it left off. Nothing is buffered without bound: stdout is read one chunk ahead of the
// client, so a box nobody listens to blocks on its own pipe; a client writing faster than the
// box reads is paused.

import { chmodSync, chownSync, unlinkSync } from "node:fs"
import type { Socket, TCPSocketListener, UnixSocketListener } from "bun"
import { boxExitCause, parseRunSummary, type BoxExit } from "./box.ts"

export interface BoxInfo {
  id: string
  site: string
  user: string
  unit: string
  label: string | null
  socket: string
  memory: number
  startedAt: number
  state: "running" | "exited"
  exit: BoxExit | null
}

export interface StartBox {
  id: string
  site: string
  user: string
  unit: string
  label: string | null
  memory: number
  socket: string                // unix socket path to listen on; its folder already exists
  cmd: string[]
  env: Record<string, string>
  owner?: { uid: number; gid: number } | null   // chown the socket to this when set
}

export type BoxAsked = "released" | "site-stopped" | "stopped"

export interface BoxHostOptions {
  onExit?: (box: BoxInfo, stderr: string) => void
  stopUnit?: (unit: string) => Promise<void>
  /**
   * Asked when a box ended by TERM or never came up and nobody here stopped it: systemd may have
   * stopped it because its site went (BindsTo), before the host heard of that.
   */
  askedLate?: (box: BoxInfo) => Promise<BoxAsked | null>
  keepExitedMs?: number
  stderrBytes?: number
}

const KEEP_EXITED_MS = 10 * 60 * 1000
const STDERR_BYTES = 64 * 1024
/** Bytes a client may have sent that the box hasn't taken yet, for when the socket can't be paused */
const STDIN_QUEUE_MAX = 8 * 1024 * 1024
/** After the box exits: how long its last output waits for a client to take it */
const DRAIN_AFTER_EXIT_MS = 2000

type Client = Socket<undefined>

interface Box {
  info: BoxInfo
  proc: ReturnType<typeof Bun.spawn> & { stdin: import("bun").FileSink; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array> }
  listener: UnixSocketListener<undefined> | TCPSocketListener<undefined> | null
  client: Client | null
  asked: BoxAsked | null
  // stdout read from the box but not yet taken by a client: at most one chunk
  pending: Uint8Array | null
  stdoutEnded: boolean
  wakePump: (() => void) | null
  // stdin the client sent while the box's pipe was full, in order
  stdinQueue: Uint8Array[]
  stdinQueued: number
  stdinBusy: boolean
  stdinDead: boolean
  stderrChunks: Uint8Array[]
  stderrBytes: number
  stderrEnded: boolean
  stderrRest: string | null
  finishing: boolean
  // fired whenever delivery or the stderr reader makes progress, so the exit path can re-check
  progress: (() => void) | null
  exited: Promise<void>
  markExited: () => void
}

const quiet = (fn: () => unknown) => { try { fn() } catch { /* the box or client is already gone */ } }

export class BoxHost {
  private boxes = new Map<string, Box>()
  private onExit: BoxHostOptions["onExit"]
  private stopUnit: BoxHostOptions["stopUnit"]
  private readonly askedLate?: BoxHostOptions["askedLate"]
  private keepExitedMs: number
  private stderrMax: number

  constructor(opts: BoxHostOptions = {}) {
    this.onExit = opts.onExit
    this.stopUnit = opts.stopUnit
    this.askedLate = opts.askedLate
    this.keepExitedMs = opts.keepExitedMs ?? KEEP_EXITED_MS
    this.stderrMax = Math.max(1, opts.stderrBytes ?? STDERR_BYTES)
  }

  /** Listen on the socket, then spawn. Throws, leaving nothing behind, if either can't be done. */
  async start(spec: StartBox): Promise<BoxInfo> {
    if (this.boxes.has(spec.id)) throw new Error(`box ${spec.id} already exists`)
    let markExited = () => {}
    const exited = new Promise<void>(resolve => { markExited = resolve })
    const box: Box = {
      info: {
        id: spec.id, site: spec.site, user: spec.user, unit: spec.unit, label: spec.label, socket: spec.socket,
        memory: spec.memory, startedAt: Date.now(), state: "running", exit: null,
      },
      proc: null as unknown as Box["proc"],
      listener: null, client: null, asked: null,
      pending: null, stdoutEnded: false, wakePump: null,
      stdinQueue: [], stdinQueued: 0, stdinBusy: false, stdinDead: false,
      stderrChunks: [], stderrBytes: 0, stderrEnded: false, stderrRest: null,
      finishing: false, progress: null, exited, markExited,
    }

    // A socket file left by a box of an earlier daemon would make listen fail
    quiet(() => unlinkSync(spec.socket))
    box.listener = Bun.listen<undefined>({
      unix: spec.socket,
      socket: {
        open: socket => this.attach(box, socket),
        data: (socket, data) => { if (socket === box.client) this.toStdin(box, data) },
        drain: socket => { if (socket === box.client) this.deliver(box) },
        close: socket => this.detach(box, socket),
        error: socket => this.detach(box, socket),
      },
    })
    try {
      // Only the site's user may connect: the folder may be shared with other boxes
      chmodSync(spec.socket, 0o600)
      if (spec.owner) chownSync(spec.socket, spec.owner.uid, spec.owner.gid)
      box.proc = Bun.spawn(spec.cmd, { env: spec.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as Box["proc"]
    } catch (err) {
      quiet(() => box.listener?.stop(true))
      quiet(() => unlinkSync(spec.socket))
      throw err
    }

    this.boxes.set(spec.id, box)
    void this.pumpStdout(box)
    void this.readStderr(box)
    void box.proc.exited.then(code => this.finish(box, code), () => this.finish(box, null))
    return { ...box.info }
  }

  get(site: string, id: string): BoxInfo | null {
    const box = this.boxes.get(id)
    return box && box.info.site === site ? { ...box.info } : null
  }

  list(site?: string): BoxInfo[] {
    const all = [...this.boxes.values()].map(b => b.info).filter(i => site === undefined || i.site === site)
    const order = (a: BoxInfo, b: BoxInfo) => a.startedAt - b.startedAt
    return [
      ...all.filter(i => i.state === "running").sort(order),
      ...all.filter(i => i.state === "exited").sort(order),
    ].map(i => ({ ...i }))
  }

  held(site: string): number {
    let n = 0
    for (const box of this.boxes.values()) if (box.info.site === site && box.info.state === "running") n++
    return n
  }

  stderr(site: string, id: string): string {
    const box = this.boxes.get(id)
    if (!box || box.info.site !== site) return ""
    return box.stderrRest ?? parseRunSummary(this.stderrText(box)).rest
  }

  async wait(site: string, id: string, ms: number): Promise<BoxInfo | null> {
    const box = this.boxes.get(id)
    if (!box || box.info.site !== site) return null
    if (box.info.state === "running") {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([box.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, ms)) })])
      clearTimeout(timer)
    }
    return { ...box.info }
  }

  /**
   * Stop a running box. The first one to ask is who the site is told stopped it. With stopUnit
   * the unit is stopped (systemd-run then exits on its own); its errors reach the caller.
   */
  async stop(site: string, id: string, asked: BoxAsked): Promise<boolean> {
    const box = this.boxes.get(id)
    if (!box || box.info.site !== site || box.info.state !== "running") return false
    box.asked ??= asked
    if (this.stopUnit) await this.stopUnit(box.info.unit)
    else quiet(() => box.proc.kill("SIGTERM"))
    return true
  }

  async stopSite(site: string, asked: BoxAsked): Promise<number> {
    const ids = [...this.boxes.values()].filter(b => b.info.site === site && b.info.state === "running").map(b => b.info.id)
    const stopped = await Promise.all(ids.map(id => this.stop(site, id, asked).catch(() => false)))
    return stopped.filter(Boolean).length
  }

  async stopAll(asked: BoxAsked): Promise<void> {
    const running = [...this.boxes.values()].filter(b => b.info.state === "running")
    await Promise.all(running.map(b => this.stop(b.info.site, b.info.id, asked).catch(() => false)))
  }

  // -------------------------------------------------------------------------
  // The client
  // -------------------------------------------------------------------------

  private attach(box: Box, socket: Client) {
    // One client at a time: two readers would split the output between them
    if (box.client || box.finishing && box.stdoutEnded && !box.pending) { quiet(() => socket.end()); return }
    box.client = socket
    if (box.stdinBusy) quiet(() => socket.pause())
    // Output a previous client didn't take goes to this one first, in order
    this.deliver(box)
  }

  private detach(box: Box, socket: Client) {
    if (socket !== box.client) return
    // The box keeps its stdin and whatever output it was about to send: the site can come back
    box.client = null
    box.progress?.()
  }

  private dropClient(box: Box) {
    const client = box.client
    box.client = null
    if (client) quiet(() => client.end())
  }

  /** Hand the held stdout chunk to the client, as much of it as the socket takes now */
  private deliver(box: Box) {
    const client = box.client
    if (!client || !box.pending) return
    let wrote = 0
    try { wrote = client.write(box.pending) } catch { wrote = 0 }
    if (wrote >= box.pending.length) {
      box.pending = null
      const wake = box.wakePump
      box.wakePump = null
      wake?.()
      box.progress?.()
    } else if (wrote > 0) {
      // The rest goes out on drain, or to the next client if this one leaves first
      box.pending = box.pending.subarray(wrote)
    }
  }

  // Reads stdout one chunk at a time, only once the last chunk is with a client. Reading one
  // chunk ahead even with nobody attached is what lets the end of the stream be seen promptly
  // when the box exits; beyond that chunk the box blocks on its pipe.
  private async pumpStdout(box: Box) {
    const reader = box.proc.stdout.getReader()
    try {
      // Ends at the end of the stream, or when finish() cancels it
      while (true) {
        if (box.pending) {
          await new Promise<void>(resolve => { box.wakePump = resolve })
          continue
        }
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        box.pending = value
        this.deliver(box)
      }
    } catch { /* the stream was cancelled: the box is being put away */ }
    box.stdoutEnded = true
    box.progress?.()
    quiet(() => reader.releaseLock())
  }

  // -------------------------------------------------------------------------
  // stdin
  // -------------------------------------------------------------------------

  private toStdin(box: Box, data: Uint8Array) {
    if (box.stdinDead || box.info.state !== "running") return
    if (box.stdinBusy) {
      // The socket is paused, but what was already in flight still arrives: keep it, bounded
      if (box.stdinQueued + data.length > STDIN_QUEUE_MAX) { this.dropClient(box); return }
      box.stdinQueue.push(data.slice())
      box.stdinQueued += data.length
      return
    }
    this.writeStdin(box, data)
  }

  private writeStdin(box: Box, data: Uint8Array) {
    let flushed: number | Promise<number>
    try {
      box.proc.stdin.write(data)
      flushed = box.proc.stdin.flush()
    } catch {
      // The box closed its stdin or is gone: nothing more can reach it
      box.stdinDead = true
      return
    }
    if (typeof flushed === "number") return
    // The pipe is full: stop reading from the client until the box catches up
    box.stdinBusy = true
    if (box.client) quiet(() => box.client!.pause())
    flushed.then(() => this.stdinDrained(box), () => { box.stdinDead = true; this.stdinDrained(box) })
  }

  private stdinDrained(box: Box) {
    box.stdinBusy = false
    if (box.stdinDead) { box.stdinQueue = []; box.stdinQueued = 0 }
    if (box.stdinQueue.length) {
      const queued = box.stdinQueue.length === 1 ? box.stdinQueue[0] : Buffer.concat(box.stdinQueue)
      box.stdinQueue = []
      box.stdinQueued = 0
      this.writeStdin(box, queued)
      if (box.stdinBusy) return
    }
    if (box.client) quiet(() => box.client!.resume())
  }

  // -------------------------------------------------------------------------
  // stderr
  // -------------------------------------------------------------------------

  private async readStderr(box: Box) {
    const reader = box.proc.stderr.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.length) continue
        // Only the tail matters: drop whole chunks from the front, then trim the first one
        box.stderrChunks.push(value)
        box.stderrBytes += value.length
        while (box.stderrBytes - box.stderrChunks[0].length >= this.stderrMax) box.stderrBytes -= box.stderrChunks.shift()!.length
        if (box.stderrBytes > this.stderrMax) {
          const cut = box.stderrBytes - this.stderrMax
          box.stderrChunks[0] = box.stderrChunks[0].subarray(cut)
          box.stderrBytes -= cut
        }
      }
    } catch { /* cancelled */ }
    box.stderrEnded = true
    box.progress?.()
    quiet(() => reader.releaseLock())
  }

  private stderrText(box: Box): string {
    return new TextDecoder().decode(Buffer.concat(box.stderrChunks))
  }

  // -------------------------------------------------------------------------
  // The end
  // -------------------------------------------------------------------------

  private async finish(box: Box, code: number | null) {
    box.finishing = true
    // The last output and systemd-run's summary may still be in the pipes: give them, and a
    // client to take them, a little while
    const deadline = Date.now() + DRAIN_AFTER_EXIT_MS
    const done = () => box.stderrEnded && box.stdoutEnded && !box.pending
    while (!done() && Date.now() < deadline) {
      // Woken by progress (a chunk delivered, a stream ended, a client gone), else re-checked
      // every 100 ms so the deadline holds
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now())))
        box.progress = () => { clearTimeout(timer); resolve() }
      })
      box.progress = null
    }
    box.progress = null

    // Whatever wasn't taken in time is dropped
    quiet(() => { void box.proc.stdout.cancel().catch(() => {}) })
    quiet(() => { void box.proc.stderr.cancel().catch(() => {}) })
    box.pending = null
    const wake = box.wakePump
    box.wakePump = null
    wake?.()
    this.dropClient(box)
    quiet(() => box.listener?.stop(true))
    box.listener = null
    quiet(() => unlinkSync(box.info.socket))
    box.stdinQueue = []
    box.stdinQueued = 0
    box.stdinDead = true
    // Let go of our end of its stdin: a leftover child of the box may still be reading it
    quiet(() => { const ended = box.proc.stdin.end() as unknown; if (ended instanceof Promise) ended.catch(() => {}) })

    let rest = ""
    try {
      const parsed = parseRunSummary(this.stderrText(box))
      rest = parsed.rest
      box.info.exit = boxExitCause(parsed.summary, box.asked, code, rest)
      const first = box.info.exit
      if (!box.asked && this.askedLate && (first.cause === "failed" || (first.cause === "signal" && first.signal === "TERM"))) {
        const late = await this.askedLate({ ...box.info }).catch(() => null)
        if (late && !box.asked) box.asked = late
        if (box.asked) box.info.exit = boxExitCause(parsed.summary, box.asked, code, rest, first.at)
      }
    } catch (err) {
      box.info.exit = { cause: "failed", code, signal: null, detail: String(err).slice(0, 500), at: Date.now() }
    }
    box.stderrRest = rest
    box.stderrChunks = []
    box.stderrBytes = 0
    box.info.state = "exited"
    box.markExited()

    try {
      const ret = this.onExit?.({ ...box.info }, rest) as unknown
      if (ret instanceof Promise) ret.catch(() => {})
    } catch { /* the daemon's problem, not the host's */ }

    const timer = setTimeout(() => { if (this.boxes.get(box.info.id) === box) this.boxes.delete(box.info.id) }, this.keepExitedMs)
    timer.unref?.()
  }
}
