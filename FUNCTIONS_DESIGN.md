# candy-functions — Design Doc

## Overview

Functions are plain JS/TS modules with a Workers-style default export, run by candy:

```ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) { ... },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) { ... },
}
```

A Hono app already has this shape (`export default app`), so it works unchanged. No build step is needed in dev.

**Functions are portless.** A function never listens on a TCP port or a socket of its own. Caddy sends the function's hosts to the daemon. The daemon intercepts each request and hands it to the function process over a channel the daemon owns, then streams the response back (see Transport).

A function is a managed process with `kind: "fn"`. candy generates its command (a host shim around the module). It keeps the server lifecycle: lazy start, idle kill, sandboxing, envFile, cron, `.localhost` / `.candy` / LAN / bound domains, tunnels, server auth, logs, MCP, portal. It skips port detection and Caddy upstreams entirely.

## Transport (daemon ↔ function)

- The daemon listens on `/run/candy/fn/<name>.sock` (user mode: `$XDG_RUNTIME_DIR/candy/fn/<name>.sock`). The socket is mode 0600 and owned by the function's user, and the path is bind-mounted into the sandbox. **The function dials in** with the token from `CANDY_FN_TOKEN` in its env. A connection without the right token is dropped.
- Frames are length-prefixed: a 4-byte length, a 1-byte type and a 4-byte stream id, followed by the payload. Headers travel as JSON and bodies as raw bytes.
  - `HELLO`: fn → daemon, with the token and the shim version. This replaces port detection, and the process counts as `running` once HELLO arrives.
  - `REQ_HEAD` / `REQ_BODY` / `REQ_END`: daemon → fn.
  - `RES_HEAD` / `RES_BODY` / `RES_END`: fn → daemon. Bodies stream both ways, so SSE and large uploads work.
  - `CANCEL`: either side, when the client disconnects. The fn side aborts `req.signal`.
  - `ERR`: fn → daemon, when `fetch` threw. The daemon renders the 500.
  - `LOG`: fn → daemon, with console output from inside a request, tagged with its stream id.
  - `WINDOW`: either side, per-stream flow control credit (see below).
  - `WS_*`: WebSocket upgrade and messages (phase 5).
- Many requests are multiplexed on one connection. Backpressure is per stream: when both sides announce a window (`HELLO.window`, `HELLO_ACK.window`), each may send at most that many body bytes on a stream before the reader grants more with `WINDOW {bytes}` (sent as the consumer actually reads). One slow client never pauses the shared socket, and a handler that reads its upload slowly holds back the daemon, not the shim's memory. Peers without a window fall back to pausing the socket.
- Routing: `routes.set(name, { target: { fn: name } })`. Caddy then emits `reverse_proxy localhost:9999` for the function's hosts, and the daemon dispatches by `Host`. Requests that arrive while the function is starting are held until HELLO (API-mode semantics, built in).
- The function's stdout and stderr stay plain logs (PTY), unchanged.
- Why the function dials in rather than listening: it opens no port or socket, the daemon controls every request (auth, activity counting, holding during start), and the shim stays swappable for an in-process Worker later without changing the protocol.

## Decisions

| Question | Choice | Why |
|---|---|---|
| Runtime | One sandboxed Bun process per function | Reuses `launchSpec`/`systemdRunCommand` and the whole lifecycle. ~50ms cold start, real isolation. |
| Networking | Portless: the daemon intercepts and dispatches over a daemon-owned socket | The function opens nothing, and the daemon sees and gates every request. |
| Bindings v1 | env + secrets, KV, D1-style SQL, cron `scheduled()` + `ctx.waitUntil` | Covers most real Workers apps. |
| Deploy | Both: live-linked dev **and** versioned deploy snapshots | Dev is edit-and-refresh; deploys are immutable and can be rolled back. |

## Config

`ServerConfig` gains:

```ts
fn?: {
  entry: string          // module path, relative to cwd (dev) or the snapshot dir
  deploy?: string        // pinned deploy id; absent = live-linked dev
}
```

```ts
fn?: {
  ...
  hot?: number           // warm instances kept alive at all times (default 0)
  linger?: number        // seconds an idle instance stays up for the next request (default 30, 0-600)
  max?: number           // cap on concurrent instances (default 4)
}
```

## Lifecycle: scale to zero, with a 30s linger

- **No request, no process.** A request comes in → the daemon spawns an instance, holds the request until HELLO, dispatches it, and streams the response back.
- **The instance lingers 30s after it goes idle, then exits.** Idle means no in-flight requests and every `ctx.waitUntil` settled. That starts the linger timer (`fn.linger` seconds, default 30, `0` = exit immediately). A new request during the linger is served warm and cancels the timer, which restarts at the next idle. When the timer expires the shim sends `BYE` and exits through the BYE/BYE_ACK handshake. The timer lives in the shim (`CANDY_FN_LINGER_MS`). `ttl` / `killIdleServers` don't apply to functions.
- Requests that arrive while an instance is still alive are multiplexed onto it rather than spawning another. A new instance is spawned only when every live one is past a per-instance concurrency limit (default 32), up to `max`.
- **`hot: N`** keeps N instances warm. They take requests the same way and are respawned if they exit or crash. Requests go to the least-loaded instance. Extra instances above N still exit when idle.
- Cron `scheduled()` runs are one-shot instances that follow the same rule.
- Cold start budget: Bun boot + import is ~30–50ms. A sandboxed spawn adds the `systemd-run` round trip (to be measured in phase 1). Deploy snapshots (pre-bundled single file) start faster than live dev. If the sandbox overhead is too high, the fix is a pre-forked "spare" instance per hot function, not a longer TTL.
- KV/D1 SQLite files are shared by concurrent instances using WAL + `busy_timeout`.

Project config is read from the function's folder, first match wins:

1. `candy.fn.json`
2. `wrangler.jsonc` / `wrangler.json` / `wrangler.toml`. Only the subset below is read; anything else is ignored with a warning.

```jsonc
{
  "main": "src/index.ts",
  "vars": { "GREETING": "hi" },
  "kv_namespaces": [{ "binding": "KV" }],
  "d1_databases":  [{ "binding": "DB" }],
  "triggers": { "crons": ["*/5 * * * *"] }
}
```

Secrets come from the existing `envFile` and are merged into `env` on top of `vars`. They are never written into the snapshot.

## Request log (last 24h)

The daemon sees every request and response frame, so it records them. The function has no part in this, and code that bypasses candy can't skip it.

- **Store**: one SQLite file per function, in the daemon's state (`/var/lib/candy-daemon/fn-log/<name>.sqlite`, or `~/.local/state/candy/fn-log/` in user mode). It is owned by the daemon and never mounted into the function's sandbox.
- **Row per request**: id, time, host, method, path + query, client IP, request headers, request body, status, response headers, response body. It also keeps timings (queued until HELLO, cold or warm, time to first byte, total), the instance id, how it ended (`ok` / `threw` / `cancelled` / `crashed`) with the error stack, and the `waitUntil` outcome.
- **Per-request console**: the shim wraps `console.*` while a request is in flight (AsyncLocalStorage) and sends `LOG` frames tagged with the stream id. The output still goes to the normal log too. Each request row then carries its own log lines, like `wrangler tail`.
- **Bodies**: the first 64 KB of each direction is captured and marked truncated beyond that. Non-text content types are stored as size + sha256 only, unless `fn.log.binary` is set. Streaming responses (SSE) record the first 64 KB and the total byte count. Capture is teed off the stream and never slows or buffers the response.
- **Redaction** by default: values of `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization`, and any header or JSON/form field matching `/token|secret|password|api[-_]?key/i` are stored as `[redacted]`. Extra rules come from `fn.log.redact`.
- **Retention**: rows older than 24h are deleted by an hourly sweep. There is also a size cap (default 256 MB per function, oldest rows dropped first). `fn.log: "meta"` skips bodies, and `fn.log: false` turns the log off.
- **Access**: only the function's owner can read it (`mayChangeConfig`). It is never exposed on the public host.
- **Surfaces**:
  - CLI: `candy fn requests <name> [--status 5xx] [--path /api] [--since 1h]`, `candy fn request <id>` (full detail), `candy fn tail <name>` (live).
  - MCP: `candy_fn_requests`, `candy_fn_request`, so an agent can debug from real traffic.
  - Portal: a request list with a detail pane.
  - **Replay**: `candy fn replay <id>` re-sends a logged request to the current code. That's useful straight after an edit. Redacted values aren't restored, and replay is refused if the logged body was truncated, unless `--allow-partial` is passed.

## Static assets (Workers Static Assets, portless)

Same config and behavior as Cloudflare Workers Static Assets. The daemon serves the files itself, with no process spawned and no port. A function with only `assets` and no `main` never starts a process at all.

```jsonc
{
  "main": "src/index.ts",              // optional when assets are set
  "assets": {
    "directory": "./public",           // required
    "binding": "ASSETS",               // optional: env.ASSETS.fetch(req) inside the function
    "not_found_handling": "none",      // "none" | "404-page" | "single-page-application"
    "html_handling": "auto-trailing-slash", // | "force-trailing-slash" | "drop-trailing-slash" | "none"
    "run_worker_first": false          // boolean | string[] of route patterns, "!" negates, e.g. ["/api/*", "!/api/docs/*"]
  }
}
```

**Routing order**, decided by the daemon before any instance is touched:

1. If `run_worker_first` matches (`true`, or the path matches a pattern and no `!` pattern), go to the function. With no `main`, that's a 500 config error, caught at add/deploy time.
2. Otherwise apply `_redirects`, then look the path up through `html_handling`. A match is served by the daemon, with `_headers` applied.
3. No match:
   - with a `main`: dispatch to the function. Exception: for `single-page-application`, **navigation** requests (`Sec-Fetch-Mode: navigate`) get `/index.html` without invoking the function, like Cloudflare.
   - without a `main`: `not_found_handling` decides. `404-page` serves the nearest `404.html` walking up from the requested path, with status 404. `single-page-application` serves `/index.html` with 200. `none` returns an empty 404.

**`run_worker_first` is the key control for SPAs with an API.** With `not_found_handling: "single-page-application"`, a browser navigation to `/api/me` would otherwise get `index.html`, and an `/api/*` path that happens to match a file would be served as that file. Setting `"run_worker_first": ["/api/*"]` sends every `/api/*` request to the function before any asset lookup, SPA fallback or `_redirects` rule. Everything else stays asset-first. Rules:
- `true` means always worker first. In that case `env.ASSETS.fetch()` is how the function serves files.
- An array is a list of patterns, matched on the path only (no query). `*` matches any characters including `/`. A pattern without `*` is an exact path. A leading `!` excludes, and exclusions win over inclusions: `["/api/*", "!/api/docs/*"]` sends `/api/docs/` to the assets again.
- Patterns are literal: `"/api/*"` matches `/api/` and `/api/me` but not `/api` itself. To send both, list both: `["/api", "/api/*"]`.
- Matching is plain string search (literal prefix, suffix, then each middle literal left to right), never a regex, so a long path can't make it backtrack.
- Patterns are validated at add/deploy (must start with `/` or `!/`, at most 100), and bad ones fail loudly instead of being ignored.
- The request log records `worker-first` as the routing reason, so it's visible why a request skipped the assets.

**`html_handling`** follows Cloudflare's table exactly:
- `auto-trailing-slash`: `/a` → `/a.html`, or `/a/index.html` with a 307 to `/a/`. `/a.html` and `/a/index.html` 307 to their canonical form.
- `force-trailing-slash` and `drop-trailing-slash`: always/never a trailing slash, with 307s.
- `none`: exact files only.

**`_redirects`** (a file in the asset directory, Netlify/Cloudflare syntax):
- One rule per line: `from to [status]`. Status is 301/302/303/307/308 (default 302), or 200 for a same-origin rewrite (proxying).
- Splats `*` → `:splat`, `:placeholders` and `#` comments. One `*` per rule, like Cloudflare: a rule with more is dropped with a warning. A placeholder matches within one path segment. Rules are matched segment by segment without regexes, so a long path costs linear time.
- Captured values are percent-encoded when substituted, so `/old/%5Cevil.com` against `/old/* /:splat 301` redirects to `/%5Cevil.com`, not `/\evil.com`. A 200 rewrite whose target resolves to another origin is refused with a 500.
- A 200 rewrite onto a path that matches `run_worker_first` goes to the function with the rewritten URL (rule `worker-first:<pattern>`), or is a 500 without `main`, the same as a direct request for that path.
- Static rules match before dynamic ones. Limits: 2000 static + 100 dynamic rules, 1000 chars per rule. Bad lines are reported as warnings at add/deploy.
- Query strings pass through.

**`_headers`** (a file in the asset directory):
- A path pattern line (with one `*` splat and `:placeholders`, absolute URLs for a host), then indented `Name: value` lines. A pattern with more than one `*` is dropped with a warning.
- `! Name` detaches a header set by an earlier rule. Multiple matching rules merge, and the same name joins with `, `. Limit: 100 rules.
- Applies only to asset responses, not function responses, like Cloudflare.

**`.assetsignore`** (gitignore syntax, in the asset directory): matching files are never served or uploaded. `_headers`, `_redirects` and `.assetsignore` are never served themselves.

**Response defaults:**
- `Content-Type` by extension (`text/*`, JS and JSON get `; charset=utf-8`).
- Strong `ETag` (sha256 prefix of the content) with `If-None-Match` → 304, and `Cache-Control: public, max-age=0, must-revalidate`. On a password-protected bound domain it is `private, max-age=0, must-revalidate` instead (redirects and bare 404/405s get it too), unless `_headers` sets something else.
- `HEAD`, and single `Range` requests → 206. With a `main`, every other method goes to the function. Without one, it gets 405 (`Allow: GET, HEAD`) when the path resolves to an asset or matches a `_redirects` rule (which then doesn't fire), and 404 otherwise.
- Compression is Caddy's `encode` on the vhost.
- Limits: 25 MiB per file, 100k files per function (with Cloudflare's 20k as a warning only).

**`env.ASSETS.fetch(req | url)`** (when `binding` is set): the shim serves from the same directory through the same `fn-assets.ts` resolver. It ignores `run_worker_first` (it's always an asset lookup) and never loops back into the function.

**Dev vs deploy:**
- Dev serves straight from the live directory: every lookup stats the disk and the control files are re-read when their stamp changes, so edits show up on the next request. The daemon and the shim keep no file index and no watcher; only the snapshot walks the tree.
- A missing dev directory (before the first `vite build`) is an empty asset set, not an error: misses go to the function or `not_found_handling`, and the folder is picked up on the request after it appears.
- `candy fn deploy` copies the filtered asset tree into `deploys/<id>/assets/`, read-only, with an `assets-manifest.json` (path → {hash, size, type}), parses `_headers` and `_redirects` into the manifest, and fails the deploy on errors. Rollback switches assets and code together.

**Safety** (the daemon serves files as root in root mode):
- Every file is resolved with `realpath` and must stay inside the asset directory. Symlinks out of it are refused.
- In dev, a file is served only if the function's user could read it: owner, group or world read bits checked against the user's uid/gids, plus search permission on every parent directory.
- `_headers`, `_redirects`, `.assetsignore` and a deploy's `assets-manifest.json` are read the same way as files: opened with `O_NOFOLLOW|O_NONBLOCK`, `fstat`ed (regular file, at most 1 MiB, 64 MiB for the manifest), checked through `/proc/self/fd` for containment (the manifest must be exactly its own path) and readability, then read with a bounded read from that fd. A swap to a symlink, a device or a FIFO is refused, never followed or waited on.
- Snapshots get the same checks. The function's user owns `deploys/`, and function code can write there if the sandbox is off, so the manifest is never trusted on its own. Each file is opened with `O_NOFOLLOW`, then `fstat`ed and checked through `/proc/self/fd` for containment and readability. Its size and hash must match the manifest, and a file that was swapped is treated as missing.
- A pinned deploy routes with the assets config recorded in its manifest (`not_found_handling`, `html_handling`, `run_worker_first`, binding), so a rollback also rolls back routing.
- The server list and `/fn/*` show what is routing: `fn.hasWorker`, `fn.source` (`live` or `deploy:<id>`) and `fn.assets` come from the cached routing state, so a pinned deploy shows its own config. `fn.entry` is the stored module path, for display only; "assets-only" is `hasWorker: false`.

**Request log**: asset hits are logged as `kind: "asset"` (meta only, no bodies), and redirect/rewrite hits record the rule that matched.

## Host shim — `fn-host.ts`

Generated command: `bun <shim> <entry>`. No `--hot`: every cold instance imports the current source, so dev edits show up on the next request.

1. `import(entry)`, then take `default`. Accept `{ fetch }` objects, Hono apps, or a bare function. Reject anything else with a clear log line.
2. Build `env`: vars + secrets + bindings (below).
3. Connect to `CANDY_FN_SOCKET` and send HELLO. For each `REQ_HEAD`, build a `Request` whose body is a stream fed by `REQ_BODY` frames, call `mod.fetch(req, env, ctx)`, and stream the `Response` back as `RES_*` frames. No `Bun.serve` and no port. If the socket drops, exit, and the daemon restarts it on the next request.
4. `ctx.waitUntil(p)` tracks promises. `ctx.passThroughOnException()` is a no-op. When in-flight = 0 and `waitUntil` is drained, start the linger timer (`CANDY_FN_LINGER_MS`, default 30000). A new `REQ_HEAD` cancels it. On expiry send `BYE` and exit, unless the daemon marked this instance hot in its HELLO reply. On SIGTERM: stop taking requests, then await `waitUntil` for up to 30s.
5. Uncaught errors in `fetch` give a 500 plus a stack in the log (stack shown in the body only on `.localhost`).
6. Scheduled mode: `<shim> <entry> --scheduled "<cron>"` calls `scheduled({ cron, scheduledTime, type: "scheduled" }, env, ctx)`, awaits `waitUntil`, then exits. Cron jobs are the existing `ServerConfig.cron` entries. Their args are fixed by candy (`--scheduled <expr>`), never user text in a shell.

Free extras from Bun: `HTMLRewriter`, `crypto.subtle`, `fetch`, `WebSocket` upgrade via `server.upgrade` (exposed later).

The shim must be readable inside the sandbox. It is installed to `/usr/lib/candy/fn-host.ts` by `install-service.sh` (root mode) or used from the repo directly (user mode).

## Bindings — `fn-bindings.ts` (pure, unit-tested)

State lives in the function's state folder: `/var/lib/candy/<name>` (root mode, already writable in the sandbox) or `~/.local/state/candy/fn/<name>` (user mode).

**KV** (`kv.sqlite`, one table per binding):

- `get(key, "text"|"json"|"arrayBuffer"|"stream" | {type})`, `getWithMetadata`
- `put(key, value, { expiration, expirationTtl, metadata })`
- `delete`, `list({ prefix, limit, cursor })` → `{ keys, list_complete, cursor }`
- Expired keys are filtered on read and swept lazily.

**D1** (`d1-<binding>.sqlite`, `bun:sqlite`, WAL):

- `prepare(sql).bind(...).first(col?) / all() / run() / raw({ columnNames })`
- `batch([...stmts])` in one transaction, `exec(sql)`, `dump()` (file bytes)
- Result shape matches D1: `{ results, success, meta: { changes, last_row_id, duration, rows_read, rows_written } }`

Both are async on the outside (D1/KV APIs are promise-based) and sync underneath.

## Deploys — `fn-deploy.ts`

`candy fn deploy [name]`:

1. `Bun.build({ entrypoints: [main], target: "bun", minify: false, sourcemap: "linked" })`
2. Write to `<state>/deploys/<id>/` (`id` = timestamp + short content hash), with `worker.js`, its sourcemap, and `manifest.json` (config subset, source path, git rev if any).
3. Set `fn.deploy = id` and restart. The process runs from the snapshot. The snapshot dir is read-only in the sandbox, and only the state dir stays writable.
4. Keep the last 10 deploys.

`candy fn rollback [name] [id]` re-pins to an earlier snapshot. `candy fn dev [name]` unpins and goes back to the live entry.

## Surfaces

- **CLI**: `candy fn add <name> [path]` (path defaults to `.`), `candy fn deploy|rollback|dev|deploys`, `candy fn kv <name> get|put|list|delete`, `candy fn d1 <name> "<sql>"`. `start/stop/logs/rm` reuse the existing commands.
- **Daemon API**: `/fn/add`, `/fn/deploy`, `/fn/rollback`, `/fn/deploys`. Ownership checks go through `mayChangeConfig`. The bundle step runs as the function's user, never root.
- **MCP**: `candy_fn_add`, `candy_fn_deploy`, `candy_fn_rollback`, `candy_fn_deploys`, `candy_fn_kv`, `candy_fn_d1`.
- **SDK**: `registerFunction({ cwd, entry?, name? })`.
- **Portal**: a "fn" badge, current deploy id, and a deploy/rollback menu.

## Non-goals (v1)

Durable Objects, R2, Queues, `request.cf`, the Cache API, CPU-time limits (systemd `CPUQuota` could come later), and multi-host replication of KV/D1.

## Phases

1. **Runtime + transport**: `fn-protocol.ts` (frame codec, pure and tested), `fn-host.ts`, `fn-config.ts`, the daemon dispatcher and socket, the `kind: "fn"` wiring in `launchSpec`, `candy fn add`. A Hono hello-world served on `hello.localhost` with no port open.
2. **Bindings**: `fn-bindings.ts` (KV + D1) with tests, wired into the shim.
3. **Cron + waitUntil**: scheduled mode and syncing `triggers.crons` into `ServerConfig.cron`.
4. **Deploys**: bundle, snapshots, rollback, the sandbox read-only snapshot dir.
5. **Request log**: `fn-log.ts` (capture, redaction, retention, pure and tested), the `LOG` frames, CLI/MCP query and replay.
6. **Surfaces**: MCP tools, SDK, portal, README.
7. **Static assets**: `fn-assets.ts` (Workers Static Assets: `html_handling`, `not_found_handling`, `run_worker_first`, `_headers`, `_redirects`, `.assetsignore`, the `ASSETS` binding), served by the daemon with no process, snapshotted on deploy.

## Appendix: module contracts (binding for all build stages)

Each module is owned by exactly one build stage. Stages build against these signatures without seeing each other's code, so **do not change a signature**. If one is truly wrong, keep it working and add a note in your stage report.

### Frame protocol — `fn-protocol.ts` (phase 1)

- Header is 9 bytes: `u32 BE payloadLength`, `u8 type`, `u32 BE streamId`, then `payload` (≤ 1 MiB, `MAX_FRAME_PAYLOAD`). Stream 0 = control.
- `export const enum`-free plain object `Frame = { HELLO:1, HELLO_ACK:2, REQ_HEAD:3, REQ_BODY:4, REQ_END:5, RES_HEAD:6, RES_BODY:7, RES_END:8, CANCEL:9, ERR:10, LOG:11, BYE:12, BYE_ACK:13, DRAIN:14, WINDOW:15 } as const`
- JSON payloads:
  - `HELLO {token, instance, version, window?}`
  - `HELLO_ACK {hot: boolean, window?}`. `window` (extension, both optional): the sender does per-stream flow control and accepts that many body bytes per stream (`INITIAL_WINDOW`, 1 MiB) before it grants more.
  - `WINDOW {bytes}` (extension): the reader of a stream's body allows `bytes` more.
  - `REQ_HEAD {method, url, headers: [string,string][], clientIp, requestId}`
  - `RES_HEAD {status, statusText, headers: [string,string][]}`
  - `ERR {message, stack?}`
  - `LOG {level: "log"|"info"|"warn"|"error"|"debug", text, ts}`
  - `BYE {reason}`
  - `BYE_ACK {}` and `DRAIN {}` have no fields.
- Bodies (`REQ_BODY`, `RES_BODY`) are raw bytes.
- Idle exit handshake: the fn sends `BYE` when idle → the daemon stops routing to it and replies `BYE_ACK` → the fn serves any `REQ_HEAD` that arrived before `BYE_ACK`, then exits when drained. `DRAIN` (daemon → fn) means: take no more requests and exit when drained, even if hot.
- Exports:
  - `encodeFrame(type: number, streamId: number, payload?: Uint8Array): Uint8Array`
  - `encodeJsonFrame(type, streamId, obj): Uint8Array`
  - `class FrameDecoder { push(chunk: Uint8Array): DecodedFrame[] }` (throws on oversize), where `DecodedFrame = {type, streamId, payload: Uint8Array}`
  - `decodeJson<T>(payload): T`
  - `PROTOCOL_VERSION = 1`

### Daemon-side connection — `fn-dispatch.ts` (phase 1)

- `class FnConnection`
  - `constructor(socket: { write(b: Uint8Array): number|void; end(): void }, opts: { onHello(h): boolean /* token check */; onLog?(requestId, log): void; onBye?(): void; onClose?(): void })`
  - `feed(chunk: Uint8Array): void`
  - `get inflight(): number`
  - `get ready(): boolean`
  - `hot: boolean`
- `dispatch(req: Request, meta: { requestId: string; clientIp: string; capture?: CaptureHooks }): Promise<Response>`
  - Streams the request body, aborts on `req.signal` (sends `CANCEL`), and resolves on `RES_HEAD` with a streaming body.
  - `ERR` → rejects with `FnThrewError(message, stack)`. Socket close mid-request → rejects with `FnCrashedError`.
- `ack(hot: boolean)` sends `HELLO_ACK`. `byeAck()`, `drain()`.
- `CaptureHooks = { onRequestChunk?(b: Uint8Array): void; onResponseHead?(status, headers): void; onResponseChunk?(b: Uint8Array): void; onEnd?(outcome: "ok"|"threw"|"cancelled"|"crashed", err?: {message, stack?}): void }`. The fn-log stage builds these and fn-dispatch calls them.

### Instance pool — `fn-pool.ts` (phase 1, pure scheduling and lifecycle, injectable)

- `class FnPool`
  - `constructor(name, opts: { hot: number; max: number; perInstanceConcurrency?: number /*32*/; spawn(): Promise<FnInstanceHandle>; startTimeoutMs?: number /*15000*/ })`
  - `acquire(): Promise<FnInstanceHandle>`: picks the least-loaded ready instance under the limit, else spawns (≤ `max`), else queues. Requests wait until HELLO.
  - `ensureHot(): Promise<void>`
  - `setLimits({hot, max})`
  - `drainAll(): Promise<void>`
  - `instances(): {id, pid, hot, inflight, startedAt, ready}[]`
- `FnInstanceHandle = { id: string; pid: number|null; conn: FnConnection|null /*null until HELLO*/; ready: Promise<FnConnection>; hot: boolean; startedAt: number; kill(): void }`
- Respawns hot instances on exit. Non-hot instances are removed on BYE or exit.

### Project config — `fn-config.ts` (phase 1)

- `loadFnProjectConfig(dir: string): Promise<FnProjectConfig>` reads, first match wins: `candy.fn.json`, `wrangler.jsonc`, `wrangler.json`, `wrangler.toml` (JSONC comments and trailing commas allowed; TOML via `Bun.TOML.parse`).
- `FnProjectConfig = { main: string; vars: Record<string,string>; kv: string[] /*binding names*/; d1: string[]; crons: string[]; warnings: string[]; source: string|null }`
- Validates binding names `/^[A-Z_][A-Z0-9_]{0,63}$/i` and that `main` stays inside `dir`.

### Host shim — `fn-host.ts` (phase 1)

- Run as `bun fn-host.ts <entry> [--scheduled <cron>]`.
- Env:
  - `CANDY_FN_SOCKET`, `CANDY_FN_TOKEN`, `CANDY_FN_INSTANCE`
  - `CANDY_FN_STATE` (bindings dir)
  - `CANDY_FN_CONFIG` (JSON `FnProjectConfig`)
  - `CANDY_FN_SECRET_KEYS` (comma-separated env keys copied into `env` as secrets)
  - `CANDY_FN_LINGER_MS` (idle linger before BYE, default 30000, set from `fn.linger`)
- `loadHandler(mod)` accepts `{fetch}` objects, Hono apps (an object with `.fetch`) or a bare function. It is exported for tests.
- Uses `buildEnv` (phase 2), `installConsoleCapture` (phase 5) and `runScheduled` (phase 3).

### Bindings — `fn-bindings.ts` (phase 2)

- `createKV(dbPath: string, binding: string): KVNamespace`
- `createD1(dbPath: string): D1Database`
- `buildEnv(cfg: FnProjectConfig, stateDir: string, secrets: Record<string,string>): Record<string, unknown>`
  - Builds vars, then secrets, then `cfg.kv` → `KV` objects in `<stateDir>/kv.sqlite` (table per binding), then `cfg.d1` → `<stateDir>/d1-<binding>.sqlite`.
- `closeBindings(env)`
- APIs follow the Workers semantics in the Bindings section. SQLite runs with WAL and `busy_timeout=5000`.

### Cron + waitUntil — `fn-cron.ts` (phase 3)

- `cronJobsFor(cfg: FnProjectConfig): CronJob[]` maps each cron to `{name: "fn-<i>-<hash6>", schedule, args: ["--scheduled", expr]}`. `CronJob` comes from `cron.ts`.
- `class ExecutionContext { waitUntil(p): void; passThroughOnException(): void; settled(): Promise<void>; get pending(): number }`
- `runScheduled(handler, env, cron: string, now?: Date): Promise<void>` calls `handler.scheduled({cron, scheduledTime, type:"scheduled", noRetry(){}}, env, ctx)` and awaits `ctx.settled()`. It throws if there is no `scheduled` handler.
- The shim uses `ExecutionContext` for `fetch` too.

### Deploys — `fn-deploy.ts` (phase 4)

- `bundleDeploy(opts: { name, srcDir, main, stateDir, gitRev?: string|null }): Promise<DeployInfo>`
  - `Bun.build` with `target: "bun"` and a linked sourcemap.
  - Writes to `<stateDir>/deploys/<id>/{worker.js, worker.js.map, manifest.json}`, where `id` = `YYYYMMDDHHmmss-<sha8>`.
- `listDeploys(stateDir): Promise<DeployInfo[]>` (newest first)
- `pruneDeploys(stateDir, keep=10, pinned?: string)`
- `resolveDeploy(stateDir, id): Promise<DeployInfo|null>`
- `DeployInfo = { id, createdAt, entry /*abs worker.js*/, dir, source, gitRev, size, main }`

### Request log — `fn-log.ts` + `fn-console.ts` (phase 5)

- `fn-log.ts`:
  - `class FnLog`
    - `constructor(dbPath, opts?: {maxBytes?: number /*256MB*/, bodyLimit?: number /*65536*/, mode?: "full"|"meta", redact?: string[]})`
    - `begin(meta: {requestId, fn, host, method, url, clientIp, reqHeaders: [string,string][], instance, cold: boolean, queuedMs}): CaptureHooks & { addLog(log) }`
    - `query(f: {status?: string /*"5xx"|"404"*/, path?, since?: number, before?: number, limit?: number}): RequestSummary[]`
    - `get(id): RequestDetail|null`
    - `sweep(now?)`
    - `subscribe(cb: (s: RequestSummary)=>void): () => void`
    - `close()`
  - `redactHeaders(h)`, `redactBody(text, contentType)`
  - `replayRequest(detail: RequestDetail, opts: {allowPartial?: boolean}): Request` (throws if truncated and not allowed)
- `fn-console.ts`: `installConsoleCapture(send: (requestId: string, log: {level, text, ts}) => void): { run<T>(requestId, fn: () => T): T }`, built on AsyncLocalStorage. Original console output still goes to stdout.

### Static assets — `fn-assets.ts` (phase 7)

- `loadAssetsConfig(raw: unknown, dir: string): { config: AssetsConfig; warnings: string[] }`
  - `AssetsConfig = { directory /*abs*/, binding: string|null, notFound: "none"|"404-page"|"single-page-application", html: "auto-trailing-slash"|"force-trailing-slash"|"drop-trailing-slash"|"none", runWorkerFirst: boolean|string[] }`
- `class AssetServer`
  - `static async open(cfg: AssetsConfig, opts: { mode: "dev"|"snapshot"; canRead?(path: string): boolean; index?: boolean; watch?: boolean }): Promise<AssetServer>`. A missing directory opens as an empty set (`attached` false) and is picked up when it appears. `index` (and `watch`, which needs it) are only for `files()` and snapshots.
  - `route(req: Request, opts: { hasWorker: boolean; private?: boolean }): Promise<{ kind: "asset"|"redirect"|"rewrite"|"worker"|"notfound"; response?: Response; request?: Request; rule?: string }>`. `kind: "worker"` means dispatch to the function. A 200 rewrite to a non-asset path comes back as `worker` with the rewritten Request in `request`.
  - `fetchAsset(req: Request): Promise<Response>` is the `env.ASSETS` path (never `worker`).
  - `warnings: string[]`
  - `close()`
- `parseRedirects(text): { rules; warnings }`, `parseHeaders(text): { rules; warnings }`, `parseAssetsIgnore(text): (relPath: string) => boolean`
- `snapshotAssets(cfg: AssetsConfig, destDir: string): Promise<{ manifestPath; files; bytes; warnings }>` (used by fn-deploy)
- `userCanRead(path, uid, gids: number[]): boolean` (stat-based, for the daemon's `canRead`)
- `FnProjectConfig` gains `assets: AssetsConfig | null`, and `main` becomes `string | null` when `assets` is set. `fn-assets.ts` is built outside the main workflow run: the integration stage should not implement asset serving itself.

### Daemon HTTP API (built by the integration stage, used by phase 6 surfaces)

Same auth as the existing control API (the session token or API key, whatever `cli.ts` and `mcp.ts` already send). All bodies are JSON. Errors are `{success:false, error}`.

| Route | Request | Response |
|---|---|---|
| `POST /fn/add` | `{name, cwd, entry?, user?, envFile?, hot?, max?, linger?}` | `{success, name, url}` |
| `POST /fn/settings` | `{name, hot?, max?, linger?, log?: true\|"meta"\|false}` | `{success}` |
| `POST /fn/deploy` | `{name}` | `{success, deploy: DeployInfo}` |
| `POST /fn/rollback` | `{name, id?}` | `{success, deploy}` |
| `POST /fn/dev` | `{name}` | `{success}` |
| `GET /fn/deploys?name=` | | `{deploys, current}` |
| `GET /fn/instances?name=` | | `{instances}` |
| `GET /fn/requests?name=&status=&path=&since=&before=&limit=` | | `{requests}` |
| `GET /fn/request?name=&id=` | | `RequestDetail` |
| `GET /fn/tail?name=` | | SSE, `data: RequestSummary` |
| `POST /fn/replay` | `{name, id, allowPartial?}` | `{status, headers, body, requestId}` |
| `POST /fn/kv` | `{name, binding, op: "get"\|"put"\|"list"\|"delete", key?, value?, prefix?, limit?}` | the op result |
| `POST /fn/d1` | `{name, binding, sql, params?}` | the D1 result |

The existing server list entries gain `fn: {entry, deploy, hot, max, log} | undefined`. Delete, start, stop and logs reuse the existing routes.
