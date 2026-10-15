import {
  APP_SERVER_INTERACTION_LEASE_SCOPES,
  type AppServerClientInfo,
  type AppServerInteractionHolder,
  type AppServerInteractionLease,
  type AppServerInteractionLeases,
  type InteractionLeaseScope,
} from "@ag2cli/app-server-protocol/types.js"

const DEFAULT_LEASE_TTL_MS = 30_000
const MIN_LEASE_TTL_MS = 1_000
const MAX_LEASE_TTL_MS = 5 * 60_000

export interface LeaseOwner {
  readonly connectionId: string
  readonly deviceId: string
  readonly client: AppServerClientInfo
}

export interface AppServerWriteAccess {
  readonly scope: InteractionLeaseScope
  readonly lease: AppServerInteractionLease
}

export interface LeaseRegistry {
  lease(sessionId: string, scope: InteractionLeaseScope): AppServerInteractionLease
  leases(sessionId: string): AppServerInteractionLeases
  acquire(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, ttlMs?: number): AppServerInteractionLease
  renew(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, generation: number, ttlMs?: number): AppServerInteractionLease
  release(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, generation: number): AppServerInteractionLease
  takeover(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, ttlMs?: number): AppServerInteractionLease
  assertWriteAccess(
    sessionId: string,
    scope: InteractionLeaseScope,
    owner: LeaseOwner,
    generation: number | undefined,
  ): AppServerWriteAccess
  releaseIfHeld(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, generation: number): void
  releaseOwner(sessionId: string, connectionId: string): boolean
  clear(): void
}

interface LeaseState {
  generation: number
  holder?: LeaseOwner
  expiresAt?: number
}

type ScopedLeaseState = Record<InteractionLeaseScope, LeaseState>

export interface LeaseRegistryOptions {
  readonly now?: () => number
  readonly onChange?: (sessionId: string) => void
}

export class InMemoryLeaseRegistry implements LeaseRegistry {
  private readonly states = new Map<string, ScopedLeaseState>()
  private readonly now: () => number
  private readonly onChange: (sessionId: string) => void

  constructor(options: LeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.onChange = options.onChange ?? (() => {})
  }

  lease(sessionId: string, scope: InteractionLeaseScope): AppServerInteractionLease {
    this.expire(sessionId, scope, true)
    return this.toLease(this.state(sessionId, scope))
  }

  leases(sessionId: string): AppServerInteractionLeases {
    return Object.fromEntries(
      APP_SERVER_INTERACTION_LEASE_SCOPES.map((scope) => [scope, this.lease(sessionId, scope)]),
    ) as AppServerInteractionLeases
  }

  acquire(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, ttlMs?: number): AppServerInteractionLease {
    const state = this.state(sessionId, scope)
    this.expire(sessionId, scope, false)
    if (state.holder !== undefined && state.holder.connectionId !== owner.connectionId) {
      throw new AppServerInteractionError("interaction_lease_held", "Session is currently controlled by another client", {
        scope,
        holder: this.toHolder(state.holder),
        lease: this.toLease(state),
      })
    }
    if (state.holder === undefined) {
      state.generation++
      state.holder = owner
    }
    state.expiresAt = this.now() + normalizeTtl(ttlMs)
    this.onChange(sessionId)
    return this.toLease(state)
  }

  renew(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, generation: number, ttlMs?: number): AppServerInteractionLease {
    const state = this.state(sessionId, scope)
    this.expire(sessionId, scope, false)
    this.requireHolder(scope, state, owner, generation)
    state.expiresAt = this.now() + normalizeTtl(ttlMs)
    this.onChange(sessionId)
    return this.toLease(state)
  }

  release(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, generation: number): AppServerInteractionLease {
    const state = this.state(sessionId, scope)
    this.expire(sessionId, scope, false)
    this.requireHolder(scope, state, owner, generation)
    this.clearHolder(state)
    this.onChange(sessionId)
    return this.toLease(state)
  }

  takeover(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, ttlMs?: number): AppServerInteractionLease {
    const state = this.state(sessionId, scope)
    this.expire(sessionId, scope, false)
    state.generation++
    state.holder = owner
    state.expiresAt = this.now() + normalizeTtl(ttlMs)
    this.onChange(sessionId)
    return this.toLease(state)
  }

  assertWriteAccess(
    sessionId: string,
    scope: InteractionLeaseScope,
    owner: LeaseOwner,
    generation: number | undefined,
  ): AppServerWriteAccess {
    const state = this.state(sessionId, scope)
    this.expire(sessionId, scope, false)
    if (state.holder === undefined) {
      throw new AppServerInteractionError(
        "interaction_lease_required",
        `A write operation requires holding the ${scope} interaction lease first`,
        {
          scope,
          lease: this.toLease(state),
        },
      )
    }
    if (state.holder.connectionId !== owner.connectionId) {
      throw new AppServerInteractionError("interaction_lease_held", "Session is currently controlled by another client", {
        scope,
        holder: this.toHolder(state.holder),
        lease: this.toLease(state),
      })
    }
    if (generation === undefined) {
      throw new AppServerInteractionError(
        "interaction_lease_required",
        `A write operation must provide the ${scope} interaction lease generation`,
        {
          scope,
          lease: this.toLease(state),
        },
      )
    }
    if (generation !== state.generation) {
      throw new AppServerInteractionError("interaction_lease_stale", "Session interaction lease has expired or been taken over", {
        scope,
        lease: this.toLease(state),
      })
    }
    state.expiresAt = this.now() + DEFAULT_LEASE_TTL_MS
    return { scope, lease: this.toLease(state) }
  }

  releaseIfHeld(sessionId: string, scope: InteractionLeaseScope, owner: LeaseOwner, generation: number): void {
    const state = this.states.get(sessionId)?.[scope]
    if (state?.holder?.connectionId !== owner.connectionId || state.generation !== generation) return
    this.clearHolder(state)
    this.onChange(sessionId)
  }

  releaseOwner(sessionId: string, connectionId: string): boolean {
    const scoped = this.states.get(sessionId)
    if (scoped === undefined) return false
    let changed = false
    for (const scope of APP_SERVER_INTERACTION_LEASE_SCOPES) {
      const state = scoped[scope]
      if (state.holder?.connectionId !== connectionId) continue
      this.clearHolder(state)
      changed = true
    }
    if (changed) this.onChange(sessionId)
    return changed
  }

  clear(): void {
    this.states.clear()
  }

  private expire(sessionId: string, scope: InteractionLeaseScope, notify: boolean): void {
    const state = this.states.get(sessionId)?.[scope]
    if (state?.holder === undefined || state.expiresAt === undefined || state.expiresAt > this.now()) return
    this.clearHolder(state)
    if (notify) this.onChange(sessionId)
  }

  private state(sessionId: string, scope: InteractionLeaseScope): LeaseState {
    let scoped = this.states.get(sessionId)
    if (scoped === undefined) {
      scoped = { composer: { generation: 0 }, "session-control": { generation: 0 } }
      this.states.set(sessionId, scoped)
    }
    return scoped[scope]
  }

  private requireHolder(scope: InteractionLeaseScope, state: LeaseState, owner: LeaseOwner, generation: number): void {
    if (state.holder?.connectionId !== owner.connectionId || state.generation !== generation) {
      throw new AppServerInteractionError("interaction_lease_stale", "Session interaction lease has expired or been taken over", {
        scope,
        lease: this.toLease(state),
      })
    }
  }

  private clearHolder(state: LeaseState): void {
    state.generation++
    state.holder = undefined
    state.expiresAt = undefined
  }

  private toHolder(owner: LeaseOwner): AppServerInteractionHolder {
    return {
      connectionId: owner.connectionId,
      deviceId: owner.deviceId,
      clientId: owner.client.clientId,
      clientKind: owner.client.clientKind,
      name: owner.client.name,
    }
  }

  private toLease(state: LeaseState | undefined): AppServerInteractionLease {
    if (state?.holder === undefined) return { status: "available", generation: state?.generation ?? 0 }
    return {
      status: "held",
      generation: state.generation,
      holder: this.toHolder(state.holder),
      expiresAt: new Date(state.expiresAt ?? this.now()).toISOString(),
    }
  }
}

export class AppServerInteractionError extends Error {
  constructor(
    readonly kind:
      | "connection_not_registered"
      | "interaction_lease_held"
      | "interaction_lease_stale"
      | "interaction_lease_required"
      | "invalid_lease_ttl",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppServerInteractionError"
  }
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < MIN_LEASE_TTL_MS || ttl > MAX_LEASE_TTL_MS) {
    throw new AppServerInteractionError(
      "invalid_lease_ttl",
      `lease ttl must be between ${MIN_LEASE_TTL_MS} and ${MAX_LEASE_TTL_MS} milliseconds`,
    )
  }
  return ttl
}
