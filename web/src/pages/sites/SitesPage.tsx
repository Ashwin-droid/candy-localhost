// Sites (SPEC §5.1): every site as one row of a table, the Attention strip above it, Add site and the legacy
// deep links ?add, ?logs and ?bind (§3.2).

import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { useDomains, useSites, useStats } from "../../api/sites.ts"
import { attentionItems, type AttentionItem } from "../../lib/attention.ts"
import { parseDeepLink, rootHashRedirect } from "../../lib/deeplinks.ts"
import { primaryAddress, type Site } from "../../lib/site.ts"
import { navigate, useRoute } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import { StartButton } from "../../shared/StartButton.tsx"
import {
  Button, Code, EmptyState, Host, Icon, Input, Link, PageHeader, Segmented, StatusDot, Table, toast, type Column,
} from "../../ui/index.ts"
import { AddSiteDialog, type AddMode } from "../site/AddSiteDialog.tsx"
import { reloadAll, reloadedText, restartingText, restartSite, stopSite } from "./actions.ts"
import {
  byMemory, byName, byRequests, byStatus, DEFAULT_VIEW, filterSites, hasViewParams, KIND_PLURAL, KIND_WORD, kindCounts,
  memoryCell, parseDismissed, parseStoredView, rowAction, serializeView, showsOwners, statusText, summary, viewFromQuery,
  viewToQuery, VIEW_STORAGE_KEY, type KindFilter, type OwnerFilter, type SitesView, type SortKey,
} from "./view.ts"
import "./sites.css"

const DISMISSED_KEY = "candy_dismissed"
const ATTENTION_MAX = 5
const DEEP_PARAMS = ["add", "logs", "bind"]

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function writeStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private mode: the URL still keeps the view */ }
}

/** Replace the current URL's query (keeps the path and hash). */
function replaceQuery(q: URLSearchParams): void {
  if (typeof location === "undefined") return
  const s = q.toString()
  navigate(location.pathname + (s ? `?${s}` : "") + location.hash, { replace: true })
}

export default function SitesPage(): React.JSX.Element {
  const session = useSession()
  const route = useRoute()
  const { sites, error, loading, offline } = useSites()
  useStats()
  const domains = useDomains()

  const view = viewFromQuery(route.query)
  const [text, setText] = useState(view.q)
  const deep = parseDeepLink(route.query.toString())
  const [add, setAdd] = useState<{ name: string | null; mode: AddMode } | null>(
    () => (deep?.kind === "add" ? { name: deep.name, mode: "port" } : null))
  const [reload, setReload] = useState<{ busy: boolean; text?: string; error?: boolean }>({ busy: false })
  const [reloadErrors, setReloadErrors] = useState<{ name: string; error: string }[]>([])

  useEffect(() => { document.title = "Sites – candy" }, [])

  // Old candy:// handler links: /#routes, /#stats
  useEffect(() => {
    const to = rootHashRedirect(route.path, route.hash)
    if (to) navigate(to, { replace: true })
  }, [route.path, route.hash])

  // Restore the saved view when the URL carries none
  useEffect(() => {
    if (hasViewParams(new URLSearchParams(location.search))) return
    const saved = parseStoredView(readStorage(VIEW_STORAGE_KEY))
    if (!saved) return
    const q = viewToQuery(saved, new URLSearchParams(location.search))
    if (q.toString() !== new URLSearchParams(location.search).toString()) replaceQuery(q)
    setText(saved.q)
  }, [])

  const setView = (patch: Partial<SitesView>) => {
    const next = { ...viewFromQuery(new URLSearchParams(location.search)), ...patch }
    writeStorage(VIEW_STORAGE_KEY, serializeView(next))
    replaceQuery(viewToQuery(next, new URLSearchParams(location.search)))
  }

  // The filter box is local state, written to the URL as it changes
  const onText = (v: string) => { setText(v); setView({ q: v }) }

  // Legacy deep links. ?add opens the dialog; ?bind goes to /public; ?logs waits for the first load.
  const search = route.query.toString()
  useEffect(() => {
    const d = parseDeepLink(search)
    if (!d) return
    if (d.kind === "add") {
      setAdd({ name: d.name, mode: "port" })
    } else if (d.kind === "bind") {
      navigate("/public" + (d.name ? `?bind=${encodeURIComponent(d.name)}` : "?bind"), { replace: true })
      return
    } else if (d.kind === "logs") {
      if (!sites) return
      if (sites.some(s => s.name === d.name)) {
        navigate(`/sites/${encodeURIComponent(d.name)}/logs`, { replace: true })
        return
      }
      toast(`${d.name} isn't one of your sites`, "error")
    }
    const q = new URLSearchParams(location.search)
    for (const k of DEEP_PARAMS) q.delete(k)
    replaceQuery(q)
  }, [search, sites])

  const owners = showsOwners(sites, session.superuser, session.user)
  const counts = useMemo(() => kindCounts(sites ?? []), [sites])
  const shown = useMemo(
    () => (sites ? filterSites(sites, { q: text, kind: view.kind, owner: view.owner }, session.user, owners) : undefined),
    [sites, text, view.kind, view.owner, session.user, owners])

  const doReload = async () => {
    setReload({ busy: true })
    try {
      const r = await reloadAll()
      setReloadErrors(r.failed)
      setReload({ busy: false, text: reloadedText(r.ok, r.total) })
    } catch (e) {
      setReload({ busy: false, text: e instanceof Error ? e.message : String(e), error: true })
    }
  }

  const kinds = (["all", "server", "function", "static", "forward"] as KindFilter[])
    .filter(k => k === "all" || counts[k] > 0 || view.kind === k)
    .map(k => ({ value: k, label: `${KIND_PLURAL[k]} ${counts[k]}` }))

  const columns: Column<Site>[] = [
    {
      key: "name", label: "Name", priority: 1, sort: byName,
      render: s => (
        <span className="sites-name">
          <StatusDot state={s.status.state} label={s.status.label} />
          <Host name={s.name} tld={s.noUrl ? null : session.tld} />
          {owners && s.owner && s.owner !== session.user ? <span className="sites-owner" title={`Runs as ${s.owner}`}>{s.owner}</span> : null}
        </span>
      ),
    },
    { key: "kind", label: "Kind", priority: 2, width: "104px", render: s => KIND_WORD[s.kind] },
    {
      key: "status", label: "Status", priority: 1, sort: byStatus, width: "168px",
      render: s => <span className={s.status.state === "crashed" ? "sites-status cherry" : "sites-status"}>{statusText(s)}</span>,
    },
    {
      key: "address", label: "Address", priority: 2,
      render: s => {
        const a = primaryAddress(s)
        if (a.text === "—") return <span className="ink-3">—</span>
        return <span className={a.mono ? "sites-address mono" : "sites-address ink-2"} title={a.text}>{a.text}</span>
      },
    },
    {
      key: "requests", label: "Requests", priority: 2, align: "right", mono: true, sort: byRequests, width: "104px",
      render: s => (s.traffic?.total ? <span className="tnum">{s.traffic.total.toLocaleString("en-US")}</span> : <span className="ink-3">—</span>),
    },
    {
      key: "memory", label: "Memory", priority: 3, align: "right", mono: true, sort: byMemory, width: "96px",
      render: s => {
        const m = memoryCell(s)
        return m.title ? <span title={m.title}>{m.text}</span> : <span className="ink-3">—</span>
      },
    },
  ]

  const empty = sites && sites.length === 0
  const filtered = !!text.trim() || view.kind !== "all" || (owners && view.owner === "mine")

  return (
    <div className="sites-page">
      <PageHeader
        title="Sites"
        meta={sites ? [summary(sites)] : []}
        actions={<>
          <Button busy={reload.busy} disabled={offline} onClick={() => void doReload()}
            title="Read candy.json again for every site. Nothing restarts. An edit otherwise waits for the site's next start.">
            Reload candy.json
          </Button>
          <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setAdd({ name: null, mode: "port" })}>Add site</Button>
        </>}
      />
      {reload.text ? (
        <p className={reload.error ? "sites-statusline cherry" : "sites-statusline"} role="status">
          {reload.text}
          <button type="button" className="sites-statusline-close" aria-label="Dismiss" onClick={() => setReload({ busy: false })}>
            <Icon name="x" size={12} />
          </button>
        </p>
      ) : null}

      {sites ? (
        <Attention items={attentionItems(sites, domains.data, session.buildStale, reloadErrors)} sites={sites} offline={offline} />
      ) : null}

      {empty ? (
        <EmptyState action={<Button variant="primary" onClick={() => setAdd({ name: null, mode: "port" })}>Add site</Button>}>
          No sites yet. Open any <Code>name.{session.tld}</Code> in a browser to set one up, or add one here.
        </EmptyState>
      ) : (
        <>
          <div className="sites-toolbar">
            <div className="sites-filter">
              <Input type="search" value={text} onChange={e => onText(e.target.value)} placeholder="Filter sites"
                aria-label="Filter sites" data-shortcut="filter" suffix="/" autoComplete="off" spellCheck={false}
                onKeyDown={e => { if (e.key === "Escape" && text) { e.stopPropagation(); onText("") } }} />
            </div>
            <Segmented<KindFilter> label="Kind" options={kinds} value={view.kind} onChange={k => setView({ kind: k })} />
            {owners ? (
              <Segmented<OwnerFilter> label="Owner" value={view.owner} onChange={o => setView({ owner: o })}
                options={[{ value: "mine", label: "Mine" }, { value: "all", label: "Everyone" }]} />
            ) : null}
          </div>
          <div className="sites-table">
            <Table<Site>
              label="Sites"
              columns={columns}
              rows={shown}
              rowKey={s => s.name}
              rowHref={s => `/sites/${encodeURIComponent(s.name)}`}
              loading={loading}
              error={error && !sites ? error.message : null}
              sortKey={view.sort}
              sortDir={view.dir}
              onSort={(key, dir) => setView({ sort: key as SortKey, dir })}
              actions={s => <RowAction site={s} offline={offline} />}
              empty={filtered ? (
                <span className="sites-noresults">
                  No sites match this filter.{" "}
                  <button type="button" className="sites-linkbtn" onClick={() => { setText(""); setView({ ...DEFAULT_VIEW, sort: view.sort, dir: view.dir }) }}>
                    Clear the filter
                  </button>
                </span>
              ) : "No sites yet."}
            />
          </div>
        </>
      )}

      <AddSiteDialog open={!!add} initialName={add?.name} mode={add?.mode} onClose={() => setAdd(null)} />
    </div>
  )
}

/** The one compact action at a row's end (§5.1). */
function RowAction(p: { site: Site; offline: boolean }): React.JSX.Element | null {
  const { site } = p
  const [busy, setBusy] = useState(false)
  const action = rowAction(site)
  if (action === "start") return p.offline ? null : <StartButton site={site} size="sm" />
  if (action === null) return null
  const run = async () => {
    setBusy(true)
    try {
      if (action === "restart") toast(restartingText(site.name), "info")
      const msg = action === "stop" ? await stopSite(site) : await restartSite(site)
      toast(msg, "success")
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" variant={action === "stop" ? "quiet" : "secondary"} busy={busy} disabled={p.offline}
      onClick={() => void run()} aria-label={`${action === "stop" ? "Stop" : "Restart"} ${site.name}`}>
      {action === "stop" ? "Stop" : "Restart"}
    </Button>
  )
}

const ATT_MARK: Record<AttentionItem["kind"], string> = {
  crashed: "is-error", manifest: "is-error", reload: "is-error", domain: "is-warn", memory: "is-warn", build: "is-info",
}
const ATT_LINK: Partial<Record<AttentionItem["kind"], string>> = {
  manifest: "Open manifest", reload: "Open manifest", domain: "Protect it", memory: "Change limit",
}

/** "Needs attention": at most five items, "and N more" expands; each can be dismissed until its fact changes. */
function Attention(p: { items: AttentionItem[]; sites: Site[]; offline: boolean }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<string[]>(() => parseDismissed(readStorage(DISMISSED_KEY)))
  const [all, setAll] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const items = p.items.filter(i => !dismissed.includes(i.key))
  if (!items.length) return null
  const shown = all ? items : items.slice(0, ATTENTION_MAX)

  const dismiss = (key: string) => {
    // keep only keys that still matter, so the stored list doesn't grow forever
    const live = new Set(p.items.map(i => i.key))
    const next = [...dismissed.filter(k => live.has(k)), key]
    setDismissed(next)
    writeStorage(DISMISSED_KEY, JSON.stringify(next))
  }
  const restart = async (name: string) => {
    const site = p.sites.find(s => s.name === name)
    if (!site) return
    setBusy(name)
    toast(restartingText(name), "info")
    try { toast(await restartSite(site), "success") } catch (e) { toast(e instanceof Error ? e.message : String(e), "error") }
    finally { setBusy(null) }
  }

  return (
    <section className="sites-attention" aria-labelledby="attention-title">
      <h2 className="sites-attention-title" id="attention-title">Needs attention</h2>
      <ul className="sites-attention-list">
        {shown.map(i => (
          <li key={i.key} className="sites-attention-item">
            <span className={`sites-att-mark ${ATT_MARK[i.kind]}`} aria-hidden="true" />
            <span className="sites-att-text">{i.kind === "build" ? <BuildText text={i.text} /> : i.text}</span>
            <span className="sites-att-actions">
              {i.kind === "crashed" && i.href ? <Link to={i.href} className="ui-btn ui-btn-quiet ui-btn-sm">Open</Link> : null}
              {i.action === "restart" && i.name ? (
                <Button size="sm" busy={busy === i.name} disabled={p.offline} onClick={() => void restart(i.name!)}>Restart</Button>
              ) : null}
              {i.href && ATT_LINK[i.kind] ? <Link to={i.href} className="ui-btn ui-btn-secondary ui-btn-sm">{ATT_LINK[i.kind]}</Link> : null}
              <button type="button" className="sites-att-dismiss" aria-label="Dismiss" title="Dismiss until this changes" onClick={() => dismiss(i.key)}>
                <Icon name="x" size={14} />
              </button>
            </span>
          </li>
        ))}
      </ul>
      {items.length > ATTENTION_MAX ? (
        <button type="button" className="sites-attention-more" onClick={() => setAll(a => !a)} aria-expanded={all}>
          {all ? "Show fewer" : `and ${items.length - ATTENTION_MAX} more`}
        </button>
      ) : null}
    </section>
  )
}

/** "… Run bun run web:build." with the command set as code. */
function BuildText(p: { text: string }): React.JSX.Element {
  const m = /^(.*Run )(.+)(\.)$/.exec(p.text)
  if (!m) return <>{p.text}</>
  return <>{m[1]}<Code>{m[2]}</Code>{m[3]}</>
}
