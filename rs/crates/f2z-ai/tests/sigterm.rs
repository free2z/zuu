//! The drain, triggered by a real `SIGTERM` delivered to this process — the
//! signal Kubernetes sends — through the same `shutdown::terminate_signal`
//! the binary uses.
//!
//! One test per file on purpose: once the handler is installed, `SIGTERM` no
//! longer kills this test process, and no other test should share that.

#![cfg(unix)]
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

use axum::http::StatusCode;
use f2z_ai::settle::UpstreamEnd;
use f2z_ai::{Stopped, shutdown};
use support::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_drains_without_cutting_an_open_stream() {
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let config = config(&[("F2Z_AI_DRAIN_TIMEOUT_SECS", "30")]);
    let running = start(&config, deps(fixed_catalog(), backend, settler.clone())).await;
    let (public, admin) = (running.public, running.admin);
    wait_readyz(admin, StatusCode::OK).await;

    let mut body = post_chat(public, &valid_chat("hi")).await.into_body();
    let stream = streams.recv().await.unwrap();
    stream.send(delta("a")).await.unwrap();
    assert!(next_frame(&mut body).await.unwrap().is_some());

    let signal = shutdown::terminate_signal().unwrap();
    let run = tokio::spawn(running.gateway.run_until(signal));
    let status = std::process::Command::new("kill")
        .args(["-TERM", &std::process::id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());

    wait_readyz(admin, StatusCode::SERVICE_UNAVAILABLE).await;
    let refused = post_chat(public, &valid_chat("new")).await;
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_of(refused).await["details"]["reason"], "draining");

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!run.is_finished());
    stream.send(usage(3)).await.unwrap();
    assert!(next_frame(&mut body).await.unwrap().is_some());
    drop(stream);
    assert_eq!(next_frame(&mut body).await.unwrap(), None);

    let stopped = tokio::time::timeout(Duration::from_secs(10), run)
        .await
        .unwrap()
        .unwrap();
    let Stopped::Drained(report) = stopped else {
        panic!("{stopped:?}");
    };
    assert!(report.completed_in_window);
    let records = settler.records();
    assert_eq!(records[0].upstream, UpstreamEnd::Finished);
    assert_eq!(records[0].usage.unwrap().output_tokens, 3);
}
