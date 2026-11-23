import type React from "react"
import "./Code.css"

/** A key, as in "Press / to filter". */
export function Kbd(p: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className="ui-kbd">{p.children}</kbd>
}
