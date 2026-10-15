/**
 * Transport helper for system prompts: joins sections into the form required by a provider.
 *
 * Section semantics and assembly belong to application/prompt, not here.
 * Protocol clients use this helper to pass SystemPrompt to the underlying field.
 */

import type { SystemPrompt } from "@ag2cli/core/model/prompt.js"

/**
 * Join the sections into one string for Anthropic's top-level system field.
 * Return undefined for an empty array so callers can omit the system field.
 */
export function joinSystemPrompt(parts: SystemPrompt): string | undefined {
  const filtered = parts.filter((p) => p && p.trim().length > 0)
  return filtered.length > 0 ? filtered.join("\n\n") : undefined
}
