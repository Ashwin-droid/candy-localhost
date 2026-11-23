// The site list and the keys several pages share (SPEC §7.4).

import { useMemo } from "react"
import { collectSites, type Site, type SitesInput } from "../lib/site.ts"
import { ApiError, getApi } from "./client.ts"
import { usePeek, useResource } from "./resources.ts"
import type {
  ConfigsResponse, DomainsResponse, EntriesResponse, PortalsResponse, ProcessesResponse, RoutesResponse, StatsResponse,
  StatusResponse,
} from "./types.ts"

export const KEYS = {
  sites: "sites", stats: "stats", domains: "domains", me: "me", users: "users",
  deploys: (name: string) => `fn/deploys:${name}`, instances: (name: string) => `fn/instances:${name}`,
  traffic: (name: string) => `traffic:${name}`,
} as const

/** What the `sites` key caches: the six answers collectSites needs (stats and domains come from their own keys). */
export type SitesData = Pick<SitesInput, "status" | "routes" | "entries" | "processes" | "configs" | "portals">

/** Six parallel GETs. /status failing means the daemon is offline. */
export async function fetchSites(signal?: AbortSignal): Promise<SitesData> {
  const api = getApi()
  const o = { signal }
  const [status, routes, entries, processes, configs, portals] = await Promise.all([
    api.get<StatusResponse>("/status", undefined, o),
    api.get<RoutesResponse>("/routes", undefined, o),
    api.get<EntriesResponse>("/routes/entry", undefined, o),
    api.get<ProcessesResponse>("/processes", undefined, o),
    api.get<ConfigsResponse>("/configs", undefined, o),
    api.get<PortalsResponse>("/portals", undefined, o),
  ])
  return { status, routes, entries, processes, configs, portals }
}

/**
 * Every site this viewer may see. `offline` = the last poll couldn't reach the daemon (data stays).
 * The cached `sites` value may also be primed as a ready Site[] in render tests.
 */
export function useSites(): { sites?: Site[]; status?: StatusResponse; error?: ApiError; loading: boolean; updatedAt?: number; offline: boolean } {
  const r = useResource<SitesData | Site[]>(KEYS.sites, fetchSites, { every: 5000 })
  const stats = usePeek<StatsResponse>(KEYS.stats)
  const domains = usePeek<DomainsResponse>(KEYS.domains)
  const sites = useMemo(() => {
    if (!r.data) return undefined
    if (Array.isArray(r.data)) return r.data
    return collectSites({ ...r.data, stats, domains })
  }, [r.data, stats, domains])
  const status = r.data && !Array.isArray(r.data) ? r.data.status : undefined
  return { sites, status, error: r.error, loading: r.loading, updatedAt: r.updatedAt, offline: r.error?.status === 0 }
}

export function useSite(name: string): { site?: Site | null /* null = not found after load */; loading: boolean; error?: ApiError } {
  const { sites, loading, error } = useSites()
  const site = sites ? sites.find(s => s.name === name) ?? null : undefined
  return { site, loading, error }
}

export function useStats(): { data?: StatsResponse } {
  const r = useResource<StatsResponse>(KEYS.stats, signal => getApi().get<StatsResponse>("/stats", undefined, { signal }), { every: 15_000 })
  return { data: r.data }
}

export function useDomains(): { data?: DomainsResponse; error?: ApiError; reload(): Promise<void> } {
  const r = useResource<DomainsResponse>(KEYS.domains, signal => getApi().get<DomainsResponse>("/domains", undefined, { signal }), { every: 30_000 })
  return { data: r.data, error: r.error, reload: r.reload }
}
