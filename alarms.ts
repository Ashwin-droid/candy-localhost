// candy alarms: one-off timers a site sets for itself through the SDK (setAlarm), with no
// candy.json entry. When one is due the daemon hands it to the site as the built-in event
// "candy:alarm" through the site's own event queue (daemon.ts), so it wakes a stopped server,
// waits for the answer and retries like any event. This file is the bookkeeping only.
import { cronNext, parseCron } from "./cron.ts"
import { eventData } from "./events.ts"

export const ALARM_EVENT = "alarm"
// Letters, digits and . _ : - ; e.g. "remind:42"
export const ALARM_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
// Alarms one site may have waiting
export const MAX_ALARMS = 256
// How far ahead one may be set
export const MAX_ALARM_AHEAD_MS = 366 * 24 * 60 * 60 * 1000

export interface Alarm {
  name: string
  // ms since the epoch: when it goes off (next)
  at: number
  // A "soft cron" (setCron): goes off at every match of this 5-field schedule, daemon local time,
  // and is set again for the next one each time. Without it the alarm goes off once.
  cron?: string
  // The data it was set with (JSON, at most MAX_EVENT_BYTES)
  data: unknown
  // ms since the epoch: when it was set
  setAt: number
}
/** `event.data` of a "candy:alarm" event */
export type AlarmFired = Alarm

/** When an alarm set now with `when` ({ at } as ms since the epoch or an ISO date, or { in } as ms from now) goes off, or why it can't be set */
export const alarmTime = (when: { at?: unknown; in?: unknown }, now: number): number | { error: string } => {
  let at: number
  if (when.in !== undefined && when.in !== null) {
    if (when.at !== undefined && when.at !== null) return { error: 'give "at" or "in", not both' }
    if (typeof when.in !== "number" || !Number.isFinite(when.in) || when.in < 0) return { error: '"in" must be a number of milliseconds, 0 or more' }
    at = now + when.in
  } else if (typeof when.at === "number") {
    at = when.at
  } else if (typeof when.at === "string") {
    at = Date.parse(when.at)
  } else {
    return { error: 'give "at" (ms since the epoch, or an ISO date) or "in" (ms from now)' }
  }
  if (!Number.isFinite(at)) return { error: `"at" is not a date` }
  if (at - now > MAX_ALARM_AHEAD_MS) return { error: `an alarm can be set at most ${Math.round(MAX_ALARM_AHEAD_MS / 86_400_000)} days ahead` }
  // In the past: it goes off now
  return Math.round(Math.max(at, now))
}

/** The next run of a soft cron after `now`, with the schedule as stored, or why it can't be used */
export const cronAlarmTime = (schedule: unknown, now: number): { at: number; cron: string } | { error: string } => {
  if (typeof schedule !== "string" || !schedule.trim() || schedule.length > 200) return { error: '"cron" must be a schedule: 5 fields (minute hour day-of-month month day-of-week) or @hourly, @daily, ...' }
  const cron = schedule.trim().replace(/\s+/g, " ")
  let next: Date | null
  try { next = cronNext(parseCron(cron), new Date(now)) } catch (e) { return { error: `"cron": ${e instanceof Error ? e.message : String(e)}` } }
  if (!next) return { error: `"cron": "${cron}" never comes round` }
  return { at: next.getTime(), cron }
}

/** Why `name` can't name an alarm, or null */
export const alarmNameProblem = (name: unknown): string | null =>
  typeof name === "string" && ALARM_NAME.test(name) ? null : "an alarm name is 1 to 128 letters, digits, dots, colons, dashes and underscores"

/** Why `data` can't go with an alarm, or its JSON */
export const alarmData = eventData

interface SiteAlarms { user: string; alarms: Map<string, Alarm> }

/**
 * Each site's waiting alarms, by name. Setting a name again moves it. They belong to the site as
 * run by one user: the name in other hands starts with none. The daemon keeps the file and the timer.
 */
export class AlarmStore {
  private bySite = new Map<string, SiteAlarms>()
  constructor(data?: unknown, private max = MAX_ALARMS) {
    if (typeof data !== "object" || data === null) return
    for (const [site, entry] of Object.entries(data as Record<string, unknown>)) {
      const e = entry as { user?: unknown; alarms?: unknown }
      if (typeof e?.user !== "string" || !Array.isArray(e.alarms)) continue
      const alarms = new Map<string, Alarm>()
      for (const a of e.alarms as Partial<Alarm>[]) {
        if (alarmNameProblem(a?.name) || typeof a.at !== "number" || typeof a.setAt !== "number") continue
        if (a.cron !== undefined && typeof a.cron !== "string") continue
        alarms.set(a.name!, { name: a.name!, at: a.at, ...(a.cron ? { cron: a.cron } : {}), data: a.data ?? null, setAt: a.setAt })
      }
      if (alarms.size) this.bySite.set(site, { user: e.user, alarms })
    }
  }

  private mine(site: string, user: string): SiteAlarms | null {
    const s = this.bySite.get(site)
    return s && s.user === user ? s : null
  }

  /** Sets (or moves) one. `replaced`: there was one by that name. */
  set(site: string, user: string, alarm: Alarm): { replaced: boolean } | { error: string } {
    let s = this.mine(site, user)
    if (!s) this.bySite.set(site, s = { user, alarms: new Map() })
    const replaced = s.alarms.has(alarm.name)
    if (!replaced && s.alarms.size >= this.max) return { error: `${site} already has ${this.max} alarms waiting` }
    s.alarms.set(alarm.name, alarm)
    return { replaced }
  }

  /** Whether there was one to cancel */
  cancel(site: string, user: string, name: string): boolean {
    const s = this.mine(site, user)
    if (!s?.alarms.delete(name)) return false
    if (s.alarms.size === 0) this.bySite.delete(site)
    return true
  }

  /** Soonest first */
  list(site: string, user: string): Alarm[] {
    return [...(this.mine(site, user)?.alarms.values() ?? [])].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
  }

  /** When the next one is due, or null */
  next(): number | null {
    let at: number | null = null
    for (const s of this.bySite.values()) for (const a of s.alarms.values()) if (at === null || a.at < at) at = a.at
    return at
  }

  /**
   * Everything due by `now`, oldest first. A one-off leaves; a soft cron stays, set for its next run
   * after `now` (runs missed while candy was down come as this one). One whose schedule no longer
   * comes round leaves too.
   */
  takeDue(now: number): { site: string; user: string; alarm: Alarm }[] {
    const out: { site: string; user: string; alarm: Alarm }[] = []
    for (const [site, s] of this.bySite) {
      for (const a of [...s.alarms.values()]) {
        if (a.at > now) continue
        const next = a.cron ? cronAlarmTime(a.cron, now) : null
        if (next && "at" in next) s.alarms.set(a.name, { ...a, at: next.at })
        else s.alarms.delete(a.name)
        out.push({ site, user: s.user, alarm: a })
      }
      if (s.alarms.size === 0) this.bySite.delete(site)
    }
    return out.sort((a, b) => a.alarm.at - b.alarm.at || a.alarm.setAt - b.alarm.setAt)
  }

  /** The name is gone. Whether it had any. */
  dropSite(site: string): boolean { return this.bySite.delete(site) }

  /** This site's alarms whoever runs it now (the portal's view; `user` says whose they are) */
  ofSite(site: string): { user: string; alarms: Alarm[] } | null {
    const s = this.bySite.get(site)
    return s ? { user: s.user, alarms: this.list(site, s.user) } : null
  }

  toJSON(): Record<string, { user: string; alarms: Alarm[] }> {
    const out: Record<string, { user: string; alarms: Alarm[] }> = {}
    for (const [site, s] of this.bySite) out[site] = { user: s.user, alarms: [...s.alarms.values()] }
    return out
  }
}
