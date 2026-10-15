import { AppServerRpcError, type AppServerRpcClient } from "@ag2cli/app-server-client/client.js"
import { type SessionControlLeaseRef } from "@ag2cli/app-server-protocol/types.js"
import { asRecord, assertJsonValue, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { HistoryCursor } from "@ag2cli/core/events/event.js"
import { parseSessionRecord } from "@ag2cli/protocol/session-codec.js"
import type { SessionCatalog, SessionCatalogOptions, SessionCreateOptions, SessionRecord } from "@ag2cli/runtime/ports/session-catalog.js"
import type { InteractionLeaseBinding } from "../tui-interaction-lease.js"

export interface AppServerSessionCatalogOptions {
  readonly interactionLease?: InteractionLeaseBinding
  /**
   * Injected workspace identity derivation for `session.create` params:
   * the implementation owner is capabilities/security/workspace +
   * composition; transport must not import it. Required so a client
   * assembly states it explicitly.
   */
  readonly workspaceIdForRoot: (workspaceRoot: string) => string
}

/**
 * Session catalog backed only by the public App Server catalog methods.
 *
 * `fork`/`archive`/`delete` reorder or change a Session's own existence and
 * therefore require the `session-control` interaction lease on the server.
 * This is kept an internal transport concern: the generic `SessionCatalog`
 * port callers (e.g. `tui.ts`) stay lease-agnostic, exactly as they were
 * before the server started enforcing this scope.
 */
export class AppServerSessionCatalog implements SessionCatalog {
  constructor(
    private readonly rpc: AppServerRpcClient,
    private readonly options: AppServerSessionCatalogOptions,
  ) {}

  async list(options?: SessionCatalogOptions): Promise<readonly SessionRecord[]> {
    const value = await this.request("session.list", { includeArchived: true }, options)
    if (!Array.isArray(value)) throw new Error("session.list.result must be an array")
    return value.map(parseSessionRecord)
  }

  async get(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord | undefined> {
    try {
      return parseSessionRecord(await this.request("session.get", { sessionId: id, includeArchived: true }, options))
    } catch (error) {
      if (error instanceof AppServerRpcError && error.kind === "session_not_found") return undefined
      throw error
    }
  }

  async create(id: SessionId, workspace: string, options?: SessionCreateOptions): Promise<SessionRecord> {
    return parseSessionRecord(
      await this.request(
        "session.create",
        {
          sessionId: id,
          workspaceId: options?.workspaceId ?? this.options.workspaceIdForRoot(workspace),
          ...(options?.title === undefined ? {} : { title: options.title }),
        },
        options,
      ),
    )
  }

  async fork(source: SessionId, target: SessionId, title?: string, options?: SessionCatalogOptions): Promise<SessionRecord> {
    return this.withSessionControlLease(source, options, async (lease) =>
      parseSessionRecord(
        await this.request(
          "session.fork",
          {
            sourceSessionId: source,
            targetSessionId: target,
            ...(title === undefined ? {} : { title }),
            ...(lease === undefined ? {} : { lease }),
          },
          options,
        ),
      ),
    )
  }

  async forkAtCursor(
    source: SessionId,
    target: SessionId,
    cursor: HistoryCursor,
    title?: string,
    options?: SessionCatalogOptions,
  ): Promise<SessionRecord> {
    return this.withSessionControlLease(source, options, async (lease) =>
      parseSessionRecord(
        await this.request(
          "session.fork",
          {
            sourceSessionId: source,
            targetSessionId: target,
            cursor,
            ...(title === undefined ? {} : { title }),
            ...(lease === undefined ? {} : { lease }),
          },
          options,
        ),
      ),
    )
  }

  async archive(id: SessionId, options?: SessionCatalogOptions): Promise<SessionRecord> {
    return this.withSessionControlLease(id, options, async (lease) =>
      parseSessionRecord(await this.request("session.archive", { sessionId: id, ...(lease === undefined ? {} : { lease }) }, options)),
    )
  }

  async delete(id: SessionId, options?: SessionCatalogOptions): Promise<void> {
    await this.withSessionControlLease(id, options, async (lease) => {
      const result = asRecord(
        await this.request("session.delete", { sessionId: id, ...(lease === undefined ? {} : { lease }) }, options),
        "session.delete.result",
      )
      if (parseNonEmptyString(result.sessionId, "session.delete.result.sessionId") !== id.toString() || result.deleted !== true) {
        throw new Error("session.delete.result is invalid")
      }
    })
  }

  /**
   * Acquire the `session-control` lease for `id`, run `fn`, then best-effort
   * release it: the server also auto-releases the lease immediately after
   * the protected write completes (same model as `session.command`), so a
   * failed/late release here is expected, not an error. A Host that does not
   * support interaction leases at all (`interaction_unavailable`) is treated
   * as before this change: the write proceeds without a `lease` param.
   */
  private async withSessionControlLease<T>(
    id: SessionId,
    options: SessionCatalogOptions | undefined,
    fn: (lease: SessionControlLeaseRef | undefined) => Promise<T> | T,
  ): Promise<T> {
    const interactionLease = this.options.interactionLease
    if (interactionLease !== undefined) {
      try {
        return await interactionLease.controller.withLease(
          id.toString(),
          "session-control",
          interactionLease.connection(),
          { signal: options?.signal },
          (generation) => fn({ scope: "session-control", generation }),
        )
      } catch (error) {
        if (isInteractionUnavailable(error)) return fn(undefined)
        throw error
      }
    }
    const lease = await this.acquireSessionControlLease(id, options)
    try {
      return await fn(lease)
    } finally {
      if (lease !== undefined) {
        await this.request(
          "interaction.release",
          { sessionId: id, scope: "session-control", leaseGeneration: lease.generation },
          options,
        ).catch(() => undefined)
      }
    }
  }

  private async acquireSessionControlLease(id: SessionId, options?: SessionCatalogOptions): Promise<SessionControlLeaseRef | undefined> {
    try {
      const acquired = asRecord(
        await this.request("interaction.acquire", { sessionId: id, scope: "session-control" }, options),
        "interaction.acquire.result",
      )
      const lease = asRecord(acquired.lease, "interaction.acquire.result.lease")
      return {
        scope: "session-control",
        generation: parseNonNegativeInteger(lease.generation, "interaction.acquire.result.lease.generation"),
      }
    } catch (error) {
      if (error instanceof AppServerRpcError && error.kind === "interaction_unavailable") return undefined
      throw error
    }
  }

  private request(method: string, params: Record<string, unknown>, options?: SessionCatalogOptions): Promise<unknown> {
    return this.rpc.request(method, assertJsonValue(JSON.parse(JSON.stringify(params)), `${method}.params`), {
      signal: options?.signal,
    })
  }
}

function isInteractionUnavailable(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.kind === "interaction_unavailable"
}
