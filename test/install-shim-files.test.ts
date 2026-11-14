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

describe("the daemon keeps the installed shim current", () => {
  it("syncs the same closure at start in root mode (a stale sdk-auth.ts/jwe.ts would refuse new tokens)", () => {
    const daemon = readFileSync(join(root, "daemon.ts"), "utf8")
    const fn = daemon.slice(daemon.indexOf("const fnShimModules = ():"), daemon.indexOf("const fnConfigOf = "))
    expect(fn).toContain(`const todo = ["fn-host.ts", "fn-tool.ts"]`)
    expect(fn).toContain("if (!RUNNING_AS_ROOT) return")
    expect(fn).toContain("dir.uid !== 0 || (dir.mode & 0o022) !== 0")
    expect(fn).toContain("auditLog('FN_SHIM_SYNC'")
    expect(daemon).toContain("await syncFnShim()")
    // and the closure includes the SDK pieces a function's env.CANDY_AUTH runs on
    expect(closure(["fn-host.ts", "fn-tool.ts"])).toEqual(expect.arrayContaining(["sdk-auth.ts", "jwe.ts"]))
  })
})
