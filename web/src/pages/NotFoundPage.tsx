import type React from "react"
import { useEffect } from "react"
import { EmptyState, Link, PageHeader } from "../ui/index.ts"

export default function NotFoundPage(): React.JSX.Element {
  useEffect(() => { document.title = "Not found – candy" }, [])
  return (
    <>
      <PageHeader title="Not found" />
      <EmptyState action={<Link to="/" className="ui-btn ui-btn-secondary">Go to Sites</Link>}>
        There’s nothing here.
      </EmptyState>
    </>
  )
}
