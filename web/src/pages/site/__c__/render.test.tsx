// Package C render tests (renderToStaticMarkup through renderWith: no DOM). SPEC §9.1.

import { describe, expect, test } from "bun:test"
import type { DeploysResponse, RequestDetail, RequestSummary, TrafficResponse } from "../../../api/types.ts"
import { KEYS } from "../../../api/sites.ts"
import { collectSites, type Site } from "../../../lib/site.ts"
import { config, fnSummary, proc, route } from "../../../test/fixtures.ts"
import { renderWith } from "../../../test/render.tsx"
import DataTab, { d1Ident, pickStore, storesOf } from "../DataTab.tsx"
import DeploymentsTab from "../DeploymentsTab.tsx"
import LogsTab from "../LogsTab.tsx"
import { BodyBlock, ConsoleBlock } from "../RequestDetail.tsx"
import RequestsTab from "../RequestsTab.tsx"

const HOSTILE = `<img src=x onerror=alert(1)>`
const ESCAPED = "&lt;img src=x onerror=alert(1)&gt;"

const fnSite: Site = collectSites({ configs: { success: true, configs: { api: config({ fn: fnSummary() }) } } })[0]
const serverSite = (o: Parameters<typeof proc>[0] | null): Site => collectSites({
  configs: { success: true, configs: { web: config() } },
  processes: o === null ? undefined : { success: true, processes: { web: proc(o) } },
  routes: { web: route(3000) },
})[0]

const req = (o: Partial<RequestSummary> = {}): RequestSummary => ({
  id: "r1", ts: Date.UTC(2026, 10, 21, 14, 2, 9), fn: "api", host: "api.candy", method: "GET", url: "/api/users", path: "/api/users",
  clientIp: "127.0.0.1", status: 200, outcome: "ok", cold: false, instance: "i1", queuedMs: 1, ttfbMs: 4, totalMs: 12,
  reqBytes: 0, resBytes: 120, kind: "worker", rule: null, ...o,
})
const listKey = (status = "", path = "") => `fn/requests:api?status=${status}&path=${path}`

describe("Requests (functions)", () => {
  test("rows render escaped, link to their detail and keep the filters in the link", () => {
    const html = renderWith(<RequestsTab site={fnSite} />, {
      route: "/sites/api/requests?status=4xx",
      resources: { [listKey("4xx")]: { success: true, requests: [req({ id: "r9", status: 404, path: `/x/${HOSTILE}`, cold: true })] } },
    })
    expect(html).not.toContain("<img")
    expect(html).toContain(ESCAPED)
    expect(html).toContain('href="/sites/api/requests/r9?status=4xx"')
    expect(html).toContain("12 ms, cold")
    expect(html).toContain("http-dot is-4xx")
    expect(html).toContain("Pick a request to see its headers, bodies, logs and timings.")
    for (const h of ["Time", "Status", "Request", "Served by", "Duration"]) expect(html).toContain(`>${h}<`)
  })

  test("a non-ok outcome without a status shows the outcome", () => {
    const html = renderWith(<RequestsTab site={fnSite} />, {
      route: "/sites/api/requests",
      resources: { [listKey()]: { success: true, requests: [req({ status: null, outcome: "crashed" })] } },
    })
    expect(html).toContain('class="http-status is-outcome"')
    expect(html).toContain("crashed")
  })

  test("empty: with and without filters", () => {
    const none = renderWith(<RequestsTab site={fnSite} />, { route: "/sites/api/requests", resources: { [listKey()]: { success: true, requests: [] } } })
    expect(none).toContain("No requests in the last 24 hours. Open the site and they show up here as they finish.")
    const filtered = renderWith(<RequestsTab site={fnSite} />, { route: "/sites/api/requests?path=/nope", resources: { [listKey("", "/nope")]: { success: true, requests: [] } } })
    expect(filtered).toContain("No requests match.")
  })

  test("the kind filter is applied on the client", () => {
    const html = renderWith(<RequestsTab site={fnSite} />, {
      route: "/sites/api/requests?kind=files",
      resources: { [listKey()]: { success: true, requests: [req({ id: "w", kind: "worker", path: "/code-path" }), req({ id: "f", kind: "asset", path: "/file-path" })] } },
    })
    expect(html).toContain("/file-path")
    expect(html).not.toContain("/code-path")
  })

  test("the detail: facts, console, headers and bodies, escaped", () => {
    const detail: RequestDetail = {
      ...req({ id: "r1", kind: "worker", cold: true, rule: "/api/*", outcome: "threw", status: 500 }),
      reqHeaders: [["user-agent", HOSTILE], ["x-ok", "1"]],
      resHeaders: [["content-type", "application/json"]],
      reqBody: { kind: "binary", contentType: "image/png", size: 2048, truncated: false, text: null, sha256: "0123456789abcdef9999" },
      resBody: { kind: "text", contentType: "application/json", size: 7, truncated: false, text: '{"a":1}', sha256: null },
      error: { message: `boom ${HOSTILE}`, stack: "at fetch (index.ts:3)" },
      logs: [{ level: "warn", text: HOSTILE, ts: Date.UTC(2026, 10, 21, 14, 2, 9, 123) }],
      logsTruncated: true,
    }
    const html = renderWith(<RequestsTab site={fnSite} />, {
      route: "/sites/api/requests/r1",
      resources: { [listKey()]: { success: true, requests: [req()] }, "fn/request:api:r1": detail },
    })
    expect(html).not.toContain("<img")
    expect(html).toContain(ESCAPED)
    expect(html).toContain("Back to requests")
    expect(html).toContain("Replay")
    expect(html).toContain("cold (new instance)")
    expect(html).toContain("the code")
    expect(html).toContain("/api/*")
    expect(html).toContain("Binary body, stored as size and hash only. sha256 0123456789abcdef…")
    expect(html).toContain("{\n  &quot;a&quot;: 1\n}")
    expect(html).toContain("req-console-line is-warn")
    expect(html).toContain("(truncated)")
    expect(html).toContain("at fetch (index.ts:3)")
    expect(html).toContain("Outcome")
    expect(html).not.toContain("undefined")
    expect(html).toContain('aria-selected="true"')
  })

  test("an asset request is served by the daemon and has no instance or start", () => {
    const detail: RequestDetail = {
      ...req({ id: "a1", kind: "asset", instance: "" }),
      reqHeaders: [], resHeaders: [],
      reqBody: { kind: "none", contentType: null, size: 0, truncated: false, text: null, sha256: null },
      resBody: { kind: "omitted", contentType: null, size: 10, truncated: false, text: null, sha256: null },
      error: null, logs: [], logsTruncated: false,
    }
    const html = renderWith(<RequestsTab site={fnSite} />, {
      route: "/sites/api/requests/a1",
      resources: { [listKey()]: { success: true, requests: [] }, "fn/request:api:a1": detail },
    })
    expect(html).toContain("the daemon, from the asset folder (no process)")
    expect(html).not.toContain("cold (new instance)")
    expect(html).not.toContain(">warm<")
    expect(html).toContain("Nothing logged during this request.")
    expect(html).toContain(">None<")
    expect(html).toContain("Not recorded: the request log keeps metadata only.")
  })
})

describe("BodyBlock and ConsoleBlock", () => {
  const b = { contentType: null, size: 5, truncated: false, sha256: null }
  test("every kind renders as text", () => {
    expect(renderWith(<BodyBlock body={{ ...b, kind: "text", text: HOSTILE }} />)).toContain(ESCAPED)
    expect(renderWith(<BodyBlock body={{ ...b, kind: "binary", text: null, sha256: "ab".repeat(16) }} />)).toContain("Binary body, stored as size and hash only.")
    expect(renderWith(<BodyBlock body={{ ...b, kind: "omitted", text: null }} />)).toContain("Not recorded")
    expect(renderWith(<BodyBlock body={{ ...b, kind: "none", text: null }} />)).toContain("Empty")
  })
  test("console lines carry their level", () => {
    const html = renderWith(<ConsoleBlock logs={[{ level: "error", text: "bad", ts: 0 }, { level: "debug", text: "d", ts: 0 }]} />)
    expect(html).toContain("is-error")
    expect(html).toContain("is-debug")
    expect(html).toContain("error")
  })
})

describe("Requests (servers)", () => {
  test("the access log, newest first, escaped", () => {
    const site = serverSite({})
    const traffic: TrafficResponse = { domain: "web", count: 2, logs: [
      { time: "2026-11-21T14:00:00.000Z", method: "GET", path: "/first", status: 200, isTunnel: false },
      { time: null, method: "POST", path: `/x?${HOSTILE}`, status: "?", isTunnel: true },
    ] }
    const html = renderWith(<RequestsTab site={site} />, { route: "/sites/web/requests", resources: { [KEYS.traffic("web")]: traffic, [KEYS.stats]: { sessionStart: "", totalRequests: 7, domains: [{ name: "web", total: 7, alive: true, children: [] }] } } })
    expect(html).toContain("From candy’s access log. Bodies and timings are recorded for functions only.")
    expect(html).not.toContain("<img")
    expect(html.indexOf("/x?")).toBeLessThan(html.indexOf("/first"))
    expect(html).toContain("tunnel")
    expect(html).toContain("direct")
    expect(html).toContain("7 requests in total")
  })
  test("empty", () => {
    const html = renderWith(<RequestsTab site={serverSite({})} />, { route: "/sites/web/requests", resources: { [KEYS.traffic("web")]: { domain: "web", count: 0, logs: [] } } })
    expect(html).toContain("No requests yet.")
  })
})

describe("Deployments", () => {
  const dep = (id: string, o: Partial<DeploysResponse["deploys"][number]> = {}) => ({
    id, createdAt: Date.UTC(2026, 10, 20, 9, 30), entry: "src/index.ts", dir: "/d", source: "/home/a/api", gitRev: "1a2b3c4d5e6f",
    size: 4096, main: "src/index.ts", assets: null, ...o,
  })
  test("the current deploy is marked, the others can be rolled back", () => {
    const data: DeploysResponse = { success: true, current: "20261120-b", fn: fnSummary({ deploy: "20261120-b" }),
      deploys: [dep("20261120-b"), dep("20261119-a", { entry: null, assets: "/srv/public", gitRev: null })] }
    const html = renderWith(<DeploymentsTab site={fnSite} />, { route: "/sites/api/deployments", resources: { [KEYS.deploys("api")]: data } })
    expect(html).toContain("Current")
    expect(html).toContain("Roll back")
    expect(html).toContain("Back to dev")
    expect(html).toContain(", pinned")
    expect(html).toContain("no code")
    expect(html).toContain("1a2b3c4d · src/index.ts")
    expect(html).toContain('title="/srv/public"')
    expect(html).toContain('aria-selected="true"')
  })
  test("live from source, and the empty state offers Deploy", () => {
    const data: DeploysResponse = { success: true, current: null, fn: fnSummary(), deploys: [] }
    const html = renderWith(<DeploymentsTab site={fnSite} />, { route: "/sites/api/deployments", resources: { [KEYS.deploys("api")]: data } })
    expect(html).toContain("dev, live from the source folder")
    expect(html).not.toContain("Back to dev")
    expect(html).toContain("No deploys yet. Deploy bundles the current code into a snapshot that doesn’t change when you edit the source. The last 10 are kept for rollback.")
    expect(html).toContain(">Deploy<")
  })
})

describe("Data", () => {
  const withStores = (o: { kv?: string[] | null; d1?: string[] | null }): Site =>
    collectSites({ configs: { success: true, configs: { api: config({ fn: fnSummary(o) }) } } })[0]
  test("stores come from candy.json, and the first one is open", () => {
    const html = renderWith(<DataTab site={withStores({ kv: ["CACHE", "SESSIONS"], d1: ["MAIN"] })} />, { route: "/sites/api/data" })
    expect(html).toContain('href="/sites/api/data?kv=CACHE"')
    expect(html).toContain('href="/sites/api/data?kv=SESSIONS"')
    expect(html).toContain('href="/sites/api/data?d1=MAIN"')
    expect(html).toContain("Add key")
    expect(html).toContain('placeholder="Filter by prefix"')
    expect(html).not.toContain("List keys")
    expect(html).not.toContain("The binding is the name")
  })
  test("?d1= opens that database with its console", () => {
    const html = renderWith(<DataTab site={withStores({ kv: ["CACHE"], d1: ["MAIN"] })} />, { route: "/sites/api/data?d1=MAIN" })
    expect(html).toContain('placeholder="SELECT * FROM sqlite_master"')
    expect(html).toContain("Runs on the function&#x27;s own database, right away. Changes can&#x27;t be undone.")
    expect(html).toContain("Tables")
    expect(html).not.toContain("Add key")
  })
  test("no bindings: says what to add to candy.json", () => {
    const html = renderWith(<DataTab site={withStores({ kv: [], d1: [] })} />, { route: "/sites/api/data" })
    expect(html).toContain("api has no KV or D1 bindings.")
    expect(html).not.toContain("Add key")
  })
  test("an older daemon that reports no bindings gets the usual names", () => {
    expect(storesOf(fnSummary())).toEqual([{ kind: "kv", binding: "KV" }, { kind: "d1", binding: "DB" }])
    expect(pickStore(storesOf(fnSummary()), new URLSearchParams("d1=DB"))).toEqual({ kind: "d1", binding: "DB" })
    expect(pickStore(storesOf(fnSummary()), new URLSearchParams("d1=NOPE"))).toEqual({ kind: "kv", binding: "KV" })
    expect(d1Ident('we"ird')).toBe('"we""ird"')
  })
})

describe("Logs", () => {
  test("no process: the empty state with Start for a server", () => {
    const html = renderWith(<LogsTab site={serverSite(null)} />, { route: "/sites/web/logs" })
    expect(html).toContain("web isn’t running, so there’s no log yet.")
    expect(html).toContain(">Start<")
  })
  test("with a process: the toolbar, the pane and the input line", () => {
    const html = renderWith(<LogsTab site={serverSite({ status: "running" })} />, { route: "/sites/web/logs" })
    for (const s of ["Running", "Follow", "Find in log…", "Clear view", "Download", "Send a line to the process", "Ctrl-C", "Ctrl-D", "Raw keys"]) {
      expect(html).toContain(s)
    }
    expect(html).toContain('role="log"')
  })
  test("a crashed process can't be typed into", () => {
    const html = renderWith(<LogsTab site={serverSite({ status: "errored", exitCode: 1 })} />, { route: "/sites/web/logs" })
    expect(html).toContain("Crashed")
    expect(html).toContain("The process isn’t running, so there is nothing to type into.")
  })
})
