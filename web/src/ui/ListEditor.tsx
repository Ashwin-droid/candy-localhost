import type React from "react"
import { useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./icons.tsx"
import { Input } from "./Input.tsx"
import "./ListEditor.css"

/** An editable list of strings (writable folders, allowlist IPs): one row per value, then an add row. */
export function ListEditor(p: { values: string[]; onChange: (v: string[]) => void; placeholder?: string; addLabel: string; mono?: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState("")
  const add = () => {
    const v = draft.trim()
    if (!v) return
    if (!p.values.includes(v)) p.onChange([...p.values, v])
    setDraft("")
  }
  return (
    <div className="ui-listed">
      {p.values.length ? (
        <ul className="ui-listed-items">
          {p.values.map((v, i) => (
            // Index keys: a value key would change on every keystroke, remount the row and drop focus
            <li key={i} className="ui-listed-item">
              <Input mono={p.mono} value={v} aria-label={`Item ${i + 1}`}
                onChange={e => p.onChange(p.values.map((x, j) => (j === i ? e.target.value : x)))}
                onBlur={e => { if (!e.target.value.trim()) p.onChange(p.values.filter((_, j) => j !== i)) }} />
              <Button variant="quiet" size="sm" icon={<Icon name="x" size={14} />} aria-label={`Remove ${v}`} title="Remove"
                onClick={() => p.onChange(p.values.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ui-listed-add">
        <Input mono={p.mono} value={draft} placeholder={p.placeholder} aria-label={p.addLabel}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); add() } }} />
        <Button size="md" icon={<Icon name="plus" size={14} />} onClick={add} disabled={!draft.trim()}>{p.addLabel}</Button>
      </div>
    </div>
  )
}
