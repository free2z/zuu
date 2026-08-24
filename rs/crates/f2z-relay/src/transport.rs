//! The one transport (§2.1), over plaintext TCP or over TLS 1.3.
//!
//! §2.2 admits exactly one transport and gives the reason: *"a second transport
//! is a second parser and a second fuzz target."* So there is one WebSocket
//! implementation here and one framing, and the only thing that varies is
//! whether the bytes underneath it went through `rustls`.
//!
//! The seam is a pair of boxed traits rather than a generic parameter, because
//! the connection loop must not be duplicated per stream type: a monomorphized
//! `drive::<TcpStream>` and `drive::<TlsStream<TcpStream>>` are two copies of
//! the code that decides when to close a connection, and they would be two
//! copies that can drift.
//!
//! # What is faithful here
//!
//! §2.1's path (`/relay/v1`), the mandatory `free2z-relay.v1` subprotocol in
//! both directions, binary versus text framing, §2.4's Ping/Pong, and the close
//! codes of §1.3 and §4.2.

use std::io;

use futures_util::future::BoxFuture;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt as _, StreamExt as _};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};

/// §2.1's path.
pub const RELAY_PATH: &str = "/relay/v1";

/// §2.1's mandatory subprotocol.
///
/// *"A relay that does not echo `free2z-relay.v1` MUST be treated by the client
/// as not speaking this protocol, and the client MUST close rather than
/// guess."*
pub const SUBPROTOCOL: &str = "free2z-relay.v1";

/// RFC 6455 status 1002, "protocol error": every fatal §10 code except §4.2's.
///
/// §1.3 defines a fatal error as "send the response, then close the WebSocket
/// connection" and names no status. 1002 is the reading used here, and it is an
/// ambiguity call — the same one `f2z-relay-testkit` made, so the two agree.
pub const CLOSE_PROTOCOL_ERROR: u16 = 1002;

/// RFC 6455 status 1003, "unsupported data": §4.2's text frame, which the
/// specification does name.
pub const CLOSE_UNSUPPORTED_DATA: u16 = 1003;

/// RFC 6455 status 1000.
pub const CLOSE_NORMAL: u16 = 1000;

/// RFC 6455 status 1001, "going away": a clean shutdown.
pub const CLOSE_GOING_AWAY: u16 = 1001;

/// One protocol unit, as it crosses the seam.
#[derive(Clone, PartialEq, Eq)]
pub enum WireMessage {
    /// A relay frame (§4.1) — the only kind that carries protocol.
    Binary(Vec<u8>),
    /// §4.2: a fatal `ERR_FRAME_TYPE` and a close with status 1003.
    Text,
    /// §2.4's server-driven Ping.
    Ping(Vec<u8>),
    /// A Pong, whether ours or the client's.
    Pong(Vec<u8>),
    /// A close, with its RFC 6455 status.
    Close(u16),
}

// A binary message is a whole frame — an APPEND payload included — and a
// derived `Debug` would render it as a list of decimal integers. See
// `crate::log` for why decimal is the trap and hex is not the check.
impl core::fmt::Debug for WireMessage {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Binary(bytes) => write!(f, "Binary(<redacted; {} bytes>)", bytes.len()),
            Self::Text => f.write_str("Text"),
            Self::Ping(bytes) => write!(f, "Ping(<{} bytes>)", bytes.len()),
            Self::Pong(bytes) => write!(f, "Pong(<{} bytes>)", bytes.len()),
            Self::Close(code) => write!(f, "Close({code})"),
        }
    }
}

/// The write half.
pub trait TransportSink: Send {
    /// Write one message.
    fn send(&mut self, message: WireMessage) -> BoxFuture<'_, io::Result<()>>;
    /// Close with an RFC 6455 status.
    fn close(&mut self, code: u16) -> BoxFuture<'_, io::Result<()>>;
}

/// The read half.
pub trait TransportStream: Send {
    /// The next message, or `None` at end of stream.
    fn recv(&mut self) -> BoxFuture<'_, io::Result<Option<WireMessage>>>;
}

/// A connection, split so a writer task and a reader loop hold one half each.
pub struct Transport {
    /// The write half.
    pub sink: Box<dyn TransportSink>,
    /// The read half.
    pub stream: Box<dyn TransportStream>,
}

impl core::fmt::Debug for Transport {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Transport { .. }")
    }
}

impl Transport {
    /// Split into the two halves.
    #[must_use]
    pub fn split(self) -> (Box<dyn TransportSink>, Box<dyn TransportStream>) {
        (self.sink, self.stream)
    }
}

struct WsSink<S> {
    inner: SplitSink<WebSocketStream<S>, Message>,
}

impl<S> WsSink<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    async fn write(&mut self, message: WireMessage) -> io::Result<()> {
        let message = match message {
            WireMessage::Binary(bytes) => Message::Binary(Bytes::from(bytes)),
            // A relay never sends a text frame. §4.2 is a rule about what it
            // receives, and the absence of a construction here is what makes
            // the rule symmetrical.
            WireMessage::Text => return Ok(()),
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
    fn send(&mut self, message: WireMessage) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(self.write(message))
    }

    fn close(&mut self, code: u16) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            let _ = self.write(WireMessage::Close(code)).await;
            self.inner.close().await.map_err(io::Error::other)
        })
    }
}

struct WsStream<S> {
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
                // §4.2: the relay MUST NOT attempt to decode it and MUST NOT
                // attempt UTF-8 validation of its own. Dropping the payload
                // here rather than carrying it is that rule as an absence.
                Message::Text(_) => WireMessage::Text,
                Message::Ping(bytes) => WireMessage::Ping(bytes.to_vec()),
                Message::Pong(bytes) => WireMessage::Pong(bytes.to_vec()),
                Message::Close(frame) => {
                    WireMessage::Close(frame.map_or(CLOSE_NORMAL, |frame| frame.code.into()))
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
    fn recv(&mut self) -> BoxFuture<'_, io::Result<Option<WireMessage>>> {
        Box::pin(self.read())
    }
}

/// Wrap a negotiated WebSocket as a [`Transport`].
pub fn wrap<S>(socket: WebSocketStream<S>) -> Transport
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (sink, stream) = socket.split();
    Transport {
        sink: Box::new(WsSink { inner: sink }),
        stream: Box::new(WsStream { inner: stream }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binary_message_never_renders_its_bytes() {
        let message = WireMessage::Binary(vec![0xde, 0xad, 0xbe, 0xef]);
        let rendered = format!("{message:?}");
        assert_eq!(rendered, "Binary(<redacted; 4 bytes>)");
        assert!(!rendered.contains("222"));
        assert!(!rendered.contains("de"));
    }

    #[test]
    fn a_text_frame_carries_nothing_into_the_relay() {
        // §4.2's "MUST NOT attempt to decode it", as a type: there is no
        // payload on the variant to decode.
        assert_eq!(format!("{:?}", WireMessage::Text), "Text");
    }

    #[test]
    fn the_close_codes_are_the_ones_the_sections_name() {
        assert_eq!(CLOSE_UNSUPPORTED_DATA, 1003);
        assert_eq!(CLOSE_PROTOCOL_ERROR, 1002);
        assert_eq!(CLOSE_NORMAL, 1000);
        assert_eq!(CLOSE_GOING_AWAY, 1001);
    }
}
