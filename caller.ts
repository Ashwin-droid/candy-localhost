// Which process is on the other end of a loopback connection to the daemon.
//
// The CLI's credential (the bootstrap secret, and the API key it buys) is for a
// person at a shell. A process candy runs (a site, a cron run, a function, a
// box) has the runtime token instead, so the daemon refuses the CLI's
// credential from one. TCP has no SO_PEERCRED: the kernel's socket table says
// which socket the connection is, and /proc/<pid>/fd says who holds it.
import { readdirSync, readFileSync, readlinkSync } from "node:fs"

export interface ClientSocket { uid: number; inode: number }

/**
 * The client ends of connections from <peerPort> to <serverPort>, out of the text of
 * /proc/net/tcp or /proc/net/tcp6. (The accepted end has the two ports the other way round.)
 */
export const clientSockets = (text: string, peerPort: number, serverPort: number): ClientSocket[] => {
  const out: ClientSocket[] = []
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || !/^\d+:$/.test(f[0])) continue
    const port = (addr: string) => parseInt(addr.slice(addr.lastIndexOf(":") + 1), 16)
    if (port(f[1]) !== peerPort || port(f[2]) !== serverPort) continue
    const uid = Number(f[7]), inode = Number(f[9])
    if (Number.isInteger(uid) && Number.isInteger(inode) && inode > 0) out.push({ uid, inode })
  }
  return out
}

/** Every PID in a cgroup and the cgroups below it */
export const pidsUnder = (cgroupDir: string, depth = 6): number[] => {
  const pids: number[] = []
  try {
    for (const line of readFileSync(`${cgroupDir}/cgroup.procs`, "utf8").split("\n")) {
      const pid = Number(line)
      if (line && Number.isInteger(pid) && pid > 0) pids.push(pid)
    }
  } catch {}
  if (depth <= 0) return pids
  try {
    for (const entry of readdirSync(cgroupDir, { withFileTypes: true })) {
      if (entry.isDirectory()) pids.push(...pidsUnder(`${cgroupDir}/${entry.name}`, depth - 1))
    }
  } catch {}
  return pids
}

/** Does this process hold one of these sockets open? */
export const holdsSocket = (pid: number, inodes: ReadonlySet<number>, proc = "/proc"): boolean => {
  let fds: string[]
  try { fds = readdirSync(`${proc}/${pid}/fd`) } catch { return false }
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`${proc}/${pid}/fd/${fd}`))
      if (m && inodes.has(Number(m[1]))) return true
    } catch {}
  }
  return false
}

export type Caller =
  | { is: "unknown" }                 // no socket table to read (not Linux): nothing to go on
  | { is: "gone" }                    // the table has no such connection
  | { is: "outside"; uid: number }    // nobody candy runs holds it
  | { is: "candy-run"; pid: number; uid: number }

export interface CallerLookup {
  peerPort: number
  serverPort: number
  /** The PIDs of everything candy runs. Only asked when the socket could be one of theirs. */
  candidates: () => number[] | Promise<number[]>
  /** A socket owned by this uid is never a candy-run process's (root, when candy runs as root) */
  neverUid?: number | null
  proc?: string
}

export const callerOf = async (o: CallerLookup): Promise<Caller> => {
  const proc = o.proc ?? "/proc"
  const sockets: ClientSocket[] = []
  let readable = false
  for (const file of ["tcp", "tcp6"]) {
    try {
      sockets.push(...clientSockets(readFileSync(`${proc}/net/${file}`, "utf8"), o.peerPort, o.serverPort))
      readable = true
    } catch {}
  }
  if (!readable) return { is: "unknown" }
  if (sockets.length === 0) return { is: "gone" }
  const suspects = sockets.filter(s => o.neverUid == null || s.uid !== o.neverUid)
  if (suspects.length === 0) return { is: "outside", uid: sockets[0].uid }
  const inodes = new Set(suspects.map(s => s.inode))
  for (const pid of new Set(await o.candidates())) {
    if (holdsSocket(pid, inodes, proc)) return { is: "candy-run", pid, uid: suspects[0].uid }
  }
  return { is: "outside", uid: suspects[0].uid }
}
