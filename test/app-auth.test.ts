import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AppKeyStore, ConsentStore, PendingRequests,
  validateAuthorize, recheckRequest, mintAppToken, successReturn, errorReturn, consentView, hostKind,
  mayFetchSiteKey, issuersFor,
  ROTATION_OVERLAP_MS, MAX_SITES, CONSENT_TTL_MS, MAX_CONSENTS, PENDING_TTL_MS, MAX_PENDING_USED, MAX_RETURN_TO,
  AUTHZ_BAD_RETURN, AUTHZ_NOT_SITE, AUTHZ_SITE_MISMATCH, AUTHZ_BAD_STATE, AUTHZ_BAD_NONCE, AUTHZ_DUPLICATE, AUTHZ_EXPIRED, AUTHZ_CHANGED, AUTHZ_BAD_MAX_AGE, freshnessOk, freshKey,
  type AuthorizeRequest, type SiteLookup,
} from "../app-auth.ts"
import { openClaims, generateKey, b64urlEncode, JweError, CLOCK_SKEW_S, DEFAULT_TTL_S, MAX_RING_KEYS, KID_RE, type JweKey } from "../jwe.ts"

const T0 = 1_800_000_000_000
const MIN = 60_000
const STATE = "s".repeat(16) + "_State-123"
const NONCE = "n".repeat(20)
const ISS = "https://portal.localhost"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "candy-app-auth-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

// candy routes: notes (claude), blog (ashwin, also on blog.example.com), wiki (ashwin)
const ROUTES: Record<string, string> = {
  "notes.localhost": "notes", "notes.candy": "notes", "notes.box.candy": "notes",
  "blog.localhost": "blog", "blog.example.com": "blog",
  "wiki.localhost": "wiki",
}
const OWNERS: Record<string, string> = { notes: "claude", blog: "ashwin", wiki: "ashwin" }
const lookup = (routes = ROUTES, owners = OWNERS): SiteLookup & { asked: string[] } => {
  const asked: string[] = []
  return {
    asked,
    siteOfHost: h => { asked.push(h); return routes[h] ?? null },
    ownerOf: s => owners[s] ?? null,
  }
}
const q = (o: Record<string, string> | [string, string][]) => new URLSearchParams(o as any)
const CB = "/_candy/auth/callback"
const good = (extra: Record<string, string> = {}) => q({ return_to: "https://notes.localhost/_candy/auth/callback", state: STATE, ...extra })

const expectJweError = async (p: Promise<unknown>, code: string) => {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(JweError)
    expect((e as JweError).code).toBe(code as any)
    return
  }
  throw new Error(`expected JweError(${code})`)
}

const request = (over: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
  id: "R".repeat(32), site: "notes", owner: "claude",
  returnTo: "https://notes.localhost/_candy/auth/callback", returnHost: "notes.localhost",
  state: STATE, nonce: NONCE, issuer: ISS, ip: "203.0.113.5", created: T0, maxAge: null, ...over,
})

// ---------------------------------------------------------------------------

describe("validateAuthorize", () => {
  it("accepts a return_to on the site and returns the normalized request", () => {
    const look = lookup()
    expect(validateAuthorize(good({ nonce: NONCE }), look)).toEqual({
      ok: true, site: "notes", owner: "claude",
      returnTo: "https://notes.localhost/_candy/auth/callback", returnHost: "notes.localhost",
      state: STATE, nonce: NONCE, maxAge: null,
    })
    expect(look.asked).toEqual(["notes.localhost"])
  })

  it("max_age: a whole number of seconds 0..86400, once; anything else is refused before parking", () => {
    for (const [raw, want] of [["0", 0], ["300", 300], ["86400", 86400]] as const) {
      expect(validateAuthorize(good({ max_age: raw }), lookup())).toMatchObject({ ok: true, maxAge: want })
    }
    for (const bad of ["86401", "-1", "+5", " 5", "5 ", "1e3", "1.5", "", "abc", "0x10", "999999"]) {
      expect(validateAuthorize(good({ max_age: bad }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_MAX_AGE })
    }
    const twice = new URLSearchParams(good({}))
    twice.append("max_age", "1")
    twice.append("max_age", "2")
    expect(validateAuthorize(twice, lookup())).toMatchObject({ ok: false, status: 400 })
  })

  it("nonce is optional", () => {
    const r = validateAuthorize(good(), lookup())
    expect(r.ok && r.nonce).toBeNull()
  })

  it("accepts tailnet, alias and bound-domain hosts of the site", () => {
    for (const h of ["notes.candy", "notes.box.candy"]) {
      const r = validateAuthorize(q({ return_to: `https://${h}${CB}`, state: STATE }), lookup())
      expect(r).toMatchObject({ ok: true, site: "notes", returnHost: h })
    }
    expect(validateAuthorize(q({ return_to: `https://blog.example.com${CB}`, state: STATE }), lookup()))
      .toMatchObject({ ok: true, site: "blog", owner: "ashwin", returnTo: `https://blog.example.com${CB}` })
  })

  it("stores url.href: host lower-cased, default port and dot segments folded", () => {
    const r = validateAuthorize(q({ return_to: "HTTPS://NOTES.Localhost:443/a/../_candy/./auth/callback", state: STATE }), lookup())
    expect(r).toMatchObject({ ok: true, returnTo: `https://notes.localhost${CB}`, returnHost: "notes.localhost" })
  })

  it("percent-encoded host bytes are decoded the way browsers do before the site check", () => {
    const r = validateAuthorize(q({ return_to: `https://%6eotes.localhost${CB}`, state: STATE }), lookup())
    expect(r).toMatchObject({ ok: true, returnTo: `https://notes.localhost${CB}`, returnHost: "notes.localhost" })
  })

  const BAD_RETURN = [
    "http://notes.localhost/cb",
    "https://notes.localhost:8443/cb",
    "https://user@notes.localhost/cb",
    "https://user:pw@notes.localhost/cb",
    "https://notes.localhost/cb#frag",
    "https://notes.localhost/cb#",
    "javascript:alert(1)//https://notes.localhost/",
    "//evil.example/cb",
    "/_candy/auth/callback",
    "notes.localhost/cb",
    "https:notes.localhost/cb",
    "https:/notes.localhost/cb",
    "https:\\\\notes.localhost\\cb",
    "https://notes.localhost\\@evil.example/",
    "https://notes.localhost/c\nb",
    "https://notes.localhost/c\tb",
    "https://notes.localhost/c\rb",
    " https://notes.localhost/cb",
    "https://notes.localhost/cb ",
    "https://notes.localhost/c b",
    "https://notes.localhost/c\u0000b",
    "https://notes.localhost/c\u007fb",
    "https://notes.localhost/c b",
    "https://notes.localhost./cb",
    "https://127.0.0.1/cb",
    "https://[::1]/cb",
    "https://",
    "https:// /",
    "data:text/html,hi",
    "file:///etc/passwd",
    "wss://notes.localhost/cb",
    "",
    // Review finding: only the SDK's callback, exactly (a token POSTed anywhere else on the site could leak)
    "https://notes.localhost/cb",
    "https://notes.localhost/",
    "https://notes.localhost/some/redirect?to=https://evil.example",
    `https://notes.localhost${CB}?x=1`,
    `https://notes.localhost${CB}?`,
    `https://notes.localhost${CB}/`,
    `https://notes.localhost/_candy/auth/%63allback`,
    `https://notes.localhost/_CANDY/auth/callback`,
    `https://notes.localhost${CB}/../x`,
  ]
  for (const rt of BAD_RETURN) {
    it(`rejects return_to ${JSON.stringify(rt)}`, () => {
      const look = lookup()
      expect(validateAuthorize(q({ return_to: rt, state: STATE }), look)).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_RETURN })
      expect(look.asked).toEqual([])  // never even looked up
    })
  }

  it("rejects a missing return_to", () => {
    expect(validateAuthorize(q({ state: STATE }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_RETURN })
  })

  it("rejects an over-long return_to before parsing it", () => {
    const base = "https://notes.localhost/"
    const ok = base + "a".repeat(MAX_RETURN_TO - base.length)
    const look = lookup()
    expect(validateAuthorize(q({ return_to: ok + "a", state: STATE }), look)).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_RETURN })
    expect(validateAuthorize(q({ return_to: base + "a".repeat(1_000_000), state: STATE }), look).ok).toBe(false)
    expect(look.asked).toEqual([])
  })

  it("rejects a return_to whose normalized form grows past the cap", () => {
    // each space-free non-ASCII char is percent-encoded to 6 chars by the URL parser
    const rt = "https://notes.localhost/" + "é".repeat(1000)
    expect(rt.length).toBeLessThanOrEqual(MAX_RETURN_TO)
    expect(validateAuthorize(q({ return_to: rt, state: STATE }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_RETURN })
  })

  it("hosts candy does not route to a site are 404 (portal, shortcut, tunnel, unknown)", () => {
    for (const h of ["portal.localhost", "portal.candy", "victim.k.localhost", "notes.kill.localhost", "x.trycloudflare.com", "evil.example", "localhost"]) {
      expect(validateAuthorize(q({ return_to: `https://${h}${CB}`, state: STATE }), lookup())).toEqual({ ok: false, status: 404, error: AUTHZ_NOT_SITE })
    }
  })

  it("a site nobody owns any more is 404", () => {
    expect(validateAuthorize(good(), lookup(ROUTES, {}))).toEqual({ ok: false, status: 404, error: AUTHZ_NOT_SITE })
  })

  it("a lookup returning a name that is not a safe site name is 404", () => {
    for (const bad of ["", "Notes", "../x", "a".repeat(129), "_audit"]) {
      expect(validateAuthorize(good(), lookup({ "notes.localhost": bad }, { [bad]: "claude" }))).toEqual({ ok: false, status: 404, error: AUTHZ_NOT_SITE })
    }
  })

  it("an owner that is not a user name is 404", () => {
    expect(validateAuthorize(good(), lookup(ROUTES, { notes: "bad user" })).ok).toBe(false)
  })

  it("site=a with return_to on b is 400", () => {
    expect(validateAuthorize(good({ site: "blog" }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_SITE_MISMATCH })
    expect(validateAuthorize(good({ site: "NOTES" }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_SITE_MISMATCH })
    expect(validateAuthorize(good({ site: "" }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_SITE_MISMATCH })
    expect(validateAuthorize(good({ site: "notes" }), lookup()).ok).toBe(true)
  })

  for (const p of ["return_to", "state", "nonce", "site"]) {
    it(`a duplicated ${p} is 400`, () => {
      const params = good({ nonce: NONCE, site: "notes" })
      params.append(p, params.get(p)!)
      expect(validateAuthorize(params, lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_DUPLICATE })
    })
  }

  it("duplicates are refused even when the second copy would be valid and first-wins vs last-wins differ", () => {
    const params = q([["return_to", `https://notes.localhost${CB}`], ["return_to", `https://blog.localhost${CB}`], ["state", STATE]])
    expect(validateAuthorize(params, lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_DUPLICATE })
  })

  it("other parameters are ignored, even duplicated", () => {
    const params = good()
    params.append("response_mode", "query")
    params.append("response_mode", "fragment")
    params.append("prompt", "none")
    expect(validateAuthorize(params, lookup()).ok).toBe(true)
  })

  it("state must match STATE_RE", () => {
    for (const s of [null, "", "a".repeat(15), "a".repeat(257), "a".repeat(15) + "=", "a".repeat(15) + ".", "a".repeat(15) + " ", "ä".repeat(16)]) {
      const params = q({ return_to: `https://notes.localhost${CB}` })
      if (s !== null) params.set("state", s)
      expect(validateAuthorize(params, lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_STATE })
    }
    expect(validateAuthorize(good({ state: "a".repeat(256) }), lookup()).ok).toBe(true)
    expect(validateAuthorize(good({ state: "a".repeat(16) }), lookup()).ok).toBe(true)
  })

  it("nonce, when present, must match NONCE_RE", () => {
    for (const n of ["", "a".repeat(15), "a".repeat(129), "a".repeat(16) + "!"]) {
      expect(validateAuthorize(good({ nonce: n }), lookup())).toEqual({ ok: false, status: 400, error: AUTHZ_BAD_NONCE })
    }
    expect(validateAuthorize(good({ nonce: "a".repeat(128) }), lookup()).ok).toBe(true)
  })
})

describe("recheckRequest", () => {
  it("passes while the site has the same owner and the host still routes to it", () => {
    expect(recheckRequest(request(), lookup())).toEqual({ ok: true })
  })
  it("site gone → 404 expired", () => {
    expect(recheckRequest(request(), lookup(ROUTES, { blog: "ashwin" }))).toEqual({ ok: false, status: 404, error: AUTHZ_EXPIRED })
  })
  it("site now owned by someone else → 409 changed", () => {
    expect(recheckRequest(request(), lookup(ROUTES, { ...OWNERS, notes: "mallory" }))).toEqual({ ok: false, status: 409, error: AUTHZ_CHANGED })
  })
  it("return host no longer routed → 404; routed to another site → 409", () => {
    expect(recheckRequest(request(), lookup({ ...ROUTES, "notes.localhost": undefined as any }))).toEqual({ ok: false, status: 404, error: AUTHZ_EXPIRED })
    expect(recheckRequest(request(), lookup({ ...ROUTES, "notes.localhost": "blog" }))).toEqual({ ok: false, status: 409, error: AUTHZ_CHANGED })
  })
})

// ---------------------------------------------------------------------------

describe("AppKeyStore", () => {
  const make = (file: string | null = join(dir, "state", "keys.json"), overlapMs?: number) => {
    const clock = { t: T0 }
    const s = new AppKeyStore(file, { now: () => clock.t, overlapMs })
    return { s, clock, file: file as string }
  }

  it("ensure creates once and then returns the same ring", () => {
    const { s } = make(null)
    const a = s.ensure("notes", "claude")
    expect(a.created).toBe(true)
    expect(a.replaced).toBe(false)
    expect(a.ring).toHaveLength(1)
    expect(a.ring[0].kid).toMatch(KID_RE)
    expect(a.ring[0].key).toBeInstanceOf(Uint8Array)
    expect(a.ring[0].key.length).toBe(32)
    const b = s.ensure("notes", "claude")
    expect(b.created).toBe(false)
    expect(b.ring).toEqual(a.ring)
    expect(s.ring("notes", "claude")).toEqual(a.ring)
    expect(s.current("notes", "claude")).toEqual(a.ring[0])
  })

  it("each site gets its own key", () => {
    const { s } = make(null)
    const a = s.ensure("notes", "claude").ring[0]
    const b = s.ensure("blog", "claude").ring[0]
    expect(a.kid).not.toBe(b.kid)
    expect(b64urlEncode(a.key)).not.toBe(b64urlEncode(b.key))
  })

  it("an owner change replaces the whole ring", () => {
    const { s } = make(null)
    const old = s.ensure("notes", "claude").ring
    const r = s.ensure("notes", "mallory")
    expect(r.created).toBe(true)
    expect(r.replaced).toBe(true)
    expect(r.ring).toHaveLength(1)
    expect(r.ring[0].kid).not.toBe(old[0].kid)
    expect(s.ring("notes", "claude")).toBeNull()
    expect(s.current("notes", "claude")).toBeNull()
    expect(s.info("notes")!.owner).toBe("mallory")
  })

  it("ring/current for a missing site or another owner is null", () => {
    const { s } = make(null)
    expect(s.ring("notes", "claude")).toBeNull()
    expect(s.current("notes", "claude")).toBeNull()
    s.ensure("notes", "claude")
    expect(s.ring("notes", "ashwin")).toBeNull()
  })

  it("rotate puts a new key in front and keeps the old one until the overlap ends", () => {
    const { s, clock } = make(null)
    const [old] = s.ensure("notes", "claude").ring
    clock.t += MIN
    const ring = s.rotate("notes", "claude")
    expect(ring).toHaveLength(2)
    // The retired key carries its retirement time (unix s), so the SDK refuses tokens made with it later
    expect(ring[1]).toEqual({ ...old, retired: Math.floor((T0 + MIN) / 1000) })
    expect(ring[0].retired).toBeUndefined()
    expect(ring[0].kid).not.toBe(old.kid)
    expect(s.info("notes")).toEqual({ owner: "claude", kid: ring[0].kid, created: T0, rotatedAt: T0 + MIN })
    clock.t += ROTATION_OVERLAP_MS
    expect(s.ring("notes", "claude")).toHaveLength(2)   // exactly at the overlap: still there
    clock.t += 1
    expect(s.ring("notes", "claude")).toEqual([ring[0]])
    expect(s.info("notes")!.rotatedAt).toBe(T0 + MIN)   // remembered after the old key is gone
  })

  it("rotate never keeps more than MAX_RING_KEYS", () => {
    const { s } = make(null)
    s.ensure("notes", "claude")
    let ring: JweKey[] = []
    for (let i = 0; i < 10; i++) ring = s.rotate("notes", "claude")
    expect(ring).toHaveLength(MAX_RING_KEYS)
    expect(new Set(ring.map(k => k.kid)).size).toBe(MAX_RING_KEYS)
  })

  it("rotate on a missing ring creates one; on another owner's ring replaces it", () => {
    const { s } = make(null)
    expect(s.rotate("notes", "claude")).toHaveLength(1)
    expect(s.info("notes")!.owner).toBe("claude")
    const r = s.rotate("notes", "mallory")
    expect(r).toHaveLength(1)
    expect(s.ring("notes", "claude")).toBeNull()
    expect(s.ring("notes", "mallory")).toEqual(r)
  })

  it("drop, info and sites", () => {
    const { s } = make(null)
    s.ensure("notes", "claude")
    s.ensure("blog", "ashwin")
    expect(s.sites()).toEqual(["blog", "notes"])
    expect(s.info("notes")).toMatchObject({ owner: "claude", created: T0, rotatedAt: null })
    expect(s.info("nope")).toBeNull()
    expect(s.drop("notes")).toBe(true)
    expect(s.drop("notes")).toBe(false)
    expect(s.sites()).toEqual(["blog"])
    expect(s.ring("notes", "claude")).toBeNull()
  })

  it("refuses invalid site names and owners", () => {
    const { s } = make(null)
    for (const site of ["", "Notes", "a/b", "_audit", ".x", "x.", "a".repeat(129), "a b"]) {
      expect(() => s.ensure(site, "claude")).toThrow()
    }
    for (const owner of ["", "Bad User", "a".repeat(40), "0abc"]) {
      expect(() => s.ensure("notes", owner)).toThrow()
    }
    expect(s.size).toBe(0)
  })

  it("throws past MAX_SITES, but an existing site still works", () => {
    const { s } = make(null)
    for (let i = 0; i < MAX_SITES; i++) s.ensure(`s${i}`, "claude")
    expect(() => s.ensure("one-more", "claude")).toThrow("too many sites with auth keys")
    expect(s.ensure("s0", "claude").created).toBe(false)
    expect(s.ensure("s1", "mallory").created).toBe(true)   // replacing doesn't add a site
    s.drop("s2")
    expect(s.ensure("one-more", "claude").created).toBe(true)
  })

  it("persists atomically to a 0600 file in a 0700 dir and reloads the same keys", () => {
    const { s, file } = make()
    const a = s.ensure("notes", "claude").ring
    s.rotate("blog", "ashwin")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(dir, "state"))).toEqual(["keys.json"])   // no temp files left
    const raw = JSON.parse(readFileSync(file, "utf8"))
    expect(raw.version).toBe(1)
    expect(raw.sites.notes.owner).toBe("claude")
    const again = new AppKeyStore(file, { now: () => T0 })
    expect(again.discarded).toBe(false)
    expect(again.ring("notes", "claude")).toEqual(a)
    expect(again.sites()).toEqual(["blog", "notes"])
  })

  it("prunes retired keys on load", () => {
    const { s, clock, file } = make()
    s.ensure("notes", "claude")
    clock.t += MIN
    const ring = s.rotate("notes", "claude")
    const later = new AppKeyStore(file, { now: () => T0 + MIN + ROTATION_OVERLAP_MS + 1 })
    expect(later.ring("notes", "claude")).toEqual([ring[0]])
  })

  for (const mode of [0o640, 0o604, 0o660, 0o606, 0o610]) {
    it(`discards a file with mode ${mode.toString(8)}`, () => {
      const { s, file } = make()
      s.ensure("notes", "claude")
      chmodSync(file, mode)
      const again = new AppKeyStore(file, { now: () => T0 })
      expect(again.discarded).toBe(true)
      expect(again.sites()).toEqual([])
      // the next save replaces it with a private file and fresh keys
      const fresh = again.ensure("notes", "claude")
      expect(fresh.created).toBe(true)
      expect(statSync(file).mode & 0o777).toBe(0o600)
    })
  }

  it("a missing or corrupt file starts empty without discarding", () => {
    expect(new AppKeyStore(join(dir, "nope.json")).discarded).toBe(false)
    const f = join(dir, "corrupt.json")
    writeFileSync(f, "{not json", { mode: 0o600 })
    const s = new AppKeyStore(f)
    expect(s.discarded).toBe(false)
    expect(s.size).toBe(0)
  })

  it("drops every invalid ring on load and keeps the valid ones", () => {
    const f = join(dir, "keys.json")
    const k = () => { const g = generateKey(); return { kid: g.kid, key: b64urlEncode(g.key), created: T0, retiredAt: null as number | null } }
    const ret = () => ({ ...k(), retiredAt: T0 })
    const good1 = { owner: "claude", keys: [k()] }
    const dupKid = k()
    const sites: Record<string, unknown> = {
      notes: good1,
      "Bad-Name": { owner: "claude", keys: [k()] },
      "_audit": { owner: "claude", keys: [k()] },
      badowner: { owner: "Not A User", keys: [k()] },
      nokeys: { owner: "claude", keys: [] },
      notarray: { owner: "claude", keys: "x" },
      toomany: { owner: "claude", keys: [k(), ret(), ret(), ret(), ret()] },
      dupkid: { owner: "claude", keys: [dupKid, { ...dupKid, retiredAt: T0 }] },
      shortkid: { owner: "claude", keys: [{ ...k(), kid: "short" }] },
      badkidchars: { owner: "claude", keys: [{ ...k(), kid: "abc/def+ghi" }] },
      shortkey: { owner: "claude", keys: [{ ...k(), key: b64urlEncode(new Uint8Array(31)) }] },
      longkey: { owner: "claude", keys: [{ ...k(), key: b64urlEncode(new Uint8Array(33)) }] },
      notb64: { owner: "claude", keys: [{ ...k(), key: "!".repeat(43) }] },
      padded: { owner: "claude", keys: [{ ...k(), key: b64urlEncode(new Uint8Array(32)) + "=" }] },
      currentretired: { owner: "claude", keys: [ret()] },
      oldunretired: { owner: "claude", keys: [k(), k()] },
      badcreated: { owner: "claude", keys: [{ ...k(), created: "yesterday" }] },
      negcreated: { owner: "claude", keys: [{ ...k(), created: -1 }] },
      nullentry: null,
      arrayentry: [],
      keynull: { owner: "claude", keys: [null] },
    }
    writeFileSync(f, JSON.stringify({ version: 1, sites }), { mode: 0o600 })
    const s = new AppKeyStore(f, { now: () => T0 })
    expect(s.sites()).toEqual(["notes"])
    expect(s.ring("notes", "claude")![0].kid).toBe(good1.keys[0].kid)
  })

  it("ignores a file whose sites field is the wrong type", () => {
    const f = join(dir, "keys.json")
    for (const v of [null, [], "x", 1]) {
      writeFileSync(f, JSON.stringify({ version: 1, sites: v }), { mode: 0o600 })
      expect(new AppKeyStore(f).size).toBe(0)
    }
  })

  it("a save failure is logged, not thrown", () => {
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "x")
    const s = new AppKeyStore(join(blocker, "keys.json"))
    const orig = console.error
    const errs: string[] = []
    console.error = (m: string) => errs.push(m)
    try {
      expect(s.ensure("notes", "claude").created).toBe(true)
    } finally {
      console.error = orig
    }
    expect(errs.join("\n")).toContain("Could not save app auth keys")
    expect(errs.join("\n")).not.toContain(b64urlEncode(s.current("notes", "claude")!.key))
  })
})

// ---------------------------------------------------------------------------

describe("ConsentStore", () => {
  const make = (file: string | null = join(dir, "state", "consent.json"), ttlMs?: number) => {
    const clock = { t: T0 }
    const s = new ConsentStore(file, { now: () => clock.t, ttlMs })
    return { s, clock, file: file as string }
  }

  it("remembers per user + site + owner", () => {
    const { s } = make(null)
    expect(s.has("ashwin", "notes", "claude")).toBe(false)
    s.remember("ashwin", "notes", "claude")
    expect(s.has("ashwin", "notes", "claude")).toBe(true)
    expect(s.has("ashwin", "notes", "mallory")).toBe(false)   // a different owner
    expect(s.has("bob", "notes", "claude")).toBe(false)
    expect(s.has("ashwin", "blog", "claude")).toBe(false)
  })

  it("expires after the ttl and remember refreshes it", () => {
    const { s, clock } = make(null)
    s.remember("ashwin", "notes", "claude")
    clock.t += CONSENT_TTL_MS - 1
    expect(s.has("ashwin", "notes", "claude")).toBe(true)
    s.remember("ashwin", "notes", "claude")
    clock.t += CONSENT_TTL_MS - 1
    expect(s.has("ashwin", "notes", "claude")).toBe(true)
    clock.t += 1
    expect(s.has("ashwin", "notes", "claude")).toBe(false)
    expect(s.list("ashwin")).toEqual([])
  })

  it("remember with a new owner replaces the old consent", () => {
    const { s } = make(null)
    s.remember("ashwin", "notes", "claude")
    s.remember("ashwin", "notes", "mallory")
    expect(s.has("ashwin", "notes", "claude")).toBe(false)
    expect(s.has("ashwin", "notes", "mallory")).toBe(true)
    expect(s.size).toBe(1)
  })

  it("revoke, dropSite, dropUser and list", () => {
    const { s, clock } = make(null)
    s.remember("ashwin", "notes", "claude")
    clock.t += 1
    s.remember("ashwin", "blog", "ashwin")
    s.remember("bob", "notes", "claude")
    expect(s.list("ashwin")).toEqual([{ site: "notes", owner: "claude", at: T0 }, { site: "blog", owner: "ashwin", at: T0 + 1 }])
    expect(s.revoke("ashwin", "blog")).toBe(true)
    expect(s.revoke("ashwin", "blog")).toBe(false)
    expect(s.dropSite("notes")).toBe(2)
    expect(s.has("bob", "notes", "claude")).toBe(false)
    s.remember("bob", "x", "claude")
    s.remember("bob", "y", "claude")
    expect(s.dropUser("bob")).toBe(2)
    expect(s.size).toBe(0)
  })

  it("refuses invalid input to remember; has() is just false for it", () => {
    const { s } = make(null)
    expect(() => s.remember("Bad User", "notes", "claude")).toThrow()
    expect(() => s.remember("ashwin", "../notes", "claude")).toThrow()
    expect(() => s.remember("ashwin", "notes", "")).toThrow()
    expect(s.has("Bad User", "notes", "claude")).toBe(false)
    expect(s.size).toBe(0)
  })

  it("the user/site key can't be confused by a separator inside a name", () => {
    const { s } = make(null)
    s.remember("ab", "c", "claude")
    expect(s.has("a", "bc", "claude")).toBe(false)
  })

  it("keeps at most MAX_CONSENTS, dropping the oldest", () => {
    const { s, clock } = make(null)
    for (let i = 0; i <= MAX_CONSENTS; i++) { s.remember("ashwin", `s${i}`, "claude"); clock.t++ }
    expect(s.size).toBe(MAX_CONSENTS)
    expect(s.has("ashwin", "s0", "claude")).toBe(false)
    expect(s.has("ashwin", "s1", "claude")).toBe(true)
    expect(s.has("ashwin", `s${MAX_CONSENTS}`, "claude")).toBe(true)
  })

  it("persists to a 0600 file and reloads", () => {
    const { s, file } = make()
    s.remember("ashwin", "notes", "claude")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, consents: [{ user: "ashwin", site: "notes", owner: "claude", at: T0 }] })
    const again = new ConsentStore(file, { now: () => T0 + 5 })
    expect(again.has("ashwin", "notes", "claude")).toBe(true)
  })

  it("refuses a group- or other-writable file", () => {
    for (const mode of [0o620, 0o602, 0o666]) {
      const { s, file } = make()
      s.remember("ashwin", "notes", "claude")
      chmodSync(file, mode)
      expect(new ConsentStore(file, { now: () => T0 }).has("ashwin", "notes", "claude")).toBe(false)
      rmSync(file)
    }
  })

  it("a group-readable (not writable) consent file is still used", () => {
    const { s, file } = make()
    s.remember("ashwin", "notes", "claude")
    chmodSync(file, 0o640)
    expect(new ConsentStore(file, { now: () => T0 }).has("ashwin", "notes", "claude")).toBe(true)
  })

  it("drops invalid, expired and future entries on load", () => {
    const f = join(dir, "consent.json")
    const consents = [
      { user: "ashwin", site: "notes", owner: "claude", at: T0 - 1000 },
      { user: "Bad User", site: "notes", owner: "claude", at: T0 },
      { user: "ashwin", site: "_audit", owner: "claude", at: T0 },
      { user: "ashwin", site: "blog", owner: 5, at: T0 },
      { user: "ashwin", site: "wiki", owner: "claude", at: "now" },
      { user: "ashwin", site: "old", owner: "claude", at: T0 - CONSENT_TTL_MS },
      { user: "ashwin", site: "future", owner: "claude", at: T0 + 60 * MIN },
      null, 7, "x",
    ]
    writeFileSync(f, JSON.stringify({ version: 1, consents }), { mode: 0o600 })
    const s = new ConsentStore(f, { now: () => T0 })
    expect(s.list("ashwin")).toEqual([{ site: "notes", owner: "claude", at: T0 - 1000 }])
    expect(s.size).toBe(1)
  })

  it("a corrupt or wrongly shaped file starts empty", () => {
    const f = join(dir, "consent.json")
    for (const body of ["{", "null", "[]", JSON.stringify({ consents: {} })]) {
      writeFileSync(f, body, { mode: 0o600 })
      expect(new ConsentStore(f).size).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------

describe("PendingRequests", () => {
  const base = (): Omit<AuthorizeRequest, "id" | "created"> => {
    const { id, created, ...r } = request()
    return r
  }
  const make = (opts: { ttlMs?: number; maxUsed?: number } = {}) => {
    const clock = { t: T0 }
    return { p: new PendingRequests({ now: () => clock.t, ...opts }), clock }
  }

  it("park seals the request into a random id; get does not consume; take is single use", () => {
    const { p } = make()
    const r = p.park(base())
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(r.created).toBe(T0)
    expect(r).toMatchObject(base())
    expect(p.park(base()).id).not.toBe(r.id)
    expect(p.get(r.id)).toEqual(r)
    expect(p.get(r.id)).toEqual(r)
    expect(p.take(r.id)).toEqual(r)
    expect(p.take(r.id)).toBeNull()
    expect(p.get(r.id)).toBeNull()
  })

  it("the id shows nothing of the request (state, nonce, return_to)", () => {
    const { p } = make()
    const r = p.park(base())
    const raw = Buffer.from(r.id, "base64url").toString("latin1")
    for (const secret of [STATE, NONCE, "notes.localhost", "claude"]) expect(raw).not.toContain(secret)
  })

  it("returns copies: changing one doesn't change the parked request", () => {
    const { p } = make()
    const r = p.park(base())
    r.returnTo = "https://evil.example/"
    p.get(r.id)!.state = "x"
    expect(p.take(r.id)!).toMatchObject({ returnTo: base().returnTo, state: STATE })
  })

  it("expires after the ttl", () => {
    const { p, clock } = make()
    const r = p.park(base())
    clock.t += PENDING_TTL_MS - 1
    expect(p.get(r.id)).not.toBeNull()
    clock.t += 1
    expect(p.get(r.id)).toBeNull()
    expect(p.take(r.id)).toBeNull()
    expect(p.size).toBe(0)
  })

  it("sweep forgets used ids once they expired", () => {
    const { p, clock } = make()
    p.take(p.park(base()).id)
    clock.t += MIN
    p.take(p.park(base()).id)
    expect(p.size).toBe(2)
    clock.t += PENDING_TTL_MS - MIN
    expect(p.sweep()).toBe(1)
    expect(p.size).toBe(1)
  })

  // Review finding: parks from one address (all of loopback through Caddy, or
  // <img> tags on any page) evicted everyone's pending sign-in
  it("no number of parks, from any address, pushes out an earlier request", () => {
    const { p, clock } = make()
    const victim = p.park({ ...base(), ip: "127.0.0.1" })
    for (let i = 0; i < 5000; i++) { p.park({ ...base(), ip: i % 2 ? "127.0.0.1" : `10.0.${i >> 8}.${i & 255}` }); clock.t++ }
    expect(p.get(victim.id)).toMatchObject({ state: STATE })
    expect(p.size).toBe(0)                    // parking stores nothing
    expect(p.take(victim.id)).not.toBeNull()
  })

  it("an id from another process (another key) or a tampered one opens nothing", () => {
    const { p } = make()
    const other = make().p.park(base())
    expect(p.get(other.id)).toBeNull()
    const r = p.park(base())
    const bytes = Buffer.from(r.id, "base64url")
    bytes[bytes.length - 20] ^= 1
    expect(p.get(bytes.toString("base64url"))).toBeNull()
    expect(p.get(r.id)).not.toBeNull()
  })

  it(`remembers at most ${MAX_PENDING_USED} used ids and fails closed when full: a used id never comes back`, () => {
    const { p, clock } = make({ maxUsed: 3 })
    const ids = [1, 2, 3, 4].map(() => { const id = p.park(base()).id; clock.t++; return id })
    expect(p.take(ids[0], "u1")).not.toBeNull()
    expect(p.take(ids[1], "u2")).not.toBeNull()
    expect(p.take(ids[2], "u3")).not.toBeNull()
    expect(p.size).toBe(3)
    // Full of live used ids: the fourth can't be recorded, so it is refused (and nothing was evicted)
    expect(p.take(ids[3], "u4")).toBeNull()
    expect(p.take(ids[0], "u1")).toBeNull()
    expect(p.size).toBe(3)
  })

  it("one user may use up only a share of the used set (review finding: no cheap flood for everyone)", () => {
    const { p } = make({ maxUsed: 100 })   // share: 5
    const mine = Array.from({ length: 6 }, () => p.park(base()).id)
    expect(mine.slice(0, 5).every(id => p.take(id, "mallory") !== null)).toBe(true)
    expect(p.take(mine[5], "mallory")).toBeNull()
    expect(p.take(p.park(base()).id, "ashwin")).not.toBeNull()
  })

  it("hostile ids get null and change nothing", () => {
    const { p } = make()
    const r = p.park(base())
    for (const id of [undefined, null, 1, {}, [r.id], "", "x", r.id + "x", r.id.slice(1), "a".repeat(100_000), { toString: () => r.id }, r.id + "=", r.id.replace(/./, "!")]) {
      expect(p.get(id)).toBeNull()
      expect(p.take(id)).toBeNull()
    }
    expect(p.size).toBe(0)
    expect(p.get(r.id)).not.toBeNull()
  })

  it("clips an absurd ip so it can't bloat the id", () => {
    const { p } = make()
    expect(p.park({ ...base(), ip: "x".repeat(10_000) }).ip.length).toBe(64)
  })
})

// ---------------------------------------------------------------------------

describe("mintAppToken", () => {
  const nowS = Math.floor(T0 / 1000)

  it("opens with openClaims for aud = site and carries exactly the documented claims", async () => {
    const key = generateKey()
    const { token, claims } = await mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0 - 3 * MIN + 999, superuser: false, key, now: T0 + 500 })
    expect(claims).toEqual({
      iss: ISS, aud: "notes", sub: "ashwin", amr: ["pam"],
      iat: nowS, exp: nowS + DEFAULT_TTL_S, auth_time: nowS - 180, superuser: false,
      jti: claims.jti, state: STATE, nonce: NONCE, dest: "https://notes.localhost/_candy/auth/callback",
    })
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const opened = await openClaims(token, [key], { aud: "notes", issuers: [ISS], now: nowS })
    expect(opened).toEqual(claims)
  })

  it("carries superuser as given (the route asks isSuperuser at mint time) and refuses a non-boolean", async () => {
    const key = generateKey()
    const su = await mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0, superuser: true, key, now: T0 })
    expect((await openClaims(su.token, [key], { aud: "notes", issuers: [ISS], now: nowS })).superuser).toBe(true)
    await expect(mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0, superuser: "yes" as any, key, now: T0 })).rejects.toThrow()
  })

  it("leaves nonce out when the request had none; passkey amr", async () => {
    const key = generateKey()
    const { token, claims } = await mintAppToken({ req: request({ nonce: null }), user: "claude", amr: "passkey", authAt: T0, superuser: false, key, now: T0 })
    expect("nonce" in claims).toBe(false)
    const opened = await openClaims(token, [key], { aud: "notes", issuers: [ISS], now: nowS })
    expect(opened.amr).toEqual(["passkey"])
    expect("nonce" in opened).toBe(false)
  })

  it("a fresh jti and a fresh ciphertext each time", async () => {
    const key = generateKey()
    const o = { req: request(), user: "ashwin", amr: "pam" as const, authAt: T0, superuser: false, key, now: T0 }
    const a = await mintAppToken(o)
    const b = await mintAppToken(o)
    expect(a.claims.jti).not.toBe(b.claims.jti)
    expect(a.token).not.toBe(b.token)
  })

  it("is useless at another site: its ring, the same kid with another key, or the wrong aud", async () => {
    const notesKey = generateKey()
    const blogKey = generateKey()
    const { token } = await mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0, superuser: false, key: notesKey, now: T0 })
    await expectJweError(openClaims(token, [blogKey], { aud: "blog", issuers: [ISS], now: nowS }), "unknown_kid")
    await expectJweError(openClaims(token, [{ kid: notesKey.kid, key: blogKey.key }], { aud: "notes", issuers: [ISS], now: nowS }), "decrypt")
    await expectJweError(openClaims(token, [notesKey], { aud: "blog", issuers: [ISS], now: nowS }), "audience")
    await expectJweError(openClaims(token, [notesKey], { aud: "notes", issuers: ["https://portal.candy"], now: nowS }), "issuer")
  })

  it("works with keys from AppKeyStore, across rotation, and not for another site's ring", async () => {
    const clock = { t: T0 }
    const keys = new AppKeyStore(null, { now: () => clock.t })
    const k1 = keys.ensure("notes", "claude").ring[0]
    keys.ensure("blog", "ashwin")
    const { token } = await mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0, superuser: false, key: keys.current("notes", "claude")!, now: T0 })
    keys.rotate("notes", "claude")
    expect(keys.current("notes", "claude")!.kid).not.toBe(k1.kid)
    expect((await openClaims(token, keys.ring("notes", "claude")!, { aud: "notes", issuers: [ISS], now: nowS })).sub).toBe("ashwin")
    await expectJweError(openClaims(token, keys.ring("blog", "ashwin")!, { aud: "notes", issuers: [ISS], now: nowS }), "unknown_kid")
    clock.t += ROTATION_OVERLAP_MS + 1
    await expectJweError(openClaims(token, keys.ring("notes", "claude")!, { aud: "notes", issuers: [ISS], now: nowS }), "unknown_kid")
  })

  it("expires: ok until exp + skew - 1, expired at exp + skew", async () => {
    const key = generateKey()
    const { token, claims } = await mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0, superuser: false, key, now: T0 })
    expect((await openClaims(token, [key], { aud: "notes", issuers: [ISS], now: claims.exp + CLOCK_SKEW_S - 1 })).sub).toBe("ashwin")
    await expectJweError(openClaims(token, [key], { aud: "notes", issuers: [ISS], now: claims.exp + CLOCK_SKEW_S }), "expired")
  })

  it("tampered, truncated and oversized tokens fail", async () => {
    const key = generateKey()
    const { token } = await mintAppToken({ req: request(), user: "ashwin", amr: "pam", authAt: T0, superuser: false, key, now: T0 })
    const parts = token.split(".")
    expect(parts).toHaveLength(5)
    expect(parts[1]).toBe("")
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1)
    const open = (t: string) => openClaims(t, [key], { aud: "notes", issuers: [ISS], now: nowS })
    // one changed ciphertext / tag / iv byte → decrypt
    await expectJweError(open([parts[0], "", parts[2], flip(parts[3], 5), parts[4]].join(".")), "decrypt")
    await expectJweError(open([parts[0], "", parts[2], parts[3], flip(parts[4], 3)].join(".")), "decrypt")
    await expectJweError(open([parts[0], "", flip(parts[2], 2), parts[3], parts[4]].join(".")), "decrypt")
    await expect(open(token.slice(0, -10))).rejects.toBeInstanceOf(JweError)
    await expect(open(parts.slice(0, 4).join("."))).rejects.toBeInstanceOf(JweError)
    await expectJweError(open(token + "A".repeat(4096)), "malformed")
    await expectJweError(open(""), "malformed")
  })

  it("refuses to mint claims that aren't valid (bad user, too long a ttl, bad state, non-https dest)", async () => {
    const key = generateKey()
    const base = { req: request(), user: "ashwin", amr: "pam" as const, authAt: T0, superuser: false, key, now: T0 }
    await expectJweError(mintAppToken({ ...base, user: "Not A User" }), "claims")
    await expectJweError(mintAppToken({ ...base, ttlS: 301 }), "claims")
    await expectJweError(mintAppToken({ ...base, ttlS: 0 }), "claims")
    await expectJweError(mintAppToken({ ...base, req: request({ state: "short" }) }), "claims")
    await expectJweError(mintAppToken({ ...base, req: request({ returnTo: "http://notes.localhost/cb" }) }), "claims")
    await expect(mintAppToken({ ...base, amr: "password" as any })).rejects.toThrow()
    expect((await mintAppToken({ ...base, ttlS: 300 })).claims.exp).toBe(Math.floor(T0 / 1000) + 300)
  })
})

describe("successReturn / errorReturn", () => {
  it("post the token and state to return_to", () => {
    expect(successReturn(request(), "TOKEN")).toEqual({
      action: "https://notes.localhost/_candy/auth/callback",
      fields: { candy_token: "TOKEN", state: STATE },
    })
  })
  it("post access_denied and state, never a token", () => {
    const f = errorReturn(request(), "access_denied")
    expect(f).toEqual({ action: "https://notes.localhost/_candy/auth/callback", fields: { error: "access_denied", state: STATE } })
    expect("candy_token" in f.fields).toBe(false)
    expect(() => errorReturn(request(), "server_error" as any)).toThrow()
  })
})

describe("consentView", () => {
  it("names the site, its owner and the exact return host, and nothing secret", () => {
    const v = consentView(request(), "ashwin", false, "pam")
    expect(v).toEqual({
      request: "R".repeat(32), site: "notes", owner: "claude", ownerIsYou: false, user: "ashwin",
      returnHost: "notes.localhost", returnOrigin: "https://notes.localhost", hostKind: "local", remembered: false, amr: "pam",
      fresh: { needed: false, passkeys: false, maxAge: null },
    })
    const s = JSON.stringify(v)
    expect(s).not.toContain(STATE)
    expect(s).not.toContain(NONCE)
  })
  it("ownerIsYou and the host kind", () => {
    const v = consentView(request({ owner: "ashwin", returnTo: "https://blog.example.com/cb", returnHost: "blog.example.com" }), "ashwin", true, "passkey")
    expect(v).toMatchObject({ ownerIsYou: true, hostKind: "domain", returnOrigin: "https://blog.example.com", remembered: true, amr: "passkey" })
  })
})

describe("hostKind", () => {
  it("classifies .localhost, .candy and everything else", () => {
    expect(hostKind("notes.localhost")).toBe("local")
    expect(hostKind("NOTES.LOCALHOST")).toBe("local")
    expect(hostKind("notes.box.candy")).toBe("tailnet")
    expect(hostKind("notes.candy.")).toBe("tailnet")
    expect(hostKind("blog.example.com")).toBe("domain")
    expect(hostKind("localhost.example.com")).toBe("domain")
    expect(hostKind("evilcandy")).toBe("domain")
  })
})

describe("mayFetchSiteKey", () => {
  it("only the owner's API key", () => {
    expect(mayFetchSiteKey({ user: "claude", via: "apikey" }, "claude")).toBe(true)
    expect(mayFetchSiteKey({ user: "ashwin", via: "apikey" }, "claude")).toBe(false)
    expect(mayFetchSiteKey({ user: "claude", via: "portal" }, "claude")).toBe(false)
    expect(mayFetchSiteKey({ user: "ashwin", via: "portal", superuser: true } as any, "claude")).toBe(false)
    expect(mayFetchSiteKey({ user: "claude", via: "oauth" }, "claude")).toBe(false)
    expect(mayFetchSiteKey(null, "claude")).toBe(false)
    expect(mayFetchSiteKey({ user: "", via: "apikey" }, "")).toBe(false)
    expect(mayFetchSiteKey({ user: "claude", via: "APIKEY" as any }, "claude")).toBe(false)
  })
})

describe("issuersFor", () => {
  it("https origins, lower case, deduped, invalid hosts skipped", () => {
    expect(issuersFor(["portal.localhost", "Portal.Candy", "portal.candy", "portal.box.candy", "portal.localhost."]))
      .toEqual(["https://portal.localhost", "https://portal.candy", "https://portal.box.candy"])
    expect(issuersFor(["", "portal.localhost:8443", "evil/x", "a b", "user@host", 5 as any, "https://portal.localhost"])).toEqual([])
  })
})


describe("freshnessOk (max_age)", () => {
  const S = (authAt: number, freshFor: string | null = null) => ({ authAt, freshFor })
  it("no max_age: anything goes", () => {
    expect(freshnessOk(request(), S(0), T0)).toBe(true)
  })
  it("max_age > 0: the latest authentication within it, or one made for this request after it was parked", () => {
    const r = request({ maxAge: 300, created: T0 })
    expect(freshnessOk(r, S(T0 - 300_000), T0)).toBe(true)
    expect(freshnessOk(r, S(T0 - 300_001), T0)).toBe(false)
    expect(freshnessOk(r, S(T0 + 10, freshKey(r.id)), T0 + 400_000)).toBe(true)
  })
  it("max_age = 0: only a fresh authentication bound to this very request, made after it was parked", () => {
    const r = request({ maxAge: 0, created: T0 })
    expect(freshnessOk(r, S(T0), T0)).toBe(false)
    expect(freshnessOk(r, S(T0 + 5, freshKey(r.id)), T0 + 5)).toBe(true)
    // made for another request, or before this one was parked
    expect(freshnessOk(r, S(T0 + 5, freshKey("another-request")), T0 + 5)).toBe(false)
    expect(freshnessOk(r, S(T0 - 1, freshKey(r.id)), T0 + 5)).toBe(false)
  })
  it("freshKey hides the request id", () => {
    expect(freshKey("R".repeat(32))).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(freshKey("R".repeat(32))).not.toContain("RRRR")
  })
})
