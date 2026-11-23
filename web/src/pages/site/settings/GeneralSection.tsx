// Settings › General (SPEC §5.5): name (rename), keep across restarts, a forward's target.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate, useResource } from "../../../api/resources.ts"
import { fetchSites, KEYS } from "../../../api/sites.ts"
import { checkName } from "../../../lib/validate.ts"
import { navigate } from "../../../router.tsx"
import { Button, Field, Input, KeyValue, SettingsSection, toast } from "../../../ui/index.ts"
import { failText, SwitchField, useSettings, useToggle, type Line, type Visibility } from "./common.tsx"

interface RenameResponse { status: "renamed"; oldName: string; newName: string; message: string }
interface RegisterResponse { domain: string; status: "registered"; message: string }

export function GeneralSection(p: { v: Visibility }): React.JSX.Element {
  const { site, tld, offline } = useSettings()
  const sites = useResource(KEYS.sites, fetchSites, { every: 5000 })
  const [name, setName] = useState(site.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const target = site.route?.target

  const rename = async () => {
    const next = name.trim()
    const problem = checkName(next)
    if (problem) { setError(problem); return }
    if (next.toLowerCase() === site.name) { setName(site.name); return }
    setBusy(true)
    setError(null)
    try {
      const res = await getApi().post<RenameResponse>("/rename", { oldName: site.name, newName: next })
      const newName = res.newName || next.toLowerCase()
      toast(`Renamed to ${newName}.${tld}`, "success")
      await sites.reload()
      navigate(`/sites/${encodeURIComponent(newName)}/settings`, { replace: true })
    } catch (e) {
      setError(failText(e, "Failed to rename route"))
    } finally {
      setBusy(false)
    }
  }

  const persistent = useToggle(!!site.route?.persistent, async (next): Promise<Line> => {
    const body = typeof target === "string" ? { name: site.name, target, persistent: next } : { name: site.name, port: target, persistent: next }
    await getApi().post<RegisterResponse>("/register", body)
    invalidate([KEYS.sites])
    return { kind: "ok", text: next ? `${site.name} pinned` : `${site.name} unpinned` }
  }, { fallback: "Failed to update route" })

  const targetText = typeof target === "number" ? `:${target} on this machine` : typeof target === "string" ? target : "—"
  return (
    <SettingsSection id="general" title="General" dirty={false} saving={false} onSave={rename} onReset={() => setName(site.name)}>
      {p.v.rename ? (
        <Field label="Name" htmlFor="set-name" error={error} help={`Currently ${site.name}.${tld}`}>
          <div className="set-inline">
            <Input id="set-name" mono value={name} suffix={`.${tld}`} spellCheck={false} autoComplete="off" invalid={!!error}
              onChange={e => { setName(e.target.value); setError(null) }}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void rename() } }} />
            <Button onClick={rename} busy={busy} disabled={offline || name.trim().toLowerCase() === site.name}>Rename</Button>
          </div>
        </Field>
      ) : null}
      {p.v.persistent ? (
        <SwitchField id="set-persistent" label="Keep across restarts" help="The route survives a daemon restart."
          checked={persistent.checked} busy={persistent.busy} disabled={offline} line={persistent.line} onChange={persistent.change} />
      ) : null}
      {p.v.target ? (
        <KeyValue rows={[{
          label: "Target", value: targetText, mono: true,
          hint: "To point it elsewhere, delete it and add it again.",
        }]} />
      ) : null}
    </SettingsSection>
  )
}
