//! Graceful drain (zuu#1054): an in-flight stream keeps reading its upstream
//! and delivering through the drain window, new work is refused, readiness
//! flips; a call still open when the window closes is cut and handed to the
//! settler as drained. Also: a client that hangs up ends delivery only.
//!
//! These drive the drain through `Gateway::run_until`'s signal future;
//! `tests/sigterm.rs` repeats the first case with a real `SIGTERM`.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::time::Duration;

use axum::http::{StatusCode, header};
use f2z_ai::Stopped;
use f2z_ai::settle::{Delivery, UpstreamEnd};
use support::*;
use tokio::sync::oneshot;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_in_flight_stream_keeps_reading_and_delivering_through_the_drain() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[("F2Z_AI_DRAIN_TIMEOUT_SECS", "30")]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    let (public, admin) = (running.public, running.admin);
    wait_readyz(admin, StatusCode::OK).await;

    // A stream is open and has produced its first event.
    let response = post_chat(public, &valid_chat("hello")).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "text/event-stream"
    );
    let mut body = response.into_body();
    let upstream = streams.recv().await.unwrap();
    upstream.send(delta("one")).await.unwrap();
    assert_eq!(
        next_frame(&mut body).await.unwrap().unwrap(),
        sse(&delta("one"))
    );
    assert_eq!(metric(admin, "f2z_ai_active_streams ").await, "1");

    // Drain.
    let (signal, fired) = oneshot::channel::<()>();
    let run = tokio::spawn(running.gateway.run_until(async move {
        let _ = fired.await;
    }));
    signal.send(()).unwrap();

    // Readiness flips; liveness does not.
    wait_readyz(admin, StatusCode::SERVICE_UNAVAILABLE).await;
    let (_, why) = get(admin, "/readyz").await;
    assert!(why.contains("draining"), "{why}");
    assert_eq!(get(admin, "/healthz").await.0, StatusCode::OK);
    assert_eq!(metric(admin, "f2z_ai_draining ").await, "1");

    // New work is refused: 503 unavailable / draining, Retry-After, close.
    let refused = post_chat(public, &valid_chat("new work")).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(refused.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(refused.headers()[header::CONNECTION], "close");
    let error = error_of(refused).await;
    assert_eq!(error["code"], "unavailable");
    assert_eq!(error["details"]["reason"], "draining");
    assert!(
        streams.try_recv().is_err(),
        "a refused call reached the backend"
    );

    // The open call keeps reading upstream to its usage, and the drain waits.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!run.is_finished(), "the drain returned with a call open");
    upstream.send(delta("two")).await.unwrap();
    upstream.send(usage(2)).await.unwrap();
    assert_eq!(
        next_frame(&mut body).await.unwrap().unwrap(),
        sse(&delta("two"))
    );
    assert_eq!(
        next_frame(&mut body).await.unwrap().unwrap(),
        sse(&usage(2))
    );
    drop(upstream);
    assert_eq!(next_frame(&mut body).await.unwrap(), None, "clean end");

    let Stopped::Drained(report) = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("expected a drain");
    };
    assert_eq!(report.in_flight_at_start, 1);
    assert!(report.completed_in_window);
    assert_eq!(report.aborted, 0);

    let records = settler.records();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].usage.unwrap().output_tokens, 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_still_open_when_the_window_closes_is_cut_and_settled_as_drained() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[
        ("F2Z_AI_DRAIN_TIMEOUT_SECS", "1"),
        ("F2Z_AI_ABORT_GRACE_SECS", "1"),
    ]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    let (public, admin) = (running.public, running.admin);
    wait_readyz(admin, StatusCode::OK).await;

    let mut body = post_chat(public, &valid_chat("long answer"))
        .await
        .into_body();
    let upstream = streams.recv().await.unwrap();
    upstream.send(delta("one")).await.unwrap();
    assert!(next_frame(&mut body).await.unwrap().is_some());

    let started = std::time::Instant::now();
    let (signal, fired) = oneshot::channel::<()>();
    let run = tokio::spawn(running.gateway.run_until(async move {
        let _ = fired.await;
    }));
    signal.send(()).unwrap();

    // Inside the window the call is untouched: it still reads and delivers.
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!run.is_finished());
    upstream.send(delta("still here")).await.unwrap();
    assert_eq!(
        next_frame(&mut body).await.unwrap().unwrap(),
        sse(&delta("still here"))
    );

    // The provider never finishes (`upstream` is kept alive). At the window
    // the gateway cuts the body: a failed body, not a clean end a client
    // could mistake for a complete answer.
    let cut = tokio::time::timeout(Duration::from_secs(5), next_frame(&mut body))
        .await
        .expect("the stream was not cut at the window");
    assert!(cut.is_err(), "expected a truncated body, got {cut:?}");
    assert!(
        started.elapsed() >= Duration::from_millis(900),
        "cut before the window: {:?}",
        started.elapsed()
    );

    let Stopped::Drained(report) = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .unwrap()
        .unwrap()
    else {
        panic!("expected a drain");
    };
    assert!(!report.completed_in_window);
    assert_eq!(report.aborted, 1);

    let records = settler.records();
    assert_eq!(records.len(), 1, "{records:?}");
    assert_eq!(records[0].upstream, UpstreamEnd::Drained);
    assert_eq!(records[0].delivery, Delivery::Cut);
    assert!(upstream.is_closed(), "the provider request was not dropped");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_drain_with_nothing_in_flight_finishes_at_once() {
    let settler = RecordingSettler::default();
    let (backend, _streams) = ControlledBackend::new();
    let config = config(&[("F2Z_AI_DRAIN_TIMEOUT_SECS", "300")]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    let Stopped::Drained(report) =
        tokio::time::timeout(Duration::from_secs(10), running.gateway.run_until(async {}))
            .await
            .unwrap()
    else {
        panic!("expected a drain");
    };
    assert!(report.completed_in_window);
    assert_eq!(report.in_flight_at_start, 0);
    assert!(settler.records().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_hangs_up_ends_delivery_only_and_the_upstream_is_read_to_its_usage() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    wait_readyz(running.admin, StatusCode::OK).await;

    let response = post_chat(running.public, &valid_chat("bye")).await;
    let upstream = streams.recv().await.unwrap();
    drop(response); // the client goes away

    // The upstream keeps being read: every event is taken promptly, long
    // after nobody is listening, and the usage frame arrives.
    tokio::time::sleep(Duration::from_millis(100)).await;
    for i in 0..200 {
        tokio::time::timeout(
            Duration::from_secs(2),
            upstream.send(delta(&format!("chunk {i}"))),
        )
        .await
        .expect("the upstream read stalled after the client left")
        .unwrap();
    }
    upstream.send(usage(200)).await.unwrap();
    // Still counted until settled.
    assert_eq!(metric(running.admin, "f2z_ai_active_streams ").await, "1");
    drop(upstream);

    let records = wait_records(&settler, 1).await;
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].delivery, Delivery::ClientGone);
    assert_eq!(records[0].usage.unwrap().output_tokens, 200);
    wait_metric(running.admin, "f2z_ai_active_streams ", "0").await;
}
