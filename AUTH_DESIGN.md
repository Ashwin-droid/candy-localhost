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
- 3rd wrong → blocked for fib(n) hours (1, 1, 2, 3, 5, 8, 13, 21...)
- Each subsequent failure advances the fib sequence
- Correct password → reset fib, clear failures
- Grudge state is persisted in `~/.config/candy/candy-grudge.lock`
- Wiping that lock file clears all stored grudges

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

---

# Portal Login (PAM) — Design

> Passkey login (an alternative to the password, set up after a password login) and "Sign in with candy" for apps build on this section: see `SDK_AUTH_DESIGN.md`.

## Goal

The portal (`portal.localhost`, `portal.candy`) and the public-MCP consent page require a local account login. The username is picked from a dropdown, and the password is checked against the machine's password through PAM.

- **Everyone** is user-scoped: they see and change only their own servers, functions, request logs, portals and domains.
- **Sudoers** are superusers, automatically, for the whole portal session: they see and manage everything and change global settings.
- **The CLI, local MCP and public MCP tokens are always user-scoped, for sudoers too.** Superuser exists only in a logged-in portal session.
- **The owner (`CANDY_OWNER`) no longer gets implicit admin rights anywhere.** It is just the default account and the daemon's user-mode identity.
  - This is about the portal/CLI/MCP permission model, not host security: the owner account is effectively root, since the systemd unit runs the owner's own checkout with bun as root and hands `~/.config/caddy` back to the owner. Running Caddy unprivileged is still a TODO.

## Who can log in

- The dropdown (`GET /auth/users`) lists the owner plus members of the `candy` group: the accounts that already have per-user secrets. It never lists root (uid 0) or accounts without a usable shell.
- A login attempt for any other name fails the same way a wrong password does.
- User mode (daemon not root): only the daemon's own user is listed. PAM can only check the caller's own password there (unix_chkpwd).

## PAM — `pam.ts`

- Service `/etc/pam.d/candy`, installed by `install-service.sh` from `candy.pam`:
  ```
  auth     include common-auth
  account  include common-account
  ```
  If the service file is missing, login fails closed with a clear error. It never falls back to another service.
- It calls `pam_start` → `pam_authenticate` → `pam_acct_mgmt` through `bun:ffi` on `libpam.so.0`. A conversation callback answers echo-off prompts with the password and ignores info/error messages.
- **It runs in a child process** (`bun pam.ts --helper`, with JSON `{service, user, password, confdir?}` on stdin and JSON `{ok, code, message}` on stdout). PAM blocks (pam_faildelay, LDAP and so on) and a crash must not take the daemon down.
  - The parent enforces a 10s timeout and a 64 KB output cap.
  - The password never appears in argv or env and is never logged.
- `confdir` uses `pam_start_confdir` (Linux-PAM ≥ 1.4) so tests can use a private config with `pam_permit` / `pam_deny`. The daemon never passes it.
- Exports:
  - `verifyPassword(user, password, opts?: {service?: string; confdir?: string; timeoutMs?: number}): Promise<{ok: boolean; reason: "ok"|"denied"|"account"|"unavailable"|"timeout"}>`
  - `pamAvailable(service = "candy"): Promise<boolean>`

## Superusers — `superuser.ts`

- `isSuperuser(user): Promise<boolean>`: true when the user may run a root shell through sudo.
  - Root mode runs `sudo -n -l -U <user> -- /bin/sh` (exit 0 means allowed). Non-root falls back to membership in `sudo`/`wheel`/`admin`.
  - Never true for root itself or for unknown users.
  - Cached for 60s per user. `clearSuperuserCache()` is for tests.
- `loginUsers(): Promise<string[]>` returns the dropdown list (above), sorted with the owner first.

## Sessions — `portal-session.ts` (pure, tested)

- `class PortalSessions`
  - `constructor(file: string | null, opts?: {idleMs = 24h, maxMs = 7d, now?: () => number})`
  - `create(user, meta: {ip, ua}): {id, cookie}`
  - `get(cookieValue): {id, user, created, lastSeen} | null`: slides `lastSeen`, and expires on idle or max age.
  - `destroy(id)`, `destroyUser(user)`, `sweep()`
  - Persists to `file` (root-only 0600, atomic write). Only sha256 hashes of the cookie values are stored, so a leaked file grants nothing. Restarts keep people logged in.
- Cookie: `candy_portal=<32 random bytes, base64url>; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`, plus `Secure` on https.
- Session secret: 32 random bytes, returned once at login; only its sha256 is stored, compared in constant time. Stored sessions without one are dropped on load.
- At most 20 sessions per user (that user's oldest goes), 1000 overall. At most 32 page-token chains per session.
- `requestAuth` re-checks `loginUsers()` (60s cache): a removed, nologin, locked or expired account loses its sessions on its next request.
- The superuser flag is **not stored**. Every request computes it with `isSuperuser(user)` (60s cache), so removing someone from sudoers takes effect within a minute.
- The per-page `CANDY_TOKEN` chain stays as the CSRF token. It is only minted for a logged-in session and is tied to that session's id. A token from another session or a logged-out one is rejected.

## Login flow

- Any portal-host request without a valid session:
  - HTML gets a 302 to `/login?next=<path>` (same-origin paths only).
  - API gets 401 `{error: "login required"}`.
- Exempt routes:
  - `/login`, `/auth/users`, `/auth/login`, `/favicon.svg` and the login page's own assets.
  - Everything that is not the portal host: server and function hosts, bound domains, `/candy-auth/*`, the public MCP host.
  - Requests carrying a valid `X-Candy-API-Key` (CLI, SDK, local MCP), which keep their own user scope.
- `POST /auth/login {user, password}`:
  - Same-origin check (Origin/Referer must be the portal host).
  - Rate limits: per non-loopback IP, the existing Fibonacci grudge rules (3 free failures, then fib(n) hours), persisted with the other grudges. Per user (from any address), and for loopback (every browser on this machine), a soft delay: 3 free failures, then 7.5s, 15s, capped at 30s. A user is never locked for everyone.
  - All of 127/8 and ::1 counts as one address, for the soft delay and the slots: any local process can bind 127.0.0.N, so rotating them buys nothing.
  - Concurrency: one attempt per user and per IP in flight, at most 4 PAM helpers overall. A busy slot is 429 `{error: "busy, try again"}`: nothing was checked, so it must not look like a wrong password. Each attempt is counted as a failure before PAM is asked, refunded on success (and when PAM gives no verdict), so parallel guesses can't outrun the lockout.
  - A user in their soft delay gets 429 with `retryAfter` and nothing is counted against the caller's address.
  - The IP is the socket address, unless the request carries the per-boot `X-Candy-Proxy` tag our Caddy adds; then the last `X-Forwarded-For` hop, or `Cf-Connecting-Ip` when that hop is loopback (cloudflared). The tag is removed on arrival, before any route, so no function or server ever sees it; `X-Forwarded-*` and `Cf-*` from anyone but our Caddy are removed too.
  - A failure takes the same time (at least 4.5s, above PAM's failure delay: pam_unix p99 2.5s measured, pam_faildelay up to 3.75s) and has the same body for an unknown user, a wrong password and a PAM problem.
  - On success it sets the cookie and returns `{user, superuser, session}`. `session` is a second secret the login page keeps in `localStorage` (scoped to the exact origin, unlike cookies, which every port of the host gets) and every portal request sends as `X-Candy-Session`. The cookie alone never authenticates.
- Portal pages (`/`, `/oauth/consent`, `/go/kill`, `/go/portal`) are a token-free shell on navigation (`portal-shell.html`); the shell asks for the page again with the header and writes it. Without a stored secret it goes to `/login?next=`. Portal streams use `fetch`, since EventSource can't send headers.
- CORS allows only exact portal origins (https, default port). `portal.localhost` with any port but 443 is not the portal, and neither is a request whose `X-Forwarded-Host` (set by our Caddy) is another host: a bound domain whose upstream is the portal.
- Every response on the portal host (pages, the login page, the shell) carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- Caddy's access log never holds the session secret: the global log filter deletes `X-Candy-Session`, `X-Candy-Token`, `X-Candy-Api-Key`, `X-Candy-Auth`, `X-Candy-Proxy`, `Authorization`, `Cookie`, `X-Auth-Token` (and response `Set-Cookie`), and the file is 0600.
- `POST /auth/logout` destroys the session.
- `GET /auth/me` returns `{user, superuser}`.
- Every login, failure and logout is audited (`AUTH_LOGIN`, `AUTH_FAIL`, `AUTH_LOGOUT`) with user and IP. Passwords are never logged.

## Authorization — one place

- `requestAuth(req): Promise<{user: string; superuser: boolean; via: "portal"|"apikey"|"oauth"} | null>` replaces `requestUser`.
  - API keys give `{user, superuser: false}`.
  - A portal session gives `{user, superuser: await isSuperuser(user)}`.
  - Public MCP OAuth access tokens give `{user: grant.user, superuser: false}`.
- `mayChangeConfig(auth, config)` = `auth.superuser || auth.user === configUser(config)`. The old "owner may do anything" rule is removed.
- List endpoints (servers, configs, processes, portals, routes, domains, fn requests and logs, activity) return only the caller's own entries unless the caller is a superuser.
- **Superuser-only** (global) actions: domain/zone/tunnel and Cloudflare settings, LAN publishing, tailnet and AdGuard settings, the public MCP toggle and its OAuth client list, other users' audit log, kill-all style actions, and running as another account (`user` ≠ self on register/config).
- Every route in daemon.ts is classified as **public**, **user** or **superuser**, in a table at the top of the router. A route left out of the table is denied (fail closed), and a test checks that every route the router matches appears in the table.

## Public MCP consent

- `/oauth/consent` requires a portal login and redirects to `/login?next=…` otherwise.
- The consent page shows "approving as <user>". The grant records that user, and access and refresh tokens act as that user, user-scoped, never superuser.
- Grants made before this change carry no user, so they are revoked at startup and audited, and clients must consent again.

## Portal UI

- `public/portal-login.html`, in the portal's visual style: a user dropdown, a password field, an error line and a lockout countdown.
- The portal header shows "<user>" plus a "superuser" badge when applicable, and a Log out button.
- Superuser-only controls are hidden for other users, and the API enforces the same rules.
- Superusers get a "Daemon settings" card: the Cloudflare zone/tunnel (`POST /domains/config`) and the AdGuard Home link (`/lan/adguard`). The CLI gets a 403 for both and says to use the portal.

## Shortcut hosts and site pages

- `<name>.k|kill.<tld>` (stop) and `<name>.p|portal.<tld>` (public tunnel) need a portal login. The site host only redirects to `https://portal.<tld>/go/kill?name=<name>` or `/go/portal?name=<name>` (user routes); nothing happens on a GET.
- There a logged-in user sees "Stop foo?" / "Open a public tunnel to foo?" (`confirm-action.html`). The button POSTs the same path with the page's token, through the usual Origin check, and only for the site's user or a superuser. Afterwards the GET shows `killed.html` / `portaling.html`.
- Site pages (`candy.html`, `starting.html`, `crashed.html`) can't act without a login, so registering and typing into the terminal link to the portal (`/?add=<name>`, `/?logs=<name>`). Without a login they keep (`siteAction`): tunnel status; a bounded startup excerpt (32 KB) of their own log, only while starting or crashed; and start/restart, with a site token the daemon mints into that page (bound to the name, 15 minutes). An Origin header proves nothing on its own.
  - The excerpt starts at the log's size when this run was spawned, so earlier runs' output never shows.
  - With a site token, start only starts a stopped site and ignores `configId` (a site with several start commands is started from the portal); restart only restarts an errored or dead one. The site's tokens end when it becomes running. Picking the port links to the portal.
