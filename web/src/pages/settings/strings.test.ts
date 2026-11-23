// Copy parity for package E (SPEC §9.1): the §5.12 confirms and the old settings / passkeys pages' strings
// these pages show, each found verbatim in its file.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8")

const STRINGS: [string, string][] = [
  // Account
  ["Superuser: you see and manage every user's sites and the daemon's settings", "AccountPage.tsx"],
  ["User: you see and manage your own sites", "AccountPage.tsx"],
  ["A passkey", "AccountPage.tsx"],
  ["Your password", "AccountPage.tsx"],
  ["Yes: sites run as their own users, in a sandbox", "AccountPage.tsx"],
  ["candy://portal", "AccountPage.tsx"],
  ["Open via the candy:// protocol", "AccountPage.tsx"],
  ["Log out", "AccountPage.tsx"],
  // Passkeys
  ["with a passkey instead of your password: Touch ID, Windows Hello, your phone or a security key.", "PasskeysPage.tsx"],
  ["Passkeys need a bound domain: candy checks them on candy.<your domain>, which has a real certificate. Set up a domain to use them; until then, log in with your password.", "PasskeysPage.tsx"],
  ["Needs a bound domain (see above).", "PasskeysPage.tsx"],
  ["This browser can’t make passkeys.", "PasskeysPage.tsx"],
  ["No passkeys yet.", "PasskeysPage.tsx"],
  ["(unusable)", "PasskeysPage.tsx"],
  ["Backed up by your passkey provider", "PasskeysPage.tsx"],
  ["synced", "PasskeysPage.tsx"],
  ["Passkey on ", "PasskeysPage.tsx"],
  ["candy-passkey", "PasskeysPage.tsx"],
  ["popup,width=", "PasskeysPage.tsx"],
  ["Passkey · candy", "PasskeysPage.tsx"],
  ["Opening ${candyHost}…", "PasskeysPage.tsx"],
  ["Follow the steps in the candy window…", "PasskeysPage.tsx"],
  ["Passkey added.", "PasskeysPage.tsx"],
  ["Delete the passkey “${pk.name}”?", "PasskeysPage.tsx"],
  ["You can't log in with it afterwards.", "PasskeysPage.tsx"],
  ["Passkey deleted. Also remove it from your device or password manager.", "PasskeysPage.tsx"],
  ["Something went wrong. Try again.", "passkeyMessage.ts"],
  // Recent password
  ["Adding or removing a passkey needs a recent password login.", "ReauthPanel.tsx"],
  ["Checking…", "ReauthPanel.tsx"],
  ["That didn’t work.", "ReauthPanel.tsx"],
  ["Too many failed logins. Try again in ${left}s.", "ReauthPanel.tsx"],
  ["current-password", "ReauthPanel.tsx"],
  ['autoComplete="username"', "ReauthPanel.tsx"],
  // Sign in with candy
  ["get a key.", "SignInPage.tsx"],
  ["Your sites' keys", "SignInPage.tsx"],
  ["Made ", "SignInPage.tsx"],
  [", replaced ", "SignInPage.tsx"],
  ["In use", "SignInPage.tsx"],
  ["Not asked for", "SignInPage.tsx"],
  ["Its candy.json asks for sign-in", "SignInPage.tsx"],
  ["Its candy.json doesn’t ask for sign-in (\"auth\": true). Nothing needs this key: revoke it.", "SignInPage.tsx"],
  ["Make a new sign-in key for ${s.site}?", "SignInPage.tsx"],
  ["Sign-ins started with the old key still finish for a few minutes; none after that.", "SignInPage.tsx"],
  ["Revoke the sign-in key of ${s.site}?", "SignInPage.tsx"],
  ["are deleted. Nobody can sign in to it with candy until it has a new key.", "logic.ts"],
  ["still asks for sign-in in its candy.json, so it gets a new key the next time it starts.", "logic.ts"],
  ["doesn’t ask for sign-in, so it gets no new key.", "logic.ts"],
  ["A running server keeps the old key in memory until it restarts.", "logic.ts"],
  [" has a new key (", "logic.ts"],
  [" to give it the new key (apps using the SDK pick it up within 5 minutes).", "logic.ts"],
  ["Revoked the key of ", "logic.ts"],
  [": a running server keeps the old key in memory until then.", "logic.ts"],
  ["None of your sites has a sign-in key.", "SignInPage.tsx"],
  ["Sites you said yes to", "SignInPage.tsx"],
  ["Run by", "SignInPage.tsx"],
  ["Forget that you said yes to ${c.site}?", "SignInPage.tsx"],
  ["It asks you again next time.", "SignInPage.tsx"],
  [" will ask again next time.", "SignInPage.tsx"],
  ["You hadn’t said yes to ", "SignInPage.tsx"],
  ["You haven’t said yes to any site.", "SignInPage.tsx"],
  // Daemon
  ["Only a superuser can change the daemon's settings.", "DaemonPage.tsx"],
  ["Cloudflare zone and tunnel", "DaemonPage.tsx"],
  ["are bound as <code>name.zone</code> and served through the tunnel. Same as <code>candy domain config</code>.", "DaemonPage.tsx"],
  ["Zone id ", "DaemonPage.tsx"],
  ["Tunnel name", "DaemonPage.tsx"],
  ["Tunnel id", "DaemonPage.tsx"],
  ["Credentials file", "DaemonPage.tsx"],
  ["~/.cloudflared/<tunnel id>.json", "DaemonPage.tsx"],
  ["Enter a zone or a tunnel name.", "logic.ts"],
  ["Saved.", "DaemonPage.tsx"],
  ["Public MCP address", "DaemonPage.tsx"],
  ["Needs a zone and a tunnel (above).", "DaemonPage.tsx"],
  ["candy for AI clients, from anywhere. Each client is approved from your tailnet.", "DaemonPage.tsx"],
  ["MCP is public at ${r?.url || \"its address\"}.", "DaemonPage.tsx"],
  ["The public MCP address is off.", "DaemonPage.tsx"],
  ["Every MCP client was signed out.", "DaemonPage.tsx"],
  ["Couldn’t load it.", "DaemonPage.tsx"],
  ["Turn off the public MCP address?", "DaemonPage.tsx"],
  ["Every connected client is signed out.", "DaemonPage.tsx"],
  ["Sign out every MCP client?", "DaemonPage.tsx"],
  ["They will need to be approved again.", "DaemonPage.tsx"],
  ["It will need to be approved again.", "DaemonPage.tsx"],
  ["signed in", "DaemonPage.tsx"],
  ["Sign out all", "DaemonPage.tsx"],
  ["Linked", "logic.ts"],
  ["Not linked", "logic.ts"],
  ["Couldn’t load", "logic.ts"],
  ["None right now", "logic.ts"],
  ["Failed: ", "logic.ts"],
  ["Sends LAN-published <code>.candy</code> names to candy-dns. Publish a site to the LAN from its Settings tab. Same as <code>candy lan adguard setup</code>.", "DaemonPage.tsx"],
  ["http://127.0.0.1:3000", "DaemonPage.tsx"],
  ["Unchanged", "DaemonPage.tsx"],
  ["Kept by the daemon, never shown again.", "DaemonPage.tsx"],
  ["Persistent client", "DaemonPage.tsx"],
  ["The AdGuard Home client that covers the LAN.", "DaemonPage.tsx"],
  ["candy-dns LAN listener", "DaemonPage.tsx"],
  ["127.0.0.1:5336", "DaemonPage.tsx"],
  ["AdGuard Home linked.", "DaemonPage.tsx"],
  ["Unlink AdGuard Home?", "DaemonPage.tsx"],
  ["candy takes out the upstream lines it added.", "DaemonPage.tsx"],
  ["AdGuard Home unlinked.", "DaemonPage.tsx"],
]

for (const [s, file] of STRINGS) {
  test(`${file}: "${s}"`, () => { expect(read(file)).toContain(s) })
}

test("§5.12 verbs", () => {
  const all = ["PasskeysPage.tsx", "SignInPage.tsx", "DaemonPage.tsx"].map(read).join("\n")
  for (const v of ['verb: "Delete"', 'verb: "Rotate"', 'verb: "Revoke"', 'verb: "Forget"', 'verb: "Turn off"', 'verb: "Sign out"', 'verb: "Unlink"']) {
    expect(all).toContain(v)
  }
})
