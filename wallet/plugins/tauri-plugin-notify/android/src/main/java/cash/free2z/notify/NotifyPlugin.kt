package cash.free2z.notify
import android.Manifest
import android.app.Activity
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import app.tauri.plugin.Plugin
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

@InvokeArg class SaveArgs { lateinit var lease: String; lateinit var revision: String }
@InvokeArg class ConsumeArgs { lateinit var pending: String; lateinit var revision: String }
@InvokeArg class RevisionArgs { lateinit var revision: String }
@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "postNotification")])
class NotifyPlugin(private val activity: Activity) : Plugin(activity) {
    private var permissionRevision: String? = null
    override fun load(webView: android.webkit.WebView) { current = java.lang.ref.WeakReference(this) }
    companion object {
        private var current = java.lang.ref.WeakReference<NotifyPlugin>(null)
        fun changed() { current.get()?.trigger("changed",JSObject()) }
    }
    private fun snapshotValue(): JSObject {
        val state = Vault.read(activity)
        return JSObject().apply {
            put("permission", if (NotificationManagerCompat.from(activity).areNotificationsEnabled()) "granted" else "denied")
            put("token", state.optString("token"))
            put("enabled",state.optString("enabled")=="1")
            put("revision",NotificationRecord.revision(state))
            if (state.has("lease")) put("lease", state.getString("lease"))
            if (state.has("pending")) put("pending", state.getString("pending"))
        }
    }
    // Keep auto-init disabled across relaunch; only Rust's validated private
    // startup or explicit consent may request/refresh a token.
    @Command fun resume(invoke: Invoke) {
        try {
            if (Vault.active(Vault.read(activity)) && NotificationManagerCompat.from(activity).areNotificationsEnabled()) register(invoke,NotificationRecord.revision(Vault.read(activity)))
            else invoke.resolve()
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun snapshot(invoke: Invoke) {
        try { invoke.resolve(snapshotValue()) } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun begin(invoke: Invoke) {
        try { val args=invoke.parseArgs(SaveArgs::class.java)
            Vault.mutate(activity) { NotificationRecord.begin(it,args.revision,args.lease) }; invoke.resolve()
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun start(invoke: Invoke) {
        try {
            val args=invoke.parseArgs(RevisionArgs::class.java)
            require(Vault.active(Vault.read(activity)) && NotificationRecord.revision(Vault.read(activity))==args.revision)
            permissionRevision=args.revision
            if (Build.VERSION.SDK_INT >= 33 && !NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
                requestPermissionForAlias("postNotification",invoke,"permissionResult");return
            }
            if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) { snapshot(invoke); return }
            register(invoke,args.revision)
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @PermissionCallback private fun permissionResult(invoke: Invoke) {
        val revision=permissionRevision ?: run { invoke.reject("unavailable");return }
        if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) { snapshot(invoke);return }
        register(invoke,revision)
    }
    private fun register(invoke: Invoke, revision: String) {
        try {
            require(Vault.active(Vault.read(activity)) && NotificationRecord.revision(Vault.read(activity))==revision)
            if (FirebaseApp.getApps(activity).isEmpty() && FirebaseApp.initializeApp(activity) == null) { invoke.reject("unconfigured");return }
            val messaging=FirebaseMessaging.getInstance();messaging.isAutoInitEnabled=false
            messaging.token.addOnCompleteListener { task ->
                try {
                    var tokenChanged=false
                    if (task.isSuccessful) Vault.mutate(activity) { tokenChanged=NotificationRecord.token(it,revision,task.result) }
                    if (tokenChanged) changed()
                } catch (_: Exception) { /* keep bounded bootstrap pending; no secrets/errors emitted */ }
            }
            invoke.resolve(snapshotValue())
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun payment(invoke: Invoke) {
        try {
            val state = Vault.read(activity)
            val lease = org.json.JSONObject(state.optString("lease", "{}"))
            if (!Vault.active(state) || lease.optBoolean("disabled", true) || lease.optLong("expires") <= System.currentTimeMillis() / 1000 || !NotificationManagerCompat.from(activity).areNotificationsEnabled()) { invoke.resolve(); return }
            val manager = activity.getSystemService(android.app.NotificationManager::class.java)
            manager.createNotificationChannel(android.app.NotificationChannel("wallet-activity", "ZUULI", android.app.NotificationManager.IMPORTANCE_DEFAULT))
            val intent = activity.packageManager.getLaunchIntentForPackage(activity.packageName) ?: run { invoke.reject("unavailable"); return }
            val pending = android.app.PendingIntent.getActivity(activity, 384, intent, android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
            val notification = androidx.core.app.NotificationCompat.Builder(activity,"wallet-activity")
                .setSmallIcon(activity.applicationInfo.icon).setContentTitle("ZUULI")
                .setContentText(activity.getString(R.string.wallet_activity))
                .setVisibility(androidx.core.app.NotificationCompat.VISIBILITY_PRIVATE)
                .setContentIntent(pending).setAutoCancel(true).setSilent(true).build()
            manager.notify(384,notification); invoke.resolve()
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun save(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(SaveArgs::class.java); require(args.lease.toByteArray().size <= 16384)
            Vault.mutate(activity) { NotificationRecord.save(it,args.revision,args.lease) }; invoke.resolve()
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun stop(invoke: Invoke) {
        try {
            Vault.mutate(activity) { NotificationRecord.stop(it) }
            permissionRevision=null
            activity.getSystemService(android.app.NotificationManager::class.java).cancel(384)
            if (FirebaseApp.getApps(activity).isNotEmpty()) {
                FirebaseMessaging.getInstance().isAutoInitEnabled = false
                FirebaseMessaging.getInstance().deleteToken()
            }
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun clear(invoke: Invoke) {
        try { val args=invoke.parseArgs(RevisionArgs::class.java); Vault.mutate(activity) { NotificationRecord.clear(it,args.revision) }; invoke.resolve() } catch (_: Exception) { invoke.reject("unavailable") }
    }
    @Command fun consume(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ConsumeArgs::class.java)
            Vault.mutate(activity) { require(NotificationRecord.revision(it)==args.revision && Vault.active(it)); if (it.optString("pending") == args.pending) it.remove("pending") }; invoke.resolve()
        } catch (_: Exception) { invoke.reject("unavailable") }
    }
}
