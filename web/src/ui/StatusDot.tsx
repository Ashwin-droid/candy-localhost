import type React from "react"
import "./StatusDot.css"

export type LampState = "running" | "starting" | "crashed" | "stopped" | "idle" | "external"

/** The status lamp. Always paired with text: showLabel renders it, otherwise label becomes aria-label + title. */
export function StatusDot(p: { state: LampState; label?: string; showLabel?: boolean }): React.JSX.Element {
  const dot = <span className={`ui-dot ui-dot-${p.state}`} aria-hidden={p.showLabel ? true : undefined}
    role={p.showLabel ? undefined : "img"} aria-label={p.showLabel ? undefined : p.label} title={p.label} />
  if (!p.showLabel || !p.label) return dot
  return (
    <span className={`ui-lamp${p.state === "crashed" ? " is-crashed" : ""}`}>
      {dot}
      <span className="ui-lamp-label">{p.label}</span>
    </span>
  )
}
