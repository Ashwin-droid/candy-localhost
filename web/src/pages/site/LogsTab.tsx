// Logs tab (SPEC §5.7). Owned by package C.

import type React from "react"
import type { TabProps } from "../../lib/site.ts"
import { StartButton } from "../../shared/StartButton.tsx"
import { EmptyState } from "../../ui/index.ts"
import { LogViewer } from "./LogViewer.tsx"

export default function LogsTab(p: TabProps): React.JSX.Element {
  const { site } = p
  if (!site.proc) {
    return (
      <EmptyState action={!site.fn && site.config ? <StartButton site={site} /> : undefined}>
        {site.name} isn’t running, so there’s no log yet.
      </EmptyState>
    )
  }
  const canType = site.proc.status === "running" || site.proc.status === "starting"
  return <LogViewer key={site.name} name={site.name} status={site.proc.status} canType={canType} />
}
