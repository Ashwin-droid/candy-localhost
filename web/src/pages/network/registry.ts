// The candy network registry (GET /candy/registry), normalised for the Peers tables. Pure: no DOM.
// Same reading as public/network.html: arrays or the older maps, null host fields treated as absent.

import type { PeerRow, RawRegistry, RawRegistryEntry } from "./types.ts"

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function entriesOf(raw: unknown, side: "local" | "remote"): RawRegistryEntry[] {
  if (Array.isArray(raw)) return raw.filter((e): e is RawRegistryEntry => typeof e === "object" && e !== null)
  if (!raw || typeof raw !== "object") return []
  return Object.entries(raw as Record<string, unknown>).map(([name, v]) => {
    if (side === "local") return { name, ip: typeof v === "string" ? v : "", canonicalFqdn: `${name}.candy`, aliasFqdns: [], winner: true }
    const info = (v && typeof v === "object" ? v : {}) as { ip?: unknown; expiresIn?: unknown }
    return {
      name, ip: typeof info.ip === "string" ? info.ip : "", canonicalFqdn: `${name}.candy`, aliasFqdns: [], winner: true,
      expiresIn: typeof info.expiresIn === "number" ? info.expiresIn : undefined,
    }
  })
}

function row(e: RawRegistryEntry, side: "local" | "remote"): PeerRow | null {
  const name = str(e.name)
  if (!name) return null
  const aliasFqdns = Array.isArray(e.aliasFqdns) ? e.aliasFqdns.filter((a): a is string => typeof a === "string" && !!a) : []
  const canonicalFqdn = str(e.canonicalFqdn)
  // network.html: a local record is always canonical; a remote one is canonical when it won, an alias when it
  // only has alias names, and otherwise shadowed by an earlier exact claim
  const role: PeerRow["role"] = side === "local" || e.winner ? "canonical" : aliasFqdns.length ? "alias" : "shadowed"
  const parts = [str(e.hostLabel) ?? str(e.hostName), str(e.dnsName)].filter((x): x is string => !!x)
  return {
    name: name.toLowerCase(), ip: str(e.ip) ?? "", side, role, canonicalFqdn, aliasFqdns,
    host: parts.length ? parts.join(" · ") : null,
    expiresIn: side === "remote" && typeof e.expiresIn === "number" && Number.isFinite(e.expiresIn) ? e.expiresIn : null,
  }
}

/** Both tables, each sorted by name. Anything malformed is skipped, never thrown on. */
export function normalizeRegistry(raw: unknown): { local: PeerRow[]; remote: PeerRow[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawRegistry
  const pick = (side: "local" | "remote") => entriesOf(r[side], side)
    .map(e => row(e, side)).filter((x): x is PeerRow => !!x)
    .sort((a, b) => a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip))
  return { local: pick("local"), remote: pick("remote") }
}

/** "4m 10s", "35s", "expired" (network.html formatExpiry). */
export function formatExpiry(ms: number): string {
  if (!(ms > 0)) return "expired"
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

export const SHADOWED = "shadowed by an earlier exact claim"

/** The Role column's words. */
export function roleText(r: PeerRow): string {
  return r.role === "shadowed" ? SHADOWED : r.role
}
