// candy pub/sub: the pure parts. A site lists the events it may publish
// ("pub") and the ones it wants ("sub": ["site:event"]) in its
// candy.json; the daemon carries them (daemon.ts, "events").

export const EVENT_NAME = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/
export const MAX_EVENTS = 32
export const MAX_SUBSCRIBE = 32
// The JSON of one event's data
export const MAX_EVENT_BYTES = 64 * 1024
// Events waiting for one subscriber (not connected, busy, or between tries). Kept on disk.
export const MAX_QUEUED = 1000
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000
// A subscriber that fails an event gets it again after each of these, then it is dropped
export const EVENT_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 30_000, 2 * 60_000, 10 * 60_000]
// A server that takes an event has this long to say how it went
export const EVENT_ACK_TIMEOUT_MS = 60_000

// The site an event came from, as candy knows it: for the receiver to judge by
export interface EventSender { name: string; user: string; kind: "server" | "function"; url: string | null }

export interface CandyEvent {
  id: string
  // The site that published it
  from: string
  // That site in full. On every event an app published; not on candy's own.
  sender?: EventSender
  event: string
  data: unknown
  // ms since the epoch, at publish
  time: number
}

export const subscriptionKey = (site: string, event: string): string => `${site}:${event}`

// Inbound events: the receiver takes one event name from any site ("sub": ["*::reply"]), and a
// sender binds an entry of its "pub" to that receiver ({ "event": "wa:reply", "bind": "wa" }).
// A publish of it goes to that one site and nowhere else, so there is no "auth" on it: the
// receiver sees who sent it (event.sender) and decides.
export const ANY_SITE = "*"
export const inboundKey = (event: string): string => `${ANY_SITE}::${event}`
/** The name the receiver sees for a bound "pub" entry: "wa:reply" bound to "wa" is "reply" */
export const boundEventName = (rule: { event: string; bind: string }): string => rule.event.slice(rule.bind.length + 1)

// A subscriber may turn an "ordered" event back into a plain one for itself: "wa:message:unordered".
// It can only give order up, never ask for it: "ordered" is the publisher's call, on its "pub" entry.
export const UNORDERED = "unordered"

/**
 * "site:event" or "*::event", either one optionally ending in ":unordered", -> its parts, or null.
 * The site part is checked by the caller (manifest.ts). Event names have no ":", so an event called
 * "unordered" ("ci:unordered") is still just that event.
 */
export const parseSubscription = (s: string): { site: string; event: string; unordered?: true } | null => {
  const plain = parsePlainSubscription(s)
  if (plain || !s.endsWith(`:${UNORDERED}`)) return plain
  const base = parsePlainSubscription(s.slice(0, -(UNORDERED.length + 1)))
  return base ? { ...base, unordered: true } : null
}

const parsePlainSubscription = (s: string): { site: string; event: string } | null => {
  if (s.startsWith(ANY_SITE)) {
    const event = s.slice(ANY_SITE.length + 2)
    return s === inboundKey(event) && EVENT_NAME.test(event) ? { site: ANY_SITE, event } : null
  }
  const at = s.indexOf(":")
  if (at <= 0) return null
  const site = s.slice(0, at)
  const event = s.slice(at + 1)
  return EVENT_NAME.test(event) ? { site, event } : null
}

// Events the daemon itself publishes, as the site "candy" (a reserved name, so never a real one).
// Getting one is a choice: a site lists it in "sub" like any other, e.g. "candy:sub-request".
//   sub-request   an app is waiting for this site's approval of one of its "strict" events;
//                 data is { app, user, event }. Once per app and event while it waits.
export const BUILTIN_SITE = "candy"
export const SUB_REQUEST_EVENT = "sub-request"
export const BUILTIN_EVENTS: readonly string[] = [SUB_REQUEST_EVENT]
export interface SubRequest { app: string; user: string; event: string }

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
// A publish goes to everyone who may get the event, or with `to` only to the apps it names.
export type PubAuth = "none" | "lax" | "strict"
export const PUB_AUTH: readonly PubAuth[] = ["none", "lax", "strict"]
// Apps one publish may name
export const MAX_PUBLISH_TO = 32

/**
 * Why a publish of `rules`' event can't name recipients, or null. Picking recipients goes with knowing
 * them: only a "strict" event has a list of approved apps (listSubClients, candy:sub-request); a "none"
 * or "lax" event is a broadcast, and a bound one has its one receiver already.
 */
export const publishToProblem = (rules: Pick<PubEvent, "event" | "auth" | "bind">): string | null => {
  if (rules.bind) return `"${rules.event}" is bound to ${rules.bind}: it takes no "to".`
  if (rules.auth !== "strict") return `"to" only works on a "strict" event, and "${rules.event}" is "${rules.auth}": it goes to everyone who may get it. Make it "strict" in "pub" to send to chosen apps.`
  return null
}

/** `to` of a publish as a list of names (lower case, no repeats), null when it wasn't given, or why it can't be used */
export const publishTargets = (to: unknown): string[] | null | { error: string } => {
  if (to === undefined || to === null) return null
  const list = typeof to === "string" ? [to] : to
  if (!Array.isArray(list) || list.length === 0 || list.some(t => typeof t !== "string" || !t.trim())) return { error: '"to" must be an app name or a list of them' }
  if (list.length > MAX_PUBLISH_TO) return { error: `"to" takes at most ${MAX_PUBLISH_TO} apps` }
  return [...new Set((list as string[]).map(t => t.trim().toLowerCase()))]
}
export const MAX_AUTH_USERS = 32
// ordered: each subscriber handles this event one at a time, in the order published
// bind: the one site this entry goes to (the event is then "<bind>:<name>", and auth is "none")
export interface PubEvent { event: string; auth: PubAuth; users: string[]; ordered?: true; bind?: string }

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

export interface Queued {
  ev: CandyEvent
  // Where it stands in its subscriber's queue (and in its file name: the order survives a restart)
  seq: number
  // Failed tries so far
  attempts: number
  // Not handed out before this (a retry waiting)
  notBefore: number
  inflight: boolean
}

/**
 * Events waiting for each subscriber, oldest first, until it says it handled them.
 * An event is handed out (take), then done or failed; a failed one waits and is
 * handed out again, up to `retryDelays.length` more times. Bounded and aged out.
 * This is the bookkeeping only: the daemon keeps the files and does the handing out.
 */
export class EventQueue {
  private bySub = new Map<string, Queued[]>()
  private seq = 0
  constructor(private now: () => number = Date.now, private max = MAX_QUEUED, private ttlMs = QUEUE_TTL_MS, private retryDelays: readonly number[] = EVENT_RETRY_DELAYS_MS) {}

  /** Number new events from here up (the daemon passes the clock, so they sort after anything an earlier run left on disk) */
  startAt(seq: number): void { this.seq = Math.max(this.seq, seq) }
  private list(sub: string): Queued[] { return this.bySub.get(sub) ?? [] }
  private remove(sub: string, item: Queued): void {
    const q = this.list(sub).filter(i => i !== item)
    if (q.length) this.bySub.set(sub, q)
    else this.bySub.delete(sub)
  }

  /** Adds an event (`seq` given: one read back from disk). `dropped`: the oldest ones not being handled, pushed out to make room. */
  push(sub: string, ev: CandyEvent, seq?: number): { item: Queued; dropped: Queued[] } {
    if (seq !== undefined) this.seq = Math.max(this.seq, seq)
    const item: Queued = { ev, seq: seq ?? ++this.seq, attempts: 0, notBefore: 0, inflight: false }
    const q = [...this.list(sub), item].sort((a, b) => a.seq - b.seq)
    const dropped: Queued[] = []
    while (q.length > this.max) {
      const at = q.findIndex(i => !i.inflight && i !== item)
      if (at < 0) break
      dropped.push(...q.splice(at, 1))
    }
    this.bySub.set(sub, q)
    return { item, dropped }
  }

  /** Removes and returns what has waited longer than the queue keeps events (never one being handled) */
  expire(sub: string): Queued[] {
    const cutoff = this.now() - this.ttlMs
    const old = this.list(sub).filter(i => !i.inflight && i.ev.time < cutoff)
    for (const i of old) this.remove(sub, i)
    return old
  }

  /**
   * Up to `limit` events to hand out now, oldest first, marked as being handled.
   * An `ordered` event waits for every earlier one of the same publisher and name:
   * one at a time, and a failed one holds the later ones back until it is through.
   */
  take(sub: string, limit: number, ordered: (ev: CandyEvent) => boolean = () => false): Queued[] {
    const out: Queued[] = []
    const held = new Set<string>()
    const now = this.now()
    for (const item of this.list(sub)) {
      if (out.length >= limit) break
      const key = subscriptionKey(item.ev.from, item.ev.event)
      const inOrder = ordered(item.ev)
      if (item.inflight || item.notBefore > now || (inOrder && held.has(key))) {
        held.add(key)
        continue
      }
      held.add(key)
      item.inflight = true
      out.push(item)
    }
    return out
  }

  private find(sub: string, id: string): Queued | null { return this.list(sub).find(i => i.ev.id === id) ?? null }
  /** Handled: it leaves the queue. Null when it isn't there (already done, dropped, or never was). */
  done(sub: string, id: string): Queued | null {
    const item = this.find(sub, id)
    if (item) this.remove(sub, item)
    return item
  }
  /** A try failed: it waits for the next one (`retryAt`), or it was the last and the event is gone (`dropped`). */
  fail(sub: string, id: string): { item: Queued; retryAt: number } | { item: Queued; dropped: true } | null {
    const item = this.find(sub, id)
    if (!item || !item.inflight) return null
    item.inflight = false
    const delay = this.retryDelays[item.attempts]
    item.attempts++
    if (delay === undefined) {
      this.remove(sub, item)
      return { item, dropped: true }
    }
    item.notBefore = this.now() + delay
    return { item, retryAt: item.notBefore }
  }
  /** Whoever was handling these is gone without an answer: they are handed out again, and it isn't counted as a failure */
  release(sub: string, id?: string): void {
    for (const item of this.list(sub)) if (id === undefined || item.ev.id === id) item.inflight = false
  }

  pending(sub: string): number { return this.list(sub).length }
  inflight(sub: string): number { return this.list(sub).filter(i => i.inflight).length }
  /** When the next retry of `sub` is due, or null */
  nextWake(sub: string): number | null {
    const times = this.list(sub).filter(i => !i.inflight && i.notBefore > this.now()).map(i => i.notBefore)
    return times.length ? Math.min(...times) : null
  }
  subscribers(): string[] { return [...this.bySub.keys()] }
  /** Forgets a subscriber; returns what it still had */
  drop(sub: string): Queued[] {
    const q = this.list(sub)
    this.bySub.delete(sub)
    return q
  }
}
