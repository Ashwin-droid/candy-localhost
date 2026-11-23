// Shared pieces of the site Settings tab (SPEC §5.5): which sections and fields apply, the context every
// section reads, save-on-change switches, inline status lines and sequential saves.

import type React from "react"
import { createContext, useContext, useEffect, useState } from "react"
import { ApiError } from "../../../api/client.ts"
import type { Site } from "../../../lib/site.ts"
import { Icon, Switch, useDraft } from "../../../ui/index.ts"

export interface SettingsContext { site: Site; tld: string; superuser: boolean; multiUser: boolean; offline: boolean }
export const SettingsCtx = createContext<SettingsContext | null>(null)
export function useSettings(): SettingsContext {
  const c = useContext(SettingsCtx)
  if (!c) throw new Error("useSettings needs the Settings tab around it")
  return c
}

/** Which sections and fields the Settings tab shows. The records decide (route, config, proc), never the kind alone. */
export interface Visibility {
  general: boolean; rename: boolean; persistent: boolean; target: boolean
  startCommands: boolean
  startup: boolean; apiMode: boolean; ttl: boolean; port: boolean
  scaling: boolean; scalingWorker: boolean
  environment: boolean
  sandbox: boolean; sandboxFields: boolean
  reach: boolean; localPort: boolean; lan: boolean; lanHttps: boolean; tailscale: boolean; domains: boolean; tunnel: boolean
  danger: boolean; deleteRoute: boolean; deleteCommands: boolean; deleteFunction: boolean
}

/** lan / lanHttps / tsServe: off the route when there is one, else off the config (01 §4.6). */
export function reachOf(site: Site): { lan: boolean; lanHttps: string | null; tsServe: string | null } {
  const src = site.route ?? site.config
  return { lan: !!src?.lan, lanHttps: src?.lanHttps ?? null, tsServe: src?.tsServe ?? null }
}

export function visibility(site: Site, who: { superuser: boolean; multiUser: boolean }): Visibility {
  const fn = !!site.fn, route = !!site.route, config = !!site.config, proc = !!site.proc
  const isStatic = site.kind === "static"
  const rename = route && !fn
  // POST /register needs the route's port or address and refuses functions, so pinning is for plain routes
  const persistent = route && !fn
  const target = site.kind === "forward"
  const apiMode = config && !fn
  const port = proc && !fn
  const scaling = fn && config
  const sandbox = who.multiUser && config && !isStatic
  // a function without an HTTP handler has no URL, so there is nothing to reach (no port, LAN, tailnet or domain)
  const routed = (route || config) && !site.noUrl
  const lan = who.superuser && routed
  const tunnel = route && !fn && !site.route?.isRestricted
  const deleteRoute = route && !fn, deleteCommands = config && !fn, deleteFunction = fn && config
  return {
    general: rename || persistent || target, rename, persistent, target,
    startCommands: config && !fn,
    startup: apiMode || port, apiMode, ttl: apiMode, port,
    scaling, scalingWorker: scaling && !!site.fn?.hasWorker,
    environment: config && !isStatic,
    sandbox, sandboxFields: sandbox && !!site.config?.sandbox,
    reach: routed, localPort: routed, lan, lanHttps: lan && reachOf(site).lan, tailscale: lan, domains: routed, tunnel,
    danger: deleteRoute || deleteCommands || deleteFunction, deleteRoute, deleteCommands, deleteFunction,
  }
}

/** The text for a failed call: the server's own words, or the old page's fallback when the daemon can't be reached. */
export function failText(e: unknown, fallback: string): string {
  if (e instanceof ApiError) return e.status === 0 || !e.message ? fallback : e.message
  if (e instanceof Error && e.message) return e.message      // our own checks of an answer
  return fallback
}

export type Line = { kind: "ok" | "error" | "warn"; text: string } | null

/** A one-line result under a control. */
export function StatusLine(p: { line: Line }): React.JSX.Element | null {
  if (!p.line) return null
  const icon = p.line.kind === "ok" ? "check" : p.line.kind === "warn" ? "warn" : "error"
  return (
    <div className={`set-line is-${p.line.kind}`} role={p.line.kind === "error" ? "alert" : "status"}>
      <Icon name={icon} size={14} />
      <span>{p.line.text}</span>
    </div>
  )
}

/**
 * A switch that saves on change: it flips at once, and flips back when the save fails. `save` returns the
 * line to show (success or warning); a thrown error becomes the error line. `confirm` may cancel the flip.
 */
export function useToggle(server: boolean, save: (next: boolean) => Promise<Line>,
  o: { fallback: string; confirm?: (next: boolean) => Promise<boolean> }) {
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<Line>(null)
  // once the daemon reports the value we asked for, follow the daemon again
  useEffect(() => { if (optimistic !== null && optimistic === server && !busy) setOptimistic(null) }, [server, optimistic, busy])
  const change = async (next: boolean) => {
    if (o.confirm && !(await o.confirm(next))) return
    setOptimistic(next)
    setBusy(true)
    setLine(null)
    try {
      setLine(await save(next))
    } catch (e) {
      setOptimistic(null)
      setLine({ kind: "error", text: failText(e, o.fallback) })
    } finally {
      setBusy(false)
    }
  }
  return { checked: optimistic ?? server, busy, line, change }
}

/** A labelled switch row: label and help on the left, the switch on the right, its result line under it. */
export function SwitchField(p: {
  id: string; label: string; help?: React.ReactNode; checked: boolean; onChange: (next: boolean) => void
  busy?: boolean; disabled?: boolean; line?: Line; children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="set-switch">
      <div className="set-switch-row">
        <div className="set-switch-text">
          <label className="set-switch-label" htmlFor={p.id}>{p.label}</label>
          {p.help ? <div className="help" id={`${p.id}-help`}>{p.help}</div> : null}
        </div>
        <Switch id={p.id} label={p.label} checked={p.checked} onChange={p.onChange} busy={p.busy} disabled={p.disabled} />
      </div>
      {p.children}
      <StatusLine line={p.line ?? null} />
    </div>
  )
}

export interface Step<K extends string> { key: K; run: () => Promise<string> }
export interface StepsResult<K extends string> { saved: K[]; messages: string[]; failed: { key: K; message: string } | null }

/** Runs saves one after another (the main lane serialises them anyway) and stops at the first failure. */
export async function runSteps<K extends string>(steps: Step<K>[], fallback: Record<K, string>): Promise<StepsResult<K>> {
  const out: StepsResult<K> = { saved: [], messages: [], failed: null }
  for (const s of steps) {
    try {
      out.messages.push(await s.run())
      out.saved.push(s.key)
    } catch (e) {
      out.failed = { key: s.key, message: failText(e, fallback[s.key]) }
      break
    }
  }
  return out
}

/** "a. b." from step messages, each ending in one full stop. */
export const sentences = (msgs: string[]) => msgs.map(m => (/[.!?]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`)).join(" ")

export const enc = encodeURIComponent

/**
 * One useDraft per field, so a save that stops half way can commit just the fields that saved and leave the
 * rest dirty (useDraft's own commit settles the whole draft). `server` must always have the same keys.
 */
export function useDraftSet<K extends string, V>(server: Record<K, V>) {
  const keys = Object.keys(server) as K[]
  const drafts = {} as Record<K, ReturnType<typeof useDraft<{ v: V }>>>
  // the key list is fixed for a section, so the hook order is stable
  for (const k of keys) drafts[k] = useDraft<{ v: V }>({ v: server[k] })
  const dirtyKeys = keys.filter(k => drafts[k].dirty)
  return {
    draft: Object.fromEntries(keys.map(k => [k, drafts[k].draft.v])) as Record<K, V>,
    set: (k: K, v: V) => drafts[k].set("v", v),
    dirtyKeys,
    dirty: dirtyKeys.length > 0,
    conflict: keys.some(k => drafts[k].conflict),
    reset: () => { for (const k of keys) drafts[k].reset() },
    commit: (saved: K[]) => { for (const k of saved) drafts[k].commit() },
  }
}
