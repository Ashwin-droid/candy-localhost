// Sandboxed launches. In root mode every server (and cron run) starts as its
// own transient systemd unit: the whole filesystem is read-only except the
// server's code folder, its state folder and a private /tmp. The unit is bound
// to the candy service, so it goes down with the daemon. It keeps the owner's
// UID and the host network (no isolated UID, no inbound filtering).

import { dirname, isAbsolute, normalize, resolve } from "node:path"

export const STATE_ROOT = "/var/lib/candy"
export const SANDBOX_SLICE = "candy.slice"
export const MAX_RW_PATHS = 16

// Memory: every unit gets a hard limit. 2G unless the site has its own
// (candy mem), and never more than 16G whatever is asked for.
export const DEFAULT_MEMORY_MB = 2048
export const MAX_MEMORY_MB = 16 * 1024
export const MIN_MEMORY_MB = 64

/** A memory limit in MB from a number (MB) or text like "4G", "512M", "1.5g". Null when it isn't one or is outside 64M-16G. */
export const validateMemoryMb = (value: unknown): number | null => {
  let mb: number
  if (typeof value === "number") mb = value
  else if (typeof value === "string") {
    const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([mg])(?:i?b)?$/i)
    if (!m) return null
    mb = Number(m[1]) * (m[2].toLowerCase() === "g" ? 1024 : 1)
  } else return null
  if (!Number.isFinite(mb)) return null
  mb = Math.round(mb)
  return mb >= MIN_MEMORY_MB && mb <= MAX_MEMORY_MB ? mb : null
}

/** The limit a unit runs with: the site's own if valid, else the default; capped at 16G even if a bad value got into the config. */
export const memoryLimitMb = (configured: unknown): number =>
  Math.min(validateMemoryMb(configured) ?? DEFAULT_MEMORY_MB, MAX_MEMORY_MB)

/** "2G", "512M", "1.5G" */
export const formatMemory = (mb: number): string => mb >= 1024 && mb % 512 === 0 ? `${mb / 1024}G` : `${mb}M`

/** systemd properties for a limit: RAM capped, and no swap to spill into */
export const memoryProperties = (mb: number): string[] => [`MemoryMax=${mb}M`, "MemorySwapMax=0"]

// "wa" -> "candy-wa-3f9a1c.service". Names are DNS-safe labels already; the
// suffix keeps a restart from colliding with a unit that is still stopping.
export const unitName = (name: string, kind: "srv" | "cron" | "fn" = "srv"): string => {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, "0")).join("")
  return `candy-${kind === "srv" ? "" : `${kind}-`}${safe}-${rand}.service`
}

// StateDirectory= value (relative to /var/lib) and the resulting path
export const stateDirName = (name: string): string => `candy/${name.replace(/[^A-Za-z0-9_.-]/g, "_")}`
export const stateDirPath = (name: string): string => `/var/lib/${stateDirName(name)}`

// The folder a server may write to: the repository its start folder is in
// (nearest ancestor holding a .git), or the start folder itself. Never the
// user's whole home or anything above it, so a dotfiles repo in ~ doesn't
// make the home writable.
export const findCodeDir = (cwd: string, home: string, hasGit: (dir: string) => boolean): string => {
  const start = resolve(cwd)
  const homeDir = resolve(home)
  let dir = start
  for (let i = 0; i < 64; i++) {
    if (dir === "/" || dir === homeDir || homeDir.startsWith(dir.endsWith("/") ? dir : dir + "/")) break
    if (hasGit(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

// An extra writable path: absolute, already normal, and not a whole tree root
export const validateRwPath = (path: unknown): string | null => {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) return null
  const clean = normalize(path).replace(/\/+$/, "") || "/"
  if (clean !== path.replace(/\/+$/, "")) return null  // no "..", "//" or "."
  if (["/", "/home", "/root", "/etc", "/usr", "/var", "/run", "/proc", "/sys", "/dev", "/boot"].includes(clean)) return null
  return clean
}

const isUnder = (path: string, parent: string) => path === parent || path.startsWith(parent + "/")

export interface SandboxSpec {
  name: string
  unit: string
  uid: number
  gid: number
  cwd: string
  codeDir: string
  extraRw?: string[]
  memoryMb?: number | null  // the site's own memory limit (default 2G, at most 16G)
  envFile?: string | null   // read by systemd itself, so it may be unreadable to the server's user
  env: Record<string, string | undefined>
  script: string            // run as: bash -ic <script> [candy <args...>]
  args?: string[]
  mode: "pty" | "pipe"      // pty for servers, pipe for cron runs and function instances
  bindsTo?: string | null   // the candy daemon's own unit
  // Functions: the daemon's socket the instance dials in on (bound into the
  // unit), and the code folder stays read-only. Deploy snapshots under the
  // state folder are read-only too; the rest of the state folder is writable.
  fn?: { socket?: string | null } | null
  description?: string
}

// What the app is told about its writable places. Caches that normally land
// in the (now read-only) home are pointed at the state folder. Only caches:
// redirecting real data locations (XDG state/data/config) would make an app
// silently start from empty instead of failing where its data is.
export const sandboxEnv = (name: string): Record<string, string> => {
  const state = stateDirPath(name)
  return {
    CANDY_STATE_DIR: state,
    XDG_CACHE_HOME: `${state}/cache`,
    BUN_INSTALL_CACHE_DIR: `${state}/cache/bun`,
    npm_config_cache: `${state}/cache/npm`,
  }
}

export const FN_STOP_TIMEOUT_S = 35

export const sandboxProperties = (spec: SandboxSpec): string[] => {
  const props = [
    // Everything read-only...
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    // ...except the state folder (created and owned by the server's user) and a private /tmp
    `StateDirectory=${stateDirName(spec.name)}`,
    "StateDirectoryMode=0700",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "RestrictRealtime=yes",
    "SystemCallArchitectures=native",
    "KeyringMode=private",
    // A function gets its 30s waitUntil grace (fn-host SHUTDOWN_WAIT_MS) before SIGKILL
    `TimeoutStopSec=${spec.fn ? FN_STOP_TIMEOUT_S : 10}`,
    // A hard memory limit: past it the kernel kills the unit, not the machine
    ...memoryProperties(memoryLimitMb(spec.memoryMb)),
  ]
  // ...and the code folder, plus any extra paths the owner listed. A folder
  // under /tmp is hidden by the private /tmp, so it is bound back in instead.
  // A function only reads its code; it writes to its state folder.
  for (const path of [...(spec.fn ? [] : [spec.codeDir]), ...(spec.extraRw ?? [])]) {
    const tmp = isUnder(path, "/tmp") || isUnder(path, "/var/tmp")
    props.push(tmp ? `BindPaths=${path}` : `ReadWritePaths=${path}`)
  }
  if (spec.fn) {
    // A function's code under /tmp would be hidden by the private /tmp: bind it back, read-only
    if (isUnder(spec.codeDir, "/tmp") || isUnder(spec.codeDir, "/var/tmp")) props.push(`BindReadOnlyPaths=${spec.codeDir}`)
    // Snapshots are immutable once built. The daemon creates deploys/ before
    // any launch, so this always applies (code can't plant snapshots first).
    props.push(`ReadOnlyPaths=${stateDirPath(spec.name)}/deploys`)
    if (spec.fn.socket) props.push(`BindPaths=${spec.fn.socket}`)
  }
  if (spec.envFile) props.push(`EnvironmentFile=${spec.envFile}`)
  if (spec.bindsTo) props.push(`BindsTo=${spec.bindsTo}`, `After=${spec.bindsTo}`)
  return props
}

// The full systemd-run command line
export const systemdRunCommand = (spec: SandboxSpec): string[] => {
  const env = { ...spec.env, ...sandboxEnv(spec.name) }
  const cmd = [
    "systemd-run", "--quiet", "--collect", "--wait",
    spec.mode === "pty" ? "--pty" : "--pipe",
    `--unit=${spec.unit}`,
    `--slice=${SANDBOX_SLICE}`,
    "--service-type=exec",
    `--uid=${spec.uid}`, `--gid=${spec.gid}`,
    `--working-directory=${spec.cwd}`,
    `--description=candy ${spec.description ?? (spec.mode === "pty" ? "server" : "cron run")}: ${spec.name}`,
  ]
  for (const prop of sandboxProperties(spec)) cmd.push(`--property=${prop}`)
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) cmd.push(`--setenv=${key}=${value}`)
  }
  cmd.push("--", "bash", "-ic", spec.script, ...(spec.args?.length ? ["candy", ...spec.args] : []))
  return cmd
}

// The unit a PID belongs to, from the text of /proc/<pid>/cgroup
export const unitOfCgroup = (cgroupText: string): string | null => {
  const path = cgroupText.split("\n").find(line => line.startsWith("0::"))?.slice(3).trim()
  const last = path?.split("/").pop()
  return last && last.endsWith(".service") ? last : null
}

// ---------------------------------------------------------------------------
// Env files
// ---------------------------------------------------------------------------

// Root puts a file under /etc/candy/env/<user>/ to hand it to that user's
// servers without the user being able to read it.
export const ENV_FILE_ROOT = "/etc/candy/env"
export const userEnvDir = (user: string): string => `${ENV_FILE_ROOT}/${user}`

// An env file path: absolute and already normal. Returns the clean path or null.
export const validateEnvFilePath = (path: unknown): string | null => {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path)) return null
  return normalize(path) === path && !path.endsWith("/") ? path : null
}

// KEY=VALUE lines, the way systemd's EnvironmentFile reads them (near enough):
// blank lines and # comments are skipped, an optional "export " is dropped,
// matching quotes around the value are removed, nothing is expanded.
export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2]
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1)
    out[m[1]] = value
  }
  return out
}
