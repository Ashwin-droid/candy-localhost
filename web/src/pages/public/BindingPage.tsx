// One public domain (SPEC §5.13, /public/:subdomain): password, JWT, who may reach it, unbind.

import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate } from "../../api/resources.ts"
import { KEYS, useDomains, useSites } from "../../api/sites.ts"
import type { DomainBinding } from "../../api/types.ts"
import { fmtDate } from "../../lib/format.ts"
import { navigate, useHistoryState, useRoute } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import {
  Banner, Button, EmptyState, ErrorState, errorMessage, Field, Host, InlineReveal, Input, KeyValue, Link, ListEditor,
  PageHeader, Section, SettingsSection, Skeleton, useConfirm, useDraft,
} from "../../ui/index.ts"
import {
  allowedWord, cleanIps, clearJwtWhich, clearPasswordWhich, clearTitle, isUnprotected, jwtApplies, jwtWord, passwordWord,
} from "./lib.ts"
import { LOAD_FAILED, NoZone, type Status, StatusLine } from "./shared.tsx"
import type {
  AllowlistResponse, AuthClearResponse, AuthSetResponse, AuthTokenResponse, ClearWhich, FlashState, UnbindResponse,
} from "./types.ts"
import "./public.css"

export const UNPROTECTED = "Anyone with the link can open it."
export const JWT_HINT = "Sign HS256 tokens with it: aud \"Candy API Authorization Service\", sub \"<site>.candy\", exp at most an hour away, iat now, and a jti to make a token single-use. Send them in X-Auth-Token."
export const TOKEN_LABEL = "Token (good for 10 minutes)"
export const TOKEN_HINT = "Send it in the X-Auth-Token header to try the site from a script. Made with its JWT secret, which is not shown."
export const ALLOW_HELP = "Tailscale and this machine are always allowed. Caddy drops others silently. Empty means everyone."
export const ENTER_PASSWORD = "Enter a password."
export const NO_MATCH = "The passwords don’t match."

export default function BindingPage(): React.JSX.Element {
  const route = useRoute()
  const sub = route.params.subdomain ?? ""
  useEffect(() => { document.title = `${sub} – Public domains – candy` }, [sub])
  const domains = useDomains()
  const flash = useHistoryState<FlashState>()?.flash ?? null
  const d = domains.data

  if (!d) {
    return (
      <>
        <PageHeader back={{ to: "/public", label: "Public domains" }} title={sub} />
        {domains.error
          ? <ErrorState error={`${LOAD_FAILED} ${errorMessage(domains.error)}`} onRetry={() => { void domains.reload() }} />
          : <Skeleton rows={4} />}
      </>
    )
  }
  if (!d.configured) {
    return (
      <>
        <PageHeader back={{ to: "/public", label: "Public domains" }} title={sub} />
        <NoZone />
      </>
    )
  }
  const b = d.bindings[sub] ?? Object.values(d.bindings).find(x => x.subdomain === sub)
  if (!b) {
    return (
      <>
        <PageHeader back={{ to: "/public", label: "Public domains" }} title={sub} />
        <EmptyState action={<Link to="/public" className="ui-btn ui-btn-secondary">All public domains</Link>}>
          There’s no public domain <span className="mono">{sub}.{d.zone.domain}</span>.
        </EmptyState>
      </>
    )
  }
  return <Binding key={b.subdomain} b={b} zone={d.zone.domain} flash={flash} />
}

/** Runs a domain change: `data.message || done` inline, then refetch `domains`. */
async function change<T extends { message?: string }>(run: () => Promise<T>, done: string,
  set: (s: Status) => void): Promise<T | null> {
  try {
    const data = await run()
    set({ kind: "ok", text: data.message || done })
    return data
  } catch (e) {
    set({ kind: "error", text: errorMessage(e) })
    return null
  } finally {
    invalidate(KEYS.domains)
  }
}

function Binding(p: { b: DomainBinding; zone: string; flash: string | null }): React.JSX.Element {
  const { b, zone } = p
  const session = useSession()
  const { sites, offline } = useSites()
  const confirm = useConfirm()
  const isSite = (sites ?? []).some(s => s.name === b.serverName)
  const fqdn = b.fqdn
  const bound = fmtDate(b.boundAt)

  return (
    <>
      <PageHeader back={{ to: "/public", label: "Public domains" }}
        title={<Host name={b.subdomain} tld={zone} size="xl" />} external={`https://${fqdn}`}
        meta={[
          <>Serves {isSite
            ? <Link to={`/sites/${encodeURIComponent(b.serverName)}`} className="mono pub-meta-link">{b.serverName}</Link>
            : <span className="mono">{b.serverName}</span>}</>,
          b.apiMode ? "API mode" : null,
          bound ? `Bound ${bound.replace(/, .*$/, "")}` : null,
          session.superuser ? <>Owner <span className="mono">{b.owner}</span>{b.orphaned ? " (orphaned)" : ""}</> : null,
        ]} />
      <div className="pub-binding">
      {isUnprotected(b) ? <div className="pub-banner"><Banner kind="error">{UNPROTECTED}</Banner></div> : null}
      {p.flash ? <div className="pub-flash"><StatusLine status={{ kind: "ok", text: p.flash }} /></div> : null}
      <PasswordSection b={b} offline={offline} confirm={confirm} />
      {jwtApplies(b) ? <JwtSection b={b} offline={offline} confirm={confirm} /> : null}
      <ReachSection b={b} offline={offline} confirm={confirm} />
      <UnbindSection b={b} offline={offline} confirm={confirm} />
      </div>
    </>
  )
}

type Confirm = ReturnType<typeof useConfirm>
interface SectionProps { b: DomainBinding; offline: boolean; confirm: Confirm }

async function clear(b: DomainBinding, which: ClearWhich, confirm: Confirm, set: (s: Status) => void): Promise<void> {
  if (!(await confirm({ title: clearTitle(which, b.fqdn), verb: "Remove", danger: true }))) return
  await change(() => getApi().post<AuthClearResponse>("/auth/clear", { domain: b.fqdn, which }), "Removed.", set)
}

function PasswordSection(p: SectionProps): React.JSX.Element {
  const { b } = p
  const [status, setStatus] = useState<Status | null>(null)
  const [editing, setEditing] = useState(false)
  const [pw, setPw] = useState("")
  const [pw2, setPw2] = useState("")
  const [err, setErr] = useState<{ pw?: string; pw2?: string }>({})
  const [busy, setBusy] = useState(false)
  const set = !isUnprotected(b) || b.hasPassword

  const submit = async () => {
    if (!pw) { setErr({ pw: ENTER_PASSWORD }); return }
    if (pw !== pw2) { setErr({ pw2: NO_MATCH }); return }
    setErr({})
    setBusy(true)
    const ok = await change(() => getApi().post<AuthSetResponse>("/auth/set", { domain: b.fqdn, password: pw }), "Password set.", setStatus)
    setBusy(false)
    if (ok) { setEditing(false); setPw(""); setPw2("") }
  }

  return (
    <Section id="password" title="Password"
      description={b.apiMode
        ? "In API mode the password guards every request, not only a login page."
        : "Visitors enter it on a login page before they reach the site."}>
      {editing ? (
        <form className="pub-card" noValidate aria-label="Set a password" onSubmit={e => { e.preventDefault(); if (!busy) void submit() }}>
          <p className="pub-card-lede">Visitors to <span className="mono">{b.fqdn}</span> need this password.</p>
          <div className="fields-2">
            <Field label="Password" htmlFor="pw" error={err.pw}>
              <Input id="pw" type="password" autoComplete="new-password" value={pw} invalid={!!err.pw}
                onChange={e => { setPw(e.target.value); setErr({}) }} autoFocus />
            </Field>
            <Field label="Confirm password" htmlFor="pw2" error={err.pw2}>
              <Input id="pw2" type="password" autoComplete="new-password" value={pw2} invalid={!!err.pw2}
                onChange={e => { setPw2(e.target.value); setErr({}) }} />
            </Field>
          </div>
          <div className="pub-card-foot">
            <StatusLine status={status?.kind === "error" ? status : null} />
            <div className="row">
              <Button variant="quiet" disabled={busy} onClick={() => { setEditing(false); setErr({}); setPw(""); setPw2("") }}>Cancel</Button>
              <Button variant="primary" type="submit" busy={busy} disabled={p.offline}>Set password</Button>
            </div>
          </div>
        </form>
      ) : (
        <>
          <KeyValue rows={[{
            label: "Password",
            value: <span className={set ? undefined : "cherry"}>{passwordWord(b)}</span>,
            hint: b.hasPassword && !b.authEnabled ? "A password is stored, but protection is switched off." : undefined,
            action: b.hasPassword
              ? <Button size="sm" variant="danger" disabled={p.offline}
                  onClick={() => { void clear(b, clearPasswordWhich(b), p.confirm, setStatus) }}>Remove</Button>
              : <Button size="sm" disabled={p.offline} onClick={() => { setStatus(null); setEditing(true) }}>Set a password</Button>,
          }]} />
          <StatusLine status={status} />
        </>
      )}
    </Section>
  )
}

function JwtSection(p: SectionProps): React.JSX.Element {
  const { b } = p
  const [status, setStatus] = useState<Status | null>(null)
  const [reveal, setReveal] = useState<{ label: string; value: string; hint: string } | null>(null)
  const [busy, setBusy] = useState<"gen" | "token" | null>(null)

  const generate = async (replacing: boolean) => {
    if (replacing && !(await p.confirm({
      title: `Replace the JWT secret for ${b.fqdn}?`, body: "Tokens signed with the old one stop working.", verb: "Replace", danger: true,
    }))) return
    setBusy("gen")
    const data = await change(() => getApi().post<AuthSetResponse>("/auth/set", { domain: b.fqdn, jwtSecret: "generate" }), "JWT secret set.", setStatus)
    setBusy(null)
    if (data?.jwtSecret) { setStatus(null); setReveal({ label: `JWT secret for ${b.fqdn}`, value: data.jwtSecret, hint: JWT_HINT }) }
  }
  const token = async () => {
    setBusy("token")
    try {
      const data = await getApi().post<AuthTokenResponse>("/auth/token", { domain: b.fqdn, ttl: 600 })
      setStatus(null)
      setReveal({ label: TOKEN_LABEL, value: data.token, hint: TOKEN_HINT })
    } catch (e) {
      setStatus({ kind: "error", text: errorMessage(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section id="jwt" title="JWT" description="For scripts and other servers: a signed token in the X-Auth-Token header instead of a password.">
      {reveal ? (
        <InlineReveal label={reveal.label} value={reveal.value} hint={reveal.hint} onDone={() => setReveal(null)} />
      ) : (
        <>
          <KeyValue rows={[{
            label: "JWT secret",
            value: <span className={b.hasJwtSecret ? undefined : "ink-2"}>{jwtWord(b)}</span>,
            hint: b.hasJwtSecret && !b.apiMode ? "The site isn’t in API mode, so tokens are not checked." : undefined,
            action: b.hasJwtSecret ? (
              <>
                <Button size="sm" busy={busy === "token"} disabled={p.offline || !!busy} onClick={() => { void token() }}>Make a 10-minute token</Button>
                <Button size="sm" busy={busy === "gen"} disabled={p.offline || !!busy} onClick={() => { void generate(true) }}>Rotate</Button>
                <Button size="sm" variant="danger" disabled={p.offline || !!busy}
                  onClick={() => { void clear(b, clearJwtWhich(b), p.confirm, setStatus) }}>Remove</Button>
              </>
            ) : (
              <Button size="sm" busy={busy === "gen"} disabled={p.offline} onClick={() => { void generate(false) }}>Generate</Button>
            ),
          }]} />
          <StatusLine status={status} />
        </>
      )}
    </Section>
  )
}

function ReachSection(p: SectionProps): React.JSX.Element {
  const { b } = p
  const server = useMemo(() => ({ ips: b.allowlist?.enabled ? b.allowlist.ips : [] }), [b.allowlist?.enabled, b.allowlist?.ips])
  const draft = useDraft<{ ips: string[] }>(server)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)

  const save = async () => {
    const ips = cleanIps(draft.draft.ips)
    setSaving(true)
    const data = await change(() => getApi().post<AllowlistResponse>("/domains/allowlist", { domain: b.fqdn, ips, enabled: ips.length > 0 }),
      "Saved.", s => setStatus({ kind: s.kind === "error" ? "error" : "ok", text: s.text }))
    setSaving(false)
    if (data) draft.commit({ ips: data.allowlist?.enabled ? data.allowlist.ips : [] })
  }
  const allowAll = async () => {
    if (!(await p.confirm({ title: `Let anyone reach ${b.fqdn}?`, verb: "Allow all" }))) return
    setSaving(true)
    const data = await change(() => getApi().post<AllowlistResponse>("/domains/allowlist", { domain: b.fqdn, ips: [], enabled: false }),
      "Anyone can reach it now.", s => setStatus({ kind: s.kind === "error" ? "error" : "ok", text: s.text }))
    setSaving(false)
    if (data) draft.commit({ ips: [] })
  }

  return (
    <SettingsSection id="reach" title="Who can reach it"
      description={<>Now: <span className="pub-now">{allowedWord(b)}</span>{b.allowlist?.enabled && b.allowlist.ips.length
        ? <> (<span className="mono">{b.allowlist.ips.join(", ")}</span>)</> : null}</>}
      dirty={draft.dirty} saving={saving} status={status} conflict={draft.conflict}
      onSave={() => { if (!p.offline) void save() }} onReset={() => { draft.reset(); setStatus(null) }}>
      <Field label="Allowed IPs or CIDRs" help={ALLOW_HELP}>
        <ListEditor mono values={draft.draft.ips} onChange={v => { draft.set("ips", v); setStatus(null) }}
          placeholder="203.0.113.7 or 198.51.100.0/24" addLabel="Add" />
      </Field>
      {b.allowlist?.enabled && !draft.dirty ? (
        <div className="row">
          <Button disabled={p.offline || saving} onClick={() => { void allowAll() }}>Allow all</Button>
          <span className="help">Turns the list off: anyone with the link can reach it again.</span>
        </div>
      ) : null}
    </SettingsSection>
  )
}

function UnbindSection(p: SectionProps): React.JSX.Element {
  const { b } = p
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const unbind = async () => {
    if (!(await p.confirm({
      title: `Unbind ${b.subdomain}?`, body: "The site is no longer served on its public domain.", verb: "Unbind", danger: true,
    }))) return
    setBusy(true)
    try {
      const data = await getApi().del<UnbindResponse>("/domains/unbind/" + encodeURIComponent(b.subdomain))
      invalidate([KEYS.domains, KEYS.sites])
      const state: FlashState = { flash: data.message || "Domain unbound." }
      navigate("/public", { state })
    } catch (e) {
      setStatus({ kind: "error", text: errorMessage(e) })
      invalidate(KEYS.domains)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section id="unbind" title="Unbind">
      <div className="pub-card pub-danger">
        <div className="pub-danger-text">
          <span>Stop serving <span className="mono">{b.serverName}</span> at <span className="mono">{b.fqdn}</span>.</span>
          <span className="help">The site itself keeps running at its candy address.</span>
          <StatusLine status={status} />
        </div>
        <Button variant="danger" busy={busy} disabled={p.offline} onClick={() => { void unbind() }}>Unbind</Button>
      </div>
    </Section>
  )
}
