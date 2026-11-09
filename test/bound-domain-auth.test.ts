import { describe, expect, it } from "bun:test"

const daemonSource = async () =>
  Bun.file(new URL("../daemon.ts", import.meta.url)).text()

describe("bound domain authentication", () => {
  it("authenticates protected bound domains before daemon web routes", async () => {
    const daemonText = await daemonSource()
    const guardIndex = daemonText.indexOf("requireBoundDomainAuth(req, controlServer, boundDomainMatch.binding)")
    const apiAuthIndex = daemonText.indexOf("// === API Routes require token validation ===")
    const streamIndex = daemonText.indexOf('// === SSE Streaming Logs ===')
    const lazyStartIndex = daemonText.indexOf("// Main routing logic for *.localhost and bound domains")

    expect(guardIndex).toBeGreaterThan(0)
    expect(guardIndex).toBeLessThan(apiAuthIndex)
    expect(guardIndex).toBeLessThan(streamIndex)
    expect(guardIndex).toBeLessThan(lazyStartIndex)
  })

  it("keeps Caddy forward_auth in front of stopped protected bound domains", async () => {
    const daemonText = await daemonSource()

    // Stopped sites (no upstream) fall back to the daemon, still behind forward_auth
    expect(daemonText).toContain('const proxyTarget = upstream ?? "localhost:9999"')
    const authIndex = daemonText.indexOf("forward_auth localhost:9999")
    const proxyIndex = daemonText.indexOf("${caddyUpstream(proxyTarget)}")
    expect(authIndex).toBeGreaterThan(0)
    expect(proxyIndex).toBeGreaterThan(authIndex)
  })
})
