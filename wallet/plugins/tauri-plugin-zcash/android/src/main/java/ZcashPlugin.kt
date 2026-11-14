// SPDX-License-Identifier: MIT OR Apache-2.0

package cash.free2z.zuuli.zcash

import android.app.AlertDialog
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.app.Activity
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.view.WindowManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
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

@InvokeArg
class SensitiveDisplayArgs {
    var active: Boolean = false
    lateinit var token: String
}

@InvokeArg
class PhonePhraseArgs { lateinit var phrase: String; var locale: String = "en" }
@InvokeArg
class PhoneLocaleArgs { var locale: String = "en" }
data class SeedValue(val phrase: String)
private class MissingSeedKey : Exception()

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
    @Volatile private var sensitiveDisplayToken: String? = null
    private var phoneDialogActive = false
    private var secureFlagReleasePending = false
    private var secureFlagAddedByPlugin = false
    private val sensitiveLifecycleObserver = object : DefaultLifecycleObserver {
        override fun onResume(owner: LifecycleOwner) {
            if (sensitiveDisplayToken == null && secureFlagReleasePending) {
                if (secureFlagAddedByPlugin) {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
                if (!secureFlagAddedByPlugin || !hasSecureFlag()) {
                    secureFlagAddedByPlugin = false
                    secureFlagReleasePending = false
                }
            }
        }
    }

    init {
        (activity as? FragmentActivity)?.lifecycle?.addObserver(sensitiveLifecycleObserver)
    }

    /**
     * FLAG_SECURE is owned by an exact reveal lease. It remains set while the
     * activity is paused/backgrounded so Android cannot put recovery material
     * in screenshots, screen recordings, or the recents snapshot. A stale
     * renderer cleanup cannot clear a newer reveal's flag.
     */
    @Command
    fun setSensitiveDisplay(invoke: Invoke) {
        val args = invoke.parseArgs(SensitiveDisplayArgs::class.java)
        if (args.token.isBlank()) {
            return reject(invoke, "unavailable", "sensitive-display token is missing")
        }
        activity.runOnUiThread {
            if (args.active) {
                val previousToken = sensitiveDisplayToken
                val previousReleasePending = secureFlagReleasePending
                val previousFlagOwnership = secureFlagAddedByPlugin
                // Record ownership only for the first lease. A replacement, or
                // a new lease while background release is pending, inherits
                // that exact ownership rather than mistaking our own flag for
                // independent protection.
                if (sensitiveDisplayToken == null && !secureFlagReleasePending) {
                    secureFlagAddedByPlugin = !hasSecureFlag()
                }
                sensitiveDisplayToken = args.token
                secureFlagReleasePending = false
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                if (!hasSecureFlag()) {
                    // Keep Rust and native authority aligned if acquisition B
                    // fails while lease A is still awaiting its cleared paint.
                    sensitiveDisplayToken = previousToken
                    secureFlagReleasePending = previousReleasePending
                    secureFlagAddedByPlugin = previousFlagOwnership
                    return@runOnUiThread reject(invoke, "unavailable", "Android FLAG_SECURE did not apply")
                }
            } else if (sensitiveDisplayToken == args.token) {
                sensitiveDisplayToken = null
                val lifecycle = (activity as? FragmentActivity)?.lifecycle
                if (lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true) {
                    if (secureFlagAddedByPlugin) {
                        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                    if (secureFlagAddedByPlugin && hasSecureFlag()) {
                        sensitiveDisplayToken = args.token
                        return@runOnUiThread reject(invoke, "unavailable", "Android FLAG_SECURE did not clear")
                    }
                    secureFlagAddedByPlugin = false
                } else {
                    // Keep recents protected until the activity is foregrounded;
                    // renderer clearing may not have painted before background.
                    secureFlagReleasePending = secureFlagAddedByPlugin
                }
            }
            invoke.resolve()
        }
    }

    private fun hasSecureFlag(): Boolean =
        activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0

    @Command
    fun storeSeed(invoke: Invoke) {
        val args = invoke.parseArgs(StoreSeedArgs::class.java)
        val plaintext = args.phrase.toByteArray(Charsets.UTF_8)
        try {
            // Preserve original ciphertext before explicit recovery can replace it.
            // It is never read as custody or removed by the migration ceremony.
            val previous = prefs.getString(prefKey(args.walletId), null)
            if (previous != null && !prefs.contains("preserved_${args.walletId}") && !prefs.edit().putString("preserved_${args.walletId}", previous).commit()) {
                plaintext.fill(0)
                return reject(invoke, "unavailable", "could not preserve original ciphertext")
            }
            val key = getOrCreateKey()
            val encrypt: (Cipher) -> Unit = { authenticated ->
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
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                    init(Cipher.ENCRYPT_MODE, key)
                }
                authenticateCipher(invoke, cipher, encrypt, onFailure = { plaintext.fill(0) })
            } else {
                // Android 10 cannot combine DEVICE_CREDENTIAL with a CryptoObject.
                // Authenticate first, then use the short-duration authorized key.
                authenticateUser(invoke, onSuccess = {
                    try {
                        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                            init(Cipher.ENCRYPT_MODE, key)
                        }
                        encrypt(cipher)
                    } catch (error: Exception) {
                        plaintext.fill(0)
                        rejectCrypto(invoke, error)
                    }
                }, onFailure = { plaintext.fill(0) })
            }
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
            val key = requireKey()
            val decrypt: (Cipher) -> Unit = { authenticated ->
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
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                    init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
                }
                authenticateCipher(invoke, cipher, decrypt, onFailure = { ciphertext.fill(0) })
            } else {
                authenticateUser(invoke, onSuccess = {
                    try {
                        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
                        }
                        decrypt(cipher)
                    } catch (error: Exception) {
                        ciphertext.fill(0)
                        rejectCrypto(invoke, error)
                    }
                }, onFailure = { ciphertext.fill(0) })
            }
        } catch (error: Exception) {
            rejectCrypto(invoke, error)
        }
    }

    @Command
    fun seedInventoryStatus(invoke: Invoke) {
        // No manifest/ID is required to detect orphaned OS-restored ciphertext.
        val present = prefs.all.keys.any { it.startsWith("seed_") || it.startsWith("preserved_") }
        invoke.resolveObject(mapOf("state" to if (present) "present" else "empty"))
    }

    // Metadata only: no biometric prompt, no decryption, no key creation.
    @Command
    fun seedStatus(invoke: Invoke) {
        val args = invoke.parseArgs(SeedKeyArgs::class.java)
        val encoded = prefs.getString(prefKey(args.walletId), null)
        if (encoded == null) { invoke.resolveObject(mapOf("state" to "missing")); return }
        try {
            val record = Base64.decode(encoded, Base64.NO_WRAP)
            val state = if (record.size <= 1 + IV_LENGTH + 16 || record[0] != RECORD_VERSION) "corrupt"
                else { requireKey(); "present" }
            invoke.resolveObject(mapOf("state" to state))
        } catch (_: MissingSeedKey) { invoke.resolveObject(mapOf("state" to "missingKey")) }
        catch (_: Exception) { invoke.resolveObject(mapOf("state" to "unavailable")) }
    }

    @Command
    fun phoneRecoveryInput(invoke: Invoke) { phoneRecoveryDialog(invoke, null, invoke.parseArgs(PhoneLocaleArgs::class.java).locale) }

    @Command
    fun phoneRecoveryDisplay(invoke: Invoke) {
        val args = invoke.parseArgs(PhonePhraseArgs::class.java)
        phoneRecoveryDialog(invoke, args.phrase, args.locale)
    }

    // Deliberately native. Phrase input/output never traverses the WebView.
    private fun phoneRecoveryDialog(invoke: Invoke, phrase: String?, locale: String) {
        activity.runOnUiThread {
            val owner = activity as? FragmentActivity
            if (phoneDialogActive) { reject(invoke, "unavailable", "native recovery is already open"); return@runOnUiThread }
            if (owner == null || !owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                reject(invoke, "locked", "open ZUULI in the foreground"); return@runOnUiThread
            }
            val entry = EditText(activity).apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                imeOptions = android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                isLongClickable = false
                setText(phrase ?: "")
                if (phrase != null) { isEnabled = false; transformationMethod = null }
            }
            var completed = false
            val copy = when (locale) {
                "es" -> arrayOf("Recuperar cartera ZUULI", "Copia de recuperación sin conexión", "Introduce tu frase sin conexión. Solo autoriza la recuperación nativa. No se admiten contraseñas BIP39. Cancela si no lo has solicitado.", "Escribe estas palabras en orden en papel, en privado. No las fotografíes ni subas. Verifica la recuperación en el teléfono nuevo antes de retirar este.", "Continuar", "Cancelar")
                "fr" -> arrayOf("Récupérer le portefeuille ZUULI", "Sauvegarde de récupération hors ligne", "Saisissez votre phrase hors ligne. Cela autorise uniquement la récupération native. Les mots de passe BIP39 ne sont pas pris en charge. Annulez si vous ne l’avez pas demandé.", "Écrivez ces mots dans l’ordre sur papier, en privé. Ne les photographiez et ne les envoyez jamais. Vérifiez la récupération sur le nouveau téléphone avant de retirer celui-ci.", "Continuer", "Annuler")
                else -> arrayOf("Recover ZUULI wallet", "Offline ZUULI recovery backup", "Enter your offline recovery phrase. This authorizes native wallet recovery only. No BIP39 passphrase is supported. Cancel if you did not request this.", "Write these words in order on paper, privately. Never photograph or upload them. Verify recovery on the new phone before retiring this one.", "Continue", "Cancel")
            }
            val dialog = AlertDialog.Builder(activity)
                .setTitle(copy[if (phrase == null) 0 else 1])
                .setMessage(copy[if (phrase == null) 2 else 3])
                .setView(entry)
                .setNegativeButton(copy[5]) { _, _ -> }
                .setPositiveButton(copy[4]) { _, _ ->
                    completed = true
                    if (phrase == null) invoke.resolveObject(SeedValue(entry.text.toString())) else invoke.resolve()
                }.create()
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            val observer = object : DefaultLifecycleObserver {
                override fun onPause(owner: LifecycleOwner) { entry.text.clear(); dialog.dismiss() }
            }
            dialog.setOnDismissListener {
                phoneDialogActive = false
                entry.text.clear()
                owner.lifecycle.removeObserver(observer)
                if (!completed) reject(invoke, "auth_cancelled", "native recovery cancelled; original data preserved")
            }
            owner.lifecycle.addObserver(observer)
            phoneDialogActive = true
            try {
                dialog.show()
                dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } catch (_: Exception) {
                phoneDialogActive = false
                owner.lifecycle.removeObserver(observer)
                entry.text.clear()
                reject(invoke, "unavailable", "native recovery could not open; original data preserved")
            }
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

    private fun authenticateCipher(
        invoke: Invoke,
        cipher: Cipher,
        onSuccess: (Cipher) -> Unit,
        onFailure: () -> Unit = {}
    ) {
        val host = activity as? FragmentActivity
        if (host == null) {
            onFailure()
            reject(invoke, "unavailable", "biometric host activity is unavailable")
            return
        }
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
            val info = promptInfo()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        }
    }

    private fun authenticateUser(
        invoke: Invoke,
        onSuccess: () -> Unit,
        onFailure: () -> Unit = {}
    ) {
        val host = activity as? FragmentActivity
        if (host == null) {
            onFailure()
            reject(invoke, "unavailable", "authentication host activity is unavailable")
            return
        }
        activity.runOnUiThread {
            val prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(host),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        onSuccess()
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        onFailure()
                        rejectAuthentication(invoke, errorCode, errString)
                    }
                })
            prompt.authenticate(promptInfo())
        }
    }

    private fun promptInfo(): BiometricPrompt.PromptInfo {
        val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG or
                androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            // AndroidX supports WEAK | DEVICE_CREDENTIAL on API 29 for the
            // non-CryptoObject flow used above.
            androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK or
                androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
        }
        return BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock ZUULI wallet")
            .setSubtitle("Authenticate to use the wallet seed")
            .setAllowedAuthenticators(authenticators)
            .build()
    }

    private fun rejectAuthentication(invoke: Invoke, errorCode: Int, errString: CharSequence) {
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

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUnlockedDeviceRequired(true)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(
                0,
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
            )
        } else {
            // API 29 cannot use device credentials with a CryptoObject. A short
            // authorization window supports PIN/pattern/password without ever
            // making the non-exportable key generally available.
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(AUTH_WINDOW_SECONDS)
        }
        generator.init(builder.build())
        return generator.generateKey()
    }

    private fun requireKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return keyStore.getKey(KEY_ALIAS, null) as? SecretKey
            ?: throw MissingSeedKey()
    }

    private fun rejectCrypto(invoke: Invoke, error: Exception) {
        when (error) {
            is MissingSeedKey -> reject(invoke, "missing_key", "device key did not transfer; use your offline recovery backup and preserve the original phone")
            is AEADBadTagException -> reject(invoke, "corrupt", "secure seed authentication failed")
            is UserNotAuthenticatedException -> reject(invoke, "locked", "device authentication is required")
            is KeyPermanentlyInvalidatedException -> reject(invoke, "corrupt", "device security changed; restore the wallet from its recovery phrase")
            else -> reject(invoke, "unavailable", "secure storage is unavailable; preserve the original data")
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
        private const val AUTH_WINDOW_SECONDS = 15
        private const val RECORD_VERSION: Byte = 1
    }
}
