//! Alignment checks for the testkit server's graceful-shutdown path.
//!
//! `WIRE.md` does not prescribe a WebSocket close status for server shutdown,
//! so this is deliberately a crate-level comparison with `f2z-relay`, not a
//! conformance vector.

// An integration test is its own crate, so the workspace's panic/unwrap/expect
// denials for the unauthenticated relay path are lifted only here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use std::time::Duration;

use f2z_relay_testkit::fake::FakeRelay;
use f2z_relay_testkit::outbound::CLOSE_GOING_AWAY;
use f2z_relay_testkit::transport::WireMessage;
use f2z_relay_testkit::websocket;

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_closes_only_the_target_servers_established_connections() {
    let stopping_relay = FakeRelay::with_defaults().expect("configurable stopping relay");
    let stopping_server = stopping_relay
        .listen_loopback()
        .await
        .expect("stopping server binds");
    let stopping_transport = websocket::connect(&stopping_server.url())
        .await
        .expect("stopping server accepts a WebSocket");
    let (_stopping_sink, mut stopping_stream) = stopping_transport.split();

    let live_relay = FakeRelay::with_defaults().expect("configurable live relay");
    let live_server = live_relay
        .listen_loopback()
        .await
        .expect("live server binds");
    let live_transport = websocket::connect(&live_server.url())
        .await
        .expect("live server accepts a WebSocket");
    let (_live_sink, mut live_stream) = live_transport.split();

    stopping_server.shutdown().await;

    let close = tokio::time::timeout(Duration::from_secs(1), stopping_stream.recv())
        .await
        .expect("shutdown produces a frame before the socket disappears")
        .expect("reading the shutdown close succeeds")
        .expect("shutdown produces a close frame");
    assert_eq!(close, WireMessage::Close(CLOSE_GOING_AWAY));

    assert!(
        tokio::time::timeout(Duration::from_millis(100), live_stream.recv())
            .await
            .is_err(),
        "a connection to an independently running server must not receive a close frame"
    );

    live_server.shutdown().await;
}
