//! Compile the shipping IPC codec without a Tauri/OS runtime. This verifies the
//! native DTO boundary, not an iOS/Android build or browser/keychain behavior.
#![allow(dead_code, missing_docs)]
// The shipping codec uses JSON indexing under the plugin lint policy.
#[allow(clippy::indexing_slicing)]
#[cfg(not(test))]
#[path = "../../../../wallet/plugins/tauri-plugin-f2z/src/wire.rs"]
mod wire;

#[cfg(not(test))]
#[path = "../tests/support/mod.rs"]
mod support;

#[cfg(not(test))]
#[tokio::main]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
async fn main() {
    let options: wire::SignInOptions = serde_json::from_str(
        r#"{"loginHint":"alice + test","uiLocales":"es-MX en","prompt":"consent"}"#,
    )
    .unwrap();
    let core = options.into_core().unwrap();
    assert_eq!(core.login_hint.as_deref(), Some("alice + test"));
    assert_eq!(core.ui_locales.as_deref(), Some("es-MX en"));
    let fake = support::Fake::start().await;
    let client = f2z_sdk::Client::new(
        fake.config(),
        std::sync::Arc::new(f2z_sdk::MemoryStore::new()),
    )
    .unwrap();
    let browser = f2z_sdk::oauth::LoopbackSession::bind(support::loopback_browser())
        .await
        .unwrap();
    let session = client.sign_in(&browser, core).await.unwrap();
    assert!(session.scopes.iter().any(|scope| scope == "ai:invoke"));
    let balance = wire::value(&client.balance().await.unwrap()).unwrap();
    assert!(balance["available_milli_2z"].is_string());
    let grant = wire::value(&client.grant().await.unwrap()).unwrap();
    assert_eq!(grant["enforced"], true);
    let models = wire::value(&client.ai().models().await.unwrap()).unwrap();
    assert!(models["models"][0]["capabilities"]["structured_output"].is_boolean());
    let request = f2z_sdk::proto::ChatRequest::new("needs-top-up", vec![])
        .with_max_output_tokens(1800)
        .strict();
    let error = client.ai().estimate(&request).await.unwrap_err();
    let dto = serde_json::to_value(wire::NativeError::from(error)).unwrap();
    assert_eq!(dto["code"], "insufficient_balance");
    assert_eq!(dto["details"]["required_2z"], "12");
    assert_eq!(dto["details"]["available_milli_2z"], "500");
    assert!(dto.get("message").is_none());
    let dto = wire::value(&serde_json::json!({"available_milli_2z": u64::MAX})).unwrap();
    assert_eq!(dto["available_milli_2z"], u64::MAX.to_string());
    let request = wire::chat_request(serde_json::json!({
        "model": models["models"][0]["id"], "messages": [{"role":"user","content":[{"type":"text","text":"JSON"}]}],
        "max_output_tokens": "1800", "max_output_tokens_strict": true
    }))
    .unwrap();
    let estimate = wire::value(&client.ai().estimate(&request).await.unwrap()).unwrap();
    assert!(estimate["hold_2z"].is_string());
    let mut stream = client
        .ai()
        .chat_with(
            request,
            f2z_sdk::ai::ChatOptions::default()
                .with_idempotency_key("native-dto-probe")
                .with_max_retries(0),
        )
        .await
        .unwrap();
    let mut saw_done = false;
    while let Some(event) = stream.next().await.unwrap() {
        let dto = wire::event(&event).unwrap();
        if dto["type"] == "done" {
            assert_eq!(dto["charge"]["state"], "charged");
            assert!(dto["charge"]["charged2z"].is_string());
            saw_done = true;
        }
    }
    assert!(saw_done);
    let record = client.ai().call(stream.call_id().unwrap()).await.unwrap();
    let dto = wire::call_record(&record).unwrap();
    assert_eq!(dto["charge"]["state"], "charged");
    assert!(dto["charge"]["charged2z"].is_string());
    client.sign_out().await.unwrap();
    println!(
        "Shipping native DTO codec: hints, grant, balance, models, estimate, stream, receipt and refusal passed"
    );
}
