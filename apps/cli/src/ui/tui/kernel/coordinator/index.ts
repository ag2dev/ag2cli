/**
 * Coordinator owner: the dispatch entry, snapshot assembly, command
 * emission, write-eligibility ledger and the operation reconciliation
 * table. It is the only subdirectory allowed to import its siblings,
 * always through their index.ts facades; cross-subdirectory needs are
 * injected as kits from here, not imported sideways. The contract types
 * live here (in contract.ts) so internals bind without touching the
 * module facade.
 */
export { createTuiKernel, TASK_EXIT_FOCUS_HINT } from "./kernel.js"
export type { TuiSnapshotGroups } from "./snapshot.js"
export type { ChildrenView, ChildEntryView, ChildrenPanelView } from "./snapshot.js"
export type {
  TuiKernel,
  TuiInput,
  TuiCommand,
  SessionOrigin,
  OperationOrigin,
  OperationOutcome,
  OperationId,
  TuiKernelPorts,
  TuiPermissionRule,
  TuiPermissionDenial,
  TuiSnapshot,
  ChildrenFact,
  ChildStatus,
} from "./contract.js"
export type { ApprovalValue, AskQuestionFact, AskValue } from "../decisions/index.js"
export type { TuiPlanRow, TuiQueueRow } from "../session-mirror/index.js"
