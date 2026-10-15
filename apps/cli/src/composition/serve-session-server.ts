import {
  createSessionClient,
  type SessionClient,
  type SessionEventListener,
  type SessionServer,
  type SessionSubscriptionOptions,
  type SessionTransientEventListener,
} from "@ag2cli/client/session-client.js"
import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import type { SessionCommand, SessionCommandResult } from "@ag2cli/protocol/session-command.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { InProcessSessionServer } from "../interfaces/transport/in-process-session-server.js"
import type { ServeSessionCatalog } from "../infrastructure/persistence/serve-session-catalog.js"
import type { JsonServeWorkspaceRegistry } from "../infrastructure/persistence/serve-workspace-registry.js"
import { WorkspaceUnavailableError } from "../capabilities/security/workspace.js"
import { ApprovalResolutionService } from "@ag2cli/runtime/application/session/approval-resolution.js"

export type ServeWorkspaceRuntimeFactory = (workspaceId: string, workspaceRoot: string) => Promise<InProcessSessionServer>

/**
 * Routes a serve Session to the runtime selected by its registry workspaceId.
 * The host-level cwd is never consulted after the Session is created.
 */
export class ServeSessionServer implements SessionServer {
  private readonly runtimes = new Map<string, Promise<InProcessSessionServer>>()
  private readonly runtimeRoots = new Map<string, string>()
  private readonly sessionRuntimes = new Map<string, Promise<InProcessSessionServer>>()
  private readonly resolvedRuntimes = new Map<string, InProcessSessionServer>()
  private runtimeMutation: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly catalog: ServeSessionCatalog,
    private readonly registry: JsonServeWorkspaceRegistry,
    private readonly createRuntime: ServeWorkspaceRuntimeFactory,
  ) {}

  connect(value: string): SessionClient {
    return createSessionClient(this, value)
  }

  async execute(
    sessionId: SessionId,
    command: SessionCommand,
    options?: { readonly signal?: AbortSignal; readonly onAccepted?: () => void },
  ): Promise<SessionCommandResult> {
    if (command.type === "get_snapshot") {
      return { protocolVersion: 1, type: "snapshot", snapshot: await this.catalog.readSnapshot(sessionId) }
    }
    if (command.type === "read_events") {
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
    return (await this.runtimeForSession(sessionId)).execute(sessionId, command, options)
  }

  subscribe(sessionId: SessionId, afterRevision: number, listener: SessionEventListener, options?: SessionSubscriptionOptions): () => void {
    let active = true
    let unsubscribe = () => {}
    void this.runtimeForSession(sessionId)
      .then((runtime) => {
        if (active) unsubscribe = runtime.subscribe(sessionId, afterRevision, listener, options)
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribe()
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

  private async runtimeForSession(sessionId: SessionId): Promise<InProcessSessionServer> {
    const run = this.runtimeMutation.then(() => this.runtimeForSessionNow(sessionId))
    this.runtimeMutation = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async runtimeForSessionNow(sessionId: SessionId): Promise<InProcessSessionServer> {
    if (this.closed) throw new Error("serve Session server is closed")
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
    const workspace = await this.catalog.workspaceForSession(sessionId)
    if (workspace === undefined || !existsAsDirectory(workspace.workspaceRoot)) return undefined
    return this.runtimeForSession(sessionId)
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
