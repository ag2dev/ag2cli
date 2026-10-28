/**
 * The Confirm task: the one-time full-access confirmation card. It
 * discloses the reach the switch grants (workspace scope plus the
 * additional directories, all tool calls unguarded), submits the fact
 * and the switch together on Enter, and then absorbs every key while
 * the canonical receipt is outstanding — Escape included, because
 * cancelling mid-flight would leave an ambiguous half-submission. A
 * rejected switch reopens the offering face with the cause inline; the
 * in-process confirmation fact itself is the coordinator's to record
 * only once the canonical outcome applied.
 */
import type { TuiIntent } from "../../keys/index.js"
import type { PermissionTaskFacts, TaskDefinition, TaskEngineEvent } from "./contracts.js"
import { noPermissionFacts } from "./contracts.js"
import { defineTask } from "./contracts.js"

export type ConfirmTaskInput = { readonly mode: string }
export type ConfirmTaskResult = { readonly confirmed: boolean }
export type ConfirmTaskEffect = { readonly kind: "full-access-confirm" }
export type ConfirmTaskDefinition = TaskDefinition<"confirm", ConfirmTaskInput, ConfirmTaskResult, ConfirmTaskEffect>

/** Directory slots the disclosure shows whole; beyond it the card trades one slot for a counted elision row. */
const DIRECTORY_SLOTS = 6

export function createConfirmTask(): ConfirmTaskDefinition {
  return defineTask({
    kind: "confirm",
    scope: "session",
    create(input, kit) {
      const facts = (): PermissionTaskFacts => kit.permissions?.() ?? noPermissionFacts
      const submission = () => facts().modeSubmission
      const waiting = (): boolean => {
        const current = submission()
        return current !== null && current.viaConfirm && current.status === "pending"
      }
      const rejection = (): "stale" | "failed" | null => {
        const current = submission()
        return current !== null && current.viaConfirm && (current.status === "stale" || current.status === "failed") ? current.status : null
      }
      return {
        title: "Full access",
        scope: "session",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent): readonly TaskEngineEvent<ConfirmTaskResult, ConfirmTaskEffect>[] {
          // The receipt window absorbs everything: no second submit, no
          // escape, no incidental key may race the canonical outcome.
          if (waiting()) return []
          if (intent.kind === "activate") return [{ kind: "effect", effect: { kind: "full-access-confirm" } }]
          return []
        },
        back: () => (waiting() ? "popped" : "root"),
        dirty: () => false,
        steps: () => ["confirm"],
        rows: () => {
          const mirror = facts().mirror
          const directories = mirror?.directories ?? []
          const overflow = directories.length > DIRECTORY_SLOTS
          const shown = directories.slice(0, overflow ? DIRECTORY_SLOTS - 1 : DIRECTORY_SLOTS)
          return [
            { label: `mode ${input.mode} — tool calls run without asking`, focused: false },
            { label: `workspace ${mirror?.workspaceRoot ?? "not reported by host"}`, focused: false },
            ...shown.map((directory) => ({ label: `additional ${directory}`, focused: false })),
            ...(overflow ? [{ label: `+${directories.length - shown.length} more directories`, focused: false }] : []),
          ]
        },
        hints: () => {
          if (waiting()) return ["waiting for the session — keys absorbed"]
          const rejected = rejection()
          if (rejected !== null) return [`switch was ${rejected} — enter retries`, "enter confirm and switch", "esc cancel"]
          return ["enter confirm and switch", "esc cancel"]
        },
      }
    },
  })
}
