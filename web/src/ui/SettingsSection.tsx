import type React from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./icons.tsx"
import "./SettingsSection.css"

export interface SettingsSectionProps {
  id: string; title: string; description?: React.ReactNode
  dirty: boolean; saving: boolean
  status?: { kind: "ok" | "error"; text: string } | null    // footer: "Saved. Applies at its next start." / error
  conflict?: boolean                                        // "Changed elsewhere. Reset to see the new value."
  onSave: () => void; onReset: () => void
  saveLabel?: string                                        // the footer's submit label, default "Save"
  children: React.ReactNode
}

/**
 * A settings card: title and description, the fields, and a footer that appears only when there is
 * something to say (unsaved changes, saving, a result). Enter in a text field saves, Esc resets.
 */
export function SettingsSection(p: SettingsSectionProps): React.JSX.Element {
  const showFooter = p.dirty || p.saving || !!p.status
  const onKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    const t = e.target as HTMLElement
    if (e.key === "Escape" && p.dirty && !p.saving) {
      e.preventDefault()
      p.onReset()
    } else if (e.key === "Enter" && t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox" && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (p.dirty && !p.saving) p.onSave()
    }
  }
  return (
    <section className="ui-settings" id={p.id} aria-labelledby={`${p.id}-title`}>
      <form className="ui-settings-form" noValidate onKeyDown={onKeyDown}
        onSubmit={e => { e.preventDefault(); if (p.dirty && !p.saving) p.onSave() }}>
        <div className="ui-settings-head">
          <h2 className="ui-settings-title" id={`${p.id}-title`}>{p.title}</h2>
          {p.description ? <div className="ui-settings-desc">{p.description}</div> : null}
        </div>
        <div className="ui-settings-body">{p.children}</div>
        {showFooter ? (
          <div className={p.conflict ? "ui-settings-foot is-conflict" : "ui-settings-foot"}>
            <div className="ui-settings-status" role="status" aria-live="polite">
              {p.conflict ? (
                <span className="ui-settings-msg is-warn"><Icon name="warn" size={14} />Changed elsewhere. Reset to see the new value.</span>
              ) : p.saving ? (
                <span className="ui-settings-msg">Saving…</span>
              ) : p.status && !p.dirty ? (
                <span className={p.status.kind === "error" ? "ui-settings-msg is-error" : "ui-settings-msg is-ok"}>
                  <Icon name={p.status.kind === "error" ? "error" : "check"} size={14} />{p.status.text}
                </span>
              ) : p.status && p.status.kind === "error" ? (
                <span className="ui-settings-msg is-error"><Icon name="error" size={14} />{p.status.text}</span>
              ) : p.dirty ? (
                <span className="ui-settings-msg">Unsaved changes</span>
              ) : null}
            </div>
            {p.dirty || p.saving ? (
              <div className="ui-settings-buttons">
                <Button variant="quiet" onClick={p.onReset} disabled={p.saving}>Reset</Button>
                <Button variant="primary" type="submit" busy={p.saving}>{p.saveLabel ?? "Save"}</Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </section>
  )
}
