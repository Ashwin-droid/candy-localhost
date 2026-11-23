// The portal (the React SPA in web/src: the dashboard, site pages, settings,
// ...) can do what the CLI (cli.ts) can, through the same daemon endpoints, and
// those endpoints are reachable from a portal login.
// Source-level checks: the SPA's source and the daemon are read as text
// (importing daemon.ts would start the daemon; web/src needs web/node_modules).
// What the pages render and send is tested by the web package (`cd web && bun test`).
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { classifyRoute, type RouteClass, type RouteRule } from "../portal-auth.ts"

const root = join(import.meta.dir, "..")
const read = (path: string) => Bun.file(join(root, path)).text()
// Every SPA source file (no tests): an endpoint is covered when any of them calls it
const portalPages: Record<string, string> = {}
for (const f of [...new Bun.Glob("web/src/**/*.{ts,tsx}").scanSync({ cwd: root })].sort()) {
  if (/\.test\.tsx?$/.test(f) || f.startsWith("web/src/test/") || f.endsWith(".d.ts")) continue
  portalPages[f] = await read(f)
}
const client = await read("web/src/api/client.ts")
const cli = await read("cli.ts")
const daemon = await read("daemon.ts")

/** From `start` to the brace that closes the block opened at the end of its line. */
const block = (text: string, start: string): string => {
  const a = text.indexOf(start)
  if (a < 0) throw new Error(`${start} not found`)
  const eol = text.indexOf("\n", a)
  const open = text.lastIndexOf("{", eol)
  if (open < a) throw new Error(`${start}: no block opens on its line`)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return text.slice(a, i + 1)
  }
  throw new Error(`${start}: no closing brace`)
}

const routeTable = (): RouteRule[] => {
  const src = daemon.slice(daemon.indexOf("// route-table:begin"), daemon.indexOf("// route-table:end"))
  const rules: RouteRule[] = []
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*\["([A-Z]+|\*)", "([^"]+)", "(public|user|superuser|app)"\],\s*$/)
    if (m) rules.push([m[1], m[2], m[3] as RouteClass])
    else if (/^\s*\[/.test(line)) throw new Error(`unparsable route-table line: ${line}`)
  }
  if (rules.length < 20) throw new Error("ROUTE_TABLE not found in daemon.ts")
  return rules
}
const table = routeTable()

// Every daemon path the CLI calls, from its literal call sites (template parts and queries dropped)
const cliEndpoints = (): string[] => {
  const found = new Set<string>()
  const add = (raw: string) => found.add(raw.replace(/\$\{[^}]*\}.*$/, "").replace(/\?.*$/, ""))
  for (const m of cli.matchAll(/\bapi(?:Get|Post|Delete)\(\s*['`](\/[^'`]*)['`]/g)) add(m[1])
  for (const m of cli.matchAll(/\bapiSuperuser\(\s*'[A-Z]+',\s*['`](\/[^'`]*)['`]/g)) add(m[1])
  for (const m of cli.matchAll(/\bfnApi\(\s*'[A-Z]+',\s*['`](\/[^'`]*)['`]/g)) add(m[1])
  for (const m of cli.matchAll(/fetch\(`\$\{API\}(\/[^`]*)`/g)) add(m[1])
  return [...found].sort()
}

// CLI endpoints no portal page calls, and why that's fine
const NOT_IN_PORTAL_PAGE: Record<string, string> = {
  "/auth/status": "the portal shows the same per binding from GET /domains",
}

const calls = (page: string, path: string): boolean =>
  page.includes(`'${path}`) || page.includes(`\`${path}`) || page.includes(`"${path}`) || page.includes(`\${API}${path}`)
const usedByPortal = (path: string): boolean => Object.values(portalPages).some(page => calls(page, path))

describe("CLI parity: every endpoint the CLI calls, the portal calls too", () => {
  const endpoints = cliEndpoints()

  it("reads the SPA's source", () => {
    expect(Object.keys(portalPages)).toEqual(expect.arrayContaining(["web/src/api/client.ts", "web/src/pages/sites/SitesPage.tsx", "web/src/pages/settings/PasskeysPage.tsx"]))
  })

  it("finds the CLI's endpoints", () => {
    // A sanity floor, so a changed call style doesn't make the next test vacuous
    expect(endpoints.length).toBeGreaterThan(30)
    for (const p of ["/fn/add", "/fn/kv", "/fn/d1", "/config/env", "/config/sandbox", "/routes/entry", "/app-auth/rotate", "/app-auth/drop", "/auth/token"]) {
      expect(endpoints).toContain(p)
    }
  })

  for (const path of cliEndpoints()) {
    it(`${path}`, () => {
      if (NOT_IN_PORTAL_PAGE[path]) return
      expect(usedByPortal(path)).toBe(true)
    })
  }
})

describe("the endpoints the new portal controls use are open to a portal login", () => {
  // class "user" = a portal login or an API key; "superuser" = a superuser's portal login only
  const userRoutes: [string, string][] = [
    ["POST", "/fn/add"], ["POST", "/fn/kv"], ["POST", "/fn/d1"],
    ["POST", "/config"], ["POST", "/config/env"], ["POST", "/config/sandbox"],
    ["GET", "/routes/entry"], ["POST", "/routes/entry"],
    ["GET", "/app-auth/sites"], ["POST", "/app-auth/rotate"], ["POST", "/app-auth/drop"], ["GET", "/app-auth/consents"], ["POST", "/app-auth/consents/revoke"],
    ["POST", "/auth/token"],
  ]
  for (const [method, path] of userRoutes) {
    it(`${method} ${path} is a user route`, () => {
      expect(classifyRoute(table, method, path)).toBe("user")
    })
  }

  it("the SPA's pages are app routes: a static page that needs no login and holds no token", () => {
    for (const path of ["/", "/settings", "/passkeys", "/sites/x", "/settings/daemon"]) expect(classifyRoute(table, "GET", path)).toBe("app")
    // The old server-rendered pages are gone from the shell list
    expect(daemon).toContain('const PORTAL_PAGES = new Set(["/oauth/consent", "/go/kill", "/go/portal", "/app-auth/consent"])')
    // Its page token comes from POST /portal/boot (user, with the session secret), never the page
    expect(classifyRoute(table, "POST", "/portal/boot")).toBe("user")
  })

  it("state-changing calls carry the page token (CSRF) and roll it; GETs don't use it up", () => {
    // web/src/api/client.ts: every POST/DELETE is a mutate() on a token chain; GETs and streams send no token
    expect(client).toContain('if (init.token) h.set("X-Candy-Token", init.token)')
    expect(client).toContain("let res = await send(method, path, { body, token: chain.token, o })")
    expect(client).toContain('const res = await send("POST", "/token", { body: { token: chain.token } })')
    expect(client).toContain('const res = await send("GET", path, { query, o })')
    expect(client).toContain('const res = await send("GET", path, { query, o: { signal: o.signal }, accept: "text/event-stream" })')
    // None of these is a tokenless route
    const tokenless = daemon.match(/const TOKENLESS_ROUTES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ""
    for (const [, path] of userRoutes) expect(tokenless).not.toContain(`"${path}"`)
    for (const path of ["/app-auth/drop", "/app-auth/rotate", "/passkeys/delete", "/domains/config", "/lan/adguard", "/auth/reauth"]) {
      expect(tokenless).not.toContain(`"${path}"`)
    }
  })

  it("a login that ended goes to the login page", () => {
    expect(client).toContain('const isLoginRequired = (res: Response) => res.status === 401 && res.headers.has("X-Candy-Login")')
    expect(client).toContain('deps.location.assign("/login?next=" + encodeURIComponent(l.pathname + l.search + l.hash))')
    expect(client).toContain("if (isLoginRequired(res)) return toLogin<T>()")
  })
})

describe("add a function (candy fn add)", () => {
  it("the Add site dialog posts /fn/add with the CLI's fields", async () => {
    const dialog = await read("web/src/pages/site/AddSiteDialog.tsx")
    const add = block(dialog, "export function addRequest(")
    expect(add).toContain('return { path: "/fn/add", body }')
    expect(add).toContain("const body: Record<string, unknown> = { name, cwd: f.cwd.trim(), ...user }")
    expect(add).toContain("if (f.entry.trim()) body.entry = f.entry.trim()")
    expect(add).toContain('for (const k of ["hot", "max", "linger"] as const)')
    expect(add).toContain("if (f.envFile.trim()) body.envFile = f.envFile.trim()")
    // A number field left empty means the daemon's default, so it isn't sent
    expect(add).toContain('v.trim() === "" ? {} :')
  })

  it("the daemon's /fn/add reads exactly those fields", () => {
    const handler = block(daemon, "if (req.method === 'POST' && route === '/fn/add')")
    for (const field of ["body.cwd", "body.entry", "body.envFile", "body.user", "body.linger", "['hot', 'max']"]) {
      expect(handler).toContain(field)
    }
  })

  it("UI text names the function config candy.json, not candy.fn.json or wrangler", () => {
    for (const [f, text] of Object.entries(portalPages)) {
      expect([f, /candy\.fn\.json|wrangler/i.test(text)]).toEqual([f, false])
    }
  })
})

describe("function data: KV and D1 (candy fn kv / d1)", () => {
  it("KV and D1 go to /fn/kv and /fn/d1 with the CLI's ops; rows are keyed by index, never by key text", async () => {
    const data = await read("web/src/pages/site/DataTab.tsx")
    expect(data).toContain('getApi().post<T>("/fn/kv", { name, binding, ...body })')
    for (const op of ['op: "list"', 'op: "get", key: k.name', 'op: "delete", key', 'op: "put", key, value: s.putValue']) expect(data).toContain(op)
    expect(data).toContain('getApi().post<D1Response>("/fn/d1", { name, binding, sql: q, ...(params ? { params } : {}) })')
    expect(data).toContain("table rows are keyed by their index in the loaded list, never by key text")
  })

  it("values from the API are never parsed as HTML anywhere in the SPA", () => {
    const sink = /dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b/
    expect(Object.entries(portalPages).filter(([, t]) => sink.test(t)).map(([f]) => f)).toEqual([])
  })
})

describe("the passkeys page stays a URL (the enroll popup goes back to /passkeys)", () => {
  it("/passkeys is an SPA route and the candy host's page links to it", async () => {
    expect(classifyRoute(table, "GET", "/passkeys")).toBe("app")
    expect(portalPages["web/src/routes.tsx"]).toContain('{ pattern: "/passkeys",')
    expect(await read("public/passkey-host.html")).toContain("portalUrl('/passkeys')")
    expect(await read("app-auth-routes.ts")).toContain('next: "/passkeys"')
  })
})
