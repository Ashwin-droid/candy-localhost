// Sandboxed launches. In root mode every server (and cron run) starts as its
// own transient systemd unit: the whole filesystem is read-only except the
// server's code folder, its state folder and a private /tmp. The unit is bound
// to the candy service, so it goes down with the daemon. It keeps the owner's
// UID and the host network (no isolated UID, no inbound filtering).

import { dirname, isAbsolute, normalize, resolve } from "node:path"

export const STATE_ROOT = "/var/lib/candy"
export const SANDBOX_SLICE = "candy.slice"
export const MAX_RW_PATHS = 16

// "wa" -> "candy-wa-3f9a1c.service". Names are DNS-safe labels already; the
// suffix keeps a restart from colliding with a unit that is still stopping.
export const unitName = (name: string, kind: "srv" | "cron" = "srv"): string => {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map(b => b.toString(16).padStart(2, "0")).join("")
  return `candy-${kind === "cron" ? "cron-" : ""}${safe}-${rand}.service`
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
  env: Record<string, string | undefined>
  script: string            // run as: bash -ic <script> [candy <args...>]
  args?: string[]
  mode: "pty" | "pipe"      // pty for servers, pipe for cron runs
  bindsTo?: string | null   // the candy daemon's own unit
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
    "TimeoutStopSec=10",
  ]
  // ...and the code folder, plus any extra paths the owner listed. A folder
  // under /tmp is hidden by the private /tmp, so it is bound back in instead.
  for (const path of [spec.codeDir, ...(spec.extraRw ?? [])]) {
    const tmp = isUnder(path, "/tmp") || isUnder(path, "/var/tmp")
    props.push(tmp ? `BindPaths=${path}` : `ReadWritePaths=${path}`)
  }
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
    `--description=candy ${spec.mode === "pty" ? "server" : "cron run"}: ${spec.name}`,
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
