import type React from "react"
import "./Section.css"

/**
 * One block of a page: a heading row (title, description, actions) and one body (KeyValue, Table,
 * SettingsSection fields, a log view or EmptyState). The body components draw their own sheet.
 */
export function Section(p: { id?: string; title: string; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const hid = p.id ? `${p.id}-title` : undefined
  return (
    <section className="ui-section" id={p.id} aria-labelledby={hid}>
      <div className="ui-section-head">
        <div className="ui-section-titles">
          <h2 className="ui-section-title" id={hid}>{p.title}</h2>
          {p.description ? <div className="ui-section-desc">{p.description}</div> : null}
        </div>
        {p.actions ? <div className="ui-section-actions">{p.actions}</div> : null}
      </div>
      <div className="ui-section-body">{p.children}</div>
    </section>
  )
}
