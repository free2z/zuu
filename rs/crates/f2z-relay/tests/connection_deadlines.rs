//! §2.4's keepalive and §2.5's handshake deadline, against a real socket.
//!
//! # Why this file exists
//!
//! `connection.rs` has a section headed "The two deadlines". Until this file
//! existed, **both could be deleted outright and `cargo test -p f2z-relay -p
//! f2z-relay-testkit` stayed green** (issue #678): replacing
//! `if missed_pongs > missed_pongs_before_close` with `if false`, or
//! `if waiting_for_hello` with `if false`, changed no verdict anywhere. Nothing
//! in either crate named a Pong, a missed pong, or the handshake timeout.
//!
//! That is not a hygiene problem. §13.1 layer 1 caps concurrent connections per
//! source and relay-wide, and a connection permit is the only structure an
//! unauthenticated caller can make the relay allocate. These two deadlines are
//! the only mechanisms that **release** one. A cap that is measured and tested,
//! guarding a release path that is neither, is a cap with a hole in it.
//!
//! # Why the `PING` command is not this
//!
//! `f2z-relay-testkit`'s vector suite mentions `Ping` six times, and every one
//! of them is §6.1's application-level `PING` **command** — a request frame with
//! a response frame, which is what [`Client::ping`] sends. §2.4's keepalive is a
//! WebSocket **control frame**, which a browser client cannot send at all, which
//! is why the relay drives it. A grep for "ping" makes the keepalive look
//! covered; it was not.
//!
//! # Why real sockets and real seconds
//!
//! `tokio::time::pause`/`advance` needs a `current_thread` runtime and a clock
//! nothing else is waiting on. These tests drive a production [`Server`] — its
//! own listener, commit thread and expiry tick — over loopback TCP, so a paused
//! clock would stop the relay it is meant to observe. `ping_interval_seconds` is
//! a `u16` of **seconds** with a floor of 1, so the shortest honest keepalive
//! test is a few real seconds; `handshake_timeout_ms` is milliseconds and costs
//! far less.
//!
//! # What a "client that does not answer" has to be
//!
//! `tokio-tungstenite` answers a Ping with a Pong from inside its own read path
//! (`WebSocket::read` flushes `additional_send` before it parses), so a client
//! that *reads* is a client that *pongs*, whatever the layer above it does. The
//! only faithful unresponsive client is one that does not read, which is why
//! [`an_unanswered_ping_closes_the_connection_going_away`] speaks `HELLO`
//! through the raw transport rather than through [`Client`], sleeps past the
//! deadline, and only then drains what the relay left on the wire.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it through `lib.rs`'s `cfg_attr(test, ...)`.
// They are relaxed here for the reason `rs/README.md` gives: a test that has to
// thread a `Result` through every assertion is a test nobody reads, and a panic
// in a test is a failing test rather than a remote denial of service.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::time::{Duration, Instant};

use f2z_codec::PROTOCOL_VERSION;
use f2z_codec::canonical::Canonical;
use f2z_codec::commands::HelloRequest;
use f2z_codec::types::Challenge;
use f2z_relay::config::Config;
use f2z_relay::server::Server;
use f2z_relay::transport::{CLOSE_GOING_AWAY, CLOSE_NORMAL};
use f2z_relay_proto::command::{ops, unsigned_request};
use f2z_relay_testkit::client::{Client, ClientConfig};
use f2z_relay_testkit::transport::{TransportSink, TransportStream, WireMessage};
use f2z_relay_testkit::websocket;

/// A relay on the conformance configuration, with one edit.
///
/// The same shape `configured_equivalents.rs` uses, and for the same reason: a
/// deadline is published policy, so reaching it needs configuration rather than
/// a fault handle compiled into the relay.
async fn relay(edit: impl FnOnce(&mut Config)) -> Server {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.enabled = false;
    config.store.backend = "memory".to_owned();
    config.identity.seed = "3c".repeat(32);
    config.antiabuse.queue_creation_mode = "open".to_owned();
    config.antiabuse.contact_append_pow_bits = 8;
    config.antiabuse.per_source_limits = false;
    config.commit.window_ms = 1;
    config.queues.expiry_tick_seconds = 3_600;
    edit(&mut config);
    Server::start(config).await.expect("the relay starts")
}

/// A client on a fresh connection, with a nonce stream no other client shares.
async fn client(server: &Server, stream: u8) -> Client {
    let transport = websocket::connect(&server.url())
        .await
        .expect("the relay accepts a connection");
    let config = ClientConfig {
        // Its own nonce stream: §5.5's seen-set is relay-wide.
        nonce_seed: [stream; 32],
        ..ClientConfig::default()
    };
    Client::connect(transport, config)
        .await
        .expect("HELLO completes")
}

/// A connection that has completed §2.5's `HELLO` but is **not** a [`Client`].
///
/// The halves come back raw, so the caller decides when — or whether — to read.
/// A [`Client`] cannot be unresponsive: every one of its paths reads, and both
/// it and `tungstenite` beneath it answer a Ping with a Pong.
async fn hello_only(
    server: &Server,
    nonce: u8,
) -> (Box<dyn TransportSink>, Box<dyn TransportStream>) {
    let transport = websocket::connect(&server.url())
        .await
        .expect("the relay accepts a connection");
    let (mut sink, mut stream) = transport.split();
    let offer = HelloRequest {
        min_version: PROTOCOL_VERSION,
        max_version: PROTOCOL_VERSION,
        client_nonce: Challenge::new([nonce; 32]),
    };
    let frame = unsigned_request::<ops::Hello>(1, &offer).expect("HELLO encodes");
    sink.send(WireMessage::Binary(
        frame.encode_canonical().expect("the frame is canonical"),
    ))
    .await
    .expect("the relay takes the HELLO");
    // The response is not verified here — `Client::connect` is what proves
    // §5.2, and this connection exists to be silent, not to be a client. It is
    // read so that the wire is empty of everything but what §2.4 puts there.
    match tokio::time::timeout(Duration::from_secs(5), stream.recv()).await {
        Ok(Ok(Some(WireMessage::Binary(_)))) => {}
        other => panic!("expected a HELLO response, got {other:?}"),
    }
    (sink, stream)
}

/// What the relay left on the wire, and when it stopped.
#[derive(Debug)]
struct Drained {
    /// §2.4 Ping control frames seen.
    pings: usize,
    /// The RFC 6455 status the relay closed with, if it closed.
    close: Option<u16>,
    /// How long the drain took to reach that verdict.
    elapsed: Duration,
}

/// Read control frames until the relay closes, or `within` elapses.
///
/// A relay that never closes is the failure this file exists to catch, so the
/// bound is on the whole drain rather than on each read: pings arriving forever
/// must not keep the loop alive forever.
async fn drain_until_close(stream: &mut Box<dyn TransportStream>, within: Duration) -> Drained {
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + within;
    let mut pings = 0usize;
    loop {
        let received = match tokio::time::timeout_at(deadline, stream.recv()).await {
            Err(_) => {
                return Drained {
                    pings,
                    close: None,
                    elapsed: started.elapsed(),
                };
            }
            Ok(received) => received,
        };
        match received {
            Ok(Some(WireMessage::Ping(_))) => pings += 1,
            Ok(Some(WireMessage::Close(code))) => {
                return Drained {
                    pings,
                    close: Some(code),
                    elapsed: started.elapsed(),
                };
            }
            // An end of stream without a close frame is still a closed
            // connection, and reported as one so the assertion can say which it
            // was. `Ok(None)` is the peer going away; `Err` is the socket.
            Ok(None) | Err(_) => {
                return Drained {
                    pings,
                    close: None,
                    elapsed: started.elapsed(),
                };
            }
            Ok(Some(_)) => {}
        }
    }
}

/// Wait for §13.1 layer 1's relay-wide counter to reach `want`.
///
/// The permit is dropped by the listener *after* `connection::drive` returns,
/// which is after the close frame is on the wire, so the client can observe the
/// close a moment before the counter moves.
async fn settled_connections(server: &Server, want: u64) -> u64 {
    for _ in 0..200u32 {
        let open = server.relay().abuse().open_connections();
        if open == want {
            return open;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    server.relay().abuse().open_connections()
}

// ---------------------------------------------------------------------------
// §2.4 — the keepalive.
// ---------------------------------------------------------------------------

/// **The positive control.** Without it, the two closing tests below would pass
/// against a relay that closed every connection the moment it opened.
///
/// A client that answers §2.4's Pings survives several ping intervals and is
/// still able to command the relay afterwards.
#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_answers_pongs_is_never_closed_by_the_keepalive() {
    let server = relay(|config| {
        config.listen.ping_interval_seconds = 1;
        config.listen.missed_pongs_before_close = 1;
    })
    .await;
    let mut alice = client(&server, 0x60).await;

    // Four ping intervals. Every `PING` command is a round trip, and a round
    // trip reads, and a read answers the pending keepalive Ping — which is
    // exactly what a real client does and the reason `missed_pongs` resets.
    let until = Instant::now() + Duration::from_millis(4_200);
    while Instant::now() < until {
        alice
            .ping()
            .await
            .expect("the relay answers a PING command");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    assert!(
        !alice.is_closed(),
        "a responsive client was closed by the keepalive"
    );
    alice
        .ping()
        .await
        .expect("a responsive client is still connected after four ping intervals");
    assert_eq!(
        server.relay().abuse().open_connections(),
        1,
        "the connection permit was released while the client was still using it"
    );
    server.shutdown().await;
}

/// A client that never answers is closed after `missed_pongs_before_close`
/// intervals, with the status production means to send — and its §13.1 layer 1
/// permit goes back.
#[tokio::test(flavor = "multi_thread")]
async fn an_unanswered_ping_closes_the_connection_going_away() {
    let server = relay(|config| {
        config.listen.ping_interval_seconds = 1;
        config.listen.missed_pongs_before_close = 1;
    })
    .await;
    let (_sink, mut stream) = hello_only(&server, 0x61).await;

    // One interval sends the Ping; the next finds it unanswered and closes. The
    // sleep is what makes the client unresponsive: reading would pong.
    tokio::time::sleep(Duration::from_millis(2_600)).await;

    let drained = drain_until_close(&mut stream, Duration::from_secs(4)).await;
    assert_eq!(
        drained.close,
        Some(CLOSE_GOING_AWAY),
        "an unanswered Ping did not close the connection with 1001: {drained:?}"
    );
    assert_eq!(
        drained.pings, 1,
        "the relay closed without first sending §2.4's Ping: {drained:?}"
    );
    assert_eq!(
        settled_connections(&server, 0).await,
        0,
        "the connection permit outlived the connection (§13.1 layer 1)"
    );
    server.shutdown().await;
}

// ---------------------------------------------------------------------------
// §2.5 — the handshake deadline.
// ---------------------------------------------------------------------------

/// A connection that completes the WebSocket upgrade and then says nothing is
/// closed at `handshake_timeout_ms`, and its permit is released.
///
/// This is the case that needs no credentials at all: the upgrade is free, and
/// before this test the relay held the permit until the process restarted.
#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_never_says_hello_is_closed_at_the_deadline() {
    let server = relay(|config| config.listen.handshake_timeout_ms = 700).await;
    let transport = websocket::connect(&server.url())
        .await
        .expect("the relay accepts a connection");
    // The sink is held, not dropped: a client that hung up would be a different
    // test, and would close the connection for a reason that is not the
    // deadline.
    let (_sink, mut stream) = transport.split();

    let drained = drain_until_close(&mut stream, Duration::from_secs(6)).await;
    assert_eq!(
        drained.close,
        Some(CLOSE_NORMAL),
        "a silent connection was not closed at §2.5's deadline: {drained:?}"
    );
    assert!(
        drained.elapsed >= Duration::from_millis(350),
        "the connection was closed far too early to be the deadline: {drained:?}"
    );
    assert_eq!(
        settled_connections(&server, 0).await,
        0,
        "an unauthenticated silent connection kept its permit (§13.1 layer 1)"
    );
    server.shutdown().await;
}

/// The other half of §2.5: the cap is on the time **to** `HELLO`, not a read
/// deadline on the session. A subscribed client on a quiet queue legitimately
/// sends nothing for hours.
#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_says_hello_in_time_outlives_the_deadline() {
    let server = relay(|config| config.listen.handshake_timeout_ms = 700).await;
    let mut alice = client(&server, 0x62).await;

    // Three times the deadline, silent. The default 25 s keepalive cannot reach
    // in here, so the only thing that could close this connection is §2.5 being
    // applied where it must not be.
    tokio::time::sleep(Duration::from_millis(2_100)).await;

    alice
        .ping()
        .await
        .expect("a connection that said HELLO in time is not subject to the deadline");
    assert_eq!(
        server.relay().abuse().open_connections(),
        1,
        "the connection was released while it was still open"
    );
    server.shutdown().await;
}
