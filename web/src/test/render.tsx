// Shared test helpers (SPEC §8 A). No DOM: renderToStaticMarkup with a fixed route, a session, primed resources
// and a fake API client. Not type-checked by `bun run check` (§1.3).

import type React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { type Api, setApiForTest } from "../api/client.ts"
import { primeResource, resetResources } from "../api/resources.ts"
import type { BootResponse } from "../api/types.ts"
import { MemoryRoute } from "../router.tsx"
import { type Session, SessionContext } from "../session.tsx"

export const TEST_SESSION: Session = {
  user: "ashwin", superuser: false, multiUser: false, owner: "ashwin", amr: "pam", candyHost: null, pamUntil: null,
  tld: "candy", buildStale: false, setPamUntil: () => {}, refreshMe: async () => {},
}

/** An Api whose every call rejects, so a render that would fetch can't reach anything real. */
export function nullApi(): Api {
  const fail = () => Promise.reject(new Error("no API in this test"))
  return { get: fail, post: fail, del: fail, stream: fail, boot: fail as () => Promise<BootResponse> }
}

export function renderWith(el: React.ReactElement, o?: { session?: Partial<Session>; route?: string; state?: unknown;
  resources?: Record<string, unknown>; api?: Api }): string {
  resetResources()
  for (const [k, v] of Object.entries(o?.resources ?? {})) primeResource(k, v)
  setApiForTest(o?.api ?? nullApi())
  const session = { ...TEST_SESSION, ...o?.session }
  return renderToStaticMarkup(
    <SessionContext.Provider value={session}>
      <MemoryRoute path={o?.route ?? "/"} state={o?.state}>{el}</MemoryRoute>
    </SessionContext.Provider>,
  )
}

export type FakeFetch = typeof fetch & { calls: Request[] }

/**
 * A fetch that answers from handlers keyed "METHOD /path" or "/path" (any method), matched on the pathname.
 * Anything else is a 404 {"error":"not found"}. Every request is recorded in `.calls` (with its body readable).
 */
export function fakeFetch(handlers: Record<string, (req: Request) => Response | Promise<Response>>): typeof fetch {
  const calls: Request[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(new URL(String(input instanceof Request ? input.url : input), "https://portal.localhost"), init)
    calls.push(req.clone())
    const path = new URL(req.url).pathname
    const h = handlers[`${req.method} ${path}`] ?? handlers[path]
    if (!h) return Response.json({ error: "not found" }, { status: 404 })
    return h(req)
  }) as FakeFetch
  f.calls = calls
  return f
}

export function fakeStorage(init?: Record<string, string>): Storage {
  const m = new Map<string, string>(Object.entries(init ?? {}))
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  }
}

/** A location stand-in for createApi; `assigned` collects every assign/replace. */
export function fakeLocation(path = "/sites/api?x=1#h") {
  const u = new URL(path, "https://portal.localhost")
  const assigned: string[] = []
  return {
    origin: u.origin, pathname: u.pathname, search: u.search, hash: u.hash, assigned,
    assign(x: string) { assigned.push(x) }, replace(x: string) { assigned.push(x) },
  }
}

export const BOOT: BootResponse = {
  token: "t0", user: "ashwin", superuser: false, multiUser: false, owner: "ashwin", amr: "pam", candyHost: null,
  pamUntil: null, tld: "candy", buildStale: false,
}
