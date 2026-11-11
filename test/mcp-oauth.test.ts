import { describe, expect, it } from "bun:test"
import { OAuthServer, type OAuthOptions, type OAuthPersisted } from "../mcp-oauth.ts"

const ISSUER = "https://candy.example.com"
const RESOURCE = "https://candy.example.com/mcp"
const CB = "https://client.example/cb"
const T0 = 1_800_000_000_000
const SEC = 1000
const MIN = 60 * SEC
const DAY = 24 * 60 * MIN

const VERIFIER = "v".repeat(43)
const s256 = (v: string) => Buffer.from(new Bun.CryptoHasher("sha256").update(v).digest()).toString("base64url")
const CHALLENGE = s256(VERIFIER)

/** A server on a clock the test controls, plus a record of every onChange call. */
const make = (over: Partial<OAuthOptions> = {}) => {
  const clock = { t: T0 }
  const changes: OAuthPersisted[] = []
  const srv = new OAuthServer({ issuer: ISSUER, resource: RESOURCE, now: () => clock.t, onChange: s => changes.push(s), ...over })
  return { srv, clock, changes }
}

const register = (srv: OAuthServer, uris: unknown = [CB], name: unknown = "Test client") => {
  const r = srv.registerClient({ redirect_uris: uris, client_name: name })
  if (!r.ok) throw new Error(`register failed: ${r.error_description}`)
  return (r.client as any).client_id as string
}

const authParams = (clientId: string, over: Record<string, string | null> = {}) => {
  const p = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CB,
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz",
  })
  for (const [k, v] of Object.entries(over)) v === null ? p.delete(k) : p.set(k, v)
  return p
}

const start = (srv: OAuthServer, clientId: string, over: Record<string, string | null> = {}) => {
  const r = srv.startAuthorization(authParams(clientId, over))
  if (!r.ok) throw new Error(`authorize failed: ${r.error_description}`)
  return r.requestId
}

/** authorize -> allow -> complete; returns the code from the redirect. */
const getCode = (srv: OAuthServer, clientId: string, approver = "ashwin") => {
  const requestId = start(srv, clientId)
  const d = srv.decide(requestId, true, approver)
  if (!d.ok) throw new Error("decide failed")
  const c = srv.complete(requestId, d.grant)
  if (!c.ok) throw new Error("complete failed")
  return new URL(c.redirect).searchParams.get("code")!
}

const codeForm = (clientId: string, code: string, over: Record<string, string | null> = {}) => {
  const p = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: CB, code_verifier: VERIFIER })
  for (const [k, v] of Object.entries(over)) v === null ? p.delete(k) : p.set(k, v)
  return p
}
const refreshForm = (clientId: string, refreshToken: string) =>
  new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken })

/** The whole dance; returns the token response body. */
const login = (srv: OAuthServer, clientId: string) => {
  const res = srv.token(codeForm(clientId, getCode(srv, clientId)))
  if (res.status !== 200) throw new Error(`token failed: ${JSON.stringify(res.body)}`)
  return res.body as { access_token: string; refresh_token: string; token_type: string; expires_in: number }
}

const errorOf = (r: { status: number; body: object }) => (r.body as any).error as string

describe("metadata", () => {
  it("describes the resource and the authorization server", () => {
    const { srv } = make()
    expect(srv.protectedResourceMetadata()).toEqual({
      resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"],
    })
    expect(srv.authorizationServerMetadata()).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    })
  })
})

describe("happy path", () => {
  it("register -> authorize -> allow -> complete -> token -> verify -> refresh", () => {
    const { srv, clock } = make()
    const reg = srv.registerClient({ redirect_uris: [CB], client_name: "Claude" })
    expect(reg).toMatchObject({
      ok: true,
      client: {
        client_id_issued_at: T0 / 1000, redirect_uris: [CB], client_name: "Claude",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      },
    })
    const clientId = (reg as any).client.client_id as string
    expect(Buffer.from(clientId, "base64url").length).toBeGreaterThanOrEqual(16)

    const requestId = start(srv, clientId, { resource: RESOURCE })
    expect(srv.getRequest(requestId)).toEqual({
      clientId, clientName: "Claude", redirectUri: CB, createdAt: T0, expiresAt: T0 + 10 * MIN, decided: false,
    })

    const d = srv.decide(requestId, true, "ashwin@tailnet")
    if (!d.ok) throw new Error("decide")
    expect(srv.getRequest(requestId)).toMatchObject({ decided: true, expiresAt: T0 + 2 * MIN })

    const c = srv.complete(requestId, d.grant)
    if (!c.ok) throw new Error("complete")
    const back = new URL(c.redirect)
    expect(back.origin + back.pathname).toBe(CB)
    expect(back.searchParams.get("state")).toBe("xyz")
    expect(back.searchParams.get("iss")).toBe(ISSUER)
    expect(srv.getRequest(requestId)).toBeNull()

    const tok = srv.token(codeForm(clientId, back.searchParams.get("code")!))
    expect(tok.status).toBe(200)
    const body = tok.body as any
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 })
    expect(Buffer.from(body.access_token, "base64url").length).toBe(32)

    expect(srv.verifyAccessToken(body.access_token)).toEqual({
      clientId, clientName: "Claude", approver: "ashwin@tailnet", expiresAt: T0 + 60 * MIN,
    })

    clock.t += 30 * MIN
    const again = srv.token(refreshForm(clientId, body.refresh_token))
    expect(again.status).toBe(200)
    const next = again.body as any
    expect(next.refresh_token).not.toBe(body.refresh_token)
    expect(srv.verifyAccessToken(next.access_token)).toMatchObject({ clientId, approver: "ashwin@tailnet" })
    expect(srv.listClients()).toEqual([{ clientId, clientName: "Claude", createdAt: T0, lastUsedAt: clock.t, activeGrants: 1 }])
  })

  it("omits state when the client sent none", () => {
    const { srv } = make()
    const clientId = register(srv)
    const requestId = start(srv, clientId, { state: null })
    const d = srv.decide(requestId, true)
    if (!d.ok) throw new Error("decide")
    const c = srv.complete(requestId, d.grant)
    if (!c.ok) throw new Error("complete")
    const q = new URL(c.redirect).searchParams
    expect(q.has("state")).toBe(false)
    expect(q.has("code")).toBe(true)
    const tok = srv.token(codeForm(clientId, q.get("code")!))
    expect(srv.verifyAccessToken((tok.body as any).access_token)).toMatchObject({ approver: null })
  })
})

describe("deny path", () => {
  it("redirects with access_denied and issues no code", () => {
    const { srv } = make()
    const clientId = register(srv)
    const requestId = start(srv, clientId)
    const d = srv.decide(requestId, false, "ashwin")
    if (!d.ok) throw new Error("decide")
    const c = srv.complete(requestId, d.grant)
    if (!c.ok) throw new Error("complete")
    const q = new URL(c.redirect).searchParams
    expect(q.get("error")).toBe("access_denied")
    expect(q.get("state")).toBe("xyz")
    expect(q.get("iss")).toBe(ISSUER)
    expect(q.has("code")).toBe(false)
    expect(srv.complete(requestId, d.grant).ok).toBe(false)  // consumed
  })
})

describe("client registration", () => {
  it("accepts https, loopback http and private-use schemes", () => {
    const { srv } = make()
    for (const uri of [
      "https://app.example/cb?x=1", "http://localhost/cb", "http://localhost:8080/cb",
      "http://127.0.0.1:9999/cb", "http://[::1]/cb", "com.example.app:/cb",
    ]) {
      expect(srv.registerClient({ redirect_uris: [uri] })).toMatchObject({ ok: true })
    }
  })

  it("rejects dangerous or malformed redirect URIs", () => {
    const { srv, changes } = make()
    for (const uri of [
      "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "http://example.com/cb",
      "http://localhost.evil.example/cb", "https://app.example/cb#frag", "https://app.example/cb#",
      "https://user:pw@app.example/cb", "myapp:/cb", "not a url", "", "/relative", 42, null,
      "https://a.example/" + "x".repeat(3000),
    ]) {
      expect(srv.registerClient({ redirect_uris: [uri] })).toMatchObject({ ok: false, status: 400, error: "invalid_redirect_uri" })
    }
    // one bad URI spoils the whole registration
    expect(srv.registerClient({ redirect_uris: [CB, "http://example.com/cb"] }).ok).toBe(false)
    expect(changes.length).toBe(0)
  })

  it("requires a non-empty redirect_uris array of at most 10", () => {
    const { srv } = make()
    expect(srv.registerClient({}).ok).toBe(false)
    expect(srv.registerClient({ redirect_uris: [] }).ok).toBe(false)
    expect(srv.registerClient({ redirect_uris: CB }).ok).toBe(false)
    const many = (n: number) => Array.from({ length: n }, (_, i) => `https://app.example/cb${i}`)
    expect(srv.registerClient({ redirect_uris: many(10) }).ok).toBe(true)
    expect(srv.registerClient({ redirect_uris: many(11) }).ok).toBe(false)
  })

  it("cleans the client name and ignores a requested auth method", () => {
    const { srv } = make()
    const name = (n: unknown) => (srv.registerClient({ redirect_uris: [CB], client_name: n }) as any).client.client_name
    expect(name("  My\u0000 App\n\u001b[31m ")).toBe("My App[31m")
    expect(name("n".repeat(500))).toBe("n".repeat(100))
    expect(name(undefined)).toBe("Unnamed client")
    expect(name("   ")).toBe("Unnamed client")
    expect(name({ evil: true })).toBe("Unnamed client")
    const r = srv.registerClient({ redirect_uris: [CB], token_endpoint_auth_method: "client_secret_basic", grant_types: ["implicit"] }) as any
    expect(r.client.token_endpoint_auth_method).toBe("none")
    expect(r.client.grant_types).toEqual(["authorization_code", "refresh_token"])
    expect(r.client.client_secret).toBeUndefined()
  })

  it("evicts the least recently used idle client at the limit, never one with a live grant", () => {
    const { srv, clock } = make()
    const first = register(srv, [CB], "first")
    login(srv, first)                       // first now holds a live refresh token
    clock.t += SEC
    const second = register(srv, [CB], "second")
    for (let i = 2; i < 100; i++) { clock.t += SEC; register(srv, [CB], `c${i}`) }
    expect(srv.listClients().length).toBe(100)

    clock.t += SEC
    const extra = register(srv, [CB], "extra")
    const ids = srv.listClients().map(c => c.clientId)
    expect(ids.length).toBe(100)
    expect(ids).toContain(first)
    expect(ids).not.toContain(second)
    expect(ids).toContain(extra)
  })

  it("refuses to register when every client is in use", () => {
    const { srv } = make()
    for (let i = 0; i < 100; i++) login(srv, register(srv))
    expect(srv.registerClient({ redirect_uris: [CB] })).toMatchObject({ ok: false, status: 400 })
    expect(srv.listClients().length).toBe(100)
  })
})

describe("authorization request validation", () => {
  it("never redirects for an unknown client or an unregistered redirect_uri", () => {
    const { srv } = make()
    const clientId = register(srv)
    for (const p of [
      authParams("nope"),
      authParams(clientId, { client_id: null }),
      authParams(clientId, { redirect_uri: "https://evil.example/cb" }),
      authParams(clientId, { redirect_uri: CB + "/" }),
      authParams(clientId, { redirect_uri: CB + "?extra=1" }),
      authParams(clientId, { redirect_uri: null }),
    ]) {
      const r = srv.startAuthorization(p)
      expect(r).toMatchObject({ ok: false, status: 400 })
      expect((r as any).redirect).toBeUndefined()
    }
  })

  it("reports other problems to the client's redirect URI with state and iss", () => {
    const { srv } = make()
    const clientId = register(srv)
    const cases: [Record<string, string | null>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ response_type: null }, "invalid_request"],
      [{ code_challenge: null }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ code_challenge: "a".repeat(129) }, "invalid_request"],
      [{ code_challenge: "!".repeat(43) }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: null }, "invalid_request"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ]
    for (const [over, error] of cases) {
      const r = srv.startAuthorization(authParams(clientId, over))
      expect(r).toMatchObject({ ok: false, error })
      const u = new URL((r as any).redirect)
      expect(u.origin + u.pathname).toBe(CB)
      expect(u.searchParams.get("error")).toBe(error)
      expect(u.searchParams.get("error_description")).toBeTruthy()
      expect(u.searchParams.get("state")).toBe("xyz")
      expect(u.searchParams.get("iss")).toBe(ISSUER)
    }
  })

  it("accepts the configured resource with or without a trailing slash", () => {
    const { srv } = make()
    const clientId = register(srv)
    expect(srv.startAuthorization(authParams(clientId, { resource: RESOURCE })).ok).toBe(true)
    expect(srv.startAuthorization(authParams(clientId, { resource: RESOURCE + "/" })).ok).toBe(true)
    expect(srv.startAuthorization(authParams(clientId, { resource: ISSUER })).ok).toBe(false)
  })

  it("ignores the port of loopback http redirect URIs only", () => {
    const { srv } = make()
    const clientId = register(srv, ["http://127.0.0.1/cb", "https://app.example/cb"])
    const ok = (uri: string) => srv.startAuthorization(authParams(clientId, { redirect_uri: uri })).ok
    expect(ok("http://127.0.0.1:51234/cb")).toBe(true)
    expect(ok("http://127.0.0.1/cb")).toBe(true)
    expect(ok("http://127.0.0.1:51234/other")).toBe(false)
    expect(ok("http://localhost:51234/cb")).toBe(false)      // a different host, even if also loopback
    expect(ok("http://127.0.0.1:51234/cb#frag")).toBe(false)
    expect(ok("https://app.example:8443/cb")).toBe(false)    // no port games for https

    // the code goes to the port the client actually asked for, and the token request must name it too
    const requestId = start(srv, clientId, { redirect_uri: "http://127.0.0.1:51234/cb" })
    const d = srv.decide(requestId, true) as any
    const c = srv.complete(requestId, d.grant) as any
    const back = new URL(c.redirect)
    expect(back.port).toBe("51234")
    const code = back.searchParams.get("code")!
    expect(errorOf(srv.token(codeForm(clientId, code, { redirect_uri: "http://127.0.0.1/cb" })))).toBe("invalid_grant")
    expect(srv.token(codeForm(clientId, code, { redirect_uri: "http://127.0.0.1:51234/cb" })).status).toBe(200)
  })

  it("caps state and keeps at most 50 pending requests", () => {
    const { srv, clock } = make()
    const clientId = register(srv)
    const long = srv.startAuthorization(authParams(clientId, { state: "s".repeat(2049) }))
    expect(long).toMatchObject({ ok: false, error: "invalid_request" })
    expect(new URL((long as any).redirect).searchParams.has("state")).toBe(false)
    expect(srv.startAuthorization(authParams(clientId, { state: "s".repeat(2048) })).ok).toBe(true)
    srv.revokeAll()

    const again = register(srv)
    const ids: string[] = []
    for (let i = 0; i < 51; i++) { clock.t += 1; ids.push(start(srv, again)) }
    expect(srv.getRequest(ids[0])).toBeNull()
    expect(srv.getRequest(ids[1])).not.toBeNull()
    expect(srv.getRequest(ids[50])).not.toBeNull()
  })
})

describe("decide and complete", () => {
  it("allows only one decision per request", () => {
    const { srv } = make()
    const requestId = start(srv, register(srv))
    expect(srv.decide(requestId, true).ok).toBe(true)
    expect(srv.decide(requestId, false)).toMatchObject({ ok: false, status: 409 })
    expect(srv.decide(requestId, true)).toMatchObject({ ok: false })
    expect(srv.decide("unknown", true)).toMatchObject({ ok: false, status: 404 })
  })

  it("a wrong grant is refused without consuming the request", () => {
    const { srv } = make()
    const requestId = start(srv, register(srv))
    expect(srv.complete(requestId, "anything")).toMatchObject({ ok: false, status: 409 })  // not decided yet
    const d = srv.decide(requestId, true) as any
    const wrong = srv.complete(requestId, "wrong-grant")
    expect(wrong).toMatchObject({ ok: false, status: 403 })
    expect(JSON.stringify(wrong)).not.toContain(d.grant)
    expect((wrong as any).redirect).toBeUndefined()
    expect(srv.complete(requestId, d.grant.slice(0, -1))).toMatchObject({ ok: false })
    expect(srv.complete(requestId, d.grant).ok).toBe(true)
    expect(srv.complete(requestId, d.grant).ok).toBe(false)  // one-time
  })

  it("a grant only works for its own request", () => {
    const { srv } = make()
    const clientId = register(srv)
    const a = start(srv, clientId)
    const b = start(srv, clientId)
    const da = srv.decide(a, true) as any
    srv.decide(b, false)
    expect(srv.complete(b, da.grant).ok).toBe(false)
    expect(srv.complete(a, da.grant).ok).toBe(true)
  })

  it("expires undecided requests after 10 minutes and grants after 2", () => {
    const { srv, clock } = make()
    const clientId = register(srv)
    const stale = start(srv, clientId)
    clock.t += 10 * MIN - 1
    expect(srv.getRequest(stale)).not.toBeNull()
    clock.t += 1
    expect(srv.getRequest(stale)).toBeNull()
    expect(srv.decide(stale, true)).toMatchObject({ ok: false, status: 404 })

    const requestId = start(srv, clientId)
    clock.t += 9 * MIN
    const d = srv.decide(requestId, true) as any
    clock.t += 2 * MIN - 1
    expect(srv.getRequest(requestId)).not.toBeNull()   // deciding late still leaves the full 2 minutes
    clock.t += 1
    expect(srv.complete(requestId, d.grant)).toMatchObject({ ok: false, status: 404 })
  })
})

describe("token endpoint: authorization_code", () => {
  it("requires every field and a known grant type", () => {
    const { srv } = make()
    const clientId = register(srv)
    const code = getCode(srv, clientId)
    expect(errorOf(srv.token(codeForm(clientId, code, { grant_type: null })))).toBe("invalid_request")
    expect(errorOf(srv.token(codeForm(clientId, code, { grant_type: "password" })))).toBe("unsupported_grant_type")
    for (const field of ["code", "client_id", "redirect_uri", "code_verifier"]) {
      const r = srv.token(codeForm(clientId, code, { [field]: null }))
      expect(r.status).toBe(400)
      expect(errorOf(r)).toBe("invalid_request")
    }
    expect(srv.token(codeForm(clientId, code, { client_id: "nope" }))).toMatchObject({ status: 401, body: { error: "invalid_client" } })
    expect(errorOf(srv.token(codeForm(clientId, code, { resource: "https://other.example/mcp" })))).toBe("invalid_target")
    expect(srv.token(codeForm(clientId, code)).status).toBe(200)  // none of the above burned the code
  })

  it("checks PKCE, redirect_uri and client binding without echoing secrets", () => {
    const { srv } = make()
    const clientId = register(srv)
    const other = register(srv)
    const code = getCode(srv, clientId)
    const tries = [
      srv.token(codeForm(clientId, code, { code_verifier: "w".repeat(43) })),
      srv.token(codeForm(clientId, code, { code_verifier: "short" })),
      srv.token(codeForm(clientId, code, { code_verifier: CHALLENGE })),   // the challenge is not the verifier
      srv.token(codeForm(clientId, code, { redirect_uri: "https://client.example/other" })),
      srv.token(codeForm(other, code)),
      srv.token(codeForm(clientId, "not-a-code")),
    ]
    for (const r of tries) {
      expect(r.status).toBe(400)
      expect(errorOf(r)).toBe("invalid_grant")
      expect(JSON.stringify(r.body)).not.toContain(code)
      expect(JSON.stringify(r.body)).not.toContain("w".repeat(43))
    }
    expect(srv.token(codeForm(clientId, code)).status).toBe(200)
  })

  it("expires a code after 60 seconds", () => {
    const { srv, clock } = make()
    const clientId = register(srv)
    const late = getCode(srv, clientId)
    clock.t += 60 * SEC
    expect(errorOf(srv.token(codeForm(clientId, late)))).toBe("invalid_grant")
    const fresh = getCode(srv, clientId)
    clock.t += 60 * SEC - 1
    expect(srv.token(codeForm(clientId, fresh)).status).toBe(200)
  })

  it("replaying a code revokes the tokens it produced", () => {
    const { srv, clock } = make()
    const clientId = register(srv)
    const code = getCode(srv, clientId)
    const first = srv.token(codeForm(clientId, code)).body as any
    const unrelated = login(srv, clientId)
    clock.t += 5 * MIN   // past the code's own lifetime: a replay is still recognised

    expect(errorOf(srv.token(codeForm(clientId, code)))).toBe("invalid_grant")
    expect(srv.verifyAccessToken(first.access_token)).toBeNull()
    expect(errorOf(srv.token(refreshForm(clientId, first.refresh_token)))).toBe("invalid_grant")
    // a separate approval for the same client is untouched
    expect(srv.verifyAccessToken(unrelated.access_token)).not.toBeNull()
    expect(srv.token(refreshForm(clientId, unrelated.refresh_token)).status).toBe(200)
  })
})

describe("token endpoint: refresh_token", () => {
  it("rotates, and reuse of an old token revokes the whole family", () => {
    const { srv } = make()
    const clientId = register(srv)
    const t1 = login(srv, clientId)
    const other = login(srv, clientId)
    const t2 = srv.token(refreshForm(clientId, t1.refresh_token)).body as any
    const t3 = srv.token(refreshForm(clientId, t2.refresh_token)).body as any
    expect(srv.verifyAccessToken(t3.access_token)).not.toBeNull()
    expect(srv.listClients()[0].activeGrants).toBe(2)

    const reuse = srv.token(refreshForm(clientId, t1.refresh_token))
    expect(reuse.status).toBe(400)
    expect(errorOf(reuse)).toBe("invalid_grant")
    expect(JSON.stringify(reuse.body)).not.toContain(t1.refresh_token)
    for (const t of [t1, t2, t3]) expect(srv.verifyAccessToken(t.access_token)).toBeNull()
    expect(errorOf(srv.token(refreshForm(clientId, t3.refresh_token)))).toBe("invalid_grant")

    expect(srv.listClients()[0].activeGrants).toBe(1)
    expect(srv.verifyAccessToken(other.access_token)).not.toBeNull()
  })

  it("requires the token and the client that owns it", () => {
    const { srv } = make()
    const clientId = register(srv)
    const other = register(srv)
    const t = login(srv, clientId)
    expect(errorOf(srv.token(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId })))).toBe("invalid_request")
    expect(errorOf(srv.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token })))).toBe("invalid_request")
    expect(errorOf(srv.token(refreshForm(other, t.refresh_token)))).toBe("invalid_grant")
    expect(errorOf(srv.token(refreshForm(clientId, "made-up")))).toBe("invalid_grant")
    expect(errorOf(srv.token(refreshForm(clientId, t.access_token)))).toBe("invalid_grant")
    expect(srv.token(refreshForm(clientId, t.refresh_token)).status).toBe(200)  // the wrong client didn't burn it
  })

  it("expires access tokens after an hour and refresh tokens after 30 days", () => {
    const { srv, clock } = make()
    const clientId = register(srv)
    const t = login(srv, clientId)
    clock.t += 60 * MIN - 1
    expect(srv.verifyAccessToken(t.access_token)).not.toBeNull()
    clock.t += 1
    expect(srv.verifyAccessToken(t.access_token)).toBeNull()
    expect(srv.verifyAccessToken(t.refresh_token)).toBeNull()   // a refresh token is not a bearer token

    clock.t = T0 + 30 * DAY - 1
    const t2 = srv.token(refreshForm(clientId, t.refresh_token)).body as any
    expect(t2.refresh_token).toBeTruthy()
    clock.t += 30 * DAY
    expect(errorOf(srv.token(refreshForm(clientId, t2.refresh_token)))).toBe("invalid_grant")
    expect(srv.listClients()[0].activeGrants).toBe(0)
  })

  it("rotation cannot stretch one approval past 90 days", () => {
    const { srv, clock } = make()
    const clientId = register(srv)
    let t = login(srv, clientId) as any
    for (let i = 0; i < 4; i++) {            // refresh every 20 days: day 20, 40, 60, 80
      clock.t += 20 * DAY
      const r = srv.token(refreshForm(clientId, t.refresh_token))
      expect(r.status).toBe(200)
      t = r.body
    }
    expect(srv.persisted().refreshTokens.find(r => !r.rotated)!.expiresAt).toBe(T0 + 90 * DAY)
    clock.t = T0 + 90 * DAY - 1
    const last = srv.token(refreshForm(clientId, t.refresh_token))
    expect(last.status).toBe(200)
    clock.t += 1
    expect(errorOf(srv.token(refreshForm(clientId, (last.body as any).refresh_token)))).toBe("invalid_grant")
  })
})

describe("persistence", () => {
  it("stores only hashes and never access tokens", () => {
    const { srv } = make()
    const clientId = register(srv)
    const t = login(srv, clientId)
    const json = JSON.stringify(srv.persisted())
    expect(json).not.toContain(t.access_token)
    expect(json).not.toContain(t.refresh_token)
    const state = JSON.parse(json) as OAuthPersisted
    expect(state.clients.length).toBe(1)
    expect(state.refreshTokens.length).toBe(1)
    expect(state.refreshTokens[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(state.refreshTokens[0].hash).toBe(new Bun.CryptoHasher("sha256").update(t.refresh_token).digest("hex"))
  })

  it("a restarted server honours refresh tokens but not old access tokens", () => {
    const { srv, clock } = make()
    const clientId = register(srv, [CB], "Persisted")
    const t = login(srv, clientId)
    const t2 = srv.token(refreshForm(clientId, t.refresh_token)).body as any

    const state = JSON.parse(JSON.stringify(srv.persisted()))
    const { srv: srv2 } = make({ persisted: state, now: () => clock.t })
    expect(srv2.verifyAccessToken(t2.access_token)).toBeNull()
    expect(srv2.listClients()).toMatchObject([{ clientId, clientName: "Persisted", activeGrants: 1 }])
    const t3 = srv2.token(refreshForm(clientId, t2.refresh_token))
    expect(t3.status).toBe(200)
    expect(srv2.verifyAccessToken((t3.body as any).access_token)).toMatchObject({ clientId, approver: "ashwin" })
    // reuse detection survives the restart too
    expect(errorOf(srv2.token(refreshForm(clientId, t.refresh_token)))).toBe("invalid_grant")
    expect(srv2.listClients()[0].activeGrants).toBe(0)
    // and the registration itself still works
    expect(srv2.startAuthorization(authParams(clientId)).ok).toBe(true)
  })

  it("survives corrupt persisted state", () => {
    const junk: any[] = [
      null, undefined, 42, "x", [], {}, { clients: "no", refreshTokens: 7 },
      { clients: [null, 1, { clientId: 5 }, { clientId: "a", clientName: "a", redirectUris: ["javascript:x"], createdAt: 1 }],
        refreshTokens: [null, { hash: "zz" }, { hash: "a".repeat(64), clientId: "ghost", familyId: "f", issuedAt: 1, expiresAt: T0 * 2, familyStartedAt: 1 }] },
    ]
    for (const persisted of junk) {
      const { srv } = make({ persisted })
      expect(srv.persisted()).toEqual({ clients: [], refreshTokens: [] })
    }
  })

  it("calls onChange for clients and refresh tokens, not for transient state", () => {
    const { srv, changes, clock } = make()
    const clientId = register(srv)
    expect(changes.length).toBe(1)
    expect(changes[0].clients[0].clientId).toBe(clientId)

    const requestId = start(srv, clientId)
    srv.getRequest(requestId)
    const d = srv.decide(requestId, true) as any
    const c = srv.complete(requestId, d.grant) as any
    expect(changes.length).toBe(1)           // pending requests and codes are not persisted

    const t = srv.token(codeForm(clientId, new URL(c.redirect).searchParams.get("code")!)).body as any
    expect(changes.length).toBe(2)
    expect(changes[1].refreshTokens.length).toBe(1)

    srv.verifyAccessToken(t.access_token)
    srv.verifyAccessToken(t.access_token)
    expect(changes.length).toBe(2)           // access token use within the same few minutes is not a change

    clock.t += 10 * MIN
    srv.verifyAccessToken(t.access_token)
    expect(changes.length).toBe(3)           // lastUsedAt moved
    expect(changes[2].clients[0].lastUsedAt).toBe(clock.t)

    srv.token(refreshForm(clientId, t.refresh_token))
    expect(changes.length).toBe(4)
    srv.token(refreshForm(clientId, t.refresh_token))   // reuse: family revoked
    expect(changes.length).toBe(5)
    expect(changes[4].refreshTokens.length).toBe(0)

    expect(srv.revokeClient(clientId)).toBe(true)
    expect(changes.length).toBe(6)
    srv.revokeAll()
    expect(changes.length).toBe(7)
    expect(changes[6]).toEqual({ clients: [], refreshTokens: [] })
  })

  it("a throwing onChange does not break the flow", () => {
    const { srv } = make({ onChange: () => { throw new Error("disk full") } })
    const clientId = register(srv)
    expect(srv.verifyAccessToken(login(srv, clientId).access_token)).not.toBeNull()
  })
})

describe("revocation and cleanup", () => {
  it("revokeClient removes the client, its tokens and its pending requests", () => {
    const { srv } = make()
    const a = register(srv, [CB], "a")
    const b = register(srv, [CB], "b")
    const ta = login(srv, a)
    const tb = login(srv, b)
    const pendingA = start(srv, a)
    const codeA = getCode(srv, a)

    expect(srv.revokeClient(a)).toBe(true)
    expect(srv.revokeClient(a)).toBe(false)
    expect(srv.revokeClient("nope")).toBe(false)
    expect(srv.verifyAccessToken(ta.access_token)).toBeNull()
    expect(srv.token(refreshForm(a, ta.refresh_token))).toMatchObject({ status: 401, body: { error: "invalid_client" } })
    expect(srv.getRequest(pendingA)).toBeNull()
    expect(srv.token(codeForm(a, codeA)).status).toBe(401)
    expect(srv.startAuthorization(authParams(a))).toMatchObject({ ok: false, status: 400 })
    expect(srv.listClients().map(c => c.clientId)).toEqual([b])
    expect(srv.verifyAccessToken(tb.access_token)).not.toBeNull()
    expect(srv.persisted().refreshTokens.every(r => r.clientId === b)).toBe(true)
  })

  it("revokeAll drops everything", () => {
    const { srv } = make()
    const clientId = register(srv)
    const t = login(srv, clientId)
    const requestId = start(srv, clientId)
    srv.revokeAll()
    expect(srv.listClients()).toEqual([])
    expect(srv.persisted()).toEqual({ clients: [], refreshTokens: [] })
    expect(srv.verifyAccessToken(t.access_token)).toBeNull()
    expect(srv.getRequest(requestId)).toBeNull()
    expect(srv.decide(requestId, true).ok).toBe(false)
  })

  it("sweep drops expired state, also lazily without being called", () => {
    const { srv, clock, changes } = make()
    const clientId = register(srv)
    login(srv, clientId)
    expect(srv.persisted().refreshTokens.length).toBe(1)
    clock.t += 31 * DAY
    const before = changes.length
    srv.sweep()
    expect(srv.persisted().refreshTokens.length).toBe(0)
    expect(changes.length).toBe(before + 1)
    srv.sweep()
    expect(changes.length).toBe(before + 1)   // nothing left to remove, nothing to report

    login(srv, clientId)
    clock.t += 31 * DAY
    srv.listClients()                          // any public call triggers the cleanup
    expect(srv.persisted().refreshTokens.length).toBe(0)
  })

  it("a client refreshing in a loop cannot grow the stored state without bound", () => {
    const { srv } = make()
    const clientId = register(srv)
    let t = login(srv, clientId) as any
    const first = t
    for (let i = 0; i < 200; i++) t = srv.token(refreshForm(clientId, t.refresh_token)).body
    expect(srv.persisted().refreshTokens.length).toBeLessThanOrEqual(11)
    expect(srv.verifyAccessToken(first.access_token)).toBeNull()      // only the newest few access tokens survive
    expect(srv.verifyAccessToken(t.access_token)).not.toBeNull()
  })
})

describe("garbage input", () => {
  it("never throws", () => {
    const { srv } = make()
    const clientId = register(srv)
    const huge = "x".repeat(1_000_000)
    const junk: any[] = [undefined, null, 0, -1, NaN, "", huge, {}, [], [[]], () => 1, Symbol("s"), new URLSearchParams("a=1"), { toString: () => { throw new Error("boom") } }]

    for (const j of junk) {
      expect(() => {
        srv.registerClient(j)
        srv.registerClient({ redirect_uris: j, client_name: j })
        srv.registerClient({ redirect_uris: [j] })
        srv.startAuthorization(j)
        srv.getRequest(j)
        srv.decide(j, j, j)
        srv.decide(j, true, j)
        srv.complete(j, j)
        srv.token(j)
        srv.verifyAccessToken(j)
        srv.revokeClient(j)
        new OAuthServer({ issuer: ISSUER, resource: RESOURCE, persisted: j })
      }).not.toThrow()
    }

    expect(srv.getRequest(huge)).toBeNull()
    expect(srv.verifyAccessToken(huge)).toBeNull()
    expect(srv.decide(huge, true)).toMatchObject({ ok: false })
    expect(srv.token(new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: huge })).status).toBe(400)
    expect(srv.token(new URLSearchParams({ grant_type: huge, client_id: huge })).status).toBe(400)
    expect(srv.startAuthorization(new URLSearchParams({ client_id: huge, redirect_uri: huge })).ok).toBe(false)
    expect(srv.startAuthorization(authParams(clientId, { redirect_uri: huge }))).toMatchObject({ ok: false, status: 400 })
    // repeated parameters are not silently resolved to one of the values
    const twice = authParams(clientId)
    twice.append("redirect_uri", "https://evil.example/cb")
    expect(srv.startAuthorization(twice)).toMatchObject({ ok: false, status: 400 })
    // a non-boolean decision is not treated as approval
    const requestId = start(srv, clientId)
    expect(srv.decide(requestId, "yes" as any).ok).toBe(false)
    expect(srv.getRequest(requestId)).toMatchObject({ decided: false })
  })
})
