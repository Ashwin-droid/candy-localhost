// A small keyed cache with polling (SPEC §7.4). One module-level Map, read through useSyncExternalStore.
// Nothing starts during render: fetches, timers and listeners begin in effects, so renderToStaticMarkup
// never fetches and render tests see primed data.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ApiError } from "./client.ts"

export interface ResourceOptions {
  every?: number          // poll interval in ms; absent = fetch on mount and on invalidate only
  whenVisible?: boolean   // default true: no polling while document.hidden
  skipInFlight?: boolean  // default true: a tick is skipped while the previous fetch is still running
  onFocus?: boolean       // default false: also refetch on window focus (the `me` key)
}
/**
 * `loading` is true while there is nothing to show yet: no data and either a first fetch in flight or none
 * finished. A refetch with data on screen keeps `loading` false (stale-while-revalidate).
 */
export interface Resource<T> { data?: T; error?: ApiError; loading: boolean; updatedAt?: number; reload(): Promise<void> }

interface Snap { data?: unknown; error?: ApiError; loading: boolean; updatedAt?: number }
interface Sub { fetcher: (signal: AbortSignal) => Promise<unknown>; o: ResourceOptions }
interface Entry {
  key: string
  snap: Snap
  subs: Set<Sub>
  listeners: Set<() => void>
  inflight: Promise<void> | null
  controller: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
  failures: number
  stale: boolean
  lastFetcher: ((signal: AbortSignal) => Promise<unknown>) | null
  gc: ReturnType<typeof setTimeout> | null   // set while nothing uses the entry; deletes it when it fires
}

const cache = new Map<string, Entry>()
const EMPTY: Snap = { loading: false }
const LOADING: Snap = { loading: true }
const MAX_BACKOFF = 30_000
/** How long an entry nobody uses stays cached (so going back to a page renders at once) before it is dropped. */
export const GC_DELAY = 5 * 60_000
let gcDelay = GC_DELAY

function entry(key: string): Entry {
  let e = cache.get(key)
  if (!e) {
    e = { key, snap: { loading: true }, subs: new Set(), listeners: new Set(), inflight: null, controller: null, timer: null, failures: 0, stale: true, lastFetcher: null, gc: null }
    cache.set(key, e)
  }
  if (e.gc) { clearTimeout(e.gc); e.gc = null }
  return e
}

/** Nothing subscribes or listens any more: drop the entry after gcDelay unless something comes back. */
function release(e: Entry): void {
  if (e.subs.size || e.listeners.size || e.gc) return
  e.gc = setTimeout(() => {
    e.gc = null
    if (e.subs.size || e.listeners.size || cache.get(e.key) !== e) return
    if (e.timer) { clearTimeout(e.timer); e.timer = null }
    e.controller?.abort()
    cache.delete(e.key)
  }, gcDelay)
}

function setSnap(e: Entry, next: Snap): void {
  e.snap = next
  for (const l of [...e.listeners]) l()
}

const hidden = () => typeof document !== "undefined" && document.hidden

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  return new ApiError(err instanceof Error ? err.message : String(err), 0)
}

function currentFetcher(e: Entry): ((signal: AbortSignal) => Promise<unknown>) | null {
  let f: Sub | undefined
  for (const s of e.subs) f = s           // the most recently subscribed component's fetcher
  return f?.fetcher ?? e.lastFetcher
}

function fetchNow(e: Entry): Promise<void> {
  if (e.inflight) return e.inflight
  const fetcher = currentFetcher(e)
  if (!fetcher) { e.stale = true; return Promise.resolve() }
  const controller = new AbortController()
  e.controller = controller
  if (e.snap.data === undefined && !e.snap.loading) setSnap(e, { ...e.snap, loading: true })
  const p = (async () => {
    try {
      const data = await fetcher(controller.signal)
      if (controller.signal.aborted) return
      e.failures = 0
      e.stale = false
      setSnap(e, { data, error: undefined, loading: false, updatedAt: Date.now() })
    } catch (err) {
      if (controller.signal.aborted) return
      e.failures++
      setSnap(e, { ...e.snap, error: toApiError(err), loading: false })
    } finally {
      if (e.controller === controller) e.controller = null
      e.inflight = null
      schedule(e)
    }
  })()
  e.inflight = p
  return p
}

function interval(e: Entry): number | null {
  let min: number | null = null
  for (const s of e.subs) if (s.o.every && (min === null || s.o.every < min)) min = s.o.every
  return min
}

function schedule(e: Entry): void {
  if (e.timer) { clearTimeout(e.timer); e.timer = null }
  const every = interval(e)
  if (!every || e.subs.size === 0) return
  const delay = e.failures ? Math.min(every * 2 ** e.failures, MAX_BACKOFF) : every
  e.timer = setTimeout(() => {
    e.timer = null
    const visibleOnly = [...e.subs].every(s => s.o.whenVisible !== false)
    if (visibleOnly && hidden()) return           // resumes on visibilitychange
    const skip = [...e.subs].every(s => s.o.skipInFlight !== false)
    if (e.inflight && skip) { schedule(e); return }
    void fetchNow(e)
  }, delay)
}

let globalListeners = false
function installGlobalListeners(): void {
  if (globalListeners || typeof window === "undefined") return
  globalListeners = true
  const all = () => { for (const e of cache.values()) if (e.subs.size) void fetchNow(e) }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return
    for (const e of cache.values()) if (e.subs.size && interval(e) !== null) void fetchNow(e)
  })
  window.addEventListener("online", all)
  window.addEventListener("focus", () => {
    for (const e of cache.values()) if ([...e.subs].some(s => s.o.onFocus)) void fetchNow(e)
  })
}

export function useResource<T>(key: string | null /* null = don't fetch */, fetcher: (signal: AbortSignal) => Promise<T>,
  o?: ResourceOptions): Resource<T> {
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const every = o?.every, whenVisible = o?.whenVisible, skipInFlight = o?.skipInFlight, onFocus = o?.onFocus

  const subscribe = useCallback((cb: () => void) => {
    if (key === null) return () => {}
    const e = entry(key)
    e.listeners.add(cb)
    return () => { e.listeners.delete(cb); release(e) }
  }, [key])
  const get = useCallback((): Snap => (key === null ? EMPTY : cache.get(key)?.snap ?? LOADING), [key])
  const snap = useSyncExternalStore(subscribe, get, get)

  useEffect(() => {
    if (key === null) return
    return subscribeResource(key, s => fetcherRef.current(s), { every, whenVisible, skipInFlight, onFocus })
  }, [key, every, whenVisible, skipInFlight, onFocus])

  const reload = useCallback(async () => {
    if (key === null) return
    await reloadResource(key, s => fetcherRef.current(s))
  }, [key])

  return { data: snap.data as T | undefined, error: snap.error, loading: snap.loading, updatedAt: snap.updatedAt, reload }
}

/**
 * What useResource's mount effect does; returns the cleanup. A key with `every` fetches on mount only when it
 * has nothing fresh (its poll keeps it current); a key without `every` loads on every mount (SPEC §7.4
 * "on mount + invalidate"), showing the cached value meanwhile.
 */
export function subscribeResource(key: string, fetcher: (signal: AbortSignal) => Promise<unknown>, o: ResourceOptions = {}): () => void {
  installGlobalListeners()
  const e = entry(key)
  const sub: Sub = { fetcher, o: { every: o.every, whenVisible: o.whenVisible, skipInFlight: o.skipInFlight, onFocus: o.onFocus } }
  e.subs.add(sub)
  e.lastFetcher = sub.fetcher
  if (e.stale || e.snap.data === undefined || !o.every) void fetchNow(e)
  else schedule(e)
  return () => {
    e.subs.delete(sub)
    if (e.subs.size === 0 && e.timer) { clearTimeout(e.timer); e.timer = null }
    else schedule(e)
    release(e)
  }
}

/**
 * Refetch a key and settle with data fetched after this call: a fetch already in flight may have started
 * before a mutation, so it is awaited and followed by a new one.
 */
export async function reloadResource(key: string, fetcher?: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const e = entry(key)
  if (!e.subs.size && fetcher) e.lastFetcher = fetcher
  if (e.inflight) await e.inflight
  await fetchNow(e)
  release(e)
}

/**
 * Read a key's cached value without fetching it (another component owns the fetch). Re-renders on change.
 * Used by useSites to merge `stats` and `domains` when they are present.
 */
export function usePeek<T>(key: string): T | undefined {
  const subscribe = useCallback((cb: () => void) => {
    const e = entry(key)
    e.listeners.add(cb)
    return () => { e.listeners.delete(cb); release(e) }
  }, [key])
  const get = useCallback(() => cache.get(key)?.snap.data, [key])
  return useSyncExternalStore(subscribe, get, get) as T | undefined
}

/** Exact keys by default; with prefix, every cached key that starts with one of them ("fn/" refetches all fn keys). */
export function invalidate(keys: string | string[], o?: { prefix?: boolean }): void {
  const list = Array.isArray(keys) ? keys : [keys]
  for (const e of cache.values()) {
    const hit = list.some(k => (o?.prefix ? e.key.startsWith(k) : e.key === k))
    if (!hit) continue
    e.stale = true
    if (e.subs.size) {
      if (e.inflight) {
        // a fetch that started before the change may carry old data: fetch again once it lands
        void e.inflight.then(() => { void fetchNow(e) })
      } else void fetchNow(e)
    }
  }
}

/** run rejects with the ApiError too, so a caller can await it; invalidate runs after success only. */
export function useMutation<A extends unknown[], R>(fn: (...a: A) => Promise<R>, o?: { invalidate?: string[] }):
  { run(...a: A): Promise<R>; busy: boolean; error?: ApiError; result?: R } {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const keysRef = useRef(o?.invalidate)
  keysRef.current = o?.invalidate
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [state, setState] = useState<{ busy: boolean; error?: ApiError; result?: R }>({ busy: false })
  const run = useCallback(async (...a: A): Promise<R> => {
    setState(s => ({ ...s, busy: true, error: undefined }))
    try {
      const result = await fnRef.current(...a)
      if (keysRef.current?.length) invalidate(keysRef.current)
      if (mounted.current) setState({ busy: false, result })
      return result
    } catch (err) {
      const error = toApiError(err)
      if (mounted.current) setState(s => ({ ...s, busy: false, error }))
      throw error
    }
  }, [])
  return { run, busy: state.busy, error: state.error, result: state.result }
}

/** Tests: seed the cache. */
export function primeResource<T>(key: string, data: T): void {
  const e = entry(key)
  e.stale = false
  e.failures = 0
  setSnap(e, { data, loading: false, updatedAt: Date.now() })
}

/** Tests: empty the cache. */
export function resetResources(): void {
  for (const e of cache.values()) {
    if (e.timer) clearTimeout(e.timer)
    if (e.gc) clearTimeout(e.gc)
    e.controller?.abort()
  }
  cache.clear()
  gcDelay = GC_DELAY
}

/** Tests: whether a key is cached. */
export function hasResource(key: string): boolean {
  return cache.has(key)
}

/** Tests: a short GC delay (resetResources restores GC_DELAY). */
export function setGcDelayForTest(ms: number): void {
  gcDelay = ms
}
