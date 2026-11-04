//! Tool-calling conformance (zuu#1128): every fixture in
//! `tests/fixtures/tool_calling/` is run through the real Chat Completions
//! adapter against a loopback endpoint that answers with the fixture's
//! provider stream. No real provider is called.
//!
//! Each fixture pins three things:
//!
//! * `provider_request` — members the provider must receive exactly (the
//!   OpenAI-shaped `tools`, `tool_choice`, `parallel_tool_calls`, and the
//!   translated tool history);
//! * `events` — the unified events the client gets, in order: every
//!   `tool_call_delta` fragment, then each complete `tool_call`;
//! * `finish_reason` and the normalised `usage`.
//!
//! The same request with `stream: false` must yield the same complete calls
//! and no fragment. `refusals.json` holds requests an adapter must refuse
//! before any I/O; the metering half of the refusal (before any hold) is in
//! `metered.rs`.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use f2z_ai::catalog::{VerifiedCatalog, now_unix};
use f2z_ai::config::ProviderConfig;
use f2z_ai::provider::ProviderBackend;
use f2z_ai_proto::Event;
use f2z_ai_proto::chat::{ChatRequest, FinishReason};
use serde_json::{Value, json};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tool_calling")
}

fn fixture(name: &str) -> Value {
    let path = fixtures_dir().join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap())
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Every stream fixture (all but `refusals.json`), by file name.
fn stream_fixtures() -> Vec<(String, Value)> {
    let mut names: Vec<String> = std::fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".json") && n != "refusals.json")
        .collect();
    names.sort();
    assert!(names.len() >= 4, "fixtures went missing: {names:?}");
    names
        .into_iter()
        .map(|n| (n.clone(), fixture(&n)))
        .collect()
}

fn model(id: &str, provider: &str, style: &str, capabilities: Value) -> Value {
    json!({
        "id": id, "provider": provider, "provider_model_id": format!("{id}-upstream"),
        "api_style": style,
        "prices": {"input_nusd_per_mtok": 1000, "cached_input_nusd_per_mtok": 100,
                   "cache_write_nusd_per_mtok": 1250, "output_nusd_per_mtok": 4000,
                   "image_nusd": 0, "tool_call_nusd": 0},
        "min_charge_2z": 1, "safety_factor_bps": 10000, "context_window": 200000,
        "max_output_tokens": 8192, "ttfb_timeout_ms": 10000, "enabled": true,
        "capabilities": capabilities,
    })
}

/// One model per conformance case, named by the fixtures' `provider` /
/// `model`. Every one signs `tools: true` except `no_tools`.
pub fn conformance_catalog() -> VerifiedCatalog {
    let now = now_unix();
    let tools = json!({"tools": true});
    let catalog = serde_json::from_value(json!({
        "schema": 1, "version": 1, "issued_at": now - 60, "expires_at": now + 3600,
        "rate_card_version": 1, "platform_margin_bps": 2000,
        "models": [
            model("openai", "openai", "openai_chat", tools.clone()),
            model("xai", "xai", "openai_chat", tools.clone()),
            model("responses", "openai", "openai_responses", tools.clone()),
            model("anthropic", "anthropic", "anthropic_messages", tools.clone()),
            model("no_tools", "openai", "openai_chat", json!({})),
            model("openai_strict_off", "openai", "openai_chat",
                  json!({"tools": true, "strict_tools": false})),
        ],
    }))
    .unwrap();
    VerifiedCatalog::from_verified(catalog).unwrap()
}

fn backend(base: &str) -> ProviderBackend {
    let mut providers = BTreeMap::new();
    for (name, include) in [("openai", true), ("xai", false), ("anthropic", true)] {
        providers.insert(
            name.to_owned(),
            ProviderConfig {
                base_url: base.to_owned(),
                api_key: format!("test-key-{name}").into(),
                completion_tokens_include_reasoning: include,
            },
        );
    }
    ProviderBackend::new(&providers, adapter_support::tuning(0)).unwrap()
}

/// A loopback Chat Completions endpoint that records each request body and
/// answers with `stream` as SSE `data:` lines.
async fn endpoint(
    stream: &[Value],
) -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let body: String = stream
        .iter()
        .map(|chunk| match chunk {
            Value::String(done) => format!("data: {done}\n\n"),
            other => format!("data: {other}\n\n"),
        })
        .collect();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&seen);
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |axum::Json(request): axum::Json<Value>| {
            let captured = Arc::clone(&captured);
            let body = body.clone();
            async move {
                captured.lock().unwrap().push(request);
                ([("content-type", "text/event-stream")], body)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base, seen, server)
}

fn request_of(fixture: &Value, model: &str, stream: bool) -> ChatRequest {
    let mut request = fixture["request"].clone();
    request["model"] = json!(model);
    request["stream"] = json!(stream);
    serde_json::from_value(request).unwrap()
}

/// Every member of `expected` equals the same member of `sent`. Returns the
/// first that does not, so a test can also assert that a mismatch IS seen.
fn first_mismatch(expected: &Value, sent: &Value) -> Option<String> {
    expected
        .as_object()
        .unwrap()
        .iter()
        .find(|(key, value)| sent.get(key.as_str()) != Some(value))
        .map(|(key, value)| {
            format!(
                "{key}: expected {value}, sent {}",
                sent.get(key.as_str()).unwrap_or(&Value::Null)
            )
        })
}

fn tagged(events: &[Event]) -> Vec<Value> {
    events
        .iter()
        .filter(|e| !matches!(e, Event::Usage(_)))
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_fixture_translates_and_streams_as_recorded() {
    let catalog = conformance_catalog();
    for (name, fixture) in stream_fixtures() {
        let stream: Vec<Value> = fixture["provider_stream"].as_array().unwrap().clone();
        let model = fixture["provider"].as_str().unwrap();
        for streamed in [true, false] {
            let (base, seen, server) = endpoint(&stream).await;
            let backend = backend(&base);
            let request = request_of(&fixture, model, streamed);
            let run = adapter_support::drive(&backend, &catalog, &request).await;

            let sent = seen.lock().unwrap()[0].clone();
            if let Some(mismatch) = first_mismatch(&fixture["provider_request"], &sent) {
                panic!("{name}: provider request differs — {mismatch}");
            }
            assert_eq!(
                sent["stream"], true,
                "{name}: the provider is always streamed"
            );

            let expected: Vec<Value> = fixture["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| streamed || e["type"] != "tool_call_delta")
                .cloned()
                .collect();
            assert_eq!(
                tagged(&run.events),
                expected,
                "{name} (stream: {streamed}): events"
            );
            let reason: FinishReason =
                serde_json::from_value(fixture["finish_reason"].clone()).unwrap();
            assert_eq!(run.outcome.finish_reason, Some(reason), "{name}");
            assert!(
                run.outcome.failure.is_none(),
                "{name}: {:?}",
                run.outcome.failure
            );
            let usage = run.usage_event().expect("usage reported");
            assert_eq!(
                (
                    usage.input_tokens + usage.cached_input_tokens,
                    usage.output_tokens
                ),
                (
                    fixture["usage"]["input_tokens"].as_u64().unwrap(),
                    fixture["usage"]["output_tokens"].as_u64().unwrap()
                ),
                "{name}: usage"
            );
            // Function calls the client runs are never billed as provider
            // tool invocations.
            assert_eq!(usage.tool_calls, 0, "{name}");
            assert_eq!(
                run.outcome.function_tool_calls,
                u64::try_from(run.tool_calls().len()).unwrap(),
                "{name}"
            );
            server.abort();
        }
    }
}

/// Negative control for the comparator above: an adapter that dropped any
/// one pinned member must be caught, or the conformance check is vacuous.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_tool_control_is_detected() {
    let fixture = fixture("openai_strict_forced_streamed.json");
    let (base, seen, server) = endpoint(fixture["provider_stream"].as_array().unwrap()).await;
    let request = request_of(&fixture, "openai", true);
    adapter_support::drive(&backend(&base), &conformance_catalog(), &request).await;
    let sent = seen.lock().unwrap()[0].clone();
    assert_eq!(first_mismatch(&fixture["provider_request"], &sent), None);
    for member in ["tools", "tool_choice", "parallel_tool_calls"] {
        let mut dropped = sent.clone();
        dropped.as_object_mut().unwrap().remove(member);
        assert!(
            first_mismatch(&fixture["provider_request"], &dropped).is_some(),
            "dropping {member} went unnoticed"
        );
    }
    let mut lax = sent;
    lax["tools"][0]["function"]
        .as_object_mut()
        .unwrap()
        .remove("strict");
    assert!(
        first_mismatch(&fixture["provider_request"], &lax).is_some(),
        "dropping strict went unnoticed"
    );
    server.abort();
}

/// The adapter half of `refusals.json`: what the adapter cannot express is
/// refused by `open`, before any I/O. (`no_tools` is the metering layer's
/// refusal — capability, not translation — and is covered in `metered.rs`.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn untranslatable_tool_features_are_refused_before_any_io() {
    let (base, seen, server) = endpoint(&[]).await;
    let backend = backend(&base);
    let catalog = conformance_catalog();
    let refusals = fixture("refusals.json");
    for case in refusals["cases"].as_array().unwrap() {
        if case["model"] == "no_tools" {
            continue;
        }
        let request = request_of(case, case["model"].as_str().unwrap(), true);
        let failure = backend
            .open(&request, &catalog, Instant::now())
            .err()
            .unwrap_or_else(|| panic!("{}: not refused", case["name"]));
        assert_eq!(
            failure.detail_of("reason"),
            Some(&json!("tools_unsupported")),
            "{}",
            case["name"]
        );
        assert_eq!(
            failure.detail_of("field"),
            Some(&case["field"]),
            "{}",
            case["name"]
        );
        // Negative control: without the refused member the same request
        // opens on the same model.
        let mut plain = case.clone();
        let field = case["field"].as_str().unwrap();
        let body = plain["request"].as_object_mut().unwrap();
        if field.ends_with(".strict") {
            body["tools"][0].as_object_mut().unwrap().remove("strict");
        } else {
            body.remove(field);
        }
        let request = request_of(&plain, case["model"].as_str().unwrap(), true);
        assert!(
            backend.open(&request, &catalog, Instant::now()).is_ok(),
            "{}: refused even without {field}",
            case["name"]
        );
    }
    assert!(
        seen.lock().unwrap().is_empty(),
        "a refused request reached the provider"
    );
    server.abort();
}
