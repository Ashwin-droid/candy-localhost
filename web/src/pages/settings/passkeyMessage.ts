// The checks between this page and the popup on candy's own host (SPEC §5.16, 02 §2.5). Pure.

/** The parts of a MessageEvent we look at. */
export interface PasskeyMessageEvent { origin: string; source: unknown; data: unknown }

/**
 * True only for `{type: "candy-passkey", purpose: "enroll", ok: true}` posted by the popup this page opened,
 * from exactly the candy host's origin. Anything else is ignored.
 */
export function acceptPasskeyMessage(e: PasskeyMessageEvent, candyOrigin: string | null, popup: unknown): boolean {
  if (!candyOrigin || e.origin !== candyOrigin) return false
  if (!popup || e.source !== popup) return false
  const d = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>
  if (d.type !== "candy-passkey" || d.purpose !== "enroll") return false
  return d.ok === true
}

/** The enroll URL from POST /passkeys/enroll/start, only when it is on https://<candyHost>; else null. */
export function checkEnrollUrl(url: unknown, candyHost: string | null): string | null {
  if (!candyHost || typeof url !== "string") return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  return u.origin === "https://" + candyHost ? u.href : null
}

export const ENROLL_WRONG = "Something went wrong. Try again."
