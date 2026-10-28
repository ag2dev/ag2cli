/**
 * The Rewind task: the checkpoint picker over the session's accepted
 * inputs. Rows arrive newest first from the history probe and stay
 * live, Enter rewinds through the canonical command (the effect
 * carries the checkpoint; the host owns the run), and the invocation
 * ends the moment the command left — the restored draft and the
 * status line land with the canonical outcome, not here.
 */
import type { TuiIntent } from "../../keys/index.js"
import type { RewindCheckpointView, TaskDefinition, TaskEngineEvent } from "./contracts.js"
import { ChoiceList } from "./choice-list.js"
import { defineTask } from "./contracts.js"

export type RewindTaskInput = Record<string, never>
export type RewindTaskResult = { readonly kind: "closed" }
export type RewindTaskEffect = { readonly kind: "rewind-checkpoint"; readonly checkpoint: string }
export type RewindTaskDefinition = TaskDefinition<"rewind", RewindTaskInput, RewindTaskResult, RewindTaskEffect>

const EMPTY_ROW = "no checkpoints yet"

function formatAcceptedAt(value: string): string {
  const instant = new Date(value)
  return Number.isFinite(instant.valueOf()) ? instant.toISOString().replace("T", " ").replace("Z", " UTC") : value
}

export function createRewindTask(): RewindTaskDefinition {
  return defineTask({
    kind: "rewind",
    scope: "session",
    create(input, kit) {
      const list = new ChoiceList({ window: 8 })
      const checkpoints = (): readonly RewindCheckpointView[] => kit.history?.().rewindCheckpoints ?? []
      const reload = (): void => {
        list.load(
          checkpoints().map((row) => ({
            key: row.checkpoint,
            label: row.acceptedAt === undefined ? row.label : `${formatAcceptedAt(row.acceptedAt)} · ${row.label}`,
          })),
          // Re-seed focus onto the held row so a projection push that
          // changes the list never jumps the picker.
          list.focusKey === null ? undefined : { focus: list.focusKey },
        )
      }
      reload()
      return {
        title: "Rewind",
        scope: "session",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent): readonly TaskEngineEvent<RewindTaskResult, RewindTaskEffect>[] {
          reload()
          const result = list.dispatch(intent)
          if (result.activated && list.chosenKey !== null) {
            return [
              { kind: "effect", effect: { kind: "rewind-checkpoint", checkpoint: list.chosenKey } },
              { kind: "completed", value: { kind: "closed" } },
            ]
          }
          return []
        },
        back: () => "root",
        dirty: () => false,
        steps: () => ["checkpoints"],
        rows: () => {
          reload()
          if (list.isEmpty) return [{ label: EMPTY_ROW, focused: false }]
          return list.visibleRows()
        },
        hints: () => {
          reload()
          return list.hints(["enter rewind here"])
        },
      }
    },
  })
}
