//! The conformance suite, run twice, and the two runs compared.
//!
//! Running it in-process proves the rules. Running it over a real
//! `ws://127.0.0.1:0` listener proves that the in-process path is not lying:
//! the framing, the ordering, the close codes and the keepalive all exist on
//! only one of the two, and a divergence would mean the fast transport is a
//! second implementation wearing the first one's tests.
//!
//! The third assertion is the one that will matter later. `f2z-relay` will be a
//! `WebSocketEndpoint` with a URL and no fault handle, and this same file will
//! run against it unchanged — the fault-driven vectors reporting *skipped*
//! rather than passing, which is the honest verdict for a relay nobody can tell
//! to misbehave.

// An integration test is its own crate, so the workspace's `panic`/`unwrap`/
// `expect` denials — written for a relay's unauthenticated request path — apply
// here too. A test that cannot assert is not a test, so they are lifted for
// this file and nowhere else.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]
use std::sync::Arc;

use f2z_relay_testkit::config::RelayConfig;
use f2z_relay_testkit::fake::{Endpoint, FakeRelay, WebSocketEndpoint};
use f2z_relay_testkit::vectors::{self, Needs, Status};

#[tokio::test(flavor = "multi_thread")]
async fn the_suite_passes_in_process() {
    let relay = FakeRelay::with_defaults().expect("a default relay is configurable");
    let endpoint: Arc<dyn Endpoint> = Arc::new(relay.in_process_endpoint());
    let report = vectors::run(endpoint).await;

    println!("{}", report.summary());
    assert_eq!(report.failed(), 0, "{:#?}", report.failures());
    assert_eq!(
        report.skipped(),
        0,
        "the in-process endpoint has both a fault handle and a clock, \
         so nothing should be skipped"
    );
    assert!(report.passed() >= 40, "the suite should be substantial");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_suite_passes_over_a_real_socket() {
    // A wall-clock relay would make the clock vectors untestable, so the socket
    // relay is frozen like the in-process one. The socket is what differs; the
    // relay must not.
    let relay = FakeRelay::new(RelayConfig::default()).expect("a default relay is configurable");
    let server = relay
        .listen_loopback()
        .await
        .expect("binding 127.0.0.1:0 succeeds");
    let endpoint: Arc<dyn Endpoint> = Arc::new(relay.websocket_endpoint(&server));

    let report = vectors::run(endpoint).await;
    println!("{}", report.summary());
    assert_eq!(report.failed(), 0, "{:#?}", report.failures());
    assert_eq!(report.skipped(), 0);

    server.shutdown().await;
}

/// The check that makes "both transports run the same implementation" a fact.
#[tokio::test(flavor = "multi_thread")]
async fn both_transports_reach_the_same_verdicts() {
    let in_process_relay = FakeRelay::with_defaults().expect("configurable");
    let in_process: Arc<dyn Endpoint> = Arc::new(in_process_relay.in_process_endpoint());
    let in_process_report = vectors::run(in_process).await;

    let socket_relay = FakeRelay::with_defaults().expect("configurable");
    let server = socket_relay.listen_loopback().await.expect("binds");
    let socket: Arc<dyn Endpoint> = Arc::new(socket_relay.websocket_endpoint(&server));
    let socket_report = vectors::run(socket).await;

    assert_eq!(
        in_process_report.verdicts(),
        socket_report.verdicts(),
        "the in-process transport and the WebSocket transport disagreed; \
         one of them is not running the relay the other is"
    );
    server.shutdown().await;
}

/// A target with no fault handle — the shape `f2z-relay` will arrive in.
#[tokio::test(flavor = "multi_thread")]
async fn a_target_without_a_fault_handle_skips_rather_than_passes() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let server = relay.listen_loopback().await.expect("binds");

    // Constructed the way a third-party relay would be: a URL, and nothing
    // else. Same suite, same file, no fault handle, no clock.
    let endpoint: Arc<dyn Endpoint> =
        Arc::new(WebSocketEndpoint::new(server.url()).with_client_config(relay.client_config()));
    let report = vectors::run(endpoint).await;
    println!("{}", report.summary());

    let expected_skips = vectors::suite()
        .iter()
        .filter(|vector| !matches!(vector.needs, Needs::Nothing))
        .count();
    assert_eq!(
        report.skipped(),
        expected_skips,
        "every fault- or clock-driven vector must report Skipped, never Passed"
    );
    assert_eq!(report.failed(), 0, "{:#?}", report.failures());
    assert!(
        report
            .outcomes
            .iter()
            .any(|outcome| matches!(outcome.status, Status::Skipped(_))),
        "at least one vector must be skipped for this test to mean anything"
    );

    server.shutdown().await;
}

/// The suite is stable in composition, so a vector cannot silently disappear.
#[test]
fn every_vector_declares_a_section_and_a_unique_name() {
    let suite = vectors::suite();
    let mut names: Vec<&str> = suite.iter().map(|vector| vector.name).collect();
    names.sort_unstable();
    let before = names.len();
    names.dedup();
    assert_eq!(before, names.len(), "vector names must be unique");
    for vector in &suite {
        assert!(
            vector.section.starts_with('§'),
            "{} does not name the WIRE.md section it pins",
            vector.name
        );
    }
}
