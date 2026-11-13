import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CFunction, CString, FFIType, ptr, read } from "bun:ffi"
import {
  createConversation, HELPER_NO_LIBPAM, HELPER_NO_SERVICE, loadLibc, PAM, pamAvailable,
  reasonFor, validUsername, verifyPassword, verifyPasswordWith, type HelperSpawner,
} from "../pam"

// Private PAM config: pam_start_confdir (Linux-PAM >= 1.4) reads services from
// here instead of /etc/pam.d, so nothing touches a real account or password.
const confdir = join("/tmp/claude-1000/candy-pam-test", `run-${process.pid}-${Date.now()}`)
const PW = "candy-test-pw-7f3a"

beforeAll(() => {
  mkdirSync(confdir, { recursive: true })
  const svc = (name: string, body: string) => writeFileSync(join(confdir, name), body)
  svc("permit", "auth required pam_permit.so\naccount required pam_permit.so\n")
  svc("deny", "auth required pam_deny.so\naccount required pam_permit.so\n")
  // pam_access with a deny-all table: acct_mgmt returns PAM_PERM_DENIED
  writeFileSync(join(confdir, "access.conf"), "-:ALL:ALL\n")
  svc("acct-denied", `auth required pam_permit.so\naccount required pam_access.so accessfile=${confdir}/access.conf\n`)
  // pam_succeed_if failing in the account stage
  svc("acct-succeed-if", "auth required pam_permit.so\naccount required pam_succeed_if.so uid < 0\n")
  // The password really reaches PAM: pam_exec gets the authtok on stdin and
  // succeeds only for PW. An info message (pam_echo) comes first.
  const check = join(confdir, "check.sh")
  writeFileSync(check, `#!/bin/sh\npw=$(tr -d '\\000')\n[ "$pw" = "${PW}" ]\n`)
  chmodSync(check, 0o755)
  svc("check", [
    "auth optional pam_echo.so candy test info",
    `auth [success=1 default=ignore] pam_exec.so expose_authtok quiet ${check}`,
    "auth requisite pam_deny.so",
    "auth required pam_permit.so",
    "account required pam_permit.so",
    "",
  ].join("\n"))
})

afterAll(() => rmSync(confdir, { recursive: true, force: true }))

const opts = (service: string) => ({ service, confdir })

describe("verifyPassword through the helper", () => {
  it("ok when PAM permits", async () => {
    expect(await verifyPassword("someone", "x", opts("permit"))).toEqual({ ok: true, reason: "ok" })
  })

  it("denied when auth fails", async () => {
    expect(await verifyPassword("someone", "x", opts("deny"))).toEqual({ ok: false, reason: "denied" })
  })

  it("passes the password through the conversation (echo-off) and ignores info messages", async () => {
    expect(await verifyPassword("someone", PW, opts("check"))).toEqual({ ok: true, reason: "ok" })
    expect(await verifyPassword("someone", `${PW}x`, opts("check"))).toEqual({ ok: false, reason: "denied" })
  })

  it("account when acct_mgmt returns PERM_DENIED", async () => {
    expect(await verifyPassword("nobody", "x", opts("acct-denied"))).toEqual({ ok: false, reason: "account" })
  })

  it("account when pam_succeed_if rejects in the account stage", async () => {
    expect(await verifyPassword("nobody", "x", opts("acct-succeed-if"))).toEqual({ ok: false, reason: "account" })
  })

  it("denied when the account step doesn't know the user", async () => {
    expect(await verifyPassword("candy-no-such-user", "x", opts("acct-succeed-if"))).toEqual({ ok: false, reason: "denied" })
  })

  it("unavailable when the service file is missing, without falling back to other", async () => {
    writeFileSync(join(confdir, "other"), "auth required pam_permit.so\naccount required pam_permit.so\n")
    try {
      expect(await verifyPassword("someone", "x", opts("no-such-service"))).toEqual({ ok: false, reason: "unavailable" })
    } finally {
      rmSync(join(confdir, "other"))
    }
  })

  it("unavailable for a malformed service name", async () => {
    expect(await verifyPassword("someone", "x", opts("../etc/x"))).toEqual({ ok: false, reason: "unavailable" })
  })

  it("pamAvailable is false for a missing service", async () => {
    expect(await pamAvailable("candy-no-such-service-xyz")).toBe(false)
    expect(await pamAvailable("../passwd")).toBe(false)
  })
})

describe("helper process limits", () => {
  it("times out a slow helper and kills it", async () => {
    const t0 = Date.now()
    const r = await verifyPasswordWith(
      { helperCmd: [process.execPath, "-e", "await Bun.sleep(30000)"] },
      "someone", "x", { timeoutMs: 300 },
    )
    expect(r).toEqual({ ok: false, reason: "timeout" })
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it("caps the helper's output", async () => {
    const t0 = Date.now()
    const r = await verifyPasswordWith(
      { helperCmd: [process.execPath, "-e", "process.stdout.write('x'.repeat(200000)); await Bun.sleep(30000)"] },
      "someone", "x", { timeoutMs: 8000 },
    )
    expect(r).toEqual({ ok: false, reason: "unavailable" })
    expect(Date.now() - t0).toBeLessThan(7000)
  }, 15000)

  it("treats garbage output and a crash as unavailable", async () => {
    expect(await verifyPasswordWith({ helperCmd: [process.execPath, "-e", "console.log('nope')"] }, "someone", "x"))
      .toEqual({ ok: false, reason: "unavailable" })
    expect(await verifyPasswordWith({ helperCmd: [process.execPath, "-e", "process.exit(3)"] }, "someone", "x"))
      .toEqual({ ok: false, reason: "unavailable" })
  })
})

describe("input validation", () => {
  const neverSpawn: HelperSpawner = () => { throw new Error("must not spawn") }

  it("denies invalid user names and root without running PAM", async () => {
    for (const user of ["root", "", "-rf", "a b", "x/y", "ü", "a".repeat(40), "1abc", "a\nb", "a:b"]) {
      expect(await verifyPasswordWith({ spawn: neverSpawn }, user, "x", opts("permit"))).toEqual({ ok: false, reason: "denied" })
    }
    expect(validUsername("alice")).toBe(true)
    expect(validUsername("machine$")).toBe(true)
    expect(validUsername("root")).toBe(false)
  })

  it("denies an empty password without running PAM", async () => {
    expect(await verifyPasswordWith({ spawn: neverSpawn }, "someone", "", opts("permit"))).toEqual({ ok: false, reason: "denied" })
  })

  it("never puts the password in argv or env", async () => {
    const calls: { cmd: string[]; env: Record<string, string> }[] = []
    const spy: HelperSpawner = (cmd, o) => {
      calls.push({ cmd, env: o.env })
      return Bun.spawn(cmd, { env: o.env, cwd: o.cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" }) as any
    }
    const r = await verifyPasswordWith({ spawn: spy }, "someone", PW, opts("check"))
    expect(r).toEqual({ ok: true, reason: "ok" })
    expect(calls).toHaveLength(1)
    const { cmd, env } = calls[0]
    expect(cmd).toEqual([process.execPath, join(import.meta.dir, "..", "pam.ts"), "--helper"])
    expect(cmd.join(" ")).not.toContain(PW)
    expect(Object.keys(env).sort()).toEqual(["LANG", "PATH"])
    expect(JSON.stringify(env)).not.toContain(PW)
  })
})

describe("reasonFor", () => {
  const r = (stage: any, code: number, ok = false) => reasonFor({ ok, code, message: "", stage })
  it("maps PAM codes to reasons", () => {
    expect(r("done", PAM.SUCCESS, true)).toBe("ok")
    expect(r("auth", PAM.AUTH_ERR)).toBe("denied")
    expect(r("auth", PAM.USER_UNKNOWN)).toBe("denied")
    expect(r("auth", PAM.MAXTRIES)).toBe("denied")
    expect(r("acct", PAM.ACCT_EXPIRED)).toBe("account")
    expect(r("acct", PAM.NEW_AUTHTOK_REQD)).toBe("account")
    expect(r("acct", PAM.PERM_DENIED)).toBe("account")
    expect(r("acct", PAM.USER_UNKNOWN)).toBe("denied")
    expect(r("setup", HELPER_NO_SERVICE)).toBe("unavailable")
    expect(r("setup", HELPER_NO_LIBPAM)).toBe("unavailable")
    expect(r("start", PAM.SYSTEM_ERR)).toBe("unavailable")
    expect(r("auth", PAM.SYSTEM_ERR)).toBe("unavailable")
    expect(r("done", PAM.SUCCESS, false)).toBe("unavailable")
  })
})

describe("conversation callback", () => {
  it("answers echo-off with the password, echo-on with the user, info with NULL, for num_msg > 1", () => {
    const libc = loadLibc()
    const pw = Buffer.from("s3cret\0")
    const user = Buffer.from("alice\0")
    const conv = createConversation(libc, pw, user)
    const call = CFunction({ ptr: conv.ptr!, args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 })

    const texts = ["Login:", "Password:", "hello", "oops"].map(t => Buffer.from(`${t}\0`))
    const styles = [2, 1, 4, 3] // ECHO_ON, ECHO_OFF, TEXT_INFO, ERROR_MSG
    const msgs = styles.map((style, i) => {
      const m = Buffer.alloc(16)
      m.writeInt32LE(style, 0)
      m.writeBigUInt64LE(BigInt(ptr(texts[i])), 8)
      return m
    })
    const msgPtrs = new BigUint64Array(msgs.map(m => BigInt(ptr(m))))
    const respOut = new BigUint64Array(1)

    expect(call(styles.length, ptr(msgPtrs), ptr(respOut), null)).toBe(PAM.SUCCESS)
    const arr = Number(respOut[0])
    expect(arr).not.toBe(0)
    const answers = styles.map((_, i) => {
      const p = read.ptr(arr as any, i * 16)
      return p ? new CString(p as any).toString() : null
    })
    expect(answers).toEqual(["alice", "s3cret", null, null])
    for (let i = 0; i < styles.length; i++) {
      expect(read.i32(arr as any, i * 16 + 8)).toBe(0)
      const p = read.ptr(arr as any, i * 16)
      if (p) libc.free(p)
    }
    libc.free(arr)

    expect(call(0, ptr(msgPtrs), ptr(respOut), null)).toBe(PAM.CONV_ERR)
    conv.close()
  })
})
