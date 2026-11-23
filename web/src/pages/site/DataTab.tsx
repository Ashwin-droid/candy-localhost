// Data tab: a browser for the function's KV namespaces and D1 databases. The bindings come from its candy.json
// (fn.kv / fn.d1), so nothing is typed to find data: keys and tables load when a store is opened.
// Keys and values are whatever the function stored (often its visitors' input): they render as text only, and
// table rows are keyed by their index in the loaded list, never by key text.

import type React from "react"
import { useEffect, useReducer, useRef, useState } from "react"
import { getApi } from "../../api/client.ts"
import type { D1Response, KvListResponse } from "../../api/types.ts"
import { fmtDate, fmtMs } from "../../lib/format.ts"
import type { TabProps } from "../../lib/site.ts"
import { Link, useRoute } from "../../router.tsx"
import {
  Button, type Column, Code, CopyButton, EmptyState, errorMessage, Field, Icon, Input, Table, Textarea, useConfirm,
} from "../../ui/index.ts"
import "./data.css"

// ---------- pure helpers (tested) ----------

export type KvKey = KvListResponse["keys"][number]

/** A KV expiration: seconds or milliseconds since the epoch (auto-detected), as a local date. "—" when none. */
export function kvExpires(exp: unknown): string {
  const n = Number(exp)
  if (exp === undefined || exp === null || !Number.isFinite(n) || n <= 0) return "—"
  return fmtDate(n < 1e12 ? n * 1000 : n) || "—"
}

/** The same, short for the table: "23 Nov, 14:12" (the year when it isn't this one). */
export function kvExpiresShort(exp: unknown, now: number = Date.now()): string {
  const full = kvExpires(exp)
  if (full === "—") return full
  const m = /^(\d+ \w+) (\d+), (\d\d:\d\d):\d\d$/.exec(full)
  if (!m) return full
  return m[2] === String(new Date(now).getFullYear()) ? `${m[1]}, ${m[3]}` : `${m[1]} ${m[2]}, ${m[3]}`
}

/** KV metadata as JSON text, "—" when there is none. */
export function kvMetadata(m: unknown): string {
  if (m === undefined || m === null) return "—"
  try { return JSON.stringify(m) ?? "—" } catch { return String(m) }
}

/** A D1 cell as text: NULL for null / missing, JSON for objects and arrays, else the value as a string. */
export function d1Cell(v: unknown): { text: string; isNull: boolean } {
  if (v === null || v === undefined) return { text: "NULL", isNull: true }
  if (typeof v === "object") {
    try { return { text: JSON.stringify(v), isNull: false } } catch { return { text: String(v), isNull: false } }
  }
  return { text: String(v), isNull: false }
}

/** Every key that appears in any row, in first-seen order. */
export function d1Columns(rows: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const r of rows) if (r && typeof r === "object" && !Array.isArray(r)) for (const k of Object.keys(r)) seen.add(k)
  return [...seen]
}

/** D1 durations are fractional milliseconds: "0.42 ms", "12 ms", "1.25 s". */
export const d1Duration = (ms: number): string => (ms > 0 && ms < 1 ? `${ms.toFixed(2)} ms` : fmtMs(ms))

export const PARAMS_ERROR = `Values for ? go in a list, like [1, "a"]`

/** The "Values for ?" field: empty = none, else it must parse to a JSON array. */
export function parseParams(text: string): { params?: unknown[]; error?: string } {
  const t = text.trim()
  if (!t) return {}
  let v: unknown
  try { v = JSON.parse(t) } catch { return { error: PARAMS_ERROR } }
  return Array.isArray(v) ? { params: v } : { error: PARAMS_ERROR }
}

export interface KvShown { key: string; binding: string; value: string | null }
export interface KvState {
  keys?: KvKey[]; binding: string; prefix: string; complete: boolean; cursor?: string
  listing: boolean; listError: string | null
  shown: KvShown | null; showError: string | null
  putKey: string; putValue: string
  status: { error: boolean; text: string } | null
}
export type KvAction =
  | { type: "listing" }
  | { type: "listed"; binding: string; prefix: string; res: KvListResponse; append: boolean }
  | { type: "listFailed"; error: string }
  | { type: "shown"; shown: KvShown }
  | { type: "showFailed"; error: string }
  | { type: "deleted"; key: string; binding: string }
  | { type: "put"; key: string; binding: string }
  | { type: "edit" }
  | { type: "field"; putKey?: string; putValue?: string }
  | { type: "status"; status: KvState["status"] }

export const KV_INITIAL: KvState = {
  binding: "KV", prefix: "", complete: true, listing: false, listError: null, shown: null, showError: null,
  putKey: "", putValue: "", status: null,
}

export function kvReducer(s: KvState, a: KvAction): KvState {
  switch (a.type) {
    case "listing": return { ...s, listing: true }
    case "listed": {
      const got = Array.isArray(a.res.keys) ? a.res.keys : []
      return {
        ...s, listing: false, listError: null, binding: a.binding, prefix: a.prefix,
        keys: a.append ? [...(s.keys ?? []), ...got] : got,
        complete: a.res.list_complete !== false, cursor: a.res.list_complete === false ? a.res.cursor : undefined,
      }
    }
    case "listFailed": return { ...s, listing: false, listError: a.error }
    case "shown": return { ...s, shown: a.shown, showError: null }
    case "showFailed": return { ...s, showError: a.error }
    case "deleted": {
      const cleared = s.shown && s.shown.key === a.key && s.shown.binding === a.binding
      return { ...s, shown: cleared ? null : s.shown, status: { error: false, text: `Deleted ${a.key}` } }
    }
    case "put": {
      // the shown value is out of date once it has been replaced
      const stale = s.shown && s.shown.key === a.key && s.shown.binding === a.binding
      return { ...s, putValue: "", shown: stale ? null : s.shown, status: { error: false, text: `Saved ${a.key} in ${a.binding}` } }
    }
    case "edit": return s.shown && s.shown.value !== null ? { ...s, putKey: s.shown.key, putValue: s.shown.value } : s
    case "field": return { ...s, ...(a.putKey !== undefined ? { putKey: a.putKey } : {}), ...(a.putValue !== undefined ? { putValue: a.putValue } : {}) }
    case "status": return { ...s, status: a.status }
  }
}

/** A table or view name as a quoted SQL identifier. */
export const d1Ident = (name: string): string => `"${name.replace(/"/g, '""')}"`

export const D1_TABLES_SQL =
  "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"

export interface Store { kind: "kv" | "d1"; binding: string }

/** The stores a function has, from its summary. A daemon that doesn't report them yet gets the usual names. */
export function storesOf(fn: { kv?: string[] | null; d1?: string[] | null } | null): Store[] {
  const kv = fn?.kv ?? ["KV"], d1 = fn?.d1 ?? ["DB"]
  return [...kv.map(binding => ({ kind: "kv" as const, binding })), ...d1.map(binding => ({ kind: "d1" as const, binding }))]
}

/** The store the URL names (?kv=NAME or ?d1=NAME), else the first one. */
export function pickStore(stores: Store[], query: URLSearchParams): Store | null {
  for (const kind of ["kv", "d1"] as const) {
    const b = query.get(kind)
    const hit = b ? stores.find(s => s.kind === kind && s.binding === b) : undefined
    if (hit) return hit
  }
  return stores[0] ?? null
}

// ---------- KV ----------

function KvStore(p: { name: string; binding: string }): React.JSX.Element {
  const { name, binding } = p
  const confirm = useConfirm()
  const [prefix, setPrefix] = useState("")
  const [s, dispatch] = useReducer(kvReducer, { ...KV_INITIAL, binding, listing: true })
  const [mode, setMode] = useState<"view" | "edit" | "add" | null>(null)
  const [putError, setPutError] = useState<string | null>(null)
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const kv = <T,>(body: Record<string, unknown>) => getApi().post<T>("/fn/kv", { name, binding, ...body })

  const list = async (o: { prefix?: string; append?: boolean } = {}) => {
    const pre = o.prefix ?? prefix
    dispatch({ type: "listing" })
    try {
      const res = await kv<KvListResponse>({ op: "list", ...(pre ? { prefix: pre } : {}), ...(o.append && s.cursor ? { cursor: s.cursor } : {}) })
      dispatch({ type: "listed", binding, prefix: pre, res, append: !!o.append })
    } catch (e) {
      dispatch({ type: "listFailed", error: `Couldn’t list keys: ${errorMessage(e)}` })
    }
  }

  // keys load when the store opens, and again a moment after the filter stops changing
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; void list(); return }
    const t = setTimeout(() => void list(), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix])

  const show = async (i: number) => {
    const k = s.keys?.[i]
    if (!k) return
    setBusyRow(i)
    try {
      const res = await kv<{ value: unknown }>({ op: "get", key: k.name })
      const v = res && typeof res === "object" && "value" in res ? res.value : res
      dispatch({ type: "shown", shown: { key: k.name, binding, value: v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v, null, 2) } })
      setMode("view")
    } catch (e) {
      dispatch({ type: "showFailed", error: `Couldn’t read ${k.name}: ${errorMessage(e)}` })
    } finally { setBusyRow(null) }
  }

  const remove = async (key: string) => {
    const b = binding
    const ok = await confirm({ title: `Delete ${key} from ${b}?`, verb: "Delete", danger: true })
    if (!ok) return
    try {
      await kv({ op: "delete", key })
      dispatch({ type: "deleted", key, binding: b })
      if (s.shown?.key === key) setMode(null)
      void list()
    } catch (e) {
      dispatch({ type: "status", status: { error: true, text: `Couldn’t delete: ${errorMessage(e)}` } })
    }
  }

  const put = async (e: React.FormEvent) => {
    e.preventDefault()
    const key = s.putKey
    if (!key) { setPutError("Enter a key"); return }
    setPutError(null)
    setSaving(true)
    try {
      await kv({ op: "put", key, value: s.putValue })
      dispatch({ type: "put", key, binding })
      dispatch({ type: "field", putKey: "" })
      setMode(null)
      void list()
    } catch (err) {
      dispatch({ type: "status", status: { error: true, text: `Couldn’t save: ${errorMessage(err)}` } })
    } finally { setSaving(false) }
  }

  const startAdd = () => { dispatch({ type: "field", putKey: "", putValue: "" }); setPutError(null); setMode("add") }
  const close = () => { setMode(null); setPutError(null) }

  const columns: Column<KvKey>[] = [
    { key: "key", label: "Key", mono: true, render: k => <span className="data-key" title={String(k.name)}>{String(k.name)}</span> },
    { key: "expires", label: "Expires", priority: 2, render: k => <span className={k.expiration ? "nowrap" : "ink-3"} title={k.expiration ? kvExpires(k.expiration) : undefined}>{kvExpiresShort(k.expiration)}</span> },
    { key: "meta", label: "Metadata", mono: true, priority: 3, render: k => { const t = kvMetadata(k.metadata); return <span className={t === "—" ? "ink-3" : "data-meta"} title={t}>{t}</span> } },
  ]
  const count = s.keys?.length ?? 0
  const open = mode !== null && (mode === "add" || s.shown !== null)

  return (
    <div className="store">
      <header className="store-head">
        <div className="store-title">
          <h2><span className="store-name">{binding}</span></h2>
          <p className="store-sub">
            {s.keys === undefined ? "Key-value storage" : `${count.toLocaleString("en-US")}${s.complete ? "" : "+"} ${count === 1 ? "key" : "keys"}${s.prefix ? ` starting with ${s.prefix}` : ""}`}
          </p>
        </div>
        <div className="store-tools">
          <label className="store-filter">
            <Icon name="search" size={14} />
            <input type="search" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="Filter by prefix" aria-label="Keys starting with" spellCheck={false} autoComplete="off" />
          </label>
          <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={startAdd}>Add key</Button>
        </div>
      </header>

      {s.status ? (
        <div className={s.status.error ? "data-status is-error" : "data-status"} role="status">
          <Icon name={s.status.error ? "error" : "check"} size={14} />{s.status.text}
        </div>
      ) : null}
      {s.showError ? <div className="data-status is-error" role="alert"><Icon name="error" size={14} />{s.showError}</div> : null}

      <div className={open ? "kv-browser is-open" : "kv-browser"}>
        <div className="kv-keys">
          <Table<KvKey> label={`Keys in ${binding}`} columns={columns}
            rows={s.keys ?? (s.listError ? undefined : s.listing ? undefined : [])}
            rowKey={(_, i) => String(i)} loading={s.listing && !s.keys}
            onRowClick={(_, i) => void show(i)}
            selectedKey={mode !== "add" && s.shown && s.keys ? String(s.keys.findIndex(k => k.name === s.shown!.key)) : null}
            error={s.listError} onRetry={() => void list()}
            empty={`No keys in ${s.binding}${s.prefix ? ` starting with ${s.prefix}` : ""}.`}
            actions={(k, i) => <Button size="sm" variant="quiet" className="data-del" disabled={busyRow === i} onClick={() => void remove(k.name)}>Delete</Button>} />
          {s.keys && !s.complete ? (
            <div className="data-more">
              <span>There are more keys.</span>
              <Button size="sm" busy={s.listing} onClick={() => void list({ prefix: s.prefix, append: true })}>Load more</Button>
            </div>
          ) : null}
        </div>

        {open ? (
          <aside className="kv-pane" aria-label={mode === "add" ? "Add key" : "Key"}>
            {mode === "view" && s.shown ? <>
              <div className="kv-pane-head">
                <h3 className="kv-pane-title" title={s.shown.key}>{s.shown.key}</h3>
                <div className="kv-pane-actions">
                  {s.shown.value !== null ? <CopyButton text={s.shown.value} /> : null}
                  {s.shown.value !== null ? <Button size="sm" onClick={() => { dispatch({ type: "edit" }); setMode("edit") }}>Edit</Button> : null}
                  <Button size="sm" variant="quiet" className="data-del" onClick={() => void remove(s.shown!.key)}>Delete</Button>
                  <Button size="sm" variant="quiet" aria-label="Close" icon={<Icon name="x" size={14} />} onClick={close} />
                </div>
              </div>
              {s.shown.value === null
                ? <p className="kv-pane-empty">Not found. It may have expired.</p>
                : <div className="data-value"><Code block>{s.shown.value}</Code></div>}
            </> : (
              <form onSubmit={e => void put(e)} noValidate>
                <div className="kv-pane-head">
                  <h3 className="kv-pane-title">{mode === "edit" ? s.putKey : "Add key"}</h3>
                  <div className="kv-pane-actions">
                    <Button size="sm" variant="quiet" aria-label="Close" icon={<Icon name="x" size={14} />} onClick={close} />
                  </div>
                </div>
                <div className="fields kv-pane-fields">
                  {mode === "add" ? (
                    <Field label="Key" htmlFor="kv-key" error={putError} help="A key that exists gets the new value.">
                      <Input id="kv-key" mono autoFocus value={s.putKey} onChange={e => { setPutError(null); dispatch({ type: "field", putKey: e.target.value }) }} spellCheck={false} autoComplete="off" required />
                    </Field>
                  ) : null}
                  <Field label="Value" htmlFor="kv-value">
                    <Textarea id="kv-value" mono rows={10} autoFocus={mode === "edit"} value={s.putValue} onChange={e => dispatch({ type: "field", putValue: e.target.value })} spellCheck={false} />
                  </Field>
                </div>
                <div className="kv-pane-foot">
                  <Button onClick={close}>Cancel</Button>
                  <Button type="submit" variant="primary" busy={saving}>Save key</Button>
                </div>
              </form>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  )
}

// ---------- D1 ----------

type D1Row = Record<string, unknown>
type D1Result = { res: D1Response } | { error: string }

function D1Store(p: { name: string; binding: string }): React.JSX.Element {
  const { name, binding } = p
  const [tables, setTables] = useState<{ name: string; type: string }[] | undefined>(undefined)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [table, setTable] = useState<string | null>(null)
  const [sql, setSql] = useState("")
  const [paramText, setParamText] = useState("")
  const [paramError, setParamError] = useState<string | null>(null)
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<D1Result | null>(null)
  const query = (q: string, params?: unknown[]) => getApi().post<D1Response>("/fn/d1", { name, binding, sql: q, ...(params ? { params } : {}) })

  const exec = async (q: string, params?: unknown[]) => {
    setRunning(true)
    try { setResult({ res: await query(q, params) }) }
    catch (e) { setResult({ error: errorMessage(e) }) }
    finally { setRunning(false) }
  }

  const openTable = (t: string) => {
    const q = `SELECT * FROM ${d1Ident(t)} LIMIT 100`
    setTable(t); setSql(q); setSqlError(null); setParamText(""); setParamError(null)
    void exec(q)
  }

  const loadTables = async (openFirst: boolean) => {
    try {
      const res = await query(D1_TABLES_SQL)
      const rows = (Array.isArray(res.results) ? res.results : []).map(r => ({ name: String(r.name), type: String(r.type) }))
      setTables(rows); setTablesError(null)
      if (openFirst && rows[0]) openTable(rows[0].name)
    } catch (e) { setTables([]); setTablesError(errorMessage(e)) }
  }

  // the tables load when the database opens, and the first one is shown
  useEffect(() => {
    void loadTables(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async () => {
    if (running) return
    if (!sql.trim()) { setSqlError("Enter some SQL"); return }
    setSqlError(null)
    const pp = parseParams(paramText)
    if (pp.error) { setParamError(pp.error); return }
    setParamError(null)
    setTable(null)
    await exec(sql, pp.params)
    void loadTables(false)   // a CREATE or DROP shows in the list
  }

  let out: React.ReactNode = null
  if (result && "error" in result) {
    out = <div className="data-error" role="alert"><pre>{result.error}</pre></div>
  } else if (result) {
    const rows: D1Row[] = Array.isArray(result.res.results) ? result.res.results : []
    const cols = d1Columns(rows)
    const m = result.res.meta ?? ({} as Partial<D1Response["meta"]>)
    const columns: Column<D1Row>[] = cols.map(c => ({
      key: `c:${c}`, label: c, mono: true,
      align: rows.every(r => r?.[c] === null || r?.[c] === undefined || typeof r[c] === "number") && rows.some(r => typeof r?.[c] === "number") ? "right" : undefined,
      render: r => { const v = d1Cell(r?.[c]); return <span className={v.isNull ? "ink-3" : undefined} title={v.isNull ? undefined : v.text}>{v.text}</span> },
    }))
    out = (
      <div className="data-result">
        <ul className="d1-facts" aria-label="Query facts">
          {table ? <li className="d1-facts-table">{table}</li> : null}
          <li><span className="tnum">{rows.length.toLocaleString("en-US")}</span> {rows.length === 1 ? "row" : "rows"}</li>
          {m.changes ? <li><span className="tnum">{Number(m.changes).toLocaleString("en-US")}</span> changed</li> : null}
          {m.last_row_id ? <li>Last row id <span className="tnum">{String(m.last_row_id)}</span></li> : null}
          {typeof m.duration === "number" ? <li>{d1Duration(m.duration)}</li> : null}
          {result.res.truncated ? <li className="d1-facts-warn">Only the first rows are shown</li> : null}
        </ul>
        {rows.length && cols.length ? (
          <div className="d1-grid">
            <Table<D1Row> label="Query result" columns={columns} rows={rows} rowKey={(_, i) => String(i)} />
          </div>
        ) : <EmptyState>No rows.</EmptyState>}
      </div>
    )
  }

  return (
    <div className="store">
      <header className="store-head">
        <div className="store-title">
          <h2><span className="store-name">{binding}</span></h2>
          <p className="store-sub">{tables === undefined ? "SQL database" : `${tables.length} ${tables.length === 1 ? "table" : "tables"}`}</p>
        </div>
      </header>

      <div className="d1-browser">
        <nav className="d1-tables" aria-label={`Tables in ${binding}`}>
          <h3 className="d1-tables-title">Tables</h3>
          {tablesError ? <p className="d1-tables-note is-error">{tablesError}</p>
            : tables === undefined ? <p className="d1-tables-note">Loading…</p>
            : tables.length === 0 ? <p className="d1-tables-note">No tables yet.</p>
            : (
              <ul>
                {tables.map(t => (
                  <li key={t.name}>
                    <button type="button" className={t.name === table ? "d1-table is-active" : "d1-table"} aria-current={t.name === table ? "true" : undefined} onClick={() => openTable(t.name)} title={t.name}>
                      <span className="d1-table-name">{t.name}</span>
                      {t.type === "view" ? <span className="d1-table-kind">view</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </nav>

        <div className="d1-main">
          <form className="d1-console" noValidate onSubmit={e => { e.preventDefault(); void run() }}>
            <Textarea id="d1-sql" mono rows={3} value={sql} placeholder="SELECT * FROM sqlite_master" spellCheck={false} aria-label="SQL"
              invalid={!!sqlError}
              onChange={e => { setSql(e.target.value); setSqlError(null) }}
              onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run() } }} />
            <div className="d1-console-foot">
              <Input id="d1-params" mono value={paramText} placeholder={`Values for ?, like [1, "a"]`} aria-label="Values for ?" spellCheck={false} autoComplete="off"
                invalid={!!paramError}
                onChange={e => { setParamText(e.target.value); setParamError(null) }} />
              <span className="d1-console-hint">Ctrl-Enter runs it</span>
              <Button type="submit" variant="primary" busy={running}>{running ? "Running…" : "Run"}</Button>
            </div>
            {sqlError || paramError ? <p className="d1-console-error" role="alert">{sqlError ?? paramError}</p> : null}
          </form>
          <p className="data-warn"><Icon name="warn" size={14} />Runs on the function's own database, right away. Changes can't be undone.</p>
          {out}
        </div>
      </div>
    </div>
  )
}

// ---------- the tab ----------

export default function DataTab(p: TabProps): React.JSX.Element {
  const route = useRoute()
  const site = p.site.name
  const stores = storesOf(p.site.fn)
  const current = pickStore(stores, route.query)
  if (!current) {
    return (
      <EmptyState>
        {`${site} has no KV or D1 bindings. Add `}<code>{`"kv": ["KV"]`}</code>{` or `}<code>{`"d1": ["DB"]`}</code>{` to its candy.json, then reload it.`}
      </EmptyState>
    )
  }
  const group = (kind: Store["kind"], title: string) => {
    const items = stores.filter(s => s.kind === kind)
    if (!items.length) return null
    return (
      <div className="data-nav-group">
        <h3 className="data-nav-title">{title}</h3>
        <ul>
          {items.map(s => {
            const active = s.kind === current.kind && s.binding === current.binding
            return (
              <li key={s.binding}>
                <Link to={`${route.path}?${kind}=${encodeURIComponent(s.binding)}`} className={active ? "data-nav-item is-active" : "data-nav-item"} aria-current={active ? "page" : undefined}>{s.binding}</Link>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
  const key = `${current.kind}:${site}:${current.binding}`
  return (
    <div className="data">
      <nav className="data-nav" aria-label="Stores">
        {group("kv", "KV")}
        {group("d1", "D1")}
      </nav>
      <div className="data-main">
        {current.kind === "kv" ? <KvStore key={key} name={site} binding={current.binding} /> : <D1Store key={key} name={site} binding={current.binding} />}
      </div>
    </div>
  )
}
