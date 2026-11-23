// Copy parity for Activity (SPEC §9.1, package F): each old string appears verbatim in this folder.

import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = import.meta.dir
const text = readdirSync(DIR).filter(f => /\.(ts|tsx)$/.test(f) && !f.includes(".test.")).map(f => readFileSync(join(DIR, f), "utf8")).join("\n")

const STRINGS = [
  "Nothing yet. Sites added, renamed, started or shared show up here.",
  "Couldn’t load activity.",
  "Yesterday",
  "Today",
]

for (const s of STRINGS) test(`"${s}"`, () => { expect(text).toContain(s) })
