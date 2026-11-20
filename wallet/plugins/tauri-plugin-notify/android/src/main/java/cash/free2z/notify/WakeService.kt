package cash.free2z.notify
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** Foreground/background/cold-start callbacks only buffer untrusted data. No wallet authority. */
class WakeService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        if (token.length !in 20..4096) return
        try { var changed=false; Vault.mutate(this) { changed=NotificationRecord.token(it,NotificationRecord.revision(it),token) }; if (changed) NotifyPlugin.changed() } catch (_: Exception) { }
    }
    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data.keys != setOf("queue", "generation", "sequence", "expires", "signature") || data.values.any { it.length > 128 }) return
        val pending = JSONObject(data as Map<*, *>).toString()
        if (pending.toByteArray().size > 1024) return
        try { Vault.mutate(this) { if (Vault.active(it)) it.put("pending", pending) } } catch (_: Exception) { }
    }
}
