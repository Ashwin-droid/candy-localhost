import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRuntime, type BoxExit, type BoxInfo, type RuntimeRecord, RUNTIME_HEADER } from "../sdk-runtime.ts"
import type { BoxExit as DaemonBoxExit } from "../box.ts"
import sdk, { boxQuota, getBox, listBoxes, rentBox } from "../sdk.ts"

const record: RuntimeRecord = { token: "tok", site: "social", url: "http://daemon" }
const NOW = 1_700_000_000_000

const info = (over: Partial<BoxInfo> = {}): BoxInfo => ({
  id: "b1", site: "social", user: "ashwin", unit: "candy-box-social-b1.service", label: null,
  socket: "/run/candy/box/b1.sock", memory: 512, memoryUsed: null, startedAt: NOW, state: "running", exit: null, ...over,
})
const exit: BoxExit = { cause: "exit", code: 0, signal: null, detail: null, at: NOW + 5 }

// A fake daemon: records each body, answers with `answer(body, n)` (n counts calls)
const daemon = (answer: (body: Record<string, unknown>, n: number) => Response | Promise<Response>) => {
  const calls: Record<string, unknown>[] = []
  const headers: (string | null)[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    expect(new URL(url).pathname).toBe("/runtime/boxes")
    expect(init.method).toBe("POST")
    headers.push(new Headers(init.headers).get(RUNTIME_HEADER))
    const body = JSON.parse(init.body as string)
    calls.push(body)
    return answer(body, calls.length)
  }) as unknown as typeof fetch
  return { calls, headers, rt: createRuntime(record, fetcher) }
}

describe("boxes in the SDK", () => {
  it("quota and list speak /runtime/boxes with the runtime token", async () => {
    const quota = { enabled: true, available: false, reason: "all 2 boxes are in use", max: 2, memory: 4096, held: 2 }
    const { calls, headers, rt } = daemon(body => body.action === "quota" ? Response.json({ boxes: quota }) : Response.json({ boxes: [info()] }))
    expect(await rt.boxQuota()).toEqual(quota)
    expect(await rt.listBoxes()).toEqual([info()])
    expect(calls).toEqual([{ action: "quota" }, { action: "list" }])
    expect(headers).toEqual(["tok", "tok"])
  })

  it("rentBox sends only what was set, and gives a Box", async () => {
    const { calls, rt } = daemon(() => Response.json({ box: info({ label: "job" }) }))
    const box = await rt.rentBox({ cmd: ["/usr/bin/true"] })
    expect(calls[0]).toEqual({ action: "rent", cmd: ["/usr/bin/true"] })
    expect(box.id).toBe("b1")
    expect(box.socket).toBe("/run/candy/box/b1.sock")
    expect(box.info.label).toBe("job")

    await rt.rentBox({
      cmd: ["/bin/sh", "-c", "x"], cwd: "/srv/a", env: { A: "1" }, grants: [{ path: "/srv/a", mode: "rw" }],
      memory: "1G", cpu: 150, tasks: 64, seconds: 60, isolation: ["PrivateNetwork=yes"], label: "job",
    })
    expect(calls[1]).toEqual({
      action: "rent", cmd: ["/bin/sh", "-c", "x"], cwd: "/srv/a", env: { A: "1" }, grants: [{ path: "/srv/a", mode: "rw" }],
      memory: "1G", cpu: 150, tasks: 64, seconds: 60, isolation: ["PrivateNetwork=yes"], label: "job",
    })
    await expect(rt.rentBox({ cmd: [] })).rejects.toThrow("needs { cmd")
    expect(calls.length).toBe(2)
  })

  it("a refusal throws with candy's own words", async () => {
    const { rt } = daemon(() => Response.json({ error: '"memory" 8G is more than a box of this site may have (4G)' }, { status: 400 }))
    await expect(rt.rentBox({ cmd: ["/usr/bin/true"], memory: "8G" })).rejects.toThrow('"memory" 8G is more than a box of this site may have (4G)')
    const bare = daemon(() => new Response("oops", { status: 500 }))
    await expect(bare.rt.listBoxes()).rejects.toThrow("candy answered 500")
  })

  it("getBox: a Box, or null on 404; other errors throw", async () => {
    const { calls, rt } = daemon(body => body.id === "b1" ? Response.json({ box: info(), stderr: "" })
      : body.id === "gone" ? Response.json({ error: "no such box" }, { status: 404 })
      : Response.json({ error: "boxes are off for social" }, { status: 403 }))
    const box = await rt.getBox("b1")
    expect(box?.id).toBe("b1")
    expect(await rt.getBox("gone")).toBeNull()
    await expect(rt.getBox("other")).rejects.toThrow("boxes are off for social")
    expect(calls.map(c => [c.action, c.id])).toEqual([["get", "b1"], ["get", "gone"], ["get", "other"]])
  })

  it("refresh, stderr and stop", async () => {
    const { calls, rt } = daemon((body, n) => {
      if (body.action === "rent") return Response.json({ box: info() })
      if (body.action === "stop") return Response.json({ stopped: true })
      return Response.json({ box: info({ memoryUsed: n * 1000 }), stderr: "warn: x\n" })
    })
    const box = await rt.rentBox({ cmd: ["/usr/bin/true"] })
    expect((await box.refresh()).memoryUsed).toBe(2000)
    expect(box.info.memoryUsed).toBe(2000)
    expect(await box.stderr()).toBe("warn: x\n")
    expect(box.info.memoryUsed).toBe(3000)
    expect(await box.stop()).toBe(true)
    expect(calls.slice(1)).toEqual([{ action: "get", id: "b1" }, { action: "get", id: "b1" }, { action: "stop", id: "b1" }])
  })

  it("exited() asks again while candy says running, and is one promise per Box", async () => {
    const { calls, rt } = daemon(async (body, n) => {
      if (body.action === "rent") return Response.json({ box: info() })
      await Bun.sleep(210)   // candy holds a wait; this one holds briefly
      return Response.json({ box: n < 4 ? info() : info({ state: "exited", exit }) })
    })
    const box = await rt.rentBox({ cmd: ["/usr/bin/true"] })
    const a = box.exited()
    expect(box.exited()).toBe(a)
    expect(await a).toEqual(exit)
    expect(box.info.state).toBe("exited")
    expect(calls.slice(1)).toEqual([1, 2, 3].map(() => ({ action: "wait", id: "b1", timeout: 8000 })))
    // Already known: no more asking
    expect(await box.exited()).toEqual(exit)
    expect(calls.length).toBe(4)
  })

  it("exited() of a box that has already ended answers without asking", async () => {
    const { calls, rt } = daemon(() => Response.json({ box: info({ state: "exited", exit }), stderr: "" }))
    const box = await rt.getBox("b1")
    expect(await box!.exited()).toEqual(exit)
    expect(calls.length).toBe(1)
  })

  it("exited() waits out a dropped connection and a 5xx, and rejects on 404", async () => {
    let n = 0
    const fetcher = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.action === "rent") return Response.json({ box: info() })
      n++
      if (n === 1) throw new TypeError("fetch failed")
      if (n === 2) return Response.json({ error: "restarting" }, { status: 503 })
      return Response.json({ box: info({ state: "exited", exit: { ...exit, cause: "oom" } }) })
    }) as unknown as typeof fetch
    const box = await createRuntime(record, fetcher).rentBox({ cmd: ["/usr/bin/true"] })
    expect((await box.exited()).cause).toBe("oom")
    expect(n).toBe(3)

    const { rt } = daemon(body => body.action === "rent" ? Response.json({ box: info() }) : Response.json({ error: "no such box" }, { status: 404 }))
    const gone = await rt.rentBox({ cmd: ["/usr/bin/true"] })
    await expect(gone.exited()).rejects.toThrow("no such box")
  })

  it("sdk.ts re-exports them, default export too", () => {
    for (const f of [rentBox, getBox, listBoxes, boxQuota]) expect(typeof f).toBe("function")
    expect(sdk.rentBox).toBe(rentBox)
    expect(sdk.getBox).toBe(getBox)
    expect(sdk.listBoxes).toBe(listBoxes)
    expect(sdk.boxQuota).toBe(boxQuota)
  })

  it("sdk-runtime.ts never loads box.ts (it ships next to the function shim, box.ts doesn't)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "sdk-runtime.ts"), "utf8")
    expect(src).not.toMatch(/(from|import)\s*\(?\s*["']\.\/box(\.ts)?["']/)
    expect(src).not.toMatch(/require\(\s*["']\.\/box/)
  })

  it("its BoxExit is box.ts's", () => {
    // Both ways assignable: a change to one without the other fails to type-check here
    const a: DaemonBoxExit = exit
    const b: BoxExit = a
    expect(b).toEqual(exit)
    const cause = (src: string) => src.slice(src.indexOf("export type BoxExitCause"), src.indexOf("export interface BoxExit {")).replace(/\s+/g, " ")
    const iface = (src: string) => src.match(/export interface BoxExit \{[^}]*\}/)?.[0]
    const box = readFileSync(join(import.meta.dir, "..", "box.ts"), "utf8")
    const runtime = readFileSync(join(import.meta.dir, "..", "sdk-runtime.ts"), "utf8")
    expect(cause(runtime)).toBe(cause(box))
    expect(iface(runtime)).toBe(iface(box))
  })
})

// `candy boxes` against a throwaway daemon stub on an ephemeral port (never 9999)
describe("candy boxes CLI", () => {
  const CLI = join(import.meta.dir, "..", "cli.ts")
  const dir = mkdtempSync(join(tmpdir(), "candy-boxes-cli-"))
  const posted: unknown[] = []
  let server: ReturnType<typeof Bun.serve>
  const held = [
    { id: "b1", label: "build", unit: "u1", memory: 4096, memoryUsed: 1.5 * 1024 ** 3, startedAt: Date.now() - 125_000 },
    { id: "b2", label: null, unit: "u2", memory: 512, memoryUsed: null, startedAt: Date.now() - 5_000 },
  ]
  const configs = {
    social: { cwd: "/srv/social", cmd: "bun run .", boxes: { wanted: true, quota: { max: 12, memory: 4096 }, held } },
    unwanted: { cwd: "/srv/u", cmd: "x", boxes: { wanted: false, quota: { max: 2, memory: 1024 }, held: [] } },
    wishful: { cwd: "/srv/w", cmd: "x", boxes: { wanted: true, quota: null, held: [] } },
    plain: { cwd: "/srv/p", cmd: "x", boxes: { wanted: false, quota: null, held: [] } },
  }

  beforeAll(() => {
    writeFileSync(`${dir}/secret`, "stub-secret\n")
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/mcp/auth") return Response.json({ apiKey: "k" })
        if (req.headers.get("x-candy-api-key") !== "k") return Response.json({ error: "unauthorized" }, { status: 401 })
        if (path === "/health" || path === "/status") return Response.json({ pid: 1, routeCount: 1, portalCount: 0 })
        if (path === "/processes") return Response.json({ processes: {} })
        if (path === "/configs") return Response.json({ success: true, configs })
        if (path === "/config/boxes") {
          const body = await req.json() as Record<string, unknown>
          posted.push(body)
          if (body.name === "nope") return Response.json({ error: "no site named nope" }, { status: 404 })
          if (body.off) return Response.json({ success: true, boxes: null, text: "no boxes", wanted: true, sandboxed: true })
          return Response.json({ success: true, boxes: { max: body.max, memory: 4096 }, text: `${body.max} boxes of up to 4G each`, wanted: body.name === "social", sandboxed: body.name !== "unsandboxed" })
        }
        return Response.json({ error: "not found" }, { status: 404 })
      },
    })
  })
  afterAll(() => {
    server?.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  const ansi = /\x1b\[[0-9;]*m/g
  const cli = async (...args: string[]) => {
    const p = Bun.spawn(["bun", CLI, ...args], {
      env: { ...process.env, HOME: "/nonexistent", CANDY_SECRET_FILE: `${dir}/secret`, CANDY_API_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe", stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: out.replace(ansi, ""), err: err.replace(ansi, "") }
  }

  it("sets, and takes off, the operator's quota", async () => {
    posted.length = 0
    const set = await cli("boxes", "social", "12", "4G")
    expect(set.code).toBe(0)
    expect(set.out).toContain("social: 12 boxes of up to 4G each")
    expect(set.out).not.toContain('"boxes": true')
    const mb = await cli("boxes", "unwanted", "2", "1024")
    expect(mb.out).toContain('needs "boxes": true')
    const off = await cli("boxes", "social", "off")
    expect(off.code).toBe(0)
    expect(off.out).toContain("social: no boxes allowed")
    expect(posted).toEqual([{ name: "social", max: 12, memory: "4G" }, { name: "unwanted", max: 2, memory: 1024 }, { name: "social", off: true }])
  })

  it("says the daemon's error and exits 1", async () => {
    const r = await cli("boxes", "nope", "1", "1G")
    expect(r.code).toBe(1)
    expect(r.err).toContain("no site named nope")
  })

  it("refuses arguments it can't use before asking the daemon", async () => {
    posted.length = 0
    for (const args of [["boxes"], ["boxes", "social", "12"], ["boxes", "social", "x", "4G"], ["boxes", "social", "off", "4G"], ["boxes", "social", "-1", "4G"]]) {
      const r = await cli(...args)
      expect(r.code).toBe(1)
      expect(r.err).toContain("Usage: candy boxes")
    }
    expect(posted).toEqual([])
  })

  it("shows the quota, whether candy.json asks, and each box", async () => {
    const r = await cli("boxes", "social")
    expect(r.code).toBe(0)
    expect(r.out).toContain("social: 12 boxes of up to 4G each, 2 held")
    expect(r.out).toContain('asks for them ("boxes": true)')
    expect(r.out).toMatch(/b1 build {2}1\.5G \/ 4G {2}2m old/)
    expect(r.out).toMatch(/b2 {2}\? \/ 512M {2}\d+s old/)

    expect((await cli("boxes", "unwanted")).out).toContain(`needs "boxes": true`)
    expect((await cli("boxes", "wishful")).out).toContain("the operator hasn't allowed any")
    const plain = await cli("boxes", "plain")
    expect(plain.out).toContain("no boxes allowed: set with candy boxes plain <max> <memory>")
    const missing = await cli("boxes", "ghost")
    expect(missing.code).toBe(1)
    expect(missing.err).toContain("No site named ghost")
  })

  it("candy status counts a site's boxes from /configs, and says nothing for the rest", async () => {
    const r = await cli("status")
    expect(r.code).toBe(0)
    expect(r.out).toContain("boxes: 2 of 12")
    expect(r.out.match(/boxes:/g)?.length).toBe(1)
  })

  it("help lists it next to candy mem", async () => {
    const r = await cli("help")
    expect(r.out).toMatch(/candy mem.*\n.*candy boxes <name> \[<max> <memory>\|off\]/)
  })
})
