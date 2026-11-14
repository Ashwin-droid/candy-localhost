// Pieces of the generated Caddyfile and cloudflared config, and the checks on
// every value that gets written into them. Pure, so tests can run the output
// through `caddy adapt` without a daemon.
//
// Everything interpolated into a Caddyfile is a token: a space, a brace, a
// quote or a newline in a name would end it and start a directive of the
// caller's choosing (e.g. `file_server` on /). So each value is checked
// against a strict shape here, and anything else is left out of the file.

/** One DNS label, lower case: subdomains of a bound zone, the public MCP subdomain. */
export const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
export const isDnsLabel = (s: unknown): s is string => typeof s === "string" && DNS_LABEL.test(s)

/** A zone like example.com: two or more DNS labels, at most 253 characters. */
export const isZoneName = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 253 && s.split(".").length >= 2 && s.split(".").every(l => DNS_LABEL.test(l))

/** A host name made of labels (site names may carry dots and underscores). */
export const isHostName = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 253 && /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/i.test(s)

export const isZoneId = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{32}$/.test(s)
export const isTunnelId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
export const isTunnelName = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)
/** An absolute path without spaces, quotes, `#`, `:` or `..` (cloudflared reads it as YAML). */
export const isCredentialsPath = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 512 && /^\/[A-Za-z0-9._\/@+-]+$/.test(s) && !s.split("/").includes("..")

/** An IP address or CIDR as Caddy's bind / client_ip take it. */
export const isIpOrCidr = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 49 && /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(s) && /[.:]/.test(s)

const ipv4 = (h: string): number[] | null => {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  const n = m?.slice(1).map(Number)
  return n && n.every(x => x <= 255) ? n : null
}

/** An IPv6 address as eight numbers (embedded IPv4 included), or null. */
const ipv6 = (h: string): number[] | null => {
  const v4 = h.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4) {
    const n = ipv4(v4[2])
    if (!n) return null
    h = `${v4[1]}${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`
  }
  const halves = h.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const groups = [...head, ...Array(fill).fill("0"), ...tail]
  return groups.every(g => /^[0-9a-f]{1,4}$/i.test(g)) ? groups.map(g => parseInt(g, 16)) : null
}

/**
 * This machine, however it's spelled: 127/8, 0/8, ::1, ::, v4-mapped forms.
 * A name whose last label is a number (127.1, 2130706433, 0x7f.1) isn't a DNS
 * name but some resolvers read it as an address, so it counts as local too.
 */
const isLocalAddress = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (h.includes(":")) {
    const g = ipv6(h)
    if (!g) return true
    if (g.slice(0, 7).every(x => x === 0) && g[7] <= 1) return true
    if ((g[0] & 0xffc0) === 0xfe80) return true  // link-local
    if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return g[6] >> 8 === 127 || g[6] >> 8 === 0
    return false
  }
  const v4 = ipv4(h)
  // Link-local covers the cloud metadata address (169.254.169.254)
  if (v4) return v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254)
  return /^(\d+|0x[0-9a-f]*)$/.test(h.split(".").pop() ?? "")
}

/**
 * A reverse_proxy upstream: localhost:<port> / 127.0.0.1:<port> (what the
 * daemon writes for a server's port), or an http(s) origin with no path that
 * isn't this machine. A user's route or bound domain pointing at
 * https://portal.localhost, a *.candy site, loopback or one of this
 * machine's own addresses (`ownAddresses`: LAN, tailnet) would let a public
 * domain reach the portal or another user's site through Caddy.
 */
export const isCaddyUpstream = (s: unknown, ownAddresses: readonly (string | null | undefined)[] = []): s is string => {
  if (typeof s !== "string" || s.length > 300) return false
  const port = (p: string | undefined) => p === undefined || (Number(p) >= 1 && Number(p) <= 65535)
  const local = s.match(/^(?:localhost|127\.0\.0\.1):(\d{1,5})$/)
  if (local) return port(local[1])
  const url = s.match(/^https?:\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/)
  if (!url || !port(url[2])) return false
  const host = url[1].toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host === "candy" || host.endsWith(".candy")) return false
  if (isLocalAddress(host)) return false
  const own = ownAddresses.filter((a): a is string => typeof a === "string" && a.length > 0).map(a => a.toLowerCase())
  return !own.includes(host.replace(/^\[|\]$/g, ""))
}

/** A trycloudflare.com quick-tunnel URL, as cloudflared prints it. */
export const isQuickTunnelUrl = (s: unknown): s is string =>
  typeof s === "string" && /^https:\/\/[a-z0-9-]{1,63}\.trycloudflare\.com$/.test(s)

// ----------------------------------------------------------------------------
// Bound domains
// ----------------------------------------------------------------------------

export interface BindingLike {
  subdomain: string
  fqdn: string
  serverName: string
  allowlist?: { enabled: boolean; ips: string[] }
  [k: string]: unknown
}

/**
 * The bindings that are safe to write into Caddy and cloudflared: key and
 * subdomain one lower-case DNS label, fqdn exactly `<sub>.<zone>`, a valid
 * site name, allowlist entries that are addresses. Everything else is
 * returned in `dropped` with why, so the daemon can audit it.
 */
export const checkBindings = <B extends BindingLike>(
  bindings: Record<string, B> | null | undefined,
  zone: string,
  isName: (name: string) => boolean,
): { kept: Record<string, B>; dropped: { key: string; why: string }[] } => {
  const kept: Record<string, B> = {}
  const dropped: { key: string; why: string }[] = []
  for (const [key, b] of Object.entries(bindings ?? {})) {
    const why = !b || typeof b !== "object" ? "not an object"
      : !isDnsLabel(key) ? "the subdomain isn't one DNS label"
      : b.subdomain !== key ? "the subdomain doesn't match its key"
      : !isZoneName(zone) ? "the zone isn't a domain name"
      : b.fqdn !== `${key}.${zone}` ? "the domain isn't <subdomain>.<zone>"
      : typeof b.serverName !== "string" || !isName(b.serverName) ? "the site name isn't valid"
      : b.allowlist && (!Array.isArray(b.allowlist.ips) || !b.allowlist.ips.every(isIpOrCidr)) ? "an allowlist entry isn't an address"
      : null
    if (why) dropped.push({ key: String(key).slice(0, 80), why })
    else kept[key] = b
  }
  return { kept, dropped }
}

// ----------------------------------------------------------------------------
// Caddyfile pieces
// ----------------------------------------------------------------------------

/** The admin API on a unix socket only Caddy's user (root) can open; never on localhost:2019. */
export const caddyAdminAddress = (socket: string): string => `unix/${socket}|0600`

/**
 * Headers the access log must never hold: the portal's session secret and
 * page tokens, API keys, bound-domain credentials, the per-boot proxy tag,
 * cookies. Caddy logs header names in Go's canonical form.
 */
export const LOG_REDACTED_REQUEST_HEADERS = [
  "X-Candy-Session", "X-Candy-Token", "X-Candy-Api-Key", "X-Candy-Auth", "X-Candy-Proxy", "X-Candy-Verified",
  "Authorization", "Proxy-Authorization", "Cookie", "X-Auth-Token",
] as const
export const LOG_REDACTED_RESPONSE_HEADERS = ["Set-Cookie"] as const
/**
 * Query parameters dropped from the logged URI. Sign in with candy never puts
 * its token in a URL (it is a form POST), but an app that misuses the SDK, or
 * a hand-made link, must not get a live login token into the log either.
 */
export const LOG_REDACTED_QUERY_PARAMS = ["candy_token"] as const

export const caddyGlobalBlock = (o: { adminSocket: string; accessLog: string }): string => {
  if (!o.adminSocket.startsWith("/") || /[\s{}"'#|]/.test(o.adminSocket)) throw new Error(`bad admin socket path: ${o.adminSocket}`)
  if (!o.accessLog.startsWith("/") || /[\s{}"'#]/.test(o.accessLog)) throw new Error(`bad access log path: ${o.accessLog}`)
  const drop = [
    ...LOG_REDACTED_REQUEST_HEADERS.map(h => `        request>headers>${h} delete`),
    ...LOG_REDACTED_RESPONSE_HEADERS.map(h => `        resp_headers>${h} delete`),
    `        request>uri query {`,
    ...LOG_REDACTED_QUERY_PARAMS.map(q => `          delete ${q}`),
    `        }`,
  ].join("\n")
  return `{
  # Admin API on a 0600 unix socket: on localhost:2019 any local user could load a config into this root Caddy
  admin ${caddyAdminAddress(o.adminSocket)}
  # The default logger, which every site's \`log\` uses: secrets in headers are
  # dropped before they're written, and the file is the daemon's alone
  log {
    output file ${o.accessLog} {
      mode 0600
    }
    format filter {
      wrap json
      fields {
${drop}
      }
    }
  }
  # Tunnel traffic arrives from cloudflared on loopback; take the visitor's IP
  # from Cloudflare's header (used by allowlists via client_ip)
  servers {
    trusted_proxies static 127.0.0.1/8 ::1
    client_ip_headers Cf-Connecting-Ip
    # No fronting: over TLS the Host header must be the name the connection
    # was opened for (SNI), or Caddy answers 421. A connection made as one
    # site can't be used to ask for another (the portal, say).
    strict_sni_host on
  }
}
`
}

/**
 * Runs `fn` one at a time. A call made while one is running waits for a single
 * run that starts after it (shared by everyone waiting), so a burst of calls
 * costs two runs, never an overlap, and every caller's change is covered.
 */
export const coalesced = (fn: () => Promise<void>): (() => Promise<void>) => {
  let tail: Promise<void> = Promise.resolve()
  let queued: Promise<void> | null = null
  return () => {
    if (queued) return queued
    const run = tail.then(() => { queued = null; return fn() })
    queued = run
    tail = run.catch(() => {})
    return run
  }
}

/** The header Caddy puts on everything it sends the daemon, so the daemon can tell Caddy from any other local caller. */
export const PROXY_TAG_HEADER = "X-Candy-Proxy"

/**
 * Adds `header_up X-Candy-Proxy <tag>` to every reverse_proxy / forward_auth
 * to the daemon (localhost:9999). header_up replaces whatever the client sent,
 * so the tag can't be forged through Caddy.
 */
export const tagDaemonUpstreams = (content: string, tag: string): string => {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(tag)) throw new Error("bad proxy tag")
  const line = `${PROXY_TAG_HEADER} ${tag}`
  return content
    // Ones that already have a block (header_up Host ..., forward_auth) get the line first.
    // In this order, so the blocks made below aren't tagged twice.
    .replace(/^([ \t]*)(reverse_proxy|forward_auth) localhost:9999 \{[ \t]*$/gm, (m, pad: string) => `${m}\n${pad}  header_up ${line}`)
    // A bare `reverse_proxy localhost:9999` line gets a block
    .replace(/^([ \t]*)reverse_proxy localhost:9999[ \t]*$/gm, (_m, pad: string) => `${pad}reverse_proxy localhost:9999 {\n${pad}  header_up ${line}\n${pad}}`)
}

/**
 * What the daemon does to every request before any route: the tag is removed
 * (no route, function or server can see or replay it), and from anyone but
 * our Caddy the forwarding headers go too, so nothing later mistakes them
 * for Caddy's.
 */
export const stripProxyHeaders = (headers: Headers, fromOwnCaddy: boolean): void => {
  headers.delete(PROXY_TAG_HEADER)
  if (fromOwnCaddy) return
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-forwarded-") || name.startsWith("cf-") || name === "forwarded") headers.delete(name)
  }
}

/** `bind` for the *.localhost sites: this machine only, so the LAN and the tailnet can't reach them with --resolve. */
export const loopbackBind = (hasIpv6Loopback: boolean): string => `bind 127.0.0.1${hasIpv6Loopback ? " ::1" : ""}`

// ----------------------------------------------------------------------------
// cloudflared
// ----------------------------------------------------------------------------

/** cloudflared's config, or null when the tunnel settings aren't safe to write. Bad hostnames are left out. */
export const cloudflaredYaml = (tunnel: { id: string; credentialsFile: string }, hostnames: string[]): string | null => {
  if (!isTunnelId(tunnel.id) || !isCredentialsPath(tunnel.credentialsFile)) return null
  let yaml = `tunnel: ${tunnel.id}\ncredentials-file: ${tunnel.credentialsFile}\n\ningress:\n`
  for (const h of hostnames) {
    if (!isZoneName(h)) continue
    yaml += `  - hostname: ${h}\n    service: http://localhost:80\n`
  }
  // Catch-all must always be last
  yaml += `  - service: http_status:404\n`
  return yaml
}

// ----------------------------------------------------------------------------
// Site names
// ----------------------------------------------------------------------------

/**
 * Hosts are case-insensitive, so names are lower case everywhere: otherwise
 * "Victim" is a second name that Caddy and the browser treat as "victim".
 * ASCII only: toLowerCase() would turn the Kelvin sign into "k".
 */
export const lowerName = <T>(s: T): T => (typeof s === "string" ? s.replace(/[A-Z]+/g, c => c.toLowerCase()) as T : s)

/** The labels of the shortcut hosts: <name>.kill|k|portal|p.<label?>.<tld>. */
export const SHORTCUT_LABELS: ReadonlySet<string> = new Set(["kill", "k", "portal", "p"])

/**
 * Why a new name can't be taken, or null. On top of the reserved names: a
 * name with a kill/k/portal/p label, or one ending in .<hostLabel>, is the
 * address of a shortcut or alias host the daemon generates for someone else's
 * site (foo.kill.<hostLabel>.candy).
 */
export const newNameProblem = (name: string, hostLabel: string | null, reserved: ReadonlySet<string>): string | null => {
  const n = name.toLowerCase()
  if (reserved.has(n)) return "That name is reserved."
  if (n.split(".").some(l => SHORTCUT_LABELS.has(l))) return "Names can't have a kill, k, portal or p part: those are shortcut hosts."
  if (hostLabel && (n === hostLabel.toLowerCase() || n.endsWith(`.${hostLabel.toLowerCase()}`))) return `Names can't end in .${hostLabel}: that's this machine's alias for its sites.`
  return null
}

/**
 * Stored names, lower-cased. When two spellings meet, the first one kept is
 * the first in the file; the others are returned so the daemon can audit them.
 */
export const mergeLowerCase = <V>(entries: Iterable<[string, V]>): { kept: Map<string, V>; dropped: string[]; renamed: [string, string][] } => {
  const kept = new Map<string, V>()
  const dropped: string[] = []
  const renamed: [string, string][] = []
  for (const [name, value] of entries) {
    const lower = lowerName(name)
    if (kept.has(lower)) { dropped.push(name); continue }
    kept.set(lower, value)
    if (lower !== name) renamed.push([name, lower])
  }
  return { kept, dropped, renamed }
}

// ----------------------------------------------------------------------------
// One site per address
// ----------------------------------------------------------------------------

/** Put on the line before a block the daemon makes for itself (shortcut and alias hosts, catch-alls). */
export const SYSTEM_BLOCK_MARK = "# candy:system"

const addressKey = (a: string) => a.trim().toLowerCase().replace(/^https:\/\//, "").replace(/:443$/, "")

/**
 * Two blocks with the same address make `caddy adapt` fail ("ambiguous site
 * definition"), and Caddy then keeps its old config for good. So each address
 * is kept once: a system block (SYSTEM_BLOCK_MARK) wins over a user's, and
 * otherwise the first one wins. A block left with no address is dropped.
 */
export const dedupeSiteAddresses = (content: string): { content: string; skipped: string[] } => {
  const lines = content.split("\n")
  type Site = { start: number; end: number; addrs: string[]; system: boolean }
  const sites: Site[] = []
  let depth = 0
  let open: Site | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (depth === 0) {
      const m = line.match(/^(\S[^{}]*?)\s*\{\s*$/)
      if (m) {
        let p = i - 1
        while (p >= 0 && lines[p].trim() === "") p--
        open = { start: i, end: i, addrs: m[1].split(",").map(s => s.trim()).filter(Boolean), system: p >= 0 && lines[p].trim() === SYSTEM_BLOCK_MARK }
      }
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0)
    if (depth === 0 && open) {
      open.end = i
      sites.push(open)
      open = null
    }
  }

  const systemAddrs = new Set(sites.filter(s => s.system).flatMap(s => s.addrs.map(addressKey)))
  const seen = new Set<string>()
  const skipped: string[] = []
  const replace = new Map<number, string | null>()  // start line -> new opener, or null to drop the block
  for (const site of sites) {
    const keep = site.addrs.filter(a => {
      const k = addressKey(a)
      const clash = seen.has(k) || (!site.system && systemAddrs.has(k))
      if (clash) skipped.push(a)
      else seen.add(k)
      return !clash
    })
    if (keep.length === site.addrs.length) continue
    replace.set(site.start, keep.length ? `${keep.join(", ")} {` : null)
  }
  if (!replace.size) return { content, skipped }

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const site = replace.has(i) ? sites.find(s => s.start === i)! : null
    if (!site) { out.push(lines[i]); continue }
    const opener = replace.get(i)
    if (opener !== null) { out.push(opener!); continue }
    i = site.end
    if (lines[i + 1] === "") i++  // the blank line after the block
  }
  return { content: out.join("\n"), skipped }
}
