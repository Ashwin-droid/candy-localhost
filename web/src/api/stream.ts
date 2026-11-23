// Server-sent events over fetch (never EventSource: it can't send X-Candy-Session). SPEC §7.4.

import { useEffect, useRef, useState } from "react"
import { getApi, type Query } from "./client.ts"

export interface SseEvent { event: string /* "message" when absent */; data: string }

/** Pure: feed it each decoded chunk plus the previous carry. Blocks end at a blank line; comments are ignored. */
export function parseSse(chunk: string, carry: string): { events: SseEvent[]; carry: string } {
  const text = (carry + chunk).replace(/\r\n?/g, "\n")
  const blocks = text.split("\n\n")
  const rest = blocks.pop() ?? ""
  const events: SseEvent[] = []
  for (const block of blocks) {
    let event = "message"
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue
      const i = line.indexOf(":")
      const field = i < 0 ? line : line.slice(0, i)
      let value = i < 0 ? "" : line.slice(i + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "event") event = value || "message"
      else if (field === "data") data.push(value)
    }
    if (data.length) events.push({ event, data: data.join("\n") })
  }
  return { events, carry: rest }
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve()
  const t = setTimeout(resolve, ms)
  signal.addEventListener("abort", () => { clearTimeout(t); resolve() }, { once: true })
})

/**
 * Keep a stream open while mounted (path null = closed). Reconnects `retryMs` after a drop; when the document
 * has been hidden longer than `pauseHiddenMs` it disconnects ("paused") and reconnects once visible again.
 * `onOpen` runs on every (re)connect, so a caller can clear what the server is about to replay.
 */
export function useStream(path: string | null, query: Query | undefined,
  o: { onEvent: (e: SseEvent) => void; onOpen?: () => void; retryMs: number; pauseHiddenMs?: number }): "connecting" | "live" | "paused" {
  const [state, setState] = useState<"connecting" | "live" | "paused">("connecting")
  const handlers = useRef(o)
  handlers.current = o
  const queryKey = JSON.stringify(query ?? {})

  useEffect(() => {
    if (path === null) { setState("paused"); return }
    const stop = new AbortController()
    let conn: AbortController | null = null
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null
    let pausedForHidden = false
    let wake: (() => void) | null = null
    const q = JSON.parse(queryKey) as Query

    const onVisibility = () => {
      const ms = handlers.current.pauseHiddenMs
      if (ms === undefined) return
      if (document.hidden) {
        if (!hiddenTimer) hiddenTimer = setTimeout(() => { pausedForHidden = true; conn?.abort() }, ms)
      } else {
        if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null }
        if (pausedForHidden) { pausedForHidden = false; wake?.() }
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    void (async () => {
      while (!stop.signal.aborted) {
        if (pausedForHidden) {
          setState("paused")
          await new Promise<void>(r => { wake = r; stop.signal.addEventListener("abort", () => r(), { once: true }) })
          wake = null
          continue
        }
        setState("connecting")
        conn = new AbortController()
        const onStop = () => conn?.abort()
        stop.signal.addEventListener("abort", onStop, { once: true })
        try {
          const res = await getApi().stream(path, q, { signal: conn.signal })
          if (res.ok && res.body) {
            setState("live")
            handlers.current.onOpen?.()
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let carry = ""
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              const r = parseSse(dec.decode(value, { stream: true }), carry)
              carry = r.carry
              for (const ev of r.events) handlers.current.onEvent(ev)
            }
          } else {
            await res.body?.cancel().catch(() => {})
          }
        } catch { /* dropped or aborted */ }
        stop.signal.removeEventListener("abort", onStop)
        if (stop.signal.aborted) break
        setState("paused")
        if (!pausedForHidden) await wait(handlers.current.retryMs, stop.signal)
      }
    })()

    return () => {
      stop.abort()
      if (hiddenTimer) clearTimeout(hiddenTimer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [path, queryKey])

  return state
}
