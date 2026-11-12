import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { FnConnection, FnCrashedError, FnThrewError, FnUnavailableError, REQ_BODY_CHUNK, type CaptureHooks } from "../fn-dispatch.ts"
import { decodeJson, encodeFrame, encodeJsonFrame, Frame, FrameDecoder, INITIAL_WINDOW, type DecodedFrame, type LogPayload } from "../fn-protocol.ts"

const DIR = join(process.env.TMPDIR ?? "/tmp/claude-1000", "candy-fn-build", "phase1a", `dispatch-${process.pid}`)
let sockN = 0

beforeAll(() => mkdir(DIR, { recursive: true }))
afterAll(() => rm(DIR, { recursive: true, force: true }))

const enc = new TextEncoder()
const dec = new TextDecoder()

// The function side of the socket, speaking raw frames
class FakeFn {
  frames: DecodedFrame[] = []
  // Every frame type in arrival order, never consumed
  seen: number[] = []
  closed = false
  private decoder = new FrameDecoder()
  private waiters: { pred: (f: DecodedFrame) => boolean; resolve: (f: DecodedFrame) => void }[] = []
  private closeWaiters: (() => void)[] = []
  private out: Uint8Array[] = []
  sock!: Bun.Socket<undefined>

  static async connect(path: string): Promise<FakeFn> {
    const fn = new FakeFn()
    fn.sock = await Bun.connect({
      unix: path,
      socket: {
        data: (_s, d) => {
          for (const f of fn.decoder.push(d)) {
            fn.frames.push(f)
            fn.seen.push(f.type)
            const i = fn.waiters.findIndex(w => w.pred(f))
            if (i >= 0) fn.waiters.splice(i, 1)[0].resolve(f)
          }
        },
        drain: () => fn.flush(),
        close: () => { fn.closed = true; for (const w of fn.closeWaiters.splice(0)) w() },
      },
    })
    return fn
  }

  // Resolves with the first matching frame, already received or future
  next(type: number | number[], streamId?: number): Promise<DecodedFrame> {
    const types = Array.isArray(type) ? type : [type]
    const pred = (f: DecodedFrame) => types.includes(f.type) && (streamId === undefined || f.streamId === streamId)
    const seen = this.frames.find(pred)
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1)
      return Promise.resolve(seen)
    }
    return new Promise(resolve => this.waiters.push({
      pred, resolve: f => { this.frames.splice(this.frames.indexOf(f), 1); resolve(f) },
    }))
  }

  waitClosed(): Promise<void> {
    return this.closed ? Promise.resolve() : new Promise(r => this.closeWaiters.push(r))
  }

  send(type: number, id: number, payload?: Uint8Array | string) {
    this.write(encodeFrame(type, id, typeof payload === "string" ? enc.encode(payload) : payload))
  }

  json(type: number, id: number, obj: unknown) {
    this.write(encodeJsonFrame(type, id, obj))
  }

  hello(token = "tok", window?: number) {
    this.json(Frame.HELLO, 0, { token, instance: "i1", version: 1, ...(window ? { window } : {}) })
  }

  respond(id: number, status = 200, headers: [string, string][] = [], body?: string) {
    this.json(Frame.RES_HEAD, id, { status, statusText: "", headers })
    if (body) this.send(Frame.RES_BODY, id, body)
    this.send(Frame.RES_END, id)
  }

  private write(b: Uint8Array) {
    if (this.out.length) return void this.out.push(b)
    const n = this.sock.write(b)
    if (n < b.length) this.out.push(b.subarray(n))
  }

  private flush() {
    while (this.out.length) {
      const n = this.sock.write(this.out[0])
      if (n < this.out[0].length) { this.out[0] = this.out[0].subarray(n); return }
      this.out.shift()
    }
  }

  close() { this.sock.end() }
}

interface Pair {
  conn: FnConnection
  fn: FakeFn
  logs: [string, LogPayload][]
  events: string[]
  stop(): void
}

async function pair(opts: { hello?: boolean; window?: number; onBye?: (c: FnConnection) => void } = {}): Promise<Pair> {
  const path = join(DIR, `s${sockN++}.sock`)
  const logs: [string, LogPayload][] = []
  const events: string[] = []
  let gotConn!: (c: FnConnection) => void
  const connP = new Promise<FnConnection>(r => { gotConn = r })
  const server = Bun.listen<{ conn: FnConnection }>({
    unix: path,
    socket: {
      open(sock) {
        const conn: FnConnection = new FnConnection(sock, {
          onHello: h => h.token === "tok",
          onLog: (id, l) => logs.push([id, l]),
          onBye: () => { events.push("bye"); opts.onBye?.(conn) },
          onClose: () => events.push("close"),
        })
        sock.data = { conn }
        gotConn(conn)
      },
      data(sock, d) { sock.data.conn.feed(d) },
      drain(sock) { sock.data.conn.flush() },
      close(sock) { sock.data.conn.close() },
      error(sock) { sock.data.conn.close() },
    },
  })
  const fn = await FakeFn.connect(path)
  const conn = await connP
  if (opts.hello !== false) {
    fn.hello("tok", opts.window)
    await until(() => conn.ready)
  }
  return { conn, fn, logs, events, stop: () => { fn.close(); server.stop(true) } }
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition")
    await Bun.sleep(2)
  }
}

function recorder() {
  const rec = { req: 0, head: null as null | [number, [string, string][]], res: 0, end: [] as [string, unknown][] }
  const hooks: CaptureHooks = {
    onRequestChunk: b => { rec.req += b.length },
    onResponseHead: (s, h) => { rec.head = [s, h] },
    onResponseChunk: b => { rec.res += b.length },
    onEnd: (o, e) => { rec.end.push([o, e]) },
  }
  return { rec, hooks }
}

const meta = (requestId = "r1", capture?: CaptureHooks) => ({ requestId, clientIp: "10.0.0.5", capture })

describe("FnConnection handshake", () => {
  it("drops a connection with the wrong token", async () => {
    const p = await pair({ hello: false })
    p.fn.hello("nope")
    await p.fn.waitClosed()
    expect(p.conn.ready).toBe(false)
    expect(p.events).toContain("close")
    p.stop()
  })

  it("drops a connection that sends anything before HELLO", async () => {
    const p = await pair({ hello: false })
    p.fn.respond(1)
    await p.fn.waitClosed()
    expect(p.conn.ready).toBe(false)
    await expect(p.conn.dispatch(new Request("http://a.localhost/"), meta())).rejects.toBeInstanceOf(FnUnavailableError)
    p.stop()
  })

  it("acks HELLO with the hot flag", async () => {
    const p = await pair()
    expect(p.conn.hello?.instance).toBe("i1")
    p.conn.ack(true)
    expect(decodeJson<{ hot: boolean }>((await p.fn.next(Frame.HELLO_ACK)).payload)).toEqual({ hot: true })
    expect(p.conn.hot).toBe(true)
    p.stop()
  })
})

describe("FnConnection dispatch", () => {
  it("round-trips a simple request with capture hooks", async () => {
    const p = await pair()
    const { rec, hooks } = recorder()
    const resP = p.conn.dispatch(new Request("http://a.localhost/x?y=1", { headers: { "x-a": "b" } }), meta("r1", hooks))
    expect(p.conn.inflight).toBe(1)

    const head = await p.fn.next(Frame.REQ_HEAD)
    const h = decodeJson<any>(head.payload)
    expect(h).toMatchObject({ method: "GET", url: "http://a.localhost/x?y=1", clientIp: "10.0.0.5", requestId: "r1" })
    expect(h.headers).toContainEqual(["x-a", "b"])
    await p.fn.next(Frame.REQ_END, head.streamId)

    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 201, statusText: "Created", headers: [["x-r", "1"], ["set-cookie", "a=1"], ["set-cookie", "b=2"]] })
    p.fn.send(Frame.RES_BODY, head.streamId, "hel")
    p.fn.send(Frame.RES_BODY, head.streamId, "lo")
    p.fn.send(Frame.RES_END, head.streamId)

    const res = await resP
    expect(res.status).toBe(201)
    expect(res.headers.get("x-r")).toBe("1")
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"])
    expect(await res.text()).toBe("hello")
    expect(p.conn.inflight).toBe(0)
    expect(rec.head?.[0]).toBe(201)
    expect(rec.res).toBe(5)
    expect(rec.end).toEqual([["ok", undefined]])
    p.stop()
  })

  it("handles null-body statuses", async () => {
    const p = await pair()
    const resP = p.conn.dispatch(new Request("http://a.localhost/"), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.respond(head.streamId, 204)
    const res = await resP
    expect(res.status).toBe(204)
    expect(res.body).toBeNull()
    await until(() => p.conn.inflight === 0)
    p.stop()
  })

  it("streams a large upload in chunks of at most 64 KiB", async () => {
    const p = await pair()
    const total = 5 * 1024 * 1024 + 123
    const piece = new Uint8Array(300_000).fill(7)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) return c.close()
        const n = Math.min(piece.length, total - sent)
        c.enqueue(piece.subarray(0, n))
        sent += n
      },
    })
    const { rec, hooks } = recorder()
    const resP = p.conn.dispatch(new Request("http://a.localhost/up", { method: "POST", body, duplex: "half" } as RequestInit), meta("r", hooks))
    const head = await p.fn.next(Frame.REQ_HEAD)
    let got = 0
    let biggest = 0
    for (;;) {
      const f = await p.fn.next([Frame.REQ_BODY, Frame.REQ_END], head.streamId)
      if (f.type === Frame.REQ_END) break
      got += f.payload.length
      biggest = Math.max(biggest, f.payload.length)
      expect(f.payload.every(b => b === 7)).toBe(true)
    }
    expect(got).toBe(total)
    expect(biggest).toBeLessThanOrEqual(REQ_BODY_CHUNK)
    expect(rec.req).toBe(total)
    p.fn.respond(head.streamId, 200, [], "ok")
    expect(await (await resP).text()).toBe("ok")
    p.stop()
  }, 20_000)

  it("streams the response as it arrives", async () => {
    const p = await pair()
    const resP = p.conn.dispatch(new Request("http://a.localhost/sse"), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [["content-type", "text/event-stream"]] })
    const res = await resP
    const reader = res.body!.getReader()
    for (const msg of ["data: 1\n\n", "data: 2\n\n"]) {
      p.fn.send(Frame.RES_BODY, head.streamId, msg)
      const { value } = await reader.read()
      expect(dec.decode(value)).toBe(msg)
    }
    p.fn.send(Frame.RES_END, head.streamId)
    expect((await reader.read()).done).toBe(true)
    p.stop()
  })

  it("multiplexes many concurrent streams", async () => {
    const p = await pair()
    const n = 40
    const promises = Array.from({ length: n }, (_, i) => p.conn.dispatch(new Request(`http://a.localhost/${i}`), meta(`r${i}`)))
    const heads = []
    for (let i = 0; i < n; i++) heads.push(await p.fn.next(Frame.REQ_HEAD))
    expect(p.conn.inflight).toBe(n)
    // Answer in reverse, interleaving body frames across streams
    for (const h of [...heads].reverse()) p.fn.json(Frame.RES_HEAD, h.streamId, { status: 200, statusText: "", headers: [] })
    for (const h of heads) p.fn.send(Frame.RES_BODY, h.streamId, decodeJson<any>(h.payload).url.split("/").pop() + "-")
    for (const h of heads) p.fn.send(Frame.RES_BODY, h.streamId, "done")
    for (const h of heads) p.fn.send(Frame.RES_END, h.streamId)
    const texts = await Promise.all(promises.map(async r => (await r).text()))
    expect(texts).toEqual(Array.from({ length: n }, (_, i) => `${i}-done`))
    expect(p.conn.inflight).toBe(0)
    p.stop()
  })

  it("delivers a big response to a slow reader without buffering all of it", async () => {
    const p = await pair()
    const resP = p.conn.dispatch(new Request("http://a.localhost/big"), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    const total = 24 * 1024 * 1024
    const chunk = new Uint8Array(256 * 1024).fill(1)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [] })
    for (let sent = 0; sent < total; sent += chunk.length) p.fn.send(Frame.RES_BODY, head.streamId, chunk)
    p.fn.send(Frame.RES_END, head.streamId)

    const reader = (await resP).body!.getReader()
    let got = 0
    let peak = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.length
      peak = Math.max(peak, (p.conn as any).inBuffered)
      if (got % (4 * 1024 * 1024) === 0) await Bun.sleep(20)
    }
    expect(got).toBe(total)
    if (process.env.FN_DEBUG) console.log("peak buffered", peak)
    // The socket is paused at 4 MiB, so the daemon never holds the whole body
    expect(peak).toBeLessThan(12 * 1024 * 1024)
    p.stop()
  }, 20_000)
})

describe("FnConnection flow control (HELLO.window)", () => {
  const W = 256 * 1024

  it("acks with its own window only for a fn that announced one", async () => {
    const plain = await pair()
    plain.conn.ack(false)
    expect(decodeJson(( await plain.fn.next(Frame.HELLO_ACK)).payload)).toEqual({ hot: false })
    expect(plain.conn.flowControlled).toBe(false)
    plain.stop()
    const flow = await pair({ window: W })
    flow.conn.ack(true)
    expect(decodeJson((await flow.fn.next(Frame.HELLO_ACK)).payload)).toEqual({ hot: true, window: INITIAL_WINDOW })
    expect(flow.conn.flowControlled).toBe(true)
    flow.stop()
  })

  it("sends request bodies only as far as the fn granted", async () => {
    const p = await pair({ window: W })
    const total = 3 * W + 1000
    const resP = p.conn.dispatch(new Request("http://a.localhost/up", { method: "POST", body: new Uint8Array(total).fill(3) }), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    const drainBody = async () => {
      let n = 0
      await Bun.sleep(50)
      while (p.fn.frames.some(f => f.type === Frame.REQ_BODY && f.streamId === head.streamId)) n += (await p.fn.next(Frame.REQ_BODY, head.streamId)).payload.length
      return n
    }
    // Nothing more than the window arrives until we grant more
    expect(await drainBody()).toBe(W)
    p.fn.json(Frame.WINDOW, head.streamId, { bytes: W })
    expect(await drainBody()).toBe(W)
    p.fn.json(Frame.WINDOW, head.streamId, { bytes: 10 * W })
    let rest = 0
    for (;;) {
      const f = await p.fn.next([Frame.REQ_BODY, Frame.REQ_END], head.streamId)
      if (f.type === Frame.REQ_END) break
      rest += f.payload.length
    }
    expect(rest).toBe(total - 2 * W)
    p.fn.respond(head.streamId, 200, [], "ok")
    expect(await (await resP).text()).toBe("ok")
    p.stop()
  })

  it("grants response credit as the consumer reads, and never pauses the socket", async () => {
    const p = await pair({ window: W })
    let paused = 0
    const sock = (p.conn as any).socket
    const realPause = sock.pause?.bind(sock)
    sock.pause = () => { paused++; realPause?.() }
    const resP = p.conn.dispatch(new Request("http://a.localhost/sse"), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [] })
    p.fn.send(Frame.RES_BODY, head.streamId, new Uint8Array(1000))
    const reader = (await resP).body!.getReader()
    expect((await reader.read()).value!.length).toBe(1000)
    const grant = await p.fn.next(Frame.WINDOW, head.streamId)
    expect(decodeJson(grant.payload)).toEqual({ bytes: 1000 })
    p.fn.send(Frame.RES_END, head.streamId)
    expect((await reader.read()).done).toBe(true)
    expect(paused).toBe(0)
    p.stop()
  })

  it("keeps serving other streams while one consumer stalls", async () => {
    const p = await pair({ window: W })
    const slowP = p.conn.dispatch(new Request("http://a.localhost/slow"), meta("slow"))
    const slowHead = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, slowHead.streamId, { status: 200, statusText: "", headers: [] })
    // A well-behaved fn fills the window it was given (INITIAL_WINDOW) and stops
    const piece = new Uint8Array(64 * 1024)
    for (let sent = 0; sent < INITIAL_WINDOW; sent += piece.length) p.fn.send(Frame.RES_BODY, slowHead.streamId, piece)
    const slow = await slowP  // nobody reads this body
    // Another request on the same socket still completes
    const fastP = p.conn.dispatch(new Request("http://a.localhost/fast"), meta("fast"))
    const fastHead = await p.fn.next(Frame.REQ_HEAD)
    p.fn.respond(fastHead.streamId, 200, [], "fast")
    expect(await (await fastP).text()).toBe("fast")
    await slow.body!.cancel()
    p.stop()
  })

  it("cuts off a stream whose fn ignores its window", async () => {
    const p = await pair({ window: W })
    const resP = p.conn.dispatch(new Request("http://a.localhost/flood"), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [] })
    const res = await resP
    const piece = new Uint8Array(256 * 1024)
    for (let sent = 0; sent < 4 * INITIAL_WINDOW; sent += piece.length) p.fn.send(Frame.RES_BODY, head.streamId, piece)
    await p.fn.next(Frame.CANCEL, head.streamId)
    await expect(res.arrayBuffer()).rejects.toThrow("buffer limit")
    p.stop()
  })
})

describe("FnConnection cancel and errors", () => {
  it("sends CANCEL when the client aborts before the head", async () => {
    const p = await pair()
    const ac = new AbortController()
    const { rec, hooks } = recorder()
    const resP = p.conn.dispatch(new Request("http://a.localhost/", { signal: ac.signal }), meta("r", hooks))
    const head = await p.fn.next(Frame.REQ_HEAD)
    ac.abort()
    await expect(resP).rejects.toThrow()
    await p.fn.next(Frame.CANCEL, head.streamId)
    expect(p.conn.inflight).toBe(0)
    expect(rec.end.map(e => e[0])).toEqual(["cancelled"])
    // Late frames for the cancelled stream are ignored
    p.fn.respond(head.streamId, 200, [], "late")
    p.stop()
  })

  it("sends CANCEL when the client aborts mid-body", async () => {
    const p = await pair()
    const ac = new AbortController()
    const resP = p.conn.dispatch(new Request("http://a.localhost/", { signal: ac.signal }), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [] })
    p.fn.send(Frame.RES_BODY, head.streamId, "a")
    const reader = (await resP).body!.getReader()
    expect(dec.decode((await reader.read()).value)).toBe("a")
    ac.abort()
    await p.fn.next(Frame.CANCEL, head.streamId)
    await expect(reader.read()).rejects.toThrow()
    p.stop()
  })

  it("sends CANCEL when the response consumer cancels", async () => {
    const p = await pair()
    const { rec, hooks } = recorder()
    const resP = p.conn.dispatch(new Request("http://a.localhost/"), meta("r", hooks))
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [] })
    const res = await resP
    await res.body!.cancel()
    await p.fn.next(Frame.CANCEL, head.streamId)
    expect(p.conn.inflight).toBe(0)
    expect(rec.end.map(e => e[0])).toEqual(["cancelled"])
    p.stop()
  })

  it("never sends frames for an already-aborted request", async () => {
    const p = await pair()
    const ac = new AbortController()
    ac.abort()
    await expect(p.conn.dispatch(new Request("http://a.localhost/", { signal: ac.signal }), meta())).rejects.toThrow()
    expect(p.conn.inflight).toBe(0)
    p.stop()
  })

  it("rejects with FnThrewError on ERR before the head", async () => {
    const p = await pair()
    const { rec, hooks } = recorder()
    const resP = p.conn.dispatch(new Request("http://a.localhost/"), meta("r", hooks))
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.ERR, head.streamId, { message: "boom", stack: "Error: boom\n  at fetch (app.ts:3)" })
    const err = await resP.catch(e => e)
    expect(err).toBeInstanceOf(FnThrewError)
    expect(err.message).toBe("boom")
    expect(err.fnStack).toContain("app.ts:3")
    expect(rec.end).toEqual([["threw", { message: "boom", stack: "Error: boom\n  at fetch (app.ts:3)" }]])
    p.stop()
  })

  it("errors the body with FnThrewError on ERR mid-stream", async () => {
    const p = await pair()
    const resP = p.conn.dispatch(new Request("http://a.localhost/"), meta())
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, head.streamId, { status: 200, statusText: "", headers: [] })
    p.fn.send(Frame.RES_BODY, head.streamId, "part")
    p.fn.json(Frame.ERR, head.streamId, { message: "late boom" })
    const reader = (await resP).body!.getReader()
    expect(dec.decode((await reader.read()).value)).toBe("part")
    expect(await reader.read().catch(e => e)).toBeInstanceOf(FnThrewError)
    p.stop()
  })

  it("fails every in-flight stream with FnCrashedError when the fn dies", async () => {
    const p = await pair()
    const a = recorder(), b = recorder()
    const pa = p.conn.dispatch(new Request("http://a.localhost/a"), meta("a", a.hooks))
    const pb = p.conn.dispatch(new Request("http://a.localhost/b"), meta("b", b.hooks))
    const ha = await p.fn.next(Frame.REQ_HEAD)
    await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.RES_HEAD, ha.streamId, { status: 200, statusText: "", headers: [] })
    p.fn.send(Frame.RES_BODY, ha.streamId, "x")
    const reader = (await pa).body!.getReader()
    expect(dec.decode((await reader.read()).value)).toBe("x")

    p.fn.close()
    expect(await pb.catch(e => e)).toBeInstanceOf(FnCrashedError)
    expect(await reader.read().catch(e => e)).toBeInstanceOf(FnCrashedError)
    await until(() => p.events.includes("close"))
    expect(p.conn.inflight).toBe(0)
    expect(p.conn.ready).toBe(false)
    expect(a.rec.end[0][0]).toBe("crashed")
    expect(b.rec.end[0][0]).toBe("crashed")
    await expect(p.conn.dispatch(new Request("http://a.localhost/"), meta())).rejects.toBeInstanceOf(FnCrashedError)
    p.stop()
  })

  it("closes on an oversized frame", async () => {
    const p = await pair()
    const pending = p.conn.dispatch(new Request("http://a.localhost/"), meta())
    const hdr = new Uint8Array(9)
    new DataView(hdr.buffer).setUint32(0, 2 * 1024 * 1024)
    hdr[4] = Frame.RES_BODY
    ;(p.fn as any).sock.write(hdr)
    expect(await pending.catch(e => e)).toBeInstanceOf(FnCrashedError)
    await p.fn.waitClosed()
    p.stop()
  })
})

describe("FnConnection logs and lifecycle", () => {
  it("routes LOG frames to the request id, even after RES_END", async () => {
    const p = await pair()
    const resP = p.conn.dispatch(new Request("http://a.localhost/"), meta("req-9"))
    const head = await p.fn.next(Frame.REQ_HEAD)
    p.fn.json(Frame.LOG, head.streamId, { level: "info", text: "inside", ts: 1 })
    p.fn.respond(head.streamId, 200, [], "ok")
    await (await resP).text()
    p.fn.json(Frame.LOG, head.streamId, { level: "warn", text: "waitUntil", ts: 2 })
    p.fn.json(Frame.LOG, 0, { level: "log", text: "global", ts: 3 })
    await until(() => p.logs.length === 3)
    expect(p.logs.map(([id, l]) => [id, l.text])).toEqual([["req-9", "inside"], ["req-9", "waitUntil"], ["", "global"]])
    p.stop()
  })

  it("serves a REQ_HEAD sent before BYE_ACK, then refuses new work", async () => {
    let raced: Promise<Response> | null = null
    const p = await pair({
      // The daemon routes one last request while handling BYE
      onBye: c => { raced = c.dispatch(new Request("http://a.localhost/raced"), meta("raced")) },
    })
    p.fn.json(Frame.BYE, 0, { reason: "idle" })
    const head = await p.fn.next(Frame.REQ_HEAD)
    await p.fn.next(Frame.BYE_ACK)
    expect(p.conn.ready).toBe(false)
    // REQ_HEAD reached the fn before BYE_ACK, so the fn serves it
    expect(p.fn.seen.indexOf(Frame.REQ_HEAD)).toBeLessThan(p.fn.seen.indexOf(Frame.BYE_ACK))
    p.fn.respond(head.streamId, 200, [], "served")
    expect(await (await raced!).text()).toBe("served")
    await expect(p.conn.dispatch(new Request("http://a.localhost/"), meta())).rejects.toBeInstanceOf(FnUnavailableError)
    p.stop()
  })

  it("holds BYE_ACK while a handed-out handle is still being dispatched", async () => {
    const p = await pair()
    const release = p.conn.holdBye()
    p.fn.json(Frame.BYE, 0, { reason: "idle" })
    await until(() => p.events.includes("bye"))
    expect(p.conn.ready).toBe(false)
    await Bun.sleep(20)
    expect(p.fn.frames.some(f => f.type === Frame.BYE_ACK)).toBe(false)

    const resP = p.conn.dispatch(new Request("http://a.localhost/late"), meta())
    release()
    const head = await p.fn.next(Frame.REQ_HEAD)
    await p.fn.next(Frame.BYE_ACK)
    expect(p.fn.seen.indexOf(Frame.REQ_HEAD)).toBeLessThan(p.fn.seen.indexOf(Frame.BYE_ACK))
    p.fn.respond(head.streamId, 200, [], "ok")
    expect(await (await resP).text()).toBe("ok")
    p.stop()
  })

  it("sends DRAIN and stops taking requests", async () => {
    const p = await pair()
    p.conn.drain()
    p.conn.drain()
    await p.fn.next(Frame.DRAIN)
    expect(p.conn.ready).toBe(false)
    await expect(p.conn.dispatch(new Request("http://a.localhost/"), meta())).rejects.toBeInstanceOf(FnUnavailableError)
    await Bun.sleep(10)
    expect(p.fn.frames.filter(f => f.type === Frame.DRAIN)).toHaveLength(0)
    p.stop()
  })
})
