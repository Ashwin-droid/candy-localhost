import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  CANDY_RUNTIME_MAGIC_ENV,
  checkRuntime,
  getLocalhostUrl,
  registerFunction,
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

describe("registerFunction", () => {
  const dir = "/tmp/claude-1000/candy-fn-build/phase6b/sdk"
  const savedSecretFile = process.env.CANDY_SECRET_FILE

  beforeAll(() => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "secret"), "dummy-secret\n")
    process.env.CANDY_SECRET_FILE = join(dir, "secret")
  })

  afterAll(() => {
    if (savedSecretFile === undefined) delete process.env.CANDY_SECRET_FILE
    else process.env.CANDY_SECRET_FILE = savedSecretFile
    rmSync(dir, { recursive: true, force: true })
  })

  /** Fake daemon: answers the key exchange, records everything else. */
  const stub = (respond: (path: string, body: any) => Response) => {
    const calls: { path: string; method: string; key: string | null; body: any }[] = []
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const path = new URL(String(input)).pathname
      if (path === "/mcp/auth") return Response.json({ apiKey: "k" })
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ path, method: init.method || "GET", key: new Headers(init.headers).get("X-Candy-API-Key"), body })
      return respond(path, body)
    }) as typeof fetch
    return calls
  }

  it("posts to /fn/add with the API key and returns the daemon's url", async () => {
    const calls = stub(() => Response.json({ success: true, name: "hello", url: "https://hello.localhost" }))
    await expect(registerFunction({ cwd: "/srv/hello", namespace: "hello", entry: "src/index.ts", hot: 1, max: 2 }))
      .resolves.toEqual({ name: "hello", url: "https://hello.localhost" })
    expect(calls).toEqual([{ path: "/fn/add", method: "POST", key: "k", body: { name: "hello", cwd: "/srv/hello", entry: "src/index.ts", hot: 1, max: 2 } }])
  })

  it("takes name like registerServer, leaves optional fields out, and falls back to <name>.localhost", async () => {
    const calls = stub(() => Response.json({ success: true }))
    await expect(registerFunction({ cwd: "/srv/api", name: " api " })).resolves.toEqual({ name: "api", url: "https://api.localhost" })
    expect(calls[0].body).toEqual({ name: "api", cwd: "/srv/api" })
  })

  it("names the function after its folder when no name is given, and passes linger", async () => {
    const calls = stub(() => Response.json({ success: true }))
    await expect(registerFunction({ cwd: "/srv/My API/", linger: 0 })).resolves.toEqual({ name: "my-api", url: "https://my-api.localhost" })
    expect(calls[0].body).toEqual({ name: "my-api", cwd: "/srv/My API/", linger: 0 })
  })

  it("still registers from inside a candy runtime", async () => {
    process.env[CANDY_RUNTIME_MAGIC_ENV] = "cfg_test123"
    const calls = stub(() => Response.json({ success: true }))
    await registerFunction({ cwd: "/srv/w", name: "w" })
    expect(calls).toHaveLength(1)
  })

  it("validates before calling the daemon", async () => {
    const calls = stub(() => Response.json({ success: true }))
    await expect(registerFunction({ cwd: "/srv/x", name: " " })).rejects.toThrow("namespace is required")
    await expect(registerFunction({ cwd: "/" })).rejects.toThrow("name is required")
    await expect(registerFunction({ cwd: "/srv/x", name: "x", linger: 601 })).rejects.toThrow("linger")
    await expect(registerFunction({ cwd: "", name: "x" })).rejects.toThrow("cwd is required")
    await expect(registerFunction({ cwd: "/srv/x", name: "x", hot: -1 })).rejects.toThrow("hot")
    await expect(registerFunction({ cwd: "/srv/x", name: "x", max: 1.5 })).rejects.toThrow("max")
    expect(calls).toHaveLength(0)
  })

  it("throws the daemon's error", async () => {
    stub(() => Response.json({ success: false, error: "name taken" }, { status: 409 }))
    await expect(registerFunction({ cwd: "/srv/x", name: "x" })).rejects.toThrow("name taken")
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
