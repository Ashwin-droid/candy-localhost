import { describe, expect, test } from "bun:test"
import type { ConfigInfo, ProcessInfo, SiteManifestView } from "../../../api/types.ts"
import { collectSites } from "../../../lib/site.ts"
import { config, fnSummary, proc, route, status } from "../../../test/fixtures.ts"
import { renderWith } from "../../../test/render.tsx"
import ManifestTab from "../ManifestTab.tsx"

const HOSTILE = `<img src=x onerror=alert(1)>`
const manifest = (o: Partial<SiteManifestView> = {}): SiteManifestView => ({
  auth: false, depends: [], publish: false, idle: false, pub: [], sub: [], service: false, cron: [], ...o,
})

function sitesWith(configs: Record<string, ConfigInfo>, processes: Record<string, ProcessInfo> = {}) {
  return collectSites({ status, configs: { success: true, configs }, processes: { success: true, processes } })
}
function render(name: string, all: ReturnType<typeof sitesWith>) {
  const site = all.find(s => s.name === name)!
  return renderWith(<ManifestTab site={site} />, { route: `/sites/${name}/manifest`, resources: { sites: all } })
}

describe("ManifestTab", () => {
  test("no candy.json", () => {
    const html = render("api", sitesWith({ api: config({ cwd: "/home/ashwin/api" }) }))
    expect(html).toContain("No candy.json in <code>/home/ashwin/api</code>. It runs with defaults.")
    expect(html).toContain("/home/ashwin/api/candy.json")
    expect(html).toContain("Reload candy.json")
  })
  test("a broken candy.json shows only the error block", () => {
    const html = render("api", sitesWith({ api: config({ manifest: { error: `candy.json: "pub"[0] ${HOSTILE}` } }) }))
    expect(html).toContain("It keeps its old config. Fix the file and reload it.")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("<img")
    expect(html).not.toContain('id="access"')
  })
  test("every declared thing has a row", () => {
    const all = sitesWith({
      api: config({ manifest: manifest({
        auth: true, service: true, publish: true, idle: true, depends: ["db", "secret"],
        pub: [
          { event: "built", auth: "none", users: [] },
          { event: "tested", auth: "lax", users: ["bob", "eve"] },
          { event: "shipped", auth: "strict", users: [], ordered: true },
          { event: "wa:reply", auth: "none", users: [], bind: "wa" },
        ],
        sub: ["db:ready", "*::ping", "candy:sub-request", "nobody:x"],
        cron: [{ tag: "cleanup", schedule: "0 3 * * *" }, { tag: "odd", schedule: "*/7 3-5 * * *" }],
      }) }),
      db: config({ manifest: manifest({ pub: [{ event: "ready", auth: "lax", users: [] }], sub: ["api:built"] }) }),
      wa: config({ manifest: manifest({ sub: ["*::reply"] }) }),
    }, { api: proc({ heldBy: ["db"] }) })
    const html = render("api", all)
    for (const id of ["access", "lifecycle", "depends", "events", "events-pub", "events-sub", "cron"]) expect(html).toContain(`id="${id}"`)
    expect(html).toContain("Asks for it")
    expect(html).toContain("Its key is in ")
    expect(html).toContain('href="/settings/sign-in"')
    expect(html).toContain("Accepts server-to-server tokens: other sites can prove which app is calling.")
    expect(html).toContain("Other users&#x27; sites may depend on it.")
    expect(html).toContain("It may ask to stay up past its idle limit.")
    expect(html).toContain("Not one of your sites")                         // "secret" isn't visible
    expect(html).toContain("Any site")
    expect(html).toContain("Its own user and the listed users")
    expect(html).toContain("The listed users, once api approved the app")
    expect(html).toContain("bob, eve")
    expect(html).toContain("Only wa")
    expect(html).toContain('href="/sites/wa"')                               // the bound entry's receiver
    expect(html).toContain("Publisher declares it (lax: allowed if you&#x27;re its user or listed)")
    expect(html).toContain("Inbound from any site")
    expect(html).toContain("candy built-in event")
    expect(html).toContain("every day at 03:00")
    expect(html).toContain("*/7 3-5 * * *")
    expect(html).toContain("Next run, estimated (")
    expect(html).toContain("Live, from the daemon.")
  })
  test("function facts and static assets", () => {
    const all = sitesWith({
      docs: config({ manifest: manifest(), fn: fnSummary({ hasWorker: false, entry: null, http: true,
        assets: { directory: "/home/ashwin/docs/dist", binding: null, notFound: "404-page", html: "auto-trailing-slash", runWorkerFirst: false } }) }),
    })
    const html = render("docs", all)
    expect(html).toContain('id="function"')
    expect(html).toContain("Has an HTTP handler")
    expect(html).toContain("No code. The daemon serves the files.")
    expect(html).toContain("Nearest 404.html, status 404")
  })
  test("no-URL function", () => {
    const all = sitesWith({ job: config({ manifest: manifest({ cron: [{ tag: "t", schedule: "@daily" }] }), fn: fnSummary({ http: false }) }) })
    const html = render("job", all)
    expect(html).toContain("No HTTP handler: no URL")
    expect(html).toContain("aren&#x27;t listed here yet.")
  })
  test("a function route without a visible config", () => {
    const all = collectSites({ status, routes: { hook: route({ fn: "hook" }) } })
    const html = render("hook", all)
    expect(html).toContain("Its candy.json isn&#x27;t visible to you.")
    expect(html).not.toContain("Reload candy.json")
  })
})
