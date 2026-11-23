// Settings › Account (SPEC §5.16): who is logged in, how, the theme, the keyboard shortcuts and Log out.

import type React from "react"
import { useEffect, useState } from "react"
import { usePeek } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import type { MeResponse } from "../../api/types.ts"
import { settingsHashRedirect } from "../../lib/deeplinks.ts"
import { getTheme, onThemeChange, setTheme, type Theme } from "../../lib/theme.ts"
import { navigate, useRoute } from "../../router.tsx"
import { logout, useSession } from "../../session.tsx"
import { Button, Icon, Kbd, KeyValue, Section, Segmented } from "../../ui/index.ts"
import { SettingsShell } from "./SettingsShell.tsx"

export const ROLE_SUPERUSER = "Superuser: you see and manage every user's sites and the daemon's settings"
export const ROLE_USER = "User: you see and manage your own sites"

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" },
]

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["/"], what: "Focus the filter on the current page" },
  { keys: ["n"], what: "Add a site" },
  { keys: ["g", "s"], what: "Go to Sites" },
  { keys: ["g", "a"], what: "Go to Activity" },
  { keys: ["1", "–", "8"], what: "Switch tabs on a site page" },
]

export default function AccountPage(): React.JSX.Element {
  const session = useSession()
  const route = useRoute()
  const me = usePeek<MeResponse>(KEYS.me)

  // Old bookmarks: /settings#passkeys, #signin, #domains, #daemon
  useEffect(() => {
    const to = settingsHashRedirect(route.hash)
    if (to) navigate(to, { replace: true })
  }, [route.hash])

  const [theme, setThemeState] = useState<Theme>("system")
  useEffect(() => {
    setThemeState(getTheme())
    return onThemeChange(setThemeState)
  }, [])

  const [leaving, setLeaving] = useState(false)
  const amr = me?.amr ?? session.amr
  const multiUser = me?.multiUser ?? session.multiUser

  return (
    <SettingsShell title="Settings">
      <Section id="account" title="Account"
        actions={<Button icon={<Icon name="logout" size={14} />} busy={leaving}
          onClick={() => { setLeaving(true); void logout() }}>Log out</Button>}>
        <KeyValue rows={[
          { label: "Logged in as", value: session.user, mono: true },
          { label: "Role", value: session.superuser ? ROLE_SUPERUSER : ROLE_USER },
          { label: "Logged in with", value: amr === "passkey" ? "A passkey" : amr === "pam" ? "Your password" : null },
          { label: "Multi-user", value: multiUser ? "Yes: sites run as their own users, in a sandbox" : "No" },
        ]} />
      </Section>

      <Section id="appearance" title="Appearance" description="Saved in this browser. System follows your device’s light or dark setting.">
        <div className="settings-sheet settings-sheet-row">
          <span className="settings-sheet-label" id="theme-label">Theme</span>
          <Segmented label="Theme" options={THEMES} value={theme} onChange={t => setTheme(t)} />
        </div>
      </Section>

      <Section id="shortcuts" title="Keyboard shortcuts" description="They work when no field is focused and no dialog is open.">
        <KeyValue labelWidth={240} rows={SHORTCUTS.map(s => ({
          label: s.what,
          value: <span className="settings-keys">
            {s.keys.map((k, i) => k === "–" ? <span key={i} className="ink-2">–</span> : <Kbd key={i}>{k}</Kbd>)}
          </span>,
        }))} />
      </Section>

      <Section id="protocol" title="Open with the candy:// protocol"
        description="A link the candy desktop handler opens straight to this portal.">
        <KeyValue rows={[
          { label: "Link", value: <a className="settings-link mono" href="candy://portal" title="Open via the candy:// protocol">candy://portal</a> },
        ]} />
      </Section>
    </SettingsShell>
  )
}
