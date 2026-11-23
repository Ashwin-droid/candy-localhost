import type React from "react"
import { Icon } from "./icons.tsx"
import "./ExternalLink.css"

/** Opens in a new tab, rel="noopener noreferrer", with a small arrow-out icon. */
export function ExternalLink(p: { href: string; mono?: boolean; children: React.ReactNode; className?: string }): React.JSX.Element {
  const cls = ["ui-xlink", p.mono ? "mono" : "", p.className ?? ""].filter(Boolean).join(" ")
  return (
    <a className={cls} href={p.href} target="_blank" rel="noopener noreferrer">
      <span className="ui-xlink-text">{p.children}</span>
      <Icon name="arrow-out" size={12} className="ui-xlink-icon" />
    </a>
  )
}
