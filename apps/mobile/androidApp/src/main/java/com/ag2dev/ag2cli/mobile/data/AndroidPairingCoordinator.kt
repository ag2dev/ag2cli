package com.ag2dev.ag2cli.mobile.data

import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import com.ag2dev.ag2cli.mobile.core.identity.AppServerHostTrust
import com.ag2dev.ag2cli.mobile.core.pairing.AppServerPairingReview
import com.ag2dev.ag2cli.mobile.core.pairing.AppServerPairingWorkflow
import com.ag2dev.ag2cli.mobile.core.protocol.KtorAppServerWebSocketTransport
import com.ag2dev.ag2cli.mobile.core.protocol.parseAppServerConnectionLink
import com.ag2dev.ag2cli.mobile.security.AndroidCleartextEndpointPolicy
import com.ag2dev.ag2cli.mobile.security.AndroidCredentialVault
import com.ag2dev.ag2cli.mobile.security.AndroidDeviceIdentityStore
import com.ag2dev.ag2cli.mobile.security.AndroidDevicePublicKeyValidator
import com.ag2dev.ag2cli.mobile.security.AndroidHostIdentityCryptography
import com.ag2dev.ag2cli.mobile.security.AndroidLocalNetworkPolicy
import com.ag2dev.ag2cli.mobile.security.AndroidSecureRandomPort
import com.ag2dev.ag2cli.mobile.security.StoredDeviceCredential
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class PairingResult(
    val deviceId: String,
    val hostId: String,
    val deviceName: String,
)

data class PairedDeviceSummary(
    val deviceId: String,
    val hostId: String,
    val deviceName: String,
    val serverOrigin: String,
)

class PairingCredentialPersistenceException(
    val deviceId: String,
    val hostId: String,
    cause: Throwable,
) : Exception("The server registered the device, but its credential could not be stored", cause)

open class AndroidLocalNetworkPermissionRequiredException :
    Exception("Android local network permission is required for this endpoint")

class PairingLocalNetworkPermissionRequiredException : AndroidLocalNetworkPermissionRequiredException()

/** Coordinates platform network policy and credential persistence around the shared KMP pairing workflow. */
class AndroidPairingCoordinator(
    context: Context,
    private val engineFactory: () -> HttpClientEngine = { CIO.create() },
) {
    private val appContext = context.applicationContext
    private val identityStore = AndroidDeviceIdentityStore()
    private val credentialVault = AndroidCredentialVault(appContext)
    private val workflow = AppServerPairingWorkflow(
        hostTrust = AppServerHostTrust(AndroidSecureRandomPort(), AndroidHostIdentityCryptography),
        transportProvider = { endpoint ->
            val engine = engineFactory()
            val client = try {
                createAndroidAppServerHttpClient(engine)
            } catch (error: Throwable) {
                engine.close()
                throw error
            }
            try {
                AndroidOwnedAppServerTransport(KtorAppServerWebSocketTransport.connect(client, endpoint), client)
            } catch (error: Throwable) {
                client.close()
                throw error
            }
        },
        deviceIdentityProvider = { hostId ->
            withContext(Dispatchers.IO) { identityStore.getOrCreate(hostId).publicKey }
        },
        devicePublicKeyValidator = AndroidDevicePublicKeyValidator,
    )

    fun pairedDevices(): List<PairedDeviceSummary> = credentialVault.loadAll().map { credential ->
        PairedDeviceSummary(
            deviceId = credential.deviceId,
            hostId = credential.hostId,
            deviceName = credential.deviceName,
            serverOrigin = serverOrigin(credential.endpoint),
        )
    }

    fun forgetPairedDevice(deviceId: String, hostId: String): Boolean = credentialVault.remove(deviceId, hostId)

    suspend fun preview(connectionLink: String): AppServerPairingReview {
        validateEndpointAccess(parseAppServerConnectionLink(connectionLink).endpoint)
        return workflow.preview(connectionLink)
    }

    suspend fun pair(
        connectionLink: String,
        review: AppServerPairingReview,
        deviceName: String,
    ): PairingResult {
        val link = parseAppServerConnectionLink(connectionLink)
        validateEndpointAccess(link.endpoint)
        require(deviceName.isNotBlank() && deviceName.length <= MAX_DEVICE_NAME_LENGTH) {
            "Device name is invalid"
        }

        withContext(Dispatchers.IO) { credentialVault.prepare() }
        val registration = workflow.claim(connectionLink, review, deviceName)
        val stored = StoredDeviceCredential(
            endpoint = link.endpoint,
            hostId = review.hostId,
            deviceId = registration.device.deviceId,
            deviceName = registration.device.name,
            credential = registration.credential,
        )
        try {
            withContext(Dispatchers.IO) { credentialVault.save(stored) }
        } catch (error: Exception) {
            throw PairingCredentialPersistenceException(registration.device.deviceId, review.hostId, error)
        }
        return PairingResult(registration.device.deviceId, review.hostId, registration.device.name)
    }

    private suspend fun validateEndpointAccess(endpoint: String) {
        val allowLoopbackCleartext = appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        require(AndroidCleartextEndpointPolicy.isPermitted(endpoint, allowLoopbackCleartext)) {
            "This Android client does not permit cleartext pairing to this endpoint"
        }
        val requiresLocalNetworkPermission = Build.VERSION.SDK_INT >= ANDROID_17_API_LEVEL &&
            withContext(Dispatchers.IO) { AndroidLocalNetworkPolicy.requiresPermission(endpoint) }
        if (
            requiresLocalNetworkPermission &&
            appContext.checkSelfPermission(ACCESS_LOCAL_NETWORK_PERMISSION) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            throw PairingLocalNetworkPermissionRequiredException()
        }
    }

    companion object {
        private const val MAX_DEVICE_NAME_LENGTH = 128
        private const val ANDROID_17_API_LEVEL = 37
        private const val ACCESS_LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}

private fun serverOrigin(endpoint: String): String {
    val uri = Uri.parse(endpoint)
    val scheme = uri.scheme ?: return "Unknown server"
    val host = uri.host ?: return "Unknown server"
    val port = uri.port.takeIf { it >= 0 }?.let { ":$it" }.orEmpty()
    return "$scheme://$host$port"
}
