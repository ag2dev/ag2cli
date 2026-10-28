package com.ag2dev.ag2cli.mobile.core.session

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerNotification
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcClientState
import com.ag2dev.ag2cli.mobile.core.protocol.decodeResyncRequiredNotification
import com.ag2dev.ag2cli.mobile.core.protocol.requiredLong
import com.ag2dev.ag2cli.mobile.core.protocol.requiredString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

data class AppServerSessionState(
    val sessionId: String? = null,
    val isLoading: Boolean = false,
    /** Authoritative attach snapshot; its revision can be behind [lastRevision]. */
    val snapshot: JsonObject? = null,
    val lastRevision: Long = 0,
    /** Durable public events through [lastRevision]: replayed history plus live delivery. */
    val events: List<CanonicalSessionEvent> = emptyList(),
    val transientEvents: List<JsonObject> = emptyList(),
    val presence: AppServerSessionPresence? = null,
    val needsResync: Boolean = false,
    val connectionClosed: Boolean = false,
    val minimumRevisionToResync: Long? = null,
    val notificationOverflow: Boolean = false,
    /** Unknown critical event types the current projection cannot apply. */
    val unknownCriticalEventTypes: Set<String> = emptySet(),
    /** Writes are refused until a clean rebuild removes the unknown criticals. */
    val degraded: Boolean = false,
    val lastErrorKind: String? = null,
)

/** Coordinates attach, replay, live notifications, and explicit recovery for one visible Session. */
class AppServerSessionController(
    private val api: AppServerSessionApi,
) {
    private val mutableState = MutableStateFlow(AppServerSessionState())
    private val stateMutex = Mutex()
    private val operationMutex = Mutex()
    private val bufferedNotifications = ArrayList<AppServerNotification>()

    private var projection: SessionProjection? = null
    private var collectorJob: Job? = null
    private var rpcStateJob: Job? = null
    private var controllerScope: CoroutineScope? = null
    private var resyncJob: Job? = null
    private var synchronizing = false
    private var bufferOverflowed = false
    private var sessionDegraded = false

    val state: StateFlow<AppServerSessionState> = mutableState.asStateFlow()

    /** Starts notification collection before any attach request can install a server subscription. */
    fun start(scope: CoroutineScope) {
        check(collectorJob == null) { "Session notification collection has already started" }
        controllerScope = scope
        collectorJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                api.notifications.collect(::handleNotification)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                stateMutex.withLock {
                    mutableState.value = mutableState.value.copy(lastErrorKind = errorKind(error))
                }
            }
        }
        rpcStateJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            api.rpcState.collect(::handleRpcState)
        }
    }

    suspend fun attachSession(sessionId: String) {
        requireSessionId(sessionId)
        operationMutex.withLock {
            requireCollector()
            val previousSessionId = mutableState.value.sessionId
            if (previousSessionId != null && previousSessionId != sessionId) {
                try {
                    api.detachSession(previousSessionId)
                } catch (error: Exception) {
                    withContext(NonCancellable) {
                        stateMutex.withLock {
                            if (mutableState.value.sessionId == previousSessionId) {
                                mutableState.value = mutableState.value.copy(
                                    isLoading = false,
                                    needsResync = true,
                                    lastErrorKind = errorKind(error),
                                )
                            }
                        }
                    }
                    throw error
                }
            }
            beginSynchronization(sessionId)
            try {
                synchronize(sessionId, resyncFirst = false)
            } catch (error: CancellationException) {
                failSynchronization(sessionId, error)
                throw error
            } catch (error: Exception) {
                failSynchronization(sessionId, error)
                throw error
            }
        }
    }

    /** Re-establishes the subscription and rebuilds the in-memory timeline from authoritative history. */
    suspend fun resync() {
        operationMutex.withLock {
            requireCollector()
            val sessionId = mutableState.value.sessionId
                ?: throw AppServerProtocolException("invalid_state", "No Session is attached")
            beginSynchronization(sessionId)
            try {
                synchronize(sessionId, resyncFirst = true)
            } catch (error: CancellationException) {
                failSynchronization(sessionId, error)
                throw error
            } catch (error: Exception) {
                failSynchronization(sessionId, error)
                throw error
            }
        }
    }

    suspend fun detachSession(): Boolean {
        operationMutex.withLock {
            requireCollector()
            val sessionId = mutableState.value.sessionId ?: return false
            beginSynchronization(sessionId)
            try {
                val detached = api.detachSession(sessionId)
                stateMutex.withLock {
                    synchronizing = false
                    bufferOverflowed = false
                    bufferedNotifications.clear()
                    projection = null
                    sessionDegraded = false
                    api.clearSessionDegraded(sessionId)
                    mutableState.value = AppServerSessionState()
                }
                return detached
            } catch (error: CancellationException) {
                failSynchronization(sessionId, error)
                throw error
            } catch (error: Exception) {
                failSynchronization(sessionId, error)
                throw error
            }
        }
    }

    suspend fun stop(detachServerSubscription: Boolean = true) {
        controllerScope = null
        try {
            resyncJob?.cancelAndJoin()
            resyncJob = null
            if (
                detachServerSubscription &&
                mutableState.value.sessionId != null &&
                !mutableState.value.connectionClosed
            ) {
                try {
                    detachSession()
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    if (!api.rpcState.value.isClosed && !mutableState.value.connectionClosed) throw error
                }
            }
        } finally {
            collectorJob?.cancelAndJoin()
            collectorJob = null
            // Notifications can schedule a new resync while stop is detaching the server subscription.
            resyncJob?.cancelAndJoin()
            resyncJob = null
            rpcStateJob?.cancelAndJoin()
            rpcStateJob = null
            // The controller's verdicts stop applying once it stops, so the
            // registry must not keep a stale entry for the last Session.
            stateMutex.withLock {
                mutableState.value.sessionId?.let { sessionId ->
                    sessionDegraded = false
                    api.clearSessionDegraded(sessionId)
                }
            }
        }
    }

    private suspend fun beginSynchronization(sessionId: String) {
        stateMutex.withLock {
            val sameSession = mutableState.value.sessionId == sessionId
            val rpcState = api.rpcState.value
            val connectionClosed = rpcState.isClosed
            val terminalErrorKind = if (connectionClosed) rpcState.terminalErrorKind ?: "client_closed" else null
            synchronizing = true
            bufferOverflowed = false
            bufferedNotifications.clear()
            if (!sameSession) {
                // The abandoned Session's degraded entry must not outlive this
                // controller's interest in it; this Session's verdict is
                // recomputed after its own rebuild.
                mutableState.value.sessionId?.let { previousSessionId ->
                    sessionDegraded = false
                    api.clearSessionDegraded(previousSessionId)
                }
                projection = null
            }
            mutableState.value = if (sameSession) {
                mutableState.value.copy(
                    isLoading = true,
                    connectionClosed = connectionClosed,
                    lastErrorKind = terminalErrorKind,
                    notificationOverflow = false,
                )
            } else {
                AppServerSessionState(
                    sessionId = sessionId,
                    isLoading = true,
                    connectionClosed = connectionClosed,
                    lastErrorKind = terminalErrorKind,
                )
            }
        }
    }

    private suspend fun synchronize(sessionId: String, resyncFirst: Boolean) {
        var attachedToServer = false
        try {
            val currentState = mutableState.value
            val requiredMinimumRevision = maxOf(
                currentState.minimumRevisionToResync ?: 0L,
                currentState.lastRevision.takeIf { currentState.sessionId == sessionId } ?: 0L,
            )
            val resyncResult = if (resyncFirst) api.resyncSession(sessionId) else null
            val resyncRevision = resyncResult?.snapshot?.requiredLong("asOfRevision")
            if (resyncRevision != null && resyncRevision < requiredMinimumRevision) {
                throw AppServerProtocolException(
                    "incomplete_resync",
                    "Session resync snapshot is behind the current recovery floor",
                )
            }
            val attached = api.attachSession(sessionId)
            attachedToServer = true
            if (resyncRevision != null && attached.barrierRevision < resyncRevision) {
                throw AppServerProtocolException("invalid_result", "session.attach snapshot is behind the resync snapshot")
            }
            if (attached.barrierRevision < requiredMinimumRevision) {
                throw AppServerProtocolException("incomplete_resync", "Session attach snapshot is behind the required revision")
            }

            val newProjection = SessionProjection(sessionId)
            newProjection.applySnapshot(attached.snapshot)
            // Snapshot-first: replay pages rebuild the timeline strictly after revision 0,
            // deduplicated against the snapshot baseline; paging continues while the host
            // reports more, and live delivery resumes past the barrier afterwards.
            val replayedEvents = ArrayList<JsonObject>()
            var afterRevision = 0L
            while (true) {
                val page = api.replaySession(sessionId, afterRevision = afterRevision)
                replayedEvents += page.events
                if (!page.hasMore) break
                val next = page.nextAfterRevision
                    ?: throw AppServerProtocolException("invalid_result", "Session replay page claims more events without a continuation cursor")
                if (next <= afterRevision) {
                    throw AppServerProtocolException("invalid_result", "Session replay page does not advance its continuation cursor")
                }
                afterRevision = next
            }
            newProjection.applyEvents(replayedEvents)
            if (newProjection.state.lastRevision < requiredMinimumRevision) {
                throw AppServerProtocolException("incomplete_resync", "Session replay did not reach the required revision")
            }

            var shouldScheduleResync = false
            stateMutex.withLock {
                projection = newProjection
                synchronizing = false
                mutableState.value = AppServerSessionState(
                    sessionId = sessionId,
                    isLoading = false,
                    snapshot = attached.snapshot,
                    lastErrorKind = if (bufferOverflowed) "notification_overflow" else null,
                )
                publishProjection()
                val buffered = bufferedNotifications.toList()
                bufferedNotifications.clear()
                buffered.forEach { shouldScheduleResync = applyNotificationLocked(it) || shouldScheduleResync }
                shouldScheduleResync = shouldScheduleResync || mutableState.value.needsResync
                // The rebuild is the degradation verdict: unknown criticals that
                // survive it degrade the Session, a clean rebuild lifts it.
                sessionDegraded = newProjection.state.unknownCriticalEventTypes.isNotEmpty()
                if (sessionDegraded) api.markSessionDegraded(sessionId) else api.clearSessionDegraded(sessionId)
                publishProjection()
            }
            if (shouldScheduleResync && !resyncFirst) scheduleResync()
        } catch (error: Exception) {
            if (attachedToServer) detachAfterFailedSynchronization(sessionId)
            throw error
        }
    }

    private suspend fun detachAfterFailedSynchronization(sessionId: String) {
        try {
            withContext(NonCancellable) {
                withTimeoutOrNull(1_000) { api.detachSession(sessionId) }
            }
        } catch (_: Exception) {
            // Cleanup is bounded; preserve the synchronization error for the caller.
        }
    }

    private suspend fun failSynchronization(sessionId: String, error: Throwable) {
        withContext(NonCancellable) {
            stateMutex.withLock {
                synchronizing = false
                val rpcState = api.rpcState.value
                val connectionClosed = mutableState.value.connectionClosed || rpcState.isClosed
                val terminalErrorKind = if (rpcState.isClosed) {
                    rpcState.terminalErrorKind ?: "client_closed"
                } else {
                    null
                }
                if (mutableState.value.sessionId == sessionId) {
                    if (!bufferOverflowed) bufferedNotifications.toList().forEach(::applyNotificationLocked)
                    bufferedNotifications.clear()
                    mutableState.value = mutableState.value.copy(
                        isLoading = false,
                        needsResync = true,
                        connectionClosed = connectionClosed,
                        notificationOverflow = bufferOverflowed,
                        lastErrorKind = terminalErrorKind ?: errorKind(error),
                    )
                    publishProjection()
                } else {
                    bufferedNotifications.clear()
                }
            }
        }
    }

    private suspend fun handleNotification(notification: AppServerNotification) {
        if (notification.method !in HANDLED_NOTIFICATION_METHODS) return
        var shouldScheduleResync = false
        try {
            val sessionId = notificationSessionId(notification)
            stateMutex.withLock {
                if (mutableState.value.sessionId != sessionId) return@withLock
                if (synchronizing) {
                    if (!bufferOverflowed) {
                        if (bufferedNotifications.size >= MAX_BUFFERED_NOTIFICATIONS) {
                            bufferedNotifications.clear()
                            bufferOverflowed = true
                            mutableState.value = mutableState.value.copy(
                                needsResync = true,
                                notificationOverflow = true,
                                lastErrorKind = "notification_overflow",
                            )
                        } else {
                            bufferedNotifications += notification
                        }
                    }
                } else {
                    shouldScheduleResync = applyNotificationLocked(notification)
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            stateMutex.withLock {
                val canRecover = notification.method == "session.event" || notification.method == "session.resyncRequired"
                if (canRecover && synchronizing) {
                    bufferMalformedNotificationLocked(notification)
                } else if (canRecover) {
                    shouldScheduleResync = markMalformedSessionNotificationLocked(notification, errorKind(error))
                }
                if (mutableState.value.sessionId != null) {
                    mutableState.value = mutableState.value.copy(lastErrorKind = errorKind(error))
                }
                if (shouldScheduleResync) publishProjection()
            }
        }
        if (shouldScheduleResync) scheduleResync()
    }

    private fun applyNotificationLocked(notification: AppServerNotification): Boolean {
        try {
            val params = notification.params ?: invalidNotification("${notification.method} is missing params")
            var shouldScheduleResync = false
            when (notification.method) {
                "session.event" -> {
                    val eventParams = params.asSessionObject("session.event params")
                    val currentProjection = projection
                    currentProjection?.applyLiveEvent(eventParams)
                    // An unknown critical event resyncs first; once degraded,
                    // further unknowns are expected and the stream stays live.
                    val currentSessionId = mutableState.value.sessionId
                    if (
                        !sessionDegraded && currentSessionId != null && currentProjection != null &&
                        currentProjection.state.unknownCriticalEventTypes.isNotEmpty()
                    ) {
                        currentProjection.markResyncRequired(currentSessionId, currentProjection.state.lastRevision)
                        shouldScheduleResync = true
                    }
                }
                "session.transient" -> {
                    // Transient streaming is lossy by design: a malformed transient is
                    // skipped without disturbing session state or the connection.
                    runCatching {
                        val objectParams = params.asSessionObject("session.transient params")
                        val sessionId = notificationSessionId(notification)
                        val event = objectParams["event"]
                            ?: invalidNotification("session.transient is missing its event")
                        projection?.applyTransient(sessionId, event)
                    }
                }
                "session.resyncRequired" -> {
                    val resync = decodeResyncRequiredNotification(params)
                    projection?.markResyncRequired(resync)
                    shouldScheduleResync = true
                }
                "presence.updated" -> {
                    val update = api.decodePresenceUpdate(params)
                    mutableState.value = mutableState.value.copy(
                        presence = AppServerSessionPresence(update.clients, update.leases),
                    )
                }
                "interaction.lease.updated" -> {
                    val update = api.decodeInteractionLeaseUpdate(params)
                    mutableState.value = mutableState.value.copy(
                        presence = (mutableState.value.presence ?: AppServerSessionPresence(emptyList(), update.leases))
                            .copy(leases = update.leases),
                    )
                }
            }
            publishProjection()
            return shouldScheduleResync
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            mutableState.value = mutableState.value.copy(lastErrorKind = errorKind(error))
            val shouldScheduleResync = (notification.method == "session.event" || notification.method == "session.resyncRequired") &&
                markMalformedSessionNotificationLocked(notification, errorKind(error))
            if (shouldScheduleResync) publishProjection()
            return shouldScheduleResync
        }
    }

    private suspend fun handleRpcState(rpcState: AppServerRpcClientState) {
        if (!rpcState.isClosed) return
        stateMutex.withLock {
            val current = mutableState.value
            mutableState.value = current.copy(
                isLoading = false,
                needsResync = current.needsResync || current.sessionId != null,
                connectionClosed = true,
                lastErrorKind = rpcState.terminalErrorKind ?: "client_closed",
            )
            publishProjection()
        }
    }

    private fun markMalformedSessionNotificationLocked(notification: AppServerNotification, errorKind: String): Boolean {
        val current = mutableState.value
        val sessionId = current.sessionId ?: return false
        val params = notification.params as? JsonObject ?: return false
        // A malformed notification still carries its identity in the envelope fields this
        // cheap extraction can reach; anything unreadable keeps the last known floor.
        val (notifiedSessionId, reportedRevision) = when (notification.method) {
            "session.event" -> {
                val event = params["event"] as? JsonObject ?: return false
                event.stringField("sessionId") to event.numberField("revision")
            }
            "session.resyncRequired" -> {
                params.stringField("sessionId") to params.numberField("minimumRevision")
            }
            else -> return false
        }
        if (notifiedSessionId != null && notifiedSessionId != sessionId) return false
        val minimumRevision = maxOf(
            current.minimumRevisionToResync ?: 0L,
            current.lastRevision,
            reportedRevision ?: current.lastRevision,
        )
        projection?.markResyncRequired(sessionId, minimumRevision)
        mutableState.value = current.copy(
            needsResync = true,
            minimumRevisionToResync = minimumRevision,
            lastErrorKind = errorKind,
        )
        return true
    }

    private fun JsonObject.stringField(name: String): String? =
        (this[name] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content

    private fun JsonObject.numberField(name: String): Long? =
        (this[name] as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.longOrNull
            ?.takeIf { it in 0..MAX_SAFE_REVISION }

    private fun bufferMalformedNotificationLocked(notification: AppServerNotification) {
        if (bufferOverflowed) return
        if (bufferedNotifications.size >= MAX_BUFFERED_NOTIFICATIONS) {
            bufferedNotifications.clear()
            bufferOverflowed = true
            mutableState.value = mutableState.value.copy(
                needsResync = true,
                notificationOverflow = true,
                lastErrorKind = "notification_overflow",
            )
        } else {
            bufferedNotifications += notification
        }
    }

    private fun scheduleResync(automaticFollowUpsRemaining: Int = 1) {
        if (resyncJob?.isActive == true) return
        val scope = controllerScope ?: return
        resyncJob = scope.launch {
            var synchronized = false
            try {
                resync()
                synchronized = true
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                // The StateFlow retains the failure and recovery cursor for an explicit retry.
            } finally {
                resyncJob = null
                // A recovery floor can move while notifications are buffered. Allow one
                // coalesced follow-up, but keep a persistently moving session from retrying forever.
                if (synchronized && mutableState.value.needsResync && automaticFollowUpsRemaining > 0) {
                    scheduleResync(automaticFollowUpsRemaining - 1)
                }
            }
        }
    }

    private fun publishProjection() {
        val current = mutableState.value
        val projectionState = projection?.state
        mutableState.value = current.copy(
            lastRevision = projectionState?.lastRevision ?: current.lastRevision,
            events = projectionState?.events ?: current.events,
            transientEvents = projectionState?.transientEvents ?: current.transientEvents,
            needsResync = bufferOverflowed || projectionState?.needsResync == true || current.needsResync,
            minimumRevisionToResync = projectionState?.minimumRevisionToResync ?: current.minimumRevisionToResync,
            notificationOverflow = bufferOverflowed,
            unknownCriticalEventTypes = projectionState?.unknownCriticalEventTypes
                ?: current.unknownCriticalEventTypes,
            degraded = sessionDegraded,
        )
    }

    private suspend fun requireCollector() {
        check(collectorJob?.isActive == true) { "Start the Session controller before using it" }
    }

    private fun notificationSessionId(notification: AppServerNotification): String {
        val params = notification.params?.asSessionObject("${notification.method} params")
            ?: invalidNotification("${notification.method} is missing params")
        if (params.containsKey("sessionId")) return params.requiredString("sessionId", "invalid_params")
        // v1 session.event and session.transient route by the wrapped event's own sessionId.
        if (notification.method == "session.event" || notification.method == "session.transient") {
            val event = params["event"]?.asSessionObject("${notification.method} event")
                ?: invalidNotification("${notification.method} is missing its event")
            return event.requiredString("sessionId", "invalid_params")
        }
        invalidNotification("${notification.method} params are missing sessionId")
    }

    private fun requireSessionId(sessionId: String) {
        if (sessionId.isBlank()) throw AppServerProtocolException("invalid_params", "Session ID must be non-blank")
    }

    private fun errorKind(error: Throwable): String {
        (error as? AppServerProtocolException)?.let { return it.kind }
        val rpcState = api.rpcState.value
        if (rpcState.isClosed) return rpcState.terminalErrorKind ?: "client_closed"
        return "session_sync_failed"
    }

    private fun invalidNotification(message: String): Nothing =
        throw AppServerProtocolException("invalid_params", message)

    private fun JsonElement.asSessionObject(context: String): JsonObject = this as? JsonObject
        ?: invalidNotification("$context must be an object")

    private companion object {
        const val MAX_BUFFERED_NOTIFICATIONS = 512
        const val MAX_SAFE_REVISION = 9_007_199_254_740_991L
        val HANDLED_NOTIFICATION_METHODS = setOf(
            "session.event",
            "session.transient",
            "session.resyncRequired",
            "presence.updated",
            "interaction.lease.updated",
        )
    }
}
