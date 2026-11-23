import type React from "react"
import "./Meter.css"

/** A usage bar: ink-2, lemon at 75 % and up, cherry at 90 % and up. */
export function Meter(p: { value: number /* 0..1 */; label: string }): React.JSX.Element {
  const v = Math.max(0, Math.min(1, Number.isFinite(p.value) ? p.value : 0))
  const level = v >= 0.9 ? " is-hot" : v >= 0.75 ? " is-warn" : ""
  return (
    <span className={`ui-meter${level}`} role="meter" aria-label={p.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} title={p.label}>
      <span className="ui-meter-fill" style={{ width: `${(v * 100).toFixed(1)}%` }} />
    </span>
  )
}
