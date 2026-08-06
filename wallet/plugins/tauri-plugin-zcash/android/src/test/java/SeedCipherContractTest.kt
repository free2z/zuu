package cash.free2z.zuuli.zcash

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

class SeedCipherContractTest {
    @Test
    fun repeatedEncryptionUsesDistinctIvAndCiphertextAndStillAuthenticates() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val plaintext = "test seed material".toByteArray()

        val first = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key)
        }
        val firstCiphertext = first.doFinal(plaintext)

        val second = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key)
        }
        val secondCiphertext = second.doFinal(plaintext)

        assertFalse(first.iv.contentEquals(second.iv))
        assertFalse(firstCiphertext.contentEquals(secondCiphertext))
        assertNotEquals(0, first.iv.size)

        val decrypted = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, first.iv))
            doFinal(firstCiphertext)
        }
        assertArrayEquals(plaintext, decrypted)
    }
}
