import { describe, expect, it } from "bun:test"
import {
  fnLaunchArgs, fnLaunchEnv, fnLimits, fnRequestHeaders, fnSocketPath, fnTargetForRequest, fnToolCommand,
  normalizeFnSettings, pinnedBun,
} from "../fn-daemon.ts"

describe("normalizeFnSettings", () => {
  it("keeps valid fields and drops bad optional ones", () => {
    expect(normalizeFnSettings({ entry: "src/index.ts", deploy: "20260101120000-0123abcd", hot: 1, max: 4, linger: 0, log: "meta" }))
      .toEqual({ entry: "src/index.ts", deploy: "20260101120000-0123abcd", hot: 1, max: 4, linger: 0, log: "meta" })
    expect(normalizeFnSettings({ entry: "a.ts", deploy: "../x", hot: -1, max: 0, linger: 601, log: "yes" })).toEqual({ entry: "a.ts" })
    expect(normalizeFnSettings({ entry: "a.ts", hot: 65, max: 1.5 })).toEqual({ entry: "a.ts" })
  })

  it("refuses an unusable entry", () => {
    for (const raw of [null, "x", {}, { entry: "" }, { entry: 1 }, { entry: "a\nb.ts" }, { entry: "x".repeat(1025) }]) {
      expect(normalizeFnSettings(raw)).toBe(null)
    }
  })

  it("clamps hot to max", () => {
    expect(fnLimits({ hot: 9, max: 2 })).toEqual({ hot: 2, max: 2 })
    expect(fnLimits({})).toEqual({ hot: 0, max: 4 })
  })
})

describe("fnSocketPath", () => {
  const dir = "/run/candy/fn"

  it("uses the name when it fits and a hash in h/ when it doesn't", () => {
    expect(fnSocketPath(dir, "hello")).toBe("/run/candy/fn/hello.sock")
    const long = "a".repeat(100)
    expect(fnSocketPath(dir, long)).toMatch(/^\/run\/candy\/fn\/h\/[0-9a-f]{24}\.sock$/)
    expect(fnSocketPath(dir, long).length).toBeLessThan(108)
  })

  it("can't be taken over by naming a function after another's hash", () => {
    const long = "alice-" + "x".repeat(100)
    const hashed = fnSocketPath(dir, long)
    const hash = hashed.split("/").pop()!.replace(/\.sock$/, "")
    expect(fnSocketPath(dir, hash)).not.toBe(hashed)
  })
})

describe("fnRequestHeaders", () => {
  const src = () => new Headers({
    host: "f.localhost", connection: "keep-alive", "transfer-encoding": "chunked", upgrade: "h2c",
    "x-candy-verified": "1", "x-candy-token": "t", cookie: "candy_session=s; other=1", authorization: "Basic dTpw", "x-app": "keep",
  })

  it("drops hop-by-hop headers and candy's verification marker", () => {
    const h = fnRequestHeaders(src(), { stripCredentials: false })
    for (const k of ["connection", "transfer-encoding", "upgrade", "x-candy-verified"]) expect(h.has(k)).toBe(false)
    expect(h.get("x-app")).toBe("keep")
    // No password on the domain: the app's own auth headers pass through
    expect(h.get("authorization")).toBe("Basic dTpw")
  })

  it("strips the visitor's candy credentials on a protected domain", () => {
    const h = fnRequestHeaders(src(), { stripCredentials: true })
    expect(h.has("authorization")).toBe(false)
    expect(h.has("x-candy-verified")).toBe(false)
    expect(h.get("x-app")).toBe("keep")
  })
})

describe("fnTargetForRequest", () => {
  const binding = { fqdn: "api.example.com" }
  const look = {
    binding: (host: string) => host === "api.example.com" ? { serverName: "api", binding } : host === "site.example.com" ? { serverName: "site", binding } : null,
    localName: (host: string) => host.replace(/\.(localhost|candy)$/, ""),
    isFn: (name: string) => name === "api" || name === "hello",
  }

  it("sends every path on a function host to the function, daemon API paths included", () => {
    for (const path of ["/", "/fn/requests", "/process/stop/hello", "/configs"]) {
      expect(fnTargetForRequest("hello.localhost", path, look)).toEqual({ name: "hello", binding: null })
    }
    expect(fnTargetForRequest("HELLO.candy:443", "/fn/tail", look)).toEqual({ name: "hello", binding: null })
  })

  it("keeps a bound domain's login pages for candy and carries the binding", () => {
    expect(fnTargetForRequest("api.example.com", "/fn/requests", look)).toEqual({ name: "api", binding })
    expect(fnTargetForRequest("api.example.com", "/candy-auth/login", look)).toBe(null)
  })

  it("leaves other hosts alone", () => {
    expect(fnTargetForRequest("portal.localhost", "/fn/requests", look)).toBe(null)
    expect(fnTargetForRequest("site.example.com", "/", look)).toBe(null)
    expect(fnTargetForRequest("localhost", "/", look)).toBe(null)
    expect(fnTargetForRequest("", "/", look)).toBe(null)
  })
})

describe("function launch composition", () => {
  it("runs the shim from the module dir with argv only", () => {
    expect(fnLaunchArgs({ bun: "bun", moduleDir: "/usr/lib/candy", entry: "/home/u/f/index.ts" }))
      .toEqual(["bun", "/usr/lib/candy/fn-host.ts", "/home/u/f/index.ts"])
    expect(fnLaunchArgs({ bun: "bun", moduleDir: "/usr/lib/candy", entry: "w.js", cronArgs: ["--scheduled", "*/5 * * * *"] }))
      .toEqual(["bun", "/usr/lib/candy/fn-host.ts", "w.js", "--scheduled", "*/5 * * * *"])
  })

  it("passes the CANDY_FN_* env", () => {
    const env = fnLaunchEnv({
      stateDir: "/var/lib/candy/f", project: { main: "index.ts" }, secretKeys: ["A", "B"], lingerS: 5,
      instance: { id: "f-1", token: "tok", socketPath: "/run/candy/fn/f.sock" },
    })
    expect(env).toEqual({
      CANDY_FN_STATE: "/var/lib/candy/f",
      CANDY_FN_CONFIG: JSON.stringify({ main: "index.ts" }),
      CANDY_FN_SECRET_KEYS: "A,B",
      CANDY_FN_LINGER_MS: "5000",
      CANDY_FN_SOCKET: "/run/candy/fn/f.sock",
      CANDY_FN_TOKEN: "tok",
      CANDY_FN_INSTANCE: "f-1",
    })
    // Cron runs have no socket; linger defaults to 30s
    const cron = fnLaunchEnv({ stateDir: "/s", project: {}, secretKeys: [] })
    expect(cron.CANDY_FN_LINGER_MS).toBe("30000")
    expect("CANDY_FN_SOCKET" in cron).toBe(false)
  })

  it("runs fn-tool as the user with a clean env and a fixed bun", () => {
    const cmd = fnToolCommand({ account: { uid: 1001, gid: 1001, name: "bob", home: "/home/bob" }, bun: "/opt/bun/bin/bun", moduleDir: "/usr/lib/candy", op: "deploys" })
    expect(cmd.slice(0, 5)).toEqual(["setpriv", "--reuid=1001", "--regid=1001", "--init-groups", "--"])
    expect(cmd).toContain("env")
    expect(cmd).toContain("-i")
    expect(cmd).toContain("PATH=/usr/local/bin:/usr/bin:/bin")
    expect(cmd.slice(-3)).toEqual(["/opt/bun/bin/bun", "/usr/lib/candy/fn-tool.ts", "deploys"])
    expect(() => fnToolCommand({ account: { uid: 0, gid: 0, name: "root", home: "/root" }, bun: "bun", moduleDir: "/x", op: "config" })).toThrow("root")
  })

  it("pins a bun outside users' homes", () => {
    const exists = (p: string) => p !== "/usr/bin/bun"
    expect(pinnedBun("/opt/bun/bin/bun", ["/usr/local/bin/bun"], exists)).toBe("/opt/bun/bin/bun")
    expect(pinnedBun("/home/alice/.bun/bin/bun", ["/usr/bin/bun", "/usr/local/bin/bun"], exists)).toBe("/usr/local/bin/bun")
    expect(pinnedBun("/root/.bun/bin/bun", [], exists)).toBe(null)
  })
})
