// Settings › Delete (SPEC §5.5, §5.12): delete the route, a start command, or the function. Each confirms first.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../../api/client.ts"
import { invalidate } from "../../../api/resources.ts"
import { KEYS } from "../../../api/sites.ts"
import { navigate } from "../../../router.tsx"
import { Button, KeyValue, Section, toast, useConfirm, type KVRow } from "../../../ui/index.ts"
import { enc, failText, StatusLine, useSettings, type Line, type Visibility } from "./common.tsx"
import { deleteCommand } from "./StartCommandsSection.tsx"

interface UnregisterResponse { status: "removed"; message: string }

export function DangerSection(p: { v: Visibility }): React.JSX.Element {
  const { site, tld, offline } = useSettings()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const [line, setLine] = useState<Line>(null)

  const act = async (key: string, fallback: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setLine(null)
    try { await fn() } catch (e) { setLine({ kind: "error", text: failText(e, fallback) }) } finally { setBusy(null) }
  }
  const deleteRoute = () => act("route", "Failed to delete route", async () => {
    const ok = await confirm({ title: `Delete ${site.name}.${tld}?`, body: "It also stops its process.", verb: "Delete", danger: true })
    if (!ok) return
    const r = await getApi().del<UnregisterResponse>("/register/" + enc(site.name))
    invalidate([KEYS.sites])
    toast(r.message || "Route deleted", "success")
    // the site stays when a start command still holds the name
    if (!site.config) navigate("/")
  })
  const deleteFunction = () => act("fn", "Failed to delete config", async () => {
    const ok = await confirm({
      title: `Delete config for ${site.name}?`, body: "Its KV and D1 data stay in its state folder.", verb: "Delete", danger: true,
      typeToConfirm: site.name,
    })
    if (!ok) return
    const r = await getApi().del<{ message?: string }>("/config/" + enc(site.name))
    invalidate([KEYS.sites])
    toast(r.message || "Config deleted", "success")
    navigate("/")
  })

  const several = site.variants.length > 1
  const button = (key: string, label: string, onClick: () => void) => (
    <Button variant="danger" size="sm" busy={busy === key} disabled={offline || busy !== null} onClick={onClick}>{label}</Button>
  )
  const rows: KVRow[] = []
  if (p.v.deleteRoute) rows.push({
    label: "Route", value: `${site.name}.${tld}`, mono: true, hint: "Deleting the route also stops its process.",
    action: button("route", "Delete route", deleteRoute),
  })
  if (p.v.deleteCommands) for (const v of site.variants) rows.push({
    label: several ? `Start command ${v.id}` : "Start command", value: v.cmd, mono: true,
    hint: several ? undefined : `Deleting it removes ${site.name}'s config: its settings on this page go with it.`,
    action: button(`cmd:${v.id}`, several ? `Delete command ${v.id}` : "Delete start command", () => act(`cmd:${v.id}`, "Failed to delete config",
      () => deleteCommand({ name: site.name, id: several ? v.id : null, hasRoute: !!site.route, confirm }))),
  })
  if (p.v.deleteFunction) rows.push({
    label: "Function", value: site.name, mono: true, hint: "Its KV and D1 data stay in its state folder.",
    action: button("fn", "Delete function", deleteFunction),
  })
  return (
    <Section id="danger" title="Delete" description="These can’t be undone.">
      <KeyValue rows={rows} labelWidth={180} />
      <StatusLine line={line} />
    </Section>
  )
}
