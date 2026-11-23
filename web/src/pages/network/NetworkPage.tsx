// Network › Overview (SPEC §5.14): this machine's addresses and every way a site is reachable, read-only.
// Each row links to the site's Settings › Reachability, where it is changed.

import type React from "react"
import { useEffect, useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate, useResource } from "../../api/resources.ts"
import { KEYS, useDomains, useSites, useStats } from "../../api/sites.ts"
import type { AdguardStatus, LanResponse, PortalCloseResponse, ServesResponse } from "../../api/types.ts"
import { useSession } from "../../session.tsx"
import {
  Button, type Column, errorMessage, ExternalLink, KeyValue, Link, Section, Table, toast,
} from "../../ui/index.ts"
import { NetworkLayout } from "./layout.tsx"
import {
  adguardText, httpsMode, type LanRow, lanRows, type PortRow, portRows, reachHref, type ServeRow, serveRows,
  type TunnelRow, tunnelRows,
} from "./lib.ts"

export const EMPTY = {
  lan: "Nothing published to the LAN.",
  serves: "Nothing is served on Tailscale.",
  ports: "No local ports.",
  tunnels: "No quick tunnels open.",
}

const siteCell = (name: string) => <span className="mono net-site">{name}</span>

export default function NetworkPage(): React.JSX.Element {
  useEffect(() => { document.title = "Network – candy" }, [])
  const session = useSession()
  const lan = useResource<LanResponse>("lan", signal => getApi().get<LanResponse>("/lan", undefined, { signal }), { every: 30_000 })
  const serves = useResource<ServesResponse>("serves", signal => getApi().get<ServesResponse>("/routes/serve", undefined, { signal }), { every: 30_000 })
  const adguard = useResource<AdguardStatus>(session.superuser ? "adguard" : null,
    signal => getApi().get<AdguardStatus>("/lan/adguard", undefined, { signal }))
  const domains = useDomains()
  const { sites, error: sitesError, offline } = useSites()
  const stats = useStats()
  const [closing, setClosing] = useState<string | null>(null)

  const close = async (name: string) => {
    setClosing(name)
    try {
      const res = await getApi().post<PortalCloseResponse>("/portal/close/" + encodeURIComponent(name))
      toast(res.message || `Closed the tunnel of ${name}`, "success")
      invalidate([KEYS.sites, KEYS.stats])
    } catch (e) {
      toast(errorMessage(e), "error")
    } finally {
      setClosing(null)
    }
  }

  const zone = domains.data?.configured ? domains.data.zone.domain : domains.data ? "None" : null
  const ag = adguardText(adguard.data)
  const lanErr = lan.error ? errorMessage(lan.error) : null

  const lanCols: Column<LanRow>[] = [
    { key: "site", label: "Site", render: r => siteCell(r.name) },
    { key: "name", label: "Name on LAN", mono: true, priority: 2, render: r => `${r.name}.candy` },
    {
      key: "https", label: "HTTPS", priority: 2,
      render: r => r.https ? (
        <span className="net-https">
          <span>{httpsMode(r.https)}</span>
          {r.https.url ? <ExternalLink href={r.https.url} mono>{r.https.url.replace(/^https:\/\//, "")}</ExternalLink> : null}
        </span>
      ) : <span className="ink-3">—</span>,
    },
  ]
  const serveCols: Column<ServeRow>[] = [
    { key: "site", label: "Site", render: r => siteCell(r.name) },
    { key: "port", label: "Port", mono: true, align: "right", width: "96px", render: r => r.port },
    {
      key: "url", label: "URL", priority: 2,
      render: r => (r.url ? <ExternalLink href={r.url} mono>{r.url.replace(/^https:\/\//, "")}</ExternalLink> : <span className="ink-3">—</span>),
    },
    { key: "local", label: "Local port", mono: true, align: "right", priority: 3, width: "120px", render: r => (r.entryPort ? `:${r.entryPort}` : <span className="ink-3">—</span>) },
  ]
  const portCols: Column<PortRow>[] = [
    { key: "site", label: "Site", render: r => siteCell(r.name) },
    { key: "url", label: "Address", mono: true, render: r => `http://127.0.0.1:${r.port}` },
  ]
  const tunnelCols: Column<TunnelRow>[] = [
    { key: "site", label: "Site", render: r => siteCell(r.name) },
    {
      key: "url", label: "URL", priority: 2,
      render: r => (r.url ? <ExternalLink href={r.url} mono>{r.url.replace(/^https:\/\//, "")}</ExternalLink> : <span className="ink-2">Opening…</span>),
    },
    { key: "requests", label: "Requests", align: "right", width: "112px", priority: 2, render: r => (r.requests === null ? <span className="ink-3">—</span> : r.requests.toLocaleString("en-US")) },
  ]

  return (
    <NetworkLayout>
      <Section id="machine" title="This machine">
        <KeyValue rows={[
          { label: "LAN IP", mono: true, value: lan.data ? lan.data.lanIp ?? "Not found" : lanErr ? <span className="ink-2">{lanErr}</span> : null },
          { label: "Tailnet host", mono: true, value: lan.data ? lan.data.tailnetHost ?? "Not on a tailnet" : null },
          {
            label: "Zone", value: zone && domains.data?.configured ? <span className="mono">{zone}</span> : zone,
            action: domains.data?.configured ? <Link to="/public" className="net-more">Public domains</Link> : undefined,
          },
          {
            label: "LAN DNS", hidden: !session.superuser,
            value: adguard.error ? <span className="ink-2">{errorMessage(adguard.error)}</span>
              : ag ? <span className={adguard.data?.configured && adguard.data.error ? "cherry" : undefined}>{ag}</span> : null,
            hint: "Sends LAN-published .candy names to candy-dns.",
            action: <Link to="/settings/daemon#adguard" className="net-more">{adguard.data?.configured ? "Change" : "Set up"}</Link>,
          },
        ]} />
      </Section>
      <Section id="lan" title="Published to LAN" description="Any device on the local network can open these at name.candy.">
        <Table<LanRow> label="Published to LAN" columns={lanCols} rows={lanRows(lan.data)} rowKey={r => r.name}
          rowHref={r => reachHref(r.name)} error={lanErr} onRetry={() => { void lan.reload() }} empty={EMPTY.lan} />
      </Section>
      <Section id="tailscale" title="Tailscale serves" description="Served over HTTPS to your tailnet only.">
        <Table<ServeRow> label="Tailscale serves" columns={serveCols} rows={serveRows(serves.data)} rowKey={r => r.name}
          rowHref={r => reachHref(r.name)} error={serves.error ? errorMessage(serves.error) : null}
          onRetry={() => { void serves.reload() }} empty={EMPTY.serves} />
      </Section>
      <Section id="ports" title="Local ports" description="Plain HTTP on this machine, for tools that can’t use a .candy name.">
        <Table<PortRow> label="Local ports" columns={portCols} rows={portRows(sites)} rowKey={r => r.name}
          rowHref={r => reachHref(r.name)} error={sitesError ? errorMessage(sitesError) : null} empty={EMPTY.ports} />
      </Section>
      <Section id="tunnels" title="Quick tunnels" description="Temporary public trycloudflare.com addresses.">
        <Table<TunnelRow> label="Quick tunnels" columns={tunnelCols} rows={tunnelRows(sites, stats.data)} rowKey={r => r.name}
          rowHref={r => reachHref(r.name)} error={sitesError ? errorMessage(sitesError) : null} empty={EMPTY.tunnels}
          actions={r => (
            <Button size="sm" variant="quiet" busy={closing === r.name} disabled={offline || (!!closing && closing !== r.name)}
              onClick={() => { void close(r.name) }}>Close</Button>
          )} />
      </Section>
    </NetworkLayout>
  )
}
