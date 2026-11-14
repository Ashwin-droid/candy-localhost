import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SoftLockout } from "../portal-auth.ts"
import {
  PasskeyStore, ChallengeStore, mayManagePasskeys, passkeyLoginKey, cleanPasskeyName, isRpId,
  startPasskeyLogin, attemptPasskeyLogin, startRegistration, finishRegistration, deletePasskey, renamePasskey,
  MAX_PER_USER_RP, MAX_PER_USER, MAX_PASSKEYS, MAX_NAME_LENGTH, CHALLENGE_TTL_MS, MAX_CHALLENGES,
  prunePasskeyAccounts,
  RECENT_PAM_MS, PASSKEY_FAILURE_FLOOR_MS, PASSKEY_FAILED, PASSKEY_SLOWED, PASSKEY_NEEDS_PASSWORD, PASSKEY_LIMIT,
  PASSKEY_EXISTS, PASSKEY_EXPIRED, PASSKEY_NOT_FOUND, PASSKEY_INVALID, MAX_CREDENTIAL_ID_CHARS,
  type PasskeyRecord, type PasskeyDeps, type WebAuthnImpl, type SessionAuthState,
} from "../passkey-store.ts"

const T0 = 1_800_000_000_000
const MIN = 60_000
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
const rand = (n: number) => b64(crypto.getRandomValues(new Uint8Array(n)))
const AAGUID = "00".repeat(16)
// Each test account's uid (a Map: "__proto__" is a test account too)
const UIDS = new Map([["alice", 1001], ["bob", 1002], ["carol", 1003], ["dave", 1004], ["x", 1005]])
const uidFor = (user: string): number => UIDS.get(user) ?? 1999

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "candy-passkeys-"))
  file = join(dir, "state", "passkeys.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rec = (o: Partial<Omit<PasskeyRecord, "created" | "lastUsed">> = {}): Omit<PasskeyRecord, "created" | "lastUsed"> => ({
  id: rand(16), user: "alice", uid: uidFor(o.user ?? "alice"), rpId: "portal.localhost", publicKey: rand(77), alg: -7, signCount: 0, name: "Laptop",
  aaguid: AAGUID, backupEligible: true, backedUp: true, transports: ["internal", "hybrid"], ...o,
})

const makeStore = (f: string | null = file) => {
  const clock = { t: T0 }
  return { store: new PasskeyStore(f, { now: () => clock.t }), clock }
}

const added = (store: PasskeyStore, o: Partial<Omit<PasskeyRecord, "created" | "lastUsed">> = {}): PasskeyRecord => {
  const r = store.add(rec(o))
  if (!r.ok) throw new Error(r.error)
  return r.record
}

// ----------------------------------------------------------------------------
// PasskeyStore
// ----------------------------------------------------------------------------

describe("PasskeyStore basics", () => {
  it("adds, gets and lists oldest first", () => {
    const { store, clock } = makeStore(null)
    const a = added(store)
    clock.t += 1000
    const b = added(store, { rpId: "portal.candy" })
    expect(a.created).toBe(T0)
    expect(a.lastUsed).toBeNull()
    expect(store.get(a.id)).toEqual(a)
    expect(store.list("alice").map(r => r.id)).toEqual([a.id, b.id])
    expect(store.list("alice", "portal.candy").map(r => r.id)).toEqual([b.id])
    expect(store.list("bob")).toEqual([])
    expect(store.size).toBe(2)
  })

  it("hands out copies, so callers can't change the store", () => {
    const { store } = makeStore(null)
    const a = added(store)
    const got = store.get(a.id)!
    got.user = "mallory"
    got.transports.push("usb")
    store.list("alice")[0]!.signCount = 99
    expect(store.get(a.id)).toEqual(a)
  })

  it("get refuses non-strings and unknown ids", () => {
    const { store } = makeStore(null)
    expect(store.get(rand(16))).toBeNull()
    expect(store.get(42 as unknown as string)).toBeNull()
    expect(store.get(undefined as unknown as string)).toBeNull()
  })

  it("views a record with the alg name and whether it is from this portal", () => {
    const { store } = makeStore(null)
    const a = added(store, { alg: -257 })
    expect(store.view(a, "portal.localhost")).toEqual({ id: a.id, name: "Laptop", rpId: "portal.localhost", created: T0, lastUsed: null, backedUp: true, alg: "RS256", here: true })
    expect(store.view(a, "portal.candy").here).toBe(false)
    expect(store.view(added(store, { alg: -7 }), "x").alg).toBe("ES256")
    expect(store.view(added(store, { alg: -8 }), "x").alg).toBe("EdDSA")
    const v = store.view(a, "portal.localhost") as unknown as Record<string, unknown>
    expect(v.publicKey).toBeUndefined()
    expect(v.user).toBeUndefined()
  })

  it("refuses a credential id twice, even for another user", () => {
    const { store } = makeStore(null)
    const a = added(store)
    expect(store.add(rec({ id: a.id }))).toEqual({ ok: false, error: PASSKEY_EXISTS })
    expect(store.add(rec({ id: a.id, user: "bob", rpId: "portal.candy" }))).toEqual({ ok: false, error: PASSKEY_EXISTS })
    expect(store.get(a.id)!.user).toBe("alice")
  })

  it("throws on records that aren't valid", () => {
    const { store } = makeStore(null)
    const bad: Partial<Omit<PasskeyRecord, "created" | "lastUsed">>[] = [
      { user: "" }, { user: "a b" }, { user: "../x" }, { user: "x".repeat(40) },
      { uid: -1 }, { uid: 1.5 }, { uid: "1001" as never }, { uid: 2 ** 32 }, { uid: undefined as never },
      { id: "" }, { id: "abc=" }, { id: "ab+c" }, { id: "a" }, { id: "AB" /* non-canonical: trailing bits */ }, { id: "A".repeat(MAX_CREDENTIAL_ID_CHARS + 1) },
      { rpId: "" }, { rpId: "portal.localhost:8443" }, { rpId: "Portal.Localhost" }, { rpId: "https://portal.localhost" }, { rpId: "-x.localhost" }, { rpId: "a..b" },
      { publicKey: "" }, { publicKey: rand(3000) },
      { alg: -35 as never }, { alg: "-7" as never },
      { signCount: -1 }, { signCount: 1.5 }, { signCount: NaN }, { signCount: 2 ** 32 }, { signCount: "1" as never },
      { aaguid: "zz".repeat(16) }, { aaguid: "00" },
      { backupEligible: false, backedUp: true },
      { backedUp: "yes" as never },
      { transports: "usb" as never },
    ]
    for (const b of bad) expect(() => store.add(rec(b))).toThrow()
    expect(store.size).toBe(0)
  })

  it("cleans names", () => {
    expect(cleanPasskeyName("  Phone\u0000\n ")).toBe("Phone")
    expect(cleanPasskeyName("evil\u202egnp.exe")).toBe("evilgnp.exe")
    expect(cleanPasskeyName("\u2066x\u2069\u200e")).toBe("x")
    expect(cleanPasskeyName("")).toBe("Passkey")
    expect(cleanPasskeyName("   \t ")).toBe("Passkey")
    expect(cleanPasskeyName(null)).toBe("Passkey")
    expect(cleanPasskeyName(42)).toBe("Passkey")
    expect(cleanPasskeyName({ toString: () => "x" })).toBe("Passkey")
    expect(cleanPasskeyName("x".repeat(500))).toBe("x".repeat(MAX_NAME_LENGTH))
    // Cut by code point, never half an emoji
    const emoji = "😀".repeat(100)
    expect([...cleanPasskeyName(emoji)].length).toBe(MAX_NAME_LENGTH)
    expect(cleanPasskeyName(emoji)).toBe("😀".repeat(MAX_NAME_LENGTH))
    expect(cleanPasskeyName("a\ud800b")).toBe("ab")  // lone surrogate
    expect(cleanPasskeyName("x".repeat(1_000_000)).length).toBe(MAX_NAME_LENGTH)
    const { store } = makeStore(null)
    expect(added(store, { name: "\u0007" }).name).toBe("Passkey")
  })

  it("validates rpIds", () => {
    for (const ok of ["portal.localhost", "portal.candy", "portal.box.candy", "localhost"]) expect(isRpId(ok)).toBe(true)
    for (const bad of ["", "portal.localhost:443", "PORTAL.localhost", "portal.localhost.", ".x", "x".repeat(64) + ".candy", "a_b.candy", "1.2.3.4:1", null, 3]) expect(isRpId(bad)).toBe(false)
  })
})

describe("PasskeyStore limits", () => {
  it(`allows ${MAX_PER_USER_RP} per user per rpId`, () => {
    const { store } = makeStore(null)
    for (let i = 0; i < MAX_PER_USER_RP; i++) added(store)
    expect(store.atLimit("alice", "portal.localhost")).toBe(true)
    expect(store.add(rec())).toEqual({ ok: false, error: PASSKEY_LIMIT })
    // Another host, or another user, still has room
    expect(store.add(rec({ rpId: "portal.candy" })).ok).toBe(true)
    expect(store.add(rec({ user: "bob" })).ok).toBe(true)
  })

  it(`allows ${MAX_PER_USER} per user across rpIds`, () => {
    const { store } = makeStore(null)
    for (let i = 0; i < MAX_PER_USER; i++) added(store, { rpId: `portal${i % 3}.candy` })
    expect(store.add(rec({ rpId: "portal9.candy" }))).toEqual({ ok: false, error: PASSKEY_LIMIT })
    expect(store.atLimit("alice", "fresh.candy")).toBe(true)
    expect(store.add(rec({ user: "bob" })).ok).toBe(true)
  })

  it(`allows ${MAX_PASSKEYS} in the whole store`, () => {
    const { store } = makeStore(null)
    for (let i = 0; i < MAX_PASSKEYS; i++) added(store, { user: `u${Math.floor(i / 10)}` })
    expect(store.size).toBe(MAX_PASSKEYS)
    expect(store.add(rec({ user: "newcomer" }))).toEqual({ ok: false, error: PASSKEY_LIMIT })
    expect(store.atLimit("newcomer", "portal.localhost")).toBe(true)
  })
})

describe("PasskeyStore touch", () => {
  it("only moves the counter forward", () => {
    const { store, clock } = makeStore(null)
    const a = added(store, { signCount: 5 })
    expect(store.touch(a.id, 5, true)).toBe(false)
    expect(store.touch(a.id, 3, true)).toBe(false)
    expect(store.touch(a.id, 0, true)).toBe(false)
    expect(store.get(a.id)!.signCount).toBe(5)
    expect(store.get(a.id)!.lastUsed).toBeNull()
    clock.t += 1000
    expect(store.touch(a.id, 6, false)).toBe(true)
    expect(store.get(a.id)).toMatchObject({ signCount: 6, lastUsed: T0 + 1000, backedUp: false })
    expect(store.touch(a.id, 6, false)).toBe(false)
  })

  it("accepts 0 → 0 (no counter) and 0 → n, but never n → 0", () => {
    const { store } = makeStore(null)
    const a = added(store, { signCount: 0 })
    expect(store.touch(a.id, 0, true)).toBe(true)
    expect(store.touch(a.id, 0, true)).toBe(true)
    expect(store.touch(a.id, 1, true)).toBe(true)
    expect(store.touch(a.id, 0, true)).toBe(false)
    const b = added(store, { signCount: 7 })
    expect(store.touch(b.id, 0, true)).toBe(false)
  })

  it("refuses counters that aren't 32-bit integers and unknown ids", () => {
    const { store } = makeStore(null)
    const a = added(store, { signCount: 1 })
    for (const bad of [NaN, Infinity, 2.5, -1, 2 ** 32, 2 ** 53, "9" as never]) expect(store.touch(a.id, bad, true)).toBe(false)
    expect(store.touch(rand(16), 9, true)).toBe(false)
    expect(store.get(a.id)!.signCount).toBe(1)
    expect(store.touch(a.id, 2 ** 32 - 1, true)).toBe(true)
  })

  it("never marks a credential that can't be backed up as backed up", () => {
    const { store } = makeStore(null)
    const a = added(store, { backupEligible: false, backedUp: false })
    expect(store.touch(a.id, 1, true)).toBe(true)
    expect(store.get(a.id)!.backedUp).toBe(false)
  })
})

describe("PasskeyStore rename and remove", () => {
  it("renames only the user's own passkey", () => {
    const { store } = makeStore(null)
    const a = added(store)
    expect(store.rename("bob", a.id, "mine now")).toBeNull()
    expect(store.rename("alice", rand(16), "x")).toBeNull()
    expect(store.rename("alice", a.id, " Work\u0000 key ")!.name).toBe("Work key")
    expect(store.get(a.id)!.name).toBe("Work key")
  })

  it("removes only the user's own passkey", () => {
    const { store } = makeStore(null)
    const a = added(store)
    expect(store.remove("bob", a.id)).toBe(false)
    expect(store.size).toBe(1)
    expect(store.remove("alice", a.id)).toBe(true)
    expect(store.remove("alice", a.id)).toBe(false)
    expect(store.size).toBe(0)
  })

  it("removeUser drops every passkey of that user and keeps the handle", () => {
    const { store } = makeStore(null)
    const h = store.userHandle("alice", uidFor("alice"))
    added(store); added(store, { rpId: "portal.candy" }); added(store, { user: "bob" })
    expect(store.removeUser("alice")).toBe(2)
    expect(store.removeUser("alice")).toBe(0)
    expect(store.size).toBe(1)
    expect(store.userHandle("alice", uidFor("alice"))).toBe(h)
  })
})

describe("PasskeyStore user handles", () => {
  it("are 32 random bytes, stable per user and different between users", () => {
    const { store } = makeStore(null)
    const a = store.userHandle("alice", uidFor("alice"))
    expect(Buffer.from(a, "base64url").length).toBe(32)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.userHandle("alice", uidFor("alice"))).toBe(a)
    expect(store.userHandle("bob", uidFor("bob"))).not.toBe(a)
    expect(store.userForHandle(a)).toBe("alice")
  })

  it("userForHandle never creates one and refuses junk", () => {
    const { store } = makeStore(null)
    expect(store.userForHandle(rand(32))).toBeNull()
    for (const bad of ["", "x", rand(31), rand(33), 5, null, "__proto__"]) expect(store.userForHandle(bad as string)).toBeNull()
  })

  it("throws for names that can't be accounts", () => {
    const { store } = makeStore(null)
    for (const bad of ["", "a b", "x".repeat(40), 7]) expect(() => store.userHandle(bad as string, 1000)).toThrow()
  })

  it("survives a reload", () => {
    const { store } = makeStore()
    const a = store.userHandle("alice", uidFor("alice"))
    const { store: again } = makeStore()
    expect(again.userHandle("alice", uidFor("alice"))).toBe(a)
    expect(again.userForHandle(a)).toBe("alice")
  })

  it("handles an account called __proto__ or constructor without touching prototypes", () => {
    const { store } = makeStore()
    const p = store.userHandle("__proto__", uidFor("__proto__"))
    const c = store.userHandle("constructor", uidFor("constructor"))
    const { store: again } = makeStore()
    expect(again.userHandle("__proto__", uidFor("__proto__"))).toBe(p)
    expect(again.userHandle("constructor", uidFor("constructor"))).toBe(c)
    expect(again.userForHandle(p)).toBe("__proto__")
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe("PasskeyStore file", () => {
  it("writes atomically: 0600 file in a 0700 dir, no temp files left, and reloads the same", () => {
    const { store, clock } = makeStore()
    const a = added(store, { signCount: 3 })
    clock.t += 5
    store.touch(a.id, 4, true)
    store.userHandle("alice", uidFor("alice"))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(dir, "state"))).toEqual(["passkeys.json"])
    const raw = JSON.parse(readFileSync(file, "utf8"))
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.handles)).toEqual(["alice"])
    expect(raw.credentials).toHaveLength(1)
    const { store: again } = makeStore()
    expect(again.get(a.id)).toEqual(store.get(a.id))
    expect(again.get(a.id)!.signCount).toBe(4)
  })

  it("keeps public keys only: nothing in the file looks like private key material", () => {
    const { store } = makeStore()
    added(store)
    const raw = JSON.parse(readFileSync(file, "utf8"))
    expect(Object.keys(raw.credentials[0]).sort()).toEqual(
      ["aaguid", "alg", "backedUp", "backupEligible", "created", "id", "lastUsed", "name", "publicKey", "rpId", "signCount", "transports", "uid", "user"])
  })

  for (const mode of [0o620, 0o602, 0o666]) {
    it(`refuses a file with mode ${mode.toString(8)} and starts empty`, () => {
      const { store } = makeStore()
      const a = added(store)
      chmodSync(file, mode)
      const { store: again } = makeStore()
      expect(again.size).toBe(0)
      expect(again.get(a.id)).toBeNull()
    })
  }

  it("starts empty on a missing, corrupt or wrongly shaped file", () => {
    expect(makeStore().store.size).toBe(0)
    const { store } = makeStore()
    store.userHandle("x", uidFor("x"))  // creates the dir
    for (const body of ["{", "null", "[]", '"x"', '{"credentials":{}}', '{"credentials":"x","handles":[]}']) {
      writeFileSync(file, body, { mode: 0o600 })
      expect(makeStore().store.size).toBe(0)
    }
  })

  it("drops every invalid record on load and keeps the valid ones", () => {
    const { store } = makeStore()
    store.userHandle("alice", uidFor("alice"))
    const good = { ...rec(), created: T0, lastUsed: null }
    const dup = { ...rec({ id: good.id, user: "bob" }), created: T0, lastUsed: null }
    const bad = [
      null, 5, "x", [],
      { ...good, id: rand(16), user: "a b" },
      { ...good, id: rand(16), user: undefined },
      { ...good, id: "not b64!" },
      { ...good, id: rand(16), publicKey: "%%%" },
      { ...good, id: rand(16), alg: -35 },
      { ...good, id: rand(16), signCount: -1 },
      { ...good, id: rand(16), signCount: 1.5 },
      { ...good, id: rand(16), signCount: 2 ** 53 },
      { ...good, id: rand(16), created: "now" },
      { ...good, id: rand(16), lastUsed: "never" },
      { ...good, id: rand(16), rpId: "portal.localhost:1" },
      { ...good, id: rand(16), aaguid: "x" },
      { ...good, id: rand(16), backupEligible: false, backedUp: true },
      { ...good, id: rand(16), transports: null },
    ]
    writeFileSync(file, JSON.stringify({ version: 1, handles: { alice: { handle: store.userHandle("alice", uidFor("alice")), uid: uidFor("alice") } }, credentials: [good, dup, ...bad] }), { mode: 0o600 })
    const { store: again } = makeStore()
    expect(again.size).toBe(1)
    expect(again.get(good.id)!.user).toBe("alice")
  })

  it("cleans names and transports from the file", () => {
    const { store } = makeStore()
    store.userHandle("alice", uidFor("alice"))
    const r = { ...rec({ name: "x\u202ey" }), transports: ["usb", "USB", "x".repeat(40), 5, "usb", "nfc"], created: T0, lastUsed: null }
    writeFileSync(file, JSON.stringify({ version: 1, handles: {}, credentials: [r] }), { mode: 0o600 })
    const got = makeStore().store.get(r.id)!
    expect(got.name).toBe("xy")
    expect(got.transports).toEqual(["usb", "nfc"])
  })

  it("enforces the limits on load", () => {
    const { store } = makeStore()
    store.userHandle("x", uidFor("x"))
    const many = Array.from({ length: MAX_PER_USER_RP + 5 }, (_, i) => ({ ...rec(), created: T0 + i, lastUsed: null }))
    const others = Array.from({ length: MAX_PASSKEYS + 20 }, (_, i) => ({ ...rec({ user: `u${Math.floor(i / 10)}` }), created: T0, lastUsed: null }))
    writeFileSync(file, JSON.stringify({ version: 1, handles: {}, credentials: [...many, ...others] }), { mode: 0o600 })
    const again = makeStore().store
    expect(again.list("alice")).toHaveLength(MAX_PER_USER_RP)
    expect(again.list("alice")[0]!.id).toBe(many[0]!.id)
    expect(again.size).toBe(MAX_PASSKEYS)
  })

  it("drops bad and duplicate handles on load", () => {
    const { store } = makeStore()
    store.userHandle("x", uidFor("x"))
    const h = rand(32)
    const H = (handle: unknown, uid: unknown = 1001) => ({ handle, uid })
    writeFileSync(file, JSON.stringify({ version: 1, handles: {
      alice: H(h), bob: H(h, 1002), carol: H("short"), "a b": H(rand(32)), dave: H(rand(33)), erin: H(5),
      frank: rand(32) /* an older file: a handle without a uid */, gina: H(rand(32), -1), hal: H(rand(32), "7"),
    }, credentials: [] }), { mode: 0o600 })
    const again = makeStore().store
    expect(again.userForHandle(h)).toBe("alice")
    for (const u of ["carol", "dave", "erin", "frank", "gina", "hal"]) expect(again.handleUid(u)).toBeNull()
    expect(again.userHandle("bob", uidFor("bob"))).not.toBe(h)
  })

  it("rewrites a refused file with a private one on the next save", () => {
    const { store } = makeStore()
    added(store)
    chmodSync(file, 0o666)
    const { store: again } = makeStore()
    added(again)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(makeStore().store.size).toBe(1)
  })

  it("persists rename, remove and removeUser", () => {
    const { store } = makeStore()
    const a = added(store), b = added(store), c = added(store, { user: "bob" })
    store.rename("alice", a.id, "Renamed")
    store.remove("alice", b.id)
    let again = makeStore().store
    expect(again.get(a.id)!.name).toBe("Renamed")
    expect(again.get(b.id)).toBeNull()
    again.removeUser("bob")
    again = makeStore().store
    expect(again.get(c.id)).toBeNull()
    expect(again.size).toBe(1)
  })

  it("leaves no temp file behind when it can't save", () => {
    writeFileSync(join(dir, "state"), "not a dir")
    const { store } = makeStore()
    const orig = console.error
    console.error = () => {}
    try { added(store) } finally { console.error = orig }
    expect(store.size).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(["state"])
  })
})

// ----------------------------------------------------------------------------
// ChallengeStore
// ----------------------------------------------------------------------------

const ch = (o: Partial<{ challenge: string; key: string; kind: "login" | "register" }> = {}) => ({
  challenge: o.challenge ?? rand(32), kind: o.kind ?? "login" as const, rpId: "portal.localhost", origin: "https://portal.localhost",
  key: o.key ?? "passkey:ip:1.2.3.4", sessionId: null, user: null,
})

describe("ChallengeStore", () => {
  const make = (opts: { ttlMs?: number; maxUsed?: number } = {}) => {
    const clock = { t: T0 }
    return { c: new ChallengeStore({ ...opts, now: () => clock.t }), clock }
  }

  it("issues sealed ids, stores nothing, and is single use", () => {
    const { c } = make()
    const a = c.issue(ch())
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(a.expires).toBe(T0 + CHALLENGE_TTL_MS)
    expect(c.size).toBe(0)
    expect(c.take(a.id, "login")).toEqual(a)
    expect(c.take(a.id, "login")).toBeNull()
    expect(c.size).toBe(1)      // the used id, remembered until it expires
  })

  it("the id shows nothing of the challenge", () => {
    const { c } = make()
    const a = c.issue(ch({ challenge: "Z".repeat(43) }))
    expect(Buffer.from(a.id, "base64url").toString("latin1")).not.toContain("ZZZZ")
  })

  it("expires after the TTL", () => {
    const { c, clock } = make()
    const a = c.issue(ch()), b = c.issue(ch())
    clock.t += CHALLENGE_TTL_MS - 1
    expect(c.take(a.id, "login")).not.toBeNull()
    clock.t += 1
    expect(c.take(b.id, "login")).toBeNull()
    expect(c.take(b.id, "login")).toBeNull()
  })

  it("a kind mismatch consumes it", () => {
    const { c } = make()
    const a = c.issue(ch({ kind: "login" }))
    expect(c.take(a.id, "register")).toBeNull()
    expect(c.take(a.id, "login")).toBeNull()
  })

  it("refuses ids of the wrong type or shape, tampered ones, and another store's", () => {
    const { c } = make()
    const a = c.issue(ch())
    const flipped = Buffer.from(a.id, "base64url"); flipped[20] ^= 1
    for (const bad of [undefined, null, 5, {}, [], "", "x".repeat(32 * 1000), "a".repeat(31), "!".repeat(32), a.id + "=", flipped.toString("base64url"), make().c.issue(ch()).id]) {
      expect(c.take(bad, "login")).toBeNull()
    }
    expect(c.size).toBe(0)
    expect(c.take(a.id, "login")).not.toBeNull()
  })

  it("refuses an unknown kind or a missing challenge", () => {
    const { c } = make()
    expect(() => c.issue({ ...ch(), kind: "admin" as never })).toThrow()
    expect(() => c.issue({ ...ch(), challenge: "" })).toThrow()
    expect(() => c.issue({ ...ch(), challenge: "x".repeat(10_000) })).toThrow()
  })

  // Review finding: login challenges were kept 8 per address, oldest out, and
  // all local browsers are one loopback address: 8 public calls pushed out
  // every other local user's pending passkey login
  it("no number of challenges from the same address pushes out an earlier one", () => {
    const { c } = make()
    const victim = c.issue(ch({ key: "passkey:ip:loopback" }))
    for (let i = 0; i < MAX_CHALLENGES + 50; i++) c.issue(ch({ key: "passkey:ip:loopback" }))
    expect(c.size).toBe(0)
    expect(c.take(victim.id, "login")).toMatchObject({ challenge: victim.challenge })
  })

  it(`remembers at most ${MAX_CHALLENGES} used ids, dropping expired ones first`, () => {
    const { c, clock } = make({ maxUsed: 3 })
    c.take(c.issue(ch()).id, "login"); c.take(c.issue(ch()).id, "login")
    clock.t += CHALLENGE_TTL_MS
    for (let i = 0; i < 3; i++) c.take(c.issue(ch()).id, "login")
    expect(c.size).toBe(3)
    expect(c.sweep()).toBe(0)
  })
})

// ----------------------------------------------------------------------------
// Policy helpers
// ----------------------------------------------------------------------------

describe("policy helpers", () => {
  it("mayManagePasskeys needs a password login within the last 10 minutes", () => {
    expect(RECENT_PAM_MS).toBe(10 * MIN)
    expect(mayManagePasskeys({ pamAt: null }, T0)).toBe(false)
    expect(mayManagePasskeys({ pamAt: T0 }, T0)).toBe(true)
    expect(mayManagePasskeys({ pamAt: T0 - RECENT_PAM_MS }, T0)).toBe(true)
    expect(mayManagePasskeys({ pamAt: T0 - RECENT_PAM_MS - 1 }, T0)).toBe(false)
    expect(mayManagePasskeys({ pamAt: NaN }, T0)).toBe(false)
    expect(mayManagePasskeys({ pamAt: T0 + 30_000 }, T0)).toBe(true)
    expect(mayManagePasskeys({ pamAt: T0 + 24 * 60 * MIN }, T0)).toBe(false)
  })

  it("passkeyLoginKey makes all of loopback one address", () => {
    expect(passkeyLoginKey("127.0.0.5", true)).toBe("passkey:ip:loopback")
    expect(passkeyLoginKey("::1", true)).toBe("passkey:ip:loopback")
    expect(passkeyLoginKey("10.0.0.2", false)).toBe("passkey:ip:10.0.0.2")
  })
})

// ----------------------------------------------------------------------------
// Orchestrators, with a stub WebAuthnImpl that checks what webauthn.ts checks
// ----------------------------------------------------------------------------

class StubError extends Error { constructor(readonly code: string) { super(code) } }

// What a browser would send: the stub "verifies" it the way webauthn.ts does
interface FakeAssertion { id: string; challenge: string; origin: string; rpId: string; userHandle?: string | null; counter: number; backedUp?: boolean; fail?: string }
interface FakeAttestation { challenge: string; origin: string; rpId: string; verdict: Record<string, unknown>; fail?: string }

const stubWebAuthn = (opts: { skipCounter?: boolean } = {}) => {
  const calls = { assert: [] as unknown[], register: [] as unknown[], regOptions: [] as Record<string, unknown>[], authOptions: [] as unknown[] }
  let n = 0
  const impl: WebAuthnImpl = {
    newChallenge: () => `chal${String(++n).padStart(4, "0")}${rand(24)}`,
    registrationOptions: o => { calls.regOptions.push(o); return { rp: { id: o.rpId, name: o.rpName }, user: { id: o.userHandle, name: o.userName, displayName: o.displayName }, challenge: o.challenge, excludeCredentials: o.exclude } as never },
    authenticationOptions: o => { calls.authOptions.push(o); return { challenge: o.challenge, rpId: o.rpId, timeout: 120_000, userVerification: "required", allowCredentials: [] } as never },
    async verifyRegistration(i) {
      calls.register.push(i)
      const r = i.response as FakeAttestation
      if (!r || typeof r !== "object") throw new StubError("malformed")
      if (r.fail) throw new StubError(r.fail)
      if (r.challenge !== i.expectedChallenge) throw new StubError("challenge")
      if (r.origin !== i.expectedOrigin) throw new StubError("origin")
      if (r.rpId !== i.expectedRpId) throw new StubError("rp_id")
      return r.verdict as never
    },
    async verifyAssertion(i) {
      calls.assert.push(i)
      const r = i.response as FakeAssertion
      if (r.fail) throw new StubError(r.fail)
      if (r.id !== i.credential.id) throw new StubError("credential_id")
      if (r.challenge !== i.expectedChallenge) throw new StubError("challenge")
      if (r.origin !== i.expectedOrigin) throw new StubError("origin")
      if (r.rpId !== i.expectedRpId) throw new StubError("rp_id")
      const stored = i.credential.signCount
      if (!opts.skipCounter && !(r.counter > stored || (stored === 0 && r.counter === 0))) throw new StubError("counter")
      return { credentialId: r.id, newSignCount: r.counter, userHandle: r.userHandle === undefined ? null : r.userHandle, backedUp: r.backedUp ?? true }
    },
  }
  return { impl, calls }
}

const LOCAL = { rpId: "portal.localhost", origin: "https://portal.localhost" }
const CANDY = { rpId: "portal.candy", origin: "https://portal.candy" }

const makeDeps = (o: { skipCounter?: boolean; users?: string[]; superusers?: string[]; file?: string | null } = {}) => {
  const clock = { t: T0 }
  const now = () => clock.t
  const store = new PasskeyStore(o.file === undefined ? null : o.file, { now })
  const challenges = new ChallengeStore({ now })
  const { impl, calls } = stubWebAuthn({ skipCounter: o.skipCounter })
  const audits: [string, string][] = []
  const sleeps: number[] = []
  const state = { users: o.users ?? ["alice", "bob"], superusers: o.superusers ?? ["bob"], usersThrow: false, suThrow: false, stepMs: 0,
    uids: new Map(UIDS) as Map<string, number>, acctDenied: [] as string[], acctThrow: false }
  const d: PasskeyDeps = {
    store, challenges, webauthn: impl, soft: new SoftLockout(now),
    loginUsers: async () => { if (state.usersThrow) throw new Error("nss down"); return state.users },
    uidOf: async u => state.uids.get(u) ?? null,
    accountOk: async u => { if (state.acctThrow) throw new Error("pam"); return !state.acctDenied.includes(u) },
    isSuperuser: async u => { if (state.suThrow) throw new Error("sudo"); return state.superusers.includes(u) },
    isLoopback: ip => ip.startsWith("127.") || ip === "::1",
    audit: (a, s) => { audits.push([a, s]) },
    now: () => { const t = clock.t; clock.t += state.stepMs; return t },
    sleep: async ms => { sleeps.push(ms); clock.t += ms },
  }
  return { d, store, challenges, calls, audits, sleeps, clock, state }
}

/** A passkey for `user` on `rpId`, as if registered earlier. */
const enrolled = (d: PasskeyDeps, user = "alice", rpId = "portal.localhost", signCount = 5) => {
  const r = d.store.add(rec({ user, rpId, signCount, name: `${user}'s key` }))
  if (!r.ok) throw new Error(r.error)
  return { record: r.record, handle: d.store.userHandle(user, uidFor(user)) }
}

const loginChallenge = (d: PasskeyDeps, at = LOCAL, ip = "10.0.0.1") => {
  const s = startPasskeyLogin(d, { ...at, ip })
  if (!s.ok) throw new Error("slowed")
  return { challengeId: s.challengeId, challenge: s.publicKey.challenge as string }
}

const assertion = (id: string, challenge: string, handle: string | null, counter = 6, at = LOCAL): FakeAssertion =>
  ({ id, challenge, origin: at.origin, rpId: at.rpId, userHandle: handle, counter })

describe("startPasskeyLogin", () => {
  it("issues a login challenge for this host and address", () => {
    const { d, challenges, calls } = makeDeps()
    const s = startPasskeyLogin(d, { ...LOCAL, ip: "10.0.0.1" })
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(s.publicKey).toMatchObject({ rpId: "portal.localhost", allowCredentials: [], userVerification: "required" })
    expect(calls.authOptions).toEqual([{ rpId: "portal.localhost", challenge: s.publicKey.challenge }])
    const c = challenges.take(s.challengeId, "login")!
    expect(c).toMatchObject({ kind: "login", rpId: "portal.localhost", origin: "https://portal.localhost", key: "passkey:ip:10.0.0.1", sessionId: null, user: null, challenge: s.publicKey.challenge })
  })

  it("is 429 while the address is slowed", () => {
    const { d } = makeDeps()
    for (let i = 0; i < 3; i++) d.soft.fail(passkeyLoginKey("10.0.0.1", false))
    const s = startPasskeyLogin(d, { ...LOCAL, ip: "10.0.0.1" })
    expect(s).toEqual({ ok: false, status: 429, body: { error: PASSKEY_SLOWED, retryAfter: 8 } })
    expect(startPasskeyLogin(d, { ...LOCAL, ip: "10.0.0.2" }).ok).toBe(true)
  })

  it("throws on an rpId or origin the daemon should never pass", () => {
    const { d } = makeDeps()
    expect(() => startPasskeyLogin(d, { rpId: "portal.localhost", origin: "https://evil.localhost", ip: "1" })).toThrow()
    expect(() => startPasskeyLogin(d, { rpId: "portal.localhost", origin: "http://portal.localhost", ip: "1" })).toThrow()
    expect(() => startPasskeyLogin(d, { rpId: "portal.localhost:8443", origin: "https://portal.localhost:8443", ip: "1" })).toThrow()
    expect(() => startPasskeyLogin(d, { rpId: "", origin: "https://", ip: "1" })).toThrow()
  })
})

describe("attemptPasskeyLogin", () => {
  it("logs in the passkey's user, moves the counter and audits", async () => {
    const { d, store, audits, sleeps, clock } = makeDeps()
    const { record, handle } = enrolled(d, "bob")
    const { challengeId, challenge } = loginChallenge(d)
    clock.t += 1234
    const r = await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle, 9), ...LOCAL, ip: "10.0.0.1" })
    expect(r).toEqual({ ok: true, user: "bob", superuser: true, credentialId: record.id })
    expect(store.get(record.id)).toMatchObject({ signCount: 9, lastUsed: T0 + 1234 })
    expect(audits).toEqual([["AUTH_LOGIN", "bob from 10.0.0.1 (passkey bob's key) (superuser)"]])
    expect(sleeps).toEqual([])
    expect(d.soft.wait(passkeyLoginKey("10.0.0.1", false))).toBe(0)
  })

  it("passes the stored key, challenge, origin and rpId to verifyAssertion", async () => {
    const { d, calls } = makeDeps()
    const { record, handle } = enrolled(d)
    const { challengeId, challenge } = loginChallenge(d)
    await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), ...LOCAL, ip: "10.0.0.1" })
    expect(calls.assert).toHaveLength(1)
    expect(calls.assert[0]).toMatchObject({
      expectedChallenge: challenge, expectedOrigin: "https://portal.localhost", expectedRpId: "portal.localhost",
      credential: { id: record.id, publicKey: record.publicKey, alg: -7, signCount: 5 },
    })
  })

  it("a non-superuser login says so; a failing superuser check means not superuser", async () => {
    const { d, state } = makeDeps()
    const { record, handle } = enrolled(d, "alice")
    let c = loginChallenge(d)
    expect(await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle, 6), ...LOCAL, ip: "10.0.0.1" })).toMatchObject({ ok: true, superuser: false })
    state.suThrow = true
    state.superusers = ["alice"]
    c = loginChallenge(d)
    expect(await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle, 7), ...LOCAL, ip: "10.0.0.1" })).toMatchObject({ ok: true, superuser: false })
  })

  const expectFailed = (r: unknown) => expect(r).toEqual({ ok: false, status: 401, body: { error: PASSKEY_FAILED } })

  it("refuses a challenge that is unknown, replayed, or for a register", async () => {
    const { d, audits } = makeDeps()
    const { record, handle } = enrolled(d)
    const { challengeId, challenge } = loginChallenge(d)
    expectFailed(await attemptPasskeyLogin(d, { challengeId: "A".repeat(32), credential: assertion(record.id, challenge, handle), ...LOCAL, ip: "10.0.0.1" }))
    expect(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), ...LOCAL, ip: "10.0.0.1" })).toMatchObject({ ok: true })
    // Replaying the very same answer
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle, 7), ...LOCAL, ip: "10.0.0.1" }))
    const reg = d.challenges.issue({ challenge: "x".repeat(43), kind: "register", ...LOCAL, key: "session:s", sessionId: "s", user: "alice" })
    expectFailed(await attemptPasskeyLogin(d, { challengeId: reg.id, credential: assertion(record.id, "x".repeat(43), handle, 8), ...LOCAL, ip: "10.0.0.1" }))
    expect(audits.filter(a => a[0] === "AUTH_FAIL").map(a => a[1])).toEqual([
      "(unknown) from 10.0.0.1 (passkey: no such challenge)",
      "(unknown) from 10.0.0.1 (passkey: no such challenge)",
      "(unknown) from 10.0.0.1 (passkey: no such challenge)",
    ])
  })

  it("refuses a challenge issued for another portal host (rpId mismatch)", async () => {
    const { d, calls } = makeDeps()
    const { record, handle } = enrolled(d, "alice", "portal.candy")
    const { challengeId, challenge } = loginChallenge(d, LOCAL)
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle, 6, CANDY), ...CANDY, ip: "10.0.0.1" }))
    expect(calls.assert).toHaveLength(0)
  })

  it("refuses an origin that differs from the challenge's", async () => {
    const { d } = makeDeps()
    const { record, handle } = enrolled(d)
    const { challengeId, challenge } = loginChallenge(d)
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), rpId: "portal.localhost", origin: "https://evil.localhost", ip: "10.0.0.1" }))
  })

  it("refuses a credential registered on portal.candy presented on portal.localhost", async () => {
    const { d, calls, audits } = makeDeps()
    const { record, handle } = enrolled(d, "alice", "portal.candy")
    const { challengeId, challenge } = loginChallenge(d, LOCAL)
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), ...LOCAL, ip: "10.0.0.1" }))
    expect(calls.assert).toHaveLength(0)
    expect(audits).toEqual([["AUTH_FAIL", "alice from 10.0.0.1 (passkey: registered on portal.candy)"]])
  })

  it("refuses a user handle of another user, or none", async () => {
    const { d, store } = makeDeps()
    const { record } = enrolled(d, "alice")
    const bobHandle = store.userHandle("bob", uidFor("bob"))
    for (const [i, handle] of [bobHandle, null, "", rand(32), 5 as never].entries()) {
      const { challengeId, challenge } = loginChallenge(d)
      expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), ...LOCAL, ip: `10.0.1.${i}` }))
    }
    expect(store.get(record.id)!.signCount).toBe(5)
  })

  it("refuses a user who may no longer log in, and when the user list can't be read", async () => {
    const { d, state, store } = makeDeps()
    const { record, handle } = enrolled(d, "alice")
    state.users = ["bob"]
    let c = loginChallenge(d)
    expectFailed(await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle), ...LOCAL, ip: "10.0.0.1" }))
    state.users = ["alice"]
    state.usersThrow = true
    c = loginChallenge(d)
    expectFailed(await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle), ...LOCAL, ip: "10.0.0.2" }))
    expect(store.get(record.id)!.signCount).toBe(5)
  })

  it("refuses malformed credentials without calling verifyAssertion", async () => {
    const { d, calls } = makeDeps()
    enrolled(d)
    const bad: unknown[] = [undefined, null, "x", 5, [], {}, { id: 5 }, { id: "" }, { id: "abc=" }, { id: "A".repeat(MAX_CREDENTIAL_ID_CHARS + 1) }, { id: rand(16) }]
    for (const [i, credential] of bad.entries()) {
      const { challengeId } = loginChallenge(d, LOCAL, `10.9.0.${i}`)
      expectFailed(await attemptPasskeyLogin(d, { challengeId, credential, ...LOCAL, ip: `10.9.0.${i}` }))
    }
    expect(calls.assert).toHaveLength(0)
  })

  it("gives every WebAuthn failure the same body", async () => {
    const { d, audits } = makeDeps()
    const { record, handle } = enrolled(d)
    for (const [i, fail] of ["signature", "user_verified", "origin", "malformed"].entries()) {
      const { challengeId, challenge } = loginChallenge(d, LOCAL, `10.8.0.${i}`)
      expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: { ...assertion(record.id, challenge, handle), fail }, ...LOCAL, ip: `10.8.0.${i}` }))
    }
    // The stub checks the challenge like webauthn.ts: an answer to another challenge fails
    const a = loginChallenge(d, LOCAL, "10.8.1.1")
    const b = loginChallenge(d, LOCAL, "10.8.1.1")
    expectFailed(await attemptPasskeyLogin(d, { challengeId: a.challengeId, credential: assertion(record.id, b.challenge, handle), ...LOCAL, ip: "10.8.1.1" }))
    expect(audits.map(x => x[1])).toEqual([
      "alice from 10.8.0.0 (passkey: signature)", "alice from 10.8.0.1 (passkey: user_verified)",
      "alice from 10.8.0.2 (passkey: origin)", "alice from 10.8.0.3 (passkey: malformed)",
      "alice from 10.8.1.1 (passkey: challenge)",
    ])
  })

  it("refuses a verdict for another credential than the one looked up", async () => {
    const { d } = makeDeps()
    const { record, handle } = enrolled(d)
    const other = enrolled(d)
    const { challengeId, challenge } = loginChallenge(d)
    d.webauthn.verifyAssertion = async () => ({ credentialId: other.record.id, newSignCount: 9, userHandle: handle, backedUp: true })
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), ...LOCAL, ip: "10.0.0.1" }))
  })

  it("audits a counter that went backwards (from verifyAssertion) and fails", async () => {
    const { d, audits, store } = makeDeps()
    const { record, handle } = enrolled(d, "alice", "portal.localhost", 5)
    for (const counter of [5, 3, 0]) {
      const { challengeId, challenge } = loginChallenge(d, LOCAL, `10.7.0.${counter}`)
      expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle, counter), ...LOCAL, ip: `10.7.0.${counter}` }))
    }
    expect(audits.filter(a => a[0] === "PASSKEY_COUNTER")).toHaveLength(3)
    expect(audits.find(a => a[0] === "PASSKEY_COUNTER")![1]).toContain(record.id)
    expect(audits.find(a => a[0] === "PASSKEY_COUNTER")![1]).toContain("alice")
    expect(store.get(record.id)!.signCount).toBe(5)
  })

  it("audits a counter the store refuses (two logins racing) and fails", async () => {
    const { d, audits, store } = makeDeps({ skipCounter: true })
    const { record, handle } = enrolled(d, "alice", "portal.localhost", 5)
    const { challengeId, challenge } = loginChallenge(d)
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle, 4), ...LOCAL, ip: "10.0.0.1" }))
    const counter = audits.find(a => a[0] === "PASSKEY_COUNTER")!
    expect(counter[1]).toBe(`alice: credential ${record.id} counter 5 -> 4 from 10.0.0.1`)
    expect(audits.at(-1)).toEqual(["AUTH_FAIL", "alice from 10.0.0.1 (passkey: counter)"])
    expect(store.get(record.id)!.signCount).toBe(5)
  })

  it("accepts counter 0/0 (authenticators without a counter)", async () => {
    const { d } = makeDeps()
    const { record, handle } = enrolled(d, "alice", "portal.localhost", 0)
    for (let i = 0; i < 2; i++) {
      const { challengeId, challenge } = loginChallenge(d)
      expect(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle, 0), ...LOCAL, ip: "10.0.0.1" })).toMatchObject({ ok: true })
    }
  })

  it("waits out the failure floor, measured from the start", async () => {
    const { d, sleeps, state } = makeDeps()
    state.stepMs = 100
    const { challengeId } = loginChallenge(d)
    await attemptPasskeyLogin(d, { challengeId, credential: null, ...LOCAL, ip: "10.0.0.1" })
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThan(0)
    expect(sleeps[0]).toBeLessThan(PASSKEY_FAILURE_FLOOR_MS)
    // A failure that already took longer than the floor doesn't sleep more
    state.stepMs = 2000
    const c = loginChallenge(d, LOCAL, "10.0.0.2")
    await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: null, ...LOCAL, ip: "10.0.0.2" })
    expect(sleeps[1]).toBe(0)
  })

  it("slows an address after failures: 429 with nothing counted and the challenge kept", async () => {
    const { d, challenges } = makeDeps()
    const { record, handle } = enrolled(d)
    const key = passkeyLoginKey("10.0.0.1", false)
    for (let i = 0; i < 3; i++) {
      const { challengeId } = loginChallenge(d)
      expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: null, ...LOCAL, ip: "10.0.0.1" }))
    }
    const waitBefore = d.soft.wait(key)
    expect(waitBefore).toBeGreaterThan(0)
    // A challenge issued earlier (before the lockout) by the real user
    const c = challenges.issue({ challenge: "y".repeat(43), kind: "login", ...LOCAL, key, sessionId: null, user: null })
    const sizeBefore = challenges.size
    const r = await attemptPasskeyLogin(d, { challengeId: c.id, credential: assertion(record.id, "y".repeat(43), handle), ...LOCAL, ip: "10.0.0.1" })
    expect(r).toEqual({ ok: false, status: 429, body: { error: PASSKEY_SLOWED, retryAfter: Math.ceil(waitBefore / 1000) } })
    expect(d.soft.wait(key)).toBe(waitBefore)
    expect(challenges.size).toBe(sizeBefore)
    // After the wait, the same challenge works and clears the lockout
    d.sleep(waitBefore)
    expect(await attemptPasskeyLogin(d, { challengeId: c.id, credential: assertion(record.id, "y".repeat(43), handle), ...LOCAL, ip: "10.0.0.1" })).toMatchObject({ ok: true })
    expect(d.soft.wait(key)).toBe(0)
  })

  it("treats all of loopback as one address", async () => {
    const { d } = makeDeps()
    for (let i = 0; i < 3; i++) {
      const ip = `127.0.0.${i + 1}`
      const { challengeId } = loginChallenge(d, LOCAL, ip)
      await attemptPasskeyLogin(d, { challengeId, credential: null, ...LOCAL, ip })
    }
    expect(startPasskeyLogin(d, { ...LOCAL, ip: "127.0.0.99" }).ok).toBe(false)
    expect(startPasskeyLogin(d, { ...LOCAL, ip: "::1" }).ok).toBe(false)
    expect(startPasskeyLogin(d, { ...LOCAL, ip: "10.0.0.1" }).ok).toBe(true)
  })

  it("counts parallel attempts before any of them is checked", async () => {
    const { d } = makeDeps()
    const cs = Array.from({ length: 6 }, () => loginChallenge(d))
    const rs = await Promise.all(cs.map(c => attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: null, ...LOCAL, ip: "10.0.0.1" })))
    expect(rs.map(r => r.ok ? 200 : r.status)).toEqual([401, 401, 401, 429, 429, 429])
  })

  it("never throws, whatever the store or verifier does", async () => {
    const { d } = makeDeps()
    const { record, handle } = enrolled(d)
    const { challengeId, challenge } = loginChallenge(d)
    d.webauthn.verifyAssertion = async () => null as never
    expectFailed(await attemptPasskeyLogin(d, { challengeId, credential: assertion(record.id, challenge, handle), ...LOCAL, ip: "10.0.0.1" }))
    const c = loginChallenge(d, LOCAL, "10.0.0.2")
    d.store.get = () => { throw new Error("boom") }
    expectFailed(await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle), ...LOCAL, ip: "10.0.0.2" }))
  })

  it("fails on an rpId or origin that isn't a portal https origin", async () => {
    const { d } = makeDeps()
    expectFailed(await attemptPasskeyLogin(d, { challengeId: "x", credential: null, rpId: "portal.localhost", origin: "http://portal.localhost", ip: "10.0.0.1" }))
  })
})

// ----------------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------------

const pamSession = (user = "alice", id = "sess-alice-0001", pamAt: number | null = T0): SessionAuthState => ({ id, user, amr: "pam", pamAt })
const passkeySession = (user = "alice", id = "sess-alice-pk01"): SessionAuthState => ({ id, user, amr: "passkey", pamAt: null })

const verdict = (o: Record<string, unknown> = {}) => ({
  credentialId: rand(16), publicKey: rand(77), alg: -7, signCount: 0, aaguid: "ab".repeat(16), backupEligible: true, backedUp: false, transports: ["internal"], ...o,
})

const register = async (d: PasskeyDeps, session: SessionAuthState, o: { at?: typeof LOCAL; name?: unknown; verdict?: Record<string, unknown>; finishSession?: SessionAuthState; finishAt?: typeof LOCAL; fail?: string } = {}) => {
  const at = o.at ?? LOCAL
  const s = await startRegistration(d, { ...at, session })
  if (!s.ok) return s
  const fin = o.finishAt ?? at
  const credential: FakeAttestation = { challenge: s.publicKey.challenge as string, origin: fin.origin, rpId: fin.rpId, verdict: o.verdict ?? verdict(), fail: o.fail }
  return finishRegistration(d, { challengeId: s.challengeId, credential, name: o.name ?? "Phone", ...fin, session: o.finishSession ?? session })
}

describe("startRegistration", () => {
  it("needs a recent password login", async () => {
    const { d, challenges, clock } = makeDeps()
    const no = { ok: false, status: 403, body: { error: PASSKEY_NEEDS_PASSWORD, reauth: true } }
    expect(await startRegistration(d, { ...LOCAL, session: passkeySession() })).toEqual(no)
    expect(await startRegistration(d, { ...LOCAL, session: pamSession("alice", "s1", T0 - RECENT_PAM_MS - 1) })).toEqual(no)
    expect((await startRegistration(d, { ...LOCAL, session: { ...passkeySession(), pamAt: T0 - MIN } })).ok).toBe(true)  // a passkey session after /auth/reauth
    clock.t += RECENT_PAM_MS
    expect((await startRegistration(d, { ...LOCAL, session: pamSession() })).ok).toBe(true)
    expect(challenges.size).toBe(0)    // challenges are stateless: nothing stored
  })

  it("issues options bound to the session, with the user's handle and their passkeys on this host excluded", async () => {
    const { d, calls, challenges, store } = makeDeps()
    const here = enrolled(d, "alice", "portal.localhost").record
    enrolled(d, "alice", "portal.candy")
    enrolled(d, "bob", "portal.localhost")
    const s = await startRegistration(d, { ...LOCAL, session: pamSession() })
    expect(s.ok).toBe(true)
    if (!s.ok) return
    expect(calls.regOptions[0]).toEqual({
      rpId: "portal.localhost", rpName: "candy", userHandle: store.userHandle("alice", uidFor("alice")), userName: "alice", displayName: "alice",
      challenge: s.publicKey.challenge, exclude: [{ id: here.id, transports: ["internal", "hybrid"] }],
    })
    expect(challenges.take(s.challengeId, "register")).toMatchObject({
      kind: "register", rpId: "portal.localhost", origin: "https://portal.localhost", key: "session:sess-alice-0001", sessionId: "sess-alice-0001", user: "alice",
    })
  })

  it("is 409 at the limit", async () => {
    const { d } = makeDeps()
    for (let i = 0; i < MAX_PER_USER_RP; i++) enrolled(d)
    expect(await startRegistration(d, { ...LOCAL, session: pamSession() })).toEqual({ ok: false, status: 409, body: { error: PASSKEY_LIMIT } })
    expect((await startRegistration(d, { ...CANDY, session: pamSession() })).ok).toBe(true)
  })

  it("stores nothing for any number of register challenges", async () => {
    const { d, challenges } = makeDeps()
    for (let i = 0; i < 20; i++) await startRegistration(d, { ...LOCAL, session: pamSession() })
    expect(challenges.size).toBe(0)
  })

  it("throws on an rpId or origin the daemon should never pass", async () => {
    const { d } = makeDeps()
    await expect(startRegistration(d, { rpId: "portal.localhost", origin: "https://portal.candy", session: pamSession() })).rejects.toThrow()
  })
})

describe("finishRegistration", () => {
  it("stores the passkey under the session's user and audits", async () => {
    const { d, store, audits } = makeDeps()
    const v = verdict({ alg: -8, signCount: 3, backupEligible: true, backedUp: true, transports: ["usb", "nfc"] })
    const r = await register(d, pamSession(), { verdict: v, name: "  Yubi\u0000Key  " })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.record).toEqual({
      id: v.credentialId as string, user: "alice", uid: 1001, rpId: "portal.localhost", publicKey: v.publicKey as string, alg: -8, signCount: 3,
      name: "YubiKey", created: T0, lastUsed: null, aaguid: "ab".repeat(16), backupEligible: true, backedUp: true, transports: ["usb", "nfc"],
    })
    expect(store.get(r.record.id)).toEqual(r.record)
    expect(audits).toEqual([["PASSKEY_ADD", `alice: YubiKey on portal.localhost (credential ${r.record.id})`]])
  })

  it("defaults the name and passes the challenge, origin and rpId to verifyRegistration", async () => {
    const { d, calls } = makeDeps()
    const r = await register(d, pamSession(), { name: 42 })
    expect(r.ok && r.record.name).toBe("Passkey")
    expect(calls.register[0]).toMatchObject({ expectedOrigin: "https://portal.localhost", expectedRpId: "portal.localhost" })
  })

  it("refuses a challenge from session X finished by session Y", async () => {
    const { d, store } = makeDeps()
    const r = await register(d, pamSession("alice", "sess-x"), { finishSession: pamSession("alice", "sess-y") })
    expect(r).toEqual({ ok: false, status: 400, body: { error: PASSKEY_EXPIRED } })
    expect(store.size).toBe(0)
  })

  it("refuses a challenge finished by another user (even with the same session id)", async () => {
    const { d, store } = makeDeps()
    const r = await register(d, pamSession("alice", "sess-x"), { finishSession: pamSession("bob", "sess-x") })
    expect(r).toEqual({ ok: false, status: 400, body: { error: PASSKEY_EXPIRED } })
    expect(store.size).toBe(0)
  })

  it("refuses a challenge finished on another portal host", async () => {
    const { d, calls } = makeDeps()
    expect(await register(d, pamSession(), { finishAt: CANDY })).toEqual({ ok: false, status: 400, body: { error: PASSKEY_EXPIRED } })
    expect(await register(d, pamSession(), { finishAt: { rpId: "portal.localhost", origin: "https://other.localhost" } })).toEqual({ ok: false, status: 400, body: { error: PASSKEY_EXPIRED } })
    expect(calls.register).toHaveLength(0)
  })

  it("refuses an unknown, expired, replayed or login challenge", async () => {
    const { d, clock } = makeDeps()
    const expired = { ok: false, status: 400, body: { error: PASSKEY_EXPIRED } }
    const session = pamSession()
    const base = { credential: {}, name: "x", ...LOCAL, session }
    expect(await finishRegistration(d, { ...base, challengeId: "A".repeat(32) })).toEqual(expired)
    expect(await finishRegistration(d, { ...base, challengeId: { toString: () => "x" } })).toEqual(expired)
    const login = loginChallenge(d)
    expect(await finishRegistration(d, { ...base, challengeId: login.challengeId })).toEqual(expired)
    const s = await startRegistration(d, { ...LOCAL, session })
    if (!s.ok) throw new Error()
    clock.t += CHALLENGE_TTL_MS
    expect(await finishRegistration(d, { ...base, session: pamSession("alice", session.id, clock.t), challengeId: s.challengeId })).toEqual(expired)
    // Replay: a finished registration's challenge is gone
    const fresh = pamSession("alice", "sess-2", clock.t)
    const s2 = await startRegistration(d, { ...LOCAL, session: fresh })
    if (!s2.ok) throw new Error()
    const cred = { challenge: s2.publicKey.challenge, ...LOCAL, verdict: verdict() }
    expect((await finishRegistration(d, { ...base, session: fresh, credential: cred, challengeId: s2.challengeId })).ok).toBe(true)
    expect(await finishRegistration(d, { ...base, session: fresh, credential: { ...cred, verdict: verdict() }, challengeId: s2.challengeId })).toEqual(expired)
  })

  it("needs a recent password at finish too, and keeps the challenge for after the re-entered password", async () => {
    const { d, clock, store } = makeDeps()
    const session = pamSession("alice", "sess-alice-0001", T0 - RECENT_PAM_MS + 1000)
    const s = await startRegistration(d, { ...LOCAL, session })
    if (!s.ok) throw new Error()
    clock.t += 2000
    const cred = { challenge: s.publicKey.challenge, ...LOCAL, verdict: verdict() }
    expect(await finishRegistration(d, { challengeId: s.challengeId, credential: cred, name: "x", ...LOCAL, session })).toEqual({ ok: false, status: 403, body: { error: PASSKEY_NEEDS_PASSWORD, reauth: true } })
    const reauthed = { ...session, pamAt: clock.t }
    expect((await finishRegistration(d, { challengeId: s.challengeId, credential: cred, name: "x", ...LOCAL, session: reauthed })).ok).toBe(true)
    expect(store.size).toBe(1)
  })

  it("a passkey-only session can't register", async () => {
    const { d } = makeDeps()
    expect(await finishRegistration(d, { challengeId: "x", credential: {}, name: "x", ...LOCAL, session: passkeySession() })).toMatchObject({ status: 403, body: { reauth: true } })
  })

  it("is 400 when the browser's answer doesn't verify, and consumes the challenge", async () => {
    const { d, store } = makeDeps()
    for (const fail of ["attestation", "user_verified", "rp_id", "algorithm"]) {
      expect(await register(d, pamSession(), { fail })).toEqual({ ok: false, status: 400, body: { error: PASSKEY_INVALID } })
    }
    expect(await register(d, pamSession(), { verdict: verdict({ alg: -35 }) })).toEqual({ ok: false, status: 400, body: { error: PASSKEY_INVALID } })
    expect(await register(d, pamSession(), { verdict: verdict({ credentialId: "bad id" }) })).toEqual({ ok: false, status: 400, body: { error: PASSKEY_INVALID } })
    expect(await register(d, pamSession(), { verdict: verdict({ backupEligible: false, backedUp: true }) })).toEqual({ ok: false, status: 400, body: { error: PASSKEY_INVALID } })
    expect(store.size).toBe(0)
  })

  it("is 409 for a credential id already registered, by anyone", async () => {
    const { d, store } = makeDeps()
    const theirs = enrolled(d, "bob").record
    expect(await register(d, pamSession(), { verdict: verdict({ credentialId: theirs.id }) })).toEqual({ ok: false, status: 409, body: { error: PASSKEY_EXISTS } })
    expect(store.get(theirs.id)!.user).toBe("bob")
  })

  it("is 409 when the limit was reached between start and finish", async () => {
    const { d } = makeDeps()
    for (let i = 0; i < MAX_PER_USER_RP - 1; i++) enrolled(d)
    const s = await startRegistration(d, { ...LOCAL, session: pamSession() })
    if (!s.ok) throw new Error()
    enrolled(d)
    const cred = { challenge: s.publicKey.challenge, ...LOCAL, verdict: verdict() }
    expect(await finishRegistration(d, { challengeId: s.challengeId, credential: cred, name: "x", ...LOCAL, session: pamSession() })).toEqual({ ok: false, status: 409, body: { error: PASSKEY_LIMIT } })
  })

  it("a registered passkey then logs in", async () => {
    const { d, store } = makeDeps()
    const r = await register(d, pamSession())
    if (!r.ok) throw new Error()
    const { challengeId, challenge } = loginChallenge(d)
    expect(await attemptPasskeyLogin(d, { challengeId, credential: assertion(r.record.id, challenge, store.userHandle("alice", uidFor("alice")), 1), ...LOCAL, ip: "10.0.0.1" }))
      .toEqual({ ok: true, user: "alice", superuser: false, credentialId: r.record.id })
  })
})

// ----------------------------------------------------------------------------
// Delete and rename
// ----------------------------------------------------------------------------

describe("deletePasskey", () => {
  it("deletes the user's own passkey and audits", () => {
    const { d, store, audits } = makeDeps()
    const { record } = enrolled(d)
    expect(deletePasskey(d, { id: record.id, session: pamSession(), superuser: false })).toEqual({ ok: true })
    expect(store.size).toBe(0)
    expect(audits).toEqual([["PASSKEY_DELETE", "alice: alice's key on portal.localhost"]])
  })

  it("needs a recent password", () => {
    const { d, store } = makeDeps()
    const { record } = enrolled(d)
    const no = { ok: false, status: 403, body: { error: PASSKEY_NEEDS_PASSWORD, reauth: true } }
    expect(deletePasskey(d, { id: record.id, session: passkeySession(), superuser: false })).toEqual(no)
    expect(deletePasskey(d, { id: record.id, session: pamSession("alice", "s", T0 - RECENT_PAM_MS - 1), superuser: false })).toEqual(no)
    expect(store.size).toBe(1)
  })

  it("is 404 for another user's passkey, and for a superuser without actingUser naming its owner", () => {
    const { d, store } = makeDeps()
    const { record } = enrolled(d, "alice")
    const nf = { ok: false, status: 404, body: { error: PASSKEY_NOT_FOUND } }
    expect(deletePasskey(d, { id: record.id, session: pamSession("bob"), superuser: false })).toEqual(nf)
    expect(deletePasskey(d, { id: record.id, session: pamSession("bob"), superuser: false, actingUser: "alice" })).toEqual(nf)
    expect(deletePasskey(d, { id: record.id, session: pamSession("bob"), superuser: true })).toEqual(nf)
    expect(deletePasskey(d, { id: record.id, session: pamSession("bob"), superuser: true, actingUser: "carol" })).toEqual(nf)
    expect(store.size).toBe(1)
  })

  it("lets a superuser acting for the owner delete it", () => {
    const { d, store, audits } = makeDeps()
    const { record } = enrolled(d, "alice")
    expect(deletePasskey(d, { id: record.id, session: pamSession("bob"), superuser: true, actingUser: "alice" })).toEqual({ ok: true })
    expect(store.size).toBe(0)
    expect(audits).toEqual([["PASSKEY_DELETE", "bob for alice: alice's key on portal.localhost"]])
  })

  it("is 404 for unknown or malformed ids", () => {
    const { d } = makeDeps()
    enrolled(d)
    for (const id of [rand(16), "", null, 5, {}, "x".repeat(5000)]) expect(deletePasskey(d, { id, session: pamSession(), superuser: false })).toMatchObject({ status: 404 })
  })
})

describe("renamePasskey", () => {
  it("renames only the session user's own passkey and audits", () => {
    const { d, audits } = makeDeps()
    const { record } = enrolled(d, "alice")
    expect(renamePasskey(d, { id: record.id, name: "x", session: pamSession("bob") })).toEqual({ ok: false, status: 404, body: { error: PASSKEY_NOT_FOUND } })
    const r = renamePasskey(d, { id: record.id, name: " Work\u202e ", session: passkeySession("alice") })
    expect(r.ok && r.record.name).toBe("Work")
    expect(audits).toEqual([["PASSKEY_RENAME", "alice: alice's key -> Work on portal.localhost"]])
    expect(renamePasskey(d, { id: 5, name: "x", session: pamSession() })).toMatchObject({ status: 404 })
  })
})

describe("persisted end to end", () => {
  it("a passkey registered and used survives a restart with its counter", async () => {
    const { d } = makeDeps({ file })
    const r = await register(d, pamSession(), { verdict: verdict({ signCount: 2 }) })
    if (!r.ok) throw new Error()
    const { challengeId, challenge } = loginChallenge(d)
    expect((await attemptPasskeyLogin(d, { challengeId, credential: assertion(r.record.id, challenge, d.store.userHandle("alice", uidFor("alice")), 3), ...LOCAL, ip: "10.0.0.1" })).ok).toBe(true)
    const after = makeDeps({ file })
    expect(after.store.get(r.record.id)).toMatchObject({ signCount: 3, user: "alice" })
    expect(after.store.userHandle("alice", uidFor("alice"))).toBe(d.store.userHandle("alice", uidFor("alice")))
    expect(existsSync(file)).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// Review findings: passkeys tied to the account (uid), PAM's account stage,
// and no superuser on a passkey alone
// ----------------------------------------------------------------------------

describe("passkeys belong to an account, not just a name", () => {
  const login = async (d: PasskeyDeps, record: PasskeyRecord, handle: string, counter: number) => {
    const c = loginChallenge(d)
    return attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle, counter), ...LOCAL, ip: "10.0.0.1" })
  }

  it("a new account with a reused name (another uid) doesn't log in with the old account's passkey", async () => {
    const { d, state, audits } = makeDeps({ superusers: ["alice"] })
    const { record, handle } = enrolled(d, "alice")
    expect(await login(d, record, handle, 6)).toMatchObject({ ok: true, user: "alice" })
    // userdel alice; useradd alice (a sudoer, uid 2001)
    state.uids.set("alice", 2001)
    expect(await login(d, record, handle, 7)).toEqual({ ok: false, status: 401, body: { error: PASSKEY_FAILED } })
    expect(audits.at(-1)).toEqual(["AUTH_FAIL", "alice from 10.0.0.1 (passkey: account changed since the passkey was added)"])
    // Gone altogether
    state.uids.delete("alice")
    expect((await login(d, record, handle, 8)).ok).toBe(false)
  })

  it("registering for the new account drops the old account's passkeys and handle", async () => {
    const { d, state, store } = makeDeps()
    const old = enrolled(d, "alice")
    state.uids.set("alice", 2001)
    const r = await register(d, pamSession())
    expect(r.ok).toBe(true)
    expect(store.get(old.record.id)).toBeNull()
    expect(store.userForHandle(old.handle)).toBeNull()
    expect(store.handleUid("alice")).toBe(2001)
    expect(r.ok && r.record.uid).toBe(2001)
  })

  it("prunePasskeyAccounts drops gone accounts and earlier accounts of a reused name", async () => {
    const { d, state, store, audits } = makeDeps()
    const a = enrolled(d, "alice"), b = enrolled(d, "bob"), c = enrolled(d, "carol")
    state.uids.delete("bob")             // userdel bob
    state.uids.set("carol", 3003)        // carol is someone else now
    expect((await prunePasskeyAccounts(d)).sort()).toEqual(["bob", "carol"])
    expect(store.get(a.record.id)).not.toBeNull()
    expect(store.userForHandle(a.handle)).toBe("alice")
    for (const x of [b, c]) {
      expect(store.get(x.record.id)).toBeNull()
      expect(store.userForHandle(x.handle)).toBeNull()
    }
    expect(audits.filter(x => x[0] === "PASSKEY_DROP").map(x => x[1]).sort()).toEqual([
      "bob: account gone, 1 passkey(s) removed",
      "carol: 1 passkey(s) of an earlier account with this name removed",
    ])
    expect(await prunePasskeyAccounts(d)).toEqual([])
  })

  it("prunePasskeyAccounts keeps everything when the lookup fails", async () => {
    const { d, store } = makeDeps()
    const a = enrolled(d, "alice")
    d.uidOf = async () => { throw new Error("nss down") }
    expect(await prunePasskeyAccounts(d)).toEqual([])
    expect(store.get(a.record.id)).not.toBeNull()
  })

  it("dropAccount removes the passkeys and the handle (a user who left the candy group)", () => {
    const { store } = makeStore(null)
    const h = store.userHandle("alice", 1001)
    added(store); added(store, { rpId: "portal.candy" }); added(store, { user: "bob" })
    expect(store.dropAccount("alice")).toBe(2)
    expect(store.userForHandle(h)).toBeNull()
    expect(store.list("bob")).toHaveLength(1)
  })
})

describe("passkey login runs PAM's account stage", () => {
  it("is refused when pam_acct_mgmt refuses the account (passwd -e, pam_access, nologin), or can't tell", async () => {
    const { d, state, audits } = makeDeps()
    const { record, handle } = enrolled(d, "alice")
    state.acctDenied = ["alice"]
    let c = loginChallenge(d)
    expect(await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle, 6), ...LOCAL, ip: "10.0.0.1" }))
      .toEqual({ ok: false, status: 401, body: { error: PASSKEY_FAILED } })
    expect(audits.at(-1)).toEqual(["AUTH_FAIL", "alice from 10.0.0.1 (passkey: account check)"])
    state.acctDenied = []
    state.acctThrow = true
    c = loginChallenge(d)
    expect((await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle, 7), ...LOCAL, ip: "10.0.0.1" })).ok).toBe(false)
    state.acctThrow = false
    c = loginChallenge(d)
    expect((await attemptPasskeyLogin(d, { challengeId: c.challengeId, credential: assertion(record.id, c.challenge, handle, 8), ...LOCAL, ip: "10.0.0.1" })).ok).toBe(true)
  })
})
