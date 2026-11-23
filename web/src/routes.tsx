// The route table (SPEC §3.1). First match wins; every site route loads SitePage. No match: NotFoundPage.
// This file imports no page at module level: each page is its own lazily loaded chunk.

import type React from "react"

/** The daemon's `app` rule paths, exactly (portal-auth ROUTE_TABLE, §2.3). A web test checks ROUTES against it. */
export const APP_ROUTES: readonly string[] = [
  "/", "/sites", "/sites/*", "/public", "/public/*", "/network", "/network/*", "/activity", "/machine", "/machine/*",
  "/settings", "/settings/*", "/passkeys",
]

// One loader per page module: App.tsx caches a lazy component per loader, so routes that share a
// loader ("/" and "/sites", the three site routes) keep the same component type and never remount the page
type Loader = () => Promise<{ default: React.ComponentType }>
const sitesPage: Loader = () => import("./pages/sites/SitesPage.tsx")
const sitePage: Loader = () => import("./pages/site/SitePage.tsx")
const activityPage: Loader = () => import("./pages/activity/ActivityPage.tsx")
const publicPage: Loader = () => import("./pages/public/PublicPage.tsx")
const bindingPage: Loader = () => import("./pages/public/BindingPage.tsx")
const networkPage: Loader = () => import("./pages/network/NetworkPage.tsx")
const peersPage: Loader = () => import("./pages/network/PeersPage.tsx")
const machinePage: Loader = () => import("./pages/machine/MachinePage.tsx")
const accountPage: Loader = () => import("./pages/settings/AccountPage.tsx")
const passkeysPage: Loader = () => import("./pages/settings/PasskeysPage.tsx")
const signInPage: Loader = () => import("./pages/settings/SignInPage.tsx")
const daemonPage: Loader = () => import("./pages/settings/DaemonPage.tsx")

export const ROUTES = [
  { pattern: "/",                          load: sitesPage },
  { pattern: "/sites",                     load: sitesPage },
  { pattern: "/sites/:name",               load: sitePage },
  { pattern: "/sites/:name/requests/:id",  load: sitePage },
  { pattern: "/sites/:name/:tab",          load: sitePage },
  { pattern: "/activity",                  load: activityPage },
  { pattern: "/public",                    load: publicPage },
  { pattern: "/public/:subdomain",         load: bindingPage },
  { pattern: "/network",                   load: networkPage },
  { pattern: "/network/peers",             load: peersPage },
  { pattern: "/machine",                   load: machinePage },
  { pattern: "/machine/services",          load: machinePage },
  { pattern: "/settings",                  load: accountPage },
  { pattern: "/settings/passkeys",         load: passkeysPage },
  { pattern: "/passkeys",                  load: passkeysPage },
  { pattern: "/settings/sign-in",          load: signInPage },
  { pattern: "/settings/daemon",           load: daemonPage },
] as const satisfies readonly { pattern: string; load: () => Promise<{ default: React.ComponentType }> }[]   // no match: pages/NotFoundPage.tsx

export const loadNotFound = (): Promise<{ default: React.ComponentType }> => import("./pages/NotFoundPage.tsx")

export const CHUNK_RELOAD_KEY = "candy_reloaded"
export const UPDATED_MESSAGE = "The portal was updated. Reload the page."

/** Thrown when a page's chunk can't load twice in a row (an old tab after a rebuild). */
export class ChunkError extends Error {
  constructor() { super(UPDATED_MESSAGE); this.name = "ChunkError" }
}

/**
 * Wrap a lazy loader (§5.17): a failed import reloads the page once, remembered in
 * sessionStorage.candy_reloaded = <path>; a second failure for the same path throws ChunkError.
 */
export function guardedLoad<T>(load: () => Promise<T>, path: () => string): () => Promise<T> {
  return async () => {
    try {
      const mod = await load()
      try { sessionStorage.removeItem(CHUNK_RELOAD_KEY) } catch { /* ignore */ }
      return mod
    } catch {
      let already = false
      try { already = sessionStorage.getItem(CHUNK_RELOAD_KEY) === path() } catch { already = true }
      if (already) throw new ChunkError()
      try { sessionStorage.setItem(CHUNK_RELOAD_KEY, path()) } catch { throw new ChunkError() }
      location.reload()
      return new Promise<T>(() => {})
    }
  }
}
