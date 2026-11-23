// Package C: request filters, tail merging, bodies, and the Data tab helpers (SPEC §5.8, §5.10, §8 C).

import { describe, expect, test } from "bun:test"
import type { CapturedBody, KvListResponse, RequestSummary } from "../../../api/types.ts"
import {
  d1Cell, d1Columns, d1Duration, KV_INITIAL, kvExpires, kvExpiresShort, kvMetadata, kvReducer, type KvState, PARAMS_ERROR, parseParams,
} from "../DataTab.tsx"
import {
  bodyView, durationText, filtersFrom, hasFilters, httpClass, isPartialError, matchesFilters, mergeRequests, parseTail, servedBy,
  TAIL_CAP,
} from "../lib/requests.ts"

const req = (o: Partial<RequestSummary> = {}): RequestSummary => ({
  id: "r1", ts: Date.UTC(2026, 10, 21, 14, 2, 9), fn: "api", host: "api.candy", method: "GET", url: "/api/users?x=1", path: "/api/users",
  clientIp: "127.0.0.1", status: 200, outcome: "ok", cold: false, instance: "i1", queuedMs: 1, ttfbMs: 4, totalMs: 12,
  reqBytes: 0, resBytes: 120, kind: "worker", rule: null, ...o,
})

describe("filters", () => {
  test("Nxx compares the first digit", () => {
    expect(matchesFilters(req({ status: 204 }), { status: "2xx" })).toBe(true)
    expect(matchesFilters(req({ status: 304 }), { status: "2xx" })).toBe(false)
    expect(matchesFilters(req({ status: 503 }), { status: "5xx" })).toBe(true)
    expect(matchesFilters(req({ status: null, outcome: "threw" }), { status: "5xx" })).toBe(false)
  })
  test("path is a prefix", () => {
    expect(matchesFilters(req({ path: "/api/users" }), { path: "/api" })).toBe(true)
    expect(matchesFilters(req({ path: "/static/a.css" }), { path: "/api" })).toBe(false)
  })
  test("kind: Code is the worker, Files the asset folder", () => {
    expect(matchesFilters(req({ kind: "worker" }), { kind: "code" })).toBe(true)
    expect(matchesFilters(req({ kind: "asset" }), { kind: "code" })).toBe(false)
    expect(matchesFilters(req({ kind: "asset" }), { kind: "files" })).toBe(true)
  })
  test("no filter matches everything; filters combine", () => {
    expect(matchesFilters(req(), {})).toBe(true)
    expect(matchesFilters(req({ status: 404, path: "/api/x" }), { status: "4xx", path: "/api", kind: "code" })).toBe(true)
    expect(matchesFilters(req({ status: 404, path: "/x" }), { status: "4xx", path: "/api" })).toBe(false)
  })
  test("filters come from the URL; unknown values are ignored", () => {
    expect(filtersFrom(new URLSearchParams("status=4xx&path=/api&kind=files"))).toEqual({ status: "4xx", path: "/api", kind: "files" })
    expect(filtersFrom(new URLSearchParams("status=9xx&kind=<b>"))).toEqual({ status: "", path: "", kind: "" })
    expect(hasFilters(filtersFrom(new URLSearchParams("")))).toBe(false)
    expect(hasFilters(filtersFrom(new URLSearchParams("path=/a")))).toBe(true)
  })
})

describe("tail merging", () => {
  test("new rows go in front", () => {
    const out = mergeRequests([req({ id: "a" }), req({ id: "b" })], [req({ id: "c" })])
    expect(out.map(r => r.id)).toEqual(["c", "a", "b"])
  })
  test("a row already in the list is not shown twice (the newer copy wins)", () => {
    const out = mergeRequests([req({ id: "a", status: 200 }), req({ id: "b" })], [req({ id: "a", status: 500 })])
    expect(out.map(r => r.id)).toEqual(["a", "b"])
    expect(out[0].status).toBe(500)
  })
  test(`at most ${TAIL_CAP} rows`, () => {
    const rows = Array.from({ length: TAIL_CAP }, (_, i) => req({ id: `old${i}` }))
    const out = mergeRequests(rows, [req({ id: "new1" }), req({ id: "new2" })])
    expect(out.length).toBe(TAIL_CAP)
    expect(out[0].id).toBe("new1")
    expect(out.at(-1)!.id).toBe(`old${TAIL_CAP - 3}`)
  })
  test("parseTail takes a RequestSummary and refuses anything else", () => {
    expect(parseTail(JSON.stringify(req({ id: "z" })))?.id).toBe("z")
    expect(parseTail("not json")).toBe(null)
    expect(parseTail(JSON.stringify({ hello: 1 }))).toBe(null)
  })
})

describe("row text", () => {
  test("status classes", () => {
    expect(httpClass(200)).toBe("2xx")
    expect(httpClass(301)).toBe("3xx")
    expect(httpClass(404)).toBe("4xx")
    expect(httpClass(502)).toBe("5xx")
    expect(httpClass(null)).toBe(null)
    expect(httpClass("?")).toBe(null)
  })
  test("served by and duration", () => {
    expect(servedBy({ kind: "asset" })).toBe("files")
    expect(servedBy({ kind: "worker" })).toBe("code")
    expect(durationText({ totalMs: 12, cold: true, kind: "worker" })).toBe("12 ms, cold")
    expect(durationText({ totalMs: 1250, cold: true, kind: "asset" })).toBe("1.25 s")
  })
  test("a partial-body replay error asks again (the daemon's three messages)", () => {
    expect(isPartialError("request x: body was truncated (9 bytes total); pass allowPartial to replay the captured part")).toBe(true)
    expect(isPartialError("request x: body was not logged (meta mode); pass allowPartial to replay without it")).toBe(true)
    expect(isPartialError("No function named api")).toBe(false)
  })
})

describe("bodyView: every CapturedBody kind", () => {
  const body = (o: Partial<CapturedBody>): CapturedBody => ({ kind: "text", contentType: null, size: 0, truncated: false, text: null, sha256: null, ...o })
  test("text, pretty-printed when JSON", () => {
    const v = bodyView(body({ kind: "text", contentType: "application/json; charset=utf-8", size: 13, text: '{"a":1,"b":[2]}' }))
    expect(v).toEqual({ kind: "text", text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}', notes: ["13 B"] })
  })
  test("text that isn't JSON stays as sent", () => {
    expect(bodyView(body({ contentType: "application/json", size: 3, text: "{x" }))).toEqual({ kind: "text", text: "{x", notes: ["3 B"] })
    expect(bodyView(body({ contentType: "text/plain", size: 5, text: "hello" })).kind).toBe("text")
  })
  test("truncated text has the note", () => {
    const v = bodyView(body({ size: 100000, truncated: true, text: "x".repeat(10) }))
    expect(v.notes).toEqual(["98 KB", "truncated at 64 KB"])
  })
  test("binary", () => {
    const v = bodyView(body({ kind: "binary", size: 2048, sha256: "0123456789abcdef0123456789abcdef" }))
    expect(v).toEqual({ kind: "note", text: "Binary body, stored as size and hash only. sha256 0123456789abcdef…", notes: ["2.0 KB"] })
  })
  test("omitted", () => {
    expect(bodyView(body({ kind: "omitted", size: 10 }))).toEqual({ kind: "note", text: "Not recorded: the request log keeps metadata only.", notes: ["10 B"] })
  })
  test("none and missing", () => {
    expect(bodyView(body({ kind: "none" }))).toEqual({ kind: "note", text: "Empty", notes: [] })
    expect(bodyView(null).text).toBe("Empty")
    expect(bodyView(body({ kind: "text", text: "" })).text).toBe("Empty")
  })
})

describe("Data tab helpers", () => {
  test("D1 cells: NULL, objects as JSON text, values as strings", () => {
    expect(d1Cell(null)).toEqual({ text: "NULL", isNull: true })
    expect(d1Cell(undefined)).toEqual({ text: "NULL", isNull: true })
    expect(d1Cell({ a: [1, "<b>"] })).toEqual({ text: '{"a":[1,"<b>"]}', isNull: false })
    expect(d1Cell([1, 2])).toEqual({ text: "[1,2]", isNull: false })
    expect(d1Cell(0)).toEqual({ text: "0", isNull: false })
    expect(d1Cell("")).toEqual({ text: "", isNull: false })
    expect(d1Cell(false)).toEqual({ text: "false", isNull: false })
  })
  test("D1 columns are the union of row keys in first-seen order", () => {
    expect(d1Columns([{ id: 1, name: "a" }, { id: 2, extra: true }, null, [1]])).toEqual(["id", "name", "extra"])
  })
  test("Values for ? must be a list", () => {
    expect(parseParams("")).toEqual({})
    expect(parseParams(' [1, "a"] ')).toEqual({ params: [1, "a"] })
    expect(parseParams("{}")).toEqual({ error: PARAMS_ERROR })
    expect(parseParams("[1,")).toEqual({ error: PARAMS_ERROR })
    expect(PARAMS_ERROR).toBe('Values for ? go in a list, like [1, "a"]')
  })
  test("KV expirations: seconds or milliseconds", () => {
    const sec = Math.floor(Date.UTC(2026, 10, 21, 12, 0, 0) / 1000)
    expect(kvExpires(sec)).toBe(kvExpires(sec * 1000))
    expect(kvExpires(sec)).toMatch(/2026/)
    expect(kvExpires(undefined)).toBe("—")
    expect(kvExpires(0)).toBe("—")
    expect(kvMetadata({ a: 1 })).toBe('{"a":1}')
    expect(kvMetadata(undefined)).toBe("—")
    const local = new Date(2026, 10, 21, 9, 5, 7).getTime()
    expect(kvExpiresShort(local / 1000, local)).toBe("21 Nov, 09:05")
    expect(kvExpiresShort(local, new Date(2027, 0, 1).getTime())).toBe("21 Nov 2026, 09:05")
    expect(kvExpiresShort(undefined)).toBe("—")
  })
  test("D1 durations keep fractions of a millisecond", () => {
    expect(d1Duration(0.42)).toBe("0.42 ms")
    expect(d1Duration(12.3)).toBe("12 ms")
    expect(d1Duration(0)).toBe("0 ms")
  })
})

describe("KV state", () => {
  const listed = (s: KvState, names: string[], binding = "KV", more = false): KvState =>
    kvReducer(s, { type: "listed", binding, prefix: "", append: false, res: { keys: names.map(name => ({ name })), list_complete: !more, cursor: more ? "c1" : undefined } as KvListResponse })

  test("rows are the loaded array; the same key text twice stays two rows", () => {
    const s = listed(KV_INITIAL, ["<img src=x onerror=alert(1)>", "dup", "dup"])
    expect(s.keys!.map(k => k.name)).toEqual(["<img src=x onerror=alert(1)>", "dup", "dup"])
  })

  test("a put clears the value field and the stale shown value", () => {
    let s = listed(KV_INITIAL, ["a"])
    s = kvReducer(s, { type: "shown", shown: { key: "a", binding: "KV", value: "old" } })
    s = kvReducer(s, { type: "field", putKey: "a", putValue: "new" })
    s = kvReducer(s, { type: "put", key: "a", binding: "KV" })
    expect(s.putValue).toBe("")
    expect(s.putKey).toBe("a")
    expect(s.shown).toBe(null)
    expect(s.status).toEqual({ error: false, text: "Saved a in KV" })
  })

  test("a put of another key keeps the shown value", () => {
    let s = kvReducer(KV_INITIAL, { type: "shown", shown: { key: "a", binding: "KV", value: "v" } })
    s = kvReducer(s, { type: "field", putKey: "b", putValue: "x" })
    s = kvReducer(s, { type: "put", key: "b", binding: "KV" })
    expect(s.shown?.key).toBe("a")
    expect(s.putValue).toBe("")
  })

  test("deleting the shown key clears it; deleting another keeps it", () => {
    let s = kvReducer(KV_INITIAL, { type: "shown", shown: { key: "a", binding: "KV", value: "v" } })
    s = kvReducer(s, { type: "deleted", key: "b", binding: "KV" })
    expect(s.shown?.key).toBe("a")
    s = kvReducer(s, { type: "deleted", key: "a", binding: "KV" })
    expect(s.shown).toBe(null)
    expect(s.status).toEqual({ error: false, text: "Deleted a" })
  })

  test("Edit copies the shown key and value into the put form; a missing value does nothing", () => {
    let s = kvReducer(KV_INITIAL, { type: "shown", shown: { key: "k", binding: "KV", value: "v1" } })
    s = kvReducer(s, { type: "edit" })
    expect([s.putKey, s.putValue]).toEqual(["k", "v1"])
    const t = kvReducer(kvReducer(KV_INITIAL, { type: "shown", shown: { key: "k", binding: "KV", value: null } }), { type: "edit" })
    expect([t.putKey, t.putValue]).toEqual(["", ""])
  })

  test("Load more appends and keeps the cursor until the list is complete", () => {
    let s = listed(KV_INITIAL, ["a", "b"], "KV", true)
    expect(s.complete).toBe(false)
    expect(s.cursor).toBe("c1")
    s = kvReducer(s, { type: "listed", binding: "KV", prefix: "", append: true, res: { keys: [{ name: "c" }], list_complete: true } })
    expect(s.keys!.map(k => k.name)).toEqual(["a", "b", "c"])
    expect(s.complete).toBe(true)
    expect(s.cursor).toBe(undefined)
  })
})
