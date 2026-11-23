import type React from "react"
import "./Segmented.css"

/** One of a few options, side by side (a radio group). Arrow keys move the choice. */
export function Segmented<T extends string>(p: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }): React.JSX.Element {
  const idx = p.options.findIndex(o => o.value === p.value)
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = p.options.length
    let next = -1
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % n
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (idx - 1 + n) % n
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = n - 1
    if (next < 0) return
    e.preventDefault()
    p.onChange(p.options[next].value)
    const btn = e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]
    btn?.focus()
  }
  return (
    <div className="ui-seg" role="radiogroup" aria-label={p.label} onKeyDown={onKey}>
      {p.options.map((o, i) => {
        const on = o.value === p.value
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on || (idx < 0 && i === 0) ? 0 : -1}
            className={on ? "ui-seg-item is-on" : "ui-seg-item"} onClick={() => p.onChange(o.value)}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
