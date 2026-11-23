import type React from "react"
import { Link } from "../router.tsx"
import "./SubNav.css"

/** A section's own navigation: a left list at >= 1024px, a scrolling strip below. Put it beside the page body. */
export function SubNav(p: { items: { to: string; label: string; active?: boolean }[]; label: string }): React.JSX.Element {
  return (
    <nav className="ui-subnav" aria-label={p.label}>
      <ul>
        {p.items.map(i => (
          <li key={i.to}>
            <Link to={i.to} className={i.active ? "ui-subnav-item is-active" : "ui-subnav-item"} aria-current={i.active ? "page" : undefined}>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
