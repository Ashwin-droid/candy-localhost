import { describe, expect, test } from "bun:test"
import { parseSse } from "../api/stream.ts"
import { parseAnsi } from "../lib/ansi.ts"
import { parseDeepLink, rootHashRedirect, settingsHashRedirect } from "../lib/deeplinks.ts"
import { fmtBytes, fmtClock, fmtDate, fmtMb, fmtMs, formatUptime, formatUptimeShort, plural, relTime, shortPath, sysBytes } from "../lib/format.ts"
import { checkAbsPath, checkMinutes, checkName, checkPort, checkWhole, parseMemory } from "../lib/validate.ts"

describe("format", () => {
  test("uptime", () => {
    expect(formatUptime(3 * 86400 + 4 * 3600 + 59)).toBe("3d 4h")
    expect(formatUptime(2 * 3600 + 5 * 60)).toBe("2h 5m")
    expect(formatUptime(59)).toBe("0m")
    expect(formatUptime(-5)).toBe("0m")
    expect(formatUptimeShort(42)).toBe("42s")
    expect(formatUptimeShort(120)).toBe("2m")
  })
  test("fmtMb", () => {
    expect(fmtMb(2048)).toBe("2G")
    expect(fmtMb(1536)).toBe("1.5G")
    expect(fmtMb(1500)).toBe("1500M")
    expect(fmtMb(512)).toBe("512M")
    expect(fmtMb(1331, true)).toBe("1.3G")
    expect(fmtMb(2048, true)).toBe("2G")
    expect(fmtMb(0.2, true)).toBe("1M")
    expect(fmtMb(81.6, true)).toBe("82M")
  })
  test("bytes, ms, sysBytes", () => {
    expect(fmtBytes(512)).toBe("512 B")
    expect(fmtBytes(3500)).toBe("3.4 KB")
    expect(fmtBytes(90000)).toBe("88 KB")
    expect(fmtBytes(1258291)).toBe("1.2 MB")
    expect(fmtBytes(NaN)).toBe("")
    expect(fmtMs(840.4)).toBe("840 ms")
    expect(fmtMs(1250)).toBe("1.25 s")
    expect(sysBytes(0)).toBe("0")
    expect(sysBytes(512)).toBe("512B")
    expect(sysBytes(1536)).toBe("1.5K")
    expect(sysBytes(200 * 1024 * 1024)).toBe("200M")
    expect(sysBytes(1.5 * 1024 ** 3)).toBe("1.5G")
  })
  test("clock and date", () => {
    const t = new Date(2026, 10, 21, 14, 2, 9, 7).getTime()
    expect(fmtClock(t)).toBe("14:02:09")
    expect(fmtClock(t, true)).toBe("14:02:09.007")
    expect(fmtClock("nope")).toBe("")
    expect(fmtDate(t)).toBe("21 Nov 2026, 14:02:09")
  })
  test("plural, shortPath", () => {
    expect(plural(1, "request")).toBe("1 request")
    expect(plural(1234, "request")).toBe("1,234 requests")
    expect(plural(0, "site")).toBe("0 sites")
    expect(shortPath("/home/alice/projects/x")).toBe("~/projects/x")
    expect(shortPath("/srv/x")).toBe("/srv/x")
  })
  test("relTime", () => {
    const now = new Date(2026, 10, 23, 12, 0, 0).getTime()
    expect(relTime(now - 10_000, now)).toBe("just now")
    expect(relTime(now - 3 * 60_000, now)).toBe("3 min ago")
    expect(relTime(now - 2 * 3600_000, now)).toBe("2 h ago")
    expect(relTime(now - 86400_000, now)).toBe("yesterday")
    expect(relTime(now - 4 * 86400_000, now)).toBe("4 days ago")
    expect(relTime(new Date(2026, 10, 1).getTime(), now)).toBe("1 Nov")
    expect(relTime(new Date(2025, 0, 2).getTime(), now)).toBe("2 Jan 2025")
    expect(relTime(now + 5 * 60_000, now)).toBe("in 5 min")
    expect(relTime(now + 86400_000, now)).toBe("tomorrow")
  })
})

describe("validate (01 §5 / §7.3 messages)", () => {
  test("names", () => {
    expect(checkName("my-app2")).toBeNull()
    expect(checkName("My-App")).toBeNull()
    expect(checkName("a.b")).toBe("Use letters, numbers and dashes only")
    expect(checkName("a b")).toBe("Use letters, numbers and dashes only")
    expect(checkName("")).toBe("Enter a name")
  })
  test("ports", () => {
    expect(checkPort("3000")).toBeNull()
    expect(checkPort("0")).toBe("Enter a port between 1 and 65535")
    expect(checkPort("70000")).toBe("Enter a port between 1 and 65535")
    expect(checkPort("3.5")).toBe("Enter a port between 1 and 65535")
    expect(checkPort("")).toBe("Enter a port between 1 and 65535")
    expect(checkPort("80", 1024, 65535)).toBe("Enter a port between 1024 and 65535")
    expect(checkPort("8443", 1024, 65535)).toBeNull()
  })
  test("minutes, paths, whole numbers", () => {
    expect(checkMinutes("")).toBeNull()
    expect(checkMinutes("15")).toBeNull()
    expect(checkMinutes("1.5")).toBe("Enter a number of minutes")
    expect(checkAbsPath("")).toBeNull()
    expect(checkAbsPath("/x/.env")).toBeNull()
    expect(checkAbsPath("x/.env")).toBe("Use the full path, starting with /")
    expect(checkAbsPath("~/x", "env file")).toBe("Use the full path of the env file, starting with /")
    expect(checkWhole("", "Hot", 0)).toBeNull()
    expect(checkWhole("2", "Hot", 0)).toBeNull()
    expect(checkWhole("-1", "Hot", 0)).toBe("Hot must be a whole number, 0 or more")
    expect(checkWhole("0", "Max", 1)).toBe("Max must be a whole number, 1 or more")
    expect(checkWhole("1.5", "Linger", 0)).toBe("Linger must be a whole number, 0 or more")
  })
  test("parseMemory", () => {
    expect(parseMemory("")).toBeNull()
    expect(parseMemory(" 4G ")).toBe(4096)
    expect(parseMemory("512m")).toBe(512)
    expect(parseMemory("1.5G")).toBe(1536)
    expect(parseMemory("1536")).toBe(1536)
    expect(parseMemory("17G")).toBe("At most 16G")
    expect(parseMemory("lots")).toBe("Enter a size like 4G or 512M")
  })
})

describe("deep links", () => {
  test("?add with and without a name", () => {
    expect(parseDeepLink("?add")).toEqual({ kind: "add", name: null })
    expect(parseDeepLink("?add=")).toEqual({ kind: "add", name: null })
    expect(parseDeepLink("?add=MyApp")).toEqual({ kind: "add", name: "myapp" })
    expect(parseDeepLink("?add=<x>")).toEqual({ kind: "add", name: null })
  })
  test("?logs and ?bind", () => {
    expect(parseDeepLink("?logs=api")).toEqual({ kind: "logs", name: "api" })
    expect(parseDeepLink("?logs=../x")).toBeNull()
    expect(parseDeepLink("?bind")).toEqual({ kind: "bind", name: null })
    expect(parseDeepLink("?bind=blog")).toEqual({ kind: "bind", name: "blog" })
    expect(parseDeepLink("")).toBeNull()
    expect(parseDeepLink("?q=x")).toBeNull()
  })
  test("old settings anchors", () => {
    expect(settingsHashRedirect("#passkeys")).toBe("/settings/passkeys")
    expect(settingsHashRedirect("#signin")).toBe("/settings/sign-in")
    expect(settingsHashRedirect("#domains")).toBe("/public")
    expect(settingsHashRedirect("#daemon")).toBe("/settings/daemon")
    expect(settingsHashRedirect("#account")).toBeNull()
    expect(settingsHashRedirect("")).toBeNull()
  })
  test("old candy:// handler anchors on /", () => {
    expect(rootHashRedirect("/", "#routes")).toBe("/sites")
    expect(rootHashRedirect("/", "#STATS")).toBe("/machine")
    expect(rootHashRedirect("/", "#other")).toBeNull()
    expect(rootHashRedirect("/", "")).toBeNull()
    expect(rootHashRedirect("/sites", "#routes")).toBeNull()
  })
})

describe("ansi", () => {
  test("the class table", () => {
    expect(parseAnsi("\x1b[31mred\x1b[0m plain")).toEqual([{ text: "red", cls: "fg-red" }, { text: " plain", cls: "" }])
    expect(parseAnsi("\x1b[92mg")).toEqual([{ text: "g", cls: "fg-green" }])
    expect(parseAnsi("\x1b[1;34mb\x1b[22mn\x1b[39mx")).toEqual([{ text: "b", cls: "fg-blue b" }, { text: "n", cls: "fg-blue" }, { text: "x", cls: "" }])
    expect(parseAnsi("\x1b[2md")).toEqual([{ text: "d", cls: "dim" }])
    expect(parseAnsi("\x1b[38;5;1ma\x1b[38;5;9mb\x1b[38;5;46mc\x1b[38;5;196md")).toEqual([
      { text: "ab", cls: "fg-red" }, { text: "c", cls: "fg-green" }, { text: "d", cls: "fg-red" }])
    expect(parseAnsi("\x1b[38;2;250;250;250mw")).toEqual([{ text: "w", cls: "fg-white" }])
    expect(parseAnsi("\x1b[38;5;244mg")[0].cls).toMatch(/^fg-(white|black)$/)
  })
  test("drops everything else and never emits markup or escapes", () => {
    const segs = parseAnsi("\x1b[41;4;5;7mx\x1b]0;title\x07y\x1b[2K\x1b[1Az\x1b(B<img src=x onerror=alert(1)>\x1b[m")
    expect(segs.map(s => s.text).join("")).toBe("xyz<img src=x onerror=alert(1)>")
    for (const s of segs) {
      expect(s.text.includes("\x1b")).toBe(false)
      for (const c of s.cls.split(" ").filter(Boolean)) expect(["fg-black", "fg-red", "fg-green", "fg-yellow", "fg-blue", "fg-magenta", "fg-cyan", "fg-white", "b", "dim"]).toContain(c)
    }
    expect(parseAnsi("")).toEqual([])
    expect(parseAnsi("\x1b[31")).toEqual([])
  })
})

describe("parseSse", () => {
  test("blocks, events, multi-line data, comments, carry", () => {
    let r = parseSse("data: a\n\nevent: status\ndata: {\"status\":\"running\"}\n\n: ping\n\ndata: x\ndata: y\n\ndata: par", "")
    expect(r.events).toEqual([
      { event: "message", data: "a" },
      { event: "status", data: "{\"status\":\"running\"}" },
      { event: "message", data: "x\ny" },
    ])
    expect(r.carry).toBe("data: par")
    r = parseSse("tial\n\n", r.carry)
    expect(r.events).toEqual([{ event: "message", data: "partial" }])
    expect(r.carry).toBe("")
    expect(parseSse("data:nospace\r\n\r\n", "").events).toEqual([{ event: "message", data: "nospace" }])
    expect(parseSse("event: x\n\n", "").events).toEqual([])
  })
})
