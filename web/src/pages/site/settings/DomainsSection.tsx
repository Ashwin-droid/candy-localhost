// Settings › Reachability › Public domains (SPEC §5.5): this site's bindings, each linking to its own page.

import type React from "react"
import { useDomains } from "../../../api/sites.ts"
import type { DomainBinding } from "../../../api/types.ts"
import { EmptyState, Link, Section, Table, type Column } from "../../../ui/index.ts"
import { useSettings } from "./common.tsx"

export function DomainsSection(): React.JSX.Element {
  const { site, superuser } = useSettings()
  const domains = useDomains()
  const bindLink = `/public?bind=${encodeURIComponent(site.name)}`
  const zone = domains.data?.configured ? domains.data.zone.domain : null
  const rows: DomainBinding[] | undefined = domains.data
    ? (domains.data.configured ? Object.values(domains.data.bindings).filter(b => b.serverName === site.name) : [])
    : undefined
  const cols: Column<DomainBinding>[] = [
    { key: "fqdn", label: "Domain", mono: true, render: b => b.fqdn },
    {
      key: "password", label: "Password", render: b => b.hasPassword && b.authEnabled
        ? "Set" : <span className="cherry">No password</span>,
    },
    {
      key: "allowed", label: "Allowed", priority: 2, render: b => b.allowlist?.enabled
        ? `${b.allowlist.ips.length} ${b.allowlist.ips.length === 1 ? "IP" : "IPs"}` : "Anyone",
    },
  ]
  if (domains.data && !domains.data.configured) {
    return (
      <Section id="reach-domains" title="Public domains">
        <EmptyState action={superuser ? <Link to="/settings/daemon" className="set-link">Set up a zone in Settings › Daemon</Link> : undefined}>
          No public zone is set up.
        </EmptyState>
      </Section>
    )
  }
  return (
    <Section id="reach-domains" title="Public domains"
      description={zone ? <>Addresses under <span className="mono">{zone}</span>, through the Cloudflare tunnel.</> : undefined}
      actions={<Link to={bindLink} className="ui-btn ui-btn-secondary ui-btn-sm">Bind a domain</Link>}>
      <Table label="Public domains" columns={cols} rows={rows} rowKey={b => b.subdomain}
        rowHref={b => `/public/${encodeURIComponent(b.subdomain)}`}
        error={domains.error ? domains.error.message : null} onRetry={() => { void domains.reload() }}
        empty={`${site.name} isn't on a public domain yet.`} />
    </Section>
  )
}
