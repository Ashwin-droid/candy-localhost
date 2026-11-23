import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/** base: what the fields started from; seen: the last server value looked at; pending: one arrived while dirty. */
export interface DraftState<T> { base: T; draft: T; seen: string; pending: boolean }

const isDirty = <T extends Record<string, unknown>>(s: DraftState<T>) =>
  Object.keys({ ...s.base, ...s.draft }).some(k => !same(s.base[k], s.draft[k]))

/** A new server value: an untouched draft follows it; an edited one keeps its edits and remembers it is behind. */
export function draftOnServer<T extends Record<string, unknown>>(s: DraftState<T>, value: T, key: string): DraftState<T> {
  if (key === s.seen) return s
  if (isDirty(s)) return { ...s, seen: key, pending: true }
  return { base: value, draft: value, seen: key, pending: false }
}

/** The draft became clean again (edited back by hand): catch up with a server value that came in meanwhile. */
export function draftOnClean<T extends Record<string, unknown>>(s: DraftState<T>, latest: T | undefined): DraftState<T> {
  if (!s.pending || latest === undefined || isDirty(s)) return s
  return { base: latest, draft: latest, seen: JSON.stringify(latest), pending: false }
}

/**
 * Edit state for a settings form. `server` is the value the daemon last reported (pass a fresh object each
 * render if you like: changes are detected by value). While the draft has no edits it follows the server;
 * once edited, a new server value sets `conflict` and the draft is NOT overwritten. If the edits are then
 * undone by hand, the draft takes the newer server value.
 */
export function useDraft<T extends Record<string, unknown>>(server: T | undefined): {
  draft: T; set: <K extends keyof T>(k: K, v: T[K]) => void; dirty: boolean; dirtyKeys: (keyof T)[]
  conflict: boolean    // the server value changed while dirty; the draft is NOT overwritten
  reset: () => void; commit: (saved?: Partial<T>) => void   // after a successful save
} {
  const serverKey = server === undefined ? "" : JSON.stringify(server)
  const [state, setState] = useState<DraftState<T>>(() => ({
    base: (server ?? {}) as T, draft: (server ?? {}) as T, seen: serverKey, pending: false,
  }))
  const latest = useRef(server)
  latest.current = server

  const dirtyKeys = useMemo(() => {
    const keys = new Set<keyof T>([...Object.keys(state.base), ...Object.keys(state.draft)] as (keyof T)[])
    return [...keys].filter(k => !same(state.base[k], state.draft[k]))
  }, [state.base, state.draft])
  const dirty = dirtyKeys.length > 0

  useEffect(() => {
    if (server === undefined || serverKey === state.seen) return
    setState(s => draftOnServer(s, latest.current as T, serverKey))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  useEffect(() => {
    if (dirty || !state.pending) return
    setState(s => draftOnClean(s, latest.current))
  }, [dirty, state.pending])

  const conflict = dirty && server !== undefined
    && Object.keys({ ...state.base, ...server }).some(k => !same(server[k], state.base[k]))

  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => {
    setState(s => ({ ...s, draft: { ...s.draft, [k]: v } }))
  }, [])
  const reset = useCallback(() => {
    const v = (latest.current ?? {}) as T
    setState({ base: v, draft: v, seen: latest.current === undefined ? "" : JSON.stringify(latest.current), pending: false })
  }, [])
  const commit = useCallback((saved?: Partial<T>) => {
    setState(s => {
      const v = { ...s.draft, ...(saved ?? {}) } as T
      return { base: v, draft: v, seen: s.seen, pending: false }   // the save supersedes what came in meanwhile
    })
  }, [])

  return { draft: state.draft, set, dirty, dirtyKeys, conflict, reset, commit }
}
