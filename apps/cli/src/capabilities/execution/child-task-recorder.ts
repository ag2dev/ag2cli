/**
 * Durable observation port for async child settles (E1, D-E1-5).
 *
 * Composition implements this over the parent host's per-session task
 * registry: one agent-type task per async child, recorded at settle time
 * with taskId = childSessionId. The port is plain transitions — the
 * causal order (Created → Started → Output → terminal, then the
 * completion notification) belongs to the caller's serial section, and
 * failures propagate to it.
 */
import type { SessionId } from "@ag2cli/core/ids.js"

/** Task identity for one async child; the title is the spawn description. */
export interface ChildTaskRecordInput {
  readonly parentSessionId: SessionId
  readonly taskId: string
  readonly title: string
  readonly prompt: string
  readonly parentRunId?: string
}

/** Terminal shape mirroring the task registry's three closes. */
export type ChildTaskTerminal =
  | { readonly kind: "completed"; readonly runNumber: number }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled"; readonly reason?: string }

export interface ChildTaskRecorder {
  created(input: ChildTaskRecordInput): Promise<void>
  started(sessionId: SessionId, taskId: string, runNumber: number): Promise<void>
  output(sessionId: SessionId, taskId: string, chunk: string): Promise<void>
  terminal(sessionId: SessionId, taskId: string, terminal: ChildTaskTerminal): Promise<void>
}
