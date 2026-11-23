import type React from "react"
import { useEffect, useRef, useState } from "react"
import { Button } from "./Button.tsx"
import { Icon } from "./icons.tsx"

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false
    await navigator.clipboard.writeText(text)
    return true
  } catch { return false }
}

/** Copies `text`. With `label` it is a small quiet button with text, otherwise an icon button. */
export function CopyButton(p: { text: string; label?: string }): React.JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle")
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (t.current) clearTimeout(t.current) }, [])
  const click = async () => {
    const ok = await copyText(p.text)
    setState(ok ? "done" : "failed")
    if (t.current) clearTimeout(t.current)
    t.current = setTimeout(() => setState("idle"), 1600)
  }
  const title = state === "done" ? "Copied" : state === "failed" ? "Couldn't copy. Select it and copy by hand." : "Copy"
  return (
    <Button variant="quiet" size="sm" onClick={click} title={title} aria-label={p.label ? undefined : title}
      icon={<Icon name={state === "done" ? "check" : "copy"} size={14} />}>
      {p.label ? (state === "done" ? "Copied" : p.label) : undefined}
    </Button>
  )
}
