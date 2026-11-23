import type React from "react"
import "./Input.css"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { mono?: boolean; prefix?: string; suffix?: string; invalid?: boolean }

/** A text input. prefix / suffix sit inside the box ("https://", ".candy", "MB"). */
export function Input(p: InputProps): React.JSX.Element {
  const { mono, prefix, suffix, invalid, className, ...rest } = p
  const input = (
    <input {...rest} aria-invalid={invalid || rest["aria-invalid"] || undefined}
      className={["ui-input", mono ? "is-mono" : "", invalid ? "is-invalid" : "", prefix || suffix ? "" : className ?? ""].filter(Boolean).join(" ")} />
  )
  if (!prefix && !suffix) return input
  return (
    <span className={["ui-input-wrap", invalid ? "is-invalid" : "", rest.disabled ? "is-disabled" : "", className ?? ""].filter(Boolean).join(" ")}>
      {prefix ? <span className={mono ? "ui-input-affix mono" : "ui-input-affix"}>{prefix}</span> : null}
      {input}
      {suffix ? <span className={mono ? "ui-input-affix mono" : "ui-input-affix"}>{suffix}</span> : null}
    </span>
  )
}

export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; invalid?: boolean }): React.JSX.Element {
  const { mono, invalid, className, ...rest } = p
  return <textarea rows={4} {...rest} aria-invalid={invalid || rest["aria-invalid"] || undefined}
    className={["ui-input", "ui-textarea", mono ? "is-mono" : "", invalid ? "is-invalid" : "", className ?? ""].filter(Boolean).join(" ")} />
}

/** The native select, styled. */
export function Select(p: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  const { className, ...rest } = p
  return (
    <span className={["ui-select", rest.disabled ? "is-disabled" : "", className ?? ""].filter(Boolean).join(" ")}>
      <select {...rest} />
    </span>
  )
}
