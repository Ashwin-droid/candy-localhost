import type React from "react"
import { Spinner } from "./icons.tsx"
import "./Switch.css"

/** An on/off switch (role="switch"). `label` is its accessible name; show visible text beside it yourself. */
export function Switch(p: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; busy?: boolean; id?: string }): React.JSX.Element {
  return (
    <button type="button" role="switch" id={p.id} aria-checked={p.checked} aria-label={p.label} aria-busy={p.busy || undefined}
      disabled={p.disabled || p.busy} className={["ui-switch", p.checked ? "is-on" : "", p.busy ? "is-busy" : ""].filter(Boolean).join(" ")}
      onClick={() => p.onChange(!p.checked)}>
      <span className="ui-switch-thumb">{p.busy ? <Spinner size={10} /> : null}</span>
    </button>
  )
}
