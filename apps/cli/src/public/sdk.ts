import { randomUUID } from "node:crypto"
import type {
  CreatePlanCommandInput,
  StartRunCommandInput,
  ExecuteShellCommandInput,
  CompactSessionCommandInput,
  UpdateGoalCommandInput,
  CreateTaskCommandInput,
  CancelTaskCommandInput,
  ResolveApprovalCommandInput,
  SessionCommandResult,
} from "@ag2cli/protocol/session-command.js"
import type { SessionClient, SessionExecuteOptions, SessionTransport } from "@ag2cli/client/session-client.js"
import {
  createPlanCommand,
  executeShellCommand,
  compactSessionCommand,
  setContextWindowCommand,
  clearContextWindowCommand,
  setAgentCommand,
  updateGoalCommand,
  createTaskCommand,
  listTasksCommand,
  cancelTaskCommand,
  startRunCommand,
  resolveApprovalCommand,
  getSnapshotCommand,
  readTraceCommand,
  readModelCallsCommand,
} from "@ag2cli/protocol/session-command.js"
import { createSessionClient } from "@ag2cli/client/session-client.js"
import type { Plan } from "@ag2cli/core/plan/plan.js"
import type { SessionSnapshot } from "@ag2cli/core/session/session-snapshot.js"
import type { TraceRecord } from "@ag2cli/runtime/ports/trace-sink.js"
import type { ModelCallRecord } from "@ag2cli/core/model/observation.js"
import type { RunResult } from "@ag2cli/core/execution/run.js"
import type { TaskSnapshot } from "@ag2cli/core/task/task.js"
/** Public, transport-neutral SDK surface for plan sessions. */
export type {
  CreatePlanCommand,
  CreatePlanCommandInput,
  StartRunCommand,
  StartRunCommandInput,
  ExecuteShellCommand,
  ExecuteShellCommandInput,
  CompactSessionCommand,
  CompactSessionCommandInput,
  SetContextWindowCommand,
  SetContextWindowCommandInput,
  ClearContextWindowCommand,
  ClearContextWindowCommandInput,
  SetAgentCommand,
  SetAgentCommandInput,
  UpdateGoalCommand,
  UpdateGoalCommandInput,
  CreateTaskCommand,
  CreateTaskCommandInput,
  CancelTaskCommand,
  CancelTaskCommandInput,
  ResolveApprovalCommand,
  ResolveApprovalCommandInput,
  SessionCommand,
  SessionCommandResult,
} from "@ag2cli/protocol/session-command.js"
export type {
  SessionClient,
  SessionEventListener,
  SessionTransientEventListener,
  SessionExecuteOptions,
  SessionServer,
  SessionTransport,
} from "@ag2cli/client/session-client.js"
export type { SessionCatalog, SessionCatalogOptions, SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
export type { AgentProfile, AgentProfileResolver } from "@ag2cli/runtime/ports/agent-profile.js"
export {
  createPlanCommand,
  executeShellCommand,
  compactSessionCommand,
  setContextWindowCommand,
  clearContextWindowCommand,
  setAgentCommand,
  updateGoalCommand,
  createTaskCommand,
  listTasksCommand,
  cancelTaskCommand,
  resolveApprovalCommand,
  getSnapshotCommand,
  readEventsCommand,
  readTraceCommand,
  SESSION_PROTOCOL_VERSION,
} from "@ag2cli/protocol/session-command.js"
export type { SessionProtocolVersion } from "@ag2cli/protocol/session-command.js"
export type { AgentEvent, AgentEventType } from "@ag2cli/core/events/event.js"
export type { EventTrace } from "@ag2cli/core/events/event.js"
export type { TransientStreamEvent, TransientStreamEventType } from "@ag2cli/core/events/transient.js"
export type { Plan, PlanStep, PlanStepStatus } from "@ag2cli/core/plan/plan.js"
export type { SessionSnapshot, SessionStatus } from "@ag2cli/core/session/session-snapshot.js"
export type { SessionGoal, SessionGoalStatus, SessionGoalUpdate } from "@ag2cli/core/session/session-goal.js"
export type { RunResult, RunSnapshot, RunStatus } from "@ag2cli/core/execution/run.js"
export type { BackgroundTaskType, BackgroundTaskStatus, TaskSnapshot } from "@ag2cli/core/task/task.js"
export { SessionReplica } from "@ag2cli/client/session-replica.js"
export type { SessionReplicaOptions } from "@ag2cli/client/session-replica.js"
export { SharedSessionController } from "@ag2cli/client/shared-session.js"
export type { SharedSessionControllerOptions } from "@ag2cli/client/shared-session.js"
export { connectElectronSession, connectMobileSession } from "../ui/platform/index.js"
export type { TraceName, TracePhase, TraceRecord, TraceSink, TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
export type {
  TelemetryAttribute,
  TelemetryRecord,
  TelemetrySeverity,
  TelemetrySink,
  TelemetryStore,
} from "@ag2cli/runtime/ports/telemetry.js"
export type {
  CanonicalModelRequest,
  ContextProvenance,
  ModelCallRecord,
  ModelProviderMetadata,
  ModelUsage,
} from "@ag2cli/core/model/observation.js"
export type { ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"

/** Connect a transport-neutral client to one authoritative session. */
export function connectSession(transport: SessionTransport, sessionId: string): SessionClient {
  return createSessionClient(transport, sessionId)
}

/** High-level plan API for CLI, desktop and mobile clients. */
export async function createPlan(client: SessionClient, input: CreatePlanCommandInput, options?: SessionExecuteOptions): Promise<Plan> {
  const result = await client.execute(createPlanCommand(input), options)
  if (result.type !== "plan_created") throw new Error("Session did not return plan_created")
  return result.plan
}

/** High-level execution API shared by CLI, desktop and mobile clients. */
export async function runAgent(client: SessionClient, input: StartRunCommandInput, options?: SessionExecuteOptions): Promise<RunResult> {
  const result = await client.execute(startRunCommand(input), options)
  if (result.type !== "run_result") throw new Error("Session did not return run_result")
  return result.result
}

/** Execute one already-tokenized shell command through the server safety boundary. */
export async function executeShell(
  client: SessionClient,
  input: ExecuteShellCommandInput,
  options?: SessionExecuteOptions,
): Promise<import("@ag2cli/core/tool-facts.js").ToolResult> {
  const result = await client.execute(executeShellCommand(input), options)
  if (result.type !== "shell_result") throw new Error("Session did not return shell_result")
  return result.result
}

/** Compact a durable session context through the same command as the TUI. */
export async function compactSession(
  client: SessionClient,
  input: Omit<CompactSessionCommandInput, "commandId"> & { readonly commandId?: string } = {},
  options?: SessionExecuteOptions,
): Promise<Extract<SessionCommandResult, { readonly type: "compacted" }>> {
  const result = await client.execute(compactSessionCommand({ ...input, commandId: input.commandId ?? randomUUID() }), options)
  if (result.type !== "compacted") throw new Error("Session did not return compacted")
  return result
}

/** Set a durable context-window override for the current session. */
export async function setSessionContextWindow(
  client: SessionClient,
  contextWindow: number,
  options?: SessionExecuteOptions,
): Promise<Extract<SessionCommandResult, { readonly type: "context_window_updated" }>> {
  const result = await client.execute(setContextWindowCommand({ commandId: randomUUID(), contextWindow }), options)
  if (result.type !== "context_window_updated") throw new Error("Session did not return context_window_updated")
  return result
}

/** Clear the durable context-window override for the current session. */
export async function clearSessionContextWindow(
  client: SessionClient,
  options?: SessionExecuteOptions,
): Promise<Extract<SessionCommandResult, { readonly type: "context_window_updated" }>> {
  const result = await client.execute(clearContextWindowCommand({ commandId: randomUUID() }), options)
  if (result.type !== "context_window_updated") throw new Error("Session did not return context_window_updated")
  return result
}

/** Select or clear the canonical main-session agent. */
export async function setSessionAgent(
  client: SessionClient,
  agentName?: string,
  options?: SessionExecuteOptions,
): Promise<Extract<SessionCommandResult, { readonly type: "agent_updated" }>> {
  const result = await client.execute(
    setAgentCommand({ commandId: randomUUID(), ...(agentName === undefined ? {} : { agentName }) }),
    options,
  )
  if (result.type !== "agent_updated") throw new Error("Session did not return agent_updated")
  return result
}

/** Update the canonical user-owned goal for a session. */
export async function updateSessionGoal(
  client: SessionClient,
  update: UpdateGoalCommandInput["update"],
  options?: SessionExecuteOptions,
): Promise<Extract<SessionCommandResult, { readonly type: "goal_updated" }>> {
  const result = await client.execute(updateGoalCommand({ commandId: randomUUID(), update }), options)
  if (result.type !== "goal_updated") throw new Error("Session did not return goal_updated")
  return result
}

/** Create a durable background task and return its canonical snapshot. */
export async function createBackgroundTask(
  client: SessionClient,
  input: CreateTaskCommandInput,
  options?: SessionExecuteOptions,
): Promise<TaskSnapshot> {
  const result = await client.execute(createTaskCommand(input), options)
  if (result.type !== "task_created") throw new Error("Session did not return task_created")
  return result.task
}

/** Read all durable background tasks visible in a session. */
export async function listBackgroundTasks(client: SessionClient, options?: SessionExecuteOptions): Promise<readonly TaskSnapshot[]> {
  const result = await client.execute(listTasksCommand(), options)
  if (result.type !== "tasks") throw new Error("Session did not return tasks")
  return result.tasks
}

/** Cancel a running or queued background task. */
export async function cancelBackgroundTask(
  client: SessionClient,
  input: CancelTaskCommandInput,
  options?: SessionExecuteOptions,
): Promise<TaskSnapshot> {
  const result = await client.execute(cancelTaskCommand(input), options)
  if (result.type !== "task_cancelled") throw new Error("Session did not return task_cancelled")
  return result.task
}

/** Resolve a pending tool approval from any connected client. */
export async function resolveApproval(
  client: SessionClient,
  input: ResolveApprovalCommandInput,
  options?: SessionExecuteOptions,
): Promise<SessionSnapshot> {
  const result = await client.execute(resolveApprovalCommand(input), options)
  if (result.type !== "snapshot") throw new Error("Session did not return an approval snapshot")
  return result.snapshot
}

export async function getSessionSnapshot(client: SessionClient, options?: SessionExecuteOptions): Promise<SessionSnapshot> {
  const result = await client.execute(getSnapshotCommand(), options)
  if (result.type !== "snapshot") throw new Error("Session did not return a snapshot")
  return result.snapshot
}

export async function readSessionTrace(client: SessionClient, options?: SessionExecuteOptions): Promise<readonly TraceRecord[]> {
  const result = await client.execute(readTraceCommand(), options)
  if (result.type !== "trace") throw new Error("Session did not return a trace")
  return result.records
}

/** Read a safe model-call projection; payloads require local-full observability. */
export async function readSessionModelCalls(
  client: SessionClient,
  includePayload = false,
  options?: SessionExecuteOptions,
): Promise<readonly ModelCallRecord[]> {
  const result = await client.execute(readModelCallsCommand(includePayload), options)
  if (result.type !== "model_calls") throw new Error("Session did not return model_calls")
  return result.records
}
