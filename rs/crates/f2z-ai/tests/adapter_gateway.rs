//! The adapters inside the real gateway (zuu#1064): a `ProviderBackend`
//! behind `/v1/chat`, read by the skeleton's call task, handed to the
//! settler. What the settler receives is what a ledger settle will be made
//! from, so it is asserted against `Scenario::expected_usage` here too.
//!
//! The call task polls `Upstream::next` in a `select!` beside a 250 ms stall
//! tick, dropping the `next` future every time the tick wins. The idle test
//! below is the proof that a provider deadline survives that: a deadline
//! kept as a relative timeout inside `next` would be restarted by every tick
//! and never fire.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;
mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use adapter_support::{ANTHROPIC, CHAT, RESPONSES, backend, catalog, tuning};
use axum::http::StatusCode;
use f2z_ai::catalog::Fixed;
use f2z_ai::provider::{ProviderBackend, UsageReport};
use f2z_ai::settle::UpstreamEnd;
use f2z_ai_proto::ErrorCode;
use f2z_ai_proto::chat::FinishReason;
use f2z_ai_testkit::mock::{AnthropicCumulative, MockProvider, ProviderStyle, Scenario};
use serde_json::json;
use support::{RecordingSettler, config, deps, post_chat, start, text, wait_records};

fn chat_body(model: &str) -> serde_json::Value {
    json!({
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
    })
}

async fn gateway(backend: ProviderBackend, settler: RecordingSettler) -> support::Running {
    let config = config(&[]);
    start(
        &config,
        deps(Arc::new(Fixed(catalog(10_000))), Arc::new(backend), settler),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_settler_receives_the_providers_usage_and_the_client_the_stream() {
    let scenario = Scenario::default()
        .with_cache(40, 25)
        .with_anthropic_cumulative(AnthropicCumulative {
            server_tool_input_tokens: 500,
            server_tool_uses: 2,
            message_deltas: 3,
        });
    let mock = MockProvider::start(scenario.clone()).await.unwrap();
    let settler = RecordingSettler::default();
    let running = gateway(backend(&mock.base_url(), tuning(0)), settler.clone()).await;

    let response = post_chat(running.public, &chat_body(ANTHROPIC.id)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = text(response).await;
    let expected = scenario
        .expected_usage(ProviderStyle::AnthropicMessages, true)
        .unwrap();
    assert!(body.contains("event: delta"), "{body}");
    assert!(
        body.contains(&format!(
            "\"input_tokens\":{},\"cached_input_tokens\":40,\"cache_write_tokens\":25",
            expected.input_tokens
        )),
        "{body}"
    );

    let record = wait_records(&settler, 1).await.remove(0);
    assert_eq!(record.upstream, UpstreamEnd::Finished);
    assert_eq!(record.usage, Some(expected));
    let outcome = record.outcome.unwrap();
    assert_eq!(outcome.usage, UsageReport::Reported(expected));
    assert_eq!(outcome.finish_reason, Some(FinishReason::Stop));
    assert_eq!(outcome.failure, None);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_report_reaches_the_settler_as_missing_not_zero() {
    let mock = MockProvider::start(Scenario::default().without_usage())
        .await
        .unwrap();
    let settler = RecordingSettler::default();
    let running = gateway(backend(&mock.base_url(), tuning(0)), settler.clone()).await;
    for (n, model) in [RESPONSES, ANTHROPIC, CHAT].into_iter().enumerate() {
        let body = text(post_chat(running.public, &chat_body(model.id)).await).await;
        assert!(body.contains("event: delta"), "{body}");
        assert!(!body.contains("event: usage"), "{}: {body}", model.id);
        let record = wait_records(&settler, n + 1).await.remove(n);
        assert_eq!(record.usage, None, "{}", model.id);
        assert!(
            matches!(record.outcome.unwrap().usage, UsageReport::Missing { .. }),
            "{}",
            model.id
        );
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_failure_before_content_is_a_stream_not_an_http_error() {
    // chat-api.md §2.2 step 7: the provider is contacted after the response
    // began, so its failure arrives in the stream (the metering layer adds
    // the lone `error` event); the settler learns the code and the phase.
    let mock = MockProvider::start(
        Scenario::default().with_fault(f2z_ai_testkit::mock::Fault::Status { status: 503 }),
    )
    .await
    .unwrap();
    let settler = RecordingSettler::default();
    let running = gateway(backend(&mock.base_url(), tuning(1)), settler.clone()).await;
    let response = post_chat(running.public, &chat_body(CHAT.id)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = text(response).await;
    assert!(!body.contains("event: delta"), "{body}");
    let record = wait_records(&settler, 1).await.remove(0);
    let outcome = record.outcome.unwrap();
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, ErrorCode::ProviderError);
    assert_eq!(outcome.attempts, 2);
    assert!(!outcome.output_produced);
    assert_eq!(record.usage, None);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_idle_deadline_fires_under_the_call_tasks_ticks() {
    let mock = MockProvider::start(Scenario::default().with_stall(2, Duration::from_secs(4)))
        .await
        .unwrap();
    let mut t = tuning(0);
    t.timeouts.idle = Duration::from_millis(700);
    let settler = RecordingSettler::default();
    let running = gateway(backend(&mock.base_url(), t), settler.clone()).await;
    let started = Instant::now();
    let body = text(post_chat(running.public, &chat_body(RESPONSES.id)).await).await;
    let record = wait_records(&settler, 1).await.remove(0);
    let elapsed = started.elapsed();
    assert_eq!(body.matches("event: delta").count(), 2, "{body}");
    let outcome = record.outcome.unwrap();
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.timeout_phase(), Some("idle"));
    assert!(
        elapsed < Duration::from_millis(2_500),
        "the idle deadline must fire despite the 250 ms ticks: {elapsed:?}"
    );
    mock.shutdown().await;
}

/// The request body's share of the upload budget follows the bytes: the
/// adapter keeps the request until the provider's 2xx head (it may have to
/// re-send it), so the reservation is held until then — not dropped when
/// `start` returns, which would let retained requests escape the budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_retained_request_keeps_its_upload_reservation_until_the_head() {
    let mock = MockProvider::start(Scenario::default().with_ttfb(Duration::from_millis(800)))
        .await
        .unwrap();
    let config = config(&[
        ("F2Z_AI_MAX_BODY_BYTES", "1000"),
        ("F2Z_AI_MAX_BODY_BYTES_WITH_IMAGES", "1000"),
        ("F2Z_AI_MAX_UPLOAD_BUFFER_BYTES", "1200"),
    ]);
    let running = start(
        &config,
        deps(
            Arc::new(Fixed(catalog(10_000))),
            Arc::new(backend(&mock.base_url(), tuning(0))),
            RecordingSettler::default(),
        ),
    )
    .await;
    let padded = |n: usize| {
        let mut body = chat_body(CHAT.id);
        let base = body.to_string().len();
        body["messages"][0]["content"][0]["text"] = json!("x".repeat(n - base + 5));
        body
    };
    let first = padded(700);
    assert!(first.to_string().len() >= 690 && first.to_string().len() <= 710);
    let public = running.public;
    let slow = tokio::spawn(async move { text(post_chat(public, &first).await).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The first call is waiting for its head and still holds ~700 bytes.
    let refused = post_chat(running.public, &padded(700)).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = slow.await.unwrap();
    assert!(body.contains("event: delta"), "{body}");
    // After the head the reservation is released.
    let ok = post_chat(running.public, &padded(700)).await;
    assert_eq!(ok.status(), StatusCode::OK);
    mock.shutdown().await;
}
