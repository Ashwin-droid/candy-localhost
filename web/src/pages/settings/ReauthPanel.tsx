// The inline "recent password" panel (SPEC §5.16): adding or removing a passkey needs a password login from
// the last 10 minutes. POST /auth/reauth {password} -> {pamUntil}.

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { ApiError, getApi } from "../../api/client.ts"
import { Button, Field, Input } from "../../ui/index.ts"
import { useCountdown } from "./SettingsShell.tsx"
import type { ReauthResponse } from "./types.ts"

export const REAUTH_TEXT = "Adding or removing a passkey needs a recent password login."
export const REAUTH_FAILED = "That didn’t work."

/** What to show for a failed POST /auth/reauth. */
export function reauthError(e: unknown): { text: string; retryAfter?: number } {
  if (e instanceof ApiError) {
    const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>
    if (typeof e.retryAfter === "number" && e.retryAfter > 0) return { text: "", retryAfter: e.retryAfter }
    if (e.status === 0) return { text: e.message }
    return { text: typeof data.error === "string" && data.error ? data.error : REAUTH_FAILED }
  }
  return { text: e instanceof Error ? e.message : REAUTH_FAILED }
}

export function ReauthPanel(p: { user: string; onDone: (ok: boolean, pamUntil?: number) => void; disabled?: boolean }): React.JSX.Element {
  const [password, setPassword] = useState("")
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const left = useCountdown(lockedUntil)
  const locked = lockedUntil !== null && left > 0
  const focusInput = () => (document.getElementById("reauth-password") as HTMLInputElement | null)?.focus()
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest" })
    focusInput()
  }, [])
  useEffect(() => { if (lockedUntil !== null && left === 0) { setLockedUntil(null); focusInput() } }, [left, lockedUntil])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (checking || locked || p.disabled) return
    setChecking(true)
    setError(null)
    const pw = password
    setPassword("")
    try {
      const out = await getApi().post<ReauthResponse>("/auth/reauth", { password: pw })
      setChecking(false)
      if (typeof out?.pamUntil === "number") { p.onDone(true, out.pamUntil); return }
      setError(REAUTH_FAILED)
    } catch (err) {
      setChecking(false)
      const r = reauthError(err)
      if (r.retryAfter) setLockedUntil(Date.now() + r.retryAfter * 1000)
      else { setError(r.text); focusInput() }
    }
  }

  const status = checking ? "Checking…" : locked ? `Too many failed logins. Try again in ${left}s.` : null
  return (
    <div className="settings-sheet settings-reauth" ref={panel} role="group" aria-labelledby="reauth-title">
      <form className="settings-reauth-form" onSubmit={submit} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); p.onDone(false) } }}>
        <div className="settings-reauth-head">
          <h3 className="settings-reauth-title" id="reauth-title">Enter your password again</h3>
          <p className="help">{REAUTH_TEXT}</p>
        </div>
        <input type="text" name="username" autoComplete="username" value={p.user} readOnly hidden />
        <div className="fields-2">
          <Field label="Password" htmlFor="reauth-password" error={error}>
            <Input id="reauth-password" type="password" autoComplete="current-password" value={password}
              onChange={e => setPassword(e.target.value)} disabled={checking} />
          </Field>
        </div>
        <div className="settings-actions">
          <span className="settings-actions-status" role="status" aria-live="polite">{status}</span>
          <Button variant="quiet" onClick={() => p.onDone(false)} disabled={checking}>Cancel</Button>
          <Button variant="primary" type="submit" busy={checking} disabled={locked || p.disabled}>Confirm</Button>
        </div>
      </form>
    </div>
  )
}
