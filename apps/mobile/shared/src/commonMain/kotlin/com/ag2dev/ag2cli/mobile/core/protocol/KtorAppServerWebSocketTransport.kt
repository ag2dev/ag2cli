package com.ag2dev.ag2cli.mobile.core.protocol

import io.ktor.client.HttpClient
import io.ktor.client.plugins.ResponseException
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.url
import kotlinx.io.IOException
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Unauthenticated WebSocket transport. Credentials are sent only in JSON-RPC initialize after Host proof.
 */
class KtorAppServerWebSocketTransport private constructor(
    private val session: DefaultClientWebSocketSession,
) : AppServerTransport {
    private val operationMutex = Mutex()
    private var closed = false

    override val incomingMessages: Flow<String> = flow {
        try {
            for (frame in session.incoming) {
                when (frame) {
                    is Frame.Text -> emit(frame.readText())
                    is Frame.Close -> break
                    else -> throw AppServerProtocolException(
                        "invalid_response",
                        "App Server WebSocket sent a non-text protocol frame",
                    )
                }
            }
        } finally {
            withContext(NonCancellable) { close() }
        }
    }

    override suspend fun send(text: String) {
        operationMutex.withLock {
            check(!closed) { "App Server transport is closed" }
            session.send(Frame.Text(text))
        }
    }

    override suspend fun close() {
        operationMutex.withLock {
            if (closed) return@withLock
            closed = true
            session.close(CloseReason(CloseReason.Codes.NORMAL, "Client closed"))
        }
    }

    companion object {
        /** The supplied client must have Ktor's WebSockets plugin installed. */
        suspend fun connect(
            client: HttpClient,
            endpoint: String,
        ): KtorAppServerWebSocketTransport {
            normalizeAppServerEndpoint(endpoint)
            val session = try {
                client.webSocketSession {
                    url(endpoint)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: ResponseException) {
                val status = error.response.status.value
                val retryable = status == 408 || status == 425 || status == 429 || status in 500..599
                throw AppServerProtocolException(
                    kind = if (retryable) "transport_failed" else "endpoint_rejected",
                    message = "App Server WebSocket endpoint rejected the connection",
                    cause = error,
                )
            } catch (error: IOException) {
                throw AppServerProtocolException(
                    "transport_failed",
                    "Could not establish the App Server WebSocket connection",
                    error,
                )
            }
            return KtorAppServerWebSocketTransport(session)
        }
    }
}
