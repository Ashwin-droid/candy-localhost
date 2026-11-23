import { describe, expect, test } from "bun:test"
import type { SystemProcess, SystemStats } from "../../api/types.ts"
import { renderWith } from "../../test/render.tsx"
import { killConfirm, processLocked, processWhat, unitActions, unitConfirm, unitDone } from "./lib/safety.ts"
import { filterProcesses, filterUnits, parseSort, PROCESS_KEYS, sortParam, sortProcesses, sortUnits } from "./lib/sort.ts"
import MachinePage, { pollProblem } from "./MachinePage.tsx"
import { busyInterfaces, pct1 } from "./tiles.tsx"

const P = (o: Partial<SystemProcess>): SystemProcess => ({
  pid: 100, ppid: 1, user: "ashwin", name: "bun", cmd: "bun run dev", state: "S", cpu: 1, mem: 1000, threads: 1, start: 5, unit: null, kernel: false, ...o,
})
const D = (o: Partial<SystemStats> = {}): SystemStats => ({
  at: 1, host: "box", uptime: 3 * 86400 + 4 * 3600, load: [0.5, 0.25, 0.1],
  cpu: { percent: 4.25, cores: [10, 20] }, mem: { total: 8 * 2 ** 30, available: 4 * 2 ** 30, used: 4 * 2 ** 30, cached: 2 ** 30, swapTotal: 0, swapUsed: 0 },
  disks: [{ device: "/dev/nvme0n1p2", type: "ext4", mount: "/", size: 100, used: 40, available: 60 }],
  net: [{ name: "eth0", rx: 2048, tx: 1024 }], temp: 51.4,
  processes: [P({ pid: 1, name: "systemd", user: "root" }), P({ pid: 2, name: "kthreadd", user: "root", kernel: true }),
    P({ pid: 42, name: "bun", user: "root", unit: "candy.service", cmd: "bun daemon.ts" }), P({ pid: 777, name: "node", unit: "candy-api.service", cpu: 90 })],
  units: [{ unit: "candy.service", processes: 3, cpu: 1, mem: 10 }, { unit: "candy-api.service", processes: 1, cpu: 90, mem: 5 },
    { unit: "nginx.service", processes: 2, cpu: 0, mem: 3, failed: true }, { unit: "session-2.scope", processes: 4, cpu: 0, mem: 1 }],
  failed: ["nginx.service"], counts: { processes: 4, threads: 9 }, root: true, self: 42, ownUnit: "candy.service",
  candy: { "candy-api.service": "api" }, ...o,
})

describe("sysmon safety", () => {
  const d = D()
  test("no End/Kill on kernel threads, pid 1 or the daemon; others in its unit keep them", () => {
    expect(processLocked(P({ pid: 1 }), d)).toBe(true)
    expect(processLocked(P({ pid: 2, kernel: true }), d)).toBe(true)
    expect(processLocked(P({ pid: 42 }), d)).toBe(true)
    expect(processLocked(P({ pid: 43, unit: "candy.service" }), d)).toBe(false)
    expect(processLocked(P({ pid: 777 }), d)).toBe(false)
  })
  test("the unit matrix", () => {
    expect(unitActions({ unit: "candy.service" }, d)).toEqual([])                         // the daemon's own unit
    expect(unitActions({ unit: "candy-api.service" }, d)).toEqual(["stop"])                // candy units keep Stop, no Restart
    expect(unitActions({ unit: "candy-api.service", failed: true }, d)).toEqual(["start"])  // and Start when failed
    expect(unitActions({ unit: "nginx.service" }, d)).toEqual(["restart", "stop"])
    expect(unitActions({ unit: "nginx.service", failed: true }, d)).toEqual(["start"])
    expect(unitActions({ unit: "session-2.scope" }, d)).toEqual(["stop"])
    expect(unitActions({ unit: "init.scope" }, d)).toEqual([])
    expect(unitActions({ unit: "dbus.service" }, d)).toEqual(["restart"])
    expect(unitActions({ unit: "dbus-broker.service" }, d)).toEqual(["restart"])
    expect(unitActions({ unit: "systemd-journald.service" }, d)).toEqual(["restart"])
    expect(unitActions({ unit: "nginx.service" }, { ...d, ownUnit: null })).toEqual(["restart", "stop"])
  })
  test("confirm wording (§5.12) and toasts", () => {
    const p = P({ pid: 812, name: "nginx", user: "www-data" })
    expect(killConfirm(p, "KILL")).toEqual({ title: "Kill nginx (pid 812, www-data)?", body: "It gets no chance to save or clean up.", verb: "Kill", danger: true })
    expect(killConfirm(p, "TERM")).toEqual({ title: "Ask nginx (pid 812) to exit?", verb: "End", danger: false })
    expect(processWhat(p, 812)).toBe("nginx (pid 812, www-data)")
    expect(processWhat(undefined, 9)).toBe("pid 9")
    expect(unitConfirm("x.service", "stop", 3)).toEqual({ title: "Stop x.service?", body: "Its 3 processes will be ended.", verb: "Stop", danger: true })
    expect(unitConfirm("x.service", "stop", 1).body).toBe("Its 1 process will be ended.")
    expect(unitConfirm("x.service", "stop", 0).body).toBeUndefined()
    expect(unitConfirm("x.service", "restart", 3)).toEqual({ title: "Restart x.service?", verb: "Restart", danger: false })
    expect(unitConfirm("x.service", "start", 3).title).toBe("Start x.service?")
    expect(unitDone("x", "stop")).toBe("x: stopping")
    expect(unitDone("x", "start")).toBe("x: starting")
    expect(unitDone("x", "restart")).toBe("x: restarting")
  })
})

describe("sort and filter", () => {
  const rows = [P({ pid: 3, cpu: 5, user: "b" }), P({ pid: 1, cpu: 5, user: "a" }), P({ pid: 2, cpu: 9, user: "a" })]
  test("numbers descending, ties by pid ascending in both directions", () => {
    expect(sortProcesses(rows, "cpu", -1).map(p => p.pid)).toEqual([2, 1, 3])
    expect(sortProcesses(rows, "cpu", 1).map(p => p.pid)).toEqual([1, 3, 2])
    expect(sortProcesses(rows, "user", 1).map(p => p.pid)).toEqual([1, 2, 3])
    expect(sortProcesses(rows, "user", -1).map(p => p.pid)).toEqual([3, 1, 2])
  })
  test("failed units first whatever the direction", () => {
    const u = [{ unit: "a", processes: 1, cpu: 0, mem: 5 }, { unit: "b", processes: 1, cpu: 0, mem: 1, failed: true }, { unit: "c", processes: 1, cpu: 0, mem: 9 }]
    expect(sortUnits(u, "mem", -1).map(x => x.unit)).toEqual(["b", "c", "a"])
    expect(sortUnits(u, "mem", 1).map(x => x.unit)).toEqual(["b", "a", "c"])
  })
  test("filters", () => {
    const d = D()
    expect(filterProcesses(d.processes, "candy-api").map(p => p.pid)).toEqual([777])
    expect(filterProcesses(d.processes, "42").map(p => p.pid)).toEqual([42])
    expect(filterProcesses(d.processes, "ROOT").length).toBe(3)
    expect(filterUnits(d.units, "api", d.candy).map(u => u.unit)).toEqual(["candy-api.service"])
  })
  test("sort param", () => {
    expect(parseSort(null, PROCESS_KEYS, ["cpu", -1])).toEqual(["cpu", -1])
    expect(parseSort("user", PROCESS_KEYS, ["cpu", -1])).toEqual(["user", 1])
    expect(parseSort("-user", PROCESS_KEYS, ["cpu", -1])).toEqual(["user", -1])
    expect(parseSort("+mem", PROCESS_KEYS, ["cpu", -1])).toEqual(["mem", 1])
    expect(parseSort("bogus", PROCESS_KEYS, ["cpu", -1])).toEqual(["cpu", -1])
    expect(sortParam("cpu", -1)).toBe("cpu")
    expect(sortParam("cpu", 1)).toBe("+cpu")
    expect(sortParam("user", -1)).toBe("-user")
  })
  test("tiles helpers and poll problems", () => {
    expect(pct1(4.25)).toBe("4.3%")
    expect(pct1(42.4)).toBe("42%")
    expect(busyInterfaces([{ name: "lo", rx: 0, tx: 0 }, { name: "a", rx: 1, tx: 0 }])).toHaveLength(2)
    const many = [0, 1, 2, 3, 4, 5].map(i => ({ name: `n${i}`, rx: i, tx: 0 }))
    expect(busyInterfaces(many).map(n => n.name)).toEqual(["n5", "n4", "n3", "n2"])
    expect(pollProblem({ status: 0, message: "x" })).toBe("Lost contact with the daemon. Trying again…")
    expect(pollProblem({ status: 500, message: "Request failed (500)" })).toBe("Could not read the system")
    expect(pollProblem({ status: 403, message: "Only a superuser, logged in to the portal, can do that." })).toBe("Only a superuser, logged in to the portal, can do that.")
  })
})

describe("MachinePage render", () => {
  test("non-superuser sees only the note", () => {
    const html = renderWith(<MachinePage />, { route: "/machine", resources: { system: D() } })
    expect(html).toContain("Only a superuser can see this machine.")
    expect(html).not.toContain("box")
  })
  test("processes: header, tiles, actions only where allowed", () => {
    const html = renderWith(<MachinePage />, { route: "/machine", session: { superuser: true }, resources: { system: D() } })
    expect(html).toContain("Up 3d 4h")
    expect(html).toContain("4 processes, 9 threads")
    expect(html).toContain("acting as root")
    expect(html).toContain("4.3%")
    expect(html).toContain("load 0.50 0.25 0.10")
    expect(html).toContain("51°C")
    expect(html).toContain("No swap".toLowerCase())
    expect(html).toContain("candy: api")
    expect(html).toContain('href="/sites/api"')
    // only pid 777 is unlocked: one End and one Kill
    expect(html.match(/>End</g)?.length).toBe(1)
    expect(html.match(/>Kill</g)?.length).toBe(1)
    expect(html).toContain("4 processes")
  })
  test("services: failed first, the matrix, counts", () => {
    const html = renderWith(<MachinePage />, { route: "/machine/services", session: { superuser: true }, resources: { system: D() } })
    expect(html).toContain("4 services and sessions, 1 failed")
    expect(html).toContain("this daemon")
    expect(html.indexOf("nginx.service")).toBeLessThan(html.indexOf("candy-api.service"))
    expect(html.match(/>Start</g)?.length).toBe(1)
    expect(html.match(/>Restart</g)).toBeNull()
    expect(html.match(/>Stop</g)?.length).toBe(2)
  })
  test("hostile process names are escaped", () => {
    const html = renderWith(<MachinePage />, { route: "/machine", session: { superuser: true },
      resources: { system: D({ processes: [P({ pid: 9, name: "<img src=x onerror=alert(1)>" })] }) } })
    expect(html).not.toContain("<img")
  })
})
