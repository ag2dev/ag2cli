package com.ag2dev.ag2cli.mobile.security

import com.ag2dev.ag2cli.mobile.core.protocol.HostIdentityCryptography
import com.ag2dev.ag2cli.mobile.core.protocol.encodeDevicePublicKeySubjectPublicKeyInfo
import com.ag2dev.ag2cli.mobile.core.protocol.p1363EcdsaSignatureToDer
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec

/** Android JCA implementation for the shared Host proof verification boundary. */
object AndroidHostIdentityCryptography : HostIdentityCryptography {
    override fun sha256(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)

    override fun verifyP256Sha256(
        spkiDer: ByteArray,
        message: ByteArray,
        signatureP1363: ByteArray,
    ): Boolean {
        if (signatureP1363.size != P256_SIGNATURE_SIZE) return false
        if (!AndroidDevicePublicKeyValidator.isValid(encodeDevicePublicKeySubjectPublicKeyInfo(spkiDer))) return false

        return try {
            val publicKey = KeyFactory.getInstance("EC")
                .generatePublic(X509EncodedKeySpec(spkiDer)) as? ECPublicKey
                ?: return false
            if (!publicKey.encoded.contentEquals(spkiDer)) return false

            val verifier = Signature.getInstance("SHA256withECDSA")
            verifier.initVerify(publicKey)
            verifier.update(message)
            verifier.verify(p1363EcdsaSignatureToDer(signatureP1363))
        } catch (_: GeneralSecurityException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    private const val P256_SIGNATURE_SIZE = 64
}
