import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AccessLogTail,
  activityFromAccessLog,
  countEstablished,
  establishedLocalPorts,
  IDLE_TIMEOUT_MS,
  idleVerdict,
  localNameCandidates,
  memoryIsTight,
  parseMeminfo,
  parsePressure,
  type MemoryState,
} from "../activity.ts"

const MIN = 60 * 1000
const CALM: MemoryState = { usedFraction: 0.2, pressureAvg10: 0 }
const TIGHT: MemoryState = { usedFraction: 0.85, pressureAvg10: 0 }

const waitFor = async (cond: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await Bun.sleep(25)
  }
  return false
}

describe("open connections keep a server alive", () => {
  it("does not kill a server with an SSE client after an hour, and kills it once the client leaves", async () => {
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch() {
        let timer: ReturnType<typeof setInterval>
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(": hello\n\n"))
            timer = setInterval(() => c.enqueue(new TextEncoder().encode(": ping\n\n")), 1000)
          },
          cancel() { clearInterval(timer) },
        })
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    try {
      const port = server.port
      const lastActivity = Date.now()
      const anHourLater = lastActivity + IDLE_TIMEOUT_MS + 5 * MIN  // simulated time, no other requests

      expect(await countEstablished([port])).toBe(0)

      const client = new AbortController()
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: client.signal })
      const reader = res.body!.getReader()
      await reader.read()
      expect(await waitFor(async () => (await countEstablished([port])) === 1)).toBe(true)

      const connected = idleVerdict({ now: anHourLater, lastActivity, hasPortal: false, openConnections: await countEstablished([port]), idling: false, memory: CALM })
      expect(connected).toEqual({ kill: false, reason: "connected" })

      client.abort()
      await reader.cancel().catch(() => {})
      expect(await waitFor(async () => (await countEstablished([port])) === 0)).toBe(true)

      const gone = idleVerdict({ now: anHourLater, lastActivity, hasPortal: false, openConnections: 0, idling: false, memory: CALM })
      expect(gone).toEqual({ kill: true, idleMinutes: 65, detail: "idle 65min" })
    } finally {
      server.stop(true)
    }
  })

  it("counts only the server side of a connection", () => {
    // sl local rem st ...   (port 0x0C1C = 3100)
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue",
      "   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000",  // listening
      "   1: 0100007F:0C1C 0100007F:D2F0 01 00000000:00000000",  // server side, established
      "   2: 0100007F:D2F0 0100007F:0C1C 01 00000000:00000000",  // client side
      "   3: 0100007F:0C1C 0100007F:D2F4 06 00000000:00000000",  // TIME_WAIT
    ].join("\n")
    expect(establishedLocalPorts(table)).toEqual([3100, 0xD2F0])
  })

  it("reads both the IPv4 and IPv6 tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candy-tcp-"))
    const v4 = join(dir, "tcp"), v6 = join(dir, "tcp6")
    await writeFile(v4, "header\n 0: 0100007F:0C1C 0100007F:D2F0 01 x\n")
    await writeFile(v6, "header\n 0: 00000000000000000000000001000000:0C1C 00000000000000000000000001000000:D300 01 x\n")
    expect(await countEstablished([3100], [v4, v6])).toBe(2)
    expect(await countEstablished([3101], [v4, v6])).toBe(0)
    expect(await countEstablished([], [v4, v6])).toBe(0)
  })
})

describe("the idle rule", () => {
  const base = { hasPortal: false, openConnections: 0, idling: false, memory: CALM }

  it("leaves recently used servers and servers with a portal alone", () => {
    expect(idleVerdict({ ...base, now: 59 * MIN, lastActivity: 0 }).kill).toBe(false)
    expect(idleVerdict({ ...base, now: 3 * 60 * MIN, lastActivity: 0, hasPortal: true }).kill).toBe(false)
  })

  it("keeps an idling server until memory is tight", () => {
    const idle = { ...base, now: 3 * 60 * MIN, lastActivity: 0, idling: true }
    expect(idleVerdict(idle)).toEqual({ kill: false, reason: "idling" })
    expect(idleVerdict({ ...idle, memory: TIGHT })).toMatchObject({ kill: true, detail: "idle 180min, idling, memory 85% used, pressure 0" })
    expect(idleVerdict({ ...idle, memory: { usedFraction: 0.3, pressureAvg10: 25 } }).kill).toBe(true)
    // Idling only matters past the timeout
    expect(idleVerdict({ ...idle, now: 30 * MIN, memory: TIGHT }).kill).toBe(false)
  })

  it("reads memory use and pressure", () => {
    expect(parseMeminfo("MemTotal:       16000000 kB\nMemFree: 1 kB\nMemAvailable:    8000000 kB\n")).toBe(0.5)
    expect(parseMeminfo("garbage")).toBeNull()
    expect(parsePressure("some avg10=12.50 avg60=3.00 avg300=1.00 total=1\nfull avg10=1.00 avg60=0 avg300=0 total=1\n")).toBe(12.5)
    expect(memoryIsTight({ usedFraction: 0.79, pressureAvg10: 9.9 })).toBe(false)
    expect(memoryIsTight({ usedFraction: 0.8, pressureAvg10: null })).toBe(true)
    expect(memoryIsTight({ usedFraction: null, pressureAvg10: 10 })).toBe(true)
  })
})

describe("Caddy access log", () => {
  const line = (host: string, ts: number) =>
    JSON.stringify({ level: "info", ts, logger: "http.log.access", msg: "handled request", request: { host, uri: "/" } })
  const bindings: Record<string, string> = { "wa.ashwins.world": "wa" }
  const resolve = (host: string) => {
    for (const n of localNameCandidates(host)) if (n === "wa" || n === "agh") return n
    return bindings[host.replace(/:\d+$/, "")] ?? null
  }

  it("counts finished requests to bound domains, *.localhost and *.candy", () => {
    const text = [
      line("wa.ashwins.world", 1000),
      line("agh.candy", 1500),
      line("agh.homeserver.candy", 1600),
      line("unknown.example.com", 9999),
      JSON.stringify({ logger: "admin.api", ts: 9999, request: { host: "wa.localhost" } }),
      "not json",
    ].join("\n")
    const seen = activityFromAccessLog(text, resolve, 10_000_000)
    expect(seen.get("wa")).toBe(1_000_000)
    expect(seen.get("agh")).toBe(1_600_000)
    expect(seen.size).toBe(2)
  })

  it("maps hosts to names", () => {
    expect(localNameCandidates("wa.localhost")).toEqual(["wa"])
    expect(localNameCandidates("WA.candy:443")).toEqual(["wa"])
    expect(localNameCandidates("wa.homeserver.candy")).toEqual(["wa.homeserver", "wa"])
    expect(localNameCandidates("wa.ashwins.world")).toEqual([])
  })

  it("only reads new lines, keeps split lines, and handles rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candy-log-"))
    const path = join(dir, "access.log")
    await writeFile(path, line("wa.candy", 1) + "\n" + line("wa.candy", 2).slice(0, 20))
    const tail = new AccessLogTail(path)
    expect((await tail.readNew()).trim()).toBe(line("wa.candy", 1))
    await writeFile(path, line("wa.candy", 1) + "\n" + line("wa.candy", 2) + "\n")
    expect((await tail.readNew()).trim()).toBe(line("wa.candy", 2))
    expect(await tail.readNew()).toBe("")
    await writeFile(path, line("wa.candy", 3) + "\n")  // rotated: smaller file
    expect((await tail.readNew()).trim()).toBe(line("wa.candy", 3))
  })
})
