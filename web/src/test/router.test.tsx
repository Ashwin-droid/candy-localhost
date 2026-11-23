import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { clearHistoryState, hashId, matchPath, matchRoute, MemoryRoute, useHistoryState, useQueryParam, useRoute } from "../router.tsx"
import { APP_ROUTES, ROUTES } from "../routes.tsx"

/** The daemon's rule matching: an exact rule matches only that path; "/x/*" matches "/x/<anything>", not "/x". */
const daemonMatch = (rule: string, path: string) =>
  rule.endsWith("/*") ? path.startsWith(rule.slice(0, -1)) && path.length > rule.length - 1 : rule === path

const sample = (pattern: string) => pattern.replace(/:([a-z]+)/g, (_, n: string) => (n === "name" ? "a" : "b"))

describe("matchPath", () => {
  test("params, exact segments, star tails", () => {
    expect(matchPath("/", "/")).toEqual({})
    expect(matchPath("/sites/:name", "/sites/api")).toEqual({ name: "api" })
    expect(matchPath("/sites/:name", "/sites/api/")).toEqual({ name: "api" })
    expect(matchPath("/sites/:name", "/sites")).toBeNull()
    expect(matchPath("/sites/:name", "/sites/a/b")).toBeNull()
    expect(matchPath("/sites/:name/requests/:id", "/sites/a/requests/r%2F1")).toEqual({ name: "a", id: "r/1" })
    expect(matchPath("/x/*", "/x")).toBeNull()
    expect(matchPath("/x/*", "/x/a/b")).toEqual({ "*": "a/b" })
    expect(matchPath("/sites/:name", "/sites/%E0%A4%A")).toBeNull()
  })
  test("ROUTES order: the request detail wins over :tab", () => {
    const m = matchRoute("/sites/api/requests/r1")!
    expect(ROUTES[m.index].pattern).toBe("/sites/:name/requests/:id")
    expect(matchRoute("/sites/api/logs")!.params).toEqual({ name: "api", tab: "logs" })
    expect(matchRoute("/network/peers")!.index).toBe(ROUTES.findIndex(r => r.pattern === "/network/peers"))
    expect(matchRoute("/sites/x/y/z")).toBeNull()
    expect(matchRoute("/nope")).toBeNull()
  })
  test("hashId decodes, and takes a malformed escape as written", () => {
    expect(hashId("#api-keys")).toBe("api-keys")
    expect(hashId("#a%20b")).toBe("a b")
    expect(hashId("#%")).toBe("%")
    expect(hashId("#%E0")).toBe("%E0")
  })
  test("routes on the same page module share one loader (so moving between them never remounts the page)", () => {
    const load = (pattern: string) => ROUTES.find(r => r.pattern === pattern)!.load
    expect(load("/sites")).toBe(load("/"))
    expect(load("/sites/:name/:tab")).toBe(load("/sites/:name"))
    expect(load("/sites/:name/requests/:id")).toBe(load("/sites/:name"))
    expect(load("/machine/services")).toBe(load("/machine"))
    expect(load("/passkeys")).toBe(load("/settings/passkeys"))
    expect(new Set(ROUTES.map(r => r.load)).size).toBe(12)
  })
  test("every ROUTES pattern is served by an APP_ROUTES rule", () => {
    for (const r of ROUTES) {
      const path = sample(r.pattern)
      expect(APP_ROUTES.some(rule => daemonMatch(rule, path))).toBe(true)
    }
  })
  test("the APP_ROUTES list", () => {
    expect([...APP_ROUTES]).toEqual(["/", "/sites", "/sites/*", "/public", "/public/*", "/network", "/network/*", "/activity", "/machine", "/machine/*", "/settings", "/settings/*", "/passkeys"])
  })
  test("every ROUTES entry loads a page module with a default export", async () => {
    for (const r of ROUTES) {
      const mod = await r.load()
      expect(typeof mod.default).toBe("function")
    }
  })
})

describe("MemoryRoute and hooks", () => {
  function Show() {
    const r = useRoute()
    const [q] = useQueryParam("q")
    return <span>{r.path}|{JSON.stringify(r.params)}|{q}|{r.hash}</span>
  }
  test("useRoute gives path, params, query and hash", () => {
    const html = renderToStaticMarkup(<MemoryRoute path="/sites/api/logs?q=err#x"><Show /></MemoryRoute>)
    expect(html).toBe(`<span>/sites/api/logs|{&quot;name&quot;:&quot;api&quot;,&quot;tab&quot;:&quot;logs&quot;}|err|#x</span>`)
  })
  test("useHistoryState reads the navigation state once, and clearing replaces it with null", () => {
    function S() {
      const s = useHistoryState<{ addWarnings: string[] }>()
      return <span>{s ? s.addWarnings.join(",") : "none"}</span>
    }
    expect(renderToStaticMarkup(<MemoryRoute path="/sites/a" state={{ addWarnings: ["w1", "w2"] }}><S /></MemoryRoute>)).toBe("<span>w1,w2</span>")
    expect(renderToStaticMarkup(<MemoryRoute path="/sites/a"><S /></MemoryRoute>)).toBe("<span>none</span>")

    const calls: unknown[][] = []
    const g = globalThis as Record<string, unknown>
    const had = "location" in g
    g.location = { pathname: "/sites/a", search: "?x=1", hash: "#h" }
    try {
      clearHistoryState({ replaceState: (...a: unknown[]) => { calls.push(a) } } as unknown as History)
    } finally {
      if (!had) delete g.location
    }
    expect(calls).toEqual([[null, "", "/sites/a?x=1#h"]])
  })
})
