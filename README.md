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
- **Functions without ports.** Workers-style modules (Hono works as is) run per request and exit when idle. The daemon hands them requests over its own socket and logs every one. See [candy-functions](#candy-functions).
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
| Functions | `fn-*.ts` | candy-functions: frame protocol, dispatcher, instance pool, host shim, bindings, cron, deploys, request log |

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

Auto-kill: a running server with no activity for more than 1 hour is stopped (checked every 30 seconds, recorded as `AUTO_KILL` in the audit log). Activity is any of:

- a finished request in Caddy's access log for `<name>.localhost`, `<name>.candy` or a bound domain
- an open TCP connection to the server's port, so SSE streams, WebSockets and long polls keep it alive however quiet they are
- a request the daemon proxies itself

A server can have its own idle limit, for something you only need up briefly (a password vault, an admin tool):

```bash
candy ttl vault 10    # stop after 10 minutes without activity
candy ttl vault off   # back to the default hour
```

Activity is counted the same way, so an open connection still keeps it up. The check runs every 30 seconds.

### Memory limit

Every sandboxed server, function and cron run has a hard memory limit: 2G unless you set another, and never more than 16G. Past its limit the server is killed (it shows as crashed; an API-mode server starts again on the next request).

```bash
candy mem vault 4G     # 64M to 16G; a bare number is MB
candy mem vault off    # back to the default 2G
```

A running server takes the new limit at once. Servers that run without the sandbox have no limit. The portal shows each site's limit, and what a running site is using.

### System monitor

For a superuser, the portal's **System** button opens a monitor for the whole machine, not only candy's sites: CPU (with per-core load), memory, disks, network rates, every process and every service, refreshed every two seconds. It can end or kill a process and restart, stop or start a service, with the daemon's own rights (root, when installed as a service). Each action is confirmed first and written to the audit log.

It is only available from a superuser's portal login: not to other users, and not through the CLI, SDK or MCP. It refuses to touch process 1, kernel threads, candy's own daemon and the units the system can't run without.

Servers with an open portal are never stopped for idleness. A server that called `setIdling()` is kept past the hour until memory is tight (80% of RAM in use, or PSI memory pressure `some avg10` at 10 or more).

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

Every request for an API-mode server's host (its bound domain, `<name>.localhost`, `<name>.candy`) belongs to the server, whatever the method or path: `/oauth/token`, `/auth/login` and `/candy/…` reach the server, not candy. A request to a stopped server waits up to 90 seconds for it to start (`CANDY_API_HOLD_SECONDS` in the daemon's environment, minimum 60), and any number of requests wait on the same start. If the server can't be reached, candy replies `503` with `Retry-After`. On a password-protected bound domain, candy keeps `/candy-auth/check` and `POST /candy-auth/login`.

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

## candy-functions

A function is a plain JS/TS module with a Workers-style default export, a folder of static files, or both. candy runs it on demand at `<name>.localhost`, with the same lifecycle as any other site (sandbox, env files, cron, `.candy`, LAN, bound domains, tunnels, logs, MCP, portal), minus the port.

```ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return new Response(`hi from ${new URL(req.url).pathname}`)
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(env.KV.put("last-run", String(event.scheduledTime)))
  },
}
```

No build step in dev: candy imports the source as it is.

### Portless

A function never listens on a TCP port or a socket of its own. Caddy sends its hosts to the daemon, the daemon picks the function by `Host` and hands each request to it over a socket the daemon owns (`/run/candy/fn/<name>.sock`, or `$XDG_RUNTIME_DIR/candy/fn/<name>.sock` as a normal user). The function process **dials in** with a per-instance token, takes requests as length-prefixed frames, and streams the responses back. Bodies stream both ways, so SSE and large uploads work, and a client that disconnects aborts `req.signal`.

So there's no port detection, nothing for other local processes to connect to, and the daemon sees and gates every request: auth, activity, holding while it starts, and the request log below.

### TTL 0, and hot instances

- **No request, no process.** The first request starts an instance and is held until it's ready (about 30–50 ms for Bun to boot and import), then dispatched.
- **An instance exits once it has been idle for `linger` seconds** (default 30, `0` = right away): idle means nothing in flight and every `ctx.waitUntil` settled, and a request during the linger is served warm. The hour-long idle rule and `candy ttl` don't apply.
- Requests that arrive while an instance is alive share it (up to 32 at once each). Another instance starts only when every live one is full, up to `max` (default 4).
- **`hot: N`** keeps N instances warm all the time, restarted if they exit or crash. Use it when the cold start matters. Instances above N still exit when idle.
- Each cold instance imports the current source, so in dev an edit shows up on the next request.

Set hot, max, linger and the request log from the function's **Function** panel in the portal, with `candy fn set <name> --hot n --max n --linger s --log full|meta|off`, or with `POST /fn/settings`.

### Bindings

Project config is read from the function's folder, first match wins: `candy.fn.json`, then `wrangler.jsonc` / `wrangler.json` / `wrangler.toml`. Only this subset is used; anything else is ignored with a warning:

```jsonc
{
  "main": "src/index.ts",
  "vars": { "GREETING": "hi" },
  "kv_namespaces": [{ "binding": "KV" }],
  "d1_databases":  [{ "binding": "DB" }],
  "triggers": { "crons": ["*/5 * * * *"] }
}
```

| Binding | What you get |
|---|---|
| `vars` | Plain strings on `env` |
| Secrets | Keys from the site's env file (`candy env <name> <file>`), merged on top of `vars`. Never written into a deploy snapshot |
| KV | `get` (`text` / `json` / `arrayBuffer` / `stream`), `getWithMetadata`, `put` with `expiration` / `expirationTtl` / `metadata`, `delete`, `list({ prefix, limit, cursor })`. Stored in `kv.sqlite` |
| D1 | `prepare(sql).bind(...).first() / all() / run() / raw()`, `batch`, `exec`, `dump`, with D1's result shape. One SQLite file per binding (`d1-<binding>.sqlite`) |
| Cron | `triggers.crons` become candy cron jobs that call `scheduled()` in a one-shot instance |
| `ctx` | `waitUntil(promise)` keeps the instance alive until it settles; `passThroughOnException()` is a no-op |

KV and D1 live in the function's state folder (`/var/lib/candy/<name>` in root mode, `~/.local/state/candy/fn/<name>` as a normal user). Instances share them through SQLite WAL. Bun's own `fetch`, `crypto.subtle` and `HTMLRewriter` are there too. Not in v1: Durable Objects, R2, Queues, the Cache API and `request.cf`. Static assets are supported, see below.

### Static assets

Same config and behavior as [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/). Put an `assets` block in `candy.fn.json` or `wrangler.*`:

```jsonc
{
  "main": "src/index.ts",                  // optional when assets are set
  "assets": {
    "directory": "./dist",                 // required
    "binding": "ASSETS",                   // optional: env.ASSETS.fetch(req) inside the function
    "not_found_handling": "single-page-application", // "none" (default) | "404-page" | "single-page-application"
    "html_handling": "auto-trailing-slash",          // | "force-trailing-slash" | "drop-trailing-slash" | "none"
    "run_worker_first": ["/api/*"]         // boolean, or route patterns; "!" excludes
  }
}
```

**A SPA with an API: use `run_worker_first`.** With `"not_found_handling": "single-page-application"`, every unknown path gets `/index.html`, including a browser navigation to `/api/me`, and an `/api/*` path that happens to match a file is served as that file. `"run_worker_first": ["/api/*"]` sends every `/api/*` request to your code before any asset lookup, SPA fallback or `_redirects` rule, while everything else stays asset-first:

```jsonc
{
  "main": "src/api.ts",                    // e.g. a Hono app with app.get("/api/me", ...)
  "assets": {
    "directory": "./dist",                 // your Vite/React build
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "!/api/docs/*"]   // /api/docs/* goes back to the files
  }
}
```

- `true` means always worker first; the code then serves files with `env.ASSETS.fetch(req)`.
- Patterns match the path only (no query). `*` matches anything, `/` included; a pattern without `*` is an exact path. `!` patterns exclude and win over inclusions. Patterns must start with `/` or `!/` (at most 100), and a bad one fails `candy fn add` / deploy instead of being ignored.
- Patterns are literal: `"/api/*"` doesn't match `/api` itself. Tip: `["/api", "/api/*"]` sends both to your code.

**Routing order**, decided by the daemon before any instance is touched:

1. A `run_worker_first` match goes to the code.
2. Otherwise `_redirects`, then a file through `html_handling`, served with `_headers` applied.
3. No file: the code handles it. With `single-page-application`, browser navigations (`Sec-Fetch-Mode: navigate`) get `/index.html` without invoking the code, like Cloudflare. With no `main`, `not_found_handling` decides: `404-page` serves the nearest `404.html` with status 404, `single-page-application` serves `/index.html`, `none` an empty 404.

With a `main`, methods other than GET and HEAD always go to the code. With no `main`, they get 405 where the path is a file or a `_redirects` rule, and 404 elsewhere. A missing asset folder (before your first build) just means no files yet: requests still reach the code.

**Files in the asset folder** (never served themselves):

- `_redirects`: one `from to [status]` rule per line, 301/302/303/307/308 (default 302) or 200 for a same-origin rewrite. Splats (`*` → `:splat`, one per rule like Cloudflare), `:placeholders` and `#` comments; captured values are substituted percent-encoded. A 200 rewrite onto a `run_worker_first` path goes to your code. Bad lines are warnings at add/deploy.
- `_headers`: a path pattern line, then indented `Name: value` lines; `! Name` removes a header an earlier rule set. Applies to asset responses only.
- `.assetsignore`: gitignore syntax; matching files are never served or snapshotted.

**Portless, no process.** The daemon serves the files itself: no port, no instance started for a file hit, ETags with 304s, `HEAD` and `Range`. Dev serves straight from the folder, so edits show up on the next request. A file is served only if the function's user could read it, and nothing outside the folder (symlinks included). On a password-protected bound domain, files are sent with `Cache-Control: private` so a shared cache can't hand them to anyone past the password (a `_headers` rule can still set your own).

**Assets-only sites.** Leave out `main` and the folder is a static site: no process ever starts, and `hot`, `max` and `linger` don't apply. `candy fn add site ./site` works the same; the portal marks it **assets-only**.

```bash
echo '{ "assets": { "directory": "./dist", "not_found_handling": "404-page" } }' > candy.fn.json
candy fn add docs
```

### Deploys

In dev a function is live-linked to its folder. A deploy freezes it:

1. `Bun.build` bundles `main` into one file with a linked sourcemap.
2. The bundle and a `manifest.json` (config, source path, git rev) are written to `<state>/deploys/<YYYYMMDDHHmmss-sha8>/`.
3. The asset folder (minus `.assetsignore`) is copied into the snapshot with a manifest; bad `_headers` / `_redirects` fail the deploy. An assets-only site snapshots just the files.
4. The function is pinned to that snapshot and restarted. Inside the sandbox the snapshot is read-only; only the state folder is writable. Rollback switches code and assets together.

The last 10 deploys are kept. Roll back to any of them, or unpin and go back to the live source. The bundle step runs as the function's user, never root.

### Request log

The daemon records every request a function serves, for the last 24 hours. The function plays no part in it, so code can't skip it.

- Each row has the method, path and query, host, client IP, status, request and response headers and bodies, timings (queued until ready, cold or warm, time to first byte, total), the instance, how it ended (`ok`, `threw`, `cancelled`, `crashed`) with the stack, and the `waitUntil` outcome.
- Each row says who answered, `kind`: `worker` (the code) or `asset` (the daemon served a file; metadata only, no bodies), and the `rule` that routed it: `worker-first:/api/*`, `spa-navigate`, the `_redirects` line, `404-page`.
- `console.*` output from inside a request is attached to that request (and still goes to the normal log), like `wrangler tail`.
- Bodies: the first 64 KB each way. Non-text bodies are kept as size and sha256 only. Streaming responses keep the first 64 KB and the total size. Capture never slows the response.
- Redacted by default: `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, and any header or JSON/form field matching `token|secret|password|api[-_]?key`, including query parameters in the URL and in `Location` / `Content-Location`.
- One SQLite file per function in the daemon's own state (`/var/lib/candy-daemon/fn-log/`, or `~/.local/state/candy/fn-log/`), never mounted into the sandbox. Capped at 256 MB, oldest rows first. The log can be set to metadata only, or off.
- Only the function's user (or a superuser) can read it, and it's never reachable from a public host (the public MCP endpoint doesn't offer the request-log, replay, KV or D1 tools). Removing the function deletes its log.

**Replay** sends a logged request again to the code running now, which is handy straight after an edit. Redacted values stay redacted, and a request whose body was cut at 64 KB is refused unless you allow a partial body.

### CLI

```bash
candy fn add hello ./hello            # register a function or static site (path defaults to .)
open https://hello.localhost          # first request starts it

candy fn deploy hello                 # bundle and pin a snapshot
candy fn deploys hello                # list snapshots
candy fn rollback hello               # back to the previous one (or pass an id)
candy fn dev hello                    # unpin, serve the live source again

candy fn kv hello put greeting hi     # poke at bindings
candy fn kv hello list
candy fn d1 hello "select count(*) from users"

candy fn requests hello --status 5xx --path /api --since 1h   # ROUTE column: asset/worker + rule
candy fn request <id>                 # headers, bodies, console, timings
candy fn tail hello                   # live
candy fn replay <id>                  # --allow-partial for a truncated body
```

`candy start`, `stop`, `logs` and `rm` work on functions as they do on any site. The SDK has `registerFunction({ cwd, entry?, name?, hot?, max?, linger? })`; the name defaults to the folder's name.

### Hono

A Hono app already has the right shape, so it runs unchanged:

```ts
// src/index.ts
import { Hono } from "hono"

type Bindings = { KV: KVNamespace; DB: D1Database; GREETING: string }
const app = new Hono<{ Bindings: Bindings }>()

app.get("/", c => c.text(c.env.GREETING))

app.get("/hits", async c => {
  const n = Number((await c.env.KV.get("hits")) ?? 0) + 1
  await c.env.KV.put("hits", String(n))
  return c.json({ hits: n })
})

app.get("/users", async c => {
  const { results } = await c.env.DB.prepare("select id, name from users").all()
  return c.json(results)
})

export default app
```

```bash
cd hello && bun add hono
candy fn add hello
curl https://hello.localhost/hits
```

## CLI Reference

```
candy dev [cmd...]             Start dev server (uses saved config, or auto-detects from package.json)
candy dev <cmd> --name <name>  Register and run with custom route name
candy dev <cmd> --api          Register in API mode (hold the first request while starting, then forward it)
candy api <name> [on|off]      Turn API mode on or off
candy mem <name> <size|off>    Memory limit for a site (default 2G, at most 16G)
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
candy fn add <name> [path]     Register a function (see candy-functions)
candy fn deploy|deploys|rollback|dev [name] [id]
                               Snapshots: bundle and pin, list, re-pin, back to live source
candy fn kv <name> get|put|list|delete ...   KV binding
candy fn d1 <name> "<sql>"     D1 binding
candy fn requests|request|tail|replay ...    The 24h request log
candy app-auth [list]          Sites with a sign-in key (yours)
candy app-auth rotate <name>   New key for a site (the old one works 10 more minutes)
candy app-auth consents        Sites you approved; candy app-auth revoke <site> forgets one
candy passkeys                 Your portal passkeys (add and remove them in the portal)
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
| `candy_servers` | List servers with status, port, PID, run-as user, API mode, variants (`configId`) and detected ports; functions add `fn` (entry, settings, `assets`) |
| `candy_start` / `candy_restart` / `candy_stop` | Control a server. `candy_start` takes `configId` when a name has several variants |
| `candy_logs` / `candy_input` | Read a server's output (tail, head, search) and type into its terminal |
| `candy_register` / `candy_deregister` | Add or remove a config. Register accepts `api` (API mode) and `user` (another account: only a portal superuser can, so over MCP it must be yourself); deregister accepts `configId` to remove one variant |
| `candy_config` | `list` configs and variants, `users` (run-as accounts), `set_api` (API mode on/off), `set_port` (pick one of several detected ports), `set_sandbox` (sandbox on/off, extra writable folders), `set_env_file`, `set_ttl` (idle minutes before it stops), `set_memory` (memory limit, 2G by default, at most 16G) |
| `candy_route` | `list`, `add` (port or URL `target`, `persistent`), `remove`, `rename`; LAN: `lan_list`, `lan_publish` (`https`: `true`, `false`, `"domain"` or `"tailscale"`, optional `port`), `lan_unpublish`; `entry` / `entry_list` (loopback entry ports), `serve` / `serve_list` (tailscale serve); AdGuard Home: `adguard_status`, `adguard_unlink` |
| `candy_domain` | Bound domains: `list`, `bind`, `unbind`, `config`; protection: `auth_status`, `auth_generate_jwt`, `auth_token` (`ttl`, `once`), `auth_clear` (`which`: password, jwt or all), `allowlist` (`add`, `remove`, `ips`, `enabled`); the public MCP endpoint: `public_mcp_status`, `public_mcp_on`, `public_mcp_off`, `public_mcp_revoke` |
| `candy_portal_open` / `candy_portal_close` / `candy_portals` | Cloudflare quick tunnels |
| `candy_status` | `status` (daemon and Caddy health), `stats` (requests per domain), `traffic` (recent requests for a name), `activity` (daemon activity log) |
| `candy_network` | The `.candy` registry across Tailscale machines |
| `candy_fn_add` | Register a function or static site from a folder (assets and `run_worker_first` come from its project config) |
| `candy_fn_deploy` / `candy_fn_rollback` / `candy_fn_deploys` | Bundle and pin a snapshot, re-pin an earlier one, list snapshots |
| `candy_fn_kv` / `candy_fn_d1` | Read and write a function's KV and D1 bindings |
| `candy_fn_requests` / `candy_fn_request` | The request log: filter by status, path and time, then one request in full (headers, bodies, console, timings, `kind` asset/worker and the routing `rule`) |

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

Sign-in is OAuth 2.1. Tailscale decides who can reach the consent page, and a portal login decides who approves:

1. The client finds the OAuth endpoints from `/.well-known/oauth-protected-resource`, registers itself, and opens `https://candy.<zone>/authorize` in your browser.
2. candy parks the request and sends the browser to `https://portal.candy/oauth/consent`. That page exists only on your tailnet, so only a device your Tailscale ACLs let reach this machine can open it, and it asks you to [log in](#portal-login) first. It shows the client's name, where it will send you back, who Tailscale says you are, and the account you're approving as.
3. Pressing **Allow** sends the browser back to `https://candy.<zone>/authorize/complete` with a one-time grant, which candy exchanges for the authorization code the client redeems.

Details: PKCE (S256) is required; access tokens last 1 hour and live in memory only; refresh tokens rotate, last 30 days and are stored hashed in `~/.config/candy/mcp-oauth.json`; reusing an old refresh token signs that client out. The public host serves nothing but the OAuth endpoints and `/mcp`, and `/mcp` there leaves out the function request-log, replay, KV and D1 tools (`PUBLIC_HIDDEN_TOOLS` in mcp.ts). Calls act as the user who approved the client, user-scoped and never as a superuser, and are recorded in the audit log (`MCP_PUBLIC_*`) with that user, the client's name and who approved it. A user who can no longer log in to the portal loses their clients too. Approvals made before portal login carried no user; the daemon revokes them at startup (audited as `MCP_PUBLIC_REVOKE`), and those clients sign in again.

A connected client can do what you can in the portal (as a regular user), including typing into your servers' terminals, which means running commands on this machine as you. Approve only clients you trust.

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

- **Portal login** (`candy_portal` cookie, on `portal.localhost` / `portal.candy` only), plus the page's rolling token (`X-Candy-Token`) on every request that changes something. See [Portal login](#portal-login).
- **API key** (`X-Candy-API-Key`): obtained via `POST /mcp/auth` with a bootstrap secret. Clients look in `$CANDY_SECRET_FILE`, `~/.config/candy/mcp-secret`, `/run/candy/users/<user>/secret`, then `/run/candy/secret`. Each API key belongs to the user whose secret it came from, and is always user-scoped.

Every control route is public, user or superuser (`ROUTE_TABLE` in daemon.ts); a route missing from that table is refused. User routes only show and change the caller's own sites, unless the caller is a superuser logged in to the portal. Without a login or key the API answers `401 {"error":"login required"}`; a superuser route answers `403` to everyone else, API keys included.

### Endpoints

#### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET` | `/login` | — | Portal login page (`?next=<path>`) |
| `GET` | `/auth/users` | — | `{ users, available }`: accounts that can log in |
| `POST` | `/auth/login` | `{ user, password }` | Log in; sets the cookie, returns `{ user, superuser }` |
| `POST` | `/auth/logout` | — | End this login |
| `GET` | `/auth/me` | — | `{ user, superuser, via }` |
| `POST` | `/token` | `{ token }` | Refresh the page's rolling token (same login only) |
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

#### Functions

Only the function's user (or a portal superuser) can call these. Errors are `{ success: false, error }`.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/fn/add` | `{ name, cwd, entry?, user?, envFile?, hot?, max? }` | Register a function (assets come from the project config; no `main` makes it assets-only) |
| `POST` | `/fn/settings` | `{ name, hot?, max?, log? }` | Warm instances, instance cap, request log (`true`, `"meta"` or `false`) |
| `POST` | `/fn/deploy` | `{ name }` | Bundle, snapshot and pin |
| `POST` | `/fn/rollback` | `{ name, id? }` | Pin an earlier snapshot (the previous one if no `id`) |
| `POST` | `/fn/dev` | `{ name }` | Unpin, back to the live source |
| `GET` | `/fn/deploys?name=` | — | `{ deploys, current }` |
| `GET` | `/fn/instances?name=` | — | Live instances: id, pid, hot, in flight, started, ready |
| `GET` | `/fn/requests?name=&status=&path=&since=&before=&limit=` | — | Request log summaries |
| `GET` | `/fn/request?name=&id=` | — | One logged request in full |
| `GET` | `/fn/tail?name=` | — | SSE, one summary per finished request |
| `POST` | `/fn/replay` | `{ name, id, allowPartial? }` | Re-send a logged request to the current code |
| `POST` | `/fn/kv` | `{ name, binding, op, key?, value?, prefix?, limit? }` | KV `get` / `put` / `list` / `delete` |
| `POST` | `/fn/d1` | `{ name, binding, sql, params? }` | Run SQL against a D1 binding |

`GET /configs` entries carry `fn: { entry, deploy, hot, max, log, assets }` for functions. `assets` is `null` or `{ directory, binding, notFound, html, runWorkerFirst }`; `entry` is `null` for an assets-only site. Deploys carry `entry` and `assets` (the snapshot's asset folder, or `null`); request log rows carry `kind` and `rule`. Delete, start, stop and logs use the usual routes.

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
| `portal.html` | Dashboard (routes, processes, configs, portals, bound domains) with a log viewer that passes keystrokes to the process. Functions get an `fn` badge and a panel for deploys, rollback, hot/max, instances and the request log with replay |
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

The template unit runs the daemon as root, with the instance name as the **owner**: state lives in the owner's `~/.config/candy`. The owner is just the default account; it has no special rights in the portal or the API. `install-service.sh` fills in the repo, Bun and Caddy paths for your machine (`./install-service.sh daemon --print` to preview).

### Portal login

The portal (`portal.localhost`, `portal.candy`) and the public MCP consent page need a login with an account on this machine. Pick the account from the list (the owner plus members of the `candy` group; in user mode, only the daemon's own user) and type its password, which is checked through PAM.

- `install-service.sh` installs the PAM service `/etc/pam.d/candy` (`common-auth` + `common-account`). Without it, login fails closed and the login page says so; nothing falls back to another service.
- Sudoers are **superusers** for their whole login: they see every user's sites and change daemon-wide settings. It's rechecked about once a minute, so removing someone from sudoers takes effect without logging them out. The CLI, the SDK, the local MCP server and public MCP clients are never superusers, sudoers included.
- A login lasts 24 hours without use and 7 days at most. It has two halves: the `candy_portal` cookie (HttpOnly, SameSite=Strict, Secure on https) and a session secret the login page keeps in the portal's `localStorage` and sends as `X-Candy-Session`. Browsers send cookies to every port of a host, so a dev server on `portal.localhost:5555` would get the cookie, but never the secret. Opening a portal page in a browser that doesn't have the secret (cleared storage, a private window) goes to the login page. Sessions survive daemon restarts; only hashes of both halves are kept on disk, in `/var/lib/candy-daemon/portal-sessions.json` (root mode) or `~/.local/state/candy/portal-sessions.json`. At most 20 logins per account are kept (the oldest goes). Leaving the `candy` group, a locked or expired account, or a shell set to nologin ends that user's sessions within a minute.
- Wrong passwords: an address that isn't this machine gets the Fibonacci lockout bound domains use (3 tries, then 1h, 1h, 2h, 3h…, kept in `candy-grudge.lock`). An account is slowed down per address, never locked for everyone: after 3 failures from one address, that address waits 7.5s, then 15s, then 30s at most. Browsers on this machine (loopback) only ever get those short waits, so typos can't lock out the desktop. One attempt per account and per address runs at a time, and at most 4 at once overall. An unknown account, a wrong password, a slowed-down account and a busy server get the same answer after the same delay (at least 4.5s, longer than PAM's own failure delay).
- Requests that change something must come from a portal page (`Origin`) and carry that page's token, which belongs to one login.
- Because the CLI and MCP are never superusers, the commands for daemon-wide settings are refused there (`403`): `candy domain config`, `candy domain mcp …`, `candy lan publish`, `candy lan adguard`, `candy route serve`, and the matching MCP actions. LAN publishing, `tailscale serve` and the public MCP address have switches in the portal for superusers; the Cloudflare zone and AdGuard Home have no portal form yet.
- Logins, failures and logouts are in the audit log (`AUTH_LOGIN`, `AUTH_FAIL`, `AUTH_LOGOUT`) with the account and address. Passwords never are.

### Sign in with candy

Apps hosted on candy don't need their own login: they send the browser to the portal, the user logs in there (password or passkey) and approves the app once, and the browser comes back with a one-shot token that only that site's key opens. The backend learns the unix user (`ashwin`, `claude`, …). Design: [SDK_AUTH_DESIGN.md](SDK_AUTH_DESIGN.md).

A plain Bun server started by candy:

```ts
import { appAuth, redirectAfterLogin } from "candy-localhost"

const auth = appAuth()   // site and key from what candy gave this process
Bun.serve({
  async fetch(req) {
    // GET /_candy/auth/login?next=/x starts it; POST /_candy/auth/callback finishes it
    const r = await auth.handle(req, u => {
      // u.user is the unix user, u.amr is ["pam"] or ["passkey"]. Issue a FRESH session id here.
      return redirectAfterLogin(u.next, `sid=${newSession(u.user)}; Path=/; Secure; HttpOnly; SameSite=Lax`)
    })
    if (r) return r
    if (!sessionOf(req)) return Response.redirect("/_candy/auth/login?next=" + encodeURIComponent(new URL(req.url).pathname), 302)
    return new Response("hello")
  },
})
```

A candy function gets the same object as `env.CANDY_AUTH`:

```ts
export default {
  async fetch(request, env) {
    const r = await env.CANDY_AUTH.handle(request, u => redirectAfterLogin(u.next, `sid=${newSession(u.user)}; Path=/; Secure; HttpOnly`))
    if (r) return r
    // ...
  },
}
```

- The token comes back as a form POST (never in a URL), lives 60 seconds, works once (the SDK keeps its `jti`), and is bound to the browser by a `__Host-candy_auth` state cookie. A token minted for one site can't be opened by another: each site has its own key, and the SDK checks the audience and the exact callback URL.
- `return_to` must be exactly `https://<host>/_candy/auth/callback` (no port, query or fragment) on a host candy routes to that same site: `<name>.localhost`, `<name>.candy` or one of its bound domains. Anything else gets an error page, never a redirect. The SDK only accepts a token at the URL it was minted for (the callback it arrived at), never one picked by a cookie.
- The first time, the portal asks "<site> wants to know who you are" and says who runs the site; "Remember for this site" skips the question for 30 days (per user and site; `candy app-auth revoke <site>` undoes it). Remembered or not, the token is only minted by a POST from the portal page.
- Keys: one random 256-bit key per site, made when the site first starts (or the SDK first asks), kept by the daemon in a root-only file. Sandboxed servers and functions get it as a systemd credential (`$CREDENTIALS_DIRECTORY/candy-auth-keys`), other launches as `CANDY_AUTH_KEYS`; never on a command line. Anything else (a server you run yourself) fetches it with your API key: `appAuth({ site: "notes" })`. Only the site's owner gets it. `candy app-auth rotate <name>` makes a new key. The ring the SDK gets marks the old key as retired, so it only opens tokens made before the rotation (a token lives a minute at most): a leaked old key can't mint sign-ins afterwards, in any copy of the ring. An app using `appAuth()` refetches the ring every 5 minutes and when it meets a new key; a server holding only the old ring (started before the rotation, no API key to refetch) keeps accepting the old key until it restarts, so `candy restart` the names the command lists. Functions are restarted for you.
- Passkeys: after a password login, open **Passkeys** in the portal (`/passkeys`) to add one; then the login page offers "Log in with a passkey". A passkey works only on the portal address it was made on (`portal.localhost` or `portal.candy`). Adding or removing one asks for the password again if it wasn't entered in the last 10 minutes, so a passkey login can't add more passkeys. A sudoer who logged in with a passkey isn't a superuser until they enter the password again (good for an hour). Passkey login is rate limited like password login and runs PAM's account checks (an expired password, `pam_access`, `pam_nologin` stop it); an account that can't log in any more can't use its passkeys either. A passkey belongs to the account (name and uid): it's removed when the account is deleted or leaves the `candy` group, and a new account that reuses the name never inherits it.
- Audit log: `APP_AUTH_GRANT` / `APP_AUTH_DENY` (user, site, how they logged in, the token's id), `APP_AUTH_KEY_FETCH`, `APP_AUTH_KEY_ROTATE`, `APP_AUTH_RESET` (a name changed hands: new key, approvals dropped), `PASSKEY_ADD` / `PASSKEY_DELETE` / `PASSKEY_COUNTER` / `PASSKEY_DROP`, `AUTH_REAUTH`. Never a token or a key.

### Multiple Users

Add people to the `candy` group to let them use the daemon:

```bash
sudo groupadd --system candy
sudo usermod -aG candy alice
```

Each member gets a secret at `/run/candy/users/<user>/secret` that only they can read (checked every minute, so no restart is needed). Servers a user registers run as that user via `setpriv`, starting in their cwd with their `$HOME`. Nothing is ever started as root.

- Everyone sees and changes only their own sites: servers, functions, routes, tunnels, bound domains, logs and request logs. A superuser (see [Portal login](#portal-login)) sees and manages all of them.
- A superuser can add a site that runs as any group member (the portal's **Run as** picker, or `user` on `POST /config`); `~` in its folder means that user's home. Everyone else, and every API key, only adds sites that run as themselves. Root is never offered.
- Daemon-wide settings are superuser-only: the Cloudflare zone and tunnel, replacing DNS records candy didn't create, LAN publishing, `tailscale serve`, AdGuard Home, the public MCP endpoint and its clients, the audit and Caddy logs, and shutting the daemon down.
- A site's own pages (starting, crashed, tunnel progress) still show its log and can start or restart it, as visiting its URL would. Typing into its terminal and registering a new name from those pages needs the portal.
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
| `/var/lib/candy-daemon/app-auth-keys.json` | Sign in with candy: each site's key ring, root-only 0600 (`~/.local/state/candy/` as a normal user) |
| `/var/lib/candy-daemon/app-auth-consent.json` | Sign in with candy: remembered approvals (user, site, owner) |
| `/var/lib/candy-daemon/passkeys.json` | Portal passkeys: public keys and counters only |
| `/run/candy/app-auth/<name>.keys` | A sandboxed site's key ring for `LoadCredential=` (root-only) |
| `/var/lib/candy/<name>/` | A sandboxed server's state folder (`CANDY_STATE_DIR`). For a function: KV/D1 SQLite files and `deploys/` (`~/.local/state/candy/fn/<name>/` as a normal user) |
| `/var/lib/candy-daemon/fn-log/<name>.sqlite` | A function's 24h request log, daemon-only (`~/.local/state/candy/fn-log/` as a normal user) |
| `/run/candy/fn/<name>.sock` | Socket a function's instances dial in on (`$XDG_RUNTIME_DIR/candy/fn/` as a normal user) |
| `/var/log/candy/<name>.log` | Process logs when run as root (cleared on daemon start) |
| `/tmp/candy-logs/<name>.log` | Process logs when run as a normal user |
| `/tmp/candy-logs/daemon/audit.log` | Operation audit log (`/var/log/candy/daemon/` as root) |
| `/tmp/candy-logs/cron/<name>.log` | Cron run output (`/var/log/candy/cron` as root) |
| `/tmp/candy-logs/_dns.log` | DNS daemon log |

## Testing

```bash
bun test
```

Current test: regression preventing redirects to `http://localhost:<port>` (ensures routing stays domain-based).

## License

GPL-3.0
