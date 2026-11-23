// Rows of the Network tables, from /lan, /routes/serve, the site list and /stats. Pure: no DOM.
// Reserved names (the portal, candy's own hosts) are never rows: they aren't sites.

import type { AdguardStatus, LanResponse, ServesResponse, StatsResponse } from "../../api/types.ts"
import { isReservedName, type Site } from "../../lib/site.ts"

export interface LanRow { name: string; https: { mode: "tailscale" | "domain"; port: number | null; url: string | null } | null }
export interface ServeRow { name: string; port: number; url: string | null; entryPort: number | null }
export interface PortRow { name: string; port: number }
export interface TunnelRow { name: string; url: string | null; port: number; requests: number | null }

/** Sites published to the LAN, with their HTTPS mode when they have one. */
export function lanRows(lan: LanResponse | undefined): LanRow[] | undefined {
  if (!lan) return undefined
  const names = new Set<string>()
  for (const [n, on] of Object.entries(lan.names ?? {})) if (on) names.add(n)
  for (const n of lan.published ?? []) names.add(n)
  return [...names].filter(n => !isReservedName(n)).sort((a, b) => a.localeCompare(b))
    .map(name => ({ name, https: lan.https?.[name] ?? null }))
}

/** "Tailscale :8443" / "Domain certificate" for the HTTPS column. */
export function httpsMode(h: NonNullable<LanRow["https"]>): string {
  return h.mode === "tailscale" ? `Tailscale${h.port ? ` :${h.port}` : ""}` : "Domain certificate"
}

export function serveRows(s: ServesResponse | undefined): ServeRow[] | undefined {
  if (!s) return undefined
  return Object.entries(s.serves ?? {}).filter(([n]) => !isReservedName(n)).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, v]) => ({ name, port: v.port, url: v.url, entryPort: v.entryPort }))
}

export function portRows(sites: Site[] | undefined): PortRow[] | undefined {
  if (!sites) return undefined
  return sites.filter(s => typeof s.entryPort === "number").map(s => ({ name: s.name, port: s.entryPort as number }))
}

/** Open quick tunnels; requests come from the /stats child whose url is the tunnel's. */
export function tunnelRows(sites: Site[] | undefined, stats: StatsResponse | undefined): TunnelRow[] | undefined {
  if (!sites) return undefined
  return sites.filter(s => s.portal).map(s => {
    const url = s.portal?.url || null
    const dom = s.traffic ?? stats?.domains.find(d => d.name === s.name)
    const child = url ? dom?.children.find(c => c.url === url) : undefined
    return { name: s.name, url, port: s.portal!.port, requests: child ? child.total : null }
  })
}

/** The LAN DNS fact: "Linked to <url>, client <client>, <n> names" / "Not linked" / "Sync failed: <error>". */
export function adguardText(a: AdguardStatus | undefined): string | null {
  if (!a) return null
  if (!a.configured) return "Not linked"
  if (a.error) return `Sync failed: ${a.error}`
  const n = a.rules?.length ?? 0
  return `Linked to ${a.url}, client ${a.client}, ${n} ${n === 1 ? "name" : "names"}`
}

/** Where a row of these tables is changed: the site's Reachability settings. */
export const reachHref = (name: string): string => `/sites/${encodeURIComponent(name)}/settings#reach`
