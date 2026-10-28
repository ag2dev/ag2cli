/**
 * The pending-decision chooser: the reopen face for collapsed leases.
 * Rows seed at open and re-read the live probe, so a lease resolved
 * elsewhere shrinks out of the list instead of offering a dead row.
 * Enter completes with the chosen request id — the reopen itself is
 * the kernel's, guarded at delivery time against an external winner.
 * Session scope by nature: the leases die with the binding, so the
 * card never outlives its rows.
 */
import type { TuiIntent } from "../../keys/index.js"
import type { PendingDecisionRowView, TaskDefinition, TaskEngineEvent } from "./contracts.js"
import { ChoiceList } from "./choice-list.js"
import { defineTask } from "./contracts.js"

export type PendingChooserInput = { readonly rows: readonly PendingDecisionRowView[] }
export type PendingChooserResult = { readonly requestId: string }
/** Declared for the engine shape only: the chooser emits no effects. */
export type PendingChooserEffect = { readonly kind: "reopen" }
export type PendingChooserDefinition = TaskDefinition<"chooser", PendingChooserInput, PendingChooserResult, PendingChooserEffect>

const EMPTY_ROW = "no pending decisions"

export function createPendingChooserTask(): PendingChooserDefinition {
  return defineTask({
    kind: "chooser",
    scope: "session",
    create(input, kit) {
      const list = new ChoiceList({ window: 8, digits: true })
      const rows = (): readonly PendingDecisionRowView[] => {
        // The probe is the live lease table; the seed covers the
        // probe-less harness so the card still renders its input.
        return kit.pendingDecisions === undefined ? input.rows : kit.pendingDecisions().rows
      }
      const reload = (): void => {
        list.load(
          rows().map((row) => ({ key: row.requestId, label: row.label, description: row.kind })),
          // Re-seed focus onto the held row so a shrink never jumps
          // the picker.
          list.focusKey === null ? undefined : { focus: list.focusKey },
        )
      }
      reload()
      return {
        title: "Pending decisions",
        scope: "session",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent): readonly TaskEngineEvent<PendingChooserResult, PendingChooserEffect>[] {
          reload()
          const result = list.dispatch(intent)
          if (result.activated && list.chosenKey !== null) {
            return [{ kind: "completed", value: { requestId: list.chosenKey } }]
          }
          return []
        },
        back: () => "root",
        dirty: () => false,
        steps: () => ["pending"],
        rows: () => {
          reload()
          if (!list.isEmpty) return list.visibleRows()
          // An empty probe row is an honest empty: nothing pends.
          return [{ label: EMPTY_ROW, focused: false }]
        },
        hints: () => {
          reload()
          return list.hints(["enter opens the chosen decision"])
        },
      }
    },
  })
}
