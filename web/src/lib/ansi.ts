// ANSI SGR -> text segments with class names from a fixed table (SPEC §8 A). Never markup, never inline style:
// ui/AnsiText renders each segment as a <span className={cls}> with React text.

export interface AnsiSegment { text: string; cls: string }

const FG = ["fg-black", "fg-red", "fg-green", "fg-yellow", "fg-blue", "fg-magenta", "fg-cyan", "fg-white"] as const

// xterm's base colours, for mapping 256-colour and truecolor to the nearest of the eight
const BASE_RGB: [number, number, number][] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
]

function nearest(r: number, g: number, b: number): string {
  // greys go to black (shown as a dim grey) or white, never to a hue
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return (r + g + b) / 3 >= 160 ? FG[7] : FG[0]
  let best = 0, bestD = Infinity
  BASE_RGB.forEach(([R, G, B], i) => {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2
    if (d < bestD) { bestD = d; best = i }
  })
  return FG[best]
}

function color256(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null
  if (n < 16) return FG[n % 8]
  if (n < 232) {
    const c = n - 16
    const lv = (x: number) => (x === 0 ? 0 : 55 + x * 40)
    return nearest(lv(Math.floor(c / 36)), lv(Math.floor(c / 6) % 6), lv(c % 6))
  }
  const g = 8 + (n - 232) * 10
  return nearest(g, g, g)
}

interface State { fg: string | null; b: boolean; dim: boolean }

const clsOf = (s: State) => [s.fg, s.b ? "b" : null, s.dim ? "dim" : null].filter(Boolean).join(" ")

function applySgr(params: string, s: State): void {
  const codes = params === "" ? [0] : params.split(/[;:]/).map(p => (p === "" ? 0 : Number(p)))
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) { s.fg = null; s.b = false; s.dim = false }
    else if (c === 1) s.b = true
    else if (c === 2) s.dim = true
    else if (c === 22) { s.b = false; s.dim = false }
    else if (c === 39) s.fg = null
    else if (c >= 30 && c <= 37) s.fg = FG[c - 30]
    else if (c >= 90 && c <= 97) s.fg = FG[c - 90]
    else if (c === 38 || c === 48) {
      const mode = codes[i + 1]
      let fg: string | null = null
      if (mode === 5) { fg = color256(codes[i + 2]); i += 2 }
      else if (mode === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]]
        if ([r, g, b].every(x => Number.isFinite(x))) fg = nearest(r, g, b)
        i += 4
      } else i += 1
      if (c === 38 && fg) s.fg = fg
    }
    // everything else (backgrounds, italic, underline, blink, reverse, ...) is dropped
  }
}

/** Split text into segments. SGR sets classes; other escape sequences (CSI, OSC, two-byte ESC) are removed. */
export function parseAnsi(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = []
  const s: State = { fg: null, b: false, dim: false }
  let buf = ""
  const flush = () => {
    if (!buf) return
    const cls = clsOf(s)
    const last = out[out.length - 1]
    if (last && last.cls === cls) last.text += buf
    else out.push({ text: buf, cls })
    buf = ""
  }
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== "\x1b" && ch !== "\x9b") { buf += ch; i++; continue }
    const csi = ch === "\x9b" ? i + 1 : text[i + 1] === "[" ? i + 2 : -1
    if (csi >= 0) {
      // CSI: parameter bytes 0x30-0x3F, intermediates 0x20-0x2F, final 0x40-0x7E
      let j = csi
      while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x3f) j++
      while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++
      if (j >= text.length) { i = text.length; break }
      const final = text[j]
      if (final === "m") {
        flush()
        applySgr(text.slice(csi, j), s)
      }
      i = j + 1
      continue
    }
    if (text[i + 1] === "]") {
      // OSC: ends at BEL or ST (ESC \)
      let j = i + 2
      while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++
      i = j >= text.length ? text.length : text[j] === "\x07" ? j + 1 : j + 2
      continue
    }
    // other ESC sequences: ESC + one byte (and charset selections ESC ( B)
    i += text[i + 1] === "(" || text[i + 1] === ")" ? 3 : 2
  }
  flush()
  return out
}
