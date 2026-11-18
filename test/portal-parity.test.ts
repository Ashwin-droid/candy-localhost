// The portal (public/portal*.html: the dashboard, the settings page, ...) can do
// what the CLI (cli.ts) can, through the same daemon endpoints, and those
// endpoints are reachable from a portal login.
// Source-level checks: the page and the daemon are read as text (importing
// daemon.ts would start the daemon).
import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { classifyRoute, type RouteClass, type RouteRule } from "../portal-auth.ts"

const root = join(import.meta.dir, "..")
const read = (path: string) => Bun.file(join(root, path)).text()
const portal = await read("public/portal.html")
const settings = await read("public/portal-settings.html")
const passkeysPage = await read("public/portal-passkeys.html")
// Every portal page: an endpoint is covered when any of them calls it
const portalPages: Record<string, string> = {}
for (const f of [...new Bun.Glob("public/portal*.html").scanSync({ cwd: root })].sort()) portalPages[f] = await read(f)
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

// CLI endpoints no portal page calls, and why that's fine
const NOT_IN_PORTAL_PAGE: Record<string, string> = {
  "/auth/status": "the portal shows the same per binding from GET /domains",
}

const calls = (page: string, path: string): boolean =>
  page.includes(`'${path}`) || page.includes(`\`${path}`) || page.includes(`"${path}`) || page.includes(`\${API}${path}`)
const usedByPortal = (path: string): boolean => Object.values(portalPages).some(page => calls(page, path))

describe("CLI parity: every endpoint the CLI calls, the portal calls too", () => {
  const endpoints = cliEndpoints()

  it("reads every portal page", () => {
    expect(Object.keys(portalPages)).toEqual(expect.arrayContaining(["public/portal.html", "public/portal-settings.html", "public/portal-passkeys.html"]))
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
    ["GET", "/settings"],
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
    // The settings page: every change goes through send(), which sends the page token and rolls it
    const send = block(settings, "function send(")
    expect(send).toContain("'X-Candy-Token': token")
    expect(send).toContain("await refreshToken()")
    expect(block(settings, "async function act(")).toContain("await send(path, body, method)")
    expect(settings).toContain("const post = (path, body) => send(path, body, 'POST')")
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
  it("posts /auth/token for the binding, from the settings page", () => {
    expect(block(settings, "async function mintTestToken(")).toContain("act('/auth/token', { domain: fqdn, ttl: 600 })")
    expect(block(settings, "function bindingItem(")).toContain("linkBtn('Token', () => mintTestToken(fqdn)")
  })
})

describe("Sign in with candy (candy app-auth), on the settings page", () => {
  it("lists keys and approvals, rotates and revokes through the CLI's endpoints", () => {
    const load = block(settings, "async function loadSignIn(")
    expect(load).toContain("get('/app-auth/sites')")
    expect(load).toContain("get('/app-auth/consents')")
    expect(block(settings, "async function rotateKey(")).toContain("act('/app-auth/rotate', { name: s.site })")
    expect(block(settings, "async function revokeConsent(")).toContain("act('/app-auth/consents/revoke', { site: c.site })")
  })

  it("revoke (candy app-auth drop) posts { name } to /app-auth/drop, only after a confirm that says what it does", () => {
    const revoke = block(settings, "async function revokeKey(")
    expect(revoke).toContain("act('/app-auth/drop', { name: s.site })")
    const ask = revoke.indexOf("if (!confirm(text)) return")
    expect(ask).toBeGreaterThan(0)
    expect(ask).toBeLessThan(revoke.indexOf("act('/app-auth/drop'"))
    for (const said of ["The key and everyone’s approvals", "gets a new key the next time it starts", "keeps the old key in memory until it restarts"]) {
      expect(revoke).toContain(said)
    }
    // The answer's restartNeeded is named
    expect(revoke).toContain("restartText(data.restartNeeded)")
    expect(settings).toContain("? ` Restart ${names.join(', ')}: a running server keeps the old key in memory until then.`")
  })

  it("a key whose site doesn't ask for sign-in says so, offers Revoke, and no Rotate", () => {
    const render = block(settings, "function renderKeys(")
    expect(render).toContain("s.enabled")
    expect(render).toContain("text: 'Not asked for'")
    expect(render).toContain("if (s.enabled) {")
    expect(render.indexOf("smallBtn('Rotate'")).toBeGreaterThan(render.indexOf("if (s.enabled) {"))
    expect(render).toContain("smallBtn('Revoke', () => revokeKey(s, rev)")
  })

  it("rows hold the API's objects, never a name inside an onclick", () => {
    expect(block(settings, "function renderKeys(")).not.toContain("onclick=")
    expect(block(settings, "function renderConsents(")).not.toContain("onclick=")
  })
})

describe("the page scripts", () => {
  const scriptsOf = (page: string) => [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  for (const [name, page] of [["portal.html", portal], ["portal-settings.html", settings]] as const) {
    it(`${name} parses`, () => {
      const scripts = scriptsOf(page)
      expect(scripts.length).toBeGreaterThan(0)
      for (const s of scripts) expect(() => new Function(s)).not.toThrow()
    })

    it(`${name}: every element it looks up by a fixed id exists`, () => {
      const ids = new Set([...page.matchAll(/\sid="([^"$]+)"/g)].map(m => m[1]))
      const used = [...new Set([...page.matchAll(/(?:getElementById|\$)\('([^'$]+)'\)/g)].map(m => m[1]))]
      expect(used.length).toBeGreaterThan(5)
      expect(used.filter(id => !ids.has(id))).toEqual([])
    })
  }
})

describe("the settings page (GET /settings, portal-settings.html)", () => {
  it("is the page the daemon's /settings route renders, with a page token and the login's vars", async () => {
    const routes = await read("app-auth-routes.ts")
    const page = block(routes, "const settingsPage = async (")
    expect(page).toContain('htmlPage("portal-settings.html", d.pageTokens.mint(auth.sessionId!)')
    expect(page).toContain("user: auth.user, superuser: auth.superuser, candyHost: d.candyHost(), pamUntil: pamUntil(auth)")
    // htmlPage puts the vars in front of the first <script>: the page has exactly one, and nothing before it says <script>
    expect(settings.split("<script>").length).toBe(2)
    expect(settings).toContain("const vars = window.CANDY_VARS || {};")
    expect(settings).toContain("let token = window.CANDY_TOKEN || '';")
    expect(settings).toContain("const SUPER = vars.superuser === true;")
  })

  it("a navigation gets the shell; a state change needs the page token; GETs don't use it up", () => {
    expect(daemon).toMatch(/const PORTAL_PAGES = new Set\(\[[^\]]*"\/settings"/)
    const tokenless = daemon.match(/const TOKENLESS_ROUTES = new Set\(\[([^\]]*)\]\)/)?.[1] ?? ""
    for (const path of ["/app-auth/drop", "/app-auth/rotate", "/passkeys/delete", "/domains/config", "/lan/adguard", "/auth/reauth"]) {
      expect(tokenless).not.toContain(`"${path}"`)
    }
    // A GET sends no token (only POST/DELETE consume one), so loads can run side by side
    expect(block(settings, "async function get(")).not.toContain("X-Candy-Token")
  })

  it("a login that ended goes to the login page", () => {
    expect(block(settings, "function send(")).toContain("res.status === 401 && res.headers.get('X-Candy-Login')")
    expect(block(settings, "async function get(")).toContain("toLogin()")
    expect(settings).toContain("location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search)")
  })

  it("has a section for each moved part, in the in-page nav", () => {
    for (const id of ["account", "passkeys", "signin", "domains", "daemon"]) {
      expect(settings).toContain(`id="${id}"`)
      expect(settings).toContain(`href="#${id}"`)
    }
    // Daemon-wide settings: superusers only
    expect(settings).toContain(`<section class="sheet" id="daemon" hidden>`)
    expect(settings).toContain("$('daemon').hidden = !SUPER;")
    for (const f of ["async function loadMcp(", "async function loadAdguard(", "function fillZoneForm("]) {
      expect(block(settings, f)).toContain("if (!SUPER) return")
    }
  })

  it("passkeys: list, add (enroll popup on the candy host), rename, delete, with a recent password", () => {
    expect(block(settings, "async function loadPasskeys(")).toContain("get('/passkeys/list')")
    expect(block(settings, "async function startEnroll(")).toContain("post('/passkeys/enroll/start', { name })")
    expect(block(settings, "function renamePasskey(")).toContain("act('/passkeys/rename', { id: p.id, name })")
    expect(block(settings, "async function deletePasskey(")).toContain("withRecentPassword(() => post('/passkeys/delete', { id: p.id }))")
    expect(settings).toContain("post('/auth/reauth', { password: $('reauthPassword').value })")
    // Messages only from our candy host, only from the popup this page opened
    expect(settings).toContain("e.origin !== candyOrigin")
    expect(settings).toContain("e.source !== popup")
    expect(settings).toContain("if (target.origin !== candyOrigin)")
    expect(settings).not.toContain("navigator.credentials.create")
    expect(settings).toContain("Passkeys need a bound domain")
  })

  it("the passkeys page stays (the enroll popup goes back to /passkeys)", async () => {
    expect(passkeysPage).toContain("'/passkeys/enroll/start'")
    expect(await read("public/passkey-host.html")).toContain("portalUrl('/passkeys')")
  })

  it("public domains: list, unbind, password, JWT, test token, allowlist", () => {
    expect(block(settings, "async function loadDomains(")).toContain("get('/domains')")
    expect(block(settings, "async function unbindDomain(")).toContain("'/domains/unbind/' + encodeURIComponent(subdomain)")
    expect(block(settings, "async function unbindDomain(")).toContain("'DELETE'")
    expect(block(settings, "function setDomainPassword(")).toContain("act('/auth/set', { domain: fqdn, password: v.password })")
    expect(block(settings, "async function clearProtection(")).toContain("'/auth/clear', { domain: fqdn, which }")
    expect(block(settings, "async function newJwtSecret(")).toContain("act('/auth/set', { domain: fqdn, jwtSecret: 'generate' })")
    expect(block(settings, "function editAllowlist(")).toContain("act('/domains/allowlist', { domain: fqdn, ips, enabled: ips.length > 0 })")
    expect(block(settings, "async function allowEveryone(")).toContain("'/domains/allowlist', { domain: fqdn, ips: [], enabled: false }")
    // Binding picks a site: the dashboard's dialog, opened by a link
    expect(settings).toContain(`href="/?bind"`)
    expect(portal).toContain("const bindLink = deepLink.has('bind');")
    expect(portal).toContain("if (domainZone) showBindDomain(bindName || '');")
  })

  it("daemon: Cloudflare zone, public MCP, AdGuard Home (the fields of the CLI)", () => {
    for (const id of ["zone-domain", "zone-tunnel", "zone-tunnel-id", "zone-credentials", "adguard-url", "adguard-username", "adguard-password", "adguard-client", "adguard-dns"]) {
      expect(settings).toContain(`id="${id}"`)
    }
    expect(settings).toContain("act('/domains/config', body)")
    expect(block(settings, "async function loadMcp(")).toContain("get('/domains/mcp')")
    expect(block(settings, "async function setPublicMcp(")).toContain("act('/domains/mcp', { enabled })")
    expect(block(settings, "async function revokePublicMcp(")).toContain("act('/domains/mcp/revoke', {})")
    expect(block(settings, "async function loadAdguard(")).toContain("get('/lan/adguard')")
    expect(settings).toContain("act('/lan/adguard', body)")
    expect(settings).toContain("act('/lan/adguard', { remove: true })")
  })

  it("account: who you are, and log out", () => {
    expect(settings).toContain("$('me').textContent = ME;")
    expect(block(settings, "async function loadMe(")).toContain("get('/auth/me')")
    expect(settings).toContain("fetch('/auth/logout'")
    expect(settings).toContain("localStorage.removeItem('candy_session')")
  })

  it("values from the API are never parsed as HTML", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) expect(settings).not.toContain(sink)
    const el = block(settings, "function el(")
    expect(el).toContain("n.textContent = String(v ?? '')")
    expect(el).toContain("n.append(kid)")
    // No attribute is set from a string of markup; links to a binding are https:// plus its name
    expect(settings).toContain("href: 'https://' + fqdn")
  })

  it("loads nothing external but the fonts every portal page uses", () => {
    expect(settings.replace(/href="https:\/\/fonts\.(googleapis|gstatic)\.com[^"]*"/g, "")).not.toMatch(/(src|href)="https?:/)
    expect(settings).not.toContain("@import")
  })

  it("works at phone width", () => {
    expect(settings).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1.0">`)
    expect(settings).toMatch(/@media \(max-width: 560px\)/)
  })

  it("calls the config file candy.json", () => {
    expect(settings).toContain("candy.json")
    expect(settings).not.toContain("candy.fn.json")
    expect(settings).not.toMatch(/wrangler/i)
  })
})

describe("the dashboard's side rail is short and links to Settings", () => {
  const rail = portal.slice(portal.indexOf('<aside class="rail">'), portal.indexOf("</aside>"))

  it("keeps Activity and a link to the settings page; the settings moved out", () => {
    expect(rail).toContain(`href="/settings"`)
    expect(rail).toContain(`id="activity-list"`)
    for (const gone of ["domains-list", "appauth-list", "settings-list", "bind-domain-btn"]) expect(portal).not.toContain(`id="${gone}"`)
    expect(rail.match(/<section/g)?.length).toBe(2)
  })

  it("the top bar links to Settings instead of the passkeys page", () => {
    const top = portal.slice(portal.indexOf('<header class="top">'), portal.indexOf("</header>"))
    expect(top).toContain(`href="/settings"`)
    expect(top).not.toContain(`href="/passkeys"`)
  })

  it("no moved feature is left behind on the dashboard", () => {
    for (const path of ["/app-auth/sites", "/app-auth/rotate", "/app-auth/consents", "/domains/config", "/lan/adguard", "/domains/mcp", "/domains/allowlist", "/auth/clear", "/auth/set", "/auth/token", "/domains/unbind"]) {
      expect(calls(portal, path)).toBe(false)
      expect(calls(settings, path)).toBe(true)
    }
    // Binding a site stays with the sites (its menu), and the record warning stays escaped
    expect(portal).toContain("apiCall('/domains/bind'")
    expect(portal).toContain("menuItem('Bind public domain…', `showBindDomain('${js}')`)")
  })
})

describe("site rows: candy.json and dependencies", () => {
  const row = block(portal, "function siteRow(")
  it("shows Sign-in, Published, Needs and Kept up by, and the file's error, escaped", () => {
    expect(row).toContain("const manifest = s.config?.manifest;")
    expect(row).toContain(">Sign-in</span>")
    expect(row).toContain(">Published</span>")
    expect(row).toContain("Needs: ${escapeHtml(needs.join(', '))}")
    expect(row).toContain("Kept up by: ${escapeHtml(heldBy.join(', '))}")
    expect(row).toContain("candy.json: ${escapeHtml(manifest.error)}")
    expect(row).toContain("const heldBy = Array.isArray(s.proc?.heldBy) ? s.proc.heldBy : [];")
  })
})
