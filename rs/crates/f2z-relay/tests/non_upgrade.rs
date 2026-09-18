//! The public listener answers. It does not drop the connection.
//!
//! # The regression this exists for
//!
//! `relay.free2z.cash` returned **502 to 100% of non-WebSocket requests for 22
//! hours** — ~5,700 a day — and paged production's site-wide load-balancer 5xx
//! alert while free2z.cash itself was entirely healthy (free2z/zuu#1037,
//! free2z/tuzi#1937). Nothing was wrong with the relay: `/healthz` on the
//! health listener answered `200`, and a real handshake returned `101` both
//! against the pod and through the load balancer.
//!
//! What was wrong was the *absence* of a reply. A request that is not a
//! WebSocket upgrade failed inside `accept_hdr_async`, which errors without
//! writing anything, so the socket simply closed — `curl` exit 52, empty reply.
//! Google's load balancer renders that as a 502, which is both a page and a
//! lie: it says the backend broke when the caller had merely not spoken the
//! protocol.
//!
//! So the assertion that matters below is not "the status is 426". It is **a
//! parseable HTTP response arrived at all**, with the status as the second
//! half. A test that only checked the status would still pass against a
//! listener that answered `426` to one shape of request and closed the socket
//! on the next.
//!
//! The rest of the file is the controls, which are the reason to believe the
//! first test: a real handshake still reaches `101` with the subprotocol echoed
//! (§2.1), and a peer that *did* ask to upgrade and got §2.1 wrong still gets
//! `reject`'s `400` rather than being swallowed by the new path. The two
//! statuses answer two different mistakes and both have to keep working.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it through `lib.rs`. Relaxed here for the
// reason `rs/README.md` gives.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::net::SocketAddr;
use std::time::Duration;

use f2z_relay::config::Config;
use f2z_relay::server::Server;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

fn base() -> Config {
    let mut config = Config::default();
    config.listen.address = "127.0.0.1:0".to_owned();
    config.admin.address = "127.0.0.1:0".to_owned();
    config.store.backend = "memory".to_owned();
    config.identity.seed = "3c".repeat(32);
    // Several connections arrive from 127.0.0.1 in quick succession here, which
    // is what §13.1's per-source limit exists to refuse.
    config.antiabuse.per_source_limits = false;
    config.queues.expiry_tick_seconds = 3_600;
    config
}

/// A handshake as a real client sends one: RFC 6455's own sample key, plus the
/// path and the subprotocol §2.1 makes mandatory.
fn handshake_for(addr: SocketAddr, path: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {addr}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Protocol: free2z-relay.v1\r\n\
         \r\n"
    )
}

/// Send `request` and read until the relay closes the connection.
///
/// Used for the cases where the relay is expected to answer and hang up. The
/// timeout is a bound on the test, not a tolerance: if it fires, nothing was
/// written and the connection was never closed either, which is its own bug.
async fn exchange_until_close(addr: SocketAddr, request: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("the protocol listener accepts");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is written");
    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;
    response
}

/// Send `request` and read only as far as the end of the response head.
///
/// A successful upgrade leaves the connection OPEN — §2.5's handshake deadline
/// is ten seconds — so reading to EOF would turn the success path into a
/// ten-second test that proves the same thing.
async fn exchange_head(addr: SocketAddr, request: &str) -> String {
    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("the protocol listener accepts");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is written");

    let mut response = Vec::new();
    let mut chunk = [0u8; 512];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(read)) => {
                response.extend_from_slice(&chunk[..read]);
                if response.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
        }
    }
    String::from_utf8_lossy(&response).into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plain_get_on_the_protocol_port_is_answered_rather_than_dropped() {
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let response = exchange_until_close(
        protocol,
        "GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n",
    )
    .await;

    // THE REGRESSION, stated the way it was measured in production: an empty
    // reply. This assertion is the one that was false for 22 hours, and it is
    // deliberately checked before anything about the status, because "no bytes
    // at all" and "the wrong status" are different bugs with different fixes.
    assert!(
        !response.is_empty(),
        "the listener closed the connection without writing a response — this \
         is the #1037 defect: a load balancer in front renders it as a 502"
    );
    assert!(
        response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
        "{response}"
    );

    let (head, body) = response
        .split_once("\r\n\r\n")
        .expect("a parseable head and body");
    // RFC 9110 §15.5.22 makes `Upgrade` required on a 426.
    assert!(
        head.lines()
            .any(|line| line.eq_ignore_ascii_case("upgrade: websocket")),
        "{head}"
    );
    let declared: usize = head
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .expect("the response declares its length")
        .parse()
        .expect("the declared length is a number");
    assert_eq!(declared, body.len(), "Content-Length disagrees with the body");
    assert_eq!(body, "upgrade required\n");

    // The `/healthz` discipline: the answer is the same for everyone and says
    // nothing. Nothing of the request comes back, and no number does either.
    assert!(
        !response.contains("relay.free2z.cash"),
        "the refusal echoed the request: {response}"
    );
    assert!(
        !body.chars().any(|character| character.is_ascii_digit()),
        "the refusal reported a number: {body:?}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn every_shape_of_scanner_traffic_is_answered_the_same_way() {
    // One shape answered and the next one dropped would still be a 502 in
    // production, just a rarer one, so the constant is asserted to be constant
    // across the requests that actually arrive at a public hostname.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let mut answers = Vec::new();
    for request in [
        "GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n",
        "GET /.env HTTP/1.1\r\nHost: x\r\n\r\n",
        "GET /relay/v1 HTTP/1.1\r\nHost: x\r\n\r\n",
        "HEAD / HTTP/1.1\r\nHost: x\r\n\r\n",
        "POST /wp-login.php HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n",
        // HTTP/1.0 with no Host at all, which is most of what a scanner sends.
        "GET / HTTP/1.0\r\n\r\n",
    ] {
        let response = exchange_until_close(protocol, request).await;
        assert!(
            response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
            "{request:?} got {response:?}"
        );
        answers.push(response);
    }

    // `/relay/v1` without an upgrade is in that list on purpose: the right path
    // is not an upgrade request, and it must not be treated as one.
    assert!(
        answers.windows(2).all(|pair| pair[0] == pair[1]),
        "the refusal varied between requests: {answers:?}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_real_handshake_still_reaches_101_with_the_subprotocol_echoed() {
    // The control for the test above. A 426 written over a handshake would
    // break every client that can use this relay, so the success path is
    // asserted on the same listener, through the same new code, byte for byte
    // as a client drives it.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let response = exchange_head(protocol, &handshake_for(protocol, "/relay/v1")).await;

    assert!(
        response.starts_with("HTTP/1.1 101 "),
        "the upgrade was refused: {response:?}"
    );
    // §2.1: a relay that does not echo the subprotocol is one the client must
    // refuse, so `101` alone is not the property.
    assert!(
        response
            .lines()
            .any(|line| line.eq_ignore_ascii_case("sec-websocket-protocol: free2z-relay.v1")),
        "{response}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_peer_that_asked_to_upgrade_and_got_it_wrong_still_gets_400() {
    // The two statuses answer two different mistakes and the new path must not
    // swallow the older one. 400 says "your handshake is wrong" and is only
    // honest to a peer that actually sent one; 426 says "this port only speaks
    // WebSocket" and is only honest to a peer that did not.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    // §2.1's path, got wrong — but the peer did ask to upgrade.
    let wrong_path = exchange_until_close(protocol, &handshake_for(protocol, "/nope")).await;
    assert!(
        wrong_path.starts_with("HTTP/1.1 400 "),
        "a malformed handshake should keep its 400: {wrong_path:?}"
    );

    // §2.1's mandatory subprotocol, omitted.
    let no_subprotocol = handshake_for(protocol, "/relay/v1")
        .replace("Sec-WebSocket-Protocol: free2z-relay.v1\r\n", "");
    let response = exchange_until_close(protocol, &no_subprotocol).await;
    assert!(
        response.starts_with("HTTP/1.1 400 "),
        "a handshake without the subprotocol should keep its 400: {response:?}"
    );

    server.shutdown().await;
}
