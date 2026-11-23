// Package B: Sites list, Add site, site frame, Overview (SPEC §8 B "Done when").

import { describe, expect, test } from "bun:test"
import { collectSites, type Site } from "../../../lib/site.ts"
import type { ConfigInfo, DomainsResponse, ProcessInfo, RouteInfo } from "../../../api/types.ts"
import { binding, config, fnSummary, proc, route, status } from "../../../test/fixtures.ts"
import { BOOT, fakeFetch, fakeLocation, fakeStorage, renderWith } from "../../../test/render.tsx"
import { createApi, setApiForTest } from "../../../api/client.ts"
import { stopSite } from "../../sites/actions.ts"
import SitesPage from "../../sites/SitesPage.tsx"
import {
  filterSites, kindCounts, parseDismissed, parseStoredView, rowAction, serializeView, showsOwners, statusText, summary,
  viewFromQuery, viewToQuery, DEFAULT_VIEW, byStatus, memoryCell,
} from "../../sites/view.ts"
import SitePage, { headerActions, kindWord, resolveTab, siteTitle, statePhrase } from "../SitePage.tsx"
import OverviewTab, { codeRows, lastRunApplies, likelyCause, manifestLines } from "../OverviewTab.tsx"
import { addRequest, AddSiteDialog, fnAddNote, validateAdd, RESERVED_NAME, type AddForm } from "../AddSiteDialog.tsx"

const MB = 1048576

function sitesOf(o: {
  routes?: Record<string, RouteInfo>; processes?: Record<string, ProcessInfo>; configs?: Record<string, ConfigInfo>
  portals?: Record<string, { port: number; url?: string }>; domains?: DomainsResponse
}): Site[] {
  return collectSites({
    status, routes: o.routes ?? {}, entries: { entries: {} },
    processes: { success: true, processes: o.processes ?? {} },
    configs: { success: true, configs: o.configs ?? {} }, portals: o.portals ?? {},
    stats: { sessionStart: "", totalRequests: 0, domains: [{ name: "api", total: 1204, alive: true, children: [] }] },
    domains: o.domains,
  })
}

const ALL = sitesOf({
  routes: { api: route(5173), grafana: route(3000), status: route("https://status.example.com"), blog: route({ fn: "blog" }), portal: route(9999) },
  processes: {
    api: proc({ status: "errored", exitCode: 1, port: 5173 }),
    shop: proc({ status: "running", memoryUsed: 182 * MB }),
  },
  configs: {
    api: config(),
    shop: config({ user: "alice" }),
    blog: config({ fn: fnSummary({ hot: 2 }) }),
    docs: config({ fn: fnSummary({ hasWorker: false, entry: null, assets: { directory: "/home/ashwin/docs/dist", binding: null, notFound: "none", html: "auto-trailing-slash", runWorkerFirst: false } }) }),
    nightly: config({ fn: fnSummary({ http: false }) }),
  },
})
const byName = (n: string) => ALL.find(s => s.name === n)!

describe("view helpers", () => {
  test("the portal is never a site", () => {
    expect(ALL.map(s => s.name)).not.toContain("portal")
  })
  test("summary sentence", () => {
    expect(summary(ALL)).toBe("7 sites, 1 running")
    const t = sitesOf({ routes: { a: route(1) }, portals: { a: { port: 1, url: "https://x.trycloudflare.com" } } })
    expect(summary(t)).toBe("1 site, 0 running, 1 quick tunnel open")
  })
  test("row action per §5.1", () => {
    expect(rowAction(byName("shop"))).toBe("stop")
    expect(rowAction(byName("api"))).toBe("restart")
    expect(rowAction(byName("blog"))).toBe(null)          // an idle function starts on its own
    expect(rowAction(byName("grafana"))).toBe(null)       // a plain forward has no process
    const stopped = sitesOf({ configs: { x: config() } })[0]
    expect(rowAction(stopped)).toBe("start")
  })
  test("status text: N warm for a routed function with hot instances", () => {
    expect(statusText(byName("blog"))).toBe("2 warm")
    expect(statusText(byName("api"))).toBe("Crashed")
  })
  test("crashed sorts first", () => {
    expect([...ALL].sort(byStatus)[0].name).toBe("api")
  })
  test("memory cell", () => {
    expect(memoryCell(byName("shop"))).toEqual({ text: "182M", title: "of 2G limit" })
    expect(memoryCell(byName("api")).text).toBe("—")
  })
  test("filter by text, kind and owner", () => {
    expect(filterSites(ALL, { q: "5173", kind: "all", owner: "all" }, "ashwin", false).map(s => s.name)).toEqual(["api"])
    expect(filterSites(ALL, { q: "", kind: "forward", owner: "all" }, "ashwin", false).map(s => s.name)).toEqual(["grafana", "status"])
    expect(filterSites(ALL, { q: "", kind: "server", owner: "mine" }, "ashwin", true).map(s => s.name)).toEqual(["api"])
    expect(kindCounts(ALL)).toEqual({ all: 7, server: 2, function: 2, static: 1, forward: 2 } as never)
  })
  test("owner column only for a superuser who sees someone else's site", () => {
    expect(showsOwners(ALL, true, "ashwin")).toBe(true)
    expect(showsOwners(ALL, false, "ashwin")).toBe(false)
  })
  test("view in the URL and in storage", () => {
    const v = { ...DEFAULT_VIEW, q: "api", kind: "server" as const, sort: "requests" as const, dir: -1 as const }
    const q = viewToQuery(v, new URLSearchParams("add=x"))
    expect(q.toString()).toBe("add=x&q=api&kind=server&sort=requests&dir=desc")
    expect(viewFromQuery(q)).toEqual(v)
    expect(parseStoredView(serializeView(v))).toEqual(v)
    expect(parseStoredView("not json")).toBe(null)
    expect(viewFromQuery(new URLSearchParams("kind=bogus&sort=x"))).toEqual(DEFAULT_VIEW)
    expect(parseDismissed('["a",1,"b"]')).toEqual(["a", "b"])
  })
})

describe("Sites page render", () => {
  const render = (sites: Site[], session = {}, route = "/", domains?: DomainsResponse) =>
    renderWith(<SitesPage />, { resources: { sites, ...(domains ? { domains } : {}) }, session, route })

  test("no pills, at most one dot per row", () => {
    const html = render(ALL)
    expect(html).not.toMatch(/class="[^"]*\b(chip|pill)\b/)
    const rows = html.split("<tr").slice(2)  // skip the header row
    expect(rows.length).toBe(ALL.length)
    for (const r of rows) expect((r.match(/ui-dot /g) ?? []).length).toBeLessThanOrEqual(1)
  })
  test("owner shown only for a superuser", () => {
    expect(render(ALL, { superuser: true })).toContain("sites-owner")
    expect(render(ALL, { superuser: false })).not.toContain("sites-owner")
    expect(render(ALL, { superuser: true })).toContain("Everyone")
    expect(render(ALL, { superuser: false })).not.toContain("Everyone")
  })
  test("attention items", () => {
    const domains: DomainsResponse = {
      configured: true, tunnel: { id: "t", name: "t", credentialsFile: "/x" }, zone: { id: "z", domain: "example.com" },
      bindings: { blog: binding({ hasPassword: false }) },
    }
    const html = render(ALL, {}, "/", domains)
    expect(html).toContain("Needs attention")
    expect(html).toContain("api crashed · exit code 1")
    expect(html).toContain("blog.example.com has no password. Anyone with the link can open it.")
    expect(html).toContain("Protect it")
    expect(render(sitesOf({ configs: { x: config() } }))).not.toContain("Needs attention")
  })
  test("summary, header actions, kind counts", () => {
    const html = render(ALL)
    expect(html).toContain("7 sites, 1 running")
    expect(html).toContain("Reload candy.json")
    expect(html).toContain("Add site")
    expect(html).toContain("Servers 2")
    expect(html).toContain("no URL")
  })
  test("hostile names render escaped", () => {
    const evil = sitesOf({ configs: { "x": config({ cmd: "<img src=x onerror=alert(1)>", user: "<b>u</b>" }) } })
    const html = render(evil, { superuser: true })
    expect(html).not.toContain("<img src=x")
    expect(html).not.toContain("<b>u</b>")
  })
  test("empty state", () => {
    expect(render([])).toContain("No sites yet. Open any <code")
  })
  test("?add=foo opens Add site in port mode with the name", () => {
    const html = render(ALL, {}, "/?add=foo")
    expect(html).toContain("Add a site")
    expect(html).toContain('value="foo"')
  })
  test("loading shows a skeleton", () => {
    expect(renderWith(<SitesPage />, {})).toContain("ui-skeleton")
  })
})

describe("Add site", () => {
  const base: AddForm = { mode: "port", name: "", port: "", persistent: false, cwd: "", cmd: "", api: false, user: null, entry: "", hot: "", max: "", linger: "", envFile: "" }
  test("validation messages", () => {
    expect(validateAdd({ ...base, name: "a b", port: "0" })).toEqual({ name: "Use letters, numbers and dashes only", port: "Enter a port between 1 and 65535" })
    expect(validateAdd({ ...base, name: "portal", port: "3000" }).name).toBe(RESERVED_NAME)
    expect(validateAdd({ ...base, mode: "fn", name: "f", cwd: "/x", hot: "5", max: "2" }).hot).toBe("Hot can't be more than max")
    expect(validateAdd({ ...base, mode: "fn", name: "f", cwd: "/x", linger: "601" }).linger).toBe("Linger must be 0 to 600 seconds")
    expect(validateAdd({ ...base, mode: "fn", name: "f", cwd: "/x", max: "0" }).max).toBe("Max must be a whole number, 1 or more")
    expect(validateAdd({ ...base, mode: "fn", name: "f", cwd: "/x", envFile: "rel/.env" }).envFile).toBe("Use the full path of the env file, starting with /")
    expect(validateAdd({ ...base, mode: "cmd", name: "c" })).toEqual({ cwd: "Enter the project folder", cmd: "Enter the start command" })
  })
  test("requests", () => {
    expect(addRequest({ ...base, name: "Api", port: "3000", persistent: true }, false)).toEqual({ path: "/register", body: { name: "api", port: 3000, persistent: true } })
    expect(addRequest({ ...base, mode: "cmd", name: "w", cwd: "~/w", cmd: "bun dev", api: true, user: "alice" }, true))
      .toEqual({ path: "/config", body: { name: "w", cwd: "~/w", cmd: "bun dev", user: "alice", api: true } })
    expect(addRequest({ ...base, mode: "cmd", name: "w", cwd: "~/w", cmd: "bun dev", user: "alice" }, false).body).not.toHaveProperty("user")
    expect(addRequest({ ...base, mode: "fn", name: "f", cwd: "/f", hot: "1", linger: "0", envFile: "/e" }, false))
      .toEqual({ path: "/fn/add", body: { name: "f", cwd: "/f", hot: 1, linger: 0, envFile: "/e" } })
  })
  test("function notes", () => {
    expect(fnAddNote({ url: "https://f.candy", fn: fnSummary({ hasWorker: false }) })).toBe("The daemon serves its files; no process starts.")
    expect(fnAddNote({ url: null, fn: fnSummary() })).toBe("Its candy.json handlers leave out http, so it gets no URL: cron and events run it.")
    expect(fnAddNote({ url: "https://f.candy", fn: fnSummary() })).toBe("It starts on the first request.")
  })
  test("run as hidden without /users", () => {
    const html = renderWith(<AddSiteDialog open onClose={() => {}} mode="cmd" />, { session: { superuser: true } })
    expect(html).toContain("Project folder")
    expect(html).not.toContain("Run as")
  })
  test("run as shown for a superuser with several users", () => {
    const users = { owner: "ashwin", you: "ashwin", superuser: true, multiUser: true, users: [{ name: "ashwin", home: "/home/ashwin" }, { name: "alice", home: "/home/alice" }] }
    const html = renderWith(<AddSiteDialog open onClose={() => {}} mode="cmd" />, { session: { superuser: true }, resources: { users } })
    expect(html).toContain("Run as")
    expect(html).toContain("~ is ashwin&#x27;s home, /home/ashwin.")
    const plain = renderWith(<AddSiteDialog open onClose={() => {}} mode="cmd" />, { session: { superuser: false }, resources: { users } })
    expect(plain).not.toContain("Run as")
  })
  test("a non-superuser still gets the ~ hint from their own /users entry", () => {
    const users = { owner: "ashwin", you: "bob", superuser: false, multiUser: true, users: [{ name: "bob", home: "/home/bob" }] }
    const html = renderWith(<AddSiteDialog open onClose={() => {}} mode="cmd" />, { session: { superuser: false, user: "bob" }, resources: { users } })
    expect(html).not.toContain("Run as")
    expect(html).toContain("~ is bob&#x27;s home, /home/bob.")
  })
})

describe("site frame", () => {
  const page = (sites: Site[], path: string, session = {}) => renderWith(<SitePage />, { resources: { sites }, route: path, session })

  test("tab resolution", () => {
    expect(resolveTab(undefined, undefined)).toBe("overview")
    expect(resolveTab("logs", undefined)).toBe("logs")
    expect(resolveTab(undefined, "abc")).toBe("requests")
    expect(resolveTab("events", undefined)).toEqual({ redirect: "events" })
    expect(resolveTab("nope", undefined)).toBe("unknown")
  })
  test("tabs per kind", () => {
    const tabsIn = (html: string) => [...html.matchAll(/class="ui-tab[^"]*"[^>]*>([A-Za-z]+)/g)].map(m => m[1])
    expect(tabsIn(page(ALL, "/sites/api"))).toEqual(["Overview", "Logs", "Requests", "Manifest", "Settings"])
    expect(tabsIn(page(ALL, "/sites/blog"))).toEqual(["Overview", "Requests", "Deployments", "Data", "Manifest", "Settings"])
    expect(tabsIn(page(ALL, "/sites/docs"))).toEqual(["Overview", "Requests", "Deployments", "Manifest", "Settings"])
    expect(tabsIn(page(ALL, "/sites/nightly"))).toEqual(["Overview", "Deployments", "Data", "Manifest", "Settings"])
    expect(tabsIn(page(ALL, "/sites/grafana"))).toEqual(["Overview", "Requests", "Settings"])
  })
  test("header actions: a proc-only site and a forward with a process show Restart and Stop", () => {
    const s = sitesOf({ routes: { fwd: route(3000) }, processes: { solo: proc(), fwd: proc() } })
    for (const n of ["solo", "fwd"]) {
      const site = s.find(x => x.name === n)!
      expect(headerActions(site)).toEqual({ deploy: false, start: false, restart: true, stop: true })
      const html = page(s, `/sites/${n}`)
      expect(html).toContain(">Restart<")
      expect(html).toContain(">Stop<")
      expect(html).not.toContain(">Start<")
    }
    expect(headerActions(byName("grafana"))).toEqual({ deploy: false, start: false, restart: false, stop: false })
    expect(headerActions(byName("blog")).deploy).toBe(true)
  })
  test("several start commands: Start ▾", () => {
    const s = sitesOf({ configs: { two: config({ variants: [
      { id: "dev", cwd: "/a", cmd: "bun dev", user: "ashwin", api: false },
      { id: "prod", cwd: "/a", cmd: "bun start", user: "ashwin", api: false },
    ] }) } })
    const html = page(s, "/sites/two")
    expect(html).toContain('aria-haspopup="true"')
  })
  test("meta: kind, state phrase, runs as", () => {
    expect(kindWord(byName("docs"))).toBe("Function · static")
    expect(statePhrase(byName("api"))).toBe("Crashed, exit code 1")
    expect(statePhrase(byName("shop"))).toBe("Running for 3h 12m")
    expect(statePhrase(byName("blog"))).toBe("Live from source")
    const html = page(ALL, "/sites/shop", { multiUser: true })
    expect(html).toContain("Runs as alice")
    expect(page(ALL, "/sites/shop", { multiUser: false })).not.toContain("Runs as alice")
    expect(siteTitle(byName("api"), "candy", "logs")).toBe("api.candy logs – candy")
  })
  test("manifest error line", () => {
    const s = sitesOf({ configs: { m: config({ manifest: { error: "bad json" } }) } })
    expect(page(s, "/sites/m")).toContain("candy.json has an error. It keeps its old config.")
  })
  test("unknown site, and no Add it for candy's own names", () => {
    const html = page(ALL, "/sites/ghost")
    expect(html).toContain("There is no site called ghost. It may have been renamed or deleted.")
    expect(html).toContain("/?add=ghost")
    const portal = page(ALL, "/sites/portal")
    expect(portal).toContain("There is no site called portal")
    expect(portal).not.toContain("Add it")
  })
})

describe("Overview", () => {
  const ov = (site: Site, o: { state?: unknown; session?: object } = {}) =>
    renderWith(<OverviewTab site={site} />, { resources: { sites: ALL }, state: o.state, session: o.session })

  test("Add site warnings read from history state", () => {
    const html = ov(byName("blog"), { state: { addWarnings: ["candy.fn" + "x is ignored"], addNote: "It starts on the first request." } })
    expect(html).toContain("It starts on the first request.")
    expect(html).toContain("is ignored")
    expect(ov(byName("blog"))).not.toContain("It starts on the first request.")
  })
  test("last run for a crashed server", () => {
    expect(lastRunApplies(byName("api"))).toBe(true)
    expect(lastRunApplies(byName("shop"))).toBe(false)
    const html = ov(byName("api"))
    expect(html).toContain("Last run")
    expect(html).toContain("Crashed · exit code 1")
    expect(html).toContain("Open full log")
    const s = sitesOf({ configs: { m: config() }, processes: { m: proc({ status: "errored", exitCode: 137, memoryUsed: 1990 * MB, memoryMax: 2048 * MB }) } })[0]
    expect(likelyCause(s)).toBe("It was near its memory limit")
  })
  test("process rows", () => {
    const html = ov(byName("shop"), { session: { multiUser: true } })
    expect(html).toContain("Process")
    expect(html).toContain("1234")
    expect(html).toContain("(detected)")
    expect(html).toContain("182M of 2G")
    expect(html).toContain("Stops after 60 min idle")
    expect(html).toContain("(usual)")
    expect(html).toContain("Runs as")
    expect(ov(byName("shop"), { session: { multiUser: false } })).not.toContain(">Runs as<")
  })
  test("code rows", () => {
    const rows = codeRows(byName("docs"))
    expect(rows[0].value).toBe("No code. The daemon serves the files.")
    expect(rows.some(r => r.label === "Scaling")).toBe(false)
    expect(codeRows(byName("blog")).find(r => r.label === "Scaling")?.value).toBe("hot 2, max 4, linger 30s")
  })
  test("reachable at", () => {
    const html = ov(byName("api"))
    expect(html).toContain("Reachable at")
    expect(html).toContain("api.candy")
    expect(html).toContain("1,204 requests")
    expect(html).toContain("Change these in Settings")
    expect(ov(byName("nightly"))).toContain("No URL. Its candy.json handlers leave out http, so cron jobs and events are what run it.")
  })
  test("from candy.json", () => {
    const s = sitesOf({ configs: { m: config({ manifest: { auth: true, depends: [], publish: false, idle: true, pub: [{ event: "a", auth: "lax", users: [] }, { event: "b", auth: "none", users: [] }, { event: "c", auth: "none", users: [] }], sub: ["x:y"], service: true, cron: [{ tag: "a", schedule: "* * * * *" }, { tag: "b", schedule: "0 3 * * *" }] } }) } })[0]
    const texts = manifestLines(s).flatMap(g => g.lines.map(l => l.text))
    expect(texts).toEqual(["Asks for Sign in with candy", "Accepts service tokens", "Publishes 3 events, subscribes to 1", "2 scheduled runs", "May ask to stay up past its idle limit"])
    expect(ov(sitesOf({ configs: { n: config() } })[0])).toContain("No candy.json in <span class=\"mono\">~/app</span>. It runs with defaults.")
  })
  test("instances table for a function with a worker", () => {
    const html = renderWith(<OverviewTab site={byName("blog")} />, {
      resources: { sites: ALL, "fn/instances:blog": { success: true, instances: [], fn: fnSummary() } },
    })
    expect(html).toContain("Instances (0)")
    expect(html).toContain("None running. The next request starts one.")
    expect(html).toContain("Warm up")
    expect(ov(byName("docs"))).not.toContain("Warm up")
  })
})

describe("stopSite", () => {
  const withApi = (answer: () => Response) => {
    let n = 0
    const f = fakeFetch({
      "POST /portal/boot": () => Response.json({ ...BOOT, token: `t${++n}` }),
      "POST /token": () => Response.json({ token: `t${++n}` }),
      "POST /process/stop/web": answer,
    })
    setApiForTest(createApi({ fetch: f, storage: fakeStorage({ candy_session: "s" }), location: fakeLocation() }))
  }
  test("a site that had already exited (200 {success:false}, no error) reads as stopped", async () => {
    withApi(() => Response.json({ success: false, alsoStopped: [] }))
    expect(await stopSite({ name: "web", fn: false })).toBe("web stopped")
  })
  test("a real failure keeps its message", async () => {
    withApi(() => Response.json({ success: false, error: "web is not yours" }, { status: 403 }))
    expect(await stopSite({ name: "web", fn: false }).catch((e: Error) => e.message)).toBe("web is not yours")
  })
  test("a network failure is 'Can't reach the candy daemon.'", async () => {
    withApi(() => { throw new TypeError("fetch failed") })
    expect(await stopSite({ name: "web", fn: false }).catch((e: Error) => e.message)).toBe("Can't reach the candy daemon.")
  })
})
