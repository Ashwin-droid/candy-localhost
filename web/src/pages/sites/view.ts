// Pure helpers of the Sites page (SPEC §5.1): the summary sentence, the filter, sorting, the row action and the
// view state kept in the URL and in localStorage.candy_sites_view. No DOM.

import { fmtMb, plural } from "../../lib/format.ts"
import { primaryAddress, type Site, type SiteKind } from "../../lib/site.ts"

const MB = 1048576

export type KindFilter = "all" | SiteKind
export type OwnerFilter = "mine" | "all"
export type SortKey = "name" | "status" | "requests" | "memory"
export interface SitesView { q: string; kind: KindFilter; owner: OwnerFilter; sort: SortKey; dir: 1 | -1 }

export const DEFAULT_VIEW: SitesView = { q: "", kind: "all", owner: "all", sort: "name", dir: 1 }
export const VIEW_STORAGE_KEY = "candy_sites_view"
export const VIEW_PARAMS = ["q", "kind", "owner", "sort", "dir"] as const

const KINDS: readonly KindFilter[] = ["all", "server", "function", "static", "forward"]
const SORTS: readonly SortKey[] = ["name", "status", "requests", "memory"]

export const KIND_WORD: Record<SiteKind, string> = { server: "Server", function: "Function", static: "Static", forward: "Forward" }
export const KIND_PLURAL: Record<KindFilter, string> = { all: "All", server: "Servers", function: "Functions", static: "Static", forward: "Forwards" }

/** The view from a query string (unknown values fall back to the defaults). */
export function viewFromQuery(q: URLSearchParams): SitesView {
  const kind = q.get("kind") as KindFilter | null
  const owner = q.get("owner")
  const sort = q.get("sort") as SortKey | null
  return {
    q: q.get("q") ?? "",
    kind: kind && KINDS.includes(kind) ? kind : "all",
    owner: owner === "mine" ? "mine" : "all",
    sort: sort && SORTS.includes(sort) ? sort : "name",
    dir: q.get("dir") === "desc" ? -1 : 1,
  }
}

/** Writes the non-default parts of a view into `q` (and removes the default ones). */
export function viewToQuery(v: SitesView, q: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(q)
  const put = (k: string, val: string | null) => { if (val === null) out.delete(k); else out.set(k, val) }
  put("q", v.q.trim() ? v.q : null)
  put("kind", v.kind === "all" ? null : v.kind)
  put("owner", v.owner === "all" ? null : v.owner)
  put("sort", v.sort === "name" ? null : v.sort)
  put("dir", v.dir === -1 ? "desc" : null)
  return out
}

export const hasViewParams = (q: URLSearchParams): boolean => VIEW_PARAMS.some(k => q.has(k))

/** The stored view, or null. Accepts only the known fields. */
export function parseStoredView(raw: string | null): SitesView | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== "object") return null
    const q = new URLSearchParams()
    for (const k of VIEW_PARAMS) if (typeof o[k] === "string" || typeof o[k] === "number") q.set(k, String(o[k]))
    if (o.dir === -1) q.set("dir", "desc")
    return viewFromQuery(q)
  } catch { return null }
}

export function serializeView(v: SitesView): string {
  return JSON.stringify({ q: v.q, kind: v.kind, owner: v.owner, sort: v.sort, dir: v.dir === -1 ? "desc" : "asc" })
}

/** "14 sites, 5 running, 1 quick tunnel open" */
export function summary(sites: Site[]): string {
  const running = sites.filter(s => s.proc?.status === "running").length
  const tunnels = sites.filter(s => s.portal).length
  let out = `${plural(sites.length, "site")}, ${running} running`
  if (tunnels) out += `, ${plural(tunnels, "quick tunnel")} open`
  return out
}

/** Text a filter matches: name, address, kind word and owner. */
export function matchesText(s: Site, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const hay = [s.name, primaryAddress(s).text, KIND_WORD[s.kind], s.owner ?? ""].join(" ").toLowerCase()
  return needle.split(/\s+/).every(w => hay.includes(w))
}

export function filterSites(sites: Site[], v: Pick<SitesView, "q" | "kind" | "owner">, viewer: string, ownerFilter: boolean): Site[] {
  return sites.filter(s =>
    (v.kind === "all" || s.kind === v.kind)
    && (!ownerFilter || v.owner === "all" || s.owner === viewer || s.owner === null)
    && matchesText(s, v.q))
}

export function kindCounts(sites: Site[]): Record<KindFilter, number> {
  const c: Record<KindFilter, number> = { all: sites.length, server: 0, function: 0, static: 0, forward: 0 }
  for (const s of sites) c[s.kind]++
  return c
}

/** Whether the owner column and the Mine / Everyone filter apply: a superuser who sees someone else's site. */
export function showsOwners(sites: Site[] | undefined, superuser: boolean, viewer: string): boolean {
  return superuser && !!sites?.some(s => s.owner !== null && s.owner !== viewer)
}

const STATE_RANK: Record<string, number> = { crashed: 0, starting: 1, running: 2, stopped: 3, idle: 4, external: 5 }

export const byName = (a: Site, b: Site): number => a.name.localeCompare(b.name)
/** Crashed first, then starting, running, stopped, idle, external. */
export const byStatus = (a: Site, b: Site): number => (STATE_RANK[a.status.state] ?? 9) - (STATE_RANK[b.status.state] ?? 9) || byName(a, b)
/** Most requests first (ascending in the header = the busiest on top). */
export const byRequests = (a: Site, b: Site): number => (b.traffic?.total ?? -1) - (a.traffic?.total ?? -1) || byName(a, b)
export const byMemory = (a: Site, b: Site): number => (memoryBytes(b) ?? -1) - (memoryBytes(a) ?? -1) || byName(a, b)

/** Memory in use by an active process (bytes), else null. */
export function memoryBytes(s: Site): number | null {
  return s.active && s.proc?.memoryUsed ? s.proc.memoryUsed : null
}

/** The Memory column: "182M", titled "of 2G limit". */
export function memoryCell(s: Site): { text: string; title?: string } {
  const used = memoryBytes(s)
  if (used === null) return { text: "—" }
  const max = s.proc?.memoryMax
  return { text: fmtMb(used / MB, true), title: max ? `of ${fmtMb(Math.round(max / MB))} limit` : undefined }
}

/** The Status column: "N warm" for a routed function with hot instances, else the status label. */
export function statusText(s: Site): string {
  if (s.kind === "function" && s.fn?.hasWorker && s.fn.hot > 0 && s.route && !s.proc) return `${s.fn.hot} warm`
  return s.status.label
}

/** A crashed process: errored, or dead with an exit code (not a function). */
export function isCrashed(s: Site): boolean {
  if (s.fn || !s.proc) return false
  return s.proc.status === "errored" || (s.proc.status === "dead" && s.proc.exitCode !== null && s.proc.exitCode !== undefined)
}

/** The one row action of §5.1: Stop for an active site, Restart for a crashed one, Start, or nothing. */
export function rowAction(s: Site): "stop" | "restart" | "start" | null {
  if (s.active) return "stop"
  if (isCrashed(s)) return "restart"
  if (!s.fn && (s.proc || s.config)) return "start"
  return null
}

/** Dismissed attention keys (localStorage.candy_dismissed): a JSON array of strings. */
export function parseDismissed(raw: string | null): string[] {
  if (!raw) return []
  try {
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").slice(-200) : []
  } catch { return [] }
}
