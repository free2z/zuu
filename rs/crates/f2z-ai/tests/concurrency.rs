//! Admission limits: the gateway-wide concurrent call limit answers `503`
//! with `Retry-After`, counts a call until it is settled (not until its head),
//! never blocks the admin listener, and the request timeout is a `500`.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::sync::Arc;
use std::time::Duration;

use axum::http::{StatusCode, header};
use f2z_ai::settle::{Delivery, UpstreamEnd};
use support::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn beyond_the_limit_is_503_with_retry_after_until_a_stream_ends() {
    let (backend, mut streams) = ControlledBackend::new();
    let config = config(&[
        ("F2Z_AI_MAX_CONCURRENT_CALLS", "2"),
        ("F2Z_AI_RETRY_AFTER_SECS", "3"),
    ]);
    let settler = RecordingSettler::default();
    let running = start(&config, deps(fixed_catalog(), backend, settler)).await;
    let (public, admin) = (running.public, running.admin);
    wait_readyz(admin, StatusCode::OK).await;

    // Two streams whose heads have been sent and whose bodies are open. With
    // a limit released at the response head these would already be free.
    let first = post_chat(public, &valid_chat("1")).await;
    let second = post_chat(public, &valid_chat("2")).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    let first_stream = streams.recv().await.unwrap();
    let _second_stream = streams.recv().await.unwrap();

    let refused = post_chat(public, &valid_chat("3")).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(refused.headers()[header::RETRY_AFTER], "3");
    let error = error_of(refused).await;
    assert_eq!(error["code"], "unavailable");
    assert!(error.get("details").is_none(), "{error}");
    assert!(
        streams.try_recv().is_err(),
        "the refused call reached the backend"
    );

    // Probes are not subject to the limit.
    assert_eq!(get(admin, "/healthz").await.0, StatusCode::OK);
    assert_eq!(get(admin, "/readyz").await.0, StatusCode::OK);
    assert_eq!(metric(admin, "f2z_ai_active_streams ").await, "2");
    assert_eq!(
        metric(admin, "f2z_ai_rejected_total{reason=\"overloaded\"} ").await,
        "1"
    );
    assert_eq!(
        metric(
            admin,
            "f2z_ai_requests_total{route=\"chat\",status=\"503\"} "
        )
        .await,
        "1"
    );

    // One stream ends; its slot frees; a new call is admitted.
    first_stream.send(usage(1)).await.unwrap();
    drop(first_stream);
    assert_eq!(text(first).await, sse(&usage(1)));
    let mut admitted = None;
    for _ in 0..100 {
        let response = post_chat(public, &valid_chat("4")).await;
        if response.status() == StatusCode::OK {
            admitted = Some(response);
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(admitted.is_some(), "the freed slot was never reused");
    drop(second);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handler_that_never_answers_is_a_500_at_the_request_timeout() {
    let config = config(&[("F2Z_AI_REQUEST_TIMEOUT_SECS", "1")]);
    let settler = RecordingSettler::default();
    let running = start(
        &config,
        deps(fixed_catalog(), Arc::new(StallingBackend), settler.clone()),
    )
    .await;
    wait_readyz(running.admin, StatusCode::OK).await;
    let started = std::time::Instant::now();
    let response = post_chat(running.public, &valid_chat("x")).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert_eq!(error_of(response).await["code"], "internal");
    // And its slot is released once the call's own start timeout fires —
    // after the call was handed to the settler as not started, so a hold the
    // backend took inside `start` could be released.
    wait_metric(running.admin, "f2z_ai_active_streams ", "0").await;
    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::NotStarted);
    assert_eq!(records[0].delivery, Delivery::None);
}
