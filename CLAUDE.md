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
- **Request log**: `/var/lib/candy-daemon/fn-log/<name>.sqlite` (user mode `~/.local/state/candy/fn-log/`), written by the daemon from the frames it relays, never mounted into the sandbox. 24h retention, 256 MB cap, 64 KB bodies, header/field redaction. The function's user or a superuser (`mayChangeConfig`), and never on a public host.
- **API**: `/fn/add|settings|deploy|rollback|dev|deploys|instances|requests|request|tail|replay|kv|d1`. `/configs` entries carry `fn`. The bundle step runs as the function's user, never root.
- **Portal**: `fn` badge, Function panel (assets config with `run_worker_first`, assets-only badge, deploys, rollback, back to dev, hot/max/log, instances, Requests tab with kind + rule per row, live tail over `fetch` SSE and replay) in `public/portal.html`.

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/candy/servers.json` | Server configurations |
| `~/.config/caddy/Caddyfile` | Generated reverse proxy config |
| `~/.config/candy/mcp-secret` | MCP bootstrap secret (mode 600) |
| `/run/candy/users/<user>/secret` | Per-user secret when the daemon runs as root |
| `/var/log/candy/` (root) or `/tmp/candy-logs/` | Per-process logs (`<name>.log`); the audit log is `daemon/audit.log`, outside the name space |
| `/run/candy/caddy-admin.sock` or `$XDG_RUNTIME_DIR/candy/caddy-admin.sock` (no `XDG_RUNTIME_DIR`: `~/.config/candy/run/`, 0700, never `/tmp`) | Caddy's admin API (0600; never `localhost:2019`). No `/load` is sent until the socket and its folder pass `secureCaddyAdminSocket` |
| `~/.config/caddy/access.log` | Caddy's access log, 0600. Secret headers are filtered out (`LOG_REDACTED_*_HEADERS`, caddy-config.ts) |
| `/var/lib/candy/<name>` or `~/.local/state/candy/fn/<name>` | Function state: KV/D1 SQLite, `deploys/` |
| `/var/lib/candy-daemon/fn-log/` or `~/.local/state/candy/fn-log/` | Function request logs (daemon-only) |
| `/run/candy/fn/<name>.sock` or `$XDG_RUNTIME_DIR/candy/fn/` | Function dial-in sockets |
| `/var/lib/candy-daemon/portal-sessions.json` or `~/.local/state/candy/portal-sessions.json` | Portal logins (cookie and session-secret hashes only, 0600) |
| `~/.config/candy/route-users.json` | Who registered each plain route (routes without a config) |
| `/etc/pam.d/candy` | PAM service for portal login (from `candy.pam`) |

## HTTP API Authentication

Spec: "Portal Login (PAM)" in `AUTH_DESIGN.md`.

- **`requestAuth(req)`** in daemon.ts is the only way to ask who a request is: `{ user, superuser, via: "portal" | "apikey" | "oauth", sessionId? } | null`. API keys (`X-Candy-API-Key`: CLI, SDK, local MCP) and public MCP tokens are always `superuser: false`. A portal login (`candy_portal` cookie, read only on portal hosts) gets `superuser` from `isSuperuser` (superuser.ts, sudoers, 60s cache) on every request; it is never stored.
- **`ROUTE_TABLE`** (next to the control server) classifies every control route as `public`, `user` or `superuser`. One guard (`classifyRoute` + `guardRequest`, portal-auth.ts) runs before any route on portal and control hosts; a route missing from the table is a 404. Adding a route means adding a table line; `test/route-table.test.ts` reads both and fails otherwise.
- **Hosts**: site hosts (`<name>.localhost/.candy`, action hosts, bound domains) never reach the control API; they get pages and lazy start (`serveSitePage`), plus `siteAction`: tunnel status, a bounded startup excerpt of its own log while starting or crashed (from `ManagedProcess.logStart`, so only this run's output), and start/restart with the site token (`siteTokens`) minted into that page. With a site token, start only starts a stopped site (no `configId`: a site with several commands is started from the portal) and restart only an errored or dead one; the site's tokens end when it becomes running (`dropName`). Never `/process/port` or the full log. Shortcut hosts (`<name>.k|kill` stops, `<name>.p|portal` tunnels) only 302 to `https://portal.<tld>/go/kill|portal?name=` (user routes): a confirmation page on GET, the action on POST with the page token. Terminal input and registering link to the portal (`/?logs=<name>`, `/?add=<name>`). The public MCP host, function hosts and `/candy-auth/*`, `/candy/*` are handled before the guard.
- **User routes are user-scoped**: check `mayChangeConfig(auth, config)` / `mayUse(name)` (= `mayChangeName`: the name's config user, else `routeUsers`, else the owner) and filter every list by it. Superuser = portal-only sudoer. The owner (`CANDY_OWNER`) has no extra rights.
- **CSRF**: state-changing portal requests need `Origin` (or `Referer`) on a portal host (`sameOrigin`) and the page's `X-Candy-Token`. Page tokens (`PageTokens`) are minted only for a portal login and tied to its session id; max 2 valid per page (current + previous).
- **Login**: `/login`, `/auth/users`, `/auth/login`, `/auth/logout`, `/auth/me`. `attemptLogin` (portal-auth.ts) does PAM (`verifyPassword`, pam.ts, in a child process) with `LoginSlots` (one attempt per user and per IP, 4 helpers overall), the attempt counted before PAM and refunded on success, Fibonacci grudges per non-loopback IP, `SoftLockout` (capped 30s) per user and for loopback, and equal-time (4.5s), equal-body failures. All of 127/8 and ::1 is one address (`loginKeys`). Answers that checked no password are 429s, never "wrong password": the address lockout, the user's soft delay (`retryAfter`), and full slots (`busy, try again`). Sessions: `PortalSessions` (portal-session.ts), hashed cookie + hashed session secret, 24h idle / 7d max, 20 per user. `requestAuth` re-checks `loginUsers` (60s cache) on every request.
- **Session secret**: the cookie alone never authenticates (browsers share it with every port of the host). `/auth/login` returns `session`, which portal-login.html keeps in `localStorage`; every portal request sends it as `X-Candy-Session` (`SESSION_FETCH_PATCH` patches the page's `fetch`). Navigating to a portal page (`PORTAL_PAGES`) gets `public/portal-shell.html`, which re-requests the page with the header and `document.write`s it: page tokens never go out on a plain navigation. EventSource can't send headers, so portal streams use `fetch`. CORS: exact portal origins only (`isPortalOrigin`); `isPortalHost` refuses any port but 443.
- **Client IP**: `X-Forwarded-For` / `Cf-Connecting-Ip` only from our Caddy, which tags what it sends the daemon with a per-boot `X-Candy-Proxy` value (`tagDaemonUpstreams`, `clientIp`). Direct :9999 callers get their socket address. `markProxyHeaders` runs first on every request: it records `viaOwnCaddy`, deletes the tag, and deletes `X-Forwarded-*` / `Cf-*` from anyone but Caddy. Forwarders (`fnRequestHeaders`, `upstreamRequestHeaders`) delete it again.
- **Portal host**: `isPortalRequest` = a portal Host, and `X-Forwarded-Host` (from our Caddy) is the same host, so a bound domain whose upstream is the portal isn't the portal. Every response on the portal host carries `frame-ancestors 'none'` and `X-Frame-Options: DENY` (`noFraming`).
- **Audit**: `auditLog` escapes control characters in every field. The actor is `auditActor(auth, X-Candy-Actor)` = `<user>:<label>` (`requestActor` in the control server); the header is only a label. Names can't start with `_` or `.`; `logFileFor` maps `_audit`/`_caddy` to the system logs (superusers) and a site name only to `<name>.log`.
- **Generated config**: every value written into the Caddyfile or cloudflared's YAML goes through `caddy-config.ts` checks (`isDnsLabel`, `isZoneName`, `isCaddyUpstream`, `checkBindings`, `cloudflaredYaml`); invalid bindings are dropped at load with `DOMAIN_BINDING_DROPPED`. `isCaddyUpstream` refuses this machine (`localhost`, `*.localhost`, `*.candy`, loopback, `ownAddresses()`) except the plain `localhost:<port>` / `127.0.0.1:<port>`. Blocks the daemon makes for itself carry `SYSTEM_BLOCK_MARK`; `dedupeSiteAddresses` keeps each address once (system first), and a skipped one is audited as `CADDY_SITE_SKIPPED`. `*.localhost` blocks get `bind 127.0.0.1 ::1` (`loopbackBind`). Bindings record `owner`; when their site is removed they're `orphaned`, still the owner's, and `boundToSomeoneElse` keeps others off the name.
- **Public MCP**: a grant records the approving `user` (mcp-oauth.ts); `handlePublicMcp` runs mcp.ts inside `publicMcpUser.run(user)` and `userScopedFetch` gives its daemon calls that user's key. Grants without a user are revoked on load (`legacyRevoked`, audited).

## MCP Tools

The MCP server exposes: `candy_servers`, `candy_start`, `candy_restart`, `candy_stop`, `candy_logs`, `candy_register`, `candy_deregister`, `candy_portal_open`, `candy_portal_close`, `candy_portals`, `candy_input`

Functions: `candy_fn_add`, `candy_fn_deploy`, `candy_fn_rollback`, `candy_fn_deploys`, `candy_fn_kv`, `candy_fn_d1`, `candy_fn_requests`, `candy_fn_request`

## Multi-user and API mode

- The systemd unit runs the daemon as root with `CANDY_OWNER=%i`. Members of the `candy` group get per-user secrets; servers run as the user who registered them (`ServerConfig.user`, launched with `setpriv`). Never start anything as root. See `launchSpec`, `requestAuth`, `mayChangeConfig` in daemon.ts.
- Per-user authorization: everyone sees and changes only their own sites; a superuser (a sudoer, logged in to the portal; never the CLI/SDK/MCP) sees and manages everything and changes daemon-wide settings. Running a site as another account is portal-superuser only; API keys run as themselves.
- Root mode launches go through `systemd-run` (`sandbox.ts`, `launchSpec`): read-only filesystem except the code folder, `/var/lib/candy/<name>` and a private `/tmp`; unit bound to the daemon's unit. Stop with `systemctl stop <unit>` (`managed.unit`), not a process-tree kill. `ServerConfig.sandbox === false` opts out; `ServerConfig.rw` adds writable paths. Every unit gets `MemoryMax` (2G default, `ServerConfig.memory` in MB up to 16G, `candy mem`; `memoryLimitMb` in sandbox.ts caps it).
- `ServerConfig.api`: every request for the server's host (bound domain, `<name>.localhost`/`.candy`), whatever its method or path, is held while a stopped server starts and forwarded 1:1 (`api-mode.ts`, `apiModeGate`), never a loading page or a daemon route. The gate runs in `controlFetch` before anything that matches a path; keep it there (`test/api-mode.test.ts`). Failures are 503 + `Retry-After`. Only `/candy-auth/check` and `POST /candy-auth/login` on a protected bound domain stay candy's.

## Public MCP endpoint

Optional (`domainConfig.mcp`, off by default): `https://<sub>.<zone>/mcp` serves `handleRequest` from mcp.ts over HTTP behind OAuth 2.1 (`mcp-oauth.ts`, pure logic). Consent happens only on the portal host (`/oauth/*`, tailnet) and needs a portal login; tokens act as the approving user, user-scoped. See `handlePublicMcp` in daemon.ts. The public host must never reach any other daemon route.

## TODO

- The owner account is effectively root: the systemd unit runs the owner's own checkout with bun as root, and hands `~/.config/caddy` back to the owner. So "the owner has no extra rights" is about the portal/CLI/MCP permission model, not host security.
- Caddy still runs as root (it binds :80/:443). Its admin API is now a 0600 root-owned unix socket, but running Caddy itself unprivileged (`CAP_NET_BIND_SERVICE`, its own user) is still to do.

## Reserved Names

Cannot be used for server names: `portal`, `p`, `kill`, `k`, `candy`, or anything starting with `_` or `.`. A new name also can't have a `kill`/`k`/`portal`/`p` label or end in `.<hostLabel>` (`newNameProblem`): those are shortcut and alias hosts.

Names are lower case. `lowerRequestNames` lower-cases `name`/`oldName`/`newName`/`serverName`/`targets` in bodies and `?name=` for every control route, path names are lower-cased where they're read, and `isSafeName` accepts lower case only. Stored names are lower-cased at load (`lowerCaseNames`, `NAME_LOWERCASED`); when two spellings meet, the first in the file stays and the others are dropped (`NAME_DROPPED`).

## Dependencies

Runtime: Bun, Caddy. Optional: `cloudflared` (tunnels), `ripgrep` (log search).

No external npm packages - uses pure Bun stdlib.
