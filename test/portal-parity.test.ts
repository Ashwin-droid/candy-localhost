// The portal (public/portal.html) can do what the CLI (cli.ts) can, through the
// same daemon endpoints, and those endpoints are reachable from a portal login.
// Source-level checks: the page and the daemon are read as text (importing
// daemon.ts would start the daemon).
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { classifyRoute, type RouteClass, type RouteRule } from "../portal-auth.ts"

const root = join(import.meta.dir, "..")
const read = (path: string) => Bun.file(join(root, path)).text()
const portal = await read("public/portal.html")
const passkeysPage = await read("public/portal-passkeys.html")
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
    const m = line.match(/^\s*\["([A-Z]+|\*)", "([^"]+)", "(public|user|superuser)"\],\s*$/)
    if (m) rules.push([m[1], m[2], m[3] as RouteClass])
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

// CLI endpoints with no call in portal.html, and why that's fine
const NOT_IN_PORTAL_PAGE: Record<string, string> = {
  "/auth/status": "the portal shows the same per binding from GET /domains",
  "/passkeys/list": "the portal's Passkeys page (portal-passkeys.html) lists them",
}

const usedByPortal = (path: string): boolean =>
  portal.includes(`'${path}`) || portal.includes(`\`${path}`) || portal.includes(`"${path}`) || portal.includes(`\${API}${path}`)

describe("CLI parity: every endpoint the CLI calls, the portal calls too", () => {
  const endpoints = cliEndpoints()

  it("finds the CLI's endpoints", () => {
    // A sanity floor, so a changed call style doesn't make the next test vacuous
    expect(endpoints.length).toBeGreaterThan(30)
    for (const p of ["/fn/add", "/fn/kv", "/fn/d1", "/config/env", "/config/sandbox", "/routes/entry", "/app-auth/rotate", "/auth/token"]) {
      expect(endpoints).toContain(p)
    }
  })

  for (const path of cliEndpoints()) {
    it(`${path}`, () => {
      if (NOT_IN_PORTAL_PAGE[path]) {
        if (path === "/passkeys/list") expect(passkeysPage).toContain("/passkeys/list")
        return
      }
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
    ["GET", "/app-auth/sites"], ["POST", "/app-auth/rotate"], ["GET", "/app-auth/consents"], ["POST", "/app-auth/consents/revoke"],
    ["POST", "/auth/token"],
  ]
  for (const [method, path] of userRoutes) {
    it(`${method} ${path} is a user route`, () => {
      expect(classifyRoute(table, method, path)).toBe("user")
    })
  }

  it("state-changing calls carry the page token (CSRF), through apiCall", () => {
    expect(block(portal, "async function apiCall(")).toContain("'X-Candy-Token': currentToken")
    expect(block(portal, "async function fnPost(")).toContain("apiCall(path, {")
    expect(block(portal, "async function postJSON(")).toContain("apiCall(path, {")
    // None of these is a tokenless route
    const tokenless = daemon.match(/const TOKENLESS_ROUTES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ""
    for (const [, path] of userRoutes) expect(tokenless).not.toContain(`"${path}"`)
  })
})

describe("add a function (candy fn add)", () => {
  const submit = block(portal, "async function submitAddFn(")
  const handler = block(daemon, "if (req.method === 'POST' && route === '/fn/add')")

  it("the form is a tab of Add site and submits to submitAddFn", () => {
    expect(portal).toContain(`<form id="add-fn-form" onsubmit="submitAddFn(event)" hidden>`)
    expect(portal).toContain(`onclick="setAddMode('fn')">Function</button>`)
    expect(portal).toContain("fn: ['add-fn-form', 'fn-add-name']")
    for (const id of ["fn-add-name", "fn-add-cwd", "fn-add-entry", "fn-add-hot", "fn-add-max", "fn-add-linger", "fn-add-env", "fn-user"]) {
      expect(portal).toContain(`id="${id}"`)
    }
  })

  it("posts to /fn/add with the CLI's fields", () => {
    expect(submit).toContain("fnPost('/fn/add', body)")
    expect(submit).toContain("const body = { name, cwd: val('fn-add-cwd') }")
    expect(submit).toContain("body.entry = val('fn-add-entry')")
    expect(submit).toMatch(/\['hot', 'fn-add-hot'.*\['max', 'fn-add-max'.*\['linger', 'fn-add-linger'/)
    expect(submit).toContain("body[key] = n")
    expect(submit).toContain("body.envFile = envFile")
    expect(submit).toContain("if (user) body.user = user")
    // A number field left empty means the daemon's default, so it isn't sent
    expect(submit).toContain("if (text === '') continue")
  })

  it("the daemon's /fn/add reads exactly those fields", () => {
    for (const field of ["body.cwd", "body.entry", "body.envFile", "body.user", "body.linger", "['hot', 'max']"]) {
      expect(handler).toContain(field)
    }
  })

  it("UI text names the function config candy.json, not candy.fn.json or wrangler", () => {
    expect(portal).toContain("The folder with its candy.json")
    expect(portal).not.toContain("candy.fn.json")
    expect(portal).not.toMatch(/wrangler/i)
  })
})

describe("function data: KV and D1 (candy fn kv / d1)", () => {
  it("KV list, get, put and delete go to /fn/kv with the CLI's ops", () => {
    expect(block(portal, "async function fnKvList(")).toContain("op: 'list'")
    expect(block(portal, "async function fnKvGet(")).toContain("fnPost('/fn/kv', { name, binding: k.binding, op: 'get', key: k.name })")
    expect(block(portal, "async function fnKvPut(")).toContain("fnPost('/fn/kv', { name, binding, op: 'put', key, value })")
    expect(block(portal, "async function fnKvDelete(")).toContain("fnPost('/fn/kv', { name, binding: k.binding, op: 'delete', key: k.name })")
  })

  it("D1 sends sql and params (a JSON list) to /fn/d1", () => {
    const run = block(portal, "async function fnD1Run(")
    expect(run).toContain("const body = { name, binding, sql }")
    expect(run).toContain("body.params = params")
    expect(run).toContain("fnPost('/fn/d1', body)")
  })

  it("a KV key never goes into an onclick: rows point at the list by index", () => {
    const list = block(portal, "async function fnKvList(")
    expect(list).toContain(`onclick="fnKvGet(\${i})"`)
    expect(list).toContain(`onclick="fnKvDelete(\${i})"`)
    expect(list).not.toContain("escapeJsSingle(k.name)")
  })

  it("keys, values, metadata, columns and cells are escaped", () => {
    const list = block(portal, "async function fnKvList(")
    expect(list).toContain("${escapeHtml(k.name)}")
    expect(list).toContain("escapeHtml(JSON.stringify(k.metadata))")
    expect(list).not.toMatch(/\$\{k\.name\}/)
    expect(block(portal, "async function fnKvGet(")).toContain("${escapeHtml(fnState.kvValue.value)}")
    const run = block(portal, "async function fnD1Run(")
    expect(run).toContain("<th>${escapeHtml(c)}</th>")
    expect(run).toContain("fnD1Cell(r?.[c])")
  })

  it("fnD1Cell escapes what a database row holds", () => {
    const escapeHtml = block(portal, "function escapeHtml(")
    const cell = block(portal, "function fnD1Cell(")
    const fnD1Cell = new Function(`${escapeHtml}\n${cell}\nreturn fnD1Cell`)() as (v: unknown) => string
    const evil = `<img src=x onerror="alert(1)">'`
    const out = fnD1Cell(evil)
    expect(out).not.toContain("<img")
    expect(out).not.toContain(`"alert`)
    expect(out).toContain("&lt;img")
    expect(fnD1Cell({ a: "<b>" })).not.toContain("<b>")
    expect(fnD1Cell(null)).toContain("NULL")
  })

  it("the Data tab is hidden for an assets-only function", () => {
    expect(block(portal, "function showFn(")).toContain("document.getElementById('fn-tab-data').hidden = assetsOnly")
    expect(block(portal, "function setFnTab(")).toContain("if (tab === 'data' && fnState.assetsOnly) tab = 'overview'")
  })
})

describe("site settings the CLI had and the portal lacked", () => {
  it("env file (candy env) posts /config/env, an empty value removes it", () => {
    const f = block(portal, "function setEnvFile(")
    expect(f).toContain("postJSON('/config/env', { name, envFile: path || null })")
  })

  it("writable folders (candy sandbox --rw) post the whole list to /config/sandbox", () => {
    const f = block(portal, "function setWritable(")
    expect(f).toContain("postJSON('/config/sandbox', { name, rw })")
    // The daemon takes rw as the full list (addRw/removeRw are the CLI's edits of it)
    expect(block(daemon, 'if (req.method === "POST" && url.pathname === "/config/sandbox")')).toContain("let rw = body.rw ? clean(body.rw)")
  })

  it("local port (candy route entry) posts /routes/entry and reads GET /routes/entry", () => {
    expect(block(portal, "function setEntryPort(")).toContain("postJSON('/routes/entry', { name, port })")
    expect(block(portal, "async function refreshRoutes(")).toContain("getJSON('/routes/entry')")
  })

  it("API mode can be chosen when adding a command (candy dev --api)", () => {
    expect(portal).toContain(`id="config-api"`)
    expect(block(portal, "async function submitAddConfig(")).toContain("if (api) body.api = true")
  })

  it("the menu offers them, with names escaped for the onclick", () => {
    const row = block(portal, "function siteRow(")
    expect(row).toContain("menuItem('Env file…', `setEnvFile('${js}')`)")
    expect(row).toContain("menuItem('Writable folders…', `setWritable('${js}')`)")
    expect(row).toContain("`setEntryPort('${js}')`")
    expect(row).toContain("const js = escapeJsSingle(name)")
    expect(row).toContain("escapeHtml(s.config.envFile)")
    expect(row).toContain("escapeHtml(rw.join(', '))")
  })
})

describe("bound domains: a test token (candy auth token)", () => {
  it("posts /auth/token for the binding", () => {
    expect(block(portal, "async function mintTestToken(")).toContain("postJSON('/auth/token', { domain: fqdn, ttl: 600 })")
    expect(portal).toContain("act('Token', `mintTestToken('${fqdn}')`)")
  })
})

describe("Sign in with candy (candy app-auth)", () => {
  it("lists keys and approvals, rotates and revokes through the CLI's endpoints", () => {
    const load = block(portal, "async function refreshAppAuth(")
    expect(load).toContain("getJSON('/app-auth/sites')")
    expect(load).toContain("getJSON('/app-auth/consents')")
    expect(block(portal, "async function rotateAppKey(")).toContain("postJSON('/app-auth/rotate', { name: s.site })")
    expect(block(portal, "async function revokeAppConsent(")).toContain("postJSON('/app-auth/consents/revoke', { site: c.site })")
  })

  it("everything from the API is escaped, and no site name goes into an onclick", () => {
    const render = block(portal, "function renderAppAuth(")
    for (const s of ["escapeHtml(s.site)", "escapeHtml(s.kid)", "escapeHtml(s.owner)", "escapeHtml(c.site)", "escapeHtml(c.owner)"]) {
      expect(render).toContain(s)
    }
    expect(render).not.toMatch(/\$\{(s|c)\.(site|kid|owner)\}/)
    expect(render).toContain(`onclick="rotateAppKey(\${i})"`)
    expect(render).toContain(`onclick="revokeAppConsent(\${i})"`)
  })
})

describe("the page script", () => {
  it("parses", () => {
    const scripts = [...portal.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })

  it("every element it looks up by a fixed id exists", () => {
    const ids = new Set([...portal.matchAll(/\sid="([^"$]+)"/g)].map(m => m[1]))
    const used = [...new Set([...portal.matchAll(/getElementById\('([^'$]+)'\)/g)].map(m => m[1]))]
    expect(used.filter(id => !ids.has(id))).toEqual([])
  })
})
