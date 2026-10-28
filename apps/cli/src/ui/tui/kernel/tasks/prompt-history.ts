/**
 * The Ctrl+R prompt-history picker. Search uses the coordinator's fuzzy
 * matcher, rows remain newest-first when scores tie, and Enter returns the original
 * prompt text without mutating the composer itself.
 */
import type { TuiIntent } from "../../keys/index.js"
import type { PromptHistoryEntryView, TaskDefinition, TaskEngineEvent } from "./contracts.js"
import { ChoiceList } from "./choice-list.js"
import { defineTask } from "./contracts.js"
import { SearchField } from "./search.js"

export type PromptHistoryTaskInput = Record<string, never>
export type PromptHistoryTaskResult = { readonly kind: "picked"; readonly text: string }
export type PromptHistoryTaskEffect = never
export type PromptHistoryTaskDefinition = TaskDefinition<
  "prompt-history",
  PromptHistoryTaskInput,
  PromptHistoryTaskResult,
  PromptHistoryTaskEffect
>

const EMPTY_ROW = "no prompt history yet"

function formatSubmittedAt(value: string): string {
  const instant = new Date(value)
  return Number.isFinite(instant.valueOf()) ? `${instant.toISOString().replace("T", " ").replace("Z", " UTC")}` : value
}

function rowPreview(text: string): string {
  const folded = text.replaceAll(/\s+/gu, " ").trim()
  return folded.length > 64 ? `${folded.slice(0, 63)}…` : folded
}

function previewLines(text: string): readonly string[] {
  const lines = text.split("\n")
  const visible = lines.slice(0, 6)
  return lines.length > visible.length ? [...visible, `… ${lines.length - visible.length} more lines`] : visible
}

export function createPromptHistoryTask(): PromptHistoryTaskDefinition {
  return defineTask({
    kind: "prompt-history",
    scope: "client",
    create(input, kit) {
      const search = new SearchField(kit.search)
      const list = new ChoiceList({ window: 8, digits: false })
      let matches: readonly PromptHistoryEntryView[] = []
      const history = (): readonly PromptHistoryEntryView[] => kit.promptHistory?.() ?? []

      const reload = (): void => {
        const entries = history()
        const byId = new Map(entries.map((entry) => [entry.id, entry] as const))
        const ranked = kit.rankText(
          search.query,
          entries.map(({ id, text }) => ({ id, text })),
        )
        matches = ranked.flatMap((id) => {
          const entry = byId.get(id)
          return entry === undefined ? [] : [entry]
        })
        const currentFocus = list.focusKey
        list.load(
          matches.length === 0
            ? [{ key: "empty", label: EMPTY_ROW, disabled: true }]
            : matches.map((entry) => ({
                key: entry.id,
                label: `${formatSubmittedAt(entry.submittedAt)} · ${rowPreview(entry.text)}`,
              })),
          currentFocus === null ? undefined : { focus: currentFocus },
        )
      }

      const queryIntent = (intent: TuiIntent): boolean => {
        if (intent.kind === "paste") return true
        if (intent.kind !== "input") return false
        return (
          intent.event.type === "char" ||
          intent.event.type === "backspace" ||
          intent.event.type === "delete" ||
          intent.event.type === "ctrl"
        )
      }

      reload()
      return {
        title: "Prompt history",
        scope: "client",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent): readonly TaskEngineEvent<PromptHistoryTaskResult, PromptHistoryTaskEffect>[] {
          if (intent.kind === "activate") {
            reload()
            const result = list.dispatch(intent)
            const selected = result.activated ? matches.find((entry) => entry.id === list.chosenKey) : undefined
            if (selected === undefined) return []
            return [{ kind: "completed", value: { kind: "picked", text: selected.text } }]
          }

          if (intent.kind === "navigate" && (intent.direction === "left" || intent.direction === "right")) {
            search.handle(intent)
            reload()
            return []
          }

          if (queryIntent(intent)) {
            search.handle(intent)
            reload()
            return []
          }

          list.dispatch(intent)
          return []
        },
        back: () => "root",
        dirty: () => false,
        steps: () => [search.query.length === 0 ? "type to search" : `search · ${search.query}`],
        rows: () => {
          reload()
          return list.visibleRows()
        },
        body: () => {
          reload()
          const selected = matches.find((entry) => entry.id === list.focusKey)
          if (selected === undefined) return []
          return [`submitted ${formatSubmittedAt(selected.submittedAt)}`, ...previewLines(selected.text)]
        },
        hints: () => {
          reload()
          return list.isEmpty ? ["esc back", "type to search"] : list.hints(["enter insert", "type to search"])
        },
      }
    },
  })
}
