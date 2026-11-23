// Settings › Start commands (SPEC §5.5): the site's variants, each with Start and Delete. There is no API to
// add or edit one, so the table is read-only apart from those two.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import type { StartResponse, Variant } from "../../../api/types.ts"
import { shortPath } from "../../../lib/format.ts"
import { navigate } from "../../../router.tsx"
import { Button, Code, Section, Table, toast, useConfirm, type Column } from "../../../ui/index.ts"
import { enc, failText, StatusLine, useSettings, type Line } from "./common.tsx"

/** Delete one start command, or the whole config when it is the only one. Resolves false when cancelled. */
export async function deleteCommand(o: {
  name: string; id: string | null; hasRoute: boolean; confirm: ReturnType<typeof useConfirm>
}): Promise<boolean> {
  const ok = await o.confirm({ title: `Delete config for ${o.name}${o.id ? ` (${o.id})` : ""}?`, verb: "Delete", danger: true })
  if (!ok) return false
  const res = await getApi().del<{ success?: boolean; message?: string }>("/config/" + enc(o.name) + (o.id ? "/" + enc(o.id) : ""))
  invalidate([KEYS.sites])
  toast(res.message || "Config deleted", "success")
  if (!o.id && !o.hasRoute) navigate("/")
  return true
}

export function StartCommandsSection(): React.JSX.Element {
  const { site, multiUser, offline } = useSettings()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const [line, setLine] = useState<Line>(null)
  const variants = site.variants
  const several = variants.length > 1

  const start = async (v: Variant) => {
    setBusy(`start:${v.id}`)
    setLine(null)
    try {
      const res = await getApi().post<StartResponse>("/process/start/" + enc(site.name), { configId: v.id })
      invalidate([KEYS.sites])
      setLine({ kind: "ok", text: res.message || `${site.name} started` })
    } catch (e) {
      setLine({ kind: "error", text: failText(e, "Failed to start process") })
    } finally {
      setBusy(null)
    }
  }
  const remove = async (v: Variant) => {
    setBusy(`del:${v.id}`)
    setLine(null)
    try {
      await deleteCommand({ name: site.name, id: several ? v.id : null, hasRoute: !!site.route, confirm })
    } catch (e) {
      setLine({ kind: "error", text: failText(e, "Failed to delete config") })
    } finally {
      setBusy(null)
    }
  }

  const cols: Column<Variant>[] = [
    { key: "id", label: "Id", mono: true, render: v => v.id },
    { key: "cwd", label: "Folder", mono: true, priority: 2, render: v => <span title={v.cwd}>{shortPath(v.cwd)}</span> },
    { key: "cmd", label: "Command", priority: 2, render: v => <Code>{v.cmd}</Code> },
    ...(multiUser ? [{ key: "user", label: "Runs as", mono: true, priority: 3, render: (v: Variant) => v.user } as Column<Variant>] : []),
    { key: "api", label: "API mode", priority: 3, render: v => (v.api ? "On" : "Off") },
  ]
  return (
    <Section id="start-commands" title={`Start commands (${variants.length})`}
      description={<>Add another with <code>candy</code> on the command line.</>}>
      <Table label="Start commands" columns={cols} rows={variants} rowKey={(v, i) => `${i}`}
        actions={v => (
          <>
            {!site.active ? (
              <Button size="sm" variant="quiet" busy={busy === `start:${v.id}`} disabled={offline || busy !== null} onClick={() => start(v)}>Start</Button>
            ) : null}
            <Button size="sm" variant="danger" busy={busy === `del:${v.id}`} disabled={offline || busy !== null} onClick={() => remove(v)}>Delete</Button>
          </>
        )} />
      <StatusLine line={line} />
    </Section>
  )
}
