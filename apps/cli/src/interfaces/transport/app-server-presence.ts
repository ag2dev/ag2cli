import {
  type AppServerClientInfo,
  type AppServerInteractionLease,
  type AppServerInteractionLeases,
  type AppServerPresenceClient,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"
import {
  AppServerInteractionError,
  InMemoryLeaseRegistry,
  type AppServerWriteAccess,
  type LeaseOwner,
  type LeaseRegistry,
} from "./lease-registry.js"

export { AppServerInteractionError, type AppServerWriteAccess }

interface ConnectionPresence extends LeaseOwner {
  readonly sessions: Set<string>
  readonly notify: (method: string, params: Record<string, unknown>) => void
}

export interface AppServerPresenceRegistration {
  readonly connectionId: string
  readonly deviceId: string
  readonly client: AppServerClientInfo
  readonly sessions: ReadonlySet<string>
  attach(sessionId: string): { readonly presence: AppServerPresenceClient[]; readonly leases: AppServerInteractionLeases }
  detach(sessionId: string): void
}

/**
 * Host-wide presence and the two independent short-lived interaction leases
 * per Session. Lease state is delegated to a registry; this facade owns
 * connection membership and notifications.
 */
export class AppServerPresenceRegistry {
  private readonly connections = new Map<string, ConnectionPresence>()
  private readonly leaseRegistry: LeaseRegistry

  constructor(options: { readonly now?: () => number } = {}) {
    this.leaseRegistry = new InMemoryLeaseRegistry({
      now: options.now,
      onChange: (sessionId) => this.publish(sessionId),
    })
  }

  register(input: {
    readonly connectionId: string
    readonly deviceId: string
    readonly client: AppServerClientInfo
    readonly notify: (method: string, params: Record<string, unknown>) => void
  }): AppServerPresenceRegistration {
    if (this.connections.has(input.connectionId)) throw new Error(`Connection is already registered: ${input.connectionId}`)
    const connection: ConnectionPresence = { ...input, sessions: new Set() }
    this.connections.set(connection.connectionId, connection)
    return {
      connectionId: connection.connectionId,
      deviceId: connection.deviceId,
      client: connection.client,
      sessions: connection.sessions,
      attach: (sessionId) => this.attach(connection, sessionId),
      detach: (sessionId) => this.detach(connection, sessionId),
    }
  }

  unregister(connectionId: string): void {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    const sessions = [...connection.sessions]
    this.connections.delete(connectionId)
    for (const sessionId of sessions) this.detach(connection, sessionId)
  }

  presence(sessionId: string): readonly AppServerPresenceClient[] {
    return [...this.connections.values()]
      .filter((connection) => connection.sessions.has(sessionId))
      .map((connection) => this.toClient(connection))
  }

  /** Current lease state for one scope. */
  lease(sessionId: string, scope: InteractionLeaseScope): AppServerInteractionLease {
    return this.leaseRegistry.lease(sessionId, scope)
  }

  /** Current lease state for both scopes, e.g. for `session.attach` and broadcast notifications. */
  leases(sessionId: string): AppServerInteractionLeases {
    return this.leaseRegistry.leases(sessionId)
  }

  acquire(sessionId: string, scope: InteractionLeaseScope, connectionId: string, ttlMs?: number): AppServerInteractionLease {
    const connection = this.requireConnection(connectionId)
    return this.leaseRegistry.acquire(sessionId, scope, connection, ttlMs)
  }

  renew(
    sessionId: string,
    scope: InteractionLeaseScope,
    connectionId: string,
    generation: number,
    ttlMs?: number,
  ): AppServerInteractionLease {
    const connection = this.requireConnection(connectionId)
    return this.leaseRegistry.renew(sessionId, scope, connection, generation, ttlMs)
  }

  release(sessionId: string, scope: InteractionLeaseScope, connectionId: string, generation: number): AppServerInteractionLease {
    const connection = this.requireConnection(connectionId)
    return this.leaseRegistry.release(sessionId, scope, connection, generation)
  }

  takeover(sessionId: string, scope: InteractionLeaseScope, connectionId: string, ttlMs?: number): AppServerInteractionLease {
    const connection = this.requireConnection(connectionId)
    return this.leaseRegistry.takeover(sessionId, scope, connection, ttlMs)
  }

  assertWriteAccess(
    sessionId: string,
    scope: InteractionLeaseScope,
    connectionId: string,
    generation: number | undefined,
  ): AppServerWriteAccess {
    const connection = this.requireConnection(connectionId)
    return this.leaseRegistry.assertWriteAccess(sessionId, scope, connection, generation)
  }

  /** Release a write lease after the protected operation has completed or been accepted. */
  releaseIfHeld(sessionId: string, scope: InteractionLeaseScope, connectionId: string, generation: number): void {
    const connection = this.connections.get(connectionId)
    if (connection === undefined) return
    this.leaseRegistry.releaseIfHeld(sessionId, scope, connection, generation)
  }

  close(): void {
    this.connections.clear()
    this.leaseRegistry.clear()
  }

  private attach(
    connection: ConnectionPresence,
    sessionId: string,
  ): { readonly presence: AppServerPresenceClient[]; readonly leases: AppServerInteractionLeases } {
    connection.sessions.add(sessionId)
    this.publish(sessionId)
    return { presence: [...this.presence(sessionId)], leases: this.leases(sessionId) }
  }

  private detach(connection: ConnectionPresence, sessionId: string): void {
    if (!connection.sessions.delete(sessionId)) return
    if (!this.leaseRegistry.releaseOwner(sessionId, connection.connectionId)) this.publish(sessionId)
  }

  private publish(sessionId: string): void {
    const presenceParams = { sessionId, clients: [...this.presence(sessionId)] }
    const leaseParams = { sessionId, leases: this.leases(sessionId) }
    for (const connection of this.connections.values()) {
      if (!connection.sessions.has(sessionId)) continue
      connection.notify("presence.updated", presenceParams)
      connection.notify("interaction.lease.updated", leaseParams)
    }
  }

  private requireConnection(connectionId: string): ConnectionPresence {
    const connection = this.connections.get(connectionId)
    if (connection === undefined)
      throw new AppServerInteractionError("connection_not_registered", "App Server connection is not initialized")
    return connection
  }

  private toClient(connection: ConnectionPresence): AppServerPresenceClient {
    return {
      connectionId: connection.connectionId,
      deviceId: connection.deviceId,
      clientId: connection.client.clientId,
      clientKind: connection.client.clientKind,
      name: connection.client.name,
      version: connection.client.version,
    }
  }
}
