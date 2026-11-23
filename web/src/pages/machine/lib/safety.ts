// What the Machine page offers on a process or a unit: exactly portal.html's rules (SPEC §5.15, §13 q2).
// The daemon's killProblem / unitActionProblem still have the last word. Pure: no DOM.

import type { SystemProcess, SystemStats } from "../../../api/types.ts"
import type { SystemUnit, UnitAction } from "../types.ts"

/** No End or Kill on kernel threads, pid 1 or the daemon itself. Other processes in its unit keep them. */
export function processLocked(p: Pick<SystemProcess, "pid" | "kernel">, d: Pick<SystemStats, "self">): boolean {
  return p.kernel || p.pid === 1 || p.pid === d.self
}

const NEVER_STOP = /^(init\.scope|dbus(-broker)?\.service|systemd-[a-z-]+\.service)$/

/**
 * The unit buttons, in order:
 * - none at all on the daemon's own unit;
 * - Start when failed (candy units included), else Restart on units that are neither scopes nor candy's;
 * - Stop unless failed, init.scope, dbus(-broker).service or systemd-*.service (candy units keep Stop).
 */
export function unitActions(u: Pick<SystemUnit, "unit" | "failed">, d: Pick<SystemStats, "ownUnit" | "candy">): UnitAction[] {
  if (d.ownUnit && u.unit === d.ownUnit) return []
  const out: UnitAction[] = []
  const candyName = d.candy?.[u.unit]
  const scope = u.unit.endsWith(".scope")
  if (u.failed) out.push("start")
  else if (!scope && !candyName) out.push("restart")
  if (!u.failed && !NEVER_STOP.test(u.unit)) out.push("stop")
  return out
}

/** "nginx (pid 812, www-data)", the way toasts name a process. */
export function processWhat(p: Pick<SystemProcess, "name" | "pid" | "user"> | undefined, pid: number): string {
  return p ? `${p.name} (pid ${pid}, ${p.user})` : `pid ${pid}`
}

/** §5.12: Kill <name> (pid P, user)? / Ask <name> (pid P) to exit? */
export function killConfirm(p: Pick<SystemProcess, "name" | "pid" | "user">, signal: "TERM" | "KILL"):
  { title: string; body?: string; verb: string; danger: boolean } {
  return signal === "KILL"
    ? { title: `Kill ${p.name} (pid ${p.pid}, ${p.user})?`, body: "It gets no chance to save or clean up.", verb: "Kill", danger: true }
    : { title: `Ask ${p.name} (pid ${p.pid}) to exit?`, verb: "End", danger: false }
}

/** §5.12: Stop <unit>? Its N processes will be ended. / Start <unit>? / Restart <unit>? */
export function unitConfirm(unit: string, action: UnitAction, processes: number):
  { title: string; body?: string; verb: string; danger: boolean } {
  if (action === "stop") {
    return {
      title: `Stop ${unit}?`, verb: "Stop", danger: true,
      body: processes ? `Its ${processes} process${processes === 1 ? "" : "es"} will be ended.` : undefined,
    }
  }
  const verb = action === "start" ? "Start" : "Restart"
  return { title: `${verb} ${unit}?`, verb, danger: false }
}

/** The toast after a unit action: "<unit>: stopping|starting|restarting". */
export function unitDone(unit: string, action: UnitAction): string {
  return `${unit}: ${action === "stop" ? "stopping" : action === "start" ? "starting" : "restarting"}`
}
