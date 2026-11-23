// Settings › Scaling (SPEC §5.5, 01 §13.1): hot, max, linger and the request log of a function. A static
// (assets-only) function has only the request log.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import type { FnSummary } from "../../../api/types.ts"
import { Field, Input, SettingsSection, Select } from "../../../ui/index.ts"
import { failText, useDraftSet, useSettings, type Visibility } from "./common.tsx"

type LogSel = "full" | "meta" | "off"
type Key = "hot" | "max" | "linger" | "log"

export const WORKER_HINT = "Hot instances stay warm and take the first request with no cold start. With hot at 0, an instance starts on a request and exits as soon as it’s idle. Max caps how many run at once. Linger is how long an idle instance waits for the next request before it exits."
export const STATIC_HINT = "Assets-only: the daemon serves the files itself and no process ever starts, so hot, max and linger don’t apply."

const logSel = (log: FnSummary["log"]): LogSel => (log === "meta" ? "meta" : log === false ? "off" : "full")
const logValue = (sel: string): true | false | "meta" => (sel === "off" ? false : sel === "meta" ? "meta" : true)

/** The old panel's checks, in its order. null = ok. */
export function checkScaling(v: { hot: string; max: string; linger: string }): { key: "hot" | "max" | "linger"; text: string } | null {
  const whole = (s: string) => /^\d+$/.test(s.trim())
  const hot = Number(v.hot.trim()), max = Number(v.max.trim()), linger = Number(v.linger.trim())
  if (!whole(v.hot) || hot < 0) return { key: "hot", text: "Hot must be 0 or more" }
  if (!whole(v.max) || max < 1) return { key: "max", text: "Max must be at least 1" }
  if (hot > max) return { key: "hot", text: "Hot can’t be more than max" }
  if (!whole(v.linger) || linger > 600) return { key: "linger", text: "Linger must be 0 to 600 seconds" }
  return null
}

export function ScalingSection(p: { v: Visibility }): React.JSX.Element {
  const { site, offline } = useSettings()
  const fn = site.fn!
  const worker = p.v.scalingWorker
  const d = useDraftSet<Key, string>({ hot: String(fn.hot), max: String(fn.max), linger: String(fn.linger), log: logSel(fn.log) })
  const [error, setError] = useState<{ key: Key; text: string } | null>(null)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const edit = (k: Key, v: string) => { d.set(k, v); setError(null); setStatus(null) }
  const save = async () => {
    const sel = d.draft.log
    let body: Record<string, unknown>
    let done: string
    if (worker) {
      const bad = checkScaling(d.draft)
      if (bad) { setError(bad); return }
      const hot = Number(d.draft.hot), max = Number(d.draft.max), linger = Number(d.draft.linger)
      body = { name: site.name, hot, max, linger, log: logValue(sel) }
      done = `${site.name}: hot ${hot}, max ${max}, linger ${linger}s, request log ${sel}`
    } else {
      body = { name: site.name, log: logValue(sel) }
      done = `${site.name}: request log ${sel}`
    }
    setSaving(true)
    setStatus(null)
    try {
      await getApi().post("/fn/settings", body)
      invalidate([KEYS.sites, KEYS.deploys(site.name), KEYS.instances(site.name)])
      d.commit(d.dirtyKeys)
      setStatus({ kind: "ok", text: done })
    } catch (e) {
      setStatus({ kind: "error", text: `Couldn’t save: ${failText(e, "Can't reach the candy daemon.")}` })
    } finally {
      setSaving(false)
    }
  }
  const reset = () => { d.reset(); setError(null); setStatus(null) }
  const err = (k: Key) => (error?.key === k ? error.text : null)

  return (
    <SettingsSection id="scaling" title={worker ? "Scaling" : "Request log"} description={worker ? WORKER_HINT : STATIC_HINT}
      dirty={d.dirty} saving={saving} status={status} conflict={d.conflict} onSave={save} onReset={reset}>
      {worker ? (
        <div className="fields-3">
          <Field label="Hot" htmlFor="set-hot" usual="usual: 0" error={err("hot")}>
            <Input id="set-hot" inputMode="numeric" mono value={d.draft.hot} invalid={!!err("hot")} disabled={offline}
              onChange={e => edit("hot", e.target.value)} />
          </Field>
          <Field label="Max" htmlFor="set-max" usual="usual: 4" error={err("max")}>
            <Input id="set-max" inputMode="numeric" mono value={d.draft.max} invalid={!!err("max")} disabled={offline}
              onChange={e => edit("max", e.target.value)} />
          </Field>
          <Field label="Linger" htmlFor="set-linger" usual="usual: 30" error={err("linger")}>
            <Input id="set-linger" inputMode="numeric" mono suffix="s" value={d.draft.linger} invalid={!!err("linger")} disabled={offline}
              onChange={e => edit("linger", e.target.value)} />
          </Field>
        </div>
      ) : null}
      <div className="fields-2">
        <Field label="Request log" htmlFor="set-log"
          help={worker ? "What the Requests tab keeps of each request, for 24 hours." : undefined}>
          <Select id="set-log" value={d.draft.log} disabled={offline} onChange={e => edit("log", e.target.value)}>
            <option value="full">Full (bodies)</option>
            <option value="meta">Metadata only</option>
            <option value="off">Off</option>
          </Select>
        </Field>
      </div>
    </SettingsSection>
  )
}
