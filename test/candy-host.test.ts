// candy's own host, candy.<zone>: the name, its reservation, its routing in
// the daemon (read as text: importing daemon.ts would start it), and the
// stamp / login code tickets. The ceremonies themselves are driven end to end
// in test/app-auth-flow.test.ts.
import { describe, expect, it } from "bun:test"
import { candyHostFor, checkBindings, cloudflaredYaml, isSocketPath, stripProxyHeaders, tagDaemonUpstreams, tunnelSiteBlock, CANDY_SUBDOMAIN, LOG_REDACTED_REQUEST_HEADERS, TUNNEL_TAG_HEADER } from "../caddy-config.ts"
import {
  isPublicMcpPath, PasskeyTickets, TicketsBusy, MAX_STAMPS_PER_ADDRESS, MAX_LIVE_STAMPS, newCookieValue, readCookie, sha256b64, CANDY_HOST_ROUTES, LOGIN_CODE_TTL_MS, STAMP_TTL_MS, type StampPayload,
} from "../candy-host.ts"

const daemon = await Bun.file(new URL("../daemon.ts", import.meta.url)).text()
const block = (start: string, end = "\n}\n"): string => {
  const a = daemon.indexOf(start)
  if (a < 0) throw new Error(`${start} not found`)
  return daemon.slice(a, daemon.indexOf(end, a))
}

describe("candyHostFor", () => {
  it("is candy.<zone>, lower case, or null without a valid zone", () => {
    expect(CANDY_SUBDOMAIN).toBe("candy")
    expect(candyHostFor("ashwins.world")).toBe("candy.ashwins.world")
    expect(candyHostFor(" Example.COM ")).toBe("candy.example.com")
    for (const bad of [null, undefined, "", "localhost", "a..b", "-x.com", "x.com/evil", 3]) expect(candyHostFor(bad)).toBeNull()
  })
})

describe("the candy subdomain is reserved", () => {
  const binding = (sub: string) => ({ subdomain: sub, fqdn: `${sub}.example.com`, serverName: "notes" })
  it("a binding for candy.<zone> is dropped (with why), others are kept", () => {
    const { kept, dropped } = checkBindings({ candy: binding("candy"), notes: binding("notes") }, "example.com", () => true)
    expect(Object.keys(kept)).toEqual(["notes"])
    expect(dropped).toEqual([{ key: "candy", why: "candy.<zone> is candy's own host (passkeys), never a binding" }])
  })
  it("/domains/bind refuses it before anything else happens", () => {
    const bind = block('if (req.method === "POST" && url.pathname === "/domains/bind")')
    const refuse = bind.indexOf("if (subdomain === CANDY_SUBDOMAIN)")
    expect(refuse).toBeGreaterThan(0)
    expect(refuse).toBeLessThan(bind.indexOf("cloudflared tunnel route dns"))
    expect(refuse).toBeLessThan(bind.indexOf("domainConfig.bindings[subdomain] = {"))
  })
  it("site names: candy was already reserved", () => {
    expect(daemon).toContain("const RESERVED_NAMES = new Set(['portal', 'k', 'kill', 'p', 'candy'])")
  })
})

describe("routing candy.<zone>", () => {
  it("candyHost() needs a tunnel and a zone", () => {
    expect(block("const candyHost = ():", "\n\n")).toContain("isTunnelId(domainConfig?.tunnel?.id) ? candyHostFor(domainConfig?.zone?.domain) : null")
  })
  it("gets a Caddy system block to the daemon, written once even when the public MCP endpoint shares it", () => {
    const caddy = block("const syncCaddyNow = async", "  if (portals.size > 0)")
    expect(caddy).toContain("const ownHost = candyHost()")
    expect(caddy).toContain("tunnelSiteBlock(ownHost, CADDY_TUNNEL_SOCKET, CADDY_TUNNEL_TAG, SYSTEM_BLOCK_MARK)")
    expect(caddy).toContain("tunnelSiteBlock(mcpPublicFqdn, CADDY_TUNNEL_SOCKET, CADDY_TUNNEL_TAG, SYSTEM_BLOCK_MARK)")
    expect(caddy).toContain("mcpPublicFqdn !== ownHost")
  })
  it("gets tunnel ingress and a DNS record; turning MCP off never deletes its DNS", () => {
    const ingress = block("const syncCloudflaredIngress = async")
    expect(ingress).toContain("const ownHost = candyHost()")
    expect(ingress).toContain("ingress.push({ hostname: ownHost, unix: CADDY_TUNNEL_SOCKET })")
    expect(ingress).toContain("ingress.push({ hostname: mcpFqdn, unix: CADDY_TUNNEL_SOCKET })")
    expect(block("const ensureCandyHostDns = async")).toContain("cloudflared tunnel route dns ${domainConfig.tunnel.name} ${host}")
    const mcp = block("const setPublicMcp = async")
    expect(mcp).toContain("previous !== candyHost()")
    expect(mcp).toContain("fqdn !== candyHost()")
    // at startup and whenever the domain config changes
    expect(daemon).toContain("ensureCandyHostDns().catch(() => {})")
    expect(block('if (req.method === "POST" && url.pathname === "/domains/config")')).toContain("await ensureCandyHostDns()")
  })
  it("is dispatched by Host before everything else in controlFetch (functions, API mode, the guard) and never falls through", () => {
    const control = block("async function controlFetch(")
    const at = control.indexOf("if (requestHostname && ownHost && requestHostname === ownHost) {")
    expect(at).toBeGreaterThan(0)
    for (const later of ["fnForRequest(requestHostname", "apiModeGate(req, url)", "auth = await requestAuth(req)", "classifyRoute(ROUTE_TABLE"]) {
      expect(control.indexOf(later)).toBeGreaterThan(at)
    }
    const branch = control.slice(at, control.indexOf("\n    }\n", at))
    expect(branch).toContain("return await candyHostRoutes.handle(")
    expect(branch).toContain("publicMcpFqdn() === ownHost && isPublicMcpPath(url.pathname)")
  })
  it("passkeys made for another host are pruned (audited) at start, on a domain change and every 10 minutes", () => {
    expect(block("const prunePasskeyRpIds = () =>")).toContain("passkeys.dropOtherRpIds(host)")
    expect(block("const prunePasskeyRpIds = () =>")).toContain("auditLog('PASSKEY_DROP'")
    expect(block("const prunePasskeys = () =>")).toContain("prunePasskeyRpIds()")
  })
})

describe("its route table", () => {
  it("is exactly the two ceremonies' page, options and verify", () => {
    expect(CANDY_HOST_ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual([
      "GET /passkey/enroll", "POST /passkey/enroll/options", "POST /passkey/enroll/verify",
      "GET /passkey/login", "POST /passkey/login/options", "POST /passkey/login/verify",
    ])
  })
  it("shares the host with the public MCP endpoint only on its paths", () => {
    for (const p of ["/mcp", "/mcp/", "/token", "/register", "/authorize", "/authorize/complete", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(isPublicMcpPath(p)).toBe(true)
    }
    for (const p of ["/", "/passkey/login", "/passkey/login/options", "/auth/me", "/configs", "/mcpx", "/.well-known/other"]) expect(isPublicMcpPath(p)).toBe(false)
  })
})

describe("PasskeyTickets", () => {
  const clock = { t: 1_800_000_000_000 }
  const make = () => new PasskeyTickets({ now: () => clock.t })
  const login = (o: Partial<StampPayload> = {}): StampPayload => ({
    purpose: "login", host: "candy.example.com", portal: "portal.candy", next: "/", bind: "b".repeat(43), user: null, sessionId: null, pamAt: null, name: null, ...o,
  })
  const enroll = (o: Partial<StampPayload> = {}): StampPayload => ({
    purpose: "enroll", host: "candy.example.com", portal: "portal.candy", next: "/passkeys", bind: null, user: "claude", sessionId: "sess-claude-000001", pamAt: clock.t, name: "Key", seq: 0, ...o,
  })

  it("stamps: opaque, checked without use, single use on take, 5 minutes", () => {
    const t = make()
    const id = t.mintStamp(login(), "ip:203.0.113.1")
    expect(id).not.toContain("portal")
    expect(t.checkStamp(id, "login", "candy.example.com")).toMatchObject({ ok: true })
    expect(t.checkStamp(id, "login", "candy.example.com")).toMatchObject({ ok: true })
    expect(t.takeStamp(id, "login", "candy.example.com")).toMatchObject({ ok: true })
    expect(t.takeStamp(id, "login", "candy.example.com")).toMatchObject({ ok: false, why: "used" })
    const late = t.mintStamp(login(), "ip:203.0.113.1")
    clock.t += STAMP_TTL_MS
    expect(t.checkStamp(late, "login", "candy.example.com")).toMatchObject({ ok: false, why: "expired" })
  })

  it("a stamp of the other purpose, another candy host, tampered or foreign is invalid", () => {
    const t = make()
    const id = t.mintStamp(login(), "ip:203.0.113.1")
    expect(t.checkStamp(id, "enroll", "candy.example.com")).toEqual({ ok: false, why: "invalid" })
    expect(t.checkStamp(id, "login", "candy.other.com")).toEqual({ ok: false, why: "invalid" })
    expect(t.checkStamp(id.slice(0, -2) + (id.endsWith("A") ? "BB" : "AA"), "login", "candy.example.com")).toEqual({ ok: false, why: "invalid" })
    expect(make().checkStamp(id, "login", "candy.example.com")).toEqual({ ok: false, why: "invalid" })
    for (const junk of [undefined, null, "", 5, {}, "x".repeat(5000)]) expect(t.checkStamp(junk, "login", "candy.example.com")).toEqual({ ok: false, why: "invalid" })
  })

  it("refuses to mint a stamp the daemon should never make", () => {
    const t = make()
    expect(() => t.mintStamp(login({ user: "claude" }), "ip:203.0.113.1")).toThrow()            // a login stamp names no one
    expect(() => t.mintStamp(login({ bind: null }), "ip:203.0.113.1")).toThrow()                // and is bound to a browser
    expect(() => t.mintStamp(login({ next: "//evil.example" }), "ip:203.0.113.1")).toThrow()
    expect(() => t.mintStamp(login({ portal: "evil example" }), "ip:203.0.113.1")).toThrow()
    expect(() => t.mintStamp(enroll({ sessionId: null }), "ip:203.0.113.1")).toThrow()
    expect(() => t.mintStamp(enroll({ pamAt: null }), "ip:203.0.113.1")).toThrow()
    expect(() => t.mintStamp(enroll({ fresh: { sessionId: "s", request: "r".repeat(43) } }), "ip:203.0.113.1")).toThrow()
    expect(() => t.mintStamp(login({ fresh: { sessionId: "s", request: "short" } }), "ip:203.0.113.1")).toThrow()
    expect(t.checkStamp(t.mintStamp(enroll({ name: "‮evil" }), "ip:203.0.113.1"), "enroll", "candy.example.com")).toMatchObject({ ok: true, stamp: { name: "evil" } })
  })

  it("claims: the first browser keeps it", () => {
    const t = make()
    expect(t.claim("j1", "h1", clock.t + 1000)).toBe("claimed")
    expect(t.claim("j1", "h1", clock.t + 1000)).toBe("same")
    expect(t.claim("j1", "h2", clock.t + 1000)).toBe("elsewhere")
    expect(t.claimedBy("j1", "h1")).toBe(true)
    expect(t.claimedBy("j1", "h2")).toBe(false)
    expect(t.claimedBy("j1", null)).toBe(false)
    clock.t += 1000
    expect(t.claimedBy("j1", "h1")).toBe(false)
    expect(t.sweep()).toBeGreaterThanOrEqual(1)
  })

  it("login codes: single use, 60 seconds, carrying the fresh binding when there is one", () => {
    const t = make()
    const p = { user: "claude", host: "candy.example.com", portal: "portal.candy", next: "/x", bind: "b".repeat(43), credential: "c", fresh: null }
    const code = t.mintCode(p)
    expect(t.takeCode(code)).toEqual({ ...p, by: "" })
    expect(t.takeCode(code)).toBeNull()
    const late = t.mintCode(p)
    clock.t += LOGIN_CODE_TTL_MS
    expect(t.takeCode(late)).toBeNull()
    const fresh = { sessionId: "sess-1", request: "r".repeat(43) }
    expect(t.takeCode(t.mintCode({ ...p, fresh }))!.fresh).toEqual(fresh)
    // a code is not a stamp, and a stamp is not a code
    expect(t.checkStamp(t.mintCode(p), "login", "candy.example.com")).toEqual({ ok: false, why: "invalid" })
    expect(t.takeCode(t.mintStamp(login(), "ip:203.0.113.1"))).toBeNull()
  })

  // Review finding (evict.ts): the claims map and the used set evicted the soonest-expiring
  // live entry when full, so a flood of cheap login stamps made a victim's finished
  // (or claimed) enroll stamp usable again in the attacker's browser.
  it("a flood never makes a used or claimed stamp usable again: one address gets a share, and full fails closed", () => {
    const t = make()
    const host = "candy.example.com"
    const victim = t.mintStamp(enroll(), "ip:198.51.100.7")
    const vc = t.checkStamp(victim, "enroll", host) as any
    const victimCookie = sha256b64(newCookieValue())
    expect(t.claim(vc.jti, victimCookie, vc.expires, "ip:198.51.100.7")).toBe("claimed")
    expect(t.takeStamp(victim, "enroll", host)).toMatchObject({ ok: true })
    const atk = sha256b64(newCookieValue())
    // One address: refused after its share, with a Retry-After
    let minted = 0, refused: unknown = null
    for (let i = 0; i < 200; i++) {
      try {
        const s = t.mintStamp(login(), "loopback")
        const c = t.checkStamp(s, "login", host) as any
        t.claim(c.jti, atk, c.expires, "loopback")
        t.takeStamp(s, "login", host)
        minted++
      } catch (e) { refused = e; break }
    }
    expect(minted).toBe(MAX_STAMPS_PER_ADDRESS)
    expect(refused).toBeInstanceOf(TicketsBusy)
    expect((refused as TicketsBusy).why).toBe("owner")
    expect((refused as TicketsBusy).retryAfterS).toBeGreaterThan(0)
    // Many addresses together (a tailnet full of attackers): the sets fill and refuse; nothing is evicted
    let full: unknown = null
    for (let a = 0; a < Math.ceil(MAX_LIVE_STAMPS / MAX_STAMPS_PER_ADDRESS) + 5 && !full; a++) {
      for (let i = 0; i < MAX_STAMPS_PER_ADDRESS; i++) {
        try {
          const s = t.mintStamp(login(), `ip:10.0.${a >> 8}.${a & 255}`)
          const c = t.checkStamp(s, "login", host) as any
          t.claim(c.jti, atk, c.expires, `ip:10.0.${a >> 8}.${a & 255}`)
          t.takeStamp(s, "login", host)
        } catch (e) { full = e; break }
      }
    }
    expect(full).toBeInstanceOf(TicketsBusy)
    expect((full as TicketsBusy).why).toBe("full")
    // The victim's stamp is still used, and still claimed by the victim only
    expect(t.checkStamp(victim, "enroll", host)).toMatchObject({ ok: false, why: "used" })
    expect(t.claim(vc.jti, atk, vc.expires, "loopback")).toBe("elsewhere")
    expect(t.claimedBy(vc.jti, victimCookie)).toBe(true)
    expect(t.claimedBy(vc.jti, atk)).toBe(false)
  })

  it("a claim that can't be recorded is 'busy' (the stamp is unusable there); minting stops when the live set is full", () => {
    const t = new PasskeyTickets({ now: () => clock.t, maxUsed: 4, maxPerAddress: 2, maxClaimsPerAddress: 1 })
    const host = "candy.example.com"
    const a = t.checkStamp(t.mintStamp(login(), "ip:a"), "login", host) as any
    const b = t.checkStamp(t.mintStamp(login(), "ip:b"), "login", host) as any
    expect(t.claim(a.jti, "h", a.expires, "ip:x")).toBe("claimed")
    expect(t.claim(b.jti, "h", b.expires, "ip:x")).toBe("busy")    // ip:x holds its share
    expect(t.claimedBy(b.jti, "h")).toBe(false)
    // used set: 2 overall
    const s1 = t.mintStamp(login(), "ip:c"), s2 = t.mintStamp(login(), "ip:d")
    expect(() => t.mintStamp(login(), "ip:e")).toThrow(TicketsBusy)   // minted set full too
    expect(t.takeStamp(s1, "login", host)).toMatchObject({ ok: true })
    expect(t.takeStamp(s2, "login", host)).toMatchObject({ ok: true })
  })

  it("cookie helpers", () => {
    expect(readCookie("a=1; __Host-candy_passkey=xyz; b=2", "__Host-candy_passkey")).toBe("xyz")
    expect(readCookie(null, "a")).toBeNull()
    expect(sha256b64("x")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe("the pages", () => {
  const page = (f: string) => Bun.file(new URL(`../public/${f}`, import.meta.url)).text()
  it("the login page only links to the candy host (no WebAuthn on the portal), hides passkeys without a bound domain, and goes straight there for an app sign-in", async () => {
    const html = await page("portal-login.html")
    expect(html).not.toContain("navigator.credentials.get")
    expect(html).toContain("'/auth/passkey/start?next='")
    expect(html).toContain("vars.passkeys !== true")
    expect(html).toContain("vars.autoPasskey === true")
    expect(block('if (req.method === "GET" && url.pathname === "/login")')).toContain('next.startsWith("/app-auth/consent?") && url.searchParams.get("with") !== "password"')
  })
  it("the passkeys page opens a popup on the candy host and trusts only its messages; no portal-address notice", async () => {
    const html = await page("portal-passkeys.html")
    expect(html).not.toContain("navigator.credentials.create")
    expect(html).not.toContain("only on the portal address")
    expect(html).toContain("e.origin !== candyOrigin")
    expect(html).toContain("e.source !== popup")
    expect(html).toContain("'/passkeys/enroll/start'")
    expect(html).toContain("Passkeys need a bound domain")
  })
  it("the candy host's page: no external resources, the stamp out of the address bar, a retry after a cancelled prompt, postMessage to the exact portal origin", async () => {
    const html = await page("passkey-host.html")
    expect(html).not.toMatch(/(src|href)="https?:/)
    expect(html).not.toMatch(/ style="/)
    expect(html).toContain("history.replaceState(null, '', location.pathname)")
    expect(html).toContain("name === 'NotAllowedError' || name === 'AbortError'")
    expect(html).toContain("retry(")
    expect(html).toContain("window.opener.postMessage({ type: 'candy-passkey', purpose: 'enroll', ok: true }, portal)")
    expect(html).toContain("Done, you can close this window.")
    expect(html).toContain("Use your password instead")
    expect(html).toContain("Go back and try again")
    expect(html).toContain("This browser can’t use passkeys.")
  })
})

describe("SealedIds and LiveSet fail closed", () => {
  it("markUsed never evicts a live entry: full means refused, and an owner holds only its share", async () => {
    const { SealedIds, LiveSet } = await import("../sealed-ids.ts")
    let t = 1000
    const ids = new SealedIds<number>("test", { now: () => t, maxUsed: 3, maxPerOwner: 2 })
    expect(ids.markUsed("a", t + 100, "x")).toBe(true)
    expect(ids.markUsed("b", t + 100, "x")).toBe(true)
    expect(ids.markUsed("c", t + 100, "x")).toBe(false)      // x's share
    expect(ids.markUsed("c", t + 100, "y")).toBe(true)
    expect(ids.markUsed("d", t + 100, "z")).toBe(false)      // full
    expect(ids.room("z")).toBe("full")
    expect(ids.isUsed("a") && ids.isUsed("b") && ids.isUsed("c")).toBe(true)
    t += 100                                                  // all expired: room again
    expect(ids.markUsed("d", t + 100, "z")).toBe(true)
    const set = new LiveSet<string>(() => t, 10)
    expect(set.maxPerOwner).toBe(1)                           // 5% of 10, at least 1
  })
})

// Review finding: a local user could send to 127.0.0.1:80 with Host: candy.<zone> and a
// made-up Cf-Connecting-Ip, and pick the address used for the candy host's lockouts.
describe("tunnel-only hosts: the visitor's address only through the tunnel", () => {
  const TUNNEL = { id: "844ebfd5-ca57-4c99-8236-d808fef70f9e", credentialsFile: "/home/u/.cloudflared/x.json" }
  it("candy's own host and the public MCP host are bound to a 0600 unix socket, never a TCP port, and tagged", () => {
    const block = tagDaemonUpstreams(tunnelSiteBlock("candy.example.com", "/run/candy/tunnel.sock", "t".repeat(32), "# candy:system"), "p".repeat(32))
    expect(block).toContain("http://candy.example.com {\n  bind unix//run/candy/tunnel.sock|0600\n")
    expect(block).toContain(`header_up ${TUNNEL_TAG_HEADER} ${"t".repeat(32)}`)
    expect(block).toContain(`header_up X-Candy-Proxy ${"p".repeat(32)}`)
    expect(() => tunnelSiteBlock("candy.example.com", "relative.sock", "t".repeat(32), "#")).toThrow()
    expect(() => tunnelSiteBlock("candy.example.com", "/run/x y.sock", "t".repeat(32), "#")).toThrow()
    expect(() => tunnelSiteBlock("bad host", "/run/candy/tunnel.sock", "t".repeat(32), "#")).toThrow()
    for (const bad of ["", "x", "/a/../b", "/a b", "/a{b}", "/" + "a".repeat(120)]) expect(isSocketPath(bad)).toBe(false)
  })
  it("cloudflared sends those hosts to the socket; bound domains still to Caddy on :80", () => {
    const yaml = cloudflaredYaml(TUNNEL, ["wa.example.com", { hostname: "candy.example.com", unix: "/run/candy/tunnel.sock" }, { hostname: "candy.example.com", unix: "/run/candy/tunnel.sock" }, { hostname: "x.example.com", unix: "rel" }])!
    expect(yaml).toContain("  - hostname: wa.example.com\n    service: http://localhost:80\n")
    expect(yaml).toContain("  - hostname: candy.example.com\n    service: unix:/run/candy/tunnel.sock\n")
    expect(yaml.match(/candy\.example\.com/g)!.length).toBe(1)
    expect(yaml).not.toContain("x.example.com")
  })
  it("the daemon believes Cf-Connecting-Ip on these hosts only with the tunnel tag (from its own Caddy); otherwise it's loopback", () => {
    const ip = block("const publicClientIp = (req: Request): string =>", "\n}\n")
    expect(ip).toContain(`if (!fromTunnel.has(req)) return "127.0.0.1"`)
    const mark = block("const markProxyHeaders = (req: Request, peer: string): void =>", "\n}\n")
    expect(mark).toContain("if (hasCaddyTag(req, peer)) {")
    expect(mark).toContain("fromTunnel.add(req)")
    expect(block("async function controlFetch(")).toContain("candyHostRoutes.handle(req, url, { ip: publicClientIp(req) })")
    expect(block("const handlePublicMcp = async")).toContain("const ip = publicClientIp(req)")
  })
  it("the tunnel tag never reaches a route, a function or the access log", () => {
    const h = new Headers({ [TUNNEL_TAG_HEADER]: "x", "cf-connecting-ip": "1.2.3.4" })
    stripProxyHeaders(h, false)
    expect(h.has(TUNNEL_TAG_HEADER)).toBe(false)
    expect(h.has("cf-connecting-ip")).toBe(false)
    const own = new Headers({ [TUNNEL_TAG_HEADER]: "x" })
    stripProxyHeaders(own, true)
    expect(own.has(TUNNEL_TAG_HEADER)).toBe(false)
    expect(LOG_REDACTED_REQUEST_HEADERS as readonly string[]).toContain("X-Candy-Tunnel")
  })
})
