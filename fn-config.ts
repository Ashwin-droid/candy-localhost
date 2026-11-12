// Project config for candy functions: candy.fn.json or the wrangler subset we support.
// Pure apart from reading files in the function's folder.
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { MAX_CRON_JOBS, parseCron } from "./cron.ts"
import { loadAssetsConfig, type AssetsConfig } from "./fn-assets.ts"

export interface FnProjectConfig {
  // null only for an assets-only project; "" (with a warning) when there is neither main nor assets
  main: string | null
  assets: AssetsConfig | null
  vars: Record<string, string>
  kv: string[]
  d1: string[]
  crons: string[]
  warnings: string[]
  source: string | null
}

// First match wins.
export const CONFIG_FILES = ["candy.fn.json", "wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const

// Tried in order when the config has no `main` (or there is no config at all).
export const DEFAULT_ENTRIES = [
  "src/index.ts", "src/index.js", "src/index.mjs", "src/worker.ts", "src/worker.js",
  "index.ts", "index.js", "index.mjs", "worker.ts", "worker.js",
] as const

export const BINDING_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/i

// Wrangler keys that only matter to Cloudflare's deploy tooling; skipping them is not worth a warning.
const QUIET_KEYS = new Set(["$schema", "name", "compatibility_date", "compatibility_flags", "account_id", "workers_dev", "preview_urls"])
const WRANGLER_KEYS = new Set(["main", "vars", "kv_namespaces", "d1_databases", "triggers", "assets"])
// candy.fn.json also takes short forms.
const CANDY_KEYS = new Set([...WRANGLER_KEYS, "kv", "d1", "crons"])

const MAX_VAR_BYTES = 64 * 1024

// Strips // and /* */ comments and trailing commas, leaving strings alone.
// Block comments keep their newlines so JSON.parse errors still point at the right line.
export const stripJsonc = (src: string): string => {
  let noComments = ""
  for (let i = 0; i < src.length;) {
    const c = src[i]
    if (c === '"') {
      const end = stringEnd(src, i)
      noComments += src.slice(i, end)
      i = end
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      if (end < 0) throw new Error("unterminated /* comment")
      noComments += src.slice(i, end + 2).replace(/[^\n]/g, " ")
      i = end + 2
    } else {
      noComments += c
      i++
    }
  }
  let out = ""
  for (let i = 0; i < noComments.length;) {
    const c = noComments[i]
    if (c === '"') {
      const end = stringEnd(noComments, i)
      out += noComments.slice(i, end)
      i = end
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < noComments.length && /\s/.test(noComments[j])) j++
      if (noComments[j] === "}" || noComments[j] === "]") { i++; continue }
    }
    out += c
    i++
  }
  return out
}

// Index just past the closing quote of the string starting at `start`.
const stringEnd = (s: string, start: number): number => {
  let j = start + 1
  while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1
  return Math.min(j + 1, s.length)
}

export const parseJsonc = (src: string): unknown => JSON.parse(stripJsonc(src.replace(/^﻿/, "")))

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

// Strictly below `base` (not `base` itself).
const inside = (base: string, p: string) => {
  const rel = relative(base, p)
  return rel !== "" && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel)
}

// `main` must resolve inside `dir`, symlinks included, so a function can't point candy at someone else's files.
export const resolveMainInside = (dir: string, main: string): string => {
  if (typeof main !== "string" || !main.trim()) throw new Error("main must be a non-empty path")
  if (main.includes("\0")) throw new Error("main contains a NUL byte")
  const root = resolve(dir)
  const abs = resolve(root, main)
  if (!inside(root, abs)) throw new Error(`main "${main}" resolves outside the function folder`)
  if (existsSync(abs)) {
    const realRoot = realpathSync(root)
    if (!inside(realRoot, realpathSync(abs))) throw new Error(`main "${main}" is a symlink that leaves the function folder`)
  }
  return normalize(relative(root, abs))
}

const bindingNames = (raw: unknown, key: string): string[] => {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${key} must be an array`)
  return raw.map((entry, i) => {
    const name = typeof entry === "string" ? entry : isObject(entry) ? entry.binding : undefined
    if (typeof name !== "string") throw new Error(`${key}[${i}] needs a "binding" name`)
    if (!BINDING_NAME.test(name)) throw new Error(`${key}[${i}]: invalid binding name "${name}" (letters, digits and _, max 64)`)
    return name
  })
}

const cronList = (raw: unknown, key: string): string[] => {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${key} must be an array of cron expressions`)
  if (raw.length > MAX_CRON_JOBS) throw new Error(`${key}: at most ${MAX_CRON_JOBS} crons`)
  return raw.map((expr, i) => {
    if (typeof expr !== "string") throw new Error(`${key}[${i}] must be a string`)
    const trimmed = expr.trim()
    try {
      parseCron(trimmed)
    } catch (e) {
      throw new Error(`${key}[${i}]: ${(e as Error).message}`)
    }
    return trimmed
  })
}

// Workers vars can be any JSON; env values here are strings, so objects are passed as JSON text.
const varsOf = (raw: unknown, warnings: string[]): Record<string, string> => {
  if (raw === undefined) return {}
  if (!isObject(raw)) throw new Error("vars must be an object")
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!BINDING_NAME.test(k)) throw new Error(`vars: invalid name "${k}" (letters, digits and _, max 64)`)
    let s: string
    if (typeof v === "string") s = v
    else if (typeof v === "number" || typeof v === "boolean") s = String(v)
    else if (v === null || v === undefined) continue
    else {
      s = JSON.stringify(v)
      warnings.push(`vars.${k} is not a string; passed as JSON text`)
    }
    if (Buffer.byteLength(s) > MAX_VAR_BYTES) throw new Error(`vars.${k} is larger than ${MAX_VAR_BYTES} bytes`)
    out[k] = s
  }
  return out
}

// The daemon serves these files as root, so the folder must be a subfolder of the project
// (never the project itself: that would publish candy.fn.json, .env files and the source).
const assetsOf = (raw: unknown, dir: string, warnings: string[]): AssetsConfig | null => {
  if (raw === undefined || raw === null) return null
  const { config, warnings: w } = loadAssetsConfig(raw, dir)
  if (/[\x00-\x1f\x7f]/.test(config.directory)) throw new Error("assets.directory contains control characters")
  const root = resolve(dir)
  if (!inside(root, config.directory)) throw new Error(`assets.directory "${(raw as Record<string, unknown>).directory}" must be a folder inside the function folder`)
  if (existsSync(config.directory) && !inside(realpathSync(root), realpathSync(config.directory))) {
    throw new Error(`assets.directory "${(raw as Record<string, unknown>).directory}" is a symlink that leaves the function folder`)
  }
  warnings.push(...w)
  return config
}

const findDefaultEntry = (dir: string): string | null => DEFAULT_ENTRIES.find(p => existsSync(join(dir, p))) ?? null

// Validates a parsed config object. `file` is the config's basename, used for messages and key rules.
export const normalizeFnConfig = (raw: unknown, dir: string, file: string | null): Omit<FnProjectConfig, "source"> => {
  if (raw !== undefined && !isObject(raw)) throw new Error(`${file}: top level must be an object`)
  const obj = (raw ?? {}) as Record<string, unknown>
  const isCandy = file === "candy.fn.json" || file === null
  const known = isCandy ? CANDY_KEYS : WRANGLER_KEYS
  const warnings: string[] = []
  for (const key of Object.keys(obj)) {
    if (known.has(key) || QUIET_KEYS.has(key)) continue
    warnings.push(`${file}: "${key}" is not supported by candy and is ignored`)
  }

  const vars = varsOf(obj.vars, warnings)
  const kv = [...bindingNames(obj.kv_namespaces, "kv_namespaces"), ...(isCandy ? bindingNames(obj.kv, "kv") : [])]
  const d1 = [...bindingNames(obj.d1_databases, "d1_databases"), ...(isCandy ? bindingNames(obj.d1, "d1") : [])]

  let crons: string[] = []
  if (obj.triggers !== undefined) {
    if (!isObject(obj.triggers)) throw new Error("triggers must be an object")
    for (const k of Object.keys(obj.triggers)) if (k !== "crons") warnings.push(`${file}: "triggers.${k}" is not supported and is ignored`)
    crons = cronList(obj.triggers.crons, "triggers.crons")
  }
  if (isCandy && obj.crons !== undefined) crons = [...crons, ...cronList(obj.crons, "crons")]
  crons = [...new Set(crons)]
  if (crons.length > MAX_CRON_JOBS) throw new Error(`at most ${MAX_CRON_JOBS} crons`)

  // One env namespace: a name may only be used once across vars and bindings.
  const seen = new Map<string, string>()
  for (const [kind, names] of [["vars", Object.keys(vars)], ["kv", kv], ["d1", d1]] as const) {
    for (const name of names) {
      const prev = seen.get(name)
      if (prev) throw new Error(`binding "${name}" is defined twice (${prev} and ${kind})`)
      seen.set(name, kind)
    }
  }

  const assets = assetsOf(obj.assets, dir, warnings)
  if (assets?.binding) {
    const prev = seen.get(assets.binding)
    if (prev) throw new Error(`binding "${assets.binding}" is defined twice (${prev} and assets)`)
  }

  let main: string | null
  if (obj.main !== undefined) {
    if (typeof obj.main !== "string") throw new Error("main must be a string")
    main = resolveMainInside(dir, obj.main)
    if (!existsSync(join(dir, main))) warnings.push(`main "${main}" does not exist yet`)
  } else if (assets) {
    // Like wrangler: with assets and no main it's an assets-only site; a stray index.js in the
    // folder must not silently turn into a worker.
    main = null
  } else {
    const found = findDefaultEntry(dir)
    if (found) main = found
    else {
      main = ""
      warnings.push(`no main set and none of ${DEFAULT_ENTRIES.join(", ")} exist`)
    }
  }

  if (main === null && assets) {
    // A route that can only be answered by a worker that doesn't exist: fail now, not with a 500 later.
    const rwf = assets.runWorkerFirst
    if (rwf === true || (Array.isArray(rwf) && rwf.some(p => !p.startsWith("!")))) {
      throw new Error("assets.run_worker_first needs a main (there is no worker to run first)")
    }
    if (assets.binding) warnings.push(`assets.binding "${assets.binding}" has no effect without a main`)
    if (crons.length) throw new Error("crons need a main (there is no worker to run them)")
  }

  return { main, assets, vars, kv, d1, crons, warnings }
}

export const loadFnProjectConfig = async (dir: string): Promise<FnProjectConfig> => {
  const root = resolve(dir)
  for (const name of CONFIG_FILES) {
    const path = join(root, name)
    const file = Bun.file(path)
    if (!(await file.exists())) continue
    const text = await file.text()
    let raw: unknown
    try {
      raw = name.endsWith(".toml") ? Bun.TOML.parse(text) : parseJsonc(text)
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`)
    }
    let cfg: Omit<FnProjectConfig, "source">
    try {
      cfg = normalizeFnConfig(raw, root, name)
    } catch (e) {
      const msg = (e as Error).message
      throw new Error(msg.startsWith(name) ? msg : `${name}: ${msg}`)
    }
    // Later candidates are not read; say so if they exist, since edits there would do nothing.
    const shadowed = CONFIG_FILES.slice(CONFIG_FILES.indexOf(name) + 1).filter(n => existsSync(join(root, n)))
    if (shadowed.length) cfg.warnings.push(`${name} takes precedence; ignoring ${shadowed.join(", ")}`)
    return { ...cfg, source: path }
  }
  return { ...normalizeFnConfig(undefined, root, null), source: null }
}
