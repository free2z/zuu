// SPDX-License-Identifier: MIT OR Apache-2.0

package cash.free2z.f2zmsg

import android.app.Activity
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
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
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class ServiceArgs {
    lateinit var service: String
}

@InvokeArg
class AccountArgs {
    lateinit var service: String
    lateinit var account: String
}

@InvokeArg
class StoreArgs {
    lateinit var service: String
    lateinit var account: String
    lateinit var value: String
}

data class WrapKeyValue(val value: String)

data class CustodyBacking(val backing: String)

/**
 * Android custody for the per-device `DeviceWrapKey` (ADR 0016 §3, issue #937).
 *
 * The AES-256-GCM key lives in `AndroidKeyStore` and is non-exportable;
 * `SharedPreferences` holds only `version || IV || ciphertext` and never key
 * material. This plugin holds ONE kind of secret — a 32-byte device-local wrap
 * key, hex encoded — and never a mnemonic or anything derived from one. That is
 * `tauri-plugin-zcash`'s ZcashPlugin, in a crate `cash.free2z.e2e2z` does not
 * link.
 *
 * # The two parameters that are deliberately absent
 *
 * `ZcashPlugin` sets `setUserAuthenticationRequired(true)` and
 * `setUnlockedDeviceRequired(true)` on the key that guards the seed, and is
 * right to: spending is user-initiated, so a prompt costs nothing.
 *
 * **Both are omitted here, on purpose.** The wrap key is opened by the inbound
 * relay poll and by background delivery, which run with no user present and
 * with the screen locked.
 *
 *   * `setUserAuthenticationRequired(true)` would require a `BiometricPrompt`
 *     per use. A background task cannot answer one, so message delivery would
 *     stop whenever the app was not in the foreground.
 *   * `setUnlockedDeviceRequired(true)` is the direct analogue of iOS
 *     `kSecAttrAccessibleWhenUnlocked` and is refused for the same reason: it
 *     makes the key unusable while the screen is locked, which is most of when
 *     there is work to do. The iOS side's `AfterFirstUnlock` and this omission
 *     are the same decision on two platforms.
 *
 * Neither omission is free, and the trade is the one ADR 0016 §3.5 identifies:
 * an engine that cannot open its wrap key in the background is one auto
 * re-enroll away from minting a directory entry per launch, and every one of
 * those must be surfaced to the user as a possible wiretap. A key that can be
 * used while the device is locked is worth strictly less than one that cannot;
 * a wiretap signal the user has been trained to dismiss is worth nothing.
 *
 * # Hardware backing is requested, reported, and not required
 *
 * StrongBox is asked for where the platform offers it and falls back to the
 * TEE, and then to the software keystore. The actual backing is reported by
 * [custodyBacking] and logged by the Rust side rather than assumed. Refusing a
 * software-backed keystore would lock out emulators and low-end handsets to
 * buy a property this process cannot verify anyway; a software `AndroidKeyStore`
 * key is still not readable by copying the app's data directory, which is the
 * threat the seal is actually about (`store.rs:186-192`).
 */
@TauriPlugin
class F2zMsgPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun custodyBacking(invoke: Invoke) {
        val args = invoke.parseArgs(ServiceArgs::class.java)
        try {
            val key = getOrCreateKey(args.service)
            invoke.resolveObject(CustodyBacking(describeBacking(key)))
        } catch (error: Exception) {
            rejectCrypto(invoke, error)
        }
    }

    @Command
    fun storeWrapKey(invoke: Invoke) {
        val args = invoke.parseArgs(StoreArgs::class.java)
        if (args.service.isBlank() || args.account.isBlank()) {
            return reject(invoke, "unavailable", "custody service and account are required")
        }
        val plaintext = args.value.toByteArray(Charsets.UTF_8)
        try {
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.ENCRYPT_MODE, getOrCreateKey(args.service))
            }
            val ciphertext = cipher.doFinal(plaintext)
            val record = ByteBuffer.allocate(1 + cipher.iv.size + ciphertext.size)
                .put(RECORD_VERSION)
                .put(cipher.iv)
                .put(ciphertext)
                .array()
            val encoded = Base64.encodeToString(record, Base64.NO_WRAP)
            // `commit()` and not `apply()`: the caller is about to treat this
            // as durable custody, and `apply()` returns before the write lands.
            if (!prefs(args.service).edit().putString(args.account, encoded).commit()) {
                reject(invoke, "unavailable", "wrap-key ciphertext persistence failed")
            } else {
                invoke.resolve()
            }
        } catch (error: Exception) {
            rejectCrypto(invoke, error)
        } finally {
            plaintext.fill(0)
        }
    }

    @Command
    fun getWrapKey(invoke: Invoke) {
        val args = invoke.parseArgs(AccountArgs::class.java)
        val encoded = prefs(args.service).getString(args.account, null)
            ?: return reject(invoke, "not_found", "no wrap key is stored")
        var plaintext: ByteArray? = null
        try {
            val record = Base64.decode(encoded, Base64.NO_WRAP)
            if (record.size <= 1 + IV_LENGTH || record[0] != RECORD_VERSION) {
                return reject(invoke, "corrupt", "the stored wrap key has an unsupported format")
            }
            val iv = record.copyOfRange(1, 1 + IV_LENGTH)
            val ciphertext = record.copyOfRange(1 + IV_LENGTH, record.size)
            val key = requireKey(args.service)
                ?: return reject(invoke, "corrupt", "the keystore key for this wrap key is gone")
            val cipher = Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            }
            plaintext = cipher.doFinal(ciphertext)
            invoke.resolveObject(WrapKeyValue(plaintext.toString(Charsets.UTF_8)))
        } catch (error: Exception) {
            rejectCrypto(invoke, error)
        } finally {
            plaintext?.fill(0)
        }
    }

    @Command
    fun deleteWrapKey(invoke: Invoke) {
        val args = invoke.parseArgs(AccountArgs::class.java)
        val store = prefs(args.service)
        if (!store.contains(args.account)) {
            return reject(invoke, "not_found", "no wrap key is stored")
        }
        if (!store.edit().remove(args.account).commit()) {
            reject(invoke, "unavailable", "wrap-key ciphertext deletion failed")
        } else {
            invoke.resolve()
        }
    }

    /**
     * One preferences file and one keystore alias per host application, keyed
     * by the namespace the host supplied. This library is embedded in both
     * ZUULI and e2e2z; a shared alias would give them one wrap key
     * (`src/custody.rs` §1). Android already isolates by UID, so this is
     * defence in depth rather than the only barrier — but it is also what keeps
     * the two apps' items distinguishable if they are ever packaged together.
     */
    private fun prefs(service: String) =
        activity.getSharedPreferences("$PREFERENCES_PREFIX${sanitize(service)}", Context.MODE_PRIVATE)

    private fun alias(service: String) = "$KEY_ALIAS_PREFIX${sanitize(service)}"

    /** Keep alias and file names to characters both APIs accept. */
    private fun sanitize(service: String) = service.replace(Regex("[^a-z0-9.-]"), "_")

    private fun getOrCreateKey(service: String): SecretKey {
        requireKey(service)?.let { return it }
        return generateKey(service, strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
    }

    private fun generateKey(service: String, strongBox: Boolean): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val builder = KeyGenParameterSpec.Builder(
            alias(service),
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
        // Deliberately NOT setUserAuthenticationRequired and NOT
        // setUnlockedDeviceRequired — see this class's documentation.
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }
        return try {
            generator.init(builder.build())
            generator.generateKey()
        } catch (unavailable: StrongBoxUnavailableException) {
            // Documented and expected on most handsets. Fall back to the TEE or
            // the software keystore; `custodyBacking` reports which.
            if (!strongBox) throw unavailable
            generateKey(service, strongBox = false)
        }
    }

    private fun requireKey(service: String): SecretKey? {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        return keyStore.getKey(alias(service), null) as? SecretKey
    }

    /**
     * Where the key actually ended up. Best effort by design: the API that
     * answers this changed at API 31 and the older one is deprecated, so an
     * unknown answer is reported as unknown rather than guessed.
     */
    private fun describeBacking(key: SecretKey): String = try {
        val factory = SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
        val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "hardware"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
                else -> "unknown"
            }
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) "hardware" else "software"
        }
    } catch (error: Exception) {
        "unknown"
    }

    /**
     * Exceptions in the vocabulary `src/custody_mobile.rs` classifies.
     *
     * [KeyPermanentlyInvalidatedException] is `corrupt` and not `not_found`,
     * and the difference matters: the ciphertext is still there and can never
     * be opened again, so the device must re-enroll rather than believe it was
     * never enrolled.
     */
    private fun rejectCrypto(invoke: Invoke, error: Exception) {
        when (error) {
            is AEADBadTagException ->
                reject(invoke, "corrupt", "the stored wrap key failed authentication")
            is KeyPermanentlyInvalidatedException ->
                reject(invoke, "corrupt", "the keystore key was invalidated; this device must re-enroll")
            is UserNotAuthenticatedException ->
                reject(invoke, "locked", "the keystore requires device authentication")
            else -> reject(invoke, "unavailable", error.message ?: error.javaClass.simpleName)
        }
    }

    private fun reject(invoke: Invoke, code: String, message: String) {
        invoke.reject(message, code)
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS_PREFIX = "f2zmsg.wrap-key."
        private const val PREFERENCES_PREFIX = "f2zmsg_wrap_key_v1_"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_LENGTH = 12
        private const val GCM_TAG_BITS = 128
        private const val RECORD_VERSION: Byte = 1
    }
}
