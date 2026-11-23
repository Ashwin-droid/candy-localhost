// Package E: the Settings pages' rules and renders (SPEC §8 E).

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { AdguardStatus, AppAuthSite, DomainsResponse, PasskeyView, PublicMcpStatus } from "../../api/types.ts"
import { renderWith } from "../../test/render.tsx"
import AccountPage from "./AccountPage.tsx"
import DaemonPage, { adguardBody, ONLY_SUPERUSER } from "./DaemonPage.tsx"
import { adguardFacts, fmtDay, needsPassword, revokeConfirmBody, revokeText, rotateText, signedInClients, ZONE_EMPTY, zoneBody, zoneDraftOf } from "./logic.ts"
import { acceptPasskeyMessage, checkEnrollUrl } from "./passkeyMessage.ts"
import PasskeysPage, { NO_DOMAIN } from "./PasskeysPage.tsx"
import { reauthError } from "./ReauthPanel.tsx"
import SignInPage from "./SignInPage.tsx"
import { SETTINGS_KEYS } from "./types.ts"
import { ApiError } from "../../api/client.ts"

const HOSTILE = `<img src=x onerror=alert(1)>`
const ORIGIN = "https://candy.example.com"

describe("acceptPasskeyMessage", () => {
  const popup = { name: "popup" }
  const ok = { type: "candy-passkey", purpose: "enroll", ok: true }
  test("accepts the popup's enroll ok from the candy origin", () => {
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: ok }, ORIGIN, popup)).toBe(true)
  })
  test("wrong origin", () => {
    expect(acceptPasskeyMessage({ origin: "https://evil.example.com", source: popup, data: ok }, ORIGIN, popup)).toBe(false)
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: ok }, null, popup)).toBe(false)
  })
  test("wrong source", () => {
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: { other: 1 }, data: ok }, ORIGIN, popup)).toBe(false)
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: null, data: ok }, ORIGIN, null)).toBe(false)
  })
  test("wrong type", () => {
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: { ...ok, type: "other" } }, ORIGIN, popup)).toBe(false)
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: "candy-passkey" }, ORIGIN, popup)).toBe(false)
  })
  test("wrong purpose", () => {
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: { ...ok, purpose: "login" } }, ORIGIN, popup)).toBe(false)
  })
  test("not ok", () => {
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: { ...ok, ok: false } }, ORIGIN, popup)).toBe(false)
    expect(acceptPasskeyMessage({ origin: ORIGIN, source: popup, data: { ...ok, ok: "true" } }, ORIGIN, popup)).toBe(false)
  })
})

describe("checkEnrollUrl", () => {
  test("only https://<candyHost>", () => {
    const u = `${ORIGIN}/passkey/enroll?candy_stamp=abc`
    expect(checkEnrollUrl(u, "candy.example.com")).toBe(u)
    expect(checkEnrollUrl("http://candy.example.com/passkey/enroll", "candy.example.com")).toBeNull()
    expect(checkEnrollUrl("https://candy.example.com.evil.com/x", "candy.example.com")).toBeNull()
    expect(checkEnrollUrl("https://candy.example.com:8443/x", "candy.example.com")).toBeNull()
    expect(checkEnrollUrl("/passkey/enroll", "candy.example.com")).toBeNull()
    expect(checkEnrollUrl("javascript:alert(1)", "candy.example.com")).toBeNull()
    expect(checkEnrollUrl(42, "candy.example.com")).toBeNull()
    expect(checkEnrollUrl(u, null)).toBeNull()
  })
})

describe("recent password", () => {
  test("needsPassword: null or within 5 s of now", () => {
    expect(needsPassword(null, 1000)).toBe(true)
    expect(needsPassword(6000, 1000)).toBe(true)
    expect(needsPassword(6001, 1000)).toBe(false)
  })
  test("reauthError: lockout, server text, fallback, network", () => {
    expect(reauthError(new ApiError("x", 429, { error: "slow down", retryAfter: 7 }, { retryAfter: 7 })).retryAfter).toBe(7)
    expect(reauthError(new ApiError("Wrong username or password.", 401, { error: "Wrong username or password." })).text).toBe("Wrong username or password.")
    expect(reauthError(new ApiError("Request failed (500)", 500, {})).text).toBe("That didn’t work.")
    expect(reauthError(new ApiError("Can't reach the candy daemon.", 0)).text).toBe("Can't reach the candy daemon.")
  })
})

describe("zone body rule", () => {
  const configured: DomainsResponse = { configured: true, zone: { id: "z1", domain: "example.com" },
    tunnel: { id: "t1", name: "candy", credentialsFile: "/c.json" }, bindings: {} }
  test("empty form: the message, nothing sent", () => {
    expect(zoneBody({ domain: " ", tunnel: "", tunnelId: "x", credentials: "" }, configured)).toEqual({ error: ZONE_EMPTY })
  })
  test("unchanged domain keeps the zone id; a new domain sends an empty id", () => {
    expect(zoneBody({ ...zoneDraftOf(configured) }, configured)).toEqual({ body: {
      zone: { domain: "example.com", id: "z1" }, tunnel: { name: "candy", id: "t1", credentialsFile: "/c.json" } } })
    expect(zoneBody({ domain: "other.org", tunnel: "", tunnelId: "", credentials: "" }, configured)).toEqual({ body: { zone: { domain: "other.org", id: "" } } })
  })
  test("tunnel included when name or id is given", () => {
    expect(zoneBody({ domain: "", tunnel: "candy", tunnelId: "", credentials: "" }, undefined)).toEqual({ body: { tunnel: { name: "candy", id: "", credentialsFile: "" } } })
    expect(zoneBody({ domain: "a.com", tunnel: "", tunnelId: "abc", credentials: "~/x.json" }, { configured: false, bindings: {} }))
      .toEqual({ body: { zone: { domain: "a.com", id: "" }, tunnel: { name: "", id: "abc", credentialsFile: "~/x.json" } } })
  })
})

describe("sign-in key texts", () => {
  test("rotate and revoke, with and without restarts", () => {
    expect(rotateText({ site: "api", kid: "k2", restartNeeded: [] })).toBe("api has a new key (k2).")
    expect(rotateText({ site: "api", kid: "k2", restartNeeded: ["api", "web"] }))
      .toBe("api has a new key (k2). Restart api, web to give it the new key (apps using the SDK pick it up within 5 minutes).")
    expect(revokeText({ site: "api", approvals: 0, restartNeeded: [] })).toBe("Revoked the key of api.")
    expect(revokeText({ site: "api", approvals: 1, restartNeeded: ["api"] }))
      .toBe("Revoked the key of api and 1 approval. Restart api: a running server keeps the old key in memory until then.")
    expect(revokeText({ site: "api", approvals: 3 })).toBe("Revoked the key of api and 3 approvals.")
    expect(revokeConfirmBody("api", true)[1]).toBe("api still asks for sign-in in its candy.json, so it gets a new key the next time it starts.")
    expect(revokeConfirmBody("api", false)[1]).toBe("api doesn’t ask for sign-in, so it gets no new key.")
  })
  test("fmtDay", () => {
    expect(fmtDay(null)).toBe("never")
    expect(fmtDay(new Date(2026, 10, 21, 14, 2).getTime())).toBe("21 Nov 2026")
  })
})

describe("AdGuard Home", () => {
  test("facts", () => {
    expect(adguardFacts(null)).toEqual([{ label: "Status", value: "Couldn’t load" }])
    expect(adguardFacts({ configured: false })).toEqual([{ label: "Status", value: "Not linked" }])
    const ag: AdguardStatus = { configured: true, url: "http://127.0.0.1:3000", username: "admin", client: "lan", dnsTarget: "127.0.0.1:5336",
      rules: ["a.candy", "b.candy"], managed: [], error: "timeout" }
    expect(adguardFacts(ag).map(f => f.value)).toEqual(["Linked", "lan", "2 to 127.0.0.1:5336: a.candy, b.candy", "Failed: timeout"])
    expect(adguardFacts({ ...ag, rules: [], error: null }).map(f => f.value)).toEqual(["Linked", "lan", "None right now"])
  })
  test("body: password needed only when not linked, never sent empty, default address", () => {
    const d = { url: "", username: "admin", password: "", client: "lan", dnsTarget: "" }
    expect("errors" in adguardBody(d, false)).toBe(true)
    expect(adguardBody(d, true)).toEqual({ body: { url: "http://127.0.0.1:3000", username: "admin", client: "lan" } })
    expect(adguardBody({ ...d, password: "pw", dnsTarget: "10.0.0.2:5336" }, false))
      .toEqual({ body: { url: "http://127.0.0.1:3000", username: "admin", password: "pw", client: "lan", dnsTarget: "10.0.0.2:5336" } })
    expect(adguardBody({ ...d, username: " ", client: "" }, true)).toMatchObject({ errors: { username: expect.any(String), client: expect.any(String) } })
  })
})

const mcp = (o: Partial<PublicMcpStatus> = {}): PublicMcpStatus => ({
  available: true, enabled: true, url: "https://mcp.example.com/mcp", wouldBe: null, consent: "https://portal.candy/oauth/consent", clients: [], ...o,
})
const client = (id: string, grants: number, name = id) => ({ clientId: id, clientName: name, createdAt: 1, lastUsedAt: null, activeGrants: grants, users: ["ashwin"] })

describe("Daemon page", () => {
  test("not rendered for a non-superuser", () => {
    const html = renderWith(<DaemonPage />, { route: "/settings/daemon", session: { superuser: false } })
    expect(html).toContain("Only a superuser can change the daemon")
    expect(html).not.toContain("Cloudflare zone and tunnel")
    expect(html).not.toContain("AdGuard Home")
    expect(html).not.toContain('href="/settings/daemon"')
    expect(ONLY_SUPERUSER).toBe("Only a superuser can change the daemon's settings.")
  })
  test("superuser sees the three sections", () => {
    const html = renderWith(<DaemonPage />, { route: "/settings/daemon", session: { superuser: true },
      resources: { [SETTINGS_KEYS.mcp]: mcp({ available: false }), [SETTINGS_KEYS.adguard]: { configured: false } } })
    expect(html).toContain("Cloudflare zone and tunnel")
    expect(html).toContain("Needs a zone and a tunnel (above).")
    expect(html).toContain("Not linked")
    expect(html).toContain('href="/settings/daemon"')
    expect(html).not.toContain("/shutdown")
  })
  test("MCP clients: only activeGrants > 0, and no Sign out all when none", () => {
    expect(signedInClients(mcp({ clients: [client("a", 0), client("b", 2)] })).map(c => c.clientId)).toEqual(["b"])
    const none = renderWith(<DaemonPage />, { session: { superuser: true }, route: "/settings/daemon",
      resources: { [SETTINGS_KEYS.mcp]: mcp({ clients: [client("idle", 0, "Idle client")] }), [SETTINGS_KEYS.adguard]: { configured: false } } })
    expect(none).not.toContain("Sign out all")
    expect(none).not.toContain("Idle client")
    expect(none).toContain(">None<")
    const some = renderWith(<DaemonPage />, { session: { superuser: true }, route: "/settings/daemon",
      resources: { [SETTINGS_KEYS.mcp]: mcp({ clients: [client("idle", 0, "Idle client"), client("c1", 1, HOSTILE)] }), [SETTINGS_KEYS.adguard]: { configured: false } } })
    expect(some).toContain("Sign out all")
    expect(some).toContain("Clients: 1 signed in")
    expect(some).not.toContain("Idle client")
    expect(some).not.toContain("<img")
    expect(some).toContain("mcp.example.com/mcp")
  })
  test("MCP off: no clients section", () => {
    const html = renderWith(<DaemonPage />, { session: { superuser: true }, route: "/settings/daemon",
      resources: { [SETTINGS_KEYS.mcp]: mcp({ enabled: false, url: null, wouldBe: "https://candy.example.com/mcp", clients: [client("c1", 1)] }), [SETTINGS_KEYS.adguard]: { configured: false } } })
    expect(html).not.toContain("Clients")
    expect(html).toContain("candy.example.com/mcp")
  })
})

const pk = (o: Partial<PasskeyView> = {}): PasskeyView => ({
  id: "p1", name: "MacBook", rpId: "candy.example.com", created: 1, lastUsed: null, backedUp: false, alg: "ES256", here: true, ...o,
})

describe("Passkeys page", () => {
  test("no candyHost: the bound-domain note and Add disabled", () => {
    const html = renderWith(<PasskeysPage />, { route: "/settings/passkeys", session: { candyHost: null }, resources: { [SETTINGS_KEYS.passkeys]: { passkeys: [] } } })
    expect(html).toContain("Passkeys need a bound domain")
    expect(html).toContain(NO_DOMAIN.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    expect(html).toContain("Needs a bound domain (see above).")
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Add a passkey/)
    expect(html).toContain("No passkeys yet.")
  })
  test("list: escaped names, unusable rpId, synced", () => {
    const html = renderWith(<PasskeysPage />, { route: "/passkeys", session: { candyHost: "candy.example.com" }, resources: {
      [SETTINGS_KEYS.passkeys]: { passkeys: [pk({ name: HOSTILE, backedUp: true }), pk({ id: "p2", name: "Old", rpId: "candy.old.org", here: false })] } } })
    expect(html).not.toContain("<img")
    expect(html).toContain("for candy.old.org (unusable)")
    expect(html).toContain('title="Backed up by your passkey provider"')
    expect(html).not.toContain("Passkeys need a bound domain")
    expect(html).toContain("with a passkey instead of your password")
    // /passkeys is the same view, with Passkeys active in the sub-nav
    expect(html).toMatch(/aria-current="page"[^>]*>Passkeys</)
  })
})

describe("Sign in with candy page", () => {
  const site = (o: Partial<AppAuthSite> = {}): AppAuthSite => ({ site: "api", owner: "ashwin", kid: "k1", created: 1, rotatedAt: null, enabled: true, ...o })
  test("Rotate only for enabled keys; owner shown to a superuser", () => {
    const html = renderWith(<SignInPage />, { route: "/settings/sign-in", session: { superuser: true }, resources: {
      [SETTINGS_KEYS.appAuthSites]: { sites: [site({ site: "old", enabled: false, owner: "bob" })] },
      [SETTINGS_KEYS.appAuthConsents]: { consents: [] } } })
    expect(html).not.toContain(">Rotate<")
    expect(html).toContain(">Revoke<")
    expect(html).toContain("Not asked for")
    expect(html).toContain(">bob<")
    expect(html).toContain("You haven’t said yes to any site.")
    const two = renderWith(<SignInPage />, { route: "/settings/sign-in", resources: {
      [SETTINGS_KEYS.appAuthSites]: { sites: [site({ site: HOSTILE })] }, [SETTINGS_KEYS.appAuthConsents]: { consents: [{ site: "web", owner: "ashwin", at: 1 }] } } })
    expect(two).toContain(">Rotate<")
    expect(two).toContain("In use")
    expect(two).not.toContain("<img")
    expect(two).toContain(">Forget<")
  })
  test("empty keys", () => {
    const html = renderWith(<SignInPage />, { route: "/settings/sign-in", resources: {
      [SETTINGS_KEYS.appAuthSites]: { sites: [] }, [SETTINGS_KEYS.appAuthConsents]: { consents: [] } } })
    expect(html).toContain("None of your sites has a sign-in key.")
  })
})

describe("Account page", () => {
  test("role, login method, multi-user, no Daemon link for a user", () => {
    const html = renderWith(<AccountPage />, { route: "/settings", session: { amr: "passkey", multiUser: true } })
    expect(html).toContain("User: you see and manage your own sites")
    expect(html).toContain("A passkey")
    expect(html).toContain("Yes: sites run as their own users, in a sandbox")
    expect(html).toContain('href="candy://portal"')
    expect(html).toContain("Log out")
    expect(html).not.toContain('href="/settings/daemon"')
  })
  test("superuser with a password login", () => {
    const html = renderWith(<AccountPage />, { route: "/settings", session: { superuser: true, amr: "pam" } })
    expect(html).toContain("Superuser: you see and manage every user&#x27;s sites and the daemon&#x27;s settings")
    expect(html).toContain("Your password")
    expect(html).toContain('href="/settings/daemon"')
  })
})

describe("source", () => {
  const SRC = join(import.meta.dir, "..", "..")
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p)
    }
  }
  walk(SRC)
  test("no navigator.credentials anywhere in web/src", () => {
    expect(files.filter(f => /navigator\.credentials/.test(readFileSync(f, "utf8")))).toEqual([])
  })
  test("the settings pages never offer to shut the daemon down", () => {
    const own = files.filter(f => f.includes(join("pages", "settings")))
    expect(own.length).toBeGreaterThan(5)
    expect(own.filter(f => /\/shutdown/.test(readFileSync(f, "utf8")))).toEqual([])
  })
})
