import type { RunId, SessionId } from "@ag2cli/core/ids.js"
import type { EventTrace } from "@ag2cli/core/events/event.js"
import type { Message } from "@ag2cli/core/message.js"
import type { ApiToolDefinition } from "@ag2cli/core/tool-facts.js"
import type { SystemPrompt } from "@ag2cli/core/model/prompt.js"
import type { ContextProvenance, ModelCallObservation } from "@ag2cli/core/model/observation.js"
import type { WorkspacePolicy } from "./workspace.js"

/** Input available to a context adapter before each model turn. */
export interface ContextBuildInput {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly goal: string
  readonly context: readonly string[]
  /** Workspace files loaded and validated by the runtime boundary. */
  readonly attachments?: readonly ContextAttachment[]
  readonly messages: readonly Message[]
  readonly tools: readonly ApiToolDefinition[]
  /** Workspace root for this turn; replayed from canonical events when the session already has one. */
  readonly workspaceRoot?: string
  /** Directories admitted beyond the root this turn; replayed from canonical events when present. */
  readonly additionalDirectories?: readonly string[]
  /** Session-scoped override; absent means use the configured model window. */
  readonly contextWindowOverride?: number
  /** Session-selected agent instructions; the file definition stays outside the event stream. */
  readonly agent?: { readonly name: string; readonly instructions: string }
  readonly trace?: EventTrace
  readonly signal?: AbortSignal
}

export interface ContextAttachment {
  readonly path: string
  readonly content: string
}

/**
 * A user-role message visible only to the current model request. It is kept
 * separate from `messages` so transient prompt context cannot enter the
 * canonical session transcript by accident.
 */
export type ContextMessage = Extract<Message, { readonly type: "user" }>

/** Project instruction file loaded by an interactive composition boundary. */
export interface ContextInstruction {
  readonly path: string
  readonly content: string
}

export type ContextAttachmentLoader = (
  paths: readonly string[],
  signal?: AbortSignal,
  workspace?: WorkspacePolicy,
) => Promise<readonly ContextAttachment[]>

/** Model-facing context. The event stream remains the source of truth. */
export interface BuiltContext {
  readonly messages: readonly Message[]
  /** Model-only context; never append these messages to durable history. */
  readonly contextMessages?: readonly ContextMessage[]
  readonly systemPrompt?: SystemPrompt
  readonly provenance?: ContextProvenance
  readonly modelObservations?: readonly ModelCallObservation[]
  /** Exact model-visible messages persisted when this build crosses a compact boundary. */
  readonly compaction?: ContextCompactionBoundary
}

export interface ContextCompactionBoundary {
  readonly compactId: string
  readonly inputMessageCount: number
  readonly outputMessageCount: number
  readonly messages: readonly Message[]
  readonly inputTokens?: number
}

/** Context boundary for memory, compact and product-specific prompt assembly. */
export interface ContextBuilder {
  build(input: ContextBuildInput): Promise<BuiltContext> | BuiltContext
}
