import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The installer copies a fixed list of modules into /usr/lib/candy for the
// sandboxed shim and fn-tool. A module missing there only breaks root mode,
// so check the list against everything they import.
const root = join(import.meta.dir, "..")

const localImports = (file: string): string[] => {
  const src = readFileSync(join(root, file), "utf8")
  const out = new Set<string>()
  for (const m of src.matchAll(/(?:from\s+|import\()\s*["']\.\/([^"']+?)["']/g)) out.add(m[1].endsWith(".ts") ? m[1] : `${m[1]}.ts`)
  return [...out]
}

const closure = (entries: string[]): string[] => {
  const seen = new Set<string>()
  const todo = [...entries]
  while (todo.length) {
    const f = todo.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    todo.push(...localImports(f))
  }
  return [...seen].sort()
}

describe("install-service.sh function shim", () => {
  it("installs every module the shim and fn-tool import", () => {
    const script = readFileSync(join(root, "install-service.sh"), "utf8")
    const installed = new Set([...script.matchAll(/"\$dir\/([\w.-]+\.ts)"/g)].map(m => m[1]))
    const missing = closure(["fn-host.ts", "fn-tool.ts"]).filter(f => !installed.has(f))
    expect(missing).toEqual([])
  })
})
