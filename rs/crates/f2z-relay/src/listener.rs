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
//!
//! **What still is not answered**, said plainly rather than left to be
//! discovered: a request whose head exceeds [`MAX_HEAD`], or which takes
//! longer than [`HEAD_TIMEOUT`] to arrive, is handed to `accept_hdr_async`
//! undecided and gets the closed socket it got before. Both are deliberate —
//! every byte and every second of them is spent on an unauthenticated peer,
//! and the alternative to a bound is no bound — and both are far outside what
//! the traffic that caused the incident looks like. The ambiguity always falls
//! the same way: towards the old behaviour, never towards refusing a peer that
//! might have been a client.

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, ReadBuf};
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

/// The most of a request head that is buffered while deciding whether the peer
/// is attempting a WebSocket upgrade.
///
/// A head larger than this is handed on undecided rather than answered — see
/// [`read_head`] — so this is the one bound that still leaves the old
/// behaviour reachable. 16 KiB is chosen against what actually arrives: a
/// WebSocket handshake is a few hundred bytes, and a cookie-laden browser or
/// crawler request is a few kilobytes. It is deliberately not the load
/// balancer's own ~60 KiB ceiling, because every byte of this is buffered per
/// connection before anything has been authenticated.
const MAX_HEAD: usize = 16 * 1024;

/// How much is read from the socket at a time while collecting the head.
const READ_CHUNK: usize = 2048;

/// The longest the head may take to arrive before the connection is handed on
/// with the behaviour that existed before #1037.
///
/// There was no deadline on this phase at all before: `accept_hdr_async` would
/// wait on a peer indefinitely, and it still does after the hand-off, so this
/// bounds only how long the 426 path is willing to wait — it is not a security
/// control. Ten seconds is §2.5's handshake budget, which is the figure this
/// connection is already judged against a moment later.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the refusal goes on discarding what the peer sent, after the
/// response is written, before closing anyway.
///
/// **This is not politeness, it is whether the response survives.** Closing a
/// TCP socket that still has unread data in its receive queue makes the kernel
/// send an **RST rather than a FIN** — Linux's `tcp_close` does it and so do
/// the BSD-derived stacks — and an RST tells the peer's stack to discard what
/// it has buffered but not yet handed to the application. The refused
/// connection has had its HEAD read, but not its BODY: a `POST` with content
/// closes with that content still unread, and the 426 is written and then
/// thrown away. The peer sees a reset connection, which a load balancer
/// renders as… a 502 — the bug this change exists to fix, reintroduced one
/// layer down.
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
/// counter, no version and no client address. That it is a `const` rather than
/// anything formatted is the enforcement rather than the intention — there is
/// no parameter here through which a request could travel into a response, in
/// the same way [`crate::log`] has no parameter through which a payload could
/// travel into a log line.
///
/// **The body is empty, and that is a decision.** A short `upgrade required`
/// line was the first draft, and it bought nothing that
/// `426 Upgrade Required` plus `Upgrade: websocket` does not already say.
/// Dropping it removes three problems at once: RFC 9112 §6.3 forbids a body on
/// a response to `HEAD`, so a constant body would have been illegal for every
/// crawler that sends one and would have needed the method parsed to avoid it;
/// a `Content-Length` and a body can drift apart; and an empty body is the
/// furthest this can go towards saying nothing, which is the discipline the
/// whole listener is held to.
///
/// `Upgrade: websocket` is not decoration: RFC 9110 §15.5.22 makes the
/// `Upgrade` field REQUIRED on a 426, and it is the one thing that makes the
/// status actionable rather than merely honest.
///
/// `Connection: close` and an explicit `Content-Length: 0` together mean
/// nothing in front of this relay ever has to guess where the message ends — a
/// peer left guessing is the whole of what went wrong here in the first place.
const NOT_A_WEBSOCKET: &str = concat!(
    "HTTP/1.1 426 Upgrade Required\r\n",
    "Upgrade: websocket\r\n",
    "Connection: close\r\n",
    "Content-Length: 0\r\n",
    "Cache-Control: no-store\r\n",
    "\r\n",
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
            let mut tls = acceptor.accept(stream).await.ok()?;
            // §5.3: the exporter is taken from the completed handshake, before
            // the WebSocket upgrade consumes the stream. No binding is a
            // refusal, not a degradation to `none` — this relay publishes
            // `channel_binding_mode: tls-exporter`, and §5.3 requires the
            // connection to be refused rather than carry the `none` sentinel.
            let binding = {
                let (_io, connection) = tls.get_ref();
                crate::tls::export(connection)?
            };
            let replay = upgrade_or_answer(&mut tls).await?;
            let socket =
                tokio_tungstenite::accept_hdr_async(Replay::new(replay, tls), check_upgrade)
                    .await
                    .ok()?;
            Some((wrap(socket), binding))
        }
        None => {
            let replay = upgrade_or_answer(&mut stream).await?;
            let socket =
                tokio_tungstenite::accept_hdr_async(Replay::new(replay, stream), check_upgrade)
                    .await
                    .ok()?;
            // §5.3: "MUST use **32 zero bytes** in the transcript".
            Some((wrap(socket), f2z_codec::types::ChannelBinding::zero()))
        }
    }
}

/// Read the request head and decide what happens to the connection.
///
/// `Some(bytes)` means "carry on with the handshake", and `bytes` is what was
/// consumed from the stream while deciding — it has to be replayed or the
/// handshake reads a request with its beginning missing. `None` means the
/// connection is finished with: either it has been answered with
/// [`NOT_A_WEBSOCKET`], or the peer went away.
///
/// # Why the bytes are consumed rather than peeked
///
/// The first version of this change used `TcpStream::peek`, which is
/// non-destructive and therefore needs no replay at all. It was wrong, and the
/// adversarial review is what established that: a peek returns whatever has
/// arrived *so far*, so one look decides on a TCP segment boundary rather than
/// on a request, and looking again can only be done by polling — `peek`
/// returns immediately with the same bytes, so a peer that stalls mid-request
/// would be re-peeked as fast as the scheduler allows. Every bound that
/// polling needs (how many looks, how long between them) is a bound at which
/// an ordinary fragmented request silently falls back to the closed socket
/// this change exists to remove, with the outcome depending on packet timing.
///
/// Reading is deterministic instead: `read` waits for more data rather than
/// spinning, so the head is collected however it happens to be split, and the
/// only cost is that [`Replay`] has to hand those bytes back. `peek` also does
/// not exist on a TLS stream, which is why the first version could not answer
/// on the TLS path at all; this one answers on both.
async fn upgrade_or_answer<S>(stream: &mut S) -> Option<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match read_head(stream).await {
        Head::Gone => None,
        Head::HandOver(prefix) => Some(prefix),
        Head::NotAnUpgrade(prefix) => {
            // Every step is best-effort: a peer that has already hung up is not
            // an error worth a branch, because there is nothing to fall back to
            // and nothing to report that would not be a log line about an
            // unauthenticated stranger.
            let _ = stream.write_all(NOT_A_WEBSOCKET.as_bytes()).await;
            let _ = stream.flush().await;
            let _ = stream.shutdown().await;
            drop(prefix);
            discard_body(stream).await;
            None
        }
    }
}

/// What reading the head concluded.
#[derive(Debug)]
enum Head {
    /// A complete head that asks for no upgrade. Answer it with a 426.
    NotAnUpgrade(Vec<u8>),
    /// Hand the stream to `accept_hdr_async`, replaying these bytes first.
    HandOver(Vec<u8>),
    /// The peer went away before it said anything usable.
    Gone,
}

/// Collect the request head, stopping as soon as there is enough to decide.
async fn read_head<S>(stream: &mut S) -> Head
where
    S: AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    let mut chunk = [0u8; READ_CHUNK];
    let mut scan = HeadScan::default();
    let verdict = tokio::time::timeout(HEAD_TIMEOUT, async {
        loop {
            match scan.feed(&buffer) {
                Sniff::Answer => return Some(true),
                Sniff::HandOver => return Some(false),
                Sniff::Wait => {}
            }
            // A head this large is not one this will answer: the `Upgrade`
            // field could still be past the bound, and refusing a working
            // client is far worse than leaving an exotic request on the old
            // behaviour.
            if buffer.len() >= MAX_HEAD {
                return Some(false);
            }
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(read) => buffer.extend_from_slice(chunk.get(..read).unwrap_or_default()),
            }
        }
    })
    .await;

    match verdict {
        Ok(Some(true)) => Head::NotAnUpgrade(buffer),
        // Handing over, or out of time. Either way the bytes already read are
        // the start of the request and must go back.
        Ok(Some(false)) | Err(_) => Head::HandOver(buffer),
        Ok(None) => Head::Gone,
    }
}

/// What the scan concluded from the bytes in hand.
#[derive(Debug, PartialEq, Eq)]
enum Sniff {
    /// A complete head that asks for no upgrade.
    Answer,
    /// It is a handshake. Hand the stream over now, without waiting for the
    /// rest of the head — this is the path a real client takes, and it must
    /// never wait on anything here.
    HandOver,
    /// Not enough has arrived to say.
    Wait,
}

/// An incremental, line-at-a-time scan of the request head.
///
/// **This is not an HTTP parser and must not become one.** It reads no method,
/// no target and no version, it interprets no header but one, and its entire
/// output is the three-way choice above between code paths that already
/// existed. RFC 6455 §4.1 requires `Upgrade: websocket` on every handshake, so
/// a completed head without one is not a handshake — including the malformed
/// near-miss that sends `Sec-WebSocket-Key` and forgets to ask for the
/// upgrade, which never reaches [`reject`]'s 400 anyway because it never
/// parses as a handshake at all.
///
/// It works in **bytes**, never in `str`. Requiring the head to be UTF-8 was
/// wrong twice over: it made the verdict depend on the request BODY, and so on
/// whether the body shared a segment with the head, and HTTP field values are
/// not required to be UTF-8 in the first place (RFC 9110 §5.5), so an opaque
/// byte in an unrelated header would have been enough to drop the answer.
///
/// # Why it is incremental rather than a fresh look each time
///
/// [`read_head`] calls this once per read, and the naive version re-examined
/// the whole accumulated buffer every time. The read boundaries belong to the
/// PEER, so that is quadratic in a quantity an attacker chooses: one-byte
/// fragments up to [`MAX_HEAD`] cost on the order of a hundred million byte
/// visits for a connection that has sent 16 KiB, and it sits in front of the
/// fragmentation defence `tungstenite` applies to the same pattern. The
/// cursors below make the whole scan linear in the bytes received — every byte
/// is looked at once, whatever boundaries it arrives on — which is also what
/// makes the verdict independent of those boundaries. That independence is
/// asserted directly by
/// `the_verdict_does_not_depend_on_how_the_bytes_are_split`.
#[derive(Debug, Default)]
struct HeadScan {
    /// Where the current, not-yet-complete line begins.
    line_start: usize,
    /// How far into that line the search for its end has already looked, so a
    /// long line is not rescanned from the beginning on every read.
    searched: usize,
    /// Whether the request line has gone past. Until it has, a blank line is
    /// one of the empty lines RFC 9112 §2.2 lets a server ignore before the
    /// request line — `httparse`, the parser inside `accept_hdr_async`, does
    /// ignore them, so reading one as a complete empty head would answer 426
    /// to a handshake that works today.
    begun: bool,
    /// An `Upgrade` field naming `websocket` has been seen.
    upgrade: bool,
    /// The end of the head has been seen.
    ended: bool,
}

impl HeadScan {
    /// Examine whatever is new in `buffer` and report the verdict so far.
    ///
    /// `buffer` must be the same growing buffer on every call: the cursors are
    /// offsets into it.
    fn feed(&mut self, buffer: &[u8]) -> Sniff {
        while !self.upgrade && !self.ended {
            let line = buffer.get(self.line_start..).unwrap_or_default();
            let Some(unsearched) = line.get(self.searched..) else {
                break;
            };
            let Some(offset) = unsearched.iter().position(|byte| *byte == b'\n') else {
                // No end of line yet. Remember how far this looked so the next
                // read resumes here instead of starting over.
                self.searched = line.len();
                break;
            };
            let end = self.searched.saturating_add(offset);
            let complete = line.get(..end).unwrap_or_default();
            // A bare LF is not conformant, but it is what a hand-rolled
            // scanner sends, and treating it as an unfinished line would leave
            // it waiting out HEAD_TIMEOUT for the closed socket this change
            // exists to remove.
            let complete = complete.strip_suffix(b"\r").unwrap_or(complete);

            self.line_start = self.line_start.saturating_add(end).saturating_add(1);
            self.searched = 0;

            if complete.is_empty() {
                if self.begun {
                    self.ended = true;
                }
                // Otherwise: an ignorable empty line before the request line.
                continue;
            }
            if !self.begun {
                // That was the request line, which is not a header: a scanner
                // asking for `/upgrade` must not read as one asking to
                // upgrade.
                self.begun = true;
                continue;
            }
            if is_upgrade_field(complete) {
                self.upgrade = true;
            }
        }

        if self.upgrade {
            Sniff::HandOver
        } else if self.ended {
            Sniff::Answer
        } else {
            Sniff::Wait
        }
    }
}

/// Whether one header line is an `Upgrade` field naming `websocket`.
fn is_upgrade_field(line: &[u8]) -> bool {
    let Some(colon) = line.iter().position(|byte| *byte == b':') else {
        return false;
    };
    let (Some(name), Some(value)) = (line.get(..colon), line.get(colon..)) else {
        return false;
    };
    name.trim_ascii().eq_ignore_ascii_case(b"upgrade")
        && contains_ignore_ascii_case(value, b"websocket")
}

/// A stream that hands back bytes already taken from `inner` before reading any
/// more of it.
///
/// The head has to be consumed to be understood (see [`read_head`]) and
/// `accept_hdr_async` has to see it anyway, so it is given back here. The
/// buffer is dropped the moment it runs out, because what follows is a session
/// that may last hours and has no use for it.
struct Replay<S> {
    prefix: Vec<u8>,
    read: usize,
    inner: S,
}

impl<S> Replay<S> {
    const fn new(prefix: Vec<u8>, inner: S) -> Self {
        Self {
            prefix,
            read: 0,
            inner,
        }
    }
}

impl<S> AsyncRead for Replay<S>
where
    S: AsyncRead + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let pending = this.prefix.get(this.read..).unwrap_or_default();
        if !pending.is_empty() && buf.remaining() > 0 {
            let take = pending.len().min(buf.remaining());
            if let Some(slice) = pending.get(..take) {
                buf.put_slice(slice);
                this.read = this.read.saturating_add(take);
                if this.read >= this.prefix.len() {
                    this.prefix = Vec::new();
                    this.read = 0;
                }
                return Poll::Ready(Ok(()));
            }
        }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<S> AsyncWrite for Replay<S>
where
    S: AsyncWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

/// Read and drop whatever is left of the request, so that closing does not
/// reset the peer.
///
/// See [`LINGER`] for why a refusal that skips this is a refusal the peer never
/// receives. The head has already been consumed; this is the body, if there is
/// one. Bounded in time rather than in bytes: a peer that keeps sending is
/// dropped on the deadline, and every other peer reaches end-of-stream long
/// before it.
async fn discard_body<S>(stream: &mut S)
where
    S: AsyncRead + Unpin,
{
    let mut sink = [0u8; READ_CHUNK];
    // One timeout around the whole loop rather than one per read, so a peer
    // that dribbles a byte at a time cannot renew its own deadline forever.
    let _ = tokio::time::timeout(LINGER, async {
        while let Ok(read) = stream.read(&mut sink).await {
            if read == 0 {
                break;
            }
        }
    })
    .await;
}

/// A case-insensitive substring test that allocates nothing.
///
/// `to_ascii_lowercase` would be one `Vec` per header line of every connection
/// arriving on an unauthenticated port, to answer a question about nine bytes.
fn contains_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
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

    /// The verdict for a whole buffer at once. `read_head` feeds the scan
    /// incrementally instead; `the_verdict_does_not_depend_on_how_the_bytes_are_split`
    /// is what pins the two together.
    fn classify(prefix: &[u8]) -> Sniff {
        HeadScan::default().feed(prefix)
    }

    /// Feed `request` to one scan in chunks of `chunk` bytes, the way
    /// `read_head` does when the peer fragments it.
    fn classify_in_chunks(request: &[u8], chunk: usize) -> Sniff {
        let mut scan = HeadScan::default();
        let mut buffer = Vec::new();
        let mut verdict = Sniff::Wait;
        for piece in request.chunks(chunk.max(1)) {
            buffer.extend_from_slice(piece);
            verdict = scan.feed(&buffer);
            if verdict != Sniff::Wait {
                return verdict;
            }
        }
        verdict
    }

    #[test]
    fn the_verdict_does_not_depend_on_how_the_bytes_are_split() {
        // The property the whole design turns on, and the one the first two
        // attempts did not have: the answer is a function of the REQUEST, not
        // of the TCP segments it arrived in. The peer chooses the boundaries,
        // so anything that varies with them is attacker-controlled.
        //
        // This also covers the incremental scan's cursors: byte-at-a-time is
        // the worst case for them, and it must agree with one-shot exactly.
        let handshake_with_pad = format!("\r\n{HANDSHAKE}");
        for request in [
            "GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n",
            "GET /favicon.ico HTTP/1.1\r\nHost: x\r\nCookie: aaaaaaaaaaaaaaaa\r\n\r\n",
            "GET / HTTP/1.1\nHost: x\n\n",
            HANDSHAKE,
            handshake_with_pad.as_str(),
        ] {
            let whole = classify(request.as_bytes());
            for chunk in [1usize, 2, 3, 7, 64, 4096] {
                assert_eq!(
                    classify_in_chunks(request.as_bytes(), chunk),
                    whole,
                    "{request:?} split {chunk} at a time disagreed with one shot"
                );
            }
        }
    }

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

        // RFC 9112 §6.3 forbids a body on a response to HEAD, and this
        // listener does not parse the method — so the only way the answer can
        // be legal for every request is for it to have no body at all. An
        // empty body is also the furthest "says nothing" can be taken.
        assert_eq!(body, "", "the refusal grew a body");
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
    }

    #[test]
    fn a_plain_request_is_answered() {
        // Exactly the traffic that was turning into 502s.
        assert_eq!(
            classify(b"GET / HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n"),
            Sniff::Answer
        );
        assert_eq!(
            classify(b"GET /favicon.ico HTTP/1.1\r\nHost: relay.free2z.cash\r\n\r\n"),
            Sniff::Answer
        );
        assert_eq!(classify(b"GET /.env HTTP/1.0\r\n\r\n"), Sniff::Answer);

        // The request TARGET is not a header. `/websocket` and `/upgrade` are
        // scanner paths, not an intention to upgrade, and a substring search
        // over the whole head would get both of these wrong.
        assert_eq!(
            classify(b"GET /websocket HTTP/1.1\r\nHost: x\r\n\r\n"),
            Sniff::Answer
        );
        assert_eq!(
            classify(b"GET /upgrade HTTP/1.1\r\nHost: x\r\n\r\n"),
            Sniff::Answer
        );
    }

    #[test]
    fn a_binary_body_does_not_hide_a_perfectly_good_head() {
        // Codex finding #2 on this change. Requiring the WHOLE prefix to be
        // UTF-8 made the verdict depend on the BODY, and therefore on whether
        // the body happened to arrive in the same segment as the head: the
        // same request got a 426 or a closed socket depending on packet
        // timing. The terminator is found in bytes and only the head is text.
        let mut request = b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1\r\n\r\n".to_vec();
        request.push(0xff);
        assert_eq!(classify(&request), Sniff::Answer);
    }

    #[test]
    fn a_handshake_is_handed_over_and_never_answered() {
        // The regression that would matter most: a 426 written over a real
        // client's handshake breaks the relay for everyone who can use it.
        assert_eq!(classify(HANDSHAKE.as_bytes()), Sniff::HandOver);

        // Field names and values are case-insensitive, and clients genuinely
        // differ — `Upgrade: WebSocket` is the spelling in RFC 6455's own
        // example, and `UPGRADE:` is legal too.
        assert_eq!(
            classify(b"GET /relay/v1 HTTP/1.1\r\nUPGRADE: WebSocket\r\n\r\n"),
            Sniff::HandOver
        );
        // A header value may carry more than one token.
        assert_eq!(
            classify(b"GET /relay/v1 HTTP/1.1\r\nUpgrade: h2c, websocket\r\n\r\n"),
            Sniff::HandOver
        );
    }

    #[test]
    fn a_handshake_is_recognised_before_its_head_is_complete() {
        // A client never waits on this. As soon as the upgrade request is
        // visible the stream is handed over, even though the head has not
        // ended — otherwise a fragmented handshake would wait
        // for the end of its own head for nothing.
        let partial = b"GET /relay/v1 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n";
        assert_eq!(classify(partial), Sniff::HandOver);
    }

    #[test]
    fn an_incomplete_head_is_waited_for_rather_than_guessed() {
        // Codex finding #1 on this change. A single look made the fix depend
        // on TCP arrival boundaries: a head split across two segments was
        // handed on and closed silently, which is the original defect. These
        // are `Wait`, not `HandOver` — the caller looks again.
        assert_eq!(classify(b""), Sniff::Wait);
        assert_eq!(classify(b"GET / HTTP/1.1\r\nHost: x\r\n"), Sniff::Wait);
        assert_eq!(classify(b"GE"), Sniff::Wait);

        // And once the rest arrives, it is answered.
        assert_eq!(
            classify(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"),
            Sniff::Answer
        );
    }

    #[test]
    fn something_that_is_not_http_at_all_is_never_answered() {
        // A TLS `ClientHello` that found the plaintext port. It has no head
        // terminator, so it is waited for and then handed on when the budget
        // runs out — never answered in a language it cannot read.
        assert_eq!(classify(&[0x16, 0x03, 0x01, 0xff, 0xfe]), Sniff::Wait);
    }

    #[test]
    fn a_leading_blank_line_does_not_look_like_an_empty_head() {
        // Codex finding, round two. RFC 9112 §2.2 lets a server ignore empty
        // lines before the request line and `httparse` — the parser inside
        // `accept_hdr_async` — does, so a client that prefixes its handshake
        // with a CRLF works TODAY. Reading those first four bytes as a
        // complete, empty head answered it with a 426 and took its relay
        // connectivity away: a regression introduced by the fix, which is
        // strictly worse than the bug.
        let padded = format!("\r\n{HANDSHAKE}");
        assert_eq!(classify(padded.as_bytes()), Sniff::HandOver);

        // And a genuinely empty head, once something follows it, is still a
        // non-upgrade rather than a permanent wait.
        assert_eq!(
            classify(b"\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n"),
            Sniff::Answer
        );
        // Nothing but blank lines is undecided, not an empty request.
        assert_eq!(classify(b"\r\n\r\n"), Sniff::Wait);
    }

    #[test]
    fn a_non_utf8_header_value_does_not_swallow_the_answer() {
        // Also round two. HTTP field values are not required to be UTF-8
        // (RFC 9110 §5.5), so requiring the head to be text meant one opaque
        // byte in an unrelated header dropped the peer back to a closed
        // socket. The scan is bytes now.
        let mut request = b"GET / HTTP/1.1\r\nHost: x\r\nX-Junk: ".to_vec();
        request.push(0xff);
        request.extend_from_slice(b"\r\n\r\n");
        assert_eq!(classify(&request), Sniff::Answer);

        // And the same byte must not hide a real upgrade request either.
        let mut upgrade = b"GET /relay/v1 HTTP/1.1\r\nX-Junk: ".to_vec();
        upgrade.push(0xff);
        upgrade.extend_from_slice(b"\r\nUpgrade: websocket\r\n\r\n");
        assert_eq!(classify(&upgrade), Sniff::HandOver);
    }

    #[test]
    fn a_bare_lf_request_is_answered_rather_than_waited_out() {
        // Not conformant, but it is what a hand-rolled scanner sends. Treating
        // it as an unfinished head would make it wait out HEAD_TIMEOUT to be
        // given the closed socket this change exists to remove.
        assert_eq!(classify(b"GET / HTTP/1.1\nHost: x\n\n"), Sniff::Answer);
        // And bare LF must not hide an upgrade request.
        assert_eq!(
            classify(b"GET /relay/v1 HTTP/1.1\nUpgrade: websocket\n\n"),
            Sniff::HandOver
        );
    }

    #[tokio::test]
    async fn the_replayed_prefix_is_handed_back_before_the_socket() {
        // `Replay` is the only genuinely new machinery on the SUCCESS path, so
        // it gets its own assertion rather than being trusted because the
        // handshake test passes. Everything read while deciding must come back
        // in order, followed by whatever the socket produces next.
        let (mut client, server) = tokio::io::duplex(64);
        let mut replay = Replay::new(b"HEAD-".to_vec(), server);

        tokio::io::AsyncWriteExt::write_all(&mut client, b"TAIL")
            .await
            .unwrap();
        tokio::io::AsyncWriteExt::shutdown(&mut client)
            .await
            .unwrap();

        let mut whole = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut replay, &mut whole)
            .await
            .unwrap();
        assert_eq!(whole, b"HEAD-TAIL");
        // The buffer is released once drained: a session may last hours.
        assert!(replay.prefix.is_empty());
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
        // the 400 case, so it must reach `check_upgrade` rather than being
        // answered here.
        let wrong_path = HANDSHAKE.replace("/relay/v1", "/nope");
        assert_eq!(classify(wrong_path.as_bytes()), Sniff::HandOver);
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
            upgrade_or_answer(&mut stream).await.is_none()
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
        assert!(response.ends_with("\r\n\r\n"), "a body reached the wire");
    }
}
