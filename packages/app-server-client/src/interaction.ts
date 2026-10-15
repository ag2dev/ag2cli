import {
  type AppServerClientInfo,
  type AppServerInteractionHolder,
  type AppServerInteractionLease,
  type AppServerInteractionLeases,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"
import { asRecord, parseNonEmptyString, parseNonNegativeInteger } from "@ag2cli/app-server-protocol/validation.js"
import type { AppServerRpcClient } from "./client.js"

export type AppServerInteractionMethod = "interaction.acquire" | "interaction.renew" | "interaction.release" | "interaction.takeover"

export interface AppServerInteractionRequestOptions {
  readonly leaseGeneration?: number
  readonly ttlMs?: number
  readonly signal?: AbortSignal
}

/**
 * Request and validate one scope's short-lived interaction lease from any App
 * Server client. `scope` must always be provided: there is no implicit
 * default scope on the wire (see `InteractionParams` in
 * `@ag2cli/app-server-protocol`), and no implicit/auto-acquire fallback for
 * a lone client either.
 */
export async function requestInteractionLease(
  rpc: AppServerRpcClient,
  method: AppServerInteractionMethod,
  sessionId: string,
  scope: InteractionLeaseScope,
  options: AppServerInteractionRequestOptions = {},
): Promise<AppServerInteractionLease> {
  const result = asRecord(
    await rpc.request(
      method,
      {
        sessionId,
        scope,
        ...(options.leaseGeneration === undefined ? {} : { leaseGeneration: options.leaseGeneration }),
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      },
      options.signal === undefined ? {} : { signal: options.signal },
    ),
    `${method}.result`,
  )
  return parseInteractionLease(result.lease)
}

/** Validate an interaction lease received from a result or notification. */
export function parseInteractionLease(value: unknown): AppServerInteractionLease {
  const record = asRecord(value, "interaction.lease")
  const status = record.status
  if (status !== "available" && status !== "held") throw new Error("interaction.lease.status is invalid")
  const holder = record.holder === undefined ? undefined : parseInteractionHolder(record.holder)
  if (status === "held" && holder === undefined) throw new Error("interaction.lease.holder is required")
  const expiresAt = record.expiresAt === undefined ? undefined : parseNonEmptyString(record.expiresAt, "interaction.lease.expiresAt")
  return {
    status,
    generation: parseNonNegativeInteger(record.generation, "interaction.lease.generation"),
    ...(holder === undefined ? {} : { holder }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** Validate both scopes' lease state, e.g. from `session.attach`'s `presence.leases` or `interaction.lease.updated`. */
export function parseInteractionLeases(value: unknown): AppServerInteractionLeases {
  const record = asRecord(value, "interaction.leases")
  return {
    composer: parseInteractionLease(record.composer),
    "session-control": parseInteractionLease(record["session-control"]),
  }
}

function parseInteractionHolder(value: unknown): AppServerInteractionHolder {
  const record = asRecord(value, "interaction.lease.holder")
  return {
    connectionId: parseNonEmptyString(record.connectionId, "interaction.lease.holder.connectionId"),
    deviceId: parseNonEmptyString(record.deviceId, "interaction.lease.holder.deviceId"),
    clientId: parseNonEmptyString(record.clientId, "interaction.lease.holder.clientId"),
    clientKind: parseClientKind(record.clientKind, "interaction.lease.holder.clientKind"),
    name: parseNonEmptyString(record.name, "interaction.lease.holder.name"),
  }
}

function parseClientKind(value: unknown, name: string): AppServerClientInfo["clientKind"] {
  if (
    value === "tui" ||
    value === "web" ||
    value === "mobile" ||
    value === "desktop" ||
    value === "acp" ||
    value === "script" ||
    value === "unknown"
  ) {
    return value
  }
  throw new Error(`${name} is invalid`)
}
