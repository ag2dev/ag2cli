/**
 * Decisions owner: ask/approval disclosure facts, request identity and
 * the lease lifecycle. Ask and approval resolution values stay
 * distinct types so an ask answer can never cross into an approval
 * slot; the resolve commands carry these shapes.
 */
export type {
  ApprovalFact,
  ApprovalOptionFact,
  ApprovalValue,
  AskFact,
  AskOptionFact,
  AskQuestionFact,
  AskValue,
  DecisionFact,
  RequestIdentity,
} from "./facts.js"
export type { DecisionLease, LeaseEvent } from "./lease.js"
export { DecisionLeases, initialLease, needsReview, reduceLease, withAnswer } from "./lease.js"
