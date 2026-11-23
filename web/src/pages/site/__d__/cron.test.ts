import { describe, expect, test } from "bun:test"
import { describeCron, formatRun, nextRun } from "../lib/cron.ts"

describe("describeCron (SPEC §5.6 table)", () => {
  const cases: [string, string | null][] = [
    ["* * * * *", "every minute"],
    ["*/5 * * * *", "every 5 minutes"],
    ["*/1 * * * *", "every minute"],
    ["7 * * * *", "every hour at :07"],
    ["30 */2 * * *", "every 2 hours at :30"],
    ["0 3 * * *", "every day at 03:00"],
    ["15 9 * * 1", "every Monday at 09:15"],
    ["15 9 * * mon", "every Monday at 09:15"],
    ["0 18 * * 0", "every Sunday at 18:00"],
    ["0 18 * * 7", "every Sunday at 18:00"],
    ["0 8 * * 1-5", "weekdays at 08:00"],
    ["0 10 * * 0,6", "weekends at 10:00"],
    ["0 10 * * 6,0", "weekends at 10:00"],
    ["5 4 1 * *", "on day 1 of every month at 04:05"],
    ["0 0 25 12 *", "every year on 25 December at 00:00"],
    ["0 0 25 dec *", "every year on 25 December at 00:00"],
    ["@hourly", "every hour at :00"],
    ["@daily", "every day at 00:00"],
    ["@midnight", "every day at 00:00"],
    ["@weekly", "every Sunday at 00:00"],
    ["@monthly", "on day 1 of every month at 00:00"],
    ["@yearly", "every year on 1 January at 00:00"],
    ["@annually", "every year on 1 January at 00:00"],
    // null: shapes the table doesn't cover, and broken expressions
    ["*/7 3-5 * * *", null],
    ["0 3,15 * * *", null],
    ["0 3 * * 1,3", null],
    ["0 3 1 * 1", null],
    ["0 3 1-7 * *", null],
    ["61 * * * *", null],
    ["not a schedule", null],
    ["", null],
  ]
  for (const [expr, want] of cases) test(JSON.stringify(expr), () => expect(describeCron(expr)).toBe(want))
})

describe("nextRun", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s)
  test("0 3 * * * after 03:00 is tomorrow at 03:00", () => {
    expect(nextRun("0 3 * * *", at(2026, 11, 23, 14, 2, 9))?.getTime()).toBe(at(2026, 11, 24, 3, 0).getTime())
  })
  test("0 3 * * * before 03:00 is today at 03:00", () => {
    expect(nextRun("0 3 * * *", at(2026, 11, 23, 1, 30))?.getTime()).toBe(at(2026, 11, 23, 3, 0).getTime())
  })
  test("starts from the next whole minute, never the current one", () => {
    expect(nextRun("* * * * *", at(2026, 11, 23, 14, 2, 0))?.getTime()).toBe(at(2026, 11, 23, 14, 3).getTime())
    expect(nextRun("0 3 * * *", at(2026, 11, 23, 3, 0, 0))?.getTime()).toBe(at(2026, 11, 24, 3, 0).getTime())
  })
  test("every 15 minutes", () => {
    expect(nextRun("*/15 * * * *", at(2026, 11, 23, 14, 2))?.getTime()).toBe(at(2026, 11, 23, 14, 15).getTime())
  })
  test("day of week (2026-11-23 is a Monday)", () => {
    expect(nextRun("0 9 * * fri", at(2026, 11, 23, 12, 0))?.getTime()).toBe(at(2026, 11, 27, 9, 0).getTime())
  })
  test("restricted day-of-month and day-of-week: either matches, as the daemon does", () => {
    // 1st of the month or a Wednesday: Wed 25 Nov comes first
    expect(nextRun("0 0 1 * 3", at(2026, 11, 23, 12, 0))?.getTime()).toBe(at(2026, 11, 25, 0, 0).getTime())
  })
  test("yearly, across the new year", () => {
    expect(nextRun("@yearly", at(2026, 11, 23, 12, 0))?.getTime()).toBe(at(2027, 1, 1, 0, 0).getTime())
  })
  test("null when it never matches within 366 days, or doesn't parse", () => {
    expect(nextRun("0 0 30 2 *", at(2026, 11, 23, 12, 0))).toBeNull()
    expect(nextRun("nope", at(2026, 11, 23, 12, 0))).toBeNull()
    expect(nextRun("0 25 * * *", at(2026, 11, 23, 12, 0))).toBeNull()
  })
})

test("formatRun", () => {
  const now = new Date(2026, 10, 23, 12, 0)
  expect(formatRun(new Date(2026, 10, 24, 3, 0), now)).toBe("Tue 24 Nov, 03:00")
  expect(formatRun(new Date(2027, 0, 1, 0, 0), now)).toBe("Fri 1 Jan 2027, 00:00")
})
