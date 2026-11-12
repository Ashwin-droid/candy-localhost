// Per-function request log (last 24h). The daemon sees every frame of every
// request, so it records them here: one bun:sqlite file per function, owned by
// the daemon and never mounted into the sandbox. Capture is fed by the
// CaptureHooks that fn-dispatch calls while it streams, so it only copies the
// first `bodyLimit` bytes and never holds the response back.

import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const LOG_RETENTION_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
export const DEFAULT_BODY_LIMIT = 64 * 1024
export const MAX_LOG_LINES = 1000
export const MAX_LOG_BYTES = 256 * 1024
export const REDACTED = "[redacted]"
// Console lines that arrive after the response (waitUntil) are written in batches
export const LATE_LOG_FLUSH_MS = 250

// Same shape as CaptureHooks in fn-dispatch.ts (declared here structurally so
// this module stays pure and does not import the dispatcher).
export type CaptureOutcome = "ok" | "threw" | "cancelled" | "crashed"
export type FnCaptureHooks = {
  onRequestChunk?(b: Uint8Array): void
  onResponseHead?(status: number, headers: [string, string][]): void
  onResponseChunk?(b: Uint8Array): void
  onEnd?(outcome: CaptureOutcome, err?: { message: string; stack?: string }): void
}

export type LogLevel = "log" | "info" | "warn" | "error" | "debug"
export type LogLine = { level: LogLevel; text: string; ts: number }

export type BeginMeta = {
  requestId: string
  fn: string
  host: string
  method: string
  url: string
  clientIp: string
  reqHeaders: [string, string][]
  instance: string
  cold: boolean
  queuedMs: number
  // "asset": served by the daemon from the asset directory (meta only, never bodies)
  kind?: RequestKind
  // Why it was routed this way: a run_worker_first pattern, "spa-navigate", a _redirects line
  rule?: string | null
}

export type RequestKind = "worker" | "asset"

export type FnLogOptions = {
  maxBytes?: number
  bodyLimit?: number
  mode?: "full" | "meta"
  redact?: string[]
}

export type RequestSummary = {
  id: string
  ts: number              // arrival time (ms), i.e. begin() minus queuedMs
  fn: string
  host: string
  method: string
  url: string
  path: string
  clientIp: string
  status: number | null   // null when the request ended before a response head
  outcome: CaptureOutcome
  cold: boolean
  instance: string
  queuedMs: number
  ttfbMs: number | null
  totalMs: number
  reqBytes: number
  resBytes: number
  kind: RequestKind
  rule: string | null
}

// kind: "text" has `text`; "binary" has only size + sha256; "omitted" is
// mode "meta"; "none" means no body bytes were seen.
export type CapturedBody = {
  kind: "text" | "binary" | "omitted" | "none"
  contentType: string | null
  size: number            // total bytes seen, not just the captured part
  truncated: boolean
  text: string | null
  sha256: string | null
}

export type RequestDetail = RequestSummary & {
  reqHeaders: [string, string][]
  resHeaders: [string, string][]
  reqBody: CapturedBody
  resBody: CapturedBody
  error: { message: string; stack: string | null } | null
  logs: LogLine[]
  logsTruncated: boolean
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"])
const SECRET_NAME = /token|secret|password|api[-_]?key/i

// Extra rules from fn.log.redact are regex sources (case-insensitive); a
// source that is not a valid regex is matched literally.
const compileExtra = (extra: string[] = []): RegExp[] =>
  extra.filter(Boolean).map(src => {
    try { return new RegExp(src, "i") }
    catch { return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
  })

const nameIsSecret = (name: string, extra: RegExp[]) =>
  SECRET_NAME.test(name) || extra.some(r => r.test(name))

// Headers that carry a URL: a redirect to /cb?token=... must not put the token in the log
const URL_HEADERS = new Set(["location", "content-location"])

const redactHeadersWith = (h: [string, string][], extra: RegExp[]): [string, string][] =>
  h.map(([k, v]) => {
    const name = k.toLowerCase()
    if (SECRET_HEADERS.has(name) || nameIsSecret(k, extra)) return [k, REDACTED]
    return [k, URL_HEADERS.has(name) ? redactUrl(v, extra) : v]
  })

export const redactHeaders = (h: [string, string][], extra: string[] = []): [string, string][] =>
  redactHeadersWith(h, compileExtra(extra))

const redactJsonValue = (v: unknown, extra: RegExp[]): unknown => {
  if (Array.isArray(v)) return v.map(x => redactJsonValue(x, extra))
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = nameIsSecret(k, extra) ? REDACTED : redactJsonValue(x, extra)
    return out
  }
  return v
}

// Truncated JSON can't be parsed, so fall back to replacing `"key": value`
// pairs textually. A string value cut off by the limit runs to the end.
const JSON_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)("(?:[^"\\]|\\.)*"?|[^,{}[\]\s"]+)/g
const redactJsonText = (text: string, extra: RegExp[]) =>
  text.replace(JSON_PAIR, (all, key: string, sep: string) =>
    nameIsSecret(key, extra) ? `"${key}"${sep}"${REDACTED}"` : all)

const decodeFormPart = (s: string) => {
  try { return decodeURIComponent(s.replace(/\+/g, " ")) } catch { return s }
}

// Rewrites only the secret pairs so the rest keeps its original encoding.
const redactFormText = (text: string, extra: RegExp[]) =>
  text.split("&").map(pair => {
    const eq = pair.indexOf("=")
    if (eq < 0) return pair
    return nameIsSecret(decodeFormPart(pair.slice(0, eq)), extra) ? `${pair.slice(0, eq)}=${REDACTED}` : pair
  }).join("&")

const mimeOf = (contentType: string | null | undefined) =>
  (contentType ?? "").split(";")[0].trim().toLowerCase()

const isJsonType = (m: string) => m === "application/json" || m.endsWith("+json") || m === "application/x-ndjson"

export const redactBody = (text: string, contentType: string | null, extra: string[] = []): string =>
  redactBodyWith(text, contentType, compileExtra(extra))

const redactBodyWith = (text: string, contentType: string | null, extra: RegExp[]): string => {
  const m = mimeOf(contentType)
  if (isJsonType(m) || (!m && /^\s*[[{]/.test(text))) {
    if (m === "application/x-ndjson") return text.split("\n").map(l => redactBodyWith(l, "application/json", extra)).join("\n")
    try { return JSON.stringify(redactJsonValue(JSON.parse(text), extra)) }
    catch { return redactJsonText(text, extra) }
  }
  if (m === "application/x-www-form-urlencoded") return redactFormText(text, extra)
  return text
}

// Query strings carry tokens too (?token=...), so the stored URL is redacted.
const redactUrl = (url: string, extra: RegExp[]) => {
  const q = url.indexOf("?")
  if (q < 0) return url
  const hash = url.indexOf("#", q)
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash)
  return url.slice(0, q + 1) + redactFormText(query, extra) + (hash < 0 ? "" : url.slice(hash))
}

// ---------------------------------------------------------------------------
// Body capture
// ---------------------------------------------------------------------------

const TEXT_MIMES = new Set([
  "application/json", "application/xml", "application/javascript", "application/ecmascript",
  "application/x-www-form-urlencoded", "application/graphql", "application/x-ndjson",
  "application/yaml", "application/x-yaml", "application/toml", "image/svg+xml",
])

// "text": store it; "binary": hash only; "unknown": no content type, decide
// at the end by checking whether the captured bytes are UTF-8.
const classify = (headers: [string, string][]): "text" | "binary" | "unknown" => {
  const get = (n: string) => headers.find(([k]) => k.toLowerCase() === n)?.[1]
  const enc = (get("content-encoding") ?? "").trim().toLowerCase()
  if (enc && enc !== "identity") return "binary"  // compressed bytes aren't readable text
  const m = mimeOf(get("content-type"))
  if (!m) return "unknown"
  if (m.startsWith("text/") || TEXT_MIMES.has(m) || m.endsWith("+json") || m.endsWith("+xml")) return "text"
  return "binary"
}

const looksLikeUtf8 = (b: Uint8Array) => {
  if (b.includes(0)) return false
  try { new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: true }); return true }
  catch { return false }
}

class BodyTap {
  private chunks: Uint8Array[] = []
  private captured = 0
  size = 0
  private hasher: Bun.CryptoHasher | null = null
  private kind: "text" | "binary" | "unknown" = "unknown"
  private contentType: string | null = null

  constructor(private limit: number, private store: boolean) {}

  setHeaders(headers: [string, string][]) {
    this.kind = classify(headers)
    this.contentType = headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? null
    if (this.store && this.kind !== "text") this.hasher = new Bun.CryptoHasher("sha256")
  }

  push(b: Uint8Array) {
    this.size += b.byteLength
    if (!this.store) return
    this.hasher?.update(b)
    // Binary bodies are hashed only; text and unknown keep the first `limit` bytes.
    if (this.kind === "binary" || this.captured >= this.limit) return
    const take = Math.min(b.byteLength, this.limit - this.captured)
    this.chunks.push(b.slice(0, take))  // copy: the caller may reuse its buffer
    this.captured += take
  }

  finish(extra: RegExp[]): CapturedBody {
    const base = { contentType: this.contentType, size: this.size }
    if (!this.store) return { ...base, kind: this.size ? "omitted" : "none", truncated: false, text: null, sha256: null }
    if (this.size === 0) return { ...base, kind: "none", truncated: false, text: null, sha256: null }
    const bytes = Buffer.concat(this.chunks)
    this.chunks = []
    const sha256 = this.hasher ? this.hasher.digest("hex") : null
    if (this.kind === "binary" || (this.kind === "unknown" && !looksLikeUtf8(bytes))) {
      return { ...base, kind: "binary", truncated: false, text: null, sha256 }
    }
    const truncated = this.size > bytes.byteLength
    const text = redactBodyWith(new TextDecoder().decode(bytes, { stream: true }), this.contentType, extra)  // stream: drop a char split by the limit
    return { ...base, kind: "text", truncated, text, sha256: this.kind === "unknown" ? sha256 : null }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  fn TEXT NOT NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  status INTEGER,
  outcome TEXT NOT NULL,
  cold INTEGER NOT NULL,
  instance TEXT NOT NULL,
  queued_ms INTEGER NOT NULL,
  ttfb_ms INTEGER,
  total_ms INTEGER NOT NULL,
  req_bytes INTEGER NOT NULL,
  res_bytes INTEGER NOT NULL,
  req_headers TEXT NOT NULL,
  res_headers TEXT NOT NULL,
  req_body TEXT NOT NULL,
  res_body TEXT NOT NULL,
  error TEXT,
  logs TEXT NOT NULL,
  logs_truncated INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'worker',
  rule TEXT
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
`

type Row = {
  id: string; ts: number; fn: string; host: string; method: string; url: string; path: string
  client_ip: string; status: number | null; outcome: CaptureOutcome; cold: number; instance: string
  queued_ms: number; ttfb_ms: number | null; total_ms: number; req_bytes: number; res_bytes: number
  req_headers: string; res_headers: string; req_body: string; res_body: string; error: string | null
  logs: string; logs_truncated: number; kind: string | null; rule: string | null
}

const SUMMARY_COLS = "id, ts, fn, host, method, url, path, client_ip, status, outcome, cold, instance, queued_ms, ttfb_ms, total_ms, req_bytes, res_bytes, kind, rule"

const toSummary = (r: Row): RequestSummary => ({
  id: r.id, ts: r.ts, fn: r.fn, host: r.host, method: r.method, url: r.url, path: r.path,
  clientIp: r.client_ip, status: r.status, outcome: r.outcome, cold: !!r.cold, instance: r.instance,
  queuedMs: r.queued_ms, ttfbMs: r.ttfb_ms, totalMs: r.total_ms, reqBytes: r.req_bytes, resBytes: r.res_bytes,
  kind: r.kind === "asset" ? "asset" : "worker", rule: r.rule ?? null,
})

// Columns added after the first schema; logs written by an older daemon get them on open
const MIGRATIONS: [column: string, ddl: string][] = [
  ["kind", "ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'"],
  ["rule", "ALTER TABLE requests ADD COLUMN rule TEXT"],
]

const pathOf = (url: string, host: string) => {
  try { return new URL(url, `http://${host || "localhost"}`).pathname } catch { return url.split("?")[0] || "/" }
}

export type QueryFilter = { status?: string; path?: string; since?: number; before?: number; limit?: number }

export class FnLog {
  private db: Database
  private maxBytes: number
  private bodyLimit: number
  private mode: "full" | "meta"
  private extra: RegExp[]
  private subscribers = new Set<(s: RequestSummary) => void>()
  private totalBytes: number
  private closed = false
  // Rows with late console lines not written yet: request id -> write them now
  private lateLogs = new Map<string, () => void>()

  constructor(dbPath: string, opts: FnLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.bodyLimit = Math.max(0, opts.bodyLimit ?? DEFAULT_BODY_LIMIT)
    this.mode = opts.mode ?? "full"
    this.extra = compileExtra(opts.redact)
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    this.db = new Database(dbPath, { create: true })
    // Logs hold request data, so only the daemon may read them. SQLite gives
    // the -wal/-shm files the same mode as the main file.
    try { chmodSync(dbPath, 0o600) } catch {}
    // auto_vacuum must be set before the first table exists to take effect.
    this.db.run("PRAGMA auto_vacuum = INCREMENTAL")
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA busy_timeout = 5000")
    this.db.run("PRAGMA synchronous = NORMAL")
    this.db.exec(SCHEMA)
    const cols = new Set((this.db.query("PRAGMA table_info(requests)").all() as { name: string }[]).map(c => c.name))
    for (const [col, ddl] of MIGRATIONS) if (!cols.has(col)) this.db.run(ddl)
    this.totalBytes = (this.db.query("SELECT COALESCE(SUM(bytes), 0) AS n FROM requests").get() as { n: number }).n
  }

  begin(meta: BeginMeta): FnCaptureHooks & { addLog(log: LogLine): void } {
    const started = performance.now()
    const queuedMs = Math.max(0, Math.round(meta.queuedMs))
    // Timings are measured from arrival, so they include time spent queued.
    const ts = Date.now() - queuedMs
    const kind: RequestKind = meta.kind === "asset" ? "asset" : "worker"
    const rule = meta.rule ?? null
    // Asset hits are files the owner already has: never copy their bodies
    const store = this.mode === "full" && kind === "worker"
    const req = new BodyTap(this.bodyLimit, store)
    const res = new BodyTap(this.bodyLimit, store)
    req.setHeaders(meta.reqHeaders)
    let status: number | null = null
    let resHeaders: [string, string][] = []
    let ttfbMs: number | null = null
    let finished = false
    const logs: LogLine[] = []
    let logBytes = 0
    let logsTruncated = false

    const pushLog = (log: LogLine): boolean => {
      if (logsTruncated) return false
      if (logs.length >= MAX_LOG_LINES || logBytes >= MAX_LOG_BYTES) { logsTruncated = true; return true }
      let text = String(log.text ?? "")
      if (logBytes + text.length > MAX_LOG_BYTES) {
        text = text.slice(0, MAX_LOG_BYTES - logBytes)
        logsTruncated = true
      }
      logBytes += text.length
      logs.push({ level: log.level, text, ts: log.ts })
      return true
    }

    return {
      onRequestChunk: b => { if (!finished) req.push(b) },
      onResponseHead: (s, headers) => {
        if (finished) return
        status = s
        resHeaders = headers
        ttfbMs = Math.round(performance.now() - started) + queuedMs
        res.setHeaders(headers)
        // Asset bodies are never streamed through the hooks: take the size from the head
        if (kind === "asset") {
          const len = Number(headers.find(([k]) => k.toLowerCase() === "content-length")?.[1])
          if (Number.isFinite(len) && len > 0) res.size = len
        }
      },
      onResponseChunk: b => { if (!finished) res.push(b) },
      onEnd: (outcome, err) => {
        if (finished) return
        finished = true
        // A throw or crash before RES_HEAD becomes the daemon's 500.
        if (status === null && (outcome === "threw" || outcome === "crashed")) status = 500
        const row = {
          id: meta.requestId, ts, fn: meta.fn, host: meta.host, method: meta.method,
          url: redactUrl(meta.url, this.extra), path: pathOf(meta.url, meta.host), clientIp: meta.clientIp,
          status, outcome, cold: meta.cold, instance: meta.instance, queuedMs, ttfbMs,
          totalMs: Math.round(performance.now() - started) + queuedMs,
          reqHeaders: redactHeadersWith(meta.reqHeaders, this.extra),
          resHeaders: redactHeadersWith(resHeaders, this.extra),
          reqBody: req.finish(this.extra), resBody: res.finish(this.extra),
          error: err ? { message: err.message, stack: err.stack ?? null } : null,
          kind, rule,
        }
        this.insert(row, logs, logsTruncated)
      },
      // LOG frames can still arrive after the response ended (waitUntil work),
      // so those are appended to the stored row, batched: a logging loop
      // must not rewrite the row once per line.
      addLog: log => {
        if (!pushLog(log) || !finished || this.closed || this.lateLogs.has(meta.requestId)) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const write = () => {
          clearTimeout(timer)
          if (this.lateLogs.get(meta.requestId) !== write) return
          this.lateLogs.delete(meta.requestId)
          if (this.closed) return
          try {
            this.db.query("UPDATE requests SET logs = ?, logs_truncated = ? WHERE id = ?")
              .run(JSON.stringify(logs), logsTruncated ? 1 : 0, meta.requestId)
          } catch {}
        }
        this.lateLogs.set(meta.requestId, write)
        timer = setTimeout(write, LATE_LOG_FLUSH_MS)
        ;(timer as { unref?: () => void }).unref?.()
      },
    }
  }

  private insert(r: Omit<RequestSummary, "reqBytes" | "resBytes"> & {
    reqHeaders: [string, string][]; resHeaders: [string, string][]
    reqBody: CapturedBody; resBody: CapturedBody; error: RequestDetail["error"]
  }, logs: LogLine[], logsTruncated: boolean) {
    if (this.closed) return
    const reqHeaders = JSON.stringify(r.reqHeaders)
    const resHeaders = JSON.stringify(r.resHeaders)
    const reqBody = JSON.stringify(r.reqBody)
    const resBody = JSON.stringify(r.resBody)
    const error = r.error ? JSON.stringify(r.error) : null
    const logsJson = JSON.stringify(logs)
    // Approximate stored size: the variable-length columns plus a fixed overhead.
    const bytes = 256 + r.url.length + r.host.length + reqHeaders.length + resHeaders.length
      + reqBody.length + resBody.length + (error?.length ?? 0) + logsJson.length
    try {
      this.db.query(`INSERT OR REPLACE INTO requests
        (id, ts, fn, host, method, url, path, client_ip, status, outcome, cold, instance, queued_ms, ttfb_ms, total_ms,
         req_bytes, res_bytes, req_headers, res_headers, req_body, res_body, error, logs, logs_truncated, bytes, kind, rule)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        r.id, r.ts, r.fn, r.host, r.method, r.url, r.path, r.clientIp, r.status, r.outcome, r.cold ? 1 : 0,
        r.instance, r.queuedMs, r.ttfbMs, r.totalMs, r.reqBody.size, r.resBody.size,
        reqHeaders, resHeaders, reqBody, resBody, error, logsJson, logsTruncated ? 1 : 0, bytes, r.kind, r.rule)
    } catch (e) {
      console.error(`[fn-log] failed to store request ${r.id}: ${(e as Error).message}`)
      return
    }
    this.totalBytes += bytes
    // Enforce the size cap between hourly sweeps without a full scan per insert.
    if (this.totalBytes > this.maxBytes) this.sweep()
    const summary: RequestSummary = { ...pick(r), reqBytes: r.reqBody.size, resBytes: r.resBody.size }
    for (const cb of this.subscribers) {
      try { cb(summary) } catch {}
    }
  }

  query(f: QueryFilter = {}): RequestSummary[] {
    const where: string[] = []
    const args: (string | number)[] = []
    const status = f.status?.trim().toLowerCase()
    if (status) {
      const cls = /^([1-5])xx$/.exec(status)
      if (cls) { where.push("status >= ? AND status < ?"); args.push(+cls[1] * 100, +cls[1] * 100 + 100) }
      else if (/^\d{3}$/.test(status)) { where.push("status = ?"); args.push(+status) }
      else throw new Error(`bad status filter: ${f.status}`)
    }
    if (f.path) { where.push("substr(path, 1, ?) = ?"); args.push(f.path.length, f.path) }
    if (f.since !== undefined) { where.push("ts >= ?"); args.push(f.since) }
    if (f.before !== undefined) { where.push("ts < ?"); args.push(f.before) }
    const limit = Math.min(1000, Math.max(1, Math.floor(f.limit ?? 100)))
    const sql = `SELECT ${SUMMARY_COLS} FROM requests ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ts DESC, seq DESC LIMIT ${limit}`
    return (this.db.query(sql).all(...args) as Row[]).map(toSummary)
  }

  // Mode for requests that begin from now on (fn.log changed); open tails stay subscribed
  setMode(mode: "full" | "meta") {
    this.mode = mode
  }

  get(id: string): RequestDetail | null {
    this.lateLogs.get(id)?.()
    const r = this.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row | null
    if (!r) return null
    return {
      ...toSummary(r),
      reqHeaders: JSON.parse(r.req_headers),
      resHeaders: JSON.parse(r.res_headers),
      reqBody: JSON.parse(r.req_body),
      resBody: JSON.parse(r.res_body),
      error: r.error ? JSON.parse(r.error) : null,
      logs: JSON.parse(r.logs),
      logsTruncated: !!r.logs_truncated,
    }
  }

  // Drops rows older than 24h, then the oldest rows until under maxBytes.
  sweep(now: number = Date.now()) {
    if (this.closed) return
    this.db.query("DELETE FROM requests WHERE ts < ?").run(now - LOG_RETENTION_MS)
    this.db.query(`DELETE FROM requests WHERE seq IN (
      SELECT seq FROM (SELECT seq, SUM(bytes) OVER (ORDER BY ts DESC, seq DESC) AS cum FROM requests) WHERE cum > ?)`)
      .run(this.maxBytes)
    this.totalBytes = (this.db.query("SELECT COALESCE(SUM(bytes), 0) AS n FROM requests").get() as { n: number }).n
    this.db.run("PRAGMA incremental_vacuum")
  }

  subscribe(cb: (s: RequestSummary) => void): () => void {
    this.subscribers.add(cb)
    return () => { this.subscribers.delete(cb) }
  }

  close() {
    if (this.closed) return
    for (const write of [...this.lateLogs.values()]) write()
    this.closed = true
    this.subscribers.clear()
    this.db.close()
  }
}

const pick = (r: Omit<RequestSummary, "reqBytes" | "resBytes">): Omit<RequestSummary, "reqBytes" | "resBytes"> => ({
  id: r.id, ts: r.ts, fn: r.fn, host: r.host, method: r.method, url: r.url, path: r.path, clientIp: r.clientIp,
  status: r.status, outcome: r.outcome, cold: r.cold, instance: r.instance, queuedMs: r.queuedMs,
  ttfbMs: r.ttfbMs, totalMs: r.totalMs, kind: r.kind, rule: r.rule,
})

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

// Hop-by-hop and framing headers are recomputed for the new request.
const REPLAY_SKIP = new Set(["content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer"])

// Rebuilds a logged request so it can be sent to the current code. Redacted
// values aren't restored: those headers and query params are dropped.
export const replayRequest = (detail: RequestDetail, opts: { allowPartial?: boolean } = {}): Request => {
  const body = detail.reqBody
  const noBody = detail.method === "GET" || detail.method === "HEAD"
  if (!noBody && !opts.allowPartial) {
    if (body.kind === "binary") throw new Error(`request ${detail.id}: body was stored as a hash only (${body.size} bytes); pass allowPartial to replay without it`)
    if (body.kind === "omitted") throw new Error(`request ${detail.id}: body was not logged (meta mode); pass allowPartial to replay without it`)
    if (body.truncated) throw new Error(`request ${detail.id}: body was truncated (${body.size} bytes total); pass allowPartial to replay the captured part`)
  }

  const url = new URL(detail.url, `http://${detail.host || "localhost"}`)
  for (const [k, v] of [...url.searchParams]) {
    if (v === REDACTED) url.searchParams.delete(k, v)
  }
  const headers = new Headers()
  for (const [k, v] of detail.reqHeaders) {
    if (v === REDACTED || REPLAY_SKIP.has(k.toLowerCase())) continue
    headers.append(k, v)
  }
  const text = !noBody && body.kind === "text" ? body.text : null
  return new Request(url.toString(), { method: detail.method, headers, body: text })
}
