// A handful of 16px line icons, drawn in currentColor. Decorative: always aria-hidden.

import type React from "react"

export type IconName =
  | "arrow-out" | "arrow-left" | "chevron-down" | "chevron-right" | "check" | "x" | "copy" | "plus"
  | "info" | "warn" | "error" | "search" | "sun" | "moon" | "monitor" | "logout" | "user" | "key" | "settings"

const PATHS: Record<IconName, React.ReactNode> = {
  "arrow-out": <><path d="M6 3.5h6.5V10" /><path d="M12.5 3.5 4 12" /></>,
  "arrow-left": <><path d="M12.5 8h-9" /><path d="M7 4.5 3.5 8 7 11.5" /></>,
  "chevron-down": <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />,
  "chevron-right": <path d="m6.25 4.5 3.5 3.5-3.5 3.5" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <><path d="m4.5 4.5 7 7" /><path d="m11.5 4.5-7 7" /></>,
  copy: <><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" /><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" /></>,
  plus: <><path d="M8 3.5v9" /><path d="M3.5 8h9" /></>,
  info: <><circle cx="8" cy="8" r="5.75" /><path d="M8 7.25v3.5" /><path d="M8 5.1v.05" /></>,
  warn: <><path d="M8 2.75 14 13H2Z" /><path d="M8 6.75v2.75" /><path d="M8 11.15v.05" /></>,
  error: <><circle cx="8" cy="8" r="5.75" /><path d="m6 6 4 4" /><path d="m10 6-4 4" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></>,
  sun: <><circle cx="8" cy="8" r="2.75" /><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" /></>,
  moon: <path d="M13 9.5A5.25 5.25 0 1 1 6.5 3a4.25 4.25 0 0 0 6.5 6.5Z" />,
  monitor: <><rect x="2" y="3" width="12" height="8" rx="1.25" /><path d="M6 13.5h4" /></>,
  logout: <><path d="M9.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h5.5" /><path d="M7 8h6.5" /><path d="m11 5.5 2.5 2.5-2.5 2.5" /></>,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.6-2.4 2.6-3.75 5-3.75s4.4 1.35 5 3.75" /></>,
  key: <><circle cx="5.5" cy="10.5" r="2.75" /><path d="m7.5 8.5 5.5-5.5" /><path d="m11 5 1.75 1.75" /></>,
  settings: <><circle cx="8" cy="8" r="2" /><path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" /></>,
}

export function Icon(p: { name: IconName; size?: number; className?: string }): React.JSX.Element {
  const size = p.size ?? 16
  return (
    <svg className={p.className ? `ui-icon ${p.className}` : "ui-icon"} width={size} height={size} viewBox="0 0 16 16"
      fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[p.name]}
    </svg>
  )
}

/** The busy spinner used by Button and Switch. */
export function Spinner(p: { size?: number }): React.JSX.Element {
  const size = p.size ?? 14
  return (
    <svg className="ui-spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
