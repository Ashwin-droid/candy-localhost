/**
 * candy-localhost SDK
 *
 * Programmatic interface to the candy daemon for one-off apps.
 *
 * Usage:
 *   import candy from "./sdk"
 *
 *   // Register + start + wait for port in one call
 *   const port = await candy.run("myapp", "npm run dev")
 *
 *   // With options
 *   const port = await candy.run("myapp", "bun run dev", { cwd: "/path/to/project" })
 *
 *   // Stop when done
 *   await candy.stop("myapp")
 */

const DAEMON_URL = "http://localhost:9999"
const MCP_SECRET_FILE = `${process.env.HOME}/.config/candy/mcp-secret`

let _apiKey: string | null = null

async function getApiKey(): Promise<string> {
  if (_apiKey) return _apiKey

  const file = Bun.file(MCP_SECRET_FILE)
  if (!await file.exists()) {
    throw new Error("candy daemon not running. Start it with: bun run daemon.ts")
  }
  const secret = (await file.text()).trim()

  const res = await fetch(`${DAEMON_URL}/mcp/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) {
    throw new Error("Failed to authenticate with candy daemon. Try restarting it.")
  }

  const data = await res.json() as { apiKey: string }
  _apiKey = data.apiKey
  return _apiKey
}

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const key = await getApiKey()

  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "X-Candy-API-Key": key,
      "X-Candy-Actor": "SDK",
      "Content-Type": "application/json",
    },
    signal: options.signal ?? AbortSignal.timeout(15000),
  })

  if (res.status === 401) {
    // Key expired (daemon restarted), clear and retry once
    _apiKey = null
    return api(path, options)
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = body?.error || `${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  return body
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Working directory. Defaults to process.cwd() */
  cwd?: string
  /** Port detection timeout in ms. Default: 15000 */
  timeout?: number
  /** Polling interval in ms. Default: 250 */
  pollInterval?: number
}

export interface ServerInfo {
  name: string
  status: string
  port: number | null
  pid: number | null
  cwd: string
  cmd: string
}

export interface PortalInfo {
  name: string
  port: number
  url: string
}

/**
 * Register a server config, start it, and wait for its port to be detected.
 *
 * ```ts
 * const port = await candy.run("myapp", "npm run dev")
 * // myapp is now live at http://myapp.localhost
 * ```
 */
async function run(name: string, cmd: string, opts?: RunOptions): Promise<number> {
  const cwd = opts?.cwd ?? process.cwd()
  const timeout = opts?.timeout ?? 15000
  const pollInterval = opts?.pollInterval ?? 250

  // Register config (idempotent - won't duplicate if cwd+cmd match)
  await api("/config", {
    method: "POST",
    body: JSON.stringify({ name, cwd, cmd }),
  })

  // Start the process
  const startRes = await api(`/process/start/${name}`, { method: "POST" })

  // If already running with a port, return immediately
  if (startRes?.data?.port) {
    return startRes.data.port
  }

  // Poll for port detection
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval))

    const res = await api("/processes")
    const proc = res?.processes?.[name]
    if (!proc) continue

    if (proc.status === "errored" || proc.status === "dead") {
      throw new Error(`Server "${name}" exited (status: ${proc.status}, exit code: ${proc.exitCode})`)
    }

    if (proc.port) {
      return proc.port
    }
  }

  // Timeout - check if there are detected ports the user can choose from
  const res = await api("/processes")
  const proc = res?.processes?.[name]
  if (proc?.detectedPorts?.length > 1) {
    // Multiple ports detected - pick the first one and bind it
    const port = proc.detectedPorts[0]
    await api(`/process/port/${name}`, {
      method: "POST",
      body: JSON.stringify({ port }),
    })
    return port
  }

  throw new Error(`Port detection timed out for "${name}" after ${timeout}ms`)
}

/** Stop a running server. */
async function stop(name: string): Promise<void> {
  await api(`/process/stop/${name}`, { method: "POST" })
}

/** Restart a running server. */
async function restart(name: string): Promise<void> {
  await api(`/process/restart/${name}`, { method: "POST" })
}

/** List all configured servers and their status. */
async function servers(): Promise<ServerInfo[]> {
  const [configsRes, processesRes] = await Promise.all([
    api("/configs"),
    api("/processes"),
  ])

  const configs = configsRes?.configs || {}
  const procs = processesRes?.processes || {}
  const result: ServerInfo[] = []

  for (const [name, config] of Object.entries(configs) as [string, any][]) {
    const proc = procs[name]
    result.push({
      name,
      status: proc?.status || "stopped",
      port: proc?.port || null,
      pid: proc?.pid || null,
      cwd: config.cwd,
      cmd: config.cmd,
    })
  }
  return result
}

/** Get logs from a server. */
async function logs(name: string, opts?: { mode?: "tail" | "head" | "search", lines?: number, pattern?: string }): Promise<string> {
  const params = new URLSearchParams({
    mode: opts?.mode || "tail",
    lines: String(opts?.lines || 50),
  })
  if (opts?.pattern) params.set("pattern", opts.pattern)

  const res = await api(`/logs/${name}?${params}`)
  return res?.logs || res?.data || ""
}

/** Register a server config without starting it. */
async function register(name: string, cmd: string, cwd?: string): Promise<void> {
  await api("/config", {
    method: "POST",
    body: JSON.stringify({ name, cwd: cwd ?? process.cwd(), cmd }),
  })
}

/** Remove a server config (stops it if running). */
async function deregister(name: string): Promise<void> {
  await api(`/process/stop/${name}`, { method: "POST" }).catch(() => {})
  await api(`/config/${name}`, { method: "DELETE" })
}

/** Open a Cloudflare tunnel for a server. Returns the public URL. */
async function portal(name: string): Promise<string> {
  const res = await api("/portal", {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  return res?.url || res?.portal?.url || ""
}

/** Close a Cloudflare tunnel. */
async function portalClose(name: string): Promise<void> {
  await api(`/portal/close/${name}`, { method: "POST" })
}

/** Send input to a server's terminal. */
async function input(name: string, text: string): Promise<void> {
  await api(`/process/input/${name}`, {
    method: "POST",
    body: JSON.stringify({ input: text }),
  })
}

const candy = { run, stop, restart, servers, logs, register, deregister, portal, portalClose, input }
export default candy
export { run, stop, restart, servers, logs, register, deregister, portal, portalClose, input }
