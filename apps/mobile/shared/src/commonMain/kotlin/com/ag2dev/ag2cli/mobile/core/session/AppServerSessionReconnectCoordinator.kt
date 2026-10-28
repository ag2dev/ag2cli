package com.ag2dev.ag2cli.mobile.core.session

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

interface AppServerSessionConnection {
    val state: StateFlow<AppServerSessionState>

    suspend fun listSessions(): List<AppServerSessionRecord>

    suspend fun attachSession(sessionId: String)

    /** Releases the session controller and all resources owned by this connection. */
    suspend fun close()
}

/**
 * Implementations must report retryable transport failures as
 * [AppServerProtocolException] with a retryable transport kind.
 */
fun interface AppServerSessionConnectionFactory {
    suspend fun connect(scope: CoroutineScope): AppServerSessionConnection
}

enum class AppServerSessionConnectionPhase {
    STOPPED,
    CONNECTING,
    REPLAYING,
    CONNECTED,
    RECONNECTING,
    FAILED,
}

data class AppServerSessionReconnectState(
    val phase: AppServerSessionConnectionPhase = AppServerSessionConnectionPhase.STOPPED,
    val session: AppServerSessionState = AppServerSessionState(),
    val reconnectAttempt: Int = 0,
    val failureKind: String? = null,
)

/** Recreates a terminal client and restores the selected Session from authoritative replay. */
class AppServerSessionReconnectCoordinator(
    private val sessionId: String,
    private val connectionFactory: AppServerSessionConnectionFactory,
    private val initialBackoffMillis: Long = DEFAULT_INITIAL_BACKOFF_MILLIS,
    private val maximumBackoffMillis: Long = DEFAULT_MAXIMUM_BACKOFF_MILLIS,
) {
    private val mutableState = MutableStateFlow(AppServerSessionReconnectState())
    private val lifecycleMutex = Mutex()
    private var reconnectJob: Job? = null

    val state: StateFlow<AppServerSessionReconnectState> = mutableState.asStateFlow()

    init {
        require(sessionId.isNotBlank()) { "Session ID must be non-blank" }
        require(initialBackoffMillis > 0) { "initialBackoffMillis must be positive" }
        require(maximumBackoffMillis >= initialBackoffMillis) {
            "maximumBackoffMillis must be at least initialBackoffMillis"
        }
    }

    suspend fun start(scope: CoroutineScope) {
        lifecycleMutex.withLock {
            check(reconnectJob?.isActive != true) { "Session reconnect coordinator is already running" }
            reconnectJob = scope.launch { runLoop(scope) }
        }
    }

    suspend fun stop() {
        lifecycleMutex.withLock {
            reconnectJob?.cancelAndJoin()
            reconnectJob = null
            mutableState.update { it.copy(phase = AppServerSessionConnectionPhase.STOPPED) }
        }
    }

    private suspend fun runLoop(scope: CoroutineScope) {
        try {
            runConnectionLoop(scope)
        } catch (error: CancellationException) {
            mutableState.update { it.copy(phase = AppServerSessionConnectionPhase.STOPPED) }
            throw error
        }
    }

    private suspend fun runConnectionLoop(scope: CoroutineScope) {
        var reconnectAttempt = 0
        var backoffMillis = initialBackoffMillis

        while (true) {
            mutableState.update { current ->
                current.copy(
                    phase = if (reconnectAttempt == 0) {
                        AppServerSessionConnectionPhase.CONNECTING
                    } else {
                        AppServerSessionConnectionPhase.RECONNECTING
                    },
                    reconnectAttempt = reconnectAttempt,
                    failureKind = null,
                )
            }

            var connection: AppServerSessionConnection? = null
            var stateJob: Job? = null
            var terminalFailureKind: String? = null
            try {
                connection = connectionFactory.connect(scope)
                val activeConnection = connection
                stateJob = scope.launch {
                    activeConnection.state.collect { publishSessionState(activeConnection) }
                }
                mutableState.update { it.copy(phase = AppServerSessionConnectionPhase.REPLAYING) }
                connection.attachSession(sessionId)
                mutableState.update { current ->
                    current.copy(
                        phase = AppServerSessionConnectionPhase.CONNECTED,
                        session = activeConnection.state.value,
                        reconnectAttempt = 0,
                        failureKind = null,
                    )
                }
                reconnectAttempt = 0
                backoffMillis = initialBackoffMillis
                val closedSession = connection.state.first { it.connectionClosed }
                terminalFailureKind = closedSession.lastErrorKind ?: "transport_closed"
                if (!isRetryableKind(terminalFailureKind)) {
                    mutableState.update { current ->
                        current.copy(
                            phase = AppServerSessionConnectionPhase.FAILED,
                            session = closedSession,
                            failureKind = terminalFailureKind,
                        )
                    }
                    return
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                val closedSession = connection?.state?.value?.takeIf { it.connectionClosed }
                terminalFailureKind = closedSession?.lastErrorKind ?: errorKind(error)
                val retryable = if (closedSession != null) {
                    isRetryableKind(terminalFailureKind)
                } else {
                    isRetryable(error)
                }
                if (!retryable) {
                    mutableState.update { current ->
                        current.copy(
                            phase = AppServerSessionConnectionPhase.FAILED,
                            session = closedSession ?: connection?.state?.value ?: current.session,
                            failureKind = terminalFailureKind,
                        )
                    }
                    return
                }
            } finally {
                withContext(NonCancellable) {
                    stateJob?.cancelAndJoin()
                    try {
                        connection?.close()
                    } catch (_: Exception) {
                        // Preserve the connection failure; cleanup is best-effort.
                    }
                }
            }

            reconnectAttempt += 1
            mutableState.update { current ->
                current.copy(
                    phase = AppServerSessionConnectionPhase.RECONNECTING,
                    session = connection?.state?.value ?: current.session,
                    reconnectAttempt = reconnectAttempt,
                    failureKind = terminalFailureKind,
                )
            }
            delay(backoffMillis)
            backoffMillis = if (backoffMillis > maximumBackoffMillis / 2) {
                maximumBackoffMillis
            } else {
                (backoffMillis * 2).coerceAtMost(maximumBackoffMillis)
            }
        }
    }

    private fun publishSessionState(connection: AppServerSessionConnection) {
        mutableState.update { current ->
            val session = connection.state.value
            val phase = when {
                current.phase == AppServerSessionConnectionPhase.FAILED -> current.phase
                session.connectionClosed -> AppServerSessionConnectionPhase.RECONNECTING
                session.isLoading -> AppServerSessionConnectionPhase.REPLAYING
                else -> current.phase
            }
            current.copy(phase = phase, session = session)
        }
    }

    private fun isRetryable(error: Throwable): Boolean = when (error) {
        is AppServerProtocolException -> isRetryableKind(error.kind)
        is AppServerRpcException -> error.retryable
        else -> false
    }

    private fun isRetryableKind(kind: String): Boolean = kind in RETRYABLE_FAILURE_KINDS

    private fun errorKind(error: Throwable): String = when (error) {
        is AppServerProtocolException -> error.kind
        is AppServerRpcException -> error.kind ?: "rpc_error"
        else -> "session_sync_failed"
    }

    private companion object {
        const val DEFAULT_INITIAL_BACKOFF_MILLIS = 1_000L
        const val DEFAULT_MAXIMUM_BACKOFF_MILLIS = 30_000L
        val RETRYABLE_FAILURE_KINDS = setOf(
            "request_timeout",
            "transport_closed",
            "transport_failed",
            "notification_overflow",
        )
    }
}
