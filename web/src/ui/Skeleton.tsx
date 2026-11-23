import type React from "react"
import "./Skeleton.css"

/** Placeholder bars while something loads (no shimmer). */
export function Skeleton(p: { rows?: number }): React.JSX.Element {
  const n = Math.max(1, p.rows ?? 3)
  return (
    <div className="ui-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div className="ui-skeleton-row" key={i}>
          <span className="ui-skeleton-bar" style={{ width: `${[38, 62, 48, 70, 54][i % 5]}%` }} />
          <span className="ui-skeleton-bar is-short" />
        </div>
      ))}
    </div>
  )
}
