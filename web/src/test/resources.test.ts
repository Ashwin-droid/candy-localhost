// The resource cache without React: the mount effect (subscribeResource), reload and GC.
import { afterEach, describe, expect, test } from "bun:test"
import { hasResource, primeResource, reloadResource, resetResources, setGcDelayForTest, subscribeResource } from "../api/resources.ts"

afterEach(() => resetResources())
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

describe("resources", () => {
  test("a key without `every` refetches on every mount, keeping the cached value meanwhile", async () => {
    let n = 0
    const fetcher = async () => ++n
    let off = subscribeResource("k", fetcher)
    await tick()
    expect(n).toBe(1)
    off()
    off = subscribeResource("k", fetcher)
    await tick()
    expect(n).toBe(2)
    off()
  })

  test("a polled key with fresh data does not refetch on mount (its poll keeps it current)", async () => {
    let n = 0
    primeResource("p", 0)
    const off = subscribeResource("p", async () => ++n, { every: 60_000 })
    await tick()
    expect(n).toBe(0)
    off()
  })

  test("reload waits out a fetch already in flight and settles with a fetch started after the call", async () => {
    let n = 0
    let release!: () => void
    const slow = new Promise<void>(r => { release = r })
    const fetcher = async () => { const mine = ++n; if (mine === 1) await slow; return mine }
    const off = subscribeResource("r", fetcher)        // fetch 1 in flight
    const done = reloadResource("r")
    release()
    await done
    expect(n).toBe(2)
    off()
  })

  test("an entry nobody uses is dropped after the GC delay; a new subscriber in time keeps it", async () => {
    setGcDelayForTest(10)
    const off = subscribeResource("g", async () => 1)
    await tick()
    off()
    expect(hasResource("g")).toBe(true)
    await tick(30)
    expect(hasResource("g")).toBe(false)

    const off2 = subscribeResource("h", async () => 1)
    await tick()
    off2()
    const off3 = subscribeResource("h", async () => 1)  // back before the delay: kept
    await tick(30)
    expect(hasResource("h")).toBe(true)
    off3()
  })
})
