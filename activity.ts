// Idle detection for managed servers: what counts as activity, and when an
// idle server may be stopped. Pure helpers plus small /proc readers, so the
// daemon's auto-kill decision can be tested with simulated time.

export const IDLE_TIMEOUT_MS = 60 * 60 * 1000  // 1 hour without activity

// ---------------------------------------------------------------------------
// Open TCP connections (/proc/net/tcp, /proc/net/tcp6)
// ---------------------------------------------------------------------------

const TCP_ESTABLISHED = "01"

// Local ports of ESTABLISHED sockets in one /proc/net/tcp{,6} table.
// Row format: "sl local_address rem_address st ...", addresses are HEXIP:HEXPORT.
export const establishedLocalPorts = (table: string): number[] => {
  const ports: number[] = []
  for (const line of table.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || cols[3] !== TCP_ESTABLISHED) continue
    const port = parseInt(cols[1].split(":")[1] ?? "", 16)
    if (Number.isFinite(port)) ports.push(port)
  }
  return ports
}

export const PROC_TCP_TABLES = ["/proc/net/tcp", "/proc/net/tcp6"]

// How many established connections terminate on any of `ports` on this machine.
// Only the server side matches (local port = the server's port); the client
// side of a loopback connection has the server port as its *remote* port.
export const countEstablished = async (ports: Iterable<number>, tables = PROC_TCP_TABLES): Promise<number> => {
  const wanted = new Set(ports)
  if (wanted.size === 0) return 0
  let count = 0
  for (const path of tables) {
    const text = await Bun.file(path).text().catch(() => "")
    for (const port of establishedLocalPorts(text)) if (wanted.has(port)) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Caddy access log
// ---------------------------------------------------------------------------

// Names a *.localhost / *.candy host could refer to, most specific first:
// "wa.localhost" -> ["wa"], "wa.homeserver.candy" -> ["wa.homeserver", "wa"].
export const localNameCandidates = (host: string): string[] => {
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
  const m = h.match(/^(.+)\.(localhost|candy)$/)
  if (!m) return []
  const base = m[1]
  const out = [base]
  const dot = base.lastIndexOf(".")
  if (dot > 0) out.push(base.slice(0, dot))  // <name>.<host-label>.candy
  return out
}

// Latest finished-request time (ms) per server, from Caddy JSON access-log lines.
// Caddy writes a line when a request finishes; `ts` is that moment.
export const activityFromAccessLog = (
  text: string,
  serverForHost: (host: string) => string | null,
  now = Date.now(),
): Map<string, number> => {
  const latest = new Map<string, number>()
  for (const line of text.split("\n")) {
    if (!line.includes('"http.log.access')) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    const host = entry?.request?.host
    if (typeof host !== "string" || !host) continue
    const name = serverForHost(host)
    if (!name) continue
    const ts = typeof entry.ts === "number" ? Math.min(entry.ts * 1000, now) : now
    if (ts > (latest.get(name) ?? 0)) latest.set(name, ts)
  }
  return latest
}

// Reads only what was appended since the last call; copes with truncation and
// rotation (the file got smaller) and with a line split across two reads.
export class AccessLogTail {
  private pos = 0
  private partial = ""
  constructor(private path: string) {}

  async readNew(): Promise<string> {
    const file = Bun.file(this.path)
    if (!await file.exists()) return ""
    const size = file.size
    if (size < this.pos) { this.pos = 0; this.partial = "" }
    if (size === this.pos) return ""
    const chunk = await file.slice(this.pos, size).text()
    this.pos = size
    const text = this.partial + chunk
    const cut = text.lastIndexOf("\n")
    this.partial = text.slice(cut + 1)
    return text.slice(0, cut + 1)
  }
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MEMORY_USED_LIMIT = 0.8      // fraction of RAM in use
export const MEMORY_PRESSURE_LIMIT = 10   // PSI "some avg10", percent of time stalled

export interface MemoryState {
  usedFraction: number | null      // (MemTotal - MemAvailable) / MemTotal
  pressureAvg10: number | null     // /proc/pressure/memory "some avg10"
}

export const parseMeminfo = (text: string): number | null => {
  const kb = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))
    return m ? Number(m[1]) : null
  }
  const total = kb("MemTotal"), available = kb("MemAvailable")
  if (!total || available === null) return null
  return (total - available) / total
}

export const parsePressure = (text: string): number | null => {
  const m = text.match(/^some\b.*\bavg10=([\d.]+)/m)
  return m ? Number(m[1]) : null
}

export const readMemoryState = async (): Promise<MemoryState> => ({
  usedFraction: parseMeminfo(await Bun.file("/proc/meminfo").text().catch(() => "")),
  pressureAvg10: parsePressure(await Bun.file("/proc/pressure/memory").text().catch(() => "")),
})

export const memoryIsTight = (m: MemoryState): boolean =>
  (m.usedFraction !== null && m.usedFraction >= MEMORY_USED_LIMIT) ||
  (m.pressureAvg10 !== null && m.pressureAvg10 >= MEMORY_PRESSURE_LIMIT)

export const describeMemory = (m: MemoryState): string => {
  const parts: string[] = []
  if (m.usedFraction !== null) parts.push(`memory ${Math.round(m.usedFraction * 100)}% used`)
  if (m.pressureAvg10 !== null) parts.push(`pressure ${m.pressureAvg10}`)
  return parts.join(", ")
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface IdleInput {
  now: number
  lastActivity: number
  hasPortal: boolean
  openConnections: number
  idling: boolean          // the server said (via the SDK) it is waiting for events
  memory: MemoryState
  timeoutMs?: number
}

export type IdleVerdict =
  | { kill: false; reason: "connected" | "portal" | "recent" | "idling" }
  | { kill: true; idleMinutes: number; detail: string }

export const idleVerdict = (i: IdleInput): IdleVerdict => {
  if (i.openConnections > 0) return { kill: false, reason: "connected" }
  if (i.hasPortal) return { kill: false, reason: "portal" }
  const idle = i.now - i.lastActivity
  if (idle <= (i.timeoutMs ?? IDLE_TIMEOUT_MS)) return { kill: false, reason: "recent" }
  const idleMinutes = Math.round(idle / 60000)
  if (i.idling) {
    if (!memoryIsTight(i.memory)) return { kill: false, reason: "idling" }
    return { kill: true, idleMinutes, detail: `idle ${idleMinutes}min, idling, ${describeMemory(i.memory)}` }
  }
  return { kill: true, idleMinutes, detail: `idle ${idleMinutes}min` }
}
