/**
 * State facade: the store seam the Ink view subscribes to, plus the
 * projection view types the snapshot carries. The view imports projection
 * vocabulary only through this facade — the projection core stays owned by
 * the state layer as it absorbs the application/sessionprojection cores.
 * The composer editor kernel, the slash framework, the card shell
 * machine and the transcript line model with its viewport live here
 * too: framework-free draft, command, card and scrolling state
 * driven by keys/ intents.
 *
 * Dispatch vocabulary, three layers deep: an *Effect* is a host-bound
 * outcome of one interaction (the store returns it for the host to
 * execute); a *Result* is what one dispatched key returned to the store
 * (whether the card changed, plus its effects); an *Outcome* is a
 * whole-machine disposition (an editor submission, a card shell's
 * activated/confirmed/declined).
 *
 * Consumers of the facade, honestly: the view binds to the store and
 * snapshot vocabulary; the kernels below the store are bound by this
 * layer's own test suites, which drive them through this same public
 * seam the view routes intents through (so the tested surface is the
 * shipped surface); and the composition host binds the run queue and
 * the slash host into the embedded-session lifecycle. Nothing outside
 * may import the modules directly — the boundary gate enforces the
 * facade.
 */
export {
  COMPOSER_ROW_CAP,
  ComposerKernel,
  completionContextAt,
  expandPastedTokens,
  formatPastedToken,
  shouldCollapsePaste,
  type ComposerRenderRun,
} from "./editor.js"
export {
  createTuiStateStore,
  EFFECT_KINDS,
  isSessionIndependentEffect,
  type TuiCompletionSources,
  type TuiDeniedCall,
  type TuiEditorState,
  type TuiStateEffect,
  type TuiStateInput,
  type TuiStateSnapshot,
  type TuiStateStore,
  type TuiStateStoreOptions,
} from "./store.js"
export { RootKeyPolicy, ROOT_CONFIRM_WINDOW_MS } from "./rootkeys.js"
export {
  ChildAgentsPanel,
  EMPTY_AGENTS_VIEW,
  MAX_CHILD_ENTRIES,
  type ChildAgentStatus,
  type ChildAgentView,
  type ChildFinalizeFact,
  type ChildSpawnFact,
  type ChildToolUseFact,
  type TuiAgentsView,
  type TuiChildPanelView,
} from "./agents.js"
export { createRunQueue, type TuiRunQueueEvent } from "./runqueue.js"
export {
  TranscriptLineCache,
  TranscriptLineModel,
  type QueuedPreview,
  type TranscriptChrome,
  type TranscriptLineSpan,
  type TranscriptLayout,
} from "./lines.js"
export { SUPPORT_FLOOR } from "../text/index.js"
export { allocateFrame, transcriptCapacity, type FrameAllocation, type InputOwner } from "./layout.js"
export {
  FOLLOW_VIEWPORT,
  resolveViewport,
  viewportIndicator,
  viewportPageDown,
  viewportPageUp,
  viewportPosition,
  viewportWheelDown,
  viewportWheelUp,
  viewportResetByContent,
  viewportShowsIndicator,
  viewportWindow,
  type TranscriptViewport,
} from "./viewport.js"
export {
  footerMinimalSegments,
  footerPendingDetails,
  footerPermissionToken,
  footerSegments,
  footerStatusToken,
  formatFooterContext,
  formatFooterTokens,
  formatSessionStatus,
  permissionModeChip,
  permissionModePanelLabel,
  type FooterTelemetry,
} from "./footer.js"
export {
  CARD_STRINGS,
  CardShellMachine,
  cardAttributionLine,
  cardPickHint,
  type CardAttribution,
  type CardSnapshot,
  type CardTabModel,
} from "./card.js"
export { ThemeCard } from "./theme-card.js"
export { RewindCard, type RewindCheckpoint } from "./rewind-card.js"
export { ResumeCard, type ResumeSessionOption } from "./resume-card.js"
export { PermissionsCard, type PermissionModeOption, type PermissionRule } from "./permissions-card.js"
export { FullAccessConfirmCard, type FullAccessConfirmCardEffect } from "./confirm-card.js"
export { DiffCard, diffReviewOptions, type DiffFileOption, type DiffReviewBlock } from "./diff-card.js"
export { DocCard } from "./doc-card.js"
export { CARD_PAGE_HEIGHT, DocPager } from "./pager.js"
export { AskCard, askTabLabel, type AskRequest } from "./ask-card.js"
export { ApprovalCard, type ApprovalRequestInput } from "./approval-card.js"
export {
  CORE_SLASH_COMMANDS,
  cardSlashCommands,
  createSlashCommandRegistry,
  ensureVisibleSlashText,
  exactArgs,
  parseSlashSubmission,
  reportSlashCommands,
  resolveSlashBusyPolicy,
  slashNotice,
  slashParseErrorNotice,
  unknownSlashNotice,
  type SlashCommandDefinition,
  type SlashInput,
  type SlashResult,
  type SlashNotice,
  type SlashRuntimeReport,
  type SlashWorkspaceDiffFile,
} from "./slash.js"
export { createTuiSlashHost, type SlashDispatchStaleReason } from "./slash-host.js"
export {
  CompletionPicker,
  commandCandidates,
  mentionCandidates,
  type CompletionCandidate,
  type CompletionContext,
  type CompletionWindow,
} from "./completion.js"
export { COMMAND_PROFILE, FILE_PROFILE, matchCompletions, type CompletionItem } from "./matching.js"
export type {
  LiveTailBlock,
  PendingRun,
  SessionContent,
  ToolBlock,
  ToolStatus,
  TranscriptBlock,
  TranscriptTextBlock,
} from "../sessionprojection/index.js"
