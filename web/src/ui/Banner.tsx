import type React from "react"
import { Icon } from "./icons.tsx"
import "./Banner.css"

/** A line across the page: something about the whole page or the app (offline, lost access, a warning). */
export function Banner(p: { kind: "info" | "warn" | "error"; children: React.ReactNode; action?: React.ReactNode; onDismiss?: () => void }): React.JSX.Element {
  return (
    <div className={`ui-banner is-${p.kind}`} role={p.kind === "error" ? "alert" : "status"}>
      <Icon name={p.kind === "info" ? "info" : p.kind === "warn" ? "warn" : "error"} className="ui-banner-icon" />
      <div className="ui-banner-text">{p.children}</div>
      {p.action || p.onDismiss ? (
        <div className="ui-banner-actions">
          {p.action}
          {p.onDismiss ? (
            <button type="button" className="ui-banner-close" aria-label="Dismiss" onClick={p.onDismiss}><Icon name="x" size={14} /></button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
