import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { FnLog, LATE_LOG_FLUSH_MS, LOG_RETENTION_MS, MAX_LOG_LINES, REDACTED, redactBody, redactHeaders, replayRequest, type BeginMeta, type RequestSummary } from "../fn-log.ts"

const ROOT = "/tmp/claude-1000/candy-fn-build/phase5/fn-log"
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

let n = 0
const openLog = (opts?: ConstructorParameters<typeof FnLog>[1]) => new FnLog(join(ROOT, `db-${++n}`, "fn.sqlite"), opts)

const enc = (s: string) => new TextEncoder().encode(s)

const meta = (over: Partial<BeginMeta> = {}): BeginMeta => ({
  requestId: `r${++n}`, fn: "hello", host: "hello.localhost", method: "GET", url: "/", clientIp: "127.0.0.1",
  reqHeaders: [], instance: "i1", cold: false, queuedMs: 0, ...over,
})

// Runs one request through the capture hooks.
const record = (log: FnLog, m: Partial<BeginMeta>, res: { status?: number; headers?: [string, string][]; body?: (string | Uint8Array)[]; reqBody?: (string | Uint8Array)[]; outcome?: "ok" | "threw" | "cancelled" | "crashed"; err?: { message: string; stack?: string } } = {}) => {
  const full = meta(m)
  const h = log.begin(full)
  for (const c of res.reqBody ?? []) h.onRequestChunk!(typeof c === "string" ? enc(c) : c)
  if (res.status !== undefined) h.onResponseHead!(res.status, res.headers ?? [])
  for (const c of res.body ?? []) h.onResponseChunk!(typeof c === "string" ? enc(c) : c)
  h.onEnd!(res.outcome ?? "ok", res.err)
  return { id: full.requestId, hooks: h }
}

describe("body capture", () => {
  it("keeps the first bodyLimit bytes, marks truncation and counts every byte", () => {
    const log = openLog({ bodyLimit: 10 })
    const { id } = record(log, { method: "POST", reqHeaders: [["content-type", "text/plain"]] }, {
      reqBody: ["hello ", "world, ", "this is long"],
      status: 200, headers: [["content-type", "text/event-stream"]],
      body: ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"],
    })
    const d = log.get(id)!
    expect(d.reqBody).toMatchObject({ kind: "text", text: "hello worl", truncated: true, size: 25 })
    expect(d.resBody).toMatchObject({ kind: "text", text: "data: 1\n\nd", truncated: true, size: 27 })
    expect(d.reqBytes).toBe(25)
    expect(d.resBytes).toBe(27)
    log.close()
  })

  it("copies chunks so a reused buffer doesn't change what was captured", () => {
    const log = openLog()
    const buf = enc("abc")
    const h = log.begin(meta({ requestId: "reuse", reqHeaders: [["content-type", "text/plain"]], method: "POST" }))
    h.onRequestChunk!(buf)
    buf.set(enc("xyz"))
    h.onEnd!("ok")
    expect(log.get("reuse")!.reqBody.text).toBe("abc")
    log.close()
  })

  it("stores size + sha256 only for non-text bodies", () => {
    const log = openLog({ bodyLimit: 4 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5])
    const { id } = record(log, {}, { status: 200, headers: [["content-type", "image/png"]], body: [png.slice(0, 3), png.slice(3)] })
    const d = log.get(id)!
    const sha = new Bun.CryptoHasher("sha256").update(png).digest("hex")
    expect(d.resBody).toEqual({ kind: "binary", contentType: "image/png", size: 10, truncated: false, text: null, sha256: sha })
    log.close()
  })

  it("treats compressed bodies as binary and sniffs bodies without a content type", () => {
    const log = openLog()
    const gz = record(log, {}, { status: 200, headers: [["content-type", "application/json"], ["content-encoding", "gzip"]], body: ["{}"] })
    expect(log.get(gz.id)!.resBody.kind).toBe("binary")
    const plain = record(log, {}, { status: 200, body: ["just text"] })
    expect(log.get(plain.id)!.resBody).toMatchObject({ kind: "text", text: "just text" })
    const bin = record(log, {}, { status: 200, body: [new Uint8Array([0xff, 0x00, 0xfe])] })
    expect(log.get(bin.id)!.resBody).toMatchObject({ kind: "binary", size: 3 })
    expect(log.get(bin.id)!.resBody.sha256).toHaveLength(64)
    log.close()
  })

  it("does not split a multi-byte character at the limit", () => {
    const log = openLog({ bodyLimit: 4 })
    const { id } = record(log, {}, { status: 200, headers: [["content-type", "text/plain"]], body: ["abcé!"] })
    expect(log.get(id)!.resBody).toMatchObject({ text: "abc", truncated: true, size: 6 })
    log.close()
  })

  it("stores no bodies in meta mode", () => {
    const log = openLog({ mode: "meta" })
    const { id } = record(log, { method: "POST", reqHeaders: [["content-type", "application/json"]] }, {
      reqBody: ['{"a":1}'], status: 201, headers: [["content-type", "text/plain"]], body: ["ok"],
    })
    const d = log.get(id)!
    expect(d.reqBody).toMatchObject({ kind: "omitted", size: 7, text: null, sha256: null })
    expect(d.resBody).toMatchObject({ kind: "omitted", size: 2, text: null })
    expect(d.status).toBe(201)
    log.close()
  })

  it("records timings, outcome, error and logs", () => {
    const log = openLog()
    const h = log.begin(meta({ requestId: "t1", cold: true, queuedMs: 40, instance: "inst-7" }))
    h.addLog({ level: "info", text: "starting", ts: 1 })
    h.onEnd!("threw", { message: "boom", stack: "Error: boom\n    at fetch" })
    h.addLog({ level: "warn", text: "from waitUntil", ts: 2 })
    const d = log.get("t1")!
    expect(d).toMatchObject({ status: 500, outcome: "threw", cold: true, instance: "inst-7", queuedMs: 40, ttfbMs: null })
    expect(d.totalMs).toBeGreaterThanOrEqual(40)
    expect(d.error).toEqual({ message: "boom", stack: "Error: boom\n    at fetch" })
    expect(d.logs.map(l => l.text)).toEqual(["starting", "from waitUntil"])
    log.close()
  })

  it("caps per-request logs", () => {
    const log = openLog()
    const h = log.begin(meta({ requestId: "many" }))
    for (let i = 0; i < MAX_LOG_LINES + 50; i++) h.addLog({ level: "log", text: `line ${i}`, ts: i })
    h.onEnd!("ok")
    const d = log.get("many")!
    expect(d.logs).toHaveLength(MAX_LOG_LINES)
    expect(d.logsTruncated).toBe(true)

    const h2 = log.begin(meta({ requestId: "big" }))
    h2.addLog({ level: "log", text: "x".repeat(300 * 1024), ts: 0 })
    h2.addLog({ level: "log", text: "after", ts: 1 })
    h2.onEnd!("ok")
    const d2 = log.get("big")!
    expect(d2.logs).toHaveLength(1)
    expect(d2.logs[0].text.length).toBe(256 * 1024)
    expect(d2.logsTruncated).toBe(true)
    log.close()
  })

  it("creates the db readable by its owner only", () => {
    const path = join(ROOT, "perm", "fn.sqlite")
    const log = new FnLog(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    log.close()
  })
})

describe("mode changes and late logs", () => {
  it("setMode applies to new requests and keeps tail subscribers", () => {
    const log = openLog()
    const seen: string[] = []
    log.subscribe(s => seen.push(s.id))
    const a = record(log, { method: "POST", reqHeaders: [["content-type", "text/plain"]] }, { reqBody: ["full body"], status: 200 })
    log.setMode("meta")
    const b = record(log, { method: "POST", reqHeaders: [["content-type", "text/plain"]] }, { reqBody: ["meta body"], status: 200 })
    expect(log.get(a.id)!.reqBody.kind).toBe("text")
    expect(log.get(b.id)!.reqBody.kind).toBe("omitted")
    expect(seen).toEqual([a.id, b.id])
    log.close()
  })

  it("writes console lines that trail the response in one batch", async () => {
    const log = openLog()
    const { id, hooks } = record(log, {}, { status: 200 })
    const db = (log as any).db
    const realQuery = db.query.bind(db)
    let updates = 0
    db.query = (sql: string) => {
      if (sql.startsWith("UPDATE requests SET logs")) updates++
      return realQuery(sql)
    }
    for (let i = 0; i < 500; i++) hooks.addLog({ level: "log", text: `late ${i}`, ts: i })
    expect(updates).toBe(0)
    await Bun.sleep(LATE_LOG_FLUSH_MS + 50)
    expect(updates).toBe(1)
    db.query = realQuery
    expect(log.get(id)!.logs).toHaveLength(500)
    log.close()
  })
})

describe("redaction", () => {
  it("redacts sensitive and secret-looking headers", () => {
    const h = redactHeaders([
      ["Authorization", "Bearer abc"], ["Cookie", "s=1"], ["set-cookie", "s=2"], ["Proxy-Authorization", "x"],
      ["X-Api-Key", "k"], ["x-api_key", "k"], ["X-CSRF-Token", "t"], ["X-Client-Secret", "s"],
      ["Content-Type", "text/plain"], ["X-Tenant", "acme"],
    ])
    expect(h.filter(([, v]) => v === REDACTED).map(([k]) => k)).toEqual([
      "Authorization", "Cookie", "set-cookie", "Proxy-Authorization", "X-Api-Key", "x-api_key", "X-CSRF-Token", "X-Client-Secret",
    ])
    expect(redactHeaders([["X-Tenant", "acme"]], ["tenant"])).toEqual([["X-Tenant", REDACTED]])
  })

  it("redacts query tokens in Location and Content-Location", () => {
    expect(redactHeaders([
      ["Location", "https://app.test/cb?code=1&access_token=abc#x"], ["content-location", "/r?api_key=k&page=2"], ["Link", "</a?token=t>"],
    ])).toEqual([
      ["Location", `https://app.test/cb?code=1&access_token=${REDACTED}#x`], ["content-location", `/r?api_key=${REDACTED}&page=2`], ["Link", "</a?token=t>"],
    ])
    expect(redactHeaders([["Location", "/cb?tenant=acme"]], ["tenant"])).toEqual([["Location", `/cb?tenant=${REDACTED}`]])
    const log = openLog()
    const { id } = record(log, {}, { status: 302, headers: [["location", "/login?token=secret1&next=/"]] })
    const d = log.get(id)!
    expect(JSON.stringify(d)).not.toContain("secret1")
    expect(d.resHeaders).toContainEqual(["location", `/login?token=${REDACTED}&next=/`])
    log.close()
  })

  it("redacts JSON fields recursively", () => {
    const out = JSON.parse(redactBody(JSON.stringify({
      user: "a", password: "p", nested: { apiKey: "k", list: [{ refresh_token: "r", ok: 1 }] }, secrets: { a: 1 },
    }), "application/json; charset=utf-8"))
    expect(out).toEqual({ user: "a", password: REDACTED, nested: { apiKey: REDACTED, list: [{ refresh_token: REDACTED, ok: 1 }] }, secrets: REDACTED })
  })

  it("redacts truncated JSON textually", () => {
    const out = redactBody('{"name":"x","token":"abc","more":{"password":"hun', "application/json")
    expect(out).toBe(`{"name":"x","token":"${REDACTED}","more":{"password":"${REDACTED}"`)
  })

  it("redacts form fields and keeps the rest as sent", () => {
    expect(redactBody("user=a%20b&password=hunter2&api-key=x&n=1", "application/x-www-form-urlencoded"))
      .toBe(`user=a%20b&password=${REDACTED}&api-key=${REDACTED}&n=1`)
    expect(redactBody("ssn=1&x=2", "application/x-www-form-urlencoded", ["^ssn$"])).toBe(`ssn=${REDACTED}&x=2`)
  })

  it("leaves other text alone", () => {
    expect(redactBody("password=1", "text/plain")).toBe("password=1")
  })

  it("applies to stored requests, responses, query strings and extra rules", () => {
    const log = openLog({ redact: ["ssn"] })
    const { id } = record(log, {
      method: "POST", url: "/login?token=abc&page=2",
      reqHeaders: [["authorization", "Bearer x"], ["content-type", "application/json"], ["x-ssn", "123"]],
    }, {
      reqBody: ['{"user":"a","password":"p","ssn":"1"}'],
      status: 200, headers: [["set-cookie", "sid=1"], ["content-type", "application/json"]],
      body: ['{"access_token":"t","ok":true}'],
    })
    const d = log.get(id)!
    expect(d.url).toBe(`/login?token=${REDACTED}&page=2`)
    expect(d.path).toBe("/login")
    expect(d.reqHeaders).toEqual([["authorization", REDACTED], ["content-type", "application/json"], ["x-ssn", REDACTED]])
    expect(JSON.parse(d.reqBody.text!)).toEqual({ user: "a", password: REDACTED, ssn: REDACTED })
    expect(d.resHeaders[0]).toEqual(["set-cookie", REDACTED])
    expect(JSON.parse(d.resBody.text!)).toEqual({ access_token: REDACTED, ok: true })
    log.close()
  })
})

describe("query", () => {
  const seed = () => {
    const log = openLog()
    const rows: [string, string, number][] = [
      ["a", "/api/users", 200], ["b", "/api/users/1", 404], ["c", "/static/x.css", 200],
      ["d", "/api/boom", 500], ["e", "/apiary", 503], ["f", "/api/users", 201],
    ]
    for (const [id, url, status] of rows) record(log, { requestId: id, url }, { status })
    // Spread arrival times so since/before have something to cut.
    const db = (log as any).db
    rows.forEach(([id], i) => db.query("UPDATE requests SET ts = ? WHERE id = ?").run(1_000 + i * 100, id))
    return log
  }

  it("returns newest first with a default and max limit", () => {
    const log = seed()
    expect(log.query({}).map(r => r.id)).toEqual(["f", "e", "d", "c", "b", "a"])
    expect(log.query({ limit: 2 }).map(r => r.id)).toEqual(["f", "e"])
    expect(log.query({ limit: 0 })).toHaveLength(1)
    expect(log.query({ limit: 99999 })).toHaveLength(6)
    log.close()
  })

  it("filters by status class, exact code, path prefix and time", () => {
    const log = seed()
    expect(log.query({ status: "5xx" }).map(r => r.id)).toEqual(["e", "d"])
    expect(log.query({ status: "4xx" }).map(r => r.id)).toEqual(["b"])
    expect(log.query({ status: "201" }).map(r => r.id)).toEqual(["f"])
    expect(log.query({ path: "/api/" }).map(r => r.id)).toEqual(["f", "d", "b", "a"])
    expect(log.query({ path: "/api" }).map(r => r.id)).toEqual(["f", "e", "d", "b", "a"])
    expect(log.query({ since: 1_200, before: 1_400 }).map(r => r.id)).toEqual(["d", "c"])
    expect(log.query({ status: "2xx", path: "/api/users" }).map(r => r.id)).toEqual(["f", "a"])
    expect(() => log.query({ status: "bad" })).toThrow()
    log.close()
  })

  it("treats path filters literally", () => {
    const log = openLog()
    record(log, { requestId: "pct", url: "/a%b" }, { status: 200 })
    record(log, { requestId: "under", url: "/a_b" }, { status: 200 })
    expect(log.query({ path: "/a_" }).map(r => r.id)).toEqual(["under"])
    log.close()
  })

  it("notifies subscribers on finished requests", () => {
    const log = openLog()
    const seen: RequestSummary[] = []
    const off = log.subscribe(s => seen.push(s))
    log.subscribe(() => { throw new Error("bad subscriber") })
    const h = log.begin(meta({ requestId: "live", url: "/x?y=1" }))
    expect(seen).toHaveLength(0)
    h.onResponseHead!(204, [])
    h.onEnd!("ok")
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id: "live", status: 204, path: "/x", outcome: "ok" })
    off()
    record(log, {}, { status: 200 })
    expect(seen).toHaveLength(1)
    log.close()
  })

  it("survives reopening the same file", () => {
    const path = join(ROOT, "reopen", "fn.sqlite")
    const a = new FnLog(path)
    record(a, { requestId: "kept" }, { status: 200 })
    a.close()
    const b = new FnLog(path)
    expect(b.get("kept")?.status).toBe(200)
    expect(b.get("missing")).toBeNull()
    b.close()
  })
})

describe("sweep", () => {
  it("deletes rows older than 24h", () => {
    const log = openLog()
    const now = Date.now()
    record(log, { requestId: "old" }, { status: 200 })
    record(log, { requestId: "new" }, { status: 200 })
    ;(log as any).db.query("UPDATE requests SET ts = ? WHERE id = 'old'").run(now - LOG_RETENTION_MS - 1)
    log.sweep(now)
    expect(log.query({}).map(r => r.id)).toEqual(["new"])
    log.close()
  })

  it("drops the oldest rows to stay under maxBytes", () => {
    const log = openLog({ maxBytes: 1e9 })
    for (let i = 0; i < 10; i++) {
      record(log, { requestId: `s${i}` }, { status: 200, headers: [["content-type", "text/plain"]], body: ["x".repeat(1000)] })
    }
    const rowBytes = ((log as any).db.query("SELECT bytes FROM requests LIMIT 1").get() as { bytes: number }).bytes
    ;(log as any).maxBytes = rowBytes * 3 + 10
    log.sweep()
    expect(log.query({}).map(r => r.id)).toEqual(["s9", "s8", "s7"])
    log.close()
  })

  it("enforces the size cap on insert too", () => {
    const log = openLog({ maxBytes: 5000 })
    for (let i = 0; i < 20; i++) {
      record(log, { requestId: `c${i}` }, { status: 200, headers: [["content-type", "text/plain"]], body: ["x".repeat(1000)] })
    }
    const ids = log.query({}).map(r => r.id)
    expect(ids.length).toBeLessThan(5)
    expect(ids[0]).toBe("c19")
    log.close()
  })
})

describe("replay", () => {
  it("rebuilds the request and drops redacted values", async () => {
    const log = openLog()
    const { id } = record(log, {
      method: "POST", url: "/api/x?token=abc&page=2", host: "hello.localhost",
      reqHeaders: [["authorization", "Bearer x"], ["content-type", "application/json"], ["content-length", "13"], ["x-trace", "1"]],
    }, { reqBody: ['{"a":1,"b":2}'], status: 200 })
    const req = replayRequest(log.get(id)!, {})
    expect(req.method).toBe("POST")
    expect(req.url).toBe("http://hello.localhost/api/x?page=2")
    expect(req.headers.get("authorization")).toBeNull()
    expect(req.headers.get("x-trace")).toBe("1")
    expect(await req.text()).toBe('{"a":1,"b":2}')
    log.close()
  })

  it("keeps absolute URLs and sends no body for GET", async () => {
    const log = openLog()
    const { id } = record(log, { url: "http://hello.localhost/p" }, { status: 200 })
    const req = replayRequest(log.get(id)!, {})
    expect(req.url).toBe("http://hello.localhost/p")
    expect(req.body).toBeNull()
    log.close()
  })

  it("refuses truncated, hashed-only or unlogged bodies unless allowPartial", async () => {
    const log = openLog({ bodyLimit: 4 })
    const trunc = record(log, { method: "POST", reqHeaders: [["content-type", "text/plain"]] }, { reqBody: ["abcdefgh"], status: 200 })
    expect(() => replayRequest(log.get(trunc.id)!, {})).toThrow(/truncated/)
    expect(await replayRequest(log.get(trunc.id)!, { allowPartial: true }).text()).toBe("abcd")

    const bin = record(log, { method: "PUT", reqHeaders: [["content-type", "application/octet-stream"]] }, { reqBody: [new Uint8Array([1, 2])], status: 200 })
    expect(() => replayRequest(log.get(bin.id)!, {})).toThrow(/hash/)
    expect(await replayRequest(log.get(bin.id)!, { allowPartial: true }).text()).toBe("")
    log.close()

    const metaLog = openLog({ mode: "meta" })
    const m = record(metaLog, { method: "POST" }, { reqBody: ["x"], status: 200 })
    expect(() => replayRequest(metaLog.get(m.id)!, {})).toThrow(/not logged/)
    metaLog.close()
  })
})

describe("kind and rule", () => {
  it("defaults to worker with no rule, and stores worker-first rules", () => {
    const log = openLog()
    const { id } = record(log, {}, { status: 200 })
    expect(log.get(id)).toMatchObject({ kind: "worker", rule: null })
    const wf = record(log, { url: "/api/me", rule: "worker-first:/api/*" }, { status: 200 })
    expect(log.get(wf.id)).toMatchObject({ kind: "worker", rule: "worker-first:/api/*" })
  })

  it("keeps asset rows meta only, with the size from Content-Length", () => {
    const log = openLog()
    const { id } = record(log, { kind: "asset", rule: "spa-navigate", instance: "" }, {
      status: 200, headers: [["content-type", "text/html"], ["content-length", "1234"]], body: ["<html>"],
    })
    const d = log.get(id)!
    expect(d.kind).toBe("asset")
    expect(d.rule).toBe("spa-navigate")
    expect(d.resBody.kind).toBe("omitted")
    expect(d.resBody.text).toBe(null)
    expect(d.resBytes).toBe(1234 + 6)
    expect(log.query()[0]).toMatchObject({ id, kind: "asset", rule: "spa-navigate" })
  })

  it("adds the columns to a log written before they existed", () => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const path = join(ROOT, "old", "fn.sqlite")
    mkdirSync(join(ROOT, "old"), { recursive: true })
    const old = new Database(path, { create: true })
    old.exec(`CREATE TABLE requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, fn TEXT NOT NULL,
      host TEXT NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL, path TEXT NOT NULL, client_ip TEXT NOT NULL,
      status INTEGER, outcome TEXT NOT NULL, cold INTEGER NOT NULL, instance TEXT NOT NULL, queued_ms INTEGER NOT NULL,
      ttfb_ms INTEGER, total_ms INTEGER NOT NULL, req_bytes INTEGER NOT NULL, res_bytes INTEGER NOT NULL,
      req_headers TEXT NOT NULL, res_headers TEXT NOT NULL, req_body TEXT NOT NULL, res_body TEXT NOT NULL,
      error TEXT, logs TEXT NOT NULL, logs_truncated INTEGER NOT NULL, bytes INTEGER NOT NULL)`)
    const none = JSON.stringify({ kind: "none", contentType: null, size: 0, truncated: false, text: null, sha256: null })
    old.query(`INSERT INTO requests (id, ts, fn, host, method, url, path, client_ip, status, outcome, cold, instance, queued_ms,
      ttfb_ms, total_ms, req_bytes, res_bytes, req_headers, res_headers, req_body, res_body, error, logs, logs_truncated, bytes)
      VALUES ('old1', ?, 'hello', 'hello.localhost', 'GET', '/', '/', '127.0.0.1', 200, 'ok', 0, 'i1', 0, 1, 1, 0, 0, '[]', '[]', ?, ?, NULL, '[]', 0, 300)`)
      .run(Date.now(), none, none)
    old.close()
    const log = new FnLog(path)
    expect(log.get("old1")).toMatchObject({ kind: "worker", rule: null })
    const { id } = record(log, { kind: "asset", rule: "/old / 301" }, { status: 301 })
    expect(log.get(id)).toMatchObject({ kind: "asset", rule: "/old / 301" })
    log.close()
    // Opening again is a no-op for the migration
    const again = new FnLog(path)
    expect(again.query().length).toBe(2)
    again.close()
  })
})
