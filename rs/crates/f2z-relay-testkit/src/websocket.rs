//! The real transport — `WIRE.md` §2.1 — minus the TLS.
//!
//! # Why a real socket exists at all
//!
//! An in-process transport cannot fragment, cannot reorder at a TCP boundary,
//! cannot half-close, and cannot tell a client that it forgot to set the binary
//! opcode. Every one of those is a bug a client can ship. So the same relay is
//! served over a real `ws://127.0.0.1:0` listener and the conformance suite is
//! run against both, which is the only way to know the fast path is not lying.
//!
//! # `ws://`, not `wss://`, and that is published
//!
//! §2.1 admits `wss://` only. A test double that terminated TLS would need a
//! certificate, a trust decision, and a story about what the client should do
//! with a self-signed one — and it would still not be able to compute the §5.3
//! exporter through the abstraction this crate uses. So it serves `ws://` and
//! takes §2.3's `--insecure-listen` path honestly: `transport_security: none`,
//! `channel_binding_mode: none`, both in the signed capability document, and a
//! client that must explicitly opt in.
//!
//! §2.3's binding rule is enforced rather than described: [`bind`] refuses a
//! non-loopback address unless the caller passes `insecure_listen`, and
//! `f2z-fakerelay` makes the operator type the flag.
//!
//! # What *is* faithful here
//!
//! The path (`/relay/v1`), the mandatory subprotocol (`free2z-relay.v1`) in
//! both directions, binary versus text framing, Ping/Pong, and close codes. A
//! client that gets any of those wrong fails against this listener, which is
//! the point.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse, Request as HandshakeRequest, Response as HandshakeResponse,
};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::engine::Relay;
use crate::error::{Result, TestkitError};
use crate::transport::{Transport, TransportSink, TransportStream, WireMessage};

/// §2.1's path.
pub const RELAY_PATH: &str = "/relay/v1";

/// §2.1's mandatory subprotocol, in both directions. "A relay that does not
/// echo `free2z-relay.v1` MUST be treated by the client as not speaking this
/// protocol, and the client MUST close rather than guess."
pub const SUBPROTOCOL: &str = "free2z-relay.v1";

const HEADER_SUBPROTOCOL: &str = "sec-websocket-protocol";

// ---------------------------------------------------------------------------
// The WebSocket half of the transport seam.
// ---------------------------------------------------------------------------

/// A WebSocket write half.
pub struct WsSink<S> {
    inner: SplitSink<WebSocketStream<S>, Message>,
}

impl<S> WsSink<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    async fn write(&mut self, message: WireMessage) -> io::Result<()> {
        let message = match message {
            WireMessage::Binary(bytes) => Message::Binary(Bytes::from(bytes)),
            WireMessage::Text(bytes) => Message::Text(
                String::from_utf8(bytes)
                    .map_err(|_| io::Error::other("text frame is not UTF-8"))?
                    .into(),
            ),
            WireMessage::Ping(bytes) => Message::Ping(Bytes::from(bytes)),
            WireMessage::Pong(bytes) => Message::Pong(Bytes::from(bytes)),
            WireMessage::Close(code) => Message::Close(Some(CloseFrame {
                code: CloseCode::from(code),
                reason: String::new().into(),
            })),
        };
        self.inner.send(message).await.map_err(io::Error::other)
    }
}

impl<S> TransportSink for WsSink<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    fn send(
        &mut self,
        message: WireMessage,
    ) -> futures_util::future::BoxFuture<'_, io::Result<()>> {
        Box::pin(self.write(message))
    }

    fn close(&mut self, code: u16) -> futures_util::future::BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            let _ = self.write(WireMessage::Close(code)).await;
            self.inner.close().await.map_err(io::Error::other)
        })
    }
}

/// A WebSocket read half.
pub struct WsStream<S> {
    inner: SplitStream<WebSocketStream<S>>,
}

impl<S> WsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    async fn read(&mut self) -> io::Result<Option<WireMessage>> {
        loop {
            let Some(next) = self.inner.next().await else {
                return Ok(None);
            };
            let message = next.map_err(io::Error::other)?;
            return Ok(Some(match message {
                Message::Binary(bytes) => WireMessage::Binary(bytes.to_vec()),
                Message::Text(text) => WireMessage::Text(text.as_bytes().to_vec()),
                Message::Ping(bytes) => WireMessage::Ping(bytes.to_vec()),
                Message::Pong(bytes) => WireMessage::Pong(bytes.to_vec()),
                Message::Close(frame) => {
                    WireMessage::Close(frame.map_or(1000, |frame| frame.code.into()))
                }
                // A raw frame never surfaces from a `WebSocketStream` in read
                // mode; skip rather than invent a protocol event for it.
                Message::Frame(_) => continue,
            }));
        }
    }
}

impl<S> TransportStream for WsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    fn recv(&mut self) -> futures_util::future::BoxFuture<'_, io::Result<Option<WireMessage>>> {
        Box::pin(self.read())
    }
}

/// Wrap a negotiated WebSocket as a [`Transport`].
pub fn wrap<S>(socket: WebSocketStream<S>) -> Transport
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (sink, stream) = socket.split();
    Transport::new(
        Box::new(WsSink { inner: sink }),
        Box::new(WsStream { inner: stream }),
    )
}

// ---------------------------------------------------------------------------
// The listener.
// ---------------------------------------------------------------------------

/// A running `ws://` listener.
pub struct RelayServer {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for RelayServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelayServer")
            .field("addr", &self.addr)
            .finish()
    }
}

impl RelayServer {
    /// The bound address. With port 0 this is the port the OS chose.
    #[must_use]
    pub const fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The endpoint URL, path included.
    #[must_use]
    pub fn url(&self) -> String {
        format!("ws://{}{RELAY_PATH}", self.addr)
    }

    /// Stop accepting and wait for the accept loop to finish.
    ///
    /// Connections already open are not torn down: a client that is mid-request
    /// when a test ends should see the request finish, not a truncated stream
    /// that looks like a fault it did not arm.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.handle.await;
    }
}

/// Bind a listener, refusing a non-loopback address without an explicit
/// override (§2.3).
///
/// # Errors
///
/// [`TestkitError::Config`] for a non-loopback address without
/// `insecure_listen`, or [`TestkitError::Transport`] if the bind fails.
pub async fn bind(addr: SocketAddr, insecure_listen: bool) -> Result<TcpListener> {
    // §2.3: "A relay MUST refuse to bind a non-loopback address without TLS.
    // This is a startup check, not a warning: the process exits." This process
    // has no TLS at all, so the check is unconditional on the address.
    if !is_loopback(addr.ip()) && !insecure_listen {
        return Err(TestkitError::Config(
            "refusing to bind a non-loopback address without TLS (WIRE.md §2.3); \
             pass --insecure-listen if you really mean it",
        ));
    }
    TcpListener::bind(addr).await.map_err(TestkitError::from)
}

fn is_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Serve `relay` on `listener` until the returned handle is shut down.
///
/// # Errors
///
/// [`TestkitError::Transport`] if the listener cannot report its own address.
pub fn serve(relay: Arc<Relay>, listener: TcpListener) -> Result<RelayServer> {
    let addr = listener.local_addr()?;
    let (shutdown, mut shutdown_rx) = watch::channel(false);
    let handle = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = shutdown_rx.changed() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _peer)) = accepted else {
                break;
            };
            let relay = Arc::clone(&relay);
            tokio::spawn(async move {
                if let Some(transport) = handshake(stream).await {
                    crate::connection::drive(relay, transport).await;
                }
            });
        }
    });
    Ok(RelayServer {
        addr,
        shutdown,
        handle,
    })
}

async fn handshake(stream: TcpStream) -> Option<Transport> {
    let socket = tokio_tungstenite::accept_hdr_async(stream, check_upgrade)
        .await
        .ok()?;
    Some(wrap(socket))
}

/// §2.1's two mandatory properties of the upgrade, enforced.
///
/// The `Err` variant is `tungstenite`'s own `http::Response`, whose size is not
/// ours to change, and this is a handshake callback rather than a hot path: one
/// oversized `Result` per TCP accept costs nothing measurable. Boxing it would
/// mean converting at the one call site `tungstenite` allows, for no benefit.
#[allow(
    clippy::result_large_err,
    reason = "the error type is tungstenite's Callback contract, once per accept"
)]
fn check_upgrade(
    request: &HandshakeRequest,
    mut response: HandshakeResponse,
) -> std::result::Result<HandshakeResponse, ErrorResponse> {
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
    // Echo it. A relay that does not is one the client must refuse.
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

// ---------------------------------------------------------------------------
// The client side.
// ---------------------------------------------------------------------------

/// Open a client connection to a `ws://` or `wss://` relay endpoint.
///
/// Enforces §2.1's client obligation: the relay MUST echo `free2z-relay.v1`,
/// and a client that does not check has no way to tell this protocol from
/// something else answering on the same path.
///
/// # Errors
///
/// [`TestkitError::Transport`] if the URL is unusable, the handshake fails, or
/// the relay did not echo the subprotocol.
pub async fn connect(url: &str) -> Result<Transport> {
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .method("GET")
        .uri(url)
        .header("Host", host_of(url)?)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header(HEADER_SUBPROTOCOL, SUBPROTOCOL)
        .body(())
        .map_err(|error| TestkitError::Transport(error.to_string()))?;

    let (socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| TestkitError::Transport(error.to_string()))?;

    let echoed = response
        .headers()
        .get(HEADER_SUBPROTOCOL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if echoed != SUBPROTOCOL {
        return Err(TestkitError::Transport(format!(
            "the relay did not echo {SUBPROTOCOL}; it is not speaking this protocol (WIRE.md §2.1)"
        )));
    }

    Ok(wrap::<MaybeTlsStream<TcpStream>>(socket))
}

fn generate_key() -> String {
    tokio_tungstenite::tungstenite::handshake::client::generate_key()
}

fn host_of(url: &str) -> Result<String> {
    let rest = url
        .strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))
        .ok_or(TestkitError::Config("a relay URL must be ws:// or wss://"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    if authority.is_empty() {
        return Err(TestkitError::Config("a relay URL must name a host"));
    }
    Ok(authority.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_header_comes_from_the_url() {
        assert_eq!(
            host_of("ws://127.0.0.1:9000/relay/v1").unwrap(),
            "127.0.0.1:9000"
        );
        assert_eq!(
            host_of("wss://relay.example/relay/v1").unwrap(),
            "relay.example"
        );
        assert!(host_of("http://relay.example/relay/v1").is_err());
    }

    #[tokio::test]
    async fn a_non_loopback_bind_is_refused_without_the_override() {
        let addr: SocketAddr = "0.0.0.0:0".parse().unwrap();
        assert!(bind(addr, false).await.is_err());
        // And with the override it is allowed, because §2.3 says an operator
        // may take that path deliberately and publish that they did.
        assert!(bind(addr, true).await.is_ok());
    }
}
