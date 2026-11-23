import { describe, expect, test } from "bun:test"
import { collectSites } from "../../lib/site.ts"
import { config, route } from "../../test/fixtures.ts"
import { renderWith } from "../../test/render.tsx"
import ActivityPage from "./ActivityPage.tsx"
import { actionLabel, dayLabel, filterEntries, groupByDay, hhmm, linkSites, parseCount } from "./lib.ts"

const NOW = new Date(2026, 10, 23, 15, 0).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()

describe("activity lib", () => {
  test("action labels", () => {
    expect(actionLabel("ADD")).toBe("Add")
    expect(actionLabel("SITE_PORT_SET")).toBe("Site port set")
    expect(actionLabel("")).toBe("")
  })
  test("day labels", () => {
    expect(dayLabel(new Date(2026, 10, 23, 1).getTime(), NOW)).toBe("Today")
    expect(dayLabel(new Date(2026, 10, 22, 23).getTime(), NOW)).toBe("Yesterday")
    expect(dayLabel(new Date(2026, 10, 21, 9).getTime(), NOW)).toBe("21 Nov")
    expect(dayLabel(new Date(2025, 0, 3).getTime(), NOW)).toBe("3 Jan 2025")
  })
  test("HH:MM, 24h", () => {
    expect(hhmm(new Date(2026, 10, 23, 9, 5).getTime())).toBe("09:05")
    expect(hhmm(new Date(2026, 10, 23, 21, 40).getTime())).toBe("21:40")
  })
  test("newest first, with a date row per day", () => {
    const items = groupByDay([
      { time: at(21, 9), action: "ADD", details: "a" },
      { time: at(23, 10), action: "ADD", details: "b" },
      { time: at(23, 14), action: "CLOSE", details: "c" },
    ], NOW)
    expect(items.map(i => (i.kind === "day" ? `#${i.label}` : i.details))).toEqual(["#Today", "c", "b", "#21 Nov", "a"])
  })
  test("filter over action words and details", () => {
    const e = [{ time: at(23, 1), action: "PORTAL", details: "api -> https://x" }, { time: at(23, 2), action: "ADD", details: "web" }]
    expect(filterEntries(e, "portal").length).toBe(1)
    expect(filterEntries(e, "WEB").length).toBe(1)
    expect(filterEntries(e, " ").length).toBe(2)
  })
  test("site names in details become links, with or without the TLD", () => {
    const names = new Set(["api", "my.app"])
    expect(linkSites("api.localhost -> :3000", names)).toEqual([{ text: "api.localhost", site: "api" }, { text: " -> :3000" }])
    expect(linkSites("my.app -> https://my.trycloudflare.com", names)[0]).toEqual({ text: "my.app", site: "my.app" })
    expect(linkSites("apiary -> :1", names)).toEqual([{ text: "apiary -> :1" }])
  })
  test("count param", () => {
    expect(parseCount(null)).toBe(200)
    expect(parseCount("40")).toBe(40)
    expect(parseCount("1000")).toBe(1000)
    expect(parseCount("7")).toBe(200)
  })
})

describe("ActivityPage render", () => {
  const sites = collectSites({ routes: { api: route(3000) }, configs: { success: true, configs: { api: config() } } })
  test("rows, links and escaping", () => {
    const html = renderWith(<ActivityPage />, {
      route: "/activity",
      resources: {
        sites,
        "activity:200": { total: 2, logs: [
          { time: new Date().toISOString(), action: "ADD", details: "api.localhost -> :3000" },
          { time: new Date().toISOString(), action: "RENAME", details: "<img src=x onerror=alert(1)>" },
        ] },
      },
    })
    expect(html).toContain("Today")
    expect(html).toContain('href="/sites/api"')
    expect(html).toContain("Rename")
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
    expect(html).toContain("Last 1,000")
  })
  test("empty", () => {
    const html = renderWith(<ActivityPage />, { route: "/activity", resources: { sites: [], "activity:200": { total: 0, logs: [] } } })
    expect(html).toContain("Nothing yet. Sites added, renamed, started or shared show up here.")
  })
  test("the count comes from the URL", () => {
    const html = renderWith(<ActivityPage />, { route: "/activity?count=40", resources: { sites: [], "activity:40": { total: 0, logs: [] } } })
    expect(html).toContain("Nothing yet.")
  })
})
