import type React from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./icons.tsx"
import "./ErrorState.css"

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  return "Something went wrong"
}

/**
 * "Couldn't load: <message>" with Try again. A message that already starts with "Couldn" (a page's own
 * "Couldn’t load deploys: …") is shown as it is.
 */
export function ErrorState(p: { error: unknown; onRetry?: () => void }): React.JSX.Element {
  const msg = errorMessage(p.error)
  const text = /^Couldn/.test(msg) ? msg : `Couldn’t load: ${msg}`
  return (
    <div className="ui-error-state" role="alert">
      <Icon name="error" className="ui-error-state-icon" />
      <div className="ui-error-state-text">{text}</div>
      {p.onRetry ? <Button size="sm" onClick={p.onRetry}>Try again</Button> : null}
    </div>
  )
}
