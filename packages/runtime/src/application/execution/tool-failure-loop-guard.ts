import type { ToolResult } from "@ag2cli/core/tool-facts.js"

const DEFAULT_THRESHOLD = 3

/** Runtime state for one agent run. It is intentionally not persisted. */
export type ToolFailureLoopGuardState = {
  readonly signatureCounts: Map<string, number>
}

export type ToolFailureLoopGuardObservation = {
  readonly toolName: string
  readonly input?: unknown
  readonly result: Pick<ToolResult, "content" | "isError">
}

export type ToolFailureLoopGuardDecision =
  | { readonly tripped: false }
  | {
      readonly tripped: false
      readonly count: number
      readonly advisory?: string
    }
  | {
      readonly tripped: true
      readonly count: number
      readonly toolName: string
      readonly category: ToolFailureCategory
      readonly message: string
    }

export type ToolFailureCategory = "DirectoryInput" | "NotFound" | "PermissionDenied" | "InvalidInput" | "UnknownTool" | "ToolError"

export function createToolFailureLoopGuardState(): ToolFailureLoopGuardState {
  return { signatureCounts: new Map() }
}

/**
 * Detects a model retrying the same kind of failed tool operation.
 *
 * The key deliberately uses a normalized category rather than the complete
 * error text. That catches different paths producing the same failure while
 * keeping paths and provider output out of the guard diagnostic.
 */
export function observeToolFailure(
  state: ToolFailureLoopGuardState,
  observation: ToolFailureLoopGuardObservation,
  threshold = DEFAULT_THRESHOLD,
): ToolFailureLoopGuardDecision {
  if (observation.result.isError !== true) {
    resetToolFailures(state, observation.toolName)
    return { tripped: false }
  }

  if (isCancellation(observation.result.content)) return { tripped: false }

  const toolName = safeToolName(observation.toolName)
  const category = classifyFailure(observation.result.content)
  const key = `${toolName}\0${category}`
  const count = (state.signatureCounts.get(key) ?? 0) + 1
  state.signatureCounts.set(key, count)
  const limit = normalizeThreshold(threshold)

  if (count >= limit) {
    return {
      tripped: true,
      count,
      toolName,
      category,
      message: [
        "Stopped after repeated tool failures.",
        `Tool ${toolName} encountered ${limit} consecutive failures in category ${category}. Review the tool arguments, path, or permissions before retrying.`,
      ].join("\n"),
    }
  }

  if (limit > 1 && count === limit - 1) {
    return {
      tripped: false,
      count,
      advisory: `Tool ${toolName} has ${count}/${limit} consecutive failures in category ${category}; another matching failure will stop this run. Use a suitable tool or review the arguments.`,
    }
  }

  return { tripped: false, count }
}

function resetToolFailures(state: ToolFailureLoopGuardState, toolName: string): void {
  const prefix = `${safeToolName(toolName)}\0`
  for (const key of state.signatureCounts.keys()) {
    if (key.startsWith(prefix)) state.signatureCounts.delete(key)
  }
}

function normalizeThreshold(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_THRESHOLD
}

function classifyFailure(content: string): ToolFailureCategory {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase()
  if (
    /eisdir|is a directory|is not a directory|cannot read director(?:y|ies)|search directory (?:does not exist|is inaccessible)|search path is not a directory|\u4e0d\u80fd\u8bfb\u53d6\u76ee\u5f55|\u76ee\u5f55/.test(
      normalized,
    )
  )
    return "DirectoryInput"
  if (/enoent|no such file|not found|does not exist|\u4e0d\u5b58\u5728|\u627e\u4e0d\u5230/.test(normalized)) return "NotFound"
  if (/eacces|eperm|permission denied|\u6743\u9650|\u62d2\u7edd\u8bbf\u95ee/.test(normalized)) return "PermissionDenied"
  if (/invalid|validation|\u53c2\u6570\u9519\u8bef|\u53c2\u6570\u65e0\u6548|\u8f93\u5165\u65e0\u6548/.test(normalized))
    return "InvalidInput"
  if (/unknown tool|\u672a\u77e5\u5de5\u5177|no such tool/.test(normalized)) return "UnknownTool"
  return "ToolError"
}

function isCancellation(content: string): boolean {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase()
  return (
    normalized === "\u7528\u6237\u53d6\u6d88" ||
    normalized === "interrupted by user" ||
    normalized.startsWith("request interrupted by user") ||
    normalized.startsWith("cancelled:") ||
    normalized.startsWith("canceled:")
  )
}

function safeToolName(toolName: string): string {
  return /^[A-Za-z0-9_.:-]+$/.test(toolName) ? toolName : "unknown tool"
}
