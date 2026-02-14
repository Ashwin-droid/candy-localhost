#!/usr/bin/env bun
/**
 * candy-localhost CLI v0.5.0
 * 
 * Usage:
 *   candy dev [cmd...]           Run dev server (auto-detects or uses saved config)
 *   candy dev <cmd> --name foo   Register and run with custom route name
 *   candy stop [name]            Stop server (current folder or by name)
 *   candy status                 Show all running servers
 *   candy logs [name]            Tail logs (current folder or by name)
 *   candy portal [name]          Open tunnel for server
 *   candy list                   List all registered configs
 * 
 * The daemon runs the actual server - this CLI is just a window into it.
 * Multiple terminals/AIs can watch the same logs simultaneously.
 */

const API = 'http://localhost:9999'
const VERSION = '0.5.0'

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
}

// Get current folder name as default route name
const getFolderName = (): string => {
  const cwd = process.cwd()
  return cwd.split('/').pop() || 'app'
}

// Get current working directory
const getCwd = (): string => process.cwd()

// API helpers - use MCP auth (reads secret from ~/.config/candy/mcp-secret)
const MCP_SECRET_FILE = `${process.env.HOME}/.config/candy/mcp-secret`

async function getApiKey(): Promise<string | null> {
  try {
    const secret = await Bun.file(MCP_SECRET_FILE).text()
    // Bootstrap: get API key using secret
    const res = await fetch(`${API}/mcp/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret.trim() })
    })
    if (res.ok) {
      const data = await res.json()
      return data.apiKey
    }
  } catch {}
  return null
}

let cachedApiKey: string | null = null

async function getHeaders(): Promise<Record<string, string>> {
  if (!cachedApiKey) {
    cachedApiKey = await getApiKey()
  }
  if (!cachedApiKey) {
    console.error(`${c.red}Error: Could not authenticate with daemon${c.reset}`)
    console.error(`${c.dim}Make sure the daemon is running and ${MCP_SECRET_FILE} exists${c.reset}`)
    process.exit(1)
  }
  return { 'X-Candy-API-Key': cachedApiKey }
}

async function apiGet(path: string) {
  const headers = await getHeaders()
  const res = await fetch(`${API}${path}`, { headers })
  return res.json()
}

async function apiPost(path: string, body?: any) {
  const headers = await getHeaders()
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function apiDelete(path: string) {
  const headers = await getHeaders()
  const res = await fetch(`${API}${path}`, { method: 'DELETE', headers })
  return res.json()
}

// Check if daemon is running
async function checkDaemon(): Promise<boolean> {
  try {
    await apiGet('/status')
    return true
  } catch {
    return false
  }
}

// Get config for current folder (by matching cwd)
async function getConfigForCwd(): Promise<{ name: string; cwd: string; cmd: string; configId?: string } | null> {
  try {
    const { configs } = await apiGet('/configs')
    const cwd = getCwd()
    
    for (const [name, config] of Object.entries(configs)) {
      const cfg = config as any
      if (cfg.cwd === cwd) {
        return { name, cwd: cfg.cwd, cmd: cfg.cmd, configId: cfg.id }
      }
      const variants = Array.isArray(cfg.variants) ? cfg.variants : []
      const match = variants.find((v: any) => v.cwd === cwd)
      if (match) {
        return { name, cwd: match.cwd, cmd: match.cmd, configId: match.id }
      }
    }
    return null
  } catch {
    return null
  }
}

// Get process status
async function getProcess(name: string): Promise<any | null> {
  try {
    const { processes } = await apiGet('/processes')
    return processes[name] || null
  } catch {
    return null
  }
}

// Clear screen and move cursor to top
const clearScreen = () => process.stdout.write('\x1b[2J\x1b[H')

// Print header
function printHeader(name: string, status: string, port?: number) {
  console.log(`${c.cyan}${c.bold}🍬 ${name}.localhost${c.reset}`)
  console.log(`${c.dim}   status: ${status === 'running' ? c.green : c.yellow}${status}${c.reset}`)
  if (port) {
    console.log(`${c.dim}   port: ${c.white}${port}${c.reset}`)
    console.log(`${c.dim}   url: ${c.cyan}https://${name}.localhost${c.reset}`)
  }
  console.log()
}

// Print help for interactive mode
function printControls() {
  console.log(`${c.dim}┌─────────────────────────────┐${c.reset}`)
  console.log(`${c.dim}│${c.reset} ${c.yellow}p${c.reset} enter port manually      ${c.dim}│${c.reset}`)
  console.log(`${c.dim}│${c.reset} ${c.yellow}o${c.reset} open in browser          ${c.dim}│${c.reset}`)
  console.log(`${c.dim}│${c.reset} ${c.yellow}t${c.reset} open tunnel (portal)     ${c.dim}│${c.reset}`)
  console.log(`${c.dim}│${c.reset} ${c.yellow}r${c.reset} restart                  ${c.dim}│${c.reset}`)
  console.log(`${c.dim}│${c.reset} ${c.yellow}q${c.reset} quit (server keeps running) ${c.dim}│${c.reset}`)
  console.log(`${c.dim}│${c.reset} ${c.yellow}Q${c.reset} quit and stop server     ${c.dim}│${c.reset}`)
  console.log(`${c.dim}└─────────────────────────────┘${c.reset}`)
  console.log()
}

// Stream logs via SSE (Bun CLI runtime has no browser EventSource)
async function streamLogs(name: string, onData: (data: string) => void, onStatus: (status: any) => void) {
  let closed = false
  let activeController: AbortController | null = null

  const handleSseBlock = (block: string) => {
    let eventType = 'message'
    const dataLines: string[] = []

    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue

      const idx = line.indexOf(':')
      const field = idx === -1 ? line : line.slice(0, idx)
      let value = idx === -1 ? '' : line.slice(idx + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      if (field === 'event') eventType = value
      if (field === 'data') dataLines.push(value)
    }

    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')

    if (eventType === 'status') {
      try {
        onStatus(JSON.parse(payload))
      } catch {}
      return
    }

    try {
      const data = JSON.parse(payload)
      onData(data)
    } catch {
      onData(payload)
    }
  }

  const connect = async () => {
    while (!closed) {
      activeController = new AbortController()
      try {
        const headers = await getHeaders()
        const res = await fetch(`${API}/stream/${name}`, {
          headers,
          signal: activeController.signal,
        })

        if (!res.ok || !res.body) {
          throw new Error(`SSE stream failed: ${res.status}`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const events = buffer.split(/\r?\n\r?\n/)
          buffer = events.pop() || ''
          for (const event of events) {
            handleSseBlock(event)
          }
        }

        buffer += decoder.decode()
        if (buffer.trim()) {
          handleSseBlock(buffer)
        }
      } catch {
        // Reconnect unless caller closed the stream.
      }

      if (!closed) {
        await new Promise(resolve => setTimeout(resolve, 750))
      }
    }
  }

  void connect()

  return () => {
    closed = true
    activeController?.abort()
  }
}

// Interactive dev mode
async function devMode(name: string, cmd: string | null, isNew: boolean, configId?: string) {
  let resolvedConfigId = configId
  // Register config if new
  if (cmd && isNew) {
    console.log(`${c.dim}Registering ${name}...${c.reset}`)
    const registered = await apiPost('/config', { name, cwd: getCwd(), cmd })
    if (registered?.config?.id) {
      resolvedConfigId = registered.config.id
    }
  }
  
  // Start the process
  console.log(`${c.dim}Starting ${name}...${c.reset}`)
  const startBody: Record<string, any> = {}
  if (resolvedConfigId) startBody.configId = resolvedConfigId
  const startResult = await apiPost(`/process/start/${name}`, startBody)
  
  if (startResult.error) {
    console.error(`${c.red}Error: ${startResult.error}${c.reset}`)
    process.exit(1)
  }
  
  // Setup terminal for raw input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  
  let currentStatus = 'starting'
  let currentPort: number | undefined
  let logBuffer = ''
  
  // Handle keyboard input
  process.stdin.on('data', async (key: string) => {
    // Ctrl+C or q
    if (key === '\u0003' || key === 'q') {
      console.log(`\n${c.dim}Detaching (server keeps running)...${c.reset}`)
      process.exit(0)
    }
    
    // Q = quit and stop
    if (key === 'Q') {
      console.log(`\n${c.dim}Stopping server...${c.reset}`)
      await apiPost(`/process/stop/${name}`)
      process.exit(0)
    }
    
    // p = manual port
    if (key === 'p') {
      process.stdout.write(`\n${c.yellow}Enter port: ${c.reset}`)
      process.stdin.setRawMode(false)
      
      const rl = await import('readline')
      const readline = rl.createInterface({ input: process.stdin, output: process.stdout })
      
      readline.question('', async (portStr) => {
        const port = parseInt(portStr.trim())
        if (port && port > 0 && port < 65536) {
          await apiPost(`/process/port/${name}`, { port })
          console.log(`${c.green}Port set to ${port}${c.reset}`)
          currentPort = port
        }
        readline.close()
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true)
        }
      })
    }
    
    // o = open browser
    if (key === 'o' && currentPort) {
      const url = `https://${name}.localhost`
      console.log(`\n${c.dim}Opening ${url}...${c.reset}`)
      await import('child_process').then(cp => {
        cp.exec(`xdg-open "${url}" || open "${url}" || start "${url}"`)
      })
    }
    
    // t = open tunnel
    if (key === 't') {
      console.log(`\n${c.dim}Opening tunnel...${c.reset}`)
      const result = await apiPost('/portal', { name, port: currentPort })
      if (result.url) {
        console.log(`${c.magenta}Tunnel: ${result.url}${c.reset}`)
      } else if (result.error) {
        console.log(`${c.red}Error: ${result.error}${c.reset}`)
      }
    }
    
    // r = restart
    if (key === 'r') {
      console.log(`\n${c.dim}Restarting...${c.reset}`)
      await apiPost(`/process/restart/${name}`)
    }
    
    // Any other key = send to PTY
    if (key.length === 1 && !['p', 'o', 't', 'r', 'q', 'Q'].includes(key)) {
      await apiPost(`/process/input/${name}`, { input: key })
    }
    
    // Special keys
    if (key === '\r') await apiPost(`/process/input/${name}`, { input: '\n' })
    if (key === '\x7f') await apiPost(`/process/input/${name}`, { key: 'backspace' })
    if (key === '\x1b[A') await apiPost(`/process/input/${name}`, { key: 'up' })
    if (key === '\x1b[B') await apiPost(`/process/input/${name}`, { key: 'down' })
    if (key === '\x1b[C') await apiPost(`/process/input/${name}`, { key: 'right' })
    if (key === '\x1b[D') await apiPost(`/process/input/${name}`, { key: 'left' })
  })
  
  // Print initial UI
  clearScreen()
  printHeader(name, 'starting')
  printControls()
  console.log(`${c.dim}─── logs ───${c.reset}\n`)
  
  // Stream logs
  const closeStream = await streamLogs(
    name,
    (data) => {
      process.stdout.write(data)
    },
    (status) => {
      if (status.status !== currentStatus || status.port !== currentPort) {
        currentStatus = status.status
        currentPort = status.port
        // Could update header here with cursor positioning
      }
    }
  )
  
  // Cleanup on exit
  process.on('exit', () => {
    closeStream()
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
  })
}

// ============================================================================
// Commands
// ============================================================================

async function cmdDev(args: string[]) {
  // Parse --name flag
  let customName: string | null = null
  const nameIdx = args.indexOf('--name')
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    customName = args[nameIdx + 1]
    args.splice(nameIdx, 2)
  }
  
  // Rest is the command
  const cmd = args.length > 0 ? args.join(' ') : null
  const folderName = getFolderName()
  const name = customName || folderName
  
  // Check daemon
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    console.error(`${c.dim}Start it with: sudo systemctl start candy-localhost@$USER${c.reset}`)
    process.exit(1)
  }
  
  // Check if we have existing config for this folder
  const existingConfig = await getConfigForCwd()
  
  if (cmd) {
    // New command provided - register/update and run
    await devMode(name, cmd, true)
  } else if (existingConfig) {
    // No command but we have saved config - use it
    console.log(`${c.dim}Using saved config: ${existingConfig.cmd}${c.reset}`)
    await devMode(existingConfig.name, null, false, existingConfig.configId)
  } else {
    // No command and no saved config - try to detect from package.json
    try {
      const pkg = await Bun.file('./package.json').json()
      if (pkg.scripts?.dev) {
        const detectedCmd = `npm run dev`
        console.log(`${c.dim}Detected: ${detectedCmd}${c.reset}`)
        await devMode(name, detectedCmd, true)
      } else {
        console.error(`${c.red}No command specified and no saved config found${c.reset}`)
        console.error(`${c.dim}Usage: candy dev <command>${c.reset}`)
        console.error(`${c.dim}Example: candy dev bun run dev${c.reset}`)
        process.exit(1)
      }
    } catch {
      console.error(`${c.red}No command specified and no saved config found${c.reset}`)
      console.error(`${c.dim}Usage: candy dev <command>${c.reset}`)
      console.error(`${c.dim}Example: candy dev bun run dev${c.reset}`)
      process.exit(1)
    }
  }
}

async function cmdStop(args: string[]) {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }
  
  let name = args[0]
  
  if (!name) {
    // Try to get from current folder
    const config = await getConfigForCwd()
    if (config) {
      name = config.name
    } else {
      name = getFolderName()
    }
  }
  
  console.log(`${c.dim}Stopping ${name}...${c.reset}`)
  const result = await apiPost(`/process/stop/${name}`)
  
  if (result.error) {
    console.error(`${c.red}Error: ${result.error}${c.reset}`)
    process.exit(1)
  }
  
  console.log(`${c.green}Stopped ${name}${c.reset}`)
}

async function cmdStatus(args: string[]) {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }
  
  const [status, { processes }, { configs }] = await Promise.all([
    apiGet('/status'),
    apiGet('/processes'),
    apiGet('/configs'),
  ])
  
  console.log(`${c.cyan}${c.bold}🍬 candy-localhost${c.reset} ${c.dim}v${VERSION}${c.reset}`)
  console.log(`${c.dim}   daemon: ${c.green}running${c.reset} ${c.dim}(PID ${status.pid})${c.reset}`)
  console.log(`${c.dim}   routes: ${status.routeCount}  portals: ${status.portalCount}${c.reset}`)
  console.log()
  
  const configNames = Object.keys(configs).filter(k => k !== 'success')
  
  if (configNames.length === 0) {
    console.log(`${c.dim}No servers registered${c.reset}`)
    return
  }
  
  for (const name of configNames) {
    const config = configs[name]
    const proc = processes[name]
    const status = proc?.status || 'stopped'
    const port = proc?.port
    const statusColor = status === 'running' ? c.green : status === 'starting' ? c.yellow : c.dim
    
    console.log(`${c.white}${name}.localhost${c.reset}`)
    console.log(`  ${c.dim}status:${c.reset} ${statusColor}${status}${c.reset}${port ? ` ${c.dim}:${port}${c.reset}` : ''}`)
    console.log(`  ${c.dim}cmd:${c.reset} ${config.cmd}`)
    console.log(`  ${c.dim}cwd:${c.reset} ${config.cwd}`)
    console.log()
  }
}

async function cmdLogs(args: string[]) {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }
  
  let name = args[0]
  
  if (!name) {
    const config = await getConfigForCwd()
    if (config) {
      name = config.name
    } else {
      name = getFolderName()
    }
  }
  
  console.log(`${c.dim}Tailing logs for ${name}...${c.reset}`)
  console.log(`${c.dim}Press Ctrl+C to exit${c.reset}\n`)
  
  await streamLogs(
    name,
    (data) => process.stdout.write(data),
    () => {}
  )
  
  // Keep running
  await new Promise(() => {})
}

async function cmdPortal(args: string[]) {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }
  
  let name = args[0]
  
  if (!name) {
    const config = await getConfigForCwd()
    if (config) {
      name = config.name
    } else {
      name = getFolderName()
    }
  }
  
  console.log(`${c.dim}Opening tunnel for ${name}...${c.reset}`)
  const result = await apiPost('/portal', { name })
  
  if (result.error) {
    console.error(`${c.red}Error: ${result.error}${c.reset}`)
    process.exit(1)
  }
  
  console.log(`${c.magenta}${c.bold}Tunnel: ${result.url}${c.reset}`)
}

async function cmdList() {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }
  
  const { configs } = await apiGet('/configs')
  const names = Object.keys(configs).filter(k => k !== 'success')
  
  if (names.length === 0) {
    console.log(`${c.dim}No servers registered${c.reset}`)
    return
  }
  
  for (const name of names) {
    const config = configs[name]
    console.log(`${c.cyan}${name}${c.reset}`)
    console.log(`  ${c.dim}cwd:${c.reset} ${config.cwd}`)
    console.log(`  ${c.dim}cmd:${c.reset} ${config.cmd}`)
  }
}

async function cmdMcp() {
  // Run the MCP server - this takes over stdio
  const mcpPath = import.meta.dir + '/mcp.ts'
  await import(mcpPath)
}

async function cmdDaemon() {
  // Run the daemon (for dev, normally use systemd)
  console.log(`${c.dim}Starting daemon...${c.reset}`)
  const daemonPath = import.meta.dir + '/daemon.ts'
  await import(daemonPath)
}

function printHelp() {
  console.log(`${c.cyan}${c.bold}🍬 candy-localhost${c.reset} ${c.dim}v${VERSION}${c.reset}`)
  console.log(`${c.dim}we hand out domains like it's 1980${c.reset}`)
  console.log()
  console.log(`${c.white}Usage:${c.reset}`)
  console.log(`  ${c.cyan}candy dev${c.reset} [cmd...]           Run dev server (uses saved config or auto-detects)`)
  console.log(`  ${c.cyan}candy dev${c.reset} <cmd> --name foo   Register and run with custom route name`)
  console.log(`  ${c.cyan}candy stop${c.reset} [name]            Stop server (current folder or by name)`)
  console.log(`  ${c.cyan}candy status${c.reset}                 Show all running servers`)
  console.log(`  ${c.cyan}candy logs${c.reset} [name]            Tail logs (current folder or by name)`)
  console.log(`  ${c.cyan}candy portal${c.reset} [name]          Open tunnel for server`)
  console.log(`  ${c.cyan}candy list${c.reset}                   List all registered configs`)
  console.log(`  ${c.cyan}candy mcp${c.reset}                    Start MCP server (stdio) for AI integration`)
  console.log(`  ${c.cyan}candy daemon${c.reset}                 Run the daemon (use systemd for production)`)
  console.log()
  console.log(`${c.white}Examples:${c.reset}`)
  console.log(`  ${c.dim}# First time in a project${c.reset}`)
  console.log(`  ${c.cyan}candy dev bun run dev${c.reset}`)
  console.log()
  console.log(`  ${c.dim}# After that, just:${c.reset}`)
  console.log(`  ${c.cyan}candy dev${c.reset}`)
  console.log()
  console.log(`  ${c.dim}# Custom route name${c.reset}`)
  console.log(`  ${c.cyan}candy dev npm start --name api${c.reset}`)
  console.log()
  console.log(`${c.dim}The daemon runs the server - this CLI is just a window into it.${c.reset}`)
  console.log(`${c.dim}Multiple terminals/AIs can watch the same logs simultaneously.${c.reset}`)
}

// ============================================================================
// Main
// ============================================================================

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'dev':
    cmdDev(args.slice(1))
    break
  case 'stop':
    cmdStop(args.slice(1))
    break
  case 'status':
    cmdStatus(args.slice(1))
    break
  case 'logs':
    cmdLogs(args.slice(1))
    break
  case 'portal':
    cmdPortal(args.slice(1))
    break
  case 'list':
    cmdList()
    break
  case 'mcp':
    cmdMcp()
    break
  case 'daemon':
    cmdDaemon()
    break
  case 'help':
  case '--help':
  case '-h':
    printHelp()
    break
  case 'version':
  case '--version':
  case '-v':
    console.log(`candy-localhost v${VERSION}`)
    break
  default:
    if (command) {
      console.error(`${c.red}Unknown command: ${command}${c.reset}`)
      console.error(`${c.dim}Run 'candy help' for usage${c.reset}`)
      process.exit(1)
    }
    printHelp()
}
