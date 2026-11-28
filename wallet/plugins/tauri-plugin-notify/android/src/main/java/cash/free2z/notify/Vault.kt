package cash.free2z.notify

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One encrypted bounded record in noBackupFilesDir. No identifier, token or capability logs. */
internal object Vault {
    private const val ALIAS = "cash.free2z.zuuli.notify.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun active(state: JSONObject): Boolean = NotificationRecord.active(state)
    @Synchronized fun read(context: Context): JSONObject {
        val file = AtomicFile(File(context.noBackupFilesDir, "notification-state"))
        if (!file.baseFile.exists()) return JSONObject()
        val bytes = file.openRead().use { input ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                require(output.size() + count <= 24576)
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        require(bytes.size in 29..24576)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    @Synchronized fun write(context: Context, state: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key())
        val plain = state.toString().toByteArray(Charsets.UTF_8); require(plain.size <= 24000)
        val bytes = cipher.iv + cipher.doFinal(plain)
        val file = AtomicFile(File(context.noBackupFilesDir, "notification-state"))
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (e: Exception) { file.failWrite(stream); throw e }
    }
    @Synchronized fun mutate(context: Context, change: (JSONObject) -> Unit) {
        val state = read(context); change(state); write(context, state)
    }
}
