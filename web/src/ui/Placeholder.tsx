import type React from "react"
import { EmptyState } from "./EmptyState.tsx"
import { PageHeader } from "./PageHeader.tsx"

/** Stub pages only: the page header and "Not built yet." */
export function Placeholder(p: { title: string }): React.JSX.Element {
  return (
    <>
      <PageHeader title={p.title} />
      <EmptyState>Not built yet.</EmptyState>
    </>
  )
}
