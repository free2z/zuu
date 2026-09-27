//! Every `f2z-ai-testkit` [`Fault`], the provider deadlines, and the retry
//! rules (zuu#1064): retry only before the first content event, within the
//! per-call policy and the per-provider budget, behind a circuit breaker;
//! errors mapped to the contract's codes (errors.md §4).

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod adapter_support;

use std::time::Duration;

use adapter_support::*;
use f2z_ai::provider::resilience::BreakerPolicy;
use f2z_ai::provider::{Phase, UsageReport};
use f2z_ai_proto::ErrorCode;
use f2z_ai_testkit::mock::{Fault, MockProvider, ProviderStyle, RenderContext, Scenario, plan};

/// The byte offset halfway through `scenario`'s stream in `model`'s style:
/// after the first content, before the end.
fn midstream(model: Model, scenario: &Scenario) -> u64 {
    let ctx = RenderContext {
        model: format!("{}-upstream", model.id),
        include_usage: true,
        request_seq: 1,
    };
    (plan(model.style, scenario, &ctx).body_bytes().len() / 2) as u64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_transient_status_is_retried_before_content_and_then_reported() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(2));
    let catalog = catalog(10_000);
    for model in [RESPONSES, ANTHROPIC, CHAT] {
        for status in [500, 502, 503, 529] {
            mock.set_scenario(Scenario::default().with_fault(Fault::Status { status }));
            let before = mock.request_count();
            let run = drive(&backend, &catalog, &request(model.id)).await;
            let label = format!("{} {status}", model.id);
            assert_eq!(mock.request_count() - before, 3, "{label}: 1 + 2 retries");
            assert_eq!(run.outcome.attempts, 3, "{label}");
            let f = run.outcome.failure.as_ref().unwrap();
            assert_eq!(f.code, ErrorCode::ProviderError, "{label}");
            assert_eq!(f.status, Some(status), "{label}");
            assert_eq!(f.phase, Phase::BeforeContent, "{label}");
            assert!(
                run.events.is_empty(),
                "{label}: a lone error, nothing streamed"
            );
            assert_eq!(run.outcome.usage, UsageReport::Missing { partial: None });
        }
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rate_limit_honours_retry_after_and_a_refusal_is_not_retried() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(1));
    let catalog = catalog(10_000);

    // 429 with `retry-after: 1`: waited out, once.
    mock.set_scenario(Scenario::default().with_fault(Fault::Status { status: 429 }));
    let run1 = drive(&backend, &catalog, &request(ANTHROPIC.id)).await;
    assert_eq!(run1.outcome.attempts, 2);
    assert!(run1.elapsed >= Duration::from_secs(1), "{:?}", run1.elapsed);
    let f = run1.outcome.failure.clone().unwrap();
    assert_eq!((f.code, f.retryable), (ErrorCode::ProviderError, true));
    assert_eq!(f.retry_after, Some(Duration::from_secs(1)));

    // The provider refused the request itself: the same request fails the
    // same way, so no retry.
    for (status, code) in [
        (400, ErrorCode::ProviderError),
        (404, ErrorCode::ProviderError),
        (401, ErrorCode::Internal),
        (403, ErrorCode::Internal),
    ] {
        mock.set_scenario(Scenario::default().with_fault(Fault::Status { status }));
        let before = mock.request_count();
        let run = drive(&backend, &catalog, &request(RESPONSES.id)).await;
        assert_eq!(mock.request_count() - before, 1, "{status}");
        let f = run.outcome.failure.unwrap();
        assert_eq!((f.code, f.retryable), (code, false), "{status}");
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disconnect_or_error_event_before_content_is_retried_after_content_is_not() {
    let mock = MockProvider::start(Scenario::default()).await.unwrap();
    let backend = backend(&mock.base_url(), tuning(2));
    let catalog = catalog(10_000);
    for model in [RESPONSES, ANTHROPIC, CHAT] {
        // Before any content: byte 0 cut, and an overload event at byte 0.
        for fault in [
            Fault::DisconnectAtByte { byte: 0 },
            Fault::DisconnectAtByte { byte: 20 },
            Fault::ErrorEventAtByte {
                byte: 0,
                status: 529,
            },
        ] {
            mock.set_scenario(Scenario::default().with_fault(fault));
            let run = drive(&backend, &catalog, &request(model.id)).await;
            let label = format!("{} {fault:?}", model.id);
            assert_eq!(run.outcome.attempts, 3, "{label}: retried");
            let f = run.outcome.failure.as_ref().unwrap();
            assert_eq!(f.code, ErrorCode::ProviderError, "{label}");
            assert_eq!(f.phase, Phase::BeforeContent, "{label}");
            assert!(run.events.is_empty(), "{label}");
        }

        // After content: never retried; the failure is after content, the
        // text so far was delivered, and no usage is invented.
        let scenario = Scenario::default().with_output_tokens(64);
        let byte = midstream(model, &scenario);
        for fault in [
            Fault::DisconnectAtByte { byte },
            Fault::ErrorEventAtByte { byte, status: 500 },
        ] {
            mock.set_scenario(scenario.clone().with_fault(fault));
            let run = drive(&backend, &catalog, &request(model.id)).await;
            let label = format!("{} {fault:?}", model.id);
            assert_eq!(run.outcome.attempts, 1, "{label}: not retried");
            let f = run.outcome.failure.as_ref().unwrap();
            assert_eq!(f.phase, Phase::AfterContent, "{label}");
            assert_eq!(f.code, ErrorCode::ProviderError, "{label}");
            assert!(run.deltas() > 0 && (run.deltas() as u64) < 64, "{label}");
            assert!(run.outcome.output_produced, "{label}");
            assert_eq!(
                run.outcome.usage.reported(),
                None,
                "{label}: no usage frame"
            );
            assert_eq!(run.usage_event(), None, "{label}");
        }
    }
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_byte_deadline_is_the_models_and_is_retried() {
    let mock = MockProvider::start(Scenario::default().with_ttfb(Duration::from_millis(400)))
        .await
        .unwrap();
    let backend = backend(&mock.base_url(), tuning(1));
    let run = drive(&backend, &catalog(100), &request(CHAT.id)).await;
    let f = run.outcome.failure.unwrap();
    assert_eq!(f.code, ErrorCode::ProviderTimeout);
    assert_eq!(f.timeout_phase(), Some("first_byte"));
    assert_eq!(run.outcome.attempts, 2);
    assert!(
        run.elapsed < Duration::from_millis(400),
        "{:?}",
        run.elapsed
    );
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_stream_and_the_hard_limit_end_the_call_after_content() {
    let mut fast = tuning(2);
    fast.timeouts.idle = Duration::from_millis(150);
    let mock = MockProvider::start(Scenario::default().with_stall(3, Duration::from_millis(1_500)))
        .await
        .unwrap();
    let backend_idle = backend(&mock.base_url(), fast);
    let run1 = drive(&backend_idle, &catalog(10_000), &request(ANTHROPIC.id)).await;
    let f = run1.outcome.failure.clone().unwrap();
    assert_eq!(
        (f.code, f.timeout_phase()),
        (ErrorCode::ProviderTimeout, Some("idle"))
    );
    assert_eq!(f.phase, Phase::AfterContent);
    assert_eq!(run1.deltas(), 3);
    assert_eq!(run1.outcome.attempts, 1);
    assert!(
        run1.elapsed < Duration::from_millis(1_000),
        "{:?}",
        run1.elapsed
    );

    // A steady trickle never idles, but the call's hard limit still ends it.
    let mut hard = tuning(2);
    hard.timeouts.hard_limit = Duration::from_millis(300);
    mock.set_scenario(
        Scenario::default()
            .with_output_tokens(100)
            .with_tokens_per_sec(50),
    );
    let backend_hard = backend(&mock.base_url(), hard);
    let run2 = drive(&backend_hard, &catalog(10_000), &request(RESPONSES.id)).await;
    let f = run2.outcome.failure.clone().unwrap();
    assert_eq!(
        (f.code, f.timeout_phase(), f.retryable),
        (ErrorCode::ProviderTimeout, Some("hard_limit"), false)
    );
    assert!(run2.deltas() > 0 && run2.deltas() < 100);
    assert!(
        run2.elapsed < Duration::from_millis(900),
        "{:?}",
        run2.elapsed
    );
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_connection_is_unavailable_and_retried() {
    // Bind and drop: a loopback port nothing listens on.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let backend = backend(&format!("http://127.0.0.1:{port}"), tuning(2));
    let run = drive(&backend, &catalog(10_000), &request(RESPONSES.id)).await;
    let f = run.outcome.failure.unwrap();
    assert_eq!((f.code, f.reason), (ErrorCode::Unavailable, "connect"));
    assert_eq!(run.outcome.attempts, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_breaker_opens_on_consecutive_failures_and_fails_fast() {
    let mock = MockProvider::start(Scenario::default().with_fault(Fault::Status { status: 503 }))
        .await
        .unwrap();
    let mut t = tuning(0);
    t.breaker = BreakerPolicy {
        failure_threshold: 2,
        open_for: Duration::from_millis(300),
    };
    let backend = backend(&mock.base_url(), t);
    let catalog = catalog(10_000);
    for _ in 0..2 {
        let run = drive(&backend, &catalog, &request(CHAT.id)).await;
        assert_eq!(run.outcome.failure.unwrap().status, Some(503));
    }
    assert!(backend.provider("chatco").unwrap().circuit_open());
    let before = mock.request_count();
    let run = drive(&backend, &catalog, &request(CHAT.id)).await;
    let f = run.outcome.failure.unwrap();
    assert_eq!(
        (f.code, f.reason),
        (ErrorCode::Unavailable, "provider_circuit_open")
    );
    assert_eq!(run.outcome.attempts, 0);
    assert_eq!(mock.request_count(), before, "no request while open");
    // Another provider is unaffected.
    assert!(!backend.provider("anthropic").unwrap().circuit_open());

    // After `open_for`, one probe; its success closes the breaker.
    tokio::time::sleep(Duration::from_millis(350)).await;
    mock.set_scenario(Scenario::default());
    let run = drive(&backend, &catalog, &request(CHAT.id)).await;
    assert_eq!(run.outcome.failure, None);
    assert!(!backend.provider("chatco").unwrap().circuit_open());
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_retry_budget_caps_retries_across_calls() {
    let mock = MockProvider::start(Scenario::default().with_fault(Fault::Status { status: 500 }))
        .await
        .unwrap();
    let mut t = tuning(2);
    t.budget_percent = 0;
    t.budget_burst = 3;
    let backend = backend(&mock.base_url(), t);
    let catalog = catalog(10_000);
    let attempts: Vec<u32> = {
        let mut v = Vec::new();
        for _ in 0..3 {
            v.push(
                drive(&backend, &catalog, &request(RESPONSES.id))
                    .await
                    .outcome
                    .attempts,
            );
        }
        v
    };
    // 3 retries in the bucket: the first call takes 2, the second 1, the
    // third none.
    assert_eq!(attempts, vec![3, 2, 1]);
    mock.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_success_after_retries_is_one_clean_stream() {
    // The first attempt gets a 503; the scenario is switched while the
    // upstream backs off, and the retry streams normally.
    let mock = MockProvider::start(Scenario::default().with_fault(Fault::Status { status: 503 }))
        .await
        .unwrap();
    let mut t = tuning(2);
    t.retry.base_backoff = Duration::from_millis(300);
    t.retry.max_backoff = Duration::from_millis(300);
    let backend = backend(&mock.base_url(), t);
    let catalog = catalog(10_000);
    let switch = async {
        while mock.request_count() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        mock.set_scenario(Scenario::default());
    };
    let req = request(ANTHROPIC.id);
    let (run, ()) = tokio::join!(drive(&backend, &catalog, &req), switch);
    assert_eq!(run.outcome.attempts, 2);
    assert_eq!(run.outcome.failure, None);
    assert_eq!(run.text(), mock_text(16));
    assert_eq!(
        run.outcome.usage.reported(),
        Scenario::default().expected_usage(ProviderStyle::AnthropicMessages, true)
    );
    mock.shutdown().await;
}
