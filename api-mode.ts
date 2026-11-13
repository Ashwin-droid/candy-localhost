// API mode: servers called by programs, not browsers. Every request for such a
// server's own host (bound domain, <name>.localhost, <name>.candy) is the
// server's, whatever its method or path. A request to a stopped server is held
// while it starts, then forwarded unchanged. The daemon never answers one with
// a page or a route of its own; when the server can't be reached the reply is
// 503 with Retry-After, so a client retries instead of dropping its session.
//
// Kept apart from daemon.ts (which can't be imported without starting it) so
// test/api-mode.test.ts runs the real gate.

/** The parts of a managed process the gate reads. */
export interface ApiModeProcess {
  status: string
  port?: number | null
  exitCode?: number | null
  detectedPorts: number[]
  lastActivity: number
}

export interface ApiModeDeps<C extends { id: string }, B> {
  /** The portal's own host: never a site */
  isPortal(req: Request): boolean
  /** A bound domain and the server it serves */
  binding(host: string): { serverName: string; binding: B } | null
  /** The server a <name>.localhost / <name>.candy host names */
  localName(host: string): string
  /** The config whose API mode applies to a name, if any */
  config(name: string): C | null
  /** The bound domain has a password or token: Caddy asks /candy-auth/check, people log in at /candy-auth/login */
  isProtected(binding: B): boolean
  /** Allowlist and credentials for a bound domain: a refusal, or null to go on */
  authorize(req: Request, binding: B): Promise<Response | null>
  process(name: string): ApiModeProcess | undefined
  start(name: string, configId: string): Promise<ApiModeProcess>
  upstreamHeaders(src: Headers, protectedDomain: boolean): Headers
  fetchUpstream(target: string, init: RequestInit, req: Request): Promise<Response>
  /** Is something accepting connections on this port yet? */
  listening(port: number): Promise<boolean>
  /** Lift the client connection's idle limit while its request is held */
  holdOpen?(req: Request): void
  /** How long a request waits for a cold start, in ms */
  holdMs: number
}

/** Seconds a held request waits for a cold start: CANDY_API_HOLD_SECONDS, never under 60. Default 90, just inside Cloudflare's 100s limit so candy's 503 arrives instead of Cloudflare's 524. */
export const apiHoldSeconds = (raw: string | undefined): number => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.max(60, Math.floor(n)) : 90
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']
const SITE_HOST = /\.(localhost|candy)(:\d+)?$/i
const RETRY_AFTER = 5

const unavailable = (error: string, details: Record<string, unknown> = {}): Response =>
  Response.json({ error, ...details }, { status: 503, headers: { 'X-Candy': 'api-mode', 'Retry-After': String(RETRY_AFTER), 'Cache-Control': 'no-store' } })

const isUp = (p: ApiModeProcess | undefined): p is ApiModeProcess => !!p && (p.status === 'running' || p.status === 'starting')

export const createApiModeGate = <C extends { id: string }, B>(deps: ApiModeDeps<C, B>) => {
  // One start per name, however many requests arrive together
  const starts = new Map<string, Promise<ApiModeProcess>>()

  const forward = async (req: Request, url: URL, name: string, config: C, protectedDomain: boolean): Promise<Response> => {
    const deadline = Date.now() + deps.holdMs
    let managed = deps.process(name)
    let cold = false
    if (!isUp(managed)) {
      cold = true
      let starting = starts.get(name)
      if (!starting) {
        starting = deps.start(name, config.id).finally(() => starts.delete(name))
        starts.set(name, starting)
      }
      try {
        managed = await starting
      } catch (e) {
        return unavailable(`Could not start ${name}`, { reason: String((e as Error)?.message ?? e) })
      }
    }
    managed.lastActivity = Date.now()

    if (managed.status === 'starting') {
      cold = true
      deps.holdOpen?.(req)
    }
    while (managed.status === 'starting' && Date.now() < deadline && !req.signal.aborted) {
      await Bun.sleep(50)
    }
    if (managed.status === 'errored' || managed.status === 'dead') {
      return unavailable(`${name} exited before it was ready`, { exitCode: managed.exitCode })
    }
    if (managed.status !== 'running' || !managed.port) {
      const ports = managed.detectedPorts
      return ports.length > 1
        ? unavailable(`${name} listens on several ports. Pick one in the portal (Set port…)`, { ports })
        : unavailable(`${name} is still starting`)
    }
    // A port printed in the log can come before the socket is open: wait for
    // it, so the one copy of the request body isn't spent on a refused connection
    while (cold && managed.status === 'running' && Date.now() < deadline && !req.signal.aborted) {
      if (await deps.listening(managed.port)) break
      await Bun.sleep(50)
    }
    managed.lastActivity = Date.now()

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    try {
      const upstream = await deps.fetchUpstream(`http://localhost:${managed.port}${url.pathname}${url.search}`, {
        method: req.method,
        headers: deps.upstreamHeaders(req.headers, protectedDomain),
        body: hasBody ? req.body : undefined,
        redirect: 'manual',
        decompress: false,
        // @ts-ignore Bun/undici option for streaming request bodies
        duplex: 'half',
      } as RequestInit, req)
      const out = new Headers(upstream.headers)
      for (const h of HOP_BY_HOP) out.delete(h)
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out })
    } catch (e) {
      return unavailable(`${name} did not answer`, { reason: String((e as Error)?.message ?? e) })
    }
  }

  /**
   * The answer for a request to an API-mode server's host, or null when the
   * request isn't one (the daemon's own router goes on).
   * Must run before anything that matches a path or touches the request.
   */
  return async (req: Request, url: URL): Promise<Response | null> => {
    const host = req.headers.get('host') || ''
    if (deps.isPortal(req)) return null
    const bound = deps.binding(host)
    if (!bound && !SITE_HOST.test(host)) return null
    const name = bound ? bound.serverName : deps.localName(host)
    if (!name || name === 'portal') return null
    const config = deps.config(name)
    if (!config) return null

    const protectedDomain = !!bound && deps.isProtected(bound.binding)
    // The only two paths candy keeps for itself, and only where a login exists
    if (protectedDomain && (url.pathname === '/candy-auth/check' || (req.method === 'POST' && url.pathname === '/candy-auth/login'))) return null
    if (bound) {
      const refused = await deps.authorize(req, bound.binding)
      if (refused) return refused
    }
    return forward(req, url, name, config, protectedDomain)
  }
}
