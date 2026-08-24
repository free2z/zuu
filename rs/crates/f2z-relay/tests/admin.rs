//! The loopback-only admin listener, and the two things it must not say.
//!
//! # `/healthz` must be constant and cheap
//!
//! It is polled every few seconds by a load balancer that keeps a log. So it
//! must not report queue depth or connection counts — that would put a
//! per-relay activity trace into a place nobody reviews for metadata — and it
//! must not touch storage, because a health check that queried the disk would
//! fail during exactly the backpressure it exists to survive, and would pull the
//! relay out of rotation at the moment `READ` and `ACK` are keeping it alive.
//!
//! # `/metrics` must carry no labels
//!
//! A `{queue="…"}` series is a per-conversation activity trace with timestamps
//! that outlives the ciphertext in the scraper's storage; a `{remote="…"}`
//! series is a connection log. Neither is something the protocol will disclose,
//! and neither may arrive through the side door.
//!
//! # And neither may leave the host
//!
//! Both are refused a non-loopback bind at startup rather than warned about.

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

use std::time::Duration;

use f2z_relay::config::Config;
use f2z_relay::server::Server;
use f2z_relay_proto::key::SigningKey;
use f2z_relay_testkit::client::{Client, ClientConfig};
use f2z_relay_testkit::websocket;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

async fn get(addr: std::net::SocketAddr, path: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("the admin listener accepts");
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
        .await
        .expect("the request is written");
    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;
    response
}

async fn relay_with_admin() -> Server {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.address = "127.0.0.1:0".to_owned();
    config.store.backend = "memory".to_owned();
    config.identity.seed = "9f".repeat(32);
    config.antiabuse.queue_creation_mode = "open".to_owned();
    config.antiabuse.per_source_limits = false;
    config.queues.expiry_tick_seconds = 3_600;
    Server::start(config).await.expect("the relay starts")
}

#[tokio::test(flavor = "multi_thread")]
async fn healthz_is_constant_and_reports_no_state() {
    let server = relay_with_admin().await;
    let admin = server.admin_addr().expect("the admin listener is bound");

    let first = get(admin, "/healthz").await;
    assert!(first.starts_with("HTTP/1.1 200 OK"));

    // Do something the relay could be tempted to report.
    let transport = websocket::connect(&server.url()).await.expect("connects");
    let mut alice = Client::connect(transport, ClientConfig::default())
        .await
        .expect("HELLO completes");
    let recv = SigningKey::from_seed(&[0xe1; 32]);
    let send = SigningKey::from_seed(&[0xe2; 32]);
    let queue = alice.create_queue(&recv, 0, 0, None).await.expect("create");
    alice.bind_send(&send, queue.send_addr).await.expect("bind");
    alice
        .append(&send, queue.send_addr, b"ciphertext")
        .await
        .expect("append");

    let second = get(admin, "/healthz").await;
    let body_of = |response: &str| {
        response
            .split("\r\n\r\n")
            .nth(1)
            .unwrap_or_default()
            .to_owned()
    };
    // Byte-identical across a queue, a connection and a message. That is the
    // property: `/healthz` is not an information channel.
    assert_eq!(body_of(&first), body_of(&second));
    assert_eq!(body_of(&second), "ok\n");
    assert!(
        !body_of(&second).chars().any(|c| c.is_ascii_digit()),
        "the health check reported a number"
    );
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn metrics_carry_totals_and_never_a_label() {
    let server = relay_with_admin().await;
    let admin = server.admin_addr().expect("the admin listener is bound");

    let transport = websocket::connect(&server.url()).await.expect("connects");
    let mut alice = Client::connect(transport, ClientConfig::default())
        .await
        .expect("HELLO completes");
    let recv = SigningKey::from_seed(&[0xf1; 32]);
    let send = SigningKey::from_seed(&[0xf2; 32]);
    let queue = alice.create_queue(&recv, 0, 0, None).await.expect("create");
    alice.bind_send(&send, queue.send_addr).await.expect("bind");
    alice
        .append(&send, queue.send_addr, b"ciphertext")
        .await
        .expect("append");

    let response = get(admin, "/metrics").await;
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(response.contains("text/plain; version=0.0.4"));
    let body = response.split("\r\n\r\n").nth(1).unwrap_or_default();

    // The counters moved, so this is a live endpoint rather than a stub.
    assert!(body.contains("f2z_relay_connections_accepted_total"));
    assert!(body.contains("f2z_relay_appends_committed_total 1"));
    assert!(body.contains("f2z_relay_commit_transactions_total"));

    // And not one series carries a label. A per-queue or per-IP series is the
    // metadata the protocol refuses, arriving through the operator's scraper.
    for line in body.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        assert!(!line.contains('{'), "a labelled series: {line}");
    }
    // Nor does the body contain either address in any rendering.
    let recv_hex: String = queue
        .recv_addr
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert!(!body.contains(&recv_hex));
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_admin_listener_answers_nothing_else() {
    let server = relay_with_admin().await;
    let admin = server.admin_addr().expect("the admin listener is bound");
    assert!(get(admin, "/").await.starts_with("HTTP/1.1 404"));
    // §11.2's document is deliberately not served here either: it belongs at a
    // public URL an operator publishes, and `--print-capabilities` emits it.
    assert!(
        get(admin, "/.well-known/free2z-relay/v1/capabilities")
            .await
            .starts_with("HTTP/1.1 404")
    );
    // A query string is ignored rather than parsed.
    assert!(
        get(admin, "/healthz?verbose=1")
            .await
            .starts_with("HTTP/1.1 200")
    );

    let mut stream = tokio::net::TcpStream::connect(admin)
        .await
        .expect("connects");
    stream
        .write_all(b"POST /metrics HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .expect("written");
    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;
    assert!(response.starts_with("HTTP/1.1 405"));
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_can_run_with_no_admin_listener_at_all() {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.enabled = false;
    config.store.backend = "memory".to_owned();
    config.identity.seed = "a7".repeat(32);
    let server = Server::start(config).await.expect("the relay starts");
    assert!(server.admin_addr().is_none());
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_loopback_admin_address_refuses_to_start() {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.address = "0.0.0.0:0".to_owned();
    config.store.backend = "memory".to_owned();
    config.identity.seed = "b8".repeat(32);
    // Refused by `check`, before a socket is opened, so `--check-config`
    // catches it too.
    assert!(config.check().is_err());
    assert!(Server::start(config).await.is_err());
}
