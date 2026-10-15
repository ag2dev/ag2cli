import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { callModelExecutionProvider } from "../infrastructure/model/call-model-execution-provider.js"
import { defaultContextBuilder, type RuntimeContextEnvironment } from "@ag2cli/runtime/application/context/default-context-builder.js"
import { compactContextBuilder, contextCompactor } from "@ag2cli/runtime/application/context/compact-context-builder.js"
import type { AgentProfile, AgentProfileResolver } from "@ag2cli/runtime/ports/agent-profile.js"
import { registryToolExecutor } from "../capabilities/tools/registry-tool-executor.js"
import { guardModelToolExecutor } from "../capabilities/tools/model-tool-executor-guard.js"
import { InProcessSessionServer } from "../interfaces/transport/in-process-session-server.js"
import { ModelPlanProvider } from "../infrastructure/model/model-plan-provider.js"
import type { ModelClient } from "@ag2cli/runtime/ports/model/contract.js"
import { modelClientToStream } from "../infrastructure/model/stream-adapter.js"
import { planId, runId, type SessionId } from "@ag2cli/core/ids.js"
import type { PlanProvider } from "@ag2cli/runtime/ports/model-provider.js"
import { createDenyAllApprovalBroker, type ApprovalBroker } from "@ag2cli/runtime/ports/approval-broker.js"
import { createGuardianWaitRegistry, type Guardian } from "@ag2cli/runtime/ports/guardian.js"
import type { ExecutionModelProvider } from "@ag2cli/runtime/ports/execution-model-provider.js"
import type { ToolExecutor } from "@ag2cli/runtime/ports/tool-executor.js"
import type { ContextBuilder } from "@ag2cli/runtime/ports/context-builder.js"
import { createWorkspaceAttachmentLoader } from "../capabilities/context/workspace-attachments.js"
import { ToolRegistry } from "../capabilities/tools/registry.js"
import { ReadFileTool } from "../capabilities/tools/read-file-tool.js"
import { WriteFileTool } from "../capabilities/tools/write-file-tool.js"
import { FileEditTool } from "../capabilities/tools/file-edit-tool.js"
import { GlobTool } from "../capabilities/tools/glob-tool.js"
import { GrepTool } from "../capabilities/tools/grep-tool.js"
import { BashTool } from "../capabilities/tools/bash-tool.js"
import { WebFetchTool } from "../capabilities/tools/web-fetch-tool.js"
import { TodoWriteTool } from "../capabilities/tools/todo-write-tool.js"
import { AskUserQuestionTool } from "../capabilities/tools/ask-user-tool.js"
import type { AskUser } from "@ag2cli/runtime/ports/tool/contract.js"
import type { ApiToolDefinition } from "@ag2cli/core/tool-facts.js"
import { canonicalizeExistingDirectory, computeWorkspaceScopeDigest, WorkspacePolicy } from "../capabilities/security/workspace.js"
import { normalizeModelBashPreparation } from "../capabilities/security/bash/security-layer.js"
import { tryQuoteShellArgs } from "../capabilities/security/bash/shell-quote.js"
import { BASH_SECURITY_PROMPT } from "../capabilities/security/bash-prompt.js"
import { ReadFileStateMap } from "../capabilities/tools/file-state.js"
import { buildSystemPrompt } from "@ag2cli/runtime/application/prompt/system-prompt.js"
import { buildRuntimeEnvironmentContext } from "../capabilities/context/system-context.js"
import { buildAgentBehaviorPrompt } from "@ag2cli/runtime/application/prompt/agent-behavior.js"
import type { MemorySelector } from "@ag2cli/runtime/application/memory/retrieve.js"
import { SkillTool } from "../capabilities/tools/skill-tool.js"
import { AgentTool } from "../capabilities/tools/agent-tool.js"
import { AgentJoinTool } from "../capabilities/tools/agent-join-tool.js"
import {
  createChildAgentRunner,
  type ChildAgentRunner,
  type ChildApprovalRunnerSurface,
} from "../capabilities/execution/child-agent-runner.js"
import { createModelSummarizer } from "@ag2cli/runtime/application/context/model-summarizer.js"
import type { RuntimeStatus } from "@ag2cli/runtime/ports/runtime-status.js"
import type { BashSecurityPort } from "@ag2cli/runtime/ports/security.js"
import type { AdditionalDirectoryResolver } from "@ag2cli/runtime/application/session/workspace-roots.js"
import type { AgentServerBuildContext, AgentServerServices, AgentServerServicesOptions } from "./agent-server-services.js"
import { createBackgroundChildTaskRecorder, createChildTaskSettleProjector } from "./child-task-settle.js"

/**
 * Session-level inputs for Phase-2 assembly. Infrastructure (storage, trust,
 * capability sources) comes from `services`; only model access,
 * interactive adapters and edge callbacks are chosen here.
 */
export interface AgentServerRuntimeOptions extends AgentServerBuildContext {
  readonly services: AgentServerServices
  readonly provider?: PlanProvider
  readonly client?: ModelClient
  readonly model?: ExecutionModelProvider
  readonly tools?: ToolExecutor
  readonly approval?: ApprovalBroker
  /**
   * Bubbling ingress for attributed child asks (TUI bridge). Children spawn
   * under frozen non-auto security bubble their asks through it; absent
   * keeps every child ask on the fail-closed backstop.
   */
  readonly childApprovals?: ChildApprovalRunnerSurface
  /** Answers auto-mode permission asks; absent keeps every auto ask terminal. */
  readonly guardian?: Guardian
  /** Whole-review deadline for auto-mode asks; absent keeps the runtime default. */
  readonly guardianDeadlineMs?: number
  /** Expose Bash only to explicit interactive `!` commands, not to the model. */
  readonly enableInteractiveShell?: boolean
  readonly askUser?: AskUser
  readonly contextBuilder?: ContextBuilder
  readonly memorySelector?: MemorySelector
  /** Receives safe, read-only composition diagnostics for rich clients. */
  readonly onRuntimeStatus?: (status: RuntimeStatus) => void
  /** Receives the assembled child-agent runner; children are process-local runner state, never session state. */
  readonly onChildRunner?: (runner: ChildAgentRunner) => void
}

/** Flat composition inputs: Phase-1 services options plus Phase-2 runtime inputs. */
export type AgentServerCompositionOptions = AgentServerServicesOptions & Omit<AgentServerRuntimeOptions, "services">

/** Compile-time exhaustiveness guard: the argument type must already be `never`. */
export type AssertNever<T extends never> = T

export function pickOptionFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const picked: Partial<Pick<T, K>> = {}
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key]
  }
  return picked as Pick<T, K>
}

export function omitOptionFields<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Omit<T, K> {
  const rest = { ...source } as Record<string, unknown>
  for (const key of keys) delete rest[key as string]
  return rest as Omit<T, K>
}

/**
 * Single source of truth for the two-phase split: which flat composition
 * fields belong to the Phase-2 runtime half. Everything not listed here stays
 * in the Phase-1 services half. `signal` is shared build context and is
 * written to both halves explicitly by the split.
 */
export const RUNTIME_OPTION_KEYS = [
  "provider",
  "client",
  "model",
  "tools",
  "approval",
  "childApprovals",
  "guardian",
  "guardianDeadlineMs",
  "enableInteractiveShell",
  "askUser",
  "contextBuilder",
  "memorySelector",
  "onRuntimeStatus",
  "onChildRunner",
] as const satisfies readonly (keyof Omit<AgentServerRuntimeOptions, "services" | keyof AgentServerBuildContext>)[]

/** Fields shared by both assembly phases; the split writes them to each side. */
export const SHARED_OPTION_KEYS = ["signal"] as const satisfies readonly (keyof AgentServerBuildContext)[]

/** Adding an unclassified runtime option field fails compilation: new fields must be classified into RUNTIME_OPTION_KEYS or SHARED_OPTION_KEYS. */
export type AssertRuntimeOptionsClassified = AssertNever<
  Exclude<
    keyof Omit<AgentServerRuntimeOptions, "services" | keyof AgentServerBuildContext>,
    (typeof RUNTIME_OPTION_KEYS)[number] | (typeof SHARED_OPTION_KEYS)[number]
  >
>

/** Internal: split flat composition options into the two phase inputs. */
export function splitAgentServerCompositionOptions(options: AgentServerCompositionOptions): {
  readonly services: AgentServerServicesOptions
  readonly runtime: Omit<AgentServerRuntimeOptions, "services">
} {
  return {
    services: omitOptionFields(options, RUNTIME_OPTION_KEYS),
    runtime: pickOptionFields(options, [...RUNTIME_OPTION_KEYS, ...SHARED_OPTION_KEYS]),
  }
}

/** Services carry workspace-scoped state and mutable sources; reuse across servers is illegal. */
const consumedServices = new WeakSet<AgentServerServices>()

/**
 * Compose the personal server profile from resolved services (Phase 2). The
 * composition owns concrete tools and provider adapters; Session/application
 * layers only see ports. Every workspace-scoped store comes from
 * `services.storage`; this phase never constructs persistence itself.
 */
export async function createAgentServerFromServices(options: AgentServerRuntimeOptions): Promise<InProcessSessionServer> {
  const { services } = options
  if (consumedServices.has(services)) {
    throw new Error(
      "AgentServerServices can only be consumed once by createAgentServerFromServices; resolve services again for each workspace/server",
    )
  }
  consumedServices.add(services)
  throwIfAborted(options.signal)
  const provider = options.provider ?? (options.client ? new ModelPlanProvider(options.client) : undefined)
  if (!provider) throw new Error("Agent Server requires a provider or client")

  let runtimeStatus: RuntimeStatus | undefined
  let server: InProcessSessionServer | undefined
  try {
    const agentProfiles: readonly AgentProfile[] = services.sources.agents.scan.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      instructions: agent.body,
      tools: agent.tools,
      ...(agent.model ? { model: agent.model } : {}),
    }))
    const agentResolver: AgentProfileResolver = {
      resolve: (name) => agentProfiles.find((agent) => agent.name.toLowerCase() === name.trim().toLowerCase()),
    }
    const {
      registry: defaultTools,
      interactiveShell,
      setChildRunner,
    } = await createCoreTools(services, {
      askUser: options.askUser,
      interactiveShell: options.enableInteractiveShell,
      signal: options.signal,
      agentResolver,
    })
    // Model Bash has exactly one runtime authority: the local registry wired to
    // canonical preparation and the permission judgment. Custom/remote
    // executors remain available for non-Bash tools but cannot replace or
    // advertise Bash.
    const modelTools = options.tools === undefined ? registryToolExecutor(defaultTools) : guardModelToolExecutor(options.tools)
    const model =
      options.model ??
      (options.client
        ? callModelExecutionProvider(
            async (messages, callOptions) =>
              options.client!.call({
                messages,
                ...(callOptions?.model ? { model: callOptions.model } : {}),
                ...(callOptions?.tools ? { tools: callOptions.tools } : {}),
                ...(callOptions?.maxTokens === undefined ? {} : { maxTokens: callOptions.maxTokens }),
                ...(callOptions?.systemPrompt ? { systemPrompt: callOptions.systemPrompt } : {}),
                ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
                ...(callOptions?.thinking ? { thinking: callOptions.thinking } : {}),
                ...(callOptions?.reasoningEffort ? { reasoningEffort: callOptions.reasoningEffort } : {}),
              }),
            options.client.callStream ? modelClientToStream(options.client) : undefined,
          )
        : undefined)
    // The session permission judgment decides every request; there is no
    // second broker authority. When no interactive broker is injected there is
    // no user to ask, so surviving requests are denied fast instead of hanging.
    const approval = options.approval ?? createDenyAllApprovalBroker()
    const bashSecurity: BashSecurityPort = {
      normalizeModelBashPreparation,
      quoteShellArgs: (argv) => tryQuoteShellArgs([...argv]),
    }
    // The child runner assembles only when a model layer exists; the agent
    // tool stays registered either way and the judgment alone decides
    // visibility. Child permission surfaces are minted per spawn from the
    // injected seams (bridge for frozen non-auto asks, guardian for frozen
    // auto asks); every other child keeps the deny-fast fail-closed backstop.
    let childRunner: ChildAgentRunner | undefined
    // Settle projection holder (onTransientEvent precedent): the runner
    // assembles before the server, so the recorder/serial point/notification
    // sink bind only after construction. No settle can predate the install —
    // spawns reach the runner exclusively through the server's runs.
    const childTaskSettle = createChildTaskSettleProjector()
    if (model !== undefined) {
      childRunner = createChildAgentRunner({
        model,
        tools: modelTools,
        approval: createDenyAllApprovalBroker(),
        ...(options.childApprovals === undefined ? {} : { childApprovals: options.childApprovals }),
        ...(options.guardian === undefined ? {} : { guardian: options.guardian }),
        agentProfiles: agentResolver,
        eventStoreFactory: services.storage.childEventStoreFactory,
        traceSinkFactory: services.storage.childTraceSinkFactory,
        observability: services.storage.observability,
        identity: {
          nextEventId: () => randomUUID(),
          nextRunId: () => runId(randomUUID()),
          now: () => new Date().toISOString(),
        },
        bashSecurity,
        workspacePolicyFactory: (policyOptions) => new WorkspacePolicy(policyOptions),
        workspaceScopeDigest: computeWorkspaceScopeDigest,
        environment: { cwd: process.cwd(), platform: process.platform },
        // The runner assembles before the server exists, so attributed child
        // events flow through the late-bound session transient seam.
        onTransientEvent: (event) => server?.publishTransientEvent(event),
        // Async settles project onto the parent session's durable stream
        // (task record + notification) through the same late-bound holder.
        onChildSettled: (settled) => childTaskSettle.project(settled),
        ...(services.policy.maxTurns === undefined ? {} : { maxTurnsDefault: services.policy.maxTurns }),
      })
      setChildRunner(childRunner)
      options.onChildRunner?.(childRunner)
    }
    runtimeStatus = {
      workspaceRoot: services.workspace.workspaceRoot,
      additionalDirectories: services.workspace.additionalDirectories,
      tools: modelTools.listTools().map((tool) => tool.name),
      skills: services.sources.skills.initial.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.source ? { source: skill.source } : {}),
        ...(skill.triggers.length > 0 ? { triggers: skill.triggers } : {}),
      })),
      agents: services.sources.agents.scan.agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: agent.source,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.tools.length > 0 ? { tools: [...agent.tools] } : {}),
        path: agent.path,
      })),
      skillDiagnostics: services.diagnostics.skills.map((diagnostic) => ({
        source: `skill:${diagnostic.path}`,
        message: diagnostic.error,
      })),
      memories: services.sources.memory.current().map((memory) => ({
        name: memory.name,
        description: memory.description,
        type: memory.type,
        ...(memory.scope ? { scope: memory.scope } : {}),
        ...(memory.alwaysLoad ? { alwaysLoad: true } : {}),
        ...(memory.path ? { path: memory.path } : {}),
      })),
      ...(services.capabilities.loadProjectInstructions
        ? {
            instructions: services.sources.instructions.initial.map((instruction) => ({
              path: instruction.path,
              bytes: Buffer.byteLength(instruction.content, "utf8"),
            })),
            instructionDiagnostics: services.diagnostics.instructions.map((diagnostic) => ({
              source: `instructions:${diagnostic.path}`,
              message: diagnostic.message,
            })),
          }
        : {}),
    }
    options.onRuntimeStatus?.(runtimeStatus)
    const contextOptions = {
      basePrompt: buildSystemPrompt({
        identity: [
          "You are AG2CLI, an open-source coding agent and CLI that helps users with software engineering tasks.",
          "For information that depends on the current runtime environment, prefer the runtime context or call the relevant tool instead of guessing from model knowledge.",
        ],
      }),
      ...(services.policy.responseLanguage === undefined ? {} : { responseLanguage: services.policy.responseLanguage }),
      dynamicPrompt: (tools: readonly ApiToolDefinition[]) => [
        ...buildAgentBehaviorPrompt({ toolNames: tools.map((tool) => tool.name) }),
        ...(tools.some((tool) => tool.name === "bash") ? [BASH_SECURITY_PROMPT] : []),
      ],
      runtimeContextSource: (environment: RuntimeContextEnvironment) =>
        buildRuntimeEnvironmentContext(environment, services.workspace.workspaceRoot).join("\n"),
      // Re-scan on every context build so an external `/memory` editor takes
      // effect on the next turn without adding a second memory lifecycle.
      memorySource: services.sources.memory.rescan,
      ...(options.memorySelector ? { memorySelector: options.memorySelector } : {}),
      skillSource: services.sources.skills.rescan,
      ...(services.capabilities.loadProjectInstructions ? { instructionSource: () => services.sources.instructions.load().files } : {}),
    }
    const summarizeContext = model === undefined ? undefined : createModelSummarizer(model, services.storage.observability)
    const compactor = summarizeContext ? contextCompactor({ summarize: summarizeContext }) : undefined
    const contextBuilder =
      options.contextBuilder ??
      (summarizeContext
        ? compactContextBuilder({
            ...contextOptions,
            enable: services.capabilities.compact.enable,
            thresholds: services.capabilities.compact.thresholds,
            traceSink: services.storage.traceSink,
            summarize: summarizeContext,
          })
        : defaultContextBuilder(contextOptions))

    server = new InProcessSessionServer({
      provider,
      workspaceRoot: services.workspace.workspaceRoot,
      ...(services.coordination.executionReservation === undefined
        ? {}
        : { executionReservation: services.coordination.executionReservation }),
      ...(services.coordination.reservationOwnerId === undefined ? {} : { reservationOwnerId: services.coordination.reservationOwnerId }),
      defaultMaxTurns: services.policy.maxTurns,
      eventStore: services.storage.eventStore,
      authority: services.storage.authority,
      snapshotStore: services.storage.snapshotStore,
      workspaceRootCanonicalizer: (root) => (root.startsWith("/") ? root : resolve(services.workspace.workspaceRoot, root)),
      workspaceScopeDigest: computeWorkspaceScopeDigest,
      workspacePolicyFactory: (policyOptions) => new WorkspacePolicy(policyOptions),
      environment: { cwd: process.cwd(), platform: process.platform },
      bashSecurity,
      catalog: services.storage.catalog,
      additionalDirectoryResolver,
      // A parent policy change settles that parent's waiting child asks
      // (bridge parkers terminal stale, frozen-auto guardian reviews abort).
      ...(childRunner === undefined
        ? {}
        : {
            onSecurityChange: (sessionId: SessionId, policyRevision: number) =>
              childRunner!.invalidateChildren(String(sessionId), policyRevision),
          }),
      traceSink: services.storage.traceSink,
      observability: services.storage.observability,
      ...(services.storage.telemetrySink ? { telemetry: services.storage.telemetrySink } : {}),
      identity: {
        nextPlanId: () => planId(randomUUID()),
        nextEventId: () => randomUUID(),
        now: () => new Date().toISOString(),
      },
      ...(model
        ? {
            agentProfiles: agentResolver,
            execution: {
              model,
              tools: modelTools,
              ...(interactiveShell ? { shellTools: interactiveShell } : {}),
              approval,
              // Surfaces follow the injected interactive adapters: a host
              // without an ask answerer must not advertise tools whose
              // judgment needs one. The guardian answers auto-mode asks.
              permissionSurfaces: {
                approvalSurface: options.approval !== undefined || options.guardian !== undefined,
                interactionSurface: options.askUser !== undefined,
              },
              ...(options.guardian === undefined ? {} : { guardian: options.guardian }),
              // The configured timeout bounds the whole review race, so the
              // adapter's provider call and the executor deadline agree.
              ...(options.guardianDeadlineMs === undefined ? {} : { guardianDeadlineMs: options.guardianDeadlineMs }),
              guardianWaits: createGuardianWaitRegistry(),
              contextBuilder,
              agentProfiles: agentResolver,
              ...(compactor ? { compactor } : {}),
              fileContextLoader: createWorkspaceAttachmentLoader(services.workspace),
              workspaceRootCanonicalizer: (root) => {
                return root.startsWith("/") ? root : resolve(services.workspace.workspaceRoot, root)
              },
              workspaceScopeDigest: computeWorkspaceScopeDigest,
              workspacePolicyFactory: (policyOptions) => new WorkspacePolicy(policyOptions),
              environment: { cwd: process.cwd(), platform: process.platform },
              bashSecurity,
              identity: {
                nextEventId: () => randomUUID(),
                nextRunId: () => runId(randomUUID()),
                now: () => new Date().toISOString(),
              },
              ...(services.coordination.executionReservation === undefined
                ? {}
                : { executionReservation: services.coordination.executionReservation }),
              ...(services.coordination.reservationOwnerId === undefined
                ? {}
                : { reservationOwnerId: services.coordination.reservationOwnerId }),
            },
          }
        : {}),
    })
    const settledServer = server
    childTaskSettle.install({
      recorder: createBackgroundChildTaskRecorder({ registry: settledServer.taskRegistry }),
      serialPoint: settledServer.policySerialPoint,
      notify: (id, text) => settledServer.enqueueHostNotification(id, text),
    })
    await server.recoverUnfinishedRuns()
    return server
  } catch (error) {
    try {
      if (server !== undefined) await server.close()
    } catch {
      // Cleanup failures must not mask the original assembly error.
    }
    throw error
  }
}

// The Session event stream is the only scope authority.  Do not mutate
// the composition-time policy here: one server may host multiple Sessions,
// and a directory added to one Session must not leak into another.
const additionalDirectoryResolver: AdditionalDirectoryResolver = {
  resolve: async (directory, workspaceRoot, existingDirectories, signal) => {
    throwIfAborted(signal)
    const canonical = await canonicalizeExistingDirectory(directory)
    throwIfAborted(signal)
    const policy = new WorkspacePolicy({ workspaceRoot, additionalDirectories: existingDirectories })
    const result = await policy.addAdditionalDirectory(canonical)
    return { canonical: result.canonical, changed: result.changed, directories: policy.additionalDirectories }
  },
  ensure: async () => {},
}

async function createCoreTools(
  services: AgentServerServices,
  options: {
    askUser?: AskUser
    interactiveShell?: boolean
    signal?: AbortSignal
    agentResolver: AgentProfileResolver
  },
): Promise<{
  registry: ToolRegistry
  interactiveShell?: ToolExecutor
  setChildRunner: (runner: ChildAgentRunner) => void
}> {
  const context = {
    workspace: services.workspace,
    readFileState: new ReadFileStateMap(),
    ...(options.askUser ? { askUser: options.askUser } : {}),
  }
  const registry = new ToolRegistry().setContext(context)
  registry.register(
    new ReadFileTool(),
    new GlobTool({ includeHidden: services.capabilities.globHidden, noIgnore: services.capabilities.globNoIgnore }),
    new GrepTool(),
    new TodoWriteTool(),
  )
  // ask_user is part of the fixed launch set: its visibility belongs to the
  // permission judgment — whose interaction-surface fact derives from the
  // injected askUser adapter — not to registration, so a surface-less host
  // converges to the approval_required terminal instead of a non-terminal
  // unknown-tool loop.
  registry.register(new AskUserQuestionTool())
  // Registration is decided by the resolve-time snapshot (`initial`): a skill
  // added between resolve and create is picked up by the next server start,
  // not by this one; runtime rescans only refresh tool CONTENT. Unlike
  // ask_user, skill absence is a capability-presence fact — no resolved
  // sources, nothing to expose — with no permission-surface fact the
  // judgment could gate on, so it stays registration-gated.
  if (services.sources.skills.initial.length > 0) registry.register(new SkillTool({ skills: services.sources.skills.rescan }))
  // Fixed launch registration set: write/bash/web_fetch always register; the
  // session permission judgment alone decides visibility and execution.
  registry.register(new WriteFileTool(), new FileEditTool(), new BashTool(), new WebFetchTool())
  // The agent face registers unconditionally with a lazy runner handle: the
  // composition assigns the assembled runner after the model layer exists,
  // and an unset thunk is a structured "delegation unavailable" refusal.
  // agent_join shares the same handle and the same refusal shape; judgment
  // classifies it session-internal (no approval card, plan-usable).
  let childRunner: ChildAgentRunner | undefined
  registry.register(
    new AgentTool({
      runnerThunk: () => childRunner,
      agentResolver: options.agentResolver,
      availableAgentNames: () => services.sources.agents.scan.agents.map((agent) => agent.name),
      availableToolNames: () => registry.list().map((tool) => tool.name),
      ...(services.policy.maxTurns === undefined ? {} : { maxTurnsDefault: services.policy.maxTurns }),
    }),
    new AgentJoinTool({ runnerThunk: () => childRunner }),
  )

  // Interactive `!` commands use a separate user-command policy. This private
  // registry is never part of the model tool list; explicit user input is
  // not model authorization.
  const interactiveRegistry = options.interactiveShell ? new ToolRegistry().register(new BashTool({ mode: "interactive" })) : undefined

  return {
    registry,
    ...(interactiveRegistry ? { interactiveShell: registryToolExecutor(interactiveRegistry, { modelBashAuthority: false }) } : {}),
    setChildRunner: (runner: ChildAgentRunner) => {
      childRunner = runner
    },
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("headless operation cancelled", "AbortError")
}
