export type SessionGoalStatus = "unset" | "active" | "paused"

export interface SessionGoal {
  readonly status: SessionGoalStatus
  readonly text?: string
}

export type SessionGoalUpdate = { readonly action: "set"; readonly text: string } | { readonly action: "clear" | "pause" | "resume" }

export interface SessionGoalChange {
  readonly changed: boolean
  readonly goal: SessionGoal
}

export const EMPTY_SESSION_GOAL: SessionGoal = { status: "unset" }

export function normalizeSessionGoal(value: SessionGoal): SessionGoal {
  if (value.status === "unset") {
    if (value.text !== undefined) throw new Error("An unset goal must not include text")
    return { status: "unset" }
  }
  if (value.text === undefined || value.text.trim().length === 0) {
    throw new Error(`${value.status} goal must include non-empty text`)
  }
  if (value.text.length > 4_000) throw new Error("goal must not exceed 4000 characters")
  return { status: value.status, text: value.text }
}

export function updateSessionGoal(current: SessionGoal | undefined, update: SessionGoalUpdate): SessionGoalChange {
  const previous = normalizeSessionGoal(current ?? EMPTY_SESSION_GOAL)
  if (update.action === "set") {
    const text = update.text.trim()
    if (text.length === 0) throw new Error("goal must not be empty")
    if (text.length > 4_000) throw new Error("goal must not exceed 4000 characters")
    const goal: SessionGoal = { status: "active", text }
    return {
      changed: previous.status !== goal.status || previous.text !== goal.text,
      goal,
    }
  }
  if (update.action === "clear") {
    return { changed: previous.status !== "unset", goal: EMPTY_SESSION_GOAL }
  }
  if (update.action === "pause") {
    const goal: SessionGoal = previous.status === "active" ? { ...previous, status: "paused" } : previous
    return { changed: goal.status !== previous.status, goal }
  }
  const goal: SessionGoal = previous.status === "paused" ? { ...previous, status: "active" } : previous
  return { changed: goal.status !== previous.status, goal }
}
