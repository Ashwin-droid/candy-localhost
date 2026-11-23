import type React from "react"
import { useEffect, useId, useRef } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./icons.tsx"
import "./Dialog.css"

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A modal dialog: focus trap, Esc and scrim click close it, focus returns to where it was. A bottom sheet
 * below 640px. Focus goes to the first element with [data-autofocus], else the first field, else the first button.
 */
export function Dialog(p: { open: boolean; title: string; onClose: () => void; width?: number /* 440 */; footer?: React.ReactNode; children: React.ReactNode }): React.JSX.Element | null {
  const box = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const onClose = useRef(p.onClose)
  onClose.current = p.onClose

  useEffect(() => {
    if (!p.open) return
    const before = document.activeElement as HTMLElement | null
    const el = box.current
    const first = el?.querySelector<HTMLElement>("[data-autofocus]")
      ?? el?.querySelector<HTMLElement>(".ui-dialog-body input:not([disabled]), .ui-dialog-body textarea:not([disabled]), .ui-dialog-body select:not([disabled])")
      ?? el?.querySelector<HTMLElement>(".ui-dialog-foot button:not([disabled])")
      ?? el
    first?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prevOverflow
      if (before && document.contains(before)) before.focus()
    }
  }, [p.open])

  if (!p.open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose.current(); return }
    if (e.key !== "Tab" || !box.current) return
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(x => x.offsetParent !== null || x === document.activeElement)
    if (!items.length) { e.preventDefault(); return }
    const first = items[0], last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  return (
    <div className="ui-dialog-layer" onKeyDown={onKeyDown}>
      <div className="ui-dialog-scrim" onMouseDown={() => onClose.current()} aria-hidden="true" />
      <div ref={box} className="ui-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        style={{ maxWidth: `${p.width ?? 440}px` }}>
        <div className="ui-dialog-head">
          <h2 className="ui-dialog-title" id={titleId}>{p.title}</h2>
          <Button variant="quiet" size="sm" icon={<Icon name="x" />} aria-label="Close" onClick={() => onClose.current()} />
        </div>
        <div className="ui-dialog-body">{p.children}</div>
        {p.footer ? <div className="ui-dialog-foot">{p.footer}</div> : null}
      </div>
    </div>
  )
}
