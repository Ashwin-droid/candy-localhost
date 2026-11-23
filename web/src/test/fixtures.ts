// Response fixtures for tests (shapes of api/types.ts). Build on these with spread.

import type { ConfigInfo, DomainBinding, FnSummary, ProcessInfo, RouteInfo, StatusResponse } from "../api/types.ts"

export const status: StatusResponse = { status: "running", caddyRunning: true, routeCount: 3, portalCount: 0, uptime: 3 * 86400 + 4 * 3600, pid: 42, owner: "ashwin", multiUser: false }

export const route = (target: RouteInfo["target"], o: Partial<RouteInfo> = {}): RouteInfo => ({
  target, isRestricted: typeof target === "string", persistent: false, lan: false, lanHttps: null, tsServe: null, ...o,
})

export const proc = (o: Partial<ProcessInfo> = {}): ProcessInfo => ({
  status: "running", port: 3000, pid: 1234, uptime: "3h 12m", exitCode: null, detectedPorts: [3000], configId: "default",
  cwd: "/home/ashwin/app", cmd: "bun dev", memoryUsed: 100 * 1048576, memoryMax: 2048 * 1048576, depends: [], heldBy: [], ...o,
})

export const fnSummary = (o: Partial<FnSummary> = {}): FnSummary => ({
  entry: "src/index.ts", deploy: null, hot: 0, max: 4, linger: 30, log: true, http: true, hasWorker: true, source: "live", assets: null, ...o,
})

export const config = (o: Partial<ConfigInfo> = {}): ConfigInfo => ({
  id: "default", cwd: "/home/ashwin/app", cmd: "bun dev", user: "ashwin", api: false, sandbox: true, envFile: null, ttl: null,
  memory: null, memoryLimit: 2048, manifest: null, rw: [], count: 1, variants: [], lan: false, lanHttps: null, tsServe: null, ...o,
})

export const binding = (o: Partial<DomainBinding> = {}): DomainBinding => ({
  subdomain: "blog", fqdn: "blog.example.com", serverName: "blog", boundAt: "2026-11-01T00:00:00Z", owner: "ashwin",
  orphaned: false, authEnabled: true, hasPassword: true, hasJwtSecret: false, apiMode: false, allowlist: { enabled: false, ips: [] }, ...o,
})
