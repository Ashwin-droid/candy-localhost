import { describe, expect, it } from "bun:test"
import { findCodeDir, sandboxProperties, stateDirPath, systemdRunCommand, unitName, unitOfCgroup, validateRwPath, type SandboxSpec } from "../sandbox.ts"

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  name: "wa", unit: "candy-wa-abc123.service", uid: 1001, gid: 1001,
  cwd: "/home/claude/projects/wa/server", codeDir: "/home/claude/projects/wa",
  env: { HOME: "/home/claude", PATH: "/usr/bin", LANG: undefined }, script: "bun start", mode: "pty",
  bindsTo: "candy-localhost@ashwin.service", ...over,
})

describe("sandbox", () => {
  it("makes everything read-only except code, state and a private /tmp", () => {
    const props = sandboxProperties(spec({ extraRw: ["/srv/data"] }))
    expect(props).toContain("ProtectSystem=strict")
    expect(props).toContain("ProtectHome=read-only")
    expect(props).toContain("PrivateTmp=yes")
    expect(props).toContain("StateDirectory=candy/wa")
    expect(props).toContain("NoNewPrivileges=yes")
    expect(props.filter(p => p.startsWith("ReadWritePaths="))).toEqual(["ReadWritePaths=/home/claude/projects/wa", "ReadWritePaths=/srv/data"])
    expect(props).toContain("BindsTo=candy-localhost@ashwin.service")
  })

  it("binds a code folder under /tmp back into the private /tmp", () => {
    const props = sandboxProperties(spec({ codeDir: "/tmp/demo" }))
    expect(props).toContain("BindPaths=/tmp/demo")
    expect(props.some(p => p.startsWith("ReadWritePaths="))).toBe(false)
  })

  it("builds the systemd-run command, with args as plain argv", () => {
    const cmd = systemdRunCommand(spec({ mode: "pipe", script: 'bun start "$@"', args: ["--sync", "; rm -rf ~"] }))
    expect(cmd[0]).toBe("systemd-run")
    expect(cmd).toContain("--pipe")
    expect(cmd).not.toContain("--pty")
    expect(cmd).toContain("--uid=1001")
    expect(cmd).toContain("--working-directory=/home/claude/projects/wa/server")
    expect(cmd).toContain("--setenv=HOME=/home/claude")
    expect(cmd).toContain(`--setenv=CANDY_STATE_DIR=${stateDirPath("wa")}`)
    expect(cmd.some(c => c.startsWith("--setenv=LANG"))).toBe(false)  // undefined values are dropped
    expect(cmd.slice(cmd.indexOf("--") + 1)).toEqual(["bash", "-ic", 'bun start "$@"', "candy", "--sync", "; rm -rf ~"])
    expect(systemdRunCommand(spec()).slice(-3)).toEqual(["bash", "-ic", "bun start"])
  })

  it("picks the repository as the code folder, but never the home", () => {
    const git = (dirs: string[]) => (d: string) => dirs.includes(d)
    expect(findCodeDir("/home/u/app/server", "/home/u", git(["/home/u/app"]))).toBe("/home/u/app")
    expect(findCodeDir("/home/u/app", "/home/u", git([]))).toBe("/home/u/app")
    expect(findCodeDir("/home/u/app", "/home/u", git(["/home/u"]))).toBe("/home/u/app")   // dotfiles repo in ~
    expect(findCodeDir("/home/u", "/home/u", git(["/home/u"]))).toBe("/home/u")
    expect(findCodeDir("/srv/x/y", "/home/u", git(["/"]))).toBe("/srv/x/y")
  })

  it("validates extra writable paths", () => {
    expect(validateRwPath("/srv/data")).toBe("/srv/data")
    expect(validateRwPath("/srv/data/")).toBe("/srv/data")
    for (const bad of ["", "relative", "/", "/home", "/etc", "/srv/../etc", "/srv//x", "/a\nb", 5, null]) {
      expect(validateRwPath(bad)).toBeNull()
    }
  })

  it("names units and reads them back from a cgroup", () => {
    expect(unitName("wa")).toMatch(/^candy-wa-[0-9a-f]{6}\.service$/)
    expect(unitName("wa", "cron")).toMatch(/^candy-cron-wa-[0-9a-f]{6}\.service$/)
    expect(unitOfCgroup("0::/candy.slice/candy-wa-abc123.service\n")).toBe("candy-wa-abc123.service")
    expect(unitOfCgroup("0::/user.slice/user-1000.slice/session-c5.scope\n")).toBeNull()
  })
})
