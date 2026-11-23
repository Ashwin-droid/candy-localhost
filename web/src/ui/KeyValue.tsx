import type React from "react"
import "./KeyValue.css"

export interface KVRow { label: string; value: React.ReactNode; mono?: boolean; hint?: React.ReactNode;
                         action?: React.ReactNode; rawKey?: string /* candy.json key, --ink-3, wide screens */; hidden?: boolean }

const isEmpty = (v: React.ReactNode) => v === null || v === undefined || v === "" || v === false

/** Facts as label / value rows on a sheet. An empty value shows "—". Values render as React text, never HTML. */
export function KeyValue(p: { rows: KVRow[]; labelWidth?: number /* default 160 */ }): React.JSX.Element {
  const rows = p.rows.filter(r => !r.hidden)
  return (
    <dl className="ui-kv" style={p.labelWidth ? { ["--kv-label" as string]: `${p.labelWidth}px` } as React.CSSProperties : undefined}>
      {rows.map((r, i) => (
        <div className="ui-kv-row" key={`${r.label}-${i}`}>
          <dt className="ui-kv-label">
            <span>{r.label}</span>
            {r.rawKey ? <code className="ui-kv-raw" title={`${r.rawKey} in candy.json`}>{r.rawKey}</code> : null}
          </dt>
          <dd className="ui-kv-value">
            <div className={r.mono ? "ui-kv-v mono" : "ui-kv-v"}>{isEmpty(r.value) ? <span className="ui-kv-empty">—</span> : r.value}</div>
            {r.hint ? <div className="ui-kv-hint">{r.hint}</div> : null}
          </dd>
          <dd className="ui-kv-action">{r.action ?? null}</dd>
        </div>
      ))}
    </dl>
  )
}
