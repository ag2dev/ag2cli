import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { JsonlEventStore } from "../infrastructure/persistence/jsonl-event-store.js"
import { JsonlSessionCatalog } from "../infrastructure/persistence/jsonl-session-catalog.js"
import { JsonSessionSnapshotStore } from "../infrastructure/persistence/json-session-snapshot-store.js"
import { JsonlTraceSink } from "../infrastructure/observability/trace/jsonl-trace-sink.js"
import { JsonlTelemetrySink } from "../infrastructure/observability/telemetry/jsonl-telemetry-sink.js"
import { InProcessSessionServer } from "../interfaces/transport/in-process-session-server.js"
import { ModelPlanProvider } from "../infrastructure/model/model-plan-provider.js"
import type { ModelClient } from "@ag2cli/runtime/ports/model/contract.js"
import { planId } from "@ag2cli/core/ids.js"
import type { PlanProvider } from "@ag2cli/runtime/ports/model-provider.js"
import { safeTraceStore, type TraceStore } from "@ag2cli/runtime/ports/trace-sink.js"
import { createObservabilityPolicy, type ObservabilityPolicy } from "@ag2cli/runtime/ports/observability.js"
import type { TelemetrySink } from "@ag2cli/runtime/ports/telemetry.js"
import { loadRuntimeConfig, type RuntimeConfig } from "../config/runtime.js"
import type { SessionSnapshotStore } from "@ag2cli/runtime/ports/session-snapshot-store.js"
import { SessionAuthority } from "@ag2cli/runtime/application/session/session-authority.js"
import { canonicalizeExistingDirectory, WorkspacePolicy } from "../capabilities/security/workspace.js"
import { type AdditionalDirectoryResolver } from "@ag2cli/runtime/application/session/workspace-roots.js"
import { workspaceStorageDigest } from "../infrastructure/persistence/storage-resolver.js"

export interface BuildPlanServerOptions {
  /** Inject a provider in tests or a custom deployment. */
  readonly provider?: PlanProvider
  /** Production adapter; only the composition layer knows this type. */
  readonly client?: ModelClient
  /** Append-only event directory. */
  readonly eventRoot?: string
  /** Optional derived snapshot store; defaults to a JSON file beside events. */
  readonly snapshotStore?: SessionSnapshotStore
  /** Optional diagnostics sink; it never becomes part of session state. */
  readonly traceSink?: TraceStore
  /** Optional trace directory; defaults to <eventRoot>/traces. */
  readonly traceRoot?: string
  readonly observability?: ObservabilityPolicy
  readonly telemetrySink?: TelemetrySink
  readonly telemetryRoot?: string
  readonly runtimeConfig?: RuntimeConfig
  readonly workspaceRoot?: string
  readonly additionalDirectories?: readonly string[]
}

/**
 * Assemble the plan-only server boundary.
 *
 * The returned server owns the use case and event store. Clients never receive
 * the provider, event store, or model SDK, which keeps the session authority
 * on the server side.
 */
export function buildPlanServer(options: BuildPlanServerOptions): InProcessSessionServer {
  const provider = options.provider ?? (options.client ? new ModelPlanProvider(options.client) : undefined)
  if (!provider) {
    throw new Error("buildPlanServer requires a provider or client")
  }

  const config = options.runtimeConfig ?? loadRuntimeConfig()
  const eventRoot = options.eventRoot ?? config.paths.eventRoot
  const workspaceIdentity = workspaceStorageDigest(options.workspaceRoot ?? process.cwd())
  const eventStore = new JsonlEventStore(eventRoot, {
    modeScope: "local-run",
    scopeId: `local-run:${workspaceIdentity}`,
    workspaceIdentity,
  })
  const authority = new SessionAuthority(eventStore)
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
  const workspaceRoot = new WorkspacePolicy({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    additionalDirectories: options.additionalDirectories,
  }).workspaceRoot
  const additionalDirectoryResolver: AdditionalDirectoryResolver = {
    resolve: async (directory, requestedWorkspaceRoot, existingDirectories, signal) => {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError")
      const canonical = await canonicalizeExistingDirectory(directory)
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError")
      const policy = new WorkspacePolicy({ workspaceRoot: requestedWorkspaceRoot, additionalDirectories: existingDirectories })
      const result = await policy.addAdditionalDirectory(canonical)
      return { canonical: result.canonical, changed: result.changed, directories: policy.additionalDirectories }
    },
    // Session events are the sole authority. A plan server may host multiple
    // sessions, so an add-dir command must not mutate shared composition state.
    ensure: async () => {},
  }
  return new InProcessSessionServer({
    provider,
    workspaceRoot,
    eventStore,
    authority,
    snapshotStore,
    catalog: new JsonlSessionCatalog(eventStore, authority),
    traceSink,
    observability,
    additionalDirectoryResolver,
    ...(telemetry ? { telemetry } : {}),
    identity: {
      nextPlanId: () => planId(randomUUID()),
      nextEventId: () => randomUUID(),
      now: () => new Date().toISOString(),
    },
  })
}
