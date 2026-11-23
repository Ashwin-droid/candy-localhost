import type React from "react"
import { useMemo } from "react"
import { parseAnsi } from "../lib/ansi.ts"
import "./AnsiText.css"

/**
 * Terminal output on the dark log surface. ANSI colours become spans with class names from lib/ansi's fixed
 * table; the text is React text, never markup.
 */
export function AnsiText(p: { text: string }): React.JSX.Element {
  const segs = useMemo(() => parseAnsi(p.text), [p.text])
  return (
    <pre className="ui-ansi">
      {segs.map((s, i) => (s.cls ? <span key={i} className={s.cls}>{s.text}</span> : s.text))}
    </pre>
  )
}
