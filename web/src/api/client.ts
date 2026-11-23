// The API client (SPEC §7.1-7.2). Every call sends X-Candy-Session; mutations also carry the lane's page token
// and roll it with POST /token afterwards. GETs never carry or roll a token and run in parallel.
//
// Literal-path rule: call sites write the API path as a string literal, `getApi().post("/fn/deploy", { name })`,
// with names in the query or body, or appended to a literal prefix: `"/process/start/" + encodeURIComponent(name)`.
// The CLI-parity test greps web/src for these literals.
//
// Nothing here touches window, document, localStorage or location at import time: getApi() is lazy.

import type { BootResponse } from "./types.ts"
import { createLanes, type Lane as TokenLane, type TokenChain } from "./tokens.ts"

export type Lane = TokenLane
export interface CallOptions { lane?: Lane; signal?: AbortSignal; headers?: Record<string, string> }
export type Query = Record<string, string | number | boolean | null | undefined>
export interface Api {
  get<T>(path: string, query?: Query, o?: CallOptions): Promise<T>
  post<T>(path: string, body?: unknown, o?: CallOptions): Promise<T>
  del<T>(path: string, o?: CallOptions): Promise<T>
  stream(path: string, query: Query | undefined, o: { signal: AbortSignal }): Promise<Response>  // raw, for stream.ts
  boot(): Promise<BootResponse>                                                     // mints a chain, sets the main lane
}
export interface ApiDeps {
  fetch: typeof fetch
  storage: Pick<Storage, "getItem" | "removeItem">
  location: { origin: string; pathname: string; search: string; hash: string; assign(u: string): void; replace(u: string): void }
  onSuperuserLost?: () => void          // session.tsx re-reads /auth/me
  /** Clock for the re-mint limit; tests pass a fake. Default Date.now. */
  now?: () => number
}

export class ApiError extends Error {
  status: number                         // 0 = network
  data: unknown                          // parsed body
  details?: string
  forbidden: boolean                     // 403
  reauth: boolean                        // 403 {reauth:true}
  retryAfter?: number                    // seconds, from body or Retry-After
  constructor(message: string, status: number, data: unknown = {}, o: { details?: string; retryAfter?: number } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.data = data
    this.details = o.details
    this.forbidden = status === 403
    this.reauth = status === 403 && isObj(data) && data.reauth === true
    this.retryAfter = o.retryAfter
  }
}

export const NETWORK_MESSAGE = "Can't reach the candy daemon."

const SESSION_KEY = "candy_session"
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Rule 1: a same-origin absolute path, never `//host`, `/\host` or a full URL. Throws before any header is set. */
export function checkPath(path: unknown, origin: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new ApiError(`Refusing to call ${String(path)}: not a path on this origin`, -1)
  }
  let u: URL
  try { u = new URL(path, origin) } catch { throw new ApiError(`Refusing to call ${path}: not a valid path`, -1) }
  if (u.origin !== new URL(origin).origin) throw new ApiError(`Refusing to call ${path}: not on this origin`, -1)
  return path
}

/** `?a=1&b=x`, skipping undefined, null and "". */
export function queryString(q?: Query): string {
  if (!q) return ""
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue
    p.append(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ""
}

function retryAfterOf(res: Response, data: unknown): number | undefined {
  if (isObj(data) && typeof data.retryAfter === "number") return data.retryAfter
  const h = res.headers.get("Retry-After")
  const n = h === null ? NaN : Number(h)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Rule 6: JSON, or {} when the body isn't JSON. Throws ApiError when !res.ok, or success === false, or
 * `error` is a string and the body has no `id` (a /fn/request detail carries its own `error` plus `id`).
 */
export async function parse<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => "")
  let data: unknown = {}
  if (text) { try { data = JSON.parse(text) } catch { data = {} } }
  const body = isObj(data) ? data : {}
  const failed = !res.ok || body.success === false || (typeof body.error === "string" && !("id" in body))
  if (!failed) return data as T
  const details = typeof body.details === "string" ? body.details : undefined
  const msg = typeof body.error === "string" && body.error
    ? body.error + (details ? `: ${details}` : "")
    : `Request failed (${res.status})`
  throw new ApiError(msg, res.status, data, { details, retryAfter: retryAfterOf(res, data) })
}

const isLoginRequired = (res: Response) => res.status === 401 && res.headers.has("X-Candy-Login")
/** The daemon's page-token rejection (daemon.ts unauthorizedResponse). Only this 401 is retried. */
export const TOKEN_REJECTED_MESSAGE = "Invalid or expired token. Refresh required."
async function isTokenRejected(res: Response): Promise<boolean> {
  if (res.status !== 401) return false
  if (res.headers.get("X-Candy-Token") === "invalid") return true
  const body = await res.clone().json().catch(() => null) as { error?: unknown } | null
  return isObj(body) && body.error === TOKEN_REJECTED_MESSAGE
}
const never = <T>() => new Promise<T>(() => {})

export function createApi(deps: ApiDeps): Api {
  const now = deps.now ?? (() => Date.now())
  const lanes = createLanes()
  let firstBoot: Promise<BootResponse> | null = null
  let redirected = false

  /** Rule 5: forget the session and go to the login page, once. The returned promise never settles. */
  function toLogin<T>(): Promise<T> {
    if (!redirected) {
      redirected = true
      try { deps.storage.removeItem(SESSION_KEY) } catch { /* ignore */ }
      const l = deps.location
      deps.location.assign("/login?next=" + encodeURIComponent(l.pathname + l.search + l.hash))
    }
    return never<T>()
  }

  function headers(accept: string, extra?: Record<string, string>, json = false): Headers {
    const h = new Headers(extra)
    let session: string | null = null
    try { session = deps.storage.getItem(SESSION_KEY) } catch { session = null }
    if (session) h.set("X-Candy-Session", session)
    h.set("Accept", accept)
    if (json) h.set("Content-Type", "application/json")
    return h
  }

  async function send(method: string, path: string, init: { body?: unknown; token?: string | null; o?: CallOptions; accept?: string; query?: Query }): Promise<Response> {
    checkPath(path, deps.location.origin)
    const hasBody = method === "POST"
    const h = headers(init.accept ?? "application/json", init.o?.headers, hasBody)
    if (init.token) h.set("X-Candy-Token", init.token)
    try {
      return await deps.fetch(path + queryString(init.query), {
        method, headers: h, credentials: "same-origin", cache: "no-store", signal: init.o?.signal,
        body: hasBody ? JSON.stringify(init.body ?? {}) : undefined,
      })
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e
      if ((e as { name?: string })?.name === "AbortError") throw e
      throw new ApiError(NETWORK_MESSAGE, 0)
    }
  }

  async function finish<T>(res: Response): Promise<T> {
    if (isLoginRequired(res)) return toLogin<T>()
    try { return await parse<T>(res) } catch (e) {
      if (e instanceof ApiError && e.status === 403) deps.onSuperuserLost?.()
      throw e
    }
  }

  /** POST /portal/boot: a fresh chain head plus the session facts. Tokenless (it is where tokens come from). */
  async function mint(): Promise<BootResponse> {
    const res = await send("POST", "/portal/boot", { body: {} })
    if (isLoginRequired(res)) return toLogin<BootResponse>()
    return parse<BootResponse>(res)
  }

  function boot(): Promise<BootResponse> {
    if (!firstBoot) {
      firstBoot = mint().then(b => { lanes.main.token = b.token; return b })
      firstBoot.catch(() => { firstBoot = null })   // a failed boot can be tried again
    }
    return firstBoot
  }

  async function remint(chain: TokenChain): Promise<void> {
    const b = await mint()
    chain.token = b.token
  }

  async function ensureToken(chain: TokenChain): Promise<void> {
    if (chain.token) return
    if (chain.lane === "main") { await boot(); if (!chain.token) chain.token = lanes.main.token; return }
    await remint(chain)
  }

  /** POST /token {token} (tokenless, on no lane): the next link of the chain. false when it failed. */
  async function roll(chain: TokenChain): Promise<boolean> {
    if (!chain.token) return false
    try {
      const res = await send("POST", "/token", { body: { token: chain.token } })
      if (!res.ok) return false
      const data = await res.json().catch(() => null) as { token?: unknown } | null
      if (!data || typeof data.token !== "string") return false
      chain.token = data.token
      return true
    } catch { return false }
  }

  function mutate<T>(method: "POST" | "DELETE", path: string, body: unknown, o?: CallOptions): Promise<T> {
    checkPath(path, deps.location.origin)
    const chain = lanes[o?.lane ?? "main"]
    return chain.run(async () => {
      await ensureToken(chain)
      let res = await send(method, path, { body, token: chain.token, o })
      if (isLoginRequired(res)) return toLogin<T>()
      // The rejected token was never consumed (roll then fails and the lane re-mints); any other answer,
      // a handler's own 401 included, consumed it: roll on, and never send the mutation a second time
      const rolled = await roll(chain)
      if (await isTokenRejected(res)) {
        if (rolled) {
          res = await send(method, path, { body, token: chain.token, o })
        } else if (chain.mayRemint(now())) {
          await remint(chain)
          res = await send(method, path, { body, token: chain.token, o })
        } else {
          return finish<T>(res)
        }
        if (isLoginRequired(res)) return toLogin<T>()
        await roll(chain)
      }
      return finish<T>(res)
    })
  }

  return {
    async get<T>(path: string, query?: Query, o?: CallOptions): Promise<T> {
      const res = await send("GET", path, { query, o })
      return finish<T>(res)
    },
    async post<T>(path: string, body?: unknown, o?: CallOptions): Promise<T> {
      return mutate<T>("POST", path, body ?? {}, o)
    },
    async del<T>(path: string, o?: CallOptions): Promise<T> {
      return mutate<T>("DELETE", path, undefined, o)
    },
    async stream(path: string, query: Query | undefined, o: { signal: AbortSignal }): Promise<Response> {
      const res = await send("GET", path, { query, o: { signal: o.signal }, accept: "text/event-stream" })
      if (isLoginRequired(res)) return toLogin<Response>()
      return res
    },
    boot,
  }
}

let singleton: Api | null = null
let superuserLostHandler: (() => void) | null = null

/** session.tsx registers what a 403 should trigger (a re-read of /auth/me). */
export function setSuperuserLostHandler(fn: (() => void) | null): void {
  superuserLostHandler = fn
}

/** The app's client, created on first use from the browser's fetch, localStorage and location. */
export function getApi(): Api {
  if (!singleton) {
    singleton = createApi({
      fetch: window.fetch.bind(window),
      storage: localStorage,
      location: window.location,
      onSuperuserLost: () => superuserLostHandler?.(),
    })
  }
  return singleton
}

/** Tests only: replace (or reset, with null) the singleton. */
export function setApiForTest(a: Api | null): void {
  singleton = a
}
