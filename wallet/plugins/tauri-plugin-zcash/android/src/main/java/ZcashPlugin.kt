// SPDX-License-Identifier: MIT OR Apache-2.0

package cash.free2z.zuuli.zcash

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SeedKeyArgs {
    lateinit var walletId: String
}

@InvokeArg
class StoreSeedArgs {
    lateinit var walletId: String
    lateinit var phrase: String
}

data class SeedValue(val phrase: String)

/**
 * Android seed custody.
 *
 * The AES key is generated inside AndroidKeyStore, is non-exportable, requires
 * strong biometric presence for each use, and is usable only while the device
 * is unlocked. SharedPreferences holds only `version || random IV || GCM
 * ciphertext`; it never contains key material or plaintext.
 */
@TauriPlugin
class ZcashPlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs = activity.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Command
    fun storeSeed(invoke: Invoke) {
        val args = invoke.parseArgs(StoreSeedArgs::class.java)
        val plaintext = args.phrase.toByteArray(Charsets.UTF_8)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            authenticate(
                invoke,
                cipher,
                onSuccess = { authenticated ->
                    try {
                        val ciphertext = authenticated.doFinal(plaintext)
                        val record = ByteBuffer.allocate(1 + authenticated.iv.size + ciphertext.size)
                            .put(RECORD_VERSION)
                            .put(authenticated.iv)
                            .put(ciphertext)
                            .array()
                        if (!prefs.edit().putString(prefKey(args.walletId), Base64.encodeToString(record, Base64.NO_WRAP)).commit()) {
                            reject(invoke, "unavailable", "secure ciphertext persistence failed")
                        } else {
                            invoke.resolve()
                        }
                    } catch (error: Exception) {
                        rejectCrypto(invoke, error)
                    } finally {
                        plaintext.fill(0)
                    }
                },
                onFailure = { plaintext.fill(0) }
            )
        } catch (error: Exception) {
            plaintext.fill(0)
            rejectCrypto(invoke, error)
        }
    }

    @Command
    fun getSeed(invoke: Invoke) {
        val args = invoke.parseArgs(SeedKeyArgs::class.java)
        val encoded = prefs.getString(prefKey(args.walletId), null)
            ?: return reject(invoke, "not_found", "seed is not present")
        try {
            val record = Base64.decode(encoded, Base64.NO_WRAP)
            if (record.size <= 1 + IV_LENGTH || record[0] != RECORD_VERSION) {
                return reject(invoke, "corrupt", "secure seed record has an unsupported format")
            }
            val iv = record.copyOfRange(1, 1 + IV_LENGTH)
            val ciphertext = record.copyOfRange(1 + IV_LENGTH, record.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, requireKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            authenticate(invoke, cipher, onSuccess = { authenticated ->
                var plaintext: ByteArray? = null
                try {
                    plaintext = authenticated.doFinal(ciphertext)
                    invoke.resolveObject(SeedValue(plaintext.toString(Charsets.UTF_8)))
                } catch (error: Exception) {
                    rejectCrypto(invoke, error)
                } finally {
                    plaintext?.fill(0)
                    ciphertext.fill(0)
                }
            })
        } catch (error: Exception) {
            rejectCrypto(invoke, error)
        }
    }

    @Command
    fun deleteSeed(invoke: Invoke) {
        val args = invoke.parseArgs(SeedKeyArgs::class.java)
        if (!prefs.contains(prefKey(args.walletId))) {
            return reject(invoke, "not_found", "seed is not present")
        }
        if (!prefs.edit().remove(prefKey(args.walletId)).commit()) {
            reject(invoke, "unavailable", "secure ciphertext deletion failed")
        } else {
            invoke.resolve()
        }
    }

    private fun authenticate(
        invoke: Invoke,
        cipher: Cipher,
        onSuccess: (Cipher) -> Unit,
        onFailure: () -> Unit = {}
    ) {
        val host = activity as? FragmentActivity
            ?: return reject(invoke, "unavailable", "biometric host activity is unavailable")
        activity.runOnUiThread {
            val prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(host),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val authenticated = result.cryptoObject?.cipher
                        if (authenticated == null) {
                            onFailure()
                            reject(invoke, "unavailable", "biometric cipher was not returned")
                        } else {
                            onSuccess(authenticated)
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        onFailure()
                        val code = when (errorCode) {
                            BiometricPrompt.ERROR_USER_CANCELED,
                            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            BiometricPrompt.ERROR_CANCELED -> "auth_cancelled"
                            BiometricPrompt.ERROR_LOCKOUT,
                            BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "locked"
                            else -> "unavailable"
                        }
                        reject(invoke, code, errString.toString())
                    }
                })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Unlock ZUULI wallet")
                .setSubtitle("Authenticate to use the wallet seed")
                .setAllowedAuthenticators(androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setNegativeButtonText("Cancel")
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUnlockedDeviceRequired(true)
                .setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .build()
        )
        return generator.generateKey()
    }

    private fun requireKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return keyStore.getKey(KEY_ALIAS, null) as? SecretKey
            ?: throw IllegalStateException("AndroidKeyStore seed key is missing")
    }

    private fun rejectCrypto(invoke: Invoke, error: Exception) {
        when (error) {
            is AEADBadTagException -> reject(invoke, "corrupt", "secure seed authentication failed")
            is UserNotAuthenticatedException -> reject(invoke, "locked", "device authentication is required")
            is KeyPermanentlyInvalidatedException -> reject(invoke, "locked", "biometric enrollment changed; restore the wallet")
            else -> reject(invoke, "unavailable", error.message ?: error.javaClass.simpleName)
        }
    }

    private fun reject(invoke: Invoke, code: String, message: String) {
        invoke.reject(message, code)
    }

    private fun prefKey(walletId: String) = "seed_$walletId"

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "cash.free2z.zuuli.seed-key.v1"
        private const val PREFERENCES = "zuuli_secure_seed_ciphertexts_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_LENGTH = 12
        private const val GCM_TAG_BITS = 128
        private const val RECORD_VERSION: Byte = 1
    }
}
