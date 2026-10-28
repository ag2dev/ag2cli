import { basename } from "node:path"
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicSessionSnapshot, PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { AgentEvent } from "@ag2cli/core/events/event.js"
import { sessionId, type SessionId } from "@ag2cli/core/ids.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import { createPendingApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import { createPendingAskBroker } from "@ag2cli/runtime/ports/ask-broker.js"
import type { PlanProvider } from "@ag2cli/runtime/ports/model-provider.js"
import {
  getSnapshotCommand,
  readEventsCommand,
  type SessionCommand,
  type SessionCommandResult,
} from "@ag2cli/session-protocol/session-command.js"
import type { ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import { WorkspaceUnavailableError, workspaceIdForRoot } from "../capabilities/security/workspace.js"
import type { RuntimeConfig } from "../config/runtime.js"
import { DEFAULT_SELECTABLE_MODES } from "../interfaces/transport/app-server-rpc.js"
import { RpcApplicationError } from "../interfaces/transport/public-session-command-mapping.js"
import type { ProjectionContext } from "../interfaces/transport/public-projection.js"
import { PublicSessionProjector } from "../interfaces/transport/public-projection.js"
import { buildAgentRunRuntime } from "./agent-run-runtime.js"
import { guardianReviewDeadlineMs, pickGuardian, pickModelClient } from "./model-client.js"
import { createPublicSessionAdapter, type PublicSessionAdapter, type PublicSessionAdapterCallbacks } from "./public-session-adapter.js"
import { PublicSessionCommands } from "./public-session-commands.js"

export type { PublicSessionAdapterCallbacks }

/** Read-only commands inject this provider: reaching plan generation there is a programming error. */
const readOnlyPlanProvider: PlanProvider = {
  async generatePlan() {
    throw new Error("This read-only command must not call PlanProvider")
  },
}

export type HeadlessSessionMode = "run" | "resume" | "read"

export interface BuildPublicHeadlessSessionOptions {
  readonly runtimeConfig: RuntimeConfig
  readonly sessionId: string
  readonly mode: HeadlessSessionMode
  readonly workspaceRoot?: string
  readonly skillDir?: string
  /** A TTY surface answers approval and ask_user cards in-process through pending brokers. */
  readonly interactive?: boolean
  readonly signal?: AbortSignal
  /** Receives the child runner once the runtime assembles one (async children). */
  readonly onChildRunner?: (runner: ChildAgentRunner) => void
}

export interface PublicHeadlessSession {
  readonly sessionId: SessionId
  readonly facade: PublicSessionCommands
  /** Live public projection attachment; each call builds a fresh adapter over the host ports. */
  attach(callbacks: PublicSessionAdapterCallbacks): PublicSessionAdapter
  /** Full public event history, strictly projected (agent session events). */
  readPublicEvents(): Promise<readonly PublicSessionEvent[]>
  /** Snapshot assembly from the canonical stream, without a live attachment (inspect). */
  publicSnapshot(): Promise<PublicSessionSnapshot>
  /** Catalog record operations; record JSON stays the headless output verbatim. */
  readonly records: {
    list(): Promise<readonly unknown[]>
    get(): Promise<unknown>
    create(target: string, workspaceRoot: string): Promise<void>
    fork(target: string): Promise<unknown>
    archive(): Promise<unknown>
    delete(): Promise<void>
  }
  /** The catalog record's workspace root, for caller-side cwd consistency checks. */
  recordWorkspaceRoot(): Promise<string | undefined>
  close(): Promise<void>
}

/**
 * Headless composition: one local-durable host, its public command facade,
 * and the in-process projection adapter. The entrypoint keeps only process
 * IO and lifecycle; every session interaction crosses the public contract.
 */
export async function buildPublicHeadlessSession(options: BuildPublicHeadlessSessionOptions): Promise<PublicHeadlessSession> {
  const id = sessionId(options.sessionId)
  const guardian = options.mode === "run" || options.mode === "resume" ? await pickGuardian(options.runtimeConfig) : undefined
  const host = await buildAgentRunRuntime({
    signal: options.signal,
    runtimeConfig: options.runtimeConfig,
    ...(options.mode === "run" || options.mode === "resume" ? { sessionId: id } : {}),
    workspaceRoot: options.workspaceRoot,
    strictCapabilities: options.skillDir !== undefined,
    ...(options.skillDir === undefined ? {} : { skillRoot: options.skillDir }),
    ...(options.mode === "run" || options.mode === "resume"
      ? {
          client: await pickModelClient(options.runtimeConfig),
          // The guardian answers auto-mode asks; a run seeded with auto (or
          // resuming one) converges approval_required without it.
          guardian,
          guardianDeadlineMs: guardianReviewDeadlineMs(options.runtimeConfig),
        }
      : { provider: readOnlyPlanProvider }),
    // Non-interactive headless keeps the deny-all default: an ask with no
    // surface converges to the durable approval_required terminal.
    ...(options.interactive === true ? { approval: createPendingApprovalBroker(), ask: createPendingAskBroker() } : {}),
    ...(options.onChildRunner === undefined ? {} : { onChildRunner: options.onChildRunner }),
  })
  // "auto" is selectable only when a Guardian policy engine is wired; the
  // facade must advertise the same set the host itself would.
  const selectableModes: readonly PublicPermissionModeValue[] =
    guardian === undefined ? DEFAULT_SELECTABLE_MODES : [...DEFAULT_SELECTABLE_MODES, "auto"]

  const execute = async (command: SessionCommand): Promise<SessionCommandResult> => {
    try {
      return await host.sessionServer.execute(id, command)
    } catch (error) {
      // Direct host reads bypass the facade's classifier; workspace facts
      // must still reach the caller as typed public errors.
      if (error instanceof WorkspaceUnavailableError) {
        throw new RpcApplicationError("workspace_unavailable", error.message)
      }
      throw error
    }
  }
  const readEventsFrom = async (from: number): Promise<readonly AgentEvent[]> => {
    const result = await execute(readEventsCommand(from))
    if (result.type !== "events") throw new Error("Session did not return events")
    return result.events
  }
  const readInternalSnapshot = async (): Promise<SessionSnapshot> => {
    const result = await execute(getSnapshotCommand())
    if (result.type !== "snapshot") throw new Error("Session did not return a snapshot")
    return result.snapshot
  }
  // Host-level projection facts are fixed for this process's workspace.
  const record = await host.catalog.get(id)
  const root = record?.snapshot.workspaceRoot ?? options.workspaceRoot ?? ""
  const context: ProjectionContext = {
    ...(record?.title === undefined ? {} : { title: record.title }),
    workspace: {
      workspaceId: workspaceIdForRoot(root),
      displayName: basename(root) || workspaceIdForRoot(root),
      availability: "available",
    },
    selectableModes,
  }
  const facade = new PublicSessionCommands({
    sessionServer: host.sessionServer,
    catalog: host.catalog,
    workspaceIdForRoot,
    isWorkspaceUnavailableError: (error): error is WorkspaceUnavailableError => error instanceof WorkspaceUnavailableError,
    selectableModes,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
  })
  const recordOptions = options.signal === undefined ? {} : { signal: options.signal }

  return {
    sessionId: id,
    facade,
    attach(callbacks) {
      return createPublicSessionAdapter(
        {
          // The anchor is pinned at the pre-subscription revision: anything
          // older is pre-barrier history the callbacks suppress anyway.
          subscribe: (listener, subscriptionOptions) => {
            const anchor = record?.snapshot.lastRevision ?? 0
            const handle = host.sessionServer.subscribe(
              id,
              anchor,
              (events) => listener(events),
              subscriptionOptions === undefined ? undefined : { onOverflow: subscriptionOptions.onOverflow },
            )
            return () => handle.unsubscribe()
          },
          subscribeTransient: (listener) => host.sessionServer.subscribeTransient(id, listener),
          readEvents: readEventsFrom,
          readSnapshot: readInternalSnapshot,
          context,
        },
        callbacks,
      )
    },
    async readPublicEvents() {
      const projector = new PublicSessionProjector()
      const events: PublicSessionEvent[] = []
      for (const event of await readEventsFrom(0)) events.push(...projector.apply(event))
      return events
    },
    async publicSnapshot() {
      const projector = new PublicSessionProjector()
      for (const event of await readEventsFrom(0)) projector.apply(event)
      return projector.snapshot(await readInternalSnapshot(), context)
    },
    records: {
      list: () => host.catalog.list(recordOptions),
      get: async () => await host.catalog.get(id, recordOptions),
      create: async (target, workspaceRoot) => {
        await host.catalog.create(sessionId(target), workspaceRoot, recordOptions)
      },
      fork: async (target) => await host.catalog.fork(id, sessionId(target), undefined, recordOptions),
      archive: async () => await host.catalog.archive(id, recordOptions),
      delete: async () => {
        await host.catalog.delete(id, recordOptions)
      },
    },
    recordWorkspaceRoot: async () => (await host.catalog.get(id, recordOptions))?.snapshot.workspaceRoot,
    close: () => host.close(),
  }
}
