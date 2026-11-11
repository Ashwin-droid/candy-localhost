/**
 * candy-localhost daemon v0.4 - Lazy Dev Server Orchestrator
 * Now with lazy-loaded dev servers and MCP integration
 *
 * Runs as a background service, manages Caddy, spawns dev servers on-demand
 */

import { $, spawn, type Subprocess } from "bun"
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs"
import { appendFile, chmod, chown, mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { userInfo } from "node:os"
import { SHARED_GROUP, SHARED_SECRET_FILE } from "./secret.ts"
import { AccessLogTail, activityFromAccessLog, countEstablished, idleVerdict, IDLE_TIMEOUT_MS, listeningPortsOf, localNameCandidates, readMemoryState, tailscaleServeTargets, type MemoryState } from "./activity.ts"
import { findCodeDir, parseEnvFile, stateDirPath, systemdRunCommand, unitName, unitOfCgroup, userEnvDir, validateEnvFilePath, validateRwPath, MAX_RW_PATHS, SANDBOX_SLICE } from "./sandbox.ts"
import { OAuthServer, type OAuthPersisted } from "./mcp-oauth.ts"
import { handleRequest as handleMcpRequest } from "./mcp.ts"
import { applyAdguardUpstreams, upstreamRule, type AdguardConfig } from "./adguard.ts"
import { CRON_JOB_ENV, LAUNCH_WRAPPER, cronMatches, cronScript, DEFAULT_CRON_TIMEOUT_S, MAX_CRON_JOBS, parseCron, validateCronJob, type CronJob } from "./cron.ts"
import { JtiBloom, readCredential, signJwt, stripCandyCredentials, verifyJwt, JWT_AUDIENCE, MAX_TOKEN_LIFETIME_S, type AuthResult, ipAllowed, isLoopback, parseCidr, TAILSCALE_RANGES } from "./server-auth.ts"

import {
  buildActionSubdomain,
  buildHostAlias,
  buildLanRecords,
  buildNetworkSnapshot,
  deriveTailscaleHostLabel,
  isPrivateLanIp,
  makeRemoteClaimKey,
  normalizeTailscaleDnsName,
  resolveLocalCandyRouteName,
  type TailscaleNodeIdentity,
} from "./tailnet"

// User-facing API messages
const msg = {
  removed: "Route removed",
  portCollision: "Port already in use by another route",
  portalSuccess: "Portal open",
  portalCollision: "A portal is already open for this route",
  portalClosed: "Portal closed",
  batchOpening: "Opening portals",
  notFound: "Not found",
  notANumber: "Port must be a number",
  noRoutes: "No routes registered",
  launder: "Route renamed",
  exit: "Shutting down",
}

// ============================================================================
// Types & Interfaces
// ============================================================================

interface ServerConfig {
  id: string
  cwd: string
  cmd: string
  user?: string  // account the server runs as (root mode); defaults to the owner
  api?: boolean  // API mode: hold the first request while starting and forward it, no loading page
  cron?: CronJob[]  // scheduled runs of cmd with extra args, set by the app via the SDK
  sandbox?: false   // opt out of the systemd sandbox (root mode); on unless false
  rw?: string[]     // extra writable paths inside the sandbox
  envFile?: string  // KEY=VALUE file handed to the server as environment at launch
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
  idling: boolean  // the app said it is only waiting for events (SDK setIdling)
  unit: string | null  // transient systemd unit, when launched sandboxed
}

// ============================================================================
// Configuration Paths
// ============================================================================

const CADDY = "caddy"
const CADDY_CONFIG_DIR = `${process.env.HOME}/.config/caddy`
const CANDY_CONFIG_DIR = `${process.env.HOME}/.config/candy`
const CADDYFILE = `${CADDY_CONFIG_DIR}/Caddyfile`
const CADDY_LOG = `${CADDY_CONFIG_DIR}/access.log`
const CADDY_PROC_LOG = `${CADDY_CONFIG_DIR}/caddy.log`
const PID_FILE = `${CADDY_CONFIG_DIR}/candy.pid`
const SERVERS_CONFIG = `${CANDY_CONFIG_DIR}/servers.json`
const ROUTES_FILE = `${CANDY_CONFIG_DIR}/routes.json`
const MCP_SECRET_FILE = `${CANDY_CONFIG_DIR}/mcp-secret`
const DOMAINS_CONFIG = `${CANDY_CONFIG_DIR}/domains.json`
const GRUDGE_FILE = `${CANDY_CONFIG_DIR}/candy-grudge.lock`
// As root, logs live in a root-owned dir: /tmp/candy-logs could be pre-created by any user
const LOGS_DIR = process.getuid?.() === 0 ? "/var/log/candy" : "/tmp/candy-logs"
const AUDIT_LOG = `${LOGS_DIR}/_audit.log`
const DNS_CONFIG_FILE = `${CANDY_CONFIG_DIR}/candy-dns.json`
const ADVERTISEMENTS_FILE = `${CANDY_CONFIG_DIR}/advertisements.json`
const LAN_FILE = `${CANDY_CONFIG_DIR}/lan.json`
const ADGUARD_FILE = `${CANDY_CONFIG_DIR}/adguard.json`
const MCP_OAUTH_FILE = `${CANDY_CONFIG_DIR}/mcp-oauth.json`
const ENTRIES_FILE = `${CANDY_CONFIG_DIR}/entries.json`
const SERVES_FILE = `${CANDY_CONFIG_DIR}/serves.json`
const CLOUDFLARED_SYSTEM_CONFIG = `/etc/cloudflared/config.yml`
const CLOUDFLARED_USER_CONFIG = `${process.env.HOME}/.cloudflared/config.yml`
const CANDY_RUNTIME_MAGIC_ENV = "X_CANDY_RUNTIME_MAGIC_STRING"

// Tailscale state (discovered at startup)
let tailscaleIp: string | null = null

// LAN publishing: names opted in to be reachable at <name>.candy from the LAN,
// not just the tailnet. Persisted to lan.json. Off for every name by default.
let lanIp: string | null = null
const lanPublished = new Set<string>()
// Published names that are also served over HTTPS on this machine's ts.net
// hostname: name -> port. Always a subset of lanPublished.
const lanHttps = new Map<string, number>()
// Published names served over HTTPS on the LAN under their bound domain
// (https://<fqdn>, Let's Encrypt certificate). A name is in at most one of
// lanHttps / lanDomainHttps.
const lanDomainHttps = new Set<string>()
const LAN_IP_REFRESH_INTERVAL = 5 * 60 * 1000  // 5 minutes

// Reserved domain names (cannot be used for servers/routes)
const RESERVED_NAMES = new Set(['portal', 'k', 'kill', 'p', 'candy'])
// Names become hostnames and file names (logs), so only DNS-safe labels are allowed.
// Anything else is treated like a reserved name and rejected.
const SAFE_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/i
const isSafeName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= 128 && SAFE_NAME.test(name)
const isReserved = (name: string) => !isSafeName(name) || RESERVED_NAMES.has(name.toLowerCase())

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
  name: string
  ip: string
  advertisedAt: number
  claimedAt: number
  ownerId: string | null
  hostName: string | null
  dnsName: string | null
  hostLabel: string | null
}

interface PidOwnedRoute {
  pid: number
  registeredAt: number
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
    jwtSecret?: string       // HMAC secret for server-to-server JWTs (API-mode sites)
  }
  // Allowlist mode: only these IPs/CIDRs (plus Tailscale and this machine) get in
  allowlist?: {
    enabled: boolean
    ips: string[]
  }
}

interface DomainConfig {
  tunnel: { id: string; name: string; credentialsFile: string }
  zone: { id: string; domain: string }
  cfApiToken: string
  bindings: Record<string, DomainBinding>
  // Public MCP endpoint (https://<subdomain>.<zone>/mcp). Off unless enabled.
  mcp?: { enabled: boolean; subdomain: string }
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

// Auth failure tracking: "ip:userAgent" -> failure state (mirrored to candy-grudge.lock)
const authFailures = new Map<string, AuthFailureState>()
let grudgeFileWatcher: FSWatcher | null = null
let authFailureIo: Promise<void> = Promise.resolve()

// Rate limiting for unauthenticated: "ip:domain" -> { timestamps[] }
const unauthRateLimit = new Map<string, number[]>()

// Rate limit blocked IPs: "ip:domain" -> unblock timestamp
const rateLimitBlocks = new Map<string, number>()

const AUTH_SESSION_TTL = 60 * 60 * 1000  // 1 hour
const AUTH_RENEWAL_THRESHOLD = 15 * 60 * 1000  // 15 minutes
const AUTH_CLEANUP_INTERVAL = 5 * 60 * 1000  // 5 minutes
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
  const direct = normalizeIp(
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    server.requestIP(req)?.address || 'unknown'
  )
  // Tunnel traffic reaches Caddy from cloudflared on loopback, so every visitor
  // would share one IP. Cloudflare's header has the real one; only trust it
  // from loopback, so a LAN client can't pick its own.
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  const ip = cf && isLoopback(direct) ? normalizeIp(cf) : direct
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
// Lockouts are per domain. The login page counts per IP + browser; API-mode
// sites count per IP, so one bad caller can't lock out the others.
const webFailureKey = (binding: DomainBinding, ip: string, userAgent: string): string => `web:${binding.subdomain}:${ip}:${userAgent}`
const apiFailureKey = (binding: DomainBinding, ip: string): string => `api:${binding.subdomain}:${ip}`

const withAuthFailureLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const run = authFailureIo.then(fn, fn)
  authFailureIo = run.then(() => undefined, () => undefined)
  return run
}

const normalizeAuthFailureState = (raw: unknown): AuthFailureState | null => {
  if (!raw || typeof raw !== "object") return null
  const count = Number((raw as any).count)
  const fibIndex = Number((raw as any).fibIndex)
  const blockedUntil = Number((raw as any).blockedUntil)
  const lastAttempt = Number((raw as any).lastAttempt)
  if (![count, fibIndex, blockedUntil, lastAttempt].every(Number.isFinite)) return null
  if (count < 0 || fibIndex < 0 || blockedUntil < 0 || lastAttempt < 0) return null
  return {
    count: Math.floor(count),
    fibIndex: Math.floor(fibIndex),
    blockedUntil,
    lastAttempt,
  }
}

const replaceAuthFailures = (raw: Record<string, unknown>) => {
  authFailures.clear()
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeAuthFailureState(value)
    if (normalized) authFailures.set(key, normalized)
  }
}

const loadAuthFailures = async (reason: 'startup' | 'sync' | 'watch' = 'sync') => {
  try {
    await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
    const file = Bun.file(GRUDGE_FILE)
    if (!(await file.exists())) {
      const cleared = authFailures.size
      authFailures.clear()
      if (reason !== 'startup' && cleared > 0) {
        console.log(`\x1b[90mGrudge file wiped - ${cleared} grudges cleared\x1b[0m`)
      }
      return
    }

    const content = await file.text()
    if (!content.trim()) {
      const cleared = authFailures.size
      authFailures.clear()
      if (reason !== 'startup' && cleared > 0) {
        console.log(`\x1b[90mGrudge file emptied - ${cleared} grudges cleared\x1b[0m`)
      }
      return
    }

    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.log(`\x1b[33mInvalid grudge file format, ignoring\x1b[0m`)
      return
    }

    replaceAuthFailures(parsed as Record<string, unknown>)
    if (reason === 'startup' && authFailures.size > 0) {
      console.log(`\x1b[90mLoaded ${authFailures.size} grudges from disk\x1b[0m`)
    }
  } catch (e) {
    console.log(`\x1b[33mFailed to load grudge file: ${e}\x1b[0m`)
  }
}

const saveAuthFailures = async () => {
  try {
    await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
    const data: Record<string, AuthFailureState> = {}
    for (const [key, state] of authFailures) {
      data[key] = { ...state }
    }
    await Bun.write(GRUDGE_FILE, JSON.stringify(data, null, 2))
  } catch (e) {
    console.log(`\x1b[33mFailed to persist grudge file: ${e}\x1b[0m`)
  }
}

const watchAuthFailures = async () => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  grudgeFileWatcher?.close()
  try {
    grudgeFileWatcher = watch(CANDY_CONFIG_DIR, (_eventType, filename) => {
      if (!filename || filename.toString() !== 'candy-grudge.lock') return
      void withAuthFailureLock(async () => {
        await loadAuthFailures('watch')
      })
    })
  } catch (e) {
    console.log(`\x1b[33mFailed to watch grudge file: ${e}\x1b[0m`)
  }
}

const checkAuthBlocked = async (key: string): Promise<{ blocked: boolean; retryAfter: number }> => {
  return withAuthFailureLock(async () => {
    await loadAuthFailures('sync')
    const state = authFailures.get(key)
    if (!state) return { blocked: false, retryAfter: 0 }
    if (state.blockedUntil > Date.now()) {
      return { blocked: true, retryAfter: Math.ceil((state.blockedUntil - Date.now()) / 1000) }
    }
    return { blocked: false, retryAfter: 0 }
  })
}

const recordAuthFailure = async (key: string): Promise<{ retryAfter: number }> => {
  return withAuthFailureLock(async () => {
    await loadAuthFailures('sync')
    const state = authFailures.get(key) || { count: 0, fibIndex: 0, blockedUntil: 0, lastAttempt: 0 }
    state.count++
    state.lastAttempt = Date.now()
    if (state.count >= 3) {
      const backoffHours = fibonacci(state.fibIndex)
      state.blockedUntil = Date.now() + backoffHours * 60 * 60 * 1000
      state.fibIndex++
      authFailures.set(key, state)
      await saveAuthFailures()
      return { retryAfter: backoffHours * 3600 }
    }
    authFailures.set(key, state)
    await saveAuthFailures()
    return { retryAfter: 0 }
  })
}

const clearAuthFailures = async (key: string) => {
  await withAuthFailureLock(async () => {
    await loadAuthFailures('sync')
    authFailures.delete(key)
    await saveAuthFailures()
  })
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

const hasBindingAuth = (binding: DomainBinding): boolean =>
  !!(binding.auth?.enabled && (binding.auth?.password || binding.auth?.jwtSecret))

const hasAllowlist = (binding: DomainBinding): boolean => !!binding.allowlist?.enabled

// Domains with auth or an allowlist go through Caddy's forward_auth check
const isGatedBinding = (binding: DomainBinding): boolean => hasBindingAuth(binding) || hasAllowlist(binding)

// Fallback only: Caddy already drops these (abort) before they reach the daemon.
// Refuse callers outside the allowlist. Not a failed login, so no lockout.
const checkAllowlist = (req: Request, server: any, binding: DomainBinding): Response | null => {
  if (!hasAllowlist(binding)) return null
  const { ip } = getFingerprint(req, server)
  if (ipAllowed(ip, binding.allowlist!.ips)) return null
  // The allowlist is for the public side. A name served on the LAN under this
  // domain is open to LAN devices (Caddy's LAN site only admits private addresses).
  if (isPrivateLanIp(ip) && lanDomainHttpsBinding(binding.serverName)?.fqdn === binding.fqdn) return null
  if (isApiSite(binding)) {
    return Response.json({ error: `${binding.fqdn} only accepts requests from allowlisted IPs.` }, { status: 403, headers: { "X-Candy": "allowlist" } })
  }
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not available</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:#eceef2;color:#1a1d33;font:15px/1.5 system-ui,sans-serif}h1{font-size:20px;margin:0 0 6px}p{margin:0;color:#555b75}@media (prefers-color-scheme:dark){body{background:#10121a;color:#e7e9f2}p{color:#a3a8c0}}</style>
</head><body><main><h1>Not available from your network</h1><p>This site only accepts visitors from approved addresses.</p></main></body></html>`, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Candy": "allowlist" },
  })
}

// ============================================================================
// Server-to-server auth (API-mode sites): Basic or JWT, no login page
// ============================================================================

const DAEMON_STARTED_S = Math.floor(Date.now() / 1000)
// Caddy copies this from a passing /candy-auth/check into the proxied request,
// so the daemon doesn't verify (and burn the jti of) the same request twice.
const CADDY_VERIFIED_NONCE = crypto.randomUUID()
const jtiBlooms = new Map<string, JtiBloom>()
const jtiBloomFor = (site: string): JtiBloom => {
  let bloom = jtiBlooms.get(site)
  if (!bloom) jtiBlooms.set(site, bloom = new JtiBloom(DAEMON_STARTED_S))
  return bloom
}
// Server went down: forget used jtis, and refuse every token issued before now
const resetJtiBloom = (site: string) => jtiBloomFor(site).reset(Math.floor(Date.now() / 1000))

const isApiSite = (binding: DomainBinding): boolean => apiModeConfig(binding.serverName) !== null

// Positive Basic checks only, so a correct password isn't re-hashed on every call
const basicAuthCache = new Map<string, number>()
const verifyBasicPassword = async (binding: DomainBinding, password: string): Promise<boolean> => {
  const hash = binding.auth?.password
  if (!hash) return false
  const key = new Bun.CryptoHasher("sha256").update(`${binding.subdomain}\0${hash}\0${password}`).digest("hex")
  const until = basicAuthCache.get(key)
  if (until && until > Date.now()) return true
  if (!await Bun.password.verify(password, hash)) return false
  if (basicAuthCache.size > 256) basicAuthCache.clear()
  basicAuthCache.set(key, Date.now() + 10 * 60 * 1000)
  return true
}

const serverAuthDenied = (binding: DomainBinding, status: number, error: string, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { "X-Candy": "auth", ...extra }
  if (status === 401 && binding.auth?.password) headers["WWW-Authenticate"] = `Basic realm="${binding.fqdn}", charset="UTF-8"`
  return Response.json({ error }, { status, headers })
}

// Returns null when the request may pass, or the error response
const checkServerAuth = async (req: Request, server: any, binding: DomainBinding): Promise<Response | null> => {
  const { ip } = getFingerprint(req, server)
  const failureKey = apiFailureKey(binding, ip)
  const { blocked, retryAfter } = await checkAuthBlocked(failureKey)
  if (blocked && retryAfter > 0) {
    return serverAuthDenied(binding, 429, `Too many failed attempts. Try again in ${retryAfter}s.`, { "Retry-After": String(retryAfter) })
  }

  const cred = readCredential(req.headers)
  let result: AuthResult
  if (!cred) {
    result = { ok: false, error: "Authentication required. Send a JWT or the domain password in X-Auth-Token (or X-Candy-Auth), or use HTTP Basic auth." }
  } else if (cred.kind === "basic") {
    result = !binding.auth?.password
      ? { ok: false, error: "This domain has no password. Send a JWT in X-Auth-Token." }
      : await verifyBasicPassword(binding, cred.password)
        ? { ok: true, via: "basic" }
        : { ok: false, error: "Wrong password", guess: true }
  } else if (!binding.auth?.jwtSecret) {
    result = { ok: false, error: "This domain has no JWT secret. Use HTTP Basic auth." }
  } else {
    const managed = processes.get(binding.serverName)
    const live = managed && (managed.status === "running" || managed.status === "starting")
    result = verifyJwt(cred.token, {
      secret: binding.auth.jwtSecret,
      site: binding.serverName,
      now: Math.floor(Date.now() / 1000),
      serverStartedAt: live ? Math.floor(managed!.startedAt.getTime() / 1000) : null,
      bloom: jtiBloomFor(binding.serverName),
    })
  }

  if (result.ok) {
    if (authFailures.get(failureKey)?.count) await clearAuthFailures(failureKey)
    return null
  }
  if (result.guess) await recordAuthFailure(failureKey)
  return serverAuthDenied(binding, 401, result.error)
}

const renderBoundDomainLogin = async (
  binding: DomainBinding,
  ip: string,
  userAgent: string,
): Promise<Response> => {
  try {
    const { blocked, retryAfter } = await checkAuthBlocked(webFailureKey(binding, ip, userAgent))
    if (blocked && retryAfter > 0) {
      const blockedHtml = (await Bun.file(import.meta.dir + "/public/blocked.html").text())
        .replace('__DOMAIN__', binding.fqdn)
        .replace('__RETRY_AFTER__', String(retryAfter))
      return new Response(blockedHtml, {
        status: 429,
        headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": String(retryAfter) }
      })
    }
    const rawHtml = await Bun.file(import.meta.dir + "/public/login.html").text()
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

const requireBoundDomainAuth = async (
  req: Request,
  server: any,
  binding: DomainBinding,
): Promise<Response | null> => {
  if (!isGatedBinding(binding)) return null
  if (req.headers.get("x-candy-verified") === CADDY_VERIFIED_NONCE) return null
  const outside = checkAllowlist(req, server, binding)
  if (outside) return outside
  if (!hasBindingAuth(binding)) return null
  if (isApiSite(binding)) return checkServerAuth(req, server, binding)

  const { ip, userAgent } = getFingerprint(req, server)
  const token = getAuthCookie(req, binding.subdomain)
  if (token) {
    const session = validateAuthSession(token, ip, userAgent, binding.subdomain)
    if (session) {
      session.lastSeen = Date.now()
      return null
    }
  }

  return renderBoundDomainLogin(binding, ip, userAgent)
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

// Set a password and/or JWT secret for a bound domain (keeps whichever isn't given)
const setBindingAuth = async (subdomain: string, opts: { password?: string; jwtSecret?: string }): Promise<boolean> => {
  const binding = domainConfig?.bindings?.[subdomain]
  if (!binding) return false
  const auth = binding.auth ?? { password: null, enabled: true }
  if (opts.password !== undefined) auth.password = await Bun.password.hash(opts.password)
  if (opts.jwtSecret !== undefined) auth.jwtSecret = opts.jwtSecret
  auth.enabled = true
  binding.auth = auth
  basicAuthCache.clear()
  await saveDomainConfig()
  return true
}

// Clear the password, the JWT secret, or both
const clearBindingAuth = async (subdomain: string, which: 'password' | 'jwt' | 'all' = 'all'): Promise<boolean> => {
  const binding = domainConfig?.bindings?.[subdomain]
  if (!binding) return false
  if (which === 'all' || !binding.auth) delete binding.auth
  else {
    if (which === 'password') binding.auth.password = null
    if (which === 'jwt') delete binding.auth.jwtSecret
    if (!binding.auth.password && !binding.auth.jwtSecret) delete binding.auth
  }
  basicAuthCache.clear()
  await saveDomainConfig()
  return true
}

const MIN_JWT_SECRET_LENGTH = 32
const generateJwtSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url')

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
  await chmod(DOMAINS_CONFIG, 0o600).catch(() => {})  // holds the API token and JWT secrets
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

// ---------------------------------------------------------------------------
// Public MCP endpoint (optional, off by default)
//
// https://<subdomain>.<zone>/mcp serves candy's MCP tools over HTTP to clients
// holding an OAuth 2.1 access token. Nobody logs in with a password: the
// authorization request is parked and the browser is sent to
// https://portal.candy/oauth/consent, which only exists on the tailnet. Being
// able to open that page and press Allow is the proof of identity, so
// Tailscale's ACLs decide who may connect a client. Approving hands back a
// one-time grant that the public host exchanges for the authorization code.
// ---------------------------------------------------------------------------

const DEFAULT_MCP_SUBDOMAIN = "candy"
let mcpOAuth: OAuthServer | null = null
let mcpOAuthFor: string | null = null  // fqdn the instance was built for

const publicMcpFqdn = (): string | null => {
  const cfg = domainConfig?.mcp
  const zone = domainConfig?.zone?.domain
  return cfg?.enabled && zone ? `${cfg.subdomain}.${zone}`.toLowerCase() : null
}

const loadMcpOAuthState = async (): Promise<OAuthPersisted | null> => {
  try {
    const file = Bun.file(MCP_OAUTH_FILE)
    return await file.exists() ? await file.json() as OAuthPersisted : null
  } catch {
    return null
  }
}

const saveMcpOAuthState = async (state: OAuthPersisted) => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(MCP_OAUTH_FILE, JSON.stringify(state, null, 2))
  await chmod(MCP_OAUTH_FILE, 0o600).catch(() => {})
}

// The OAuth server for the current public host, or null while the feature is off
const getMcpOAuth = async (): Promise<OAuthServer | null> => {
  const fqdn = publicMcpFqdn()
  if (!fqdn) return null
  if (!mcpOAuth || mcpOAuthFor !== fqdn) {
    mcpOAuth = new OAuthServer({
      issuer: `https://${fqdn}`,
      resource: `https://${fqdn}/mcp`,
      persisted: await loadMcpOAuthState(),
      onChange: (state) => { saveMcpOAuthState(state).catch(() => {}) },
    })
    mcpOAuthFor = fqdn
  }
  return mcpOAuth
}

// Where the consent page lives: the portal, on the tailnet only
const mcpConsentUrl = (requestId: string) => `https://portal.candy/oauth/consent?request=${encodeURIComponent(requestId)}`

const MCP_PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
}
const MCP_MAX_BODY = 1024 * 1024

// Unauthenticated requests to the public MCP host, per visitor IP. A client
// signing in sends a quick burst (discovery, register, token), so this is far
// looser than the 3-per-second limit on other public sites. Requests that
// carry a valid access token are not counted.
const MCP_RATE_WINDOW_MS = 10 * 1000
const MCP_RATE_MAX = 60
const MCP_RATE_BLOCK_MS = 30 * 1000
const mcpRate = new Map<string, { times: number[]; blockedUntil: number }>()

const mcpRateOk = (ip: string): boolean => {
  const now = Date.now()
  if (mcpRate.size > 5000) {
    for (const [key, entry] of mcpRate) {
      if (entry.blockedUntil < now && (entry.times.at(-1) ?? 0) < now - MCP_RATE_WINDOW_MS) mcpRate.delete(key)
    }
  }
  const entry = mcpRate.get(ip) ?? { times: [], blockedUntil: 0 }
  mcpRate.set(ip, entry)
  if (now < entry.blockedUntil) return false
  entry.times = entry.times.filter(t => now - t < MCP_RATE_WINDOW_MS)
  entry.times.push(now)
  if (entry.times.length > MCP_RATE_MAX) {
    entry.blockedUntil = now + MCP_RATE_BLOCK_MS
    return false
  }
  return true
}

const mcpJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...MCP_PUBLIC_CORS, "Cache-Control": "no-store", ...headers } })

const mcpErrorPage = (title: string, detail: string, status = 400) =>
  new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:#eceef2;color:#1a1d33;font:15px/1.5 system-ui,sans-serif}main{max-width:440px}h1{font-size:20px;margin:0 0 6px}p{margin:0;color:#555b75}@media (prefers-color-scheme:dark){body{background:#10121a;color:#e7e9f2}p{color:#a3a8c0}}</style>
</head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })

const escapeHtmlText = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!))

// Everything served on the public MCP host. Nothing else of the daemon is
// reachable through it.
const handlePublicMcp = async (req: Request, url: URL, server: any): Promise<Response> => {
  const oauth = await getMcpOAuth()
  if (!oauth) return new Response("Not found", { status: 404 })
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: MCP_PUBLIC_CORS })

  const { ip } = getFingerprint(req, server)
  const path = url.pathname.replace(/\/+$/, "") || "/"
  const tooMany = () => mcpJson({ error: "slow_down", error_description: "Too many requests. Try again in a moment." }, 429, { "Retry-After": "30" })
  if (path !== "/mcp" && !mcpRateOk(ip)) return tooMany()

  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return mcpJson(oauth.protectedResourceMetadata(), 200, { "Cache-Control": "max-age=300" })
  }
  if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) {
    return mcpJson(oauth.authorizationServerMetadata(), 200, { "Cache-Control": "max-age=300" })
  }

  if (req.method === "POST" && path === "/register") {
    const body = await req.json().catch(() => null)
    const result = oauth.registerClient(body)
    if (!result.ok) return mcpJson({ error: result.error, error_description: result.error_description }, result.status)
    auditLog('MCP_PUBLIC_CLIENT', `registered "${(result.client as any).client_name}" from ${ip}`, 'Network')
    return mcpJson(result.client, 201)
  }

  if (req.method === "GET" && path === "/authorize") {
    const result = oauth.startAuthorization(url.searchParams)
    if (result.ok) return Response.redirect(mcpConsentUrl(result.requestId), 302)
    if (result.redirect) return Response.redirect(result.redirect, 302)
    return mcpErrorPage("This sign-in link is not valid", escapeHtmlText(result.error_description), result.status)
  }

  // Back from the consent page on the tailnet, carrying the one-time grant
  if (req.method === "GET" && path === "/authorize/complete") {
    const result = oauth.complete(url.searchParams.get("request") || "", url.searchParams.get("grant") || "")
    if (result.ok) return Response.redirect(result.redirect, 302)
    return mcpErrorPage("This approval can't be used", escapeHtmlText(result.error_description), result.status)
  }

  if (req.method === "POST" && path === "/token") {
    const text = (await req.text().catch(() => "")).slice(0, 16 * 1024)
    const result = oauth.token(new URLSearchParams(text))
    if (result.status === 200) auditLog('MCP_PUBLIC_TOKEN', `issued to ${ip}`, 'Network')
    return mcpJson(result.body, result.status, { Pragma: "no-cache" })
  }

  if (path === "/mcp") {
    const challenge = { "WWW-Authenticate": `Bearer resource_metadata="https://${url.host}/.well-known/oauth-protected-resource"` }
    if (req.method !== "POST") {
      // No server-initiated stream, no sessions: POST only
      return mcpJson({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" })
    }
    const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1]
    const token = bearer ? oauth.verifyAccessToken(bearer) : null
    if (!token) {
      if (!mcpRateOk(ip)) return tooMany()
      return mcpJson({ error: "invalid_token", error_description: "Sign in again to continue." }, 401, {
        "WWW-Authenticate": `${challenge["WWW-Authenticate"]}${bearer ? ', error="invalid_token"' : ''}`,
      })
    }
    const raw = await req.text().catch(() => "")
    if (raw.length > MCP_MAX_BODY) return mcpJson({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413)
    let message: any
    try { message = JSON.parse(raw) } catch {
      return mcpJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400)
    }
    const batch = Array.isArray(message)
    const replies: unknown[] = []
    for (const item of (batch ? message : [message]).slice(0, 50)) {
      if (!item || typeof item !== "object" || typeof item.method !== "string") continue  // responses and junk get no reply
      if (item.method === "tools/call") {
        auditLog('MCP_PUBLIC_CALL', `${item.params?.name ?? '?'} by "${token.clientName}" (approved by ${token.approver ?? 'unknown'})`, 'AI')
      }
      const reply = await handleMcpRequest(item)
      if (reply && item.id !== undefined && item.id !== null) replies.push(reply)
    }
    if (replies.length === 0) return new Response(null, { status: 202, headers: MCP_PUBLIC_CORS })
    return mcpJson(batch ? replies : replies[0])
  }

  return new Response("Not found", { status: 404, headers: MCP_PUBLIC_CORS })
}

// Who is pressing Allow, according to Tailscale: "user@example.com on laptop"
const tailnetIdentity = async (ip: string): Promise<string> => {
  if (isLoopback(ip)) return "this machine"
  try {
    const out = await $`tailscale whois --json ${ip}`.quiet().nothrow().text()
    const who = JSON.parse(out) as { Node?: { ComputedName?: string; Name?: string }; UserProfile?: { LoginName?: string } }
    const user = who.UserProfile?.LoginName
    const node = who.Node?.ComputedName || who.Node?.Name?.split(".")[0]
    if (user || node) return [user, node && `on ${node}`].filter(Boolean).join(" ")
  } catch {}
  return ip
}

// Turn the public MCP endpoint on or off: DNS record, tunnel ingress, Caddy site.
// Turning it off also signs every client out.
const setPublicMcp = async (enabled: boolean, subdomain: string, actor: Actor): Promise<{ ok: true; fqdn: string | null } | { ok: false; error: string }> => {
  if (!domainConfig?.zone?.domain || !domainConfig?.tunnel?.id) {
    return { ok: false, error: "Set up a domain and tunnel first (candy domain config)." }
  }
  const zone = domainConfig.zone.domain
  if (enabled) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return { ok: false, error: "The subdomain can only use letters, numbers and dashes." }
    if (domainConfig.bindings?.[subdomain]) return { ok: false, error: `${subdomain}.${zone} is already bound to ${domainConfig.bindings[subdomain].serverName}. Pick another subdomain.` }
    const previous = publicMcpFqdn()
    const fqdn = `${subdomain}.${zone}`
    if (previous && previous !== fqdn) await deleteDnsRecords(previous)
    await $`cloudflared tunnel route dns ${domainConfig.tunnel.name} ${fqdn}`.quiet().nothrow()
    domainConfig.mcp = { enabled: true, subdomain }
    auditLog('MCP_PUBLIC_ON', fqdn, actor)
  } else {
    const fqdn = publicMcpFqdn()
    if (fqdn) await deleteDnsRecords(fqdn)
    ;(await getMcpOAuth())?.revokeAll()
    mcpOAuth = null
    mcpOAuthFor = null
    await unlink(MCP_OAUTH_FILE).catch(() => {})
    domainConfig.mcp = { enabled: false, subdomain: domainConfig.mcp?.subdomain || subdomain }
    auditLog('MCP_PUBLIC_OFF', fqdn ?? '', actor)
  }
  await saveDomainConfig()
  await syncCaddy()
  await syncCloudflaredIngress()
  await restartCloudflared()
  return { ok: true, fqdn: publicMcpFqdn() }
}

const deleteDnsRecords = async (fqdn: string) => {
  if (!domainConfig?.cfApiToken || !domainConfig.zone?.id) return
  try {
    const auth = { Authorization: `Bearer ${domainConfig.cfApiToken}` }
    const base = `https://api.cloudflare.com/client/v4/zones/${domainConfig.zone.id}/dns_records`
    const list = await fetch(`${base}?name=${fqdn}`, { headers: auth, signal: AbortSignal.timeout(10000) })
    if (!list.ok) return
    for (const record of ((await list.json()) as any).result || []) {
      await fetch(`${base}/${record.id}`, { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(10000) }).catch(() => {})
    }
  } catch (e) {
    auditLog('DOMAIN_DNS_DELETE_FAIL', `${fqdn}: ${e}`, 'System')
  }
}

const publicMcpStatus = async () => {
  const oauth = await getMcpOAuth()
  const zone = domainConfig?.zone?.domain ?? null
  const subdomain = domainConfig?.mcp?.subdomain || DEFAULT_MCP_SUBDOMAIN
  return {
    available: !!(zone && domainConfig?.tunnel?.id),
    enabled: !!oauth,
    url: oauth ? `https://${publicMcpFqdn()}/mcp` : null,
    wouldBe: zone ? `https://${subdomain}.${zone}/mcp` : null,
    consent: "https://portal.candy/oauth/consent",
    clients: oauth?.listClients() ?? [],
  }
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
  const mcpFqdn = publicMcpFqdn()
  if (mcpFqdn) ingressRules.push({ hostname: mcpFqdn, service: 'http://localhost:80' })

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
    await $`sudo mkdir -p ${dirname(CLOUDFLARED_SYSTEM_CONFIG)}`.quiet().nothrow()
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

// Where a bound public domain sends its traffic. A site candy starts itself goes to its
// running process (or to the daemon, which starts it). A plain route goes straight to
// its port or external URL.
const bindingUpstream = (serverName: string): string | null => {
  const managed = processes.get(serverName)
  if (managed?.status === 'running' && managed.port) return `localhost:${managed.port}`
  if (managed || serverConfigs.has(serverName)) return null
  const route = routes.get(serverName)
  if (!route) return null
  const target = String(route.target)
  return /^\d+$/.test(target) ? `localhost:${target}` : target
}

// Caddy needs the upstream's own Host header for an https URL target
const caddyUpstream = (upstream: string): string =>
  upstream.startsWith('https://')
    ? `reverse_proxy ${upstream} {
      header_up Host {upstream_hostport}
    }`
    : `reverse_proxy ${upstream}`
const portals = new Map<string, { proc: Subprocess | null, port: number, url?: string | null, pid?: number }>()
const processes = new Map<string, ManagedProcess>()
const serverConfigs = new Map<string, ServerConfig[]>()
const pidOwnedRoutes = new Map<string, PidOwnedRoute>()
const remoteRecords = new Map<string, RemoteRecord>()
// Historical mapping: tunnel domain -> server name (persists after portal close)
const tunnelHistory = new Map<string, string>()
let caddyProc: Subprocess | null = null

const makeConfigId = () => `cfg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
const makeLocalhostUrl = (name: string) => `https://${name}.localhost`
const getConfigsForName = (name: string): ServerConfig[] => serverConfigs.get(name) || []
const getConfigById = (name: string, configId?: string): ServerConfig | null => {
  const configs = getConfigsForName(name)
  if (configs.length === 0) return null
  if (!configId) return configs[0]
  return configs.find(c => c.id === configId) || null
}

const getAllLocalRouteNames = (): string[] =>
  [...new Set([
    ...routes.keys(),
    ...serverConfigs.keys(),
    ...processes.keys(),
  ])]

const getLocalCandyHostLabel = (): string | null => tailscaleSelf?.hostLabel || null

const resolveLocalCandyDomain = (host: string): string => {
  const cleanHost = host.replace(/:\d+$/, "").toLowerCase()
  const requested = cleanHost.replace(/\.(localhost|candy)$/, "")

  if (!cleanHost.endsWith(".candy")) return requested

  return resolveLocalCandyRouteName(requested, getAllLocalRouteNames(), getLocalCandyHostLabel())
}

const resolveLocalCandyActionDomain = (name: string, hostLabel?: string | null): string => {
  const requested = hostLabel ? `${name}.${hostLabel}` : name
  return resolveLocalCandyRouteName(requested, getAllLocalRouteNames(), getLocalCandyHostLabel())
}

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

// Auto-kill idle servers (1hr no activity, no portal). Activity is:
// - a finished request in Caddy's access log, for *.localhost, *.candy and bound domains
// - any open TCP connection to the server's port (SSE, WebSockets and other
//   long-lived streams never produce a log line while they stay open)
// - requests the daemon proxies itself
// A server that told candy it is idling (SDK setIdling) is kept past the timeout
// unless memory is tight (>= 80% used, or high PSI memory pressure).
const IDLE_TIMEOUT = IDLE_TIMEOUT_MS
const ACTIVITY_SAMPLE_INTERVAL = 60 * 1000
const IDLE_CHECK_INTERVAL = 5 * 60 * 1000
const accessLogTail = new AccessLogTail(CADDY_LOG)

const serverNameForHost = (host: string): string | null => {
  for (const name of localNameCandidates(host)) {
    if (processes.has(name)) return name
  }
  return resolveBindingFromHost(host.toLowerCase())?.serverName ?? null
}

const updateActivityFromCaddyLogs = async () => {
  try {
    const text = await accessLogTail.readNew()
    if (!text) return
    for (const [name, ts] of activityFromAccessLog(text, serverNameForHost)) {
      const proc = processes.get(name)
      if (proc && (proc.status === 'running' || proc.status === 'starting') && ts > proc.lastActivity) {
        proc.lastActivity = ts
      }
    }
  } catch {}
}

const serverPorts = (proc: ManagedProcess): number[] =>
  [...new Set([proc.port, ...proc.detectedPorts].filter((p): p is number => typeof p === 'number'))]

// An open connection is activity right now
const updateActivityFromConnections = async () => {
  const now = Date.now()
  for (const proc of processes.values()) {
    if (proc.status !== 'running') continue
    if (await countEstablished(serverPorts(proc)) > 0) proc.lastActivity = now
  }
}

const sampleActivity = async () => {
  await updateActivityFromCaddyLogs()
  await updateActivityFromConnections()
}

const killIdleServers = async () => {
  let memory: MemoryState | null = null
  for (const [name, proc] of processes) {
    if (proc.status !== 'running') continue
    const now = Date.now()
    if (now - proc.lastActivity <= IDLE_TIMEOUT) continue
    // Re-check connections right before deciding; this is the one that matters
    const openConnections = await countEstablished(serverPorts(proc))
    memory ??= await readMemoryState()
    const verdict = idleVerdict({
      now,
      lastActivity: proc.lastActivity,
      hasPortal: portals.has(name),
      openConnections,
      idling: proc.idling,
      memory,
    })
    if (!verdict.kill) {
      if (verdict.reason === 'connected') proc.lastActivity = now
      continue
    }
    console.log(`\x1b[33m[auto-kill] ${name} ${verdict.detail}\x1b[0m`)
    await stopProcess(name, 'System')
    auditLog('AUTO_KILL', `${name} (${verdict.detail})`, 'System')
  }
}

setInterval(() => { sampleActivity().catch(() => {}) }, ACTIVITY_SAMPLE_INTERVAL)
setInterval(async () => {
  await sampleActivity().catch(() => {})
  await killIdleServers().catch(e => console.error('[auto-kill]', e))
}, IDLE_CHECK_INTERVAL)

// Cron: once a minute, run every job whose schedule matches (local time).
// A run is the server's command plus the job's args, as the server's user, in
// its cwd. A job still running from last time is skipped, and runs past their
// timeout are stopped. Output goes to <logs>/cron/<name>.log.
const CRON_LOG_DIR = `${LOGS_DIR}/cron`
const cronRunning = new Map<string, number>()  // `${configId}:${job}` -> pid
let lastCronMinute = -1

const runCronJob = async (name: string, config: ServerConfig, job: CronJob) => {
  const key = `${config.id}:${job.name}`
  if (cronRunning.has(key)) {
    auditLog('CRON_SKIP', `${name}:${job.name} (previous run still going)`, 'System')
    return
  }
  const launch = await launchSpec(config, { job: job.name, args: job.args }, name)
  await mkdir(CRON_LOG_DIR, { recursive: true }).catch(() => {})
  const logFile = `${CRON_LOG_DIR}/${name.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_')}.log`
  const write = (text: string) => appendFile(logFile, text).catch(() => {})
  await write(`\n--- ${job.name} ${new Date().toISOString()} ---\n`)
  const proc = spawn({ cmd: launch.cmd, cwd: launch.cwd, env: launch.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  cronRunning.set(key, proc.pid)
  auditLog('CRON_RUN', `${name}:${job.name} ${JSON.stringify(job.args)} (pid ${proc.pid})`, 'System')
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) await write(stripAnsi(decoder.decode(chunk, { stream: true })))
  }
  const timeoutS = job.timeoutSec ?? DEFAULT_CRON_TIMEOUT_S
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ;(launch.unit ? stopUnit(launch.unit) : terminateProcessTree(proc.pid, 5000)).catch(() => {})
  }, timeoutS * 1000)
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]).catch(() => {})
  const code = await proc.exited
  clearTimeout(timer)
  cronRunning.delete(key)
  await write(`--- exit ${code}${timedOut ? ` (stopped after ${timeoutS}s)` : ''} ---\n`)
  auditLog('CRON_EXIT', `${name}:${job.name} code ${code}${timedOut ? ' (timeout)' : ''}`, 'System')
}

const cronTick = () => {
  const now = new Date()
  const minute = Math.floor(now.getTime() / 60000)
  if (minute === lastCronMinute) return
  lastCronMinute = minute
  for (const [name, configs] of serverConfigs) {
    for (const config of configs) {
      for (const job of config.cron ?? []) {
        let due = false
        try { due = cronMatches(parseCron(job.schedule), now) } catch {}
        if (due) runCronJob(name, config, job).catch(e => auditLog('CRON_FAIL', `${name}:${job.name} ${e?.message ?? e}`, 'System'))
      }
    }
  }
}

// Tick a couple of seconds into each minute
setTimeout(() => { cronTick(); setInterval(cronTick, 60 * 1000) }, 60 * 1000 - (Date.now() % 60000) + 2000)

// MCP Authentication - bootstrap secrets + session API keys
// Each user gets their own bootstrap secret; exchanging it via /mcp/auth gives
// an API key tied to that user. API keys are valid for the daemon's lifetime.
//
// Run as a normal user, the daemon has one identity (itself): the secret goes
// to ~/.config/candy/mcp-secret, plus /run/candy/secret for the `candy` group.
// Run as root (CANDY_OWNER=<user>), every member of the `candy` group gets
// /run/candy/users/<user>/secret readable only by them, and servers they
// register run as them. Nothing is ever started as root.
const RUNNING_AS_ROOT = process.getuid?.() === 0
// The systemd unit this daemon runs in (null when started by hand). Sandboxed
// servers are bound to it, so they stop when the daemon does.
const OWN_UNIT = (() => {
  try { return unitOfCgroup(readFileSync("/proc/self/cgroup", "utf8")) } catch { return null }
})()
// Servers are sandboxed when the daemon is root, under systemd, with systemd-run at hand
const SANDBOX_AVAILABLE = RUNNING_AS_ROOT && !!OWN_UNIT && !!Bun.which("systemd-run")
const OWNER = process.env.CANDY_OWNER || (RUNNING_AS_ROOT ? "" : userInfo().username)
if (RUNNING_AS_ROOT && !OWNER) {
  console.error("\x1b[31mRunning as root needs CANDY_OWNER=<user> (the user whose ~/.config/candy is used).\x1b[0m")
  process.exit(1)
}
const USER_SECRETS_DIR = `${dirname(SHARED_SECRET_FILE)}/users`
const secretUsers = new Map<string, string>()   // bootstrap secret -> user
const mcpApiKeys = new Map<string, string>()    // API key -> user
const TAILSCALE_STATUS_CACHE_MS = 15 * 1000
let tailscaleSelf: TailscaleNodeIdentity | null = null
let tailscaleStatusFetchedAt = 0
const tailscalePeersByIp = new Map<string, TailscaleNodeIdentity>()

interface UserAccount { name: string; uid: number; gid: number; home: string; shell: string }
const lookupUser = async (name: string): Promise<UserAccount | null> => {
  if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(name)) return null
  const res = await $`getent passwd ${name}`.quiet().nothrow()
  if (res.exitCode !== 0) return null
  const [user, , uid, gid, , home, shell] = res.stdout.toString().trim().split(":")
  return { name: user, uid: Number(uid), gid: Number(gid), home, shell: shell || "/bin/bash" }
}

const groupMembers = async (group: string): Promise<string[] | null> => {
  const res = await $`getent group ${group}`.quiet().nothrow()
  if (res.exitCode !== 0) return null
  const members = res.stdout.toString().trim().split(":")[3] || ""
  return members.split(",").map(m => m.trim()).filter(Boolean)
}

// Create the file with restrictive permissions before any secret is in it
const writeSecretFile = async (path: string, secret: string, mode: number, owner?: UserAccount | null, gid?: number) => {
  await unlink(path).catch(() => {})
  await writeFile(path, secret, { mode: 0o600 })
  if (owner || gid !== undefined) await chown(path, owner?.uid ?? process.getuid!(), gid ?? owner!.gid)
  await chmod(path, mode)
}

const newSecretFor = (user: string): string => {
  for (const [secret, u] of secretUsers) if (u === user) return secret
  const secret = crypto.randomUUID()
  secretUsers.set(secret, user)
  return secret
}

const forgetUser = (user: string) => {
  for (const [secret, u] of secretUsers) if (u === user) secretUsers.delete(secret)
  for (const [key, u] of mcpApiKeys) if (u === user) mcpApiKeys.delete(key)
}

// Root mode: one secret per member of the candy group (plus the owner).
// Re-run periodically so group changes apply without a restart.
const syncUserSecrets = async () => {
  const members = new Set(await groupMembers(SHARED_GROUP) ?? [])
  members.add(OWNER)
  await mkdir(USER_SECRETS_DIR, { recursive: true, mode: 0o755 })
  for (const name of members) {
    const account = await lookupUser(name)
    if (!account || account.uid === 0) continue
    const dir = `${USER_SECRETS_DIR}/${account.name}`
    const file = `${dir}/secret`
    const secret = newSecretFor(account.name)
    const current = await Bun.file(file).text().catch(() => "")
    if (current === secret) continue
    await mkdir(dir, { recursive: true })
    await chown(dir, account.uid, account.gid)
    await chmod(dir, 0o700)
    await writeSecretFile(file, secret, 0o600, account)
  }
  const users = new Set(secretUsers.values())
  for (const user of users) {
    if (members.has(user)) continue
    forgetUser(user)
    await $`rm -rf ${USER_SECRETS_DIR}/${user}`.quiet().nothrow()
    auditLog('AUTH', `Revoked access for ${user} (left the ${SHARED_GROUP} group)`, 'System')
  }
}

const initMcpAuth = async () => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  if (RUNNING_AS_ROOT) {
    const owner = await lookupUser(OWNER)
    if (!owner || owner.uid === 0) {
      console.error(`\x1b[31mCANDY_OWNER=${OWNER} is not a usable non-root account.\x1b[0m`)
      process.exit(1)
    }
    await writeSecretFile(MCP_SECRET_FILE, newSecretFor(OWNER), 0o600, owner)
    await unlink(SHARED_SECRET_FILE).catch(() => {})
    try {
      await syncUserSecrets()
    } catch (e) {
      console.error(`\x1b[33mCould not write per-user secrets under ${USER_SECRETS_DIR}: ${(e as Error).message}\x1b[0m`)
    }
    setInterval(() => syncUserSecrets().catch(() => {}), 60 * 1000)
    console.log(`\x1b[90mMCP auth initialized (multi-user, owner ${OWNER})\x1b[0m`)
    return
  }
  const secret = newSecretFor(OWNER)
  await writeSecretFile(MCP_SECRET_FILE, secret, 0o600)
  await publishSharedSecret(secret)
  console.log(`\x1b[90mMCP auth initialized\x1b[0m`)
}

// Single-user mode: if a `candy` group exists, also write the secret to
// /run/candy/secret readable by that group. Everyone acts as the daemon's user.
const publishSharedSecret = async (secret: string) => {
  const group = await $`getent group ${SHARED_GROUP}`.quiet().nothrow()
  if (group.exitCode !== 0) {
    await unlink(SHARED_SECRET_FILE).catch(() => {})
    return
  }
  const gid = Number(group.stdout.toString().split(":")[2])
  try {
    await mkdir(dirname(SHARED_SECRET_FILE), { recursive: true })
    await writeSecretFile(SHARED_SECRET_FILE, secret, 0o640, null, gid)
    console.log(`\x1b[90mShared secret at ${SHARED_SECRET_FILE} for group ${SHARED_GROUP}\x1b[0m`)
  } catch (e) {
    await unlink(SHARED_SECRET_FILE).catch(() => {})
    console.error(`\x1b[33mCould not share the secret with group ${SHARED_GROUP}: ${(e as Error).message}. Is ${process.env.USER} in that group, and does ${dirname(SHARED_SECRET_FILE)} exist?\x1b[0m`)
  }
}

const validateMcpApiKey = (apiKey: string): boolean => {
  return mcpApiKeys.has(apiKey)
}

const exchangeMcpSecret = (secret: string): { apiKey: string; user: string } | null => {
  const user = typeof secret === "string" ? secretUsers.get(secret) : undefined
  if (!user) return null
  const apiKey = `mcp_${crypto.randomUUID()}`
  mcpApiKeys.set(apiKey, user)
  return { apiKey, user }
}

// Who a request acts as. API keys carry their user; the web portal acts as the owner.
const requestUser = (req: Request): string => {
  const key = req.headers.get("X-Candy-API-Key")
  return (key && mcpApiKeys.get(key)) || OWNER
}

const configUser = (config: ServerConfig): string => config.user || OWNER

// Accounts a site may run as: the owner plus members of the candy group, never root
const runAsUsers = async (): Promise<UserAccount[]> => {
  if (!RUNNING_AS_ROOT) {
    const self = await lookupUser(OWNER)
    return self ? [self] : []
  }
  const names = [OWNER, ...(await groupMembers(SHARED_GROUP) ?? []).filter(n => n !== OWNER)]
  const accounts: UserAccount[] = []
  for (const name of names) {
    const account = await lookupUser(name)
    if (account && account.uid !== 0) accounts.push(account)
  }
  return accounts
}

// Changing or removing a config is limited to the user it runs as (the owner may remove any).
const mayChangeConfig = (requester: string, config: ServerConfig): boolean =>
  !RUNNING_AS_ROOT || requester === configUser(config) || requester === OWNER

const getTailscaleIpv4 = (ips: string[]): string | null =>
  ips.find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null

const parseTailscaleNode = (value: unknown): TailscaleNodeIdentity | null => {
  if (!value || typeof value !== "object") return null

  const node = value as {
    ID?: unknown
    HostName?: unknown
    DNSName?: unknown
    TailscaleIPs?: unknown
  }
  const ips = Array.isArray(node.TailscaleIPs)
    ? node.TailscaleIPs.filter((ip): ip is string => typeof ip === "string")
    : []
  const dnsName = normalizeTailscaleDnsName(typeof node.DNSName === "string" ? node.DNSName : null)
  const hostName = typeof node.HostName === "string" ? node.HostName : null

  return {
    id: typeof node.ID === "string" ? node.ID : null,
    hostName,
    dnsName,
    hostLabel: deriveTailscaleHostLabel({ hostName, dnsName }),
    ips,
  }
}

const refreshTailscaleStatus = async (force = false): Promise<void> => {
  if (!force && Date.now() - tailscaleStatusFetchedAt < TAILSCALE_STATUS_CACHE_MS) return

  try {
    const raw = await $`tailscale status --json`.text()
    const status = JSON.parse(raw) as { Self?: unknown; Peer?: Record<string, unknown> }

    tailscaleSelf = parseTailscaleNode(status.Self)
    tailscalePeersByIp.clear()

    for (const peer of Object.values(status.Peer || {})) {
      const parsed = parseTailscaleNode(peer)
      if (!parsed) continue
      for (const ip of parsed.ips) {
        tailscalePeersByIp.set(ip, parsed)
      }
    }

    tailscaleStatusFetchedAt = Date.now()
  } catch {
    if (force) {
      tailscaleSelf = null
      tailscalePeersByIp.clear()
      tailscaleStatusFetchedAt = Date.now()
    }
  }
}

const getLocalTailscaleIdentity = async (): Promise<TailscaleNodeIdentity | null> => {
  await refreshTailscaleStatus()
  return tailscaleSelf
}

const getTailscalePeerByIp = async (ip: string): Promise<TailscaleNodeIdentity | null> => {
  await refreshTailscaleStatus()
  return tailscalePeersByIp.get(ip) || null
}

// Discover Tailscale IPv4 address
const discoverTailscaleIp = async (): Promise<string | null> => {
  await refreshTailscaleStatus(true)

  const cachedIp = tailscaleSelf ? getTailscaleIpv4(tailscaleSelf.ips) : null
  if (cachedIp) return cachedIp

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

// ============================================================================
// LAN Publishing (opt-in per name)
// ============================================================================

// This machine's LAN IPv4: CANDY_LAN_IP if set, else the source address of the
// default route. Only RFC 1918 addresses count, so a Tailscale exit node or a
// public address never gets .candy sites bound to it.
const discoverLanIp = async (): Promise<string | null> => {
  const override = process.env.CANDY_LAN_IP?.trim()
  if (override) return override

  try {
    const out = await $`ip -4 route get 1.1.1.1`.quiet().text()
    const src = out.match(/\bsrc (\d+\.\d+\.\d+\.\d+)/)?.[1]
    if (src && isPrivateLanIp(src)) return src
  } catch {}

  try {
    const { networkInterfaces } = await import("node:os")
    for (const [iface, addrs] of Object.entries(networkInterfaces())) {
      if (iface.startsWith("tailscale") || iface.startsWith("docker") || iface.startsWith("br-")) continue
      for (const addr of addrs || []) {
        if (addr.family === "IPv4" && !addr.internal && isPrivateLanIp(addr.address)) return addr.address
      }
    }
  } catch {}

  return null
}

const loadLanPublished = async () => {
  try {
    const file = Bun.file(LAN_FILE)
    if (!await file.exists()) return
    const data = await file.json() as { published?: unknown, https?: unknown }
    lanPublished.clear()
    lanHttps.clear()
    lanDomainHttps.clear()
    if (Array.isArray(data.published)) {
      for (const name of data.published) {
        if (typeof name === "string" && name && !isReserved(name)) lanPublished.add(name.toLowerCase())
      }
    }
    if (data.https && typeof data.https === "object") {
      for (const [name, port] of Object.entries(data.https as Record<string, unknown>)) {
        const key = name.toLowerCase()
        if (!lanPublished.has(key)) continue
        if (port === "domain") lanDomainHttps.add(key)
        else if (isValidLanHttpsPort(port)) lanHttps.set(key, port)
      }
    }
  } catch {}
}

const saveLanPublished = async () => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  // name -> port (ts.net hostname) or "domain" (bound domain)
  const https = Object.fromEntries([
    ...lanHttps,
    ...[...lanDomainHttps].map(name => [name, "domain"] as [string, string]),
  ].sort(([a], [b]) => a.localeCompare(b)))
  await Bun.write(LAN_FILE, JSON.stringify({ published: [...lanPublished].sort(), https }, null, 2))
}

const isLanPublished = (name: string): boolean => lanPublished.has(name.toLowerCase())

// ---------------------------------------------------------------------------
// HTTPS on the LAN with a real certificate
//
// <name>.candy uses Caddy's internal CA, which LAN devices don't trust. A
// published name can also get a port on this machine's Tailscale hostname
// (https://<host>.<tailnet>.ts.net:<port>). Caddy gets a publicly trusted
// certificate for that name from tailscaled and serves it on the LAN IP only;
// candy-dns's LAN view answers the hostname with the LAN IP. The Tailscale IP
// is left alone: on the tailnet MagicDNS resolves the hostname to the
// Tailscale IP, where `tailscale serve` may own the same port (and that's the
// way to give tailnet devices the same URL).
// ---------------------------------------------------------------------------

const LAN_HTTPS_PORT_START = 8443
const LAN_HTTPS_PORT_SEARCH = 200
const LAN_HTTPS_RESERVED_PORTS = new Set([9999])

function isValidLanHttpsPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
}

// This machine's MagicDNS name (e.g. "homeserver.example.ts.net"), if known.
const getTailnetHostname = (): string | null => normalizeTailscaleDnsName(tailscaleSelf?.dnsName)

// The bound domain of a server, if it has one (the first, by name, when several)
const bindingForServer = (name: string): DomainBinding | null => {
  const key = name.toLowerCase()
  const found = Object.values(domainConfig?.bindings || {})
    .filter(b => b.serverName.toLowerCase() === key)
    .sort((a, b) => a.fqdn.localeCompare(b.fqdn))
  return found[0] ?? null
}

type LanHttpsMode = "domain" | "tailscale"

const lanHttpsMode = (name: string): LanHttpsMode | null => {
  const key = name.toLowerCase()
  return lanDomainHttps.has(key) ? "domain" : lanHttps.has(key) ? "tailscale" : null
}

// Bound-domain mode: the LAN gets https://<fqdn> on the LAN IP, with a Let's
// Encrypt certificate Caddy obtains over the tunnel (HTTP-01), and candy-dns's
// LAN view answers the fqdn with the LAN IP. Same URL at home and away.
const lanDomainHttpsBinding = (name: string): DomainBinding | null =>
  lanDomainHttps.has(name.toLowerCase()) ? bindingForServer(name) : null

const lanHttpsUrl = (name: string): string | null => {
  const key = name.toLowerCase()
  if (lanDomainHttps.has(key)) {
    const binding = bindingForServer(key)
    return binding ? `https://${binding.fqdn}` : null
  }
  const port = lanHttps.get(key)
  const host = getTailnetHostname()
  return port && host ? `https://${host}:${port}` : null
}

const canBindPort = (hostname: string, port: number): boolean => {
  try {
    const listener = Bun.listen({ hostname, port, socket: { data() {} } })
    listener.stop(true)
    return true
  } catch {
    return false
  }
}

// Why `port` can't be used for <name>'s HTTPS site, or null if it can.
const lanHttpsPortProblem = async (name: string, port: number): Promise<string | null> => {
  if (!isValidLanHttpsPort(port)) return "Port must be between 1024 and 65535."
  if (LAN_HTTPS_RESERVED_PORTS.has(port)) return `Port ${port} is reserved for the candy daemon.`
  for (const [other, otherPort] of lanHttps) {
    if (other !== name && otherPort === port) return `Port ${port} is already used by ${other}.`
  }
  if (lanHttps.get(name) === port) return null  // already ours, Caddy holds it
  if (lanIp && !canBindPort(lanIp, port)) return `Port ${port} is already in use on ${lanIp}.`
  return null
}

const pickLanHttpsPort = async (name: string): Promise<number | null> => {
  for (let port = LAN_HTTPS_PORT_START; port < LAN_HTTPS_PORT_START + LAN_HTTPS_PORT_SEARCH; port++) {
    if (!await lanHttpsPortProblem(name, port)) return port
  }
  return null
}

// Addresses a <name>.candy site block binds to. Unpublished names stay
// Tailscale-only; published names are also served on the LAN IP.
const candyBindAddrs = (name: string): string[] => {
  const addrs: string[] = []
  if (tailscaleIp) addrs.push(tailscaleIp)
  if (lanIp && lanIp !== tailscaleIp && isLanPublished(name)) addrs.push(lanIp)
  return addrs
}

const setLanPublished = async (name: string, publish: boolean, actor: Actor = 'Portal') => {
  const key = name.toLowerCase()
  if (publish === lanPublished.has(key)) return
  if (publish) lanPublished.add(key)
  else {
    lanPublished.delete(key)
    lanHttps.delete(key)
    lanDomainHttps.delete(key)
  }
  await saveLanPublished()
  auditLog(publish ? 'LAN_PUBLISH' : 'LAN_UNPUBLISH', `${key}.candy${publish && lanIp ? ` -> ${lanIp}` : ''}`, actor)
  await syncCaddy()
}

// Drop a name's exposure once the name is gone (no route, no server config),
// so a later, unrelated server that reuses the name does not start out
// exposed: the LAN opt-in, its Tailscale serve port and its entry port.
const forgetLanPublishedIfGone = async (name: string): Promise<boolean> => {
  const key = name.toLowerCase()
  if (routes.has(name) || serverConfigs.has(name)) return false
  let changed = false
  if (lanPublished.has(key)) {
    lanPublished.delete(key)
    lanHttps.delete(key)
    lanDomainHttps.delete(key)
    await saveLanPublished()
    auditLog('LAN_UNPUBLISH', `${key}.candy (name removed)`, 'System')
    changed = true
  }
  const served = tsServes.get(key)
  if (served) {
    tsServes.delete(key)
    await saveTsServes()
    // Only close the Tailscale port if it still points at this name's entry port
    const entry = entryPorts.get(key)
    const target = (await tsServeTargets()).get(served)
    if (entry && target === `http://127.0.0.1:${entry}`) {
      await $`tailscale serve --https=${served} off`.quiet().nothrow()
    }
    auditLog('TS_SERVE_OFF', `${key} :${served} (name removed)`, 'System')
    changed = true
  }
  if (entryPorts.delete(key)) {
    await saveEntryPorts()
    auditLog('ENTRY_PORT_OFF', `${key} (name removed)`, 'System')
    changed = true
  }
  return changed
}

const refreshLanIp = async () => {
  const next = await discoverLanIp()
  if (next === lanIp) return
  lanIp = next
  if (lanPublished.size > 0) await syncCaddy()
}

// Sync DNS config file for candy-dns daemon
const syncDnsConfig = async () => {
  if (!tailscaleIp) return
  const localIdentity = await getLocalTailscaleIdentity()
  const servers = [...routes.keys()]
  const snapshot = buildNetworkSnapshot({
    localNames: [...new Set([...routes.keys(), ...serverConfigs.keys()])],
    localIp: tailscaleIp,
    localIdentity: {
      hostName: localIdentity?.hostName || null,
      dnsName: localIdentity?.dnsName || null,
      hostLabel: localIdentity?.hostLabel || null,
    },
    remoteClaims: remoteRecords.values(),
    ttlMs: ADVERTISEMENT_TTL,
  })

  const records: Record<string, string> = { ...snapshot.dnsRecords }
  records["candy"] = tailscaleIp  // always

  // Names published to the LAN: candy-dns answers these with the LAN IP, but
  // only for queries in its LAN view.
  const lanRecords = buildLanRecords({ published: lanPublished, local: snapshot.local, lanIp })

  // Names outside .candy that the LAN view answers: this machine's ts.net
  // hostname, while any published name is served over HTTPS on it.
  const tailnetHost = normalizeTailscaleDnsName(localIdentity?.dnsName)
  const lanHostRecords: Record<string, string> = {}
  if (tailnetHost && lanIp && lanHttps.size > 0) lanHostRecords[tailnetHost] = lanIp
  // ...and the bound domain of every name served over HTTPS under it.
  if (lanIp) {
    for (const name of lanDomainHttps) {
      const binding = bindingForServer(name)
      if (binding) lanHostRecords[binding.fqdn.toLowerCase()] = lanIp
    }
  }

  // candy-dns passes other names in these zones to a public resolver, so the
  // front resolver can send the whole zone to the LAN listener once.
  const lanForwardZones = lanDomainZones()

  await Bun.write(DNS_CONFIG_FILE, JSON.stringify({
    tailscaleIp, tld: "candy", servers, records, lanIp, lanRecords, lanHostRecords, lanForwardZones
  }, null, 2))

  syncAdguard().catch(() => {})
}

// Zones that have a bound domain served on the LAN
const lanDomainZones = (): string[] => {
  const zone = domainConfig?.zone?.domain?.toLowerCase()
  if (!zone || !lanIp) return []
  return [...lanDomainHttps].some(name => bindingForServer(name)) ? [zone] : []
}

// ---------------------------------------------------------------------------
// AdGuard Home: keep the LAN client's upstreams pointing the right names at
// candy-dns's LAN listener (see adguard.ts). Optional; set up with
// `candy lan adguard setup`.
// ---------------------------------------------------------------------------

let adguardConfig: AdguardConfig | null = null
let adguardApplied: string | null = null  // last desired set that was applied
let adguardError: string | null = null

const loadAdguardConfig = async () => {
  try {
    const file = Bun.file(ADGUARD_FILE)
    if (!await file.exists()) return
    const data = await file.json() as Partial<AdguardConfig>
    if (data.url && data.username && data.password && data.client && data.dnsTarget) {
      adguardConfig = { ...data, managed: Array.isArray(data.managed) ? data.managed : [] } as AdguardConfig
    }
  } catch {}
}

const saveAdguardConfig = async () => {
  if (!adguardConfig) {
    await unlink(ADGUARD_FILE).catch(() => {})
    return
  }
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(ADGUARD_FILE, JSON.stringify(adguardConfig, null, 2))
  await chmod(ADGUARD_FILE, 0o600).catch(() => {})  // holds the AdGuard Home password
}

// Names LAN clients must resolve through candy-dns's LAN view, beyond .candy
const adguardDesiredRules = (cfg: AdguardConfig): string[] => {
  const rules: string[] = []
  const tailnetHost = getTailnetHostname()
  if (tailnetHost && lanIp && lanHttps.size > 0) rules.push(upstreamRule(tailnetHost, cfg.dnsTarget))
  for (const zone of lanDomainZones()) rules.push(upstreamRule(zone, cfg.dnsTarget))
  return rules
}

const syncAdguard = async (force = false): Promise<void> => {
  const cfg = adguardConfig
  if (!cfg) return
  const desired = adguardDesiredRules(cfg)
  const key = JSON.stringify(desired)
  if (!force && key === adguardApplied) return
  try {
    const result = await applyAdguardUpstreams(cfg, desired)
    adguardApplied = key
    adguardError = null
    if (result.changed || JSON.stringify(result.managed) !== JSON.stringify(cfg.managed)) {
      cfg.managed = result.managed
      await saveAdguardConfig()
    }
    if (result.changed) auditLog('ADGUARD_SYNC', `${cfg.client}: ${desired.join(' ') || 'no extra names'}`, 'System')
  } catch (e) {
    adguardError = String((e as Error)?.message ?? e)
    auditLog('ADGUARD_FAIL', adguardError, 'System')
    if (force) throw e
  }
}

const adguardStatus = () => adguardConfig ? {
  configured: true,
  url: adguardConfig.url,
  username: adguardConfig.username,
  client: adguardConfig.client,
  dnsTarget: adguardConfig.dnsTarget,
  rules: adguardDesiredRules(adguardConfig),
  managed: adguardConfig.managed,
  error: adguardError,
} : { configured: false }

// Advertisement persistence
const loadAdvertisements = async () => {
  try {
    const file = Bun.file(ADVERTISEMENTS_FILE)
    if (!await file.exists()) return
    const data = await file.json() as Record<string, Partial<RemoteRecord>>
    const now = Date.now()
    for (const [key, record] of Object.entries(data)) {
      const name = typeof record.name === "string" ? record.name : key.split("@")[0] || key
      const ownerKey = record.ownerId || record.hostLabel || record.ip
      if (!name || !record.ip || !ownerKey) continue

      const normalizedRecord: RemoteRecord = {
        name,
        ip: record.ip,
        advertisedAt: typeof record.advertisedAt === "number" ? record.advertisedAt : 0,
        claimedAt: typeof record.claimedAt === "number"
          ? record.claimedAt
          : (typeof record.advertisedAt === "number" ? record.advertisedAt : now),
        ownerId: typeof record.ownerId === "string" ? record.ownerId : null,
        hostName: typeof record.hostName === "string" ? record.hostName : null,
        dnsName: normalizeTailscaleDnsName(typeof record.dnsName === "string" ? record.dnsName : null),
        hostLabel: typeof record.hostLabel === "string" ? record.hostLabel : null,
      }

      if (now - normalizedRecord.advertisedAt < ADVERTISEMENT_TTL) {
        remoteRecords.set(makeRemoteClaimKey(name, ownerKey), normalizedRecord)
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
  // Retry Tailscale discovery if it wasn't available at startup
  if (!tailscaleIp) {
    tailscaleIp = await discoverTailscaleIp()
    if (tailscaleIp) {
      console.log(`\x1b[33mTailscale:\x1b[0m   ${tailscaleIp} (*.candy domains now active)`)
      await syncCaddy()
    } else {
      return
    }
  }
  try {
    const dns = await import("node:dns")
    const addrs = await dns.promises.resolve4("candy.candy")
    if (!addrs.length) return
    const hubIp = addrs[0]
    // If candy.candy resolves to us, we ARE the hub - skip
    if (hubIp === tailscaleIp) return

    const myRoutes = [...new Set([...routes.keys(), ...serverConfigs.keys()])]
    if (myRoutes.length === 0) return
    const identity = await getLocalTailscaleIdentity()

    const resp = await fetch(`http://${hubIp}:9999/candy/advertise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routes: myRoutes,
        identity: identity ? {
          id: identity.id,
          hostName: identity.hostName,
          dnsName: identity.dnsName,
          hostLabel: identity.hostLabel,
        } : undefined,
      }),
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
  try {
    await Bun.write(AUDIT_LOG, "")
  } catch (e: any) {
    if (e?.code === "EACCES") {
      console.error(`\x1b[31m${LOGS_DIR} is not writable by ${process.env.USER ?? "this user"}.\x1b[0m`)
      console.error(`It was probably created by another user (e.g. candy-dns running as root).`)
      console.error(`Run candy-dns as the same user as the daemon, then: sudo rm -rf ${LOGS_DIR}`)
    }
    throw e
  }
}

// Actor types for audit logging
type Actor = 'AI' | 'Page' | 'Portal' | 'System' | 'Network' | 'SDK'

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
  const logFile = getLogFile(name)
  try {
    const file = Bun.file(logFile)
    const existing = await file.exists() ? await file.text() : ""
    await Bun.write(logFile, existing + stripAnsi(data))
  } catch {}
}

// Get log file path for a process
const getLogFile = (name: string) => `${LOGS_DIR}/${name.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_')}.log`

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
          const user = typeof (item as any).user === "string" && (item as any).user ? (item as any).user : undefined
          const cfg: ServerConfig = { id, cwd, cmd }
          if (user) cfg.user = user
          if ((item as any).api === true) cfg.api = true
          if ((item as any).sandbox === false) cfg.sandbox = false
          if (Array.isArray((item as any).rw)) {
            const rw = (item as any).rw.map(validateRwPath).filter((v: string | null): v is string => !!v).slice(0, MAX_RW_PATHS)
            if (rw.length > 0) cfg.rw = rw
          }
          const envFile = validateEnvFilePath((item as any).envFile)
          if (envFile) cfg.envFile = envFile
          if (Array.isArray((item as any).cron)) {
            const jobs = (item as any).cron.map(validateCronJob).filter((v: any) => v.ok).map((v: any) => v.job as CronJob)
            if (jobs.length > 0) cfg.cron = jobs.slice(0, MAX_CRON_JOBS)
          }
          normalized.push(cfg)
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

const setApiFlag = (config: ServerConfig, api: boolean) => {
  if (api) config.api = true
  else delete config.api
}

// Add a server config
const addServerConfig = async (name: string, cwd: string, cmd: string, actor: Actor = 'Portal', user: string = OWNER, api?: boolean) => {
  // Expand tilde in cwd against the home of the user it will run as
  const home = RUNNING_AS_ROOT ? (await lookupUser(user))?.home : process.env.HOME
  const expandedCwd = cwd.replace(/^~/, home || '')
  const configs = getConfigsForName(name)
  const dupe = configs.find(cfg => cfg.cwd === expandedCwd && cfg.cmd === cmd && configUser(cfg) === user)
  if (dupe) {
    if (api !== undefined) setApiFlag(dupe, api)
  } else {
    const cfg: ServerConfig = { id: makeConfigId(), cwd: expandedCwd, cmd }
    if (user !== OWNER) cfg.user = user
    if (api) cfg.api = true
    configs.push(cfg)
    serverConfigs.set(name, configs)
  }
  await saveServerConfigs()
  auditLog('CONFIG_ADD', `${name}: ${cmd} in ${expandedCwd}${RUNNING_AS_ROOT ? ` as ${user}` : ''}`, actor)
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
  if (await forgetLanPublishedIfGone(name)) await syncCaddy()
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

// ============================================================================
// API mode
// ============================================================================
// For servers that are called by programs, not browsers: a request to a
// stopped server is held (no loading page) while it starts, then forwarded
// unchanged. Later requests go straight through Caddy once the route exists.

// The config whose API mode applies to a name: the running one, else the first configured.
const apiModeConfig = (name: string): ServerConfig | null => {
  const managed = processes.get(name)
  if (managed && (managed.status === 'running' || managed.status === 'starting')) {
    return managed.config.api ? managed.config : null
  }
  const configs = getConfigsForName(name)
  return configs.find(c => c.api) ?? null
}

// The daemon's own proxies wait up to 30s for an upstream's response headers.
// After that the body streams for as long as it lasts (SSE, long polls), and
// the client connection's idle timeout is lifted so quiet streams aren't cut.
const PROXY_HEADER_TIMEOUT = 30 * 1000

const fetchWithHeaderTimeout = async (target: string, init: RequestInit, req: Request): Promise<Response> => {
  const headerTimeout = new AbortController()
  const timer = setTimeout(
    () => headerTimeout.abort(new DOMException(`No response headers within ${PROXY_HEADER_TIMEOUT / 1000}s`, 'TimeoutError')),
    PROXY_HEADER_TIMEOUT,
  )
  try {
    const res = await fetch(target, { ...init, signal: AbortSignal.any([req.signal, headerTimeout.signal]) })
    try { controlServer.timeout(req, 0) } catch {}
    return res
  } finally {
    clearTimeout(timer)
  }
}

const apiModeStarts = new Map<string, Promise<ManagedProcess>>()
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']

const apiModeError = (status: number, error: string, details: Record<string, unknown> = {}) =>
  Response.json({ error, ...details }, { status, headers: { 'X-Candy': 'api-mode' } })

const forwardApiModeRequest = async (req: Request, url: URL, name: string, config: ServerConfig, protectedDomain = false): Promise<Response> => {
  let managed = processes.get(name)
  if (!managed || (managed.status !== 'running' && managed.status !== 'starting')) {
    // One start per name, however many requests arrive together
    let starting = apiModeStarts.get(name)
    if (!starting) {
      starting = spawnProcess(name, 'Network', config.id).finally(() => apiModeStarts.delete(name))
      apiModeStarts.set(name, starting)
    }
    try {
      managed = await starting
    } catch (e) {
      return apiModeError(502, `Could not start ${name}`, { reason: String((e as Error)?.message ?? e) })
    }
  }
  managed.lastActivity = Date.now()

  // Port detection gives up after PORT_DETECTION_TIMEOUT; wait for it or for the process to exit
  const deadline = managed.startedAt.getTime() + PORT_DETECTION_TIMEOUT + 500
  if (managed.status === 'starting') { try { controlServer.timeout(req, 30) } catch {} }  // the default 10s idle limit is shorter than a start
  while (managed.status === 'starting' && Date.now() < deadline && !req.signal.aborted) {
    await Bun.sleep(50)
  }
  if (managed.status === 'errored' || managed.status === 'dead') {
    return apiModeError(502, `${name} exited before it was ready`, { exitCode: managed.exitCode })
  }
  if (managed.status !== 'running' || !managed.port) {
    const ports = managed.detectedPorts
    return ports.length > 1
      ? apiModeError(502, `${name} listens on several ports. Pick one in the portal (Set port…)`, { ports })
      : apiModeError(504, `${name} started but no port was detected`)
  }

  const headers = new Headers(req.headers)
  for (const h of HOP_BY_HOP) headers.delete(h)
  headers.delete('x-candy-verified')
  if (protectedDomain) stripCandyCredentials(headers)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  try {
    const upstream = await fetchWithHeaderTimeout(`http://localhost:${managed.port}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: 'manual',
      decompress: false,
      // @ts-ignore Bun/undici option for streaming request bodies
      duplex: 'half',
    } as RequestInit, req)
    const out = new Headers(upstream.headers)
    for (const h of HOP_BY_HOP) out.delete(h)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
  } catch (e) {
    return apiModeError(502, `${name} did not answer`, { reason: String((e as Error)?.message ?? e) })
  }
}

// How to run a config. As root, drop to the config's user with setpriv and
// cd as that user (so a cwd they couldn't reach on their own fails).
// A cron run passes `cron`: its args reach the command as "$@" (positional
// parameters), never as shell text, so they can't add commands.
const launchSpec = async (config: ServerConfig, cron?: { job: string; args: string[] }, name = ''): Promise<{ cmd: string[]; cwd: string; env: Record<string, string | undefined>; unit: string | null }> => {
  const extra: Record<string, string> = cron
    ? { TERM: 'dumb', [CRON_JOB_ENV]: cron.job }
    : { FORCE_COLOR: '1', TERM: 'xterm-256color', [CANDY_RUNTIME_MAGIC_ENV]: config.id }
  const script = cron ? cronScript(config.cmd) : config.cmd
  const args = cron ? ['candy', ...cron.args] : []
  let fileEnv: Record<string, string> = {}
  if (config.envFile) {
    const problem = await envFileProblem(configUser(config), config.envFile)
    if (problem) throw new Error(`Refusing to start: ${problem}`)
    // Sandboxed launches let systemd read the file; the others get it merged here
    if (!(SANDBOX_AVAILABLE && config.sandbox !== false && name)) {
      fileEnv = parseEnvFile(await Bun.file(config.envFile).text())
    }
  }
  if (!RUNNING_AS_ROOT) {
    return { cmd: ['bash', '-ic', script, ...args], cwd: config.cwd, env: { ...process.env, ...fileEnv, ...extra }, unit: null }
  }
  const account = await lookupUser(configUser(config))
  if (!account || account.uid === 0) {
    throw new Error(`Refusing to start: '${configUser(config)}' is not a usable non-root account`)
  }
  const env = {
    HOME: account.home,
    USER: account.name,
    LOGNAME: account.name,
    SHELL: account.shell,
    PATH: `${account.home}/.bun/bin:${account.home}/.local/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
    LANG: process.env.LANG,
    ...extra,
  }

  // Sandboxed: its own systemd unit, as the config's user. Read-only
  // everywhere except the code folder, the state folder and a private /tmp.
  if (SANDBOX_AVAILABLE && config.sandbox !== false && name) {
    const unit = unitName(name, cron ? 'cron' : 'srv')
    return {
      cmd: systemdRunCommand({
        name,
        unit,
        uid: account.uid,
        gid: account.gid,
        cwd: config.cwd,
        codeDir: findCodeDir(config.cwd, account.home, dir => existsSync(`${dir}/.git`)),
        extraRw: config.rw,
        envFile: config.envFile,
        env,
        script,
        args: cron?.args,
        mode: cron ? 'pipe' : 'pty',
        bindsTo: OWN_UNIT,
      }),
      cwd: '/',
      env: process.env,
      unit,
    }
  }

  return {
    cmd: [
      'setpriv', `--reuid=${account.uid}`, `--regid=${account.gid}`, '--init-groups', '--',
      'bash', '-c', LAUNCH_WRAPPER, 'candy', config.cwd, script, ...args,
    ],
    cwd: '/',
    env: { ...env, ...fileEnv, ...extra },
    unit: null,
  }
}

// Why <path> can't be <user>'s env file, or null if it can. Checked when it is
// set and again at every launch. Two ways in:
// - the user can read the file themselves, or
// - root placed it under /etc/candy/env/<user>/ (root-owned, not writable by
//   anyone else). Sandboxed, systemd reads it, so the user never can.
// Anything else would let a user read root's files through candy.
const envFileProblem = async (user: string, path: string): Promise<string | null> => {
  if (!validateEnvFilePath(path)) return "The env file must be an absolute path."
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return `${path} is not a file.`
  if (info.size > 256 * 1024) return "The env file is larger than 256 KB."
  if (!RUNNING_AS_ROOT) return null  // read as ourselves; no more rights than the user has
  const dir = userEnvDir(user)
  if (path.startsWith(dir + "/") && !path.slice(dir.length + 1).includes("/")) {
    const dirInfo = await stat(dir).catch(() => null)
    const rootOnly = (s: typeof info | null) => !!s && s.uid === 0 && (s.mode & 0o022) === 0
    return rootOnly(info) && rootOnly(dirInfo) ? null : `${dir} and the file must be owned by root and not writable by others.`
  }
  const account = await lookupUser(user)
  if (!account || account.uid === 0) return `'${user}' is not a usable account.`
  const readable = await $`setpriv --reuid=${account.uid} --regid=${account.gid} --init-groups -- test -r ${path}`.quiet().nothrow()
  return readable.exitCode === 0 ? null : `${user} can't read ${path}. Make it readable to them, or have root put it in ${dir}/.`
}

// Port detection fallback for servers that don't print their port
const SOCKET_SCAN_AFTER = 1500
const SOCKET_SCAN_EVERY = 500
const SOCKET_SCAN_GIVE_UP = 60 * 1000

const serverPids = async (managed: ManagedProcess): Promise<number[]> => {
  if (managed.unit) {
    const procs = await Bun.file(`/sys/fs/cgroup/${SANDBOX_SLICE}/${managed.unit}/cgroup.procs`).text().catch(() => "")
    return parsePidList(procs)
  }
  const root = managed.pid ?? managed.proc?.pid ?? null
  return root ? await getProcessTreePids(root) : []
}

const listeningPortsOfServer = async (managed: ManagedProcess): Promise<number[]> => {
  const pids = await serverPids(managed)
  if (pids.length === 0) return []
  const ss = await $`ss -Htlnp`.quiet().nothrow().text()
  return listeningPortsOf(ss, pids)
}

// Stop a sandboxed launch: systemd ends every process in the unit (TERM, then
// KILL after TimeoutStopSec), which also ends the systemd-run client we hold.
const stopUnit = async (unit: string) => {
  await $`systemctl stop ${unit}`.quiet().nothrow()
}

// Spawn a dev server process using Bun.Terminal for proper PTY support
const spawnProcess = async (name: string, actor: Actor = 'System', configId?: string): Promise<ManagedProcess> => {
  const config = getConfigById(name, configId)
  if (!config) {
    throw new Error(`No config found for server: ${name}`)
  }
  const launch = await launchSpec(config, undefined, name)

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
    idling: false,
    unit: launch.unit,
  }

  processes.set(name, managed)
  auditLog('PROCESS_START', `${name}:${config.id} ${config.cmd}${launch.unit ? ` [${launch.unit}]` : ''}`, actor)

  // Collected output for port detection
  let collectedOutput = ''
  let lastLoggedLine = ''

  const startPortDetection = () => {
    const startTime = Date.now()
    let lastSocketScan = 0
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
        pidOwnedRoutes.delete(name)
        await syncCaddy()
        auditLog('ROUTE_AUTO', `${name}.localhost -> :${managed.port}`)
        return
      }

      // Printed nothing we recognise: look at what it actually listens on.
      // Only once a socket is open, so a request is never forwarded too early.
      if (managed.detectedPorts.length === 0 && elapsed >= SOCKET_SCAN_AFTER && Date.now() - lastSocketScan >= SOCKET_SCAN_EVERY) {
        lastSocketScan = Date.now()
        const found = await listeningPortsOfServer(managed)
        if (found.length > 0 && managed.status === 'starting' && managed.detectedPorts.length === 0) {
          managed.detectedPorts.push(...found)
          auditLog('PORT_FROM_SOCKET', `${name}: listening on ${found.join(', ')}`, 'System')
        }
        return
      }

      // Timeout: keep starting state (user can manually select a port if multiple detected).
      // A silent server gets longer, since only its socket can tell us the port.
      if (elapsed >= (managed.detectedPorts.length === 0 ? SOCKET_SCAN_GIVE_UP : PORT_DETECTION_TIMEOUT)) {
        clearInterval(checkInterval)
      }
    }, 100)
  }

  // Spawn bash with PTY using Bun.Terminal API (v1.3.5+)
  // Use `-i -c <cmd>` so:
  // - .bashrc loads (interactive)
  // - the bash process exits when the command exits (so we can mark status dead/errored)
  const proc = spawn({
    cmd: launch.cmd,
    cwd: launch.cwd,
    env: launch.env,
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
    resetJtiBloom(name)
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

    // API mode: point Caddy back at the daemon, so the next request starts the
    // server again and is held and forwarded (lazy respawn). Without this Caddy
    // keeps proxying to the dead port and callers get 502s. Other servers keep
    // their route, and the crash page, as before.
    if (managed.config.api && processes.get(name) === managed) {
      if (!routes.get(name)?.persistent) routes.delete(name)
      syncCaddy().catch(() => {})
      auditLog('API_RESPAWN_ARMED', `${name}: next request restarts it`, 'System')
    }

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
      if (managed.unit) await stopUnit(managed.unit)
      await terminateProcessTree(pid, managed.unit ? 2000 : 5000)
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
  pidOwnedRoutes.delete(name)

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
  pidOwnedRoutes.delete(name)
  await syncCaddy()
  auditLog('STATE', `${name}: ${prevStatus} -> running (port ${port}, manual)`, actor)

  return true
}

type OpenPortalResult =
  | { ok: true; body: { name: string; url: string; port: number; message: string } }
  | { ok: false; status: number; body: { error: string; details?: string } }

const openPortalForName = async ({ name, port, openBrowser }: { name?: string; port: number; openBrowser?: boolean }): Promise<OpenPortalResult> => {
  if (!port) {
    return { ok: false, status: 400, body: { error: "Port is required" } }
  }

  const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
  if (existingPortal) {
    const m = msg.portalCollision
    return { ok: false, status: 409, body: { error: m, details: `${existingPortal[0]} has :${port}` } }
  }

  let portalName = name
  if (!portalName) {
    let anonCounter = 1
    while (portals.has(`anon-${anonCounter}`)) anonCounter++
    portalName = `anon-${anonCounter}`
  }

  if (isReserved(portalName)) {
    return { ok: false, status: 403, body: { error: "That name is reserved.", details: portalName } }
  }

  if (portals.has(portalName)) {
    const m = msg.portalCollision
    return { ok: false, status: 409, body: { error: m, details: `${portalName} already open` } }
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

  if (!tunnelUrl) {
    portals.delete(portalName)
    return { ok: false, status: 500, body: { error: "Tunnel collapsed. Even our connections have limits." } }
  }

  const portal = portals.get(portalName)
  if (portal) {
    portal.url = tunnelUrl
    portal.pid = cfProc.pid
    tunnelHistory.set(tunnelUrl.replace('https://', ''), portalName)
    await syncCaddy()
  }

  if (openBrowser) {
    setTimeout(() => {
      spawn({ cmd: ["xdg-open", tunnelUrl], stdout: "ignore", stderr: "ignore" })
    }, 30000)
  }

  const m = msg.portalSuccess
  log("PORTAL", `${portalName} -> ${tunnelUrl}`)
  return { ok: true, body: { name: portalName, url: tunnelUrl, port, message: m } }
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

const findManagedProcessByConfigId = (configId: string): ManagedProcess | null => {
  for (const managed of processes.values()) {
    if (managed.config.id === configId) {
      return managed
    }
  }
  return null
}

const isPidInProcessTree = async (rootPid: number, candidatePid: number): Promise<boolean> => {
  if (!Number.isFinite(rootPid) || rootPid <= 0 || !Number.isFinite(candidatePid) || candidatePid <= 0) {
    return false
  }
  if (rootPid === candidatePid) return true
  const tree = await getProcessTreePids(rootPid)
  return tree.includes(candidatePid)
}

const resolveManagedRuntime = async (configId: string, pid?: number): Promise<ManagedProcess | null> => {
  const managed = findManagedProcessByConfigId(configId)
  if (!managed) return null

  if (!pid) return managed

  const rootPid = managed.pid ?? managed.proc?.pid ?? null
  if (!rootPid) return null
  if (!await isPidRunning(pid)) return null

  if (await isPidInProcessTree(rootPid, pid)) return managed
  // Sandboxed servers run in their own unit, not under our process tree
  if (managed.unit) {
    const cgroup = await Bun.file(`/proc/${pid}/cgroup`).text().catch(() => "")
    if (unitOfCgroup(cgroup) === managed.unit) return managed
  }
  return null
}

const claimPidOwnedRoute = (name: string, pid: number) => {
  pidOwnedRoutes.set(name, { pid, registeredAt: Date.now() })
}

const releasePidOwnedRoute = (name: string) => {
  pidOwnedRoutes.delete(name)
}

const getPidOwnedRoutePort = async (name: string, pid: number): Promise<number | null> => {
  const owner = pidOwnedRoutes.get(name)
  if (!owner || owner.pid !== pid) return null
  if (!await isPidRunning(pid)) {
    pidOwnedRoutes.delete(name)
    return null
  }
  const route = routes.get(name)
  if (!route || typeof route.target === "string") return null
  return route.target
}

// Start Caddy in background
const startCaddy = async () => {
  await $`mkdir -p ${CADDY_CONFIG_DIR}`.quiet().nothrow()

  if (await isCaddyRunning()) {
    console.log("\x1b[33mCaddy already running\x1b[0m (relinked)")
    return
  }

  // Caddy < 2.7 can't share the HTTP/3 UDP :443 listener between the wildcard
  // *.localhost blocks and the Tailscale-bound *.candy blocks ("listen udp :443:
  // address already in use"). Distro packages (e.g. Ubuntu's 2.6.2) hit this.
  try {
    const ver = (await $`${CADDY} version`.quiet().text()).trim()
    const m = ver.match(/v?(\d+)\.(\d+)/)
    if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 7))) {
      console.log(`\x1b[33mWarning:\x1b[0m Caddy ${ver.split(" ")[0]} is too old; candy needs Caddy >= 2.7 (install from caddyserver.com, not the distro package)`)
    }
  } catch {}

  try {
    caddyProc = spawn({
      cmd: [CADDY, "run", "--config", CADDYFILE],
      stdout: Bun.file(CADDY_PROC_LOG),
      stderr: Bun.file(CADDY_PROC_LOG),
      detached: true,
    })
    caddyProc.unref()

    await new Promise(r => setTimeout(r, 1500))
    if (caddyProc.exitCode !== null) {
      const out = await Bun.file(CADDY_PROC_LOG).text().catch(() => "")
      const errLine = out.split("\n").reverse().find(l => /^Error|"level":"error"/.test(l)) ?? ""
      console.log(`\x1b[31mCaddy exited immediately\x1b[0m (code ${caddyProc.exitCode}). See ${CADDY_PROC_LOG}`)
      if (errLine) console.log(`  ${errLine.slice(0, 300)}`)
      caddyProc = null
      return
    }
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
        if (managed.unit) await stopUnit(managed.unit)
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

// Entry ports: a plain-HTTP port on loopback that always reaches <name>
// through candy, whatever Host the caller sends. For local front ends that
// can't set the Host (tailscale serve, another proxy): pointing them at the
// server's own port would bypass candy, so a stopped server would never start.
const entryPorts = new Map<string, number>()

const loadEntryPorts = async () => {
  try {
    const file = Bun.file(ENTRIES_FILE)
    if (!await file.exists()) return
    for (const [name, port] of Object.entries(await file.json() as Record<string, unknown>)) {
      if (isSafeName(name) && isValidLanHttpsPort(port)) entryPorts.set(name.toLowerCase(), port)
    }
  } catch {}
}

const saveEntryPorts = async () => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(ENTRIES_FILE, JSON.stringify(Object.fromEntries([...entryPorts].sort(([a], [b]) => a.localeCompare(b))), null, 2))
}

const entryPortProblem = (name: string, port: number): string | null => {
  if (!isValidLanHttpsPort(port)) return "Port must be between 1024 and 65535."
  if (LAN_HTTPS_RESERVED_PORTS.has(port)) return `Port ${port} is reserved for the candy daemon.`
  for (const [other, otherPort] of entryPorts) {
    if (other !== name && otherPort === port) return `Port ${port} is already the entry port of ${other}.`
  }
  if (entryPorts.get(name) === port) return null  // already ours, Caddy holds it
  if (!canBindPort("127.0.0.1", port)) return `Port ${port} is already in use on this machine.`
  return null
}

// tailscale serve, run by candy: https://<host>.ts.net:<port> on the tailnet,
// forwarded to the name's entry port so the request goes through candy (and
// can start a stopped server). The Tailscale IP's ports belong to tailscaled,
// so this is how a name gets a trusted-certificate URL on the tailnet.
const tsServes = new Map<string, number>()   // name -> HTTPS port on the ts.net hostname
const ENTRY_PORT_START = 18200

const loadTsServes = async () => {
  try {
    const file = Bun.file(SERVES_FILE)
    if (!await file.exists()) return
    for (const [name, port] of Object.entries(await file.json() as Record<string, unknown>)) {
      if (isSafeName(name) && isValidLanHttpsPort(port)) tsServes.set(name.toLowerCase(), port)
    }
  } catch {}
}

const saveTsServes = async () => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(SERVES_FILE, JSON.stringify(Object.fromEntries([...tsServes].sort(([a], [b]) => a.localeCompare(b))), null, 2))
}

// The name's entry port, giving it one if it has none
const ensureEntryPort = async (name: string): Promise<number | null> => {
  const existing = entryPorts.get(name)
  if (existing) return existing
  for (let port = ENTRY_PORT_START; port < ENTRY_PORT_START + 200; port++) {
    if (!entryPortProblem(name, port)) {
      entryPorts.set(name, port)
      await saveEntryPorts()
      return port
    }
  }
  return null
}

const tsServeUrl = (name: string): string | null => {
  const port = tsServes.get(name.toLowerCase())
  const host = getTailnetHostname()
  return port && host ? `https://${host}:${port}` : null
}

const tsServeTargets = async (): Promise<Map<number, string>> =>
  tailscaleServeTargets(await $`tailscale serve status --json`.quiet().nothrow().text())

// Why tailscale's HTTPS <port> can't be given to <name>, or null if it can
const tsServeProblem = async (name: string, port: number): Promise<string | null> => {
  if (!isValidLanHttpsPort(port)) return "Port must be between 1024 and 65535."
  if (!getTailnetHostname()) return "Tailscale isn't reporting this machine's hostname."
  for (const [other, otherPort] of tsServes) {
    if (other !== name && otherPort === port) return `Port ${port} is already served for ${other}.`
  }
  const current = (await tsServeTargets()).get(port)
  const entry = entryPorts.get(name)
  const ownPort = processes.get(name)?.port ?? (typeof routes.get(name)?.target === "number" ? routes.get(name)!.target : null)
  const ours = current === undefined
    || (entry && current === `http://127.0.0.1:${entry}`)
    || (ownPort && (current === `http://127.0.0.1:${ownPort}` || current === `http://localhost:${ownPort}`))
  return ours ? null : `Tailscale already serves port ${port} for something else (${current}). Turn that off first: tailscale serve --https=${port} off`
}

// Make tailscaled match: every served name forwards to its entry port
const syncTsServe = async () => {
  if (tsServes.size === 0) return
  const targets = await tsServeTargets()
  for (const [name, port] of tsServes) {
    if (!routes.has(name) && !serverConfigs.has(name)) continue
    const entry = await ensureEntryPort(name)
    if (!entry) continue
    const want = `http://127.0.0.1:${entry}`
    if (targets.get(port) === want) continue
    const result = await $`tailscale serve --bg --https=${port} ${want}`.quiet().nothrow()
    if (result.exitCode !== 0) auditLog('TS_SERVE_FAIL', `${name} :${port}: ${result.stderr.toString().trim().slice(0, 200)}`, 'System')
  }
}

const setTsServe = async (name: string, port: number | null, actor: Actor): Promise<{ ok: true; url: string | null } | { ok: false; error: string }> => {
  const key = name.toLowerCase()
  const previous = tsServes.get(key)
  if (port === null) {
    if (previous) {
      tsServes.delete(key)
      await saveTsServes()
      await $`tailscale serve --https=${previous} off`.quiet().nothrow()
      auditLog('TS_SERVE_OFF', `${key} :${previous}`, actor)
    }
    return { ok: true, url: null }
  }
  const problem = await tsServeProblem(key, port)
  if (problem) return { ok: false, error: problem }
  if (!await ensureEntryPort(key)) return { ok: false, error: "No free entry port found." }
  if (previous && previous !== port) await $`tailscale serve --https=${previous} off`.quiet().nothrow()
  tsServes.set(key, port)
  await saveTsServes()
  await syncCaddy()      // the entry port's site
  await syncTsServe()
  auditLog('TS_SERVE', `${key} -> ${tsServeUrl(key)}`, actor)
  return { ok: true, url: tsServeUrl(key) }
}

// Where a route's site block proxies to. An API-mode server that isn't running
// goes to the daemon instead of its (dead) port, so a request can start it;
// this matters for persistent routes, which outlive the process.
const routeProxyTarget = (name: string, route: { target: number | string }): string => {
  const status = processes.get(name)?.status
  if (apiModeConfig(name) && status !== 'running') return 'localhost:9999'
  return typeof route.target === "number" ? `localhost:${route.target}` : route.target
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
  # Tunnel traffic arrives from cloudflared on loopback; take the visitor's IP
  # from Cloudflare's header (used by allowlists via client_ip)
  servers {
    trusted_proxies static 127.0.0.1/8 ::1
    client_ip_headers Cf-Connecting-Ip
  }
}

`
  const localExactNames = new Set([...routes.keys(), ...serverConfigs.keys()])
  const localHostLabel = getLocalCandyHostLabel()
  const candyAliasHosts: string[] = []
  const candyKillAliasHosts: string[] = []
  const candyPortalAliasHosts: string[] = []

  for (const [name, route] of routes) {
    const proxyTarget = routeProxyTarget(name, route)
    content += `${name}.localhost {
  tls internal
  reverse_proxy ${proxyTarget}
  log
}

`
  }

  // .candy route blocks. Bound to the Tailscale IP; names published to the LAN
  // are bound to the LAN IP as well. Kill/portal subdomains and the catch-all
  // stay Tailscale-only, so publishing a name exposes that one site and nothing else.
  for (const [name, route] of routes) {
    const bindAddrs = candyBindAddrs(name)
    if (bindAddrs.length === 0) continue
    const proxyTarget = routeProxyTarget(name, route)
    const candyHosts = [`${name}.candy`]
    const alias = buildHostAlias(name, localHostLabel)
    if (alias && !localExactNames.has(alias)) {
      candyHosts.push(`${alias}.candy`)
      candyKillAliasHosts.push(
        `${buildActionSubdomain(name, "kill", localHostLabel)}.candy`,
        `${buildActionSubdomain(name, "k", localHostLabel)}.candy`,
      )
      candyPortalAliasHosts.push(
        `${buildActionSubdomain(name, "portal", localHostLabel)}.candy`,
        `${buildActionSubdomain(name, "p", localHostLabel)}.candy`,
      )
    }
    content += `${candyHosts.join(", ")} {
  bind ${bindAddrs.join(" ")}
  tls internal
  reverse_proxy ${proxyTarget}
  log
}

`
  }

  for (const name of serverConfigs.keys()) {
    if (routes.has(name)) continue
    const bindAddrs = candyBindAddrs(name)
    if (bindAddrs.length === 0) continue
    const alias = buildHostAlias(name, localHostLabel)
    const hasAlias = !!alias && !localExactNames.has(alias)
    if (hasAlias) {
      candyKillAliasHosts.push(
        `${buildActionSubdomain(name, "kill", localHostLabel)}.candy`,
        `${buildActionSubdomain(name, "k", localHostLabel)}.candy`,
      )
      candyPortalAliasHosts.push(
        `${buildActionSubdomain(name, "portal", localHostLabel)}.candy`,
        `${buildActionSubdomain(name, "p", localHostLabel)}.candy`,
      )
    }

    if (isLanPublished(name) && lanIp) {
      // Not running yet: the Tailscale catch-all can't serve the LAN, so give a
      // published name its own block that reaches the daemon's lazy-start page.
      const candyHosts = [`${name}.candy`]
      if (hasAlias) candyHosts.push(`${alias}.candy`)
      content += `${candyHosts.join(", ")} {
  bind ${bindAddrs.join(" ")}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    } else if (hasAlias) {
      candyAliasHosts.push(`${alias}.candy`)
    }
  }

  // HTTPS on the tailnet hostname: https://<host>.ts.net:<port> per name, with
  // a certificate from tailscaled. LAN IP only; the Tailscale IP's ports belong
  // to `tailscale serve`.
  const tailnetHost = getTailnetHostname()
  if (tailnetHost && lanIp && lanIp !== tailscaleIp) {
    for (const [name, port] of [...lanHttps].sort(([a], [b]) => a.localeCompare(b))) {
      const route = routes.get(name)
      if (!route && !serverConfigs.has(name)) continue
      // Not running yet: the daemon's lazy-start page picks the server by Host.
      const proxy = route
        ? `reverse_proxy ${typeof route.target === "number" ? `localhost:${route.target}` : route.target}`
        : `reverse_proxy localhost:9999 {
    header_up Host ${name}.candy
  }`
      content += `${tailnetHost}:${port} {
  bind ${lanIp}
  tls {
    get_certificate tailscale
  }
  ${proxy}
  log
}

`
    }
  }

  // Entry ports (loopback only). A running server is proxied directly; anything
  // else goes to the daemon under the name's own host, so it can start it.
  for (const [name, port] of [...entryPorts].sort(([a], [b]) => a.localeCompare(b))) {
    const route = routes.get(name)
    if (!route && !serverConfigs.has(name)) continue
    const target = route ? routeProxyTarget(name, route) : 'localhost:9999'
    const proxy = target === 'localhost:9999'
      ? `reverse_proxy localhost:9999 {
    header_up Host ${name}.localhost
  }`
      : `reverse_proxy ${target}`
    content += `http://:${port} {
  bind 127.0.0.1
  ${proxy}
  log
}

`
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
      const upstream = bindingUpstream(binding.serverName)
      let body: string

      if (hasBindingAuth(binding)) {
        const proxyTarget = upstream ?? "localhost:9999"

        // Protected domains must authenticate before either proxying to a running
        // app or touching the daemon's lazy-start/log UI for a stopped app.
        // API-mode sites: the check hands back a nonce so the daemon trusts it,
        // and candy's own credentials are removed before the app sees the request
        const apiSite = isApiSite(binding)
        const stripLines = (apiSite ? `
    request_header -X-Candy-Auth
    request_header -X-Auth-Token
    @candy_basic header Authorization "Basic *"
    request_header @candy_basic -Authorization` : '') + (proxyTarget === "localhost:9999" ? '' : `
    request_header -X-Candy-Verified`)
        body = `  handle /candy-auth/* {
    reverse_proxy localhost:9999 {
      header_up X-Forwarded-Host {host}
    }
  }
  handle {
    forward_auth localhost:9999 {
      uri /candy-auth/check
      header_up X-Forwarded-Host {host}
      copy_headers X-Candy-Verified
    }${stripLines}
    ${caddyUpstream(proxyTarget)}
  }`
      } else if (upstream) {
        // Unprotected + reachable: caddy proxies directly to the server, no daemon in the middle
        body = `  ${caddyUpstream(upstream)}`
      } else {
        // Server not running: proxy to candy daemon for starting page
        body = `  reverse_proxy localhost:9999`
      }

      // LAN HTTPS under the bound domain: the same site (and the same auth) on
      // the LAN IP, port 443, with a Let's Encrypt certificate. The HTTP-01
      // challenge arrives through the tunnel on port 80. Only private and
      // Tailscale addresses are served; anyone else is dropped.
      if (lanIp && lanIp !== tailscaleIp && lanDomainHttpsBinding(binding.serverName)?.fqdn === binding.fqdn) {
        content += `https://${binding.fqdn} {
  bind ${lanIp}
  tls {
    issuer acme {
      disable_tlsalpn_challenge
    }
  }
  @candy_outside not client_ip private_ranges ${TAILSCALE_RANGES.join(" ")}
  route {
    abort @candy_outside
${body.split("\n").map(line => line ? `  ${line}` : line).join("\n")}
  }
  log
}

`
      }

      if (hasAllowlist(binding)) {
        // Allowlist mode: Caddy closes the connection without a reply for anyone
        // else, before any auth check or upstream connection. The client IP comes
        // from Cf-Connecting-Ip when cloudflared (loopback) forwards the request.
        const allowed = [...binding.allowlist!.ips, ...TAILSCALE_RANGES, "127.0.0.1/8", "::1"].join(" ")
        body = `  @candy_blocked not client_ip ${allowed}
  route {
    abort @candy_blocked
${body.split("\n").map(line => line ? `  ${line}` : line).join("\n")}
  }`
      }

      content += `http://${binding.fqdn} {
${body}
  log
}

`
    }
  }

  // Public MCP endpoint: the daemon answers it directly (OAuth + MCP over HTTP)
  const mcpPublicFqdn = publicMcpFqdn()
  if (mcpPublicFqdn) {
    content += `http://${mcpPublicFqdn} {
  reverse_proxy localhost:9999
  log
}

`
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
    if (candyKillAliasHosts.length > 0) {
      content += `${[...new Set(candyKillAliasHosts)].join(", ")} {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    }
    if (candyPortalAliasHosts.length > 0) {
      content += `${[...new Set(candyPortalAliasHosts)].join(", ")} {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    }
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
    if (candyAliasHosts.length > 0) {
      content += `${[...new Set(candyAliasHosts)].join(", ")} {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    }
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
    const res = await fetch("http://localhost:2019/load", {
      method: "POST",
      headers: { "Content-Type": "text/caddyfile" },
      body: content,
    })
    // Caddy keeps running the previous config when a load is rejected.
    if (!res.ok) console.log(`\x1b[31mCaddy rejected the new config:\x1b[0m ${(await res.text()).trim()}`)
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
    (tailscaleIp && origin.match(/^https?:\/\/[a-z0-9.-]+\.candy$/))
  )
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Candy-Token, X-Candy-API-Key",
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

    // The control port listens on every interface (tailnet peers post their
    // registry here), but everything else arrives through Caddy on loopback.
    // Refuse direct connections from anywhere else, so a LAN device can't
    // open the portal or the consent page by talking to :9999 itself.
    const peerIp = normalizeIp(controlServer.requestIP(req)?.address || "")
    if (!isLoopback(peerIp) && !(url.pathname.startsWith("/candy/") && ipAllowed(peerIp, []))) {
      return new Response("Forbidden", { status: 403 })
    }

    // Public MCP host: its own small surface (OAuth + /mcp), nothing else
    const requestHostname = (req.headers.get("host") || "").replace(/:\d+$/, "").toLowerCase()
    if (requestHostname && requestHostname === publicMcpFqdn()) {
      return await handlePublicMcp(req, url, controlServer)
    }

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    // Consent for a public MCP client. Only on the portal's own host, which is
    // served on the tailnet (portal.candy) and this machine (portal.localhost).
    if (url.pathname.startsWith("/oauth/")) {
      const onPortal = resolveLocalCandyDomain(req.headers.get("host") || "") === "portal" && !resolveBindingFromHost(req.headers.get("host") || "")
      const oauth = onPortal ? await getMcpOAuth() : null
      if (!oauth) return new Response("Not found", { status: 404 })

      if (req.method === "GET" && url.pathname === "/oauth/consent") {
        const rawHtml = await Bun.file(import.meta.dir + "/public/authorize.html").text()
        // A portal session token, so only this page load can answer
        const html = rawHtml.replace('<script>', `<script>window.CANDY_TOKEN="${createSession()}";</script><script>`)
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
      }
      if (req.method === "GET" && url.pathname === "/oauth/request") {
        const pending = oauth.getRequest(url.searchParams.get("request") || "")
        if (!pending || pending.decided) return Response.json({ error: "This request has expired or was already answered." }, { status: 404 })
        const { ip } = getFingerprint(req, controlServer)
        let redirectHost = pending.redirectUri
        try { redirectHost = new URL(pending.redirectUri).host || pending.redirectUri } catch {}
        return Response.json({
          clientName: pending.clientName,
          redirectHost,
          expiresAt: pending.expiresAt,
          endpoint: `https://${publicMcpFqdn()}/mcp`,
          you: await tailnetIdentity(ip),
        }, { headers: { "Cache-Control": "no-store" } })
      }
      if (req.method === "POST" && url.pathname === "/oauth/decision") {
        const token = req.headers.get("X-Candy-Token")
        if (!token || !consumeToken(token)) return unauthorizedResponse(corsHeaders)
        const body = await req.json().catch(() => ({})) as { request?: string; allow?: boolean }
        const { ip } = getFingerprint(req, controlServer)
        const approver = await tailnetIdentity(ip)
        const pending = oauth.getRequest(body.request || "")
        const result = oauth.decide(body.request || "", body.allow === true, approver)
        if (!result.ok) return Response.json({ error: result.error_description }, { status: result.status })
        auditLog(body.allow === true ? 'MCP_PUBLIC_ALLOW' : 'MCP_PUBLIC_DENY', `"${pending?.clientName ?? '?'}" by ${approver}`, 'Portal')
        const back = new URL(`https://${publicMcpFqdn()}/authorize/complete`)
        back.searchParams.set("request", body.request || "")
        back.searchParams.set("grant", result.grant)
        return Response.json({ redirect: back.toString() })
      }
      return new Response("Not found", { status: 404 })
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
      const { ip, userAgent } = getFingerprint(req, controlServer)

      // No auth configured = unprotected, pass straight through (no rate limits, no auth)
      // Nag banner shows on portal page instead to guilt the owner
      const verified = { 'X-Candy-Verified': CADDY_VERIFIED_NONCE }
      const outside = checkAllowlist(req, controlServer, binding)
      if (outside) return outside

      if (!hasBindingAuth(binding)) {
        return new Response('OK', { status: 200, headers: verified })
      }

      // API-mode sites: credentials on every request, never a login page
      if (isApiSite(binding)) {
        const denied = await checkServerAuth(req, controlServer, binding)
        if (denied) return denied
        return new Response('OK', { status: 200, headers: verified })
      }

      // Auth is enabled - check cookie
      const token = getAuthCookie(req, binding.subdomain)
      if (token) {
        const session = validateAuthSession(token, ip, userAgent, binding.subdomain)
        if (session) {
          // Valid session - update last seen
          session.lastSeen = Date.now()
          return new Response('OK', { status: 200, headers: verified })
        }
      }

      // No valid session - return login page as 401
      return renderBoundDomainLogin(binding, ip, userAgent)
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
      const outsideLogin = checkAllowlist(req, controlServer, binding)
      if (outsideLogin) return outsideLogin
      const auth = binding.auth
      if (!auth?.enabled || !auth?.password) {
        return Response.json({ error: 'No password configured' }, { status: 400 })
      }

      const { ip, userAgent } = getFingerprint(req, controlServer)
      const failureKey = webFailureKey(binding, ip, userAgent)

      // Check fibonacci backoff block
      const { blocked, retryAfter } = await checkAuthBlocked(failureKey)
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
        const failure = await recordAuthFailure(failureKey)
        auditLog('AUTH_FAIL', `${binding.fqdn} from ${ip}`, 'System')
        return Response.json({
          error: 'Wrong password',
          retryAfter: failure.retryAfter
        }, { status: 401 })
      }

      // Correct password - issue session
      await clearAuthFailures(failureKey)
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

      const { subdomain, domain, password, jwtSecret: rawJwtSecret } = await req.json() as { subdomain?: string; domain?: string; password?: string; jwtSecret?: string }
      if ((!subdomain && !domain) || (!password && !rawJwtSecret)) {
        return Response.json({ error: "domain (or subdomain) and a password or jwtSecret are required" }, { status: 400, headers: corsHeaders })
      }
      // "generate" asks the daemon for a random secret, returned once in the response
      const generated = rawJwtSecret === "generate"
      const jwtSecret = generated ? generateJwtSecret() : rawJwtSecret
      if (jwtSecret !== undefined && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
        return Response.json({ error: `The JWT secret must be at least ${MIN_JWT_SECRET_LENGTH} characters. Use "generate" for a random one.` }, { status: 400, headers: corsHeaders })
      }

      const bindingKey = resolveBindingKey(subdomain, domain)
      if (!bindingKey) {
        const target = domain || subdomain || '(unknown)'
        return Response.json({ error: `No binding found for '${target}'` }, { status: 404, headers: corsHeaders })
      }

      const ok = await setBindingAuth(bindingKey, { password: password || undefined, jwtSecret })
      if (!ok) {
        return Response.json({ error: `No binding found for '${bindingKey}'` }, { status: 404, headers: corsHeaders })
      }
      // Resync caddy to add forward_auth
      await syncCaddy()
      const label = domainConfig?.bindings?.[bindingKey]?.fqdn || bindingKey
      const actor: Actor = isMcpRequest ? 'AI' : 'Portal'
      const what = [password ? 'Password' : '', jwtSecret ? 'JWT secret' : ''].filter(Boolean).join(' and ')
      auditLog('AUTH_SET', `${what} set for ${label}`, actor)
      const binding = domainConfig!.bindings[bindingKey]
      const note = jwtSecret && !isApiSite(binding)
        ? ` ${binding.serverName} isn't in API mode, so browsers still get the login page and JWTs aren't checked until it is.`
        : ''
      return Response.json({
        success: true,
        message: `${what} set for ${label}.${note}`,
        ...(generated ? { jwtSecret } : {}),
      }, { headers: corsHeaders })
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

      const { subdomain, domain, which } = await req.json() as { subdomain?: string; domain?: string; which?: 'password' | 'jwt' | 'all' }
      if (!subdomain && !domain) {
        return Response.json({ error: "domain (or subdomain) required" }, { status: 400, headers: corsHeaders })
      }

      const bindingKey = resolveBindingKey(subdomain, domain)
      if (!bindingKey) {
        const target = domain || subdomain || '(unknown)'
        return Response.json({ error: `No binding found for '${target}'` }, { status: 404, headers: corsHeaders })
      }

      const ok = await clearBindingAuth(bindingKey, which === 'password' || which === 'jwt' ? which : 'all')
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

    // Allowlist mode for a bound domain: only listed IPs/CIDRs, Tailscale and this machine
    if (req.method === "POST" && url.pathname === "/domains/allowlist") {
      const mcpApiKey = req.headers.get("X-Candy-API-Key")
      const isMcpRequest = !!(mcpApiKey && validateMcpApiKey(mcpApiKey))
      if (!isMcpRequest) {
        const token = req.headers.get("X-Candy-Token")
        if (!token || !consumeToken(token)) return unauthorizedResponse(corsHeaders)
      }
      const body = await req.json().catch(() => ({})) as { subdomain?: string; domain?: string; enabled?: boolean; ips?: string[]; add?: string[]; remove?: string[] }
      const bindingKey = resolveBindingKey(body.subdomain, body.domain)
      const binding = bindingKey ? domainConfig?.bindings?.[bindingKey] : undefined
      if (!binding) {
        return Response.json({ error: `No binding found for '${body.domain || body.subdomain || '(unknown)'}'` }, { status: 404, headers: corsHeaders })
      }
      const entries = [...(body.ips ?? []), ...(body.add ?? [])].map(e => String(e).trim().replace(/^\[|\](?=\/|$)/g, '')).filter(Boolean)
      const bad = entries.filter(e => !parseCidr(e))
      if (bad.length) {
        return Response.json({ error: `Not an IP or CIDR: ${bad.join(', ')}` }, { status: 400, headers: corsHeaders })
      }
      const current = binding.allowlist ?? { enabled: false, ips: [] }
      let ips = body.ips ? [] : [...current.ips]
      for (const e of entries) if (!ips.includes(e)) ips.push(e)
      const removing = new Set((body.remove ?? []).map(e => String(e).trim()))
      ips = ips.filter(e => !removing.has(e))
      // Adding entries turns it on unless told otherwise
      const enabled = typeof body.enabled === "boolean" ? body.enabled : (entries.length > 0 || current.enabled)
      binding.allowlist = { enabled, ips }
      await saveDomainConfig()
      await syncCaddy()
      const actor: Actor = isMcpRequest ? 'AI' : 'Portal'
      const summary = enabled ? `on (${ips.length ? ips.join(', ') : 'no extra IPs'} + Tailscale)` : 'off'
      auditLog('ALLOWLIST', `${binding.fqdn}: ${summary}`, actor)
      return Response.json({
        success: true,
        allowlist: binding.allowlist,
        message: enabled
          ? `${binding.fqdn} now only accepts ${ips.length ? `${ips.length} allowlisted address${ips.length === 1 ? '' : 'es'}, ` : ''}Tailscale and this machine`
          : `${binding.fqdn} accepts any address again`,
      }, { headers: corsHeaders })
    }

    // Mint a server-auth JWT for an API-mode domain (for scripts and testing)
    if (req.method === "POST" && url.pathname === "/auth/token") {
      const mcpApiKey = req.headers.get("X-Candy-API-Key")
      const isMcpRequest = !!(mcpApiKey && validateMcpApiKey(mcpApiKey))
      if (!isMcpRequest) {
        const token = req.headers.get("X-Candy-Token")
        if (!token || !consumeToken(token)) return unauthorizedResponse(corsHeaders)
      }
      const { subdomain, domain, ttl, jti } = await req.json().catch(() => ({})) as { subdomain?: string; domain?: string; ttl?: number; jti?: boolean | string }
      const bindingKey = resolveBindingKey(subdomain, domain)
      const binding = bindingKey ? domainConfig?.bindings?.[bindingKey] : undefined
      if (!binding) {
        return Response.json({ error: `No binding found for '${domain || subdomain || '(unknown)'}'` }, { status: 404, headers: corsHeaders })
      }
      if (!binding.auth?.jwtSecret) {
        return Response.json({ error: `${binding.fqdn} has no JWT secret. Set one first.` }, { status: 400, headers: corsHeaders })
      }
      // Only the owner or the user the site runs as may mint tokens for it
      const requester = requestUser(req)
      const siteUsers = getConfigsForName(binding.serverName).map(configUser)
      if (RUNNING_AS_ROOT && requester !== OWNER && !siteUsers.includes(requester)) {
        return Response.json({ error: `Only ${OWNER} or the site's own user can mint tokens for it.` }, { status: 403, headers: corsHeaders })
      }
      const lifetime = Math.min(Math.max(Math.floor(Number(ttl) || 600), 1), MAX_TOKEN_LIFETIME_S)
      const now = Math.floor(Date.now() / 1000)
      const claims: Record<string, unknown> = { aud: JWT_AUDIENCE, sub: `${binding.serverName}.candy`, iat: now, nbf: now, exp: now + lifetime }
      if (jti) claims.jti = typeof jti === "string" ? jti : crypto.randomUUID()
      auditLog('AUTH_TOKEN', `Token minted for ${binding.fqdn} (${lifetime}s${claims.jti ? ', single use' : ''})`, isMcpRequest ? 'AI' : 'Portal')
      return Response.json({ token: signJwt(claims, binding.auth.jwtSecret), claims }, { headers: corsHeaders })
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
            hasJwtSecret: !!binding.auth?.jwtSecret,
            apiMode: isApiSite(binding),
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
      const body = await req.json().catch(() => ({})) as { secret?: string }
      const auth = exchangeMcpSecret(body.secret ?? "")
      if (!auth) {
        return Response.json({ error: "Invalid secret" }, { status: 401, headers: corsHeaders })
      }
      auditLog('MCP_AUTH', `Client authenticated as ${auth.user}`, 'AI')
      return Response.json({ apiKey: auth.apiKey, user: auth.user }, { headers: corsHeaders })
    }

    // === Web UI Routes (no token required, token is SSR'd) ===
    // Also allow SSE streams and portal status polling without token (read-only)
    // Allow all GET requests from *.localhost domains (not direct API calls)
    const hostHeader = req.headers.get("host") || ""
    const isCandyDomain = hostHeader.endsWith(".candy")
    const boundDomainMatch = resolveBindingFromHost(hostHeader)
    const isBoundDomain = !!boundDomainMatch
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

    if (isBoundDomain && boundDomainMatch && !url.pathname.startsWith("/candy-auth/")) {
      const authResponse = await requireBoundDomainAuth(req, controlServer, boundDomainMatch.binding)
      if (authResponse) return authResponse
    }

    // === API mode: any method, held until the server is up, then forwarded as-is ===
    if (isLocalhostDomain && !url.pathname.startsWith("/candy-auth/")) {
      const apiName = boundDomainMatch ? boundDomainMatch.serverName : resolveLocalCandyDomain(hostHeader)
      const apiConfig = apiName && apiName !== "portal" ? apiModeConfig(apiName) : null
      if (apiConfig) {
        const protectedDomain = !!boundDomainMatch && hasBindingAuth(boundDomainMatch.binding)
        return await forwardApiModeRequest(req, url, apiName, apiConfig, protectedDomain)
      }
    }

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
        const {
          routes: advertisedRoutes,
          identity: advertisedIdentity,
        } = await req.json() as {
          routes: string[]
          identity?: Partial<TailscaleNodeIdentity>
        }
        const accepted: string[] = []
        const rejected: { name: string; reason: string }[] = []
        const aliases: Record<string, string> = {}
        const peerIdentity = await getTailscalePeerByIp(callerIp)
        const callerIdentity: TailscaleNodeIdentity = {
          id: peerIdentity?.id || (typeof advertisedIdentity?.id === "string" ? advertisedIdentity.id : null),
          hostName: peerIdentity?.hostName || (typeof advertisedIdentity?.hostName === "string" ? advertisedIdentity.hostName : null),
          dnsName: peerIdentity?.dnsName || normalizeTailscaleDnsName(typeof advertisedIdentity?.dnsName === "string" ? advertisedIdentity.dnsName : null),
          hostLabel: peerIdentity?.hostLabel
            || (typeof advertisedIdentity?.hostLabel === "string" ? advertisedIdentity.hostLabel.trim().toLowerCase() : null)
            || deriveTailscaleHostLabel({
              hostName: typeof advertisedIdentity?.hostName === "string" ? advertisedIdentity.hostName : null,
              dnsName: typeof advertisedIdentity?.dnsName === "string" ? advertisedIdentity.dnsName : null,
            }),
          ips: peerIdentity?.ips || [callerIp],
        }
        const ownerKey = callerIdentity.id || callerIdentity.hostLabel || callerIp

        for (const name of advertisedRoutes) {
          if (isReserved(name)) {
            rejected.push({ name, reason: "reserved" }); continue
          }
          const claimKey = makeRemoteClaimKey(name, ownerKey)
          const existing = remoteRecords.get(claimKey)
          const claimedAt = existing?.claimedAt || Date.now()
          const alias = buildHostAlias(name, callerIdentity.hostLabel)

          remoteRecords.set(claimKey, {
            name,
            ip: callerIp,
            advertisedAt: Date.now(),
            claimedAt,
            ownerId: callerIdentity.id,
            hostName: callerIdentity.hostName,
            dnsName: callerIdentity.dnsName,
            hostLabel: callerIdentity.hostLabel,
          })
          accepted.push(name)
          if (alias) aliases[name] = `${alias}.candy`
        }

        if (accepted.length > 0) {
          await saveAdvertisements()
          await syncDnsConfig()
          const ownerLabel = callerIdentity.hostLabel || callerIdentity.hostName || callerIp
          auditLog('ADS_ACCEPTED', `${ownerLabel} (${callerIp}): ${accepted.join(", ")}`, 'Network')
        }

        return Response.json({ accepted, rejected, aliases }, { headers: corsHeaders })
      }

      // GET /candy/registry - view all known records
      if (req.method === "GET" && url.pathname === "/candy/registry") {
        const localIdentity = await getLocalTailscaleIdentity()
        const snapshot = buildNetworkSnapshot({
          localNames: [...new Set([...routes.keys(), ...serverConfigs.keys()])],
          localIp: tailscaleIp || "unknown",
          localIdentity: {
            hostName: localIdentity?.hostName || null,
            dnsName: localIdentity?.dnsName || null,
            hostLabel: localIdentity?.hostLabel || null,
          },
          remoteClaims: remoteRecords.values(),
          ttlMs: ADVERTISEMENT_TTL,
        })
        return Response.json({
          local: snapshot.local,
          remote: snapshot.remote,
        }, { headers: corsHeaders })
      }
    }

    // === API Routes require token validation ===
    // MCP/CLI uses X-Candy-API-Key header (obtained via /mcp/auth with secret)
    const mcpApiKey = req.headers.get("X-Candy-API-Key")
    const isMCP = mcpApiKey && validateMcpApiKey(mcpApiKey)
    if (!isWebRoute && !isMCP && !isBoundDomain && !isCandyApi) {
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
        const hasAuth = hasBindingAuth(binding)
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
              const proxyRes = await fetchWithHeaderTimeout(`http://localhost:${managed.port}${url.pathname}${url.search}`, {
                method: req.method,
                headers: proxyHeaders,
                body: req.body,
              }, req)
              return new Response(proxyRes.body, { status: proxyRes.status, headers: proxyRes.headers })
            } catch (e) {
              return new Response(`Proxy error: ${e}`, { status: 502 })
            }
          }
        }
      }
    }

    // === SDK API ===
    // Always needs an API key: requests on a bound domain's host skip the
    // token check above, and must not reach these from the internet.
    if (url.pathname.startsWith("/sdk/") && !isMCP) {
      return unauthorizedResponse(corsHeaders)
    }

    if (req.method === "POST" && url.pathname === "/sdk/runtime") {
      const { configId, pid } = await req.json() as { configId?: string; pid?: number }
      if (!configId) {
        return Response.json({ error: "configId is required" }, { status: 400, headers: corsHeaders })
      }

      const managed = await resolveManagedRuntime(configId, pid)
      if (!managed) {
        return Response.json({ error: "No running candy runtime found for that configId." }, { status: 404, headers: corsHeaders })
      }

      return Response.json({
        success: true,
        runtime: {
          name: managed.name,
          url: makeLocalhostUrl(managed.name),
          port: managed.port,
          status: managed.status,
          configId: managed.config.id,
          cwd: managed.config.cwd,
          cmd: managed.config.cmd,
        }
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/sdk/register-port") {
      const body = await req.json() as { name?: string; port?: number; persistent?: boolean; pid?: number }
      const { name, port, persistent, pid } = body

      if (!name || !port || !pid) {
        return Response.json({ error: "name, port, and pid are required" }, { status: 400, headers: corsHeaders })
      }

      if (isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return Response.json({ error: msg.notANumber, details: String(port) }, { status: 400, headers: corsHeaders })
      }

      if (!await isPidRunning(pid)) {
        return Response.json({ error: `PID ${pid} is not running.` }, { status: 400, headers: corsHeaders })
      }

      if (serverConfigs.has(name)) {
        return Response.json({ error: `Namespace '${name}' belongs to a managed candy server.` }, { status: 409, headers: corsHeaders })
      }

      const existingOwner = pidOwnedRoutes.get(name)
      if (existingOwner && existingOwner.pid !== pid) {
        if (await isPidRunning(existingOwner.pid)) {
          return Response.json({ error: `Namespace '${name}' is already owned by PID ${existingOwner.pid}.` }, { status: 409, headers: corsHeaders })
        }
        releasePidOwnedRoute(name)
      }

      const existingRoute = routes.get(name)
      if (existingRoute && !existingOwner) {
        return Response.json({ error: `Namespace '${name}' is already registered.` }, { status: 409, headers: corsHeaders })
      }

      const portCollision = [...routes.entries()].find(([routeName, route]) => {
        if (routeName === name || typeof route.target === "string") return false
        return route.target === port
      })
      if (portCollision) {
        const m = msg.portCollision
        return Response.json({ error: m, details: `${portCollision[0]} has :${port}` }, { status: 409, headers: corsHeaders })
      }

      routes.set(name, { target: port, persistent: persistent === true })
      claimPidOwnedRoute(name, pid)
      await syncCaddy()
      if (persistent === true) await savePersistentRoutes()

      log("ADD", `${name}.localhost -> :${port} (pid ${pid})`)
      return Response.json({
        success: true,
        name,
        port,
        domain: `${name}.localhost`,
        url: makeLocalhostUrl(name),
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/sdk/portal") {
      const { configId, name, pid } = await req.json() as { configId?: string; name?: string; pid?: number }

      if (configId) {
        const managed = await resolveManagedRuntime(configId, pid)
        if (!managed) {
          return Response.json({ error: "That candy runtime is not active." }, { status: 404, headers: corsHeaders })
        }
        if (!managed.port) {
          return Response.json({ error: `Server '${managed.name}' is running but has no detected port yet.` }, { status: 400, headers: corsHeaders })
        }

        const result = await openPortalForName({ name: managed.name, port: managed.port })
        return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: corsHeaders })
      }

      if (!name || !pid) {
        return Response.json({ error: "name and pid are required when not running inside candy." }, { status: 400, headers: corsHeaders })
      }

      const port = await getPidOwnedRoutePort(name, pid)
      if (!port) {
        return Response.json({ error: `PID ${pid} does not own '${name}'.` }, { status: 403, headers: corsHeaders })
      }

      const result = await openPortalForName({ name, port })
      return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: corsHeaders })
    }

    // Idling and cron come from inside a running server only: the caller's PID
    // must be in that server's process tree, and the API key's user must be
    // allowed to change its config.
    if (req.method === "POST" && (url.pathname === "/sdk/idle" || url.pathname === "/sdk/cron")) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null
      const configId = typeof body?.configId === "string" ? body.configId : ""
      const pid = typeof body?.pid === "number" ? body.pid : 0
      if (!configId || !pid) {
        return Response.json({ error: "configId and pid are required. Call this from inside a server candy started." }, { status: 400, headers: corsHeaders })
      }
      const managed = await resolveManagedRuntime(configId, pid)
      if (!managed) {
        return Response.json({ error: "No running candy server owns that process." }, { status: 404, headers: corsHeaders })
      }
      if (!mayChangeConfig(requestUser(req), managed.config)) {
        return Response.json({ error: "That server belongs to another user." }, { status: 403, headers: corsHeaders })
      }

      if (url.pathname === "/sdk/idle") {
        const idling = body?.idling !== false
        if (managed.idling !== idling) {
          managed.idling = idling
          auditLog('IDLING', `${managed.name}: ${idling ? 'on' : 'off'}`, 'SDK')
        }
        return Response.json({ success: true, name: managed.name, idling }, { headers: corsHeaders })
      }

      // /sdk/cron: list | set | remove
      const config = getConfigById(managed.name, managed.config.id) ?? managed.config
      const action = body?.action ?? "list"
      let jobs = [...(config.cron ?? [])]
      if (action === "set") {
        const v = validateCronJob(body?.job)
        if (!v.ok) return Response.json({ error: v.error }, { status: 400, headers: corsHeaders })
        const i = jobs.findIndex(j => j.name === v.job.name)
        if (i >= 0) jobs[i] = v.job
        else if (jobs.length >= MAX_CRON_JOBS) {
          return Response.json({ error: `A server can have at most ${MAX_CRON_JOBS} cron jobs.` }, { status: 400, headers: corsHeaders })
        } else jobs.push(v.job)
        auditLog('CRON_SET', `${managed.name}:${v.job.name} "${v.job.schedule}" ${JSON.stringify(v.job.args)}`, 'SDK')
      } else if (action === "remove") {
        const name = body?.name
        const before = jobs.length
        jobs = jobs.filter(j => j.name !== name)
        if (jobs.length !== before) auditLog('CRON_REMOVE', `${managed.name}:${name}`, 'SDK')
      } else if (action !== "list") {
        return Response.json({ error: "action must be list, set or remove" }, { status: 400, headers: corsHeaders })
      }
      if (action !== "list") {
        for (const target of new Set([config, managed.config])) {
          if (jobs.length > 0) target.cron = jobs
          else delete target.cron
        }
        await saveServerConfigs()
      }
      return Response.json({ success: true, name: managed.name, jobs }, { headers: corsHeaders })
    }

    // === Route Management ===

    if (req.method === "POST" && url.pathname === "/register") {
      const body = await req.json() as { name: string; port?: number; target?: string; persistent?: boolean }
      const { name } = body

      // Reserved names
      if (isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }

      const isRestricted = body.target && (body.target.startsWith("http://") || body.target.startsWith("https://"))
      if (!isRestricted && (!Number.isInteger(body.port) || body.port! < 1 || body.port! > 65535)) {
        return Response.json({ error: "A route needs a port (1-65535) or an http(s) address.", details: String(body.port ?? body.target ?? "") }, { status: 400, headers: corsHeaders })
      }
      const routeTarget = isRestricted ? body.target! : body.port!

      if (!isRestricted) {
        const existingRoute = [...routes.entries()].find(([n, r]) => r.target === routeTarget && n !== name)
        if (existingRoute) {
          const m = msg.portCollision
          return Response.json({ error: m, details: `${existingRoute[0]} has :${routeTarget}` }, { status: 409, headers: corsHeaders })
        }
      }

      const persistent = body.persistent === true
      routes.set(name, { target: routeTarget, persistent })
      releasePidOwnedRoute(name)
      await syncCaddy()
      if (persistent) await savePersistentRoutes()

      log("ADD", `${name}.localhost -> ${isRestricted ? routeTarget : ":" + routeTarget}`)
      return Response.json({ domain: `${name}.localhost`, status: "registered", message: "Route added" }, { headers: corsHeaders })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/register/")) {
      const name = url.pathname.split("/")[2]
      if (isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }
      if (!routes.has(name)) {
        return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
      }

      // Also stop the associated process if running
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      const proc = processes.get(name)
      if (proc && (proc.status === 'running' || proc.status === 'starting')) {
        await stopProcess(name, actor)
      }

      const wasRoute = routes.get(name)
      routes.delete(name)
      releasePidOwnedRoute(name)
      await forgetLanPublishedIfGone(name)
      await syncCaddy()
      if (wasRoute?.persistent) await savePersistentRoutes()
      const m = msg.removed
      log("REMOVE", `${name}.localhost`)
      return Response.json({ status: "removed", message: m }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/rename") {
      const { oldName, newName } = await req.json() as { oldName: string, newName: string }

      if (isReserved(oldName) || isReserved(newName)) {
        return Response.json({ error: "That name is reserved.", details: "portal" }, { status: 403, headers: corsHeaders })
      }
      if (!routes.has(oldName)) {
        return Response.json({ error: msg.notFound, details: oldName }, { status: 404, headers: corsHeaders })
      }
      if (routes.has(newName)) {
        return Response.json({ error: `A route named '${newName}' already exists.`, details: newName }, { status: 409, headers: corsHeaders })
      }

      const routeData = routes.get(oldName)!
      routes.delete(oldName)
      routes.set(newName, routeData)
      if (routeData.persistent) await savePersistentRoutes()

      const routeOwner = pidOwnedRoutes.get(oldName)
      if (routeOwner) {
        pidOwnedRoutes.delete(oldName)
        pidOwnedRoutes.set(newName, routeOwner)
      }

      // The LAN opt-in follows the route, unless a server config keeps the old name.
      if (isLanPublished(oldName)) {
        const oldKey = oldName.toLowerCase()
        const newKey = newName.toLowerCase()
        const httpsPort = lanHttps.get(oldKey)
        if (!serverConfigs.has(oldName)) {
          lanPublished.delete(oldKey)
          lanHttps.delete(oldKey)
          lanDomainHttps.delete(oldKey)  // the bound domain stays with the old name
        }
        lanPublished.add(newKey)
        // A port can only belong to one name, so HTTPS moves only with the whole opt-in.
        if (httpsPort !== undefined && !lanHttps.has(oldKey)) lanHttps.set(newKey, httpsPort)
        await saveLanPublished()
      }

      if (portals.has(oldName)) {
        const portalData = portals.get(oldName)!
        portals.delete(oldName)
        portals.set(newName, portalData)
      }

      await syncCaddy()
      const m = msg.launder
      log("RENAME", `${oldName} -> ${newName}`)
      return Response.json({ status: "renamed", oldName, newName, message: m }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/routes") {
      const routeList: Record<string, { target: number | string, isRestricted: boolean, persistent: boolean, lan: boolean, lanHttps: string | null, tsServe: string | null }> = {}
      for (const [name, route] of routes) {
        if (isReserved(name)) continue  // hide reserved
        routeList[name] = {
          target: route.target,
          isRestricted: typeof route.target === "string",
          persistent: route.persistent,
          lan: isLanPublished(name),
          lanHttps: isLanPublished(name) ? lanHttpsUrl(name) : null,
          tsServe: tsServeUrl(name),
        }
      }
      return Response.json(routeList, { headers: corsHeaders })
    }

    // === LAN Publishing ===

    if (req.method === "GET" && url.pathname === "/lan") {
      const names = [...new Set([...routes.keys(), ...serverConfigs.keys()])]
        .filter(name => !isReserved(name))
        .sort((a, b) => a.localeCompare(b))
      return Response.json({
        lanIp,
        tailnetHost: getTailnetHostname(),
        published: [...lanPublished].sort(),
        names: Object.fromEntries(names.map(name => [name, isLanPublished(name)])),
        https: Object.fromEntries([
          ...[...lanHttps].map(([name, port]) => [name, { mode: "tailscale", port, url: lanHttpsUrl(name) }]),
          ...[...lanDomainHttps].map(name => [name, { mode: "domain", port: null, url: lanHttpsUrl(name) }]),
        ]),
      }, { headers: corsHeaders })
    }

    if (url.pathname === "/routes/serve") {
      if (req.method === "GET") {
        return Response.json({
          tailnetHost: getTailnetHostname(),
          serves: Object.fromEntries([...tsServes].map(([name, port]) => [name, { port, url: tsServeUrl(name), entryPort: entryPorts.get(name) ?? null }])),
        }, { headers: corsHeaders })
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { name?: string; port?: number | null }
        const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : ""
        if (!name || isReserved(name)) return Response.json({ error: "A valid name is required." }, { status: 400, headers: corsHeaders })
        if (!routes.has(name) && !serverConfigs.has(name)) return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
        const cfg = getConfigsForName(name)[0]
        if (cfg && !mayChangeConfig(requestUser(req), cfg)) {
          return Response.json({ error: `${name} runs as ${configUser(cfg)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
        }
        const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
        const result = await setTsServe(name, body.port === null || body.port === undefined ? null : Number(body.port), actor)
        if (!result.ok) return Response.json({ error: result.error }, { status: 409, headers: corsHeaders })
        return Response.json({ name, port: tsServes.get(name) ?? null, url: result.url, entryPort: entryPorts.get(name) ?? null }, { headers: corsHeaders })
      }
    }

    if (url.pathname === "/routes/entry") {
      if (req.method === "GET") {
        return Response.json({ entries: Object.fromEntries(entryPorts) }, { headers: corsHeaders })
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { name?: string; port?: number | null }
        const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : ""
        if (!name || isReserved(name)) return Response.json({ error: "A valid name is required." }, { status: 400, headers: corsHeaders })
        if (!routes.has(name) && !serverConfigs.has(name)) return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
        const cfg = getConfigsForName(name)[0]
        if (cfg && !mayChangeConfig(requestUser(req), cfg)) {
          return Response.json({ error: `${name} runs as ${configUser(cfg)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
        }
        const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
        if (body.port === null || body.port === undefined) {
          if (entryPorts.delete(name)) {
            await saveEntryPorts()
            await syncCaddy()
            auditLog('ENTRY_PORT_OFF', name, actor)
          }
          return Response.json({ name, port: null }, { headers: corsHeaders })
        }
        const port = Number(body.port)
        const problem = entryPortProblem(name, port)
        if (problem) return Response.json({ error: problem }, { status: 409, headers: corsHeaders })
        entryPorts.set(name, port)
        await saveEntryPorts()
        await syncCaddy()
        auditLog('ENTRY_PORT', `${name} <- 127.0.0.1:${port}`, actor)
        return Response.json({ name, port, url: `http://127.0.0.1:${port}` }, { headers: corsHeaders })
      }
    }

    if (url.pathname === "/lan/adguard") {
      if (requestUser(req) !== OWNER) {
        return Response.json({ error: "Only the owner can change the AdGuard Home link." }, { status: 403, headers: corsHeaders })
      }
      if (req.method === "GET") return Response.json(adguardStatus(), { headers: corsHeaders })
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        if (body.remove === true) {
          if (adguardConfig) {
            // Take back the lines candy added, then forget the login
            await applyAdguardUpstreams(adguardConfig, []).catch(() => {})
            adguardConfig = null
            adguardApplied = null
            adguardError = null
            await saveAdguardConfig()
            auditLog('ADGUARD_UNLINK', 'AdGuard Home link removed')
          }
          return Response.json(adguardStatus(), { headers: corsHeaders })
        }
        const str = (v: unknown) => typeof v === "string" ? v.trim() : ""
        const next: AdguardConfig = {
          url: str(body.url) || adguardConfig?.url || "http://127.0.0.1:3000",
          username: str(body.username) || adguardConfig?.username || "",
          password: typeof body.password === "string" && body.password ? body.password : adguardConfig?.password || "",
          client: str(body.client) || adguardConfig?.client || "",
          dnsTarget: str(body.dnsTarget) || adguardConfig?.dnsTarget || "127.0.0.1:5336",
          managed: adguardConfig?.managed ?? [],
        }
        if (!/^https?:\/\/[^\s]+$/.test(next.url)) return Response.json({ error: "url must be an http(s) address." }, { status: 400, headers: corsHeaders })
        if (!/^[\w.:\[\]-]+:\d+$/.test(next.dnsTarget)) return Response.json({ error: "dnsTarget must be host:port." }, { status: 400, headers: corsHeaders })
        if (!next.username || !next.password || !next.client) {
          return Response.json({ error: "username, password and client are required." }, { status: 400, headers: corsHeaders })
        }
        const previous = adguardConfig
        adguardConfig = next
        try {
          await syncAdguard(true)
        } catch (e) {
          adguardConfig = previous
          return Response.json({ error: String((e as Error)?.message ?? e) }, { status: 502, headers: corsHeaders })
        }
        await saveAdguardConfig()
        auditLog('ADGUARD_LINK', `${next.url} client "${next.client}"`)
        return Response.json(adguardStatus(), { headers: corsHeaders })
      }
    }

    if (req.method === "POST" && url.pathname === "/lan") {
      const body = await req.json() as { name?: string; publish?: boolean; https?: boolean | "domain" | "tailscale"; port?: number }
      const name = typeof body.name === "string" ? body.name.trim() : ""
      const publish = body.publish !== false
      const key = name.toLowerCase()

      if (!name || isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }
      if (publish && !routes.has(name) && !serverConfigs.has(name)) {
        return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
      }

      // Optional HTTPS with a trusted certificate (omitted = unchanged):
      //   true        the bound domain if the name has one, else the ts.net hostname
      //   "domain"    https://<bound domain>
      //   "tailscale" https://<host>.ts.net:<port> (also chosen when a port is given)
      //   false       off
      let httpsChange: "on" | "off" | null = null
      const wantHttps = body.https === true || body.https === "domain" || body.https === "tailscale"
      if (publish && wantHttps) {
        const mode: LanHttpsMode = body.https === true
          ? (body.port === undefined && bindingForServer(key) ? "domain" : "tailscale")
          : body.https as LanHttpsMode
        if (mode === "domain") {
          if (body.port !== undefined) {
            return Response.json({ error: "A bound domain is served on port 443. Ports are for Tailscale mode." }, { status: 400, headers: corsHeaders })
          }
          if (!bindingForServer(key)) {
            return Response.json({ error: `${name} has no bound domain. Bind one (candy domain bind), or use Tailscale mode.` }, { status: 409, headers: corsHeaders })
          }
          if (!lanDomainHttps.has(key)) {
            lanHttps.delete(key)
            lanDomainHttps.add(key)
            httpsChange = "on"
          }
        } else {
          if (!getTailnetHostname()) {
            return Response.json({ error: "Tailscale mode needs this machine's Tailscale hostname, and Tailscale isn't reporting one." }, { status: 409, headers: corsHeaders })
          }
          const port = body.port !== undefined ? Number(body.port) : (lanHttps.get(key) ?? await pickLanHttpsPort(key))
          if (port === null) {
            return Response.json({ error: "No free port found for HTTPS. Pass one explicitly." }, { status: 409, headers: corsHeaders })
          }
          const problem = await lanHttpsPortProblem(key, port)
          if (problem) return Response.json({ error: problem, details: String(port) }, { status: 409, headers: corsHeaders })
          if (lanHttps.get(key) !== port || lanDomainHttps.has(key)) {
            lanDomainHttps.delete(key)
            lanHttps.set(key, port)
            httpsChange = "on"
          }
          // Same URL on the tailnet: tailscale serve on the same port, through candy.
          // Best effort; a port tailscale already serves for something else is left alone.
          if (tsServes.get(key) !== port) {
            const served = await setTsServe(key, port, (req.headers.get('X-Candy-Actor') as Actor) || 'Portal')
            if (!served.ok) auditLog('TS_SERVE_SKIP', `${key} :${port}: ${served.error}`, 'System')
          }
        }
      } else if (body.https === false && lanHttpsMode(key)) {
        lanHttps.delete(key)
        lanDomainHttps.delete(key)
        httpsChange = "off"
      }

      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      const wasPublished = isLanPublished(name)
      await setLanPublished(name, publish, actor)
      if (httpsChange && publish) {
        // setLanPublished only saves and reloads when the opt-in itself changed.
        if (wasPublished) {
          await saveLanPublished()
          await syncCaddy()
        }
        auditLog(httpsChange === "on" ? 'LAN_HTTPS_ON' : 'LAN_HTTPS_OFF', `${key}${httpsChange === "on" ? ` -> ${lanHttpsUrl(key)}` : ''}`, actor)
      }
      const httpsUrl = isLanPublished(name) ? lanHttpsUrl(name) : null
      log(publish ? "LAN" : "UNLAN", `${name}.candy${publish && lanIp ? ` -> ${lanIp}` : ""}${httpsUrl ? ` + ${httpsUrl}` : ""}`)
      return Response.json({
        name,
        domain: `${name}.candy`,
        published: isLanPublished(name),
        lanIp,
        httpsUrl,
        httpsMode: lanHttpsMode(key),
        dnsManaged: !!adguardConfig,  // AdGuard Home's LAN upstreams are kept in sync
        httpsPort: lanHttps.get(key) ?? null,
        ...(publish && !lanIp ? { warning: "No LAN address detected. Set CANDY_LAN_IP to publish." } : {}),
      }, { headers: corsHeaders })
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

      const result = await openPortalForName({ name, port, openBrowser })
      return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: corsHeaders })
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
          return Response.json({ error: msg.noRoutes }, { status: 400, headers: corsHeaders })
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
        return Response.json({ error: msg.noRoutes }, { status: 400, headers: corsHeaders })
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
        message: msg.batchOpening
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/portals") {
      const portalList: Record<string, { port: number, url?: string }> = {}
      for (const [name, { port, url }] of portals) {
        portalList[name] = url ? { port, url } : { port }
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
        return Response.json({ error: msg.notFound, details: `portal: ${name}` }, { status: 404, headers: corsHeaders })
      }

      if (toClose.proc) {
        try { toClose.proc.kill() } catch {}
      } else if (toClose.pid) {
        await terminateProcessTree(toClose.pid, 3000)
      }
      portals.delete(name)
      await syncCaddy()

      const m = msg.portalClosed
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

    if (req.method === "GET" && url.pathname === "/users") {
      const accounts = await runAsUsers()
      return Response.json({
        owner: OWNER,
        you: requestUser(req),
        multiUser: RUNNING_AS_ROOT,
        users: accounts.map(a => ({ name: a.name, home: a.home })),
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: "running",
        caddyRunning: await isCaddyRunning(),
        routeCount: routes.size,
        portalCount: portals.size,
        uptime: process.uptime(),
        pid: process.pid,
        owner: OWNER,
        multiUser: RUNNING_AS_ROOT,
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      if (RUNNING_AS_ROOT && requestUser(req) !== OWNER) {
        return Response.json({ error: `Only ${OWNER} can do that.` }, { status: 403, headers: corsHeaders })
      }
      const m = msg.exit
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
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return Response.json({ success: false, error: "The port must be a number from 1 to 65535." }, { status: 400, headers: corsHeaders })
      }
      // This is the port the server itself listens on, not an outside address.
      // If we can see what it listens on, refuse anything else: candy would
      // forward to a port nothing answers on.
      const running = processes.get(name)
      const actual = running ? await listeningPortsOfServer(running).catch(() => []) : []
      if (actual.length > 0 && !actual.includes(port)) {
        return Response.json({
          success: false,
          error: `${name} listens on ${actual.join(", ")}, not ${port}. This sets the server's own port; for an outside address use a route, a bound domain or 'candy route serve'.`,
        }, { status: 409, headers: corsHeaders })
      }
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
      // Typing into a terminal runs commands as its user, so only that user may
      if (RUNNING_AS_ROOT && requestUser(req) !== configUser(managed.config)) {
        return Response.json({ success: false, error: `${name} runs as ${configUser(managed.config)}. Only they can type into it.` }, { status: 403, headers: corsHeaders })
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
          user: configUser(first),
          api: !!first.api,
          sandbox: SANDBOX_AVAILABLE && first.sandbox !== false,
          envFile: first.envFile ?? null,
          rw: first.rw ?? [],
          count: entries.length,
          variants: entries.map(c => ({ id: c.id, cwd: c.cwd, cmd: c.cmd, user: configUser(c), api: !!c.api })),
          lan: isLanPublished(name),
          lanHttps: isLanPublished(name) ? lanHttpsUrl(name) : null,
          tsServe: tsServeUrl(name),
        }
      }
      return Response.json({ success: true, configs }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config") {
      const { name, cwd, cmd, api, user: runAs, envFile } = await req.json() as { name: string, cwd: string, cmd: string, api?: boolean, user?: string, envFile?: string | null }
      if (isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      // Run as yourself, or (owner only) as another member of the candy group
      const requester = requestUser(req)
      let user = requester
      if (runAs && runAs !== requester) {
        if (!RUNNING_AS_ROOT || requester !== OWNER) {
          return Response.json({ error: `You can only add sites that run as ${requester}.` }, { status: 403, headers: corsHeaders })
        }
        if (!(await runAsUsers()).some(u => u.name === runAs)) {
          return Response.json({ error: `${runAs} isn't in the ${SHARED_GROUP} group, so sites can't run as them.` }, { status: 400, headers: corsHeaders })
        }
        user = runAs
      }
      // A name belongs to one user: its state folder and env files are theirs
      const otherOwner = RUNNING_AS_ROOT ? getConfigsForName(name).find(cfg => configUser(cfg) !== user) : undefined
      if (otherOwner) {
        return Response.json({ error: `'${name}' already belongs to ${configUser(otherOwner)}. Pick another name.` }, { status: 403, headers: corsHeaders })
      }
      if (envFile !== undefined && envFile !== null) {
        const problem = await envFileProblem(user, String(envFile))
        if (problem) return Response.json({ error: problem }, { status: 400, headers: corsHeaders })
      }
      await addServerConfig(name, cwd, cmd, actor, user, typeof api === "boolean" ? api : undefined)
      const added = getConfigsForName(name).slice(-1)[0]
      if (envFile && added) {
        added.envFile = String(envFile)
        await saveServerConfigs()
      }
      return Response.json({ success: true, config: added }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config/api") {
      const { name, configId, api } = await req.json().catch(() => ({})) as { name?: string, configId?: string, api?: boolean }
      if (!name || typeof api !== "boolean") {
        return Response.json({ error: "name and api (true or false) are required" }, { status: 400, headers: corsHeaders })
      }
      const targets = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      if (targets.length === 0) {
        return Response.json({ error: `No site named '${name}' with a start command.` }, { status: 404, headers: corsHeaders })
      }
      const requester = requestUser(req)
      const denied = targets.find(cfg => !mayChangeConfig(requester, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      for (const cfg of targets) setApiFlag(cfg, api)
      await saveServerConfigs()
      await syncCaddy()  // protected domains switch between login page and header auth
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      auditLog('CONFIG_API', `${name}: API mode ${api ? 'on' : 'off'}`, actor)
      return Response.json({ success: true, api, message: `API mode ${api ? 'on' : 'off'} for ${name}` }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config/env") {
      const body = await req.json().catch(() => ({})) as { name?: string, configId?: string, envFile?: string | null }
      const { name, configId } = body
      if (!name) return Response.json({ error: "name is required" }, { status: 400, headers: corsHeaders })
      const targets = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      if (targets.length === 0) {
        return Response.json({ error: `No site named '${name}' with a start command.` }, { status: 404, headers: corsHeaders })
      }
      const requester = requestUser(req)
      const denied = targets.find(cfg => !mayChangeConfig(requester, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      const path = body.envFile ? String(body.envFile) : null
      if (path) {
        for (const cfg of targets) {
          const problem = await envFileProblem(configUser(cfg), path)
          if (problem) return Response.json({ error: problem }, { status: 400, headers: corsHeaders })
        }
      }
      for (const cfg of targets) {
        if (path) cfg.envFile = path
        else delete cfg.envFile
      }
      await saveServerConfigs()
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      auditLog('CONFIG_ENV', `${name}: ${path ?? 'no env file'}`, actor)
      return Response.json({ success: true, envFile: path, message: `Takes effect the next time ${name} starts.` }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config/sandbox") {
      const body = await req.json().catch(() => ({})) as { name?: string, configId?: string, sandbox?: boolean, rw?: string[], addRw?: string[], removeRw?: string[] }
      const { name, configId } = body
      if (!name) return Response.json({ error: "name is required" }, { status: 400, headers: corsHeaders })
      const targets = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      if (targets.length === 0) {
        return Response.json({ error: `No site named '${name}' with a start command.` }, { status: 404, headers: corsHeaders })
      }
      const requester = requestUser(req)
      const denied = targets.find(cfg => !mayChangeConfig(requester, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      const lists = [body.rw, body.addRw, body.removeRw].filter(Array.isArray) as unknown[][]
      const bad = lists.flat().find(p => !validateRwPath(p))
      if (bad !== undefined) {
        return Response.json({ error: "Writable paths must be absolute folders, not a whole system tree.", details: String(bad) }, { status: 400, headers: corsHeaders })
      }
      const clean = (list?: string[]) => (list ?? []).map(p => validateRwPath(p)!)
      for (const cfg of targets) {
        if (body.sandbox === false) cfg.sandbox = false
        else if (body.sandbox === true) delete cfg.sandbox
        if (lists.length > 0) {
          let rw = body.rw ? clean(body.rw) : [...(cfg.rw ?? [])]
          rw = [...new Set([...rw, ...clean(body.addRw)])].filter(p => !clean(body.removeRw).includes(p))
          if (rw.length > MAX_RW_PATHS) {
            return Response.json({ error: `At most ${MAX_RW_PATHS} extra writable paths.` }, { status: 400, headers: corsHeaders })
          }
          if (rw.length > 0) cfg.rw = rw
          else delete cfg.rw
        }
      }
      await saveServerConfigs()
      const first = targets[0]
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      auditLog('CONFIG_SANDBOX', `${name}: sandbox ${first.sandbox === false ? 'off' : 'on'}${first.rw?.length ? `, writable: ${first.rw.join(' ')}` : ''}`, actor)
      return Response.json({
        success: true,
        sandbox: first.sandbox !== false,
        active: SANDBOX_AVAILABLE && first.sandbox !== false,
        rw: first.rw ?? [],
        stateDir: stateDirPath(name),
        message: `Takes effect the next time ${name} starts.`,
      }, { headers: corsHeaders })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/config/")) {
      const parts = url.pathname.split("/")
      const name = parts[2]
      const configId = parts[3]
      const actor = (req.headers.get('X-Candy-Actor') as Actor) || 'Portal'
      const requester = requestUser(req)
      const affected = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      const denied = affected.find(cfg => !mayChangeConfig(requester, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can remove it.` }, { status: 403, headers: corsHeaders })
      }
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
          hasJwtSecret: !!binding.auth?.jwtSecret,
          apiMode: isApiSite(binding),
          allowlist: binding.allowlist ?? { enabled: false, ips: [] },
        }
      }
      return Response.json({
        configured: true,
        tunnel: domainConfig.tunnel,
        zone: domainConfig.zone,
        bindings,
      }, { headers: corsHeaders })
    }

    if (url.pathname === "/domains/mcp" || url.pathname === "/domains/mcp/revoke") {
      if (requestUser(req) !== OWNER) {
        return Response.json({ error: "Only the owner can change the public MCP endpoint." }, { status: 403, headers: corsHeaders })
      }
      if (req.method === "GET" && url.pathname === "/domains/mcp") {
        return Response.json(await publicMcpStatus(), { headers: corsHeaders })
      }
      if (req.method === "POST" && url.pathname === "/domains/mcp") {
        const body = await req.json().catch(() => ({})) as { enabled?: boolean; subdomain?: string }
        if (typeof body.enabled !== "boolean") {
          return Response.json({ error: "enabled (true or false) is required" }, { status: 400, headers: corsHeaders })
        }
        const subdomain = (body.subdomain || domainConfig?.mcp?.subdomain || DEFAULT_MCP_SUBDOMAIN).trim().toLowerCase()
        const result = await setPublicMcp(body.enabled, subdomain, isMCP ? 'AI' : 'Portal')
        if (!result.ok) return Response.json({ error: result.error }, { status: 400, headers: corsHeaders })
        return Response.json(await publicMcpStatus(), { headers: corsHeaders })
      }
      if (req.method === "POST" && url.pathname === "/domains/mcp/revoke") {
        const oauth = await getMcpOAuth()
        if (!oauth) return Response.json({ error: "The public MCP endpoint is off." }, { status: 409, headers: corsHeaders })
        const body = await req.json().catch(() => ({})) as { clientId?: string }
        if (body.clientId) {
          if (!oauth.revokeClient(body.clientId)) return Response.json({ error: "No such client." }, { status: 404, headers: corsHeaders })
        } else oauth.revokeAll()
        auditLog('MCP_PUBLIC_REVOKE', body.clientId || 'all clients', isMCP ? 'AI' : 'Portal')
        return Response.json(await publicMcpStatus(), { headers: corsHeaders })
      }
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
      if (fqdn.toLowerCase() === publicMcpFqdn()) {
        return Response.json({ error: `${fqdn} is the public MCP endpoint. Pick another subdomain, or turn that off first.` }, { status: 409, headers: corsHeaders })
      }

      // Bind any site: one candy starts, or a plain route to a port or URL
      if (!serverConfigs.has(serverName) && !routes.has(serverName)) {
        return Response.json({ error: `No site named '${serverName}'. Add it first.` }, { status: 404, headers: corsHeaders })
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
                message: `${fqdn} already has DNS records. Replace them to point it at candy?`,
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

      // Regenerate Caddy's http://fqdn blocks (without one, Caddy redirects the tunnel's plain HTTP to HTTPS forever)
      await syncCaddy()
      // Sync ingress and restart cloudflared
      await syncCloudflaredIngress()
      await restartCloudflared()

      auditLog('DOMAIN_BIND', `${fqdn} -> ${serverName}`, isMCP ? 'AI' : 'Portal')
      return Response.json({
        message: `${fqdn} now serves ${serverName}`,
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

      // Regenerate Caddy's http://fqdn blocks (without one, Caddy redirects the tunnel's plain HTTP to HTTPS forever)
      await syncCaddy()
      // Sync ingress and restart cloudflared
      await syncCloudflaredIngress()
      await restartCloudflared()

      auditLog('DOMAIN_UNBIND', `${binding.fqdn}`, isMCP ? 'AI' : 'Portal')
      return Response.json({
        message: `Unbound ${binding.fqdn}`,
        subdomain,
        fqdn: binding.fqdn,
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/domains/config") {
      if (RUNNING_AS_ROOT && requestUser(req) !== OWNER) {
        return Response.json({ error: `Only ${OWNER} can do that.` }, { status: 403, headers: corsHeaders })
      }
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
    const currentHostUrl = (path: string = "") => `https://${reqHost}${path}`
    const currentServiceHost = () => {
      if (!isCandy) return reqHost
      return reqHost.replace(/\.(kill|k|portal|p)(?:\.([a-z0-9-]+))?\.candy$/, (_full, _action, hostLabel) =>
        hostLabel ? `.${hostLabel}.candy` : ".candy",
      )
    }
    const currentServiceUrl = (path: string = "") => `https://${currentServiceHost()}${path}`

    // Handle kill hostnames:
    // - <name>.kill.localhost / <name>.k.localhost
    const killSuffixMatch = reqHost.match(/^([a-z0-9-]+)\.(kill|k)(?:\.([a-z0-9-]+))?\.(localhost|candy)$/)
    if (killSuffixMatch && req.method === "GET") {
      const requestedName = killSuffixMatch[3] ? `${killSuffixMatch[1]}.${killSuffixMatch[3]}` : killSuffixMatch[1]
      const serverName = killSuffixMatch[4] === "candy"
        ? resolveLocalCandyActionDomain(killSuffixMatch[1], killSuffixMatch[3] || null)
        : requestedName

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
    const portalMatch = reqHost.match(/^([a-z0-9-]+)\.(portal|p)(?:\.([a-z0-9-]+))?\.(localhost|candy)$/)
    if (portalMatch && req.method === "GET") {
      const requestedName = portalMatch[3] ? `${portalMatch[1]}.${portalMatch[3]}` : portalMatch[1]
      const serverName = portalMatch[4] === "candy"
        ? resolveLocalCandyActionDomain(portalMatch[1], portalMatch[3] || null)
        : requestedName

      // Check if process is running
      const proc = processes.get(serverName)
      if (!proc || proc.status !== 'running' || !proc.port) {
        // Check if config exists
        const hasConfig = serverConfigs.has(serverName)
        const message = hasConfig
          ? `Server "${serverName}" is not running.`
          : `Server "${serverName}" does not exist.`
        const action = hasConfig
          ? `<a href="${isCandy ? currentServiceUrl() : domainUrl(serverName)}" class="btn">Start Server</a>`
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

        const newPortal = {
          port: proc.port,
          url: null,
          pid: tunnelProc.pid,
          proc: tunnelProc,
        }
        existingPortal = newPortal
        portals.set(serverName, newPortal)

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
        const domain = boundMatch ? boundMatch.serverName : resolveLocalCandyDomain(reqHost)
        const isBoundDomain = !!boundMatch
        const isRootPath = url.pathname === "/" || url.pathname === ""

        // Portal UI at portal.localhost (only root)
        if (domain === "portal" && isRootPath && !isBoundDomain) {
          domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
          const rawHtml = await Bun.file(import.meta.dir + "/public/portal.html").text()
          let html = injectToken(rawHtml)
          // Check if any bound domain is unprotected → inject nag banner on portal
          const domainConfig = await loadDomainConfig()
          const hasUnprotected = domainConfig?.bindings && Object.values(domainConfig.bindings).some((b: any) => !b.auth?.password || !b.auth?.enabled)
          if (hasUnprotected) {
            const nagScript = `<script data-candy-nag>(function(){if(document.querySelector('[data-candy-nag-banner]'))return;var b=document.createElement('div');b.setAttribute('data-candy-nag-banner','1');b.setAttribute('role','status');b.innerHTML='<span>A public domain has no password. Anyone with the link can open it.</span><button aria-label="Dismiss" style="background:none;border:0;color:inherit;opacity:.7;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 14px">&times;</button>';b.querySelector('button').onclick=function(){b.remove()};b.style.cssText='position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100% - 32px);display:flex;align-items:center;background:#1a1d33;color:#fff;padding:10px 14px 10px 16px;border-radius:10px;font:500 13px/1.4 \\'Schibsted Grotesk\\',system-ui,sans-serif;box-shadow:0 10px 30px rgba(10,12,24,.25);z-index:999999';document.body.appendChild(b)})()</script>`
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
              const hasAuth = hasBindingAuth(boundMatch!.binding)

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
            return Response.redirect(currentHostUrl(`${url.pathname}${url.search}`), 302)
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
                  const proxyRes = await fetchWithHeaderTimeout(`http://localhost:${newProcess.port}${url.pathname}${url.search}`, {
                    headers: req.headers,
                  }, req)
                  return new Response(proxyRes.body, { status: proxyRes.status, headers: proxyRes.headers })
                } catch (e) {
                  return new Response(`Proxy error: ${e}`, { status: 502 })
                }
              }
              // Auto-detected port - redirect preserving path (Caddy will take over)
              return Response.redirect(currentHostUrl(`${url.pathname}${url.search}`), 302)
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

        // A bound domain whose site no longer exists
        if (isBoundDomain) {
          const safeName = String(domain).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
          return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nothing here</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;box-sizing:border-box;background:#eceef2;color:#1a1d33;font:15px/1.5 system-ui,sans-serif}h1{font-size:20px;margin:0 0 6px}p{margin:0;color:#555b75}code{font-family:ui-monospace,monospace}@media (prefers-color-scheme:dark){body{background:#10121a;color:#e7e9f2}p{color:#a3a8c0}}</style>
</head><body><main><h1>Nothing is served here</h1><p>This domain points at <code>${safeName}</code>, which isn’t set up in candy any more.</p></main></body></html>`, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
            status: 404
          })
        }

        // No config exists - redirect non-root paths to root for registration
        if (!isRootPath) {
          return Response.redirect(currentHostUrl("/"), 302)
        }

        // Show candy/terminal page with mode toggle (registration screen)
        domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
        const page = "candy.html"
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
await loadAuthFailures('startup')
await watchAuthFailures()
await syncCloudflaredIngress()
await restartCloudflared()

// Initialize MCP auth (write bootstrap secret to file)
await initMcpAuth()

// Load persistent routes first (survive daemon restarts)
await loadPersistentRoutes()

// Load remote advertisements from disk
await loadAdvertisements()

// LAN publishing: opted-in names and this machine's LAN address
await loadLanPublished()
await loadEntryPorts()
await loadTsServes()
await loadAdguardConfig()
lanIp = await discoverLanIp()

// Create fresh Caddyfile (includes persistent routes)
await syncCaddy()

// Now start Caddy
await startCaddy()

// Discover Tailscale IP for .candy TLD support
tailscaleIp = await discoverTailscaleIp()
if (tailscaleIp) {
  // Re-sync Caddy with .candy blocks now that we have the IP
  await syncCaddy()
  syncTsServe().catch(() => {})
}

// Write PID file
await Bun.write(PID_FILE, process.pid.toString())

const tailscaleStatus = tailscaleIp
  ? `\x1b[33mTailscale:\x1b[0m   ${tailscaleIp} (*.candy domains active)`
  : `\x1b[90mTailscale:\x1b[0m   not detected (*.candy domains disabled)`
const lanStatus = lanIp
  ? `\x1b[33mLAN:\x1b[0m         ${lanIp} (${lanPublished.size} published${lanHttps.size + lanDomainHttps.size ? `, ${lanHttps.size + lanDomainHttps.size} with HTTPS` : ''})`
  : `\x1b[90mLAN:\x1b[0m         not detected (LAN publishing disabled)`

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
${lanStatus}

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

// Follow LAN address changes (DHCP renewals, switching networks)
setInterval(() => { refreshLanIp().catch(() => {}) }, LAN_IP_REFRESH_INTERVAL)

// Client-side: advertise to hub if we're not the DNS host
setInterval(advertiseToHub, READVERTISE_INTERVAL)
// Also advertise immediately on startup (with short delay for DNS to be ready)
setTimeout(advertiseToHub, 5000)
