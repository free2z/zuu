//! The keepalive must not be a fault nobody armed.
//!
//! §2.4 is a liveness check on the *client*, and a WebSocket client only
//! answers a Ping while something polls its socket. Every client of this crate
//! is single-owner and `&mut`-driven — the messaging engine's `RelayConnection`
//! says so in its own doc comment — so a connection parked between two calls is
//! not polled at all, and its whole liveness budget is the wall-clock time its
//! owner spends elsewhere.
//!
//! That made [`RelayConfig::ping_interval`]'s old 500 ms default, with two
//! permitted missed Pongs, a **1.5-second deadline on every test in the
//! repository**: open a SQLite store, commit to it, and a loaded runner has
//! already lost the connection. Issue #952 is exactly that, seen from the far
//! end — a one-shot BIND_SEND fault the relay never received, never retired,
//! and a test that waited out its whole hang detector to report `Elapsed(())`.
//!
//! So this file asserts the negative: an idle connection is still there
//! afterwards. Two seconds is chosen to clear the old 1.5-second budget and
//! nothing more; it fails against the previous default and passes against a
//! keepalive that matches the relay this crate is a fake of.
//!
//! [`RelayConfig::ping_interval`]: f2z_relay_testkit::config::RelayConfig::ping_interval

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
use std::time::Duration;

use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::config::RelayConfig;
use f2z_relay_testkit::fake::FakeRelay;

/// Longer than the 1.5 s the old default allowed, short enough to stay a unit
/// test. Raising it does not make the guard stronger; the point is that the
/// budget is no longer measured in hundreds of milliseconds.
const IDLE: Duration = Duration::from_secs(2);

/// The default keepalive is the shipping relay's, not a harsher one.
///
/// `f2z-relay`'s `listen.ping_interval_seconds` default is 25, and the
/// `f2z-fakerelay` binary already used 25 000 ms. The in-process default was
/// the odd one out, and nothing about being in-process justifies a client
/// contract 50× tighter than the relay being faked.
#[test]
fn the_default_keepalive_matches_the_relay_this_crate_fakes() {
    assert_eq!(
        RelayConfig::default().ping_interval,
        Duration::from_secs(25),
        "the fake's keepalive must not be stricter than f2z-relay's"
    );
}

/// A connection its owner leaves parked survives and is still usable.
///
/// The client is not polled during the sleep, so it sends no Pong; that is what
/// a real single-owner client does between two calls, and it is not evidence of
/// a dead peer.
#[tokio::test(flavor = "multi_thread")]
async fn an_idle_connection_is_not_closed_by_the_keepalive() {
    let relay = FakeRelay::with_defaults().expect("configurable");
    let mut client = relay.client().await.expect("connects");
    let key = SigningKey::from_seed(&[0x5a; 32]);
    let created = client
        .create_queue(&key, 0, 0, None)
        .await
        .expect("CREATE_QUEUE before the idle window");

    tokio::time::sleep(IDLE).await;

    client
        .read(&key, created.recv_addr, 0, 16, 4_096)
        .await
        .expect("an idle connection was closed by the keepalive");
}

/// The same, with the keepalive a test *about* §2.4 would ask for.
///
/// A short interval is still available and still closes a silent client — the
/// fix moved the cost onto the tests that want it, it did not remove the
/// behaviour.
#[tokio::test(flavor = "multi_thread")]
async fn a_test_that_wants_a_short_keepalive_still_gets_one() {
    let relay = FakeRelay::new(RelayConfig {
        ping_interval: Duration::from_millis(100),
        missed_pongs_before_close: 1,
        ..RelayConfig::default()
    })
    .expect("configurable");
    let mut client = relay.client().await.expect("connects");
    let key = SigningKey::from_seed(&[0x5b; 32]);
    let created = client
        .create_queue(&key, 0, 0, None)
        .await
        .expect("CREATE_QUEUE before the idle window");

    tokio::time::sleep(Duration::from_millis(600)).await;

    assert!(
        client
            .read(&key, created.recv_addr, 0, 16, 4_096)
            .await
            .is_err(),
        "an explicit short keepalive must still close a silent client"
    );
}
