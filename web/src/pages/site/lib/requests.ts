// The Requests tab's model (SPEC §5.8). Pure: no DOM, no fetch.

import type { CapturedBody, RequestSummary } from "../../../api/types.ts"
import { fmtBytes, fmtMs } from "../../../lib/format.ts"

export const TAIL_CAP = 500

export type StatusFilter = "" | "2xx" | "3xx" | "4xx" | "5xx"
export type KindFilter = "" | "code" | "files"
export interface RequestFilters { status: StatusFilter; path: string; kind: KindFilter }

export const STATUS_FILTERS: readonly StatusFilter[] = ["", "2xx", "3xx", "4xx", "5xx"]
export const KIND_FILTERS: readonly KindFilter[] = ["", "code", "files"]

/** Filters from the URL; anything unknown is "any". */
export function filtersFrom(q: { get(k: string): string | null }): RequestFilters {
  const s = q.get("status") ?? ""
  const k = q.get("kind") ?? ""
  return {
    status: (STATUS_FILTERS as readonly string[]).includes(s) ? s as StatusFilter : "",
    path: q.get("path") ?? "",
    kind: (KIND_FILTERS as readonly string[]).includes(k) ? k as KindFilter : "",
  }
}

export const hasFilters = (f: RequestFilters): boolean => !!(f.status || f.path || f.kind)

/**
 * The same matching as the server's list (01 §13.2 `fnMatches`), for rows that arrive on the live tail:
 * "Nxx" compares the first digit of the status, any other status filter is exact; the path is a prefix.
 * Kind is client-side only (Code = the worker, Files = the asset folder).
 */
export function matchesFilters(r: RequestSummary, f: Partial<RequestFilters>): boolean {
  if (f.status) {
    if (r.status === null || r.status === undefined) return false
    const s = String(r.status)
    if (/^[1-5]xx$/.test(f.status)) { if (s[0] !== f.status[0]) return false }
    else if (s !== f.status) return false
  }
  if (f.path && !String(r.path ?? "").startsWith(f.path)) return false
  if (f.kind === "code" && r.kind !== "worker") return false
  if (f.kind === "files" && r.kind !== "asset") return false
  return true
}

/**
 * Put rows that just arrived (newest first) in front of the list. A row that is already there is replaced
 * by its newer copy, never shown twice; the list keeps at most `cap` rows.
 */
export function mergeRequests(rows: readonly RequestSummary[], incoming: readonly RequestSummary[], cap = TAIL_CAP): RequestSummary[] {
  const seen = new Set<string>()
  const out: RequestSummary[] = []
  for (const r of [...incoming, ...rows]) {
    if (!r || typeof r.id !== "string" || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
    if (out.length >= cap) break
  }
  return out
}

/** A tail event's data as a RequestSummary, or null when it isn't one. */
export function parseTail(data: string): RequestSummary | null {
  try {
    const r = JSON.parse(data) as RequestSummary
    return r && typeof r === "object" && typeof r.id === "string" ? r : null
  } catch { return null }
}

export type HttpClass = "2xx" | "3xx" | "4xx" | "5xx" | "other"

/** Which dot a status gets: 2xx mint, 3xx ring, 4xx lemon, 5xx cherry. */
export function httpClass(status: number | string | null | undefined): HttpClass | null {
  if (status === null || status === undefined || status === "" || status === "?") return null
  const d = String(status)[0]
  return d === "2" || d === "3" || d === "4" || d === "5" ? `${d}xx` as HttpClass : "other"
}

/** "Served by" in the list: files from the asset folder, or the code. */
export const servedBy = (r: Pick<RequestSummary, "kind">): string => (r.kind === "asset" ? "files" : "code")

/** "12 ms", "1.25 s, cold" (cold only for the worker). */
export function durationText(r: Pick<RequestSummary, "totalMs" | "cold" | "kind">): string {
  return fmtMs(r.totalMs) + (r.cold && r.kind === "worker" ? ", cold" : "")
}

export type BodyView =
  | { kind: "text"; text: string; notes: string[] }
  | { kind: "note"; text: string; notes: string[] }

/**
 * How a captured body shows: its text (pretty JSON when the content type says JSON), or one sentence for a
 * binary, unrecorded or empty body. Notes: the size and "truncated at 64 KB".
 */
export function bodyView(b: CapturedBody | null | undefined): BodyView {
  if (!b) return { kind: "note", text: "Empty", notes: [] }
  const notes: string[] = []
  if (b.size > 0) notes.push(fmtBytes(b.size))
  if (b.truncated) notes.push("truncated at 64 KB")
  switch (b.kind) {
    case "text": {
      if (b.text === null || b.text === "") return { kind: "note", text: "Empty", notes }
      let text = b.text
      if (/json/i.test(b.contentType ?? "") && !b.truncated) {
        try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* not valid JSON: as sent */ }
      }
      return { kind: "text", text, notes }
    }
    case "binary":
      return { kind: "note", text: `Binary body, stored as size and hash only.${b.sha256 ? ` sha256 ${b.sha256.slice(0, 16)}…` : ""}`, notes }
    case "omitted":
      return { kind: "note", text: "Not recorded: the request log keeps metadata only.", notes }
    default:
      return { kind: "note", text: "Empty", notes }
  }
}

/** A replay error that /fn/replay would accept with allowPartial (a body cut off, hashed or not kept). */
export const isPartialError = (message: string): boolean => /truncat|partial/i.test(message)
