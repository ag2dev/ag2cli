/**
 * Stable, machine-readable App Server error codes shared by the RPC host,
 * `@ag2cli/app-server-client` and the Web client.
 *
 * Scope: this catalog currently only covers the interaction-lease, approval
 * and command-idempotency error families touched by the App Server
 * finalization work. Other existing error kinds (e.g. `session_not_found`,
 * `scope_denied`, `method_not_found`) remain locally defined at their call
 * sites until the phase that owns them migrates them here; this file is
 * additive, not a one-shot migration of every error code in the codebase.
 */
export const APP_SERVER_ERROR_CODES = [
  // interaction lease (Phase 1)
  "interaction_lease_required",
  "interaction_lease_scope_mismatch",
  "interaction_lease_held",
  "interaction_lease_stale",
  "interaction_scope_unclassified",
  "interaction_unavailable",
  "invalid_lease_ttl",
  "connection_not_registered",
  // approval (Phase 4A)
  "stale_approval",
  "approval_already_resolved",
  // command idempotency (Phase 2)
  "command_idempotency_conflict",
  "reservation_conflict",
  "workspace_access_denied",
  "workspace_unavailable",
  "capability_denied",
] as const

export type AppServerErrorCode = (typeof APP_SERVER_ERROR_CODES)[number]

export function isAppServerErrorCode(value: unknown): value is AppServerErrorCode {
  return typeof value === "string" && (APP_SERVER_ERROR_CODES as readonly string[]).includes(value)
}
