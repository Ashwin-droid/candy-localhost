// Facts worked out from candy.json declarations (SPEC §5.6). The daemon exposes no subscriber or approval
// state yet, so everything here is derived from the manifests the viewer can see. Pure: no DOM.

import type { PubAuth, PubEvent } from "../../../api/types.ts"
import type { Site } from "../../../lib/site.ts"

/** Who may subscribe to an event of `name`, in words. */
export function accessWords(auth: PubAuth, name: string): string {
  if (auth === "none") return "Any site"
  if (auth === "lax") return "Its own user and the listed users"
  return `The listed users, once ${name} approved the app`
}

export interface ParsedSub { kind: "site" | "any" | "builtin"; publisher: string | null; event: string }

/** The daemon's own publisher name for built-in events ("candy:sub-request"). */
export const BUILTIN_SITE = "candy"

/** "site:event", "*::event" (inbound from any site that binds to it) or "candy:<event>" (built-in). */
export function parseSub(s: string): ParsedSub {
  const v = s.trim()
  if (v.startsWith("*::")) return { kind: "any", publisher: null, event: v.slice(3) }
  const at = v.indexOf(":")
  if (at <= 0) return { kind: "site", publisher: null, event: v }
  const publisher = v.slice(0, at), event = v.slice(at + 1)
  if (publisher === BUILTIN_SITE) return { kind: "builtin", publisher, event }
  return { kind: "site", publisher, event }
}

/** The name a bound entry's receiver sees: "wa:reply" bound to "wa" is "reply". */
export function boundEventName(e: Pick<PubEvent, "event" | "bind">): string | null {
  if (!e.bind || !e.event.startsWith(`${e.bind}:`)) return null
  return e.event.slice(e.bind.length + 1)
}

/**
 * The visible sites that get one of `site`'s events. An unbound event goes to every site whose "sub" names
 * "<site>:<event>"; a bound entry goes only to its "bind" site, and only when that one takes "*::<name>".
 * Other users' sites aren't visible, so they aren't counted.
 */
export function subscribersOf(site: Pick<Site, "name">, pub: PubEvent, all: Site[]): Site[] {
  const bound = boundEventName(pub)
  if (pub.bind) {
    if (!bound) return []
    return all.filter(s => s.name === pub.bind && !!s.manifest?.sub.includes(`*::${bound}`))
  }
  const key = `${site.name}:${pub.event}`
  return all.filter(s => !!s.manifest?.sub.includes(key))
}

export interface SubRow { text: string; tone: "plain" | "error" }

/** What can be said about one "sub" entry from the manifests the viewer sees. */
export function subscriptionRow(sub: ParsedSub, all: Site[]): SubRow {
  if (sub.kind === "builtin") return { text: "candy built-in event", tone: "plain" }
  if (sub.kind === "any") return { text: "Inbound from any site", tone: "plain" }
  const publisher = all.find(s => s.name === sub.publisher)
  if (!publisher) return { text: "Not one of your sites", tone: "plain" }
  const entry = publisher.manifest?.pub.find(p => !p.bind && p.event === sub.event)
  if (!entry) return { text: "Publisher doesn't declare this event", tone: "error" }
  if (entry.auth === "none") return { text: "Publisher declares it (any site may subscribe)", tone: "plain" }
  if (entry.auth === "lax") return { text: "Publisher declares it (lax: allowed if you're its user or listed)", tone: "plain" }
  return { text: "Publisher declares it (strict: needs its approval)", tone: "plain" }
}
