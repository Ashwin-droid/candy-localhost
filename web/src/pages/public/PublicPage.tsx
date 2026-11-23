// Public domains (SPEC §5.13): every binding of the Cloudflare zone, and binding a site.

import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { useDomains, useSites } from "../../api/sites.ts"
import type { DomainBinding } from "../../api/types.ts"
import { navigate, useHistoryState, useRoute } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import {
  Button, type Column, ErrorState, errorMessage, ExternalLink, Icon, Link, PageHeader, Section, Skeleton, Table,
} from "../../ui/index.ts"
import { BindForm } from "./BindForm.tsx"
import { allowedWord, bindableSites, bindingsOf, isUnprotected, jwtApplies, jwtWord, passwordWord } from "./lib.ts"
import { LOAD_FAILED, NoZone, StatusLine } from "./shared.tsx"
import type { FlashState } from "./types.ts"
import "./public.css"

export const EMPTY_PREFIX = "No public domains yet. Bind one to serve a site at name."

export default function PublicPage(): React.JSX.Element {
  useEffect(() => { document.title = "Public domains – candy" }, [])
  const route = useRoute()
  const session = useSession()
  const domains = useDomains()
  const { sites, offline } = useSites()
  const flash = useHistoryState<FlashState>()?.flash ?? null
  const bindParam = route.query.has("bind") ? route.query.get("bind") ?? "" : null
  const [open, setOpen] = useState(bindParam !== null)
  useEffect(() => { if (bindParam !== null) setOpen(true) }, [bindParam])

  const d = domains.data
  const bindings = useMemo(() => bindingsOf(d), [d])
  const siteNames = useMemo(() => new Set((sites ?? []).map(s => s.name)), [sites])
  const options = useMemo(() => bindableSites(sites), [sites])

  const close = () => {
    setOpen(false)
    if (bindParam !== null) navigate("/public", { replace: true })
  }

  if (!d) {
    return (
      <>
        <PageHeader title="Public domains" />
        {domains.error
          ? <ErrorState error={`${LOAD_FAILED} ${errorMessage(domains.error)}`} onRetry={() => { void domains.reload() }} />
          : <Skeleton rows={4} />}
      </>
    )
  }
  if (!d.configured) {
    return (
      <>
        <PageHeader title="Public domains" />
        <NoZone />
      </>
    )
  }

  const zone = d.zone.domain
  const showJwt = bindings.some(jwtApplies)
  const columns: Column<DomainBinding>[] = [
    {
      key: "domain", label: "Domain", mono: true,
      render: b => <span className="pub-fqdn">{b.subdomain}<span className="pub-zone">.{zone}</span></span>,
      sort: (a, b) => a.fqdn.localeCompare(b.fqdn),
    },
    {
      key: "site", label: "Site", priority: 2,
      render: b => (
        <span className="pub-site">
          {siteNames.has(b.serverName)
            ? <Link to={`/sites/${encodeURIComponent(b.serverName)}`} className="mono">{b.serverName}</Link>
            : <span className="mono">{b.serverName}</span>}
          {b.apiMode ? <span className="ink-2">API mode</span> : null}
        </span>
      ),
      sort: (a, b) => a.serverName.localeCompare(b.serverName),
    },
    {
      key: "password", label: "Password", priority: 2,
      render: b => <span className={isUnprotected(b) ? "cherry" : undefined}>{passwordWord(b)}</span>,
    },
    ...(showJwt ? [{
      key: "jwt", label: "JWT", priority: 3 as const,
      render: (b: DomainBinding) => (jwtApplies(b) ? jwtWord(b) : <span className="ink-3">—</span>),
    }] : []),
    {
      key: "allowed", label: "Allowed", priority: 2,
      render: b => <span title={b.allowlist?.ips.join(", ") || undefined}>{allowedWord(b)}</span>,
    },
    ...(session.superuser ? [{
      key: "owner", label: "Owner", priority: 3 as const, mono: true,
      render: (b: DomainBinding) => (
        <span className="pub-site">{b.owner}{b.orphaned ? <span className="ink-2 pub-note">orphaned</span> : null}</span>
      ),
    }] : []),
  ]

  return (
    <>
      <PageHeader title="Public domains"
        meta={[
          <>Zone <span className="mono">{zone}</span></>,
          <>Tunnel <span className="mono">{d.tunnel.name}</span></>,
          `${bindings.length} ${bindings.length === 1 ? "domain" : "domains"}`,
        ]}
        actions={open ? undefined : (
          <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => setOpen(true)}>Bind a site</Button>
        )} />
      {flash ? <div className="pub-flash"><StatusLine status={{ kind: "ok", text: flash }} /></div> : null}
      {open ? (
        <Section id="bind" title="Bind a site" description={`Serve one of your sites at name.${zone} through the tunnel.`}>
          <BindForm zone={zone} options={options} initialSite={bindParam || null} offline={offline} onClose={close} />
        </Section>
      ) : null}
      <Section id="domains" title="Domains"
        description={`Sites served at name.${zone} through the Cloudflare tunnel, and who may reach them.`}>
        <Table<DomainBinding>
          label="Public domains" columns={columns} rows={bindings} rowKey={b => b.subdomain}
          rowHref={b => `/public/${encodeURIComponent(b.subdomain)}`}
          error={domains.error ? errorMessage(domains.error) : null}
          actions={b => <ExternalLink href={`https://${b.fqdn}`} className="pub-open">Open</ExternalLink>}
          empty={`${EMPTY_PREFIX}${zone}.`} />
      </Section>
    </>
  )
}
