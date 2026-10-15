/**
 * Child approval surface adapter (composition seam): binds the child
 * approval bridge onto the TUI store's card inputs — a raised head
 * becomes an approval-request (the token as request id, disclosure
 * through the same ingress mapper the parent face uses) or an
 * open-ask-card, and a retraction becomes a close-urgent-card. The
 * attribution drops the parent session id the card surface has no use
 * for. The adapter owns no state: FIFO discipline, card versions and
 * single-winner settles stay the bridge's.
 */
import {
  createChildApprovalBridge,
  type ChildApprovalBridge,
  type ChildApprovalCard,
  type ChildAskAttribution,
} from "./child-approval-bridge.js"
import { approvalSummaryLines } from "./tui-ingress.js"
import type { TuiStateInput } from "../ui/tui/state/index.js"

const cardAttribution = (attribution: ChildAskAttribution) => ({
  childSessionId: attribution.childSessionId,
  description: attribution.description,
  ...(attribution.subagentType === undefined ? {} : { subagentType: attribution.subagentType }),
})

const childCardInput = (card: ChildApprovalCard): TuiStateInput =>
  card.kind === "approval"
    ? {
        kind: "approval-request",
        request: {
          requestId: card.token,
          toolName: card.toolName,
          summary: approvalSummaryLines(card.toolInput, card.toolName),
          version: card.version,
          attribution: cardAttribution(card.attribution),
        },
      }
    : {
        kind: "open-ask-card",
        request: {
          requestId: card.token,
          questions: card.questions,
          attribution: cardAttribution(card.attribution),
        },
      }

export function createTuiChildApprovals(dispatch: (input: TuiStateInput) => void): ChildApprovalBridge {
  return createChildApprovalBridge({
    raise: (card) => dispatch(childCardInput(card)),
    retract: (token) => dispatch({ kind: "close-urgent-card", requestId: token }),
  })
}
