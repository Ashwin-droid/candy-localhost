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

Auto-kill: daemon parses Caddy access logs every 30 minutes and stops processes idle for >1 hour (unless they have an active portal).

### Port Detection

Scans process stdout/stderr for ports in range `1024–65535`:

- Socket forms: `0.0.0.0:3000`, `127.0.0.1:5173`, `[::]:3000`, `[::1]:5173`
- URL forms: `http://localhost:3000`, `http://127.0.0.1:5173`

One port detected → auto-bind. Multiple → manual selection required via UI or API.

### Variant Configs

A server name can have multiple configurations (different cwd/cmd). Only one variant runs at a time — starting a different variant stops the active one.

### Reserved Names

`portal`, `k`, `kill`, `p` — cannot be used as server names.

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

| Tool | Arguments | Description |
|------|-----------|-------------|
| `candy_servers` | — | List all servers with status, port, PID |
| `candy_start` | `name` | Start a server |
| `candy_stop` | `name` | Stop a server |
| `candy_restart` | `name` | Restart a server |
| `candy_logs` | `name`, `mode?`, `lines?`, `pattern?` | Read logs (tail/head/search) |
| `candy_register` | `name`, `cwd`, `cmd` | Register a server config |
| `candy_deregister` | `name` | Remove a server config |
| `candy_portal_open` | `name`, `port?` | Open a tunnel |
| `candy_portal_close` | `name` | Close a tunnel |
| `candy_portals` | — | List active tunnels |
| `candy_input` | `name`, `input?`, `key?` | Send PTY input to server |
| `candy_domain` | `action`, `subdomain?`, `serverName?`, `force?`, `zone?`, `tunnel?` | Domain management |
| `candy_route` | `action`, `name?`, `port?`, `persistent?` | Route management (`add`, `remove`, `list`, `lan_publish`, `lan_unpublish`); `https?` with `lan_publish` |

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
- **API key** (`X-Candy-API-Key`): obtained via `POST /mcp/auth` with bootstrap secret from `~/.config/candy/mcp-secret`

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

Apps that refuse self-signed certificates (password managers, mobile apps) can use this machine's Tailscale hostname instead:

```bash
candy lan publish vault --https=9443   # -> https://<host>.<tailnet>.ts.net:9443
candy lan publish vault --no-https
```

- Caddy serves `https://<host>.<tailnet>.ts.net:<port>` on the **LAN IP only**, with a Let's Encrypt certificate fetched from `tailscaled` (`get_certificate tailscale`).
- `candy-dns`'s LAN view answers the ts.net hostname with the LAN IP (A record; other types get NODATA). The tailnet view doesn't answer it.
- The Tailscale IP is left alone. On the tailnet, MagicDNS resolves the hostname to the Tailscale IP, so to give tailnet devices the same URL, serve the same port there with `tailscale serve --https=<port> http://127.0.0.1:<app port>`. The same URL then works at home and on the tailnet, and nothing is exposed to the internet.

One-time setup:

- Caddy runs as your user, so it needs `tailscaled` access for certificates: `sudo tailscale set --operator=$USER`.
- The front resolver must send LAN clients' queries for the hostname to the LAN listener. With AdGuard Home, add `[/<host>.<tailnet>.ts.net/]127.0.0.1:5336` to the LAN persistent client's upstreams, next to the `.candy` one.
- Devices with their own DNS (Android Private DNS, DoH in the browser) skip the LAN resolver and won't see the LAN address.

## Domain Binding (Cloudflare)

Requires `~/.config/candy/domains.json` with zone and tunnel configuration.

**Bind flow:** validate server exists → check existing DNS records → run `cloudflared tunnel route dns` → persist binding → regenerate ingress config → restart cloudflared

**Unbind flow:** delete DNS records via CF API → remove binding → regenerate ingress → restart cloudflared

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

Template unit runs as the specified user, sets `cap_net_bind_service` on Caddy before start. `install-service.sh` fills in the repo, Bun and Caddy paths for your machine (`./install-service.sh daemon --print` to preview).

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
| `~/.config/candy/lan.json` | Names published to the LAN, and their ts.net HTTPS ports |
| `~/.config/candy/domains.json` | Domain binding config (zone, tunnel, bindings) |
| `~/.config/candy/candy-grudge.lock` | Bound-domain auth grudge state |
| `~/.config/candy/mcp-secret` | MCP auth bootstrap secret |
| `~/.config/candy/candy-dns.json` | DNS daemon config |
| `~/.config/caddy/Caddyfile` | Generated Caddy config |
| `~/.config/caddy/access.log` | Caddy access log |
| `~/.config/caddy/caddy.log` | Caddy process stdout/stderr |
| `~/.config/caddy/candy.pid` | Daemon PID |
| `/tmp/candy-logs/<name>.log` | Process logs (cleared on daemon start) |
| `/tmp/candy-logs/_audit.log` | Operation audit log |
| `/tmp/candy-logs/_dns.log` | DNS daemon log |

## Testing

```bash
bun test
```

Current test: regression preventing redirects to `http://localhost:<port>` (ensures routing stays domain-based).

## License

GPL-3.0
