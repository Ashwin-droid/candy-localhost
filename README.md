# candy-localhost

We hand out domains like it's 1980.

```text
App: "hey can I get a domain?"
candy-localhost: "sure bestie, you're vite.localhost now"
```

A tiny local "registry" that maps `name.localhost` → `localhost:port`.

## What It Does

- Runs a control plane on `http://localhost:9999`.
- Uses Caddy as the reverse proxy so `http://<name>.localhost` forwards to your local port.
- Provides a web UI (served via the same control plane) for claiming unallocated `*.localhost` names.
- Optionally opens public tunnels for a domain (via `cloudflared`).

## Requirements

- Bun
- Caddy
- (Optional) `cloudflared` for tunnels
- Port 80 available (Caddy binds HTTP)
- A modern browser/OS (most environments resolve `*.localhost` automatically)

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

Or watch mode:

```bash
bun run dev
```

When running, the app manages a Caddyfile in your local app data directory and reloads Caddy via its admin API.

## Usage

### Web UI

- Open `http://anything.localhost`.
- Enter the port you want to claim.
- After registration, visit `http://<name>.localhost` and it should proxy to your app.

### CLI (interactive)

Run the app, then use the prompt:

```text
> add <name> <port>
> rm <name>
> rename <old> <new>
> ls
> portal [name] <port>
> portals
> close <name>
> traffic <name> [count]
> logs
> detach
> exit
```

Type `help` in the app for the full command list.

### HTTP API (automation)

Register a route:

```bash
curl -X POST http://localhost:9999/register \
  -H "Content-Type: application/json" \
  -d '{"name":"vite","port":5173}'
```

List routes:

```bash
curl http://localhost:9999/routes
```

Remove a route:

```bash
curl -X DELETE http://localhost:9999/register/vite
```

Open a tunnel:

```bash
curl -X POST http://localhost:9999/portal \
  -H "Content-Type: application/json" \
  -d '{"name":"vite","port":5173,"openBrowser":true}'
```

List tunnels:

```bash
curl http://localhost:9999/portals
```

## Files & Persistence

- Routes persist to your Caddyfile (managed by the app).
- Access logs are written by Caddy to an `access.log` in the same local app data directory.

## Notes

This is a local-dev toy with intentionally minimal guardrails: the control plane API is unauthenticated and built for convenience.

## License

WTFPL
