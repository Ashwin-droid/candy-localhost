import type React from "react"
import { Spinner } from "./icons.tsx"
import "./Button.css"

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger"
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant            // default "secondary"; primary = ink fill; danger = cherry text (cherry fill only in Confirm)
  size?: "md" | "sm"                 // 32 / 28 px
  busy?: boolean                     // spinner, aria-busy, disabled, label kept
  icon?: React.ReactNode
}

export function Button(p: ButtonProps): React.JSX.Element {
  const { variant = "secondary", size = "md", busy, icon, className, children, disabled, type, ...rest } = p
  const cls = ["ui-btn", `ui-btn-${variant}`, size === "sm" ? "ui-btn-sm" : "", busy ? "is-busy" : "", !children ? "ui-btn-icon-only" : "", className ?? ""]
    .filter(Boolean).join(" ")
  return (
    <button {...rest} type={type ?? "button"} className={cls} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <Spinner /> : icon}
      {children !== undefined && children !== null && children !== false ? <span className="ui-btn-label">{children}</span> : null}
    </button>
  )
}
