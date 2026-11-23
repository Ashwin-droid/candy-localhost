// Copy parity for Public domains (SPEC §9.1, package F): old strings and §5.12 confirms, verbatim in this folder.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = import.meta.dir
const text = readdirSync(DIR).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes(".test.")).map(f => readFileSync(join(DIR, f), "utf8")).join("\n")

const STRINGS = [
  // portal-settings.html (02 §1.7)
  "Put a site on your own domain through a Cloudflare tunnel.",
  "No zone is set up yet; a superuser sets one up.",
  "No zone is set up yet.",
  "Couldn’t load domains.",
  "through the Cloudflare tunnel, and who may reach them.",
  "No public domains yet. Bind one to serve a site at name.",
  "Every request", "Login page", "Not set", "Needs API mode", "Anyone", "Tailscale",
  "Visitors to ", " need this password.",
  "Enter a password.",
  "The passwords don’t match.",
  "Domain unbound.", "Password set.", "Removed.", "Anyone can reach it now.", "Saved.",
  "Sign HS256 tokens with it: aud \\\"Candy API Authorization Service\\\", sub \\\"<site>.candy\\\", exp at most an hour away, iat now, and a jti to make a token single-use. Send them in X-Auth-Token.",
  "Token (good for 10 minutes)",
  "Send it in the X-Auth-Token header to try the site from a script. Made with its JWT secret, which is not shown.",
  // portal.html bind modal (01 §8)
  "Fill in all fields", "Binding domain...", "Overriding DNS records...", "Replace records",
  // SPEC §5.13
  "Anyone with the link can open it.",
  "Ask a superuser to replace them.",
  "Tailscale and this machine are always allowed. Caddy drops others silently. Empty means everyone.",
  "Bound ${",
  // §5.12 confirms
  "Unbind ${b.subdomain}?", "The site is no longer served on its public domain.",
  "Remove ${what} for ${fqdn}?", "the JWT secret", "the password", "protection",
  "Replace the JWT secret for ${b.fqdn}?", "Tokens signed with the old one stop working.",
  "Let anyone reach ${b.fqdn}?", "Allow all",
]

for (const s of STRINGS) test(`"${s}"`, () => { expect(text).toContain(s) })
