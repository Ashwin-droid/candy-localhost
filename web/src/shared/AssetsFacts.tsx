// The "Static assets" facts of a function (SPEC §5.4), shared by Overview and the Manifest tab.

import type React from "react"
import type { FnSummary } from "../api/types.ts"
import { shortPath } from "../lib/format.ts"
import { Code, EmptyState, KeyValue, type KVRow } from "../ui/index.ts"
import "./AssetsFacts.css"

const NOT_FOUND: Record<string, string> = {
  "single-page-application": "Single-page app: unknown paths get /index.html",
  "404-page": "Nearest 404.html, status 404",
  none: "Empty 404",
}

export const SPA_API_HINT = "For a SPA with an API, set \"run_worker_first\": [\"/api/*\"] so /api/* reaches the code instead of index.html."

export function assetsOrderHelp(fn: FnSummary): string {
  return `Order: worker-first patterns, then _redirects, then a matching file (with _headers), then ${fn.hasWorker ? "the code" : "the not-found rule"}. Edit "assets" in candy.json to change this.`
}

export function AssetsFacts(p: { fn: FnSummary }): React.JSX.Element {
  const a = p.fn.assets
  if (!a) return <EmptyState>No static assets. Add "assets" to candy.json to serve a folder.</EmptyState>
  const wf = a.runWorkerFirst
  let workerFirst: React.ReactNode
  let workerHint: React.ReactNode = undefined
  if (wf === true) {
    workerFirst = <Code>always</Code>
    workerHint = `Every request goes to the code first; it serves files through env.${a.binding || "ASSETS"}.fetch().`
  } else if (Array.isArray(wf) && wf.length) {
    workerFirst = (
      <span className="assets-patterns">
        {wf.map((pat, i) => <span key={i} className={pat.startsWith("!") ? "assets-pattern is-negated" : "assets-pattern"}><Code>{pat}</Code></span>)}
      </span>
    )
  } else {
    workerFirst = "Off."
    if (p.fn.hasWorker) workerHint = SPA_API_HINT
  }
  const rows: KVRow[] = [
    { label: "Folder", value: <span title={a.directory}>{shortPath(a.directory)}</span>, mono: true, rawKey: "assets.directory" },
    { label: "Worker first", value: workerFirst, hint: workerHint, rawKey: "assets.run_worker_first" },
    { label: "Not found", value: NOT_FOUND[a.notFound] ?? (a.notFound || "Empty 404"), rawKey: "assets.not_found_handling" },
    { label: "HTML", value: a.html || "auto-trailing-slash", mono: true, rawKey: "assets.html_handling" },
    { label: "Binding", value: a.binding ? `env.${a.binding}` : "None", mono: !!a.binding, rawKey: "assets.binding" },
  ]
  return (
    <div className="assets-facts">
      <KeyValue rows={rows} />
      <p className="help">{assetsOrderHelp(p.fn)}</p>
    </div>
  )
}
