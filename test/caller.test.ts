import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { callerOf, clientSockets, holdsSocket, pidsUnder } from "../caller.ts"

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
const row = (n: number, local: string, remote: string, uid: number, inode: number) =>
  `   ${n}: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`
// 9999 = 0x270F, 40000 = 0x9C40
const TCP = HEADER +
  row(0, "0100007F:9C40", "0100007F:270F", 1000, 555) +   // the client end
  row(1, "0100007F:270F", "0100007F:9C40", 0, 556) +      // the daemon's accepted end
  row(2, "0100007F:9C41", "0100007F:270F", 1000, 557) +
  row(3, "00000000:270F", "00000000:0000", 0, 558)
const TCP6 = HEADER + row(0, "00000000000000000000000001000000:9C40", "00000000000000000000000001000000:270F", 1001, 777)

const root = mkdtempSync(join(tmpdir(), "candy-caller-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A /proc with a socket table and processes holding sockets
const fakeProc = (name: string, tcp: string | null, tcp6: string | null, held: Record<number, number[]>) => {
  const proc = join(root, name)
  mkdirSync(join(proc, "net"), { recursive: true })
  if (tcp !== null) writeFileSync(join(proc, "net", "tcp"), tcp)
  if (tcp6 !== null) writeFileSync(join(proc, "net", "tcp6"), tcp6)
  for (const [pid, inodes] of Object.entries(held)) {
    mkdirSync(join(proc, pid, "fd"), { recursive: true })
    symlinkSync("/dev/null", join(proc, pid, "fd", "0"))
    inodes.forEach((inode, i) => symlinkSync(`socket:[${inode}]`, join(proc, pid, "fd", String(i + 3))))
  }
  return proc
}

describe("clientSockets", () => {
  it("picks the client end by its two ports, not the accepted end", () => {
    expect(clientSockets(TCP, 40000, 9999)).toEqual([{ uid: 1000, inode: 555 }])
    expect(clientSockets(TCP, 40001, 9999)).toEqual([{ uid: 1000, inode: 557 }])
    expect(clientSockets(TCP6, 40000, 9999)).toEqual([{ uid: 1001, inode: 777 }])
  })
  it("finds nothing for a port nobody connected from, a listener or junk", () => {
    expect(clientSockets(TCP, 40002, 9999)).toEqual([])
    expect(clientSockets(TCP, 0, 9999)).toEqual([])
    expect(clientSockets("garbage\n\n1: x y\n", 40000, 9999)).toEqual([])
  })
  it("reads the real table without throwing", () => {
    let text = ""
    try { text = readFileSync("/proc/net/tcp", "utf8") } catch { return }
    expect(Array.isArray(clientSockets(text, 1, 2))).toBe(true)
  })
})

describe("holdsSocket and pidsUnder", () => {
  it("knows which process holds a socket", () => {
    const proc = fakeProc("holds", TCP, null, { 10: [555], 11: [999] })
    expect(holdsSocket(10, new Set([555]), proc)).toBe(true)
    expect(holdsSocket(11, new Set([555]), proc)).toBe(false)
    expect(holdsSocket(12, new Set([555]), proc)).toBe(false)   // no such process
  })
  it("lists a cgroup's processes and the ones below it", () => {
    const cg = join(root, "candy.slice")
    mkdirSync(join(cg, "candy-srv-a.service", "inner"), { recursive: true })
    mkdirSync(join(cg, "candy-box-a-1.service"), { recursive: true })
    writeFileSync(join(cg, "cgroup.procs"), "")
    writeFileSync(join(cg, "candy-srv-a.service", "cgroup.procs"), "100\n101\n")
    writeFileSync(join(cg, "candy-srv-a.service", "inner", "cgroup.procs"), "102\n")
    writeFileSync(join(cg, "candy-box-a-1.service", "cgroup.procs"), "200\n")
    expect(pidsUnder(cg).sort()).toEqual([100, 101, 102, 200])
    expect(pidsUnder(join(cg, "candy-srv-a.service"), 0)).toEqual([100, 101])
    expect(pidsUnder(join(root, "nothing-here"))).toEqual([])
  })
})

describe("callerOf", () => {
  const look = (proc: string, candidates: number[], extra: object = {}) =>
    callerOf({ peerPort: 40000, serverPort: 9999, candidates: () => candidates, proc, ...extra })

  it("a candy-run process holding the connection is found", async () => {
    const proc = fakeProc("inside", TCP, TCP6, { 10: [555], 20: [1] })
    expect(await look(proc, [20, 10])).toEqual({ is: "candy-run", pid: 10, uid: 1000 })
  })
  it("the same user's shell is outside: the connection is held by nobody candy runs", async () => {
    const proc = fakeProc("outside", TCP, null, { 10: [557], 30: [555] })
    expect(await look(proc, [10])).toEqual({ is: "outside", uid: 1000 })
  })
  it("the same port over IPv6 counts too", async () => {
    const proc = fakeProc("v6", TCP, TCP6, { 10: [777] })
    expect((await look(proc, [10])).is).toBe("candy-run")
  })
  it("root's sockets are never a site's, and the candidates aren't even listed", async () => {
    const tcp = HEADER + row(0, "0100007F:9C40", "0100007F:270F", 0, 555)
    const proc = fakeProc("root", tcp, null, { 10: [555] })
    let asked = false
    expect(await callerOf({ peerPort: 40000, serverPort: 9999, proc, neverUid: 0, candidates: () => { asked = true; return [10] } })).toEqual({ is: "outside", uid: 0 })
    expect(asked).toBe(false)
    // without that rule (candy run as a normal user) the holder is found
    expect((await look(proc, [10])).is).toBe("candy-run")
  })
  it("says so when the connection isn't in the table, or there is no table", async () => {
    expect(await look(fakeProc("gone", HEADER, HEADER, {}), [10])).toEqual({ is: "gone" })
    expect(await look(fakeProc("none", null, null, {}), [10])).toEqual({ is: "unknown" })
  })
})

describe("the daemon", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "daemon.ts"), "utf8")
  it("checks the caller before any route of its own, for the secret exchange and for API keys", () => {
    const gate = daemon.indexOf("const cliRefusal = await cliCredentialRefusal(req, url)\n    if (cliRefusal) return Response.json({ error: cliRefusal }, { status: 403")
    // after the sites' own hosts are served, before the guard and every route
    expect(gate).toBeGreaterThan(daemon.indexOf("const apiAnswer = await apiModeGate(req, url)"))
    expect(daemon.indexOf("auth = await requestAuth(req)")).toBeGreaterThan(gate)
    expect(daemon.indexOf('url.pathname === "/mcp/auth") {')).toBeGreaterThan(gate)
    expect(daemon).toMatch(/const exchange = req\.method === "POST" && url\.pathname === "\/mcp\/auth"\n  if \(!exchange && !mcpApiKeys\.has\(/)
    expect(daemon).toMatch(/if \(viaOwnCaddy\(req\)\) return /)
  })
  it("leaves a candy-run process the SDK's calls and the exchange, and nothing else", () => {
    const m = /const CANDY_RUN_MAY = (\(method: string, path: string\): boolean =>\n[^\n]+)\n/.exec(daemon)!
    const may = new Function(`return ${m[1].replace(/: string|: boolean/g, "")}`)() as (method: string, path: string) => boolean
    expect(may("POST", "/mcp/auth")).toBe(true)
    expect(may("POST", "/sdk/register-port")).toBe(true)
    expect(may("POST", "/sdk/idle")).toBe(true)
    for (const [method, path] of [["GET", "/mcp/auth"], ["POST", "/config"], ["POST", "/config/boxes"], ["POST", "/config/memory"], ["DELETE", "/register/x"], ["GET", "/configs"], ["GET", "/routes"], ["POST", "/fn/add"], ["POST", "/sdkx"], ["GET", "/"]]) {
      expect(may(method, path)).toBe(false)
    }
    // asked only once the caller is known to be candy-run, and before the refusal
    expect(daemon).toMatch(/if \(caller\.is === "gone"\) return [^\n]+\n  if \(CANDY_RUN_MAY\(req\.method, url\.pathname\)\) return null\n/)
  })
  it("never grants the secret's files to a box", () => {
    expect(daemon).toMatch(/const CLI_SECRET_PATHS = \[CANDY_CONFIG_DIR, USER_SECRETS_DIR, SHARED_SECRET_FILE\]/)
    expect(daemon).toMatch(/secret: CLI_SECRET_PATHS \}/)
  })
})

// The real kernel tables: a child process calls a server here, and is told apart from anyone else
it.skipIf(process.platform !== "linux")("finds a real caller by its connection", async () => {
  const seen: unknown[] = []
  let child: ReturnType<typeof Bun.spawn> | null = null
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const peerPort = server.requestIP(req)!.port
      seen.push(await callerOf({ peerPort, serverPort: server.port!, candidates: () => [child!.pid] }))
      seen.push(await callerOf({ peerPort, serverPort: server.port!, candidates: () => [process.pid] }))
      seen.push(await callerOf({ peerPort, serverPort: server.port!, candidates: () => [child!.pid], neverUid: process.getuid!() }))
      return new Response("ok")
    },
  })
  try {
    child = Bun.spawn(["bun", "-e", `await fetch("http://127.0.0.1:${server.port}/")`], { stdout: "ignore", stderr: "ignore" })
    await child.exited
    const uid = process.getuid!()
    expect(seen).toEqual([{ is: "candy-run", pid: child.pid, uid }, { is: "outside", uid }, { is: "outside", uid }])
  } finally {
    server.stop(true)
  }
})
