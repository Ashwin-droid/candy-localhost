import type React from "react"
import { useEffect, useRef, useSyncExternalStore } from "react"
import { Icon } from "./icons.tsx"
import "./toast.css"

type Kind = "info" | "success" | "error"
interface Toast { id: number; text: string; kind: Kind }

let toasts: Toast[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const MAX = 3
const LIFETIME = 4000

/** A short note about a result the user is no longer looking at. 4 s; errors stay until dismissed. */
export function toast(text: string, kind?: "info" | "success" | "error"): void {
  toasts = [...toasts, { id: ++seq, text, kind: kind ?? "info" }].slice(-MAX)
  emit()
}

function dismiss(id: number) {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
const snapshot = () => toasts

/** Rendered once by AppFrame. */
export function Toaster(): React.JSX.Element {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot)
  return (
    <div className="ui-toaster" role="status" aria-live="polite">
      {list.map(t => <ToastItem key={t.id} t={t} />)}
    </div>
  )
}

function ToastItem(p: { t: Toast }): React.JSX.Element {
  const left = useRef(LIFETIME)
  const started = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sticky = p.t.kind === "error"
  const start = () => {
    if (sticky) return
    started.current = Date.now()
    timer.current = setTimeout(() => dismiss(p.t.id), left.current)
  }
  const pause = () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    left.current = Math.max(800, left.current - (Date.now() - started.current))
  }
  useEffect(() => { start(); return pause }, [])
  return (
    <div className={`ui-toast is-${p.t.kind}`} onMouseEnter={pause} onMouseLeave={start} onFocus={pause} onBlur={start}>
      <span className="ui-toast-mark" aria-hidden="true" />
      <span className="ui-toast-text">{p.t.text}</span>
      <button type="button" className="ui-toast-close" aria-label="Dismiss" onClick={() => dismiss(p.t.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}
