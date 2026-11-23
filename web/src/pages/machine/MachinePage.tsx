// Machine (SPEC §5.15, /machine and /machine/services): the whole computer, superuser only.
// Polls /system/stats every 2 s while visible; End / Kill processes and start / stop / restart units.

import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { getApi } from "../../api/client.ts"
import { useResource } from "../../api/resources.ts"
import type { SystemProcess, SystemStats } from "../../api/types.ts"
import { formatUptime, sysBytes } from "../../lib/format.ts"
import { isReservedName } from "../../lib/site.ts"
import { navigate, useQueryParam, useRoute } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import {
  Button, type Column, EmptyState, ErrorState, errorMessage, Input, Link, PageHeader, Segmented, Skeleton, Table, toast,
  useConfirm,
} from "../../ui/index.ts"
import { killConfirm, processLocked, processWhat, unitActions, unitConfirm, unitDone } from "./lib/safety.ts"
import {
  filterProcesses, filterUnits, parseSort, PROCESS_KEYS, type ProcessKey, processComparator, sortParam, UNIT_KEYS,
  type UnitKey, unitComparator, defaultDir,
} from "./lib/sort.ts"
import { Tiles } from "./tiles.tsx"
import type { KillResponse, MachineTab, Signal, SortDir, SystemUnit, UnitAction, UnitResponse } from "./types.ts"
import "./machine.css"

export const NOT_SUPERUSER = "Only a superuser can see this machine."
export const READ_FAILED = "Could not read the system"
export const LOST = "Lost contact with the daemon. Trying again…"
export const MAX_ROWS = 250
const SAMPLES = 60
const GIB = 1073741824

export default function MachinePage(): React.JSX.Element {
  const { superuser } = useSession()
  useEffect(() => { document.title = "Machine – candy" }, [])
  if (!superuser) {
    return (
      <>
        <PageHeader title="Machine" />
        <EmptyState>{NOT_SUPERUSER}</EmptyState>
      </>
    )
  }
  return <Machine />
}

/** Why the last poll failed, in the old page's words. */
export function pollProblem(err: { status: number; message: string } | undefined): string | null {
  if (!err) return null
  if (err.status === 0) return LOST
  return err.message && !/^Request failed \(/.test(err.message) ? err.message : READ_FAILED
}

const cpuClass = (v: number) => (v >= 80 ? "cherry" : v < 0.05 ? "ink-3" : undefined)
const memClass = (v: number) => (v >= 2 * GIB ? "cherry" : v === 0 ? "ink-3" : undefined)

function CandySite(p: { name: string }): React.JSX.Element {
  return isReservedName(p.name)
    ? <span className="m-tag">candy: {p.name}</span>
    : <Link to={`/sites/${encodeURIComponent(p.name)}`} className="m-tag m-tag-link">candy: {p.name}</Link>
}

function Machine(): React.JSX.Element {
  const route = useRoute()
  const tab: MachineTab = route.path.replace(/\/$/, "") === "/machine/services" ? "services" : "processes"
  const [qParam, setQParam] = useQueryParam("q")
  const [sortValue, setSortParam] = useQueryParam("sort")
  const [q, setQ] = useState(qParam ?? "")
  useEffect(() => { setQ(qParam ?? "") }, [qParam])
  const confirm = useConfirm()

  const res = useResource<SystemStats>("system", signal => getApi().get<SystemStats>("/system/stats", undefined, { signal }),
    { every: 2000, skipInFlight: true })
  const d = res.data

  // the last 60 samples for the sparklines (CPU %, memory % of total)
  const [hist, setHist] = useState<{ at: number; cpu: number[]; mem: number[] }>({ at: 0, cpu: [], mem: [] })
  useEffect(() => {
    if (!d || d.at === hist.at) return
    setHist(h => ({
      at: d.at,
      cpu: [...h.cpu, d.cpu.percent].slice(-SAMPLES),
      mem: [...h.mem, 100 * d.mem.used / (d.mem.total || 1)].slice(-SAMPLES),
    }))
  }, [d, hist.at])

  // don't redraw the table under a button that is being pressed (the old sys.held)
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!held) return
    const up = () => setHeld(false)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
    return () => { window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up) }
  }, [held])

  const [pKey, pDir] = parseSort<ProcessKey>(tab === "processes" ? sortValue : null, PROCESS_KEYS, ["cpu", -1])
  const [uKey, uDir] = parseSort<UnitKey>(tab === "services" ? sortValue : null, UNIT_KEYS, ["mem", -1])
  const onSort = (key: string, current: string, dir: SortDir) => {
    const next: SortDir = key === current ? (dir === 1 ? -1 : 1) : defaultDir(key)
    setSortParam(sortParam(key, next))
  }

  const procs = useMemo(() => (d ? filterProcesses(d.processes, q) : undefined), [d, q])
  const units = useMemo(() => (d ? filterUnits(d.units, q, d.candy) : undefined), [d, q])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const reloadSoon = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { void res.reload() }, 600) }

  const kill = async (p: SystemProcess, signal: Signal) => {
    if (!(await confirm(killConfirm(p, signal)))) return
    const what = processWhat(p, p.pid)
    try {
      await getApi().post<KillResponse>("/system/kill", { pid: p.pid, start: p.start, signal })
      toast(signal === "KILL" ? `Killed ${what}` : `Asked ${what} to exit`, "success")
      reloadSoon()
    } catch (e) {
      toast(errorMessage(e), "error")
    }
  }
  const unitAct = async (u: SystemUnit, action: UnitAction) => {
    if (!(await confirm(unitConfirm(u.unit, action, u.processes)))) return
    try {
      await getApi().post<UnitResponse>("/system/unit", { unit: u.unit, action })
      toast(unitDone(u.unit, action), "success")
      reloadSoon()
    } catch (e) {
      toast(errorMessage(e), "error")
    }
  }

  const problem = pollProblem(res.error)
  const meta: React.ReactNode[] = d ? [
    `Up ${formatUptime(d.uptime)}`,
    `${d.counts.processes.toLocaleString("en-US")} processes, ${d.counts.threads.toLocaleString("en-US")} threads`,
    d.root ? "acting as root" : "acting as the daemon's user",
  ] : []
  if (problem) meta.push(<span className="cherry" role="status">{problem}</span>)

  if (!d) {
    return (
      <>
        <PageHeader title="Machine" meta={meta} />
        {res.error ? <ErrorState error={problem ?? errorMessage(res.error)} onRetry={() => { void res.reload() }} /> : <Skeleton rows={6} />}
      </>
    )
  }

  const procCols: Column<SystemProcess>[] = [
    { key: "pid", label: "PID", align: "right", mono: true, width: "84px", render: p => <span className="ink-2">{p.pid}</span>, sort: processComparator("pid", pDir) },
    { key: "user", label: "User", priority: 2, width: "120px", render: p => <span className="m-user">{p.user}</span>, sort: processComparator("user", pDir) },
    { key: "cpu", label: "CPU", align: "right", mono: true, width: "84px", render: p => <span className={cpuClass(p.cpu)}>{p.cpu.toFixed(1)}%</span>, sort: processComparator("cpu", pDir) },
    { key: "mem", label: "Memory", align: "right", mono: true, width: "96px", priority: 2, render: p => <span className={memClass(p.mem)}>{sysBytes(p.mem)}</span>, sort: processComparator("mem", pDir) },
    {
      key: "unit", label: "Service", priority: 3, width: "240px", sort: processComparator("unit", pDir),
      render: p => {
        const site = p.unit ? d.candy[p.unit] : undefined
        return (
          <span className="m-unit">
            <span className={p.unit ? "mono m-unit-name" : "ink-3"}>{p.unit ? p.unit.replace(/\.service$/, "") : p.kernel ? "kernel" : "–"}</span>
            {site ? <CandySite name={site} /> : null}
          </span>
        )
      },
    },
    {
      key: "name", label: "Command", sort: processComparator("name", pDir),
      render: p => (
        <span className="m-cmd mono" title={p.cmd || p.name}>
          <b>{p.name}</b>{p.cmd && p.cmd !== p.name ? <span className="ink-2"> {p.cmd}</span> : null}
        </span>
      ),
    },
  ]
  const unitCols: Column<SystemUnit>[] = [
    {
      key: "unit", label: "Service", sort: unitComparator("unit", uDir),
      render: u => (
        <span className="m-unit">
          <span className="mono m-unit-name">{u.unit}</span>
          {d.candy[u.unit] ? <CandySite name={d.candy[u.unit]} /> : null}
          {d.ownUnit && u.unit === d.ownUnit ? <span className="m-tag">this daemon</span> : null}
          {u.failed ? <span className="m-tag cherry">failed</span> : null}
        </span>
      ),
    },
    { key: "processes", label: "Processes", align: "right", mono: true, width: "104px", priority: 2, render: u => u.processes, sort: unitComparator("processes", uDir) },
    { key: "cpu", label: "CPU", align: "right", mono: true, width: "84px", render: u => <span className={cpuClass(u.cpu)}>{u.cpu.toFixed(1)}%</span>, sort: unitComparator("cpu", uDir) },
    { key: "mem", label: "Memory", align: "right", mono: true, width: "96px", priority: 2, render: u => <span className={memClass(u.mem)}>{sysBytes(u.mem)}</span>, sort: unitComparator("mem", uDir) },
  ]

  const count = tab === "processes"
    ? `${(procs?.length ?? 0).toLocaleString("en-US")} processes`
    : `${(units?.length ?? 0).toLocaleString("en-US")} services and sessions${d.failed.length ? `, ${d.failed.length} failed` : ""}`
  const go = (t: MachineTab) => {
    const qs = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""
    navigate((t === "services" ? "/machine/services" : "/machine") + qs)
  }

  return (
    <>
      <PageHeader title={<span className="mono m-host">{d.host || "System"}</span>} meta={meta} />
      <Tiles d={d} cpu={hist.cpu} mem={hist.mem} />
      <div className="m-toolbar">
        <Segmented<MachineTab> label="Show" value={tab} onChange={go}
          options={[{ value: "processes", label: "Processes" }, { value: "services", label: "Services" }]} />
        <Input type="search" className="m-filter" data-shortcut="filter" value={q} aria-label="Filter"
          placeholder={tab === "processes" ? "Filter by name, user, service or pid" : "Filter by service or site"}
          onChange={e => { setQ(e.target.value); setQParam(e.target.value || null) }} />
        <span className="m-count" aria-live="polite">{count}</span>
      </div>
      <div className="m-table" onPointerDown={() => setHeld(true)}>
        {tab === "processes" ? (
          <Table<SystemProcess>
            label="Processes" columns={procCols} rows={procs} rowKey={p => `${p.pid}:${p.start}`} freeze={held}
            sortKey={pKey} sortDir={pDir} onSort={k => onSort(k, pKey, pDir)} maxRows={MAX_ROWS}
            empty={q.trim() ? "Nothing matches" : "No processes"}
            actions={p => processLocked(p, d) ? null : (
              <>
                <Button size="sm" variant="quiet" title="Ask it to exit (SIGTERM)" onClick={() => { void kill(p, "TERM") }}>End</Button>
                <Button size="sm" variant="danger" title="Kill it at once (SIGKILL)" onClick={() => { void kill(p, "KILL") }}>Kill</Button>
              </>
            )} />
        ) : (
          <Table<SystemUnit>
            label="Services" columns={unitCols} rows={units} rowKey={u => u.unit} freeze={held}
            sortKey={uKey} sortDir={uDir} onSort={k => onSort(k, uKey, uDir)}
            empty={q.trim() ? "Nothing matches" : "No services"}
            actions={u => {
              const acts = unitActions(u, d)
              return acts.length ? acts.map(a => (
                <Button key={a} size="sm" variant={a === "stop" ? "danger" : "quiet"} onClick={() => { void unitAct(u, a) }}>
                  {a === "start" ? "Start" : a === "restart" ? "Restart" : "Stop"}
                </Button>
              )) : null
            }} />
        )}
      </div>
    </>
  )
}
