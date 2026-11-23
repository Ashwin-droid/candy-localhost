import type React from "react"
import "./Code.css"

/** Inline code, or a block (pre) for multi-line text. Text only. */
export function Code(p: { children: React.ReactNode; block?: boolean }): React.JSX.Element {
  if (p.block) return <pre className="ui-code-block"><code>{p.children}</code></pre>
  return <code className="ui-code">{p.children}</code>
}

