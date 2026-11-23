// Pure rules of the Settings pages (no DOM), unit-tested in settings.test.tsx.

import type { AdguardStatus, DomainsResponse, PublicMcpStatus } from "../../api/types.ts"
import { fmtDate } from "../../lib/format.ts"
import type { DomainConfigBody } from "./types.ts"

/** A passkey change needs a password login from the last 10 minutes; 5 s of slack so it can't lapse in flight. */
export function needsPassword(pamUntil: number | null, now: number = Date.now()): boolean {
  return pamUntil === null || pamUntil <= now + 5000
}

/** "21 Nov 2026" (the old page's medium date), "never" for a missing time. */
export function fmtDay(t: number | null | undefined): string {
  if (typeof t !== "number") return "never"
  const s = fmtDate(t)
  return s ? s.split(",")[0] : "never"
}

/** Full local date and time, "never" for a missing time. */
export function fmtWhen(t: number | null | undefined): string {
  if (typeof t !== "number") return "never"
  return fmtDate(t) || "never"
}

export interface ZoneDraft { [k: string]: unknown; domain: string; tunnel: string; tunnelId: string; credentials: string }

export function zoneDraftOf(d: DomainsResponse | undefined): ZoneDraft {
  if (!d || !d.configured) return { domain: "", tunnel: "", tunnelId: "", credentials: "" }
  return { domain: d.zone?.domain ?? "", tunnel: d.tunnel?.name ?? "", tunnelId: d.tunnel?.id ?? "", credentials: d.tunnel?.credentialsFile ?? "" }
}

export const ZONE_EMPTY = "Enter a zone or a tunnel name."

/**
 * POST /domains/config body (portal-settings.html l.1110-1112): `zone` when a domain is given, keeping the old
 * zone id only while the domain is unchanged; `tunnel` when the tunnel name or id is given.
 */
export function zoneBody(draft: ZoneDraft, current: DomainsResponse | undefined): { body: DomainConfigBody } | { error: string } {
  const domain = draft.domain.trim()
  const name = draft.tunnel.trim()
  const id = draft.tunnelId.trim()
  const credentialsFile = draft.credentials.trim()
  if (!domain && !name) return { error: ZONE_EMPTY }
  const old = current && current.configured ? current.zone : null
  const body: DomainConfigBody = {}
  if (domain) body.zone = { domain, id: old && domain === old.domain ? old.id || "" : "" }
  if (name || id) body.tunnel = { name, id, credentialsFile }
  return { body }
}

/** The MCP clients that are signed in now (the old page counted only these). */
export function signedInClients(st: PublicMcpStatus | undefined): PublicMcpStatus["clients"] {
  return (Array.isArray(st?.clients) ? st.clients : []).filter(c => c.activeGrants > 0)
}

/** The address without https://, as the old page showed it. */
export function mcpAddress(st: PublicMcpStatus): string {
  return String(st.url || st.wouldBe || "").replace(/^https:\/\//, "")
}

export function rotateText(r: { site: string; kid: string; restartNeeded?: string[] }): string {
  const names = Array.isArray(r.restartNeeded) ? r.restartNeeded : []
  return `${r.site} has a new key (${r.kid}).` + (names.length
    ? ` Restart ${names.join(", ")} to give it the new key (apps using the SDK pick it up within 5 minutes).` : "")
}

export function revokeText(r: { site: string; approvals?: number; restartNeeded?: string[] }): string {
  const n = Number(r.approvals) || 0
  const names = Array.isArray(r.restartNeeded) ? r.restartNeeded : []
  return `Revoked the key of ${r.site}` + (n ? ` and ${n} approval${n === 1 ? "" : "s"}.` : ".")
    + (names.length ? ` Restart ${names.join(", ")}: a running server keeps the old key in memory until then.` : "")
}

/** The three paragraphs of the Revoke confirm (portal-settings.html l.909-915). */
export function revokeConfirmBody(site: string, enabled: boolean): string[] {
  return [
    `The key and everyone’s approvals of ${site} are deleted. Nobody can sign in to it with candy until it has a new key.`,
    enabled
      ? `${site} still asks for sign-in in its candy.json, so it gets a new key the next time it starts.`
      : `${site} doesn’t ask for sign-in, so it gets no new key.`,
    "A running server keeps the old key in memory until it restarts.",
  ]
}

/** The facts of the AdGuard Home section. `null` status = the GET failed. */
export function adguardFacts(ag: AdguardStatus | null): { label: string; value: string }[] {
  const linked = !!ag?.configured
  const facts = [{ label: "Status", value: linked ? "Linked" : ag ? "Not linked" : "Couldn’t load" }]
  if (ag && ag.configured) {
    facts.push({ label: "Client", value: ag.client })
    const rules = Array.isArray(ag.rules) ? ag.rules : []
    facts.push({ label: "Names", value: rules.length ? `${rules.length} to ${ag.dnsTarget}: ${rules.join(", ")}` : "None right now" })
    if (ag.error) facts.push({ label: "Sync", value: "Failed: " + ag.error })
  }
  return facts
}
