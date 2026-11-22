// candy.json: a site's manifest, in the folder it runs from. Servers and
// functions share the keys here (the features a site has to ask for); a
// function's own keys (main, vars, kv, d1, crons, assets) are read from the
// same file by fn-config.ts.
//
// Running a site needs no manifest. Without one it gets none of these:
//   "auth": true            Sign in with candy (a key, and tokens for it)
//   "depends": ["db", ...]  sites started before this one and kept up while it runs
//   "publish": true         other users' sites may depend on this one, or subscribe to its events
//   "idle": true            may ask to be kept past its idle limit (SDK setIdling)
//   "pub": [{ "event": "built", "auth": "strict", "auth-users": ["bob"] }, "announce"]
//                           events it may publish, and who may subscribe to each (events.ts)
//   "sub": ["ci:built"]     events of other sites it gets; a publish wakes it, and it keeps them up
//   "service": true         takes server-to-server tokens ("app x, running as user y, asks")
//
// Pure apart from loadSiteManifest reading the one file.
import { join, resolve } from "node:path"
import { parseJsonc } from "./fn-config.ts"
import { EVENT_NAME, MAX_AUTH_USERS, MAX_EVENTS, MAX_SUBSCRIBE, PUB_AUTH, parseSubscription, type PubAuth, type PubEvent } from "./events.ts"

export const MANIFEST_FILE = "candy.json"
// Keys every kind of site may set. fn-config.ts skips these without a warning.
export const MANIFEST_KEYS = ["auth", "depends", "publish", "idle", "pub", "sub", "service"] as const
export const MAX_DEPENDS = 16
const MAX_MANIFEST_BYTES = 256 * 1024
// The same shape as a site name: a DNS label
const SITE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const USER_NAME = /^[a-z_][a-z0-9_.-]{0,31}$/

export interface SiteManifest {
  auth: boolean
  depends: string[]
  // Whether sites that run as other users may list this one in their "depends"
  publish: boolean
  // May call setIdling
  idle: boolean
  // The events this site may publish, each with who may subscribe to it
  pub: PubEvent[]
  // "site:event" it is subscribed to
  sub: string[]
  // Takes server-to-server tokens (its own key, apart from "auth")
  service: boolean
  warnings: string[]
  // Path of the candy.json this came from; null when the site has none
  source: string | null
}

export const emptyManifest = (): SiteManifest => ({ auth: false, depends: [], publish: false, idle: false, pub: [], sub: [], service: false, warnings: [], source: null })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The shared keys of a parsed candy.json. Throws on a value it can't use: a typo must not quietly turn a feature off. */
export const normalizeManifest = (raw: unknown): Omit<SiteManifest, "source"> => {
  if (!isObject(raw)) throw new Error(`${MANIFEST_FILE}: top level must be an object`)
  const warnings: string[] = []

  let auth = false
  if (raw.auth !== undefined) {
    if (typeof raw.auth !== "boolean") throw new Error(`${MANIFEST_FILE}: "auth" must be true or false`)
    auth = raw.auth
  }

  let depends: string[] = []
  if (raw.depends !== undefined) {
    const list = typeof raw.depends === "string" ? [raw.depends] : raw.depends
    if (!Array.isArray(list)) throw new Error(`${MANIFEST_FILE}: "depends" must be a site name or a list of them`)
    for (const item of list) {
      if (typeof item !== "string") throw new Error(`${MANIFEST_FILE}: "depends" must only hold site names`)
      const name = item.trim().toLowerCase()
      if (!SITE_NAME.test(name)) throw new Error(`${MANIFEST_FILE}: "${item.slice(0, 80)}" in "depends" is not a site name`)
      if (!depends.includes(name)) depends.push(name)
    }
    if (depends.length > MAX_DEPENDS) throw new Error(`${MANIFEST_FILE}: at most ${MAX_DEPENDS} sites in "depends"`)
  }

  let publish = false
  if (raw.publish !== undefined) {
    if (typeof raw.publish !== "boolean") throw new Error(`${MANIFEST_FILE}: "publish" must be true or false`)
    publish = raw.publish
  }

  const flag = (key: "idle" | "service"): boolean => {
    if (raw[key] === undefined) return false
    if (typeof raw[key] !== "boolean") throw new Error(`${MANIFEST_FILE}: "${key}" must be true or false`)
    return raw[key] as boolean
  }
  const idle = flag("idle")
  const service = flag("service")

  const list = (key: "pub" | "sub", max: number): unknown[] => {
    if (raw[key] === undefined) return []
    const v = Array.isArray(raw[key]) ? raw[key] as unknown[] : [raw[key]]
    if (v.length > max) throw new Error(`${MANIFEST_FILE}: at most ${max} entries in "${key}"`)
    return v
  }

  // "pub": each entry an event name, or { event, auth, auth-users }
  const pub: PubEvent[] = []
  for (const item of list("pub", MAX_EVENTS)) {
    const at = `"pub"[${pub.length}]`
    const o = typeof item === "string" ? { event: item } : item
    if (!isObject(o)) throw new Error(`${MANIFEST_FILE}: ${at} must be an event name or { "event": ..., "auth": ..., "auth-users": [...] }`)
    for (const k of Object.keys(o)) if (k !== "event" && k !== "auth" && k !== "auth-users") throw new Error(`${MANIFEST_FILE}: ${at} has no "${k.slice(0, 40)}" (it takes "event", "auth" and "auth-users")`)
    const event = typeof o.event === "string" ? o.event.trim().toLowerCase() : ""
    if (!EVENT_NAME.test(event)) throw new Error(`${MANIFEST_FILE}: ${at} needs an "event" name (letters, digits, dots, dashes and underscores)`)
    if (pub.some(e => e.event === event)) throw new Error(`${MANIFEST_FILE}: "pub" lists "${event}" twice`)
    let auth: PubAuth = "lax"
    if (o.auth !== undefined) {
      if (!PUB_AUTH.includes(o.auth as PubAuth)) throw new Error(`${MANIFEST_FILE}: ${at} "auth" must be "none", "lax" or "strict"`)
      auth = o.auth as PubAuth
    }
    const users: string[] = []
    if (o["auth-users"] !== undefined) {
      const names = typeof o["auth-users"] === "string" ? [o["auth-users"]] : o["auth-users"]
      if (!Array.isArray(names)) throw new Error(`${MANIFEST_FILE}: ${at} "auth-users" must be a user name or a list of them`)
      for (const u of names) {
        if (typeof u !== "string" || !USER_NAME.test(u)) throw new Error(`${MANIFEST_FILE}: ${at} "auth-users" must only hold unix user names`)
        if (!users.includes(u)) users.push(u)
      }
      if (users.length > MAX_AUTH_USERS) throw new Error(`${MANIFEST_FILE}: ${at} has more than ${MAX_AUTH_USERS} "auth-users"`)
      // A list nobody reads is a mistake worth saying out loud
      if (auth === "none") throw new Error(`${MANIFEST_FILE}: ${at} "auth-users" does nothing with "auth": "none"`)
    }
    pub.push({ event, auth, users })
  }

  const sub: string[] = []
  for (const item of list("sub", MAX_SUBSCRIBE)) {
    const v = typeof item === "string" ? item.trim().toLowerCase() : ""
    const parsed = parseSubscription(v)
    if (!parsed || !SITE_NAME.test(parsed.site)) throw new Error(`${MANIFEST_FILE}: "sub"[${sub.length}] must be "<site>:<event>"`)
    if (!sub.includes(v)) sub.push(v)
  }

  return { auth, depends, publish, idle, pub, sub, service, warnings }
}

/** Reads <dir>/candy.json. A folder without one gets the empty manifest. */
export const loadSiteManifest = async (dir: string): Promise<SiteManifest> => {
  const path = join(resolve(dir), MANIFEST_FILE)
  const file = Bun.file(path)
  if (!(await file.exists())) return emptyManifest()
  if (file.size > MAX_MANIFEST_BYTES) throw new Error(`${MANIFEST_FILE} is too large`)
  let raw: unknown
  try {
    raw = parseJsonc(await file.text())
  } catch (e) {
    throw new Error(`${MANIFEST_FILE}: ${(e as Error).message}`)
  }
  return { ...normalizeManifest(raw), source: path }
}

/** A manifest that came back from another process (fn-tool, run as the site's user): checked again, never trusted. */
export const checkSiteManifest = (v: unknown): SiteManifest => {
  if (!isObject(v)) throw new Error("bad manifest")
  const pub = Array.isArray(v.pub) ? v.pub.map(e => isObject(e) ? { event: e.event, auth: e.auth, ...(e.auth === "none" ? {} : { "auth-users": e.users }) } : e) : v.pub
  const m = normalizeManifest({ auth: v.auth, depends: v.depends, publish: v.publish, idle: v.idle, pub, sub: v.sub, service: v.service })
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 500)
  const warnings = Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === "string").slice(0, 32).map(clean) : []
  const source = typeof v.source === "string" && v.source.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v.source) ? v.source : null
  return { ...m, warnings, source }
}

/**
 * A circle of "depends" that comes back to `start`, written "a -> b -> a", or null.
 * `graph` maps each site to what it depends on (sites it doesn't list depend on nothing).
 */
export const findDependencyLoop = (start: string, graph: ReadonlyMap<string, readonly string[]>): string | null => {
  const path: string[] = []
  const done = new Set<string>()
  const walk = (name: string): string | null => {
    const at = path.indexOf(name)
    if (at >= 0) return [...path.slice(at), name].join(" -> ")
    if (done.has(name)) return null
    path.push(name)
    for (const dep of graph.get(name) ?? []) {
      const loop = walk(dep)
      if (loop) return loop
    }
    path.pop()
    done.add(name)
    return null
  }
  return walk(start)
}
