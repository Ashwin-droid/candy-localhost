// Copy parity for the kit and the frame (SPEC §9.1, package A's list). Each string must appear verbatim in A's files.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..")
const read = (...files: string[]) => files.map(f => readFileSync(join(SRC, f), "utf8")).join("\n")

const STRINGS: [string, string[]][] = [
  ["Couldn't copy. Select it and copy by hand.", ["ui/InlineReveal.tsx", "ui/CopyButton.tsx"]],
  ["Shown once", ["ui/InlineReveal.tsx"]],
  ["Lost contact with the daemon. Showing what it last said at ", ["ui/AppFrame.tsx"]],
  ["Your superuser access ended.", ["ui/AppFrame.tsx"]],
  ["Daemon up ", ["ui/AppFrame.tsx"]],
  ["Daemon offline", ["ui/AppFrame.tsx"]],
  ["Connecting…", ["ui/AppFrame.tsx"]],
  ["The portal was updated. Reload the page.", ["routes.tsx"]],
  ["This address only works for a portal login.", ["session.tsx"]],
  ["Couldn’t reach candy. Retrying…", ["session.tsx"]],
  ["Can't reach the candy daemon.", ["api/client.ts"]],
  ["Request failed (", ["api/client.ts"]],
  ["Unsaved changes", ["ui/SettingsSection.tsx"]],
  ["Changed elsewhere. Reset to see the new value.", ["ui/SettingsSection.tsx"]],
  ["Showing ", ["ui/Table.tsx"]],
  [". Filter to narrow it.", ["ui/Table.tsx"]],
  ["Not built yet.", ["ui/Placeholder.tsx"]],
  ["There’s nothing here.", ["pages/NotFoundPage.tsx"]],
  ["Failed to start process", ["shared/StartButton.tsx"]],
  [" started", ["shared/StartButton.tsx"]],
  ["Single-page app: unknown paths get /index.html", ["shared/AssetsFacts.tsx"]],
  ["Nearest 404.html, status 404", ["shared/AssetsFacts.tsx"]],
  ["Empty 404", ["shared/AssetsFacts.tsx"]],
  ["Order: worker-first patterns, then _redirects, then a matching file (with _headers), then ", ["shared/AssetsFacts.tsx"]],
  [`Edit "assets" in candy.json to change this.`, ["shared/AssetsFacts.tsx"]],
  [`For a SPA with an API, set \\"run_worker_first\\": [\\"/api/*\\"] so /api/* reaches the code instead of index.html.`, ["shared/AssetsFacts.tsx"]],
  ["Use letters, numbers and dashes only", ["lib/validate.ts"]],
  ["Enter a port between ", ["lib/validate.ts"]],
  ["Enter a number of minutes", ["lib/validate.ts"]],
  ["Use the full path, starting with /", ["lib/validate.ts"]],
  [" must be a whole number, ", ["lib/validate.ts"]],
  ["has no password. Anyone with the link can open it.", ["lib/attention.ts"]],
  ["(it keeps its old config)", ["lib/attention.ts"]],
  ["The portal is older than its source. Run bun run web:build.", ["lib/attention.ts", "ui/AppFrame.tsx"]],
]

for (const [s, files] of STRINGS) {
  test(`"${s}"`, () => {
    for (const f of files) expect(read(f)).toContain(s)
  })
}
