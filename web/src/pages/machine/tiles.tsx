// The four Machine tiles: CPU, Memory, Disks, Network (SPEC §5.15).

import type React from "react"
import type { SystemStats } from "../../api/types.ts"
import { sysBytes } from "../../lib/format.ts"
import { Meter, Sparkline } from "../../ui/index.ts"

export const pct1 = (v: number): string => `${v.toFixed(v < 10 ? 1 : 0)}%`

function Tile(p: { title: string; aside?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="m-tile" aria-label={p.title}>
      <div className="m-tile-head">
        <h2 className="m-tile-title">{p.title}</h2>
        {p.aside ? <span className="m-tile-aside">{p.aside}</span> : null}
      </div>
      {p.children}
    </section>
  )
}

/** Interfaces with traffic (all of them when there are 3 or fewer), top 4 by rx + tx. */
export function busyInterfaces(net: SystemStats["net"]): SystemStats["net"] {
  return net.filter(n => n.rx > 0 || n.tx > 0 || net.length <= 3).sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx)).slice(0, 4)
}

export function Tiles(p: { d: SystemStats; cpu: number[]; mem: number[] }): React.JSX.Element {
  const { d } = p
  const memPct = 100 * d.mem.used / (d.mem.total || 1)
  const nets = busyInterfaces(d.net)
  return (
    <div className="m-tiles">
      <Tile title="CPU" aside={`${d.cpu.cores.length} cores`}>
        <div className="m-stat">{pct1(d.cpu.percent)}</div>
        <div className="m-sub mono">load {d.load.map(n => n.toFixed(2)).join(" ")}</div>
        <div className="m-spark"><Sparkline values={p.cpu} max={100} width={240} height={36} label="CPU use, last two minutes" /></div>
        <div className="m-cores" aria-label="Per core">
          {d.cpu.cores.map((c, i) => <Meter key={i} value={c / 100} label={`Core ${i + 1}: ${c.toFixed(0)}%`} />)}
        </div>
      </Tile>
      <Tile title="Memory" aside={d.mem.swapTotal ? `swap ${sysBytes(d.mem.swapUsed)} of ${sysBytes(d.mem.swapTotal)}` : "no swap"}>
        <div className="m-stat">{sysBytes(d.mem.used)}</div>
        <div className="m-sub">of {sysBytes(d.mem.total)} · {memPct.toFixed(0)}%</div>
        <div className="m-spark"><Sparkline values={p.mem} max={100} width={240} height={36} label="Memory use, last two minutes" /></div>
        <div className="m-sub">{sysBytes(d.mem.available)} available · {sysBytes(d.mem.cached)} cache</div>
      </Tile>
      <Tile title="Disks">
        {d.disks.length ? (
          <ul className="m-lines">
            {d.disks.slice(0, 4).map(k => {
              const total = k.used + k.available
              return (
                <li key={`${k.device}|${k.mount}`} className="m-disk" title={`${k.device} (${k.type})`}>
                  <div className="m-line"><span className="mono m-name">{k.mount}</span><span className="m-val">{sysBytes(k.used)} of {sysBytes(total)}</span></div>
                  <Meter value={k.used / (total || 1)} label={`${k.mount}: ${sysBytes(k.used)} of ${sysBytes(total)}`} />
                </li>
              )
            })}
          </ul>
        ) : <div className="m-sub">No disks found.</div>}
      </Tile>
      <Tile title="Network" aside={d.temp ? `${Math.round(d.temp)}°C` : undefined}>
        {nets.length ? (
          <ul className="m-lines">
            {nets.map(n => (
              <li key={n.name} className="m-line">
                <span className="mono m-name">{n.name}</span>
                <span className="m-val mono">↓ {sysBytes(n.rx)}/s ↑ {sysBytes(n.tx)}/s</span>
              </li>
            ))}
          </ul>
        ) : <div className="m-sub">No traffic</div>}
      </Tile>
    </div>
  )
}
