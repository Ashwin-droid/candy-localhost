/**
 * candy-localhost daemon - We hand out domains like it's 1980
 * (no iana was harmed in making of this app)
 *
 * Runs as a background service, manages Caddy, and serves the control plane API
 */

import { $, spawn } from "bun"

// Random message picker
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

// Playful messages
const msg = {
  added: [
    "Approved. Next!",
    "Rubber stamped. No paperwork required.",
    "Allocated. Accountability is for the 2000s.",
    "Added to the registry. The auditors won't notice.",
    "IANA would be proud.",
    "slay.",
    "say less.",
    "done. no cap.",
  ],
  removed: [
    "Reclaimed. Like it never happened.",
    "Gone. We'll shred the paperwork.",
    "Deallocated. Off the books.",
    "ghosted.",
    "it's giving... deleted.",
  ],
  portCollision: [
    "That port's already spoken for. Even we have some standards.",
    "Someone beat you to it. Should've asked in 1983.",
    "Already claimed. First come, first served - the IANA way.",
    "That port's taken. It's complicated.",
    "port's in a relationship already.",
    "that port has mass. it's taken.",
  ],
  portalOpening: [
    "Opening an unregistered tunnel... the ITU can't reach us here.",
    "Bypassing international regulations...",
    "The UN has no jurisdiction in localhost.",
    "Digging a tunnel through the bureaucracy...",
    "no thoughts just tunnels...",
  ],
  portalSuccess: [
    "You didn't get this from us.",
    "Connection established. Off the record, of course.",
    "Tunnel's open. What you do with it is your business.",
    "and i oop- it's live.",
    "lowkey connected. highkey untraceable.",
  ],
  portalCollision: [
    "Already got a tunnel there. We're generous, not wasteful.",
    "That port's already got a backroom deal.",
    "bestie that tunnel exists already.",
  ],
  portalClosed: [
    "Tunnel sealed. Plausible deniability restored.",
    "Connection severed. We were never here.",
    "tunnel said: i'm out.",
  ],
  batchOpening: [
    "Bulk deal approved. Volume discount.",
    "Opening multiple back channels...",
    "Quantity over quality. The IANA special.",
    "understood the assignment.",
  ],
  notFound: [
    "Never heard of 'em.",
    "Not in our records. Try another registry.",
    "That name doesn't ring a bell.",
    "who? idk her.",
    "404 in the streets, 404 in the sheets.",
  ],
  notANumber: [
    "That's not a number and you know it.",
    "We need a port number, not poetry.",
    "bestie that's not a port.",
  ],
  detach: [
    "Shredding the paperwork...",
    "Leaving the back door open...",
    "brb (not really).",
    "going dark. tunnels stay lit.",
  ],
  exit: [
    "Closing up shop. Evidence destroyed.",
    "Later. This meeting never happened.",
    "Peace out. The registry forgets nothing.",
    "Gone. Like a /8 block in 1983.",
    "Exiting. Tell IANA we said hi.",
  ],
  noRoutes: [
    "Nothing on the books to tunnel.",
    "Registry's empty. Add some routes first.",
    "can't tunnel nothing bestie.",
  ],
  launder: [
    "Papers updated. New identity, who dis?",
    "Clean as a whistle. Never heard of the old name.",
    "Laundered. The auditors will never know.",
    "New name just dropped. Past is past.",
    "Identity scrubbed. Witness protection activated.",
    "it's giving... rebrand.",
  ],
  silence: [
    "Silenced. They won't be talking anymore.",
    "Shhhh... it's done.",
    "They knew too much.",
    "Problem solved. Permanently.",
    "Gone. Like they never existed.",
  ],
  summon: [
    "The ritual is complete. It has arrived.",
    "From the void, a domain emerges.",
    "You called. It answered.",
    "Summoned from the depths of localhost.",
  ],
  rift: [
    "Reality torn. The rift is open.",
    "A hole in the fabric of the network.",
    "The void peers back at you.",
    "Careful. Some tunnels go both ways.",
  ],
  seal: [
    "The rift is sealed. For now.",
    "Banished back to the void.",
    "The connection withers and dies.",
    "Sealed. Whatever was on the other side stays there.",
  ],
  witness: [
    "New identity assigned. Old one? Never heard of it.",
    "Relocated. Don't look back.",
    "The past is dead. Long live the new name.",
  ],
  vanish: [
    "Vanishing... tell no one.",
    "Going dark. Forget this address.",
    "We were never here.",
    "*poof*",
  ],
  evidence: [
    "Compiling the dossier...",
    "Everything we have on file:",
    "The evidence locker contains:",
  ],
}

const CADDY = "caddy"
const CADDY_CONFIG_DIR = `${process.env.HOME}/.config/caddy`
const CADDYFILE = `${CADDY_CONFIG_DIR}/Caddyfile`
const CADDY_LOG = `${CADDY_CONFIG_DIR}/access.log`
const PID_FILE = `${CADDY_CONFIG_DIR}/candy.pid`

const routes = new Map<string, number | string>()
const portals = new Map<string, { proc: ReturnType<typeof spawn> | null, port: number, url?: string, pid?: number }>()
let caddyProc: ReturnType<typeof spawn> | null = null

// Rolling token chains - per-client (session) amnesiac arrays
// Token format: sessionId:tokenValue
// Each session has its own chain: [previous_used, current_valid]
const sessionTokens = new Map<string, { chain: string[], created: number }>()

// Clean up old sessions periodically (older than 24h)
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  for (const [sessionId, data] of sessionTokens) {
    if (data.created < cutoff) sessionTokens.delete(sessionId)
  }
}, 60 * 60 * 1000) // every hour

// Generate a random token value
const generateTokenValue = () => crypto.randomUUID()

// Generate a new session with initial token
const createSession = (): string => {
  const sessionId = crypto.randomUUID()
  const tokenValue = generateTokenValue()
  const fullToken = `${sessionId}:${tokenValue}`
  sessionTokens.set(sessionId, { chain: [fullToken], created: Date.now() })
  return fullToken
}

// Parse token into sessionId and tokenValue
const parseToken = (token: string): { sessionId: string, tokenValue: string } | null => {
  const parts = token.split(':')
  if (parts.length !== 2) return null
  return { sessionId: parts[0], tokenValue: parts[1] }
}

// Validate and consume token - returns true if valid (consumes it)
const consumeToken = (token: string): boolean => {
  const parsed = parseToken(token)
  if (!parsed) return false

  const session = sessionTokens.get(parsed.sessionId)
  if (!session) return false

  // Token must be the current (last) in chain
  const currentToken = session.chain[session.chain.length - 1]
  if (token !== currentToken) return false

  // Valid! Generate next token
  const newTokenValue = generateTokenValue()
  const newToken = `${parsed.sessionId}:${newTokenValue}`

  // Slide the window: keep max 2 tokens
  if (session.chain.length >= 2) {
    session.chain.shift()
  }
  session.chain.push(newToken)

  return true
}

// Refresh token - if provided token exists in session chain, return current token
const refreshToken = (oldToken: string): string | null => {
  const parsed = parseToken(oldToken)
  if (!parsed) return null

  const session = sessionTokens.get(parsed.sessionId)
  if (!session) return null

  // Token must exist somewhere in the chain (current or just-used)
  if (!session.chain.includes(oldToken)) return null

  // Return the current (last) token
  return session.chain[session.chain.length - 1]
}

// Get current token for a session (used for SSR)
const getCurrentToken = (sessionId: string): string | null => {
  const session = sessionTokens.get(sessionId)
  if (!session) return null
  return session.chain[session.chain.length - 1]
}

// The void tracking
let pageViews = 0
let darkShownThisCycle = false

// Activity log
const activityLog: { time: Date, action: string, details: string }[] = []
const log = (action: string, details: string) => {
  activityLog.push({ time: new Date(), action, details })
}

// Traffic stats per domain
const domainHits = new Map<string, number>()

// Check if Caddy is already running via admin API
const isCaddyRunning = async () => {
  try {
    const res = await fetch("http://localhost:2019/config/", { signal: AbortSignal.timeout(500) })
    return res.ok
  } catch {
    return false
  }
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

// Start Caddy in background
const startCaddy = async () => {
  await $`mkdir -p ${CADDY_CONFIG_DIR}`.quiet().nothrow()

  if (await isCaddyRunning()) {
    console.log("\x1b[33mCaddy already running\x1b[0m (relinked)")
    return
  }

  try {
    caddyProc = spawn({
      cmd: [CADDY, "run", "--config", CADDYFILE],
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    caddyProc.unref()

    await new Promise(r => setTimeout(r, 500))
    console.log("\x1b[32mCaddy started\x1b[0m (PID: " + caddyProc.pid + ")")
  } catch (e) {
    console.log("\x1b[31mFailed to start Caddy\x1b[0m")
  }
}

// Stop Caddy
const stopCaddy = async (force = false) => {
  if (caddyProc) {
    caddyProc.kill()
    console.log("\x1b[90mCaddy stopped\x1b[0m")
  } else if (force && await isCaddyRunning()) {
    try {
      await fetch("http://localhost:2019/stop", { method: "POST", signal: AbortSignal.timeout(2000) })
      console.log("\x1b[90mCaddy stopped (was detached)\x1b[0m")
    } catch {
      console.log("\x1b[31mFailed to stop Caddy\x1b[0m")
    }
  }
}

// Cleanup on exit
const cleanup = async () => {
  for (const [, { proc }] of portals) proc?.kill()
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
    for (const [, name, target] of matches) {
      if (target.startsWith("localhost:")) {
        routes.set(name, parseInt(target.replace("localhost:", "")))
      } else {
        routes.set(name, target)
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

// Write Caddyfile and reload
const syncCaddy = async () => {
  let content = `# candy-localhost routes
# managed by candy-localhost - do not edit manually

{
  log {
    output file ${CADDY_LOG.replace(/\\/g, "/")}
    format json
  }
}

`
  for (const [name, target] of routes) {
    const proxyTarget = typeof target === "number" ? `localhost:${target}` : target
    content += `${name}.localhost {
  reverse_proxy ${proxyTarget}
  log
}

`
  }

  // portal.localhost is handled by the daemon directly via *.localhost wildcard
  content += `*.localhost {
  reverse_proxy localhost:9999
  log
}

`

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

  await Bun.write(CADDYFILE, content)

  try {
    await fetch("http://localhost:2019/load", {
      method: "POST",
      headers: { "Content-Type": "text/caddyfile" },
      body: content,
    })
  } catch (e) {
    console.log("\x1b[31mFailed to reload Caddy - is it running?\x1b[0m")
  }
}

// Parse Caddy access logs for stats
const getCaddyStats = async () => {
  const caddyHits = new Map<string, { total: number, tunnel: number, lastSeen: number }>()
  try {
    const logContent = await Bun.file(CADDY_LOG).text()
    for (const line of logContent.trim().split("\n").filter(l => l.trim())) {
      try {
        const entry = JSON.parse(line)
        const host = entry.request?.host?.replace(".localhost", "") || ""
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
        const host = entry.request?.host?.replace(".localhost", "") || ""
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

// Strict CORS headers - localhost only
const getCorsHeaders = (origin: string | null) => {
  // Only allow *.localhost origins
  const allowed = origin && (origin.endsWith('.localhost') || origin === 'http://localhost:9999' || origin.match(/^https?:\/\/[a-z0-9-]+\.localhost(:\d+)?$/))
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Candy-Token",
    "Access-Control-Allow-Credentials": "true",
  }
}

// Token validation response
const unauthorizedResponse = (cors: ReturnType<typeof getCorsHeaders>) =>
  Response.json({ error: "Invalid or expired token. Refresh required." }, { status: 401, headers: cors })

// Control plane API server
const controlServer = Bun.serve({
  port: 9999,
  async fetch(req) {
    const url = new URL(req.url)
    const origin = req.headers.get("origin")
    const corsHeaders = getCorsHeaders(origin)

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    // === Session Creation Endpoint (no auth required - for CLI) ===
    if (req.method === "POST" && url.pathname === "/session") {
      const token = createSession()
      return Response.json({ token }, { headers: corsHeaders })
    }

    // === Token Refresh Endpoint (no auth required) ===
    if (req.method === "POST" && url.pathname === "/token") {
      const body = await req.json() as { token: string }
      const newToken = refreshToken(body.token)
      if (!newToken) {
        return Response.json({ error: "Invalid token. Session expired." }, { status: 401, headers: corsHeaders })
      }
      return Response.json({ token: newToken }, { headers: corsHeaders })
    }

    // === Web UI Routes (no token required, token is SSR'd) ===
    const isWebRoute = req.method === "GET" && (
      url.pathname === "/" ||
      url.pathname === "/favicon.svg" ||
      url.pathname === "/register" ||
      url.pathname === "/portal"
    )

    // === API Routes require token validation ===
    if (!isWebRoute) {
      const token = req.headers.get("X-Candy-Token")
      if (!token || !consumeToken(token)) {
        return unauthorizedResponse(corsHeaders)
      }
    }

    // === Route Management ===

    if (req.method === "POST" && url.pathname === "/register") {
      const body = await req.json() as { name: string; port?: number; target?: string }
      const { name } = body

      // Reserved names
      if (name.toLowerCase() === "portal") {
        return Response.json({ error: "That name is reserved. Nice try though.", details: name }, { status: 403, headers: corsHeaders })
      }

      const isRestricted = body.target && (body.target.startsWith("http://") || body.target.startsWith("https://"))
      const routeTarget = isRestricted ? body.target! : body.port!

      if (!isRestricted) {
        const existingRoute = [...routes.entries()].find(([n, p]) => p === routeTarget && n !== name)
        if (existingRoute) {
          const m = pick(msg.portCollision)
          return Response.json({ error: m, details: `${existingRoute[0]} has :${routeTarget}` }, { status: 409, headers: corsHeaders })
        }
      }

      routes.set(name, routeTarget)
      await syncCaddy()

      if (isRestricted) {
        log("RESTRICTED", `${name}.localhost -> ${routeTarget}`)
        return Response.json({
          domain: `${name}.localhost`,
          status: "registered",
          restricted: true,
          message: "You've entered the restricted zone."
        }, { headers: corsHeaders })
      } else {
        const m = pick(msg.added)
        log("ADD", `${name}.localhost -> :${routeTarget}`)
        return Response.json({ domain: `${name}.localhost`, status: "registered", message: m }, { headers: corsHeaders })
      }
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/register/")) {
      const name = url.pathname.split("/")[2]
      if (name.toLowerCase() === "portal") {
        return Response.json({ error: "That name is reserved. Nice try though.", details: name }, { status: 403, headers: corsHeaders })
      }
      if (!routes.has(name)) {
        return Response.json({ error: pick(msg.notFound), details: name }, { status: 404, headers: corsHeaders })
      }
      routes.delete(name)
      await syncCaddy()
      const m = pick(msg.removed)
      log("REMOVE", `${name}.localhost`)
      return Response.json({ status: "removed", message: m }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/rename") {
      const { oldName, newName } = await req.json() as { oldName: string, newName: string }

      if (oldName.toLowerCase() === "portal" || newName.toLowerCase() === "portal") {
        return Response.json({ error: "That name is reserved. Nice try though.", details: "portal" }, { status: 403, headers: corsHeaders })
      }
      if (!routes.has(oldName)) {
        return Response.json({ error: pick(msg.notFound), details: oldName }, { status: 404, headers: corsHeaders })
      }
      if (routes.has(newName)) {
        return Response.json({ error: `New identity '${newName}' already exists.`, details: newName }, { status: 409, headers: corsHeaders })
      }

      const port = routes.get(oldName)!
      routes.delete(oldName)
      routes.set(newName, port)

      if (portals.has(oldName)) {
        const portalData = portals.get(oldName)!
        portals.delete(oldName)
        portals.set(newName, portalData)
      }

      await syncCaddy()
      const m = pick(msg.launder)
      log("RENAME", `${oldName} -> ${newName}`)
      return Response.json({ status: "renamed", oldName, newName, message: m }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/routes") {
      const routeList: Record<string, { target: number | string, isRestricted: boolean }> = {}
      for (const [name, target] of routes) {
        if (name.toLowerCase() === "portal") continue  // hide reserved
        routeList[name] = {
          target,
          isRestricted: typeof target === "string"
        }
      }
      return Response.json(routeList, { headers: corsHeaders })
    }

    // === Portal Management ===

    if (req.method === "POST" && url.pathname === "/portal") {
      const { name, port, openBrowser } = await req.json() as { name?: string, port: number, openBrowser?: boolean }

      const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
      if (existingPortal) {
        const m = pick(msg.portalCollision)
        return Response.json({ error: m, details: `${existingPortal[0]} has :${port}` }, { status: 409, headers: corsHeaders })
      }

      let portalName = name
      if (!portalName) {
        let anonCounter = 1
        while (portals.has(`anon-${anonCounter}`)) anonCounter++
        portalName = `anon-${anonCounter}`
      }

      if (portalName.toLowerCase() === "portal") {
        return Response.json({ error: "That name is reserved. Nice try though.", details: portalName }, { status: 403, headers: corsHeaders })
      }

      if (portals.has(portalName)) {
        const m = pick(msg.portalCollision)
        return Response.json({ error: m, details: `${portalName} already open` }, { status: 409, headers: corsHeaders })
      }

      if (!routes.has(portalName)) {
        routes.set(portalName, port)
        await syncCaddy()
      }

      const cfProc = spawn({
        cmd: ["cloudflared", "tunnel", "--url", `http://localhost:${port}`],
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

      if (tunnelUrl) {
        const portal = portals.get(portalName)
        if (portal) {
          portal.url = tunnelUrl
          portal.pid = cfProc.pid
          await syncCaddy()
        }

        if (openBrowser) {
          setTimeout(() => {
            spawn({ cmd: ["xdg-open", tunnelUrl], stdout: "ignore", stderr: "ignore" })
          }, 30000)
        }

        const m = pick(msg.portalSuccess)
        log("PORTAL", `${portalName} -> ${tunnelUrl}`)
        return Response.json({ name: portalName, url: tunnelUrl, port, message: m }, { headers: corsHeaders })
      } else {
        portals.delete(portalName)
        return Response.json({ error: "Tunnel collapsed. Even our connections have limits." }, { status: 500, headers: corsHeaders })
      }
    }

    if (req.method === "POST" && url.pathname === "/portal/batch") {
      const { targets } = await req.json() as { targets?: (string | number)[] }

      const batchTargets: { name: string, port: number }[] = []

      if (!targets || targets.length === 0) {
        for (const [name, target] of routes) {
          if (typeof target === "string") continue
          if (!portals.has(name)) batchTargets.push({ name, port: target })
        }
        if (batchTargets.length === 0) {
          return Response.json({ error: pick(msg.noRoutes) }, { status: 400, headers: corsHeaders })
        }
      } else {
        for (const arg of targets) {
          if (typeof arg === "number") {
            const port = arg
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
            if (existingPortal || batchTargets.some(t => t.port === port)) continue
            let anonCounter = 1
            while (portals.has(`anon-${anonCounter}`) || batchTargets.some(t => t.name === `anon-${anonCounter}`)) anonCounter++
            batchTargets.push({ name: `anon-${anonCounter}`, port })
          } else {
            const routeTarget = routes.get(arg)
            if (!routeTarget || typeof routeTarget === "string") continue
            if (portals.has(arg)) continue
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === routeTarget)
            if (existingPortal || batchTargets.some(t => t.port === routeTarget)) continue
            batchTargets.push({ name: arg, port: routeTarget })
          }
        }
      }

      if (batchTargets.length === 0) {
        return Response.json({ error: pick(msg.noRoutes) }, { status: 400, headers: corsHeaders })
      }

      const results = await Promise.all(batchTargets.map(async ({ name, port }) => {
        const proc = spawn({
          cmd: ["cloudflared", "tunnel", "--url", `http://localhost:${port}`],
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
          log("PORTAL", `${name} -> ${url}`)
          successResults.push({ name, port, url })
        } else {
          portals.delete(name)
        }
      }
      await syncCaddy()

      return Response.json({
        portals: successResults,
        message: pick(msg.batchOpening)
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/portals") {
      const portalList: Record<string, { port: number, url?: string }> = {}
      for (const [name, { port, url }] of portals) {
        portalList[name] = { port, url }
      }
      return Response.json(portalList, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname.startsWith("/portal/close/")) {
      const name = url.pathname.split("/")[3]
      const toClose = portals.get(name)

      if (!toClose) {
        return Response.json({ error: pick(msg.notFound), details: `portal: ${name}` }, { status: 404, headers: corsHeaders })
      }

      if (toClose.proc) {
        toClose.proc.kill()
      } else if (toClose.pid) {
        await $`kill -9 ${toClose.pid}`.quiet().nothrow()
      }
      portals.delete(name)
      await syncCaddy()

      const m = pick(msg.portalClosed)
      log("CLOSE", name)
      return Response.json({ status: "closed", name, message: m }, { headers: corsHeaders })
    }

    // === Logs & Stats ===

    if (req.method === "GET" && url.pathname === "/logs") {
      const count = parseInt(url.searchParams.get("count") || "20")
      return Response.json({
        logs: activityLog.slice(-count).map(e => ({
          time: e.time.toISOString(),
          action: e.action,
          details: e.details
        })),
        total: activityLog.length
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      const caddyHits = await getCaddyStats()
      const totalReqs = [...caddyHits.values()].reduce((a, b) => a + b.total, 0)
      const sessionStart = activityLog[0]?.time || new Date()

      const stats: any[] = []
      const sorted = [...caddyHits.entries()].sort((a, b) => b[1].total - a[1].total)

      for (const [domain, { total, tunnel }] of sorted) {
        stats.push({
          domain,
          total,
          tunnel,
          isRegistered: routes.has(domain)
        })
      }

      return Response.json({
        sessionStart: sessionStart.toISOString(),
        totalRequests: totalReqs,
        domainCount: caddyHits.size,
        stats
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname.startsWith("/stats/")) {
      const domain = url.pathname.split("/")[2]
      const caddyHits = await getCaddyStats()
      const stats = caddyHits.get(domain) || { total: 0, tunnel: 0, lastSeen: 0 }

      const isRegistered = routes.has(domain)
      const hasPortal = portals.has(domain)
      const portalUrl = portals.get(domain)?.url
      const port = routes.get(domain)

      const domainActivity = activityLog.filter(e => e.details.includes(domain))

      return Response.json({
        domain,
        isRegistered,
        port: isRegistered ? port : null,
        hasPortal,
        portalUrl: portalUrl || null,
        totalRequests: stats.total,
        tunnelRequests: stats.tunnel,
        lastSeen: stats.lastSeen ? new Date(stats.lastSeen * 1000).toISOString() : null,
        activity: domainActivity.slice(-10).map(e => ({
          time: e.time.toISOString(),
          action: e.action,
          details: e.details
        }))
      }, { headers: corsHeaders })
    }

    if (req.method === "GET" && url.pathname.startsWith("/traffic/")) {
      const domain = url.pathname.split("/")[2]
      const count = parseInt(url.searchParams.get("count") || "20")
      const logs = await getTrafficLogs(domain, count)

      return Response.json({
        domain,
        count: logs.length,
        logs
      }, { headers: corsHeaders })
    }

    // === Status & Control ===

    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({
        status: "running",
        caddyRunning: await isCaddyRunning(),
        routeCount: routes.size,
        portalCount: portals.size,
        uptime: process.uptime(),
        pid: process.pid
      }, { headers: corsHeaders })
    }

    if (req.method === "POST" && url.pathname === "/shutdown") {
      const m = pick(msg.exit)
      setTimeout(async () => {
        await cleanup()
        process.exit(0)
      }, 100)
      return Response.json({ status: "shutting_down", message: m }, { headers: corsHeaders })
    }

    // === Web UI ===

    // SSR inject token into HTML - creates a new session for each page load
    const injectToken = (html: string): string => {
      const token = createSession() // new session per page load
      const tokenScript = `<script>window.CANDY_TOKEN="${token}";</script>`
      // Inject before the first <script> tag or at the end of <head>
      if (html.includes('<script>')) {
        return html.replace('<script>', tokenScript + '<script>')
      }
      return html.replace('</head>', tokenScript + '</head>')
    }

    if (req.method === "GET" && url.pathname === "/favicon.svg") {
      try {
        const svg = await Bun.file(import.meta.dir + "/public/favicon.svg").text()
        return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } })
      } catch {
        return new Response("", { status: 404 })
      }
    }

    if (req.method === "GET" && (url.pathname === "/register" || url.pathname === "/portal")) {
      return Response.redirect(url.origin + "/", 302)
    }

    if (req.method === "GET" && url.pathname !== "/") {
      return Response.redirect(url.origin + "/", 302)
    }

    if (req.method === "GET" && url.pathname === "/") {
      try {
        const reqHost = req.headers.get("host")?.replace(".localhost", "").replace(":9999", "") || "unknown"
        domainHits.set(reqHost, (domainHits.get(reqHost) || 0) + 1)

        // Serve portal UI at portal.localhost
        if (reqHost === "portal") {
          const rawHtml = await Bun.file(import.meta.dir + "/public/portal.html").text()
          const html = injectToken(rawHtml)
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        }

        pageViews++

        let showDark = Math.random() < 0.15
        if (!showDark && pageViews >= 10 && !darkShownThisCycle) {
          showDark = true
        }

        if (showDark) {
          darkShownThisCycle = true
        }
        if (pageViews >= 10) {
          pageViews = 0
          darkShownThisCycle = false
        }

        const page = showDark ? "terminal.html" : "candy.html"
        const rawHtml = await Bun.file(import.meta.dir + "/public/" + page).text()
        const html = injectToken(rawHtml)
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
      } catch {
        return new Response("registration terminal offline", { status: 500 })
      }
    }

    return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
  }
})

// Clear access log and Caddyfile on startup (fresh slate each boot)
try {
  await Bun.write(CADDY_LOG, "")
} catch {}

// Create fresh Caddyfile (don't load previous routes - clean slate)
await syncCaddy()

// Now start Caddy
await startCaddy()

// Write PID file
await Bun.write(PID_FILE, process.pid.toString())

console.log(`
\x1b[36m░█▀▀░█▀█░█▀█░█▀▄░█░█\x1b[0m   \x1b[90mv0.3.0 (daemon)\x1b[0m
\x1b[36m░█░░░█▀█░█░█░█░█░░█░\x1b[0m   "we hand out domains like it's 1980"
\x1b[36m░▀▀▀░▀░▀░▀░▀░▀▀░░░▀░\x1b[0m   \x1b[90mno iana was harmed. probably.\x1b[0m

\x1b[33mCaddyfile:\x1b[0m  ${CADDYFILE}
\x1b[33mControl:\x1b[0m    http://localhost:9999
\x1b[33mPID:\x1b[0m        ${process.pid}

\x1b[90mdaemon mode active. use 'candy' CLI to interact.\x1b[0m
`)

