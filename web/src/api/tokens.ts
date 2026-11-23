// Page-token chains (SPEC §7.2 rules 3-4). A chain is one lane: a promise queue with one mutation in flight, so
// two concurrent posts never share a token. The token itself is rolled by client.ts after every mutation.

export type Lane = "main" | "long" | "term"

export const LANES: readonly Lane[] = ["main", "long", "term"]

/** Recovery re-mints of one lane are at most this far apart (the eviction-loop guard of §2.5). */
export const REMINT_INTERVAL_MS = 30_000

export class TokenChain {
  readonly lane: Lane
  token: string | null = null
  /** When this lane last re-minted to recover from a dead chain (not its first mint). */
  lastRemint = -Infinity
  private tail: Promise<unknown> = Promise.resolve()

  constructor(lane: Lane) { this.lane = lane }

  /** Run `fn` after every earlier call on this lane has settled. Rejections don't block the queue. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Whether a recovery re-mint is allowed now (and, if so, records it). */
  mayRemint(now: number): boolean {
    if (now - this.lastRemint < REMINT_INTERVAL_MS) return false
    this.lastRemint = now
    return true
  }
}

export function createLanes(): Record<Lane, TokenChain> {
  return { main: new TokenChain("main"), long: new TokenChain("long"), term: new TokenChain("term") }
}
