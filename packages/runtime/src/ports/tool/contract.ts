/**
 * Tool interface.
 *
 * The tool contract exposes only the minimum runtime boundary:
 *  - name: tool name referenced by the model in tool_use
 *  - description: model-facing guidance that influences when the model selects this tool
 *  - inputSchema: zod schema used for runtime validation and conversion to JSON Schema for the model
 *  - call(args, context): execute and return ToolResult; context holds mutable state shared across tools
 *  - isReadOnly / isConcurrencySafe: used for permission checks and concurrency partitioning
 */

import type { z } from "zod/v4"
import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { SessionSecuritySnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { ToolInteraction, ToolOutputSink, ToolPreparation, ToolResult } from "@ag2cli/core/tool-facts.js"
import type { WorkspacePolicy } from "../workspace.js"

/** Runtime coordinates exposed to a tool for nested trace correlation. */
export interface ToolExecutionContext {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly toolUseId: string
  /** Stable key for adapters that need to deduplicate external side effects. */
  readonly idempotencyKey: string
  readonly trace: EventTrace
  /** Session-authoritative workspace policy for this invocation. */
  readonly workspace?: WorkspacePolicy
  /**
   * Canonical security snapshot the executor judged this call against,
   * frozen at dispatch. Executor-populated only; a tool never derives it
   * from its own input.
   */
  readonly security?: SessionSecuritySnapshot
  /**
   * Name of the agent profile the parent turn is running under, same
   * source as the turn's tool scoping. Executor-populated only; undefined
   * is a legal value meaning the main session has no active agent.
   */
  readonly agentName?: string
  /** Trusted working directory selected by the session boundary. */
  readonly cwd?: string
  /** Live output callback scoped to this tool invocation. */
  readonly onOutput?: ToolOutputSink
  /** Preparation fact selected by the canonical executor; not user-controlled. */
  readonly preparation?: ToolPreparation
  /** Approval fact selected by the canonical executor; required for ask calls. */
  readonly approvalDecision?: "approved" | "denied"
  /**
   * Judgment resolution recorded by the canonical executor when it
   * authorized the call without an approval (mode defaults, the
   * interaction surface). Present only on the non-ask execution path; a
   * preparation "ask" may execute under this fact instead of a recorded
   * approval.
   */
  readonly judgmentDecision?: "allow"
  /**
   * Executor-scoped ask callback override. The canonical executor leaves
   * it unset (the registry context owns the host callback); a nesting
   * wrapper may pin a different owner so a nested session's questions
   * never reach the enclosing host's ask surface.
   */
  readonly askUser?: AskUser
  /**
   * Serializes the actual process spawn against session policy commits. The
   * gate re-reads canonical security and rejects the spawn when the policy
   * drifted since this call was bound. A tool must never reach this gate
   * while its own dispatch section still holds the serial point: the gate
   * shares the dispatch token, so that violation surfaces as a reentry
   * error instead of a silent ordering hole.
   */
  readonly preSpawnGate?: (spawn: () => Promise<unknown>) => Promise<unknown>
}

/** Read state for one file (mtime and content snapshot), used for read-before-write validation. */
export interface ReadFileStateEntry {
  timestamp: number
  content: string
}

export interface ReadFileState {
  get(path: string): ReadFileStateEntry | undefined
  set(path: string, state: ReadFileStateEntry): void
}

/** Todo item, defined here for use by the Todo tool. */
export interface TodoItem {
  content: string
  status: "pending" | "in_progress" | "completed"
  activeForm?: string
}

/**
 * Callback used by the AskUserQuestion tool to ask the user questions.
 * Returns one answer per question; the CLI injects a readline implementation and tests inject a fake.
 */
export type AskUser = (
  questions: ReadonlyArray<import("../ask-user.js").AskUserQuestion>,
) => Promise<import("../ask-user.js").AskUserAnswer[]>

/**
 * Tool execution context.
 *
 * Mutable state shared across tools is injected centrally rather than held by
 * individual tools. Fields are optional by capability. If a security capability
 * is not injected, the corresponding operation must be denied; never bypass the boundary.
 */
export interface ToolContext {
  /** mtime validation for read-before-write checks, used by FileEdit. */
  readFileState?: ReadFileState
  /** Todo list. */
  todos?: TodoItem[]
  /** Interaction callback for AskUserQuestion. The tool returns a diagnostic message if it is not injected. */
  askUser?: AskUser
  /** Enter plan mode. */
  enterPlanMode?: () => void
  /**
   * Submit a plan for approval. Returns whether it was approved; the implementation handles mode switching.
   */
  submitPlan?: (plan: string) => Promise<boolean>
  /**
   * Security foundation: workspace path policy. File tools (Read/Write/Edit/Notebook/
   * Glob/Grep) use this before invocation to ensure paths are inside an allowed root
   * and are not sensitive. Production composition roots must inject it.
   */
  workspace?: WorkspacePolicy
  /** Runtime reliability: cancellation signal for the current operation. Long-running Bash and subagent tasks listen for it and stop on abort. */
  signal?: AbortSignal
  /** Parent runtime coordinates for nested execution and trace correlation. */
  execution?: ToolExecutionContext
  /** Optional live output sink. Chunks are never part of the durable context. */
  onOutput?: ToolOutputSink
}

/** All tools implement this interface. Input is the zod schema type. */
export interface Tool<Input extends z.ZodType = z.ZodType> {
  readonly name: string
  readonly description: string
  readonly inputSchema: Input
  /** Prepare a validated call without starting external work. */
  prepare?(args: z.infer<Input>, context?: ToolContext): Promise<ToolPreparation> | ToolPreparation
  /** A question is answered by the client; it is not a y/n authorization request. */
  readonly interaction?: Exclude<ToolInteraction, "none">
  /**
   * Execute the tool. args has been parsed by inputSchema; context is optional shared state.
   */
  call(args: z.infer<Input>, context?: ToolContext): Promise<ToolResult>
  /** Whether the tool is read-only and does not change external state. */
  isReadOnly?(args: z.infer<Input>): boolean
  /**
   * Whether this tool can run concurrently with other safe tools. The implementation
   * may decide based on input (for example, distinguish read-only Bash commands from
   * write commands). Read-only tools are usually safe; write tools are not. Treat
   * errors and parse failures conservatively as unsafe.
   */
  isConcurrencySafe?(args: z.infer<Input>): boolean
}
