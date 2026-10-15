/**
 * Domain identifiers.
 *
 * IDs are intentionally opaque to the domain.  Generation belongs to an
 * adapter/port; the domain only carries and validates non-empty values.
 */

export type SessionId = string & { readonly __brand: "SessionId" }
export type PlanId = string & { readonly __brand: "PlanId" }
export type RunId = string & { readonly __brand: "RunId" }
export type TaskId = string & { readonly __brand: "TaskId" }

function asId<T extends string>(value: string, kind: string): T {
  const normalized = value.trim()
  if (normalized.length === 0) throw new Error(`${kind} must not be empty`)
  return normalized as T
}

export function sessionId(value: string): SessionId {
  return asId<SessionId>(value, "sessionId")
}

export function planId(value: string): PlanId {
  return asId<PlanId>(value, "planId")
}

export function runId(value: string): RunId {
  return asId<RunId>(value, "runId")
}

export function taskId(value: string): TaskId {
  return asId<TaskId>(value, "taskId")
}
