// Overview (SPEC §5.4): what the site is (left, 3fr) and where it's reachable (right, 2fr). One column below
// 1024px. A banner slot on top for Add site's warnings and the "Last run" of a crashed process.

import type React from "react"
import { useEffect, useState } from "react"
import { getApi } from "../../api/client.ts"
import { useResource } from "../../api/resources.ts"
import { KEYS, useDomains, useSites, useStats } from "../../api/sites.ts"
import type { FnInstanceInfo, InstancesResponse, LogTextResponse } from "../../api/types.ts"
import { fmtMb, formatUptimeShort, plural, shortPath } from "../../lib/format.ts"
import { addressesOf, type Address, type Site, type TabProps } from "../../lib/site.ts"
import { useHistoryState } from "../../router.tsx"
import { useSession, type Session } from "../../session.tsx"
import { AssetsFacts } from "../../shared/AssetsFacts.tsx"
import {
  AnsiText, Banner, Button, CopyButton, EmptyState, ExternalLink, KeyValue, Link, Meter, Section, StatusDot,
  Table, type Column, type KVRow,
} from "../../ui/index.ts"
import { closeTunnel, restartingText, restartSite, warmUp } from "../sites/actions.ts"
import type { AddSiteState } from "./AddSiteDialog.tsx"
import "./overview.css"

const MB = 1048576

// The last memory ratio seen per site while it ran, for "It was near its memory limit" after a crash
const lastMemory = new Map<string, number>()

const enc = encodeURIComponent
const settingsLink = (name: string, section: string) => `/sites/${enc(name)}/settings#${section}`
const manifestLink = (name: string, anchor?: string) => `/sites/${enc(name)}/manifest${anchor ? `#${anchor}` : ""}`
const change = (name: string, section: string) => <Link to={settingsLink(name, section)} className="ov-change">Change</Link>

/** A process that ended badly: errored, or dead with an exit code (not a function). */
export function lastRunApplies(s: Site): boolean {
  const p = s.proc
  if (!p || s.fn) return false
  return (p.status === "errored" || p.status === "dead") && p.exitCode !== null && p.exitCode !== undefined
}

/** The likely cause sentence of a crash, when the facts allow one. */
export function likelyCause(s: Site, lastRatio?: number): string | null {
  if (s.manifestError) return "candy.json has an error"
  const p = s.proc
  const ratio = p?.memoryUsed && p.memoryMax ? p.memoryUsed / p.memoryMax : lastRatio
  if (ratio !== undefined && ratio >= 0.95) return "It was near its memory limit"
  return null
}

/** The rows of "Process" (§5.4). */
export function processRows(s: Site, session: Pick<Session, "multiUser">, phrase: string): KVRow[] {
  const p = s.proc, c = s.config
  const rows: KVRow[] = []
  rows.push({ label: "Status", value: <StatusDot state={s.status.state} label={phrase} showLabel /> })
  if (p) {
    rows.push({ label: "PID", value: p.pid ?? null, mono: true })
    if (p.port) {
      rows.push({
        label: "Port", mono: true,
        value: <>:{p.port}{p.detectedPorts?.includes(p.port) ? <span className="ov-dim"> (detected)</span> : null}</>,
        action: !s.fn ? change(s.name, "startup") : undefined,
      })
    }
    if (p.detectedPorts && p.detectedPorts.length > 1) {
      rows.push({ label: "Detected ports", value: p.detectedPorts.map(x => `:${x}`).join(", "), mono: true })
    }
    if (s.active && p.memoryUsed) {
      const used = fmtMb(p.memoryUsed / MB, true)
      const memAction = session.multiUser && c && c.sandbox ? change(s.name, "sandbox") : undefined
      if (p.memoryMax) {
        const ratio = p.memoryUsed / p.memoryMax
        rows.push({
          label: "Memory", action: memAction,
          value: (
            <span className="ov-memory">
              <span className="mono">{used} of {fmtMb(Math.round(p.memoryMax / MB))}</span>
              <Meter value={ratio} label={`${Math.round(ratio * 100)}% of its memory limit`} />
            </span>
          ),
        })
      } else {
        rows.push({
          label: "Memory", action: memAction, value: <span className="mono">{used}, no limit yet</span>,
          hint: "Started before limits existed: it gets one at its next start.",
        })
      }
    }
    if (s.active && p.uptime) rows.push({ label: "Uptime", value: p.uptime, mono: true })
  }
  const cmd = p?.cmd || c?.cmd
  if (cmd) rows.push({ label: "Command", value: cmd, mono: true })
  const cwd = p?.cwd || c?.cwd
  if (cwd) rows.push({ label: "Folder", value: <span title={cwd}>{shortPath(cwd)}</span>, mono: true })
  if (s.variants.length > 1) {
    const id = p?.configId || s.variants[0].id
    const i = Math.max(0, s.variants.findIndex(v => v.id === id))
    rows.push({ label: "Start command", value: `${s.variants[i].id} (${i + 1} of ${s.variants.length})`, action: change(s.name, "start-commands") })
  }
  if (c && !s.fn) {
    if (session.multiUser && c.user) rows.push({ label: "Runs as", value: c.user, mono: true })
    if (session.multiUser && c.sandbox === false) rows.push({ label: "Sandbox", value: "Off", action: change(s.name, "sandbox") })
    rows.push({
      label: "Idle", action: change(s.name, "startup"),
      value: <>Stops after {c.ttl ?? 60} min idle{c.ttl === null || c.ttl === undefined ? <span className="ov-dim"> (usual)</span> : null}</>,
    })
    if (c.api) rows.push({ label: "API mode", value: "On", action: change(s.name, "startup") })
    if (c.envFile) rows.push({ label: "Env file", value: c.envFile, mono: true, action: change(s.name, "environment") })
    if (c.rw?.length && c.sandbox !== false) {
      rows.push({ label: "Writable folders", value: <span title={c.rw.join("\n")}>{c.rw.length} extra</span>, action: change(s.name, "sandbox") })
    }
  }
  return rows
}

const LOG_WORD: Record<string, string> = { true: "Full", meta: "Metadata only", false: "Off" }

/** The rows of a function's "Code" (§5.4). */
export function codeRows(s: Site): KVRow[] {
  const fn = s.fn!
  const rows: KVRow[] = []
  rows.push(s.kind === "static"
    ? { label: "Entry", value: "No code. The daemon serves the files." }
    : { label: "Entry", value: fn.entry, mono: true })
  rows.push({ label: "Handlers", value: fn.http ? "Has a URL" : "No HTTP handler. Cron and events run it, so it has no URL." })
  rows.push({
    label: "Deploy",
    value: fn.deploy
      ? <><span className="mono">{fn.deploy}</span>, pinned</>
      : <><span className="mono">dev</span>, live from <span className="mono" title={s.config?.cwd}>{shortPath(s.config?.cwd ?? "the source folder")}</span></>,
    action: <Link to={`/sites/${enc(s.name)}/deployments`} className="ov-change">Deployments</Link>,
  })
  if (s.kind !== "static") {
    rows.push({ label: "Scaling", value: `hot ${fn.hot}, max ${fn.max}, linger ${fn.linger}s`, mono: true, action: change(s.name, "scaling") })
  }
  rows.push({ label: "Request log", value: LOG_WORD[String(fn.log)] ?? "Full", action: change(s.name, "scaling") })
  if (s.config?.cwd) rows.push({ label: "Folder", value: <span title={s.config.cwd}>{shortPath(s.config.cwd)}</span>, mono: true })
  return rows
}

/** "From candy.json": one line per declared thing, grouped by the Manifest tab's sections. */
export function manifestLines(s: Site): { label: string; lines: { text: string; anchor: string }[] }[] {
  const m = s.manifest
  if (!m) return []
  const access: { text: string; anchor: string }[] = []
  if (m.auth) access.push({ text: "Asks for Sign in with candy", anchor: "access" })
  if (m.service) access.push({ text: "Accepts service tokens", anchor: "access" })
  if (m.publish) access.push({ text: "Other users' sites may depend on it", anchor: "access" })
  const events: { text: string; anchor: string }[] = []
  const pub = m.pub?.length ?? 0, sub = m.sub?.length ?? 0
  if (pub && sub) events.push({ text: `Publishes ${plural(pub, "event")}, subscribes to ${sub}`, anchor: "events" })
  else if (pub) events.push({ text: `Publishes ${plural(pub, "event")}`, anchor: "events" })
  else if (sub) events.push({ text: `Subscribes to ${plural(sub, "event")}`, anchor: "events" })
  const cron: { text: string; anchor: string }[] = []
  if (m.cron?.length) cron.push({ text: plural(m.cron.length, "scheduled run"), anchor: "cron" })
  const life: { text: string; anchor: string }[] = []
  if (m.depends?.length) life.push({ text: `Depends on ${plural(m.depends.length, "site")}`, anchor: "lifecycle" })
  if (m.idle) life.push({ text: "May ask to stay up past its idle limit", anchor: "lifecycle" })
  return [
    { label: "Access", lines: access }, { label: "Events", lines: events }, { label: "Cron", lines: cron }, { label: "Lifecycle", lines: life },
  ].filter(g => g.lines.length)
}

export function routeStatus(s: Site): string {
  if (s.route?.isRestricted) return "External URL"
  if (s.traffic?.alive) return "Listening"
  return "Forwarding"
}

export default function OverviewTab(p: TabProps): React.JSX.Element {
  const { site } = p
  const session = useSession()
  useStats()
  useDomains()
  const added = useHistoryState<AddSiteState>()

  // remember how close to its limit a running process got
  useEffect(() => {
    const pr = site.proc
    if (site.active && pr?.memoryUsed && pr.memoryMax) lastMemory.set(site.name, pr.memoryUsed / pr.memoryMax)
  }, [site.name, site.active, site.proc?.memoryUsed, site.proc?.memoryMax])

  const showProcess = !!site.proc || (site.kind === "server" && !!site.config)
  const showInstances = site.kind === "function" && !!site.fn?.hasWorker
  const phrase = processPhrase(site)

  return (
    <div className="ov">
      {added && (added.addNote || added.addWarnings?.length) ? (
        <div className="ov-banners">
          <Banner kind="info">
            {added.addNote ? <p>{added.addNote}</p> : null}
            {added.addWarnings?.length ? (
              <ul className="ov-warnings">{added.addWarnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            ) : null}
          </Banner>
        </div>
      ) : null}

      {lastRunApplies(site) ? <LastRun site={site} /> : null}

      <div className="ov-grid">
        <div className="ov-col">
          {showProcess ? (
            <Section title="Process">
              <KeyValue rows={processRows(site, session, phrase)} />
            </Section>
          ) : null}

          {site.fn ? (
            <Section title="Code">
              <KeyValue rows={codeRows(site)} />
            </Section>
          ) : null}

          {showInstances ? <Instances name={site.name} /> : null}

          {site.fn?.assets ? (
            <Section title="Static assets" description={site.fn.hasWorker ? "Served by the daemon before the code." : "Assets only: no code, no process."}>
              <AssetsFacts fn={site.fn} />
            </Section>
          ) : null}

          {site.route && !site.fn ? <RouteSection site={site} /> : null}

        </div>

        <div className="ov-col">
          <Reachable site={site} tld={session.tld} />

          <Relationships site={site} />

          {site.config && (site.kind === "server" || site.fn) ? <FromManifest site={site} /> : null}
        </div>
      </div>
    </div>
  )
}

/** The Process status phrase: like the header's, for the Status row. */
function processPhrase(s: Site): string {
  const p = s.proc
  if (p?.status === "running") return "Running"
  if (p?.status === "errored") return p.exitCode !== null && p.exitCode !== undefined ? `Crashed, exit code ${p.exitCode}` : "Crashed"
  if (p?.status === "dead") return p.exitCode !== null && p.exitCode !== undefined ? `Stopped, exit code ${p.exitCode}` : "Stopped"
  return s.status.label
}

function LastRun(p: { site: Site }): React.JSX.Element {
  const { site } = p
  const proc = site.proc!
  const logs = useResource<LogTextResponse>(`logs/tail:${site.name}:${proc.pid ?? ""}:${proc.exitCode ?? ""}`,
    signal => getApi().get<LogTextResponse>("/logs/" + enc(site.name), { mode: "tail", lines: 30 }, { signal }))
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<{ text: string; error?: boolean } | null>(null)
  const cause = likelyCause(site, lastMemory.get(site.name))
  const verb = proc.status === "errored" ? "Crashed" : "Stopped"

  const restart = async () => {
    setBusy(true)
    setLine({ text: restartingText(site.name) })
    try { setLine({ text: await restartSite(site) }) } catch (e) { setLine({ text: e instanceof Error ? e.message : String(e), error: true }) }
    finally { setBusy(false) }
  }

  return (
    <Section title="Last run"
      description={<>{verb} · exit code {proc.exitCode}{cause ? <span className="ov-cause">. Likely cause: {cause}.</span> : null}</>}
      actions={<>
        <Link to={`/sites/${enc(site.name)}/logs`} className="ui-btn ui-btn-quiet ui-btn-sm">Open full log</Link>
        <Button size="sm" busy={busy} onClick={() => void restart()}>Restart</Button>
      </>}>
      {line ? <p className={line.error ? "ov-line cherry" : "ov-line"} role="status">{line.text}</p> : null}
      <div className="ov-log">
        {logs.data ? (
          logs.data.logs?.trim() ? <AnsiText text={logs.data.logs} /> : <p className="ov-log-empty">The log is empty.</p>
        ) : logs.error ? (
          <p className="ov-log-empty">Couldn’t load the log: {logs.error.message}</p>
        ) : <p className="ov-log-empty">Loading the last 30 lines…</p>}
      </div>
    </Section>
  )
}

function Instances(p: { name: string }): React.JSX.Element {
  const r = useResource<InstancesResponse>(KEYS.instances(p.name),
    signal => getApi().get<InstancesResponse>("/fn/instances", { name: p.name }, { signal }), { every: 5000 })
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<{ text: string; error?: boolean } | null>(null)
  const list = r.data?.instances
  const now = Date.now()
  const columns: Column<FnInstanceInfo>[] = [
    { key: "id", label: "Instance", mono: true, priority: 1, render: i => <span className="truncate" title={i.id}>{i.id}</span> },
    { key: "pid", label: "PID", mono: true, priority: 2, render: i => i.pid ?? "—" },
    { key: "kind", label: "Kind", priority: 2, render: i => (i.hot ? "Hot" : "On demand") },
    { key: "state", label: "State", priority: 1, render: i => <StatusDot state={i.ready ? "running" : "starting"} label={i.ready ? "Ready" : "Starting"} showLabel /> },
    { key: "inflight", label: "In flight", align: "right", priority: 2, render: i => <span className="tnum">{i.inflight}</span> },
    { key: "up", label: "Up", align: "right", mono: true, priority: 3, render: i => formatUptimeShort((now - i.startedAt) / 1000) },
  ]
  const warm = async () => {
    setBusy(true)
    try { setLine({ text: await warmUp(p.name) }) } catch (e) { setLine({ text: e instanceof Error ? e.message : String(e), error: true }) }
    finally { setBusy(false) }
  }
  return (
    <Section title={list ? `Instances (${list.length})` : "Instances"}
      description={line ? <span className={line.error ? "cherry" : undefined} role="status">{line.text}</span> : undefined}
      actions={<Button size="sm" busy={busy} onClick={() => void warm()} title="Start its hot instances now">Warm up</Button>}>
      <Table<FnInstanceInfo> label={`Instances of ${p.name}`} columns={columns} rows={list} rowKey={i => i.id}
        error={list ? null : r.error?.message ?? null} onRetry={() => void r.reload()}
        empty="None running. The next request starts one." />
    </Section>
  )
}

function RouteSection(p: { site: Site }): React.JSX.Element {
  const { site } = p
  const t = site.route!.target
  const target: React.ReactNode = typeof t === "number"
    ? <><span className="mono">:{t}</span> on this machine</>
    : typeof t === "string" ? <ExternalLink href={/^https?:\/\//i.test(t) ? t : `https://${t}`} mono>{t}</ExternalLink> : "—"
  return (
    <Section title="Route">
      <KeyValue rows={[
        { label: "Target", value: target, hint: typeof t === "string" ? "external" : undefined },
        { label: "Status", value: <StatusDot state={site.route!.isRestricted ? "external" : site.traffic?.alive ? "running" : "idle"} label={routeStatus(site)} showLabel /> },
        { label: "Kept across restarts", value: site.route!.persistent ? "Yes" : "No", action: change(site.name, "general") },
      ]} />
    </Section>
  )
}

function Relationships(p: { site: Site }): React.JSX.Element | null {
  const { site } = p
  const { sites } = useSites()
  const depends = site.manifest?.depends?.length ? site.manifest.depends : site.proc?.depends ?? []
  const heldBy = site.proc?.heldBy ?? []
  if (!depends.length && !heldBy.length) return null
  const link = (n: string) => {
    const other = sites?.find(s => s.name === n)
    return (
      <Link key={n} to={`/sites/${enc(n)}`} className="ov-rel">
        {other ? <StatusDot state={other.status.state} label={other.status.label} /> : <StatusDot state="idle" label="Not one of your sites" />}
        <span className="mono">{n}</span>
      </Link>
    )
  }
  const rows: KVRow[] = []
  if (depends.length) rows.push({ label: "Depends on", value: <span className="ov-rels">{depends.map(link)}</span> })
  if (heldBy.length) {
    rows.push({
      label: "Kept up by", value: <span className="ov-rels">{heldBy.map(link)}</span>,
      hint: "These sites depend on it or subscribe to its events, so it isn't stopped for being idle.",
    })
  }
  return <Section title="Relationships"><KeyValue rows={rows} /></Section>
}

function FromManifest(p: { site: Site }): React.JSX.Element {
  const { site } = p
  const cwd = site.config?.cwd ?? ""
  if (site.manifestError) {
    return (
      <Section title="From candy.json">
        <EmptyState action={<Link to={manifestLink(site.name)} className="ui-btn ui-btn-secondary ui-btn-sm">See the error</Link>}>
          candy.json has an error. It keeps its old config.
        </EmptyState>
      </Section>
    )
  }
  if (!site.manifest) {
    return (
      <Section title="From candy.json">
        <EmptyState>No candy.json in <span className="mono">{shortPath(cwd)}</span>. It runs with defaults.</EmptyState>
      </Section>
    )
  }
  const groups = manifestLines(site)
  return (
    <Section title="From candy.json" actions={<Link to={manifestLink(site.name)} className="ov-change">Manifest</Link>}>
      {groups.length ? (
        <KeyValue rows={groups.map(g => ({
          label: g.label,
          value: <span className="ov-lines">{g.lines.map((l, i) => <Link key={i} to={manifestLink(site.name, l.anchor)} className="ov-mline">{l.text}</Link>)}</span>,
        }))} />
      ) : <EmptyState>Its candy.json declares no sign-in, events, cron or dependencies.</EmptyState>}
    </Section>
  )
}

/** A host or URL that may wrap only before a "." or ":" (never inside a label), so a narrow column stays readable. */
function breakable(text: string): React.ReactNode[] {
  return text.split(/(?=[.:])/).map((part, i) => (i ? [<wbr key={i} />, part] : part)).flat()
}

function Reachable(p: { site: Site; tld: string }): React.JSX.Element {
  const { site } = p
  const [closing, setClosing] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (site.noUrl) {
    return (
      <Section title="Reachable at">
        <EmptyState>
          No URL. Its candy.json handlers leave out http, so cron jobs and events are what run it.{" "}
          See <Link to={manifestLink(site.name, "cron")} className="ov-inline">cron jobs</Link> and{" "}
          <Link to={manifestLink(site.name, "events")} className="ov-inline">events</Link>.
        </EmptyState>
      </Section>
    )
  }
  const rows = addressesOf(site, { tld: p.tld })
  const close = async () => {
    setClosing(true)
    setErr(null)
    try { await closeTunnel(site.name) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setClosing(false) }
  }
  const columns: Column<Address>[] = [
    { key: "way", label: "Way in", priority: 1, width: "112px", render: a => a.label },
    {
      key: "address", label: "Address", priority: 1, mono: true,
      render: a => (a.url ? <ExternalLink href={a.url} mono className="ov-addr">{breakable(a.url.replace(/^https?:\/\//, ""))}</ExternalLink> : <span className="ink-2">Opening…</span>),
    },
    { key: "note", label: "Note", priority: 2, render: a => <AddressNote a={a} /> },
  ]
  return (
    <Section title="Reachable at">
      <div className="ov-reach"><Table<Address> label={`Addresses of ${site.name}`} columns={columns} rows={rows} rowKey={(a, i) => `${a.way}-${i}`}
        actions={a => (a.way === "candy" && a.url ? <CopyButton text={a.url} />
          : a.way === "tunnel" ? <Button size="sm" variant="quiet" busy={closing} onClick={() => void close()}>Close</Button> : null)} /></div>
      {err ? <p className="ov-line cherry" role="alert">{err}</p> : null}
      <p className="ov-foot">
        <Link to={settingsLink(site.name, "reach")} className="ov-change">Change these in Settings</Link>
      </p>
    </Section>
  )
}

function AddressNote(p: { a: Address }): React.JSX.Element | null {
  const { a } = p
  const req = a.requests !== undefined ? plural(a.requests, "request") : null
  if (a.way === "public" && a.binding) {
    const open = !(a.binding.hasPassword && a.binding.authEnabled)
    const [first, ...rest] = (a.note ?? "").split(" · ")
    return (
      <Link to={`/public/${enc(a.binding.subdomain)}`} className="ov-note-link">
        <span className={open ? "cherry" : undefined}>{first}</span>{rest.length ? ` · ${rest.join(" · ")}` : null}
      </Link>
    )
  }
  const note = a.way === "tunnel" && !a.url ? null : a.note
  const text = [note, req].filter(Boolean).join(" · ")
  return text ? <span className="ink-2">{text}</span> : null
}

