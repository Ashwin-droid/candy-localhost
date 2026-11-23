// Copy parity for package B (SPEC §9.1): the old dashboard's strings (01 §2, §4.5, §5, §7, §13) and the
// spec's replacements that B's pages show, each grepped in B's own files.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const PAGES = join(import.meta.dir, "..", "..")
const FILES = [
  "sites/SitesPage.tsx", "sites/view.ts", "sites/actions.ts", "site/SitePage.tsx", "site/OverviewTab.tsx", "site/AddSiteDialog.tsx",
]
const all = FILES.map(f => readFileSync(join(PAGES, f), "utf8")).join("\n")

const STRINGS: string[] = [
  // Sites (§5.1)
  "Reload candy.json", "Add site", "Needs attention", "Filter sites", "Protect it", "Open manifest",
  "quick tunnel", " running", "No sites yet. Open any ", " in a browser to set one up, or add one here.",
  "Read candy.json for ", " isn't one of your sites", "Could not reload",
  "Read candy.json again for every site. Nothing restarts. An edit otherwise waits for the site's next start.",
  "Mine", "Everyone",
  // process actions (01 §5)
  "Failed to stop process", " stopped", "Restarting ", "Failed to restart process", " restarted",
  "Failed to close portal", "Portal closed",
  // Add site (§5.2, 01 §7)
  "Add a site", "Existing port", "Something is already listening on this machine.", "Command",
  "candy starts it the first time it's opened.", "Function", "A Workers-style module or a static folder. No port.",
  "Something already listening on this machine.", "Keep this route when the daemon restarts", "Run as",
  "The command runs with this user's permissions. Root isn't an option.", "Nobody is in the candy group yet.",
  "~/projects/myapp", "npm run dev", "bun dev", "pnpm dev", "yarn dev", "'s home, ",
  "candy starts it the first time the site is opened and finds the port from its output.", "More options",
  "API mode: the first request waits while it starts, no loading page",
  `The folder with its candy.json. The code ("main"), static files ("assets"), KV, D1 and cron jobs are read from there.`,
  `Only if candy.json has no "main", or to run a different file.`,
  "Hot instances stay warm. Max caps how many run at once. Linger is how long an idle one waits before it exits. Empty uses the usual value.",
  "A KEY=VALUE file whose values the function gets as its environment. Use the full path.",
  "Linger must be 0 to 600 seconds", "Hot can't be more than max", "env file",
  "Failed to add route", "Failed to add config", "Could not add the function",
  "The daemon serves its files; no process starts.",
  "Its candy.json handlers leave out http, so it gets no URL: cron and events run it.",
  "It starts on the first request.", "Added ",
  // site frame (§5.3, 01 §13)
  "Running for ", "Crashed, exit code ", "Pinned deploy ", "Live from source", "Runs as ", "Function · static",
  "candy.json has an error. It keeps its old config.", "See it", "Deploying ", " deployed ", "Deploy failed: ",
  "There is no site called ", ". It may have been renamed or deleted.", "Back to Sites", "Add it",
  // Overview (§5.4, 01 §4.6, §13.1)
  "Last run", "Open full log", "It was near its memory limit", "candy.json has an error", "no limit yet",
  "Started before limits existed: it gets one at its next start.", "Stops after ", " min idle", "(usual)",
  "No code. The daemon serves the files.", "Has a URL", "No HTTP handler. Cron and events run it, so it has no URL.",
  "live from ", "pinned", "Metadata only", "None running. The next request starts one.", "Warm up", "On demand",
  "Ready", "Starting", "In flight", " on this machine", "External URL", "Listening", "Forwarding", "Kept across restarts",
  "These sites depend on it or subscribe to its events, so it isn't stopped for being idle.",
  "Asks for Sign in with candy", "scheduled run", "Accepts service tokens", "Other users' sites may depend on it",
  "May ask to stay up past its idle limit", "No candy.json in ", ". It runs with defaults.", "Reachable at",
  "Change these in Settings", "No URL. Its candy.json handlers leave out http, so cron jobs and events are what run it.",
]

for (const s of STRINGS) {
  test(`"${s}"`, () => { expect(all).toContain(s) })
}
