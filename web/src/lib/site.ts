// The site model (SPEC §7.3 "Domain model"): one Site per name from the daemon's routes, processes, configs and
// tunnels. Pure: no DOM, no fetch.

import type {
  ConfigInfo, ConfigsResponse, DomainBinding, DomainsResponse, EntriesResponse, FnSummary, PortalInfo, PortalsResponse,
  ProcessInfo, ProcessesResponse, RouteInfo, RoutesResponse, SiteManifestView, StatsResponse, StatusResponse,
  TrafficDomain, Variant,
} from "../api/types.ts"
import type { LampState } from "../ui/StatusDot.tsx"
import { shortPath } from "./format.ts"

export type SiteKind = "server" | "function" | "static" | "forward"

export interface Site {
  name: string; kind: SiteKind
  route?: RouteInfo; proc?: ProcessInfo; config?: ConfigInfo; portal?: PortalInfo
  traffic?: TrafficDomain; entryPort?: number; bindings: DomainBinding[]
  fn: FnSummary | null              // config.fn ?? (route target is {fn} ? FN_UNKNOWN : null)
  noUrl: boolean                    // fn && fn.http === false
  variants: Variant[]               // variantsOf(config)
  status: { state: LampState; label: string }   // siteStatus, 01 §4.3 order exactly
  active: boolean                   // proc running | starting
  owner: string | null              // config.user (null for plain routes)
  manifest: SiteManifestView | null; manifestError: string | null
}

export interface SitesInput {
  status?: StatusResponse; routes?: RoutesResponse; entries?: EntriesResponse
  processes?: ProcessesResponse; configs?: ConfigsResponse; portals?: PortalsResponse; stats?: StatsResponse; domains?: DomainsResponse
}

/** Tab components get the site they belong to. */
export interface TabProps { site: Site }

/** A function route whose config this viewer can't see: a function with unknown details. */
export const FN_UNKNOWN: FnSummary = {
  entry: null, deploy: null, hot: 0, max: 0, linger: 0, log: false, http: true,
  hasWorker: true, source: null, assets: null,
}

/**
 * Names that are never sites: candy's own hosts (the portal itself, the shortcut hosts, candy's host) and
 * anything starting with "_" or "." (CLAUDE.md "Reserved Names"). The portal must never show up as a site.
 */
const RESERVED = new Set(["portal", "p", "kill", "k", "candy"])
export const isReservedName = (name: string): boolean =>
  RESERVED.has(name.toLowerCase()) || name.startsWith("_") || name.startsWith(".")

export function variantsOf(config: ConfigInfo | undefined): Variant[] {
  if (!config) return []
  if (Array.isArray(config.variants) && config.variants.length) return config.variants
  return [{ id: config.id, cwd: config.cwd, cmd: config.cmd, user: config.user, api: config.api }]
}

export function siteKind(s: Pick<Site, "route" | "config" | "proc">): SiteKind {
  const fn = fnOf(s)
  if (fn) return !fn.hasWorker && fn.assets ? "static" : "function"
  if (s.config || s.proc) return "server"
  return "forward"
}

function fnOf(s: Pick<Site, "route" | "config">): FnSummary | null {
  if (s.config?.fn) return s.config.fn
  const t = s.route?.target
  if (t && typeof t === "object" && "fn" in t) return FN_UNKNOWN
  return null
}

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w)

/** 01 §4.3, in order: the process, then a function, then a config, then the route. */
export function siteStatus(s: Site): { state: LampState; label: string } {
  const p = s.proc?.status as string | undefined
  if (p === "running") return { state: "running", label: "Running" }
  if (p === "starting") return { state: "starting", label: "Starting" }
  if (p === "errored") return { state: "crashed", label: "Crashed" }
  if (p === "dead" || p === "stopped") return { state: "stopped", label: "Stopped" }
  if (p) return { state: "idle", label: cap(p) }
  if (s.fn) return { state: "idle", label: "Starts on request" }
  if (s.config) return { state: "idle", label: s.config.api ? "Starts on first request" : "Starts when opened" }
  if (s.route?.isRestricted) return { state: "external", label: "External URL" }
  if (s.traffic?.alive) return { state: "running", label: "Listening" }
  return { state: "idle", label: "Forwarding" }
}

/** Union of names from routes, processes, configs and tunnels, sorted, reserved names left out. */
export function collectSites(i: SitesInput): Site[] {
  const routes = i.routes ?? {}
  const procs = i.processes?.processes ?? {}
  const configs = i.configs?.configs ?? {}
  const portals = i.portals ?? {}
  const entries = i.entries?.entries ?? {}
  const traffic = i.stats?.domains ?? []
  const bindings = i.domains?.configured ? Object.values(i.domains.bindings) : []
  const names = new Set<string>()
  for (const src of [routes, procs, configs, portals]) for (const n of Object.keys(src)) if (!isReservedName(n)) names.add(n)
  return [...names].sort((a, b) => a.localeCompare(b)).map(name => {
    const route = routes[name], proc = procs[name], config = configs[name], portal = portals[name]
    const fn = fnOf({ route, config })
    const m = config?.manifest ?? null
    const manifestError = m && "error" in m ? m.error : null
    const base = {
      name, route, proc, config, portal,
      traffic: traffic.find(d => d.name === name),
      entryPort: typeof entries[name] === "number" ? entries[name] : undefined,
      bindings: bindings.filter(b => b.serverName === name),
      fn,
      noUrl: !!fn && fn.http === false,
      variants: variantsOf(config),
      active: proc?.status === "running" || proc?.status === "starting",
      owner: config?.user ?? null,
      manifest: m && !("error" in m) ? m : null,
      manifestError,
    }
    const site = { ...base, kind: siteKind(base), status: { state: "idle" as LampState, label: "" } } satisfies Site
    site.status = siteStatus(site)
    return site
  })
}

export function siteUrl(name: string, tld: string): string {
  return `https://${name}.${tld}`
}

export interface Address {
  way: "candy" | "machine" | "lan" | "lan-https" | "tailscale" | "public" | "tunnel"
  label: string; url: string | null; note?: string; binding?: DomainBinding; requests?: number
}

/** lan, lanHttps and tsServe come off the route when there is one, else off the config (01 §4.6). */
function reach(s: Site): { lan: boolean; lanHttps: string | null; tsServe: string | null } {
  const src = s.route ?? s.config
  return { lan: !!src?.lan, lanHttps: src?.lanHttps ?? null, tsServe: src?.tsServe ?? null }
}

/** Every way into a site, in the order of the Overview's "Reachable at" table (SPEC §5.4). */
export function addressesOf(s: Site, ctx: { tld: string }): Address[] {
  const out: Address[] = []
  if (!s.noUrl) out.push({ way: "candy", label: "candy", url: siteUrl(s.name, ctx.tld), requests: s.traffic?.total })
  if (s.entryPort) out.push({ way: "machine", label: "This machine", url: `http://127.0.0.1:${s.entryPort}` })
  const r = reach(s)
  if (r.lan) out.push({ way: "lan", label: "LAN", url: `http://${s.name}.candy`, note: "from the local network" })
  if (r.lanHttps) out.push({ way: "lan-https", label: "LAN HTTPS", url: r.lanHttps, note: "trusted certificate" })
  if (r.tsServe && r.tsServe !== r.lanHttps) out.push({ way: "tailscale", label: "Tailscale", url: r.tsServe, note: "tailnet only" })
  for (const b of s.bindings) {
    const ips = b.allowlist?.enabled ? b.allowlist.ips.length : 0
    const note = (b.hasPassword && b.authEnabled ? "Password set" : "No password") + (ips ? ` · ${ips} ${ips === 1 ? "IP" : "IPs"}` : "")
    out.push({ way: "public", label: "Public domain", url: `https://${b.fqdn}`, note, binding: b })
  }
  if (s.portal) {
    const url = s.portal.url || null
    const child = url ? s.traffic?.children.find(c => c.url === url) : undefined
    out.push({ way: "tunnel", label: "Quick tunnel", url, note: url ? undefined : "Opening…", requests: child?.total })
  }
  return out
}

export type TabId = "overview" | "logs" | "requests" | "deployments" | "data" | "manifest" | "settings"

/** The tabs of a site page, in order (SPEC §5.3 table). */
export function tabsFor(s: Site): TabId[] {
  const tabs: TabId[] = ["overview"]
  if (s.kind === "server" || (s.kind !== "static" && s.proc)) tabs.push("logs")
  if (!s.noUrl) tabs.push("requests")
  if (s.fn) tabs.push("deployments")
  if (s.fn && s.kind === "function") tabs.push("data")
  if (s.fn || (s.kind === "server" && s.config)) tabs.push("manifest")
  tabs.push("settings")
  return tabs
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url.replace(/^[a-z]+:\/\//i, "") }
}

/** The list's Address column (SPEC §5.1). */
export function primaryAddress(s: Site): { text: string; mono: boolean } {
  if (s.noUrl) return { text: "no URL", mono: false }
  if (s.kind === "static") return s.fn?.assets ? { text: shortPath(s.fn.assets.directory), mono: true } : { text: "—", mono: false }
  if (s.kind === "function") return s.fn?.entry ? { text: s.fn.entry, mono: true } : { text: "—", mono: false }
  const t = s.route?.target
  if (typeof t === "string") return { text: hostOf(t), mono: true }
  if (typeof t === "number") return { text: `:${t}`, mono: true }
  if (s.proc?.port) return { text: `:${s.proc.port}`, mono: true }
  return { text: "—", mono: false }
}
