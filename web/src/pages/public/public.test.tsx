import { describe, expect, test } from "bun:test"
import type { DomainsResponse } from "../../api/types.ts"
import { collectSites } from "../../lib/site.ts"
import { binding, config, fnSummary, proc, route } from "../../test/fixtures.ts"
import { renderWith } from "../../test/render.tsx"
import { BindForm, BindWarningBlock } from "./BindForm.tsx"
import BindingPage from "./BindingPage.tsx"
import {
  allowedWord, bindableSites, cleanIps, clearJwtWhich, clearPasswordWhich, clearTitle, isUnprotected, jwtWord, passwordWord,
  recordLines, siteDetail,
} from "./lib.ts"
import PublicPage from "./PublicPage.tsx"

const HOSTILE = "<img src=x onerror=alert(1)>"
const zone = (bindings: Record<string, ReturnType<typeof binding>>): DomainsResponse => ({
  configured: true, tunnel: { id: "t1", name: "home", credentialsFile: "/x.json" }, zone: { id: "z1", domain: "example.com" }, bindings,
})
const sites = collectSites({
  routes: { blog: route(4000), fwd: route("https://elsewhere.example") },
  processes: { success: true, processes: { blog: proc({ port: 4000 }) } },
  configs: { success: true, configs: { blog: config(), fnx: config({ fn: fnSummary() }) } },
})

describe("public lib", () => {
  test("password words", () => {
    expect(passwordWord(binding())).toBe("Login page")
    expect(passwordWord(binding({ apiMode: true }))).toBe("Every request")
    expect(passwordWord(binding({ hasPassword: false }))).toBe("Not set")
    expect(passwordWord(binding({ authEnabled: false }))).toBe("Not set")
    expect(isUnprotected(binding({ authEnabled: false }))).toBe(true)
  })
  test("jwt words", () => {
    expect(jwtWord(binding())).toBe("Not set")
    expect(jwtWord(binding({ hasJwtSecret: true, apiMode: true }))).toBe("Set")
    expect(jwtWord(binding({ hasJwtSecret: true }))).toBe("Needs API mode")
  })
  test("allowed words", () => {
    expect(allowedWord(binding())).toBe("Anyone")
    expect(allowedWord(binding({ allowlist: { enabled: true, ips: [] } }))).toBe("Tailscale")
    expect(allowedWord(binding({ allowlist: { enabled: true, ips: ["1.2.3.4"] } }))).toBe("1 IP + Tailscale")
    expect(allowedWord(binding({ allowlist: { enabled: true, ips: ["1.2.3.4", "10.0.0.0/8"] } }))).toBe("2 IPs + Tailscale")
  })
  test("which to clear", () => {
    expect(clearPasswordWhich(binding())).toBe("all")
    expect(clearPasswordWhich(binding({ hasJwtSecret: true }))).toBe("password")
    expect(clearJwtWhich(binding({ hasJwtSecret: true }))).toBe("jwt")
    expect(clearJwtWhich(binding({ hasJwtSecret: true, hasPassword: false }))).toBe("all")
    expect(clearTitle("password", "a.b")).toBe("Remove the password for a.b?")
    expect(clearTitle("jwt", "a.b")).toBe("Remove the JWT secret for a.b?")
    expect(clearTitle("all", "a.b")).toBe("Remove protection for a.b?")
  })
  test("site picker: route or config, with detail", () => {
    const opts = bindableSites(sites)
    expect(opts.map(o => o.value)).toEqual(["blog", "fnx", "fwd"])
    expect(siteDetail(sites.find(s => s.name === "fnx")!)).toBe("fn")
    expect(opts.find(o => o.value === "blog")!.detail).toBe(":4000")
    expect(opts.find(o => o.value === "fwd")!.detail).toBe("https://elsewhere.example")
  })
  test("records as text, ips cleaned", () => {
    expect(recordLines({ warning: true, message: "m", fqdn: "x", existingRecords: [{ type: "A", content: HOSTILE, id: "1" }] }))
      .toEqual([`A → ${HOSTILE}`])
    expect(cleanIps(["1.2.3.4, 5.6.7.8", " ", "1.2.3.4"])).toEqual(["1.2.3.4", "5.6.7.8"])
  })
})

describe("bind warning", () => {
  const w = { warning: true as const, message: `Records exist for ${HOSTILE}`, fqdn: "blog.example.com",
    existingRecords: [{ type: "CNAME", content: HOSTILE, id: "r1" }] }
  test("superuser can replace the records; escaped", () => {
    const html = renderWith(<BindWarningBlock warning={w} superuser busy={false} onForce={() => {}} onCancel={() => {}} />, { session: { superuser: true } })
    expect(html).toContain("Replace records")
    expect(html).not.toContain("Ask a superuser")
    expect(html).not.toContain("<img")
    expect(html).toContain("CNAME → &lt;img")
  })
  test("others are told to ask", () => {
    const html = renderWith(<BindWarningBlock warning={w} superuser={false} busy={false} onForce={() => {}} onCancel={() => {}} />)
    expect(html).not.toContain("Replace records")
    expect(html).toContain("Ask a superuser to replace them.")
    expect(html).toContain("Cancel")
  })
  test("the form preselects the site and the subdomain", () => {
    const html = renderWith(<BindForm zone="example.com" options={bindableSites(sites)} initialSite="blog" onClose={() => {}} />)
    expect(html).toContain('value="blog"')
    expect(html).toContain(".example.com")
  })
})

describe("PublicPage", () => {
  test("no zone: superuser gets Set one up", () => {
    const html = renderWith(<PublicPage />, { route: "/public", session: { superuser: true }, resources: { domains: { configured: false, bindings: {} }, sites } })
    expect(html).toContain("Put a site on your own domain through a Cloudflare tunnel.")
    expect(html).toContain("No zone is set up yet.")
    expect(html).toContain('href="/settings/daemon#zone"')
  })
  test("no zone: others are told who sets it up", () => {
    const html = renderWith(<PublicPage />, { route: "/public", resources: { domains: { configured: false, bindings: {} }, sites } })
    expect(html).toContain("No zone is set up yet; a superuser sets one up.")
    expect(html).not.toContain("Set one up")
  })
  test("list: rows link to the binding, hostile names escaped, owner only for superusers", () => {
    const d = zone({ blog: binding({ serverName: "blog" }), x: binding({ subdomain: "x", fqdn: "x.example.com", serverName: HOSTILE, hasPassword: false, owner: "bob" }) })
    const html = renderWith(<PublicPage />, { route: "/public", resources: { domains: d, sites } })
    expect(html).toContain('href="/public/blog"')
    expect(html).toContain('href="/sites/blog"')
    expect(html).toContain("Login page")
    expect(html).toContain("Not set")
    expect(html).not.toContain("<img")
    expect(html).not.toContain(">Owner<")
    expect(html).not.toContain(">JWT<")
    const su = renderWith(<PublicPage />, { route: "/public", session: { superuser: true }, resources: { domains: d, sites } })
    expect(su).toContain(">Owner<")
  })
  test("?bind opens the form with the site picked", () => {
    const html = renderWith(<PublicPage />, { route: "/public?bind=blog", resources: { domains: zone({}), sites } })
    expect(html).toContain("Bind a site")
    expect(html).toContain('aria-label="Bind a site"')
    expect(html).toContain("No public domains yet. Bind one to serve a site at name.example.com.")
  })
  test("the portal is never offered for binding", () => {
    const withPortal = collectSites({ routes: { portal: route(9999), blog: route(4000) } })
    expect(bindableSites(withPortal).map(o => o.value)).toEqual(["blog"])
  })
})

describe("BindingPage", () => {
  test("unprotected: cherry banner and Set a password", () => {
    const d = zone({ blog: binding({ hasPassword: false }) })
    const html = renderWith(<BindingPage />, { route: "/public/blog", resources: { domains: d, sites } })
    expect(html).toContain("Anyone with the link can open it.")
    expect(html).toContain("Set a password")
    expect(html).toContain("Serves")
    expect(html).not.toContain(">JWT<")
  })
  test("api mode with a secret: JWT section and its buttons", () => {
    const d = zone({ blog: binding({ apiMode: true, hasJwtSecret: true }) })
    const html = renderWith(<BindingPage />, { route: "/public/blog", resources: { domains: d, sites } })
    expect(html).toContain("API mode")
    expect(html).toContain("Every request")
    expect(html).toContain("Make a 10-minute token")
    expect(html).toContain("Rotate")
    expect(html).not.toContain("Anyone with the link can open it.")
  })
  test("allowlist shows the IPs and Allow all", () => {
    const d = zone({ blog: binding({ allowlist: { enabled: true, ips: ["10.0.0.0/8"] } }) })
    const html = renderWith(<BindingPage />, { route: "/public/blog", resources: { domains: d, sites } })
    expect(html).toContain("1 IP + Tailscale")
    expect(html).toContain('value="10.0.0.0/8"')
    expect(html).toContain("Allow all")
    expect(html).toContain("Tailscale and this machine are always allowed. Caddy drops others silently. Empty means everyone.")
  })
  test("unknown subdomain", () => {
    const html = renderWith(<BindingPage />, { route: "/public/nope", resources: { domains: zone({}), sites } })
    expect(html).toContain("no public domain")
  })
  test("flash from history state", () => {
    const html = renderWith(<BindingPage />, { route: "/public/blog", state: { flash: "Bound blog.example.com" }, resources: { domains: zone({ blog: binding() }), sites } })
    expect(html).toContain("Bound blog.example.com")
  })
})
