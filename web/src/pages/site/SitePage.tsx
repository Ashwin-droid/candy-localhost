// The site page frame (SPEC §5.3): header (lamp, host, meta, actions), the manifest error line, the deploy
// status line, the tabs that apply to this site, and the tab itself.

import type React from "react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { useSites } from "../../api/sites.ts"
import { isReservedName, siteUrl, tabsFor, type Site, type TabId, type TabProps } from "../../lib/site.ts"
import { navigate, useRoute } from "../../router.tsx"
import { useSession, type Session } from "../../session.tsx"
import { useShortcut } from "../../shared/shortcuts.ts"
import { StartButton, canStart } from "../../shared/StartButton.tsx"
import {
  Button, EmptyState, ErrorState, Host, Icon, Link, PageHeader, Skeleton, StatusDot, Tabs, toast, type TabItem,
} from "../../ui/index.ts"
import { deployingText, deploySite, restartingText, restartSite, stopSite } from "../sites/actions.ts"
import OverviewTab from "./OverviewTab.tsx"
import "./frame.css"

export const SITE_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/

export const TAB_LABEL: Record<TabId, string> = {
  overview: "Overview", logs: "Logs", requests: "Requests", deployments: "Deployments", data: "Data",
  manifest: "Manifest", settings: "Settings",
}

// Overview is part of this module; the other tabs (packages C and D) load on first use, so a tab that
// fails to load is caught by the app's boundary instead of taking the site frame down with it.
const TAB_COMPONENT: Record<TabId, React.ComponentType<TabProps>> = {
  overview: OverviewTab,
  logs: lazy(() => import("./LogsTab.tsx")),
  requests: lazy(() => import("./RequestsTab.tsx")),
  deployments: lazy(() => import("./DeploymentsTab.tsx")),
  data: lazy(() => import("./DataTab.tsx")),
  manifest: lazy(() => import("./ManifestTab.tsx")),
  settings: lazy(() => import("./SettingsTab.tsx")),
}

const KNOWN_TABS = new Set<string>(["logs", "requests", "deployments", "data", "manifest", "settings"])

export const tabPath = (name: string, tab: TabId): string =>
  `/sites/${encodeURIComponent(name)}${tab === "overview" ? "" : `/${tab}`}`

/** params.tab → a TabId, a redirect, or "unknown" (§3.1). */
export function resolveTab(tab: string | undefined, id: string | undefined): TabId | { redirect: "events" | "cron" } | "unknown" {
  if (id !== undefined) return "requests"
  if (tab === undefined || tab === "") return "overview"
  if (tab === "events" || tab === "cron") return { redirect: tab }
  return KNOWN_TABS.has(tab) ? (tab as TabId) : "unknown"
}

/** The header's kind word. */
export function kindWord(s: Site): string {
  if (s.kind === "server") return "Server"
  if (s.kind === "static") return "Function · static"
  if (s.kind === "function") return "Function"
  return "Forward"
}

/** The header's state phrase (§5.3 meta 2). */
export function statePhrase(s: Site): string {
  const p = s.proc
  if (p?.status === "running") return p.uptime ? `Running for ${p.uptime}` : "Running"
  if (p?.status === "starting") return "Starting"
  if (p?.status === "errored") return p.exitCode !== null && p.exitCode !== undefined ? `Crashed, exit code ${p.exitCode}` : "Crashed"
  if (p?.status === "dead") return p.exitCode !== null && p.exitCode !== undefined ? `Stopped, exit code ${p.exitCode}` : "Stopped"
  if (s.fn) {
    if (s.fn.deploy) return `Pinned deploy ${s.fn.deploy}`
    if (s.fn.source === "live" || s.config) return "Live from source"
    return "Starts on request"
  }
  return s.status.label
}

/** Which header actions apply (§5.3 table). The rules key off the records, not the kind. */
export function headerActions(s: Site): { deploy: boolean; start: boolean; restart: boolean; stop: boolean } {
  return { deploy: !!s.fn, start: canStart(s), restart: !!s.proc, stop: s.active }
}

export function siteTitle(s: Pick<Site, "name" | "noUrl">, tld: string, tab: TabId): string {
  const host = s.noUrl ? s.name : `${s.name}.${tld}`
  return `${host}${tab === "overview" ? "" : ` ${tab}`} – candy`
}

export function runsAs(s: Site, session: Pick<Session, "multiUser" | "user">): string | null {
  return session.multiUser && s.owner && s.owner !== session.user ? `Runs as ${s.owner}` : null
}

export default function SitePage(): React.JSX.Element {
  const route = useRoute()
  const name = (route.params.name ?? "").toLowerCase()
  if (!SITE_NAME.test(name)) return <NoSuchPage />
  return <SiteFrame name={name} />
}

function NoSuchPage(): React.JSX.Element {
  useEffect(() => { document.title = "Not found – candy" }, [])
  return (
    <>
      <PageHeader back={{ to: "/", label: "Sites" }} title="Not found" />
      <EmptyState action={<Link to="/" className="ui-btn ui-btn-secondary">Back to Sites</Link>}>There’s nothing here.</EmptyState>
    </>
  )
}

function SiteFrame(p: { name: string }): React.JSX.Element {
  const route = useRoute()
  const session = useSession()
  const { sites, error, offline } = useSites()
  const site = sites ? sites.find(s => s.name === p.name) ?? null : undefined
  const resolved = resolveTab(route.params.tab, route.params.id)
  const tabs = site ? tabsFor(site) : []

  // Redirects: events/cron → manifest anchors; an unknown or absent tab → Overview
  const redirect = typeof resolved === "object"
    ? `${tabPath(p.name, "manifest")}#${resolved.redirect}`
    : resolved === "unknown" || (site && resolved !== "overview" && !tabs.includes(resolved)) ? tabPath(p.name, "overview") : null
  useEffect(() => { if (redirect) navigate(redirect, { replace: true }) }, [redirect])

  const tab: TabId = typeof resolved === "string" && resolved !== "unknown" && (!site || tabs.includes(resolved)) ? resolved : "overview"

  useEffect(() => {
    document.title = site ? siteTitle(site, session.tld, tab) : `${p.name}.${session.tld} – candy`
  }, [site?.name, site?.noUrl, session.tld, tab, p.name])

  // 1–8 switch tabs
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const go = (i: number) => { const t = tabsRef.current[i]; if (t) navigate(tabPath(p.name, t)) }
  useShortcut("1", () => go(0)); useShortcut("2", () => go(1)); useShortcut("3", () => go(2)); useShortcut("4", () => go(3))
  useShortcut("5", () => go(4)); useShortcut("6", () => go(5)); useShortcut("7", () => go(6)); useShortcut("8", () => go(7))

  if (site === undefined) {
    return (
      <div className="site-page">
        <PageHeader back={{ to: "/", label: "Sites" }} title={<Host name={p.name} tld={session.tld} size="xl" />} />
        {error ? <ErrorState error={error} /> : <Skeleton rows={4} />}
      </div>
    )
  }

  if (site === null) {
    const reserved = isReservedName(p.name)
    return (
      <div className="site-page">
        <PageHeader back={{ to: "/", label: "Sites" }} title={<Host name={p.name} tld={session.tld} size="xl" />} />
        <EmptyState action={<>
          <Link to="/" className="ui-btn ui-btn-secondary">Back to Sites</Link>
          {reserved ? null : <Link to={`/?add=${encodeURIComponent(p.name)}`} className="ui-btn ui-btn-primary">Add it</Link>}
        </>}>
          There is no site called {p.name}. It may have been renamed or deleted.
        </EmptyState>
      </div>
    )
  }

  const items: TabItem[] = tabs.map(t => ({ to: tabPath(site.name, t), label: TAB_LABEL[t], active: t === tab }))
  const Tab = TAB_COMPONENT[tab]

  return (
    <div className="site-page">
      <SiteHeader site={site} offline={offline} />
      <Tabs items={items} label={`${site.name} sections`} />
      <div className="site-tab" key={tab}>
        <Suspense fallback={<Skeleton rows={4} />}>
          <Tab site={site} />
        </Suspense>
      </div>
    </div>
  )
}

type Line = { text: string; kind: "info" | "ok" | "error" } | null

function SiteHeader(p: { site: Site; offline: boolean }): React.JSX.Element {
  const { site, offline } = p
  const session = useSession()
  const [line, setLine] = useState<Line>(null)
  const [busy, setBusy] = useState<"deploy" | "restart" | "stop" | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setLine(null) }, [site.name])

  const act = async (what: "deploy" | "restart" | "stop") => {
    setBusy(what)
    setLine(what === "deploy" ? { text: deployingText(site.name), kind: "info" }
      : what === "restart" ? { text: restartingText(site.name), kind: "info" } : null)
    try {
      const msg = what === "deploy" ? await deploySite(site.name) : what === "restart" ? await restartSite(site) : await stopSite(site)
      if (mounted.current) setLine({ text: msg, kind: "ok" })
      else toast(msg, "success")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (mounted.current) setLine({ text: msg, kind: "error" })
      else toast(msg, "error")
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  const a = headerActions(site)
  const onlyDeploy = a.deploy && !a.start && !a.restart && !a.stop
  const meta = [
    kindWord(site),
    <span key="state" className={site.status.state === "crashed" ? "cherry" : undefined}>{statePhrase(site)}</span>,
    runsAs(site, session),
  ].filter(Boolean) as React.ReactNode[]

  return (
    <>
      <PageHeader
        back={{ to: "/", label: "Sites" }}
        lead={<StatusDot state={site.status.state} label={site.status.label} />}
        title={<Host name={site.name} tld={site.noUrl ? null : session.tld} size="xl" />}
        external={site.noUrl ? null : siteUrl(site.name, session.tld)}
        meta={meta}
        actions={a.deploy || a.start || a.restart || a.stop ? <>
          {a.deploy ? (
            <Button variant={onlyDeploy ? "primary" : "secondary"} busy={busy === "deploy"} disabled={offline} onClick={() => void act("deploy")}>
              {busy === "deploy" ? "Deploying…" : "Deploy"}
            </Button>
          ) : null}
          {a.start && !offline ? <StartButton site={site} /> : null}
          {a.restart ? <Button busy={busy === "restart"} disabled={offline} onClick={() => void act("restart")}>Restart</Button> : null}
          {a.stop ? <Button busy={busy === "stop"} disabled={offline} onClick={() => void act("stop")}>Stop</Button> : null}
        </> : undefined}
      />
      {site.manifestError ? (
        <p className="site-manifest-error" role="alert">
          <span>candy.json has an error. It keeps its old config.</span>
          <Link to={`${tabPath(site.name, "manifest")}`} className="site-inline-link">See it</Link>
        </p>
      ) : null}
      {line ? (
        <p className={`site-line is-${line.kind}`} role="status">
          <span>{line.text}</span>
          {busy ? null : (
            <button type="button" className="site-line-close" aria-label="Dismiss" onClick={() => setLine(null)}><Icon name="x" size={12} /></button>
          )}
        </p>
      ) : null}
    </>
  )
}
