/**
 * Canonical tool facts: execution results, pre-approval preparation, output streams, and wire definitions.
 *
 * Keep only pure data facts here; execution contracts (`Tool`/`ToolContext`) belong in ports,
 * and tool implementations belong in tools/ and adapters/.
 */

/**
 * Stable denial reason codes for the first release (ADR-UNIFIED-PERMISSION-POLICY-WITHOUT-SANDBOX-001
 * §2): all terminal tool results that did not execute, approval facts, and protocol projections share this closed set.
 * Adding codes outside this set is a breaking change.
 */
export const PERMISSION_DENIAL_CODES = [
  "stale_policy",
  "approval_required",
  "denied_by_rule",
  "plan_mode_rejected",
  "unknown_tool_or_input",
  "outside_workspace",
  "user_denied",
  "guardian_denied",
] as const

/** Stable denial codes crossing tool results, approvals and the protocol. */
export type PermissionDenialCode = (typeof PERMISSION_DENIAL_CODES)[number]

/**
 * Stable machine-readable guardian denial reasons. Rubric denials carry their
 * rule code; every review-seam failure (deadline, disconnect, unparsable
 * output, binding mismatch, missing context) converges on `review-unavailable`.
 * Humans read the bounded display `reason`; machines judge on the code. Adding
 * a code outside this closure is a breaking change.
 */
export const GUARDIAN_DENIAL_REASON_CODES = [
  "unsafe-action",
  "out-of-scope",
  "goal-mismatch",
  "insufficient-context",
  "review-unavailable",
] as const

/** Stable guardian denial reason; display text travels separately. */
export type GuardianDenialReasonCode = (typeof GUARDIAN_DENIAL_REASON_CODES)[number]

/**
 * Canonical bound on guardian display text (verdict reasons and durable
 * attribution blocks); every seam validates against this one constant.
 */
export const MAX_GUARDIAN_REASON_LENGTH = 4_096

/** Canonical bound on the guardian identity string (id and verdict stamps). */
export const MAX_GUARDIAN_ID_LENGTH = 128

/**
 * Effect classes over the closed model-tool set. Permission judgment and the
 * guardian review request share this vocabulary; it lives with the other
 * tool vocabularies so guardian-independent code never depends on the
 * guardian port.
 */
export type ModelToolEffect = "read" | "structured-write" | "session-internal" | "interaction" | "bash" | "network" | "delegation"

/**
 * Preparation-time security facts feeding the permission judgment. Producers
 * live in the CLI security layer; the judgment consumes them to exempt
 * plan-capped read-only shapes and to mint allows that never consult the
 * approval surface. Facts only ever widen what a mode default admits — deny
 * rules and explicit ask rules always win first. Adding a kind outside this
 * closure is a breaking change.
 */
export const PREPARED_SECURITY_FACT_KINDS = ["bash-read-only-template", "scratch-write", "dangerous-write"] as const

/** Kind closure of {@link PreparedSecurityFact}. */
export type PreparedSecurityFactKind = (typeof PREPARED_SECURITY_FACT_KINDS)[number]

export type PreparedSecurityFact =
  /** Read-only Bash template: argv0 whitelist + metacharacter + argument screens passed. */
  | { readonly kind: "bash-read-only-template" }
  /** Write target inside the session's scratch zone. */
  | { readonly kind: "scratch-write" }
  /** Write target inside workspace/add-dir scope that hits the dangerous list. */
  | { readonly kind: "dangerous-write" }

/**
 * Wire-boundary narrowing shared by the codec, the canonical invariants and
 * the Bash execution contract. Tolerates unknown sibling fields (the codec
 * reconstructs only the kind), rejects every unknown kind.
 */
export function isPreparedSecurityFact(value: unknown): value is PreparedSecurityFact {
  if (typeof value !== "object" || value === null) return false
  const kind = (value as { readonly kind?: unknown }).kind
  return typeof kind === "string" && (PREPARED_SECURITY_FACT_KINDS as readonly string[]).includes(kind)
}

/**
 * Structured denial fact: a machine-readable reason for a terminal result.
 * Omitted means no denial information (legacy events and non-terminal results); when present, it must include a valid `code`.
 */
export type ToolResultDenial = {
  readonly code: PermissionDenialCode
  readonly reason?: string
}

/** Tool execution result. */
export type ToolResult = {
  /** Text content returned to the model. */
  content: string
  /** Set to true on error; the model sees this as is_error. */
  isError?: boolean
  /** Safe machine-readable links to nested execution, never user/model text. */
  metadata?: Readonly<Record<string, string>>
  /**
   * Presentation-channel data: a structured patch for changes actually applied by file_edit/write_file.
   * This is data only and never enters the model view (provider assembly and compaction read only content;
   * see ADR-TOOL-DIFF-DISPLAY-001).
   */
  appliedPatch?: StructuredPatch
  /**
   * Structured reason for a terminal denial (presentation/projection channel; like appliedPatch, it never enters the model view).
   * Every new terminal result that did not execute must include it, except for advisory results on a plain reuse miss.
   */
  readonly denial?: ToolResultDenial
}

/** Line kind in a structured patch. */
export type PatchLineKind = "context" | "added" | "removed"

/** One structured patch line; text preserves the original line ending (CRLF is not normalized). */
export type PatchLine = {
  readonly kind: PatchLineKind
  readonly text: string
}

/** A hunk with 1-based absolute line numbers; a zero-line side follows Git convention (the line before the insertion point, or 0 at file start). */
export type PatchHunk = {
  readonly oldStart: number
  readonly newStart: number
  readonly oldLines: number
  readonly newLines: number
  readonly lines: readonly PatchLine[]
}

/**
 * Structured patch for changes applied by a tool (presentation-channel data that never enters ToolResult.content;
 * see ADR-TOOL-DIFF-DISPLAY-001). Producers set truncated when a size limit is reached.
 */
export type StructuredPatch = {
  readonly hunks: readonly PatchHunk[]
  /** Total number of added lines. */
  readonly addedLines: number
  /** Total number of removed lines. */
  readonly removedLines: number
  /** Number of change clusters (maximal contiguous add/remove runs), corresponding to replace_all replacement sites. */
  readonly sites: number
  /** Set when the patch is truncated because it exceeds the size limit. */
  readonly truncated?: boolean
}

/** Canonical side-effect-free preparation fact recorded before approval. */
export type ToolPreparation = {
  readonly status: "ready" | "invalid" | "blocked" | "denied" | "reused"
  readonly decision: "allow" | "ask" | "deny"
  readonly preparedInput?: unknown
  readonly reasons: readonly string[]
  readonly analyzerVersion: string
  readonly policyVersion: string
  readonly approvalFingerprint?: string
  /** Canonical cwd used by path analysis and the executing process. */
  readonly cwd?: string
  /** Security projection captured when this preparation was created. */
  readonly scopeRevision?: number
  readonly scopeDigest?: string
  readonly policyRevision?: number
  /**
   * Structured denial reason: a stable code the producer can determine during preparation
   * (for example, `outside_workspace` for a cwd outside the allowed roots). When omitted, execution derives a default code from status.
   */
  readonly denial?: ToolResultDenial
  /**
   * Producer-declared security fact (read-only Bash template, scratch write,
   * dangerous write). Durable so a resumed turn re-judges on the fact the
   * live turn prepared; absent on reused display-only preparations.
   */
  readonly securityFact?: PreparedSecurityFact
}

/** Interaction owned by a tool rather than by the permission system. */
export type ToolInteraction = "none" | "question"

/** Static/runtime facts needed before an executor chooses an interaction path. */
export interface ToolExecutionMetadata {
  readonly interaction: ToolInteraction
  readonly isReadOnly: boolean
  /**
   * Whether a call with this input may run in parallel with its same-turn
   * siblings. Conservative default: false (strictly serial turn execution).
   */
  readonly concurrencySafe: boolean
}

/** A live, non-persistent chunk produced by a long-running tool. */
export type ToolOutputChunk = {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

export type ToolOutputSink = (chunk: ToolOutputChunk) => void

/** JSON Schema shape for tool input. */
export interface ToolInputSchema {
  type: "object"
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

/**
 * Convert a tool definition to the JSON Schema used by the model API.
 */
export type ApiToolDefinition = {
  name: string
  description: string
  input_schema: ToolInputSchema
}
