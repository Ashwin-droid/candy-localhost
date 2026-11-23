import type React from "react"
import { useRef, useState } from "react"
import { Link } from "../router.tsx"
import { EmptyState } from "./EmptyState.tsx"
import { ErrorState } from "./ErrorState.tsx"
import { Icon } from "./icons.tsx"
import { Skeleton } from "./Skeleton.tsx"
import "./Table.css"

export interface Column<T> {
  key: string; label: string; render: (row: T, index: number) => React.ReactNode
  align?: "left" | "right"; mono?: boolean; width?: string
  priority?: 1 | 2 | 3               // 1 always; 2 hidden < 640 (moved into the stacked block); 3 hidden < 1024
  sort?: (a: T, b: T) => number      // makes the header a sort button with aria-sort
}
export interface TableProps<T> {
  columns: Column<T>[]; rows: T[] | undefined; rowKey: (row: T, index: number) => string
  rowHref?: (row: T) => string       // whole row is a link
  onRowClick?: (row: T, index: number) => void; selectedKey?: string | null
  actions?: (row: T, index: number) => React.ReactNode   // at most two compact quiet buttons
  loading?: boolean; error?: string | null; onRetry?: () => void
  empty?: React.ReactNode; maxRows?: number /* default none; footer "Showing N of M. Filter to narrow it." */
  sortKey?: string; sortDir?: 1 | -1; onSort?: (key: string, dir: 1 | -1) => void
  label: string                      // aria-label
  freeze?: boolean                   // keep the previous rows on screen (Machine while pointer is down)
}

const cellClass = (c: { align?: string; mono?: boolean; priority?: number }, extra = "") =>
  ["ui-td", c.align === "right" ? "is-right" : "", c.mono ? "is-mono" : "", `p${c.priority ?? 1}`, extra].filter(Boolean).join(" ")

/**
 * A data table on its own sheet. Sorting is controlled when sortKey/onSort are given, otherwise kept here;
 * rows are sorted by the active column's `sort`. Below 640px each row becomes a block: priority-1 cells on
 * the first line, priority-2 cells as small label/value pairs under it, priority-3 cells hidden.
 */
export function Table<T>(p: TableProps<T>): React.JSX.Element {
  const [own, setOwn] = useState<{ key?: string; dir: 1 | -1 }>({ dir: 1 })
  const frozen = useRef<T[] | undefined>(undefined)
  if (!p.freeze) frozen.current = p.rows
  const source = p.freeze ? frozen.current ?? p.rows : p.rows

  const sortKey = p.sortKey ?? own.key
  const sortDir = p.sortKey !== undefined ? p.sortDir ?? 1 : own.dir
  const sortCol = p.columns.find(c => c.key === sortKey && c.sort)
  const indexed = (source ?? []).map((row, i) => ({ row, i }))
  if (sortCol?.sort) {
    const s = sortCol.sort
    indexed.sort((a, b) => s(a.row, b.row) * sortDir || a.i - b.i)
  }
  const total = indexed.length
  const shown = p.maxRows !== undefined ? indexed.slice(0, p.maxRows) : indexed

  const toggleSort = (key: string) => {
    const dir: 1 | -1 = sortKey === key ? (sortDir === 1 ? -1 : 1) : 1
    if (p.onSort) p.onSort(key, dir)
    else setOwn({ key, dir })
  }

  let body: React.ReactNode = null
  if (source === undefined) {
    if (p.error) body = <ErrorState error={p.error} onRetry={p.onRetry} />
    else body = <Skeleton rows={3} />
  } else if (total === 0) {
    body = p.error ? <ErrorState error={p.error} onRetry={p.onRetry} /> : <EmptyState>{p.empty ?? "Nothing here yet."}</EmptyState>
  }
  const primary = p.columns.filter(c => (c.priority ?? 1) === 1)
  const firstPrimaryKey = primary[0]?.key ?? p.columns[0]?.key

  return (
    <div className={p.loading && source !== undefined ? "ui-table-frame is-refreshing" : "ui-table-frame"}>
      {body ?? (
        <div className="ui-table-scroll">
          <table className="ui-table" aria-label={p.label}>
            <thead>
              <tr>
                {p.columns.map(c => {
                  const active = sortCol?.key === c.key
                  return (
                    <th key={c.key} scope="col" className={cellClass(c, "ui-th")} style={c.width ? { width: c.width } : undefined}
                      aria-sort={c.sort ? (active ? (sortDir === 1 ? "ascending" : "descending") : "none") : undefined}>
                      {c.sort ? (
                        <button type="button" className={active ? "ui-th-sort is-active" : "ui-th-sort"} onClick={() => toggleSort(c.key)}>
                          {c.label}
                          <Icon name="chevron-down" size={12} className={active && sortDir === -1 ? "ui-th-arrow is-desc" : "ui-th-arrow"} />
                        </button>
                      ) : c.label}
                    </th>
                  )
                })}
                {p.actions ? <th className="ui-td ui-th ui-td-actions" scope="col"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.map(({ row, i }) => {
                const key = p.rowKey(row, i)
                const href = p.rowHref?.(row)
                const selected = p.selectedKey !== undefined && p.selectedKey !== null && p.selectedKey === key
                const clickable = !!p.onRowClick && !href
                const cls = ["ui-tr", href || clickable ? "is-linked" : "", selected ? "is-selected" : ""].filter(Boolean).join(" ")
                return (
                  <tr key={key} className={cls} aria-selected={p.selectedKey !== undefined ? selected : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? (e) => { if (!(e.target as HTMLElement).closest("a,button,input,select,textarea")) p.onRowClick!(row, i) } : undefined}
                    onKeyDown={clickable ? (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); p.onRowClick!(row, i) } } : undefined}>
                    {p.columns.map(c => {
                      const content = c.render(row, i)
                      const isFirst = c.key === firstPrimaryKey
                      return (
                        <td key={c.key} className={cellClass(c)} data-label={c.label}>
                          {href && isFirst ? (
                            <Link to={href} className="ui-row-link" onClick={() => p.onRowClick?.(row, i)}>{content}</Link>
                          ) : content}
                        </td>
                      )
                    })}
                    {p.actions ? <td className="ui-td ui-td-actions"><div className="ui-row-actions">{p.actions(row, i)}</div></td> : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {body === null && p.maxRows !== undefined && total > shown.length ? (
        <div className="ui-table-foot">Showing {shown.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")}. Filter to narrow it.</div>
      ) : null}
      {body === null && p.error ? <div className="ui-table-foot is-error">Couldn’t refresh: {p.error}</div> : null}
    </div>
  )
}
