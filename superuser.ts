// Who may log in to the portal, and who is a superuser there.
//
// A superuser is anyone who may run a root shell through sudo. Root mode asks
// sudo itself (`sudo -n -l -U <user> -- /bin/sh`); a non-root daemon can't, so
// it falls back to membership in sudo/wheel/admin. Never true for root or
// unknown users. See "Superusers" in AUTH_DESIGN.md.
import { userInfo } from "node:os"
import { SHARED_GROUP } from "./secret"

export interface RunResult { exitCode: number; stdout: string }
export type CommandRunner = (cmd: string[]) => Promise<RunResult>

export interface SuperuserDeps {
  run?: CommandRunner
  /** Whether the daemon runs as root (default: process uid 0). */
  isRoot?: boolean
  /** The daemon's owner (default: CANDY_OWNER, or the current user when not root). */
  owner?: string
  /** The daemon's own account name in user mode (default: the current user). */
  self?: string
  now?: () => number
}

export interface UserAccount { name: string; uid: number; gid: number; home: string; shell: string }

export const SUPERUSER_CACHE_MS = 60_000
const ADMIN_GROUPS = ["sudo", "wheel", "admin"]
const USERNAME_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i
const NO_LOGIN_SHELLS = new Set(["nologin", "false", "true", "sync", "halt", "shutdown"])
const RUN_TIMEOUT_MS = 5_000

const defaultRunner: CommandRunner = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } })
    const timer = setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, RUN_TIMEOUT_MS)
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return { exitCode, stdout }
  } catch {
    return { exitCode: 127, stdout: "" }
  }
}

/** A shell someone can actually log in with. An empty field means /bin/sh. */
export const usableShell = (shell: string): boolean => {
  if (!shell) return true
  if (shell === "/dev/null") return false
  return !NO_LOGIN_SHELLS.has(shell.slice(shell.lastIndexOf("/") + 1))
}

export const parsePasswd = (line: string): UserAccount | null => {
  const f = line.trim().split(":")
  if (f.length < 7 || !f[0]) return null
  const uid = Number(f[2]), gid = Number(f[3])
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || f[2] === "" || f[3] === "") return null
  return { name: f[0], uid, gid, home: f[5], shell: f[6] }
}

export const parseGroup = (line: string): { name: string; gid: number; members: string[] } | null => {
  const f = line.trim().split(":")
  if (f.length < 4 || !f[0] || f[2] === "") return null
  const gid = Number(f[2])
  if (!Number.isInteger(gid)) return null
  return { name: f[0], gid, members: f[3].split(",").map(m => m.trim()).filter(Boolean) }
}

export const createSuperuser = (deps: SuperuserDeps = {}) => {
  const run = deps.run ?? defaultRunner
  const now = deps.now ?? Date.now
  const isRoot = deps.isRoot ?? process.getuid?.() === 0
  const self = () => {
    if (deps.self !== undefined) return deps.self
    try { return userInfo().username } catch { return "" }
  }
  const owner = () => deps.owner ?? (process.env.CANDY_OWNER || (isRoot ? "" : self()))
  const cache = new Map<string, { value: boolean; at: number }>()

  const lookupUser = async (name: string): Promise<UserAccount | null> => {
    if (!USERNAME_RE.test(name)) return null
    const res = await run(["getent", "passwd", name])
    if (res.exitCode !== 0) return null
    const account = parsePasswd(res.stdout.split("\n")[0] ?? "")
    return account && account.name === name ? account : null
  }

  const lookupGroup = async (name: string) => {
    const res = await run(["getent", "group", name])
    if (res.exitCode !== 0) return null
    return parseGroup(res.stdout.split("\n")[0] ?? "")
  }

  // Locked (passwd -l / usermod -L: "!" before the hash) or past its expiry date.
  // Only root can read shadow; elsewhere PAM's account check is all there is.
  const lockedOrExpired = async (name: string): Promise<boolean> => {
    if (!isRoot) return false
    const res = await run(["getent", "shadow", name])
    if (res.exitCode !== 0) return false
    const f = (res.stdout.split("\n")[0] ?? "").split(":")
    if (f[0] !== name) return false
    if ((f[1] ?? "").startsWith("!")) return true
    const expire = Number(f[7])
    return f[7] !== "" && f[7] !== undefined && Number.isFinite(expire) && expire * 86400000 <= now()
  }

  const check = async (user: string): Promise<boolean> => {
    if (user === "root") return false
    const account = await lookupUser(user)
    if (!account || account.uid === 0) return false
    if (isRoot) {
      const res = await run(["sudo", "-n", "-l", "-U", user, "--", "/bin/sh"])
      return res.exitCode === 0
    }
    for (const g of ADMIN_GROUPS) {
      const group = await lookupGroup(g)
      if (group && (group.members.includes(user) || group.gid === account.gid)) return true
    }
    return false
  }

  /** True when `user` may run a root shell through sudo. Cached for 60s per user. */
  const isSuperuser = async (user: string): Promise<boolean> => {
    if (typeof user !== "string" || !USERNAME_RE.test(user) || user === "root") return false
    const hit = cache.get(user)
    if (hit && now() - hit.at < SUPERUSER_CACHE_MS) return hit.value
    let value = false
    try { value = await check(user) } catch { value = false }
    cache.set(user, { value, at: now() })
    return value
  }

  /** The login dropdown: owner first, then the rest sorted. Never root, no-shell, locked or expired accounts. */
  const loginUsers = async (): Promise<string[]> => {
    const first = owner()
    const candidates = isRoot
      ? [first, ...((await lookupGroup(SHARED_GROUP))?.members ?? [])]
      : [self()]
    const out: string[] = []
    for (const name of new Set(candidates)) {
      if (!name || out.includes(name)) continue
      const account = await lookupUser(name)
      if (!account || account.uid === 0 || !usableShell(account.shell)) continue
      if (await lockedOrExpired(account.name)) continue
      out.push(account.name)
    }
    return out.sort((a, b) => (a === first ? -1 : b === first ? 1 : a < b ? -1 : a > b ? 1 : 0))
  }

  const clearCache = () => cache.clear()

  return { isSuperuser, loginUsers, clearCache, lookupUser }
}

const defaultInstance = createSuperuser()

export const isSuperuser = (user: string): Promise<boolean> => defaultInstance.isSuperuser(user)
export const loginUsers = (): Promise<string[]> => defaultInstance.loginUsers()
/** For tests. */
export const clearSuperuserCache = (): void => defaultInstance.clearCache()
