// Settings › Sandbox and memory (SPEC §5.5): multi-user only. The sandbox switch saves on change (Confirm before
// turning it off); the memory limit and writable folders are saved together, in order.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import type { MemoryResponse, SandboxResponse } from "../../../api/types.ts"
import { fmtMb } from "../../../lib/format.ts"
import { checkAbsPath, parseMemory } from "../../../lib/validate.ts"
import { Field, Input, ListEditor, SettingsSection, useConfirm } from "../../../ui/index.ts"
import { runSteps, sentences, SwitchField, useDraftSet, useSettings, useToggle, type Line, type Step } from "./common.tsx"

type Key = "memory" | "rw"

export function SandboxSection(): React.JSX.Element {
  const { site, offline } = useSettings()
  const cfg = site.config!
  const confirm = useConfirm()
  const d = useDraftSet<Key, string | string[]>({ memory: cfg.memory ? fmtMb(cfg.memory) : "", rw: cfg.rw ?? [] })
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({})
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const sandbox = useToggle(!!cfg.sandbox, async (next): Promise<Line> => {
    await getApi().post<SandboxResponse>("/config/sandbox", { name: site.name, sandbox: next })
    invalidate([KEYS.sites])
    return { kind: "ok", text: `${site.name}: sandbox ${next ? "on" : "off"} from its next start` }
  }, {
    fallback: "Could not change the sandbox",
    confirm: next => next ? Promise.resolve(true) : confirm({
      title: `Run ${site.name} without the sandbox?`, body: "It will be able to write anywhere its user can.", verb: "Turn off", danger: true,
    }),
  })

  const memory = d.draft.memory as string
  const rw = d.draft.rw as string[]
  const edit = (k: Key, v: string | string[]) => { d.set(k, v); setErrors(e => ({ ...e, [k]: undefined })); setStatus(null) }

  const save = async () => {
    const dirty = new Set(d.dirtyKeys)
    const errs: Partial<Record<Key, string>> = {}
    const mem = parseMemory(memory)
    if (dirty.has("memory") && typeof mem === "string") errs.memory = mem
    const folders = rw.map(x => x.trim()).filter(Boolean)
    if (dirty.has("rw")) {
      const bad = folders.map(f => checkAbsPath(f)).find(Boolean)
      if (bad) errs.rw = bad
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    const steps: Step<Key>[] = []
    if (dirty.has("memory")) steps.push({
      key: "memory", run: async () => {
        const r = await getApi().post<MemoryResponse>("/config/memory", { name: site.name, memory: mem })
        return `${site.name}: memory limit ${r.text}${r.applied === "now" ? "" : ", from its next start"}`
      },
    })
    if (dirty.has("rw")) steps.push({
      key: "rw", run: async () => {
        const r = await getApi().post<SandboxResponse>("/config/sandbox", { name: site.name, rw: folders })
        return r.rw?.length ? `${site.name} can also write to ${r.rw.join(", ")}` : `${site.name}: no extra writable folders`
      },
    })
    setSaving(true)
    setStatus(null)
    const r = await runSteps(steps, { memory: "Could not save the memory limit", rw: "Could not save the writable folders" })
    setSaving(false)
    if (r.saved.length) { invalidate([KEYS.sites]); d.commit(r.saved) }
    if (r.failed) {
      setErrors({ [r.failed.key]: r.failed.message })
      if (r.saved.length) setStatus({ kind: "error", text: `${sentences(r.messages)} The rest wasn’t saved.` })
    } else setStatus({ kind: "ok", text: sentences(r.messages) })
  }

  return (
    <SettingsSection id="sandbox" title="Sandbox and memory" dirty={d.dirty} saving={saving} status={status} conflict={d.conflict}
      onSave={save} onReset={() => { d.reset(); setErrors({}); setStatus(null) }}>
      <SwitchField id="set-sandbox" label="Sandbox"
        help={`${site.name} runs with a read-only filesystem except its own folder, its state folder and a private /tmp.`}
        checked={sandbox.checked} busy={sandbox.busy} disabled={offline} line={sandbox.line} onChange={sandbox.change} />
      {sandbox.checked ? (
        <>
          <div className="fields-2">
            <Field label="Memory limit" htmlFor="set-memory" usual="usual: 2G" error={errors.memory}
              help={`Like 4G or 512M, at most 16G. Leave it empty for the usual 2G. If ${site.name} uses more than this, it is stopped.`}>
              <Input id="set-memory" mono value={memory} placeholder="2G" spellCheck={false} autoComplete="off" invalid={!!errors.memory}
                disabled={offline} onChange={e => edit("memory", e.target.value)} />
            </Field>
          </div>
          <Field label="Writable folders" error={errors.rw}
            help={`${site.name} can always write to its own folder, its state folder and a private /tmp. Add full paths of other folders it needs to write to. Leave it empty for none. Takes effect at its next start.`}>
            <ListEditor mono values={rw} onChange={v => edit("rw", v)} placeholder="/home/me/shared" addLabel="Add folder" />
          </Field>
        </>
      ) : (
        <p className="help">Memory limit and writable folders apply only in the sandbox.</p>
      )}
    </SettingsSection>
  )
}
