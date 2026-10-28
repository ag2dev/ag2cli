package com.ag2dev.ag2cli.mobile.security

import com.ag2dev.ag2cli.mobile.core.identity.SecureRandomPort
import java.security.SecureRandom

class AndroidSecureRandomPort(
    private val secureRandom: SecureRandom = SecureRandom(),
) : SecureRandomPort {
    override fun bytes(size: Int): ByteArray {
        require(size >= 0) { "Secure random byte count must not be negative" }
        return ByteArray(size).also(secureRandom::nextBytes)
    }
}
