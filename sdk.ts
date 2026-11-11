const API = process.env.CANDY_DAEMON_URL || "http://localhost:9999"
import { exchangeSecret, readSecrets, secretHint } from "./secret.ts"
import { CRON_JOB_ENV, validateCronJob, type CronJob } from "./cron.ts"

export type { CronJob } from "./cron.ts"

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

const candySdk = {
  checkRuntime,
  registerServer,
  getLocalhostUrl,
  openPortal,
  registerPort,
  setIdling,
  setCron,
  removeCron,
  listCrons,
  cronJob,
}

export default candySdk
