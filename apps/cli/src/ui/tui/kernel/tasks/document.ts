/**
 * The read-only document task: fixed-height logical pages over a line
 * document, the carrier for /help, /status, /provider and /context.
 * Line keys scroll within a page and cross page boundaries, page keys
 * and the horizontal moves jump whole pages. Escape at the root ends
 * the invocation immediately — a read-only view holds nothing to
 * guard, so Back can repeat straight through a stack of documents.
 */
import type { TuiIntent } from "../../keys/index.js"
import { defineTask, type TaskDefinition, type TaskPagerView } from "./contracts.js"

export type DocumentTaskInput = { readonly title: string; readonly lines: readonly string[] }
/** Read-only browsing; no keyboard path completes it. */
export type DocumentTaskResult = null
export type DocumentTaskEffect = { readonly kind: string }
export type DocumentTaskDefinition = TaskDefinition<"document", DocumentTaskInput, DocumentTaskResult, DocumentTaskEffect>

export function createDocumentTask(): DocumentTaskDefinition {
  return defineTask({
    kind: "document",
    scope: "client",
    create(input, kit) {
      let lines = kit.pager.wrapLines?.(input.lines) ?? input.lines
      let pageHeight = kit.pager.pageHeight?.() ?? 7
      let pager: TaskPagerView = kit.pager.create(lines, pageHeight)
      const syncPager = (): void => {
        const nextLines = kit.pager.wrapLines?.(input.lines) ?? input.lines
        const nextHeight = kit.pager.pageHeight?.() ?? pageHeight
        const linesChanged = nextLines.length !== lines.length || nextLines.some((line, index) => line !== lines[index])
        if (!linesChanged && nextHeight === pageHeight) return
        const anchor = pager.anchorRow()
        lines = nextLines
        pager = kit.pager.create(lines, nextHeight)
        pager.restoreRow(anchor)
        pageHeight = nextHeight
      }
      return {
        title: input.title,
        scope: "client",
        composerMode: "hidden",
        input,
        identities: () => [],
        handle(intent: TuiIntent) {
          syncPager()
          if (intent.kind === "navigate") pager.move(intent.direction)
          else if (intent.kind === "wheel") pager.move(intent.direction)
          return []
        },
        back: () => "root",
        dirty: () => false,
        // The document is a transport task, not a user-facing navigation level.
        steps: () => [],
        body: () => {
          syncPager()
          return [...pager.pageLines()]
        },
        hints: () => {
          syncPager()
          return pager.pageCount > 1 ? [`page ${pager.pageNumber}/${pager.pageCount}`, "esc back"] : ["esc back"]
        },
      }
    },
  })
}
