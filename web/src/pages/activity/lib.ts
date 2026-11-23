// Pure helpers for the Activity page: labels, day groups, the filter and site links in details. No DOM.

import { fmtDate } from "../../lib/format.ts"
import { COUNTS, type ActivityEntry, type ActivityItem, type Count, type DetailPart } from "./types.ts"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const pad = (n: number) => String(n).padStart(2, "0")

/** "SITE_ADD" -> "Site add": lower-cased, "_" to a space, first letter capitalised. */
export function actionLabel(action: string): string {
  const s = String(action || "").toLowerCase().replace(/_/g, " ").trim()
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/** Local 24h "HH:MM". */
export function hhmm(at: number): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? "" : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime() }

/** "Today", "Yesterday", "21 Nov", or "21 Nov 2025" for another year. */
export function dayLabel(at: number, now: number): string {
  const day = dayStart(at), today = dayStart(now)
  if (day === today) return "Today"
  // a day before today's midnight (DST-safe: compare calendar days, not 24h steps)
  const y = new Date(today); y.setDate(y.getDate() - 1)
  if (day === y.getTime()) return "Yesterday"
  const d = new Date(at)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? "" : ` ${d.getFullYear()}`}`
}

/** Client-side filter over the action (as shown and as sent) and the details. */
export function filterEntries(entries: ActivityEntry[], q: string): ActivityEntry[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return entries
  return entries.filter(e => `${e.action} ${actionLabel(e.action)} ${e.details}`.toLowerCase().includes(needle))
}

/**
 * Newest first, with a date row before the first entry of each day. The daemon sends the oldest first.
 * Entries with an unreadable time go under one "Unknown date" heading at the end.
 */
export function groupByDay(entries: ActivityEntry[], now: number): ActivityItem[] {
  const rows = entries
    .map((e, i) => ({ e, i, at: new Date(e.time).getTime() }))
    .reverse()
  const out: ActivityItem[] = []
  let current: string | null = null
  for (const { e, i, at } of rows) {
    const valid = !Number.isNaN(at)
    const label = valid ? dayLabel(at, now) : "Unknown date"
    if (label !== current) {
      current = label
      out.push({ kind: "day", key: `day:${label}`, label, title: valid ? fmtDate(dayStart(at)).replace(/, .*$/, "") : "" })
    }
    out.push({ kind: "entry", key: `e:${i}:${e.time}`, at, time: e.time, action: e.action, details: e.details })
  }
  return out
}

// A name-like token: what a site name looks like, plus a trailing ".localhost" / ".candy" in details such as
// "api.localhost -> :3000".
const TOKEN = /[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]|[A-Za-z0-9]/g

/** Splits details into text and the names of visible sites (which the page renders as links). */
export function linkSites(details: string, names: ReadonlySet<string>): DetailPart[] {
  const text = String(details ?? "")
  if (!names.size || !text) return text ? [{ text }] : []
  const out: DetailPart[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0]
    const lower = tok.toLowerCase()
    const site = names.has(lower) ? lower : lower.replace(/\.(localhost|candy)$/, "")
    if (!names.has(site)) continue
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ text: tok, site })
    last = at + tok.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** The count from `?count=`, or 200. */
export function parseCount(v: string | null): Count {
  const n = Number(v)
  return (COUNTS as readonly number[]).includes(n) ? (n as Count) : 200
}
