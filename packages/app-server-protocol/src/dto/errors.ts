import { z } from "zod"
import { APP_SERVER_ERROR_CODES, type AppServerErrorCode } from "../error-codes.js"
import { publicInteractionResolutionSchema, type PublicInteractionResolution } from "./interactions.js"
import { nonEmptyStringSchema, nonNegativeIntegerSchema } from "./primitives.js"

// Typed error payloads for `JsonRpcError.data = { code, retryable, details }`.
// `details` is the protocol's JsonValue extension slot; codes without a
// structured details shape map to `undefined`.

/** `run_not_active`: the run a steer targeted is not running. `status`
 * carries the run's terminal state so clients can fall back to submitting a
 * fresh prompt; "unknown" covers runs that no longer exist. */
export interface RunNotActiveErrorDetails {
  runId: string
  status: "completed" | "failed" | "cancelled" | "unknown"
}

/** `policy_revision_conflict`: carries the current revision so the client
 * can rebase and retry the policy write. */
export interface PolicyRevisionConflictErrorDetails {
  currentPolicyRevision: number
}

/** `interaction_already_resolved`: a late competing resolution receives the
 * canonical first-writer-wins result. */
export type InteractionAlreadyResolvedErrorDetails = PublicInteractionResolution

type CodeWithDetails = "run_not_active" | "policy_revision_conflict" | "interaction_already_resolved"

export type AppServerErrorDetailsByCode = {
  [C in CodeWithDetails]: C extends "run_not_active"
    ? RunNotActiveErrorDetails
    : C extends "policy_revision_conflict"
      ? PolicyRevisionConflictErrorDetails
      : InteractionAlreadyResolvedErrorDetails
} & { [C in Exclude<AppServerErrorCode, CodeWithDetails>]?: undefined }

export const appServerErrorDetailsSchemaByCode: {
  [C in AppServerErrorCode]?: z.ZodType<AppServerErrorDetailsByCode[C]>
} = {
  run_not_active: z.object({
    runId: nonEmptyStringSchema("details.runId"),
    status: z.enum(["completed", "failed", "cancelled", "unknown"]),
  }),
  policy_revision_conflict: z.object({
    currentPolicyRevision: nonNegativeIntegerSchema("details.currentPolicyRevision"),
  }),
  interaction_already_resolved: publicInteractionResolutionSchema,
}

// Initial retryability ruling: only conditions where retrying the same
// request can succeed without semantic change (transient availability or
// contention, or re-registration after a connection reset) are retryable.
// Call sites refine these values as their method groups migrate.
export const APP_SERVER_ERROR_RETRYABLE: Readonly<Record<AppServerErrorCode, boolean>> = {
  invalid_params: false,
  invalid_result: false,
  method_not_found: false,
  protocol_version_mismatch: false,
  invalid_intent: false,
  scope_denied: false,
  session_not_found: false,
  run_not_active: false,
  revision_conflict: false,
  revision_ahead: false,
  policy_revision_conflict: false,
  reservation_conflict: true,
  command_idempotency_conflict: false,
  interaction_already_resolved: false,
  stale_approval: false,
  interaction_expired: false,
  unsupported_event: false,
  capability_unavailable: false,
  capability_denied: false,
  workspace_access_denied: false,
  workspace_unavailable: true,
  workspace_path_denied: false,
  workspace_changed: false,
  interaction_lease_required: false,
  interaction_lease_scope_mismatch: false,
  interaction_lease_held: false,
  interaction_lease_stale: false,
  interaction_scope_unclassified: false,
  interaction_unavailable: false,
  invalid_lease_ttl: false,
  connection_not_registered: true,
  invalid_host_result: false,
}

export const appServerErrorDataSchema = z.object({
  code: z.enum(APP_SERVER_ERROR_CODES),
  retryable: z.boolean(),
  details: z.unknown().optional(),
})
export type AppServerErrorData = z.infer<typeof appServerErrorDataSchema>
