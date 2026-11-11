import { describe, expect, it } from "bun:test"
import { planUpstreams, upstreamRule } from "../adguard.ts"
import { nameInZones } from "../tailnet"

const CANDY = "[/candy/]127.0.0.1:5336"
const ZONE = upstreamRule("Ashwins.World", "127.0.0.1:5336")
const TS = upstreamRule("homeserver.example.ts.net", "127.0.0.1:5336")

describe("AdGuard Home upstream lines", () => {
  it("adds what is missing and remembers it", () => {
    expect(ZONE).toBe("[/ashwins.world/]127.0.0.1:5336")
    expect(planUpstreams([CANDY], [ZONE], [])).toEqual({ next: [CANDY, ZONE], managed: [ZONE], changed: true })
  })

  it("removes only lines it added", () => {
    expect(planUpstreams([CANDY, ZONE], [], [ZONE])).toEqual({ next: [CANDY], managed: [], changed: true })
    // A hand-written line is left alone, wanted or not
    expect(planUpstreams([CANDY, TS], [], [])).toEqual({ next: [CANDY, TS], managed: [], changed: false })
    expect(planUpstreams([CANDY, TS], [TS], [])).toEqual({ next: [CANDY, TS], managed: [], changed: false })
  })

  it("is stable once in sync, and re-adds a line someone deleted", () => {
    expect(planUpstreams([CANDY, ZONE], [ZONE], [ZONE])).toEqual({ next: [CANDY, ZONE], managed: [ZONE], changed: false })
    expect(planUpstreams([CANDY], [ZONE], [ZONE])).toEqual({ next: [CANDY, ZONE], managed: [ZONE], changed: true })
  })
})

describe("forwarded zones", () => {
  it("matches the zone and names under it only", () => {
    expect(nameInZones("ashwins.world", ["ashwins.world"])).toBe(true)
    expect(nameInZones("Mail.Ashwins.World.", ["ashwins.world"])).toBe(true)
    expect(nameInZones("notashwins.world", ["ashwins.world"])).toBe(false)
    expect(nameInZones("ashwins.world.evil.com", ["ashwins.world"])).toBe(false)
    expect(nameInZones("example.com", [])).toBe(false)
    expect(nameInZones("example.com", undefined)).toBe(false)
  })
})
