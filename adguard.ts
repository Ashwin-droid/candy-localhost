// AdGuard Home integration for LAN HTTPS. AdGuard Home hides the client
// address from candy-dns, so LAN clients only get LAN answers when its
// persistent LAN client forwards the right names to candy-dns's LAN listener.
// candy keeps those "[/name/]host:port" upstream lines in place through
// AdGuard Home's API, touching only lines it added itself.

export interface AdguardConfig {
  url: string        // AdGuard Home admin address, e.g. http://127.0.0.1:3000
  username: string
  password: string
  client: string     // name of the persistent client that covers the LAN
  dnsTarget: string  // candy-dns LAN listener, e.g. 127.0.0.1:5336
  managed: string[]  // upstream lines candy added (and may remove)
}

export const upstreamRule = (domain: string, target: string): string => `[/${domain.toLowerCase()}/]${target}`

// Add the desired lines that are missing; drop lines candy added earlier that
// are no longer wanted. Lines someone else wrote are never removed, and a
// desired line that was already there is not taken over.
export const planUpstreams = (current: string[], desired: string[], managed: string[]) => {
  const kept = current.filter(line => !managed.includes(line) || desired.includes(line))
  const added = desired.filter(line => !kept.includes(line))
  const next = [...kept, ...added]
  return {
    next,
    managed: [...managed.filter(line => desired.includes(line) && current.includes(line)), ...added],
    changed: next.length !== current.length || next.some((line, i) => line !== current[i]),
  }
}

interface AdguardClient {
  name: string
  upstreams?: string[] | null
  [key: string]: unknown
}

const call = async (cfg: AdguardConfig, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${cfg.url.replace(/\/+$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  })
  if (res.status === 401 || res.status === 403) throw new Error("AdGuard Home rejected the username or password.")
  if (!res.ok) throw new Error(`AdGuard Home answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  try { return text ? JSON.parse(text) : null } catch { return null }
}

export const adguardClients = async (cfg: AdguardConfig): Promise<AdguardClient[]> =>
  ((await call(cfg, "/control/clients"))?.clients ?? []) as AdguardClient[]

// Bring the LAN client's upstreams in line with `desired`. Returns the new
// list of lines candy manages.
export const applyAdguardUpstreams = async (cfg: AdguardConfig, desired: string[]) => {
  const clients = await adguardClients(cfg)
  const client = clients.find(c => c.name === cfg.client)
  if (!client) {
    const names = clients.map(c => `"${c.name}"`).join(", ") || "none"
    throw new Error(`AdGuard Home has no persistent client named "${cfg.client}" (found: ${names}).`)
  }
  const plan = planUpstreams(client.upstreams ?? [], desired, cfg.managed)
  if (plan.changed) {
    await call(cfg, "/control/clients/update", { name: client.name, data: { ...client, upstreams: plan.next } })
  }
  return { changed: plan.changed, managed: plan.managed, upstreams: plan.next }
}
