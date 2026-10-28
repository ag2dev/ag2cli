import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { JsonRpcAppServerClient, type AppServerClientOptions } from "@ag2cli/app-server-client/client.js"
import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerCapabilities,
  type AppServerDeviceRegistry,
  type AppServerDescriptor,
  type AppServerScope,
  type JsonRpcNotification,
  type ServerInitializeResult,
} from "@ag2cli/app-server-protocol/types.js"
import type { PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import { AppServerRpcConnection, DEFAULT_SELECTABLE_MODES } from "../interfaces/transport/app-server-rpc.js"
import { AppServerOperationRegistry } from "../interfaces/transport/app-server-operation-registry.js"
import { AppServerPresenceRegistry } from "../interfaces/transport/app-server-presence.js"
import { InProcessAppServerTransport } from "../interfaces/transport/in-process-app-server.js"
import { readAg2cliVersion } from "../public/version.js"
import { DEFAULT_EVENT_ROOT, loadRuntimeConfig, type RuntimeConfig } from "../config/runtime.js"
import { acquireDurableHostLease, type DurableHostLease } from "../infrastructure/persistence/durable-host-lease.js"
import { JsonlSessionCatalog } from "../infrastructure/persistence/jsonl-session-catalog.js"
import { WorkspaceUnavailableError, workspaceIdForRoot } from "../capabilities/security/workspace.js"
import { WorkspaceInspector } from "../capabilities/workspace/inspection.js"
import type { InProcessSessionServer } from "../interfaces/transport/in-process-session-server.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import { createAgentServerHostIdentity, type AgentServerHostIdentity } from "./host-identity.js"
import {
  createAgentServerFromServices,
  omitOptionFields,
  pickOptionFields,
  splitAgentServerCompositionOptions,
  type AgentServerCompositionOptions,
  type AssertNever,
} from "./agent-server.js"
import { resolveAgentServerServices, type AgentServerServicesOptions } from "./agent-server-services.js"
import {
  resolveLocalStorage,
  resolveServeStorage,
  workspaceStorageDigest,
  type LocalStorageMode,
} from "../infrastructure/persistence/storage-resolver.js"
import { JsonSessionExecutionReservation } from "../infrastructure/persistence/session-execution-reservation.js"
import { InProcessSessionExecutionReservation } from "@ag2cli/runtime/application/session/in-process-session-execution-reservation.js"
import { JsonServeWorkspaceRegistry } from "../infrastructure/persistence/serve-workspace-registry.js"
import { ServeSessionCatalog } from "../infrastructure/persistence/serve-session-catalog.js"
import { ServeSessionServer } from "./serve-session-server.js"
import { resolveWorkspaceRuntimeConfig } from "./common-runtime.js"
import { drainChildAgents, type ChildAgentRunner } from "../capabilities/execution/child-agent-runner.js"
import type { SessionCatalog } from "@ag2cli/runtime/ports/session-catalog.js"
import type { SessionServer } from "@ag2cli/session-client/session-client.js"

/** Internal lifecycle profile; durable storage and service coordination are separate concerns. */
export type AgentServerHostProfile = "local-durable" | "serve-durable" | "ephemeral"
type NormalizedAgentServerHostProfile = AgentServerHostProfile

export interface BuildAgentServerHostOptions extends AgentServerCompositionOptions {
  /** Durable hosts own resumable Session state; ephemeral hosts are one-shot. */
  readonly profile: AgentServerHostProfile
  /** Additional serve workspaces registered before accepting clients. */
  readonly workspaceRoots?: readonly string[]
  /** Override the protocol descriptor in integration tests or a packaged build. */
  readonly descriptor?: AppServerDescriptor
  /** Stable public Host identity for serve; private in-process Hosts use an ephemeral ID. */
  readonly hostId?: string
  /** Load an existing durable Session's workspace before composing its runtime. */
  readonly sessionId?: SessionId
  /** Per-runner budget for the close-time child drain before remaining children are cancelled. */
  readonly childDrainBudgetMs?: number
}

/**
 * Single source of truth for Host-only fields: they are stripped before the
 * two-phase split so the Phase-1 options type never silently carries host
 * routing it would ignore. New host fields must be classified here.
 */
export const HOST_OPTION_KEYS = [
  "profile",
  "workspaceRoots",
  "descriptor",
  "hostId",
  "sessionId",
  "childDrainBudgetMs",
] as const satisfies readonly (keyof BuildAgentServerHostOptions)[]

/** Adding an unclassified Host option field fails compilation: new fields must be classified into HOST_OPTION_KEYS. */
export type AssertHostOptionsClassified = AssertNever<
  Exclude<keyof BuildAgentServerHostOptions, keyof AgentServerCompositionOptions | (typeof HOST_OPTION_KEYS)[number]>
>

/** Host-only fields never reach the two-phase split. */
export function stripHostOnlyOptions(options: BuildAgentServerHostOptions): AgentServerCompositionOptions {
  return omitOptionFields(options, HOST_OPTION_KEYS)
}

/**
 * Serve workspace runtimes re-resolve their own services from each workspace's
 * event root. These Host option fields are deliberately forwarded; every other
 * services field is either derived by serve itself or explicitly withheld
 * below. This pair of tuples is the single source of truth for the serve
 * factory's forwarding behaviour.
 */
export const SERVE_FORWARD_OPTION_KEYS = [
  "signal",
  "additionalDirectories",
  "observability",
  "memoryRoot",
  "skillRoot",
  "compact",
  "strictCapabilities",
  "loadProjectInstructions",
] as const satisfies readonly (keyof AgentServerServicesOptions)[]

/**
 * Withheld on purpose: storage injections (workspace, snapshot/journal stores,
 * trace/telemetry sinks, child event stores) must not leak Host-level storage
 * into a workspace runtime; roots and coordination are derived or forced off
 * by serve itself.
 */
export const SERVE_WITHHELD_OPTION_KEYS = [
  "storageMode",
  "storageIdentity",
  "runtimeProfile",
  "runtimeConfig",
  "workspaceRoot",
  "eventRoot",
  "traceRoot",
  "telemetryRoot",
  "executionReservation",
  "reservationOwnerId",
  "workspace",
  "sessionAuthority",
  "snapshotStore",
  "notesStore",
  "traceSink",
  "telemetrySink",
  "childEventStoreFactory",
] as const satisfies readonly (keyof AgentServerServicesOptions)[]

/** Adding an unclassified services option field fails compilation: every field must be classified as forwarded or withheld. */
export type AssertServeOptionsClassified = AssertNever<
  Exclude<keyof AgentServerServicesOptions, (typeof SERVE_FORWARD_OPTION_KEYS)[number] | (typeof SERVE_WITHHELD_OPTION_KEYS)[number]>
>
/** The forwarded and withheld serve sets must not overlap. */
export type AssertServeOptionsDisjoint = AssertNever<
  (typeof SERVE_FORWARD_OPTION_KEYS)[number] & (typeof SERVE_WITHHELD_OPTION_KEYS)[number]
>

/** Derive the services-resolution input for one serve workspace runtime from Host options. */
export function serveWorkspaceServicesOptions(
  options: BuildAgentServerHostOptions,
  inputs: {
    readonly runtimeConfig: RuntimeConfig
    readonly runtimeProfile: "headless" | "interactive"
    readonly eventRoot: string
    readonly workspaceId: string
    readonly workspaceRoot: string
    readonly sessionAuthority?: import("@ag2cli/runtime/application/session/session-authority.js").SessionAuthority
    readonly executionReservation?: import("@ag2cli/runtime/ports/session-execution-reservation.js").SessionExecutionReservation
    readonly reservationOwnerId?: string
  },
): AgentServerServicesOptions {
  return {
    ...pickOptionFields(options, SERVE_FORWARD_OPTION_KEYS),
    // Serve clients are interactive by design: default project instruction
    // loading on unless the Host explicitly opted out.
    loadProjectInstructions: options.loadProjectInstructions ?? true,
    runtimeConfig: inputs.runtimeConfig,
    runtimeProfile: inputs.runtimeProfile,
    storageMode: "serve",
    storageIdentity: inputs.workspaceId,
    eventRoot: inputs.eventRoot,
    workspaceRoot: inputs.workspaceRoot,
    traceRoot: join(inputs.eventRoot, "traces"),
    telemetryRoot: join(inputs.eventRoot, "telemetry"),
    ...(inputs.sessionAuthority === undefined ? {} : { sessionAuthority: inputs.sessionAuthority }),
    // Presence/Lease and the operation registry coordinate interactive
    // commands; the Host's shared in-process reservation serializes writer
    // commands across every workspace runtime. Caller-injected local
    // reservations stay withheld (SERVE_WITHHELD_OPTION_KEYS).
    executionReservation: inputs.executionReservation,
    reservationOwnerId: inputs.reservationOwnerId,
  }
}

export interface AgentServerHostConnectionOptions {
  readonly grantedScopes?: readonly AppServerScope[]
  /** Host-scoped device registry used by App Server administration methods. */
  readonly deviceRegistry?: AppServerDeviceRegistry
  readonly capabilities?: AppServerCapabilities
  readonly connectionId?: string
  readonly deviceId?: string
  readonly client?: AppServerClientOptions
  /** Override the notification sink when the connection is owned by a network transport. */
  readonly onNotification?: (notification: JsonRpcNotification) => void
}

export interface AgentServerHostConnection {
  readonly rpc: AppServerRpcConnection
  readonly client: JsonRpcAppServerClient
  /** Private in-process initialization for TUI/ACP adapters; never used by network clients. */
  initializeLocal(input: Parameters<AppServerRpcConnection["initializeLocal"]>[0]): Promise<ServerInitializeResult>
  close(): void
}

export interface AgentServerHost {
  readonly profile: AgentServerHostProfile
  readonly identity: AgentServerHostIdentity
  readonly sessionServer: InProcessSessionServer
  /** Local catalog, or the serve registry-backed catalog. */
  readonly catalog: SessionCatalog
  /** Network/ACP-facing server. Local profiles use `sessionServer`; serve uses a router. */
  readonly rpcSessionServer?: SessionServer
  readonly rpcCatalog?: SessionCatalog
  readonly descriptor: AppServerDescriptor
  /** Present only for the disposable storage allocated by an ephemeral host. */
  readonly temporaryStorageRoot?: string
  createConnection(options?: AgentServerHostConnectionOptions): AgentServerHostConnection
  close(): Promise<void>
}

/**
 * Compose one authoritative Host and expose only protocol connections from it.
 * A Host is the lifecycle boundary: every Session it owns is isolated from
 * other Host instances, including another `serve` process or a one-shot run.
 */
export async function buildAgentServerHost(options: BuildAgentServerHostOptions): Promise<AgentServerHost> {
  const profile = options.profile
  const temporaryStorageRoot = profile === "ephemeral" ? await mkdtemp(join(tmpdir(), "ag2cli-ephemeral-host-")) : undefined
  let durableLease: DurableHostLease | undefined
  let server: InProcessSessionServer | undefined
  let serveSessionServer: ServeSessionServer | undefined
  try {
    const runtimeConfig = options.runtimeConfig ?? loadRuntimeConfig()
    const runtimeProfile = options.runtimeProfile ?? "interactive"
    const workspaceRoot = options.workspaceRoot ?? process.cwd()
    const localStorageMode: LocalStorageMode = runtimeProfile === "headless" ? "local-run" : "local-tui"
    const workspaceIdentity = workspaceStorageDigest(workspaceRoot)
    const durableEventRoot =
      options.eventRoot === undefined
        ? profile === "local-durable"
          ? resolveLocalStorage({
              workspaceRoot,
              configuredRoot: runtimeConfig.paths.eventRoot,
              explicitRoot: runtimeConfig.paths.eventRootExplicit === true,
              mode: localStorageMode,
            }).root
          : profile === "serve-durable"
            ? resolveServeStorage({
                serverRoot:
                  runtimeConfig.paths.eventRoot === DEFAULT_EVENT_ROOT
                    ? join(runtimeConfig.applicationHome ?? process.cwd(), "serve")
                    : runtimeConfig.paths.eventRoot,
              }).root
            : resolve(runtimeConfig.paths.eventRoot)
        : resolve(options.eventRoot)
    assertStoragePolicy({ ...options, profile })
    if (profile === "serve-durable") durableLease = await acquireDurableHostLease(durableEventRoot)
    const executionReservation = profile === "local-durable" ? new JsonSessionExecutionReservation(durableEventRoot) : undefined
    // The durable Host lease already guarantees one owning serve process, so
    // an in-process reservation gives serve the same single-writer discipline
    // local-durable gets from the file reservation: writer commands such as a
    // background shell task queue behind the active run instead of colliding
    // with the canonical one-running-loop invariant.
    const serveExecutionReservation = profile === "serve-durable" ? new InProcessSessionExecutionReservation() : undefined
    const serveReservationOwnerId = serveExecutionReservation === undefined ? undefined : `serve-host-${randomUUID()}`
    const workspaceRegistry = profile === "serve-durable" ? new JsonServeWorkspaceRegistry(durableEventRoot) : undefined
    const serveCatalog = workspaceRegistry === undefined ? undefined : new ServeSessionCatalog(durableEventRoot, workspaceRegistry)
    if (workspaceRegistry !== undefined) {
      const roots = new Set<string>([
        ...(options.workspaceRoot === undefined ? [] : [options.workspaceRoot]),
        ...(options.workspaceRoots ?? []),
      ])
      for (const root of roots) await workspaceRegistry.register(root)
    }
    // Only local composition may use a Session snapshot to recover its workspace
    // bootstrap. Serve routing is always registry/workspaceId based; reading a
    // serve snapshot here would make its descriptive workspaceRoot authoritative.
    const sessionRecord =
      profile === "local-durable" && options.sessionId !== undefined
        ? await new JsonlSessionCatalog(durableEventRoot, undefined, {
            modeScope: localStorageMode,
            scopeId: `${localStorageMode}:${workspaceIdentity}`,
            workspaceIdentity,
          }).get(options.sessionId)
        : undefined
    // A serve Session's persisted `workspaceRoot` is descriptive metadata, not
    // routing authority. Serve resolves workspace roots through its registry;
    // only the local composition may use the Session snapshot as a fallback.
    const serverWorkspaceRoot =
      profile === "serve-durable"
        ? undefined
        : (options.workspaceRoot ??
          (profile === "local-durable" ? (sessionRecord?.snapshot.workspaceRoot ?? process.cwd()) : process.cwd()))
    // Serve sessions are routed lazily through the registry. The authoritative
    // placeholder server still needs an existing WorkspacePolicy, so bind it
    // to the durable service root rather than process.cwd(). This keeps a
    // deleted launch cwd from preventing history-only serve startup and is
    // never exposed as a Session workspace identity.
    const compositionWorkspaceRoot = profile === "serve-durable" ? durableEventRoot : serverWorkspaceRoot
    const serverAdditionalDirectories =
      options.sessionId === undefined ? options.additionalDirectories : sessionRecord?.snapshot.additionalDirectories
    // Close-time drain must see every runner this host mints — the
    // authoritative runtime's and each lazily created workspace runtime's —
    // so the caller's callback is wrapped into a collector here.
    const callerOnChildRunner = options.onChildRunner
    const childRunners = new Set<ChildAgentRunner>()
    // Strip Host-only fields before splitting: the Phase-1 options type must
    // not silently carry profile/descriptor/session routing it will ignore.
    const composition = stripHostOnlyOptions({
      ...options,
      onChildRunner: (runner: ChildAgentRunner) => {
        childRunners.add(runner)
        callerOnChildRunner?.(runner)
      },
    })
    const { services: baseServicesOptions, runtime: runtimeInputs } = splitAgentServerCompositionOptions(composition)
    const services = await resolveAgentServerServices({
      ...baseServicesOptions,
      runtimeConfig,
      runtimeProfile,
      storageMode: profile === "serve-durable" ? "serve" : profile === "ephemeral" ? "ephemeral" : localStorageMode,
      eventRoot: profile === "ephemeral" ? join(temporaryStorageRoot!, "events") : durableEventRoot,
      workspaceRoot: compositionWorkspaceRoot,
      ...(profile === "ephemeral"
        ? {
            traceRoot: join(temporaryStorageRoot!, "traces"),
            telemetryRoot: join(temporaryStorageRoot!, "telemetry"),
          }
        : {}),
      // Serve coordinates interactive commands through Presence/Lease and
      // the operation registry, while the host's own in-process reservation
      // serializes writer commands. A caller-injected local file reservation
      // is still never forwarded. The ephemeral profile keeps a
      // caller-injected reservation as-is.
      ...(profile === "serve-durable"
        ? { executionReservation: serveExecutionReservation, reservationOwnerId: serveReservationOwnerId }
        : executionReservation === undefined
          ? {}
          : { executionReservation, reservationOwnerId: `pid-${process.pid}-${randomUUID()}` }),
      ...(serverAdditionalDirectories === undefined ? {} : { additionalDirectories: serverAdditionalDirectories }),
    })
    const identity = createAgentServerHostIdentity({
      profile: profile === "ephemeral" ? "ephemeral" : "durable",
      runtimeProfile,
      runtimeConfig,
      enableInteractiveShell: options.enableInteractiveShell === true,
      strictCapabilities: services.capabilities.strict,
      loadProjectInstructions: options.loadProjectInstructions === true,
      ...(profile === "serve-durable" || compositionWorkspaceRoot === undefined ? {} : { workspaceRoot: compositionWorkspaceRoot }),
      ...(serverAdditionalDirectories === undefined ? {} : { additionalDirectories: serverAdditionalDirectories }),
    })
    server = await createAgentServerFromServices({ ...runtimeInputs, services })
    const authoritativeServer = server
    const descriptor = options.descriptor ?? (await defaultDescriptor(options.hostId))
    let closed = false
    const connections = new Set<AgentServerHostConnection>()
    if (profile === "serve-durable" && workspaceRegistry !== undefined && serveCatalog !== undefined) {
      serveSessionServer = new ServeSessionServer(serveCatalog, workspaceRegistry, async (workspaceId, registeredWorkspaceRoot) => {
        const workspaceEventRoot = resolveServeStorage({ serverRoot: durableEventRoot, workspaceId }).root
        const workspaceRuntimeConfig = resolveWorkspaceRuntimeConfig(runtimeConfig, registeredWorkspaceRoot)
        const runtime = await createAgentServerFromServices({
          ...runtimeInputs,
          // Workspace services are resolved from scratch. Host-level storage
          // injections and the caller's workspace policy must not leak into a
          // workspace runtime; every store is derived from this workspace's
          // own event root. The forwarded/withheld field split lives in
          // SERVE_FORWARD_OPTION_KEYS / SERVE_WITHHELD_OPTION_KEYS.
          services: await resolveAgentServerServices(
            serveWorkspaceServicesOptions(options, {
              runtimeConfig: workspaceRuntimeConfig,
              runtimeProfile,
              eventRoot: workspaceEventRoot,
              workspaceId,
              workspaceRoot: registeredWorkspaceRoot,
              sessionAuthority: serveCatalog.authorityForWorkspace(workspaceId),
              executionReservation: serveExecutionReservation,
              reservationOwnerId: serveReservationOwnerId,
            }),
          ),
        })
        return runtime
      })
    }
    const operationRegistry = profile === "serve-durable" ? new AppServerOperationRegistry() : undefined
    const presenceRegistry = profile === "serve-durable" ? new AppServerPresenceRegistry() : undefined
    return {
      profile,
      identity,
      sessionServer: authoritativeServer,
      catalog: serveCatalog ?? authoritativeServer.catalog!,
      descriptor,
      ...(serveSessionServer === undefined ? {} : { rpcSessionServer: serveSessionServer, rpcCatalog: serveCatalog! }),
      ...(temporaryStorageRoot === undefined ? {} : { temporaryStorageRoot }),
      createConnection(connectionOptions = {}): AgentServerHostConnection {
        if (closed) throw new Error("Agent Server Host is closed")
        let transport: InProcessAppServerTransport | undefined
        // "auto" is selectable only when a Guardian policy engine is wired:
        // without one the Host cannot honor auto decisions, so advertising
        // the mode would be a lie the CAS write would then reject.
        const selectableModes: readonly PublicPermissionModeValue[] =
          runtimeInputs.guardian === undefined ? DEFAULT_SELECTABLE_MODES : [...DEFAULT_SELECTABLE_MODES, "auto"]
        const rpc = new AppServerRpcConnection({
          sessionServer: serveSessionServer ?? authoritativeServer,
          catalog: serveCatalog ?? authoritativeServer.catalog,
          descriptor,
          profile: profile === "ephemeral" ? "ephemeral" : "durable",
          workspaceIdForRoot,
          selectableModes,
          isWorkspaceUnavailableError: (error): error is WorkspaceUnavailableError => error instanceof WorkspaceUnavailableError,
          ...(profile === "serve-durable" || serverWorkspaceRoot === undefined ? {} : { workspaceRoot: serverWorkspaceRoot }),
          configurationFingerprint: identity.configurationFingerprint,
          securityFingerprint: identity.securityFingerprint,
          ...(identity.workspaceFingerprint === undefined ? {} : { workspaceFingerprint: identity.workspaceFingerprint }),
          ...(connectionOptions.grantedScopes === undefined ? {} : { grantedScopes: connectionOptions.grantedScopes }),
          ...(connectionOptions.deviceRegistry === undefined ? {} : { deviceRegistry: connectionOptions.deviceRegistry }),
          ...(connectionOptions.capabilities === undefined ? {} : { capabilities: connectionOptions.capabilities }),
          ...(connectionOptions.connectionId === undefined ? {} : { connectionId: connectionOptions.connectionId }),
          ...(connectionOptions.deviceId === undefined ? {} : { deviceId: connectionOptions.deviceId }),
          ...(operationRegistry === undefined ? {} : { operationRegistry }),
          ...(presenceRegistry === undefined ? {} : { presenceRegistry }),
          ...(workspaceRegistry === undefined ? {} : { workspaceRegistry }),
          // Structural conformance with the transport-owned
          // WorkspaceInspectionPort is asserted here at the wiring site.
          workspaceInspection: new WorkspaceInspector(),
          readTransient: (sessionId: SessionId) =>
            serveSessionServer?.readTransient(sessionId) ?? authoritativeServer.readTransient(sessionId),
          onNotification: connectionOptions.onNotification ?? ((notification) => transport?.emit(notification)),
        })
        transport = new InProcessAppServerTransport(rpc)
        const client = new JsonRpcAppServerClient(transport, connectionOptions.client)
        const connection: AgentServerHostConnection = {
          rpc,
          client,
          initializeLocal: (input) => rpc.initializeLocal(input),
          close: () => {
            if (!connections.delete(connection)) return
            client.close()
          },
        }
        connections.add(connection)
        return connection
      },
      close: async () => {
        if (closed) return
        closed = true
        // Live children still settle their durable projections through the
        // open runtimes; drain before any runtime or store close would
        // truncate that landing. Connections stay open so subscribed clients
        // receive the settle notifications as they land.
        for (const runner of childRunners) await drainChildAgents(runner, options.childDrainBudgetMs)
        for (const connection of [...connections]) connection.close()
        await serveSessionServer?.close()
        operationRegistry?.close()
        presenceRegistry?.close()
        try {
          await authoritativeServer.close()
        } finally {
          try {
            await durableLease?.close()
          } finally {
            if (temporaryStorageRoot !== undefined) {
              await rm(temporaryStorageRoot, { recursive: true, force: true })
            }
          }
        }
      },
    }
  } catch (error) {
    await server?.close().catch(() => {})
    await durableLease?.close().catch(() => {})
    if (temporaryStorageRoot !== undefined) await rm(temporaryStorageRoot, { recursive: true, force: true })
    throw error
  }
}

function assertStoragePolicy(options: BuildAgentServerHostOptions & { readonly profile: NormalizedAgentServerHostProfile }): void {
  if (options.profile !== "ephemeral") return
  const explicitStorage = [
    ["eventRoot", options.eventRoot],
    ["snapshotStore", options.snapshotStore],
    ["traceSink", options.traceSink],
    ["traceRoot", options.traceRoot],
    ["telemetrySink", options.telemetrySink],
    ["telemetryRoot", options.telemetryRoot],
    ["childEventStoreFactory", options.childEventStoreFactory],
  ].find(([, value]) => value !== undefined)
  if (explicitStorage)
    throw new Error(`ephemeral Host does not accept external ${explicitStorage[0]}; its storage must be managed by the Host`)
}

async function defaultDescriptor(hostId?: string): Promise<AppServerDescriptor> {
  const version = await readAg2cliVersion()
  return {
    name: "ag2cli",
    version,
    hostId: hostId ?? `ag2cli-host.v1.${randomBytes(32).toString("base64url")}`,
    protocolVersion: APP_SERVER_PROTOCOL_VERSION,
  }
}
