import type { PublicPermissionModeValue, PublicSessionStatus, PublicSessionSummary } from "@ag2cli/app-server-protocol/dto/snapshot.js"
import type { SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
import { publicWorkspaceFor } from "../public-session-command-mapping.js"
import type { MethodContext } from "./method-context.js"

/** Remote-selectable modes when no assembly narrows the set; `auto` stays
 * host-gated until the guardian policy face decides its availability. */
export const DEFAULT_SELECTABLE_MODES: readonly PublicPermissionModeValue[] = ["manual", "accept-edits", "plan", "full-access"]

export async function toPublicSessionSummary(context: MethodContext, record: SessionRecord): Promise<PublicSessionSummary> {
  return {
    sessionId: record.sessionId,
    ...(record.title === undefined ? {} : { title: record.title }),
    status: record.snapshot.status as PublicSessionStatus,
    workspace: await publicWorkspaceFor(context, record),
    updatedAt: record.updatedAt,
    ...(record.archivedAt === undefined ? {} : { archivedAt: record.archivedAt }),
  }
}
