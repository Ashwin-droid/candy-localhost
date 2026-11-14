// System monitor: what the whole machine is doing (not just candy's servers),
// for the portal's superuser view. Reads /proc and /sys; the parsers are pure
// so they can be tested on sample text. Rates (CPU %, network, disk) are the
// difference between two samples, kept here between requests.

import { readdir } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface CpuTimes { total: number; idle: number }

/** /proc/stat: "cpu" (all) and "cpuN" lines, in clock ticks. idle includes iowait. */
export const parseProcStat = (text: string): { all: CpuTimes; cores: CpuTimes[] } => {
  const all: CpuTimes = { total: 0, idle: 0 }
  const cores: CpuTimes[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^cpu(\d*)\s+(.+)$/)
    if (!m) continue
    const n = m[2].trim().split(/\s+/).map(Number)
    // user nice system idle iowait irq softirq steal (guest times are already in user)
    const t = { total: n.slice(0, 8).reduce((a, b) => a + (b || 0), 0), idle: (n[3] || 0) + (n[4] || 0) }
    if (m[1] === "") Object.assign(all, t)
    else cores[Number(m[1])] = t
  }
  return { all, cores: cores.filter(Boolean) }
}

/** Busy share between two samples, 0-100 */
export const cpuPercent = (before: CpuTimes | undefined, after: CpuTimes): number => {
  if (!before) return 0
  const total = after.total - before.total
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, 100 * (1 - (after.idle - before.idle) / total)))
}

export interface MemInfo { total: number; available: number; used: number; cached: number; swapTotal: number; swapUsed: number }

/** /proc/meminfo, in bytes. used = total - available (what `free` calls used + shared, near enough). */
export const parseMeminfo = (text: string): MemInfo => {
  const kb: Record<string, number> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)/)
    if (m) kb[m[1]] = Number(m[2])
  }
  const b = (k: string) => (kb[k] || 0) * 1024
  const total = b("MemTotal")
  const available = kb.MemAvailable !== undefined ? b("MemAvailable") : b("MemFree") + b("Buffers") + b("Cached")
  return {
    total, available, used: Math.max(0, total - available),
    cached: b("Cached") + b("Buffers") + b("SReclaimable"),
    swapTotal: b("SwapTotal"), swapUsed: Math.max(0, b("SwapTotal") - b("SwapFree")),
  }
}

export interface NetCounters { rx: number; tx: number }

/** /proc/net/dev: bytes per interface, without loopback */
export const parseNetDev = (text: string): Record<string, NetCounters> => {
  const out: Record<string, NetCounters> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^\s:]+):\s*(.+)$/)
    if (!m || m[1] === "lo") continue
    const n = m[2].trim().split(/\s+/).map(Number)
    if (n.length >= 9) out[m[1]] = { rx: n[0] || 0, tx: n[8] || 0 }
  }
  return out
}

export interface DiskUsage { device: string; type: string; mount: string; size: number; used: number; available: number }

/** `df -B1 --output=source,fstype,size,used,avail,target`: real filesystems, one row per device */
export const parseDf = (text: string): DiskUsage[] => {
  const rows: DiskUsage[] = []
  const seen = new Set<string>()
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const [, device, type, size, used, available, mount] = m
    if (!device.startsWith("/") && !["zfs", "btrfs", "nfs", "nfs4", "cifs"].includes(type)) continue
    if (/^(squashfs|overlay|tmpfs|devtmpfs|efivarfs)$/.test(type) || Number(size) === 0) continue
    if (seen.has(device)) continue
    seen.add(device)
    rows.push({ device, type, mount: mount.trim(), size: Number(size), used: Number(used), available: Number(available) })
  }
  return rows
}

export interface ProcStat { pid: number; comm: string; state: string; ppid: number; ticks: number; start: number; rssPages: number; threads: number }

/** /proc/<pid>/stat. The name is in parentheses and may itself hold spaces or parentheses. */
export const parsePidStat = (text: string): ProcStat | null => {
  const open = text.indexOf("(")
  const close = text.lastIndexOf(")")
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 1).trim().split(/\s+/)
  // rest[0] is field 3 (state); field N is rest[N - 3]
  const f = (n: number) => Number(rest[n - 3])
  if (!Number.isInteger(pid) || rest.length < 22) return null
  return { pid, comm: text.slice(open + 1, close), state: rest[0], ppid: f(4), ticks: f(14) + f(15), start: f(22), rssPages: f(24), threads: f(20) }
}

/** The systemd unit (or scope) a process is in, from /proc/<pid>/cgroup */
export const unitOfProcess = (cgroupText: string): string | null => {
  const path = cgroupText.split("\n").find(line => line.startsWith("0::"))?.slice(3).trim()
  if (!path) return null
  const parts = path.split("/").filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/\.(service|scope)$/.test(parts[i])) return parts[i]
  }
  return null
}

/** /etc/passwd: uid -> name */
export const parsePasswd = (text: string): Map<number, string> => {
  const users = new Map<number, string>()
  for (const line of text.split("\n")) {
    const p = line.split(":")
    if (p.length >= 3 && /^\d+$/.test(p[2]) && !users.has(Number(p[2]))) users.set(Number(p[2]), p[0])
  }
  return users
}

// ---------------------------------------------------------------------------
// What may be acted on
// ---------------------------------------------------------------------------

export const SIGNALS = ["TERM", "KILL"] as const
export type MonitorSignal = typeof SIGNALS[number]
export const UNIT_ACTIONS = ["restart", "stop", "start"] as const
export type UnitAction = typeof UNIT_ACTIONS[number]

/** A unit name as systemd writes it. Nothing that could be an option or a path. */
export const isUnitName = (unit: unknown): unit is string =>
  typeof unit === "string" && unit.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9:_.@\\-]*\.(service|scope|socket|timer|mount)$/.test(unit)

/**
 * Why a process can't be signalled from the monitor, or null. Never init, the
 * kernel's threads, or the daemon itself (use the portal's own shutdown).
 */
export const killProblem = (p: { pid: number; ppid: number; kernel: boolean }, self: number): string | null => {
  if (!Number.isInteger(p.pid) || p.pid <= 0) return "That isn't a process id."
  if (p.pid === 1) return "Process 1 is the system itself. Stopping it would take the machine down."
  if (p.kernel || p.pid === 2 || p.ppid === 2) return "That is a kernel thread. It can't be stopped."
  if (p.pid === self) return "That is candy's own daemon. Use Shut down in Daemon settings."
  return null
}

/** Why a unit can't be acted on from the monitor, or null */
export const unitActionProblem = (unit: string, action: string, ownUnit: string | null): string | null => {
  if (!isUnitName(unit)) return "That isn't a unit name."
  if (!(UNIT_ACTIONS as readonly string[]).includes(action)) return "Choose restart, stop or start."
  if (unit.endsWith(".scope") && action !== "stop") return "A scope can only be stopped."
  if (ownUnit && unit === ownUnit) return "That is candy's own service. Restarting it from here would cut this page off: use systemctl."
  if (action === "stop" && /^(init\.scope|dbus(-broker)?\.service|systemd-[a-z-]+\.service)$/.test(unit)) return "The system needs that unit. Stopping it from here is refused."
  return null
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface ProcessRow {
  pid: number; ppid: number; user: string; name: string; cmd: string; state: string
  cpu: number      // percent of one core since the last sample
  mem: number      // resident bytes
  threads: number
  start: number    // start time in clock ticks since boot: with pid, names one process for good
  unit: string | null
  kernel: boolean
}

export interface UnitRow { unit: string; processes: number; cpu: number; mem: number; failed?: boolean }

export interface Snapshot {
  at: number
  host: string
  uptime: number
  load: [number, number, number]
  cpu: { percent: number; cores: number[] }
  mem: MemInfo
  disks: DiskUsage[]
  net: { name: string; rx: number; tx: number }[]   // bytes per second
  temp: number | null
  processes: ProcessRow[]
  units: UnitRow[]
  failed: string[]
  counts: { processes: number; threads: number }
}

const PAGE = 4096
const TICKS = 100
const read = (path: string) => Bun.file(path).text().catch(() => "")

export class SystemMonitor {
  private prev: { at: number; cpu: { all: CpuTimes; cores: CpuTimes[] }; net: Record<string, NetCounters>; ticks: Map<string, number> } | null = null
  private users: { at: number; map: Map<number, string> } = { at: 0, map: new Map() }
  private slow: { at: number; disks: DiskUsage[]; failed: string[] } = { at: 0, disks: [], failed: [] }
  private running: Promise<Snapshot> | null = null
  private last: Snapshot | null = null

  constructor(private run: (cmd: string[]) => Promise<string> = async cmd => {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out
  }) {}

  /** One snapshot. Concurrent callers share it, and one less than a second old is reused. */
  async snapshot(): Promise<Snapshot> {
    if (this.last && Date.now() - this.last.at < 900) return this.last
    if (!this.running) this.running = this.collect().finally(() => { this.running = null })
    return this.running
  }

  private async collect(): Promise<Snapshot> {
    // Rates need an earlier sample: none yet (or a stale one), so take one and wait a moment
    if (!this.prev || Date.now() - this.prev.at > 30_000) {
      await this.sample()
      await Bun.sleep(300)
    }
    return (this.last = await this.sample())
  }

  private async sample(): Promise<Snapshot> {
    const at = Date.now()
    const [stat, meminfo, netdev, loadavg, uptime, host] = await Promise.all([
      read("/proc/stat"), read("/proc/meminfo"), read("/proc/net/dev"), read("/proc/loadavg"), read("/proc/uptime"), read("/proc/sys/kernel/hostname"),
    ])
    const cpu = parseProcStat(stat)
    const net = parseNetDev(netdev)
    const prev = this.prev
    const seconds = prev ? Math.max(0.05, (at - prev.at) / 1000) : 1

    if (at - this.users.at > 60_000) this.users = { at, map: parsePasswd(await read("/etc/passwd")) }
    if (at - this.slow.at > 10_000) {
      const [df, failed] = await Promise.all([
        this.run(["df", "-B1", "--output=source,fstype,size,used,avail,target"]).catch(() => ""),
        this.run(["systemctl", "list-units", "--state=failed", "--no-legend", "--plain", "--no-pager"]).catch(() => ""),
      ])
      this.slow = { at, disks: parseDf(df), failed: failed.split("\n").map(l => l.trim().split(/\s+/)[0]).filter(isUnitName) }
    }

    const pids = (await readdir("/proc").catch(() => [] as string[])).filter(d => /^\d+$/.test(d))
    const ticks = new Map<string, number>()
    let threads = 0
    const rows = (await Promise.all(pids.map(async (pid): Promise<ProcessRow | null> => {
      const st = parsePidStat(await read(`/proc/${pid}/stat`))
      if (!st) return null
      const [cmdline, cgroup, owner] = await Promise.all([
        read(`/proc/${pid}/cmdline`), read(`/proc/${pid}/cgroup`),
        Bun.file(`/proc/${pid}`).stat().then(s => s.uid).catch(() => -1),
      ])
      const key = `${st.pid}:${st.start}`
      ticks.set(key, st.ticks)
      threads += st.threads || 1
      const before = prev?.ticks.get(key)
      const cmd = cmdline.replace(/\0+$/, "").replace(/\0/g, " ").slice(0, 400)
      return {
        pid: st.pid, ppid: st.ppid, user: this.users.map.get(owner) ?? (owner >= 0 ? String(owner) : "?"),
        name: st.comm, cmd, state: st.state,
        cpu: before === undefined ? 0 : Math.max(0, ((st.ticks - before) / TICKS / seconds) * 100),
        mem: st.rssPages * PAGE, threads: st.threads, start: st.start,
        unit: unitOfProcess(cgroup), kernel: cmd === "" && (st.ppid === 2 || st.pid === 2),
      }
    }))).filter((r): r is ProcessRow => !!r)

    const units = new Map<string, UnitRow>()
    for (const r of rows) {
      if (!r.unit) continue
      const u = units.get(r.unit) ?? { unit: r.unit, processes: 0, cpu: 0, mem: 0 }
      u.processes++; u.cpu += r.cpu; u.mem += r.mem
      units.set(r.unit, u)
    }
    for (const f of this.slow.failed) if (!units.has(f)) units.set(f, { unit: f, processes: 0, cpu: 0, mem: 0, failed: true })

    let temp: number | null = null
    for (let i = 0; i < 12; i++) {
      const t = Number(await read(`/sys/class/thermal/thermal_zone${i}/temp`))
      if (Number.isFinite(t) && t > 0) temp = Math.max(temp ?? 0, t / 1000)
      else if (i > 0 && !t) break
    }

    const snapshot: Snapshot = {
      at,
      host: host.trim(),
      uptime: Number(uptime.split(" ")[0]) || 0,
      load: (loadavg.split(" ").slice(0, 3).map(Number) as [number, number, number]),
      cpu: { percent: cpuPercent(prev?.cpu.all, cpu.all), cores: cpu.cores.map((c, i) => cpuPercent(prev?.cpu.cores[i], c)) },
      mem: parseMeminfo(meminfo),
      disks: this.slow.disks,
      net: Object.entries(net).map(([name, c]) => {
        const p = prev?.net[name]
        return { name, rx: p ? Math.max(0, (c.rx - p.rx) / seconds) : 0, tx: p ? Math.max(0, (c.tx - p.tx) / seconds) : 0 }
      }),
      temp,
      processes: rows,
      units: [...units.values()],
      failed: this.slow.failed,
      counts: { processes: rows.length, threads },
    }
    this.prev = { at, cpu, net, ticks }
    return snapshot
  }

  /** The process the page saw, if it is still that process (same pid and start time) */
  async find(pid: number, start: number): Promise<{ pid: number; ppid: number; name: string; cmd: string; kernel: boolean; user: string } | null> {
    const st = parsePidStat(await read(`/proc/${pid}/stat`))
    if (!st || st.start !== start) return null
    const cmd = (await read(`/proc/${pid}/cmdline`)).replace(/\0+$/, "").replace(/\0/g, " ").slice(0, 400)
    const uid = await Bun.file(`/proc/${pid}`).stat().then(s => s.uid).catch(() => -1)
    return { pid: st.pid, ppid: st.ppid, name: st.comm, cmd, kernel: cmd === "" && (st.ppid === 2 || st.pid === 2), user: this.users.map.get(uid) ?? String(uid) }
  }
}
