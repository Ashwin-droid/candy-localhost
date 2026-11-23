// Activity (SPEC §5.11): what happened to your sites, newest first, grouped by day.

import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { getApi } from "../../api/client.ts"
import { useResource } from "../../api/resources.ts"
import { useSites } from "../../api/sites.ts"
import type { ActivityResponse } from "../../api/types.ts"
import { fmtDate } from "../../lib/format.ts"
import { useQueryParam } from "../../router.tsx"
import { type Column, errorMessage, Input, Link, PageHeader, Select, Table } from "../../ui/index.ts"
import { actionLabel, filterEntries, groupByDay, hhmm, linkSites, parseCount } from "./lib.ts"
import { COUNTS, type ActivityItem } from "./types.ts"
import "./activity.css"

export const EMPTY_TEXT = "Nothing yet. Sites added, renamed, started or shared show up here."
export const ERROR_TEXT = "Couldn’t load activity."

export default function ActivityPage(): React.JSX.Element {
  useEffect(() => { document.title = "Activity – candy" }, [])
  const [qParam, setQParam] = useQueryParam("q")
  const [countParam, setCountParam] = useQueryParam("count")
  const count = parseCount(countParam)
  const [q, setQ] = useState(qParam ?? "")
  useEffect(() => { setQ(qParam ?? "") }, [qParam])

  const res = useResource<ActivityResponse>(`activity:${count}`,
    signal => getApi().get<ActivityResponse>("/logs", { count }, { signal }), { every: 15_000 })
  const { sites } = useSites()
  const names = useMemo(() => new Set((sites ?? []).map(s => s.name)), [sites])

  const logs = res.data?.logs
  const items = useMemo(() => (logs ? groupByDay(filterEntries(logs, q), Date.now()) : undefined), [logs, q])

  const columns: Column<ActivityItem>[] = [
    {
      key: "time", label: "Time", mono: true, width: "88px",
      render: r => r.kind === "day"
        ? <span className="act-day" title={r.title}>{r.label}</span>
        : <time className="act-time" dateTime={Number.isNaN(r.at) ? undefined : new Date(r.at).toISOString()}
            title={Number.isNaN(r.at) ? undefined : fmtDate(r.at)}>{hhmm(r.at) || "—"}</time>,
    },
    { key: "action", label: "Action", width: "160px", render: r => (r.kind === "entry" ? <span className="act-action">{actionLabel(r.action)}</span> : null) },
    {
      key: "details", label: "Details",
      render: r => r.kind === "entry" ? (
        <span className="act-details">
          {linkSites(r.details, names).map((p, i) => p.site
            ? <Link key={i} to={`/sites/${encodeURIComponent(p.site)}`} className="act-site">{p.text}</Link>
            : <span key={i}>{p.text}</span>)}
        </span>
      ) : null,
    },
  ]

  const total = res.data?.total ?? 0
  const meta: React.ReactNode[] = []
  if (res.data) meta.push(total > (logs?.length ?? 0)
    ? `Newest ${(logs?.length ?? 0).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`
    : `${total.toLocaleString("en-US")} ${total === 1 ? "entry" : "entries"}`)

  const error = !res.error ? null : logs ? errorMessage(res.error) : `${ERROR_TEXT} ${errorMessage(res.error)}`
  const filtered = !!q.trim() && !!logs?.length

  return (
    <>
      <PageHeader title="Activity" meta={meta} actions={
        <div className="act-tools">
          <Input type="search" className="act-filter" placeholder="Filter by action or details" aria-label="Filter activity"
            data-shortcut="filter" value={q}
            onChange={e => { setQ(e.target.value); setQParam(e.target.value || null) }} />
          <Select aria-label="How many entries" value={String(count)}
            onChange={e => setCountParam(e.target.value === "200" ? null : e.target.value)}>
            {COUNTS.map(n => <option key={n} value={n}>Last {n.toLocaleString("en-US")}</option>)}
          </Select>
        </div>
      } />
      <div className="act-table">
        <Table<ActivityItem>
          label="Activity" columns={columns} rows={items} rowKey={r => r.key}
          loading={res.loading} error={error} onRetry={() => { void res.reload() }}
          empty={filtered ? `Nothing matches “${q.trim()}”.` : EMPTY_TEXT} />
      </div>
    </>
  )
}
