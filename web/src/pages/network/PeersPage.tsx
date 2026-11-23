// Network › Peers (SPEC §5.14): the candy network registry, the .candy names this machine and its tailnet peers claim.

import type React from "react"
import { useEffect, useMemo } from "react"
import { getApi } from "../../api/client.ts"
import { useResource } from "../../api/resources.ts"
import { type Column, ErrorState, errorMessage, Host, Section, Skeleton, Table } from "../../ui/index.ts"
import { NetworkLayout } from "./layout.tsx"
import { formatExpiry, normalizeRegistry, roleText } from "./registry.ts"
import type { PeerRow } from "./types.ts"

export const REGISTRY_ERROR = "Couldn’t load the candy network registry: "

export default function PeersPage(): React.JSX.Element {
  useEffect(() => { document.title = "Peers – Network – candy" }, [])
  const reg = useResource<unknown>("registry", signal => getApi().get<unknown>("/candy/registry", undefined, { signal }), { every: 30_000 })
  const data = useMemo(() => (reg.data === undefined ? undefined : normalizeRegistry(reg.data)), [reg.data])

  const base: Column<PeerRow>[] = [
    { key: "name", label: "Name", render: r => <Host name={r.name} tld="candy" />, sort: (a, b) => a.name.localeCompare(b.name) },
    { key: "ip", label: "IP", mono: true, priority: 2, render: r => r.ip || <span className="ink-3">—</span> },
    {
      key: "role", label: "Role", priority: 2,
      render: r => (
        <span className="net-role">
          <span className={r.role === "shadowed" ? "ink-2" : undefined}>{roleText(r)}</span>
          {r.role === "alias" && r.aliasFqdns.length ? <span className="mono ink-2">{r.aliasFqdns.join(", ")}</span> : null}
        </span>
      ),
    },
    { key: "host", label: "Host", priority: 3, render: r => (r.host ? <span className="mono net-host">{r.host}</span> : <span className="ink-3">—</span>) },
  ]
  const remoteCols: Column<PeerRow>[] = [
    ...base,
    {
      key: "expires", label: "Expires", align: "right", width: "112px", priority: 2,
      render: r => (r.expiresIn === null ? <span className="ink-3">—</span> : <span className="tnum">{formatExpiry(r.expiresIn)}</span>),
      sort: (a, b) => (a.expiresIn ?? 0) - (b.expiresIn ?? 0),
    },
  ]

  const meta = data ? [`${data.local.length} local`, `${data.remote.length} remote`] : undefined
  if (!data) {
    return (
      <NetworkLayout>
        {reg.error ? <ErrorState error={REGISTRY_ERROR + errorMessage(reg.error)} onRetry={() => { void reg.reload() }} /> : <Skeleton rows={4} />}
      </NetworkLayout>
    )
  }
  const err = reg.error ? errorMessage(reg.error) : null
  return (
    <NetworkLayout meta={meta}>
      <Section id="local" title="Local records" description="Names this machine answers for on the candy network.">
        <Table<PeerRow> label="Local records" columns={base} rows={data.local} rowKey={r => `${r.name}|${r.ip}`} error={err}
          empty="No local records." />
      </Section>
      <Section id="remote" title="Remote records" description="Names other candy machines on the tailnet have advertised. Each claim expires unless it is renewed.">
        <Table<PeerRow> label="Remote records" columns={remoteCols} rows={data.remote} rowKey={r => `${r.name}|${r.ip}|${r.host ?? ""}`} error={err}
          empty="No remote records." />
      </Section>
    </NetworkLayout>
  )
}
