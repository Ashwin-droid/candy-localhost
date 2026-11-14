import { describe, expect, it } from "bun:test"
import { cpuPercent, isUnitName, killProblem, parseDf, parseMeminfo, parseNetDev, parsePasswd, parsePidStat, parseProcStat, SystemMonitor, unitActionProblem, unitOfProcess } from "../sysmon.ts"

describe("sysmon parsers", () => {
  it("/proc/stat: totals per core, idle includes iowait", () => {
    const a = parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 60 0 20 400 20 0 0 0 0 0\ncpu1 40 0 30 400 30 0 0 0 0 0\nintr 1 2 3\n")
    expect(a.all).toEqual({ total: 1000, idle: 850 })
    expect(a.cores.length).toBe(2)
    const b = parseProcStat("cpu  200 0 100 850 50 0 0 0 0 0\ncpu0 60 0 20 500 20 0 0 0 0 0\ncpu1 140 0 80 350 30 0 0 0 0 0\n")
    expect(cpuPercent(a.all, b.all)).toBeCloseTo(75)       // 200 ticks, 50 idle
    expect(cpuPercent(a.cores[0], b.cores[0])).toBe(0)      // all idle
    expect(cpuPercent(undefined, b.all)).toBe(0)
    expect(cpuPercent(b.all, b.all)).toBe(0)
  })

  it("/proc/meminfo: used is total minus available", () => {
    const m = parseMeminfo("MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    600 kB\nBuffers:          50 kB\nCached:          300 kB\nSwapTotal:       200 kB\nSwapFree:        150 kB\nSReclaimable:     50 kB\n")
    expect(m).toEqual({ total: 1024000, available: 614400, used: 409600, cached: 409600, swapTotal: 204800, swapUsed: 51200 })
  })

  it("/proc/net/dev: bytes per interface, no loopback", () => {
    const n = parseNetDev("Inter-|   Receive  |  Transmit\n face |bytes packets|bytes\n    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\ntailscale0:7 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0\n")
    expect(n).toEqual({ eth0: { rx: 1000, tx: 2000 }, tailscale0: { rx: 7, tx: 9 } })
  })

  it("df: real filesystems once each", () => {
    const d = parseDf("Filesystem Type 1B-blocks Used Avail Mounted on\n/dev/nvme0n1p2 btrfs 1000 250 750 /\n/dev/nvme0n1p2 btrfs 1000 250 750 /home\ntmpfs tmpfs 500 1 499 /run\n/dev/loop3 squashfs 100 100 0 /snap/core/1\n/dev/sda1 ext4 2000 500 1500 /mnt/my data\n")
    expect(d).toEqual([
      { device: "/dev/nvme0n1p2", type: "btrfs", mount: "/", size: 1000, used: 250, available: 750 },
      { device: "/dev/sda1", type: "ext4", mount: "/mnt/my data", size: 2000, used: 500, available: 1500 },
    ])
  })

  it("/proc/<pid>/stat: a name with spaces and parentheses", () => {
    const rest = "S 1 100 100 0 -1 4194560 500 0 0 0 30 12 0 0 20 0 7 0 98765 1000000 2500 18446744073709551615"
    expect(parsePidStat(`4242 (my (odd) name) ${rest}`)).toEqual({ pid: 4242, comm: "my (odd) name", state: "S", ppid: 1, ticks: 42, start: 98765, rssPages: 2500, threads: 7 })
    expect(parsePidStat("garbage")).toBeNull()
    expect(parsePidStat("")).toBeNull()
  })

  it("the unit a process is in", () => {
    expect(unitOfProcess("0::/candy.slice/candy-wa-ef3482.service\n")).toBe("candy-wa-ef3482.service")
    expect(unitOfProcess("0::/user.slice/user-1000.slice/session-c5.scope\n")).toBe("session-c5.scope")
    expect(unitOfProcess("0::/system.slice/docker.service/sub/leaf\n")).toBe("docker.service")
    expect(unitOfProcess("0::/\n")).toBeNull()
    expect(unitOfProcess("")).toBeNull()
  })

  it("/etc/passwd", () => {
    const u = parsePasswd("root:x:0:0:root:/root:/bin/bash\nashwin:x:1000:1000::/home/ashwin:/bin/bash\nbroken\n")
    expect(u.get(0)).toBe("root")
    expect(u.get(1000)).toBe("ashwin")
    expect(u.size).toBe(2)
  })
})

describe("sysmon: what may be acted on", () => {
  it("never init, kernel threads or the daemon itself", () => {
    expect(killProblem({ pid: 1, ppid: 0, kernel: false }, 500)).toContain("Process 1")
    expect(killProblem({ pid: 2, ppid: 0, kernel: true }, 500)).toContain("kernel")
    expect(killProblem({ pid: 77, ppid: 2, kernel: true }, 500)).toContain("kernel")
    expect(killProblem({ pid: 500, ppid: 1, kernel: false }, 500)).toContain("candy's own daemon")
    expect(killProblem({ pid: 0, ppid: 0, kernel: false }, 500)).not.toBeNull()
    expect(killProblem({ pid: -1, ppid: 0, kernel: false }, 500)).not.toBeNull()   // kill(-1) is everything
    expect(killProblem({ pid: 1.5, ppid: 0, kernel: false }, 500)).not.toBeNull()
    expect(killProblem({ pid: 4242, ppid: 1, kernel: false }, 500)).toBeNull()
  })

  it("unit names are names, never options or paths", () => {
    for (const ok of ["nginx.service", "candy-wa-ef3482.service", "user@1000.service", "session-c5.scope", "dev-disk-by\\x2duuid.mount", "docker.socket"]) expect(isUnitName(ok), ok).toBe(true)
    for (const bad of ["--now", "-H host.service", "../x.service", "a b.service", "a;reboot.service", "nginx", "nginx.target", "", "x.service\n", "$(id).service", null, 5]) expect(isUnitName(bad), String(bad)).toBe(false)
  })

  it("unit actions: not candy's own service, not the system's core, scopes only stop", () => {
    const own = "candy-localhost@ashwin.service"
    expect(unitActionProblem("nginx.service", "restart", own)).toBeNull()
    expect(unitActionProblem("nginx.service", "stop", own)).toBeNull()
    expect(unitActionProblem("logrotate.service", "start", own)).toBeNull()
    expect(unitActionProblem("session-c5.scope", "stop", own)).toBeNull()
    expect(unitActionProblem("session-c5.scope", "restart", own)).toContain("scope")
    expect(unitActionProblem(own, "restart", own)).toContain("candy's own")
    expect(unitActionProblem(own, "stop", own)).toContain("candy's own")
    expect(unitActionProblem("systemd-journald.service", "stop", own)).toContain("refused")
    expect(unitActionProblem("dbus.service", "stop", own)).toContain("refused")
    expect(unitActionProblem("init.scope", "stop", own)).toContain("refused")
    expect(unitActionProblem("nginx.service", "disable", own)).toContain("restart, stop or start")
    expect(unitActionProblem("nginx.service", "kill; reboot", own)).not.toBeNull()
    expect(unitActionProblem("--force", "stop", own)).toContain("isn't a unit")
  })
})

describe("sysmon: live", () => {
  it.skipIf(process.platform !== "linux")("a snapshot of this machine, shared by concurrent callers", async () => {
    let runs = 0
    const real = new SystemMonitor()
    const m = new SystemMonitor(async cmd => { runs++; return (real as any).run(cmd) })
    const [a, b] = await Promise.all([m.snapshot(), m.snapshot()])
    expect(a).toBe(b)
    expect(runs).toBe(2)   // df and systemctl, once
    expect(a.cpu.cores.length).toBeGreaterThan(0)
    expect(a.cpu.percent).toBeGreaterThanOrEqual(0)
    expect(a.cpu.percent).toBeLessThanOrEqual(100)
    expect(a.mem.total).toBeGreaterThan(a.mem.used)
    expect(a.mem.used).toBeGreaterThan(0)
    const me = a.processes.find(p => p.pid === process.pid)!
    expect(me).toBeDefined()
    expect(me.mem).toBeGreaterThan(0)
    expect(me.kernel).toBe(false)
    expect(await m.find(me.pid, me.start)).toMatchObject({ pid: process.pid, kernel: false })
    expect(await m.find(me.pid, me.start + 1)).toBeNull()   // a reused pid is another process
    expect(a.counts.processes).toBe(a.processes.length)
  })
})
