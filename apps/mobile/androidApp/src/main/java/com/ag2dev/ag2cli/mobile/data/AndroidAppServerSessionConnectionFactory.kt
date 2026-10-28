package com.ag2dev.ag2cli.mobile.data

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import com.ag2dev.ag2cli.mobile.BuildConfig
import com.ag2dev.ag2cli.mobile.core.identity.AppServerHostTrust
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerClientInfo
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerClientKind
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerScope
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerTransport
import com.ag2dev.ag2cli.mobile.core.protocol.KtorAppServerWebSocketTransport
import com.ag2dev.ag2cli.mobile.core.protocol.normalizeAppServerEndpoint
import com.ag2dev.ag2cli.mobile.core.session.AppServerSessionConnection
import com.ag2dev.ag2cli.mobile.core.session.AppServerSessionConnectionFactory
import com.ag2dev.ag2cli.mobile.core.session.AppServerSessionTransportProvider
import com.ag2dev.ag2cli.mobile.core.session.DefaultAppServerSessionConnectionFactory
import com.ag2dev.ag2cli.mobile.security.AndroidCleartextEndpointPolicy
import com.ag2dev.ag2cli.mobile.security.AndroidDeviceIdentityStore
import com.ag2dev.ag2cli.mobile.security.AndroidHostIdentityCryptography
import com.ag2dev.ag2cli.mobile.security.AndroidLocalNetworkPolicy
import com.ag2dev.ag2cli.mobile.security.AndroidSecureRandomPort
import com.ag2dev.ag2cli.mobile.security.StoredDeviceCredential
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.engine.cio.CIO
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Creates an authenticated, read-only App Server session connection for one explicitly selected device. */
class AndroidAppServerSessionConnectionFactory(
    context: Context,
    private val credential: StoredDeviceCredential,
    private val engineFactory: () -> HttpClientEngine = { CIO.create() },
    private val webSocketClientFactory: (HttpClientEngine) -> HttpClient = ::createAndroidAppServerHttpClient,
) : AppServerSessionConnectionFactory {
    private val appContext = context.applicationContext
    private val identityStore = AndroidDeviceIdentityStore()
    private val clientIdStore = AndroidAppServerClientIdStore(appContext)

    override suspend fun connect(scope: CoroutineScope): AppServerSessionConnection {
        validateEndpointAccess()
        val identity = withContext(Dispatchers.IO) { identityStore.getOrCreate(credential.hostId) }
        val clientId = withContext(Dispatchers.IO) { clientIdStore.getOrCreate() }
        val client = AppServerClientInfo(
            clientId = clientId,
            clientKind = AppServerClientKind.MOBILE,
            name = CLIENT_NAME,
            version = BuildConfig.VERSION_NAME,
            capabilities = READ_CAPABILITIES,
        )
        val delegate = DefaultAppServerSessionConnectionFactory(
            client = client,
            expectedHostId = credential.hostId,
            deviceId = credential.deviceId,
            credential = credential.credential,
            signer = identity.signer,
            hostTrust = AppServerHostTrust(AndroidSecureRandomPort(), AndroidHostIdentityCryptography),
            transportProvider = AppServerSessionTransportProvider {
                val webSocketEngine = engineFactory()
                val httpClient = try {
                    webSocketClientFactory(webSocketEngine)
                } catch (error: Throwable) {
                    webSocketEngine.close()
                    throw error
                }
                try {
                    val transport = KtorAppServerWebSocketTransport.connect(
                        client = httpClient,
                        endpoint = credential.endpoint,
                    )
                    AndroidOwnedAppServerTransport(transport, httpClient)
                } catch (error: Throwable) {
                    httpClient.close()
                    throw error
                }
            },
        )
        return delegate.connect(scope)
    }

    private suspend fun validateEndpointAccess() {
        normalizeAppServerEndpoint(credential.endpoint)
        require(credential.deviceId.isNotBlank()) { "Paired device ID must be non-blank" }
        require(credential.hostId.isNotBlank()) { "Paired Host ID must be non-blank" }

        val allowLoopbackCleartext = appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        require(AndroidCleartextEndpointPolicy.isPermitted(credential.endpoint, allowLoopbackCleartext)) {
            "This Android client does not permit cleartext connections to this endpoint"
        }
        if (Build.VERSION.SDK_INT < ANDROID_17_API_LEVEL) return
        val requiresLocalNetworkPermission = withContext(Dispatchers.IO) {
            AndroidLocalNetworkPolicy.requiresPermission(credential.endpoint)
        }
        if (
            requiresLocalNetworkPermission &&
            appContext.checkSelfPermission(ACCESS_LOCAL_NETWORK_PERMISSION) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            throw AndroidLocalNetworkPermissionRequiredException()
        }
    }

    private companion object {
        const val CLIENT_NAME = "AG2CLI Android"
        const val ANDROID_17_API_LEVEL = 37
        const val ACCESS_LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
        val READ_CAPABILITIES = listOf(
            "session.list",
            "session.get",
            "session.attach",
            "session.detach",
            "session.snapshot",
            "session.replay",
            "session.resync",
        )
    }
}
