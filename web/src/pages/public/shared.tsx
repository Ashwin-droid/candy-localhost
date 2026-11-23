// Pieces both Public domains pages use: the no-zone state and the inline status line.

import type React from "react"
import { useSession } from "../../session.tsx"
import { EmptyState, Icon, Link } from "../../ui/index.ts"

export const LEDE = "Put a site on your own domain through a Cloudflare tunnel."
export const NO_ZONE_SUPER = "No zone is set up yet."
export const NO_ZONE_USER = "No zone is set up yet; a superuser sets one up."
export const LOAD_FAILED = "Couldn’t load domains."

/** No zone and tunnel yet: what this page is for, and who can set it up. */
export function NoZone(): React.JSX.Element {
  const { superuser } = useSession()
  return (
    <EmptyState action={superuser ? <Link to="/settings/daemon#zone" className="ui-btn ui-btn-primary">Set one up</Link> : undefined}>
      <p>{LEDE}</p>
      <p>{superuser ? NO_ZONE_SUPER : NO_ZONE_USER}</p>
    </EmptyState>
  )
}

export interface Status { kind: "ok" | "error" | "busy" | "warn"; text: string }

/** A one-line result next to the thing it is about (role=status, so screen readers hear it). */
export function StatusLine(p: { status: Status | null | undefined }): React.JSX.Element | null {
  const s = p.status
  return (
    <div className="pub-status" role="status" aria-live="polite">
      {s ? (
        <span className={`pub-status-msg is-${s.kind}`}>
          {s.kind === "ok" ? <Icon name="check" size={14} /> : s.kind === "error" ? <Icon name="error" size={14} /> : s.kind === "warn" ? <Icon name="warn" size={14} /> : null}
          <span>{s.text}</span>
        </span>
      ) : null}
    </div>
  )
}
