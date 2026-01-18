/**
 * candy-localhost MCP Server
 *
 * Simple server management tools: list, start, stop, logs
 * Designed for autonomous agent use - no explicit user request needed.
 */

import { $ } from "bun"

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
const LOGS_DIR = "/tmp/candy-logs"

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
    name: "candy_stop",
    description: `Stop a running dev server by name.

USE THIS TOOL AUTONOMOUSLY when:
- User says "stop the server" or "kill the app"
- User is done testing and wants to free up the port
- Server is in errored/crashed state and needs to be stopped before restart
- User is switching to a different project

Sends SIGTERM to gracefully stop the process.

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
  }
]

// ============================================================================
// Daemon API Client
// ============================================================================

let sessionToken: string | null = null

async function getToken(): Promise<string> {
  if (!sessionToken) {
    const res = await fetch(`${DAEMON_URL}/session`, { method: "POST" })
    const data = await res.json() as { token: string }
    sessionToken = data.token
  }
  return sessionToken
}

async function refreshToken(): Promise<string> {
  const res = await fetch(`${DAEMON_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sessionToken })
  })
  const data = await res.json() as { token: string }
  sessionToken = data.token
  return sessionToken
}

async function daemonFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getToken()

  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      "X-Candy-Token": token,
      "X-Candy-Actor": "AI",
      "Content-Type": "application/json"
    }
  })

  await refreshToken()
  return res.json()
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function handleServers(): Promise<any> {
  const [configsRes, processesRes] = await Promise.all([
    daemonFetch("/configs"),
    daemonFetch("/processes")
  ])

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

async function handleStop(params: any): Promise<any> {
  const { name } = params
  return await daemonFetch(`/process/stop/${name}`, { method: "POST" })
}

async function handleLogs(params: any): Promise<any> {
  const { name, mode = "tail", lines = 50, pattern } = params
  const logFile = `${LOGS_DIR}/${name}.log`
  const lineCount = Math.min(lines, 500)

  try {
    const file = Bun.file(logFile)
    if (!await file.exists()) {
      return { error: `No logs found for '${name}'. Server may not have been started yet.` }
    }

    let result: string
    if (mode === "search" && pattern) {
      result = await $`grep -n -C 2 ${pattern} ${logFile}`.nothrow().text()
      if (!result.trim()) result = "(no matches)"
    } else if (mode === "head") {
      result = await $`head -n ${lineCount} ${logFile}`.nothrow().text()
    } else {
      result = await $`tail -n ${lineCount} ${logFile}`.nothrow().text()
    }

    // Get server config and status for more context
    let serverInfo: any = {}
    try {
      const [configsRes, processesRes] = await Promise.all([
        daemonFetch("/configs"),
        daemonFetch("/processes")
      ])
      const config = configsRes.configs?.[name]
      const proc = processesRes.processes?.[name]
      if (config) {
        serverInfo = {
          cwd: config.cwd,
          cmd: config.cmd,
          status: proc?.status || "stopped",
          port: proc?.port || null,
          pid: proc?.pid || null
        }
      }
    } catch {}

    return {
      candy: `Lazy dev server orchestrator. Hands out domains on .localhost TLD.`,
      server: {
        name,
        url: `https://${name}.localhost`,
        ...serverInfo
      },
      query: {
        mode,
        lines: mode !== "search" ? lineCount : undefined,
        pattern: mode === "search" ? pattern : undefined
      },
      logs: result || "(no output)"
    }
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
          case "candy_stop":
            result = await handleStop(toolArgs)
            break
          case "candy_logs":
            result = await handleLogs(toolArgs)
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
