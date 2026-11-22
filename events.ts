// candy pub/sub: the pure parts. A site lists the events it may publish
// ("pub") and the ones it wants ("sub": ["site:event"]) in its
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

// ---- who may subscribe: decided per event, in the publisher's candy.json ----
//   "pub": [{ "event": "built", "auth": "strict", "auth-users": ["bob"] }, "announce"]
//   "none"    any site candy runs
//   "lax"     sites running as the publisher's own user or one in "auth-users" (the default, with no extra users)
//   "strict"  the same users, and the publisher approved that app for that event (approveSubClient)
export type PubAuth = "none" | "lax" | "strict"
export const PUB_AUTH: readonly PubAuth[] = ["none", "lax", "strict"]
export const MAX_AUTH_USERS = 32
export interface PubEvent { event: string; auth: PubAuth; users: string[] }

export type SubDecision = "approved" | "rejected" | "revoked"
// "user": runs as someone the publisher doesn't allow. "pending": allowed user, waiting for approveSubClient.
export type SubAccess = "ok" | "user" | "pending" | "rejected" | "revoked"

/** May a site run by `subUser` get this event of a site run by `owner`? `decision` is what the publisher said about that app for this event, if anything. */
export const subAccess = (rules: Pick<PubEvent, "auth" | "users">, owner: string, subUser: string, decision: SubDecision | null): SubAccess => {
  if (rules.auth === "none") return "ok"
  if (subUser !== owner && !rules.users.includes(subUser)) return "user"
  if (rules.auth === "lax") return "ok"
  return decision === "approved" ? "ok" : decision ?? "pending"
}

export interface SubClient { app: string; user: string; event: string; status: "pending" | SubDecision; decidedAt: number | null }
interface StoredDecision { user: string; status: SubDecision; at: number }
const decisionKey = (event: string, app: string) => `${event} ${app}`   // neither name can hold a space

/** What publishers decided, event by event, about the apps that asked. A decision is for an app as run by one user: the name in other hands starts over. */
export class SubClientStore {
  private byPub = new Map<string, Map<string, StoredDecision>>()
  constructor(data?: unknown, private now: () => number = Date.now) {
    if (typeof data !== "object" || data === null) return
    for (const [pub, apps] of Object.entries(data as Record<string, unknown>)) {
      if (typeof apps !== "object" || apps === null) continue
      for (const [key, d] of Object.entries(apps as Record<string, Partial<StoredDecision>>)) {
        if (key.split(" ").length !== 2) continue
        if (typeof d?.user !== "string" || typeof d.at !== "number" || !["approved", "rejected", "revoked"].includes(d.status as string)) continue
        this.apps(pub).set(key, { user: d.user, status: d.status as SubDecision, at: d.at })
      }
    }
  }
  private apps(pub: string): Map<string, StoredDecision> {
    let m = this.byPub.get(pub)
    if (!m) this.byPub.set(pub, m = new Map())
    return m
  }
  private get(pub: string, event: string, app: string, user: string): StoredDecision | null {
    const d = this.byPub.get(pub)?.get(decisionKey(event, app))
    return d && d.user === user ? d : null
  }
  decision(pub: string, event: string, app: string, user: string): SubDecision | null { return this.get(pub, event, app, user)?.status ?? null }
  decidedAt(pub: string, event: string, app: string, user: string): number | null { return this.get(pub, event, app, user)?.at ?? null }
  set(pub: string, event: string, app: string, user: string, status: SubDecision): void {
    this.apps(pub).set(decisionKey(event, app), { user, status, at: this.now() })
  }
  /** Every decision of `pub`, also about apps that no longer ask: an approval can still be revoked */
  decided(pub: string): { event: string; app: string; user: string; status: SubDecision; at: number }[] {
    return [...(this.byPub.get(pub) ?? [])].map(([key, d]) => ({ event: key.split(" ")[0], app: key.split(" ")[1], ...d }))
  }
  /** A name is gone: what it decided as a publisher, and what was decided about it */
  dropSite(name: string): void {
    this.byPub.delete(name)
    for (const m of this.byPub.values()) for (const key of [...m.keys()]) if (key.split(" ")[1] === name) m.delete(key)
  }
  toJSON(): Record<string, Record<string, StoredDecision>> {
    const out: Record<string, Record<string, StoredDecision>> = {}
    for (const [pub, m] of this.byPub) if (m.size) out[pub] = Object.fromEntries(m)
    return out
  }
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
