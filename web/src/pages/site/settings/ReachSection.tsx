// Settings › Reachability (SPEC §5.5): local port, LAN, LAN HTTPS, Tailscale and the quick tunnel. Each
// control acts on its own (inline buttons and switches), so this card has no Save footer.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate, useResource } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import type { LanResponse, LanSet, PortalCloseResponse, PortalOpenResponse } from "../../../api/types.ts"
import { checkPort } from "../../../lib/validate.ts"
import { Button, ExternalLink, Field, Input, SettingsSection, useConfirm } from "../../../ui/index.ts"
import { failText, reachOf, StatusLine, SwitchField, useDraftSet, useSettings, useToggle, type Line, type Visibility } from "./common.tsx"

interface EntrySet { name: string; port: number | null; url?: string }
interface ServeSet { name: string; port: number | null; url: string | null; entryPort: number | null }

const LAN_KEYS = [KEYS.sites, KEYS.domains, "lan", "serves"]

/** The Tailscale port of a serve URL ("https://box.ts.net:8443" -> "8443"), else the usual 8443. */
export function tailscalePort(url: string | null): string {
  return (url?.match(/:(\d+)\/?$/) ?? [])[1] ?? "8443"
}

function LocalPort(): React.JSX.Element {
  const { site, offline } = useSettings()
  const d = useDraftSet<"port", string>({ port: site.entryPort ? String(site.entryPort) : "" })
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState<Line>(null)
  const [busy, setBusy] = useState<"save" | "remove" | null>(null)
  const send = async (port: number | null) => {
    setBusy(port === null ? "remove" : "save")
    setLine(null)
    try {
      const r = await getApi().post<EntrySet>("/routes/entry", { name: site.name, port })
      invalidate([KEYS.sites])
      if (port === null) d.set("port", "")
      d.commit(["port"])
      setLine({ kind: "ok", text: r.port ? `${r.url ?? `http://127.0.0.1:${r.port}`} now reaches ${site.name}` : `${site.name} has no local port` })
    } catch (e) {
      setError(failText(e, "Could not save the local port"))
    } finally {
      setBusy(null)
    }
  }
  const save = () => {
    const text = d.draft.port.trim()
    if (text === "") { if (site.entryPort) void send(null); return }
    const bad = checkPort(text, 1024, 65535)
    if (bad) { setError(bad); return }
    void send(Number(text))
  }
  return (
    <Field label="Local port" htmlFor="set-entry" error={error}
      help={`http://127.0.0.1:<port> on the machine candy runs on always reaches ${site.name} through candy, and starts it when needed. Only that machine can use it. Leave it empty to remove it.`}>
      <>
      <div className="set-inline">
        <Input id="set-entry" aria-describedby="set-entry-help" mono inputMode="numeric" prefix="127.0.0.1:" value={d.draft.port} invalid={!!error} disabled={offline}
          onChange={e => { d.set("port", e.target.value); setError(null); setLine(null) }}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); save() } }} />
        <Button onClick={save} busy={busy === "save"} disabled={offline || busy !== null || !d.dirty}>Save</Button>
        {site.entryPort ? <Button variant="quiet" onClick={() => send(null)} busy={busy === "remove"} disabled={offline || busy !== null}>Remove</Button> : null}
      </div>
      <StatusLine line={line} />
      </>
    </Field>
  )
}

function Lan(p: { v: Visibility }): React.JSX.Element {
  const { site, offline } = useSettings()
  const confirm = useConfirm()
  const r = reachOf(site)
  const lanInfo = useResource<LanResponse>("lan", signal => getApi().get<LanResponse>("/lan", undefined, { signal }), { every: 30_000 })
  const lanIp = lanInfo.data?.lanIp ?? null

  const lan = useToggle(r.lan, async (publish): Promise<Line> => {
    const res = await getApi().post<LanSet>("/lan", { name: site.name, publish })
    invalidate(LAN_KEYS)
    if (res.warning) return { kind: "warn", text: res.warning }
    return { kind: "ok", text: publish ? `${site.name}.candy published to LAN (${res.lanIp ?? lanIp ?? "no LAN address"})` : `${site.name}.candy is tailnet-only again` }
  }, {
    fallback: "Failed to update LAN publishing",
    confirm: next => !next ? Promise.resolve(true) : confirm({
      title: `Publish ${site.name}.candy to the LAN?`, body: "Any device on your local network will be able to open it.", verb: "Publish",
    }),
  })
  const https = useToggle(!!r.lanHttps, async (on): Promise<Line> => {
    const res = await getApi().post<LanSet>("/lan", { name: site.name, publish: true, https: on })
    invalidate(LAN_KEYS)
    if (res.warning) return { kind: "warn", text: res.warning }
    return { kind: "ok", text: on ? `${site.name} on the LAN at ${res.httpsUrl}` : `${site.name}: LAN HTTPS off` }
  }, { fallback: "Failed to update LAN HTTPS" })

  return (
    <>
      <SwitchField id="set-lan" label="LAN" checked={lan.checked} busy={lan.busy} disabled={offline} line={lan.line} onChange={lan.change}
        help={<>
          <span className="mono">{site.name}.candy</span> for devices on the local network, not just the tailnet.
          {lanIp ? <> This machine's LAN address is <span className="mono">{lanIp}</span>.</> : null}
        </>} />
      {p.v.lanHttps ? (
        <SwitchField id="set-lan-https" label="LAN HTTPS" checked={https.checked} busy={https.busy} disabled={offline} line={https.line}
          onChange={https.change}
          help={r.lanHttps
            ? <>Served at <ExternalLink href={r.lanHttps} mono>{r.lanHttps.replace(/^https:\/\//, "")}</ExternalLink> with a trusted certificate.</>
            : "Also serve it on the LAN over HTTPS with a trusted certificate: its public domain if it has one, otherwise https://<this machine>.ts.net:<port>."} />
      ) : null}
    </>
  )
}

function Tailscale(): React.JSX.Element {
  const { site, offline } = useSettings()
  const ts = reachOf(site).tsServe
  const d = useDraftSet<"port", string>({ port: tailscalePort(ts) })
  const [error, setError] = useState<string | null>(null)
  const [line, setLine] = useState<Line>(null)
  const [busy, setBusy] = useState<"serve" | "stop" | null>(null)
  const serve = async () => {
    const bad = checkPort(d.draft.port, 1024, 65535)
    if (bad) { setError(bad); return }
    setBusy("serve")
    setLine(null)
    try {
      const r = await getApi().post<ServeSet>("/routes/serve", { name: site.name, port: Number(d.draft.port.trim()) })
      invalidate(LAN_KEYS)
      d.commit(["port"])
      setLine({ kind: "ok", text: `${site.name} is at ${r.url}` })
    } catch (e) {
      setError(failText(e, "Could not set up Tailscale serving"))
    } finally {
      setBusy(null)
    }
  }
  const stop = async () => {
    setBusy("stop")
    setLine(null)
    try {
      await getApi().post<ServeSet>("/routes/serve", { name: site.name, port: null })
      invalidate(LAN_KEYS)
      setLine({ kind: "ok", text: `${site.name} is no longer served on Tailscale` })
    } catch (e) {
      setError(failText(e, "Could not stop Tailscale serving"))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Field label="Tailscale" htmlFor="set-ts" usual="usual: 8443" error={error}
      help={<>
        {ts ? <>Served at <ExternalLink href={ts} mono>{ts.replace(/^https:\/\//, "")}</ExternalLink>. </> : null}
        Devices on your tailnet open https://&lt;this machine&gt;.ts.net:&lt;port&gt;, with a trusted certificate. It goes through candy, so {site.name} starts when needed. This is the outside port, not the one {site.name} listens on.
      </>}>
      <>
      <div className="set-inline">
        <Input id="set-ts" aria-describedby="set-ts-help" mono inputMode="numeric" value={d.draft.port} invalid={!!error} disabled={offline}
          onChange={e => { d.set("port", e.target.value); setError(null); setLine(null) }}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void serve() } }} />
        <Button onClick={serve} busy={busy === "serve"} disabled={offline || busy !== null || (!!ts && !d.dirty)}>{ts ? "Change port" : "Serve"}</Button>
        {ts ? <Button variant="quiet" onClick={stop} busy={busy === "stop"} disabled={offline || busy !== null}>Stop serving</Button> : null}
      </div>
      <StatusLine line={line} />
      </>
    </Field>
  )
}

function QuickTunnel(): React.JSX.Element {
  const { site, offline } = useSettings()
  const [busy, setBusy] = useState<"open" | "close" | null>(null)
  const [line, setLine] = useState<Line>(null)
  const portal = site.portal
  const open = async () => {
    setBusy("open")
    setLine(null)
    try {
      const target = site.route?.target
      const body = typeof target === "number" ? { name: site.name, port: target } : { name: site.name }
      const r = await getApi().post<PortalOpenResponse>("/portal", body, { lane: "long" })
      invalidate([KEYS.sites, KEYS.stats])
      setLine({ kind: "ok", text: `Portal opened: ${r.url}` })
    } catch (e) {
      setLine({ kind: "error", text: failText(e, "Failed to open portal") })
    } finally {
      setBusy(null)
    }
  }
  const close = async () => {
    setBusy("close")
    setLine(null)
    try {
      const r = await getApi().post<PortalCloseResponse>("/portal/close/" + encodeURIComponent(site.name))
      invalidate([KEYS.sites, KEYS.stats])
      setLine({ kind: "ok", text: r.message || "Portal closed" })
    } catch (e) {
      setLine({ kind: "error", text: failText(e, "Failed to close portal") })
    } finally {
      setBusy(null)
    }
  }
  return (
    <Field label="Quick tunnel"
      help="A temporary trycloudflare.com address. Anyone with it can open the site.">
      <>
      <div className="set-inline">
        {portal ? (
          <>
            <span className="set-value">{portal.url ? <ExternalLink href={portal.url} mono>{portal.url.replace(/^https:\/\//, "")}</ExternalLink> : "Opening…"}</span>
            <Button onClick={close} busy={busy === "close"} disabled={offline || busy !== null}>Close</Button>
          </>
        ) : (
          <Button onClick={open} busy={busy === "open"} disabled={offline || busy !== null}>{busy === "open" ? "Opening…" : "Open a quick tunnel"}</Button>
        )}
      </div>
      <StatusLine line={line} />
      </>
    </Field>
  )
}

export function ReachSection(p: { v: Visibility }): React.JSX.Element {
  const { site } = useSettings()
  return (
    <SettingsSection id="reach" title="Reachability" description={`The ways into ${site.name} besides its candy address.`}
      dirty={false} saving={false} onSave={() => {}} onReset={() => {}}>
      {p.v.localPort ? <LocalPort /> : null}
      {p.v.lan ? <Lan v={p.v} /> : null}
      {p.v.tailscale ? <Tailscale /> : null}
      {p.v.tunnel ? <QuickTunnel /> : null}
    </SettingsSection>
  )
}
