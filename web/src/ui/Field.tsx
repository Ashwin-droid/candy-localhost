import * as React from "react"
import { Icon } from "./icons.tsx"
import "./Field.css"

/**
 * A labelled control: label (with `usual: 60` and a status on its right), the control, help under it, then
 * the error. With htmlFor, a single child control gets aria-describedby / aria-invalid wired up.
 */
export function Field(p: { label: string; htmlFor?: string; help?: React.ReactNode; error?: string | null;
                           status?: React.ReactNode; usual?: string /* "usual: 60" */; children: React.ReactNode }): React.JSX.Element {
  const helpId = p.htmlFor && p.help ? `${p.htmlFor}-help` : undefined
  const errId = p.htmlFor && p.error ? `${p.htmlFor}-error` : undefined
  let control = p.children
  if (p.htmlFor && React.isValidElement(p.children) && (helpId || errId)) {
    const el = p.children as React.ReactElement<Record<string, unknown>>
    const described = [el.props["aria-describedby"], errId, helpId].filter(Boolean).join(" ")
    control = React.cloneElement(el, {
      "aria-describedby": described || undefined,
      ...(p.error ? { "aria-invalid": true } : {}),
    })
  }
  return (
    <div className={p.error ? "ui-field has-error" : "ui-field"}>
      <div className="ui-field-head">
        {p.htmlFor ? <label className="ui-field-label" htmlFor={p.htmlFor}>{p.label}</label> : <span className="ui-field-label">{p.label}</span>}
        {p.usual ? <span className="ui-field-usual">{p.usual}</span> : null}
        {p.status ? <span className="ui-field-status">{p.status}</span> : null}
      </div>
      <div className="ui-field-control">{control}</div>
      {p.error ? (
        <div className="ui-field-error" id={errId} role="alert">
          <Icon name="error" size={14} />
          <span>{p.error}</span>
        </div>
      ) : null}
      {p.help ? <div className="ui-field-help" id={helpId}>{p.help}</div> : null}
    </div>
  )
}
