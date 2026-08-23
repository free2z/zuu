mod oauth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Native payment confirmation is intentionally available only to Rust.
        // No dialog permission is granted to the privileged webview.
        .plugin(tauri_plugin_dialog::init())
        // Exact private-use redirects for iOS/Android social OAuth and native
        // Checkout recovery. The plugin registers oauth/callback and
        // checkout/return; their Rust/TypeScript consumers independently
        // validate the full URL and the signed, session-bound payload.
        .plugin(tauri_plugin_deep_link::init())
        // Native HTTP client the frontend uses (@tauri-apps/plugin-http) to call
        // the free2z API without browser CORS — required for Login with Zcash.
        .plugin(tauri_plugin_http::init())
        // The shared Zcash engine — same plugin the zuuallet reference wallet
        // uses (librustzcash path dependency). This is what makes ZUULI a real
        // Zcash wallet on the desktop.
        .plugin(tauri_plugin_zcash::init())
        // Loopback (127.0.0.1) OAuth redirect capture for desktop social login
        // (X / Google / GitHub) — ZUULI-specific, see src/oauth.rs. Inert
        // until invoked; the frontend only calls these commands once the
        // backend reports a provider is configured.
        .manage(oauth::OauthLoopbackState::default())
        .manage(oauth::OauthMobileState::default())
        .invoke_handler(tauri::generate_handler![
            oauth::oauth_loopback_start,
            oauth::oauth_loopback_wait,
            oauth::oauth_loopback_cancel,
            oauth::oauth_callback_transport,
            oauth::oauth_mobile_arm,
            oauth::oauth_mobile_pending,
            oauth::oauth_mobile_claim,
            oauth::oauth_mobile_resume,
            oauth::oauth_mobile_finish,
            oauth::oauth_mobile_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
