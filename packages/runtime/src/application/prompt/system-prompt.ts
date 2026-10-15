/**
 * Default system-prompt assembly.
 *
 * Represent the system prompt as an array of sections. Different capabilities can
 * provide sections independently; they are joined at the protocol adapter boundary
 * by joinSystemPrompt in ports/model/prompt.
 *
 * Design notes:
 *  1. The system prompt is a separate API field, not a regular message
 *     (Anthropic's top-level `system` or the first `{role:"system"}` message
 *     for OpenAI). It defines the agent's role, rules, and available tools for
 *     the entire session and applies to every model call.
 *  2. An array of sections, rather than one string, allows identity, tool
 *     descriptions, and rules to be assembled as needed.
 *  3. This module only assembles the prompt and does not depend on runtime
 *     state; callers provide the identity and tool descriptions.
 *
 * This module assembles identity, language preference, and the current tool
 * list. Repository context is provided separately as temporary model messages
 * by the prompt assembly/context adapter.
 */

import type { Tool } from "../../ports/tool/contract.js"
import type { SystemPrompt } from "@ag2cli/core/model/prompt.js"

type PromptTool = Pick<Tool, "name" | "description">

/** Input to buildSystemPrompt. */
export interface BuildSystemPromptInput {
  /** Identity, role, or general-rule sections, prepended in order. */
  identity?: string[]
  /** Preferred model response language; absent means follow the user's language. */
  responseLanguage?: string
  /** Available tools; their descriptions form the tool-list section. */
  tools?: ReadonlyArray<PromptTool>
}

/**
 * Assemble identity and tool-description sections into a complete system prompt.
 *
 * Structure:
 *   [identity sections...]
 *   "The tools registered and available in this turn are...\n- name: description\n- ..."
 * (Returns an empty array when there is no identity or tools, so the client
 * omits the system field.)
 */
export function buildSystemPrompt(input: BuildSystemPromptInput = {}): SystemPrompt {
  const parts: string[] = []
  if (input.identity) parts.push(...input.identity)
  if (input.responseLanguage?.trim()) {
    parts.push(
      [
        "# Response language policy",
        `Always respond in ${input.responseLanguage.trim()}. Use ${input.responseLanguage.trim()} for explanations and direct responses unless the user explicitly requests another language.`,
        "Keep the response language consistent across turns; do not switch languages based only on the language of tools, files, or system instructions.",
        "Keep code, commands, paths, identifiers, quoted content, and protocol fields in their original form unless the user asks otherwise.",
      ].join("\n"),
    )
  }
  if (input.tools && input.tools.length > 0) {
    const lines = input.tools.map((t) => `- ${t.name}: ${t.description}`)
    parts.push(
      [
        "The following tools are registered and callable in this turn. When answering questions about tools, use only this list. Bash is a tool; the specific command is provided in its command string.",
        ...lines,
      ].join("\n"),
    )
  }
  return parts
}
