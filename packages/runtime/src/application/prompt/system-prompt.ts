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
 *     for OpenAI). It defines stable identity and policy for each model call.
 *  2. An array of sections, rather than one string, keeps identity and policy
 *     composable.
 *  3. This module only assembles the prompt and does not depend on runtime
 *     state; tool definitions are supplied separately with the model request.
 *
 * Repository context is provided separately as temporary model messages by
 * the prompt assembly/context adapter.
 */

import type { SystemPrompt } from "@ag2cli/core/model/prompt.js"

/** Input to buildSystemPrompt. */
export interface BuildSystemPromptInput {
  /** Identity, role, or general-rule sections, prepended in order. */
  identity?: readonly string[]
  /** Preferred model response language; absent means follow the user's language. */
  responseLanguage?: string
}

/**
 * Assemble identity and response-language sections into a system prompt.
 *
 * Identity sections precede the optional response-language policy. Tool
 * definitions are supplied separately with the model request and are not
 * copied into the system prompt.
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
  return parts
}
