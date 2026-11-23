import type React from "react"
import { Link } from "../router.tsx"
import { Icon } from "./icons.tsx"
import "./PageHeader.css"

export interface PageHeaderProps {
  back?: { to: string; label: string }
  lead?: React.ReactNode              // usually a StatusDot
  title: React.ReactNode              // text or <Host size="xl">
  external?: string | null            // href for the arrow-out link after the title
  meta?: React.ReactNode[]            // up to 3 short facts, laid out with a 16px gap, no separators
  actions?: React.ReactNode           // up to 3 Buttons
}

export function PageHeader(p: PageHeaderProps): React.JSX.Element {
  const meta = (p.meta ?? []).filter(m => m !== null && m !== undefined && m !== false && m !== "")
  return (
    <header className="ui-pagehead">
      {p.back ? (
        <Link className="ui-pagehead-back" to={p.back.to}>
          <Icon name="arrow-left" size={14} />
          {p.back.label}
        </Link>
      ) : null}
      <div className="ui-pagehead-row">
        <div className="ui-pagehead-main">
          <h1 className="ui-pagehead-title">
            {p.lead ? <span className="ui-pagehead-lead">{p.lead}</span> : null}
            <span className="ui-pagehead-text">{p.title}</span>
            {p.external ? (
              <a className="ui-pagehead-ext" href={p.external} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
                <Icon name="arrow-out" size={16} />
              </a>
            ) : null}
          </h1>
          {meta.length ? (
            <ul className="ui-pagehead-meta">
              {meta.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
          ) : null}
        </div>
        {p.actions ? <div className="ui-pagehead-actions">{p.actions}</div> : null}
      </div>
    </header>
  )
}
