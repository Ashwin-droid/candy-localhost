import { describe, expect, it } from "bun:test"

import {
  buildActionSubdomain,
  buildNetworkSnapshot,
  deriveTailscaleHostLabel,
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
