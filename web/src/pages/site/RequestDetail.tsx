// One function request: facts, error, console, headers and bodies, and Replay (SPEC §5.8). Owned by package C.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../api/client.ts"
import { useResource } from "../../api/resources.ts"
import type { CapturedBody, ReplayResponse, RequestDetail as Detail } from "../../api/types.ts"
import { fmtBytes, fmtClock, fmtDate, fmtMs } from "../../lib/format.ts"
import {
  Button, Code, EmptyState, ErrorState, errorMessage, Icon, KeyValue, type KVRow, Link, Section, Skeleton, Table, useConfirm,
} from "../../ui/index.ts"
import { bodyView, httpClass, isPartialError } from "./lib/requests.ts"
import "./requests.css"

/** A status as a dot and the number: 2xx mint, 3xx ring, 4xx lemon, 5xx cherry. */
export function HttpStatus(p: { status: number | string | null | undefined; outcome?: string }): React.JSX.Element {
  const cls = httpClass(p.status)
  if (!cls) {
    if (p.outcome && p.outcome !== "ok") return <span className="http-status is-outcome" title={p.outcome}>{p.outcome}</span>
    return <span className="http-status"><span className="http-dot" aria-hidden="true" />{p.status === "?" ? "?" : "—"}</span>
  }
  return (
    <span className="http-status" title={p.outcome && p.outcome !== "ok" ? p.outcome : undefined}>
      <span className={`http-dot is-${cls}`} aria-hidden="true" />
      <span className="tnum">{String(p.status)}</span>
    </span>
  )
}

/** The text of a captured body, or the one sentence that says why there is none. */
export function BodyBlock(p: { body: CapturedBody | null | undefined }): React.JSX.Element {
  const v = bodyView(p.body)
  if (v.kind === "text") return <div className="req-body"><Code block>{v.text}</Code></div>
  return <div className="req-note">{v.text}</div>
}

const bodyNotes = (b: CapturedBody | null | undefined) => bodyView(b).notes.join(" · ") || undefined

type HeaderRow = [string, string]
function HeadersTable(p: { rows: HeaderRow[] | null | undefined; label: string }): React.JSX.Element {
  return (
    <Table<HeaderRow> label={p.label} rows={Array.isArray(p.rows) ? p.rows : []} rowKey={(_, i) => String(i)} empty="None"
      columns={[
        { key: "name", label: "Name", width: "34%", render: h => <span className="req-hname">{h[0]}</span> },
        { key: "value", label: "Value", mono: true, render: h => <span className="req-hval">{h[1]}</span> },
      ]} />
  )
}

function replayBody(r: ReplayResponse): CapturedBody {
  const ct = (r.headers ?? []).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null
  const text = typeof r.body === "string" ? r.body : r.body === undefined || r.body === null ? "" : JSON.stringify(r.body)
  return { kind: text ? "text" : "none", contentType: ct, size: text.length, truncated: !!r.truncated, text, sha256: null }
}

export function RequestFacts(p: { d: Detail }): React.JSX.Element {
  const { d } = p
  const worker = d.kind !== "asset"
  const rows: KVRow[] = [
    { label: "Time", value: `${fmtDate(d.ts)}.${fmtClock(d.ts, true).slice(-3)}` },
    { label: "Host", value: d.host, mono: true },
    { label: "From", value: d.clientIp, mono: true },
    { label: "Served by", value: d.kind === "asset" ? "the daemon, from the asset folder (no process)" : "the code" },
    { label: "Rule", value: d.rule, mono: true, hidden: !d.rule },
    { label: "Instance", value: d.instance, mono: true, hidden: !worker || !d.instance },
    { label: "Start", value: d.cold ? "cold (new instance)" : "warm", hidden: !worker },
    { label: "Queued", value: fmtMs(d.queuedMs) },
    { label: "First byte", value: d.ttfbMs === null || d.ttfbMs === undefined ? null : fmtMs(d.ttfbMs) },
    { label: "Total", value: fmtMs(d.totalMs) },
    { label: "Outcome", value: <span className="cherry">{d.outcome}</span>, hidden: !d.outcome || d.outcome === "ok" },
  ]
  return <KeyValue rows={rows} labelWidth={120} />
}

export function ConsoleBlock(p: { logs: Detail["logs"] | null | undefined; truncated?: boolean }): React.JSX.Element {
  const logs = Array.isArray(p.logs) ? p.logs : []
  if (!logs.length) return <EmptyState>Nothing logged during this request.</EmptyState>
  return (
    <pre className="req-console">
      {logs.map((l, i) => {
        const lv = String(l.level || "log")
        return (
          <div key={i} className={`req-console-line is-${lv}`}>
            <span className="req-console-time">{fmtClock(l.ts, true)}</span> <span className="req-console-level">{lv.padEnd(5)}</span> {String(l.text ?? "")}
          </div>
        )
      })}
      {p.truncated ? <div className="req-console-line is-debug">(truncated)</div> : null}
    </pre>
  )
}

/** The detail pane of /sites/:name/requests/:id. */
export function RequestDetail(p: { name: string; id: string; hrefFor: (id: string) => string; backHref: string }): React.JSX.Element {
  const { name, id } = p
  const r = useResource<Detail>(`fn/request:${name}:${id}`,
    signal => getApi().get<Detail>("/fn/request", { name, id }, { signal }))
  const confirm = useConfirm()
  const [replay, setReplay] = useState<{ id: string; busy: boolean; line?: { error: boolean; text: string }; result?: ReplayResponse }>({ id, busy: false })
  const mine = replay.id === id ? replay : { id, busy: false }

  const run = async (allowPartial: boolean): Promise<void> => {
    setReplay({ id, busy: true })
    try {
      const res = await getApi().post<ReplayResponse>("/fn/replay", allowPartial ? { name, id, allowPartial: true } : { name, id })
      setReplay({ id, busy: false, result: res, line: { error: String(res.status)[0] === "5", text: `Replayed: ${res.status}` } })
    } catch (e) {
      const msg = errorMessage(e)
      if (!allowPartial && isPartialError(msg)) {
        setReplay({ id, busy: false })
        const ok = await confirm({
          title: "Replay with a cut-off body?",
          body: "This request's body was cut off when it was logged. Replay it with the part that was kept?",
          verb: "Replay",
        })
        if (ok) return run(true)
        return
      }
      setReplay({ id, busy: false, line: { error: true, text: `Replay failed: ${msg}` } })
    }
  }

  const back = (
    <Link to={p.backHref} className="req-back"><Icon name="arrow-left" size={14} />Back to requests</Link>
  )

  if (!r.data) {
    return (
      <div className="req-detail">
        {back}
        {r.error ? <ErrorState error={`Couldn’t load this request: ${r.error.message}`} onRetry={() => void r.reload()} /> : <Skeleton rows={6} />}
      </div>
    )
  }
  const d = r.data
  const result = mine.result
  return (
    <div className="req-detail" aria-label="Request detail">
      {back}
      <div className="req-head">
        <HttpStatus status={d.status} outcome={d.outcome} />
        <span className="req-head-line mono" title={d.url}>{d.method} {d.path}</span>
        <Button size="sm" busy={mine.busy} onClick={() => void run(false)} title="Send this request again to the code running now">Replay</Button>
      </div>
      {mine.line ? (
        <div className={mine.line.error ? "req-status is-error" : "req-status"} role="status">
          <Icon name={mine.line.error ? "error" : "check"} size={14} />{mine.line.text}
        </div>
      ) : null}

      <Section title="Facts"><RequestFacts d={d} /></Section>

      {d.error ? (
        <Section title="Error">
          <div className="req-error">
            <div className="req-error-msg">{d.error.message}</div>
            {d.error.stack ? <pre className="req-error-stack">{d.error.stack}</pre> : null}
          </div>
        </Section>
      ) : null}

      {result ? (
        <Section title={`Replay result ${result.status} · logged as ${result.requestId}`}
          description={result.requestId ? <Link to={p.hrefFor(result.requestId)}>Open the new request</Link> : undefined}>
          <div className="req-stack">
            <HeadersTable rows={result.headers} label="Replay response headers" />
            {replayBody(result).kind === "none" ? <div className="req-note">Empty body</div> : <BodyBlock body={replayBody(result)} />}
          </div>
        </Section>
      ) : null}

      <Section title="Console" description={d.logs?.length ? `${d.logs.length} ${d.logs.length === 1 ? "line" : "lines"}${d.logsTruncated ? " (truncated)" : ""}` : undefined}>
        <ConsoleBlock logs={d.logs} truncated={d.logsTruncated} />
      </Section>

      <Section title={d.reqHeaders?.length ? `Request headers (${d.reqHeaders.length})` : "Request headers"}>
        <HeadersTable rows={d.reqHeaders} label="Request headers" />
      </Section>
      <Section title="Request body" description={bodyNotes(d.reqBody) ?? (d.reqBytes ? fmtBytes(d.reqBytes) : undefined)}>
        <BodyBlock body={d.reqBody} />
      </Section>
      <Section title={d.resHeaders?.length ? `Response headers (${d.resHeaders.length})` : "Response headers"}>
        <HeadersTable rows={d.resHeaders} label="Response headers" />
      </Section>
      <Section title="Response body" description={bodyNotes(d.resBody) ?? (d.resBytes ? fmtBytes(d.resBytes) : undefined)}>
        <BodyBlock body={d.resBody} />
      </Section>
    </div>
  )
}
