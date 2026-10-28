/**
 * Stable, machine-readable App Server error codes shared by the RPC host,
 * `@ag2cli/app-server-client` and the Web client.
 *
 * The catalog is closed: exactly these codes exist on the v1 wire. Values
 * such as the legacy `approval_already_resolved` (renamed to
 * `interaction_already_resolved`) are no longer part of the catalog type;
 * call sites that still emit or compare legacy literals migrate with their
 * method groups. Retryability and typed details live in `dto/errors.js`.
 */
export const APP_SERVER_ERROR_CODES = [
  // request validation and protocol framing
  "invalid_params",
  "invalid_result",
  "method_not_found",
  "protocol_version_mismatch",
  "invalid_intent",
  "scope_denied",
  // session and run state
  "session_not_found",
  "run_not_active",
  // CAS, reservations and idempotency
  "revision_conflict",
  "revision_ahead",
  "policy_revision_conflict",
  "reservation_conflict",
  "command_idempotency_conflict",
  // interactions and approvals
  "interaction_already_resolved",
  "stale_approval",
  "interaction_expired",
  "unsupported_event",
  // capabilities
  "capability_unavailable",
  "capability_denied",
  // workspace
  "workspace_access_denied",
  "workspace_unavailable",
  "workspace_path_denied",
  "workspace_changed",
  // interaction leases
  "interaction_lease_required",
  "interaction_lease_scope_mismatch",
  "interaction_lease_held",
  "interaction_lease_stale",
  "interaction_scope_unclassified",
  "interaction_unavailable",
  "invalid_lease_ttl",
  // connection and host
  "connection_not_registered",
  "invalid_host_result",
] as const

export type AppServerErrorCode = (typeof APP_SERVER_ERROR_CODES)[number]

export function isAppServerErrorCode(value: unknown): value is AppServerErrorCode {
  return typeof value === "string" && (APP_SERVER_ERROR_CODES as readonly string[]).includes(value)
}
