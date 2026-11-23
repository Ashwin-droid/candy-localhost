import type React from "react"
import "./Sparkline.css"

/** A tiny line chart (SVG polyline in --ink-2), with a faint area under it. */
export function Sparkline(p: { values: number[]; max?: number; width?: number; height?: number; label: string }): React.JSX.Element {
  const w = p.width ?? 120, h = p.height ?? 32
  const vals = p.values.filter(v => Number.isFinite(v))
  const max = p.max ?? Math.max(1, ...vals)
  const step = vals.length > 1 ? w / (vals.length - 1) : w
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (Math.min(v, max) / max) * (h - 2)).toFixed(1)}`)
  return (
    <svg className="ui-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={p.label} preserveAspectRatio="none">
      {pts.length > 1 ? <>
        <polygon className="ui-spark-area" points={`0,${h} ${pts.join(" ")} ${((vals.length - 1) * step).toFixed(1)},${h}`} />
        <polyline className="ui-spark-line" points={pts.join(" ")} />
      </> : <line className="ui-spark-base" x1="0" x2={w} y1={h - 1} y2={h - 1} />}
    </svg>
  )
}
