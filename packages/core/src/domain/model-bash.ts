/** Strict model-facing contract shared by preparation, events and executors. */

export const MAX_MODEL_BASH_TIMEOUT_MS = 10 * 60_000

export type ModelBashInput = {
  readonly command: string
  readonly timeout?: number
  readonly description?: string
}

/**
 * Runtime validation for data crossing a model, transport or persistence
 * boundary. Unknown keys are rejected so legacy argv/cwd aliases cannot be
 * smuggled through a custom or remote executor.
 */
export function isModelBashInput(value: unknown): value is ModelBashInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const allowedKeys = new Set(["command", "timeout", "description"])
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return false
  if (typeof candidate.command !== "string" || candidate.command.length === 0) return false
  const timeout = candidate.timeout
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_MODEL_BASH_TIMEOUT_MS)
  ) {
    return false
  }
  if (candidate.description !== undefined && typeof candidate.description !== "string") return false
  return true
}
