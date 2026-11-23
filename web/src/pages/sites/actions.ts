// Process actions shared by the Sites list and the site header (01 §5 strings, word for word).

import { ApiError, getApi } from "../../api/client.ts"
import { invalidate } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import type { FnStartResponse, PortalCloseResponse, ReloadResponse, RestartResponse } from "../../api/types.ts"
import type { Site } from "../../lib/site.ts"
import type { DeployResponse, StopAnswer } from "./types.ts"

const enc = encodeURIComponent
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function touched(site: Pick<Site, "name" | "fn">): string[] {
  return site.fn ? [KEYS.sites, KEYS.instances(site.name)] : [KEYS.sites]
}

/** POST /process/stop/:name. Resolves to the success text; rejects with the error text. */
export async function stopSite(site: Pick<Site, "name" | "fn">): Promise<string> {
  try {
    const res = await getApi().post<StopAnswer>("/process/stop/" + enc(site.name))
    invalidate(touched(site))
    return res.message || `${site.name} stopped`
  } catch (e) {
    // 200 {success:false} with no error: nothing was running (it exited between a poll and the click).
    // The old page read only `error`, so this is the same "stopped" answer.
    if (e instanceof ApiError && e.status === 200 && isObj(e.data) && e.data.success === false && typeof e.data.error !== "string") {
      invalidate(touched(site))
      return `${site.name} stopped`
    }
    throw new Error(e instanceof Error && e.message ? e.message : "Failed to stop process")
  }
}

/** POST /process/restart/:name */
export async function restartSite(site: Pick<Site, "name" | "fn">): Promise<string> {
  try {
    const res = await getApi().post<RestartResponse>("/process/restart/" + enc(site.name))
    invalidate(touched(site))
    return res.message || `${site.name} restarted`
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : "Failed to restart process")
  }
}

export const restartingText = (name: string): string => `Restarting ${name}…`

/** POST /fn/deploy on the long lane: "<name> deployed <id>" / "Deploy failed: <msg>". */
export async function deploySite(name: string): Promise<string> {
  try {
    const res = await getApi().post<DeployResponse>("/fn/deploy", { name }, { lane: "long" })
    invalidate([KEYS.sites, KEYS.deploys(name), KEYS.instances(name)])
    return `${name} deployed ${res.deploy?.id ?? ""}`.trim()
  } catch (e) {
    throw new Error(`Deploy failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export const deployingText = (name: string): string => `Deploying ${name}…`

/** POST /process/start/:name for a function: warms its hot instances. */
export async function warmUp(name: string): Promise<string> {
  const res = await getApi().post<FnStartResponse>("/process/start/" + enc(name), {})
  invalidate([KEYS.sites, KEYS.instances(name)])
  return res.message || `${name} started`
}

/** POST /portal/close/:name */
export async function closeTunnel(name: string): Promise<string> {
  try {
    const res = await getApi().post<PortalCloseResponse>("/portal/close/" + enc(name))
    invalidate([KEYS.sites, KEYS.stats])
    return res.message || "Portal closed"
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : "Failed to close portal")
  }
}

/** POST /config/reload {} on the long lane. */
export async function reloadAll(): Promise<{ ok: number; total: number; failed: { name: string; error: string }[] }> {
  let res: ReloadResponse
  try {
    res = await getApi().post<ReloadResponse>("/config/reload", {}, { lane: "long" })
  } catch (e) {
    throw new Error(e instanceof Error && e.message ? e.message : "Could not reload")
  }
  invalidate([KEYS.sites])
  const sites = Array.isArray(res.sites) ? res.sites : []
  return {
    ok: sites.filter(s => s.ok).length,
    total: sites.length,
    failed: sites.filter(s => !s.ok).map(s => ({ name: s.name, error: s.error || "Couldn’t read candy.json" })),
  }
}

export const reloadedText = (ok: number, total: number): string => `Read candy.json for ${ok} of ${total} sites`
