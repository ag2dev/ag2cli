package com.ag2dev.ag2cli.mobile.security

import android.net.Uri
import java.net.InetAddress

/** Identifies local-network endpoints that need Android 17 permission before connecting. */
object AndroidLocalNetworkPolicy {
    fun requiresPermission(endpoint: String): Boolean = requiresPermission(endpoint) { host ->
        InetAddress.getAllByName(host).toList()
    }

    internal fun requiresPermission(
        endpoint: String,
        resolveHost: (String) -> List<InetAddress>,
    ): Boolean {
        val host = Uri.parse(endpoint).host
            ?.removePrefix("[")
            ?.removeSuffix("]")
            ?.substringBefore('%')
            ?.lowercase()
            ?.removeSuffix(".")
            ?: return false

        if (host == "localhost" || isLoopbackIpv4(host) || host == "::1" || host == "0:0:0:0:0:0:0:1") {
            return false
        }
        if (host.endsWith(".local") || isLocalIpv4(host)) return true

        return runCatching { resolveHost(host) }
            .getOrDefault(emptyList())
            .any(::isLocalNetworkAddress)
    }

    private fun isLocalIpv4(host: String): Boolean {
        val octets = host.split('.').map { it.toIntOrNull() ?: return false }
        if (octets.size != 4 || octets.any { it !in 0..255 }) return false
        return when {
            octets[0] == 10 -> true
            octets[0] == 172 && octets[1] in 16..31 -> true
            octets[0] == 192 && octets[1] == 168 -> true
            octets[0] == 169 && octets[1] == 254 -> true
            octets[0] == 100 && octets[1] in 64..127 -> true
            else -> false
        }
    }

    private fun isLoopbackIpv4(host: String): Boolean {
        val octets = host.split('.').map { it.toIntOrNull() ?: return false }
        return octets.size == 4 && octets.all { it in 0..255 } && octets[0] == 127
    }

    private fun isLocalNetworkAddress(address: InetAddress): Boolean {
        if (address.isLoopbackAddress) return false
        val firstByte = address.address.firstOrNull()?.toInt()?.and(0xff) ?: return false
        val secondByte = address.address.getOrNull(1)?.toInt()?.and(0xff)
        return address.isLinkLocalAddress ||
            address.isSiteLocalAddress ||
            (address.address.size == 4 && firstByte == 100 && secondByte != null && secondByte in 64..127) ||
            (address.address.size == 16 && (firstByte and 0xfe) == 0xfc)
    }
}
