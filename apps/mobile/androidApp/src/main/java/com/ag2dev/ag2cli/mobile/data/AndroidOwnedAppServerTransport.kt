package com.ag2dev.ag2cli.mobile.data

import com.ag2dev.ag2cli.mobile.core.protocol.AppServerTransport
import com.ag2dev.ag2cli.mobile.core.protocol.KtorAppServerWebSocketTransport
import io.ktor.client.HttpClient
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Releases the Ktor client together with the WebSocket session it owns. */
internal class AndroidOwnedAppServerTransport(
    private val transport: KtorAppServerWebSocketTransport,
    private val client: HttpClient,
) : AppServerTransport {
    override val incomingMessages: Flow<String> = transport.incomingMessages
    private val closeMutex = Mutex()
    private var closed = false

    override suspend fun send(text: String) = transport.send(text)

    override suspend fun close() {
        closeMutex.withLock {
            if (closed) return
            closed = true
            try {
                transport.close()
            } finally {
                client.close()
            }
        }
    }
}
