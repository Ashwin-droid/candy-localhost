// The Logs tab's model (SPEC §5.7). Pure: no DOM, no fetch.
//
// - LogBuffer: the text of /stream/<name> as lines, with carriage returns handled the way a terminal shows them
//   and a cap of 5,000 lines / 2 MB.
// - stripAnsi, findLines, splitHits: find in the buffer.
// - parseSearch: the rg output of GET /logs/<name>?mode=search.
// - keyToInput, createKeySender: the raw-keys terminal (01 §11 mapping, coalescing, one ordered queue).

export const MAX_LINES = 5000
export const MAX_CHARS = 2 * 1024 * 1024

/**
 * Lines of a terminal log. The last line is the open one, still being written.
 *
 * Line endings: "\n" and "\r\n" end a line. A bare "\r" moves back to the start of the line: the next text
 * replaces the line (a progress bar redraws in place). A "\r" followed by "\n" is a plain newline, also when
 * the two arrive in different chunks or as "\r\r\n" (what a PTY makes of "\r\n").
 */
export class LogBuffer {
  private lines: string[] = [""]
  private chars = 0
  private cr = false
  /** Older lines were dropped to stay under the cap. */
  dropped = false
  /** Bumped on every change, for React. */
  version = 0

  append(chunk: string): void {
    if (!chunk) return
    const re = /\r\n|\r|\n/g
    let last = 0
    for (let m = re.exec(chunk); m; m = re.exec(chunk)) {
      this.write(chunk.slice(last, m.index))
      if (m[0] === "\r") this.cr = true
      else this.newline()
      last = m.index + m[0].length
    }
    this.write(chunk.slice(last))
    this.trim()
    this.version++
  }

  clear(): void {
    this.lines = [""]
    this.chars = 0
    this.cr = false
    this.dropped = false
    this.version++
  }

  /** Lines to show: every finished line, plus the open one when it has text. */
  get length(): number {
    const n = this.lines.length
    return this.lines[n - 1] === "" ? n - 1 : n
  }

  line(i: number): string {
    return this.lines[i] ?? ""
  }

  /** The shown lines (a copy). */
  all(): string[] {
    return this.lines.slice(0, this.length)
  }

  /** The buffer as one text, for Download. */
  text(): string {
    return this.all().join("\n") + (this.length ? "\n" : "")
  }

  /** Characters held (the 2 MB cap counts these). */
  get size(): number {
    return this.chars
  }

  private write(text: string): void {
    if (!text) return
    const i = this.lines.length - 1
    if (this.cr) {
      this.cr = false
      this.chars -= this.lines[i].length
      this.lines[i] = ""
    }
    this.lines[i] += text
    this.chars += text.length
  }

  private newline(): void {
    this.cr = false
    this.lines.push("")
  }

  private trim(): void {
    // keep MAX_LINES shown lines (the open, empty line doesn't count)
    let drop = Math.max(0, this.length - MAX_LINES)
    let chars = this.chars
    for (let k = 0; k < drop; k++) chars -= this.lines[k].length
    while (chars > MAX_CHARS && drop < this.lines.length - 1) { chars -= this.lines[drop].length; drop++ }
    if (drop > 0) {
      this.lines.splice(0, drop)
      this.chars = chars
      this.dropped = true
    }
    // one enormous line with no newline: keep its end
    if (this.chars > MAX_CHARS) {
      const i = this.lines.length - 1
      const cut = this.chars - MAX_CHARS
      this.lines[i] = this.lines[i].slice(cut)
      this.chars -= cut
      this.dropped = true
    }
  }
}

// ESC [ … final, ESC ] … BEL / ST, ESC ( x, ESC x, and the one-byte CSI
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]/g
// other control characters that would only show as boxes (tab is kept)
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g

/** The text of a line without escape sequences and control characters. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(CTRL_RE, "")
}

/** Indexes of the lines whose text contains q (case-insensitive). */
export function findLines(lines: readonly string[], q: string): number[] {
  const needle = q.toLowerCase()
  if (!needle) return []
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) if (stripAnsi(lines[i]).toLowerCase().includes(needle)) out.push(i)
  return out
}

/** Split a plain text into runs that match q (case-insensitive) and runs that don't, for highlighting. */
export function splitHits(text: string, q: string): { text: string; hit: boolean }[] {
  if (!q) return [{ text, hit: false }]
  const hay = text.toLowerCase(), needle = q.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let from = 0
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false })
    out.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false })
  return out.length ? out : [{ text, hit: false }]
}

export interface SearchLine { line: number; text: string; hit: boolean }

/**
 * `rg -n -C 2` output: "12:text" for a match, "11-text" for context, "--" between groups. The daemon answers
 * "(no matches)" when nothing matched; that is an empty list here.
 */
export function parseSearch(out: string): SearchLine[][] {
  if (!out || out.trim() === "(no matches)") return []
  const groups: SearchLine[][] = []
  let cur: SearchLine[] = []
  for (const raw of out.split("\n")) {
    if (raw === "--") { if (cur.length) groups.push(cur); cur = []; continue }
    const m = /^(\d+)([:-])(.*)$/.exec(raw)
    if (!m) continue
    cur.push({ line: Number(m[1]), text: stripAnsi(m[3]), hit: m[2] === ":" })
  }
  if (cur.length) groups.push(cur)
  return groups
}

export type TermInput = { input: string } | { key: "ctrl+c" | "ctrl+d" | "ctrl+z" | "ctrl+l" | "tab" | "backspace" | "up" | "down" | "left" | "right" }

/**
 * A key press in raw-keys mode (01 §11): "release" for Esc (give focus back), null for keys left to the
 * browser (Cmd/Alt shortcuts, Ctrl+V so paste works, function keys).
 */
export function keyToInput(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): TermInput | "release" | null {
  if (e.key === "Escape") return "release"
  if (e.metaKey || e.altKey) return null
  if (e.ctrlKey) {
    const k = e.key.toLowerCase()
    if (k === "c" || k === "d" || k === "z" || k === "l") return { key: `ctrl+${k}` as "ctrl+c" }
    return null
  }
  switch (e.key) {
    case "Enter": return { input: "\n" }
    case "Tab": return { key: "tab" }
    case "Backspace": return { key: "backspace" }
    case "ArrowUp": return { key: "up" }
    case "ArrowDown": return { key: "down" }
    case "ArrowLeft": return { key: "left" }
    case "ArrowRight": return { key: "right" }
  }
  if (e.key.length === 1) return { input: e.key }
  // a character outside the BMP comes as two UTF-16 units
  if ([...e.key].length === 1 && e.key.length === 2) return { input: e.key }
  return null
}

export interface KeySender {
  /** A typed character: held for up to `windowMs` so a fast burst goes as one {input}. */
  char(ch: string): void
  /** Anything else (a special key, a pasted text, a line): sends what is held first, then this. */
  send(body: TermInput): void
  /** Send what is held now. */
  flush(): void
  dispose(): void
}

/**
 * Keeps keystrokes in order. Characters typed within `windowMs` of each other are coalesced into one
 * {input}; every other body flushes them first. `post` is called in order (on the term lane, which runs one
 * request at a time), so the process sees exactly what was typed.
 */
export function createKeySender(post: (body: TermInput) => void, o: {
  windowMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
} = {}): KeySender {
  const windowMs = o.windowMs ?? 30
  const setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = o.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  let held = ""
  let timer: unknown = null
  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null } }
  const flush = () => {
    stop()
    if (!held) return
    const input = held
    held = ""
    post({ input })
  }
  return {
    char(ch) {
      held += ch
      stop()
      timer = setTimer(flush, windowMs)
    },
    send(body) {
      flush()
      post(body)
    },
    flush,
    dispose() { flush() },
  }
}
