import {
  createSessionClient,
  type SessionClient,
  type SessionEventListener,
  type SessionServer,
  type SessionSubscriptionHandle,
  type SessionSubscriptionOptions,
  type SessionTransientEventListener,
} from "@ag2cli/session-client/session-client.js"
import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/session-protocol/session-command.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { InProcessSessionServer } from "../interfaces/transport/in-process-session-server.js"
import type { ServeSessionCatalog } from "../infrastructure/persistence/serve-session-catalog.js"
import type { JsonServeWorkspaceRegistry } from "../infrastructure/persistence/serve-workspace-registry.js"
import { WorkspaceUnavailableError } from "../capabilities/security/workspace.js"
import { ApprovalResolutionService } from "@ag2cli/runtime/application/session/approval-resolution.js"
import { AskResolutionService } from "@ag2cli/runtime/application/session/ask-resolution.js"
import { OrderedLane } from "@ag2cli/runtime/concurrency/ordered-lane.js"
import { SingleFlight } from "@ag2cli/runtime/concurrency/single-flight.js"
import { BackgroundTaskRegistry } from "@ag2cli/runtime/application/task/task-registry.js"
import { cancelOrphanedAgentTasks } from "@ag2cli/runtime/application/task/orphaned-task-recovery.js"

export type ServeWorkspaceRuntimeFactory = (workspaceId: string, workspaceRoot: string) => Promise<InProcessSessionServer>
export type ServeOrphanedTaskCancel = (sessionId: SessionId) => Promise<void>

/**
 * Routes a serve Session to the runtime selected by its registry workspaceId.
 * The host-level cwd is never consulted after the Session is created.
 */
export class ServeSessionServer implements SessionServer {
  // Resolved-value caches, not in-flight guards: runtimes are kept for
  // reuse and a session that reached a runtime skips the bypass gate, so
  // entries are externally evicted on root change and close — out of reach
  // for a run-once primitive by shape.
  private readonly runtimes = new Map<string, Promise<InProcessSessionServer>>()
  private readonly runtimeRoots = new Map<string, string>()
  private readonly sessionRuntimes = new Map<string, Promise<InProcessSessionServer>>()
  private readonly resolvedRuntimes = new Map<string, InProcessSessionServer>()
  private readonly bypassConvergence = new SingleFlight<string>()
  private readonly runtimeMutation = new OrderedLane<string>()
  private closed = false
  private readonly cancelOrphanedTasks: ServeOrphanedTaskCancel

  constructor(
    private readonly catalog: ServeSessionCatalog,
    private readonly registry: JsonServeWorkspaceRegistry,
    private readonly createRuntime: ServeWorkspaceRuntimeFactory,
    cancelOrphanedTasks?: ServeOrphanedTaskCancel,
  ) {
    this.cancelOrphanedTasks = cancelOrphanedTasks ?? defaultServeOrphanedTaskCancel(catalog)
  }

  connect(value: string): SessionClient {
    return createSessionClient(this, value)
  }

  async execute(
    sessionId: SessionId,
    command: SessionCommand,
    options?: { readonly signal?: AbortSignal; readonly onAccepted?: () => void },
  ): Promise<SessionCommandResult> {
    if (command.type === "get_snapshot") {
      await this.bypassFor(sessionId)
      return { protocolVersion: 1, type: "snapshot", snapshot: await this.catalog.readSnapshot(sessionId) }
    }
    if (command.type === "read_events") {
      await this.bypassFor(sessionId)
      const events = await this.catalog.readEvents(sessionId)
      return {
        protocolVersion: 1,
        type: "events",
        events: command.afterRevision === undefined ? events : events.filter((event) => event.revision > command.afterRevision!),
      }
    }
    if (command.type === "resolve_approval") {
      const runtime = await this.tryRuntimeForSession(sessionId)
      if (runtime !== undefined) return runtime.execute(sessionId, command, options)
      await this.bypassFor(sessionId)
      const eventStore = await this.catalog.eventStoreForSession(sessionId)
      if (eventStore === undefined) throw new Error(`Session does not exist: ${sessionId}`)
      const authority = await this.catalog.authorityForSession(sessionId)
      const resolver = new ApprovalResolutionService({
        eventStore,
        ...(authority === undefined ? {} : { authority }),
        identity: { nextEventId: () => randomUUID(), now: () => new Date().toISOString() },
      })
      await resolver.resolve({
        sessionId,
        runId: command.runId,
        turn: command.turn,
        toolUseId: command.toolUseId,
        preparedEventId: command.preparedEventId,
        expectedScopeRevision: command.expectedScopeRevision,
        expectedPolicyRevision: command.expectedPolicyRevision,
        decision: command.decision,
      })
      return { protocolVersion: 1, type: "snapshot", snapshot: await this.catalog.readSnapshot(sessionId) }
    }
    if (command.type === "resolve_ask") {
      const runtime = await this.tryRuntimeForSession(sessionId)
      if (runtime !== undefined) return runtime.execute(sessionId, command, options)
      await this.bypassFor(sessionId)
      const eventStore = await this.catalog.eventStoreForSession(sessionId)
      if (eventStore === undefined) throw new Error(`Session does not exist: ${sessionId}`)
      const authority = await this.catalog.authorityForSession(sessionId)
      const resolver = new AskResolutionService({
        eventStore,
        ...(authority === undefined ? {} : { authority }),
        identity: { nextEventId: () => randomUUID(), now: () => new Date().toISOString() },
      })
      await resolver.resolve({
        sessionId,
        runId: command.runId,
        turn: command.turn,
        toolUseId: command.toolUseId,
        outcome: command.outcome,
        ...(command.answers === undefined
          ? {}
          : {
              answers: command.answers.map((row) => ({
                header: row.header,
                selected: [...row.selected],
                ...(row.freeText === undefined ? {} : { freeText: row.freeText }),
              })),
            }),
        ...(command.contextAnswers === undefined
          ? {}
          : {
              contextAnswers: command.contextAnswers.map((row) => ({
                questionIndex: row.questionIndex,
                header: row.header,
                selected: [...row.selected],
                ...(row.freeText === undefined ? {} : { freeText: row.freeText }),
              })),
            }),
      })
      return { protocolVersion: 1, type: "snapshot", snapshot: await this.catalog.readSnapshot(sessionId) }
    }
    return (await this.runtimeForSession(sessionId)).execute(sessionId, command, options)
  }

  subscribe(
    sessionId: SessionId,
    afterRevision: number,
    listener: SessionEventListener,
    options?: SessionSubscriptionOptions,
  ): SessionSubscriptionHandle {
    let active = true
    let unsubscribe = () => {}
    // The hub registration must be awaited before any history read that
    // computes a live barrier: publishes landing between the call and the
    // deferred registration are invisible to this subscriber forever.
    const installed = new Promise<void>((resolve, reject) => {
      void this.runtimeForSession(sessionId).then(
        (runtime) => {
          if (!active) {
            resolve()
            return
          }
          unsubscribe = runtime.subscribe(sessionId, afterRevision, listener, options).unsubscribe
          resolve()
        },
        (error: unknown) => {
          // A vanished workspace root is the established degraded mode, not an
          // install failure: history-only attach must keep working without a
          // live runtime, and no runtime means no publishes the subscription
          // could miss. Genuine factory failures still surface through the
          // barrier read.
          if (error instanceof WorkspaceUnavailableError) {
            resolve()
            return
          }
          reject(error)
        },
      )
    })
    return {
      unsubscribe: () => {
        active = false
        unsubscribe()
      },
      installed,
    }
  }

  subscribeTransient(sessionId: SessionId, listener: SessionTransientEventListener): () => void {
    let active = true
    let unsubscribe = () => {}
    void this.runtimeForSession(sessionId)
      .then((runtime) => {
        if (active && runtime.subscribeTransient) unsubscribe = runtime.subscribeTransient(sessionId, listener)
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribe()
    }
  }

  readTransient(sessionId: SessionId): readonly import("@ag2cli/core/events/transient.js").TransientStreamEvent[] {
    const runtime = this.sessionRuntimes.get(sessionId.toString())
    if (runtime === undefined) return []
    const resolved = this.resolvedRuntimes.get(sessionId.toString())
    if (resolved !== undefined) return resolved.readTransient(sessionId)
    void runtime.then((value) => this.resolvedRuntimes.set(sessionId.toString(), value)).catch(() => {})
    return []
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const runtimes = await Promise.allSettled([...this.runtimes.values()])
    for (const result of runtimes) {
      if (result.status === "fulfilled") await result.value.close().catch(() => {})
    }
    this.runtimes.clear()
    this.runtimeRoots.clear()
    this.sessionRuntimes.clear()
    this.resolvedRuntimes.clear()
  }

  private runtimeForSession(sessionId: SessionId): Promise<InProcessSessionServer> {
    return this.runtimeMutation.run("mutation", () => this.runtimeForSessionNow(sessionId))
  }

  private async runtimeForSessionNow(sessionId: SessionId): Promise<InProcessSessionServer> {
    if (this.closed) throw new Error("serve Session server is closed")
    // A birth for a session whose bypass convergence is still in flight must
    // wait for it: the bypass scan cannot tell an orphan from a live child
    // task, and the birth's first command may spawn one between the bypass
    // entry check and the runtime start.
    // A failed scan must not fail the birth; the next read touch retries it.
    const bypass = this.bypassConvergence.peek(sessionId.toString())
    if (bypass !== undefined) await bypass.catch(() => {})
    const record = await this.catalog.get(sessionId)
    if (record === undefined || record.workspaceId === undefined)
      throw new Error(`Session does not exist or is missing workspaceId: ${sessionId}`)
    const workspace = await this.registry.get(record.workspaceId)
    if (workspace === undefined) throw new Error(`workspaceId does not exist: ${record.workspaceId}`)
    if (!existsAsDirectory(workspace.workspaceRoot)) throw new WorkspaceUnavailableError(workspace.workspaceRoot)
    let runtimePromise = this.runtimes.get(workspace.workspaceId)
    const previousRoot = this.runtimeRoots.get(workspace.workspaceId)
    if (runtimePromise !== undefined && previousRoot !== workspace.workspaceRoot) {
      const previousRuntime = await runtimePromise
      await previousRuntime.close().catch(() => {})
      this.runtimes.delete(workspace.workspaceId)
      this.runtimeRoots.delete(workspace.workspaceId)
      this.resolvedRuntimes.delete(workspace.workspaceId)
      for (const [sessionKey, sessionRuntime] of this.sessionRuntimes) {
        if (sessionRuntime === runtimePromise) {
          this.sessionRuntimes.delete(sessionKey)
          this.resolvedRuntimes.delete(sessionKey)
        }
      }
      runtimePromise = undefined
    }
    if (runtimePromise === undefined) {
      runtimePromise = this.createRuntime(workspace.workspaceId, workspace.workspaceRoot)
      this.runtimes.set(workspace.workspaceId, runtimePromise)
      this.runtimeRoots.set(workspace.workspaceId, workspace.workspaceRoot)
      // A transient factory failure must not poison the workspace until the
      // Host restarts: evict the rejected promise so the next Session retries
      // runtime creation. The identity guard keeps a root-change replacement.
      void runtimePromise.catch(() => {
        if (this.runtimes.get(workspace.workspaceId) !== runtimePromise) return
        this.runtimes.delete(workspace.workspaceId)
        this.runtimeRoots.delete(workspace.workspaceId)
      })
    }
    const runtime = await runtimePromise
    this.resolvedRuntimes.set(workspace.workspaceId, runtime)
    this.sessionRuntimes.set(sessionId.toString(), runtimePromise)
    this.resolvedRuntimes.set(sessionId.toString(), runtime)
    return runtime
  }

  private async tryRuntimeForSession(sessionId: SessionId): Promise<InProcessSessionServer | undefined> {
    // A runtime that already served this Session stays the resolution path
    // even after its workspace root disappears: its hub still holds live
    // subscribers and its broker still holds the waiting executor, so the
    // degraded fallback (no publish, no wake) would strand both.
    const memoized = this.resolvedRuntimes.get(sessionId.toString())
    if (memoized !== undefined) return memoized
    const workspace = await this.catalog.workspaceForSession(sessionId)
    if (workspace === undefined || !existsAsDirectory(workspace.workspaceRoot)) return undefined
    return this.runtimeForSession(sessionId)
  }

  private async bypassFor(sessionId: SessionId): Promise<void> {
    const key = sessionId.toString()
    // Only the O(1) entry checks run on the mutation lane. The entry is
    // captured inside the body rather than returned because a returned
    // thenable would be adopted and hold the lane for the full-stream
    // body's duration, serializing every other session's first read and
    // birth behind it.
    let entry: Promise<void> | undefined
    await this.runtimeMutation.run("mutation", async () => {
      entry = this.ensureBypassEntry(key, sessionId)
    })
    if (entry !== undefined) await entry.catch(() => {})
  }

  private ensureBypassEntry(key: string, sessionId: SessionId): Promise<void> | undefined {
    // A session that ever reached a runtime is owned by that runtime's own
    // convergence guard: this scan cannot distinguish an orphan from a live
    // child task the runtime's recovered run spawned after its birth.
    if (this.sessionRuntimes.has(key) || this.resolvedRuntimes.has(key)) return undefined
    // Join evicts a failed scan so a later touch retries it; readers
    // swallow the rejection because the read's own failure surface governs.
    return this.bypassConvergence.join(key, () => this.cancelOrphanedTasks(sessionId))
  }
}

function defaultServeOrphanedTaskCancel(catalog: ServeSessionCatalog): ServeOrphanedTaskCancel {
  return async (sessionId) => {
    const eventStore = await catalog.eventStoreForSession(sessionId)
    if (eventStore === undefined) return
    const authority = await catalog.authorityForSession(sessionId)
    if (authority === undefined) return
    const registry = new BackgroundTaskRegistry({
      eventStore,
      authority,
      identity: { nextEventId: () => randomUUID(), now: () => new Date().toISOString() },
    })
    await cancelOrphanedAgentTasks({ registry, sessionId })
  }
}

function existsAsDirectory(root: string): boolean {
  try {
    return requireFsStat(root)
  } catch {
    return false
  }
}

function requireFsStat(root: string): boolean {
  // Keep the router synchronous at the SessionServer boundary; the actual
  // file-bound runtime is still constructed lazily only after this check.
  return statSync(root).isDirectory()
}
