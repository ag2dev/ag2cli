export const SESSION_PERMISSION_MODES = ["manual", "accept-edits", "plan", "full-access", "auto"] as const
export type SessionPermissionMode = (typeof SESSION_PERMISSION_MODES)[number]

/** Non-throwing wire-boundary narrowing for a decoded permission mode
 * (durable fingerprints, protocol payloads); persisted values keep the
 * throwing {@link assertKnownPermissionMode} audit. */
export function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return typeof value === "string" && (SESSION_PERMISSION_MODES as readonly string[]).includes(value)
}

export const SESSION_PERMISSION_RULE_BEHAVIORS = ["allow", "ask", "deny"] as const
export type SessionPermissionRuleBehavior = (typeof SESSION_PERMISSION_RULE_BEHAVIORS)[number]

export interface SessionPermissionRule {
  readonly name: string
  readonly behavior: SessionPermissionRuleBehavior
}

export const DEFAULT_SESSION_PERMISSION_MODE: SessionPermissionMode = "manual"

/** Typed signal that persisted history is incompatible with the current
 * permission-policy contract (missing explicit SessionCreated policy fields,
 * ill-typed revision fields, an unknown permission mode, or an illegal bash
 * permission rule): replay throws it so listing surfaces can skip such
 * sessions while direct access reports the incompatibility. */
export class IncompatibleSessionEventError extends Error {
  constructor(message = "incompatible session event: SessionCreated predates explicit permission policy") {
    super(message)
    this.name = "IncompatibleSessionEventError"
  }
}

/** Runtime gate for persisted history: a SessionCreated recorded before the
 * explicit permission policy lacks its fields (or carries a retired mode).
 * The static types are already required; this checks what actually arrived. */
export function assertExplicitSessionCreatedPolicy(payload: {
  readonly permissionMode?: SessionPermissionMode
  readonly permissionRules?: readonly SessionPermissionRule[]
  readonly policyRevision?: number
  readonly scopeRevision?: number
}): void {
  if (
    payload.permissionMode === undefined ||
    payload.permissionRules === undefined ||
    payload.policyRevision === undefined ||
    !SESSION_PERMISSION_MODES.includes(payload.permissionMode)
  ) {
    throw new IncompatibleSessionEventError()
  }
  assertSessionRevisionField(payload.policyRevision, "SessionCreated.policyRevision")
  if (payload.scopeRevision !== undefined) {
    assertSessionRevisionField(payload.scopeRevision, "SessionCreated.scopeRevision")
  }
}

/** Fail-closed guard for revision fields read from raw JSONL history: the
 * replay path never passes the codec, so a missing or ill-typed field must
 * throw before any `<=` comparison (which would fail open on NaN). */
export function assertSessionRevisionField(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IncompatibleSessionEventError(`incompatible session event: ${field} must be a non-negative integer`)
  }
  return value
}

/** Replay-path gate shared by the snapshot projections and the canonical
 * invariant validator: a mode outside the live enum is incompatible
 * persisted history, never silent. Pre-unification sessions carrying the
 * retired "auto" never reach this gate — their SessionCreated predates the
 * explicit policy fields and {@link assertExplicitSessionCreatedPolicy}
 * rejects the replay first. */
export function assertKnownPermissionMode(mode: SessionPermissionMode): void {
  if (!SESSION_PERMISSION_MODES.includes(mode)) {
    throw new IncompatibleSessionEventError("incompatible session event: SessionPermissionModeSet carries an unknown permission mode")
  }
}

/** Upper bound for a NEW permission rule name at every ingest face. Enforced
 * by `assertSessionPermissionRuleNameBound` at command decode/use-case entry;
 * deliberately NOT inside `normalizeSessionPermissionRules`, which also runs
 * on the canonical replay path and must stay tolerant of names recorded by
 * older writers (event-sourced sessions are never rewritten). */
export const SESSION_PERMISSION_RULE_NAME_MAX = 128

export function assertSessionPermissionRuleNameBound(name: string): void {
  if (name.trim().length > SESSION_PERMISSION_RULE_NAME_MAX) {
    throw new Error(`permission rule name must be 1-${SESSION_PERMISSION_RULE_NAME_MAX} characters`)
  }
}

export function normalizeSessionPermissionRules(rules: readonly SessionPermissionRule[] | undefined): readonly SessionPermissionRule[] {
  const byName = new Map<string, SessionPermissionRuleBehavior>()
  for (const rule of rules ?? []) {
    const name = rule.name.trim()
    if (name.length === 0) throw new Error("permission rule name must not be empty")
    if (!SESSION_PERMISSION_RULE_BEHAVIORS.includes(rule.behavior)) {
      throw new Error(`unknown permission rule behavior: ${rule.behavior}`)
    }
    // Unlike the name-length bound above, the bash rule-class bound is
    // enforced on replay too: an honored Allow(bash) would silently grant
    // model Bash auto-approval, so persisted history may never carry it.
    if (name === "bash" && rule.behavior !== "deny") {
      throw new IncompatibleSessionEventError(
        "incompatible session event: only Deny(bash) is a legal bash permission rule in the first release",
      )
    }
    byName.set(name, rule.behavior)
  }
  return [...byName.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, behavior]) => ({ name, behavior }))
}
