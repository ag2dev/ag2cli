/**
 * TUI-facing public session: the in-process command facade plus the live
 * attachment wiring for one embedded session. Session identity stays a
 * public string on this surface — every branded-id crossing lives behind
 * the composition seam — so the TUI assembly tree consumes the public
 * contract only, exactly like a remote client would.
 */
import type { PublicSessionEvent } from "@ag2cli/app-server-protocol/dto/events.js"
import type { PublicPermissionModeValue } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { SessionSnapshotResult } from "@ag2cli/app-server-protocol/types.js"
import { WorkspaceUnavailableError, workspaceIdForRoot } from "../capabilities/security/workspace.js"
import { DEFAULT_SELECTABLE_MODES } from "../interfaces/transport/app-server-rpc.js"
import { RpcApplicationError } from "../interfaces/transport/public-session-command-mapping.js"
import type { AgentServerHost } from "./agent-host.js"
import { createPublicLiveAttachment, liveAttachmentPorts } from "./public-session-live-attachment.js"
import { PublicSessionCommands } from "./public-session-commands.js"
import type { TuiSessionDriverLiveCallbacks } from "./tui-session-driver.js"

export interface TuiPublicSession {
  readonly sessionId: string
  /** The in-process public command face; methods take this session's id. */
  readonly facade: PublicSessionCommands
  /** Modes this process may commit: the fixed set, plus auto behind a Guardian. */
  readonly selectableModes: readonly PublicPermissionModeValue[]
  /** Land a fresh id in the catalog; an existing record is left untouched. */
  ensureSession(): Promise<void>
  /** Live public projection attachment for the session driver. */
  attachPublicProjection(callbacks: TuiSessionDriverLiveCallbacks): { stop(): void }
  /** Full public event history of the active lineage. */
  readPublicEvents(): Promise<readonly PublicSessionEvent[]>
  publicSnapshot(): Promise<SessionSnapshotResult>
}

export interface TuiPublicSessionOptions {
  /** The process-embedded host; one per TUI process. */
  readonly host: AgentServerHost
  readonly sessionId: string
  /** This process's workspace root; the facade derives its workspace identity from it. */
  readonly workspaceRoot: string
  /** Auto joins the selectable set only when a Guardian reviewer is wired. */
  readonly guardianAvailable: boolean
}

export function openTuiPublicSession(options: TuiPublicSessionOptions): TuiPublicSession {
  // The fixed selectable set, plus auto when a Guardian reviewer
  // answers it — the same words the facade serves.
  const selectableModes: readonly PublicPermissionModeValue[] = options.guardianAvailable
    ? [...DEFAULT_SELECTABLE_MODES, "auto"]
    : DEFAULT_SELECTABLE_MODES
  const facade = new PublicSessionCommands({
    sessionServer: options.host.sessionServer,
    catalog: options.host.catalog,
    workspaceIdForRoot,
    isWorkspaceUnavailableError: (error): error is WorkspaceUnavailableError => error instanceof WorkspaceUnavailableError,
    selectableModes,
    workspaceRoot: options.workspaceRoot,
  })
  return {
    sessionId: options.sessionId,
    facade,
    selectableModes,
    async ensureSession() {
      try {
        await facade.snapshot({ sessionId: options.sessionId })
      } catch (error) {
        if (error instanceof RpcApplicationError && error.kind === "session_not_found") {
          await facade.createSession({ sessionId: options.sessionId, workspaceId: workspaceIdForRoot(options.workspaceRoot) })
          return
        }
        throw error
      }
    },
    attachPublicProjection(callbacks) {
      return createPublicLiveAttachment(liveAttachmentPorts(options.host.sessionServer, options.sessionId), callbacks)
    },
    readPublicEvents: () => facade.readPublicEvents({ sessionId: options.sessionId }),
    publicSnapshot: () => facade.snapshot({ sessionId: options.sessionId }),
  }
}
