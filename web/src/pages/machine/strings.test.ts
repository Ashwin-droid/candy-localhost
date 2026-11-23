// Copy parity for Machine (SPEC §9.1, package F): portal.html's system monitor strings and the §5.12 confirms.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const DIR = import.meta.dir
const files = (d: string): string[] => readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]))
const text = files(DIR).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes(".test.")).map(f => readFileSync(f, "utf8")).join("\n")

const STRINGS = [
  "Could not read the system", "Lost contact with the daemon. Trying again…",
  "acting as root", "acting as the daemon's user", " processes, ", " threads",
  " cores", "load ", "no swap", " available · ", " cache", "No disks found", "No traffic",
  "Filter by name, user, service or pid", "services and sessions", " failed",
  "this daemon", "candy: ", "kernel", "Nothing matches",
  "Ask it to exit (SIGTERM)", "Kill it at once (SIGKILL)",
  "Killed ${what}", "Asked ${what} to exit",
  "stopping", "starting", "restarting",
  "Only a superuser can see this machine.",
  // §5.12
  "Kill ${p.name} (pid ${p.pid}, ${p.user})?", "It gets no chance to save or clean up.",
  "Ask ${p.name} (pid ${p.pid}) to exit?", "Stop ${unit}?", "will be ended.",
]

for (const s of STRINGS) test(`"${s}"`, () => { expect(text).toContain(s) })
