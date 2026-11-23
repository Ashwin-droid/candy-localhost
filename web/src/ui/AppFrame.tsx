// The frame around every page (SPEC §3.4): top bar with the wordmark, nav, daemon lamp and user menu; the
// app-wide banners; the Confirm host and the toaster; the global shortcuts.

import type React from "react"
import { useEffect, useRef, useState } from "react"
import { useDomains, useSites } from "../api/sites.ts"
import { fmtClock, formatUptime } from "../lib/format.ts"
import { getTheme, onThemeChange, setTheme, type Theme } from "../lib/theme.ts"
import { Link, navigate, useRoute } from "../router.tsx"
import { logout, useSession, useSuperuserLost } from "../session.tsx"
import { useShortcut } from "../shared/shortcuts.ts"
import { Banner } from "./Banner.tsx"
import { ConfirmHost } from "./confirm.tsx"
import { Icon } from "./icons.tsx"
import { StatusDot } from "./StatusDot.tsx"
import { Toaster } from "./toast.tsx"
import "./AppFrame.css"

export const OFFLINE_TEXT = (at: string) => `Lost contact with the daemon. Showing what it last said at ${at}.`
export const SUPERUSER_ENDED = "Your superuser access ended."
export const BUILD_STALE_TEXT = "The portal is older than its source. Run bun run web:build."

interface NavItem { to: string; label: string; match: (path: string) => boolean }

const NAV: NavItem[] = [
  { to: "/", label: "Sites", match: p => p === "/" || p === "/sites" || p.startsWith("/sites/") },
  { to: "/public", label: "Domains", match: p => p === "/public" || p.startsWith("/public/") },
  { to: "/network", label: "Network", match: p => p === "/network" || p.startsWith("/network/") },
  { to: "/activity", label: "Activity", match: p => p === "/activity" },
]
const MACHINE: NavItem = { to: "/machine", label: "Machine", match: p => p === "/machine" || p.startsWith("/machine/") }

export function AppFrame(p: { children: React.ReactNode }): React.JSX.Element {
  const session = useSession()
  const route = useRoute()
  const { status, offline, updatedAt, error } = useSites()
  const domains = useDomains()
  const [lost, clearLost] = useSuperuserLost()

  useShortcut("n", () => navigate("/?add"))
  useShortcut("g s", () => navigate("/"))
  useShortcut("g a", () => navigate("/activity"))
  useShortcut("/", () => {
    const el = document.querySelector<HTMLElement>('[data-shortcut="filter"]')
    el?.focus()
  })

  const items = session.superuser ? [...NAV, MACHINE] : NAV
  const unprotected = domains.data?.configured
    ? Object.values(domains.data.bindings).filter(b => !b.hasPassword || !b.authEnabled).length : 0
  const onSites = NAV[0].match(route.path)

  return (
    <div className="frame">
      <a className="frame-skip" href="#main">Skip to content</a>
      <header className="frame-top">
        <div className="frame-top-inner">
          <Link to="/" className="frame-mark" aria-label="candy, Sites">candy<span className="frame-mark-dot">.</span></Link>
          <nav className="frame-nav" aria-label="Main">
            <div className="frame-nav-scroll">
              {items.map(n => {
                const active = n.match(route.path)
                return (
                  <Link key={n.to} to={n.to} className={active ? "frame-nav-item is-active" : "frame-nav-item"} aria-current={active ? "page" : undefined}>
                    {n.label}
                    {n.to === "/public" && unprotected ? (
                      <span className="frame-nav-flag" role="img"
                        aria-label={unprotected === 1 ? "1 domain has no password" : `${unprotected} domains have no password`}
                        title={unprotected === 1 ? "1 domain has no password" : `${unprotected} domains have no password`} />
                    ) : null}
                  </Link>
                )
              })}
            </div>
          </nav>
          <div className="frame-right">
            <DaemonLamp uptime={status?.uptime} offline={offline || (!!error && !status)} />
            <UserMenu user={session.user} superuser={session.superuser} />
          </div>
        </div>
      </header>
      <main className="frame-main" id="main">
        <div className="frame-content">
          {offline || lost || (session.buildStale && !onSites) ? (
            <div className="frame-banners">
              {offline ? <Banner kind="error">{OFFLINE_TEXT(updatedAt ? fmtClock(updatedAt).slice(0, 5) : "—")}</Banner> : null}
              {lost ? <Banner kind="warn" onDismiss={clearLost}>{SUPERUSER_ENDED}</Banner> : null}
              {session.buildStale && !onSites ? <Banner kind="info">{BUILD_STALE_TEXT}</Banner> : null}
            </div>
          ) : null}
          {p.children}
        </div>
      </main>
      <ConfirmHost />
      <Toaster />
    </div>
  )
}

function DaemonLamp(p: { uptime?: number; offline: boolean }): React.JSX.Element {
  const text = p.offline ? "Daemon offline" : p.uptime !== undefined ? `Daemon up ${formatUptime(p.uptime)}` : "Connecting…"
  const state = p.offline ? "crashed" : p.uptime !== undefined ? "running" : "idle"
  return (
    <span className="frame-lamp" title={text}>
      <StatusDot state={state} label={text} />
      <span className="frame-lamp-text" aria-hidden="true">{text}</span>
    </span>
  )
}

const THEMES: { value: Theme; label: string; icon: "monitor" | "sun" | "moon" }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
]

/** The only dropdown menu in the app. */
function UserMenu(p: { user: string; superuser: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [theme, setThemeState] = useState<Theme>("system")
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => { setThemeState(getTheme()); return onThemeChange(setThemeState) }, [])
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [open])

  const close = () => { setOpen(false); button.current?.focus() }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus() }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus() }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus() }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus() }
    else if (e.key === "Tab") setOpen(false)
  }
  const go = (to: string) => { setOpen(false); navigate(to) }

  return (
    <div className="frame-user" ref={root}>
      <button ref={button} type="button" className={open ? "frame-user-button is-open" : "frame-user-button"}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true) } }}>
        <span className="frame-user-name">{p.user}</span>
        {p.superuser ? <span className="frame-user-role">superuser</span> : null}
        <Icon name="chevron-down" size={14} className="frame-user-chevron" />
      </button>
      {open ? (
        <div ref={menu} className="frame-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
          <div className="frame-menu-who" role="presentation">
            <span className="frame-menu-who-name">{p.user}</span>
            <span className="frame-menu-who-role">{p.superuser ? "Superuser: you see every user's sites" : "Your sites"}</span>
          </div>
          <button type="button" role="menuitem" className="frame-menu-item" onClick={() => go("/settings")}>
            <Icon name="settings" size={14} />Settings
          </button>
          <button type="button" role="menuitem" className="frame-menu-item" onClick={() => go("/settings/passkeys")}>
            <Icon name="key" size={14} />Passkeys
          </button>
          <div className="frame-menu-sep" role="separator" />
          <div className="frame-menu-group" role="group" aria-label="Theme">
            <div className="frame-menu-label" aria-hidden="true">Theme</div>
            {THEMES.map(t => (
              <button key={t.value} type="button" role="menuitemradio" aria-checked={theme === t.value} className="frame-menu-item"
                onClick={() => { setTheme(t.value); setThemeState(t.value) }}>
                <Icon name={t.icon} size={14} />{t.label}
                {theme === t.value ? <Icon name="check" size={14} className="frame-menu-check" /> : null}
              </button>
            ))}
          </div>
          <div className="frame-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="frame-menu-item" onClick={() => { setOpen(false); void logout() }}>
            <Icon name="logout" size={14} />Log out
          </button>
        </div>
      ) : null}
    </div>
  )
}
