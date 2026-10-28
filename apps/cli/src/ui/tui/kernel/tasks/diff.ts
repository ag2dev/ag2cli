/**
 * The Diff task: a changed-file list with a query field and a paged
 * preview stacked as a second step. Enter adopts the focused file's
 * detail document; Escape pops one level — detail back to the list
 * with its query and focus intact, the list back to the caller. Files
 * are navigation units, not a pick-one answer, so the task never
 * completes from the keyboard; it is a browser that ends dismissed or
 * invalidated. Workspace scope: a different workspace invalidates it.
 */
import type { TuiIntent } from "../../keys/index.js"
import { ChoiceList } from "./choice-list.js"
import { SearchField } from "./search.js"
import { defineTask, type TaskDefinition, type TaskPagerView, type TaskRowView } from "./contracts.js"

export interface DiffFile {
  readonly path: string
  readonly description?: string
  readonly detail: readonly string[]
}

export type DiffTaskInput = { readonly workspaceId: string; readonly files: readonly DiffFile[]; readonly loading?: boolean }
/** A read-only browser: no keyboard path completes it, so the result type is null on purpose. */
export type DiffTaskResult = null
export type DiffTaskEffect = { readonly kind: string }
export type DiffTaskDefinition = TaskDefinition<"diff", DiffTaskInput, DiffTaskResult, DiffTaskEffect>

const LIST_STEP = "files"
const DETAIL_STEP = "detail"
const PAGE_HEIGHT = 7
/** The list window; matches the ChoiceList window so the rows and the digit shortcuts address the same slice. */
const LIST_WINDOW = 8

function sameFiles(left: readonly DiffFile[], right: readonly DiffFile[]): boolean {
  return (
    left.length === right.length &&
    left.every((file, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        file.path === other.path &&
        file.description === other.description &&
        file.detail.length === other.detail.length &&
        file.detail.every((line, lineIndex) => line === other.detail[lineIndex])
      )
    })
  )
}

export function createDiffTask(): DiffTaskDefinition {
  return defineTask({
    kind: "diff",
    scope: "workspace",
    create(input, kit) {
      const field = new SearchField(kit.search)
      const list = new ChoiceList()
      const identity = `workspace:${input.workspaceId}`
      let files = input.files
      const matches = (): readonly DiffFile[] => {
        const needle = field.query.toLowerCase()
        return files.filter((file) => file.path.toLowerCase().includes(needle))
      }
      const reload = (seed: string | undefined): void => {
        list.load(
          matches().map((file) => ({
            key: file.path,
            label: file.path,
            ...(file.description === undefined ? {} : { description: file.description }),
          })),
          seed === undefined ? undefined : { focus: seed },
        )
      }
      reload(undefined)
      let preview: { readonly path: string; readonly pager: TaskPagerView } | null = null
      const openDetail = (path: string): void => {
        const file = files.find((candidate) => candidate.path === path)
        if (file === undefined) return
        preview = { path, pager: kit.pager.create(file.detail, PAGE_HEIGHT) }
      }
      // The surfaced rows are the visible window of the current matches,
      // derived from the list's own focus and window start so the rows,
      // the digits, and the focus can never disagree.
      const windowRows = (): readonly TaskRowView[] => {
        const files = matches()
        const focus = list.focusIndex ?? Math.min(0, files.length - 1)
        const start = Math.min(Math.max(0, focus - LIST_WINDOW + 1), Math.max(0, files.length - LIST_WINDOW))
        return files.slice(start, start + LIST_WINDOW).map((file, position) => {
          const focused = start + position === focus
          return { label: file.path, ...(file.description === undefined ? {} : { description: file.description }), focused }
        })
      }
      const refresh = (): void => {
        const live = kit.diffFiles?.()
        if (live === undefined || sameFiles(files, live)) return
        files = live
        reload(list.focusKey ?? undefined)
      }
      return {
        title: "Changes",
        scope: "workspace",
        composerMode: "hidden",
        input,
        identities: () => [identity],
        handle(intent: TuiIntent) {
          refresh()
          if (preview !== null) {
            if (intent.kind === "navigate") preview.pager.move(intent.direction)
            else if (intent.kind === "wheel") preview.pager.move(intent.direction)
            return []
          }
          if (
            intent.kind === "input" ||
            intent.kind === "paste" ||
            (intent.kind === "navigate" && (intent.direction === "left" || intent.direction === "right"))
          ) {
            if (field.handle(intent)) reload(list.focusKey ?? undefined)
            return []
          }
          if (intent.kind === "navigate") {
            list.dispatch(intent)
            return []
          }
          if (intent.kind === "activate") {
            const result = list.dispatch(intent)
            if (result.activated && list.chosenKey !== null) openDetail(list.chosenKey)
            return []
          }
          return []
        },
        back() {
          if (preview !== null) {
            // Detail returns to the list; the query and focus were never touched.
            preview = null
            return "popped"
          }
          return "root"
        },
        dirty: () => false,
        steps: () => (preview === null ? [LIST_STEP] : [LIST_STEP, `${DETAIL_STEP}:${preview.path}`]),
        rows: () => {
          if (preview !== null) return []
          if (kit.diffFiles?.() === undefined && input.loading === true) return [{ label: "loading workspace changes…", focused: false }]
          refresh()
          const rows = windowRows()
          return rows.length === 0 ? [{ label: "no workspace changes", focused: false }] : rows
        },
        body: () => (preview === null ? [] : [...preview.pager.pageLines()]),
        hints: () => {
          if (preview !== null) return [`page ${preview.pager.pageNumber}/${preview.pager.pageCount}`, "esc back"]
          // Keep the primary navigation and exit affordances intact at
          // 40 columns; the list's digit shortcuts remain active but are
          // secondary and are omitted from this constrained hint row.
          const hints = ["esc back", "up/down", "enter open"]
          if (field.query.length > 0) hints.push(`find: ${field.query}`)
          return hints
        },
      }
    },
  })
}
