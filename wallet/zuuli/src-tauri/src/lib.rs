mod messaging;
mod oauth;

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

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
        // End-to-end encrypted messaging (docs/e2ee/CLIENT-CONTRACT.md §3).
        // Its `on_event` handler is deliberately NOT the Zcash plugin's: that
        // one clears the seed on `Focused(false)`, and a messaging engine torn
        // down on every alt-tab would drop relay connections and stop
        // acknowledging inbound messages, leaving ciphertext on relays. §9
        // rule 6: `Exit` / `ExitRequested` only.
        .plugin(tauri_plugin_f2zmsg::init())
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
            // Enrollment (§2.2). App-crate commands, no `plugin:` prefix and
            // no capability entry, because they need the wallet seed and it
            // must never cross IPC.
            messaging::f2zmsg_enrollment_status,
            messaging::f2zmsg_enroll,
            messaging::f2zmsg_unenroll,
        ])
        .run(app_context())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    #[cfg(not(target_os = "windows"))]
    use serde_json::json;
    #[cfg(not(target_os = "windows"))]
    use tauri::WebviewWindowBuilder;

    #[test]
    fn shipping_mobile_capability_authorizes_sensitive_entry_lifecycle() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json")))
                .expect("Tauri must emit valid shipping capabilities");
        let permissions = capabilities["mobile"]["permissions"]
            .as_array()
            .expect("shipping mobile capability permissions");
        let permission_ids = permissions
            .iter()
            .map(|permission| {
                permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .expect("shipping mobile permission identifier")
            })
            .collect::<Vec<_>>();

        for permission in [
            "zcash:allow-begin-sensitive-entry",
            "zcash:allow-end-sensitive-display",
        ] {
            assert!(
                permission_ids.contains(&permission),
                "shipping mobile capability must authorize {permission}"
            );
        }
    }

    #[test]
    fn shipping_capabilities_authorize_the_messaging_plugin_on_both_platforms() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/capabilities.json")))
                .expect("Tauri must emit valid shipping capabilities");

        // Desktop takes the plugin's `default` set. Mobile enumerates, and
        // `wallet/zuuli/scripts/mobile-webview-authority.mjs` decides which —
        // this only proves the messaging plugin is authorized there at all, so
        // that a capability file losing every `f2zmsg:` entry is a red test and
        // not a silently unreachable feature on the platform it has to work on.
        let identifiers = |capability: &str| -> Vec<String> {
            capabilities[capability]["permissions"]
                .as_array()
                .expect("shipping capability permissions")
                .iter()
                .map(|permission| {
                    permission
                        .as_str()
                        .or_else(|| permission["identifier"].as_str())
                        .expect("shipping permission identifier")
                        .to_owned()
                })
                .collect()
        };

        assert!(
            identifiers("default").contains(&"f2zmsg:default".to_owned()),
            "the desktop capability must grant the messaging plugin",
        );
        let mobile = identifiers("mobile");
        assert!(
            mobile
                .iter()
                .any(|identifier| identifier == "f2zmsg:allow-send-message"),
            "the mobile capability must authorize sending a message",
        );
        assert!(
            !mobile
                .iter()
                .any(|identifier| identifier == "f2zmsg:default"),
            "mobile main takes named messaging permissions, never the blanket set",
        );
        // §2.2: enrollment is an app-crate command, so no capability grants it.
        assert!(
            !mobile
                .iter()
                .chain(identifiers("default").iter())
                .any(|identifier| identifier.contains("f2zmsg-enroll")),
            "enrollment is not a plugin command and must not appear in a capability",
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn shipping_router_registers_the_messaging_surface_and_enrollment() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_f2zmsg::command_router())
            .invoke_handler(tauri::generate_handler![
                super::messaging::f2zmsg_enroll,
                super::messaging::f2zmsg_unenroll,
            ])
            .build(super::app_context())
            .expect("mock ZUULI app with the shipping messaging routers");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock main webview");

        // Argument validation is what answers here, which is the point: it
        // proves the command was *routed* before anything in its body ran. A
        // command that is not registered answers "not found" instead.
        //
        // The plugin half carries the `plugin:f2zmsg|` prefix; the enrollment
        // half deliberately carries none (§2.2), and getting that wrong in
        // either direction is a runtime failure with no build-time symptom.
        for (cmd, command) in [
            ("plugin:f2zmsg|send_message", "send_message"),
            ("plugin:f2zmsg|start_conversation", "start_conversation"),
            ("f2zmsg_enroll", "f2zmsg_enroll"),
            ("f2zmsg_unenroll", "f2zmsg_unenroll"),
        ] {
            let error = tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: cmd.to_owned(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().expect("invoke URL"),
                    body: tauri::ipc::InvokeBody::Json(json!({})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
            .expect_err("registered command must reject its missing arguments");
            assert_eq!(
                error,
                json!(
                    "invalid args `args` for command `".to_owned()
                        + command
                        + "`: command "
                        + command
                        + " missing required key args"
                ),
                "the shipping router must route {cmd} before argument validation",
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn shipping_zcash_router_registers_sensitive_entry_commands() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_zcash::command_router())
            .build(super::app_context())
            .expect("mock ZUULI app with shipping zcash router");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock main webview");

        for command in ["begin_sensitive_entry", "end_sensitive_display"] {
            let error = tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: format!("plugin:zcash|{command}"),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().expect("invoke URL"),
                    body: tauri::ipc::InvokeBody::Json(json!({})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
            .expect_err("registered command must reject its missing arguments");
            assert_eq!(
                error,
                json!(
                    "invalid args `args` for command `".to_owned()
                        + command
                        + "`: command "
                        + command
                        + " missing required key args"
                ),
                "the shipping plugin must route {command} before argument validation",
            );
        }
    }
}
