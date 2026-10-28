package com.ag2dev.ag2cli.mobile.core.pairing

import com.ag2dev.ag2cli.mobile.core.identity.AppServerHostTrust
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerDevicePublicKeyValidator
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerHostProofPurpose
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerPairClaimParams
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerPairClaimResult
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerPairPreviewResult
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerProtocolException
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerRpcClient
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerScope
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerTransport
import com.ag2dev.ag2cli.mobile.core.protocol.parseAppServerConnectionLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlin.time.Clock
import kotlin.time.Instant

fun interface AppServerPairingTransportProvider {
    suspend fun connect(endpoint: String): AppServerTransport
}

fun interface AppServerPairingDeviceIdentityProvider {
    suspend fun publicKey(hostId: String): String
}

class AppServerPairingReview internal constructor(
    val endpoint: String,
    val hostId: String,
    val scopes: List<AppServerScope>,
    val expiresAt: String,
    internal val pairingToken: String,
) {
    override fun toString(): String = "AppServerPairingReview(endpoint=$endpoint, hostId=$hostId, scopes=$scopes, expiresAt=$expiresAt, pairingToken=<redacted>)"
}

/** Owns the two-connection review/claim workflow; the UI receives only the reviewed Host and scopes. */
class AppServerPairingWorkflow(
    private val hostTrust: AppServerHostTrust,
    private val transportProvider: AppServerPairingTransportProvider,
    private val deviceIdentityProvider: AppServerPairingDeviceIdentityProvider,
    private val devicePublicKeyValidator: AppServerDevicePublicKeyValidator,
    private val nowEpochMillis: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) {
    suspend fun preview(connectionLink: String): AppServerPairingReview {
        val link = parseMobileLink(connectionLink)
        val rpc = openVerifiedLinkConnection(link.endpoint, link.hostId)
        try {
            val result: AppServerPairPreviewResult = rpc.previewPairing(link.pairingToken)
            val expiresAt = parseExpiry(result.expiresAt)
            if (result.hostId != link.hostId || expiresAt != parseExpiry(link.expiresAt)) {
                throw AppServerProtocolException("pairing_link_mismatch", "Pairing preview does not match the connection link")
            }
            return AppServerPairingReview(
                endpoint = link.endpoint,
                hostId = link.hostId,
                scopes = result.scopes,
                expiresAt = result.expiresAt,
                pairingToken = link.pairingToken,
            )
        } finally {
            rpc.close()
        }
    }

    suspend fun claim(
        connectionLink: String,
        review: AppServerPairingReview,
        deviceName: String,
    ): AppServerPairClaimResult {
        val link = parseMobileLink(connectionLink)
        if (
            link.endpoint != review.endpoint ||
            link.hostId != review.hostId ||
            link.pairingToken != review.pairingToken ||
            parseExpiry(link.expiresAt) != parseExpiry(review.expiresAt)
        ) {
            throw AppServerProtocolException("pairing_review_mismatch", "Connection link changed after pairing review")
        }
        if (deviceName.isBlank() || deviceName.length > MAX_DEVICE_NAME_LENGTH) {
            throw AppServerProtocolException("invalid_device_name", "Device name is invalid")
        }
        val publicKey = deviceIdentityProvider.publicKey(review.hostId)
        if (!devicePublicKeyValidator.isValid(publicKey)) {
            throw AppServerProtocolException("invalid_public_key", "Device public key is invalid")
        }
        val rpc = openVerifiedLinkConnection(review.endpoint, review.hostId)
        return try {
            val result = rpc.claimPairing(
                AppServerPairClaimParams(
                    pairingToken = review.pairingToken,
                    name = deviceName.trim(),
                    clientKind = com.ag2dev.ag2cli.mobile.core.protocol.AppServerClientKind.MOBILE,
                    publicKey = publicKey,
                ),
            )
            validateClaimResult(result, review, publicKey)
            result
        } finally {
            rpc.close()
        }
    }

    private suspend fun openVerifiedLinkConnection(endpoint: String, hostId: String): AppServerRpcClient {
        val transport = transportProvider.connect(endpoint)
        val rpc = AppServerRpcClient(transport)
        try {
            rpc.start(CoroutineScope(currentCoroutineContext()))
            rpc.preflight(hostTrust, hostId, AppServerHostProofPurpose.PAIRING_LINK)
            return rpc
        } catch (error: Throwable) {
            rpc.close()
            throw error
        }
    }

    private fun parseMobileLink(value: String) = parseAppServerConnectionLink(value).also { link ->
        if (link.clientKind != null && link.clientKind != "mobile") {
            throw AppServerProtocolException("client_kind_mismatch", "Connection link is restricted to a different client kind")
        }
        if (parseExpiry(link.expiresAt) <= nowEpochMillis()) {
            throw AppServerProtocolException("pairing_expired", "Connection link has expired")
        }
    }

    private fun parseExpiry(value: String): Long = try {
        Instant.parse(value).toEpochMilliseconds()
    } catch (_: IllegalArgumentException) {
        throw AppServerProtocolException("invalid_params", "Connection link expiry is invalid")
    }

    private fun validateClaimResult(
        result: AppServerPairClaimResult,
        review: AppServerPairingReview,
        publicKey: String,
    ) {
        if (
            result.device.clientKind != com.ag2dev.ag2cli.mobile.core.protocol.AppServerClientKind.MOBILE ||
            result.device.publicKey != publicKey ||
            result.device.scopes != review.scopes
        ) {
            throw AppServerProtocolException("invalid_result", "pair.claim result does not match the reviewed device and scopes")
        }
    }

    private companion object {
        const val MAX_DEVICE_NAME_LENGTH = 128
    }
}
