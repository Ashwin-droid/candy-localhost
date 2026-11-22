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
import type { CandyEvent } from "./events.ts"

export type { CandyEvent } from "./events.ts"
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
export interface SubscribeOptions { onError?: (e: Error) => void }

export interface CandyRuntime {
  /** This site's name */
  site: string
  /** Publish one of the events this site's candy.json lists. Stopped subscribers are started. */
  publish(event: string, data?: unknown): Promise<{ id: string; delivered: string[] }>
  /** Every event this site's candy.json subscribes to, one at a time, for as long as the process lives. */
  subscribe(handler: (event: CandyEvent) => unknown, opts?: SubscribeOptions): Subscription
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
    publish: (event, data) => call("/runtime/publish", { event, data: data ?? null }),
    subscribe(handler, opts = {}) {
      const r = record ?? noRuntime()
      const stop = new AbortController()
      const fail = (e: unknown) => { try { opts.onError?.(e instanceof Error ? e : new Error(String(e))) } catch {} }
      ;(async () => {
        let wait = 500
        while (!stop.signal.aborted) {
          try {
            const res = await fetcher(`${r.url}/runtime/events`, { headers: { [RUNTIME_HEADER]: r.token }, signal: stop.signal })
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
                let ev: CandyEvent
                try { ev = JSON.parse(line) } catch { continue }
                try { await handler(ev) } catch (e) { fail(e) }
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
