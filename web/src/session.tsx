// Who is looking: boot (POST /portal/boot), the session context, /auth/me refreshes and logout (SPEC §2.7, §7.4).

import * as React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ApiError, getApi, setSuperuserLostHandler } from "./api/client.ts"
import { useResource } from "./api/resources.ts"
import { KEYS } from "./api/sites.ts"
import type { BootResponse, MeResponse } from "./api/types.ts"
import "./styles/session.css"

export interface Session { user: string; superuser: boolean; multiUser: boolean; owner: string; amr: "pam" | "passkey" | null;
  candyHost: string | null; pamUntil: number | null; tld: "candy" | "localhost"; buildStale: boolean;
  setPamUntil(v: number | null): void; refreshMe(): Promise<void> }

export const SessionContext: React.Context<Session | null> = createContext<Session | null>(null)

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error("useSession needs a SessionProvider (or SessionContext.Provider in tests)")
  return s
}

// "Your superuser access ended." is shown by AppFrame; kept outside Session so Session stays as specified
let superuserLost = false
const lostSubs = new Set<() => void>()
function setSuperuserLost(v: boolean) { superuserLost = v; for (const s of lostSubs) s() }
/** True once a superuser session has been told by the daemon that it no longer is one. */
export function useSuperuserLost(): [boolean, () => void] {
  const v = useSyncExternalStore(
    cb => { lostSubs.add(cb); return () => { lostSubs.delete(cb) } },
    () => superuserLost, () => superuserLost,
  )
  return [v, () => setSuperuserLost(false)]
}

export const SESSION_KEY = "candy_session"

/** The login page with this page as `next` (always a relative path starting with one "/"). */
export function loginUrl(): string {
  const next = location.pathname + location.search + location.hash
  return "/login?next=" + encodeURIComponent(next.startsWith("/") && !next.startsWith("//") ? next : "/")
}

/** POST /auth/logout (tokenless, errors ignored), forget the session secret, go to /login. */
export async function logout(): Promise<void> {
  let session: string | null = null
  try { session = localStorage.getItem(SESSION_KEY) } catch { session = null }
  try {
    await fetch("/auth/logout", {
      method: "POST", credentials: "same-origin", cache: "no-store", body: "{}",
      headers: { "Content-Type": "application/json", ...(session ? { "X-Candy-Session": session } : {}) },
    })
  } catch { /* the daemon may be down; logging out locally still works */ }
  try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
  location.assign("/login")
}

type BootState =
  | { kind: "booting" }
  | { kind: "ready"; boot: BootResponse }
  | { kind: "forbidden" }
  | { kind: "unreachable"; message: string; retryIn: number }

const BACKOFF = [2000, 4000, 8000, 10000]

/** Boots the page (once per load), then provides the session. Shows the frame's skeleton until ready. */
export function SessionProvider(p: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<BootState>({ kind: "booting" })
  const [pamUntil, setPamUntil] = useState<number | null>(null)
  const [superuser, setSuperuser] = useState(false)
  const superRef = useRef(false)
  superRef.current = superuser

  useEffect(() => {
    let session: string | null = null
    try { session = localStorage.getItem(SESSION_KEY) } catch { session = null }
    if (!session) { location.replace(loginUrl()); return }
    let cancelled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = () => {
      getApi().boot().then(b => {
        if (cancelled) return
        setPamUntil(b.pamUntil)
        setSuperuser(b.superuser)
        setState({ kind: "ready", boot: b })
      }, (e: unknown) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 403) { setState({ kind: "forbidden" }); return }
        const wait = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
        attempt++
        setState({ kind: "unreachable", message: e instanceof Error ? e.message : String(e), retryIn: wait })
        timer = setTimeout(run, wait)
      })
    }
    run()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  const ready = state.kind === "ready"
  const me = useResource<MeResponse>(ready ? KEYS.me : null,
    signal => getApi().get<MeResponse>("/auth/me", undefined, { signal }), { every: 600_000, onFocus: true })

  useEffect(() => {
    if (!me.data) return
    if (superRef.current && !me.data.superuser) setSuperuserLost(true)
    setSuperuser(me.data.superuser)
  }, [me.data])

  const refreshMe = me.reload
  useEffect(() => {
    setSuperuserLostHandler(() => { if (superRef.current) void refreshMe() })
    return () => setSuperuserLostHandler(null)
  }, [refreshMe])

  const setPam = useCallback((v: number | null) => setPamUntil(v), [])
  const session = useMemo<Session | null>(() => {
    if (state.kind !== "ready") return null
    const b = state.boot
    return {
      user: b.user, superuser, multiUser: b.multiUser, owner: b.owner, amr: b.amr, candyHost: b.candyHost,
      pamUntil, tld: b.tld, buildStale: b.buildStale, setPamUntil: setPam, refreshMe,
    }
  }, [state, superuser, pamUntil, setPam, refreshMe])

  if (state.kind === "forbidden") {
    return (
      <FullPage>
        <p>This address only works for a portal login.</p>
        <p><a className="session-link" href="/login">Log in</a></p>
      </FullPage>
    )
  }
  if (state.kind === "unreachable") {
    return (
      <FullPage>
        <p>Couldn’t reach candy. Retrying…</p>
        <p className="session-detail">{state.message}</p>
      </FullPage>
    )
  }
  if (!session) return <BootSkeleton />
  return <SessionContext.Provider value={session}>{p.children}</SessionContext.Provider>
}

function FullPage(p: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="session-page">
      <div className="session-card">
        <div className="session-mark">candy<span>.</span></div>
        {p.children}
      </div>
    </div>
  )
}

/** The frame's outline while booting: the top bar, nothing else. */
function BootSkeleton(): React.JSX.Element {
  return (
    <div className="session-boot" aria-busy="true" aria-label="Loading">
      <div className="session-boot-bar"><span className="session-mark">candy<span>.</span></span></div>
    </div>
  )
}
