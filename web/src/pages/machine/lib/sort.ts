// Sorting and filtering for the Machine tables (portal.html sysSort / sysRender). Pure: no DOM.
//
// The kit Table sorts with `column.sort(a, b) * dir` and falls back to the incoming order, so the comparators
// below take the direction too and undo it for the parts that must not flip: processes tie by pid ascending,
// services keep failed ones first.

import type { SystemProcess, SystemStats } from "../../../api/types.ts"
import type { SortDir, SystemUnit } from "../types.ts"

export const PROCESS_KEYS = ["pid", "user", "cpu", "mem", "unit", "name"] as const
export const UNIT_KEYS = ["unit", "processes", "cpu", "mem"] as const
export type ProcessKey = (typeof PROCESS_KEYS)[number]
export type UnitKey = (typeof UNIT_KEYS)[number]

const TEXT = new Set(["name", "user", "unit"])
/** Text columns sort ascending first, numbers descending. */
export const defaultDir = (key: string): SortDir => (TEXT.has(key) ? 1 : -1)

function cmpField(x: unknown, y: unknown): number {
  if (typeof x === "string" || typeof y === "string") return String(x ?? "").localeCompare(String(y ?? ""))
  return (Number(x) || 0) - (Number(y) || 0)
}

/** For Table column.sort: by key in `dir`, ties by pid ascending whatever the direction. */
export function processComparator(key: ProcessKey, dir: SortDir): (a: SystemProcess, b: SystemProcess) => number {
  return (a, b) => cmpField(a[key], b[key]) || (a.pid - b.pid) * dir
}

/** For Table column.sort: failed units first whatever the direction, then by key in `dir`. */
export function unitComparator(key: UnitKey, dir: SortDir): (a: SystemUnit, b: SystemUnit) => number {
  return (a, b) => ((b.failed ? 1 : 0) - (a.failed ? 1 : 0)) * dir || cmpField(a[key], b[key])
}

/** What the Table shows, as a plain function (tests): the comparator times dir. */
export function sortProcesses(rows: SystemProcess[], key: ProcessKey, dir: SortDir): SystemProcess[] {
  const c = processComparator(key, dir)
  return [...rows].sort((a, b) => c(a, b) * dir)
}
export function sortUnits(rows: SystemUnit[], key: UnitKey, dir: SortDir): SystemUnit[] {
  const c = unitComparator(key, dir)
  return [...rows].sort((a, b) => c(a, b) * dir)
}

/** Filter matches pid, user, name, cmd and unit. */
export function filterProcesses(rows: SystemProcess[], q: string): SystemProcess[] {
  const n = q.trim().toLowerCase()
  if (!n) return rows
  return rows.filter(p => `${p.pid} ${p.user} ${p.name} ${p.cmd} ${p.unit || ""}`.toLowerCase().includes(n))
}

/** Filter matches the unit and its candy site. */
export function filterUnits(rows: SystemUnit[], q: string, candy: SystemStats["candy"]): SystemUnit[] {
  const n = q.trim().toLowerCase()
  if (!n) return rows
  return rows.filter(u => `${u.unit} ${candy?.[u.unit] || ""}`.toLowerCase().includes(n))
}

/** `?sort=cpu` or `?sort=-cpu` / `?sort=+user`: a known key and a direction (its default when unsigned). */
export function parseSort<K extends string>(v: string | null, keys: readonly K[], fallback: [K, SortDir]): [K, SortDir] {
  if (!v) return fallback
  const sign = v[0] === "-" ? -1 : v[0] === "+" ? 1 : 0
  const key = (sign ? v.slice(1) : v) as K
  if (!keys.includes(key)) return fallback
  return [key, sign ? (sign as SortDir) : defaultDir(key)]
}

/** The `?sort=` value for a key and direction (unsigned when it is the key's default). */
export function sortParam(key: string, dir: SortDir): string {
  return dir === defaultDir(key) ? key : `${dir === 1 ? "+" : "-"}${key}`
}
