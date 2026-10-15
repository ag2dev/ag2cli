import type { Message, UserMessage } from "@ag2cli/core/message.js"
import { userText } from "@ag2cli/core/message.js"
import type { PromptAssemblyManifest, SystemPrompt } from "@ag2cli/core/model/prompt.js"

/** A named system-prompt section assembled for one model call. */
export interface PromptSection {
  readonly id: string
  readonly text: string
}

/** A model-visible, non-canonical context fragment for the current request. */
export interface PromptContextFragment {
  readonly id: string
  readonly source: PromptContextSource
  readonly text: string
  readonly path?: string
}

export type PromptContextSource = "runtime" | "project-instructions" | "request" | "attachment" | "memory" | "skill"

export interface PromptAssembly {
  readonly systemPrompt: SystemPrompt
  /** These messages are sent to the model but never appended to session history. */
  readonly contextMessages: readonly UserMessage[]
  readonly manifest: PromptAssemblyManifest
}

/**
 * Assemble the model request boundary from named system sections and transient
 * context. Context is intentionally represented as one user message so the
 * provider adapters receive a stable, role-preserving shape without turning
 * every source into a separate conversation turn.
 */
export function assemblePrompt(
  input: {
    readonly systemSections?: readonly PromptSection[]
    readonly contextFragments?: readonly PromptContextFragment[]
  } = {},
): PromptAssembly {
  const systemSections = normalizeSystemSections(input.systemSections ?? [])
  const contextFragments = normalizeContextFragments(input.contextFragments ?? [])
  const contextText = contextFragments.map(renderContextFragment).join("\n\n")

  return {
    systemPrompt: systemSections.map((section) => section.text),
    contextMessages: contextText ? [userText(contextText)] : [],
    manifest: {
      systemSectionIds: systemSections.map((section) => section.id),
      contextFragmentIds: contextFragments.map((fragment) => fragment.id),
    },
  }
}

/** Put transient context before the canonical transcript for one model call. */
export function modelMessagesForRequest(contextMessages: readonly UserMessage[] | undefined, messages: readonly Message[]): Message[] {
  return [...(contextMessages ?? []), ...messages]
}

function normalizeSystemSections(sections: readonly PromptSection[]): PromptSection[] {
  const seen = new Set<string>()
  const normalized: PromptSection[] = []
  for (const section of sections) {
    const id = section.id.trim()
    const text = section.text
    if (!id || !text.trim()) continue
    if (seen.has(id)) throw new Error(`Duplicate system prompt section: ${id}`)
    seen.add(id)
    normalized.push({ id, text })
  }
  return normalized
}

function normalizeContextFragments(fragments: readonly PromptContextFragment[]): PromptContextFragment[] {
  const seen = new Set<string>()
  const normalized: PromptContextFragment[] = []
  for (const fragment of fragments) {
    const id = fragment.id.trim()
    if (!id || !fragment.text.trim()) continue
    if (seen.has(id)) throw new Error(`Duplicate prompt context fragment: ${id}`)
    seen.add(id)
    normalized.push({
      ...fragment,
      id,
      ...(fragment.path === undefined ? {} : { path: fragment.path }),
    })
  }
  return normalized
}

function renderContextFragment(fragment: PromptContextFragment): string {
  const attributes = [
    `source="${escapePromptAttribute(fragment.source)}"`,
    ...(fragment.path === undefined ? [] : [`path="${escapePromptAttribute(fragment.path)}"`]),
  ]
  // Do not allow source content to close the framing element. The content is
  // still shown verbatim apart from this one structural escape.
  const text = fragment.text.replaceAll("</system-reminder>", "<\\/system-reminder>")
  return `<system-reminder ${attributes.join(" ")}>\n${text}\n</system-reminder>`
}

/** Escape a value used in prompt framing attributes, not in user content. */
export function escapePromptAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}
