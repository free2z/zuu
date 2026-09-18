//! The public listener: accept, upgrade, hand over (§2.1, §2.3, §13.1 layer 1).
//!
//! # §2.3 is enforced at bind, not warned about
//!
//! > *A relay **MUST refuse to bind a non-loopback address without TLS.** This
//! > is a startup check, not a warning: the process exits.*
//!
//! [`crate::config::Config::check`] is where that decision is made, so it is
//! reachable from `--check-config` without opening a socket. This module is
//! where it is *acted on*: [`bind`] refuses the same case again, because a
//! listener that could be constructed by a caller who skipped the check is a
//! listener that will eventually be constructed that way.
//!
//! The override is published, not private: `--insecure-listen` makes the
//! capability document say `transport_security: none` and
//! `channel_binding_mode: none`, and [`crate::caps`] derives both from the same
//! question the listener asks, so they cannot disagree.
//!
//! # What the upgrade checks
//!
//! §2.1 makes two things mandatory and this enforces both: the path
//! `/relay/v1`, and the `free2z-relay.v1` subprotocol **echoed back**. A relay
//! that does not echo it is one the client must refuse, so a relay that forgets
//! to is a relay nobody can talk to — which is a bug worth failing loudly rather
//! than a nicety.
//!
//! # What answers a peer that is not speaking WebSocket at all
//!
//! A request that is not a handshake — a scanner, a crawler, `/favicon.ico`,
//! `/.env`, or any HTTP/2 client, since a WebSocket upgrade cannot be expressed
//! over h2 — used to get **no HTTP response whatsoever**: the socket simply
//! closed. A Google Cloud load balancer renders "the backend closed the
//! connection before sending data" as **502**, so 100% of non-upgrade traffic
//! to the public hostname became a 5xx attributed to the shared production URL
//! map — ~5,700 a day, and a page on an alert whose whole meaning is "the site
//! is broken" while the site was entirely healthy (free2z/zuu#1037,
//! free2z/tuzi#1937). The 502 also actively lied: it said *this* backend had
//! failed, when the truth was that the caller had not spoken the protocol.
//!
//! So [`handshake`] answers that case itself, with a constant **426 Upgrade
//! Required** ([`NOT_A_WEBSOCKET`]), before `accept_hdr_async` ever sees the
//! bytes. Two things it deliberately is not:
//!
//! * **It is not an HTTP surface.** Nothing is routed, no target is examined,
//!   there is no `/metrics` and no health endpoint here — `/healthz` stays on
//!   the separate health listener ([`crate::admin`]) where a probe can reach
//!   it. One constant status for "you are not a WebSocket", and §2.2's argument
//!   against a second parser on the unauthenticated port is exactly why it
//!   stops there.
//! * **It is not [`reject`]'s 400, and the difference is the point.** A 400
//!   says *your handshake is wrong*, and it is the honest answer to a peer that
//!   **did** ask to upgrade and then named the wrong path or omitted the
//!   mandatory subprotocol (§2.1). A 426 says *this port only speaks
//!   WebSocket*, and it is the honest answer to a peer that never asked at all.
//!   Answering the second case with a 400 would tell a crawler its perfectly
//!   well-formed request was malformed; answering the first with a 426 would
//!   tell a real client to go and do the thing it just did. Both statuses stay,
//!   on their own cases.

use std::net::SocketAddr;
use std::sync::Arc;

use std::time::Duration;

use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as HandshakeRequest, Response as HandshakeResponse,
};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

use crate::abuse::Refusal;
use crate::config::is_loopback;
use crate::engine::Relay;
use crate::metrics::Metrics;
use crate::transport::{RELAY_PATH, SUBPROTOCOL, Transport, wrap};

const HEADER_SUBPROTOCOL: &str = "sec-websocket-protocol";

/// The most of a peer's first segment that is looked at before deciding whether
/// it is attempting a WebSocket upgrade.
///
/// The same bound, chosen for the same reason, as the single read in
/// [`crate::admin`]: a request line plus whatever headers arrived alongside it.
/// It bounds the LOOK and not the protocol — nothing here consumes a byte, and
/// a request head longer than this is simply handed on undecided.
const SNIFF_LIMIT: usize = 2048;

/// How long the refusal goes on discarding what the peer sent, after the
/// response is written, before closing anyway.
///
/// **This is not politeness, it is whether the response survives.** Closing a
/// TCP socket that still has unread data in its receive queue makes the kernel
/// send an **RST rather than a FIN** — Linux's `tcp_close` does it and so do
/// the BSD-derived stacks — and an RST tells the peer's stack to discard what
/// it has buffered but not yet handed to the application. Since the sniff
/// above deliberately does not CONSUME the request, every refused connection
/// would close with the whole request still unread, and the 426 would be
/// written and then thrown away. The peer would see a reset connection, which
/// a load balancer renders as… a 502. That is the bug this change exists to
/// fix, reintroduced one layer down.
///
/// It was observed rather than reasoned about:
/// `a_plain_get_over_a_real_socket_is_answered_not_dropped` failed with
/// `ECONNRESET` before this existed.
///
/// So: write, FIN, then read and drop whatever arrives until the peer closes
/// too. 250ms is a bound on a peer that sends and never stops — it is not a
/// budget anything well-behaved spends, because a client reading a
/// `Connection: close` response closes as soon as it has it.
const LINGER: Duration = Duration::from_millis(250);

/// The whole of the answer to a peer that is not speaking WebSocket, exactly as
/// it goes on the wire.
///
/// **Constant, in the same sense `/healthz` is constant** (see
/// [`crate::admin`]): the same bytes for every peer, every target and every
/// source address. It echoes no request, names no queue, and carries no
/// counter, no version and no client address; the body contains no digit at
/// all. That it is a `const` rather than anything formatted is the enforcement
/// rather than the intention — there is no parameter here through which a
/// request could travel into a response, in the same way [`crate::log`] has no
/// parameter through which a payload could travel into a log line.
///
/// `Upgrade: websocket` is not decoration: RFC 9110 §15.5.22 makes the
/// `Upgrade` field REQUIRED on a 426, and it is the one thing that makes the
/// status actionable rather than merely honest.
///
/// `Connection: close` and an exact `Content-Length` together mean nothing in
/// front of this relay ever has to guess where the message ends — a peer left
/// guessing is the whole of what went wrong here in the first place.
const NOT_A_WEBSOCKET: &str = concat!(
    "HTTP/1.1 426 Upgrade Required\r\n",
    "Upgrade: websocket\r\n",
    "Connection: close\r\n",
    "Content-Type: text/plain; charset=utf-8\r\n",
    // 17, the length of the body below. The two are pinned together by
    // `the_refusal_is_a_parseable_http_response_that_discloses_nothing`,
    // because a `Content-Length` that disagrees with its body is precisely the
    // sort of thing that reads fine and breaks a proxy.
    "Content-Length: 17\r\n",
    "Cache-Control: no-store\r\n",
    "\r\n",
    "upgrade required\n",
);

/// Why a listener could not be created.
#[derive(Debug)]
pub enum ListenError {
    /// §2.3: a non-loopback bind without TLS and without the override.
    InsecureBind,
    /// The socket could not be bound.
    Io(std::io::Error),
}

impl std::fmt::Display for ListenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InsecureBind => f.write_str(
                "refusing to bind a non-loopback address without TLS (WIRE.md §2.3); \
                 configure listen.tls_cert and listen.tls_key, or pass --insecure-listen",
            ),
            Self::Io(error) => write!(f, "bind: {error}"),
        }
    }
}

impl std::error::Error for ListenError {}

/// Bind the protocol listener.
///
/// # Errors
///
/// [`ListenError::InsecureBind`] for §2.3's refused case, or
/// [`ListenError::Io`] if the socket cannot be bound.
pub async fn bind(
    addr: SocketAddr,
    tls: bool,
    insecure_override: bool,
) -> Result<TcpListener, ListenError> {
    if !tls && !is_loopback(&addr) && !insecure_override {
        return Err(ListenError::InsecureBind);
    }
    TcpListener::bind(addr).await.map_err(ListenError::Io)
}

/// Accept connections until `shutdown` flips.
pub async fn serve(
    relay: Arc<Relay>,
    listener: TcpListener,
    acceptor: Option<TlsAcceptor>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let Ok((stream, peer)) = accepted else {
            // A transient accept failure (a descriptor limit, a peer that reset
            // between the SYN and the accept) must not end the listener: the
            // relay would then be a process that is running and serving nobody.
            crate::log_warn!("accept failed");
            continue;
        };

        let metrics = Arc::clone(relay.metrics());
        let abuse = Arc::clone(relay.abuse());
        let source = abuse.key_for(&peer);
        // §13.1 layer 1, applied **before** any protocol is spoken. There is no
        // HELLO yet, so there is no frame to answer with; the socket closes.
        let permit = match abuse.accept(source, crate::now_ms()) {
            Ok(permit) => permit,
            Err(reason) => {
                Metrics::inc(&metrics.connections_refused);
                crate::log_debug!("connection refused", "reason" = refusal_code(reason));
                drop(stream);
                continue;
            }
        };
        Metrics::inc(&metrics.connections_accepted);
        Metrics::inc(&metrics.connections_open);

        let relay = Arc::clone(&relay);
        let acceptor = acceptor.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let outcome = handshake(stream, acceptor.as_ref()).await;
            if let Some((transport, binding)) = outcome {
                crate::connection::drive(relay, transport, binding, source, shutdown).await;
            }
            Metrics::dec(&metrics.connections_open);
            // The permit is released here, whatever path the task took — a
            // failed TLS handshake, a refused upgrade, or a full session.
            drop(permit);
        });
    }
}

const fn refusal_code(reason: Refusal) -> u32 {
    match reason {
        Refusal::TooManyConnections => 1,
        Refusal::TooManyFromSource => 2,
        Refusal::ConnectingTooFast => 3,
        Refusal::Backpressure => 4,
    }
}

async fn handshake(
    mut stream: TcpStream,
    acceptor: Option<&TlsAcceptor>,
) -> Option<(Transport, f2z_codec::types::ChannelBinding)> {
    // Nagle costs a relay latency and buys it nothing: every frame is written
    // whole by the writer task.
    let _ = stream.set_nodelay(true);

    match acceptor {
        Some(acceptor) => {
            let tls = acceptor.accept(stream).await.ok()?;
            // §5.3: the exporter is taken from the completed handshake, before
            // the WebSocket upgrade consumes the stream. No binding is a
            // refusal, not a degradation to `none` — this relay publishes
            // `channel_binding_mode: tls-exporter`, and §5.3 requires the
            // connection to be refused rather than carry the `none` sentinel.
            let binding = {
                let (_io, connection) = tls.get_ref();
                crate::tls::export(connection)?
            };
            // No 426 on this path, and that is a scope decision rather than
            // an oversight — see `refuse_non_upgrade`, which explains why the
            // answer is offered over plaintext only. A relay that terminates
            // TLS itself and is then sent a non-upgrade request still gets the
            // closed socket it got before #1037.
            let socket = tokio_tungstenite::accept_hdr_async(tls, check_upgrade)
                .await
                .ok()?;
            Some((wrap(socket), binding))
        }
        None => {
            // #1037. If the peer plainly is not asking to upgrade, it is told
            // so and the connection ends here; `accept_hdr_async` never sees
            // it. Everything else — including every case that cannot be
            // decided — falls through to exactly the code that ran before.
            if refuse_non_upgrade(&mut stream).await {
                return None;
            }
            let socket = tokio_tungstenite::accept_hdr_async(stream, check_upgrade)
                .await
                .ok()?;
            // §5.3: "MUST use **32 zero bytes** in the transcript".
            Some((wrap(socket), f2z_codec::types::ChannelBinding::zero()))
        }
    }
}

/// Answer a peer that is not attempting a WebSocket upgrade, reporting whether
/// it was answered.
///
/// `true` means the connection has been served and shut down and the caller
/// must not go on to use it. `false` means "hand it to the handshake", and it
/// is the answer to every case this cannot settle — the refusal is only ever
/// issued from evidence already in hand, so anything ambiguous degrades to the
/// behaviour that existed before rather than to a confident wrong answer.
///
/// # Why this is on the plaintext path only
///
/// * **It is the deployed topology, and the one that produced the 502s.** The
///   load balancer terminates TLS and the pod speaks plaintext behind it
///   (`F2Z_RELAY_LISTEN_INSECURE=true` in `k8s/f2z-relay/deployment.yaml` in
///   the tuzi repo, which [`crate::caps`] then publishes honestly as
///   `transport_security: none`), so every request the load balancer forwards
///   arrives here.
/// * **`peek` is what makes this free.** It leaves the stream byte-for-byte
///   untouched, so `accept_hdr_async` reads exactly what it read before this
///   existed and the working `101` path cannot regress: there is no new
///   buffering layer anywhere in a session's read path. `rustls` offers no
///   equivalent, and faking one means a prefix-buffering wrapper sitting
///   underneath every frame of every connection for the life of the session —
///   new code on the hot path, to fix a cold path that no load balancer is
///   turning into a 5xx.
async fn refuse_non_upgrade(stream: &mut TcpStream) -> bool {
    let mut prefix = [0u8; SNIFF_LIMIT];
    // ONE peek, with no reassembly loop, which is the same discipline
    // `crate::admin` applies to its single `read`. A loop here would be a SPIN
    // loop: `peek` is non-destructive and returns immediately with whatever is
    // already buffered, so a peer that sends half a request and then stalls
    // would be re-peeked as fast as the scheduler allows, on an internet-facing
    // port, for as long as it cared to hold the socket open. A request head
    // split across segments is therefore left to `accept_hdr_async` exactly as
    // it was — every client that matters here, the load balancer and `curl`
    // and a scanner alike, writes the whole head in a single write.
    let Ok(peeked) = stream.peek(&mut prefix).await else {
        return false;
    };
    if !is_settled_non_upgrade(prefix.get(..peeked).unwrap_or_default()) {
        return false;
    }
    // Borrowing the stream rather than taking it by value is what lets the
    // caller keep ownership for the handshake path. Every step is best-effort:
    // a peer that has already hung up is not an error worth a branch, because
    // there is nothing to fall back to and nothing to report that would not be
    // a log line about an unauthenticated stranger.
    let _ = stream.write_all(NOT_A_WEBSOCKET.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
    discard_request(stream).await;
    true
}

/// Read and drop whatever the peer sent, so that closing does not reset it.
///
/// See [`LINGER`] for why a refusal that skips this is a refusal the peer never
/// receives. Bounded in time rather than in bytes: a peer that keeps sending is
/// dropped on the deadline, and every other peer reaches end-of-stream long
/// before it.
async fn discard_request(stream: &mut TcpStream) {
    let mut sink = [0u8; SNIFF_LIMIT];
    let deadline = tokio::time::Instant::now() + LINGER;
    while let Ok(Ok(read)) = tokio::time::timeout_at(deadline, stream.read(&mut sink)).await {
        if read == 0 {
            break;
        }
    }
}

/// Whether `prefix` holds a **complete** request head that is **not** asking to
/// upgrade.
///
/// "Settled" is the whole of the contract: `false` means either "this is a
/// handshake" or "I cannot tell yet", and both hand the connection on
/// untouched. Only a head that has ended — `\r\n\r\n` seen — and carries no
/// `Upgrade` field naming `websocket` is answered.
///
/// **This is not an HTTP parser and must not become one.** It reads no method,
/// no target and no version, it interprets no other header, and its entire
/// output is one bit choosing between two code paths that both already existed.
/// RFC 6455 §4.1 requires `Upgrade: websocket` on every handshake, so a head
/// without one is not a handshake — including the malformed near-miss that
/// sends `Sec-WebSocket-Key` and forgets to ask for the upgrade, which never
/// reaches [`reject`]'s 400 anyway because it never parses as a handshake at
/// all.
fn is_settled_non_upgrade(prefix: &[u8]) -> bool {
    // Not being UTF-8 is not a decision: a TLS `ClientHello` that arrived on the
    // plaintext port, or any binary probe, is handed on rather than answered in
    // text it was never going to read.
    let Ok(text) = core::str::from_utf8(prefix) else {
        return false;
    };
    let Some(end) = text.find("\r\n\r\n") else {
        return false;
    };
    let Some(head) = text.get(..end) else {
        return false;
    };
    // `skip(1)` drops the request line, which is not a header: a scanner asking
    // for `/upgrade` must not read as one asking to upgrade.
    !head.split("\r\n").skip(1).any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.trim().eq_ignore_ascii_case("upgrade")
            && contains_ignore_ascii_case(value, b"websocket")
    })
}

/// A case-insensitive substring test that allocates nothing.
///
/// `to_ascii_lowercase` would be one `String` per header line of every
/// connection arriving on an unauthenticated port, to answer a question about
/// nine bytes.
fn contains_ignore_ascii_case(haystack: &str, needle: &[u8]) -> bool {
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

/// §2.1's two mandatory properties of the upgrade.
///
/// The `Err` variant is `tungstenite`'s own `http::Response`, whose size is not
/// ours to change, and this runs once per accept rather than on a hot path.
#[allow(
    clippy::result_large_err,
    reason = "the error type is tungstenite's Callback contract, once per accept"
)]
fn check_upgrade(
    request: &HandshakeRequest,
    mut response: HandshakeResponse,
) -> Result<HandshakeResponse, ErrorResponse> {
    if request.uri().path() != RELAY_PATH {
        return Err(reject("the relay serves only /relay/v1 (WIRE.md §2.1)"));
    }
    let offered = request
        .headers()
        .get(HEADER_SUBPROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !offered
        .split(',')
        .map(str::trim)
        .any(|value| value == SUBPROTOCOL)
    {
        return Err(reject(
            "the subprotocol header is mandatory in both directions (WIRE.md §2.1)",
        ));
    }
    response
        .headers_mut()
        .insert(HEADER_SUBPROTOCOL, HeaderValue::from_static(SUBPROTOCOL));
    Ok(response)
}

fn reject(reason: &'static str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(reason.to_owned()));
    *response.status_mut() = StatusCode::BAD_REQUEST;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_non_loopback_bind_without_tls_is_refused() {
        let addr: SocketAddr = "0.0.0.0:0".parse().unwrap();
        assert!(matches!(
            bind(addr, false, false).await,
            Err(ListenError::InsecureBind)
        ));
        // With TLS, or with the published override, §2.3 permits it.
        assert!(bind(addr, true, false).await.is_ok());
        assert!(bind(addr, false, true).await.is_ok());
    }

    #[tokio::test]
    async fn loopback_without_tls_needs_no_override() {
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        assert!(bind(addr, false, false).await.is_ok());
    }

    /// A handshake as a real client sends one: RFC 6455's own sample key, the
    /// path §2.1 mandates, and the subprotocol §2.1 mandates.
    const HANDSHAKE: &str = "GET /relay/v1 HTTP/1.1\r\n\
         Host: relay.free2z.cash\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Sec-WebSocket-Protocol: free2z-relay.v1\r\n\
         \r\n";

    #[test]
    fn the_refusal_is_a_parseable_http_response_that_discloses_nothing() {
        // The production failure was an UNPARSEABLE reply — specifically, no
        // reply — so "it parses" is the property, not a formality.
        let (head, body) = NOT_A_WEBSOCKET
            .split_once("\r\n\r\n")
            .expect("the response has a head and a body");
        assert!(
            head.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
            "{NOT_A_WEBSOCKET}"
        );

        // RFC 9110 §15.5.22: `Upgrade` is REQUIRED on a 426. Without it the
        // status names no protocol and the caller learns nothing actionable.
        assert!(
            head.lines()
                .any(|line| line.eq_ignore_ascii_case("upgrade: websocket")),
            "{head}"
        );

        // A `Content-Length` that disagrees with the body is a framing bug that
        // looks fine in a test that only reads the status line.
        let declared: usize = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .expect("the response declares its length")
            .parse()
            .expect("the declared length is a number");
        assert_eq!(
            declared,
            body.len(),
            "Content-Length disagrees with {body:?}"
        );

        // The `/healthz` discipline, applied here: the body is constant and
        // carries no number. Nothing about the queue, the peer, the build or
        // the request can reach it, because there is no parameter to reach it
        // through — this is a `const`.
        assert_eq!(body, "upgrade required\n");
        assert!(
            !body.chars().any(|character| character.is_ascii_digit()),
            "the refusal reported a number"
        );
    }

    #[test]
    fn a_plain_request_is_settled_as_a_non_upgrade() {
        // Exactly the traffic that was turning into 502s.
        assert!(is_settled_non_upgrade(
            b"GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n"
        ));
        assert!(is_settled_non_upgrade(
            b"GET /favicon.ico HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n"
        ));
        assert!(is_settled_non_upgrade(b"GET /.env HTTP/1.0\r\n\r\n"));

        // The request TARGET is not a header. `/websocket` and `/upgrade` are
        // scanner paths, not an intention to upgrade, and a substring search
        // over the whole head would get both of these wrong.
        assert!(is_settled_non_upgrade(
            b"GET /websocket HTTP/1.1\r\nHost: x\r\n\r\n"
        ));
        assert!(is_settled_non_upgrade(
            b"GET /upgrade HTTP/1.1\r\nHost: x\r\n\r\n"
        ));
    }

    #[test]
    fn a_handshake_is_never_settled_as_a_non_upgrade() {
        // The regression that would matter most: a 426 written over a real
        // client's handshake breaks the relay for everyone who can use it.
        assert!(!is_settled_non_upgrade(HANDSHAKE.as_bytes()));

        // Field names and values are case-insensitive, and clients genuinely
        // differ — `Upgrade: WebSocket` is the spelling in RFC 6455's own
        // example, and `UPGRADE:` is legal too.
        assert!(!is_settled_non_upgrade(
            b"GET /relay/v1 HTTP/1.1\r\nUPGRADE: WebSocket\r\n\r\n"
        ));
        // A header value may carry more than one token.
        assert!(!is_settled_non_upgrade(
            b"GET /relay/v1 HTTP/1.1\r\nUpgrade: h2c, websocket\r\n\r\n"
        ));
    }

    #[test]
    fn an_undecided_prefix_is_handed_to_the_handshake() {
        // No end of head yet, so these bytes may still become a handshake and
        // nothing is answered. This is the direction the ambiguity HAS to
        // fall: handing it on is precisely the behaviour that existed before
        // #1037, whereas answering early would break a client mid-handshake.
        assert!(!is_settled_non_upgrade(b""));
        assert!(!is_settled_non_upgrade(b"GET / HTTP/1.1\r\nHost: x\r\n"));
        // A head longer than the bound is undecided rather than refused.
        let long = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "y".repeat(SNIFF_LIMIT));
        let truncated = long.as_bytes().get(..SNIFF_LIMIT).unwrap();
        assert!(!is_settled_non_upgrade(truncated));
        // Not UTF-8 at all: a TLS `ClientHello` that found the plaintext port.
        assert!(!is_settled_non_upgrade(&[0x16, 0x03, 0x01, 0xff, 0xfe]));
    }

    #[test]
    fn the_two_refusals_are_different_statuses_on_purpose() {
        // `reject` answers a peer that DID ask to upgrade and got §2.1 wrong;
        // `NOT_A_WEBSOCKET` answers a peer that never asked. Pinned here so
        // that a later "simplification" to one shared status has to argue with
        // a test rather than with a comment.
        assert_eq!(reject("whatever").status(), StatusCode::BAD_REQUEST);
        assert!(NOT_A_WEBSOCKET.starts_with("HTTP/1.1 426 "));

        // And the case each one takes. A wrong path WITH an upgrade request is
        // the 400 case, so it must not be settled away here before
        // `check_upgrade` ever runs.
        let wrong_path = HANDSHAKE.replace("/relay/v1", "/nope");
        assert!(!is_settled_non_upgrade(wrong_path.as_bytes()));
    }

    #[tokio::test]
    async fn a_plain_get_over_a_real_socket_is_answered_not_dropped() {
        // The unit-level statement of the production defect: bytes on the
        // wire, from the code path `serve` actually calls. `tests/non_upgrade.rs`
        // makes the same assertion against a whole running relay.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _peer) = listener.accept().await.unwrap();
            refuse_non_upgrade(&mut stream).await
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n")
            .await
            .unwrap();

        let mut response = String::new();
        tokio::io::AsyncReadExt::read_to_string(&mut client, &mut response)
            .await
            .unwrap();

        assert!(server.await.unwrap(), "the peer was not answered");
        assert!(!response.is_empty(), "the socket closed without a response");
        assert_eq!(response, NOT_A_WEBSOCKET);
    }
}
