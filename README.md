# candy-localhost

A lazy-loaded dev server orchestrator. Configure your servers once, then visit `<name>.localhost` in your browser — candy spawns the process, detects the port, and starts proxying through Caddy.

## About

candy-localhost replaces the workflow of manually starting dev servers, remembering ports, and juggling terminal windows. Instead, you register a server once (name + directory + start command), and from then on just visit `myapp.localhost`. candy handles the rest: spawning the process, detecting the port from stdout, configuring the reverse proxy, and tearing it down when idle.

### Design Intentions

- **Lazy by default.** Servers start on first browser request and auto-stop after idle timeout. No background processes burning resources.
- **Multiplayer by design.** Multiple MCP clients, CLI sessions, and browser tabs can connect simultaneously. Log streams (SSE) are shared — everyone sees the same output in real time.
- **Multi-agent by default.** Any agent that supports MCP can manage servers. Multiple agents can observe the same logs and collaborate on the same running processes.
- **Persistent browser sessions.** Because routing is domain-based (`myapp.localhost`), cookies, localStorage, and service workers persist across server restarts regardless of which port the process binds to.
- **Host-based routing.** Each server gets its own `.localhost` domain with automatic TLS via Caddy. No port numbers to remember.
- **Zero-config tunnels.** Expose any local server publicly with one command via Cloudflare Quick Tunnels.
- **Tailscale-aware.** When a Tailscale IP is detected, servers are also available on `<name>.candy` from any device on the tailnet.

## Quickstart

### Requirements

- [Bun](https://bun.sh)
- [Caddy](https://caddyserver.com) **2.7 or newer** — use the [official packages](https://caddyserver.com/docs/install); distro builds like Ubuntu's 2.6.2 fail with `listen udp :443: address already in use` when Tailscale is active
- `cloudflared` (optional — for public tunnels and domain binding)
- [Tailscale](https://tailscale.com) (optional — for `.candy` TLD access across your tailnet)

### Install and Run

```bash
git clone https://github.com/Ashwin-droid/candy-localhost.git
cd candy-localhost
bun install
bun link          # registers the 'candy' CLI globally
bun run daemon
```

After `bun link`, the `candy` command is available system-wide.

To use the SDK from another Bun project, link the package there too:

```bash
cd /path/to/your-app
bun link candy-localhost
```

### Register a Server

Create `~/.config/candy/servers.json`:

```json
{
  "myapp": {
    "cwd": "~/projects/myapp",
    "cmd": "npm run dev"
  }
}
```

Or use the CLI from your project directory:

```bash
candy dev npm run dev
```

### Use the SDK

For small one-off Bun apps, you can import the package directly after `bun link candy-localhost`:

```ts
import {
  checkRuntime,
  getLocalhostUrl,
  openPortal,
  registerPort,
  registerServer,
} from "candy-localhost"

const runtime = checkRuntime()

await registerServer({
  cwd: process.cwd(),
  command: "bun run dev",
  namespace: "myapp",
})

await registerPort({
  namespace: "myapp-api",
  port: 8787,
})

console.log(await getLocalhostUrl({ namespace: "myapp-api" }))

if (runtime.isCandyRuntime) {
  console.log(await getLocalhostUrl())
  console.log(await openPortal())
}
```

SDK behavior:

- `registerServer({ cwd, command, namespace })` registers a managed candy config, but no-ops safely when called from inside a candy-managed runtime.
- `checkRuntime()` reports whether the current process is running under candy by checking `X_CANDY_RUNTIME_MAGIC_STRING`.
- `getLocalhostUrl()` returns `https://<namespace>.localhost`, or resolves the current managed runtime automatically when called inside candy.
- `registerPort({ namespace, port })` registers an unmanaged route owned by the current PID.
- `openPortal()` only works for the calling runtime's managed config, or for a PID-owned route that the same process registered via `registerPort`.

From inside a server candy started, two more calls are available:

```ts
import { cronJob, setCron, setIdling } from "candy-localhost"

// Waiting for events, not serving anything: don't stop me for inactivity
// unless memory gets tight (>= 80% of RAM used, or high memory pressure).
await setIdling(true)

// Run this server's own command with extra args on a schedule (local time).
await setCron({ name: "sync", schedule: "*/15 * * * *", args: ["--sync"] })

if (cronJob() === "sync") {
  // this process was started by the "sync" job
}
```

- `setIdling(on = true)` marks the running server as idling until it stops or calls `setIdling(false)`. Open connections and recent requests still count as activity as usual.
- `setCron({ name, schedule, args?, timeoutSec? })` adds or replaces a job; `removeCron(name)` and `listCrons()` manage them. Schedules are 5-field cron or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.
- A cron run is the server's command plus `args`, as the server's user, in its directory, whether or not the server is running. The base command can't be changed, and `args` are passed as separate argv entries (`"$@"`), so `;`, `&&`, `|` or `$(...)` in them are plain text. A run that is still going when the next one is due is skipped, and runs are stopped after `timeoutSec` (default 1 hour). Output goes to `<logs>/cron/<name>.log`, and runs are recorded in the audit log (`CRON_RUN`, `CRON_EXIT`).

### Use It

Open `https://myapp.localhost` in your browser. candy spawns the process, detects the port, and starts proxying. To stop: visit `https://myapp.kill.localhost` or run `candy stop myapp`.

---

## Project Components

| Component | File | Purpose |
|-----------|------|---------|
| Daemon | `daemon.ts` | HTTP control plane on `:9999`, process manager, Caddy sync, portal/domain management |
| CLI | `cli.ts` | User-facing `candy` command with interactive PTY mode |
| SDK | `sdk.ts` | Importable Bun SDK for one-off projects and runtime-aware helpers |
| MCP Server | `mcp.ts` | JSON-RPC MCP server over stdio for agent integration |
| DNS Daemon | `candy-dns.ts` | UDP DNS for `.candy` TLD, resolves to Tailscale IP |
| UI Pages | `public/*.html` | Registration, startup progress, portal control, crash/kill pages |
| Protocol Handler | `candy-open.sh`, `candy-protocol.desktop` | `candy://` URL scheme |
| Service Units | `*.service` | systemd service files |

## Request and Routing Model

Caddy terminates local TLS (`tls internal`) and proxies traffic to managed process ports or back to the daemon on `:9999` for UI pages.

### Host Classes

| Host Pattern | Behavior |
|-------------|----------|
| `portal.localhost` | Dashboard UI |
| `<name>.localhost` | Proxied server (auto-starts if configured) |
| `<name>.kill.localhost` / `<name>.k.localhost` | Stop a running server |
| `<name>.portal.localhost` / `<name>.p.localhost` | Create/open a tunnel |
| `*.trycloudflare.com` | Tunnel traffic proxied back to local port |
| `<sub>.<zone>` | Bound domain via Cloudflare tunnel ingress |

All patterns have `.candy` equivalents when Tailscale is active.

### Process Lifecycle

| State | Description |
|-------|-------------|
| `starting` | Process spawned, scanning stdout for port (10 second window) |
| `running` | Port detected, route active, proxying traffic |
| `dead` | Process exited with code 0 |
| `errored` | Process crashed (non-zero exit) |

Auto-kill: a running server with no activity for more than 1 hour is stopped (checked every 5 minutes, recorded as `AUTO_KILL` in the audit log). Activity is any of:

- a finished request in Caddy's access log for `<name>.localhost`, `<name>.candy` or a bound domain
- an open TCP connection to the server's port, so SSE streams, WebSockets and long polls keep it alive however quiet they are
- a request the daemon proxies itself

Servers with an open portal are never stopped. A server that called `setIdling()` is kept past the hour until memory is tight (80% of RAM in use, or PSI memory pressure `some avg10` at 10 or more).

The daemon's own proxies (unprotected bound domains, API mode, first request to a stopped bound server) wait up to 30 seconds for response headers; after that the body can stream indefinitely.

### Port Detection

Scans process stdout/stderr for ports in range `1024–65535`:

- Socket forms: `0.0.0.0:3000`, `127.0.0.1:5173`, `[::]:3000`, `[::1]:5173`
- URL forms: `http://localhost:3000`, `http://127.0.0.1:5173`

One port detected → auto-bind. Multiple → manual selection required via UI or API.

### Sandbox

When the daemon runs as the root systemd service, every server and cron run is started with `systemd-run` as its own unit (`candy-<name>-<id>.service` in `candy.slice`), as the user the site runs as. The unit is bound to the candy service, so it stops when the daemon stops or dies.

Inside, the whole filesystem is read-only except three places:

| Writable | What it is |
|---|---|
| The code folder | The repository the start folder is in (nearest `.git`), or the start folder itself. Never the whole home |
| The state folder | `/var/lib/candy/<name>`, owned by the site's user, given to the app as `CANDY_STATE_DIR`. Survives restarts |
| `/tmp` | Private to the server and emptied when it stops |

Caches that would land in the read-only home are pointed at the state folder (`XDG_CACHE_HOME`, bun and npm caches). The unit also gets private devices, no capabilities, no privilege gain (`sudo` doesn't work inside), and protected kernel settings, clock and hostname. It keeps the user's UID and the host network: other local processes can still reach its port.

```bash
candy sandbox myapp --rw /srv/myapp-data   # one more writable folder
candy sandbox myapp --no-rw /srv/myapp-data
candy sandbox myapp off                    # run it unsandboxed (setpriv, as before)
candy sandbox myapp on
```

Changes apply at the next start. An app that fails with "Read-only file system" is writing outside those places: move that data to `CANDY_STATE_DIR`, or add the folder with `--rw`. Started by hand or as a normal user, the daemon doesn't sandbox anything.

### Variant Configs

A server name can have multiple configurations (different cwd/cmd). Only one variant runs at a time — starting a different variant stops the active one.

### API Mode

For servers called by programs rather than browsers. A request to a stopped API-mode server never gets the loading page: it is held while the server starts, then forwarded unchanged (method, path, query, headers, body), and the server's response comes back as-is. Requests that arrive together share one start. Once the port is detected, Caddy routes later requests straight to the server.

If the server exits first, the request gets `502` with JSON `{ "error", "exitCode" }`. If no port is detected within the port-detection window, it gets `504`; if several ports are detected, it gets `502` listing them.

```bash
candy dev bun run api.ts --api   # register in API mode
candy api <name> on|off          # toggle for an existing site
```

The portal has the same toggle in each site's menu.

### Env Files

```bash
candy env myapp /path/to/myapp.env   # KEY=VALUE lines, handed to the server as environment
candy env myapp off
```

The file is read at every launch, so the server doesn't have to read secrets from disk itself. Two kinds of file are accepted:

- one the server's user can read (checked as that user), or
- one root placed in `/etc/candy/env/<user>/` (both root-owned and not writable by anyone else). For a sandboxed server systemd reads it, so the file can be mode 600 root: the secrets reach the process but the user's other programs can't read the file.

Anything else is refused, so candy can't be used to read someone else's files. Values in the file override candy's own variables.

### Ports

candy learns a server's port from its output. A server that prints nothing recognisable is still found: after 1.5 seconds candy looks at which TCP ports the server's processes listen on (for up to a minute).

### Tailscale HTTPS (`candy route serve`)

```bash
candy route serve vault 9443   # https://<host>.<tailnet>.ts.net:9443, tailnet only, trusted certificate
candy route serve vault off
```

candy runs `tailscale serve` for the port and forwards it to the name's entry port (created if needed), so requests go through candy and can start a stopped server. A port that tailscale already serves for something else is refused. The port stays open while the server is stopped (the next request starts it) and is closed when you turn it off or delete the site. `candy lan publish <name> --https=<port>` (Tailscale mode) turns this on for the same port, so the URL is identical on the LAN and on the tailnet.

### Entry Ports

```bash
candy route entry vault 18222   # http://127.0.0.1:18222 always reaches "vault" through candy
candy route entry vault off
```

An entry port is a plain-HTTP port on loopback that reaches a name through candy whatever `Host` header is sent. Use it as the target for a local front end that can't set the host, such as `tailscale serve --https=9443 http://127.0.0.1:18222`. Pointing such a front end at the server's own port bypasses candy, so a stopped server (idle, crashed, API mode) would never be started by that traffic.

### Reserved Names

`portal`, `k`, `kill`, `p` — cannot be used as server names. Names may only use letters, numbers, dashes, underscores and dots.

### Route Types

Routes map `<name>.localhost` to a target. There are three kinds:

- **Auto-routes.** Created automatically when a managed process starts and a port is detected. Removed when the process stops (unless marked persistent).
- **Manual routes.** Created via `candy route add <name> <port>` or `POST /register`. Point a domain at a port or external URL without a managed process.
- **Persistent routes.** Any route created with `--persistent` (CLI) or `persistent: true` (API) survives daemon restarts. Stored in `~/.config/candy/routes.json`. Non-persistent routes exist only in memory.
- **External routes.** When `target` is an `http(s)` URL instead of a port number, the route proxies to an external service.

## CLI Reference

```
candy dev [cmd...]             Start dev server (uses saved config, or auto-detects from package.json)
candy dev <cmd> --name <name>  Register and run with custom route name
candy dev <cmd> --api          Register in API mode (hold the first request while starting, then forward it)
candy api <name> [on|off]      Turn API mode on or off
candy stop [name]              Stop server (current directory or by name)
candy status                   Show daemon status and all servers
candy logs [name]              Tail logs via SSE
candy portal [name]            Open Cloudflare Quick Tunnel
candy list                     List registered server configs
candy route add <name> <port>  Add manual route (--persistent to survive restarts)
candy route rm <name>          Remove a route
candy route                    List routes
candy lan                      List domains and whether each is published to the LAN
candy lan publish <name>       Make <name>.candy reachable from the LAN (opt-in)
candy lan unpublish <name>     Back to tailnet-only
candy lan publish <name> --https[=port]
                               Also serve https://<host>.ts.net:<port> on the LAN (trusted cert)
candy lan publish <name> --no-https
                               Drop the ts.net HTTPS site, keep <name>.candy on the LAN
candy domain list              List bound public domains
candy domain bind <sub> [--server <name>]  Bind subdomain (defaults serverName=subdomain)
candy domain unbind <sub>      Remove domain binding
candy domain config --zone <domain> --tunnel <name> [--tunnel-id <id>] [--credentials <path>]
candy mcp                      Start MCP server (stdio)
candy daemon                   Run daemon in foreground
candy help | -h                Show help
candy version | -v             Show version
```

### Interactive Dev Mode (`candy dev`)

| Key | Action |
|-----|--------|
| `p` | Manually set port |
| `o` | Open in browser |
| `t` | Open tunnel |
| `r` | Restart |
| `q` / `Ctrl+C` | Detach (server keeps running) |
| `Q` | Stop server and exit |
| Other keys/arrows | Forwarded to server PTY |

## MCP Tools

| Tool | What it does |
|------|--------------|
| `candy_servers` | List servers with status, port, PID, run-as user, API mode, variants (`configId`) and detected ports |
| `candy_start` / `candy_restart` / `candy_stop` | Control a server. `candy_start` takes `configId` when a name has several variants |
| `candy_logs` / `candy_input` | Read a server's output (tail, head, search) and type into its terminal |
| `candy_register` / `candy_deregister` | Add or remove a config. Register accepts `api` (API mode) and `user` (run-as account, owner only); deregister accepts `configId` to remove one variant |
| `candy_config` | `list` configs and variants, `users` (run-as accounts), `set_api` (API mode on/off), `set_port` (pick one of several detected ports), `set_sandbox` (sandbox on/off, extra writable folders), `set_env_file` |
| `candy_route` | `list`, `add` (port or URL `target`, `persistent`), `remove`, `rename`; LAN: `lan_list`, `lan_publish` (`https`: `true`, `false`, `"domain"` or `"tailscale"`, optional `port`), `lan_unpublish`; `entry` / `entry_list` (loopback entry ports), `serve` / `serve_list` (tailscale serve); AdGuard Home: `adguard_status`, `adguard_unlink` |
| `candy_domain` | Bound domains: `list`, `bind`, `unbind`, `config`; protection: `auth_status`, `auth_generate_jwt`, `auth_token` (`ttl`, `once`), `auth_clear` (`which`: password, jwt or all), `allowlist` (`add`, `remove`, `ips`, `enabled`); the public MCP endpoint: `public_mcp_status`, `public_mcp_on`, `public_mcp_off`, `public_mcp_revoke` |
| `candy_portal_open` / `candy_portal_close` / `candy_portals` | Cloudflare quick tunnels |
| `candy_status` | `status` (daemon and Caddy health), `stats` (requests per domain), `traffic` (recent requests for a name), `activity` (daemon activity log) |
| `candy_network` | The `.candy` registry across Tailscale machines |

Actions that change who can reach a site (`lan_publish`, `auth_clear`, turning an allowlist off or removing entries, `unbind`, opening a portal) tell the model to confirm with you first.

Secrets never pass through the model: set a site password with `candy auth set <subdomain>` and link AdGuard Home with `candy lan adguard`. The one exception is `auth_generate_jwt`, which returns the newly generated secret once.

### Public MCP endpoint (optional)

Off by default. When on, the same tools are served over HTTP at `https://candy.<your zone>/mcp` (MCP Streamable HTTP), so an AI client anywhere can use them, for example as a custom connector.

```bash
candy domain mcp on                 # or --subdomain <name>; also a switch in the portal
candy domain mcp                    # status and connected clients
candy domain mcp revoke [clientId]  # sign one client or everyone out
candy domain mcp off                # removes the address and signs everyone out
```

There is no password. Sign-in is OAuth 2.1, and Tailscale decides who gets in:

1. The client finds the OAuth endpoints from `/.well-known/oauth-protected-resource`, registers itself, and opens `https://candy.<zone>/authorize` in your browser.
2. candy parks the request and sends the browser to `https://portal.candy/oauth/consent`. That page exists only on your tailnet, so only a device your Tailscale ACLs let reach this machine can open it. It shows the client's name, where it will send you back, and who Tailscale says you are.
3. Pressing **Allow** sends the browser back to `https://candy.<zone>/authorize/complete` with a one-time grant, which candy exchanges for the authorization code the client redeems.

Details: PKCE (S256) is required; access tokens last 1 hour and live in memory only; refresh tokens rotate, last 30 days and are stored hashed in `~/.config/candy/mcp-oauth.json`; reusing an old refresh token signs that client out. The public host serves nothing but the OAuth endpoints and `/mcp`. Calls run as the owner and are recorded in the audit log (`MCP_PUBLIC_*`) with the client's name and who approved it.

A connected client can do what the portal can, including typing into server terminals, which means running commands on this machine. Approve only clients you trust.

### How MCP Integration Works

The MCP server (`mcp.ts`) runs over stdio and exposes candy's full control plane as MCP tools. Any MCP-compatible agent (Claude, Codex, etc.) can:

- Check which servers are running and their ports
- Start, stop, and restart servers by name
- Read and search process logs
- Open and close public tunnels
- Register new server configs
- Send PTY input to running processes

Because candy is multiplayer, multiple agents can connect simultaneously via separate MCP server instances. They all see the same daemon state and log streams — enabling collaborative workflows where one agent starts a server and another monitors its logs.

### MCP Quickstart

1. Add to your MCP client config (e.g. Claude Desktop, Cursor, Codex):

```json
{
  "mcpServers": {
    "candy": {
      "command": "candy",
      "args": ["mcp"]
    }
  }
}
```

2. The MCP server authenticates with the daemon automatically using the bootstrap secret in `~/.config/candy/mcp-secret` (generated on first daemon run).

3. Ask your agent to list servers, start a project, or check logs — it will use the candy tools automatically.

## HTTP API

Base URL: `http://localhost:9999`

### Authentication

Two auth modes:

- **Browser token** (`X-Candy-Token`): rolling token injected into rendered HTML, rotates on each request
- **API key** (`X-Candy-API-Key`): obtained via `POST /mcp/auth` with a bootstrap secret. Clients look in `$CANDY_SECRET_FILE`, `~/.config/candy/mcp-secret`, `/run/candy/users/<user>/secret`, then `/run/candy/secret`. Each API key belongs to the user whose secret it came from.

### Endpoints

#### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/token` | `{ token }` | Refresh rolling browser token |
| `POST` | `/mcp/auth` | `{ secret }` | Exchange bootstrap secret for API key |

#### Routes

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/register` | `{ name, port?, target?, persistent? }` | Add route (`target` with http(s) proxies to an external URL) |
| `DELETE` | `/register/:name` | — | Remove route and stop associated process |
| `POST` | `/rename` | `{ oldName, newName }` | Rename route |
| `GET` | `/routes` | — | List all routes |

#### LAN Publishing

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/lan` | — | Detected LAN IP and which names are published |
| `POST` | `/lan` | `{ name, publish, https?, port? }` | Publish (`true`, default) or unpublish (`false`) `<name>.candy` on the LAN. `https: true` also serves it at `https://<host>.ts.net:<port>` on the LAN (port auto-picked from 8443 up if omitted); `https: false` turns that off |

#### Processes

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/processes` | — | List managed processes |
| `POST` | `/process/start/:name` | `{ configId? }` | Start process (409 on multi-variant ambiguity) |
| `POST` | `/process/stop/:name` | — | Stop process tree (SIGTERM → SIGKILL) |
| `POST` | `/process/restart/:name` | — | Restart with overlap protection |
| `POST` | `/process/port/:name` | `{ port }` | Manual port bind |
| `POST` | `/process/input/:name` | `{ input?, key? }` | Send PTY input |

#### Configs

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/configs` | — | List server configs with variants |
| `POST` | `/config` | `{ name, cwd, cmd }` | Add config variant |
| `DELETE` | `/config/:name` | — | Remove all variants |
| `DELETE` | `/config/:name/:configId` | — | Remove specific variant |

#### Portals (Tunnels)

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/portal` | `{ name?, port?, openBrowser? }` | Open Quick Tunnel |
| `POST` | `/portal/batch` | `{ targets? }` | Open multiple tunnels |
| `GET` | `/portals` | — | List active tunnels |
| `GET` | `/portal/status/:name` | — | Poll tunnel creation status |
| `POST` | `/portal/close/:name` | — | Close tunnel |

#### Domains

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/domains` | — | List domain config and bindings |
| `POST` | `/domains/config` | `{ zone?, tunnel?, cfApiToken? }` | Configure zone/tunnel |
| `POST` | `/domains/bind` | `{ subdomain, serverName, force? }` | Bind subdomain + DNS + ingress sync |
| `DELETE` | `/domains/unbind/:sub` | — | Unbind + remove DNS records |

#### Logs and Stats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/logs` | Activity log entries |
| `GET` | `/logs/:name` | Process logs (tail/head/search) |
| `GET` | `/stream/:name` | SSE log stream |
| `GET` | `/stats` | Caddy traffic stats |
| `GET` | `/traffic/:domain` | Recent requests for domain |
| `GET` | `/status` | Daemon status |
| `POST` | `/shutdown` | Graceful daemon shutdown |

## Tailscale Integration

When Tailscale is installed and connected, candy automatically detects the machine's Tailscale IPv4 address and hostname metadata on daemon startup. candy uses `tailscale status --json` when available, with `tailscale ip -4` as a fallback for the local IPv4. This enables:

- **`.candy` TLD routing.** Every `<name>.localhost` route also becomes available at `<name>.candy`. Kill and portal subdomains work too (`<name>.kill.candy`, `<name>.portal.candy`).
- **Hostname fallback aliases.** Every route also gets a stable host-scoped alias such as `hello.pop-os.candy`, and action subdomains follow the same shape (`hello.k.pop-os.candy`, `hello.p.pop-os.candy`).
- **Cross-device access.** Any device on your tailnet can reach your dev servers by name — phone, laptop, VM, etc.
- **Host-aware network registry.** The candy network view shows which Tailscale host is advertising each route, plus the canonical and alias `.candy` names for every claim.
- **Caddy auto-config.** The generated Caddyfile includes `.candy` route blocks bound to the Tailscale IP alongside the `.localhost` blocks.
- **Opt-in LAN publishing.** Individual names can also be served to the local network. See [Publish to LAN](#publish-to-lan-opt-in).

If Tailscale is not installed or not connected, candy runs normally with `.localhost` only. No configuration needed — detection is automatic.

### DNS Daemon (`candy-dns.ts`)

A companion DNS daemon resolves `*.candy` queries to your Tailscale IP so the `.candy` TLD works from other devices:

- Binds UDP on `<tailscale-ip>:53`
- Answers `*.candy` A queries with the Tailscale IP (TTL 60)
- Non-`.candy` or unsupported queries return NXDOMAIN
- Watches `~/.config/candy/candy-dns.json` for config changes

Point your tailnet's DNS to this machine for the `.candy` zone, or configure per-device DNS to resolve `.candy` to the Tailscale IP.

`CANDY_DNS_HOST` / `CANDY_DNS_PORT` override the bind address when another resolver owns `:53` and forwards `candy` here.

### Publish to LAN (opt-in)

`.candy` is tailnet-only by default: names resolve to the Tailscale IP and Caddy serves them only on that address. A device on your local network that is not on the tailnet (a TV, a guest phone) cannot reach them.

Publishing a name changes that for that one name:

```bash
candy lan publish myapp     # or the LAN button on the route / server config in the portal
candy lan unpublish myapp
```

For a published name:

- Caddy also binds `<name>.candy` (and its host alias) to the machine's LAN IP. Kill/portal subdomains, the portal UI and every unpublished name stay Tailscale-only.
- `candy-dns` answers with the LAN IP, but only in its **LAN view**. Tailnet clients keep getting the Tailscale IP, so the name still works away from home.

The opt-in is stored per name in `~/.config/candy/lan.json`, applies to routes and server configs alike, and is dropped when the name is removed. The LAN IP is the source address of the default route (RFC 1918 only); set `CANDY_LAN_IP` to override.

A query is in the LAN view when:

- it comes straight from an RFC 1918 address (candy-dns bound to a LAN-reachable address), or
- it arrives on the dedicated LAN listener, enabled with `CANDY_DNS_LAN_PORT` (and optionally `CANDY_DNS_LAN_HOST`).

The second form is for a front resolver that hides the client address. Point the resolver's LAN clients at the LAN listener:

- **dnsmasq** serving only the LAN: `server=/candy/127.0.0.1#5336`
- **AdGuard Home** serving both LAN and tailnet: keep `[/candy/]127.0.0.1:5335` as the global upstream and add a persistent client for the LAN subnet (e.g. `192.168.0.0/24`) with upstream `[/candy/]127.0.0.1:5336` and its own upstream cache enabled. Without the per-client cache AdGuard Home stops caching for those clients.

```ini
# /etc/systemd/system/candy-dns.service.d/override.conf
[Service]
Environment="CANDY_DNS_HOST=127.0.0.1"
Environment="CANDY_DNS_PORT=5335"
Environment="CANDY_DNS_LAN_PORT=5336"
```

LAN devices see Caddy's internal CA, same as tailnet devices: trust the Caddy root certificate or accept the warning.

#### HTTPS with a trusted certificate (`--https`)

Apps that refuse self-signed certificates (password managers, mobile apps) need a real one. There are two modes:

```bash
candy lan publish vault --https            # bound domain if vault has one, else Tailscale
candy lan publish vault --https=domain     # https://vault.example.com
candy lan publish vault --https=tailscale  # https://<host>.<tailnet>.ts.net:<port>
candy lan publish vault --https=9443       # Tailscale mode on that port
candy lan publish vault --no-https
```

**Bound domain mode** (the default when the name has a [bound domain](#domain-binding-cloudflare)):

- Caddy serves `https://<fqdn>` on the **LAN IP only** (port 443), with a Let's Encrypt certificate. The HTTP-01 challenge reaches Caddy through the Cloudflare tunnel, so no DNS plugin or API token is involved.
- `candy-dns`'s LAN view answers the fqdn with the LAN IP. Everywhere else the name resolves to Cloudflare as before, so the same URL works at home and away.
- The LAN site has the same password/JWT protection as the public one. The IP allowlist doesn't apply to LAN devices; the LAN site only serves private and Tailscale addresses and drops everyone else.
- The front resolver must send LAN clients' queries for the domain's zone to the LAN listener (once per zone, e.g. `[/example.com/]127.0.0.1:5336`). `candy-dns` answers the bound names it serves and passes every other name in the zone to a public resolver (`CANDY_DNS_UPSTREAM`, default `1.1.1.1,8.8.8.8`), so the rest of the zone keeps working. See [AdGuard Home](#adguard-home) to have candy add the line itself.

**Tailscale mode** (the default otherwise):

- Caddy serves `https://<host>.<tailnet>.ts.net:<port>` on the **LAN IP only**, with a Let's Encrypt certificate fetched from `tailscaled` (`get_certificate tailscale`).
- `candy-dns`'s LAN view answers the ts.net hostname with the LAN IP (A record; other types get NODATA). While nothing is published over HTTPS on it, the LAN view passes ts.net lookups to Tailscale's resolver (`100.100.100.100`), so a front-resolver rule for the hostname can stay in place. The tailnet view doesn't answer it.
- Caddy never binds the Tailscale IP for this. On the tailnet, MagicDNS resolves the hostname to the Tailscale IP, where candy runs `tailscale serve` on the same port (see `candy route serve`). The same URL then works at home and on the tailnet, and nothing is exposed to the internet.
- One-time setup: Caddy needs `tailscaled` access for certificates (`sudo tailscale set --operator=$USER`), and the front resolver must send LAN clients' queries for the hostname to the LAN listener (`[/<host>.<tailnet>.ts.net/]127.0.0.1:5336`, or let candy add it, below).

In both modes, devices with their own DNS (Android Private DNS, DoH in the browser) skip the LAN resolver: in Tailscale mode they won't see the LAN address, in bound domain mode they simply go out through Cloudflare.

#### AdGuard Home

A resolver in front of candy-dns can't simply be bypassed: it hides the client address, and putting candy-dns in front of it would hide every device from the resolver instead. So the split happens in AdGuard Home's per-client upstreams, and candy can keep those lines in place for you:

```bash
candy lan adguard setup --url http://127.0.0.1:3000 --user admin --client "LAN"
candy lan adguard          # status
candy lan adguard off      # removes the lines candy added and forgets the login
```

`setup` asks for the password and checks it. From then on, whenever LAN HTTPS is turned on or off, candy makes sure the named persistent client forwards the ts.net hostname (Tailscale mode) and the bound domains' zone (bound domain mode) to the LAN listener (`--dns`, default `127.0.0.1:5336`). It only removes lines it added itself. The login is stored in `~/.config/candy/adguard.json` (mode 600).

## Domain Binding (Cloudflare)

Requires `~/.config/candy/domains.json` with zone and tunnel configuration.

**Bind flow:** validate server exists → check existing DNS records → run `cloudflared tunnel route dns` → persist binding → regenerate ingress config → restart cloudflared

**Unbind flow:** delete DNS records via CF API → remove binding → regenerate ingress → restart cloudflared

### Protecting a public domain

- **Browser sites:** a password gives a login page and a cookie session (`candy auth set <domain>`).
- **API-mode sites:** there is no login page. Every request carries credentials, which candy strips before the app sees the request. `Authorization` is left free for the app's own auth unless it holds candy's Basic credentials.
  - **Password:** `X-Auth-Token: <password>`, `X-Candy-Auth: <password>`, or HTTP Basic (any username).
  - **JWT:** HS256/384/512, signed with the domain's secret, sent in `X-Auth-Token` or `X-Candy-Auth`. Set a secret with `candy auth set <domain> --jwt` (generated and shown once), or mint a test token with `candy auth token <domain> [--ttl s] [--once]`. Claims:
    - `aud`: `"Candy API Authorization Service"`
    - `sub`: `"<site>.candy"`
    - `exp`: required, at most one hour away
    - `nbf`: optional
    - `iat`: required. Must be no earlier than 5s before the server started (or before now, when the request is what starts it), and after the server last went down.
    - `jti`: optional. Makes the token single-use, using a per-site Bloom filter of `sha3-512(jti)` that is cleared when the server stops.
- **Lockout:** 3 failed attempts lock a client out for Fibonacci hours (1, 1, 2, 3, 5…), per domain. Login pages count per IP + user agent; API sites count per IP, so one bad caller doesn't block others. Expired, replayed or wrong-`sub` tokens with a valid signature don't count. A success resets the count.
- **Allowlist mode:** `candy domain allow <sub> <ip|cidr>...` (or `--on` / `--off` / `--rm`). Caddy drops every other address without a reply, before any auth check or upstream connection. Tailscale addresses and this machine are always allowed. Through the tunnel, the visitor's IP comes from `Cf-Connecting-Ip`, which is trusted only from loopback (cloudflared).

## UI Pages

| Page | Purpose |
|------|---------|
| `portal.html` | Dashboard (routes, processes, configs, portals, bound domains) with a log viewer that passes keystrokes to the process |
| `candy.html` | Registration page (quick route mode + lazy server config mode) |
| `starting.html` | Startup progress with live log SSE, manual port assignment, variant chooser |
| `crashed.html` | Crash page with recent logs and restart action |
| `killed.html` | Kill confirmation page |
| `portaling.html` | Tunnel creation progress with polling and redirect |
| `login.html` | Password prompt for protected bound domains |
| `blocked.html` | Access denied page shown while an IP is locked out after failed logins |

## Protocol Handler

`candy://` URL scheme:

| URL | Opens |
|-----|-------|
| `candy://portal` | `https://portal.localhost` |
| `candy://routes` / `candy://list` | `https://portal.localhost/#routes` |
| `candy://stats` / `candy://status` | `https://portal.localhost/#stats` |
| `candy://<name>` | `https://<name>.localhost` |

Install: `xdg-mime default candy-protocol.desktop x-scheme-handler/candy`

Note: `candy-protocol.desktop` contains a hardcoded `Exec=` path — edit if installed elsewhere.

## systemd Setup

### Daemon Service

```bash
bun run install-service
sudo systemctl enable --now candy-localhost@$USER
```

The template unit runs the daemon as root, with the instance name as the **owner**: state lives in the owner's `~/.config/candy`, and the web portal acts as them. `install-service.sh` fills in the repo, Bun and Caddy paths for your machine (`./install-service.sh daemon --print` to preview).

### Multiple Users

Add people to the `candy` group to let them use the daemon:

```bash
sudo groupadd --system candy
sudo usermod -aG candy alice
```

Each member gets a secret at `/run/candy/users/<user>/secret` that only they can read (checked every minute, so no restart is needed). Servers a user registers run as that user via `setpriv`, starting in their cwd with their `$HOME`. Nothing is ever started as root.

- The owner can add a site that runs as any group member (the portal's **Run as** picker, or `user` on `POST /config`); `~` in its folder means that user's home. Other members can only add sites that run as themselves. Root is never offered.
- Only a server's own user can type into its terminal, change its API mode, or remove it (the owner can also remove any).
- Anyone in the group can start, stop and restart any server; it still runs as its own user.
- Only the owner can change the Cloudflare domain config or shut the daemon down.
- The web portal acts as the owner, and anyone who can reach `localhost:9999` can use it.
- Process logs move to `/var/log/candy` (root-owned) and are readable by all local users.

Run as a normal user instead (`bun run daemon`), everything runs as that user. If a `candy` group exists, the secret is also written to `/run/candy/secret` for the group.

### DNS Service

```bash
bun run install-dns-service
sudo systemctl enable --now candy-dns
```

Runs as the installing user with `CAP_NET_BIND_SERVICE` for port 53 — not root, so it shares `/tmp/candy-logs` with the daemon. Paths are filled in by `install-service.sh`.

## Configuration Files

| Path | Purpose |
|------|---------|
| `~/.config/candy/servers.json` | Server configurations (name → variants) |
| `~/.config/candy/routes.json` | Persistent routes |
| `~/.config/candy/lan.json` | Names published to the LAN, and their HTTPS mode (ts.net port or `"domain"`) |
| `~/.config/candy/mcp-oauth.json` | Public MCP endpoint: registered clients and hashed refresh tokens (mode 600) |
| `~/.config/candy/entries.json` | Entry ports (name → loopback port) |
| `~/.config/candy/serves.json` | Names served on the ts.net hostname (name → HTTPS port) |
| `/etc/candy/env/<user>/` | Root-placed env files for that user's servers |
| `~/.config/candy/adguard.json` | AdGuard Home login and the upstream lines candy manages (mode 600) |
| `~/.config/candy/domains.json` | Domain binding config (zone, tunnel, bindings) |
| `~/.config/candy/candy-grudge.lock` | Bound-domain auth grudge state |
| `~/.config/candy/mcp-secret` | MCP auth bootstrap secret |
| `~/.config/candy/candy-dns.json` | DNS daemon config |
| `~/.config/caddy/Caddyfile` | Generated Caddy config |
| `~/.config/caddy/access.log` | Caddy access log |
| `~/.config/caddy/caddy.log` | Caddy process stdout/stderr |
| `~/.config/caddy/candy.pid` | Daemon PID |
| `/run/candy/users/<user>/secret` | Per-user bootstrap secret (root mode) |
| `/var/lib/candy/<name>/` | A sandboxed server's state folder (`CANDY_STATE_DIR`) |
| `/var/log/candy/<name>.log` | Process logs when run as root (cleared on daemon start) |
| `/tmp/candy-logs/<name>.log` | Process logs when run as a normal user |
| `/tmp/candy-logs/_audit.log` | Operation audit log (`/var/log/candy` as root) |
| `/tmp/candy-logs/cron/<name>.log` | Cron run output (`/var/log/candy/cron` as root) |
| `/tmp/candy-logs/_dns.log` | DNS daemon log |

## Testing

```bash
bun test
```

Current test: regression preventing redirects to `http://localhost:<port>` (ensures routing stays domain-based).

## License

GPL-3.0
