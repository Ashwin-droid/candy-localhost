// Server-to-server tokens. The daemon knows which site a process it launched
// belongs to, so it can tell another site: "the app named <app>, running as
// unix user <user>, asks". Nothing here says a person signed in: that is
// Sign in with candy (sdk-auth.ts), with its own key, header and claims.
//
// A token is a compact JWE (jwe.ts) under the receiving site's service key
// (candy.json "service": true), good for that one site and a few minutes.
import { decryptCompact, encryptCompact, randomB64url, JweError, SITE_RE, USER_RE, JTI_RE, CLOCK_SKEW_S, type JweKey } from "./jwe.ts"

export const SERVICE_HEADER = "Candy-Service-Token"
export const SERVICE_TYP = "candy-service"
export const SERVICE_TTL_S = 300

export interface ServiceClaims {
  iss: "candy"
  typ: typeof SERVICE_TYP
  // The receiving site
  aud: string
  // The calling site, and the unix user it runs as
  app: string
  user: string
  iat: number
  exp: number
  jti: string
}

/** Who is calling, as the daemon vouched for it */
export interface ServiceCaller { app: string; user: string; issuedAt: number; expiresAt: number }

const utf8 = new TextEncoder()
const isSite = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 128 && SITE_RE.test(v)

export const mintServiceToken = async (o: { key: JweKey; target: string; app: string; user: string; now?: number; ttlS?: number }): Promise<{ token: string; expiresAt: number }> => {
  if (!isSite(o.target) || !isSite(o.app)) throw new Error("invalid site name")
  if (!USER_RE.test(o.user)) throw new Error("invalid user")
  const iat = Math.floor((o.now ?? Date.now()) / 1000)
  const exp = iat + Math.min(o.ttlS ?? SERVICE_TTL_S, SERVICE_TTL_S)
  const claims: ServiceClaims = { iss: "candy", typ: SERVICE_TYP, aud: o.target, app: o.app, user: o.user, iat, exp, jti: randomB64url(16) }
  return { token: await encryptCompact(utf8.encode(JSON.stringify(claims)), o.key), expiresAt: exp * 1000 }
}

/** The caller a token names. Throws JweError for anything else: wrong site, expired, a sign-in token, garbage. */
export const openServiceToken = async (token: string, ring: readonly JweKey[], expect: { site: string; now?: number }): Promise<ServiceCaller> => {
  const { plaintext } = await decryptCompact(token, ring)
  let c: Partial<ServiceClaims>
  try { c = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) } catch { throw new JweError("claims", "not JSON") }
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new JweError("claims")
  if (c.iss !== "candy") throw new JweError("issuer")
  if (c.typ !== SERVICE_TYP) throw new JweError("claims", "not a service token")
  if (c.aud !== expect.site) throw new JweError("audience")
  if (!isSite(c.app) || typeof c.user !== "string" || !USER_RE.test(c.user)) throw new JweError("claims")
  if (typeof c.jti !== "string" || !JTI_RE.test(c.jti)) throw new JweError("claims")
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp! <= c.iat! || c.exp! - c.iat! > SERVICE_TTL_S) throw new JweError("claims")
  const now = Math.floor((expect.now ?? Date.now()) / 1000)
  if (now >= c.exp! + CLOCK_SKEW_S) throw new JweError("expired")
  if (c.iat! > now + CLOCK_SKEW_S) throw new JweError("not_yet_valid")
  return { app: c.app, user: c.user, issuedAt: c.iat! * 1000, expiresAt: c.exp! * 1000 }
}
