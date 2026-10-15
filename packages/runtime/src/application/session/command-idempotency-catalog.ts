import { CREATE_PLAN_FAMILY } from "../plan/create-plan.js"
import { EXECUTE_SHELL_FAMILY } from "../execution/execute-shell.js"
import { START_RUN_FAMILY } from "../execution/run-agent.js"
import { CREATE_TASK_FAMILY } from "../task/task-registry.js"
import { CONTEXT_WINDOW_FAMILY } from "./context-window.js"
import { PERMISSION_FAMILY } from "./permission-state.js"
import { GOAL_FAMILY } from "./update-goal.js"
import { AGENT_FAMILY } from "./update-agent.js"
import { ADDITIONAL_DIRECTORY_IDEMPOTENCY_FAMILY } from "./workspace-roots.js"
import { COMPACT_IDEMPOTENCY_FAMILY } from "./compact-session.js"

export type CommandIdempotencyCoverage = "resolver" | "bespoke-correct" | "bespoke-gap-documented" | "excluded-by-design"

export type CommandIdempotencyIdentity = "commandId" | "taskId" | "saga-key" | "resource-key" | "none"

export interface CommandIdempotencyCatalogEntry {
  readonly commandFamily: string
  /** Stable owner label; this is a catalog reference, not a runtime import path lookup. */
  readonly owner: string
  readonly coverage: CommandIdempotencyCoverage
  readonly identity: CommandIdempotencyIdentity
  readonly reason: string
  /** Actual production strategy reference for entries using the shared resolver. */
  readonly strategy?: { readonly family: string }
}

/** Production-side audit seam for every durable command and explicit exclusion. */
export const COMMAND_IDEMPOTENCY_FAMILY_CATALOG: readonly CommandIdempotencyCatalogEntry[] = [
  {
    commandFamily: "set_context_window / clear_context_window",
    owner: "session/context-window",
    coverage: "resolver",
    identity: "commandId",
    strategy: CONTEXT_WINDOW_FAMILY,
    reason: "Single-event family; SessionContextWindowSet/Cleared payload is a direct fingerprint of the request.",
  },
  {
    commandFamily: "update_goal",
    owner: "session/update-goal",
    coverage: "resolver",
    identity: "commandId",
    strategy: GOAL_FAMILY,
    reason: "Pure projected SessionGoal fingerprint distinguishes same update replay from a conflicting commandId reuse.",
  },
  {
    commandFamily: "set_permission_mode / set_permission_rules",
    owner: "session/permission-state",
    coverage: "resolver",
    identity: "commandId",
    strategy: PERMISSION_FAMILY,
    reason: "One command may append mode/rules events; the strategy combines both event types into one fingerprint.",
  },
  {
    commandFamily: "update_agent",
    owner: "session/update-agent",
    coverage: "resolver",
    identity: "commandId",
    strategy: AGENT_FAMILY,
    reason: "Single-event family; SessionAgentSelected.payload.agentName is a direct fingerprint of the request.",
  },
  {
    commandFamily: "create_plan",
    owner: "plan/create-plan",
    coverage: "resolver",
    identity: "commandId",
    strategy: CREATE_PLAN_FAMILY,
    reason: "CommandAccepted anchor plus plan terminal strategy; domain result and incomplete generation recovery remain in the use case.",
  },
  {
    commandFamily: "execute_shell / execute_user_shell",
    owner: "execution/execute-shell",
    coverage: "resolver",
    identity: "commandId",
    strategy: EXECUTE_SHELL_FAMILY,
    reason:
      "Both shell command forms share the RunStarted/ToolCallRequested fingerprint and ToolResultCommitted terminal; security and partial execution stay in the use case.",
  },
  {
    commandFamily: "run (start_run)",
    owner: "execution/run-agent",
    coverage: "resolver",
    identity: "commandId",
    strategy: START_RUN_FAMILY,
    reason: "InputAccepted anchor plus run terminal strategy; multi-turn model/tool/approval resume stays in the use case.",
  },
  {
    commandFamily: "create_task",
    owner: "task/task-registry",
    coverage: "resolver",
    identity: "taskId",
    strategy: CREATE_TASK_FAMILY,
    reason:
      "Natural taskId identity maps to CommandAttempt.commandId; task definition is fingerprinted while current projection is returned.",
  },
  {
    commandFamily: "add_additional_directory",
    owner: "session/workspace-roots",
    coverage: "resolver",
    identity: "commandId",
    strategy: ADDITIONAL_DIRECTORY_IDEMPOTENCY_FAMILY,
    reason: "The terminal event stores both raw requested directory and resolved directory, so replay never re-runs resolution.",
  },
  {
    commandFamily: "compact",
    owner: "session/compact-session",
    coverage: "resolver",
    identity: "commandId",
    strategy: COMPACT_IDEMPOTENCY_FAMILY,
    reason: "The terminal event stores the instructions fingerprint; replay never re-runs the non-pure compactor.",
  },
  {
    commandFamily: "rewind / preview_rewind",
    owner: "session/rewind-session",
    coverage: "bespoke-correct",
    identity: "commandId",
    reason:
      "Conversation rewind pairs BranchCreated and HeadMoved atomically and compares the requested checkpoint on replay; preview remains read-only.",
  },
  {
    commandFamily: "resolve_approval",
    owner: "session/permission-state",
    coverage: "excluded-by-design",
    identity: "resource-key",
    reason: "Approval resolution is fenced by sessionId+runId+turn+toolUseId, not client commandId.",
  },
  {
    commandFamily: "session.cancel / cancel_task",
    owner: "execution/run-agent + task/task-registry",
    coverage: "excluded-by-design",
    identity: "resource-key",
    reason: "Cancellation is resource-keyed and convergent; repeated cancellation has no fingerprint conflict semantics.",
  },
]

/** Actual shared-resolver strategies, kept separate for tests that verify references are not just labels. */
export const COMMAND_IDEMPOTENCY_RESOLVER_FAMILIES = [
  CONTEXT_WINDOW_FAMILY,
  GOAL_FAMILY,
  PERMISSION_FAMILY,
  AGENT_FAMILY,
  CREATE_PLAN_FAMILY,
  EXECUTE_SHELL_FAMILY,
  START_RUN_FAMILY,
  CREATE_TASK_FAMILY,
  ADDITIONAL_DIRECTORY_IDEMPOTENCY_FAMILY,
  COMPACT_IDEMPOTENCY_FAMILY,
] as const
