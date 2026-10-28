/**
 * Tasks owner: the task registry, the navigator with its back-stack
 * and dirty guard, the ChoiceList/Search engines and the feature task
 * definitions. SearchField runs on the fields editor kernel injected
 * as a kit by the coordinator — never imported sideways.
 */
export type {
  DeliveredCompletion,
  PagerKit,
  SearchEditor,
  SearchEditorKit,
  SearchCandidate,
  TaskComposerMode,
  TaskBackResult,
  TaskCompletion,
  TaskDefinition,
  TaskEngine,
  TaskEngineEvent,
  TaskKit,
  TaskPagerView,
  TaskScope,
  TaskTabsView,
} from "./contracts.js"
export { defineTask } from "./contracts.js"
export type {
  AnyTaskEffect,
  PauseOutcome,
  PausedTaskRef,
  TaskBackOutcome,
  TaskDelivery,
  TaskDispatch,
  TaskEntries,
  TaskInputOf,
  TaskOrigin,
  TaskPathNode,
  TaskPredicate,
  TaskResultOf,
  TaskRuling,
  TaskTicket,
} from "./navigator.js"
export { TaskNavigator } from "./navigator.js"
export type { TaskFrameSnapshot, TaskFrameSource } from "./task-frame.js"
export { taskFrameSnapshot } from "./task-frame.js"
export type { ChoiceItem, ChoiceListOptions, ChoiceListResult } from "./choice-list.js"
export { ChoiceList } from "./choice-list.js"
export { SearchField } from "./search.js"
export type {
  PendingDecisionRowView,
  PermissionDenialView,
  PermissionRuleView,
  PermissionTaskFacts,
  PromptHistoryEntryView,
  ResumeSessionRowView,
  RewindCheckpointView,
} from "./contracts.js"
export { noPermissionFacts } from "./contracts.js"
export type { ConfirmTaskDefinition, ConfirmTaskEffect, ConfirmTaskInput, ConfirmTaskResult } from "./confirm.js"
export { createConfirmTask } from "./confirm.js"
export type {
  PermissionsTab,
  PermissionsTaskDefinition,
  PermissionsTaskEffect,
  PermissionsTaskInput,
  PermissionsTaskResult,
} from "./permissions.js"
export { createPermissionsTask, nextPermissionMode, PERMISSION_MODE_RING } from "./permissions.js"
export type { DiffFile, DiffTaskDefinition, DiffTaskEffect, DiffTaskInput, DiffTaskResult } from "./diff.js"
export { createDiffTask } from "./diff.js"
export type { DocumentTaskDefinition, DocumentTaskEffect, DocumentTaskInput, DocumentTaskResult } from "./document.js"
export { createDocumentTask } from "./document.js"
export type { ThemeTaskDefinition, ThemeTaskEffect, ThemeTaskInput, ThemeTaskResult } from "./theme.js"
export { createThemeTask } from "./theme.js"
export type { RewindTaskDefinition, RewindTaskEffect, RewindTaskInput, RewindTaskResult } from "./rewind.js"
export { createRewindTask } from "./rewind.js"
export type { ResumeTaskDefinition, ResumeTaskEffect, ResumeTaskInput, ResumeTaskResult } from "./resume.js"
export { createResumeTask } from "./resume.js"
export type {
  PromptHistoryTaskDefinition,
  PromptHistoryTaskEffect,
  PromptHistoryTaskInput,
  PromptHistoryTaskResult,
} from "./prompt-history.js"
export { createPromptHistoryTask } from "./prompt-history.js"
export type { PendingChooserDefinition, PendingChooserEffect, PendingChooserInput, PendingChooserResult } from "./chooser.js"
export { createPendingChooserTask } from "./chooser.js"
