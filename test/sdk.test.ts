import { afterEach, describe, expect, it } from "bun:test"

import {
  CANDY_RUNTIME_MAGIC_ENV,
  checkRuntime,
  getLocalhostUrl,
  registerServer,
} from "../sdk"

const originalRuntimeMagic = process.env[CANDY_RUNTIME_MAGIC_ENV]
const originalFetch = globalThis.fetch

afterEach(() => {
  if (originalRuntimeMagic === undefined) {
    delete process.env[CANDY_RUNTIME_MAGIC_ENV]
  } else {
    process.env[CANDY_RUNTIME_MAGIC_ENV] = originalRuntimeMagic
  }
  globalThis.fetch = originalFetch
})

describe("sdk runtime helpers", () => {
  it("detects when code is running inside candy", () => {
    process.env[CANDY_RUNTIME_MAGIC_ENV] = "cfg_test123"

    expect(checkRuntime()).toEqual({
      isCandyRuntime: true,
      magicString: "cfg_test123",
    })
  })

  it("returns localhost urls directly when a namespace is provided", async () => {
    delete process.env[CANDY_RUNTIME_MAGIC_ENV]

    await expect(getLocalhostUrl({ namespace: "demo-app" })).resolves.toBe("https://demo-app.localhost")
  })

  it("ignores registerServer calls from inside candy runtime", async () => {
    process.env[CANDY_RUNTIME_MAGIC_ENV] = "cfg_test123"
    globalThis.fetch = (() => {
      throw new Error("registerServer should not hit the daemon inside candy runtime")
    }) as typeof fetch

    await expect(registerServer({
      cwd: "/tmp/demo",
      command: "bun run dev",
      namespace: "demo-app",
    })).resolves.toEqual({
      ignored: true,
      name: "demo-app",
      url: "https://demo-app.localhost",
      configId: "cfg_test123",
    })
  })
})

describe("package exports", () => {
  it("points the package root at the sdk entrypoint", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      main?: string
      exports?: Record<string, string>
    }

    expect(packageJson.main).toBe("./sdk.ts")
    expect(packageJson.exports?.["."]).toBe("./sdk.ts")
  })

  it("keeps the daemon runtime magic env contract in place", async () => {
    const daemonText = await Bun.file(new URL("../daemon.ts", import.meta.url)).text()
    expect(daemonText).toContain(CANDY_RUNTIME_MAGIC_ENV)
  })
})
