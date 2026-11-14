// Regression tests for the portal-login security review (findings 1-16),
// and its re-verification (R1-R9 at the end).
// Pure modules are tested directly; daemon.ts is read as text, since
// importing it would start the daemon.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attemptLogin, auditActor, auditSafe, cachedList, clientIp, isPortalOrigin, LoginSlots, PageTokens, safeNext, sameOrigin,
  SiteTokens, SoftLockout, LOGIN_BUSY, LOGIN_FAILED, LOGIN_FAILURE_FLOOR_MS, MAX_CHAINS_PER_SESSION, MAX_PAM_IN_FLIGHT, SOFT_DELAY_CAP_MS,
  type LoginDeps, type RequestAuth,
} from "../portal-auth.ts"
import {
  coalesced, caddyGlobalBlock, checkBindings, cloudflaredYaml, dedupeSiteAddresses, isCaddyUpstream, isDnsLabel, isZoneName, loopbackBind, lowerName,
  mergeLowerCase, newNameProblem, stripProxyHeaders, tagDaemonUpstreams, LOG_REDACTED_REQUEST_HEADERS, LOG_REDACTED_RESPONSE_HEADERS,
  PROXY_TAG_HEADER, SYSTEM_BLOCK_MARK,
} from "../caddy-config.ts"
import { fnRequestHeaders } from "../fn-daemon.ts"

const root = join(import.meta.dir, "..")
const daemon = await Bun.file(join(root, "daemon.ts")).text()
const apiMode = await Bun.file(join(root, "api-mode.ts")).text()
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

const caddy = Bun.which("caddy")
/** `caddy adapt` on a Caddyfile: the JSON config, or throws with Caddy's error. Offline, no admin API. */
const adapt = (caddyfile: string): any => {
  const dir = mkdtempSync(join(tmpdir(), "candy-adapt-"))
  try {
    const f = join(dir, "Caddyfile")
    writeFileSync(f, caddyfile)
    const r = Bun.spawnSync([caddy!, "adapt", "--config", f, "--adapter", "caddyfile"], { stderr: "pipe", env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir } })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return JSON.parse(r.stdout.toString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const isPortal = (h: string) => h === "portal.localhost" || h === "portal.candy"

// ----------------------------------------------------------------------------
// 1. Cookie theft through another port on portal.localhost
// ----------------------------------------------------------------------------

describe("1. the portal cookie alone never authenticates", () => {
  it("only exact portal origins count (https, default port)", () => {
    expect(isPortalOrigin("https://portal.localhost", isPortal)).toBe(true)
    expect(isPortalOrigin("https://portal.candy", isPortal)).toBe(true)
    for (const o of ["http://portal.localhost:5555", "https://portal.localhost:5555", "http://portal.localhost", "https://portal.localhost:9999",
      "https://evil.localhost", "https://x@portal.localhost", "null", "", null]) {
      expect(isPortalOrigin(o, isPortal)).toBe(false)
    }
  })

  it("sameOrigin refuses another port on the portal's host (the reviewer's probe)", () => {
    const h = (o: Record<string, string>) => new Headers(o)
    expect(sameOrigin(h({ host: "portal.localhost", origin: "http://portal.localhost:5555" }), isPortal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost:9999", origin: "http://portal.localhost" }), isPortal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost", referer: "http://portal.localhost:5555/x" }), isPortal)).toBe(false)
    expect(sameOrigin(h({ host: "portal.localhost", origin: "https://portal.localhost" }), isPortal)).toBe(true)
  })

  it("requestAuth needs the cookie and the X-Candy-Session header", () => {
    const fn = block(daemon, "const requestAuth = async")
    expect(fn).toContain('portalSessions.get(readSessionCookie(req.headers.get("cookie")), req.headers.get(SESSION_HEADER))')
    // every other session lookup also takes the header
    const lookups = daemon.split("\n").filter(l => l.includes("portalSessions.get("))
    expect(lookups.length).toBeGreaterThanOrEqual(3)
    for (const l of lookups) expect(l).toContain("req.headers.get(SESSION_HEADER)")
  })

  it("the portal host check refuses unexpected ports", () => {
    const fn = block(daemon, "const isPortalHost = (host")
    expect(fn).toMatch(/port !== undefined && port !== "443"\) return false/)
  })

  it("portal pages are a token-free shell on navigation; the real page needs the header", async () => {
    const shell = await page("portal-shell.html")
    expect(shell).not.toContain("CANDY_TOKEN")
    expect(shell).toContain("X-Candy-Session")
    expect(shell).toContain("/login?next=")
    const control = block(daemon, "async function controlFetch(")
    const shellAt = control.indexOf("PORTAL_PAGES.has(url.pathname) && !req.headers.get(SESSION_HEADER)")
    const guardAt = control.indexOf("auth = await requestAuth(req)")
    expect(shellAt).toBeGreaterThan(0)
    expect(shellAt).toBeLessThan(guardAt)
    expect(daemon).toContain('const PORTAL_PAGES = new Set(["/", "/oauth/consent", "/go/kill", "/go/portal"])')
  })

  it("every page token goes out with the session fetch patch, and only after the guard", () => {
    const tokenScripts = daemon.match(/window\.CANDY_TOKEN=\$\{JSON\.stringify\(\w+\)\}/g) ?? []
    // portalPageScript (portal) and serveSitePage's site pages (no session: site token or null)
    expect(tokenScripts.length).toBe(2)
    expect(block(daemon, "async function shortcutPage(")).toContain("portalPageScript(token, vars)")
    expect(block(daemon, 'if (req.method === "GET" && url.pathname === "/oauth/consent")')).toContain("portalPageScript(pageTokens.mint(")
    expect(daemon).toContain("const SESSION_FETCH_PATCH")
  })

  it("the login hands the secret to the page, which keeps it in this origin's storage", async () => {
    expect(block(daemon, 'if (req.method === "POST" && url.pathname === "/auth/login")')).toContain("session: secret")
    const login = await page("portal-login.html")
    expect(login).toContain("localStorage.setItem('candy_session'")
    expect(await page("portal.html")).toContain("localStorage.removeItem('candy_session')")
  })

  it("the portal reads logs over a fetch stream (EventSource can't send the header)", async () => {
    const portal = await page("portal.html")
    expect(portal).not.toContain("new EventSource")
    expect(portal).toContain("readLogStream")
  })

  it("CORS answers only exact portal origins", () => {
    const fn = block(daemon, "const getCorsHeaders = (origin")
    expect(fn).toContain("isPortalOrigin(origin, isPortalHost)")
    expect(fn).not.toMatch(/localhost\(:\\d\+\)\?/)
  })
})

// ----------------------------------------------------------------------------
// 2. Caddy's admin API
// ----------------------------------------------------------------------------

describe("2. Caddy's admin API is a 0600 unix socket", () => {
  it("the global block moves admin off localhost:2019", () => {
    const g = caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/root/.config/caddy/access.log" })
    expect(g).toContain("admin unix//run/candy/caddy-admin.sock|0600")
    expect(() => caddyGlobalBlock({ adminSocket: "/run/x y.sock", accessLog: "/a" })).toThrow()
  })

  it.skipIf(!caddy)("caddy adapt accepts it and listens nowhere else", () => {
    const cfg = adapt(caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/tmp/access.log" }) + "\na.localhost {\n  respond 1\n}\n")
    expect(cfg.admin.listen).toBe("unix//run/candy/caddy-admin.sock|0600")
  })

  it("the daemon talks to the socket, never to :2019 (beyond stopping a pre-socket Caddy once)", () => {
    expect(daemon).toContain('"/run/candy/caddy-admin.sock"')
    expect(daemon).toContain('caddyAdmin("/load"')
    expect(daemon).toContain('caddyAdmin("/stop"')
    expect(daemon).toContain('caddyAdmin("/config/"')
    const at2019 = [...daemon.matchAll(/fetch\("http:\/\/[^"]*:2019([^"]*)"/g)].map(m => m[1])
    expect(at2019.sort()).toEqual(["/config/", "/stop"])
    expect(block(daemon, "const startCaddy = async")).toContain("umask 077")
    expect(daemon).toContain("const secureCaddyAdminSocket")
  })
})

// ----------------------------------------------------------------------------
// 3. Caddyfile injection
// ----------------------------------------------------------------------------

describe("3. nothing unchecked reaches the Caddyfile or cloudflared's YAML", () => {
  const inject = ["x {\n}\n:8088 {\n  root * /\n  file_server browse\n}\nhttp://y", "a b", "A", "-a", "a-", "a.b", "x".repeat(64), "", "a\nb", "a#b"]

  it("subdomains are one lower-case DNS label", () => {
    expect(isDnsLabel("shop")).toBe(true)
    expect(isDnsLabel("a1-b2")).toBe(true)
    for (const bad of inject) expect(isDnsLabel(bad)).toBe(false)
  })

  it("bindings are re-checked: bad ones are dropped with a reason", () => {
    const ok = { subdomain: "shop", fqdn: "shop.example.com", serverName: "shop" }
    const { kept, dropped } = checkBindings({
      shop: ok,
      [inject[0]]: { subdomain: inject[0], fqdn: `${inject[0]}.example.com`, serverName: "x" },
      Upper: { subdomain: "Upper", fqdn: "Upper.example.com", serverName: "x" },
      wrong: { subdomain: "wrong", fqdn: "wrong.evil.com", serverName: "x" },
      name: { subdomain: "name", fqdn: "name.example.com", serverName: "x {" },
      allow: { subdomain: "allow", fqdn: "allow.example.com", serverName: "x", allowlist: { enabled: true, ips: ["1.2.3.4 }"] } },
    }, "example.com", n => /^[a-z0-9]+$/.test(n))
    expect(Object.keys(kept)).toEqual(["shop"])
    expect(dropped.length).toBe(5)
    expect(checkBindings({ shop: ok }, "example.com\n:80 {", () => true).dropped.length).toBe(1)
  })

  it("upstreams, zones and the tunnel config are strict", () => {
    for (const ok of ["localhost:3000", "https://api.example.com", "http://10.0.0.5:8080", "https://[2001:db8::1]:8443"]) expect(isCaddyUpstream(ok)).toBe(true)
    for (const bad of ["localhost:99999", "https://a.com/path {", "http://a.com\nfile_server", "ftp://a.com", "a.com", "https://a b", "https://[::1]:8443"]) expect(isCaddyUpstream(bad)).toBe(false)
    // Link-local, including the cloud metadata address
    for (const bad of ["http://169.254.169.254", "http://169.254.0.1:80", "http://[fe80::1]:8080"]) expect(isCaddyUpstream(bad)).toBe(false)
    expect(isZoneName("example.com")).toBe(true)
    expect(isZoneName("example.com {")).toBe(false)
    expect(cloudflaredYaml({ id: "not-a-uuid\ningress:", credentialsFile: "/etc/c.json" }, [])).toBeNull()
    expect(cloudflaredYaml({ id: "6ff42ae2-765d-4adf-8112-31c55c1551ef", credentialsFile: "/etc/c.json\n- x" }, [])).toBeNull()
    const yaml = cloudflaredYaml({ id: "6ff42ae2-765d-4adf-8112-31c55c1551ef", credentialsFile: "/root/.cloudflared/x.json" }, ["shop.example.com", "evil.com\n  - service: http://localhost:2019"])!
    expect(yaml).toContain("hostname: shop.example.com")
    expect(yaml).not.toContain("2019")
  })

  it("POST /domains/bind validates and lowercases the subdomain before using it", () => {
    const bind = block(daemon, 'if (req.method === "POST" && url.pathname === "/domains/bind")')
    const lower = bind.indexOf("body.subdomain.trim().toLowerCase()")
    const check = bind.indexOf("if (!isDnsLabel(subdomain))")
    expect(lower).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(lower)
    expect(check).toBeLessThan(bind.indexOf("cloudflared tunnel route dns"))
    expect(block(daemon, "const loadDomainConfig = async")).toContain("dropInvalidBindings()")
    expect(block(daemon, "const dropInvalidBindings = ")).toContain("auditLog('DOMAIN_BINDING_DROPPED'")
    expect(block(daemon, "const syncCloudflaredIngress = async")).toContain("cloudflaredYaml(")
    const sync = block(daemon, "const syncCaddyNow = async")
    expect(sync).toContain("Object.values(safeBindings())")
    expect(sync).toContain("okUpstream(name, proxyTarget)")
    expect(sync).toContain("isQuickTunnelUrl(url)")
    const config = block(daemon, 'if (req.method === "POST" && url.pathname === "/domains/config")')
    for (const check of ["isZoneName(", "isZoneId(", "isTunnelId(", "isTunnelName(", "isCredentialsPath("]) expect(config).toContain(check)
    expect(block(daemon, 'if (req.method === "POST" && url.pathname === "/register")')).toContain("isCaddyUpstream(body.target, ownAddresses())")
  })

  it.skipIf(!caddy)("the reviewer's injected subdomain can't produce a file_server site", () => {
    // The old code wrote `http://${fqdn} {`; with the check in front, an injected value never gets there
    const { kept } = checkBindings({ [inject[0]]: { subdomain: inject[0], fqdn: `${inject[0]}.example.com`, serverName: "x" } }, "example.com", () => true)
    expect(Object.keys(kept)).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// 4. Audit-log wipe and forgery
// ----------------------------------------------------------------------------

describe("4. no name maps to the daemon's logs, and audit lines can't be forged", () => {
  // Names are lower case only, so SAFE_NAME has no /i flag
  const safeName = new RegExp(daemon.match(/const SAFE_NAME = \/(.+)\/\n/)![1])
  const isSafeName = (n: string) => n.length > 0 && n.length <= 128 && safeName.test(n)

  it("names can't start with _ or .", () => {
    for (const bad of ["_audit", "_caddy", "_dns", ".audit", "..", "~audit", "a/../_audit"]) expect(isSafeName(bad)).toBe(false)
    for (const ok of ["app", "my_app", "a.b", "a-1", "x9"]) expect(isSafeName(ok)).toBe(true)
  })

  it("the audit log lives outside the per-name namespace, with no _caddy symlink", () => {
    expect(daemon).toContain("const AUDIT_LOG = `${LOGS_DIR}/daemon/audit.log`")
    expect(daemon).not.toContain("_caddy.log")
    expect(daemon).not.toMatch(/_audit\.log/)
  })

  it("mayReadLog and /stream check the file a name maps to", () => {
    const logFileFor = daemon.slice(daemon.indexOf("const logFileFor = (name"), daemon.indexOf("// Clear logs for a process"))
    expect(logFileFor).toContain("if (!isSafeName(name)) return null")
    expect(logFileFor).toContain("file === `${LOGS_DIR}/${name}.log`")
    expect(block(daemon, "const mayReadLog = (name")).toContain("logFileFor(name)")
    expect(block(daemon, 'if (req.method === "GET" && url.pathname.startsWith("/stream/"))')).toContain("logFileFor(name)!.file")
  })

  it("audit fields are one line each, and commands are quoted", () => {
    expect(auditSafe("ok\n[2026-01-01T00:00:00Z] [System] AUTH_LOGIN: root")).not.toContain("\n")
    expect(auditSafe("a\r\u0000 b")).toBe("a\\u000d\\u0000\\u2028b")
    const fn = block(daemon, "const auditLog = async")
    expect(fn).toContain("${auditSafe(actor)}] ${auditSafe(action)}: ${auditSafe(details)}")
    expect(daemon).toContain("auditLog('CONFIG_ADD', `${name}: ${JSON.stringify(cmd)}")
    expect(daemon).toContain("${JSON.stringify(config.cmd)}")
  })
})

// ----------------------------------------------------------------------------
// 5. Concurrency and the lockout
// ----------------------------------------------------------------------------

const raceDeps = (over: Partial<LoginDeps> = {}) => {
  const fails = new Map<string, number>()
  const seen: number[] = []
  let pamCalls = 0
  let inPam = 0
  const deps: LoginDeps = {
    pamReady: () => true,
    loginUsers: async () => ["ashwin", ...Array.from({ length: 50 }, (_, i) => `u${i}`)],
    verifyPassword: async () => {
      pamCalls++
      inPam++
      seen.push(inPam)
      await Bun.sleep(30)
      inPam--
      return { ok: false, reason: "denied" }
    },
    isSuperuser: async () => false,
    blocked: async k => ({ blocked: (fails.get(k) ?? 0) >= 3, retryAfter: 3600 }),
    fail: async k => { fails.set(k, (fails.get(k) ?? 0) + 1); return { retryAfter: 0 } },
    clear: async () => {},
    audit: () => {},
    serverError: () => {},
    now: () => Date.now(),
    sleep: async () => {},
    ...over,
  }
  return { deps, fails, seen, calls: () => pamCalls }
}

describe("5. parallel guesses can't outrun the lockout, and PAM helpers are bounded", () => {
  it("500 parallel attempts on one user reach PAM a bounded number of times (the reviewer's race)", async () => {
    const env = raceDeps()
    await Promise.all(Array.from({ length: 500 }, (_, i) => attemptLogin(env.deps, { user: "ashwin", password: "g" + i, ip: "10.0.0." + (i % 250) })))
    expect(env.calls()).toBeLessThanOrEqual(3)
  })

  it(`never runs more than ${MAX_PAM_IN_FLIGHT} PAM helpers at once, whoever asks`, async () => {
    const env = raceDeps()
    await Promise.all(Array.from({ length: 200 }, (_, i) => attemptLogin(env.deps, { user: `u${i % 50}`, password: "x", ip: `10.1.${i}.1` })))
    expect(Math.max(...env.seen)).toBeLessThanOrEqual(MAX_PAM_IN_FLIGHT)
  })

  it("counts the attempt before PAM answers, and refunds it when PAM gives no verdict", async () => {
    const counted: number[] = []
    const env = raceDeps()
    env.deps.verifyPassword = async () => { counted.push(env.fails.get("portal:ip:10.9.9.9") ?? 0); return { ok: false, reason: "timeout" } }
    let refunded = 0
    env.deps.refund = async k => { refunded++; env.fails.set(k, (env.fails.get(k) ?? 1) - 1) }
    await attemptLogin(env.deps, { user: "ashwin", password: "x", ip: "10.9.9.9" })
    expect(counted).toEqual([1])
    expect(refunded).toBe(1)
    expect(env.fails.get("portal:ip:10.9.9.9")).toBe(0)
  })

  it("a busy slot says busy (never 'wrong password'), checks nothing and counts nothing", async () => {
    let t = 0
    const slots = new LoginSlots()
    const hold = slots.acquire("ashwin", "1.1.1.1")!
    const env = raceDeps({ slots, now: () => t, sleep: async ms => { t += ms } })
    const out = await attemptLogin(env.deps, { user: "ashwin", password: "x", ip: "2.2.2.2" })
    expect(out).toEqual({ ok: false, status: 429, body: { error: LOGIN_BUSY } })
    expect(env.calls()).toBe(0)
    expect(env.fails.get("portal:ip:2.2.2.2") ?? 0).toBe(0)
    hold()
    expect(slots.inFlight).toBe(0)
  })

  it("LoginSlots: one per user and per address, a global cap, release is idempotent", () => {
    const s = new LoginSlots(2)
    const a = s.acquire("Alice", "1.1.1.1")!
    expect(s.acquire("alice", "9.9.9.9")).toBeNull()
    expect(s.acquire("bob", "1.1.1.1")).toBeNull()
    const b = s.acquire("bob", "2.2.2.2")!
    expect(s.acquire("carol", "3.3.3.3")).toBeNull()
    a(); a()
    expect(s.inFlight).toBe(1)
    expect(s.acquire("carol", "3.3.3.3")).not.toBeNull()
    b()
  })
})

// ----------------------------------------------------------------------------
// 6. siteAction
// ----------------------------------------------------------------------------

describe("6. a site's own page acts only with its site token", () => {
  it("site tokens are bound to the name and expire", () => {
    let t = 0
    const s = new SiteTokens(() => t, 1000)
    const tok = s.mint("app")
    expect(s.check(tok, "app")).toBe(true)
    expect(s.check(tok, "app")).toBe(true)  // Restart may be pressed twice
    expect(s.check(tok, "other")).toBe(false)
    expect(s.check("site_" + crypto.randomUUID(), "app")).toBe(false)
    expect(s.check(null, "app")).toBe(false)
    t = 1000
    expect(s.check(tok, "app")).toBe(false)
  })

  it("siteAction: no /process/port, and start/restart need the token (Origin alone isn't enough)", () => {
    const fn = block(daemon, "const siteAction = (req")
    expect(fn).not.toContain("/process/port/")
    expect(fn).toContain('siteTokens.check(req.headers.get("X-Candy-Token"), name)')
    expect(block(daemon, 'if (req.method === "POST" && url.pathname.startsWith("/process/port/"))')).toContain("pageHost !== null ||")
  })

  it("the site-host log stream is a bounded excerpt, only while starting or crashed", () => {
    const stream = block(daemon, 'if (req.method === "GET" && url.pathname.startsWith("/stream/"))')
    expect(stream).toContain("const excerptOnly = pageHost !== null")
    expect(stream).toContain("status !== 'starting' && status !== 'errored' && status !== 'dead'")
    expect(stream).toContain("SITE_LOG_EXCERPT_BYTES - sent")
  })

  it("only starting/crashed pages of .localhost/.candy hosts get a site token, and send it", async () => {
    expect(block(daemon, "async function serveSitePage(").match(/isBoundDomain \? undefined : domain\)/g)!.length).toBe(4)
    for (const f of ["starting.html", "crashed.html"]) expect(await page(f)).toContain("'X-Candy-Token': window.CANDY_TOKEN || ''")
    expect(await page("starting.html")).not.toContain("/process/port/")
  })
})

// ----------------------------------------------------------------------------
// 7. Spoofed X-Forwarded-For; loopback lockout
// ----------------------------------------------------------------------------

describe("7. forwarding headers count only from our Caddy", () => {
  const norm = (ip: string) => ip.replace(/^::ffff:/, "")
  const loop = (ip: string) => ip === "127.0.0.1" || ip === "::1"
  const ip = (o: { peer: string; viaCaddy: boolean; xff?: string; cf?: string }) =>
    clientIp({ peer: o.peer, viaCaddy: o.viaCaddy, xff: o.xff ?? null, cf: o.cf ?? null, isLoopback: loop, normalize: norm })

  it("a direct :9999 caller can't pick its address", () => {
    expect(ip({ peer: "127.0.0.1", viaCaddy: false, xff: "6.6.6.6" })).toBe("127.0.0.1")
    expect(ip({ peer: "::ffff:127.0.0.1", viaCaddy: false, cf: "6.6.6.6" })).toBe("127.0.0.1")
  })

  it("from Caddy: the hop Caddy appended, and Cloudflare's header only via loopback (cloudflared)", () => {
    expect(ip({ peer: "127.0.0.1", viaCaddy: true, xff: "6.6.6.6, 192.168.0.20" })).toBe("192.168.0.20")
    expect(ip({ peer: "127.0.0.1", viaCaddy: true, xff: "127.0.0.1", cf: "203.0.113.9" })).toBe("203.0.113.9")
    expect(ip({ peer: "127.0.0.1", viaCaddy: true, xff: "192.168.0.20", cf: "203.0.113.9" })).toBe("192.168.0.20")
    expect(ip({ peer: "127.0.0.1", viaCaddy: true, xff: "127.0.0.1", cf: "not an ip" })).toBe("127.0.0.1")
  })

  it("Caddy tags what it sends the daemon, and the daemon checks the tag", () => {
    const tag = "t".repeat(32)
    const out = tagDaemonUpstreams(`a {\n  reverse_proxy localhost:9999\n}\nb {\n  reverse_proxy localhost:9999 {\n    header_up Host x\n  }\n  forward_auth localhost:9999 {\n    uri /c\n  }\n  reverse_proxy localhost:3000\n}\n`, tag)
    // once per daemon upstream: a bare line, a block with header_up Host, forward_auth
    expect(out.split(`header_up ${PROXY_TAG_HEADER} ${tag}`).length - 1).toBe(3)
    expect(out).toContain("reverse_proxy localhost:3000\n")
    const fingerprint = daemon.slice(daemon.indexOf("const getFingerprint = (req"), daemon.indexOf("// Validate auth session"))
    expect(fingerprint).toContain("viaCaddy: viaOwnCaddy(req, peer)")
    expect(fingerprint).not.toMatch(/split\(','\)\[0\]/)
    expect(block(daemon, "const syncCaddyNow = async")).toContain("tagDaemonUpstreams(content, CADDY_PROXY_TAG)")
  })

  it.skipIf(!caddy)("the tagged config adapts, setting the header on every daemon upstream", () => {
    const cfg = JSON.stringify(adapt(tagDaemonUpstreams("a.localhost {\n  tls internal\n  reverse_proxy localhost:9999\n}\n", "t".repeat(32))))
    expect(cfg).toContain(`"${PROXY_TAG_HEADER}":["${"t".repeat(32)}"]`)
  })

  it("the soft lockout grows and stops at 30s; loopback never gets the hard lock", async () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(SoftLockout.delayFor)).toEqual([0, 0, 0, 7500, 15000, SOFT_DELAY_CAP_MS, SOFT_DELAY_CAP_MS])
    let t = 0
    const hard: string[] = []
    const deps: LoginDeps = {
      ...raceDeps().deps,
      isLoopback: (a: string) => a === "127.0.0.1",
      blocked: async k => { hard.push(k); return { blocked: false, retryAfter: 0 } },
      fail: async k => { hard.push(k); return { retryAfter: 0 } },
      now: () => t,
      sleep: async ms => { t += ms },
    }
    for (let i = 0; i < 20; i++) {
      t += 31_000  // whatever happened before, 30s later it may try again
      const out = await attemptLogin(deps, { user: "ashwin", password: "typo", ip: "127.0.0.1" })
      expect(out.ok).toBe(false)
      expect((out as any).status).toBe(401)
    }
    expect(hard).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// 8. Taking over another user's public domain
// ----------------------------------------------------------------------------

describe("8. a bound domain stays its owner's", () => {
  it("register, SDK register-port, rename and new configs refuse a name bound by someone else", () => {
    for (const route of ['url.pathname === "/register")', 'url.pathname === "/sdk/register-port")', 'url.pathname === "/rename")']) {
      expect(block(daemon, `if (req.method === "POST" && ${route}`)).toContain("boundToSomeoneElse(")
    }
    const taken = block(daemon, "const nameTakenWithoutConfig = (")
    expect(taken.indexOf("boundToSomeoneElse(")).toBeLessThan(taken.indexOf("nameOwner(name) === auth.user"))
  })

  it("bindings record their owner, and removing the site orphans them instead of handing them on", () => {
    expect(block(daemon, 'if (req.method === "POST" && url.pathname === "/domains/bind")')).toContain("owner: nameOwner(serverName)")
    expect(block(daemon, "const refreshOrphanedBindings = async")).toContain("b.orphaned = true")
    expect(block(daemon, "const syncCaddyNow = async")).toContain("await refreshOrphanedBindings()")
    expect(daemon).toContain("await assignBindingOwners()")
    expect(block(daemon, "const boundToSomeoneElse = (")).toContain("bindingOwner(b) !== auth?.user")
  })
})

// ----------------------------------------------------------------------------
// 9. *.localhost on loopback only
// ----------------------------------------------------------------------------

describe("9. *.localhost sites listen on loopback only", () => {
  it("every .localhost block gets the loopback bind", () => {
    expect(loopbackBind(true)).toBe("bind 127.0.0.1 ::1")
    expect(loopbackBind(false)).toBe("bind 127.0.0.1")
    const sync = block(daemon, "const syncCaddyNow = async")
    for (const head of ["${name}.localhost {", "*.kill.localhost, *.k.localhost {", "*.portal.localhost, *.p.localhost {", "*.localhost {"]) {
      expect(sync).toContain(`${head}\n  \${localBind}\n`)
    }
  })

  it.skipIf(!caddy)("caddy adapt puts the .localhost server on loopback addresses only", () => {
    const cfg = adapt(`${caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/tmp/a.log" })}
app.localhost {
  ${loopbackBind(true)}
  tls internal
  reverse_proxy localhost:3000
}
*.localhost {
  ${loopbackBind(true)}
  tls internal
  reverse_proxy localhost:9999
}
`)
    const listens = Object.values(cfg.apps.http.servers).flatMap((s: any) => s.listen)
    expect(listens.sort()).toEqual(["127.0.0.1:443", "[::1]:443"])
  })
})

// ----------------------------------------------------------------------------
// 10, 11, 13, 14, 15, 16
// ----------------------------------------------------------------------------

describe("10. open redirect", () => {
  it("safeNext re-checks after normalization (the reviewer's probe)", () => {
    for (const n of ["/.//evil.com", "/./\\evil.com", "/a/..//evil.com", "//evil.com", "/\\evil", "/%2F%2Fevil.com/x/..//x"]) {
      const out = safeNext(n)
      expect(out.startsWith("//") || out.startsWith("/\\")).toBe(false)
      expect(new URL(out, "https://portal.localhost").host).toBe("portal.localhost")
    }
    expect(safeNext("/.//evil.com")).toBe("/")
    expect(safeNext("/?logs=app")).toBe("/?logs=app")
  })
})

describe("11. losing login eligibility ends the session", () => {
  it("requestAuth re-checks loginUsers (cached) and ends that user's logins", () => {
    const fn = block(daemon, "const requestAuth = async")
    expect(fn).toContain("await eligibleLoginUsers()")
    expect(fn).toContain("portalSessions.destroyUser(session.user)")
    expect(daemon).toContain("const eligibleLoginUsers = cachedList(() => loginUsers(), 60 * 1000)")
  })

  it("cachedList: one load per ttl, shared by concurrent callers", async () => {
    let t = 0, loads = 0
    const list = cachedList(async () => { loads++; return ["alice"] }, 60_000, () => t)
    await Promise.all([list(), list(), list()])
    expect(loads).toBe(1)
    t = 59_999
    await list()
    expect(loads).toBe(1)
    t = 60_000
    await list()
    expect(loads).toBe(2)
  })
})

describe("13. per-session caps", () => {
  it(`PageTokens keeps at most ${MAX_CHAINS_PER_SESSION} page loads per login, dropping the oldest`, () => {
    const t = new PageTokens()
    const other = t.mint("s2")
    const mine = Array.from({ length: MAX_CHAINS_PER_SESSION + 3 }, () => t.mint("s1"))
    expect(t.size).toBe(MAX_CHAINS_PER_SESSION + 1)
    for (const old of mine.slice(0, 3)) expect(t.consume(old, "s1")).toBe(false)
    expect(t.consume(mine.at(-1), "s1")).toBe(true)
    expect(t.consume(other, "s2")).toBe(true)
  })
})

describe("14. the audit actor is the authenticated user", () => {
  const alice: RequestAuth = { user: "alice", superuser: false, via: "apikey" }
  it("X-Candy-Actor is only a label after the real user", () => {
    expect(auditActor(alice, null)).toBe("alice:API")
    expect(auditActor(alice, "AI")).toBe("alice:AI")
    expect(auditActor({ ...alice, via: "portal" }, "root")).toBe("alice:root")
    expect(auditActor(alice, "System] [x")).toBe("alice:API")
    expect(auditActor(null, "AI")).toBe("System")
  })

  it("no handler takes X-Candy-Actor as the actor", () => {
    expect(daemon).not.toMatch(/req\.headers\.get\('X-Candy-Actor'\) as Actor/)
    expect(daemon).toContain("const requestActor: Actor = pageHost !== null ? 'Page' : auditActor(auth, req.headers.get('X-Candy-Actor'))")
  })
})

describe("15. server data is escaped before innerHTML", () => {
  it("Cloudflare record content and tunnel URLs are escaped", async () => {
    const portal = await page("portal.html")
    expect(portal).toContain("`${escapeHtml(r.type)} -> ${escapeHtml(r.content)}`")
    expect(portal).not.toContain("${r.content}")
    const portaling = await page("portaling.html")
    expect(portaling).not.toMatch(/<span class="url">\$\{(tunnelUrl|existingUrl)\}/)
    expect(portaling).toContain("const existingUrl = httpsUrl(vars.existingUrl)")
  })
})

describe("16. login timing", () => {
  it("the failure floor covers PAM's own failure delay (pam_unix p99 2.5s, pam_faildelay up to 3.75s)", () => {
    expect(LOGIN_FAILURE_FLOOR_MS).toBeGreaterThanOrEqual(4500)
  })
})

// ============================================================================
// Re-verification (R1-R9)
// ============================================================================

const TAG = "T".repeat(32)
const fromCaddy = () => new Headers({
  host: "myfn.localhost", [PROXY_TAG_HEADER]: TAG, "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "myfn.localhost", "cf-connecting-ip": "203.0.113.9",
})
const freePort = () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = s.port
  s.stop(true)
  return port
}

describe("R1. Caddy never logs secrets", () => {
  const global = caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/tmp/x/access.log" })

  it("the default logger filters every secret header and writes a 0600 file", () => {
    expect(global).toContain("format filter {")
    expect(global).toContain("wrap json")
    expect(global).toContain("mode 0600")
    for (const h of ["X-Candy-Session", "X-Candy-Token", "X-Candy-Api-Key", "X-Candy-Auth", "X-Candy-Proxy", "Authorization", "Cookie", "X-Auth-Token"]) {
      expect(LOG_REDACTED_REQUEST_HEADERS as readonly string[]).toContain(h)
      expect(global).toContain(`request>headers>${h} delete`)
    }
    expect(LOG_REDACTED_RESPONSE_HEADERS as readonly string[]).toContain("Set-Cookie")
    expect(global).toContain("resp_headers>Set-Cookie delete")
  })

  it("the daemon creates (and re-modes) access.log 0600", () => {
    expect(daemon).toContain('closeSync(openSync(CADDY_LOG, "w", 0o600))')
    expect(daemon).toContain("chmodSync(CADDY_LOG, 0o600)")
    expect(daemon).not.toContain('Bun.write(CADDY_LOG, "")')
  })

  it.skipIf(!caddy)("caddy adapt takes it, with a delete filter per header", () => {
    const json = adapt(`${global}\nhttp://127.0.0.1:1 {\n  respond "ok"\n  log\n}\n`)
    const log = json.logging.logs.default
    expect(log.writer.mode).toBe("0600")
    expect(log.encoder.format).toBe("filter")
    for (const h of LOG_REDACTED_REQUEST_HEADERS) expect(log.encoder.fields[`request>headers>${h}`]).toEqual({ filter: "delete" })
    expect(log.encoder.fields["resp_headers>Set-Cookie"]).toEqual({ filter: "delete" })
  })

  it.skipIf(!caddy)("a disposable Caddy (admin off, high port) leaves the headers out of the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candy-log-"))
    const port = freePort()
    const logFile = join(dir, "access.log")
    const cf = caddyGlobalBlock({ adminSocket: join(dir, "admin.sock"), accessLog: logFile })
      .replace(/^  admin .*$/m, `  admin off\n  auto_https off\n  storage file_system ${dir}/data`)
    writeFileSync(join(dir, "Caddyfile"), `${cf}\nhttp://127.0.0.1:${port} {\n  header Set-Cookie "candy_portal=SECRET_SETCOOKIE"\n  respond "ok"\n  log\n}\n`)
    const proc = Bun.spawn([caddy!, "run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], {
      stdout: "ignore", stderr: "ignore", env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
    })
    try {
      let res: Response | null = null
      for (let i = 0; i < 50 && !res; i++) {
        res = await fetch(`http://127.0.0.1:${port}/`, {
          headers: {
            "X-Candy-Session": "SECRET_SESSION", "X-Candy-Token": "SECRET_TOKEN", "X-Candy-API-Key": "SECRET_KEY", "X-Candy-Auth": "SECRET_AUTH",
            "X-Candy-Proxy": "SECRET_TAG", Authorization: "Bearer SECRET_BEARER", Cookie: "candy_portal=SECRET_COOKIE", "X-Auth-Token": "SECRET_XAT",
            "X-Visible": "still-here",
          },
        }).catch(() => null)
        if (!res) await Bun.sleep(100)
      }
      expect(res?.status).toBe(200)
      let text = ""
      for (let i = 0; i < 30 && !text.includes("still-here"); i++) { await Bun.sleep(100); text = await Bun.file(logFile).text().catch(() => "") }
      expect(text).toContain("still-here")
      expect(text).not.toContain("SECRET")
      expect(statSync(logFile).mode & 0o777).toBe(0o600)
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describe("Caddy reloads never overlap", () => {
  it("coalesced: one at a time, and a burst during a run shares one more run", async () => {
    let running = 0, max = 0, runs = 0
    const sync = coalesced(async () => { running++; max = Math.max(max, running); runs++; await Bun.sleep(20); running-- })
    const first = sync()
    await Bun.sleep(5)
    const burst = [sync(), sync(), sync()]
    expect(burst[0]).toBe(burst[1])
    await Promise.all([first, ...burst])
    expect(max).toBe(1)
    expect(runs).toBe(2)
    await sync()
    expect(runs).toBe(3)
  })

  it("a failed run doesn't block the next, and only its own callers see the error", async () => {
    let n = 0
    const sync = coalesced(async () => { if (++n === 1) throw new Error("boom") })
    await expect(sync()).rejects.toThrow("boom")
    await sync()
    expect(n).toBe(2)
  })

  it("the daemon syncs through it, retries a load that throws, and restarts a Caddy that stays unreachable", () => {
    expect(daemon).toContain("const syncCaddy = coalesced(() => syncCaddyNow())")
    const load = block(daemon, "const loadCaddyConfig = async")
    expect(load).toContain("attempt < 3")
    expect(load).toContain("keepalive: false")
    expect(load).toContain("AbortSignal.timeout(")
    const failed = block(daemon, "const caddyReloadFailed = async")
    expect(failed).toContain("syncCaddy()")
    expect(failed).toContain("await stopCaddy()")
    expect(failed).toContain("await startCaddy()")
    // and stopping Caddy doesn't wait on open connections forever
    expect(block(daemon, "const stopCaddy = async")).toContain('proc.kill("SIGKILL")')
  })
})

describe("SNI fronting: a TLS connection opened as one site can't ask for another", () => {
  const curl = Bun.which("curl")

  it("the global block turns strict_sni_host on for every server", () => {
    expect(caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/tmp/a.log" })).toMatch(/servers \{[^}]*\n    strict_sni_host on\n/)
  })

  it.skipIf(!caddy)("caddy adapt carries it to each HTTPS server, whatever its bind", () => {
    const cfg = adapt(`${caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/tmp/a.log" })}
wa.localhost {
  bind 127.0.0.1
  respond "wa"
}
portal.candy {
  bind 127.0.0.2
  respond "portal"
}
`)
    const https = Object.values(cfg.apps.http.servers as Record<string, any>).filter(s => s.listen.some((l: string) => l.endsWith(":443")))
    expect(https.length).toBe(2)
    for (const s of https) expect(s.strict_sni_host).toBe(true)
  })

  it.skipIf(!caddy || !curl)("a disposable Caddy answers 421 when Host isn't the SNI name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candy-sni-"))
    const port = freePort()
    const cf = caddyGlobalBlock({ adminSocket: join(dir, "admin.sock"), accessLog: join(dir, "access.log") })
      .replace(/^  admin .*$/m, `  admin off\n  skip_install_trust\n  auto_https disable_redirects\n  storage file_system ${dir}/data`)
    writeFileSync(join(dir, "Caddyfile"), `${cf}
https://wa.localhost:${port} {
  bind 127.0.0.1
  tls internal
  respond "wa"
}
https://portal.candy:${port} {
  bind 127.0.0.1
  tls internal
  respond "portal"
}
`)
    const proc = Bun.spawn([caddy!, "run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], {
      stdout: "ignore", stderr: "ignore", env: { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
    })
    // Connect (and send SNI) as `sni`, ask for `host`
    const ask = async (sni: string, host: string): Promise<{ status: number; body: string }> => {
      const r = Bun.spawnSync([curl!, "-sk", "-m", "5", "--resolve", `${sni}:${port}:127.0.0.1`, "-H", `Host: ${host}`, "-w", "\n%{http_code}", `https://${sni}:${port}/`])
      const out = r.stdout.toString()
      const cut = out.lastIndexOf("\n")
      return { status: Number(out.slice(cut + 1)), body: out.slice(0, Math.max(cut, 0)) }
    }
    try {
      let ok = { status: 0, body: "" }
      for (let i = 0; i < 60 && ok.status !== 200; i++) { ok = await ask("wa.localhost", "wa.localhost"); if (ok.status !== 200) await Bun.sleep(150) }
      expect(ok).toEqual({ status: 200, body: "wa" })
      expect(await ask("portal.candy", "portal.candy")).toEqual({ status: 200, body: "portal" })
      // With the port in Host too
      expect((await ask("wa.localhost", `wa.localhost:${port}`)).body).toBe("wa")
      for (const [sni, host] of [["wa.localhost", "portal.candy"], ["wa.localhost", `portal.candy:${port}`], ["portal.candy", "wa.localhost"], ["wa.localhost", "nothing.example"]]) {
        const res = await ask(sni, host)
        expect(res.status, `${sni} asking for ${host}`).toBe(421)
        expect(res.body).not.toContain("portal")
        expect(res.body).not.toBe("wa")
      }
    } finally {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("R2. the proxy tag never reaches user code", () => {
  it("stripProxyHeaders: the tag always goes; forwarding headers go unless Caddy sent them", () => {
    const caddyReq = fromCaddy()
    stripProxyHeaders(caddyReq, true)
    expect(caddyReq.get(PROXY_TAG_HEADER)).toBeNull()
    expect(caddyReq.get("x-forwarded-for")).toBe("127.0.0.1")
    expect(caddyReq.get("cf-connecting-ip")).toBe("203.0.113.9")
    const direct = fromCaddy()
    direct.set("forwarded", "for=6.6.6.6")
    stripProxyHeaders(direct, false)
    for (const h of [PROXY_TAG_HEADER, "x-forwarded-for", "x-forwarded-host", "cf-connecting-ip", "forwarded"]) expect(direct.get(h)).toBeNull()
    expect(direct.get("host")).toBe("myfn.localhost")
  })

  it("a function's headers and an API-mode server's headers never carry it, even if the strip were skipped", async () => {
    expect(fnRequestHeaders(fromCaddy(), { stripCredentials: false }).get(PROXY_TAG_HEADER)).toBeNull()
    expect(fnRequestHeaders(fromCaddy(), { stripCredentials: true }).get(PROXY_TAG_HEADER)).toBeNull()
    // An API-mode server, sent what forwardApiModeRequest sends (upstreamRequestHeaders = fnRequestHeaders)
    let seen: Headers | null = null
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => { seen = req.headers; return new Response("ok") } })
    try {
      const incoming = fromCaddy()
      stripProxyHeaders(incoming, true)
      await fetch(`http://127.0.0.1:${server.port}/`, { headers: fnRequestHeaders(incoming, { stripCredentials: false }) })
      expect(seen!.get(PROXY_TAG_HEADER)).toBeNull()
      await fetch(`http://127.0.0.1:${server.port}/`, { headers: fnRequestHeaders(fromCaddy(), { stripCredentials: false }) })
      expect(seen!.get(PROXY_TAG_HEADER)).toBeNull()
    } finally {
      server.stop(true)
    }
  })

  it("the daemon strips it once, before the public MCP host, functions and every route", () => {
    const control = block(daemon, "async function controlFetch(")
    const strip = control.indexOf("markProxyHeaders(req, peerIp)")
    expect(strip).toBeGreaterThan(0)
    for (const later of ["handlePublicMcp(", "fnForRequest(", "/candy-auth/check", "classifyRoute(ROUTE_TABLE"]) expect(control.indexOf(later)).toBeGreaterThan(strip)
    expect(block(daemon, "const markProxyHeaders = ")).toContain("stripProxyHeaders(req.headers, fromOwnCaddy.has(req))")
    // viaOwnCaddy is the decision made there, not a re-read of a header that's gone
    expect(daemon).toContain("const viaOwnCaddy = (req: Request, _peer?: string): boolean => fromOwnCaddy.has(req)")
  })

  it("every forwarder builds its headers through upstreamRequestHeaders (fnRequestHeaders)", () => {
    expect(daemon).toContain("const upstreamRequestHeaders = (src: Headers, protectedDomain: boolean): Headers =>\n  fnRequestHeaders(")
    // API mode forwards from api-mode.ts, with the headers the daemon hands it
    expect(daemon).toContain("upstreamHeaders: (src, protectedDomain) => upstreamRequestHeaders(src, protectedDomain),")
    expect(apiMode).toContain("headers: deps.upstreamHeaders(req.headers, protectedDomain),")
    expect(apiMode).not.toMatch(/headers: req\.headers,/)
    expect(apiMode).not.toContain("new Headers(req.headers)")
    expect(daemon).toContain("const proxyHeaders = upstreamRequestHeaders(req.headers, false)")
    expect(daemon).toContain("headers: upstreamRequestHeaders(req.headers, !!boundMatch && hasBindingAuth(boundMatch.binding))")
    expect(daemon).not.toMatch(/headers: req\.headers,/)
    expect(daemon).not.toContain("new Headers(req.headers)")
  })
})

describe("R3. login limits", () => {
  const mk = (verify: LoginDeps["verifyPassword"], over: Partial<LoginDeps> = {}) => {
    let t = 0
    const audits: string[] = []
    const hard = new Map<string, number>()
    const deps: LoginDeps = {
      pamReady: () => true,
      loginUsers: async () => ["alice", "bob", "carol", "dave", "erin"],
      verifyPassword: verify,
      isSuperuser: async () => false,
      blocked: async k => ({ blocked: (hard.get(k) ?? 0) >= 3, retryAfter: 3600 }),
      fail: async k => { hard.set(k, (hard.get(k) ?? 0) + 1); return { retryAfter: 0 } },
      clear: async () => {},
      audit: (a, d) => audits.push(`${a} ${d}`),
      serverError: () => {},
      now: () => t,
      sleep: async ms => { t += ms },
      isLoopback: ip => /^127\./.test(ip) || ip === "::1",
      slots: new LoginSlots(),
      soft: new SoftLockout(() => t),
      ...over,
    }
    return { deps, audits, hard, advance: (ms: number) => { t += ms }, freeze: () => { deps.sleep = async () => {} } }
  }
  const denied = () => { let n = 0; return { verify: async () => { n++; return { ok: false, reason: "denied" } as const }, calls: () => n } }

  it("rotating 127.0.0.N reaches PAM no more often than one address (login-probe B)", async () => {
    const one = denied(), many = denied()
    const a = mk(one.verify); a.freeze()
    const b = mk(many.verify); b.freeze()
    for (let i = 0; i < 20; i++) await attemptLogin(a.deps, { user: "alice", password: `x${i}`, ip: "127.0.0.1" })
    for (let i = 0; i < 20; i++) await attemptLogin(b.deps, { user: "alice", password: `x${i}`, ip: `127.0.${i >> 8}.${(i & 255) + 2}` })
    expect(many.calls()).toBe(one.calls())
    expect(many.calls()).toBeLessThanOrEqual(3)
  })

  it("the soft lockout is per user: rotating non-loopback addresses doesn't buy guesses either", async () => {
    const d = denied()
    const env = mk(d.verify); env.freeze()
    for (let i = 0; i < 20; i++) await attemptLogin(env.deps, { user: "alice", password: `x${i}`, ip: `10.0.${i}.1` })
    expect(d.calls()).toBe(3)
  })

  it("a user in the delay gets 429 + retryAfter (never 'wrong password'), at most 30s, and nothing counted on the caller", async () => {
    const env = mk(async (_u, pw) => ({ ok: pw === "right", reason: pw === "right" ? "ok" : "denied" }))
    // The attacker rotates addresses, so no address lock gets in its way
    for (let i = 0; i < 6; i++) { await attemptLogin(env.deps, { user: "erin", password: "guess", ip: `198.51.100.${i}` }); env.advance(SOFT_DELAY_CAP_MS) }
    await attemptLogin(env.deps, { user: "erin", password: "guess", ip: "198.51.100.99" })
    const victim = await attemptLogin(env.deps, { user: "erin", password: "right", ip: "192.0.2.1" })
    expect(victim.ok).toBe(false)
    if (victim.ok) return
    expect(victim.status).toBe(429)
    expect(victim.body.error).not.toBe(LOGIN_FAILED)
    expect(victim.body.retryAfter).toBeGreaterThan(0)
    expect(victim.body.retryAfter!).toBeLessThanOrEqual(SOFT_DELAY_CAP_MS / 1000)
    expect(env.hard.get("portal:ip:192.0.2.1") ?? 0).toBe(0)
    // and once the (capped) delay has passed, the right password works
    env.advance(SOFT_DELAY_CAP_MS)
    expect((await attemptLogin(env.deps, { user: "erin", password: "right", ip: "192.0.2.1" })).ok).toBe(true)
  })

  it("full slots answer 429 'busy, try again' to a right password (login-probe C and D)", async () => {
    const release: (() => void)[] = []
    const verify: LoginDeps["verifyPassword"] = (user, pw) => user === "erin" && pw === "right"
      ? Promise.resolve({ ok: true, reason: "ok" })
      : new Promise(r => release.push(() => r({ ok: false, reason: "denied" })))
    // C: the global cap, held from four outside addresses
    const c = mk(verify)
    const held = ["alice", "bob", "carol", "dave"].map((u, i) => attemptLogin(c.deps, { user: u, password: "guess", ip: `198.51.100.${10 + i}` }))
    await Bun.sleep(5)
    expect(await attemptLogin(c.deps, { user: "erin", password: "right", ip: "192.0.2.1" })).toEqual({ ok: false, status: 429, body: { error: LOGIN_BUSY } })
    release.splice(0).forEach(f => f()); await Promise.all(held)
    // D: the victim's own user slot
    const d = mk(verify)
    const p = attemptLogin(d.deps, { user: "erin", password: "guess", ip: "198.51.100.99" })
    await Bun.sleep(5)
    expect(await attemptLogin(d.deps, { user: "erin", password: "right", ip: "192.0.2.1" })).toEqual({ ok: false, status: 429, body: { error: LOGIN_BUSY } })
    release.splice(0).forEach(f => f()); await p
  })

  it("a real failure still takes the floor time", async () => {
    const env = mk(denied().verify)
    const start = env.deps.now()
    const out = await attemptLogin(env.deps, { user: "alice", password: "nope", ip: "192.0.2.5" })
    expect(out).toEqual({ ok: false, status: 401, body: { error: LOGIN_FAILED } })
    expect(env.deps.now() - start).toBeGreaterThanOrEqual(LOGIN_FAILURE_FLOOR_MS)
  })
})

describe("R4. names are lower case everywhere", () => {
  it("lowerName is ASCII only (the Kelvin sign doesn't become k)", () => {
    expect(lowerName("Victim")).toBe("victim")
    expect(lowerName("Kill")).toBe("Kill")
    expect(lowerName(42)).toBe(42)
  })

  it("stored names: lower-cased, and on a clash the first one stays", () => {
    const { kept, dropped, renamed } = mergeLowerCase([["victim", 1], ["Victim", 2], ["MyApp", 3], ["other", 4]])
    expect([...kept]).toEqual([["victim", 1], ["myapp", 3], ["other", 4]])
    expect(dropped).toEqual(["Victim"])
    expect(renamed).toEqual([["MyApp", "myapp"]])
  })

  it("isSafeName takes lower case only, and every control route sees lower-cased names", () => {
    expect(daemon).toContain("const SAFE_NAME = /^[a-z0-9]([a-z0-9_-]*[a-z0-9_])?(\\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/\n")
    const control = block(daemon, "async function controlFetch(")
    const lower = control.indexOf("lowerRequestNames(req, url)")
    expect(lower).toBeGreaterThan(control.indexOf("fnForRequest("))  // a function's own request is left alone
    expect(lower).toBeLessThan(control.indexOf('url.pathname === "/register"'))
    expect(daemon).toContain('const NAME_FIELDS = ["name", "oldName", "newName", "serverName", "targets"]')
    // names read from paths are lower-cased where they're read
    expect(daemon).not.toMatch(/const (name|domain|subdomain) = url\.pathname\.split\("\/"\)\[\d\]/)
    expect(daemon).toContain("let portalName = lowerName(name)")
  })

  it("names stored mixed-case are migrated at load, with an audit line", () => {
    expect(block(daemon, "const loadServerConfigs = async")).toContain('lowerCaseNames("site", serverConfigs)')
    expect(block(daemon, "const loadPersistentRoutes = async")).toContain('lowerCaseNames("route", routes)')
    expect(block(daemon, "const loadRouteUsers = async")).toContain('lowerCaseNames("route owner", routeUsers)')
    expect(block(daemon, "const loadDomainConfig = async")).toContain("b.serverName = lowerName(b.serverName)")
    const fn = block(daemon, "const lowerCaseNames = ")
    expect(fn).toContain("auditLog('NAME_LOWERCASED'")
    expect(fn).toContain("auditLog('NAME_DROPPED'")
  })
})

describe("R5. no name can freeze Caddy's config", () => {
  const RESERVED = new Set(["portal", "k", "kill", "p", "candy"])

  it("new names can't be shortcut or alias hosts", () => {
    for (const bad of ["portal", "kill", "foo.kill", "foo.kill.myhost", "foo.k", "a.p.b", "x.portal", "foo.myhost", "myhost"]) {
      expect(newNameProblem(bad, "myhost", RESERVED)).not.toBeNull()
    }
    for (const ok of ["foo", "killer", "my-app.dev", "portals", "foo.myhost2"]) expect(newNameProblem(ok, "myhost", RESERVED)).toBeNull()
    // every creation route asks
    for (const start of ['if (req.method === "POST" && url.pathname === "/register")', 'if (req.method === "POST" && url.pathname === "/rename")',
      'if (req.method === "POST" && url.pathname === "/sdk/register-port")', "if (req.method === 'POST' && route === '/fn/add')"]) {
      expect(block(daemon, start)).toContain("newNameRefusal(")
    }
    const open = daemon.slice(daemon.indexOf("const openPortalForName = async"))
    expect(open.slice(0, open.indexOf("routes.set(portalName"))).toContain("newNameRefusal(portalName)")
    expect(daemon.match(/const refusal = nameInUse\(name\) \? null : newNameRefusal\(name\)/g)!.length).toBeGreaterThanOrEqual(3)
  })

  // What syncCaddy writes for a user who registered "foo.kill.myhost" (and the
  // old mixed-case "Victim" next to "victim"), with the system alias for "foo"
  const hostile = (global: string) => `${global}
foo.candy, foo.myhost.candy {
  bind 100.64.0.1
  tls internal
  reverse_proxy localhost:3000
  log
}

foo.kill.myhost.candy, foo.kill.myhost.myhost.candy {
  bind 100.64.0.1
  tls internal
  reverse_proxy localhost:4000
  log
}

victim.localhost {
  bind 127.0.0.1
  tls internal
  reverse_proxy localhost:5000
  log
}

Victim.localhost {
  bind 127.0.0.1
  tls internal
  reverse_proxy localhost:5001
  log
}

${SYSTEM_BLOCK_MARK}
foo.kill.myhost.candy, foo.k.myhost.candy {
  bind 100.64.0.1
  tls internal
  reverse_proxy localhost:9999
  log
}
`

  it("dedupe: the system alias wins, the first user block wins, an emptied block goes", () => {
    const { content, skipped } = dedupeSiteAddresses(hostile(""))
    expect(skipped.sort()).toEqual(["Victim.localhost", "foo.kill.myhost.candy"])
    expect(content).toContain("foo.kill.myhost.myhost.candy {\n  bind 100.64.0.1\n  tls internal\n  reverse_proxy localhost:4000")
    expect(content).not.toContain("localhost:5001")
    expect(content).toContain(`${SYSTEM_BLOCK_MARK}\nfoo.kill.myhost.candy, foo.k.myhost.candy {`)
    // nothing to do: the same text back
    const clean = "a.localhost {\n  reverse_proxy localhost:1\n}\n"
    expect(dedupeSiteAddresses(clean)).toEqual({ content: clean, skipped: [] })
  })

  it.skipIf(!caddy)("caddy adapt fails on the hostile file and succeeds once deduped", () => {
    const global = tagDaemonUpstreams(caddyGlobalBlock({ adminSocket: "/run/candy/caddy-admin.sock", accessLog: "/tmp/x/access.log" }), TAG)
    const raw = tagDaemonUpstreams(hostile(global), TAG)
    expect(() => adapt(raw)).toThrow(/ambiguous site definition/)
    const json = adapt(dedupeSiteAddresses(raw).content)
    expect(JSON.stringify(json)).toContain("foo.kill.myhost.candy")
  })

  it("syncCaddy marks its own blocks and dedupes before writing, auditing each skip once", () => {
    const sync = block(daemon, "const syncCaddyNow = async")
    for (const host of ["*.kill.localhost, *.k.localhost {", "*.portal.localhost, *.p.localhost {", "*.kill.candy, *.k.candy {", "*.portal.candy, *.p.candy {",
      "${[...new Set(candyKillAliasHosts)]", "${[...new Set(candyPortalAliasHosts)]", "${[...new Set(candyAliasHosts)]", "*.localhost {", "*.candy {"]) {
      expect(sync).toContain("${SYSTEM_BLOCK_MARK}\n" + host)
    }
    const dedupe = sync.indexOf("dedupeSiteAddresses(content)")
    expect(dedupe).toBeGreaterThan(sync.indexOf("tagDaemonUpstreams(content, CADDY_PROXY_TAG)"))
    expect(dedupe).toBeLessThan(sync.indexOf("await Bun.write(CADDYFILE, content)"))
    expect(sync).toContain("auditLog('CADDY_SITE_SKIPPED'")
  })
})

describe("R6. a site page's token and log excerpt", () => {
  it("tokens for a name end when it's running", () => {
    const s = new SiteTokens()
    const a = s.mint("app"), b = s.mint("other")
    s.dropName("app")
    expect(s.check(a, "app")).toBe(false)
    expect(s.check(b, "other")).toBe(true)
    for (const at of ["managed.status = 'running'\n        siteTokens.dropName(name)", "managed.status = 'running'\n  siteTokens.dropName(name)"]) expect(daemon).toContain(at)
  })

  it("the excerpt starts at this run's offset", () => {
    const spawnFn = block(daemon, "const spawnProcess = async")
    expect(spawnFn.indexOf("logStart = statSync(logFile).size")).toBeLessThan(spawnFn.indexOf("--- PROCESS RESTART"))
    expect(spawnFn).toContain("    logStart,\n")
    const stream = block(daemon, 'if (req.method === "GET" && url.pathname.startsWith("/stream/"))')
    expect(stream).toContain("const startAt = excerptOnly ? (processes.get(name)?.logStart ?? 0) : 0")
    expect(stream).toContain("let offset = startAt")
    expect(stream).toContain("file.slice(offset, end)")
  })

  it("with a site token: start ignores configId (and never switches a running variant), restart only after a crash", () => {
    const start = block(daemon, 'if (req.method === "POST" && url.pathname.startsWith("/process/start/"))')
    expect(start).toContain("const requestedConfigId = pageHost !== null ? undefined : body?.configId")
    const restart = block(daemon, 'if (req.method === "POST" && url.pathname.startsWith("/process/restart/"))')
    expect(restart).toContain("if (pageHost !== null && status !== 'errored' && status !== 'dead')")
    expect(restart.indexOf("pageHost !== null && status")).toBeLessThan(restart.indexOf("scheduleRestart("))
  })
})

describe("R7. a bound domain can't expose the portal", () => {
  const own = ["192.168.0.7", "100.64.0.1", "fd7a:115c:a1e0::1", "myhost.tail1234.ts.net"]

  it("upstreams that are this machine are refused, except the daemon's own localhost:<port> form", () => {
    for (const ok of ["localhost:3000", "127.0.0.1:3000", "https://api.example.com", "http://10.0.0.5:8080", "https://[2001:db8::1]:8443"]) {
      expect(isCaddyUpstream(ok, own)).toBe(true)
    }
    for (const bad of ["https://portal.localhost", "http://portal.localhost:443", "https://PORTAL.LOCALHOST", "http://localhost:3000", "http://localhost.:3000",
      "https://foo.candy", "https://portal.myhost.candy", "http://127.0.0.2", "http://127.1", "http://2130706433", "http://0x7f.1", "http://0.0.0.0:80",
      "http://[::1]:80", "http://[0:0:0:0:0:0:0:1]", "http://[::ffff:127.0.0.1]", "http://[::]:80", "http://192.168.0.7:8080", "http://100.64.0.1",
      "http://[fd7a:115c:a1e0::1]", "https://myhost.tail1234.ts.net"]) {
      expect(isCaddyUpstream(bad, own)).toBe(false)
    }
    const sync = block(daemon, "const syncCaddyNow = async")
    expect(sync).toContain("isCaddyUpstream(target, own)")
  })

  it("the portal isn't the portal when Caddy received the request as another site", () => {
    const fn = block(daemon, "const isPortalRequest = ")
    expect(fn).toContain('req.headers.get("x-forwarded-host")')
    expect(block(daemon, "const requestAuth = async")).toContain("if (!isPortalRequest(req)) return null")
    expect(block(daemon, "async function controlFetch(")).toContain("const portalHost = isPortalRequest(req)")
  })
})

describe("R8. Caddy's admin socket", () => {
  it("the old :2019 check can't be redirected", () => {
    const start = block(daemon, "const startCaddy = async")
    const calls = start.split("\n").filter(l => l.includes('fetch("http://127.0.0.1:2019'))
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c).toContain('redirect: "manual"')
  })

  it("no /load to a socket that failed the check: log and retry", () => {
    const sync = block(daemon, "const syncCaddyNow = async")
    const check = sync.indexOf("!caddyAdminTrusted && !await secureCaddyAdminSocket(1)")
    expect(check).toBeGreaterThan(0)
    // the only /load is loadCaddyConfig, reached after the check
    expect(check).toBeLessThan(sync.indexOf("await loadCaddyConfig(content)"))
    expect(sync).not.toContain('caddyAdmin("/load"')
    expect(daemon.match(/caddyAdmin\("\/load"/g)?.length).toBe(1)
    expect(sync).toContain("scheduleCaddyRetry()")
    const secure = block(daemon, "const secureCaddyAdminSocket = async")
    expect(secure).toContain("return caddyAdminTrusted = ok")
    expect(secure).toContain("(dir.mode & 0o022) !== 0")
  })

  it("no predictable /tmp socket folder in user mode", () => {
    expect(daemon).not.toContain("/tmp/candy-${process.getuid")
    expect(daemon).toContain("const USER_RUN_DIR = process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/candy` : `${CANDY_CONFIG_DIR}/run`")
  })
})

describe("R9. the portal can't be framed", () => {
  it("every response on the portal host carries frame-ancestors 'none' and DENY", () => {
    expect(daemon).toContain(`const PORTAL_NO_FRAMING = { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" }`)
    // the server's only fetch is the wrapper, so the login page and the shell get it too
    expect(block(daemon, "const controlServer = Bun.serve({")).toContain("return noFraming(req, await controlFetch(req))")
    expect(block(daemon, "const noFraming = ")).toContain('isPortalHost(req.headers.get("host"))')
  })
})
