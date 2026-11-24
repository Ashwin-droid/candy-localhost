import { expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TLS_PER_NAME } from "../caddy-config.ts"

const caddy = Bun.which("caddy")
const daemon = readFileSync(join(import.meta.dir, "..", "daemon.ts"), "utf8")

// A block that answers many names must not hand every visitor one certificate naming them all
// ("*.candy", or a list of every alias host): each name gets its own.
it("every wildcard and alias-list block the daemon writes asks for a certificate per name", () => {
  const lines = daemon.split("\n")
  const openers = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^\*\.[a-z.*, ]+ \{$/.test(l) || /^\$\{\[\.\.\.new Set\(candy\w+Hosts\)\]\.filter\(isHostName\)\.join\(", "\)\} \{$/.test(l))
  expect(openers.length).toBe(9)
  for (const { l, i } of openers) {
    const body = lines.slice(i + 1, i + 6).join("\n")
    // *.candy blocks take candyTls: TLS_PER_NAME, or on a peer the same thing from the hub (tlsFromHub)
    expect(`${l}\n${body}`).toMatch(l.includes(".localhost") ? /\$\{TLS_PER_NAME\}/ : /\$\{candyTls\}/)
    expect(body).not.toMatch(/^\s*tls internal\s*$/m)
  }
})

// Caddy doesn't manage a certificate for an explicit name that an on-demand wildcard block covers
// ("wa.candy" next to "*.candy"): its handshake then fails. So a named block is on-demand too.
it("no block is left on plain `tls internal`", () => {
  expect(daemon).not.toMatch(/^\s*tls internal\s*$/m)
})

it.skipIf(!caddy)("a named block next to the wildcard still gets a certificate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "candy-tls-"))
  const port = 18000 + Math.floor(Math.random() * 1000)
  const env = { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir }
  writeFileSync(join(dir, "Caddyfile"), `{\n  admin off\n  auto_https disable_redirects\n  https_port ${port}\n  skip_install_trust\n}\nwa.candy {\n  bind 127.0.0.1\n  ${TLS_PER_NAME}\n  respond "wa"\n}\n*.candy {\n  bind 127.0.0.1\n  ${TLS_PER_NAME}\n  respond "any"\n}\n`)
  const proc = Bun.spawn([caddy!, "run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], { stdout: "ignore", stderr: "ignore", env })
  try {
    const san = async (name: string) => {
      for (let i = 0; i < 40; i++) {
        const r = Bun.spawnSync(["sh", "-c", `echo | openssl s_client -connect 127.0.0.1:${port} -servername ${name} 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null | tail -1`])
        const out = r.stdout.toString().trim()
        if (out) return out
        await Bun.sleep(100)
      }
      return ""
    }
    expect(await san("wa.candy")).toBe("DNS:wa.candy")
    expect(await san("other.candy")).toBe("DNS:other.candy")
  } finally {
    proc.kill()
    await proc.exited
    rmSync(dir, { recursive: true, force: true })
  }
})

it.skipIf(!caddy)("Caddy takes it: on-demand, from its own CA, with no ask endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "candy-tls-"))
  try {
    const f = join(dir, "Caddyfile")
    writeFileSync(f, `{\n  admin off\n}\n*.candy, *.k.candy {\n  bind 127.0.0.1\n  ${TLS_PER_NAME}\n  respond "ok"\n}\n`)
    const env = { ...process.env, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir }
    const r = Bun.spawnSync([caddy!, "adapt", "--config", f, "--adapter", "caddyfile"], { stderr: "pipe", env })
    expect(r.exitCode).toBe(0)
    const policy = JSON.parse(r.stdout.toString()).apps.tls.automation.policies[0]
    expect(policy.on_demand).toBe(true)
    expect(policy.issuers).toEqual([{ module: "internal" }])
    // validate provisions the TLS app, which is where a missing permission module would be refused
    const v = Bun.spawnSync([caddy!, "validate", "--config", f, "--adapter", "caddyfile"], { stderr: "pipe", stdout: "pipe", env })
    expect(v.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it("knows a stored certificate that several names share", async () => {
  const { isSharedCert } = await import("../caddy-config.ts")
  expect(isSharedCert("wildcard_.candy", ["*.candy"])).toBe(true)
  expect(isSharedCert("wildcard_.k.candy", null)).toBe(true)        // unreadable .json: the folder name is enough
  expect(isSharedCert("a.candy", ["a.candy", "a-host.candy"])).toBe(true)
  expect(isSharedCert("odd", ["*.x"])).toBe(true)
  expect(isSharedCert("deye.candy", ["deye.candy"])).toBe(false)
  expect(isSharedCert("deye.candy", null)).toBe(false)
  // and the daemon clears them before it starts Caddy
  expect(daemon).toMatch(/await purgeSharedCerts\(\)\n\n  try \{\n    caddyProc = spawn/)
})
