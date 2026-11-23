import type React from "react"
import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "./icons.tsx"
import { StatusDot, type LampState } from "./StatusDot.tsx"
import "./Listbox.css"

export interface ListboxOption { value: string; label: string; detail?: string; lamp?: LampState }

/**
 * A custom single-choice dropdown with a detail line per option (01 §7.5 keyboard model): on the button
 * ArrowDown/Up/Enter/Space open; in the list ArrowUp/Down, Home/End, Enter/Space pick, Esc closes (and stops
 * propagation, so a dialog around it stays open), Tab closes, typing a letter jumps to the next option.
 */
export function Listbox(p: { id?: string; options: ListboxOption[]; value: string | null; onChange: (v: string) => void;
                             placeholder?: string; emptyText?: string; disabled?: boolean; label: string }): React.JSX.Element {
  const auto = useId()
  const id = p.id ?? `lb${auto.replace(/:/g, "")}`
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const selected = p.options.find(o => o.value === p.value) ?? null

  const openAt = (i?: number) => {
    if (p.disabled) return
    const idx = i ?? Math.max(0, p.options.findIndex(o => o.value === p.value))
    setActive(idx)
    setOpen(true)
  }
  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus() }
  const pick = (i: number) => {
    const o = p.options[i]
    if (!o) return
    p.onChange(o.value)
    close()
  }

  useEffect(() => {
    if (!open) return
    list.current?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" })
  }, [open, active])

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openAt() }
  }
  const onListKey = (e: React.KeyboardEvent) => {
    const n = p.options.length
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(n - 1, a + 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === "Home") { e.preventDefault(); setActive(0) }
    else if (e.key === "End") { e.preventDefault(); setActive(n - 1) }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active) }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === "Tab") { close(false) }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase()
      for (let k = 1; k <= n; k++) {
        const i = (active + k) % n
        if (p.options[i].label.toLowerCase().startsWith(ch)) { setActive(i); break }
      }
    }
  }

  return (
    <div className={open ? "ui-listbox is-open" : "ui-listbox"} ref={root}>
      <button ref={button} id={id} type="button" className="ui-listbox-button" disabled={p.disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={p.label}
        onClick={() => (open ? close() : openAt())} onKeyDown={onButtonKey}>
        {selected ? (
          <span className="ui-listbox-current">
            {selected.lamp ? <StatusDot state={selected.lamp} label={selected.label} /> : null}
            <span className="ui-listbox-name">{selected.label}</span>
            {selected.detail ? <span className="ui-listbox-detail">{selected.detail}</span> : null}
          </span>
        ) : <span className="ui-listbox-placeholder">{p.placeholder ?? "Pick one"}</span>}
        <Icon name="chevron-down" size={14} className="ui-listbox-chevron" />
      </button>
      {open ? (
        <ul ref={list} id={listId} className="ui-listbox-list" role="listbox" tabIndex={-1} aria-label={p.label}
          aria-activedescendant={p.options.length ? `${id}-opt-${active}` : undefined} onKeyDown={onListKey}>
          {p.options.length === 0 ? <li className="ui-listbox-empty">{p.emptyText ?? "No sites yet. Add one first."}</li> : null}
          {p.options.map((o, i) => (
            <li key={o.value} id={`${id}-opt-${i}`} data-index={i} role="option" aria-selected={o.value === p.value}
              className={["ui-listbox-option", i === active ? "is-active" : "", o.value === p.value ? "is-selected" : ""].filter(Boolean).join(" ")}
              onMouseMove={() => { if (i !== active) setActive(i) }} onClick={() => pick(i)}>
              {o.lamp ? <StatusDot state={o.lamp} label={o.label} /> : null}
              <span className="ui-listbox-texts">
                <span className="ui-listbox-name">{o.label}</span>
                {o.detail ? <span className="ui-listbox-detail">{o.detail}</span> : null}
              </span>
              {o.value === p.value ? <Icon name="check" size={14} className="ui-listbox-check" /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
