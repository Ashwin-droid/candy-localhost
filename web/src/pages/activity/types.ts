// Activity (SPEC §5.11). The response type is shared (api/types.ts ActivityResponse); these are the page's own shapes.

import type { ActivityResponse } from "../../api/types.ts"

/** One /logs entry as the daemon sends it: time (ISO), action ("ADD", "PORTAL"…), details (free text). */
export type ActivityEntry = ActivityResponse["logs"][number]

/** A row of the activity table: a date heading ("Today", "21 Nov") or an entry under it. */
export type ActivityItem =
  | { kind: "day"; key: string; label: string; title: string }
  | { kind: "entry"; key: string; at: number; time: string; action: string; details: string }

/** A piece of the details text; `site` is set when the piece names one of the viewer's sites. */
export interface DetailPart { text: string; site?: string }

/** How many entries the page asks for (the count Select). */
export const COUNTS = [40, 200, 1000] as const
export type Count = (typeof COUNTS)[number]
