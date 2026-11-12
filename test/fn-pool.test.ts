import { describe, expect, it } from "bun:test"
import { FnConnection } from "../fn-dispatch.ts"
import { FnPool, type FnInstanceHandle } from "../fn-pool.ts"
import { decodeJson, encodeFrame, encodeJsonFrame, Frame, FrameDecoder, type DecodedFrame } from "../fn-protocol.ts"

// A fake fn process: a real FnConnection over an in-memory socket
class FakeInstance {
  frames: DecodedFrame[] = []
  killed = false
  conn: FnConnection
  handle: FnInstanceHandle
  private decoder = new FrameDecoder()
  private resolveReady!: (c: FnConnection) => void
  private rejectReady!: (e: Error) => void

  constructor(readonly id: string) {
    this.conn = new FnConnection({
      write: b => { this.frames.push(...this.decoder.push(b)) },
      end: () => {},
    }, { onHello: h => h.token === "tok" })
    const ready = new Promise<FnConnection>((res, rej) => { this.resolveReady = res; this.rejectReady = rej })
    ready.catch(() => {})
    this.handle = {
      id, pid: 1000, conn: null, ready, hot: false, startedAt: Date.now(),
      kill: () => { this.killed = true; this.rejectReady(new Error("killed")); this.conn.close() },
    }
  }

  hello() {
    this.conn.feed(encodeJsonFrame(Frame.HELLO, 0, { token: "tok", instance: this.id, version: 1 }))
    this.resolveReady(this.conn)
  }

  failStart(msg = "import failed") { this.rejectReady(new Error(msg)) }
  bye() { this.conn.feed(encodeJsonFrame(Frame.BYE, 0, { reason: "idle" })) }
  exit() { this.conn.close() }
  types() { return this.frames.map(f => f.type) }
  ackPayloads() { return this.frames.filter(f => f.type === Frame.HELLO_ACK).map(f => decodeJson<{ hot: boolean }>(f.payload)) }

  // Starts a request on this instance; returns a finisher
  busy(): () => void {
    this.conn.dispatch(new Request("http://f.localhost/"), { requestId: "r", clientIp: "" }).catch(() => {})
    const head = this.frames.filter(f => f.type === Frame.REQ_HEAD).at(-1)!
    return () => {
      this.conn.feed(encodeJsonFrame(Frame.RES_HEAD, head.streamId, { status: 204, statusText: "", headers: [] }))
      this.conn.feed(encodeFrame(Frame.RES_END, head.streamId))
    }
  }
}

function spawner(opts: { hello?: "auto" | "manual"; failSpawn?: boolean } = {}) {
  const all: FakeInstance[] = []
  let n = 0
  return {
    all,
    spawn: async (): Promise<FnInstanceHandle> => {
      if (opts.failSpawn) throw new Error("no such file")
      const inst = new FakeInstance(`i${++n}`)
      all.push(inst)
      if ((opts.hello ?? "auto") === "auto") setTimeout(() => inst.hello(), 1)
      return inst.handle
    },
  }
}

async function until(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition")
    await Bun.sleep(2)
  }
}

const settle = () => Bun.sleep(5)

describe("FnPool TTL 0", () => {
  it("spawns on demand, holds until HELLO and drops the instance on BYE", async () => {
    const sp = spawner({ hello: "manual" })
    const pool = new FnPool("f", { hot: 0, max: 4, spawn: sp.spawn })
    expect(pool.instances()).toEqual([])

    const acq = pool.acquire()
    await until(() => sp.all.length === 1)
    let resolved = false
    acq.then(() => { resolved = true })
    await settle()
    expect(resolved).toBe(false)

    sp.all[0].hello()
    const h = await acq
    expect(h.id).toBe("i1")
    expect(h.conn).toBe(sp.all[0].conn)
    expect(sp.all[0].ackPayloads()).toEqual([{ hot: false }])
    expect(pool.instances()).toMatchObject([{ id: "i1", hot: false, ready: true, pid: 1000 }])

    sp.all[0].bye()
    expect(pool.instances()).toEqual([])
    // h was never dispatched on, so BYE_ACK waits for its reservation to lapse
    await until(() => sp.all[0].types().includes(Frame.BYE_ACK), 3000)

    // The next request needs a fresh instance
    const next = pool.acquire()
    await until(() => sp.all.length === 2)
    sp.all[1].hello()
    expect((await next).id).toBe("i2")
  })

  it("drops an instance that exits", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 0, max: 4, spawn: sp.spawn })
    await pool.acquire()
    sp.all[0].exit()
    expect(pool.instances()).toEqual([])
  })

  it("starts one instance for a burst of cold requests", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 0, max: 4, spawn: sp.spawn })
    const hs = await Promise.all(Array.from({ length: 10 }, () => pool.acquire()))
    expect(sp.all).toHaveLength(1)
    expect(new Set(hs.map(h => h.id))).toEqual(new Set(["i1"]))
  })

  it("serves a handle handed out just before BYE", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 0, max: 4, spawn: sp.spawn })
    const h = await pool.acquire()
    sp.all[0].bye()
    // The pool still holds a reservation, so BYE_ACK waits for the dispatch
    expect(sp.all[0].types()).not.toContain(Frame.BYE_ACK)
    h.conn!.dispatch(new Request("http://f.localhost/"), { requestId: "r", clientIp: "" }).catch(() => {})
    const t = sp.all[0].types()
    expect(t.indexOf(Frame.REQ_HEAD)).toBeGreaterThan(-1)
    expect(t.indexOf(Frame.REQ_HEAD)).toBeLessThan(t.indexOf(Frame.BYE_ACK))
  })
})

describe("FnPool routing and limits", () => {
  it("routes to the least-loaded instance", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 2, max: 4, spawn: sp.spawn })
    await pool.ensureHot()
    const [a, b] = sp.all
    a.busy(); a.busy(); b.busy()
    expect((await pool.acquire()).id).toBe(b.id)
    // Handed-out handles count as load until dispatched: 2 vs 2 now, then b
    const next = await pool.acquire()
    expect(next.id).toBe(a.id)
  })

  it("spawns up to max, then queues until capacity frees up", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 0, max: 2, perInstanceConcurrency: 2, spawn: sp.spawn })
    const finishers: (() => void)[] = []
    for (let i = 0; i < 4; i++) {
      const h = await pool.acquire()
      finishers.push(sp.all.find(x => x.id === h.id)!.busy())
    }
    expect(sp.all).toHaveLength(2)
    expect(pool.instances().map(i => i.inflight)).toEqual([2, 2])

    let got: FnInstanceHandle | null = null
    pool.acquire().then(h => { got = h })
    await settle()
    expect(got).toBeNull()
    expect(sp.all).toHaveLength(2)

    finishers[3]()
    await until(() => got !== null)
    expect(sp.all).toHaveLength(2)
  })

  it("rejects queued acquires when the instance never says HELLO", async () => {
    const sp = spawner({ hello: "manual" })
    const pool = new FnPool("f", { hot: 0, max: 4, spawn: sp.spawn, startTimeoutMs: 50 })
    const results = await Promise.allSettled([pool.acquire(), pool.acquire()])
    for (const r of results) {
      expect(r.status).toBe("rejected")
      expect(String((r as PromiseRejectedResult).reason.message)).toMatch(/fn "f" did not (say HELLO|start) within 50ms/)
    }
    expect(sp.all[0].killed).toBe(true)
    expect(pool.instances()).toEqual([])
  })

  it("rejects queued acquires when the instance fails to start or spawn", async () => {
    const sp = spawner({ hello: "manual" })
    const pool = new FnPool("f", { hot: 0, max: 4, spawn: sp.spawn })
    const acq = pool.acquire()
    await until(() => sp.all.length === 1)
    sp.all[0].failStart("SyntaxError in app.ts")
    await expect(acq).rejects.toThrow(/failed to start: SyntaxError in app.ts/)

    const bad = new FnPool("g", { hot: 0, max: 4, spawn: spawner({ failSpawn: true }).spawn })
    await expect(bad.acquire()).rejects.toThrow(/failed to spawn: no such file/)
  })

  it("times out a queued acquire when every instance stays busy", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 0, max: 1, perInstanceConcurrency: 1, spawn: sp.spawn, startTimeoutMs: 60 })
    await pool.acquire()
    sp.all[0].busy()
    await expect(pool.acquire()).rejects.toThrow(/no instance free within 60ms/)
  })
})

describe("FnPool hot instances", () => {
  it("keeps N warm and respawns them on exit", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 2, max: 4, spawn: sp.spawn, backoffBaseMs: 10 })
    await pool.ensureHot()
    expect(pool.instances().map(i => [i.hot, i.ready])).toEqual([[true, true], [true, true]])
    expect(sp.all.map(i => i.ackPayloads())).toEqual([[{ hot: true }], [{ hot: true }]])

    sp.all[0].exit()
    await until(() => pool.instances().filter(i => i.ready).length === 2)
    expect(sp.all).toHaveLength(3)
    expect(pool.instances().every(i => i.hot)).toBe(true)
  })

  it("backs off instead of respawning a crash loop tightly", async () => {
    const sp = spawner({ hello: "manual" })
    const pool = new FnPool("f", { hot: 1, max: 2, spawn: sp.spawn, backoffBaseMs: 40 })
    pool.ensureHot()
    const start = Date.now()
    // Every instance dies right after it starts
    while (Date.now() - start < 500) {
      for (const inst of sp.all) if (!inst.killed && !inst.conn.isClosed) {
        inst.hello()
        inst.exit()
      }
      await Bun.sleep(2)
    }
    // 0 + 40 + 80 + 160 + 320 ms: about 5 spawns, never hundreds
    expect(sp.all.length).toBeGreaterThanOrEqual(3)
    expect(sp.all.length).toBeLessThanOrEqual(6)
    await pool.drainAll()
  })

  it("respects max and does not count retiring instances against it", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 5, max: 2, spawn: sp.spawn })
    await pool.ensureHot()
    expect(sp.all).toHaveLength(2)

    const p2 = new FnPool("g", { hot: 0, max: 1, spawn: sp.spawn })
    await p2.acquire()
    sp.all[2].bye()
    expect((await p2.acquire()).id).toBe(sp.all[3].id)
  })

  it("setLimits drains demoted hot instances and spawns new ones", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 2, max: 4, spawn: sp.spawn })
    await pool.ensureHot()
    pool.setLimits({ hot: 1 })
    expect(sp.all.filter(i => i.types().includes(Frame.DRAIN))).toHaveLength(1)
    expect(pool.instances()).toHaveLength(1)

    pool.setLimits({ hot: 3 })
    await until(() => pool.instances().filter(i => i.ready && i.hot).length === 3)
  })

  it("drainAll drains ready instances, kills starting ones and stops respawning", async () => {
    const sp = spawner({ hello: "manual" })
    const pool = new FnPool("f", { hot: 2, max: 4, spawn: sp.spawn, backoffBaseMs: 1 })
    pool.ensureHot()
    await until(() => sp.all.length === 2)
    sp.all[0].hello()
    await settle()

    let done = false
    const d = pool.drainAll().then(() => { done = true })
    expect(sp.all[0].types()).toContain(Frame.DRAIN)
    expect(sp.all[1].killed).toBe(true)
    await settle()
    expect(done).toBe(false)

    // The drained instance exits once its work is done
    sp.all[0].exit()
    await d
    await Bun.sleep(20)
    expect(sp.all).toHaveLength(2)
    expect(pool.instances()).toEqual([])
  })
})

describe("FnPool restart and reservations", () => {
  it("restart drains old instances but sends queued requests to fresh ones", async () => {
    const sp = spawner({ hello: "manual" })
    const pool = new FnPool("f", { hot: 0, max: 1, spawn: sp.spawn })
    const first = pool.acquire()
    await until(() => sp.all.length === 1)
    sp.all[0].hello()
    await first
    // Fill the only instance, then queue one more request behind it
    const finish = sp.all[0].busy()
    for (let i = 1; i < 32; i++) sp.all[0].busy()
    const queued = pool.acquire()
    let failed: unknown = null
    queued.catch(e => { failed = e })
    await settle()

    const restarted = pool.restart()
    expect(sp.all[0].types()).toContain(Frame.DRAIN)
    // The retiring instance no longer counts against max: a fresh one starts
    await until(() => sp.all.length === 2)
    sp.all[1].hello()
    expect((await queued).id).toBe(sp.all[1].id)
    expect(failed).toBe(null)
    finish()
    sp.all[0].exit()
    await restarted
  })

  it("restart replaces hot instances at once and applies new limits", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 1, max: 4, spawn: sp.spawn })
    await pool.ensureHot()
    const done = pool.restart({ hot: 2, max: 4 })
    await until(() => pool.instances().filter(i => i.ready && i.hot).length === 2)
    expect(pool.instances().map(i => i.id)).not.toContain(sp.all[0].id)
    sp.all[0].exit()
    await done
  })

  it("a request after drainAll brings the hot instances back", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 2, max: 4, spawn: sp.spawn, backoffBaseMs: 1 })
    await pool.ensureHot()
    const d = pool.drainAll()
    for (const i of sp.all) i.exit()
    await d
    expect(pool.instances()).toEqual([])
    await pool.acquire()
    await until(() => pool.instances().filter(i => i.ready && i.hot).length === 2)
  })

  it("releases each reservation once: a stale timer never frees a newer reservation's BYE hold", async () => {
    const sp = spawner()
    const pool = new FnPool("f", { hot: 0, max: 1, spawn: sp.spawn })
    const inst = (await pool.acquire(), sp.all[0])
    // Reservation A is dispatched right away
    inst.busy()()
    await Bun.sleep(1900)
    // Reservation B is taken just before A's 2s timer would have fired
    await pool.acquire()
    await Bun.sleep(200)
    // A's timer has passed; B is still held, so a BYE now is not acked yet
    inst.bye()
    expect(inst.types()).not.toContain(Frame.BYE_ACK)
    // Dispatching B releases its hold and the BYE is acked
    inst.busy()
    expect(inst.types()).toContain(Frame.BYE_ACK)
  }, 10000)
})
