/**
 * `agent` tool face (delegation, D6): a thin adapter over the child runner.
 *
 * Authorization belongs to the canonical judgment (delegation effect), not to
 * a custom prepare, so this face only validates input shape, resolves the
 * optional profile, and maps the child outcome onto the ToolResult contract.
 * The runner arrives through a lazy thunk because composition assembles it
 * after the model layer; an unset thunk is a structured refusal.
 */

import { z } from "zod/v4"
import type { ToolResult } from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import type { AgentProfileResolver } from "@ag2cli/runtime/ports/agent-profile.js"
import { effectiveChildToolNames, type ChildAgentRunner } from "../execution/child-agent-runner.js"

const inputSchema = z.object({
  prompt: z.string().min(1).describe("Self-contained subtask description: goal, relevant paths, boundaries, and expected output"),
  description: z.string().min(1).describe("3–5-word task summary for approval cards and progress updates"),
  subagent_type: z.string().min(1).optional().describe("Named agent profile; defaults to the general-purpose subagent"),
  model: z.string().min(1).optional().describe("Model for the subagent, selected from configured providers"),
  max_turns: z.number().int().positive().optional().describe("Maximum turns for the subagent; capped at the composition limit"),
  tools: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe("tool names the child may use; the list only narrows the pool it would inherit, never widens it"),
  async: z
    .boolean()
    .optional()
    .describe(
      "When true, return the subagent handle immediately without waiting; a completion notification arrives later, and agent_join retrieves the report",
    ),
})

export interface AgentToolDependencies {
  /** Resolved lazily: composition assigns the runner after the model layer exists. */
  readonly runnerThunk: () => ChildAgentRunner | undefined
  readonly agentResolver: AgentProfileResolver
  readonly availableAgentNames: () => readonly string[]
  /** Host registry names; anchors the face-level spawn-tools narrowing guard. */
  readonly availableToolNames: () => readonly string[]
  /** Composition-level turn cap; explicit max_turns clamps to it. */
  readonly maxTurnsDefault?: number
}

export class AgentTool implements Tool<typeof inputSchema> {
  readonly name = "agent"
  readonly description =
    "Delegate an independent, multi-step subtask to a subagent and return its final report. With async: true, return the handle immediately; a completion notification arrives later, and agent_join retrieves the report. The subagent cannot see the current conversation, so the delegated prompt must be self-contained."
  readonly inputSchema = inputSchema

  constructor(private readonly deps: AgentToolDependencies) {}

  async call(args: z.infer<typeof inputSchema>, context?: ToolContext): Promise<ToolResult> {
    const words = countWords(args.description)
    if (words < 3 || words > 5) {
      return structuredError(`description must be 3-5 words (one CJK segment counts as one word); got ${words}`)
    }
    if (args.prompt.trim().length === 0) {
      return structuredError("prompt must be non-empty; whitespace-only prompts are rejected")
    }
    const subagentProfile = args.subagent_type === undefined ? undefined : this.deps.agentResolver.resolve(args.subagent_type)
    if (args.subagent_type !== undefined && subagentProfile === undefined) {
      const available = this.deps.availableAgentNames()
      return structuredError(
        `unknown subagent_type: ${args.subagent_type}; available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      )
    }
    const parentAgentName = context?.execution?.agentName
    const parentProfile = parentAgentName === undefined ? undefined : this.deps.agentResolver.resolve(parentAgentName)
    if (args.tools !== undefined) {
      const refusal = validateSpawnTools(args.tools, {
        hostNames: this.deps.availableToolNames(),
        parentTools: parentProfile?.tools,
        profileTools: subagentProfile?.tools,
      })
      if (refusal !== undefined) return structuredError(refusal, { code: "unknown_tool_or_input" })
    }
    const runner = this.deps.runnerThunk()
    if (runner === undefined) {
      return structuredError("delegation unavailable: this host did not assemble a child agent runner")
    }
    const execution = context?.execution
    if (execution?.security === undefined) {
      return structuredError("delegation unavailable: canonical security snapshot missing for this dispatch")
    }
    const cap = this.deps.maxTurnsDefault
    const maxTurns = args.max_turns === undefined || cap === undefined ? args.max_turns : Math.min(args.max_turns, cap)
    const request = {
      prompt: args.prompt,
      description: args.description,
      ...(args.subagent_type === undefined ? {} : { subagentType: args.subagent_type }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(parentAgentName === undefined ? {} : { parentAgentName }),
      ...(args.tools === undefined ? {} : { tools: args.tools }),
      security: execution.security,
      trace: execution.trace,
      parentSessionId: execution.sessionId,
      parentRunId: execution.runId,
      toolUseId: execution.toolUseId,
      ...(context?.signal === undefined ? {} : { signal: context.signal }),
      ...(context?.onOutput === undefined ? {} : { onOutput: context.onOutput }),
    }
    if (args.async === true) {
      // Same judgment, same request shape — only the wait differs: the
      // handle returns now, the report arrives via notification/join.
      const spawned = await runner.spawn(request)
      if (spawned.status === "failed") {
        return structuredError(`child agent failed: ${spawned.error}`)
      }
      return {
        content: `async child spawned: ${spawned.childSessionId}; completion arrives as a task notification; call agent_join to retrieve the report`,
        metadata: { childSessionId: spawned.childSessionId },
      }
    }
    const outcome = await runner.run(request)
    const metadata: Record<string, string> = {}
    if (outcome.childSessionId !== undefined) metadata["childSessionId"] = outcome.childSessionId
    if (outcome.childRunId !== undefined) metadata["childRunId"] = outcome.childRunId
    if (outcome.status === "completed") {
      return {
        content: outcome.finalText ?? "child agent completed without a final report",
        metadata,
      }
    }
    const reason = outcome.status === "cancelled" ? "child agent cancelled" : `child agent failed: ${outcome.error ?? "unknown error"}`
    return { content: reason, isError: true, metadata }
  }

  isReadOnly(): boolean {
    return false
  }

  isConcurrencySafe(): boolean {
    return true
  }
}

/** One CJK segment counts as one word, matching the deleted tool's rule family. */
function countWords(description: string): number {
  return (description.match(/[A-Za-z0-9][A-Za-z0-9._+-]*|[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]+/g) ?? []).length
}

/**
 * Spawn-tools guard: the request may only shrink the pool the runner would
 * construct from the host registry and the enclosing agent scopes. Each
 * refusal names the offender and the pool it violated so the model can
 * correct the input instead of guessing.
 */
function validateSpawnTools(
  names: readonly string[],
  scopes: {
    readonly hostNames: readonly string[]
    readonly parentTools?: readonly string[]
    readonly profileTools?: readonly string[]
  },
): string | undefined {
  if (names.includes("agent")) {
    return 'tools must not include "agent"; nested delegation does not exist'
  }
  const unknown = names.filter((name) => !scopes.hostNames.includes(name))
  if (unknown.length > 0) {
    return `unknown tool name in tools: ${unknown.join(", ")}; available: ${scopes.hostNames.join(", ")}`
  }
  const effective = effectiveChildToolNames(scopes)
  const outside = names.filter((name) => !effective.includes(name))
  if (outside.length > 0) {
    return `tool(s) outside the child pool for this spawn: ${outside.join(", ")}; child pool: ${effective.join(", ")}`
  }
  return undefined
}

function structuredError(message: string, denial?: ToolResult["denial"]): ToolResult {
  return { content: `agent tool refused: ${message}`, isError: true, ...(denial === undefined ? {} : { denial }) }
}
