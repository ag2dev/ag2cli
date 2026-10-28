package com.ag2dev.ag2cli.mobile.core.session

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.requiredLong
import com.ag2dev.ag2cli.mobile.core.protocol.requiredString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

// Public session event decoding: a known `type` must satisfy its strict
// per-type payload (a malformed payload is a wire violation), while an
// unknown `type` is tolerated through the lenient envelope so consumers can
// skip unknown informational events without dropping the connection.

/** Envelope fields every public event carries, whatever its type. */
data class PublicSessionEventEnvelope(
    val eventId: String,
    val sessionId: String,
    val revision: Long,
    val type: String,
    val timestamp: String,
    val criticality: String,
    val raw: JsonObject,
)

sealed interface SessionEventDecoding {
    val envelope: PublicSessionEventEnvelope
    val raw: JsonObject get() = envelope.raw

    /** Known type: envelope and per-type payload both validated. */
    data class Known(override val envelope: PublicSessionEventEnvelope) : SessionEventDecoding

    /** Unknown informational type: safe to skip while the revision cursor still advances. */
    data class SkippedUnknown(override val envelope: PublicSessionEventEnvelope) : SessionEventDecoding

    /**
     * Unknown critical type: classification fact only. Deciding between resync and
     * degraded read-only mode is a shared-layer concern, not a decoder action.
     */
    data class UnknownCritical(override val envelope: PublicSessionEventEnvelope) : SessionEventDecoding
}

fun decodeSessionEventNotification(value: JsonElement): SessionEventDecoding {
    val params = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "session.event params must be an object")
    if (params.keys != setOf("event")) {
        throw AppServerProtocolException("invalid_params", "session.event params must contain exactly the event field")
    }
    val raw = params["event"] as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "session.event params.event must be an object")
    return decodePublicSessionEvent(raw, "invalid_params")
}

fun decodePublicSessionEvent(raw: JsonObject, errorKind: String): SessionEventDecoding {
    requirePublicEventEnvelope(raw, errorKind)
    val envelope = PublicSessionEventEnvelope(
        eventId = raw.requiredString("eventId", errorKind),
        sessionId = raw.requiredString("sessionId", errorKind),
        revision = raw.requiredLong("revision", errorKind),
        type = raw.requiredString("type", errorKind),
        timestamp = raw.requiredString("timestamp", errorKind),
        criticality = raw.requiredString("criticality", errorKind),
        raw = raw,
    )
    return when {
        envelope.type in KNOWN_PUBLIC_EVENT_TYPES -> {
            validatePublicSessionEventPayload(envelope.type, raw, errorKind)
            SessionEventDecoding.Known(envelope)
        }
        envelope.criticality == "informational" -> SessionEventDecoding.SkippedUnknown(envelope)
        else -> SessionEventDecoding.UnknownCritical(envelope)
    }
}

/** Envelope fields every transient event carries, whatever its kind. */
data class PublicTransientEventEnvelope(
    val eventId: String,
    val sessionId: String,
    val sequence: Long,
    val timestamp: String,
    val kind: String,
    val raw: JsonObject,
)

fun decodeSessionTransientNotification(value: JsonElement): PublicTransientEventEnvelope {
    val params = value as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "session.transient params must be an object")
    if (params.keys != setOf("event")) {
        throw AppServerProtocolException("invalid_params", "session.transient params must contain exactly the event field")
    }
    val raw = params["event"] as? JsonObject
        ?: throw AppServerProtocolException("invalid_params", "session.transient params.event must be an object")
    return decodePublicTransientEvent(raw, "invalid_params")
}

fun decodePublicTransientEvent(raw: JsonObject, errorKind: String): PublicTransientEventEnvelope {
    val envelope = PublicTransientEventEnvelope(
        eventId = raw.requiredNonEmpty("eventId", errorKind),
        sessionId = raw.requiredNonEmpty("sessionId", errorKind),
        sequence = raw.requiredInt("sequence", 1, MAX_SAFE_INTEGER, errorKind),
        timestamp = raw.requiredTimestamp("timestamp", errorKind),
        kind = raw.requiredEnumValue("kind", TRANSIENT_EVENT_KINDS, errorKind),
        raw = raw,
    )
    validateTransientEventPayload(envelope.kind, raw, errorKind)
    return envelope
}

private fun validateTransientEventPayload(kind: String, event: JsonObject, errorKind: String) {
    when (kind) {
        "model_text_delta" -> {
            event.requiredNonEmpty("runId", errorKind)
            event.requiredInt("turn", 1, MAX_SAFE_INTEGER, errorKind)
            event.requiredPlain("text", errorKind)
            event.optionalNonEmpty("childSessionId", errorKind)
        }
        "model_tool_call_start" -> {
            event.requiredNonEmpty("runId", errorKind)
            event.requiredNonEmpty("toolCallId", errorKind)
            event.requiredNonEmpty("toolName", errorKind)
            event.requiredPlain("title", errorKind)
            event.optionalNonEmpty("childSessionId", errorKind)
        }
        "model_tool_call_delta" -> {
            event.requiredNonEmpty("runId", errorKind)
            event.requiredNonEmpty("toolCallId", errorKind)
            event.requiredPlain("inputDelta", errorKind)
            event.optionalNonEmpty("childSessionId", errorKind)
        }
        "model_tool_call_end" -> {
            event.requiredNonEmpty("runId", errorKind)
            event.requiredNonEmpty("toolCallId", errorKind)
            event.optionalNonEmpty("childSessionId", errorKind)
        }
        "tool_output_delta" -> {
            event.requiredNonEmpty("runId", errorKind)
            event.requiredNonEmpty("toolCallId", errorKind)
            event.requiredEnumValue("stream", TRANSIENT_OUTPUT_STREAMS, errorKind)
            event.requiredPlain("text", errorKind)
        }
        "child_agent_started" -> {
            event.requiredNonEmpty("runId", errorKind)
            event.requiredNonEmpty("childSessionId", errorKind)
            event.optionalPlain("title", errorKind)
            event.optionalNonEmpty("subagentType", errorKind)
            event.optionalNonEmpty("toolUseId", errorKind)
        }
    }
}

internal val KNOWN_PUBLIC_EVENT_TYPES = CRITICAL_EVENT_TYPES + INFORMATIONAL_EVENT_TYPES

internal fun validatePublicSessionEventPayload(type: String, event: JsonObject, errorKind: String) {
    when (type) {
        "input.accepted", "input.updated" ->
            validatePublicInputSnapshot(event.requiredObjectField("input", errorKind), errorKind)
        "input.failed" -> {
            event.requiredNonEmpty("inputId", errorKind)
            event.requiredNonEmpty("commandId", errorKind)
            validatePublicFailure(event.requiredObjectField("failure", errorKind), errorKind)
        }
        "run.updated" -> validatePublicRunSnapshot(event.requiredObjectField("run", errorKind), errorKind)
        "message.upserted" -> validatePublicMessage(event.requiredObjectField("message", errorKind), errorKind)
        "tool_call.upserted" -> validatePublicToolCall(event.requiredObjectField("toolCall", errorKind), errorKind)
        "interaction.requested" ->
            validatePublicPendingInteraction(event.requiredObjectField("interaction", errorKind), errorKind)
        "interaction.resolved" ->
            validatePublicInteractionResolution(event.requiredObjectField("resolution", errorKind), errorKind)
        "security.updated" -> {
            event.requiredEnumValue("permissionMode", PUBLIC_PERMISSION_MODES, errorKind)
            event.requiredInt("policyRevision", 0, MAX_SAFE_INTEGER, errorKind)
        }
        "session.archived" -> event.requiredTimestamp("archivedAt", errorKind)
        "plan.updated" -> validatePublicPlanSummary(event.requiredObjectField("plan", errorKind), errorKind)
        "task.updated", "background_task.updated" ->
            validatePublicTaskSummary(event.requiredObjectField("task", errorKind), errorKind)
        "session.title.updated" -> event.requiredPlain("title", errorKind)
    }
}

private fun validatePublicInputSnapshot(input: JsonObject, errorKind: String) {
    input.requiredNonEmpty("inputId", errorKind)
    input.requiredNonEmpty("commandId", errorKind)
    input.requiredEnumValue("kind", INPUT_KINDS, errorKind)
    input.requiredEnumValue("status", INPUT_STATUSES, errorKind)
    input.requiredTimestamp("acceptedAt", errorKind)
    input.optionalNonEmpty("runId", errorKind)
    // Full mailbox text, never a truncated preview.
    input.requiredPlain("text", errorKind)
    input.optionalPlain("cancelReason", errorKind)
}

/** Typed mirror of the public input snapshot; text is the full mailbox text
 * and cancelReason appears only on status "cancelled". */
data class PublicSessionInput(
    val inputId: String,
    val commandId: String,
    val kind: String,
    val status: String,
    val acceptedAt: String,
    val runId: String? = null,
    val text: String,
    val cancelReason: String? = null,
)

/** Single strict decode path for mailbox inputs: snapshot elements and
 * input.accepted/input.updated payloads both run through the payload
 * validator before extraction. */
internal fun decodePublicInputSnapshot(input: JsonObject, errorKind: String): PublicSessionInput {
    validatePublicInputSnapshot(input, errorKind)
    return PublicSessionInput(
        inputId = input.requiredNonEmpty("inputId", errorKind),
        commandId = input.requiredNonEmpty("commandId", errorKind),
        kind = input.requiredEnumValue("kind", INPUT_KINDS, errorKind),
        status = input.requiredEnumValue("status", INPUT_STATUSES, errorKind),
        acceptedAt = input.requiredTimestamp("acceptedAt", errorKind),
        runId = input.optionalNonEmpty("runId", errorKind),
        text = input.requiredPlain("text", errorKind),
        cancelReason = input.optionalPlain("cancelReason", errorKind),
    )
}

/** Typed mirror of the snapshot security block; rules are deliberately absent
 * because they travel only through the permission policy face. */
data class PublicSessionSecurity(
    val permissionMode: String,
    val policyRevision: Long,
    val hasCustomRules: Boolean,
    val selectableModes: List<String>,
)

/** Single strict decode path for the snapshot security block. */
internal fun decodePublicSessionSecurity(security: JsonObject, errorKind: String): PublicSessionSecurity {
    val permissionMode = security.requiredEnumValue("permissionMode", PUBLIC_PERMISSION_MODES, errorKind)
    val policyRevision = security.requiredInt("policyRevision", 0, MAX_SAFE_INTEGER, errorKind)
    val hasCustomRules = security.requiredBoolean("hasCustomRules", errorKind)
    val selectableModes = security.requiredArrayField("selectableModes", errorKind).mapIndexed { index, element ->
        val mode = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: invalid(errorKind, "selectableModes[$index] must be a permission mode")
        if (mode !in PUBLIC_PERMISSION_MODES) {
            invalid(errorKind, "selectableModes[$index] must be one of ${PUBLIC_PERMISSION_MODES.sorted().joinToString(", ")}")
        }
        mode
    }
    return PublicSessionSecurity(permissionMode, policyRevision, hasCustomRules, selectableModes)
}

/** Single strict decode path for the security.updated payload; the event
 * carries exactly the mode and the revision that moved. */
internal fun decodePublicSecurityUpdate(payload: JsonObject, errorKind: String): Pair<String, Long> {
    val permissionMode = payload.requiredEnumValue("permissionMode", PUBLIC_PERMISSION_MODES, errorKind)
    val policyRevision = payload.requiredInt("policyRevision", 0, MAX_SAFE_INTEGER, errorKind)
    return permissionMode to policyRevision
}

private fun validatePublicFailure(failure: JsonObject, errorKind: String) {
    failure.requiredNonEmpty("code", errorKind)
    failure.requiredPlain("message", errorKind)
    failure.requiredBoolean("retryable", errorKind)
}

private fun validatePublicRunSnapshot(run: JsonObject, errorKind: String) {
    run.requiredNonEmpty("runId", errorKind)
    run.requiredEnumValue("status", RUN_STATUSES, errorKind)
    run.requiredInt("turn", 1, MAX_SAFE_INTEGER, errorKind)
    run.requiredTimestamp("startedAt", errorKind)
    run.optionalTimestamp("completedAt", errorKind)
    run.optionalPlain("goal", errorKind)
    run.requiredEnumValue("phase", RUN_PHASES, errorKind)
    run.optionalObjectField("activeTool", errorKind)?.let { tool ->
        tool.requiredNonEmpty("toolCallId", errorKind)
        tool.requiredNonEmpty("toolName", errorKind)
        tool.requiredPlain("title", errorKind)
        tool.optionalTimestamp("startedAt", errorKind)
    }
    run.optionalObjectField("usage", errorKind)?.let { usage ->
        usage.optionalPlain("model", errorKind)
        usage.optionalInt("inputTokens", 0, MAX_SAFE_INTEGER, errorKind)
        usage.optionalBoolean("estimated", errorKind)
    }
    run.optionalObjectField("failure", errorKind)?.let { failure ->
        validatePublicFailure(failure, errorKind)
    }
}

private fun validatePublicMessage(message: JsonObject, errorKind: String) {
    message.requiredNonEmpty("messageId", errorKind)
    message.requiredEnumValue("role", MESSAGE_ROLES, errorKind)
    message.optionalNonEmpty("runId", errorKind)
    message.requiredTimestamp("createdAt", errorKind)
    val content = message.requiredArrayField("content", errorKind)
    content.forEachIndexed { index, block ->
        val objectBlock = block as? JsonObject ?: invalid(errorKind, "content[$index] must be an object")
        when (objectBlock.requiredEnumValue("type", CONTENT_BLOCK_TYPES, errorKind)) {
            "text" -> objectBlock.requiredPlain("text", errorKind)
            "file_reference" -> {
                objectBlock.requiredNonEmpty("workspaceId", errorKind)
                objectBlock.requiredNonEmpty("path", errorKind)
                objectBlock.requiredPlain("displayName", errorKind)
            }
        }
    }
    message.optionalInt("turn", 1, MAX_SAFE_INTEGER, errorKind)
    message.optionalInt("durationMs", 0, MAX_SAFE_INTEGER, errorKind)
}

private fun validatePublicToolCall(toolCall: JsonObject, errorKind: String) {
    toolCall.requiredNonEmpty("toolCallId", errorKind)
    toolCall.requiredNonEmpty("runId", errorKind)
    toolCall.requiredNonEmpty("toolName", errorKind)
    toolCall.requiredPlain("title", errorKind)
    toolCall.requiredEnumValue("status", TOOL_CALL_STATUSES, errorKind)
    toolCall.optionalInt("turn", 1, MAX_SAFE_INTEGER, errorKind)
    toolCall.optionalTimestamp("startedAt", errorKind)
    toolCall.optionalTimestamp("completedAt", errorKind)
    toolCall.optionalNonEmpty("interactionId", errorKind)
    toolCall.optionalPlain("input", errorKind)
    toolCall.optionalPlain("result", errorKind)
    toolCall.optionalPlain("resultSummary", errorKind)
    toolCall.optionalObjectField("diff", errorKind)?.let { diff ->
        diff.requiredInt("additions", 0, MAX_SAFE_INTEGER, errorKind)
        diff.requiredInt("deletions", 0, MAX_SAFE_INTEGER, errorKind)
        diff.requiredInt("sites", 0, MAX_SAFE_INTEGER, errorKind)
        diff.requiredPlain("patch", errorKind)
    }
    toolCall.optionalObjectField("denial", errorKind)?.let { denial ->
        denial.requiredNonEmpty("code", errorKind)
        denial.optionalPlain("reason", errorKind)
    }
    toolCall.optionalBoolean("isError", errorKind)
    toolCall.optionalPlain("questionOutcome", errorKind)
    toolCall.optionalNonEmpty("childSessionId", errorKind)
    toolCall.optionalNonEmpty("childRunId", errorKind)
}

private fun validatePublicPendingInteraction(interaction: JsonObject, errorKind: String) {
    interaction.requiredNonEmpty("interactionId", errorKind)
    interaction.requiredNonEmpty("sessionId", errorKind)
    interaction.requiredNonEmpty("runId", errorKind)
    interaction.requiredInt("turn", 1, MAX_SAFE_INTEGER, errorKind)
    interaction.requiredTimestamp("createdAt", errorKind)
    when (interaction.requiredEnumValue("kind", INTERACTION_KINDS, errorKind)) {
        "tool_approval" -> {
            interaction.requiredNonEmpty("toolCallId", errorKind)
            interaction.requiredPlain("title", errorKind)
            interaction.optionalPlain("description", errorKind)
            validatePublicApprovalSubject(interaction.requiredObjectField("subject", errorKind), errorKind)
            interaction.requiredArrayField("options", errorKind).forEachIndexed { index, element ->
                val option = element as? JsonObject ?: invalid(errorKind, "options[$index] must be an object")
                option.requiredNonEmpty("optionId", errorKind)
                option.requiredPlain("label", errorKind)
                option.requiredEnumValue("outcome", APPROVAL_OPTION_OUTCOMES, errorKind)
            }
            interaction.requiredInt("policyRevision", 0, MAX_SAFE_INTEGER, errorKind)
            interaction.requiredInt("scopeRevision", 0, MAX_SAFE_INTEGER, errorKind)
            interaction.optionalEnumValue("ownedBy", INTERACTION_OWNERS, errorKind)
        }
        "ask_user" -> {
            interaction.requiredArrayField("questions", errorKind).forEachIndexed { index, element ->
                val question = element as? JsonObject ?: invalid(errorKind, "questions[$index] must be an object")
                question.requiredNonEmpty("questionId", errorKind)
                question.requiredPlain("question", errorKind)
                question.optionalPlain("header", errorKind)
                question.requiredBoolean("multiSelect", errorKind)
                question.requiredArrayField("options", errorKind).forEachIndexed { optionIndex, optionElement ->
                    val option = optionElement as? JsonObject
                        ?: invalid(errorKind, "questions[$index].options[$optionIndex] must be an object")
                    option.requiredNonEmpty("optionId", errorKind)
                    option.requiredPlain("label", errorKind)
                    option.optionalPlain("description", errorKind)
                }
            }
            interaction.optionalEnumValue("inputMode", ASK_USER_INPUT_MODES, errorKind)
        }
    }
}

private fun validatePublicApprovalSubject(subject: JsonObject, errorKind: String) {
    when (subject.requiredEnumValue("type", APPROVAL_SUBJECT_TYPES, errorKind)) {
        "tool_call" -> {
            subject.requiredNonEmpty("toolName", errorKind)
            subject.requiredPlain("summary", errorKind)
            subject.optionalPlain("command", errorKind)
            subject.optionalNonEmpty("workspaceId", errorKind)
            subject.optionalPlain("path", errorKind)
            subject.optionalPlain("diff", errorKind)
            subject.optionalPlain("pattern", errorKind)
            subject.optionalPlain("url", errorKind)
            subject.optionalObjectField("agentProfile", errorKind)?.let { profile ->
                profile.requiredNonEmpty("subagentType", errorKind)
                profile.optionalPlain("model", errorKind)
            }
            subject.optionalPlain("inputExcerpt", errorKind)?.let { excerpt ->
                if (excerpt.length > MAX_INPUT_EXCERPT_LENGTH) {
                    invalid(errorKind, "inputExcerpt must be at most $MAX_INPUT_EXCERPT_LENGTH characters")
                }
            }
        }
        "command" -> {
            subject.requiredNonEmpty("command", errorKind)
            subject.requiredNonEmpty("workspaceId", errorKind)
            subject.requiredNonEmpty("cwdRelative", errorKind)
        }
    }
}

/** Typed mirror of the pending-interaction wire union; the two kinds share only the envelope fields. */
sealed interface PublicPendingInteraction {
    val interactionId: String
    val sessionId: String
    val runId: String
    val turn: Long
    val createdAt: String

    data class ToolApproval(
        override val interactionId: String,
        override val sessionId: String,
        override val runId: String,
        override val turn: Long,
        override val createdAt: String,
        val toolCallId: String,
        val title: String,
        val description: String?,
        val subject: PublicApprovalSubject,
        val options: List<PublicApprovalOption>,
        val policyRevision: Long,
        val scopeRevision: Long,
        val ownedBy: String?,
    ) : PublicPendingInteraction

    data class AskUser(
        override val interactionId: String,
        override val sessionId: String,
        override val runId: String,
        override val turn: Long,
        override val createdAt: String,
        val questions: List<PublicAskUserQuestion>,
        val inputMode: String?,
    ) : PublicPendingInteraction
}

data class PublicApprovalOption(val optionId: String, val label: String, val outcome: String)

data class PublicAgentProfile(val subagentType: String, val model: String?)

sealed interface PublicApprovalSubject {
    data class ToolCall(
        val toolName: String,
        val summary: String,
        val command: String?,
        val workspaceId: String?,
        val path: String?,
        val diff: String?,
        val pattern: String?,
        val url: String?,
        val agentProfile: PublicAgentProfile?,
        val inputExcerpt: String?,
    ) : PublicApprovalSubject

    data class Command(
        val command: String,
        val workspaceId: String,
        val cwdRelative: String,
    ) : PublicApprovalSubject
}

data class PublicAskUserOption(val optionId: String, val label: String, val description: String?)

data class PublicAskUserQuestion(
    val questionId: String,
    val question: String,
    val header: String?,
    val multiSelect: Boolean,
    val options: List<PublicAskUserOption>,
)

/** Single strict decode path for pending interactions: snapshot elements and
 * event payloads both run through the payload validator before extraction. */
internal fun decodePublicPendingInteraction(interaction: JsonObject, errorKind: String): PublicPendingInteraction {
    validatePublicPendingInteraction(interaction, errorKind)
    return when (interaction.requiredEnumValue("kind", INTERACTION_KINDS, errorKind)) {
        "tool_approval" -> PublicPendingInteraction.ToolApproval(
            interactionId = interaction.requiredNonEmpty("interactionId", errorKind),
            sessionId = interaction.requiredNonEmpty("sessionId", errorKind),
            runId = interaction.requiredNonEmpty("runId", errorKind),
            turn = interaction.requiredInt("turn", 1, MAX_SAFE_INTEGER, errorKind),
            createdAt = interaction.requiredTimestamp("createdAt", errorKind),
            toolCallId = interaction.requiredNonEmpty("toolCallId", errorKind),
            title = interaction.requiredPlain("title", errorKind),
            description = interaction.optionalPlain("description", errorKind),
            subject = decodePublicApprovalSubject(interaction.requiredObjectField("subject", errorKind), errorKind),
            options = interaction.requiredArrayField("options", errorKind).map { element ->
                val option = element as? JsonObject ?: invalid(errorKind, "options element must be an object")
                PublicApprovalOption(
                    optionId = option.requiredNonEmpty("optionId", errorKind),
                    label = option.requiredPlain("label", errorKind),
                    outcome = option.requiredEnumValue("outcome", APPROVAL_OPTION_OUTCOMES, errorKind),
                )
            },
            policyRevision = interaction.requiredInt("policyRevision", 0, MAX_SAFE_INTEGER, errorKind),
            scopeRevision = interaction.requiredInt("scopeRevision", 0, MAX_SAFE_INTEGER, errorKind),
            ownedBy = interaction.optionalEnumValue("ownedBy", INTERACTION_OWNERS, errorKind),
        )
        "ask_user" -> PublicPendingInteraction.AskUser(
            interactionId = interaction.requiredNonEmpty("interactionId", errorKind),
            sessionId = interaction.requiredNonEmpty("sessionId", errorKind),
            runId = interaction.requiredNonEmpty("runId", errorKind),
            turn = interaction.requiredInt("turn", 1, MAX_SAFE_INTEGER, errorKind),
            createdAt = interaction.requiredTimestamp("createdAt", errorKind),
            questions = interaction.requiredArrayField("questions", errorKind).map { element ->
                val question = element as? JsonObject ?: invalid(errorKind, "questions element must be an object")
                PublicAskUserQuestion(
                    questionId = question.requiredNonEmpty("questionId", errorKind),
                    question = question.requiredPlain("question", errorKind),
                    header = question.optionalPlain("header", errorKind),
                    multiSelect = question.requiredBoolean("multiSelect", errorKind),
                    options = question.requiredArrayField("options", errorKind).map { optionElement ->
                        val option = optionElement as? JsonObject ?: invalid(errorKind, "options element must be an object")
                        PublicAskUserOption(
                            optionId = option.requiredNonEmpty("optionId", errorKind),
                            label = option.requiredPlain("label", errorKind),
                            description = option.optionalPlain("description", errorKind),
                        )
                    },
                )
            },
            inputMode = interaction.optionalEnumValue("inputMode", ASK_USER_INPUT_MODES, errorKind),
        )
        else -> invalid(errorKind, "kind must be one of ask_user, tool_approval")
    }
}

private fun decodePublicApprovalSubject(subject: JsonObject, errorKind: String): PublicApprovalSubject =
    when (subject.requiredEnumValue("type", APPROVAL_SUBJECT_TYPES, errorKind)) {
        "tool_call" -> PublicApprovalSubject.ToolCall(
            toolName = subject.requiredNonEmpty("toolName", errorKind),
            summary = subject.requiredPlain("summary", errorKind),
            command = subject.optionalPlain("command", errorKind),
            workspaceId = subject.optionalNonEmpty("workspaceId", errorKind),
            path = subject.optionalPlain("path", errorKind),
            diff = subject.optionalPlain("diff", errorKind),
            pattern = subject.optionalPlain("pattern", errorKind),
            url = subject.optionalPlain("url", errorKind),
            agentProfile = subject.optionalObjectField("agentProfile", errorKind)?.let { profile ->
                PublicAgentProfile(
                    subagentType = profile.requiredNonEmpty("subagentType", errorKind),
                    model = profile.optionalPlain("model", errorKind),
                )
            },
            inputExcerpt = subject.optionalPlain("inputExcerpt", errorKind),
        )
        "command" -> PublicApprovalSubject.Command(
            command = subject.requiredNonEmpty("command", errorKind),
            workspaceId = subject.requiredNonEmpty("workspaceId", errorKind),
            cwdRelative = subject.requiredNonEmpty("cwdRelative", errorKind),
        )
        else -> invalid(errorKind, "type must be one of command, tool_call")
    }

private fun validatePublicInteractionResolution(resolution: JsonObject, errorKind: String) {
    resolution.requiredNonEmpty("interactionId", errorKind)
    resolution.requiredEnumValue("kind", INTERACTION_KINDS, errorKind)
    resolution.requiredEnumValue("outcome", INTERACTION_OUTCOMES, errorKind)
    resolution.requiredTimestamp("resolvedAt", errorKind)
    resolution.optionalEnumValue("resolver", INTERACTION_RESOLVER_KINDS, errorKind)
    resolution.optionalObjectField("resolvedBy", errorKind)?.let { resolver ->
        resolver.requiredPlain("clientName", errorKind)
        resolver.requiredEnumValue("clientKind", PUBLIC_CLIENT_KINDS, errorKind)
    }
    resolution.optionalArrayField("answers", errorKind)?.forEachIndexed { index, element ->
        val answer = element as? JsonObject ?: invalid(errorKind, "answers[$index] must be an object")
        answer.requiredNonEmpty("questionId", errorKind)
        answer.requiredArrayField("selectedOptionIds", errorKind).forEachIndexed { optionIndex, option ->
            val optionId = (option as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (optionId.isNullOrBlank()) {
                invalid(errorKind, "selectedOptionIds[$optionIndex] must be a non-empty string")
            }
        }
    }
}

private fun validatePublicPlanSummary(plan: JsonObject, errorKind: String) {
    plan.requiredNonEmpty("planId", errorKind)
    plan.optionalPlain("title", errorKind)
    plan.requiredEnumValue("status", PLAN_STATUSES, errorKind)
    plan.requiredInt("totalSteps", 0, MAX_SAFE_INTEGER, errorKind)
    plan.requiredInt("completedSteps", 0, MAX_SAFE_INTEGER, errorKind)
    plan.optionalArrayField("steps", errorKind)?.forEachIndexed { index, element ->
        val step = element as? JsonObject ?: invalid(errorKind, "steps[$index] must be an object")
        step.requiredInt("order", 0, MAX_SAFE_INTEGER, errorKind)
        step.requiredPlain("title", errorKind)
        step.requiredEnumValue("status", PLAN_STEP_STATUSES, errorKind)
        step.optionalPlain("description", errorKind)
    }
    plan.requiredTimestamp("updatedAt", errorKind)
}

/** Typed mirror of one plan step inside a public plan summary. */
data class PublicPlanStep(
    val order: Long,
    val title: String,
    val status: String,
    val description: String? = null,
)

/** Typed mirror of the public plan summary; steps ride along only when the
 * host emits them. */
data class PublicPlanSummary(
    val planId: String,
    val title: String? = null,
    val status: String,
    val totalSteps: Long,
    val completedSteps: Long,
    val steps: List<PublicPlanStep>? = null,
    val updatedAt: String,
)

/** Single strict decode path for plan summaries: the snapshot's activePlan and
 * the plan.updated payload both run through the payload validator before
 * extraction. */
internal fun decodePublicPlanSummary(plan: JsonObject, errorKind: String): PublicPlanSummary {
    validatePublicPlanSummary(plan, errorKind)
    return PublicPlanSummary(
        planId = plan.requiredNonEmpty("planId", errorKind),
        title = plan.optionalPlain("title", errorKind),
        status = plan.requiredEnumValue("status", PLAN_STATUSES, errorKind),
        totalSteps = plan.requiredInt("totalSteps", 0, MAX_SAFE_INTEGER, errorKind),
        completedSteps = plan.requiredInt("completedSteps", 0, MAX_SAFE_INTEGER, errorKind),
        steps = plan.optionalArrayField("steps", errorKind)?.mapIndexed { index, element ->
            val step = element as? JsonObject ?: invalid(errorKind, "steps[$index] must be an object")
            PublicPlanStep(
                order = step.requiredInt("order", 0, MAX_SAFE_INTEGER, errorKind),
                title = step.requiredPlain("title", errorKind),
                status = step.requiredEnumValue("status", PLAN_STEP_STATUSES, errorKind),
                description = step.optionalPlain("description", errorKind),
            )
        },
        updatedAt = plan.requiredTimestamp("updatedAt", errorKind),
    )
}

private fun validatePublicTaskSummary(task: JsonObject, errorKind: String) {
    task.requiredNonEmpty("taskId", errorKind)
    task.requiredEnumValue("kind", TASK_KINDS, errorKind)
    task.requiredPlain("title", errorKind)
    task.requiredEnumValue("status", TASK_STATUSES, errorKind)
    task.optionalNumber("progress", errorKind)
    task.requiredTimestamp("updatedAt", errorKind)
}

private fun invalid(errorKind: String, message: String): Nothing = throw AppServerProtocolException(errorKind, message)

private fun JsonObject.requiredPlain(field: String, errorKind: String): String =
    (this[field] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: invalid(errorKind, "$field must be a string")

private fun JsonObject.requiredNonEmpty(field: String, errorKind: String): String =
    requiredPlain(field, errorKind).takeIf { it.isNotBlank() }
        ?: invalid(errorKind, "$field must be a non-empty string")

private fun JsonObject.requiredBoolean(field: String, errorKind: String): Boolean =
    (this[field] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        ?: invalid(errorKind, "$field must be a boolean")

private fun JsonObject.requiredInt(field: String, minimum: Long, maximum: Long, errorKind: String): Long {
    val parsed = (this[field] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        ?: invalid(errorKind, "$field must be an integer")
    if (parsed < minimum || parsed > maximum) {
        invalid(errorKind, "$field must be an integer between $minimum and $maximum")
    }
    return parsed
}

private fun JsonObject.requiredTimestamp(field: String, errorKind: String): String =
    requiredPlain(field, errorKind).takeIf { ISO_8601_TIMESTAMP.matches(it) }
        ?: invalid(errorKind, "$field must be an ISO-8601 timestamp string")

private fun JsonObject.requiredEnumValue(field: String, allowed: Set<String>, errorKind: String): String =
    requiredPlain(field, errorKind).takeIf { it in allowed }
        ?: invalid(errorKind, "$field must be one of ${allowed.sorted().joinToString(", ")}")

private fun JsonObject.requiredObjectField(field: String, errorKind: String): JsonObject =
    this[field] as? JsonObject ?: invalid(errorKind, "$field must be an object")

private fun JsonObject.requiredArrayField(field: String, errorKind: String): JsonArray =
    this[field] as? JsonArray ?: invalid(errorKind, "$field must be an array")

private fun JsonObject.optionalPlain(field: String, errorKind: String): String? =
    this[field]?.let { requiredPlain(field, errorKind) }

private fun JsonObject.optionalNonEmpty(field: String, errorKind: String): String? =
    this[field]?.let { requiredNonEmpty(field, errorKind) }

private fun JsonObject.optionalBoolean(field: String, errorKind: String): Boolean? =
    this[field]?.let { requiredBoolean(field, errorKind) }

private fun JsonObject.optionalInt(field: String, minimum: Long, maximum: Long, errorKind: String): Long? =
    this[field]?.let { requiredInt(field, minimum, maximum, errorKind) }

private fun JsonObject.optionalTimestamp(field: String, errorKind: String): String? =
    this[field]?.let { requiredTimestamp(field, errorKind) }

private fun JsonObject.optionalEnumValue(field: String, allowed: Set<String>, errorKind: String): String? =
    this[field]?.let { requiredEnumValue(field, allowed, errorKind) }

private fun JsonObject.optionalObjectField(field: String, errorKind: String): JsonObject? =
    this[field]?.let { requiredObjectField(field, errorKind) }

private fun JsonObject.optionalArrayField(field: String, errorKind: String): JsonArray? =
    this[field]?.let { requiredArrayField(field, errorKind) }

private fun JsonObject.optionalNumber(field: String, errorKind: String): Double? =
    this[field]?.let { element ->
        (element as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            ?: invalid(errorKind, "$field must be a number")
    }

private val ISO_8601_TIMESTAMP = Regex("""^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$""")

private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L
private const val MAX_INPUT_EXCERPT_LENGTH = 600

private val INPUT_KINDS = setOf("prompt", "steer", "notification")
internal val TRANSIENT_EVENT_KINDS = setOf(
    "model_text_delta",
    "model_tool_call_start",
    "model_tool_call_delta",
    "model_tool_call_end",
    "tool_output_delta",
    "child_agent_started",
)
private val TRANSIENT_OUTPUT_STREAMS = setOf("stdout", "stderr")
private val INPUT_STATUSES = setOf("queued", "consumed", "cancelled", "failed")
private val RUN_STATUSES = setOf("running", "completed", "failed", "cancelled")
private val RUN_PHASES = setOf("thinking", "tool_execution", "waiting_for_approval", "waiting_for_user")
private val MESSAGE_ROLES = setOf("user", "assistant")
private val CONTENT_BLOCK_TYPES = setOf("text", "file_reference")
private val TOOL_CALL_STATUSES = setOf("requested", "awaiting_approval", "running", "completed", "failed", "denied")
private val APPROVAL_SUBJECT_TYPES = setOf("tool_call", "command")
private val APPROVAL_OPTION_OUTCOMES = setOf("approve_once", "deny")
private val INTERACTION_KINDS = setOf("tool_approval", "ask_user")
private val INTERACTION_OUTCOMES = setOf("approved", "denied", "answered", "chat", "declined", "expired")
private val INTERACTION_RESOLVER_KINDS = setOf("client", "guardian", "system")
private val INTERACTION_OWNERS = setOf("user", "guardian")
private val ASK_USER_INPUT_MODES = setOf("selection", "text", "form")
private val PUBLIC_CLIENT_KINDS = setOf("tui", "web", "mobile", "desktop", "acp", "script", "unknown")
private val PUBLIC_PERMISSION_MODES = setOf("manual", "accept-edits", "plan", "full-access", "auto")
private val PLAN_STATUSES = setOf("proposed", "active", "completed", "abandoned")
private val PLAN_STEP_STATUSES = setOf("pending", "blocked", "ready")
private val TASK_KINDS = setOf("agent", "shell", "user_shell")
private val TASK_STATUSES = setOf("queued", "running", "completed", "failed", "cancelled")
