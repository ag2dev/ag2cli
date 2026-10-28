package com.ag2dev.ag2cli.mobile.core.session

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerResyncRequiredNotification
import com.ag2dev.ag2cli.mobile.core.protocol.RecoveryCursor
import com.ag2dev.ag2cli.mobile.core.protocol.requiredLong
import com.ag2dev.ag2cli.mobile.core.protocol.requiredString
import kotlinx.collections.immutable.PersistentList
import kotlinx.collections.immutable.persistentListOf
import kotlinx.collections.immutable.plus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Public event types this projection understands; unknown types pass through as-is. */
internal val CRITICAL_EVENT_TYPES = setOf(
    "input.accepted",
    "input.updated",
    "input.failed",
    "run.updated",
    "message.upserted",
    "tool_call.upserted",
    "interaction.requested",
    "interaction.resolved",
    "security.updated",
    "session.archived",
)

internal val INFORMATIONAL_EVENT_TYPES = setOf(
    "plan.updated",
    "task.updated",
    "background_task.updated",
    "session.title.updated",
)

internal val EVENT_ENVELOPE_KEYS = setOf("eventId", "sessionId", "revision", "type", "timestamp", "criticality")

private val ISO_8601_TIMESTAMP = Regex("""^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$""")

private const val MAX_SAFE_REVISION = 9_007_199_254_740_991L

/** Envelope fields every public event carries, whatever its type. */
internal fun requirePublicEventEnvelope(value: JsonElement, errorKind: String): JsonObject {
    val event = value as? JsonObject
        ?: throw AppServerProtocolException(errorKind, "Session event must be an object")
    event.requiredString("eventId", errorKind)
    event.requiredString("sessionId", errorKind)
    val revision = event.requiredLong("revision", errorKind)
    if (revision < 1 || revision > MAX_SAFE_REVISION) {
        throw AppServerProtocolException(errorKind, "Session event revision must be a positive safe integer")
    }
    val timestamp = event.requiredString("timestamp", errorKind)
    if (!ISO_8601_TIMESTAMP.matches(timestamp)) {
        throw AppServerProtocolException(errorKind, "Session event timestamp must be an ISO-8601 timestamp")
    }
    val type = event.requiredString("type", errorKind)
    val criticality = event.requiredString("criticality", errorKind)
    if (criticality != "critical" && criticality != "informational") {
        throw AppServerProtocolException(errorKind, "Session event criticality must be critical or informational")
    }
    val expectedCriticality = when (type) {
        in CRITICAL_EVENT_TYPES -> "critical"
        in INFORMATIONAL_EVENT_TYPES -> "informational"
        else -> return event
    }
    if (criticality != expectedCriticality) {
        throw AppServerProtocolException(errorKind, "Session event criticality disagrees with its type")
    }
    return event
}

data class CanonicalSessionEvent(
    val eventId: String,
    val sessionId: String,
    val revision: Long,
    val type: String,
    val timestamp: String,
    val payload: JsonObject,
    val raw: JsonObject,
)

data class SessionProjectionState(
    val sessionId: String,
    val snapshot: JsonObject? = null,
    val lastRevision: Long = 0,
    val events: PersistentList<CanonicalSessionEvent> = persistentListOf(),
    val pendingInteractions: List<PublicPendingInteraction> = emptyList(),
    val inputs: List<PublicSessionInput> = emptyList(),
    val security: PublicSessionSecurity? = null,
    val activePlan: PublicPlanSummary? = null,
    val transientEvents: List<JsonObject> = emptyList(),
    val needsResync: Boolean = false,
    val minimumRevisionToResync: Long? = null,
    /** Unknown critical event types seen on the stream; how to react is a shared-layer decision. */
    val unknownCriticalEventTypes: Set<String> = emptySet(),
)

sealed interface SessionEventResult {
    data class Applied(val revision: Long) : SessionEventResult
    data class Duplicate(val revision: Long) : SessionEventResult
}

/**
 * Live projection over one Session's public event stream. Identity dedup is by
 * eventId (several public events may share one revision) and revisions only
 * ever move forward; a missing revision is never an error by itself — the
 * authoritative signal to recover is the session.resyncRequired notification.
 */
class SessionProjection(private val sessionId: String) {
    private val seenEventIds = HashSet<String>()
    private var baselineRevision = 0L
    private val terminalRuns = mutableSetOf<String>()
    private val durableAssistantRuns = mutableSetOf<String>()
    private val durableToolCalls = mutableSetOf<Pair<String, String>>()

    var state: SessionProjectionState = SessionProjectionState(sessionId)
        private set

    init {
        if (sessionId.isBlank()) throw AppServerProtocolException("invalid_params", "Session ID must be a non-blank string")
    }

    fun recoveryCursor(): RecoveryCursor = RecoveryCursor(
        sessionId = sessionId,
        afterRevision = state.minimumRevisionToResync
            ?.let { (it - 1).coerceAtLeast(0) }
            ?: state.lastRevision,
    )

    fun applySnapshot(snapshotValue: JsonElement): SessionProjectionState {
        val snapshot = snapshotValue as? JsonObject
            ?: throw AppServerProtocolException("invalid_result", "Session snapshot must be an object")
        if (snapshot.requiredString("sessionId") != sessionId) {
            throw AppServerProtocolException("invalid_result", "Session snapshot belongs to a different Session")
        }
        val revision = snapshot.requiredLong("asOfRevision")
        if (revision !in 0..MAX_SAFE_REVISION) {
            throw AppServerProtocolException("invalid_result", "Session snapshot revision is outside the supported range")
        }
        val minimumRevision = state.minimumRevisionToResync
        val resyncSatisfied = minimumRevision == null || revision >= minimumRevision
        val pendingInteractions = decodePendingInteractions(snapshot["pendingInteractions"], "invalid_result")
        val inputs = decodeInputs(snapshot["inputs"], "invalid_result")
        val security = decodeSnapshotSecurity(snapshot["security"], "invalid_result")
        val activePlan = decodeSnapshotActivePlan(snapshot["activePlan"], "invalid_result")
        baselineRevision = revision
        state = state.copy(
            snapshot = snapshot,
            lastRevision = revision,
            events = persistentListOf(),
            pendingInteractions = pendingInteractions,
            inputs = inputs,
            security = security,
            activePlan = activePlan,
            transientEvents = emptyList(),
            needsResync = !resyncSatisfied,
            minimumRevisionToResync = if (resyncSatisfied) null else minimumRevision,
            unknownCriticalEventTypes = emptySet(),
        )
        seenEventIds.clear()
        terminalRuns.clear()
        durableAssistantRuns.clear()
        durableToolCalls.clear()
        return state
    }

    // Full snapshot shape is validated upstream by the Api layer, which always
    // supplies these fields; a snapshot without them baselines to empty lists.
    private fun decodePendingInteractions(field: JsonElement?, errorKind: String): List<PublicPendingInteraction> {
        if (field == null) return emptyList()
        val array = field as? JsonArray
            ?: throw AppServerProtocolException(errorKind, "Session snapshot pendingInteractions must be an array")
        return array.mapIndexed { index, element ->
            val interaction = element as? JsonObject
                ?: throw AppServerProtocolException(errorKind, "Session snapshot pendingInteractions[$index] must be an object")
            decodePublicPendingInteraction(interaction, errorKind)
        }
    }

    private fun decodeInputs(field: JsonElement?, errorKind: String): List<PublicSessionInput> {
        if (field == null) return emptyList()
        val array = field as? JsonArray
            ?: throw AppServerProtocolException(errorKind, "Session snapshot inputs must be an array")
        return array.mapIndexed { index, element ->
            val input = element as? JsonObject
                ?: throw AppServerProtocolException(errorKind, "Session snapshot inputs[$index] must be an object")
            decodePublicInputSnapshot(input, errorKind)
        }
    }

    private fun decodeSnapshotSecurity(field: JsonElement?, errorKind: String): PublicSessionSecurity? {
        // Absence is tolerated like the list baselines: the Api layer validates
        // the full snapshot, and a partial snapshot still baselines a usable
        // projection with the mirror left unset.
        if (field == null) return null
        val security = field as? JsonObject
            ?: throw AppServerProtocolException(errorKind, "Session snapshot security must be an object")
        return decodePublicSessionSecurity(security, errorKind)
    }

    private fun decodeSnapshotActivePlan(field: JsonElement?, errorKind: String): PublicPlanSummary? {
        // An absent key means no plan exists, so the mirror baselines to null
        // rather than to an empty placeholder plan.
        if (field == null) return null
        val plan = field as? JsonObject
            ?: throw AppServerProtocolException(errorKind, "Session snapshot activePlan must be an object")
        return decodePublicPlanSummary(plan, errorKind)
    }

    fun applyLiveEvent(paramsValue: JsonElement): SessionEventResult =
        applyDecoded(decodeSessionEventNotification(paramsValue), "invalid_params")

    /** Applies a replay page's events in host order; each is deduped individually. */
    fun applyEvents(eventValues: List<JsonElement>): SessionProjectionState {
        val events = eventValues.map { decodeEventValue(it, "invalid_result") }
        events.forEach { applyDecoded(it, "invalid_result") }
        return state
    }

    private fun decodeEventValue(value: JsonElement, errorKind: String): SessionEventDecoding {
        val event = value as? JsonObject
            ?: throw AppServerProtocolException(errorKind, "Session event must be an object")
        return decodePublicSessionEvent(event, errorKind)
    }

    private fun applyDecoded(decoding: SessionEventDecoding, errorKind: String): SessionEventResult {
        val envelope = decoding.envelope
        if (envelope.sessionId != sessionId) {
            throw AppServerProtocolException(errorKind, "Session event belongs to a different Session")
        }
        // Several public events may share one revision, so identity dedup is by eventId;
        // events at or before the snapshot baseline are already reflected in the snapshot,
        // and anything below the highest applied revision is a stale straggler.
        if (envelope.eventId in seenEventIds ||
            envelope.revision <= baselineRevision ||
            envelope.revision < state.lastRevision
        ) {
            return SessionEventResult.Duplicate(envelope.revision)
        }
        seenEventIds.add(envelope.eventId)
        state = state.copy(lastRevision = envelope.revision)
        when (decoding) {
            is SessionEventDecoding.Known -> {
                val event = decoding.toCanonicalEvent()
                state = state.copy(events = state.events + event)
                recordPublicEvent(event, errorKind)
            }
            // Unknown informational events are safe to skip, but the revision cursor still
            // advances so the recovery floor keeps tracking the host.
            is SessionEventDecoding.SkippedUnknown -> Unit
            is SessionEventDecoding.UnknownCritical ->
                state = state.copy(unknownCriticalEventTypes = state.unknownCriticalEventTypes + envelope.type)
        }
        state = state.copy(transientEvents = pruneTransientEvents(state.transientEvents))
        return SessionEventResult.Applied(envelope.revision)
    }

    private fun SessionEventDecoding.Known.toCanonicalEvent(): CanonicalSessionEvent = CanonicalSessionEvent(
        eventId = envelope.eventId,
        sessionId = envelope.sessionId,
        revision = envelope.revision,
        type = envelope.type,
        timestamp = envelope.timestamp,
        payload = JsonObject(envelope.raw.filterKeys { it !in EVENT_ENVELOPE_KEYS }),
        raw = envelope.raw,
    )

    fun markResyncRequired(sessionId: String, minimumRevision: Long) {
        requireSession(sessionId, "Resync notification")
        requireRevision(minimumRevision, "Minimum revision", "invalid_params")
        state = state.copy(
            needsResync = true,
            minimumRevisionToResync = maxOf(state.minimumRevisionToResync ?: minimumRevision, minimumRevision),
        )
    }

    fun markResyncRequired(notification: AppServerResyncRequiredNotification) {
        markResyncRequired(notification.sessionId, notification.minimumRevision)
    }

    fun applyTransient(sessionId: String, eventValue: JsonElement) {
        requireSession(sessionId, "Transient event")
        val raw = eventValue as? JsonObject
            ?: throw AppServerProtocolException("invalid_params", "Session transient event must be an object")
        val event = decodePublicTransientEvent(raw, "invalid_params")
        if (event.sessionId != sessionId) {
            throw AppServerProtocolException("invalid_params", "Transient event belongs to a different Session")
        }
        // Child-attributed deltas belong to the child Session's own stream, not this projection.
        if (event.kind == "child_agent_started" || raw.containsKey("childSessionId")) return
        state = state.copy(
            transientEvents = pruneTransientEvents(mergeTransientEvents(state.transientEvents, listOf(raw))),
        )
    }

    private fun recordPublicEvent(event: CanonicalSessionEvent, errorKind: String) {
        when (event.type) {
            "input.accepted" -> {
                val input = event.payload["input"] as? JsonObject ?: return
                // Event order is queue order; the mailbox stays FIFO as emitted.
                state = state.copy(inputs = state.inputs + decodePublicInputSnapshot(input, errorKind))
            }
            "input.updated" -> {
                val input = event.payload["input"] as? JsonObject ?: return
                applyInputUpdate(decodePublicInputSnapshot(input, errorKind))
            }
            "input.failed" -> {
                // The payload carries identities and the failure only, so the last
                // known fields stay and just the status turns; an id the projection
                // never held cannot be enriched and is tolerated without an entry.
                val inputId = event.payload.stringOrNull("inputId") ?: return
                val known = state.inputs.firstOrNull { it.inputId == inputId } ?: return
                applyInputUpdate(known.copy(status = "failed"))
            }
            "run.updated" -> {
                val run = event.payload["run"] as? JsonObject ?: return
                val runId = run.stringOrNull("runId") ?: return
                val status = run.stringOrNull("status")
                if (status == "completed" || status == "failed" || status == "cancelled") terminalRuns += runId
            }
            "interaction.requested" -> {
                val interaction = event.payload["interaction"] as? JsonObject ?: return
                state = state.copy(
                    pendingInteractions = state.pendingInteractions + decodePublicPendingInteraction(interaction, errorKind),
                )
            }
            "interaction.resolved" -> {
                val resolution = event.payload["resolution"] as? JsonObject ?: return
                val interactionId = resolution.stringOrNull("interactionId") ?: return
                // A resolution may trail a snapshot that never carried the interaction.
                state = state.copy(pendingInteractions = state.pendingInteractions.filterNot { it.interactionId == interactionId })
            }
            "security.updated" -> {
                val (permissionMode, policyRevision) = decodePublicSecurityUpdate(event.payload, errorKind)
                // The event carries exactly mode and revision; the other mirror fields
                // keep their last-known snapshot values, and without a baseline there
                // is nothing to move onto.
                state.security?.let { security ->
                    state = state.copy(
                        security = security.copy(permissionMode = permissionMode, policyRevision = policyRevision),
                    )
                }
            }
            "plan.updated" -> {
                val plan = event.payload["plan"] as? JsonObject ?: return
                // The event always carries the full current summary, so the
                // mirror is replaced whole rather than merged field by field.
                state = state.copy(activePlan = decodePublicPlanSummary(plan, errorKind))
            }
            "message.upserted" -> {
                val message = event.payload["message"] as? JsonObject ?: return
                if (message.stringOrNull("role") == "assistant" && hasNonEmptyText(message["content"])) {
                    message.stringOrNull("runId")?.let(durableAssistantRuns::add)
                }
            }
            "tool_call.upserted" -> {
                val toolCall = event.payload["toolCall"] as? JsonObject ?: return
                val status = toolCall.stringOrNull("status")
                if (status != "completed" && status != "failed" && status != "denied") return
                val runId = toolCall.stringOrNull("runId") ?: return
                val toolCallId = toolCall.stringOrNull("toolCallId") ?: return
                durableToolCalls += runId to toolCallId
            }
        }
    }

    // A transition rides the full input object, so the entry is replaced in
    // place to preserve mailbox order; an update the baseline never carried
    // still lands whole rather than being dropped.
    private fun applyInputUpdate(updated: PublicSessionInput) {
        val index = state.inputs.indexOfFirst { it.inputId == updated.inputId }
        state = if (index == -1) {
            state.copy(inputs = state.inputs + updated)
        } else {
            state.copy(inputs = state.inputs.toMutableList().apply { set(index, updated) })
        }
    }

    private fun pruneTransientEvents(transientEvents: List<JsonObject>): List<JsonObject> {
        if (transientEvents.isEmpty()) return transientEvents

        return transientEvents.filter { transient ->
            if (transient.requiredString("kind") == "child_agent_started" || transient.containsKey("childSessionId")) {
                return@filter false
            }
            val runId = transient.stringOrNull("runId")
            if (runId != null && runId in terminalRuns) return@filter false
            if (transient.requiredString("kind") == "model_text_delta") {
                runId == null || runId !in durableAssistantRuns
            } else {
                val toolCallId = transient.stringOrNull("toolCallId")
                runId == null || toolCallId == null || (runId to toolCallId) !in durableToolCalls
            }
        }
    }

    private fun hasNonEmptyText(content: JsonElement?): Boolean = when (content) {
        is JsonArray -> content.any { block ->
            val objectBlock = block as? JsonObject ?: return@any false
            val type = objectBlock["type"] as? JsonPrimitive
            val text = objectBlock["text"] as? JsonPrimitive
            type?.isString == true && type.content == "text" && text?.isString == true && text.content.isNotEmpty()
        }
        else -> false
    }

    private fun JsonObject.stringOrNull(name: String): String? =
        (this[name] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content

    private fun mergeTransientEvents(existing: List<JsonObject>, incoming: List<JsonObject>): List<JsonObject> {
        val byEventId = linkedMapOf<String, JsonObject>()
        existing.forEach { event -> byEventId[event.requiredString("eventId")] = event }
        incoming.forEach { event -> byEventId[event.requiredString("eventId")] = event }
        return byEventId.values
            .sortedBy { it.requiredLong("sequence") }
            .takeLast(MAX_TRANSIENT_EVENTS)
            .toList()
    }

    private fun requireSession(actualSessionId: String, source: String) {
        if (actualSessionId != sessionId) {
            throw AppServerProtocolException("invalid_result", "$source belongs to a different Session")
        }
    }

    private fun requireRevision(revision: Long, field: String, errorKind: String) {
        if (revision !in 0..MAX_SAFE_REVISION) {
            throw AppServerProtocolException(errorKind, "$field is outside the supported range")
        }
    }

    private companion object {
        const val MAX_TRANSIENT_EVENTS = 512
    }
}
