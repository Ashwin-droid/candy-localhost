// Legacy deep links (SPEC §3.2). Pure: callers pass location.search / location.hash.

export type DeepLink = { kind: "add"; name: string | null } | { kind: "logs"; name: string } | { kind: "bind"; name: string | null }

const NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/i

const cleanName = (v: string | null): string | null => (v && NAME.test(v) ? v.toLowerCase() : null)

/** `?add[=name]`, `?logs=name`, `?bind[=name]`. An invalid name: add/bind open empty, logs is ignored. */
export function parseDeepLink(search: string): DeepLink | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  if (q.has("add")) return { kind: "add", name: cleanName(q.get("add")) }
  if (q.has("logs")) {
    const name = cleanName(q.get("logs"))
    return name ? { kind: "logs", name } : null
  }
  if (q.has("bind")) return { kind: "bind", name: cleanName(q.get("bind")) }
  return null
}

const SETTINGS_HASHES: Record<string, string> = {
  "#passkeys": "/settings/passkeys",
  "#signin": "/settings/sign-in",
  "#domains": "/public",
  "#daemon": "/settings/daemon",
}

/** Old `/settings#…` anchors to their new routes; null when the hash isn't one of them. */
export function settingsHashRedirect(hash: string): string | null {
  return SETTINGS_HASHES[hash.toLowerCase()] ?? null
}

const ROOT_HASHES: Record<string, string> = {
  "#routes": "/sites",
  "#stats": "/machine",
}

/** Old `/#routes` and `/#stats` links (earlier candy:// handlers) to their new routes; null otherwise. */
export function rootHashRedirect(path: string, hash: string): string | null {
  return path === "/" ? ROOT_HASHES[hash.toLowerCase()] ?? null : null
}
