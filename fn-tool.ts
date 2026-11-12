// Work the daemon does on a function's files, run as the function's user.
// In root mode the daemon never reads, bundles or opens anything in a
// function's folder or state dir itself: a symlink planted there would make
// root follow it. It runs `bun fn-tool.ts <op>` through setpriv instead, with
// the op's JSON on stdin and `{ok, result|error}` JSON on stdout. In user
// mode the daemon calls runFnTool() in-process.

import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { mkdirSync } from "node:fs"
import type { DeployInfo } from "./fn-deploy.ts"
import type { FnProjectConfig } from "./fn-config.ts"
import { validateRunWorkerFirst, type AssetsConfig, type AssetsRouting } from "./fn-assets.ts"

export type FnToolOp = "config" | "deploy" | "deploys" | "resolve" | "prune" | "kv" | "d1"
export const FN_TOOL_OPS: readonly FnToolOp[] = ["config", "deploy", "deploys", "resolve", "prune", "kv", "d1"]

// Results of a few ops are capped so a runaway list or query can't flood the daemon
const KV_LIST_LIMIT = 1000
const D1_MAX_ROWS = 10_000

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${what} is required`)
  return v
}

// ---------------------------------------------------------------------------
// Checking what came back. In root mode the tool runs as the function's user,
// who controls that process (their own bun, their own files), so the daemon
// treats its output as untrusted: ids must be deploy ids, strings must be
// free of control characters (they reach audit lines, the portal and argv).
// ---------------------------------------------------------------------------

const CONTROL = /[\x00-\x1f\x7f]/
const DEPLOY_ID = /^\d{14}-[0-9a-f]{8}$/
const BINDING = /^[A-Z_][A-Z0-9_]{0,63}$/i
const MAX_DEPLOYS = 1000

const NOT_FOUND = ["none", "404-page", "single-page-application"]
const HTML = ["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"]

const plain = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length <= max && !CONTROL.test(v)
// Absolute and already normalized, so no "..", "//" or trailing "/" can move it after the check
const absPath = (v: unknown): v is string => plain(v) && v.startsWith("/") && (v === "/" || (normalize(v) === v && !v.endsWith("/")))
const strictlyInside = (base: string, p: string) => {
  const rel = relative(base, p)
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)
}

// `dir` (the project folder the daemon asked about), when given, is what assets.directory must sit
// inside; without it the config file's folder is used.
export const checkAssetsConfig = (v: unknown, dir: string | null): AssetsConfig => {
  const routing = checkAssetsRouting(v)
  const a = v as Record<string, unknown>
  if (!absPath(a.directory) || dir === null || !strictlyInside(dir, a.directory)) throw new Error("fn-tool config: bad assets.directory")
  return { directory: a.directory, ...routing }
}

// The routing keys alone: what a deploy's manifest records and the daemon then serves a pinned
// deploy with, so they get the same checks as the live config.
export const checkAssetsRouting = (v: unknown): AssetsRouting => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("fn-tool config: bad assets")
  const a = v as Record<string, unknown>
  if (!(a.binding === null || (typeof a.binding === "string" && BINDING.test(a.binding)))) throw new Error("fn-tool config: bad assets.binding")
  if (typeof a.notFound !== "string" || !NOT_FOUND.includes(a.notFound)) throw new Error("fn-tool config: bad assets.notFound")
  if (typeof a.html !== "string" || !HTML.includes(a.html)) throw new Error("fn-tool config: bad assets.html")
  let runWorkerFirst: boolean | string[]
  try {
    runWorkerFirst = validateRunWorkerFirst(a.runWorkerFirst)
  } catch {
    throw new Error("fn-tool config: bad assets.runWorkerFirst")
  }
  if (Array.isArray(runWorkerFirst) && !runWorkerFirst.every(p => plain(p, 1000))) throw new Error("fn-tool config: bad assets.runWorkerFirst")
  return { binding: a.binding as string | null, notFound: a.notFound as AssetsConfig["notFound"], html: a.html as AssetsConfig["html"], runWorkerFirst }
}

// `stateDir`, when given, pins the snapshot to <stateDir>/deploys/<id>.
export const checkDeployInfo = (v: unknown, stateDir?: string): DeployInfo | null => {
  if (!v || typeof v !== "object") return null
  const d = v as Record<string, unknown>
  if (typeof d.id !== "string" || !DEPLOY_ID.test(d.id)) return null
  if (!Number.isFinite(d.createdAt) || !Number.isFinite(d.size)) return null
  if (!absPath(d.dir) || !plain(d.source) || !plain(d.main)) return null
  // The snapshot dir is deploys/<id>; worker.js and assets/ are fixed names inside it
  if (d.dir !== join(dirname(dirname(d.dir)), "deploys", d.id)) return null
  if (stateDir !== undefined && d.dir !== join(stateDir, "deploys", d.id)) return null
  const entry = d.entry ?? null
  const assets = d.assets ?? null
  if (entry !== null && entry !== join(d.dir, "worker.js")) return null
  if (assets !== null && assets !== join(d.dir, "assets")) return null
  if (entry === null && assets === null) return null
  // Recorded routing (newer manifests only): checked like the live config, and only meaningful with assets
  let assetsConfig: AssetsRouting | undefined
  if (d.assetsConfig !== undefined && d.assetsConfig !== null) {
    if (assets === null) return null
    try {
      assetsConfig = checkAssetsRouting(d.assetsConfig)
    } catch {
      return null
    }
  }
  if (d.gitRev !== null && d.gitRev !== undefined && !(typeof d.gitRev === "string" && /^[0-9a-f]{4,64}$/.test(d.gitRev))) return null
  const info: DeployInfo = {
    id: d.id, createdAt: d.createdAt as number, entry: entry as string | null, dir: d.dir, source: d.source,
    gitRev: (d.gitRev as string | null | undefined) ?? null, size: d.size as number, main: d.main,
    assets: assets as string | null,
  }
  if (assetsConfig) info.assetsConfig = assetsConfig
  return info
}

export const checkProjectConfig = (v: unknown, dir?: string): FnProjectConfig => {
  if (!v || typeof v !== "object") throw new Error("fn-tool config: bad result")
  const c = v as Record<string, unknown>
  if (!(c.main === null || c.main === "" || plain(c.main, 1024))) throw new Error("fn-tool config: bad main")
  if (!(c.source === null || c.source === undefined || absPath(c.source))) throw new Error("fn-tool config: bad source")
  const projectDir = dir !== undefined ? resolve(dir) : typeof c.source === "string" ? dirname(c.source) : null
  if (dir !== undefined && typeof c.source === "string" && dirname(c.source) !== projectDir) throw new Error("fn-tool config: bad source")
  const assets = c.assets === null || c.assets === undefined ? null : checkAssetsConfig(c.assets, projectDir)
  // main is null only for an assets-only project
  if (c.main === null && !assets) throw new Error("fn-tool config: bad main")
  const vars: Record<string, string> = {}
  if (c.vars && typeof c.vars === "object" && !Array.isArray(c.vars)) {
    for (const [k, x] of Object.entries(c.vars)) {
      if (!BINDING.test(k) || typeof x !== "string") throw new Error(`fn-tool config: bad var ${JSON.stringify(k).slice(0, 80)}`)
      vars[k] = x
    }
  }
  const names = (x: unknown, what: string): string[] => {
    if (x === undefined) return []
    if (!Array.isArray(x) || x.length > 100 || !x.every(n => typeof n === "string" && BINDING.test(n))) throw new Error(`fn-tool config: bad ${what}`)
    return x as string[]
  }
  const crons = c.crons === undefined ? [] : c.crons
  if (!Array.isArray(crons) || crons.length > 100 || !crons.every(x => plain(x, 256))) throw new Error("fn-tool config: bad crons")
  const warnings = Array.isArray(c.warnings)
    ? c.warnings.slice(0, 100).map(w => String(w).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000))
    : []
  return { main: c.main as string | null, assets, vars, kv: names(c.kv, "kv"), d1: names(c.d1, "d1"), crons: crons as string[], warnings, source: (c.source ?? null) as string | null }
}

// The result of `op`, checked; throws on anything the daemon must not use
// `args` (the op's own arguments, optional) tightens the path checks to the dirs the daemon asked about.
export const checkToolResult = (op: FnToolOp, v: unknown, args?: Record<string, unknown>): unknown => {
  const stateDir = typeof args?.stateDir === "string" ? args.stateDir : undefined
  switch (op) {
    case "config": return checkProjectConfig(v, typeof args?.dir === "string" ? args.dir : undefined)
    case "deploy": {
      const d = checkDeployInfo(v, stateDir)
      if (!d) throw new Error("fn-tool deploy: bad deploy info")
      return d
    }
    case "resolve": {
      if (v === null || v === undefined) return null
      const d = checkDeployInfo(v, stateDir)
      if (!d) throw new Error("fn-tool resolve: bad deploy info")
      return d
    }
    case "deploys":
      if (!Array.isArray(v)) throw new Error("fn-tool deploys: bad result")
      return v.slice(0, MAX_DEPLOYS).map(d => checkDeployInfo(d, stateDir)).filter((d): d is DeployInfo => d !== null)
    default:
      return v
  }
}

export const runFnTool = async (op: string, a: Record<string, any>): Promise<unknown> => {
  switch (op) {
    case "config": {
      // The project config, with an explicit entry (from /fn/add) checked the same way main is
      const { loadFnProjectConfig, resolveMainInside } = await import("./fn-config.ts")
      const dir = str(a.dir, "dir")
      const cfg = await loadFnProjectConfig(dir)
      if (typeof a.entry === "string" && a.entry) cfg.main = resolveMainInside(dir, a.entry)
      return cfg
    }
    case "deploy": {
      const { bundleDeploy } = await import("./fn-deploy.ts")
      const srcDir = str(a.srcDir, "srcDir")
      // Assets come from the project config read here, as this user, unless the daemon passed
      // the (already checked) config; main may then be null for an assets-only project.
      let assets: AssetsConfig | null
      if (a.assets === undefined) {
        const { loadFnProjectConfig } = await import("./fn-config.ts")
        assets = (await loadFnProjectConfig(srcDir)).assets
      } else {
        assets = a.assets === null ? null : checkAssetsConfig(a.assets, resolve(srcDir))
      }
      const main = typeof a.main === "string" && a.main ? a.main : null
      if (!main && !assets) throw new Error("main is required")
      return bundleDeploy({ name: str(a.name, "name"), srcDir, main, stateDir: str(a.stateDir, "stateDir"), assets })
    }
    case "deploys": {
      const { listDeploys } = await import("./fn-deploy.ts")
      return listDeploys(str(a.stateDir, "stateDir"))
    }
    case "resolve": {
      const { resolveDeploy } = await import("./fn-deploy.ts")
      return resolveDeploy(str(a.stateDir, "stateDir"), str(a.id, "id"))
    }
    case "prune": {
      const { pruneDeploys } = await import("./fn-deploy.ts")
      const keep = Number.isInteger(a.keep) && a.keep > 0 ? a.keep : 10
      return pruneDeploys(str(a.stateDir, "stateDir"), keep, typeof a.pinned === "string" ? a.pinned : undefined)
    }
    case "kv": {
      const { createKV, closeBindings } = await import("./fn-bindings.ts")
      const { BINDING_NAME } = await import("./fn-config.ts")
      const stateDir = str(a.stateDir, "stateDir")
      const binding = str(a.binding, "binding")
      if (!BINDING_NAME.test(binding)) throw new Error(`invalid binding name "${binding}"`)
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const kv = createKV(join(stateDir, "kv.sqlite"), binding)
      try {
        switch (a.op) {
          case "get": return { value: await kv.get(str(a.key, "key"), "text") }
          case "put": {
            if (typeof a.value !== "string") throw new Error("value must be a string")
            await kv.put(str(a.key, "key"), a.value)
            return { success: true }
          }
          case "delete": await kv.delete(str(a.key, "key")); return { success: true }
          case "list": {
            const limit = Number.isInteger(a.limit) ? Math.max(1, Math.min(a.limit, KV_LIST_LIMIT)) : KV_LIST_LIMIT
            return kv.list({ prefix: typeof a.prefix === "string" ? a.prefix : undefined, limit, cursor: typeof a.cursor === "string" ? a.cursor : undefined })
          }
          default: throw new Error("op must be get, put, list or delete")
        }
      } finally {
        closeBindings({ kv })
      }
    }
    case "d1": {
      const { createD1, closeBindings } = await import("./fn-bindings.ts")
      const { BINDING_NAME } = await import("./fn-config.ts")
      const stateDir = str(a.stateDir, "stateDir")
      const binding = str(a.binding, "binding")
      if (!BINDING_NAME.test(binding)) throw new Error(`invalid binding name "${binding}"`)
      const sql = str(a.sql, "sql")
      const params = a.params === undefined ? [] : a.params
      if (!Array.isArray(params)) throw new Error("params must be an array")
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const db = createD1(join(stateDir, `d1-${binding}.sqlite`))
      try {
        const res = await db.prepare(sql).bind(...params).all()
        if (res.results.length > D1_MAX_ROWS) return { ...res, results: res.results.slice(0, D1_MAX_ROWS), truncated: true }
        return res
      } finally {
        closeBindings({ db })
      }
    }
    default:
      throw new Error(`unknown fn-tool op "${op}"`)
  }
}

if (import.meta.main) {
  const op = process.argv[2] ?? ""
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n")
  try {
    const text = await new Response(Bun.stdin.stream()).text()
    const args = text.trim() ? JSON.parse(text) : {}
    out({ ok: true, result: (await runFnTool(op, args)) ?? null })
    process.exit(0)
  } catch (e) {
    out({ ok: false, error: e instanceof Error ? e.message : String(e) })
    process.exit(1)
  }
}
