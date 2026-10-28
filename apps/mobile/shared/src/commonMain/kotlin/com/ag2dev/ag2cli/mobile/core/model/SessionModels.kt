package com.ag2dev.ag2cli.mobile.core.model

import kotlinx.serialization.Serializable

/** Opaque local key for a saved server profile; it is not the server's wire identity. */
@Serializable
@JvmInline
value class ServerProfileKey(val value: String) {
    init {
        require(value.isNotBlank()) { "Server profile key must not be blank" }
    }
}

/** Session IDs are only unique within a server profile. */
@Serializable
data class SessionKey(
    val serverProfileKey: ServerProfileKey,
    val sessionId: String,
) {
    init {
        require(sessionId.isNotBlank()) { "Session ID must not be blank" }
    }
}

/** Approval IDs are only unique within a server profile. */
@Serializable
data class ApprovalKey(
    val serverProfileKey: ServerProfileKey,
    val approvalId: String,
) {
    init {
        require(approvalId.isNotBlank()) { "Approval ID must not be blank" }
    }
}

data class SessionSummary(
    val id: String,
    val title: String,
    val workspace: String,
    val updated: String,
    val preview: String,
    val status: SessionStatus,
)

enum class SessionStatus {
    RUNNING,
    WAITING_APPROVAL,
    COMPLETED,
    FAILED,
    UNKNOWN,
}

data class ApprovalSummary(
    val id: String,
    val sessionId: String,
    val tool: String,
    val path: String,
    val reason: String,
    val addedLine: String,
    val removedLine: String,
)
