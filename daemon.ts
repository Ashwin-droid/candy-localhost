/**
 * candy-localhost daemon v0.4 - Lazy Dev Server Orchestrator
 * Now with lazy-loaded dev servers and MCP integration
 *
 * Runs as a background service, manages Caddy, spawns dev servers on-demand
 */

import { $, spawn, type Subprocess } from "bun"
import { chmodSync, closeSync, existsSync, openSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs"
import { appendFile, chmod, chown, lchown, lstat, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { timingSafeEqual } from "node:crypto"
import { networkInterfaces, userInfo } from "node:os"
import { SHARED_GROUP, SHARED_SECRET_FILE } from "./secret.ts"
import { AccessLogTail, activityFromAccessLog, countEstablished, idleVerdict, IDLE_TIMEOUT_MS, listeningPortsOf, localNameCandidates, readMemoryState, tailscaleServeTargets, validateTtlMinutes, type MemoryState } from "./activity.ts"
import { findCodeDir, parseEnvFile, stateDirPath, systemdRunCommand, unitName, unitOfCgroup, userEnvDir, validateEnvFilePath, validateRwPath, MAX_RW_PATHS, SANDBOX_SLICE, STATE_ROOT, DEFAULT_MEMORY_MB, MAX_MEMORY_MB, MIN_MEMORY_MB, formatMemory, memoryLimitMb, memoryProperties, validateMemoryMb } from "./sandbox.ts"
import { OAuthServer, type OAuthPersisted } from "./mcp-oauth.ts"
import { handlePublicRequest as handlePublicMcpRequest } from "./mcp.ts"
import { applyAdguardUpstreams, upstreamRule, type AdguardConfig } from "./adguard.ts"
import { CRON_JOB_ENV, LAUNCH_WRAPPER, cronMatches, cronScript, DEFAULT_CRON_TIMEOUT_S, MAX_CRON_JOBS, parseCron, validateCronJob, type CronJob } from "./cron.ts"
import { FnRuntime, type FnLaunched } from "./fn-runtime.ts"
import { FnLog, replayRequest } from "./fn-log.ts"
import { cronJobsFor } from "./fn-cron.ts"
import { checkToolResult, runFnTool, type FnToolOp } from "./fn-tool.ts"
import {
  fnFileName, fnLaunchArgs, fnLaunchEnv, fnLimits, fnRequestHeaders, fnSocketPath as fnSocketPathIn, fnTargetForRequest, fnToolCommand,
  normalizeFnSettings, pinnedBun, FN_DEFAULT_LINGER_S, FN_DEFAULT_MAX, FN_MAX_INSTANCES, FN_MAX_LINGER_S, type FnSettings,
  fnAssetsPlan, fnShimProject, fnSummaryOf, logAssetResponse, routeFunctionRequest, FnRoutingCache, type FnAssetsPlan,
} from "./fn-daemon.ts"
import { AssetServer, userCanRead, type AssetsConfig } from "./fn-assets.ts"
import { isDeployId, type DeployInfo } from "./fn-deploy.ts"
import { CONFIG_FILES as FN_CONFIG_FILES, type FnProjectConfig } from "./fn-config.ts"
import { apiHoldSeconds, createApiModeGate } from "./api-mode.ts"
import { SystemMonitor, SIGNALS, isUnitName, killProblem, unitActionProblem } from "./sysmon.ts"
import { PortalSessions, readSessionCookie, sessionCookieHeader, clearSessionCookieHeader } from "./portal-session.ts"
import { attemptLogin, loginKeys, auditActor, auditSafe, cachedList, classifyRoute, clientIp, guardRequest, isPortalOrigin, LoginSlots, mayActOn, PageTokens, parseShortcutHost, safeNext, sameOrigin, shortcutConfirmUrl, SiteTokens, SoftLockout, SESSION_HEADER, userScopedFetch, wantsHtml, logSafe, type RequestAuth, type RouteRule, type ShortcutAction } from "./portal-auth.ts"
import { coalesced, caddyGlobalBlock, checkBindings, cloudflaredYaml, dedupeSiteAddresses, isCaddyUpstream, isCredentialsPath, isDnsLabel, isHostName, isIpOrCidr, isQuickTunnelUrl, isTunnelId, isTunnelName, isZoneId, isZoneName, loopbackBind, lowerName, mergeLowerCase, newNameProblem, PROXY_TAG_HEADER, stripProxyHeaders, SYSTEM_BLOCK_MARK, tagDaemonUpstreams } from "./caddy-config.ts"
import { verifyPassword, pamAvailable, checkAccount } from "./pam.ts"
import { isSuperuser, loginUsers } from "./superuser.ts"
import { AppKeyStore, ConsentStore, PendingRequests, issuersFor, type SiteLookup } from "./app-auth.ts"
import { ChallengeStore, PasskeyStore, SUPERUSER_PAM_MS, mayActAsSuperuser, prunePasskeyAccounts, type PasskeyDeps } from "./passkey-store.ts"
import * as webauthn from "./webauthn.ts"
import { formatKeyRing, type JweKey } from "./jwe.ts"
import { createAuthRoutes, type AuthRouteContext } from "./app-auth-routes.ts"
import { CREDENTIAL_NAME as APP_AUTH_CREDENTIAL } from "./sdk-auth.ts"
import { AsyncLocalStorage } from "node:async_hooks"
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
  ttl?: number      // its own idle limit in minutes (default: one hour)
  memory?: number   // its own memory limit in MB (default 2048, at most 16384)
  fn?: FnSettings   // a function (candy-functions): no port, dispatched by the daemon
}

// A route either goes to a port/URL, or to a function the daemon dispatches itself
type RouteTarget = number | string | { fn: string }

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
  logStart?: number  // size of the log file when this run was spawned: a site page's excerpt starts here
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
// Caddy's admin API: a 0600 unix socket owned by Caddy's user, never localhost:2019,
// where any local user could load a config (file_server on /) into a root Caddy
// User mode without XDG_RUNTIME_DIR: a 0700 folder of our own, never a /tmp path
// someone else could create first
const USER_RUN_DIR = process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/candy` : `${CANDY_CONFIG_DIR}/run`
const CADDY_ADMIN_SOCKET = process.getuid?.() === 0
  ? "/run/candy/caddy-admin.sock"
  : `${USER_RUN_DIR}/caddy-admin.sock`
const caddyAdmin = (path: string, init: RequestInit = {}) =>
  fetch(`http://caddy${path}`, { ...init, unix: CADDY_ADMIN_SOCKET } as RequestInit)
const SERVERS_CONFIG = `${CANDY_CONFIG_DIR}/servers.json`
const ROUTES_FILE = `${CANDY_CONFIG_DIR}/routes.json`
const MCP_SECRET_FILE = `${CANDY_CONFIG_DIR}/mcp-secret`
const DOMAINS_CONFIG = `${CANDY_CONFIG_DIR}/domains.json`
const GRUDGE_FILE = `${CANDY_CONFIG_DIR}/candy-grudge.lock`
// As root, logs live in a root-owned dir: /tmp/candy-logs could be pre-created by any user
const LOGS_DIR = process.getuid?.() === 0 ? "/var/log/candy" : "/tmp/candy-logs"
// In a folder of its own: per-name logs are LOGS_DIR/<name>.log, so no name can map to it
const AUDIT_LOG = `${LOGS_DIR}/daemon/audit.log`
const DNS_CONFIG_FILE = `${CANDY_CONFIG_DIR}/candy-dns.json`
const ADVERTISEMENTS_FILE = `${CANDY_CONFIG_DIR}/advertisements.json`
const LAN_FILE = `${CANDY_CONFIG_DIR}/lan.json`
const ADGUARD_FILE = `${CANDY_CONFIG_DIR}/adguard.json`
const MCP_OAUTH_FILE = `${CANDY_CONFIG_DIR}/mcp-oauth.json`
const ENTRIES_FILE = `${CANDY_CONFIG_DIR}/entries.json`
const SERVES_FILE = `${CANDY_CONFIG_DIR}/serves.json`
const ROUTE_USERS_FILE = `${CANDY_CONFIG_DIR}/route-users.json`
// Root-only: ~/.config/candy is handed back to the owner when the daemon stops
const PORTAL_SESSIONS_FILE = process.getuid?.() === 0
  ? "/var/lib/candy-daemon/portal-sessions.json"
  : `${process.env.HOME}/.local/state/candy/portal-sessions.json`
// Sign in with candy (SDK_AUTH_DESIGN.md): per-site key rings, remembered
// approvals, passkeys (public keys only). Root-only files, 0600 in a 0700 folder.
const AUTH_STATE_DIR = process.getuid?.() === 0 ? "/var/lib/candy-daemon" : `${process.env.HOME}/.local/state/candy`
const APP_AUTH_KEYS_FILE = `${AUTH_STATE_DIR}/app-auth-keys.json`
const APP_AUTH_CONSENT_FILE = `${AUTH_STATE_DIR}/app-auth-consent.json`
const PASSKEYS_FILE = `${AUTH_STATE_DIR}/passkeys.json`
// Root mode: what LoadCredential= copies into a sandboxed unit (dir 0700, files 0600, root's)
const APP_AUTH_CRED_DIR = "/run/candy/app-auth"
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
// Anything else is treated like a reserved name and rejected. No leading "_" or ".":
// those are the daemon's own log names (_audit, _caddy, _dns).
// Lower case only: requests are lower-cased on arrival (lowerRequestNames) and
// stored names at load (migrateNames), so "Victim" can't be a second "victim".
const SAFE_NAME = /^[a-z0-9]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/
const isSafeName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= 128 && SAFE_NAME.test(name)
const isReserved = (name: string) => !isSafeName(name) || RESERVED_NAMES.has(name.toLowerCase())
// A name nobody has yet: also not the address of a shortcut or alias host (newNameProblem)
const newNameRefusal = (name: string): string | null => newNameProblem(name, getLocalCandyHostLabel(), RESERVED_NAMES)

// Body fields and query parameters that carry a site name
const NAME_FIELDS = ["name", "oldName", "newName", "serverName", "targets"]
const lowerNameFields = (body: unknown): unknown => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const b = body as Record<string, unknown>
  for (const k of NAME_FIELDS) {
    if (typeof b[k] === "string") b[k] = lowerName(b[k])
    else if (Array.isArray(b[k])) b[k] = (b[k] as unknown[]).map(lowerName)
  }
  return body
}
/** Every control route sees names in lower case, whatever the caller typed. */
const lowerRequestNames = (req: Request, url: URL): void => {
  const json = req.json.bind(req)
  ;(req as any).json = async () => lowerNameFields(await json())
  const name = url.searchParams.get("name")
  if (name !== null && name !== lowerName(name)) url.searchParams.set("name", lowerName(name))
}

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
  owner?: string      // who bound it; bindings from before this get the name's owner at startup
  orphaned?: boolean  // its site was removed; only the owner (or a superuser) may take the name again
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

// Caddy marks what it sends the daemon with this per-boot tag (tagDaemonUpstreams),
// so forwarding headers are believed from Caddy and from nobody else on loopback
const CADDY_PROXY_TAG = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url')
const hasCaddyTag = (req: Request, peer: string): boolean => {
  const tag = req.headers.get(PROXY_TAG_HEADER)
  return isLoopback(peer) && !!tag && tag.length === CADDY_PROXY_TAG.length && timingSafeEqual(Buffer.from(tag), Buffer.from(CADDY_PROXY_TAG))
}
// Decided once per request (markProxyHeaders), before the tag is stripped
const fromOwnCaddy = new WeakSet<Request>()
const viaOwnCaddy = (req: Request, _peer?: string): boolean => fromOwnCaddy.has(req)

// First thing for every request: note whether our Caddy sent it, then strip (stripProxyHeaders)
const markProxyHeaders = (req: Request, peer: string): void => {
  if (hasCaddyTag(req, peer)) fromOwnCaddy.add(req)
  stripProxyHeaders(req.headers, fromOwnCaddy.has(req))
}

/** Headers for a request we pass on to a server: the same as a function gets (fnRequestHeaders: no hop-by-hop, no candy markers or proxy tag, and on a protected domain no candy credentials). */
const upstreamRequestHeaders = (src: Headers, protectedDomain: boolean): Headers =>
  fnRequestHeaders(src, { stripCredentials: protectedDomain })

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']

// Get fingerprint key from request
const getFingerprint = (req: Request, server: any): { ip: string; userAgent: string } => {
  const peer = normalizeIp(server.requestIP(req)?.address || 'unknown')
  // X-Forwarded-For / Cf-Connecting-Ip only from our own Caddy (see clientIp):
  // a local process talking to :9999 directly can't pick its address
  const ip = clientIp({
    peer,
    viaCaddy: viaOwnCaddy(req, peer),
    xff: req.headers.get('x-forwarded-for'),
    cf: req.headers.get('cf-connecting-ip'),
    isLoopback,
    normalize: normalizeIp,
  })
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

// Undo one recordAuthFailure: a portal login counts the attempt before PAM
// answers, and gives it back when PAM never gave a verdict
const refundAuthFailure = async (key: string) => {
  await withAuthFailureLock(async () => {
    await loadAuthFailures('sync')
    const state = authFailures.get(key)
    if (!state) return
    if (state.count >= 3 && state.fibIndex > 0) state.fibIndex--
    state.count--
    if (state.count <= 0) authFailures.delete(key)
    else if (state.count < 3) state.blockedUntil = 0
    await saveAuthFailures()
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
      let lowered = false
      for (const [key, b] of Object.entries(domainConfig.bindings ?? {})) {
        if (!b || typeof b.serverName !== "string" || b.serverName === lowerName(b.serverName)) continue
        auditLog('NAME_LOWERCASED', `domain ${JSON.stringify(key)}: site ${JSON.stringify(b.serverName)} is now ${lowerName(b.serverName)}`, 'System')
        b.serverName = lowerName(b.serverName)
        lowered = true
      }
      if (dropInvalidBindings() || lowered) await saveDomainConfig()
      const count = Object.keys(domainConfig.bindings || {}).length
      console.log(`\x1b[90mLoaded domain config: ${domainConfig.zone?.domain || '(no zone)'} with ${count} bindings\x1b[0m`)
      return domainConfig
    }
  } catch (e) {
    console.log(`\x1b[33mNo domain config found or invalid format\x1b[0m`)
  }
  return null
}

// The bindings that are safe to write into Caddy and cloudflared (checkBindings)
const safeBindings = (): Record<string, DomainBinding> =>
  domainConfig ? checkBindings(domainConfig.bindings, domainConfig.zone?.domain ?? "", isSafeName).kept : {}

// Drops bindings that could inject into the Caddyfile or cloudflared's config
// (from an older candy, or a hand-edited file), each with an audit line
const dropInvalidBindings = (): boolean => {
  if (!domainConfig?.bindings) return false
  const { kept, dropped } = checkBindings(domainConfig.bindings, domainConfig.zone?.domain ?? "", isSafeName)
  for (const d of dropped) auditLog('DOMAIN_BINDING_DROPPED', `${JSON.stringify(d.key)}: ${d.why}`, 'System')
  if (dropped.length) domainConfig.bindings = kept
  return dropped.length > 0
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
    if (mcpOAuth.legacyRevoked > 0) {
      auditLog('MCP_PUBLIC_REVOKE', `${mcpOAuth.legacyRevoked} approval(s) from before portal login carried no user and were revoked; those clients must sign in again`, 'System')
    }
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
    let token = bearer ? oauth.verifyAccessToken(bearer) : null
    // Someone who can no longer log in to the portal loses their clients too
    if (token && !(await loginUsers().catch(() => [] as string[])).includes(token.user)) token = null
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
        auditLog('MCP_PUBLIC_CALL', `${item.params?.name ?? '?'} as ${token.user} by "${token.clientName}" (approved by ${token.approver ?? 'unknown'})`, 'AI')
      }
      // The public host gets a subset: no request logs, replay, KV or D1.
      // Its calls act as the user who approved the client, never as a superuser.
      const reply = await publicMcpUser.run(token.user, () => handlePublicMcpRequest(item))
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

  // Only checked values reach the YAML (cloudflaredYaml drops bad hostnames)
  const hostnames = Object.values(safeBindings()).map(b => b.fqdn)
  const mcpFqdn = publicMcpFqdn()
  if (mcpFqdn) hostnames.push(mcpFqdn)
  const yaml = cloudflaredYaml(domainConfig.tunnel, hostnames)
  if (!yaml) {
    console.log(`\x1b[31mThe tunnel id or credentials file isn't valid; cloudflared's config was left as it was.\x1b[0m`)
    return
  }

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

const routes = new Map<string, { target: RouteTarget, persistent: boolean }>()

// Where a bound public domain sends its traffic. A site candy starts itself goes to its
// running process (or to the daemon, which starts it). A plain route goes straight to
// its port or external URL.
const bindingUpstream = (serverName: string): string | null => {
  if (fnConfigOf(serverName)) return null  // functions are always served by the daemon
  const managed = processes.get(serverName)
  if (managed?.status === 'running' && managed.port) return `localhost:${managed.port}`
  if (managed || serverConfigs.has(serverName)) return null
  const route = routes.get(serverName)
  if (!route || typeof route.target === "object") return null
  const target = String(route.target)
  return /^\d+$/.test(target) ? `localhost:${target}` : target
}

// Caddy needs the upstream's own Host header for an https URL target
const UPSTREAM_KEEPALIVE = "5s"
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

// Portal logins, and the per-page CANDY_TOKEN chains (CSRF tokens) tied to them
const portalSessions = new PortalSessions(PORTAL_SESSIONS_FILE)
const pageTokens = new PageTokens()
// Start/restart tokens for a site's own pages (starting, crashed), per page load
const siteTokens = new SiteTokens()
// Sign in with candy: site key rings, remembered approvals, parked requests.
// Passkeys: credentials and their single-use challenges.
const appKeys = new AppKeyStore(APP_AUTH_KEYS_FILE)
const appConsents = new ConsentStore(APP_AUTH_CONSENT_FILE)
const appPending = new PendingRequests()
const passkeys = new PasskeyStore(PASSKEYS_FILE)
const passkeyChallenges = new ChallengeStore()
setInterval(() => {
  portalSessions.sweep()
  pageTokens.sweep(id => portalSessions.alive(id))
  siteTokens.sweep()
  appPending.sweep()
  passkeyChallenges.sweep()
}, 10 * 60 * 1000)

// Auto-kill idle servers (1hr no activity, no portal). Activity is:
// - a finished request in Caddy's access log, for *.localhost, *.candy and bound domains
// - any open TCP connection to the server's port (SSE, WebSockets and other
//   long-lived streams never produce a log line while they stay open)
// - requests the daemon proxies itself
// A server that told candy it is idling (SDK setIdling) is kept past the timeout
// unless memory is tight (>= 80% used, or high PSI memory pressure).
const IDLE_TIMEOUT = IDLE_TIMEOUT_MS
const ACTIVITY_SAMPLE_INTERVAL = 30 * 1000
const IDLE_CHECK_INTERVAL = 30 * 1000  // short, so per-server limits of a few minutes are kept
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
    // The server's own idle limit, if it has one (candy ttl)
    const timeoutMs = proc.config.ttl ? proc.config.ttl * 60 * 1000 : IDLE_TIMEOUT
    if (now - proc.lastActivity <= timeoutMs) continue
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
      timeoutMs,
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
  const oauthKey = oauthKeys.get(user)
  if (oauthKey) { oauthKeys.delete(user); oauthKeyUsers.delete(oauthKey) }
  if (portalSessions.destroyUser(user) > 0) auditLog('AUTH_LOGOUT', `${user}: every portal session ended (left the ${SHARED_GROUP} group)`, 'System')
  // Their app approvals and passkeys go too: whoever gets the name or the
  // group membership next starts from nothing
  appConsents.dropUser(user)
  const n = passkeys.dropAccount(user)
  if (n > 0) auditLog('PASSKEY_DROP', `${user}: ${n} passkey(s) removed (left the ${SHARED_GROUP} group)`, 'System')
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

// API keys for the public MCP endpoint, one per user who approved a client.
// They never leave this process: userScopedFetch puts them on mcp.ts's calls.
const oauthKeys = new Map<string, string>()      // user -> key
const oauthKeyUsers = new Map<string, string>()  // key -> user
const oauthKeyFor = (user: string): string => {
  let key = oauthKeys.get(user)
  if (!key) {
    key = `oauth_${crypto.randomUUID()}`
    oauthKeys.set(user, key)
    oauthKeyUsers.set(key, user)
  }
  return key
}

// The portal's own hosts: portal.localhost, portal.candy (and its tailnet alias).
// Login cookies are only read here; on localhost:<port> they'd reach every local server.
// Only the default port: browsers don't scope cookies by port, and portal.localhost:5555
// is someone else's server, never the portal.
const isPortalHost = (host: string | null | undefined): boolean => {
  const raw = (host || "").toLowerCase()
  const port = raw.match(/:(\d+)$/)?.[1]
  if (port !== undefined && port !== "443") return false
  const h = raw.replace(/:\d+$/, "")
  if (!h.endsWith(".localhost") && !h.endsWith(".candy")) return false
  return resolveLocalCandyDomain(h) === "portal" && !resolveBindingFromHost(h)
}

// Our Caddy sets X-Forwarded-Host to the host it was asked for (non-Caddy
// callers have it stripped, markProxyHeaders). When that isn't the portal,
// the request reached Caddy as another site (a bound domain whose upstream is
// the portal, say) and must not be treated as the portal.
const isPortalRequest = (req: Request): boolean => {
  const host = req.headers.get("host")
  if (!isPortalHost(host)) return false
  const forwarded = req.headers.get("x-forwarded-host")
  if (!forwarded) return true
  const norm = (h: string) => h.trim().toLowerCase().replace(/:443$/, "")
  return norm(forwarded.split(",")[0]) === norm(host || "")
}

// Who a request acts as, or null. API keys (CLI, SDK, local MCP) and public
// MCP tokens are always user-scoped; superuser exists only in a portal login,
// and is recomputed per request (60s cache) so losing sudo takes effect.
const requestAuth = async (req: Request): Promise<RequestAuth | null> => {
  const key = req.headers.get("X-Candy-API-Key")
  if (key) {
    const user = mcpApiKeys.get(key)
    if (user) return { user, superuser: false, via: "apikey" }
    const viaOauth = oauthKeyUsers.get(key)
    if (viaOauth) return { user: viaOauth, superuser: false, via: "oauth" }
    return null
  }
  if (!isPortalRequest(req)) return null
  // The cookie alone never authenticates: other ports on this host get it too.
  // The session secret lives in the portal origin's localStorage and comes as a header.
  const session = portalSessions.get(readSessionCookie(req.headers.get("cookie")), req.headers.get(SESSION_HEADER))
  if (!session) return null
  // A removed, nologin, locked or expired account loses its logins on its next request
  const eligible = await eligibleLoginUsers().catch(() => null)
  if (!eligible) return null
  if (!eligible.includes(session.user)) {
    const n = portalSessions.destroyUser(session.user)
    pageTokens.dropSession(session.id)
    appConsents.dropUser(session.user)
    auditLog('AUTH_REVOKED', `${session.user}: can't log in any more, ${n} login(s) ended`, 'System')
    return null
  }
  // A sudoer's passkey session is a superuser only after re-entering the
  // password (/auth/reauth): root-level actions never rest on a passkey alone
  const sudoer = await isSuperuser(session.user).catch(() => false)
  const stepped = mayActAsSuperuser(session, Date.now())
  return {
    user: session.user, superuser: sudoer && stepped, via: "portal", sessionId: session.id,
    amr: session.amr, pamAt: session.pamAt, sessionCreated: session.created,
    ...(sudoer && !stepped ? { superuserNeedsPassword: true } : {}),
  }
}
// When a passkey session's superuser step-up (/auth/reauth) runs out, for the
// portal to ask again then; null when it doesn't (a password login, or none yet)
const superuserUntil = (auth: RequestAuth): number | null =>
  auth.superuser && auth.amr === "passkey" && typeof auth.pamAt === "number" ? auth.pamAt + SUPERUSER_PAM_MS : null
// Who may log in, cached for a minute: checked on every portal request
const eligibleLoginUsers = cachedList(() => loginUsers(), 60 * 1000)

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

// Changing or removing a config is limited to the user it runs as, or a superuser
const mayChangeConfig = (auth: RequestAuth | null, config: ServerConfig): boolean =>
  mayActOn(auth, configUser(config))

// Who a name belongs to: its config's user, else whoever registered the route.
// Routes from before ownership was tracked belong to the owner.
const routeUsers = new Map<string, string>()
const nameOwner = (name: string): string => {
  const cfg = getConfigsForName(name)[0]
  if (cfg) return configUser(cfg)
  return routeUsers.get(name) ?? OWNER
}
const mayChangeName = (auth: RequestAuth | null, name: string): boolean => mayActOn(auth, nameOwner(name))
const nameInUse = (name: string): boolean => routes.has(name) || serverConfigs.has(name) || processes.has(name)

const loadRouteUsers = async () => {
  try {
    const data = await Bun.file(ROUTE_USERS_FILE).json() as Record<string, unknown>
    for (const [name, user] of Object.entries(data)) if (typeof user === "string") routeUsers.set(name, user)
    const changed = lowerCaseNames("route owner", routeUsers)
    for (const name of [...routeUsers.keys()]) if (!isSafeName(name)) routeUsers.delete(name)
    if (changed) await saveRouteUsers()
  } catch {}
}

// Names from before they were lower case: lower-cased where they're stored.
// Two spellings of one name: the first in the file stays, the others go (audited).
const lowerCaseNames = <V>(what: string, map: Map<string, V>): boolean => {
  const { kept, dropped, renamed } = mergeLowerCase(map)
  if (!dropped.length && !renamed.length) return false
  map.clear()
  for (const [k, v] of kept) map.set(k, v)
  for (const [from, to] of renamed) auditLog('NAME_LOWERCASED', `${what} ${JSON.stringify(from)} is now ${to}`, 'System')
  for (const name of dropped) auditLog('NAME_DROPPED', `${what} ${JSON.stringify(name)}: another spelling of ${lowerName(name)} came first`, 'System')
  return true
}
const saveRouteUsers = async () => {
  await $`mkdir -p ${CANDY_CONFIG_DIR}`.quiet().nothrow()
  await Bun.write(ROUTE_USERS_FILE, JSON.stringify(Object.fromEntries(routeUsers), null, 2))
}
const setRouteUser = async (name: string, user: string | null) => {
  if (user === null || user === OWNER) {
    if (!routeUsers.delete(name)) return
  } else if (routeUsers.get(name) === user) return
  else routeUsers.set(name, user)
  await saveRouteUsers()
}

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

// Activity log (in-memory for API responses)
// `name` is the site an entry is about: users see only entries about their own sites
const activityLog: { time: Date, action: string, details: string, name?: string }[] = []
const log = (action: string, details: string, name?: string) => {
  activityLog.push({ time: new Date(), action, details, name })
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
  // The audit log's own folder (readLogs maps _caddy to the access log directly, no symlink in the name space)
  await $`mkdir -p ${dirname(AUDIT_LOG)}`.quiet().nothrow()
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
// 'System', 'Network', 'Page' for the daemon's own doings; otherwise auditActor(): "<user>:<label>"
type Actor = string

// Write to audit log with actor tracking. Every field is made one line
// (auditSafe), so nothing a caller sends can start a forged entry.
const auditLog = async (action: string, details: string, actor: Actor = 'System') => {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] [${auditSafe(actor)}] ${auditSafe(action)}: ${auditSafe(details)}\n`
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
const getLogFile = (name: string) => `${LOGS_DIR}/${name.replace(/[^\w.-]/g, '_').replace(/^[._]+/, '-')}.log`

// The daemon's own logs, by the names the API uses for them
const SYSTEM_LOGS: Record<string, string> = { _audit: AUDIT_LOG, _caddy: CADDY_LOG }
// The file a log name reads, or null. A site's name must be a valid one whose
// file is exactly <name>.log, so no other spelling reaches a system log.
const logFileFor = (name: string): { file: string; system: boolean } | null => {
  if (Object.hasOwn(SYSTEM_LOGS, name)) return { file: SYSTEM_LOGS[name], system: true }
  if (!isSafeName(name)) return null
  const file = getLogFile(name)
  return file === `${LOGS_DIR}/${name}.log` ? { file, system: false } : null
}

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
  const target = logFileFor(processName)
  if (!target) return { success: false, error: `Log file not found: ${processName}` }
  const logFile = target.file

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
          const rawTtl = (item as any).ttl
          const ttl = validateTtlMinutes(typeof rawTtl === "object" && rawTtl ? rawTtl.idleMin : rawTtl)
          if (ttl) cfg.ttl = ttl
          const memory = validateMemoryMb((item as any).memory)
          if (memory) cfg.memory = memory
          const envFile = validateEnvFilePath((item as any).envFile)
          if (envFile) cfg.envFile = envFile
          if (Array.isArray((item as any).cron)) {
            const jobs = (item as any).cron.map(validateCronJob).filter((v: any) => v.ok).map((v: any) => v.job as CronJob)
            if (jobs.length > 0) cfg.cron = jobs.slice(0, MAX_CRON_JOBS)
          }
          if ((item as any).fn !== undefined) {
            const fn = normalizeFnSettings((item as any).fn)
            if (!fn) continue  // a broken fn entry must not turn into a plain server
            cfg.fn = fn
            cfg.api = true  // functions are API mode: no loading page, requests are held
          }
          normalized.push(cfg)
        }
        if (normalized.length > 0) {
          serverConfigs.set(name, normalized)
        }
      }
      const before = new Set(serverConfigs.keys())
      if (lowerCaseNames("site", serverConfigs)) {
        // A site's state folder and request log are named after it: they move with the name
        for (const from of before) {
          const to = lowerName(from)
          if (to === from || !serverConfigs.has(to) || before.has(to)) continue
          for (const [a, b] of [[fnStateDir(from), fnStateDir(to)], [fnLogPath(from), fnLogPath(to)]]) {
            if (existsSync(a) && !existsSync(b)) await rename(a, b).catch(e => console.log(`\x1b[33mCouldn't move ${a} to ${b}: ${e}\x1b[0m`))
          }
        }
        await saveServerConfigs()
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
  auditLog('CONFIG_ADD', `${name}: ${JSON.stringify(cmd)} in ${JSON.stringify(expandedCwd)}${RUNNING_AS_ROOT ? ` as ${user}` : ''}`, actor)
}

// Remove a server config
const removeServerConfig = async (name: string, actor: Actor = 'Portal', configId?: string) => {
  // A function: stop its instances, close its socket and log, drop its route
  const fnConfig = fnConfigOf(name)
  if (fnConfig && (!configId || fnConfig.id === configId)) {
    await teardownFn(name)
    await removeFnLogFiles(name)
    if (typeof routes.get(name)?.target === "object") routes.delete(name)
  }
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
  if (!nameInUse(name)) await dropAppAuth(name, actor)
  if (await forgetLanPublishedIfGone(name) || fnConfig) await syncCaddy()
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
    // keepalive: false closes the upstream connection when the response ends.
    // A pooled idle connection would look like activity to the idle check.
    const res = await fetch(target, { ...init, keepalive: false, signal: AbortSignal.any([req.signal, headerTimeout.signal]) })
    try { controlServer.timeout(req, 0) } catch {}
    return res
  } finally {
    clearTimeout(timer)
  }
}

// How long a request for a stopped API-mode server waits for it to come up
const API_START_HOLD = apiHoldSeconds(process.env.CANDY_API_HOLD_SECONDS) * 1000

const portListening = (port: number): Promise<boolean> => new Promise(resolve => {
  let settled = false
  const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
  const timer = setTimeout(() => done(false), 1000)
  Bun.connect({
    hostname: 'localhost',
    port,
    socket: {
      open(socket) { clearTimeout(timer); socket.end(); done(true) },
      data() {},
      error() { clearTimeout(timer); done(false) },
      connectError() { clearTimeout(timer); done(false) },
    },
  }).catch(() => { clearTimeout(timer); done(false) })
})

// The whole machine's CPU, memory, disks and processes, for the portal's superuser view
const systemMonitor = new SystemMonitor()

// Every request for an API-mode server's host: held while it starts, then forwarded (api-mode.ts)
const apiModeGate = createApiModeGate<ServerConfig, DomainBinding>({
  isPortal: req => isPortalRequest(req),
  binding: host => resolveBindingFromHost(host),
  localName: host => resolveLocalCandyDomain(host),
  config: name => apiModeConfig(name),
  isProtected: binding => hasBindingAuth(binding),
  authorize: (req, binding) => requireBoundDomainAuth(req, controlServer, binding),
  process: name => processes.get(name),
  start: (name, configId) => spawnProcess(name, 'Network', configId),
  upstreamHeaders: (src, protectedDomain) => upstreamRequestHeaders(src, protectedDomain),
  fetchUpstream: (target, init, req) => fetchWithHeaderTimeout(target, init, req),
  listening: portListening,
  holdOpen: req => { try { controlServer.timeout(req, 0) } catch {} },  // the default 10s idle limit is shorter than a start
  holdMs: API_START_HOLD,
})

// ============================================================================
// Sign in with candy: per-site key rings (SDK_AUTH_DESIGN.md, F)
// ============================================================================

// Portal hosts tokens may come from (the SDK's issuers), and where apps send users
const appAuthPortalHosts = (): string[] => {
  const label = getLocalCandyHostLabel()
  return ["portal.localhost", "portal.candy", ...(label ? [`portal.${label}.candy`] : [])]
}
const appAuthPortalUrl = (): string => tailscaleIp ? "https://portal.candy" : "https://portal.localhost"
const appAuthCredentialPath = (name: string): string => `${APP_AUTH_CRED_DIR}/${fnFileName(name)}.keys`

// The site's ring for its current owner. A ring left by someone who used the
// name before is replaced, and approvals given to them go with it.
const appAuthRing = (site: string, owner: string, actor: Actor = 'System'): JweKey[] => {
  const { ring, replaced } = appKeys.ensure(site, owner)
  if (replaced) {
    const n = appConsents.dropSite(site)
    auditLog('APP_AUTH_RESET', `${site}: now run by ${owner}, new key, ${n} approval(s) dropped`, actor)
  }
  return ring
}

// What a launch of `name` gets: env for the SDK, and the ring (kept apart from env)
const appAuthLaunch = (name: string, owner: string): { env: Record<string, string>; keys: string } | null => {
  try {
    const ring = appAuthRing(name, owner)
    return {
      env: { CANDY_AUTH_SITE: name, CANDY_AUTH_URL: appAuthPortalUrl(), CANDY_AUTH_ISSUERS: issuersFor(appAuthPortalHosts()).join(",") },
      keys: formatKeyRing(ring),
    }
  } catch (e) {
    console.error(`\x1b[33mNo candy auth key for ${name}: ${(e as Error).message}\x1b[0m`)
    return null
  }
}

// The LoadCredential= source for a sandboxed unit: root's, 0600, in a 0700
// folder, written atomically. null (no credential) if it can't be written.
const writeAppAuthCredential = async (name: string, keys: string): Promise<string | null> => {
  if (!RUNNING_AS_ROOT) return null
  const path = appAuthCredentialPath(name)
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await mkdir(APP_AUTH_CRED_DIR, { recursive: true, mode: 0o700 })
    await chmod(APP_AUTH_CRED_DIR, 0o700)
    await writeFile(tmp, keys, { mode: 0o600, flag: 'wx' })
    await chmod(tmp, 0o600)
    await rename(tmp, path)
    return path
  } catch (e) {
    await unlink(tmp).catch(() => {})
    console.error(`\x1b[33mCould not write the auth key credential for ${name}: ${(e as Error).message}\x1b[0m`)
    return null
  }
}

// A ring changed (rotated, or replaced for a new owner): rewrite the
// credential file, restart a function's instances (they read it at start).
// Returns the running servers that still hold the old ring.
const appAuthKeysChanged = async (site: string, ring: JweKey[]): Promise<string[]> => {
  if (RUNNING_AS_ROOT && existsSync(appAuthCredentialPath(site))) await writeAppAuthCredential(site, formatKeyRing(ring))
  if (fnConfigOf(site)) {
    await restartFn(site).catch(e => auditLog('FN_RESTART_FAIL', `${site}: ${fnErrorText(e)}`, 'System'))
    return []
  }
  const proc = processes.get(site)
  return proc && (proc.status === 'running' || proc.status === 'starting') ? [site] : []
}

// The name is gone: its keys, approvals and credential file go too, so
// whoever uses the name next starts from nothing
const dropAppAuth = async (name: string, actor: Actor = 'System') => {
  const hadKeys = appKeys.drop(name)
  const n = appConsents.dropSite(name)
  await unlink(appAuthCredentialPath(name)).catch(() => {})
  if (hadKeys || n) auditLog('APP_AUTH_DROP', `${name}: key and ${n} approval(s) removed`, actor)
}

// How to run a config. As root, drop to the config's user with setpriv and
// cd as that user (so a cwd they couldn't reach on their own fails).
// A cron run passes `cron`: its args reach the command as "$@" (positional
// parameters), never as shell text, so they can't add commands.
// A function launch (`fnInstance` for one that dials in; a cron run passes
// `cron`) runs `bun <shim> <entry> [--scheduled <expr>]`, all of it as argv:
// the script is just `exec "$@"`.
const launchSpec = async (config: ServerConfig, cron?: { job: string; args: string[] }, name = '', fnInstance?: FnInstanceLaunch): Promise<{ cmd: string[]; cwd: string; env: Record<string, string | undefined>; unit: string | null }> => {
  const extra: Record<string, string> = cron
    ? { TERM: 'dumb', [CRON_JOB_ENV]: cron.job }
    : { FORCE_COLOR: '1', TERM: 'xterm-256color', [CANDY_RUNTIME_MAGIC_ENV]: config.id }
  if (config.envFile) {
    const problem = await envFileProblem(configUser(config), config.envFile)
    if (problem) throw new Error(`Refusing to start: ${problem}`)
  }
  const fn = config.fn ? await fnLaunchParts(name, config, cron, fnInstance) : null
  if (fn) Object.assign(extra, fn.env, { TERM: 'dumb' })
  // Sign in with candy: the site's name, portal and issuers for servers and
  // function instances (never cron runs). The key ring itself never goes into
  // `extra`: sandboxed units get it as a credential file, others in the spawn env.
  const appAuth = !cron && name ? appAuthLaunch(name, configUser(config)) : null
  if (appAuth) Object.assign(extra, appAuth.env)
  const authKeysEnv: Record<string, string> = appAuth ? { CANDY_AUTH_KEYS: appAuth.keys } : {}
  const script = fn ? fn.script : cron ? cronScript(config.cmd) : config.cmd
  const args = fn ? ['candy', ...fn.args] : cron ? ['candy', ...cron.args] : []
  let fileEnv: Record<string, string> = {}
  // Sandboxed launches let systemd read the file; the others get it merged here
  if (config.envFile && !(SANDBOX_AVAILABLE && config.sandbox !== false && name)) {
    fileEnv = parseEnvFile(await readFnEnvFile(config))
  }
  if (!RUNNING_AS_ROOT) {
    return { cmd: ['bash', fn ? '-c' : '-ic', script, ...args], cwd: config.cwd, env: { ...process.env, ...fileEnv, ...extra, ...authKeysEnv }, unit: null }
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
    const unit = unitName(name, cron ? 'cron' : fn ? 'fn' : 'srv')
    const credential = appAuth ? await writeAppAuthCredential(name, appAuth.keys) : null
    return {
      cmd: systemdRunCommand({
        name,
        unit,
        uid: account.uid,
        gid: account.gid,
        cwd: config.cwd,
        codeDir: findCodeDir(config.cwd, account.home, dir => existsSync(`${dir}/.git`)),
        extraRw: config.rw,
        memoryMb: config.memory,
        envFile: config.envFile,
        env,
        script,
        args: fn ? fn.args : cron?.args,
        mode: cron || fn ? 'pipe' : 'pty',
        bindsTo: OWN_UNIT,
        fn: fn ? { socket: fn.socket } : null,
        credentials: credential ? [{ name: APP_AUTH_CREDENTIAL, path: credential }] : undefined,
        description: fn ? (cron ? 'function cron run' : 'function') : undefined,
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
    env: { ...env, ...fileEnv, ...extra, ...authKeysEnv },
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

// ============================================================================
// Functions (candy-functions, see FUNCTIONS_DESIGN.md)
// ============================================================================
// A function never listens anywhere. Caddy sends its hosts here, the daemon
// owns a unix socket per function that instances dial in on, and FnRuntime
// (pool + dispatch) serves each request. Instances are launched through
// launchSpec like any server (sandboxed and as the config's user in root
// mode). Anything touching the function's own files (project config, deploy
// bundles, KV/D1 from the API) runs as that user through fn-tool.ts.

interface FnInstanceLaunch { id: string; token: string; socketPath: string }

const FN_KEEP_DEPLOYS = 10
const FN_ROOT_MODULE_DIR = "/usr/lib/candy"
const FN_TOOL_TIMEOUT_MS = 120 * 1000
// fn-tool prints one JSON line; anything near this is a runaway (or hostile) process
const FN_TOOL_MAX_OUTPUT = 8 * 1024 * 1024
// Cloudflare cuts a request with no response after 100s; do the same
const FN_HEADER_TIMEOUT_MS = 100 * 1000
const FN_LOG_SWEEP_INTERVAL = 60 * 60 * 1000
const FN_SOCKET_DIR = RUNNING_AS_ROOT ? "/run/candy/fn" : `${USER_RUN_DIR}/fn`
const FN_LOG_DIR = RUNNING_AS_ROOT ? "/var/lib/candy-daemon/fn-log" : `${process.env.HOME}/.local/state/candy/fn-log`

const fnStateDir = (name: string): string =>
  RUNNING_AS_ROOT ? stateDirPath(name) : `${process.env.HOME}/.local/state/candy/fn/${fnFileName(name)}`
const fnSocketPath = (name: string): string => fnSocketPathIn(FN_SOCKET_DIR, name)
const fnLogPath = (name: string): string => `${FN_LOG_DIR}/${fnFileName(name)}.sqlite`
// Where the shim and its sibling modules live: installed copies in root mode
// (readable by every user), this checkout otherwise
const fnModuleDir = (): string =>
  RUNNING_AS_ROOT && existsSync(`${FN_ROOT_MODULE_DIR}/fn-host.ts`) ? FN_ROOT_MODULE_DIR : import.meta.dir

const fnConfigOf = (name: string): ServerConfig | null => getConfigsForName(name).find(c => c.fn) ?? null

// A bun the function's user can't swap: fn-tool's output is trusted only as
// far as checkToolResult goes, but root should not run the user's binary at all
const FN_TOOL_BUN = pinnedBun(process.execPath, ['/opt/bun/bin/bun', '/usr/local/bin/bun', '/usr/bin/bun'], existsSync)

// Reads a child's stream up to `max` bytes; past that it is killed
const readCapped = async (stream: ReadableStream<Uint8Array>, max: number, onOverflow: () => void): Promise<string> => {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > max) {
      onOverflow()
      throw new Error(`output larger than ${max} bytes`)
    }
    parts.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

// Run one fn-tool op as the config's user. In user mode the daemon is that user already.
// Either way the result is checked (deploy ids, no control characters) before use.
const fnTool = async <T>(config: Pick<ServerConfig, "user">, op: FnToolOp, args: Record<string, unknown>): Promise<T> => {
  if (!RUNNING_AS_ROOT) return checkToolResult(op, await runFnTool(op, args), args) as T
  const account = await lookupUser(configUser(config as ServerConfig))
  if (!account || account.uid === 0) throw new Error(`'${configUser(config as ServerConfig)}' is not a usable non-root account`)
  const proc = spawn({
    cmd: fnToolCommand({
      account, op, moduleDir: fnModuleDir(),
      // No system bun: fall back to the user's own (output is still checked)
      bun: FN_TOOL_BUN ?? 'bun',
      path: FN_TOOL_BUN ? undefined : `${account.home}/.bun/bin:${account.home}/.local/bin:/opt/bun/bin:/usr/local/bin:/usr/bin:/bin`,
    }),
    cwd: '/',
    stdin: new Blob([JSON.stringify(args)]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const kill = () => { try { proc.kill('SIGKILL') } catch {} }
  const timer = setTimeout(kill, FN_TOOL_TIMEOUT_MS)
  let out: string, err: string
  try {
    [out, err] = await Promise.all([
      readCapped(proc.stdout, FN_TOOL_MAX_OUTPUT, kill),
      readCapped(proc.stderr, 64 * 1024, kill).catch(() => ''),
      proc.exited,
    ])
  } catch (e) {
    kill()
    throw new Error(`fn-tool ${op} failed: ${fnErrorText(e)}`)
  } finally {
    clearTimeout(timer)
  }
  const last = out.trim().split("\n").pop() ?? ""
  let parsed: { ok?: boolean; result?: unknown; error?: string } | null = null
  try { parsed = JSON.parse(last) } catch {}
  const clean = (t: string) => t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, 2000)
  if (!parsed) throw new Error(`fn-tool ${op} failed: ${clean(err.trim() || out.trim() || "no output")}`)
  if (!parsed.ok) throw new Error(clean(typeof parsed.error === 'string' && parsed.error ? parsed.error : `fn-tool ${op} failed`))
  return checkToolResult(op, parsed.result, args) as T
}

// Why the state folder can't be handed to `uid`, or null. A folder still
// owned by another user holds their KV/D1 data and snapshots (a removed
// function of theirs); it is never given away.
const fnStateDirProblem = async (name: string, uid: number): Promise<string | null> => {
  if (!RUNNING_AS_ROOT) return null
  const info = await lstat(fnStateDir(name)).catch(() => null)
  if (!info) return null
  if (info.isSymbolicLink() || !info.isDirectory()) return `${fnStateDir(name)} is not a folder`
  if (info.uid !== 0 && info.uid !== uid) return `${fnStateDir(name)} still holds another user's data for '${name}'. Pick another name, or have root remove that folder.`
  return null
}

// The function's state folder must exist (and be the user's) before a tool
// or an instance touches it. /var/lib/candy is root's, so users can't plant
// anything there; a symlink is refused anyway. deploys/ is made here too, so
// the sandbox can always mount it read-only (code can't plant snapshots).
const ensureFnStateDir = async (name: string, config: ServerConfig): Promise<string> => {
  const dir = fnStateDir(name)
  if (!RUNNING_AS_ROOT) {
    await mkdir(`${dir}/deploys`, { recursive: true, mode: 0o700 })
    return dir
  }
  const account = await lookupUser(configUser(config))
  if (!account || account.uid === 0) throw new Error(`'${configUser(config)}' is not a usable non-root account`)
  await mkdir(STATE_ROOT, { recursive: true, mode: 0o755 })
  const problem = await fnStateDirProblem(name, account.uid)
  if (problem) throw new Error(problem)
  let info = await lstat(dir).catch(() => null)
  if (!info) {
    await mkdir(dir, { mode: 0o700 })
    info = await lstat(dir)
  }
  if (info.uid !== account.uid || info.gid !== account.gid) await chown(dir, account.uid, account.gid)
  // The folder is the user's now: only a deploys/ we just made is chowned, and
  // lchown never follows a symlink they could swap in
  const made = await mkdir(`${dir}/deploys`, { mode: 0o755 }).then(() => true, () => false)
  if (made) await lchown(`${dir}/deploys`, account.uid, account.gid)
  return dir
}

// Env file key names (the values reach the shim through systemd or launchSpec).
// Root reads only files under /etc/candy/env/<user>; anything else is read
// as the user, so a path swapped for a symlink can't expose root's files.
const readFnEnvFile = async (config: ServerConfig): Promise<string> => {
  if (!config.envFile) return ''
  const user = configUser(config)
  const dir = userEnvDir(user)
  if (!RUNNING_AS_ROOT || (config.envFile.startsWith(dir + '/') && !config.envFile.slice(dir.length + 1).includes('/'))) {
    return await Bun.file(config.envFile).text().catch(() => '')
  }
  const account = await lookupUser(user)
  if (!account || account.uid === 0) return ''
  const res = await $`setpriv --reuid=${account.uid} --regid=${account.gid} --init-groups -- head -c 262144 -- ${config.envFile}`.quiet().nothrow()
  return res.exitCode === 0 ? res.stdout.toString() : ''
}

// Project config (candy.fn.json / wrangler.*), read as the user and cached
// until one of those files changes
const fnProjects = new Map<string, { cfg: FnProjectConfig; stamp: string; cwd: string; entry: string | null }>()
const fnConfigStamp = async (dir: string): Promise<string> =>
  (await Promise.all(FN_CONFIG_FILES.map(f => stat(`${dir}/${f}`).then(s => `${f}:${s.mtimeMs}:${s.size}`, () => "")))).join("|")

const fnProject = async (name: string, config: ServerConfig, force = false): Promise<FnProjectConfig> => {
  const stamp = await fnConfigStamp(config.cwd)
  const cached = fnProjects.get(name)
  if (cached && !force && cached.stamp === stamp && cached.cwd === config.cwd && cached.entry === config.fn!.entry) return cached.cfg
  // An assets-only function has no explicit entry: the project file decides
  const cfg = await fnTool<FnProjectConfig>(config, 'config', { dir: config.cwd, entry: config.fn!.entry ?? undefined })
  fnProjects.set(name, { cfg, stamp, cwd: config.cwd, entry: config.fn!.entry })
  return cfg
}

// Cron triggers become ordinary cron jobs; their args are fixed by candy
const syncFnCron = (config: ServerConfig, project: FnProjectConfig) => {
  // fn-tool refuses this first; an assets-only function has nothing to run on a schedule
  if (!project.main && project.crons.length > 0) throw new Error("cron triggers need a main module: an assets-only function never runs code")
  const jobs = cronJobsFor(project)
  if (jobs.length > 0) config.cron = jobs
  else delete config.cron
}

const fnLaunchParts = async (name: string, config: ServerConfig, cron?: { job: string; args: string[] }, instance?: FnInstanceLaunch) => {
  const fn = config.fn!
  if (!name) throw new Error("a function launch needs its name")
  const project = await fnProject(name, config)
  const stateDir = await ensureFnStateDir(name, config)
  const routing = await fnRoutingFor(name, config)
  // Assets-only functions are served by the daemon alone: no instance, no cron run
  if (!routing.hasWorker) throw new Error(`${name} serves static assets only: it never starts an instance`)
  // A pinned deploy runs its snapshot; dev runs the live entry (checked to stay inside cwd)
  const entry = fn.deploy ? `${stateDir}/deploys/${fn.deploy}/worker.js` : project.main
  if (!entry) throw new Error(`${name} has no entry module`)
  // Only the names: the values reach the shim through the env file (systemd or merged here)
  const secretKeys = Object.keys(parseEnvFile(await readFnEnvFile(config)))
  const assets = routing.assetsDir ? { dir: routing.assetsDir, mode: routing.mode } : null
  // The shim's assets block matches what the daemon routes with (the deploy's own when pinned)
  const env = fnLaunchEnv({ stateDir, project: fnShimProject(project, routing.plan), secretKeys, lingerS: fn.linger, instance, assets })
  // As root, bun comes from the user's PATH (it runs their own code anyway); otherwise it is the daemon's own
  const bun = RUNNING_AS_ROOT ? 'bun' : process.execPath
  return {
    script: 'exec "$@"',
    args: fnLaunchArgs({ bun, moduleDir: fnModuleDir(), entry, cronArgs: cron?.args }),
    env,
    socket: instance?.socketPath ?? null,
  }
}

// One instance: launched like a server (pipes, not a PTY), output into the function's log
const launchFnInstance = async (name: string, instance: FnInstanceLaunch): Promise<FnLaunched> => {
  const config = fnConfigOf(name)
  if (!config) throw new Error(`No function named ${name}`)
  const launch = await launchSpec(config, undefined, name, instance)
  const proc = spawn({ cmd: launch.cmd, cwd: launch.cwd, env: launch.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  auditLog('FN_INSTANCE_START', `${name}: ${instance.id} (pid ${proc.pid})${launch.unit ? ` [${launch.unit}]` : ''}`, 'System')
  const pump = async (stream: ReadableStream<Uint8Array>, tag: string) => {
    const decoder = new TextDecoder()
    let partial = ''
    for await (const chunk of stream) {
      const lines = (partial + stripAnsi(decoder.decode(chunk, { stream: true }))).split(/\r?\n/)
      partial = lines.pop() ?? ''
      const ts = new Date().toISOString()
      for (const line of lines) if (line.trim()) await processLog(name, `[${ts}] [${tag}] ${line}\n`)
    }
    if (partial.trim()) await processLog(name, `[${new Date().toISOString()}] [${tag}] ${partial}\n`)
  }
  const tag = instance.id.slice(name.length + 1)
  Promise.all([pump(proc.stdout, tag), pump(proc.stderr, tag)]).catch(() => {})
  const exited = proc.exited.then(code => {
    auditLog('FN_INSTANCE_EXIT', `${name}: ${instance.id} code ${code}`, 'System')
    return code
  })
  return {
    pid: proc.pid,
    exited,
    kill: () => {
      if (launch.unit) stopUnit(launch.unit).catch(() => {})
      else try { proc.kill('SIGTERM') } catch {}
    },
  }
}

// How requests for a function are routed: whether it has a worker (live main,
// or the pinned deploy's worker.js) and its asset server. Opened on first use
// and reopened when the folder, deploy or project config changes (the key);
// resetFnRouting drops it on deploy/rollback/dev/settings/add/remove.
interface FnRouting {
  hasWorker: boolean
  deploy: string | null
  assets: AssetServer | null
  assetsDir: string | null      // what the shim's env.ASSETS reads
  assetsConfig: AssetsConfig | null  // the deploy's recorded config when pinned, else the live one
  mode: 'dev' | 'snapshot'
  plan: FnAssetsPlan
}
const fnRoutings = new FnRoutingCache<FnRouting>(r => r.assets?.close())

// Root serves the files: only what the function's user could read themselves.
// Groups are looked up once a minute per user, not on every open.
const FN_GIDS_TTL_MS = 60_000
const fnGidsCache = new Map<string, { at: number; gids: number[] }>()
const fnUserGids = async (account: UserAccount): Promise<number[]> => {
  const hit = fnGidsCache.get(account.name)
  if (hit && Date.now() - hit.at < FN_GIDS_TTL_MS) return hit.gids
  const res = await $`id -G -- ${account.name}`.quiet().nothrow()
  const gids = res.exitCode === 0 ? res.stdout.toString().trim().split(/\s+/).map(Number).filter(Number.isInteger) : [account.gid]
  fnGidsCache.set(account.name, { at: Date.now(), gids })
  return gids
}
const fnAssetReader = async (config: ServerConfig): Promise<((path: string) => boolean) | undefined> => {
  if (!RUNNING_AS_ROOT) return undefined  // the daemon is that user already
  const account = await lookupUser(configUser(config))
  if (!account || account.uid === 0) throw new Error(`'${configUser(config)}' is not a usable non-root account`)
  const gids = await fnUserGids(account)
  return path => userCanRead(path, account.uid, gids)
}

const openFnRouting = async (name: string, config: ServerConfig, project: FnProjectConfig, deploy: string | null): Promise<FnRouting> => {
  let info: DeployInfo | null = null
  if (deploy) {
    // Read as the user and checked (assetsConfig included) by checkToolResult
    info = await fnTool<DeployInfo | null>(config, 'resolve', { stateDir: fnStateDir(name), id: deploy })
    if (!info) throw new Error(`deploy ${deploy} of ${name} is gone`)
  }
  const plan = fnAssetsPlan(project, info)
  if (plan.source === 'live-fallback' || plan.source === 'default') {
    auditLog('FN_ASSETS_WARN', `${name}: deploy ${deploy} has no recorded assets routing, using the ${plan.source === 'default' ? 'defaults' : 'live project config'}`, 'System')
  }
  const cfg = plan.config
  if (!cfg) return { hasWorker: plan.hasWorker, deploy, assets: null, assetsDir: null, assetsConfig: null, mode: plan.mode, plan }
  // canRead in snapshot mode too: the user owns deploys/ and could swap a file for a symlink.
  // No index or watcher: dev lookups stat the disk, snapshots use the manifest. A missing
  // folder (dev before the first build) is an empty asset set, picked up when it appears.
  const assets = await AssetServer.open(cfg, { mode: plan.mode, canRead: await fnAssetReader(config) })
  if (!assets.attached) auditLog('FN_ASSETS_WARN', `${name}: assets directory ${cfg.directory} does not exist yet, every lookup misses until it does`, 'System')
  for (const w of assets.warnings.slice(0, 20)) auditLog('FN_ASSETS_WARN', `${name}: ${w}`, 'System')
  return { hasWorker: plan.hasWorker, deploy, assets, assetsDir: cfg.directory, assetsConfig: cfg, mode: plan.mode, plan }
}

const fnRoutingFor = (name: string, config: ServerConfig): Promise<FnRouting> =>
  fnRoutings.get(name, async () => {
    const project = await fnProject(name, config)
    const deploy = config.fn?.deploy ?? null
    return {
      key: JSON.stringify([config.cwd, configUser(config), deploy, project.main, project.assets]),
      open: () => openFnRouting(name, config, project, deploy),
    }
  // Removed or replaced while the project config loaded: don't store a routing for it
  }, () => fnConfigOf(name) === config)

const resetFnRouting = (name: string) => fnRoutings.reset(name)

const fnRuntimes = new Map<string, FnRuntime>()
const fnLogs = new Map<string, FnLog>()

// The request log of a function; `fn.log` decides whether requests are captured
const fnLogOf = (name: string, config: ServerConfig): FnLog => {
  let log = fnLogs.get(name)
  if (!log) {
    log = new FnLog(fnLogPath(name), { mode: config.fn?.log === "meta" ? "meta" : "full" })
    fnLogs.set(name, log)
  }
  return log
}
const closeFnLog = (name: string) => {
  try { fnLogs.get(name)?.close() } catch {}
  fnLogs.delete(name)
}
// A removed function's traffic must not go to whoever takes the name next
const removeFnLogFiles = async (name: string) => {
  closeFnLog(name)
  for (const suffix of ['', '-wal', '-shm']) await unlink(fnLogPath(name) + suffix).catch(() => {})
}

const fnRuntimeFor = async (name: string): Promise<FnRuntime | null> => {
  const existing = fnRuntimes.get(name)
  if (existing) return existing
  const config = fnConfigOf(name)
  if (!config?.fn) return null
  const account = RUNNING_AS_ROOT ? await lookupUser(configUser(config)) : null
  if (RUNNING_AS_ROOT && (!account || account.uid === 0)) throw new Error(`'${configUser(config)}' is not a usable non-root account`)
  // Another request may have created it while we looked the user up
  const raced = fnRuntimes.get(name)
  if (raced) return raced
  const { hot, max } = fnLimits(config.fn)
  const rt = new FnRuntime({
    name,
    socketPath: fnSocketPath(name),
    socketOwner: account ? { uid: account.uid, gid: account.gid } : null,
    hot,
    max,
    launch: instance => launchFnInstance(name, instance),
    log: () => {
      const current = fnConfigOf(name)
      return current?.fn && current.fn.log !== false ? fnLogOf(name, current) : null
    },
  })
  fnRuntimes.set(name, rt)
  try {
    await rt.listen()
  } catch (e) {
    fnRuntimes.delete(name)
    throw e
  }
  return rt
}

// Instances finish what they're serving and exit; queued and new requests go
// to fresh ones (new code, new settings). Hot instances are replaced at once.
// Doesn't wait for the old instances (a long stream can keep one for 30s).
const restartFn = async (name: string) => {
  const rt = fnRuntimes.get(name)
  const config = fnConfigOf(name)
  // Now assets-only (e.g. main removed, or an assets-only deploy): its instances just go
  const routing = config?.fn ? await fnRoutingFor(name, config).catch(() => null) : null
  if (rt && routing && !routing.hasWorker) {
    fnRuntimes.delete(name)
    rt.close().catch(() => {})
    return
  }
  if (rt) {
    rt.restart(config?.fn ? fnLimits(config.fn) : undefined).catch(e => auditLog('FN_RESTART_FAIL', `${name}: ${fnErrorText(e)}`, 'System'))
    return
  }
  await warmFn(name)
}

// Hot instances up (creating the runtime if needed); nothing else changes
const warmFn = async (name: string) => {
  const config = fnConfigOf(name)
  if (!config?.fn || fnLimits(config.fn).hot === 0) return
  // hot is ignored for an assets-only function: it never starts an instance
  if (!(await fnRoutingFor(name, config)).hasWorker) return
  const rt = await fnRuntimeFor(name)
  rt?.pool.ensureHot().catch(e => auditLog('FN_HOT_FAIL', `${name}: ${fnErrorText(e)}`, 'System'))
}

const teardownFn = async (name: string) => {
  const rt = fnRuntimes.get(name)
  fnRuntimes.delete(name)
  fnProjects.delete(name)
  resetFnRouting(name)
  closeFnLog(name)
  if (rt) await rt.close().catch(() => {})
}

// Which function a request is for: its .localhost / .candy name or a bound domain
const fnForRequest = (host: string, path: string): { name: string; binding: DomainBinding | null } | null =>
  fnTargetForRequest(host, path, {
    binding: resolveBindingFromHost,
    localName: resolveLocalCandyDomain,
    isFn: name => !!fnConfigOf(name),
  })

// Serve a request for a function host. Bound domains keep their auth,
// lockouts and allowlist exactly like other sites (API mode: header auth).
const serveFunction = async (req: Request, url: URL, name: string, binding: DomainBinding | null, server: any): Promise<Response> => {
  if (binding) {
    const denied = await requireBoundDomainAuth(req, server, binding)
    if (denied) return denied
  }
  const config = fnConfigOf(name)
  if (!config?.fn) return Response.json({ error: `No function named ${name}` }, { status: 404, headers: { 'X-Candy': 'fn' } })
  let routing: FnRouting
  try {
    routing = await fnRoutingFor(name, config)
  } catch (e) {
    return Response.json({ error: `Could not start ${name}`, reason: String((e as Error)?.message ?? e) }, { status: 502, headers: { 'X-Candy': 'fn' } })
  }

  const headers = fnRequestHeaders(req.headers, { stripCredentials: !!binding && hasBindingAuth(binding) })
  const host = req.headers.get('host') || `${name}.localhost`
  const cleanHost = host.replace(/:\d+$/, '')
  // Everything reaches the visitor over https (Caddy, or Cloudflare for bound domains)
  const proto = binding ? 'https' : (req.headers.get('x-forwarded-proto') === 'http' ? 'http' : 'https')
  const headerTimeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; headerTimeout.abort(new DOMException('No response headers in time', 'TimeoutError')) }, FN_HEADER_TIMEOUT_MS)
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  // Method, Range and conditional headers ride along: the asset router answers HEAD, 206 and 304 itself
  const target = new Request(`${proto}://${host}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? req.body : null,
    signal: AbortSignal.any([req.signal, headerTimeout.signal]),
    redirect: 'manual',
    // @ts-ignore streaming request bodies
    duplex: 'half',
  })
  // A cold start and a long stream both outlast the default 10s idle limit
  try { server.timeout(req, 0) } catch {}
  if (url.pathname === '/' || url.pathname === '') domainHits.set(name, (domainHits.get(name) || 0) + 1)
  const { ip } = getFingerprint(req, server)
  const startedAt = performance.now()
  try {
    // Assets first (no instance, no port); only "worker" touches the pool
    const routed = await routeFunctionRequest(target, {
      assets: routing.assets,
      hasWorker: routing.hasWorker,
      private: !!binding && hasBindingAuth(binding),
      worker: async (workerReq, rule) => {
        let rt: FnRuntime | null
        try {
          rt = await fnRuntimeFor(name)
        } catch (e) {
          return Response.json({ error: `Could not start ${name}`, reason: String((e as Error)?.message ?? e) }, { status: 502, headers: { 'X-Candy': 'fn' } })
        }
        if (!rt) return Response.json({ error: `No function named ${name}` }, { status: 404, headers: { 'X-Candy': 'fn' } })
        const res = await rt.handle(workerReq, { clientIp: ip, host: cleanHost, showStack: !binding && cleanHost.endsWith('.localhost'), rule })
        if (timedOut) return Response.json({ error: `${name} sent no response within ${FN_HEADER_TIMEOUT_MS / 1000}s` }, { status: 504, headers: { 'X-Candy': 'fn' } })
        return res
      },
    })
    if (routed.kind !== 'worker') {
      const log = config.fn.log !== false ? fnLogOf(name, config) : null
      logAssetResponse(log, { requestId: crypto.randomUUID(), fn: name, host: cleanHost, req: target, clientIp: ip, rule: routed.rule, startedAt }, routed.response)
    }
    return routed.response
  } catch (e) {
    return Response.json({ error: `${name}: ${fnErrorText(e)}` }, { status: 500, headers: { 'X-Candy': 'fn' } })
  } finally {
    clearTimeout(timer)
  }
}

// Why `auth` can't put a new config on `name` although no config has it,
// or null: someone else's route (/register, SDK) or a bound public domain
// still points at it. Only its user or a superuser may take those over.
// Who a bound domain belongs to: recorded when it was bound (startup fills it in
// for bindings from before), so it stays theirs after the site itself is removed
const bindingOwner = (b: DomainBinding): string => b.owner ?? nameOwner(b.serverName)

// Why `auth` can't use `name`: a public domain someone else bound still points at
// it, and whoever registers the name would serve that domain. Null when free.
const boundToSomeoneElse = (name: string, auth: RequestAuth | null): string | null => {
  if (auth?.superuser) return null
  const b = Object.values(domainConfig?.bindings ?? {}).find(b => b.serverName === name && bindingOwner(b) !== auth?.user)
  return b ? `${b.fqdn} is bound to '${name}' and belongs to ${bindingOwner(b)}. Pick another name.` : null
}

// Records an owner on bindings from before owners were recorded (after configs and route users load)
const assignBindingOwners = async () => {
  let changed = false
  for (const b of Object.values(domainConfig?.bindings ?? {})) {
    if (!b.owner) { b.owner = nameOwner(b.serverName); changed = true }
  }
  if (changed) await saveDomainConfig()
}

// A binding whose site is gone is kept for its owner, marked orphaned (and
// unmarked when the name is in use again); boundToSomeoneElse keeps others off the name.
const refreshOrphanedBindings = async () => {
  let changed = false
  for (const b of Object.values(domainConfig?.bindings ?? {})) {
    const orphaned = !nameInUse(b.serverName)
    if (!!b.orphaned === orphaned) continue
    if (!b.owner) b.owner = nameOwner(b.serverName)
    if (orphaned) b.orphaned = true
    else delete b.orphaned
    changed = true
    auditLog(orphaned ? 'DOMAIN_ORPHANED' : 'DOMAIN_ADOPTED', `${b.fqdn} -> ${b.serverName} (owner ${b.owner})`, 'System')
  }
  if (changed) await saveDomainConfig()
}

const nameTakenWithoutConfig = (name: string, auth: RequestAuth): string | null => {
  const boundElsewhere = boundToSomeoneElse(name, auth)
  if (boundElsewhere) return boundElsewhere
  if (auth.superuser || getConfigsForName(name).length > 0 || nameOwner(name) === auth.user) return null
  const route = routes.get(name)
  if (route && !(typeof route.target === 'object' && route.target.fn === name)) return `'${name}' is already routed. Pick another name.`
  const bound = Object.values(domainConfig?.bindings ?? {}).some(b => b.serverName === name)
  if (bound) return `A public domain is bound to '${name}'. Pick another name.`
  return null
}

// The function's routes go to the daemon; called at startup and on add
const routeFunction = (name: string) => routes.set(name, { target: { fn: name }, persistent: false })

// From the routing in use (a pinned deploy's own config), opened here if it isn't yet
const fnSummary = async (config: ServerConfig, name: string) => {
  if (!config.fn) return undefined
  const routing = await fnRoutingFor(name, config).catch(() => null)
  return fnSummaryOf(config.fn, routing, fnProjects.get(name)?.cfg ?? null)
}
// The server list is polled: it shows the routing as it stands and refreshes it in the
// background (a project config edit, e.g. main added, shows on the next poll)
const fnSummaryNow = (name: string) => {
  const config = fnConfigOf(name)
  if (!config?.fn) return undefined
  fnRoutingFor(name, config).catch(() => {})
  return fnSummaryOf(config.fn, fnRoutings.current(name) ?? null, fnProjects.get(name)?.cfg ?? null)
}

const fnErrorText = (e: unknown) => String((e as Error)?.message ?? e)

// HTTP API for functions (/fn/*). The function's user or a superuser: every route checks mayChangeConfig.
const handleFnApi = async (req: Request, url: URL, corsHeaders: Record<string, string>, server: any, auth: RequestAuth): Promise<Response> => {
  const ok = (body: Record<string, unknown>) => Response.json({ success: true, ...body }, { headers: corsHeaders })
  const fail = (error: string, status = 400) => Response.json({ success: false, error }, { status, headers: corsHeaders })
  const actor = auditActor(auth, req.headers.get('X-Candy-Actor'))
  const requester = auth.user
  const body: Record<string, any> = req.method === 'POST' ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams)
  const name = typeof body.name === 'string' ? body.name : ''
  const route = url.pathname

  // ---- add (creates or updates the function) ----
  if (req.method === 'POST' && route === '/fn/add') {
    if (!name || isReserved(name)) return fail(isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", isSafeName(name) ? 403 : 400)
    const refusal = nameInUse(name) ? null : newNameRefusal(name)
    if (refusal) return fail(refusal, 403)
    let user = requester
    if (body.user && body.user !== requester) {
      // Another account: a superuser logged in to the portal only, never an API key
      if (!RUNNING_AS_ROOT || !auth.superuser) return fail(`You can only add functions that run as ${requester}.`, 403)
      if (!(await runAsUsers()).some(u => u.name === body.user)) return fail(`${body.user} isn't in the ${SHARED_GROUP} group, so functions can't run as them.`)
      user = String(body.user)
    }
    const others = getConfigsForName(name)
    const otherOwner = RUNNING_AS_ROOT ? others.find(cfg => configUser(cfg) !== user) : undefined
    if (otherOwner) return fail(`'${name}' already belongs to ${configUser(otherOwner)}. Pick another name.`, 403)
    if (others.some(cfg => !cfg.fn)) return fail(`'${name}' is already a server. Remove it first or pick another name.`, 409)
    const taken = nameTakenWithoutConfig(name, auth)
    if (taken) return fail(taken, 409)
    const account = RUNNING_AS_ROOT ? await lookupUser(user) : null
    const stateProblem = account ? await fnStateDirProblem(name, account.uid) : null
    if (stateProblem) return fail(stateProblem, 409)
    if (typeof body.cwd !== 'string' || !body.cwd) return fail("cwd is required")
    const home = RUNNING_AS_ROOT ? (await lookupUser(user))?.home : process.env.HOME
    const cwd = body.cwd.replace(/^~(?=$|\/)/, home || '')
    if (!cwd.startsWith('/') || /[\x00-\x1f]/.test(cwd)) return fail("cwd must be an absolute path")
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) return fail(`${cwd} is not a folder`)
    for (const key of ['hot', 'max'] as const) {
      if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] < (key === 'max' ? 1 : 0) || body[key] > FN_MAX_INSTANCES)) return fail(`${key} must be a whole number from ${key === 'max' ? 1 : 0} to ${FN_MAX_INSTANCES}`)
    }
    if (body.linger !== undefined && (!Number.isInteger(body.linger) || body.linger < 0 || body.linger > FN_MAX_LINGER_S)) return fail(`linger must be a whole number of seconds from 0 to ${FN_MAX_LINGER_S}`)
    if (body.envFile !== undefined && body.envFile !== null) {
      const problem = await envFileProblem(user, String(body.envFile))
      if (problem) return fail(problem)
    }
    if (body.entry !== undefined && (typeof body.entry !== 'string' || !body.entry)) return fail("entry must be a path")
    let project: FnProjectConfig
    try {
      project = await fnTool<FnProjectConfig>({ user }, 'config', { dir: cwd, entry: body.entry })
    } catch (e) {
      return fail(fnErrorText(e))
    }
    if (!project.main && !project.assets) return fail(`No entry module: set "main" (or "assets") in candy.fn.json or wrangler, or pass entry. ${project.warnings.join('; ')}`)
    if (!project.main) {
      // Assets-only: served by the daemon, never an instance. fn-tool refuses most of this first.
      if (body.hot !== undefined && body.hot > 0) return fail("hot needs a main module: an assets-only function never starts an instance")
      const rwf = project.assets!.runWorkerFirst
      if (rwf === true || (Array.isArray(rwf) && rwf.some(p => !p.startsWith('!')))) return fail("run_worker_first needs a main module")
      if (project.crons.length > 0) return fail("cron triggers need a main module")
    }
    let config = others.find(cfg => cfg.fn)
    const fn: FnSettings = { ...(config?.fn ?? {}), entry: project.main || null }
    for (const key of ['hot', 'max', 'linger'] as const) if (body[key] !== undefined) fn[key] = body[key]
    if (fnLimits(fn).hot !== (fn.hot ?? 0)) return fail("hot can't be more than max")
    if (config) {
      // Re-adding from another folder unpins the deploy, which was built from the old one
      if (config.cwd !== cwd) delete fn.deploy
      config.cwd = cwd
      config.fn = fn
    } else {
      config = { id: makeConfigId(), cwd, cmd: '', api: true, fn }
      if (user !== OWNER) config.user = user
      serverConfigs.set(name, [config])
    }
    // shown in lists; never run as shell text
    config.cmd = fn.entry ? `fn-host.ts ${fn.entry}` : `assets ${project.assets!.directory}`
    if (body.envFile !== undefined) {
      if (body.envFile) config.envFile = String(body.envFile)
      else delete config.envFile
    }
    try {
      syncFnCron(config, project)
    } catch (e) {
      return fail(fnErrorText(e))
    }
    fnProjects.set(name, { cfg: project, stamp: await fnConfigStamp(cwd), cwd, entry: fn.entry })
    await saveServerConfigs()
    routeFunction(name)
    await syncCaddy()
    resetFnRouting(name)
    await restartFn(name)
    auditLog('FN_ADD', `${name}: ${fn.entry ?? `assets ${project.assets!.directory}`} in ${cwd}${RUNNING_AS_ROOT ? ` as ${user}` : ''}`, actor)
    return ok({ name, url: makeLocalhostUrl(name), warnings: project.warnings, fn: await fnSummary(config, name) })
  }

  if (!route.startsWith('/fn/')) return fail("Not found", 404)
  if (!name) return fail("name is required")
  const config = fnConfigOf(name)
  if (!config?.fn) return fail(`No function named '${name}'.`, 404)
  if (!mayChangeConfig(auth, config)) return fail(`${name} runs as ${configUser(config)}. Only they can use this.`, 403)
  const fn = config.fn
  const stateDir = fnStateDir(name)

  if (req.method === 'POST' && route === '/fn/settings') {
    const next: FnSettings = { ...fn }
    for (const key of ['hot', 'max'] as const) {
      if (body[key] === undefined) continue
      if (!Number.isInteger(body[key]) || body[key] < (key === 'max' ? 1 : 0) || body[key] > FN_MAX_INSTANCES) return fail(`${key} must be a whole number from ${key === 'max' ? 1 : 0} to ${FN_MAX_INSTANCES}`)
      next[key] = body[key]
    }
    if (body.linger !== undefined) {
      if (!Number.isInteger(body.linger) || body.linger < 0 || body.linger > FN_MAX_LINGER_S) return fail(`linger must be a whole number of seconds from 0 to ${FN_MAX_LINGER_S}`)
      next.linger = body.linger
    }
    if (body.log !== undefined) {
      if (body.log === true) delete next.log
      else if (body.log === false || body.log === 'meta') next.log = body.log
      else return fail('log must be true, "meta" or false')
    }
    if ((next.hot ?? 0) > (next.max ?? FN_DEFAULT_MAX)) return fail("hot can't be more than max")
    if (body.hot !== undefined && body.hot > 0) {
      const routing = await fnRoutingFor(name, config).catch(() => null)
      if (routing && !routing.hasWorker) return fail("hot needs a main module: an assets-only function never starts an instance")
    }
    const logChanged = (next.log ?? true) !== (fn.log ?? true)
    config.fn = next
    try {
      syncFnCron(config, await fnProject(name, config, true))
    } catch (e) {
      auditLog('FN_CONFIG_FAIL', `${name}: ${fnErrorText(e)}`, actor)
    }
    await saveServerConfigs()
    // Open tails stay subscribed; requests from now on use the new mode
    if (logChanged && next.log !== false) fnLogs.get(name)?.setMode(next.log === 'meta' ? 'meta' : 'full')
    resetFnRouting(name)
    const rt = fnRuntimes.get(name)
    rt?.setLimits(fnLimits(next))
    if (fnLimits(next).hot > 0) await warmFn(name).catch(() => {})
    auditLog('FN_SETTINGS', `${name}: hot ${fnLimits(next).hot}, max ${fnLimits(next).max}, linger ${next.linger ?? FN_DEFAULT_LINGER_S}s, log ${next.log ?? 'full'}`, actor)
    return ok({ fn: await fnSummary(config, name) })
  }

  if (req.method === 'POST' && route === '/fn/deploy') {
    try { server.timeout(req, 0) } catch {}  // bundling can take a while
    let info: DeployInfo
    try {
      await ensureFnStateDir(name, config)
      const project = await fnProject(name, config, true)
      // The already-checked assets block goes along; main is null for an assets-only project
      info = await fnTool<DeployInfo>(config, 'deploy', { name, srcDir: config.cwd, main: project.main, assets: project.assets ?? null, stateDir })
      // /fn/settings may have replaced config.fn while the bundle ran
      if (!config.fn) throw new Error(`${name} is no longer a function`)
      config.fn.deploy = info.id
      syncFnCron(config, project)
    } catch (e) {
      auditLog('FN_DEPLOY_FAIL', `${name}: ${fnErrorText(e).split('\n')[0]}`, actor)
      return fail(fnErrorText(e))
    }
    await saveServerConfigs()
    await fnTool(config, 'prune', { stateDir, keep: FN_KEEP_DEPLOYS, pinned: info.id }).catch(e => auditLog('FN_PRUNE_FAIL', `${name}: ${fnErrorText(e)}`, 'System'))
    resetFnRouting(name)  // code and assets switch together
    await restartFn(name)
    auditLog('FN_DEPLOY', `${name}: ${info.id}${info.gitRev ? ` (${info.gitRev})` : ''}`, actor)
    return ok({ deploy: info })
  }

  if (req.method === 'POST' && route === '/fn/rollback') {
    let target: DeployInfo | null = null
    try {
      if (body.id !== undefined) {
        if (!isDeployId(body.id)) return fail("That isn't a deploy id.")
        target = await fnTool<DeployInfo | null>(config, 'resolve', { stateDir, id: body.id })
        if (!target) return fail(`No deploy ${body.id} for ${name}.`, 404)
      } else {
        // The snapshot before the current one (or the newest, from dev)
        const deploys = await fnTool<DeployInfo[]>(config, 'deploys', { stateDir })
        const at = fn.deploy ? deploys.findIndex(d => d.id === fn.deploy) : -1
        target = fn.deploy ? (at >= 0 ? deploys[at + 1] ?? null : deploys[0] ?? null) : deploys[0] ?? null
        if (!target) return fail(`No earlier deploy of ${name} to roll back to.`, 404)
      }
    } catch (e) {
      return fail(fnErrorText(e))
    }
    if (!config.fn) return fail(`${name} is no longer a function`, 404)
    config.fn.deploy = target.id
    await saveServerConfigs()
    resetFnRouting(name)
    await restartFn(name)
    auditLog('FN_ROLLBACK', `${name}: ${target.id}`, actor)
    return ok({ deploy: target })
  }

  if (req.method === 'POST' && route === '/fn/dev') {
    delete config.fn!.deploy
    try { syncFnCron(config, await fnProject(name, config, true)) } catch {}
    await saveServerConfigs()
    resetFnRouting(name)
    await restartFn(name)
    auditLog('FN_DEV', `${name}: live code`, actor)
    return ok({})
  }

  if (req.method === 'GET' && route === '/fn/deploys') {
    try {
      const deploys = await fnTool<DeployInfo[]>(config, 'deploys', { stateDir })
      return ok({ deploys, current: fn.deploy ?? null, fn: await fnSummary(config, name) })
    } catch (e) {
      return fail(fnErrorText(e))
    }
  }

  if (req.method === 'GET' && route === '/fn/instances') {
    await fnProject(name, config).catch(() => {})  // fresh assets block for the summary
    return ok({ instances: fnRuntimes.get(name)?.instances() ?? [], fn: await fnSummary(config, name) })
  }

  if (req.method === 'GET' && route === '/fn/requests') {
    const num = (v: unknown) => v === undefined || v === '' ? undefined : Number(v)
    const filter = { status: body.status || undefined, path: body.path || undefined, since: num(body.since), before: num(body.before), limit: num(body.limit) }
    for (const key of ['since', 'before', 'limit'] as const) {
      if (filter[key] !== undefined && !Number.isFinite(filter[key])) return fail(`${key} must be a number (epoch ms for since/before)`)
    }
    try {
      return ok({ requests: fnLogOf(name, config).query(filter) })
    } catch (e) {
      return fail(fnErrorText(e))
    }
  }

  if (req.method === 'GET' && route === '/fn/request') {
    const detail = typeof body.id === 'string' ? fnLogOf(name, config).get(body.id) : null
    if (!detail) return fail(`No logged request ${body.id ?? ''} for ${name}.`, 404)
    return Response.json(detail, { headers: corsHeaders })
  }

  if (req.method === 'GET' && route === '/fn/tail') {
    const log = fnLogOf(name, config)
    const enc = new TextEncoder()
    let unsubscribe = () => {}
    let ping: ReturnType<typeof setInterval> | undefined
    const stop = () => { unsubscribe(); clearInterval(ping) }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => { try { controller.enqueue(enc.encode(text)) } catch { stop() } }
        send(`: tail ${name}\n\n`)
        unsubscribe = log.subscribe(s => send(`data: ${JSON.stringify(s)}\n\n`))
        ping = setInterval(() => send(': ping\n\n'), 15 * 1000)
        req.signal.addEventListener('abort', () => { stop(); try { controller.close() } catch {} }, { once: true })
      },
      cancel: stop,
    })
    try { server.timeout(req, 0) } catch {}
    return new Response(stream, { headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
  }

  if (req.method === 'POST' && route === '/fn/replay') {
    const detail = typeof body.id === 'string' ? fnLogOf(name, config).get(body.id) : null
    if (!detail) return fail(`No logged request ${body.id ?? ''} for ${name}.`, 404)
    let replay: Request
    try {
      replay = replayRequest(detail, { allowPartial: body.allowPartial === true })
    } catch (e) {
      return fail(fnErrorText(e))
    }
    const routing = await fnRoutingFor(name, config).catch(() => null)
    if (!routing) return fail(`Could not start ${name}`, 502)
    try { server.timeout(req, 0) } catch {}
    const requestId = crypto.randomUUID()
    // Same routing as live traffic: an asset hit replays against the files, not the worker
    const res = (await routeFunctionRequest(replay, {
      assets: routing.assets,
      hasWorker: routing.hasWorker,
      worker: async (workerReq, rule) => {
        const rt = await fnRuntimeFor(name).catch(() => null)
        if (!rt) return Response.json({ error: `Could not start ${name}` }, { status: 502 })
        return rt.handle(workerReq, { clientIp: '127.0.0.1', host: detail.host, requestId, showStack: true, rule })
      },
    })).response
    // Replies are for reading in a terminal or the portal: cap what comes back
    const LIMIT = 1024 * 1024
    const reader = res.body?.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    let truncated = false
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.length > LIMIT) {
        parts.push(value.subarray(0, LIMIT - size))
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
      parts.push(value)
      size += value.length
    }
    auditLog('FN_REPLAY', `${name}: ${detail.id} -> ${requestId} (${res.status})`, actor)
    return Response.json({
      status: res.status,
      headers: [...res.headers],
      body: new TextDecoder().decode(Buffer.concat(parts)),
      truncated,
      requestId,
    }, { headers: corsHeaders })
  }

  if (req.method === 'POST' && route === '/fn/kv') {
    if (!['get', 'put', 'list', 'delete'].includes(body.op)) return fail("op must be get, put, list or delete")
    if (typeof body.binding !== 'string' || !body.binding) return fail("binding is required")
    try {
      await ensureFnStateDir(name, config)
      const result = await fnTool<Record<string, unknown>>(config, 'kv', {
        stateDir, binding: body.binding, op: body.op, key: body.key, value: body.value, prefix: body.prefix, limit: body.limit, cursor: body.cursor,
      })
      if (body.op === 'put' || body.op === 'delete') auditLog('FN_KV', `${name}: ${body.op} ${body.binding}/${String(body.key).slice(0, 200)}`, actor)
      return Response.json(result, { headers: corsHeaders })
    } catch (e) {
      return fail(fnErrorText(e))
    }
  }

  if (req.method === 'POST' && route === '/fn/d1') {
    if (typeof body.binding !== 'string' || !body.binding) return fail("binding is required")
    if (typeof body.sql !== 'string' || !body.sql.trim()) return fail("sql is required")
    try {
      await ensureFnStateDir(name, config)
      const result = await fnTool<Record<string, unknown>>(config, 'd1', { stateDir, binding: body.binding, sql: body.sql, params: body.params })
      auditLog('FN_D1', `${name}: ${body.binding} ${body.sql.slice(0, 200).replace(/\s+/g, ' ')}`, actor)
      return Response.json(result, { headers: corsHeaders })
    } catch (e) {
      return fail(fnErrorText(e))
    }
  }

  return fail("Not found", 404)
}

setInterval(() => {
  for (const [name, log] of fnLogs) {
    try { log.sweep() } catch (e) { console.error(`[fn] ${name}: log sweep failed`, e) }
  }
}, FN_LOG_SWEEP_INTERVAL)

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
  if (config.fn) throw new Error(`${name} is a function: it starts on its first request`)
  const launch = await launchSpec(config, undefined, name)

  const logFile = getLogFile(name)
  // Earlier runs' output stays out of the site page's excerpt
  let logStart = 0
  try { logStart = statSync(logFile).size } catch {}
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
    logStart,
  }

  processes.set(name, managed)
  auditLog('PROCESS_START', `${name}:${config.id} ${JSON.stringify(config.cmd)}${launch.unit ? ` [${launch.unit}]` : ''}`, actor)

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
        siteTokens.dropName(name)  // its starting page has nothing left to start
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
  siteTokens.dropName(name)

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

const openPortalForName = async ({ name, port, openBrowser, user }: { name?: string; port: number; openBrowser?: boolean; user?: string }): Promise<OpenPortalResult> => {
  if (!port) {
    return { ok: false, status: 400, body: { error: "Port is required" } }
  }

  const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
  if (existingPortal) {
    const m = msg.portalCollision
    return { ok: false, status: 409, body: { error: m, details: `${existingPortal[0]} has :${port}` } }
  }

  let portalName = lowerName(name)
  if (!portalName) {
    let anonCounter = 1
    while (portals.has(`anon-${anonCounter}`)) anonCounter++
    portalName = `anon-${anonCounter}`
  }

  if (isReserved(portalName)) {
    return { ok: false, status: 403, body: { error: "That name is reserved.", details: portalName } }
  }
  const refusal = nameInUse(portalName) ? null : newNameRefusal(portalName)
  if (refusal) return { ok: false, status: 403, body: { error: refusal, details: portalName } }

  if (portals.has(portalName)) {
    const m = msg.portalCollision
    return { ok: false, status: 409, body: { error: m, details: `${portalName} already open` } }
  }

  if (!routes.has(portalName)) {
    routes.set(portalName, { target: port, persistent: false })
    // The new route (anon-N included) belongs to whoever opened the tunnel
    if (user && !serverConfigs.has(portalName)) await setRouteUser(portalName, user)
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
  log("PORTAL", `${portalName} -> ${tunnelUrl}`, portalName)
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

// Check if Caddy is already running via admin API (its unix socket)
const isCaddyRunning = async () => {
  try {
    const res = await caddyAdmin("/config/", { signal: AbortSignal.timeout(500) })
    return res.ok
  } catch {
    return false
  }
}

// The admin socket must be 0600 and ours, in a folder only we can write to:
// Caddy creates it with the |0600 mode and our umask, and this checks (and
// fixes) it rather than trusting that. Until it passes, no config is sent
// there (caddyAdminTrusted): whoever made that socket would get it.
let caddyAdminTrusted = false
const secureCaddyAdminSocket = async (tries = 30): Promise<boolean> => {
  const dir = await lstat(dirname(CADDY_ADMIN_SOCKET)).catch(() => null)
  if (!dir?.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o022) !== 0) {
    console.log(`\x1b[31mThe folder of Caddy's admin socket, ${dirname(CADDY_ADMIN_SOCKET)}, isn't ours alone. Not using it.\x1b[0m`)
    return caddyAdminTrusted = false
  }
  for (let i = 0; i < tries; i++) {
    const st = await lstat(CADDY_ADMIN_SOCKET).catch(() => null)
    if (st?.isSocket()) {
      if ((st.mode & 0o777) !== 0o600) await chmod(CADDY_ADMIN_SOCKET, 0o600).catch(() => {})
      const again = await lstat(CADDY_ADMIN_SOCKET).catch(() => null)
      const ok = !!again && (again.mode & 0o777) === 0o600 && again.uid === process.getuid?.()
      if (!ok) console.log(`\x1b[31mCaddy's admin socket ${CADDY_ADMIN_SOCKET} isn't 0600 and ours. Stop Caddy and check it.\x1b[0m`)
      return caddyAdminTrusted = ok
    }
    await Bun.sleep(100)
  }
  console.log(`\x1b[31mCaddy's admin socket ${CADDY_ADMIN_SOCKET} didn't appear.\x1b[0m`)
  return caddyAdminTrusted = false
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
  if (!route || typeof route.target !== "number") return null
  return route.target
}

// Start Caddy in background
const startCaddy = async () => {
  await $`mkdir -p ${CADDY_CONFIG_DIR}`.quiet().nothrow()

  // The socket's folder: /run/candy (root, 0755, also holds fn/), else
  // $XDG_RUNTIME_DIR/candy or ~/.config/candy/run (0700)
  await mkdir(dirname(CADDY_ADMIN_SOCKET), { recursive: true, mode: RUNNING_AS_ROOT ? 0o755 : 0o700 }).catch(() => {})
  if (!RUNNING_AS_ROOT) await chmod(dirname(CADDY_ADMIN_SOCKET), 0o700).catch(() => {})

  if (await isCaddyRunning()) {
    await secureCaddyAdminSocket()
    console.log("\x1b[33mCaddy already running\x1b[0m (relinked)")
    return
  }

  // A Caddy from before the admin socket still has its API on localhost:2019.
  // Stop it (nothing else is sent there: whoever listens on 2019 gets no config)
  // so the new one, with the socket, can take the ports.
  try {
    // redirect: "manual": whoever listens on :2019 can't bounce this POST to another local URL
    const legacy = await fetch("http://127.0.0.1:2019/config/", { signal: AbortSignal.timeout(500), redirect: "manual" }).catch(() => null)
    if (legacy?.ok) {
      await fetch("http://127.0.0.1:2019/stop", { method: "POST", signal: AbortSignal.timeout(2000), redirect: "manual" }).catch(() => {})
      console.log("\x1b[33mStopped the old Caddy\x1b[0m (admin API on :2019); starting one with the admin socket")
      await Bun.sleep(1000)
    }
  } catch {}

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
      // umask 077: whatever Caddy creates (the admin socket first) is private to it
      cmd: ["/bin/sh", "-c", 'umask 077 && exec "$0" run --config "$1"', CADDY, CADDYFILE],
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
    await secureCaddyAdminSocket()
    console.log("\x1b[32mCaddy started\x1b[0m (PID: " + caddyProc.pid + ")")
  } catch (e) {
    console.log("\x1b[31mFailed to start Caddy\x1b[0m")
  }
}

// Stop Caddy
const stopCaddy = async (force = false) => {
  if (caddyProc) {
    // Caddy waits for open connections (streams) before it exits, with no
    // limit. Give it a moment, then end it, so a restart isn't a long outage.
    const proc = caddyProc
    caddyProc = null
    caddyAdminTrusted = false
    proc.kill()
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)])
    if (!exited) {
      try { proc.kill("SIGKILL") } catch {}
      await Promise.race([proc.exited, Bun.sleep(2000)])
    }
    console.log(`\x1b[90mCaddy stopped${exited ? '' : ' (had to be killed: it was waiting on open connections)'}\x1b[0m`)
  } else if (force && await isCaddyRunning()) {
    try {
      await caddyAdmin("/stop", { method: "POST", signal: AbortSignal.timeout(2000) })
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
    // Functions: ask instances to finish, but don't hold the shutdown for long
    await Promise.race([Promise.all([...fnRuntimes.keys()].map(teardownFn)), Bun.sleep(3000)])
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
    for (const [, rawName, target] of matches) {
      const name = lowerName(rawName)
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
    if (lowerCaseNames("route", routes)) await savePersistentRoutes()
  } catch {}
}

// Save only persistent routes to routes.json
const savePersistentRoutes = async () => {
  const data: Record<string, number | string> = {}
  for (const [name, route] of routes) {
    if (route.persistent && typeof route.target !== "object") {
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
const routeProxyTarget = (name: string, route: { target: RouteTarget }): string => {
  if (typeof route.target === "object") return 'localhost:9999'  // function: the daemon dispatches by Host
  const status = processes.get(name)?.status
  if (apiModeConfig(name) && status !== 'running') return 'localhost:9999'
  return typeof route.target === "number" ? `localhost:${route.target}` : route.target
}

// ::1 is only bound when this machine has it: Caddy refuses a config whose bind fails
const hasIpv6Loopback = (): boolean =>
  Object.values(networkInterfaces()).some(list => list?.some(a => a.family === "IPv6" && a.address === "::1"))

// Every address of this machine: a route or bound domain pointing here could
// reach the portal or another user's site through Caddy (isCaddyUpstream)
const ownAddresses = (): string[] => {
  const all = new Set<string>()
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) all.add(a.address.toLowerCase())
  for (const a of [lanIp, tailscaleIp, getTailnetHostname()]) if (a) all.add(a.toLowerCase())
  return [...all]
}
// Each skipped address is audited once per run, not on every sync
const auditedSiteClashes = new Set<string>()

const CADDY_ADMIN_RETRY_MS = 30_000
let caddyRetry: ReturnType<typeof setTimeout> | null = null
const scheduleCaddyRetry = () => {
  if (caddyRetry) return
  caddyRetry = setTimeout(() => { caddyRetry = null; syncCaddy().catch(() => {}) }, CADDY_ADMIN_RETRY_MS)
}

// Send a config to Caddy. Each try uses its own connection (Caddy replaces its
// admin server on every load, so a kept-alive one may be gone) and has a time
// limit. true: Caddy has it, or refused it (it keeps the old one; trying again won't help).
const loadCaddyConfig = async (content: string): Promise<boolean> => {
  let lastError = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await caddyAdmin("/load", {
        method: "POST",
        headers: { "Content-Type": "text/caddyfile", "Connection": "close" },
        body: content,
        keepalive: false,
        signal: AbortSignal.timeout(20_000),
      })
      // Caddy keeps running the previous config when a load is rejected.
      if (!res.ok) console.log(`\x1b[31mCaddy rejected the new config:\x1b[0m ${(await res.text()).trim()}`)
      return true
    } catch (e) {
      lastError = String((e as any)?.code ?? (e as Error)?.name ?? "") + " " + String((e as Error)?.message ?? e)
      await Bun.sleep(300 * (attempt + 1))
    }
  }
  console.log(`\x1b[31mFailed to reload Caddy\x1b[0m (${lastError.trim()})`)
  return false
}

// Caddy is running an old config while reloads keep failing: sites would
// point at ports that are gone (502). Try again shortly; if it still can't be
// reached, replace it, which reads the Caddyfile fresh.
let caddyReloadFailures = 0
const caddyReloadFailed = async () => {
  caddyReloadFailures++
  auditLog('CADDY_RELOAD_FAILED', `attempt ${caddyReloadFailures}`, 'System')
  if (caddyReloadFailures < 3 || !caddyProc) {
    // Soon: until it lands, sites may point at ports that are gone
    setTimeout(() => { syncCaddy().catch(() => {}) }, 3000)
    return
  }
  caddyReloadFailures = 0
  console.log("\x1b[33mCaddy isn't taking new configs. Restarting it.\x1b[0m")
  auditLog('CADDY_RESTART', 'reloads kept failing', 'System')
  await stopCaddy()
  await startCaddy()
}

// Write Caddyfile and reload. One at a time: callers that arrive during a
// sync share the next one (coalesced), so Caddy never gets two loads at once.
const syncCaddy = coalesced(() => syncCaddyNow())
const syncCaddyNow = async () => {
  await refreshOrphanedBindings()
  let content = `# candy-localhost routes
# managed by candy-localhost - do not edit manually

${caddyGlobalBlock({ adminSocket: CADDY_ADMIN_SOCKET, accessLog: CADDY_LOG.replace(/\\/g, "/") })}
`
  // *.localhost sites answer this machine only: the LAN and the tailnet can't reach them with --resolve
  const localBind = loopbackBind(hasIpv6Loopback())
  // Everything below becomes Caddyfile tokens: names, upstreams and addresses that
  // aren't the shape they should be are left out (and said so), never written
  const skipped: string[] = []
  const okName = (name: string) => isSafeName(name) && isHostName(name) ? true : (skipped.push(`name ${JSON.stringify(name)}`), false)
  const own = ownAddresses()
  const okUpstream = (name: string, target: string) => isCaddyUpstream(target, own) ? true : (skipped.push(`${name}: upstream ${JSON.stringify(target)}`), false)
  const okIp = (ip: string | null): ip is string => !!ip && isIpOrCidr(ip)
  const localExactNames = new Set([...routes.keys(), ...serverConfigs.keys()])
  const localHostLabel = getLocalCandyHostLabel()
  const candyAliasHosts: string[] = []
  const candyKillAliasHosts: string[] = []
  const candyPortalAliasHosts: string[] = []

  for (const [name, route] of routes) {
    const proxyTarget = routeProxyTarget(name, route)
    if (!okName(name) || !okUpstream(name, proxyTarget)) continue
    content += `${name}.localhost {
  ${localBind}
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
    const bindAddrs = candyBindAddrs(name).filter(okIp)
    if (bindAddrs.length === 0) continue
    const proxyTarget = routeProxyTarget(name, route)
    if (!okName(name) || !okUpstream(name, proxyTarget)) continue
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
    content += `${candyHosts.filter(isHostName).join(", ")} {
  bind ${bindAddrs.join(" ")}
  tls internal
  reverse_proxy ${proxyTarget}
  log
}

`
  }

  for (const name of serverConfigs.keys()) {
    if (routes.has(name)) continue
    const bindAddrs = candyBindAddrs(name).filter(okIp)
    if (bindAddrs.length === 0 || !okName(name)) continue
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
      content += `${candyHosts.filter(isHostName).join(", ")} {
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
  if (tailnetHost && isHostName(tailnetHost) && okIp(lanIp) && lanIp !== tailscaleIp) {
    for (const [name, port] of [...lanHttps].sort(([a], [b]) => a.localeCompare(b))) {
      const route = routes.get(name)
      if (!route && !serverConfigs.has(name)) continue
      if (!okName(name) || !Number.isInteger(port)) continue
      if (route && typeof route.target === "string" && !okUpstream(name, route.target)) continue
      // Not running yet (or a function): the daemon picks the server by Host.
      const proxy = route && typeof route.target !== "object"
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
    if (!okName(name) || !Number.isInteger(port) || !okUpstream(name, target)) continue
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
    if (url && !isQuickTunnelUrl(url)) skipped.push(`${name}: tunnel ${JSON.stringify(url)}`)
    else if (url && Number.isInteger(port)) {
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
    for (const binding of Object.values(safeBindings())) {
      const upstream = bindingUpstream(binding.serverName)
      if (upstream && !okUpstream(binding.serverName, upstream)) continue
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
      if (okIp(lanIp) && lanIp !== tailscaleIp && lanDomainHttpsBinding(binding.serverName)?.fqdn === binding.fqdn) {
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
  if (mcpPublicFqdn && isZoneName(mcpPublicFqdn)) {
    content += `${SYSTEM_BLOCK_MARK}
http://${mcpPublicFqdn} {
  reverse_proxy localhost:9999
  log
}

`
  }

  // Kill subdomains:
  // - <name>.kill.localhost / <name>.k.localhost
  content += `${SYSTEM_BLOCK_MARK}
*.kill.localhost, *.k.localhost {
  ${localBind}
  tls internal
  reverse_proxy localhost:9999
  log
}

`

  // Portal subdomains: <name>.portal.localhost and <name>.p.localhost
  // Opens a cloudflare tunnel and redirects after DNS propagates
  content += `${SYSTEM_BLOCK_MARK}
*.portal.localhost, *.p.localhost {
  ${localBind}
  tls internal
  reverse_proxy localhost:9999
  log
}

`

  // .candy kill/portal subdomains (Tailscale)
  if (okIp(tailscaleIp)) {
    content += `${SYSTEM_BLOCK_MARK}
*.kill.candy, *.k.candy {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    content += `${SYSTEM_BLOCK_MARK}
*.portal.candy, *.p.candy {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    if (candyKillAliasHosts.length > 0) {
      content += `${SYSTEM_BLOCK_MARK}
${[...new Set(candyKillAliasHosts)].filter(isHostName).join(", ")} {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    }
    if (candyPortalAliasHosts.length > 0) {
      content += `${SYSTEM_BLOCK_MARK}
${[...new Set(candyPortalAliasHosts)].filter(isHostName).join(", ")} {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    }
  }

  // Everything else goes to daemon (portal, unregistered domains, etc)
  content += `${SYSTEM_BLOCK_MARK}
*.localhost {
  ${localBind}
  tls internal
  reverse_proxy localhost:9999
  log
}

`

  // .candy catch-all (Tailscale) - portal UI, unregistered domains
  if (okIp(tailscaleIp)) {
    if (candyAliasHosts.length > 0) {
      content += `${SYSTEM_BLOCK_MARK}
${[...new Set(candyAliasHosts)].filter(isHostName).join(", ")} {
  bind ${tailscaleIp}
  tls internal
  reverse_proxy localhost:9999
  log
}

`
    }
    content += `${SYSTEM_BLOCK_MARK}
*.candy {
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

  // Caddy keeps an idle connection to each upstream for two minutes by default.
  // Idle detection counts open connections as activity, so keep those short:
  // then only connections that are really in use (streams, websockets) count.
  content = content.replace(
    /^([ \t]*)reverse_proxy (localhost:(?!9999\b)\d+)[ \t]*$/gm,
    (_line, pad: string, target: string) => `${pad}reverse_proxy ${target} {\n${pad}  transport http {\n${pad}    keepalive ${UPSTREAM_KEEPALIVE}\n${pad}  }\n${pad}}`,
  )
  // Caddy tags everything it sends the daemon, so forwarding headers are trusted from Caddy only
  content = tagDaemonUpstreams(content, CADDY_PROXY_TAG)
  // One block per address, or Caddy refuses the whole file and keeps the old
  // one: a user's name that spells a shortcut or alias host loses to it
  const deduped = dedupeSiteAddresses(content)
  content = deduped.content
  for (const address of deduped.skipped) {
    if (auditedSiteClashes.has(address)) continue
    auditedSiteClashes.add(address)
    auditLog('CADDY_SITE_SKIPPED', `${address}: another block already serves this address`, 'System')
  }
  if (skipped.length) console.log(`\x1b[33mLeft out of the Caddyfile (not a valid value):\x1b[0m ${[...new Set(skipped)].join(", ")}`)
  await Bun.write(CADDYFILE, content)
  await chmod(CADDYFILE, 0o600).catch(() => {})  // holds the proxy tag

  // Never hand the config (it holds the proxy tag) to a socket that failed the check.
  // No socket yet: Caddy isn't up, and reads the Caddyfile when it starts.
  if (!caddyAdminTrusted && !existsSync(CADDY_ADMIN_SOCKET)) {
    // nothing to reload
  } else if (!caddyAdminTrusted && !await secureCaddyAdminSocket(1)) {
    console.log(`\x1b[31mNot reloading Caddy: its admin socket failed the check. Trying again in ${CADDY_ADMIN_RETRY_MS / 1000}s.\x1b[0m`)
    scheduleCaddyRetry()
  } else if (await loadCaddyConfig(content)) {
    caddyReloadFailures = 0
  } else {
    await caddyReloadFailed()
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

// Credentialed CORS only for exact portal origins (https, default port, a portal
// host): never *.localhost:<any port>, which any local user can serve.
const getCorsHeaders = (origin: string | null) => {
  const allowed = isPortalOrigin(origin, isPortalHost)
  return {
    "Access-Control-Allow-Origin": allowed ? origin! : "",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, X-Candy-Token, X-Candy-API-Key, ${SESSION_HEADER}`,
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  }
}

// Token validation response
const unauthorizedResponse = (cors: ReturnType<typeof getCorsHeaders>) =>
  Response.json({ error: "Invalid or expired token. Refresh required." }, { status: 401, headers: cors })

// JSON for inside a <script> element: no "</script>" or "<!--" can end it early
const scriptJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c")

// Portal pages that are served as a shell on navigation (public/portal-shell.html):
// the real page, with its page token, only comes back to a request that carries
// the session secret header, which a stolen cookie alone can't add
const PORTAL_PAGES = new Set(["/", "/oauth/consent", "/go/kill", "/go/portal", "/app-auth/consent", "/passkeys"])

// Put into every portal page: same-origin fetches carry the session secret,
// which the login page keeps in this origin's localStorage
const SESSION_FETCH_PATCH = `(function(){var s=null;try{s=localStorage.getItem('candy_session')}catch(e){}var f=window.fetch;if(!s||f.__candy)return;var p=function(i,o){o=o||{};try{var u=new URL(i instanceof Request?i.url:String(i),location.href);if(u.origin===location.origin){var h=new Headers(o.headers||(i instanceof Request?i.headers:undefined));h.set('${SESSION_HEADER}',s);o=Object.assign({},o,{headers:h})}}catch(e){}return f.call(window,i,o)};p.__candy=true;window.fetch=p})();`

// The token and variables for a portal page, plus the fetch patch
const portalPageScript = (token: string | null, vars?: unknown): string =>
  `<script>window.CANDY_TOKEN=${JSON.stringify(token)};${vars === undefined ? "" : `window.CANDY_VARS=${scriptJson(vars)};`}${SESSION_FETCH_PATCH}</script>`

// Caddy terminates TLS; it says how the browser connected
const isHttps = (req: Request): boolean => req.headers.get("x-forwarded-proto") === "https"

// The site a site host is for: <name>.localhost, <name>.candy, and the action
// hosts <name>.k|kill|p|portal.<tld> (pages served while it isn't up)
const siteNameForHost = (host: string): string => {
  const h = host.replace(/:\d+$/, "").toLowerCase()
  const m = h.match(/^([a-z0-9-]+)\.(kill|k|portal|p)(?:\.([a-z0-9-]+))?\.(localhost|candy)$/)
  if (m) return m[4] === "candy" ? resolveLocalCandyActionDomain(m[1], m[3] || null) : (m[3] ? `${m[1]}.${m[3]}` : m[1])
  return resolveLocalCandyDomain(h)
}

// What a site's own pages (starting, crashed, tunnel) may do on that site
// without a login: a bounded startup excerpt of its log while it is starting
// or crashed (the /stream handler enforces that), its tunnel status, and start
// or restart it with the site token the daemon put in that page (siteTokens:
// this name, this page load, 15 minutes). Never pick its port, type into its
// terminal, register, or touch another site. An Origin header proves nothing
// (curl sends any), so the token is what counts; Origin is checked as well.
const siteAction = (req: Request, url: URL, name: string): boolean => {
  if (!name || isReserved(name)) return false
  const path = url.pathname
  if (req.method === "GET") return path === `/stream/${name}` || path === `/portal/status/${name}`
  if (req.method !== "POST") return false
  if (path !== `/process/start/${name}` && path !== `/process/restart/${name}`) return false
  let from: string | null = null
  try { from = new URL(req.headers.get("origin") || "").host.toLowerCase() } catch {}
  if (!from || from !== (req.headers.get("host") || "").toLowerCase()) return false
  return siteTokens.check(req.headers.get("X-Candy-Token"), name)
}

// The most of a log a site page shows without a login: its startup output
const SITE_LOG_EXCERPT_BYTES = 32 * 1024

// Logging in and out happens before there is a page token; /token is the refresh itself
// (passkey login too; all of them are still held to sameOrigin)
const TOKENLESS_ROUTES = new Set(["/auth/login", "/auth/logout", "/token", "/auth/passkey/options", "/auth/passkey"])

// Whether /etc/pam.d/candy is there. Login fails closed (with a message) while it isn't.
let pamReady = false
const checkPam = async (warn: boolean) => {
  const was = pamReady
  pamReady = await pamAvailable("candy").catch(() => false)
  if (!pamReady && (warn || was)) {
    console.error(`\x1b[33mPortal login is off: /etc/pam.d/candy is missing. Run install-service.sh to install it.\x1b[0m`)
  }
}

const loginDeps = {
  pamReady: () => pamReady,
  loginUsers,
  verifyPassword: (user: string, password: string) => verifyPassword(user, password),
  isSuperuser,
  blocked: checkAuthBlocked,
  fail: recordAuthFailure,
  clear: clearAuthFailures,
  refund: refundAuthFailure,
  // Every browser on this machine is loopback (through Caddy): a soft, capped delay, never a lock
  isLoopback,
  slots: new LoginSlots(),
  soft: new SoftLockout(),
  audit: (action: "AUTH_LOGIN" | "AUTH_FAIL", details: string) => { auditLog(action, details, 'Portal') },
  serverError: (message: string) => console.error(`\x1b[31mPortal login: ${message}\x1b[0m`),
  now: () => Date.now(),
  sleep: (ms: number) => Bun.sleep(ms),
}

// Passkey login: its own soft lockout (per address, loopback as one), plus
// the password login's address lockout (appAuthRoutes.addressWait)
// The account's uid, null when getent says there's no such user (exit 2);
// throws when it can't tell (NSS/LDAP trouble), so nothing is pruned on a hiccup
const passkeyUid = async (name: string): Promise<number | null> => {
  if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(name)) return null
  const res = await $`getent passwd ${name}`.quiet().nothrow()
  if (res.exitCode === 2) return null
  if (res.exitCode !== 0) throw new Error(`getent passwd exited ${res.exitCode}`)
  const f = res.stdout.toString().trim().split(":")
  const uid = Number(f[2])
  if (f[0] !== name || !Number.isSafeInteger(uid)) throw new Error("getent passwd: unexpected output")
  return uid
}

const passkeyDeps: PasskeyDeps = {
  store: passkeys,
  challenges: passkeyChallenges,
  webauthn,
  soft: new SoftLockout(),
  loginUsers: () => eligibleLoginUsers(),
  uidOf: passkeyUid,
  // PAM's account stage (pam_acct_mgmt only), as a password login has it. Without
  // /etc/pam.d/candy, loginUsers' shadow checks (locked, expired, must change) are all there is
  accountOk: async user => !pamReady || (await checkAccount(user)).ok,
  isSuperuser,
  isLoopback,
  audit: (action, details) => { auditLog(action, details, 'Portal') },
  now: () => Date.now(),
  sleep: (ms: number) => Bun.sleep(ms),
}

// Passkeys of accounts that are gone, or that are another account now (the
// name was reused): dropped. Login checks the uid anyway; this cleans up.
const prunePasskeys = () => prunePasskeyAccounts(passkeyDeps).catch(e => console.error(`\x1b[33mPasskey cleanup: ${(e as Error).message}\x1b[0m`))
setTimeout(prunePasskeys, 30 * 1000)
setInterval(prunePasskeys, 10 * 60 * 1000)

// Which site candy routes an https host to, for return_to: a site's
// .localhost / .candy name or a bound domain. Never the portal, a shortcut
// host, a tunnel, a host with a port, or a name nobody uses.
const appAuthSites: SiteLookup = {
  siteOfHost: (raw: string) => {
    const h = raw.toLowerCase()
    if (!h || h.includes(":") || isPortalHost(h) || parseShortcutHost(h)) return null
    if (h.endsWith(".localhost") || h.endsWith(".candy")) {
      const name = resolveLocalCandyDomain(h)
      return name && nameInUse(name) && !isReserved(name) ? name : null
    }
    const name = resolveBindingFromHost(h)?.serverName ?? null
    return name && nameInUse(name) && !isReserved(name) ? name : null
  },
  ownerOf: (name: string) => nameInUse(name) ? nameOwner(name) : null,
}

const appAuthRoutes = createAuthRoutes({
  appKeys,
  consents: appConsents,
  pending: appPending,
  passkeys: passkeyDeps,
  sessions: portalSessions,
  pageTokens,
  site: appAuthSites,
  mayUse: (auth, name) => mayChangeName(auth, name),
  passwordLogin: input => attemptLogin(loginDeps, input),
  addressWait: async (ip: string) => {
    const local = isLoopback(ip)
    const key = loginKeys("", ip, local).ip
    if (local) return Math.ceil(loginDeps.soft.wait(key) / 1000)
    const hard = await checkAuthBlocked(key)
    return hard.blocked ? Math.max(1, hard.retryAfter) : 0
  },
  siteForKeyFetch: body => {
    if (typeof body.configId === "string" && body.configId) {
      for (const [name, configs] of serverConfigs) if (configs.some(c => c.id === body.configId)) return name
      return null
    }
    if (typeof body.name !== "string") return null
    const name = lowerName(body.name)
    return isSafeName(name) && !isReserved(name) && nameInUse(name) ? name : null
  },
  issuers: () => issuersFor(appAuthPortalHosts()),
  portalUrl: appAuthPortalUrl,
  keysChanged: appAuthKeysChanged,
  page: file => Bun.file(`${import.meta.dir}/public/${file}`).text(),
  pageScript: portalPageScript,
  readSessionCookie,
  sessionCookie: sessionCookieHeader,
  sessionHeader: SESSION_HEADER,
  audit: (action, details, actor) => { auditLog(action, details, actor as Actor) },
  now: () => Date.now(),
})

const appAuthContext = (req: Request, auth: RequestAuth | null, portalHost: boolean, cors: Record<string, string>, actor: Actor): AuthRouteContext => {
  const { ip, userAgent } = getFingerprint(req, controlServer)
  return { auth, portalHost, host: (req.headers.get("host") || "").toLowerCase().replace(/:443$/, ""), ip, userAgent, https: isHttps(req), cors, actor }
}

// The public MCP endpoint runs mcp.ts in this process; its calls back to the
// daemon carry the API key of the user who approved the client (oauthKeyFor).
const publicMcpUser = new AsyncLocalStorage<string>()
globalThis.fetch = userScopedFetch(globalThis.fetch, publicMcpUser, "http://localhost:9999", oauthKeyFor)

// Every control route, by class (AUTH_DESIGN.md, "Authorization — one place"):
//   public     anyone (login itself, secret exchange, tailnet discovery)
//   user       a portal login or an API key; handlers then limit it to the caller's own sites
//   superuser  daemon-wide settings, only from a superuser's portal login (never an API key)
// The guard in the control server denies anything not listed here.
// test/route-table.test.ts reads this table (one rule per line) and checks the router against it.
// route-table:begin
const ROUTE_TABLE: readonly RouteRule[] = [
  ["GET", "/login", "public"],
  ["GET", "/auth/users", "public"],
  ["POST", "/auth/login", "public"],
  ["POST", "/auth/logout", "public"],
  ["POST", "/auth/passkey/options", "public"],
  ["POST", "/auth/passkey", "public"],
  ["GET", "/app-auth/authorize", "public"],
  ["GET", "/favicon.svg", "public"],
  ["POST", "/mcp/auth", "public"],
  ["POST", "/candy/advertise", "public"],
  ["GET", "/candy/registry", "public"],
  ["*", "/candy-auth/check", "public"],
  ["POST", "/candy-auth/login", "public"],
  ["GET", "/", "user"],
  ["GET", "/auth/me", "user"],
  ["POST", "/token", "user"],
  ["GET", "/oauth/consent", "user"],
  ["GET", "/oauth/request", "user"],
  ["GET", "/go/kill", "user"],
  ["POST", "/go/kill", "user"],
  ["GET", "/go/portal", "user"],
  ["POST", "/go/portal", "user"],
  ["POST", "/oauth/decision", "user"],
  ["GET", "/app-auth/consent", "user"],
  ["POST", "/app-auth/decision", "user"],
  ["GET", "/app-auth/sites", "user"],
  ["POST", "/app-auth/rotate", "user"],
  ["GET", "/app-auth/consents", "user"],
  ["POST", "/app-auth/consents/revoke", "user"],
  ["POST", "/auth/reauth", "user"],
  ["GET", "/passkeys", "user"],
  ["GET", "/passkeys/list", "user"],
  ["POST", "/passkeys/register/options", "user"],
  ["POST", "/passkeys/register", "user"],
  ["POST", "/passkeys/rename", "user"],
  ["POST", "/passkeys/delete", "user"],
  ["POST", "/auth/set", "user"],
  ["POST", "/auth/clear", "user"],
  ["POST", "/auth/token", "user"],
  ["GET", "/auth/status", "user"],
  ["POST", "/domains/allowlist", "user"],
  ["POST", "/sdk/runtime", "user"],
  ["POST", "/sdk/register-port", "user"],
  ["POST", "/sdk/portal", "user"],
  ["POST", "/sdk/idle", "user"],
  ["POST", "/sdk/cron", "user"],
  ["POST", "/sdk/auth/keys", "user"],
  ["*", "/fn/*", "user"],
  ["POST", "/register", "user"],
  ["DELETE", "/register/*", "user"],
  ["POST", "/rename", "user"],
  ["GET", "/routes", "user"],
  ["GET", "/lan", "user"],
  ["GET", "/routes/serve", "user"],
  ["GET", "/routes/entry", "user"],
  ["POST", "/routes/entry", "user"],
  ["POST", "/portal", "user"],
  ["POST", "/portal/batch", "user"],
  ["GET", "/portals", "user"],
  ["GET", "/portal/status/*", "user"],
  ["POST", "/portal/close/*", "user"],
  ["GET", "/logs", "user"],
  ["GET", "/logs/*", "user"],
  ["GET", "/stats", "user"],
  ["GET", "/traffic/*", "user"],
  ["GET", "/users", "user"],
  ["GET", "/status", "user"],
  ["GET", "/processes", "user"],
  ["POST", "/process/start/*", "user"],
  ["POST", "/process/stop/*", "user"],
  ["POST", "/process/restart/*", "user"],
  ["POST", "/process/port/*", "user"],
  ["POST", "/process/input/*", "user"],
  ["GET", "/configs", "user"],
  ["POST", "/config", "user"],
  ["POST", "/config/api", "user"],
  ["POST", "/config/ttl", "user"],
  ["POST", "/config/memory", "user"],
  ["POST", "/config/env", "user"],
  ["POST", "/config/sandbox", "user"],
  ["DELETE", "/config/*", "user"],
  ["GET", "/domains", "user"],
  ["POST", "/domains/bind", "user"],
  ["DELETE", "/domains/unbind/*", "user"],
  ["GET", "/stream/*", "user"],
  ["POST", "/lan", "superuser"],
  ["*", "/lan/adguard", "superuser"],
  ["POST", "/routes/serve", "superuser"],
  ["*", "/domains/mcp", "superuser"],
  ["POST", "/domains/mcp/revoke", "superuser"],
  ["POST", "/domains/config", "superuser"],
  ["POST", "/shutdown", "superuser"],
  // System monitor: the whole machine, as root. Portal superusers only.
  ["GET", "/system/stats", "superuser"],
  ["POST", "/system/kill", "superuser"],
  ["POST", "/system/unit", "superuser"],
]
// route-table:end

// The portal's pages (the shell, the login page, everything on its host) are
// never shown in someone else's frame: no clickjacking of its buttons
const PORTAL_NO_FRAMING = { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" }
const noFraming = (req: Request, res: Response): Response => {
  if (!isPortalHost(req.headers.get("host"))) return res
  try {
    for (const [k, v] of Object.entries(PORTAL_NO_FRAMING)) if (!res.headers.has(k)) res.headers.set(k, v)
    return res
  } catch {
    const headers = new Headers(res.headers)
    for (const [k, v] of Object.entries(PORTAL_NO_FRAMING)) if (!headers.has(k)) headers.set(k, v)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

// Control plane API server
const controlServer = Bun.serve({
  port: 9999,
  async fetch(req) {
    return noFraming(req, await controlFetch(req))
  },
})

// Every request to :9999. A function declaration, so the server above can call it.
async function controlFetch(req: Request): Promise<Response> {
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
    // Before any route: who sent it (our Caddy or not), then the tag is gone
    markProxyHeaders(req, peerIp)

    // Public MCP host: its own small surface (OAuth + /mcp), nothing else
    const requestHostname = (req.headers.get("host") || "").replace(/:\d+$/, "").toLowerCase()
    if (requestHostname && requestHostname === publicMcpFqdn()) {
      return await handlePublicMcp(req, url, controlServer)
    }

    // Functions: every request for a function's host is the function's,
    // whatever its method or path (bound-domain login pages excepted)
    const fnTarget = fnForRequest(requestHostname, url.pathname)
    if (fnTarget) {
      return await serveFunction(req, url, fnTarget.name, fnTarget.binding, controlServer)
    }

    // API mode: every request for such a server's host is the server's,
    // whatever its method or path: held until it's up, then forwarded as-is.
    // Before any route below, so none of them can answer in its place.
    // api-mode-gate
    const apiAnswer = await apiModeGate(req, url)
    if (apiAnswer) return apiAnswer

    const hostHeader = req.headers.get("host") || ""
    const boundDomainMatch = resolveBindingFromHost(hostHeader)
    const isBoundDomain = !!boundDomainMatch
    const portalHost = isPortalRequest(req)
    // A site's own hosts (<name>.localhost / .candy, action hosts, bound domains):
    // pages and lazy start, never the control API. Everything else is the portal
    // or a direct control request (CLI, SDK, MCP on localhost:9999), behind the guard.
    const siteHost = !portalHost && (isBoundDomain || /\.(localhost|candy)(:\d+)?$/i.test(hostHeader))

    // Not before this point: a function's or site's own request body and paths are theirs
    lowerRequestNames(req, url)

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

    // === Network Discovery API (unauthenticated, Tailscale-protected) ===
    // Peers post to this machine's address and the portal reads the registry: never a site's host
    const isCandyApi = !siteHost && url.pathname.startsWith("/candy/")
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
      return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
    }

    // The portal answers credentialed CORS only for its own pages, not every *.localhost
    if (portalHost && origin) {
      let originHost = ""
      try { originHost = new URL(origin).host } catch {}
      if (!isPortalHost(originHost)) corsHeaders["Access-Control-Allow-Origin"] = ""
    }
    if (isBoundDomain && boundDomainMatch && !url.pathname.startsWith("/candy-auth/")) {
      const authResponse = await requireBoundDomainAuth(req, controlServer, boundDomainMatch.binding)
      if (authResponse) return authResponse
    }

    let auth: RequestAuth | null = null
    // Set when a site's own page acts on that site without a login (see siteAction)
    let pageHost: string | null = null

    if (siteHost) {
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
                const proxyHeaders = upstreamRequestHeaders(req.headers, false)
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
      if (!isBoundDomain) {
        const name = siteNameForHost(hostHeader)
        if (siteAction(req, url, name)) pageHost = name
      }
      if (!pageHost) {
        if (req.method === "GET" || req.method === "HEAD") return await serveSitePage(req, url, corsHeaders, null)
        if (isBoundDomain) return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
        return Response.json({ error: "login required" }, { status: 401, headers: { ...corsHeaders, "X-Candy-Login": "required" } })
      }
    } else {
      // A browser opening a portal page: the shell, which asks again with the session secret
      if (portalHost && PORTAL_PAGES.has(url.pathname) && !req.headers.get(SESSION_HEADER) && wantsHtml(req.method, req.headers.get("accept"))) {
        return new Response(Bun.file(import.meta.dir + "/public/portal-shell.html"), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Vary": SESSION_HEADER },
        })
      }
      // === The guard: every control route is in ROUTE_TABLE, or it's denied ===
      auth = await requestAuth(req)
      const verdict = guardRequest({
        cls: classifyRoute(ROUTE_TABLE, req.method, url.pathname),
        auth,
        portalHost,
        // The shell's own request (with the header) wants a 401, not a redirect
        html: wantsHtml(req.method, req.headers.get("accept")) && !req.headers.get(SESSION_HEADER),
        path: url.pathname,
        search: url.search,
      })
      if (!verdict.ok) {
        if (verdict.status === 302) return new Response(null, { status: 302, headers: { Location: verdict.location, "Cache-Control": "no-store" } })
        const loginHeader: Record<string, string> = verdict.status === 401 ? { "X-Candy-Login": "required" } : {}
        const stepUp = verdict.status === 403 && verdict.superuserNeedsPassword ? { superuserNeedsPassword: true } : {}
        return Response.json({ error: verdict.error, ...stepUp }, { status: verdict.status, headers: { ...corsHeaders, ...loginHeader } })
      }
      // === API Routes require token validation ===
      // Anything that changes state from the portal: sent by a portal page (Origin),
      // and carrying that page's token, minted for this very login
      if (portalHost && req.method !== "GET" && req.method !== "HEAD") {
        if (!sameOrigin(req.headers, isPortalHost)) {
          return Response.json({ error: "Cross-site request refused." }, { status: 403, headers: corsHeaders })
        }
        if (auth?.via === "portal" && !TOKENLESS_ROUTES.has(url.pathname) && !pageTokens.consume(req.headers.get("X-Candy-Token"), auth.sessionId)) {
          return unauthorizedResponse(corsHeaders)
        }
      }
    }
    const isMCP = auth?.via === "apikey" || auth?.via === "oauth"
    // Who the audit log says did it: the authenticated user, with X-Candy-Actor only as a label after the name
    const requestActor: Actor = pageHost !== null ? 'Page' : auditActor(auth, req.headers.get('X-Candy-Actor'))
    // Acting on a site by name: its user or a superuser, or the site's own page
    const mayUse = (name: string): boolean => pageHost !== null ? name === pageHost : mayChangeName(auth, name)
    const notYoursResponse = (name: string, verb = "change it") =>
      Response.json({ success: false, error: `${name} belongs to ${nameOwner(name)}. Only they can ${verb}.` }, { status: 403, headers: corsHeaders })
    // Sites whose route or process uses `port`
    const portUsers = (port: number): string[] => [
      ...[...routes].filter(([, r]) => r.target === port).map(([n]) => n),
      ...[...processes].filter(([, p]) => p.port === port).map(([n]) => n),
    ]
    // _audit and _caddy cover every user: superusers only
    const mayReadLog = (name: string): boolean => {
      const target = logFileFor(name)
      if (!target) return false
      return target.system ? !!auth?.superuser : mayUse(name)
    }
    // A binding is its site's; once the site is gone (orphaned), its recorded owner's
    const mayUseBinding = (b: DomainBinding): boolean => b.orphaned ? mayActOn(auth, bindingOwner(b)) : mayUse(b.serverName)
    const denyBinding = (key: string): Response | null => {
      const b = domainConfig?.bindings?.[key]
      if (!b || mayUseBinding(b)) return null
      return Response.json({ error: `${b.fqdn} serves ${b.serverName}, which belongs to ${nameOwner(b.serverName)}.` }, { status: 403, headers: corsHeaders })
    }

    // === Portal login ===
    if (req.method === "GET" && url.pathname === "/login") {
      if (!portalHost) return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
      const next = safeNext(url.searchParams.get("next"))
      if (auth?.via === "portal") return new Response(null, { status: 302, headers: { Location: next, "Cache-Control": "no-store" } })
      const rawHtml = await Bun.file(import.meta.dir + "/public/portal-login.html").text()
      // Passkey login works without PAM installed
      const vars = { next, available: pamReady, passkeys: true }
      const html = rawHtml.replace('<script>', `<script>window.CANDY_VARS=${scriptJson(vars)};</script><script>`)
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
    }

    if (req.method === "GET" && url.pathname === "/auth/users") {
      if (!portalHost) return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
      return Response.json({ users: await loginUsers().catch(() => []), available: pamReady, passkeys: true }, { headers: { ...corsHeaders, "Cache-Control": "no-store" } })
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      if (!portalHost) return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
      const body = await req.json().catch(() => ({})) as { user?: unknown; password?: unknown }
      const { ip, userAgent } = getFingerprint(req, controlServer)
      const outcome = await attemptLogin(loginDeps, { user: body.user, password: body.password, ip })
      if (!outcome.ok) return Response.json(outcome.body, { status: outcome.status, headers: { ...corsHeaders, "Cache-Control": "no-store" } })
      // A fresh session id on every login, never one handed in
      const old = portalSessions.get(readSessionCookie(req.headers.get("cookie")), req.headers.get(SESSION_HEADER))
      if (old) { portalSessions.destroy(old.id); pageTokens.dropSession(old.id) }
      const { cookie, secret } = portalSessions.create(outcome.user, { ip, ua: userAgent })
      // `session` goes to the login page's localStorage (this exact origin only) and comes back as X-Candy-Session
      return Response.json({ user: outcome.user, superuser: outcome.superuser, session: secret }, {
        headers: { ...corsHeaders, "Cache-Control": "no-store", "Set-Cookie": sessionCookieHeader(cookie, isHttps(req)) },
      })
    }

    if (req.method === "POST" && url.pathname === "/auth/logout") {
      const session = portalHost ? portalSessions.get(readSessionCookie(req.headers.get("cookie")), req.headers.get(SESSION_HEADER)) : null
      if (session) {
        portalSessions.destroy(session.id)
        pageTokens.dropSession(session.id)
        const { ip } = getFingerprint(req, controlServer)
        auditLog('AUTH_LOGOUT', `${session.user} from ${ip}`, 'Portal')
      }
      return Response.json({ success: true }, {
        headers: { ...corsHeaders, "Cache-Control": "no-store", "Set-Cookie": clearSessionCookieHeader(isHttps(req)) },
      })
    }

    if (req.method === "GET" && url.pathname === "/auth/me") {
      return Response.json({ user: auth!.user, superuser: auth!.superuser, superuserNeedsPassword: auth!.superuserNeedsPassword === true, superuserUntil: superuserUntil(auth!), via: auth!.via, amr: auth!.amr, multiUser: RUNNING_AS_ROOT }, { headers: { ...corsHeaders, "Cache-Control": "no-store" } })
    }

    // === Sign in with candy, and passkeys (app-auth-routes.ts) ===
    // After the guard: the class, the login, and for state-changing portal
    // requests sameOrigin and the page token (passkey login is TOKENLESS)
    if (url.pathname === "/app-auth/authorize" || url.pathname === "/app-auth/consent" || url.pathname === "/app-auth/decision"
      || url.pathname === "/app-auth/sites" || url.pathname === "/app-auth/rotate"
      || url.pathname === "/app-auth/consents" || url.pathname === "/app-auth/consents/revoke"
      || url.pathname === "/auth/passkey/options" || url.pathname === "/auth/passkey" || url.pathname === "/auth/reauth"
      || url.pathname === "/passkeys" || url.pathname === "/passkeys/list" || url.pathname === "/passkeys/register/options"
      || url.pathname === "/passkeys/register" || url.pathname === "/passkeys/rename" || url.pathname === "/passkeys/delete") {
      const answer = await appAuthRoutes.handle(req, url, appAuthContext(req, auth, portalHost, corsHeaders, requestActor))
      return answer ?? Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
    }

    // Where the shortcut hosts (<name>.k / <name>.p) send the browser: a
    // confirmation page on GET; the action only on POST, which the guard has
    // held to a portal page's Origin and token. The site's user or a superuser.
    if (url.pathname === "/go/kill" || url.pathname === "/go/portal") {
      const shortcut: ShortcutAction = url.pathname === "/go/kill" ? "kill" : "portal"
      if (!portalHost || auth?.via !== "portal") return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
      const isPost = req.method === "POST"
      const body = isPost ? await req.json().catch(() => ({})) as { name?: unknown } : null
      const name = String((isPost ? body?.name : url.searchParams.get("name")) ?? "")
      const serviceHost = `${name}.${/\.candy(:\d+)?$/i.test(hostHeader) ? "candy" : "localhost"}`
      const token = () => pageTokens.mint(auth!.sessionId!)
      const refuse = (error: string, status: number, extra: Record<string, unknown> = {}) => isPost
        ? Response.json({ error }, { status, headers: corsHeaders })
        : shortcutPage("confirm-action.html", { action: shortcut, name, serviceHost, error, ...extra }, status)
      if (!isSafeName(name) || isReserved(name)) return refuse("That isn't a site name.", 400)
      if (!nameInUse(name)) return refuse(`There's no site called ${name}.`, 404)
      if (!mayUse(name)) return refuse(`${name} belongs to ${nameOwner(name)}. Only they or a superuser can ${shortcut === "kill" ? "stop it" : "open a tunnel to it"}.`, 403)
      const proc = processes.get(name)

      if (shortcut === "kill") {
        const up = proc?.status === "running" || proc?.status === "starting"
        if (isPost) {
          const stopped = up ? await stopProcess(name, requestActor) : true
          return Response.json(stopped ? { success: true } : { success: false, error: `${name} didn't stop.` }, { status: stopped ? 200 : 500, headers: corsHeaders })
        }
        // Already stopped (or just stopped by the POST): the result page
        if (!up) return shortcutPage("killed.html", { name, serviceHost })
        return shortcutPage("confirm-action.html", { action: "kill", name, serviceHost }, 200, token())
      }

      const open = portals.get(name)
      if (open) {
        if (isPost) return Response.json({ success: true, url: open.url ?? null }, { headers: corsHeaders })
        return shortcutPage("portaling.html", { name, serviceHost, existingUrl: open.url || "" })
      }
      const port = proc?.status === "running" ? proc.port : null
      if (!port) return refuse(`${name} isn't running.`, 409, { notRunning: true })
      if (!isPost) return shortcutPage("confirm-action.html", { action: "portal", name, serviceHost }, 200, token())
      // A tunnel puts the port on the internet: not one another user's site also uses
      const portUser = portUsers(port).find(n => !mayUse(n))
      if (portUser) return notYoursResponse(portUser, "open a tunnel to it")
      auditLog('PORTAL_CREATE', `${name} (from the ${name}.p shortcut)`, requestActor)
      const result = await openPortalForName({ name, port, user: auth!.user })
      return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: corsHeaders })
    }

    // Consent for a public MCP client. Only on the portal's own host, which is
    // served on the tailnet (portal.candy) and this machine (portal.localhost).
    // Approving needs a portal login (an API key can't approve), and the grant acts as that user.
    if (url.pathname.startsWith("/oauth/")) {
      const oauth = portalHost && auth?.via === "portal" ? await getMcpOAuth() : null
      if (!oauth) return new Response("Not found", { status: 404 })

      if (req.method === "GET" && url.pathname === "/oauth/consent") {
        const rawHtml = await Bun.file(import.meta.dir + "/public/authorize.html").text()
        // A portal session token, so only this page load can answer
        const vars = { user: auth!.user, superuser: auth!.superuser }
        const html = rawHtml.replace('<script>', `${portalPageScript(pageTokens.mint(auth!.sessionId!), vars)}<script>`)
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
          user: auth!.user,
        }, { headers: { "Cache-Control": "no-store" } })
      }
      if (req.method === "POST" && url.pathname === "/oauth/decision") {
        const body = await req.json().catch(() => ({})) as { request?: string; allow?: boolean }
        const { ip } = getFingerprint(req, controlServer)
        const approver = await tailnetIdentity(ip)
        const pending = oauth.getRequest(body.request || "")
        const result = oauth.decide(body.request || "", body.allow === true, auth!.user, approver)
        if (!result.ok) return Response.json({ error: result.error_description }, { status: result.status })
        auditLog(body.allow === true ? 'MCP_PUBLIC_ALLOW' : 'MCP_PUBLIC_DENY', `"${pending?.clientName ?? '?'}" as ${auth!.user} by ${approver}`, 'Portal')
        const back = new URL(`https://${publicMcpFqdn()}/authorize/complete`)
        back.searchParams.set("request", body.request || "")
        back.searchParams.set("grant", result.grant)
        return Response.json({ redirect: back.toString() })
      }
      return new Response("Not found", { status: 404 })
    }

    // === Bound domain auth management (the site's user or a superuser) ===

    if (req.method === "POST" && url.pathname === "/auth/set") {
      const isMcpRequest = isMCP

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
      const notYours = denyBinding(bindingKey)
      if (notYours) return notYours

      const ok = await setBindingAuth(bindingKey, { password: password || undefined, jwtSecret })
      if (!ok) {
        return Response.json({ error: `No binding found for '${bindingKey}'` }, { status: 404, headers: corsHeaders })
      }
      // Resync caddy to add forward_auth
      await syncCaddy()
      const label = domainConfig?.bindings?.[bindingKey]?.fqdn || bindingKey
      const actor: Actor = requestActor
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
      const isMcpRequest = isMCP

      const { subdomain, domain, which } = await req.json() as { subdomain?: string; domain?: string; which?: 'password' | 'jwt' | 'all' }
      if (!subdomain && !domain) {
        return Response.json({ error: "domain (or subdomain) required" }, { status: 400, headers: corsHeaders })
      }

      const bindingKey = resolveBindingKey(subdomain, domain)
      if (!bindingKey) {
        const target = domain || subdomain || '(unknown)'
        return Response.json({ error: `No binding found for '${target}'` }, { status: 404, headers: corsHeaders })
      }
      const notYours = denyBinding(bindingKey)
      if (notYours) return notYours

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
      const actor: Actor = requestActor
      auditLog('AUTH_CLEAR', `Password cleared for ${label}`, actor)
      return Response.json({ success: true, message: `Password cleared for ${label}` }, { headers: corsHeaders })
    }

    // Allowlist mode for a bound domain: only listed IPs/CIDRs, Tailscale and this machine
    if (req.method === "POST" && url.pathname === "/domains/allowlist") {
      const isMcpRequest = isMCP
      const body = await req.json().catch(() => ({})) as { subdomain?: string; domain?: string; enabled?: boolean; ips?: string[]; add?: string[]; remove?: string[] }
      const bindingKey = resolveBindingKey(body.subdomain, body.domain)
      const binding = bindingKey ? domainConfig?.bindings?.[bindingKey] : undefined
      if (!binding) {
        return Response.json({ error: `No binding found for '${body.domain || body.subdomain || '(unknown)'}'` }, { status: 404, headers: corsHeaders })
      }
      const notYours = denyBinding(bindingKey!)
      if (notYours) return notYours
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
      const actor: Actor = requestActor
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
      const isMcpRequest = isMCP
      const { subdomain, domain, ttl, jti } = await req.json().catch(() => ({})) as { subdomain?: string; domain?: string; ttl?: number; jti?: boolean | string }
      const bindingKey = resolveBindingKey(subdomain, domain)
      const binding = bindingKey ? domainConfig?.bindings?.[bindingKey] : undefined
      if (!binding) {
        return Response.json({ error: `No binding found for '${domain || subdomain || '(unknown)'}'` }, { status: 404, headers: corsHeaders })
      }
      if (!binding.auth?.jwtSecret) {
        return Response.json({ error: `${binding.fqdn} has no JWT secret. Set one first.` }, { status: 400, headers: corsHeaders })
      }
      // Only the site's own user (or a superuser) may mint tokens for it
      const notYours = denyBinding(bindingKey!)
      if (notYours) return notYours
      const lifetime = Math.min(Math.max(Math.floor(Number(ttl) || 600), 1), MAX_TOKEN_LIFETIME_S)
      const now = Math.floor(Date.now() / 1000)
      const claims: Record<string, unknown> = { aud: JWT_AUDIENCE, sub: `${binding.serverName}.candy`, iat: now, nbf: now, exp: now + lifetime }
      if (jti) claims.jti = typeof jti === "string" ? jti : crypto.randomUUID()
      auditLog('AUTH_TOKEN', `Token minted for ${binding.fqdn} (${lifetime}s${claims.jti ? ', single use' : ''})`, isMcpRequest ? 'AI' : 'Portal')
      return Response.json({ token: signJwt(claims, binding.auth.jwtSecret), claims }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/auth/status") {
      const domains: Record<string, any> = {}
      if (domainConfig?.bindings) {
        for (const [sub, binding] of Object.entries(domainConfig.bindings)) {
          if (!mayChangeName(auth, binding.serverName)) continue
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

    // === Page token refresh: only for a chain minted for this login ===
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await req.json().catch(() => ({})) as { token?: string }
      const newToken = pageTokens.refresh(body.token, auth?.sessionId)
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

    // === Functions API ===
    // Request logs hold request data: never on a site's host (siteHost never gets here)
    if (url.pathname.startsWith("/fn/")) {
      return await handleFnApi(req, url, corsHeaders, controlServer, auth!)
    }

    // === SDK API ===
    // Always an API key (from inside a server candy started), never a portal login
    if (url.pathname.startsWith("/sdk/") && auth?.via !== "apikey") {
      return unauthorizedResponse(corsHeaders)
    }

    // The site's auth key ring, for its owner's own process (sdk.ts appAuth): app-auth-routes.ts
    if (req.method === "POST" && url.pathname === "/sdk/auth/keys") {
      const answer = await appAuthRoutes.handle(req, url, appAuthContext(req, auth, portalHost, corsHeaders, requestActor))
      return answer ?? Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/sdk/runtime") {
      const { configId, pid } = await req.json() as { configId?: string; pid?: number }
      if (!configId) {
        return Response.json({ error: "configId is required" }, { status: 400, headers: corsHeaders })
      }

      const managed = await resolveManagedRuntime(configId, pid)
      if (!managed || !mayChangeConfig(auth, managed.config)) {
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
      const refusal = nameInUse(name) ? null : newNameRefusal(name)
      if (refusal) return Response.json({ error: refusal, details: name }, { status: 403, headers: corsHeaders })

      if (!await isPidRunning(pid)) {
        return Response.json({ error: `PID ${pid} is not running.` }, { status: 400, headers: corsHeaders })
      }

      if (serverConfigs.has(name)) {
        return Response.json({ error: `Namespace '${name}' belongs to a managed candy server.` }, { status: 409, headers: corsHeaders })
      }
      const boundElsewhere = boundToSomeoneElse(name, auth)
      if (boundElsewhere) return Response.json({ error: boundElsewhere }, { status: 409, headers: corsHeaders })

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
      await setRouteUser(name, auth!.user)
      await syncCaddy()
      if (persistent === true) await savePersistentRoutes()

      log("ADD", `${name}.localhost -> :${port} (pid ${pid})`, name)
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
        if (!managed || !mayChangeConfig(auth, managed.config)) {
          return Response.json({ error: "That candy runtime is not active." }, { status: 404, headers: corsHeaders })
        }
        if (!managed.port) {
          return Response.json({ error: `Server '${managed.name}' is running but has no detected port yet.` }, { status: 400, headers: corsHeaders })
        }

        const result = await openPortalForName({ name: managed.name, port: managed.port, user: auth!.user })
        return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: corsHeaders })
      }

      if (!name || !pid) {
        return Response.json({ error: "name and pid are required when not running inside candy." }, { status: 400, headers: corsHeaders })
      }

      const port = await getPidOwnedRoutePort(name, pid)
      if (!port || !mayUse(name)) {
        return Response.json({ error: `PID ${pid} does not own '${name}'.` }, { status: 403, headers: corsHeaders })
      }

      const result = await openPortalForName({ name, port, user: auth!.user })
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
      if (!mayChangeConfig(auth, managed.config)) {
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

      if (fnConfigOf(name)) {
        return Response.json({ error: `'${name}' is a function; it has no port to route to.`, details: name }, { status: 409, headers: corsHeaders })
      }
      const boundElsewhere = boundToSomeoneElse(name, auth)
      if (boundElsewhere) return Response.json({ error: boundElsewhere, details: name }, { status: 409, headers: corsHeaders })
      if (typeof body.target === "string" && /^https?:\/\//.test(body.target) && !isCaddyUpstream(body.target, ownAddresses())) {
        return Response.json({ error: "The address must be http(s)://host[:port], without a path, and not this machine (use a port for a local server).", details: body.target }, { status: 400, headers: corsHeaders })
      }
      const wasInUse = nameInUse(name)
      if (wasInUse && !mayUse(name)) return notYoursResponse(name, "route it")
      const refusal = wasInUse ? null : newNameRefusal(name)
      if (refusal) return Response.json({ error: refusal, details: name }, { status: 403, headers: corsHeaders })
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
      if (!wasInUse) await setRouteUser(name, auth!.user)
      await syncCaddy()
      if (persistent) await savePersistentRoutes()

      log("ADD", `${name}.localhost -> ${isRestricted ? routeTarget : ":" + routeTarget}`, name)
      return Response.json({ domain: `${name}.localhost`, status: "registered", message: "Route added" }, { headers: corsHeaders })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/register/")) {
      const name = lowerName(url.pathname.split("/")[2])
      if (isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }
      if (!routes.has(name)) {
        return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
      }
      if (!mayUse(name)) return notYoursResponse(name, "remove it")

      // Also stop the associated process if running
      const actor = requestActor
      const proc = processes.get(name)
      if (proc && (proc.status === 'running' || proc.status === 'starting')) {
        await stopProcess(name, actor)
      }

      const wasRoute = routes.get(name)
      routes.delete(name)
      releasePidOwnedRoute(name)
      if (!serverConfigs.has(name)) await setRouteUser(name, null)
      if (!nameInUse(name)) await dropAppAuth(name, actor)
      await forgetLanPublishedIfGone(name)
      await syncCaddy()
      if (wasRoute?.persistent) await savePersistentRoutes()
      const m = msg.removed
      log("REMOVE", `${name}.localhost`, name)
      return Response.json({ status: "removed", message: m }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/rename") {
      const { oldName, newName } = await req.json() as { oldName: string, newName: string }

      if (isReserved(oldName) || isReserved(newName)) {
        return Response.json({ error: "That name is reserved.", details: "portal" }, { status: 403, headers: corsHeaders })
      }
      const refusal = nameInUse(newName) ? null : newNameRefusal(newName)
      if (refusal) return Response.json({ error: refusal, details: newName }, { status: 403, headers: corsHeaders })
      if (!routes.has(oldName)) {
        return Response.json({ error: msg.notFound, details: oldName }, { status: 404, headers: corsHeaders })
      }
      if (!mayUse(oldName)) return notYoursResponse(oldName, "rename it")
      const boundElsewhere = boundToSomeoneElse(newName, auth)
      if (boundElsewhere) return Response.json({ error: boundElsewhere, details: newName }, { status: 409, headers: corsHeaders })
      if (serverConfigs.has(newName) || processes.has(newName)) {
        return Response.json({ error: `A site named '${newName}' already exists.`, details: newName }, { status: 409, headers: corsHeaders })
      }
      if (fnConfigOf(oldName) || fnConfigOf(newName)) {
        return Response.json({ error: "Functions can't be renamed. Add it under the new name and remove the old one." }, { status: 409, headers: corsHeaders })
      }
      if (routes.has(newName)) {
        return Response.json({ error: `A route named '${newName}' already exists.`, details: newName }, { status: 409, headers: corsHeaders })
      }

      const routeData = routes.get(oldName)!
      const routeUser = nameOwner(oldName)
      routes.delete(oldName)
      routes.set(newName, routeData)
      if (!serverConfigs.has(oldName)) await setRouteUser(oldName, null)
      if (!nameInUse(oldName)) await dropAppAuth(oldName, requestActor)
      await setRouteUser(newName, routeUser)
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
      log("RENAME", `${oldName} -> ${newName}`, newName)
      return Response.json({ status: "renamed", oldName, newName, message: m }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/routes") {
      const routeList: Record<string, { target: RouteTarget, isRestricted: boolean, persistent: boolean, lan: boolean, lanHttps: string | null, tsServe: string | null }> = {}
      for (const [name, route] of routes) {
        if (isReserved(name) || !mayUse(name)) continue  // hide reserved, and other users' routes
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
        .filter(name => !isReserved(name) && mayUse(name))
        .sort((a, b) => a.localeCompare(b))
      return Response.json({
        lanIp,
        tailnetHost: getTailnetHostname(),
        published: [...lanPublished].filter(mayUse).sort(),
        names: Object.fromEntries(names.map(name => [name, isLanPublished(name)])),
        https: Object.fromEntries([
          ...[...lanHttps].filter(([name]) => mayUse(name)).map(([name, port]) => [name, { mode: "tailscale", port, url: lanHttpsUrl(name) }]),
          ...[...lanDomainHttps].filter(mayUse).map(name => [name, { mode: "domain", port: null, url: lanHttpsUrl(name) }]),
        ]),
      }, { headers: corsHeaders })
    }

    if (url.pathname === "/routes/serve") {
      if (req.method === "GET") {
        return Response.json({
          tailnetHost: getTailnetHostname(),
          serves: Object.fromEntries([...tsServes].filter(([name]) => mayUse(name)).map(([name, port]) => [name, { port, url: tsServeUrl(name), entryPort: entryPorts.get(name) ?? null }])),
        }, { headers: corsHeaders })
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { name?: string; port?: number | null }
        const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : ""
        if (!name || isReserved(name)) return Response.json({ error: "A valid name is required." }, { status: 400, headers: corsHeaders })
        if (!routes.has(name) && !serverConfigs.has(name)) return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
        const actor = requestActor
        const result = await setTsServe(name, body.port === null || body.port === undefined ? null : Number(body.port), actor)
        if (!result.ok) return Response.json({ error: result.error }, { status: 409, headers: corsHeaders })
        return Response.json({ name, port: tsServes.get(name) ?? null, url: result.url, entryPort: entryPorts.get(name) ?? null }, { headers: corsHeaders })
      }
    }

    if (url.pathname === "/routes/entry") {
      if (req.method === "GET") {
        return Response.json({ entries: Object.fromEntries([...entryPorts].filter(([name]) => mayUse(name))) }, { headers: corsHeaders })
      }
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({})) as { name?: string; port?: number | null }
        const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : ""
        if (!name || isReserved(name)) return Response.json({ error: "A valid name is required." }, { status: 400, headers: corsHeaders })
        if (!routes.has(name) && !serverConfigs.has(name)) return Response.json({ error: msg.notFound, details: name }, { status: 404, headers: corsHeaders })
        if (!mayUse(name)) return notYoursResponse(name)
        const actor = requestActor
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

    // Superuser only (ROUTE_TABLE)
    if (url.pathname === "/lan/adguard") {
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
            const served = await setTsServe(key, port, requestActor)
            if (!served.ok) auditLog('TS_SERVE_SKIP', `${key} :${port}: ${served.error}`, 'System')
          }
        }
      } else if (body.https === false && lanHttpsMode(key)) {
        lanHttps.delete(key)
        lanDomainHttps.delete(key)
        httpsChange = "off"
      }

      const actor = requestActor
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
      log(publish ? "LAN" : "UNLAN", `${name}.candy${publish && lanIp ? ` -> ${lanIp}` : ""}${httpsUrl ? ` + ${httpsUrl}` : ""}`, name)
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
      // A tunnel puts a site on the internet: only your own, or a port nobody else's site uses
      if (name && nameInUse(name) && !mayUse(name)) return notYoursResponse(name, "open a tunnel to it")
      const portUser = portUsers(port).find(n => !mayUse(n))
      if (portUser) return notYoursResponse(portUser, "open a tunnel to it")

      const result = await openPortalForName({ name, port, openBrowser, user: auth!.user })
      return Response.json(result.body, { status: result.ok ? 200 : result.status, headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/portal/batch") {
      const { targets } = await req.json() as { targets?: (string | number)[] }

      const batchTargets: { name: string, port: number }[] = []

      if (!targets || targets.length === 0) {
        // Everything you may open: your own routes (a superuser's: all of them)
        for (const [name, route] of routes) {
          if (typeof route.target !== "number" || !mayUse(name)) continue
          if (!portals.has(name)) batchTargets.push({ name, port: route.target as number })
        }
        if (batchTargets.length === 0) {
          return Response.json({ error: msg.noRoutes }, { status: 400, headers: corsHeaders })
        }
      } else {
        for (const arg of targets) {
          if (typeof arg === "number") {
            const port = arg
            if (portUsers(port).some(n => !mayUse(n))) continue
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
            if (existingPortal || batchTargets.some(t => t.port === port)) continue
            let anonCounter = 1
            while (portals.has(`anon-${anonCounter}`) || batchTargets.some(t => t.name === `anon-${anonCounter}`)) anonCounter++
            batchTargets.push({ name: `anon-${anonCounter}`, port })
          } else {
            const routeData = routes.get(arg)
            if (!routeData || typeof routeData.target !== "number" || !mayUse(arg)) continue
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
          if (!nameInUse(name)) await setRouteUser(name, auth!.user)  // anon-N: a port, no route
          // Track tunnel -> server mapping for stats history
          tunnelHistory.set(url.replace('https://', ''), name)
          log("PORTAL", `${name} -> ${url}`, name)
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
        if (!mayUse(name)) continue
        portalList[name] = url ? { port, url } : { port }
      }
      return Response.json(portalList, { headers: corsHeaders })
    }

    // Get single portal status (for polling from portaling.html)
    if (req.method === "GET" && url.pathname.startsWith("/portal/status/")) {
      const name = lowerName(url.pathname.split("/")[3])
      const portal = portals.get(name)
      if (!portal || !mayUse(name)) {
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
      const name = lowerName(url.pathname.split("/")[3])
      const toClose = portals.get(name)

      if (!toClose) {
        return Response.json({ error: msg.notFound, details: `portal: ${name}` }, { status: 404, headers: corsHeaders })
      }
      if (!mayUse(name)) return notYoursResponse(name, "close its tunnel")

      if (toClose.proc) {
        try { toClose.proc.kill() } catch {}
      } else if (toClose.pid) {
        await terminateProcessTree(toClose.pid, 3000)
      }
      portals.delete(name)
      if (!nameInUse(name)) await setRouteUser(name, null)
      await syncCaddy()

      const m = msg.portalClosed
      log("CLOSE", name, name)
      return Response.json({ status: "closed", name, message: m }, { headers: corsHeaders })
    }

    // === Logs & Stats ===

    if (req.method === "GET" && url.pathname === "/logs") {
      const count = parseInt(url.searchParams.get("count") || "20")
      // Entries about your own sites; daemon-wide ones (no name) for superusers
      const visible = auth!.superuser ? activityLog : activityLog.filter(e => e.name !== undefined && mayUse(e.name))
      return Response.json({
        logs: visible.slice(-count).map(e => ({
          time: e.time.toISOString(),
          action: e.action,
          details: e.details
        })),
        total: visible.length
      }, { headers: corsHeaders })
    }

    // Process logs: /logs/:name?mode=tail|head|search&lines=50&pattern=error&context=2
    if (req.method === "GET" && url.pathname.startsWith("/logs/")) {
      const name = lowerName(url.pathname.slice(6)) // strip "/logs/"
      if (!name) {
        return Response.json({ error: "Missing process name" }, { status: 400, headers: corsHeaders })
      }
      if (!mayReadLog(name)) return notYoursResponse(name, "read its log")
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
      const totalReqs = [...caddyHits].filter(([d]) => auth!.superuser || mayUse(tunnelHistory.get(d) ?? d)).reduce((a, [, b]) => a + b.total, 0)
      const sessionStart = activityLog[0]?.time || new Date()

      // Use tunnelHistory for tunnel -> server mapping (includes dead tunnels)
      const tunnelToServer = tunnelHistory

      // Build domains list with children
      const domainsMap = new Map<string, { name: string, total: number, alive: boolean, children: { name: string, url: string, total: number, alive: boolean }[] }>()

      for (const [domain, { total }] of caddyHits) {
        // Skip reserved names (portal, kill, etc), and other users' sites
        if (isReserved(domain)) continue

        const serverName = tunnelToServer.get(domain)
        if (!mayUse(serverName ?? domain)) continue
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
      const domain = lowerName(url.pathname.split("/")[2])
      if (!mayUse(tunnelHistory.get(domain) ?? domain)) return notYoursResponse(domain, "see its traffic")
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
      // Running as another account is for superusers; everyone else sees only themselves
      const accounts = (await runAsUsers()).filter(a => auth!.superuser || a.name === auth!.user)
      return Response.json({
        owner: OWNER,
        you: auth!.user,
        superuser: auth!.superuser,
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
      const m = msg.exit  // superuser only (ROUTE_TABLE)
      setTimeout(async () => {
        await cleanup()
        process.exit(0)
      }, 100)
      return Response.json({ status: "shutting_down", message: m }, { headers: corsHeaders })
    }

    // === System monitor: the whole machine, not only candy's servers ===
    // Superuser only (ROUTE_TABLE), and only from a portal login: it reads every
    // process and acts with the daemon's own rights (root, when installed as a service).
    if (url.pathname.startsWith("/system/")) {
      if (!portalHost || auth?.via !== "portal" || !auth.superuser) {
        return Response.json({ error: "Only a superuser, logged in to the portal, can do that." }, { status: 403, headers: corsHeaders })
      }
      const noStore = { ...corsHeaders, "Cache-Control": "no-store" }

      if (req.method === "GET" && url.pathname === "/system/stats") {
        const snap = await systemMonitor.snapshot()
        // Which units are candy's own servers, so the page can say so
        const candy: Record<string, string> = {}
        for (const [name, proc] of processes) if (proc.unit) candy[proc.unit] = name
        return Response.json({ ...snap, root: RUNNING_AS_ROOT, self: process.pid, ownUnit: OWN_UNIT, candy }, { headers: noStore })
      }

      if (req.method === "POST" && url.pathname === "/system/kill") {
        const body = await req.json().catch(() => ({})) as { pid?: unknown; start?: unknown; signal?: unknown }
        const pid = Number(body.pid), start = Number(body.start)
        const signal = String(body.signal ?? "TERM").toUpperCase()
        if (!(SIGNALS as readonly string[]).includes(signal)) return Response.json({ error: "Choose TERM or KILL." }, { status: 400, headers: noStore })
        if (!Number.isInteger(pid) || !Number.isFinite(start)) return Response.json({ error: "pid and start are required." }, { status: 400, headers: noStore })
        // The very process the page showed: same pid and start time, so a reused pid is never hit
        const target = await systemMonitor.find(pid, start)
        if (!target) return Response.json({ error: `Process ${pid} has already exited.` }, { status: 404, headers: noStore })
        const problem = killProblem(target, process.pid)
        if (problem) return Response.json({ error: problem }, { status: 403, headers: noStore })
        try {
          process.kill(pid, signal === "KILL" ? "SIGKILL" : "SIGTERM")
        } catch (e) {
          return Response.json({ error: `Could not signal ${pid}: ${(e as Error)?.message ?? e}` }, { status: 500, headers: noStore })
        }
        auditLog('SYSTEM_KILL', `SIG${signal} to ${pid} (${auditSafe(target.name)}, ${auditSafe(target.user)})`, requestActor)
        return Response.json({ success: true, pid, signal, name: target.name }, { headers: noStore })
      }

      if (req.method === "POST" && url.pathname === "/system/unit") {
        const body = await req.json().catch(() => ({})) as { unit?: unknown; action?: unknown }
        const unit = String(body.unit ?? ""), action = String(body.action ?? "")
        const problem = unitActionProblem(unit, action, OWN_UNIT)
        if (problem) return Response.json({ error: problem }, { status: isUnitName(unit) ? 403 : 400, headers: noStore })
        // A candy server's unit: through candy, so its state, route and audit trail stay right
        const candyName = [...processes].find(([, p]) => p.unit === unit)?.[0]
        if (candyName && action === "stop") {
          const stopped = await stopProcess(candyName, requestActor)
          return Response.json(stopped ? { success: true, unit, action } : { error: `${candyName} didn't stop.` }, { status: stopped ? 200 : 500, headers: noStore })
        }
        if (candyName) return Response.json({ error: `${unit} is candy's ${candyName}. Restart it from the Sites list.` }, { status: 409, headers: noStore })
        const result = await $`systemctl ${action} --no-block -- ${unit}`.quiet().nothrow()
        auditLog('SYSTEM_UNIT', `${action} ${auditSafe(unit)}${result.exitCode === 0 ? '' : ` (failed, exit ${result.exitCode})`}`, requestActor)
        if (result.exitCode !== 0) {
          return Response.json({ error: result.stderr.toString().trim().split("\n")[0] || `systemctl ${action} failed` }, { status: 500, headers: noStore })
        }
        return Response.json({ success: true, unit, action }, { headers: noStore })
      }

      return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
    }

    // === Process Management API ===

    if (req.method === "GET" && url.pathname === "/processes") {
      const processList: Record<string, any> = {}
      // What a running unit uses and may use, in bytes, from its cgroup (null: no unit, or no limit)
      const cgroupNumber = async (unit: string | null | undefined, file: string): Promise<number | null> => {
        if (!unit || !/^[A-Za-z0-9_.@-]+\.service$/.test(unit)) return null
        const n = Number((await Bun.file(`/sys/fs/cgroup/${SANDBOX_SLICE}/${unit}/${file}`).text().catch(() => "")).trim())
        return Number.isFinite(n) && n > 0 ? n : null
      }
      for (const [name, proc] of processes) {
        if (!mayUse(name)) continue
        const up = proc.status === 'running' || proc.status === 'starting'
        processList[name] = {
          memoryUsed: up ? await cgroupNumber(proc.unit, "memory.current") : null,
          memoryMax: up ? await cgroupNumber(proc.unit, "memory.max") : null,
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

    // Functions have no process of their own: start warms the hot instances,
    // stop and restart send every instance DRAIN
    if (req.method === "POST" && /^\/process\/(start|stop|restart)\//.test(url.pathname) && fnConfigOf(lowerName(url.pathname.split("/")[3]))) {
      const name = lowerName(url.pathname.split("/")[3])
      const op = url.pathname.split("/")[2]
      const config = fnConfigOf(name)!
      if (!mayChangeConfig(auth, config)) {
        return Response.json({ success: false, error: `${name} runs as ${configUser(config)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      const actor = requestActor
      if (op === "stop") await fnRuntimes.get(name)?.stop()
      else if (op === "start") await warmFn(name)  // never disturbs instances that are serving
      else await restartFn(name)
      auditLog(`FN_${op.toUpperCase()}`, name, actor)
      return Response.json({
        success: true,
        data: { name, status: "function", instances: fnRuntimes.get(name)?.instances() ?? [] },
        message: op === "stop" ? `${name}'s instances are stopping; the next request starts one` : `${name} starts on its next request`,
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/process/start/")) {
      const name = lowerName(url.pathname.split("/")[3])
      if (!serverConfigs.has(name)) {
        return Response.json({ success: false, error: `No config for server: ${name}` }, { status: 404, headers: corsHeaders })
      }
      if (!mayUse(name)) return notYoursResponse(name, "start it")
      try {
        const actor = requestActor
        const body = await req.json().catch(() => ({})) as { configId?: string }
        // A site page only starts what's stopped, and never picks (or switches) the variant
        const requestedConfigId = pageHost !== null ? undefined : body?.configId
        const configs = getConfigsForName(name)
        if (configs.length > 1 && !requestedConfigId) {
          return Response.json({
            success: false,
            error: pageHost !== null
              ? `${name} has several start commands. Pick one in the portal.`
              : `Multiple configs found for ${name}. Choose a configId.`,
            configs: pageHost !== null ? undefined : configs.map(c => ({ id: c.id, cwd: c.cwd, cmd: c.cmd }))
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
      const name = lowerName(url.pathname.split("/")[3])
      if (!mayUse(name)) return notYoursResponse(name, "stop it")
      const actor = requestActor
      const success = await stopProcess(name, actor)
      return Response.json({ success }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/process/restart/")) {
      const name = lowerName(url.pathname.split("/")[3])
      if (!mayUse(name)) return notYoursResponse(name, "restart it")
      // A site page restarts only a site that has crashed or exited, never a running one
      const status = processes.get(name)?.status
      if (pageHost !== null && status !== 'errored' && status !== 'dead') {
        return Response.json({ success: false, error: `${name} is ${status ?? "not started"}; restart it from the portal.` }, { status: 409, headers: corsHeaders })
      }
      const actor = requestActor
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
      const name = lowerName(url.pathname.split("/")[3])
      // Never from a site page (siteAction doesn't allow it either): the portal or an API key only
      if (pageHost !== null || !mayUse(name)) return notYoursResponse(name)
      const { port } = await req.json() as { port: number }
      const actor = requestActor
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
      const name = lowerName(url.pathname.split("/")[3])
      const managed = processes.get(name)
      if (!managed) {
        return Response.json({ success: false, error: `Process not found: ${name}` }, { status: 404, headers: corsHeaders })
      }
      if (!managed.terminal) {
        return Response.json({ success: false, error: `Process has no active terminal: ${name}` }, { status: 400, headers: corsHeaders })
      }
      // Typing into a terminal runs commands as its user: that user (or a superuser), never a site page
      if (pageHost !== null || !mayChangeConfig(auth, managed.config)) {
        return Response.json({ success: false, error: `${name} runs as ${configUser(managed.config)}. Only they can type into it.` }, { status: 403, headers: corsHeaders })
      }

      const { input, key } = await req.json() as { input?: string, key?: string }

      // Support both raw input and special keys
      if (input !== undefined) {
        managed.terminal.write(input)
        const actor = requestActor
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
          const actor = requestActor
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
        if (entries.length === 0 || !mayUse(name)) continue
        const first = entries[0]
        configs[name] = {
          id: first.id,
          cwd: first.cwd,
          cmd: first.cmd,
          user: configUser(first),
          api: !!first.api,
          sandbox: SANDBOX_AVAILABLE && first.sandbox !== false,
          envFile: first.envFile ?? null,
          ttl: first.ttl ?? null,
          memory: first.memory ?? null,
          memoryLimit: memoryLimitMb(first.memory),
          rw: first.rw ?? [],
          count: entries.length,
          variants: entries.map(c => ({ id: c.id, cwd: c.cwd, cmd: c.cmd, user: configUser(c), api: !!c.api })),
          lan: isLanPublished(name),
          lanHttps: isLanPublished(name) ? lanHttpsUrl(name) : null,
          tsServe: tsServeUrl(name),
          fn: fnSummaryNow(name),
        }
      }
      return Response.json({ success: true, configs }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config") {
      const { name, cwd, cmd, api, user: runAs, envFile } = await req.json() as { name: string, cwd: string, cmd: string, api?: boolean, user?: string, envFile?: string | null }
      if (isReserved(name)) {
        return Response.json({ error: isSafeName(name) ? "That name is reserved." : "Names can only use letters, numbers, dashes, underscores and dots.", details: name }, { status: isSafeName(name) ? 403 : 400, headers: corsHeaders })
      }
      const refusal = nameInUse(name) ? null : newNameRefusal(name)
      if (refusal) return Response.json({ error: refusal, details: name }, { status: 403, headers: corsHeaders })
      const actor = requestActor
      // Run as yourself, or (a superuser logged in to the portal only) as another member of the candy group
      const requester = auth!.user
      let user = requester
      if (runAs && runAs !== requester) {
        if (!RUNNING_AS_ROOT || !auth!.superuser) {
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
      // A function's name serves only the function (requests go to it by Host)
      if (fnConfigOf(name)) {
        return Response.json({ error: `'${name}' is a function. Remove it first or pick another name.` }, { status: 409, headers: corsHeaders })
      }
      const taken = nameTakenWithoutConfig(name, auth!)
      if (taken) return Response.json({ error: taken }, { status: 409, headers: corsHeaders })
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
      const denied = targets.find(cfg => !mayChangeConfig(auth, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      for (const cfg of targets) setApiFlag(cfg, api)
      await saveServerConfigs()
      await syncCaddy()  // protected domains switch between login page and header auth
      const actor = requestActor
      auditLog('CONFIG_API', `${name}: API mode ${api ? 'on' : 'off'}`, actor)
      return Response.json({ success: true, api, message: `API mode ${api ? 'on' : 'off'} for ${name}` }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config/ttl") {
      const body = await req.json().catch(() => ({})) as { name?: string, configId?: string, minutes?: number | null }
      const { name, configId } = body
      if (!name) return Response.json({ error: "name is required" }, { status: 400, headers: corsHeaders })
      const targets = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      if (targets.length === 0) {
        return Response.json({ error: `No site named '${name}' with a start command.` }, { status: 404, headers: corsHeaders })
      }
      const denied = targets.find(cfg => !mayChangeConfig(auth, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      const minutes = body.minutes === null || body.minutes === undefined ? null : validateTtlMinutes(body.minutes)
      if (body.minutes !== null && body.minutes !== undefined && !minutes) {
        return Response.json({ error: "minutes must be a whole number from 1 to 10080 (a week)." }, { status: 400, headers: corsHeaders })
      }
      for (const cfg of targets) {
        if (minutes) cfg.ttl = minutes
        else delete cfg.ttl
      }
      await saveServerConfigs()
      const actor = requestActor
      auditLog('CONFIG_TTL', `${name}: stops after ${minutes ?? IDLE_TIMEOUT / 60000}min idle${minutes ? '' : ' (default)'}`, actor)
      return Response.json({ success: true, minutes, defaultMinutes: IDLE_TIMEOUT / 60000 }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config/memory") {
      const body = await req.json().catch(() => ({})) as { name?: string, configId?: string, memory?: number | string | null }
      const { name, configId } = body
      if (!name) return Response.json({ error: "name is required" }, { status: 400, headers: corsHeaders })
      const targets = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      if (targets.length === 0) {
        return Response.json({ error: `No site named '${name}' with a start command.` }, { status: 404, headers: corsHeaders })
      }
      const denied = targets.find(cfg => !mayChangeConfig(auth, cfg))
      if (denied) {
        return Response.json({ error: `${name} runs as ${configUser(denied)}. Only they can change it.` }, { status: 403, headers: corsHeaders })
      }
      const reset = body.memory === null || body.memory === undefined
      const mb = reset ? null : validateMemoryMb(body.memory)
      if (!reset && !mb) {
        return Response.json({ error: `The memory limit must be between ${formatMemory(MIN_MEMORY_MB)} and ${formatMemory(MAX_MEMORY_MB)}, like 4G or 512M (a bare number is MB).` }, { status: 400, headers: corsHeaders })
      }
      for (const cfg of targets) {
        if (mb && mb !== DEFAULT_MEMORY_MB) cfg.memory = mb
        else delete cfg.memory
      }
      await saveServerConfigs()
      const limit = memoryLimitMb(mb)
      // A running unit takes the new limit now; otherwise it applies at the next start
      const managed = processes.get(name)
      let live = false
      if (managed?.unit && (managed.status === 'running' || managed.status === 'starting') && targets.some(cfg => cfg.id === managed.config.id)) {
        const [max, swap] = memoryProperties(limit)
        live = (await $`systemctl set-property --runtime ${managed.unit} ${max} ${swap}`.quiet().nothrow()).exitCode === 0
      }
      auditLog('CONFIG_MEMORY', `${name}: memory limit ${formatMemory(limit)}${mb ? '' : ' (default)'}${live ? ', applied to the running unit' : ''}`, requestActor)
      return Response.json({
        success: true,
        memory: mb,
        limit,
        text: formatMemory(limit),
        isDefault: limit === DEFAULT_MEMORY_MB,
        applied: live ? "now" : "next start",
        sandboxed: SANDBOX_AVAILABLE && targets.every(cfg => cfg.sandbox !== false),
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/config/env") {
      const body = await req.json().catch(() => ({})) as { name?: string, configId?: string, envFile?: string | null }
      const { name, configId } = body
      if (!name) return Response.json({ error: "name is required" }, { status: 400, headers: corsHeaders })
      const targets = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      if (targets.length === 0) {
        return Response.json({ error: `No site named '${name}' with a start command.` }, { status: 404, headers: corsHeaders })
      }
      const denied = targets.find(cfg => !mayChangeConfig(auth, cfg))
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
      const actor = requestActor
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
      const denied = targets.find(cfg => !mayChangeConfig(auth, cfg))
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
      const actor = requestActor
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
      const name = lowerName(parts[2])
      const configId = parts[3]
      const actor = requestActor
      const affected = getConfigsForName(name).filter(cfg => !configId || cfg.id === configId)
      const denied = affected.find(cfg => !mayChangeConfig(auth, cfg))
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
        if (!mayUseBinding(binding)) continue
        bindings[subdomain] = {
          subdomain: binding.subdomain,
          fqdn: binding.fqdn,
          serverName: binding.serverName,
          boundAt: binding.boundAt,
          owner: bindingOwner(binding),
          orphaned: !!binding.orphaned,
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

    // Superuser only (ROUTE_TABLE)
    if (url.pathname === "/domains/mcp" || url.pathname === "/domains/mcp/revoke") {
      if (req.method === "GET" && url.pathname === "/domains/mcp") {
        return Response.json(await publicMcpStatus(), { headers: corsHeaders })
      }
      if (req.method === "POST" && url.pathname === "/domains/mcp") {
        const body = await req.json().catch(() => ({})) as { enabled?: boolean; subdomain?: string }
        if (typeof body.enabled !== "boolean") {
          return Response.json({ error: "enabled (true or false) is required" }, { status: 400, headers: corsHeaders })
        }
        const subdomain = (body.subdomain || domainConfig?.mcp?.subdomain || DEFAULT_MCP_SUBDOMAIN).trim().toLowerCase()
        const result = await setPublicMcp(body.enabled, subdomain, requestActor)
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
        auditLog('MCP_PUBLIC_REVOKE', body.clientId || 'all clients', requestActor)
        return Response.json(await publicMcpStatus(), { headers: corsHeaders })
      }
    }

    if (req.method === "POST" && url.pathname === "/domains/bind") {
      if (!domainConfig?.zone?.domain || !domainConfig?.tunnel?.id) {
        return Response.json({ error: "Domain config not set up. Run POST /domains/config first." }, { status: 400, headers: corsHeaders })
      }

      const body = await req.json().catch(() => ({})) as { subdomain?: unknown; serverName?: unknown; force?: boolean }
      const { force } = body
      if (typeof body.subdomain !== "string" || typeof body.serverName !== "string" || !body.subdomain || !body.serverName) {
        return Response.json({ error: "subdomain and serverName are required" }, { status: 400, headers: corsHeaders })
      }
      // Both end up in the Caddyfile and cloudflared's YAML: one DNS label, lower case, and a real site name
      const subdomain = body.subdomain.trim().toLowerCase()
      const serverName = body.serverName
      if (!isDnsLabel(subdomain)) {
        return Response.json({ error: "The subdomain can only use letters, numbers and dashes (not at the start or end), up to 63 characters." }, { status: 400, headers: corsHeaders })
      }
      if (isReserved(serverName)) {
        return Response.json({ error: "That isn't a site name." }, { status: 400, headers: corsHeaders })
      }
      if (!isZoneName(domainConfig.zone.domain)) {
        return Response.json({ error: "The zone in the domain config isn't a domain name. Fix it with POST /domains/config." }, { status: 400, headers: corsHeaders })
      }

      const fqdn = `${subdomain}.${domainConfig.zone.domain}`
      if (fqdn.toLowerCase() === publicMcpFqdn()) {
        return Response.json({ error: `${fqdn} is the public MCP endpoint. Pick another subdomain, or turn that off first.` }, { status: 409, headers: corsHeaders })
      }

      // Bind any site: one candy starts, or a plain route to a port or URL
      if (!serverConfigs.has(serverName) && !routes.has(serverName)) {
        return Response.json({ error: `No site named '${serverName}'. Add it first.` }, { status: 404, headers: corsHeaders })
      }
      // Your own site, on a subdomain that isn't someone else's binding
      if (!mayUse(serverName)) return notYoursResponse(serverName, "bind a domain to it")
      const existingBinding = domainConfig.bindings?.[subdomain]
      if (existingBinding && !mayUseBinding(existingBinding)) return notYoursResponse(existingBinding.serverName, `move ${fqdn}`)
      // Someone else's domain still pointing at this name would serve your site
      const boundElsewhere = boundToSomeoneElse(serverName, auth)
      if (boundElsewhere) return Response.json({ error: boundElsewhere }, { status: 409, headers: corsHeaders })
      // Replacing DNS records candy didn't create changes the zone itself
      if (force && !auth?.superuser) {
        return Response.json({ error: "Only a superuser can replace DNS records that candy didn't create." }, { status: 403, headers: corsHeaders })
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
        // Whoever bound it keeps it, also if the site is removed (see orphanBindingsIfGone)
        owner: nameOwner(serverName),
      }
      await saveDomainConfig()

      // Regenerate Caddy's http://fqdn blocks (without one, Caddy redirects the tunnel's plain HTTP to HTTPS forever)
      await syncCaddy()
      // Sync ingress and restart cloudflared
      await syncCloudflaredIngress()
      await restartCloudflared()

      auditLog('DOMAIN_BIND', `${fqdn} -> ${serverName}`, requestActor)
      return Response.json({
        message: `${fqdn} now serves ${serverName}`,
        binding: domainConfig.bindings[subdomain],
      }, { headers: corsHeaders })
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/domains/unbind/")) {
      if (!domainConfig) {
        return Response.json({ error: "Domain config not set up." }, { status: 400, headers: corsHeaders })
      }

      const subdomain = lowerName(url.pathname.split("/")[3])
      const binding = domainConfig.bindings?.[subdomain]
      if (!binding) {
        return Response.json({ error: `No binding found for '${subdomain}'.` }, { status: 404, headers: corsHeaders })
      }
      if (!mayUseBinding(binding)) return notYoursResponse(binding.serverName, `unbind ${binding.fqdn}`)

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

      auditLog('DOMAIN_UNBIND', `${binding.fqdn}`, requestActor)
      return Response.json({
        message: `Unbound ${binding.fqdn}`,
        subdomain,
        fqdn: binding.fqdn,
      }, { headers: corsHeaders })
    }

    // Superuser only (ROUTE_TABLE): zone, tunnel and the Cloudflare token
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

      // The zone and tunnel are written into the Caddyfile and cloudflared's YAML
      const bad = (what: string) => Response.json({ error: `${what} isn't valid.` }, { status: 400, headers: corsHeaders })
      if (body.zone?.domain !== undefined && !isZoneName(String(body.zone.domain).toLowerCase())) return bad("The zone domain")
      if (body.zone?.id !== undefined && body.zone.id !== "" && !isZoneId(body.zone.id)) return bad("The zone id")
      if (body.tunnel?.id !== undefined && !isTunnelId(body.tunnel.id)) return bad("The tunnel id")
      if (body.tunnel?.name !== undefined && !isTunnelName(body.tunnel.name)) return bad("The tunnel name")
      if (body.tunnel?.credentialsFile !== undefined && !isCredentialsPath(body.tunnel.credentialsFile)) return bad("The credentials file path")
      if (body.zone?.domain !== undefined) body.zone.domain = String(body.zone.domain).toLowerCase()

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
              if (isZoneId(zoneData.result?.[0]?.id)) {
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
      auditLog('DOMAIN_CONFIG', `zone: ${domainConfig.zone.domain}, tunnel: ${domainConfig.tunnel.name}`, requestActor)

      return Response.json({
        message: "Domain config updated",
        zone: domainConfig.zone,
        tunnel: { id: domainConfig.tunnel.id, name: domainConfig.tunnel.name },
      }, { headers: corsHeaders })
    }

    // === SSE Streaming Logs ===

    if (req.method === "GET" && url.pathname.startsWith("/stream/")) {
      const name = lowerName(url.pathname.split("/")[2])
      if (!mayReadLog(name)) return notYoursResponse(name, "read its log")
      const logFile = logFileFor(name)!.file
      // A site's own page (no login) sees only a bounded startup excerpt, and
      // only while the server is starting or crashed; the full log is the portal's
      const excerptOnly = pageHost !== null
      if (excerptOnly) {
        const status = processes.get(name)?.status
        if (status !== 'starting' && status !== 'errored' && status !== 'dead') {
          return Response.json({ error: "The log is in the portal." }, { status: 403, headers: corsHeaders })
        }
      }

      // The excerpt starts where this run's output does (logStart): earlier
      // runs' logs are the portal's. Offsets are bytes, decoded as a stream.
      const startAt = excerptOnly ? (processes.get(name)?.logStart ?? 0) : 0

      // Return SSE stream
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          const decoder = new TextDecoder()
          let offset = startAt

          let sent = 0
          let closed = false
          const finish = () => {
            if (closed) return
            closed = true
            clearInterval(interval)
            try { controller.close() } catch {}
          }
          const sendEvent = (data: string) => {
            if (closed) return
            if (excerptOnly) {
              data = data.slice(0, Math.max(0, SITE_LOG_EXCERPT_BYTES - sent))
              sent += data.length
            }
            if (!data) return
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
          }
          const readNew = async () => {
            const file = Bun.file(logFile)
            if (!await file.exists()) return
            const size = file.size
            if (size < offset) offset = excerptOnly ? size : 0  // cleared: start over (the excerpt never goes back)
            if (size <= offset) return
            const end = excerptOnly ? Math.min(size, offset + SITE_LOG_EXCERPT_BYTES - sent) : size
            if (end <= offset) return
            const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer())
            offset = end
            sendEvent(decoder.decode(bytes, { stream: true }))
          }

          // Initial content
          try { await readNew() } catch {}

          // Poll for new content
          const interval = setInterval(async () => {
            try {
              await readNew()

              // Also send process status updates
              const proc = processes.get(name)
              if (proc && !closed) {
                controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({
                  status: proc.status,
                  port: proc.port,
                  detectedPorts: proc.detectedPorts,
                })}\n\n`))
              }
              // The excerpt ends once the server is up, or when it is full
              if (excerptOnly && (proc?.status === 'running' || sent >= SITE_LOG_EXCERPT_BYTES)) finish()
            } catch {}
          }, 500)

          // Cleanup on abort
          req.signal.addEventListener('abort', finish)
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

    // === Pages: the portal itself, and every site's own pages ===
    return await serveSitePage(req, url, corsHeaders, auth)
}

// The shortcut pages on the portal host (/go/kill, /go/portal). Only the
// confirmation page gets a page token: its button is the one POST.
async function shortcutPage(file: string, vars: Record<string, unknown>, status = 200, token: string | null = null): Promise<Response> {
  const raw = await Bun.file(import.meta.dir + "/public/" + file).text()
  const html = raw.replace('<script>', `${portalPageScript(token, vars)}<script>`)
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
}

// The pages: the portal UI (after the guard) and each site's own pages
// (lazy start, starting/crashed/killed, tunnels, registration).
// A function declaration, so the server above can call it from its first request.
async function serveSitePage(req: Request, url: URL, corsHeaders: Record<string, string>, auth: RequestAuth | null): Promise<Response> {
  // SSR a page token into HTML: a new chain per page load, for a portal login.
  // A site's own starting/crashed page gets a site token for that name
  // (siteTokens: start and restart only, see siteAction); other pages get null.
  const injectToken = (html: string, siteName?: string): string => {
    const token = auth?.via === "portal" ? pageTokens.mint(auth.sessionId!) : siteName ? siteTokens.mint(siteName) : null
    const tokenScript = auth?.via === "portal" ? portalPageScript(token) : `<script>window.CANDY_TOKEN=${JSON.stringify(token)};</script>`
    // Inject before the first <script> tag or at the end of <head>
    if (html.includes('<script>')) {
      return html.replace('<script>', tokenScript + '<script>')
    }
    return html.replace('</head>', tokenScript + '</head>')
  }

  // Inject variables into HTML
  const injectVars = (html: string, vars: Record<string, any>, siteName?: string): string => {
    let result = injectToken(html, siteName)
    const varsScript = `<script>window.CANDY_VARS=${scriptJson(vars)};</script>`
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

  const currentHostUrl = (path: string = "") => `https://${reqHost}${path}`

  // Shortcut hosts: <name>.k|kill.<tld> stops a site, <name>.p|portal.<tld> opens
  // a public tunnel to it. Both need a portal login, and the cookie belongs to
  // the portal host, so confirm (and act) there. Nothing happens on this GET.
  const shortcutHost = parseShortcutHost(reqHost)
  if (shortcutHost && (req.method === "GET" || req.method === "HEAD")) {
    const serverName = shortcutHost.tld === "candy"
      ? resolveLocalCandyActionDomain(shortcutHost.name, shortcutHost.label)
      : (shortcutHost.label ? `${shortcutHost.name}.${shortcutHost.label}` : shortcutHost.name)
    return new Response(null, { status: 302, headers: { Location: shortcutConfirmUrl(shortcutHost.action, serverName, shortcutHost.tld), "Cache-Control": "no-store" } })
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

      // Portal UI at portal.localhost (only root), for a portal login only
      if (domain === "portal" && !isBoundDomain && auth?.via !== "portal") {
        return new Response(null, { status: 302, headers: { Location: "/login", "Cache-Control": "no-store" } })
      }
      if (domain === "portal" && isRootPath && !isBoundDomain) {
        domainHits.set(domain, (domainHits.get(domain) || 0) + 1)
        const rawHtml = await Bun.file(import.meta.dir + "/public/portal.html").text()
        let html = injectVars(rawHtml, { user: auth!.user, superuser: auth!.superuser, superuserNeedsPassword: auth!.superuserNeedsPassword === true, superuserUntil: superuserUntil(auth!), multiUser: RUNNING_AS_ROOT })
        // Check if any bound domain is unprotected → inject nag banner on portal
        const domainConfig = await loadDomainConfig()
        const hasUnprotected = domainConfig?.bindings && Object.values(domainConfig.bindings).some((b: any) => mayChangeName(auth, b.serverName) && (!b.auth?.password || !b.auth?.enabled))
        if (hasUnprotected) {
          const nagScript = `<script data-candy-nag>(function(){if(document.querySelector('[data-candy-nag-banner]'))return;var b=document.createElement('div');b.setAttribute('data-candy-nag-banner','1');b.setAttribute('role','status');b.innerHTML='<span>A public domain has no password. Anyone with the link can open it.</span><button aria-label="Dismiss" style="background:none;border:0;color:inherit;opacity:.7;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 14px">&times;</button>';b.querySelector('button').onclick=function(){b.remove()};b.style.cssText='position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100% - 32px);display:flex;align-items:center;background:#1a1d33;color:#fff;padding:10px 14px 10px 16px;border-radius:10px;font:500 13px/1.4 \\'Schibsted Grotesk\\',system-ui,sans-serif;box-shadow:0 10px 30px rgba(10,12,24,.25);z-index:999999';document.body.appendChild(b)})()</script>`
          html = html.replace('</body>', nagScript + '</body>')
        }
        // Holds a page token: never cached, where a plain navigation could find it
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Vary": SESSION_HEADER } })
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
          }, isBoundDomain ? undefined : domain)
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }

        if (managed.status === 'errored' || managed.status === 'dead') {
          // Show crashed page
          const rawHtml = await Bun.file(import.meta.dir + "/public/crashed.html").text()
          const html = injectVars(rawHtml, {
            name: domain,
            exitCode: managed.exitCode,
            status: managed.status,
          }, isBoundDomain ? undefined : domain)
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
          }, isBoundDomain ? undefined : domain)
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
                  headers: upstreamRequestHeaders(req.headers, !!boundMatch && hasBindingAuth(boundMatch.binding)),
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
          }, isBoundDomain ? undefined : domain)
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
      const html = injectVars(rawHtml, { name: domain })
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    } catch (e) {
      return new Response("registration terminal offline: " + e, { status: 500 })
    }
  }

  return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
}

// ============================================================================
// Startup Sequence
// ============================================================================

// Initialize log directory (clears on boot)
await initLogs()

// Clear the access log on startup (fresh slate each boot). 0600: even with
// the header filter it says who visited what. chmod as well, for a file an
// older candy created 0644 (the mode only applies to a new file).
try {
  closeSync(openSync(CADDY_LOG, "w", 0o600))
  chmodSync(CADDY_LOG, 0o600)
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

// Portal login: PAM service present? Re-checked so installing it later needs no restart.
await checkPam(true)
setInterval(() => { checkPam(false).catch(() => {}) }, 5 * 60 * 1000)
// Sign in with candy: a key file others could read was thrown away at load (new keys from here on)
if (appKeys.discarded) auditLog('APP_AUTH_KEYS_DISCARDED', `${APP_AUTH_KEYS_FILE} was readable or writable by others, or not ours: every site gets a new key`, 'System')
// Public MCP approvals without a user are revoked (and audited) as the state loads
await getMcpOAuth()

// Load persistent routes first (survive daemon restarts)
await loadPersistentRoutes()
await loadRouteUsers()
await assignBindingOwners()

// Functions are routed to the daemon from the start
for (const [name, configs] of serverConfigs) if (configs.some(c => c.fn)) routeFunction(name)

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

// Routing (and the project config under it) opened once in the background, so the server list
// can show each function's assets and whether it has a worker
for (const [name, configs] of serverConfigs) {
  const fnCfg = configs.find(c => c.fn)
  if (fnCfg) fnRoutingFor(name, fnCfg).catch(() => {})
}

// Hot functions keep their warm instances across daemon restarts
for (const [name, configs] of serverConfigs) {
  const fnCfg = configs.find(c => c.fn)
  if (fnCfg?.fn && fnLimits(fnCfg.fn).hot > 0) warmFn(name).catch(e => auditLog('FN_HOT_FAIL', `${name}: ${fnErrorText(e)}`, 'System'))
}

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
