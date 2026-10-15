import type { SessionId } from "@ag2cli/core/ids.js"

/** Critical-section labels for diagnostics; tokens stay caller-minted. */
export type PolicySerialSection = "permission-commit" | "tool-dispatch" | "bash-spawn" | "child-task"

/**
 * Serializes the read-judge-write window that policy changes and tool
 * dispatch share on one session. A permission commit and a tool dispatch
 * section never interleave: whichever wins the queue commits first, and the
 * loser re-reads fresh state before acting.
 *
 * Concurrency contract:
 *  - FIFO per session; different sessions never block each other.
 *  - `taskId` is an explicit caller-minted token, namespaced per mint site
 *    (`permission:<commandId>`, `add-directory:<commandId>`,
 *    `dispatch:<toolUseId>`, `spawn:<toolUseId>`,
 *    `child-task:<childSessionId>`). Requesting a section
 *    whose token is currently running on the same session throws (reentry
 *    guard); a request whose earlier namesake is still queued serializes
 *    behind it. Re-acquiring a token after its previous section released is
 *    legal.
 *  - The executor's `approvalResolution.record` CAS append runs OUTSIDE this
 *    lock; only event-store reads/appends and process spawn belong inside.
 *  - Sections must initiate work, not babysit it: `fn` returns once external
 *    work is started so queued permission commits are never starved by a
 *    long-running tool execution. The same rule binds the bash spawn fence:
 *    its closure resolves when the process is STARTED, never when it exits.
 *    The same rule binds the `child-task` section: its closure resolves once
 *    a settled child agent's bounded append sequence (durable task events,
 *    then the completion notification) is committed, never while waiting on
 *    the child run itself.
 */
export interface PolicySerialPoint {
  critical<T>(sessionId: SessionId, taskId: string, section: PolicySerialSection, fn: () => Promise<T>): Promise<T>
}

/** Thrown when a task requests a section its own token is currently running. */
export class PolicySerialReentryError extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly taskId: string,
    readonly section: PolicySerialSection,
  ) {
    super(`policy serial reentry: ${taskId} already holds the ${sessionId} ${section} critical section`)
    this.name = "PolicySerialReentryError"
  }
}
