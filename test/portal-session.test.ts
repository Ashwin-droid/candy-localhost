import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PortalSessions, readSessionCookie, sessionCookieHeader, clearSessionCookieHeader,
  DEFAULT_IDLE_MS, DEFAULT_MAX_MS, MAX_SESSIONS, MAX_SESSIONS_PER_USER,
} from "../portal-session.ts"

const T0 = 1_800_000_000_000
const MIN = 60 * 1000
const HOUR = 60 * MIN
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex")

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "candy-sessions-"))
  file = join(dir, "state", "portal-sessions.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const make = (f: string | null = file, opts: { idleMs?: number; maxMs?: number } = {}) => {
  const clock = { t: T0 }
  const s = new PortalSessions(f, { ...opts, now: () => clock.t })
  return { s, clock }
}

describe("create and get", () => {
  it("returns the session for its cookie and nothing for anything else", () => {
    const { s } = make(null)
    const { id, cookie, secret } = s.create("alice", { ip: "127.0.0.1", ua: "test" })
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.get(cookie, secret)).toEqual({ id, user: "alice", created: T0, lastSeen: T0, amr: "pam", pamAt: T0 })
    expect(s.get(cookie + "x", secret)).toBeNull()
    expect(s.get("", secret)).toBeNull()
    expect(s.get(null, secret)).toBeNull()
    expect(s.get(undefined, secret)).toBeNull()
    expect(s.get("a".repeat(10_000), secret)).toBeNull()
  })

  it("gives every login its own id and cookie", () => {
    const { s } = make(null)
    const a = s.create("alice")
    const b = s.create("alice")
    expect(a.id).not.toBe(b.id)
    expect(a.cookie).not.toBe(b.cookie)
    expect(s.size).toBe(2)
  })

  it("refuses names that can't be accounts", () => {
    const { s } = make(null)
    for (const bad of ["", "Root;rm", "a b", "../x", "-x", "x".repeat(40)]) expect(() => s.create(bad)).toThrow()
  })
})

describe("expiry", () => {
  it("defaults to 24h idle and 7 days max", () => {
    expect(DEFAULT_IDLE_MS).toBe(24 * HOUR)
    expect(DEFAULT_MAX_MS).toBe(7 * 24 * HOUR)
  })

  it("expires after the idle time without a request", () => {
    const { s, clock } = make(null, { idleMs: HOUR, maxMs: 10 * HOUR })
    const { cookie, secret } = s.create("alice")
    clock.t += HOUR - 1
    expect(s.get(cookie, secret)).not.toBeNull()
    clock.t += HOUR  // an hour after that last request
    expect(s.get(cookie, secret)).toBeNull()
    expect(s.size).toBe(0)
  })

  it("slides lastSeen on every get", () => {
    const { s, clock } = make(null, { idleMs: HOUR, maxMs: 100 * HOUR })
    const { cookie, secret } = s.create("alice")
    for (let i = 0; i < 5; i++) {
      clock.t += 50 * MIN
      expect(s.get(cookie, secret)?.lastSeen).toBe(clock.t)
    }
    expect(clock.t - T0).toBeGreaterThan(HOUR)
  })

  it("ends at the max age however active it is", () => {
    const { s, clock } = make(null, { idleMs: HOUR, maxMs: 3 * HOUR })
    const { cookie, secret } = s.create("alice")
    while (clock.t < T0 + 3 * HOUR - 30 * MIN) {
      clock.t += 30 * MIN
      expect(s.get(cookie, secret)).not.toBeNull()
    }
    clock.t = T0 + 3 * HOUR
    expect(s.get(cookie, secret)).toBeNull()
  })

  it("never moves lastSeen backwards when the clock does", () => {
    const { s, clock } = make(null)
    const { cookie, secret } = s.create("alice")
    clock.t += 10 * MIN
    s.get(cookie, secret)
    clock.t -= 5 * MIN
    expect(s.get(cookie, secret)?.lastSeen).toBe(T0 + 10 * MIN)
  })

  it("sweep drops only expired sessions", () => {
    const { s, clock } = make(null, { idleMs: HOUR })
    const old = s.create("alice")
    clock.t += 50 * MIN
    const fresh = s.create("bob")
    clock.t += 20 * MIN
    expect(s.sweep()).toBe(1)
    expect(s.get(old.cookie, old.secret)).toBeNull()
    expect(s.get(fresh.cookie, fresh.secret)?.user).toBe("bob")
    expect(s.sweep()).toBe(0)
  })

  it("alive reports without sliding", () => {
    const { s, clock } = make(null, { idleMs: HOUR })
    const { id, cookie, secret } = s.create("alice")
    expect(s.alive(id)).toBe(true)
    clock.t += 30 * MIN
    expect(s.alive(id)).toBe(true)
    clock.t += 31 * MIN
    expect(s.alive(id)).toBe(false)
    expect(s.get(cookie, secret)).toBeNull()
    expect(s.alive("nope")).toBe(false)
  })
})

describe("destroy", () => {
  it("destroy ends one session", () => {
    const { s } = make(null)
    const a = s.create("alice")
    const b = s.create("alice")
    expect(s.destroy(a.id)).toBe(true)
    expect(s.destroy(a.id)).toBe(false)
    expect(s.get(a.cookie, a.secret)).toBeNull()
    expect(s.get(b.cookie, b.secret)).not.toBeNull()
  })

  it("destroyUser ends every session of that user only", () => {
    const { s } = make(file)
    const a1 = s.create("alice")
    const a2 = s.create("alice")
    const b = s.create("bob")
    expect(s.destroyUser("alice")).toBe(2)
    expect(s.destroyUser("alice")).toBe(0)
    expect(s.get(a1.cookie, a1.secret)).toBeNull()
    expect(s.get(a2.cookie, a2.secret)).toBeNull()
    expect(s.get(b.cookie, b.secret)?.user).toBe("bob")
    // and it sticks across a restart
    const { s: again } = make(file)
    expect(again.get(a1.cookie, a1.secret)).toBeNull()
    expect(again.get(b.cookie, b.secret)?.user).toBe("bob")
  })

  it("keeps at most MAX_SESSIONS, dropping the oldest", () => {
    const { s } = make(null)
    const first = s.create("alice")
    for (let i = 0; i < MAX_SESSIONS; i++) s.create(`u${i}`)
    expect(s.size).toBe(MAX_SESSIONS)
    expect(s.get(first.cookie, first.secret)).toBeNull()
  })
})

describe("persistence", () => {
  it("survives a restart", () => {
    const { s } = make(file)
    const { id, cookie, secret } = s.create("alice", { ip: "100.64.0.1", ua: "firefox" })
    const { s: again } = make(file)
    expect(again.get(cookie, secret)).toEqual({ id, user: "alice", created: T0, lastSeen: T0, amr: "pam", pamAt: T0 })
    expect(again.list()[0]).toMatchObject({ ip: "100.64.0.1", ua: "firefox" })
  })

  it("stores only hashes: the file alone grants nothing", () => {
    const { s } = make(file)
    const { cookie, secret } = s.create("alice")
    const text = readFileSync(file, "utf8")
    expect(text).not.toContain(cookie)
    const stored = JSON.parse(text).sessions[0]
    expect(stored.hash).toBe(sha(cookie))
    expect(Object.values(stored)).not.toContain(cookie)
    // presenting what's in the file doesn't work
    const { s: again } = make(file)
    expect(again.get(stored.hash, stored.secretHash)).toBeNull()
    expect(again.get(stored.id, stored.secretHash)).toBeNull()
  })

  it("writes the file 0600 in a 0700 folder, atomically", () => {
    const { s } = make(file)
    s.create("alice")
    s.create("bob")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700)
    // no temp files left behind
    expect(readdirSync(join(dir, "state"))).toEqual(["portal-sessions.json"])
    expect(JSON.parse(readFileSync(file, "utf8")).sessions.length).toBe(2)
  })

  it("replaces a loose-permission file with a 0600 one", () => {
    const { s } = make(file)
    s.create("alice")
    chmodSync(file, 0o644)
    s.create("bob")
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("doesn't write the slide on every request, only every minute", () => {
    const { s, clock } = make(file)
    const { cookie, secret } = s.create("alice")
    const before = readFileSync(file, "utf8")
    clock.t += 10 * 1000
    s.get(cookie, secret)
    expect(readFileSync(file, "utf8")).toBe(before)
    clock.t += 60 * 1000
    s.get(cookie, secret)
    expect(JSON.parse(readFileSync(file, "utf8")).sessions[0].lastSeen).toBe(clock.t)
  })

  it("drops sessions that expired while the daemon was down", () => {
    const { s } = make(file, { idleMs: HOUR })
    const { cookie, secret } = s.create("alice")
    const later = new PortalSessions(file, { idleMs: HOUR, now: () => T0 + 2 * HOUR })
    expect(later.size).toBe(0)
    expect(later.get(cookie, secret)).toBeNull()
  })

  it("starts empty from a missing or corrupt file", () => {
    expect(make(join(dir, "nope.json")).s.size).toBe(0)
    for (const junk of ["", "{", "null", "42", "[]", '{"sessions":7}', '{"sessions":[null,1,"x"]}']) {
      writeFileSync(file.replace("state/", ""), junk, { mode: 0o600 })
      const { s } = make(file.replace("state/", ""))
      expect(s.size).toBe(0)
      // and still works
      const { cookie, secret } = s.create("alice")
      expect(s.get(cookie, secret)?.user).toBe("alice")
    }
  })

  it("skips tampered entries and keeps the good ones", () => {
    const { s } = make(file)
    const good = s.create("alice")
    const data = JSON.parse(readFileSync(file, "utf8"))
    const base = data.sessions[0]
    const bad = [
      { ...base, id: "x1".repeat(10), hash: "zz" },                          // not a sha256
      { ...base, id: "x2".repeat(10), hash: sha("a"), user: "root;rm -rf" }, // not an account name
      { ...base, id: "x3".repeat(10), hash: sha("b"), user: 7 },
      { ...base, id: "x4".repeat(10), hash: sha("c"), created: "yesterday" },
      { ...base, id: "x5".repeat(10), hash: sha("d"), lastSeen: T0 + 365 * 24 * HOUR },  // from the future
      { ...base, id: "x6".repeat(10), hash: sha("e"), created: T0 + 365 * 24 * HOUR },
      { ...base, id: "x7".repeat(10), hash: sha("f"), lastSeen: T0 - HOUR },              // seen before it was made
      { ...base, hash: sha("g") },                                                          // duplicate id
      { ...base, id: "bad id!", hash: sha("h") },
    ]
    data.sessions.push(...bad)
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
    const { s: again } = make(file)
    expect(again.size).toBe(1)
    expect(again.get(good.cookie, good.secret)?.user).toBe("alice")
    for (const v of "abcdefgh") expect(again.get(v, good.secret)).toBeNull()
  })

  it("ignores a file that others can write", () => {
    const { s } = make(file)
    const { cookie, secret } = s.create("alice")
    chmodSync(file, 0o666)
    const { s: again } = make(file)
    expect(again.size).toBe(0)
    expect(again.get(cookie, secret)).toBeNull()
  })

  it("works without a file", () => {
    const { s } = make(null)
    const { cookie, secret } = s.create("alice")
    expect(s.get(cookie, secret)?.user).toBe("alice")
    expect(existsSync(file)).toBe(false)
  })
})

describe("cookies", () => {
  it("reads candy_portal out of a Cookie header", () => {
    expect(readSessionCookie("a=1; candy_portal=abc_-; b=2")).toBe("abc_-")
    expect(readSessionCookie("candy_portal=x")).toBe("x")
    expect(readSessionCookie("candy_portal_other=x; xcandy_portal=y")).toBeNull()
    expect(readSessionCookie("candy_portal=")).toBeNull()
    expect(readSessionCookie(null)).toBeNull()
    expect(readSessionCookie("")).toBeNull()
  })

  it("sets HttpOnly SameSite=Strict for a week, Secure on https", () => {
    expect(sessionCookieHeader("v", false)).toBe("candy_portal=v; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800")
    expect(sessionCookieHeader("v", true)).toBe("candy_portal=v; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure")
    expect(clearSessionCookieHeader(true)).toContain("Max-Age=0")
  })
})

// Review finding 1: the cookie reaches every port on the portal's host, so it
// must never be enough on its own.
describe("session secret (cookie + X-Candy-Session)", () => {
  it("needs both the cookie and the secret, and each must be this session's", () => {
    const { s } = make()
    const a = s.create("alice")
    const b = s.create("bob")
    expect(a.secret).not.toBe(a.cookie)
    expect(s.get(a.cookie, a.secret)?.user).toBe("alice")
    expect(s.get(a.cookie, null)).toBeNull()
    expect(s.get(a.cookie, undefined)).toBeNull()
    expect(s.get(a.cookie, "")).toBeNull()
    expect(s.get(a.cookie, b.secret)).toBeNull()
    expect(s.get(a.cookie, a.secret + "x")).toBeNull()
    expect(s.get(null, a.secret)).toBeNull()
    expect(s.get(a.secret, a.cookie)).toBeNull()
  })

  it("keeps only the secret's hash on disk, and survives a restart", () => {
    const { s } = make(file)
    const a = s.create("alice")
    const text = readFileSync(file, "utf8")
    expect(text).not.toContain(a.secret)
    const { s: again } = make(file)
    expect(again.get(a.cookie, a.secret)?.user).toBe("alice")
    expect(again.get(a.cookie, null)).toBeNull()
  })

  it("drops stored logins from before the secret existed", () => {
    const { s } = make(file)
    const a = s.create("alice")
    const data = JSON.parse(readFileSync(file, "utf8"))
    delete data.sessions[0].secretHash
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
    const { s: again } = make(file)
    expect(again.size).toBe(0)
    expect(again.get(a.cookie, a.secret)).toBeNull()
  })
})

// Review finding 13: one account can't push everyone else's logins out
describe("per-user cap", () => {
  it(`keeps at most ${MAX_SESSIONS_PER_USER} per user, dropping that user's oldest`, () => {
    const { s } = make()
    const bob = s.create("bob")
    const alice = Array.from({ length: MAX_SESSIONS_PER_USER + 5 }, () => s.create("alice"))
    expect(s.list().filter(x => x.user === "alice").length).toBe(MAX_SESSIONS_PER_USER)
    for (const old of alice.slice(0, 5)) expect(s.get(old.cookie, old.secret)).toBeNull()
    for (const kept of alice.slice(5)) expect(s.get(kept.cookie, kept.secret)).not.toBeNull()
    expect(s.get(bob.cookie, bob.secret)?.user).toBe("bob")
  })
})

// SDK_AUTH_DESIGN.md, F: how a login was made, and when its password was last checked
describe("amr and pamAt", () => {
  it("a password login is amr pam with pamAt = now; a passkey login has no pamAt", () => {
    const { s } = make(null)
    const pam = s.create("alice")
    const key = s.create("alice", {}, { amr: "passkey" })
    expect(s.get(pam.cookie, pam.secret)).toMatchObject({ amr: "pam", pamAt: T0 })
    expect(s.get(key.cookie, key.secret)).toMatchObject({ amr: "passkey", pamAt: null })
    expect(() => s.create("alice", {}, { amr: "sms" as any })).toThrow()
  })

  it("markPam moves pamAt to now, persists, and refuses unknown or expired sessions", () => {
    const { s, clock } = make(file, { idleMs: HOUR, maxMs: 10 * HOUR })
    const key = s.create("alice", {}, { amr: "passkey" })
    clock.t += 5 * MIN
    expect(s.markPam(key.id)).toBe(T0 + 5 * MIN)
    expect(s.get(key.cookie, key.secret)).toMatchObject({ amr: "passkey", pamAt: T0 + 5 * MIN })
    const { s: again } = make(file, { idleMs: HOUR, maxMs: 10 * HOUR })
    expect(again.get(key.cookie, key.secret)).toMatchObject({ amr: "passkey", pamAt: T0 + 5 * MIN })
    expect(s.markPam("nope")).toBeNull()
    clock.t += 2 * HOUR
    expect(s.markPam(key.id)).toBeNull()
  })

  it("loads sessions from before amr existed as password logins (pamAt = created)", () => {
    const { s } = make(file)
    const a = s.create("alice")
    const data = JSON.parse(readFileSync(file, "utf8"))
    delete data.sessions[0].amr
    delete data.sessions[0].pamAt
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
    const { s: again } = make(file)
    expect(again.get(a.cookie, a.secret)).toMatchObject({ amr: "pam", pamAt: T0 })
  })

  it("drops stored sessions with a bad amr or pamAt", () => {
    for (const bad of [{ amr: "sms" }, { amr: "pam", pamAt: null }, { amr: "pam", pamAt: "x" }, { amr: "passkey", pamAt: T0 - 1 }, { amr: "pam", pamAt: T0 + 24 * HOUR }]) {
      const { s } = make(file)
      const a = s.create("alice")
      const data = JSON.parse(readFileSync(file, "utf8"))
      Object.assign(data.sessions[0], bad)
      writeFileSync(file, JSON.stringify(data), { mode: 0o600 })
      const { s: again } = make(file)
      expect(again.get(a.cookie, a.secret)).toBeNull()
      rmSync(file, { force: true })
    }
  })
})
