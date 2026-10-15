import { descriptorByName, GENERIC_OPENAI_DESCRIPTOR, OPENAI_ENDPOINT_DESCRIPTORS } from "./descriptors.js"
import type {
  OpenAICompatibilityOverride,
  OpenAIEndpointDescriptor,
  ResolvedOpenAICompatibility,
} from "@ag2cli/runtime/ports/model/compatibility.js"

export function resolveOpenAICompatibility(endpoint: string, override?: OpenAICompatibilityOverride): ResolvedOpenAICompatibility {
  const normalizedEndpoint = normalizeEndpoint(endpoint)
  const overrideDescriptor = override?.name === undefined ? undefined : descriptorByName(override.name)
  const endpointDescriptor = OPENAI_ENDPOINT_DESCRIPTORS.find((descriptor) => matchesEndpoint(normalizedEndpoint, descriptor))
  const base = overrideDescriptor ?? endpointDescriptor ?? GENERIC_OPENAI_DESCRIPTOR
  const descriptor = applyOverride(base, override)
  return {
    endpoint: normalizedEndpoint,
    descriptor,
    source: overrideDescriptor ? "override" : endpointDescriptor ? "endpoint" : "generic",
  }
}

function applyOverride(descriptor: OpenAIEndpointDescriptor, override?: OpenAICompatibilityOverride): OpenAIEndpointDescriptor {
  if (!override) return descriptor
  return {
    ...descriptor,
    ...(override.maxTokensField === undefined ? {} : { maxTokensField: override.maxTokensField }),
    ...(override.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: override.supportsReasoningEffort }),
    ...(override.thinkingRequestFormat === undefined ? {} : { thinkingRequestFormat: override.thinkingRequestFormat }),
    ...(override.reasoningReplay === undefined ? {} : { reasoningReplay: override.reasoningReplay }),
    ...(override.assistantEmptyContent === undefined ? {} : { assistantEmptyContent: override.assistantEmptyContent }),
    ...(override.parseThinkTags === undefined ? {} : { parseThinkTags: override.parseThinkTags }),
    ...(override.visibleReasoningDetailTypes === undefined ? {} : { visibleReasoningDetailTypes: override.visibleReasoningDetailTypes }),
    ...(override.supportsStreamUsage === undefined ? {} : { supportsStreamUsage: override.supportsStreamUsage }),
    ...(override.requiresToolResultName === undefined ? {} : { requiresToolResultName: override.requiresToolResultName }),
  }
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("OpenAI endpoint must not be empty")
  try {
    return new URL(trimmed).toString()
  } catch {
    throw new Error(`Invalid OpenAI endpoint: ${value}`)
  }
}

function matchesEndpoint(endpoint: string, descriptor: OpenAIEndpointDescriptor): boolean {
  const url = new URL(endpoint)
  return descriptor.matchers.some((matcher) => {
    if (matcher.kind === "hostname") return url.hostname === matcher.value
    if (matcher.kind === "hostname-suffix") return url.hostname.endsWith(matcher.value)
    return url.pathname === matcher.value || url.pathname.startsWith(`${matcher.value}/`)
  })
}
