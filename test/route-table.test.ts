// Every route the control server matches must be in ROUTE_TABLE (daemon.ts):
// the guard denies anything that isn't, so a new route without a class would
// be unreachable, and a class is a decision someone should make on purpose.
// Reads daemon.ts as text: importing it would start the daemon.
import { describe, expect, it } from "bun:test"
import { classifyRoute, type RouteClass, type RouteRule } from "../portal-auth.ts"

const source = await Bun.file(new URL("../daemon.ts", import.meta.url)).text()

const parseTable = (): RouteRule[] => {
  const begin = source.indexOf("// route-table:begin")
  const end = source.indexOf("// route-table:end")
  if (begin < 0 || end < begin) throw new Error("route-table markers not found in daemon.ts")
  const rules: RouteRule[] = []
  for (const line of source.slice(begin, end).split("\n")) {
    const m = line.match(/^\s*\["([A-Z]+|\*)", "([^"]+)", "(public|user|superuser)"\],\s*$/)
    if (m) rules.push([m[1], m[2], m[3] as RouteClass])
    else if (/^\s*\[/.test(line)) throw new Error(`unparsable route-table line: ${line}`)
  }
  return rules
}

/** The body of a top-level function or object, from its declaration to the matching closing line. */
const section = (start: string, end: string): string => {
  const a = source.indexOf(start)
  const b = source.indexOf(end, a)
  if (a < 0 || b < 0) throw new Error(`section ${start} not found`)
  return source.slice(a, b)
}

// The router: the control server's fetch, the functions API and the page server.
// handlePublicMcp is left out on purpose: it serves its own host and never reaches these.
const routerSource = [
  section("async function controlFetch(", "\n}\n"),
  section("const handleFnApi = async", "\n}\n"),
  section("async function serveSitePage(", "\n}\n"),
].join("\n")

interface Literal { method: string | null; kind: "exact" | "prefix"; path: string; line: string }

const extractLiterals = (text: string): Literal[] => {
  const found: Literal[] = []
  for (const line of text.split("\n")) {
    const method = line.match(/req\.method === ["']([A-Z]+)["']/)?.[1] ?? null
    for (const m of line.matchAll(/(?:url\.pathname|\broute) === ["'](\/[^"']*)["']/g)) found.push({ method, kind: "exact", path: m[1], line: line.trim() })
    for (const m of line.matchAll(/(?:url\.pathname|\broute)\.startsWith\(["'](\/[^"']*)["']\)/g)) found.push({ method, kind: "prefix", path: m[1], line: line.trim() })
    // regex routes like /^\/process\/(start|stop|restart)\//
    for (const m of line.matchAll(/\/\^((?:\\\/[a-z-]+)+)\\\/\(([a-z|]+)\)\\\/\//g)) {
      const base = m[1].replace(/\\\//g, "/")
      for (const alt of m[2].split("|")) found.push({ method, kind: "prefix", path: `${base}/${alt}/`, line: line.trim() })
    }
  }
  return found
}

const table = parseTable()
const literals = extractLiterals(routerSource)
const METHODS = ["GET", "POST", "DELETE"]

describe("ROUTE_TABLE", () => {
  it("parses, with no duplicates", () => {
    expect(table.length).toBeGreaterThan(50)
    const keys = table.map(([m, p]) => `${m} ${p}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("finds the router's routes", () => {
    expect(literals.length).toBeGreaterThan(80)
    const paths = new Set(literals.map(l => l.path))
    for (const p of ["/configs", "/auth/login", "/fn/deploy", "/process/start/", "/oauth/consent", "/shutdown", "/"]) expect(paths.has(p)).toBe(true)
  })

  it("classifies every route the router matches", () => {
    const missing: string[] = []
    for (const lit of literals) {
      if (lit.kind === "exact") {
        const methods = lit.method ? [lit.method] : METHODS
        if (!methods.some(m => classifyRoute(table, m, lit.path))) missing.push(`${lit.method ?? "*"} ${lit.path}   (${lit.line})`)
      } else {
        // A prefix the router dispatches on: something below it must be classified
        const sample = `${lit.path}${lit.path.endsWith("/") ? "" : "/"}x`
        const methods = lit.method ? [lit.method] : METHODS
        const covered = methods.some(m => classifyRoute(table, m, sample))
          || table.some(([m, p]) => p.startsWith(lit.path) && (!lit.method || m === "*" || m === lit.method))
        if (!covered) missing.push(`${lit.method ?? "*"} ${lit.path}*   (${lit.line})`)
      }
    }
    expect(missing).toEqual([])
  })

  it("has no rule the router doesn't use", () => {
    const unused = table.filter(([m, p]) => !literals.some(l => {
      if (l.method && m !== "*" && l.method !== m) return false
      if (p.endsWith("/*")) return l.path.startsWith(p.slice(0, -1)) || p.slice(0, -1).startsWith(l.path)
      return l.kind === "exact" ? l.path === p : p.startsWith(l.path)
    }))
    expect(unused).toEqual([])
  })

  it("keeps daemon-wide settings superuser-only", () => {
    const su = (m: string, p: string) => classifyRoute(table, m, p)
    expect(su("POST", "/domains/config")).toBe("superuser")
    expect(su("POST", "/domains/mcp")).toBe("superuser")
    expect(su("GET", "/domains/mcp")).toBe("superuser")
    expect(su("POST", "/domains/mcp/revoke")).toBe("superuser")
    expect(su("POST", "/lan")).toBe("superuser")
    expect(su("GET", "/lan/adguard")).toBe("superuser")
    expect(su("POST", "/routes/serve")).toBe("superuser")
    expect(su("POST", "/shutdown")).toBe("superuser")
  })

  it("needs a login for the kill and tunnel shortcuts, and only GET shows, POST acts", () => {
    for (const p of ["/go/kill", "/go/portal"]) {
      expect(classifyRoute(table, "GET", p)).toBe("user")
      expect(classifyRoute(table, "POST", p)).toBe("user")
      expect(classifyRoute(table, "DELETE", p)).toBeNull()
    }
  })

  it("leaves only the login, discovery and secret exchange public", () => {
    const pub = table.filter(([, , c]) => c === "public").map(([m, p]) => `${m} ${p}`).sort()
    expect(pub).toEqual([
      "* /candy-auth/check", "GET /auth/users", "GET /candy/registry", "GET /favicon.svg", "GET /login",
      "POST /auth/login", "POST /auth/logout", "POST /candy-auth/login", "POST /candy/advertise", "POST /mcp/auth",
    ])
  })

  it("is enforced: the guard classifies with this table before any route runs", () => {
    const guard = source.indexOf("classifyRoute(ROUTE_TABLE, req.method, url.pathname)")
    expect(guard).toBeGreaterThan(0)
    const server = source.indexOf("async function controlFetch(")
    expect(guard).toBeGreaterThan(server)
    // every handler in the server body comes after the guard, except the exempt ones
    const body = section("async function controlFetch(", "\n}\n")
    const guardAt = body.indexOf("classifyRoute(ROUTE_TABLE")
    for (const lit of extractLiterals(body.slice(0, guardAt))) {
      expect(lit.path.startsWith("/candy-auth/") || lit.path.startsWith("/candy/")).toBe(true)
    }
  })
})
