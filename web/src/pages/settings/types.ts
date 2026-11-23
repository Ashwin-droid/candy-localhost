// Answers of the endpoints only the Settings pages call (SPEC §7.3, shapes from 04).
// PasskeyView, AppAuthSite, AppAuthConsent, PublicMcpStatus and AdguardStatus live in api/types.ts.

import type { AppAuthConsent, AppAuthSite, PasskeyView } from "../../api/types.ts"

/** GET /passkeys/list */
export interface PasskeyListResponse { passkeys: PasskeyView[] }
/** POST /passkeys/enroll/start */
export interface EnrollStartResponse { url: string; origin: string }
/** POST /passkeys/rename */
export interface PasskeyRenameResponse { passkey: PasskeyView }
/** POST /passkeys/delete */
export interface PasskeyDeleteResponse { deleted: true }
/** POST /auth/reauth */
export interface ReauthResponse { pamUntil: number }

/** GET /app-auth/sites */
export interface AppAuthSitesResponse { sites: AppAuthSite[] }
/** POST /app-auth/rotate */
export interface AppAuthRotateResponse { site: string; kid: string; restartNeeded: string[] }
/** POST /app-auth/drop */
export interface AppAuthDropResponse { site: string; revoked: true; approvals: number; restartNeeded: string[]; enabled: boolean }
/** GET /app-auth/consents */
export interface AppAuthConsentsResponse { consents: AppAuthConsent[] }
/** POST /app-auth/consents/revoke */
export interface ConsentRevokeResponse { revoked: boolean }

/** POST /domains/config body (same shape as `candy domain config`) */
export interface DomainConfigBody {
  zone?: { domain: string; id: string }
  tunnel?: { name: string; id: string; credentialsFile: string }
}
/** POST /domains/config */
export interface DomainConfigResponse { message?: string; zone?: { id: string; domain: string }; tunnel?: { id: string; name: string } }

/** POST /lan/adguard body (link or save); `{ remove: true }` unlinks */
export interface AdguardBody { url: string; username: string; password?: string; client: string; dnsTarget?: string }

/** The cache keys these pages own (SPEC §7.4: on mount + invalidate). */
export const SETTINGS_KEYS = {
  passkeys: "passkeys",
  appAuthSites: "appauth/sites",
  appAuthConsents: "appauth/consents",
  mcp: "mcp",
  adguard: "adguard",
} as const
