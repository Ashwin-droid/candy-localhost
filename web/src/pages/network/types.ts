// Network pages (SPEC §5.14). LanResponse, ServesResponse, AdguardStatus, RegistryEntry and RegistryResponse are shared
// (api/types.ts); these are the shapes only this area reads.

import type { RegistryEntry } from "../../api/types.ts"

/**
 * /candy/registry as it may arrive: the current daemon sends entry arrays; an older one sent maps
 * (`local: { name: ip }`, `remote: { name: { ip, expiresIn } }`). Host fields may be null or missing.
 */
export type RawRegistryEntry = Partial<RegistryEntry> & { name?: unknown; ip?: unknown }
export interface RawRegistry {
  local?: RawRegistryEntry[] | Record<string, string> | null
  remote?: RawRegistryEntry[] | Record<string, { ip?: string; expiresIn?: number }> | null
}

/** A registry record ready to show. */
export interface PeerRow {
  name: string; ip: string; side: "local" | "remote"
  role: "canonical" | "alias" | "shadowed"
  canonicalFqdn: string | null; aliasFqdns: string[]
  host: string | null              // hostLabel or hostName, then dnsName, joined " · "
  expiresIn: number | null         // ms, remote only
}
