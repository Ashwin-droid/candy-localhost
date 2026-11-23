import type React from "react"
import { useState } from "react"
import { Button } from "./Button.tsx"
import { copyText } from "./CopyButton.tsx"
import { Icon } from "./icons.tsx"
import "./InlineReveal.css"

export const COPY_FAILED = "Couldn't copy. Select it and copy by hand."

/** A secret shown once (a JWT secret, a token): the value, Copy, "Shown once", and Done to put it away. */
export function InlineReveal(p: { label: string; value: string; hint?: React.ReactNode; onDone: () => void }): React.JSX.Element {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle")
  return (
    <div className="ui-reveal" role="group" aria-label={p.label}>
      <div className="ui-reveal-head">
        <span className="ui-reveal-label">{p.label}</span>
        <span className="ui-reveal-once">Shown once</span>
      </div>
      <div className="ui-reveal-row">
        <input className="ui-reveal-value" readOnly value={p.value} aria-label={p.label} spellCheck={false}
          onFocus={e => e.currentTarget.select()} />
        <Button size="sm" icon={<Icon name={copy === "done" ? "check" : "copy"} size={14} />}
          onClick={async () => setCopy((await copyText(p.value)) ? "done" : "failed")}>
          {copy === "done" ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="primary" onClick={p.onDone}>Done</Button>
      </div>
      {copy === "failed" ? <div className="ui-reveal-error" role="alert">{COPY_FAILED}</div> : null}
      {p.hint ? <div className="ui-reveal-hint">{p.hint}</div> : null}
    </div>
  )
}
