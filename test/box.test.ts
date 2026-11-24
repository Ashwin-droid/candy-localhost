import { describe, expect, it } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BOX_ENV_CREDENTIAL, BOX_INIT, BOX_INIT_REFUSED, DEFAULT_BOX_TASKS, ISOLATION_PROPERTIES, MAX_BOXES, MAX_BOX_GRANTS, MAX_BOX_ISOLATION, MAX_BOX_TASKS, MAX_BOX_SECONDS,
  boxAuditLine, boxEnvFile, boxExitCause, boxProperties, boxRunCommand, cwdProblem, grantProblem, isolationProblem,
  parseBoxRequest, parseRunSummary, validateBoxQuota,
  type BoxParent, type BoxRequest, type BoxUnit, type RunSummary,
} from "../box.ts"
import { HARDENING, MAX_MEMORY_MB, memoryProperties } from "../sandbox.ts"

const quota = { max: 4, memory: 1024 }
const ok = (body: Record<string, unknown>): BoxRequest => {
  const r = parseBoxRequest({ cmd: ["/bin/true"], ...body }, quota)
  if ("error" in r) throw new Error(`expected a request, got: ${r.error}`)
  return r
}
const refused = (body: unknown, q = quota): string => {
  // Every field but cmd is tested with a good cmd, so the refusal is about that field
  const whole = body && typeof body === "object" && !Array.isArray(body) && !("cmd" in body) ? { cmd: ["/bin/true"], ...body } : body
  const r = parseBoxRequest(whole, q)
  if (!("error" in r)) throw new Error(`expected a refusal for ${JSON.stringify(body)}`)
  return r.error
}

const unit = (over: Partial<BoxRequest> = {}): BoxUnit => ({
  site: "wa", unit: "candy-box-wa-abc123.service", uid: 1001, gid: 1001,
  parentUnit: "candy-wa-def456.service",
  request: { ...ok({}), ...over },
  hidden: ["/var/lib/candy", "/srv"],
})

const nameOf = (prop: string) => prop.slice(0, prop.indexOf("="))

// ---------------------------------------------------------------------------

describe("validateBoxQuota", () => {
  it("takes a whole max from 1 to MAX_BOXES and a memory in range", () => {
    expect(validateBoxQuota({ max: 1, memory: 64 })).toEqual({ max: 1, memory: 64 })
    expect(validateBoxQuota({ max: MAX_BOXES, memory: "2G" })).toEqual({ max: MAX_BOXES, memory: 2048 })
    expect(validateBoxQuota({ max: 3, memory: "16G" })).toEqual({ max: 3, memory: MAX_MEMORY_MB })
  })
  it("refuses anything else", () => {
    for (const raw of [null, undefined, 5, "x", [], {}, { max: 1 }, { memory: 512 },
      { max: 0, memory: 512 }, { max: MAX_BOXES + 1, memory: 512 }, { max: 1.5, memory: 512 }, { max: "2", memory: 512 },
      { max: -1, memory: 512 }, { max: NaN, memory: 512 }, { max: Infinity, memory: 512 },
      { max: 1, memory: 63 }, { max: 1, memory: "17G" }, { max: 1, memory: "lots" }, { max: 1, memory: null }, { max: 1, memory: true }]) {
      expect(validateBoxQuota(raw)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------

describe("parseBoxRequest", () => {
  it("fills in defaults: memory is the quota, tasks the default, cwd /", () => {
    const r = ok({})
    expect(r).toEqual({ cmd: ["/bin/true"], cwd: "/", env: {}, grants: [], memory: 1024, cpu: null, tasks: DEFAULT_BOX_TASKS, seconds: null, isolation: [], label: null })
    // null means the default too
    expect(ok({ env: null, grants: null, cwd: null, memory: null, cpu: null, tasks: null, seconds: null, isolation: null, label: null })).toEqual(r)
  })

  it("refuses bodies that aren't objects", () => {
    for (const b of [null, undefined, 3, "x", []]) expect(refused(b)).toContain('"cmd"')
  })

  describe("cmd", () => {
    it("takes an absolute program and any arguments, untouched", () => {
      const args = ["/usr/bin/env", "a b", "$HOME", "%n", "'q'", '"d"', "", "--x=y", "\n", "日本"]
      expect(ok({ cmd: args }).cmd).toEqual(args)
    })
    it("refuses a relative or empty program", () => {
      for (const c of [["bun"], ["./x"], ["../bin/x"], [""], ["~/bin/x"]]) expect(refused({ cmd: c })).toContain("absolute path")
    })
    it("refuses non-lists, empty lists, non-text, NUL bytes, too many or too large", () => {
      for (const c of [undefined, null, "/bin/true", {}, [], [1], ["/bin/true", 2], ["/bin/true", null], ["/bin/tr\0ue"], ["/bin/true", "a\0b"]]) {
        expect(refused({ cmd: c })).toContain('"cmd"')
      }
      expect(refused({ cmd: ["/bin/true", ...Array(1024).fill("a")] })).toContain('"cmd"')
      expect(refused({ cmd: ["/bin/true", "a".repeat(128 * 1024)] })).toContain("KB")
      expect(ok({ cmd: ["/bin/true", ...Array(1023).fill("a")] }).cmd.length).toBe(1024)
    })
  })

  describe("env", () => {
    it("takes variable names with text values, tabs and newlines included", () => {
      expect(ok({ env: { A: "1", _b: "", c_9: "x\ty\nz", U: "日本 $X `id`" } }).env).toEqual({ A: "1", _b: "", c_9: "x\ty\nz", U: "日本 $X `id`" })
    })
    it("refuses names that aren't variable names", () => {
      for (const k of ["1A", "A-B", "A=B", "A B", "", "A\0", "A\n", "Ä", "--setenv"]) expect(refused({ env: { [k]: "x" } })).toContain("variable name")
    })
    it("refuses non-text values and control characters other than tab and newline", () => {
      for (const v of [1, null, true, {}, ["x"], "a\0b", "a\rb", "a\x1bb", "a\x7fb", "\x01", "\x0b", "\x0c"]) expect(refused({ env: { A: v } })).toContain("env")
    })
    it("refuses non-objects", () => {
      for (const e of ["A=1", ["A=1"], 3]) expect(refused({ env: e })).toContain('"env"')
    })
    it("refuses too many or too large", () => {
      const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`V${i}`, "x"]))
      expect(refused({ env: many })).toContain("256")
      expect(refused({ env: { A: "x".repeat(128 * 1024) } })).toContain("KB")
      expect(Object.keys(ok({ env: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`V${i}`, "x"])) }).env).length).toBe(256)
    })
  })

  describe("grants", () => {
    it("takes absolute, normal paths with a mode", () => {
      expect(ok({ grants: [{ path: "/home/u/proj/data", mode: "rw" }, { path: "/opt/models", mode: "ro" }, { path: "/a-b_c.d/e+f@g,h=i~j", mode: "ro" }] }).grants)
        .toEqual([{ path: "/home/u/proj/data", mode: "rw" }, { path: "/opt/models", mode: "ro" }, { path: "/a-b_c.d/e+f@g,h=i~j", mode: "ro" }])
    })
    it("refuses paths that aren't absolute and normal", () => {
      for (const p of ["data", "./data", "/a/../b", "/a/./b", "/a//b", "/a/", "//a", "/a/..", "/.", "", 3, null, undefined, "/" + "a".repeat(1024)]) {
        expect(refused({ grants: [{ path: p, mode: "ro" }] })).toContain("absolute path")
      }
    })
    it("refuses anything systemd would read as syntax: spaces, colons, quotes, %, $, globs, backslashes, control characters", () => {
      for (const p of ["/a b", "/a:b", "/a:/etc:rbind", "/a'b", '/a"b', "/a%h", "/a$HOME", "/a*", "/a?", "/a[1]", "/a]", "/a\\b", "/a\tb", "/a\nb", "/a\0b", "/a\x7fb", "/a\rb"]) {
        expect(refused({ grants: [{ path: p, mode: "ro" }] })).toContain("can't contain")
      }
    })
    it("needs a mode of ro or rw", () => {
      for (const m of [undefined, "r", "RW", "rwx", true, 1]) expect(refused({ grants: [{ path: "/a", mode: m }] })).toContain('"mode"')
    })
    it("refuses a path granted twice, even with another mode", () => {
      expect(refused({ grants: [{ path: "/a", mode: "ro" }, { path: "/a", mode: "rw" }] })).toContain("twice")
    })
    it("refuses non-lists, non-objects and too many", () => {
      expect(refused({ grants: { path: "/a", mode: "ro" } })).toContain('"grants"')
      expect(refused({ grants: ["/a"] })).toContain("absolute path")
      expect(refused({ grants: [null] })).toContain("absolute path")
      const many = Array.from({ length: MAX_BOX_GRANTS + 1 }, (_, i) => ({ path: `/g${i}`, mode: "ro" }))
      expect(refused({ grants: many })).toContain('"grants"')
      expect(ok({ grants: many.slice(0, MAX_BOX_GRANTS) }).grants.length).toBe(MAX_BOX_GRANTS)
    })
  })

  describe("cwd", () => {
    it("takes an absolute, normal path", () => {
      expect(ok({ cwd: "/home/u/proj" }).cwd).toBe("/home/u/proj")
      expect(ok({ cwd: "/" }).cwd).toBe("/")
    })
    it("refuses everything pathProblem refuses", () => {
      for (const c of ["proj", "/a/../b", "/a/", "/a b", "/a:b", "/a%n", "/a$X", "/a\0", "", 7]) expect(refused({ cwd: c })).toContain('"cwd"')
    })
  })

  describe("memory", () => {
    it("takes MB or text up to the quota", () => {
      expect(ok({ memory: 512 }).memory).toBe(512)
      expect(ok({ memory: "1G" }).memory).toBe(1024)
      expect(ok({ memory: "64M" }).memory).toBe(64)
    })
    it("refuses more than the operator's quota, and nonsense", () => {
      expect(refused({ cmd: ["/bin/true"], memory: 1025 })).toContain("more than a box of this site may have")
      expect(refused({ cmd: ["/bin/true"], memory: "2G" })).toContain("more than")
      expect(refused({ cmd: ["/bin/true"], memory: "16G" }, { max: 1, memory: 15 * 1024 })).toContain("more than")
      for (const m of [0, 63, -1, "17G", "1T", "lots", true, {}, NaN]) expect(refused({ cmd: ["/bin/true"], memory: m })).toContain('"memory"')
    })
  })

  describe("cpu, tasks, seconds", () => {
    it("take whole numbers in range", () => {
      expect(ok({ cpu: 150, tasks: 10, seconds: 60 })).toMatchObject({ cpu: 150, tasks: 10, seconds: 60 })
      expect(ok({ cpu: 1, tasks: 1, seconds: 1 })).toMatchObject({ cpu: 1, tasks: 1, seconds: 1 })
      expect(ok({ cpu: 6400, tasks: MAX_BOX_TASKS, seconds: MAX_BOX_SECONDS })).toMatchObject({ cpu: 6400, tasks: MAX_BOX_TASKS, seconds: MAX_BOX_SECONDS })
    })
    it("refuse anything else", () => {
      for (const key of ["cpu", "tasks", "seconds"]) {
        for (const v of [0, -1, 1.5, "10", true, NaN, Infinity, {}]) expect(refused({ cmd: ["/bin/true"], [key]: v })).toContain(`"${key}"`)
      }
      expect(refused({ cmd: ["/bin/true"], cpu: 6401 })).toContain('"cpu"')
      expect(refused({ cmd: ["/bin/true"], tasks: MAX_BOX_TASKS + 1 })).toContain('"tasks"')
      expect(refused({ cmd: ["/bin/true"], seconds: MAX_BOX_SECONDS + 1 })).toContain('"seconds"')
    })
  })

  describe("isolation", () => {
    it("takes lines from the list", () => {
      expect(ok({ isolation: ["PrivateNetwork=yes", "SystemCallFilter=@system-service"] }).isolation).toEqual(["PrivateNetwork=yes", "SystemCallFilter=@system-service"])
    })
    it("refuses lines isolationProblem refuses, non-lists and too many", () => {
      expect(refused({ cmd: ["/bin/true"], isolation: ["User=root"] })).toContain("refused")
      expect(refused({ cmd: ["/bin/true"], isolation: "PrivateNetwork=yes" })).toContain('"isolation"')
      expect(refused({ cmd: ["/bin/true"], isolation: [3] })).toContain("isolation line")
      expect(refused({ cmd: ["/bin/true"], isolation: Array(MAX_BOX_ISOLATION + 1).fill("PrivateNetwork=yes") })).toContain('"isolation"')
      expect(ok({ isolation: Array(MAX_BOX_ISOLATION).fill("PrivateNetwork=yes") }).isolation.length).toBe(MAX_BOX_ISOLATION)
    })
  })

  describe("label", () => {
    it("takes up to 80 characters of plain text", () => {
      expect(ok({ label: "worker #1 (ä)" }).label).toBe("worker #1 (ä)")
      expect(ok({ label: "x".repeat(80) }).label).toBe("x".repeat(80))
    })
    it("refuses longer, control characters and non-text", () => {
      for (const l of ["x".repeat(81), "a\nb", "a\tb", "a\0", "a\x1b[31m", "a\x7f", 3, ["a"]]) expect(refused({ cmd: ["/bin/true"], label: l })).toContain('"label"')
    })
  })
})

// ---------------------------------------------------------------------------

describe("isolationProblem", () => {
  it("accepts every ISOLATION_PROPERTIES name", () => {
    for (const name of ISOLATION_PROPERTIES) {
      expect(isolationProblem(`${name}=yes`)).toBeNull()
      expect(isolationProblem(`${name}=`)).toBeNull()
    }
  })

  it("refuses everything that would undo or change what candy sets", () => {
    for (const line of [
      "User=root", "Group=root", "DynamicUser=yes", "SupplementaryGroups=wheel", "BindPaths=/etc", "BindReadOnlyPaths=/root",
      "ReadWritePaths=/", "TemporaryFileSystem=/x", "ProtectSystem=no", "PrivateTmp=no", "ProtectHome=no", "ProtectHome=",
      "NoNewPrivileges=no", "CapabilityBoundingSet=CAP_SYS_ADMIN", "CapabilityBoundingSet=", "AmbientCapabilities=CAP_SYS_ADMIN",
      "ExecStartPre=/bin/sh -c id", "ExecStartPost=/bin/x", "ExecStopPost=/bin/x", "RootDirectory=/", "RootImage=/x",
      "MemoryMax=infinity", "MemoryHigh=infinity", "MemorySwapMax=infinity", "CPUQuota=", "TasksMax=infinity", "RuntimeMaxSec=infinity",
      "PrivatePIDs=no", "BindsTo=", "After=", "Environment=LD_PRELOAD=/x", "EnvironmentFile=/etc/shadow", "PassEnvironment=PATH",
      "LoadCredential=x:/etc/shadow", "SetCredential=x:y", "PAMName=login", "WorkingDirectory=/root", "OOMPolicy=continue",
      "OOMScoreAdjust=-1000", "CPUWeight=10000", "IOWeight=10000", "StartupCPUWeight=10000", "TimeoutStopSec=infinity", "Slice=-.slice", "Delegate=yes", "KeyringMode=shared", "ProtectKernelTunables=no",
      "SystemCallArchitectures=", "PrivateDevices=no", "DeviceAllow=/dev/sda rw", "RestrictSUIDSGID=no", "Personality=x86",
      "StandardInput=file:/etc/shadow", "StandardOutput=file:/etc/x", "UtmpIdentifier=x", "IPAccounting=yes", "Nice=-20",
      "privatenetwork=yes", "PRIVATENETWORK=yes",
    ]) expect(isolationProblem(line)).not.toBeNull()
  })

  it("names the right way to ask for limits and folders", () => {
    expect(isolationProblem("MemoryMax=1G")).toContain('"memory"')
    expect(isolationProblem("CPUQuota=200%")).toContain('"cpu"')
    expect(isolationProblem("TasksMax=10")).toContain('"tasks"')
    expect(isolationProblem("RuntimeMaxSec=5")).toContain('"seconds"')
    expect(isolationProblem("BindPaths=/x")).toContain('"grants"')
  })

  it("refuses newlines and control characters anywhere", () => {
    for (const line of ["PrivateNetwork=yes\nUser=root", "PrivateNetwork=yes\r\nUser=root", "PrivateNetwork=yes\0", "InaccessiblePaths=/a\tb", "UMask=\x1b0077", "ProtectProc=\x7f", "PrivateNetwork\n=yes"]) {
      expect(isolationProblem(line)).not.toBeNull()
    }
  })

  it("refuses lines without a name and =", () => {
    for (const line of ["PrivateNetwork", "=yes", "", " PrivateNetwork=yes", "PrivateNetwork =yes", "-PrivateNetwork=yes"]) expect(isolationProblem(line)).not.toBeNull()
  })

  it("refuses names with odd characters, and non-text", () => {
    for (const line of ["Private-Network=yes", "Private.Network=yes", "Private_Network=yes", "9Lives=yes", "Ünicode=yes", "Private Network=yes", "X-Foo=bar", "PrivateNetwork:yes"]) {
      expect(isolationProblem(line)).not.toBeNull()
    }
    for (const v of [null, undefined, 3, {}, ["PrivateNetwork=yes"]]) expect(isolationProblem(v)).not.toBeNull()
    expect(isolationProblem("PrivateNetwork=" + "y".repeat(2048))).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe("grantProblem", () => {
  const sandboxed: BoxParent = { writable: ["/home/u/proj", "/var/lib/candy/wa", "/tmp/demo"], privateTmp: true }
  const open: BoxParent = { writable: ["/"], privateTmp: false }

  it("refuses whole trees, whoever asks", () => {
    for (const p of ["/", "/home", "/root", "/etc", "/usr", "/var", "/run", "/proc", "/sys", "/dev", "/boot", "/var/lib/candy"]) {
      expect(grantProblem(p, "ro", open, true)).toContain("whole tree")
      expect(grantProblem(p, "ro", sandboxed, true)).not.toBeNull()
    }
  })

  it("refuses kernel filesystems and /run, anything under them", () => {
    for (const p of ["/proc/1/root", "/proc/self/mem", "/sys/fs/cgroup", "/dev/sda", "/dev/shm/x", "/run/candy", "/run/candy/box/x", "/run/user/1000", "/run/systemd/private", "/run/dbus/system_bus_socket"]) {
      expect(grantProblem(p, "ro", open, true)).not.toBeNull()
      expect(grantProblem(p, "rw", open, true)).not.toBeNull()
    }
  })

  it("allows rw only inside what the site may write", () => {
    expect(grantProblem("/home/u/proj", "rw", sandboxed, true)).toBeNull()
    expect(grantProblem("/home/u/proj/data", "rw", sandboxed, true)).toBeNull()
    expect(grantProblem("/var/lib/candy/wa/cache", "rw", sandboxed, true)).toBeNull()
    expect(grantProblem("/home/u", "rw", sandboxed, true)).toContain("read-write")
    expect(grantProblem("/home/u/projector", "rw", sandboxed, true)).toContain("read-write")
    expect(grantProblem("/home/u/.bashrc", "rw", sandboxed, true)).toContain("read-write")
    expect(grantProblem("/var/lib/candy/other", "rw", sandboxed, true)).toContain("read-write")
    expect(grantProblem("/opt/models", "rw", sandboxed, true)).toContain("read-write")
  })

  it("allows ro anywhere the site's user can read, never where it can't", () => {
    expect(grantProblem("/opt/models", "ro", sandboxed, true)).toBeNull()
    expect(grantProblem("/home/u/.config", "ro", sandboxed, true)).toBeNull()
    expect(grantProblem("/opt/models", "ro", sandboxed, false)).toContain("can read")
    expect(grantProblem("/home/u/proj/data", "rw", sandboxed, false)).toContain("can read")
  })

  it("refuses the machine's /tmp to a site with a private /tmp, except a writable path in it", () => {
    for (const p of ["/tmp/x", "/tmp/.X11-unix", "/var/tmp/x", "/tmp/demox"]) {
      expect(grantProblem(p, "ro", sandboxed, true)).toContain("/tmp")
      expect(grantProblem(p, "rw", sandboxed, true)).toContain("/tmp")
    }
    expect(grantProblem("/tmp/demo", "rw", sandboxed, true)).toBeNull()
    expect(grantProblem("/tmp/demo/sub", "ro", sandboxed, true)).toBeNull()
    expect(grantProblem("/tmp/x", "rw", open, true)).toBeNull()
  })

  it("a site with no sandbox (writable /) may grant rw anything it can read that isn't refused", () => {
    expect(grantProblem("/home/u/anything", "rw", open, true)).toBeNull()
    expect(grantProblem("/opt/x", "rw", open, true)).toBeNull()
    expect(grantProblem("/opt/x", "rw", open, false)).not.toBeNull()
    expect(grantProblem("/etc", "rw", open, true)).not.toBeNull()
  })
})

describe("cwdProblem", () => {
  it("allows a cwd the box sees", () => {
    for (const c of ["/", "/usr/lib", "/opt/x", "/var/lib", "/homework"]) expect(cwdProblem(c, [])).toBeNull()
  })
  it("refuses a hidden folder unless a grant puts it back", () => {
    for (const c of ["/home", "/home/u/proj", "/root", "/run/user/1000", "/run/candy", "/var/lib/candy/wa", "/mnt/x", "/media", "/srv/www", "/tmp", "/tmp/x", "/var/tmp/y"]) {
      expect(cwdProblem(c, [])).toContain("doesn't see")
    }
    expect(cwdProblem("/home/u/proj", [{ path: "/home/u/proj", mode: "ro" }])).toBeNull()
    expect(cwdProblem("/home/u/proj/src", [{ path: "/home/u/proj", mode: "rw" }])).toBeNull()
    expect(cwdProblem("/home/u/projector", [{ path: "/home/u/proj", mode: "rw" }])).not.toBeNull()
    expect(cwdProblem("/tmp/demo", [{ path: "/tmp/demo", mode: "rw" }])).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe("boxProperties", () => {
  const full = unit({
    memory: 512, cpu: 150, seconds: 30, tasks: 77,
    grants: [{ path: "/home/u/proj", mode: "rw" }, { path: "/opt/models", mode: "ro" }],
    isolation: ["PrivateNetwork=yes", "SystemCallFilter=@system-service"],
  })
  const props = boxProperties(full)

  it("starts from every HARDENING entry", () => {
    for (const h of HARDENING) expect(props).toContain(h)
    expect(props.slice(0, HARDENING.length)).toEqual([...HARDENING])
  })

  it("hides the homes, the hidden folders and other processes", () => {
    expect(props).toContain("ProtectHome=tmpfs")
    expect(props).toContain("TemporaryFileSystem=/var/lib/candy:ro")
    expect(props).toContain("TemporaryFileSystem=/srv:ro")
    expect(props).toContain("PrivatePIDs=yes")
  })

  it("sets the limits", () => {
    for (const m of memoryProperties(512)) expect(props).toContain(m)
    expect(props).toContain("TasksMax=77")
    expect(props).toContain("CPUQuota=150%")
    expect(props).toContain("RuntimeMaxSec=30")
    expect(props).toContain("OOMPolicy=stop")
    const bare = boxProperties(unit())
    expect(bare).toContain("MemoryMax=1024M")
    expect(bare).toContain(`TasksMax=${DEFAULT_BOX_TASKS}`)
    expect(bare.some(p => p.startsWith("CPUQuota="))).toBe(false)
    expect(bare.some(p => p.startsWith("RuntimeMaxSec="))).toBe(false)
  })

  it("is bound to the site's unit", () => {
    expect(props).toContain("BindsTo=candy-wa-def456.service")
    expect(props).toContain("After=candy-wa-def456.service")
  })

  it("has nothing on the isolation list that gives a box more of the machine", () => {
    for (const name of ["CPUWeight", "IOWeight", "StartupCPUWeight", "Nice", "OOMScoreAdjust", "CPUQuota", "MemoryMax", "TasksMax"]) expect(ISOLATION_PROPERTIES).not.toContain(name)
  })

  it("binds a grant from its real path to the path the site named", () => {
    const p = boxProperties(unit({ grants: [{ path: "/home/u/proj/current", source: "/home/u/proj/releases/5", mode: "ro", check: "1:2" }, { path: "/home/u/data", source: "/home/u/data", mode: "rw", check: "1:3" }] }))
    expect(p).toContain("BindReadOnlyPaths=/home/u/proj/releases/5:/home/u/proj/current")
    expect(p).toContain("BindPaths=/home/u/data")
  })

  it("turns grants into BindPaths / BindReadOnlyPaths", () => {
    expect(props).toContain("BindPaths=/home/u/proj")
    expect(props).toContain("BindReadOnlyPaths=/opt/models")
    expect(props.filter(p => p.startsWith("Bind") && !p.startsWith("BindsTo="))).toEqual(["BindPaths=/home/u/proj", "BindReadOnlyPaths=/opt/models"])
  })

  it("puts the site's isolation lines last", () => {
    expect(props.slice(-2)).toEqual(["PrivateNetwork=yes", "SystemCallFilter=@system-service"])
  })

  it("never sets the same property twice from candy's side and the site's list", () => {
    const own = new Set(boxProperties(unit({ cpu: 1, seconds: 1, grants: [{ path: "/a", mode: "rw" }, { path: "/b", mode: "ro" }] })).map(nameOf))
    for (const name of ISOLATION_PROPERTIES) expect(own.has(name)).toBe(false)
  })

  it("throws on an isolation line that names something it sets, or isn't on the list (parseBoxRequest bypassed)", () => {
    for (const line of ["ProtectSystem=no", "PrivatePIDs=no", "MemoryMax=infinity", "BindsTo=", "User=root", "BindPaths=/etc", "ProtectHome=no", "NoNewPrivileges=no", "Environment=A=1", "privatenetwork=yes", "PrivateNetwork"]) {
      expect(() => boxProperties(unit({ isolation: [line] }))).toThrow("isolation line refused")
    }
  })
})

// ---------------------------------------------------------------------------

/** What the daemon records for a granted path: device and inode, as stat -c %d:%i prints them */
const checkOf = (path: string) => { const st = lstatSync(path, { bigint: true }); return `${st.dev}:${st.ino}` }

describe("boxRunCommand", () => {
  const secrets = { SECRET_TOKEN: "s3cr3t-VALUE-zq81", OTHER: "another-distinct-val-7731", MULTI: "line-a\nline-b-9913" }
  const args = ["/usr/bin/node", "a b", "$HOME", "%n", "'single'", '"double"', "${X}", "--", "--flag=1", "\\x", ""]
  const box = unit({
    cmd: args, env: secrets, cwd: "/home/u/proj", label: "worker\u00e9 1",
    grants: [{ path: "/home/u/proj", mode: "rw", check: "2049:131" }, { path: "/opt/models", mode: "ro", source: "/data/models", check: "2050:7" }],
    isolation: ["PrivateNetwork=yes"],
  })
  const cmd = boxRunCommand(box, "/run/candy/box/abc.env")
  const first = cmd.indexOf("--")

  it("never has an env key or value in the argv", () => {
    const all = cmd.join("\0")
    for (const [k, v] of Object.entries(secrets)) {
      expect(all).not.toContain(v)
      expect(all).not.toContain(k)
    }
    expect(cmd.some(a => a.startsWith("--setenv") || a.startsWith("-E") || a.startsWith("--property=Environment"))).toBe(false)
  })

  it("hands the environment over as the box-env credential", () => {
    expect(BOX_ENV_CREDENTIAL).toBe("box-env")
    expect(cmd).toContain("--property=LoadCredential=box-env:/run/candy/box/abc.env")
  })

  it("asks systemd not to expand anything, and waits for the unit", () => {
    expect(cmd[0]).toBe("systemd-run")
    for (const f of ["--expand-environment=no", "--collect", "--wait", "--pipe", "--service-type=exec", "--uid=1001", "--gid=1001",
      "--unit=candy-box-wa-abc123.service", "--slice=candy.slice", "--working-directory=/home/u/proj"]) expect(cmd).toContain(f)
    expect(cmd).not.toContain("--quiet")
    expect(boxRunCommand(box, "/x", "/usr/bin/systemd-run")[0]).toBe("/usr/bin/systemd-run")
  })

  it("puts every property on a --property= before the first --", () => {
    const props = cmd.slice(0, first).filter(a => a.startsWith("--property=")).map(a => a.slice("--property=".length))
    expect(props).toEqual(["LoadCredential=box-env:/run/candy/box/abc.env", ...boxProperties(box)])
    expect(cmd.slice(0, first).every(a => a.startsWith("-") || a === "systemd-run")).toBe(true)
  })

  it("keeps the label printable in the description", () => {
    expect(cmd).toContain("--description=candy box of wa: worker? 1")
    const evil = boxRunCommand(unit({ label: "x\u202e\u0085y" }), "/x")
    expect(evil.find(a => a.startsWith("--description="))).toBe("--description=candy box of wa: x??y")
  })

  it("ends with --, the init shell, each grant's check and path, --, and the command untouched", () => {
    expect(cmd.slice(first)).toEqual(["--", "/bin/sh", "-c", BOX_INIT, "candy-box", "2049:131", "/home/u/proj", "2050:7", "/opt/models", "--", ...args])
    const none = boxRunCommand(unit({ cmd: ["/bin/true", "--"] }), "/x")
    expect(none.slice(none.indexOf("--"))).toEqual(["--", "/bin/sh", "-c", BOX_INIT, "candy-box", "--", "/bin/true", "--"])
  })

  it("throws on a grant nobody checked, or a check that isn't device:inode", () => {
    for (const check of [undefined, "", "1:", ":1", "1:2:3", "a:b", "1:2\n", " 1:2", "--", "-1:2"]) {
      expect(() => boxRunCommand(unit({ grants: [{ path: "/a", mode: "ro", check }] }), "/x")).toThrow("never checked")
    }
  })

  it("throws rather than build a command with a forbidden isolation line", () => {
    expect(() => boxRunCommand(unit({ isolation: ["User=root"] }), "/x")).toThrow()
  })
})

describe("boxEnvFile", () => {
  it("writes export NAME='value' lines, a quote as '\\''", () => {
    expect(boxEnvFile({ A: "1", B: "it's", C: "" })).toBe("export A='1'\nexport B='it'\\''s'\nexport C=''\n")
    expect(boxEnvFile({})).toBe("")
  })
  it("throws on a bad name or a NUL", () => {
    for (const k of ["1A", "A-B", "A B", "", "A=B", "A;id", "$(id)"]) expect(() => boxEnvFile({ [k]: "x" })).toThrow()
    expect(() => boxEnvFile({ A: "a\0b" })).toThrow()
  })
})

// ---------------------------------------------------------------------------

const shells = [...new Set(["/bin/sh", "/usr/bin/dash", "/bin/dash", "/usr/bin/bash", "/bin/bash"].filter(existsSync))]

const NASTY: Record<string, string> = {
  QUOTES: `say "hi" and 'yo'`, SQ: "'", SQ_ESC: "'\\''", SQ_MANY: "''''", SQ_END: "a'", SQ_CMD: "'; touch /tmp/never; '",
  BACKSLASH: "a\\b\\\\c\\n", TRAILING: "ends\\", DOLLAR: "$HOME ${PATH} $$ $1", SUBST: "$(touch /tmp/never)", BACKTICK: "`touch /tmp/never`",
  NEWLINES: "line1\nline2\n", TAB: "a\tb\t", HASH: "# not a comment", SEMI: "; also not", UNICODE: "héllo ✓ 日本 \u202e", EMPTY: "",
  INJECT: "x\nexport EVIL=1", INJECT2: "x'\nexport EVIL2=1\n'", INJECT3: "'\nEVIL3=1 #", SPACES: "  lead and trail  ", PERCENT: "%h %n %%",
  EQUALS: "a=b=c", GLOB: "* ? [a]", BANG: "!! !$", TILDE: "~root",
}

/** Runs BOX_INIT like systemd does: env in $CREDENTIALS_DIRECTORY/box-env, grants as check/path pairs */
const runInit = (sh: string, opts: { cmd: string[]; grants?: string[]; env?: Record<string, string> | null; procEnv?: Record<string, string>; stdin?: "pipe" | "ignore" }) => {
  let creds: string | null = null
  if (opts.env) {
    creds = mkdtempSync(join(tmpdir(), "box-cred-"))
    writeFileSync(join(creds, BOX_ENV_CREDENTIAL), boxEnvFile(opts.env), { mode: 0o600 })
  }
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", ...opts.procEnv, ...(creds ? { CREDENTIALS_DIRECTORY: creds } : {}) }
  const p = Bun.spawn([sh, "-c", BOX_INIT, "candy-box", ...(opts.grants ?? []), "--", ...opts.cmd], { env, stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" })
  // A caller that drives stdin reads stdout itself; otherwise both are read while it runs
  const own = opts.stdin !== "pipe"
  const out = own ? new Response(p.stdout).text() : Promise.resolve("")
  const err = own ? new Response(p.stderr).text() : Promise.resolve("")
  const done = p.exited.then(async code => {
    if (creds) rmSync(creds, { recursive: true, force: true })
    return { code, out: await out, err: await err }
  })
  return { p, done }
}

const readEnv0 = (out: string) => {
  const got: Record<string, string> = {}
  for (const kv of out.split("\0")) { const i = kv.indexOf("="); if (i > 0) got[kv.slice(0, i)] = kv.slice(i + 1) }
  return got
}

for (const sh of shells) {
  describe(`BOX_INIT under ${sh}`, () => {
    const init = (cmd: string[], grants: string[] = []) => runInit(sh, { cmd, grants, stdin: "pipe" }).p

    it("passes stdin to the command and its stdout back", async () => {
      const p = init(["/bin/cat"])
      p.stdin.write("hello\nbox\n")
      await p.stdin.end()
      expect(await new Response(p.stdout).text()).toBe("hello\nbox\n")
      expect(await p.exited).toBe(0)
    })

    it("passes the arguments untouched, a -- among them included", async () => {
      const args = ["a b", "$HOME", "%n", "'q'", '"d"', "*", "", "--", "-c", "--x"]
      const { done } = runInit(sh, { cmd: ["/usr/bin/printf", "[%s]\\n", ...args] })
      const r = await done
      expect(r.out).toBe(args.map(a => `[${a}]\n`).join(""))
      expect(r.code).toBe(0)
    })

    it("exits with the command's exit code", async () => {
      for (const code of [0, 1, 3, 42, 255]) expect((await runInit(sh, { cmd: ["/bin/sh", "-c", `exit ${code}`] }).done).code).toBe(code)
    })

    it("gives 137 for a command killed by SIGKILL", async () => {
      expect((await runInit(sh, { cmd: ["/bin/sh", "-c", "kill -9 $$"] }).done).code).toBe(137)
    })

    it("forwards SIGTERM to the command and exits with its status", async () => {
      const p = init(["/bin/sh", "-c", "trap 'exit 7' TERM; echo ready; while :; do sleep 0.05; done"])
      const reader = p.stdout.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n")
      p.kill("SIGTERM")
      expect(await p.exited).toBe(7)
    })

    it("a command with no TERM handler ends with 143", async () => {
      const p = init(["/bin/sh", "-c", "echo ready; exec sleep 30"])
      await p.stdout.getReader().read()
      await Bun.sleep(50)
      p.kill("SIGTERM")
      expect(await p.exited).toBe(143)
    })

    it("doesn't wait for an orphaned grandchild", async () => {
      const marker = `29.${Math.floor(Math.random() * 1e6)}`
      const started = Date.now()
      const r = await runInit(sh, { cmd: ["/bin/sh", "-c", `sleep ${marker} </dev/null >/dev/null 2>&1 & exit 5`] }).done
      expect(r.code).toBe(5)
      expect(Date.now() - started).toBeLessThan(5000)
      Bun.spawnSync(["pkill", "-f", `sleep ${marker}`])
    })

    it("gives 127 for a missing program", async () => {
      expect((await runInit(sh, { cmd: ["/nonexistent/program"] }).done).code).toBe(127)
    })

    // A background command of a non-interactive shell starts with SIGINT ignored (POSIX), and there
    // is no INT trap any more: an INT for the box does nothing unless the command resets it
    it("starts the command with SIGINT ignored", async () => {
      const r = await runInit(sh, { cmd: ["/bin/sh", "-c", "grep '^SigIgn' /proc/$$/status"] }).done
      expect(BigInt("0x" + r.out.split(/\s+/)[1]) & 2n).toBe(2n)
    })

    describe("grant checks", () => {
      const setup = () => {
        const dir = mkdtempSync(join(tmpdir(), "box-grant-"))
        mkdirSync(join(dir, "data"))
        mkdirSync(join(dir, "other"))
        writeFileSync(join(dir, "file"), "x")
        return dir
      }
      const ran = (r: { out: string }) => r.out.includes("RAN")
      const cmd = ["/bin/sh", "-c", "echo RAN"]

      it("runs the command when every grant is what was checked (a folder and a file)", async () => {
        const dir = setup()
        try {
          const grants = [checkOf(join(dir, "data")), join(dir, "data"), checkOf(join(dir, "file")), join(dir, "file")]
          const r = await runInit(sh, { cmd, grants }).done
          expect([r.code, ran(r), r.err]).toEqual([0, true, ""])
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })

      it("refuses with 125 and never runs the command on a mismatch", async () => {
        const dir = setup()
        try {
          const grants = [checkOf(join(dir, "data")), join(dir, "data"), checkOf(join(dir, "other")), join(dir, "file")]
          const r = await runInit(sh, { cmd: ["/bin/sh", "-c", `echo RAN; touch ${dir}/touched`], grants }).done
          expect(r.code).toBe(BOX_INIT_REFUSED)
          expect(ran(r)).toBe(false)
          expect(existsSync(join(dir, "touched"))).toBe(false)
          expect(r.err).toBe(`candy: ${dir}/file in the box is not what was granted\n`)
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })

      it("refuses a path swapped for a symlink to another folder after the check", async () => {
        const dir = setup()
        try {
          const path = join(dir, "data")
          const check = checkOf(path)
          rmSync(path, { recursive: true })
          symlinkSync(join(dir, "other"), path)
          const r = await runInit(sh, { cmd, grants: [check, path] }).done
          expect(r.code).toBe(BOX_INIT_REFUSED)
          expect(ran(r)).toBe(false)
          // Even a symlink to the very folder that was checked: the box must see the folder itself
          const real = join(dir, "real")
          renameSync(join(dir, "other"), real)
          const realCheck = checkOf(real)
          rmSync(path)
          symlinkSync(real, path)
          const r2 = await runInit(sh, { cmd, grants: [realCheck, path] }).done
          expect(r2.code).toBe(BOX_INIT_REFUSED)
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })

      it("refuses a folder replaced by another one of the same name, and a missing path", async () => {
        const dir = setup()
        try {
          const path = join(dir, "data")
          const check = checkOf(path)
          rmSync(path, { recursive: true })
          renameSync(join(dir, "other"), path)
          expect((await runInit(sh, { cmd, grants: [check, path] }).done).code).toBe(BOX_INIT_REFUSED)
          expect((await runInit(sh, { cmd, grants: [check, join(dir, "missing")] }).done).code).toBe(BOX_INIT_REFUSED)
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })

      it("runs with no grants at all", async () => {
        const r = await runInit(sh, { cmd, grants: [] }).done
        expect([r.code, ran(r)]).toEqual([0, true])
      })

      it("checks before the site's environment exists, with /usr/bin/stat by full path", async () => {
        const dir = setup()
        try {
          // A fake stat that prints whatever check is wanted, first in every PATH there is
          const fake = join(dir, "fakebin")
          mkdirSync(fake)
          const check = checkOf(join(dir, "data"))
          writeFileSync(join(fake, "stat"), `#!/bin/sh\necho ${check}\n`, { mode: 0o755 })
          const env = { PATH: fake, LD_PRELOAD: "/nonexistent/evil.so", IFS: "/:", CANDY_SITE_VAR: "seen" }
          const wrong = await runInit(sh, { cmd, grants: [check, join(dir, "file")], env, procEnv: { PATH: fake } }).done
          expect(wrong.code).toBe(BOX_INIT_REFUSED)
          expect(ran(wrong)).toBe(false)
          expect(wrong.err).not.toContain("evil.so")  // nothing ran with the site's LD_PRELOAD
          const right = await runInit(sh, { cmd: ["/bin/sh", "-c", 'echo "RAN $CANDY_SITE_VAR"'], grants: [check, join(dir, "data")], env, procEnv: { PATH: fake } }).done
          expect(right.code).toBe(0)
          expect(right.out).toBe("RAN seen\n")
        } finally { rmSync(dir, { recursive: true, force: true }) }
      })
    })

    describe("the site's environment", () => {
      it("round-trips nasty values, and no value runs a command or adds a variable", async () => {
        const r = await runInit(sh, { cmd: ["/usr/bin/env", "-0"], env: NASTY }).done
        expect(r.code).toBe(0)
        const got = readEnv0(r.out)
        for (const [k, v] of Object.entries(NASTY)) expect([k, got[k]]).toEqual([k, v])
        for (const k of ["EVIL", "EVIL2", "EVIL3"]) expect(got[k]).toBeUndefined()
        expect(existsSync("/tmp/never")).toBe(false)
        expect(r.err).toBe("")
      })

      it("names the init uses itself (c, s, IFS, PATH) don't change its exit code or TERM forwarding", async () => {
        const env = { c: "1", s: "99", IFS: "ex/:", PATH: "/nonexistent", OPTIND: "1", trap: "x", kill: "x" }
        const r = await runInit(sh, { cmd: ["/bin/sh", "-c", 'echo "$c $s"; exit 3'], env }).done
        expect([r.code, r.out]).toEqual([3, "1 99\n"])
        const { p, done } = runInit(sh, { cmd: ["/bin/sh", "-c", "trap 'exit 7' TERM; echo ready; while :; do sleep 0.05; done"], env, procEnv: {}, stdin: "pipe" })
        const reader = p.stdout.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n")
        p.kill("SIGTERM")
        expect(await p.exited).toBe(7)
        await done.catch(() => {})
      })

      it("runs the command without CREDENTIALS_DIRECTORY", async () => {
        const r = await runInit(sh, { cmd: ["/bin/sh", "-c", "echo RAN"], env: null }).done
        expect([r.code, r.out]).toEqual([0, "RAN\n"])
      })

      it("never runs the command when the credential can't be read", async () => {
        const p = Bun.spawnSync([sh, "-c", BOX_INIT, "candy-box", "--", "/bin/sh", "-c", "echo RAN"], { env: { PATH: "/usr/bin:/bin", CREDENTIALS_DIRECTORY: "/nonexistent" } })
        expect(p.stdout.toString()).toBe("")
        // bash reaches `|| exit 125`; dash treats a failed `.` as fatal and exits 2
        expect([BOX_INIT_REFUSED, 2]).toContain(p.exitCode)
      })
    })
  })
}

it("BOX_INIT checks grants before it reads the site's environment, and runs nothing else by PATH", () => {
  const lines = BOX_INIT.split("\n")
  const stat = lines.findIndex(l => l.includes("/usr/bin/stat -c %d:%i --"))
  const source = lines.findIndex(l => l.includes(`. "$CREDENTIALS_DIRECTORY/${BOX_ENV_CREDENTIAL}"`))
  const run = lines.findIndex(l => l.includes('"$@"'))
  expect(stat).toBeGreaterThanOrEqual(0)
  expect(source).toBeGreaterThan(stat)
  expect(run).toBeGreaterThan(source)
  expect(BOX_INIT).not.toMatch(/\bstat\b(?<!\/usr\/bin\/stat)/)
  expect(BOX_INIT).not.toContain("trap 'kill -INT")
})

// ---------------------------------------------------------------------------
// Real systemd (user manager), when there is one

const userSystemd = (() => {
  try {
    const p = Bun.spawnSync(["systemd-run", "--user", "--wait", "--pipe", "--collect", "--quiet", "/bin/true"], { stdin: "ignore", timeout: 10_000 })
    return p.exitCode === 0
  } catch { return false }
})()

describe.skipIf(!userSystemd)("with systemd-run --user", () => {
  it("runs boxRunCommand's tail end to end: credential env, grant checks, argv untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "box-e2e-"))
    try {
      mkdirSync(join(dir, "data"))
      const envFile = join(dir, "env")
      writeFileSync(envFile, boxEnvFile(NASTY), { mode: 0o600 })
      const args = ["a b", "$HOME", "${X}", "%n %h %%", '"q"', "'s'", "\\x", "", "$(id)", "--"]
      const box = unit({ cmd: ["/bin/sh", "-c", 'printf "[%s]\\n" "$@"; env -0 >&2', "x", ...args], grants: [{ path: join(dir, "data"), mode: "ro", check: checkOf(join(dir, "data")) }] })
      const full = boxRunCommand(box, envFile)
      const tail = full.slice(full.indexOf("--"))
      const run = (t: string[]) => Bun.spawnSync(["systemd-run", "--user", "--wait", "--pipe", "--collect", "--quiet", "--expand-environment=no", "--service-type=exec",
        full.find(a => a.startsWith("--property=LoadCredential="))!, ...t], { stdin: "ignore", timeout: 20_000 })
      const p = run(tail)
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toBe(args.map(a => `[${a}]\n`).join(""))
      const got = readEnv0(p.stderr.toString())
      for (const [k, v] of Object.entries(NASTY)) expect([k, got[k]]).toEqual([k, v])
      for (const k of ["EVIL", "EVIL2", "EVIL3"]) expect(got[k]).toBeUndefined()

      // The same, with a check that doesn't match: refused, nothing ran
      const bad = [...tail]
      bad[bad.indexOf("candy-box") + 1] = "1:1"
      const refusedRun = run(bad)
      expect(refusedRun.exitCode).toBe(BOX_INIT_REFUSED)
      expect(refusedRun.stdout.toString()).toBe("")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)

  it("parseRunSummary reads what systemd-run really prints", () => {
    const run = (script: string, ...props: string[]) => {
      const p = Bun.spawnSync(["systemd-run", "--user", "--wait", "--pipe", "--collect", "--expand-environment=no", "--service-type=exec", ...props.map(x => `--property=${x}`),
        "--", "/bin/sh", "-c", script], { stdin: "ignore", timeout: 20_000 })
      return { ...parseRunSummary(p.stderr.toString()), exit: p.exitCode }
    }
    const three = run("echo own-line >&2; exit 3")
    expect(three.summary).toEqual({ started: true, result: "exit-code", code: "exited", status: expect.stringMatching(/^3(\/|$)/) })
    expect(three.rest).toBe("own-line")
    expect(boxExitCause(three.summary, null, three.exit, three.rest, 0)).toMatchObject({ cause: "exit", code: 3 })

    const killed = run("kill -9 $$")
    expect(killed.summary).toMatchObject({ started: true, result: "signal", code: "killed" })
    expect(boxExitCause(killed.summary, null, killed.exit, killed.rest, 0)).toMatchObject({ cause: "signal", signal: "KILL" })

    const fake = run("echo 'Finished with result: oom-kill' >&2; echo 'Main processes terminated with: code=killed, status=9/KILL' >&2; printf partial >&2; exit 0")
    expect(fake.summary).toMatchObject({ result: "success", code: "exited" })
    expect(fake.rest).toBe("Finished with result: oom-kill\nMain processes terminated with: code=killed, status=9/KILL\npartial")

    const refused = run(`echo 'candy: /x in the box is not what was granted' >&2; exit ${BOX_INIT_REFUSED}`)
    expect(boxExitCause(refused.summary, null, refused.exit, refused.rest, 0)).toMatchObject({ cause: "failed", code: BOX_INIT_REFUSED, detail: "candy: /x in the box is not what was granted" })

    if (existsSync("/usr/bin/python3")) {
      const oom = run("exec /usr/bin/python3 -c 'x=[]\nwhile 1: x.append(bytearray(1<<20))'", "MemoryMax=24M", "MemorySwapMax=0", "OOMPolicy=stop")
      if (oom.summary.result) {
        expect(oom.summary.result).toBe("oom-kill")
        expect(boxExitCause(oom.summary, "released", oom.exit, oom.rest, 0).cause).toBe("oom")
      }
    }
  }, 60_000)
})
// ---------------------------------------------------------------------------

describe("parseRunSummary", () => {
  // Captured from systemd 259 (systemd-run --user --wait --pipe, stderr)
  const REAL_EXIT3 = [
    "Running as unit: run-p382575-i347713.service; invocation ID: f9d190777899464d8f461835168e625b",
    "hi",
    "          Finished with result: exit-code",
    "Main processes terminated with: code=exited, status=3/NOTIMPLEMENTED",
    "               Service runtime: 22ms",
    "             CPU time consumed: 3ms",
    "                   Memory peak: 1.7M (swap: 0B)",
    "",
  ].join("\n")
  const REAL_KILL = [
    "Running as unit: run-p382716-i352211.service; invocation ID: 45309768a25c43e198d7b9850ce2811a",
    "          Finished with result: signal",
    "Main processes terminated with: code=killed, status=9/KILL",
    "               Service runtime: 18ms",
    "             CPU time consumed: 4ms",
    "                   Memory peak: 2M (swap: 0B)",
    "",
  ].join("\n")
  const REAL_OOM = [
    "Running as unit: run-p382787-i352224.service; invocation ID: b1913a4b3d1548adbb2119b6cdb5f3a1",
    "          Finished with result: oom-kill",
    "Main processes terminated with: code=killed, status=9/KILL",
    "               Service runtime: 32ms",
    "             CPU time consumed: 20ms",
    "                   Memory peak: 20M (swap: 0B)",
    "",
  ].join("\n")
  const REAL_TIMEOUT = [
    "Running as unit: run-p382602-i398865.service; invocation ID: aa7890ae139e44f48d17d583d8f6c5a6",
    "          Finished with result: timeout",
    "Main processes terminated with: code=killed, status=15/TERM",
    "               Service runtime: 1.050s",
    "             CPU time consumed: 9ms",
    "                   Memory peak: 2M (swap: 0B)",
    "",
  ].join("\n")
  const REAL_137 = [
    "Running as unit: run-p382767-i352216.service; invocation ID: b867946757e642f1b9c79db98a6e6821",
    "          Finished with result: exit-code",
    "Main processes terminated with: code=exited, status=137/n/a",
    "               Service runtime: 24ms",
    "",
  ].join("\n")
  const REAL_CHDIR = [
    "Running as unit: run-p382794-i352226.service; invocation ID: e0127e0c89f6460890cf6df26fae9979",
    "          Finished with result: exit-code",
    "Main processes terminated with: code=exited, status=200/CHDIR",
    "               Service runtime: 22ms",
    "",
  ].join("\n")
  // The box's stderr ended without a newline: its last bytes share the line
  const REAL_PARTIAL = [
    "Running as unit: run-p382801-i352228.service; invocation ID: 8e41b0626b454009902df40e3143061f",
    "partial          Finished with result: success",
    "Main processes terminated with: code=exited, status=0/SUCCESS",
    "               Service runtime: 3ms",
    "             CPU time consumed: 2ms",
    "                   Memory peak: 1.7M (swap: 0B)",
    "",
  ].join("\n")

  it("reads real systemd 259 output", () => {
    expect(parseRunSummary(REAL_EXIT3)).toEqual({ summary: { started: true, result: "exit-code", code: "exited", status: "3/NOTIMPLEMENTED" }, rest: "hi" })
    expect(parseRunSummary(REAL_KILL)).toEqual({ summary: { started: true, result: "signal", code: "killed", status: "9/KILL" }, rest: "" })
    expect(parseRunSummary(REAL_OOM).summary).toEqual({ started: true, result: "oom-kill", code: "killed", status: "9/KILL" })
    expect(parseRunSummary(REAL_TIMEOUT).summary).toEqual({ started: true, result: "timeout", code: "killed", status: "15/TERM" })
    expect(parseRunSummary(REAL_137).summary.status).toBe("137/n/a")
    expect(parseRunSummary(REAL_CHDIR).summary.status).toBe("200/CHDIR")
  })

  it("keeps a box's unterminated last line and still reads the real result after it", () => {
    expect(parseRunSummary(REAL_PARTIAL)).toEqual({ summary: { started: true, result: "success", code: "exited", status: "0/SUCCESS" }, rest: "partial" })
    const forged = REAL_PARTIAL.replace("partial", "Finished with result: oom-kill")
    expect(parseRunSummary(forged).summary.result).toBe("success")
  })

  it("still reads the older code=x/status=y shape and other summary lines", () => {
    const text = [
      "Running as unit: candy-box-x-abc.service; invocation ID: 0123abcd",
      "own stderr",
      "Finished with result: exit-code",
      "Main processes terminated with: code=exited/status=3",
      "Service runtime: 1.204s",
      "CPU time consumed: 80ms",
      "Memory peak: 3.1M",
      "Memory swap peak: 0B",
      "IP traffic received: 0B",
      "IP traffic sent: 0B",
      "IO bytes read: 0B",
      "IO bytes written: 0B",
    ].join("\n")
    expect(parseRunSummary(text)).toEqual({ summary: { started: true, result: "exit-code", code: "exited", status: "3" }, rest: "own stderr" })
  })

  it("isn't fooled by look-alike lines the box printed earlier: the last block wins", () => {
    const text = [
      "Running as unit: run-u1.service; invocation ID: 1",
      "Running as unit: fake.service",
      "          Finished with result: oom-kill",
      "Main processes terminated with: code=killed, status=9/KILL",
      "               Service runtime: 1ms",
      "work",
      "Finished with result: success",
      "Main processes terminated with: code=exited, status=0/SUCCESS",
      "          Finished with result: exit-code",
      "Main processes terminated with: code=exited, status=3/NOTIMPLEMENTED",
      "               Service runtime: 22ms",
    ].join("\n")
    const { summary, rest } = parseRunSummary(text)
    expect(summary).toEqual({ started: true, result: "exit-code", code: "exited", status: "3/NOTIMPLEMENTED" })
    expect(rest).toContain("work")
    expect(rest).toContain("Running as unit: fake.service")
    expect(rest).toContain("Finished with result: oom-kill")
    expect(rest).toContain("Finished with result: success")
  })

  it("handles empty input and output with no summary", () => {
    expect(parseRunSummary("")).toEqual({ summary: { started: false, result: null, code: null, status: null }, rest: "" })
    expect(parseRunSummary("Failed to find executable /x: No such file or directory\n")).toEqual({
      summary: { started: false, result: null, code: null, status: null }, rest: "Failed to find executable /x: No such file or directory",
    })
    const cut = parseRunSummary("Running as unit: run-u1.service; invocation ID: 1\nsome output\n")
    expect(cut).toEqual({ summary: { started: true, result: null, code: null, status: null }, rest: "some output" })
  })
})

// ---------------------------------------------------------------------------

describe("boxExitCause", () => {
  const s = (over: Partial<RunSummary>): RunSummary => ({ started: true, result: "exit-code", code: "exited", status: "0/SUCCESS", ...over })
  const at = 1

  it("not started: failed, with the last stderr line", () => {
    expect(boxExitCause({ started: false, result: null, code: null, status: null }, null, 1, "x\nFailed to start transient service unit: Unit exists.\n", at))
      .toEqual({ cause: "failed", code: null, signal: null, detail: "Failed to start transient service unit: Unit exists.", at })
    expect(boxExitCause({ started: false, result: null, code: null, status: null }, null, 1, "", at).detail).toBe("systemd-run exited 1")
  })

  it("stopped before it ever started: who asked, not a failure", () => {
    for (const asked of ["released", "site-stopped", "stopped"] as const) {
      expect(boxExitCause({ started: false, result: null, code: null, status: null }, asked, 1, "Failed to start", at).cause).toBe(asked)
    }
  })

  it("125: the init refused (a grant isn't what was checked), with its line", () => {
    expect(boxExitCause(s({ status: "125/n/a" }), null, 125, "candy: /a in the box is not what was granted", at))
      .toEqual({ cause: "failed", code: BOX_INIT_REFUSED, signal: null, detail: "candy: /a in the box is not what was granted", at })
    expect(boxExitCause(s({ status: "125" }), null, 125, "", at)).toMatchObject({ cause: "failed", detail: "the box refused to start" })
  })

  it("oom wins, even over who asked", () => {
    for (const asked of [null, "released", "site-stopped", "stopped"] as const) {
      expect(boxExitCause(s({ result: "oom-kill", code: "killed", status: "9/KILL" }), asked, 1, "", at).cause).toBe("oom")
    }
  })

  it("asked: that cause", () => {
    for (const asked of ["released", "site-stopped", "stopped"] as const) expect(boxExitCause(s({ status: "143/n/a" }), asked, 143, "", at).cause).toBe(asked)
  })

  it("timeout: the lease ran out", () => {
    expect(boxExitCause(s({ result: "timeout", code: "killed", status: "15/TERM" }), null, 1, "", at).cause).toBe("lease")
  })

  it("killed or dumped: the signal by name", () => {
    expect(boxExitCause(s({ result: "signal", code: "killed", status: "9/KILL" }), null, 255, "", at)).toMatchObject({ cause: "signal", signal: "KILL" })
    expect(boxExitCause(s({ result: "core-dump", code: "dumped", status: "11/SEGV" }), null, 1, "", at)).toMatchObject({ cause: "signal", signal: "SEGV" })
    expect(boxExitCause(s({ result: "signal", code: "killed", status: "KILL" }), null, 1, "", at)).toMatchObject({ cause: "signal", signal: "KILL" })
    expect(boxExitCause(s({ result: "signal", code: "killed", status: "SIGKILL" }), null, 1, "", at)).toMatchObject({ cause: "signal", signal: "KILL" })
  })

  it("systemd's own setup codes: failed", () => {
    expect(boxExitCause(s({ status: "203/EXEC" }), null, 203, "boom", at)).toMatchObject({ cause: "failed", detail: "systemd could not start it (203/EXEC): boom" })
    expect(boxExitCause(s({ status: "200/CHDIR" }), null, 200, "", at)).toMatchObject({ cause: "failed", detail: "systemd could not start it (200/CHDIR)" })
  })

  it("126 and 127: the command couldn't be run", () => {
    expect(boxExitCause(s({ status: "127/n/a" }), null, 127, "/bin/sh: 1: /x: not found", at)).toMatchObject({ cause: "failed", code: 127, detail: "/bin/sh: 1: /x: not found" })
    expect(boxExitCause(s({ status: "127" }), null, 127, "", at)).toMatchObject({ cause: "failed", code: 127, detail: "the command could not be run" })
    expect(boxExitCause(s({ status: "126/n/a" }), null, 126, "", at).cause).toBe("failed")
  })

  it("128 + n: the signal that ended the command", () => {
    expect(boxExitCause(s({ status: "137/n/a" }), null, 137, "", at)).toMatchObject({ cause: "signal", code: 137, signal: "KILL" })
    expect(boxExitCause(s({ status: "143/n/a" }), null, 143, "", at)).toMatchObject({ cause: "signal", code: 143, signal: "TERM" })
    expect(boxExitCause(s({ status: "137" }), null, 137, "", at)).toMatchObject({ cause: "signal", signal: "KILL" })
    expect(boxExitCause(s({ status: "162/n/a" }), null, 162, "", at)).toMatchObject({ cause: "signal", signal: "34" })
  })

  it("plain exit codes", () => {
    expect(boxExitCause(s({ status: "3/NOTIMPLEMENTED" }), null, 3, "", at)).toEqual({ cause: "exit", code: 3, signal: null, detail: null, at })
    expect(boxExitCause(s({ result: "success", status: "0/SUCCESS" }), null, 0, "", at)).toEqual({ cause: "exit", code: 0, signal: null, detail: null, at })
    expect(boxExitCause(s({ status: "3" }), null, 3, "", at)).toMatchObject({ cause: "exit", code: 3 })
  })

  it("no status line: falls back on systemd-run's own exit code", () => {
    expect(boxExitCause(s({ result: null, code: null, status: null }), null, 4, "", at)).toMatchObject({ cause: "exit", code: 4 })
    expect(boxExitCause(s({ result: null, code: null, status: null }), null, null, "", at)).toMatchObject({ cause: "failed", detail: "systemd result unknown" })
  })
})

// ---------------------------------------------------------------------------

describe("boxAuditLine", () => {
  it("names the program and the limits, never the environment or arguments", () => {
    const r = ok({
      cmd: ["/usr/bin/node", "--token=arg-secret-4471", "script.js"], env: { API_KEY: "env-secret-9182" },
      memory: 512, cpu: 50, seconds: 10, grants: [{ path: "/opt/m", mode: "ro" }], isolation: ["PrivateNetwork=yes"], label: "lbl",
    })
    const line = boxAuditLine(r)
    expect(line).toBe("cmd=/usr/bin/node memory=512M tasks=1024 cpu=50% seconds=10 grants=[ro:/opt/m] isolation=[PrivateNetwork=yes]")
    expect(line).not.toContain("arg-secret-4471")
    expect(line).not.toContain("script.js")
    expect(line).not.toContain("env-secret-9182")
    expect(line).not.toContain("API_KEY")
  })
})
