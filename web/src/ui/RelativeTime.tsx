import type React from "react"
import { useSyncExternalStore } from "react"
import { fmtDate, relTime } from "../lib/format.ts"

// One shared 30 s tick for every RelativeTime on the page
let tick = 0
const subs = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
const subscribe = (cb: () => void) => {
  subs.add(cb)
  if (!timer) timer = setInterval(() => { tick++; for (const s of subs) s() }, 30_000)
  return () => { subs.delete(cb); if (!subs.size && timer) { clearInterval(timer); timer = null } }
}
const snap = () => tick

/** "3 min ago", with the full local date as its title. Re-renders every 30 s. */
export function RelativeTime(p: { at: number | string }): React.JSX.Element {
  useSyncExternalStore(subscribe, snap, snap)
  const d = new Date(p.at)
  const valid = !Number.isNaN(d.getTime())
  return (
    <time dateTime={valid ? d.toISOString() : undefined} title={valid ? fmtDate(d.getTime()) : undefined}>
      {valid ? relTime(d.getTime(), Date.now()) : "—"}
    </time>
  )
}
