/**
 * candy-localhost daemon v0.4 - Lazy Dev Server Orchestrator
 * Now with lazy-loaded dev servers and MCP integration
 *
 * Runs as a background service, manages Caddy, spawns dev servers on-demand
 */

import { $, spawn, type Subprocess } from "bun"

// Random message picker
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

// Playful messages (kept for legacy API responses)
const msg = {
  added: [
    "Approved. Next!",
    "Rubber stamped. No paperwork required.",
    "Allocated. Accountability is for the 2000s.",
    "Added to the registry. The auditors won't notice.",
    "IANA would be proud.",
    "slay.",
    "say less.",
    "done. no cap.",
  ],
  removed: [
    "Reclaimed. Like it never happened.",
    "Gone. We'll shred the paperwork.",
    "Deallocated. Off the books.",
    "ghosted.",
    "it's giving... deleted.",
  ],
  portCollision: [
    "That port's already spoken for. Even we have some standards.",
    "Someone beat you to it. Should've asked in 1983.",
    "Already claimed. First come, first served - the IANA way.",
    "That port's taken. It's complicated.",
    "port's in a relationship already.",
    "that port has mass. it's taken.",
  ],
  portalOpening: [
    "Opening an unregistered tunnel... the ITU can't reach us here.",
    "Bypassing international regulations...",
    "The UN has no jurisdiction in localhost.",
    "Digging a tunnel through the bureaucracy...",
    "no thoughts just tunnels...",
  ],
  portalSuccess: [
    "You didn't get this from us.",
    "Connection established. Off the record, of course.",
    "Tunnel's open. What you do with it is your business.",
    "and i oop- it's live.",
    "lowkey connected. highkey untraceable.",
  ],
  portalCollision: [
    "Already got a tunnel there. We're generous, not wasteful.",
    "That port's already got a backroom deal.",
    "bestie that tunnel exists already.",
  ],
  portalClosed: [
    "Tunnel sealed. Plausible deniability restored.",
    "Connection severed. We were never here.",
    "tunnel said: i'm out.",
  ],
  batchOpening: [
    "Bulk deal approved. Volume discount.",
    "Opening multiple back channels...",
    "Quantity over quality. The IANA special.",
    "understood the assignment.",
  ],
  notFound: [
    "Never heard of 'em.",
    "Not in our records. Try another registry.",
    "That name doesn't ring a bell.",
    "who? idk her.",
    "404 in the streets, 404 in the sheets.",
  ],
  notANumber: [
    "That's not a number and you know it.",
    "We need a port number, not poetry.",
    "bestie that's not a port.",
  ],
  detach: [
    "Shredding the paperwork...",
    "Leaving the back door open...",
    "brb (not really).",
    "going dark. tunnels stay lit.",
  ],
  exit: [
    "Closing up shop. Evidence destroyed.",
    "Later. This meeting never happened.",
    "Peace out. The registry forgets nothing.",
    "Gone. Like a /8 block in 1983.",
    "Exiting. Tell IANA we said hi.",
  ],
  noRoutes: [
    "Nothing on the books to tunnel.",
    "Registry's empty. Add some routes first.",
    "can't tunnel nothing bestie.",
  ],
  launder: [
    "Papers updated. New identity, who dis?",
    "Clean as a whistle. Never heard of the old name.",
    "Laundered. The auditors will never know.",
    "New name just dropped. Past is past.",
    "Identity scrubbed. Witness protection activated.",
    "it's giving... rebrand.",
  ],
  silence: [
    "Silenced. They won't be talking anymore.",
    "Shhhh... it's done.",
    "They knew too much.",
    "Problem solved. Permanently.",
    "Gone. Like they never existed.",
  ],
  summon: [
    "The ritual is complete. It has arrived.",
    "From the void, a domain emerges.",
    "You called. It answered.",
    "Summoned from the depths of localhost.",
  ],
  rift: [
    "Reality torn. The rift is open.",
    "A hole in the fabric of the network.",
    "The void peers back at you.",
    "Careful. Some tunnels go both ways.",
  ],
  seal: [
    "The rift is sealed. For now.",
    "Banished back to the void.",
    "The connection withers and dies.",
    "Sealed. Whatever was on the other side stays there.",
  ],
  witness: [
    "New identity assigned. Old one? Never heard of it.",
    "Relocated. Don't look back.",
    "The past is dead. Long live the new name.",
  ],
  vanish: [
    "Vanishing... tell no one.",
    "Going dark. Forget this address.",
    "We were never here.",
    "*poof*",
  ],
  evidence: [
    "Compiling the dossier...",
    "Everything we have on file:",
    "The evidence locker contains:",
  ],
}

// ============================================================================
// Types & Interfaces
// ============================================================================

interface ServerConfig {
  id: string
  cwd: string
  cmd: string
}

type ProcessStatus = 'starting' | 'running' | 'dead' | 'errored'

interface ManagedProcess {
  name: string
  config: ServerConfig
  proc: Subprocess | null
  pid: number | null
  status: ProcessStatus
  port: number | null
  startedAt: Date
  lastActivity: number  // Unix timestamp of last request/activity
  exitCode: number | null
  logFile: string
  detectedPorts: number[]  // All ports detected during startup
  terminal: any | null  // Bun.Terminal reference for PTY input
}

// ============================================================================
// Configuration Paths
// ============================================================================

const CADDY = "caddy"
const CADDY_CONFIG_DIR = `${process.env.HOME}/.config/caddy`
const CANDY_CONFIG_DIR = `${process.env.HOME}/.config/candy`
const CADDYFILE = `${CADDY_CONFIG_DIR}/Caddyfile`
const CADDY_LOG = `${CADDY_CONFIG_DIR}/access.log`
const PID_FILE = `${CADDY_CONFIG_DIR}/candy.pid`
const SERVERS_CONFIG = `${CANDY_CONFIG_DIR}/servers.json`
const ROUTES_FILE = `${CANDY_CONFIG_DIR}/routes.json`
const MCP_SECRET_FILE = `${CANDY_CONFIG_DIR}/mcp-secret`
const DOMAINS_CONFIG = `${CANDY_CONFIG_DIR}/domains.json`
const LOGS_DIR = "/tmp/candy-logs"
const AUDIT_LOG = `${LOGS_DIR}/_audit.log`
const DNS_CONFIG_FILE = `${CANDY_CONFIG_DIR}/candy-dns.json`
const ADVERTISEMENTS_FILE = `${CANDY_CONFIG_DIR}/advertisements.json`
const CLOUDFLARED_SYSTEM_CONFIG = `/etc/cloudflared/config.yml`
const CLOUDFLARED_USER_CONFIG = `${process.env.HOME}/.cloudflared/config.yml`

// Tailscale state (discovered at startup)
let tailscaleIp: string | null = null

// Reserved domain names (cannot be used for servers/routes)
const RESERVED_NAMES = new Set(['portal', 'k', 'kill', 'p', 'candy'])
const isReserved = (name: string) => RESERVED_NAMES.has(name.toLowerCase())

// Port detection patterns (run against process stdout/stderr)
const PORT_PATTERNS = [
  // IPv4: 0.0.0.0:3000, 127.0.0.1:5173, 192.168.1.1:8080
  /(?:0\.0\.0\.0|127\.0\.0\.1|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})/g,
  // IPv6: [::]:3000, [::1]:5173
  /\[::(?:1)?\]:(\d{2,5})/g,
  // URL: http://localhost:3000, http://127.0.0.1:5173/path
  /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g,
]

const PORT_DETECTION_TIMEOUT = 10000  // 10 seconds

// Advertisement / service discovery
const ADVERTISEMENT_TTL = 30 * 60 * 1000  // 30 minutes
const READVERTISE_INTERVAL = 25 * 60 * 1000  // 25 minutes
const EXPIRY_SWEEP_INTERVAL = 5 * 60 * 1000  // 5 minutes

interface RemoteRecord {
  ip: string
  advertisedAt: number
}

// ============================================================================
// Bound Domains Config
// ============================================================================

interface DomainBinding {
  subdomain: string
  fqdn: string
  serverName: string
  boundAt: string
  auth?: {
    password: string | null  // bcrypt hash, null = no auth (nag mode)
    enabled: boolean
  }
}

interface DomainConfig {
  tunnel: { id: string; name: string; credentialsFile: string }
  zone: { id: string; domain: string }
  cfApiToken: string
  bindings: Record<string, DomainBinding>
}

// ============================================================================
// Bound Domain Auth - Session & Rate Limiting State
// ============================================================================

interface AuthSession {
  ip: string
  userAgent: string
  domain: string
  issuedAt: number
  expiresAt: number
  lastSeen: number
}

interface AuthFailureState {
  count: number
  fibIndex: number  // position in fib sequence (starts at 0)
  blockedUntil: number  // timestamp when block expires
  lastAttempt: number
}

// Auth sessions: token -> session data
const authSessions = new Map<string, AuthSession>()

// Auth failure tracking: "ip:userAgent" -> failure state
const authFailures = new Map<string, AuthFailureState>()

// Rate limiting for unauthenticated: "ip:domain" -> { timestamps[] }
const unauthRateLimit = new Map<string, number[]>()

// Rate limit blocked IPs: "ip:domain" -> unblock timestamp
const rateLimitBlocks = new Map<string, number>()

const AUTH_SESSION_TTL = 60 * 60 * 1000  // 1 hour
const AUTH_RENEWAL_THRESHOLD = 15 * 60 * 1000  // 15 minutes
const AUTH_CLEANUP_INTERVAL = 5 * 60 * 1000  // 5 minutes
const AUTH_FAILURE_EXPIRY = 60 * 60 * 1000  // 1 hour of no attempts
const UNAUTH_RATE_LIMIT = 3  // requests per second
const RATE_LIMIT_BLOCK_DURATION = 60 * 1000  // 60 seconds

// Fibonacci sequence helper
const fibonacci = (n: number): number => {
  if (n <= 1) return 1
  let a = 1, b = 1
  for (let i = 2; i <= n; i++) {
    const c = a + b
    a = b
    b = c
  }
  return b
}

// Generate auth session token
const generateAuthToken = (): string => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Get fingerprint key from request
const getFingerprint = (req: Request, server: any): { ip: string; userAgent: string } => {
  const ip = normalizeIp(
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    server.requestIP(req)?.address || 'unknown'
  )
  const userAgent = req.headers.get('user-agent') || 'unknown'
  return { ip, userAgent }
}

// Validate auth session: checks cookie + fingerprint
const validateAuthSession = (token: string, ip: string, userAgent: string, domain: string): AuthSession | null => {
  const session = authSessions.get(token)
  if (!session) return null
  if (session.domain !== domain) return null
  if (Date.now() > session.expiresAt) {
    authSessions.delete(token)
    return null
  }
  // Fingerprint check
  if (session.ip !== ip || session.userAgent !== userAgent) {
    authSessions.delete(token)
    return null
  }
  return session
}

// Create auth session
const createAuthSession = (ip: string, userAgent: string, domain: string): string => {
  const token = generateAuthToken()
  authSessions.set(token, {
    ip,
    userAgent,
    domain,
    issuedAt: Date.now(),
    expiresAt: Date.now() + AUTH_SESSION_TTL,
    lastSeen: Date.now(),
  })
  return token
}

// Renew session if close to expiry
const maybeRenewSession = (token: string): boolean => {
  const session = authSessions.get(token)
  if (!session) return false
  const timeLeft = session.expiresAt - Date.now()
  if (timeLeft < AUTH_RENEWAL_THRESHOLD) {
    session.expiresAt = Date.now() + AUTH_SESSION_TTL
    session.lastSeen = Date.now()
    return true  // cookie needs reissue
  }
  session.lastSeen = Date.now()
  return false
}

// Get auth failure state for an IP+UA combo
const getAuthFailureKey = (ip: string, userAgent: string): string => `${ip}:${userAgent}`

const checkAuthBlocked = (ip: string, userAgent: string): { blocked: boolean; retryAfter: number } => {
  const key = getAuthFailureKey(ip, userAgent)
  const state = authFailures.get(key)
  if (!state) return { blocked: false, retryAfter: 0 }
  // Expire old state
  if (Date.now() - state.lastAttempt > AUTH_FAILURE_EXPIRY) {
    authFailures.delete(key)
    return { blocked: false, retryAfter: 0 }
  }
  if (state.blockedUntil > Date.now()) {
    return { blocked: true, retryAfter: Math.ceil((state.blockedUntil - Date.now()) / 1000) }
  }
  return { blocked: false, retryAfter: 0 }
}

const recordAuthFailure = (ip: string, userAgent: string): { retryAfter: number } => {
  const key = getAuthFailureKey(ip, userAgent)
  const state = authFailures.get(key) || { count: 0, fibIndex: 0, blockedUntil: 0, lastAttempt: 0 }
  state.count++
  state.lastAttempt = Date.now()
  if (state.count >= 3) {
    const backoffHours = fibonacci(state.fibIndex) || 1  // fib(0)=0, floor to 1hr minimum
    state.blockedUntil = Date.now() + backoffHours * 60 * 60 * 1000  // hours, not seconds
    state.fibIndex++
    authFailures.set(key, state)
    return { retryAfter: backoffHours * 3600 }  // return seconds for display
  }
  authFailures.set(key, state)
  return { retryAfter: 0 }
}

const clearAuthFailures = (ip: string, userAgent: string) => {
  authFailures.delete(getAuthFailureKey(ip, userAgent))
}

// Unauthenticated rate limiting: 3 rps per IP per domain
const checkRateLimit = (ip: string, domain: string): boolean => {
  const key = `${ip}:${domain}`
  // Check if currently blocked
  const blockUntil = rateLimitBlocks.get(key)
  if (blockUntil && Date.now() < blockUntil) return false
  if (blockUntil && Date.now() >= blockUntil) rateLimitBlocks.delete(key)

  const now = Date.now()
  const timestamps = unauthRateLimit.get(key) || []
  // Keep only timestamps from last second
  const recent = timestamps.filter(t => now - t < 1000)
  recent.push(now)
  unauthRateLimit.set(key, recent)

  if (recent.length > UNAUTH_RATE_LIMIT) {
    rateLimitBlocks.set(key, now + RATE_LIMIT_BLOCK_DURATION)
    return false
  }
  return true
}

const isRateLimitBlocked = (ip: string, domain: string): boolean => {
  const key = `${ip}:${domain}`
  const blockUntil = rateLimitBlocks.get(key)
  return !!blockUntil && Date.now() < blockUntil
}

// Parse auth cookie from request
const getAuthCookie = (req: Request, domain: string): string | null => {
  const cookieHeader = req.headers.get('cookie')
  if (!cookieHeader) return null
  const cookieName = `candy_auth_${domain.replace(/[^a-z0-9]/g, '_')}`
  const match = cookieHeader.match(new RegExp(`${cookieName}=([^;]+)`))
  return match ? match[1] : null
}

// Build Set-Cookie header for auth
const makeAuthCookie = (domain: string, token: string, fqdn: string): string => {
  const cookieName = `candy_auth_${domain.replace(/[^a-z0-9]/g, '_')}`
  return `${cookieName}=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=3600; Path=/; Domain=${fqdn}`
}

// Get binding auth config
const getBindingAuth = (subdomain: string): { password: string | null; enabled: boolean } | null => {
  if (!domainConfig?.bindings?.[subdomain]?.auth) return null
  return domainConfig.bindings[subdomain].auth!
}

// Set password for a bound domain
const setBindingPassword = async (subdomain: string, password: string): Promise<boolean> => {
  if (!domainConfig?.bindings?.[subdomain]) return false
  const hash = await Bun.password.hash(password)
  domainConfig.bindings[subdomain].auth = { password: hash, enabled: true }
  await saveDomainConfig()
  return true
}

// Clear password for a bound domain
const clearBindingPassword = async (subdomain: string): Promise<boolean> => {
  if (!domainConfig?.bindings?.[subdomain]) return false
  delete domainConfig.bindings[subdomain].auth
  await saveDomainConfig()
  return true
}

// Resolve an auth target from either subdomain or full domain (fqdn)
const resolveBindingKey = (subdomain?: string, domain?: string): string | null => {
  const cleanSub = (subdomain || '').trim().toLowerCase()
  if (cleanSub && domainConfig?.bindings?.[cleanSub]) return cleanSub

  const cleanDomain = (domain || '').trim().toLowerCase()
  if (!cleanDomain || !domainConfig?.bindings) return null

  // Allow callers to send a subdomain via the "domain" field too
  if (domainConfig.bindings[cleanDomain]) return cleanDomain

  for (const [sub, binding] of Object.entries(domainConfig.bindings)) {
    if (binding.fqdn.toLowerCase() === cleanDomain) return sub
  }

  return null
}

// Session cleanup sweep - every 5 minutes
setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [token, session] of authSessions) {
    if (now > session.expiresAt) {
      authSessions.delete(token)
      cleaned++
    }
  }
  // Clean expired failure states
  for (const [key, state] of authFailures) {
    if (now - state.lastAttempt > AUTH_FAILURE_EXPIRY) {
      authFailures.delete(key)
    }
  }
  // Clean old rate limit entries
  for (const [key, timestamps] of unauthRateLimit) {
    const recent = timestamps.filter(t => now - t < 2000)
    if (recent.length === 0) unauthRateLimit.delete(key)
    else unauthRateLimit.set(key, recent)
  }
  // Clean expired blocks
  for (const [key, blockUntil] of rateLimitBlocks) {
    if (now >= blockUntil) rateLimitBlocks.delete(key)
  }
  if (cleaned > 0) {
    auditLog('AUTH_CLEANUP', `${cleaned} expired sessions cleaned`, 'System')
  }
}, AUTH_CLEANUP_INTERVAL)

let domainConfig: DomainConfig | null = null

const loadDomainConfig = async (): Promise<DomainConfig | null> => {
  try {
    const file = Bun.file(DOMAINS_CONFIG)
    if (await file.exists()) {
      domainConfig = await file.json() as DomainConfig
      const count = Object.keys(domainConfig.bindings || {}).length
      console.log(`\x1b[90mLoaded domain config: ${domainConfig.zone?.domain || '(no zone)'} with ${count} bindings\x1b[0m`)
      return domainConfig
    }
  } catch (e) {
    console.log(`\x1b[33mNo domain config found or invalid format\x1b[0m`)
  }
  return null
}

const saveDomainConfig = async () => {
  if (!domainConfig) return
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(DOMAINS_CONFIG, JSON.stringify(domainConfig, null, 2))
}

// Resolve an incoming Host header to a bound domain's server name
// Returns the server name if the host matches a binding's FQDN, null otherwise
const resolveBindingFromHost = (host: string): { serverName: string; binding: DomainBinding } | null => {
  if (!domainConfig?.bindings) return null
  // Strip port if present
  const cleanHost = host.replace(/:\d+$/, '')
  for (const binding of Object.values(domainConfig.bindings)) {
    if (binding.fqdn === cleanHost) {
      return { serverName: binding.serverName, binding }
    }
  }
  return null
}

// Write ingress rules to cloudflared config files and restart the service
const syncCloudflaredIngress = async () => {
  if (!domainConfig?.tunnel?.id) return

  // Build ingress rules from bindings
  const ingressRules: { hostname: string; service: string }[] = []
  for (const binding of Object.values(domainConfig.bindings || {})) {
    ingressRules.push({
      hostname: binding.fqdn,
      service: 'http://localhost:80',
    })
  }

  // Build YAML content
  let yaml = `tunnel: ${domainConfig.tunnel.id}\n`
  yaml += `credentials-file: ${domainConfig.tunnel.credentialsFile}\n`
  yaml += `\ningress:\n`
  for (const rule of ingressRules) {
    yaml += `  - hostname: ${rule.hostname}\n`
    yaml += `    service: ${rule.service}\n`
  }
  // Catch-all must always be last
  yaml += `  - service: http_status:404\n`

  // Write to both system and user config
  try {
    await Bun.write(CLOUDFLARED_USER_CONFIG, yaml)
  } catch (e) {
    console.log(`\x1b[33mFailed to write user cloudflared config: ${e}\x1b[0m`)
  }
  try {
    await $`sudo cp ${CLOUDFLARED_USER_CONFIG} ${CLOUDFLARED_SYSTEM_CONFIG}`.quiet().nothrow()
  } catch (e) {
    console.log(`\x1b[33mFailed to write system cloudflared config: ${e}\x1b[0m`)
  }
}

const restartCloudflared = async () => {
  try {
    await $`sudo systemctl restart cloudflared`.quiet().nothrow()
    console.log(`\x1b[90mCloudflared restarted\x1b[0m`)
  } catch (e) {
    console.log(`\x1b[31mFailed to restart cloudflared: ${e}\x1b[0m`)
  }
}

// ============================================================================
// State Maps
// ============================================================================

const routes = new Map<string, { target: number | string, persistent: boolean }>()
const portals = new Map<string, { proc: Subprocess | null, port: number, url?: string, pid?: number }>()
const processes = new Map<string, ManagedProcess>()
const serverConfigs = new Map<string, ServerConfig[]>()
const remoteRecords = new Map<string, RemoteRecord>()
// Historical mapping: tunnel domain -> server name (persists after portal close)
const tunnelHistory = new Map<string, string>()
let caddyProc: Subprocess | null = null

const makeConfigId = () => `cfg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const getConfigsForName = (name: string): ServerConfig[] => serverConfigs.get(name) || []
const getConfigById = (name: string, configId?: string): ServerConfig | null => {
  const configs = getConfigsForName(name)
  if (configs.length === 0) return null
  if (!configId) return configs[0]
  return configs.find(c => c.id === configId) || null
}

// ============================================================================
// THE VOID - Eldritch Horror State Management
// ============================================================================

interface VoidState {
  marked: boolean           // Has the user been touched by the void?
  markedAt: number | null   // When did the void first claim them?
  burstCount: number        // How many times has the void burst forth?
  lastBurst: number | null  // When did the void last manifest?
  burstPending: boolean     // Is a burst event waiting to be consumed?
  burstId: string | null    // Unique ID for current burst (for coordination)
  pity: number              // Pity counter - increases chance of void storm
}

let voidState: VoidState = {
  marked: false,
  markedAt: null,
  burstCount: 0,
  lastBurst: null,
  burstPending: false,
  burstId: null,
  pity: -20, // Negative pity - need 20 visits/clicks before void starts building
}

// SSE connections waiting for void events
const voidListeners = new Set<ReadableStreamDefaultController<Uint8Array>>()

// Rolling token chains - per-client (session) amnesiac arrays
// Token format: sessionId:tokenValue
// Each session has its own chain: [previous_used, current_valid]
const sessionTokens = new Map<string, { chain: string[], created: number }>()

// Clean up old sessions periodically (older than 24h)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const [sessionId, data] of sessionTokens) {
    if (data.created < cutoff) sessionTokens.delete(sessionId)
  }
}, 60 * 60 * 1000) // every hour

// Auto-kill idle servers (1hr no activity, no portal)
const IDLE_TIMEOUT = 60 * 60 * 1000 // 1 hour
let lastLogPosition = 0

const updateActivityFromCaddyLogs = async () => {
  try {
    const file = Bun.file(CADDY_LOG)
    if (!await file.exists()) return

    const content = await file.text()
    const newContent = content.slice(lastLogPosition)
    lastLogPosition = content.length

    // Parse Caddy JSON logs for requests to *.localhost and *.candy
    for (const line of newContent.split('\n')) {
      if (!line.trim()) continue
      try {
        const log = JSON.parse(line)
        const host = log.request?.host || ''
        const match = host.match(/^([a-z0-9-]+)\.(localhost|candy)/)
        if (match) {
          const serverName = match[1]
          const proc = processes.get(serverName)
          if (proc && proc.status === 'running') {
            proc.lastActivity = Date.now()
          }
        }
      } catch {}
    }
  } catch {}
}

const killIdleServers = async () => {
  const now = Date.now()
  for (const [name, proc] of processes) {
    if (proc.status !== 'running') continue

    const idleTime = now - proc.lastActivity
    const hasPortal = portals.has(name)

    // Kill if idle for 1hr+ and no portal
    if (idleTime > IDLE_TIMEOUT && !hasPortal) {
      console.log(`\x1b[33m[auto-kill] ${name} idle for ${Math.round(idleTime / 60000)}min\x1b[0m`)
      await stopProcess(name, 'System')
      auditLog('AUTO_KILL', `${name} (idle ${Math.round(idleTime / 60000)}min)`, 'System')
    }
  }
}

// Run every 30 minutes (idle timeout is 1hr, so ±30min is fine)
setInterval(async () => {
  await updateActivityFromCaddyLogs()
  await killIdleServers()
}, 30 * 60 * 1000)

// MCP Authentication - bootstrap secret + session API keys
// The daemon writes a secret to MCP_SECRET_FILE on startup
// MCP reads it, exchanges for a session API key via /mcp/auth
// API key is valid for the daemon's lifetime (no rolling)
let mcpBootstrapSecret: string | null = null
const mcpApiKeys = new Set<string>()

const initMcpAuth = async () => {
  mcpBootstrapSecret = crypto.randomUUID()
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(MCP_SECRET_FILE, mcpBootstrapSecret)
  // Restrict file permissions to owner only
  await $`chmod 600 ${MCP_SECRET_FILE}`.quiet().nothrow()
  console.log(`\x1b[90mMCP auth initialized\x1b[0m`)
}

const validateMcpApiKey = (apiKey: string): boolean => {
  return mcpApiKeys.has(apiKey)
}

const exchangeMcpSecret = (secret: string): string | null => {
  if (secret !== mcpBootstrapSecret) return null
  const apiKey = `mcp_${crypto.randomUUID()}`
  mcpApiKeys.add(apiKey)
  return apiKey
}

// Discover Tailscale IPv4 address
const discoverTailscaleIp = async (): Promise<string | null> => {
  try {
    const result = await $`tailscale ip -4`.text()
    return result.trim() || null
  } catch { return null }
}

// Validate that an IP is in Tailscale's CGNAT range (100.64.0.0/10)
const isTailscaleIp = (ip: string): boolean => {
  const clean = ip.replace(/^::ffff:/, '')
  const parts = clean.split('.').map(Number)
  if (parts.length !== 4) return false
  return parts[0] === 100 && (parts[1] & 0xC0) === 64
}

const normalizeIp = (ip: string): string => ip.replace(/^::ffff:/, '')

// Sync DNS config file for candy-dns daemon
const syncDnsConfig = async () => {
  if (!tailscaleIp) return
  const servers = [...routes.keys()]

  // Build per-name records: remote first, then local overwrites
  const records: Record<string, string> = {}
  for (const [name, rec] of remoteRecords) {
    records[name] = rec.ip
  }
  // Local routes + configs always win (host is "first advertiser")
  for (const name of routes.keys()) {
    records[name] = tailscaleIp
  }
  for (const name of serverConfigs.keys()) {
    records[name] = tailscaleIp
  }
  records["candy"] = tailscaleIp  // always

  await Bun.write(DNS_CONFIG_FILE, JSON.stringify({
    tailscaleIp, tld: "candy", servers, records
  }, null, 2))
}

// Advertisement persistence
const loadAdvertisements = async () => {
  try {
    const file = Bun.file(ADVERTISEMENTS_FILE)
    if (!await file.exists()) return
    const data = await file.json() as Record<string, RemoteRecord>
    const now = Date.now()
    for (const [name, record] of Object.entries(data)) {
      if (now - record.advertisedAt < ADVERTISEMENT_TTL) {
        remoteRecords.set(name, record)
      }
    }
    if (remoteRecords.size > 0) {
      auditLog('ADS_LOADED', `${remoteRecords.size} remote records loaded`, 'System')
    }
  } catch {}
}

const saveAdvertisements = async () => {
  await Bun.write(ADVERTISEMENTS_FILE, JSON.stringify(
    Object.fromEntries(remoteRecords), null, 2
  ))
}

// Client-side: advertise local routes to the DNS hub
const advertiseToHub = async () => {
  if (!tailscaleIp) return
  try {
    const dns = await import("node:dns")
    const addrs = await dns.promises.resolve4("candy.candy")
    if (!addrs.length) return
    const hubIp = addrs[0]
    // If candy.candy resolves to us, we ARE the hub - skip
    if (hubIp === tailscaleIp) return

    const myRoutes = [...new Set([...routes.keys(), ...serverConfigs.keys()])]
    if (myRoutes.length === 0) return

    const resp = await fetch(`http://${hubIp}:9999/candy/advertise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routes: myRoutes }),
      signal: AbortSignal.timeout(10000),
    })
    const result = await resp.json() as { accepted?: string[] }
    if (result.accepted?.length) {
      auditLog('ADS_SENT', `Advertised ${result.accepted.length} routes to ${hubIp}`, 'System')
    }
  } catch {} // Silent fail - hub might not exist
}

// Generate a random token value
const generateTokenValue = () => crypto.randomUUID()

// Generate a new session with initial token
const createSession = (): string => {
  const sessionId = crypto.randomUUID()
  const tokenValue = generateTokenValue()
  const fullToken = `${sessionId}:${tokenValue}`
  sessionTokens.set(sessionId, { chain: [fullToken], created: Date.now() })
  return fullToken
}

// Parse token into sessionId and tokenValue
const parseToken = (token: string): { sessionId: string, tokenValue: string } | null => {
  const parts = token.split(':')
  if (parts.length !== 2) return null
  return { sessionId: parts[0], tokenValue: parts[1] }
}

// Validate and consume token - returns true if valid (consumes it)
const consumeToken = (token: string): boolean => {
  const parsed = parseToken(token)
  if (!parsed) return false

  const session = sessionTokens.get(parsed.sessionId)
  if (!session) return false

  // Token must be the current (last) in chain
  const currentToken = session.chain[session.chain.length - 1]
  if (token !== currentToken) return false

  // Valid! Generate next token
  const newTokenValue = generateTokenValue()
  const newToken = `${parsed.sessionId}:${newTokenValue}`

  // Slide the window: keep max 2 tokens
  if (session.chain.length >= 2) {
    session.chain.shift()
  }
  session.chain.push(newToken)

  return true
}

// Refresh token - if provided token exists in session chain, return current token
const refreshToken = (oldToken: string): string | null => {
  const parsed = parseToken(oldToken)
  if (!parsed) return null

  const session = sessionTokens.get(parsed.sessionId)
  if (!session) return null

  // Token must exist somewhere in the chain (current or just-used)
  if (!session.chain.includes(oldToken)) return null

  // Return the current (last) token
  return session.chain[session.chain.length - 1]
}

// Get current token for a session (used for SSR)
const getCurrentToken = (sessionId: string): string | null => {
  const session = sessionTokens.get(sessionId)
  if (!session) return null
  return session.chain[session.chain.length - 1]
}

// The void tracking
let pageViews = 0
let darkShownThisCycle = false

// Activity log (in-memory for API responses)
const activityLog: { time: Date, action: string, details: string }[] = []
const log = (action: string, details: string) => {
  activityLog.push({ time: new Date(), action, details })
  // Also write to audit log file
  auditLog(action, details)
}

// Traffic stats per domain
const domainHits = new Map<string, number>()

// ============================================================================
// Log Infrastructure
// ============================================================================

// Initialize logs directory - clear on boot
const initLogs = async () => {
  await $`rm -rf ${LOGS_DIR}`.quiet().nothrow()
  await $`mkdir -p ${LOGS_DIR}`.quiet().nothrow()
  // Create symlink to Caddy access log
  await $`ln -sf ${CADDY_LOG} ${LOGS_DIR}/_caddy.log`.quiet().nothrow()
  // Create empty audit log
  await Bun.write(AUDIT_LOG, "")
}

// Actor types for audit logging
type Actor = 'AI' | 'Page' | 'Portal' | 'System' | 'Network' | 'Void'

// Write to audit log with actor tracking
const auditLog = async (action: string, details: string, actor: Actor = 'System') => {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${actor}] ${action}: ${details}\n`
  try {
    const file = Bun.file(AUDIT_LOG)
    const existing = await file.exists() ? await file.text() : ""
    await Bun.write(AUDIT_LOG, existing + line)
  } catch {}
}

// Strip ANSI escape codes and terminal control sequences from text
const stripAnsi = (text: string): string => {
  return text
    // Standard ANSI escape sequences (colors, cursor, clear, etc)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    // OSC sequences (title, hyperlinks, etc): ESC ] ... BEL or ESC ] ... ESC \
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // DCS, PM, APC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    // Simple escape sequences (like ESC c for reset)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b[cDEHMNOPVWXZ78=>]/g, '')
    // Carriage returns without newlines (terminal overwrites)
    .replace(/\r(?!\n)/g, '')
    // Bell character
    // eslint-disable-next-line no-control-regex
    .replace(/\x07/g, '')
}

// Write to process log file
const processLog = async (name: string, data: string) => {
  const logFile = `${LOGS_DIR}/${name}.log`
  try {
    const file = Bun.file(logFile)
    const existing = await file.exists() ? await file.text() : ""
    await Bun.write(logFile, existing + stripAnsi(data))
  } catch {}
}

// Get log file path for a process
const getLogFile = (name: string) => `${LOGS_DIR}/${name}.log`

// Clear logs for a process
const clearLogs = async (name: string) => {
  const logFile = getLogFile(name)
  await $`rm -f ${logFile}`.quiet().nothrow()
}

// Read logs with mode: tail, head, or search
const readLogs = async (
  processName: string,
  mode: 'tail' | 'head' | 'search',
  count: number = 50,
  pattern?: string,
  context: number = 2
): Promise<{ success: boolean, data?: string, error?: string }> => {
  let logFile: string
  if (processName === '_caddy') {
    logFile = CADDY_LOG
  } else if (processName === '_audit') {
    logFile = AUDIT_LOG
  } else {
    logFile = getLogFile(processName)
  }

  try {
    const file = Bun.file(logFile)
    if (!await file.exists()) {
      return { success: false, error: `Log file not found: ${processName}` }
    }

    if (mode === 'search' && pattern) {
      // Safe rg invocation - escape shell metacharacters
      const safePattern = pattern.replace(/[`$\\;"'|&<>]/g, '\\$&')
      const result = await $`rg -n -C ${context} -e ${safePattern} ${logFile}`.nothrow().text()
      return { success: true, data: result || '(no matches)' }
    } else if (mode === 'head') {
      const result = await $`head -n ${count} ${logFile}`.nothrow().text()
      return { success: true, data: result }
    } else {
      // tail (default)
      const result = await $`tail -n ${count} ${logFile}`.nothrow().text()
      return { success: true, data: result }
    }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

// ============================================================================
// Server Config Management (servers.json)
// ============================================================================

// Load server configs from ~/.config/candy/servers.json
const loadServerConfigs = async () => {
  try {
    await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
    const file = Bun.file(SERVERS_CONFIG)
    if (await file.exists()) {
      const content = await file.json() as Record<string, ServerConfig | ServerConfig[] | { cwd: string, cmd: string } | { cwd: string, cmd: string }[]>
      serverConfigs.clear()
      for (const [name, rawConfig] of Object.entries(content)) {
        const items = Array.isArray(rawConfig) ? rawConfig : [rawConfig]
        const normalized: ServerConfig[] = []
        for (const item of items) {
          if (!item || typeof item !== "object") continue
          const cwd = (item as any).cwd
          const cmd = (item as any).cmd
          if (!cwd || !cmd) continue
          const id = typeof (item as any).id === "string" && (item as any).id.length > 0
            ? (item as any).id
            : makeConfigId()
          normalized.push({ id, cwd, cmd })
        }
        if (normalized.length > 0) {
          serverConfigs.set(name, normalized)
        }
      }
      const totalConfigs = [...serverConfigs.values()].reduce((acc, cfgs) => acc + cfgs.length, 0)
      console.log(`\x1b[90mLoaded ${totalConfigs} server configs across ${serverConfigs.size} names\x1b[0m`)
    }
  } catch (e) {
    console.log(`\x1b[33mNo server configs found or invalid format\x1b[0m`)
  }
}

// Save server configs to ~/.config/candy/servers.json
const saveServerConfigs = async () => {
  const data: Record<string, ServerConfig[]> = {}
  for (const [name, configs] of serverConfigs) {
    data[name] = configs
  }
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(SERVERS_CONFIG, JSON.stringify(data, null, 2))
}

// Add a server config
const addServerConfig = async (name: string, cwd: string, cmd: string, actor: Actor = 'Portal') => {
  // Expand tilde in cwd
  const expandedCwd = cwd.replace(/^~/, process.env.HOME || '')
  const configs = getConfigsForName(name)
  const dupe = configs.find(cfg => cfg.cwd === expandedCwd && cfg.cmd === cmd)
  if (!dupe) {
    configs.push({ id: makeConfigId(), cwd: expandedCwd, cmd })
    serverConfigs.set(name, configs)
  }
  await saveServerConfigs()
  auditLog('CONFIG_ADD', `${name}: ${cmd} in ${expandedCwd}`, actor)
}

// Remove a server config
const removeServerConfig = async (name: string, actor: Actor = 'Portal', configId?: string) => {
  // Stop the process if running
  const proc = processes.get(name)
  if (proc && (proc.status === 'running' || proc.status === 'starting')) {
    if (!configId || proc.config.id === configId) {
      await stopProcess(name, actor)
    }
  }

  if (configId) {
    const remaining = getConfigsForName(name).filter(cfg => cfg.id !== configId)
    if (remaining.length > 0) {
      serverConfigs.set(name, remaining)
    } else {
      await clearLogs(name)
      processes.delete(name)
      serverConfigs.delete(name)
    }
  } else {
    await clearLogs(name)
    processes.delete(name)
    serverConfigs.delete(name)
  }
  await saveServerConfigs()
  auditLog('CONFIG_REMOVE', configId ? `${name}:${configId}` : name, actor)
}

// ============================================================================
// Void State Management - The Daemon Remembers
// ============================================================================

const loadVoidState = async () => {
  // The void is memory only - it forgets when the daemon sleeps
  // All state resets on daemon restart
  console.log(`\x1b[35m👁️ The void awakens...\x1b[0m`)
}

// saveVoidState removed - void is memory only, forgets when daemon sleeps

// Mark the user - they have been touched by the void (memory only - resets on daemon restart)
const markByVoid = async () => {
  voidState.marked = true
  voidState.markedAt = voidState.markedAt || Date.now()
  voidState.pity = -20 // Reset pity when void storm triggers
  // Not saved to disk - the void forgets when daemon sleeps
  auditLog('VOID_MARK', 'The void has marked this machine', 'Void')
  console.log(`\x1b[35m👁️ THE VOID HAS MARKED THIS MACHINE\x1b[0m`)
}

// Trigger a void burst - chaos across all pages
const triggerVoidBurst = async () => {
  voidState.burstCount++
  voidState.lastBurst = Date.now()
  voidState.burstPending = true
  voidState.burstId = `burst_${Date.now()}_${Math.random().toString(36).slice(2)}`
  voidState.pity = -20 // Reset pity on burst
  // burstCount saved for fun stats, but mark/pity are memory only
  
  auditLog('VOID_BURST', `Burst #${voidState.burstCount} - ${voidState.burstId}`, 'Void')
  console.log(`\x1b[35;1m👁️ VOID BURST #${voidState.burstCount} - THE VOID MANIFESTS\x1b[0m`)
  
  // Notify all SSE listeners
  const encoder = new TextEncoder()
  const eventData = encoder.encode(`event: burst\ndata: ${JSON.stringify({
    burstId: voidState.burstId,
    burstCount: voidState.burstCount,
    timestamp: voidState.lastBurst,
  })}\n\n`)
  
  for (const controller of voidListeners) {
    try {
      controller.enqueue(eventData)
    } catch {
      voidListeners.delete(controller)
    }
  }
  
  // THE VOID MANIFESTS IN THE REAL WORLD
  // Spawn a calculator because the void wants to do math
  spawnVoidManifestation()
}

// The void manifests as a calculator (or other GUI chaos)
const spawnVoidManifestation = async () => {
  // GUI apps need display access - systemd services don't have this by default
  const guiEnv = {
    ...process.env,
    DISPLAY: ':1',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: `/run/user/1000`,
  }

  // Try various calculators depending on what's installed
  const calculators = [
    'gnome-calculator',
    'kcalc', 
    'xcalc',
    'galculator',
    'mate-calc',
    'qalculate-gtk',
  ]
  
  // Also try some other fun ones
  const funManifestations = [
    'xeyes',           // Classic X11 eyes that follow cursor
    'oneko',           // Cat that chases cursor
    'xsnow',           // Snow on your screen
  ]
  
  // Try calculators first (the void wants to count its victims)
  for (const calc of calculators) {
    try {
      const proc = spawn([calc], {
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
        env: guiEnv,
      })
      if (proc.pid) {
        console.log(`\x1b[35m👁️ The void manifests as: ${calc} (PID ${proc.pid})\x1b[0m`)
        auditLog('VOID_MANIFEST', `Spawned ${calc} (PID ${proc.pid})`, 'Void')
        return
      }
    } catch {
      // Try next one
    }
  }
  
  // If no calculator, try fun manifestations
  for (const fun of funManifestations) {
    try {
      const proc = spawn([fun], {
        stdout: 'ignore', 
        stderr: 'ignore',
        stdin: 'ignore',
        env: guiEnv,
      })
      if (proc.pid) {
        console.log(`\x1b[35m👁️ The void manifests as: ${fun} (PID ${proc.pid})\x1b[0m`)
        auditLog('VOID_MANIFEST', `Spawned ${fun} (PID ${proc.pid})`, 'Void')
        return
      }
    } catch {
      // The void will find another way
    }
  }
  
  // Last resort: try to send a desktop notification
  try {
    await $`DISPLAY=:1 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 notify-send -u critical "THE VOID" "I SEE YOU" -i dialog-warning`.quiet().nothrow()
    console.log(`\x1b[35m👁️ The void manifests as a notification\x1b[0m`)
    auditLog('VOID_MANIFEST', 'Desktop notification', 'Void')
  } catch {
    // The void is patient
  }
}

// ============================================================================
// Process Management
// ============================================================================

// Extract ports from output using detection patterns
const extractPorts = (output: string): number[] => {
  const ports = new Set<number>()
  for (const pattern of PORT_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(output)) !== null) {
      const port = parseInt(match[1])
      if (port >= 1024 && port <= 65535) {
        ports.add(port)
      }
    }
  }
  return [...ports]
}

// Spawn a dev server process using Bun.Terminal for proper PTY support
const spawnProcess = async (name: string, actor: Actor = 'System', configId?: string): Promise<ManagedProcess> => {
  const config = getConfigById(name, configId)
  if (!config) {
    throw new Error(`No config found for server: ${name}`)
  }

  const logFile = getLogFile(name)
  // Add restart separator to log file (don't clear)
  await processLog(name, `\n--- PROCESS RESTART ${new Date().toISOString()} ---\n\n`)

  const managed: ManagedProcess = {
    name,
    config,
    proc: null,
    pid: null,
    status: 'starting',
    port: null,
    startedAt: new Date(),
    lastActivity: Date.now(),
    exitCode: null,
    logFile,
    detectedPorts: [],
    terminal: null,
  }

  processes.set(name, managed)
  auditLog('PROCESS_START', `${name}:${config.id} ${config.cmd}`, actor)

  // Collected output for port detection
  let collectedOutput = ''
  let lastLoggedLine = ''

  const startPortDetection = () => {
    const startTime = Date.now()
    const checkInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime

      // Stop checking if process is no longer starting
      if (managed.status !== 'starting') {
        clearInterval(checkInterval)
        return
      }

      // If exactly one port detected, bind and mark running
      if (managed.detectedPorts.length === 1) {
        managed.port = managed.detectedPorts[0]
        managed.status = 'running'
        auditLog('STATE', `${name}: starting -> running (port ${managed.port})`, 'System')
        clearInterval(checkInterval)

        // Add route and sync (preserve persistent flag if route already exists)
        const existing = routes.get(name)
        routes.set(name, { target: managed.port, persistent: existing?.persistent || false })
        await syncCaddy()
        auditLog('ROUTE_AUTO', `${name}.localhost -> :${managed.port}`)
        return
      }

      // Timeout: keep starting state (user can manually select a port if multiple detected)
      if (elapsed >= PORT_DETECTION_TIMEOUT) {
        clearInterval(checkInterval)
      }
    }, 100)
  }

  // Spawn bash with PTY using Bun.Terminal API (v1.3.5+)
  // Use `-i -c <cmd>` so:
  // - .bashrc loads (interactive)
  // - the bash process exits when the command exits (so we can mark status dead/errored)
  const proc = spawn({
    cmd: ['bash', '-ic', config.cmd],
    cwd: config.cwd,
    env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' },
    terminal: {
      cols: 120,
      rows: 30,
      async data(terminal, data) {
        const text = stripAnsi(new TextDecoder().decode(data))
        collectedOutput += text

        // Write to log file - split on newlines, strip carriage returns, filter empty
        const timestamp = new Date().toISOString()
        const lines = text
          .split(/\r?\n/)
          .map(l => l.replace(/\r/g, '').trim())
          .filter(l => l.length > 0)
        for (const line of lines) {
          // Skip duplicate consecutive lines (bash echo)
          if (line === lastLoggedLine) continue
          lastLoggedLine = line
          await processLog(name, `[${timestamp}] [pty] ${line}\n`)
        }

        // Extract ports during starting phase
        if (managed.status === 'starting') {
          managed.detectedPorts = extractPorts(collectedOutput)
        }
      },
    },
  })

  managed.proc = proc
  managed.pid = proc.pid
  managed.terminal = proc.terminal

  // Kick off port detection asynchronously; do not block tool calls/UI on this.
  startPortDetection()

  // Handle process exit
  proc.exited.then((exitCode) => {
    // If already marked dead (intentional kill), don't overwrite with errored
    if (managed.status === 'dead') {
      managed.proc = null
      return
    }

    managed.exitCode = exitCode
    const newStatus = exitCode === 0 ? 'dead' : 'errored'
    managed.status = newStatus
    managed.proc = null
    managed.pid = null
    if (managed.terminal) {
      try { managed.terminal.close() } catch {}
      managed.terminal = null
    }
    auditLog('STATE', `${name}: ${newStatus} (exit ${exitCode})`, 'System')

    // Don't remove from processes map - keep for crash recovery UI
  })

  return managed
}

const parsePidList = (text: string): number[] =>
  text
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => parseInt(p, 10))
    .filter(p => Number.isFinite(p) && p > 0)

const getDirectChildPids = async (pid: number): Promise<number[]> => {
  const stdout = await $`pgrep -P ${pid}`.quiet().nothrow().text()
  return parsePidList(stdout)
}

// List entire process tree (children first, then parent).
// This is safer than process-group kills because npm/node often spawn into their own PGID.
const getProcessTreePids = async (pid: number, visited = new Set<number>()): Promise<number[]> => {
  if (!Number.isFinite(pid) || pid <= 0) return []
  if (visited.has(pid)) return []
  visited.add(pid)

  const children = await getDirectChildPids(pid)
  const ordered: number[] = []
  for (const child of children) {
    ordered.push(...await getProcessTreePids(child, visited))
  }
  ordered.push(pid)
  return ordered
}

const terminateProcessTree = async (pid: number, graceMs = 5000): Promise<void> => {
  const pids = await getProcessTreePids(pid)
  if (pids.length === 0) return

  // First: try graceful shutdown
  for (const p of pids) {
    await $`kill -TERM ${p}`.quiet().nothrow()
  }

  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    let anyRunning = false
    for (const p of pids) {
      if (await isPidRunning(p)) {
        anyRunning = true
        break
      }
    }
    if (!anyRunning) return
    await new Promise(r => setTimeout(r, 200))
  }

  // Fallback: hard kill anything still running
  for (const p of pids) {
    if (await isPidRunning(p)) {
      await $`kill -KILL ${p}`.quiet().nothrow()
    }
  }
}

// Stop a managed process
const stopProcess = async (name: string, actor: Actor = 'System'): Promise<boolean> => {
  const managed = processes.get(name)
  if (!managed) return false

  // Only attempt to terminate OS processes if we believe the process is active.
  // This avoids "stale PID reuse" where a dead process' old PID could later belong to an unrelated program.
  const shouldTerminate = managed.status === 'running' || managed.status === 'starting'
  let terminated = true
  if (shouldTerminate) {
    const pid = managed.pid ?? managed.proc?.pid ?? null
    if (pid && await isPidRunning(pid)) {
      await terminateProcessTree(pid, 5000)
      terminated = !(await isPidRunning(pid))
    } else if (managed.proc) {
      try { managed.proc.kill() } catch {}
    }
  }

  if (!terminated) {
    auditLog('PROCESS_STOP_FAIL', name, actor)
    return false
  }

  // Close terminal if still open
  if (managed.terminal) {
    try { managed.terminal.close() } catch {}
    managed.terminal = null
  }

  managed.status = 'dead'
  managed.exitCode = 0
  managed.proc = null
  managed.pid = null
  auditLog('PROCESS_STOP', name, actor)

  // Clear logs for fresh restart
  await clearLogs(name)

  // Remove route (keep persistent routes — they survive process stops)
  const route = routes.get(name)
  if (!route?.persistent) {
    routes.delete(name)
  }

  // Also kill associated portal/tunnel if exists
  const portal = portals.get(name)
  if (portal) {
    if (portal.proc) {
      try { portal.proc.kill() } catch {}
    } else if (portal.pid) {
      await terminateProcessTree(portal.pid, 3000)
    }
    portals.delete(name)
    auditLog('PORTAL_CLOSE', `${name} (with process)`, actor)
  }

  await syncCaddy()

  return true
}

// Restart a managed process
const restartProcess = async (name: string, actor: Actor = 'System'): Promise<ManagedProcess | null> => {
  const prev = processes.get(name)
  const stopped = await stopProcess(name, actor)
  if (!stopped) return null

  // Small delay before restart
  await new Promise(r => setTimeout(r, 500))

  if (!serverConfigs.has(name)) {
    return null
  }

  return spawnProcess(name, actor, prev?.config.id)
}

const restartLocks = new Map<string, Promise<void>>()

const scheduleRestart = (name: string, actor: Actor) => {
  if (restartLocks.has(name)) return

  const task = (async () => {
    const prev = processes.get(name)
    try {
      await stopProcess(name, actor)
      // Small delay before restart
      await new Promise(r => setTimeout(r, 500))
      if (serverConfigs.has(name)) {
        await spawnProcess(name, actor, prev?.config.id)
      }
    } finally {
      restartLocks.delete(name)
    }
  })()

  restartLocks.set(name, task)
}

// Manually set port for a process
const setProcessPort = async (name: string, port: number, actor: Actor = 'Portal'): Promise<boolean> => {
  const managed = processes.get(name)
  if (!managed) return false

  const prevStatus = managed.status
  managed.port = port
  managed.status = 'running'

  const existingRoute = routes.get(name)
  routes.set(name, { target: port, persistent: existingRoute?.persistent || false })
  await syncCaddy()
  auditLog('STATE', `${name}: ${prevStatus} -> running (port ${port}, manual)`, actor)

  return true
}

// Format uptime for display
const formatUptime = (startedAt: Date): string => {
  const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

// Check if Caddy is already running via admin API
const isCaddyRunning = async () => {
  try {
    const res = await fetch("http://localhost:2019/config/", { signal: AbortSignal.timeout(500) })
    return res.ok
  } catch {
    return false
  }
}

// Check if a PID is still running
const isPidRunning = async (pid: number): Promise<boolean> => {
  try {
    const result = await $`kill -0 ${pid} 2>/dev/null && echo "running"`.quiet().text()
    return result.includes("running")
  } catch {
    return false
  }
}

// Start Caddy in background
const startCaddy = async () => {
  await $`mkdir -p ${CADDY_CONFIG_DIR}`.quiet().nothrow()

  if (await isCaddyRunning()) {
    console.log("\x1b[33mCaddy already running\x1b[0m (relinked)")
    return
  }

  try {
    caddyProc = spawn({
      cmd: [CADDY, "run", "--config", CADDYFILE],
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    caddyProc.unref()

    await new Promise(r => setTimeout(r, 500))
    console.log("\x1b[32mCaddy started\x1b[0m (PID: " + caddyProc.pid + ")")
  } catch (e) {
    console.log("\x1b[31mFailed to start Caddy\x1b[0m")
  }
}

// Stop Caddy
const stopCaddy = async (force = false) => {
  if (caddyProc) {
    caddyProc.kill()
    console.log("\x1b[90mCaddy stopped\x1b[0m")
  } else if (force && await isCaddyRunning()) {
    try {
      await fetch("http://localhost:2019/stop", { method: "POST", signal: AbortSignal.timeout(2000) })
      console.log("\x1b[90mCaddy stopped (was detached)\x1b[0m")
    } catch {
      console.log("\x1b[31mFailed to stop Caddy\x1b[0m")
    }
  }
}

  const cleanupManagedProcesses = async () => {
    for (const [, managed] of processes) {
      if (managed.status !== 'running' && managed.status !== 'starting') continue
      const pid = managed.pid ?? managed.proc?.pid ?? null
      if (pid && await isPidRunning(pid)) {
        await terminateProcessTree(pid, 2000)
      } else if (managed.proc) {
        try { managed.proc.kill() } catch {}
      }
      if (managed.terminal) {
        try { managed.terminal.close() } catch {}
        managed.terminal = null
      }
      managed.proc = null
      managed.pid = null
      managed.status = 'dead'
      managed.exitCode = 0
    }
  }

  // Cleanup on exit
  const cleanup = async () => {
	  for (const [, { proc, pid }] of portals) {
      if (proc) {
        try { proc.kill() } catch {}
      } else if (pid && await isPidRunning(pid)) {
        await terminateProcessTree(pid, 2000)
      }
    }
    await cleanupManagedProcesses()
	  await stopCaddy(true)
	  await $`rm -f ${PID_FILE}`.quiet().nothrow()
  }

process.on("SIGINT", async () => { await cleanup(); process.exit(0) })
process.on("SIGTERM", async () => { await cleanup(); process.exit(0) })

// Load existing routes and portals from Caddyfile
const loadRoutes = async () => {
  try {
    const content = await Bun.file(CADDYFILE).text()

    const matches = content.matchAll(/^([\w-]+)\.localhost \{\s*reverse_proxy\s+(\S+)/gm)
    for (const [, name, target] of matches) {
      const t = target.startsWith("localhost:") ? parseInt(target.replace("localhost:", "")) : target
      // Don't overwrite persistent routes loaded earlier
      if (!routes.has(name)) {
        routes.set(name, { target: t, persistent: false })
      }
    }

    const portalMatch = content.match(/^# portals:(.+)$/m)
    if (portalMatch) {
      try {
        const portalData = JSON.parse(atob(portalMatch[1])) as Record<string, { port: number, url: string, pid: number }>
        for (const [name, data] of Object.entries(portalData)) {
          if (await isPidRunning(data.pid)) {
            portals.set(name, { proc: null, port: data.port, url: data.url, pid: data.pid })
          }
        }
      } catch {}
    }
  } catch {}
}

// Load persistent routes from routes.json (survives daemon restarts)
const loadPersistentRoutes = async () => {
  try {
    const content = await Bun.file(ROUTES_FILE).text()
    const data = JSON.parse(content) as Record<string, number | string>
    for (const [name, target] of Object.entries(data)) {
      routes.set(name, { target, persistent: true })
    }
  } catch {}
}

// Save only persistent routes to routes.json
const savePersistentRoutes = async () => {
  const data: Record<string, number | string> = {}
  for (const [name, route] of routes) {
    if (route.persistent) {
      data[name] = route.target
    }
  }
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(ROUTES_FILE, JSON.stringify(data, null, 2))
}

// Write Caddyfile and reload
const syncCaddy = async () => {
  let content = `# candy-localhost routes
# managed by candy-localhost - do not edit manually

{
  log {
    output file ${CADDY_LOG.replace(/\\/g, "/")}
    format json
  }
}

`
  for (const [name, route] of routes) {
    const proxyTarget = typeof route.target === "number" ? `localhost:${route.target}` : route.target
    content += `${name}.localhost {
  tls internal
  reverse_proxy ${proxyTarget}
  log
}

`
  }

  // .candy route blocks (Tailscale - HTTP only, bound to Tailscale IP)
  if (tailscaleIp) {
    for (const [name, route] of routes) {
      const proxyTarget = typeof route.target === "number" ? `localhost:${route.target}` : route.target
      content += `${name}.candy {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy ${proxyTarget}
  log
}

`
    }
  }

  // Tunnel domains (trycloudflare.com) - route to local ports
  for (const [name, { port, url }] of portals) {
    if (url) {
      const tunnelDomain = url.replace('https://', '')
      content += `${tunnelDomain} {
  reverse_proxy localhost:${port}
  log
}

`
    }
  }

  // Bound domain routes (CF tunnel -> Caddy -> server)
  // Caddy handles WS/SSE proxying correctly, unlike fetch()
  // Protected domains: forward_auth gates requests through daemon auth check
  // Unprotected domains: proxy through daemon for rate limiting + nag banner injection
  if (domainConfig) {
    for (const binding of Object.values(domainConfig.bindings || {})) {
      const managed = processes.get(binding.serverName)
      const hasAuth = binding.auth?.enabled && binding.auth?.password

      if (managed?.status === 'running' && managed.port) {
        if (hasAuth) {
          // Protected + running: forward_auth through daemon, then proxy to server
          // /candy-auth/* routes go directly to daemon for login handling
          content += `http://${binding.fqdn} {
  handle /candy-auth/* {
    reverse_proxy localhost:9999 {
      header_up X-Forwarded-Host {host}
    }
  }
  handle {
    forward_auth localhost:9999 {
      uri /candy-auth/check
      header_up X-Forwarded-Host {host}
    }
    reverse_proxy localhost:${managed.port}
  }
  log
}

`
        } else {
          // Unprotected + running: caddy proxies directly to server, no daemon in the middle
          content += `http://${binding.fqdn} {
  reverse_proxy localhost:${managed.port}
  log
}

`
        }
      } else {
        // Server not running: proxy to candy daemon for starting page
        content += `http://${binding.fqdn} {
  reverse_proxy localhost:9999
  log
}

`
      }
    }
  }

  // Kill subdomains:
  // - <name>.kill.localhost / <name>.k.localhost
  content += `*.kill.localhost, *.k.localhost {
  tls internal
  reverse_proxy localhost:9999
  log
}

`

  // Portal subdomains: <name>.portal.localhost and <name>.p.localhost
  // Opens a cloudflare tunnel and redirects after DNS propagates
  content += `*.portal.localhost, *.p.localhost {
  tls internal
  reverse_proxy localhost:9999
  log
}

`

  // .candy kill/portal subdomains (Tailscale)
  if (tailscaleIp) {
    content += `*.kill.candy, *.k.candy {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    content += `*.portal.candy, *.p.candy {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
  }

  // Everything else goes to daemon (portal, unregistered domains, etc)
  content += `*.localhost {
  tls internal
  reverse_proxy localhost:9999
  log
}

`

  // .candy catch-all (Tailscale) - portal UI, unregistered domains
  if (tailscaleIp) {
    content += `*.candy {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
  }

  if (portals.size > 0) {
    const portalData: Record<string, { port: number, url: string, pid: number }> = {}
    for (const [name, { port, url, pid, proc }] of portals) {
      const actualPid = pid || proc?.pid
      if (url && actualPid) {
        portalData[name] = { port, url, pid: actualPid }
      }
    }
    if (Object.keys(portalData).length > 0) {
      content += `# portals:${btoa(JSON.stringify(portalData))}\n`
    }
  }

  await Bun.write(CADDYFILE, content)

  try {
    await fetch("http://localhost:2019/load", {
      method: "POST",
      headers: { "Content-Type": "text/caddyfile" },
      body: content,
    })
  } catch (e) {
    console.log("\x1b[31mFailed to reload Caddy - is it running?\x1b[0m")
  }

  // Sync DNS config for candy-dns daemon
  await syncDnsConfig()

  // Propagate route changes to hub (fire-and-forget)
  advertiseToHub().catch(() => {})
}

// Parse Caddy access logs for stats
const getCaddyStats = async () => {
  const caddyHits = new Map<string, { total: number, tunnel: number, lastSeen: number }>()
  try {
    const logContent = await Bun.file(CADDY_LOG).text()
    for (const line of logContent.trim().split("\n").filter(l => l.trim())) {
      try {
        const entry = JSON.parse(line)
        // Strip port and .localhost/.candy suffix
        const host = entry.request?.host?.replace(/:\d+$/, '').replace(/\.(localhost|candy)$/, "") || ""
        if (!host) continue
        const current = caddyHits.get(host) || { total: 0, tunnel: 0, lastSeen: 0 }
        current.total++
        if (entry.request?.headers?.["Cf-Ray"]) current.tunnel++
        if (entry.ts && entry.ts > current.lastSeen) current.lastSeen = entry.ts
        caddyHits.set(host, current)
      } catch {}
    }
  } catch {}
  return caddyHits
}

// Get traffic logs for a specific domain
const getTrafficLogs = async (domain: string, count: number = 20) => {
  const logs: any[] = []
  try {
    const logContent = await Bun.file(CADDY_LOG).text()
    const allLines = logContent.trim().split("\n").filter(l => l.trim())

    for (const line of allLines) {
      try {
        const entry = JSON.parse(line)
        const host = entry.request?.host?.replace(/\.(localhost|candy)$/, "") || ""
        if (host === domain) {
          logs.push({
            time: entry.ts ? new Date(entry.ts * 1000).toISOString() : null,
            method: entry.request?.method || "?",
            path: entry.request?.uri || "/",
            status: entry.status || "?",
            isTunnel: !!entry.request?.headers?.["Cf-Ray"]
          })
        }
      } catch {}
    }
  } catch {}
  return logs.slice(-count)
}

// Strict CORS headers - localhost only
const getCorsHeaders = (origin: string | null) => {
  // Allow *.localhost and *.candy origins
  const allowed = origin && (
    origin.endsWith('.localhost') ||
    origin === 'http://localhost:9999' ||
    origin === 'https://candy.candy' ||
    origin.match(/^https?:\/\/[a-z0-9-]+\.localhost(:\d+)?$/) ||
    (tailscaleIp && origin.match(/^https?:\/\/[a-z0-9-]+\.candy$/))
  )
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Candy-Token",
    "Access-Control-Allow-Credentials": "true",
  }
}

// Token validation response
const unauthorizedResponse = (cors: ReturnType<typeof getCorsHeaders>) =>
  Response.json({ error: "Invalid or expired token. Refresh required." }, { status: 401, headers: cors })

// Control plane API server
const controlServer = Bun.serve({
  port: 9999,
  async fetch(req) {
    const url = new URL(req.url)
    const origin = req.headers.get("origin")
    const corsHeaders = getCorsHeaders(origin)

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    // === Bound Domain Auth Endpoints (forward_auth from Caddy) ===

    if (url.pathname === "/candy-auth/check") {
      // forward_auth subrequest from Caddy - check cookie + fingerprint
      const forwardedHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
      const boundMatch = resolveBindingFromHost(forwardedHost)
      if (!boundMatch) {
        return new Response('OK', { status: 200 })  // not a bound domain, pass through
      }

      const { binding } = boundMatch
      const auth = binding.auth
      const { ip, userAgent } = getFingerprint(req, controlServer)

      // No auth configured = unprotected, pass straight through (no rate limits, no auth)
      // Nag banner shows on portal page instead to guilt the owner
      if (!auth?.enabled || !auth?.password) {
        return new Response('OK', { status: 200 })
      }

      // Auth is enabled - check cookie
      const token = getAuthCookie(req, binding.subdomain)
      if (token) {
        const session = validateAuthSession(token, ip, userAgent, binding.subdomain)
        if (session) {
          // Valid session - update last seen
          session.lastSeen = Date.now()
          return new Response('OK', { status: 200 })
        }
      }

      // No valid session - return login page as 401
      try {
        const rawHtml = await Bun.file(import.meta.dir + "/public/login.html").text()
        const { blocked, retryAfter } = checkAuthBlocked(ip, userAgent)
        const html = rawHtml
          .replace('__DOMAIN__', binding.fqdn)
          .replace('__SUBDOMAIN__', binding.subdomain)
          .replace('__BLOCKED__', String(blocked))
          .replace('__RETRY_AFTER__', String(retryAfter))
        return new Response(html, {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        })
      } catch {
        return new Response('Authentication required', { status: 401 })
      }
    }

    if (req.method === "POST" && url.pathname === "/candy-auth/login") {
      // Password submission from login page
      const forwardedHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
      // Also check Origin/Referer for the domain when not forwarded
      const referer = req.headers.get('referer') || req.headers.get('origin') || ''
      const loginHost = forwardedHost || new URL(referer || 'http://localhost').hostname
      const boundMatch = resolveBindingFromHost(loginHost)
      if (!boundMatch) {
        return Response.json({ error: 'Not a bound domain' }, { status: 400 })
      }

      const { binding } = boundMatch
      const auth = binding.auth
      if (!auth?.enabled || !auth?.password) {
        return Response.json({ error: 'No password configured' }, { status: 400 })
      }

      const { ip, userAgent } = getFingerprint(req, controlServer)

      // Check fibonacci backoff block
      const { blocked, retryAfter } = checkAuthBlocked(ip, userAgent)
      if (blocked) {
        return Response.json({ error: 'Too many attempts', retryAfter }, { status: 429 })
      }

      // Parse form body or JSON
      let password = ''
      const contentType = req.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const body = await req.json() as { password?: string }
        password = body.password || ''
      } else {
        const formData = await req.formData()
        password = formData.get('password')?.toString() || ''
      }

      // Verify password
      const valid = await Bun.password.verify(password, auth.password)
      if (!valid) {
        const failure = recordAuthFailure(ip, userAgent)
        auditLog('AUTH_FAIL', `${binding.fqdn} from ${ip}`, 'System')
        return Response.json({
          error: 'Wrong password',
          retryAfter: failure.retryAfter
        }, { status: 401 })
      }

      // Correct password - issue session
      clearAuthFailures(ip, userAgent)
      const token = createAuthSession(ip, userAgent, binding.subdomain)
      const cookie = makeAuthCookie(binding.subdomain, token, binding.fqdn)
      auditLog('AUTH_SUCCESS', `${binding.fqdn} from ${ip}`, 'System')

      return new Response(null, {
        status: 302,
        headers: {
          'Set-Cookie': cookie,
          'Location': '/',
        }
      })
    }

    // === Auth Management API (daemon-side, for CLI/MCP) ===

    if (req.method === "POST" && url.pathname === "/auth/set") {
      const mcpApiKeyHeader = req.headers.get("X-Candy-API-Key")
      const isMcpRequest = !!(mcpApiKeyHeader && validateMcpApiKey(mcpApiKeyHeader))
      if (!isMcpRequest) {
        const token = req.headers.get("X-Candy-Token")
        if (!token || !consumeToken(token)) {
          return unauthorizedResponse(corsHeaders)
        }
      }

      const { subdomain, domain, password } = await req.json() as { subdomain?: string; domain?: string; password?: string }
      if ((!subdomain && !domain) || !password) {
        return Response.json({ error: "domain (or subdomain) and password required" }, { status: 400, headers: corsHeaders })
      }

      const bindingKey = resolveBindingKey(subdomain, domain)
      if (!bindingKey) {
        const target = domain || subdomain || '(unknown)'
        return Response.json({ error: `No binding found for '${target}'` }, { status: 404, headers: corsHeaders })
      }

      const ok = await setBindingPassword(bindingKey, password)
      if (!ok) {
        return Response.json({ error: `No binding found for '${bindingKey}'` }, { status: 404, headers: corsHeaders })
      }
      // Resync caddy to add forward_auth
      await syncCaddy()
      const label = domainConfig?.bindings?.[bindingKey]?.fqdn || bindingKey
      const actor: Actor = isMcpRequest ? 'AI' : 'Portal'
      auditLog('AUTH_SET', `Password set for ${label}`, actor)
      return Response.json({ success: true, message: `Password set for ${label}` }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/auth/clear") {
      const mcpApiKeyHeader = req.headers.get("X-Candy-API-Key")
      const isMcpRequest = !!(mcpApiKeyHeader && validateMcpApiKey(mcpApiKeyHeader))
      if (!isMcpRequest) {
        const token = req.headers.get("X-Candy-Token")
        if (!token || !consumeToken(token)) {
          return unauthorizedResponse(corsHeaders)
        }
      }

      const { subdomain, domain } = await req.json() as { subdomain?: string; domain?: string }
      if (!subdomain && !domain) {
        return Response.json({ error: "domain (or subdomain) required" }, { status: 400, headers: corsHeaders })
      }

      const bindingKey = resolveBindingKey(subdomain, domain)
      if (!bindingKey) {
        const target = domain || subdomain || '(unknown)'
        return Response.json({ error: `No binding found for '${target}'` }, { status: 404, headers: corsHeaders })
      }

      const ok = await clearBindingPassword(bindingKey)
      if (!ok) {
        return Response.json({ error: `No binding found for '${bindingKey}'` }, { status: 404, headers: corsHeaders })
      }
      // Invalidate all sessions for this domain
      for (const [token, session] of authSessions) {
        if (session.domain === bindingKey) authSessions.delete(token)
      }
      await syncCaddy()
      const label = domainConfig?.bindings?.[bindingKey]?.fqdn || bindingKey
      const actor: Actor = isMcpRequest ? 'AI' : 'Portal'
      auditLog('AUTH_CLEAR', `Password cleared for ${label}`, actor)
      return Response.json({ success: true, message: `Password cleared for ${label}` }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/auth/status") {
      const mcpApiKey = req.headers.get("X-Candy-API-Key")
      if (!mcpApiKey || !validateMcpApiKey(mcpApiKey)) {
        return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders })
      }
      const domains: Record<string, any> = {}
      if (domainConfig?.bindings) {
        for (const [sub, binding] of Object.entries(domainConfig.bindings)) {
          const sessionCount = [...authSessions.values()].filter(s => s.domain === sub).length
          domains[sub] = {
            fqdn: binding.fqdn,
            serverName: binding.serverName,
            authEnabled: !!binding.auth?.enabled,
            hasPassword: !!binding.auth?.password,
            activeSessions: sessionCount,
          }
        }
      }
      return Response.json({ domains }, { headers: corsHeaders })
    }

    // === Token Refresh Endpoint (no auth required) ===
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await req.json() as { token: string }
      const newToken = refreshToken(body.token)
      if (!newToken) {
        return Response.json({ error: "Invalid token. Session expired." }, { status: 401, headers: corsHeaders })
      }
      return Response.json({ token: newToken }, { headers: corsHeaders })
    }

    // === MCP Auth Endpoint (exchange bootstrap secret for API key) ===
    if (req.method === "POST" && url.pathname === "/mcp/auth") {
      const body = await req.json() as { secret: string }
      const apiKey = exchangeMcpSecret(body.secret)
      if (!apiKey) {
        return Response.json({ error: "Invalid secret" }, { status: 401, headers: corsHeaders })
      }
      auditLog('MCP_AUTH', 'MCP client authenticated', 'AI')
      return Response.json({ apiKey }, { headers: corsHeaders })
    }

    // === Web UI Routes (no token required, token is SSR'd) ===
    // Also allow SSE streams and portal status polling without token (read-only)
    // Allow all GET requests from *.localhost domains (not direct API calls)
    const hostHeader = req.headers.get("host") || ""
    const isCandyDomain = hostHeader.endsWith(".candy")
    const isBoundDomain = !!resolveBindingFromHost(hostHeader)
    const isLocalhostDomain = hostHeader.endsWith(".localhost") || hostHeader.endsWith(".localhost:9999") || isCandyDomain || isBoundDomain
    const isWebRoute = req.method === "GET" && (
      isLocalhostDomain ||
      url.pathname === "/" ||
      url.pathname === "/favicon.svg" ||
      url.pathname === "/register" ||
      url.pathname === "/portal" ||
      url.pathname.startsWith("/stream/") ||
      url.pathname.startsWith("/portal/status/")
    )

    // Void endpoints bypass auth (easter egg system needs to work across pages)
    const isVoidRoute = url.pathname.startsWith("/void/")

    // === Network Discovery API (unauthenticated, Tailscale-protected) ===
    const isCandyApi = url.pathname.startsWith("/candy/")
    if (isCandyApi) {
      // POST /candy/advertise - register routes from a remote machine
      if (req.method === "POST" && url.pathname === "/candy/advertise") {
        if (!tailscaleIp) {
          return Response.json({ error: "Tailscale not active" }, { status: 503, headers: corsHeaders })
        }
        const callerIp = normalizeIp(controlServer.requestIP(req)?.address || "")
        if (!callerIp || !isTailscaleIp(callerIp)) {
          return Response.json({ error: "Not a Tailscale peer" }, { status: 403, headers: corsHeaders })
        }
        const { routes: advertisedRoutes } = await req.json() as { routes: string[] }
        const accepted: string[] = []
        const rejected: { name: string; reason: string }[] = []

        for (const name of advertisedRoutes) {
          if (isReserved(name)) {
            rejected.push({ name, reason: "reserved" }); continue
          }
          // Local routes/configs always win
          if (routes.has(name) || serverConfigs.has(name)) {
            rejected.push({ name, reason: "owned by dns host" }); continue
          }
          const existing = remoteRecords.get(name)
          if (existing && existing.ip !== callerIp) {
            rejected.push({ name, reason: `claimed by ${existing.ip}` }); continue
          }
          // Accept: new or refresh
          remoteRecords.set(name, { ip: callerIp, advertisedAt: Date.now() })
          accepted.push(name)
        }

        if (accepted.length > 0) {
          await saveAdvertisements()
          await syncDnsConfig()
          auditLog('ADS_ACCEPTED', `${callerIp}: ${accepted.join(", ")}`, 'Network')
        }

        return Response.json({ accepted, rejected }, { headers: corsHeaders })
      }

      // GET /candy/registry - view all known records
      if (req.method === "GET" && url.pathname === "/candy/registry") {
        const local = Object.fromEntries(
          [...new Set([...routes.keys(), ...serverConfigs.keys()])]
            .map(n => [n, tailscaleIp || "unknown"])
        )
        const remote = Object.fromEntries(
          [...remoteRecords.entries()].map(([name, rec]) => [
            name, { ip: rec.ip, expiresIn: Math.max(0, ADVERTISEMENT_TTL - (Date.now() - rec.advertisedAt)) }
          ])
        )
        return Response.json({ local, remote }, { headers: corsHeaders })
      }
    }

    // === API Routes require token validation ===
    // MCP/CLI uses X-Candy-API-Key header (obtained via /mcp/auth with secret)
    const mcpApiKey = req.headers.get("X-Candy-API-Key")
    const isMCP = mcpApiKey && validateMcpApiKey(mcpApiKey)
    if (!isWebRoute && !isMCP && !isVoidRoute && !isBoundDomain && !isCandyApi) {
      const token = req.headers.get("X-Candy-Token")
      if (!token || !consumeToken(token)) {
        return unauthorizedResponse(corsHeaders)
      }
    }

    // === Unprotected Bound Domain Proxy (non-GET methods) ===
    // For unprotected bound domains, all traffic routes through daemon for rate limiting
    if (isBoundDomain && req.method !== "GET") {
      const boundProxyMatch = resolveBindingFromHost(hostHeader)
      if (boundProxyMatch) {
        const { binding } = boundProxyMatch
        const hasAuth = binding.auth?.enabled && binding.auth?.password
        if (!hasAuth) {
          const managed = processes.get(binding.serverName)
          if (managed?.status === 'running' && managed.port) {
            const { ip } = getFingerprint(req, controlServer)
            if (!checkRateLimit(ip, binding.subdomain)) {
              return new Response('Rate limited', { status: 429 })
            }
            managed.lastActivity = Date.now()
            try {
              const proxyHeaders = new Headers(req.headers)
              proxyHeaders.set('host', `localhost:${managed.port}`)
              const proxyRes = await fetch(`http://localhost:${managed.port}${url.pathname}${url.search}`, {
                method: req.method,
                headers: proxyHeaders,
                body: req.body,
                signal: AbortSignal.timeout(30000),
              })
              return new Response(proxyRes.body, { status: proxyRes.status, headers: proxyRes.headers })
            } catch (e) {
              return new Response(`Proxy error: ${e}`, { status: 502 })
            }
          }
        }
      }
    }

    // === Route Management ===

    if (req.method === "POST" && url.pathname === "/register") {
      const body = await req.json() as { name: string; port?: number; target?: string }
      const { name } = body

      // Reserved names
      if (isReserved(name)) {
        return Response.json({ error: "That name is reserved. Nice try though.", details: name }, { status: 403, headers: corsHeaders })
      }

      const isRestricted = body.target && (body.target.startsWith("http://") || body.target.startsWith("https://"))
      const routeTarget = isRestricted ? body.target! : body.port!

      if (!isRestricted) {
        const existingRoute = [...routes.entries()].find(([n, r]) => r.target === routeTarget && n !== name)
        if (existingRoute) {
          const m = pick(msg.portCollision)
          return Response.json({ error: m, details: `${existingRoute[0]} has :${routeTarget}` }, { status: 409, headers: corsHeaders })
        }
      }

      const persistent = body.persistent === true
      routes.set(name, { target: routeTarget, persistent })
      await syncCaddy()
      if (persistent) await savePersistentRoutes()

      if (isRestricted) {
        log("RESTRICTED", `${name}.localhost -> ${routeTarget}`)
        return Response.json({
          domain: `${name}.localhost`,
          status: "registered",
          restricted: true,
          message: "You've entered the restricted zone."
        }, { headers: corsHeaders })
      } else {
        const m = pick(msg.added)
        log("ADD", `${name}.localhost -> :${routeTarget}`)
        return Response.json({ domain: `${name}.localhost`, status: "registered", message: m }, { headers: corsHeaders })
      }
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/register/")) {
      const name = url.pathname.split("/")[2]
      if (isReserved(name)) {
        return Response.json({ error: "That name is reserved. Nice try though.", details: name }, { status: 403, headers: corsHeaders })
      }
      if (!routes.has(name)) {
        return Response.json({ error: pick(msg.notFound), details: name }, { status: 404, headers: corsHeaders })
      }

      // Also stop the associated process if running
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      const proc = processes.get(name)
      if (proc && (proc.status === 'running' || proc.status === 'starting')) {
        await stopProcess(name, actor)
      }

      const wasRoute = routes.get(name)
      routes.delete(name)
      await syncCaddy()
      if (wasRoute?.persistent) await savePersistentRoutes()
      const m = pick(msg.removed)
      log("REMOVE", `${name}.localhost`)
      return Response.json({ status: "removed", message: m }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/rename") {
      const { oldName, newName } = await req.json() as { oldName: string, newName: string }

      if (isReserved(oldName) || isReserved(newName)) {
        return Response.json({ error: "That name is reserved. Nice try though.", details: "portal" }, { status: 403, headers: corsHeaders })
      }
      if (!routes.has(oldName)) {
        return Response.json({ error: pick(msg.notFound), details: oldName }, { status: 404, headers: corsHeaders })
      }
      if (routes.has(newName)) {
        return Response.json({ error: `New identity '${newName}' already exists.`, details: newName }, { status: 409, headers: corsHeaders })
      }

      const routeData = routes.get(oldName)!
      routes.delete(oldName)
      routes.set(newName, routeData)
      if (routeData.persistent) await savePersistentRoutes()

      if (portals.has(oldName)) {
        const portalData = portals.get(oldName)!
        portals.delete(oldName)
        portals.set(newName, portalData)
      }

      await syncCaddy()
      const m = pick(msg.launder)
      log("RENAME", `${oldName} -> ${newName}`)
      return Response.json({ status: "renamed", oldName, newName, message: m }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/routes") {
      const routeList: Record<string, { target: number | string, isRestricted: boolean, persistent: boolean }> = {}
      for (const [name, route] of routes) {
        if (isReserved(name)) continue  // hide reserved
        routeList[name] = {
          target: route.target,
          isRestricted: typeof route.target === "string",
          persistent: route.persistent
        }
      }
      return Response.json(routeList, { headers: corsHeaders })
    }

    // === Portal Management ===

    if (req.method === "POST" && url.pathname === "/portal") {
      const body = await req.json() as { name?: string, port?: number, openBrowser?: boolean }
      let { name, port } = body
      const { openBrowser } = body

      // If no port provided but name is given, look up from running processes
      if (!port && name) {
        const proc = processes.get(name)
        if (proc?.port) {
          port = proc.port
        } else {
          return Response.json({ error: `Server '${name}' is not running or has no port.` }, { status: 400, headers: corsHeaders })
        }
      }

      if (!port) {
        return Response.json({ error: "Port is required" }, { status: 400, headers: corsHeaders })
      }

      const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
      if (existingPortal) {
        const m = pick(msg.portalCollision)
        return Response.json({ error: m, details: `${existingPortal[0]} has :${port}` }, { status: 409, headers: corsHeaders })
      }

      let portalName = name
      if (!portalName) {
        let anonCounter = 1
        while (portals.has(`anon-${anonCounter}`)) anonCounter++
        portalName = `anon-${anonCounter}`
      }

      if (isReserved(portalName)) {
        return Response.json({ error: "That name is reserved. Nice try though.", details: portalName }, { status: 403, headers: corsHeaders })
      }

      if (portals.has(portalName)) {
        const m = pick(msg.portalCollision)
        return Response.json({ error: m, details: `${portalName} already open` }, { status: 409, headers: corsHeaders })
      }

      if (!routes.has(portalName)) {
        routes.set(portalName, { target: port, persistent: false })
        await syncCaddy()
      }

      const cfProc = spawn({
        cmd: ["cloudflared", "tunnel", "--config", "/dev/null", "--no-tls-verify", "--url", `https://${portalName}.localhost`],
        stdout: "pipe",
        stderr: "pipe",
      })
      portals.set(portalName, { proc: cfProc, port })

      const tunnelUrl = await new Promise<string | null>((resolve) => {
        const reader = cfProc.stderr.getReader()
        const decoder = new TextDecoder()
        const read = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) { resolve(null); return }
            const text = decoder.decode(value)
            const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
            if (match) { resolve(match[0]); return }
          }
        }
        read()
      })

      if (tunnelUrl) {
        const portal = portals.get(portalName)
        if (portal) {
          portal.url = tunnelUrl
          portal.pid = cfProc.pid
          // Track tunnel -> server mapping for stats history
          tunnelHistory.set(tunnelUrl.replace('https://', ''), portalName)
          await syncCaddy()
        }

        if (openBrowser) {
          setTimeout(() => {
            spawn({ cmd: ["xdg-open", tunnelUrl], stdout: "ignore", stderr: "ignore" })
          }, 30000)
        }

        const m = pick(msg.portalSuccess)
        log("PORTAL", `${portalName} -> ${tunnelUrl}`)
        return Response.json({ name: portalName, url: tunnelUrl, port, message: m }, { headers: corsHeaders })
      } else {
        portals.delete(portalName)
        return Response.json({ error: "Tunnel collapsed. Even our connections have limits." }, { status: 500, headers: corsHeaders })
      }
    }

    if (req.method === "POST" && url.pathname === "/portal/batch") {
      const { targets } = await req.json() as { targets?: (string | number)[] }

      const batchTargets: { name: string, port: number }[] = []

      if (!targets || targets.length === 0) {
        for (const [name, route] of routes) {
          if (typeof route.target === "string") continue
          if (!portals.has(name)) batchTargets.push({ name, port: route.target as number })
        }
        if (batchTargets.length === 0) {
          return Response.json({ error: pick(msg.noRoutes) }, { status: 400, headers: corsHeaders })
        }
      } else {
        for (const arg of targets) {
          if (typeof arg === "number") {
            const port = arg
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
            if (existingPortal || batchTargets.some(t => t.port === port)) continue
            let anonCounter = 1
            while (portals.has(`anon-${anonCounter}`) || batchTargets.some(t => t.name === `anon-${anonCounter}`)) anonCounter++
            batchTargets.push({ name: `anon-${anonCounter}`, port })
          } else {
            const routeData = routes.get(arg)
            if (!routeData || typeof routeData.target === "string") continue
            if (portals.has(arg)) continue
            const routePort = routeData.target as number
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === routePort)
            if (existingPortal || batchTargets.some(t => t.port === routePort)) continue
            batchTargets.push({ name: arg, port: routePort })
          }
        }
      }

      if (batchTargets.length === 0) {
        return Response.json({ error: pick(msg.noRoutes) }, { status: 400, headers: corsHeaders })
      }

      const results = await Promise.all(batchTargets.map(async ({ name, port }) => {
        const proc = spawn({
          cmd: ["cloudflared", "tunnel", "--config", "/dev/null", "--no-tls-verify", "--url", `https://${name}.localhost`],
          stdout: "pipe",
          stderr: "pipe",
        })
        portals.set(name, { proc, port })

        const url = await new Promise<string | null>((resolve) => {
          const reader = proc.stderr.getReader()
          const decoder = new TextDecoder()
          const read = async () => {
            while (true) {
              const { done, value } = await reader.read()
              if (done) { resolve(null); return }
              const text = decoder.decode(value)
              const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
              if (match) { resolve(match[0]); return }
            }
          }
          read()
        })

        return { name, port, url, pid: proc.pid }
      }))

      const successResults: any[] = []
      for (const { name, port, url, pid } of results) {
        const portal = portals.get(name)
        if (url && portal) {
          portal.url = url
          portal.pid = pid
          // Track tunnel -> server mapping for stats history
          tunnelHistory.set(url.replace('https://', ''), name)
          log("PORTAL", `${name} -> ${url}`)
          successResults.push({ name, port, url })
        } else {
          portals.delete(name)
        }
      }
      await syncCaddy()

      return Response.json({
        portals: successResults,
        message: pick(msg.batchOpening)
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/portals") {
      const portalList: Record<string, { port: number, url?: string }> = {}
      for (const [name, { port, url }] of portals) {
        portalList[name] = { port, url }
      }
      return Response.json(portalList, { headers: corsHeaders })
    }

    // Get single portal status (for polling from portaling.html)
    if (req.method === "GET" && url.pathname.startsWith("/portal/status/")) {
      const name = url.pathname.split("/")[3]
      const portal = portals.get(name)
      if (!portal) {
        return Response.json({ exists: false }, { headers: corsHeaders })
      }
      return Response.json({
        exists: true,
        url: portal.url,
        port: portal.port,
        ready: !!portal.url
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/portal/close/")) {
      const name = url.pathname.split("/")[3]
      const toClose = portals.get(name)

      if (!toClose) {
        return Response.json({ error: pick(msg.notFound), details: `portal: ${name}` }, { status: 404, headers: corsHeaders })
      }

      if (toClose.proc) {
        try { toClose.proc.kill() } catch {}
      } else if (toClose.pid) {
        await terminateProcessTree(toClose.pid, 3000)
      }
      portals.delete(name)
      await syncCaddy()

      const m = pick(msg.portalClosed)
      log("CLOSE", name)
      return Response.json({ status: "closed", name, message: m }, { headers: corsHeaders })
    }

    // === Logs & Stats ===

    if (req.method === "GET" && url.pathname === "/logs") {
      const count = parseInt(url.searchParams.get("count") || "20")
      return Response.json({
        logs: activityLog.slice(-count).map(e => ({
          time: e.time.toISOString(),
          action: e.action,
          details: e.details
        })),
        total: activityLog.length
      }, { headers: corsHeaders })
    }

    // Process logs: /logs/:name?mode=tail|head|search&lines=50&pattern=error&context=2
    if (req.method === "GET" && url.pathname.startsWith("/logs/")) {
      const name = url.pathname.slice(6) // strip "/logs/"
      if (!name) {
        return Response.json({ error: "Missing process name" }, { status: 400, headers: corsHeaders })
      }
      const mode = (url.searchParams.get("mode") || "tail") as 'tail' | 'head' | 'search'
      const lines = parseInt(url.searchParams.get("lines") || "50")
      const pattern = url.searchParams.get("pattern") || undefined
      const context = parseInt(url.searchParams.get("context") || "2")

      const result = await readLogs(name, mode, lines, pattern, context)
      if (!result.success) {
        return Response.json({ error: result.error }, { status: 404, headers: corsHeaders })
      }
      return Response.json({ logs: result.data }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      const caddyHits = await getCaddyStats()
      const totalReqs = [...caddyHits.values()].reduce((a, b) => a + b.total, 0)
      const sessionStart = activityLog[0]?.time || new Date()

      // Use tunnelHistory for tunnel -> server mapping (includes dead tunnels)
      const tunnelToServer = tunnelHistory

      // Build domains list with children
      const domainsMap = new Map<string, { name: string, total: number, alive: boolean, children: { name: string, url: string, total: number, alive: boolean }[] }>()

      for (const [domain, { total }] of caddyHits) {
        // Skip reserved names (portal, kill, etc)
        if (isReserved(domain)) continue

        const serverName = tunnelToServer.get(domain)
        if (serverName) {
          // This is a tunnel domain - add as child
          if (!domainsMap.has(serverName)) {
            const proc = processes.get(serverName)
            domainsMap.set(serverName, {
              name: serverName,
              total: 0,
              alive: proc?.status === 'running',
              children: []
            })
          }
          const portal = portals.get(serverName)
          // Tunnel is alive only if it matches the current active portal URL
          const isCurrentTunnel = portal?.url === `https://${domain}`
          const tunnelAlive = isCurrentTunnel && !!(portal?.proc || (portal?.pid && await isPidRunning(portal.pid)))
          const entry = domainsMap.get(serverName)!
          entry.children.push({ name: domain, url: `https://${domain}`, total, alive: tunnelAlive })
          entry.total += total
        } else {
          // Standalone domain
          if (!domainsMap.has(domain)) {
            const proc = processes.get(domain)
            domainsMap.set(domain, {
              name: domain,
              total: 0,
              alive: proc?.status === 'running',
              children: []
            })
          }
          domainsMap.get(domain)!.total += total
        }
      }

      // Sort children and convert to array
      const domains = [...domainsMap.values()]
        .map(d => {
          d.children.sort((a, b) => b.total - a.total)
          return d
        })
        .sort((a, b) => b.total - a.total)

      return Response.json({
        sessionStart: sessionStart.toISOString(),
        totalRequests: totalReqs,
        domains
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname.startsWith("/traffic/")) {
      const domain = url.pathname.split("/")[2]
      const count = parseInt(url.searchParams.get("count") || "20")
      const logs = await getTrafficLogs(domain, count)

      return Response.json({
        domain,
        count: logs.length,
        logs
      }, { headers: corsHeaders })
    }

    // === Status & Control ===

    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: "running",
        caddyRunning: await isCaddyRunning(),
        routeCount: routes.size,
        portalCount: portals.size,
        uptime: process.uptime(),
        pid: process.pid
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      const m = pick(msg.exit)
      setTimeout(async () => {
        await cleanup()
        process.exit(0)
      }, 100)
      return Response.json({ status: "shutting_down", message: m }, { headers: corsHeaders })
    }

    // === Process Management API ===

    if (req.method === "GET" && url.pathname === "/processes") {
      const processList: Record<string, any> = {}
      for (const [name, proc] of processes) {
        processList[name] = {
          status: proc.status,
          port: proc.port,
          pid: proc.pid,
          uptime: formatUptime(proc.startedAt),
          exitCode: proc.exitCode,
          detectedPorts: proc.detectedPorts,
          configId: proc.config.id,
          cwd: proc.config.cwd,
          cmd: proc.config.cmd,
        }
      }
      return Response.json({ success: true, processes: processList }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/process/start/")) {
      const name = url.pathname.split("/")[3]
      if (!serverConfigs.has(name)) {
        return Response.json({ success: false, error: `No config for server: ${name}` }, { status: 404, headers: corsHeaders })
      }
      try {
        const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
        const body = await req.json().catch(() => ({})) as { configId?: string }
        const requestedConfigId = body?.configId
        const configs = getConfigsForName(name)
        if (configs.length > 1 && !requestedConfigId) {
          return Response.json({
            success: false,
            error: `Multiple configs found for ${name}. Choose a configId.`,
            configs: configs.map(c => ({ id: c.id, cwd: c.cwd, cmd: c.cmd }))
          }, { status: 409, headers: corsHeaders })
        }
        const existing = processes.get(name)
        if (existing && (existing.status === 'running' || existing.status === 'starting')) {
          // Single active config rule: starting a different variant switches active process.
          if (requestedConfigId && existing.config.id !== requestedConfigId) {
            await stopProcess(name, actor)
          } else {
            // Idempotent when requesting the active variant.
            return Response.json({
              success: true,
              data: {
                name,
                status: existing.status,
                port: existing.port,
                pid: existing.pid,
                detectedPorts: existing.detectedPorts,
                configId: existing.config.id,
                cwd: existing.config.cwd,
                cmd: existing.config.cmd,
              },
              message: `${name} is already ${existing.status}`
            }, { headers: corsHeaders })
          }
        }

        const managed = await spawnProcess(name, actor, requestedConfigId)
        return Response.json({
          success: true,
          data: {
            name,
            status: managed.status,
            port: managed.port,
            pid: managed.pid,
            detectedPorts: managed.detectedPorts,
            configId: managed.config.id,
            cwd: managed.config.cwd,
            cmd: managed.config.cmd,
          }
        }, { headers: corsHeaders })
      } catch (e) {
        return Response.json({ success: false, error: String(e) }, { status: 500, headers: corsHeaders })
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/process/stop/")) {
      const name = url.pathname.split("/")[3]
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      const success = await stopProcess(name, actor)
      return Response.json({ success }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/process/restart/")) {
      const name = url.pathname.split("/")[3]
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      scheduleRestart(name, actor)
      const proc = processes.get(name)
      return Response.json({
        success: true,
        data: {
          name,
          status: proc?.status || "starting",
          port: proc?.port || null,
          pid: proc?.pid || null,
          detectedPorts: proc?.detectedPorts || [],
        },
        message: restartLocks.has(name) ? "Restart scheduled" : "Restart queued"
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/process/port/")) {
      const name = url.pathname.split("/")[3]
      const { port } = await req.json() as { port: number }
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      const success = await setProcessPort(name, port, actor)
      return Response.json({ success }, { headers: corsHeaders })
    }

    // Send input to process PTY (interactive terminal input)
    if (req.method === "POST" && url.pathname.startsWith("/process/input/")) {
      const name = url.pathname.split("/")[3]
      const managed = processes.get(name)
      if (!managed) {
        return Response.json({ success: false, error: `Process not found: ${name}` }, { status: 404, headers: corsHeaders })
      }
      if (!managed.terminal) {
        return Response.json({ success: false, error: `Process has no active terminal: ${name}` }, { status: 400, headers: corsHeaders })
      }

      const { input, key } = await req.json() as { input?: string, key?: string }

      // Support both raw input and special keys
      if (input !== undefined) {
        managed.terminal.write(input)
        const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'AI'
        auditLog('PTY_INPUT', `${name}: ${input.length} chars`, actor)
      } else if (key) {
        // Handle special keys: enter, ctrl+c, ctrl+d, etc.
        const keyMap: Record<string, string> = {
          'enter': '\n',
          'return': '\n',
          'ctrl+c': '\x03',
          'ctrl+d': '\x04',
          'ctrl+z': '\x1a',
          'ctrl+l': '\x0c',
          'tab': '\t',
          'escape': '\x1b',
          'esc': '\x1b',
          'backspace': '\x7f',
          'up': '\x1b[A',
          'down': '\x1b[B',
          'right': '\x1b[C',
          'left': '\x1b[D',
        }
        const keyCode = keyMap[key.toLowerCase()]
        if (keyCode) {
          managed.terminal.write(keyCode)
          const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'AI'
          auditLog('PTY_KEY', `${name}: ${key}`, actor)
        } else {
          return Response.json({ success: false, error: `Unknown key: ${key}` }, { status: 400, headers: corsHeaders })
        }
      } else {
        return Response.json({ success: false, error: 'Provide "input" (string) or "key" (special key name)' }, { status: 400, headers: corsHeaders })
      }

      return Response.json({ success: true }, { headers: corsHeaders })
    }

    // === Config Management API ===

    if (req.method === "GET" && url.pathname === "/configs") {
      const configs: Record<string, any> = {}
      for (const [name, entries] of serverConfigs) {
        if (entries.length === 0) continue
        const first = entries[0]
        configs[name] = {
          id: first.id,
          cwd: first.cwd,
          cmd: first.cmd,
          count: entries.length,
          variants: entries.map(c => ({ id: c.id, cwd: c.cwd, cmd: c.cmd })),
        }
      }
      return Response.json({ success: true, configs }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config") {
      const { name, cwd, cmd } = await req.json() as { name: string, cwd: string, cmd: string }
      if (isReserved(name)) {
        return Response.json({ error: "That name is reserved. Nice try though.", details: name }, { status: 403, headers: corsHeaders })
      }
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      await addServerConfig(name, cwd, cmd, actor)
      const added = getConfigsForName(name).slice(-1)[0]
      return Response.json({ success: true, config: added }, { headers: corsHeaders })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/config/")) {
      const parts = url.pathname.split("/")
      const name = parts[2]
      const configId = parts[3]
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      await removeServerConfig(name, actor, configId)
      return Response.json({ success: true }, { headers: corsHeaders })
    }

    // === Bound Domains API ===

    if (req.method === "GET" && url.pathname === "/domains") {
      if (!domainConfig) {
        return Response.json({ configured: false, bindings: {} }, { headers: corsHeaders })
      }
      const bindings: Record<string, any> = {}
      for (const [subdomain, binding] of Object.entries(domainConfig.bindings || {})) {
        bindings[subdomain] = {
          subdomain: binding.subdomain,
          fqdn: binding.fqdn,
          serverName: binding.serverName,
          boundAt: binding.boundAt,
          authEnabled: !!binding.auth?.enabled,
          hasPassword: !!binding.auth?.password,
        }
      }
      return Response.json({
        configured: true,
        tunnel: domainConfig.tunnel,
        zone: domainConfig.zone,
        bindings,
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/domains/bind") {
      if (!domainConfig?.zone?.domain || !domainConfig?.tunnel?.id) {
        return Response.json({ error: "Domain config not set up. Run POST /domains/config first." }, { status: 400, headers: corsHeaders })
      }

      const { subdomain, serverName, force } = await req.json() as { subdomain: string; serverName: string; force?: boolean }
      if (!subdomain || !serverName) {
        return Response.json({ error: "subdomain and serverName are required" }, { status: 400, headers: corsHeaders })
      }

      const fqdn = `${subdomain}.${domainConfig.zone.domain}`

      // Check if serverName has a config registered
      if (!serverConfigs.has(serverName)) {
        return Response.json({ error: `No server config found for '${serverName}'. Register it first.` }, { status: 404, headers: corsHeaders })
      }

      // Check for existing DNS records via CF API
      if (!force && domainConfig.cfApiToken) {
        try {
          const checkRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domainConfig.zone.id}/dns_records?name=${fqdn}`,
            { headers: { Authorization: `Bearer ${domainConfig.cfApiToken}` }, signal: AbortSignal.timeout(10000) }
          )
          if (checkRes.ok) {
            const checkData = await checkRes.json() as any
            const existingRecords = checkData.result || []
            // Only warn about non-candy CNAME records (records we didn't create)
            const tunnelTarget = `${domainConfig.tunnel.id}.cfargotunnel.com`
            const foreignRecords = existingRecords.filter((r: any) => !(r.type === 'CNAME' && r.content === tunnelTarget))
            if (foreignRecords.length > 0) {
              return Response.json({
                warning: true,
                message: `Oh? Someone's already living at ${fqdn}... I could remove this record for you, just say the word.`,
                existingRecords: foreignRecords.map((r: any) => ({ type: r.type, content: r.content, id: r.id })),
                fqdn,
              }, { headers: corsHeaders })
            }
          }
        } catch (e) {
          auditLog('DOMAIN_DNS_CHECK_FAIL', `${fqdn}: ${e}`, 'System')
        }
      }

      // Create DNS CNAME record via cloudflared CLI
      try {
        await $`cloudflared tunnel route dns ${domainConfig.tunnel.name} ${fqdn}`.quiet().nothrow()
      } catch (e) {
        auditLog('DOMAIN_DNS_ROUTE_FAIL', `${fqdn}: ${e}`, 'System')
      }

      // Save binding
      if (!domainConfig.bindings) domainConfig.bindings = {}
      domainConfig.bindings[subdomain] = {
        subdomain,
        fqdn,
        serverName,
        boundAt: new Date().toISOString(),
      }
      await saveDomainConfig()

      // Sync ingress and restart cloudflared
      await syncCloudflaredIngress()
      await restartCloudflared()

      auditLog('DOMAIN_BIND', `${fqdn} -> ${serverName}`, isMCP ? 'AI' : 'Portal')
      return Response.json({
        message: `Welcome home, ${fqdn}~`,
        binding: domainConfig.bindings[subdomain],
      }, { headers: corsHeaders })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/domains/unbind/")) {
      if (!domainConfig) {
        return Response.json({ error: "Domain config not set up." }, { status: 400, headers: corsHeaders })
      }

      const subdomain = url.pathname.split("/")[3]
      const binding = domainConfig.bindings?.[subdomain]
      if (!binding) {
        return Response.json({ error: `No binding found for '${subdomain}'.` }, { status: 404, headers: corsHeaders })
      }

      // Delete DNS CNAME record via CF API
      if (domainConfig.cfApiToken && domainConfig.zone?.id) {
        try {
          const listRes = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${domainConfig.zone.id}/dns_records?name=${binding.fqdn}`,
            { headers: { Authorization: `Bearer ${domainConfig.cfApiToken}` }, signal: AbortSignal.timeout(10000) }
          )
          if (listRes.ok) {
            const listData = await listRes.json() as any
            for (const record of (listData.result || [])) {
              await fetch(
                `https://api.cloudflare.com/client/v4/zones/${domainConfig.zone.id}/dns_records/${record.id}`,
                { method: 'DELETE', headers: { Authorization: `Bearer ${domainConfig.cfApiToken}` }, signal: AbortSignal.timeout(10000) }
              ).catch(() => {})
            }
          }
        } catch (e) {
          auditLog('DOMAIN_DNS_DELETE_FAIL', `${binding.fqdn}: ${e}`, 'System')
        }
      }

      // Remove binding
      delete domainConfig.bindings[subdomain]
      await saveDomainConfig()

      // Sync ingress and restart cloudflared
      await syncCloudflaredIngress()
      await restartCloudflared()

      auditLog('DOMAIN_UNBIND', `${binding.fqdn}`, isMCP ? 'AI' : 'Portal')
      return Response.json({
        message: `You want me to let them go? ...fine. But they were mine first.`,
        subdomain,
        fqdn: binding.fqdn,
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/domains/config") {
      const body = await req.json() as { zone?: { id: string; domain: string }; tunnel?: { id: string; name: string; credentialsFile: string }; cfApiToken?: string }

      if (!domainConfig) {
        domainConfig = {
          tunnel: { id: '', name: '', credentialsFile: '' },
          zone: { id: '', domain: '' },
          cfApiToken: '',
          bindings: {},
        }
      }

      if (body.zone) {
        domainConfig.zone = { ...domainConfig.zone, ...body.zone }

        // If zone ID is missing but domain is provided, try to look it up via CF API
        if (!domainConfig.zone.id && domainConfig.zone.domain && domainConfig.cfApiToken) {
          try {
            const zoneRes = await fetch(
              `https://api.cloudflare.com/client/v4/zones?name=${domainConfig.zone.domain}`,
              { headers: { Authorization: `Bearer ${domainConfig.cfApiToken}` }, signal: AbortSignal.timeout(10000) }
            )
            if (zoneRes.ok) {
              const zoneData = await zoneRes.json() as any
              if (zoneData.result?.[0]?.id) {
                domainConfig.zone.id = zoneData.result[0].id
              }
            }
          } catch {}
        }
      }
      if (body.tunnel) {
        domainConfig.tunnel = { ...domainConfig.tunnel, ...body.tunnel }
      }
      if (body.cfApiToken) {
        domainConfig.cfApiToken = body.cfApiToken
      }

      await saveDomainConfig()
      auditLog('DOMAIN_CONFIG', `zone: ${domainConfig.zone.domain}, tunnel: ${domainConfig.tunnel.name}`, isMCP ? 'AI' : 'Portal')

      return Response.json({
        message: "Domain config updated",
        zone: domainConfig.zone,
        tunnel: { id: domainConfig.tunnel.id, name: domainConfig.tunnel.name },
      }, { headers: corsHeaders })
    }

    // === THE VOID API ===

    // Get void status - are they marked? is a burst pending?
    if (req.method === "GET" && url.pathname === "/void/status") {
      return Response.json({
        marked: voidState.marked,
        markedAt: voidState.markedAt,
        burstCount: voidState.burstCount,
        lastBurst: voidState.lastBurst,
        burstPending: voidState.burstPending,
        burstId: voidState.burstId,
        pity: voidState.pity,
      }, { headers: corsHeaders })
    }

    // Increment pity - feeds the void, increases storm chance (memory only)
    if (req.method === "POST" && url.pathname === "/void/pity") {
      voidState.pity++
      return Response.json({ pity: voidState.pity }, { headers: corsHeaders })
    }

    // Mark the user - called when void storm triggers in portal.html
    if (req.method === "POST" && url.pathname === "/void/mark") {
      await markByVoid()
      return Response.json({ 
        success: true, 
        message: "THE VOID HAS MARKED YOU",
        markedAt: voidState.markedAt,
      }, { headers: corsHeaders })
    }

    // Trigger a void burst - called when corruption hits 100%
    if (req.method === "POST" && url.pathname === "/void/burst") {
      await triggerVoidBurst()
      return Response.json({
        success: true,
        burstId: voidState.burstId,
        burstCount: voidState.burstCount,
      }, { headers: corsHeaders })
    }

    // Acknowledge burst was seen (clear pending flag)
    if (req.method === "POST" && url.pathname === "/void/burst/ack") {
      const { burstId } = await req.json() as { burstId: string }
      if (burstId === voidState.burstId) {
        voidState.burstPending = false
      }
      return Response.json({ success: true }, { headers: corsHeaders })
    }

    // SSE endpoint for void events - pages subscribe to receive burst notifications
    if (req.method === "GET" && url.pathname === "/void/listen") {
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          voidListeners.add(controller)
          
          // Send current state immediately
          controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify({
            marked: voidState.marked,
            burstPending: voidState.burstPending,
            burstId: voidState.burstId,
          })}\n\n`))
          
          // Heartbeat every 15s to keep connection alive (also re-sends state)
          const heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({
                marked: voidState.marked,
                burstPending: voidState.burstPending,
                time: Date.now(),
              })}\n\n`))
            } catch {
              clearInterval(heartbeat)
              voidListeners.delete(controller)
            }
          }, 15000)
          
          // Cleanup on abort
          req.signal.addEventListener('abort', () => {
            clearInterval(heartbeat)
            voidListeners.delete(controller)
            controller.close()
          })
        }
      })
      
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...corsHeaders,
        }
      })
    }

    // === SSE Streaming Logs ===

    if (req.method === "GET" && url.pathname.startsWith("/stream/")) {
      const name = url.pathname.split("/")[2]
      const logFile = getLogFile(name)

      // Return SSE stream
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          let lastSize = 0

          const sendEvent = (data: string) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
          }

          // Initial content
          try {
            const file = Bun.file(logFile)
            if (await file.exists()) {
              const content = await file.text()
              lastSize = content.length
              sendEvent(content)
            }
          } catch {}

          // Poll for new content
          const interval = setInterval(async () => {
            try {
              const file = Bun.file(logFile)
              if (await file.exists()) {
                const content = await file.text()
                if (content.length > lastSize) {
                  const newContent = content.slice(lastSize)
                  lastSize = content.length
                  sendEvent(newContent)
                }
              }

              // Also send process status updates
              const proc = processes.get(name)
              if (proc) {
                controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({
                  status: proc.status,
                  port: proc.port,
                  detectedPorts: proc.detectedPorts,
                })}\n\n`))
              }
            } catch {}
          }, 500)

          // Cleanup on abort
          req.signal.addEventListener('abort', () => {
            clearInterval(interval)
            controller.close()
          })
        }
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          ...corsHeaders,
        }
      })
    }

    // === Web UI ===

    // SSR inject token into HTML - creates a new session for each page load
    const injectToken = (html: string): string => {
      const token = createSession() // new session per page load
      const tokenScript = `<script>window.CANDY_TOKEN="${token}";</script>`
      // Inject before the first <script> tag or at the end of <head>
      if (html.includes('<script>')) {
        return html.replace('<script>', tokenScript + '<script>')
      }
      return html.replace('</head>', tokenScript + '</head>')
    }

    // Inject variables into HTML
    const injectVars = (html: string, vars: Record<string, any>): string => {
      let result = injectToken(html)
      const varsScript = `<script>window.CANDY_VARS=${JSON.stringify(vars)};</script>`
      if (result.includes('window.CANDY_TOKEN')) {
        result = result.replace('</script>', `</script>${varsScript}`)
      } else {
        result = result.replace('</head>', varsScript + '</head>')
      }
      return result
    }

    if (req.method === "GET" && url.pathname === "/favicon.svg") {
      try {
        const svg = await Bun.file(import.meta.dir + "/public/favicon.svg").text()
        return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } })
      } catch {
        return new Response("", { status: 404 })
      }
    }

    // Parse host header
    const reqHost = req.headers.get("host")?.replace(":9999", "").replace(":80", "") || ""

    // Network dashboard at candy.candy
    if (reqHost === "candy.candy" && req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const rawHtml = await Bun.file(import.meta.dir + "/public/network.html").text()
      const html = injectToken(rawHtml)
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    // Detect if request is coming via .candy TLD (Tailscale)
    const isCandy = reqHost.endsWith(".candy")
    // Build a domain URL with the correct scheme/TLD
    const domainUrl = (name: string) => isCandy ? `https://${name}.candy` : `https://${name}.localhost`

    // Handle kill hostnames:
    // - <name>.kill.localhost / <name>.k.localhost
    const killSuffixMatch = reqHost.match(/^([a-z0-9-]+)\.(kill|k)\.(localhost|candy)$/)
    if (killSuffixMatch && req.method === "GET") {
      const serverName = killSuffixMatch[1]

      // Stop the process if running (Page actor - direct browser access)
      const proc = processes.get(serverName)
      if (proc && (proc.status === 'running' || proc.status === 'starting')) {
        await stopProcess(serverName, 'Page')
      }

      // Serve killed.html
      try {
        const rawHtml = await Bun.file(import.meta.dir + "/public/killed.html").text()
        const html = injectVars(rawHtml, { name: serverName })
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      } catch {
        return new Response(`Process "${serverName}" killed. <a href="${domainUrl("portal")}">Return to portal</a>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        })
      }
    }

    // Handle portal subdomain: <name>.portal.localhost or <name>.p.localhost
    const portalMatch = reqHost.match(/^([a-z0-9-]+)\.(portal|p)\.(localhost|candy)$/)
    if (portalMatch && req.method === "GET") {
      const serverName = portalMatch[1]

      // Check if process is running
      const proc = processes.get(serverName)
      if (!proc || proc.status !== 'running' || !proc.port) {
        // Check if config exists
        const hasConfig = serverConfigs.has(serverName)
        const message = hasConfig
          ? `Server "${serverName}" is not running.`
          : `Server "${serverName}" does not exist.`
        const action = hasConfig
          ? `<a href="${domainUrl(serverName)}" class="btn">Start Server</a>`
          : `<a href="${domainUrl("portal")}" class="btn">Go to Portal</a>`

        return new Response(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Server Not Running</title>
<style>
  body { font-family: system-ui; background: #0a0a0f; color: #e0e0e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .box { text-align: center; padding: 2rem; }
  h1 { font-size: 1.2rem; margin-bottom: 1rem; }
  .btn { display: inline-block; padding: 0.6rem 1.2rem; background: #00e5ff; color: #0a0a0f; text-decoration: none; border-radius: 4px; margin-top: 1rem; }
</style>
</head><body>
<div class="box">
  <h1>${message}</h1>
  ${action}
</div>
</body></html>`, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
          status: 404
        })
      }

      // Check if portal already exists
      let existingPortal = portals.get(serverName)
      if (!existingPortal) {
        // Create a new portal
        auditLog('PORTAL_CREATE', `${serverName} (auto from ${serverName}.p.localhost)`, 'Page')

        // Start cloudflared tunnel
        const tunnelProc = spawn({
          cmd: ['cloudflared', 'tunnel', '--config', '/dev/null', '--no-tls-verify', '--url', `https://${serverName}.localhost`],
          stdout: 'pipe',
          stderr: 'pipe',
        })

        existingPortal = {
          port: proc.port,
          url: null,
          pid: tunnelProc.pid,
          proc: tunnelProc,
        }
        portals.set(serverName, existingPortal)

        // Capture tunnel URL from stderr
        const reader = tunnelProc.stderr.getReader()
        const decoder = new TextDecoder()
        const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

        ;(async () => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              const text = decoder.decode(value)
              const match = text.match(urlPattern)
              if (match && existingPortal) {
                existingPortal.url = match[0]
                // Track tunnel -> server mapping for stats history
                tunnelHistory.set(match[0].replace('https://', ''), serverName)
                auditLog('PORTAL_READY', `${serverName} -> ${match[0]}`, 'System')
                await syncCaddy()
                break
              }
            }
          } catch {}
        })()
      }

      // Serve the portal loading page
      try {
        const rawHtml = await Bun.file(import.meta.dir + "/public/portaling.html").text()
        const html = injectVars(rawHtml, {
          name: serverName,
          existingUrl: existingPortal?.url || ''
        })
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      } catch {
        return new Response(`Creating tunnel for "${serverName}"... Refresh in a few seconds.`, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        })
      }
    }

    // Bound domain requests:
    // - Protected domains (auth enabled): Caddy uses forward_auth, daemon only sees auth checks
    // - Unprotected domains: Caddy routes ALL requests here for rate limiting + nag injection
    // - Server not running: Caddy falls back to :9999 for starting page

    // Main routing logic for *.localhost and bound domains
    if (req.method === "GET") {
      try {
        // Check if this is a bound domain request (e.g. inksp.inkspired.ai)
        const boundMatch = resolveBindingFromHost(reqHost)
        const domain = boundMatch ? boundMatch.serverName : reqHost.replace(/\.(localhost|candy)$/, "")
        const isBoundDomain = !!boundMatch
        const isRootPath = url.pathname === "/" || url.pathname === ""

        // For bound domains, build redirect URL using the FQDN
        const boundDomainUrl = (path: string) => isBoundDomain ? `https://${boundMatch!.binding.fqdn}${path}` : `${domainUrl(domain)}${path}`

        // Portal UI at portal.localhost (only root)
        if (domain === "portal" && isRootPath && !isBoundDomain) {
          domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
          const rawHtml = await Bun.file(import.meta.dir + "/public/portal.html").text()
          let html = injectToken(rawHtml)
          // Check if any bound domain is unprotected → inject nag banner on portal
          const domainConfig = loadDomainConfig()
          const hasUnprotected = domainConfig?.bindings && Object.values(domainConfig.bindings).some((b: any) => !b.auth?.password || !b.auth?.enabled)
          if (hasUnprotected) {
            const nagScript = `<script data-candy-nag>(function(){if(document.querySelector('[data-candy-nag-banner]'))return;var b=document.createElement('div');b.setAttribute('data-candy-nag-banner','1');b.innerHTML='<span style="margin-right:8px">&#127852;</span> you have unprotected bound domains <button onclick="this.parentElement.style.display=\\'none\\'" style="background:none;border:none;color:#fff;cursor:pointer;margin-left:12px;font-size:14px">&#10005;</button>';b.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(255,0,170,0.9);color:#fff;padding:10px 20px;border-radius:8px;font-family:system-ui,sans-serif;font-size:13px;z-index:999999;backdrop-filter:blur(8px);box-shadow:0 4px 20px rgba(255,0,170,0.3);display:flex;align-items:center;white-space:nowrap';document.body.appendChild(b);setTimeout(function(){b.style.display='none';setTimeout(function(){b.style.display='flex'},10000)},5000)})()</script>`
            html = html.replace('</body>', nagScript + '</body>')
          }
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }

        const configs = getConfigsForName(domain)
        const managed = processes.get(domain)

        if (managed) {
          if (isRootPath) {
            domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
          }

          // Process exists - check its status
          if (managed.status === 'running' && managed.port) {
            // For bound domains: check if auth is enabled
            if (isBoundDomain) {
              const bindingAuth = boundMatch!.binding.auth
              const hasAuth = bindingAuth?.enabled && bindingAuth?.password

              if (hasAuth) {
                // Protected domain: Caddy handles via forward_auth, we shouldn't get here
                // unless it's a race condition. Sync and redirect.
                await syncCaddy()
                return Response.redirect(`https://${boundMatch!.binding.fqdn}${url.pathname}${url.search}`, 302)
              }

              // Unprotected domain: caddy proxies directly to server port
              // This code shouldn't be reached (caddy doesn't route to daemon for unprotected)
              // but just in case, redirect to the bound domain itself
              managed.lastActivity = Date.now()
              return Response.redirect(`https://${boundMatch!.binding.fqdn}${url.pathname}${url.search}`, 302)
            }
            // For .localhost/.candy, ensure the route exists and redirect (Caddy takes over)
            const existRoute = routes.get(domain)
            routes.set(domain, { target: managed.port, persistent: existRoute?.persistent || false })
            await syncCaddy()
            return Response.redirect(`${domainUrl(domain)}${url.pathname}${url.search}`, 302)
          }

          if (managed.status === 'starting') {
            // Show starting page with streaming logs (preserve path for refresh)
            const rawHtml = await Bun.file(import.meta.dir + "/public/starting.html").text()
            const html = injectVars(rawHtml, {
              mode: "starting",
              name: domain,
              configId: managed.config.id,
              cwd: managed.config.cwd,
              cmd: managed.config.cmd,
              detectedPorts: managed.detectedPorts,
              returnPath: url.pathname + url.search,
            })
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          }

          if (managed.status === 'errored' || managed.status === 'dead') {
            // Show crashed page
            const rawHtml = await Bun.file(import.meta.dir + "/public/crashed.html").text()
            const html = injectVars(rawHtml, {
              name: domain,
              exitCode: managed.exitCode,
              status: managed.status,
            })
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          }
        }

        // Check if there's a server config (lazy loading)
        if (configs.length > 0) {
          if (isRootPath) {
            domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
          }

          // Multiple variants and nothing active yet -> ask which variant to start.
          if (configs.length > 1) {
            const rawHtml = await Bun.file(import.meta.dir + "/public/starting.html").text()
            const html = injectVars(rawHtml, {
              mode: "chooser",
              name: domain,
              variants: configs.map(c => ({ id: c.id, cwd: c.cwd, cmd: c.cmd })),
              returnPath: url.pathname + url.search,
            })
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          }

          // Spawn the server! (Page actor - direct browser access)
          try {
            const newProcess = await spawnProcess(domain, 'Page', configs[0].id)

            if (newProcess.status === 'running' && newProcess.port) {
              if (isBoundDomain) {
                newProcess.lastActivity = Date.now()
                try {
                  const proxyRes = await fetch(`http://localhost:${newProcess.port}${url.pathname}${url.search}`, {
                    headers: req.headers,
                    signal: AbortSignal.timeout(30000),
                  })
                  return new Response(proxyRes.body, { status: proxyRes.status, headers: proxyRes.headers })
                } catch (e) {
                  return new Response(`Proxy error: ${e}`, { status: 502 })
                }
              }
              // Auto-detected port - redirect preserving path (Caddy will take over)
              return Response.redirect(`${domainUrl(domain)}${url.pathname}${url.search}`, 302)
            }

            // Show starting page (preserve path for refresh)
            const rawHtml = await Bun.file(import.meta.dir + "/public/starting.html").text()
            const html = injectVars(rawHtml, {
              mode: "starting",
              name: domain,
              configId: newProcess.config.id,
              cwd: newProcess.config.cwd,
              cmd: newProcess.config.cmd,
              detectedPorts: newProcess.detectedPorts,
              returnPath: url.pathname + url.search,
            })
            return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          } catch (e) {
            return new Response(`Failed to start server: ${e}`, { status: 500 })
          }
        }

        // For bound domains with no server config, show an error
        if (isBoundDomain) {
          return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Server Not Found</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e0e0e8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{text-align:center;padding:2rem}h1{font-size:1.2rem;margin-bottom:1rem;color:#ff3366}</style>
</head><body><div class="box"><h1>No server config for '${domain}'</h1><p>This domain is bound but the server '${domain}' has no config registered.</p></div></body></html>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
            status: 404
          })
        }

        // No config exists - redirect non-root paths to root for registration
        if (!isRootPath) {
          return Response.redirect(`${domainUrl(domain)}/`, 302)
        }

        // Show candy/terminal page with mode toggle (registration screen)
        domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
        pageViews++
        let showDark = Math.random() < 0.15
        if (!showDark && pageViews >= 10 && !darkShownThisCycle) {
          showDark = true
        }
        if (showDark) {
          darkShownThisCycle = true
        }
        if (pageViews >= 10) {
          pageViews = 0
          darkShownThisCycle = false
        }
        const page = showDark ? "terminal.html" : "candy.html"
        const rawHtml = await Bun.file(import.meta.dir + "/public/" + page).text()
        const html = injectToken(rawHtml)
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      } catch (e) {
        return new Response("registration terminal offline: " + e, { status: 500 })
      }
    }

    return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
  }
})

// ============================================================================
// Startup Sequence
// ============================================================================

// Initialize log directory (clears on boot)
await initLogs()

// Clear access log and Caddyfile on startup (fresh slate each boot)
try {
  await Bun.write(CADDY_LOG, "")
} catch {}

// Load server configs
await loadServerConfigs()

// Load bound domain config
await loadDomainConfig()
await syncCloudflaredIngress()
await restartCloudflared()

// Load void state (the daemon remembers...)
await loadVoidState()

// Initialize MCP auth (write bootstrap secret to file)
await initMcpAuth()

// Load persistent routes first (survive daemon restarts)
await loadPersistentRoutes()

// Load remote advertisements from disk
await loadAdvertisements()

// Create fresh Caddyfile (includes persistent routes)
await syncCaddy()

// Now start Caddy
await startCaddy()

// Discover Tailscale IP for .candy TLD support
tailscaleIp = await discoverTailscaleIp()
if (tailscaleIp) {
  // Re-sync Caddy with .candy blocks now that we have the IP
  await syncCaddy()
}

// Write PID file
await Bun.write(PID_FILE, process.pid.toString())

const tailscaleStatus = tailscaleIp
  ? `\x1b[33mTailscale:\x1b[0m   ${tailscaleIp} (*.candy domains active)`
  : `\x1b[90mTailscale:\x1b[0m   not detected (*.candy domains disabled)`

console.log(`
\x1b[36m░█▀▀░█▀█░█▀█░█▀▄░█░█\x1b[0m   \x1b[90mv0.5.0 (lazy dev server orchestrator)\x1b[0m
\x1b[36m░█░░░█▀█░█░█░█░█░░█░\x1b[0m   "we spawn servers like it's 1980"
\x1b[36m░▀▀▀░▀░▀░▀░▀░▀▀░░░▀░\x1b[0m   \x1b[90mno iana was harmed. probably.\x1b[0m

\x1b[33mCaddyfile:\x1b[0m   ${CADDYFILE}
\x1b[33mServers:\x1b[0m     ${SERVERS_CONFIG}
\x1b[33mLogs:\x1b[0m        ${LOGS_DIR}
\x1b[33mControl:\x1b[0m     http://localhost:9999
\x1b[33mPID:\x1b[0m         ${process.pid}
${tailscaleStatus}

\x1b[90mLazy dev server mode active. Visit <name>.localhost to auto-start.\x1b[0m
`)

// Sweep expired remote records every 5 minutes
setInterval(async () => {
  const now = Date.now()
  let expired = 0
  for (const [name, rec] of remoteRecords) {
    if (now - rec.advertisedAt > ADVERTISEMENT_TTL) {
      remoteRecords.delete(name)
      expired++
    }
  }
  if (expired > 0) {
    auditLog('ADS_EXPIRED', `${expired} remote records expired`, 'System')
    await saveAdvertisements()
    await syncDnsConfig()
  }
}, EXPIRY_SWEEP_INTERVAL)

// Client-side: advertise to hub if we're not the DNS host
setInterval(advertiseToHub, READVERTISE_INTERVAL)
// Also advertise immediately on startup (with short delay for DNS to be ready)
setTimeout(advertiseToHub, 5000)
