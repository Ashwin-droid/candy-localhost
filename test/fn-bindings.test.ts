import { afterAll, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildEnv, closeBindings, createD1, createKV, splitSql, type D1Database, type KVNamespace } from "../fn-bindings.ts"

const ROOT = "/tmp/claude-1000/candy-fn-build/phase2-bindings"
mkdirSync(ROOT, { recursive: true })
const base = mkdtempSync(join(ROOT, "t-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let n = 0
const fresh = (name = "f") => join(base, `${name}-${++n}.sqlite`)
const close = (...xs: unknown[]) => closeBindings(Object.fromEntries(xs.map((x, i) => [String(i), x])))

describe("KV", () => {
  it("gets values as text, json, arrayBuffer and stream", async () => {
    const kv = createKV(fresh(), "KV")
    await kv.put("s", "héllo")
    await kv.put("j", JSON.stringify({ a: 1 }))
    await kv.put("b", new Uint8Array([1, 2, 3]))
    await kv.put("ab", new Uint8Array([9, 8]).buffer)
    await kv.put("view", new Uint8Array([0, 5, 6, 0]).subarray(1, 3))
    expect(await kv.get("s")).toBe("héllo")
    expect(await kv.get("s", "text")).toBe("héllo")
    expect(await kv.get("j", "json")).toEqual({ a: 1 })
    expect(await kv.get("j", { type: "json" })).toEqual({ a: 1 })
    expect([...new Uint8Array(await kv.get("b", "arrayBuffer"))]).toEqual([1, 2, 3])
    expect([...new Uint8Array(await kv.get("ab", "arrayBuffer"))]).toEqual([9, 8])
    expect([...new Uint8Array(await kv.get("view", "arrayBuffer"))]).toEqual([5, 6])
    const stream = await kv.get("s", "stream")
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(await new Response(stream).text()).toBe("héllo")
    expect(await kv.get("missing")).toBeNull()
    await expect(kv.get("s", "nope" as any)).rejects.toThrow("unknown KV get type")
    close(kv)
  })

  it("supports bulk get", async () => {
    const kv = createKV(fresh(), "KV")
    await kv.put("a", "1")
    const m = await kv.get(["a", "b"])
    expect(m).toBeInstanceOf(Map)
    expect(m.get("a")).toBe("1")
    expect(m.get("b")).toBeNull()
    close(kv)
  })

  it("puts from a ReadableStream", async () => {
    const kv = createKV(fresh(), "KV")
    const body = new Response("streamed body").body!
    await kv.put("k", body)
    expect(await kv.get("k")).toBe("streamed body")
    close(kv)
  })

  it("stores metadata and returns it with getWithMetadata", async () => {
    const kv = createKV(fresh(), "KV")
    await kv.put("k", "v", { metadata: { owner: "me", n: 2 } })
    expect(await kv.getWithMetadata("k")).toEqual({ value: "v", metadata: { owner: "me", n: 2 }, cacheStatus: null })
    await kv.put("plain", "x")
    expect(await kv.getWithMetadata("plain", "text")).toEqual({ value: "x", metadata: null, cacheStatus: null })
    expect(await kv.getWithMetadata("missing")).toEqual({ value: null, metadata: null, cacheStatus: null })
    // overwrite replaces metadata too
    await kv.put("k", "v2")
    expect((await kv.getWithMetadata("k")).metadata).toBeNull()
    close(kv)
  })

  it("deletes keys", async () => {
    const kv = createKV(fresh(), "KV")
    await kv.put("k", "v")
    await kv.delete("k")
    expect(await kv.get("k")).toBeNull()
    await kv.delete("never-existed")
    close(kv)
  })

  it("enforces key, value and metadata limits", async () => {
    const kv = createKV(fresh(), "KV")
    await expect(kv.put("", "v")).rejects.toThrow()
    await expect(kv.put(".", "v")).rejects.toThrow()
    await expect(kv.put("x".repeat(513), "v")).rejects.toThrow("512")
    await kv.put("x".repeat(512), "v")
    // multi-byte chars count in bytes, not characters
    await expect(kv.put("é".repeat(257), "v")).rejects.toThrow("512")
    await expect(kv.put("big", new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow("larger than")
    await expect(kv.put("meta", "v", { metadata: { x: "y".repeat(1100) } })).rejects.toThrow("1024")
    await expect(kv.put("k", 42 as any)).rejects.toThrow()
    close(kv)
  })

  it("hides expired keys and enforces the 60s minimum", async () => {
    let now = 1_700_000_000_000
    const path = fresh()
    const kv = createKV(path, "KV", { now: () => now })
    await expect(kv.put("k", "v", { expirationTtl: 30 })).rejects.toThrow("60")
    await expect(kv.put("k", "v", { expiration: now / 1000 + 10 })).rejects.toThrow("60")
    await kv.put("ttl", "v", { expirationTtl: 60 })
    await kv.put("abs", "v", { expiration: now / 1000 + 120, metadata: { m: 1 } })
    await kv.put("forever", "v")
    let l = await kv.list()
    expect(l.keys).toEqual([
      { name: "abs", expiration: now / 1000 + 120, metadata: { m: 1 } },
      { name: "forever" },
      { name: "ttl", expiration: now / 1000 + 60 },
    ])
    now += 61_000
    expect(await kv.get("ttl")).toBeNull()
    expect(await kv.getWithMetadata("ttl")).toEqual({ value: null, metadata: null, cacheStatus: null })
    expect(await kv.get("abs")).toBe("v")
    l = await kv.list()
    expect(l.keys.map(k => k.name)).toEqual(["abs", "forever"])
    now += 60_000
    expect(await kv.get("abs")).toBeNull()
    // expired rows were swept from the table, not just hidden
    const raw = new Database(path, { readonly: true })
    expect(raw.query(`SELECT key FROM "kv_KV" ORDER BY key`).all()).toEqual([{ key: "forever" }])
    raw.close()
    close(kv)
  })

  it("lists with prefix and paginates with a cursor", async () => {
    const kv = createKV(fresh(), "KV")
    for (let i = 0; i < 25; i++) await kv.put(`user:${String(i).padStart(2, "0")}`, "v")
    await kv.put("other", "v")
    await kv.put("user_", "v") // "_" must not act as a wildcard
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = await kv.list({ prefix: "user:", limit: 10, cursor })
      pages++
      seen.push(...page.keys.map(k => k.name))
      if (page.list_complete) { expect(page.cursor).toBeUndefined(); break }
      expect(page.keys.length).toBe(10)
      cursor = page.cursor
    }
    expect(pages).toBe(3)
    expect(seen.length).toBe(25)
    expect(seen[0]).toBe("user:00")
    expect(seen[24]).toBe("user:24")
    const all = await kv.list()
    expect(all.keys.length).toBe(27)
    expect(all.list_complete).toBe(true)
    // exact page boundary still reports complete correctly
    const exact = await kv.list({ prefix: "user:", limit: 25 })
    expect(exact.list_complete).toBe(true)
    await expect(kv.list({ limit: 0 })).rejects.toThrow()
    close(kv)
  })

  it("defaults list limit to 1000 and caps it there", async () => {
    const kv = createKV(fresh(), "KV")
    for (let i = 0; i < 1005; i++) await kv.put(`k${String(i).padStart(4, "0")}`, "")
    const first = await kv.list()
    expect(first.keys.length).toBe(1000)
    expect(first.list_complete).toBe(false)
    expect((await kv.list({ limit: 5000 })).keys.length).toBe(1000)
    const rest = await kv.list({ cursor: first.cursor })
    expect(rest.keys.map(k => k.name)).toEqual(["k1000", "k1001", "k1002", "k1003", "k1004"])
    close(kv)
  })

  it("keeps bindings in separate tables of one file", async () => {
    const path = fresh()
    const a = createKV(path, "A")
    const b = createKV(path, "B")
    await a.put("k", "from a")
    expect(await b.get("k")).toBeNull()
    expect(() => createKV(path, "bad name; drop")).toThrow("invalid binding")
    expect(() => createKV(path, "1X")).toThrow("invalid binding")
    close(a, b)
  })

  it("shares data between two connections to the same file", async () => {
    const path = fresh()
    const one = createKV(path, "KV")
    const two = createKV(path, "KV")
    await one.put("k", "v1")
    expect(await two.get("k")).toBe("v1")
    await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? one : two).put(`c${i}`, String(i))))
    expect((await one.list({ prefix: "c" })).keys.length).toBe(50)
    await two.delete("k")
    expect(await one.get("k")).toBeNull()
    const mode = new Database(path).query("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(mode.journal_mode).toBe("wal")
    close(one, two)
  })
})

describe("D1", () => {
  const setup = async (path = fresh("d1")) => {
    const db = createD1(path)
    await db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER, data BLOB);`)
    return db
  }

  it("runs writes with D1-shaped meta", async () => {
    const db = await setup()
    const r = await db.prepare("INSERT INTO users (name, active) VALUES (?, ?)").bind("ann", true).run()
    expect(r.success).toBe(true)
    expect(r.results).toEqual([])
    expect(r.meta.changes).toBe(1)
    expect(r.meta.last_row_id).toBe(1)
    expect(r.meta.rows_written).toBe(1)
    expect(r.meta.changed_db).toBe(true)
    expect(r.meta.size_after).toBeGreaterThan(0)
    expect(typeof r.meta.duration).toBe("number")
    const r2 = await db.prepare("INSERT INTO users (name, active) VALUES (?1, ?2)").bind("bob", false).run()
    expect(r2.meta.last_row_id).toBe(2)
    close(db)
  })

  it("all, first and raw", async () => {
    const db = await setup()
    await db.prepare("INSERT INTO users (name, active, data) VALUES (?, ?, ?)").bind("ann", true, new Uint8Array([1, 2])).run()
    await db.prepare("INSERT INTO users (name, active) VALUES (?, ?)").bind("bob", false).run()
    const all = await db.prepare("SELECT id, name, active, data FROM users ORDER BY id").all()
    expect(all.results).toEqual([
      { id: 1, name: "ann", active: 1, data: [1, 2] },
      { id: 2, name: "bob", active: 0, data: null },
    ])
    expect(all.meta.rows_read).toBe(2)
    expect(all.meta.changes).toBe(0)
    expect(all.meta.changed_db).toBe(false)

    const q = db.prepare("SELECT id, name FROM users WHERE name = ?")
    expect(await q.bind("bob").first()).toEqual({ id: 2, name: "bob" })
    expect(await q.bind("bob").first("name")).toBe("bob")
    expect(await q.bind("zed").first()).toBeNull()
    expect(await q.bind("zed").first("name")).toBeNull()
    await expect(q.bind("bob").first("nope")).rejects.toThrow("D1_COLUMN_NOTFOUND")
    // bind returns a new statement; the original stays unbound
    await expect(q.first()).rejects.toThrow()

    const raw = db.prepare("SELECT id, name FROM users ORDER BY id")
    expect(await raw.raw()).toEqual([[1, "ann"], [2, "bob"]])
    expect(await raw.raw({ columnNames: true })).toEqual([["id", "name"], [1, "ann"], [2, "bob"]])
    close(db)
  })

  it("supports RETURNING", async () => {
    const db = await setup()
    const r = await db.prepare("INSERT INTO users (name) VALUES (?) RETURNING id, name").bind("cy").all()
    expect(r.results).toEqual([{ id: 1, name: "cy" }])
    expect(r.meta.changes).toBe(1)
    close(db)
  })

  it("rejects undefined and unsupported bind values like D1", async () => {
    const db = await setup()
    expect(() => db.prepare("SELECT ?").bind(undefined)).toThrow("D1_TYPE_ERROR")
    expect(() => db.prepare("SELECT ?").bind({ a: 1 })).toThrow("D1_TYPE_ERROR")
    expect(await db.prepare("SELECT ? AS a, ? AS b, ? AS c").bind(null, 1.5, "x").first()).toEqual({ a: null, b: 1.5, c: "x" })
    close(db)
  })

  it("wraps SQL errors with D1_ERROR", async () => {
    const db = await setup()
    await expect(db.prepare("SELEC nonsense").all()).rejects.toThrow("D1_ERROR")
    await db.prepare("INSERT INTO users (name) VALUES ('a')").run()
    await expect(db.prepare("INSERT INTO users (name) VALUES ('a')").run()).rejects.toThrow(/D1_ERROR: .*UNIQUE/)
    close(db)
  })

  it("batch runs in one transaction and returns one result per statement", async () => {
    const db = await setup()
    const ins = db.prepare("INSERT INTO users (name) VALUES (?)")
    const res = await db.batch([ins.bind("a"), ins.bind("b"), db.prepare("SELECT count(*) AS n FROM users")])
    expect(res.length).toBe(3)
    expect(res[0].meta.changes).toBe(1)
    expect(res[2].results).toEqual([{ n: 2 }])
    close(db)
  })

  it("batch rolls back everything when one statement fails", async () => {
    const db = await setup()
    const ins = db.prepare("INSERT INTO users (name) VALUES (?)")
    await ins.bind("taken").run()
    await expect(db.batch([ins.bind("x"), ins.bind("y"), ins.bind("taken")])).rejects.toThrow("D1_ERROR")
    const names = await db.prepare("SELECT name FROM users ORDER BY name").raw()
    expect(names).toEqual([["taken"]])
    // statements from another database are refused
    const other = await setup()
    await expect(db.batch([other.prepare("SELECT 1")])).rejects.toThrow()
    close(db, other)
  })

  it("exec runs multi-statement scripts", async () => {
    const db = createD1(fresh("d1"))
    const r = await db.exec(`
      -- a comment; with a semicolon
      CREATE TABLE t (v TEXT);
      INSERT INTO t VALUES ('a;b'); /* block; comment */
      INSERT INTO t VALUES ("x");
      CREATE TABLE log (v TEXT);
      CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO log VALUES (new.v); INSERT INTO log VALUES ('again'); END;
      INSERT INTO t VALUES ('c')
    `)
    expect(r.count).toBe(6)
    expect(typeof r.duration).toBe("number")
    expect(await db.prepare("SELECT v FROM t").raw()).toEqual([["a;b"], ["x"], ["c"]])
    expect(await db.prepare("SELECT v FROM log").raw()).toEqual([["c"], ["again"]])
    await expect(db.exec("CREATE TABLE z (a); BROKEN SQL;")).rejects.toThrow("D1_ERROR")
    close(db)
  })

  it("splitSql handles quotes, comments and triggers", () => {
    expect(splitSql("a; b ;; -- c;\n d")).toEqual(["a", "b", "-- c;\n d"])
    expect(splitSql("select 'it''s;'; select \"q;\"")).toEqual(["select 'it''s;'", 'select "q;"'])
    expect(splitSql("create temp trigger t after insert on x begin select case when 1 then 2 end; end; select 1")).toEqual([
      "create temp trigger t after insert on x begin select case when 1 then 2 end; end",
      "select 1",
    ])
    expect(splitSql("  -- only a comment\n")).toEqual([])
  })

  it("dump returns a sqlite file image", async () => {
    const db = await setup()
    await db.prepare("INSERT INTO users (name) VALUES ('dumped')").run()
    const buf = await db.dump()
    expect(buf).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(new Uint8Array(buf, 0, 15))).toBe("SQLite format 3")
    const copy = Database.deserialize(new Uint8Array(buf))
    expect(copy.query("SELECT name FROM users").all()).toEqual([{ name: "dumped" }])
    copy.close()
    close(db)
  })

  it("two connections to the same file see each other's writes", async () => {
    const path = fresh("d1")
    const a = await setup(path)
    const b = await setup(path)
    await a.prepare("INSERT INTO users (name) VALUES ('from-a')").run()
    expect(await b.prepare("SELECT name FROM users").first("name")).toBe("from-a")
    // interleaved batches from both connections all land (busy_timeout serializes them)
    const ins = (db: D1Database, i: number) => db.batch([db.prepare("INSERT INTO users (name) VALUES (?)").bind(`n${i}`)])
    await Promise.all(Array.from({ length: 20 }, (_, i) => ins(i % 2 ? a : b, i)))
    expect(await a.prepare("SELECT count(*) AS n FROM users").first("n")).toBe(21)
    close(a, b)
  })

  it("survives a writer in another process holding the lock briefly", async () => {
    const path = fresh("d1")
    const db = await setup(path)
    const proc = Bun.spawn(["bun", "-e", `
      const { Database } = require("bun:sqlite")
      const d = new Database(${JSON.stringify(path)})
      d.run("PRAGMA busy_timeout = 5000")
      d.run("BEGIN IMMEDIATE")
      d.run("INSERT INTO users (name) VALUES ('other-proc')")
      console.log("locked")
      Bun.sleepSync(300)
      d.run("COMMIT")
    `], { stdout: "pipe" })
    const reader = proc.stdout.getReader()
    await reader.read() // wait for "locked"
    await db.prepare("INSERT INTO users (name) VALUES ('mine')").run()
    await proc.exited
    expect(await db.prepare("SELECT name FROM users ORDER BY id").raw()).toEqual([["other-proc"], ["mine"]])
    close(db)
  })
})

describe("buildEnv", () => {
  it("layers vars, secrets and bindings, and creates the state dir", async () => {
    const stateDir = join(base, "state-" + ++n, "nested")
    const cfg = {
      main: "index.ts", vars: { GREETING: "hi", TOKEN: "from-vars" }, kv: ["CACHE", "SESSIONS"], d1: ["DB"],
      crons: [], warnings: [], source: null,
    }
    const env = buildEnv(cfg, stateDir, { TOKEN: "secret" })
    expect(env.GREETING).toBe("hi")
    expect(env.TOKEN).toBe("secret")
    const cache = env.CACHE as KVNamespace
    const sessions = env.SESSIONS as KVNamespace
    const db = env.DB as D1Database
    await cache.put("k", "v")
    expect(await sessions.get("k")).toBeNull()
    await db.exec("CREATE TABLE t (a)")
    expect(existsSync(join(stateDir, "kv.sqlite"))).toBe(true)
    expect(existsSync(join(stateDir, "d1-DB.sqlite"))).toBe(true)

    // a second instance of the same function sees the same state
    const env2 = buildEnv(cfg, stateDir, {})
    expect(await (env2.CACHE as KVNamespace).get("k")).toBe("v")
    expect(env2.TOKEN).toBe("from-vars")
    closeBindings(env)
    closeBindings(env2)
    // closed connections refuse further work
    await expect(cache.get("k")).rejects.toThrow()
  })

  it("creates the state dir even with no bindings and rejects bad binding names", () => {
    const stateDir = join(base, "state-" + ++n)
    const env = buildEnv({ main: "i.ts", vars: {}, kv: [], d1: [], crons: [], warnings: [], source: null }, stateDir, {})
    expect(env).toEqual({})
    expect(existsSync(stateDir)).toBe(true)
    expect(() => buildEnv({ main: "i.ts", vars: {}, kv: ["../x"], d1: [], crons: [], warnings: [], source: null }, stateDir, {})).toThrow()
  })
})
