import type React from "react"
import "./Host.css"

/** A hostname: the name in ink, "." + tld in ink-3, mono. size "xl" is the site page title. */
export function Host(p: { name: string; tld?: string | null; size?: "md" | "xl" }): React.JSX.Element {
  return (
    <span className={p.size === "xl" ? "ui-host ui-host-xl" : "ui-host"}>
      <span className="ui-host-name">{p.name}</span>
      {p.tld ? <span className="ui-host-tld">.{p.tld}</span> : null}
    </span>
  )
}
