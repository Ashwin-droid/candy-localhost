// Requests tab (SPEC §5.8). Owned by package C.
// Functions and static sites: the request log (/fn/requests), a live tail (/fn/tail) and the detail pane.
// Servers and forwards: candy's access log (/traffic/<name>).

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { getApi } from "../../api/client.ts"
import { useResource } from "../../api/resources.ts"
import { KEYS, useStats } from "../../api/sites.ts"
import { useStream } from "../../api/stream.ts"
import type { RequestSummary, TrafficResponse } from "../../api/types.ts"
import { fmtClock, fmtDate, plural } from "../../lib/format.ts"
import type { Site, TabProps } from "../../lib/site.ts"
import { navigate, useRoute } from "../../router.tsx"
import { Button, type Column, EmptyState, Input, Section, Segmented, StatusDot, Table } from "../../ui/index.ts"
import { HttpStatus, RequestDetail } from "./RequestDetail.tsx"
import {
  durationText, filtersFrom, hasFilters, type KindFilter, matchesFilters, mergeRequests, parseTail, type RequestFilters,
  servedBy, type StatusFilter,
} from "./lib/requests.ts"
import "./requests.css"

interface RequestsList { success: true; requests: RequestSummary[] }

const STATUS_OPTIONS: { value: StatusFilter | "any"; label: string }[] = [
  { value: "any", label: "Any" }, { value: "2xx", label: "2xx" }, { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx" }, { value: "5xx", label: "5xx" },
]
const KIND_OPTIONS: { value: KindFilter | "any"; label: string }[] = [
  { value: "any", label: "Any" }, { value: "code", label: "Code" }, { value: "files", label: "Files" },
]

/** Replace some query params of the current URL, keeping the rest (and the path). */
function setQuery(changes: Record<string, string | null>): void {
  if (typeof location === "undefined") return
  const q = new URLSearchParams(location.search)
  for (const [k, v] of Object.entries(changes)) { if (v) q.set(k, v); else q.delete(k) }
  const s = q.toString()
  navigate(location.pathname + (s ? `?${s}` : ""), { replace: true })
}

export const requestColumns: Column<RequestSummary>[] = [
  { key: "time", label: "Time", width: "84px", render: r => <span className="tnum nowrap" title={fmtDate(r.ts)}>{fmtClock(r.ts)}</span> },
  { key: "status", label: "Status", width: "76px", render: r => <HttpStatus status={r.status} outcome={r.outcome} /> },
  { key: "request", label: "Request", mono: true, render: r => <span className="req-line" title={r.url}><span className="req-method">{r.method}</span> {r.path}</span> },
  { key: "served", label: "Served by", priority: 3, width: "92px", render: r => <span title={r.rule ? `Rule ${r.rule}` : undefined}>{servedBy(r)}</span> },
  { key: "duration", label: "Duration", align: "right", priority: 2, width: "110px", render: r => <span className="tnum nowrap">{durationText(r)}</span> },
]

function FnRequests(p: { site: Site }): React.JSX.Element {
  const { name } = p.site
  const route = useRoute()
  const id = route.params.id ?? null
  const filters: RequestFilters = filtersFrom(route.query)
  const qs = route.query.toString()
  const base = `/sites/${encodeURIComponent(name)}/requests`
  const hrefFor = (rid: string) => `${base}/${encodeURIComponent(rid)}${qs ? `?${qs}` : ""}`

  // path prefix: typed here, in the URL 300 ms later
  const [pathDraft, setPathDraft] = useState(filters.path)
  useEffect(() => { setPathDraft(filters.path) }, [filters.path])
  useEffect(() => {
    if (pathDraft === filters.path) return
    const t = setTimeout(() => setQuery({ path: pathDraft || null }), 300)
    return () => clearTimeout(t)
  }, [pathDraft, filters.path])

  const key = `fn/requests:${name}?status=${filters.status}&path=${filters.path}`
  const list = useResource<RequestsList>(key, signal => getApi().get<RequestsList>("/fn/requests",
    { name, status: filters.status || undefined, path: filters.path || undefined, limit: 200 }, { signal }))

  // rows = the loaded list plus what the tail added since it loaded (newest first, de-duplicated, capped)
  const [tail, setTail] = useState<RequestSummary[]>([])
  const [pending, setPending] = useState<RequestSummary[]>([])
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  useEffect(() => { setTail([]); setPending([]) }, [list.data])
  const loaded = list.data ? (Array.isArray(list.data.requests) ? list.data.requests : []) : undefined
  const rows = loaded ? mergeRequests(loaded, tail) : undefined

  // new rows wait while a row is open or the list is scrolled down
  const scroller = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const check = () => {
      const el = scroller.current
      if (!el) return
      setScrolled(el.scrollTop > 8 || el.getBoundingClientRect().top < -8)
    }
    window.addEventListener("scroll", check, { passive: true })
    return () => window.removeEventListener("scroll", check)
  }, [])
  const hold = useRef(false)
  hold.current = !!id || scrolled
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t) }, [])
  const flash = (ids: string[]) => {
    setFresh(s => new Set([...s, ...ids]))
    const t = setTimeout(() => {
      timers.current.delete(t)
      setFresh(s => { const n = new Set(s); for (const i of ids) n.delete(i); return n })
    }, 1200)
    timers.current.add(t)
  }

  const live = useStream(list.data ? "/fn/tail" : null, { name }, {
    retryMs: 3000,
    onEvent: e => {
      if (e.event !== "message") return
      const r = parseTail(e.data)
      if (!r || !matchesFilters(r, { status: filtersRef.current.status, path: filtersRef.current.path })) return
      if (hold.current) setPending(ps => mergeRequests(ps, [r]))
      else { setTail(ts => mergeRequests(ts, [r])); flash([r.id]) }
    },
  })

  const showPending = () => {
    setTail(ts => mergeRequests(ts, pending))
    flash(pending.map(r => r.id))
    setPending([])
    scroller.current?.scrollTo({ top: 0 })
    if (scroller.current && scroller.current.getBoundingClientRect().top < 0) scroller.current.scrollIntoView({ block: "start" })
  }

  const shown = rows?.filter(r => matchesFilters(r, { kind: filters.kind }))
  const lamp = live === "live" ? { state: "running" as const, label: "Live" }
    : live === "connecting" && list.data ? { state: "starting" as const, label: "Connecting…" }
    : { state: "idle" as const, label: "Paused" }
  const filtered = hasFilters(filters)
  const columns = requestColumns.map(c => c.key === "time"
    ? { ...c, render: (r: RequestSummary, i: number) => <>{fresh.has(r.id) ? <span className="req-fresh" aria-hidden="true" /> : null}{requestColumns[0].render(r, i)}</> }
    : c)

  return (
    <div className={id ? "reqs has-detail" : "reqs"}>
      <div className="reqs-list">
        <Section title="Requests" description="The request log keeps the last 24 hours."
          actions={<span className="reqs-live" title="New requests appear as they finish"><StatusDot state={lamp.state} label={lamp.label} showLabel /></span>}>
          <div className="reqs-filters" role="group" aria-label="Filters">
            <Segmented label="Status" options={STATUS_OPTIONS} value={filters.status || "any"}
              onChange={v => setQuery({ status: v === "any" ? null : v })} />
            <Segmented label="Served by" options={KIND_OPTIONS} value={filters.kind || "any"}
              onChange={v => setQuery({ kind: v === "any" ? null : v })} />
            <Input className="reqs-path" mono value={pathDraft} placeholder="Path starts with…" aria-label="Path starts with"
              spellCheck={false} autoComplete="off" onChange={e => setPathDraft(e.target.value)} />
          </div>
          {pending.length ? (
            <div className="reqs-pending">
              <Button size="sm" onClick={showPending}>{plural(pending.length, "new request")}</Button>
            </div>
          ) : null}
          <div className="reqs-scroll" ref={scroller}
            onScroll={e => setScrolled(e.currentTarget.scrollTop > 8 || e.currentTarget.getBoundingClientRect().top < -8)}>
            <Table<RequestSummary> label={`Requests to ${name}`} columns={columns} rows={shown} rowKey={r => r.id}
              rowHref={r => hrefFor(r.id)} selectedKey={id}
              loading={list.loading} error={list.error ? `Couldn’t load requests: ${list.error.message}` : null} onRetry={() => void list.reload()}
              empty={filtered ? "No requests match." : "No requests in the last 24 hours. Open the site and they show up here as they finish."} />
          </div>
        </Section>
      </div>
      <div className="reqs-detail">
        {id ? (
          <RequestDetail key={id} name={name} id={id} hrefFor={hrefFor} backHref={`${base}${qs ? `?${qs}` : ""}`} />
        ) : (
          <EmptyState>Pick a request to see its headers, bodies, logs and timings.</EmptyState>
        )}
      </div>
    </div>
  )
}

type TrafficRow = TrafficResponse["logs"][number]

const trafficColumns: Column<TrafficRow>[] = [
  { key: "time", label: "Time", width: "84px", render: r => (r.time ? <span className="tnum" title={fmtDate(r.time)}>{fmtClock(r.time)}</span> : "—") },
  { key: "status", label: "Status", width: "76px", render: r => <HttpStatus status={r.status} /> },
  { key: "method", label: "Method", width: "84px", mono: true, priority: 2, render: r => r.method },
  { key: "path", label: "Path", mono: true, render: r => <span className="req-line" title={r.path}>{r.path}</span> },
  { key: "via", label: "Via", width: "80px", priority: 3, render: r => (r.isTunnel ? "tunnel" : "direct") },
]

function TrafficRequests(p: { site: Site }): React.JSX.Element {
  const { name } = p.site
  const r = useResource<TrafficResponse>(KEYS.traffic(name),
    signal => getApi().get<TrafficResponse>("/traffic/" + encodeURIComponent(name), { count: 100 }, { signal }), { every: 15_000 })
  const stats = useStats()
  const total = stats.data?.domains?.find(d => d.name === name)?.total
  // the access log comes oldest first; show the newest at the top
  const rows = r.data ? [...(Array.isArray(r.data.logs) ? r.data.logs : [])].reverse() : undefined
  return (
    <Section title="Requests" description="From candy’s access log. Bodies and timings are recorded for functions only."
      actions={total !== undefined ? <span className="ink-2 small tnum">{plural(total, "request")} in total</span> : undefined}>
      <Table<TrafficRow> label={`Requests to ${name}`} columns={trafficColumns} rows={rows} rowKey={(_, i) => String(i)}
        loading={r.loading} error={r.error ? `Couldn’t load requests: ${r.error.message}` : null} onRetry={() => void r.reload()}
        empty="No requests yet." />
    </Section>
  )
}

export default function RequestsTab(p: TabProps): React.JSX.Element {
  return p.site.fn ? <FnRequests key={p.site.name} site={p.site} /> : <TrafficRequests key={p.site.name} site={p.site} />
}
