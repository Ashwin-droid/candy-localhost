import { describe, expect, it } from "bun:test"

describe("daemon redirects", () => {
  it("does not redirect users to http://localhost:<port>", async () => {
    const daemonText = await Bun.file(new URL("../daemon.ts", import.meta.url)).text()
    expect(daemonText).not.toContain("Response.redirect(`http://localhost:${managed.port}")
  })
})

