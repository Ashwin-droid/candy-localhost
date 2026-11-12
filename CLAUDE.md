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

Two main files (plus `fn-*.ts` for functions, see Functions below):
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

## Functions

candy-functions run Workers-style modules (`export default { fetch, scheduled }`, Hono apps as is) as `ServerConfig.fn = { entry, deploy?, hot?, max?, log? }`. Full design and the binding module contracts: `FUNCTIONS_DESIGN.md`.

- **Functions never listen on a port or a socket of their own.** Don't add `Bun.serve`, port detection or Caddy upstreams for them. Caddy sends their hosts to the daemon (`reverse_proxy localhost:9999`, route target `{ fn: name }`), and the daemon dispatches by `Host`.
- **Transport**: the daemon listens on `/run/candy/fn/<name>.sock` (user mode `$XDG_RUNTIME_DIR/candy/fn/`), mode 0600, bind-mounted into the sandbox. The instance dials in with `CANDY_FN_TOKEN`. Frames are `u32 len, u8 type, u32 streamId, payload` (`fn-protocol.ts`), many requests multiplexed per connection. HELLO marks the instance ready (replaces port detection).
- **Lifecycle**: TTL 0. A request spawns an instance, waits for HELLO, dispatches. The instance sends BYE and exits when nothing is in flight and `waitUntil` is settled. `hot` instances stay up and are respawned; `max` caps the pool (`fn-pool.ts`). `ttl` and `killIdleServers` don't apply. Cron runs `fn-host.ts <entry> --scheduled <expr>`, args fixed by candy.
- **Files**: `fn-protocol.ts` (frames), `fn-dispatch.ts` (`FnConnection`, daemon side), `fn-pool.ts` (instances), `fn-host.ts` (the shim run inside the sandbox; `/usr/lib/candy/fn-host.ts` in root mode), `fn-config.ts` (`candy.fn.json` / `wrangler.*`), `fn-bindings.ts` (KV, D1), `fn-cron.ts` (`scheduled`, `ExecutionContext`), `fn-deploy.ts` (bundles), `fn-log.ts` + `fn-console.ts` (request log, per-request console), `fn-assets.ts` (Workers Static Assets: resolver, `_headers`, `_redirects`, `.assetsignore`, deploy snapshots).
- **Static assets**: routing order is `run_worker_first` patterns → `_redirects` → asset → the worker, or `not_found_handling` when there's no `main`. The daemon serves asset hits itself without spawning an instance; an assets-only function never starts a process. Surfaces decide that from `fn.hasWorker` (the cached routing state, so a pinned deploy's own worker and assets config), never from `fn.entry`, which is display only. Pattern matching (`run_worker_first`, `_redirects`, `_headers`) is regex-free and linear on the visitor's path; keep it that way. Request log rows carry `kind: "worker" | "asset"` and `rule`.
- **State**: KV/D1 SQLite and `deploys/<id>/` in the function's state dir (`/var/lib/candy/<name>`, user mode `~/.local/state/candy/fn/<name>`). Deploy snapshots are read-only in the sandbox; secrets from `envFile` are never written into them.
- **Request log**: `/var/lib/candy-daemon/fn-log/<name>.sqlite` (user mode `~/.local/state/candy/fn-log/`), written by the daemon from the frames it relays, never mounted into the sandbox. 24h retention, 256 MB cap, 64 KB bodies, header/field redaction. Owner only (`mayChangeConfig`) and never on a public host.
- **API**: `/fn/add|settings|deploy|rollback|dev|deploys|instances|requests|request|tail|replay|kv|d1`. `/configs` entries carry `fn`. The bundle step runs as the function's user, never root.
- **Portal**: `fn` badge, Function panel (assets config with `run_worker_first`, assets-only badge, deploys, rollback, back to dev, hot/max/log, instances, Requests tab with kind + rule per row, live tail over `fetch` SSE and replay) in `public/portal.html`.

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/candy/servers.json` | Server configurations |
| `~/.config/caddy/Caddyfile` | Generated reverse proxy config |
| `~/.config/candy/mcp-secret` | MCP bootstrap secret (mode 600) |
| `/run/candy/users/<user>/secret` | Per-user secret when the daemon runs as root |
| `/var/log/candy/` (root) or `/tmp/candy-logs/` | Per-process logs and `_audit.log` |
| `/var/lib/candy/<name>` or `~/.local/state/candy/fn/<name>` | Function state: KV/D1 SQLite, `deploys/` |
| `/var/lib/candy-daemon/fn-log/` or `~/.local/state/candy/fn-log/` | Function request logs (daemon-only) |
| `/run/candy/fn/<name>.sock` or `$XDG_RUNTIME_DIR/candy/fn/` | Function dial-in sockets |

## HTTP API Authentication

- Session tokens via `X-Candy-Token` header (web UI)
- API keys via `X-Candy-API-Key` header (MCP)
- Token chain: max 2 valid tokens per session (current + previous)

## MCP Tools

The MCP server exposes: `candy_servers`, `candy_start`, `candy_restart`, `candy_stop`, `candy_logs`, `candy_register`, `candy_deregister`, `candy_portal_open`, `candy_portal_close`, `candy_portals`, `candy_input`

Functions: `candy_fn_add`, `candy_fn_deploy`, `candy_fn_rollback`, `candy_fn_deploys`, `candy_fn_kv`, `candy_fn_d1`, `candy_fn_requests`, `candy_fn_request`

## Multi-user and API mode

- The systemd unit runs the daemon as root with `CANDY_OWNER=%i`. Members of the `candy` group get per-user secrets; servers run as the user who registered them (`ServerConfig.user`, launched with `setpriv`). Never start anything as root. See `launchSpec`, `requestUser`, `mayChangeConfig` in daemon.ts.
- Root mode launches go through `systemd-run` (`sandbox.ts`, `launchSpec`): read-only filesystem except the code folder, `/var/lib/candy/<name>` and a private `/tmp`; unit bound to the daemon's unit. Stop with `systemctl stop <unit>` (`managed.unit`), not a process-tree kill. `ServerConfig.sandbox === false` opts out; `ServerConfig.rw` adds writable paths.
- `ServerConfig.api`: requests to a stopped server are held and forwarded 1:1 (`forwardApiModeRequest`) instead of showing the loading page.

## Public MCP endpoint

Optional (`domainConfig.mcp`, off by default): `https://<sub>.<zone>/mcp` serves `handleRequest` from mcp.ts over HTTP behind OAuth 2.1 (`mcp-oauth.ts`, pure logic). Consent happens only on the portal host (`/oauth/*`, tailnet), see `handlePublicMcp` in daemon.ts. The public host must never reach any other daemon route.

## Reserved Names

Cannot be used for server names: `portal`, `p`, `kill`, `k`

## Dependencies

Runtime: Bun, Caddy. Optional: `cloudflared` (tunnels), `ripgrep` (log search).

No external npm packages - uses pure Bun stdlib.
