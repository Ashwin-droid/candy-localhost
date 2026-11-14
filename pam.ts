// Portal login: check a local account's password through PAM.
//
// The PAM calls (pam_start → pam_authenticate → pam_acct_mgmt) run in a child
// process (`bun pam.ts --helper`), so a module that blocks (pam_faildelay,
// LDAP, ...) or crashes can't take the daemon down. The parent sends
// {service, user, password, confdir?} as JSON on stdin and reads one JSON line
// {ok, code, message, stage} back. The password is never in argv or env and is
// never logged. See "Portal Login (PAM)" in AUTH_DESIGN.md.
//
// {service, user, mode: "account"} (no password) runs only pam_acct_mgmt:
// what a passkey login (passkey-store.ts) checks, so an expired password,
// pam_access, pam_time or pam_nologin refuse it the way they refuse a password.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { dlopen, FFIType, JSCallback, ptr, read, toArrayBuffer } from "bun:ffi"

export type PamReason = "ok" | "denied" | "account" | "unavailable" | "timeout"
export interface PamVerifyResult { ok: boolean; reason: PamReason }
export interface PamVerifyOptions { service?: string; confdir?: string; timeoutMs?: number }

/** What the helper prints. `stage` says which call produced `code`. */
export interface PamHelperResult {
  ok: boolean
  code: number
  message: string
  stage: "setup" | "start" | "auth" | "acct" | "done"
}

export const DEFAULT_SERVICE = "candy"
export const HELPER_TIMEOUT_MS = 10_000
export const HELPER_OUTPUT_CAP = 64 * 1024
const MAX_PASSWORD_BYTES = 4096
const MAX_HELPER_INPUT = 16 * 1024
const PAM_DIR = "/etc/pam.d"

// Linux-PAM return codes (security/_pam_types.h)
export const PAM = {
  SUCCESS: 0, OPEN_ERR: 1, SYMBOL_ERR: 2, SERVICE_ERR: 3, SYSTEM_ERR: 4, BUF_ERR: 5,
  PERM_DENIED: 6, AUTH_ERR: 7, CRED_INSUFFICIENT: 8, AUTHINFO_UNAVAIL: 9, USER_UNKNOWN: 10,
  MAXTRIES: 11, NEW_AUTHTOK_REQD: 12, ACCT_EXPIRED: 13, CONV_ERR: 19, AUTHTOK_EXPIRED: 27,
  ABORT: 26, MODULE_UNKNOWN: 28,
} as const
// Helper-only codes for failures before PAM is reached
export const HELPER_NO_LIBPAM = -1
export const HELPER_NO_SERVICE = -2
export const HELPER_BAD_INPUT = -3

const PAM_PROMPT_ECHO_OFF = 1
const PAM_PROMPT_ECHO_ON = 2

const USERNAME_RE = /^[a-z_][a-z0-9_.-]{0,31}\$?$/i
const SERVICE_RE = /^[a-z0-9_][a-z0-9_.-]{0,63}$/i

/** Names PAM may be asked about. Root never logs in to the portal. */
export const validUsername = (user: unknown): user is string =>
  typeof user === "string" && USERNAME_RE.test(user) && user !== "root"

const validService = (service: unknown): service is string =>
  typeof service === "string" && SERVICE_RE.test(service)

const servicePath = (service: string, confdir?: string) => join(confdir ?? PAM_DIR, service)

/** Map a helper result to the reason enum. Anything unexpected fails closed. */
export const reasonFor = (r: PamHelperResult): PamReason => {
  if (r.ok && r.code === PAM.SUCCESS && r.stage === "done") return "ok"
  if (r.stage === "auth") {
    if (r.code === PAM.AUTH_ERR || r.code === PAM.USER_UNKNOWN || r.code === PAM.MAXTRIES ||
        r.code === PAM.CRED_INSUFFICIENT || r.code === PAM.PERM_DENIED) return "denied"
    return "unavailable"
  }
  if (r.stage === "acct") {
    if (r.code === PAM.USER_UNKNOWN) return "denied"
    if (r.code === PAM.ACCT_EXPIRED || r.code === PAM.NEW_AUTHTOK_REQD || r.code === PAM.PERM_DENIED ||
        r.code === PAM.AUTHTOK_EXPIRED || r.code === PAM.AUTH_ERR) return "account"
    return "unavailable"
  }
  if (r.stage === "setup" && r.code === HELPER_BAD_INPUT) return "denied"
  return "unavailable"
}

// ---------------------------------------------------------------------------
// Parent side

export interface HelperProcess {
  stdin: { write(data: string | Uint8Array): unknown; end(): unknown }
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
}
export type HelperSpawner = (cmd: string[], opts: { env: Record<string, string>; cwd: string }) => HelperProcess

export interface PamDeps {
  /** The helper command line; defaults to [bun, pam.ts, "--helper"]. */
  helperCmd?: string[]
  spawn?: HelperSpawner
  outputCap?: number
}

const defaultSpawn: HelperSpawner = (cmd, opts) => Bun.spawn(cmd, {
  env: opts.env, cwd: opts.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore",
}) as unknown as HelperProcess

/** The only environment the helper gets: no secrets, no inherited state. */
export const helperEnv = (): Record<string, string> => ({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" })

const fail = (reason: PamReason): PamVerifyResult => ({ ok: false, reason })

/** verifyPassword with injectable spawner and helper command (tests). */
export const verifyPasswordWith = async (
  deps: PamDeps, user: string, password: string, opts: PamVerifyOptions = {},
): Promise<PamVerifyResult> => {
  if (!validUsername(user)) return fail("denied")
  // An empty password would pass for accounts PAM treats as password-less (nullok)
  if (typeof password !== "string" || password.length === 0) return fail("denied")
  const service = opts.service ?? DEFAULT_SERVICE
  if (!validService(service)) return fail("unavailable")

  const pw = Buffer.from(password, "utf8")
  if (pw.length > MAX_PASSWORD_BYTES) { pw.fill(0); return fail("denied") }

  const input: Record<string, unknown> = { service, user, password }
  if (opts.confdir !== undefined) input.confdir = opts.confdir
  const payload = Buffer.from(JSON.stringify(input), "utf8")
  pw.fill(0)
  return callHelper(deps, payload, opts)
}

/**
 * PAM's account stage alone (pam_acct_mgmt, no pam_authenticate) for `user`,
 * with injectable spawner (tests). ok only when it says PAM_SUCCESS.
 */
export const checkAccountWith = async (deps: PamDeps, user: string, opts: PamVerifyOptions = {}): Promise<PamVerifyResult> => {
  if (!validUsername(user)) return fail("denied")
  const service = opts.service ?? DEFAULT_SERVICE
  if (!validService(service)) return fail("unavailable")
  const input: Record<string, unknown> = { service, user, mode: "account" }
  if (opts.confdir !== undefined) input.confdir = opts.confdir
  return callHelper(deps, Buffer.from(JSON.stringify(input), "utf8"), opts)
}

/** checkAccountWith with the real helper. Never throws. */
export const checkAccount = (user: string, opts?: PamVerifyOptions): Promise<PamVerifyResult> =>
  checkAccountWith({}, user, opts)

// Runs the helper with `payload` on stdin (wiped after) and maps its answer
const callHelper = async (deps: PamDeps, payload: Buffer, opts: PamVerifyOptions): Promise<PamVerifyResult> => {
  const cmd = deps.helperCmd ?? [process.execPath, import.meta.path, "--helper"]
  const cap = deps.outputCap ?? HELPER_OUTPUT_CAP
  const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS

  let proc: HelperProcess
  try {
    proc = (deps.spawn ?? defaultSpawn)(cmd, { env: helperEnv(), cwd: "/" })
  } catch {
    payload.fill(0)
    return fail("unavailable")
  }

  let killed = false
  const kill = () => { if (!killed) { killed = true; try { proc.kill("SIGKILL") } catch {} } }

  try {
    proc.stdin.write(payload)
    proc.stdin.end()
  } catch {
    // The helper died before reading; its output (or lack of it) decides
  } finally {
    payload.fill(0)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs) })

  const readOutput = async (): Promise<string | "overflow"> => {
    const reader = proc.stdout.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > cap) { kill(); return "overflow" }
        chunks.push(value)
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    return Buffer.concat(chunks).toString("utf8")
  }

  try {
    const out = await Promise.race([
      Promise.all([readOutput(), proc.exited]).then(([text]) => text),
      timedOut,
    ])
    if (out === "timeout") { kill(); return fail("timeout") }
    if (out === "overflow") { kill(); return fail("unavailable") }
    const line = out.split("\n").find(l => l.trim())
    if (!line) return fail("unavailable")
    let parsed: PamHelperResult
    try { parsed = JSON.parse(line) } catch { return fail("unavailable") }
    if (!parsed || typeof parsed !== "object" || typeof parsed.code !== "number") return fail("unavailable")
    const reason = reasonFor(parsed)
    return { ok: reason === "ok", reason }
  } catch {
    kill()
    return fail("unavailable")
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Check `user`'s password through the PAM service (default "candy").
 * Never throws; every failure maps to a reason.
 */
export const verifyPassword = (user: string, password: string, opts?: PamVerifyOptions): Promise<PamVerifyResult> =>
  verifyPasswordWith({}, user, password, opts)

/** True when libpam loads and the service file exists. Never falls back to another service. */
export const pamAvailable = async (service = DEFAULT_SERVICE): Promise<boolean> => {
  if (!validService(service) || !existsSync(servicePath(service))) return false
  try {
    const lib = dlopen("libpam.so.0", { pam_strerror: { args: ["ptr", "i32"], returns: "ptr" } })
    lib.close()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Helper side: runs inside the child process

export interface Libc {
  calloc(n: number, size: number): number | null
  strdup(s: unknown): number | null
  free(p: number | null): void
}

export const loadLibc = (): Libc => dlopen("libc.so.6", {
  calloc: { args: [FFIType.u64, FFIType.u64], returns: FFIType.ptr },
  strdup: { args: [FFIType.ptr], returns: FFIType.ptr },
  free: { args: [FFIType.ptr], returns: FFIType.void },
}).symbols as unknown as Libc

/**
 * The PAM conversation function:
 *   int conv(int num_msg, const struct pam_message **msg, struct pam_response **resp, void *appdata)
 *   struct pam_message  { int msg_style; const char *msg; }   (16 bytes)
 *   struct pam_response { char *resp; int resp_retcode; }     (16 bytes)
 * Linux-PAM passes msg as an array of pointers. PAM free()s resp and each
 * resp[i].resp, so they come from libc calloc/strdup. Echo-off prompts get the
 * password, echo-on prompts the user name, info/error messages a NULL answer.
 * `password` and `user` must be NUL-terminated; the caller wipes them and
 * close()s the callback when the transaction ends.
 */
export const createConversation = (libc: Libc, password: Buffer, user: Buffer): JSCallback =>
  new JSCallback((numMsg: number, msgPtr: number, respPtrPtr: number, _appdata: number): number => {
    if (numMsg <= 0 || numMsg > 32 || !msgPtr || !respPtrPtr) return PAM.CONV_ERR
    const arr = libc.calloc(numMsg, 16)
    if (!arr) return PAM.BUF_ERR
    const view = new DataView(toArrayBuffer(arr as any, 0, numMsg * 16))
    const dups: number[] = []
    const abort = () => {
      for (const d of dups) libc.free(d)
      libc.free(arr)
      return PAM.CONV_ERR
    }
    for (let i = 0; i < numMsg; i++) {
      const m = read.ptr(msgPtr as any, i * 8)
      if (!m) return abort()
      const style = read.i32(m as any, 0)
      const answer = style === PAM_PROMPT_ECHO_OFF ? password : style === PAM_PROMPT_ECHO_ON ? user : null
      if (answer) {
        const d = libc.strdup(ptr(answer))
        if (!d) return abort()
        dups.push(d)
        view.setBigUint64(i * 16, BigInt(d), true)
      }
    }
    new DataView(toArrayBuffer(respPtrPtr as any, 0, 8)).setBigUint64(0, BigInt(arr), true)
    return PAM.SUCCESS
  }, { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 })

/** Run one PAM transaction. Exported for the helper entry point only. */
export const runPam = async (input: { service: string; user: string; password: Buffer; confdir?: string; accountOnly?: boolean }): Promise<PamHelperResult> => {
  const { service, user, password, confdir, accountOnly = false } = input
  const result = (stage: PamHelperResult["stage"], code: number, message: string): PamHelperResult =>
    ({ ok: stage === "done" && code === PAM.SUCCESS, code, message, stage })

  if (!validService(service)) return result("setup", HELPER_NO_SERVICE, "invalid PAM service name")
  if (!validUsername(user)) return result("setup", HELPER_BAD_INPUT, "invalid user name")
  // Linux-PAM falls back to "other" for a missing service; never let it
  if (!existsSync(servicePath(service, confdir))) {
    return result("setup", HELPER_NO_SERVICE, `PAM service file ${servicePath(service, confdir)} is missing`)
  }

  let pam: any
  let libc: Libc
  try {
    pam = dlopen("libpam.so.0", {
      pam_start: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      pam_authenticate: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      pam_acct_mgmt: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      pam_end: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      pam_strerror: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.cstring },
    })
    libc = loadLibc()
  } catch (e) {
    return result("setup", HELPER_NO_LIBPAM, `libpam unavailable: ${(e as Error).message}`)
  }

  let startConfdir: ((...a: any[]) => number) | null = null
  if (confdir !== undefined) {
    try {
      const lib = dlopen("libpam.so.0", {
        pam_start_confdir: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
      })
      startConfdir = lib.symbols.pam_start_confdir as any
    } catch {
      return result("setup", HELPER_NO_LIBPAM, "pam_start_confdir is not available in this libpam")
    }
  }

  // NUL-terminated copies; wiped once PAM is done with them
  const pwC = Buffer.alloc(password.length + 1)
  password.copy(pwC)
  password.fill(0)
  const userC = Buffer.from(`${user}\0`, "utf8")
  const serviceC = Buffer.from(`${service}\0`, "utf8")
  const confdirC = confdir !== undefined ? Buffer.from(`${confdir}\0`, "utf8") : null

  const conv = createConversation(libc, pwC, userC)

  const convStruct = new BigUint64Array(2)
  convStruct[0] = BigInt(conv.ptr!)
  convStruct[1] = 0n
  const handleOut = new BigUint64Array(1)

  let handle = 0
  let status: number = PAM.SUCCESS
  try {
    status = startConfdir
      ? startConfdir(ptr(serviceC), ptr(userC), ptr(convStruct), ptr(confdirC!), ptr(handleOut))
      : pam.symbols.pam_start(ptr(serviceC), ptr(userC), ptr(convStruct), ptr(handleOut))
    handle = Number(handleOut[0])
    if (status !== PAM.SUCCESS || !handle) {
      return result("start", status || PAM.SYSTEM_ERR, "pam_start failed")
    }
    const message = (code: number) => {
      try { return String(pam.symbols.pam_strerror(handle, code) ?? "") } catch { return "" }
    }
    if (!accountOnly) {
      status = pam.symbols.pam_authenticate(handle, 0)
      if (status !== PAM.SUCCESS) return result("auth", status, message(status))
    }
    status = pam.symbols.pam_acct_mgmt(handle, 0)
    if (status !== PAM.SUCCESS) return result("acct", status, message(status))
    return result("done", PAM.SUCCESS, message(PAM.SUCCESS))
  } finally {
    if (handle) pam.symbols.pam_end(handle, status)
    pwC.fill(0)
    conv.close()
  }
}

const helperMain = async () => {
  const write = async (r: PamHelperResult) => { await Bun.write(Bun.stdout, `${JSON.stringify(r)}\n`) }
  let raw: Buffer
  try {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of Bun.stdin.stream()) {
      total += chunk.length
      if (total > MAX_HELPER_INPUT) { await write({ ok: false, code: HELPER_BAD_INPUT, message: "input too large", stage: "setup" }); return }
      chunks.push(Buffer.from(chunk))
    }
    raw = Buffer.concat(chunks)
    for (const c of chunks) c.fill(0)
  } catch {
    await write({ ok: false, code: HELPER_BAD_INPUT, message: "unreadable input", stage: "setup" })
    return
  }
  let input: any
  try { input = JSON.parse(raw.toString("utf8")) } catch { input = null }
  raw.fill(0)
  const accountOnly = !!input && typeof input === "object" && input.mode === "account"
  if (!input || typeof input !== "object" || (input.mode !== undefined && !accountOnly) ||
      (accountOnly ? input.password !== undefined : typeof input.password !== "string") ||
      (input.confdir !== undefined && typeof input.confdir !== "string")) {
    await write({ ok: false, code: HELPER_BAD_INPUT, message: "bad input", stage: "setup" })
    return
  }
  const password = Buffer.from(accountOnly ? "" : input.password, "utf8")
  input.password = ""
  let r: PamHelperResult
  try {
    r = await runPam({ service: input.service, user: input.user, password, confdir: input.confdir, accountOnly })
  } catch (e) {
    r = { ok: false, code: PAM.SYSTEM_ERR, message: `helper error: ${(e as Error).message}`, stage: "setup" }
  } finally {
    password.fill(0)
  }
  await write(r)
}

if (import.meta.main && process.argv.includes("--helper")) {
  await helperMain()
  process.exit(0)
}
