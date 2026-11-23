// Package C: the log buffer, find, rg search output and the raw-keys sender (SPEC §5.7, §8 C).

import { describe, expect, test } from "bun:test"
import {
  createKeySender, findLines, keyToInput, LogBuffer, MAX_CHARS, MAX_LINES, parseSearch, splitHits, stripAnsi, type TermInput,
} from "../lib/logbuffer.ts"

describe("LogBuffer line endings", () => {
  test("\\n and \\r\\n end lines; the open line shows once it has text", () => {
    const b = new LogBuffer()
    b.append("one\ntwo\r\nthr")
    expect(b.all()).toEqual(["one", "two", "thr"])
    b.append("ee\n")
    expect(b.all()).toEqual(["one", "two", "three"])
    expect(b.length).toBe(3)
  })

  test("a bare \\r overwrites the line with the next text", () => {
    const b = new LogBuffer()
    b.append("progress 10%\rprogress 50%\rprogress 100%\ndone\n")
    expect(b.all()).toEqual(["progress 100%", "done"])
  })

  test("\\r and \\n split across chunks is still one newline", () => {
    const b = new LogBuffer()
    b.append("line one\r")
    b.append("\nline two\n")
    expect(b.all()).toEqual(["line one", "line two"])
  })

  test("\\r\\r\\n (a PTY's \\r\\n) keeps the line", () => {
    const b = new LogBuffer()
    b.append("hello\r\r\nworld\r\r\n")
    expect(b.all()).toEqual(["hello", "world"])
  })

  test("a \\r at the end of a chunk replaces the line only when text follows", () => {
    const b = new LogBuffer()
    b.append("50%\r")
    expect(b.all()).toEqual(["50%"])
    b.append("75%")
    expect(b.all()).toEqual(["75%"])
  })

  test("clear empties the view and bumps the version", () => {
    const b = new LogBuffer()
    b.append("x\ny\n")
    const v = b.version
    b.clear()
    expect(b.length).toBe(0)
    expect(b.version).toBeGreaterThan(v)
    expect(b.text()).toBe("")
  })

  test("text() is the buffer for Download", () => {
    const b = new LogBuffer()
    b.append("a\nb")
    expect(b.text()).toBe("a\nb\n")
  })
})

describe("LogBuffer cap", () => {
  test(`keeps the last ${MAX_LINES} lines and says older lines were dropped`, () => {
    const b = new LogBuffer()
    let chunk = ""
    for (let i = 0; i < MAX_LINES + 250; i++) chunk += `line ${i}\n`
    b.append(chunk)
    expect(b.length).toBe(MAX_LINES)
    expect(b.line(0)).toBe("line 250")
    expect(b.line(MAX_LINES - 1)).toBe(`line ${MAX_LINES + 249}`)
    expect(b.dropped).toBe(true)
  })

  test("keeps the line cap across many small appends", () => {
    const b = new LogBuffer()
    for (let i = 0; i < MAX_LINES + 10; i++) b.append(`l${i}\n`)
    expect(b.length).toBe(MAX_LINES)
    expect(b.line(0)).toBe("l10")
  })

  test("keeps at most 2 MB", () => {
    const b = new LogBuffer()
    const line = "x".repeat(1023) + "\n"   // 1 KB a line
    for (let i = 0; i < 3000; i++) b.append(line)
    expect(b.size).toBeLessThanOrEqual(MAX_CHARS)
    expect(b.length).toBeLessThan(3000)
    expect(b.dropped).toBe(true)
  })

  test("one huge line with no newline keeps its end", () => {
    const b = new LogBuffer()
    b.append("a".repeat(MAX_CHARS) + "TAIL")
    expect(b.size).toBe(MAX_CHARS)
    expect(b.line(0).endsWith("TAIL")).toBe(true)
  })

  test("under the cap nothing is dropped", () => {
    const b = new LogBuffer()
    b.append("a\nb\n")
    expect(b.dropped).toBe(false)
  })
})

describe("find", () => {
  test("stripAnsi removes SGR, OSC, other CSI and control characters", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x1b[2K\x07")).toBe("red ok")
  })
  test("findLines matches text, not escape codes, case-insensitively", () => {
    const lines = ["\x1b[32mGET /api\x1b[0m 200", "error: boom", "ERROR again", "\x1b[31m"]
    expect(findLines(lines, "error")).toEqual([1, 2])
    expect(findLines(lines, "31m")).toEqual([])
    expect(findLines(lines, "")).toEqual([])
  })
  test("splitHits marks every occurrence", () => {
    expect(splitHits("a-b-A", "a")).toEqual([{ text: "a", hit: true }, { text: "-b-", hit: false }, { text: "A", hit: true }])
    expect(splitHits("none", "x")).toEqual([{ text: "none", hit: false }])
  })
})

describe("parseSearch (rg -n -C 2)", () => {
  test("groups, match and context lines", () => {
    const out = "3-before\n4:the error\n5-after\n--\n20:\x1b[31merror\x1b[0m two\n"
    const g = parseSearch(out)
    expect(g.length).toBe(2)
    expect(g[0]).toEqual([
      { line: 3, text: "before", hit: false }, { line: 4, text: "the error", hit: true }, { line: 5, text: "after", hit: false },
    ])
    expect(g[1][0]).toEqual({ line: 20, text: "error two", hit: true })
  })
  test("(no matches) is an empty list", () => {
    expect(parseSearch("(no matches)")).toEqual([])
    expect(parseSearch("")).toEqual([])
  })
})

describe("keyToInput (01 §11 mapping)", () => {
  const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    keyToInput({ key, ctrlKey: false, metaKey: false, altKey: false, ...o })
  test("ctrl keys", () => {
    expect(k("c", { ctrlKey: true })).toEqual({ key: "ctrl+c" })
    expect(k("D", { ctrlKey: true })).toEqual({ key: "ctrl+d" })
    expect(k("z", { ctrlKey: true })).toEqual({ key: "ctrl+z" })
    expect(k("l", { ctrlKey: true })).toEqual({ key: "ctrl+l" })
    expect(k("v", { ctrlKey: true })).toBe(null)   // paste goes through the paste event
  })
  test("special keys and printable characters", () => {
    expect(k("Enter")).toEqual({ input: "\n" })
    expect(k("Tab")).toEqual({ key: "tab" })
    expect(k("Backspace")).toEqual({ key: "backspace" })
    expect(k("ArrowUp")).toEqual({ key: "up" })
    expect(k("ArrowDown")).toEqual({ key: "down" })
    expect(k("ArrowLeft")).toEqual({ key: "left" })
    expect(k("ArrowRight")).toEqual({ key: "right" })
    expect(k("q")).toEqual({ input: "q" })
    expect(k(" ")).toEqual({ input: " " })
    expect(k("Escape")).toBe("release")
    expect(k("Shift")).toBe(null)
    expect(k("F5")).toBe(null)
    expect(k("r", { metaKey: true })).toBe(null)
  })
})

describe("createKeySender", () => {
  function harness() {
    const sent: TermInput[] = []
    let pending: (() => void) | null = null
    const s = createKeySender(b => sent.push(b), {
      windowMs: 30,
      setTimer: fn => { pending = fn; return 1 },
      clearTimer: () => { pending = null },
    })
    return { sent, s, fire: () => { const f = pending; pending = null; f?.() } }
  }

  test("characters typed within the window go as one input", () => {
    const { sent, s, fire } = harness()
    s.char("l"); s.char("s")
    expect(sent).toEqual([])
    fire()
    expect(sent).toEqual([{ input: "ls" }])
  })

  test("a special key flushes the held characters first, so order is kept", () => {
    const { sent, s, fire } = harness()
    s.char("l"); s.char("s")
    s.send({ input: "\n" })
    s.char("q")
    s.send({ key: "ctrl+c" })
    fire()
    expect(sent).toEqual([{ input: "ls" }, { input: "\n" }, { input: "q" }, { key: "ctrl+c" }])
  })

  test("a paste between characters keeps its place", () => {
    const { sent, s, fire } = harness()
    s.char("a")
    s.send({ input: "PASTED" })
    s.char("b")
    fire()
    expect(sent).toEqual([{ input: "a" }, { input: "PASTED" }, { input: "b" }])
  })

  test("dispose sends what is held", () => {
    const { sent, s } = harness()
    s.char("x")
    s.dispose()
    expect(sent).toEqual([{ input: "x" }])
  })

  test("with real timers, a slow typist sends one key at a time", async () => {
    const sent: TermInput[] = []
    const s = createKeySender(b => sent.push(b), { windowMs: 5 })
    s.char("a")
    await new Promise(r => setTimeout(r, 25))
    s.char("b")
    await new Promise(r => setTimeout(r, 25))
    expect(sent).toEqual([{ input: "a" }, { input: "b" }])
  })
})
