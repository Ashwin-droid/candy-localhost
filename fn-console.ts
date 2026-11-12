// Per-request console capture for the function shim. While a request runs
// inside run(requestId, fn), console.* still prints as usual and each call is
// also sent to the daemon (as a LOG frame) tagged with that request, so the
// request log can show its own lines like `wrangler tail`.

import { AsyncLocalStorage } from "node:async_hooks"
import { formatWithOptions } from "node:util"

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug"
export type ConsoleLog = { level: ConsoleLevel; text: string; ts: number }
type Send = (requestId: string, log: ConsoleLog) => void

const LEVELS: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"]

// Module-level so a second install doesn't wrap console twice; it only swaps
// the sender.
let state: { als: AsyncLocalStorage<string>; send: Send; runner: { run<T>(requestId: string, fn: () => T): T } } | null = null

export const installConsoleCapture = (send: Send): { run<T>(requestId: string, fn: () => T): T } => {
  if (state) {
    state.send = send
    return state.runner
  }
  const als = new AsyncLocalStorage<string>()
  const runner = { run: <T>(requestId: string, fn: () => T): T => als.run(requestId, fn) }
  state = { als, send, runner }
  const s = state
  // Guards against a sender that itself logs, which would loop forever.
  let sending = false

  for (const level of LEVELS) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      const requestId = s.als.getStore()
      if (requestId === undefined || sending) return
      sending = true
      try {
        s.send(requestId, { level, text: formatWithOptions({ colors: false }, ...args), ts: Date.now() })
      } catch {
        // A broken channel must never break the function's own logging.
      } finally {
        sending = false
      }
    }
  }
  return runner
}
