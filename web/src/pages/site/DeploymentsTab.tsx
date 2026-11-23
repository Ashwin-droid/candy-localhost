// Deployments tab (SPEC §5.9). Owned by package C.

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate, useResource } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import type { DeployInfo, DeploysResponse } from "../../api/types.ts"
import { fmtBytes, fmtDate, shortPath } from "../../lib/format.ts"
import type { TabProps } from "../../lib/site.ts"
import { Button, type Column, errorMessage, Icon, KeyValue, Section, Table, toast, useConfirm } from "../../ui/index.ts"
import "./requests.css"

interface DeployResult { success: true; deploy: DeployInfo }

/** "21 Nov 2026, 14:02": the medium date and the short time. */
export const createdText = (t: number): string => fmtDate(t).replace(/:\d\d$/, "")

/** "1a2b3c4d · src/index.ts": the git revision (8) and the entry. */
export const sourceText = (d: Pick<DeployInfo, "gitRev" | "main">): string =>
  [d.gitRev ? String(d.gitRev).slice(0, 8) : "", d.main || ""].filter(Boolean).join(" · ")

const touched = (name: string) => [KEYS.sites, KEYS.deploys(name), KEYS.instances(name)]

export default function DeploymentsTab(p: TabProps): React.JSX.Element {
  const { name } = p.site
  const confirm = useConfirm()
  const r = useResource<DeploysResponse>(KEYS.deploys(name),
    signal => getApi().get<DeploysResponse>("/fn/deploys", { name }, { signal }))
  const [line, setLine] = useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)   // "deploy" | "dev" | a deploy id
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // a deploy that appears at the top flashes once
  const lastTop = useRef<string | null | undefined>(undefined)
  const [fresh, setFresh] = useState<string | null>(null)
  const top = r.data?.deploys?.[0]?.id ?? null
  useEffect(() => {
    if (r.data === undefined) return
    if (lastTop.current !== undefined && top && top !== lastTop.current) {
      setFresh(top)
      const t = setTimeout(() => setFresh(null), 1200)
      lastTop.current = top
      return () => clearTimeout(t)
    }
    lastTop.current = top
  }, [top, r.data])

  const report = (error: boolean, text: string) => {
    if (mounted.current) setLine({ error, text })
    else toast(text, error ? "error" : "success")
  }

  const deploy = async () => {
    setBusy("deploy")
    setLine({ error: false, text: `Deploying ${name}…` })
    try {
      const res = await getApi().post<DeployResult>("/fn/deploy", { name }, { lane: "long" })
      invalidate(touched(name))
      report(false, `${name} deployed ${res.deploy?.id ?? ""}`.trim())
    } catch (e) {
      report(true, `Deploy failed: ${errorMessage(e)}`)
    } finally { if (mounted.current) setBusy(null) }
  }

  const rollback = async (id: string) => {
    const ok = await confirm({ title: `Roll ${name} back to ${id}?`, body: "Requests go to that snapshot right away.", verb: "Roll back" })
    if (!ok) return
    setBusy(id)
    try {
      await getApi().post<DeployResult>("/fn/rollback", { name, id }, { lane: "long" })
      invalidate(touched(name))
      report(false, `${name} is running ${id}`)
    } catch (e) {
      report(true, `Rollback failed: ${errorMessage(e)}`)
    } finally { if (mounted.current) setBusy(null) }
  }

  const backToDev = async () => {
    const ok = await confirm({ title: `Unpin ${name} and serve the live source folder again?`, verb: "Back to dev" })
    if (!ok) return
    setBusy("dev")
    try {
      await getApi().post("/fn/dev", { name }, { lane: "long" })
      invalidate(touched(name))
      report(false, `${name} is back on the live source`)
    } catch (e) {
      report(true, `Couldn’t switch to dev: ${errorMessage(e)}`)
    } finally { if (mounted.current) setBusy(null) }
  }

  const current = r.data ? r.data.current ?? null : p.site.fn?.deploy ?? null
  const cwd = p.site.config?.cwd
  const columns: Column<DeployInfo>[] = [
    { key: "id", label: "Deploy", mono: true, render: d => <>{fresh === d.id ? <span className="req-fresh" aria-hidden="true" /> : null}{d.id}</> },
    { key: "created", label: "Created", render: d => <span className="nowrap" title={fmtDate(d.createdAt)}>{d.createdAt ? createdText(d.createdAt) : "—"}</span> },
    { key: "size", label: "Size", align: "right", priority: 2, render: d => (d.entry === null ? <span className="ink-2">no code</span> : <span className="tnum">{fmtBytes(d.size)}</span>) },
    { key: "assets", label: "Assets", priority: 3, render: d => (d.assets ? <span title={d.assets}>Yes</span> : <span className="ink-3">—</span>) },
    { key: "source", label: "Source", mono: true, priority: 3, render: d => <span title={d.source || undefined}>{sourceText(d) || "—"}</span> },
  ]

  return (
    <>
      <Section title="Serving">
        <div className="dep-serving">
          <KeyValue rows={[
            {
              label: "Serving", value: current ? <><span className="mono">{current}</span>, pinned</> : "dev, live from the source folder",
              action: current ? <Button size="sm" busy={busy === "dev"} disabled={!!busy && busy !== "dev"} onClick={() => void backToDev()}>Back to dev</Button> : undefined,
            },
            { label: "Source folder", value: cwd ? <span title={cwd}>{shortPath(cwd)}</span> : null, mono: true, hidden: !cwd },
          ]} />
          {line ? (
            <div className={line.error ? "req-status is-error" : "req-status"} role="status">
              <Icon name={line.error ? "error" : busy === "deploy" ? "info" : "check"} size={14} />{line.text}
            </div>
          ) : null}
        </div>
      </Section>
      <Section title="Deploys" description="Each deploy is a snapshot of the code that doesn’t change when you edit the source. The last 10 are kept for rollback.">
        <Table<DeployInfo> label={`Deploys of ${name}`} columns={columns} rows={r.data ? r.data.deploys ?? [] : undefined}
          rowKey={d => d.id} selectedKey={current}
          loading={r.loading} error={r.error ? `Couldn’t load deploys: ${r.error.message}` : null} onRetry={() => void r.reload()}
          actions={d => (d.id === current
            ? <span className="ink-2 small dep-current">Current</span>
            : <Button size="sm" variant="quiet" busy={busy === d.id} disabled={!!busy && busy !== d.id} onClick={() => void rollback(d.id)}>Roll back</Button>)}
          empty={<div className="dep-empty">
            <p>No deploys yet. Deploy bundles the current code into a snapshot that doesn’t change when you edit the source. The last 10 are kept for rollback.</p>
            <Button variant="primary" busy={busy === "deploy"} onClick={() => void deploy()}>{busy === "deploy" ? "Deploying…" : "Deploy"}</Button>
          </div>} />
      </Section>
    </>
  )
}
