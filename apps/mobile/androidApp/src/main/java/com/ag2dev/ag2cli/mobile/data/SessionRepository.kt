package com.ag2dev.ag2cli.mobile.data

import android.content.res.Resources
import com.ag2dev.ag2cli.mobile.R
import com.ag2dev.ag2cli.mobile.core.model.ApprovalKey
import com.ag2dev.ag2cli.mobile.core.model.ApprovalSummary
import com.ag2dev.ag2cli.mobile.core.model.ServerProfileKey
import com.ag2dev.ag2cli.mobile.core.model.SessionKey
import com.ag2dev.ag2cli.mobile.core.model.SessionStatus
import com.ag2dev.ag2cli.mobile.core.model.SessionSummary

data class SessionTimelineMessage(
    val id: Long,
    val author: String,
    val time: String,
    val text: String,
    val fromUser: Boolean,
)

/** Product-level actions exposed to the UI, independent of App Server method names. */
data class SessionCapabilities(
    val canSubmit: Boolean = false,
    val canCancel: Boolean = false,
)

interface SessionRepository {
    fun sessions(serverProfileKey: ServerProfileKey): List<SessionSummary>
    fun session(key: SessionKey): SessionSummary?
    fun timeline(key: SessionKey): List<SessionTimelineMessage>
    fun sessionCapabilities(key: SessionKey): SessionCapabilities
    fun pendingApprovals(serverProfileKey: ServerProfileKey): List<ApprovalSummary>
    fun approval(key: ApprovalKey): ApprovalSummary?
}

val DEMO_SERVER_PROFILE_KEY = ServerProfileKey("demo-server")

class DemoSessionRepository(private val resources: Resources) : SessionRepository {
    private val sessionRecords = listOf(
        SessionSummary(
            id = "session-mobile-prototype",
            title = resources.getString(R.string.demo_session_mobile_title),
            workspace = resources.getString(R.string.demo_workspace),
            updated = resources.getString(R.string.demo_session_mobile_updated),
            preview = resources.getString(R.string.demo_session_mobile_preview),
            status = SessionStatus.WAITING_APPROVAL,
        ),
        SessionSummary(
            id = "session-protocol-recovery",
            title = resources.getString(R.string.demo_session_recovery_title),
            workspace = resources.getString(R.string.demo_workspace),
            updated = resources.getString(R.string.demo_session_recovery_updated),
            preview = resources.getString(R.string.demo_session_recovery_preview),
            status = SessionStatus.RUNNING,
        ),
        SessionSummary(
            id = "session-adaptive-layout",
            title = resources.getString(R.string.demo_session_adaptive_title),
            workspace = resources.getString(R.string.demo_workspace),
            updated = resources.getString(R.string.demo_session_yesterday),
            preview = resources.getString(R.string.demo_session_adaptive_preview),
            status = SessionStatus.COMPLETED,
        ),
        SessionSummary(
            id = SUBMIT_ONLY_SESSION_ID,
            title = resources.getString(R.string.demo_session_submit_only_title),
            workspace = resources.getString(R.string.demo_workspace),
            updated = resources.getString(R.string.demo_session_yesterday),
            preview = resources.getString(R.string.demo_session_submit_only_preview),
            status = SessionStatus.COMPLETED,
        ),
        SessionSummary(
            id = "session-tooling-error",
            title = resources.getString(R.string.demo_session_tooling_title),
            workspace = resources.getString(R.string.demo_workspace),
            updated = resources.getString(R.string.demo_session_yesterday),
            preview = resources.getString(R.string.demo_session_tooling_preview),
            status = SessionStatus.FAILED,
        ),
        SessionSummary(
            id = "session-unknown-state",
            title = resources.getString(R.string.demo_session_unknown_title),
            workspace = resources.getString(R.string.demo_workspace),
            updated = resources.getString(R.string.demo_session_two_days),
            preview = resources.getString(R.string.demo_session_unknown_preview),
            status = SessionStatus.UNKNOWN,
        ),
    )

    private val approvalRecords = listOf(
        ApprovalSummary(
            id = "approval-android-manifest",
            sessionId = "session-mobile-prototype",
            tool = "apply_patch",
            path = "apps/mobile/androidApp/src/main/AndroidManifest.xml",
            reason = resources.getString(R.string.demo_approval_reason),
            addedLine = resources.getString(R.string.demo_approval_added_line),
            removedLine = "",
        ),
    )

    private val longHistory by lazy {
        val userLabel = resources.getString(R.string.sample_author_user)
        val agentLabel = resources.getString(R.string.sample_author_agent)
        val userTime = resources.getString(R.string.sample_time_user)
        val agentTime = resources.getString(R.string.sample_time_agent)
        val archivedEvent = resources.getString(R.string.demo_history_event)
        val latestEvent = resources.getString(R.string.demo_history_last_event)
        List(LONG_HISTORY_SIZE) { index ->
            SessionTimelineMessage(
                id = index.toLong() + 1,
                author = if (index % 2 == 0) userLabel else agentLabel,
                time = if (index % 2 == 0) userTime else agentTime,
                text = if (index == LONG_HISTORY_SIZE - 1) latestEvent else archivedEvent,
                fromUser = index % 2 == 0,
            )
        }
    }

    override fun sessions(serverProfileKey: ServerProfileKey): List<SessionSummary> =
        if (serverProfileKey == DEMO_SERVER_PROFILE_KEY) sessionRecords else emptyList()

    override fun session(key: SessionKey): SessionSummary? =
        if (key.serverProfileKey == DEMO_SERVER_PROFILE_KEY) {
            sessionRecords.firstOrNull { it.id == key.sessionId }
        } else {
            null
        }

    override fun timeline(key: SessionKey): List<SessionTimelineMessage> {
        if (key.serverProfileKey != DEMO_SERVER_PROFILE_KEY) return emptyList()
        return if (key.sessionId == LONG_HISTORY_SESSION_ID) {
            longHistory
        } else {
            listOf(
                SessionTimelineMessage(
                    id = 1,
                    author = resources.getString(R.string.sample_author_user),
                    time = resources.getString(R.string.sample_time_user),
                    text = resources.getString(R.string.sample_user_prompt),
                    fromUser = true,
                ),
                SessionTimelineMessage(
                    id = 2,
                    author = resources.getString(R.string.sample_author_agent),
                    time = resources.getString(R.string.sample_time_agent),
                    text = session(key)?.preview.orEmpty(),
                    fromUser = false,
                ),
            )
        }
    }

    override fun sessionCapabilities(key: SessionKey): SessionCapabilities {
        if (key.serverProfileKey != DEMO_SERVER_PROFILE_KEY) return SessionCapabilities()
        return when (key.sessionId) {
            LONG_HISTORY_SESSION_ID -> SessionCapabilities(canSubmit = true, canCancel = true)
            SUBMIT_ONLY_SESSION_ID -> SessionCapabilities(canSubmit = true)
            else -> SessionCapabilities()
        }
    }

    override fun pendingApprovals(serverProfileKey: ServerProfileKey): List<ApprovalSummary> =
        if (serverProfileKey == DEMO_SERVER_PROFILE_KEY) approvalRecords else emptyList()

    override fun approval(key: ApprovalKey): ApprovalSummary? =
        if (key.serverProfileKey == DEMO_SERVER_PROFILE_KEY) {
            approvalRecords.firstOrNull { it.id == key.approvalId }
        } else {
            null
        }

    private companion object {
        const val LONG_HISTORY_SESSION_ID = "session-protocol-recovery"
        const val SUBMIT_ONLY_SESSION_ID = "session-submit-only"
        const val LONG_HISTORY_SIZE = 1_000
    }
}

enum class ConnectionPreviewState {
    CONNECTED,
    CONNECTING,
    REPLAYING,
    OFFLINE,
}
