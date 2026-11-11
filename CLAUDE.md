# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

candy-localhost is a lazy-loaded dev server orchestrator. It spawns local development servers on-demand when you visit `.localhost` domains, auto-detects ports from process output, and provides MCP tools for AI integration.

## Commands

```bash
# Development with auto-reload
bun run dev

# Run daemon once
bun run daemon

# Run MCP server (for AI tool integration)
bun run mcp

# Install as systemd service
sudo npm run install-service
```

## Architecture

Two main files:
- **daemon.ts** - Main control server running on `localhost:9999`. Handles process spawning, Caddy reverse proxy management, port detection, and HTTP API.
- **mcp.ts** - MCP server exposing tools for AI clients via JSON-RPC over stdio. Authenticates with daemon using a bootstrap secret.

### Data Flow

1. User visits `<name>.localhost` → Caddy routes to daemon
2. Daemon spawns server process with PTY (`Bun.Terminal`)
3. Port detection scans stdout/stderr for 10 seconds using regex patterns
4. Single port detected → auto-bind route; multiple ports → selection UI
5. Daemon updates Caddyfile and reloads Caddy

### Key State (in-memory maps)

- `processes: Map<string, ManagedProcess>` - Running servers
- `serverConfigs: Map<string, ServerConfig>` - All configurations (persisted to `~/.config/candy/servers.json`)
- `routes: Map<string, number | string>` - Name → port mappings
- `portals: Map<string, Portal>` - Active Cloudflare tunnels

### Process States

`starting` → `running` → `dead` or `errored`

Servers auto-kill after 1 hour of inactivity unless they have active tunnels. Activity = Caddy access-log lines (including bound domains), open TCP connections to the server's port, or daemon-proxied requests. Servers that called SDK `setIdling()` survive until memory is tight. Logic lives in `activity.ts` (`idleVerdict`), wired up in daemon.ts `killIdleServers`.

### Cron

`ServerConfig.cron` holds jobs set via SDK `setCron` (`/sdk/cron`). A run is `config.cmd "$@"` with the job's args as argv (see `cron.ts`, `launchSpec(config, cron)`); never build shell text from args.

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/candy/servers.json` | Server configurations |
| `~/.config/caddy/Caddyfile` | Generated reverse proxy config |
| `~/.config/candy/mcp-secret` | MCP bootstrap secret (mode 600) |
| `/run/candy/users/<user>/secret` | Per-user secret when the daemon runs as root |
| `/var/log/candy/` (root) or `/tmp/candy-logs/` | Per-process logs and `_audit.log` |

## HTTP API Authentication

- Session tokens via `X-Candy-Token` header (web UI)
- API keys via `X-Candy-API-Key` header (MCP)
- Token chain: max 2 valid tokens per session (current + previous)

## MCP Tools

The MCP server exposes: `candy_servers`, `candy_start`, `candy_restart`, `candy_stop`, `candy_logs`, `candy_register`, `candy_deregister`, `candy_portal_open`, `candy_portal_close`, `candy_portals`, `candy_input`

## Multi-user and API mode

- The systemd unit runs the daemon as root with `CANDY_OWNER=%i`. Members of the `candy` group get per-user secrets; servers run as the user who registered them (`ServerConfig.user`, launched with `setpriv`). Never start anything as root. See `launchSpec`, `requestUser`, `mayChangeConfig` in daemon.ts.
- `ServerConfig.api`: requests to a stopped server are held and forwarded 1:1 (`forwardApiModeRequest`) instead of showing the loading page.

## Reserved Names

Cannot be used for server names: `portal`, `p`, `kill`, `k`

## Dependencies

Runtime: Bun, Caddy. Optional: `cloudflared` (tunnels), `ripgrep` (log search).

No external npm packages - uses pure Bun stdlib.
