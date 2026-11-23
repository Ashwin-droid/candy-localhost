import type React from "react"
import { useEffect, useRef } from "react"
import { Link } from "../router.tsx"
import "./Tabs.css"

export interface TabItem { to: string; label: string; count?: number; active?: boolean }

/** Router-link tabs under a page header. The active tab is scrolled into view on narrow screens. */
export function Tabs(p: { items: TabItem[]; label: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const active = p.items.findIndex(t => t.active)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="page"]')
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [active])
  return (
    <nav className="ui-tabs" aria-label={p.label}>
      <div className="ui-tabs-scroll" ref={ref}>
        {p.items.map(t => (
          <Link key={t.to} to={t.to} className={t.active ? "ui-tab is-active" : "ui-tab"} aria-current={t.active ? "page" : undefined}>
            {t.label}
            {t.count !== undefined ? <span className="ui-tab-count">{t.count.toLocaleString("en-US")}</span> : null}
          </Link>
        ))}
      </div>
    </nav>
  )
}
