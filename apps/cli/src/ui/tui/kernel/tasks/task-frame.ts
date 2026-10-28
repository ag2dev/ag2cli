/**
 * TaskFrame: the composed frame of the live task — the invocation
 * path, the engine's own steps, its hints and its dirty flag — as one
 * snapshot the view renders. Composition only: the frame holds no
 * state of its own and moves only when the navigator or the engine
 * move.
 */
import type { TaskTabsView } from "./contracts.js"

export interface TaskFrameSource {
  path(): readonly { readonly title: string }[]
  topTitle(): string | null
  topSteps(): readonly string[]
  topHints(): readonly string[]
  topDirty(): boolean
  /** The top engine's body lines; engines without a body surface report none. */
  topBody(): readonly string[]
  topTabs?(): TaskTabsView | undefined
}

export interface TaskFrameSnapshot {
  readonly title: string
  /** Invocation titles from the root caller to the live task. */
  readonly path: readonly string[]
  /** Engine-internal steps of the live task, innermost last. */
  readonly steps: readonly string[]
  readonly hints: readonly string[]
  readonly dirty: boolean
  /** The top engine's body lines (paged documents, tab annotations). */
  readonly body: readonly string[]
  readonly tabs?: TaskTabsView
}

export function taskFrameSnapshot(source: TaskFrameSource): TaskFrameSnapshot | null {
  const title = source.topTitle()
  if (title === null) return null
  const tabs = source.topTabs?.()
  return {
    title,
    path: source.path().map((node) => node.title),
    steps: [...source.topSteps()],
    hints: [...source.topHints()],
    dirty: source.topDirty(),
    body: [...source.topBody()],
    ...(tabs === undefined ? {} : { tabs }),
  }
}
