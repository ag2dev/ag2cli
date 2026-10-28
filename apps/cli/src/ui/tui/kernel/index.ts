/**
 * The kernel facade: the one seam the composition roots and bootstrap
 * are allowed to see. It is a pure re-export of the coordinator's
 * contract — nothing inside the tree may import this file back, so the
 * types live beside their implementation and only their names surface
 * here. Every member is contract: adding, removing or reshaping one is
 * a contract change and moves the seam tests with it.
 */
export { createTuiKernel, TASK_EXIT_FOCUS_HINT } from "./coordinator/index.js"
export type {
  TuiKernel,
  TuiInput,
  TuiCommand,
  SessionOrigin,
  TuiKernelPorts,
  TuiSnapshot,
  TuiQueueRow,
  TuiPlanRow,
  ChildStatus,
  ApprovalValue,
  AskQuestionFact,
  AskValue,
} from "./coordinator/index.js"
