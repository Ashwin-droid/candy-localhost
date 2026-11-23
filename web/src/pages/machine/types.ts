// Machine (SPEC §5.15). SystemStats and SystemProcess are shared (api/types.ts); these are the action answers.

import type { SystemStats } from "../../api/types.ts"

export type Signal = "TERM" | "KILL"
export type UnitAction = "start" | "stop" | "restart"
export type SystemUnit = SystemStats["units"][number]

/** POST /system/kill {pid, start, signal} */
export interface KillResponse { success: true; pid: number; signal: string; name: string }
/** POST /system/unit {unit, action} */
export interface UnitResponse { success: true; unit: string; action: string }

export type MachineTab = "processes" | "services"
export type SortDir = 1 | -1
