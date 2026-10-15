import type { AgentEvent, HistoryCursor } from "../events/event.js"
import type { ContentBlock, Message } from "../message.js"
import type { RunId, SessionId } from "../ids.js"
import {
  historyCursorKey,
  isHistoryAncestor,
  reduceCanonicalSession,
  sameHistoryCursor,
  type CanonicalSessionState,
} from "./canonical-session.js"

export interface ForkMaterialization {
  readonly events: readonly AgentEvent[]
  readonly sourcePrefixDigest: string
  readonly sourceCursor: HistoryCursor
}

/**
 * Materialize one canonical conversation cut into a new, linear Session.
 *
 * The source is read once by the catalog before this function is called. The
 * cursor therefore identifies an immutable physical prefix, while the
 * active-history walk prevents abandoned branches and queued inputs from
 * leaking into the new Session. Provider attempts are never copied unless
 * their durable commit is part of the selected history.
 *
 * The recorded sourceCursor is always the requested cursor (provenance and
 * idempotent re-fork identity); when it sits on a synthetic rewind head the
 * physical cut silently walks up to the nearest materializable ancestor, so
 * the two may differ.
 */
export function materializeSessionAtCursor(
  source: readonly AgentEvent[],
  targetSessionId: SessionId,
  sourceCursor: HistoryCursor,
  nextEventId: () => string,
  now: () => string = () => new Date().toISOString(),
): ForkMaterialization {
  if (source.length === 0) throw new Error("cannot create a Session branch from an empty event stream")
  const sourceState = reduceCanonicalSession(source)
  const sourceSessionId = source[0]!.sessionId
  if (sourceCursor.sessionId !== sourceSessionId) throw new Error("fork cursor does not belong to the source Session")
  if (sourceState.activeHead === undefined || !isHistoryAncestor(sourceState, sourceState.activeHead, sourceCursor)) {
    throw new Error("fork cursor must be on the lineage of the source Session's current active head")
  }
  if (!Number.isSafeInteger(sourceCursor.physicalRevision) || sourceCursor.physicalRevision < 1) {
    throw new Error("fork cursor physicalRevision must be a positive safe integer")
  }
  const cutCursor = materializableCursorFor(sourceState, sourceCursor)
  const cutIndex = source.findIndex((event) => event.revision === cutCursor.physicalRevision)
  if (cutIndex < 0) throw new Error(`fork cursor revision does not exist: ${cutCursor.physicalRevision}`)
  const sourcePrefix = source.slice(0, cutIndex + 1)
  const prefixState = reduceCanonicalSession(sourcePrefix)
  if (prefixState.activeHead === undefined || !sameHistoryCursor(prefixState.activeHead, cutCursor)) {
    throw new Error("fork cursor must be the active head of that physical prefix")
  }

  const runningRunIds = new Set([...prefixState.runs.values()].filter((run) => run.status === "running").map((run) => String(run.runId)))
  if (runningRunIds.size > 0) throw new Error(`fork cursor cannot stop after an incomplete run: ${[...runningRunIds].join(",")}`)

  const sourcePrefixDigest = sha256Hex(JSON.stringify(sourcePrefix.map(stripStorageMetadata)))
  const activeHistoryEventIds = collectActiveHistoryEventIds(prefixState)
  const activeNodesByEventId = collectActiveNodesByEventId(prefixState)
  const consumedInputs = new Set(
    sourcePrefix
      .filter(
        (event): event is Extract<AgentEvent, { type: "InputConsumed" }> =>
          event.type === "InputConsumed" && activeHistoryEventIds.has(event.eventId),
      )
      .map((event) => event.payload.inputId),
  )
  const activeRuns = new Set<string>()
  const committedModelAttempts = new Set<string>()
  const committedToolAttempts = new Set<string>()
  const committedToolUses = new Set<string>()

  for (const event of sourcePrefix) {
    if (event.type === "InputConsumed" && activeHistoryEventIds.has(event.eventId)) activeRuns.add(String(event.payload.runId))
    if (event.type === "ModelResponseCommitted" && activeHistoryEventIds.has(event.eventId)) {
      activeRuns.add(String(event.payload.runId))
      committedModelAttempts.add(event.payload.attemptId)
      for (const block of event.payload.content) if (block.type === "tool_use") committedToolUses.add(block.id)
    }
    if (event.type === "ToolResultCommitted" && activeHistoryEventIds.has(event.eventId)) {
      activeRuns.add(String(event.payload.runId))
      committedToolAttempts.add(event.payload.attemptId)
      committedToolUses.add(event.payload.toolUseId)
    }
  }

  const incompleteRuns = [...prefixState.runs.values()].filter((run) => run.status === "running")
  if (incompleteRuns.length > 0) {
    throw new Error(`fork cursor cannot stop after an incomplete run: ${incompleteRuns.map((run) => run.runId).join(",")}`)
  }
  const incompleteAttempts = [...prefixState.attempts.values()].filter((attempt) => attempt.status === "started")
  if (incompleteAttempts.length > 0) {
    throw new Error(
      `fork cursor cannot stop after an incomplete attempt: ${incompleteAttempts.map((attempt) => attempt.attemptId).join(",")}`,
    )
  }

  validateSelectedToolPairs(sourcePrefix, activeHistoryEventIds, committedToolUses)
  const sourceRunStarted = new Map<string, Extract<AgentEvent, { type: "RunStarted" }>>()
  for (const event of sourcePrefix) {
    if (event.type === "RunStarted" && activeRuns.has(String(event.payload.runId))) {
      sourceRunStarted.set(String(event.payload.runId), event)
    }
  }
  for (const runId of activeRuns) {
    if (!sourceRunStarted.has(runId)) throw new Error(`fork history is missing RunStarted: ${runId}`)
  }

  const commandIds = new Set<string>()
  const inputIds = new Set<string>()
  const runIds = new Set<string>()
  const attemptIds = new Set<string>()
  const toolUseIds = new Set<string>()
  for (const event of sourcePrefix) {
    if (event.type === "InputAccepted" && consumedInputs.has(event.payload.inputId)) {
      commandIds.add(event.payload.commandId)
      inputIds.add(event.payload.inputId)
    }
    if (event.type === "RunStarted" && activeRuns.has(String(event.payload.runId))) {
      commandIds.add(event.payload.commandId)
      runIds.add(String(event.payload.runId))
    }
    if (event.type === "InputConsumed" && activeHistoryEventIds.has(event.eventId)) {
      commandIds.add(event.payload.commandId)
      inputIds.add(event.payload.inputId)
      runIds.add(String(event.payload.runId))
    }
    if (event.type === "ModelAttemptStarted" && committedModelAttempts.has(event.payload.attemptId)) {
      runIds.add(String(event.payload.runId))
      attemptIds.add(event.payload.attemptId)
    }
    if (event.type === "ModelResponseCommitted" && activeHistoryEventIds.has(event.eventId)) {
      runIds.add(String(event.payload.runId))
      attemptIds.add(event.payload.attemptId)
      for (const block of event.payload.content) if (block.type === "tool_use") toolUseIds.add(block.id)
    }
    if (event.type === "ToolAttemptStarted" && committedToolAttempts.has(event.payload.attemptId)) {
      runIds.add(String(event.payload.runId))
      attemptIds.add(event.payload.attemptId)
      toolUseIds.add(event.payload.toolUseId)
    }
    if (event.type === "ToolResultCommitted" && activeHistoryEventIds.has(event.eventId)) {
      runIds.add(String(event.payload.runId))
      attemptIds.add(event.payload.attemptId)
      toolUseIds.add(event.payload.toolUseId)
    }
  }

  const ids = createIdMapper(targetSessionId)
  for (const value of commandIds) ids.command(value)
  for (const value of inputIds) ids.input(value)
  for (const value of runIds) ids.run(value)
  for (const value of attemptIds) ids.attempt(value)
  for (const value of toolUseIds) ids.toolUse(value)

  const targetEvents: AgentEvent[] = []
  const sourceEventIds = new Map<string, string>()
  const targetCursors = new Map<string, HistoryCursor>()
  const sourceRoot = findRootCursor(sourceState)
  const targetRoot: HistoryCursor = {
    sessionId: targetSessionId,
    branchId: "main",
    nodeId: "root",
    physicalRevision: 1,
    recordHash: "",
  }

  const append = (sourceEvent: AgentEvent, payload: unknown, type: AgentEvent["type"] = sourceEvent.type): AgentEvent => {
    const eventId = nextEventId()
    const revision = targetEvents.length + 1
    const { recordHash: _recordHash, previousRecordHash: _previousRecordHash, ...withoutStorage } = sourceEvent
    const target = {
      ...withoutStorage,
      eventId,
      sessionId: targetSessionId,
      revision,
      type,
      trace: targetTrace(sourceEvent, targetSessionId, sourceEventIds),
      ...(sourceEvent.transitionId === undefined ? {} : { transitionId: ids.transition(sourceEvent.transitionId) }),
      payload,
    } as AgentEvent
    targetEvents.push(target)
    sourceEventIds.set(sourceEvent.eventId, eventId)
    return target
  }

  const created = sourcePrefix[0]
  if (created?.type !== "SessionCreated") throw new Error("Canonical Session branches must start with SessionCreated")
  const targetCreated = append(created, created.payload)
  const root = {
    ...targetRoot,
    physicalRevision: targetCreated.revision,
    recordHash: targetCreated.eventId,
  }
  targetCursors.set(historyCursorKey(sourceRoot), root)

  const includedSourceEvents = sourcePrefix.filter((event) =>
    shouldMaterializeEvent(event, activeHistoryEventIds, consumedInputs, activeRuns, committedModelAttempts, committedToolAttempts),
  )
  for (const sourceEvent of includedSourceEvents) {
    if (sourceEvent.type === "SessionCreated") continue
    const payload = remapForkPayload(
      sourceEvent,
      sourceEvent.payload,
      targetSessionId,
      ids,
      sourceState,
      targetCursors,
      targetRoot,
      activeRuns,
      committedModelAttempts,
      committedToolAttempts,
    )
    const target = append(sourceEvent, payload)
    if (activeHistoryEventIds.has(sourceEvent.eventId)) {
      const sourceNode = activeNodesByEventId.get(sourceEvent.eventId)
      if (sourceNode !== undefined) {
        const targetCursor: HistoryCursor = {
          sessionId: targetSessionId,
          branchId: "main",
          nodeId: `event:${target.eventId}`,
          physicalRevision: target.revision,
          recordHash: target.eventId,
        }
        targetCursors.set(historyCursorKey(sourceNode), targetCursor)
      }
    }
  }

  const forkCommandId = ids.command(
    `fork:${sourceSessionId}:${sourceCursor.branchId}:${sourceCursor.nodeId}:${sourceCursor.physicalRevision}`,
  )
  const forkTrace = {
    traceId: `fork:${targetSessionId}`,
    operationId: `fork:${targetSessionId}`,
    ...(targetEvents.at(-1)?.eventId === undefined ? {} : { causationId: targetEvents.at(-1)!.eventId }),
  }
  const forkRequested = appendSynthetic(
    targetEvents,
    targetSessionId,
    nextEventId,
    now,
    "ForkRequested",
    {
      commandId: forkCommandId,
      sourceSessionId,
      sourceCursor,
      targetSessionId,
    },
    forkTrace,
  )
  appendSynthetic(
    targetEvents,
    targetSessionId,
    nextEventId,
    now,
    "ForkCompleted",
    {
      commandId: forkCommandId,
      sourceSessionId,
      sourceCursor,
      targetSessionId,
      materializedPrefixDigest: sourcePrefixDigest,
      foreignLineageRef: {
        sourceSessionId,
        sourceCursor,
        materializedPrefixDigest: sourcePrefixDigest,
      },
    },
    { ...forkTrace, causationId: forkRequested.eventId },
  )

  const targetState = reduceCanonicalSession(targetEvents)
  if (targetState.activeHead === undefined) throw new Error("fork target is missing an active head")
  return { events: targetEvents, sourcePrefixDigest, sourceCursor }
}

/**
 * Rewind parks the active head on a synthetic BranchCreated node that carries
 * no event identity. Cutting the physical stream at that revision would leave
 * an unpaired BranchCreated and break canonical replay. Walk up the lineage to
 * the nearest node that identifies a real committed event (or the root) and
 * cut there; the rewind transition pair itself never belongs to the fork.
 */
function materializableCursorFor(state: CanonicalSessionState, requested: HistoryCursor): HistoryCursor {
  let cursor = requested
  for (let hop = 0; hop <= state.nodes.size; hop += 1) {
    const node = state.nodes.get(historyCursorKey(cursor))
    // Only reachable on a corrupted store: the lineage check upstream
    // guarantees the requested cursor is a registered node. Fail with the
    // dangling node named instead of a misleading revision error later.
    if (node === undefined) throw new Error(`fork cursor points to an unregistered history node: ${cursor.nodeId}`)
    if (node.eventId !== undefined || node.parentCursor === undefined) return cursor
    cursor = node.parentCursor
  }
  throw new Error(`fork cursor is not materializable: ${requested.nodeId}`)
}

function shouldMaterializeEvent(
  event: AgentEvent,
  activeHistoryEvents: ReadonlySet<string>,
  consumedInputs: ReadonlySet<string>,
  activeRuns: ReadonlySet<string>,
  committedModelAttempts: ReadonlySet<string>,
  committedToolAttempts: ReadonlySet<string>,
): boolean {
  switch (event.type) {
    case "SessionAdditionalDirectoryAdded":
      return true
    case "SessionPermissionModeSet":
    case "SessionPermissionRulesSet":
    case "SessionContextWindowSet":
    case "SessionContextWindowCleared":
    case "SessionAgentSelected":
    case "SessionGoalUpdated":
      return true
    case "InputAccepted":
      return consumedInputs.has(event.payload.inputId)
    case "InputConsumed":
    case "ModelResponseCommitted":
    case "ToolResultCommitted":
    case "SessionContextCompacted":
      return activeHistoryEvents.has(event.eventId)
    case "RunStarted":
      return activeRuns.has(String(event.payload.runId))
    case "ContextCompacted":
      return activeRuns.has(String(event.payload.runId))
    case "RunCompleted":
    case "RunFailed":
    case "RunCancelled":
      return activeRuns.has(String(event.payload.runId))
    case "ModelAttemptStarted":
      return committedModelAttempts.has(event.payload.attemptId)
    case "ToolAttemptStarted":
      return committedToolAttempts.has(event.payload.attemptId)
    default:
      return false
  }
}

function remapForkPayload(
  event: AgentEvent,
  payload: unknown,
  targetSessionId: SessionId,
  ids: ReturnType<typeof createIdMapper>,
  sourceState: CanonicalSessionState,
  targetCursors: ReadonlyMap<string, HistoryCursor>,
  targetRoot: HistoryCursor,
  _activeRuns: ReadonlySet<string>,
  committedModelAttempts: ReadonlySet<string>,
  committedToolAttempts: ReadonlySet<string>,
): unknown {
  switch (event.type) {
    case "SessionAdditionalDirectoryAdded":
      return {
        ...event.payload,
        commandId: ids.command(event.payload.commandId),
      }
    case "SessionPermissionModeSet":
    case "SessionPermissionRulesSet":
    case "SessionContextWindowSet":
    case "SessionContextWindowCleared":
    case "SessionAgentSelected":
    case "SessionGoalUpdated":
      return payload
    case "InputAccepted":
      return {
        ...event.payload,
        inputId: ids.input(event.payload.inputId),
        commandId: ids.command(event.payload.commandId),
        ...(event.payload.targetRunId === undefined
          ? {}
          : {
              targetRunId: ids.run(String(event.payload.targetRunId)) as RunId,
            }),
        ...(event.payload.history === undefined ? {} : { history: undefined }),
      }
    case "InputConsumed":
      return {
        ...event.payload,
        inputId: ids.input(event.payload.inputId),
        commandId: ids.command(event.payload.commandId),
        runId: ids.run(String(event.payload.runId)) as RunId,
        executionGeneration: 0,
        parent: remapCursor(event.payload.parent, sourceState, targetCursors, targetRoot),
      }
    case "RunStarted":
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
        commandId: ids.command(event.payload.commandId),
      }
    case "RunCompleted":
    case "RunFailed":
    case "RunCancelled":
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
      }
    case "ContextCompacted":
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
        messages: remapMessages(event.payload.messages, ids),
      }
    case "SessionContextCompacted":
      return {
        ...event.payload,
        commandId: ids.command(event.payload.commandId),
        messages: remapMessages(event.payload.messages, ids),
      }
    case "ModelAttemptStarted":
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
        attemptId: ids.attempt(event.payload.attemptId),
        executionGeneration: 0,
        branchId: "main",
        inputCursor: remapCursor(event.payload.inputCursor, sourceState, targetCursors, targetRoot),
      }
    case "ModelResponseCommitted":
      if (!committedModelAttempts.has(event.payload.attemptId)) throw new Error("fork response attempt was not selected")
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
        attemptId: ids.attempt(event.payload.attemptId),
        executionGeneration: 0,
        branchId: "main",
        inputCursor: remapCursor(event.payload.inputCursor, sourceState, targetCursors, targetRoot),
        parent: remapCursor(event.payload.parent, sourceState, targetCursors, targetRoot),
        content: remapContent(event.payload.content, ids),
      }
    case "ToolAttemptStarted":
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
        attemptId: ids.attempt(event.payload.attemptId),
        toolUseId: ids.toolUse(event.payload.toolUseId),
        executionGeneration: 0,
        branchId: "main",
        inputCursor: remapCursor(event.payload.inputCursor, sourceState, targetCursors, targetRoot),
      }
    case "ToolResultCommitted":
      if (!committedToolAttempts.has(event.payload.attemptId)) throw new Error("fork tool attempt was not selected")
      return {
        ...event.payload,
        runId: ids.run(String(event.payload.runId)) as RunId,
        attemptId: ids.attempt(event.payload.attemptId),
        toolUseId: ids.toolUse(event.payload.toolUseId),
        executionGeneration: 0,
        branchId: "main",
        parent: remapCursor(event.payload.parent, sourceState, targetCursors, targetRoot),
      }
    default:
      throw new Error(`fork does not support materializing event: ${event.type}`)
  }
}

function appendSynthetic(
  events: AgentEvent[],
  sessionIdValue: SessionId,
  nextEventId: () => string,
  timestamp: string | (() => string),
  type: AgentEvent["type"],
  payload: unknown,
  trace: AgentEvent["trace"],
): AgentEvent {
  const eventId = nextEventId()
  const event = {
    eventId,
    sessionId: sessionIdValue,
    revision: events.length + 1,
    type,
    timestamp: typeof timestamp === "function" ? timestamp() : timestamp,
    trace,
    payload,
  } as AgentEvent
  events.push(event)
  return event
}

function remapCursor(
  sourceCursor: HistoryCursor,
  sourceState: CanonicalSessionState,
  targetCursors: ReadonlyMap<string, HistoryCursor>,
  targetRoot: HistoryCursor,
): HistoryCursor {
  const root = findRootCursor(sourceState)
  if (sameHistoryCursor(sourceCursor, root)) {
    return targetCursors.get(historyCursorKey(root)) ?? targetRoot
  }
  const existing = targetCursors.get(historyCursorKey(sourceCursor))
  if (existing !== undefined) return existing
  const node = sourceState.nodes.get(historyCursorKey(sourceCursor))
  if (node?.parentCursor !== undefined) return remapCursor(node.parentCursor, sourceState, targetCursors, targetRoot)
  throw new Error(`fork cursor ancestor was not materialized: ${sourceCursor.nodeId}`)
}

function collectActiveHistoryEventIds(state: CanonicalSessionState): Set<string> {
  const ids = new Set<string>()
  let cursor = state.activeHead
  while (cursor !== undefined) {
    const node = state.nodes.get(historyCursorKey(cursor))
    if (node?.eventId !== undefined) ids.add(node.eventId)
    cursor = node?.parentCursor
  }
  return ids
}

function collectActiveNodesByEventId(state: CanonicalSessionState): Map<string, HistoryCursor> {
  const result = new Map<string, HistoryCursor>()
  let cursor = state.activeHead
  while (cursor !== undefined) {
    const node = state.nodes.get(historyCursorKey(cursor))
    if (node?.eventId !== undefined) result.set(node.eventId, node)
    cursor = node?.parentCursor
  }
  return result
}

function findRootCursor(state: CanonicalSessionState): HistoryCursor {
  for (const node of state.nodes.values()) {
    if (node.nodeId === "root" && node.parentCursor === undefined) return node
  }
  throw new Error("canonical Session is missing the root history node")
}

function validateSelectedToolPairs(
  events: readonly AgentEvent[],
  activeHistoryEventIds: ReadonlySet<string>,
  committedToolUses: ReadonlySet<string>,
): void {
  for (const event of events) {
    if (event.type !== "ModelResponseCommitted" || !activeHistoryEventIds.has(event.eventId)) continue
    for (const block of event.payload.content) {
      if (block.type === "tool_use" && !committedToolUses.has(block.id)) {
        throw new Error("fork cursor cannot stop after an incomplete tool call")
      }
    }
  }
}

function runIdOf(event: AgentEvent): string | undefined {
  if (!event.payload || typeof event.payload !== "object" || !("runId" in event.payload)) return undefined
  const value = (event.payload as { readonly runId?: unknown }).runId
  return typeof value === "string" ? value : value === undefined ? undefined : String(value)
}

function remapContent(content: readonly ContentBlock[], ids: ReturnType<typeof createIdMapper>): readonly ContentBlock[] {
  return content.map((block) => {
    if (block.type === "tool_use") return { ...block, id: ids.toolUse(block.id) }
    if (block.type === "tool_result") return { ...block, tool_use_id: ids.toolUse(block.tool_use_id) }
    return block
  })
}

function remapMessages(messages: readonly Message[], ids: ReturnType<typeof createIdMapper>): readonly Message[] {
  return messages.map((message) => {
    if (typeof message.message.content === "string") return message
    if (message.type === "user") {
      return {
        ...message,
        message: {
          role: "user",
          content: [...remapContent(message.message.content, ids)],
        },
      }
    }
    return {
      ...message,
      message: {
        role: "assistant",
        content: [...remapContent(message.message.content, ids)],
      },
    }
  })
}

function targetTrace(
  sourceEvent: AgentEvent,
  targetSessionId: SessionId,
  sourceEventIds: ReadonlyMap<string, string>,
): AgentEvent["trace"] {
  return {
    traceId: `fork:${targetSessionId}:trace:${encodeURIComponent(sourceEvent.trace.traceId)}`,
    operationId: `fork:${targetSessionId}:operation:${encodeURIComponent(sourceEvent.trace.operationId)}`,
    ...(sourceEvent.trace.causationId === undefined
      ? {}
      : {
          causationId:
            sourceEventIds.get(sourceEvent.trace.causationId) ??
            `fork:${targetSessionId}:cause:${encodeURIComponent(sourceEvent.trace.causationId)}`,
        }),
  }
}

function createIdMapper(targetSessionId: SessionId) {
  const maps = {
    command: new Map<string, string>(),
    input: new Map<string, string>(),
    run: new Map<string, string>(),
    attempt: new Map<string, string>(),
    toolUse: new Map<string, string>(),
    transition: new Map<string, string>(),
  }
  const map = (kind: keyof typeof maps, value: string): string => {
    const existing = maps[kind].get(value)
    if (existing !== undefined) return existing
    const mapped = `fork:${targetSessionId}:${kind}:${encodeURIComponent(value)}`
    maps[kind].set(value, mapped)
    return mapped
  }
  return {
    command: (value: string) => map("command", value),
    input: (value: string) => map("input", value),
    run: (value: string) => map("run", value),
    attempt: (value: string) => map("attempt", value),
    toolUse: (value: string) => map("toolUse", value),
    transition: (value: string) => map("transition", value),
  }
}

function stripStorageMetadata(event: AgentEvent): AgentEvent {
  const {
    scopeId: _scopeId,
    modeScope: _modeScope,
    workspaceIdentity: _workspaceIdentity,
    transitionId: _transitionId,
    writerEpoch: _writerEpoch,
    recordHash: _recordHash,
    previousRecordHash: _previousRecordHash,
    ...canonical
  } = event
  return canonical as AgentEvent
}

function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const highLength = Math.floor(bitLength / 0x1_0000_0000)
  const lowLength = bitLength >>> 0
  const lengthOffset = padded.length - 8
  padded[lengthOffset] = (highLength >>> 24) & 0xff
  padded[lengthOffset + 1] = (highLength >>> 16) & 0xff
  padded[lengthOffset + 2] = (highLength >>> 8) & 0xff
  padded[lengthOffset + 3] = highLength & 0xff
  padded[lengthOffset + 4] = (lowLength >>> 24) & 0xff
  padded[lengthOffset + 5] = (lowLength >>> 16) & 0xff
  padded[lengthOffset + 6] = (lowLength >>> 8) & 0xff
  padded[lengthOffset + 7] = lowLength & 0xff

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const words = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4
      words[index] = (padded[base]! << 24) | (padded[base + 1]! << 16) | (padded[base + 2]! << 8) | padded[base + 3]!
    }
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15]!
      const smallSigma0 = rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)
      const prior = words[index - 2]!
      const smallSigma1 = rotateRight(prior, 17) ^ rotateRight(prior, 19) ^ (prior >>> 10)
      words[index] = (words[index - 16]! + smallSigma0 + words[index - 7]! + smallSigma1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + bigSigma1 + choose + constants[index]! + words[index]!) >>> 0
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (bigSigma0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((value) => value.toString(16).padStart(8, "0")).join("")
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}
