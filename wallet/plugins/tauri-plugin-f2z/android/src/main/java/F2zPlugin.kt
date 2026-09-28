// SPDX-License-Identifier: MIT
package cash.free2z.sdk

import android.app.Activity
import android.content.Intent
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabsIntent
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg class RedirectArgs { var https: String? = null; var privateScheme: String? = null }
@InvokeArg class AuthArgs { lateinit var attemptId: String; lateinit var url: String; lateinit var redirectUri: String; var timeoutMs: Long = 0 }
@InvokeArg class CancelArgs { lateinit var attemptId: String }
@InvokeArg class BrowserArgs { lateinit var url: String }

@TauriPlugin
@Suppress("OVERRIDE_DEPRECATION") // Retain Tauri 2.5-compatible lifecycle hooks.
class F2zPlugin(private val activity: Activity): Plugin(activity) {
    private val handler = Handler(Looper.getMainLooper())
    private data class Pending(val invoke: Invoke, val id: String, val redirect: Uri, val state: String, val expiry: Runnable)
    private var pending: Pending? = null
    private var leftApplication = false
    override fun onPause() { if (pending != null) leftApplication = true }
    override fun onResume() {
        val current = pending
        if (current != null && leftApplication) {
            handler.postDelayed({ finish(current.id, null) }, 300)
        }
    }
    override fun onDestroy() { pending?.let { finish(it.id, null) } }
    private fun redirectUri(value: String): Uri? {
        val uri = Uri.parse(value)
        if (uri.query != null || uri.fragment != null || uri.userInfo != null || uri.path.isNullOrEmpty()) return null
        if (uri.scheme == "https") return if (uri.host.isNullOrEmpty()) null else uri
        return if (uri.scheme?.contains('.') == true) uri else null
    }
    @Command fun redirect(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(RedirectArgs::class.java)
            val https = args.https?.let(::redirectUri)?.takeIf { it.scheme == "https" }
            if (https != null && Build.VERSION.SDK_INT >= 31) {
                val manager = activity.getSystemService(DomainVerificationManager::class.java)
                val state = manager?.getDomainVerificationUserState(activity.packageName)
                if (state?.hostToStateMap?.get(https.host) == DomainVerificationUserState.DOMAIN_STATE_VERIFIED) {
                    invoke.resolve(JSObject().put("uri", args.https)); return
                }
            }
            val fallback = args.privateScheme?.let(::redirectUri)?.takeIf { it.scheme != "https" }
                ?: return invoke.reject("verified app link or private callback required")
            invoke.resolve(JSObject().put("uri", fallback.toString()))
        } catch (_: Exception) { invoke.reject("invalid callback configuration") }
    }
    @Command fun authorize(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                val args = invoke.parseArgs(AuthArgs::class.java)
                val uri = Uri.parse(args.url)
                val redirect = redirectUri(args.redirectUri)
                val state = uri.getQueryParameter("state")
                if (pending != null || uri.scheme != "https" || redirect == null || state.isNullOrEmpty() || args.timeoutMs !in 1..300000) {
                    invoke.reject("authentication unavailable"); return@runOnUiThread
                }
                val expiry = Runnable { finish(args.attemptId, null) }
                leftApplication = false
                pending = Pending(invoke, args.attemptId, redirect, state, expiry)
                handler.postDelayed(expiry, args.timeoutMs)
                CustomTabsIntent.Builder().build().launchUrl(activity, uri)
            } catch (_: Exception) {
                val current = pending
                if (current?.invoke === invoke) finish(current.id, null) else invoke.reject("browser unavailable")
            }
        }
    }
    private fun finish(id: String, uri: Uri?) {
        val current = pending?.takeIf { it.id == id } ?: return
        pending = null; handler.removeCallbacks(current.expiry)
        if (uri == null) current.invoke.reject("authentication cancelled")
        else current.invoke.resolve(JSObject().put("url", uri.toString()))
    }
    override fun onNewIntent(intent: Intent) {
        val uri = intent.data ?: return
        activity.runOnUiThread {
            val current = pending ?: return@runOnUiThread
            val target = current.redirect
            try {
                if (!CallbackPolicy.accepts(uri.toString(), target.toString(), current.state)) return@runOnUiThread
                finish(current.id, uri)
            } catch (_: Exception) { /* Unrelated/malformed intent never consumes the attempt. */ }
        }
    }
    @Command fun cancelAuth(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(CancelArgs::class.java)
            activity.runOnUiThread { finish(args.attemptId, null); invoke.resolve() }
        } catch (_: Exception) { invoke.reject("invalid cancellation") }
    }
    @Command fun openBrowser(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(BrowserArgs::class.java)
            val uri = Uri.parse(args.url)
            if (uri.scheme != "https" || uri.userInfo != null) { invoke.reject("invalid checkout URL"); return }
            activity.runOnUiThread {
                try { CustomTabsIntent.Builder().build().launchUrl(activity, uri); invoke.resolve() }
                catch (_: Exception) { invoke.reject("browser unavailable") }
            }
        } catch (_: Exception) { invoke.reject("invalid browser request") }
    }
}
