// Copy parity for Network and Peers (SPEC §9.1, package F), verbatim in this folder.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = import.meta.dir
const text = readdirSync(DIR).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes(".test.")).map(f => readFileSync(join(DIR, f), "utf8")).join("\n")

const STRINGS = [
  "Nothing published to the LAN.", "Nothing is served on Tailscale.", "No local ports.", "No quick tunnels open.",
  "Opening…", "Not linked", "Sync failed: ", "Linked to ",
  "Couldn’t load the candy network registry: ", "shadowed by an earlier exact claim", "expired",
  "Local records", "Remote records",
]

for (const s of STRINGS) test(`"${s}"`, () => { expect(text).toContain(s) })
