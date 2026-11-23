import { describe, expect, test } from "bun:test"
import type { DomainsResponse } from "../api/types.ts"
import { attentionItems } from "../lib/attention.ts"
import { addressesOf, collectSites, FN_UNKNOWN, primaryAddress, siteKind, siteStatus, tabsFor, type Site, type SitesInput } from "../lib/site.ts"
import { binding, config, fnSummary, proc, route, status } from "./fixtures.ts"

const one = (i: SitesInput, name: string): Site => {
  const s = collectSites({ status, ...i }).find(x => x.name === name)
  if (!s) throw new Error(`no site ${name}`)
  return s
}

describe("collectSites", () => {
  test("a union of names from routes, processes, configs and tunnels, sorted, without reserved names", () => {
    const sites = collectSites({
      routes: { zed: route(3000), portal: route(9999), _audit: route(1) },
      processes: { success: true, processes: { api: proc(), k: proc() } },
      configs: { success: true, configs: { blog: config(), candy: config() } },
      portals: { tun: { port: 4000, url: "https://x.trycloudflare.com" }, p: { port: 1 } },
    })
    expect(sites.map(s => s.name)).toEqual(["api", "blog", "tun", "zed"])
  })

  test("a server: config + process", () => {
    const s = one({ configs: { success: true, configs: { api: config() } }, processes: { success: true, processes: { api: proc() } } }, "api")
    expect(s.kind).toBe("server")
    expect(s.active).toBe(true)
    expect(s.owner).toBe("ashwin")
    expect(s.variants).toEqual([{ id: "default", cwd: "/home/ashwin/app", cmd: "bun dev", user: "ashwin", api: false }])
    expect(s.fn).toBeNull()
  })

  test("a process-only site is a server", () => {
    const s = one({ processes: { success: true, processes: { left: proc({ status: "dead", exitCode: 0 }) } } }, "left")
    expect(s.kind).toBe("server")
    expect(s.owner).toBeNull()
  })

  test("a route + process (no config) is a server", () => {
    const s = one({ routes: { r: route(5173) }, processes: { success: true, processes: { r: proc({ port: 5173 }) } } }, "r")
    expect(s.kind).toBe("server")
  })

  test("a route only is a forward", () => {
    expect(one({ routes: { g: route(3000) } }, "g").kind).toBe("forward")
    expect(one({ routes: { ext: route("https://status.example.com") } }, "ext").kind).toBe("forward")
  })

  test("a function and a static site", () => {
    const f = one({ configs: { success: true, configs: { f: config({ fn: fnSummary() }) } } }, "f")
    expect(f.kind).toBe("function")
    const st = one({ configs: { success: true, configs: { st: config({ fn: fnSummary({ hasWorker: false, entry: null, assets: { directory: "/home/ashwin/docs/dist", binding: null, notFound: "404-page", html: "auto-trailing-slash", runWorkerFirst: false } }) }) } } }, "st")
    expect(st.kind).toBe("static")
  })

  test("a {fn} route with no visible config gets FN_UNKNOWN", () => {
    const s = one({ routes: { hidden: route({ fn: "hidden" }) } }, "hidden")
    expect(s.fn).toBe(FN_UNKNOWN)
    expect(s.kind).toBe("function")
  })

  test("no-URL function, traffic, entry port, bindings and manifest error", () => {
    const domains: DomainsResponse = { configured: true, tunnel: { id: "t", name: "t", credentialsFile: "/x" }, zone: { id: "z", domain: "example.com" },
      bindings: { blog: binding(), other: binding({ subdomain: "o", fqdn: "o.example.com", serverName: "other" }) } }
    const s = one({
      configs: { success: true, configs: { blog: config({ fn: fnSummary({ http: false }), manifest: { error: "bad json" } }) } },
      entries: { entries: { blog: 8080 } },
      stats: { sessionStart: "", totalRequests: 5, domains: [{ name: "blog", total: 5, alive: true, children: [] }] },
      domains,
    }, "blog")
    expect(s.noUrl).toBe(true)
    expect(s.entryPort).toBe(8080)
    expect(s.traffic?.total).toBe(5)
    expect(s.bindings.map(b => b.subdomain)).toEqual(["blog"])
    expect(s.manifest).toBeNull()
    expect(s.manifestError).toBe("bad json")
  })

  test("variants come from config.variants when there are several", () => {
    const v = [{ id: "dev", cwd: "/a", cmd: "x", user: "u", api: false }, { id: "prod", cwd: "/b", cmd: "y", user: "u", api: true }]
    expect(one({ configs: { success: true, configs: { a: config({ variants: v }) } } }, "a").variants).toEqual(v)
  })
})

describe("siteStatus: all 10 branches in order", () => {
  const base = (o: Partial<Site>): Site => ({ ...one({ routes: { x: route(1) } }, "x"), route: undefined, ...o })
  const cases: [string, Partial<Site>, string, string][] = [
    ["running", { proc: proc({ status: "running" }) }, "running", "Running"],
    ["starting", { proc: proc({ status: "starting" }) }, "starting", "Starting"],
    ["errored", { proc: proc({ status: "errored" }) }, "crashed", "Crashed"],
    ["dead", { proc: proc({ status: "dead" }) }, "stopped", "Stopped"],
    ["other", { proc: proc({ status: "paused" as never }) }, "idle", "Paused"],
    ["fn", { fn: fnSummary() }, "idle", "Starts on request"],
    ["config", { config: config() }, "idle", "Starts when opened"],
    ["config api", { config: config({ api: true }) }, "idle", "Starts on first request"],
    ["external", { route: route("https://x.example") }, "external", "External URL"],
    ["listening", { route: route(3000), traffic: { name: "x", total: 1, alive: true, children: [] } }, "running", "Listening"],
    ["forwarding", { route: route(3000) }, "idle", "Forwarding"],
  ]
  for (const [name, o, state, label] of cases) {
    test(name, () => expect(siteStatus(base(o))).toEqual({ state: state as never, label }))
  }
  test("process wins over fn and config", () => {
    expect(siteStatus(base({ proc: proc({ status: "errored" }), fn: fnSummary(), config: config() })).label).toBe("Crashed")
  })
  test("siteKind order", () => {
    expect(siteKind({ config: config({ fn: fnSummary() }), proc: proc() })).toBe("function")
    expect(siteKind({ proc: proc() })).toBe("server")
    expect(siteKind({ route: route(1) })).toBe("forward")
  })
})

describe("tabsFor", () => {
  test("per kind", () => {
    const server = one({ configs: { success: true, configs: { a: config() } } }, "a")
    expect(tabsFor(server)).toEqual(["overview", "logs", "requests", "manifest", "settings"])
    const procOnly = one({ processes: { success: true, processes: { a: proc() } } }, "a")
    expect(tabsFor(procOnly)).toEqual(["overview", "logs", "requests", "settings"])
    const fn = one({ configs: { success: true, configs: { a: config({ fn: fnSummary() }) } } }, "a")
    expect(tabsFor(fn)).toEqual(["overview", "requests", "deployments", "data", "manifest", "settings"])
    const fnProc = one({ configs: { success: true, configs: { a: config({ fn: fnSummary() }) } }, processes: { success: true, processes: { a: proc() } } }, "a")
    expect(tabsFor(fnProc)).toEqual(["overview", "logs", "requests", "deployments", "data", "manifest", "settings"])
    const stat = one({ configs: { success: true, configs: { a: config({ fn: fnSummary({ hasWorker: false, assets: { directory: "/d", binding: null, notFound: "none", html: "none", runWorkerFirst: false } }) }) } }, processes: { success: true, processes: { a: proc() } } }, "a")
    expect(tabsFor(stat)).toEqual(["overview", "requests", "deployments", "manifest", "settings"])
    const noUrl = one({ configs: { success: true, configs: { a: config({ fn: fnSummary({ http: false }) }) } } }, "a")
    expect(tabsFor(noUrl)).toEqual(["overview", "deployments", "data", "manifest", "settings"])
    const fwd = one({ routes: { a: route(3000) } }, "a")
    expect(tabsFor(fwd)).toEqual(["overview", "requests", "settings"])
    const fwdProc = one({ routes: { a: route(3000) }, processes: { success: true, processes: { a: proc() } } }, "a")
    expect(tabsFor(fwdProc)).toContain("logs")
  })
})

describe("addressesOf", () => {
  test("every way in, in order", () => {
    const s = one({
      routes: { blog: route(3000, { lan: true, lanHttps: "https://blog.lan.example:8443", tsServe: "https://box.ts.net:8443" }) },
      entries: { entries: { blog: 7001 } },
      portals: { blog: { port: 3000, url: "https://abc.trycloudflare.com" } },
      stats: { sessionStart: "", totalRequests: 9, domains: [{ name: "blog", total: 9, alive: true, children: [{ name: "t", url: "https://abc.trycloudflare.com", total: 4, alive: true }] }] },
      domains: { configured: true, tunnel: { id: "t", name: "t", credentialsFile: "/x" }, zone: { id: "z", domain: "example.com" },
        bindings: { blog: binding({ hasPassword: false, allowlist: { enabled: true, ips: ["1.2.3.4", "5.6.7.8"] } }) } },
    }, "blog")
    const a = addressesOf(s, { tld: "candy" })
    expect(a.map(x => x.way)).toEqual(["candy", "machine", "lan", "lan-https", "tailscale", "public", "tunnel"])
    expect(a[0]).toMatchObject({ url: "https://blog.candy", requests: 9 })
    expect(a[1].url).toBe("http://127.0.0.1:7001")
    expect(a[5]).toMatchObject({ url: "https://blog.example.com", note: "No password · 2 IPs" })
    expect(a[6]).toMatchObject({ url: "https://abc.trycloudflare.com", requests: 4 })
  })
  test("tailscale equal to LAN HTTPS shows once; a no-URL function has no candy row; an opening tunnel", () => {
    const s = one({ configs: { success: true, configs: { f: config({ fn: fnSummary({ http: false }), lanHttps: "https://x", tsServe: "https://x" }) } }, portals: { f: { port: 1 } } }, "f")
    const a = addressesOf(s, { tld: "localhost" })
    expect(a.map(x => x.way)).toEqual(["lan-https", "tunnel"])
    expect(a[1]).toMatchObject({ url: null, note: "Opening…" })
  })
})

describe("primaryAddress", () => {
  test("per kind", () => {
    expect(primaryAddress(one({ routes: { a: route(3000) } }, "a"))).toEqual({ text: ":3000", mono: true })
    expect(primaryAddress(one({ routes: { a: route("https://status.example.com/x") } }, "a"))).toEqual({ text: "status.example.com", mono: true })
    expect(primaryAddress(one({ configs: { success: true, configs: { a: config() } }, processes: { success: true, processes: { a: proc({ port: 5173 }) } } }, "a")).text).toBe(":5173")
    expect(primaryAddress(one({ configs: { success: true, configs: { a: config({ fn: fnSummary() }) } } }, "a")).text).toBe("src/index.ts")
    expect(primaryAddress(one({ configs: { success: true, configs: { a: config({ fn: fnSummary({ http: false }) }) } } }, "a"))).toEqual({ text: "no URL", mono: false })
  })
})

describe("attentionItems", () => {
  test("order and texts", () => {
    const sites = collectSites({
      status,
      configs: { success: true, configs: { api: config(), bad: config({ manifest: { error: "x" } }), big: config() } },
      processes: { success: true, processes: { api: proc({ status: "errored", exitCode: 1 }), big: proc({ memoryUsed: 1946 * 1048576, memoryMax: 2048 * 1048576 }) } },
    })
    const domains: DomainsResponse = { configured: true, tunnel: { id: "t", name: "t", credentialsFile: "/x" }, zone: { id: "z", domain: "example.com" },
      bindings: { blog: binding({ hasPassword: false, authEnabled: false }), safe: binding({ subdomain: "safe", fqdn: "safe.example.com" }) } }
    const items = attentionItems(sites, domains, true, [{ name: "z", error: "bad key" }])
    expect(items.map(i => i.kind)).toEqual(["crashed", "manifest", "reload", "domain", "memory", "build"])
    expect(items[0]).toMatchObject({ text: "api crashed · exit code 1", action: "restart", href: "/sites/api" })
    expect(items[1].text).toBe("bad: candy.json has an error (it keeps its old config)")
    expect(items[2].text).toBe("z: bad key (it keeps its old config)")
    expect(items[3]).toMatchObject({ text: "blog.example.com has no password. Anyone with the link can open it.", href: "/public/blog" })
    expect(items[4]).toMatchObject({ text: "big uses 1.9G of its 2G limit", href: "/sites/big/settings#sandbox" })
    expect(new Set(items.map(i => i.key)).size).toBe(items.length)
  })
  test("nothing to say", () => {
    expect(attentionItems([], undefined, false)).toEqual([])
  })
})
