# Bound Domain Auth — Design Doc

## Overview
Bound domains (public cloudflare tunnel) get a password gate. `.localhost` and `.candy` (tailscale) stay unprotected. Password is per-domain, configured in the portal UI.

## Architecture: Caddy forward_auth (Option B)

Caddy handles all proxying (WS/SSE/HTTP2 natively). Daemon only does auth logic via `forward_auth`.

```caddyfile
http://myapp.yourdomain.com {
  forward_auth localhost:9999 {
    uri /candy-auth/check
    copy_headers Cookie X-Forwarded-For User-Agent
  }
  reverse_proxy localhost:{server_port}
  log
}
```

Flow:
1. Request hits caddy
2. Caddy sends subrequest to daemon `/candy-auth/check` with original headers
3. Daemon checks cookie + fingerprint → 200 (pass) or 401 (show login page)
4. If 200 → caddy proxies to dev server directly
5. If 401 → daemon's response body IS the login page

## Password Storage

```json
// domains.json per binding
{
  "auth": {
    "password": "<bcrypt hash>",  // null = no auth (easter egg nag)
    "enabled": true
  }
}
```

- Hash with `Bun.password.hash()` / `Bun.password.verify()`
- Set via portal UI or CLI: `candy auth set <domain> <password>`
- `candy auth clear <domain>` removes it

## Session/Cookie Model

On correct password:
- Generate session token: crypto.randomBytes(32).toString('hex')
- Store in memory: `Map<token, { ip, userAgent, domain, issuedAt, expiresAt, lastSeen }>`
- Set cookie: `candy_auth_<domain>=<token>; HttpOnly; Secure; SameSite=Strict; Max-Age=3600; Path=/`
- Cookie + fingerprint (IP + User-Agent) must match

Renewal: on every authenticated request, if <15min left, extend expiresAt by 1hr, reissue cookie.
Expiry: 1 hour from last activity. Cleanup sweep every 5 min.

## Fingerprinting (Weak Signal)

Session pinned to: client IP, User-Agent, domain.
If IP or UA changes → session invalidated, re-auth required.
Not security (spoofable) — just friction against casual cookie theft.

WebSocket/SSE: cookies sent on initial handshake, so auth works. Connection stays open after that.

## Rate Limiting — Unauthenticated

Per-domain, tracked by IP:
- 3 requests/second max for unauthenticated visitors
- Exceeding → serve `blocked.html` (camera easter egg)
- Block duration: 60 seconds

## Rate Limiting — Auth Failures (Fibonacci Backoff)

Per IP+UserAgent combo:
- 1st/2nd wrong password → instant retry
- 3rd wrong → blocked for fib(n) seconds (1, 1, 2, 3, 5, 8, 13, 21...)
- Each subsequent failure advances the fib sequence
- Correct password → reset fib, clear failures
- Backoff state expires after 1 hour of no attempts

## Easter Eggs

### No password configured (nag):
- Floating banner injected on every page: "🍬 this domain is unprotected"
- Candy-styled, dismissible but returns

### blocked.html (rate limit exceeded):
- Fake "Face ID verification required" page
- Requests camera permission
- If granted: shows user's face with spooky overlay + "access denied — your face has been logged"
- If denied: "camera access required for verification"
- Does nothing real — just scares them. Unblocks after timeout.

## Login Page

Candy-styled, injected by daemon:
- Single password field + submit
- Candy branding, minimal
- Shows fibonacci backoff countdown if blocked
- POST to `/candy-auth/login`

## CLI

```
candy auth set <domain> [password]    # prompts if no password arg
candy auth clear <domain>
candy auth status
```

## Request Flow

```
incoming request on bound domain
  ├─ is .localhost or .candy? → pass through
  ├─ has valid candy_auth cookie + fingerprint match? → 200 (caddy proxies)
  ├─ POST /candy-auth/login?
  │   ├─ fib blocked? → show backoff page
  │   ├─ correct? → issue cookie, redirect
  │   └─ wrong? → increment failures, advance fib if ≥3
  ├─ no auth configured?
  │   ├─ rate check (3rps) → over? → blocked.html (camera egg)
  │   └─ under → 200 + inject nag banner
  └─ auth required, no cookie → 401 login page
```
