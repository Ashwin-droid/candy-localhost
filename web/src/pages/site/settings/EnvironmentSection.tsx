// Settings › Environment (SPEC §5.5): the env file. Not for static sites: no process ever starts to read it.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import { checkAbsPath } from "../../../lib/validate.ts"
import { Field, Input, SettingsSection } from "../../../ui/index.ts"
import { failText, useDraftSet, useSettings } from "./common.tsx"

interface EnvResponse { success: true; envFile: string | null; message: string }

export function EnvironmentSection(): React.JSX.Element {
  const { site, offline } = useSettings()
  const d = useDraftSet<"envFile", string>({ envFile: site.config?.envFile ?? "" })
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const path = d.draft.envFile.trim()
    const bad = checkAbsPath(path)
    if (bad) { setError(bad); return }
    setSaving(true)
    setStatus(null)
    try {
      const r = await getApi().post<EnvResponse>("/config/env", { name: site.name, envFile: path || null })
      invalidate([KEYS.sites])
      d.commit(["envFile"])
      const note = r.message ? ` ${r.message}` : ""
      setStatus({ kind: "ok", text: r.envFile ? `${site.name} gets its environment from ${r.envFile}.${note}` : `${site.name}: no env file.${note}` })
    } catch (e) {
      setError(failText(e, "Could not save the env file"))
    } finally {
      setSaving(false)
    }
  }
  return (
    <SettingsSection id="environment" title="Environment" dirty={d.dirty} saving={saving} status={status} conflict={d.conflict}
      onSave={save} onReset={() => { d.reset(); setError(null); setStatus(null) }}>
      <Field label="Env file" htmlFor="set-env" error={error}
        help={`A KEY=VALUE file. ${site.name} gets its values as environment variables from its next start. Use the full path, like /home/me/app/.env. Leave it empty for none.`}>
        <Input id="set-env" mono value={d.draft.envFile} placeholder="/home/me/app/.env" spellCheck={false} autoComplete="off"
          invalid={!!error} disabled={offline} onChange={e => { d.set("envFile", e.target.value); setError(null); setStatus(null) }} />
      </Field>
    </SettingsSection>
  )
}
