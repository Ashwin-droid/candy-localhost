import type React from "react"
import "./EmptyState.css"

/** A real empty state: one or two sentences and, when there is one, the action that fills it. */
export function EmptyState(p: { children: React.ReactNode; action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="ui-empty">
      <div className="ui-empty-text">{p.children}</div>
      {p.action ? <div className="ui-empty-action">{p.action}</div> : null}
    </div>
  )
}
