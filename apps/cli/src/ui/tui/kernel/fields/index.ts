/**
 * Fields owner: the editor, completion and matching kernels — the
 * draft, its companion picker and the scoring the host-injected
 * completion sources feed. The completion-source injection face below
 * is the port-side vocabulary the host supplies candidates through.
 */
export {
  COMPOSER_ROW_CAP,
  ComposerKernel,
  completionContextAt,
  expandPastedTokens,
  formatPastedToken,
  shouldCollapsePaste,
  type ComposerCompletionContext,
  type ComposerCompletionExpectation,
  type ComposerCompletionKind,
  type ComposerKernelOptions,
  type ComposerOutcome,
  type ComposerRender,
  type ComposerRenderRun,
} from "./editor.js"
export {
  CompletionPicker,
  MAX_MENTION_CANDIDATES,
  commandCandidates,
  mentionCandidates,
  type CompletionCandidate,
  type CompletionContext,
  type CompletionWindow,
  type PickerOutcome,
} from "./completion.js"
export {
  COMMAND_PROFILE,
  FILE_PROFILE,
  matchCompletions,
  type CompletionField,
  type CompletionItem,
  type CompletionItemKind,
  type CompletionProfile,
  type FieldMatch,
  type MatchResult,
} from "./matching.js"
import type { CompletionItem } from "./matching.js"

/** Mention and command corpora, injected; absence simply yields no candidates. */
export interface TuiCompletionSources {
  readonly mention?: () => readonly CompletionItem[]
  readonly command?: () => readonly CompletionItem[]
}
