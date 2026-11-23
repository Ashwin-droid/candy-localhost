// Settings tab of a site (SPEC §5.5). Each section appears only when it applies; text fields are drafts with a
// Save footer, switches save on change. One file per section under ./settings/.

import type React from "react"
import { useMemo } from "react"
import { useSites } from "../../api/sites.ts"
import type { TabProps } from "../../lib/site.ts"
import { useRoute } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import { EmptyState, SubNav } from "../../ui/index.ts"
import { SettingsCtx, visibility, type SettingsContext, type Visibility } from "./settings/common.tsx"
import { DangerSection } from "./settings/DangerSection.tsx"
import { DomainsSection } from "./settings/DomainsSection.tsx"
import { EnvironmentSection } from "./settings/EnvironmentSection.tsx"
import { GeneralSection } from "./settings/GeneralSection.tsx"
import { ReachSection } from "./settings/ReachSection.tsx"
import { SandboxSection } from "./settings/SandboxSection.tsx"
import { ScalingSection } from "./settings/ScalingSection.tsx"
import { StartCommandsSection } from "./settings/StartCommandsSection.tsx"
import { StartupSection } from "./settings/StartupSection.tsx"
import "./settings.css"

/** The section index, in page order: [anchor, label]. */
export function sectionIndex(v: Visibility, o: { static: boolean }): [string, string][] {
  const out: [string, string][] = []
  if (v.general) out.push(["general", "General"])
  if (v.startCommands) out.push(["start-commands", "Start commands"])
  if (v.startup) out.push(["startup", "Startup"])
  if (v.scaling) out.push(["scaling", o.static ? "Request log" : "Scaling"])
  if (v.environment) out.push(["environment", "Environment"])
  if (v.sandbox) out.push(["sandbox", "Sandbox and memory"])
  if (v.reach) out.push(["reach", "Reachability"])
  if (v.danger) out.push(["danger", "Delete"])
  return out
}

export default function SettingsTab(p: TabProps): React.JSX.Element {
  const { site } = p
  const session = useSession()
  const route = useRoute()
  const { offline } = useSites()
  const v = visibility(site, session)
  const ctx = useMemo<SettingsContext>(() => ({
    site, tld: session.tld, superuser: session.superuser, multiUser: session.multiUser, offline,
  }), [site, session.tld, session.superuser, session.multiUser, offline])
  const index = sectionIndex(v, { static: site.kind === "static" })
  const here = route.hash.slice(1)
  const base = `/sites/${encodeURIComponent(site.name)}/settings`
  const active = index.some(([id]) => id === here) ? here : here === "reach-domains" ? "reach" : index[0]?.[0]

  return (
    <SettingsCtx.Provider value={ctx}>
      <div className="site-settings">
        {index.length > 1 ? (
          <SubNav label="Settings sections" items={index.map(([id, label]) => ({ to: `${base}#${id}`, label, active: id === active }))} />
        ) : null}
        <div className="site-settings-body">
          {/* key: a rename re-mounts the drafts for the new name */}
          <div key={site.name} className="site-settings-column">
            {v.general ? <GeneralSection v={v} /> : null}
            {v.startCommands ? <StartCommandsSection /> : null}
            {v.startup ? <StartupSection v={v} /> : null}
            {v.scaling ? <ScalingSection v={v} /> : null}
            {v.environment ? <EnvironmentSection /> : null}
            {v.sandbox ? <SandboxSection /> : null}
            {v.reach ? <ReachSection v={v} /> : null}
            {v.domains ? <DomainsSection /> : null}
            {v.danger ? <DangerSection v={v} /> : null}
            {!index.length ? <EmptyState>Nothing about {site.name} can be changed from the portal.</EmptyState> : null}
          </div>
        </div>
      </div>
    </SettingsCtx.Provider>
  )
}
