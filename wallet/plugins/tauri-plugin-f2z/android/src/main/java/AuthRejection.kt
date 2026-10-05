// SPDX-License-Identifier: MIT
package cash.free2z.sdk

/**
 * Why a native sign-in ended without a callback, as the `code` of the
 * `authorize` rejection. The Rust core maps exactly these strings
 * (`platform.rs`, `native_auth_rejection`); `null` — no code — is its
 * `browser_error` fallback, for an ending this layer cannot attribute.
 */
internal object AuthRejection {
    const val USER_CANCELLED = "user_cancelled"
    const val BROWSER_UNAVAILABLE = "browser_unavailable"
    const val TIMEOUT = "timeout"

    enum class Ending {
        /**
         * The app resumed from the Custom Tab without a callback. Custom Tabs
         * report no dismissal of their own, so this is the dismissal signal; a
         * browser that closed itself looks the same.
         */
        DISMISSED,
        /** The attempt's deadline passed. */
        TIMED_OUT,
        /** The Custom Tab could not be launched (no browser handles it). */
        LAUNCH_FAILED,
        /** The activity was destroyed, or Rust withdrew the attempt. */
        ABANDONED,
    }

    fun code(ending: Ending): String? = when (ending) {
        Ending.DISMISSED -> USER_CANCELLED
        Ending.TIMED_OUT -> TIMEOUT
        Ending.LAUNCH_FAILED -> BROWSER_UNAVAILABLE
        Ending.ABANDONED -> null
    }
}
