pub mod intent;
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
        // The intent bridge's authority side (#905). Managed state, never an
        // IPC command: it holds the one-use replay ledger for the process, and
        // the privileged WebView must not be able to mint an intent (#367).
        // `wallet/zuuli/src-tauri/src/intent.rs` is where the reasoning lives.
        .manage(intent::IntentAuthority::new())
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

    /// #753 — the census.
    ///
    /// `tauri_plugin_f2zmsg::init()`'s `setup` hook is fallible end to end, an
    /// `Err` from a plugin's setup makes `tauri::Builder::build()` fail, and
    /// `run()` above ends in `.expect("error while running tauri
    /// application")`. So a messaging store that would not open took the entire
    /// wallet down at launch — and WAL is unavailable on some filesystems, a
    /// data directory can be full or read-only, and a half-written
    /// `f2zmsg.sqlite` is a state a real device reaches.
    ///
    /// Four things are asserted here and nothing weaker would do:
    ///
    /// 1. **The app still builds.** That single `.expect` on `build()` below is
    ///    the defect: before the fix it failed, and ZUULI did not start.
    /// 2. **`get_engine_status` answers** §6.1's `faulted` carrying the §8
    ///    code, so the UI can say *why* messaging is unavailable rather than
    ///    render an empty screen.
    /// 3. **`check_handle_eligibility` still answers from the string alone,**
    ///    including a positive control that rejects malformed input. A test
    ///    that only accepts `alice` would also pass an implementation that says
    ///    yes to everything.
    /// 4. **Every engine- or storage-dependent command refuses, and none
    ///    panics** — driven off
    ///    `tauri_plugin_f2zmsg::COMMANDS`, the same `with_f2zmsg_commands!`
    ///    expansion that builds the invoke handler and the permission manifest,
    ///    so this cannot cover forty of forty-three and look green. The
    ///    enrollment trio is checked alongside it: those three live in this
    ///    crate (§2.2) and reach the same engine.
    ///
    /// Failing soft could not be done by skipping `app.manage(..)`:
    /// `F2zMsgExt::f2zmsg` is `state::<F2zMsg<R>>().inner()`, which panics on an
    /// unmanaged type, so every command that needs state would have panicked
    /// instead of refusing. Pure handle eligibility does not touch managed
    /// state; that distinction is precisely what this test would catch.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn an_unopenable_messaging_store_routes_only_engine_free_commands() {
        /// The §8 code an occupied store path produces. `SqliteBackend::open`
        /// answers `SQLITE_CANTOPEN`, which is the same statement as a
        /// read-only or permission-denied data directory: this device cannot
        /// host a store that may ACK (§11.2).
        const FAULT: &str = "durability-unavailable";

        /// A valid payload for each command, so the refusal under test is the
        /// engine's absence and not argument validation — an "invalid args"
        /// answer would prove only that the command was routed.
        ///
        /// `None` means the command takes no `args` key at all (§3). The final
        /// `panic!` is the census: a command added to §3 fails here until
        /// someone states how to call it.
        fn args_for(command: &str) -> Option<serde_json::Value> {
            match command {
                "get_engine_status"
                | "start_engine"
                | "stop_engine"
                | "get_device_info"
                | "list_contact_requests"
                | "get_self_audit_state"
                | "list_alarms"
                | "list_relays"
                | "list_witnesses"
                | "get_witness_set_state" => None,
                // Every field of these two is optional, and §3 still nests them
                // under `args`.
                "list_conversations" | "get_retention_policy" => Some(json!({})),
                "get_conversation"
                | "leave_conversation"
                | "get_receipt_policy"
                | "list_gaps"
                | "get_ephemeral_hint"
                | "list_purge_requests"
                | "get_safety_number" => Some(json!({ "conversationId": "conversation-1" })),
                "start_conversation" | "resolve_handle" => Some(json!({ "handle": "alice" })),
                "check_handle_eligibility" => Some(json!({ "username": "alice" })),
                "accept_contact_request" => Some(json!({ "requestId": "request-1" })),
                "reject_contact_request" => {
                    Some(json!({ "requestId": "request-1", "block": false }))
                }
                "send_message" => Some(json!({
                    "conversationId": "conversation-1",
                    "body": "hello",
                    "clientRef": "client-ref-1",
                })),
                "retry_send" | "cancel_send" | "get_message" | "get_delivery_state" => {
                    Some(json!({ "msgId": "message-1" }))
                }
                "list_messages" => Some(json!({ "conversationId": "conversation-1", "limit": 20 })),
                "mark_read" => Some(json!({
                    "conversationId": "conversation-1",
                    "upToMsgId": "message-1",
                })),
                "set_receipt_policy" => Some(json!({
                    "conversationId": "conversation-1",
                    "deliveryReceipts": true,
                    "readReceipts": false,
                })),
                "request_gap_repair" => Some(json!({
                    "conversationId": "conversation-1",
                    "gapIds": ["gap-1"],
                })),
                "set_retention_policy" => Some(json!({
                    "scope": "global",
                    "mode": "expire",
                    "ttlSeconds": 604_800,
                })),
                "send_ephemeral_hint" => Some(json!({
                    "conversationId": "conversation-1",
                    "mode": "ephemeral",
                    "ttlSeconds": 300,
                })),
                "send_purge_request" => Some(json!({
                    "conversationId": "conversation-1",
                    "beforeEpoch": 7,
                })),
                "set_verification" => Some(json!({
                    "conversationId": "conversation-1",
                    "safetyNumberDigest": "0011223344556677",
                    "verified": true,
                })),
                "acknowledge_alarm" => Some(json!({
                    "alarmId": "alarm-1",
                    "confirmation": "i-have-read-this",
                })),
                "add_relay" => Some(json!({ "relayUrl": "wss://relay.invalid/" })),
                "remove_relay" | "get_relay_capabilities" => Some(json!({ "relayId": "relay-1" })),
                "set_relay_trust" => Some(json!({
                    "relayId": "relay-1",
                    "allowInsecureTransport": false,
                    "allowNoChannelBinding": false,
                })),
                "set_witness_set" => Some(json!({ "witnesses": [], "threshold": 1 })),
                other => panic!(
                    "{other} was added to the plugin's command registry; \
                     state how to call it so #753's census still covers it"
                ),
            }
        }

        // A data directory whose store path is occupied by a *directory*.
        // SQLite cannot open it, and arranging that needs neither root nor a
        // filesystem the test machine may not have.
        let store = tempfile::tempdir().expect("temp data directory");
        std::fs::create_dir(store.path().join("f2zmsg.sqlite")).expect("occupy the store path");

        // (1) The app builds. This `.expect` is the whole defect.
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_f2zmsg::init_with_store_dir(
                store.path().to_path_buf(),
            ))
            .invoke_handler(tauri::generate_handler![
                super::messaging::f2zmsg_enrollment_status,
                super::messaging::f2zmsg_enroll,
                super::messaging::f2zmsg_unenroll,
            ])
            .build(super::app_context())
            .expect("a messaging store that will not open must not stop ZUULI from starting");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock main webview");

        let invoke = |cmd: String, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd,
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().expect("invoke URL"),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
        };
        let body_for = |command: &str| match args_for(command) {
            Some(args) => json!({ "args": args }),
            None => json!({}),
        };

        // (2) `get_engine_status` answers instead of refusing.
        let status = invoke(
            "plugin:f2zmsg|get_engine_status".to_owned(),
            body_for("get_engine_status"),
        )
        .expect("get_engine_status must report the fault, not refuse")
        .deserialize::<serde_json::Value>()
        .expect("an engine status is JSON");
        assert_eq!(
            status["state"],
            json!("faulted"),
            "the UI has to be able to say messaging is unavailable: {status}"
        );
        assert_eq!(status["lastError"], json!(FAULT), "…and why: {status}");

        // (3) The pure validator answers without an engine. Both cases are
        // mutation controls: routing through `engine()?` breaks the eligible
        // assertion, while replacing validation with an unconditional answer
        // breaks the malformed one.
        let eligible = invoke(
            "plugin:f2zmsg|check_handle_eligibility".to_owned(),
            json!({ "args": { "username": "SkylarSaveland" } }),
        )
        .expect("pure handle eligibility must survive a store startup fault")
        .deserialize::<serde_json::Value>()
        .expect("handle eligibility is JSON");
        assert_eq!(
            eligible,
            json!({
                "eligible": true,
                "candidate": "skylarsaveland",
                "reason": null,
            })
        );

        let malformed = invoke(
            "plugin:f2zmsg|check_handle_eligibility".to_owned(),
            json!({ "args": { "username": "Not A Handle!" } }),
        )
        .expect("malformed eligibility is an answer, not an engine failure")
        .deserialize::<serde_json::Value>()
        .expect("handle eligibility is JSON");
        assert_eq!(
            malformed,
            json!({
                "eligible": false,
                "candidate": null,
                "reason": "punctuation",
            })
        );

        // (4) Every engine- or storage-dependent command refuses with the same
        // §8 code. The registry-driven census makes any new answering command
        // fail until its faulted-state behavior is reviewed here explicitly.
        assert_eq!(
            tauri_plugin_f2zmsg::COMMANDS.len(),
            43,
            "§3's plugin surface changed; the census below covers whatever it now is"
        );
        for command in tauri_plugin_f2zmsg::COMMANDS {
            if matches!(*command, "get_engine_status" | "check_handle_eligibility") {
                continue;
            }
            let refused = invoke(format!("plugin:f2zmsg|{command}"), body_for(command))
                .expect_err("an engine-dependent command with no engine must refuse, not answer");
            assert_eq!(
                refused,
                json!(FAULT),
                "plugin:f2zmsg|{command} must refuse with a §8 code"
            );
        }

        // …and so does the enrollment trio, which lives in this crate (§2.2)
        // and reaches the same engine. `f2zmsg_enroll` refuses *before* it
        // reads the wallet seed.
        for (command, body) in [
            ("f2zmsg_enrollment_status", json!({})),
            ("f2zmsg_enroll", json!({ "args": { "handle": "alice" } })),
            (
                "f2zmsg_unenroll",
                json!({ "args": { "confirmation": "DELETE" } }),
            ),
        ] {
            let refused = invoke(command.to_owned(), body)
                .expect_err("enrollment with no engine must refuse, not answer");
            assert_eq!(
                refused,
                json!(FAULT),
                "{command} must refuse with a §8 code"
            );
        }
    }

    /// The negative control for the test above: the same build over a *usable*
    /// data directory is not faulted. Without it, a plugin that faulted
    /// unconditionally would pass the census and prove nothing.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn a_messaging_store_that_opens_leaves_the_engine_reachable() {
        let store = tempfile::tempdir().expect("temp data directory");
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_f2zmsg::init_with_store_dir(
                store.path().to_path_buf(),
            ))
            .build(super::app_context())
            .expect("mock ZUULI app over a usable messaging store");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("mock main webview");

        let status = tauri::test::get_ipc_response(
            &webview,
            tauri::webview::InvokeRequest {
                cmd: "plugin:f2zmsg|get_engine_status".to_owned(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().expect("invoke URL"),
                body: tauri::ipc::InvokeBody::Json(json!({})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        )
        .expect("a usable store answers")
        .deserialize::<serde_json::Value>()
        .expect("an engine status is JSON");
        assert_ne!(
            status["state"],
            json!("faulted"),
            "a writable data directory must produce an engine: {status}"
        );
        assert_eq!(status["lastError"], json!(null));
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
