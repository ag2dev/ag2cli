package com.ag2dev.ag2cli.mobile.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.websocket.WebSockets

/** Uses CIO's normal platform trust store; no trust-all TLS configuration is installed. */
fun createAndroidAppServerHttpClient(engine: HttpClientEngine = CIO.create()): HttpClient = HttpClient(engine) {
    followRedirects = false
    install(WebSockets) {
        pingIntervalMillis = WEBSOCKET_PING_INTERVAL_MILLIS
    }
    install(HttpTimeout) {
        connectTimeoutMillis = CONNECT_TIMEOUT_MILLIS
        requestTimeoutMillis = REQUEST_TIMEOUT_MILLIS
    }
}

private const val WEBSOCKET_PING_INTERVAL_MILLIS = 30_000L
private const val CONNECT_TIMEOUT_MILLIS = 15_000L
private const val REQUEST_TIMEOUT_MILLIS = 30_000L
