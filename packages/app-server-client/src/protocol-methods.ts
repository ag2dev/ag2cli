import type {
  AppServerCapabilities,
  AppServerDeviceRecord,
  AppServerMethod,
  AppServerPairClaimParams,
  AppServerPairClaimResult,
  AppServerPairCreateParams,
  AppServerPairCreateResult,
  AppServerPairPreviewParams,
  AppServerPairPreviewResult,
  DeviceRevokeParams,
  JsonValue,
  ServerDescribeResult,
  ServerInitializeParams,
  ServerInitializeResult,
  SessionPlanParams,
  SessionPlanResult,
  ServerPreflightParams,
  ServerPreflightResult,
  SessionTraceParams,
  SessionTraceResult,
  SessionAddDirectoryParams,
  SessionAddDirectoryResult,
  SessionArchiveParams,
  SessionArchiveResult,
  SessionAttachParams,
  SessionAttachResult,
  SessionCancelInputParams,
  SessionCancelInputResult,
  SessionCancelRunParams,
  SessionCancelRunResult,
  SessionCancelTaskParams,
  SessionCancelTaskResult,
  SessionClearContextWindowParams,
  SessionClearContextWindowResult,
  SessionCompactParams,
  SessionCompactResult,
  SessionCreateParams,
  SessionCreateTaskParams,
  SessionCreateTaskResult,
  SessionDeleteParams,
  SessionDeleteResult,
  SessionDetachParams,
  SessionDetachResult,
  SessionExecuteShellParams,
  SessionExecuteShellResult,
  SessionExecuteUserShellParams,
  SessionExecuteUserShellResult,
  SessionForkParams,
  SessionGetParams,
  SessionGetPermissionPolicyParams,
  SessionGetPermissionPolicyResult,
  SessionGetResult,
  SessionGetTaskLogsParams,
  SessionGetTaskLogsResult,
  SessionListCheckpointsParams,
  SessionListCheckpointsResult,
  SessionListParams,
  SessionListResult,
  SessionListTasksParams,
  SessionListTasksResult,
  SessionMessagesParams,
  SessionMessagesResult,
  SessionModelCallsParams,
  SessionModelCallsResult,
  SessionPreviewRewindParams,
  SessionPreviewRewindResult,
  SessionResyncParams,
  SessionResyncResult,
  SessionResolveInteractionParams,
  SessionResolveInteractionResult,
  SessionReplayParams,
  SessionReplayResult,
  SessionRewindParams,
  SessionRewindResult,
  SessionSelectAgentParams,
  SessionSelectAgentResult,
  SessionSetContextWindowParams,
  SessionSetContextWindowResult,
  SessionSetPermissionModeParams,
  SessionSetPermissionModeResult,
  SessionSetPermissionRulesParams,
  SessionSetPermissionRulesResult,
  SessionSnapshotMethodParams,
  SessionSnapshotMethodResult,
  SessionSnapshotResult,
  SessionSteerParams,
  SessionSteerResult,
  SessionSubmitParams,
  SessionSubmitResult,
  SessionUpdateGoalParams,
  SessionUpdateGoalResult,
  WorkspaceDiffParams,
  WorkspaceDiffResult,
  WorkspaceReadFileParams,
  WorkspaceReadFileResult,
} from "@ag2cli/app-server-protocol/types.js"
import {
  APP_SERVER_METHOD_PARAM_PARSERS,
  APP_SERVER_METHOD_RESULT_PARSERS,
  assertJsonValue,
} from "@ag2cli/app-server-protocol/validation.js"
import { AppServerRpcError } from "./client.js"
import type { AppServerInteractionMethod } from "./interaction.js"

/**
 * Declared-only result shapes: the protocol package ships no runtime result
 * parser for these methods yet, so the toolkit trusts the server. Registering
 * the missing parsers is tracked as a protocol-package artifact gap.
 */
export interface ServerHealthResult {
  readonly ok: boolean
  readonly status: string
  readonly protocolVersion: number
}

export interface DeviceRevokeResult {
  readonly deviceId: string
  readonly revoked: boolean
}

/** Every method the typed surface covers: the wire catalog minus the interaction methods, which keep their dedicated lease-aware path in `interaction.ts`. */
export type ProtocolMethod = Exclude<AppServerMethod, AppServerInteractionMethod>

export interface ProtocolMethodParams {
  readonly "server.preflight": ServerPreflightParams
  readonly "server.initialize": ServerInitializeParams
  readonly "server.describe": undefined
  readonly "server.health": undefined
  readonly "session.list": SessionListParams
  readonly "session.create": SessionCreateParams
  readonly "session.get": SessionGetParams
  readonly "session.fork": SessionForkParams
  readonly "session.archive": SessionArchiveParams
  readonly "session.delete": SessionDeleteParams
  readonly "session.attach": SessionAttachParams
  readonly "session.detach": SessionDetachParams
  readonly "session.snapshot": SessionSnapshotMethodParams
  readonly "session.plan": SessionPlanParams
  readonly "session.compact": SessionCompactParams
  readonly "session.addDirectory": SessionAddDirectoryParams
  readonly "session.setContextWindow": SessionSetContextWindowParams
  readonly "session.clearContextWindow": SessionClearContextWindowParams
  readonly "session.selectAgent": SessionSelectAgentParams
  readonly "session.updateGoal": SessionUpdateGoalParams
  readonly "session.listCheckpoints": SessionListCheckpointsParams
  readonly "session.previewRewind": SessionPreviewRewindParams
  readonly "session.rewind": SessionRewindParams
  readonly "session.submit": SessionSubmitParams
  readonly "session.steer": SessionSteerParams
  readonly "session.cancelRun": SessionCancelRunParams
  readonly "session.cancelInput": SessionCancelInputParams
  readonly "session.messages": SessionMessagesParams
  readonly "session.resolveInteraction": SessionResolveInteractionParams
  readonly "session.getPermissionPolicy": SessionGetPermissionPolicyParams
  readonly "session.setPermissionMode": SessionSetPermissionModeParams
  readonly "session.setPermissionRules": SessionSetPermissionRulesParams
  readonly "session.replay": SessionReplayParams
  readonly "session.trace": SessionTraceParams
  readonly "session.modelCalls": SessionModelCallsParams
  readonly "session.resync": SessionResyncParams
  readonly "pair.create": AppServerPairCreateParams
  readonly "pair.preview": AppServerPairPreviewParams
  readonly "pair.claim": AppServerPairClaimParams
  readonly "device.list": undefined
  readonly "device.revoke": DeviceRevokeParams
  readonly "workspace.diff": WorkspaceDiffParams
  readonly "workspace.readFile": WorkspaceReadFileParams
  readonly "session.createTask": SessionCreateTaskParams
  readonly "session.listTasks": SessionListTasksParams
  readonly "session.cancelTask": SessionCancelTaskParams
  readonly "session.getTaskLogs": SessionGetTaskLogsParams
  readonly "session.executeShell": SessionExecuteShellParams
  readonly "session.executeUserShell": SessionExecuteUserShellParams
}

export interface ProtocolMethodResults {
  readonly "server.preflight": ServerPreflightResult
  readonly "server.initialize": ServerInitializeResult
  readonly "server.describe": ServerDescribeResult
  readonly "server.health": ServerHealthResult
  readonly "session.list": SessionListResult
  readonly "session.create": SessionSnapshotResult
  readonly "session.get": SessionGetResult
  readonly "session.fork": SessionSnapshotResult
  readonly "session.archive": SessionArchiveResult
  readonly "session.delete": SessionDeleteResult
  readonly "session.attach": SessionAttachResult
  readonly "session.detach": SessionDetachResult
  readonly "session.snapshot": SessionSnapshotMethodResult
  readonly "session.plan": SessionPlanResult
  readonly "session.compact": SessionCompactResult
  readonly "session.addDirectory": SessionAddDirectoryResult
  readonly "session.setContextWindow": SessionSetContextWindowResult
  readonly "session.clearContextWindow": SessionClearContextWindowResult
  readonly "session.selectAgent": SessionSelectAgentResult
  readonly "session.updateGoal": SessionUpdateGoalResult
  readonly "session.listCheckpoints": SessionListCheckpointsResult
  readonly "session.previewRewind": SessionPreviewRewindResult
  readonly "session.rewind": SessionRewindResult
  readonly "session.submit": SessionSubmitResult
  readonly "session.steer": SessionSteerResult
  readonly "session.cancelRun": SessionCancelRunResult
  readonly "session.cancelInput": SessionCancelInputResult
  readonly "session.messages": SessionMessagesResult
  readonly "session.resolveInteraction": SessionResolveInteractionResult
  readonly "session.getPermissionPolicy": SessionGetPermissionPolicyResult
  readonly "session.setPermissionMode": SessionSetPermissionModeResult
  readonly "session.setPermissionRules": SessionSetPermissionRulesResult
  readonly "session.replay": SessionReplayResult
  readonly "session.trace": SessionTraceResult
  readonly "session.modelCalls": SessionModelCallsResult
  readonly "session.resync": SessionResyncResult
  readonly "pair.create": AppServerPairCreateResult
  readonly "pair.preview": AppServerPairPreviewResult
  readonly "pair.claim": AppServerPairClaimResult
  readonly "device.list": readonly AppServerDeviceRecord[]
  readonly "device.revoke": DeviceRevokeResult
  readonly "workspace.diff": WorkspaceDiffResult
  readonly "workspace.readFile": WorkspaceReadFileResult
  readonly "session.createTask": SessionCreateTaskResult
  readonly "session.listTasks": SessionListTasksResult
  readonly "session.cancelTask": SessionCancelTaskResult
  readonly "session.getTaskLogs": SessionGetTaskLogsResult
  readonly "session.executeShell": SessionExecuteShellResult
  readonly "session.executeUserShell": SessionExecuteUserShellResult
}

/** Anything whose `request` matches the RPC client surface can carry typed protocol calls. */
export interface ProtocolCaller {
  request(method: string, params?: JsonValue, options?: { readonly signal?: AbortSignal }): Promise<JsonValue>
}

export interface ProtocolCallOptions {
  readonly signal?: AbortSignal
}

/**
 * One shared typed-method implementation for every client class. Params are
 * validated against the protocol registries before the wire (violations fail
 * locally); results go through the runtime result parsers, and a result that
 * fails parsing is reported as a locally synthesized `invalid_result`
 * `AppServerRpcError`. Methods without a registered result parser are trusted
 * casts (see the declared-only shapes above).
 */
export async function callProtocol<M extends ProtocolMethod>(
  caller: ProtocolCaller,
  method: M,
  params: ProtocolMethodParams[M],
  options: ProtocolCallOptions = {},
): Promise<ProtocolMethodResults[M]> {
  let wireParams: JsonValue | undefined
  if (params !== undefined) {
    const paramParser = APP_SERVER_METHOD_PARAM_PARSERS[method]
    const parsed = paramParser === undefined ? params : parseLocalParams(paramParser, params as unknown, method)
    wireParams = assertJsonValue(parsed, `${method}.params`)
  }
  const raw = await caller.request(method, wireParams, options)
  const resultParser = APP_SERVER_METHOD_RESULT_PARSERS[method]
  if (resultParser === undefined) return raw as ProtocolMethodResults[M]
  try {
    return resultParser(raw) as ProtocolMethodResults[M]
  } catch (error) {
    throw AppServerRpcError.local("invalid_result", `${method} result failed protocol parsing: ${errorMessage(error)}`)
  }
}

/**
 * Authoritative capability discovery: the Host descriptor plus its
 * capabilities, runtime-validated by the protocol result parser.
 */
export function describeAppServer(caller: ProtocolCaller, options?: ProtocolCallOptions): Promise<ServerDescribeResult> {
  return callProtocol(caller, "server.describe", undefined, options)
}

/** Read the capabilities the Host advertised for this connection via `server.initialize`. */
export function connectionCapabilities(initialize: ServerInitializeResult): AppServerCapabilities {
  return initialize.capabilities
}

function parseLocalParams(parser: (value: unknown) => unknown, params: unknown, method: ProtocolMethod): unknown {
  try {
    return parser(params)
  } catch (error) {
    throw new Error(`${method}.params failed protocol validation: ${errorMessage(error)}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
