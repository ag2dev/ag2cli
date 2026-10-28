import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { SessionId } from "@ag2cli/core/ids.js"
import { JsonlEventStore, sessionTranscriptPath } from "../infrastructure/persistence/jsonl-event-store.js"
import { JsonlSessionCatalog } from "../infrastructure/persistence/jsonl-session-catalog.js"
import { FileSessionNotesStore } from "../infrastructure/persistence/file-session-notes-store.js"
import { JsonSessionSnapshotStore } from "../infrastructure/persistence/json-session-snapshot-store.js"
import { JsonlTraceSink } from "../infrastructure/observability/trace/jsonl-trace-sink.js"
import { JsonlTelemetrySink } from "../infrastructure/observability/telemetry/jsonl-telemetry-sink.js"
import { MemoryEventStore } from "../infrastructure/persistence/memory-event-store.js"
import { MemoryTraceSink } from "../infrastructure/observability/trace/memory-trace-sink.js"
import type { EventStore } from "@ag2cli/runtime/ports/event-store.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import { safeTraceStore, type TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
import { createObservabilityPolicy, type ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"
import type { TelemetrySink } from "@ag2cli/runtime/ports/telemetry.js"
import type { SessionSnapshotStore } from "@ag2cli/runtime/ports/session-snapshot-store.js"
import type { SessionNotesStore } from "@ag2cli/runtime/ports/session-notes-store.js"
import type { SessionExecutionReservation } from "@ag2cli/runtime/ports/session-execution-reservation.js"
import { thresholdsForContextWindow, type CompactThresholds } from "@ag2cli/core/model/limits.js"
import { resolveAutoFloor } from "@ag2cli/runtime/application/context/compact-budgets.js"
import { WorkspacePolicy } from "../capabilities/security/workspace.js"
import { checkTrust, getWorkspaceIdentity, loadTrustStore } from "../capabilities/security/trust.js"
import { scanMemoryRoots, type Memory, type MemoryRoot } from "../capabilities/memory/store.js"
import { scanSkillRoots, type Skill, type SkillDiagnostic, type SkillRoot } from "../capabilities/skills/store.js"
import { scanAgentRoots, type AgentScanResult } from "../capabilities/agents/store.js"
import {
  loadProjectInstructionFiles,
  type ProjectInstructionDiagnostic,
  type ProjectInstructionFile,
  type ProjectInstructionLoadResult,
} from "../capabilities/workspace/instructions.js"
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtime.js"
import { resolveMainModelFacts } from "./model-facts.js"
import { workspaceStorageDigest } from "../infrastructure/persistence/storage-resolver.js"

/** Per-composition operation context. Shared by both assembly phases; never part of services state. */
export interface AgentServerBuildContext {
  readonly signal?: AbortSignal
}

/**
 * Inputs for resolving cwd/config-bound agent server services (Phase 1).
 *
 * These are infrastructure decisions owned by the Host or the test harness:
 * storage, trust and capability roots. Session-level
 * inputs (model access, approval, callbacks) belong to Phase 2.
 */
export interface AgentServerServicesOptions extends AgentServerBuildContext {
  /** Physical canonical-history scope. */
  readonly storageMode?: "serve" | "local-tui" | "local-run" | "ephemeral"
  /** Stable identity used by serve routing; survives a workspace-root move. */
  readonly storageIdentity?: string
  /** Default loading policy selected by the entrypoint. */
  readonly runtimeProfile?: "headless" | "interactive"
  readonly runtimeConfig?: RuntimeConfig
  /** Immutable session workspace identity selected before server startup. */
  readonly workspaceRoot?: string
  /** Session-local directories selected before the first command. */
  readonly additionalDirectories?: readonly string[]
  /** Shared mutable workspace policy used by tools and @ attachments. */
  readonly workspace?: WorkspacePolicy
  /** Append-only event directory. */
  readonly eventRoot?: string
  /** Shared session writer authority for catalog and runtime composition. */
  readonly sessionAuthority?: SessionAuthority
  /** Optional derived snapshot store; defaults to a JSON file beside events. */
  readonly snapshotStore?: SessionSnapshotStore
  /** Session notes side-car store; defaults to a markdown file under the event root. */
  readonly notesStore?: SessionNotesStore
  readonly traceSink?: TraceStore
  readonly traceRoot?: string
  readonly observability?: ObservabilityPolicy
  readonly telemetrySink?: TelemetrySink
  readonly telemetryRoot?: string
  /** One ephemeral store per child agent session; defaults to an in-memory store. */
  readonly childEventStoreFactory?: () => EventStore
  readonly memoryRoot?: string
  readonly skillRoot?: string
  readonly compact?: { readonly enable?: boolean; readonly thresholds?: Partial<CompactThresholds> }
  /** Opt-in hierarchical project instruction loading for interactive clients. */
  readonly loadProjectInstructions?: boolean
  /** Explicit capability sources fail closed instead of degrading silently. */
  readonly strictCapabilities?: boolean
  /** Local durable execution guard; serve derives its own in-process reservation. */
  readonly executionReservation?: SessionExecutionReservation
  readonly reservationOwnerId?: string
}

/** Workspace-scoped durable state. Every member is created here and only here. */
export interface AgentServerStorageServices {
  readonly eventStore: EventStore
  readonly authority: SessionAuthority
  readonly catalog: SessionCatalog
  readonly snapshotStore: SessionSnapshotStore
  /** Durable transcript location shared by the notes side-car and boundary stamps. */
  readonly eventRoot: string
  readonly notesStore: SessionNotesStore
  /** Absolute transcript path per session, stamped into compaction boundary blocks. */
  readonly transcriptPath: (sessionId: SessionId) => string
  readonly traceSink: TraceStore
  readonly observability: ObservabilityPolicy
  readonly telemetrySink?: TelemetrySink
  /** One ephemeral store per child agent session; children never touch durable history. */
  readonly childEventStoreFactory: () => EventStore
  readonly childTraceSinkFactory: () => TraceStore
}

/** Capability surface resolved from config plus explicit overrides. */
export interface AgentServerCapabilityServices {
  readonly strict: boolean
  readonly loadProjectInstructions: boolean
  readonly compact: {
    readonly enable: boolean
    readonly thresholds: CompactThresholds
    /**
     * Main-model request-side output-token fact. Sessions that override the
     * context window re-derive their thresholds from it instead of the
     * conservative default reservation.
     */
    readonly maxOutputTokens: number
    /**
     * Pure per-window derivation for child agents: injected or configured
     * compact fields express a decision about the main conversation window,
     * so each child re-derives its pair from its own resolved model facts.
     */
    readonly thresholdsForModel: (modelId?: string) => CompactThresholds
  }
  readonly globHidden: boolean
  readonly globNoIgnore: boolean
}

/**
 * Hot-read capability sources. Trust and root selection are decided once at
 * resolution; file contents are re-read live so external editors take effect
 * without restarting the server.
 */
export interface AgentServerMemorySource {
  /** Current in-memory view; updated by `rescan`. */
  current(): readonly Memory[]
  /** Re-scan every trusted root on the next context build. */
  rescan(): readonly Memory[]
}

export interface AgentServerSkillSource {
  /** Result of the startup scan; used for the initial runtime status. */
  readonly initial: readonly Skill[]
  /** Re-scan skill roots so `.ag2cli/skills` edits apply without a restart. */
  rescan(): readonly Skill[]
}

export interface AgentServerInstructionSource {
  /** Startup scan result (empty unless project instructions are enabled). */
  readonly initial: readonly ProjectInstructionFile[]
  load(): ProjectInstructionLoadResult
}

/**
 * Coherent cwd/config-bound services for exactly one InProcessSessionServer.
 *
 * One instance may be consumed by `createAgentServerFromServices` once; it
 * must never be reused across workspaces or servers.
 */
export interface AgentServerServices {
  readonly isHeadless: boolean
  readonly workspace: WorkspacePolicy
  readonly storage: AgentServerStorageServices
  readonly capabilities: AgentServerCapabilityServices
  readonly sources: {
    readonly memory: AgentServerMemorySource
    readonly skills: AgentServerSkillSource
    readonly instructions: AgentServerInstructionSource
    readonly agents: { readonly scan: AgentScanResult }
  }
  readonly policy: {
    readonly maxTurns: RuntimeConfig["maxTurns"]
    readonly responseLanguage: RuntimeConfig["responseLanguage"]
  }
  readonly coordination: {
    readonly executionReservation?: SessionExecutionReservation
    readonly reservationOwnerId?: string
  }
  readonly diagnostics: {
    readonly skills: readonly SkillDiagnostic[]
    readonly instructions: readonly ProjectInstructionDiagnostic[]
  }
}

/**
 * Resolve Phase-1 services: config, workspace identity, storage, trust and
 * capability scans. Does not create a server and has no provider dependency;
 * session assembly happens in Phase 2.
 */
export async function resolveAgentServerServices(options: AgentServerServicesOptions): Promise<AgentServerServices> {
  throwIfAborted(options.signal)
  const config = options.runtimeConfig ?? loadRuntimeConfig()
  const isHeadless = options.runtimeProfile === "headless"
  const workspace =
    options.workspace ??
    new WorkspacePolicy({
      workspaceRoot: options.workspaceRoot ?? process.cwd(),
      additionalDirectories: options.additionalDirectories,
    })
  const loadInstructions = () =>
    loadProjectInstructionFiles({
      cwd: workspace.workspaceRoot,
      roots: [workspace.workspaceRoot],
      fileName: config.paths.instructionFileName,
    })
  const projectInstructionScan = options.loadProjectInstructions === true ? loadInstructions() : { files: [], diagnostics: [] }
  const agentScan = isHeadless
    ? { agents: [], diagnostics: [] }
    : scanAgentRoots([
        { root: resolve(workspace.workspaceRoot, config.paths.agentRoot), source: "project" },
        ...(config.paths.userAgentRoot ? [{ root: config.paths.userAgentRoot, source: "user" as const }] : []),
      ])

  const eventRoot = options.eventRoot ?? config.paths.eventRoot
  const notesStore = options.notesStore ?? new FileSessionNotesStore(eventRoot)
  const snapshotStore = options.snapshotStore ?? new JsonSessionSnapshotStore(eventRoot)
  const traceSink = safeTraceStore(options.traceSink ?? new JsonlTraceSink(options.traceRoot ?? join(eventRoot, "traces")))!
  const observability =
    options.observability ??
    createObservabilityPolicy({
      mode: config.observability.mode,
      telemetry: config.observability.telemetry,
      maxPayloadBytes: config.observability.maxPayloadBytes,
    })
  const telemetry =
    options.telemetrySink ??
    (observability.exportTelemetry
      ? new JsonlTelemetrySink(options.telemetryRoot ?? config.observability.telemetryRoot ?? join(eventRoot, "telemetry"))
      : undefined)
  // One EventStore per services instance; the catalog shares it so catalog
  // appends (create/fork) serialize through the same in-process queue as
  // server appends instead of relying only on the cross-process file lock.
  const storageMode = options.storageMode ?? (isHeadless ? "local-run" : "local-tui")
  const workspaceIdentity = options.storageIdentity ?? workspaceStorageDigest(workspace.workspaceRoot)
  const eventStore = new JsonlEventStore(eventRoot, {
    modeScope: storageMode,
    scopeId: `${storageMode}:${workspaceIdentity}`,
    workspaceIdentity,
  })
  const authority = options.sessionAuthority ?? new SessionAuthority(eventStore)

  const memoryRoot = options.memoryRoot ?? config.paths.memoryRoot
  const workspaceTrusted = isHeadless ? false : await isTrustedWorkspace(config.paths.trustStore, workspace.workspaceRoot)
  const projectMemoryTrusted = options.memoryRoot !== undefined || workspaceTrusted
  const memoryRoots: MemoryRoot[] = [
    ...(!isHeadless && config.paths.userMemoryRoot ? [{ root: config.paths.userMemoryRoot, scope: "user" as const }] : []),
    ...(!isHeadless && config.paths.teamMemoryRoot ? [{ root: config.paths.teamMemoryRoot, scope: "team" as const }] : []),
    ...(projectMemoryTrusted ? [{ root: memoryRoot, scope: "project" as const }] : []),
  ]
  let memories = scanMemoryRoots(memoryRoots)
  const projectSkillRoot = options.skillRoot ?? config.paths.skillRoot
  const projectSkillsTrusted = projectSkillRoot !== undefined || config.features.trustProjectSkills || (!isHeadless && workspaceTrusted)
  const configuredProjectSkillRoot = projectSkillRoot ?? ".ag2cli/skills"
  const resolvedProjectSkillRoot = isAbsolute(configuredProjectSkillRoot)
    ? configuredProjectSkillRoot
    : resolve(workspace.workspaceRoot, configuredProjectSkillRoot)
  const skillRoots: SkillRoot[] = []
  if (projectSkillsTrusted) {
    skillRoots.push({ root: resolvedProjectSkillRoot, source: "project" })
  }
  const userSkillRoot = isHeadless ? undefined : config.paths.userSkillRoot
  if (userSkillRoot) skillRoots.push({ root: userSkillRoot, source: "user" })
  // Re-scan on every use (context build / skill tool call) so a skill file
  // edited or added on disk takes effect without restarting the server —
  // same rationale as `memory.rescan` below. Trust and root selection are
  // decided once at startup; only file contents are re-read live.
  const rescanSkills = () => scanSkillRoots(skillRoots).skills
  const skillScan = scanSkillRoots(skillRoots)
  // A directory being untrusted silently drops it from skillRoots above; a
  // user who added skills to an untrusted project would otherwise see zero
  // feedback about why they never show up in the catalog or /skills.
  const skillTrustDiagnostics =
    !projectSkillsTrusted && existsSync(resolvedProjectSkillRoot)
      ? [
          {
            path: "skills:trust",
            error: `${resolvedProjectSkillRoot} exists, but the current workspace is not trusted; project skills from this directory were not loaded`,
          },
        ]
      : []
  throwIfAborted(options.signal)
  if (options.strictCapabilities && options.skillRoot !== undefined) {
    const skillRoot = resolve(workspace.workspaceRoot, options.skillRoot)
    if (!existsSync(skillRoot)) throw new Error(`Explicit skills directory does not exist: ${options.skillRoot}`)
    if (skillScan.diagnostics.length > 0) {
      throw new Error(`Explicit skills directory contains an invalid file: ${skillScan.diagnostics[0]!.path}`)
    }
  }

  return {
    isHeadless,
    workspace,
    storage: {
      eventStore,
      authority,
      catalog: new JsonlSessionCatalog(eventStore, authority, undefined, notesStore),
      snapshotStore,
      eventRoot,
      notesStore,
      transcriptPath: (id) => sessionTranscriptPath(eventRoot, id),
      traceSink,
      observability,
      ...(telemetry ? { telemetrySink: telemetry } : {}),
      childEventStoreFactory: options.childEventStoreFactory ?? (() => new MemoryEventStore()),
      childTraceSinkFactory: () => new MemoryTraceSink(),
    },
    capabilities: {
      strict: options.strictCapabilities === true,
      loadProjectInstructions: options.loadProjectInstructions === true,
      compact: resolveCompactCapability(config, options.compact),
      globHidden: config.features.globHidden,
      globNoIgnore: config.features.globNoIgnore,
    },
    sources: {
      memory: {
        current: () => memories,
        rescan: () => {
          memories = scanMemoryRoots(memoryRoots)
          return memories
        },
      },
      skills: {
        initial: skillScan.skills,
        rescan: rescanSkills,
      },
      instructions: {
        initial: projectInstructionScan.files,
        load: loadInstructions,
      },
      agents: { scan: agentScan },
    },
    policy: {
      maxTurns: config.maxTurns,
      responseLanguage: config.responseLanguage,
    },
    coordination: {
      ...(options.executionReservation === undefined ? {} : { executionReservation: options.executionReservation }),
      ...(options.reservationOwnerId === undefined ? {} : { reservationOwnerId: options.reservationOwnerId }),
    },
    diagnostics: {
      skills: [...skillScan.diagnostics, ...skillTrustDiagnostics],
      instructions: projectInstructionScan.diagnostics,
    },
  }
}

/**
 * Complete compaction thresholds per field: injected value wins, then the
 * explicit config value, then derivation from the resolved main-model window
 * facts (context window plus the request-side output-token fact). Illegal
 * combinations — only reachable through explicit or injected fields, since
 * pure derivation always yields blocking > auto and an auto above the floor —
 * fail closed at resolution time.
 */
function resolveCompactCapability(
  config: RuntimeConfig,
  injected: { readonly enable?: boolean; readonly thresholds?: Partial<CompactThresholds> } | undefined,
): AgentServerCapabilityServices["compact"] {
  const resolved = resolveMainModelFacts(config).resolved
  const derived = thresholdsForContextWindow(resolved.contextWindow.value, resolved.defaultMaxOutputTokens)
  const autoCompactTokens = resolveAutoFloor(
    injected?.thresholds?.autoCompactTokens ?? config.compact?.autoCompactTokens ?? derived.autoCompactTokens,
  )
  const blockingLimitTokens =
    injected?.thresholds?.blockingLimitTokens ?? config.compact?.blockingLimitTokens ?? derived.blockingLimitTokens
  if (blockingLimitTokens <= autoCompactTokens) {
    throw new Error("compact blockingLimitTokens must be greater than autoCompactTokens")
  }
  return {
    enable: injected?.enable ?? true,
    thresholds: { autoCompactTokens, blockingLimitTokens },
    maxOutputTokens: resolved.defaultMaxOutputTokens,
    thresholdsForModel: (modelId?: string) => {
      const facts = resolveMainModelFacts(config, modelId).resolved
      return thresholdsForContextWindow(facts.contextWindow.value, facts.defaultMaxOutputTokens)
    },
  }
}

async function isTrustedWorkspace(trustStorePath: string, workspaceRoot = process.cwd()): Promise<boolean> {
  try {
    const identity = await getWorkspaceIdentity(workspaceRoot)
    return checkTrust(workspaceRoot, loadTrustStore(trustStorePath), identity).trusted
  } catch {
    return false
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException("headless operation cancelled", "AbortError")
}
