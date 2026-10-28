/**
 * The Theme task: a palette over the theme ids with a live query field.
 * Focus movement previews (the effect carries the candidate id; the
 * host re-themes), Enter completes with the focused theme, Escape
 * returns to the caller dismissed — an uncommitted preview rolls back
 * without a confirm because it wrote nothing. The palette is client
 * scope: nothing session- or workspace-shaped can invalidate it.
 */
import type { TuiIntent } from "../../keys/index.js"
import { ChoiceList } from "./choice-list.js"
import { SearchField } from "./search.js"
import { defineTask, type TaskDefinition, type TaskEngineEvent } from "./contracts.js"

export type ThemeTaskInput = { readonly initialThemeId: string | null }
export type ThemeTaskResult = { readonly themeId: string }
export type ThemeTaskEffect = { readonly kind: "theme-preview"; readonly themeId: string }
export type ThemeTaskDefinition = TaskDefinition<"theme", ThemeTaskInput, ThemeTaskResult, ThemeTaskEffect>

/** Compact shared-card hints keep restore and save visible beside the side preview. */
const THEME_HINTS: readonly string[] = ["esc restore", "enter save", "↑↓"]

export function createThemeTask(themes: readonly string[]): ThemeTaskDefinition {
  return defineTask({
    kind: "theme",
    scope: "client",
    create(input, kit) {
      const field = new SearchField(kit.search)
      const list = new ChoiceList({ window: 8, digits: false })
      const palette = [...themes]
      const matches = (): readonly string[] => {
        const needle = field.query.toLowerCase()
        return palette.filter((themeId) => themeId.includes(needle))
      }
      const reload = (seed: string | undefined): void => {
        list.load(
          matches().map((themeId) => ({ key: themeId, label: themeId })),
          seed === undefined ? undefined : { focus: seed },
        )
      }
      reload(input.initialThemeId ?? undefined)
      let lastPreviewed: string | null = null
      const focusEffects = (): readonly { readonly kind: "effect"; readonly effect: ThemeTaskEffect }[] => {
        const focusKey = list.focusKey
        if (focusKey === null || focusKey === lastPreviewed) return []
        lastPreviewed = focusKey
        return [{ kind: "effect", effect: { kind: "theme-preview", themeId: focusKey } }]
      }
      return {
        title: "Theme",
        scope: "client",
        composerMode: "hidden",
        input,
        identities: () => [],
        body: () => ['- const greeting = "Hello";', '+ const greeting = "Hello, world";'],
        handle(intent: TuiIntent): readonly TaskEngineEvent<ThemeTaskResult, ThemeTaskEffect>[] {
          // Text keys, paste, and the horizontal moves belong to the
          // query field; a query change reloads the palette.
          if (
            intent.kind === "input" ||
            intent.kind === "paste" ||
            (intent.kind === "navigate" && (intent.direction === "left" || intent.direction === "right"))
          ) {
            if (field.handle(intent)) reload(list.focusKey ?? undefined)
            return focusEffects()
          }
          if (intent.kind === "navigate") {
            list.dispatch(intent)
            return focusEffects()
          }
          if (intent.kind === "activate") {
            const result = list.dispatch(intent)
            if (!result.activated || list.chosenKey === null) return []
            return [{ kind: "completed", value: { themeId: list.chosenKey } }]
          }
          return []
        },
        back: () => "root",
        dirty: () => false,
        steps: () => ["palette"],
        rows: () => list.visibleRows(),
        hints: () => (list.isEmpty ? ["esc restore"] : [...THEME_HINTS]),
      }
    },
  })
}
