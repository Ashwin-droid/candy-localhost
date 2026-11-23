// The Network area's frame: header, then the Overview · Peers sub-navigation beside the page body.

import type React from "react"
import { useRoute } from "../../router.tsx"
import { PageHeader, SubNav } from "../../ui/index.ts"
import "./network.css"

export function NetworkLayout(p: { meta?: React.ReactNode[]; children: React.ReactNode }): React.JSX.Element {
  const { path } = useRoute()
  const peers = path.replace(/\/$/, "") === "/network/peers"
  return (
    <>
      <PageHeader title="Network" meta={p.meta} />
      <div className="net-layout">
        <SubNav label="Network" items={[
          { to: "/network", label: "Overview", active: !peers },
          { to: "/network/peers", label: "Peers", active: peers },
        ]} />
        <div className="net-body">{p.children}</div>
      </div>
    </>
  )
}
