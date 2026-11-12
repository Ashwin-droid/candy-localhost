// Workers-style KV and D1 bindings for candy functions, backed by bun:sqlite.
// The APIs are promise-based like Cloudflare's, but run synchronously underneath.
// Several instances of one function may open the same files at once, so every
// connection uses WAL and a busy timeout.

import { Database, type Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { FnProjectConfig } from "./fn-config.ts"

const BINDING_RE = /^[A-Z_][A-Z0-9_]{0,63}$/i
const CLOSE = Symbol.for("candy.fn.close")

export const KV_MAX_KEY_BYTES = 512
export const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024
export const KV_MAX_METADATA_BYTES = 1024
export const KV_MIN_TTL_SECONDS = 60
export const KV_LIST_MAX = 1000

const enc = new TextEncoder()
const dec = new TextDecoder()

function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  // busy_timeout first, so switching to WAL waits on a concurrent opener instead of failing
  db.run("PRAGMA busy_timeout = 5000")
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL")
  return db
}

function checkBinding(binding: string) {
  if (!BINDING_RE.test(binding)) throw new Error(`invalid binding name: ${JSON.stringify(binding)}`)
}

// ---------------------------------------------------------------- KV

export type KVGetType = "text" | "json" | "arrayBuffer" | "stream"
export type KVPutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream
export type KVPutOptions = { expiration?: number; expirationTtl?: number; metadata?: unknown }
export type KVListOptions = { prefix?: string | null; limit?: number; cursor?: string | null }
export type KVListKey = { name: string; expiration?: number; metadata?: unknown }
export type KVListResult = { keys: KVListKey[]; list_complete: boolean; cursor?: string; cacheStatus: null }

export interface KVNamespace {
  get(key: string, type?: KVGetType | { type?: KVGetType; cacheTtl?: number }): Promise<any>
  get(keys: string[], type?: KVGetType | { type?: KVGetType; cacheTtl?: number }): Promise<Map<string, any>>
  getWithMetadata(key: string, type?: KVGetType | { type?: KVGetType; cacheTtl?: number }): Promise<{ value: any; metadata: any; cacheStatus: null }>
  put(key: string, value: KVPutValue, opts?: KVPutOptions): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: KVListOptions): Promise<KVListResult>
}

type KVRow = { value: Uint8Array; expiration: number | null; metadata: string | null }

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key === "") throw new TypeError("KV key must be a non-empty string")
  if (key === "." || key === "..") throw new TypeError(`KV key cannot be "${key}"`)
  if (enc.encode(key).byteLength > KV_MAX_KEY_BYTES) throw new TypeError(`KV key is longer than ${KV_MAX_KEY_BYTES} bytes`)
}

function readType(t: unknown): KVGetType {
  const type = (typeof t === "object" && t !== null ? (t as { type?: KVGetType }).type : t) ?? "text"
  if (type !== "text" && type !== "json" && type !== "arrayBuffer" && type !== "stream") {
    throw new TypeError(`unknown KV get type: ${String(type)}`)
  }
  return type
}

function decodeValue(bytes: Uint8Array, type: KVGetType): unknown {
  switch (type) {
    case "text": return dec.decode(bytes)
    case "json": return JSON.parse(dec.decode(bytes))
    case "arrayBuffer": return bytes.slice().buffer
    case "stream": {
      const copy = bytes.slice()
      return new ReadableStream<Uint8Array>({ start(c) { if (copy.byteLength) c.enqueue(copy); c.close() } })
    }
  }
}

async function valueBytes(value: KVPutValue): Promise<Uint8Array> {
  if (typeof value === "string") return enc.encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  if (value instanceof ReadableStream) {
    // read with a running cap so a huge stream fails early instead of filling memory
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = value.getReader()
    for (;;) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      const b = typeof chunk === "string" ? enc.encode(chunk) : new Uint8Array(chunk as ArrayBufferLike)
      total += b.byteLength
      if (total > KV_MAX_VALUE_BYTES) { reader.cancel().catch(() => {}); throw new TypeError(`KV value is larger than ${KV_MAX_VALUE_BYTES} bytes`) }
      chunks.push(b)
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.byteLength }
    return out
  }
  throw new TypeError("KV put value must be a string, ArrayBuffer, ArrayBufferView or ReadableStream")
}

// Cursors are opaque to callers; ours is just the last key returned
const encodeCursor = (key: string) => Buffer.from(key, "utf8").toString("base64url")
const decodeCursor = (c: string) => Buffer.from(c, "base64url").toString("utf8")

export function createKV(dbPath: string, binding: string, opts: { now?: () => number } = {}): KVNamespace {
  checkBinding(binding)
  const now = opts.now ?? Date.now
  const nowSec = () => now() / 1000
  const db = openDb(dbPath)
  const table = `"kv_${binding}"`
  db.run(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER, metadata TEXT) WITHOUT ROWID`)

  const qGet = db.query<KVRow, [string]>(`SELECT value, expiration, metadata FROM ${table} WHERE key = ?`)
  const qPut = db.query(`INSERT OR REPLACE INTO ${table} (key, value, expiration, metadata) VALUES (?, ?, ?, ?)`)
  const qDel = db.query(`DELETE FROM ${table} WHERE key = ?`)
  const qDelExpired = db.query(`DELETE FROM ${table} WHERE key = ? AND expiration IS NOT NULL AND expiration <= ?`)
  const qSweep = db.query(`DELETE FROM ${table} WHERE expiration IS NOT NULL AND expiration <= ?`)
  // substr compare instead of LIKE/GLOB so prefixes need no escaping; key order is byte order (BINARY collation)
  const qList = db.query<{ key: string; expiration: number | null; metadata: string | null }, [string, number, string, number]>(
    `SELECT key, expiration, metadata FROM ${table}
     WHERE substr(key, 1, length(?1)) = ?1 AND key > ?3 AND (expiration IS NULL OR expiration > ?2)
     ORDER BY key LIMIT ?4`)

  let writesSinceSweep = 0

  const live = (key: string): KVRow | null => {
    const row = qGet.get(key)
    if (!row) return null
    if (row.expiration !== null && row.expiration <= nowSec()) {
      // lazy sweep; a failure here (e.g. another instance holds the write lock) is harmless
      try { qDelExpired.run(key, nowSec()) } catch {}
      return null
    }
    return row
  }

  const getOne = (key: string, type: KVGetType) => {
    checkKey(key)
    const row = live(key)
    return row ? decodeValue(row.value, type) : null
  }

  const kv: KVNamespace & { [CLOSE](): void } = {
    async get(key: any, t?: any): Promise<any> {
      const type = readType(t)
      if (Array.isArray(key)) {
        if (type === "arrayBuffer" || type === "stream") throw new TypeError(`bulk KV get does not support type "${type}"`)
        if (key.length > 100) throw new TypeError("bulk KV get takes at most 100 keys")
        return new Map(key.map((k: string) => [k, getOne(k, type)]))
      }
      return getOne(key, type)
    },

    async getWithMetadata(key, t) {
      const type = readType(t)
      checkKey(key)
      const row = live(key)
      if (!row) return { value: null, metadata: null, cacheStatus: null }
      return { value: decodeValue(row.value, type), metadata: row.metadata === null ? null : JSON.parse(row.metadata), cacheStatus: null }
    },

    async put(key, value, o = {}) {
      checkKey(key)
      let expiration: number | null = null
      if (o.expirationTtl !== undefined && o.expirationTtl !== null) {
        const ttl = Number(o.expirationTtl)
        if (!Number.isFinite(ttl) || ttl < KV_MIN_TTL_SECONDS) throw new TypeError(`expirationTtl must be at least ${KV_MIN_TTL_SECONDS} seconds`)
        expiration = Math.floor(nowSec() + ttl)
      } else if (o.expiration !== undefined && o.expiration !== null) {
        const exp = Number(o.expiration)
        if (!Number.isFinite(exp) || exp < nowSec() + KV_MIN_TTL_SECONDS) throw new TypeError(`expiration must be at least ${KV_MIN_TTL_SECONDS} seconds in the future`)
        expiration = Math.floor(exp)
      }
      let metadata: string | null = null
      if (o.metadata !== undefined && o.metadata !== null) {
        metadata = JSON.stringify(o.metadata)
        if (metadata === undefined) throw new TypeError("KV metadata must be JSON-serializable")
        if (enc.encode(metadata).byteLength > KV_MAX_METADATA_BYTES) throw new TypeError(`KV metadata is larger than ${KV_MAX_METADATA_BYTES} bytes`)
      }
      const bytes = await valueBytes(value)
      if (bytes.byteLength > KV_MAX_VALUE_BYTES) throw new TypeError(`KV value is larger than ${KV_MAX_VALUE_BYTES} bytes`)
      qPut.run(key, bytes, expiration, metadata)
      if (++writesSinceSweep >= 100) { writesSinceSweep = 0; qSweep.run(nowSec()) }
    },

    async delete(key) {
      checkKey(key)
      qDel.run(key)
    },

    async list(o = {}) {
      const prefix = o.prefix ?? ""
      let limit = o.limit ?? KV_LIST_MAX
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError("KV list limit must be a positive integer")
      limit = Math.min(limit, KV_LIST_MAX)
      const after = o.cursor ? decodeCursor(o.cursor) : ""
      try { qSweep.run(nowSec()) } catch {}
      // one extra row tells us whether there is another page
      const rows = qList.all(prefix, nowSec(), after, limit + 1)
      const page = rows.slice(0, limit)
      const keys = page.map(r => {
        const k: KVListKey = { name: r.key }
        if (r.expiration !== null) k.expiration = r.expiration
        if (r.metadata !== null) k.metadata = JSON.parse(r.metadata)
        return k
      })
      if (rows.length > limit) return { keys, list_complete: false, cursor: encodeCursor(page[page.length - 1].key), cacheStatus: null }
      return { keys, list_complete: true, cacheStatus: null }
    },

    [CLOSE]() { db.close() },
  }
  return kv
}

// ---------------------------------------------------------------- D1

export type D1Meta = {
  duration: number
  changes: number
  last_row_id: number
  rows_read: number
  rows_written: number
  changed_db: boolean
  size_after: number
}
export type D1Result<T = Record<string, unknown>> = { results: T[]; success: true; meta: D1Meta }
export type D1ExecResult = { count: number; duration: number }

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(column?: string): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>
  raw<T = unknown[]>(opts?: { columnNames?: boolean }): Promise<T[]>
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
  exec(sql: string): Promise<D1ExecResult>
  dump(): Promise<ArrayBuffer>
}

function d1Error(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.startsWith("D1_")) return e as Error
  return new Error(`D1_ERROR: ${msg}`, { cause: e })
}

// D1 accepts null, numbers, strings, booleans (as 0/1) and binary; undefined is a type error
function bindValue(v: unknown, i: number): unknown {
  if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "bigint") return v
  if (typeof v === "boolean") return v ? 1 : 0
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Array.isArray(v) && v.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return new Uint8Array(v)
  const type = v === undefined ? "undefined" : typeof v
  throw new Error(`D1_TYPE_ERROR: Type '${type}' not supported for value '${String(v)}' at position ${i + 1}`)
}

// D1 returns BLOB columns as plain number arrays
function convertCell(v: unknown): unknown {
  return v instanceof Uint8Array ? Array.from(v) : v
}
function convertRow(row: Record<string, unknown>): Record<string, unknown> {
  for (const k in row) row[k] = convertCell(row[k])
  return row
}

// Splits a multi-statement script on top-level semicolons, skipping quotes and comments.
// CREATE TRIGGER bodies contain semicolons inside BEGIN ... END, so those are kept whole.
export function splitSql(sql: string): string[] {
  const out: string[] = []
  let start = 0
  let depth = 0 // BEGIN/END nesting for triggers
  let heads: string[] = [] // first words of the current statement
  let i = 0
  const n = sql.length
  const word = /[A-Za-z_]/
  while (i < n) {
    const c = sql[i]
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c
      i++
      while (i < n) {
        if (sql[i] === close) { if (close !== "]" && sql[i + 1] === close) { i += 2; continue } break }
        i++
      }
      i++
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end < 0 ? n : end + 2
    } else if (word.test(c) && (i === 0 || !/[A-Za-z0-9_$]/.test(sql[i - 1]))) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++
      const w = sql.slice(i, j).toUpperCase()
      if (heads.length < 3) heads.push(w)
      // only count BEGIN/END/CASE inside a CREATE [TEMP] TRIGGER statement
      if (heads[0] === "CREATE" && (heads[1] === "TRIGGER" || ((heads[1] === "TEMP" || heads[1] === "TEMPORARY") && heads[2] === "TRIGGER"))) {
        if (w === "BEGIN" || w === "CASE") depth++
        else if (w === "END" && depth > 0) depth--
      }
      i = j
    } else if (c === ";" && depth === 0) {
      const stmt = sql.slice(start, i).trim()
      if (stripComments(stmt).trim()) out.push(stmt)
      start = i + 1
      heads = []
      i++
    } else i++
  }
  const tail = sql.slice(start).trim()
  if (stripComments(tail).trim()) out.push(tail)
  return out
}

function stripComments(s: string): string {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?(\*\/|$)/g, "")
}

const STMT = Symbol("candy.d1.stmt")
type Bound = { db: D1Impl; sql: string; params: unknown[] }

class D1Impl {
  readonly db: Database
  private qChanges: Statement<{ t: number; r: number }>
  private qSize: Statement<{ s: number }>

  constructor(readonly path: string) {
    this.db = openDb(path)
    this.qChanges = this.db.query("SELECT total_changes() AS t, last_insert_rowid() AS r")
    this.qSize = this.db.query("SELECT page_count * page_size AS s FROM pragma_page_count(), pragma_page_size()")
  }

  // Runs one bound statement synchronously and builds a D1-shaped result
  execute(b: Bound, mode: "objects" | "values"): { rows: unknown[]; columns: string[]; meta: D1Meta } {
    const t0 = performance.now()
    let stmt: Statement
    try { stmt = this.db.query(b.sql) } catch (e) { throw d1Error(e) }
    // sqlite binds missing parameters as NULL; D1 refuses them, which catches forgotten bind() calls
    if (stmt.paramsCount !== b.params.length) {
      throw new Error(`D1_ERROR: Wrong number of parameter bindings for SQL query (expected ${stmt.paramsCount}, got ${b.params.length})`)
    }
    const before = this.qChanges.get()!.t
    let rows: unknown[]
    try {
      if (stmt.columnNames.length > 0) rows = mode === "values" ? stmt.values(...(b.params as any[])) : stmt.all(...(b.params as any[]))
      else { stmt.run(...(b.params as any[])); rows = [] }
    } catch (e) { throw d1Error(e) }
    const after = this.qChanges.get()!
    const changes = after.t - before
    rows = mode === "values"
      ? (rows as unknown[][]).map(r => r.map(convertCell))
      : (rows as Record<string, unknown>[]).map(convertRow)
    const meta: D1Meta = {
      duration: performance.now() - t0,
      changes,
      last_row_id: Number(after.r),
      // sqlite doesn't report rows scanned; rows returned is the closest cheap figure
      rows_read: rows.length,
      rows_written: changes,
      changed_db: changes > 0,
      size_after: this.qSize.get()?.s ?? 0,
    }
    return { rows, columns: stmt.columnNames, meta }
  }
}

function makeStatement(b: Bound): D1PreparedStatement {
  const s: D1PreparedStatement & { [STMT]: Bound } = {
    [STMT]: b,
    bind(...values) {
      return makeStatement({ ...b, params: values.map(bindValue) })
    },
    async first(column?: string) {
      const { rows } = b.db.execute(b, "objects")
      const row = rows[0] as Record<string, unknown> | undefined
      if (!row) return null
      if (column === undefined) return row as any
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`)
      return row[column] as any
    },
    async all() {
      const { rows, meta } = b.db.execute(b, "objects")
      return { results: rows as any[], success: true, meta }
    },
    async run() {
      const { rows, meta } = b.db.execute(b, "objects")
      return { results: rows as any[], success: true, meta }
    },
    async raw(opts = {}) {
      const { rows, columns } = b.db.execute(b, "values")
      return (opts.columnNames ? [columns, ...rows] : rows) as any[]
    },
  }
  return s
}

export function createD1(dbPath: string): D1Database {
  const impl = new D1Impl(dbPath)
  const d1: D1Database & { [CLOSE](): void } = {
    prepare(sql) {
      if (typeof sql !== "string" || !sql.trim()) throw new Error("D1_ERROR: prepare() needs a SQL string")
      return makeStatement({ db: impl, sql, params: [] })
    },

    async batch(statements) {
      const bound = statements.map(st => {
        const b = (st as any)?.[STMT] as Bound | undefined
        if (!b) throw new Error("D1_ERROR: batch() takes statements from prepare()")
        if (b.db !== impl) throw new Error("D1_ERROR: batch() statements must come from this database")
        return b
      })
      // all or nothing: any failure rolls the whole batch back
      try {
        return impl.db.transaction(() => bound.map(b => {
          const { rows, meta } = impl.execute(b, "objects")
          return { results: rows as any[], success: true as const, meta }
        })).immediate()
      } catch (e) { throw d1Error(e) }
    },

    async exec(sql) {
      const t0 = performance.now()
      const stmts = splitSql(sql)
      let count = 0
      for (const s of stmts) {
        try { impl.db.run(s) } catch (e) { throw d1Error(e) }
        count++
      }
      return { count, duration: performance.now() - t0 }
    },

    async dump() {
      // serialize() gives a consistent image including pages still in the WAL
      const bytes = new Uint8Array(impl.db.serialize())
      // header bytes 18/19 say "WAL mode"; reset them to legacy so the image opens anywhere,
      // including read-only or in-memory (deserialize) where no -wal file can exist
      if (bytes.byteLength >= 100 && bytes[18] === 2) { bytes[18] = 1; bytes[19] = 1 }
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },

    [CLOSE]() { impl.db.close() },
  }
  return d1
}

// ---------------------------------------------------------------- env

export function buildEnv(cfg: FnProjectConfig, stateDir: string, secrets: Record<string, string>): Record<string, unknown> {
  const env: Record<string, unknown> = { ...(cfg.vars ?? {}), ...secrets }
  const kv = cfg.kv ?? []
  const d1 = cfg.d1 ?? []
  for (const b of [...kv, ...d1]) checkBinding(b)
  mkdirSync(stateDir, { recursive: true })
  for (const b of kv) env[b] = createKV(join(stateDir, "kv.sqlite"), b)
  for (const b of d1) env[b] = createD1(join(stateDir, `d1-${b}.sqlite`))
  return env
}

export function closeBindings(env: Record<string, unknown>): void {
  for (const v of Object.values(env)) {
    const close = (v as any)?.[CLOSE]
    if (typeof close === "function") {
      try { close.call(v) } catch {}
    }
  }
}
