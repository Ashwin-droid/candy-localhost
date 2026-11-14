# Candy SDK Auth + Passkeys — Design

Contracts for two features. Builds on "Portal Login (PAM) — Design" in `AUTH_DESIGN.md`; everything there still holds.

1. **Delegated app login.** An app on candy sends the browser to the portal. The user logs in there (PAM or passkey), approves the app once, and the browser comes back to the app carrying a one-shot JWE. The app's backend decrypts it with its site key and learns the unix user (`ashwin`, `claude`, ...).
2. **Passkeys.** After a PAM login, a user can register a WebAuthn passkey on the portal. From then on they can log in to the portal with it instead of the password.

Six work items. **A–E have no dependencies on each other at runtime or in tests.** Where a file needs another one's types it uses `import type`, which is erased; anything needed at runtime is injected. **F wires everything in** after A–E land.

| | Files | Imports at runtime |
|---|---|---|
| A | `jwe.ts`, `test/jwe.test.ts` | nothing (WebCrypto) |
| B | `webauthn.ts`, `test/webauthn.test.ts` | nothing (WebCrypto) |
| C | `passkey-store.ts`, `test/passkey-store.test.ts` | `portal-auth.ts` (`SoftLockout`, `logSafe`), `sealed-ids.ts`; `import type` from `webauthn.ts` |
| D | `app-auth.ts`, `test/app-auth.test.ts` | `jwe.ts` (tests that open tokens run once A exists), `sealed-ids.ts`, `sdk-auth.ts` (`CALLBACK_PATH` only) |
| E | `sdk-auth.ts`, `test/sdk-auth.test.ts`, `public/app-consent.html`, `public/portal-passkeys.html`, passkey section of `public/portal-login.html` | `jwe.ts` only |
| F | `daemon.ts`, `portal-session.ts`, `sandbox.ts`, `fn-host.ts`, `sdk.ts`, `cli.ts`, `install-service.sh`, `package.json`, `public/portal.html` (one link), docs, tests for those | everything |

D and E depend on A's **contract** (section A). If A has not landed yet, D and E write against the signatures below; their tests run once `jwe.ts` exists.

Style: no semicolons, small pure modules with injected `now`/`random`, `bun:test`, no npm packages, WebCrypto only (`crypto.subtle`, `crypto.getRandomValues`). Times are **ms** in stores and APIs. **JWT claims are seconds**.

---

## 0. Decisions and deviations from the brief

| # | Decision | Why |
|---|---|---|
| D1 | **The token travels back as a form POST** (OIDC-style `form_post`). The portal page submits a POST to the app's callback with fields `candy_token` and `state`, and the callback answers `303`. | It reaches the backend. It is never in a URL, so it never lands in browser history, Caddy's access log (which logs the URI, not bodies) or a `Referer`. The 303 keeps a reload from resubmitting it. A query-string token would be logged by Caddy, and a fragment never reaches the backend. |
| D2 | The SDK's state cookie is `__Host-candy_auth; Secure; HttpOnly; SameSite=None; Path=/; Max-Age=600`. | The callback POST is cross-site (`portal.localhost` → `app.localhost`: `localhost`/`candy` are not on the PSL, so every name is its own site, and bound domains are cross-site anyway). Lax cookies are not sent on a cross-site POST. `__Host-` stops anything but the app's own host over https from setting it. It is a top-level navigation, so third-party-cookie blocking does not apply. |
| D3 | **Deviation: env is `CANDY_AUTH_KEYS` (a ring), not `CANDY_AUTH_KEY`.** It is delivered with `LoadCredential=` for sandboxed units, never with `--setenv`. | `systemdRunCommand` puts every env var in **systemd-run's argv** (`--setenv=K=V`). That is readable by every local user through `/proc/<pid>/cmdline`, for the unit's whole life, since `--wait` keeps systemd-run alive, and through `systemctl show -p Environment`. A key passed that way can be stolen by any unix user. `LoadCredential` copies a root-only file into `$CREDENTIALS_DIRECTORY`, readable only by the unit's user. Non-sandboxed launches (setpriv, user mode) pass it in the spawn env. `/proc/<pid>/environ` is readable only by the owner. A ring rather than one key, so rotation has an overlap. |
| D4 | **Deviation: the authorize step is parked.** `GET /app-auth/authorize` (public) checks the request, seals it into an id (AES-256-GCM under a per-process key, `sealed-ids.ts`; nothing is stored), and 302s to `/app-auth/consent?request=<id>`. | `safeNext` caps `next` at 1024 chars, and `return_to` + `state` would not survive the login redirect as plain parameters. The sealed id does, and keeps `return_to`/`state` out of the login page's URL (it is encrypted). Stateless because every browser on the machine is one loopback address through Caddy: a stored, capped table let a curl loop or `<img>` tags on any page evict everyone's pending sign-in (review finding). |
| D5 | The token minted for a site carries `aud = <site name>` **and** `dest = <exact return_to URL>`, and `return_to` must be exactly `https://<host>/_candy/auth/callback`. The SDK checks `dest` against **the URL the token arrived at** (`requestOrigin(request)` + its path), never a value from the state cookie. | `aud` + a per-site key already stop A→B. `dest` pins the token to the callback, so a token that leaked from anywhere else (a 307 on another path of the site, a proxy, a page that echoes its body) is refused at the callback. The cookie is not a MAC'd value: whoever POSTs can send any cookie from their own browser, so it only says what *this* browser started (review finding). |
| D6 | Minting is always a **POST** from a portal page (Origin check + page token), even when consent is remembered. In that case the consent page auto-POSTs without a click. | A GET never mints a token, so the existing CSRF machinery covers the only state change. |
| D7 | Passkey management needs a **recent PAM** login: `pamAt` within 10 min. A logged-in user refreshes it with `POST /auth/reauth {password}`, which reuses `attemptLogin` and its limits. | The brief asks for a "recent password". Sessions last 7 days, so the age of the session alone means nothing. |
| D8 | Attestation formats other than `none` are **accepted but not verified**: `attStmt` is ignored. | We ask for `attestation: "none"`. Browsers normally strip attestation, but some authenticators still send `packed`. We never trust attestation, so verifying it buys nothing, and rejecting it would break real devices. The credential key is still bound by `authData` and the challenge. |
| D9 | Delegated auth is not available from **tunnel** hosts (`*.trycloudflare.com`) or shortcut hosts. `return_to` must be `https://<name>.localhost`, `https://<name>.candy` (aliases included) or a bound-domain FQDN of that site, on the default port. | Those are the only hosts the daemon can prove route to that site. |
| D10 | Keys are created lazily, at the first launch of a site or the first SDK key fetch. They are dropped, along with all consents for the site, when the site's config is removed **or when its owner changes**. | A name reused by another unix user must not inherit keys or consents. |
| D11 | The JTI replay cache is per process. A function pool (several instances) or a multi-process app can accept one token once per process. The state cookie is what actually stops cross-browser replay. `ReplayStore` can be injected (KV, etc.) for a shared cache. | Documented limit; the token lives 60s and is bound to the browser's `__Host-` cookie. |

---

## 1. End-to-end flow

```
browser                     app (site "notes")                 portal (daemon)
  GET /_candy/auth/login?next=/x ─▶ auth.login(req)
  ◀─ 302 https://portal.localhost/app-auth/authorize?return_to=https%3A%2F%2Fnotes.localhost%2F_candy%2Fauth%2Fcallback&state=S&nonce=N
       Set-Cookie: __Host-candy_auth=<b64url{v,s,n,x,t}>
  GET /app-auth/authorize?... ──────────────────────────────────▶ validateAuthorize, park
  ◀─ 302 /app-auth/consent?request=R ◀───────────────────────────
  GET /app-auth/consent?request=R  (portal-shell → /login?next=… if no session; PAM or passkey)
  ◀─ app-consent.html: "notes (run by claude) wants to know who you are"   [Continue] [Cancel]
  POST /app-auth/decision {request:R, approve:true, remember:true}  (Origin + X-Candy-Token + X-Candy-Session)
  ◀─ {action:"https://notes.localhost/_candy/auth/callback", fields:{candy_token:T, state:S}}
  page builds <form method=POST action=…> and submits it
  POST /_candy/auth/callback (candy_token=T&state=S) ─▶ auth.handleCallback(req)
       cookie.s===S, decrypt T with the site key, aud/iss/exp/nonce/jti checks, dest === the URL it arrived at
  ◀─ 303 /x  Set-Cookie: <app's own session>; __Host-candy_auth=; Max-Age=0
```

---

## A. `jwe.ts`: compact JWE, `dir` + `A256GCM`

Pure. WebCrypto only. No other imports.

### Format
`BASE64URL(header) "." "" "." BASE64URL(iv) "." BASE64URL(ciphertext) "." BASE64URL(tag)`. With `dir` the encrypted-key segment is empty, so a token always has exactly 5 segments and the second is `""`.
- Protected header: exactly `{"alg":"dir","enc":"A256GCM","kid":"<kid>","typ":"JWT"}`. Serialize it in that key order.
- AAD = ASCII bytes of the first segment, as it appears in the token.
- `AES-GCM`, 12-byte IV (random), 128-bit tag. WebCrypto returns `ciphertext‖tag`; split off the last 16 bytes.
- Plaintext = UTF-8 JSON of the claims.

### Exports
```ts
export const JWE_ALG = "dir"
export const JWE_ENC = "A256GCM"
export const JWE_TYP = "JWT"
export const KEY_BYTES = 32
export const IV_BYTES = 12
export const TAG_BYTES = 16
export const MAX_TOKEN_LENGTH = 4096        // chars; checked before any decoding
export const MAX_HEADER_BYTES = 256
export const MAX_PLAINTEXT_BYTES = 2048
export const MAX_RING_KEYS = 4
export const DEFAULT_TTL_S = 60
export const MAX_TTL_S = 300               // exp - iat larger than this: rejected
export const CLOCK_SKEW_S = 30
export const KID_RE = /^[A-Za-z0-9_-]{8,32}$/
export const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i      // same as portal-session.ts
export const STATE_RE = /^[A-Za-z0-9_-]{16,256}$/
export const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
export const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/
export const SITE_RE = /^[a-z0-9]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/  // daemon's SAFE_NAME; also length 1..128

export type Amr = "pam" | "passkey"
export interface JweKey { kid: string; key: Uint8Array; retired?: number }    // key.length === 32; retired: unix s it was rotated out
export interface JweHeader { alg: "dir"; enc: "A256GCM"; kid: string; typ: "JWT" }
export interface AppClaims {
  iss: string          // portal origin, e.g. "https://portal.localhost"
  aud: string          // site name, e.g. "notes"
  sub: string          // unix user (USER_RE)
  amr: [Amr]           // exactly one entry
  iat: number          // unix seconds, integer
  exp: number          // unix seconds, integer, iat < exp <= iat + MAX_TTL_S
  auth_time: number    // unix seconds the portal session was created (integer)
  jti: string          // JTI_RE
  state: string        // STATE_RE, echoed from the authorize request
  nonce?: string       // NONCE_RE, echoed when the request had one
  dest: string         // the exact return_to URL (https, <= 2048 chars)
}

export type JweErrorCode = "malformed" | "unsupported" | "unknown_kid" | "decrypt" | "expired" | "not_yet_valid" | "audience" | "issuer" | "claims"
export class JweError extends Error { constructor(readonly code: JweErrorCode, message?: string) }

export const b64urlEncode: (bytes: Uint8Array) => string                 // no padding
export const b64urlDecode: (s: string) => Uint8Array                     // strict, throws JweError("malformed")
export const randomB64url: (bytes: number) => string                     // crypto.getRandomValues
export const generateKey: () => JweKey                                    // kid = randomB64url(9) (12 chars), key = 32 random bytes
export const encryptCompact: (plaintext: Uint8Array, key: JweKey, opts?: { iv?: Uint8Array }) => Promise<string>   // iv override: tests only
export const decryptCompact: (token: string, ring: readonly JweKey[]) => Promise<{ header: JweHeader; plaintext: Uint8Array }>
export const sealClaims: (claims: AppClaims, key: JweKey) => Promise<string>          // validates claims shape first (throws "claims")
export const openClaims: (token: string, ring: readonly JweKey[], expect: {
  aud: string
  issuers: readonly string[]
  now?: number          // unix seconds; default Math.floor(Date.now()/1000)
  skewS?: number        // default CLOCK_SKEW_S
}) => Promise<AppClaims>
export const validateClaims: (c: unknown) => AppClaims                   // shape only (no time/aud/iss), throws JweError("claims")
export const formatKeyRing: (ring: readonly JweKey[]) => string          // "<kid>:<b64url key>[:<retired>],…" current first
export const parseKeyRing: (s: string) => JweKey[]                       // throws JweError("malformed")
```

### Parsing rules (each one pinned by a test)
- `typeof token === "string"` and `length <= MAX_TOKEN_LENGTH`, else `malformed`, **before** any split or decode.
- Exactly 5 segments. Segment 2 must be `""`. Segments 1, 3, 4 and 5 are non-empty.
- `b64urlDecode`: only `[A-Za-z0-9_-]`, no `=`, `len % 4 !== 1`, and canonical: re-encoding gives the input back, so unused trailing bits must be zero.
- The header decodes to ≤ `MAX_HEADER_BYTES` and parses as a JSON object whose key set is exactly `{alg, enc, kid, typ}`. `alg !== "dir"` or `enc !== "A256GCM"` → `unsupported` (that covers `"none"`, `RSA-OAEP`, `A128GCM`, any `zip`, `crit`, `jku`, `jwk` and `x5u`: extra keys are `unsupported` too). `typ !== "JWT"` → `unsupported`. A kid failing `KID_RE` → `malformed`.
- IV exactly 12 bytes, tag exactly 16, ciphertext 1..`MAX_PLAINTEXT_BYTES`, else `malformed`.
- Key lookup is **by kid only**. Not in the ring → `unknown_kid`. Never try every key.
- A GCM failure → `decrypt`, with no detail.
- Plaintext: UTF-8 (`fatal: true`), JSON, then `validateClaims`.
- `validateClaims`: the key set is a subset of the `AppClaims` keys, with every required key present; an unknown claim → `claims`. Types and patterns as in the interface above. `iat`, `exp` and `auth_time` are safe integers ≥ 0. `exp > iat`, `exp - iat <= MAX_TTL_S`, `auth_time <= iat + skew`. `dest` parses as a URL with `https:` and no userinfo.
- `openClaims` order: keys with `retired` and `now >= retired + MAX_TTL_S + skew` are left out of the ring (→ `unknown_kid`) → decrypt → validate → made with a retired key and `iat > retired + skew` → `unknown_kid` → `now >= exp + skew` → `expired`; `iat > now + skew` → `not_yet_valid`; `aud !== expect.aud` → `audience`; `!issuers.includes(iss)` → `issuer`.
- `parseKeyRing`: 1..`MAX_RING_KEYS` comma-separated `kid:key` or `kid:key:retired` entries (`retired`: unix seconds, a decimal of at most 12 digits, no leading zero). Each kid matches `KID_RE` and is unique. Each key decodes to exactly 32 bytes. Surrounding whitespace is trimmed and nothing else is tolerated.
- **Retirement (review finding):** the daemon marks a rotated-out key with its retirement time. Wherever a copy of the ring lives (env, credential, an SDK cache that is never refreshed), that key opens only tokens issued before the rotation, so a leaked key can't mint sign-ins after `candy app-auth rotate`, and is dead for good `MAX_TTL_S + skew` later. Before this, a running app kept a retired key forever.
- `encryptCompact` never reuses an IV: each call takes a fresh random one unless `opts.iv` is given.

### Tests must pin
Round trip; a fixed vector (key, iv, plaintext → exact token, so the format is frozen); each malformed case above; header tampering (flip one char → `decrypt`, since the AAD covers it); `alg:"none"`, `enc:"A128GCM"` and extra `zip` → `unsupported`; unknown kid; rotation (ring `[new, old]` decrypts tokens of both, `[new]` rejects old with `unknown_kid`); exp/iat/skew boundaries (exactly `exp + skew - 1` ok, `exp + skew` expired); `exp - iat = 301` rejected; wrong aud/iss; unknown claim rejected; a 4097-char token rejected without decoding; `formatKeyRing`/`parseKeyRing` round trip and its rejects.

---

## B. `webauthn.ts`: minimal WebAuthn relying party

Pure. WebCrypto only. It brings its own private base64url helpers and does not import `jwe.ts`.

### Constants and types
```ts
export type CoseAlg = -7 | -257 | -8                     // ES256, RS256, EdDSA (Ed25519)
export const SUPPORTED_ALGS: readonly CoseAlg[] = [-8, -7, -257]   // preference order in pubKeyCredParams
export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 } as const
export const CHALLENGE_BYTES = 32
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_CLIENT_DATA_BYTES = 4096
export const MAX_ATTESTATION_BYTES = 16_384
export const MAX_AUTH_DATA_BYTES = 4096
export const MAX_CREDENTIAL_ID_BYTES = 1023
export const MAX_SIGNATURE_BYTES = 1024
export const MAX_USER_HANDLE_BYTES = 64
export const MIN_RSA_BITS = 2048
export const MAX_RSA_BITS = 4096
export const CBOR_LIMITS = { maxDepth: 8, maxItems: 512, maxBytes: 16_384 } as const

export type CborValue = number | string | Uint8Array | boolean | null | CborValue[] | Map<number | string, CborValue>
export class CborError extends Error {}

export type WebAuthnErrorCode =
  | "malformed" | "type" | "challenge" | "origin" | "cross_origin" | "rp_id"
  | "user_present" | "user_verified" | "credential_id" | "algorithm" | "key"
  | "signature" | "counter" | "attestation"
export class WebAuthnError extends Error { constructor(readonly code: WebAuthnErrorCode, message?: string) }

export interface ClientData { type: string; challenge: string; origin: string; crossOrigin: boolean; raw: Uint8Array }
export interface AttestedCredential { aaguid: Uint8Array; credentialId: Uint8Array; publicKey: Uint8Array /* the exact COSE bytes */ }
export interface AuthenticatorData {
  rpIdHash: Uint8Array; flags: number
  up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean
  signCount: number; attested: AttestedCredential | null; extensions: CborValue | null
}

// Browser JSON (PublicKeyCredential.toJSON() shape; every binary field is base64url)
export interface RegistrationResponseJSON {
  id: string; rawId: string; type: "public-key"
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] }
  authenticatorAttachment?: string | null; clientExtensionResults?: Record<string, unknown>
}
export interface AuthenticationResponseJSON {
  id: string; rawId: string; type: "public-key"
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null }
  authenticatorAttachment?: string | null; clientExtensionResults?: Record<string, unknown>
}
export interface CreationOptionsJSON {
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  challenge: string
  pubKeyCredParams: { type: "public-key"; alg: CoseAlg }[]
  timeout: number
  attestation: "none"
  authenticatorSelection: { residentKey: "required"; requireResidentKey: true; userVerification: "required" }
  excludeCredentials: { type: "public-key"; id: string; transports?: string[] }[]
  extensions: { credProps: true }
}
export interface RequestOptionsJSON {
  challenge: string; rpId: string; timeout: number
  userVerification: "required"; allowCredentials: []   // discoverable only
}
export interface RegistrationVerdict {
  credentialId: string      // b64url
  publicKey: string         // b64url of the COSE key bytes
  alg: CoseAlg
  signCount: number
  aaguid: string            // 32 lowercase hex chars
  backupEligible: boolean
  backedUp: boolean
  transports: string[]      // from the response, filtered to /^[a-z-]{1,16}$/, at most 8
}
export interface AssertionVerdict { credentialId: string; newSignCount: number; userHandle: string | null; backedUp: boolean }
export interface StoredCredentialKey { id: string; publicKey: string; alg: CoseAlg; signCount: number }
```

### Functions
```ts
export const decodeCbor: (bytes: Uint8Array, limits?: Partial<typeof CBOR_LIMITS>) => CborValue        // whole input; trailing bytes → CborError
export const decodeCborPrefix: (bytes: Uint8Array, offset: number, limits?: Partial<typeof CBOR_LIMITS>) => { value: CborValue; end: number }
export const parseAuthenticatorData: (bytes: Uint8Array) => AuthenticatorData        // throws WebAuthnError("malformed")
export const parseCoseKey: (cose: Uint8Array) => { alg: CoseAlg; kty: 1 | 2 | 3; jwk: JsonWebKey | null; raw: Uint8Array | null }  // throws "algorithm" | "key"
export const importCoseKey: (cose: Uint8Array) => Promise<{ alg: CoseAlg; key: CryptoKey }>
export const derToRawEcdsa: (der: Uint8Array, size?: number /* 32 */) => Uint8Array  // throws WebAuthnError("signature")
export const parseClientData: (b64: string, type: "webauthn.create" | "webauthn.get") => ClientData
export const newChallenge: () => string                                              // randomB64url(CHALLENGE_BYTES)
export const registrationOptions: (o: {
  rpId: string; rpName: string; userHandle: string; userName: string; displayName: string
  challenge: string; exclude: { id: string; transports?: string[] }[]; timeoutMs?: number
}) => CreationOptionsJSON
export const authenticationOptions: (o: { rpId: string; challenge: string; timeoutMs?: number }) => RequestOptionsJSON
export const verifyRegistration: (i: {
  response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string
}) => Promise<RegistrationVerdict>
export const verifyAssertion: (i: {
  response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string
  credential: StoredCredentialKey
}) => Promise<AssertionVerdict>
```

### CBOR (bounded, hand-rolled)
- Supported: major 0 (uint), 1 (negint), 2 (bstr), 3 (tstr, UTF-8 `fatal`), 4 (array), 5 (map), and 7 only for `false`/`true`/`null` (`0xf4`–`0xf6`).
- Rejected with `CborError`: indefinite lengths (ai 31); additional info 28–30; major 6 (tags); floats and other simple values (`undefined` included); integers beyond `Number.MAX_SAFE_INTEGER` (8-byte arguments above 2^53−1); non-minimal length encodings (a value < 24 encoded long, and so on); map keys that are not int or text; duplicate map keys; depth > `maxDepth`; a running item count > `maxItems`; input > `maxBytes`.
- **A declared length is checked against the bytes left before anything is allocated or sliced** (the CBOR bomb defence). An array or map count is checked against the bytes left (each item ≥ 1 byte) and against `maxItems` before the loop.
- Maps decode to `Map` in wire order.

### authenticatorData
- `rpIdHash[32] | flags[1] | signCount[4 BE] | (AT: aaguid[16] | credIdLen[2 BE] | credId | COSE key) | (ED: CBOR map)`.
- Length ≥ 37 and ≤ `MAX_AUTH_DATA_BYTES` (registration: ≤ `MAX_ATTESTATION_BYTES`).
- `credIdLen` is 1..`MAX_CREDENTIAL_ID_BYTES` and fits in the bytes left.
- The COSE key is read with `decodeCborPrefix`, and `publicKey` is exactly the bytes it consumed.
- With ED, the extensions are one CBOR map that must end exactly at the end of the input. Without ED, leftover bytes → `malformed`. RFU bits are ignored.

### COSE → WebCrypto
- EC2 (kty 2): alg −7, crv (−1) = 1, x (−2) and y (−3) are 32-byte bstrs → JWK `{kty:"EC",crv:"P-256",x,y}` → `ECDSA P-256`, verified with `{name:"ECDSA",hash:"SHA-256"}`. The point must import (WebCrypto rejects off-curve points; a failure → `key`).
- RSA (kty 3): alg −257, n (−1) is 256..512 bytes with no leading zero byte, e (−2) is 1..4 bytes → `RSASSA-PKCS1-v1_5` + SHA-256.
- OKP (kty 1): alg −8, crv (−1) = 6, x (−2) 32 bytes → `importKey("raw", x, {name:"Ed25519"})`, `verify("Ed25519")`.
- alg (3) is required. kty must match alg. Any other alg/kty/crv → `algorithm`. Extra labels are ignored except `key_ops`, which is ignored too (never trusted).

### ECDSA DER → raw
Strict DER: `30 len 02 rlen r 02 slen s`, with the total length matching exactly. Each INTEGER is 1..33 bytes, positive (leading byte < 0x80 unless there is a single `00` pad), and minimal (no `00` pad unless the next byte ≥ 0x80). Each is left-padded to 32 → `r‖s` (64 bytes). Anything else → `signature`.

### verifyRegistration (order matters; each step is a code)
1. Shape: `type === "public-key"`, `id === rawId`, `id` is canonical b64url decoding to 1..1023 bytes, response fields are strings (`malformed`).
2. `parseClientData(clientDataJSON, "webauthn.create")`. Raw ≤ `MAX_CLIENT_DATA_BYTES`. JSON object with `type` (`type`), `challenge` === expected (constant-time compare; `challenge`), `origin === expectedOrigin` exactly (`origin`). `crossOrigin === true`, or any `topOrigin` present → `cross_origin`.
3. attestationObject ≤ `MAX_ATTESTATION_BYTES` → `decodeCbor` → a map with exactly `fmt` (text ≤ 32), `attStmt` (map) and `authData` (bstr). `fmt === "none"` requires `attStmt` to be empty (`attestation`). Any other fmt: attStmt ignored (D8).
4. `parseAuthenticatorData`. `rpIdHash` equals `SHA-256(expectedRpId)` (`rp_id`). UP (`user_present`), UV (`user_verified`) and AT (`malformed`) are set. BS set without BE → `malformed`.
5. `attested.credentialId` bytes equal the decoded `rawId` (`credential_id`).
6. `importCoseKey(attested.publicKey)` → alg in `SUPPORTED_ALGS` (`algorithm`).
7. Return the verdict. `signCount` is taken from authData.

### verifyAssertion
1. Shape as above, plus `id === credential.id` (`credential_id`). signature 1..`MAX_SIGNATURE_BYTES`. userHandle, when present, is 1..`MAX_USER_HANDLE_BYTES` (`malformed`).
2. clientData with `"webauthn.get"`, the same checks.
3. authData ≤ `MAX_AUTH_DATA_BYTES`, rpIdHash, UP, UV. **AT must not be set** (`malformed`).
4. Signature over `authData ‖ SHA-256(clientDataJSON raw bytes)` with the stored key. ES256 converts DER → raw first. Failure → `signature`.
5. Counter: when `stored === 0 && new === 0` it is fine (authenticators without a counter, e.g. synced passkeys). Otherwise `new > stored` or `counter`. `newSignCount = new`.

### Tests (real crypto, no mocks)
The test file contains a **software authenticator**. It has a minimal CBOR *encoder* (test-only), generates ES256, RS256 (2048) and Ed25519 keys with WebCrypto, and builds the COSE key, authData (with counters), clientDataJSON, attestationObject (`fmt:"none"`) and signatures. For ES256 it converts WebCrypto's raw `r‖s` to DER, including the high-bit padding cases.

Pin: happy paths for all three algs, registration and assertion. Then one failing test per code: wrong challenge, origin `https://portal.candy` vs expected `https://portal.localhost`, rpIdHash for another host, UP off, UV off, AT on in an assertion, `crossOrigin:true`, `topOrigin` present, id/rawId mismatch, unsupported alg (−35), RSA 1024, a tampered signature, a tampered authData byte, counter rollback (stored 5, new 5 and new 3), counter 0/0 accepted, stored 7 / new 0 rejected.

CBOR: indefinite length, tag, float, a non-minimal int, a duplicate map key, depth 9, a bstr declaring 2^32 bytes in a 10-byte input (must throw quickly and allocate nothing big), an array declaring 1e6 items, trailing bytes. DER: non-minimal, negative, wrong total length, a 34-byte integer.

---

## C. `passkey-store.ts`: credential store, challenges, login/registration orchestration

Imports: `SoftLockout`, `logSafe` from `./portal-auth.ts`, `SealedIds` from `./sealed-ids.ts`. `import type { CoseAlg, CreationOptionsJSON, RequestOptionsJSON, RegistrationVerdict, AssertionVerdict, StoredCredentialKey } from "./webauthn.ts"`, erased at runtime. Every WebAuthn call is injected (`WebAuthnImpl`), so the tests use stubs here and B's tests carry the crypto.

### Constants
```ts
export const MAX_PER_USER_RP = 10          // passkeys per user per rpId
export const MAX_PER_USER = 25             // per user across rpIds
export const MAX_PASSKEYS = 1000           // whole store
export const MAX_NAME_LENGTH = 64
export const CHALLENGE_TTL_MS = 5 * 60_000
export const MAX_CHALLENGES = 10_000       // used challenge ids remembered until they expire (challenges are stateless)
export const RECENT_PAM_MS = 10 * 60_000
export const SUPERUSER_PAM_MS = 60 * 60_000   // a sudoer's passkey session is a superuser this long after /auth/reauth
export const PASSKEY_FAILURE_FLOOR_MS = 1000
export const PASSKEY_FAILED = "That passkey didn't work. Try again, or log in with your password."
export const PASSKEY_SLOWED = "Too many failed passkey logins. Try again in a moment."
export const PASSKEY_NEEDS_PASSWORD = "Enter your password again to change passkeys."
export const PASSKEY_LIMIT = "You have the most passkeys allowed here. Remove one first."
export const PASSKEY_EXISTS = "That passkey is already registered."
export const PASSKEY_EXPIRED = "That request expired. Try again."
export const PASSKEY_NOT_FOUND = "No such passkey."
```

### Types
```ts
export interface PasskeyRecord {
  id: string            // credential id, b64url (unique across the store)
  user: string          // USER_RE
  uid: number           // the account's uid at registration: a new account reusing the name never matches
  rpId: string          // portal host it was registered on, e.g. "portal.localhost"
  publicKey: string     // b64url COSE bytes; public keys only, never private material
  alg: CoseAlg
  signCount: number
  name: string          // label, 1..64 printable chars
  created: number; lastUsed: number | null   // ms
  aaguid: string        // 32 hex
  backupEligible: boolean; backedUp: boolean
  transports: string[]
}
export interface PasskeyView { id: string; name: string; rpId: string; created: number; lastUsed: number | null; backedUp: boolean; alg: "ES256" | "RS256" | "EdDSA"; here: boolean }
export type ChallengeKind = "login" | "register"
export interface Challenge { id: string; challenge: string; kind: ChallengeKind; rpId: string; origin: string; key: string; sessionId: string | null; user: string | null; expires: number }
export interface WebAuthnImpl {
  newChallenge(): string
  registrationOptions(o: { rpId: string; rpName: string; userHandle: string; userName: string; displayName: string; challenge: string; exclude: { id: string; transports?: string[] }[] }): CreationOptionsJSON
  authenticationOptions(o: { rpId: string; challenge: string }): RequestOptionsJSON
  verifyRegistration(i: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string }): Promise<RegistrationVerdict>
  verifyAssertion(i: { response: unknown; expectedChallenge: string; expectedOrigin: string; expectedRpId: string; credential: StoredCredentialKey }): Promise<AssertionVerdict>
}
export interface SessionAuthState { id: string; user: string; amr: "pam" | "passkey"; pamAt: number | null }
```

### `class PasskeyStore`
```ts
constructor(file: string | null, opts?: { now?: () => number })
userHandle(user: string, uid: number): string          // stable random 32 bytes b64url per account, created on first use (persisted); another uid → dropAccount, then a new handle
userForHandle(handle: string): string | null
handleUid(user: string): number | null                  // the uid the user's handle was made for
get(id: string): PasskeyRecord | null
list(user: string, rpId?: string): PasskeyRecord[]      // oldest first
view(r: PasskeyRecord, currentRpId: string): PasskeyView
add(r: Omit<PasskeyRecord, "created" | "lastUsed">): { ok: true; record: PasskeyRecord } | { ok: false; error: string }   // PASSKEY_EXISTS / PASSKEY_LIMIT
touch(id: string, newSignCount: number, backedUp: boolean): boolean   // only moves signCount forward (strictly greater, or 0 → 0); sets lastUsed
rename(user: string, id: string, name: string): PasskeyRecord | null  // null if not that user's
remove(user: string, id: string): boolean                // only that user's
removeUser(user: string): number
dropAccount(user: string): number                       // passkeys + handle (account gone, or left the candy group)
dropOtherUids(user: string, uid: number): number        // what an earlier account of that name left behind
accounts(): Map<string, Set<number>>                    // every user with a handle or passkey, and the uids on record
get size(): number
```
- Names are cleaned: control chars stripped, trimmed, cut to 64. Empty → `"Passkey"`.
- File `{ "version": 1, "handles": { "<user>": { "handle": "<b64url>", "uid": <n> } }, "credentials": [PasskeyRecord...] }`. A handle or record without a valid uid is dropped at load. Atomic write (private tmp + rename, mode 0600, dir 0700), like `PortalSessions.save`.
- Load: refuse a file with `mode & 0o022` (start empty, the way sessions do). Drop every record that fails validation: duplicate id, bad user, bad b64url, unknown alg, signCount not a safe integer ≥ 0, and so on. Keep at most `MAX_PASSKEYS`.
- `touch` with a counter that is not greater (except 0 → 0) returns false and changes nothing.

### `class ChallengeStore` (stateless, `sealed-ids.ts`)
```ts
constructor(opts?: { now?: () => number; ttlMs?: number; maxUsed?: number })
issue(c: Omit<Challenge, "id" | "expires">): Challenge   // id = the challenge sealed with AES-256-GCM under a per-process key; nothing stored
take(id: unknown, kind: ChallengeKind): Challenge | null // single use: any take of an intact id marks it used (until it expires), including a kind mismatch or expiry
sweep(): number                                          // forgets used ids that expired
get size(): number                                       // used ids remembered
```
Review finding: the store used to keep 8 challenges per key, oldest out, and every local browser is the one loopback key; 8 public `/auth/passkey/options` calls from any local user wiped every other local user's pending passkey login. A stateless challenge can't be pushed out: issuing stores nothing. The used-id set is bounded (`MAX_CHALLENGES`, soonest-expiring out), and only grows with login attempts, which the soft lockout already limits.

### Policy helpers and orchestrators
```ts
export const mayManagePasskeys: (s: Pick<SessionAuthState, "pamAt">, now: number) => boolean   // pamAt !== null && now - pamAt <= RECENT_PAM_MS
export const mayActAsSuperuser: (s: Pick<SessionAuthState, "amr" | "pamAt">, now: number) => boolean   // amr === "pam", or pamAt within SUPERUSER_PAM_MS
export const prunePasskeyAccounts: (d: Pick<PasskeyDeps, "store" | "uidOf" | "audit">) => Promise<string[]>   // drops gone accounts and earlier uids of a name
export const passkeyLoginKey: (ip: string, loopback: boolean) => string   // "passkey:ip:loopback" | `passkey:ip:${ip}`

export interface PasskeyDeps {
  store: PasskeyStore; challenges: ChallengeStore; webauthn: WebAuthnImpl
  soft: SoftLockout                     // its own instance, not the PAM one
  loginUsers(): Promise<string[]>
  uidOf(user: string): Promise<number | null>   // getent passwd; null = no such account; throws when it can't tell
  accountOk(user: string): Promise<boolean>     // pam_acct_mgmt alone (pam.ts checkAccount)
  isSuperuser(user: string): Promise<boolean>
  isLoopback(ip: string): boolean
  audit(action: "AUTH_LOGIN" | "AUTH_FAIL" | "PASSKEY_ADD" | "PASSKEY_DELETE" | "PASSKEY_RENAME" | "PASSKEY_COUNTER" | "PASSKEY_DROP", details: string): void
  now(): number; sleep(ms: number): Promise<void>
}

export const startPasskeyLogin: (d: PasskeyDeps, i: { rpId: string; origin: string; ip: string }) =>
  { ok: true; challengeId: string; publicKey: RequestOptionsJSON } | { ok: false; status: 429; body: { error: string; retryAfter: number } }

export const attemptPasskeyLogin: (d: PasskeyDeps, i: { challengeId: unknown; credential: unknown; rpId: string; origin: string; ip: string }) =>
  Promise<{ ok: true; user: string; superuser: boolean; credentialId: string } | { ok: false; status: 401 | 429; body: { error: string; retryAfter?: number } }>

export const startRegistration: (d: PasskeyDeps, i: { rpId: string; origin: string; session: SessionAuthState }) =>
  Promise<{ ok: true; challengeId: string; publicKey: CreationOptionsJSON } | { ok: false; status: 403 | 409; body: { error: string; reauth?: true } }>

export const finishRegistration: (d: PasskeyDeps, i: { challengeId: unknown; credential: unknown; name: unknown; rpId: string; origin: string; session: SessionAuthState }) =>
  Promise<{ ok: true; record: PasskeyRecord } | { ok: false; status: 400 | 403 | 409; body: { error: string; reauth?: true } }>

export const deletePasskey: (d: PasskeyDeps, i: { id: unknown; session: SessionAuthState; superuser: boolean; actingUser?: string }) =>
  { ok: true } | { ok: false; status: 403 | 404; body: { error: string; reauth?: true } }
```
`attemptPasskeyLogin` order:
1. Soft wait on `passkeyLoginKey` > 0 → 429 `PASSKEY_SLOWED`. Nothing is counted.
2. `take(challengeId, "login")`. The challenge must exist with `rpId`/`origin` equal to the inputs.
3. Parse `credential.id` (string ≤ 1400 chars) → `store.get`. The record must exist with `record.rpId === rpId`.
4. `webauthn.verifyAssertion` with the challenge, origin, rpId and the record's key.
5. `userHandle` is required and must be `record.user`'s handle (`store.userForHandle(handle) === record.user`; a lookup, it never creates a handle).
6. `record.user` must be in `loginUsers()`.
7. `uidOf(record.user)` must equal `record.uid` and `store.handleUid(record.user)` (review finding: a name reused by a new account, a sudoer say, logged in with the old account's passkey).
8. `accountOk(record.user)`: PAM's account stage (review finding: `passwd -e`, `pam_access`, `pam_time`, `pam_nologin` stopped password logins but not passkey logins).
9. `store.touch`. When it returns false → audit `PASSKEY_COUNTER` and fail.
10. `soft.clear`. Audit `AUTH_LOGIN "<user> from <ip> (passkey <name>)"`. Return `isSuperuser` (whether the account is a sudoer; the route answers `superuser: false, superuserNeedsPassword: true` for one, see F).

The attempt is counted (`soft.fail(key)`) right after step 1, before the first await, and cleared on success, so parallel attempts can't outrun the lockout. Any failure: audit `AUTH_FAIL "<who> (passkey: <reason>)"`, sleep to `PASSKEY_FAILURE_FLOOR_MS` since start, 401 `PASSKEY_FAILED`. Failures use one body for every reason. A counter error (`PASSKEY_COUNTER`) is audited with the credential id and user.

`startRegistration`:
- `!mayManagePasskeys(session)` → 403 `PASSKEY_NEEDS_PASSWORD` + `reauth: true`.
- `uidOf(user)` (null → 403 + reauth). `store.userHandle(user, uid)`: a handle made for another uid drops that earlier account's passkeys first.
- At the limit for `(user, rpId)` or `user` → 409 `PASSKEY_LIMIT`.
- Otherwise it issues a challenge with `kind:"register"`, `key = "session:"+id`, `sessionId`, `user`, `rpId` and `origin`.
- Options: `rpName: "candy"`, `userHandle: store.userHandle(user, uid)`, `userName = displayName = user`, `exclude` = the user's records on this rpId.

`finishRegistration`:
- Recheck `mayManagePasskeys`.
- The challenge's `sessionId` must equal the session's id, its `user` the session's user, and its rpId/origin the inputs (400 `PASSKEY_EXPIRED` when not).
- `verifyRegistration`, then `uidOf(session.user)` must still equal the handle's uid, then `store.add({... user: session.user, uid, rpId})`.
- Audit `PASSKEY_ADD "<user>: <name> on <rpId> (credential <id>)"`.

`deletePasskey`:
- Needs `mayManagePasskeys`.
- The record must belong to `session.user`, unless `superuser && actingUser` names its owner.
- Audit `PASSKEY_DELETE`.

### Tests must pin
Store: limits, duplicate id, atomic 0600 file, refuse a group-writable file, drop invalid records on load, `touch` monotonic, rename/remove scoped to the user, a stable handle across reloads.

Challenges: single use, TTL, a kind mismatch consumes it, tampered or foreign ids refused, no number of issues from one key pushes out an earlier challenge, the used set is bounded.

Accounts: a reused name (another uid) or a gone account logs in no one; registering for the new uid drops the old account's passkeys and handle; `prunePasskeyAccounts` drops gone accounts and earlier uids and keeps everything when the lookup fails; `accountOk` false → 401; `mayActAsSuperuser` windows.

Orchestrators (stub `WebAuthnImpl`): the rpId mismatch between the challenge and the request; a credential registered on `portal.candy` presented on `portal.localhost` → 401; a userHandle of another user → 401; a user removed from `loginUsers` → 401; the counter path audits; soft lockout → 429 with nothing counted; the failure floor; registration without recent PAM → 403 + reauth; a challenge from session X finished by session Y → 400; deleting another user's passkey → 404 (superuser + actingUser → ok).

---

## D. `app-auth.ts`: daemon-side delegated login logic

Imports from `./jwe.ts`: `generateKey`, `sealClaims`, `randomB64url`, `b64urlEncode`, `b64urlDecode`, `formatKeyRing`, `KID_RE`, `MAX_RING_KEYS`, `STATE_RE`, `NONCE_RE`, `SITE_RE`, `USER_RE`, `DEFAULT_TTL_S`, and the types `JweKey`/`AppClaims`. Write against the contract in section A; the tests run once `jwe.ts` exists.

### Constants
```ts
export const ROTATION_OVERLAP_MS = 10 * 60_000      // a retired key stays in the ring this long
export const MAX_SITES = 2000
export const CONSENT_TTL_MS = 30 * 24 * 60 * 60_000
export const MAX_CONSENTS = 5000
export const PENDING_TTL_MS = 10 * 60_000
export const MAX_PENDING_USED = 10_000            // used (taken) request ids remembered until they expire
export const MAX_RETURN_TO = 2048
export const AUTHZ_BAD_RETURN = "return_to must be https://<a candy site's host>/_candy/auth/callback, with no port, user name, query or #fragment."
export const AUTHZ_NOT_SITE = "That address isn't a candy site."
export const AUTHZ_SITE_MISMATCH = "return_to doesn't belong to the site that asked."
export const AUTHZ_BAD_STATE = "state must be 16 to 256 characters of A-Z, a-z, 0-9, _ or -."
export const AUTHZ_BAD_NONCE = "nonce must be 16 to 128 characters of A-Z, a-z, 0-9, _ or -."
export const AUTHZ_DUPLICATE = "Each parameter may appear only once."
export const AUTHZ_EXPIRED = "This sign-in request expired. Go back to the app and try again."
export const AUTHZ_CHANGED = "This site changed hands since it asked. Go back to the app and try again."
```

### Types
```ts
export interface StoredKey { kid: string; key: string /* b64url */; created: number; retiredAt: number | null }
export interface SiteRing { owner: string; keys: StoredKey[] }          // keys[0] is current
export interface AuthorizeRequest {
  id: string; site: string; owner: string
  returnTo: string; returnHost: string
  state: string; nonce: string | null
  issuer: string            // "https://<portal host this arrived on>"
  ip: string; created: number
}
export interface FormPost { action: string; fields: Record<string, string> }
export interface SiteLookup {
  siteOfHost(host: string): string | null     // canonical site name candy routes this https host to; null for portal, shortcut, tunnel or unknown hosts
  ownerOf(site: string): string | null        // null when the name isn't in use
}
export type HostKind = "local" | "tailnet" | "domain"   // .localhost | .candy | bound domain
```

### `class AppKeyStore`
```ts
constructor(file: string | null, opts?: { now?: () => number; overlapMs?: number })
ensure(site: string, owner: string): { ring: JweKey[]; created: boolean; replaced: boolean }   // creates when missing, or replaces the whole ring when the stored owner differs (created and replaced: true)
ring(site: string, owner: string): JweKey[] | null                         // live keys, current first; prunes ones retired more than overlapMs ago; null if missing or the owner differs
current(site: string, owner: string): JweKey | null
rotate(site: string, owner: string): JweKey[]                              // new key in front; the previous current gets retiredAt = now; at most MAX_RING_KEYS kept
// Rings handed out (ring/ensure/rotate, so env, credential files and /sdk/auth/keys) carry `retired` = floor(retiredAt/1000) on retired keys (A)
drop(site: string): boolean
info(site: string): { owner: string; kid: string; created: number; rotatedAt: number | null } | null
sites(): string[]
readonly discarded: boolean     // true when load found a file readable or writable by group/other and threw it away
```
- File `{ "version": 1, "sites": { "<site>": SiteRing } }`, atomic, 0600, dir 0700.
- Load **discards** (`discarded = true`, start empty) when `mode & 0o077`: the keys may have been read. F audits `APP_AUTH_KEYS_DISCARDED`.
- Entries are validated: SITE_RE, USER_RE, KID_RE, 32-byte keys, ≤ `MAX_RING_KEYS`.
- At most `MAX_SITES`. `ensure` beyond that throws `Error("too many sites with auth keys")`.

### `class ConsentStore`
```ts
constructor(file: string | null, opts?: { now?: () => number; ttlMs?: number })
has(user: string, site: string, owner: string): boolean       // same owner as when given, and not older than ttl
remember(user: string, site: string, owner: string): void     // refreshes `at`; the oldest beyond MAX_CONSENTS goes
revoke(user: string, site: string): boolean
dropSite(site: string): number
dropUser(user: string): number
list(user: string): { site: string; owner: string; at: number }[]
```
File `{ "version": 1, "consents": [{ user, site, owner, at }] }`, 0600, atomic. Load refuses `mode & 0o022`.

### `class PendingRequests` (stateless, `sealed-ids.ts`)
```ts
constructor(opts?: { now?: () => number; ttlMs?: number; maxUsed?: number })
park(r: Omit<AuthorizeRequest, "id" | "created">): AuthorizeRequest     // id = the request sealed (AES-256-GCM, per-process key); stores nothing
get(id: unknown): AuthorizeRequest | null       // no consume; null if not ours, used or expired
take(id: unknown): AuthorizeRequest | null      // single use: marks the id used until it expires
sweep(): number                                 // forgets used ids that expired
get size(): number                              // used ids remembered
```
Review finding: parks used to be capped per IP (20, oldest out) and globally (500, oldest out). `GET /app-auth/authorize` is public, and every local browser reaches it as loopback, so any web page (`<img src=…/app-auth/authorize?…>`) or local user could evict a victim's request between the redirect and their click. A sealed request can't be evicted, and the id doesn't show `state`, `nonce` or `return_to`.

### Functions
```ts
export const validateAuthorize: (params: URLSearchParams, look: SiteLookup) =>
  | { ok: true; site: string; owner: string; returnTo: string; returnHost: string; state: string; nonce: string | null }
  | { ok: false; status: 400 | 404; error: string }

export const recheckRequest: (r: AuthorizeRequest, look: SiteLookup) => { ok: true } | { ok: false; status: 404 | 409; error: string }
  // site still owned by r.owner (else 409 AUTHZ_CHANGED; gone → 404 AUTHZ_EXPIRED), and siteOfHost(r.returnHost) still === r.site

export const mintAppToken: (o: {
  req: AuthorizeRequest; user: string; amr: "pam" | "passkey"; sessionCreated: number /* ms */
  key: JweKey; now: number /* ms */; ttlS?: number
}) => Promise<{ token: string; claims: AppClaims }>
  // iss = req.issuer, aud = req.site, sub = user, amr = [amr], iat = floor(now/1000), exp = iat + (ttlS ?? DEFAULT_TTL_S),
  // auth_time = floor(sessionCreated/1000), jti = randomB64url(16), state, nonce (only if not null), dest = req.returnTo

export const successReturn: (r: AuthorizeRequest, token: string) => FormPost    // { action: r.returnTo, fields: { candy_token: token, state: r.state } }
export const errorReturn: (r: AuthorizeRequest, error: "access_denied") => FormPost   // { action, fields: { error, state } }
export const consentView: (r: AuthorizeRequest, user: string, remembered: boolean, amr: "pam" | "passkey") => {
  request: string; site: string; owner: string; ownerIsYou: boolean; user: string
  returnHost: string; returnOrigin: string; hostKind: HostKind; remembered: boolean; amr: "pam" | "passkey"
}
export const hostKind: (host: string) => HostKind
export const mayFetchSiteKey: (auth: { user: string; via: "portal" | "apikey" | "oauth" } | null, owner: string) => boolean
  // via === "apikey" && user === owner. Never portal (keys never reach a browser), never oauth, no superuser override
export const issuersFor: (portalHosts: readonly string[]) => string[]   // ["https://" + h for each], deduped, lower case
```
`validateAuthorize` rules:
- Any of `return_to`, `state`, `nonce`, `site` appearing twice → 400 `AUTHZ_DUPLICATE`. Other params are ignored.
- `return_to`: length ≤ `MAX_RETURN_TO`, then `new URL` must succeed, then `protocol === "https:"`, empty `username`/`password`, `port === ""`, empty `hash`, and the raw string has no control chars or `\`. Then `url.href` must be exactly `https://<host>/_candy/auth/callback` and the raw string has no `?` (an exact redirect match, as OAuth requires: a token POSTed to any other path of the site could be leaked by whatever answers there, a 307 to elsewhere, a proxy, a page that echoes its body; review finding). Else 400 `AUTHZ_BAD_RETURN`, before any lookup. **The stored `returnTo` is `url.href`** (normalized).
- `site = siteOfHost(url.hostname)`. null → 404 `AUTHZ_NOT_SITE`. `ownerOf(site)` null → 404 `AUTHZ_NOT_SITE`.
- `site` param, if given, must equal it (400 `AUTHZ_SITE_MISMATCH`).
- `state` must match `STATE_RE` (400 `AUTHZ_BAD_STATE`). `nonce` is optional and must match `NONCE_RE`.

### Tests must pin
Rejects: `http:`, `:8443`, `user@`, `#frag`, `javascript:`, `//evil`, any path but the callback (`/cb`, `/`, `…/callback?x=1`, `…/callback/`, `%63allback`), a host that `siteOfHost` maps to null (the portal, `victim.k.localhost`, `x.trycloudflare.com`), `site=a` with `return_to` on b, duplicates.

Stores: ensure → same ring twice; an owner change → a new key and `created: true`; rotate keeps the old key until overlap, then prunes it; a group-readable file is discarded. Consent: a different owner → false, expiry, `dropSite`. Pending: single use, TTL, ids opaque and tamper-proof, a flood of parks from one address leaves an earlier request intact, the used set is bounded.

The rest: `mintAppToken` output opens with `openClaims` (A) for `aud=site` and fails for another site's ring. `successReturn`/`errorReturn` shapes. `mayFetchSiteKey` matrix (portal superuser → false, apikey owner → true, apikey other → false, oauth → false).

---

## E. `sdk-auth.ts` + UI

### `sdk-auth.ts` (the app side; works in a plain Bun server and in a candy function)
Imports: `./jwe.ts` only (`openClaims`, `parseKeyRing`, `JweError`, `randomB64url`, `b64urlEncode`, `b64urlDecode`, `STATE_RE`, `NONCE_RE`, `SITE_RE`, `CLOCK_SKEW_S`, types). It never imports `secret.ts`, `server-auth.ts` or anything daemon-side, because fn-host loads it inside the sandbox.

```ts
export const LOGIN_PATH = "/_candy/auth/login"
export const CALLBACK_PATH = "/_candy/auth/callback"
export const STATE_COOKIE = "__Host-candy_auth"
export const STATE_COOKIE_MAX_AGE_S = 600
export const CREDENTIAL_NAME = "candy-auth-keys"          // $CREDENTIALS_DIRECTORY/<this>
export const ENV = { site: "CANDY_AUTH_SITE", url: "CANDY_AUTH_URL", issuers: "CANDY_AUTH_ISSUERS", keys: "CANDY_AUTH_KEYS" } as const
export const DEFAULT_ISSUERS = ["https://portal.localhost", "https://portal.candy"]
export const MAX_CALLBACK_BODY = 8192
export const MAX_COOKIE_LENGTH = 3000
export const REFETCH_MIN_INTERVAL_MS = 30_000
export const RING_REFRESH_MS = 5 * 60_000       // with fetchKeys: refetch a ring this old (under the daemon's 10-minute overlap)
export const MAX_REPLAY_ENTRIES = 10_000

export type AuthErrorCode = JweErrorCode | "replay" | "state" | "nonce" | "dest" | "no_keys" | "denied" | "bad_request"
export interface AuthUser { user: string; amr: Amr[]; authTime: number /* ms */; claims: AppClaims }
export type VerifyResult = ({ ok: true } & AuthUser) | { ok: false; error: AuthErrorCode; message: string }
export type CallbackResult =
  | ({ ok: true; next: string; clearCookie: string } & AuthUser)
  | { ok: false; status: 400 | 401 | 403; error: AuthErrorCode; message: string; clearCookie: string }

export interface ReplayStore { checkAndRecord(jti: string, expiresAtMs: number): boolean | Promise<boolean> }  // true = first time
export class ReplayCache implements ReplayStore {
  constructor(max?: number /* MAX_REPLAY_ENTRIES */, now?: () => number)
  checkAndRecord(jti: string, expiresAtMs: number): boolean       // drops expired; at max evicts the entry expiring soonest
  get size(): number
}

export interface AppAuthOptions {
  site?: string                                    // default env CANDY_AUTH_SITE; required in the end (throws "candy auth: no site name")
  portal?: string                                  // fallback portal origin; default env CANDY_AUTH_URL, else "https://portal.localhost"
  issuers?: string[]                               // default env CANDY_AUTH_ISSUERS (comma list), else DEFAULT_ISSUERS
  keys?: string                                    // a ring string (formatKeyRing); default credential file, then env CANDY_AUTH_KEYS
  fetchKeys?: (site: string) => Promise<string>    // fetches the ring again (sdk.ts supplies the daemon fetcher); used when none is configured, or on unknown_kid
  replay?: ReplayStore                             // default new ReplayCache()
  env?: Record<string, string | undefined>         // default process.env
  readFile?: (path: string) => string | null       // default: readFileSync utf8, null on error
  now?: () => number
}
export interface AppAuth {
  readonly site: string
  loginUrl(o: { returnTo: string; state: string; nonce?: string; portal?: string }): string
  login(request: Request, o?: { next?: string; portal?: string }): Promise<Response>
  verify(token: string, expect?: { state?: string; nonce?: string; dest?: string }): Promise<VerifyResult>
  handleCallback(request: Request): Promise<CallbackResult>
  handle(request: Request, onLogin: (u: AuthUser & { next: string }, request: Request) => Response | Promise<Response>): Promise<Response | null>
}
export const createAppAuth: (opts?: AppAuthOptions) => AppAuth
export const portalForHost: (host: string, fallback: string) => string   // *.localhost → https://portal.localhost; *.candy → https://portal.candy; else fallback
export const requestOrigin: (request: Request) => string                  // "https://" + Host header (lower case, ":443" stripped); throws on a missing or invalid Host
export const safeAppPath: (next: unknown) => string                        // same rules as portal-auth safeNext, its own copy; default "/"
export const redirectAfterLogin: (next: string, setCookie?: string | string[]) => Response   // 303, Location next, Cache-Control no-store, Referrer-Policy no-referrer
```
Behaviour:
- **Key resolution, lazy, at the first `verify`**:
  1. `opts.keys`;
  2. `readFile(env.CREDENTIALS_DIRECTORY + "/" + CREDENTIAL_NAME)` when `CREDENTIALS_DIRECTORY` is set;
  3. `env.CANDY_AUTH_KEYS`;
  4. `fetchKeys(site)`.
  Nothing → `{ok:false, error:"no_keys"}`. On `unknown_kid`, when `fetchKeys` exists and the last fetch was ≥ `REFETCH_MIN_INTERVAL_MS` ago, refetch once, replace the ring and retry. With `fetchKeys`, a ring older than `RING_REFRESH_MS` is also refetched (and replaced) before a verify, so a key the daemon pruned leaves the app even when no token with a new kid ever arrives (review finding). Retired keys in the ring carry `retired` (A). Key bytes are never logged or put in an error message.
- `loginUrl`: `${portal}/app-auth/authorize?return_to=…&state=…[&nonce=…]` (URLSearchParams order: return_to, state, nonce). `portal` must be `https://` with no path, else it throws. `returnTo` must be exactly `https://<host>/_candy/auth/callback` (the only return_to the portal accepts), else it throws.
- `login(request)`:
  - `origin = requestOrigin(request)`, `returnTo = origin + CALLBACK_PATH`, `state = randomB64url(24)`, `nonce = randomB64url(24)`.
  - `next = safeAppPath(o.next ?? url.searchParams.get("next"))`.
  - The cookie value is `b64url(JSON {v:1, s:state, n:nonce, x:next, t:nowMs})`. It holds what this browser started; it is not a MAC'd value, so nothing about where a token may arrive comes from it (an older cookie's `d` is ignored).
  - Response: 302 to `loginUrl({returnTo, state, nonce, portal: o.portal ?? portalForHost(host, opts.portal)})`, with `Set-Cookie: __Host-candy_auth=<v>; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- `verify(token, expect)`:
  - `openClaims(token, ring, {aud: site, issuers})`.
  - Then, when given, `expect.state === claims.state` (`state`), `expect.nonce` (`nonce`), `expect.dest === claims.dest` (`dest`).
  - Then `replay.checkAndRecord(jti, (exp + CLOCK_SKEW_S) * 1000)` false → `replay`. **Replay is checked last**, so a token that fails another check doesn't burn its jti.
- `handleCallback(request)`:
  - The method must be POST and the content type `application/x-www-form-urlencoded`. The body is read with the `MAX_CALLBACK_BODY` cap (Content-Length checked, then the bytes counted) → else 400 `bad_request`.
  - Parse the cookie (≤ `MAX_COOKIE_LENGTH`, `v === 1`, cookie age ≤ 600s) → else 400 `state`.
  - Form `state` must equal `cookie.s` (403 `state`).
  - When the form has `error` → 403 `denied` (message "You cancelled signing in." for `access_denied`).
  - Otherwise `verify(candy_token, {state: cookie.s, nonce: cookie.n, dest: requestOrigin(request) + url.pathname + url.search})`: `dest` must be the URL the token actually arrived at. A failure is 401 with the code. (Review finding: `dest` came from the cookie's `d`, which the POSTer controls, so a token leaked from any other path of the site, minted for that path, logged its holder in as the victim.)
  - `clearCookie` = `__Host-candy_auth=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0` **on every outcome**.
- `handle(request, onLogin)`:
  - `GET LOGIN_PATH` → `login`. `POST CALLBACK_PATH` → `handleCallback`; ok → `onLogin(...)`, with `clearCookie` appended to its response's `Set-Cookie`. Error → a minimal `text/plain` response with its status, clearCookie, `Cache-Control: no-store`.
  - Any other path → `null`.
  - The docs tell apps to **issue a fresh session id** in `onLogin` (no session fixation) and to answer with `redirectAfterLogin(next, cookie)`.

Tests (real `jwe.ts`, keys from `generateKey`): login sets the cookie with the exact attributes and builds the redirect URL; a full round trip (mint a token with `sealClaims` the way D does) → ok; replay → `replay` the second time; another site's ring → `unknown_kid`; same kid but wrong `aud` → `audience`; state cookie missing or mismatched; dest mismatch; a forged cookie naming the token's dest → `dest`; a token minted for one host POSTed on another host or path → `dest`; `loginUrl` refuses any returnTo but the callback; ring refresh every `RING_REFRESH_MS`; a retired key refuses tokens made after its retirement; nonce mismatch; `error=access_denied`; GET to the callback → 400; a 9000-byte body → 400; key resolution order (credential file beats env beats fetch); refetch on unknown kid at most once per 30s; `portalForHost`; `safeAppPath` (`//evil`, `/\\evil`, `https://x`). The error path never echoes the token.

### `public/app-consent.html` (served through the portal shell)
- Style matches `confirm-action.html` / `portal-login.html`.
- `window.CANDY_VARS` = `consentView(...)` (D) or `{ error: string }`. `window.CANDY_TOKEN` is the page token.
- Shows: "**<site>** wants to know who you are", "You'll go back to **https://<returnHost>**" (with a badge per `hostKind`: local / tailnet / public domain), "Signed in as **<user>**". When `!ownerIsYou`: a warning line "This site is run by **<owner>**, not you. They will see your user name."
- Checkbox "Remember for this site" (checked by default). Buttons **Continue** and **Cancel**.
- Continue/Cancel → `fetch('/app-auth/decision', {method:'POST', headers:{'Content-Type':'application/json','X-Candy-Token':CANDY_TOKEN}, body: JSON.stringify({request, approve, remember})})`. The session header is added by `SESSION_FETCH_PATCH`.
- Response `{action, fields}`: JS checks that `new URL(action).protocol === 'https:'` and that its host equals `returnHost`. It builds `<form method="POST" action>` with hidden `<input>`s (set with `.value`, never through innerHTML), appends it and calls `submit()`.
- Errors show inline.
- When `remembered === true`: it auto-calls approve with `remember:true` on load, showing "Signing you in to <site>…" with a Cancel link.
- `error` mode: the message only, and no buttons.
- `<meta name="referrer" content="no-referrer">`.

### `public/portal-login.html`: passkey section (edit only this file's markup and script)
- Under the password form: a "Log in with a passkey" button. It is shown only when `window.PublicKeyCredential` exists and `CANDY_VARS.passkeys !== false`.
- Flow:
  1. `POST /auth/passkey/options` `{}` → `{challengeId, publicKey}`.
  2. Convert with `PublicKeyCredential.parseRequestOptionsFromJSON` when present; else a manual b64url → ArrayBuffer conversion of `challenge` (inline helper of ≈20 lines).
  3. `navigator.credentials.get({publicKey, mediation:'optional'})`.
  4. Serialize with `cred.toJSON()` when present; else manually (id, rawId, type, response.{clientDataJSON, authenticatorData, signature, userHandle} as b64url).
  5. `POST /auth/passkey {challengeId, credential}`.
  6. The success handling is exactly the password path: store `session` in `localStorage` as `candy_session`, go to `next`.
- A 429 shows a countdown from `retryAfter`, like the password path. 401 shows the error string. `NotAllowedError` (the user cancelled) shows nothing.
- Optional: when `PublicKeyCredential.isConditionalMediationAvailable()` resolves true, start a `mediation:'conditional'` request with `autocomplete="username webauthn"` on the user field. One AbortController; abort it before a button-initiated request.

### `public/portal-passkeys.html` (served at `GET /passkeys` through the shell)
- `CANDY_VARS = { user, superuser, rpId, pamUntil: number | null }`.
- It lists `GET /passkeys/list` as a table: name (inline rename → `POST /passkeys/rename {id,name}`), "this portal" marker when `here`, created, last used, synced badge (`backedUp`), and Delete (`POST /passkeys/delete {id}`).
- "Add a passkey" → `POST /passkeys/register/options` → `navigator.credentials.create` (`parseCreationOptionsFromJSON`, or a manual conversion of `challenge`, `user.id` and `excludeCredentials[].id`) → serialize (`toJSON()`, or manually: clientDataJSON, attestationObject, transports via `getTransports()`) → `POST /passkeys/register {challengeId, credential, name}`. The name comes from a text field (default "Passkey on <platform>").
- Any `{reauth:true}` 403, and also before Add/Delete when `pamUntil` is null or past, opens a password prompt → `POST /auth/reauth {password}` → `{pamUntil}` → retry.
- Says plainly: "Passkeys work only on the portal address they were made on (<rpId>)."
- Every POST sends `X-Candy-Token`. A token is consumed by each POST, so after each one get the next with `POST /token {token}` → `{token}` (the same as `refreshToken()` in portal.html). `app-consent.html` makes one POST and needs no refresh.

---

## F. Integration (one engineer, after A–E)

### Files and state
| Path (root mode) | Path (user mode) | Holds |
|---|---|---|
| `/var/lib/candy-daemon/app-auth-keys.json` | `~/.local/state/candy/app-auth-keys.json` | `AppKeyStore` (0600) |
| `/var/lib/candy-daemon/app-auth-consent.json` | `~/.local/state/candy/app-auth-consent.json` | `ConsentStore` (0600) |
| `/var/lib/candy-daemon/passkeys.json` | `~/.local/state/candy/passkeys.json` | `PasskeyStore` (0600) |
| `/run/candy/app-auth/<name>.keys` (dir 0700 root, file 0600 root) | none | credential source for `LoadCredential=` |

### `portal-session.ts` (F edits it, along with `test/portal-session.test.ts`)
- `create(user, meta, opts?: { amr?: "pam" | "passkey" })`. Default `"pam"`. It stores `amr` and `pamAt = amr === "pam" ? now : null`.
- `PortalSession` gains `amr: "pam" | "passkey"; pamAt: number | null`. `get()` returns them.
- `markPam(id: string): number | null` sets `pamAt = now` and returns it (persisted). null if no such session.
- Load: a missing `amr` → `"pam"` with `pamAt = created` (those were all PAM logins). Anything else invalid → dropped.
- `RequestAuth` (portal-auth.ts) gains `amr?: "pam" | "passkey"; pamAt?: number | null; sessionCreated?: number`, set by `requestAuth` for portal sessions (`sessionCreated` feeds `mintAppToken`'s `auth_time`).

### `sandbox.ts`
- `SandboxSpec.credentials?: { name: string; path: string }[]` → `--property=LoadCredential=<name>:<path>` (name `/^[a-z0-9-]{1,64}$/`, path absolute).
- **Never pass key material in `env`**. Add a test that `systemdRunCommand` output contains no `CANDY_AUTH_KEYS`.

### daemon.ts
1. **Stores**: `appKeys = new AppKeyStore(FILE)` (audit `APP_AUTH_KEYS_DISCARDED` when `.discarded`), `appConsents`, `appPending = new PendingRequests()`, `passkeys = new PasskeyStore(FILE)`, `passkeyChallenges = new ChallengeStore()`, `passkeySoft = new SoftLockout()`. Sweep them in the existing 10-minute interval.
2. **`siteLookup: SiteLookup`**:
   - `siteOfHost(h)`: null when `isPortalHost(h)`, when `parseShortcutHost(h)` matches, or for a host with a port.
   - A `.localhost`/`.candy` host → `resolveLocalCandyDomain(h)`, only when `nameInUse` and `!isReserved`.
   - Otherwise `resolveBindingFromHost(h)?.serverName`.
   - `ownerOf(n) = nameInUse(n) ? nameOwner(n) : null`.
3. **Key lifecycle**:
   - `launchSpec` (servers, fn instances; not cron) calls `appKeys.ensure(name, configUser(config))`. When `created` and an old ring existed for another owner, also `appConsents.dropSite(name)` + audit `APP_AUTH_RESET`.
   - Env in `extra`: `CANDY_AUTH_SITE`, `CANDY_AUTH_URL` (`https://portal.candy` when tailnet is up, else `https://portal.localhost`) and `CANDY_AUTH_ISSUERS` (all portal hosts: `portal.localhost`, `portal.candy`, `portal.<hostLabel>.candy` when known).
   - **Sandboxed**: write `/run/candy/app-auth/<name>.keys` = `formatKeyRing(ring)` (0600 root, atomic) and pass `credentials: [{name: "candy-auth-keys", path}]`. **Not sandboxed** (setpriv / user mode): `CANDY_AUTH_KEYS` in the spawn env.
   - Config removal (`DELETE /config/*`, `/register/*` when the name goes away) → `appKeys.drop(name)`, `appConsents.dropSite(name)` and remove the credential file.
4. **fn-host.ts**:
   - At startup, read `CANDY_AUTH_SITE/URL/ISSUERS` and the ring (credential file, or `CANDY_AUTH_KEYS`), then `delete process.env.CANDY_AUTH_KEYS`.
   - Put `CANDY_AUTH: createAppAuth({site, portal, issuers, keys})` into the worker's `env` object. A project var/secret/binding named `CANDY_AUTH` → refuse to start: "CANDY_AUTH is reserved for candy auth".
   - Workers code: `const r = await env.CANDY_AUTH.handle(request, (u) => …); if (r) return r`.
   - `install-service.sh` adds `"$dir/sdk-auth.ts" "$dir/jwe.ts"` (`test/install-shim-files.test.ts` enforces it).
5. **Rotation**: `POST /app-auth/rotate` → `appKeys.rotate`, rewrite the credential file, restart that site's function instances (`restartFn`). The response lists the running servers in `restartNeeded`. The SDK in servers refetches on `unknown_kid` and every `RING_REFRESH_MS` if it can reach the daemon; the rotated-out key carries `retired`, so no copy of the ring accepts tokens made with it after the rotation. A server whose static ring predates the rotation and that can't refetch keeps the old key until it restarts: the CLI says so and prints `candy restart <names>`.
6. **Routes** (all handlers check `isPortalRequest(req)` where "portal only" is noted, else 404):

| Method | Path | Class | Where | Request | Response |
|---|---|---|---|---|---|
| GET | `/app-auth/authorize` | public | portal only | query `return_to`, `state`, `nonce?`, `site?` | 302 `/app-auth/consent?request=<id>`; invalid → 400/404 **HTML** (`app-consent.html` with `{error}`), never a redirect. Headers `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. `issuer = "https://" + host` |
| GET | `/app-auth/consent` | user | portal only, `via==="portal"`, PORTAL_PAGES | `?request=<id>` | `app-consent.html` + `portalPageScript(token, consentView(...))`; unknown → 404 page with `{error: AUTHZ_EXPIRED}` |
| POST | `/app-auth/decision` | user | portal only, page token | `{request: string, approve: boolean, remember?: boolean}` | 200 `FormPost`; 404/409 `{error}`. On approve: `take`, `recheckRequest`, `appKeys.ensure`, `mintAppToken(amr = auth.amr)`, `remember` if asked, audit `APP_AUTH_GRANT "<user> -> <site> (<amr>)"`. On deny: `take`, `errorReturn`, audit `APP_AUTH_DENY`. `Cache-Control: no-store` |
| GET | `/app-auth/sites` | user | any | | `{sites: [{site, owner, kid, created, rotatedAt}]}`, `mayUse`-filtered |
| POST | `/app-auth/rotate` | user | any (portal page token or API key) | `{name}` (lower-cased, like every control route) | `{site, kid, restartNeeded: string[]}`; `mayUse(name)` else 403; audit `APP_AUTH_KEY_ROTATE` |
| GET | `/app-auth/consents` | user | any | | `{consents: [{site, owner, at}]}` (own) |
| POST | `/app-auth/consents/revoke` | user | any | `{site}` (lower-cased) | `{revoked: boolean}` |
| POST | `/sdk/auth/keys` | user | **API key only** (the existing `/sdk/` check) | `{name?: string, configId?: string}` | `{site, keys, issuers, portal}`; `mayFetchSiteKey(auth, owner)` else 403 "<name> belongs to <owner>. Only they can read its auth key."; unknown → 404; audit `APP_AUTH_KEY_FETCH`; `Cache-Control: no-store` |
| POST | `/auth/passkey/options` | public | portal only, TOKENLESS | `{}` | `{challengeId, publicKey}` or 429. `rpId = host`, `origin = "https://" + host` |
| POST | `/auth/passkey` | public | portal only, TOKENLESS | `{challengeId, credential}` | exactly like `/auth/login`: destroy any old session, `portalSessions.create(user, meta, {amr:"passkey"})`, `Set-Cookie`, `{user, superuser: false, superuserNeedsPassword?: true, session}`; else 401/429 |
| POST | `/auth/reauth` | user | portal only, page token | `{password}` | `attemptLogin(loginDeps, {user: auth.user, password, ip})` (the body's user is ignored); ok → `markPam` → `{pamUntil: pamAt + RECENT_PAM_MS, superuserUntil: pamAt + SUPERUSER_PAM_MS}`; else its status and body; audit `AUTH_REAUTH` |
| GET | `/passkeys` | user | portal only, PORTAL_PAGES | | `portal-passkeys.html` + vars |
| GET | `/passkeys/list` | user | portal or API key | `?user=` (portal superuser only) | `{passkeys: PasskeyView[]}` |
| POST | `/passkeys/register/options` | user | portal only, page token | `{}` | `startRegistration` |
| POST | `/passkeys/register` | user | portal only, page token | `{challengeId, credential, name?}` | `{passkey: PasskeyView}` |
| POST | `/passkeys/rename` | user | portal only, page token | `{id, name}` | `{passkey}` / 404 |
| POST | `/passkeys/delete` | user | portal only, page token | `{id, user?}` | `{deleted: true}` / 403 (reauth) / 404 |

   - Add every line to `ROUTE_TABLE` (exact paths, no `/*`).
   - `PORTAL_PAGES += "/app-auth/consent", "/passkeys"`.
   - `TOKENLESS_ROUTES += "/auth/passkey/options", "/auth/passkey"` (still `sameOrigin`-checked).
   - `/auth/users`' JSON and the login page's `CANDY_VARS` gain `passkeys: true`.
   - Passkey **login works without PAM installed**. Registration does not, since it needs a PAM session.
7. **User removal**: wherever sessions are destroyed because a user left `loginUsers`, also run `appConsents.dropUser` (a temporarily locked account keeps its passkeys; login refuses them while it can't log in). A user who leaves the candy group (`forgetUser`) also loses their passkeys and handle (`passkeys.dropAccount`, audited `PASSKEY_DROP`), and `prunePasskeyAccounts` runs every 10 minutes (and 30s after start) to drop the passkeys of deleted accounts and of an earlier account whose name was reused (another uid). `uidOf` is `getent passwd`: exit 2 = no such account, any other failure throws, so an NSS hiccup prunes nothing.
8. **Superuser is a step-up (review finding)**: `requestAuth` sets `superuser` only when `isSuperuser(user) && mayActAsSuperuser(session, now)`: a password login, or a passkey login within `SUPERUSER_PAM_MS` of `/auth/reauth`. A sudoer's passkey session otherwise gets `superuser: false` and `superuserNeedsPassword: true` (also in `/auth/me`), so `/system/kill`, `/system/unit`, running sites as others and daemon-wide settings never rest on a (possibly synced) passkey alone. The portal asks for the password itself (see "F as built", portal step-up).
9. **PAM account stage on passkey login (review finding)**: `accountOk` = `checkAccount(user)` (pam.ts: the helper with `mode: "account"` runs `pam_start` → `pam_acct_mgmt` → `pam_end`, no password, no `pam_authenticate`), refused on anything but `PAM_SUCCESS`. Without `/etc/pam.d/candy` it is skipped, and `loginUsers` (superuser.ts) is what's left: it also leaves out an account whose password must be changed (`lastchg` 0, or older than its max age), as pam_unix would.
10. **Logs**: Caddy already deletes `Cookie`/`Set-Cookie` from the access log. Add nothing to URLs that holds a secret. The callback POST body is never logged.

### `sdk.ts` / `package.json` / CLI / MCP
- `sdk.ts`: `export { createAppAuth, type AppAuth, type AuthUser } from "./sdk-auth.ts"`.
- `export function appAuth(opts?: AppAuthOptions): AppAuth` is memoized for the no-opts call. It defaults `fetchKeys` to `daemonFetch("/sdk/auth/keys", {method:"POST", body: {name, configId: magicString}})` and, when no site is in env, `site` from `/sdk/runtime`.
- Add `appAuth` to the default export.
- `package.json` exports `"./auth": "./sdk-auth.ts"`.
- `cli.ts`:
  - `candy app-auth list` → `GET /app-auth/sites`.
  - `candy app-auth rotate <name>` → `POST /app-auth/rotate`. Print `restartNeeded`.
  - `candy passkeys` → `GET /passkeys/list` (read-only; the CLI never registers or deletes, since that needs a recent PAM portal login).
- `mcp.ts`: **no change**. No tool ever returns key material.

### Docs
`README.md` gets a short "Sign in with candy" section with the Bun and the Workers snippets. `CLAUDE.md` gets one bullet under HTTP API Authentication pointing here plus the new file rows. `AUTH_DESIGN.md` gets a one-line pointer.

### Integration tests
- `test/route-table.test.ts` must pass.
- `test/install-shim-files.test.ts` must pass.
- `test/sandbox.test.ts`: LoadCredential is present, and no key appears in argv.
- `test/portal-session.test.ts`: amr, pamAt, markPam, legacy load.
- An e2e test in `test/app-auth-flow.test.ts` drives D + E + F's routes together with real keys and a software authenticator: authorize → park → decision → FormPost → `handleCallback` with the cookie → user.

---

## Threat model

| Attack | Defence |
|---|---|
| **Open redirect** via `return_to` | `validateAuthorize`: https, no port, no userinfo, no query, no fragment, exactly `/_candy/auth/callback`, and `siteOfHost(host)` must name an existing site. A bad request is an error *page*, never a redirect. The SDK's `next` goes through `safeAppPath` (same-origin path only). |
| **Token replay** | 60s `exp` (`MAX_TTL_S` 300 hard cap). `jti` cache in the SDK (checked last). The token is bound to the browser by `state` = the `__Host-` HttpOnly cookie, cleared on every callback outcome. The `nonce` is echoed. D11 covers multi-process limits. |
| **Token for site A used at B** | A per-site key (B can't decrypt it: `unknown_kid`/`decrypt`). `aud === site` checked. `dest` equals the callback URL the token arrived at. |
| **Malicious site asks for a token for another site** | `return_to` must route to the site, so the token is only ever POSTed to that site. It is encrypted with that site's key, which only its owner can fetch (`mayFetchSiteKey`: API key of the owner only). The consent page names the site, its return host and its owner. |
| **Login CSRF / session fixation on the app** | An attacker's token POSTed into a victim's browser fails the state check: no `__Host-candy_auth` cookie with that `state`, and an attacker can't set `__Host-` cookies from another host. The SDK docs require a fresh app session id in `onLogin`. The SDK never accepts a token from a GET or a query string. |
| **CSRF on the portal decision** | Minting only happens on `POST /app-auth/decision`: `sameOrigin` + a page token tied to the session + the session secret header. Remembered consent still goes through that POST. `frame-ancestors 'none'` stops clickjacking the Continue button. |
| **Silent identification by a site the user approved before** | By design (remembered consent), limited to sites the user approved, with the same owner (`ConsentStore.has` checks owner), within 30 days. Users can revoke (`/app-auth/consents/revoke`). |
| **Phishing a lookalike host** | The SDK only ever sends users to configured portal origins (`portalForHost`, `CANDY_AUTH_URL`). `portal`, `p`, `k` and `kill` are reserved names. `isPortalHost` refuses ports. Passkeys are origin-bound (a lookalike gets nothing). The consent page shows the exact return host. |
| **Passkey rpId/origin confusion across portal hosts** | `rpId = host` the request arrived on (only `isPortalRequest` hosts). The challenge records rpId + origin and must match at finish. The record's `rpId` must equal the current host. `rpIdHash` and `origin` are checked exactly. `crossOrigin`/`topOrigin` are refused. |
| **Cross-user passkey registration** | Register challenges are bound to `sessionId` + `user`. The record is always saved under the session's user. Credential ids are unique store-wide (`PASSKEY_EXISTS`). Login requires `userHandle === store.userHandle(record.user)`. Registering needs a recent **PAM** (`pamAt` ≤ 10 min), so a stolen passkey session can't add a persistent credential. |
| **Counter rollback (cloned authenticator)** | `new > stored`, except 0/0. Failing it denies the login and is audited as `PASSKEY_COUNTER`. The store's `touch` is monotonic. |
| **CBOR bombs / malformed input** | Lengths are checked against the bytes left before allocating. Depth ≤ 8, items ≤ 512, input ≤ 16 KB. No indefinite lengths, tags or floats. Exact-length authData. Bounded clientDataJSON, signature, ids and userHandle. JWE size is checked before decoding. |
| **Key theft by another unix user** | Root-only 0600 key file in a 0700 dir (a group/other-readable file is discarded). No key in argv or `systemctl show` (D3: `LoadCredential`, not `--setenv`). Spawn env only for non-sandboxed launches (`/proc/<pid>/environ` is owner-only). The SDK key fetch is only for the owner's API key. Keys never go to a browser, an MCP tool or a log. |
| **Name reuse by another user** | Ring and consents are owner-stamped. An owner change replaces the key and drops consents (`APP_AUTH_RESET`). Config removal drops both. |
| **Downgrade** | JWE `alg`/`enc` are pinned, so `none`, other algs, `zip` and `crit` are refused. There is no JWS or plaintext path. There is no parameter to skip consent or change the response mode. `userVerification: "required"` and the UV flag is checked. Passkey sessions can't register or delete passkeys. `amr` is truthful, so apps that care can require `"pam"`. |
| **Password guessing via the reauth endpoint** | It reuses `attemptLogin`, with its slots, Fibonacci grudges, soft lockout and equal-time failures. |
| **Passkey login flood** | Per-IP soft lockout (loopback aggregated), a 1s failure floor. Challenges are stateless (sealed ids, 5-min TTL), so a flood of `/auth/passkey/options` stores nothing and can't push out anyone's pending login; only used ids are kept (≤ 10,000). |
| **Pending sign-in eviction** | Parked authorize requests are stateless too: no number of `/app-auth/authorize` hits (a curl loop, `<img>` tags on any page) can evict a victim's request. |
| **Request-id leakage** | A parked id only lets a *logged-in* user send a token to the site that asked, the same as starting the flow themselves. It is single-use with a 10-min TTL, and encrypted: it shows nothing of the request. |
| **Token leaked from another path of the site** | `return_to` is only ever the exact callback, and the SDK compares `dest` with the URL the token arrived at, not with anything in the (unsigned) state cookie. |
| **A leaked site key after rotation** | The rotated-out key is marked `retired` in every ring candy hands out, and opens only tokens issued before the rotation; SDK apps refetch the ring every 5 minutes. A server with a pre-rotation static ring that can't refetch must be restarted (the CLI says which). |
| **Passkey of a deleted or renamed account** | Records and the user handle carry the uid; login needs `uidOf(user) === record.uid`. A user who leaves the candy group, or whose account is deleted or replaced, loses their passkeys (`PASSKEY_DROP`). |
| **Account policy bypass by passkey** | Passkey login runs `pam_acct_mgmt` (pam.ts `checkAccount`), as the password login does. |
| **Root by a synced passkey alone** | A passkey session is never a superuser until the password is re-entered (`SUPERUSER_PAM_MS`). |
| **Body size on public routes** | `readJsonBody` counts bytes as they stream and cancels past 64 KB, chunked bodies included (Content-Length alone was trusted before). |

## Open questions (do not block the build)
- Some WebAuthn clients may not accept `.candy` (not on the PSL) as an RP ID. `.localhost` works in Chrome and Firefox. Check Safari by hand.
- A shared replay store for function pools (KV) is left to apps through `ReplayStore`.

---

## F as built (integration notes)

Where the wiring differs from, or pins down, section F:

- **Routes live in `app-auth-routes.ts`** (`createAuthRoutes(deps)`), not inline in `controlFetch`. The daemon dispatches the listed paths after its guard (class, login, `sameOrigin`, page token; `/sdk/auth/keys` after the `/sdk/` API-key rule), so `test/app-auth-flow.test.ts` drives the same handlers end to end with real stores, real keys, the real SDK and a software ES256 authenticator.
- **Passkey login also honours the password login's address lockout** (the Fibonacci grudge off-machine, the loopback soft delay): an address locked out for guessing passwords gets 429 on `/auth/passkey/options` and `/auth/passkey` before anything is checked. On top of that it keeps its own `SoftLockout` and 1s failure floor; login challenges are stateless sealed ids, so there is no per-address challenge cap. It does not take a PAM `LoginSlots` slot (no PAM helper runs); parallel attempts are still bounded because each is counted before its first await. Passkey failures do not count toward the password grudges, so a broken authenticator can't lock out the password.
- **A parked request is bound to the portal host it arrived on** (its `issuer`): the consent page and the decision on another portal host answer 404 `AUTHZ_EXPIRED`. The consent page re-checks the request (`recheckRequest`) before showing it; a denial is re-checked too, so `error=access_denied` never goes to a host that changed hands.
- **Audit additions**: `APP_AUTH_REVOKE` (consent revoked), `APP_AUTH_DROP` (name removed: key, approvals and credential file deleted), `APP_AUTH_RESET` also when the decision or a key fetch finds a ring left by a previous owner. `APP_AUTH_GRANT` records user, site, return host, amr, kid and jti, never the token.
- **`sdk.ts` `appAuth()`** needs a site from `CANDY_AUTH_SITE` or `{ site }`; it does not ask `/sdk/runtime` (`createAppAuth` is synchronous, and every launch candy makes sets the env). The key fetch sends `{ name }` only. Inside a function, `appAuth()` returns fn-host's `env.CANDY_AUTH` object (`globalThis[Symbol.for("candy.appAuth")]`).
- **`sandbox.ts`** drops `CANDY_AUTH_KEYS` from `--setenv` unconditionally (`SECRET_ENV_NAMES`), and refuses a `LoadCredential` name or path systemd could misread.
- **Logs**: Caddy's access-log filter also deletes a `candy_token` query parameter (`LOG_REDACTED_QUERY_PARAMS`), for apps that misuse the SDK. The function request log already redacts any field or parameter named like `token` (fn-log `SECRET_NAME`), which covers the callback's form body.
- **fn-host** refuses a var, secret, KV/D1 or assets binding named `CANDY_AUTH`, reads the ring before the function's module is imported, and removes `CANDY_AUTH_KEYS` from `process.env`.
- **Request bodies** on these routes are read with a 64 KB cap, counted while streaming (a chunked body is cancelled past it, never buffered). `/app-auth/rotate` and `/app-auth/consents/revoke` lower-case the name themselves (`lowerName`), since `readJsonBody` bypasses the `req.json` patch of `lowerRequestNames`. `/passkeys/list?user=` is for a portal superuser only. `/auth/me` reports `amr`, `superuserNeedsPassword` and `superuserUntil` (when a passkey session's step-up runs out, else null). `/app-auth/rotate` needs the name to be in use (`mayUse`); it creates a ring if there was none.
- **CLI**: also `candy app-auth consents` and `candy app-auth revoke <site>`. The portal header links to `/passkeys`.
- **Portal step-up** (`public/portal.html`): the portal's `CANDY_VARS` carry `superuserNeedsPassword` and `superuserUntil`. While `superuserNeedsPassword` is true the header shows an "Unlock superuser" button by the user's name; it opens a password dialog (the passkeys page's prompt: hidden username for password managers, the daemon's error text, a `retryAfter` countdown, the field cleared after every attempt, nothing stored) that POSTs `/auth/reauth` with the page token, then re-reads `/auth/me` and redraws the superuser views without a reload. A timer re-reads `/auth/me` just after `superuserUntil` (and again when the tab comes back into view), so the button returns when the hour is up. The guard's superuser refusal of such a session is `403 {error, superuserNeedsPassword: true}`; `apiCall` offers the same dialog for it and retries once, for a user's action (not GET/HEAD: background polling only updates the header). Handlers that check `auth.superuser` themselves (running a site or function as another user, forced DNS replacement) answer a plain 403 and get no prompt.
