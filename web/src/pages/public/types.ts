// Answers of the endpoints only the Public domains pages call (04 §5). DomainsResponse, DomainBinding, BindOk and
// BindWarning are shared and live in api/types.ts.

/** DELETE /domains/unbind/:subdomain */
export interface UnbindResponse { message: string; subdomain: string; fqdn: string }

/** POST /domains/allowlist */
export interface AllowlistResponse { success: true; allowlist: { enabled: boolean; ips: string[] }; message: string }

/** POST /auth/set ({password} or {jwtSecret: "generate"}); jwtSecret only when one was generated */
export interface AuthSetResponse { success: true; message: string; jwtSecret?: string }

/** POST /auth/clear */
export interface AuthClearResponse { success: true; message: string }
export type ClearWhich = "password" | "jwt" | "all"

/** POST /auth/token */
export interface AuthTokenResponse { token: string; claims: Record<string, unknown> }

/** What a page hands the next one through history state (a one-time status line). */
export interface FlashState { flash?: string }
