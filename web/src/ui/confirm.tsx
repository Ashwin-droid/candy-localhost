import type React from "react"
import { useState, useSyncExternalStore } from "react"
import { Button } from "./Button.tsx"
import { Dialog } from "./Dialog.tsx"
import { Input } from "./Input.tsx"

export interface ConfirmOptions { title: string; body?: React.ReactNode; verb: string; danger?: boolean; typeToConfirm?: string }

interface Pending { id: number; o: ConfirmOptions; resolve: (ok: boolean) => void }

// One module-level queue; ConfirmHost (rendered once by AppFrame) shows the first entry.
let queue: Pending[] = []
let seq = 0
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }

/** Ask before doing something. Resolves true for the verb, false for Cancel, Esc or the scrim. */
export function requestConfirm(o: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    queue = [...queue, { id: ++seq, o, resolve }]
    emit()
  })
}

export function useConfirm(): (o: ConfirmOptions) => Promise<boolean> {
  return requestConfirm
}

function settle(id: number, ok: boolean) {
  const p = queue.find(x => x.id === id)
  queue = queue.filter(x => x.id !== id)
  emit()
  p?.resolve(ok)
}

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
const snapshot = () => queue

/** Rendered by AppFrame. Destructive confirms use the cherry-filled verb and focus Cancel. */
export function ConfirmHost(): React.JSX.Element | null {
  const q = useSyncExternalStore(subscribe, snapshot, snapshot)
  const top = q[0]
  if (!top) return null
  return <ConfirmDialog key={top.id} pending={top} />
}

function ConfirmDialog(p: { pending: Pending }): React.JSX.Element {
  const { o, id } = p.pending
  const [typed, setTyped] = useState("")
  const blocked = !!o.typeToConfirm && typed.trim() !== o.typeToConfirm
  return (
    <Dialog open title={o.title} onClose={() => settle(id, false)} width={420}
      footer={<>
        <Button onClick={() => settle(id, false)} data-autofocus={o.danger && !o.typeToConfirm ? true : undefined}>Cancel</Button>
        <Button variant={o.danger ? "danger" : "primary"} className={o.danger ? "ui-btn-danger-fill" : undefined}
          disabled={blocked} onClick={() => settle(id, true)} data-autofocus={!o.danger ? true : undefined}>{o.verb}</Button>
      </>}>
      {o.body ? <div className="ui-confirm-body">{typeof o.body === "string" ? <p>{o.body}</p> : o.body}</div> : null}
      {o.typeToConfirm ? (
        <label className="ui-confirm-type">
          <span className="small ink-2">Type <code>{o.typeToConfirm}</code> to confirm.</span>
          <Input mono value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus
            onKeyDown={e => { if (e.key === "Enter" && !blocked) { e.preventDefault(); settle(id, true) } }} />
        </label>
      ) : null}
    </Dialog>
  )
}
