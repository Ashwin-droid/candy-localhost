import { describe, expect, it } from "bun:test"
import { parseEnvFile, validateEnvFilePath, userEnvDir } from "../sandbox.ts"
import { listeningPortsOf, tailscaleServeTargets } from "../activity.ts"
import { DEFAULT_MEMORY_MB, MAX_MEMORY_MB, formatMemory, memoryLimitMb, validateMemoryMb, findCodeDir, sandboxProperties, stateDirPath, systemdRunCommand, unitName, unitOfCgroup, validateRwPath, type SandboxSpec } from "../sandbox.ts"

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

  it("keeps a function's code and deploy snapshots read-only and binds its socket in", () => {
    const props = sandboxProperties(spec({ mode: "pipe", fn: { socket: "/run/candy/fn/wa.sock" }, extraRw: ["/srv/data"] }))
    expect(props.filter(p => p.startsWith("ReadWritePaths="))).toEqual(["ReadWritePaths=/srv/data"])
    expect(props).toContain("StateDirectory=candy/wa")
    expect(props).toContain(`ReadOnlyPaths=${stateDirPath("wa")}/deploys`)
    expect(props).toContain("TimeoutStopSec=35")
    expect(props).not.toContain("TimeoutStopSec=10")
    expect(props).toContain("BindPaths=/run/candy/fn/wa.sock")
    expect(sandboxProperties(spec({ codeDir: "/tmp/demo", fn: {} }))).toContain("BindReadOnlyPaths=/tmp/demo")
    const cmd = systemdRunCommand(spec({ mode: "pipe", fn: {}, description: "function", script: 'exec bun "$@"', args: ["/usr/lib/candy/fn-host.ts", "index.ts"] }))
    expect(cmd).toContain("--description=candy function: wa")
    expect(cmd.slice(cmd.indexOf("--") + 1)).toEqual(["bash", "-ic", 'exec bun "$@"', "candy", "/usr/lib/candy/fn-host.ts", "index.ts"])
    expect(unitName("wa", "fn")).toMatch(/^candy-fn-wa-[0-9a-f]{6}\.service$/)
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

describe("env files", () => {
  it("parses KEY=VALUE lines without expanding anything", () => {
    expect(parseEnvFile([
      "# comment", "", "A=1", "export B=two words", 'C="quoted value"', "D='single'", "E=has=equals", "F=$HOME/x", "bad line", "1X=no", "G=",
    ].join("\n"))).toEqual({ A: "1", B: "two words", C: "quoted value", D: "single", E: "has=equals", F: "$HOME/x", G: "" })
  })

  it("accepts only clean absolute paths, and passes the file to systemd", () => {
    expect(validateEnvFilePath("/etc/candy/env/ashwin/vw.env")).toBe("/etc/candy/env/ashwin/vw.env")
    for (const bad of ["vw.env", "/etc/../shadow", "/etc/x/", "", null, "/a\nb"]) expect(validateEnvFilePath(bad)).toBeNull()
    expect(userEnvDir("ashwin")).toBe("/etc/candy/env/ashwin")
    expect(sandboxProperties(spec({ envFile: "/etc/candy/env/ashwin/vw.env" }))).toContain("EnvironmentFile=/etc/candy/env/ashwin/vw.env")
    expect(sandboxProperties(spec()).some(p => p.startsWith("EnvironmentFile="))).toBe(false)
  })
})

describe("ports and tailscale serve", () => {
  it("finds what a server listens on from ss output", () => {
    const ss = [
      'LISTEN 0 128 127.0.0.1:8222 0.0.0.0:* users:(("vaultwarden",pid=4242,fd=11))',
      'LISTEN 0 512 *:9999 *:* users:(("bun",pid=10,fd=20))',
      'LISTEN 0 512 [::1]:3100 [::]:* users:(("bun",pid=77,fd=5),("bun",pid=78,fd=5))',
      'LISTEN 0 128 127.0.0.1:8223 0.0.0.0:* users:(("vaultwarden",pid=4242,fd=12))',
    ].join("\n")
    expect(listeningPortsOf(ss, [4242])).toEqual([8222, 8223])
    expect(listeningPortsOf(ss, [78, 999])).toEqual([3100])
    expect(listeningPortsOf(ss, [])).toEqual([])
  })

  it("reads tailscale serve targets by port", () => {
    const status = JSON.stringify({
      TCP: { "8443": { HTTPS: true }, "9443": { HTTPS: true }, "22": { TCPForward: "127.0.0.1:22" } },
      Web: {
        "host.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
        "host.ts.net:9443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18222" } } },
      },
    })
    const targets = tailscaleServeTargets(status)
    expect(targets.get(9443)).toBe("http://127.0.0.1:18222")
    expect(targets.get(8443)).toBe("http://127.0.0.1:3773")
    expect(targets.get(22)).toBe("(something else)")
    expect(tailscaleServeTargets("").size).toBe(0)
    expect(tailscaleServeTargets("{}").size).toBe(0)
  })
})

describe("memory limit", () => {
  it("every unit gets 2G and no swap unless the site has its own limit", () => {
    for (const s of [spec(), spec({ mode: "pipe" }), spec({ mode: "pipe", fn: {} }), spec({ memoryMb: null })]) {
      const props = sandboxProperties(s)
      expect(props).toContain("MemoryMax=2048M")
      expect(props).toContain("MemorySwapMax=0")
    }
    expect(systemdRunCommand(spec())).toContain("--property=MemoryMax=2048M")
    expect(sandboxProperties(spec({ memoryMb: 4096 }))).toContain("MemoryMax=4096M")
    expect(sandboxProperties(spec({ memoryMb: 512 }))).toContain("MemoryMax=512M")
  })

  it("never more than 16G, whatever the config says", () => {
    expect(DEFAULT_MEMORY_MB).toBe(2048)
    expect(MAX_MEMORY_MB).toBe(16384)
    expect(sandboxProperties(spec({ memoryMb: 16384 }))).toContain("MemoryMax=16384M")
    // A value over the cap (a hand-edited config) falls back to the default, not to "unlimited"
    for (const bad of [16385, 64 * 1024, Infinity, NaN, -1, 0]) {
      expect(sandboxProperties(spec({ memoryMb: bad }))).toContain("MemoryMax=2048M")
      expect(memoryLimitMb(bad)).toBe(2048)
    }
    expect(sandboxProperties(spec({ memoryMb: 999999 })).filter(p => p.startsWith("MemoryMax=")).length).toBe(1)
  })

  it("reads sizes like 4G and 512M, and refuses anything outside 64M-16G", () => {
    expect(validateMemoryMb("4G")).toBe(4096)
    expect(validateMemoryMb("4g")).toBe(4096)
    expect(validateMemoryMb("1.5G")).toBe(1536)
    expect(validateMemoryMb("512M")).toBe(512)
    expect(validateMemoryMb("512 MB")).toBe(512)
    expect(validateMemoryMb("16GiB")).toBe(16384)
    expect(validateMemoryMb(3000)).toBe(3000)
    for (const bad of ["17G", "16.1G", "32M", "4", "4T", "infinity", "", "4G; rm -rf /", "-4G", 16385, 63, null, undefined, {}, true]) {
      expect(validateMemoryMb(bad), String(bad)).toBeNull()
    }
    expect(formatMemory(2048)).toBe("2G")
    expect(formatMemory(1536)).toBe("1.5G")
    expect(formatMemory(512)).toBe("512M")
    expect(formatMemory(3000)).toBe("3000M")
  })
})
