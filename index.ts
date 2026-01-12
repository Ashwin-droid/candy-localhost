/**
 * candy-localhost - We hand out domains like it's 1980
 * (no iana was harmed in making of this app)
 *
 * Now powered by Caddy!
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
  // Easter egg messages
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

const CADDY = "C:\\Users\\ash6c\\AppData\\Local\\Microsoft\\WinGet\\Links\\caddy.exe"
const CADDYFILE = `${process.env.LOCALAPPDATA}/caddy/Caddyfile`
const routes = new Map<string, number | string>()  // port number OR full URL for restricted proxies
const portals = new Map<string, { proc: ReturnType<typeof spawn> | null, port: number, url?: string, pid?: number }>()
let caddyProc: ReturnType<typeof spawn> | null = null

// The void tracking - guarantees the darkness reveals itself once per 10 visits
let pageViews = 0
let darkShownThisCycle = false

// Activity log - the system remembers everything
const activityLog: { time: Date, action: string, details: string }[] = []
const log = (action: string, details: string) => {
  activityLog.push({ time: new Date(), action, details })
}

// Traffic stats per domain - for interrogation
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

// Start Caddy in background (or relink to existing)
const startCaddy = async () => {
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
    caddyProc.unref()  // don't keep parent alive for this child

    // Give it a moment to start
    await new Promise(r => setTimeout(r, 500))
    console.log("\x1b[32mCaddy started\x1b[0m (PID: " + caddyProc.pid + ")")
  } catch (e) {
    console.log("\x1b[31mFailed to start Caddy\x1b[0m")
  }
}

// Stop Caddy (spawned or detached)
const stopCaddy = async (force = false) => {
  if (caddyProc) {
    caddyProc.kill()
    console.log("\x1b[90mCaddy stopped\x1b[0m")
  } else if (force && await isCaddyRunning()) {
    // Use admin API to stop - faster and doesn't hang
    try {
      await fetch("http://localhost:2019/stop", { method: "POST", signal: AbortSignal.timeout(2000) })
      console.log("\x1b[90mCaddy stopped (was detached)\x1b[0m")
    } catch {
      console.log("\x1b[31mFailed to stop Caddy\x1b[0m")
    }
  }
}

// Cleanup on exit
process.on("SIGINT", async () => {
  for (const [, { proc }] of portals) proc.kill()
  await stopCaddy(true)
  process.exit(0)
})
process.on("SIGTERM", async () => {
  for (const [, { proc }] of portals) proc.kill()
  await stopCaddy(true)
  process.exit(0)
})

// Check if a PID is still running
const isPidRunning = async (pid: number): Promise<boolean> => {
  try {
    const result = await $`tasklist /FI "PID eq ${pid}" /NH`.quiet().text()
    return result.includes(pid.toString())
  } catch {
    return false
  }
}

// Load existing routes and portals from Caddyfile
const loadRoutes = async () => {
  try {
    const content = await Bun.file(CADDYFILE).text()

    // Load routes - matches both localhost:port and full URLs
    const matches = content.matchAll(/^([\w-]+)\.localhost \{\s*reverse_proxy\s+(\S+)/gm)
    for (const [, name, target] of matches) {
      if (target.startsWith("localhost:")) {
        routes.set(name, parseInt(target.replace("localhost:", "")))
      } else {
        routes.set(name, target)  // URL target (restricted)
      }
    }

    // Load portals from b64 blob
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

// Caddy access log path
const CADDY_LOG = `${process.env.LOCALAPPDATA}/caddy/access.log`

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

  // Wildcard fallback - catches unregistered domains, sends to registration page
  content += `*.localhost {
  reverse_proxy localhost:9999
  log
}

`

  // Save portals as b64 blob
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
    // Use admin API for instant reload
    await fetch("http://localhost:2019/load", {
      method: "POST",
      headers: { "Content-Type": "text/caddyfile" },
      body: content,
    })
  } catch (e) {
    console.log("\x1b[31mFailed to reload Caddy - is it running?\x1b[0m")
  }
}

// Control plane API - apps can still register via HTTP
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

let controlServer: ReturnType<typeof Bun.serve> | null = null
try {
  controlServer = Bun.serve({
    port: 9999,
    async fetch(req) {
      const url = new URL(req.url)

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders })
      }

      if (req.method === "POST" && url.pathname === "/register") {
        const body = await req.json() as { name: string; port?: number; target?: string }
        const { name } = body

        // Check if it's a URL (restricted zone) or port
        const isRestricted = body.target && (body.target.startsWith("http://") || body.target.startsWith("https://"))
        const routeTarget = isRestricted ? body.target! : body.port!

        if (!isRestricted) {
          // Check for port collision (skip if updating same name)
          const existingRoute = [...routes.entries()].find(([n, p]) => p === routeTarget && n !== name)
          if (existingRoute) {
            const m = pick(msg.portCollision)
            apiLog(`\x1b[31m!\x1b[0m ${m} (${existingRoute[0]} has :${routeTarget})`)
            return Response.json({ error: m, details: `${existingRoute[0]} has :${routeTarget}` }, { status: 409, headers: corsHeaders })
          }
        }

        routes.set(name, routeTarget)
        await syncCaddy()

        if (isRestricted) {
          log("RESTRICTED", `${name}.localhost -> ${routeTarget}`)
          apiLog(`\x1b[31m⚠\x1b[0m ${name}.localhost -> \x1b[31m${routeTarget}\x1b[0m \x1b[90m[RESTRICTED ZONE]\x1b[0m`)
          return Response.json({
            domain: `${name}.localhost`,
            status: "registered",
            restricted: true,
            message: "You've entered the restricted zone."
          }, { headers: corsHeaders })
        } else {
          const m = pick(msg.added)
          apiLog(`\x1b[32m+\x1b[0m ${name}.localhost -> :${routeTarget} \x1b[90m${m}\x1b[0m`)
          return Response.json({ domain: `${name}.localhost`, status: "registered", message: m }, { headers: corsHeaders })
        }
      }

      if (req.method === "DELETE" && url.pathname.startsWith("/register/")) {
        const name = url.pathname.split("/")[2]
        routes.delete(name)
        await syncCaddy()
        const m = pick(msg.removed)
        apiLog(`\x1b[31m-\x1b[0m ${name}.localhost \x1b[90m${m}\x1b[0m`)
        return Response.json({ status: "removed", message: m }, { headers: corsHeaders })
      }

      // Portal API - create tunnel and optionally open in browser
      if (req.method === "POST" && url.pathname === "/portal") {
        const { name, port, openBrowser } = await req.json() as { name?: string, port: number, openBrowser?: boolean }

        // Check for port collision
        const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
        if (existingPortal) {
          const m = pick(msg.portalCollision)
          return Response.json({ error: m, details: `${existingPortal[0]} has :${port}` }, { status: 409, headers: corsHeaders })
        }

        // Generate name if not provided
        let portalName = name
        if (!portalName) {
          let anonCounter = 1
          while (portals.has(`anon-${anonCounter}`)) anonCounter++
          portalName = `anon-${anonCounter}`
        }

        if (portals.has(portalName)) {
          const m = pick(msg.portalCollision)
          return Response.json({ error: m, details: `${portalName} already open` }, { status: 409, headers: corsHeaders })
        }

        // Ensure route exists for tunnel to flow through Caddy
        if (!routes.has(portalName)) {
          routes.set(portalName, port)
          await syncCaddy()
          apiLog(`\x1b[32m+\x1b[0m ${portalName}.localhost -> :${port} \x1b[90m(auto-registered for tunnel)\x1b[0m`)
        }

        apiLog(`\x1b[35m◉\x1b[0m ${pick(msg.portalOpening)} \x1b[90m(${portalName} :${port})\x1b[0m`)

        // Spawn cloudflared - route through Caddy for logging
        const cfProc = spawn({
          cmd: ["cloudflared", "tunnel", "--url", `https://${portalName}.localhost`, "--no-tls-verify"],
          stdout: "pipe",
          stderr: "pipe",
        })
        portals.set(portalName, { proc: cfProc, port })

        // Wait for URL
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
          const m = pick(msg.portalSuccess)
          apiLog(`\x1b[35m◉\x1b[0m ${portalName} -> \x1b[4m${tunnelUrl}\x1b[0m \x1b[90m${m}\x1b[0m`)

          // Open in browser if requested - delayed so tunnel is warm and doesn't cache errors
          if (openBrowser) {
            setTimeout(() => {
              spawn({ cmd: ["cmd", "/c", "start", tunnelUrl], stdout: "ignore", stderr: "ignore" })
            }, 30000)
          }

          return Response.json({ name: portalName, url: tunnelUrl, port, message: m }, { headers: corsHeaders })
        } else {
          portals.delete(portalName)
          return Response.json({ error: "Tunnel collapsed. Even our connections have limits." }, { status: 500, headers: corsHeaders })
        }
      }

      if (req.method === "GET" && url.pathname === "/portals") {
        const portalList: Record<string, { port: number, url?: string }> = {}
        for (const [name, { port, url }] of portals) {
          portalList[name] = { port, url }
        }
        return Response.json(portalList, { headers: corsHeaders })
      }

      if (req.method === "GET" && url.pathname === "/routes") {
        return Response.json(Object.fromEntries(routes), { headers: corsHeaders })
      }

      // Serve favicon
      if (req.method === "GET" && url.pathname === "/favicon.svg") {
        try {
          const svg = await Bun.file(import.meta.dir + "/public/favicon.svg").text()
          return new Response(svg, {
            headers: { "Content-Type": "image/svg+xml" }
          })
        } catch {
          return new Response("", { status: 404 })
        }
      }

      // Redirect API routes that got GET but expect POST to root
      if (req.method === "GET" && (url.pathname === "/register" || url.pathname === "/portal")) {
        return Response.redirect(url.origin + "/", 302)
      }

      // Redirect any non-root path to root (browsers cache paths on unregistered domains)
      if (req.method === "GET" && url.pathname !== "/") {
        return Response.redirect(url.origin + "/", 302)
      }

      // Serve the registration page for unregistered domains
      // The void reveals itself... sometimes
      if (req.method === "GET" && url.pathname === "/") {
        try {
          // Track domain hits for surveillance
          const reqHost = req.headers.get("host")?.replace(".localhost", "").replace(":9999", "") || "unknown"
          domainHits.set(reqHost, (domainHits.get(reqHost) || 0) + 1)

          pageViews++

          // 15% random chance, OR forced on 10th view if not shown this cycle
          let showDark = Math.random() < 0.15
          if (!showDark && pageViews >= 10 && !darkShownThisCycle) {
            showDark = true
          }

          // Reset cycle after showing dark or hitting 10
          if (showDark) {
            darkShownThisCycle = true
          }
          if (pageViews >= 10) {
            pageViews = 0
            darkShownThisCycle = false
          }

          const page = showDark ? "terminal.html" : "candy.html"
          const html = await Bun.file(import.meta.dir + "/public/" + page).text()
          return new Response(html, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          })
        } catch {
          return new Response("registration terminal offline", { status: 500 })
        }
      }

      return Response.json({ error: "not found" }, { status: 404, headers: corsHeaders })
    }
  })
} catch {
  console.log("\x1b[33mAPI port 9999 busy - running TUI-only mode\x1b[0m")
}

// Clean access log on startup - fresh session, fresh surveillance
try {
  await Bun.write(CADDY_LOG, "")
} catch {}

// Start Caddy and load routes
await startCaddy()
await loadRoutes()

console.log(`
\x1b[36m░█▀▀░█▀█░█▀█░█▀▄░█░█\x1b[0m   \x1b[90mv0.2.0\x1b[0m
\x1b[36m░█░░░█▀█░█░█░█░█░░█░\x1b[0m   "we hand out domains like it's 1980"
\x1b[36m░▀▀▀░▀░▀░▀░▀░▀▀░░░▀░\x1b[0m   \x1b[90mno iana was harmed. probably.\x1b[0m

\x1b[33mCaddyfile:\x1b[0m  ${CADDYFILE}
\x1b[33mControl:\x1b[0m    http://localhost:9999

\x1b[90mtype 'help' if lost. we don't judge.\x1b[0m
`)

if (routes.size > 0) {
  console.log(`\x1b[33mPreviously allocated domains:\x1b[0m \x1b[90m(they're still yours, no questions asked)\x1b[0m`)
  for (const [name, target] of routes) {
    const isRestricted = typeof target === "string"
    const display = isRestricted ? `\x1b[31m${target}\x1b[0m \x1b[90m[RESTRICTED]\x1b[0m` : `:${target}`
    console.log(`  \x1b[32m${name}\x1b[0m.localhost -> ${display}`)
  }
  console.log()
}

if (portals.size > 0) {
  console.log(`\x1b[33mBack channels still open:\x1b[0m \x1b[90m(the tunnels remember)\x1b[0m`)
  for (const [name, { port, url }] of portals) {
    console.log(`  \x1b[35m◉\x1b[0m ${name} (:${port}) -> ${url}`)
  }
  console.log()
}

// TUI
const prompt = () => process.stdout.write("\x1b[36m>\x1b[0m ")

// Log from API layer - clears current line, prints, shows new prompt
const apiLog = (message: string) => {
  process.stdout.write(`\r\x1b[K${message}\n`)
  prompt()
}

const printRoutes = () => {
  if (routes.size === 0) {
    console.log("\x1b[90m  nothing allocated yet. the registry is empty. for now.\x1b[0m")
    return
  }
  for (const [name, target] of routes) {
    const isRestricted = typeof target === "string"
    const display = isRestricted ? `\x1b[31m${target}\x1b[0m \x1b[90m[RESTRICTED]\x1b[0m` : `:${target}`
    console.log(`  \x1b[32m${name}\x1b[0m.localhost -> ${display}`)
  }
}

const handleCommand = async (line: string) => {
  const [cmd, ...args] = line.trim().split(/\s+/)

  switch (cmd) {
    case "add":
    case "a":
    case "summon":
    case "conjure":
    case "manifest":
      const isSummon = ["summon", "conjure", "manifest"].includes(cmd)
      const [name, portStr] = args
      if (!name || !portStr) {
        console.log("\x1b[31mUsage: add <name> <port>\x1b[0m")
        break
      }
      const port = parseInt(portStr)
      if (isNaN(port)) {
        console.log(`\x1b[31m${pick(msg.notANumber)}\x1b[0m`)
        break
      }
      // Check for port collision (skip if updating same name)
      const existingRoute = [...routes.entries()].find(([n, p]) => p === port && n !== name)
      if (existingRoute) {
        console.log(`\x1b[31m${pick(msg.portCollision)}\x1b[0m (${existingRoute[0]} has :${port})`)
        break
      }
      routes.set(name, port)
      await syncCaddy()
      log(isSummon ? "SUMMON" : "ADD", `${name}.localhost -> :${port}`)
      const addMsg = isSummon ? pick(msg.summon) : pick(msg.added)
      console.log(`\x1b[32m+\x1b[0m ${name}.localhost -> :${port} \x1b[90m${addMsg}\x1b[0m`)
      break

    case "rm":
    case "remove":
    case "r":
    case "silence":
    case "shh":
    case "hush":
    case "eliminate":
      const isSilence = ["silence", "shh", "hush", "eliminate"].includes(cmd)
      if (!args[0]) {
        console.log("\x1b[31mUsage: rm <name>\x1b[0m")
        break
      }
      if (routes.has(args[0])) {
        routes.delete(args[0])
        await syncCaddy()
        log(isSilence ? "SILENCE" : "REMOVE", `${args[0]}.localhost`)
        const rmMsg = isSilence ? pick(msg.silence) : pick(msg.removed)
        console.log(`\x1b[31m-\x1b[0m ${args[0]}.localhost \x1b[90m${rmMsg}\x1b[0m`)
      } else {
        console.log(`\x1b[31m${pick(msg.notFound)}\x1b[0m (${args[0]})`)
      }
      break

    case "rename":
    case "ren":
    case "launder":
    case "mv":
    case "witness":
    case "relocate":
    case "rebrand":
      const isWitness = ["launder", "mv", "witness", "relocate", "rebrand"].includes(cmd)
      const [oldName, newName] = args
      if (!oldName || !newName) {
        console.log("\x1b[31mUsage: rename <old> <new>\x1b[0m")
        break
      }
      if (!routes.has(oldName)) {
        console.log(`\x1b[31m${pick(msg.notFound)}\x1b[0m (${oldName})`)
        break
      }
      if (routes.has(newName)) {
        console.log(`\x1b[31mNew identity '${newName}' already exists. Pick another alias.\x1b[0m`)
        break
      }
      const launderPort = routes.get(oldName)!
      routes.delete(oldName)
      routes.set(newName, launderPort)
      // Also rename portal if exists
      if (portals.has(oldName)) {
        const portalData = portals.get(oldName)!
        portals.delete(oldName)
        portals.set(newName, portalData)
      }
      await syncCaddy()
      log(isWitness ? "WITNESS" : "LAUNDER", `${oldName} -> ${newName}`)
      const launderMsg = isWitness ? pick(msg.witness) : pick(msg.launder)
      console.log(`\x1b[33m~\x1b[0m ${oldName}.localhost -> ${newName}.localhost \x1b[90m${launderMsg}\x1b[0m`)
      break

    case "ls":
    case "list":
    case "l":
    case "evidence":
    case "dossier":
    case "inventory":
      if (["evidence", "dossier", "inventory"].includes(cmd)) {
        console.log(`\x1b[90m${pick(msg.evidence)}\x1b[0m`)
      }
      printRoutes()
      break

    case "portal":
    case "p":
    case "rift":
    case "void":
    case "breach":
    case "tear":
      const isRift = ["rift", "void", "breach", "tear"].includes(cmd)
      let portalName: string
      let portalPort: number | undefined

      if (!args[0]) {
        // No args - need at least a port
        console.log("\x1b[31mUsage: portal [name] <port>\x1b[0m")
        break
      } else if (!isNaN(parseInt(args[0]))) {
        // First arg is a number - anonymous portal
        portalPort = parseInt(args[0])
        let anonCounter = 1
        while (portals.has(`anon-${anonCounter}`)) anonCounter++
        portalName = `anon-${anonCounter}`
      } else {
        // First arg is a name
        portalName = args[0]
        portalPort = args[1] ? parseInt(args[1]) : routes.get(portalName)
      }

      if (!portalPort) {
        console.log(`\x1b[31m${pick(msg.notFound)}\x1b[0m (${portalName} - no port)`)
        break
      }

      if (portals.has(portalName)) {
        console.log(`\x1b[33m${pick(msg.portalCollision)}\x1b[0m (${portalName})`)
        break
      }

      // Check for port collision
      const existingOnPort = [...portals.entries()].find(([, p]) => p.port === portalPort)
      if (existingOnPort) {
        console.log(`\x1b[33m${pick(msg.portalCollision)}\x1b[0m (${existingOnPort[0]} has :${portalPort})`)
        break
      }

      // Ensure route exists for tunnel to flow through Caddy
      if (!routes.has(portalName)) {
        routes.set(portalName, portalPort)
        await syncCaddy()
        console.log(`\x1b[32m+\x1b[0m ${portalName}.localhost -> :${portalPort} \x1b[90m(auto-registered for tunnel)\x1b[0m`)
      }

      // Spawn cloudflared - route through Caddy for logging
      const cfProc = spawn({
        cmd: ["cloudflared", "tunnel", "--url", `https://${portalName}.localhost`, "--no-tls-verify"],
        stdout: "pipe",
        stderr: "pipe",
      })

      portals.set(portalName, { proc: cfProc, port: portalPort })
      const openMsg = isRift ? pick(msg.rift) : pick(msg.portalOpening)
      console.log(`\x1b[35m◉\x1b[0m ${openMsg} \x1b[90m(${portalName} :${portalPort})\x1b[0m`)

      // Wait for the URL (blocks until received)
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
        log(isRift ? "RIFT" : "PORTAL", `${portalName} -> ${tunnelUrl}`)
        console.log(`\x1b[35m◉\x1b[0m ${portalName} -> \x1b[4m${tunnelUrl}\x1b[0m \x1b[90m${pick(msg.portalSuccess)}\x1b[0m`)
      } else {
        log("COLLAPSE", `${portalName} failed`)
        console.log(`\x1b[31mTunnel collapsed. Even our connections have limits.\x1b[0m`)
        portals.delete(portalName)
      }
      break

    case "batch-portals":
    case "bp":
      // If no args, use all routes
      const batchTargets: { name: string, port: number }[] = []

      if (args.length === 0) {
        for (const [name, target] of routes) {
          // Skip restricted (URL) routes - can't tunnel external URLs
          if (typeof target === "string") continue
          if (!portals.has(name)) batchTargets.push({ name, port: target })
        }
        if (batchTargets.length === 0) {
          console.log(`\x1b[33m${pick(msg.noRoutes)}\x1b[0m`)
          break
        }
      } else {
        for (const arg of args) {
          if (!isNaN(parseInt(arg))) {
            // It's a port - create anon portal
            const port = parseInt(arg)
            // Check for port collision with existing portals or batch targets
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
            if (existingPortal) {
              console.log(`\x1b[33m${pick(msg.portalCollision)}\x1b[0m (${existingPortal[0]} has :${port})`)
              continue
            }
            if (batchTargets.some(t => t.port === port)) {
              console.log(`\x1b[33m:${port} already in batch\x1b[0m`)
              continue
            }
            let anonCounter = 1
            while (portals.has(`anon-${anonCounter}`) || batchTargets.some(t => t.name === `anon-${anonCounter}`)) anonCounter++
            batchTargets.push({ name: `anon-${anonCounter}`, port })
          } else {
            // It's a name - lookup port from routes
            const routeTarget = routes.get(arg)
            if (!routeTarget) {
              console.log(`\x1b[31m${pick(msg.notFound)}\x1b[0m (${arg})`)
              continue
            }
            if (typeof routeTarget === "string") {
              console.log(`\x1b[31mCan't tunnel restricted routes\x1b[0m (${arg})`)
              continue
            }
            const port = routeTarget
            if (portals.has(arg)) {
              console.log(`\x1b[33m${pick(msg.portalCollision)}\x1b[0m (${arg})`)
              continue
            }
            // Check for port collision
            const existingPortal = [...portals.entries()].find(([, p]) => p.port === port)
            if (existingPortal) {
              console.log(`\x1b[33m${pick(msg.portalCollision)}\x1b[0m (${existingPortal[0]} has :${port})`)
              continue
            }
            if (batchTargets.some(t => t.port === port)) {
              console.log(`\x1b[33m:${port} (${arg}) already in batch\x1b[0m`)
              continue
            }
            batchTargets.push({ name: arg, port })
          }
        }
      }

      if (batchTargets.length === 0) {
        console.log(`\x1b[33m${pick(msg.noRoutes)}\x1b[0m`)
        break
      }

      console.log(`\x1b[35m◉\x1b[0m ${pick(msg.batchOpening)} \x1b[90m(${batchTargets.length} tunnels)\x1b[0m`)

      // Spawn all cloudflared processes and wait for URLs in parallel
      // Routes through Caddy for logging
      const batchResults = await Promise.all(batchTargets.map(async ({ name, port }) => {
        const proc = spawn({
          cmd: ["cloudflared", "tunnel", "--url", `https://${name}.localhost`, "--no-tls-verify"],
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

      // Update portals and print results
      for (const { name, url, pid } of batchResults) {
        const portal = portals.get(name)
        if (url && portal) {
          portal.url = url
          portal.pid = pid
          console.log(`  \x1b[35m◉\x1b[0m ${name} -> \x1b[4m${url}\x1b[0m \x1b[90m${pick(msg.portalSuccess)}\x1b[0m`)
        } else {
          console.log(`  \x1b[31m✗\x1b[0m ${name} - tunnel collapsed`)
          portals.delete(name)
        }
      }
      await syncCaddy()
      break

    case "portals":
    case "ps":
      if (portals.size === 0) {
        console.log("\x1b[90m  no tunnels open. squeaky clean. suspiciously clean.\x1b[0m")
      } else {
        for (const [pname, { port, url, proc }] of portals) {
          const status = proc ? "◉" : "◎"  // filled = spawned, hollow = relinked
          console.log(`  \x1b[35m${status}\x1b[0m ${pname} (:${port}) -> ${url || "(connecting...)"}`)
        }
      }
      break

    case "close":
    case "c":
    case "seal":
    case "banish":
    case "collapse":
      const isSeal = ["seal", "banish", "collapse"].includes(cmd)
      const closeName = args[0]
      if (!closeName) {
        console.log("\x1b[31mUsage: close <name>\x1b[0m")
        break
      }
      const toClose = portals.get(closeName)
      if (toClose) {
        if (toClose.proc) {
          toClose.proc.kill()
        } else if (toClose.pid) {
          // Relinked portal - kill by PID
          await $`taskkill /PID ${toClose.pid} /F`.quiet().nothrow()
        }
        portals.delete(closeName)
        await syncCaddy()  // update persisted state
        log(isSeal ? "SEAL" : "CLOSE", closeName)
        const closeMsg = isSeal ? pick(msg.seal) : pick(msg.portalClosed)
        console.log(`\x1b[35m○\x1b[0m ${closeName} \x1b[90m${closeMsg}\x1b[0m`)
      } else {
        console.log(`\x1b[31m${pick(msg.notFound)}\x1b[0m (portal: ${closeName})`)
      }
      break

    case "logs":
    case "confess":
    case "sins":
    case "history":
      if (activityLog.length === 0) {
        console.log(`\x1b[90mThe record is clean. Suspiciously clean.\x1b[0m`)
      } else {
        console.log(`\n\x1b[31m╔══════════════════════════════════════════════════════════╗\x1b[0m`)
        console.log(`\x1b[31m║\x1b[0m  \x1b[33mCONFESSION LOG\x1b[0m - \x1b[90m${activityLog.length} sins recorded\x1b[0m              \x1b[31m║\x1b[0m`)
        console.log(`\x1b[31m╚══════════════════════════════════════════════════════════╝\x1b[0m\n`)
        for (const entry of activityLog.slice(-20)) {
          const time = entry.time.toLocaleTimeString()
          const actionColor = entry.action.includes("SILENCE") || entry.action.includes("SEAL") ? "\x1b[31m" :
                             entry.action.includes("RIFT") || entry.action.includes("VOID") ? "\x1b[35m" :
                             entry.action.includes("WITNESS") || entry.action.includes("LAUNDER") ? "\x1b[33m" :
                             "\x1b[32m"
          console.log(`  \x1b[90m${time}\x1b[0m  ${actionColor}${entry.action.padEnd(10)}\x1b[0m  ${entry.details}`)
        }
        if (activityLog.length > 20) {
          console.log(`\n  \x1b[90m... and ${activityLog.length - 20} more sins buried deeper\x1b[0m`)
        }
        console.log()
      }
      break

    case "interrogate":
    case "stats":
    case "profile":
      // Count hits from Caddy access log + find last activity times
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

      const target = args[0]
      if (!target) {
        // Show all domain stats - cinematic overview
        const totalReqs = [...caddyHits.values()].reduce((a, b) => a + b.total, 0)
        const sessionStart = activityLog[0]?.time || new Date()
        const sessionMins = Math.floor((Date.now() - sessionStart.getTime()) / 60000)
        const sessionTime = `${String(Math.floor(sessionMins / 60)).padStart(2, "0")}:${String(sessionMins % 60).padStart(2, "0")}:${String(Math.floor((Date.now() - sessionStart.getTime()) / 1000) % 60).padStart(2, "0")}`

        console.log(`
\x1b[33m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
\x1b[33m▓\x1b[0m  SURVEILLANCE NETWORK \x1b[90m-\x1b[0m LIVE FEED                  \x1b[33m▓\x1b[0m
\x1b[33m▓\x1b[0m  \x1b[90mSession:\x1b[0m ${sessionTime} \x1b[90m│ Domains:\x1b[0m ${caddyHits.size} \x1b[90m│ Total:\x1b[0m ${totalReqs} req   \x1b[33m▓\x1b[0m
\x1b[33m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
`)
        if (caddyHits.size === 0) {
          console.log(`  \x1b[90mNo traffic recorded. The watchers see nothing... yet.\x1b[0m\n`)
        } else {
          const sorted = [...caddyHits.entries()].sort((a, b) => b[1].total - a[1].total)
          const maxHits = sorted[0]?.[1].total || 1
          const barWidth = 20

          for (const [domain, { total, tunnel }] of sorted) {
            const barLen = Math.ceil((total / maxHits) * barWidth)
            const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen)
            const status = routes.has(domain) ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m"
            const tunnelBadge = tunnel > 0 ? `  \x1b[35m◉ ${tunnel} tunneled\x1b[0m` : ""
            const unregBadge = !routes.has(domain) ? "  \x1b[31m[UNREGISTERED]\x1b[0m" : ""
            console.log(`  ${status} ${domain.padEnd(14)} \x1b[35m${bar}\x1b[0m  ${String(total).padStart(4)}${tunnelBadge}${unregBadge}`)
          }
          console.log(`\n  \x1b[90m◉ = external exposure   ○ = ghost traffic\x1b[0m\n`)
        }
      } else {
        // Show specific domain stats - detailed dossier
        const stats = caddyHits.get(target) || { total: 0, tunnel: 0, lastSeen: 0 }
        const isRegistered = routes.has(target)
        const hasPortal = portals.has(target)
        const portalUrl = portals.get(target)?.url
        const tunnelPct = stats.total > 0 ? ((stats.tunnel / stats.total) * 100).toFixed(1) : "0"
        const lastSeenAgo = stats.lastSeen ? Math.floor((Date.now() / 1000 - stats.lastSeen) / 60) : null
        const lastSeenStr = lastSeenAgo !== null ? (lastSeenAgo < 1 ? "just now" : `${lastSeenAgo} min ago`) : "never"

        console.log(`
\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m
\x1b[33m║\x1b[0m  SUBJECT: \x1b[36m${(target + ".localhost").padEnd(30)}\x1b[0m       \x1b[33m║\x1b[0m
\x1b[33m║\x1b[0m  CLASSIFICATION: ${isRegistered ? "\x1b[32m████████ ACTIVE  \x1b[0m" : "\x1b[31m████████ GHOST   \x1b[0m"}              \x1b[33m║\x1b[0m
\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m

  STATUS ............ ${isRegistered ? "\x1b[32mREGISTERED\x1b[0m" : "\x1b[31mUNREGISTERED\x1b[0m"}
  PORT .............. ${isRegistered ? ":" + routes.get(target) : "\x1b[90m-\x1b[0m"}
  EXPOSURE .......... ${hasPortal ? "\x1b[35mPUBLIC (tunnel active)\x1b[0m" : "\x1b[90mLOCAL ONLY\x1b[0m"}

  \x1b[90m┌─ TRAFFIC ANALYSIS ─────────────────────────────┐\x1b[0m
  \x1b[90m│\x1b[0m  Total Requests:     ${String(stats.total).padEnd(26)}\x1b[90m│\x1b[0m
  \x1b[90m│\x1b[0m  Via Tunnel:         ${stats.tunnel > 0 ? `\x1b[35m${stats.tunnel} (${tunnelPct}%)\x1b[0m`.padEnd(35) : "\x1b[90m0\x1b[0m".padEnd(26)}\x1b[90m│\x1b[0m
  \x1b[90m│\x1b[0m  Last Activity:      ${lastSeenStr.padEnd(26)}\x1b[90m│\x1b[0m
  \x1b[90m└────────────────────────────────────────────────┘\x1b[0m
`)
        if (hasPortal && portalUrl) {
          console.log(`  \x1b[90m┌─ TUNNEL INTEL ──────────────────────────────────┐\x1b[0m
  \x1b[90m│\x1b[0m  URL: \x1b[4m${portalUrl}\x1b[0m
  \x1b[90m│\x1b[0m  Status: \x1b[35m◉ ACTIVE\x1b[0m
  \x1b[90m└─────────────────────────────────────────────────┘\x1b[0m
`)
        }

        // Find activity for this domain
        const domainActivity = activityLog.filter(e => e.details.includes(target))
        if (domainActivity.length > 0) {
          console.log(`  \x1b[90m┌─ ACTIVITY LOG ──────────────────────────────────┐\x1b[0m`)
          for (const entry of domainActivity.slice(-5)) {
            const actionStr = entry.action.padEnd(12)
            console.log(`  \x1b[90m│\x1b[0m  ${entry.time.toLocaleTimeString()}  ${actionStr}  ${entry.details.substring(0, 24)}`)
          }
          console.log(`  \x1b[90m└─────────────────────────────────────────────────┘\x1b[0m`)
        }
        console.log()
      }
      break

    case "traffic":
    case "t":
    case "wiretap":
    case "surveil":
      // Show Caddy access logs for a specific domain (includes tunnel traffic)
      const trafficTarget = args[0]
      if (!trafficTarget) {
        console.log("\x1b[31mUsage: traffic <name> [count]\x1b[0m")
        break
      }
      const logCount = parseInt(args[1]) || 20
      try {
        const logContent = await Bun.file(CADDY_LOG).text()
        const allLines = logContent.trim().split("\n").filter(l => l.trim())

        // Filter by domain
        const filtered: string[] = []
        for (const line of allLines) {
          try {
            const entry = JSON.parse(line)
            const host = entry.request?.host?.replace(".localhost", "") || ""
            if (host === trafficTarget) filtered.push(line)
          } catch {}
        }

        const lines = filtered.slice(-logCount)

        if (lines.length === 0) {
          console.log(`\x1b[90mNo traffic for ${trafficTarget}. The wires are silent.\x1b[0m`)
          break
        }

        console.log(`\n\x1b[33mWIRETAP: ${trafficTarget}.localhost\x1b[0m \x1b[90m(${lines.length}/${filtered.length} requests)\x1b[0m\n`)

        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            const req = entry.request || {}
            const method = req.method || "?"
            const path = req.uri || "/"
            const status = entry.status || "?"
            const ts = entry.ts ? new Date(entry.ts * 1000).toLocaleTimeString() : "?"

            // Color code by status
            const statusColor = status >= 500 ? "\x1b[31m" :
                               status >= 400 ? "\x1b[33m" :
                               status >= 300 ? "\x1b[36m" : "\x1b[32m"

            // Check if this is tunnel traffic (from cloudflare)
            const cfRay = req.headers?.["Cf-Ray"]?.[0]
            const isTunnel = cfRay ? "\x1b[35m◉\x1b[0m " : "  "

            console.log(`${isTunnel}\x1b[90m${ts}\x1b[0m  ${statusColor}${status}\x1b[0m  ${method.padEnd(6)}  ${path}`)
          } catch {
            // Skip malformed lines
          }
        }
        console.log()
        console.log(`\x1b[90m  ◉ = tunnel traffic\x1b[0m`)
        console.log()
      } catch {
        console.log(`\x1b[90mNo access log found. Traffic surveillance offline.\x1b[0m`)
      }
      break

    case "classified":
    case "redacted":
    case "blackbook":
      console.log(`
\x1b[31m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
\x1b[31m▓\x1b[0m  \x1b[33mCLASSIFIED - EYES ONLY - CLEARANCE LEVEL 5\x1b[0m  \x1b[31m▓\x1b[0m
\x1b[31m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m

\x1b[90mThe following commands do not officially exist.\x1b[0m

\x1b[33mDark Allocations:\x1b[0m
  summon, conjure, manifest    \x1b[90m->\x1b[0m add     \x1b[35m"The ritual is complete."\x1b[0m
  silence, shh, hush, eliminate \x1b[90m->\x1b[0m rm      \x1b[35m"They knew too much."\x1b[0m
  launder, mv, witness, relocate \x1b[90m->\x1b[0m rename  \x1b[35m"Witness protection."\x1b[0m
  evidence, dossier, inventory \x1b[90m->\x1b[0m ls      \x1b[35m"Compiling the dossier..."\x1b[0m

\x1b[33mVoid Operations:\x1b[0m
  rift, void, breach, tear     \x1b[90m->\x1b[0m portal  \x1b[35m"Reality torn."\x1b[0m
  seal, banish, collapse       \x1b[90m->\x1b[0m close   \x1b[35m"Banished to the void."\x1b[0m

\x1b[33mEscape Routes:\x1b[0m
  vanish, ghost, disappear     \x1b[90m->\x1b[0m exit    \x1b[35m"*poof*"\x1b[0m
  abandon, flee                \x1b[90m->\x1b[0m detach  \x1b[35m"Going dark."\x1b[0m

\x1b[33mSurveillance:\x1b[0m
  confess, sins                \x1b[90m       \x1b[0m         \x1b[35m"The system remembers."\x1b[0m
  interrogate, profile [name]  \x1b[90m       \x1b[0m         \x1b[35m"We're watching."\x1b[0m
  wiretap, surveil             \x1b[90m->\x1b[0m traffic \x1b[35m"The wires have ears."\x1b[0m

\x1b[31m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
\x1b[90mThis document will self-destruct. Or not. Whatever.\x1b[0m
`)
      break

    case "help":
    case "h":
    case "?":
      console.log(`
\x1b[33mDomain Allocation Services:\x1b[0m \x1b[90m(no forms, no waiting, no accountability)\x1b[0m
  add, a <name> <port>     Claim a domain. It's basically free real estate.
  rm, r <name>             Deallocate. We'll pretend it never happened.
  rename, ren <old> <new>  Change a domain's name. Totally normal.
  ls, l                    See what you've hoarded so far.

\x1b[33mUnofficial Tunneling Division:\x1b[0m \x1b[90m(the ITU can't stop us here)\x1b[0m
  portal, p [name] [port]  Open a tunnel. Questions? We don't ask those.
  batch-portals, bp [...]  Bulk tunnel deal. Volume discount.
  portals, ps              Check your back channels.
  close, c <name>          Seal a tunnel. Plausible deniability restored.

\x1b[33mBureaucracy:\x1b[0m
  logs                     View activity history. The system remembers.
  traffic, t <name> [n]    Wiretap a domain. Shows last n requests.
  help, h, ?               You are here. Congrats.
  exit, q                  Leave. Takes the tunnels down with you.
  detach, d                Leave but keep everything running. Shady.

\x1b[33mAPI:\x1b[0m \x1b[90m(for the automation girlies)\x1b[0m
  POST   :9999/register        {"name":"x","port":3000}
  DELETE :9999/register/:name
  GET    :9999/routes
  POST   :9999/portal          {"name?":"x","port":3000,"openBrowser?":true}
  GET    :9999/portals

\x1b[90mRoutes persist in Caddyfile. Caddy handles the hard stuff.
Visit any unregistered *.localhost to claim it via the web UI.\x1b[0m
`)
      break

    case "exit":
    case "quit":
    case "q":
    case "vanish":
    case "ghost":
    case "disappear":
      const isVanish = ["vanish", "ghost", "disappear"].includes(cmd)
      const exitMsg = isVanish ? pick(msg.vanish) : pick(msg.exit)
      console.log(`\x1b[90m${exitMsg}\x1b[0m`)
      for (const [, { proc }] of portals) proc?.kill()
      await stopCaddy(true)
      process.exit(0)

    case "detach":
    case "d":
    case "abandon":
    case "flee":
      console.log(`\x1b[90m${pick(msg.detach)}\x1b[0m`)
      caddyProc = null
      // 1. Stop Caddy
      await fetch("http://localhost:2019/stop", { method: "POST" }).catch(() => {})
      await new Promise(r => setTimeout(r, 200))
      // 2. Stop control server (Caddy no longer sees it)
      if (controlServer) await controlServer.stop()
      await new Promise(r => setTimeout(r, 100))
      // 3. Restart Caddy fresh
      spawn({ cmd: [CADDY, "run", "--config", CADDYFILE], stdout: "ignore", stderr: "ignore", detached: true }).unref()
      await new Promise(r => setTimeout(r, 300))
      process.exit(0)

    case "":
      break

    default:
      console.log(`\x1b[31m${pick(msg.notFound)}\x1b[0m (command: ${cmd})`)
  }
}

prompt()

const decoder = new TextDecoder()
for await (const chunk of Bun.stdin.stream()) {
  const line = decoder.decode(chunk)
  await handleCommand(line)
  prompt()
}
