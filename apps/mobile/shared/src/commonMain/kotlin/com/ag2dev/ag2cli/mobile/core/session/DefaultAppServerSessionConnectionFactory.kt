package com.ag2dev.ag2cli.mobile.core.session

import com.ag2dev.ag2cli.mobile.core.identity.AppServerHostTrust
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerClientInfo
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerClientKind
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerDeviceAuth
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerDeviceChallenge
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerHostProofPurpose
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcClient
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerScope
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerTransport
import com.ag2dev.ag2cli.mobile.core.protocol.DeviceServerInitializeAuth
import com.ag2dev.ag2cli.mobile.core.protocol.ServerInitializeParams
import com.ag2dev.ag2cli.mobile.core.protocol.signAppServerDeviceChallenge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.io.IOException

fun interface AppServerSessionTransportProvider {
    suspend fun connect(): AppServerTransport
}

/** Builds a read-only Session connection after same-socket Host and device proof verification. */
class DefaultAppServerSessionConnectionFactory(
    private val client: AppServerClientInfo,
    private val expectedHostId: String,
    private val deviceId: String,
    private val credential: String,
    private val signer: com.ag2dev.ag2cli.mobile.core.protocol.AppServerDeviceProofSigner,
    private val hostTrust: AppServerHostTrust,
    private val transportProvider: AppServerSessionTransportProvider,
    private val requestTimeoutMillis: Long = DEFAULT_REQUEST_TIMEOUT_MILLIS,
) : AppServerSessionConnectionFactory {
    init {
        require(client.clientKind == AppServerClientKind.MOBILE) { "Mobile connections must use the mobile client kind" }
        require(client.clientId.isNotBlank()) { "Mobile client ID must be non-blank" }
        require(expectedHostId.isNotBlank()) { "Paired Host ID must be non-blank" }
        require(deviceId.isNotBlank()) { "Paired device ID must be non-blank" }
        require(credential.isNotBlank()) { "Paired device credential must be non-blank" }
        require(requestTimeoutMillis > 0) { "requestTimeoutMillis must be positive" }
    }

    override suspend fun connect(scope: CoroutineScope): AppServerSessionConnection {
        val transport = connectTransport()
        val rpc = AppServerRpcClient(transport, requestTimeoutMillis)
        try {
            rpc.start(scope)
            val preflight = rpc.preflight(hostTrust, expectedHostId, AppServerHostProofPurpose.DEVICE_CONNECT)
            val challenge = preflight.deviceChallenge
                ?: throw AppServerProtocolException("device_proof_unavailable", "Device preflight did not include a challenge")
            val challengeExpiresAt = preflight.deviceChallengeExpiresAt
                ?: throw AppServerProtocolException("device_proof_unavailable", "Device preflight did not include a challenge expiry")
            val proof = signAppServerDeviceChallenge(
                AppServerDeviceChallenge(challenge, preflight.hostId, challengeExpiresAt),
                deviceId,
                client.clientId,
                signer,
            )
            val initialized = rpc.initialize(
                ServerInitializeParams(
                    hostId = preflight.hostId,
                    client = client,
                    auth = DeviceServerInitializeAuth(
                        AppServerDeviceAuth(
                            deviceId = proof.deviceId,
                            challenge = proof.challenge,
                            signature = proof.signature,
                            credential = credential,
                        ),
                    ),
                    requestedScopes = listOf(AppServerScope.SESSION_READ),
                ),
            )
            if (initialized.connection.scopes != listOf(AppServerScope.SESSION_READ)) {
                throw AppServerProtocolException(
                    "unexpected_scope_grant",
                    "App Server did not grant exactly the requested session:read scope",
                )
            }

            val api = AppServerSessionApi(rpc, initialized)
            val controller = AppServerSessionController(api)
            controller.start(scope)
            return DefaultAppServerSessionConnection(rpc, api, controller)
        } catch (error: CancellationException) {
            closeAfterFailure(rpc)
            throw error
        } catch (error: Throwable) {
            closeAfterFailure(rpc)
            throw error
        }
    }

    private suspend fun connectTransport(): AppServerTransport = try {
        transportProvider.connect()
    } catch (error: CancellationException) {
        throw error
    } catch (error: IOException) {
        throw AppServerProtocolException("transport_failed", "Could not open the App Server connection", error)
    }

    private suspend fun closeAfterFailure(rpc: AppServerRpcClient) {
        withContext(NonCancellable) {
            try {
                rpc.close()
            } catch (_: Throwable) {
                // Preserve the connection setup failure if transport cleanup also fails.
            }
        }
    }

    private companion object {
        const val DEFAULT_REQUEST_TIMEOUT_MILLIS = 30_000L
    }
}

private class DefaultAppServerSessionConnection(
    private val rpc: AppServerRpcClient,
    private val api: AppServerSessionApi,
    private val controller: AppServerSessionController,
) : AppServerSessionConnection {
    private val closeMutex = Mutex()
    private var closed = false

    override val state: StateFlow<AppServerSessionState> = controller.state

    override suspend fun listSessions(): List<AppServerSessionRecord> = api.listSessions()

    override suspend fun attachSession(sessionId: String) = controller.attachSession(sessionId)

    override suspend fun close() {
        closeMutex.withLock {
            if (closed) return
            closed = true
            withContext(NonCancellable) {
                try {
                    controller.stop(detachServerSubscription = false)
                } finally {
                    rpc.close()
                }
            }
        }
    }
}
