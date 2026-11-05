export interface TailscaleNodeIdentity {
  id: string | null
  hostName: string | null
  dnsName: string | null
  hostLabel: string | null
  ips: string[]
}

export interface RemoteRouteClaim {
  name: string
  ip: string
  advertisedAt: number
  claimedAt: number
  ownerId: string | null
  hostName: string | null
  dnsName: string | null
  hostLabel: string | null
}

export interface NetworkRegistryEntry {
  name: string
  ip: string
  hostName: string | null
  dnsName: string | null
  hostLabel: string | null
  canonicalFqdn: string | null
  aliasFqdns: string[]
  winner: boolean
  expiresIn?: number
}

export interface NetworkSnapshot {
  local: NetworkRegistryEntry[]
  remote: NetworkRegistryEntry[]
  dnsRecords: Record<string, string>
}

const CANDY_ACTION_LABELS = new Set(["kill", "k", "portal", "p"])
const CANDY_BUILTIN_NAMES = new Set(["candy", "portal", "p", "kill", "k"])

const uniqueSorted = (values: Iterable<string>): string[] =>
  [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b))

export const normalizeTailscaleDnsName = (dnsName?: string | null): string | null => {
  if (!dnsName) return null
  const normalized = dnsName.trim().toLowerCase().replace(/\.+$/, "")
  return normalized || null
}

export const deriveTailscaleHostLabel = (
  node: Pick<TailscaleNodeIdentity, "hostName" | "dnsName">,
): string | null => {
  const normalizedDnsName = normalizeTailscaleDnsName(node.dnsName)
  const firstLabel = normalizedDnsName?.split(".")[0]
  if (firstLabel) return firstLabel

  if (!node.hostName) return null
  const ascii = node.hostName
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return ascii || null
}

export const buildHostAlias = (name: string, hostLabel?: string | null): string | null => {
  const cleanName = name.trim().toLowerCase()
  const cleanHostLabel = hostLabel?.trim().toLowerCase()
  if (!cleanName || !cleanHostLabel) return null
  const alias = `${cleanName}.${cleanHostLabel}`
  return alias === cleanName ? null : alias
}

export const buildActionSubdomain = (
  name: string,
  action: "kill" | "k" | "portal" | "p",
  hostLabel?: string | null,
): string => {
  const cleanName = name.trim().toLowerCase()
  const cleanHostLabel = hostLabel?.trim().toLowerCase()
  return cleanHostLabel
    ? `${cleanName}.${action}.${cleanHostLabel}`
    : `${cleanName}.${action}`
}

// ---------------------------------------------------------------------------
// LAN publishing
//
// .candy names resolve to the Tailscale IP by default. A name that was opted in
// ("published to LAN") additionally resolves to this machine's LAN IP, but only
// for queries that arrive in the LAN view.
// ---------------------------------------------------------------------------

export type CandyDnsView = "tailnet" | "lan"

const parseIpv4 = (ip: string): number[] | null => {
  const parts = ip.trim().replace(/^::ffff:/i, "").split(".")
  if (parts.length !== 4) return null
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : null
}

// RFC 1918 only. Tailscale's 100.64.0.0/10 and loopback are deliberately not LAN.
export const isPrivateLanIp = (ip: string): boolean => {
  const octets = parseIpv4(ip)
  if (!octets) return false
  const [a, b] = octets
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

// A query gets the LAN view when it arrives on the dedicated LAN listener (a
// front resolver such as AdGuard Home forwards its LAN clients there), or when
// candy-dns is queried directly from an RFC 1918 address.
export const pickCandyDnsView = (
  listener: "default" | "lan",
  sourceIp: string,
): CandyDnsView => (listener === "lan" || isPrivateLanIp(sourceIp) ? "lan" : "tailnet")

// name -> LAN IP for every published local name, plus its host-scoped aliases.
export const buildLanRecords = ({
  published,
  local,
  lanIp,
  tld = "candy",
}: {
  published: Iterable<string>
  local: Iterable<Pick<NetworkRegistryEntry, "name" | "aliasFqdns">>
  lanIp: string | null
  tld?: string
}): Record<string, string> => {
  const records: Record<string, string> = {}
  if (!lanIp) return records

  const publishedSet = new Set([...published].map(name => name.trim().toLowerCase()))
  const suffix = `.${tld}`
  for (const entry of local) {
    if (!publishedSet.has(entry.name)) continue
    records[entry.name] = lanIp
    for (const fqdn of entry.aliasFqdns) {
      if (fqdn.endsWith(suffix)) records[fqdn.slice(0, -suffix.length)] = lanIp
    }
  }
  return records
}

export const resolveCandyDnsRecord = ({
  subdomain,
  records,
  localNames = [],
  hostIp,
  lanRecords,
}: {
  subdomain: string
  records?: Record<string, string>
  localNames?: Iterable<string>
  hostIp: string
  // Pass only for queries in the LAN view. Published names win; everything
  // else (action subdomains, unpublished names) resolves as on the tailnet.
  lanRecords?: Record<string, string>
}): string | null => {
  const requested = subdomain.trim().toLowerCase()
  if (!requested) return null

  if (CANDY_BUILTIN_NAMES.has(requested)) return hostIp

  const lanTarget = lanRecords?.[requested]
  if (lanTarget) return lanTarget

  const localNameSet = new Set(
    [...localNames]
      .filter(Boolean)
      .map(name => name.toLowerCase()),
  )
  const exact = records?.[requested] || (localNameSet.has(requested) ? hostIp : null)
  if (exact) return exact

  const labels = requested.split(".").filter(Boolean)
  if (labels.length < 2 || labels.length > 3 || !CANDY_ACTION_LABELS.has(labels[1])) {
    return null
  }

  const canonicalBase = labels[0]
  const hostScopedBase = labels[2] ? buildHostAlias(canonicalBase, labels[2]) : null

  if (hostScopedBase) {
    const aliasTarget = records?.[hostScopedBase] || (localNameSet.has(hostScopedBase) ? hostIp : null)
    if (aliasTarget) return aliasTarget
  }

  return records?.[canonicalBase] || (localNameSet.has(canonicalBase) ? hostIp : null)
}

export const makeRemoteClaimKey = (name: string, ownerKey: string): string => `${name}@${ownerKey}`

export const resolveLocalCandyRouteName = (
  requestedName: string,
  localNames: Iterable<string>,
  hostLabel?: string | null,
): string => {
  const requested = requestedName.trim().toLowerCase()
  if (!requested) return requested

  const exactNames = new Set(
    [...localNames]
      .filter(Boolean)
      .map(name => name.toLowerCase()),
  )

  if (exactNames.has(requested)) return requested

  const aliasSuffix = hostLabel?.trim().toLowerCase()
  if (!aliasSuffix) return requested

  const suffix = `.${aliasSuffix}`
  if (!requested.endsWith(suffix)) return requested

  const baseName = requested.slice(0, -suffix.length)
  if (baseName && exactNames.has(baseName)) return baseName

  return requested
}

const compareClaims = (left: RemoteRouteClaim, right: RemoteRouteClaim): number => {
  const byName = left.name.localeCompare(right.name)
  if (byName !== 0) return byName

  const byClaimedAt = left.claimedAt - right.claimedAt
  if (byClaimedAt !== 0) return byClaimedAt

  const leftOwner = left.ownerId || left.hostLabel || left.ip
  const rightOwner = right.ownerId || right.hostLabel || right.ip
  return leftOwner.localeCompare(rightOwner)
}

export const buildNetworkSnapshot = ({
  localNames,
  localIp,
  localIdentity,
  remoteClaims,
  ttlMs,
  now = Date.now(),
  tld = "candy",
}: {
  localNames: Iterable<string>
  localIp: string
  localIdentity: Pick<TailscaleNodeIdentity, "hostName" | "dnsName" | "hostLabel">
  remoteClaims: Iterable<RemoteRouteClaim>
  ttlMs: number
  now?: number
  tld?: string
}): NetworkSnapshot => {
  const localNameList = uniqueSorted(
    [...localNames].map(name => name.trim().toLowerCase()),
  )
  const localNameSet = new Set(localNameList)
  const remoteClaimList = [...remoteClaims]
    .filter(claim => claim.name && claim.ip)
    .map(claim => ({
      ...claim,
      name: claim.name.trim().toLowerCase(),
      hostLabel: claim.hostLabel?.trim().toLowerCase() || null,
      dnsName: normalizeTailscaleDnsName(claim.dnsName),
    }))
    .sort(compareClaims)

  const exactNames = new Set<string>(localNameList)
  for (const claim of remoteClaimList) {
    exactNames.add(claim.name)
  }

  const canonicalRemoteByName = new Map<string, RemoteRouteClaim>()
  for (const claim of remoteClaimList) {
    if (!canonicalRemoteByName.has(claim.name)) {
      canonicalRemoteByName.set(claim.name, claim)
    }
  }

  const dnsRecords: Record<string, string> = {}
  for (const name of uniqueSorted(canonicalRemoteByName.keys())) {
    dnsRecords[name] = canonicalRemoteByName.get(name)!.ip
  }
  for (const name of localNameList) {
    dnsRecords[name] = localIp
  }

  const local = localNameList.map((name): NetworkRegistryEntry => {
    const aliasFqdns: string[] = []
    const aliasName = buildHostAlias(name, localIdentity.hostLabel)
    if (aliasName && !exactNames.has(aliasName) && !dnsRecords[aliasName]) {
      dnsRecords[aliasName] = localIp
      aliasFqdns.push(`${aliasName}.${tld}`)
    }

    return {
      name,
      ip: localIp,
      hostName: localIdentity.hostName || null,
      dnsName: normalizeTailscaleDnsName(localIdentity.dnsName),
      hostLabel: localIdentity.hostLabel || null,
      canonicalFqdn: `${name}.${tld}`,
      aliasFqdns,
      winner: true,
    }
  })

  const remote = remoteClaimList.map((claim): NetworkRegistryEntry => {
    const aliasFqdns: string[] = []
    const aliasName = buildHostAlias(claim.name, claim.hostLabel)
    if (aliasName && !exactNames.has(aliasName) && !dnsRecords[aliasName]) {
      dnsRecords[aliasName] = claim.ip
      aliasFqdns.push(`${aliasName}.${tld}`)
    }

    const winner = !localNameSet.has(claim.name) && canonicalRemoteByName.get(claim.name) === claim
    return {
      name: claim.name,
      ip: claim.ip,
      hostName: claim.hostName || null,
      dnsName: claim.dnsName || null,
      hostLabel: claim.hostLabel || null,
      canonicalFqdn: winner ? `${claim.name}.${tld}` : null,
      aliasFqdns,
      winner,
      expiresIn: Math.max(0, ttlMs - (now - claim.advertisedAt)),
    }
  })

  return { local, remote, dnsRecords }
}
