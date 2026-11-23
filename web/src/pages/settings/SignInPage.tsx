// Settings › Sign in with candy (SPEC §5.16, 02 §1.6): each site's sign-in key (rotate, revoke, with Restart
// buttons for the servers that still hold the old key) and the sites you said yes to (forget).

import type React from "react"
import { useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate, useResource } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import type { AppAuthConsent, AppAuthSite, RestartResponse } from "../../api/types.ts"
import { useSession } from "../../session.tsx"
import { Button, type Column, errorMessage, Icon, Link, requestConfirm, Section, Table } from "../../ui/index.ts"
import { fmtDay, revokeConfirmBody, revokeText, rotateText } from "./logic.ts"
import { Notice, type NoticeValue, SettingsShell, useOffline } from "./SettingsShell.tsx"
import {
  type AppAuthConsentsResponse, type AppAuthDropResponse, type AppAuthRotateResponse, type AppAuthSitesResponse,
  type ConsentRevokeResponse, SETTINGS_KEYS,
} from "./types.ts"

const reloadBoth = () => invalidate([SETTINGS_KEYS.appAuthSites, SETTINGS_KEYS.appAuthConsents])

/** One Restart button for a server that still holds the old key. */
function RestartButton(p: { name: string; disabled?: boolean }): React.JSX.Element {
  const [state, setState] = useState<{ busy: boolean; done?: string; error?: string }>({ busy: false })
  const run = async () => {
    setState({ busy: true })
    try {
      const r = await getApi().post<RestartResponse>("/process/restart/" + encodeURIComponent(p.name))
      setState({ busy: false, done: r?.message || "Restart scheduled" })
      invalidate(KEYS.sites)
    } catch (e) {
      setState({ busy: false, error: errorMessage(e) })
    }
  }
  return (
    <span className="settings-restart">
      <Button size="sm" busy={state.busy} disabled={p.disabled || !!state.done} onClick={() => void run()}
        icon={state.done ? <Icon name="check" size={14} /> : undefined}>
        Restart <span className="mono">{p.name}</span>
      </Button>
      {state.done ? <span className="small ink-2">{state.done}</span> : null}
      {state.error ? <span className="small cherry" role="alert">{state.error}</span> : null}
    </span>
  )
}

export default function SignInPage(): React.JSX.Element {
  const { user, superuser } = useSession()
  const offline = useOffline()
  const keys = useResource<AppAuthSitesResponse>(SETTINGS_KEYS.appAuthSites,
    signal => getApi().get<AppAuthSitesResponse>("/app-auth/sites", undefined, { signal }))
  const consents = useResource<AppAuthConsentsResponse>(SETTINGS_KEYS.appAuthConsents,
    signal => getApi().get<AppAuthConsentsResponse>("/app-auth/consents", undefined, { signal }))
  const keyRows = keys.data ? (Array.isArray(keys.data.sites) ? keys.data.sites : []) : undefined
  const consentRows = consents.data ? (Array.isArray(consents.data.consents) ? consents.data.consents : []) : undefined

  const [keyNotice, setKeyNotice] = useState<{ notice: NoticeValue; restart: string[]; seq: number } | null>(null)
  const [consentNotice, setConsentNotice] = useState<NoticeValue | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // seq gives each result's Restart buttons fresh state
  const say = (notice: NoticeValue, restart: string[] = []) => setKeyNotice(prev => ({ notice, restart, seq: (prev?.seq ?? 0) + 1 }))

  const rotate = async (s: AppAuthSite) => {
    const ok = await requestConfirm({ title: `Make a new sign-in key for ${s.site}?`,
      body: "Sign-ins started with the old key still finish for a few minutes; none after that.", verb: "Rotate" })
    if (!ok) return
    setBusy("rotate:" + s.site)
    try {
      const r = await getApi().post<AppAuthRotateResponse>("/app-auth/rotate", { name: s.site })
      say({ kind: "ok", text: rotateText(r) }, Array.isArray(r.restartNeeded) ? r.restartNeeded : [])
    } catch (e) {
      say({ kind: "error", text: errorMessage(e) })
    } finally { setBusy(null); reloadBoth() }
  }

  const revoke = async (s: AppAuthSite) => {
    const ok = await requestConfirm({ title: `Revoke the sign-in key of ${s.site}?`, verb: "Revoke", danger: true,
      body: <>{revokeConfirmBody(s.site, s.enabled).map((t, i) => <p key={i}>{t}</p>)}</> })
    if (!ok) return
    setBusy("revoke:" + s.site)
    try {
      const r = await getApi().post<AppAuthDropResponse>("/app-auth/drop", { name: s.site })
      say({ kind: "ok", text: revokeText(r) }, Array.isArray(r.restartNeeded) ? r.restartNeeded : [])
    } catch (e) {
      say({ kind: "error", text: errorMessage(e) })
    } finally { setBusy(null); reloadBoth() }
  }

  const forget = async (c: AppAuthConsent) => {
    const ok = await requestConfirm({ title: `Forget that you said yes to ${c.site}?`, body: "It asks you again next time.", verb: "Forget" })
    if (!ok) return
    setBusy("forget:" + c.site)
    try {
      const r = await getApi().post<ConsentRevokeResponse>("/app-auth/consents/revoke", { site: c.site })
      setConsentNotice({ kind: "ok", text: r.revoked ? `${c.site} will ask again next time.` : `You hadn’t said yes to ${c.site}.` })
    } catch (e) {
      setConsentNotice({ kind: "error", text: errorMessage(e) })
    } finally { setBusy(null); reloadBoth() }
  }

  const keyColumns: Column<AppAuthSite>[] = [
    {
      key: "site", label: "Site", render: s => (
        <span className="settings-site">
          <Link to={`/sites/${encodeURIComponent(s.site)}`} className="mono">{s.site}</Link>
          {superuser && s.owner && s.owner !== user ? <span className="small ink-2" title={`Run by ${s.owner}`}>{s.owner}</span> : null}
        </span>
      ),
    },
    {
      key: "kid", label: "Key", priority: 2, render: s => (
        <span className="settings-kid">
          <span className="mono">{s.kid}</span>
          <span className="small ink-2">Made {fmtDay(s.created)}{s.rotatedAt ? `, replaced ${fmtDay(s.rotatedAt)}` : ""}</span>
        </span>
      ),
    },
    {
      key: "status", label: "Status", render: s => s.enabled
        ? <span title="Its candy.json asks for sign-in">In use</span>
        : <span className="ink-2" title={`Its candy.json doesn’t ask for sign-in ("auth": true). Nothing needs this key: revoke it.`}>Not asked for</span>,
    },
  ]

  const consentColumns: Column<AppAuthConsent>[] = [
    { key: "site", label: "Site", mono: true, render: c => c.site },
    { key: "owner", label: "Run by", mono: true, priority: 2, render: c => c.owner },
    { key: "at", label: "Since", priority: 2, render: c => fmtDay(c.at) },
  ]

  return (
    <SettingsShell title="Sign in with candy">
      <Section id="keys" title="Your sites' keys"
        description={<>Sites whose candy.json asks for <code>"auth": true</code> get a key. Apps use it to check who signed in with candy.</>}>
        <Table label="Your sites' keys" columns={keyColumns} rows={keyRows} rowKey={s => s.site}
          loading={keys.loading} error={keys.error ? keys.error.message : null} onRetry={() => void keys.reload()}
          empty="None of your sites has a sign-in key."
          actions={s => (
            <>
              {s.enabled ? (
                <Button size="sm" variant="quiet" title="Make a new sign-in key for this site" busy={busy === "rotate:" + s.site}
                  disabled={offline || !!busy} onClick={() => void rotate(s)}>Rotate</Button>
              ) : null}
              <Button size="sm" variant="danger" title="Delete the key and everyone’s approvals of this site" busy={busy === "revoke:" + s.site}
                disabled={offline || !!busy} onClick={() => void revoke(s)}>Revoke</Button>
            </>
          )} />
        {keyNotice ? (
          <Notice notice={keyNotice.notice}>
            {keyNotice.restart.length ? (
              <span className="row">{keyNotice.restart.map(n => <RestartButton key={`${keyNotice.seq}:${n}`} name={n} disabled={offline} />)}</span>
            ) : null}
          </Notice>
        ) : <Notice notice={null} />}
      </Section>

      <Section id="consents" title="Sites you said yes to" description="Sites that may sign you in without asking. Forget one and it asks again.">
        <Table label="Sites you said yes to" columns={consentColumns} rows={consentRows} rowKey={c => `${c.owner}/${c.site}`}
          loading={consents.loading} error={consents.error ? consents.error.message : null} onRetry={() => void consents.reload()}
          empty="You haven’t said yes to any site."
          actions={c => (
            <Button size="sm" variant="quiet" title="It asks you again next time" busy={busy === "forget:" + c.site}
              disabled={offline || !!busy} onClick={() => void forget(c)}>Forget</Button>
          )} />
        <Notice notice={consentNotice} />
      </Section>
    </SettingsShell>
  )
}
