/**
 * Tool registry.
 *
 * Responsibilities:
 *  1. Hold a set of Tool instances.
 *  2. Convert zod inputSchema to the Anthropic API's input_schema (JSON Schema).
 *  3. Look up tools by name and execute tool_use.
 */

import { toJSONSchema } from "zod/v4"
import type {
  ApiToolDefinition,
  PermissionDenialCode,
  ToolExecutionMetadata,
  ToolInputSchema,
  ToolPreparation,
  ToolResult,
} from "@ag2cli/core/tool-facts.js"
import type { Tool, ToolContext } from "@ag2cli/runtime/ports/tool/contract.js"
import { deniedReasons } from "@ag2cli/runtime/application/execution/denial-reasons.js"
import { normalizeModelBashPreparation } from "../security/bash/security-layer.js"

/** Single source for the input-family refusal code used across this guard layer. */
const UNKNOWN_TOOL_OR_INPUT: PermissionDenialCode = "unknown_tool_or_input"

export class ToolRegistry {
  private tools = new Map<string, Tool>()
  /** Mutable state shared across tools and injected during execution. */
  private context: ToolContext = {}

  register(...tools: Tool[]): this {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`)
      this.tools.set(t.name, t)
    }
    return this
  }

  /** Remove one runtime tool. Returns false when the name was not registered. */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /** Remove all tools in a runtime namespace. */
  unregisterPrefix(prefix: string): number {
    let removed = 0
    for (const name of this.tools.keys()) {
      if (name.startsWith(prefix) && this.tools.delete(name)) removed++
    }
    return removed
  }

  /** Set the tool context (readFileState and todos). */
  setContext(context: ToolContext): this {
    this.context = context
    return this
  }
  getContext(): ToolContext {
    return this.context
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /**
   * Describe the interaction required before execution. Invalid input is
   * never treated as read-only.
   */
  describeTool(name: string, input: unknown): ToolExecutionMetadata | undefined {
    const tool = this.tools.get(name)
    if (!tool) return undefined
    const parsed = tool.inputSchema.safeParse(input)
    let isReadOnly = false
    let concurrencySafe = false
    if (parsed.success) {
      try {
        isReadOnly = tool.isReadOnly?.(parsed.data) ?? false
        concurrencySafe = tool.isConcurrencySafe?.(parsed.data) ?? false
      } catch {
        isReadOnly = false
        concurrencySafe = false
      }
    }
    return {
      interaction: tool.interaction ?? "none",
      isReadOnly,
      concurrencySafe,
    }
  }

  async prepare(
    name: string,
    input: unknown,
    contextOverride: Pick<ToolContext, "signal" | "execution" | "onOutput"> = {},
  ): Promise<ToolPreparation> {
    const tool = this.tools.get(name)
    if (!tool)
      return {
        status: "denied",
        decision: "deny",
        reasons: [`unknown tool: ${name} (${UNKNOWN_TOOL_OR_INPUT})`],
        analyzerVersion: "registry",
        policyVersion: "registry",
        denial: { code: UNKNOWN_TOOL_OR_INPUT },
      }
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success)
      return {
        status: "invalid",
        decision: "deny",
        reasons: [parsed.error.message],
        analyzerVersion: "registry",
        policyVersion: "registry",
        denial: { code: UNKNOWN_TOOL_OR_INPUT },
      }
    const context: ToolContext = {
      ...this.context,
      ...contextOverride,
      ...(contextOverride.execution?.workspace === undefined ? {} : { workspace: contextOverride.execution.workspace }),
      ...(contextOverride.execution?.askUser === undefined ? {} : { askUser: contextOverride.execution.askUser }),
    }
    if (tool.prepare) {
      try {
        return await tool.prepare(parsed.data, context)
      } catch (error) {
        // Preparation is the security boundary.  A provider/parser failure
        // must become a durable deny fact rather than escaping into a caller
        // that might accidentally execute the unprepared input.
        return {
          status: "invalid",
          decision: "deny",
          preparedInput: parsed.data,
          reasons: [`Tool ${name} preparation failed: ${error instanceof Error ? error.message : String(error)}`],
          analyzerVersion: "registry",
          policyVersion: "registry",
          denial: { code: UNKNOWN_TOOL_OR_INPUT },
        }
      }
    }
    // Tools without a custom preparation hook produce a neutral fact:
    // authorization is decided by the canonical judgment, never here.
    return {
      status: "ready",
      decision: "ask",
      preparedInput: parsed.data,
      reasons: [],
      analyzerVersion: "registry",
      policyVersion: "registry",
    }
  }

  /** All registered tools, used by buildSystemPrompt to assemble the tool list. */
  list(): Tool[] {
    return [...this.tools.values()]
  }

  /**
   * API definitions for all tools, passed to the tools field of Anthropic messages.create.
   * An optional filter predicate (such as read-only filtering for plan mode) is applied on top.
   */
  toApiDefinitions(options?: { filter?: (tool: Tool) => boolean }): ApiToolDefinition[] {
    const all = [...this.tools.values()]
    const visible = options?.filter ? all.filter((tool) => options.filter!(tool)) : all
    return visible.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: toJSONSchema(tool.inputSchema, { target: "draft-7" }) as ToolInputSchema,
    }))
  }

  /** Execute one tool_use. Return an is_error result when the tool is missing instead of throwing. */
  async execute(
    name: string,
    input: unknown,
    contextOverride: Pick<ToolContext, "signal" | "execution" | "onOutput"> = {},
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return {
        content: `tool ${name} denied (${UNKNOWN_TOOL_OR_INPUT}: unknown tool)`,
        isError: true,
        denial: { code: UNKNOWN_TOOL_OR_INPUT, reason: "unknown tool" },
      }
    }
    // Every registered model tool may only be executed with the exact
    // preparation fact selected by the canonical executor. Direct registry
    // calls must not become a preparation bypass.
    const preparation = contextOverride.execution?.preparation
    if (!preparation) {
      return {
        content: `tool ${name} denied (denied_by_rule: canonical preparation missing)`,
        isError: true,
        denial: { code: "denied_by_rule", reason: "canonical preparation missing" },
      }
    }
    if (name === "bash" && preparation.policyVersion !== "user-owned") {
      const normalized = normalizeModelBashPreparation(input, preparation)
      if (normalized.status === "invalid") {
        return {
          content: `tool bash denied (${UNKNOWN_TOOL_OR_INPUT}: canonical preparation does not satisfy the execution contract)`,
          isError: true,
          denial: { code: UNKNOWN_TOOL_OR_INPUT, reason: "canonical preparation does not satisfy the execution contract" },
        }
      }
    }
    if (preparation.decision === "deny" || preparation.status !== "ready") {
      // The preparation's own code (when it declared one) is the honest
      // cause; the guard itself is a rule refusal. Producer reasons render
      // through the shared normalization the executors apply (empty
      // reasons filtered, joined, capped) and are mirrored into the
      // structured denial.
      const code = preparation.denial?.code ?? "denied_by_rule"
      const reason =
        preparation.denial?.reason ??
        (preparation.reasons.length > 0 && deniedReasons(preparation.reasons) !== "" ? deniedReasons(preparation.reasons) : undefined)
      return {
        content: reason === undefined ? `tool ${name} denied (${code})` : `tool ${name} denied (${code}: ${reason})`,
        isError: true,
        denial: reason === undefined ? { code } : { code, reason },
      }
    }
    const approvalAuthorized =
      contextOverride.execution?.approvalDecision === "approved" || contextOverride.execution?.judgmentDecision === "allow"
    // A preparation "ask" executes only under a recorded approval or the
    // executor's judgment-allow resolution (mode defaults, the interaction
    // surface). Model bash accepts the judgment/approval pair alone: its
    // preparation "allow" is never the authorization itself.
    const preparationAuthorizes = preparation.decision === "allow" && !(name === "bash" && preparation.policyVersion !== "user-owned")
    if (!approvalAuthorized && !preparationAuthorizes) {
      return {
        content: `tool ${name} denied (approval_required: canonical approval missing)`,
        isError: true,
        denial: { code: "approval_required", reason: "canonical approval missing" },
      }
    }
    // Runtime validation and default-value population.
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        content: `tool ${name} denied (${UNKNOWN_TOOL_OR_INPUT}: ${parsed.error.message})`,
        isError: true,
        denial: { code: UNKNOWN_TOOL_OR_INPUT, reason: parsed.error.message },
      }
    }
    // Inject the shared context (readFileState, etc.).
    return tool.call(parsed.data, {
      ...this.context,
      ...contextOverride,
      ...(contextOverride.execution?.workspace === undefined ? {} : { workspace: contextOverride.execution.workspace }),
      ...(contextOverride.execution?.askUser === undefined ? {} : { askUser: contextOverride.execution.askUser }),
    })
  }
}
