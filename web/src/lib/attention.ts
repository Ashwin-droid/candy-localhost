// The Sites page's "Needs attention" strip (SPEC §5.1). Pure. Order: crashed, candy.json errors, reload errors,
// unprotected public domains, memory near the limit, a stale portal build.
// `key` is kind + name + the fact, so a dismissed item comes back when its fact changes.

import type { DomainsResponse } from "../api/types.ts"
import { fmtMb } from "./format.ts"
import type { Site } from "./site.ts"

export interface AttentionItem {
  key: string; kind: "crashed" | "manifest" | "domain" | "memory" | "build" | "reload"
  text: string; href?: string; action?: "restart"; name?: string
}

const MB = 1048576

export function attentionItems(
  sites: Site[], domains: DomainsResponse | undefined, buildStale: boolean,
  reloadErrors?: { name: string; error: string }[],
): AttentionItem[] {
  const out: AttentionItem[] = []
  const enc = encodeURIComponent

  for (const s of sites) {
    if (s.status.state !== "crashed" || s.fn) continue
    const code = s.proc?.exitCode
    out.push({
      key: `crashed:${s.name}:${code ?? ""}:${s.proc?.pid ?? ""}`, kind: "crashed", name: s.name,
      text: code === null || code === undefined ? `${s.name} crashed` : `${s.name} crashed · exit code ${code}`,
      href: `/sites/${enc(s.name)}`, action: "restart",
    })
  }
  for (const s of sites) {
    if (!s.manifestError) continue
    out.push({
      key: `manifest:${s.name}:${s.manifestError}`, kind: "manifest", name: s.name,
      text: `${s.name}: candy.json has an error (it keeps its old config)`, href: `/sites/${enc(s.name)}/manifest`,
    })
  }
  for (const e of reloadErrors ?? []) {
    out.push({
      key: `reload:${e.name}:${e.error}`, kind: "reload", name: e.name,
      text: `${e.name}: ${e.error} (it keeps its old config)`, href: `/sites/${enc(e.name)}/manifest`,
    })
  }
  if (domains?.configured) {
    for (const b of Object.values(domains.bindings).sort((a, b) => a.fqdn.localeCompare(b.fqdn))) {
      if (b.hasPassword && b.authEnabled) continue
      out.push({
        key: `domain:${b.subdomain}:${b.hasPassword}:${b.authEnabled}`, kind: "domain", name: b.serverName,
        text: `${b.fqdn} has no password. Anyone with the link can open it.`, href: `/public/${enc(b.subdomain)}`,
      })
    }
  }
  for (const s of sites) {
    const used = s.active ? s.proc?.memoryUsed : null
    if (!used) continue
    const limit = s.proc?.memoryMax ?? (s.config?.memoryLimit ? s.config.memoryLimit * MB : null)
    if (!limit || used / limit < 0.9) continue
    out.push({
      key: `memory:${s.name}:${Math.round(limit / MB)}`, kind: "memory", name: s.name,
      text: `${s.name} uses ${fmtMb(used / MB, true)} of its ${fmtMb(Math.round(limit / MB))} limit`,
      href: `/sites/${enc(s.name)}/settings#sandbox`,
    })
  }
  if (buildStale) {
    out.push({ key: "build", kind: "build", text: "The portal is older than its source. Run bun run web:build." })
  }
  return out
}
