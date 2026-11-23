// "Bind a site" on /public (SPEC §5.13): subdomain + site, POST /domains/bind, and the foreign-records warning.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import type { BindOk, BindWarning } from "../../api/types.ts"
import { navigate } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import { Button, errorMessage, Field, Input, Listbox, type ListboxOption } from "../../ui/index.ts"
import { recordLines, SUBDOMAIN } from "./lib.ts"
import { type Status, StatusLine } from "./shared.tsx"
import type { FlashState } from "./types.ts"

export const FILL_IN = "Fill in all fields"
export const BINDING = "Binding domain..."
export const OVERRIDING = "Overriding DNS records..."
export const ASK_SUPERUSER = "Ask a superuser to replace them."
export const BAD_SUBDOMAIN = "Use letters, numbers and dashes only"

/** The lemon-ruled warning: the daemon's message and the records already in the zone, as plain text. */
export function BindWarningBlock(p: { warning: BindWarning; superuser: boolean; busy: boolean; disabled?: boolean;
  onForce: () => void; onCancel: () => void }): React.JSX.Element {
  const lines = recordLines(p.warning)
  return (
    <div className="pub-warning" role="alert">
      <p className="pub-warning-text">{p.warning.message}</p>
      {lines.length ? (
        <ul className="pub-warning-records" aria-label="Records already in the zone">
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      ) : null}
      <div className="row">
        {p.superuser
          ? <Button variant="primary" busy={p.busy} disabled={p.disabled} onClick={p.onForce}>Replace records</Button>
          : <span className="pub-warning-ask">{ASK_SUPERUSER}</span>}
        <Button variant="quiet" onClick={p.onCancel} disabled={p.busy}>Cancel</Button>
      </div>
    </div>
  )
}

export function BindForm(p: { zone: string; options: ListboxOption[]; initialSite: string | null; offline?: boolean;
  onClose: () => void }): React.JSX.Element {
  const { superuser } = useSession()
  const initial = p.initialSite && p.options.some(o => o.value === p.initialSite) ? p.initialSite : null
  const [site, setSite] = useState<string | null>(initial)
  const [sub, setSub] = useState(initial ?? "")
  const [subTouched, setSubTouched] = useState(false)
  const [busy, setBusy] = useState<"bind" | "force" | null>(null)
  const [warning, setWarning] = useState<BindWarning | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [subError, setSubError] = useState<string | null>(null)

  const pick = (v: string) => {
    setSite(v)
    if (!subTouched || !sub.trim()) setSub(v.replace(/\./g, "-"))
  }

  const send = async (force: boolean) => {
    const subdomain = sub.trim()
    if (!subdomain || !site) { setStatus({ kind: "error", text: FILL_IN }); return }
    if (!SUBDOMAIN.test(subdomain)) { setSubError(BAD_SUBDOMAIN); return }
    setSubError(null)
    setBusy(force ? "force" : "bind")
    setStatus({ kind: "busy", text: force ? OVERRIDING : BINDING })
    try {
      const res = await getApi().post<BindOk | BindWarning>("/domains/bind",
        force ? { subdomain, serverName: site, force: true } : { subdomain, serverName: site })
      if ("warning" in res && res.warning) {
        setWarning(res)
        setStatus(null)
        return
      }
      const ok = res as BindOk
      invalidate([KEYS.domains, KEYS.sites])
      const fqdn = ok.binding?.fqdn ?? `${subdomain}.${p.zone}`
      const state: FlashState = { flash: `Bound ${fqdn}` }
      navigate(`/public/${encodeURIComponent(ok.binding?.subdomain ?? subdomain)}`, { state })
    } catch (e) {
      setStatus({ kind: "error", text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <form className="pub-card" noValidate aria-label="Bind a site"
      onSubmit={e => { e.preventDefault(); if (!busy && !warning) void send(false) }}>
      <div className="fields-2">
        <Field label="Site" htmlFor="bind-site" help="Every site with a route or a start command.">
          <Listbox id="bind-site" label="Site" options={p.options} value={site} onChange={pick}
            placeholder="Pick a site" disabled={!!warning || !!busy} />
        </Field>
        <Field label="Subdomain" htmlFor="bind-sub" error={subError}
          help={<>Served at <span className="mono">{(sub.trim() || "name")}.{p.zone}</span> through the tunnel.</>}>
          <Input id="bind-sub" mono suffix={`.${p.zone}`} value={sub} pattern="[a-zA-Z0-9-]+" autoComplete="off" spellCheck={false}
            disabled={!!warning || !!busy} invalid={!!subError}
            onChange={e => { setSub(e.target.value); setSubTouched(true); setSubError(null) }} />
        </Field>
      </div>
      {warning ? (
        <BindWarningBlock warning={warning} superuser={superuser} busy={busy === "force"} disabled={p.offline}
          onForce={() => { void send(true) }} onCancel={() => { setWarning(null); setStatus(null) }} />
      ) : (
        <div className="pub-card-foot">
          <StatusLine status={status} />
          <div className="row">
            <Button variant="quiet" onClick={p.onClose} disabled={!!busy}>Cancel</Button>
            <Button variant="primary" type="submit" busy={busy === "bind"} disabled={p.offline}>Bind</Button>
          </div>
        </div>
      )}
      {warning && status ? <StatusLine status={status} /> : null}
    </form>
  )
}
