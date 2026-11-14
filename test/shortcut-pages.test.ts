// The kill/tunnel shortcuts, the site-host pages and the CLI's superuser
// refusals. daemon.ts is read as text: importing it would start the daemon.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const daemon = await Bun.file(join(root, "daemon.ts")).text()
const page = (name: string) => Bun.file(join(root, "public", name)).text()

/** From `start` to the brace that closes the block opened on its line. */
const block = (text: string, start: string): string => {
  const a = text.indexOf(start)
  if (a < 0) throw new Error(`${start} not found`)
  let depth = 0
  for (let i = text.indexOf("{", a); i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return text.slice(a, i + 1)
  }
  throw new Error(`${start} never closes`)
}

describe("shortcut hosts (<name>.k / <name>.p)", () => {
  const sitePage = block(daemon, "async function serveSitePage(")
  const shortcutHandler = block(daemon, 'if (url.pathname === "/go/kill" || url.pathname === "/go/portal") {')

  it("only redirect to the portal from the site host, never act", () => {
    const redirect = block(sitePage, "if (shortcutHost && (")
    expect(redirect).toContain("shortcutConfirmUrl(")
    expect(redirect).toContain("status: 302")
    for (const act of ["stopProcess(", "openPortalForName(", "cloudflared", "spawn("]) expect(sitePage).not.toContain(act)
  })

  it("stop and open a tunnel only inside the POST branches", () => {
    const posts = [...shortcutHandler.matchAll(/if \(isPost\) \{/g)].map(m => block(shortcutHandler.slice(m.index!), "if (isPost) {"))
    expect(posts.length).toBe(1)
    expect(posts[0]).toContain("stopProcess(")
    expect(shortcutHandler.split("stopProcess(").length).toBe(2)
    // The tunnel opens after the GET branch has returned the confirmation page
    const getReturn = shortcutHandler.indexOf('if (!isPost) return shortcutPage("confirm-action.html"')
    const open = shortcutHandler.indexOf("openPortalForName(")
    expect(getReturn).toBeGreaterThan(0)
    expect(open).toBeGreaterThan(getReturn)
    expect(shortcutHandler.split("openPortalForName(").length).toBe(2)
  })

  it("are for the site's user or a superuser, from a portal login", () => {
    expect(shortcutHandler).toContain('if (!portalHost || auth?.via !== "portal")')
    const check = shortcutHandler.indexOf("if (!mayUse(name))")
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(shortcutHandler.indexOf("stopProcess("))
    expect(check).toBeLessThan(shortcutHandler.indexOf("openPortalForName("))
  })

  it("run after the guard, which holds POSTs to the page's Origin and token", () => {
    const guard = daemon.indexOf("classifyRoute(ROUTE_TABLE, req.method, url.pathname)")
    const tokenCheck = daemon.indexOf("pageTokens.consume(req.headers.get(\"X-Candy-Token\"), auth.sessionId)")
    const handler = daemon.indexOf('if (url.pathname === "/go/kill" || url.pathname === "/go/portal")')
    expect(guard).toBeGreaterThan(0)
    expect(tokenCheck).toBeGreaterThan(guard)
    expect(handler).toBeGreaterThan(tokenCheck)
    expect(daemon).not.toMatch(/TOKENLESS_ROUTES = new Set\([^)]*\/go\//)
  })

  it("confirm with a button that POSTs the page token, and nothing on load", async () => {
    const html = await page("confirm-action.html")
    expect(html.match(/fetch\(/g)?.length).toBe(1)
    const click = html.indexOf("goBtn.addEventListener('click'")
    expect(click).toBeGreaterThan(0)
    expect(html.indexOf("fetch(")).toBeGreaterThan(click)
    expect(html).toContain("method: 'POST'")
    expect(html).toContain("'X-Candy-Token': window.CANDY_TOKEN")
  })

  it("show the result in the kill and tunnel pages, named for the site", async () => {
    expect(await page("killed.html")).toContain("vars.serviceHost || getServiceHost()")
    expect(await page("portaling.html")).toContain("vars.serviceHost || _host")
  })
})

describe("site-host pages", () => {
  it("send registering to the portal instead of posting from the site host", async () => {
    const html = await page("candy.html")
    expect(html).not.toContain("/register")
    expect(html).not.toContain("apiCall(")
    expect(html).toContain("/?add=${encodeURIComponent(siteName)}")
  })

  for (const name of ["starting.html", "crashed.html"]) {
    it(`${name} links terminal input to the portal and keeps its own site actions`, async () => {
      const html = await page(name)
      expect(html).not.toContain("/process/input/")
      expect(html).not.toContain("addEventListener('keydown'")
      expect(html).toContain("/?logs=${encodeURIComponent(serverName)}")
      expect(html).toContain("/stream/${serverName}")
      for (const allowed of html.match(/apiCall\(`[^`]+`/g) ?? []) {
        expect(allowed).toMatch(/^apiCall\(`\/process\/(start|restart|port)\/\$\{serverName\}`$/)
      }
    })
  }

  it("the portal opens those links", async () => {
    const html = await page("portal.html")
    expect(html).toContain("deepLink.get('add')")
    expect(html).toContain("deepLink.get('logs')")
  })
})

describe("superuser settings", () => {
  it("the portal has forms for the zone and AdGuard Home, for superusers only", async () => {
    const html = await page("portal.html")
    for (const id of ["zone-domain", "zone-tunnel", "zone-tunnel-id", "zone-credentials", "adguard-url", "adguard-username", "adguard-password", "adguard-client", "adguard-dns"]) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('<section id="settings-card" hidden>')
    expect(block(html, "async function refreshSettings()")).toContain("if (!SUPER) return")
    expect(html).toContain("apiCall('/domains/config'")
    expect(html).toContain("apiCall('/lan/adguard'")
  })
})

describe("superuser step-up in the portal (a sudoer's passkey login)", () => {
  it("gets superuserNeedsPassword and superuserUntil in the portal's CANDY_VARS and /auth/me", () => {
    const portalVars = daemon.slice(daemon.indexOf('const rawHtml = await Bun.file(import.meta.dir + "/public/portal.html")'))
    expect(portalVars.slice(0, 400)).toContain("superuserNeedsPassword: auth!.superuserNeedsPassword === true, superuserUntil: superuserUntil(auth!)")
    const me = block(daemon, 'if (req.method === "GET" && url.pathname === "/auth/me") {')
    expect(me).toContain("superuserNeedsPassword:")
    expect(me).toContain("superuserUntil: superuserUntil(auth!)")
    // The guard's superuser refusal carries the flag the portal's prompt keys on
    expect(daemon).toContain("verdict.status === 403 && verdict.superuserNeedsPassword ? { superuserNeedsPassword: true } : {}")
  })

  it("shows an Unlock superuser button by the user's name, only when the daemon says so", async () => {
    const html = await page("portal.html")
    expect(html.slice(html.indexOf('<div class="who"'), html.indexOf('<div class="top-actions">'))).toContain('id="who-unlock" hidden onclick="unlockSuperuser()"')
    expect(html).toContain("document.getElementById('who-unlock').hidden = !ME.superuserNeedsPassword;")
    const apply = block(html, "function applyAuth(me) {")
    expect(apply).toContain("document.getElementById('who-unlock').hidden = !ME.superuserNeedsPassword;")
    expect(apply).toContain("document.getElementById('who-su').hidden = !SUPER;")
    expect(apply).toContain("if (was !== SUPER) refreshAll();")
    // SUPER changes without a reload
    expect(html).toContain("let SUPER = !!ME.superuser;")
    expect(html).not.toContain("const SUPER")
  })

  it("asks for the password in a dialog and POSTs it to /auth/reauth with the page token, never keeping it", async () => {
    const html = await page("portal.html")
    for (const id of ["unlock-modal", "unlock-form", "unlock-password", "unlock-msg", "unlock-go"]) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('id="unlock-password" class="input-field" autocomplete="current-password" required')
    const submit = block(html, "async function submitUnlock(e) {")
    expect(submit).toContain("fetch(API + '/auth/reauth'")
    expect(submit).toContain("'X-Candy-Token': currentToken")
    expect(submit).toContain("JSON.stringify({ password })")
    // Cleared before the request goes out, whatever comes back; the next token fetched either way
    expect(submit.indexOf("pw.value = '';")).toBeLessThan(submit.indexOf("fetch(API + '/auth/reauth'"))
    expect(submit.indexOf("await refreshToken();")).toBeGreaterThan(submit.indexOf("fetch(API + '/auth/reauth'"))
    // Success re-reads /auth/me; failures show the daemon's words (wrong password, slowed, busy)
    expect(submit).toContain("await refreshMe();")
    expect(submit).toContain("msg.textContent = data.error ||")
    expect(submit).toContain("data.retryAfter")
    expect(block(html, "function closeUnlock(ok) {")).toContain("document.getElementById('unlock-password').value = '';")
    expect(html).not.toMatch(/(localStorage|sessionStorage)\.setItem\([^)]*password/i)
  })

  it("reads /auth/me again when the hour runs out, so the button comes back", async () => {
    const html = await page("portal.html")
    expect(block(html, "async function refreshMe() {")).toContain("fetch(API + '/auth/me'")
    expect(block(html, "function applyAuth(me) {")).toContain("setTimeout(refreshMe, Math.max(0, ME.superuserUntil - Date.now()) + 1000)")
  })

  it("offers the prompt when a superuser route refuses a passkey login, then tries once more", async () => {
    const html = await page("portal.html")
    // (block() would stop at the `{}` default)
    const api = html.slice(html.indexOf("async function apiCall(endpoint, options = {}) {"), html.indexOf("// ---------- Superuser step-up"))
    const branch = api.slice(api.indexOf("} else if (res.status === 403) {"))
    expect(branch).toContain("body.superuserNeedsPassword")
    expect(branch).toContain("await askSuperuserPassword(true)")
    expect(branch).toContain("const retry = await fetch(API + endpoint, { ...options, headers });")
    // Background GETs (polling) never pop the dialog
    expect(branch).toContain("method !== 'GET' && method !== 'HEAD'")
  })
})

describe("CLI on a superuser-only setting", () => {
  let server: ReturnType<typeof Bun.serve>
  let dir: string
  const seen: string[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "candy-cli-su-"))
    writeFileSync(join(dir, "secret"), "test-secret\n")
    // A stand-in daemon: accepts the secret, refuses every setting like the guard does for an API key
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        seen.push(`${req.method} ${url.pathname}`)
        if (url.pathname === "/mcp/auth") return Response.json({ apiKey: "k", user: "alice" })
        return Response.json({ error: "Only a superuser, logged in to the portal, can do that." }, { status: 403 })
      },
    })
  })
  afterAll(() => {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  })

  const run = async (...args: string[]) => {
    const p = Bun.spawn(["bun", join(root, "cli.ts"), ...args], {
      env: { ...process.env, CANDY_API_URL: `http://127.0.0.1:${server.port}`, CANDY_SECRET_FILE: join(dir, "secret"), HOME: dir, NO_COLOR: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    })
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code, out, err }
  }

  it("says to use the portal", async () => {
    for (const args of [["domain", "config", "--zone", "example.com"], ["lan", "adguard", "status"], ["lan", "adguard", "off"]]) {
      const r = await run(...args)
      expect(r.err).toContain("superuser only: use the portal while logged in as a sudoer")
      expect(r.code).toBe(1)
    }
  })

  it("refuses adguard setup before asking for a password", async () => {
    seen.length = 0
    const r = await run("lan", "adguard", "setup", "--url", "http://127.0.0.1:3000", "--user", "u", "--client", "lan")
    expect(r.err).toContain("superuser only: use the portal while logged in as a sudoer")
    expect(r.out).not.toContain("Password")
    expect(r.code).toBe(1)
    expect(seen.filter(s => s.startsWith("POST /lan/adguard"))).toEqual([])
  })
})
