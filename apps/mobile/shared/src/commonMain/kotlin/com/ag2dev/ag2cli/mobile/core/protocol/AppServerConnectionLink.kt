package com.ag2dev.ag2cli.mobile.core.protocol

import io.ktor.http.Url
import io.ktor.http.parseUrl
import kotlin.time.Clock
import kotlin.time.Instant

data class AppServerConnectionLink(
    val endpoint: String,
    val hostId: String,
    val pairingToken: String,
    val expiresAt: String,
    val clientKind: String?,
) {
    override fun toString(): String =
        "AppServerConnectionLink(endpoint=${redactedEndpointOrigin(endpoint)}, hostId=$hostId, pairingToken=<redacted>, expiresAt=$expiresAt, clientKind=$clientKind)"
}

/** Parse and validate the short-lived pairing link without consuming its ticket. */
fun parseAppServerConnectionLink(value: String, now: Instant = Clock.System.now()): AppServerConnectionLink {
    val source = value.trim()
    if (source.isEmpty()) invalidLink("Connection link must not be empty")
    val link = parseUrl(source) ?: invalidLink("Connection link must be a valid URL")
    if (link.protocol.name != "ag2cli" || link.host != "connect" || link.encodedPath != "/v1") {
        invalidLink("Connection link must use ag2cli://connect/v1")
    }
    if (link.user != null || link.password != null || link.fragment.isNotEmpty()) {
        invalidLink("Connection link must not contain credentials or a fragment")
    }

    val allowedFields = setOf("endpoint", "hostId", "ticket", "expires", "client")
    val unknownField = link.parameters.names().firstOrNull { it !in allowedFields }
    if (unknownField != null) invalidLink("Connection link contains an unknown field: $unknownField")

    val endpoint = normalizeAppServerEndpoint(requiredValue(link, "endpoint"))
    val hostId = normalizeSafeToken(requiredValue(link, "hostId"), "Host ID", 128)
    if (!isValidAppServerHostId(hostId)) invalidLink("Connection link has an invalid Host ID")
    val pairingToken = normalizeSafeToken(requiredValue(link, "ticket"), "pairing token", 256)
    if (!PAIRING_TOKEN_PATTERN.matches(pairingToken)) {
        invalidLink("Connection link has an invalid pairing token format")
    }
    val expiresAt = normalizeSafeToken(requiredValue(link, "expires"), "connection link expiry", 128)
    val expiry = try {
        Instant.parse(expiresAt)
    } catch (_: IllegalArgumentException) {
        invalidLink("Connection link expiry must be a valid ISO-8601 timestamp")
    }
    if (expiry <= now) invalidLink("Connection link has expired")

    val clientKind = optionalValue(link, "client")?.also(::validateClientKind)
    return AppServerConnectionLink(endpoint, hostId, pairingToken, expiresAt, clientKind)
}

fun normalizeAppServerEndpoint(value: String): String {
    if (value.isBlank()) invalidLink("Connection link endpoint must not be empty")
    val endpoint = parseUrl(value.trim()) ?: invalidLink("Connection link endpoint must be a valid URL")
    if (endpoint.protocol.name != "ws" && endpoint.protocol.name != "wss") {
        invalidLink("Connection link endpoint must use ws:// or wss://")
    }
    if (endpoint.parameters.names().isNotEmpty()) {
        invalidLink("Connection link endpoint must not contain query parameters")
    }
    if (endpoint.host.isBlank() || endpoint.user != null || endpoint.password != null || endpoint.fragment.isNotEmpty()) {
        invalidLink("Connection link endpoint contains an invalid host, credentials, or fragment")
    }
    if (endpoint.protocol.name == "ws" && !isLoopbackHost(endpoint.host)) {
        invalidLink("Cleartext App Server endpoints must use loopback")
    }
    return endpoint.toString()
}

private fun isLoopbackHost(value: String): Boolean {
    val host = value.lowercase().removeSuffix(".")
    if (host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1") return true
    val octets = host.split('.')
    return octets.size == 4 && octets[0] == "127" && octets.all { it.toIntOrNull() in 0..255 }
}

private fun normalizeSafeToken(value: String, label: String, maxLength: Int): String {
    val normalized = value.trim()
    if (
        normalized.isEmpty() ||
        normalized.length > maxLength ||
        normalized.any { it.isWhitespace() || it.category == CharCategory.FORMAT || it.code in 0x00..0x1f || it.code in 0x7f..0x9f }
    ) {
        invalidLink("$label has an invalid format")
    }
    return normalized
}

private fun redactedEndpointOrigin(endpoint: String): String = runCatching {
    val parsed = Url(endpoint)
    val defaultPort = if (parsed.protocol.name == "wss") 443 else 80
    val port = if (parsed.port == defaultPort) "" else ":${parsed.port}"
    "${parsed.protocol.name}://${parsed.host}$port/"
}.getOrDefault("<redacted>")

private fun requiredValue(link: Url, key: String): String {
    val values = link.parameters.getAll(key).orEmpty()
    if (values.size > 1) invalidLink("Connection link must not contain duplicate $key values")
    if (values.size != 1 || values.single().isEmpty()) {
        invalidLink("Connection link must contain exactly one $key")
    }
    return values.single()
}

private fun optionalValue(link: Url, key: String): String? {
    val values = link.parameters.getAll(key).orEmpty()
    if (values.size > 1) invalidLink("Connection link must not contain duplicate $key values")
    return values.singleOrNull()
}

private fun validateClientKind(value: String) {
    if (value !in CLIENT_KINDS) invalidLink("Connection link has an invalid client kind")
}

private fun invalidLink(message: String): Nothing = throw AppServerProtocolException("invalid_params", message)

private val CLIENT_KINDS = setOf("tui", "web", "mobile", "desktop", "acp", "script", "unknown")
private val PAIRING_TOKEN_PATTERN = Regex("ag2cli-pairing\\.[A-Za-z0-9_-]{43}")
