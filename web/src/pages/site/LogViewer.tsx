// The live log and terminal of one site (SPEC §5.7). Owned by package C.
//
// The stream is GET /stream/<name> (SSE over fetch): the default event is a JSON string chunk of the log,
// `event: status` carries {status, port, detectedPorts}. The server replays the whole file on every connect,
// so a reconnect replaces the buffer. Input goes to POST /process/input/<name> on the term lane, in order.

import type React from "react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import { useStream } from "../../api/stream.ts"
import type { LogTextResponse, ProcessStatus } from "../../api/types.ts"
import { parseAnsi } from "../../lib/ansi.ts"
import { plural } from "../../lib/format.ts"
import { Banner, Button, ErrorState, errorMessage, Icon, Input, type LampState, StatusDot, Switch } from "../../ui/index.ts"
import {
  createKeySender, findLines, type KeySender, keyToInput, LogBuffer, parseSearch, type SearchLine, splitHits, stripAnsi,
  type TermInput,
} from "./lib/logbuffer.ts"
import "./logs.css"

const ROW = 19          // px, one log line (matches --t-mono-small at 19px line height)
const OVERSCAN = 30
const MIN_PANE = 420

export function lampOf(status: ProcessStatus | string | undefined): { state: LampState; label: string } {
  switch (status) {
    case "running": return { state: "running", label: "Running" }
    case "starting": return { state: "starting", label: "Starting" }
    case "errored": return { state: "crashed", label: "Crashed" }
    case "dead": return { state: "stopped", label: "Stopped" }
    default: return { state: "idle", label: "No process" }
  }
}

/** One log line: ANSI colours as class names, find hits as <mark>. Text only. */
function LogLine(p: { text: string; q: string; current: boolean }): React.JSX.Element {
  const segs = parseAnsi(p.text)
  return (
    <div className={p.current ? "log-line is-current" : "log-line"}>
      {segs.map((s, i) => {
        const text = stripAnsi(s.text)
        const parts = p.q ? splitHits(text, p.q) : [{ text, hit: false }]
        const inner = parts.map((h, j) => (h.hit ? <mark key={j} className="log-hit">{h.text}</mark> : h.text))
        return s.cls ? <span key={i} className={s.cls}>{inner}</span> : <span key={i}>{inner}</span>
      })}
      {"\n"}
    </div>
  )
}

const KEY_BUTTONS: { label: string; aria: string; body: TermInput }[] = [
  { label: "Ctrl-C", aria: "Send Ctrl-C", body: { key: "ctrl+c" } },
  { label: "Ctrl-D", aria: "Send Ctrl-D", body: { key: "ctrl+d" } },
  { label: "Tab", aria: "Send Tab", body: { key: "tab" } },
  { label: "↑", aria: "Send the up arrow", body: { key: "up" } },
  { label: "↓", aria: "Send the down arrow", body: { key: "down" } },
]

type Search =
  | { state: "loading"; q: string }
  | { state: "done"; q: string; groups: SearchLine[][] }
  | { state: "error"; q: string; error: string }

export function LogViewer(p: { name: string; status?: ProcessStatus; canType: boolean }): React.JSX.Element {
  const { name } = p
  const buf = useRef<LogBuffer>(null as unknown as LogBuffer)
  if (!buf.current) buf.current = new LogBuffer()
  const [tick, setTick] = useState(0)
  const raf = useRef<number | null>(null)
  const bump = useCallback(() => {
    if (raf.current !== null) return
    raf.current = requestAnimationFrame(() => { raf.current = null; setTick(buf.current.version) })
  }, [])
  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current) }, [])

  const [status, setStatus] = useState<string | undefined>(p.status)
  useEffect(() => { setStatus(p.status) }, [p.status])
  const canType = status === undefined ? p.canType : status === "running" || status === "starting"
  const lastStatus = useRef<string>("")
  const opens = useRef(0)
  const [reconnected, setReconnected] = useState(false)

  const stream = useStream("/stream/" + encodeURIComponent(name), undefined, {
    retryMs: 2000,
    pauseHiddenMs: 60_000,
    onOpen: () => {
      opens.current++
      buf.current.clear()
      if (opens.current > 1) setReconnected(true)
      bump()
    },
    onEvent: e => {
      if (e.event === "status") {
        let s: { status?: string; port?: number | null } = {}
        try { s = JSON.parse(e.data) } catch { return }
        const sig = `${s.status}|${s.port ?? ""}`
        if (sig !== lastStatus.current) {
          const first = lastStatus.current === ""
          lastStatus.current = sig
          setStatus(s.status)
          // the page header reads useSite: refetch when the state really changed, not on every 500 ms tick
          if (!first || s.status !== p.status) invalidate(KEYS.sites)
        }
        return
      }
      if (e.event !== "message") return
      let chunk: unknown
      try { chunk = JSON.parse(e.data) } catch { return }
      if (typeof chunk === "string" && chunk) { buf.current.append(chunk); bump() }
    },
  })

  // ---- pane geometry, follow ----
  const pane = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, h: MIN_PANE })
  const [paneH, setPaneH] = useState(MIN_PANE)
  const [follow, setFollow] = useState(true)

  useLayoutEffect(() => {
    const fit = () => {
      const el = pane.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      const below = (el.parentElement?.nextElementSibling as HTMLElement | null)?.offsetHeight ?? 0
      setPaneH(Math.max(MIN_PANE, Math.floor(window.innerHeight - top - below - 40)))
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])

  const total = buf.current.length
  useLayoutEffect(() => {
    const el = pane.current
    if (!el) return
    if (follow) el.scrollTop = el.scrollHeight
    setView({ top: el.scrollTop, h: el.clientHeight })
  }, [tick, follow, paneH])

  const onScroll = () => {
    const el = pane.current
    if (!el) return
    setView({ top: el.scrollTop, h: el.clientHeight })
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW
    if (atBottom !== follow) setFollow(atBottom)
  }

  // ---- find ----
  const [q, setQ] = useState("")
  const [hit, setHit] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const matches = useMemo(() => findLines(buf.current.all(), q), [q, tick])
  const landed = useRef(false)
  useEffect(() => { setHit(0); landed.current = false }, [q])
  const goTo = (i: number) => {
    if (!matches.length) return
    const n = ((i % matches.length) + matches.length) % matches.length
    setHit(n)
    landed.current = true
    setFollow(false)
    const el = pane.current
    if (el) el.scrollTop = Math.max(0, matches[n] * ROW - el.clientHeight / 2)
  }
  const currentLine = q && matches.length ? matches[Math.min(hit, matches.length - 1)] : -1

  const [search, setSearch] = useState<Search | null>(null)
  const searchFile = async () => {
    const pattern = q.trim()
    if (!pattern) return
    setSearch({ state: "loading", q: pattern })
    try {
      const r = await getApi().get<LogTextResponse>("/logs/" + encodeURIComponent(name), { mode: "search", pattern, context: 2 })
      setSearch({ state: "done", q: pattern, groups: parseSearch(r.logs ?? "") })
    } catch (e) {
      setSearch({ state: "error", q: pattern, error: errorMessage(e) })
    }
  }

  // ---- input ----
  const [line, setLine] = useState("")
  const [sendError, setSendError] = useState<string | null>(null)
  const sender = useRef<KeySender | null>(null)
  useEffect(() => {
    sender.current = createKeySender(body => {
      getApi().post("/process/input/" + encodeURIComponent(name), body, { lane: "term" })
        .then(() => setSendError(null))
        .catch(e => setSendError(errorMessage(e)))
    })
    return () => { sender.current?.dispose(); sender.current = null }
  }, [name])
  const send = (body: TermInput) => sender.current?.send(body)

  const [raw, setRaw] = useState(false)
  const [rawFocus, setRawFocus] = useState(false)
  const toggleRaw = (on: boolean) => {
    setRaw(on)
    if (on) requestAnimationFrame(() => pane.current?.focus())
  }
  const onPaneKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!raw || !canType) return
    const r = keyToInput(e)
    if (r === null) return
    e.preventDefault()
    e.stopPropagation()
    if (r === "release") { sender.current?.flush(); pane.current?.blur(); return }
    if ("input" in r && r.input !== "\n") sender.current?.char(r.input)
    else sender.current?.send(r)
  }
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!raw || !canType) return
    const text = e.clipboardData.getData("text")
    e.preventDefault()
    if (text) send({ input: text })
  }

  const download = () => {
    const blob = new Blob([buf.current.text()], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${name}.log`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const lamp = lampOf(status)
  const start = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN)
  const end = Math.min(total, Math.ceil((view.top + view.h) / ROW) + OVERSCAN)
  const shown: React.ReactNode[] = []
  for (let i = start; i < end; i++) shown.push(<LogLine key={i} text={buf.current.line(i)} q={q} current={i === currentLine} />)

  return (
    <div className="logs">
      <div className="logs-toolbar" role="toolbar" aria-label={`Log of ${name}`}>
        <span className="logs-status">
          <StatusDot state={lamp.state} label={lamp.label} showLabel />
          {stream !== "live" ? <span className="logs-conn">{stream === "paused" ? "Reconnecting…" : "Connecting…"}</span> : null}
        </span>
        <label className="logs-follow">
          <Switch checked={follow} onChange={setFollow} label="Follow" />
          <span aria-hidden="true">Follow</span>
        </label>
        <form className="logs-find" role="search" onSubmit={e => { e.preventDefault() }}>
          <Input type="search" value={q} placeholder="Find in log…" aria-label="Find in log" spellCheck={false} autoComplete="off"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); goTo(!landed.current ? hit : hit + (e.shiftKey ? -1 : 1)) }
              if (e.key === "Escape" && q) { e.preventDefault(); setQ("") }
            }} />
          {q ? <span className="logs-count" aria-live="polite">{matches.length ? `${Math.min(hit, matches.length - 1) + 1} of ${matches.length}` : "No matches"}</span> : null}
          {q.trim() ? <Button size="sm" variant="quiet" onClick={() => void searchFile()} busy={search?.state === "loading"}>Search the whole file</Button> : null}
        </form>
        <div className="logs-actions">
          <Button size="sm" variant="quiet" onClick={() => { buf.current.clear(); setSearch(null); bump() }}>Clear view</Button>
          <Button size="sm" variant="quiet" onClick={download} disabled={!total}>Download</Button>
        </div>
      </div>

      {reconnected ? (
        <Banner kind="info" onDismiss={() => setReconnected(false)}>Reconnected. Showing the log from the start.</Banner>
      ) : null}

      {search ? (
        <div className="logs-search" aria-live="polite">
          <div className="logs-search-head">
            <span>
              {search.state === "loading" ? <>Searching the whole file for <code>{search.q}</code>…</>
                : search.state === "error" ? <>Search for <code>{search.q}</code></>
                : search.groups.length ? <>{plural(search.groups.reduce((n, g) => n + g.filter(l => l.hit).length, 0), "matching line")} in the whole file for <code>{search.q}</code></>
                : <>No lines in the whole file match <code>{search.q}</code>.</>}
            </span>
            <Button size="sm" variant="quiet" icon={<Icon name="x" size={14} />} aria-label="Close the search results" onClick={() => setSearch(null)} />
          </div>
          {search.state === "error" ? <ErrorState error={`Couldn’t search the log: ${search.error}`} onRetry={() => void searchFile()} /> : null}
          {search.state === "done" && search.groups.length ? (
            <div className="logs-search-body">
              {search.groups.slice(0, 200).map((g, gi) => (
                <div className="logs-search-group" key={gi}>
                  {g.map(l => (
                    <div key={l.line} className={l.hit ? "logs-search-line is-hit" : "logs-search-line"}>
                      <span className="logs-search-no">{l.line}</span>
                      <span className="logs-search-text">
                        {l.hit ? splitHits(l.text, search.q).map((h, j) => (h.hit ? <mark key={j} className="log-hit">{h.text}</mark> : h.text)) : l.text}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              {search.groups.length > 200 ? <div className="logs-search-more">Showing the first 200 places. Narrow the search to see the rest.</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="logs-pane-wrap">
        <div ref={pane} className={["logs-pane", raw ? "is-raw" : "", raw && rawFocus ? "is-typing" : ""].filter(Boolean).join(" ")}
          style={{ height: paneH }} onScroll={onScroll}
          tabIndex={raw ? 0 : -1} role="log" aria-label={`Log of ${name}`} aria-live="off"
          data-shortcuts={raw ? "off" : undefined}
          onKeyDown={onPaneKey} onPaste={onPaste} onFocus={() => setRawFocus(true)} onBlur={() => setRawFocus(false)}>
          <div className="logs-sizer" style={{ height: total * ROW }}>
            <div className="logs-lines ui-ansi" style={{ transform: `translateY(${start * ROW}px)` }}>{shown}</div>
          </div>
          {total === 0 ? <div className="logs-empty">{stream === "live" ? "Nothing logged yet." : "Connecting to the log…"}</div> : null}
        </div>
        {!follow && total > 0 ? (
          <Button size="sm" className="logs-jump" onClick={() => setFollow(true)} icon={<Icon name="chevron-down" size={14} />}>Jump to latest</Button>
        ) : null}
        <div className="logs-foot">
          <span>{plural(total, "line")}</span>
          {buf.current.dropped ? <span>Older lines were dropped from this view.</span> : null}
          {raw ? <span className="logs-raw-hint">{rawFocus ? "Keys go to the process. Press Esc to stop." : "Click the log to send keys to the process."}</span> : null}
        </div>
      </div>

      <div className="logs-input">
        <form className="logs-line" onSubmit={e => { e.preventDefault(); if (!canType) return; send({ input: line + "\n" }); setLine("") }}>
          <Input mono prefix="›" value={line} onChange={e => setLine(e.target.value)} placeholder="Send a line to the process"
            aria-label="Send a line to the process" disabled={!canType} spellCheck={false} autoComplete="off" />
          <Button type="submit" disabled={!canType}>Send</Button>
        </form>
        <div className="logs-keys">
          {KEY_BUTTONS.map(k => (
            <Button key={k.label} size="sm" variant="quiet" className="logs-key" aria-label={k.aria} title={k.aria} disabled={!canType}
              onClick={() => send(k.body)}>{k.label}</Button>
          ))}
          <label className="logs-raw">
            <Switch checked={raw} onChange={toggleRaw} label="Raw keys" disabled={!canType} />
            <span aria-hidden="true">Raw keys</span>
          </label>
        </div>
        {sendError ? <div className="logs-send-error" role="alert"><Icon name="error" size={14} />Couldn’t send: {sendError}</div> : null}
        {!canType ? <div className="logs-send-note">The process isn’t running, so there is nothing to type into.</div> : null}
      </div>
    </div>
  )
}
