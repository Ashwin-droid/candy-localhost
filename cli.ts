#!/usr/bin/env bun
import { exchangeSecret, secretHint } from "./secret.ts"
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
 *   candy auth set <domain>       Set password for bound domain
 *   candy auth clear <domain>     Remove password from bound domain
 *   candy auth status             Show auth status for all bound domains
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

// API helpers - use MCP auth (secret from ~/.config/candy/mcp-secret or /run/candy/secret)
async function getApiKey(): Promise<string | null> {
  try {
    return await exchangeSecret(API)
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
    console.error(`${c.dim}${secretHint()}${c.reset}`)
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
async function devMode(name: string, cmd: string | null, isNew: boolean, configId?: string, api = false) {
  let resolvedConfigId = configId
  // Register config if new
  if (cmd && isNew) {
    console.log(`${c.dim}Registering ${name}${api ? ' (API mode)' : ''}...${c.reset}`)
    const registered = await apiPost('/config', { name, cwd: getCwd(), cmd, ...(api ? { api: true } : {}) })
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
  // --api: hold requests while the server starts and forward them (no loading page)
  const apiIdx = args.indexOf('--api')
  const api = apiIdx !== -1
  if (api) args.splice(apiIdx, 1)
  
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
    await devMode(name, cmd, true, undefined, api)
  } else if (existingConfig) {
    // No command but we have saved config - use it
    console.log(`${c.dim}Using saved config: ${existingConfig.cmd}${c.reset}`)
    if (api) await apiPost('/config/api', { name: existingConfig.name, configId: existingConfig.configId, api: true })
    await devMode(existingConfig.name, null, false, existingConfig.configId)
  } else {
    // No command and no saved config - try to detect from package.json
    try {
      const pkg = await Bun.file('./package.json').json()
      if (pkg.scripts?.dev) {
        const detectedCmd = `npm run dev`
        console.log(`${c.dim}Detected: ${detectedCmd}${c.reset}`)
        await devMode(name, detectedCmd, true, undefined, api)
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

// Auth management
async function cmdAuth(args: string[]) {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }

  const sub = args[0]

  if ((sub === 'set' || sub === 's') && args.includes('--jwt')) {
    // candy auth set <domain> --jwt [secret]   (no secret: the daemon generates one)
    const rest = args.slice(1).filter(a => a !== '--jwt')
    const subdomain = rest[0]
    if (!subdomain) {
      console.error(`${c.red}Usage: candy auth set <domain> --jwt [secret]${c.reset}`)
      process.exit(1)
    }
    const res = await apiPost('/auth/set', { subdomain, jwtSecret: rest[1] || 'generate' })
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
      process.exit(1)
    }
    console.log(`${c.green}${res.message}${c.reset}`)
    if (res.jwtSecret) {
      console.log(`\n  ${c.bold}${res.jwtSecret}${c.reset}\n`)
      console.log(`${c.dim}This is shown once. Sign HS256 JWTs with it: aud "Candy API Authorization Service",${c.reset}`)
      console.log(`${c.dim}sub "<site>.candy", exp at most 1h away, iat now, optional jti for single use.${c.reset}`)
      console.log(`${c.dim}Send them in X-Auth-Token. Try one with: candy auth token ${subdomain}${c.reset}`)
    }
    return
  }

  if (sub === 'token' || sub === 't') {
    // candy auth token <domain> [--ttl <seconds>] [--once]
    const subdomain = args[1]
    if (!subdomain) {
      console.error(`${c.red}Usage: candy auth token <domain> [--ttl <seconds>] [--once]${c.reset}`)
      process.exit(1)
    }
    const ttlIdx = args.indexOf('--ttl')
    const ttl = ttlIdx !== -1 ? Number(args[ttlIdx + 1]) : undefined
    const res = await apiPost('/auth/token', { subdomain, ttl, jti: args.includes('--once') })
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
      process.exit(1)
    }
    console.log(res.token)
    return
  }

  if (sub === 'set' || sub === 's') {
    const subdomain = args[1]
    if (!subdomain) {
      console.error(`${c.red}Usage: candy auth set <domain> [password]${c.reset}`)
      process.exit(1)
    }

    let password = args[2]
    if (!password) {
      // Prompt for password
      const rl = await import('readline')
      const readline = rl.createInterface({ input: process.stdin, output: process.stdout })
      password = await new Promise<string>(resolve => {
        // Hide input
        process.stdout.write(`${c.yellow}Password: ${c.reset}`)
        if (process.stdin.isTTY) process.stdin.setRawMode(true)
        let buf = ''
        const onData = (ch: string) => {
          if (ch === '\r' || ch === '\n') {
            process.stdin.removeListener('data', onData)
            if (process.stdin.isTTY) process.stdin.setRawMode(false)
            process.stdout.write('\n')
            readline.close()
            resolve(buf)
          } else if (ch === '\x7f' || ch === '\b') {
            if (buf.length > 0) {
              buf = buf.slice(0, -1)
              process.stdout.write('\b \b')
            }
          } else if (ch === '\x03') {
            // Ctrl+C
            if (process.stdin.isTTY) process.stdin.setRawMode(false)
            readline.close()
            process.exit(0)
          } else {
            buf += ch
            process.stdout.write('*')
          }
        }
        process.stdin.on('data', onData)
        process.stdin.resume()
      })
    }

    if (!password || password.length < 1) {
      console.error(`${c.red}Password cannot be empty${c.reset}`)
      process.exit(1)
    }

    const res = await apiPost('/auth/set', { subdomain, password })
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
    } else {
      console.log(`${c.green}${res.message}${c.reset}`)
    }
  } else if (sub === 'clear' || sub === 'c') {
    const subdomain = args[1]
    if (!subdomain) {
      console.error(`${c.red}Usage: candy auth clear <domain> [--jwt|--password]${c.reset}`)
      process.exit(1)
    }
    const which = args.includes('--jwt') ? 'jwt' : args.includes('--password') ? 'password' : 'all'
    const res = await apiPost('/auth/clear', { subdomain, which })
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
    } else {
      console.log(`${c.green}${res.message}${c.reset}`)
    }
  } else if (sub === 'status' || !sub) {
    const res = await apiGet('/auth/status')
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
      return
    }
    const domains = Object.entries(res.domains || {})
    if (domains.length === 0) {
      console.log(`${c.dim}No bound domains configured${c.reset}`)
      return
    }
    console.log(`${c.cyan}${c.bold}Bound Domain Auth Status${c.reset}`)
    console.log()
    for (const [sub, info] of domains) {
      const i = info as any
      const methods = [i.hasPassword ? 'password' : '', i.hasJwtSecret ? 'JWT' : ''].filter(Boolean).join(' + ')
      const authStatus = !i.authEnabled
        ? `${c.yellow}unprotected${c.reset}`
        : i.apiMode
          ? `${c.green}protected${c.reset} (${methods}, checked on every request)`
          : `${c.green}protected${c.reset} (${methods}, ${i.activeSessions} active session${i.activeSessions !== 1 ? 's' : ''})`
      console.log(`  ${c.white}${i.fqdn}${c.reset} -> ${c.cyan}${i.serverName}${c.reset}`)
      console.log(`    auth: ${authStatus}`)
    }
  } else {
    console.error(`${c.red}Unknown auth subcommand: ${sub}${c.reset}`)
    console.error(`${c.dim}Usage: candy auth [set|token|clear|status]${c.reset}`)
    process.exit(1)
  }
}

// Domain management
async function cmdDomain(args: string[]) {
  if (!await checkDaemon()) {
    console.error(`${c.red}Error: candy daemon not running${c.reset}`)
    process.exit(1)
  }

  const sub = args[0]

  if (sub === 'list' || sub === 'ls' || !sub) {
    const res = await apiGet('/domains')
    if (!res.configured) {
      console.log(`${c.dim}Domain config not set up.${c.reset}`)
      console.log(`${c.dim}Run: candy domain config --zone <domain> --tunnel <name>${c.reset}`)
      return
    }
    console.log(`${c.cyan}${c.bold}Bound Domains${c.reset} ${c.dim}(*.${res.zone?.domain})${c.reset}`)
    console.log(`${c.dim}Tunnel: ${res.tunnel?.name} (${res.tunnel?.id?.slice(0, 8)}...)${c.reset}`)
    console.log()
    const bindings = Object.values(res.bindings || {})
    if (bindings.length === 0) {
      console.log(`${c.dim}No bound domains yet.${c.reset}`)
    } else {
      for (const b of bindings as any[]) {
        console.log(`  ${c.green}${b.fqdn}${c.reset} -> ${c.cyan}${b.serverName}${c.reset}`)
      }
    }
  } else if (sub === 'allow' || sub === 'allowlist') {
    // candy domain allow <sub> [ip|cidr ...] | --off | --on | --rm <ip ...>
    const subdomain = args[1]
    const rest = args.slice(2)
    if (!subdomain) {
      console.error(`${c.red}Usage: candy domain allow <subdomain> [ip|cidr ...] [--rm <ip ...>] [--on|--off]${c.reset}`)
      process.exit(1)
    }
    const rmIdx = rest.indexOf('--rm')
    const add = (rmIdx === -1 ? rest : rest.slice(0, rmIdx)).filter(a => !a.startsWith('--'))
    const remove = rmIdx === -1 ? [] : rest.slice(rmIdx + 1).filter(a => !a.startsWith('--'))
    const enabled = rest.includes('--off') ? false : rest.includes('--on') ? true : undefined
    if (!add.length && !remove.length && enabled === undefined) {
      const res = await apiGet('/domains')
      const b = Object.values(res.bindings || {}).find((x: any) => x.subdomain === subdomain || x.fqdn === subdomain) as any
      if (!b) { console.error(`${c.red}No binding found for '${subdomain}'${c.reset}`); process.exit(1) }
      const al = b.allowlist || { enabled: false, ips: [] }
      console.log(al.enabled
        ? `${b.fqdn}: allowlist on. Allowed: ${[...al.ips, 'Tailscale', 'this machine'].join(', ')}`
        : `${b.fqdn}: allowlist off (any address)${al.ips.length ? `. Saved: ${al.ips.join(', ')}` : ''}`)
      return
    }
    const res = await apiPost('/domains/allowlist', { subdomain, add, remove, ...(enabled !== undefined ? { enabled } : {}) })
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
      process.exit(1)
    }
    console.log(`${c.green}${res.message}${c.reset}`)
  } else if (sub === 'bind' || sub === 'b') {
    const subdomain = args[1]
    let serverName: string | undefined
    const serverIdx = args.indexOf('--server')
    if (serverIdx !== -1 && args[serverIdx + 1]) {
      serverName = args[serverIdx + 1]
    } else {
      serverName = args[2]
    }
    if (!subdomain) {
      console.error(`${c.red}Usage: candy domain bind <subdomain> [--server <name>]${c.reset}`)
      process.exit(1)
    }
    if (!serverName) {
      // Default to subdomain as server name
      serverName = subdomain
    }
    console.log(`${c.dim}Binding ${subdomain} -> ${serverName}...${c.reset}`)
    const res = await apiPost('/domains/bind', { subdomain, serverName })
    if (res?.warning) {
      console.log(`${c.yellow}${res.message}${c.reset}`)
      console.log(`${c.dim}Existing records:${c.reset}`)
      for (const r of res.existingRecords || []) {
        console.log(`  ${c.dim}${r.type} -> ${r.content}${c.reset}`)
      }
      // Ask for confirmation
      const rl = await import('readline')
      const readline = rl.createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise<string>(resolve => {
        readline.question(`${c.yellow}Override? (y/N): ${c.reset}`, resolve)
      })
      readline.close()
      if (answer.toLowerCase() !== 'y') {
        console.log(`${c.dim}Cancelled.${c.reset}`)
        return
      }
      // Retry with force
      const forceRes = await apiPost('/domains/bind', { subdomain, serverName, force: true })
      if (forceRes?.error) {
        console.error(`${c.red}${forceRes.error}${c.reset}`)
      } else {
        console.log(`${c.green}${forceRes.message}${c.reset}`)
        console.log(`${c.dim}${forceRes.binding?.fqdn}${c.reset}`)
      }
    } else if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
    } else {
      console.log(`${c.green}${res.message}${c.reset}`)
      console.log(`${c.dim}${res.binding?.fqdn}${c.reset}`)
    }
  } else if (sub === 'unbind' || sub === 'u') {
    const subdomain = args[1]
    if (!subdomain) {
      console.error(`${c.red}Usage: candy domain unbind <subdomain>${c.reset}`)
      process.exit(1)
    }
    console.log(`${c.dim}Unbinding ${subdomain}...${c.reset}`)
    const res = await apiDelete(`/domains/unbind/${subdomain}`)
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
    } else {
      console.log(`${c.magenta}${res.message}${c.reset}`)
    }
  } else if (sub === 'config') {
    // Parse flags
    let zone = '', tunnel = '', tunnelId = '', credentialsFile = ''
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--zone' && args[i + 1]) { zone = args[++i]; continue }
      if (args[i] === '--tunnel' && args[i + 1]) { tunnel = args[++i]; continue }
      if (args[i] === '--tunnel-id' && args[i + 1]) { tunnelId = args[++i]; continue }
      if (args[i] === '--credentials' && args[i + 1]) { credentialsFile = args[++i]; continue }
    }
    if (!zone && !tunnel) {
      console.error(`${c.red}Usage: candy domain config --zone <domain> --tunnel <name> [--tunnel-id <id>] [--credentials <path>]${c.reset}`)
      process.exit(1)
    }
    const body: any = {}
    if (zone) {
      // Fetch zone ID from CF API if only domain provided
      body.zone = { domain: zone, id: '' }
    }
    if (tunnel || tunnelId) {
      body.tunnel = {
        name: tunnel || '',
        id: tunnelId || '',
        credentialsFile: credentialsFile || '',
      }
    }
    const res = await apiPost('/domains/config', body)
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
    } else {
      console.log(`${c.green}Domain config updated${c.reset}`)
      if (res.zone?.domain) console.log(`  ${c.dim}zone: ${res.zone.domain}${c.reset}`)
      if (res.tunnel?.name) console.log(`  ${c.dim}tunnel: ${res.tunnel.name}${c.reset}`)
    }
  } else {
    console.error(`${c.red}Unknown domain subcommand: ${sub}${c.reset}`)
    console.error(`${c.dim}Usage: candy domain [list|bind|unbind|config]${c.reset}`)
    process.exit(1)
  }
}

function printHelp() {
  console.log(`${c.cyan}${c.bold}🍬 candy-localhost${c.reset} ${c.dim}v${VERSION}${c.reset}`)
  console.log()
  console.log(`${c.white}Usage:${c.reset}`)
  console.log(`  ${c.cyan}candy dev${c.reset} [cmd...]           Run dev server (uses saved config or auto-detects)`)
  console.log(`  ${c.cyan}candy dev${c.reset} <cmd> --name foo   Register and run with custom route name`)
  console.log(`  ${c.cyan}candy dev${c.reset} <cmd> --api        API mode: hold the first request while starting, then forward it`)
  console.log(`  ${c.cyan}candy api${c.reset} <name> [on|off]     Turn API mode on or off for a site`)
  console.log(`  ${c.cyan}candy stop${c.reset} [name]            Stop server (current folder or by name)`)
  console.log(`  ${c.cyan}candy status${c.reset}                 Show all running servers`)
  console.log(`  ${c.cyan}candy logs${c.reset} [name]            Tail logs (current folder or by name)`)
  console.log(`  ${c.cyan}candy portal${c.reset} [name]          Open tunnel for server`)
  console.log(`  ${c.cyan}candy list${c.reset}                   List all registered configs`)
  console.log(`  ${c.cyan}candy route${c.reset} [add|rm]          Manage domain routes (--persistent|-p)`)
  console.log(`  ${c.cyan}candy lan${c.reset} [publish|unpublish] <name>  Make <name>.candy reachable from the LAN (opt-in)`)
  console.log(`      ${c.dim}publish <name> --https         trusted HTTPS on the LAN: the bound domain if any, else ts.net${c.reset}`)
  console.log(`      ${c.dim}publish <name> --https=domain|tailscale|<port>   pick the mode (a port means ts.net)${c.reset}`)
  console.log(`      ${c.dim}publish <name> --no-https      turn LAN HTTPS off, keep <name>.candy${c.reset}`)
  console.log(`      ${c.dim}adguard setup|status|off       let candy keep AdGuard Home's LAN upstreams in sync${c.reset}`)
  console.log(`  ${c.cyan}candy domain${c.reset} [list|bind|unbind|config]  Manage bound domains`)
  console.log(`  ${c.cyan}candy auth${c.reset} [set|clear|status] Manage bound domain authentication`)
  console.log(`      ${c.dim}set <domain> --jwt [secret]  JWT secret for API-mode sites (generated if omitted)${c.reset}`)
  console.log(`      ${c.dim}token <domain> [--ttl s] [--once]  mint a JWT to test with${c.reset}`)
  console.log(`  ${c.cyan}candy domain allow${c.reset} <sub> [ip|cidr...] [--rm ip...] [--on|--off]  Allowlist mode (Tailscale always allowed)`)
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
  console.log(`  ${c.dim}# Bind a subdomain to a server${c.reset}`)
  console.log(`  ${c.cyan}candy domain bind myapp --server inkspired${c.reset}`)
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
  case 'auth':
    cmdAuth(args.slice(1))
    break
  case 'api': {
    const [name, state] = args.slice(1)
    if (!name || (state && !['on', 'off'].includes(state))) {
      console.error(`${c.red}Usage: candy api <name> [on|off]${c.reset}`)
      process.exit(1)
    }
    const res = await apiPost('/config/api', { name, api: state !== 'off' })
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
      process.exit(1)
    }
    console.log(state === 'off'
      ? `${name}: API mode off. Browsers get the loading page again.`
      : `${name}: API mode on. The first request waits for the server and is forwarded to it.`)
    break
  }
  case 'domain':
  case 'domains':
    cmdDomain(args.slice(1))
    break
  case 'route':
  case 'routes': {
    const rargs = args.slice(1)
    const sub = rargs[0]
    if (sub === 'add' || sub === 'a') {
      const name = rargs[1]
      const port = parseInt(rargs[2])
      const persistent = rargs.includes('--persistent') || rargs.includes('-p')
      if (!name || !port) {
        console.error(`${c.red}Usage: candy route add <name> <port> [--persistent|-p]${c.reset}`)
        process.exit(1)
      }
      const res = await apiPost('/register', { name, port, persistent })
      if (res?.error) {
        console.error(`${c.red}${res.error}${c.reset}`)
      } else {
        console.log(`${c.green}+ ${name}.localhost -> :${port}${persistent ? ' (persistent)' : ''}${c.reset}`)
      }
    } else if (sub === 'rm' || sub === 'remove') {
      const name = rargs[1]
      if (!name) {
        console.error(`${c.red}Usage: candy route rm <name>${c.reset}`)
        process.exit(1)
      }
      const res = await fetch(`${API}/register/${name}`, { method: 'DELETE', headers: await getHeaders() }).then(r => r.json()).catch(() => null)
      if (res?.error) {
        console.error(`${c.red}${res.error}${c.reset}`)
      } else {
        console.log(`${c.red}- ${name}.localhost${c.reset}`)
      }
    } else {
      // List routes
      const res = await fetch(`${API}/routes`, { headers: await getHeaders() }).then(r => r.json()).catch(() => null)
      if (!res) {
        console.error(`${c.red}Daemon not running${c.reset}`)
        process.exit(1)
      }
      const names = Object.keys(res)
      if (names.length === 0) {
        console.log(`${c.dim}No routes registered${c.reset}`)
      } else {
        for (const name of names) {
          const r = res[name]
          const flags = (r.persistent ? ` ${c.cyan}[persistent]${c.reset}` : '') + (r.lan ? ` ${c.green}[lan]${c.reset}` : '')
          console.log(`  ${c.green}${name}.localhost${c.reset} -> ${r.isRestricted ? r.target : ':' + r.target}${flags}`)
        }
      }
    }
    break
  }
  case 'lan': {
    const largs = args.slice(1)
    const sub = largs[0]
    if (sub === 'publish' || sub === 'unpublish') {
      const name = largs[1]
      if (!name) {
        console.error(`${c.red}Usage: candy lan ${sub} <name>${c.reset}`)
        process.exit(1)
      }
      const publish = sub === 'publish'
      const body: Record<string, unknown> = { name, publish }
      for (const flag of largs.slice(2)) {
        // --https (bound domain if there is one, else ts.net), --https=domain,
        // --https=tailscale, --https=<port> (ts.net on that port)
        const httpsFlag = flag.match(/^--https(?:=(\d+|domain|tailscale))?$/)
        if (httpsFlag && publish) {
          const value = httpsFlag[1]
          if (!value) body.https = true
          else if (/^\d+$/.test(value)) { body.https = "tailscale"; body.port = Number(value) }
          else body.https = value
        } else if (flag === '--no-https' && publish) {
          body.https = false
        } else {
          console.error(`${c.red}Unknown option: ${flag}${c.reset}`)
          process.exit(1)
        }
      }
      const res = await apiPost('/lan', body)
      if (!res) {
        console.error(`${c.red}Daemon not running${c.reset}`)
        process.exit(1)
      }
      if (res.error) {
        console.error(`${c.red}${res.error}${res.details ? ` (${res.details})` : ''}${c.reset}`)
        process.exit(1)
      }
      if (publish) {
        console.log(`${c.green}+ ${name}.candy published to LAN${res.lanIp ? ` -> ${res.lanIp}` : ''}${c.reset}`)
        if (res.httpsUrl) console.log(`${c.green}+ ${res.httpsUrl}${c.reset} ${c.dim}(LAN, trusted cert)${c.reset}`)
        else if (body.https === false) console.log(`${c.dim}  LAN HTTPS is off${c.reset}`)
        if (res.httpsUrl && !res.dnsManaged) {
          console.log(`${c.dim}  LAN DNS must send this name to candy-dns's LAN listener. Run 'candy lan adguard setup' once to have candy keep AdGuard Home in sync.${c.reset}`)
        }
        if (res.warning) console.log(`${c.yellow}${res.warning}${c.reset}`)
      } else {
        console.log(`${c.red}- ${name}.candy no longer published to LAN${c.reset}`)
      }
    } else if (sub === 'adguard') {
      // candy lan adguard [status] | setup [--url U] [--user NAME] [--client NAME] [--dns host:port] | off
      const action = largs[1] || 'status'
      const show = (res: any) => {
        if (!res?.configured) {
          console.log(`${c.dim}AdGuard Home is not linked. Run: candy lan adguard setup${c.reset}`)
          return
        }
        console.log(`${c.green}AdGuard Home linked${c.reset} ${c.dim}${res.url}, client "${res.client}", as ${res.username}${c.reset}`)
        console.log(`  ${c.dim}LAN names go to ${res.dnsTarget}:${c.reset} ${res.rules.length ? res.rules.join('  ') : 'none right now'}`)
        if (res.error) console.log(`  ${c.red}Last sync failed: ${res.error}${c.reset}`)
      }
      const fail = (res: any) => {
        if (!res) { console.error(`${c.red}Daemon not running${c.reset}`); process.exit(1) }
        if (res.error) { console.error(`${c.red}${res.error}${c.reset}`); process.exit(1) }
      }
      if (action === 'status') {
        const res = await apiGet('/lan/adguard'); fail(res); show(res)
      } else if (action === 'off') {
        const res = await apiPost('/lan/adguard', { remove: true }); fail(res)
        console.log(`${c.red}- AdGuard Home link removed${c.reset} ${c.dim}(lines candy added were taken out)${c.reset}`)
      } else if (action === 'setup') {
        const opts: Record<string, string> = {}
        const rest = largs.slice(2)
        for (let i = 0; i < rest.length; i++) {
          const m = rest[i].match(/^--(url|user|client|dns)(?:=(.*))?$/)
          if (!m) { console.error(`${c.red}Unknown option: ${rest[i]}${c.reset}`); process.exit(1) }
          opts[m[1]] = m[2] ?? rest[++i] ?? ''
        }
        const rl = await import('readline')
        const ask = (q: string, hidden = false): Promise<string> => new Promise(resolve => {
          const iface = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
          if (hidden) (iface as any)._writeToOutput = (text: string) => { if (text.includes(q)) process.stdout.write(q) }
          iface.question(q, answer => { iface.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()) })
        })
        const url = opts.url || await ask('AdGuard Home address [http://127.0.0.1:3000]: ') || 'http://127.0.0.1:3000'
        const username = opts.user || await ask('Username: ')
        const client = opts.client || await ask('Name of the persistent client that covers the LAN: ')
        const password = await ask('Password (not shown): ', true)
        const res = await apiPost('/lan/adguard', { url, username, password, client, ...(opts.dns ? { dnsTarget: opts.dns } : {}) })
        fail(res); show(res)
      } else {
        console.error(`${c.red}Usage: candy lan adguard [status|setup|off]${c.reset}`)
        process.exit(1)
      }
    } else if (!sub || sub === 'list' || sub === 'ls') {
      const res = await apiGet('/lan')
      if (!res) {
        console.error(`${c.red}Daemon not running${c.reset}`)
        process.exit(1)
      }
      console.log(`${c.dim}LAN address: ${res.lanIp || 'not detected'}${c.reset}`)
      const names = Object.keys(res.names || {})
      if (names.length === 0) {
        console.log(`${c.dim}No domains registered${c.reset}`)
      } else {
        for (const name of names) {
          const https = res.https?.[name]?.url
          console.log(res.names[name]
            ? `  ${c.green}${name}.candy${c.reset} published${https ? `  ${c.cyan}${https}${c.reset}` : ''}`
            : `  ${c.dim}${name}.candy  tailnet only${c.reset}`)
        }
      }
    } else {
      console.error(`${c.red}Usage: candy lan [publish|unpublish] <name>${c.reset}`)
      process.exit(1)
    }
    break
  }
  default:
    if (command) {
      console.error(`${c.red}Unknown command: ${command}${c.reset}`)
      console.error(`${c.dim}Run 'candy help' for usage${c.reset}`)
      process.exit(1)
    }
    printHelp()
}
