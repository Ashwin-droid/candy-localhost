/**
 * candy-dns - Standalone DNS daemon for .candy TLD via Tailscale
 *
 * Responds to *.candy A record queries with the machine's Tailscale IP.
 * Watches ~/.config/candy/candy-dns.json for the list of known server names.
 * Zero npm dependencies - pure Bun stdlib.
 */

import { $ } from "bun"
import { watch } from "fs"

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
  ip: string | null, // null = NXDOMAIN
): Buffer => {
  // Header: 12 bytes
  const header = Buffer.alloc(12)
  // Transaction ID
  header.writeUInt16BE(queryId, 0)
  // Flags: QR=1 (response), AA=1 (authoritative), RCODE=0 or 3
  if (ip) {
    header.writeUInt16BE(0x8400, 2) // QR + AA, no error
  } else {
    header.writeUInt16BE(0x8403, 2) // QR + AA, NXDOMAIN
  }
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

  // Start UDP DNS server
  const socket = await Bun.udpSocket({
    hostname: tailscaleIp,
    port: 53,

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

        // Per-name IP resolution
        const records = config?.records
        const ip = subdomain === "candy"
          ? (config?.tailscaleIp || tailscaleIp)       // candy.candy always -> host
          : records?.[subdomain]                         // per-name lookup
          ?? (config?.servers?.includes(subdomain) ? (config?.tailscaleIp || tailscaleIp) : null)  // backward compat

        const response = buildResponse(Buffer.from(buf), queryId, name, ip)
        socket.send(response, port, addr)

        if (ip) {
          log(`A ${nameLower} -> ${ip} (from ${addr}:${port})`)
        } else {
          log(`NXDOMAIN ${nameLower} (from ${addr}:${port})`)
        }
      },
    },
  })

  await log(`DNS server listening on ${tailscaleIp}:53`)
  await log(`Serving *.candy -> ${tailscaleIp}`)

  console.log(`
\x1b[36m candy-dns\x1b[0m  \x1b[90mDNS server for .candy TLD\x1b[0m
\x1b[33m Bind:\x1b[0m      ${tailscaleIp}:53
\x1b[33m TLD:\x1b[0m       .candy
\x1b[33m Config:\x1b[0m    ${DNS_CONFIG_FILE}
\x1b[33m Log:\x1b[0m       ${LOG_FILE}
`)
}

main().catch(async (e) => {
  await log(`FATAL: ${e}`)
  process.exit(1)
})
