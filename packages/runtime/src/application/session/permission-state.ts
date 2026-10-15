import type { AgentEvent } from "@ag2cli/core/events/event.js"
import type { SessionPermissionMode, SessionPermissionRule } from "@ag2cli/core/session/session-security.js"
import {
  DEFAULT_SESSION_PERMISSION_MODE,
  assertSessionPermissionRuleNameBound,
  normalizeSessionPermissionRules,
} from "@ag2cli/core/session/session-security.js"
import { replaySession } from "@ag2cli/core/session/session-snapshot.js"
import type { SessionId } from "@ag2cli/core/ids.js"
import type { EventStore } from "../../ports/event-store.js"
import type { PolicySerialPoint } from "../../ports/policy-serial-point.js"
import { commandIdempotencyConflictError, resolveCommandIdempotency, type CommandIdempotencyFamily } from "./command-idempotency.js"
import { appendSessionEventsIfRevision, SessionRevisionConflictError } from "./revision-conflict.js"
import type { SessionAuthority } from "./session-authority.js"

interface PermissionFingerprint {
  readonly mode: SessionPermissionMode | undefined
  readonly rules: readonly SessionPermissionRule[] | undefined
}

/** Attempts for one permission switch before a revision conflict surfaces. */
const CAS_RETRY_LIMIT = 3

/**
 * A retried `permission` command may append zero, one, or two events
 * (`SessionPermissionModeSet` / `SessionPermissionRulesSet`, only for the
 * parts that actually changed), so the anchor scan looks for both event
 * types sharing this commandId's traceId and reconstructs the combined
 * `{mode, rules}` fingerprint from whichever of the two actually fired.
 */
export const PERMISSION_FAMILY: CommandIdempotencyFamily<PermissionFingerprint> = {
  family: "permission",
  findAnchor: (events, commandId) => {
    const traceId = `permission:${commandId}`
    const matches = events.filter(
      (event): event is Extract<AgentEvent, { type: "SessionPermissionModeSet" | "SessionPermissionRulesSet" }> =>
        (event.type === "SessionPermissionModeSet" || event.type === "SessionPermissionRulesSet") && event.trace.traceId === traceId,
    )
    if (matches.length === 0) return undefined
    const modeEvent = matches.find(
      (event): event is Extract<AgentEvent, { type: "SessionPermissionModeSet" }> => event.type === "SessionPermissionModeSet",
    )
    const rulesEvent = matches.find(
      (event): event is Extract<AgentEvent, { type: "SessionPermissionRulesSet" }> => event.type === "SessionPermissionRulesSet",
    )
    return {
      event: matches[0]!,
      inputFingerprint: {
        mode: modeEvent?.payload.mode,
        rules: rulesEvent?.payload.rules,
      },
    }
  },
}

export interface UpdatePermissionInput {
  readonly sessionId: SessionId
  readonly commandId: string
  readonly mode?: SessionPermissionMode
  readonly rules?: readonly SessionPermissionRule[]
  readonly expectedPolicyRevision?: number
}

/**
 * A permission update lost the concurrent policy-revision race (the caller
 * baked a stale expectedPolicyRevision). Typed so the App Server boundary
 * surfaces it as a stable protocol error instead of an internal one.
 */
export class SessionPolicyRevisionConflictError extends Error {
  readonly code = "policy_revision_conflict"

  constructor(
    readonly sessionId: SessionId,
    readonly expectedPolicyRevision: number,
    readonly actualPolicyRevision: number,
  ) {
    super(`stale_policy: expected ${expectedPolicyRevision}, actual ${actualPolicyRevision}`)
    this.name = "SessionPolicyRevisionConflictError"
  }
}

export class UpdateSessionPermissionUseCase {
  constructor(
    private readonly deps: {
      readonly eventStore: EventStore
      readonly authority?: SessionAuthority
      readonly identity: { nextEventId(): string; now(): string }
      /** Serializes the read-judge-append window against tool dispatch on one session. */
      readonly serialPoint: PolicySerialPoint
      readonly onEventsAppended?: (events: readonly AgentEvent[]) => Promise<void> | void
    },
  ) {}

  async execute(input: UpdatePermissionInput): Promise<{ readonly changed: boolean }> {
    // Ingest-bound: every `set_permission_rules` writer funnels through this
    // use case, so a NEW rule name over the bound is rejected before any
    // fingerprint or event exists. Replay/read paths never execute this.
    if (input.rules !== undefined) for (const rule of input.rules) assertSessionPermissionRuleNameBound(rule.name)
    return this.deps.serialPoint.critical(input.sessionId, `permission:${input.commandId}`, "permission-commit", async () => {
      // Tool-result appends run outside any serial section, so the CAS below
      // can lose a race against them; re-read and re-judge instead of failing
      // the permission switch on a concurrent tool commit.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.commit(input)
        } catch (error) {
          if (!(error instanceof SessionRevisionConflictError) || attempt >= CAS_RETRY_LIMIT) throw error
        }
      }
    })
  }

  private async commit(input: UpdatePermissionInput): Promise<{ readonly changed: boolean }> {
    const events = await this.deps.eventStore.read(input.sessionId)
    const idempotency = resolveCommandIdempotency(PERMISSION_FAMILY, events, {
      family: PERMISSION_FAMILY.family,
      commandId: input.commandId,
      inputFingerprint: {
        mode: input.mode,
        rules: input.rules === undefined ? undefined : normalizeSessionPermissionRules(input.rules),
      },
    })
    if (idempotency.status === "conflict") throw commandIdempotencyConflictError(idempotency.record)
    if (idempotency.status === "replay") return { changed: true }
    const snapshot = events.length === 0 ? undefined : replaySession(events)
    const currentRevision = snapshot?.policyRevision ?? 0
    if (input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== currentRevision) {
      throw new SessionPolicyRevisionConflictError(input.sessionId, input.expectedPolicyRevision, currentRevision)
    }
    if (input.mode === undefined && input.rules === undefined) throw new Error("permission update requires mode or rules")
    const nextMode = input.mode ?? snapshot?.permissionMode ?? DEFAULT_SESSION_PERMISSION_MODE
    const nextRules = normalizeSessionPermissionRules(input.rules ?? snapshot?.permissionRules ?? [])
    const modeChanged = nextMode !== (snapshot?.permissionMode ?? DEFAULT_SESSION_PERMISSION_MODE)
    const rulesChanged = JSON.stringify(nextRules) !== JSON.stringify(snapshot?.permissionRules ?? [])
    if (!modeChanged && !rulesChanged) return { changed: false }
    const workspaceRoot = snapshot?.workspaceRoot
    if (!workspaceRoot) throw new Error("permission update requires a created session")
    let revision = events.length + 1
    let causationId = events.at(-1)?.eventId
    const traceId = `permission:${input.commandId}`
    const make = <TType extends AgentEvent["type"]>(
      type: TType,
      payload: Extract<AgentEvent, { type: TType }>["payload"],
    ): Extract<AgentEvent, { type: TType }> => {
      const eventId = this.deps.identity.nextEventId()
      const event = {
        eventId,
        sessionId: input.sessionId,
        revision: revision++,
        type,
        timestamp: this.deps.identity.now(),
        trace: {
          traceId,
          operationId: traceId,
          ...(causationId ? { causationId } : {}),
        },
        payload,
      } as Extract<AgentEvent, { type: TType }>
      causationId = eventId
      return event
    }
    let policyRevision = currentRevision
    const appended: AgentEvent[] = []
    if (modeChanged)
      appended.push(
        make("SessionPermissionModeSet", {
          mode: nextMode,
          policyRevision: ++policyRevision,
        }),
      )
    if (rulesChanged)
      appended.push(
        make("SessionPermissionRulesSet", {
          rules: nextRules,
          policyRevision: ++policyRevision,
        }),
      )
    await appendSessionEventsIfRevision({
      eventStore: this.deps.eventStore,
      authority: this.deps.authority,
      sessionId: input.sessionId,
      expectedRevision: events.length,
      events: appended,
      onEventsAppended: this.deps.onEventsAppended,
    })
    return { changed: true }
  }
}
