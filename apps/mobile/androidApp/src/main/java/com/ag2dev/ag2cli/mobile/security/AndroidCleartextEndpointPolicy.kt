package com.ag2dev.ag2cli.mobile.security

import android.net.Uri

/** Matches the exact debug-only cleartext hosts permitted by Network Security Config. */
object AndroidCleartextEndpointPolicy {
    fun isPermitted(endpoint: String, allowLoopbackCleartext: Boolean): Boolean {
        val uri = Uri.parse(endpoint)
        if (uri.scheme != "ws") return uri.scheme == "wss"
        if (!allowLoopbackCleartext) return false
        val host = uri.host?.removePrefix("[")?.removeSuffix("]")?.lowercase()?.removeSuffix(".")
        return host in LOOPBACK_HOSTS
    }

    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1")
}
