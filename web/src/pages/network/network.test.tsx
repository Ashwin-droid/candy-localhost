import { describe, expect, test } from "bun:test"
import { collectSites } from "../../lib/site.ts"
import { route } from "../../test/fixtures.ts"
import { renderWith } from "../../test/render.tsx"
import { adguardText, httpsMode, lanRows, portRows, serveRows, tunnelRows } from "./lib.ts"
import NetworkPage from "./NetworkPage.tsx"
import PeersPage from "./PeersPage.tsx"
import { formatExpiry, normalizeRegistry, roleText } from "./registry.ts"

const HOSTILE = "<img src=x onerror=alert(1)>"

describe("registry normalisation", () => {
  test("arrays: roles, host, expiry; null host fields absent", () => {
    const r = normalizeRegistry({
      local: [{ name: "Api", ip: "100.1.1.1", hostName: null, dnsName: null, hostLabel: null, canonicalFqdn: "api.candy", aliasFqdns: [], winner: false }],
      remote: [
        { name: "b", ip: "100.2.2.2", hostName: "box", dnsName: "box.tail.ts.net", hostLabel: null, canonicalFqdn: "b.candy", aliasFqdns: [], winner: true, expiresIn: 61_000 },
        { name: "a", ip: "100.3.3.3", hostName: null, dnsName: null, hostLabel: "lap", canonicalFqdn: null, aliasFqdns: ["a.lap.candy"], winner: false, expiresIn: 5_000 },
        { name: "c", ip: "100.4.4.4", hostName: null, dnsName: null, hostLabel: null, canonicalFqdn: null, aliasFqdns: [], winner: false },
      ],
    })
    expect(r.local).toEqual([{ name: "api", ip: "100.1.1.1", side: "local", role: "canonical", canonicalFqdn: "api.candy", aliasFqdns: [], host: null, expiresIn: null }])
    expect(r.remote.map(x => [x.name, x.role, x.host, x.expiresIn])).toEqual([
      ["a", "alias", "lap", 5000], ["b", "canonical", "box · box.tail.ts.net", 61000], ["c", "shadowed", null, null],
    ])
    expect(roleText(r.remote[2])).toBe("shadowed by an earlier exact claim")
  })
  test("the older map shape", () => {
    const r = normalizeRegistry({ local: { web: "100.1.1.1" }, remote: { db: { ip: "100.9.9.9", expiresIn: 1000 } } })
    expect(r.local[0]).toMatchObject({ name: "web", ip: "100.1.1.1", role: "canonical", canonicalFqdn: "web.candy" })
    expect(r.remote[0]).toMatchObject({ name: "db", ip: "100.9.9.9", role: "canonical", expiresIn: 1000 })
  })
  test("garbage is skipped, not thrown", () => {
    expect(normalizeRegistry(null)).toEqual({ local: [], remote: [] })
    expect(normalizeRegistry({ local: [null, 3, { ip: "x" }], remote: "nope" })).toEqual({ local: [], remote: [] })
  })
  test("expiry words", () => {
    expect(formatExpiry(0)).toBe("expired")
    expect(formatExpiry(35_000)).toBe("35s")
    expect(formatExpiry(250_000)).toBe("4m 10s")
  })
})

describe("network rows", () => {
  test("LAN rows: published only, reserved names left out, https mode", () => {
    const rows = lanRows({ lanIp: "192.168.0.5", tailnetHost: null, published: ["api"], names: { api: true, web: false, portal: true },
      https: { api: { mode: "tailscale", port: 8443, url: "https://x.ts.net:8443" } } })!
    expect(rows.map(r => r.name)).toEqual(["api"])
    expect(httpsMode(rows[0].https!)).toBe("Tailscale :8443")
    expect(httpsMode({ mode: "domain", port: null, url: null })).toBe("Domain certificate")
  })
  test("serves, ports and tunnels", () => {
    expect(serveRows({ tailnetHost: "h", serves: { api: { port: 8443, url: "https://h:8443", entryPort: 5000 }, candy: { port: 1, url: null, entryPort: null } } }))
      .toEqual([{ name: "api", port: 8443, url: "https://h:8443", entryPort: 5000 }])
    const sites = collectSites({ routes: { api: route(3000), web: route(4000), portal: route(9999) }, entries: { entries: { api: 5000, portal: 1 } },
      portals: { web: { port: 4000, url: "https://w.trycloudflare.com" }, api: { port: 3000 } },
      stats: { sessionStart: "", totalRequests: 0, domains: [{ name: "web", total: 9, alive: true, children: [{ name: "w", url: "https://w.trycloudflare.com", total: 7, alive: true }] }] } })
    expect(portRows(sites)).toEqual([{ name: "api", port: 5000 }])
    expect(tunnelRows(sites, undefined)).toEqual([
      { name: "api", url: null, port: 3000, requests: null },
      { name: "web", url: "https://w.trycloudflare.com", port: 4000, requests: 7 },
    ])
  })
  test("AdGuard words", () => {
    expect(adguardText({ configured: false })).toBe("Not linked")
    const base = { configured: true as const, url: "http://127.0.0.1:3000", username: "u", client: "candy", dnsTarget: "127.0.0.1:5336", rules: ["a", "b"], managed: [], error: null }
    expect(adguardText(base)).toBe("Linked to http://127.0.0.1:3000, client candy, 2 names")
    expect(adguardText({ ...base, error: "401" })).toBe("Sync failed: 401")
  })
})

describe("NetworkPage render", () => {
  const sites = collectSites({ routes: { api: route(3000) }, entries: { entries: { api: 5000 } } })
  const resources = {
    sites, stats: { sessionStart: "", totalRequests: 0, domains: [] },
    domains: { configured: false, bindings: {} },
    lan: { lanIp: "192.168.0.5", tailnetHost: "box.tail.ts.net", published: [], names: { api: false }, https: {} },
    serves: { tailnetHost: null, serves: {} },
    adguard: { configured: false },
  }
  test("facts, tables and empty states; LAN DNS only for superusers", () => {
    const html = renderWith(<NetworkPage />, { route: "/network", resources })
    expect(html).toContain("192.168.0.5")
    expect(html).toContain("box.tail.ts.net")
    expect(html).toContain("Nothing published to the LAN.")
    expect(html).toContain("Nothing is served on Tailscale.")
    expect(html).toContain("No quick tunnels open.")
    expect(html).toContain("http://127.0.0.1:5000")
    expect(html).toContain('href="/sites/api/settings#reach"')
    expect(html).not.toContain("LAN DNS")
    expect(html).toContain('href="/network/peers"')
    const su = renderWith(<NetworkPage />, { route: "/network", session: { superuser: true }, resources })
    expect(su).toContain("LAN DNS")
    expect(su).toContain("Not linked")
  })
})

describe("PeersPage render", () => {
  test("both tables, escaped", () => {
    const html = renderWith(<PeersPage />, { route: "/network/peers", resources: { registry: {
      local: [{ name: "api", ip: "100.1.1.1", hostName: HOSTILE, dnsName: null, hostLabel: null, canonicalFqdn: "api.candy", aliasFqdns: [], winner: true }],
      remote: [],
    } } })
    expect(html).toContain("Local records")
    expect(html).toContain("No remote records.")
    expect(html).toContain("canonical")
    expect(html).not.toContain("<img")
  })
})
