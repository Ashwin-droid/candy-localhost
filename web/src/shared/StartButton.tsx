// Start for a server that isn't running (SPEC §5.1, §5.3). Shown when `!fn && (proc || config) && !active`.
// With several start commands it is "Start ▾", a small popover with "Start <id>" per command; a 409 that lists
// configs opens the same popover instead of an error.

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { ApiError, getApi } from "../api/client.ts"
import { invalidate } from "../api/resources.ts"
import { KEYS } from "../api/sites.ts"
import type { StartResponse } from "../api/types.ts"
import { shortPath } from "../lib/format.ts"
import type { Site } from "../lib/site.ts"
import { Button, Icon, toast } from "../ui/index.ts"
import "./StartButton.css"

interface Choice { id: string; cwd: string; cmd: string }

/** Whether a Start button applies to this site at all. */
export function canStart(site: Site): boolean {
  return !site.fn && (!!site.proc || !!site.config) && !site.active
}

export async function startSite(name: string, configId?: string): Promise<StartResponse> {
  toast(`Starting ${name}${configId ? ` (${configId})` : ""}…`, "info")
  const body = configId ? { configId } : {}
  const res = await getApi().post<StartResponse>("/process/start/" + encodeURIComponent(name), body)
  invalidate([KEYS.sites])
  return res
}

export function StartButton(p: { site: Site; size?: "md" | "sm" }): React.JSX.Element | null {
  const { site } = p
  const [busy, setBusy] = useState(false)
  const [choices, setChoices] = useState<Choice[] | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!choices) return
    root.current?.querySelector<HTMLElement>(".start-pop button")?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setChoices(null) }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [choices])

  if (!canStart(site)) return null
  const several = site.variants.length > 1

  const run = async (configId?: string) => {
    setChoices(null)
    setBusy(true)
    try {
      const res = await startSite(site.name, configId)
      toast(res.message || `${site.name} started`, "success")
    } catch (e) {
      const data = e instanceof ApiError ? e.data as { configs?: Choice[] } : null
      if (e instanceof ApiError && e.status === 409 && Array.isArray(data?.configs) && data.configs.length) {
        setChoices(data.configs)
      } else {
        toast(e instanceof Error && e.message ? e.message : "Failed to start process", "error")
      }
    } finally {
      setBusy(false)
    }
  }

  const open = () => setChoices(site.variants.map(v => ({ id: v.id, cwd: v.cwd, cmd: v.cmd })))

  return (
    <div className="start" ref={root}
      onKeyDown={e => { if (e.key === "Escape" && choices) { e.stopPropagation(); setChoices(null) } }}>
      <Button size={p.size ?? "md"} busy={busy} aria-haspopup={several ? "true" : undefined} aria-expanded={several ? !!choices : undefined}
        onClick={() => (several ? (choices ? setChoices(null) : open()) : void run())}>
        {several ? <>Start<Icon name="chevron-down" size={12} className="start-chevron" /></> : "Start"}
      </Button>
      {choices ? (
        <div className="start-pop" role="group" aria-label={`Start commands of ${site.name}`}>
          {choices.map(c => (
            <button key={c.id} type="button" className="start-pop-item" onClick={() => void run(c.id)}>
              <span className="start-pop-title">Start {c.id}</span>
              <span className="start-pop-detail mono">{shortPath(c.cwd)} · {c.cmd}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
