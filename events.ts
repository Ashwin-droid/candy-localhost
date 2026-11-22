// candy pub/sub: the pure parts. A site lists the events it may publish
// ("events") and the ones it wants ("subscribe": ["site:event"]) in its
// candy.json; the daemon carries them (daemon.ts, "events").

export const EVENT_NAME = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/
export const MAX_EVENTS = 32
export const MAX_SUBSCRIBE = 32
// The JSON of one event's data
export const MAX_EVENT_BYTES = 64 * 1024
// Events waiting for a subscriber that isn't connected (it is being started)
export const MAX_QUEUED = 1000
export const QUEUE_TTL_MS = 10 * 60 * 1000
// A function that fails an event gets it again after each of these, then it is dropped
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [1000, 5000]

export interface CandyEvent {
  id: string
  // The site that published it
  from: string
  event: string
  data: unknown
  // ms since the epoch, at publish
  time: number
}

export const subscriptionKey = (site: string, event: string): string => `${site}:${event}`

/** "site:event" -> its parts, or null. The site part is checked by the caller (manifest.ts). */
export const parseSubscription = (s: string): { site: string; event: string } | null => {
  const at = s.indexOf(":")
  if (at <= 0) return null
  const site = s.slice(0, at)
  const event = s.slice(at + 1)
  return EVENT_NAME.test(event) ? { site, event } : null
}

/** Why `data` can't be published, or null. Returns the JSON too, so it is made once. */
export const eventData = (data: unknown): { json: string } | { error: string } => {
  let json: string | undefined
  try { json = JSON.stringify(data ?? null) } catch { /* cycles, BigInt */ }
  if (json === undefined) return { error: "event data must be JSON" }
  if (new TextEncoder().encode(json).length > MAX_EVENT_BYTES) return { error: `event data is larger than ${MAX_EVENT_BYTES / 1024} KB` }
  return { json }
}

/** Events held per subscriber until it connects: bounded, and old ones are dropped. */
export class EventQueue {
  private bySub = new Map<string, CandyEvent[]>()
  constructor(private now: () => number = Date.now, private max = MAX_QUEUED, private ttlMs = QUEUE_TTL_MS) {}

  /** Returns how many old events were pushed out to make room. */
  push(sub: string, ev: CandyEvent): number {
    const q = this.fresh(sub)
    q.push(ev)
    const over = Math.max(0, q.length - this.max)
    if (over) q.splice(0, over)
    this.bySub.set(sub, q)
    return over
  }
  /** Everything waiting for `sub`, oldest first; the queue is emptied. */
  take(sub: string): CandyEvent[] {
    const q = this.fresh(sub)
    this.bySub.delete(sub)
    return q
  }
  pending(sub: string): number { return this.fresh(sub).length }
  drop(sub: string): void { this.bySub.delete(sub) }

  private fresh(sub: string): CandyEvent[] {
    const cutoff = this.now() - this.ttlMs
    const q = (this.bySub.get(sub) ?? []).filter(e => e.time >= cutoff)
    if (q.length) this.bySub.set(sub, q)
    else this.bySub.delete(sub)
    return q
  }
}
