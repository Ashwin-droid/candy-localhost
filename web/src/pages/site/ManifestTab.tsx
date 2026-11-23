// Manifest tab (SPEC §5.6): the home of every candy.json fact, with Reload.

import type React from "react"
import { useEffect, useState } from "react"
import { ApiError, getApi } from "../../api/client.ts"
import { invalidate } from "../../api/resources.ts"
import { KEYS, useSites } from "../../api/sites.ts"
import type { PubEvent, ReloadResponse, SiteManifestView } from "../../api/types.ts"
import type { Site, TabProps } from "../../lib/site.ts"
import { AssetsFacts } from "../../shared/AssetsFacts.tsx"
import {
  Button, Code, EmptyState, Icon, KeyValue, Link, Section, StatusDot, Table, type Column, type KVRow,
} from "../../ui/index.ts"
import { describeCron, formatRun, localZone, nextRun } from "./lib/cron.ts"
import { accessWords, parseSub, subscribersOf, subscriptionRow, type ParsedSub } from "./lib/manifest.ts"
import "./manifest.css"

type ReloadState = { kind: "ok"; text: string } | { kind: "error"; text: string } | null

const siteLink = (name: string) => <Link to={`/sites/${encodeURIComponent(name)}`} className="manifest-site">{name}</Link>

function SiteLinks(p: { names: string[]; all: Site[] }): React.JSX.Element {
  return (
    <span className="manifest-links">
      {p.names.map(n => {
        const s = p.all.find(x => x.name === n)
        return (
          <span key={n} className="manifest-link">
            {s ? <StatusDot state={s.status.state} label={s.status.label} /> : null}
            {s ? siteLink(n) : <span className="mono">{n}</span>}
          </span>
        )
      })}
    </span>
  )
}

export function ReloadBar(p: { site: Site; disabled?: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ReloadState>(null)
  const cwd = p.site.config?.cwd
  const reload = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await getApi().post<ReloadResponse>("/config/reload", { name: p.site.name }, { lane: "long" })
      const mine = res.sites.find(s => s.name === p.site.name) ?? res.sites[0]
      if (mine && !mine.ok) setResult({ kind: "error", text: `${mine.error ?? "It couldn't be read"} (it keeps its old config)` })
      else {
        const cron = mine?.cron?.length ? ` Cron: ${mine.cron.join(", ")}` : ""
        setResult({ kind: "ok", text: `Read just now. Nothing restarts; edits apply at its next start.${cron}` })
      }
      invalidate([KEYS.sites])
    } catch (e) {
      const msg = e instanceof ApiError && e.status !== 0 ? e.message : "Could not reload"
      setResult({ kind: "error", text: `${msg} (it keeps its old config)` })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="manifest-file">
      <div className="manifest-file-row">
        <div className="manifest-file-path">
          <span className="small ink-2">File</span>
          <code title={cwd ? `${cwd}/candy.json` : undefined}>{cwd ? `${cwd.replace(/\/$/, "")}/candy.json` : "candy.json"}</code>
        </div>
        <Button size="sm" onClick={reload} busy={busy} disabled={p.disabled || !cwd}>Reload candy.json</Button>
      </div>
      {result ? (
        <div className={result.kind === "error" ? "manifest-result is-error" : "manifest-result"} role="status">
          <Icon name={result.kind === "error" ? "error" : "check"} size={14} />
          <span>{result.text}</span>
        </div>
      ) : null}
    </div>
  )
}

function AccessSection(p: { m: SiteManifestView }): React.JSX.Element {
  const rows: KVRow[] = [
    {
      label: "Sign in with candy", rawKey: "auth",
      value: p.m.auth ? "Asks for it" : "Not asked for",
      hint: p.m.auth ? <>Its key is in <Link to="/settings/sign-in">Settings › Sign in with candy</Link>.</> : undefined,
    },
    {
      label: "Service tokens", rawKey: "service", value: p.m.service ? "Accepts them" : "No",
      hint: p.m.service ? "Accepts server-to-server tokens: other sites can prove which app is calling." : undefined,
    },
    {
      label: "Published", rawKey: "publish", value: p.m.publish ? "Yes" : "No",
      hint: p.m.publish ? "Other users' sites may depend on it." : undefined,
    },
  ]
  return <Section id="access" title="Access"><KeyValue rows={rows} labelWidth={180} /></Section>
}

interface DepRow { name: string; site: Site | undefined }

function LifecycleSections(p: { site: Site; m: SiteManifestView; all: Site[] }): React.JSX.Element | null {
  const deps = p.m.depends.length ? p.m.depends : p.site.proc?.depends ?? []
  const heldBy = p.site.proc?.heldBy ?? []
  if (!deps.length && !p.m.idle && !heldBy.length) return null
  const rows: KVRow[] = [
    {
      label: "May idle", rawKey: "idle", value: p.m.idle ? "Yes" : "No",
      hint: p.m.idle ? "It may ask to stay up past its idle limit." : undefined,
    },
    {
      label: "Kept up by (now)", value: heldBy.length ? <SiteLinks names={heldBy} all={p.all} /> : "Nothing right now",
      hint: "Live, from the daemon.",
    },
  ]
  const depRows: DepRow[] = deps.map(name => ({ name, site: p.all.find(s => s.name === name) }))
  const cols: Column<DepRow>[] = [
    {
      key: "site", label: "Site", render: r => r.site
        ? <span className="manifest-link"><StatusDot state={r.site.status.state} label={r.site.status.label} />{siteLink(r.name)}</span>
        : <span className="mono">{r.name}</span>,
    },
    { key: "status", label: "Status", render: r => r.site ? r.site.status.label : "—" },
    { key: "note", label: "Note", priority: 2, render: r => r.site ? "—" : "Not one of your sites" },
  ]
  return (
    <>
      <Section id="lifecycle" title="Lifecycle"><KeyValue rows={rows} labelWidth={180} /></Section>
      {depRows.length ? (
        <Section id="depends" title="Depends on" description="Started before it, and kept up while it runs.">
          <Table label="Depends on" columns={cols} rows={depRows} rowKey={(r, i) => `${i}`} />
        </Section>
      ) : null}
    </>
  )
}

function EventsSections(p: { site: Site; m: SiteManifestView; all: Site[] }): React.JSX.Element | null {
  if (!p.m.pub.length && !p.m.sub.length) return null
  const pubCols: Column<PubEvent>[] = [
    { key: "event", label: "Event", mono: true, render: e => e.event },
    { key: "access", label: "Access", render: e => e.bind ? `Only ${e.bind}` : accessWords(e.auth, p.site.name) },
    { key: "users", label: "Users", priority: 2, render: e => e.users.length ? e.users.join(", ") : "—" },
    { key: "ordered", label: "Ordered", priority: 3, render: e => e.ordered ? "Yes" : "—" },
    { key: "bind", label: "Bound to", priority: 3, render: e => e.bind ? <span className="mono">{e.bind}</span> : "—" },
    {
      key: "subs", label: "Subscribers (derived)", priority: 2, render: e => {
        const subs = subscribersOf(p.site, e, p.all)
        return subs.length ? <SiteLinks names={subs.map(s => s.name)} all={p.all} /> : "—"
      },
    },
  ]
  const subRows = p.m.sub.map(s => ({ raw: s, parsed: parseSub(s) }))
  const subCols: Column<{ raw: string; parsed: ParsedSub }>[] = [
    {
      key: "publisher", label: "Publisher", render: r => {
        if (r.parsed.kind === "any") return "Any site"
        if (r.parsed.kind === "builtin") return "candy"
        const name = r.parsed.publisher ?? ""
        return p.all.some(s => s.name === name) ? <SiteLinks names={[name]} all={p.all} /> : <span className="mono">{name}</span>
      },
    },
    { key: "event", label: "Event", mono: true, render: r => r.parsed.event },
    {
      key: "status", label: "Status (derived)", priority: 2, render: r => {
        const row = subscriptionRow(r.parsed, p.all)
        return <span className={row.tone === "error" ? "cherry" : undefined}>{row.text}</span>
      },
    },
  ]
  return (
    <div id="events" className="manifest-group">
      {p.m.pub.length ? (
        <Section id="events-pub" title="Publishes"
          description="Who may subscribe to each event. Subscribers are worked out from your sites' candy.json; other users' sites aren't counted.">
          <Table label="Events it publishes" columns={pubCols} rows={p.m.pub} rowKey={(e, i) => `${i}`} />
        </Section>
      ) : null}
      {p.m.sub.length ? (
        <Section id="events-sub" title="Subscribes"
          description={<span title="Worked out from candy.json. Approval state isn't visible yet.">Worked out from candy.json. Approval state isn't visible yet.</span>}>
          <Table label="Events it subscribes to" columns={subCols} rows={subRows} rowKey={(r, i) => `${i}`} />
        </Section>
      ) : null}
    </div>
  )
}

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

function CronSection(p: { site: Site; m: SiteManifestView }): React.JSX.Element | null {
  const now = useMinuteClock()
  if (!p.m.cron.length) return null
  const zone = localZone()
  const cols: Column<{ tag: string; schedule: string }>[] = [
    { key: "tag", label: "Tag", mono: true, render: j => j.tag },
    {
      key: "schedule", label: "Schedule", render: j => {
        const words = describeCron(j.schedule)
        return (
          <span className="manifest-cron">
            <code>{j.schedule}</code>
            {words ? <span className="small ink-2">{words}</span> : null}
          </span>
        )
      },
    },
    {
      key: "next", label: `Next run, estimated (${zone})`, priority: 2, render: j => {
        const next = nextRun(j.schedule, now)
        return next ? <span className="tnum" title={next.toString()}>{formatRun(next, now)}</span> : "—"
      },
    },
  ]
  const help = p.site.fn
    ? <>From candy.json. Run history isn't recorded yet. Untagged <code>crons</code> entries of a function aren't listed here yet.</>
    : "From candy.json. Run history isn't recorded yet."
  return (
    <Section id="cron" title="Cron" description={help}>
      <Table label="Scheduled runs" columns={cols} rows={p.m.cron} rowKey={(j, i) => `${i}`} />
    </Section>
  )
}

function FunctionSections(p: { site: Site }): React.JSX.Element | null {
  const fn = p.site.fn
  if (!fn) return null
  const rows: KVRow[] = [
    { label: "Handlers", rawKey: "handlers", value: fn.http ? "Has an HTTP handler" : "No HTTP handler: no URL" },
    {
      label: "Entry", rawKey: "main", mono: !!fn.entry,
      value: fn.entry ?? (fn.hasWorker ? null : "No code. The daemon serves the files."),
      hint: "Change it in candy.json.",
    },
  ]
  return (
    <>
      <Section id="function" title="Function"><KeyValue rows={rows} labelWidth={180} /></Section>
      {fn.assets ? <Section id="assets" title="Static assets"><AssetsFacts fn={fn} /></Section> : null}
    </>
  )
}

export default function ManifestTab(p: TabProps): React.JSX.Element {
  const { site } = p
  const { sites, offline } = useSites()
  const all = sites ?? [site]
  const cfg = site.config
  let body: React.ReactNode
  if (!cfg) {
    body = <EmptyState>Its candy.json isn't visible to you.</EmptyState>
  } else if (site.manifestError) {
    body = (
      <div className="manifest-error" role="alert">
        <div className="manifest-error-title">candy.json has an error</div>
        <Code block>{site.manifestError}</Code>
        <p className="help">It keeps its old config. Fix the file and reload it.</p>
      </div>
    )
  } else if (!site.manifest) {
    body = (
      <>
        <EmptyState>No candy.json in <code>{cfg.cwd}</code>. It runs with defaults.</EmptyState>
        <FunctionSections site={site} />
      </>
    )
  } else {
    const m = site.manifest
    body = (
      <>
        <AccessSection m={m} />
        <LifecycleSections site={site} m={m} all={all} />
        <EventsSections site={site} m={m} all={all} />
        <CronSection site={site} m={m} />
        <FunctionSections site={site} />
      </>
    )
  }
  return (
    <div className="manifest">
      {cfg ? <ReloadBar site={site} disabled={offline} /> : null}
      {body}
    </div>
  )
}
