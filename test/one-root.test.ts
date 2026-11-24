import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { caddyGlobalBlock, hubAllowedDomains, hubSiteBlock, servesHost, tlsFromHub, HUB_ACME_DIRECTORY } from "../caddy-config.ts"

const caddy = Bun.which("caddy")
const daemon = readFileSync(join(import.meta.dir, "..", "daemon.ts"), "utf8")
const RESERVED = ["portal", "k", "kill", "p", "candy"]

describe("one root for the candy network", () => {
  it("the hub signs for every shape of name candy makes, and nothing else", () => {
    expect(hubAllowedDomains([])).toEqual(["*.candy", "*.kill.candy", "*.k.candy", "*.portal.candy", "*.p.candy"])
    expect(hubAllowedDomains(["Pop-OS", "pop-os", "bad label", "homeserver"])).toEqual([
      "*.candy", "*.kill.candy", "*.k.candy", "*.portal.candy", "*.p.candy",
      "*.homeserver.candy", "*.kill.homeserver.candy", "*.k.homeserver.candy", "*.portal.homeserver.candy", "*.p.homeserver.candy",
      "*.pop-os.candy", "*.kill.pop-os.candy", "*.k.pop-os.candy", "*.portal.pop-os.candy", "*.p.pop-os.candy",
    ])
  })

  it("the hub block and the peer's tls refuse what isn't an address or a path", () => {
    expect(hubSiteBlock({ bind: "100.64.0.1", hostLabels: ["a"], mark: "# m" })).toContain("domains *.candy *.kill.candy")
    expect(() => hubSiteBlock({ bind: "100.64.0.1 }\nevil {", hostLabels: [], mark: "# m" })).toThrow()
    expect(() => hubSiteBlock({ bind: "100.64.0.0/10", hostLabels: [], mark: "# m" })).toThrow()
    expect(tlsFromHub("/home/a/.config/candy/hub-root.crt")).toContain(`dir ${HUB_ACME_DIRECTORY}`)
    expect(() => tlsFromHub("relative.crt")).toThrow()
    expect(() => tlsFromHub("/a b.crt")).toThrow()
    expect(() => caddyGlobalBlock({ adminSocket: "/run/a.sock", accessLog: "/a.log", tlsAsk: "http://evil.example/ask" })).toThrow()
    expect(caddyGlobalBlock({ adminSocket: "/run/a.sock", accessLog: "/a.log", tlsAsk: "http://localhost:9999/candy/tls-ask" })).toContain("ask http://localhost:9999/candy/tls-ask")
  })

  it("a certificate on demand only for a name the machine serves", () => {
    const serves = (h: string) => servesHost(h, ["wa", "deye"], "homeserver", RESERVED)
    for (const h of ["wa.candy", "WA.candy.", "deye.homeserver.candy", "portal.candy", "candy.candy", "wa.kill.candy", "wa.k.candy", "wa.portal.candy", "wa.p.homeserver.candy", "anything.localhost", "a.k.localhost", "localhost"]) {
      expect([h, serves(h)]).toEqual([h, true])
    }
    for (const h of ["nosuch.candy", "wa.pop-os.candy", "nosuch.k.candy", "kill.kill.candy", "wa.candy.evil.com", "example.com", "candy", ""]) {
      expect([h, serves(h)]).toEqual([h, false])
    }
    expect(servesHost("wa.candy", ["wa"], null, RESERVED)).toBe(true)
    expect(servesHost("wa.homeserver.candy", ["wa"], null, RESERVED)).toBe(false)
  })

  it("the daemon wires it: role from candy.candy, the pinned root, the ask and the root download", () => {
    expect(daemon).toContain("const candyTls = candyHub.role === 'peer' && hubRootPinned ? tlsFromHub(HUB_ROOT_FILE) : TLS_PER_NAME")
    expect(daemon).toContain("tlsAsk: TLS_ASK_URL")
    expect(daemon).toMatch(/url\.pathname === "\/candy\/tls-ask"\) \{\n\s+if \(!isLoopback\(/)
    expect(daemon).toContain("await refreshShortIntermediate()\n  await purgeSharedCerts()")
    // a hub that shows another root later is not believed
    expect(daemon).toContain("'HUB_ROOT_CHANGED'")
  })

  // The real thing, in a private network namespace: a hub and a peer Caddy built from the same
  // strings the daemon writes. The hub's "DNS" is /etc/hosts there: wa.* is the peer's, evil.candy isn't.
  const sandbox = Bun.spawnSync(["unshare", "-Urnm", "true"]).exitCode === 0
  it.skipIf(!caddy || !sandbox)("a peer gets certificates from the hub for its own names only, under the hub's root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candy-root-"))
    try {
      const root = `${dir}/hubdata/caddy/pki/authorities/local/root.crt`
      const global = (extra = "") => `{\n  admin off\n  skip_install_trust\n  pki {\n    ca local {\n      intermediate_lifetime 30d\n    }\n  }\n${extra}}\n`
      writeFileSync(`${dir}/hosts`, "127.0.0.1 localhost candy.candy evil.candy\n127.0.0.2 wa.candy wa.pop-os.candy wa.k.pop-os.candy\n")
      writeFileSync(`${dir}/hub.caddy`, global() + hubSiteBlock({ bind: "127.0.0.1", hostLabels: ["pop-os"], mark: "# hub" }))
      writeFileSync(`${dir}/peer.caddy`, global("  on_demand_tls {\n    ask http://localhost:9998/ask\n  }\n")
        + `http://localhost:9998 {\n  bind 127.0.0.1\n  respond 200\n}\n*.candy, *.pop-os.candy, *.k.pop-os.candy {\n  bind 127.0.0.2\n  ${tlsFromHub(root)}\n  respond "peer"\n}\n`)
      writeFileSync(`${dir}/run.sh`, `
ip link set lo up; ip addr add 127.0.0.2/8 dev lo
mount --bind ${dir}/hosts /etc/hosts
cd ${dir}
XDG_DATA_HOME=${dir}/hubdata XDG_CONFIG_HOME=${dir}/hubcfg ${caddy} run --config hub.caddy --adapter caddyfile >hub.log 2>&1 &
sleep 2
XDG_DATA_HOME=${dir}/peerdata XDG_CONFIG_HOME=${dir}/peercfg ${caddy} run --config peer.caddy --adapter caddyfile >peer.log 2>&1 &
sleep 2
for n in wa.candy wa.pop-os.candy wa.k.pop-os.candy evil.candy; do
  out=$(timeout 8 openssl s_client -connect 127.0.0.2:443 -servername $n -CAfile ${root} </dev/null 2>/dev/null)
  echo "$n|$(echo "$out" | openssl x509 -noout -issuer -ext subjectAltName 2>/dev/null | tr -d ' \\n')|$(echo "$out" | grep -c 'Verify return code: 0 (ok)')" >> out.txt
done
`)
      const run = Bun.spawn(["timeout", "-s", "KILL", "40", "unshare", "-Urnm", "--fork", "--kill-child", "sh", `${dir}/run.sh`], { stdout: "ignore", stderr: "ignore" })
      await run.exited
      const lines = Object.fromEntries(readFileSync(`${dir}/out.txt`, "utf8").trim().split("\n").map(l => { const [n, cert, ok] = l.split("|"); return [n, { cert, ok }] }))
      for (const n of ["wa.candy", "wa.pop-os.candy", "wa.k.pop-os.candy"]) {
        expect(lines[n].cert).toContain(`DNS:${n}`)
        expect(lines[n].cert).toContain("ECCIntermediate")
        expect(Number(lines[n].ok)).toBeGreaterThan(0)   // chains to the hub's root
      }
      // Not the peer's name in the hub's eyes: the hub refuses, and Caddy falls back to its own CA,
      // which the hub's root doesn't vouch for
      expect(Number(lines["evil.candy"].ok)).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
