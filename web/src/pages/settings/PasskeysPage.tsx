// Settings › Passkeys (SPEC §5.16, 02 §2): the list with inline rename and delete, the recent-password panel,
// and Add a passkey, which runs on candy's own host in a popup (this page never calls WebAuthn itself).

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { ApiError, getApi } from "../../api/client.ts"
import { invalidate, useResource } from "../../api/resources.ts"
import type { PasskeyView } from "../../api/types.ts"
import { useSession } from "../../session.tsx"
import {
  Banner, Button, type Column, errorMessage, Field, Input, Link, RelativeTime, requestConfirm, Section, Table,
} from "../../ui/index.ts"
import { fmtDay, fmtWhen, needsPassword } from "./logic.ts"
import { acceptPasskeyMessage, checkEnrollUrl, ENROLL_WRONG } from "./passkeyMessage.ts"
import { ReauthPanel } from "./ReauthPanel.tsx"
import { Notice, type NoticeValue, SettingsShell, useCountdown, useOffline } from "./SettingsShell.tsx"
import { type EnrollStartResponse, type PasskeyListResponse, SETTINGS_KEYS } from "./types.ts"

export const NO_DOMAIN = "Passkeys need a bound domain: candy checks them on candy.<your domain>, which has a real certificate. Set up a domain to use them; until then, log in with your password."
export const NEEDS_DOMAIN = "Needs a bound domain (see above)."
export const NO_WEBAUTHN = "This browser can’t make passkeys."
export const DELETED = "Passkey deleted. Also remove it from your device or password manager."

function defaultName(): string {
  let platform = ""
  try {
    if (typeof navigator !== "undefined") {
      const n = navigator as Navigator & { userAgentData?: { platform?: string } }
      platform = n.userAgentData?.platform || n.platform || ""
    }
  } catch { platform = "" }
  return ("Passkey on " + (platform || "this device")).slice(0, 64)
}

/** Opened blank inside the click itself (popup blockers), pointed at the candy host once the stamp is there. */
function openPopup(): Window | null {
  const w = 470, h = 640
  const left = Math.max(0, Math.round((window.screenX || 0) + ((window.outerWidth || w) - w) / 2))
  const top = Math.max(0, Math.round((window.screenY || 0) + ((window.outerHeight || h) - h) / 2))
  const win = window.open("", "candy-passkey", `popup,width=${w},height=${h},left=${left},top=${top}`)
  try { if (win) win.document.title = "Passkey · candy" } catch { /* cross-origin already */ }
  return win
}
const closeWin = (w: Window | null) => { try { if (w && !w.closed) w.close() } catch { /* ignore */ } }

export default function PasskeysPage(): React.JSX.Element {
  const session = useSession()
  const offline = useOffline()
  const { candyHost, user } = session
  const candyOrigin = candyHost ? "https://" + candyHost : null
  const list = useResource<PasskeyListResponse>(SETTINGS_KEYS.passkeys,
    signal => getApi().get<PasskeyListResponse>("/passkeys/list", undefined, { signal }))
  const passkeys = list.data ? (Array.isArray(list.data.passkeys) ? list.data.passkeys : []) : undefined

  // The password freshness as of now, also between renders (a reauth sets it before React re-renders)
  const pam = useRef(session.pamUntil)
  useEffect(() => { pam.current = session.pamUntil }, [session.pamUntil])
  const setPam = useCallback((v: number | null) => { pam.current = v; session.setPamUntil(v) }, [session])

  // ---- recent password ----
  const [reauthOpen, setReauthOpen] = useState(false)
  const waiter = useRef<((ok: boolean) => void) | null>(null)
  const askPassword = useCallback(() => new Promise<boolean>(resolve => {
    waiter.current?.(false)
    waiter.current = resolve
    setReauthOpen(true)
  }), [])
  const reauthDone = (ok: boolean, until?: number) => {
    if (ok && typeof until === "number") setPam(until)
    setReauthOpen(false)
    const w = waiter.current
    waiter.current = null
    w?.(ok)
  }
  async function withRecentPassword<T>(fn: () => Promise<T>): Promise<T | null> {
    if (needsPassword(pam.current) && !(await askPassword())) return null
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof ApiError && e.reauth)) throw e
      setPam(null)
      if (!(await askPassword())) return null
      return await fn()
    }
  }

  // ---- list: rename, delete ----
  const [listNotice, setListNotice] = useState<NoticeValue | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const editingRef = useRef(editing)
  editingRef.current = editing
  const [busyId, setBusyId] = useState<string | null>(null)

  const finishRename = async (pk: PasskeyView, save: boolean) => {
    const e = editingRef.current
    if (!e || e.id !== pk.id) return
    editingRef.current = null
    setEditing(null)
    const name = e.value.trim()
    if (!save || !name || name === pk.name) return
    setBusyId(pk.id)
    setListNotice(null)
    try {
      await getApi().post("/passkeys/rename", { id: pk.id, name })
      invalidate(SETTINGS_KEYS.passkeys)
    } catch (err) {
      setListNotice({ kind: "error", text: errorMessage(err) })
    } finally { setBusyId(null) }
  }

  const deletePasskey = async (pk: PasskeyView) => {
    const ok = await requestConfirm({ title: `Delete the passkey “${pk.name}”?`, body: "You can't log in with it afterwards.", verb: "Delete", danger: true })
    if (!ok) return
    setBusyId(pk.id)
    setListNotice(null)
    try {
      const out = await withRecentPassword(() => getApi().post("/passkeys/delete", { id: pk.id }))
      if (out) {
        setListNotice({ kind: "ok", text: DELETED })
        invalidate(SETTINGS_KEYS.passkeys)
      }
    } catch (err) {
      setListNotice({ kind: "error", text: errorMessage(err) })
    } finally { setBusyId(null) }
  }

  // ---- add ----
  const [webauthn, setWebauthn] = useState<boolean | null>(null)
  useEffect(() => { setWebauthn(typeof window !== "undefined" && typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential !== "undefined") }, [])
  const [pkName, setPkName] = useState(defaultName)
  const [adding, setAdding] = useState(false)
  const [addNotice, setAddNoticeState] = useState<NoticeValue | null>(null)
  const addNoticeRef = useRef(addNotice)
  const setAddNotice = (n: NoticeValue | null) => { addNoticeRef.current = n; setAddNoticeState(n) }
  const [addLockedUntil, setAddLockedUntil] = useState<number | null>(null)
  const addLeft = useCountdown(addLockedUntil)
  const popup = useRef<Window | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const resetAdd = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    popup.current = null
    setAdding(false)
  }

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!acceptPasskeyMessage(e, candyOrigin, popup.current)) return
      setAddNotice({ kind: "ok", text: "Passkey added." })
      invalidate(SETTINGS_KEYS.passkeys)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [candyOrigin])
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
    waiter.current?.(false)
    waiter.current = null
  }, [])

  const enroll = async (win: Window | null, retried: boolean): Promise<void> => {
    if (!candyHost) return
    setAddNotice({ kind: "wait", text: `Opening ${candyHost}…` })
    let out: EnrollStartResponse
    try {
      out = await getApi().post<EnrollStartResponse>("/passkeys/enroll/start", { name: pkName.trim() || "Passkey" })
    } catch (e) {
      closeWin(win)
      if (e instanceof ApiError && e.reauth && !retried) {
        setPam(null)
        setAddNotice(null)
        if (!(await askPassword())) { resetAdd(); return }
        return enroll(openPopup(), true)
      }
      resetAdd()
      if (e instanceof ApiError && typeof e.retryAfter === "number" && e.retryAfter > 0) setAddLockedUntil(Date.now() + e.retryAfter * 1000)
      setAddNotice({ kind: "error", text: errorMessage(e) })
      return
    }
    const target = checkEnrollUrl(out?.url, candyHost)
    if (!target) {
      closeWin(win)
      resetAdd()
      setAddNotice({ kind: "error", text: ENROLL_WRONG })
      return
    }
    if (!win || win.closed) {
      // The popup was blocked: go there in this tab (its page links back to /passkeys when done)
      location.assign(target)
      return
    }
    popup.current = win
    win.location.replace(target)
    setAddNotice({ kind: "wait", text: "Follow the steps in the candy window…" })
    if (timer.current) clearInterval(timer.current)
    timer.current = setInterval(() => {
      if (popup.current && popup.current.closed) {
        const waiting = addNoticeRef.current?.kind === "wait"
        resetAdd()
        if (waiting) setAddNotice(null)
        invalidate(SETTINGS_KEYS.passkeys)
      }
    }, 500)
  }

  const addLocked = addLockedUntil !== null && addLeft > 0
  const canAdd = !!candyHost && webauthn !== false && !offline
  const onAdd = () => {
    if (adding || !canAdd || addLocked) return
    setAdding(true)
    setAddNotice(null)
    // A stale password first: the Confirm press is then the gesture that opens the popup
    if (needsPassword(pam.current)) {
      void askPassword().then(ok => { if (!ok) resetAdd(); else void enroll(openPopup(), false) })
      return
    }
    void enroll(openPopup(), false)
  }

  const addHelp = !candyHost ? NEEDS_DOMAIN : webauthn === false ? NO_WEBAUTHN : `candy opens a small window on ${candyHost}, where your browser makes the passkey.`
  const shownAddNotice: NoticeValue | null = addNotice && addLocked && addNotice.kind === "error"
    ? { kind: "error", text: `${addNotice.text} Try again in ${addLeft}s.` } : addNotice

  const columns: Column<PasskeyView>[] = [
    {
      key: "name", label: "Name", render: pk => (
        <div className="settings-pk-name">
          {editing?.id === pk.id ? (
            <Input className="settings-rename" aria-label="Passkey name" maxLength={64} autoFocus value={editing.value}
              onFocus={e => e.currentTarget.select()}
              onChange={e => setEditing({ id: pk.id, value: e.target.value })}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); void finishRename(pk, true) }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void finishRename(pk, false) }
              }}
              onBlur={() => void finishRename(pk, true)} />
          ) : (
            <button type="button" className="settings-name-btn" title="Rename" disabled={busyId === pk.id || offline}
              onClick={() => setEditing({ id: pk.id, value: pk.name })}>{pk.name}</button>
          )}
          {!pk.here ? <span className="mono ink-2 settings-pk-rp">for {pk.rpId} (unusable)</span> : null}
        </div>
      ),
    },
    { key: "created", label: "Created", priority: 3, render: pk => <span className="nowrap" title={fmtWhen(pk.created)}>{fmtDay(pk.created)}</span> },
    { key: "used", label: "Last used", priority: 2, render: pk => (typeof pk.lastUsed === "number" ? <RelativeTime at={pk.lastUsed} /> : "never") },
    {
      key: "synced", label: "Synced", priority: 2, render: pk => pk.backedUp
        ? <span title="Backed up by your passkey provider">synced</span> : <span className="ink-3">—</span>,
    },
  ]

  return (
    <SettingsShell title="Passkeys">
      {!candyHost ? (
        <Banner kind="warn" action={<Link className="ui-btn ui-btn-secondary ui-btn-sm" to={session.superuser ? "/settings/daemon#zone" : "/public"}>Set up a domain</Link>}>
          {NO_DOMAIN}
        </Banner>
      ) : null}

      <Section id="passkeys" title="Your passkeys"
        description={<>Log in to the portal as <strong className="mono">{user}</strong> with a passkey instead of your password: Touch ID, Windows Hello, your phone or a security key.</>}>
        <Table label="Your passkeys" columns={columns} rows={passkeys} rowKey={pk => pk.id}
          loading={list.loading} error={list.error ? list.error.message : null} onRetry={() => void list.reload()}
          empty="No passkeys yet."
          actions={pk => (
            <Button size="sm" variant="danger" busy={busyId === pk.id} disabled={offline} onClick={() => void deletePasskey(pk)}>Delete</Button>
          )} />
        <Notice notice={listNotice} />
      </Section>

      {reauthOpen ? <ReauthPanel user={user} onDone={reauthDone} disabled={offline} /> : null}

      <Section id="add" title="Add a passkey">
        <div className="settings-sheet">
          <form className="settings-add" onSubmit={e => { e.preventDefault(); onAdd() }}>
            <Field label="Name" htmlFor="pk-name" help={addHelp}>
              <Input id="pk-name" maxLength={64} value={pkName} onChange={e => setPkName(e.target.value)} disabled={!candyHost} />
            </Field>
            <div className="settings-add-button">
              <Button variant="primary" type="submit" busy={adding} disabled={!canAdd || addLocked}>Add a passkey</Button>
            </div>
          </form>
          <Notice notice={shownAddNotice} />
        </div>
      </Section>
    </SettingsShell>
  )
}
