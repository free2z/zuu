//! The public listener answers. It does not drop the connection.
//!
//! # The regression this exists for
//!
//! `relay.free2z.cash` returned **502 to 100% of non-WebSocket requests for 22
//! hours** — ~5,700 a day — and paged production's site-wide load-balancer 5xx
//! alert while free2z.cash itself was entirely healthy (free2z/zuu#1037, and
//! the incident write-up in the tuzi repo). Nothing was wrong with the relay:
//! `/healthz` on the
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
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use f2z_relay::config::Config;
use f2z_relay::server::Server;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

const TEST_CERT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/localhost-cert.pem"
);
const TEST_KEY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/localhost-key.pem"
);

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

fn tls_base() -> Config {
    let mut config = base();
    config.listen.tls_cert = TEST_CERT.to_owned();
    config.listen.tls_key = TEST_KEY.to_owned();
    config.antiabuse.per_source_limits = true;
    config.limits.max_connections_per_source = 1;
    config
}

fn tls_connector() -> tokio_rustls::TlsConnector {
    use tokio_rustls::rustls::RootCertStore;
    use tokio_rustls::rustls::pki_types::CertificateDer;
    use tokio_rustls::rustls::pki_types::pem::PemObject as _;

    let cert = CertificateDer::pem_file_iter(Path::new(TEST_CERT))
        .expect("the test certificate is readable")
        .next()
        .expect("the test certificate contains one certificate")
        .expect("the test certificate is valid PEM");
    let mut roots = RootCertStore::empty();
    roots.add(cert).expect("the test cert is trusted as a root");
    let client = tokio_rustls::rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_rustls::TlsConnector::from(Arc::new(client))
}

async fn connect_tls(addr: SocketAddr) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
    use tokio_rustls::rustls::pki_types::ServerName;

    let stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("the TLS protocol listener accepts");
    tls_connector()
        .connect(
            ServerName::try_from("localhost".to_owned()).expect("localhost is a valid name"),
            stream,
        )
        .await
        .expect("TLS 1.3 handshake succeeds with the trusted local fixture")
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
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response))
        .await
        .expect("the listener closes the response within five seconds")
        .expect("the listener closes cleanly after its response");
    response
}

/// Read a response after half-closing the request side, requiring both a
/// bounded completion and clean EOF. Sending a body before the half-close also
/// checks the listener's bounded drain of unread client bytes.
async fn checked_http_exchange_until_eof<S>(stream: &mut S, request: &str) -> Vec<u8>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    stream
        .write_all(request.as_bytes())
        .await
        .expect("the request is written");
    stream
        .shutdown()
        .await
        .expect("the request side is half-closed");
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .expect("the response reaches EOF within five seconds")
        .expect("the response reaches clean EOF rather than resetting");
    response
}

async fn closes_within<S>(stream: &mut S, bound: Duration) -> bool
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut byte = [0u8; 1];
    matches!(
        tokio::time::timeout(bound, stream.read(&mut byte)).await,
        Ok(Ok(0) | Err(_))
    )
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

    response_head(&mut stream).await
}

async fn response_head<S>(stream: &mut S) -> String
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut response = Vec::new();
    let mut chunk = [0u8; 512];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Err(error)) => panic!("reading response head failed: {error}"),
            Err(_) => panic!("response head did not arrive within five seconds"),
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
    assert_eq!(
        declared,
        body.len(),
        "Content-Length disagrees with the body"
    );
    // RFC 9112 §6.3 forbids a body on a response to HEAD, and this listener
    // does not parse the method, so the answer has no body at all.
    assert_eq!(body, "", "the refusal grew a body");

    // The `/healthz` discipline: the answer is the same for everyone and says
    // nothing. Nothing of the request comes back.
    assert!(
        !response.contains("relay.free2z.cash"),
        "the refusal echoed the request: {response}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn per_source_rate_limit_returns_a_constant_http_429() {
    let mut config = base();
    config.antiabuse.per_source_limits = true;
    config.limits.new_connections_per_source_per_second = 0;
    let server = Server::start(config).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    // A zero new-connection budget is a deterministic way to trip the real
    // per-source limiter on every connection, independent of wall-clock bucket
    // boundaries. Timing the complete exchange measures the socket-facing
    // cost, including accept, limiter lookup, task scheduling, response write
    // and bounded close; it has no pass/fail speed threshold.
    let started = std::time::Instant::now();
    let refusals = 32;
    for _ in 0..refusals {
        let mut stream = tokio::net::TcpStream::connect(protocol)
            .await
            .expect("the protocol listener accepts");
        let response = checked_http_exchange_until_eof(
            &mut stream,
            "POST /anything HTTP/1.1\r\nHost: ignored.example\r\nContent-Length: 9\r\n\r\nbody-data",
        )
        .await;
        let response = String::from_utf8(response).expect("the HTTP response is ASCII");
        assert!(
            response.starts_with("HTTP/1.1 429 Too Many Requests\r\n"),
            "the limiter closed without an HTTP refusal: {response:?}"
        );
        let (head, body) = response.split_once("\r\n\r\n").expect("HTTP response head");
        assert_eq!(body, "", "the refusal must not carry content");
        assert!(
            head.lines().any(|line| line == "Content-Length: 0"),
            "{head}"
        );
        assert!(
            head.lines().any(|line| line == "Cache-Control: no-store"),
            "{head}"
        );
        assert!(!response.contains("ignored.example"), "{response:?}");
    }
    let elapsed = started.elapsed();
    eprintln!(
        "local per-source 429 measurement: {refusals} sequential loopback exchanges in {elapsed:?} ({:.1} refusals/s)",
        f64::from(refusals) / elapsed.as_secs_f64()
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn tls_rate_limit_returns_encrypted_429_and_keeps_allowed_upgrade() {
    let server = Server::start(tls_base())
        .await
        .expect("the TLS relay starts");
    let protocol = server.protocol_addr();

    // Hold a real allowed TLS/WebSocket upgrade open. The per-source open
    // limit is one, so the next connection deterministically exercises
    // TooManyFromSource instead of relying on a wall-clock rate bucket.
    let mut allowed = connect_tls(protocol).await;
    assert_eq!(
        allowed.get_ref().1.protocol_version(),
        Some(tokio_rustls::rustls::ProtocolVersion::TLSv1_3)
    );
    allowed
        .write_all(handshake_for(protocol, "/relay/v1").as_bytes())
        .await
        .expect("the WebSocket request is written inside TLS");
    let upgrade = response_head(&mut allowed).await;
    assert!(upgrade.starts_with("HTTP/1.1 101 "), "{upgrade:?}");
    assert!(
        upgrade
            .lines()
            .any(|line| { line.eq_ignore_ascii_case("sec-websocket-protocol: free2z-relay.v1") })
    );

    // The listener receives the request body but must not parse it to decide
    // the limiter refusal. Half-close lets its bounded drain finish, and the
    // checked read proves the encrypted response ends in clean TLS EOF.
    let mut refused = connect_tls(protocol).await;
    let response = checked_http_exchange_until_eof(
        &mut refused,
        "POST /ignored HTTP/1.1\r\nHost: ignored.example\r\nContent-Length: 9\r\n\r\nbody-data",
    )
    .await;
    let response = String::from_utf8(response).expect("the encrypted HTTP response is ASCII");
    assert!(
        response.starts_with("HTTP/1.1 429 Too Many Requests\r\n"),
        "TLS refusal was not an HTTP 429: {response:?}"
    );
    assert!(
        response.ends_with("\r\n\r\n"),
        "the response has a body: {response:?}"
    );
    assert!(!response.contains("ignored.example"));

    drop(allowed);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_tls_refusals_are_capped_and_slots_expire_and_reuse() {
    let server = Server::start(tls_base())
        .await
        .expect("the TLS relay starts");
    let protocol = server.protocol_addr();

    // Keep one permitted WebSocket live so every following source connection
    // is refused before TLS. The 16 silent peers then occupy every bounded TLS
    // response task without sending ClientHello bytes.
    let mut allowed = connect_tls(protocol).await;
    allowed
        .write_all(handshake_for(protocol, "/relay/v1").as_bytes())
        .await
        .expect("the WebSocket request is written inside TLS");
    let upgrade = response_head(&mut allowed).await;
    assert!(upgrade.starts_with("HTTP/1.1 101 "), "{upgrade:?}");

    let mut silent = Vec::with_capacity(16);
    for _ in 0..16 {
        silent.push(
            tokio::net::TcpStream::connect(protocol)
                .await
                .expect("the protocol listener accepts a silent TLS peer"),
        );
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    let mut excess = tokio::net::TcpStream::connect(protocol)
        .await
        .expect("the protocol listener accepts the over-cap peer");
    assert!(
        closes_within(&mut excess, Duration::from_millis(500)).await,
        "the peer beyond the 16 response slots was not closed promptly"
    );

    // The admitted clients have not reached the one-second TLS deadline yet.
    // WouldBlock proves each socket is still open and has received no plaintext
    // response while TLS negotiation is incomplete.
    for (index, stream) in silent.iter_mut().enumerate() {
        let mut byte = [0u8; 1];
        assert!(
            matches!(
                stream.try_read(&mut byte),
                Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock
            ),
            "admitted silent TLS peer {index} closed or received bytes before its deadline"
        );
    }

    // All admitted handshakes reach their timeout and release their slots.
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    for (index, stream) in silent.iter_mut().enumerate() {
        assert!(
            closes_within(stream, Duration::from_millis(200)).await,
            "silent TLS peer {index} survived beyond the handshake deadline"
        );
    }

    // A trusted TLS client now reuses a response slot and receives the real
    // encrypted refusal while the allowed WebSocket still holds the source
    // connection permit.
    let mut retry = connect_tls(protocol).await;
    let response = checked_http_exchange_until_eof(
        &mut retry,
        "GET /ignored HTTP/1.1\r\nHost: ignored.example\r\n\r\n",
    )
    .await;
    assert!(
        response.starts_with(b"HTTP/1.1 429 Too Many Requests\r\n"),
        "a released slot did not serve a TLS 429: {response:?}"
    );

    drop(allowed);
    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_cancels_a_pending_tls_refusal() {
    let server = Server::start(tls_base())
        .await
        .expect("the TLS relay starts");
    let protocol = server.protocol_addr();

    let mut allowed = connect_tls(protocol).await;
    allowed
        .write_all(handshake_for(protocol, "/relay/v1").as_bytes())
        .await
        .expect("the WebSocket request is written inside TLS");
    let upgrade = response_head(&mut allowed).await;
    assert!(upgrade.starts_with("HTTP/1.1 101 "), "{upgrade:?}");

    let mut silent = tokio::net::TcpStream::connect(protocol)
        .await
        .expect("the protocol listener accepts a silent TLS peer");
    tokio::time::sleep(Duration::from_millis(50)).await;
    server.shutdown().await;
    assert!(
        closes_within(&mut silent, Duration::from_millis(250)).await,
        "listener shutdown left the pending TLS refusal alive"
    );
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
async fn a_request_head_split_across_segments_is_still_answered() {
    // Found by the codex adversarial review of this change. The first version
    // looked at the socket exactly once, so a head that arrived in two pieces
    // was handed straight to `accept_hdr_async` and closed without a response:
    // the original defect, still reachable, and now dependent on TCP arrival
    // boundaries rather than on anything anyone could reason about. One write
    // by the sender is not one read by the receiver.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let mut stream = tokio::net::TcpStream::connect(protocol)
        .await
        .expect("the protocol listener accepts");
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\n")
        .await
        .expect("the first segment is written");
    // Well past any short polling budget. The first version of this fix
    // looked eight times at 20ms and then gave up, so a 400ms gap put the
    // request straight back on the closed-socket path; reading rather than
    // polling means the gap simply does not matter.
    tokio::time::sleep(Duration::from_millis(400)).await;
    stream
        .write_all(b"\r\n")
        .await
        .expect("the terminator is written");

    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;

    assert!(
        response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
        "a fragmented request went unanswered: {response:?}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_with_a_binary_body_is_answered_from_its_head() {
    // Also from the codex review. Requiring the whole peeked prefix to be
    // UTF-8 let the BODY decide whether the HEAD could be answered, so the
    // same request got a 426 or a closed socket depending on whether the two
    // shared a segment. Framing must not depend on packet boundaries.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let mut stream = tokio::net::TcpStream::connect(protocol)
        .await
        .expect("the protocol listener accepts");
    let mut request = b"POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\n".to_vec();
    request.push(0xff);
    stream
        .write_all(&request)
        .await
        .expect("the request is written");

    let mut response = String::new();
    let _ =
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_string(&mut response)).await;

    assert!(
        response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
        "a binary body hid a perfectly good head: {response:?}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cookie_laden_request_is_still_answered() {
    // The first version bounded the look at 2 KiB, so an ordinary crawler or
    // browser request carrying a few kilobytes of cookies fell through to the
    // closed socket. 4 KiB of headers is unremarkable on the open internet.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let cookie = "a".repeat(4096);
    let request = format!("GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\nCookie: {cookie}\r\n\r\n");
    let response = exchange_until_close(protocol, &request).await;

    assert!(
        response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
        "a 4 KiB header block went unanswered: {response:?}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_handshake_behind_a_leading_blank_line_still_upgrades() {
    // RFC 9112 §2.2 lets a server ignore empty lines before the request line,
    // and the parser inside `accept_hdr_async` does — so this shape WORKS on
    // the relay in production today. An early version of this fix read those
    // four bytes as a complete empty head and answered 426, taking a working
    // client's connectivity away. That is a regression the fix must not make.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let padded = format!("\r\n{}", handshake_for(protocol, "/relay/v1"));
    let response = exchange_head(protocol, &padded).await;

    assert!(
        response.starts_with("HTTP/1.1 101 "),
        "a handshake that works today was refused: {response:?}"
    );

    server.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_head_request_gets_no_body() {
    // RFC 9112 §6.3: a response to HEAD ends at the header terminator whatever
    // its Content-Length says. This listener does not parse the method, so the
    // only way the answer can be legal for HEAD is for it to have no body for
    // anyone — which is also the most content-free thing it could say.
    let server = Server::start(base()).await.expect("the relay starts");
    let protocol = server.protocol_addr();

    let response = exchange_until_close(protocol, "HEAD / HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert!(
        response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
        "{response:?}"
    );
    assert!(
        response.ends_with("\r\n\r\n"),
        "a body followed the head of a HEAD response: {response:?}"
    );
    let (_head, body) = response.split_once("\r\n\r\n").expect("a parseable head");
    assert_eq!(body, "");

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
