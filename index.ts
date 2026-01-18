#!/usr/bin/env bun
/**
 * candy-localhost CLI - We hand out domains like it's 1980
 *
 * Pure frontend CLI that communicates with the candy daemon via HTTP API
 */

const API_BASE = "http://localhost:9999"

// Token management - rolling one-time-use tokens
let currentToken: string | null = null

// Create a new session and get initial token
const createSession = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${API_BASE}/session`, {
      method: "POST",
      signal: AbortSignal.timeout(5000)
    })
    if (res.ok) {
      const data = await res.json()
      currentToken = data.token
      return true
    }
  } catch {}
  return false
}

// Refresh token after each API call
const refreshToken = async () => {
  if (!currentToken) return
  try {
    const res = await fetch(`${API_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken }),
      signal: AbortSignal.timeout(5000)
    })
    if (res.ok) {
      const data = await res.json()
      currentToken = data.token
    }
  } catch {}
}

// Random message picker for local flavor
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

const msg = {
  notANumber: [
    "That's not a number and you know it.",
    "We need a port number, not poetry.",
    "bestie that's not a port.",
  ],
  daemonOffline: [
    "Daemon's not responding. Is it running?",
    "Can't reach the mothership. Try 'candy start' first.",
    "The void is silent. Start the daemon.",
  ],
  evidence: [
    "Compiling the dossier...",
    "Everything we have on file:",
    "The evidence locker contains:",
  ],
}

// API helpers with token management
const api = {
  async get(path: string) {
    try {
      // Ensure we have a session
      if (!currentToken) await createSession()

      const res = await fetch(`${API_BASE}${path}`, {
        headers: { "X-Candy-Token": currentToken || "" },
        signal: AbortSignal.timeout(5000)
      })

      // Refresh token after successful call
      if (res.ok) await refreshToken()

      return res.json()
    } catch {
      return { error: pick(msg.daemonOffline) }
    }
  },

  async post(path: string, body?: any) {
    try {
      // Ensure we have a session
      if (!currentToken) await createSession()

      const res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Candy-Token": currentToken || ""
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000)  // Longer timeout for tunnel creation
      })

      // Refresh token after successful call
      if (res.ok) await refreshToken()

      return res.json()
    } catch {
      return { error: pick(msg.daemonOffline) }
    }
  },

  async del(path: string) {
    try {
      // Ensure we have a session
      if (!currentToken) await createSession()

      const res = await fetch(`${API_BASE}${path}`, {
        method: "DELETE",
        headers: { "X-Candy-Token": currentToken || "" },
        signal: AbortSignal.timeout(5000)
      })

      // Refresh token after successful call
      if (res.ok) await refreshToken()

      return res.json()
    } catch {
      return { error: pick(msg.daemonOffline) }
    }
  }
}

// Check if daemon is running
const isDaemonRunning = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${API_BASE}/status`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

// Print helpers
const printRoutes = (routes: Record<string, { target: number | string, isRestricted: boolean }>) => {
  if (Object.keys(routes).length === 0) {
    console.log("\x1b[90m  nothing allocated yet. the registry is empty. for now.\x1b[0m")
    return
  }
  for (const [name, { target, isRestricted }] of Object.entries(routes)) {
    const display = isRestricted ? `\x1b[31m${target}\x1b[0m \x1b[90m[RESTRICTED]\x1b[0m` : `:${target}`
    console.log(`  \x1b[32m${name}\x1b[0m.localhost -> ${display}`)
  }
}

const printPortals = (portals: Record<string, { port: number, url?: string }>) => {
  if (Object.keys(portals).length === 0) {
    console.log("\x1b[90m  no tunnels open. squeaky clean. suspiciously clean.\x1b[0m")
    return
  }
  for (const [name, { port, url }] of Object.entries(portals)) {
    console.log(`  \x1b[35m◉\x1b[0m ${name} (:${port}) -> ${url || "(connecting...)"}`)
  }
}

// Command handlers
const handleCommand = async (line: string) => {
  const [cmd, ...args] = line.trim().split(/\s+/)

  switch (cmd) {
    case "add":
    case "a":
    case "summon":
    case "conjure":
    case "manifest": {
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

      const result = await api.post("/register", { name, port })
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m${result.details ? ` (${result.details})` : ""}`)
      } else {
        console.log(`\x1b[32m+\x1b[0m ${name}.localhost -> :${port} \x1b[90m${result.message}\x1b[0m`)
      }
      break
    }

    case "rm":
    case "remove":
    case "r":
    case "silence":
    case "shh":
    case "hush":
    case "eliminate": {
      if (!args[0]) {
        console.log("\x1b[31mUsage: rm <name>\x1b[0m")
        break
      }

      const result = await api.del(`/register/${args[0]}`)
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m${result.details ? ` (${result.details})` : ""}`)
      } else {
        console.log(`\x1b[31m-\x1b[0m ${args[0]}.localhost \x1b[90m${result.message}\x1b[0m`)
      }
      break
    }

    case "rename":
    case "ren":
    case "launder":
    case "mv":
    case "witness":
    case "relocate":
    case "rebrand": {
      const [oldName, newName] = args
      if (!oldName || !newName) {
        console.log("\x1b[31mUsage: rename <old> <new>\x1b[0m")
        break
      }

      const result = await api.post("/rename", { oldName, newName })
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m${result.details ? ` (${result.details})` : ""}`)
      } else {
        console.log(`\x1b[33m~\x1b[0m ${oldName}.localhost -> ${newName}.localhost \x1b[90m${result.message}\x1b[0m`)
      }
      break
    }

    case "ls":
    case "list":
    case "l":
    case "evidence":
    case "dossier":
    case "inventory": {
      if (["evidence", "dossier", "inventory"].includes(cmd)) {
        console.log(`\x1b[90m${pick(msg.evidence)}\x1b[0m`)
      }

      const routes = await api.get("/routes")
      if (routes.error) {
        console.log(`\x1b[31m${routes.error}\x1b[0m`)
      } else {
        printRoutes(routes)
      }
      break
    }

    case "portal":
    case "p":
    case "rift":
    case "void":
    case "breach":
    case "tear": {
      let portalName: string | undefined
      let portalPort: number | undefined

      if (!args[0]) {
        console.log("\x1b[31mUsage: portal [name] <port>\x1b[0m")
        break
      } else if (!isNaN(parseInt(args[0]))) {
        portalPort = parseInt(args[0])
      } else {
        portalName = args[0]
        portalPort = args[1] ? parseInt(args[1]) : undefined
      }

      console.log(`\x1b[35m◉\x1b[0m Opening tunnel... \x1b[90m(this may take a moment)\x1b[0m`)

      const body: any = { port: portalPort }
      if (portalName) body.name = portalName

      const result = await api.post("/portal", body)
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m${result.details ? ` (${result.details})` : ""}`)
      } else {
        console.log(`\x1b[35m◉\x1b[0m ${result.name} -> \x1b[4m${result.url}\x1b[0m \x1b[90m${result.message}\x1b[0m`)
      }
      break
    }

    case "batch-portals":
    case "bp": {
      console.log(`\x1b[35m◉\x1b[0m Opening batch tunnels... \x1b[90m(this may take a moment)\x1b[0m`)

      const targets = args.map(a => isNaN(parseInt(a)) ? a : parseInt(a))
      const result = await api.post("/portal/batch", { targets: targets.length > 0 ? targets : undefined })

      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m`)
      } else {
        console.log(`\x1b[35m◉\x1b[0m ${result.message} \x1b[90m(${result.portals.length} tunnels)\x1b[0m`)
        for (const portal of result.portals) {
          console.log(`  \x1b[35m◉\x1b[0m ${portal.name} -> \x1b[4m${portal.url}\x1b[0m`)
        }
      }
      break
    }

    case "portals":
    case "ps": {
      const portals = await api.get("/portals")
      if (portals.error) {
        console.log(`\x1b[31m${portals.error}\x1b[0m`)
      } else {
        printPortals(portals)
      }
      break
    }

    case "close":
    case "c":
    case "seal":
    case "banish":
    case "collapse": {
      const closeName = args[0]
      if (!closeName) {
        console.log("\x1b[31mUsage: close <name>\x1b[0m")
        break
      }

      const result = await api.post(`/portal/close/${closeName}`)
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m${result.details ? ` (${result.details})` : ""}`)
      } else {
        console.log(`\x1b[35m○\x1b[0m ${closeName} \x1b[90m${result.message}\x1b[0m`)
      }
      break
    }

    case "logs":
    case "confess":
    case "sins":
    case "history": {
      const count = parseInt(args[0]) || 20
      const result = await api.get(`/logs?count=${count}`)

      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m`)
      } else if (result.logs.length === 0) {
        console.log(`\x1b[90mThe record is clean. Suspiciously clean.\x1b[0m`)
      } else {
        console.log(`\n\x1b[31m╔══════════════════════════════════════════════════════════╗\x1b[0m`)
        console.log(`\x1b[31m║\x1b[0m  \x1b[33mCONFESSION LOG\x1b[0m - \x1b[90m${result.total} sins recorded\x1b[0m              \x1b[31m║\x1b[0m`)
        console.log(`\x1b[31m╚══════════════════════════════════════════════════════════╝\x1b[0m\n`)

        for (const entry of result.logs) {
          const time = new Date(entry.time).toLocaleTimeString()
          const actionColor = entry.action.includes("SILENCE") || entry.action.includes("SEAL") ? "\x1b[31m" :
                             entry.action.includes("RIFT") || entry.action.includes("VOID") ? "\x1b[35m" :
                             entry.action.includes("WITNESS") || entry.action.includes("LAUNDER") ? "\x1b[33m" :
                             "\x1b[32m"
          console.log(`  \x1b[90m${time}\x1b[0m  ${actionColor}${entry.action.padEnd(10)}\x1b[0m  ${entry.details}`)
        }

        if (result.total > result.logs.length) {
          console.log(`\n  \x1b[90m... and ${result.total - result.logs.length} more sins buried deeper\x1b[0m`)
        }
        console.log()
      }
      break
    }

    case "interrogate":
    case "stats":
    case "profile": {
      const target = args[0]

      if (!target) {
        const result = await api.get("/stats")
        if (result.error) {
          console.log(`\x1b[31m${result.error}\x1b[0m`)
          break
        }

        const sessionStart = new Date(result.sessionStart)
        const sessionMins = Math.floor((Date.now() - sessionStart.getTime()) / 60000)
        const sessionTime = `${String(Math.floor(sessionMins / 60)).padStart(2, "0")}:${String(sessionMins % 60).padStart(2, "0")}:${String(Math.floor((Date.now() - sessionStart.getTime()) / 1000) % 60).padStart(2, "0")}`

        console.log(`
\x1b[33m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
\x1b[33m▓\x1b[0m  SURVEILLANCE NETWORK \x1b[90m-\x1b[0m LIVE FEED                  \x1b[33m▓\x1b[0m
\x1b[33m▓\x1b[0m  \x1b[90mSession:\x1b[0m ${sessionTime} \x1b[90m│ Domains:\x1b[0m ${result.domainCount} \x1b[90m│ Total:\x1b[0m ${result.totalRequests} req   \x1b[33m▓\x1b[0m
\x1b[33m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
`)
        if (result.stats.length === 0) {
          console.log(`  \x1b[90mNo traffic recorded. The watchers see nothing... yet.\x1b[0m\n`)
        } else {
          const maxHits = result.stats[0]?.total || 1
          const barWidth = 20

          for (const { domain, total, tunnel, isRegistered } of result.stats) {
            const barLen = Math.ceil((total / maxHits) * barWidth)
            const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen)
            const status = isRegistered ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m"
            const tunnelBadge = tunnel > 0 ? `  \x1b[35m◉ ${tunnel} tunneled\x1b[0m` : ""
            const unregBadge = !isRegistered ? "  \x1b[31m[UNREGISTERED]\x1b[0m" : ""
            console.log(`  ${status} ${domain.padEnd(14)} \x1b[35m${bar}\x1b[0m  ${String(total).padStart(4)}${tunnelBadge}${unregBadge}`)
          }
          console.log(`\n  \x1b[90m◉ = external exposure   ○ = ghost traffic\x1b[0m\n`)
        }
      } else {
        const result = await api.get(`/stats/${target}`)
        if (result.error) {
          console.log(`\x1b[31m${result.error}\x1b[0m`)
          break
        }

        const tunnelPct = result.totalRequests > 0 ? ((result.tunnelRequests / result.totalRequests) * 100).toFixed(1) : "0"
        const lastSeenStr = result.lastSeen ? (() => {
          const ago = Math.floor((Date.now() - new Date(result.lastSeen).getTime()) / 60000)
          return ago < 1 ? "just now" : `${ago} min ago`
        })() : "never"

        console.log(`
\x1b[33m╔══════════════════════════════════════════════════╗\x1b[0m
\x1b[33m║\x1b[0m  SUBJECT: \x1b[36m${(target + ".localhost").padEnd(30)}\x1b[0m       \x1b[33m║\x1b[0m
\x1b[33m║\x1b[0m  CLASSIFICATION: ${result.isRegistered ? "\x1b[32m████████ ACTIVE  \x1b[0m" : "\x1b[31m████████ GHOST   \x1b[0m"}              \x1b[33m║\x1b[0m
\x1b[33m╚══════════════════════════════════════════════════╝\x1b[0m

  STATUS ............ ${result.isRegistered ? "\x1b[32mREGISTERED\x1b[0m" : "\x1b[31mUNREGISTERED\x1b[0m"}
  PORT .............. ${result.port ? ":" + result.port : "\x1b[90m-\x1b[0m"}
  EXPOSURE .......... ${result.hasPortal ? "\x1b[35mPUBLIC (tunnel active)\x1b[0m" : "\x1b[90mLOCAL ONLY\x1b[0m"}

  \x1b[90m┌─ TRAFFIC ANALYSIS ─────────────────────────────┐\x1b[0m
  \x1b[90m│\x1b[0m  Total Requests:     ${String(result.totalRequests).padEnd(26)}\x1b[90m│\x1b[0m
  \x1b[90m│\x1b[0m  Via Tunnel:         ${result.tunnelRequests > 0 ? `\x1b[35m${result.tunnelRequests} (${tunnelPct}%)\x1b[0m`.padEnd(35) : "\x1b[90m0\x1b[0m".padEnd(26)}\x1b[90m│\x1b[0m
  \x1b[90m│\x1b[0m  Last Activity:      ${lastSeenStr.padEnd(26)}\x1b[90m│\x1b[0m
  \x1b[90m└────────────────────────────────────────────────┘\x1b[0m
`)
        if (result.hasPortal && result.portalUrl) {
          console.log(`  \x1b[90m┌─ TUNNEL INTEL ──────────────────────────────────┐\x1b[0m
  \x1b[90m│\x1b[0m  URL: \x1b[4m${result.portalUrl}\x1b[0m
  \x1b[90m│\x1b[0m  Status: \x1b[35m◉ ACTIVE\x1b[0m
  \x1b[90m└─────────────────────────────────────────────────┘\x1b[0m
`)
        }

        if (result.activity && result.activity.length > 0) {
          console.log(`  \x1b[90m┌─ ACTIVITY LOG ──────────────────────────────────┐\x1b[0m`)
          for (const entry of result.activity) {
            const actionStr = entry.action.padEnd(12)
            console.log(`  \x1b[90m│\x1b[0m  ${new Date(entry.time).toLocaleTimeString()}  ${actionStr}  ${entry.details.substring(0, 24)}`)
          }
          console.log(`  \x1b[90m└─────────────────────────────────────────────────┘\x1b[0m`)
        }
        console.log()
      }
      break
    }

    case "traffic":
    case "t":
    case "wiretap":
    case "surveil": {
      const trafficTarget = args[0]
      if (!trafficTarget) {
        console.log("\x1b[31mUsage: traffic <name> [count]\x1b[0m")
        break
      }

      const logCount = parseInt(args[1]) || 20
      const result = await api.get(`/traffic/${trafficTarget}?count=${logCount}`)

      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m`)
      } else if (result.logs.length === 0) {
        console.log(`\x1b[90mNo traffic for ${trafficTarget}. The wires are silent.\x1b[0m`)
      } else {
        console.log(`\n\x1b[33mWIRETAP: ${trafficTarget}.localhost\x1b[0m \x1b[90m(${result.count} requests)\x1b[0m\n`)

        for (const log of result.logs) {
          const statusColor = log.status >= 500 ? "\x1b[31m" :
                             log.status >= 400 ? "\x1b[33m" :
                             log.status >= 300 ? "\x1b[36m" : "\x1b[32m"
          const isTunnel = log.isTunnel ? "\x1b[35m◉\x1b[0m " : "  "
          const time = log.time ? new Date(log.time).toLocaleTimeString() : "?"

          console.log(`${isTunnel}\x1b[90m${time}\x1b[0m  ${statusColor}${log.status}\x1b[0m  ${log.method.padEnd(6)}  ${log.path}`)
        }
        console.log()
        console.log(`\x1b[90m  ◉ = tunnel traffic\x1b[0m`)
        console.log()
      }
      break
    }

    case "classified":
    case "redacted":
    case "blackbook": {
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

\x1b[33mSurveillance:\x1b[0m
  confess, sins                \x1b[90m       \x1b[0m         \x1b[35m"The system remembers."\x1b[0m
  interrogate, profile [name]  \x1b[90m       \x1b[0m         \x1b[35m"We're watching."\x1b[0m
  wiretap, surveil             \x1b[90m->\x1b[0m traffic \x1b[35m"The wires have ears."\x1b[0m

\x1b[31m▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓\x1b[0m
\x1b[90mThis document will self-destruct. Or not. Whatever.\x1b[0m
`)
      break
    }

    case "status": {
      const result = await api.get("/status")
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m`)
      } else {
        const uptime = Math.floor(result.uptime)
        const hours = Math.floor(uptime / 3600)
        const mins = Math.floor((uptime % 3600) / 60)
        const secs = uptime % 60
        console.log(`
\x1b[32m●\x1b[0m Daemon Status: \x1b[32mRUNNING\x1b[0m
  PID:      ${result.pid}
  Uptime:   ${hours}h ${mins}m ${secs}s
  Caddy:    ${result.caddyRunning ? "\x1b[32mrunning\x1b[0m" : "\x1b[31mstopped\x1b[0m"}
  Routes:   ${result.routeCount}
  Portals:  ${result.portalCount}
`)
      }
      break
    }

    case "start": {
      if (await isDaemonRunning()) {
        console.log("\x1b[33mDaemon is already running.\x1b[0m")
        break
      }

      console.log("\x1b[90mStarting daemon...\x1b[0m")

      const { spawn } = await import("bun")
      const proc = spawn({
        cmd: ["bun", "run", import.meta.dir + "/daemon.ts"],
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      })
      proc.unref()

      // Wait for daemon to come up
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 250))
        if (await isDaemonRunning()) {
          console.log("\x1b[32mDaemon started.\x1b[0m")
          return
        }
      }

      console.log("\x1b[31mDaemon failed to start. Check logs.\x1b[0m")
      break
    }

    case "stop": {
      if (!await isDaemonRunning()) {
        console.log("\x1b[33mDaemon is not running.\x1b[0m")
        break
      }

      const result = await api.post("/shutdown")
      if (result.error) {
        console.log(`\x1b[31m${result.error}\x1b[0m`)
      } else {
        console.log(`\x1b[90m${result.message}\x1b[0m`)
      }
      break
    }

    case "help":
    case "h":
    case "?": {
      console.log(`
\x1b[33mDaemon Control:\x1b[0m
  start                      Start the candy daemon.
  stop                       Stop the candy daemon.
  status                     Check daemon status.

\x1b[33mDomain Allocation Services:\x1b[0m \x1b[90m(no forms, no waiting, no accountability)\x1b[0m
  add, a <name> <port>       Claim a domain. It's basically free real estate.
  rm, r <name>               Deallocate. We'll pretend it never happened.
  rename, ren <old> <new>    Change a domain's name. Totally normal.
  ls, l                      See what you've hoarded so far.

\x1b[33mUnofficial Tunneling Division:\x1b[0m \x1b[90m(the ITU can't stop us here)\x1b[0m
  portal, p [name] [port]    Open a tunnel. Questions? We don't ask those.
  batch-portals, bp [...]    Bulk tunnel deal. Volume discount.
  portals, ps                Check your back channels.
  close, c <name>            Seal a tunnel. Plausible deniability restored.

\x1b[33mSurveillance:\x1b[0m
  logs [count]               View activity history. The system remembers.
  traffic, t <name> [n]      Wiretap a domain. Shows last n requests.
  stats [name]               Interrogate traffic stats.

\x1b[33mMisc:\x1b[0m
  help, h, ?                 You are here. Congrats.
  exit, quit, q              Leave. Ctrl+C also works.

\x1b[90mVisit any unregistered *.localhost to claim it via the web UI.\x1b[0m
`)
      break
    }

    case "exit":
    case "quit":
    case "q": {
      console.log("\x1b[90mLater.\x1b[0m")
      process.exit(0)
    }

    case "":
      break

    default:
      console.log(`\x1b[31mUnknown command: ${cmd}\x1b[0m (type 'help' for available commands)`)
  }
}

// Main entry
const main = async () => {
  // Check for command line arguments (non-interactive mode)
  const args = process.argv.slice(2)
  if (args.length > 0) {
    await handleCommand(args.join(" "))
    return
  }

  // Interactive mode
  if (!await isDaemonRunning()) {
    console.log(`\x1b[33mDaemon not running.\x1b[0m Starting it...`)
    await handleCommand("start")
    await new Promise(r => setTimeout(r, 500))
  }

  console.log(`
\x1b[36m░█▀▀░█▀█░█▀█░█▀▄░█░█\x1b[0m   \x1b[90mv0.3.0\x1b[0m
\x1b[36m░█░░░█▀█░█░█░█░█░░█░\x1b[0m   "we hand out domains like it's 1980"
\x1b[36m░▀▀▀░▀░▀░▀░▀░▀▀░░░▀░\x1b[0m   \x1b[90mno iana was harmed. probably.\x1b[0m

\x1b[90mtype 'help' if lost. we don't judge.\x1b[0m
`)

  // Show current state
  const routes = await api.get("/routes")
  if (!routes.error && Object.keys(routes).length > 0) {
    console.log(`\x1b[33mActive domains:\x1b[0m`)
    printRoutes(routes)
    console.log()
  }

  const portals = await api.get("/portals")
  if (!portals.error && Object.keys(portals).length > 0) {
    console.log(`\x1b[33mActive tunnels:\x1b[0m`)
    printPortals(portals)
    console.log()
  }

  // TUI
  const prompt = () => process.stdout.write("\x1b[36m>\x1b[0m ")
  prompt()

  const decoder = new TextDecoder()
  for await (const chunk of Bun.stdin.stream()) {
    const line = decoder.decode(chunk)
    await handleCommand(line)
    prompt()
  }
}

main()
