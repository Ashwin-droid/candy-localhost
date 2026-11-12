import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { MAX_CRON_JOBS, validateCronJob } from "../cron.ts"
import { cronJobsFor, ExecutionContext, idleWatcher, runScheduled } from "../fn-cron.ts"

const tick = () => new Promise((r) => setTimeout(r, 0))
const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

describe("cronJobsFor", () => {
  it("maps each expression to a fixed-args job", () => {
    const jobs = cronJobsFor({ crons: ["*/5 * * * *", " @daily "] })
    expect(jobs).toHaveLength(2)
    expect(jobs[0].name).toMatch(/^fn-0-[0-9a-f]{6}$/)
    expect(jobs[0].schedule).toBe("*/5 * * * *")
    expect(jobs[0].args).toEqual(["--scheduled", "*/5 * * * *"])
    expect(jobs[1].name).toMatch(/^fn-1-[0-9a-f]{6}$/)
    expect(jobs[1].args).toEqual(["--scheduled", "@daily"])
    for (const j of jobs) expect(validateCronJob(j).ok).toBe(true)
  })

  it("names are stable and unique for duplicate expressions", () => {
    const a = cronJobsFor({ crons: ["0 * * * *", "0 * * * *"] })
    const b = cronJobsFor({ crons: ["0 * * * *"] })
    expect(a[0].name).toBe(b[0].name)
    expect(a[0].name).not.toBe(a[1].name)
    expect(a[0].name.slice(-6)).toBe(a[1].name.slice(-6))
  })

  it("returns nothing for no crons", () => {
    expect(cronJobsFor({ crons: [] })).toEqual([])
  })

  it("throws a clear error on a bad expression", () => {
    expect(() => cronJobsFor({ crons: ["* * * * *", "61 * * * *"] })).toThrow(/triggers\.crons\[1\] "61 \* \* \* \*": schedule:/)
    expect(() => cronJobsFor({ crons: ["nope"] })).toThrow(/5 fields/)
    expect(() => cronJobsFor({ crons: [5 as unknown as string] })).toThrow(/must be a string/)
  })

  it("rejects control characters", () => {
    expect(() => cronJobsFor({ crons: ["* * * *\n*"] })).toThrow()
  })

  it("respects MAX_CRON_JOBS", () => {
    expect(cronJobsFor({ crons: Array(MAX_CRON_JOBS).fill("* * * * *") })).toHaveLength(MAX_CRON_JOBS)
    expect(() => cronJobsFor({ crons: Array(MAX_CRON_JOBS + 1).fill("* * * * *") })).toThrow(/at most 16/)
  })
})

describe("ExecutionContext", () => {
  let errSpy: ReturnType<typeof spyOn>
  beforeEach(() => { errSpy = spyOn(console, "error").mockImplementation(() => {}) })
  afterEach(() => { errSpy.mockRestore() })

  it("settles immediately with nothing pending", async () => {
    const ctx = new ExecutionContext()
    expect(ctx.pending).toBe(0)
    await ctx.settled()
    ctx.passThroughOnException()
  })

  it("tracks pending work and waits for it", async () => {
    const ctx = new ExecutionContext()
    const a = deferred(), b = deferred()
    ctx.waitUntil(a.promise)
    ctx.waitUntil(b.promise)
    expect(ctx.pending).toBe(2)
    let done = false
    const s = ctx.settled().then(() => { done = true })
    a.resolve()
    await tick()
    expect(ctx.pending).toBe(1)
    expect(done).toBe(false)
    b.resolve()
    await s
    expect(ctx.pending).toBe(0)
  })

  it("waits for work added while settling", async () => {
    const ctx = new ExecutionContext()
    const order: string[] = []
    const second = deferred()
    ctx.waitUntil((async () => {
      await tick()
      order.push("first")
      ctx.waitUntil(second.promise.then(() => order.push("second")))
      setTimeout(() => second.resolve(), 5)
    })())
    await ctx.settled()
    order.push("settled")
    expect(order).toEqual(["first", "second", "settled"])
  })

  it("logs rejections without throwing", async () => {
    const ctx = new ExecutionContext()
    ctx.waitUntil(Promise.reject(new Error("boom")))
    ctx.waitUntil("not a promise")
    await ctx.settled()
    expect(ctx.pending).toBe(0)
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0][1])).toContain("boom")
  })
})

describe("runScheduled", () => {
  it("passes the controller, env and ctx, and awaits waitUntil", async () => {
    let seen: any
    let bgDone = false
    const env = { A: "1" }
    const handler = {
      async scheduled(controller: any, e: any, ctx: ExecutionContext) {
        seen = { controller, e, ctx }
        ctx.waitUntil(new Promise<void>((r) => setTimeout(() => { bgDone = true; r() }, 10)))
      },
    }
    const now = new Date("2026-11-12T10:00:00Z")
    await runScheduled(handler, env, "*/5 * * * *", now)
    expect(bgDone).toBe(true)
    expect(seen.e).toBe(env)
    expect(seen.ctx).toBeInstanceOf(ExecutionContext)
    expect(seen.controller.cron).toBe("*/5 * * * *")
    expect(seen.controller.scheduledTime).toBe(now.getTime())
    expect(seen.controller.type).toBe("scheduled")
    expect(() => seen.controller.noRetry()).not.toThrow()
  })

  it("defaults scheduledTime to now", async () => {
    let t = 0
    const before = Date.now()
    await runScheduled({ scheduled: (c: any) => { t = c.scheduledTime } }, {}, "@hourly")
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })

  it("throws when there is no scheduled handler", async () => {
    await expect(runScheduled({ fetch() {} }, {}, "* * * * *")).rejects.toThrow(/no scheduled\(\) handler/)
    await expect(runScheduled(null, {}, "* * * * *")).rejects.toThrow(/no scheduled\(\) handler/)
  })

  it("still drains waitUntil when the handler throws", async () => {
    let bgDone = false
    const handler = {
      scheduled(_c: unknown, _e: unknown, ctx: ExecutionContext) {
        ctx.waitUntil(new Promise<void>((r) => setTimeout(() => { bgDone = true; r() }, 5)))
        throw new Error("handler failed")
      },
    }
    await expect(runScheduled(handler, {}, "* * * * *")).rejects.toThrow("handler failed")
    expect(bgDone).toBe(true)
  })
})

describe("idleWatcher", () => {
  it("fires once when in-flight is 0 and waitUntil has settled", async () => {
    const ctx = new ExecutionContext()
    let inflight = 1
    let fired = 0
    const w = idleWatcher(ctx, () => inflight, () => { fired++ })
    const bg = deferred()
    ctx.waitUntil(bg.promise)

    w.check()
    await tick()
    expect(fired).toBe(0)  // request still in flight

    inflight = 0
    w.check()
    await tick()
    expect(fired).toBe(0)  // waitUntil still pending

    bg.resolve()
    await tick()
    expect(fired).toBe(1)  // draining waitUntil triggers the check itself

    w.check()
    await tick()
    expect(fired).toBe(1)  // only once until re-armed
    w.stop()
  })

  it("counts waitUntil added in the same tick as the check", async () => {
    const ctx = new ExecutionContext()
    let fired = 0
    const w = idleWatcher(ctx, () => 0, () => { fired++ })
    const bg = deferred()
    w.check()
    ctx.waitUntil(bg.promise)
    await tick()
    expect(fired).toBe(0)
    bg.resolve()
    await tick()
    expect(fired).toBe(1)
    w.stop()
  })

  it("can be re-armed and stopped", async () => {
    const ctx = new ExecutionContext()
    let inflight = 0
    let fired = 0
    const w = idleWatcher(ctx, () => inflight, () => { fired++ })
    w.check()
    await tick()
    expect(fired).toBe(1)

    inflight = 1
    w.arm()
    await tick()
    expect(fired).toBe(1)
    inflight = 0
    w.check()
    await tick()
    expect(fired).toBe(2)

    w.arm()
    w.stop()
    await tick()
    expect(fired).toBe(2)
    ctx.waitUntil(Promise.resolve())
    await tick()
    expect(fired).toBe(2)
  })
})
