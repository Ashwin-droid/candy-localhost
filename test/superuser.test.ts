import { beforeEach, describe, expect, it } from "bun:test"
import { clearSuperuserCache, createSuperuser, isSuperuser, parseGroup, parsePasswd, usableShell, type CommandRunner } from "../superuser"

// A fake system: passwd and group databases plus the sudoers answer.
const passwd: Record<string, string> = {
  root: "root:x:0:0:root:/root:/bin/bash",
  toor: "toor:x:0:0:alias:/root:/bin/bash",
  alice: "alice:x:1000:1000:Alice:/home/alice:/bin/bash",
  bob: "bob:x:1001:1001:Bob:/home/bob:/usr/bin/zsh",
  carol: "carol:x:1002:27:Carol:/home/carol:/bin/bash",
  dave: "dave:x:1003:1003:Dave:/home/dave:",
  svc: "svc:x:998:998:service:/var/lib/svc:/usr/sbin/nologin",
  ghost: "ghost:x:997:997:ghost:/:/bin/false",
}
const groups: Record<string, string> = {
  candy: "candy:x:990:bob,svc,root,ghost,dave,nobody-here",
  sudo: "sudo:x:27:alice",
  wheel: "wheel:x:10:",
}

// No one locked unless a test says so (getent shadow: name:hash:...:expire:)
const shadow: Record<string, string> = {}

const fakeSystem = (sudoers: string[] = []) => {
  const calls: string[][] = []
  const run: CommandRunner = async (cmd) => {
    calls.push(cmd)
    if (cmd[0] === "getent" && cmd[1] === "passwd") return passwd[cmd[2]] ? { exitCode: 0, stdout: `${passwd[cmd[2]]}\n` } : { exitCode: 2, stdout: "" }
    if (cmd[0] === "getent" && cmd[1] === "shadow") return shadow[cmd[2]] ? { exitCode: 0, stdout: `${shadow[cmd[2]]}\n` } : { exitCode: 2, stdout: "" }
    if (cmd[0] === "getent" && cmd[1] === "group") return groups[cmd[2]] ? { exitCode: 0, stdout: `${groups[cmd[2]]}\n` } : { exitCode: 2, stdout: "" }
    if (cmd[0] === "sudo") {
      expect(cmd.slice(0, 4)).toEqual(["sudo", "-n", "-l", "-U"])
      expect(cmd.slice(5)).toEqual(["--", "/bin/sh"])
      return sudoers.includes(cmd[4]) ? { exitCode: 0, stdout: "/bin/sh\n" } : { exitCode: 1, stdout: "" }
    }
    throw new Error(`unexpected command ${cmd.join(" ")}`)
  }
  return { run, calls }
}

describe("isSuperuser, root mode (sudo -l)", () => {
  it("asks sudo whether the user may run a root shell", async () => {
    const sys = fakeSystem(["bob"])
    const su = createSuperuser({ run: sys.run, isRoot: true, owner: "alice" })
    expect(await su.isSuperuser("bob")).toBe(true)
    // alice is in group sudo, but in root mode sudo's own answer decides
    expect(await su.isSuperuser("alice")).toBe(false)
  })

  it("is never true for root, uid 0 aliases, unknown or malformed users", async () => {
    const sys = fakeSystem(["root", "toor", "nobody-here", "bad name"])
    const su = createSuperuser({ run: sys.run, isRoot: true, owner: "alice" })
    for (const u of ["root", "toor", "nobody-here", "bad name", "", "-U"]) expect(await su.isSuperuser(u)).toBe(false)
    expect(sys.calls.some(c => c[0] === "sudo")).toBe(false)
  })

  it("caches for 60s per user", async () => {
    let t = 1_000_000
    const sudoers = ["bob"]
    const sys = fakeSystem(sudoers)
    const su = createSuperuser({ run: sys.run, isRoot: true, owner: "alice", now: () => t })
    expect(await su.isSuperuser("bob")).toBe(true)
    sudoers.length = 0
    t += 59_000
    expect(await su.isSuperuser("bob")).toBe(true)
    t += 2_000
    expect(await su.isSuperuser("bob")).toBe(false)
    sudoers.push("bob")
    su.clearCache()
    expect(await su.isSuperuser("bob")).toBe(true)
    expect(sys.calls.filter(c => c[0] === "sudo")).toHaveLength(3)
  })

  it("fails closed when the runner throws", async () => {
    const su = createSuperuser({ run: async () => { throw new Error("boom") }, isRoot: true, owner: "alice" })
    expect(await su.isSuperuser("bob")).toBe(false)
  })
})

describe("isSuperuser, user mode (group fallback)", () => {
  it("uses sudo/wheel/admin membership, including the primary group", async () => {
    const sys = fakeSystem()
    const su = createSuperuser({ run: sys.run, isRoot: false, owner: "alice", self: "alice" })
    expect(await su.isSuperuser("alice")).toBe(true)
    expect(await su.isSuperuser("carol")).toBe(true) // primary gid 27 = sudo
    expect(await su.isSuperuser("bob")).toBe(false)
    expect(await su.isSuperuser("root")).toBe(false)
    expect(sys.calls.some(c => c[0] === "sudo")).toBe(false)
  })
})

describe("loginUsers", () => {
  it("root mode: owner first, then usable candy members sorted; no root, no nologin, no unknown", async () => {
    const su = createSuperuser({ run: fakeSystem().run, isRoot: true, owner: "alice" })
    expect(await su.loginUsers()).toEqual(["alice", "bob", "dave"])
  })

  it("root mode: a member who is also the owner is listed once, first", async () => {
    const su = createSuperuser({ run: fakeSystem().run, isRoot: true, owner: "dave" })
    expect(await su.loginUsers()).toEqual(["dave", "bob"])
  })

  it("root mode without a candy group lists just the owner", async () => {
    const run: CommandRunner = async (cmd) => cmd[1] === "group" ? { exitCode: 2, stdout: "" } : fakeSystem().run(cmd)
    expect(await createSuperuser({ run, isRoot: true, owner: "bob" }).loginUsers()).toEqual(["bob"])
  })

  // Review finding 11: a locked or expired account can't log in, so it isn't eligible
  it("root mode leaves out locked and expired accounts", async () => {
    const now = Date.UTC(2026, 10, 12)
    shadow.bob = "bob:!$6$abc:20000:0:99999:7:::"            // passwd -l
    shadow.dave = `dave:$6$abc:20000:0:99999:7::${Math.floor(now / 86400000) - 1}:`  // expired yesterday
    try {
      const su = createSuperuser({ run: fakeSystem().run, isRoot: true, owner: "alice", now: () => now })
      expect(await su.loginUsers()).toEqual(["alice"])
      shadow.dave = `dave:$6$abc:20000:0:99999:7::${Math.floor(now / 86400000) + 30}:`  // expires next month
      delete shadow.bob
      expect(await createSuperuser({ run: fakeSystem().run, isRoot: true, owner: "alice", now: () => now }).loginUsers()).toEqual(["alice", "bob", "dave"])
    } finally {
      delete shadow.bob
      delete shadow.dave
    }
  })

  it("user mode lists only the daemon's own user", async () => {
    expect(await createSuperuser({ run: fakeSystem().run, isRoot: false, owner: "bob", self: "bob" }).loginUsers()).toEqual(["bob"])
    expect(await createSuperuser({ run: fakeSystem().run, isRoot: false, owner: "svc", self: "svc" }).loginUsers()).toEqual([])
  })
})

describe("parsing", () => {
  it("parses passwd and group lines", () => {
    expect(parsePasswd(passwd.bob)).toEqual({ name: "bob", uid: 1001, gid: 1001, home: "/home/bob", shell: "/usr/bin/zsh" })
    expect(parsePasswd("garbage")).toBeNull()
    expect(parseGroup(groups.candy)?.members).toEqual(["bob", "svc", "root", "ghost", "dave", "nobody-here"])
    expect(parseGroup(groups.wheel)).toEqual({ name: "wheel", gid: 10, members: [] })
  })

  it("knows which shells are usable", () => {
    for (const s of ["/bin/bash", "/usr/bin/zsh", "", "/usr/bin/fish"]) expect(usableShell(s)).toBe(true)
    for (const s of ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false", "/bin/true", "/dev/null"]) expect(usableShell(s)).toBe(false)
  })
})

describe("module exports", () => {
  beforeEach(() => clearSuperuserCache())
  it("root is never a superuser", async () => {
    expect(await isSuperuser("root")).toBe(false)
  })
})
