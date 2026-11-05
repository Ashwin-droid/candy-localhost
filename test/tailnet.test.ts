import { describe, expect, it } from "bun:test"

import {
  buildActionSubdomain,
  buildLanRecords,
  buildNetworkSnapshot,
  deriveTailscaleHostLabel,
  isPrivateLanIp,
  pickCandyDnsView,
  resolveCandyDnsRecord,
  resolveLocalCandyRouteName,
  type RemoteRouteClaim,
} from "../tailnet"

describe("tailnet helpers", () => {
  it("prefers the first label from a MagicDNS name", () => {
    expect(deriveTailscaleHostLabel({
      dnsName: "pop-os.wisent-monitor.ts.net.",
      hostName: "Pop!_OS",
    })).toBe("pop-os")
  })

  it("falls back to a sanitized hostname when DNSName is missing", () => {
    expect(deriveTailscaleHostLabel({
      dnsName: null,
      hostName: "Ashwin's Pixel",
    })).toBe("ashwin-s-pixel")
  })

  it("resolves hostname aliases without clobbering exact dotted routes", () => {
    expect(resolveLocalCandyRouteName("hello.pop-os", ["hello"], "pop-os")).toBe("hello")
    expect(resolveLocalCandyRouteName("hello.pop-os", ["hello", "hello.pop-os"], "pop-os")).toBe("hello.pop-os")
  })

  it("builds host-scoped action subdomains", () => {
    expect(buildActionSubdomain("hello", "k", "pop-os")).toBe("hello.k.pop-os")
    expect(buildActionSubdomain("hello", "portal", null)).toBe("hello.portal")
  })
})

describe("network snapshot", () => {
  const remoteClaims: RemoteRouteClaim[] = [
    {
      name: "hello",
      ip: "100.104.61.13",
      advertisedAt: 1000,
      claimedAt: 1000,
      ownerId: "peer-openclaw",
      hostName: "openclaw",
      dnsName: "openclaw.wisent-monitor.ts.net",
      hostLabel: "openclaw",
    },
    {
      name: "hello",
      ip: "100.90.53.121",
      advertisedAt: 2000,
      claimedAt: 2000,
      ownerId: "peer-debian",
      hostName: "debian",
      dnsName: "avf-droid-debian.wisent-monitor.ts.net",
      hostLabel: "debian",
    },
  ]

  it("keeps canonical ownership with the earliest remote claim", () => {
    const snapshot = buildNetworkSnapshot({
      localNames: [],
      localIp: "100.117.235.58",
      localIdentity: {
        hostName: "pop-os",
        dnsName: "pop-os.wisent-monitor.ts.net",
        hostLabel: "pop-os",
      },
      remoteClaims,
      ttlMs: 30 * 60 * 1000,
      now: 5000,
    })

    expect(snapshot.dnsRecords.hello).toBe("100.104.61.13")
    expect(snapshot.dnsRecords["hello.openclaw"]).toBe("100.104.61.13")
    expect(snapshot.dnsRecords["hello.debian"]).toBe("100.90.53.121")
    expect(snapshot.remote[0].canonicalFqdn).toBe("hello.candy")
    expect(snapshot.remote[1].canonicalFqdn).toBeNull()
  })

  it("lets local routes win the top-level name while preserving per-host aliases", () => {
    const snapshot = buildNetworkSnapshot({
      localNames: ["hello"],
      localIp: "100.117.235.58",
      localIdentity: {
        hostName: "pop-os",
        dnsName: "pop-os.wisent-monitor.ts.net",
        hostLabel: "pop-os",
      },
      remoteClaims,
      ttlMs: 30 * 60 * 1000,
      now: 5000,
    })

    expect(snapshot.dnsRecords.hello).toBe("100.117.235.58")
    expect(snapshot.dnsRecords["hello.pop-os"]).toBe("100.117.235.58")
    expect(snapshot.dnsRecords["hello.openclaw"]).toBe("100.104.61.13")
    expect(snapshot.dnsRecords["hello.debian"]).toBe("100.90.53.121")
    expect(snapshot.local[0].aliasFqdns).toEqual(["hello.pop-os.candy"])
    expect(snapshot.remote.every(entry => entry.canonicalFqdn === null)).toBe(true)
  })

  it("resolves action subdomains through canonical and host-scoped aliases", () => {
    const snapshot = buildNetworkSnapshot({
      localNames: ["hello"],
      localIp: "100.117.235.58",
      localIdentity: {
        hostName: "pop-os",
        dnsName: "pop-os.wisent-monitor.ts.net",
        hostLabel: "pop-os",
      },
      remoteClaims,
      ttlMs: 30 * 60 * 1000,
      now: 5000,
    })

    expect(resolveCandyDnsRecord({
      subdomain: "hello.k",
      records: snapshot.dnsRecords,
      localNames: ["hello"],
      hostIp: "100.117.235.58",
    })).toBe("100.117.235.58")

    expect(resolveCandyDnsRecord({
      subdomain: "hello.k.pop-os",
      records: snapshot.dnsRecords,
      localNames: ["hello"],
      hostIp: "100.117.235.58",
    })).toBe("100.117.235.58")

    expect(resolveCandyDnsRecord({
      subdomain: "hello.k.openclaw",
      records: snapshot.dnsRecords,
      localNames: ["hello"],
      hostIp: "100.117.235.58",
    })).toBe("100.104.61.13")
  })
})

describe("LAN publishing", () => {
  const tailscaleIp = "100.86.31.43"
  const lanIp = "192.168.0.7"
  const local = [
    { name: "agh", aliasFqdns: ["agh.homeserver.candy"] },
    { name: "notes", aliasFqdns: ["notes.homeserver.candy"] },
  ]
  const records = {
    agh: tailscaleIp,
    "agh.homeserver": tailscaleIp,
    notes: tailscaleIp,
    "notes.homeserver": tailscaleIp,
  }

  it("treats only RFC 1918 addresses as LAN", () => {
    expect(isPrivateLanIp("192.168.0.42")).toBe(true)
    expect(isPrivateLanIp("10.1.2.3")).toBe(true)
    expect(isPrivateLanIp("172.20.0.5")).toBe(true)
    expect(isPrivateLanIp("::ffff:192.168.0.42")).toBe(true)
    expect(isPrivateLanIp("172.32.0.5")).toBe(false)
    expect(isPrivateLanIp("100.86.31.43")).toBe(false)
    expect(isPrivateLanIp("127.0.0.1")).toBe(false)
    expect(isPrivateLanIp("8.8.8.8")).toBe(false)
    expect(isPrivateLanIp("fe80::1")).toBe(false)
  })

  it("picks the LAN view by listener or by source address", () => {
    expect(pickCandyDnsView("lan", "127.0.0.1")).toBe("lan")
    expect(pickCandyDnsView("default", "192.168.0.42")).toBe("lan")
    expect(pickCandyDnsView("default", "127.0.0.1")).toBe("tailnet")
    expect(pickCandyDnsView("default", "100.101.102.103")).toBe("tailnet")
  })

  it("builds LAN records only for published local names and their aliases", () => {
    expect(buildLanRecords({ published: ["AGH", "gone"], local, lanIp })).toEqual({
      agh: lanIp,
      "agh.homeserver": lanIp,
    })
    expect(buildLanRecords({ published: [], local, lanIp })).toEqual({})
    expect(buildLanRecords({ published: ["agh"], local, lanIp: null })).toEqual({})
  })

  it("answers published names with the LAN IP in the LAN view only", () => {
    const lanRecords = buildLanRecords({ published: ["agh"], local, lanIp })
    const resolve = (subdomain: string, view: "lan" | "tailnet") => resolveCandyDnsRecord({
      subdomain,
      records,
      localNames: ["agh", "notes"],
      hostIp: tailscaleIp,
      lanRecords: view === "lan" ? lanRecords : undefined,
    })

    expect(resolve("agh", "lan")).toBe(lanIp)
    expect(resolve("agh.homeserver", "lan")).toBe(lanIp)
    expect(resolve("agh", "tailnet")).toBe(tailscaleIp)
    expect(resolve("agh.homeserver", "tailnet")).toBe(tailscaleIp)
  })

  it("keeps unpublished names, built-ins and action subdomains on the tailnet", () => {
    const lanRecords = buildLanRecords({ published: ["agh"], local, lanIp })
    const resolve = (subdomain: string) => resolveCandyDnsRecord({
      subdomain,
      records,
      localNames: ["agh", "notes"],
      hostIp: tailscaleIp,
      lanRecords,
    })

    expect(resolve("notes")).toBe(tailscaleIp)
    expect(resolve("candy")).toBe(tailscaleIp)
    expect(resolve("portal")).toBe(tailscaleIp)
    expect(resolve("agh.kill")).toBe(tailscaleIp)
    expect(resolve("agh.p.homeserver")).toBe(tailscaleIp)
    expect(resolve("missing")).toBeNull()
  })
})
