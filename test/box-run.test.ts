import { afterAll, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BoxHost, type BoxInfo, type StartBox } from "../box-run.ts"

const dir = mkdtempSync(join(tmpdir(), "box-run-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
const spec = (cmd: string[], over: Partial<StartBox> = {}): StartBox => {
  const id = `b${++seq}`
  return {
    id, site: "wa", user: "claude", unit: `candy-box-${id}.service`, label: null, memory: 256,
    socket: join(dir, `${id}.sock`), cmd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, ...over,
  }
}

// What systemd-run prints around a box, so the real exit path can be driven without systemd
const fakeRun = (body: string, result: string, main: string, code: number) => ["sh", "-c", [
  'echo "Running as unit: x.service" >&2',
  body,
  `echo "Finished with result: ${result}" >&2`,
  `echo "Main processes terminated with: ${main}" >&2`,
  'echo "Service runtime: 12ms" >&2',
  `exit ${code}`,
].join("\n")]

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

interface Client {
  chunks: Buffer[]
  closed: boolean
  text(): string
  bytes(): Buffer
  write(data: Uint8Array | string): Promise<void>
  end(): void
}

const connect = async (path: string): Promise<Client> => {
  let drained: (() => void) | null = null
  const c = {
    chunks: [] as Buffer[],
    closed: false,
    text: () => Buffer.concat(c.chunks).toString(),
    bytes: () => Buffer.concat(c.chunks),
    // A client that respects backpressure: partial writes wait for drain
    write: async (data: Uint8Array | string) => {
      let buf = typeof data === "string" ? Buffer.from(data) : data
      while (buf.length) {
        const n = sock.write(buf)
        if (n > 0) buf = buf.subarray(n)
        if (buf.length) await new Promise<void>(resolve => { drained = resolve })
      }
    },
    end: () => sock.end(),
  }
  const sock = await Bun.connect({
    unix: path,
    socket: {
      data: (_s, d) => { c.chunks.push(Buffer.from(d)) },
      drain: () => { const d = drained; drained = null; d?.() },
      close: () => { c.closed = true },
      error: () => { c.closed = true },
    },
  })
  return c
}

describe("BoxHost", () => {
  it("relays stdin and stdout through the socket", async () => {
    const host = new BoxHost()
    const s = spec(["cat"])
    const info = await host.start(s)
    expect(info.state).toBe("running")
    const c = await connect(s.socket)
    await c.write("hello box\n")
    await waitFor(() => c.text() === "hello box\n")
    expect(await host.stop("wa", s.id, "released")).toBe(true)
    const done = await host.wait("wa", s.id, 3000)
    expect(done?.state).toBe("exited")
    await waitFor(() => c.closed)
  })

  it("keeps the box across a reconnect and loses no output", async () => {
    const host = new BoxHost()
    // Output is written while nobody is attached, then more after the next client speaks
    const s = spec(["sh", "-c", "read a; sleep 0.1; echo got-$a; for i in 0 1 2 3 4; do echo line$i; done; read b; echo end-$b"])
    await host.start(s)
    const c1 = await connect(s.socket)
    await c1.write("x\n")
    c1.end()
    await waitFor(() => c1.closed)
    await Bun.sleep(200)
    expect(host.get("wa", s.id)?.state).toBe("running")
    const c2 = await connect(s.socket)
    await c2.write("y\n")
    await host.wait("wa", s.id, 3000)
    await waitFor(() => c2.closed)
    expect(c1.text() + c2.text()).toBe("got-x\nline0\nline1\nline2\nline3\nline4\nend-y\n")
    expect(c2.text()).toContain("end-y")
  })

  it("refuses a second client while one is attached", async () => {
    const host = new BoxHost()
    const s = spec(["cat"])
    await host.start(s)
    const c1 = await connect(s.socket)
    const c2 = await connect(s.socket)
    await waitFor(() => c2.closed)
    await c1.write("still mine\n")
    await waitFor(() => c1.text() === "still mine\n")
    expect(c1.closed).toBe(false)
    await host.stopAll("stopped")
    await host.wait("wa", s.id, 3000)
  })

  it("reports how a box ended from systemd-run's lines", async () => {
    const exits: BoxInfo[] = []
    const host = new BoxHost({ onExit: info => { exits.push(info) } })

    const code = spec(fakeRun("true", "exit-code", "code=exited/status=3", 3))
    await host.start(code)
    const a = await host.wait("wa", code.id, 3000)
    expect(a?.exit).toMatchObject({ cause: "exit", code: 3 })

    const oom = spec(fakeRun("true", "oom-kill", "code=killed/status=KILL", 137))
    await host.start(oom)
    expect((await host.wait("wa", oom.id, 3000))?.exit?.cause).toBe("oom")

    // Stopped only once systemd-run would have said it started, as the real one does first
    const released = spec(["sh", "-c", 'echo "Running as unit: x.service" >&2; echo ready; exec cat'])
    await host.start(released)
    const c = await connect(released.socket)
    await waitFor(() => c.text() === "ready\n")
    expect(await host.stop("wa", released.id, "released")).toBe(true)
    expect((await host.wait("wa", released.id, 3000))?.exit?.cause).toBe("released")
    expect(await host.stop("wa", released.id, "stopped")).toBe(false)

    // A plain command never printed "Running as unit": it never ran as far as systemd goes
    const plain = spec(["sh", "-c", "echo nope >&2; exit 1"])
    await host.start(plain)
    expect((await host.wait("wa", plain.id, 3000))?.exit).toMatchObject({ cause: "failed", detail: "nope" })

    expect(exits.map(e => e.id)).toEqual([code.id, oom.id, released.id, plain.id])
  })

  it("stops through stopUnit, and the first one to ask is who stopped it", async () => {
    const units: string[] = []
    const host = new BoxHost({ stopUnit: async unit => { units.push(unit) } })
    const s = spec(["sh", "-c", 'echo "Running as unit: x.service" >&2; exec sleep 0.2'])
    await host.start(s)
    expect(await host.stop("wa", s.id, "site-stopped")).toBe(true)
    expect(await host.stop("wa", s.id, "released")).toBe(true)
    expect(units).toEqual([s.unit, s.unit])
    expect((await host.wait("wa", s.id, 3000))?.exit?.cause).toBe("site-stopped")
  })

  it("keeps only the tail of stderr, without systemd-run's lines", async () => {
    let told = ""
    const host = new BoxHost({ stderrBytes: 1000, onExit: (_info, stderr) => { told = stderr } })
    const s = spec(fakeRun("i=0; while [ $i -lt 400 ]; do echo err-$i >&2; i=$((i+1)); done", "success", "code=exited/status=0", 0))
    await host.start(s)
    expect((await host.wait("wa", s.id, 3000))?.exit).toMatchObject({ cause: "exit", code: 0 })
    const tail = host.stderr("wa", s.id)
    expect(tail.length).toBeLessThanOrEqual(1000)
    expect(tail.endsWith("err-399")).toBe(true)
    expect(tail).not.toContain("err-0\n")
    expect(tail).not.toContain("Finished with")
    expect(tail).not.toContain("Running as unit")
    expect(tail).not.toContain("Service runtime")
    expect(told).toBe(tail)
    expect(host.stderr("other", s.id)).toBe("")
  })

  it("waits for the exit, or gives up while it still runs", async () => {
    const host = new BoxHost()
    const s = spec(["cat"])
    await host.start(s)
    const t = Date.now()
    expect((await host.wait("wa", s.id, 50))?.state).toBe("running")
    expect(Date.now() - t).toBeLessThan(1000)
    expect(await host.wait("wa", "nope", 50)).toBeNull()
    expect(await host.wait("other", s.id, 50)).toBeNull()
    const waiting = host.wait("wa", s.id, 5000)
    await host.stop("wa", s.id, "stopped")
    expect((await waiting)?.state).toBe("exited")
  })

  it("scopes get, list and held by site", async () => {
    const host = new BoxHost({ keepExitedMs: 300 })
    const a1 = spec(["cat"], { site: "a" })
    const b1 = spec(["cat"], { site: "b" })
    const a2 = spec(["true"], { site: "a" })
    const a3 = spec(["cat"], { site: "a", label: "third" })
    await host.start(a1)
    await host.start(b1)
    await host.start(a2)
    await host.wait("a", a2.id, 3000)
    await Bun.sleep(2)
    await host.start(a3)

    expect(host.get("a", a1.id)?.id).toBe(a1.id)
    expect(host.get("b", a1.id)).toBeNull()
    expect(host.held("a")).toBe(2)
    expect(host.held("b")).toBe(1)
    expect(host.held("c")).toBe(0)
    expect(host.list("a").map(i => i.id)).toEqual([a1.id, a3.id, a2.id])
    expect(host.list("a")[1].label).toBe("third")
    expect(host.list("b").map(i => i.id)).toEqual([b1.id])
    expect(host.list().map(i => i.state)).toEqual(["running", "running", "running", "exited"])

    expect(await host.stopSite("a", "site-stopped")).toBe(2)
    await host.wait("a", a1.id, 3000)
    await host.wait("a", a3.id, 3000)
    expect(host.held("a")).toBe(0)
    expect(host.held("b")).toBe(1)
    expect(host.get("a", a1.id)?.exit?.cause).toBe("site-stopped")  // who asked wins, even for a unit that never came up
    await host.stopAll("stopped")
    await host.wait("b", b1.id, 3000)
    expect(host.list().every(i => i.state === "exited")).toBe(true)

    // Exited records are forgotten after keepExitedMs
    await waitFor(() => host.list().length === 0)
    expect(host.get("a", a2.id)).toBeNull()
  })

  it("makes the socket 0600, replaces a stale one, and removes it at exit", async () => {
    const host = new BoxHost()
    const s = spec(["cat"])
    writeFileSync(s.socket, "stale")
    await host.start(s)
    expect(statSync(s.socket).mode & 0o777).toBe(0o600)
    expect(statSync(s.socket).isSocket()).toBe(true)
    await host.stop("wa", s.id, "stopped")
    await host.wait("wa", s.id, 3000)
    expect(existsSync(s.socket)).toBe(false)
  })

  it("throws when the socket can't be made, leaving no box", async () => {
    const host = new BoxHost()
    const s = spec(["cat"], { socket: join(dir, "missing", "x.sock") })
    await expect(host.start(s)).rejects.toThrow()
    expect(host.list()).toEqual([])
  })

  it("survives an onExit that throws", async () => {
    const host = new BoxHost({ onExit: () => { throw new Error("daemon bug") } })
    const s1 = spec(["true"])
    await host.start(s1)
    expect((await host.wait("wa", s1.id, 3000))?.state).toBe("exited")
    const s2 = spec(["cat"])
    await host.start(s2)
    const c = await connect(s2.socket)
    await c.write("ok\n")
    await waitFor(() => c.text() === "ok\n")
    await host.stopAll("stopped")
    expect((await host.wait("wa", s2.id, 3000))?.state).toBe("exited")
  })

  it("carries 20 MB through cat intact", async () => {
    const host = new BoxHost()
    const s = spec(["cat"])
    await host.start(s)
    const c = await connect(s.socket)
    const data = randomBytes(20 * 1024 * 1024)
    await c.write(data)
    await waitFor(() => c.chunks.reduce((n, b) => n + b.length, 0) >= data.length, 15000)
    const got = c.bytes()
    expect(got.length).toBe(data.length)
    expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"))
    await host.stop("wa", s.id, "released")
    await host.wait("wa", s.id, 3000)
  }, 20000)
})

it("a box ended by TERM that nobody here stopped asks who did: its site going is 'site-stopped'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candy-box-late-"))
  const script = `echo "Running as unit: x.service" >&2; trap 'echo "Finished with result: success" >&2; echo "Main processes terminated with: code=exited, status=143/n/a" >&2; exit 143' TERM; echo ready; while :; do sleep 0.05; done`
  const asked: string[] = []
  const host = new BoxHost({ askedLate: async box => { asked.push(box.id); return box.id === "gone" ? "site-stopped" : null } })
  try {
    const exits: Record<string, string | undefined> = {}
    for (const id of ["gone", "stays"]) {
      const info = await host.start({ id, site: "a", user: "u", unit: `${id}.service`, label: null, memory: 64, socket: join(dir, `${id}.sock`), cmd: ["/bin/sh", "-c", script], env: { PATH: "/usr/bin:/bin" } })
      const pid = Number(Bun.spawnSync(["pgrep", "-f", "-n", "Running as unit: x.service"]).stdout.toString().trim())
      await Bun.sleep(150)
      process.kill(pid, "SIGTERM")   // not through host.stop: as systemd would
      exits[id] = (await host.wait("a", info.id, 5000))?.exit?.cause
    }
    expect(exits).toEqual({ gone: "site-stopped", stays: "signal" })
    expect(asked).toEqual(["gone", "stays"])
  } finally {
    await host.stopAll("stopped")
    rmSync(dir, { recursive: true, force: true })
  }
})
