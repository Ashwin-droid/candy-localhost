import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cronMatches, cronScript, LAUNCH_WRAPPER, parseCron, validateCronJob } from "../cron.ts"

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi)

describe("cron schedules", () => {
  it("matches steps, ranges, lists and names", () => {
    const every15 = parseCron("*/15 * * * *")
    expect(cronMatches(every15, at(2026, 11, 9, 10, 30))).toBe(true)
    expect(cronMatches(every15, at(2026, 11, 9, 10, 31))).toBe(false)

    const weekdays9to5 = parseCron("0 9-17 * * mon-fri")
    expect(cronMatches(weekdays9to5, at(2026, 11, 9, 9, 0))).toBe(true)   // Monday
    expect(cronMatches(weekdays9to5, at(2026, 11, 8, 9, 0))).toBe(false)  // Sunday
    expect(cronMatches(weekdays9to5, at(2026, 11, 9, 18, 0))).toBe(false)

    expect(cronMatches(parseCron("5/20 * * * *"), at(2026, 1, 1, 0, 45))).toBe(true)
    expect(cronMatches(parseCron("0 0 * * 7"), at(2026, 11, 8, 0, 0))).toBe(true)  // 7 = Sunday
    expect(cronMatches(parseCron("@daily"), at(2026, 3, 4, 0, 0))).toBe(true)
    expect(cronMatches(parseCron("0 12 1 jan,jul *"), at(2026, 7, 1, 12, 0))).toBe(true)
  })

  it("uses OR when both day fields are set", () => {
    const spec = parseCron("0 0 13 * fri")
    expect(cronMatches(spec, at(2026, 11, 13, 0, 0))).toBe(true)  // the 13th
    expect(cronMatches(spec, at(2026, 11, 6, 0, 0))).toBe(true)   // a Friday
    expect(cronMatches(spec, at(2026, 11, 7, 0, 0))).toBe(false)
  })

  it("rejects bad schedules", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "* * * * * *", "a b c d e", "1-2-3 * * * *"]) {
      expect(() => parseCron(bad)).toThrow()
    }
  })
})

describe("cron jobs", () => {
  it("validates names, args and timeouts", () => {
    expect(validateCronJob({ name: "sync", schedule: "@hourly", args: ["--sync"] })).toEqual({ ok: true, job: { name: "sync", schedule: "@hourly", args: ["--sync"] } })
    expect(validateCronJob({ name: "bad name", schedule: "@hourly" }).ok).toBe(false)
    expect(validateCronJob({ name: "x", schedule: "nope" }).ok).toBe(false)
    expect(validateCronJob({ name: "x", schedule: "@hourly", args: "--sync" }).ok).toBe(false)
    expect(validateCronJob({ name: "x", schedule: "@hourly", args: [1] }).ok).toBe(false)
    expect(validateCronJob({ name: "x", schedule: "@hourly", args: ["a\nrm -rf ~"] }).ok).toBe(false)
    expect(validateCronJob({ name: "x", schedule: "@hourly", timeoutSec: 0 }).ok).toBe(false)
    expect(validateCronJob({ name: "x", schedule: "@hourly", timeoutSec: 600 })).toMatchObject({ ok: true, job: { timeoutSec: 600 } })
  })

  const hostile = ["--sync", "; touch pwned1", "&& touch pwned2", "|| touch pwned3", "$(touch pwned4)", "`touch pwned5`", "'; touch pwned6; '", "a b", "*"]

  it("passes args to the base command as plain text, never as shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candy-cron-"))
    const proc = Bun.spawn(["bash", "-c", cronScript(`printf '%s\\n'`), "candy", ...hostile], { cwd: dir, stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out.split("\n").slice(0, -1)).toEqual(hostile)
    expect(await readdir(dir)).toEqual([])
  })

  it("keeps args plain through the root launch wrapper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candy-cron-"))
    const proc = Bun.spawn(
      ["bash", "-c", LAUNCH_WRAPPER, "candy", dir, cronScript(`printf '%s\\n'`), "candy", ...hostile],
      { cwd: "/", stdout: "pipe", stderr: "ignore", env: { ...process.env, HOME: dir } },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out.split("\n").slice(0, -1)).toEqual(hostile)
    expect(await readdir(dir)).toEqual([])
  })

  it("leaves a normal server start unchanged through the wrapper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "candy-cron-"))
    const proc = Bun.spawn(["bash", "-c", LAUNCH_WRAPPER, "candy", dir, "pwd; echo $#"], { cwd: "/", stdout: "pipe", stderr: "ignore", env: { ...process.env, HOME: dir } })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out.trim().split("\n")).toEqual([dir, "0"])
  })
})
