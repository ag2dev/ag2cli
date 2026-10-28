package com.ag2dev.ag2cli.mobile.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.ag2dev.ag2cli.mobile.core.protocol.APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerDeviceProofSigner
import com.ag2dev.ag2cli.mobile.core.protocol.AppServerDevicePublicKeyValidator
import com.ag2dev.ag2cli.mobile.core.protocol.derEcdsaSignatureToP1363
import com.ag2dev.ag2cli.mobile.core.protocol.encodeDevicePublicKeySubjectPublicKeyInfo
import com.ag2dev.ag2cli.mobile.core.protocol.isValidDevicePublicKey
import com.ag2dev.ag2cli.mobile.core.protocol.decodeBase64Url
import com.ag2dev.ag2cli.mobile.core.protocol.isValidAppServerHostId
import com.ag2dev.ag2cli.mobile.core.protocol.encodeBase64Url
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.AlgorithmParameters
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECFieldFp
import java.security.spec.X509EncodedKeySpec

data class AndroidDeviceIdentity(
    val publicKey: String,
    val signer: AppServerDeviceProofSigner,
)

/** Creates a non-exportable P-256 signing key and exposes only its SPKI public key. */
class AndroidDeviceIdentityStore internal constructor(private val keyAliasForHost: (String) -> String) {
    constructor() : this(::deviceKeyAlias)

    internal constructor(keyAlias: String) : this({ keyAlias })

    fun getOrCreate(hostId: String): AndroidDeviceIdentity = synchronized(KEYSTORE_LOCK) {
        require(isValidAppServerHostId(hostId)) { "Host ID is invalid" }
        val keyAlias = keyAliasForHost(hostId)
        val keyStore = loadKeyStore()
        if (!keyStore.containsAlias(keyAlias)) {
            createDeviceKey(keyAlias)
            keyStore.load(null)
        }

        val certificate = keyStore.getCertificate(keyAlias)
            ?: throw GeneralSecurityException("Android device identity certificate is unavailable")
        val publicKey = encodeDevicePublicKeySubjectPublicKeyInfo(certificate.publicKey.encoded)
        if (!AndroidDevicePublicKeyValidator.isValid(publicKey)) {
            throw GeneralSecurityException("Android device identity is not a valid P-256 public key")
        }
        if (keyStore.getKey(keyAlias, null) !is java.security.PrivateKey) {
            throw GeneralSecurityException("Android device identity private key is unavailable")
        }
        AndroidDeviceIdentity(publicKey, AndroidDeviceProofSignerImpl(keyAlias))
    }

    private fun createDeviceKey(keyAlias: String) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec(P256_CURVE))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
            .build()
        generator.initialize(spec)
        generator.generateKeyPair()
    }

    private fun loadKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private inner class AndroidDeviceProofSignerImpl(private val keyAlias: String) : AppServerDeviceProofSigner {
        override suspend fun signP256Sha256(message: ByteArray): ByteArray = withContext(Dispatchers.IO) {
            val privateKey = loadKeyStore().getKey(keyAlias, null) as? java.security.PrivateKey
                ?: throw GeneralSecurityException("Android device identity private key is unavailable")
            val signature = Signature.getInstance("SHA256withECDSA")
            signature.initSign(privateKey)
            signature.update(message)
            derEcdsaSignatureToP1363(signature.sign())
        }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        internal const val DEVICE_KEY_ALIAS_PREFIX = "com.ag2dev.ag2cli.mobile.device-proof.v1."
        private const val P256_CURVE = "secp256r1"
        private val KEYSTORE_LOCK = Any()
    }
}

private fun deviceKeyAlias(hostId: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(hostId.encodeToByteArray())
    return AndroidDeviceIdentityStore.DEVICE_KEY_ALIAS_PREFIX + encodeBase64Url(digest)
}

/** Imports the complete SubjectPublicKeyInfo and checks it uses the named P-256 curve. */
object AndroidDevicePublicKeyValidator : AppServerDevicePublicKeyValidator {
    override fun isValid(publicKey: String): Boolean {
        if (!isValidDevicePublicKey(publicKey)) return false
        val encoded = decodeBase64Url(publicKey.removePrefix(APP_SERVER_DEVICE_PUBLIC_KEY_PREFIX)) ?: return false
        return try {
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(encoded)) as? ECPublicKey
                ?: return false
            val actual = key.params
            val expected = AlgorithmParameters.getInstance("EC").run {
                init(ECGenParameterSpec("secp256r1"))
                getParameterSpec(ECParameterSpec::class.java)
            }
            val actualField = actual.curve.field as? ECFieldFp ?: return false
            val expectedField = expected.curve.field as? ECFieldFp ?: return false
            actualField.p == expectedField.p &&
                actual.curve.a == expected.curve.a &&
                actual.curve.b == expected.curve.b &&
                actual.generator.affineX == expected.generator.affineX &&
                actual.generator.affineY == expected.generator.affineY &&
                actual.order == expected.order &&
                actual.cofactor == expected.cofactor
        } catch (_: GeneralSecurityException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }
    }
}
