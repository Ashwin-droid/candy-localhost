const API = process.env.CANDY_DAEMON_URL || "http://localhost:9999"
const MCP_SECRET_FILE = `${process.env.HOME}/.config/candy/mcp-secret`

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

  let secret: string
  try {
    secret = (await Bun.file(MCP_SECRET_FILE).text()).trim()
  } catch {
    throw new Error(`Could not read ${MCP_SECRET_FILE}. Is candy-localhost running?`)
  }

  const res = await fetch(`${API}/mcp/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret })
  })

  const body = await res.json().catch(() => null) as { apiKey?: string; error?: string } | null
  if (!res.ok || !body?.apiKey) {
    throw new Error(parseErrorMessage(body, "Could not authenticate with the candy daemon."))
  }

  cachedApiKey = body.apiKey
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

const candySdk = {
  checkRuntime,
  registerServer,
  getLocalhostUrl,
  openPortal,
  registerPort,
}

export default candySdk
