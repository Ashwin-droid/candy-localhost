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
 *   candy fn <command>            Functions: add, deploy, requests, tail, kv, d1 (candy fn help)
 * 
 * The daemon runs the actual server - this CLI is just a window into it.
 * Multiple terminals/AIs can watch the same logs simultaneously.
 */

// CANDY_API_URL points the CLI at another daemon on this machine (tests); loopback only
const API = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(process.env.CANDY_API_URL ?? '') ? process.env.CANDY_API_URL! : 'http://localhost:9999'
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

// Daemon-wide settings take a superuser, and superuser exists only in a portal
// login; an API key never is one, so say where to go instead of a bare 403
const SUPERUSER_ONLY = 'superuser only: use the portal while logged in as a sudoer'
async function apiSuperuser(method: 'GET' | 'POST', path: string, body?: any) {
  const headers = await getHeaders()
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 403) return { error: SUPERUSER_ONLY }
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
    if (config.fn) for (const [k, v] of fnInfoRows(config.fn)) console.log(`  ${c.dim}${k}:${c.reset} ${v}`)
    else console.log(`  ${c.dim}cmd:${c.reset} ${config.cmd}`)
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
    if (config.fn) for (const [k, v] of fnInfoRows(config.fn)) console.log(`  ${c.dim}${k}:${c.reset} ${v}`)
    else console.log(`  ${c.dim}cmd:${c.reset} ${config.cmd}`)
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
  } else if (sub === 'mcp') {
    // candy domain mcp [status] | on [--subdomain <name>] | off | revoke [clientId]
    const action = args[1] || 'status'
    const fail = (res: any) => {
      if (!res) { console.error(`${c.red}Daemon not running${c.reset}`); process.exit(1) }
      if (res.error) { console.error(`${c.red}${res.error}${c.reset}`); process.exit(1) }
    }
    const show = (res: any) => {
      if (!res.available) {
        console.log(`${c.dim}Needs a domain and tunnel first: candy domain config --zone <domain> --tunnel <name>${c.reset}`)
        return
      }
      if (!res.enabled) {
        console.log(`${c.dim}Public MCP endpoint is off. 'candy domain mcp on' would serve ${res.wouldBe}${c.reset}`)
        return
      }
      console.log(`${c.green}Public MCP endpoint is on${c.reset}  ${c.cyan}${res.url}${c.reset}`)
      console.log(`${c.dim}  Clients are approved on the tailnet at ${res.consent}${c.reset}`)
      if (res.clients.length === 0) console.log(`${c.dim}  No clients yet${c.reset}`)
      for (const cl of res.clients) {
        const used = cl.lastUsedAt ? `last used ${new Date(cl.lastUsedAt).toLocaleString()}` : 'never used'
        console.log(`  ${cl.activeGrants > 0 ? c.green : c.dim}${cl.clientName}${c.reset} ${c.dim}${cl.clientId}  ${cl.activeGrants > 0 ? 'signed in' : 'not signed in'}, ${used}${c.reset}`)
      }
    }
    if (action === 'status') {
      const res = await apiGet('/domains/mcp'); fail(res); show(res)
    } else if (action === 'on' || action === 'off') {
      const body: Record<string, unknown> = { enabled: action === 'on' }
      const flag = args.indexOf('--subdomain')
      if (flag >= 0 && args[flag + 1]) body.subdomain = args[flag + 1]
      const res = await apiPost('/domains/mcp', body); fail(res)
      if (action === 'off') console.log(`${c.red}- Public MCP endpoint is off${c.reset} ${c.dim}(every client was signed out)${c.reset}`)
      else show(res)
    } else if (action === 'revoke') {
      const res = await apiPost('/domains/mcp/revoke', args[2] ? { clientId: args[2] } : {}); fail(res)
      console.log(`${c.red}- ${args[2] ? 'Client removed' : 'Every client was signed out'}${c.reset}`)
    } else {
      console.error(`${c.red}Usage: candy domain mcp [status|on [--subdomain <name>]|off|revoke [clientId]]${c.reset}`)
      process.exit(1)
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
    const res = await apiSuperuser('POST', '/domains/config', body)
    if (res?.error) {
      console.error(`${c.red}${res.error}${c.reset}`)
      process.exit(1)
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

// ============================================================================
// Functions (candy fn ...)
// ============================================================================

const FN_USAGE: [string, string][] = [
  ['add <name> [path] [--entry f] [--hot n] [--max n] [--linger s] [--env-file p]', 'Register a function or static site (path defaults to .; assets come from its config)'],
  ['deploy [name]', 'Bundle a snapshot and run from it'],
  ['rollback [name] [id]', 'Pin an earlier deploy (default: the one before current)'],
  ['dev [name]', 'Unpin and run the live source again'],
  ['deploys [name]', 'List deploy snapshots'],
  ['instances [name]', 'List running instances'],
  ['set <name> [--hot n] [--max n] [--linger s] [--log full|meta|off]', 'Change warm instances, the cap, idle linger, or request logging'],
  ['requests <name> [--status 5xx] [--path /api] [--since 1h] [--limit n]', 'Logged requests (last 24h)'],
  ['request <id> [--name n]', 'One logged request in full'],
  ['tail <name>', 'Live requests, one line each'],
  ['replay <name> <id> [--allow-partial]', 'Re-send a logged request to the current code'],
  ['kv <name> [--binding KV] get|put|list|delete ...', 'Read or change a KV namespace'],
  ['d1 <name> [--binding DB] "<sql>" [params...]', 'Run SQL against a D1 database'],
]

function printFnHelp() {
  console.log(`${c.cyan}${c.bold}🍬 candy fn${c.reset} ${c.dim}Workers-style functions, run portless by the daemon${c.reset}`)
  console.log()
  console.log(`${c.white}Usage:${c.reset}`)
  for (const [usage, desc] of FN_USAGE) {
    console.log(`  ${c.cyan}candy fn${c.reset} ${usage}`)
    console.log(`      ${c.dim}${desc}${c.reset}`)
  }
  console.log()
  console.log(`  ${c.dim}kv: get <key> | put <key> <value> | list [prefix] [--limit n] | delete <key>${c.reset}`)
  console.log(`  ${c.dim}[name] defaults to the function registered for this folder, then the name in${c.reset}`)
  console.log(`  ${c.dim}candy.fn.json / wrangler.*, then the folder name.${c.reset}`)
  console.log(`  ${c.dim}stop and logs work on functions like any other site.${c.reset}`)
  console.log()
  console.log(`  ${c.dim}Static assets: set "assets" in candy.fn.json / wrangler.* and the daemon serves the${c.reset}`)
  console.log(`  ${c.dim}files itself, no process. "main" is optional (assets-only site). For a SPA with an API:${c.reset}`)
  console.log(`  ${c.dim}  "assets": { "directory": "./dist", "not_found_handling": "single-page-application",${c.reset}`)
  console.log(`  ${c.dim}              "run_worker_first": ["/api/*"] }${c.reset}`)
  console.log(`  ${c.dim}_headers, _redirects and .assetsignore in the asset folder work like on Cloudflare.${c.reset}`)
}

const fnFail = (msg: string): never => {
  console.error(`${c.red}${msg}${c.reset}`)
  process.exit(1)
}

const fnUsage = (sub: string): never => {
  const row = FN_USAGE.find(([u]) => u.split(' ')[0] === sub)
  return fnFail(`Usage: candy fn ${row ? row[0] : '<command>'}`)
}

// Split argv into positionals and --flags. Flags listed in `bool` take no value;
// --flag=value works too.
function parseFnArgs(argv: string[], bool: string[] = []) {
  const pos: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
      if (eq !== -1) flags[key] = a.slice(eq + 1)
      else if (bool.includes(key)) flags[key] = true
      else if (i + 1 < argv.length) flags[key] = argv[++i]
      else fnFail(`--${key} needs a value`)
      continue
    }
    pos.push(a)
  }
  return { pos, flags }
}

const flagStr = (flags: Record<string, string | true>, key: string): string | undefined =>
  typeof flags[key] === 'string' ? (flags[key] as string) : undefined

function flagInt(flags: Record<string, string | true>, key: string): number | undefined {
  const v = flagStr(flags, key)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) fnFail(`--${key} must be a whole number`)
  return n
}

// Seconds an idle instance waits for the next request (fn.linger)
function flagLinger(flags: Record<string, string | true>): number | undefined {
  const n = flagInt(flags, 'linger')
  if (n !== undefined && n > 600) fnFail('--linger must be 0 to 600 seconds')
  return n
}

// "1h", "30m", "2d", "90s" or plain ms -> milliseconds
function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim())
  if (!m) return null
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] || 'ms']!
  return Math.round(Number(m[1]) * unit)
}

// Strip // and /* */ comments and trailing commas so wrangler.jsonc parses.
// String contents are left alone.
function stripJsonc(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += ch
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

// The `name` field from the folder's project config, first file wins (same order
// as fn-config.ts). Read here directly so the CLI doesn't need the daemon for it.
async function fnProjectName(dir: string): Promise<string | null> {
  for (const file of ['candy.fn.json', 'wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const f = Bun.file(`${dir}/${file}`)
    if (!(await f.exists())) continue
    try {
      const text = await f.text()
      const cfg: any = file.endsWith('.toml') ? Bun.TOML.parse(text) : JSON.parse(stripJsonc(text))
      return typeof cfg?.name === 'string' && cfg.name ? cfg.name : null
    } catch {
      return null
    }
  }
  return null
}

// [name] omitted: the site registered for this folder, then the project config's
// name, then the folder name (what `candy fn add` would pick).
async function resolveFnName(given: string | undefined): Promise<string> {
  if (given) return given
  const config = await getConfigForCwd()
  if (config) return config.name
  return (await fnProjectName(getCwd())) || getFolderName()
}

// The fn routes answer {success:false, error} on failure. A 404 with no JSON body
// means the daemon predates functions.
async function fnApi(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const headers = await getHeaders()
  let res: Response
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Daemons without the fn routes redirect unknown paths to https://localhost/.
      redirect: 'manual',
    })
  } catch {
    return fnFail('Error: candy daemon not running')
  }
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch {}
  // A logged request's detail has its own `error` (what the fn threw), so only a string error is an API failure
  if (!res.ok || data?.success === false || (data && typeof data === 'object' && typeof data.error === 'string')) {
    if ((res.status === 404 || (res.status >= 300 && res.status < 400)) && !data?.error) {
      return fnFail(`Error: the daemon has no ${path.split('?')[0]} route (update and restart candy)`)
    }
    return fnFail(`Error: ${data?.error || text.trim() || `HTTP ${res.status}`}`)
  }
  return data
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v))
  return q.toString()
}

// Request-log data comes from the function's visitors (anyone, on a bound
// domain): control characters would be escape sequences in the owner's
// terminal (OSC 52 clipboard writes, title changes, screen rewrites), so they
// print as visible \xNN. Newlines and tabs stay.
const terminalSafe = (text: string): string =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
const safeDeep = (v: any): any =>
  typeof v === 'string' ? terminalSafe(v)
    : Array.isArray(v) ? v.map(safeDeep)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [terminalSafe(k), safeDeep(x)]))
    : v

const visibleLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length

// Plain column table; cells may already carry colors.
function printTable(headers: string[], rows: string[][]) {
  if (rows.length === 0) return
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => visibleLen(r[i] ?? ''))))
  const line = (cells: string[]) => cells
    .map((cell, i) => i === cells.length - 1 ? cell : cell + ' '.repeat(widths[i] - visibleLen(cell)))
    .join('  ')
  console.log(`${c.dim}${line(headers)}${c.reset}`)
  for (const r of rows) console.log(line(r.map(x => x ?? '')))
}

// Timestamps may come back as epoch ms, epoch s or ISO strings.
function toDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v)
  const d = new Date(String(v))
  return isNaN(d.getTime()) ? null : d
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtTime = (v: unknown) => {
  const d = toDate(v)
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : '-'
}
const fmtDateTime = (v: unknown) => {
  const d = toDate(v)
  return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtTime(d.getTime())}` : '-'
}
const fmtAgo = (v: unknown) => {
  const d = toDate(v)
  if (!d) return '-'
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
}
const fmtBytes = (n: unknown) => {
  if (typeof n !== 'number') return '-'
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
}

const statusColor = (s: unknown) => {
  const n = Number(s)
  return !n ? c.dim : n >= 500 ? c.red : n >= 400 ? c.yellow : n >= 300 ? c.cyan : c.green
}

// RequestSummary field names, with fallbacks so a renamed field still shows.
const reqTime = (r: any) => r.ts ?? r.time ?? r.startedAt ?? r.createdAt
const reqPath = (r: any) => {
  const p = r.path ?? r.url ?? ''
  try { const u = new URL(p); return u.pathname + u.search } catch { return p }
}
const reqMs = (r: any) => {
  const ms = r.totalMs ?? r.durationMs ?? r.ms ?? r.timings?.totalMs ?? r.timings?.total
  return typeof ms === 'number' ? `${Math.round(ms)}ms` : '-'
}
const reqTemp = (r: any) => {
  const cold = r.cold ?? r.timings?.cold
  return cold === undefined ? '' : cold ? `${c.yellow}cold${c.reset}` : `${c.dim}warm${c.reset}`
}
const reqOutcome = (r: any) => {
  const o = r.outcome
  return !o || o === 'ok' ? '' : `${c.red}${o}${c.reset}`
}

// Who answered (kind: "asset" = the daemon served a file, no process) and the
// routing rule that decided it (worker-first:/api/*, spa-navigate, a
// _redirects line, 404-page), compactly. Long _redirects lines are cut.
const reqRoute = (r: any) => {
  const rule = typeof r.rule === 'string' && r.rule ? (r.rule.length > 48 ? r.rule.slice(0, 47) + '…' : r.rule) : ''
  const kind = r.kind === 'asset' ? `${c.blue}asset${c.reset}` : ''
  return [kind, rule ? `${c.dim}${rule}${c.reset}` : ''].filter(Boolean).join(' ')
}

function reqLine(r: any): string {
  const status = r.status ?? '-'
  return [
    `${c.dim}${fmtTime(reqTime(r))}${c.reset}`,
    `${statusColor(status)}${status}${c.reset}`,
    (r.method ?? '').padEnd(6),
    reqPath(r),
    `${c.dim}${reqMs(r)}${c.reset}`,
    reqRoute(r),
    r.kind === 'asset' ? '' : reqTemp(r),
    reqOutcome(r),
  ].filter(Boolean).join(' ')
}

// Static assets of a function (fn.assets), shown in list/status/instances/add.
// run_worker_first is spelled out because it decides what reaches the code.
const NOT_FOUND_TEXT: Record<string, string> = { 'single-page-application': 'SPA (index.html)', '404-page': '404.html', none: 'empty 404' }
function fnAssetsText(a: any): string {
  const first = a.runWorkerFirst
  const wf = first === true ? `${c.yellow}always${c.reset}`
    : Array.isArray(first) && first.length ? `${c.yellow}${first.join(' ')}${c.reset}`
    : `${c.dim}off${c.reset}`
  return [
    `${a.directory ?? '?'}`,
    `${c.dim}not found:${c.reset} ${NOT_FOUND_TEXT[a.notFound] ?? a.notFound ?? 'empty 404'}`,
    `${c.dim}worker first:${c.reset} ${wf}`,
    a.binding ? `${c.dim}binding:${c.reset} env.${a.binding}` : '',
    a.html && a.html !== 'auto-trailing-slash' ? `${c.dim}html:${c.reset} ${a.html}` : '',
  ].filter(Boolean).join('  ')
}

// Assets-only is what's routing (hasWorker: a pinned deploy's worker, or main added since),
// not the stored entry, which is for display. entry is the fallback for an older daemon.
const fnAssetsOnly = (fn: any): boolean =>
  !!fn && (typeof fn.hasWorker === 'boolean' ? !fn.hasWorker : fn.entry === null)

// [label, value] rows for a function's fn summary: its code (or assets-only) and assets.
function fnInfoRows(fn: any): [string, string][] {
  if (!fn || typeof fn !== 'object') return []
  fn = safeDeep(fn)
  const deploy = fn.deploy ? ` ${c.dim}(deploy ${fn.deploy})${c.reset}` : ''
  const rows: [string, string][] = [['fn', fnAssetsOnly(fn)
    ? `${c.blue}assets-only${c.reset} ${c.dim}(served by the daemon; no process ever starts)${c.reset}${deploy}`
    : `${fn.entry || 'main'}${deploy}`]]
  if (fn.assets) rows.push(['assets', fnAssetsText(fn.assets)])
  return rows
}

// Headers arrive as [k,v][] (contract) or a plain object.
function printHeaders(h: unknown) {
  const pairs: [string, string][] = Array.isArray(h) ? h as [string, string][] : h && typeof h === 'object' ? Object.entries(h as Record<string, string>) : []
  for (const [k, v] of pairs) console.log(`  ${c.dim}${k}:${c.reset} ${v}`)
}

function printBody(body: unknown, truncated?: unknown) {
  // The daemon's request log stores bodies as {kind, text, size, truncated, sha256}
  if (body && typeof body === 'object' && typeof (body as any).kind === 'string') {
    const b = body as { kind: string; text?: string | null; size?: number; truncated?: boolean; sha256?: string | null; contentType?: string | null }
    if (b.kind === 'binary') { console.log(`  ${c.dim}(binary, ${b.size ?? '?'} bytes, sha256 ${b.sha256 ?? '?'})${c.reset}`); return }
    if (b.kind === 'omitted') { console.log(`  ${c.dim}(not logged: meta mode, ${b.size ?? 0} bytes)${c.reset}`); return }
    body = b.kind === 'text' ? b.text ?? '' : ''
    truncated = truncated || (b.truncated ? `${b.size} bytes in total` : undefined)
  }
  if (body === undefined || body === null || body === '') { console.log(`  ${c.dim}(empty)${c.reset}`); return }
  let text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  // Pretty-print JSON bodies; leave everything else as sent.
  if (typeof body === 'string') {
    try { text = JSON.stringify(JSON.parse(body), null, 2) } catch {}
  }
  for (const line of text.split('\n')) console.log(`  ${line}`)
  if (truncated) console.log(`  ${c.yellow}(truncated)${c.reset}`)
}

const showSection = (title: string) => console.log(`\n${c.white}${c.bold}${title}${c.reset}`)

function printRequestDetail(d: any) {
  const shown = new Set<string>()
  const pick = (...keys: string[]) => {
    for (const k of keys) if (d[k] !== undefined) { shown.add(k); return d[k] }
    return undefined
  }
  const id = pick('id', 'requestId')
  const status = pick('status')
  const method = pick('method')
  const url = pick('url', 'path')
  console.log(`${c.cyan}${c.bold}${method ?? ''} ${url ?? ''}${c.reset} ${statusColor(status)}${status ?? '-'}${c.reset}`)
  const meta: [string, unknown][] = [
    ['id', id],
    ['time', fmtDateTime(pick('ts', 'time', 'startedAt', 'createdAt'))],
    ['host', pick('host')],
    ['client', pick('clientIp')],
    ['instance', pick('instance')],
    ['cold', pick('cold')],
    ['queued', pick('queuedMs')],
    ['ttfb', pick('ttfbMs')],
    ['total', pick('totalMs', 'durationMs')],
    ['outcome', pick('outcome')],
    ['waitUntil', pick('waitUntil')],
    ['kind', pick('kind')],
    ['rule', pick('rule') ?? undefined],
  ]
  for (const [k, v] of meta) {
    if (v === undefined || v === '-' || v === '') continue
    // Assets are served by the daemon: no instance, nothing cold
    if (d.kind === 'asset' && (k === 'instance' || k === 'cold')) continue
    const val = typeof v === 'number' && ['queued', 'ttfb', 'total'].includes(k) ? `${Math.round(v)}ms` : String(v)
    console.log(`  ${c.dim}${k.padEnd(9)}${c.reset} ${k === 'outcome' && v !== 'ok' ? c.red : ''}${val}${c.reset}`)
  }
  const timings = pick('timings')
  if (timings && typeof timings === 'object') {
    console.log(`  ${c.dim}timings  ${c.reset} ${Object.entries(timings).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }
  const error = pick('error', 'errorMessage')
  const stack = pick('stack', 'errorStack')
  if (error || stack) {
    showSection('Error')
    const msg = typeof error === 'object' && error ? (error as any).message : error
    if (msg) console.log(`  ${c.red}${msg}${c.reset}`)
    const st = stack ?? (typeof error === 'object' && error ? (error as any).stack : undefined)
    if (st) for (const line of String(st).split('\n')) console.log(`  ${c.dim}${line}${c.reset}`)
  }
  const reqHeaders = pick('reqHeaders', 'requestHeaders')
  if (reqHeaders) { showSection('Request headers'); printHeaders(reqHeaders) }
  const reqBody = pick('reqBody', 'requestBody')
  const reqTrunc = pick('reqTruncated', 'requestTruncated')
  if (reqBody !== undefined || reqTrunc) { showSection('Request body'); printBody(reqBody, reqTrunc) }
  const resHeaders = pick('resHeaders', 'responseHeaders')
  if (resHeaders) { showSection('Response headers'); printHeaders(resHeaders) }
  const resBody = pick('resBody', 'responseBody')
  const resTrunc = pick('resTruncated', 'responseTruncated')
  if (resBody !== undefined || resTrunc) { showSection('Response body'); printBody(resBody, resTrunc) }
  const logs = pick('logs')
  if (Array.isArray(logs) && logs.length) {
    showSection('Console')
    for (const l of logs) {
      const color = l.level === 'error' ? c.red : l.level === 'warn' ? c.yellow : l.level === 'debug' ? c.dim : ''
      console.log(`  ${c.dim}${fmtTime(l.ts)}${c.reset} ${color}${l.level ?? 'log'}${c.reset} ${l.text ?? ''}`)
    }
  }
  // Anything else the daemon sends, so nothing is hidden.
  const rest = Object.keys(d).filter(k => !shown.has(k) && k !== 'success' && k !== 'fn' && k !== 'name')
  if (rest.length) {
    showSection('Other')
    for (const k of rest) {
      const v = d[k]
      console.log(`  ${c.dim}${k}:${c.reset} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    }
  }
}

// D1-style CLI params: numbers and null are passed typed, everything else as text.
function d1Param(s: string): string | number | null {
  if (s === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(Number(s))) return Number(s)
  return s
}

function printD1Result(res: any) {
  const results = Array.isArray(res?.results) ? res.results : Array.isArray(res) ? res : null
  if (results && results.length) {
    const cols = [...new Set(results.flatMap((r: any) => r && typeof r === 'object' ? Object.keys(r) : []))] as string[]
    printTable(cols, results.map((r: any) => cols.map(col => {
      const v = r?.[col]
      return v === null ? `${c.dim}NULL${c.reset}` : typeof v === 'object' ? JSON.stringify(v) : String(v)
    })))
  } else if (results) {
    console.log(`${c.dim}(no rows)${c.reset}`)
  } else {
    console.log(JSON.stringify(res, null, 2))
  }
  const m = res?.meta
  if (m) {
    const bits = [
      results ? `${results.length} row${results.length === 1 ? '' : 's'}` : null,
      m.changes ? `${m.changes} changed` : null,
      m.last_row_id ? `last_row_id ${m.last_row_id}` : null,
      typeof m.duration === 'number' ? `${m.duration.toFixed(2)}ms` : null,
    ].filter(Boolean)
    if (bits.length) console.log(`${c.dim}${bits.join('  ')}${c.reset}`)
  }
}

// Follow /fn/tail (SSE of RequestSummary) and print one line per request.
// Reconnects like `candy logs`.
async function fnTail(name: string) {
  console.log(`${c.dim}Tailing requests for ${name}... (Ctrl+C to exit)${c.reset}`)
  let warnedDown = false
  for (;;) {
    try {
      const headers = await getHeaders()
      const res = await fetch(`${API}/fn/tail?${qs({ name })}`, { headers, redirect: 'manual' })
      if (res.status === 404 || res.status === 403 || res.status === 400 || (res.status >= 300 && res.status < 400)) {
        let err = ''
        try { err = (await res.json())?.error } catch {}
        fnFail(`Error: ${err || (res.status !== 400 && res.status !== 403 ? 'the daemon has no /fn/tail route (update and restart candy)' : `HTTP ${res.status}`)}`)
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      warnedDown = false
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/)
        buffer = blocks.pop() || ''
        for (const block of blocks) {
          const data = block.split(/\r?\n/)
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, ''))
            .join('\n')
          if (!data) continue
          try { console.log(reqLine(safeDeep(JSON.parse(data)))) } catch {}
        }
      }
    } catch {
      if (!warnedDown) console.log(`${c.dim}(disconnected, retrying...)${c.reset}`)
      warnedDown = true
    }
    await new Promise(resolve => setTimeout(resolve, 750))
  }
}

async function cmdFn(argv: string[]) {
  const sub = argv[0]
  const rest = argv.slice(1)
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    printFnHelp()
    return
  }
  const known = ['add', 'deploy', 'rollback', 'dev', 'deploys', 'instances', 'set', 'requests', 'request', 'tail', 'replay', 'kv', 'd1']
  if (!known.includes(sub)) {
    console.error(`${c.red}Unknown fn command: ${sub}${c.reset}`)
    console.error(`${c.dim}Run 'candy fn help' for usage${c.reset}`)
    process.exit(1)
  }

  // Validate arguments before touching the daemon so usage errors stay local.
  switch (sub) {
    case 'add': {
      const { pos, flags } = parseFnArgs(rest)
      const name = pos[0]
      if (!name || pos.length > 2) fnUsage('add')
      const { resolve } = await import('path')
      const body: Record<string, unknown> = { name, cwd: resolve(pos[1] || '.') }
      const entry = flagStr(flags, 'entry')
      if (entry) body.entry = entry
      const envFile = flagStr(flags, 'env-file')
      if (envFile) body.envFile = resolve(envFile)
      const hot = flagInt(flags, 'hot'), max = flagInt(flags, 'max'), linger = flagLinger(flags)
      if (hot !== undefined) body.hot = hot
      if (max !== undefined) body.max = max
      if (linger !== undefined) body.linger = linger
      console.log(`${c.dim}Registering function ${name}...${c.reset}`)
      const res = await fnApi('POST', '/fn/add', body)
      console.log(`${c.green}+ ${res.name ?? name}${c.reset} ${c.dim}->${c.reset} ${c.cyan}${res.url ?? `https://${name}.localhost`}${c.reset}`)
      for (const [k, v] of fnInfoRows(res.fn)) console.log(`  ${c.dim}${k.padEnd(7)}${c.reset}${v}`)
      console.log(fnAssetsOnly(res.fn)
        ? `${c.dim}  Live-linked to ${body.cwd}. Files are served by the daemon; no process starts.${c.reset}`
        : `${c.dim}  Live-linked to ${body.cwd}. Starts on the first request, exits when idle.${c.reset}`)
      for (const w of Array.isArray(res.warnings) ? safeDeep(res.warnings) : []) console.log(`${c.yellow}  ${w}${c.reset}`)
      return
    }
    case 'deploy': {
      const { pos } = parseFnArgs(rest)
      if (pos.length > 1) fnUsage('deploy')
      const name = await resolveFnName(pos[0])
      console.log(`${c.dim}Bundling ${name}...${c.reset}`)
      const { deploy: d } = await fnApi('POST', '/fn/deploy', { name })
      const what = d && d.entry === null ? 'assets only' : fmtBytes(d?.size)
      console.log(`${c.green}Deployed ${name}${c.reset} ${c.cyan}${d?.id ?? ''}${c.reset} ${c.dim}${what}${d?.assets && d.entry !== null ? ' + assets' : ''}${d?.gitRev ? `  git ${String(d.gitRev).slice(0, 8)}` : ''}${c.reset}`)
      console.log(`${c.dim}  Running from the snapshot. 'candy fn dev ${name}' goes back to live source.${c.reset}`)
      return
    }
    case 'rollback': {
      const { pos } = parseFnArgs(rest)
      if (pos.length > 2) fnUsage('rollback')
      const name = await resolveFnName(pos[0])
      const body: Record<string, unknown> = { name }
      if (pos[1]) body.id = pos[1]
      const { deploy: d } = await fnApi('POST', '/fn/rollback', body)
      console.log(`${c.yellow}Rolled back ${name}${c.reset} to ${c.cyan}${d?.id ?? pos[1] ?? '?'}${c.reset} ${c.dim}${fmtDateTime(d?.createdAt)}${c.reset}`)
      return
    }
    case 'dev': {
      const { pos } = parseFnArgs(rest)
      if (pos.length > 1) fnUsage('dev')
      const name = await resolveFnName(pos[0])
      await fnApi('POST', '/fn/dev', { name })
      console.log(`${c.green}${name}${c.reset}: live-linked to its source again ${c.dim}(edits show up on the next cold start)${c.reset}`)
      return
    }
    case 'deploys': {
      const { pos } = parseFnArgs(rest)
      if (pos.length > 1) fnUsage('deploys')
      const name = await resolveFnName(pos[0])
      const { deploys = [], current, fn } = await fnApi('GET', `/fn/deploys?${qs({ name })}`)
      console.log(`${c.cyan}${c.bold}${name}${c.reset} ${c.dim}${current ? `pinned to ${current}` : 'live-linked (dev)'}${c.reset}`)
      for (const [k, v] of fnInfoRows(fn)) console.log(`  ${c.dim}${k.padEnd(7)}${c.reset}${v}`)
      if (!deploys.length) { console.log(`${c.dim}No deploys yet. Run: candy fn deploy ${name}${c.reset}`); return }
      console.log()
      printTable(['', 'ID', 'CREATED', 'SIZE', 'ASSETS', 'GIT', 'SOURCE'], deploys.map((d: any) => [
        d.id === current ? `${c.green}*${c.reset}` : ' ',
        d.id === current ? `${c.green}${d.id}${c.reset}` : d.id,
        fmtDateTime(d.createdAt),
        d.entry === null ? `${c.blue}assets-only${c.reset}` : fmtBytes(d.size),
        d.assets ? `${c.blue}yes${c.reset}` : `${c.dim}-${c.reset}`,
        d.gitRev ? String(d.gitRev).slice(0, 8) : '-',
        `${c.dim}${d.source ?? d.main ?? ''}${c.reset}`,
      ]))
      return
    }
    case 'instances': {
      const { pos } = parseFnArgs(rest)
      if (pos.length > 1) fnUsage('instances')
      const name = await resolveFnName(pos[0])
      const { instances = [], fn } = await fnApi('GET', `/fn/instances?${qs({ name })}`)
      if (fnAssetsOnly(fn)) {
        console.log(`${name}: ${c.blue}assets-only${c.reset} ${c.dim}(the daemon serves the files; no instance ever starts)${c.reset}`)
        for (const [k, v] of fnInfoRows(fn).slice(1)) console.log(`  ${c.dim}${k.padEnd(7)}${c.reset}${v}`)
        return
      }
      if (!instances.length) { console.log(`${c.dim}${name}: no instances running (one starts on the next request)${c.reset}`); return }
      printTable(['ID', 'PID', 'STATE', 'HOT', 'INFLIGHT', 'UP'], instances.map((i: any) => [
        i.id,
        i.pid == null ? '-' : String(i.pid),
        i.ready ? `${c.green}ready${c.reset}` : `${c.yellow}starting${c.reset}`,
        i.hot ? `${c.yellow}hot${c.reset}` : `${c.dim}-${c.reset}`,
        String(i.inflight ?? 0),
        fmtAgo(i.startedAt),
      ]))
      return
    }
    case 'set': {
      const { pos, flags } = parseFnArgs(rest)
      const name = pos[0]
      if (!name || pos.length > 1) fnUsage('set')
      const body: Record<string, unknown> = { name }
      const hot = flagInt(flags, 'hot'), max = flagInt(flags, 'max'), linger = flagLinger(flags)
      if (hot !== undefined) body.hot = hot
      if (max !== undefined) body.max = max
      if (linger !== undefined) body.linger = linger
      const log = flagStr(flags, 'log')
      if (log !== undefined) {
        const map: Record<string, true | 'meta' | false> = { full: true, on: true, meta: 'meta', off: false }
        if (!(log in map)) fnFail('--log must be full, meta or off')
        body.log = map[log]
      }
      if (Object.keys(body).length === 1) fnUsage('set')
      if (typeof body.hot === 'number' && typeof body.max === 'number' && body.hot > body.max) fnFail('--hot cannot be more than --max')
      await fnApi('POST', '/fn/settings', body)
      const bits = [
        body.hot !== undefined ? `hot ${c.cyan}${body.hot}${c.reset}` : null,
        body.max !== undefined ? `max ${c.cyan}${body.max}${c.reset}` : null,
        body.linger !== undefined ? `linger ${c.cyan}${body.linger}s${c.reset}` : null,
        log !== undefined ? `log ${c.cyan}${log}${c.reset}` : null,
      ].filter(Boolean)
      console.log(`${name}: ${bits.join(', ')}`)
      return
    }
    case 'requests': {
      const { pos, flags } = parseFnArgs(rest)
      const name = pos[0]
      if (!name || pos.length > 1) fnUsage('requests')
      const status = flagStr(flags, 'status')
      if (status !== undefined && !/^[1-5](xx|\d\d)$/i.test(status)) fnFail('--status takes a code like 404 or a class like 5xx')
      let since: number | undefined
      const sinceArg = flagStr(flags, 'since')
      if (sinceArg !== undefined) {
        const ms = parseDuration(sinceArg)
        if (ms === null) fnFail('--since takes a duration like 30m, 1h or 2d')
        since = Date.now() - ms!
      }
      const limit = flagInt(flags, 'limit')
      const { requests = [] } = safeDeep(await fnApi('GET', `/fn/requests?${qs({ name, status: status?.toLowerCase(), path: flagStr(flags, 'path'), since, limit })}`))
      if (!requests.length) { console.log(`${c.dim}No matching requests in the last 24h${c.reset}`); return }
      printTable(['TIME', 'STATUS', 'METHOD', 'PATH', 'MS', 'ROUTE', '', 'ID'], requests.map((r: any) => [
        `${c.dim}${fmtTime(reqTime(r))}${c.reset}`,
        `${statusColor(r.status)}${r.status ?? '-'}${c.reset}`,
        r.method ?? '',
        reqPath(r),
        reqMs(r),
        reqRoute(r) || `${c.dim}worker${c.reset}`,
        [r.kind === 'asset' ? '' : reqTemp(r), reqOutcome(r)].filter(Boolean).join(' '),
        `${c.dim}${r.id ?? r.requestId ?? ''}${c.reset}`,
      ]))
      return
    }
    case 'request': {
      const { pos, flags } = parseFnArgs(rest)
      const id = pos[0]
      if (!id || pos.length > 1) fnUsage('request')
      const name = await resolveFnName(flagStr(flags, 'name'))
      printRequestDetail(safeDeep(await fnApi('GET', `/fn/request?${qs({ name, id })}`)))
      return
    }
    case 'tail': {
      const { pos } = parseFnArgs(rest)
      if (pos.length > 1) fnUsage('tail')
      await fnTail(await resolveFnName(pos[0]))
      return
    }
    case 'replay': {
      const { pos, flags } = parseFnArgs(rest, ['allow-partial'])
      const [name, id] = pos
      if (!name || !id || pos.length > 2) fnUsage('replay')
      const body: Record<string, unknown> = { name, id }
      if (flags['allow-partial']) body.allowPartial = true
      const res = safeDeep(await fnApi('POST', '/fn/replay', body))
      console.log(`${statusColor(res.status)}${c.bold}${res.status ?? '-'}${c.reset} ${c.dim}replayed ${id} as ${res.requestId ?? '?'}${c.reset}`)
      printHeaders(res.headers)
      console.log()
      printBody(res.body)
      return
    }
    case 'kv': {
      const { pos, flags } = parseFnArgs(rest)
      const [name, op, ...opArgs] = pos
      if (!name || !op) fnUsage('kv')
      const binding = flagStr(flags, 'binding') || 'KV'
      const body: Record<string, unknown> = { name, binding, op }
      if (op === 'get' || op === 'delete') {
        if (opArgs.length !== 1) fnFail(`Usage: candy fn kv <name> [--binding KV] ${op} <key>`)
        body.key = opArgs[0]
      } else if (op === 'put') {
        if (opArgs.length !== 2) fnFail('Usage: candy fn kv <name> [--binding KV] put <key> <value>')
        body.key = opArgs[0]
        body.value = opArgs[1]
      } else if (op === 'list') {
        if (opArgs.length > 1) fnFail('Usage: candy fn kv <name> [--binding KV] list [prefix] [--limit n]')
        if (opArgs[0]) body.prefix = opArgs[0]
        const limit = flagInt(flags, 'limit')
        if (limit !== undefined) body.limit = limit
      } else {
        fnFail('kv takes get, put, list or delete')
      }
      const res = await fnApi('POST', '/fn/kv', body)
      if (op === 'get') {
        // KV get returns the value, or null when missing; it may come wrapped.
        const v = res && typeof res === 'object' && 'value' in res ? res.value : res
        if (v === null || v === undefined) fnFail(`${body.key}: not found in ${binding}`)
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
      } else if (op === 'put') {
        console.log(`${c.green}+ ${body.key}${c.reset} ${c.dim}in ${binding}${c.reset}`)
      } else if (op === 'delete') {
        console.log(`${c.red}- ${body.key}${c.reset} ${c.dim}from ${binding}${c.reset}`)
      } else {
        const keys = res?.keys ?? []
        if (!keys.length) { console.log(`${c.dim}No keys in ${binding}${body.prefix ? ` with prefix ${body.prefix}` : ''}${c.reset}`); return }
        printTable(['KEY', 'EXPIRES', 'METADATA'], keys.map((k: any) => [
          k.name,
          k.expiration ? fmtDateTime(k.expiration) : `${c.dim}-${c.reset}`,
          k.metadata === undefined || k.metadata === null ? `${c.dim}-${c.reset}` : JSON.stringify(k.metadata),
        ]))
        if (res.list_complete === false) console.log(`${c.dim}More keys exist (cursor ${res.cursor}). Use a prefix or --limit to narrow.${c.reset}`)
      }
      return
    }
    case 'd1': {
      const { pos, flags } = parseFnArgs(rest)
      const [name, sql, ...params] = pos
      if (!name || !sql) fnUsage('d1')
      const body: Record<string, unknown> = { name, binding: flagStr(flags, 'binding') || 'DB', sql }
      if (params.length) body.params = params.map(d1Param)
      printD1Result(await fnApi('POST', '/fn/d1', body))
      return
    }
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
  console.log(`  ${c.cyan}candy ttl${c.reset} <name> <minutes|off>  Stop a site after that many idle minutes (default 60)`)
  console.log(`  ${c.cyan}candy mem${c.reset} <name> <size|off>     Memory limit for a site (default 2G, at most 16G)`)
  console.log(`  ${c.cyan}candy env${c.reset} <name> <path|off>     Give a site its environment from a KEY=VALUE file`)
  console.log(`  ${c.cyan}candy route serve${c.reset} <name> <port|off>  https://<host>.ts.net:<port> on the tailnet (tailscale serve, run by candy)`)
  console.log(`  ${c.cyan}candy route entry${c.reset} <name> <port|off>  A local port that always reaches the site through candy`)
  console.log(`  ${c.cyan}candy sandbox${c.reset} <name> [on|off] [--rw <path>]  Sandbox a site (on by default as a root service); --rw adds a writable folder`)
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
  console.log(`  ${c.cyan}candy app-auth${c.reset} [list|rotate <name>|consents|revoke <site>]  Sign in with candy: site keys, your approvals`)
  console.log(`  ${c.cyan}candy passkeys${c.reset}                 Your portal passkeys (add and remove them in the portal)`)
  console.log(`  ${c.cyan}candy domain allow${c.reset} <sub> [ip|cidr...] [--rm ip...] [--on|--off]  Allowlist mode (Tailscale always allowed)`)
  console.log(`  ${c.cyan}candy domain mcp${c.reset} [on|off|status|revoke]  Public MCP endpoint, approved over Tailscale (off by default)`)
  console.log(`  ${c.cyan}candy fn${c.reset} add <name> [path]       Run a Workers-style module (and/or static assets) as a portless function`)
  console.log(`      ${c.dim}deploy|rollback|dev|deploys [name]   versioned snapshots, or live-linked source${c.reset}`)
  console.log(`      ${c.dim}instances|set|requests|request|tail|replay   instances and the 24h request log${c.reset}`)
  console.log(`      ${c.dim}kv|d1 <name> ...               read and change bindings (candy fn help for all)${c.reset}`)
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
  case 'ttl': {
    // candy ttl <name> <minutes|off>: stop this site after that many idle minutes
    const [name, value] = args.slice(1)
    const minutes = value === 'off' ? null : Number((value || '').replace(/m(in)?$/, ''))
    if (!name || !value || (minutes !== null && !Number.isInteger(minutes))) {
      console.error(`${c.red}Usage: candy ttl <name> <minutes|off>${c.reset}`)
      process.exit(1)
    }
    const res = await apiPost('/config/ttl', { name, minutes })
    if (!res || res.error) {
      console.error(`${c.red}${res?.error || 'Daemon not running'}${c.reset}`)
      process.exit(1)
    }
    console.log(`${name}: stops after ${c.cyan}${res.minutes ?? res.defaultMinutes} min${c.reset} without activity${res.minutes ? '' : ' (the default)'}`)
    break
  }
  case 'mem': {
    // candy mem <name> <size|off>: this site's memory limit (default 2G, at most 16G)
    const [name, value] = args.slice(1)
    if (!name || !value) {
      console.error(`${c.red}Usage: candy mem <name> <size|off>   (4G, 512M; at most 16G; off = the default 2G)${c.reset}`)
      process.exit(1)
    }
    const off = value === 'off' || value === 'default'
    const res = await apiPost('/config/memory', { name, memory: off ? null : /^\d+(\.\d+)?$/.test(value) ? Number(value) : value })
    if (!res || res.error) {
      console.error(`${c.red}${res?.error || 'Daemon not running'}${c.reset}`)
      process.exit(1)
    }
    console.log(`${name}: memory limit ${c.cyan}${res.text}${c.reset}${res.isDefault ? ' (the default)' : ''}, ${res.applied === 'now' ? 'applied to the running server' : 'from its next start'}`)
    if (!res.sandboxed) console.log(`${c.dim}The limit only applies to sandboxed servers; this one runs without the sandbox.${c.reset}`)
    break
  }
  case 'env': {
    // candy env <name> <path|off>: hand a KEY=VALUE file to the server as environment
    const [name, value] = args.slice(1)
    if (!name || !value) {
      console.error(`${c.red}Usage: candy env <name> <path|off>${c.reset}`)
      process.exit(1)
    }
    const { resolve } = await import('path')
    const res = await apiPost('/config/env', { name, envFile: value === 'off' ? null : resolve(value) })
    if (!res || res.error) {
      console.error(`${c.red}${res?.error || 'Daemon not running'}${c.reset}`)
      process.exit(1)
    }
    console.log(res.envFile
      ? `${name}: gets its environment from ${c.cyan}${res.envFile}${c.reset}. ${c.dim}${res.message}${c.reset}`
      : `${name}: no env file. ${c.dim}${res.message}${c.reset}`)
    break
  }
  case 'sandbox': {
    // candy sandbox <name> [on|off] [--rw <path>]... [--no-rw <path>]...
    const name = args[1]
    const rest = args.slice(2)
    const body: Record<string, unknown> = { name }
    const addRw: string[] = [], removeRw: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === 'on') body.sandbox = true
      else if (rest[i] === 'off') body.sandbox = false
      else if (rest[i] === '--rw' && rest[i + 1]) addRw.push(rest[++i])
      else if (rest[i] === '--no-rw' && rest[i + 1]) removeRw.push(rest[++i])
      else { body.name = undefined; break }
    }
    if (!name || !body.name) {
      console.error(`${c.red}Usage: candy sandbox <name> [on|off] [--rw <path>] [--no-rw <path>]${c.reset}`)
      process.exit(1)
    }
    if (addRw.length) body.addRw = addRw
    if (removeRw.length) body.removeRw = removeRw
    const res = await apiPost('/config/sandbox', body)
    if (!res || res.error) {
      console.error(`${c.red}${res?.error || 'Daemon not running'}${res?.details ? ` (${res.details})` : ''}${c.reset}`)
      process.exit(1)
    }
    console.log(`${name}: sandbox ${res.sandbox ? `${c.green}on${c.reset}` : `${c.red}off${c.reset}`}${res.sandbox && !res.active ? ` ${c.dim}(not in effect: the daemon isn't running as a root systemd service)${c.reset}` : ''}`)
    if (res.sandbox) {
      console.log(`${c.dim}  Writable: its code folder, ${res.stateDir} (CANDY_STATE_DIR), a private /tmp${res.rw.length ? `, ${res.rw.join(', ')}` : ''}${c.reset}`)
      console.log(`${c.dim}  Everything else is read-only. ${res.message}${c.reset}`)
    }
    break
  }
  case 'domain':
  case 'domains':
    cmdDomain(args.slice(1))
    break
  case 'fn':
  case 'fns':
    await cmdFn(args.slice(1))
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
    } else if (sub === 'serve') {
      // candy route serve <name> <port|off>: https://<host>.ts.net:<port> on the tailnet, via tailscale serve
      const name = rargs[1]
      const value = rargs[2]
      if (!name || !value || (value !== 'off' && !/^\d+$/.test(value))) {
        console.error(`${c.red}Usage: candy route serve <name> <port|off>${c.reset}`)
        process.exit(1)
      }
      const res = await apiPost('/routes/serve', { name, port: value === 'off' ? null : Number(value) })
      if (!res || res.error) {
        console.error(`${c.red}${res?.error || 'Daemon not running'}${c.reset}`)
        process.exit(1)
      }
      console.log(res.url
        ? `${c.green}+ ${res.url} -> ${name}${c.reset} ${c.dim}(tailnet only, trusted certificate, goes through candy)${c.reset}`
        : `${c.red}- ${name} is no longer served on the tailnet hostname${c.reset}`)
    } else if (sub === 'entry') {
      // candy route entry <name> <port|off>: a loopback port that always goes through candy
      const name = rargs[1]
      const value = rargs[2]
      if (!name || !value || (value !== 'off' && !/^\d+$/.test(value))) {
        console.error(`${c.red}Usage: candy route entry <name> <port|off>${c.reset}`)
        process.exit(1)
      }
      const res = await apiPost('/routes/entry', { name, port: value === 'off' ? null : Number(value) })
      if (!res || res.error) {
        console.error(`${c.red}${res?.error || 'Daemon not running'}${c.reset}`)
        process.exit(1)
      }
      console.log(res.port
        ? `${c.green}+ ${res.url} -> ${name}${c.reset} ${c.dim}(this machine only; starts ${name} when needed)${c.reset}`
        : `${c.red}- ${name} has no entry port${c.reset}`)
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
          // A function's route has target {fn: name}: the daemon serves it
          const target = r.target && typeof r.target === 'object' ? 'fn' : r.isRestricted ? r.target : ':' + r.target
          console.log(`  ${c.green}${name}.localhost${c.reset} -> ${target}${flags}`)
        }
      }
    }
    break
  }
  case 'app-auth': {
    // Sign in with candy (SDK_AUTH_DESIGN.md). Keys themselves are never printed:
    // apps get them from candy (env/credential) or with the SDK's appAuth()
    const [sub = 'list', target] = args.slice(1)
    const fail = (res: any) => {
      if (!res) { console.error(`${c.red}Daemon not running${c.reset}`); process.exit(1) }
      if (res.error) { console.error(`${c.red}${res.error}${c.reset}`); process.exit(1) }
    }
    const when = (ms: unknown) => typeof ms === 'number' ? new Date(ms).toLocaleString() : 'never'
    if (sub === 'list' || sub === 'ls') {
      const res = await apiGet('/app-auth/sites'); fail(res)
      if (!res.sites?.length) console.log(`${c.dim}No site has a sign-in key yet (one is made when a site starts, or the SDK asks)${c.reset}`)
      for (const s of res.sites ?? []) {
        console.log(`  ${c.green}${s.site}${c.reset} ${c.dim}owner ${s.owner}, key ${s.kid}, made ${when(s.created)}${s.rotatedAt ? `, rotated ${when(s.rotatedAt)}` : ''}${c.reset}`)
      }
    } else if (sub === 'rotate') {
      if (!target) { console.error(`${c.red}Usage: candy app-auth rotate <name>${c.reset}`); process.exit(1) }
      const res = await apiPost('/app-auth/rotate', { name: target }); fail(res)
      console.log(`${c.green}+ ${res.site} has a new key (${res.kid})${c.reset} ${c.dim}sign-ins made with the old one before now still go through for a few minutes; none made after${c.reset}`)
      if (res.restartNeeded?.length) {
        const names = res.restartNeeded.join(', ')
        console.log(`${c.yellow}${names} still run with the old key: candy restart ${res.restartNeeded.join(' ')}${c.reset} ${c.dim}(an app using the SDK's appAuth() picks up the new ring within 5 minutes on its own; anything else keeps the old key until it restarts)${c.reset}`)
      }
    } else if (sub === 'consents') {
      const res = await apiGet('/app-auth/consents'); fail(res)
      if (!res.consents?.length) console.log(`${c.dim}You haven't approved any site${c.reset}`)
      for (const x of res.consents ?? []) console.log(`  ${c.green}${x.site}${c.reset} ${c.dim}run by ${x.owner}, approved ${when(x.at)}${c.reset}`)
    } else if (sub === 'revoke') {
      if (!target) { console.error(`${c.red}Usage: candy app-auth revoke <site>${c.reset}`); process.exit(1) }
      const res = await apiPost('/app-auth/consents/revoke', { site: target }); fail(res)
      console.log(res.revoked ? `${c.red}- ${target} will ask again next time${c.reset}` : `${c.dim}You hadn't approved ${target}${c.reset}`)
    } else {
      console.error(`${c.red}Usage: candy app-auth [list|rotate <name>|consents|revoke <site>]${c.reset}`)
      process.exit(1)
    }
    break
  }
  case 'passkeys': {
    // Read-only: adding or removing one needs a recent password login in the portal
    const res = await apiGet('/passkeys/list')
    if (!res) { console.error(`${c.red}Daemon not running${c.reset}`); process.exit(1) }
    if (res.error) { console.error(`${c.red}${res.error}${c.reset}`); process.exit(1) }
    if (!res.passkeys?.length) console.log(`${c.dim}No passkeys. Add one in the portal: https://portal.localhost/passkeys${c.reset}`)
    for (const p of res.passkeys ?? []) {
      const used = typeof p.lastUsed === 'number' ? new Date(p.lastUsed).toLocaleString() : 'never used'
      console.log(`  ${c.green}${p.name}${c.reset} ${c.dim}${p.rpId}, ${p.alg}${p.backedUp ? ', synced' : ''}, ${used}${c.reset}`)
    }
    console.log(`${c.dim}Add or remove passkeys in the portal: https://portal.localhost/passkeys${c.reset}`)
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
        const res = await apiSuperuser('GET', '/lan/adguard'); fail(res); show(res)
      } else if (action === 'off') {
        const res = await apiSuperuser('POST', '/lan/adguard', { remove: true }); fail(res)
        console.log(`${c.red}- AdGuard Home link removed${c.reset} ${c.dim}(lines candy added were taken out)${c.reset}`)
      } else if (action === 'setup') {
        const opts: Record<string, string> = {}
        const rest = largs.slice(2)
        for (let i = 0; i < rest.length; i++) {
          const m = rest[i].match(/^--(url|user|client|dns)(?:=(.*))?$/)
          if (!m) { console.error(`${c.red}Unknown option: ${rest[i]}${c.reset}`); process.exit(1) }
          opts[m[1]] = m[2] ?? rest[++i] ?? ''
        }
        // Refused before asking for a password nobody can use here
        fail(await apiSuperuser('GET', '/lan/adguard'))
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
        const res = await apiSuperuser('POST', '/lan/adguard', { url, username, password, client, ...(opts.dns ? { dnsTarget: opts.dns } : {}) })
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
