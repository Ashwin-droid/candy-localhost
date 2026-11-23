// Pure helpers for the Public domains pages: the words for each protection, site options, warnings. No DOM.

import type { BindWarning, DomainBinding, DomainsResponse } from "../../api/types.ts"
import { siteKind, type Site } from "../../lib/site.ts"
import type { ListboxOption } from "../../ui/index.ts"
import type { ClearWhich } from "./types.ts"

/** Unprotected = no password, or protection switched off. Matches the Attention strip (lib/attention.ts). */
export const isUnprotected = (b: DomainBinding): boolean => !b.hasPassword || !b.authEnabled

/** "Every request" (API mode) / "Login page" / "Not set". */
export function passwordWord(b: DomainBinding): string {
  if (isUnprotected(b)) return "Not set"
  return b.apiMode ? "Every request" : "Login page"
}

/** "Set" / "Needs API mode" / "Not set". */
export function jwtWord(b: DomainBinding): string {
  if (!b.hasJwtSecret) return "Not set"
  return b.apiMode ? "Set" : "Needs API mode"
}

/** Whether the JWT column / section applies at all. */
export const jwtApplies = (b: DomainBinding): boolean => b.apiMode || b.hasJwtSecret

/** "Anyone" / "3 IPs + Tailscale" / "Tailscale". */
export function allowedWord(b: DomainBinding): string {
  const al = b.allowlist ?? { enabled: false, ips: [] }
  if (!al.enabled) return "Anyone"
  const n = al.ips.length
  return `${n ? `${n} IP${n === 1 ? "" : "s"} + ` : ""}Tailscale`
}

/** `which` for removing the password: keep the JWT secret when there is one. */
export const clearPasswordWhich = (b: DomainBinding): ClearWhich => (b.hasJwtSecret ? "password" : "all")
/** `which` for removing the JWT secret: keep the password when there is one. */
export const clearJwtWhich = (b: DomainBinding): ClearWhich => (b.hasPassword ? "jwt" : "all")

/** §5.12 titles for the three /auth/clear variants. */
export function clearTitle(which: ClearWhich, fqdn: string): string {
  const what = which === "jwt" ? "the JWT secret" : which === "password" ? "the password" : "protection"
  return `Remove ${what} for ${fqdn}?`
}

/** The bindings, sorted by domain. Empty when no zone is configured. */
export function bindingsOf(d: DomainsResponse | undefined): DomainBinding[] {
  if (!d || !d.configured) return []
  return Object.values(d.bindings).sort((a, b) => a.fqdn.localeCompare(b.fqdn))
}

/** The Site picker detail: "fn", the route target, ":port" or the first command (01 §8). */
export function siteDetail(s: Site): string {
  if (s.fn) return "fn"
  const t = s.route?.target
  if (typeof t === "string") return t
  if (typeof t === "number") return `:${t}`
  if (s.proc?.port) return `:${s.proc.port}`
  return s.variants[0]?.cmd ?? s.config?.cmd ?? ""
}

/** Every site with a route or a config (the portal and other reserved names are never sites). */
export function bindableSites(sites: Site[] | undefined): ListboxOption[] {
  return (sites ?? [])
    .filter(s => s.route || s.config)
    .map(s => ({ value: s.name, label: s.name, detail: siteDetail(s) || siteKind(s), lamp: s.status.state }))
}

/** A subdomain the daemon accepts: letters, numbers and dashes. */
export const SUBDOMAIN = /^[a-zA-Z0-9-]+$/

/** The warning's records as text lines, "<type> → <content>". Never markup: zone content is untrusted. */
export function recordLines(w: BindWarning): string[] {
  return (w.existingRecords ?? []).map(r => `${String(r.type ?? "")} → ${String(r.content ?? "")}`)
}

/** Allowlist entries from the editor: trimmed, empty ones dropped, duplicates removed. */
export function cleanIps(ips: string[]): string[] {
  const out: string[] = []
  for (const raw of ips) for (const v of raw.split(/[\s,]+/)) if (v && !out.includes(v)) out.push(v)
  return out
}
