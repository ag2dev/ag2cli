package com.ag2dev.ag2cli.mobile.core.protocol

import com.ag2dev.ag2cli.mobile.core.identity.AppServerHostProofChallenge
import com.ag2dev.ag2cli.mobile.core.identity.AppServerHostTrust
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.encodeToJsonElement

interface AppServerTransport {
    val incomingMessages: Flow<String>

    suspend fun send(text: String)

    suspend fun close()
}

data class AppServerNotification(
    val method: String,
    val params: JsonElement?,
)

data class AppServerRpcClientState(
    val isClosed: Boolean = false,
    val terminalErrorKind: String? = null,
)

class AppServerRpcClient(
    private val transport: AppServerTransport,
    private val requestTimeoutMillis: Long = 30_000,
) {
    private val mutex = Mutex()
    private val pendingRequests = mutableMapOf<Long, CompletableDeferred<JsonElement>>()
    private val notificationEmitter = MutableSharedFlow<AppServerNotification>(extraBufferCapacity = 64)
    private val mutableState = MutableStateFlow(AppServerRpcClientState())
    private var nextRequestId = 1L
    private var readerJob: Job? = null
    private var closed = false
    private var initializationAttempted = false
    private var initialized = false
    private var preflightAttempted = false
    private var preflightResult: ServerPreflightResult? = null
    private var verifiedHostId: String? = null
    private var verifiedPurpose: AppServerHostProofPurpose? = null
    private var pairClaimAttempted = false
    private var pairCreateAttempted = false

    /**
     * Hot, non-replaying notifications. Collect before requests that may establish subscriptions.
     * If a slow collector fills the buffer, the client fails closed so replay can restore state.
     */
    val notifications: SharedFlow<AppServerNotification> = notificationEmitter.asSharedFlow()

    /** Replaying terminal state so owners can observe transport closure even while idle. */
    val state: StateFlow<AppServerRpcClientState> = mutableState.asStateFlow()

    init {
        require(requestTimeoutMillis > 0) { "requestTimeoutMillis must be positive" }
    }

    suspend fun start(scope: CoroutineScope) {
        val startedReader = mutex.withLock {
            check(!closed) { "App Server client is closed" }
            check(readerJob == null) { "App Server client has already started" }
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    transport.incomingMessages.collect(::receive)
                    closeWithFailure(AppServerProtocolException("transport_closed", "App Server transport closed"))
                } catch (error: CancellationException) {
                    withContext(NonCancellable) {
                        closeWithFailure(AppServerProtocolException("transport_closed", "App Server transport reader was cancelled"))
                    }
                    throw error
                } catch (error: Exception) {
                    closeWithFailure(error)
                }
            }.also { readerJob = it }
        }
        if (!startedReader.isActive) {
            closeWithFailure(AppServerProtocolException("transport_closed", "App Server transport reader could not start"))
        }
    }

    /** Sends and verifies the first RPC on this socket. No caller may send credentials before it succeeds. */
    suspend fun preflight(
        trust: AppServerHostTrust,
        expectedHostId: String,
        purpose: AppServerHostProofPurpose,
    ): ServerPreflightResult {
        val challenge: AppServerHostProofChallenge = mutex.withLock {
            check(!closed) { "App Server client is closed" }
            check(readerJob?.isActive == true) { "App Server transport reader is not active" }
            check(!preflightAttempted) { "App Server preflight has already been attempted" }
            check(!initializationAttempted && !initialized) { "App Server handshake has already started" }
            preflightAttempted = true
            trust.createChallenge(expectedHostId, purpose)
        }
        return try {
            val raw = requestInternal(
                method = "server.preflight",
                params = appServerJson.encodeToJsonElement(ServerPreflightParams.serializer(), ServerPreflightParams(challenge.nonce, purpose)),
                allowBeforeInitialization = true,
            )
            val result = decodeServerPreflightResult(raw)
            val verified = trust.verify(challenge, result)
            mutex.withLock {
                check(!closed) { "App Server client closed during Host verification" }
                preflightResult = result
                verifiedHostId = verified.hostId
                verifiedPurpose = purpose
            }
            result
        } catch (error: Throwable) {
            withContext(NonCancellable) { close() }
            throw error
        }
    }

    suspend fun initialize(params: ServerInitializeParams): ServerInitializeResult {
        mutex.withLock {
            check(!closed) { "App Server client is closed" }
            check(readerJob?.isActive == true) { "App Server transport reader is not active" }
            check(preflightResult != null && verifiedHostId != null && verifiedPurpose != null) {
                "Verify server.preflight before App Server initialization"
            }
            check(params.hostId == verifiedHostId) { "server.initialize Host ID does not match the verified Host" }
            check(!initializationAttempted) { "App Server initialize has already been attempted" }
            initializationAttempted = true
        }

        val proof = preflightResult!!
        val purpose = verifiedPurpose!!
        when (purpose) {
            AppServerHostProofPurpose.PAIRING_LINK -> throw AppServerProtocolException(
                "method_not_allowed",
                "Pairing-link connections cannot initialize",
            )
            AppServerHostProofPurpose.DEVICE_CONNECT -> {
                val auth = params.auth as? DeviceServerInitializeAuth
                    ?: throw AppServerProtocolException("authentication_required", "device-connect requires device authentication")
                if (auth.device.challenge != proof.deviceChallenge) {
                    throw AppServerProtocolException("device_proof_invalid", "Device challenge is not bound to this connection")
                }
                if (params.client.clientKind != AppServerClientKind.MOBILE) {
                    throw AppServerProtocolException("invalid_params", "device-connect requires the mobile client kind")
                }
            }
            AppServerHostProofPurpose.ADMIN_PAIRING -> {
                if (params.auth !is OperatorServerInitializeAuth || params.requestedScopes != listOf(AppServerScope.DEVICE_ADMIN)) {
                    throw AppServerProtocolException("scope_denied", "admin-pairing requires operator auth and only device:admin")
                }
            }
        }

        return try {
            val result = requestInternal(
                method = "server.initialize",
                params = encodeServerInitializeParams(params),
                allowBeforeInitialization = true,
            )
            val initializedServer = decodeServerInitializeResult(result)
            if (initializedServer.server.hostId != params.hostId) {
                throw AppServerProtocolException(
                    "server_identity_mismatch",
                    "App Server identity does not match the paired server",
                )
            }
            val expectedDeviceId = (params.auth as? DeviceServerInitializeAuth)?.device?.deviceId
            if (expectedDeviceId != null && initializedServer.connection.deviceId != expectedDeviceId) {
                throw AppServerProtocolException(
                    "device_identity_mismatch",
                    "App Server connection does not match the paired device",
                )
            }
            mutex.withLock {
                check(!closed) { "App Server client closed during initialization" }
                initialized = true
            }
            initializedServer
        } catch (error: Throwable) {
            withContext(NonCancellable) { close() }
            throw error
        }
    }

    suspend fun request(method: String, params: JsonElement? = null): JsonElement {
        check(method != "server.initialize") { "Use initialize() for the first App Server request" }
        check(!method.startsWith("pair.") && method != "server.preflight") {
            "Use the Host-verified pairing API for handshake methods"
        }
        return requestInternal(method, params, allowBeforeInitialization = false)
    }

    suspend fun previewPairing(pairingToken: String): AppServerPairPreviewResult {
        requireVerifiedPurpose(AppServerHostProofPurpose.PAIRING_LINK, initializedRequired = false)
        val result = decodeAppServerPairPreviewResult(
            requestInternal(
                "pair.preview",
                appServerJson.encodeToJsonElement(AppServerPairPreviewParams.serializer(), AppServerPairPreviewParams(pairingToken)),
                allowBeforeInitialization = true,
            ),
        )
        if (result.hostId != verifiedHostId) throw AppServerProtocolException("server_identity_mismatch", "Pair preview belongs to a different Host")
        return result
    }

    suspend fun claimPairing(params: AppServerPairClaimParams): AppServerPairClaimResult {
        requireVerifiedPurpose(AppServerHostProofPurpose.PAIRING_LINK, initializedRequired = false)
        mutex.withLock {
            check(!pairClaimAttempted) { "pair.claim cannot be retried on the same connection" }
            pairClaimAttempted = true
        }
        return try {
            decodeAppServerPairClaimResult(
                requestInternal(
                    "pair.claim",
                    appServerJson.encodeToJsonElement(AppServerPairClaimParams.serializer(), params),
                    allowBeforeInitialization = true,
                ),
            )
        } finally {
            close()
        }
    }

    suspend fun createPairing(params: AppServerPairCreateParams): AppServerPairCreateResult {
        requireVerifiedPurpose(AppServerHostProofPurpose.ADMIN_PAIRING, initializedRequired = true)
        mutex.withLock {
            check(!pairCreateAttempted) { "admin-pairing connection can create only one ticket" }
            pairCreateAttempted = true
        }
        return try {
            val result = decodeAppServerPairCreateResult(
                requestInternal(
                    "pair.create",
                    appServerJson.encodeToJsonElement(AppServerPairCreateParams.serializer(), params),
                    allowBeforeInitialization = false,
                ),
            )
            if (result.hostId != verifiedHostId) throw AppServerProtocolException("server_identity_mismatch", "Pair ticket belongs to a different Host")
            result
        } finally {
            close()
        }
    }

    private suspend fun requireVerifiedPurpose(purpose: AppServerHostProofPurpose, initializedRequired: Boolean) {
        mutex.withLock {
            check(!closed) { "App Server client is closed" }
            check(verifiedHostId != null && verifiedPurpose == purpose) { "Operation requires a verified $purpose Host proof" }
            check(initialized == initializedRequired) {
                if (initializedRequired) "Initialize the verified connection before this operation" else "Operation is only allowed before initialization"
            }
        }
    }

    private suspend fun requestInternal(
        method: String,
        params: JsonElement?,
        allowBeforeInitialization: Boolean,
    ): JsonElement {
        val (id, response) = mutex.withLock {
            check(!closed) { "App Server client is closed" }
            check(readerJob?.isActive == true) { "App Server transport reader is not active" }
            check(allowBeforeInitialization || initialized) { "Call initialize() before App Server requests" }
            val requestId = nextRequestId++
            val deferred = CompletableDeferred<JsonElement>()
            pendingRequests[requestId] = deferred
            requestId to deferred
        }

        try {
            val result = withTimeoutOrNull(requestTimeoutMillis) {
                send(encodeJsonRpcRequest(JsonRpcRequest(id = id, method = method, params = params)))
                response.await()
            }
            return result ?: throw AppServerProtocolException("request_timeout", "App Server request timed out: $method")
        } finally {
            mutex.withLock { pendingRequests.remove(id) }
        }
    }

    suspend fun notify(method: String, params: JsonElement? = null) {
        mutex.withLock {
            check(!closed) { "App Server client is closed" }
            check(readerJob?.isActive == true) { "App Server transport reader is not active" }
            check(initialized) { "Call initialize() before App Server notifications" }
        }
        send(encodeJsonRpcNotification(JsonRpcNotification(method = method, params = params)))
    }

    private suspend fun send(text: String) {
        try {
            transport.send(text)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            val failure = AppServerProtocolException(
                "transport_failed",
                "App Server transport send failed",
                error,
            )
            withContext(NonCancellable) {
                try {
                    closeWithFailure(failure)
                } catch (_: Exception) {
                    // Preserve the send failure if transport cleanup also fails.
                }
            }
            throw failure
        }
    }

    suspend fun close() {
        val reader = mutex.withLock {
            if (closed) return
            closed = true
            mutableState.value = AppServerRpcClientState(isClosed = true)
            val failure = AppServerProtocolException("client_closed", "App Server client is closed")
            pendingRequests.values.forEach { it.completeExceptionally(failure) }
            pendingRequests.clear()
            readerJob
        }
        reader?.cancelAndJoin()
        transport.close()
    }

    private suspend fun receive(text: String) {
        val message = try {
            appServerJson.parseToJsonElement(text).jsonObject
        } catch (error: IllegalArgumentException) {
            throw AppServerProtocolException("invalid_response", "App Server sent invalid JSON")
        }
        if (message["jsonrpc"]?.let { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.content } != "2.0") {
            throw AppServerProtocolException("invalid_response", "App Server response has an invalid JSON-RPC version")
        }

        if ("id" in message) {
            receiveResponse(message)
            return
        }

        val method = message.requiredString("method", "invalid_response")
        if (!notificationEmitter.tryEmit(AppServerNotification(method, message["params"]))) {
            throw AppServerProtocolException(
                "notification_overflow",
                "App Server notification buffer overflowed; reconnect and recover the Session state",
            )
        }
    }

    private suspend fun receiveResponse(message: JsonObject) {
        val idPrimitive = message["id"] as? JsonPrimitive
        val id = idPrimitive?.takeIf { !it.isString }?.longOrNull
            ?: throw AppServerProtocolException("invalid_response", "App Server response has an invalid request id")
        val response = mutex.withLock { pendingRequests[id] } ?: return
        val hasError = "error" in message
        val hasResult = "result" in message
        if (hasError == hasResult) {
            throw AppServerProtocolException("invalid_response", "App Server response must contain exactly one of result or error")
        }
        val error = message["error"]
        if (error != null) {
            val fields = error as? JsonObject
                ?: throw AppServerProtocolException("invalid_response", "App Server error must be an object")
            val dataElement = fields["data"]
            val data = when (dataElement) {
                null -> null
                is JsonObject -> dataElement
                else -> throw AppServerProtocolException("invalid_response", "App Server error data must be an object")
            }
            val retryable = data?.get("retryable")?.let { value ->
                (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
                    ?: throw AppServerProtocolException("invalid_response", "App Server error retryable field must be a boolean")
            } ?: false
            val failure = AppServerRpcException(
                code = fields.requiredLong("code", "invalid_response"),
                kind = data?.requiredString("code", "invalid_response"),
                retryable = retryable,
                details = data?.get("details"),
                message = fields.requiredString("message", "invalid_response"),
            )
            response.completeExceptionally(failure)
            return
        }

        val result = message["result"]!!
        if (result === JsonNull) {
            response.complete(JsonNull)
        } else {
            response.complete(result)
        }
    }

    private suspend fun closeWithFailure(error: Throwable) {
        mutex.withLock {
            if (closed) return
            closed = true
            mutableState.value = AppServerRpcClientState(
                isClosed = true,
                terminalErrorKind = (error as? AppServerProtocolException)?.kind ?: "transport_failed",
            )
            pendingRequests.values.forEach { it.completeExceptionally(error) }
            pendingRequests.clear()
        }
        transport.close()
    }
}
