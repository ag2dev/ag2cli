import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import { DEFAULT_SESSION_PERMISSION_MODE } from "@ag2cli/core/session/session-security.js"
import type { EventStore } from "../../ports/event-store.js"
import type { PolicySerialPoint } from "../../ports/policy-serial-point.js"
import type { WorkspaceScopeDigest } from "../../ports/workspace.js"
import { appendSessionEventsIfRevision } from "./revision-conflict.js"
import { SessionAuthority } from "./session-authority.js"
import { commandIdempotencyConflictError, resolveCommandIdempotency, type CommandIdempotencyFamily } from "./command-idempotency.js"

export const ADDITIONAL_DIRECTORY_FAMILY = "add_additional_directory"

type AdditionalDirectoryFingerprint = {
  readonly requestedDirectory: string
  readonly workspaceRoot: string
}

export const ADDITIONAL_DIRECTORY_IDEMPOTENCY_FAMILY: CommandIdempotencyFamily<AdditionalDirectoryFingerprint> = {
  family: ADDITIONAL_DIRECTORY_FAMILY,
  findAnchor(events, commandId) {
    const event = events.find(
      (candidate): candidate is Extract<AgentEvent, { type: "SessionAdditionalDirectoryAdded" }> =>
        candidate.type === "SessionAdditionalDirectoryAdded" && candidate.payload.commandId === commandId,
    )
    if (event === undefined) return undefined
    const created = events.find(
      (candidate): candidate is Extract<AgentEvent, { type: "SessionCreated" }> => candidate.type === "SessionCreated",
    )
    return {
      event,
      inputFingerprint: {
        requestedDirectory: event.payload.requestedDirectory,
        workspaceRoot: created?.payload.workspaceRoot ?? "",
      },
    }
  },
}

export interface AddAdditionalDirectoryInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly directory: string
  readonly workspaceRoot?: string
  readonly expectedScopeRevision?: number
  readonly signal?: AbortSignal
}

export interface AdditionalDirectoryResolver {
  readonly resolve: (
    directory: string,
    workspaceRoot: string,
    existingDirectories: readonly string[],
    signal?: AbortSignal,
  ) => Promise<{
    readonly canonical: string
    readonly changed: boolean
    readonly directories?: readonly string[]
  }>
  readonly ensure: (workspaceRoot: string, directories: readonly string[]) => Promise<void> | void
}

export interface AddAdditionalDirectoryResult {
  readonly changed: boolean
  readonly directory: string
  readonly additionalDirectories: readonly string[]
  readonly scopeRevision: number
  readonly scopeDigest?: string
}

export interface AddAdditionalDirectoryDependencies {
  readonly eventStore: EventStore
  readonly authority?: SessionAuthority
  readonly identity: { nextEventId(): string; now(): string }
  readonly resolver: AdditionalDirectoryResolver
  readonly workspaceScopeDigest: WorkspaceScopeDigest
  /** Serializes the read-judge-append window against tool dispatch on one session. */
  readonly serialPoint: PolicySerialPoint
  readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
}

/** Persist one additional directory before exposing it to the session. */
export class AddAdditionalDirectoryUseCase {
  private readonly pending = new Map<string, Promise<void>>()
  private readonly authority: SessionAuthority

  constructor(private readonly deps: AddAdditionalDirectoryDependencies) {
    this.authority = deps.authority ?? new SessionAuthority(deps.eventStore)
  }

  async execute(input: AddAdditionalDirectoryInput): Promise<AddAdditionalDirectoryResult> {
    const key = input.sessionId.toString()
    const previous = this.pending.get(key)
    const operation = (previous ?? Promise.resolve()).then(() =>
      this.deps.serialPoint.critical(input.sessionId, `add-directory:${input.commandId}`, "permission-commit", () =>
        this.executeNow(input),
      ),
    )
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    )
    this.pending.set(key, tracked)
    try {
      return await operation
    } finally {
      if (this.pending.get(key) === tracked) this.pending.delete(key)
    }
  }

  private async executeNow(input: AddAdditionalDirectoryInput): Promise<AddAdditionalDirectoryResult> {
    throwIfAborted(input.signal)
    const events = await this.deps.eventStore.read(input.sessionId)
    const current = events.length === 0 ? undefined : replaySession(events)
    const workspaceRoot = current?.workspaceRoot ?? input.workspaceRoot?.trim()
    if (!workspaceRoot) throw new Error("workspaceRoot is required when adding a directory to an empty Session")
    const fingerprint = {
      requestedDirectory: input.directory.trim(),
      workspaceRoot,
    }
    const idempotency = resolveCommandIdempotency(ADDITIONAL_DIRECTORY_IDEMPOTENCY_FAMILY, events, {
      family: ADDITIONAL_DIRECTORY_FAMILY,
      commandId: input.commandId,
      inputFingerprint: fingerprint,
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") {
      if (idempotency.terminal.type !== "SessionAdditionalDirectoryAdded") {
        throw new Error("additional directory receipt has an invalid terminal event")
      }
      const prior = idempotency.terminal
      const directories = prior.payload.additionalDirectories ?? current?.additionalDirectories ?? []
      await Promise.resolve()
        .then(() => this.deps.resolver.ensure(workspaceRoot, directories))
        .catch(() => {})
      return {
        changed: prior.payload.changed,
        directory: prior.payload.directory,
        additionalDirectories: directories,
        scopeRevision: prior.payload.scopeRevision,
        scopeDigest: prior.payload.scopeDigest,
      }
    }
    if (input.expectedScopeRevision !== undefined && input.expectedScopeRevision !== (current?.scopeRevision ?? 0)) {
      throw new Error(`stale_scope_revision: expected ${input.expectedScopeRevision}, received ${current?.scopeRevision ?? 0}`)
    }
    const existingDirectories = current?.additionalDirectories ?? []
    const resolved = await this.deps.resolver.resolve(input.directory, workspaceRoot, existingDirectories, input.signal)
    throwIfAborted(input.signal)
    const directories = [
      ...(resolved.directories ?? (resolved.changed ? [...existingDirectories, resolved.canonical] : existingDirectories)),
    ]
    const traceId = `additional-directory:${input.commandId}`
    let revision = events.length + 1
    let causationId: string | undefined = events.at(-1)?.eventId
    const createEvent = <TType extends AgentEvent["type"]>(
      type: TType,
      payload: Extract<AgentEvent, { type: TType }>["payload"],
    ): Extract<AgentEvent, { type: TType }> => {
      const eventId = this.deps.identity.nextEventId()
      const event = {
        eventId,
        sessionId: input.sessionId,
        revision: revision++,
        type,
        timestamp: this.deps.identity.now(),
        trace: {
          traceId,
          operationId: traceId,
          ...(causationId ? { causationId } : {}),
        },
        payload,
      } as Extract<AgentEvent, { type: TType }>
      causationId = eventId
      return event
    }

    const appended: AgentEvent[] = []
    const scopeDigest = this.deps.workspaceScopeDigest(workspaceRoot, directories)
    const ensureDirectories = () =>
      Promise.resolve()
        .then(() => this.deps.resolver.ensure(workspaceRoot, directories))
        .catch(() => {})

    if (!resolved.changed) {
      // A no-op add persists no directory event: the scope already contains
      // the directory, and an unchanged scopeRevision would fail the
      // strict-increment invariant at commit. A fresh session keeps only its
      // SessionCreated seed.
      if (!current) {
        await appendSessionEventsIfRevision({
          eventStore: this.deps.eventStore,
          authority: this.authority,
          sessionId: input.sessionId,
          expectedRevision: events.length,
          events: [
            createEvent("SessionCreated", {
              workspaceRoot,
              scopeRevision: 0,
              permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
              permissionRules: [],
              policyRevision: 0,
            }),
          ],
          onEventsAppended: this.deps.onEventsAppended,
        })
      }
      await ensureDirectories()
      return {
        changed: false,
        directory: resolved.canonical,
        additionalDirectories: current ? current.additionalDirectories : directories,
        scopeRevision: current?.scopeRevision ?? 0,
        scopeDigest,
      }
    }

    const nextScopeRevision = (current?.scopeRevision ?? 0) + 1
    const nextPolicyRevision = (current?.policyRevision ?? 0) + 1
    if (!current) {
      appended.push(
        createEvent("SessionCreated", {
          workspaceRoot,
          scopeRevision: 0,
          permissionMode: DEFAULT_SESSION_PERMISSION_MODE,
          permissionRules: [],
          policyRevision: 0,
        }),
      )
    }
    appended.push(
      createEvent("SessionAdditionalDirectoryAdded", {
        commandId: input.commandId,
        requestedDirectory: input.directory.trim(),
        directory: resolved.canonical,
        additionalDirectories: directories,
        scopeRevision: nextScopeRevision,
        policyRevision: nextPolicyRevision,
        scopeDigest,
        changed: true,
      }),
    )
    await appendSessionEventsIfRevision({
      eventStore: this.deps.eventStore,
      authority: this.authority,
      sessionId: input.sessionId,
      expectedRevision: events.length,
      events: appended,
      onEventsAppended: this.deps.onEventsAppended,
    })
    await ensureDirectories()
    return {
      changed: true,
      directory: resolved.canonical,
      additionalDirectories: directories,
      scopeRevision: nextScopeRevision,
      scopeDigest,
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("additional directory command cancelled", "AbortError")
}
