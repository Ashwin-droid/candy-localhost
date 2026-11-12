// Deploy snapshots for candy functions: bundle the entry with Bun.build and copy the static
// assets into an immutable <stateDir>/deploys/<id>/ dir that the sandbox mounts read-only.

import { realpathSync } from "node:fs"
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { MANIFEST_NAME, snapshotAssets, type AssetsConfig, type AssetsRouting } from "./fn-assets.ts"

export interface DeployInfo {
  id: string
  createdAt: number      // epoch ms
  entry: string | null   // absolute path of worker.js; null for an assets-only deploy
  dir: string            // absolute snapshot dir
  source: string         // absolute source dir the bundle was built from
  gitRev: string | null
  size: number           // worker.js bytes (0 without a worker)
  main: string           // entry as given, relative to source ("" without a worker)
  assets: string | null  // absolute path of <dir>/assets; null when the project has no assets
  // The routing config the deploy was made with, so a pinned deploy (and a rollback) routes like it
  // did then. Absent for deploys without assets or with a manifest that didn't record it.
  assetsConfig?: AssetsRouting
}

interface Manifest {
  id: string
  createdAt: number
  main: string | null
  source: string
  gitRev: string | null
  size: number
  files: string[]
  // Older manifests have no `assets` key: treated as null
  assets?: (Omit<AssetsConfig, "directory"> & { source: string; files: number; bytes: number }) | null
}

const ID_RE = /^\d{14}-[0-9a-f]{8}$/

export function isDeployId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id)
}

const deploysDir = (stateDir: string) => join(stateDir, "deploys")

// UTC so ids sort the same regardless of the daemon's timezone
function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

export async function gitRevOf(dir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--short", "HEAD"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const rev = out.trim()
    return code === 0 && /^[0-9a-f]{4,64}$/.test(rev) ? rev : null
  } catch {
    return null  // git not installed
  }
}

function formatBuildLogs(logs: readonly unknown[]): string {
  return logs.map(l => {
    const m = l as { message?: string; level?: string; position?: { file?: string; line?: number; column?: number } | null }
    const pos = m.position?.file ? ` (${m.position.file}:${m.position.line}:${m.position.column})` : ""
    return `${m.level ?? "error"}: ${m.message ?? String(l)}${pos}`
  }).join("\n")
}

// Make a snapshot writable again so it can be renamed over or removed.
// Recursive because assets/ is a read-only tree; symlinks are never followed.
async function unlock(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => {})
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await unlock(p)
    else if (e.isFile()) await chmod(p, 0o644).catch(() => {})
  }
}

const strictlyInside = (base: string, p: string) => {
  const rel = relative(base, p)
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)
}

async function removeSnapshot(dir: string): Promise<void> {
  await unlock(dir)
  await rm(dir, { recursive: true, force: true })
}

export async function bundleDeploy(opts: { name: string; srcDir: string; main: string | null; stateDir: string; gitRev?: string | null; assets?: AssetsConfig | null }): Promise<DeployInfo> {
  const source = resolve(opts.srcDir)
  const assets = opts.assets ?? null
  let mainAbs: string | null = null
  let rel: string | null = null
  if (opts.main) {
    mainAbs = resolve(source, opts.main)
    rel = relative(source, mainAbs)
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`fn ${opts.name}: main "${opts.main}" is outside ${source}`)
  } else if (!assets) {
    throw new Error(`fn ${opts.name}: nothing to deploy (no main and no assets)`)
  }
  if (assets) {
    // Same rule as fn-config: a subfolder of the source, symlinks included
    const dir = resolve(assets.directory)
    if (!strictlyInside(source, dir)) throw new Error(`fn ${opts.name}: assets directory ${assets.directory} is outside ${source}`)
    let real: string
    try {
      real = realpathSync(dir)
    } catch {
      throw new Error(`fn ${opts.name}: assets directory ${assets.directory} does not exist`)
    }
    if (!strictlyInside(realpathSync(source), real)) throw new Error(`fn ${opts.name}: assets directory ${assets.directory} is a symlink that leaves ${source}`)
  }

  const root = deploysDir(opts.stateDir)
  await mkdir(root, { recursive: true })
  // Temp dir inside deploys/ so the final rename stays on one filesystem
  const tmp = join(root, `.tmp-${crypto.randomUUID()}`)
  await mkdir(tmp)
  try {
    let code: Buffer = Buffer.alloc(0)
    if (mainAbs) code = await build(opts.name, mainAbs, tmp)

    const hasher = new Bun.CryptoHasher("sha256").update(code)
    let assetsInfo: Manifest["assets"] = null
    if (assets) {
      const snap = await snapshotAssets(assets, join(tmp, "assets"))
      const am = JSON.parse(await readFile(snap.manifestPath, "utf8")) as { files: Record<string, { hash: string }>; headers: unknown; redirects: unknown }
      const { directory, ...routing } = assets
      assetsInfo = { ...routing, source: directory, files: snap.files, bytes: snap.bytes }
      // The id covers the files, the parsed _headers/_redirects and the routing config, so a change
      // to any of them is a new snapshot. Files sorted so walk order can't change the id.
      const files = Object.entries(am.files).map(([p, f]) => `${p}:${f.hash}`).sort()
      hasher.update("\0assets\0" + JSON.stringify({ routing, files, headers: am.headers, redirects: am.redirects }))
    }

    const files = (await readdir(tmp)).sort()
    const sha8 = hasher.digest("hex").slice(0, 8)
    const now = new Date()
    const id = `${stamp(now)}-${sha8}`
    const manifest: Manifest = {
      id,
      createdAt: now.getTime(),
      main: rel,
      source,
      gitRev: opts.gitRev === undefined ? await gitRevOf(source) : opts.gitRev,
      size: code.byteLength,
      files: [...files, "manifest.json"].sort(),
      assets: assetsInfo,
    }
    await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

    const dir = join(root, id)
    // Same content in the same second: the existing snapshot is identical, reuse it
    const existing = await resolveDeploy(opts.stateDir, id)
    if (existing) {
      await removeSnapshot(tmp)
      return existing
    }

    // assets/ is already read-only (snapshotAssets); everything else at the top level is a file
    for (const f of manifest.files) if (f !== "assets") await chmod(join(tmp, f), 0o444)
    await chmod(tmp, 0o555)
    await rename(tmp, dir)
    return toInfo(manifest, dir)
  } catch (e) {
    await removeSnapshot(tmp).catch(() => {})
    throw e
  }
}

// Bun.build into `out` as a single worker.js (+ map); returns the code.
async function build(name: string, mainAbs: string, out: string): Promise<Buffer> {
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build({
      entrypoints: [mainAbs],
      outdir: out,
      naming: "worker.[ext]",
      target: "bun",
      sourcemap: "linked",
      minify: false,
      throw: false,
    })
  } catch (e: any) {
    // Older Bun throws an AggregateError instead of returning logs
    const logs = e?.errors ? formatBuildLogs(e.errors) : String(e?.message ?? e)
    throw new Error(`fn ${name}: build failed\n${logs}`)
  }
  if (!result.success) throw new Error(`fn ${name}: build failed\n${formatBuildLogs(result.logs)}`)

  // Runs before the assets snapshot, so out/ holds only the build output here
  const files = (await readdir(out)).sort()
  if (!files.includes("worker.js")) throw new Error(`fn ${name}: build produced no worker.js (got ${files.join(", ") || "nothing"})`)
  const extra = files.filter(f => f !== "worker.js" && f !== "worker.js.map")
  if (extra.length) throw new Error(`fn ${name}: build produced extra files (${extra.join(", ")}); a deploy must be a single worker.js`)
  return readFile(join(out, "worker.js"))
}

const hasWorker = (m: Manifest) => !!m.main && m.files.includes("worker.js")
const hasAssets = (m: Manifest) => !!m.assets && m.files.includes("assets")

// Only the four routing keys, passed as recorded (fn-tool's checkDeployInfo validates them); an
// incomplete record is left out so the daemon falls back to the live config.
function recordedRouting(a: Manifest["assets"]): AssetsRouting | undefined {
  if (!a || !("binding" in a && "notFound" in a && "html" in a && "runWorkerFirst" in a)) return undefined
  return { binding: a.binding, notFound: a.notFound, html: a.html, runWorkerFirst: a.runWorkerFirst }
}

function toInfo(m: Manifest, dir: string): DeployInfo {
  const info: DeployInfo = {
    id: m.id, createdAt: m.createdAt, entry: hasWorker(m) ? join(dir, "worker.js") : null, dir, source: m.source,
    gitRev: m.gitRev ?? null, size: m.size, main: m.main ?? "", assets: hasAssets(m) ? join(dir, "assets") : null,
  }
  const routing = hasAssets(m) ? recordedRouting(m.assets) : undefined
  if (routing) info.assetsConfig = routing
  return info
}

export async function resolveDeploy(stateDir: string, id: string): Promise<DeployInfo | null> {
  // The id becomes a path segment, so only the exact generated shape is allowed
  if (!isDeployId(id)) return null
  const dir = join(deploysDir(stateDir), id)
  try {
    const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest
    if (m.id !== id || !Array.isArray(m.files)) return null
    if (!hasWorker(m) && !hasAssets(m)) return null
    if (hasWorker(m)) await stat(join(dir, "worker.js"))
    if (hasAssets(m) && !(await stat(join(dir, "assets"))).isDirectory()) return null
    if (hasAssets(m)) await stat(join(dir, MANIFEST_NAME))
    return toInfo(m, dir)
  } catch {
    return null
  }
}

export async function listDeploys(stateDir: string): Promise<DeployInfo[]> {
  const names = await readdir(deploysDir(stateDir)).catch(() => [] as string[])
  const infos = (await Promise.all(names.filter(isDeployId).map(id => resolveDeploy(stateDir, id))))
    .filter((d): d is DeployInfo => d !== null)
  return infos.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

// Keeps the newest `keep` snapshots plus `pinned`; returns the removed ids.
// Leftover .tmp- dirs from interrupted builds are cleaned up too.
export async function pruneDeploys(stateDir: string, keep = 10, pinned?: string): Promise<string[]> {
  const root = deploysDir(stateDir)
  const removed: string[] = []
  for (const d of (await listDeploys(stateDir)).slice(Math.max(0, keep))) {
    if (d.id === pinned) continue
    await removeSnapshot(d.dir)
    removed.push(d.id)
  }
  const cutoff = Date.now() - 3600_000
  for (const n of await readdir(root).catch(() => [] as string[])) {
    if (!n.startsWith(".tmp-")) continue
    const s = await stat(join(root, n)).catch(() => null)
    // An hour old means no build is still writing into it
    if (s && s.mtimeMs < cutoff) await removeSnapshot(join(root, n)).catch(() => {})
  }
  return removed
}
