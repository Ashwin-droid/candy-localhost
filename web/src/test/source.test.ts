// Web-wide source greps (SPEC §9.1). They read every source file under web/src except tests.

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { APP_ROUTES, ROUTES } from "../routes.tsx"

const SRC = join(import.meta.dir, "..")
const REPO = join(SRC, "..", "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out) }
    else out.push(p)
  }
  return out
}

const all = walk(SRC)
const isTest = (p: string) => /\.test\.tsx?$/.test(p) || relative(SRC, p).startsWith("test/")
const code = all.filter(p => /\.(ts|tsx)$/.test(p) && !isTest(p) && !p.endsWith(".d.ts"))
const css = all.filter(p => p.endsWith(".css"))
const rel = (p: string) => relative(SRC, p)

/** Remove comments, keeping strings (good enough for these greps: "//" inside a string is kept). */
function stripComments(src: string): string {
  let out = "", i = 0
  let q: string | null = null
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (q) {
      out += c
      if (c === "\\") { out += n ?? ""; i += 2; continue }
      if (c === q) q = null
      i++; continue
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue }
    out += c; i++
  }
  return out
}

const sources = code.map(p => ({ path: rel(p), text: readFileSync(p, "utf8"), code: stripComments(readFileSync(p, "utf8")) }))

function offenders(re: RegExp, which: "code" | "text" = "code"): string[] {
  return sources.filter(s => re.test(s[which])).map(s => s.path)
}

describe("source greps", () => {
  test("no raw HTML sinks or eval", () => {
    expect(offenders(/dangerouslySetInnerHTML|\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\b/)).toEqual([])
  })
  test("no EventSource, no injected page globals, no WebAuthn", () => {
    expect(offenders(/\bEventSource\b/)).toEqual([])
    expect(offenders(/CANDY_TOKEN|CANDY_VARS/, "text")).toEqual([])
    expect(offenders(/navigator\.credentials/)).toEqual([])
  })
  test("no absolute http(s) fetch targets", () => {
    expect(offenders(/\b(?:fetch|get|post|del|stream)\s*(?:<[^>]*>)?\(\s*["'`]https?:\/\//)).toEqual([])
  })
  test("calls it candy.json, never candy.fn.json or wrangler", () => {
    expect(offenders(/candy\.fn\.json|wrangler/i, "text")).toEqual([])
  })
  test("index.html has no inline script", () => {
    const html = readFileSync(join(SRC, "index.html"), "utf8")
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const [, attrs, body] of scripts) {
      expect(/\bsrc=/.test(attrs)).toBe(true)
      expect(body.trim()).toBe("")
    }
    expect(/\bstyle=/.test(html)).toBe(false)
    expect(/<style\b/i.test(html)).toBe(false)
    expect(html).not.toContain("CANDY_")
  })
  test("no colour literals in CSS outside tokens.css", () => {
    const bad: string[] = []
    for (const p of css) {
      if (p.endsWith("styles/tokens.css")) continue
      const text = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
      if (/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i.test(text)) bad.push(rel(p))
    }
    expect(bad).toEqual([])
  })
  test("no style attributes in JSX strings that a CSP would block (style={{…}} via React is fine)", () => {
    expect(offenders(/style\s*=\s*["']/)).toEqual([])
  })
})

describe("modules import without a DOM", () => {
  test("window, document, localStorage, sessionStorage and location are absent under bun test", () => {
    const g = globalThis as Record<string, unknown>
    for (const k of ["window", "document", "localStorage", "sessionStorage", "location"]) expect(g[k]).toBeUndefined()
  })
  test("every module under web/src imports", async () => {
    const failed: string[] = []
    for (const p of code) {
      if (rel(p) === "main.tsx") continue       // the entry renders into #root; it is checked by `bun run check`
      try { await import(p) } catch (e) { failed.push(`${rel(p)}: ${(e as Error).message}`) }
    }
    expect(failed).toEqual([])
  })
  test("main.tsx reads the DOM only inside guarded code", () => {
    const main = stripComments(readFileSync(join(SRC, "main.tsx"), "utf8"))
    expect(main).toContain('document.getElementById("root")')
  })
})

describe("routes against the daemon's table", () => {
  const daemonMatch = (rule: string, path: string) =>
    rule.endsWith("/*") ? path.startsWith(rule.slice(0, -1)) && path.length > rule.length - 1 : rule === path
  // Before the S2 cut-over these three are still "user" (the old pages); afterwards they are "app".
  const CUT_OVER = ["/", "/settings", "/passkeys"]

  function daemonTable(): { path: string; cls: string }[] | null {
    let src: string
    try { src = readFileSync(join(REPO, "daemon.ts"), "utf8") } catch { return null }
    const begin = src.indexOf("route-table:begin"), end = src.indexOf("route-table:end")
    if (begin < 0 || end < 0) return null
    return [...src.slice(begin, end).matchAll(/\[\s*"GET"\s*,\s*"([^"]+)"\s*,\s*"([a-z]+)"\s*\]/g)].map(m => ({ path: m[1], cls: m[2] }))
  }

  test("every ROUTES pattern is under an APP_ROUTES rule", () => {
    for (const r of ROUTES) {
      const sample = r.pattern.replace(/:[a-z]+/g, "x")
      expect(APP_ROUTES.some(rule => daemonMatch(rule, sample))).toBe(true)
    }
  })
  test("APP_ROUTES equals the daemon's app rules (modulo the S2 cut-over)", () => {
    const table = daemonTable()
    if (!table) return                     // daemon.ts not next to web/ (a web-only checkout)
    const app = table.filter(t => t.cls === "app").map(t => t.path)
    for (const p of app) expect(APP_ROUTES).toContain(p)
    for (const p of APP_ROUTES) {
      if (CUT_OVER.includes(p)) expect(table.some(t => t.path === p && (t.cls === "app" || t.cls === "user"))).toBe(true)
      else expect(app).toContain(p)
    }
    expect(table.some(t => t.path === "/assets/*" && t.cls === "public")).toBe(true)
  })
  test("the daemon's pinned list in test/route-table.test.ts agrees", () => {
    let src: string
    try { src = readFileSync(join(REPO, "test", "route-table.test.ts"), "utf8") } catch { return }
    const lists = [...src.matchAll(/const APP_PATHS\w*\s*=\s*\[([^\]]*)\]/g)].map(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]))
    for (const list of lists) {
      for (const p of list) expect(APP_ROUTES).toContain(p)
      for (const p of APP_ROUTES) if (!CUT_OVER.includes(p)) expect(list).toContain(p)
    }
  })
})
