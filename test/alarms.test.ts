import { describe, expect, it } from "bun:test"
import { AlarmStore, alarmTime, cronAlarmTime, alarmNameProblem, MAX_ALARM_AHEAD_MS, type Alarm } from "../alarms.ts"
import { cronNext, parseCron } from "../cron.ts"
import { normalizeManifest } from "../manifest.ts"
import { alarmOf, createRuntime, type RuntimeRecord } from "../sdk-runtime.ts"
import type { CandyEvent } from "../events.ts"

const NOW = new Date(2026, 10, 24, 9, 30, 15).getTime()   // local time: cron is local
const alarm = (name: string, at: number, o: Partial<Alarm> = {}): Alarm => ({ name, at, data: null, setAt: NOW, ...o })

describe("alarm times", () => {
  it("at, in, ISO dates; the past is now", () => {
    expect(alarmTime({ in: 1000 }, NOW)).toBe(NOW + 1000)
    expect(alarmTime({ at: NOW + 5000 }, NOW)).toBe(NOW + 5000)
    expect(alarmTime({ at: new Date(NOW + 60_000).toISOString() }, NOW)).toBe(NOW + 60_000)
    expect(alarmTime({ at: NOW - 99_999 }, NOW)).toBe(NOW)
    expect(alarmTime({ at: 1, in: 1 }, NOW)).toHaveProperty("error")
    expect(alarmTime({ in: -1 }, NOW)).toHaveProperty("error")
    expect(alarmTime({ at: "not a date" }, NOW)).toHaveProperty("error")
    expect(alarmTime({}, NOW)).toHaveProperty("error")
    expect(alarmTime({ in: MAX_ALARM_AHEAD_MS + 1 }, NOW)).toHaveProperty("error")
  })

  it("names", () => {
    expect(alarmNameProblem("remind:42")).toBeNull()
    expect(alarmNameProblem("digest.user-1_x")).toBeNull()
    expect(alarmNameProblem("")).not.toBeNull()
    expect(alarmNameProblem("has space")).not.toBeNull()
    expect(alarmNameProblem(":lead")).not.toBeNull()
    expect(alarmNameProblem("x".repeat(129))).not.toBeNull()
    expect(alarmNameProblem(7)).not.toBeNull()
  })

  it("a soft cron's next run, local time", () => {
    const r = cronAlarmTime("  0 8 * * 1-5 ", NOW)   // Tue 24 Nov 2026 09:30 -> Wed 08:00
    expect(r).toEqual({ at: new Date(2026, 10, 25, 8, 0).getTime(), cron: "0 8 * * 1-5" })
    expect(cronAlarmTime("@hourly", NOW)).toEqual({ at: new Date(2026, 10, 24, 10, 0).getTime(), cron: "@hourly" })
    expect(cronAlarmTime("nope", NOW)).toHaveProperty("error")
    expect(cronAlarmTime("0 0 31 2 *", NOW)).toEqual({ error: `"cron": "0 0 31 2 *" never comes round` })
    expect(cronAlarmTime(5, NOW)).toHaveProperty("error")
  })

  it("cronNext agrees with cronMatches", () => {
    const from = new Date(NOW)
    for (const expr of ["*/7 * * * *", "15 3 * * sun", "0 0 1 * *", "30 12 13 * 5", "0 9 * 2 *", "@yearly"]) {
      const next = cronNext(parseCron(expr), from)!
      // brute force, minute by minute
      const d = new Date(from); d.setSeconds(0, 0)
      let t = d.getTime() + 60_000
      const spec = parseCron(expr)
      const { cronMatches } = require("../cron.ts")
      while (!cronMatches(spec, new Date(t))) t += 60_000
      expect(next.getTime()).toBe(t)
    }
  })
})

describe("AlarmStore", () => {
  it("sets, moves, cancels and lists by site and user", () => {
    const s = new AlarmStore(undefined, 2)
    expect(s.set("bot", "ashwin", alarm("b", NOW + 2000))).toEqual({ replaced: false })
    expect(s.set("bot", "ashwin", alarm("a", NOW + 1000))).toEqual({ replaced: false })
    expect(s.set("bot", "ashwin", alarm("c", NOW))).toHaveProperty("error")   // full
    expect(s.set("bot", "ashwin", alarm("b", NOW + 500))).toEqual({ replaced: true })
    expect(s.list("bot", "ashwin").map(a => a.name)).toEqual(["b", "a"])
    expect(s.list("bot", "bob")).toEqual([])
    expect(s.cancel("bot", "bob", "a")).toBe(false)
    expect(s.cancel("bot", "ashwin", "a")).toBe(true)
    expect(s.cancel("bot", "ashwin", "a")).toBe(false)
    expect(s.next()).toBe(NOW + 500)
    // The name in other hands starts from nothing
    s.set("bot", "bob", alarm("z", NOW + 9))
    expect(s.list("bot", "ashwin")).toEqual([])
    expect(s.ofSite("bot")).toEqual({ user: "bob", alarms: [alarm("z", NOW + 9)] })
  })

  it("hands out what is due; a soft cron stays for its next run", () => {
    const s = new AlarmStore()
    s.set("bot", "ashwin", alarm("once", NOW - 10))
    s.set("bot", "ashwin", alarm("later", NOW + 60_000))
    s.set("bot", "ashwin", alarm("tick", NOW - 5, { cron: "*/5 * * * *" }))
    s.set("web", "ashwin", alarm("gone", NOW - 1, { cron: "0 0 31 2 *" }))
    const due = s.takeDue(NOW)
    expect(due.map(d => `${d.site} ${d.alarm.name}`)).toEqual(["bot once", "bot tick", "web gone"])
    expect(due[1].alarm.at).toBe(NOW - 5)   // the run it was for
    expect(s.list("bot", "ashwin").map(a => [a.name, a.at])).toEqual([
      ["later", NOW + 60_000],
      ["tick", new Date(2026, 10, 24, 9, 35).getTime()],
    ])
    expect(s.ofSite("web")).toBeNull()
    expect(s.takeDue(NOW)).toEqual([])
  })

  it("survives a round trip through JSON, dropping junk", () => {
    const s = new AlarmStore()
    s.set("bot", "ashwin", alarm("a", NOW, { data: { x: 1 } }))
    s.set("bot", "ashwin", alarm("t", NOW, { cron: "@daily" }))
    const back = new AlarmStore(JSON.parse(JSON.stringify(s)))
    expect(back.list("bot", "ashwin")).toEqual(s.list("bot", "ashwin"))
    const junk = new AlarmStore({ bot: { user: "a", alarms: [{ name: "bad name", at: 1, setAt: 1 }, { name: "ok", at: "x" }, { name: "c", at: 1, setAt: 1, cron: 5 }] }, x: 5 })
    expect(junk.ofSite("bot")).toBeNull()
    expect(new AlarmStore("nope").next()).toBeNull()
  })

  it("dropSite", () => {
    const s = new AlarmStore()
    s.set("bot", "ashwin", alarm("a", NOW))
    expect(s.dropSite("bot")).toBe(true)
    expect(s.dropSite("bot")).toBe(false)
  })
})

it("candy.json can't subscribe to candy:alarm: it needs no entry", () => {
  expect(() => normalizeManifest({ sub: ["candy:alarm"] })).toThrow("needs no entry")
})

describe("SDK", () => {
  const record: RuntimeRecord = { token: "tok", site: "bot", url: "http://daemon" }
  const fired = (id: string): CandyEvent => ({ id, from: "candy", event: "alarm", data: alarm("a", NOW, { data: { n: id } }), time: NOW })
  const plain = (id: string): CandyEvent => ({ id, from: "ci", event: "built", data: null, time: NOW })

  it("setAlarm, setCron, cancelAlarm and listAlarms speak /runtime/alarms", async () => {
    const calls: unknown[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      calls.push({ path: new URL(url).pathname, ...body })
      if (body.action === "list") return Response.json({ alarms: [] })
      if (body.action === "cancel") return Response.json({ cancelled: true })
      return Response.json({ alarm: { name: body.name, at: 1, setAt: 1 }, replaced: false })
    }) as unknown as typeof fetch
    const rt = createRuntime(record, fetcher)
    await rt.setAlarm("a", new Date(5000), { x: 1 })
    await rt.setAlarm("b", { in: 60_000 })
    await rt.setAlarm("c", { at: "2027-01-01T00:00:00Z" })
    await rt.setCron("d", "@daily", { u: 1 })
    expect(await rt.cancelAlarm("a")).toBe(true)
    expect(await rt.listAlarms()).toEqual([])
    expect(calls).toEqual([
      { path: "/runtime/alarms", action: "set", name: "a", at: 5000, data: { x: 1 } },
      { path: "/runtime/alarms", action: "set", name: "b", in: 60_000, data: null },
      { path: "/runtime/alarms", action: "set", name: "c", at: "2027-01-01T00:00:00Z", data: null },
      { path: "/runtime/alarms", action: "set", name: "d", cron: "@daily", data: { u: 1 } },
      { path: "/runtime/alarms", action: "cancel", name: "a" },
      { path: "/runtime/alarms", action: "list" },
    ])
    await expect(rt.setAlarm("x", null as never)).rejects.toThrow("needs a time")
  })

  it("one stream for subscribe() and onAlarm(); alarms go to onAlarm, the rest to subscribe", async () => {
    const urls: string[] = []
    const acks: { id: string; ok: boolean; error?: string }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/runtime/ack")) { acks.push(JSON.parse(init.body as string)); return Response.json({ success: true }) }
      urls.push(url)
      if (urls.length > 1) return new Promise(() => {})   // stays open
      return new Response(`${JSON.stringify(fired("1"))}\n${JSON.stringify(plain("2"))}\n`)
    }) as unknown as typeof fetch
    const rt = createRuntime(record, fetcher)
    const alarms: unknown[] = []
    const events: string[] = []
    const a = rt.onAlarm((al, ev) => { alarms.push([al.name, al.data, ev.id]) })
    const s = rt.subscribe(e => { events.push(e.id) })
    await Bun.sleep(30)
    a.close(); s.close()
    expect(urls[0]).toBe("http://daemon/runtime/events?ack=1&parallel=1&alarms=1")
    expect(alarms).toEqual([["a", { n: "1" }, "1"]])
    expect(events).toEqual(["2"])
    expect(acks.sort((x, y) => x.id.localeCompare(y.id))).toEqual([{ id: "1", ok: true }, { id: "2", ok: true }])
  })

  it("an alarm with no onAlarm() goes to subscribe(); an event with no subscribe() fails", async () => {
    const run = async (listen: (rt: ReturnType<typeof createRuntime>, got: string[]) => { close(): void }) => {
      const acks: { id: string; ok: boolean; error?: string }[] = []
      let n = 0
      const fetcher = (async (url: string, init: RequestInit) => {
        if (url.endsWith("/runtime/ack")) { acks.push(JSON.parse(init.body as string)); return Response.json({ success: true }) }
        if (n++) return new Promise(() => {})
        return new Response(`${JSON.stringify(fired("1"))}\n${JSON.stringify(plain("2"))}\n`)
      }) as unknown as typeof fetch
      const got: string[] = []
      const sub = listen(createRuntime(record, fetcher), got)
      await Bun.sleep(30)
      sub.close()
      return { got, acks: acks.sort((x, y) => x.id.localeCompare(y.id)) }
    }
    expect(await run((rt, got) => rt.subscribe(e => { got.push(e.id) }))).toEqual({ got: ["1", "2"], acks: [{ id: "1", ok: true }, { id: "2", ok: true }] })
    expect(await run((rt, got) => rt.onAlarm((_, e) => { got.push(e.id) }))).toEqual({
      got: ["1"],
      acks: [{ id: "1", ok: true }, { id: "2", ok: false, error: "no subscribe() handler in this process" }],
    })
  })

  it("alarmOf", () => {
    expect(alarmOf(fired("1"))?.name).toBe("a")
    expect(alarmOf(plain("2"))).toBeNull()
  })
})
