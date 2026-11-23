// Theme preference: localStorage.candy_theme = "light" | "dark", absent = follow the system.
// Applied as <html data-theme>. Every access is guarded: no DOM under bun test, and storage may throw.

export type Theme = "system" | "light" | "dark"

const KEY = "candy_theme"

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage } catch { return null }
}

export function getTheme(): Theme {
  try {
    const v = storage()?.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch { return "system" }
}

/** Apply a theme to the document (no storage write). */
export function applyTheme(t: Theme): void {
  if (typeof document === "undefined") return
  const el = document.documentElement
  if (t === "system") delete el.dataset.theme
  else el.dataset.theme = t
}

export function setTheme(t: Theme): void {
  try {
    const s = storage()
    if (t === "system") s?.removeItem(KEY)
    else s?.setItem(KEY, t)
  } catch { /* private mode: the choice lasts this page only */ }
  applyTheme(t)
  for (const fn of listeners) fn(t)
}

const listeners = new Set<(t: Theme) => void>()
/** For the user menu's radio items: called after setTheme. */
export function onThemeChange(fn: (t: Theme) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
