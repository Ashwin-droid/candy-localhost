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

    expect(daemonText).toContain("const proxyTarget = managed?.status === 'running' && managed.port")
    expect(daemonText).toContain(': "localhost:9999"')
    expect(daemonText).toContain("reverse_proxy ${proxyTarget}")
  })
})
