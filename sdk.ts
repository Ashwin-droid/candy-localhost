const API = process.env.CANDY_DAEMON_URL || "http://localhost:9999"
import { exchangeSecret, readSecrets, secretHint } from "./secret.ts"
import { CRON_JOB_ENV, validateCronJob, type CronJob } from "./cron.ts"
import { createAppAuth, type AppAuth, type AppAuthOptions } from "./sdk-auth.ts"

export type { CronJob } from "./cron.ts"
// Sign in with candy (SDK_AUTH_DESIGN.md): the app side
export {
  createAppAuth, redirectAfterLogin, safeAppPath, portalForHost, ReplayCache, LOGIN_PATH, CALLBACK_PATH,
  type AppAuth, type AppAuthOptions, type AuthUser, type CallbackResult, type VerifyResult, type ReplayStore, type AuthErrorCode,
} from "./sdk-auth.ts"

export const CANDY_RUNTIME_MAGIC_ENV = "X_CANDY_RUNTIME_MAGIC_STRING"

let cachedApiKey: string | null = null

export interface CandyRuntimeStatus {
  isCandyRuntime: boolean
  magicString: string | null
}

export interface RegisterServerOptions {
  cwd: string
  command?: string
  cmd?: string
  namespace?: string
  name?: string
}

export interface RegisterPortOptions {
  port: number
  persistent?: boolean
  namespace?: string
  name?: string
}

export interface GetLocalhostUrlOptions {
  namespace?: string
  name?: string
}

export interface OpenPortalOptions {
  namespace?: string
  name?: string
}

export interface RegisterServerResult {
  ignored: boolean
  name: string
  url: string
  configId: string | null
}

export interface RegisterPortResult {
  name: string
  port: number
  url: string
  domain: string
  persistent: boolean
}

export interface PortalResult {
  name: string
  port: number
  url: string
  message?: string
}

interface RuntimeLookupResponse {
  runtime: {
    name: string
    url: string
    port: number | null
    status: string
    configId: string
    cwd: string
    cmd: string
  }
}

const makeLocalhostUrl = (name: string) => `https://${name}.localhost`

const resolveNamespace = (value: { namespace?: string; name?: string }, label = "namespace"): string => {
  const resolved = value.namespace ?? value.name
  if (!resolved || resolved.trim().length === 0) {
    throw new Error(`${label} is required`)
  }
  return resolved.trim()
}

const resolveCommand = (value: { command?: string; cmd?: string }): string => {
  const resolved = value.command ?? value.cmd
  if (!resolved || resolved.trim().length === 0) {
    throw new Error("command is required")
  }
  return resolved.trim()
}

const parseErrorMessage = (body: unknown, fallback: string) => {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: string }).error === "string") {
    return (body as { error: string }).error
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return body
  }
  return fallback
}

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey

  if ((await readSecrets()).length === 0) throw new Error(secretHint())
  const key = await exchangeSecret(API)
  if (!key) throw new Error("The candy daemon rejected every secret. Restart it, or check your group membership.")
  cachedApiKey = key
  return cachedApiKey
}

async function daemonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = await getApiKey()
  const headers = new Headers(init.headers || {})
  headers.set("X-Candy-API-Key", apiKey)
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }

  const res = await fetch(`${API}${path}`, { ...init, headers })
  const contentType = res.headers.get("content-type") || ""
  const body = contentType.includes("application/json")
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null)

  if (res.status === 401) {
    cachedApiKey = null
  }

  if (!res.ok) {
    throw new Error(parseErrorMessage(body, `${res.status} ${res.statusText}`.trim()))
  }

  return body as T
}

async function resolveRuntimeOrThrow(): Promise<RuntimeLookupResponse["runtime"]> {
  const runtime = checkRuntime()
  if (!runtime.isCandyRuntime || !runtime.magicString) {
    throw new Error("This process is not running inside candy. Pass a namespace instead.")
  }

  const response = await daemonFetch<RuntimeLookupResponse>("/sdk/runtime", {
    method: "POST",
    body: JSON.stringify({ configId: runtime.magicString, pid: process.pid })
  })

  return response.runtime
}

export function checkRuntime(): CandyRuntimeStatus {
  const magicString = process.env[CANDY_RUNTIME_MAGIC_ENV]?.trim() || null
  return {
    isCandyRuntime: !!magicString,
    magicString,
  }
}

export async function registerServer(options: RegisterServerOptions): Promise<RegisterServerResult> {
  const name = resolveNamespace(options)
  const runtime = checkRuntime()

  if (runtime.isCandyRuntime) {
    return {
      ignored: true,
      name,
      url: makeLocalhostUrl(name),
      configId: runtime.magicString,
    }
  }

  await daemonFetch("/config", {
    method: "POST",
    body: JSON.stringify({
      name,
      cwd: options.cwd,
      cmd: resolveCommand(options),
    })
  })

  return {
    ignored: false,
    name,
    url: makeLocalhostUrl(name),
    configId: null,
  }
}

export interface RegisterFunctionOptions {
  /** Absolute path of the function's folder */
  cwd: string
  /** Module path relative to cwd. Defaults to main from candy.fn.json / wrangler config. */
  entry?: string
  /** Defaults to the folder's name (e.g. /srv/my-api -> my-api) */
  namespace?: string
  name?: string
  /** Warm instances kept alive at all times (default 0) */
  hot?: number
  /** Cap on concurrent instances (default 4) */
  max?: number
  /** Seconds an idle instance waits for the next request (default 30, 0-600) */
  linger?: number
}

export interface RegisterFunctionResult {
  name: string
  url: string
}

// A candy name from a folder: its last part, lowercased, other characters as dashes
export const nameFromFolder = (cwd: string): string => {
  const base = cwd.trim().replace(/\/+$/, "").split("/").pop() ?? ""
  const name = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63)
  if (!name) throw new Error("name is required (the folder's name can't be used)")
  return name
}

const optionalCount = (value: number | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a whole number >= 0`)
  return value
}

/**
 * Register a Workers-style module (`export default { fetch }`, or a Hono app)
 * as a candy function served at <name>.localhost. Functions open no port: candy
 * starts an instance per request burst and it exits when idle.
 */
export async function registerFunction(options: RegisterFunctionOptions): Promise<RegisterFunctionResult> {
  if (!options.cwd || options.cwd.trim().length === 0) throw new Error("cwd is required")
  const name = options.namespace !== undefined || options.name !== undefined
    ? resolveNamespace(options)
    : nameFromFolder(options.cwd)
  const hot = optionalCount(options.hot, "hot")
  const max = optionalCount(options.max, "max")
  const linger = optionalCount(options.linger, "linger")
  if (linger !== undefined && linger > 600) throw new Error("linger must be 0 to 600 seconds")

  const response = await daemonFetch<{ name?: string; url?: string }>("/fn/add", {
    method: "POST",
    body: JSON.stringify({
      name,
      cwd: options.cwd,
      ...(options.entry ? { entry: options.entry } : {}),
      ...(hot !== undefined ? { hot } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(linger !== undefined ? { linger } : {}),
    })
  })

  return {
    name: response?.name || name,
    url: response?.url || makeLocalhostUrl(name),
  }
}

export async function getLocalhostUrl(options: GetLocalhostUrlOptions = {}): Promise<string> {
  const explicitNamespace = options.namespace ?? options.name
  if (explicitNamespace) {
    return makeLocalhostUrl(resolveNamespace(options))
  }

  const runtime = await resolveRuntimeOrThrow()
  return runtime.url
}

export async function registerPort(options: RegisterPortOptions): Promise<RegisterPortResult> {
  const name = resolveNamespace(options)
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("port must be an integer between 1 and 65535")
  }

  const response = await daemonFetch<{ domain?: string; url?: string }>("/sdk/register-port", {
    method: "POST",
    body: JSON.stringify({
      name,
      port: options.port,
      persistent: options.persistent === true,
      pid: process.pid,
    })
  })

  return {
    name,
    port: options.port,
    persistent: options.persistent === true,
    domain: response.domain || `${name}.localhost`,
    url: response.url || makeLocalhostUrl(name),
  }
}

export async function openPortal(options: OpenPortalOptions = {}): Promise<PortalResult> {
  const runtime = checkRuntime()
  if (runtime.isCandyRuntime && runtime.magicString) {
    return await daemonFetch<PortalResult>("/sdk/portal", {
      method: "POST",
      body: JSON.stringify({
        configId: runtime.magicString,
        pid: process.pid,
      })
    })
  }

  const name = resolveNamespace(options)
  return await daemonFetch<PortalResult>("/sdk/portal", {
    method: "POST",
    body: JSON.stringify({
      name,
      pid: process.pid,
    })
  })
}

// Calls that only make sense from inside a server candy started
async function runtimeCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const runtime = checkRuntime()
  if (!runtime.isCandyRuntime || !runtime.magicString) {
    throw new Error("This only works inside a server started by candy.")
  }
  return await daemonFetch<T>(path, {
    method: "POST",
    body: JSON.stringify({ configId: runtime.magicString, pid: process.pid, ...body }),
  })
}

export interface IdlingResult {
  name: string
  idling: boolean
}

/**
 * Tell candy whether this server is idling: handling no requests right now,
 * only waiting for events to arrive. An idling server is not stopped for
 * inactivity until memory gets tight (80% of RAM in use, or high memory
 * pressure). Call `setIdling(false)` to go back to the normal 1-hour rule.
 * The flag lasts until the server stops.
 */
export async function setIdling(idling = true): Promise<IdlingResult> {
  const res = await runtimeCall<IdlingResult>("/sdk/idle", { idling })
  return { name: res.name, idling: res.idling }
}

export interface CronJobInput {
  /** Unique per server: setting a job with an existing name replaces it. */
  name: string
  /** 5-field cron (minute hour day-of-month month day-of-week) or @hourly, @daily, @weekly, @monthly, @yearly. Local time. */
  schedule: string
  /** Appended to the server's own command as separate arguments. Never parsed by a shell. */
  args?: string[]
  /** Stop a run after this many seconds. Default 3600, max 86400. */
  timeoutSec?: number
}

/**
 * Run this server's command on a schedule, with extra arguments of your
 * choice. The base command can't be changed, and the arguments are passed as
 * plain argv entries: `;`, `&&`, `|` or `$(...)` in them are just text.
 * A run gets CANDY_CRON_JOB=<name> in its environment (see `cronJob()`).
 * Jobs are saved with the server's config and run whether or not it is running.
 */
export async function setCron(job: CronJobInput): Promise<CronJob[]> {
  const v = validateCronJob(job)
  if (!v.ok) throw new Error(v.error)
  return (await runtimeCall<{ jobs: CronJob[] }>("/sdk/cron", { action: "set", job: v.job })).jobs
}

export async function removeCron(name: string): Promise<CronJob[]> {
  return (await runtimeCall<{ jobs: CronJob[] }>("/sdk/cron", { action: "remove", name })).jobs
}

export async function listCrons(): Promise<CronJob[]> {
  return (await runtimeCall<{ jobs: CronJob[] }>("/sdk/cron", { action: "list" })).jobs
}

/** The cron job that started this process, or null when it wasn't started by cron. */
export function cronJob(): string | null {
  return process.env[CRON_JOB_ENV]?.trim() || null
}

// ---------------------------------------------------------------------------
// Sign in with candy
// ---------------------------------------------------------------------------

/** The key ring for `site`, from the daemon: only the site owner's own API key gets it. */
const fetchSiteKeys = async (site: string): Promise<string> => {
  const res = await daemonFetch<{ keys?: unknown }>("/sdk/auth/keys", { method: "POST", body: JSON.stringify({ name: site }) })
  if (typeof res?.keys !== "string") throw new Error("candy auth: the daemon sent no keys")
  return res.keys
}

let defaultAppAuth: AppAuth | null = null

/**
 * "Sign in with candy" for this app: send users to the portal, get back who
 * they are (`user`, e.g. "ashwin"). No options: memoized, the site and key
 * from what candy gave this process (CANDY_AUTH_SITE, the key credential or
 * CANDY_AUTH_KEYS), refetched from the daemon with your API key when the key
 * rotates. Inside a candy function it is the same object as env.CANDY_AUTH.
 *
 *   const auth = appAuth()
 *   const r = await auth.handle(req, u => redirectAfterLogin(u.next, newSessionCookie(u.user)))
 *   if (r) return r
 *
 * Outside candy, pass { site } (a site you own); the key comes from the daemon.
 */
export function appAuth(opts?: AppAuthOptions): AppAuth {
  if (opts === undefined) {
    const fromHost = (globalThis as Record<symbol, unknown>)[Symbol.for("candy.appAuth")] as AppAuth | undefined
    if (fromHost) return fromHost
    if (defaultAppAuth) return defaultAppAuth
  }
  let auth: AppAuth
  try {
    auth = createAppAuth({ fetchKeys: fetchSiteKeys, ...opts })
  } catch (e) {
    if ((e as Error).message === "candy auth: no site name") {
      throw new Error("candy auth: no site name. Servers and functions candy starts get CANDY_AUTH_SITE; elsewhere pass appAuth({ site: '<your site>' }).")
    }
    throw e
  }
  if (opts === undefined) defaultAppAuth = auth
  return auth
}

const candySdk = {
  checkRuntime,
  registerServer,
  registerFunction,
  getLocalhostUrl,
  openPortal,
  registerPort,
  setIdling,
  setCron,
  removeCron,
  listCrons,
  cronJob,
  appAuth,
  createAppAuth,
}

export default candySdk
