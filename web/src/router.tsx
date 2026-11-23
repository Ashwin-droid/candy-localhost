// A small history router (SPEC §8 A). Paths are matched against ROUTES (routes.tsx) for params.
// Nothing reads window at import time; BrowserRouter subscribes in an effect.

import * as React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { ROUTES } from "./routes.tsx"

export interface Route { path: string; params: Record<string, string>; query: URLSearchParams; hash: string;
  state: unknown /* history.state at the time of navigation */ }

export const RouterContext: React.Context<Route | null> = createContext<Route | null>(null)

/** ":param" segments, "*" as the last segment matches one or more segments (not the bare prefix). */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const norm = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p)
  const ps = norm(pattern).split("/").slice(1)
  const xs = norm(path).split("/").slice(1)
  const params: Record<string, string> = {}
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    if (p === "*" && i === ps.length - 1) {
      const rest = xs.slice(i)
      if (!rest.length || rest.every(s => s === "")) return null
      params["*"] = rest.join("/")
      return params
    }
    const x = xs[i]
    if (x === undefined) return null
    if (p.startsWith(":")) {
      if (x === "") return null
      try { params[p.slice(1)] = decodeURIComponent(x) } catch { return null }
    } else if (p !== x) return null
  }
  return xs.length === ps.length ? params : null
}

/** The first ROUTES entry that matches, with its params. */
export function matchRoute(path: string): { index: number; params: Record<string, string> } | null {
  for (let i = 0; i < ROUTES.length; i++) {
    const params = matchPath(ROUTES[i].pattern, path)
    if (params) return { index: i, params }
  }
  return null
}

function routeFrom(href: string, state: unknown): Route {
  const u = new URL(href, "http://portal.invalid")
  return {
    path: u.pathname,
    params: matchRoute(u.pathname)?.params ?? {},
    query: u.searchParams,
    hash: u.hash,
    state: state ?? null,
  }
}

// ---- browser history ----

const NAV_EVENT = "candy:navigate"

export function navigate(to: string, o?: { replace?: boolean; state?: unknown }): void {
  if (typeof window === "undefined") return
  const before = location.pathname
  const next = new URL(to, location.href)
  if (next.origin !== location.origin) { location.assign(next.href); return }
  const url = next.pathname + next.search + next.hash
  if (o?.replace) history.replaceState(o?.state ?? null, "", url)
  else history.pushState(o?.state ?? null, "", url)
  window.dispatchEvent(new Event(NAV_EVENT))
  if (!o?.replace && next.pathname !== before && !next.hash) window.scrollTo(0, 0)
}

let version = 0
const subscribeHistory = (cb: () => void) => {
  const on = () => { version++; cb() }
  window.addEventListener("popstate", on)
  window.addEventListener(NAV_EVENT, on)
  return () => { window.removeEventListener("popstate", on); window.removeEventListener(NAV_EVENT, on) }
}
const historySnapshot = () => `${version}|${location.pathname}${location.search}${location.hash}`

/** The element id a `#hash` names; a malformed escape (`#%`, `#%E0`) is taken as written, never thrown. */
export function hashId(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash
  try { return decodeURIComponent(raw) } catch { return raw }
}

/** Provides the live Route from window.history to everything below it. */
export function BrowserRouter(p: { children: React.ReactNode }): React.JSX.Element {
  const key = useSyncExternalStore(subscribeHistory, historySnapshot, () => "0|/")
  const route = useMemo(
    () => routeFrom(location.pathname + location.search + location.hash, history.state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  )
  // Bring an anchor into view after navigating to it (Settings sections, manifest#events)
  useEffect(() => {
    if (!route.hash) return
    const id = hashId(route.hash)
    const raf = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }))
    return () => cancelAnimationFrame(raf)
  }, [route.path, route.hash])
  return <RouterContext.Provider value={route}>{p.children}</RouterContext.Provider>
}

/** Tests: a fixed Route, no window. `path` may carry a query and a hash. */
export function MemoryRoute(p: { path: string; state?: unknown; children: React.ReactNode }): React.JSX.Element {
  const route = useMemo(() => routeFrom(p.path, p.state), [p.path, p.state])
  return <RouterContext.Provider value={route}>{p.children}</RouterContext.Provider>
}

export function useRoute(): Route {
  const r = useContext(RouterContext)
  if (!r) throw new Error("useRoute needs a BrowserRouter or MemoryRoute above it")
  return r
}

/** Clears history.state without changing the URL (so a reload or Back doesn't show it again). */
export function clearHistoryState(h: Pick<History, "replaceState"> | null = typeof history === "undefined" ? null : history): void {
  if (!h || typeof location === "undefined") return
  h.replaceState(null, "", location.pathname + location.search + location.hash)
}

/**
 * Reads route.state once on mount into component state, then clears it with history.replaceState(null, "")
 * so a reload or Back doesn't show it again.
 */
export function useHistoryState<T>(): T | null {
  const route = useRoute()
  const [state] = useState<T | null>(() => (route.state ?? null) as T | null)
  useEffect(() => {
    if (state !== null) clearHistoryState()
    // once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return state
}

/** One query parameter and a setter (replace by default, so typing in a filter doesn't stack history). */
export function useQueryParam(key: string): [string | null, (v: string | null, o?: { replace?: boolean }) => void] {
  const route = useRoute()
  const value = route.query.get(key)
  const set = useCallback((v: string | null, o?: { replace?: boolean }) => {
    if (typeof location === "undefined") return
    const q = new URLSearchParams(location.search)
    if (v === null || v === "") q.delete(key)
    else q.set(key, v)
    const s = q.toString()
    navigate(location.pathname + (s ? `?${s}` : "") + location.hash, { replace: o?.replace ?? true })
  }, [key])
  return [value, set]
}

export interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> { to: string; replace?: boolean }

/** An in-app link: a real <a href>, with plain left clicks handled by the router. */
export function Link(p: LinkProps): React.JSX.Element {
  const { to, replace, onClick, target, ...rest } = p
  const click = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    if (target && target !== "_self") return
    e.preventDefault()
    navigate(to, { replace })
  }
  return <a {...rest} href={to} target={target} onClick={click} />
}
