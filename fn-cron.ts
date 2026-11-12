// Scheduled handlers and ctx.waitUntil for functions. Cron triggers from the
// project config become ordinary ServerConfig.cron jobs whose args are fixed
// by candy (`--scheduled <expr>`), so no user text ever reaches a shell.

import { type CronJob, MAX_CRON_JOBS, validateCronJob } from "./cron.ts"
import type { FnProjectConfig } from "./fn-config.ts"

const hash6 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 6)

// Throws on the first bad expression (or too many) so a broken config is
// reported instead of silently dropping a schedule.
export const cronJobsFor = (cfg: Pick<FnProjectConfig, "crons">): CronJob[] => {
  const crons = cfg.crons ?? []
  if (!Array.isArray(crons)) throw new Error("triggers.crons must be a list of cron expressions")
  if (crons.length > MAX_CRON_JOBS) {
    throw new Error(`triggers.crons has ${crons.length} entries; at most ${MAX_CRON_JOBS} are allowed`)
  }
  return crons.map((raw, i) => {
    if (typeof raw !== "string") throw new Error(`triggers.crons[${i}] must be a string`)
    const expr = raw.trim()
    const v = validateCronJob({ name: `fn-${i}-${hash6(expr)}`, schedule: expr, args: ["--scheduled", expr] })
    if (!v.ok) throw new Error(`triggers.crons[${i}] "${raw}": ${v.error}`)
    return v.job
  })
}

// Workers-style ctx. waitUntil work keeps the instance alive until it settles;
// a rejection is logged and never takes the process down.
export class ExecutionContext {
  private readonly tracked = new Set<Promise<unknown>>()
  private readonly listeners = new Set<() => void>()

  waitUntil(p: unknown): void {
    const tracked: Promise<unknown> = Promise.resolve(p).then(
      () => {},
      (err) => { console.error("waitUntil promise rejected:", err) },
    ).finally(() => {
      this.tracked.delete(tracked)
      if (this.tracked.size === 0) for (const cb of [...this.listeners]) cb()
    })
    this.tracked.add(tracked)
  }

  passThroughOnException(): void {}

  get pending(): number { return this.tracked.size }

  // Loops because settling work may call waitUntil again.
  async settled(): Promise<void> {
    while (this.tracked.size > 0) await Promise.allSettled([...this.tracked])
  }

  // Called each time the tracked set drains to empty. Not part of the Workers
  // API; idleWatcher uses it.
  onDrained(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }
}

export interface ScheduledController {
  cron: string
  scheduledTime: number
  type: "scheduled"
  noRetry(): void
}

type ScheduledHandler = { scheduled?: (c: ScheduledController, env: unknown, ctx: ExecutionContext) => unknown }

export const runScheduled = async (handler: unknown, env: unknown, cron: string, now?: Date): Promise<void> => {
  const h = handler as ScheduledHandler | null | undefined
  if (!h || typeof h.scheduled !== "function") {
    throw new Error(`cron "${cron}" fired but the function has no scheduled() handler in its default export`)
  }
  const ctx = new ExecutionContext()
  const controller: ScheduledController = {
    cron,
    scheduledTime: (now ?? new Date()).getTime(),
    type: "scheduled",
    noRetry() {},
  }
  try {
    await h.scheduled(controller, env, ctx)
  } finally {
    // Background work still finishes even if the handler threw.
    await ctx.settled()
  }
}

export interface IdleWatcher {
  // Re-check now, e.g. after a request finishes.
  check(): void
  // Allow onIdle to fire again after it already fired.
  arm(): void
  stop(): void
}

// Fires onIdle once when no requests are in flight and waitUntil work has
// settled. The check runs on a microtask so a waitUntil added in the same tick
// as the response finishing still counts.
export const idleWatcher = (ctx: ExecutionContext, getInflight: () => number, onIdle: () => void): IdleWatcher => {
  let armed = true
  let stopped = false
  let queued = false
  const evaluate = () => {
    queued = false
    if (stopped || !armed) return
    if (getInflight() === 0 && ctx.pending === 0) {
      armed = false
      onIdle()
    }
  }
  const check = () => {
    if (stopped || queued) return
    queued = true
    queueMicrotask(evaluate)
  }
  const off = ctx.onDrained(check)
  return {
    check,
    arm() { armed = true; check() },
    stop() { stopped = true; off() },
  }
}
