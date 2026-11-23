// Single-key shortcuts ("n", "/", "1") and two-key sequences ("g s"). Ignored while typing in a field, while a
// dialog is open, and with Ctrl / Cmd / Alt held. One document listener serves every registration.

import { useEffect, useRef } from "react"

type Handler = { keys: string[]; fn: () => void }

const handlers = new Set<Handler>()
let pending: string | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let installed = false

function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type)
  }
  return !!el.closest?.('[role="listbox"], [data-shortcuts="off"]')
}

export function dialogOpen(): boolean {
  return typeof document !== "undefined" && !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

/** Whether a key event should be treated as a shortcut at all (exported for tests). */
export function shortcutAllowed(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "target" | "defaultPrevented">, dialog: boolean): boolean {
  return !e.defaultPrevented && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !dialog
}

function onKey(e: KeyboardEvent) {
  if (!shortcutAllowed(e, dialogOpen())) { pending = null; return }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const seq = pending ? [pending, key] : [key]
  for (const h of [...handlers]) {
    if (h.keys.length === seq.length && h.keys.every((k, i) => k === seq[i])) {
      e.preventDefault()
      pending = null
      h.fn()
      return
    }
  }
  if (!pending && [...handlers].some(h => h.keys.length === 2 && h.keys[0] === key)) {
    pending = key
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => { pending = null }, 1200)
    return
  }
  pending = null
}

/** Register a shortcut while the component is mounted: "n", "/", "1", or a sequence "g s". */
export function useShortcut(keys: string /* "n", "g s", "1" */, fn: () => void): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!installed) { document.addEventListener("keydown", onKey); installed = true }
    const h: Handler = { keys: keys.trim().split(/\s+/).map(k => k.toLowerCase()), fn: () => ref.current() }
    handlers.add(h)
    return () => { handlers.delete(h) }
  }, [keys])
}
