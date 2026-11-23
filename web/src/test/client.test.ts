import { describe, expect, test } from "bun:test"
import { ApiError, checkPath, createApi, parse, queryString, TOKEN_REJECTED_MESSAGE } from "../api/client.ts"
import { BOOT, fakeFetch, fakeLocation, fakeStorage, type FakeFetch } from "./render.tsx"

function setup(handlers: Record<string, (req: Request) => Response | Promise<Response>>, o?: { now?: () => number; session?: string | null }) {
  let n = 0
  const base: Record<string, (req: Request) => Response | Promise<Response>> = {
    "POST /portal/boot": () => Response.json({ ...BOOT, token: `boot${++n}` }),
    "POST /token": async (req) => {
      const { token } = await req.json() as { token: string }
      return Response.json({ token: `${token}+` })
    },
  }
  const f = fakeFetch({ ...base, ...handlers }) as FakeFetch
  const storage = fakeStorage(o?.session === null ? {} : { candy_session: o?.session ?? "sess-1" })
  const location = fakeLocation()
  const api = createApi({ fetch: f, storage, location, now: o?.now })
  return { api, f, storage, location }
}

const pathsOf = (f: FakeFetch) => f.calls.map(r => `${r.method} ${new URL(r.url).pathname}`)

describe("client headers", () => {
  test("X-Candy-Session on every call, no token on GETs, no /token after a GET", async () => {
    const { api, f } = setup({ "GET /status": () => Response.json({ status: "running" }) })
    await api.get("/status")
    await api.get("/status", { a: 1, b: "", c: null, d: undefined, e: false })
    expect(pathsOf(f)).toEqual(["GET /status", "GET /status"])
    for (const r of f.calls) {
      expect(r.headers.get("X-Candy-Session")).toBe("sess-1")
      expect(r.headers.get("X-Candy-Token")).toBeNull()
      expect(r.headers.get("Accept")).toBe("application/json")
    }
    expect(new URL(f.calls[1].url).search).toBe("?a=1&e=false")
  })

  test("mutations carry the lane token and roll it with POST /token afterwards", async () => {
    const { api, f } = setup({ "POST /fn/deploy": () => Response.json({ success: true }) })
    await api.boot()
    await api.post("/fn/deploy", { name: "x" })
    await api.post("/fn/deploy", { name: "y" })
    expect(pathsOf(f)).toEqual(["POST /portal/boot", "POST /fn/deploy", "POST /token", "POST /fn/deploy", "POST /token"])
    expect(f.calls[0].headers.get("X-Candy-Token")).toBeNull()        // boot is tokenless
    expect(f.calls[1].headers.get("X-Candy-Token")).toBe("boot1")
    expect(await f.calls[2].json()).toEqual({ token: "boot1" })
    expect(f.calls[2].headers.get("X-Candy-Token")).toBeNull()        // /token is tokenless
    expect(f.calls[3].headers.get("X-Candy-Token")).toBe("boot1+")
    expect(f.calls[1].headers.get("Content-Type")).toBe("application/json")
    expect(await f.calls[1].json()).toEqual({ name: "x" })
    expect(f.calls[1].headers.get("X-Candy-Session")).toBe("sess-1")
  })

  test("DELETE is a mutation too", async () => {
    const { api, f } = setup({ "DELETE /config/x": () => Response.json({ success: true }) })
    await api.del("/config/x")
    expect(pathsOf(f)).toEqual(["POST /portal/boot", "DELETE /config/x", "POST /token"])
    expect(f.calls[1].headers.get("X-Candy-Token")).toBe("boot1")
  })

  test("a token 401 refreshes and retries once with the new token", async () => {
    let first = true
    const { api, f } = setup({
      "POST /process/stop/x": (req) => {
        if (first) { first = false; return Response.json({ error: TOKEN_REJECTED_MESSAGE }, { status: 401, headers: { "X-Candy-Token": "invalid" } }) }
        return Response.json({ success: true, token: req.headers.get("X-Candy-Token") })
      },
    })
    const r = await api.post<{ token: string }>("/process/stop/x")
    expect(r.token).toBe("boot1+")
    expect(pathsOf(f)).toEqual(["POST /portal/boot", "POST /process/stop/x", "POST /token", "POST /process/stop/x", "POST /token"])
  })

  test("a handler's own 401 (a wrong re-auth password) is sent once, and the chain still rolls", async () => {
    let calls = 0
    const { api, f } = setup({
      "POST /auth/reauth": () => { calls++; return Response.json({ error: "Wrong username or password." }, { status: 401 }) },
    })
    const err = await api.post("/auth/reauth", { password: "typo" }).catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect((err as ApiError).message).toBe("Wrong username or password.")
    expect(calls).toBe(1)
    expect(pathsOf(f)).toEqual(["POST /portal/boot", "POST /auth/reauth", "POST /token"])
  })

  test("the token-rejection body alone (no marker header) is still retried", async () => {
    let first = true
    const { api, f } = setup({
      "POST /x": () => {
        if (first) { first = false; return Response.json({ error: TOKEN_REJECTED_MESSAGE }, { status: 401 }) }
        return Response.json({ success: true })
      },
    })
    await api.post("/x")
    expect(pathsOf(f).filter(p => p === "POST /x")).toHaveLength(2)
  })

  test("a dead chain re-boots the lane once, and not again within 30 s", async () => {
    let clock = 1_000_000
    let deadUntilBoot = 0
    const { api, f } = setup({
      "POST /token": () => Response.json({ error: "unknown token" }, { status: 401 }),
      "POST /x": (req) => {
        const t = req.headers.get("X-Candy-Token") ?? ""
        return Number(t.replace("boot", "")) > deadUntilBoot ? Response.json({ success: true }) : Response.json({ error: TOKEN_REJECTED_MESSAGE }, { status: 401, headers: { "X-Candy-Token": "invalid" } })
      },
    }, { now: () => clock })
    await api.boot()                      // boot1
    deadUntilBoot = 1                     // boot1 is dead; a re-boot gives boot2
    await api.post("/x")
    expect(pathsOf(f).filter(p => p === "POST /portal/boot")).toHaveLength(2)
    deadUntilBoot = 2                     // boot2 dies too, 10 s later: no re-boot inside the window
    clock += 10_000
    const err = await api.post("/x").catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect(pathsOf(f).filter(p => p === "POST /portal/boot")).toHaveLength(2)
    clock += 30_000                       // after the window it may re-boot again
    deadUntilBoot = 2
    await api.post("/x")
    expect(pathsOf(f).filter(p => p === "POST /portal/boot")).toHaveLength(3)
  })

  test("the first boot is shared by concurrent callers", async () => {
    const { api, f } = setup({})
    const [a, b] = await Promise.all([api.boot(), api.boot()])
    expect(a).toBe(b)
    expect(pathsOf(f)).toEqual(["POST /portal/boot"])
  })

  test("long and term lanes mint their own chains on first use", async () => {
    const { api, f } = setup({ "POST /fn/deploy": () => Response.json({ success: true }), "POST /process/input/x": () => Response.json({ success: true }) })
    await api.boot()
    await api.post("/fn/deploy", { name: "x" }, { lane: "long" })
    await api.post("/process/input/x", { input: "a" }, { lane: "term" })
    expect(f.calls[2].headers.get("X-Candy-Token")).toBe("boot2")
    expect(f.calls.find(r => new URL(r.url).pathname === "/process/input/x")!.headers.get("X-Candy-Token")).toBe("boot3")
  })

  test("401 + X-Candy-Login removes the session and goes to /login once; the promise never settles", async () => {
    const { api, storage, location } = setup({
      "GET /status": () => new Response("{}", { status: 401, headers: { "X-Candy-Login": "required" } }),
    })
    let settled = false
    void api.get("/status").then(() => { settled = true }, () => { settled = true })
    void api.get("/status").then(() => { settled = true }, () => { settled = true })
    await new Promise(r => setTimeout(r, 10))
    expect(settled).toBe(false)
    expect(storage.getItem("candy_session")).toBeNull()
    expect(location.assigned).toEqual(["/login?next=" + encodeURIComponent("/sites/api?x=1#h")])
  })

  test("boot answering 401 + X-Candy-Login redirects too", async () => {
    const { api, location } = setup({
      "POST /portal/boot": () => new Response("{}", { status: 401, headers: { "X-Candy-Login": "required" } }),
    })
    void api.boot()
    await new Promise(r => setTimeout(r, 10))
    expect(location.assigned).toHaveLength(1)
  })

  test("//x, /\\x and https://x are refused before any request is made", async () => {
    const { api, f } = setup({})
    for (const p of ["//evil.example/x", "/\\evil.example", "https://evil.example/x", "status", ""]) {
      await expect(api.get(p)).rejects.toBeInstanceOf(ApiError)
      await expect(api.post(p, {})).rejects.toBeInstanceOf(ApiError)
      await expect(api.del(p)).rejects.toBeInstanceOf(ApiError)
    }
    expect(f.calls).toHaveLength(0)
    expect(() => checkPath("/ok", "https://portal.localhost")).not.toThrow()
  })

  test("a network failure is ApiError status 0 with the daemon message", async () => {
    const api = createApi({
      fetch: (async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch,
      storage: fakeStorage({ candy_session: "s" }), location: fakeLocation(),
    })
    const err = await api.get("/status").catch(e => e) as ApiError
    expect(err.status).toBe(0)
    expect(err.message).toBe("Can't reach the candy daemon.")
  })

  test("a 403 calls onSuperuserLost and is thrown with forbidden/reauth", async () => {
    let lost = 0
    const f = fakeFetch({ "GET /system/stats": () => Response.json({ error: "Superuser only", reauth: true }, { status: 403 }) })
    const api = createApi({ fetch: f, storage: fakeStorage({ candy_session: "s" }), location: fakeLocation(), onSuperuserLost: () => { lost++ } })
    const err = await api.get("/system/stats").catch(e => e) as ApiError
    expect(err.forbidden).toBe(true)
    expect(err.reauth).toBe(true)
    expect(err.message).toBe("Superuser only")
    expect(lost).toBe(1)
  })

  test("streams ask for text/event-stream with the session and no token", async () => {
    const { api, f } = setup({ "GET /stream/x": () => new Response("data: 1\n\n", { headers: { "Content-Type": "text/event-stream" } }) })
    const res = await api.stream("/stream/x", { a: 1 }, { signal: new AbortController().signal })
    expect(res.ok).toBe(true)
    expect(f.calls[0].headers.get("Accept")).toBe("text/event-stream")
    expect(f.calls[0].headers.get("X-Candy-Session")).toBe("sess-1")
    expect(f.calls[0].headers.get("X-Candy-Token")).toBeNull()
  })
})

describe("serialisation per lane", () => {
  test("two concurrent posts never share a token", async () => {
    const seen: string[] = []
    let inflight = 0, maxInflight = 0
    const { api } = setup({
      "POST /x": async (req) => {
        inflight++; maxInflight = Math.max(maxInflight, inflight)
        seen.push(req.headers.get("X-Candy-Token")!)
        await new Promise(r => setTimeout(r, 5))
        inflight--
        return Response.json({ success: true })
      },
    })
    await Promise.all([api.post("/x"), api.post("/x"), api.post("/x")])
    expect(new Set(seen).size).toBe(3)
    expect(maxInflight).toBe(1)
    expect(seen).toEqual(["boot1", "boot1+", "boot1++"])
  })

  test("a failing mutation doesn't block the next one", async () => {
    let n = 0
    const { api } = setup({ "POST /x": () => (n++ === 0 ? Response.json({ error: "nope" }, { status: 400 }) : Response.json({ ok: 1 })) })
    const a = api.post("/x").catch(e => e)
    const b = api.post<{ ok: number }>("/x")
    expect(await a).toBeInstanceOf(ApiError)
    expect((await b).ok).toBe(1)
  })
})

describe("parse", () => {
  test("error, details and the failure rules", async () => {
    await expect(parse(Response.json({ error: "x", details: "y" }, { status: 400 }))).rejects.toThrow("x: y")
    await expect(parse(Response.json({ success: false }))).rejects.toThrow("Request failed (200)")
    await expect(parse(Response.json({ error: "boom" }))).rejects.toThrow("boom")
    expect(await parse(Response.json({ id: "r1", error: { message: "threw" } }))).toEqual({ id: "r1", error: { message: "threw" } })
    expect(await parse(Response.json({ id: "r1", error: "threw" }))).toEqual({ id: "r1", error: "threw" })
    expect(await parse(new Response("not json"))).toEqual({})
    await expect(parse(new Response("oops", { status: 502 }))).rejects.toThrow("Request failed (502)")
    const w = { warning: true, message: "m", existingRecords: [], fqdn: "a.b" }
    expect(await parse(Response.json(w))).toEqual(w)
    const e = await parse(Response.json({ error: "slow down", retryAfter: 7 }, { status: 429 })).catch(x => x) as ApiError
    expect(e.retryAfter).toBe(7)
    const e2 = await parse(Response.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "5" } })).catch(x => x) as ApiError
    expect(e2.retryAfter).toBe(5)
  })

  test("409 with configs keeps the body on the error", async () => {
    const e = await parse(Response.json({ success: false, error: "several", configs: [{ id: "a", cwd: "/", cmd: "x" }] }, { status: 409 })).catch(x => x) as ApiError
    expect(e.status).toBe(409)
    expect((e.data as { configs: unknown[] }).configs).toHaveLength(1)
  })

  test("queryString skips empty values", () => {
    expect(queryString({ a: "x y", b: undefined, c: null, d: "", e: 0 })).toBe("?a=x+y&e=0")
    expect(queryString()).toBe("")
  })
})
