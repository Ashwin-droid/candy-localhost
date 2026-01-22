# candy-localhost

Lazy dev server orchestrator with MCP integration.

```text
You: visit myapp.localhost
candy: *spawns server* *detects port* here you go
```

A lazy-loaded dev server manager that spawns servers on-demand when you visit their `.localhost` domain.

## What It Does

- **Lazy Loading**: Configure servers once, start them by visiting `<name>.localhost`
- **Auto Port Detection**: Scans server output for port numbers and auto-binds routes
- **MCP Integration**: AI-accessible tools for managing servers, routes, and logs
- **Public Tunnels**: Expose local servers via Cloudflare tunnels
- **Process Management**: Start, stop, restart servers with crash recovery

## Requirements

- [Bun](https://bun.sh)
- [Caddy](https://caddyserver.com)
- (Optional) `cloudflared` for public tunnels
- (Optional) `ripgrep` for log search

## Install

```bash
bun install
```

## Run

Start the daemon:

```bash
bun run daemon
```

Or with auto-reload:

```bash
bun run dev
```

## Quick Start

### 1. Configure a server

Create `~/.config/candy/servers.json`:

```json
{
  "myapp": {
    "cwd": "~/projects/myapp",
    "cmd": "npm run dev"
  },
  "api": {
    "cwd": "~/projects/backend",
    "cmd": "python -m flask run"
  }
}
```

### 2. Visit the domain

Open `http://myapp.localhost` in your browser. candy will:

1. Spawn the process
2. Capture output and scan for ports
3. Auto-bind the route when a port is detected
4. Start proxying traffic

### 3. Manage via UI or MCP

- **Portal UI**: `http://portal.localhost`
- **Kill a server**: `https://myapp.kill.localhost` or `https://myapp.k.localhost`
- **MCP**: Use AI tools to manage everything

## MCP Setup

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "candy": {
      "command": "bun",
      "args": ["run", "mcp"],
      "cwd": "/path/to/candy-localhost"
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `candy_logs` | Read logs (tail, head, or search with pattern) |
| `candy_processes` | List all managed processes |
| `candy_start` | Start a server by name |
| `candy_stop` | Stop a running server |
| `candy_restart` | Restart a server |
| `candy_routes` | List all routes |
| `candy_route_add` | Add a route (name -> port) |
| `candy_route_remove` | Remove a route |
| `candy_portals` | List open tunnels |
| `candy_portal_open` | Open a public tunnel |
| `candy_portal_close` | Close a tunnel |
| `candy_config_list` | List server configurations |
| `candy_config_add` | Add a server configuration |
| `candy_config_remove` | Remove a configuration |
| `candy_status` | Get daemon status |

### Example MCP Usage

```
You: What processes are running?
AI: [calls candy_processes]

You: Search for errors in myapp logs
AI: [calls candy_logs with process="myapp", mode="search", pattern="error"]

You: Restart the api server
AI: [calls candy_restart with name="api"]
```

## Configuration Methods

### 1. servers.json (Recommended)

Edit `~/.config/candy/servers.json` directly:

```json
{
  "vite-app": {
    "cwd": "~/projects/vite-app",
    "cmd": "npm run dev"
  }
}
```

### 2. Web UI

Visit an unconfigured domain (e.g., `http://newapp.localhost`) to see the configuration form.

### 3. MCP

```
You: Add a server config for "frontend" at ~/projects/frontend with "pnpm dev"
AI: [calls candy_config_add]
```

## Process States

| State | Description |
|-------|-------------|
| `starting` | Process spawned, waiting for port detection |
| `running` | Port detected, route active, proxying traffic |
| `dead` | Process exited normally (exit code 0) |
| `errored` | Process crashed (non-zero exit code) |

## Port Detection

candy scans process output for 10 seconds using these patterns:

- IPv4: `0.0.0.0:3000`, `127.0.0.1:5173`
- IPv6: `[::]:3000`, `[::1]:5173`
- URLs: `http://localhost:3000`, `http://127.0.0.1:5173`

If exactly one port is detected, it auto-binds. Multiple ports show a selection UI.

## Kill Mechanism

Stop a server instantly by visiting:

- `https://myapp.kill.localhost`
- `https://myapp.k.localhost`

## Files

| Path | Purpose |
|------|---------|
| `~/.config/candy/servers.json` | Server configurations |
| `~/.config/caddy/Caddyfile` | Generated routes |
| `/tmp/candy-logs/<name>.log` | Process logs (cleared on boot) |
| `/tmp/candy-logs/_audit.log` | Operation audit log |

## HTTP API

All endpoints require `X-Candy-Token` header (obtained via `/session`).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/session` | POST | Create session, get token |
| `/processes` | GET | List managed processes |
| `/process/start/:name` | POST | Start a process |
| `/process/stop/:name` | POST | Stop a process |
| `/process/restart/:name` | POST | Restart a process |
| `/configs` | GET | List server configs |
| `/config` | POST | Add server config |
| `/config/:name` | DELETE | Remove config |
| `/routes` | GET | List routes |
| `/register` | POST | Add route |
| `/register/:name` | DELETE | Remove route |
| `/portals` | GET | List tunnels |
| `/portal` | POST | Open tunnel |
| `/portal/close/:name` | POST | Close tunnel |
| `/stream/:name` | GET | SSE log stream |
| `/status` | GET | Daemon status |

## License

WTFPL
