import { describe, expect, test } from "bun:test"
import { useResource } from "../api/resources.ts"
import { useSites } from "../api/sites.ts"
import { collectSites } from "../lib/site.ts"
import { AssetsFacts } from "../shared/AssetsFacts.tsx"
import { canStart, StartButton } from "../shared/StartButton.tsx"
import {
  AnsiText, Banner, Button, EmptyState, ErrorState, Field, Host, Input, KeyValue, Meter, PageHeader, SettingsSection, StatusDot, Table, Tabs,
} from "../ui/index.ts"
import { config, fnSummary, proc, route, status } from "./fixtures.ts"
import { renderWith } from "./render.tsx"

const HOSTILE = `<img src=x onerror=alert(1)>`
const cols = [{ key: "name", label: "Name", render: (r: { name: string }) => r.name }]

describe("Table", () => {
  test("loading shows a skeleton, not a table", () => {
    const html = renderWith(<Table label="Sites" columns={cols} rows={undefined} rowKey={r => r.name} loading />)
    expect(html).toContain("ui-skeleton")
    expect(html).not.toContain("<table")
  })
  test("error with no rows shows the error and Try again", () => {
    const html = renderWith(<Table label="Sites" columns={cols} rows={undefined} rowKey={r => r.name} error="daemon down" onRetry={() => {}} />)
    expect(html).toContain("Couldn’t load: daemon down")
    expect(html).toContain("Try again")
  })
  test("empty shows the empty text", () => {
    const html = renderWith(<Table label="Sites" columns={cols} rows={[]} rowKey={r => r.name} empty="No sites yet." />)
    expect(html).toContain("No sites yet.")
    expect(html).not.toContain("<table")
  })
  test("rows render escaped, with links, sort buttons and the maxRows footer", () => {
    const rows = [{ name: HOSTILE }, { name: "b" }, { name: "a" }]
    const html = renderWith(<Table label="Sites" rows={rows} rowKey={(r, i) => `${i}`} rowHref={r => `/sites/${encodeURIComponent(r.name)}`} maxRows={2}
      columns={[{ key: "name", label: "Name", render: r => r.name, sort: (x, y) => x.name.localeCompare(y.name) }]} sortKey="name" sortDir={1} onSort={() => {}} />)
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).toContain('aria-sort="ascending"')
    expect(html).toContain("Showing 2 of 3. Filter to narrow it.")
    expect(html).toContain('class="ui-row-link"')
    expect(html).toContain(">a<")
    expect(html).not.toContain(">b<")   // sorted first, then cut to two rows
  })
  test("error with rows keeps the rows and says it couldn't refresh", () => {
    const html = renderWith(<Table label="x" columns={cols} rows={[{ name: "a" }]} rowKey={r => r.name} error="timeout" />)
    expect(html).toContain("<table")
    expect(html).toContain("Couldn’t refresh: timeout")
  })
})

describe("KeyValue", () => {
  test("escapes values, labels and hints; empty values are a dash; hidden rows are skipped", () => {
    const html = renderWith(<KeyValue rows={[
      { label: HOSTILE, value: HOSTILE, hint: HOSTILE, rawKey: "assets.directory" },
      { label: "Empty", value: "" },
      { label: "Hidden", value: "secret", hidden: true },
    ]} />)
    expect(html).not.toContain("<img")
    expect(html.split("&lt;img").length - 1).toBe(3)
    expect(html).toContain("—")
    expect(html).not.toContain("secret")
    expect(html).toContain("assets.directory")
  })
})

describe("useResource and useSites with primed data", () => {
  test("primed data renders without fetching", () => {
    function V() {
      const r = useResource<{ n: number }>("thing", () => Promise.reject(new Error("must not fetch")))
      return <span>{r.loading ? "loading" : r.data?.n}</span>
    }
    expect(renderWith(<V />, { resources: { thing: { n: 7 } } })).toBe("<span>7</span>")
    expect(renderWith(<V />)).toBe("<span>loading</span>")
  })
  test("a null key is not loading", () => {
    function V() { const r = useResource<number>(null, async () => 1); return <span>{String(r.loading)}</span> }
    expect(renderWith(<V />)).toBe("<span>false</span>")
  })
  test("useSites collects the primed raw answers and leaves the portal out", () => {
    function V() { const { sites, status: st } = useSites(); return <span>{sites?.map(s => s.name).join(",")}|{st?.uptime}</span> }
    const html = renderWith(<V />, { resources: { sites: {
      status, routes: { portal: route(9999), api: route(3000) }, entries: { entries: {} },
      processes: { success: true, processes: {} }, configs: { success: true, configs: {} }, portals: {},
    } } })
    expect(html).toBe(`<span>api|${status.uptime}</span>`)
  })
  test("useSites also accepts a primed Site[]", () => {
    function V() { const { sites } = useSites(); return <span>{sites?.length}</span> }
    const sites = collectSites({ routes: { a: route(1), b: route(2) } })
    expect(renderWith(<V />, { resources: { sites } })).toBe("<span>2</span>")
  })
})

describe("StartButton (§5.1 conditions)", () => {
  const sites = (i: Parameters<typeof collectSites>[0]) => collectSites({ status, ...i })
  test("shown for a stopped server, hidden when active, for functions and plain forwards", () => {
    const [stopped] = sites({ configs: { success: true, configs: { a: config() } } })
    const [running] = sites({ configs: { success: true, configs: { a: config() } }, processes: { success: true, processes: { a: proc() } } })
    const [crashed] = sites({ processes: { success: true, processes: { a: proc({ status: "errored", exitCode: 1 }) } } })
    const [fn] = sites({ configs: { success: true, configs: { a: config({ fn: fnSummary() }) } } })
    const [fwd] = sites({ routes: { a: route(3000) } })
    expect([stopped, running, crashed, fn, fwd].map(canStart)).toEqual([true, false, true, false, false])
    expect(renderWith(<StartButton site={stopped} />)).toContain(">Start<")
    expect(renderWith(<StartButton site={running} />)).toBe("")
    expect(renderWith(<StartButton site={fn} />)).toBe("")
    expect(renderWith(<StartButton site={fwd} />)).toBe("")
  })
  test("several start commands make it a menu button", () => {
    const v = [{ id: "dev", cwd: "/a", cmd: "x", user: "u", api: false }, { id: "prod", cwd: "/b", cmd: "y", user: "u", api: false }]
    const [s] = sites({ configs: { success: true, configs: { a: config({ variants: v }) } } })
    const html = renderWith(<StartButton site={s} size="sm" />)
    expect(html).toContain('aria-haspopup="true"')
    expect(html).toContain("ui-btn-sm")
  })
})

describe("kit pieces", () => {
  test("StatusDot always has a name", () => {
    expect(renderWith(<StatusDot state="crashed" label="Crashed" />)).toContain('aria-label="Crashed"')
    const html = renderWith(<StatusDot state="running" label="Running" showLabel />)
    expect(html).toContain(">Running<")
  })
  test("Host dims the TLD", () => {
    expect(renderWith(<Host name="api" tld="candy" />)).toContain('<span class="ui-host-tld">.candy</span>')
    expect(renderWith(<Host name="api" />)).not.toContain("ui-host-tld")
  })
  test("PageHeader, Tabs, Button busy", () => {
    const html = renderWith(<>
      <PageHeader back={{ to: "/", label: "Sites" }} title={<Host name="api" tld="candy" size="xl" />} external="https://api.candy" meta={["Server", null, "Running for 3h"]} actions={<Button>Stop</Button>} />
      <Tabs label="Site" items={[{ to: "/sites/api", label: "Overview", active: true }, { to: "/sites/api/logs", label: "Logs", count: 3 }]} />
      <Button busy variant="primary">Deploying…</Button>
    </>)
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('aria-busy="true"')
    expect((html.match(/<li>/g) ?? []).length).toBe(2)
  })
  test("Field wires help and error to its control", () => {
    const html = renderWith(<Field label="Port" htmlFor="port" help="Something already listening." error="Enter a port between 1 and 65535"><Input id="port" /></Field>)
    expect(html).toContain('aria-describedby="port-error port-help"')
    expect(html).toContain('aria-invalid="true"')
  })
  test("SettingsSection footer only when there is something to say", () => {
    const quiet = renderWith(<SettingsSection id="s" title="Startup" dirty={false} saving={false} onSave={() => {}} onReset={() => {}}>x</SettingsSection>)
    expect(quiet).not.toContain("ui-settings-foot")
    const dirty = renderWith(<SettingsSection id="s" title="Startup" dirty saving={false} onSave={() => {}} onReset={() => {}}>x</SettingsSection>)
    expect(dirty).toContain("Unsaved changes")
    expect(dirty).toContain(">Save<")
    const conflict = renderWith(<SettingsSection id="s" title="Startup" dirty conflict saving={false} onSave={() => {}} onReset={() => {}}>x</SettingsSection>)
    expect(conflict).toContain("Changed elsewhere. Reset to see the new value.")
    const saved = renderWith(<SettingsSection id="s" title="Startup" dirty={false} saving={false} status={{ kind: "ok", text: "Saved. Applies at its next start." }} onSave={() => {}} onReset={() => {}}>x</SettingsSection>)
    expect(saved).toContain("Saved. Applies at its next start.")
  })
  test("SettingsSection says Save unless given another label", () => {
    const plain = renderWith(<SettingsSection id="s" title="Zone" dirty saving={false} onSave={() => {}} onReset={() => {}}>x</SettingsSection>)
    expect(plain).toContain(">Save</span>")
    const link = renderWith(<SettingsSection id="s" title="AdGuard" dirty saving={false} saveLabel="Link" onSave={() => {}} onReset={() => {}}>x</SettingsSection>)
    expect(link).toContain(">Link</span>")
    expect(link).not.toContain(">Save</span>")
  })
  test("AnsiText renders classes from the table and escapes text", () => {
    const html = renderWith(<AnsiText text={`\x1b[31m${HOSTILE}\x1b[0m`} />)
    expect(html).toContain('<span class="fg-red">&lt;img')
    expect(html).not.toContain("<img")
  })
  test("Meter levels, Banner, EmptyState, ErrorState", () => {
    expect(renderWith(<Meter value={0.95} label="x" />)).toContain("is-hot")
    expect(renderWith(<Meter value={0.8} label="x" />)).toContain("is-warn")
    expect(renderWith(<Banner kind="error">Lost</Banner>)).toContain('role="alert"')
    expect(renderWith(<EmptyState action={<Button>Add</Button>}>None yet.</EmptyState>)).toContain("None yet.")
    expect(renderWith(<ErrorState error={new Error("Couldn’t load deploys: x")} />)).toContain(">Couldn’t load deploys: x<")
  })
  test("AssetsFacts rows and help", () => {
    const html = renderWith(<AssetsFacts fn={fnSummary({ assets: { directory: "/home/a/site/dist", binding: "ASSETS", notFound: "single-page-application", html: "auto-trailing-slash", runWorkerFirst: ["/api/*", "!/api/docs"] } })} />)
    expect(html).toContain("~/site/dist")
    expect(html).toContain("Single-page app: unknown paths get /index.html")
    expect(html).toContain("env.ASSETS")
    expect(html).toContain("assets-pattern is-negated")
    expect(html).toContain("then the code. Edit")
    const off = renderWith(<AssetsFacts fn={fnSummary({ assets: { directory: "/d", binding: null, notFound: "404-page", html: "none", runWorkerFirst: false } })} />)
    expect(off).toContain("Off.")
    expect(off).toContain("run_worker_first")
    expect(off).toContain("None")
  })
})
