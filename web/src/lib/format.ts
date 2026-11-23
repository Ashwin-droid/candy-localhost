// Formatters (01 §1.4, ported from public/portal.html with the same output). Pure: no DOM.

/** "3d 4h", "2h 5m", "7m" */
export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

/** Like formatUptime, but seconds under a minute ("42s"). */
export function formatUptimeShort(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  return s < 60 ? `${s}s` : formatUptime(s)
}

/** Megabytes. Strict (limits): "2G" only for whole half-gigabytes, else "512M". Loose (usage): "1.3G", "82M". */
export function fmtMb(mb: number, loose?: boolean): string {
  if (loose) return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(/\.0$/, "")}G` : `${Math.max(1, Math.round(mb))}M`
  return mb >= 1024 && mb % 512 === 0 ? `${mb / 1024}G` : `${Math.round(mb)}M`
}

/** "512 B", "3.4 KB", "88 KB", "1.2 MB" */
export function fmtBytes(n: number): string {
  n = Number(n)
  if (!Number.isFinite(n)) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Machine sizes: B/K/M/G/T, one decimal under 100 ("1.5G", "512M", "0"). */
export function sysBytes(n: number): string {
  if (!(n > 0)) return "0"
  const u = ["B", "K", "M", "G", "T"]
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`
}

/** "840 ms", "1.25 s" */
export function fmtMs(n: number): string {
  n = Number(n)
  if (!Number.isFinite(n)) return ""
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

/** Local 24h clock "14:02:09" ("14:02:09.123" with ms). "" for an invalid time. */
export function fmtClock(t: number | string, ms?: boolean): string {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ""
  const s = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return ms ? `${s}.${pad(d.getMilliseconds(), 3)}` : s
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Full local date and time, "21 Nov 2026, 14:02:09". "" for an invalid time. */
export function fmtDate(t: number | string): string {
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ""
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${fmtClock(d.getTime())}`
}

/** "1 request", "1,234 requests" */
export function plural(n: number, word: string): string {
  return `${Number(n).toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`
}

/** /home/alice/projects/x -> ~/projects/x */
export function shortPath(p: string): string {
  return String(p || "").replace(/^\/home\/[^/]+/, "~")
}

/**
 * "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago", "21 Nov"; future times read
 * "in 5 min", "in 2 h", "tomorrow", "in 3 days". `t` is ms since the epoch or a date string.
 */
export function relTime(t: number | string, now: number = Date.now()): string {
  const at = new Date(t).getTime()
  if (Number.isNaN(at)) return ""
  const diff = now - at
  const future = diff < 0
  const s = Math.abs(diff) / 1000
  if (s < 45) return future ? "in a moment" : "just now"
  const m = Math.round(s / 60)
  if (m < 60) return future ? `in ${m} min` : `${m} min ago`
  const h = Math.round(s / 3600)
  if (h < 24) return future ? `in ${h} h` : `${h} h ago`
  const d = Math.round(s / 86400)
  if (d === 1) return future ? "tomorrow" : "yesterday"
  if (d < 7) return future ? `in ${d} days` : `${d} days ago`
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${sameYear ? "" : ` ${date.getFullYear()}`}`
}
