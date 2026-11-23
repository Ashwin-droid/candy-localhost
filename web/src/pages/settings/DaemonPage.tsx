// Settings › Daemon (SPEC §5.16, 02 §1.8), superuser only: the Cloudflare zone and tunnel, the public MCP
// address and its clients, and the AdGuard Home link. Shutting the daemon down is deliberately not offered here.

import type React from "react"
import { useState } from "react"
import { ApiError, getApi } from "../../api/client.ts"
import { invalidate, useResource } from "../../api/resources.ts"
import { KEYS, useDomains } from "../../api/sites.ts"
import type { AdguardStatus, PublicMcpStatus } from "../../api/types.ts"
import { useSession } from "../../session.tsx"
import {
  Button, type Column, EmptyState, ErrorState, errorMessage, Field, Input, KeyValue, RelativeTime, requestConfirm,
  Section, SettingsSection, Skeleton, Switch, Table, useDraft,
} from "../../ui/index.ts"
import { adguardFacts, mcpAddress, signedInClients, zoneBody, zoneDraftOf } from "./logic.ts"
import { Notice, type NoticeValue, SettingsShell, useOffline } from "./SettingsShell.tsx"
import { type AdguardBody, type DomainConfigResponse, SETTINGS_KEYS } from "./types.ts"

export const ONLY_SUPERUSER = "Only a superuser can change the daemon's settings."

export default function DaemonPage(): React.JSX.Element {
  const { superuser } = useSession()
  if (!superuser) {
    return (
      <SettingsShell title="Daemon">
        <EmptyState>{ONLY_SUPERUSER}</EmptyState>
      </SettingsShell>
    )
  }
  return (
    <SettingsShell title="Daemon">
      <ZoneSection />
      <McpSection />
      <AdguardSections />
    </SettingsShell>
  )
}

// ---- Cloudflare zone and tunnel ----

function ZoneSection(): React.JSX.Element {
  const domains = useDomains()
  const offline = useOffline()
  const server = domains.data ? zoneDraftOf(domains.data) : undefined
  const d = useDraft(server)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const zoneId = domains.data && domains.data.configured ? domains.data.zone?.id : ""

  const save = async () => {
    const out = zoneBody(d.draft, domains.data)
    if ("error" in out) { setStatus({ kind: "error", text: out.error }); return }
    setSaving(true)
    setStatus(null)
    try {
      const r = await getApi().post<DomainConfigResponse>("/domains/config", out.body)
      d.commit()
      setStatus({ kind: "ok", text: r?.message || "Saved." })
      invalidate([KEYS.domains, SETTINGS_KEYS.mcp])
    } catch (e) {
      setStatus({ kind: "error", text: errorMessage(e) })
    } finally { setSaving(false) }
  }
  const field = (k: "domain" | "tunnel" | "tunnelId" | "credentials") => ({
    value: d.draft[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setStatus(null); d.set(k, e.target.value) },
    disabled: !domains.data || saving || offline, spellCheck: false, autoComplete: "off", mono: true,
  })

  return (
    <SettingsSection id="zone" title="Cloudflare zone and tunnel"
      description={<>Public domains are bound as <code>name.zone</code> and served through the tunnel. Same as <code>candy domain config</code>.</>}
      dirty={d.dirty} saving={saving} status={status} conflict={d.conflict}
      onSave={() => void save()} onReset={() => { d.reset(); setStatus(null) }}>
      {domains.error && !domains.data ? <ErrorState error={domains.error.message} onRetry={() => void domains.reload()} /> : null}
      <div className="fields-2">
        <Field label="Zone" htmlFor="zone-domain" help={zoneId ? `Zone id ${zoneId}` : "The Cloudflare zone, like example.com."}>
          <Input id="zone-domain" placeholder="example.com" {...field("domain")} />
        </Field>
        <Field label="Tunnel name" htmlFor="zone-tunnel">
          <Input id="zone-tunnel" placeholder="candy" {...field("tunnel")} />
        </Field>
        <Field label="Tunnel id" htmlFor="zone-tunnel-id" usual="optional">
          <Input id="zone-tunnel-id" placeholder="optional" {...field("tunnelId")} />
        </Field>
        <Field label="Credentials file" htmlFor="zone-credentials">
          <Input id="zone-credentials" placeholder="~/.cloudflared/<tunnel id>.json" {...field("credentials")} />
        </Field>
      </div>
    </SettingsSection>
  )
}

// ---- Public MCP address ----

type McpClient = PublicMcpStatus["clients"][number]

function McpSection(): React.JSX.Element {
  const offline = useOffline()
  const mcp = useResource<PublicMcpStatus>(SETTINGS_KEYS.mcp,
    signal => getApi().get<PublicMcpStatus>("/domains/mcp", undefined, { signal }))
  const [notice, setNotice] = useState<NoticeValue | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const st = mcp.data
  const clients = signedInClients(st)

  const setEnabled = async (enabled: boolean) => {
    if (!enabled) {
      const ok = await requestConfirm({ title: "Turn off the public MCP address?", body: "Every connected client is signed out.", verb: "Turn off", danger: true })
      if (!ok) return
    }
    setBusy("switch")
    setNotice(null)
    try {
      const r = await getApi().post<PublicMcpStatus>("/domains/mcp", { enabled })
      setNotice({ kind: "ok", text: enabled ? `MCP is public at ${r?.url || "its address"}.` : "The public MCP address is off." })
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) })
    } finally { setBusy(null); invalidate(SETTINGS_KEYS.mcp) }
  }

  const signOut = async (c: McpClient | null) => {
    const ok = c
      ? await requestConfirm({ title: `Sign out ${c.clientName}?`, body: "It will need to be approved again.", verb: "Sign out", danger: true })
      : await requestConfirm({ title: "Sign out every MCP client?", body: "They will need to be approved again.", verb: "Sign out", danger: true })
    if (!ok) return
    setBusy(c ? "client:" + c.clientId : "all")
    setNotice(null)
    try {
      await getApi().post("/domains/mcp/revoke", c ? { clientId: c.clientId } : {})
      setNotice({ kind: "ok", text: c ? `${c.clientName} was signed out.` : "Every MCP client was signed out." })
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) })
    } finally { setBusy(null); invalidate(SETTINGS_KEYS.mcp) }
  }

  let body: React.ReactNode
  if (!st) {
    body = mcp.error
      ? <ErrorState error={`Couldn’t load it. ${mcp.error.message}`} onRetry={() => void mcp.reload()} />
      : <Skeleton rows={2} />
  } else if (!st.available) {
    body = <EmptyState>Needs a zone and a tunnel (above).</EmptyState>
  } else {
    body = (
      <KeyValue rows={[
        { label: "Address", value: mcpAddress(st), mono: true, hint: "candy for AI clients, from anywhere. Each client is approved from your tailnet." },
        {
          label: "Status", value: st.enabled ? "On" : "Off",
          action: <Switch label="Public MCP address" checked={st.enabled} busy={busy === "switch"} disabled={offline || (!!busy && busy !== "switch")}
            onChange={next => void setEnabled(next)} />,
        },
      ]} />
    )
  }

  const columns: Column<McpClient>[] = [
    { key: "name", label: "Name", render: c => c.clientName },
    { key: "grants", label: "Grants", align: "right", mono: true, priority: 2, render: c => c.activeGrants },
    { key: "used", label: "Last used", priority: 2, render: c => (typeof c.lastUsedAt === "number" ? <RelativeTime at={c.lastUsedAt} /> : "never") },
    { key: "users", label: "Users", mono: true, priority: 3, render: c => (Array.isArray(c.users) ? c.users.join(", ") : "") },
  ]

  return (
    <>
      <Section id="mcp" title="Public MCP address">
        {body}
        <Notice notice={notice} />
      </Section>
      {st && st.available && st.enabled ? (
        <Section id="mcp-clients" title={clients.length ? `Clients: ${clients.length} signed in` : "Clients"}
          actions={clients.length ? (
            <Button size="sm" variant="danger" busy={busy === "all"} disabled={offline || (!!busy && busy !== "all")}
              onClick={() => void signOut(null)}>Sign out all</Button>
          ) : undefined}>
          <Table label="MCP clients" columns={columns} rows={clients} rowKey={c => c.clientId} empty="None"
            actions={c => (
              <Button size="sm" variant="quiet" busy={busy === "client:" + c.clientId} disabled={offline || !!busy}
                onClick={() => void signOut(c)}>Sign out</Button>
            )} />
        </Section>
      ) : null}
    </>
  )
}

// ---- AdGuard Home ----

interface AdguardDraft { [k: string]: unknown; url: string; username: string; password: string; client: string; dnsTarget: string }

function adguardDraftOf(ag: AdguardStatus): AdguardDraft {
  if (!ag.configured) return { url: "", username: "", password: "", client: "", dnsTarget: "" }
  return { url: ag.url || "", username: ag.username || "", password: "", client: ag.client || "", dnsTarget: ag.dnsTarget || "" }
}

/** The POST /lan/adguard body, or the field errors that stop it. An empty password keeps the daemon's. */
export function adguardBody(d: AdguardDraft, linked: boolean): { body: AdguardBody } | { errors: Partial<Record<keyof AdguardDraft, string>> } {
  const errors: Partial<Record<keyof AdguardDraft, string>> = {}
  if (!d.username.trim()) errors.username = "Enter the AdGuard Home username"
  if (!linked && !d.password) errors.password = "Enter the AdGuard Home password"
  if (!d.client.trim()) errors.client = "Enter the client’s name"
  if (Object.keys(errors).length) return { errors }
  const dnsTarget = d.dnsTarget.trim()
  return {
    body: {
      url: d.url.trim() || "http://127.0.0.1:3000",
      username: d.username.trim(),
      ...(d.password ? { password: d.password } : {}),
      client: d.client.trim(),
      ...(dnsTarget ? { dnsTarget } : {}),
    },
  }
}

function AdguardSections(): React.JSX.Element {
  const offline = useOffline()
  const ag = useResource<AdguardStatus>(SETTINGS_KEYS.adguard,
    signal => getApi().get<AdguardStatus>("/lan/adguard", undefined, { signal }))
  const linked = !!ag.data?.configured
  const d = useDraft(ag.data ? adguardDraftOf(ag.data) : undefined)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [errors, setErrors] = useState<Partial<Record<keyof AdguardDraft, string>>>({})
  const [notice, setNotice] = useState<NoticeValue | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const save = async () => {
    const out = adguardBody(d.draft, linked)
    if ("errors" in out) { setErrors(out.errors); return }
    setErrors({})
    setSaving(true)
    setStatus(null)
    setNotice(null)
    try {
      await getApi().post<AdguardStatus>("/lan/adguard", out.body)
      d.commit({ password: "" })
      setStatus({ kind: "ok", text: "AdGuard Home linked." })
      invalidate(SETTINGS_KEYS.adguard)
    } catch (e) {
      // 502: AdGuard Home refused the new settings and the daemon kept the old ones
      const text = errorMessage(e) + (e instanceof ApiError && e.status === 502 ? " candy kept the previous settings." : "")
      setStatus({ kind: "error", text })
    } finally { setSaving(false) }
  }

  const unlink = async () => {
    const ok = await requestConfirm({ title: "Unlink AdGuard Home?", body: "candy takes out the upstream lines it added.", verb: "Unlink", danger: true })
    if (!ok) return
    setUnlinking(true)
    setNotice(null)
    try {
      await getApi().post<AdguardStatus>("/lan/adguard", { remove: true })
      setNotice({ kind: "ok", text: "AdGuard Home unlinked." })
      d.reset()
      setStatus(null)
      invalidate(SETTINGS_KEYS.adguard)
    } catch (e) {
      setNotice({ kind: "error", text: errorMessage(e) })
    } finally { setUnlinking(false) }
  }

  const field = (k: "url" | "username" | "password" | "client" | "dnsTarget") => ({
    value: d.draft[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setStatus(null)
      if (errors[k]) setErrors(x => ({ ...x, [k]: undefined }))
      d.set(k, e.target.value)
    },
    disabled: !ag.data || saving || offline, spellCheck: false, autoComplete: "off",
  })

  return (
    <>
      <Section id="adguard" title="AdGuard Home"
        description={<>Sends LAN-published <code>.candy</code> names to candy-dns. Publish a site to the LAN from its Settings tab. Same as <code>candy lan adguard setup</code>.</>}
        actions={linked ? <Button size="sm" variant="danger" busy={unlinking} disabled={offline || saving} onClick={() => void unlink()}>Unlink</Button> : undefined}>
        {ag.data || ag.error ? (
          <KeyValue rows={adguardFacts(ag.data ?? null).map(f => {
            const d = ag.data
            const rules = f.label === "Names" && d && d.configured && Array.isArray(d.rules) ? d.rules : []
            if (!rules.length) return { label: f.label, value: f.value, mono: f.label === "Client" }
            // one upstream rule per line, as AdGuard Home shows them
            return { label: f.label, value: <>
              <span>{rules.length} to <span className="mono">{d && d.configured ? d.dnsTarget : ""}</span></span>
              <ul className="daemon-rules">{rules.map((r, i) => <li key={i} className="mono">{r}</li>)}</ul>
            </> }
          })} />
        ) : <Skeleton rows={1} />}
        {ag.error && !ag.data ? <Notice notice={{ kind: "error", text: ag.error.message }} /> : <Notice notice={notice} />}
      </Section>
      <SettingsSection id="adguard-link" title={linked ? "Link settings" : "Link AdGuard Home"}
        description={linked ? "Change how candy reaches AdGuard Home. Leave the password empty to keep the one it has." : "candy logs in to AdGuard Home and adds upstream lines for the LAN client."}
        dirty={d.dirty} saving={saving} status={status} conflict={d.conflict} saveLabel={linked ? "Save" : "Link"}
        onSave={() => void save()} onReset={() => { d.reset(); setErrors({}); setStatus(null) }}>
        <div className="fields-2">
          <Field label="Address" htmlFor="adguard-url">
            <Input id="adguard-url" mono placeholder="http://127.0.0.1:3000" {...field("url")} />
          </Field>
          <Field label="Username" htmlFor="adguard-username" error={errors.username}>
            <Input id="adguard-username" {...field("username")} invalid={!!errors.username} />
          </Field>
          <Field label="Password" htmlFor="adguard-password" error={errors.password} help="Kept by the daemon, never shown again.">
            <Input id="adguard-password" type="password" placeholder={linked ? "Unchanged" : ""} {...field("password")}
              autoComplete="new-password" invalid={!!errors.password} />
          </Field>
          <Field label="Persistent client" htmlFor="adguard-client" error={errors.client} help="The AdGuard Home client that covers the LAN.">
            <Input id="adguard-client" {...field("client")} invalid={!!errors.client} />
          </Field>
          <Field label="candy-dns LAN listener" htmlFor="adguard-dns" usual="optional">
            <Input id="adguard-dns" mono placeholder="127.0.0.1:5336" {...field("dnsTarget")} />
          </Field>
        </div>
      </SettingsSection>
    </>
  )
}
