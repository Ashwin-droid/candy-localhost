// Cron schedules as the daemon reads them (SPEC §5.6). The parser is the daemon's own root cron.ts, so the
// portal never disagrees with what actually runs. Pure: no DOM.

import { cronMatches, parseCron } from "../../../../../cron.ts"

const MINUTE = 60_000
const HORIZON_MS = 366 * 24 * 60 * MINUTE

/**
 * The next time `expr` fires after `from`, in local time (the daemon checks each local minute). Steps minute
 * by minute from the next whole minute, up to 366 days. null when the expression doesn't parse or never
 * matches in that window.
 */
export function nextRun(expr: string, from: Date): Date | null {
  let spec
  try { spec = parseCron(expr) } catch { return null }
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  let t = d.getTime() + MINUTE
  const end = from.getTime() + HORIZON_MS
  while (t <= end) {
    const at = new Date(t)
    // Skips that can't change the answer: a wrong month skips the day, a wrong hour skips the hour
    if (!spec.month.has(at.getMonth() + 1)) {
      const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)
      t = next.getTime()
      continue
    }
    if (!spec.hour.has(at.getHours())) {
      const next = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1)
      t = Math.max(next.getTime(), t + MINUTE)
      continue
    }
    if (cronMatches(spec, at)) return at
    t += MINUTE
  }
  return null
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
}
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const MONTH_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

const pad = (n: number) => String(n).padStart(2, "0")
/** A plain number field within [min, max], else null. */
function num(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null
  const n = Number(field)
  return n >= min && n <= max ? n : null
}
function dayOf(field: string): number | null {
  const n = num(field, 0, 7)
  if (n !== null) return n % 7
  const i = DAY_SHORT.indexOf(field.toLowerCase())
  return i >= 0 ? i : null
}
function monthOf(field: string): number | null {
  const n = num(field, 1, 12)
  if (n !== null) return n - 1
  const i = MONTH_SHORT.indexOf(field.toLowerCase())
  return i >= 0 ? i : null
}
const WEEKDAYS = new Set(["1-5", "mon-fri"])
const WEEKENDS = new Set(["0,6", "6,0", "sat,sun", "sun,sat", "6,7", "7,6"])

/**
 * A plain reading of the common schedule shapes ("every day at 03:00"), or null for anything else, in which
 * case the UI shows only the expression. The `@` macros read as the schedule they stand for.
 */
export function describeCron(expr: string): string | null {
  const raw = expr.trim()
  if (!raw) return null
  try { parseCron(raw) } catch { return null }
  const text = MACROS[raw.toLowerCase()] ?? raw
  const f = text.split(/\s+/)
  if (f.length !== 5) return null
  const [mi, h, dom, mo, dow] = f

  if (h === "*" && dom === "*" && mo === "*" && dow === "*") {
    if (mi === "*") return "every minute"
    const step = /^\*\/(\d+)$/.exec(mi)
    if (step) {
      const n = Number(step[1])
      return n === 1 ? "every minute" : `every ${n} minutes`
    }
    const m = num(mi, 0, 59)
    return m === null ? null : `every hour at :${pad(m)}`
  }

  const m = num(mi, 0, 59)
  if (m === null) return null
  if (dom === "*" && mo === "*" && dow === "*") {
    const step = /^\*\/(\d+)$/.exec(h)
    if (step) {
      const n = Number(step[1])
      return n === 1 ? `every hour at :${pad(m)}` : `every ${n} hours at :${pad(m)}`
    }
  }
  const hour = num(h, 0, 23)
  if (hour === null) return null
  const at = `${pad(hour)}:${pad(m)}`

  if (dom === "*" && mo === "*") {
    if (dow === "*") return `every day at ${at}`
    const low = dow.toLowerCase()
    if (WEEKDAYS.has(low)) return `weekdays at ${at}`
    if (WEEKENDS.has(low)) return `weekends at ${at}`
    const d = dayOf(dow)
    return d === null ? null : `every ${DAY_NAMES[d]} at ${at}`
  }
  if (dow !== "*") return null
  const day = num(dom, 1, 31)
  if (day === null) return null
  if (mo === "*") return `on day ${day} of every month at ${at}`
  const month = monthOf(mo)
  return month === null ? null : `every year on ${day} ${MONTH_NAMES[month]} at ${at}`
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** A next run as people read it: "Tue 24 Nov, 03:00" (the year only when it isn't this one). */
export function formatRun(d: Date, now: Date = new Date()): string {
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`
  return `${SHORT_DAYS[d.getDay()]} ${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The viewer's time zone name ("Europe/London"), or "local time" when the runtime can't say. */
export function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time" } catch { return "local time" }
}
