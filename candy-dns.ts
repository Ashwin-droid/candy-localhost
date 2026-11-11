/**
 * candy-dns - Standalone DNS daemon for .candy TLD via Tailscale
 *
 * Responds to *.candy A record queries with the machine's Tailscale IP.
 * Names published to the LAN answer with the LAN IP instead, but only for
 * queries in the LAN view (see pickCandyDnsView). The LAN view also answers
 * this machine's ts.net hostname with the LAN IP while a published name is
 * served over HTTPS on it (lanHostRecords), and the bound domains served on
 * the LAN. Other names in those domains' zone (lanForwardZones) are passed to
 * a public resolver, so a front resolver can send the whole zone here.
 * Watches ~/.config/candy/candy-dns.json for the list of known server names.
 * Zero npm dependencies - pure Bun stdlib.
 */

import { $ } from "bun"
import { watch } from "fs"

import { nameInZones, pickCandyDnsView, resolveCandyDnsRecord } from "./tailnet"

const CANDY_CONFIG_DIR = `${process.env.HOME}/.config/candy`
const DNS_CONFIG_FILE = `${CANDY_CONFIG_DIR}/candy-dns.json`
const LOGS_DIR = "/tmp/candy-logs"
const LOG_FILE = `${LOGS_DIR}/_dns.log`

// ============================================================================
// Logging
// ============================================================================

const log = async (msg: string) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  try {
    const file = Bun.file(LOG_FILE)
    const existing = await file.exists() ? await file.text() : ""
    await Bun.write(LOG_FILE, existing + line)
  } catch {}
}

// ============================================================================
// Config
// ============================================================================

interface DnsConfig {
  tailscaleIp: string
  tld: string
  servers: string[]
  records?: Record<string, string>  // name -> IP mapping
  lanIp?: string | null
  lanRecords?: Record<string, string>  // published name -> LAN IP (LAN view only)
  lanHostRecords?: Record<string, string>  // full hostname -> LAN IP (LAN view only)
  lanForwardZones?: string[]  // zones whose other names are forwarded upstream (LAN view only)
}

let config: DnsConfig | null = null

const loadConfig = async (): Promise<DnsConfig | null> => {
  try {
    const file = Bun.file(DNS_CONFIG_FILE)
    if (!await file.exists()) return null
    return await file.json() as DnsConfig
  } catch {
    return null
  }
}

// Watch config file for changes
const watchConfig = () => {
  try {
    watch(DNS_CONFIG_FILE, async () => {
      const newConfig = await loadConfig()
      if (newConfig) {
        config = newConfig
        await log(`Config reloaded: ${config.servers.length} servers`)
      }
    })
  } catch {
    // File doesn't exist yet, retry in a bit
    setTimeout(watchConfig, 5000)
  }
}

// ============================================================================
// Tailscale IP Discovery
// ============================================================================

const discoverTailscaleIp = async (): Promise<string | null> => {
  try {
    const result = await $`tailscale ip -4`.text()
    return result.trim() || null
  } catch {
    return null
  }
}

// ============================================================================
// DNS Wire Protocol
// ============================================================================

// Parse a DNS name from a buffer at the given offset
// Returns [name, newOffset]
const parseDnsName = (buf: Buffer, offset: number): [string, number] => {
  const labels: string[] = []
  let pos = offset
  while (pos < buf.length) {
    const len = buf[pos]
    if (len === 0) {
      pos++
      break
    }
    // Pointer (compression) - top 2 bits set
    if ((len & 0xc0) === 0xc0) {
      const ptrOffset = ((len & 0x3f) << 8) | buf[pos + 1]
      const [name] = parseDnsName(buf, ptrOffset)
      labels.push(name)
      pos += 2
      return [labels.join("."), pos]
    }
    pos++
    labels.push(buf.slice(pos, pos + len).toString("ascii"))
    pos += len
  }
  return [labels.join("."), pos]
}

// Build a DNS response with an A record
const buildResponse = (
  queryBuf: Buffer,
  queryId: number,
  name: string,
  ip: string | null, // null = no answer
  rcode: 0 | 2 | 3 = ip ? 0 : 3, // NOERROR + no answer = NODATA (name exists, other type); 2 = SERVFAIL
): Buffer => {
  // Header: 12 bytes
  const header = Buffer.alloc(12)
  // Transaction ID
  header.writeUInt16BE(queryId, 0)
  // Flags: QR=1 (response), AA=1 (authoritative), RCODE=0 or 3
  header.writeUInt16BE(0x8400 | rcode, 2) // QR + AA, NOERROR or NXDOMAIN
  // QDCOUNT = 1
  header.writeUInt16BE(1, 4)
  // ANCOUNT = 1 if we have an answer, 0 otherwise
  header.writeUInt16BE(ip ? 1 : 0, 6)
  // NSCOUNT = 0
  header.writeUInt16BE(0, 8)
  // ARCOUNT = 0
  header.writeUInt16BE(0, 10)

  // Question section - copy from query
  // Skip the 12-byte header to find the question
  let qPos = 12
  while (qPos < queryBuf.length && queryBuf[qPos] !== 0) {
    const labelLen = queryBuf[qPos]
    if ((labelLen & 0xc0) === 0xc0) {
      qPos += 2
      break
    }
    qPos += 1 + labelLen
  }
  if (queryBuf[qPos] === 0) qPos++ // null terminator
  qPos += 4 // QTYPE + QCLASS

  const question = queryBuf.slice(12, qPos)

  if (!ip) {
    // NXDOMAIN - no answer section
    return Buffer.concat([header, question])
  }

  // Answer section
  // Name: pointer to question name (offset 12)
  const answer = Buffer.alloc(16)
  answer.writeUInt16BE(0xc00c, 0) // pointer to offset 12
  answer.writeUInt16BE(1, 2) // TYPE = A
  answer.writeUInt16BE(1, 4) // CLASS = IN
  answer.writeUInt32BE(60, 6) // TTL = 60 seconds
  answer.writeUInt16BE(4, 10) // RDLENGTH = 4 (IPv4)

  // IP address
  const parts = ip.split(".").map(Number)
  answer[12] = parts[0]
  answer[13] = parts[1]
  answer[14] = parts[2]
  answer[15] = parts[3]

  return Buffer.concat([header, question, answer])
}

// ============================================================================
// Forwarding (names candy-dns doesn't own, inside a forwarded zone)
// ============================================================================

const UPSTREAMS = (process.env.CANDY_DNS_UPSTREAM || "1.1.1.1,8.8.8.8")
  .split(",").map(s => s.trim()).filter(Boolean)
// Tailscale's own resolver (MagicDNS). ts.net machine names only exist there.
const TAILSCALE_RESOLVER = ["100.100.100.100"]
const UPSTREAM_RETRY_MS = 1500
const UPSTREAM_GIVE_UP_MS = 4000

interface PendingForward {
  originalId: number
  reply: (response: Buffer | null) => void
  timers: ReturnType<typeof setTimeout>[]
}
const pendingForwards = new Map<number, PendingForward>()
let upstreamSocket: Awaited<ReturnType<typeof Bun.udpSocket>> | null = null

const openUpstreamSocket = async () => {
  upstreamSocket = await Bun.udpSocket({
    socket: {
      data(_socket, buf) {
        if (buf.length < 12) return
        const id = (buf[0] << 8) | buf[1]
        const pending = pendingForwards.get(id)
        if (!pending) return
        pendingForwards.delete(id)
        pending.timers.forEach(clearTimeout)
        const out = Buffer.from(buf)
        out.writeUInt16BE(pending.originalId, 0)
        pending.reply(out)
      },
    },
  })
}

// Relay a query as-is to the first upstream, try the second if it stays quiet,
// and give up (reply(null)) after a few seconds. IDs are remapped so two
// clients using the same ID can't get each other's answers.
const forwardQuery = (query: Buffer, reply: (response: Buffer | null) => void, upstreams: string[] = UPSTREAMS) => {
  if (!upstreamSocket || upstreams.length === 0 || pendingForwards.size >= 0xffff) return reply(null)
  let id = Math.floor(Math.random() * 0x10000)
  while (pendingForwards.has(id)) id = (id + 1) & 0xffff
  const out = Buffer.from(query)
  const originalId = out.readUInt16BE(0)
  out.writeUInt16BE(id, 0)
  const send = (upstream: string) => { try { upstreamSocket!.send(out, 53, upstream) } catch {} }
  const timers = [
    setTimeout(() => send(upstreams[1] ?? upstreams[0]), UPSTREAM_RETRY_MS),
    setTimeout(() => { pendingForwards.delete(id); reply(null) }, UPSTREAM_GIVE_UP_MS),
  ]
  pendingForwards.set(id, { originalId, reply, timers })
  send(upstreams[0])
}

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  await $`mkdir -p ${LOGS_DIR}`.quiet().nothrow()

  // Discover Tailscale IP
  const tailscaleIp = await discoverTailscaleIp()
  if (!tailscaleIp) {
    await log("ERROR: Could not discover Tailscale IP. Is Tailscale running?")
    process.exit(1)
  }
  await log(`Tailscale IP: ${tailscaleIp}`)

  // Bind address/port. Defaults to <tailscaleIp>:53. Override when another
  // resolver (e.g. Pi-hole) owns :53 and forwards *.candy here instead.
  const bindHost = process.env.CANDY_DNS_HOST || tailscaleIp
  const bindPort = Number(process.env.CANDY_DNS_PORT || 53)

  // Load initial config
  config = await loadConfig()
  if (config) {
    await log(`Loaded config: ${config.servers.length} servers`)
  } else {
    await log("No config file found, will watch for creation")
    config = { tailscaleIp, tld: "candy", servers: [] }
  }

  // Watch for config changes
  watchConfig()

  // Optional second listener that always answers in the LAN view. A front
  // resolver that serves both LAN and tailnet clients (AdGuard Home, dnsmasq)
  // hides the client address, so it forwards its LAN clients here instead.
  const lanPort = process.env.CANDY_DNS_LAN_PORT ? Number(process.env.CANDY_DNS_LAN_PORT) : null
  const lanHost = process.env.CANDY_DNS_LAN_HOST || bindHost

  const listen = (hostname: string, port: number, listener: "default" | "lan") =>
    Bun.udpSocket({
      hostname,
      port,

      socket: {
        data(socket, buf, port, addr) {
          // Need at least a DNS header (12 bytes)
          if (buf.length < 12) return

          const queryId = (buf[0] << 8) | buf[1]
          const qdcount = (buf[4] << 8) | buf[5]

          if (qdcount < 1) return

          // Parse question name
          const [name, nameEnd] = parseDnsName(Buffer.from(buf), 12)

          // Check QTYPE and QCLASS
          if (nameEnd + 4 > buf.length) return
          const qtype = (buf[nameEnd] << 8) | buf[nameEnd + 1]
          const qclass = (buf[nameEnd + 2] << 8) | buf[nameEnd + 3]

          const nameLower = name.toLowerCase()
          const tld = config?.tld || "candy"
          const suffix = `.${tld}`

          const view = pickCandyDnsView(listener, addr)

          // This machine's ts.net hostname, LAN view only. Other record types get
          // NODATA rather than NXDOMAIN, so resolvers don't cache the whole name
          // as nonexistent (RFC 8020).
          const hostIp = view === "lan" ? config?.lanHostRecords?.[nameLower] : undefined
          if (hostIp) {
            const isA = qtype === 1 && qclass === 1
            socket.send(buildResponse(Buffer.from(buf), queryId, name, isA ? hostIp : null, 0), port, addr)
            if (isA) log(`A ${nameLower} -> ${hostIp} [lan] (from ${addr}:${port})`)
            return
          }

          // Another name in a zone that has bound domains on the LAN: not ours,
          // ask a public resolver and pass its answer back untouched.
          if (view === "lan" && nameInZones(nameLower, config?.lanForwardZones)) {
            const query = Buffer.from(buf)
            forwardQuery(query, (response) => {
              socket.send(response ?? buildResponse(query, queryId, name, null, 2), port, addr)
              if (!response) log(`SERVFAIL ${nameLower} [lan] (upstream did not answer)`)
            })
            return
          }

          // A ts.net name we aren't serving on the LAN right now (nothing is
          // published over HTTPS on it): a front resolver may still send these
          // here, so ask Tailscale instead of claiming the name doesn't exist.
          if (view === "lan" && nameLower.endsWith(".ts.net")) {
            const query = Buffer.from(buf)
            forwardQuery(query, (response) => {
              socket.send(response ?? buildResponse(query, queryId, name, null, 2), port, addr)
              if (!response) log(`SERVFAIL ${nameLower} [lan] (Tailscale's resolver did not answer)`)
            }, TAILSCALE_RESOLVER)
            return
          }

          // Only handle queries ending in .candy
          if (!nameLower.endsWith(suffix)) {
            const response = buildResponse(Buffer.from(buf), queryId, name, null)
            socket.send(response, port, addr)
            return
          }

          // Extract subdomain
          const subdomain = nameLower.slice(0, -suffix.length)

          // Only respond to A (1) IN (1) queries with the Tailscale IP
          // For any other QTYPE, respond NXDOMAIN
          if (qtype !== 1 || qclass !== 1) {
            const response = buildResponse(Buffer.from(buf), queryId, name, null)
            socket.send(response, port, addr)
            return
          }

          // Per-name IP resolution, including host-scoped aliases and action subdomains.
          const ip = resolveCandyDnsRecord({
            subdomain,
            records: config?.records,
            localNames: config?.servers,
            hostIp: config?.tailscaleIp || tailscaleIp,
            lanRecords: view === "lan" ? config?.lanRecords : undefined,
          })

          const response = buildResponse(Buffer.from(buf), queryId, name, ip)
          socket.send(response, port, addr)

          const tag = view === "lan" ? " [lan]" : ""
          if (ip) {
            log(`A ${nameLower} -> ${ip}${tag} (from ${addr}:${port})`)
          } else {
            log(`NXDOMAIN ${nameLower}${tag} (from ${addr}:${port})`)
          }
        },
      },
    })

  await openUpstreamSocket()

  // Start UDP DNS server(s)
  await listen(bindHost, bindPort, "default")
  if (lanPort) {
    await listen(lanHost, lanPort, "lan")
    await log(`LAN view listening on ${lanHost}:${lanPort}`)
  }

  await log(`DNS server listening on ${bindHost}:${bindPort}`)
  await log(`Serving *.candy -> ${tailscaleIp}`)

  console.log(`
\x1b[36m candy-dns\x1b[0m  \x1b[90mDNS server for .candy TLD\x1b[0m
\x1b[33m Bind:\x1b[0m      ${bindHost}:${bindPort}${lanPort ? `  (LAN view: ${lanHost}:${lanPort})` : ""}
\x1b[33m TLD:\x1b[0m       .candy
\x1b[33m Config:\x1b[0m    ${DNS_CONFIG_FILE}
\x1b[33m Log:\x1b[0m       ${LOG_FILE}
`)
}

main().catch(async (e) => {
  await log(`FATAL: ${e}`)
  process.exit(1)
})
