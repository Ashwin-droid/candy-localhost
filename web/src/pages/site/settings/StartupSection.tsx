// Settings › Startup (SPEC §5.5): API mode (saves on change), Stop after idle and Port (saved together, in order).

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import type { OkResponse } from "../../../api/types.ts"
import { checkMinutes, checkPort } from "../../../lib/validate.ts"
import { Field, Input, SettingsSection } from "../../../ui/index.ts"
import { enc, runSteps, useDraftSet, sentences, SwitchField, useSettings, useToggle, type Line, type Step, type Visibility } from "./common.tsx"

interface TtlResponse { success: true; minutes: number | null; defaultMinutes: number }
interface ApiModeResponse { success: true; api: boolean; message: string }

export const TTL_MAX = 10080

/** Idle minutes: empty (the usual), or a whole number from 1 to 10080. */
export function checkIdle(v: string): string | null {
  const bad = checkMinutes(v)
  if (bad) return bad
  const s = v.trim()
  if (s === "") return null
  const n = Number(s)
  return n >= 1 && n <= TTL_MAX ? null : "Enter a number of minutes from 1 to 10080 (a week)"
}

type Key = "ttl" | "port"

export function StartupSection(p: { v: Visibility }): React.JSX.Element {
  const { site, offline } = useSettings()
  const cfg = site.config
  const server = { ttl: cfg?.ttl != null ? String(cfg.ttl) : "", port: site.proc?.port != null ? String(site.proc.port) : "" }
  const d = useDraftSet<Key, string>(server)
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({})
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const api = useToggle(!!cfg?.api, async (next): Promise<Line> => {
    await getApi().post<ApiModeResponse>("/config/api", { name: site.name, api: next })
    invalidate([KEYS.sites])
    return { kind: "ok", text: next ? `${site.name} will hold the first request while it starts` : `${site.name} shows the loading page again` }
  }, { fallback: "Could not change API mode" })

  const edit = (k: Key, v: string) => {
    d.set(k, v)
    setErrors(e => ({ ...e, [k]: undefined }))
    setStatus(null)
  }

  const save = async () => {
    const dirty = new Set(d.dirtyKeys)
    const errs: Partial<Record<Key, string>> = {}
    if (dirty.has("ttl")) { const e = checkIdle(d.draft.ttl); if (e) errs.ttl = e }
    if (dirty.has("port")) { const e = checkPort(d.draft.port); if (e) errs.port = e }
    setErrors(errs)
    if (Object.keys(errs).length) return
    const steps: Step<Key>[] = []
    if (dirty.has("ttl")) steps.push({
      key: "ttl", run: async () => {
        const text = d.draft.ttl.trim()
        const r = await getApi().post<TtlResponse>("/config/ttl", { name: site.name, minutes: text ? Number(text) : null })
        return `${site.name} stops after ${r.minutes ?? r.defaultMinutes} idle minutes`
      },
    })
    if (dirty.has("port")) steps.push({
      key: "port", run: async () => {
        const port = Number(d.draft.port.trim())
        const r = await getApi().post<OkResponse>("/process/port/" + enc(site.name), { port })
        if (r.success === false) throw new Error(`Couldn't set the port for ${site.name}`)
        return `${site.name} now on :${port}`
      },
    })
    setSaving(true)
    setStatus(null)
    const r = await runSteps(steps, { ttl: "Could not save the idle time", port: "Failed to set port" })
    setSaving(false)
    if (r.saved.length) {
      invalidate([KEYS.sites])
      d.commit(r.saved)
    }
    if (r.failed) {
      const failed = r.failed
      setErrors({ [failed.key]: failed.message })
      // the saved ones are committed; the rest stay dirty
      if (r.saved.length) setStatus({ kind: "error", text: `${sentences(r.messages)} The rest wasn’t saved.` })
    } else {
      setStatus({ kind: "ok", text: sentences(r.messages) })
    }
  }

  const reset = () => { d.reset(); setErrors({}); setStatus(null) }

  return (
    <SettingsSection id="startup" title="Startup" dirty={d.dirty} saving={saving} status={status} conflict={d.conflict}
      onSave={save} onReset={reset}>
      {p.v.apiMode ? (
        <SwitchField id="set-api" label="API mode" help="Requests wait while it starts and are passed straight through. No loading page."
          checked={api.checked} busy={api.busy} disabled={offline} line={api.line} onChange={api.change} />
      ) : null}
      {p.v.ttl || p.v.port ? (
        <div className="fields-2">
          {p.v.ttl ? (
            <Field label="Stop after idle" htmlFor="set-ttl" usual="usual: 60" error={errors.ttl}
              help={`${site.name} stops after this many minutes without activity. Leave it empty for the usual 60. An open connection counts as activity.`}>
              <Input id="set-ttl" inputMode="numeric" mono suffix="min" placeholder="60" value={d.draft.ttl} invalid={!!errors.ttl}
                disabled={offline} onChange={e => edit("ttl", e.target.value)} />
            </Field>
          ) : null}
          {p.v.port ? (
            <Field label="Port" htmlFor="set-port" error={errors.port}
              help="Use this when port detection picked the wrong port. The route is updated to match.">
              <Input id="set-port" inputMode="numeric" mono prefix=":" value={d.draft.port} invalid={!!errors.port}
                disabled={offline} onChange={e => edit("port", e.target.value)} />
            </Field>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  )
}
