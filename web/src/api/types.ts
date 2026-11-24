// Shared API response types (SPEC §7.3). Page packages type their own endpoints in pages/<area>/types.ts.
// Shapes follow 04-api-catalog.md and daemon.ts; keep the names exactly as they are.

export type ProcessStatus = "starting" | "running" | "dead" | "errored"
export interface StatusResponse { status: "running"; caddyRunning: boolean; routeCount: number; portalCount: number;
  uptime: number; pid: number; owner: string; multiUser: boolean }
export type RouteTarget = number | string | { fn: string }
export interface RouteInfo { target: RouteTarget; isRestricted: boolean; persistent: boolean; lan: boolean;
  lanHttps: string | null; tsServe: string | null }
export type RoutesResponse = Record<string, RouteInfo>
export interface EntriesResponse { entries: Record<string, number> }
export interface ProcessInfo { status: ProcessStatus; port: number | null; pid: number | null; uptime: string;
  exitCode: number | null; detectedPorts: number[]; configId: string; cwd: string; cmd: string;
  memoryUsed: number | null /* bytes */; memoryMax: number | null /* bytes */; depends: string[]; heldBy: string[] }
  // /processes never sends `fn` (daemon.ts ~8263-8290); uptime is the daemon's formatted string
export interface ProcessesResponse { success: true; processes: Record<string, ProcessInfo> }
export type PubAuth = "none" | "lax" | "strict"
export interface PubEvent { event: string; auth: PubAuth; users: string[]; ordered?: true; bind?: string }
export interface SiteManifestView { auth: boolean; depends: string[]; publish: boolean; idle: boolean; pub: PubEvent[];
  sub: string[]; service: boolean; cron: { tag: string; schedule: string }[]
  unordered?: string[]   // entries of sub that end in ":unordered" in candy.json (shown without it in sub)
}
export interface Variant { id: string; cwd: string; cmd: string; user: string; api: boolean }
export interface AssetsSummary { directory: string; binding: string | null;
  notFound: "none" | "404-page" | "single-page-application";
  html: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none"; runWorkerFirst: boolean | string[] }
export interface FnSummary { entry: string | null; deploy: string | null; hot: number; max: number; linger: number;
  log: true | false | "meta"; http: boolean; hasWorker: boolean; source: "live" | `deploy:${string}` | null;
  assets: AssetsSummary | null;
  kv?: string[] | null; d1?: string[] | null   // binding names from candy.json; null until it has been read
}
export interface ConfigInfo { id: string; cwd: string; cmd: string; user: string; api: boolean; sandbox: boolean;
  envFile: string | null; ttl: number | null; memory: number | null; memoryLimit: number;
  manifest: SiteManifestView | { error: string } | null; rw: string[]; count: number; variants: Variant[];
  lan: boolean; lanHttps: string | null; tsServe: string | null; fn?: FnSummary
  alarms?: AlarmView[]   // set by the app through the SDK (setAlarm / setCron), not candy.json
  boxes?: BoxesView      // sandboxes the site rents for its own child processes
}
// cron: a soft cron's schedule (it goes off again after each run); null for a one-off alarm. Times in ms.
export interface AlarmView { name: string; at: number; cron: string | null; setAt: number }
// wanted: candy.json has "boxes": true. quota: what the operator allows (memory in MB per box); null = none.
export interface BoxesView { wanted: boolean; quota: { max: number; memory: number } | null; held: BoxView[] }
export interface BoxView { id: string; label: string | null; unit: string; memory: number /* MB limit */;
  memoryUsed: number | null /* bytes */; startedAt: number /* ms */ }
export interface ConfigsResponse { success: true; configs: Record<string, ConfigInfo> }
export interface PortalInfo { port: number; url?: string }
export type PortalsResponse = Record<string, PortalInfo>
export interface TrafficDomain { name: string; total: number; alive: boolean;
  children: { name: string; url: string; total: number; alive: boolean }[] }
export interface StatsResponse { sessionStart: string; totalRequests: number; domains: TrafficDomain[] }
export interface DomainBinding { subdomain: string; fqdn: string; serverName: string; boundAt: string; owner: string;
  orphaned: boolean; authEnabled: boolean; hasPassword: boolean; hasJwtSecret: boolean; apiMode: boolean;
  allowlist: { enabled: boolean; ips: string[] } }
export type DomainsResponse =
  | { configured: false; bindings: Record<string, never> }
  | { configured: true; tunnel: { id: string; name: string; credentialsFile: string }; zone: { id: string; domain: string };
      bindings: Record<string, DomainBinding> }
export interface BindOk { message: string; binding: Pick<DomainBinding, "subdomain" | "fqdn" | "serverName" | "boundAt" | "owner"> }
export interface BindWarning { warning: true; message: string; existingRecords: { type: string; content: string; id: string }[]; fqdn: string }
export interface UsersResponse { owner: string; you: string; superuser: boolean; multiUser: boolean; users: { name: string; home: string }[] }
export interface ActivityResponse { logs: { time: string; action: string; details: string }[]; total: number }
export interface TrafficResponse { domain: string; count: number;
  logs: { time: string | null; method: string; path: string; status: number | "?"; isTunnel: boolean }[] }
export interface LogTextResponse { logs: string }
export interface LanResponse { lanIp: string | null; tailnetHost: string | null; published: string[]; names: Record<string, boolean>;
  https: Record<string, { mode: "tailscale"; port: number; url: string | null } | { mode: "domain"; port: null; url: string | null }> }
export interface LanSet { name: string; domain: string; published: boolean; lanIp: string | null; httpsUrl: string | null;
  httpsMode: "domain" | "tailscale" | null; dnsManaged: boolean; httpsPort: number | null; warning?: string }
export interface ServesResponse { tailnetHost: string | null; serves: Record<string, { port: number; url: string | null; entryPort: number | null }> }
export type AdguardStatus = { configured: false } | { configured: true; url: string; username: string; client: string;
  dnsTarget: string; rules: string[]; managed: string[]; error: string | null }
export interface PublicMcpStatus { available: boolean; enabled: boolean; url: string | null; wouldBe: string | null; consent: string;
  clients: { clientId: string; clientName: string; createdAt: number; lastUsedAt: number | null; activeGrants: number; users: string[] }[] }
export interface FnInstanceInfo { id: string; pid: number | null; hot: boolean; inflight: number; startedAt: number; ready: boolean }
export interface DeployInfo { id: string; createdAt: number; entry: string | null; dir: string; source: string; gitRev: string | null;
  size: number; main: string; assets: string | null; assetsConfig?: Omit<AssetsSummary, "directory"> }
export interface DeploysResponse { success: true; deploys: DeployInfo[]; current: string | null; fn: FnSummary }
export interface InstancesResponse { success: true; instances: FnInstanceInfo[]; fn: FnSummary }
export interface RequestSummary { id: string; ts: number; fn: string; host: string; method: string; url: string; path: string;
  clientIp: string; status: number | null; outcome: "ok" | "threw" | "cancelled" | "crashed"; cold: boolean; instance: string;
  queuedMs: number; ttfbMs: number | null; totalMs: number; reqBytes: number; resBytes: number; kind: "worker" | "asset"; rule: string | null }
export interface CapturedBody { kind: "text" | "binary" | "omitted" | "none"; contentType: string | null; size: number;
  truncated: boolean; text: string | null; sha256: string | null }
export interface RequestDetail extends RequestSummary { reqHeaders: [string, string][]; resHeaders: [string, string][];
  reqBody: CapturedBody; resBody: CapturedBody; error: { message: string; stack: string | null } | null;
  logs: { level: "log" | "info" | "warn" | "error" | "debug"; text: string; ts: number }[]; logsTruncated: boolean }
export interface ReplayResponse { status: number; headers: [string, string][]; body: string; truncated: boolean; requestId: string }
export interface KvListResponse { keys: { name: string; expiration?: number; metadata?: unknown }[]; list_complete: boolean; cursor?: string }
export interface D1Meta { duration: number; changes: number; last_row_id: number; rows_read: number; rows_written: number; changed_db: boolean; size_after: number }
export interface D1Response { results: Record<string, unknown>[]; success: true; meta: D1Meta; truncated?: true }
export interface FnAddResponse { success: true; name: string; url: string | null; warnings: string[]; fn: FnSummary }
export interface ReloadResponse { success: true; sites: { name: string; ok: boolean; error?: string; cron: string[]; url?: string | null }[] }
export interface MemoryResponse { success: true; memory: number | null; limit: number; text: string; isDefault: boolean; applied: "now" | "next start"; sandboxed: boolean }
export interface BoxesResponse { success: true; boxes: { max: number; memory: number } | null; text: string; wanted: boolean; sandboxed: boolean }
export interface SandboxResponse { success: true; sandbox: boolean; active: boolean; rw: string[]; stateDir: string; message: string }
export interface StartResponse { success: true; message?: string /* "already running" */; data: { name: string; status: ProcessStatus;
  port: number | null; pid: number | null; detectedPorts: number[]; configId: string; cwd: string; cmd: string } }
export interface StartChoose { success: false; error: string; configs: { id: string; cwd: string; cmd: string }[] }
export interface SystemProcess { pid: number; ppid: number; user: string; name: string; cmd: string; state: string; cpu: number;
  mem: number; threads: number; start: number; unit: string | null; kernel: boolean }
export interface SystemStats { at: number; host: string; uptime: number; load: [number, number, number];
  cpu: { percent: number; cores: number[] }; mem: { total: number; available: number; used: number; cached: number; swapTotal: number; swapUsed: number };
  disks: { device: string; type: string; mount: string; size: number; used: number; available: number }[];
  net: { name: string; rx: number; tx: number }[]; temp: number | null; processes: SystemProcess[];
  units: { unit: string; processes: number; cpu: number; mem: number; failed?: boolean }[]; failed: string[];
  counts: { processes: number; threads: number }; root: boolean; self: number; ownUnit: string | null; candy: Record<string, string> }
export interface MeResponse { user: string; superuser: boolean; via: "portal" | "apikey" | "oauth"; amr?: "pam" | "passkey"; multiUser: boolean }
export interface BootResponse { token: string; user: string; superuser: boolean; multiUser: boolean; owner: string;
  amr: "pam" | "passkey" | null; candyHost: string | null; pamUntil: number | null; tld: "candy" | "localhost"; buildStale: boolean }
export interface PasskeyView { id: string; name: string; rpId: string; created: number; lastUsed: number | null; backedUp: boolean;
  alg: "ES256" | "RS256" | "EdDSA"; here: boolean }
export interface AppAuthSite { site: string; owner: string; kid: string; created: number; rotatedAt: number | null; enabled: boolean }
export interface AppAuthConsent { site: string; owner: string; at: number }
// = tailnet.ts NetworkRegistryEntry (copied, not imported: web/ doesn't import daemon modules other than cron.ts)
export interface RegistryEntry { name: string; ip: string; hostName: string | null; dnsName: string | null;
  hostLabel: string | null; canonicalFqdn: string | null; aliasFqdns: string[]; winner: boolean; expiresIn?: number }
export interface RegistryResponse { local: RegistryEntry[]; remote: RegistryEntry[] }
// Process and tunnel answers (B, C, E and F all start, stop, restart or close)
export interface FnStartResponse { success: true; data: { name: string; status: "function"; instances: FnInstanceInfo[] }; message: string }
export interface StopResponse { success: boolean; alsoStopped: string[] }        // a function answers FnStartResponse
export interface RestartResponse { success: true; data: { name: string; status: ProcessStatus; port: number | null; pid: number | null;
  detectedPorts: number[] }; message: "Restart scheduled" | "Restart queued" }
export interface PortalOpenResponse { name: string; url: string; port: number; message: string }
export interface PortalCloseResponse { status: "closed"; name: string; message: string }
export interface OkResponse { success?: boolean; message?: string }              // /process/port and other bare answers
