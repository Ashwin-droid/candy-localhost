// The frame every Settings page shares: the page header, the section's SubNav and a 720 px reading column.
// Also the small pieces the four pages use: inline notices and a seconds countdown.

import type React from "react"
import { useEffect, useState } from "react"
import { useSites } from "../../api/sites.ts"
import { useRoute } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import { Icon, PageHeader, SubNav } from "../../ui/index.ts"
import "./settings.css"

export function SettingsShell(p: { title: string; children: React.ReactNode }): React.JSX.Element {
  const { superuser } = useSession()
  const route = useRoute()
  useEffect(() => { document.title = `${p.title} – candy` }, [p.title])
  const path = route.path.replace(/\/+$/, "") || "/"
  const items = [
    { to: "/settings", label: "Account", active: path === "/settings" },
    { to: "/settings/passkeys", label: "Passkeys", active: path === "/settings/passkeys" || path === "/passkeys" },
    { to: "/settings/sign-in", label: "Sign in with candy", active: path === "/settings/sign-in" },
    ...(superuser ? [{ to: "/settings/daemon", label: "Daemon", active: path === "/settings/daemon" }] : []),
  ]
  return (
    <>
      <PageHeader title="Settings" />
      <div className="settings-layout">
        <SubNav items={items} label="Settings" />
        <div className="settings-col">
          {p.children}
        </div>
      </div>
    </>
  )
}

/** True while the daemon doesn't answer /status: every mutation button is disabled (SPEC §5). */
export function useOffline(): boolean {
  return useSites().offline
}

export type NoticeKind = "ok" | "error" | "wait"
export interface NoticeValue { kind: NoticeKind; text: string }

/** An inline result line under the thing it is about (the old pages' `.msg`). */
export function Notice(p: { notice: NoticeValue | null; children?: React.ReactNode }): React.JSX.Element | null {
  if (!p.notice) return <div className="settings-notice is-empty" role="status" aria-live="polite" />
  const { kind, text } = p.notice
  return (
    <div className={`settings-notice is-${kind}`} role={kind === "error" ? "alert" : "status"} aria-live="polite">
      {kind === "wait" ? null : <Icon name={kind === "ok" ? "check" : "error"} size={14} className="settings-notice-icon" />}
      <div className="settings-notice-body">
        <span>{text}</span>
        {p.children ? <div className="settings-notice-extra">{p.children}</div> : null}
      </div>
    </div>
  )
}

/** Whole seconds left until `until` (ms epoch), ticking every second; 0 when there is none. */
export function useCountdown(until: number | null): number {
  const left = () => (until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000)))
  const [, setTick] = useState(0)
  useEffect(() => {
    if (until === null) return
    const t = setInterval(() => {
      setTick(x => x + 1)
      if (left() <= 0) clearInterval(t)
    }, 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until])
  return left()
}
