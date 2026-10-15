/**
 * Semantic write capabilities exposed to interactive clients.
 *
 * The implementation may be an in-process bridge or a remote transport. The
 * client never needs to know command discriminants, event storage, or agent
 * loop ownership to use these actions.
 */
export interface SessionInputReceipt {
  readonly inputId: string
  readonly queued: boolean
}

export type SessionCancellationStatus = "cancelled" | "cancelled-before-acceptance" | "already-delivered"

export interface SessionActions {
  submitInput(input: { readonly text: string; readonly signal?: AbortSignal }): Promise<SessionInputReceipt>
  cancelInput(input: { readonly inputId: string; readonly reason?: string }): Promise<{
    readonly inputId: string
    readonly status: SessionCancellationStatus
  }>
  steer(input: { readonly runId: string; readonly text: string }): Promise<{ readonly inputId: string }>
}

export interface SessionActionsOptions {
  readonly commandId?: () => string
}

/** Hide protocol command construction behind the semantic client seam. */
export function createSessionActions(client: SessionClient, options: SessionActionsOptions = {}): SessionActions {
  const nextCommandId = options.commandId ?? (() => globalThis.crypto.randomUUID())
  return {
    async submitInput({ text }) {
      // The local signal belongs to the UI admission handle. Aborting the
      // transport here could hide a committed receipt before the caller can
      // issue the durable cancellation by inputId.
      const result = await client.execute(startRunCommand({ commandId: nextCommandId(), goal: text }), { acceptOnly: true })
      if (result.type !== "input_accepted") throw new Error("Session did not accept the input")
      return { inputId: result.inputId, queued: result.queued }
    },
    async cancelInput({ inputId, reason }) {
      const result = await client.execute(cancelInputCommand({ commandId: nextCommandId(), inputId, reason }))
      if (result.type !== "input_cancelled") throw new Error("Session did not return input_cancelled")
      return { inputId: result.inputId, status: result.status }
    },
    async steer({ runId: value, text }) {
      const result = await client.execute(steerCommand({ commandId: nextCommandId(), runId: runId(value), text }))
      if (result.type !== "input_accepted") throw new Error("Session did not accept the steering input")
      return { inputId: result.inputId }
    },
  }
}
import { runId } from "@ag2cli/core/ids.js"
import { cancelInputCommand, startRunCommand, steerCommand } from "@ag2cli/protocol/session-command.js"
import type { SessionClient } from "./session-client.js"
