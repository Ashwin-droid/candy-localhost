// Add site (SPEC §5.2): the only form modal. Three kinds (an existing port, a command, a function), inline
// validation with the old dashboard's messages, server errors at the top, and on success the new site's page.

import type React from "react"
import { useState } from "react"
import { getApi } from "../../api/client.ts"
import { invalidate, useResource } from "../../api/resources.ts"
import { KEYS } from "../../api/sites.ts"
import type { FnAddResponse, UsersResponse } from "../../api/types.ts"
import { isReservedName } from "../../lib/site.ts"
import { checkAbsPath, checkName, checkPort, checkWhole } from "../../lib/validate.ts"
import { navigate } from "../../router.tsx"
import { useSession } from "../../session.tsx"
import { Banner, Button, Dialog, Field, Input, Listbox, toast, type ListboxOption } from "../../ui/index.ts"
import type { AddConfigResponse, RegisterResponse } from "../sites/types.ts"
import "../sites/add-site.css"

export type AddMode = "port" | "cmd" | "fn"

export interface AddSiteState { addWarnings?: string[]; addNote?: string }

const KINDS: { value: AddMode; label: string; help: string }[] = [
  { value: "port", label: "Existing port", help: "Something is already listening on this machine." },
  { value: "cmd", label: "Command", help: "candy starts it the first time it's opened." },
  { value: "fn", label: "Function", help: "A Workers-style module or a static folder. No port." },
]

const PRESETS = ["npm run dev", "bun dev", "pnpm dev", "yarn dev"]

export const FN_NOTES = {
  static: "The daemon serves its files; no process starts.",
  noUrl: "Its candy.json handlers leave out http, so it gets no URL: cron and events run it.",
  onRequest: "It starts on the first request.",
} as const

/** The explanation sentence of a /fn/add answer (01 §7.3). */
export function fnAddNote(res: Pick<FnAddResponse, "url" | "fn">): string {
  if (res.fn && res.fn.hasWorker === false) return FN_NOTES.static
  if (res.url === null) return FN_NOTES.noUrl
  return FN_NOTES.onRequest
}

export interface AddForm {
  mode: AddMode; name: string; port: string; persistent: boolean
  cwd: string; cmd: string; api: boolean; user: string | null
  entry: string; hot: string; max: string; linger: string; envFile: string
}

export type AddErrors = Partial<Record<"name" | "port" | "cwd" | "cmd" | "hot" | "max" | "linger" | "envFile", string>>

export const RESERVED_NAME = "That name belongs to candy itself. Pick another one."

/** Client validation (01 §7.3 messages). Returns only the fields with a problem. */
export function validateAdd(f: AddForm): AddErrors {
  const e: AddErrors = {}
  const name = checkName(f.name)
  if (name) e.name = name
  else if (isReservedName(f.name.trim())) e.name = RESERVED_NAME
  if (f.mode === "port") {
    const p = checkPort(f.port)
    if (p) e.port = p
  } else if (f.mode === "cmd") {
    if (!f.cwd.trim()) e.cwd = "Enter the project folder"
    if (!f.cmd.trim()) e.cmd = "Enter the start command"
  } else {
    if (!f.cwd.trim()) e.cwd = "Enter the folder"
    const hot = checkWhole(f.hot, "Hot", 0)
    const max = checkWhole(f.max, "Max", 1)
    let linger = checkWhole(f.linger, "Linger", 0)
    if (!linger && f.linger.trim() && Number(f.linger) > 600) linger = "Linger must be 0 to 600 seconds"
    if (hot) e.hot = hot
    if (max) e.max = max
    if (linger) e.linger = linger
    if (!hot && !max && f.hot.trim() && f.max.trim() && Number(f.hot) > Number(f.max)) e.hot = "Hot can't be more than max"
    const env = checkAbsPath(f.envFile, "env file")
    if (env) e.envFile = env
  }
  return e
}

/** The request each kind sends. `user` only when Run as is shown. */
export function addRequest(f: AddForm, withUser: boolean): { path: "/register" | "/config" | "/fn/add"; body: Record<string, unknown> } {
  const name = f.name.trim().toLowerCase()
  if (f.mode === "port") return { path: "/register", body: { name, port: Number(f.port.trim()), persistent: f.persistent } }
  const user = withUser && f.user ? { user: f.user } : {}
  if (f.mode === "cmd") {
    return { path: "/config", body: { name, cwd: f.cwd.trim(), cmd: f.cmd.trim(), ...user, ...(f.api ? { api: true } : {}) } }
  }
  const num = (v: string) => (v.trim() === "" ? {} : { v: Number(v.trim()) })
  const body: Record<string, unknown> = { name, cwd: f.cwd.trim(), ...user }
  if (f.entry.trim()) body.entry = f.entry.trim()
  for (const k of ["hot", "max", "linger"] as const) { const n = num(f[k]); if ("v" in n) body[k] = n.v }
  if (f.envFile.trim()) body.envFile = f.envFile.trim()
  return { path: "/fn/add", body }
}

const FALLBACK: Record<AddMode, string> = { port: "Failed to add route", cmd: "Failed to add config", fn: "Could not add the function" }

export function AddSiteDialog(p: { open: boolean; onClose: () => void; initialName?: string | null; mode?: AddMode }): React.JSX.Element | null {
  if (!p.open) return null
  return <AddSiteForm onClose={p.onClose} initialName={p.initialName ?? null} mode={p.mode ?? "port"} />
}

function AddSiteForm(p: { onClose: () => void; initialName: string | null; mode: AddMode }): React.JSX.Element {
  const session = useSession()
  const [f, setF] = useState<AddForm>({
    mode: p.mode, name: p.initialName ?? "", port: "", persistent: false, cwd: "", cmd: "", api: false, user: null,
    entry: "", hot: "", max: "", linger: "", envFile: "",
  })
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const set = <K extends keyof AddForm>(k: K, v: AddForm[K]) => setF(x => ({ ...x, [k]: v }))

  // Everyone reads /users: a non-superuser gets only themselves (no Run as), which still gives the ~ hint
  const users = useResource<UsersResponse>(KEYS.users,
    signal => getApi().get<UsersResponse>("/users", undefined, { signal }))
  const u = users.error ? undefined : users.data
  const runAs = session.superuser && !!u && u.multiUser && u.users.length > 1
  const defaultUser = u ? (u.users.find(x => x.name === u.owner)?.name ?? u.users[0]?.name ?? null) : null
  const user = f.user ?? defaultUser
  const home = u?.users.find(x => x.name === (runAs ? user : session.user))?.home
  const homeHint = home ? `~ is ${runAs ? user : session.user}'s home, ${home}.` : null
  const userOptions: ListboxOption[] = (u?.users ?? []).map(x => ({
    value: x.name, label: x.name, detail: x.home + (x.name === u?.owner ? " · owner" : ""),
  }))

  const errors = tried ? validateAdd({ ...f, user }) : {}
  const tld = session.tld

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTried(true)
    const form = { ...f, user }
    if (Object.keys(validateAdd(form)).length) return
    const req = addRequest(form, runAs)
    const name = String(req.body.name)
    setBusy(true)
    setServerError(null)
    try {
      let state: AddSiteState | undefined
      if (req.path === "/register") {
        await getApi().post<RegisterResponse>("/register", req.body)
      } else if (req.path === "/config") {
        await getApi().post<AddConfigResponse>("/config", req.body)
      } else {
        const res = await getApi().post<FnAddResponse>("/fn/add", req.body, { lane: "long" })
        state = { addWarnings: Array.isArray(res.warnings) ? res.warnings : [], addNote: fnAddNote(res) }
      }
      invalidate([KEYS.sites])
      const added = name
      p.onClose()
      toast(`Added ${added}.${tld}`, "success")
      navigate("/sites/" + encodeURIComponent(added), state ? { state } : undefined)
    } catch (err) {
      setServerError(err instanceof Error && err.message ? err.message : FALLBACK[f.mode])
      setBusy(false)
    }
  }

  const userField = runAs ? (
    <Field label="Run as" help="The command runs with this user's permissions. Root isn't an option.">
      <Listbox id="add-user" label="Run as" options={userOptions} value={user} onChange={v => set("user", v)}
        emptyText="Nobody is in the candy group yet." />
    </Field>
  ) : null

  return (
    <Dialog open title="Add a site" onClose={p.onClose} width={520}
      footer={<>
        <Button onClick={p.onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="add-site-form" busy={busy}>Add site</Button>
      </>}>
      <form id="add-site-form" className="add-site" onSubmit={submit} noValidate>
        {serverError ? <Banner kind="error">{serverError}</Banner> : null}

        <fieldset className="add-kinds">
          <legend className="sr-only">Kind of site</legend>
          {KINDS.map(k => (
            <label key={k.value} className={f.mode === k.value ? "add-kind is-on" : "add-kind"}>
              <input type="radio" name="add-kind" value={k.value} checked={f.mode === k.value}
                onChange={() => { set("mode", k.value); setServerError(null) }} />
              <span className="add-kind-text">
                <span className="add-kind-label">{k.label}</span>
                <span className="add-kind-help">{k.help}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="fields">
          <Field label="Name" htmlFor="add-name" error={errors.name}>
            <Input id="add-name" value={f.name} onChange={e => set("name", e.target.value)} suffix={`.${tld}`} mono
              pattern="[a-zA-Z0-9-]+" autoComplete="off" spellCheck={false} placeholder="myapp" invalid={!!errors.name}
              data-autofocus={!(p.initialName && f.mode === "port") ? true : undefined} />
          </Field>

          {f.mode === "port" ? (
            <>
              <Field label="Port" htmlFor="add-port" error={errors.port} help="Something already listening on this machine.">
                <Input id="add-port" type="number" min={1} max={65535} inputMode="numeric" mono value={f.port}
                  onChange={e => set("port", e.target.value)} placeholder="3000" invalid={!!errors.port}
                  data-autofocus={p.initialName ? true : undefined} />
              </Field>
              <label className="add-check">
                <input type="checkbox" checked={f.persistent} onChange={e => set("persistent", e.target.checked)} />
                <span>Keep this route when the daemon restarts</span>
              </label>
            </>
          ) : null}

          {f.mode === "cmd" ? (
            <>
              {userField}
              <Field label="Project folder" htmlFor="add-cwd" error={errors.cwd} help={homeHint}>
                <Input id="add-cwd" mono value={f.cwd} onChange={e => set("cwd", e.target.value)} placeholder="~/projects/myapp"
                  autoComplete="off" spellCheck={false} invalid={!!errors.cwd} />
              </Field>
              <Field label="Start command" htmlFor="add-cmd" error={errors.cmd}
                help="candy starts it the first time the site is opened and finds the port from its output.">
                <Input id="add-cmd" mono value={f.cmd} onChange={e => set("cmd", e.target.value)} placeholder="npm run dev"
                  autoComplete="off" spellCheck={false} invalid={!!errors.cmd} />
              </Field>
              <div className="add-presets" role="group" aria-label="Common start commands">
                {PRESETS.map(c => (
                  <Button key={c} variant="quiet" size="sm" className="mono" aria-pressed={f.cmd === c} onClick={() => set("cmd", c)}>{c}</Button>
                ))}
              </div>
              <details className="add-more">
                <summary>More options</summary>
                <div className="add-more-body">
                  <label className="add-check">
                    <input type="checkbox" checked={f.api} onChange={e => set("api", e.target.checked)} />
                    <span>API mode: the first request waits while it starts, no loading page</span>
                  </label>
                </div>
              </details>
            </>
          ) : null}

          {f.mode === "fn" ? (
            <>
              {userField}
              <Field label="Folder" htmlFor="add-fn-cwd" error={errors.cwd}
                help={<>The folder with its candy.json. The code ("main"), static files ("assets"), KV, D1 and cron jobs are read from there.{homeHint ? <> {homeHint}</> : null}</>}>
                <Input id="add-fn-cwd" mono value={f.cwd} onChange={e => set("cwd", e.target.value)} placeholder="~/projects/myfn"
                  autoComplete="off" spellCheck={false} invalid={!!errors.cwd} />
              </Field>
              <details className="add-more" open={!!(errors.hot || errors.max || errors.linger || errors.envFile) || undefined}>
                <summary>More options</summary>
                <div className="add-more-body fields">
                  <Field label="Code file" htmlFor="add-entry" help={`Only if candy.json has no "main", or to run a different file.`}>
                    <Input id="add-entry" mono value={f.entry} onChange={e => set("entry", e.target.value)} placeholder="src/index.ts"
                      autoComplete="off" spellCheck={false} />
                  </Field>
                  <div className="add-scaling">
                    <div className="fields-3">
                      <Field label="Hot" htmlFor="add-hot" error={errors.hot}>
                        <Input id="add-hot" type="number" min={0} inputMode="numeric" mono value={f.hot} placeholder="0"
                          onChange={e => set("hot", e.target.value)} invalid={!!errors.hot} />
                      </Field>
                      <Field label="Max" htmlFor="add-max" error={errors.max}>
                        <Input id="add-max" type="number" min={1} inputMode="numeric" mono value={f.max} placeholder="4"
                          onChange={e => set("max", e.target.value)} invalid={!!errors.max} />
                      </Field>
                      <Field label="Linger" htmlFor="add-linger" error={errors.linger}>
                        <Input id="add-linger" type="number" min={0} max={600} inputMode="numeric" mono value={f.linger} placeholder="30"
                          suffix="s" onChange={e => set("linger", e.target.value)} invalid={!!errors.linger} />
                      </Field>
                    </div>
                    <p className="help">Hot instances stay warm. Max caps how many run at once. Linger is how long an idle one waits before it exits. Empty uses the usual value.</p>
                  </div>
                  <Field label="Env file" htmlFor="add-env" error={errors.envFile}
                    help="A KEY=VALUE file whose values the function gets as its environment. Use the full path.">
                    <Input id="add-env" mono value={f.envFile} onChange={e => set("envFile", e.target.value)} placeholder="/home/me/app/.env"
                      autoComplete="off" spellCheck={false} invalid={!!errors.envFile} />
                  </Field>
                </div>
              </details>
            </>
          ) : null}
        </div>
      </form>
    </Dialog>
  )
}
