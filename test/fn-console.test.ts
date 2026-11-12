import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { installConsoleCapture, type ConsoleLog } from "../fn-console.ts"

// Silence real output while still checking that the original methods run.
const levels = ["log", "info", "warn", "error", "debug"] as const
const printed: string[] = []
const saved: Record<string, (...a: unknown[]) => void> = {}
beforeAll(() => {
  for (const l of levels) {
    saved[l] = console[l]
    console[l] = (...a: unknown[]) => { printed.push(`${l}:${a.join(" ")}`) }
  }
})

let sent: [string, ConsoleLog][] = []
let capture: ReturnType<typeof installConsoleCapture>
beforeAll(() => { capture = installConsoleCapture((id, log) => sent.push([id, log])) })
afterAll(() => { for (const l of levels) console[l] = saved[l] as any })

const reset = () => { sent = []; printed.length = 0 }
const tick = (ms = 1) => new Promise(r => setTimeout(r, ms))

describe("console capture", () => {
  it("sends nothing outside a run but still prints", () => {
    reset()
    console.log("outside")
    expect(sent).toEqual([])
    expect(printed).toEqual(["log:outside"])
  })

  it("tags every level inside a run and still prints", () => {
    reset()
    capture.run("req-1", () => {
      for (const l of levels) console[l](`at ${l}`)
    })
    expect(sent.map(([id, log]) => [id, log.level, log.text])).toEqual(levels.map(l => ["req-1", l, `at ${l}`]))
    expect(printed).toHaveLength(5)
    expect(typeof sent[0][1].ts).toBe("number")
  })

  it("formats like util.inspect", () => {
    reset()
    capture.run("fmt", () => console.log("n=%d s=%s", 3, "x", { a: [1, { b: 2 }] }, null))
    expect(sent[0][1].text).toBe("n=3 s=x { a: [ 1, { b: 2 } ] } null")
  })

  it("keeps the request across awaits and returns the callback's value", async () => {
    reset()
    const out = await capture.run("async", async () => {
      console.log("before")
      await tick()
      await Promise.resolve()
      console.warn("after")
      return 42
    })
    expect(out).toBe(42)
    expect(sent.map(([id, l]) => `${id}:${l.text}`)).toEqual(["async:before", "async:after"])
  })

  it("keeps concurrent runs apart", async () => {
    reset()
    const job = (id: string, delays: number[]) => capture.run(id, async () => {
      for (const [i, d] of delays.entries()) { await tick(d); console.log(`${id}-${i}`) }
    })
    await Promise.all([job("A", [5, 1, 5]), job("B", [1, 5, 1]), job("C", [3, 3, 3])])
    for (const id of ["A", "B", "C"]) {
      expect(sent.filter(([r]) => r === id).map(([, l]) => l.text)).toEqual([`${id}-0`, `${id}-1`, `${id}-2`])
    }
    expect(sent).toHaveLength(9)
    // Timers fired after the runs finished are outside any request.
    console.log("later")
    expect(sent).toHaveLength(9)
  })

  it("is idempotent: a second install swaps the sender without double wrapping", () => {
    reset()
    const other: string[] = []
    const again = installConsoleCapture((id, log) => other.push(`${id}:${log.text}`))
    expect(again).toBe(capture)
    capture.run("x", () => console.info("once"))
    expect(other).toEqual(["x:once"])
    expect(sent).toEqual([])
    expect(printed).toEqual(["info:once"])
    installConsoleCapture((id, log) => sent.push([id, log]))
  })

  it("survives a sender that throws or logs", () => {
    reset()
    installConsoleCapture(() => { console.log("from sender"); throw new Error("broken pipe") })
    expect(() => capture.run("y", () => console.error("still fine"))).not.toThrow()
    expect(printed).toEqual(["error:still fine", "log:from sender"])
    installConsoleCapture((id, log) => sent.push([id, log]))
  })
})
