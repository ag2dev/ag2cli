import type { SessionPermissionMode, SessionPermissionRule } from "@ag2cli/core/session/session-security.js"
import { DEFAULT_SESSION_PERMISSION_MODE } from "@ag2cli/core/session/session-security.js"
import type { ModelToolEffect, PermissionDenialCode, PreparedSecurityFact } from "@ag2cli/core/tool-facts.js"

export type { ModelToolEffect }

/**
 * Policy knowledge: canonical names classify through this closed table.
 * Unlisted names never classify — in particular never as read — so they
 * fail closed at judgment step 1. A Map keeps Object.prototype members
 * ("toString", "constructor", …) unclassified instead of resolving as
 * inherited effects.
 */
const EFFECT_BY_NAME = new Map<string, ModelToolEffect>([
  ["read_file", "read"],
  ["glob", "read"],
  ["grep", "read"],
  ["write_file", "structured-write"],
  ["file_edit", "structured-write"],
  ["todo_write", "session-internal"],
  ["skill", "session-internal"],
  ["session_history", "session-internal"],
  ["ask_user", "interaction"],
  ["bash", "bash"],
  ["web_fetch", "network"],
  ["agent", "delegation"],
  ["agent_join", "session-internal"],
])

/**
 * Stable denial codes crossing tool results, approvals and the protocol.
 * The closure is owned by core (`PERMISSION_DENIAL_CODES`); runtime only
 * aliases it so judgments and executor settlements cannot drift apart.
 */
export type { PermissionDenialCode }

/**
 * Preparation-time security facts, same aliasing discipline: the closure is
 * owned by core; the judgment input and both executor chains (model loop and
 * user shell) share this one type so a fact cannot drift between them.
 */
export type { PreparedSecurityFact }

/**
 * Interactive surfaces available to the executing composition. A headless
 * run carries none: an ask without its surface is terminal, never a hang.
 */
export interface PermissionSurfaces {
  readonly approvalSurface: boolean
  readonly interactionSurface: boolean
}

/**
 * The policy slice one judgment needs. A missing mode falls back to the
 * canonical default (manual); the revision drives staleness only when both
 * sides of the comparison are known.
 */
export interface PermissionPolicySnapshot {
  readonly permissionMode?: SessionPermissionMode
  readonly permissionRules?: readonly SessionPermissionRule[]
  readonly policyRevision?: number
}

export type PermissionJudgment =
  | { readonly decision: "allow" }
  | { readonly decision: "ask" }
  | { readonly decision: "deny"; readonly code: PermissionDenialCode; readonly terminal?: boolean }

export interface ModelToolJudgmentInput {
  readonly name: string
  /**
   * False when canonical preparation already failed validation. Required so
   * the executor wiring cannot silently regress; name-only callers
   * (projection) pass true — no preparation has failed at their layer.
   */
  readonly inputValid: boolean
  /** Policy revision the preparation was bound to; undefined skips the check. */
  readonly preparedAtPolicyRevision?: number
  /**
   * Producer-declared security fact adopted from the durable preparation.
   * A fact only ever widens what a mode default admits: deny rules, explicit
   * ask rules, staleness and the unknown-name gate all still win first.
   */
  readonly securityFact?: PreparedSecurityFact
}

function deny(code: PermissionDenialCode, terminal = false): PermissionJudgment {
  return terminal ? { decision: "deny", code, terminal: true } : { decision: "deny", code }
}

/** Effect classification shared with the guardian review request. */
export function modelToolEffectOf(name: string): ModelToolEffect | undefined {
  return EFFECT_BY_NAME.get(name)
}

/**
 * A fact only applies to the effect class its producer classified: the Bash
 * template to `bash`, the write facts to `structured-write`. A mismatched
 * pairing (a misrouted or tampered fact) is inert, so it can never widen a
 * different tool's admission.
 */
function factForEffect(fact: PreparedSecurityFact | undefined, effect: ModelToolEffect): PreparedSecurityFact | undefined {
  if (fact?.kind === "bash-read-only-template") return effect === "bash" ? fact : undefined
  if (fact !== undefined) return effect === "structured-write" ? fact : undefined
  return undefined
}

/**
 * The single judgment total order for model tool calls:
 * unknown/invalid → stale → deny rules → plan cap → interaction surface →
 * ask/allow rules → mode defaults → ask resolution against the available
 * surfaces. A preparation security fact slots inside that order: deny rules
 * and explicit ask rules are never downgraded by a fact, and the fact only
 * rewrites the plan cap exemption and the mode defaults below it.
 */
export function judgeModelToolCall(
  input: ModelToolJudgmentInput,
  snapshot: PermissionPolicySnapshot | undefined,
  surfaces: PermissionSurfaces,
): PermissionJudgment {
  const effect = EFFECT_BY_NAME.get(input.name)
  if (effect === undefined || input.inputValid === false) return deny("unknown_tool_or_input")
  if (
    input.preparedAtPolicyRevision !== undefined &&
    snapshot?.policyRevision !== undefined &&
    input.preparedAtPolicyRevision !== snapshot.policyRevision
  ) {
    return deny("stale_policy")
  }
  const mode = snapshot?.permissionMode ?? DEFAULT_SESSION_PERMISSION_MODE
  // Canonical writers dedupe rules by name, but a replayed payload carrying
  // duplicates must never let an allow row shadow a deny row: resolution is
  // most-restrictive-wins (deny > ask > allow).
  const behaviors = snapshot?.permissionRules?.filter((item) => item.name === input.name) ?? []
  const rule = behaviors.some((item) => item.behavior === "deny")
    ? "deny"
    : behaviors.some((item) => item.behavior === "ask")
      ? "ask"
      : behaviors.some((item) => item.behavior === "allow")
        ? "allow"
        : undefined
  if (rule === "deny") return deny("denied_by_rule")
  const fact = factForEffect(input.securityFact, effect)
  // The plan cap cannot be broken by an allow rule, but a deny rule still
  // reports first so the stronger reason wins. A read-only Bash template or
  // a scratch write is judged read-shaped and passes the cap; a dangerous
  // write does not.
  if (
    mode === "plan" &&
    effect !== "read" &&
    effect !== "session-internal" &&
    effect !== "interaction" &&
    fact?.kind !== "bash-read-only-template" &&
    fact?.kind !== "scratch-write"
  ) {
    return deny("plan_mode_rejected")
  }
  // The question surface is not an approval card: no rule — allow or ask —
  // and no mode can stand in for the interaction surface an ask_user call
  // requires.
  if (effect === "interaction") return surfaces.interactionSurface ? { decision: "allow" } : deny("approval_required", true)
  if (rule === "allow") return { decision: "allow" }
  if (rule === "ask") return resolveAsk(mode, surfaces)
  switch (effect) {
    case "read":
    case "session-internal":
      return { decision: "allow" }
    case "structured-write":
      // A scratch write mints allow in every mode; a dangerous write
      // upgrades the mode default to an ask even under accept-edits.
      if (fact?.kind === "scratch-write") return { decision: "allow" }
      if (fact?.kind === "dangerous-write") return resolveAsk(mode, surfaces)
      return mode === "accept-edits" || mode === "full-access" ? { decision: "allow" } : resolveAsk(mode, surfaces)
    case "bash":
      // A read-only template mints allow in every mode without consulting
      // the approval surface — auto included, because the guardian only
      // answers asks.
      if (fact?.kind === "bash-read-only-template") return { decision: "allow" }
      return mode === "full-access" ? { decision: "allow" } : resolveAsk(mode, surfaces)
    case "network":
    case "delegation":
      return mode === "full-access" ? { decision: "allow" } : resolveAsk(mode, surfaces)
  }
}

/**
 * Ask resolution: full-access skips the ask — never the deny that already
 * reported above; every other mode hands the ask to the approval surface,
 * and a missing surface terminates the call.
 */
function resolveAsk(mode: SessionPermissionMode, surfaces: PermissionSurfaces): PermissionJudgment {
  if (mode === "full-access") return { decision: "allow" }
  return surfaces.approvalSurface ? { decision: "ask" } : deny("approval_required", true)
}

/**
 * Projection over the advertised tool list: the model sees exactly the names
 * the judgment admits on the same snapshot. Denials (terminal or not) hide,
 * and asks survive only when their surface exists — the judge already folds
 * surface-less asks into terminal denials, so allow/ask are both visible.
 */
export function projectModelTools(
  names: readonly string[],
  snapshot: PermissionPolicySnapshot | undefined,
  surfaces: PermissionSurfaces,
): Set<string> {
  const visible = new Set<string>()
  for (const name of names) {
    const judgment = judgeModelToolCall({ name, inputValid: true }, snapshot, surfaces)
    if (judgment.decision === "deny") continue
    visible.add(name)
  }
  return visible
}
