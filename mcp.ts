/**
 * candy-localhost MCP Server
 *
 * Tools that mirror what the candy CLI and web portal can do: servers and
 * their configs, routes, LAN publishing, portals, bound domains and their
 * protection, plus read-only status. Runs over stdio when executed directly;
 * the daemon can also import handleRequest.
 */
import { exchangeSecret, readSecrets, secretHint } from "./secret.ts"


// ============================================================================
// Types
// ============================================================================

export interface MCPRequest {
  jsonrpc: "2.0"
  id?: number | string | null
  method: string
  params?: any
}

export interface MCPResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: any
  error?: { code: number; message: string; data?: any }
}

// ============================================================================
// Configuration
// ============================================================================

const DAEMON_URL = "http://localhost:9999"

const SERVER_VERSION = "0.5.0"  // keep in step with package.json
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
const DEFAULT_PROTOCOL_VERSION = "2025-06-18"

// ============================================================================
// Tool Definitions
// ============================================================================

export const TOOLS = [
  {
    name: "candy_servers",
    description: `List all configured local dev servers managed by candy-localhost.

USE THIS TOOL AUTONOMOUSLY when:
- User mentions a project name that might be a dev server (e.g. "inkspired", "myapp")
- User asks about running servers, ports, or localhost domains
- You need to check if a server is running before suggesting to start it
- User is debugging a web app and you need to know its port/status

Returns each server's: name, status (running/stopped), port, PID, working directory, start command, run-as user, API mode, and LAN publishing.
When a name has several configs (variants), they are listed with their configId; when a server printed several ports, detectedPorts lists them (pick one with candy_config set_port).
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

	If the name has several configs (variants), pass configId (see candy_servers). Without it the daemon answers with the list of variants to choose from. Starting a different variant than the one running stops the running one first.

	This STARTS A PROCESS - prefer to confirm with user if they haven't explicitly asked.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name (e.g. 'inkspired', 'myapp')"
        },
        configId: {
          type: "string",
          description: "Which variant to start, when the name has several configs"
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
Registering a name again with a different cwd/cmd adds a variant (see candy_servers for configIds).

Options:
- api: API mode. Requests to a stopped server are held and forwarded once it is up, instead of showing the loading page. On a protected bound domain, API mode also switches browsers' login page for header (JWT) auth.
- user: account the server runs as. Defaults to you. Only the daemon's owner can pick another account, and only one listed by candy_config users.

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
        },
        api: {
          type: "boolean",
          description: "API mode: hold and forward requests while the server starts"
        },
        user: {
          type: "string",
          description: "Run-as account (owner only; see candy_config users). Defaults to the caller"
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
With configId, only that variant is removed (and the server is stopped only if that variant is the one running); without it, every variant of the name is removed.

This MODIFIES CONFIGURATION - confirm with user before deregistering.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Server name to remove"
        },
        configId: {
          type: "string",
          description: "Remove only this variant (see candy_servers)"
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
    name: "candy_domain",
    description: `Manage bound domains — real subdomains on the user's Cloudflare-managed domain that route through a named tunnel.

USE THIS TOOL when:
- User wants to expose a dev server on a real subdomain
- User asks about bound domains or CF tunnel domains
- User wants to bind/unbind a subdomain

Actions:
- list: Show all bound domains, their protection (password / JWT secret / allowlist) and config status
- bind: Bind a subdomain to a server config (creates DNS + ingress)
- unbind: Remove a subdomain binding (deletes DNS + ingress)
- config: Set up zone/tunnel configuration (one-time setup)
- auth_status: Per domain: is it protected, by password and/or JWT secret, API mode, active login sessions (read-only)
- auth_generate_jwt: Give a domain a new random JWT secret (returned once in the result; show it to the user, do not store it). Replaces any existing JWT secret, so tokens signed with the old one stop working. JWTs are only checked when the server is in API mode
- auth_token: Mint a short-lived JWT for a domain that has a JWT secret. ttl in seconds (default 600); once: true makes it single use
- auth_clear: Remove protection. which: "password", "jwt" or "all". THIS CAN MAKE THE DOMAIN PUBLIC: with nothing left, anyone on the internet can reach it. Logs out every session
- allowlist: Restrict a domain to listed IPs/CIDRs (plus Tailscale and this machine). add / remove edit the list, ips replaces it, enabled turns it on or off. Adding entries turns it on. enabled: false, or removing entries, WIDENS WHO CAN REACH THE DOMAIN
- public_mcp_status: Is candy's own MCP server reachable on a public address, where, and which clients are connected (read-only)
- public_mcp_on / public_mcp_off: Turn that public address on or off (subdomain optional, default "candy"). It is OFF by default. ON PUTS CANDY'S CONTROL TOOLS ON THE INTERNET (clients must still be approved from the tailnet); off signs every client out
- public_mcp_revoke: Sign one client out (clientId) or all of them

For the auth_* and allowlist actions, name the domain with subdomain (the binding key, e.g. 'myapp') or domain (the full name, e.g. 'myapp.example.com').

Setting a password is not offered here: the user sets it themselves with \`candy auth set <subdomain>\` so it never passes through a model.

This MODIFIES DNS AND TUNNEL CONFIG - confirm with user before bind/unbind.
auth_clear, allowlist with enabled: false / remove / ips, unbind and public_mcp_on CHANGE WHO CAN REACH THE SITE OR CANDY ITSELF - always confirm with the user first, saying exactly what will become reachable.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "bind", "unbind", "config", "auth_status", "auth_generate_jwt", "auth_token", "auth_clear", "allowlist", "public_mcp_status", "public_mcp_on", "public_mcp_off", "public_mcp_revoke"],
          description: "Action to perform"
        },
        subdomain: {
          type: "string",
          description: "Subdomain name (e.g. 'myapp')"
        },
        domain: {
          type: "string",
          description: "auth_* and allowlist: full domain name, as an alternative to subdomain"
        },
        clientId: {
          type: "string",
          description: "public_mcp_revoke: the client to sign out (omit for all)"
        },
        which: {
          type: "string",
          enum: ["password", "jwt", "all"],
          description: "auth_clear: what to remove (required)"
        },
        ttl: {
          type: "number",
          description: "auth_token: lifetime in seconds (default 600)"
        },
        once: {
          type: "boolean",
          description: "auth_token: single-use token (adds a random jti)"
        },
        enabled: {
          type: "boolean",
          description: "allowlist: turn allowlist mode on or off"
        },
        ips: {
          type: "array",
          items: { type: "string" },
          description: "allowlist: replace the whole list with these IPs/CIDRs"
        },
        add: {
          type: "array",
          items: { type: "string" },
          description: "allowlist: IPs/CIDRs to add"
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description: "allowlist: IPs/CIDRs to remove"
        },
        serverName: {
          type: "string",
          description: "Server config name to bind to (e.g. 'inkspired')"
        },
        force: {
          type: "boolean",
          description: "Force override existing DNS records"
        },
        zone: {
          type: "object",
          properties: {
            id: { type: "string" },
            domain: { type: "string" }
          },
          description: "Zone config for setup (config action)"
        },
        tunnel: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            credentialsFile: { type: "string" }
          },
          description: "Tunnel config for setup (config action)"
        }
      },
      required: ["action"]
    },
    annotations: {
      title: "Manage Bound Domains",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "candy_network",
    description: `View the candy network registry - all local and remote server records across Tailscale machines.

USE THIS TOOL AUTONOMOUSLY when:
- User asks about network discovery or distributed servers
- User wants to see which machines are advertising routes
- User asks "what's on the network" or "which servers are available"
- You need to check if a remote server is registered

Returns local records (this machine's routes with IPs) and remote records (other machines' routes with IPs and time-until-expiry).
Records include Tailscale hostnames plus canonical/alias .candy domains when available.

This is a READ-ONLY operation - safe to call anytime without asking.`,
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: {
      title: "View Network Registry",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_route",
    description: `Manage plain routes (<name>.localhost -> a port or URL) and LAN publishing.

Actions:
- list: All routes with target, persistence and LAN state
- add: Route <name>.localhost to a port (or to an http(s) URL with target). persistent: true survives daemon restarts
- remove: Remove a route. Also stops the server of that name if it is running
- rename: Rename a route (name -> newName). The route, its portal and its LAN opt-in move; a server config keeps its old name
- lan_list: What is published to the LAN, this machine's LAN address and Tailscale hostname, and HTTPS URLs
- lan_publish: Make <name>.candy reachable FROM THE LOCAL NETWORK (off by default; .candy is Tailscale-only otherwise). https adds a publicly trusted certificate: true = the bound domain if the name has one, else the ts.net hostname; "domain" = https://<bound domain>; "tailscale" = https://<host>.ts.net:<port>; false = HTTPS off. port picks the ts.net port (implies "tailscale"; auto-assigned otherwise). Omit https to leave it unchanged
- lan_unpublish: Take <name>.candy off the local network
- adguard_status: Is AdGuard Home linked for LAN DNS, and which rules candy manages there (owner only, read-only)
- entry: Give a name a loopback port (port: 1024-65535, omit to remove) that always reaches it through candy, whatever Host is sent. For local front ends such as tailscale serve; pointing those at the server's own port would bypass candy, so a stopped server would never start. entry_list shows them
- serve: Put a name on this machine's Tailscale hostname with a trusted certificate: https://<host>.ts.net:<port> (port: 1024-65535, omit to remove). candy runs tailscale serve for it and forwards through its entry port. Tailnet only. serve_list shows them
- adguard_unlink: Remove the AdGuard Home link and the rules candy added (owner only). LAN devices stop resolving .candy names through AdGuard

Linking AdGuard Home is not offered here: it needs the AdGuard password, which the user enters themselves with \`candy lan adguard\`.

lan_publish EXPOSES A SITE TO EVERY DEVICE ON THE LOCAL NETWORK - confirm with the user first. Confirm remove, rename and adguard_unlink too unless the user asked for them.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "remove", "rename", "lan_list", "lan_publish", "lan_unpublish", "entry", "entry_list", "serve", "serve_list", "adguard_status", "adguard_unlink"],
          description: "Action to perform"
        },
        name: {
          type: "string",
          description: "Route name (becomes <name>.localhost)"
        },
        newName: {
          type: "string",
          description: "rename: the new route name"
        },
        port: {
          type: "number",
          description: "add: port to route to. lan_publish: HTTPS port on the ts.net hostname"
        },
        target: {
          type: "string",
          description: "add: http(s) URL to route to, instead of a port"
        },
        persistent: {
          type: "boolean",
          description: "If true, route survives daemon restarts"
        },
        https: {
          type: ["boolean", "string"],
          enum: [true, false, "domain", "tailscale"],
          description: "lan_publish only: HTTPS on the LAN. true (bound domain if any, else ts.net), \"domain\", \"tailscale\", or false to turn it off"
        }
      },
      required: ["action"]
    },
    annotations: {
      title: "Manage Routes and LAN Publishing",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  {
    name: "candy_config",
    description: `Inspect and change server configs beyond register/deregister.

Actions:
- list: Every config with its variants (configId, cwd, cmd, run-as user, API mode) and LAN state (read-only)
- users: Accounts servers can run as, who the daemon's owner is, and who you are (read-only)
- set_api: Turn API mode on or off for a name (all variants, or one with configId). In API mode requests to a stopped server are held and forwarded once it is up; on a protected bound domain browsers get header (JWT) auth instead of the login page, so confirm with the user before changing it for a site with a bound domain
- set_port: Choose which port <name>.localhost routes to, when a running server printed several (see detectedPorts in candy_servers)

Renaming a route is candy_route rename. Removing one variant is candy_deregister with configId. Starting a variant is candy_start with configId.

- set_sandbox: Servers run sandboxed by default (read-only filesystem except their code folder, their state folder CANDY_STATE_DIR and a private /tmp). sandbox: false turns that off for a name; addRw / removeRw edit its list of extra writable folders (absolute paths). Takes effect at the next start. TURNING THE SANDBOX OFF OR ADDING WRITABLE PATHS WEAKENS ISOLATION - confirm with the user first

- set_env_file: Hand a KEY=VALUE file to the server as its environment at launch (envFile: absolute path; omit to remove). Only the path passes through here, never the contents. The file must be readable by the server's user, or placed by root in /etc/candy/env/<user>/

set_api, set_port, set_sandbox and set_env_file MODIFY CONFIGURATION - confirm with user if they haven't asked.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "users", "set_api", "set_port", "set_sandbox", "set_env_file"],
          description: "Action to perform"
        },
        name: {
          type: "string",
          description: "Server name (set_api, set_port)"
        },
        configId: {
          type: "string",
          description: "set_api: limit to one variant"
        },
        api: {
          type: "boolean",
          description: "set_api: true for on, false for off"
        },
        envFile: {
          type: "string",
          description: "set_env_file: absolute path of the env file (omit to remove it)"
        },
        sandbox: {
          type: "boolean",
          description: "set_sandbox: false to run this server without the sandbox, true to turn it back on"
        },
        addRw: {
          type: "array",
          items: { type: "string" },
          description: "set_sandbox: extra folders the server may write to (absolute paths)"
        },
        removeRw: {
          type: "array",
          items: { type: "string" },
          description: "set_sandbox: folders to take off that list"
        },
        port: {
          type: "number",
          description: "set_port: the port to route to"
        }
      },
      required: ["action"]
    },
    annotations: {
      title: "Manage Server Configs",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "candy_status",
    description: `Daemon status, request statistics and recent traffic.

USE THIS TOOL AUTONOMOUSLY when:
- You need to know whether the daemon and Caddy are healthy
- User asks how much traffic a site gets, or what requests just hit it
- You are debugging and want the last requests to a domain, or the daemon's recent activity

Actions:
- status (default): Daemon up, Caddy running, route and portal counts, uptime, owner, multi-user mode
- stats: Request totals per domain, with each server's tunnel domains
- traffic: Last requests for one name (name required; count default 20, max 500)
- activity: The daemon's recent activity log (count default 20, max 500)

This is a READ-ONLY operation - safe to call anytime without asking.`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "stats", "traffic", "activity"],
          description: "What to read (default status)"
        },
        name: {
          type: "string",
          description: "traffic: server or domain name"
        },
        count: {
          type: "number",
          description: "traffic / activity: how many entries (default 20, max 500)"
        }
      }
    },
    annotations: {
      title: "Daemon Status and Traffic",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  ]

// ============================================================================
// Daemon API Client
// ============================================================================

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

  if ((await readSecrets()).length === 0) throw new Error(secretHint())
  const key = await exchangeSecret(DAEMON_URL)
  if (!key) throw new Error("Failed to authenticate with daemon. Secret may be stale - restart daemon?")
  apiKey = key
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
        hint: "Ensure the candy daemon is running (port 9999) and ~/.config/candy/mcp-secret or /run/candy/secret is readable."
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

// Mutating calls are attributed to the AI in the daemon's audit log
const AI = { "X-Candy-Actor": "AI" }
const post = (path: string, body?: unknown) =>
  daemonFetch(path, { method: "POST", headers: AI, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const del = (path: string) => daemonFetch(path, { method: "DELETE", headers: AI })
const seg = (value: unknown) => encodeURIComponent(String(value ?? ""))
const clampCount = (value: unknown, fallback = 20) =>
  Math.min(Math.max(Math.floor(Number(value) || fallback), 1), 500)

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
    const active = (config.variants || []).find((v: any) => v.id === proc?.configId) || config
    servers.push({
      name,
      url: `https://${name}.localhost`,
      status: proc?.status || "stopped",
      port: proc?.port || null,
      pid: proc?.pid || null,
      cwd: active.cwd,
      cmd: active.cmd,
      configId: active.id,
      user: active.user,
      api: !!active.api,
      ...(proc?.detectedPorts?.length > 1 ? { detectedPorts: proc.detectedPorts } : {}),
      ...(config.count > 1 ? { variants: config.variants } : {}),
      ...(config.lan ? { lan: true, lanHttps: config.lanHttps ?? null } : {}),
    })
  }

  return { servers }
}

async function handleStart(params: any): Promise<any> {
  const { name, configId } = params
  return await post(`/process/start/${seg(name)}`, configId ? { configId } : undefined)
}

async function handleRestart(params: any): Promise<any> {
  const { name } = params
  return await post(`/process/restart/${seg(name)}`)
}

async function handleStop(params: any): Promise<any> {
  const { name } = params
  return await post(`/process/stop/${seg(name)}`)
}

async function handleRegister(params: any): Promise<any> {
  const { name, cwd, cmd, api, user } = params
  return await post("/config", {
    name, cwd, cmd,
    ...(typeof api === "boolean" ? { api } : {}),
    ...(user ? { user } : {}),
  })
}

async function handleDeregister(params: any): Promise<any> {
  const { name, configId } = params
  if (!name) return { error: "name is required" }
  // First stop the process if running (with a configId: only if that variant is the one running)
  let stop = true
  if (configId) {
    const processesRes = await daemonFetch("/processes")
    stop = processesRes?.processes?.[name]?.configId === configId
  }
  if (stop) await post(`/process/stop/${seg(name)}`).catch(() => {})
  // Then remove the config
  return await del(`/config/${seg(name)}${configId ? `/${seg(configId)}` : ""}`)
}

async function handleConfig(params: any): Promise<any> {
  const { action, name, configId, api, port, sandbox, addRw, removeRw, envFile } = params
  switch (action) {
    case "set_env_file":
      if (!name) return { error: "name is required for set_env_file" }
      return await post("/config/env", { name, ...(configId ? { configId } : {}), envFile: envFile ? String(envFile) : null })
    case "set_sandbox":
      if (!name) return { error: "name is required for set_sandbox" }
      return await post("/config/sandbox", {
        name,
        ...(configId ? { configId } : {}),
        ...(typeof sandbox === "boolean" ? { sandbox } : {}),
        ...(Array.isArray(addRw) ? { addRw: addRw.map(String) } : {}),
        ...(Array.isArray(removeRw) ? { removeRw: removeRw.map(String) } : {}),
      })
    case "list":
      return await daemonFetch("/configs")
    case "users":
      return await daemonFetch("/users")
    case "set_api":
      if (!name || typeof api !== "boolean") return { error: "name and api (true or false) are required for set_api" }
      return await post("/config/api", { name, ...(configId ? { configId } : {}), api })
    case "set_port": {
      const n = Number(port)
      if (!name || !Number.isInteger(n) || n < 1 || n > 65535) return { error: "name and a port (1-65535) are required for set_port" }
      const res = await post(`/process/port/${seg(name)}`, { port: n })
      if (res && res.success === false) return { error: `${name} is not running, so there is no port to choose. Start it first.` }
      return res
    }
    default:
      return { error: "Unknown action. Use: list, users, set_api, set_port, set_sandbox, set_env_file" }
  }
}

async function handleStatus(params: any): Promise<any> {
  const { action = "status", name, count } = params
  switch (action) {
    case "status":
      return await daemonFetch("/status")
    case "stats":
      return await daemonFetch("/stats")
    case "traffic":
      if (!name) return { error: "name is required for traffic" }
      return await daemonFetch(`/traffic/${seg(name)}?count=${clampCount(count)}`)
    case "activity":
      return await daemonFetch(`/logs?count=${clampCount(count)}`)
    default:
      return { error: "Unknown action. Use: status, stats, traffic, activity" }
  }
}

async function handleDomain(params: any): Promise<any> {
  const { action, subdomain, domain, serverName, force, zone, tunnel, which, ttl, once, enabled, ips, add, remove, clientId } = params
  // auth_* and allowlist accept the binding key or the full domain name
  const target = { ...(subdomain ? { subdomain } : {}), ...(domain ? { domain } : {}) }
  const needsTarget = () => (!subdomain && !domain) ? { error: `subdomain or domain is required for ${action}` } : null
  const list = (value: unknown) => Array.isArray(value) ? value.map(String) : undefined

  switch (action) {
    case "list":
      return await daemonFetch("/domains")
    case "bind":
      if (!subdomain || !serverName) return { error: "subdomain and serverName are required for bind" }
      return await post("/domains/bind", { subdomain, serverName, force: force || false })
    case "unbind":
      if (!subdomain) return { error: "subdomain is required for unbind" }
      return await del(`/domains/unbind/${seg(subdomain)}`)
    case "config": {
      const body: any = {}
      if (zone) body.zone = zone
      if (tunnel) body.tunnel = tunnel
      return await post("/domains/config", body)
    }
    case "public_mcp_status":
      return await daemonFetch("/domains/mcp")
    case "public_mcp_on":
    case "public_mcp_off":
      return await post("/domains/mcp", { enabled: action === "public_mcp_on", ...(subdomain ? { subdomain } : {}) })
    case "public_mcp_revoke":
      return await post("/domains/mcp/revoke", clientId ? { clientId } : {})
    case "auth_status":
      return await daemonFetch("/auth/status")
    case "auth_generate_jwt":
      return needsTarget() ?? await post("/auth/set", { ...target, jwtSecret: "generate" })
    case "auth_token":
      return needsTarget() ?? await post("/auth/token", {
        ...target,
        ...(ttl !== undefined ? { ttl: Number(ttl) } : {}),
        ...(once ? { jti: true } : {}),
      })
    case "auth_clear":
      if (which !== "password" && which !== "jwt" && which !== "all") {
        return { error: 'which is required for auth_clear: "password", "jwt" or "all"' }
      }
      return needsTarget() ?? await post("/auth/clear", { ...target, which })
    case "allowlist": {
      const body = {
        ...target,
        ...(typeof enabled === "boolean" ? { enabled } : {}),
        ...(list(ips) ? { ips: list(ips) } : {}),
        ...(list(add) ? { add: list(add) } : {}),
        ...(list(remove) ? { remove: list(remove) } : {}),
      }
      if (Object.keys(body).length === Object.keys(target).length) {
        return { error: "allowlist needs at least one of enabled, ips, add, remove. Use action list to see the current allowlist." }
      }
      return needsTarget() ?? await post("/domains/allowlist", body)
    }
    default:
      return { error: "Unknown action. Use: list, bind, unbind, config, auth_status, auth_generate_jwt, auth_token, auth_clear, allowlist, public_mcp_status, public_mcp_on, public_mcp_off, public_mcp_revoke" }
  }
}

async function handleRoute(params: any): Promise<any> {
  const { action, name, newName, port, target, persistent, https } = params
  const fail = (res: any) => res?.error && typeof res.error === "string" ? `Error: ${res.error}` : null

  switch (action) {
    case "list": {
      const res = await daemonFetch("/routes")
      if (fail(res)) return fail(res)
      const entries = Object.entries((res || {}) as Record<string, any>)
      return entries.length === 0 ? "No routes" : entries.map(([n, r]: [string, any]) => `${n}.localhost -> ${typeof r.target === "string" ? r.target : ":" + r.target}${r.persistent ? " [persistent]" : ""}${r.lan ? " [lan]" : ""}${r.lanHttps ? ` [${r.lanHttps}]` : ""}`).join("\n")
    }
    case "add": {
      if (!name || (!port && !target)) return "Error: name and a port (or target URL) are required for add"
      const res = await post("/register", { name, ...(target ? { target } : { port }), persistent: persistent || false })
      return fail(res) ?? `Route added: ${name}.localhost -> ${target || ":" + port}${persistent ? " (persistent)" : ""}`
    }
    case "remove": {
      if (!name) return "Error: name is required for remove"
      const res = await del(`/register/${seg(name)}`)
      return fail(res) ?? `Route removed: ${name}.localhost`
    }
    case "rename": {
      if (!name || !newName) return "Error: name and newName are required for rename"
      const res = await post("/rename", { oldName: name, newName })
      return fail(res) ?? `Route renamed: ${name}.localhost -> ${newName}.localhost`
    }
    case "lan_list":
      return await daemonFetch("/lan")
    case "lan_publish":
    case "lan_unpublish": {
      if (!name) return `Error: name is required for ${action}`
      const publish = action === "lan_publish"
      const httpsValues: unknown[] = [true, false, "domain", "tailscale"]
      if (publish && https !== undefined && !httpsValues.includes(https)) {
        return 'Error: https must be true, false, "domain" or "tailscale"'
      }
      // A port only means something for the ts.net hostname, so it implies that mode
      const mode = publish && port && (https === undefined || https === true) ? "tailscale" : https
      const res = await post("/lan", {
        name,
        publish,
        ...(publish && mode !== undefined ? { https: mode } : {}),
        ...(publish && port && mode !== false ? { port } : {}),
      })
      return fail(res) ?? (publish
        ? `Published to LAN: ${name}.candy -> ${res.lanIp || "no LAN address detected"}${res.httpsUrl ? `, HTTPS: ${res.httpsUrl}` : ""}${res.warning ? ` (${res.warning})` : ""}`
        : `Unpublished from LAN: ${name}.candy`)
    }
    case "entry": {
      if (!name) return "Error: name is required for entry"
      const res = await post("/routes/entry", { name, port: port ? Number(port) : null })
      return fail(res) ?? (res.port ? `Entry port: ${res.url} -> ${name} (this machine only)` : `${name} has no entry port`)
    }
    case "entry_list":
      return await daemonFetch("/routes/entry")
    case "serve": {
      if (!name) return "Error: name is required for serve"
      const res = await post("/routes/serve", { name, port: port ? Number(port) : null })
      return fail(res) ?? (res.url ? `Served on the tailnet: ${res.url} -> ${name}` : `${name} is no longer served on the tailnet hostname`)
    }
    case "serve_list":
      return await daemonFetch("/routes/serve")
    case "adguard_status":
      return await daemonFetch("/lan/adguard")
    case "adguard_unlink":
      return await post("/lan/adguard", { remove: true })
    default:
      return "Unknown action. Use: list, add, remove, rename, lan_list, lan_publish, lan_unpublish, adguard_status, adguard_unlink"
  }
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

  return await post("/portal", { name, port })
}

async function handlePortalClose(params: any): Promise<any> {
  const { name } = params
  return await post(`/portal/close/${seg(name)}`)
}

async function handlePortals(): Promise<any> {
  return await daemonFetch("/portals")
}

async function handleInput(params: any): Promise<any> {
  const { name, input, key } = params
  const body: any = {}
  if (input !== undefined) body.input = input
  if (key !== undefined) body.key = key

  return await post(`/process/input/${seg(name)}`, body)
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

export async function handleRequest(request: MCPRequest): Promise<MCPResponse | null> {
  const { method, params } = request
  const id = request.id ?? null

  // Notifications never get a response
  if (typeof method === "string" && method.startsWith("notifications/")) return null

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion)
              ? params.protocolVersion
              : DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "candy-localhost", version: SERVER_VERSION }
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
          case "candy_network":
            result = await daemonFetch("/candy/registry")
            break
          case "candy_domain":
            result = await handleDomain(toolArgs)
            break
          case "candy_route":
            result = await handleRoute(toolArgs)
            break
          case "candy_config":
            result = await handleConfig(toolArgs)
            break
          case "candy_status":
            result = await handleStatus(toolArgs)
            break
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

      case "ping":
        return { jsonrpc: "2.0", id, result: {} }

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

if (import.meta.main) main().catch(console.error)
