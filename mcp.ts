/**
 * candy-localhost MCP Server
 *
 * Simple server management tools: list, start, stop, logs
 * Designed for autonomous agent use - no explicit user request needed.
 */


// ============================================================================
// Types
// ============================================================================

interface MCPRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: any
}

interface MCPResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: any
  error?: { code: number; message: string; data?: any }
}

// ============================================================================
// Configuration
// ============================================================================

const DAEMON_URL = "http://localhost:9999"

// ============================================================================
// Tool Definitions
// ============================================================================

const TOOLS = [
  {
    name: "candy_servers",
    description: `List all configured local dev servers managed by candy-localhost.

USE THIS TOOL AUTONOMOUSLY when:
- User mentions a project name that might be a dev server (e.g. "inkspired", "myapp")
- User asks about running servers, ports, or localhost domains
- You need to check if a server is running before suggesting to start it
- User is debugging a web app and you need to know its port/status

Returns each server's: name, status (running/stopped), port, PID, working directory, and start command.
Servers are accessible at <name>.localhost when running.

This is a READ-ONLY operation - safe to call anytime without asking.`,
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: {
      title: "List Dev Servers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_start",
    description: `Start a local dev server by name.

USE THIS TOOL AUTONOMOUSLY when:
- User says "start the server" or "run the app"
- User wants to test/preview their web app locally
- You checked candy_servers and the server is stopped but user needs it running
- User navigates to <name>.localhost and it's not responding

The server must already be configured in candy. Use candy_servers first to see available servers.
Once started, the server will be accessible at <name>.localhost.
	Port is auto-detected from the process output (supports vite, next, etc).

	If the server is already running, this call is idempotent and will not spawn a duplicate process.

	This STARTS A PROCESS - prefer to confirm with user if they haven't explicitly asked.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name (e.g. 'inkspired', 'myapp')"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Start Dev Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    }
  },
  {
    name: "candy_restart",
    description: `Restart a running dev server by name.

	USE THIS TOOL AUTONOMOUSLY when:
	- User says "restart the server"
	- A dev server is wedged and needs a clean restart
	- User calls start but wants a restart semantics

	Attempts to gracefully stop (SIGTERM), escalates to SIGKILL if needed, then starts again.

	This KILLS A PROCESS - prefer to confirm with user if they haven't explicitly asked.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to restart"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Restart Dev Server",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: "candy_stop",
    description: `Stop a running dev server by name.

USE THIS TOOL AUTONOMOUSLY when:
- User says "stop the server" or "kill the app"
- User is done testing and wants to free up the port
- Server is in errored/crashed state and needs to be stopped before restart
- User is switching to a different project

Attempts to gracefully stop the process (SIGTERM), then escalates to SIGKILL if needed.

This KILLS A PROCESS - prefer to confirm with user if they haven't explicitly asked.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to stop"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Stop Dev Server",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_logs",
    description: `Get logs from a dev server's stdout/stderr.

USE THIS TOOL AUTONOMOUSLY when:
- User reports an error or bug in their web app
- Server failed to start or crashed
- User asks "what went wrong" or "why isn't it working"
- You need to debug a runtime error, build failure, or startup issue
- User mentions seeing an error in the browser from their local app

STRONGLY PREFER THIS over asking user to paste logs or re-running builds.
This gives you direct access to the server's output - use it liberally for debugging.

Modes:
- tail (default): Last N lines of output
- head: First N lines of output
- search: Grep for a pattern with context lines

ANSI codes are stripped for readability.

This is a READ-ONLY operation - safe to call anytime without asking.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to get logs from"
        },
        mode: {
          type: "string",
          enum: ["tail", "head", "search"],
          description: "Read mode: tail (last N lines), head (first N lines), or search (grep pattern)"
        },
        lines: {
          type: "number",
          description: "Number of lines for tail/head (default 50, max 500)"
        },
        pattern: {
          type: "string",
          description: "Search pattern for grep (required for search mode)"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Get Server Logs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_register",
    description: `Register a new dev server configuration.

USE THIS TOOL AUTONOMOUSLY when:
- User wants to add a new project to candy
- User says "add this server" or "register this app"
- User wants to set up a new dev server with a custom command

Creates a server config that can be started on-demand by visiting <name>.localhost.
The server won't start until first accessed.

This MODIFIES CONFIGURATION - confirm with user before registering.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name (becomes <name>.localhost)"
        },
        cwd: {
          type: "string",
          description: "Working directory for the server (absolute path)"
        },
        cmd: {
          type: "string",
          description: "Command to start the dev server (e.g. 'npm run dev', 'bun run dev')"
        }
      },
      required: ["name", "cwd", "cmd"]
    },
    annotations: {
      title: "Register Dev Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_deregister",
    description: `Remove a dev server configuration.

USE THIS TOOL AUTONOMOUSLY when:
- User wants to remove a server from candy
- User says "delete this server" or "remove this app"
- User no longer needs a dev server registered

This removes the server config. If the server is running, it will be stopped first.

This MODIFIES CONFIGURATION - confirm with user before deregistering.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to remove"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Deregister Dev Server",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_portal_open",
    description: `Open a Cloudflare tunnel (portal) for a dev server.

USE THIS TOOL AUTONOMOUSLY when:
- User wants to share their local app with someone
- User says "make this public" or "create a tunnel"
- User needs a public URL for their dev server

Creates a temporary public URL via Cloudflare Tunnel (trycloudflare.com).
The server must be running first.

This STARTS AN EXTERNAL TUNNEL - confirm with user before opening.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to create portal for"
        },
        port: {
          type: "number",
          description: "Port to tunnel (required if server not registered)"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Open Portal",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "candy_portal_close",
    description: `Close a Cloudflare tunnel (portal).

USE THIS TOOL AUTONOMOUSLY when:
- User is done sharing their app
- User says "close the tunnel" or "stop sharing"
- User wants to take down the public URL

Terminates the Cloudflare tunnel process.

This STOPS AN EXTERNAL TUNNEL - prefer to confirm with user.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Portal name to close"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Close Portal",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_portals",
    description: `List all open Cloudflare tunnels (portals).

USE THIS TOOL AUTONOMOUSLY when:
- User asks about active tunnels or public URLs
- User wants to see what's currently shared
- You need to check if a portal exists before opening/closing

Returns each portal's name, port, and public URL.

This is a READ-ONLY operation - safe to call anytime without asking.`,
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: {
      title: "List Portals",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_input",
    description: `Send input to a running dev server's terminal (PTY).

USE THIS TOOL AUTONOMOUSLY when:
- Server prompts for input (e.g. "press h for help", "continue? y/n")
- User asks to interact with the running process
- You need to send keyboard commands to the server (e.g. restart vite with 'r')
- User wants to answer prompts in the terminal

Supports:
- Raw text input (including newlines)
- Special keys: enter, ctrl+c, ctrl+d, ctrl+z, tab, escape, backspace, arrow keys

Examples:
- Send "h" + enter to vite for help: { "input": "h\\n" }
- Send ctrl+c to interrupt: { "key": "ctrl+c" }
- Restart vite: { "input": "r\\n" }
- Answer yes to prompt: { "input": "y\\n" }

This SENDS INPUT TO A PROCESS - use when server needs interaction.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to send input to"
        },
        input: {
          type: "string",
          description: "Raw text to send (use \\n for enter)"
        },
        key: {
          type: "string",
          enum: ["enter", "ctrl+c", "ctrl+d", "ctrl+z", "ctrl+l", "tab", "escape", "backspace", "up", "down", "left", "right"],
          description: "Special key to send (alternative to input)"
        }
      },
      required: ["name"]
    },
    annotations: {
      title: "Send Terminal Input",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: "candy_route",
    description: "Add, remove, or list domain routes. Use persistent flag for routes that survive daemon restarts.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: add, remove, or list"
        },
        name: {
          type: "string",
          description: "Route name (becomes <name>.localhost)"
        },
        port: {
          type: "number",
          description: "Port to route to"
        },
        persistent: {
          type: "boolean",
          description: "If true, route survives daemon restarts"
        }
      },
      required: ["action"]
    }
  },
  ]

// ============================================================================
// Daemon API Client
// ============================================================================

const MCP_SECRET_FILE = `${process.env.HOME}/.config/candy/mcp-secret`
let apiKey: string | null = null

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const sanitizeFetchErrorMessage = (message: string): string => {
  let msg = message.trim()
  // Bun often appends this suggestion; it's not actionable for end users inside MCP tool output.
  msg = msg.replace(/For more information, pass `verbose: true` in\s*the second argument to fetch\(\)\.?/g, "").trim()
  msg = msg.replace(/^Error:\s*/g, "").trim()

  if (msg.includes("The socket connection was closed unexpectedly")) {
    return "Daemon connection closed unexpectedly."
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("Connection refused")) {
    return "Could not connect to daemon (connection refused)."
  }
  if (msg.includes("fetch failed")) {
    return "Request to daemon failed."
  }
  if (msg.includes("AbortError") || msg.includes("timed out") || msg.includes("timeout")) {
    return "Request to daemon timed out."
  }
  return msg || "Request failed."
}

async function getApiKey(): Promise<string> {
  if (apiKey) return apiKey

  // Read bootstrap secret from file
  const secretFile = Bun.file(MCP_SECRET_FILE)
  if (!await secretFile.exists()) {
    throw new Error("MCP secret file not found. Is the candy daemon running?")
  }
  const secret = (await secretFile.text()).trim()

  // Exchange secret for API key
  const res = await fetch(`${DAEMON_URL}/mcp/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
    signal: AbortSignal.timeout(5000),
  })

  if (!res.ok) {
    throw new Error("Failed to authenticate with daemon. Secret may be stale - restart daemon?")
  }

  const data = await res.json() as { apiKey: string }
  apiKey = data.apiKey
  return apiKey
}

async function daemonFetch(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${DAEMON_URL}${path}`

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let key: string
    try {
      key = await getApiKey()
    } catch (e) {
      return {
        error: String(e),
        hint: "Ensure the candy daemon is running (port 9999) and ~/.config/candy/mcp-secret exists."
      }
    }

    const headers = {
      ...options.headers,
      "X-Candy-API-Key": key,
      "Content-Type": "application/json",
    } as Record<string, string>

    let res: Response
    try {
      res = await fetch(url, {
        ...options,
        headers,
        // Avoid hanging MCP calls forever on a wedged daemon/network stack
        signal: options.signal ?? AbortSignal.timeout(15000),
      })
    } catch (e) {
      const msg = sanitizeFetchErrorMessage(String(e))
      const retryable =
        msg.includes("Daemon connection closed unexpectedly") ||
        msg.includes("connection refused") ||
        msg.includes("Request to daemon failed") ||
        msg.includes("timed out")
      if (retryable && attempt < maxAttempts) {
        await sleep(150 * attempt)
        continue
      }
      return {
        error: msg,
        hint: "Daemon unreachable. Check `systemctl status candy-localhost@$USER` or run `bun run daemon.ts`."
      }
    }

    // If daemon restarted, the API key becomes invalid; clear and retry once.
    if (res.status === 401) {
      apiKey = null
      if (attempt < maxAttempts) {
        await sleep(100 * attempt)
        continue
      }
    }

    const contentType = res.headers.get("content-type") || ""
    const parseBody = async () => {
      if (contentType.includes("application/json")) {
        try { return await res.json() } catch {}
      }
      try { return await res.text() } catch {}
      return null
    }

    const body = await parseBody()

    if (!res.ok) {
      const errMsg =
        (body && typeof body === "object" && "error" in body && typeof (body as any).error === "string")
          ? (body as any).error
          : `${res.status} ${res.statusText}`.trim()
      return {
        error: errMsg || "Request failed",
        status: res.status,
        details: body,
        hint: res.status === 401
          ? "Authentication failed; daemon may have restarted. Try again."
          : undefined
      }
    }

    return body
  }

  return { error: "Request failed after retries" }
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleServers(): Promise<any> {
  const [configsRes, processesRes] = await Promise.all([
    daemonFetch("/configs"),
    daemonFetch("/processes")
  ])

  if (configsRes?.error) return configsRes
  if (processesRes?.error) return processesRes

  const configs = configsRes.configs || {}
  const processes = processesRes.processes || {}

  const servers: any[] = []
  for (const [name, config] of Object.entries(configs) as [string, any][]) {
    const proc = processes[name]
    servers.push({
      name,
      url: `https://${name}.localhost`,
      status: proc?.status || "stopped",
      port: proc?.port || null,
      pid: proc?.pid || null,
      cwd: config.cwd,
      cmd: config.cmd
    })
  }

  return { servers }
}

async function handleStart(params: any): Promise<any> {
  const { name } = params
  return await daemonFetch(`/process/start/${name}`, { method: "POST" })
}

async function handleRestart(params: any): Promise<any> {
  const { name } = params
  return await daemonFetch(`/process/restart/${name}`, { method: "POST" })
}

async function handleStop(params: any): Promise<any> {
  const { name } = params
  return await daemonFetch(`/process/stop/${name}`, { method: "POST" })
}

async function handleRegister(params: any): Promise<any> {
  const { name, cwd, cmd } = params
  return await daemonFetch("/config", {
    method: "POST",
    body: JSON.stringify({ name, cwd, cmd })
  })
}

async function handleDeregister(params: any): Promise<any> {
  const { name } = params
  // First stop the process if running
  await daemonFetch(`/process/stop/${name}`, { method: "POST" }).catch(() => {})
  // Then remove the config
  return await daemonFetch(`/config/${name}`, { method: "DELETE" })
}

async function handlePortalOpen(params: any): Promise<any> {
  const { name } = params
  let { port } = params

  // If no port provided, look it up from running processes
  if (!port && name) {
    const processesRes = await daemonFetch("/processes")
    const proc = processesRes.processes?.[name]
    if (proc?.port) {
      port = proc.port
    } else {
      return { error: `Server '${name}' is not running or has no port. Start it first.` }
    }
  }

  return await daemonFetch("/portal", {
    method: "POST",
    body: JSON.stringify({ name, port })
  })
}

async function handlePortalClose(params: any): Promise<any> {
  const { name } = params
  return await daemonFetch(`/portal/close/${name}`, { method: "POST" })
}

async function handlePortals(): Promise<any> {
  return await daemonFetch("/portals")
}

async function handleInput(params: any): Promise<any> {
  const { name, input, key } = params
  const body: any = {}
  if (input !== undefined) body.input = input
  if (key !== undefined) body.key = key

  return await daemonFetch(`/process/input/${name}`, {
    method: "POST",
    body: JSON.stringify(body)
  })
}

async function handleLogs(params: any): Promise<any> {
  const { name, mode = "tail", lines = 50, pattern } = params
  const lineCount = Math.min(lines, 500)

  try {
    // Fetch logs from daemon
    const queryParams = new URLSearchParams({
      mode,
      lines: String(lineCount),
      ...(pattern && { pattern })
    })
    const logsRes = await daemonFetch(`/logs/${name}?${queryParams}`)
    if (logsRes.error) {
      return { error: logsRes.error }
    }

    // Get server status for header
    let status = "unknown"
    let port = ""
    try {
      const processesRes = await daemonFetch("/processes")
      const proc = processesRes.processes?.[name]
      if (proc) {
        status = proc.status || "stopped"
        port = proc.port ? `:${proc.port}` : ""
      }
    } catch {}

    const header = `[${name}] ${status}${port}\n${"─".repeat(40)}\n`
    return header + (logsRes.logs || "(no output)")
  } catch (e) {
    return { error: String(e) }
  }
}

// ============================================================================
// MCP Protocol Handlers
// ============================================================================

async function handleRequest(request: MCPRequest): Promise<MCPResponse | null> {
  const { id, method, params } = request

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "candy-localhost", version: "0.4.0" }
          }
        }

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS }
        }

      case "tools/call":
        const toolName = params?.name
        const toolArgs = params?.arguments || {}

        let result: any
        switch (toolName) {
          case "candy_servers":
            result = await handleServers()
            break
          case "candy_start":
            result = await handleStart(toolArgs)
            break
          case "candy_restart":
            result = await handleRestart(toolArgs)
            break
          case "candy_stop":
            result = await handleStop(toolArgs)
            break
          case "candy_logs":
            result = await handleLogs(toolArgs)
            break
          case "candy_register":
            result = await handleRegister(toolArgs)
            break
          case "candy_deregister":
            result = await handleDeregister(toolArgs)
            break
          case "candy_portal_open":
            result = await handlePortalOpen(toolArgs)
            break
          case "candy_portal_close":
            result = await handlePortalClose(toolArgs)
            break
          case "candy_route": {
            const { action: routeAction, name: routeName, port: routePort, persistent: routePersistent } = toolArgs as any
            if (routeAction === "list") {
              const res = await fetch(`${API}/routes`, { headers: authHeaders() }).then(r => r.json())
              const entries = Object.entries(res as Record<string, any>)
              result = entries.length === 0 ? "No routes" : entries.map(([n, r]: [string, any]) => `${n}.localhost -> ${typeof r.target === "string" ? r.target : ":" + r.target}${r.persistent ? " [persistent]" : ""}`).join("\n")
            } else if (routeAction === "add") {
              const res = await fetch(`${API}/register`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ name: routeName, port: routePort, persistent: routePersistent || false }) }).then(r => r.json())
              result = (res as any).error ? `Error: ${(res as any).error}` : `Route added: ${routeName}.localhost -> :${routePort}${routePersistent ? " (persistent)" : ""}`
            } else if (routeAction === "remove") {
              const res = await fetch(`${API}/register/${routeName}`, { method: "DELETE", headers: authHeaders() }).then(r => r.json())
              result = (res as any).error ? `Error: ${(res as any).error}` : `Route removed: ${routeName}.localhost`
            } else { result = "Unknown action" }
            break
          }
          case "candy_portals":
            result = await handlePortals()
            break
          case "candy_input":
            result = await handleInput(toolArgs)
            break
          default:
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Unknown tool: ${toolName}` }
            }
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{
              type: "text",
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
            }]
          }
        }

      case "notifications/initialized":
        return null

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown method: ${method}` }
        }
    }
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(e) }
    }
  }
}

// ============================================================================
// Main: stdio transport
// ============================================================================

async function main() {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()

  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split("\n")
    buffer = lines.pop() || ""

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const request = JSON.parse(line) as MCPRequest
        const response = await handleRequest(request)

        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n")
        }
      } catch (e) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        }) + "\n")
      }
    }
  }
}

main().catch(console.error)
