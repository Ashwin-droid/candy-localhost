import { describe, expect, test } from "bun:test"
import type { SiteManifestView } from "../../../api/types.ts"
import { collectSites } from "../../../lib/site.ts"
import { config, status } from "../../../test/fixtures.ts"
import { accessWords, parseSub, subscribersOf, subscriptionRow } from "../lib/manifest.ts"

const manifest = (o: Partial<SiteManifestView> = {}): SiteManifestView => ({
  auth: false, depends: [], publish: false, idle: false, pub: [], sub: [], service: false, cron: [], ...o,
})

// ci publishes three events (one per access level) and one bound to wa; app, bot and wa subscribe in different ways
const sites = collectSites({
  status,
  configs: {
    success: true,
    configs: {
      ci: config({ manifest: manifest({ pub: [
        { event: "built", auth: "none", users: [] },
        { event: "tested", auth: "lax", users: ["bob"] },
        { event: "deployed", auth: "strict", users: [], ordered: true },
        { event: "wa:reply", auth: "none", users: [], bind: "wa" },
      ] }) }),
      app: config({ manifest: manifest({ sub: ["ci:built", "ci:tested", "ci:deployed", "ci:gone", "other:x", "*::ping", "candy:sub-request"] }) }),
      bot: config({ manifest: manifest({ sub: ["ci:built", "*::reply"] }) }),
      wa: config({ manifest: manifest({ sub: ["*::reply"] }) }),
      plain: config(),
    },
  },
})
const site = (n: string) => sites.find(s => s.name === n)!

describe("parseSub", () => {
  test("site:event", () => expect(parseSub("ci:built")).toEqual({ kind: "site", publisher: "ci", event: "built" }))
  test("*::event", () => expect(parseSub("*::reply")).toEqual({ kind: "any", publisher: null, event: "reply" }))
  test("candy built-ins", () => expect(parseSub("candy:sub-request")).toEqual({ kind: "builtin", publisher: "candy", event: "sub-request" }))
  test("an event name with dots keeps everything after the first colon", () => {
    expect(parseSub("ci:build.done")).toEqual({ kind: "site", publisher: "ci", event: "build.done" })
  })
})

test("accessWords", () => {
  expect(accessWords("none", "ci")).toBe("Any site")
  expect(accessWords("lax", "ci")).toBe("Its own user and the listed users")
  expect(accessWords("strict", "ci")).toBe("The listed users, once ci approved the app")
})

describe("subscribersOf", () => {
  const pub = site("ci").manifest!.pub
  test("visible sites that name publisher:event", () => {
    expect(subscribersOf(site("ci"), pub[0], sites).map(s => s.name)).toEqual(["app", "bot"])
    expect(subscribersOf(site("ci"), pub[1], sites).map(s => s.name)).toEqual(["app"])
  })
  test("a bound entry goes only to its bind site, when that one takes *::<name>", () => {
    expect(subscribersOf(site("ci"), pub[3], sites).map(s => s.name)).toEqual(["wa"])
    const noTaker = sites.filter(s => s.name !== "wa")
    expect(subscribersOf(site("ci"), pub[3], noTaker)).toEqual([])
  })
  test("nobody", () => {
    expect(subscribersOf(site("plain"), { event: "x", auth: "none", users: [] }, sites)).toEqual([])
  })
})

describe("subscriptionRow", () => {
  const row = (s: string) => subscriptionRow(parseSub(s), sites)
  test("each status of §5.6", () => {
    expect(row("ci:built")).toEqual({ text: "Publisher declares it (any site may subscribe)", tone: "plain" })
    expect(row("ci:tested")).toEqual({ text: "Publisher declares it (lax: allowed if you're its user or listed)", tone: "plain" })
    expect(row("ci:deployed")).toEqual({ text: "Publisher declares it (strict: needs its approval)", tone: "plain" })
    expect(row("ci:gone")).toEqual({ text: "Publisher doesn't declare this event", tone: "error" })
    expect(row("other:x")).toEqual({ text: "Not one of your sites", tone: "plain" })
    expect(row("candy:sub-request")).toEqual({ text: "candy built-in event", tone: "plain" })
    expect(row("*::ping")).toEqual({ text: "Inbound from any site", tone: "plain" })
  })
  test("a bound entry is not a declaration of the plain event name", () => {
    expect(row("ci:wa:reply").text).toBe("Publisher doesn't declare this event")
  })
  test("a visible publisher without candy.json doesn't declare anything", () => {
    expect(row("plain:x").text).toBe("Publisher doesn't declare this event")
  })
})
