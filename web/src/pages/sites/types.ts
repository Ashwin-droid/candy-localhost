// Response types of the endpoints only package B calls (SPEC §7.3: B types /register, /config (add), /fn/add).
// Shapes from 04 §2-3. FnAddResponse is already in api/types.ts and is used from there.

import type { DeployInfo } from "../../api/types.ts"

/** POST /register {name, port, persistent} */
export interface RegisterResponse { success?: boolean; message?: string; name?: string; port?: number; url?: string }

/** POST /config {name, cwd, cmd, user?, api?} */
export interface AddConfigResponse {
  success: true
  config: { id: string; cwd: string; cmd: string; user?: string; api?: boolean }
  message?: string
}

/** POST /fn/deploy {name} (the site header's Deploy button) */
export interface DeployResponse { success: true; deploy: DeployInfo }

/** POST /process/stop/:name for a function answers like start does; a server answers StopResponse. */
export interface StopAnswer { success?: boolean; alsoStopped?: string[]; message?: string }
