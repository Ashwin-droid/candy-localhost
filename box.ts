// Boxes: sandboxes a sandboxed site rents from candy for its own child processes (root mode).
// One box is one transient systemd unit running one process tree as the site's user, with its
// own memory, CPU and task limits, a private PID namespace, and only the folders the site
// granted it. It is bound to the site's unit, so it never outlives the site.
//
// Who decides what:
//   candy.json "boxes": true     the site says it wants boxes
//   the operator (candy boxes)   how many it may hold, and how much memory each may have
//   the site, per box            command, grants, limits within the operator's, extra isolation
//
// A box starts from the hardening every site gets (HARDENING in sandbox.ts) and hides more: the
// home folders, other sites' state, candy's own run folder. The site can add isolation
// (ISOLATION_PROPERTIES) and can never take any away: a line naming something candy sets is refused.
// Nothing on that list gives a box more of the machine (no CPUWeight, IOWeight or limits).
//
// This file is the checks and the systemd-run command line. box-run.ts runs one.

import { isAbsolute, normalize } from "node:path"
import { HARDENING, MAX_MEMORY_MB, MIN_MEMORY_MB, SANDBOX_SLICE, STATE_ROOT, formatMemory, memoryProperties, validateMemoryMb } from "./sandbox.ts"

/** The most boxes an operator can give one site */
export const MAX_BOXES = 64
export const MAX_BOX_GRANTS = 32
export const MAX_BOX_ISOLATION = 32
export const MAX_BOX_ARGS_BYTES = 128 * 1024
export const MAX_BOX_ENV_BYTES = 128 * 1024
export const MAX_BOX_ENV_VARS = 256
export const DEFAULT_BOX_TASKS = 1024
export const MAX_BOX_TASKS = 4096
/** A week: the longest lease a box can ask for */
export const MAX_BOX_SECONDS = 7 * 24 * 3600
/** PID 1 of a box ignores a TERM it has no handler for, so a stop may need the KILL after this long */
export const BOX_STOP_TIMEOUT_S = 5
export const BOX_RUN_DIR = "/run/candy/box"

/** What the operator allows a site: boxes at once, and memory for each */
export interface BoxQuota { max: number; memory: number }

/** The operator's setting as stored in a site's config, or null when it isn't one */
export const validateBoxQuota = (raw: unknown): BoxQuota | null => {
  if (!raw || typeof raw !== "object") return null
  const { max, memory } = raw as { max?: unknown; memory?: unknown }
  const mb = validateMemoryMb(memory)
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_BOXES || !mb) return null
  return { max, memory: mb }
}

/** `path` is where the box sees it: the path the site named. `source` is the real path behind it and `check` the device:inode found there, both filled in by the daemon. */
export interface BoxGrant { path: string; mode: "ro" | "rw"; source?: string; check?: string }

export interface BoxRequest {
  cmd: string[]                 // argv; cmd[0] is an absolute path as the box sees it
  cwd: string
  env: Record<string, string>
  grants: BoxGrant[]
  memory: number                // MB
  cpu: number | null            // percent of one core, e.g. 150
  tasks: number
  seconds: number | null        // the lease: stopped after this long
  isolation: string[]           // extra systemd properties, "Name=value"
  label: string | null          // the site's own name for it, shown in lists
}

// A path that is safe to put in a systemd property: absolute, already normal, and with nothing
// BindPaths= would read as syntax (it splits on spaces and colons)
export const boxPathProblem = (path: unknown, what: string): string | null => {
  if (typeof path !== "string" || !path || path.length > 1024) return `${what} must be an absolute path`
  if (!isAbsolute(path) || normalize(path) !== path || (path.length > 1 && path.endsWith("/"))) return `${what} must be an absolute path with no "..", "." or doubled or trailing slash: ${JSON.stringify(path.slice(0, 200))}`
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f:\\%$"'*?\[\]]/.test(path)) return `${what} can't contain spaces, control characters or any of : \\ % $ " ' * ? [ ]: ${JSON.stringify(path.slice(0, 200))}`
  return null
}

const isUnder = (path: string, parent: string) => parent === "/" || path === parent || path.startsWith(parent + "/")

/** Never grantable, whoever asks: whole trees, kernel filesystems, and candy's own run folder */
const GRANT_ROOTS = ["/", "/home", "/root", "/etc", "/usr", "/var", "/run", "/proc", "/sys", "/dev", "/boot", STATE_ROOT]
const GRANT_NEVER_UNDER = ["/proc", "/sys", "/dev", "/run"]
/** What a box does not see unless a grant puts it back */
export const BOX_HIDDEN = [STATE_ROOT, "/run/candy", "/mnt", "/media", "/srv"]
const BOX_HIDDEN_BY_HOME = ["/home", "/root", "/run/user"]

/** Names the box's first shell (BOX_INIT) can't take from a file: read-only in bash, or fatal in dash when not a number */
const SHELL_OWNED_ENV = ["UID", "EUID", "PPID", "SHELLOPTS", "BASHOPTS", "BASH_VERSINFO", "OPTIND"]

/** Extra isolation a site may put on a box: nothing here can undo what candy sets */
export const ISOLATION_PROPERTIES: readonly string[] = [
  "PrivateNetwork", "IPAddressDeny", "IPAddressAllow", "RestrictAddressFamilies", "SocketBindDeny", "SocketBindAllow",
  "SystemCallFilter", "SystemCallErrorNumber", "RestrictNamespaces", "MemoryDenyWriteExecute", "PrivateIPC", "RemoveIPC",
  "InaccessiblePaths", "ReadOnlyPaths", "NoExecPaths", "ExecPaths", "RestrictFileSystems", "ProtectProc", "ProcSubset",
  "UMask",
]

/** Why this "Name=value" line can't go on a box, or null */
export const isolationProblem = (line: unknown): string | null => {
  if (typeof line !== "string" || line.length > 2048) return "an isolation line is text like \"PrivateNetwork=yes\""
  const eq = line.indexOf("=")
  const name = eq > 0 ? line.slice(0, eq) : ""
  const shown = JSON.stringify(line.slice(0, 120))
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return `an isolation line is "Name=value": ${shown}`
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(line)) return `an isolation line can't hold control characters: ${shown}`
  if (ISOLATION_PROPERTIES.includes(name)) return null
  if (name === "MemoryMax" || name === "MemoryHigh" || name === "MemorySwapMax") return `${shown} is refused: set "memory" on the box instead`
  if (name === "CPUQuota") return `${shown} is refused: set "cpu" on the box instead`
  if (name === "TasksMax") return `${shown} is refused: set "tasks" on the box instead`
  if (name === "RuntimeMaxSec") return `${shown} is refused: set "seconds" on the box instead`
  if (name === "BindPaths" || name === "BindReadOnlyPaths" || name === "ReadWritePaths" || name === "TemporaryFileSystem") return `${shown} is refused: folders reach a box through "grants"`
  return `${shown} is refused: a box keeps everything its site's sandbox has, and extra isolation can only be one of ${ISOLATION_PROPERTIES.join(", ")}`
}

/**
 * A rent request as sent over /runtime/boxes, checked against the operator's quota. Paths are
 * checked for shape only: whether the site may grant them is grantProblem's job, on real paths.
 */
export const parseBoxRequest = (body: unknown, quota: BoxQuota): BoxRequest | { error: string } => {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const fail = (error: string) => ({ error })

  if (!Array.isArray(b.cmd) || b.cmd.length === 0 || b.cmd.length > 1024 || !b.cmd.every(a => typeof a === "string" && !a.includes("\0"))) return fail('"cmd" must be the command and its arguments, a list of text')
  const cmd = b.cmd as string[]
  if (!isAbsolute(cmd[0])) return fail(`"cmd" must start with the program's absolute path (as the box sees it), not ${JSON.stringify(cmd[0].slice(0, 200))}`)
  if (cmd.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0) > MAX_BOX_ARGS_BYTES) return fail(`"cmd" is more than ${MAX_BOX_ARGS_BYTES / 1024} KB`)

  const env: Record<string, string> = {}
  if (b.env !== undefined && b.env !== null) {
    if (typeof b.env !== "object" || Array.isArray(b.env)) return fail('"env" must be an object of text values')
    let bytes = 0
    for (const [key, value] of Object.entries(b.env as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return fail(`"env" has a name that isn't a variable name: ${JSON.stringify(key.slice(0, 80))}`)
      if (SHELL_OWNED_ENV.includes(key)) return fail(`"env" can't set ${key}: the shell that starts the box owns it`)
      // eslint-disable-next-line no-control-regex
      if (typeof value !== "string" || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return fail(`"env" value of ${key} must be text with no control characters (tabs and newlines are fine)`)
      bytes += key.length + Buffer.byteLength(value) + 2
      env[key] = value
    }
    if (Object.keys(env).length > MAX_BOX_ENV_VARS || bytes > MAX_BOX_ENV_BYTES) return fail(`"env" is more than ${MAX_BOX_ENV_VARS} variables or ${MAX_BOX_ENV_BYTES / 1024} KB`)
  }

  const grants: BoxGrant[] = []
  if (b.grants !== undefined && b.grants !== null) {
    if (!Array.isArray(b.grants) || b.grants.length > MAX_BOX_GRANTS) return fail(`"grants" must be a list of at most ${MAX_BOX_GRANTS} folders or files`)
    for (const g of b.grants as unknown[]) {
      const { path, mode } = (g && typeof g === "object" ? g : {}) as { path?: unknown; mode?: unknown }
      const problem = boxPathProblem(path, "a grant's path")
      if (problem) return fail(problem)
      if (mode !== "ro" && mode !== "rw") return fail(`the grant of ${path} needs "mode": "ro" or "rw"`)
      if (grants.some(x => x.path === path)) return fail(`${path} is granted twice`)
      grants.push({ path: path as string, mode })
    }
  }

  const cwd = b.cwd === undefined || b.cwd === null ? "/" : b.cwd
  const cwdProblem = boxPathProblem(cwd, '"cwd"')
  if (cwdProblem) return fail(cwdProblem)

  let memory = quota.memory
  if (b.memory !== undefined && b.memory !== null) {
    const mb = validateMemoryMb(b.memory)
    if (!mb) return fail(`"memory" must be between ${formatMemory(MIN_MEMORY_MB)} and ${formatMemory(MAX_MEMORY_MB)}, like "1G" or 512 (MB)`)
    if (mb > quota.memory) return fail(`"memory" ${formatMemory(mb)} is more than a box of this site may have (${formatMemory(quota.memory)})`)
    memory = mb
  }

  const whole = (key: string, min: number, max: number): number | null | { error: string } => {
    const v = b[key]
    if (v === undefined || v === null) return null
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fail(`"${key}" must be a whole number from ${min} to ${max}`)
    return v
  }
  const cpu = whole("cpu", 1, 6400)
  if (cpu && typeof cpu === "object") return cpu
  const tasks = whole("tasks", 1, MAX_BOX_TASKS)
  if (tasks && typeof tasks === "object") return tasks
  const seconds = whole("seconds", 1, MAX_BOX_SECONDS)
  if (seconds && typeof seconds === "object") return seconds

  const isolation: string[] = []
  if (b.isolation !== undefined && b.isolation !== null) {
    if (!Array.isArray(b.isolation) || b.isolation.length > MAX_BOX_ISOLATION) return fail(`"isolation" must be a list of at most ${MAX_BOX_ISOLATION} lines like "PrivateNetwork=yes"`)
    for (const line of b.isolation as unknown[]) {
      const problem = isolationProblem(line)
      if (problem) return fail(problem)
      isolation.push(line as string)
    }
  }

  let label: string | null = null
  if (b.label !== undefined && b.label !== null) {
    // eslint-disable-next-line no-control-regex
    if (typeof b.label !== "string" || b.label.length > 80 || /[\x00-\x1f\x7f]/.test(b.label)) return fail('"label" must be at most 80 characters of plain text')
    label = b.label
  }

  return { cmd, cwd: cwd as string, env, grants, memory, cpu: cpu as number | null, tasks: (tasks as number | null) ?? DEFAULT_BOX_TASKS, seconds: seconds as number | null, isolation, label }
}

/** What the renting site can reach, as real paths */
export interface BoxParent {
  /** Where the site itself may write: its code folder, state folder and "rw" paths. ["/"] for a site with no sandbox. */
  writable: string[]
  /** False when the site runs without the sandbox: then its /tmp is the machine's */
  privateTmp: boolean
  /** Where the CLI's credential is kept: never granted, on its own or inside a wider folder */
  secret?: string[]
}

/**
 * Why the site can't grant this (already real, symlink-free) path, or null. `canRead` is whether
 * the site's user could open it. A box gets at most what its site has: read-write only inside
 * what the site may write, read-only anywhere the site can read.
 */
export const grantProblem = (real: string, mode: "ro" | "rw", parent: BoxParent, canRead: boolean): string | null => {
  if (GRANT_ROOTS.includes(real)) return `${real} is a whole tree: grant the folders inside it that the box needs`
  if (GRANT_NEVER_UNDER.some(root => isUnder(real, root))) return `${real} can't be granted to a box`
  const secret = parent.secret?.find(s => isUnder(real, s) || isUnder(s, real))
  if (secret) return real === secret || isUnder(real, secret)
    ? `${real} can't be granted to a box: it holds candy's own credentials`
    : `${real} can't be granted to a box as a whole: ${secret} is inside it and holds candy's own credentials. Grant the folders the box needs`
  const inWritable = parent.writable.some(w => isUnder(real, w))
  // The site's /tmp is its own private one: the machine's /tmp isn't something it has
  if (parent.privateTmp && (isUnder(real, "/tmp") || isUnder(real, "/var/tmp")) && !inWritable) return `${real} is in the machine's /tmp, which this site doesn't see (it has a private one)`
  if (!canRead) return `${real} isn't something this site's user can read`
  if (mode === "rw" && !inWritable) return `${real} can't be granted read-write: this site can't write there itself (it writes in ${parent.writable.join(", ")})`
  return null
}

/** Why a box can't start in this folder, or null: it must be somewhere the box sees */
export const cwdProblem = (cwd: string, grants: BoxGrant[]): string | null => {
  if (grants.some(g => isUnder(cwd, g.path))) return null
  const hidden = [...BOX_HIDDEN, ...BOX_HIDDEN_BY_HOME, "/tmp", "/var/tmp"].find(h => isUnder(cwd, h))
  return hidden ? `"cwd" ${cwd} isn't in a granted folder, and the box doesn't see ${hidden}` : null
}

export interface BoxUnit {
  site: string
  unit: string
  uid: number
  gid: number
  parentUnit: string            // the site's own unit: the box is bound to it
  request: BoxRequest           // grants hold real paths by now
  hidden: string[]              // BOX_HIDDEN entries that exist on this machine
}

/** Every systemd property of a box. The site's lines come last and can't name anything above them. */
export const boxProperties = (box: BoxUnit): string[] => {
  const r = box.request
  const props = [
    ...HARDENING,
    // Nothing of the home folders, other sites' state or candy's run folder: only the grants
    "ProtectHome=tmpfs",
    ...box.hidden.map(path => `TemporaryFileSystem=${path}:ro`),
    // Its own process tree and nobody else's: no command lines or environments of the site
    "PrivatePIDs=yes",
    ...memoryProperties(r.memory),
    `TasksMax=${r.tasks}`,
    ...(r.cpu ? [`CPUQuota=${r.cpu}%`] : []),
    ...(r.seconds ? [`RuntimeMaxSec=${r.seconds}`] : []),
    // Out of memory ends the box as a whole, and is reported as that
    "OOMPolicy=stop",
    `TimeoutStopSec=${BOX_STOP_TIMEOUT_S}`,
    // Gone with the site: stopped, crashed, restarted or idled out
    `BindsTo=${box.parentUnit}`,
    `After=${box.parentUnit}`,
  ]
  const set = new Set(props.map(p => p.slice(0, p.indexOf("="))))
  // Bound from the real path to the path the site named, so the box sees the names its site uses
  for (const g of r.grants) props.push(`${g.mode === "rw" ? "BindPaths" : "BindReadOnlyPaths"}=${g.source && g.source !== g.path ? `${g.source}:${g.path}` : g.path}`)
  for (const line of r.isolation) {
    const name = line.slice(0, line.indexOf("="))
    // Checked at parse time too; here as well, because this is the line that reaches systemd as root
    if (!ISOLATION_PROPERTIES.includes(name) || set.has(name)) throw new Error(`isolation line refused: ${JSON.stringify(line.slice(0, 120))}`)
    props.push(line)
  }
  return props
}

/** The credential the box's environment travels in (LoadCredential=), read by BOX_INIT */
export const BOX_ENV_CREDENTIAL = "box-env"
/** BOX_INIT's exit code when a grant isn't what was checked, or the environment can't be read */
export const BOX_INIT_REFUSED = 125

// PID 1 of the box, run as: sh -c BOX_INIT candy-box [<dev:inode> <path>]... -- <command...>
//
// 1. The grants. The daemon checked each granted path and noted which file or folder it was
//    (device and inode). systemd binds by path a moment later, and the site can swap a folder for
//    a symlink in between, to somewhere its own sandbox keeps read-only. So before anything of
//    the site's runs, the shell looks at what is really mounted at each path and stops if it is
//    not the thing that was checked. This runs with systemd's plain environment: the site's
//    variables (LD_PRELOAD, PATH) are not set yet, and stat is called by its full path.
// 2. The site's environment, from the credential file (boxEnvFile).
// 3. The command, with the box's stdin. A program that is PID 1 gets no default signal handling
//    and has to reap every orphan in its namespace, which bun, node and most programs don't. So
//    the shell stays as PID 1: it passes TERM on, reaps, and exits with the command's status
//    (128 + the signal when a signal ended it).
export const BOX_INIT = [
  'while [ "$1" != -- ]; do',
  `  [ "$(/usr/bin/stat -c %d:%i -- "$2" 2>/dev/null)" = "$1" ] || { echo "candy: $2 in the box is not what was granted" >&2; exit ${BOX_INIT_REFUSED}; }`,
  "  shift 2",
  "done",
  "shift",
  // Checked first: in dash a "." that can't read its file ends the shell with its own exit code
  `if [ -n "$CREDENTIALS_DIRECTORY" ]; then [ -r "$CREDENTIALS_DIRECTORY/${BOX_ENV_CREDENTIAL}" ] && . "$CREDENTIALS_DIRECTORY/${BOX_ENV_CREDENTIAL}" || exit ${BOX_INIT_REFUSED}; fi`,
  // dash gives a background command /dev/null before "<&0" applies, so stdin goes round by fd 3
  '{ "$@" <&3 3<&- & } 3<&0; c=$!',
  `trap 'kill -TERM "$c" 2>/dev/null' TERM`,
  'while :; do wait "$c"; s=$?; kill -0 "$c" 2>/dev/null || break; done',
  'exit "$s"',
].join("\n")

/**
 * The box's environment as shell text BOX_INIT reads: `export NAME='value'` lines. In single
 * quotes nothing is special to a shell, and a quote inside is written '\''. It reaches the box
 * as a credential (root-owned source, 0600): never --setenv=NAME=value, which every user can read
 * in /proc, never systemd-run's own environment, where LD_PRELOAD would act on a root process,
 * and never the unit's own environment, where it would act on BOX_INIT's checks.
 */
export const boxEnvFile = (env: Record<string, string>): string =>
  Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error(`bad environment variable ${JSON.stringify(key.slice(0, 80))}`)
    return `export ${key}='${value.replace(/'/g, `'\\''`)}'\n`
  }).join("")

/** The command line that runs a box. `envFile`: where boxEnvFile's text was written. */
export const boxRunCommand = (box: BoxUnit, envFile: string, systemdRun = "systemd-run"): string[] => {
  const cmd = [
    // No --quiet: the lines systemd-run prints when the unit ends say how it ended (parseRunSummary)
    systemdRun, "--collect", "--wait", "--pipe",
    `--unit=${box.unit}`,
    `--slice=${SANDBOX_SLICE}`,
    "--service-type=exec",
    "--expand-environment=no",
    `--uid=${box.uid}`, `--gid=${box.gid}`,
    `--working-directory=${box.request.cwd}`,
    `--description=candy box of ${box.site}${box.request.label ? `: ${box.request.label.replace(/[^\x20-\x7e]/g, "?")}` : ""}`,
    `--property=LoadCredential=${BOX_ENV_CREDENTIAL}:${envFile}`,
  ]
  for (const prop of boxProperties(box)) cmd.push(`--property=${prop}`)
  const checks: string[] = []
  for (const g of box.request.grants) {
    // Without the daemon's note of what it checked, there is nothing to hold the mount to
    if (!g.check || !/^\d+:\d+$/.test(g.check)) throw new Error(`the grant of ${g.path} was never checked`)
    checks.push(g.check, g.path)
  }
  cmd.push("--", "/bin/sh", "-c", BOX_INIT, "candy-box", ...checks, "--", ...box.request.cmd)
  return cmd
}

// ---------------------------------------------------------------------------
// How a box ended
// ---------------------------------------------------------------------------

export type BoxExitCause =
  | "exit"          // the command exited: `code`
  | "signal"        // a signal ended it: `signal`
  | "oom"           // it ran past its memory limit
  | "lease"         // its "seconds" ran out
  | "released"      // the site stopped it
  | "site-stopped"  // the site itself ended, and its boxes with it
  | "stopped"       // candy or the operator stopped it
  | "failed"        // it never ran: `detail` says why

export interface BoxExit { cause: BoxExitCause; code: number | null; signal: string | null; detail: string | null; at: number }

export interface RunSummary { started: boolean; result: string | null; code: string | null; status: string | null }

/**
 * What systemd-run said about the unit, from the end of its stderr, and the box's own stderr
 * without those lines. The box can print look-alikes, so only the last of each counts: the real
 * ones are written after the box is gone.
 */
export const parseRunSummary = (stderr: string): { summary: RunSummary; rest: string } => {
  const summary: RunSummary = { started: false, result: null, code: null, status: null }
  const kept: string[] = []
  const lines = stderr.split("\n")
  let tail = lines.length
  // The summary is the block at the very end: walk back over it
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) { tail = i; continue }
    // A box whose stderr ended without a newline leaves its last bytes in front of this line
    const result = line.match(/^(.*)Finished with result: (\S+)$/)
    // systemd 259 prints "code=exited, status=3/NOTIMPLEMENTED" ("code=killed, status=9/KILL")
    const main = line.match(/^Main processes terminated with: code=(\w+)(?:, |\/)status=(\S+)$/)
    if (result && !summary.result) {
      summary.result = result[2]
      const before = lines[i].slice(0, lines[i].lastIndexOf("Finished with result: ")).trimEnd()
      if (before) { lines[i] = before; tail = i + 1; break }
      tail = i; continue
    }
    if (main && !summary.code) { summary.code = main[1]; summary.status = main[2]; tail = i; continue }
    if (/^(Service runtime|CPU time consumed|Memory peak|Memory swap peak|IP traffic received|IP traffic sent|IO bytes read|IO bytes written): /.test(line)) { tail = i; continue }
    break
  }
  for (let i = 0; i < tail; i++) {
    if (!summary.started && /^Running as unit: \S+/.test(lines[i].trim())) { summary.started = true; continue }
    kept.push(lines[i])
  }
  return { summary, rest: kept.join("\n").replace(/\n+$/, "") }
}

const SIGNAL_NAMES: Record<number, string> = { 1: "HUP", 2: "INT", 3: "QUIT", 4: "ILL", 6: "ABRT", 7: "BUS", 8: "FPE", 9: "KILL", 11: "SEGV", 13: "PIPE", 14: "ALRM", 15: "TERM" }

/**
 * The cause the site is told. `asked`: who stopped it, if someone did. `runExit`: systemd-run's
 * own exit code. A box's PID 1 is the BOX_INIT shell, so a command ended by a signal shows up as
 * exit code 128 + the signal, and one that couldn't be run as 126 or 127.
 */
export const boxExitCause = (summary: RunSummary, asked: "released" | "site-stopped" | "stopped" | null, runExit: number | null, stderrTail: string, at = Date.now()): BoxExit => {
  const exit = (cause: BoxExitCause, more: Partial<BoxExit> = {}): BoxExit => ({ cause, code: null, signal: null, detail: null, at, ...more })
  const lastLine = stderrTail.trim().split("\n").pop()?.trim().slice(0, 500) || null
  // Stopped before it was even up: that is the stop, not a failure
  if (!summary.started && !summary.result) return asked ? exit(asked) : exit("failed", { detail: lastLine ?? `systemd-run exited ${runExit}` })
  // Out of memory is the one thing the site reports to its operator: it wins over who asked
  if (summary.result === "oom-kill") return exit("oom")
  if (asked) return exit(asked)
  if (summary.result === "timeout") return exit("lease")
  const status = summary.status ?? ""
  if (summary.code === "killed" || summary.code === "dumped") return exit("signal", { signal: status.replace(/^\d+\//, "").replace(/^SIG/, "") || null })
  const code = /^\d+/.test(status) ? parseInt(status, 10) : runExit
  if (code === null || !Number.isInteger(code)) return exit("failed", { detail: `systemd result ${summary.result ?? "unknown"}` })
  // systemd's own codes for a unit it couldn't set up or exec (200 and up: 203/EXEC, 226/NAMESPACE, ...)
  if (code >= 200 && code <= 245 && status.includes("/")) return exit("failed", { detail: `systemd could not start it (${status})${lastLine ? `: ${lastLine}` : ""}` })
  if (code === BOX_INIT_REFUSED) return exit("failed", { code, detail: lastLine ?? "the box refused to start" })
  if (code === 126 || code === 127) return exit("failed", { code, detail: lastLine ?? "the command could not be run" })
  if (code > 128 && code <= 128 + 64) return exit("signal", { code, signal: SIGNAL_NAMES[code - 128] ?? String(code - 128) })
  return exit("exit", { code })
}

/** One line for the audit log: what was rented. Never the environment or the arguments. */
export const boxAuditLine = (r: BoxRequest): string => [
  `cmd=${r.cmd[0]}`,
  `memory=${formatMemory(r.memory)}`,
  `tasks=${r.tasks}`,
  ...(r.cpu ? [`cpu=${r.cpu}%`] : []),
  ...(r.seconds ? [`seconds=${r.seconds}`] : []),
  `grants=[${r.grants.map(g => `${g.mode}:${g.path}`).join(" ")}]`,
  `isolation=[${r.isolation.join(" ; ")}]`,
].join(" ")
