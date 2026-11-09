// Where clients look for the daemon's bootstrap secret.
//
// The daemon writes ~/.config/candy/mcp-secret for its owner. Run as root, it
// also writes /run/candy/users/<user>/secret for each member of the `candy`
// group, readable only by that user, and their servers run as them. Run as a
// normal user, it writes SHARED_SECRET_FILE (mode 640, group candy) instead,
// and everyone acts as the daemon's user.
import { userInfo } from "node:os"

export const SHARED_SECRET_FILE = "/run/candy/secret"
export const SHARED_GROUP = "candy"

export const secretFileCandidates = (): string[] => {
  const paths: string[] = []
  if (process.env.CANDY_SECRET_FILE) paths.push(process.env.CANDY_SECRET_FILE)
  if (process.env.HOME) paths.push(`${process.env.HOME}/.config/candy/mcp-secret`)
  try {
    paths.push(`/run/candy/users/${userInfo().username}/secret`)
  } catch {}
  paths.push(SHARED_SECRET_FILE)
  return paths
}

/** Every readable secret, in priority order. Callers try each until one is accepted. */
export const readSecrets = async (): Promise<string[]> => {
  const secrets: string[] = []
  for (const path of secretFileCandidates()) {
    try {
      const secret = (await Bun.file(path).text()).trim()
      if (secret && !secrets.includes(secret)) secrets.push(secret)
    } catch {}
  }
  return secrets
}

export const secretHint = (): string =>
  `No readable secret in ${secretFileCandidates().join(" or ")}. ` +
  `Is the daemon running, and are you in the '${SHARED_GROUP}' group?`

/**
 * Exchange a bootstrap secret for an API key. Returns null if no secret is
 * readable or none is accepted; network errors (daemon down) are thrown.
 */
export const exchangeSecret = async (apiBase: string, timeoutMs = 5000): Promise<string | null> => {
  for (const secret of await readSecrets()) {
    const res = await fetch(`${apiBase}/mcp/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) continue
    const data = await res.json().catch(() => null) as { apiKey?: string } | null
    if (data?.apiKey) return data.apiKey
  }
  return null
}
