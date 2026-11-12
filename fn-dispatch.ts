// Daemon side of one function connection: many request streams multiplexed
// over the socket the fn dialed in on (see FUNCTIONS_DESIGN.md, Transport).

import {
  decodeJson, encodeFrame, encodeJsonFrame, Frame, FrameDecoder, INITIAL_WINDOW,
  type ErrPayload, type HelloPayload, type LogPayload, type ResHeadPayload, type WindowPayload,
} from "./fn-protocol.ts"

export type CaptureHooks = {
  onRequestChunk?(b: Uint8Array): void
  onResponseHead?(status: number, headers: [string, string][]): void
  onResponseChunk?(b: Uint8Array): void
  onEnd?(outcome: "ok" | "threw" | "cancelled" | "crashed", err?: { message: string; stack?: string }): void
}

export class FnThrewError extends Error {
  constructor(message: string, readonly fnStack?: string) {
    super(message)
    this.name = "FnThrewError"
    // The fn's stack is the useful one for the 500 page and the request log
    if (fnStack) this.stack = fnStack
  }
}

export class FnCrashedError extends Error {
  constructor(message = "function process went away mid-request") {
    super(message)
    this.name = "FnCrashedError"
  }
}

// Thrown by dispatch() when the connection no longer takes requests (after
// BYE_ACK, DRAIN or close). Nothing reached the fn, so a retry on another
// instance is safe. Subclass of FnCrashedError so callers that only know the
// contract errors still treat it as a failed dispatch.
export class FnUnavailableError extends FnCrashedError {
  readonly retryable = true
  constructor(message = "function instance is not accepting requests") {
    super(message)
    this.name = "FnUnavailableError"
  }
}

export interface FnSocket {
  write(b: Uint8Array): number | void
  end(): void
  pause?(): void
  resume?(): void
}

export interface FnConnectionOpts {
  onHello(h: HelloPayload): boolean
  onLog?(requestId: string, log: LogPayload): void
  onBye?(): void
  onClose?(): void
}

type ConnEvent = "bye" | "close" | "load" | "dispatch"

export const REQ_BODY_CHUNK = 64 * 1024
// Outbound bytes queued in userspace before request-body pumping waits for drain
const OUT_HIGH = 1024 * 1024
// Peers without flow control (no HELLO.window): total buffered response bytes
// before the socket is paused (if it can be), and the level at which it resumes.
// With flow control each stream is bounded by its window instead, so one slow
// consumer never stalls the other streams on the socket.
const IN_HIGH = 4 * 1024 * 1024
const IN_LOW = 1024 * 1024
// Hard per-stream cap when the consumer stalls and the socket can't be paused
const STREAM_HARD_CAP = 32 * 1024 * 1024
// A flow-controlled peer that overruns its window this far is cut off
const WINDOW_SLACK = 2 * INITIAL_WINDOW
// Largest single WINDOW grant we accept
const MAX_GRANT = 0x7fffffff
// LOG frames can trail RES_END (waitUntil work), so recent ids stay mapped
const RECENT_IDS = 256

const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

interface Stream {
  id: number
  requestId: string
  capture?: CaptureHooks
  resolve(r: Response): void
  reject(e: unknown): void
  headed: boolean
  done: boolean
  // Response body plumbing
  chunks: Uint8Array[]
  buffered: number
  ended: boolean
  error: unknown
  wake: (() => void) | null
  stopRequestBody: () => void
  detachAbort: () => void
  // Flow control: request-body bytes we may still send, and its waiter
  sendCredit: number
  creditWake: (() => void) | null
}

export class FnConnection {
  hot = false
  hello: HelloPayload | null = null

  private decoder = new FrameDecoder()
  private streams = new Map<number, Stream>()
  private recent = new Map<number, string>()
  private nextId = 1
  private helloed = false
  private closed = false
  private byeReceived = false
  private byeAcked = false
  private drained = false
  private byeHolds = 0
  private out: Uint8Array[] = []
  private outBytes = 0
  private writableWaiters: (() => void)[] = []
  private inBuffered = 0
  private paused = false
  // Set from HELLO.window: the fn grants credit per stream, both ways
  private flow = false
  private peerWindow = 0
  private listeners = new Map<ConnEvent, Set<() => void>>()

  constructor(private socket: FnSocket, private opts: FnConnectionOpts) {}

  get inflight(): number {
    return this.streams.size
  }

  // True while the pool may route new requests here
  get ready(): boolean {
    return this.helloed && !this.closed && !this.byeReceived && !this.drained
  }

  get isClosed(): boolean {
    return this.closed
  }

  get byeSeen(): boolean {
    return this.byeReceived
  }

  // Extension for the pool: lifecycle and load notifications
  on(ev: ConnEvent, cb: () => void): () => void {
    let set = this.listeners.get(ev)
    if (!set) this.listeners.set(ev, set = new Set())
    set.add(cb)
    return () => set!.delete(cb)
  }

  private emit(ev: ConnEvent): void {
    for (const cb of [...(this.listeners.get(ev) ?? [])]) {
      try { cb() } catch (e) { console.error(`[fn] ${ev} listener failed:`, e) }
    }
  }

  // Delays BYE_ACK while someone holds a handle they are about to dispatch on,
  // so a request the pool already handed out is still served by this instance.
  holdBye(): () => void {
    this.byeHolds++
    let released = false
    return () => {
      if (released) return
      released = true
      this.byeHolds--
      if (this.byeReceived && this.byeHolds === 0) this.byeAck()
    }
  }

  feed(chunk: Uint8Array): void {
    if (this.closed) return
    let frames
    try {
      frames = this.decoder.push(chunk)
    } catch (e) {
      console.error(`[fn] protocol error, dropping connection: ${(e as Error).message}`)
      this.close()
      return
    }
    for (const f of frames) {
      if (this.closed) return
      this.handleFrame(f.type, f.streamId, f.payload)
    }
  }

  private handleFrame(type: number, streamId: number, payload: Uint8Array): void {
    if (!this.helloed) {
      // Nothing is trusted before a valid HELLO
      if (type !== Frame.HELLO) return this.close()
      let h: HelloPayload
      try { h = decodeJson<HelloPayload>(payload) } catch { return this.close() }
      let ok = false
      try { ok = !!h && typeof h === "object" && this.opts.onHello(h) } catch { ok = false }
      if (!ok) return this.close()
      this.hello = h
      this.helloed = true
      if (Number.isInteger(h.window) && (h.window as number) > 0) {
        this.flow = true
        this.peerWindow = Math.min(h.window as number, MAX_GRANT)
      }
      return
    }

    switch (type) {
      case Frame.RES_HEAD: return this.onResHead(streamId, payload)
      case Frame.RES_BODY: return this.onResBody(streamId, payload)
      case Frame.RES_END: return this.onResEnd(streamId)
      case Frame.ERR: return this.onErr(streamId, payload)
      case Frame.CANCEL: return this.onFnCancel(streamId)
      case Frame.LOG: return this.onLogFrame(streamId, payload)
      case Frame.BYE: return this.onBye()
      case Frame.WINDOW: return this.onWindow(streamId, payload)
      default: return  // unknown or misdirected frames are ignored
    }
  }

  dispatch(req: Request, meta: { requestId: string; clientIp: string; capture?: CaptureHooks }): Promise<Response> {
    if (!this.helloed || this.closed || this.byeAcked || this.drained) {
      return Promise.reject(new FnUnavailableError())
    }
    if (req.signal.aborted) {
      return Promise.reject(req.signal.reason ?? new DOMException("request aborted", "AbortError"))
    }

    const id = this.allocId()
    let resolve!: (r: Response) => void, reject!: (e: unknown) => void
    const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej })
    const s: Stream = {
      id, requestId: meta.requestId, capture: meta.capture, resolve, reject,
      headed: false, done: false, chunks: [], buffered: 0, ended: false, error: null, wake: null,
      stopRequestBody: () => {}, detachAbort: () => {},
      sendCredit: this.peerWindow, creditWake: null,
    }
    this.streams.set(id, s)
    this.remember(id, meta.requestId)

    this.write(encodeJsonFrame(Frame.REQ_HEAD, id, {
      method: req.method,
      url: req.url,
      headers: [...req.headers],
      clientIp: meta.clientIp,
      requestId: meta.requestId,
    }))

    const onAbort = () => this.cancelStream(s, req.signal.reason ?? new DOMException("request aborted", "AbortError"))
    req.signal.addEventListener("abort", onAbort, { once: true })
    s.detachAbort = () => req.signal.removeEventListener("abort", onAbort)

    if (req.body) this.pumpRequestBody(s, req.body)
    else this.write(encodeFrame(Frame.REQ_END, id))

    this.emit("dispatch")
    this.emit("load")
    return promise
  }

  private allocId(): number {
    // Wraps before u32 overflow and skips 0 (control) and ids still in use
    for (;;) {
      const id = this.nextId
      this.nextId = id >= 0xffffffff ? 1 : id + 1
      if (!this.streams.has(id)) return id
    }
  }

  private async pumpRequestBody(s: Stream, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    let stopped = false
    s.stopRequestBody = () => {
      if (stopped) return
      stopped = true
      reader.cancel().catch(() => {})
    }
    try {
      for (;;) {
        if (this.outBytes > OUT_HIGH) await this.writable()
        if (stopped || s.done || this.closed) return
        const { done, value } = await reader.read()
        if (stopped || s.done || this.closed) return
        if (done) break
        if (!value?.length) continue
        try { s.capture?.onRequestChunk?.(value) } catch {}
        if (!this.flow) {
          for (let off = 0; off < value.length; off += REQ_BODY_CHUNK) {
            this.write(encodeFrame(Frame.REQ_BODY, s.id, value.subarray(off, off + REQ_BODY_CHUNK)))
          }
          continue
        }
        // Flow control: only as much as the fn has room for on this stream
        for (let off = 0; off < value.length;) {
          while (s.sendCredit <= 0 && !stopped && !s.done && !this.closed) {
            await new Promise<void>(r => { s.creditWake = r })
          }
          if (stopped || s.done || this.closed) return
          const n = Math.min(REQ_BODY_CHUNK, s.sendCredit, value.length - off)
          this.write(encodeFrame(Frame.REQ_BODY, s.id, value.subarray(off, off + n)))
          s.sendCredit -= n
          off += n
        }
      }
      stopped = true
      this.write(encodeFrame(Frame.REQ_END, s.id))
    } catch (e) {
      // The client's upload broke: the fn must not wait for the rest of it
      if (!stopped && !s.done) this.cancelStream(s, e)
    }
  }

  private onResHead(id: number, payload: Uint8Array): void {
    const s = this.streams.get(id)
    if (!s || s.headed) return
    let head: ResHeadPayload
    try { head = decodeJson<ResHeadPayload>(payload) } catch {
      return this.failStream(s, "crashed", new FnCrashedError("function sent a malformed RES_HEAD"), { message: "malformed RES_HEAD" })
    }
    s.headed = true
    const status = Number.isInteger(head.status) && head.status >= 200 && head.status <= 599 ? head.status : 500
    const headers = Array.isArray(head.headers) ? head.headers : []
    try { s.capture?.onResponseHead?.(status, headers) } catch {}

    let response: Response
    try {
      const h = new Headers()
      for (const [k, v] of headers) { try { h.append(k, v) } catch {} }
      const body = NULL_BODY_STATUS.has(status) ? null : this.bodyStream(s)
      response = new Response(body, { status, statusText: head.statusText ?? "", headers: h })
    } catch (e) {
      return this.failStream(s, "crashed", new FnCrashedError(`bad response head: ${(e as Error).message}`), { message: String(e) })
    }
    s.resolve(response)
  }

  private bodyStream(s: Stream): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      // Pull-based: the consumer's reads drain our per-stream queue
      pull: async (controller) => {
        for (;;) {
          const chunk = s.chunks.shift()
          if (chunk) {
            s.buffered -= chunk.length
            this.inBuffered -= chunk.length
            this.maybeResume()
            // The consumer took it: the fn may send that much more
            if (this.flow && !s.done && !this.closed) this.write(encodeJsonFrame(Frame.WINDOW, s.id, { bytes: chunk.length }))
            controller.enqueue(chunk)
            return
          }
          if (s.error) return controller.error(s.error)
          if (s.ended) return controller.close()
          await new Promise<void>(r => { s.wake = r })
          s.wake = null
        }
      },
      cancel: (reason) => {
        this.dropBuffered(s)
        if (!s.done) this.cancelStream(s, reason ?? new DOMException("response body cancelled", "AbortError"))
      },
    }, { highWaterMark: 0 })
  }

  private onResBody(id: number, payload: Uint8Array): void {
    const s = this.streams.get(id)
    if (!s || !s.headed || !payload.length) return
    try { s.capture?.onResponseChunk?.(payload) } catch {}
    s.chunks.push(payload)
    s.buffered += payload.length
    this.inBuffered += payload.length
    this.wakeStream(s)
    if (s.buffered > (this.flow ? INITIAL_WINDOW + WINDOW_SLACK : STREAM_HARD_CAP)) {
      // A stalled consumer (or a fn ignoring its window) would otherwise make us buffer without bound
      this.dropBuffered(s)
      this.cancelStream(s, new FnCrashedError("response consumer stalled; buffer limit exceeded"))
      return
    }
    // Flow-controlled streams are bounded by their window; never pause the
    // shared socket for them (that would stall every other stream)
    if (!this.flow && this.inBuffered > IN_HIGH && !this.paused && this.socket.pause) {
      this.paused = true
      this.socket.pause()
    }
  }

  private onResEnd(id: number): void {
    const s = this.streams.get(id)
    if (!s) return
    if (!s.headed) {
      return this.failStream(s, "crashed", new FnCrashedError("function ended the response without a head"), { message: "RES_END before RES_HEAD" })
    }
    s.ended = true
    this.wakeStream(s)
    this.finish(s, "ok")
  }

  private onErr(id: number, payload: Uint8Array): void {
    const s = this.streams.get(id)
    if (!s) return
    let err: ErrPayload
    try { err = decodeJson<ErrPayload>(payload) } catch { err = { message: "function threw" } }
    const message = typeof err.message === "string" ? err.message : "function threw"
    const stack = typeof err.stack === "string" ? err.stack : undefined
    this.failStream(s, "threw", new FnThrewError(message, stack), { message, stack })
  }

  private onFnCancel(id: number): void {
    const s = this.streams.get(id)
    if (!s) return
    // The fn gave up on the stream (its side was aborted); no CANCEL echo
    this.failStream(s, "cancelled", new FnCrashedError("function cancelled the request"))
  }

  private onLogFrame(id: number, payload: Uint8Array): void {
    if (!this.opts.onLog) return
    let log: LogPayload
    try { log = decodeJson<LogPayload>(payload) } catch { return }
    const requestId = id === 0 ? "" : this.streams.get(id)?.requestId ?? this.recent.get(id) ?? ""
    try { this.opts.onLog(requestId, log) } catch {}
  }

  private onWindow(id: number, payload: Uint8Array): void {
    const s = this.streams.get(id)
    if (!s) return
    let w: WindowPayload
    try { w = decodeJson<WindowPayload>(payload) } catch { return }
    if (!Number.isInteger(w?.bytes) || w.bytes <= 0 || w.bytes > MAX_GRANT) return
    s.sendCredit = Math.min(s.sendCredit + w.bytes, MAX_GRANT)
    const wake = s.creditWake
    s.creditWake = null
    wake?.()
  }

  private onBye(): void {
    if (this.byeReceived) return
    this.byeReceived = true
    try { this.opts.onBye?.() } catch {}
    this.emit("bye")
    // Listeners may have taken holds for handles already handed out
    if (this.byeHolds === 0) this.byeAck()
  }

  // Cancels from our side (client gone, consumer cancelled): tell the fn
  private cancelStream(s: Stream, reason: unknown): void {
    if (s.done) return
    if (!this.closed) this.write(encodeFrame(Frame.CANCEL, s.id))
    this.failStream(s, "cancelled", reason)
  }

  private failStream(s: Stream, outcome: "threw" | "cancelled" | "crashed", err: unknown, info?: { message: string; stack?: string }): void {
    if (s.done) return
    if (!s.headed) {
      s.reject(err)
    } else {
      s.error = err
      this.wakeStream(s)
    }
    this.finish(s, outcome, info)
  }

  private finish(s: Stream, outcome: "ok" | "threw" | "cancelled" | "crashed", info?: { message: string; stack?: string }): void {
    if (s.done) return
    s.done = true
    s.detachAbort()
    s.stopRequestBody()
    const wake = s.creditWake
    s.creditWake = null
    wake?.()
    this.streams.delete(s.id)
    try { s.capture?.onEnd?.(outcome, info) } catch {}
    this.emit("load")
  }

  private wakeStream(s: Stream): void {
    const w = s.wake
    s.wake = null
    w?.()
  }

  private dropBuffered(s: Stream): void {
    this.inBuffered -= s.buffered
    s.buffered = 0
    s.chunks = []
    this.maybeResume()
  }

  private maybeResume(): void {
    if (this.paused && this.inBuffered < IN_LOW) {
      this.paused = false
      this.socket.resume?.()
    }
  }

  private remember(id: number, requestId: string): void {
    this.recent.set(id, requestId)
    if (this.recent.size > RECENT_IDS) this.recent.delete(this.recent.keys().next().value!)
  }

  ack(hot: boolean): void {
    this.hot = hot
    // Our window for response bodies, only for a fn that does flow control
    if (!this.closed) this.write(encodeJsonFrame(Frame.HELLO_ACK, 0, this.flow ? { hot, window: INITIAL_WINDOW } : { hot }))
  }

  // True when the fn announced per-stream flow control in its HELLO
  get flowControlled(): boolean {
    return this.flow
  }

  byeAck(): void {
    if (this.byeAcked || this.closed) return
    this.byeAcked = true
    this.write(encodeJsonFrame(Frame.BYE_ACK, 0, {}))
  }

  drain(): void {
    if (this.drained || this.closed) return
    this.drained = true
    this.write(encodeJsonFrame(Frame.DRAIN, 0, {}))
  }

  // Must be called from the socket's drain handler: Bun sockets accept partial writes
  flush(): void {
    while (this.out.length && !this.closed) {
      const head = this.out[0]
      const n = this.rawWrite(head)
      if (n < head.length) {
        this.out[0] = head.subarray(n)
        this.outBytes -= n
        break
      }
      this.out.shift()
      this.outBytes -= head.length
    }
    if (this.outBytes <= OUT_HIGH) this.releaseWritable()
  }

  // Must be called when the socket closes or errors. Every in-flight stream
  // fails with FnCrashedError.
  close(): void {
    if (this.closed) return
    this.closed = true
    this.out = []
    this.outBytes = 0
    this.releaseWritable()
    for (const s of [...this.streams.values()]) {
      this.failStream(s, "crashed", new FnCrashedError(), { message: "function process went away mid-request" })
    }
    try { this.socket.end() } catch {}
    try { this.opts.onClose?.() } catch {}
    this.emit("close")
  }

  private write(frame: Uint8Array): void {
    if (this.closed) return
    if (this.out.length) {
      this.out.push(frame)
      this.outBytes += frame.length
      return
    }
    const n = this.rawWrite(frame)
    if (n < frame.length) {
      const rest = frame.subarray(n)
      this.out.push(rest)
      this.outBytes += rest.length
    }
  }

  private rawWrite(b: Uint8Array): number {
    let n: number | void
    try { n = this.socket.write(b) } catch { n = 0 }
    if (typeof n !== "number") return b.length
    return n < 0 ? 0 : n
  }

  private writable(): Promise<void> {
    return new Promise(r => this.writableWaiters.push(r))
  }

  private releaseWritable(): void {
    const ws = this.writableWaiters
    this.writableWaiters = []
    for (const w of ws) w()
  }
}
