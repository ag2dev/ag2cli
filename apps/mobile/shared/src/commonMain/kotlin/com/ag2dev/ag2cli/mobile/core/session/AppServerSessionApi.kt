package com.ag2dev.ag2cli.mobile.core.session

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerNotification
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcClientState
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcClient
import com.ag2dev.ag2cli.mobile.core.protocol.MobileAppServerOperation
import com.ag2dev.ag2cli.mobile.core.protocol.ServerInitializeResult
import com.ag2dev.ag2cli.mobile.core.protocol.allows
import com.ag2dev.ag2cli.mobile.core.protocol.appServerJson
import com.ag2dev.ag2cli.mobile.core.protocol.jsonParams
import com.ag2dev.ag2cli.mobile.core.protocol.requiredLong
import com.ag2dev.ag2cli.mobile.core.protocol.requiredString
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerWorkspace
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

data class AppServerSessionWorkspace(
    val workspaceId: String,
    val displayName: String,
    val availability: String,
)

data class AppServerSessionRecord(
    val sessionId: String,
    val title: String?,
    val status: String,
    val workspace: AppServerSessionWorkspace,
    val updatedAt: String,
    val archivedAt: String?,
)

data class AppServerSessionSnapshotResult(
    val sessionId: String,
    val snapshot: JsonObject,
)

data class AppServerSessionArchiveResult(
    val sessionId: String,
    val archivedAt: String,
)

data class AppServerSessionDeleteResult(
    val sessionId: String,
)

data class AppServerPresenceClient(
    val clientId: String,
    val clientKind: String,
    val name: String,
    val version: String,
)

data class AppServerInteractionLeaseHolder(
    val clientId: String,
    val clientKind: String,
    val name: String,
)

data class AppServerInteractionLease(
    val status: LeaseStatus,
    val generation: Long,
    val holder: AppServerInteractionLeaseHolder? = null,
    val expiresAt: String? = null,
)

enum class LeaseStatus {
    AVAILABLE,
    HELD,
}

enum class SessionInteractionLeaseScope(val wireName: String) {
    COMPOSER("composer"),
    SESSION_CONTROL("session-control"),
}

data class AppServerInteractionLeases(
    val composer: AppServerInteractionLease,
    val sessionControl: AppServerInteractionLease,
) {
    operator fun get(scope: SessionInteractionLeaseScope): AppServerInteractionLease = when (scope) {
        SessionInteractionLeaseScope.COMPOSER -> composer
        SessionInteractionLeaseScope.SESSION_CONTROL -> sessionControl
    }
}

data class AppServerSessionPresence(
    val clients: List<AppServerPresenceClient>,
    val leases: AppServerInteractionLeases,
)

data class AppServerPresenceUpdate(
    val sessionId: String,
    val clients: List<AppServerPresenceClient>,
    val leases: AppServerInteractionLeases,
)

data class AppServerInteractionLeaseUpdate(
    val sessionId: String,
    val leases: AppServerInteractionLeases,
)

data class AppServerSessionAttachResult(
    val sessionId: String,
    val snapshot: JsonObject,
    /** Revision barrier the subscription starts delivering after; equals snapshot.asOfRevision. */
    val barrierRevision: Long,
)

data class AppServerSessionDetachResult(
    val sessionId: String,
    val detached: Boolean,
)

data class AppServerSessionReplayPage(
    val events: List<JsonObject>,
    val scannedThroughRevision: Long,
    /** Continuation cursor; present exactly when [hasMore] is true. */
    val nextAfterRevision: Long?,
    val hasMore: Boolean,
)

data class AppServerSessionSubmitLease(
    val composerGeneration: Long? = null,
    val sessionControlGeneration: Long? = null,
)

data class AppServerRunCancellationResult(
    val requested: Boolean,
    val state: String,
)

data class AppServerInputAdmissionResult(
    val sessionId: String,
    val commandId: String,
    val inputId: String,
    val queued: Boolean,
)

data class AppServerCancellationResult(
    val requested: Boolean,
    val state: String,
)

data class AppServerMessagesPage(
    val messages: List<JsonObject>,
    /** Oldest messageId of the page; present exactly when older messages remain. */
    val nextBefore: String?,
)

data class AppServerSessionResolveInteractionResult(
    val interactionId: String,
    val kind: String,
    /** Raw resolution document: known fields are validated, unknown fields pass through. */
    val resolution: JsonObject,
)

/** Typed mirror of the resolveInteraction params union: the two kinds share
 * only the envelope fields, payload fields are never shared. */
sealed interface SessionInteractionResolutionRequest {
    val resolutionId: String
    val interactionId: String

    data class ToolApproval(
        override val resolutionId: String,
        override val interactionId: String,
        val optionId: String,
        val expectedPolicyRevision: Long? = null,
        val expectedScopeRevision: Long? = null,
    ) : SessionInteractionResolutionRequest

    data class AskUser(
        override val resolutionId: String,
        override val interactionId: String,
        val answer: SessionAskUserAnswer,
    ) : SessionInteractionResolutionRequest
}

/** ask_user answers discriminate on `outcome`; only "answered" carries per-question payload. */
sealed interface SessionAskUserAnswer {
    data class Answered(
        val answers: List<SessionAskUserSelection>,
        val freeText: List<SessionAskUserFreeText>? = null,
    ) : SessionAskUserAnswer

    data object Chat : SessionAskUserAnswer

    data object Declined : SessionAskUserAnswer
}

data class SessionAskUserSelection(
    val questionId: String,
    val selectedOptionIds: List<String>,
)

data class SessionAskUserFreeText(
    val questionId: String,
    val text: String,
)

data class AppServerPermissionPolicy(
    val sessionId: String,
    val mode: String,
    val policyRevision: Long,
    /** Raw rule bodies; the strict {name, behavior} envelope is validated, contents pass through. */
    val rules: List<JsonObject>,
    val selectableModes: List<String>,
)

/** Request-side rule envelope for `session.setPermissionRules`. */
data class SessionPermissionRuleRequest(
    val name: String,
    val behavior: String,
)

/** `session.plan` admission result: the plan and snapshot documents stay
 * opaque because the public wire contract defines no result schema for this
 * face, so callers consume the documents themselves. */
data class SessionPlanAdmissionResult(
    val sessionId: String,
    val commandId: String,
    val result: JsonElement,
    val snapshot: JsonElement,
)

data class AppServerWorkspaceDiffResult(
    val sessionId: String,
    val workspaceId: String,
    val snapshotToken: String,
    /** Raw {head?, indexTree?, workingTreeDigest} state document. */
    val asOf: JsonObject,
    /** Raw change entries; the strict envelope and enums are validated, contents pass through. */
    val changes: List<JsonObject>,
    val nextCursor: String?,
)

data class AppServerWorkspaceReadFileResult(
    val sessionId: String,
    val workspaceId: String,
    val path: String,
    val kind: String,
    val content: String?,
    val encoding: String?,
    val sizeBytes: Long,
    val digest: String,
    val startLine: Long?,
    val totalLines: Long?,
    val nextStartLine: Long?,
)

data class AppServerPublicTaskSummary(
    val taskId: String,
    val kind: String,
    val status: String,
    val updatedAt: String,
    /** Raw document; unknown fields pass through like the TypeScript parser. */
    val raw: JsonObject,
)

data class AppServerSessionCreateTaskResult(
    val sessionId: String,
    val commandId: String,
    val task: AppServerPublicTaskSummary,
    val queued: Boolean,
)

data class AppServerSessionListTasksResult(
    val sessionId: String,
    val tasks: List<AppServerPublicTaskSummary>,
)

data class AppServerSessionCancelTaskResult(
    val cancelled: Boolean,
    val sessionId: String,
    val taskId: String,
    val task: AppServerPublicTaskSummary,
)

data class AppServerTaskLogChunk(
    val sequence: Long,
    val text: String,
)

data class AppServerSessionTaskLogsPage(
    val sessionId: String,
    val taskId: String,
    val status: String,
    val outputBytes: Long,
    val chunks: List<AppServerTaskLogChunk>,
    /** Continuation cursor; present exactly when more chunks remain. */
    val nextAfterSequence: Long?,
)

data class AppServerShellTaskAdmissionResult(
    val sessionId: String,
    val commandId: String,
    val taskId: String,
    val queued: Boolean,
)

data class AppServerSessionCompactResult(
    val sessionId: String,
    val commandId: String,
    val changed: Boolean,
    val inputMessageCount: Long,
    val outputMessageCount: Long,
    val inputTokens: Long?,
)

data class AppServerSessionAddDirectoryResult(
    val sessionId: String,
    val commandId: String,
    val changed: Boolean,
    val directory: String,
    val additionalDirectories: List<String>,
    val scopeRevision: Long,
    val scopeDigest: String?,
)

data class AppServerSessionContextWindowResult(
    val sessionId: String,
    val commandId: String,
    val changed: Boolean,
    val contextWindowOverride: Long?,
)

data class AppServerSessionSelectAgentResult(
    val sessionId: String,
    val commandId: String,
    val changed: Boolean,
    val agentName: String?,
)

data class AppServerPublicGoal(
    val status: String,
    val text: String?,
)

data class AppServerSessionUpdateGoalResult(
    val sessionId: String,
    val commandId: String,
    val changed: Boolean,
    val goal: AppServerPublicGoal,
)

data class AppServerPublicCheckpoint(
    val checkpointId: String,
    val kind: String,
    val headRevision: Long,
    val generation: Long,
    val createdAt: String,
)

data class AppServerSessionCheckpointsResult(
    val sessionId: String,
    val checkpoints: List<AppServerPublicCheckpoint>,
)

data class AppServerSessionPreviewRewindResult(
    val sessionId: String,
    val checkpoint: AppServerPublicCheckpoint,
    val currentRevision: Long,
    val currentGeneration: Long,
    val staleRevision: Boolean,
    val canCommit: Boolean,
)

data class AppServerSessionRewindResult(
    val sessionId: String,
    val commandId: String,
    val status: String,
    val rewindId: String,
    val error: String?,
)

/** Typed access to the Session methods supported by the mobile client. */
class AppServerSessionApi(
    private val rpc: AppServerRpcClient,
    private val initialize: ServerInitializeResult,
) {
    // A degraded Session keeps its readable, live stream but refuses writes.
    // Degradation is orthogonal to needsResync: resync is the recovery path,
    // so read and recovery faces stay available while the registry holds a Session.
    private val degradedSessions = mutableSetOf<String>()

    internal fun markSessionDegraded(sessionId: String) {
        degradedSessions += sessionId
    }

    internal fun clearSessionDegraded(sessionId: String) {
        degradedSessions -= sessionId
    }

    private fun requireSessionWritable(sessionId: String) {
        if (sessionId in degradedSessions) {
            throw AppServerProtocolException(
                "unsupported_event",
                "Session writes are refused with unsupported_event until a clean rebuild restores this Session",
            )
        }
    }

    val rpcState: StateFlow<AppServerRpcClientState> = rpc.state

    val notifications = rpc.notifications

    val workspaces: List<AppServerWorkspace>
        get() = initialize.host?.workspaces.orEmpty()

    fun decodePresenceUpdate(value: JsonElement): AppServerPresenceUpdate = decodePresenceUpdatedNotification(value)

    fun decodeInteractionLeaseUpdate(value: JsonElement): AppServerInteractionLeaseUpdate = decodeInteractionLeaseUpdatedNotification(value)

    suspend fun listSessions(workspaceId: String? = null): List<AppServerSessionRecord> {
        requireAllowed(MobileAppServerOperation.SESSION_LIST)
        workspaceId?.let { requireWireString(it, "workspaceId") }
        val value = rpc.request("session.list", jsonParams {
            workspaceId?.let { put("workspaceId", it) }
        })
        return decodeSessionListResult(value)
    }

    suspend fun getSession(sessionId: String): AppServerSessionRecord {
        requireAllowed(MobileAppServerOperation.SESSION_GET)
        requireWireString(sessionId, "sessionId")
        val value = rpc.request("session.get", jsonParams {
            put("sessionId", sessionId)
        })
        return decodeSessionGetResult(value, sessionId)
    }

    /** `session.create` is idempotent per (sessionId, payload): a replay of the same request
     * returns the canonical session, so a retry after an ambiguous failure is safe. */
    suspend fun createSession(
        sessionId: String,
        workspaceId: String,
        title: String? = null,
    ): AppServerSessionSnapshotResult {
        requireAllowed(MobileAppServerOperation.SESSION_CREATE)
        requireWireString(sessionId, "sessionId")
        requireWireString(workspaceId, "workspaceId")
        title?.let { requireWireString(it, "title") }
        val value = rpc.request("session.create", jsonParams {
            put("sessionId", sessionId)
            put("workspaceId", workspaceId)
            title?.let { put("title", it) }
        })
        return decodeSessionSnapshotResult(value, sessionId)
    }

    /**
     * Cursor-less attach: the result installs the subscription behind
     * [AppServerSessionAttachResult.barrierRevision]; catch-up rides `replaySession` pages.
     */
    suspend fun attachSession(
        sessionId: String,
        includeRecentMessages: Long? = null,
    ): AppServerSessionAttachResult {
        requireAllowed(MobileAppServerOperation.SESSION_ATTACH)
        requireWireString(sessionId, "sessionId")
        includeRecentMessages?.let {
            if (it < 1 || it > 100) {
                throw AppServerProtocolException("invalid_params", "includeRecentMessages must be between 1 and 100")
            }
        }
        val value = try {
            rpc.request("session.attach", jsonParams {
                put("sessionId", sessionId)
                includeRecentMessages?.let { put("includeRecentMessages", it) }
            })
        } catch (error: AppServerRpcException) {
            // A JSON-RPC error is a definite rejection; detach could remove a prior subscription.
            throw error
        } catch (error: Exception) {
            detachAfterUncertainAttach(sessionId)
            throw error
        }
        return try {
            // A successful response may have installed a subscription even when its payload is bad.
            decodeSessionAttachResult(value, sessionId)
        } catch (error: Exception) {
            detachAfterUncertainAttach(sessionId)
            throw error
        }
    }

    suspend fun detachSession(sessionId: String): Boolean {
        requireAllowed(MobileAppServerOperation.SESSION_DETACH)
        requireWireString(sessionId, "sessionId")
        return decodeSessionDetachResult(rpc.request("session.detach", jsonParams { put("sessionId", sessionId) }), sessionId).detached
    }

    /** One `session.replay` page strictly after [afterRevision]; the caller drives paging via
     * [AppServerSessionReplayPage.nextAfterRevision] while [AppServerSessionReplayPage.hasMore] holds. */
    suspend fun replaySession(
        sessionId: String,
        afterRevision: Long = 0,
        limit: Long? = null,
    ): AppServerSessionReplayPage {
        requireAllowed(MobileAppServerOperation.SESSION_REPLAY)
        requireWireString(sessionId, "sessionId")
        requireRevision(afterRevision, "afterRevision")
        limit?.let { requireRevision(it, "limit") }
        val page = decodeSessionReplayResult(
            rpc.request("session.replay", jsonParams {
                put("sessionId", sessionId)
                put("afterRevision", afterRevision)
                limit?.let { put("limit", it) }
            }),
            sessionId,
        )
        page.events.forEach { event ->
            if (event.requiredLong("revision") <= afterRevision) {
                invalidResult("session.replay returned an event at or before its cursor")
            }
        }
        return page
    }

    suspend fun resyncSession(sessionId: String): AppServerSessionSnapshotResult {
        requireAllowed(MobileAppServerOperation.SESSION_RESYNC)
        requireWireString(sessionId, "sessionId")
        return decodeSessionSnapshotDocumentResult(
            rpc.request("session.resync", jsonParams { put("sessionId", sessionId) }),
            sessionId,
        )
    }

    /** Keeps the supplied commandId unchanged so a caller can reconcile an ambiguous submit. */
    suspend fun submit(
        sessionId: String,
        commandId: String,
        text: String,
        lease: AppServerSessionSubmitLease = AppServerSessionSubmitLease(),
        expectedRevision: Long? = null,
        workspace: String? = null,
        context: List<String>? = null,
        fileReferences: List<String>? = null,
    ): AppServerInputAdmissionResult {
        requireAllowed(MobileAppServerOperation.SESSION_SUBMIT)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requireWireString(commandId, "commandId")
        requireWireString(text, "text")
        expectedRevision?.let { requireRevision(it, "expectedRevision") }
        workspace?.let { requireWireString(it, "workspace") }
        listOfNotNull(lease.composerGeneration, lease.sessionControlGeneration).forEach {
            requireRevision(it, "lease generation")
        }
        val result = rpc.request("session.submit", jsonParams {
            put("sessionId", sessionId)
            put("commandId", commandId)
            put("text", text)
            expectedRevision?.let { put("expectedRevision", it) }
            workspace?.let { put("workspace", it) }
            context?.let { put("context", JsonArray(it.map(::JsonPrimitive))) }
            fileReferences?.let { put("fileReferences", JsonArray(it.map(::JsonPrimitive))) }
            if (lease.composerGeneration != null || lease.sessionControlGeneration != null) {
                putJsonObject("lease") {
                    lease.composerGeneration?.let { put("composer", it) }
                    lease.sessionControlGeneration?.let { put("session-control", it) }
                }
            }
        })
        val admission = decodeSessionSubmitResult(result, sessionId)
        if (admission.commandId != commandId) {
            invalidResult("session.submit returned a different command identity")
        }
        return admission
    }

    /** Steer appends to a running run's input queue; a dead target surfaces as
     * the server's `run_not_active` error, and falling back to submit is a
     * caller policy, not a shared-layer one. */
    suspend fun steer(
        sessionId: String,
        runId: String,
        commandId: String,
        text: String,
    ): AppServerInputAdmissionResult {
        requireAllowed(MobileAppServerOperation.SESSION_STEER)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requireWireString(runId, "runId")
        requireWireString(commandId, "commandId")
        requireWireString(text, "text")
        val admission = decodeSessionSteerResult(
            rpc.request("session.steer", jsonParams {
                put("sessionId", sessionId)
                put("runId", runId)
                put("commandId", commandId)
                put("text", text)
            }),
            sessionId,
        )
        if (admission.commandId != commandId) {
            invalidResult("session.steer returned a different command identity")
        }
        return admission
    }

    /** Cancellation is a convergent fact, never an error: terminal and unknown
     * runs are reported through `state`; the terminal fact itself arrives as a
     * durable `run.updated` event. */
    suspend fun cancelRun(
        sessionId: String,
        runId: String,
    ): AppServerRunCancellationResult {
        requireAllowed(MobileAppServerOperation.SESSION_CANCEL_RUN)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requireWireString(runId, "runId")
        val result = rpc.request("session.cancelRun", jsonParams {
            put("sessionId", sessionId)
            put("runId", runId)
        }).requireObject("session.cancelRun result")
        val requested = result.requiredBoolean("requested")
        val state = result.requiredString("state")
        if (state !in RUN_CANCELLATION_STATES) invalidResult("session.cancelRun returned an unknown state")
        if (requested != (state == "requested")) invalidResult("session.cancelRun result contradicts the requested invariant")
        return AppServerRunCancellationResult(
            requested = requested,
            state = state,
        )
    }

    /** Cancelling a mailbox input converges the same way run cancellation
     * does: terminal and unknown inputs come back through `state`, never as
     * errors. */
    suspend fun cancelInput(
        sessionId: String,
        inputId: String,
    ): AppServerCancellationResult {
        requireAllowed(MobileAppServerOperation.SESSION_CANCEL_INPUT)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requireWireString(inputId, "inputId")
        return decodeSessionCancellationResult(
            rpc.request("session.cancelInput", jsonParams {
                put("sessionId", sessionId)
                put("inputId", inputId)
            }),
            "session.cancelInput",
        )
    }

    /** The result only confirms the write; the pending card leaves the
     * projection through the durable `interaction.resolved` event that follows. */
    suspend fun resolveInteraction(
        sessionId: String,
        resolution: SessionInteractionResolutionRequest,
    ): AppServerSessionResolveInteractionResult {
        requireAllowed(MobileAppServerOperation.SESSION_RESOLVE_INTERACTION)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requireWireString(resolution.resolutionId, "resolutionId")
        requireWireString(resolution.interactionId, "interactionId")
        val wireKind = when (resolution) {
            is SessionInteractionResolutionRequest.ToolApproval -> {
                requireWireString(resolution.optionId, "optionId")
                resolution.expectedPolicyRevision?.let { requireRevision(it, "expectedPolicyRevision") }
                resolution.expectedScopeRevision?.let { requireRevision(it, "expectedScopeRevision") }
                "tool_approval"
            }
            is SessionInteractionResolutionRequest.AskUser -> {
                validateAskUserAnswer(resolution.answer)
                "ask_user"
            }
        }
        val result = decodeSessionResolveInteractionResult(
            rpc.request("session.resolveInteraction", jsonParams {
                put("sessionId", sessionId)
                put("resolutionId", resolution.resolutionId)
                put("kind", wireKind)
                put("interactionId", resolution.interactionId)
                when (resolution) {
                    is SessionInteractionResolutionRequest.ToolApproval -> {
                        put("optionId", resolution.optionId)
                        resolution.expectedPolicyRevision?.let { put("expectedPolicyRevision", it) }
                        resolution.expectedScopeRevision?.let { put("expectedScopeRevision", it) }
                    }
                    is SessionInteractionResolutionRequest.AskUser -> put("answer", encodeAskUserAnswer(resolution.answer))
                }
            }),
        )
        if (result.interactionId != resolution.interactionId || result.kind != wireKind) {
            invalidResult("session.resolveInteraction returned a different interaction identity")
        }
        return result
    }

    /** Rules travel only through this face, never through the snapshot projection. */
    suspend fun getPermissionPolicy(sessionId: String): AppServerPermissionPolicy {
        requireAllowed(MobileAppServerOperation.SESSION_GET_PERMISSION_POLICY)
        requireWireString(sessionId, "sessionId")
        return decodeSessionPermissionPolicyResult(
            rpc.request("session.getPermissionPolicy", jsonParams { put("sessionId", sessionId) }),
            sessionId,
        )
    }

    /** Policy writes are CAS writes: the session-control lease plus the last
     * seen policyRevision; the result carries the next revision to write against. */
    suspend fun setPermissionMode(
        sessionId: String,
        mode: String,
        expectedPolicyRevision: Long,
        leaseGeneration: Long,
    ): AppServerPermissionPolicy {
        requireAllowed(MobileAppServerOperation.SESSION_SET_PERMISSION_MODE)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requirePermissionMode(mode)
        requireRevision(expectedPolicyRevision, "expectedPolicyRevision")
        requireSessionControlGeneration(leaseGeneration)
        val policy = decodeSessionPermissionPolicyResult(
            rpc.request("session.setPermissionMode", jsonParams {
                put("sessionId", sessionId)
                put("mode", mode)
                put("expectedPolicyRevision", expectedPolicyRevision)
                putSessionControlLease(leaseGeneration)
            }),
            sessionId,
        )
        if (policy.mode != mode) {
            invalidResult("session.setPermissionMode returned a different mode")
        }
        return policy
    }

    suspend fun setPermissionRules(
        sessionId: String,
        rules: List<SessionPermissionRuleRequest>,
        expectedPolicyRevision: Long,
        leaseGeneration: Long,
    ): AppServerPermissionPolicy {
        requireAllowed(MobileAppServerOperation.SESSION_SET_PERMISSION_RULES)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        rules.forEach { rule ->
            requireWireString(rule.name, "rules.name")
            if (rule.behavior !in PERMISSION_RULE_BEHAVIORS) {
                throw AppServerProtocolException(
                    "invalid_params",
                    "rules.behavior must be one of: ${PERMISSION_RULE_BEHAVIORS.joinToString()}",
                )
            }
        }
        requireRevision(expectedPolicyRevision, "expectedPolicyRevision")
        requireSessionControlGeneration(leaseGeneration)
        return decodeSessionPermissionPolicyResult(
            rpc.request("session.setPermissionRules", jsonParams {
                put("sessionId", sessionId)
                put(
                    "rules",
                    JsonArray(
                        rules.map { rule ->
                            buildJsonObject {
                                put("name", rule.name)
                                put("behavior", rule.behavior)
                            }
                        },
                    ),
                )
                put("expectedPolicyRevision", expectedPolicyRevision)
                putSessionControlLease(leaseGeneration)
            }),
            sessionId,
        )
    }

    /** The composer lease guards this write; the admission envelope comes back
     * strictly decoded while the plan and snapshot documents pass through
     * opaque, because the wire contract pins no typed result for this face. */
    suspend fun plan(
        sessionId: String,
        commandId: String,
        text: String,
        context: List<String>? = null,
        workspace: String? = null,
        expectedRevision: Long? = null,
        leaseGeneration: Long? = null,
    ): SessionPlanAdmissionResult {
        requireAllowed(MobileAppServerOperation.SESSION_PLAN)
        requireSessionWritable(sessionId)
        requireWireString(sessionId, "sessionId")
        requireWireString(commandId, "commandId")
        requireWireString(text, "text")
        workspace?.let { requireWireString(it, "workspace") }
        expectedRevision?.let { requireRevision(it, "expectedRevision") }
        leaseGeneration?.let { requireRevision(it, "lease generation") }
        return decodeSessionPlanResult(
            rpc.request("session.plan", jsonParams {
                put("sessionId", sessionId)
                put("commandId", commandId)
                put("text", text)
                context?.let { put("context", JsonArray(it.map(::JsonPrimitive))) }
                workspace?.let { put("workspace", it) }
                expectedRevision?.let { put("expectedRevision", it) }
                leaseGeneration?.let { putComposerLease(it) }
            }),
            sessionId,
            commandId,
        )
    }

    /** One `workspace.diff` page; the caller pages through
     * [AppServerWorkspaceDiffResult.nextCursor] while it is present. */
    suspend fun workspaceDiff(
        sessionId: String,
        cursor: String? = null,
        limit: Long? = null,
        includePatch: Boolean? = null,
    ): AppServerWorkspaceDiffResult {
        requireAllowed(MobileAppServerOperation.WORKSPACE_DIFF)
        requireWireString(sessionId, "sessionId")
        cursor?.let { requireWireString(it, "cursor") }
        limit?.let { requirePositiveInteger(it, "limit") }
        return decodeWorkspaceDiffResult(
            rpc.request("workspace.diff", jsonParams {
                put("sessionId", sessionId)
                cursor?.let { put("cursor", it) }
                limit?.let { put("limit", it) }
                includePatch?.let { put("includePatch", it) }
            }),
            sessionId,
        )
    }

    suspend fun workspaceReadFile(
        sessionId: String,
        path: String,
        startLine: Long? = null,
        maxLines: Long? = null,
        expectedDigest: String? = null,
    ): AppServerWorkspaceReadFileResult {
        requireAllowed(MobileAppServerOperation.WORKSPACE_READ_FILE)
        requireWireString(sessionId, "sessionId")
        requireWireString(path, "path")
        startLine?.let { requirePositiveInteger(it, "startLine") }
        maxLines?.let { requirePositiveInteger(it, "maxLines") }
        expectedDigest?.let { requireWireString(it, "expectedDigest") }
        val result = decodeWorkspaceReadFileResult(
            rpc.request("workspace.readFile", jsonParams {
                put("sessionId", sessionId)
                put("path", path)
                startLine?.let { put("startLine", it) }
                maxLines?.let { put("maxLines", it) }
                expectedDigest?.let { put("expectedDigest", it) }
            }),
            sessionId,
        )
        if (result.path != path) {
            invalidResult("workspace.readFile returned a different path")
        }
        return result
    }

    suspend fun acquireLease(
        sessionId: String,
        scope: SessionInteractionLeaseScope,
        ttlMs: Long? = null,
    ): AppServerInteractionLease {
        requireAllowed(MobileAppServerOperation.INTERACTION_ACQUIRE)
        return interactionLeaseRequest("interaction.acquire", sessionId, scope, ttlMs = ttlMs)
    }

    suspend fun renewLease(
        sessionId: String,
        scope: SessionInteractionLeaseScope,
        generation: Long,
        ttlMs: Long? = null,
    ): AppServerInteractionLease {
        requireAllowed(MobileAppServerOperation.INTERACTION_RENEW)
        requireRevision(generation, "leaseGeneration")
        return interactionLeaseRequest("interaction.renew", sessionId, scope, generation, ttlMs)
    }

    suspend fun releaseLease(
        sessionId: String,
        scope: SessionInteractionLeaseScope,
        generation: Long,
    ): AppServerInteractionLease {
        requireAllowed(MobileAppServerOperation.INTERACTION_RELEASE)
        requireRevision(generation, "leaseGeneration")
        return interactionLeaseRequest("interaction.release", sessionId, scope, generation)
    }

    suspend fun takeoverLease(
        sessionId: String,
        scope: SessionInteractionLeaseScope,
        ttlMs: Long? = null,
    ): AppServerInteractionLease {
        requireAllowed(MobileAppServerOperation.INTERACTION_TAKEOVER)
        return interactionLeaseRequest("interaction.takeover", sessionId, scope, ttlMs = ttlMs)
    }

    private suspend fun interactionLeaseRequest(
        method: String,
        sessionId: String,
        scope: SessionInteractionLeaseScope,
        generation: Long? = null,
        ttlMs: Long? = null,
    ): AppServerInteractionLease {
        requireWireString(sessionId, "sessionId")
        generation?.let { requireRevision(it, "leaseGeneration") }
        ttlMs?.let { requireRevision(it, "ttlMs") }
        val result = rpc.request(method, jsonParams {
            put("sessionId", sessionId)
            put("scope", scope.wireName)
            generation?.let { put("leaseGeneration", it) }
            ttlMs?.let { put("ttlMs", it) }
        }).requireObject("$method result")
        if (result.requiredString("sessionId") != sessionId || result.requiredString("scope") != scope.wireName) {
            invalidResult("$method returned a different Session or lease scope")
        }
        val lease = result["lease"]?.requireObject("$method lease") ?: invalidResult("$method result is missing its lease")
        return parseInteractionLease(lease, "$method lease")
    }

    private suspend fun detachAfterUncertainAttach(sessionId: String) {
        try {
            withContext(NonCancellable) {
                withTimeoutOrNull(ATTACH_CLEANUP_TIMEOUT_MILLIS) {
                    // Attach may install a server-side subscription before its response times out.
                    rpc.request("session.detach", jsonParams { put("sessionId", sessionId) })
                }
            }
        } catch (_: Exception) {
            // Preserve the original attach failure; cleanup is bounded and best-effort.
        }
    }

    private fun requireAllowed(operation: MobileAppServerOperation) {
        if (!initialize.allows(operation)) {
            throw AppServerProtocolException(
                "capability_denied",
                "The paired device is not authorized for ${operation.capability}",
            )
        }
    }

    private companion object {
        val RUN_CANCELLATION_STATES = setOf("requested", "already_terminal", "not_found")
        const val ATTACH_CLEANUP_TIMEOUT_MILLIS = 1_000L
    }
}

fun decodeSessionAttachResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionAttachResult {
    val result = value.requireObject("session.attach result")
    result.requireExactFields(setOf("snapshot", "barrierRevision"), "session.attach result")
    val snapshot = parsePublicSessionSnapshot(result["snapshot"]!!, "session.attach result.snapshot")
    val sessionId = snapshot.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("session.attach returned a different sessionId")
    }
    val barrierRevision = result.requiredLong("barrierRevision")
    requireRevision(barrierRevision, "session.attach result.barrierRevision", "invalid_result")
    if (barrierRevision != snapshot.requiredLong("asOfRevision")) {
        invalidResult("session.attach barrierRevision diverges from the snapshot revision")
    }
    return AppServerSessionAttachResult(sessionId, snapshot, barrierRevision)
}

internal fun encodeSessionAttachResult(result: AppServerSessionAttachResult): JsonObject = buildJsonObject {
    put("snapshot", result.snapshot)
    put("barrierRevision", result.barrierRevision)
}

fun decodeSessionDetachResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionDetachResult {
    val result = value.requireObject("session.detach result")
    result.requireExactFields(setOf("sessionId", "detached"), "session.detach result")
    val sessionId = result.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("session.detach returned a different sessionId")
    }
    if (!result.requiredBoolean("detached")) invalidResult("session.detach result.detached must be literal true")
    return AppServerSessionDetachResult(sessionId, detached = true)
}

internal fun encodeSessionDetachResult(result: AppServerSessionDetachResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("detached", result.detached)
}

/** Decoder for result groups that carry a bare snapshot document (`session.snapshot`, `session.resync`). */
fun decodeSessionSnapshotDocumentResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionSnapshotResult {
    val result = value.requireObject("session snapshot result")
    result.requireExactFields(setOf("snapshot"), "session snapshot result")
    val snapshot = parsePublicSessionSnapshot(result["snapshot"]!!, "session snapshot result.snapshot")
    val sessionId = snapshot.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("session snapshot result returned a different sessionId")
    }
    return AppServerSessionSnapshotResult(sessionId, snapshot)
}

internal fun encodeSessionSnapshotDocumentResult(result: AppServerSessionSnapshotResult): JsonObject = buildJsonObject {
    put("snapshot", result.snapshot)
}

fun decodeSessionReplayResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionReplayPage {
    val result = value.requireObject("session.replay result")
    result.requireFields(required = setOf("events", "scannedThroughRevision", "hasMore"), optional = setOf("nextAfterRevision"), context = "session.replay result")
    val events = result.requiredObjectArray("events").mapIndexed { index, event ->
        val envelope = requirePublicEventEnvelope(event, "invalid_result")
        if (expectedSessionId != null && envelope.requiredString("sessionId") != expectedSessionId) {
            invalidResult("session.replay result.events[$index] belongs to a different Session")
        }
        envelope
    }
    val scannedThroughRevision = result.requiredLong("scannedThroughRevision")
    requireRevision(scannedThroughRevision, "session.replay result.scannedThroughRevision", "invalid_result")
    val nextAfterRevision = if (result["nextAfterRevision"] === null || result["nextAfterRevision"] === JsonNull) {
        null
    } else {
        result.requiredLong("nextAfterRevision")
    }
    if (nextAfterRevision != null) {
        requireRevision(nextAfterRevision, "session.replay result.nextAfterRevision", "invalid_result")
    }
    val hasMore = result.requiredBoolean("hasMore")
    if (hasMore && nextAfterRevision == null) {
        invalidResult("session.replay result claims more events without a continuation cursor")
    }
    return AppServerSessionReplayPage(
        events = events,
        scannedThroughRevision = scannedThroughRevision,
        nextAfterRevision = nextAfterRevision,
        hasMore = hasMore,
    )
}

internal fun encodeSessionReplayResult(page: AppServerSessionReplayPage): JsonObject = buildJsonObject {
    put("events", JsonArray(page.events))
    put("scannedThroughRevision", page.scannedThroughRevision)
    page.nextAfterRevision?.let { put("nextAfterRevision", it) }
    put("hasMore", page.hasMore)
}

private val INPUT_ADMISSION_FIELDS = setOf("accepted", "sessionId", "commandId", "inputId", "queued")
private val CANCELLATION_STATES = setOf("requested", "already_terminal", "not_found")
private val MESSAGE_ROLES = setOf("user", "assistant")
private val INTERACTION_KINDS = setOf("tool_approval", "ask_user")
private val INTERACTION_OUTCOMES = setOf("approved", "denied", "answered", "chat", "declined", "expired")
private val PERMISSION_RULE_BEHAVIORS = setOf("allow", "ask", "deny")
private val WORKSPACE_CHANGE_OPERATIONS = setOf("add", "delete", "modify", "move", "copy")
private val WORKSPACE_FILE_KINDS = setOf("text", "binary", "symlink", "directory", "unknown")

/** `session.submit` and `session.steer` share the mailbox admission shape; steer's `queued`
 * being always true for a running target is a server invariant, not a wire-shape fact. */
fun decodeSessionSubmitResult(value: JsonElement, expectedSessionId: String? = null): AppServerInputAdmissionResult =
    decodeInputAdmissionResult(value, "session.submit", expectedSessionId)

fun decodeSessionSteerResult(value: JsonElement, expectedSessionId: String? = null): AppServerInputAdmissionResult =
    decodeInputAdmissionResult(value, "session.steer", expectedSessionId)

private fun decodeInputAdmissionResult(
    value: JsonElement,
    method: String,
    expectedSessionId: String?,
): AppServerInputAdmissionResult {
    val result = value.requireObject("$method result")
    result.requireExactFields(INPUT_ADMISSION_FIELDS, "$method result")
    if (!result.requiredBoolean("accepted")) invalidResult("$method result.accepted must be literal true")
    val sessionId = result.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("$method returned a different sessionId")
    }
    return AppServerInputAdmissionResult(
        sessionId = sessionId,
        commandId = result.requiredString("commandId"),
        inputId = result.requiredString("inputId"),
        queued = result.requiredBoolean("queued"),
    )
}

internal fun encodeSessionAdmissionResult(result: AppServerInputAdmissionResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("inputId", result.inputId)
    put("queued", result.queued)
}

/** Cancellation results report the requested state, never a completion; the
 * `requested === (state == "requested")` pairing holds by server construction. */
fun decodeSessionCancellationResult(value: JsonElement, method: String): AppServerCancellationResult {
    val result = value.requireObject("$method result")
    result.requireExactFields(setOf("requested", "state"), "$method result")
    return AppServerCancellationResult(
        requested = result.requiredBoolean("requested"),
        state = result.requiredEnum("state", CANCELLATION_STATES, "$method result"),
    )
}

internal fun encodeSessionCancellationResult(result: AppServerCancellationResult): JsonObject = buildJsonObject {
    put("requested", result.requested)
    put("state", result.state)
}

/** One deep-history page in chronological order; `nextBefore` is the oldest
 * messageId of the page and appears exactly when older messages remain. */
fun decodeSessionMessagesResult(value: JsonElement): AppServerMessagesPage {
    val result = value.requireObject("session.messages result")
    result.requireFields(required = setOf("messages"), optional = setOf("nextBefore"), context = "session.messages result")
    val messages = result.requiredObjectArray("messages").mapIndexed { index, message ->
        val context = "session.messages result.messages[$index]"
        message.requireFields(
            required = setOf("messageId", "role", "createdAt", "content"),
            optional = setOf("runId", "turn", "durationMs"),
            context = context,
        )
        message.requiredEnum("role", MESSAGE_ROLES, context)
        message["createdAt"]!!.asIsoTimestamp("$context.createdAt")
        message["content"]!!.requireArray("$context.content")
        message.optionalLong("turn", "$context.turn", 1)
        message.optionalLong("durationMs", "$context.durationMs", 0)
        message
    }
    return AppServerMessagesPage(
        messages = messages,
        nextBefore = result.optionalString("nextBefore", "session.messages result.nextBefore"),
    )
}

internal fun encodeSessionMessagesResult(page: AppServerMessagesPage): JsonObject = buildJsonObject {
    put("messages", JsonArray(page.messages))
    page.nextBefore?.let { put("nextBefore", it) }
}

/** Unified interaction resolution (contract §11.5): the envelope is strict, the
 * nested resolution document is not — unknown resolution fields pass through
 * like other nested public DTOs. */
fun decodeSessionResolveInteractionResult(value: JsonElement): AppServerSessionResolveInteractionResult {
    val result = value.requireObject("session.resolveInteraction result")
    result.requireExactFields(
        setOf("resolved", "interactionId", "kind", "resolution"),
        "session.resolveInteraction result",
    )
    if (!result.requiredBoolean("resolved")) {
        invalidResult("session.resolveInteraction result.resolved must be literal true")
    }
    val interactionId = result.requiredString("interactionId")
    val kind = result.requiredEnum("kind", INTERACTION_KINDS, "session.resolveInteraction result")
    val resolutionContext = "session.resolveInteraction result.resolution"
    val resolution = result["resolution"]?.requireObject(resolutionContext)
        ?: invalidResult("session.resolveInteraction result is missing its resolution")
    if (resolution.requiredString("interactionId") != interactionId) {
        invalidResult("$resolutionContext belongs to a different interaction")
    }
    if (resolution.requiredString("kind") != kind) {
        invalidResult("$resolutionContext carries a different kind")
    }
    resolution.requiredEnum("outcome", INTERACTION_OUTCOMES, resolutionContext)
    val resolvedAt = resolution["resolvedAt"] ?: invalidResult("$resolutionContext is missing resolvedAt")
    resolvedAt.asIsoTimestamp("$resolutionContext.resolvedAt")
    resolution["resolvedBy"]?.takeUnless { it === JsonNull }?.let { resolver ->
        val resolverObject = resolver.requireObject("$resolutionContext.resolvedBy")
        resolverObject.requiredString("clientName")
        resolverObject.requiredEnum("clientKind", CLIENT_KINDS, "$resolutionContext.resolvedBy")
    }
    return AppServerSessionResolveInteractionResult(interactionId, kind, resolution)
}

internal fun encodeSessionResolveInteractionResult(
    result: AppServerSessionResolveInteractionResult,
): JsonObject = buildJsonObject {
    put("resolved", true)
    put("interactionId", result.interactionId)
    put("kind", result.kind)
    put("resolution", result.resolution)
}

private fun validateAskUserAnswer(answer: SessionAskUserAnswer) {
    when (answer) {
        is SessionAskUserAnswer.Answered -> {
            answer.answers.forEach { selection ->
                requireWireString(selection.questionId, "questionId")
                selection.selectedOptionIds.forEach { requireWireString(it, "selectedOptionId") }
            }
            answer.freeText?.forEach { entry -> requireWireString(entry.questionId, "questionId") }
        }
        SessionAskUserAnswer.Chat, SessionAskUserAnswer.Declined -> Unit
    }
}

private fun encodeAskUserAnswer(answer: SessionAskUserAnswer): JsonObject = buildJsonObject {
    when (answer) {
        is SessionAskUserAnswer.Answered -> {
            put("outcome", "answered")
            put("answers", JsonArray(answer.answers.map(::encodeAskUserSelection)))
            answer.freeText?.let { put("freeText", JsonArray(it.map(::encodeAskUserFreeText))) }
        }
        SessionAskUserAnswer.Chat -> put("outcome", "chat")
        SessionAskUserAnswer.Declined -> put("outcome", "declined")
    }
}

private fun encodeAskUserSelection(selection: SessionAskUserSelection): JsonObject = buildJsonObject {
    put("questionId", selection.questionId)
    put("selectedOptionIds", JsonArray(selection.selectedOptionIds.map(::JsonPrimitive)))
}

private fun encodeAskUserFreeText(entry: SessionAskUserFreeText): JsonObject = buildJsonObject {
    put("questionId", entry.questionId)
    put("text", entry.text)
}

/** Permission policy face (contract §13): reads and writes share one result —
 * the full policy document — because a writer must see the new policyRevision
 * it carries into its next CAS. Rule bodies travel only through this face,
 * never through the snapshot projection. */
fun decodeSessionPermissionPolicyResult(value: JsonElement, expectedSessionId: String? = null): AppServerPermissionPolicy {
    val result = value.requireObject("permission policy result")
    result.requireExactFields(setOf("policy"), "permission policy result")
    val context = "permission policy result.policy"
    val policy = result["policy"]?.requireObject(context) ?: invalidResult("$context is missing")
    policy.requireExactFields(setOf("sessionId", "mode", "policyRevision", "rules", "selectableModes"), context)
    val sessionId = policy.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("permission policy returned a different sessionId")
    }
    val mode = policy.requiredEnum("mode", PERMISSION_MODES, context)
    val policyRevision = policy.requiredLong("policyRevision")
    requireRevision(policyRevision, "$context.policyRevision", "invalid_result")
    val rules = policy.requiredObjectArray("rules").mapIndexed { index, rule ->
        val ruleContext = "$context.rules[$index]"
        rule.requireExactFields(setOf("name", "behavior"), ruleContext)
        rule.requiredEnum("behavior", PERMISSION_RULE_BEHAVIORS, ruleContext)
        rule
    }
    val selectableModes = policy.requiredArray("selectableModes").mapIndexed { index, element ->
        val primitive = element as? JsonPrimitive
            ?: invalidResult("$context.selectableModes[$index] must be one of: ${PERMISSION_MODES.joinToString()}")
        if (!primitive.isString || primitive.content !in PERMISSION_MODES) {
            invalidResult("$context.selectableModes[$index] must be one of: ${PERMISSION_MODES.joinToString()}")
        }
        primitive.content
    }
    return AppServerPermissionPolicy(sessionId, mode, policyRevision, rules, selectableModes)
}

internal fun encodeSessionPermissionPolicyResult(policy: AppServerPermissionPolicy): JsonObject = buildJsonObject {
    put("policy", buildJsonObject {
        put("sessionId", policy.sessionId)
        put("mode", policy.mode)
        put("policyRevision", policy.policyRevision)
        put("rules", JsonArray(policy.rules))
        put("selectableModes", JsonArray(policy.selectableModes.map(::JsonPrimitive)))
    })
}

/** Client-local result decoder for `session.plan`: the method has no result
 * schema in the public wire contract, so only the admission envelope is
 * strict here and the result and snapshot documents pass through opaque. */
private fun decodeSessionPlanResult(
    value: JsonElement,
    expectedSessionId: String,
    expectedCommandId: String,
): SessionPlanAdmissionResult {
    val result = value.requireObject("session.plan result")
    result.requireExactFields(
        setOf("accepted", "sessionId", "commandId", "intent", "result", "snapshot"),
        "session.plan result",
    )
    if (!result.requiredBoolean("accepted")) invalidResult("session.plan result.accepted must be literal true")
    if (result.requiredString("intent") != "plan") invalidResult("session.plan result.intent must be literal plan")
    if (result.requiredString("sessionId") != expectedSessionId) {
        invalidResult("session.plan returned a different sessionId")
    }
    if (result.requiredString("commandId") != expectedCommandId) {
        invalidResult("session.plan returned a different command identity")
    }
    return SessionPlanAdmissionResult(
        sessionId = expectedSessionId,
        commandId = expectedCommandId,
        result = result["result"]!!,
        snapshot = result["snapshot"]!!,
    )
}

/** Workspace read-only face (contract §12). The result envelope, the asOf
 * state document, and every change entry are strict; paths must be
 * workspace-relative POSIX paths, matching the TypeScript result parser. */
fun decodeWorkspaceDiffResult(value: JsonElement, expectedSessionId: String? = null): AppServerWorkspaceDiffResult {
    val result = value.requireObject("workspace.diff result")
    result.requireFields(
        required = setOf("sessionId", "workspaceId", "snapshotToken", "asOf", "changes"),
        optional = setOf("nextCursor"),
        context = "workspace.diff result",
    )
    val sessionId = result.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("workspace.diff returned a different sessionId")
    }
    val asOfContext = "workspace.diff result.asOf"
    val asOf = result["asOf"]?.requireObject(asOfContext) ?: invalidResult("$asOfContext is missing")
    asOf.requireFields(
        required = setOf("workingTreeDigest"),
        optional = setOf("head", "indexTree"),
        context = asOfContext,
    )
    asOf.requiredString("workingTreeDigest")
    val changes = result.requiredObjectArray("changes").mapIndexed { index, change ->
        val changeContext = "workspace.diff result.changes[$index]"
        change.requireFields(
            required = setOf("operation", "path", "fileKind", "truncated"),
            optional = setOf("oldPath", "additions", "deletions", "gitPatch"),
            context = changeContext,
        )
        change.requiredEnum("operation", WORKSPACE_CHANGE_OPERATIONS, changeContext)
        requireWorkspaceRelativePath(change.requiredString("path"), "$changeContext.path")
        change.optionalString("oldPath", "$changeContext.oldPath")?.let { oldPath ->
            requireWorkspaceRelativePath(oldPath, "$changeContext.oldPath")
        }
        change.requiredEnum("fileKind", WORKSPACE_FILE_KINDS, changeContext)
        change.optionalLong("additions", "$changeContext.additions", minimum = 0)
        change.optionalLong("deletions", "$changeContext.deletions", minimum = 0)
        change.requiredBoolean("truncated")
        change["gitPatch"]?.let { patch ->
            if (patch !is JsonPrimitive || !patch.isString) invalidResult("$changeContext.gitPatch must be a string")
        }
        change
    }
    return AppServerWorkspaceDiffResult(
        sessionId = sessionId,
        workspaceId = result.requiredString("workspaceId"),
        snapshotToken = result.requiredString("snapshotToken"),
        asOf = asOf,
        changes = changes,
        nextCursor = result.optionalString("nextCursor", "workspace.diff result.nextCursor"),
    )
}

internal fun encodeWorkspaceDiffResult(result: AppServerWorkspaceDiffResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("workspaceId", result.workspaceId)
    put("snapshotToken", result.snapshotToken)
    put("asOf", result.asOf)
    put("changes", JsonArray(result.changes))
    result.nextCursor?.let { put("nextCursor", it) }
}

/** Text results carry content only with the utf-8 encoding marker; binary
 * results return metadata only. All line numbers are 1-based positive
 * integers, and sizeBytes is a non-negative byte count. */
fun decodeWorkspaceReadFileResult(value: JsonElement, expectedSessionId: String? = null): AppServerWorkspaceReadFileResult {
    val result = value.requireObject("workspace.readFile result")
    result.requireFields(
        required = setOf("sessionId", "workspaceId", "path", "kind", "sizeBytes", "digest"),
        optional = setOf("content", "encoding", "startLine", "totalLines", "nextStartLine"),
        context = "workspace.readFile result",
    )
    val sessionId = result.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("workspace.readFile returned a different sessionId")
    }
    val kind = result.requiredEnum("kind", setOf("text", "binary"), "workspace.readFile result")
    val path = result.requiredString("path")
    requireWorkspaceRelativePath(path, "workspace.readFile result.path")
    val encoding = result["encoding"]?.let { element ->
        val value2 = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: invalidResult("workspace.readFile result.encoding must be a string")
        if (value2 != "utf-8") invalidResult("workspace.readFile result.encoding must be utf-8")
        value2
    }
    val sizeBytes = result.requiredLong("sizeBytes")
    if (sizeBytes < 0) invalidResult("workspace.readFile result.sizeBytes must be non-negative")
    return AppServerWorkspaceReadFileResult(
        sessionId = sessionId,
        workspaceId = result.requiredString("workspaceId"),
        path = path,
        kind = kind,
        content = result.optionalLabel("content", "workspace.readFile result.content"),
        encoding = encoding,
        sizeBytes = sizeBytes,
        digest = result.requiredString("digest"),
        startLine = result.optionalLong("startLine", "workspace.readFile result.startLine", minimum = 1),
        totalLines = result.optionalLong("totalLines", "workspace.readFile result.totalLines", minimum = 1),
        nextStartLine = result.optionalLong("nextStartLine", "workspace.readFile result.nextStartLine", minimum = 1),
    )
}

internal fun encodeWorkspaceReadFileResult(result: AppServerWorkspaceReadFileResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("workspaceId", result.workspaceId)
    put("path", result.path)
    put("kind", result.kind)
    result.content?.let { put("content", it) }
    result.encoding?.let { put("encoding", it) }
    put("sizeBytes", result.sizeBytes)
    put("digest", result.digest)
    result.startLine?.let { put("startLine", it) }
    result.totalLines?.let { put("totalLines", it) }
    result.nextStartLine?.let { put("nextStartLine", it) }
}

/** Standalone task and remote shell face (contract §11.7/§11.8): both execute
 * methods admit a background task and return its identity, paged output
 * arrives via `session.getTaskLogs`, and cancellation converges through
 * `session.cancelTask`. Periodic loops stay a local-runtime concern and never
 * cross this face. */
private val PUBLIC_TASK_KINDS = setOf("agent", "shell", "user_shell")
private val PUBLIC_TASK_STATUSES = setOf("queued", "running", "completed", "failed", "cancelled")
private const val MAX_TASK_LOG_CHUNK_LENGTH = 4_096
private val PUBLIC_GOAL_STATUSES = setOf("unset", "active", "paused")
private val PUBLIC_CHECKPOINT_KINDS = setOf("prompt", "manual")
private val PUBLIC_REWIND_STATUSES = setOf("rewound", "already_rewound", "failed", "already_failed")
private const val MAX_ADDITIONAL_DIRECTORIES = 64

fun decodePublicTaskSummary(value: JsonElement, context: String): AppServerPublicTaskSummary {
    val task = value.requireObject(context)
    for (field in listOf("taskId", "kind", "title", "status", "updatedAt")) {
        if (field !in task.keys) invalidResult("$context is missing required fields: $field")
    }
    val progress = task["progress"]
    if (progress != null && progress !== JsonNull) {
        (progress as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
            ?: invalidResult("$context.progress must be an integer")
    }
    return AppServerPublicTaskSummary(
        taskId = task.requiredString("taskId"),
        kind = task.requiredEnum("kind", PUBLIC_TASK_KINDS, context),
        status = task.requiredEnum("status", PUBLIC_TASK_STATUSES, context),
        updatedAt = task["updatedAt"]!!.asIsoTimestamp("$context.updatedAt"),
        raw = task,
    )
}

internal fun encodePublicTaskSummary(task: AppServerPublicTaskSummary): JsonObject = task.raw

fun decodeSessionCreateTaskResult(value: JsonElement): AppServerSessionCreateTaskResult {
    val result = value.requireObject("session.createTask result")
    result.requireExactFields(setOf("accepted", "sessionId", "commandId", "task", "queued"), "session.createTask result")
    if (!result.requiredBoolean("accepted")) {
        invalidResult("session.createTask result.accepted must be literal true")
    }
    return AppServerSessionCreateTaskResult(
        sessionId = result.requiredString("sessionId"),
        commandId = result.requiredString("commandId"),
        task = decodePublicTaskSummary(result["task"]!!, "session.createTask result.task"),
        queued = result.requiredBoolean("queued"),
    )
}

internal fun encodeSessionCreateTaskResult(result: AppServerSessionCreateTaskResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("task", encodePublicTaskSummary(result.task))
    put("queued", result.queued)
}

fun decodeSessionListTasksResult(value: JsonElement): AppServerSessionListTasksResult {
    val result = value.requireObject("session.listTasks result")
    result.requireExactFields(setOf("sessionId", "tasks"), "session.listTasks result")
    return AppServerSessionListTasksResult(
        sessionId = result.requiredString("sessionId"),
        tasks = result.requiredObjectArray("tasks").mapIndexed { index, task ->
            decodePublicTaskSummary(task, "session.listTasks result.tasks[$index]")
        },
    )
}

internal fun encodeSessionListTasksResult(result: AppServerSessionListTasksResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("tasks", JsonArray(result.tasks.map(::encodePublicTaskSummary)))
}

fun decodeSessionCancelTaskResult(value: JsonElement): AppServerSessionCancelTaskResult {
    val result = value.requireObject("session.cancelTask result")
    result.requireExactFields(setOf("cancelled", "sessionId", "taskId", "task"), "session.cancelTask result")
    return AppServerSessionCancelTaskResult(
        cancelled = result.requiredBoolean("cancelled"),
        sessionId = result.requiredString("sessionId"),
        taskId = result.requiredString("taskId"),
        task = decodePublicTaskSummary(result["task"]!!, "session.cancelTask result.task"),
    )
}

internal fun encodeSessionCancelTaskResult(result: AppServerSessionCancelTaskResult): JsonObject = buildJsonObject {
    put("cancelled", result.cancelled)
    put("sessionId", result.sessionId)
    put("taskId", result.taskId)
    put("task", encodePublicTaskSummary(result.task))
}

fun decodeSessionGetTaskLogsResult(value: JsonElement): AppServerSessionTaskLogsPage {
    val result = value.requireObject("session.getTaskLogs result")
    result.requireFields(
        required = setOf("sessionId", "taskId", "status", "outputBytes", "chunks"),
        optional = setOf("nextAfterSequence"),
        context = "session.getTaskLogs result",
    )
    return AppServerSessionTaskLogsPage(
        sessionId = result.requiredString("sessionId"),
        taskId = result.requiredString("taskId"),
        status = result.requiredEnum("status", PUBLIC_TASK_STATUSES, "session.getTaskLogs result"),
        outputBytes = result.requiredLong("outputBytes"),
        chunks = result.requiredArray("chunks").mapIndexed { index, element ->
            val context = "session.getTaskLogs result.chunks[$index]"
            val chunk = element.requireObject(context)
            chunk.requireExactFields(setOf("sequence", "text"), context)
            val sequence = chunk.requiredLong("sequence")
            if (sequence < 0) invalidResult("$context.sequence must be a non-negative integer")
            val text = chunk.requiredLabel("text", context)
            if (text.length > MAX_TASK_LOG_CHUNK_LENGTH) {
                invalidResult("$context.text must hold at most $MAX_TASK_LOG_CHUNK_LENGTH characters")
            }
            AppServerTaskLogChunk(sequence, text)
        },
        nextAfterSequence = result.optionalLong("nextAfterSequence", "session.getTaskLogs result.nextAfterSequence", minimum = 1),
    )
}

internal fun encodeSessionGetTaskLogsResult(page: AppServerSessionTaskLogsPage): JsonObject = buildJsonObject {
    put("sessionId", page.sessionId)
    put("taskId", page.taskId)
    put("status", page.status)
    put("outputBytes", page.outputBytes)
    put(
        "chunks",
        JsonArray(
            page.chunks.map { chunk ->
                buildJsonObject {
                    put("sequence", chunk.sequence)
                    put("text", chunk.text)
                }
            },
        ),
    )
    page.nextAfterSequence?.let { put("nextAfterSequence", it) }
}

/** Both execute methods share the admission result: the task identity plus the
 * queued fact; progress arrives as `task.updated` events, paged output via
 * `session.getTaskLogs`. */
fun decodeSessionShellAdmissionResult(value: JsonElement, method: String): AppServerShellTaskAdmissionResult {
    val result = value.requireObject("$method result")
    result.requireExactFields(setOf("accepted", "sessionId", "commandId", "taskId", "queued"), "$method result")
    if (!result.requiredBoolean("accepted")) {
        invalidResult("$method result.accepted must be literal true")
    }
    return AppServerShellTaskAdmissionResult(
        sessionId = result.requiredString("sessionId"),
        commandId = result.requiredString("commandId"),
        taskId = result.requiredString("taskId"),
        queued = result.requiredBoolean("queued"),
    )
}

internal fun encodeSessionShellAdmissionResult(result: AppServerShellTaskAdmissionResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("taskId", result.taskId)
    put("queued", result.queued)
}

/** Session action results (contract §11.7): the shared accepted/sessionId/commandId/changed
 * facts plus each action's reducer facts — structural updates keep arriving as durable
 * session events, so no snapshot rides these results. */
private fun decodeSessionActionFacts(result: JsonObject, method: String): Triple<String, String, Boolean> {
    if (!result.requiredBoolean("accepted")) {
        invalidResult("$method result.accepted must be literal true")
    }
    return Triple(result.requiredString("sessionId"), result.requiredString("commandId"), result.requiredBoolean("changed"))
}

fun decodeSessionCompactResult(value: JsonElement): AppServerSessionCompactResult {
    val context = "session.compact result"
    val result = value.requireObject(context)
    result.requireFields(
        required = setOf("accepted", "sessionId", "commandId", "changed", "inputMessageCount", "outputMessageCount"),
        optional = setOf("inputTokens"),
        context = context,
    )
    val facts = decodeSessionActionFacts(result, "session.compact")
    val inputMessageCount = result.requiredLong("inputMessageCount")
    val outputMessageCount = result.requiredLong("outputMessageCount")
    if (inputMessageCount < 0 || outputMessageCount < 0) {
        invalidResult("session.compact result message counts must be non-negative")
    }
    return AppServerSessionCompactResult(
        sessionId = facts.first,
        commandId = facts.second,
        changed = facts.third,
        inputMessageCount = inputMessageCount,
        outputMessageCount = outputMessageCount,
        inputTokens = result.optionalLong("inputTokens", "session.compact result.inputTokens", minimum = 0),
    )
}

internal fun encodeSessionCompactResult(result: AppServerSessionCompactResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("changed", result.changed)
    put("inputMessageCount", result.inputMessageCount)
    put("outputMessageCount", result.outputMessageCount)
    result.inputTokens?.let { put("inputTokens", it) }
}

fun decodeSessionAddDirectoryResult(value: JsonElement): AppServerSessionAddDirectoryResult {
    val context = "session.addDirectory result"
    val result = value.requireObject(context)
    result.requireFields(
        required = setOf("accepted", "sessionId", "commandId", "changed", "directory", "additionalDirectories", "scopeRevision"),
        optional = setOf("scopeDigest"),
        context = context,
    )
    val facts = decodeSessionActionFacts(result, "session.addDirectory")
    val directories = result.requiredArray("additionalDirectories").mapIndexed { index, element ->
        val directory = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
            ?: invalidResult("$context.additionalDirectories[$index] must be a string")
        if (directory.isBlank()) invalidResult("$context.additionalDirectories[$index] must be non-blank")
        directory
    }
    if (directories.size > MAX_ADDITIONAL_DIRECTORIES) {
        invalidResult("$context.additionalDirectories must hold at most $MAX_ADDITIONAL_DIRECTORIES entries")
    }
    val scopeRevision = result.requiredLong("scopeRevision")
    if (scopeRevision < 0) invalidResult("$context.scopeRevision must be non-negative")
    return AppServerSessionAddDirectoryResult(
        sessionId = facts.first,
        commandId = facts.second,
        changed = facts.third,
        directory = result.requiredString("directory"),
        additionalDirectories = directories,
        scopeRevision = scopeRevision,
        scopeDigest = result.optionalString("scopeDigest", "$context.scopeDigest"),
    )
}

internal fun encodeSessionAddDirectoryResult(result: AppServerSessionAddDirectoryResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("changed", result.changed)
    put("directory", result.directory)
    put("additionalDirectories", JsonArray(result.additionalDirectories.map { JsonPrimitive(it) }))
    put("scopeRevision", result.scopeRevision)
    result.scopeDigest?.let { put("scopeDigest", it) }
}

fun decodeSessionSetContextWindowResult(value: JsonElement): AppServerSessionContextWindowResult {
    val context = "session.setContextWindow result"
    val result = value.requireObject(context)
    result.requireFields(
        required = setOf("accepted", "sessionId", "commandId", "changed"),
        optional = setOf("contextWindowOverride"),
        context = context,
    )
    val facts = decodeSessionActionFacts(result, "session.setContextWindow")
    val override = result.optionalLong("contextWindowOverride", "$context.contextWindowOverride", minimum = 1)
    return AppServerSessionContextWindowResult(
        sessionId = facts.first,
        commandId = facts.second,
        changed = facts.third,
        contextWindowOverride = override,
    )
}

internal fun encodeSessionSetContextWindowResult(result: AppServerSessionContextWindowResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("changed", result.changed)
    result.contextWindowOverride?.let { put("contextWindowOverride", it) }
}

fun decodeSessionClearContextWindowResult(value: JsonElement): AppServerSessionContextWindowResult {
    val context = "session.clearContextWindow result"
    val result = value.requireObject(context)
    result.requireExactFields(setOf("accepted", "sessionId", "commandId", "changed"), context)
    val facts = decodeSessionActionFacts(result, "session.clearContextWindow")
    return AppServerSessionContextWindowResult(
        sessionId = facts.first,
        commandId = facts.second,
        changed = facts.third,
        contextWindowOverride = null,
    )
}

internal fun encodeSessionClearContextWindowResult(result: AppServerSessionContextWindowResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("changed", result.changed)
}

fun decodeSessionSelectAgentResult(value: JsonElement): AppServerSessionSelectAgentResult {
    val context = "session.selectAgent result"
    val result = value.requireObject(context)
    result.requireFields(
        required = setOf("accepted", "sessionId", "commandId", "changed"),
        optional = setOf("agentName"),
        context = context,
    )
    val facts = decodeSessionActionFacts(result, "session.selectAgent")
    return AppServerSessionSelectAgentResult(
        sessionId = facts.first,
        commandId = facts.second,
        changed = facts.third,
        agentName = result.optionalString("agentName", "$context.agentName"),
    )
}

internal fun encodeSessionSelectAgentResult(result: AppServerSessionSelectAgentResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("changed", result.changed)
    result.agentName?.let { put("agentName", it) }
}

fun decodeSessionUpdateGoalResult(value: JsonElement): AppServerSessionUpdateGoalResult {
    val context = "session.updateGoal result"
    val result = value.requireObject(context)
    result.requireExactFields(setOf("accepted", "sessionId", "commandId", "changed", "goal"), context)
    val facts = decodeSessionActionFacts(result, "session.updateGoal")
    val goalObject = result["goal"]?.requireObject("$context.goal") ?: invalidResult("$context.goal must be an object")
    goalObject.requireFields(required = setOf("status"), optional = setOf("text"), context = "$context.goal")
    return AppServerSessionUpdateGoalResult(
        sessionId = facts.first,
        commandId = facts.second,
        changed = facts.third,
        goal = AppServerPublicGoal(
            status = goalObject.requiredEnum("status", PUBLIC_GOAL_STATUSES, "$context.goal"),
            text = goalObject.optionalString("text", "$context.goal.text"),
        ),
    )
}

internal fun encodeSessionUpdateGoalResult(result: AppServerSessionUpdateGoalResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("changed", result.changed)
    put(
        "goal",
        buildJsonObject {
            put("status", result.goal.status)
            result.goal.text?.let { put("text", it) }
        },
    )
}

/** Rewind face (contract §11.7): checkpoints travel as business facts only —
 * the internal DAG cursor never reaches the wire, so the decoder rejects it. */
fun decodePublicCheckpoint(value: JsonElement, context: String): AppServerPublicCheckpoint {
    val checkpoint = value.requireObject(context)
    checkpoint.requireExactFields(setOf("checkpointId", "kind", "headRevision", "generation", "createdAt"), context)
    val headRevision = checkpoint.requiredLong("headRevision")
    if (headRevision < 0) invalidResult("$context.headRevision must be a non-negative integer")
    val generation = checkpoint.requiredLong("generation")
    if (generation < 0) invalidResult("$context.generation must be a non-negative integer")
    return AppServerPublicCheckpoint(
        checkpointId = checkpoint.requiredString("checkpointId"),
        kind = checkpoint.requiredEnum("kind", PUBLIC_CHECKPOINT_KINDS, context),
        headRevision = headRevision,
        generation = generation,
        createdAt = checkpoint["createdAt"]!!.asIsoTimestamp("$context.createdAt"),
    )
}

internal fun encodePublicCheckpoint(checkpoint: AppServerPublicCheckpoint): JsonObject = buildJsonObject {
    put("checkpointId", checkpoint.checkpointId)
    put("kind", checkpoint.kind)
    put("headRevision", checkpoint.headRevision)
    put("generation", checkpoint.generation)
    put("createdAt", checkpoint.createdAt)
}

fun decodeSessionCheckpointsResult(value: JsonElement): AppServerSessionCheckpointsResult {
    val context = "session.listCheckpoints result"
    val result = value.requireObject(context)
    result.requireExactFields(setOf("sessionId", "checkpoints"), context)
    return AppServerSessionCheckpointsResult(
        sessionId = result.requiredString("sessionId"),
        checkpoints = result.requiredObjectArray("checkpoints").mapIndexed { index, item ->
            decodePublicCheckpoint(item, "$context.checkpoints[$index]")
        },
    )
}

internal fun encodeSessionCheckpointsResult(result: AppServerSessionCheckpointsResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("checkpoints", JsonArray(result.checkpoints.map(::encodePublicCheckpoint)))
}

fun decodeSessionPreviewRewindResult(value: JsonElement): AppServerSessionPreviewRewindResult {
    val context = "session.previewRewind result"
    val result = value.requireObject(context)
    result.requireExactFields(
        setOf("sessionId", "checkpoint", "currentRevision", "currentGeneration", "staleRevision", "canCommit"),
        context,
    )
    val currentRevision = result.requiredLong("currentRevision")
    if (currentRevision < 0) invalidResult("$context.currentRevision must be a non-negative integer")
    val currentGeneration = result.requiredLong("currentGeneration")
    if (currentGeneration < 0) invalidResult("$context.currentGeneration must be a non-negative integer")
    return AppServerSessionPreviewRewindResult(
        sessionId = result.requiredString("sessionId"),
        checkpoint = decodePublicCheckpoint(result["checkpoint"]!!, "$context.checkpoint"),
        currentRevision = currentRevision,
        currentGeneration = currentGeneration,
        staleRevision = result.requiredBoolean("staleRevision"),
        canCommit = result.requiredBoolean("canCommit"),
    )
}

internal fun encodeSessionPreviewRewindResult(result: AppServerSessionPreviewRewindResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("checkpoint", encodePublicCheckpoint(result.checkpoint))
    put("currentRevision", result.currentRevision)
    put("currentGeneration", result.currentGeneration)
    put("staleRevision", result.staleRevision)
    put("canCommit", result.canCommit)
}

fun decodeSessionRewindResult(value: JsonElement): AppServerSessionRewindResult {
    val context = "session.rewind result"
    val result = value.requireObject(context)
    result.requireFields(required = setOf("accepted", "sessionId", "commandId", "status", "rewindId"), optional = setOf("error"), context = context)
    if (!result.requiredBoolean("accepted")) invalidResult("$context.accepted must be literal true")
    val status = result.requiredEnum("status", PUBLIC_REWIND_STATUSES, context)
    val error = result.optionalString("error", "$context.error")
    if ((status == "failed" || status == "already_failed") && error == null) invalidResult("$context.error is required for a failed rewind")
    if (status != "failed" && status != "already_failed" && error != null) invalidResult("$context.error is only valid for a failed rewind")
    return AppServerSessionRewindResult(
        sessionId = result.requiredString("sessionId"),
        commandId = result.requiredString("commandId"),
        status = status,
        rewindId = result.requiredString("rewindId"),
        error = error,
    )
}

internal fun encodeSessionRewindResult(result: AppServerSessionRewindResult): JsonObject = buildJsonObject {
    put("accepted", true)
    put("sessionId", result.sessionId)
    put("commandId", result.commandId)
    put("status", result.status)
    put("rewindId", result.rewindId)
    result.error?.let { put("error", it) }
}

/** Public catalog result decoders. Envelope objects are strict (unknown fields are
 * protocol errors); nested summaries and snapshots ignore fields this client does
 * not read, matching the TypeScript result parsers. */
fun decodeSessionListResult(value: JsonElement): List<AppServerSessionRecord> =
    value.requireArray("session.list result").mapIndexed { index, item ->
        parseSessionSummaryElement(item, "session.list result[$index]")
    }

fun decodeSessionGetResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionRecord {
    val result = value.requireObject("session.get result")
    result.requireExactFields(setOf("summary"), "session.get result")
    val summary = parseSessionSummaryElement(result["summary"]!!, "session.get result.summary")
    if (expectedSessionId != null && summary.sessionId != expectedSessionId) {
        invalidResult("session.get returned a different sessionId")
    }
    return summary
}

fun decodeSessionSnapshotResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionSnapshotResult {
    val result = value.requireObject("session snapshot result")
    result.requireExactFields(setOf("session"), "session snapshot result")
    val snapshot = parsePublicSessionSnapshot(result["session"]!!, "session snapshot result.session")
    val sessionId = snapshot.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("session snapshot result returned a different sessionId")
    }
    return AppServerSessionSnapshotResult(sessionId, snapshot)
}

fun decodeSessionArchiveResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionArchiveResult {
    val result = value.requireObject("session.archive result")
    result.requireExactFields(setOf("sessionId", "archived", "archivedAt"), "session.archive result")
    val sessionId = result.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("session.archive returned a different sessionId")
    }
    if (!result.requiredBoolean("archived")) invalidResult("session.archive result.archived must be literal true")
    return AppServerSessionArchiveResult(sessionId, result["archivedAt"]!!.asIsoTimestamp("session.archive result.archivedAt"))
}

fun decodeSessionDeleteResult(value: JsonElement, expectedSessionId: String? = null): AppServerSessionDeleteResult {
    val result = value.requireObject("session.delete result")
    result.requireExactFields(setOf("sessionId", "deleted"), "session.delete result")
    val sessionId = result.requiredString("sessionId")
    if (expectedSessionId != null && sessionId != expectedSessionId) {
        invalidResult("session.delete returned a different sessionId")
    }
    if (!result.requiredBoolean("deleted")) invalidResult("session.delete result.deleted must be literal true")
    return AppServerSessionDeleteResult(sessionId)
}

internal fun encodeSessionSummary(record: AppServerSessionRecord): JsonObject = buildJsonObject {
    put("sessionId", record.sessionId)
    record.title?.let { put("title", it) }
    put("status", record.status)
    put("workspace", encodeSessionWorkspace(record.workspace))
    put("updatedAt", record.updatedAt)
    record.archivedAt?.let { put("archivedAt", it) }
}

private fun encodeSessionWorkspace(workspace: AppServerSessionWorkspace): JsonObject = buildJsonObject {
    put("workspaceId", workspace.workspaceId)
    put("displayName", workspace.displayName)
    put("availability", workspace.availability)
}

internal fun encodeSessionListResult(records: List<AppServerSessionRecord>): JsonArray =
    JsonArray(records.map(::encodeSessionSummary))

internal fun encodeSessionSnapshotResult(result: AppServerSessionSnapshotResult): JsonObject = buildJsonObject {
    put("session", result.snapshot)
}

internal fun encodeSessionArchiveResult(result: AppServerSessionArchiveResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("archived", true)
    put("archivedAt", result.archivedAt)
}

internal fun encodeSessionDeleteResult(result: AppServerSessionDeleteResult): JsonObject = buildJsonObject {
    put("sessionId", result.sessionId)
    put("deleted", true)
}

private val SESSION_STATUSES = setOf("created", "planning", "plan_ready", "running", "completed", "failed", "cancelled")
private val WORKSPACE_AVAILABILITIES = setOf("available", "unavailable")
private val FOREGROUND_STATES = setOf("idle", "running", "requires_action")
private val RUN_PHASES = setOf("thinking", "tool_execution", "waiting_for_approval", "waiting_for_user")
private val PERMISSION_MODES = setOf("manual", "accept-edits", "plan", "full-access", "auto")
private val ISO_8601_TIMESTAMP = Regex("""^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$""")

private fun parseSessionSummaryElement(value: JsonElement, context: String): AppServerSessionRecord {
    val record = value.requireObject(context)
    return AppServerSessionRecord(
        sessionId = record.requiredString("sessionId"),
        title = record.optionalLabel("title", "$context.title"),
        status = record.requiredEnum("status", SESSION_STATUSES, context),
        workspace = parseSessionWorkspace(
            record["workspace"] ?: invalidResult("$context is missing workspace"),
            "$context.workspace",
        ),
        updatedAt = record["updatedAt"]?.asIsoTimestamp("$context.updatedAt") ?: invalidResult("$context is missing updatedAt"),
        archivedAt = if ("archivedAt" in record) {
            record["archivedAt"]!!.asIsoTimestamp("$context.archivedAt")
        } else {
            null
        },
    )
}

private fun parseSessionWorkspace(value: JsonElement, context: String): AppServerSessionWorkspace {
    val workspace = value.requireObject(context)
    val availability = workspace.requiredString("availability")
    if (availability !in WORKSPACE_AVAILABILITIES) {
        invalidResult("$context.availability must be \"available\" or \"unavailable\"")
    }
    return AppServerSessionWorkspace(
        workspaceId = workspace.requiredString("workspaceId"),
        displayName = workspace.requiredLabel("displayName", "$context.displayName"),
        availability = availability,
    )
}

/** Validates the public session snapshot envelope (enums, scalars, container shapes)
 * and returns it unchanged; nested run/input/interaction bodies stay opaque JsonObject. */
private fun parsePublicSessionSnapshot(value: JsonElement, context: String): JsonObject {
    val snapshot = value.requireObject(context)
    snapshot.requiredEnum("status", SESSION_STATUSES, context)
    requireRevision(snapshot.requiredLong("asOfRevision"), "$context.asOfRevision", "invalid_result")
    snapshot["updatedAt"]?.asIsoTimestamp("$context.updatedAt") ?: invalidResult("$context is missing updatedAt")
    snapshot.optionalLabel("title", "$context.title")
    val foreground = snapshot["foreground"]?.requireObject("$context.foreground") ?: invalidResult("$context is missing foreground")
    foreground.requiredEnum("state", FOREGROUND_STATES, "$context.foreground")
    foreground.optionalString("runId", "$context.foreground.runId")
    foreground.optionalString("phase", "$context.foreground.phase")?.let { phase ->
        if (phase !in RUN_PHASES) invalidResult("$context.foreground.phase is not a run phase")
    }
    parseSessionWorkspace(snapshot["workspace"] ?: invalidResult("$context is missing workspace"), "$context.workspace")
    val security = snapshot["security"]?.requireObject("$context.security") ?: invalidResult("$context is missing security")
    security.requiredEnum("permissionMode", PERMISSION_MODES, "$context.security")
    requireRevision(security.requiredLong("policyRevision"), "$context.security.policyRevision", "invalid_result")
    security.requiredBoolean("hasCustomRules")
    security.requiredArray("selectableModes").forEachIndexed { index, mode ->
        val primitive = mode as? JsonPrimitive
        if (primitive == null || !primitive.isString || primitive.content !in PERMISSION_MODES) {
            invalidResult("$context.security.selectableModes[$index] must be a permission mode")
        }
    }
    snapshot.requiredObjectArray("inputs")
    snapshot.requiredObjectArray("pendingInteractions")
    snapshot.requiredObjectArray("activeTasks")
    snapshot["currentRun"]?.requireObject("$context.currentRun")
    snapshot["activePlan"]?.requireObject("$context.activePlan")
    snapshot["lastError"]?.requireObject("$context.lastError")
    snapshot["recentMessages"]?.let { element ->
        if (element !is JsonArray) invalidResult("$context.recentMessages must be an array")
    }
    return snapshot
}

fun decodePresenceUpdatedNotification(value: JsonElement): AppServerPresenceUpdate {
    val params = value.notificationObject("presence.updated params")
    val sessionId = params.requiredString("sessionId", "invalid_params")
    val clients = params.notificationArray("clients").mapIndexed { index, client ->
        parsePresenceClient(client, "presence.updated clients[$index]")
    }
    val leases = params["leases"]?.notificationObject("presence.updated leases")
        ?: invalidNotification("presence.updated is missing leases")
    return AppServerPresenceUpdate(sessionId, clients, parseLeaseSet(leases, "presence.updated leases"))
}

fun decodeInteractionLeaseUpdatedNotification(value: JsonElement): AppServerInteractionLeaseUpdate {
    val params = value.notificationObject("interaction.lease.updated params")
    val sessionId = params.requiredString("sessionId", "invalid_params")
    val leases = params["leases"]?.notificationObject("interaction.lease.updated leases")
        ?: invalidNotification("interaction.lease.updated is missing leases")
    return AppServerInteractionLeaseUpdate(sessionId, parseLeaseSet(leases, "interaction.lease.updated leases"))
}

internal fun encodePresenceUpdate(update: AppServerPresenceUpdate): JsonObject = buildJsonObject {
    put("sessionId", update.sessionId)
    put("clients", JsonArray(update.clients.map(::encodePresenceClient)))
    put("leases", encodeLeaseSet(update.leases))
}

internal fun encodeInteractionLeaseUpdate(update: AppServerInteractionLeaseUpdate): JsonObject = buildJsonObject {
    put("sessionId", update.sessionId)
    put("leases", encodeLeaseSet(update.leases))
}

private fun encodeLeaseSet(leases: AppServerInteractionLeases): JsonObject = buildJsonObject {
    put("composer", encodeInteractionLease(leases.composer))
    put("session-control", encodeInteractionLease(leases.sessionControl))
}

private fun encodePresenceClient(client: AppServerPresenceClient): JsonObject = buildJsonObject {
    put("clientId", client.clientId)
    put("clientKind", client.clientKind)
    put("name", client.name)
    put("version", client.version)
}

private fun encodeInteractionLease(lease: AppServerInteractionLease): JsonObject = buildJsonObject {
    put("status", if (lease.status == LeaseStatus.AVAILABLE) "available" else "held")
    put("generation", lease.generation)
    lease.holder?.let { holder ->
        put(
            "holder",
            buildJsonObject {
                put("clientId", holder.clientId)
                put("clientKind", holder.clientKind)
                put("name", holder.name)
            },
        )
    }
    lease.expiresAt?.let { put("expiresAt", it) }
}

private val CLIENT_KINDS = setOf("tui", "web", "mobile", "desktop", "acp", "script", "unknown")

private fun parseLeaseSet(leases: JsonObject, context: String, errorKind: String = "invalid_params"): AppServerInteractionLeases =
    AppServerInteractionLeases(
        composer = parseInteractionLease(
            leases["composer"] ?: invalid(errorKind, "$context is missing the composer lease"),
            "$context composer",
            errorKind,
        ),
        sessionControl = parseInteractionLease(
            leases["session-control"] ?: invalid(errorKind, "$context is missing the session-control lease"),
            "$context session-control",
            errorKind,
        ),
    )

private fun parsePresenceClient(
    value: JsonElement,
    context: String,
    errorKind: String = "invalid_params",
): AppServerPresenceClient {
    val client = value.asSessionObject(context, errorKind)
    val kind = client.requiredString("clientKind", errorKind)
    if (kind !in CLIENT_KINDS) invalid(errorKind, "$context has an invalid clientKind")
    return AppServerPresenceClient(
        clientId = client.requiredString("clientId", errorKind),
        clientKind = kind,
        name = client.requiredString("name", errorKind),
        version = client.requiredString("version", errorKind),
    )
}

private fun parseInteractionLease(
    value: JsonElement,
    context: String,
    errorKind: String = "invalid_params",
): AppServerInteractionLease {
    val lease = value.asSessionObject(context, errorKind)
    val status = when (lease.requiredString("status", errorKind)) {
        "available" -> LeaseStatus.AVAILABLE
        "held" -> LeaseStatus.HELD
        else -> invalid(errorKind, "$context has an unknown status")
    }
    val generation = lease.requiredLong("generation", errorKind)
    if (generation < 0 || generation > MAX_SAFE_REVISION) {
        invalid(errorKind, "$context generation must be a non-negative safe integer")
    }
    val holder = lease["holder"]?.let { element ->
        if (element === JsonNull) null else {
            val holderValue = element.asSessionObject("$context holder", errorKind)
            val kind = holderValue.requiredString("clientKind", errorKind)
            if (kind !in CLIENT_KINDS) invalid(errorKind, "$context holder has an invalid clientKind")
            AppServerInteractionLeaseHolder(
                clientId = holderValue.requiredString("clientId", errorKind),
                clientKind = kind,
                name = holderValue.requiredString("name", errorKind),
            )
        }
    }
    val expiresAt = lease.optionalString("expiresAt", "$context expiresAt", errorKind)
    return AppServerInteractionLease(status, generation, holder, expiresAt)
}

private fun JsonObject.requireExactFields(fields: Set<String>, context: String) {
    requireFields(required = fields, optional = emptySet(), context = context)
}

private fun JsonObject.requireFields(required: Set<String>, optional: Set<String>, context: String) {
    val missing = required - keys
    if (missing.isNotEmpty()) invalidResult("$context is missing required fields: ${missing.joinToString()}")
    val unexpected = keys - required - optional
    if (unexpected.isNotEmpty()) invalidResult("$context has unexpected fields: ${unexpected.joinToString()}")
}

private fun JsonElement.asIsoTimestamp(context: String): String {
    val primitive = this as? JsonPrimitive ?: invalidResult("$context must be an ISO-8601 timestamp")
    if (!primitive.isString || !ISO_8601_TIMESTAMP.matches(primitive.content)) {
        invalidResult("$context must be an ISO-8601 timestamp")
    }
    return primitive.content
}

private fun JsonObject.requiredEnum(name: String, allowed: Set<String>, context: String): String {
    val value = requiredString(name)
    if (value !in allowed) invalidResult("$context.$name must be one of: ${allowed.joinToString()}")
    return value
}

private fun JsonElement.requireObject(context: String): JsonObject = this as? JsonObject
    ?: invalidResult("$context must be an object")

private fun JsonElement.requireArray(context: String): JsonArray = this as? JsonArray
    ?: invalidResult("$context must be an array")

private fun JsonObject.requiredArray(name: String): JsonArray = this[name]?.requireArray(name)
    ?: invalidResult("$name must be an array")

private fun JsonObject.requiredObjectArray(name: String): List<JsonObject> = requiredArray(name).mapIndexed { index, element ->
    element.requireObject("$name[$index]")
}

private fun JsonElement.requireObjectArray(context: String): List<JsonObject> = requireArray(context).mapIndexed { index, element ->
    element.requireObject("$context[$index]")
}

private fun JsonObject.requiredBoolean(name: String): Boolean {
    val primitive = this[name] as? JsonPrimitive
    return primitive?.takeIf { !it.isString }?.booleanOrNull
        ?: invalidResult("Missing or invalid boolean field: $name")
}

private fun JsonObject.optionalString(name: String, context: String): String? {
    return optionalString(name, context, "invalid_result")
}

private fun JsonObject.optionalString(name: String, context: String, errorKind: String): String? {
    val element = this[name] ?: return null
    if (element === JsonNull) return null
    val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (value.isNullOrBlank()) invalid(errorKind, "$context must be a non-blank string")
    return value
}

/** `title` and `displayName` are plain strings on the public summary and
 * snapshot DTOs; blank values are valid there, unlike ids and enum members. */
private fun JsonObject.optionalLabel(name: String, context: String): String? {
    val element = this[name] ?: return null
    if (element === JsonNull) return null
    return (element as? JsonPrimitive)?.takeIf { it.isString }?.content ?: invalidResult("$context must be a string")
}

private fun JsonObject.optionalLong(name: String, context: String, minimum: Long): Long? {
    val element = this[name] ?: return null
    if (element === JsonNull) return null
    val value = (element as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
        ?: invalidResult("$context must be an integer")
    if (value < minimum || value > MAX_SAFE_REVISION) invalidResult("$context is outside the safe integer range")
    return value
}

/** Workspace-relative POSIX path: no leading "/" and no ".." segment, mirroring
 * the app-server-protocol package's workspaceRelativePathSchema. */
private fun requireWorkspaceRelativePath(path: String, context: String) {
    if (path.isBlank() || path.startsWith("/") || path.split("/").any { it == ".." }) {
        invalidResult("$context must be a workspace-relative POSIX path")
    }
}

private fun JsonObject.requiredLabel(name: String, context: String): String =
    optionalLabel(name, context) ?: invalidResult("Missing or invalid string field: $name")

private fun JsonElement.notificationObject(context: String): JsonObject = this as? JsonObject
    ?: invalidNotification("$context must be an object")

private fun JsonObject.notificationArray(name: String): JsonArray = this[name] as? JsonArray
    ?: invalidNotification("$name must be an array")

private fun JsonElement.asSessionObject(context: String, errorKind: String): JsonObject = this as? JsonObject
    ?: invalid(errorKind, "$context must be an object")

private fun requireWireString(value: String, field: String) {
    if (value.isBlank()) throw AppServerProtocolException("invalid_params", "$field must be a non-blank string")
}

private fun requirePermissionMode(mode: String) {
    if (mode !in PERMISSION_MODES) {
        throw AppServerProtocolException("invalid_params", "mode must be one of: ${PERMISSION_MODES.joinToString()}")
    }
}

// The policy lease generation is a positive integer on the wire, unlike
// revisions, which start at zero.
private fun requireSessionControlGeneration(generation: Long) {
    requirePositiveInteger(generation, "leaseGeneration")
}

private fun JsonObjectBuilder.putSessionControlLease(generation: Long) {
    putJsonObject("lease") {
        put("scope", SessionInteractionLeaseScope.SESSION_CONTROL.wireName)
        put("generation", generation)
    }
}

// The plan face's lease scope is pinned to composer by the wire contract.
private fun JsonObjectBuilder.putComposerLease(generation: Long) {
    putJsonObject("lease") {
        put("scope", SessionInteractionLeaseScope.COMPOSER.wireName)
        put("generation", generation)
    }
}

private fun requireRevision(value: Long, field: String, errorKind: String = "invalid_params") {
    if (value !in 0..MAX_SAFE_REVISION) throw AppServerProtocolException(errorKind, "$field must be a non-negative safe integer")
}

private fun requirePositiveInteger(value: Long, field: String) {
    if (value !in 1..MAX_SAFE_REVISION) {
        throw AppServerProtocolException("invalid_params", "$field must be a positive safe integer")
    }
}

private fun invalidResult(message: String): Nothing = throw AppServerProtocolException("invalid_result", message)

private fun invalidNotification(message: String): Nothing = throw AppServerProtocolException("invalid_params", message)

private fun invalid(errorKind: String, message: String): Nothing = throw AppServerProtocolException(errorKind, message)

private const val MAX_SAFE_REVISION = 9_007_199_254_740_991L
