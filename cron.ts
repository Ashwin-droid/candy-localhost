// Cron jobs for managed servers. A job runs the server's own command with
// extra arguments the app chose through the SDK. The base command can't be
// changed, and the arguments never pass through a shell parser: they are
// handed to bash as positional parameters and expanded with "$@".

export interface CronJob {
  name: string
  schedule: string
  args: string[]
  timeoutSec?: number
}

export const MAX_CRON_JOBS = 16
export const MAX_CRON_ARGS = 32
export const MAX_CRON_ARG_LENGTH = 1024
export const DEFAULT_CRON_TIMEOUT_S = 60 * 60
export const MAX_CRON_TIMEOUT_S = 24 * 60 * 60
export const CRON_JOB_ENV = "CANDY_CRON_JOB"

const JOB_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

// ---------------------------------------------------------------------------
// Schedule: standard 5-field cron (minute hour day-of-month month day-of-week)
// ---------------------------------------------------------------------------

export interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const parseField = (field: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> => {
  const value = (s: string): number => {
    const named = names?.indexOf(s.toLowerCase()) ?? -1
    if (named >= 0) return named + nameBase
    if (!/^\d+$/.test(s)) throw new Error(`'${s}' is not a number`)
    const n = Number(s)
    if (n < min || n > max) throw new Error(`${n} is outside ${min}-${max}`)
    return n
  }
  const out = new Set<number>()
  for (const part of field.split(",")) {
    const [range, stepText, extra] = part.split("/")
    if (extra !== undefined || range === "") throw new Error(`bad field '${field}'`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in '${part}'`)
    let lo: number, hi: number
    if (range === "*") { lo = min; hi = max }
    else if (range.includes("-")) {
      const [a, b, more] = range.split("-")
      if (more !== undefined) throw new Error(`bad range '${range}'`)
      lo = value(a); hi = value(b)
      if (lo > hi) throw new Error(`bad range '${range}'`)
    } else {
      lo = value(range)
      hi = stepText === undefined ? lo : max  // "5/15" means 5, 20, 35, 50
    }
    for (let n = lo; n <= hi; n += step) out.add(n)
  }
  return out
}

export const parseCron = (expr: string): CronSpec => {
  const text = (MACROS[expr.trim().toLowerCase()] ?? expr).trim()
  const fields = text.split(/\s+/)
  if (fields.length !== 5) throw new Error("A schedule has 5 fields: minute hour day-of-month month day-of-week")
  const [mi, h, dom, mo, dow] = fields
  const dowSet = parseField(dow, 0, 7, DAYS)
  if (dowSet.has(7)) { dowSet.delete(7); dowSet.add(0) }  // 7 is Sunday too
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mo, 1, 12, MONTHS, 1),
    dow: dowSet,
    domAny: dom === "*",
    dowAny: dow === "*",
  }
}

// Classic cron: when both day fields are restricted, either one matching is enough.
export const cronMatches = (spec: CronSpec, d: Date): boolean => {
  if (!spec.minute.has(d.getMinutes()) || !spec.hour.has(d.getHours()) || !spec.month.has(d.getMonth() + 1)) return false
  const domOk = spec.dom.has(d.getDate())
  const dowOk = spec.dow.has(d.getDay())
  if (spec.domAny && spec.dowAny) return true
  if (spec.domAny) return dowOk
  if (spec.dowAny) return domOk
  return domOk || dowOk
}

// ---------------------------------------------------------------------------
// Validation and command building
// ---------------------------------------------------------------------------

export type CronValidation = { ok: true; job: CronJob } | { ok: false; error: string }

export const validateCronJob = (input: unknown): CronValidation => {
  if (!input || typeof input !== "object") return { ok: false, error: "job must be an object" }
  const { name, schedule, args = [], timeoutSec } = input as Record<string, unknown>
  if (typeof name !== "string" || !JOB_NAME.test(name)) {
    return { ok: false, error: "name: 1-64 letters, numbers, dashes or underscores" }
  }
  if (typeof schedule !== "string") return { ok: false, error: "schedule is required" }
  try { parseCron(schedule) } catch (e) { return { ok: false, error: `schedule: ${(e as Error).message}` } }
  if (!Array.isArray(args) || args.length > MAX_CRON_ARGS) {
    return { ok: false, error: `args must be a list of at most ${MAX_CRON_ARGS} strings` }
  }
  for (const a of args) {
    if (typeof a !== "string") return { ok: false, error: "every arg must be a string" }
    if (a.length > MAX_CRON_ARG_LENGTH) return { ok: false, error: `args are limited to ${MAX_CRON_ARG_LENGTH} characters` }
    if (CONTROL_CHARS.test(a)) return { ok: false, error: "args can't contain control characters or newlines" }
  }
  const job: CronJob = { name, schedule: schedule.trim(), args: [...args] as string[] }
  if (timeoutSec !== undefined) {
    if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_CRON_TIMEOUT_S) {
      return { ok: false, error: `timeoutSec must be a whole number from 1 to ${MAX_CRON_TIMEOUT_S}` }
    }
    job.timeoutSec = timeoutSec
  }
  return { ok: true, job }
}

// The script bash runs for a job: the base command, then the job's args as
// "$@". The args travel as separate argv entries after the script, so `;`,
// `&&`, `|`, `$(...)` and quotes in them are plain text to the program.
export const cronScript = (baseCmd: string): string => `${baseCmd} "$@"`

// As root, the daemon runs `setpriv ... -- bash -c LAUNCH_WRAPPER candy <cwd> <script> [candy <args>...]`:
// cd as the target user, then run the script in an interactive bash with the
// remaining argv as its $0 and "$@".
export const LAUNCH_WRAPPER = 'cd -- "$1" || exit 126; s=$2; shift 2; exec bash -ic "$s" "$@"'
