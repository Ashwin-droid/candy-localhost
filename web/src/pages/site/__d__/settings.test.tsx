import { describe, expect, test } from "bun:test"
import { useState } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ConfigInfo, DomainsResponse, ProcessInfo, RouteInfo } from "../../../api/types.ts"
import { collectSites, type Site } from "../../../lib/site.ts"
import { binding, config, fnSummary, proc, route, status } from "../../../test/fixtures.ts"
import { renderWith } from "../../../test/render.tsx"
import { useDraft } from "../../../ui/index.ts"
import { draftOnClean, draftOnServer, type DraftState } from "../../../ui/useDraft.ts"
import SettingsTab, { sectionIndex } from "../SettingsTab.tsx"
import { useDraftSet, visibility } from "../settings/common.tsx"
import { tailscalePort } from "../settings/ReachSection.tsx"
import { checkScaling } from "../settings/ScalingSection.tsx"
import { checkIdle } from "../settings/StartupSection.tsx"

const HOSTILE = `<img src=x onerror=alert(1)>`

function make(name: string, o: { route?: RouteInfo; proc?: ProcessInfo; config?: ConfigInfo; entry?: number }): Site {
  return collectSites({
    status,
    routes: o.route ? { [name]: o.route } : {},
    processes: { success: true, processes: o.proc ? { [name]: o.proc } : {} },
    configs: { success: true, configs: o.config ? { [name]: o.config } : {} },
    entries: { entries: o.entry ? { [name]: o.entry } : {} },
  })[0]
}

const assets = { directory: "/home/ashwin/site/public", binding: null, notFound: "none" as const, html: "auto-trailing-slash" as const, runWorkerFirst: false }
const SITES = {
  server: make("api", { route: route(3000), proc: proc(), config: config({ variants: [
    { id: "dev", cwd: "/home/ashwin/app", cmd: "bun dev", user: "ashwin", api: false },
    { id: "prod", cwd: "/home/ashwin/app", cmd: "bun start", user: "ashwin", api: true },
  ], count: 2 }) }),
  stoppedServer: make("api", { config: config() }),
  fn: make("hook", { route: route({ fn: "hook" }), config: config({ fn: fnSummary() }) }),
  static: make("docs", { route: route({ fn: "docs" }), config: config({ fn: fnSummary({ hasWorker: false, entry: null, assets }) }) }),
  forward: make("db", { route: route(5432) }),
  urlForward: make("ext", { route: route("https://example.com") }),
  forwardWithProc: make("tool", { route: route(4000), proc: proc({ port: 4000 }) }),
  procOnly: make("job", { proc: proc({ status: "dead", exitCode: 1 }) }),
}

const ZONE: DomainsResponse = {
  configured: true, tunnel: { id: "t", name: "t", credentialsFile: "/x" }, zone: { id: "z", domain: "example.com" },
  bindings: { blog: binding({ serverName: "api", fqdn: "api.example.com", subdomain: "api" }) },
}
const NO_ZONE: DomainsResponse = { configured: false, bindings: {} }

function render(site: Site, session: { superuser?: boolean; multiUser?: boolean } = {}, domains: DomainsResponse = ZONE) {
  return renderWith(<SettingsTab site={site} />, {
    session, route: `/sites/${site.name}/settings`, resources: { sites: [site], domains },
  })
}
const has = (html: string, id: string) => html.includes(`id="${id}"`)

describe("visibility matrix (render)", () => {
  const SECTIONS = ["general", "start-commands", "startup", "scaling", "environment", "sandbox", "reach", "reach-domains", "danger"]
  const expectSections = (html: string, want: string[]) => {
    expect(SECTIONS.filter(id => has(html, id))).toEqual(want)
  }
  test("server with a route, two commands and a process", () => {
    const html = render(SITES.server)
    expectSections(html, ["general", "start-commands", "startup", "environment", "reach", "reach-domains", "danger"])
    for (const id of ["set-name", "set-persistent", "set-api", "set-ttl", "set-port", "set-env", "set-entry"]) expect(has(html, id)).toBe(true)
    expect(html).toContain("Start commands (2)")
    expect(html).toContain("Delete command dev")
    expect(html).toContain("Delete command prod")
    expect(html).toContain("Open a quick tunnel")
  })
  test("stopped server with a config only: no route fields, no port", () => {
    const html = render(SITES.stoppedServer)
    expectSections(html, ["start-commands", "startup", "environment", "reach", "reach-domains", "danger"])
    expect(has(html, "set-port")).toBe(false)
    expect(has(html, "set-name")).toBe(false)
    expect(html).not.toContain("Open a quick tunnel")
    expect(html).toContain("Delete start command")
  })
  test("function with a worker", () => {
    const html = render(SITES.fn)
    expectSections(html, ["reach", "reach-domains", "scaling", "environment", "danger"].sort((a, b) => SECTIONS.indexOf(a) - SECTIONS.indexOf(b)))
    for (const id of ["set-hot", "set-max", "set-linger", "set-log", "set-env"]) expect(has(html, id)).toBe(true)
    expect(has(html, "set-name")).toBe(false)
    expect(has(html, "set-api")).toBe(false)
    expect(html).not.toContain("Open a quick tunnel")
    expect(html).toContain("Delete function")
    expect(html).not.toContain("Delete route")
  })
  test("static function: request log only, no env file", () => {
    const html = render(SITES.static, { multiUser: true, superuser: true })
    expectSections(html, ["scaling", "reach", "reach-domains", "danger"])
    expect(has(html, "set-log")).toBe(true)
    expect(has(html, "set-hot")).toBe(false)
    expect(html).toContain("Assets-only: the daemon serves the files itself and no process ever starts, so hot, max and linger don’t apply.")
    expect(has(html, "sandbox")).toBe(false)
  })
  test("port forward: general with target, reach, delete route", () => {
    const html = render(SITES.forward)
    expectSections(html, ["general", "reach", "reach-domains", "danger"])
    expect(html).toContain(":5432 on this machine")
    expect(html).toContain("To point it elsewhere, delete it and add it again.")
    expect(html).toContain("Open a quick tunnel")
  })
  test("URL forward: no quick tunnel", () => {
    const html = render(SITES.urlForward)
    expect(html).toContain("https://example.com")
    expect(html).not.toContain("Open a quick tunnel")
  })
  test("forward with a process gets the port field", () => {
    const html = render(SITES.forwardWithProc)
    expect(has(html, "startup")).toBe(true)
    expect(has(html, "set-port")).toBe(true)
    expect(has(html, "set-api")).toBe(false)
  })
  test("a leftover process with no config or route: only the port", () => {
    const html = render(SITES.procOnly)
    expectSections(html, ["startup"])
    expect(has(html, "set-port")).toBe(true)
  })
  test("superuser-only fields are absent for everyone else", () => {
    const user = render(SITES.server)
    for (const id of ["set-lan", "set-lan-https", "set-ts"]) expect(has(user, id)).toBe(false)
    const su = render(SITES.server, { superuser: true })
    expect(has(su, "set-lan")).toBe(true)
    expect(has(su, "set-ts")).toBe(true)
    expect(has(su, "set-lan-https")).toBe(false)              // only once it is on the LAN
    const onLan = make("api", { route: route(3000, { lan: true, lanHttps: "https://box.ts.net:8444" }), config: config() })
    expect(has(render(onLan, { superuser: true }), "set-lan-https")).toBe(true)
  })
  test("multi-user-only fields are absent on a single-user daemon", () => {
    expect(has(render(SITES.server), "sandbox")).toBe(false)
    const mu = render(SITES.server, { multiUser: true })
    expect(has(mu, "sandbox")).toBe(true)
    expect(has(mu, "set-memory")).toBe(true)
    expect(mu).toContain("Runs as")
    const off = make("api", { config: config({ sandbox: false }) })
    const offHtml = render(off, { multiUser: true })
    expect(has(offHtml, "set-memory")).toBe(false)
    expect(offHtml).toContain("Memory limit and writable folders apply only in the sandbox.")
  })
  test("no public zone", () => {
    const html = render(SITES.server, {}, NO_ZONE)
    expect(html).toContain("No public zone is set up.")
    expect(html).not.toContain("/settings/daemon")
    expect(render(SITES.server, { superuser: true }, NO_ZONE)).toContain('href="/settings/daemon"')
  })
  test("bindings of this site link to their page, and Bind a domain carries the name", () => {
    const html = render(SITES.server)
    expect(html).toContain("api.example.com")
    expect(html).toContain('href="/public/api"')
    expect(html).toContain('href="/public?bind=api"')
  })
  test("the portal itself is never a site, so it never gets a Settings tab", () => {
    expect(make("portal", { route: route(9999), config: config() })).toBeUndefined()
  })
  test("section index follows the sections", () => {
    const v = visibility(SITES.fn, { superuser: false, multiUser: false })
    expect(sectionIndex(v, { static: false }).map(([id]) => id)).toEqual(["scaling", "environment", "reach", "danger"])
    const html = render(SITES.server)
    expect(html).toContain('href="/sites/api/settings#general"')
    expect(html).toContain('href="/sites/api/settings#danger"')
  })
})

describe("escaping", () => {
  test("hostile values render as text", () => {
    const s = make("api", { route: route(3000), proc: proc({ cmd: HOSTILE }), config: config({
      envFile: HOSTILE, variants: [{ id: HOSTILE, cwd: HOSTILE, cmd: HOSTILE, user: "ashwin", api: false }],
    }) })
    const html = render(s, { multiUser: true })
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })
})

describe("validation messages (01 §5, §13.1)", () => {
  test("idle minutes", () => {
    expect(checkIdle("")).toBeNull()
    expect(checkIdle("30")).toBeNull()
    expect(checkIdle("abc")).toBe("Enter a number of minutes")
    expect(checkIdle("1.5")).toBe("Enter a number of minutes")
    expect(checkIdle("0")).toBe("Enter a number of minutes from 1 to 10080 (a week)")
    expect(checkIdle("10081")).toBe("Enter a number of minutes from 1 to 10080 (a week)")
  })
  test("scaling", () => {
    expect(checkScaling({ hot: "0", max: "4", linger: "30" })).toBeNull()
    expect(checkScaling({ hot: "-1", max: "4", linger: "30" })?.text).toBe("Hot must be 0 or more")
    expect(checkScaling({ hot: "x", max: "4", linger: "30" })?.text).toBe("Hot must be 0 or more")
    expect(checkScaling({ hot: "0", max: "0", linger: "30" })?.text).toBe("Max must be at least 1")
    expect(checkScaling({ hot: "5", max: "4", linger: "30" })).toEqual({ key: "hot", text: "Hot can’t be more than max" })
    expect(checkScaling({ hot: "0", max: "4", linger: "601" })?.text).toBe("Linger must be 0 to 600 seconds")
  })
  test("tailscale port from the serve URL", () => {
    expect(tailscalePort(null)).toBe("8443")
    expect(tailscalePort("https://box.tail.ts.net:9443")).toBe("9443")
    expect(tailscalePort("https://box.tail.ts.net")).toBe("8443")
  })
})

// Drafts: no DOM here, so the edits happen as render-phase updates, which React (and its server renderer)
// applies by rendering the component again before it returns.
describe("drafts and polls", () => {
  test("a dirty draft is not overwritten by a new server value: conflict instead", () => {
    function Harness() {
      const [step, setStep] = useState(0)
      const server = { ttl: step < 2 ? "60" : "15" }        // a poll brings 15 after the edit
      const d = useDraft(server)
      if (step === 0) { d.set("ttl", "30"); setStep(1) }
      else if (step === 1) setStep(2)
      return <i>{`${d.draft.ttl}|${d.dirty}|${d.conflict}`}</i>
    }
    expect(renderToStaticMarkup(<Harness />)).toBe("<i>30|true|true</i>")
  })
  test("edits undone by hand take the server value that came in while dirty", () => {
    const v1 = { ttl: "60", port: "3000" }, v2 = { ttl: "60", port: "4000" }
    let s: DraftState<typeof v1> = { base: v1, draft: v1, seen: JSON.stringify(v1), pending: false }
    s = { ...s, draft: { ...s.draft, ttl: "30" } }                // edit
    s = draftOnServer(s, v2, JSON.stringify(v2))                  // a poll brings port 4000: kept out
    expect(s.draft).toEqual({ ttl: "30", port: "3000" })
    expect(s.pending).toBe(true)
    expect(draftOnClean(s, v2)).toBe(s)                            // still dirty: nothing changes
    s = { ...s, draft: { ...s.draft, ttl: "60" } }                // edited back: clean again
    s = draftOnClean(s, v2)
    expect(s.base).toEqual(v2)
    expect(s.draft).toEqual(v2)
    expect(s.pending).toBe(false)
  })
  test("an untouched draft follows the server without a conflict", () => {
    function Harness() {
      const d = useDraft({ ttl: "60" })
      return <i>{`${d.draft.ttl}|${d.dirty}|${d.conflict}`}</i>
    }
    expect(renderToStaticMarkup(<Harness />)).toBe("<i>60|false|false</i>")
  })
  test("useDraftSet commits only the fields that saved", () => {
    function Harness() {
      const [step, setStep] = useState(0)
      const d = useDraftSet<"ttl" | "port", string>({ ttl: "60", port: "3000" })
      if (step === 0) { d.set("ttl", "30"); d.set("port", "3001"); setStep(1) }
      else if (step === 1) { d.commit(["ttl"]); setStep(2) }
      return <i>{`${d.draft.ttl}|${d.draft.port}|${d.dirtyKeys.join(",")}`}</i>
    }
    expect(renderToStaticMarkup(<Harness />)).toBe("<i>30|3001|port</i>")
  })
})
