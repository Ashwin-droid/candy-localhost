// Client-side validation with the old dashboard's exact messages (01 §5, §7.3). null = ok, string = the error.
// Empty input is "ok" wherever the field is optional (it means "the usual value" or "none"); the caller
// decides when a field is required.

const WHOLE = /^\d+$/

/** Site names: letters, numbers and dashes (the daemon lower-cases). */
export function checkName(v: string): string | null {
  const s = v.trim()
  if (!s) return "Enter a name"
  return /^[a-zA-Z0-9-]+$/.test(s) ? null : "Use letters, numbers and dashes only"
}

/** A whole port in [min, max] (default 1-65535). Required: empty is an error. */
export function checkPort(v: string, min = 1, max = 65535): string | null {
  const s = v.trim()
  const n = Number(s)
  if (!WHOLE.test(s) || !Number.isInteger(n) || n < min || n > max) return `Enter a port between ${min} and ${max}`
  return null
}

/** Idle minutes: empty (the usual) or a whole number. */
export function checkMinutes(v: string): string | null {
  const s = v.trim()
  return s === "" || WHOLE.test(s) ? null : "Enter a number of minutes"
}

/** An absolute path: empty (none) or starting with "/". `what` names it: "env file". */
export function checkAbsPath(v: string, what?: string): string | null {
  const s = v.trim()
  if (s === "" || s.startsWith("/")) return null
  return what ? `Use the full path of the ${what}, starting with /` : "Use the full path, starting with /"
}

const MEMORY_MAX_MB = 16 * 1024

/**
 * Memory limit text. Returns null for empty (the usual 2G), the limit in MB as a number when valid
 * ("4G" -> 4096, "512M" -> 512, "1536" -> 1536 MB), or the error message as a string.
 * Send the number as `memory` to POST /config/memory (the daemon takes MB numbers as well as "4G").
 */
export function parseMemory(v: string): number | string | null {
  const s = v.trim().toUpperCase().replace(/\s+/g, "")
  if (s === "") return null
  const m = /^(\d+(?:\.\d+)?)(G|GB|M|MB)?$/.exec(s)
  if (!m) return "Enter a size like 4G or 512M"
  const n = Number(m[1])
  const unit = m[2] ?? "M"
  const mb = Math.round(unit.startsWith("G") ? n * 1024 : n)
  if (mb < 1) return "Enter a size like 4G or 512M"
  if (mb > MEMORY_MAX_MB) return "At most 16G"
  return mb
}

/** A whole number >= min: "<Label> must be a whole number, <min> or more". Empty is ok (the usual value). */
export function checkWhole(v: string, label: string, min: number): string | null {
  const s = v.trim()
  if (s === "") return null
  const n = Number(s)
  return WHOLE.test(s) && Number.isInteger(n) && n >= min ? null : `${label} must be a whole number, ${min} or more`
}
