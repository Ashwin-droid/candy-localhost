// What a process candy launched can do as its site: publish and receive
// events, ask for server-to-server tokens and check the ones it is sent.
// Used by sdk.ts (servers) and fn-host.ts (functions, as env.CANDY).
//
// The daemon hands every launch a runtime record: a credential file in a
// sandboxed unit ($CREDENTIALS_DIRECTORY/candy-runtime), else the CANDY_RUNTIME
// env var. Its token names the site to the daemon; it is not an API key.
import { readFileSync } from "node:fs"
import { parseKeyRing, type JweKey } from "./jwe.ts"
import { openServiceToken, SERVICE_HEADER, type ServiceCaller } from "./service-auth.ts"
import type { CandyEvent, SubClient } from "./events.ts"

export type { CandyEvent, EventSender, SubClient, SubRequest } from "./events.ts"
export type { ServiceCaller } from "./service-auth.ts"
export { SERVICE_HEADER } from "./service-auth.ts"

export const RUNTIME_CREDENTIAL = "candy-runtime"
export const RUNTIME_ENV = "CANDY_RUNTIME"
export const RUNTIME_HEADER = "X-Candy-Runtime"

export interface RuntimeRecord {
  token: string
  site: string
  // The daemon, e.g. http://localhost:9999
  url: string
  // The site's service key ring (candy.json "service": true), jwe.ts formatKeyRing
  serviceKeys?: string
  // The event this run was started for (a function's event run)
  event?: CandyEvent
}

/** The record candy gave this process, or null outside candy. */
export const readRuntime = (env: Record<string, string | undefined> = process.env): RuntimeRecord | null => {
  let raw: string | undefined
  const dir = env.CREDENTIALS_DIRECTORY
  if (dir) {
    try { raw = readFileSync(`${dir.replace(/\/+$/, "")}/${RUNTIME_CREDENTIAL}`, "utf8") } catch {}
  }
  raw ??= env[RUNTIME_ENV]
  if (!raw) return null
  try {
    const r = JSON.parse(raw) as RuntimeRecord
    return typeof r?.token === "string" && typeof r.site === "string" && typeof r.url === "string" ? r : null
  } catch {
    return null
  }
}

export interface Subscription { close(): void }
/** `to`: only these approved apps get it. A "strict" event only; on any other the publish is refused. */
export interface PublishOptions { to?: string | string[] }
/** Where one "sub" entry stands: "ok", "denied" (the publisher doesn't allow this site's user), "pending", "rejected" or "revoked" */
export interface SubscriptionStatus { subscription: string; site: string; event: string; status: "ok" | "denied" | "pending" | "rejected" | "revoked" }
export interface SubscribeOptions {
  onError?: (e: Error) => void
  /** Called on every (re)connect with where each subscription stands. Throw or exit here if a denial is fatal to you. */
  onStatus?: (subscriptions: SubscriptionStatus[]) => void
}

/** What is in force after a reload: the tagged cron jobs and, for a function, its handlers and URL */
export interface ReloadedConfig {
  cron: { tag: string; schedule: string }[]
  handlers?: string[] | null
  url?: string | null
  warnings: string[]
}

export interface CandyRuntime {
  /** This site's name */
  site: string
  /** Publish one of the events this site's candy.json lists in "pub". Stopped subscribers are started. */
  /** `to`: only these subscribers get it (without it: everyone who may); refused if one of them can't. */
  publish(event: string, data?: unknown, opts?: PublishOptions): Promise<{ id: string; delivered: string[] }>
  /** Every event this site's candy.json "sub" lists, for as long as the process lives. Up to 8 at once, except that an "ordered" event waits for the one before it to be handled. */
  subscribe(handler: (event: CandyEvent) => unknown, opts?: SubscribeOptions): Subscription
  /** Where each of this site's subscriptions stands with its publisher */
  subscriptions(): Promise<SubscriptionStatus[]>
  /** Have candy read this site's candy.json again now (after editing it). Throws with the reason when the file can't be used. */
  reloadConfig(): Promise<ReloadedConfig>
  /** For this site's "strict" events: each app asking, per event, with `status` "pending", "approved", "rejected" or "revoked" */
  listSubClients(): Promise<SubClient[]>
  /** Let `app` have `event` from now on. Without `event`: every strict event it asks for. */
  approveSubClient(app: string, event?: string): Promise<SubClient[]>
  /** Turn down an app that is waiting */
  rejectSubClient(app: string, event?: string): Promise<SubClient[]>
  /** Take an approval back: the app gets no more of that event */
  revokeSubClient(app: string, event?: string): Promise<SubClient[]>
  /** A token that tells `target` which app (and unix user) is calling. Cached until shortly before it expires. */
  serviceToken(target: string): Promise<string>
  /** `{ "Candy-Service-Token": <token> }` for a request to `target` */
  serviceHeaders(target: string): Promise<Record<string, string>>
  /** Who a request (or a bare token) is from, or null. Needs "service": true in this site's candy.json. */
  verifyService(from: Request | Headers | string | null | undefined): Promise<ServiceCaller | null>
}

const noRuntime = (): never => {
  throw new Error("This process was not started by candy (no runtime record), so it has no site to act as.")
}

export const createRuntime = (record: RuntimeRecord | null, fetcher: typeof fetch = fetch): CandyRuntime => {
  let ring: JweKey[] | null = null
  const call = async <T>(path: string, body: unknown): Promise<T> => {
    const r = record ?? noRuntime()
    const res = await fetcher(`${r.url}${path}`, { method: "POST", headers: { [RUNTIME_HEADER]: r.token, "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const answer = await res.json().catch(() => null) as (T & { error?: string }) | null
    if (!res.ok) throw new Error(answer?.error ?? `candy answered ${res.status}`)
    return answer as T
  }
  const tokens = new Map<string, { token: string; expiresAt: number }>()

  return {
    get site() { return (record ?? noRuntime()).site },
    publish: (event, data, opts) => call("/runtime/publish", { event, data: data ?? null, ...(opts?.to !== undefined ? { to: opts.to } : {}) }),
    subscribe(handler, opts = {}) {
      const r = record ?? noRuntime()
      const stop = new AbortController()
      const fail = (e: unknown) => { try { opts.onError?.(e instanceof Error ? e : new Error(String(e))) } catch {} }
      ;(async () => {
        let wait = 500
        while (!stop.signal.aborted) {
          try {
            const res = await fetcher(`${r.url}/runtime/events?ack=1&parallel=1`, { headers: { [RUNTIME_HEADER]: r.token }, signal: stop.signal })
            if (!res.ok || !res.body) {
              const answer = await res.json().catch(() => null) as { error?: string } | null
              throw new Error(answer?.error ?? `candy answered ${res.status}`)
            }
            wait = 500
            const decoder = new TextDecoder()
            let partial = ""
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n")
              partial = lines.pop() ?? ""
              for (const line of lines) {
                if (!line.trim()) continue   // keep-alive
                let ev: CandyEvent & { candy?: string; subscriptions?: SubscriptionStatus[] }
                try { ev = JSON.parse(line) } catch { continue }
                if (ev.candy === "subscriptions") {
                  opts.onStatus?.(ev.subscriptions ?? [])
                  continue
                }
                // The answer is what takes the event off candy's queue; a throw brings it back later.
                // Not awaited: candy holds back an "ordered" event until the one before it is answered,
                // so anything that arrives meanwhile may run alongside.
                const got = ev
                void (async () => {
                  let problem: string | null = null
                  try { await handler(got) } catch (e) { fail(e); problem = e instanceof Error ? e.message : String(e) }
                  call("/runtime/ack", { id: got.id, ok: problem === null, ...(problem === null ? {} : { error: problem }) }).catch(fail)
                })()
              }
            }
          } catch (e) {
            if (stop.signal.aborted) return
            fail(e)
          }
          await new Promise(done => setTimeout(done, wait))
          wait = Math.min(wait * 2, 10_000)
        }
      })()
      return { close: () => stop.abort() }
    },
    reloadConfig: () => call<ReloadedConfig>("/runtime/reload-config", {}),
    subscriptions: async () => (await call<{ subscriptions: SubscriptionStatus[] }>("/runtime/subscriptions", {})).subscriptions,
    listSubClients: async () => (await call<{ clients: SubClient[] }>("/runtime/sub-clients", { action: "list" })).clients,
    approveSubClient: async (app, event) => (await call<{ clients: SubClient[] }>("/runtime/sub-clients", { action: "approve", app, event })).clients,
    rejectSubClient: async (app, event) => (await call<{ clients: SubClient[] }>("/runtime/sub-clients", { action: "reject", app, event })).clients,
    revokeSubClient: async (app, event) => (await call<{ clients: SubClient[] }>("/runtime/sub-clients", { action: "revoke", app, event })).clients,
    async serviceToken(target) {
      const hit = tokens.get(target)
      if (hit && hit.expiresAt - Date.now() > 30_000) return hit.token
      const fresh = await call<{ token: string; expiresAt: number }>("/runtime/service-token", { target })
      tokens.set(target, fresh)
      return fresh.token
    },
    async serviceHeaders(target) {
      return { [SERVICE_HEADER]: await this.serviceToken(target) }
    },
    async verifyService(from) {
      const r = record ?? noRuntime()
      if (!r.serviceKeys) throw new Error(`candy service auth is off for ${r.site}: set "service": true in its candy.json and restart it.`)
      const token = typeof from === "string" ? from : (from instanceof Request ? from.headers : from)?.get(SERVICE_HEADER)
      if (!token) return null
      try {
        ring ??= parseKeyRing(r.serviceKeys)
        return await openServiceToken(token.trim(), ring, { site: r.site })
      } catch {
        return null
      }
    },
  }
}
