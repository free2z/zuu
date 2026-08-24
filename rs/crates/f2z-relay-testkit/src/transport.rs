//! The one seam between "a relay" and "how its bytes travel".
//!
//! `WIRE.md` §2.1 admits exactly one transport, and §2.2 gives the reason: a
//! second transport is a second parser and a second fuzz target. This crate
//! does not add one. What it adds is a *seam*, so that the identical relay can
//! be driven either over a real WebSocket or over an in-memory pipe.
//!
//! # Why both, and why they must be the same code
//!
//! An in-process transport is fast, deterministic and has no sockets, which
//! makes it the right thing for a unit test. It is also a liar: it cannot
//! reorder, cannot fragment, cannot drop a connection at a TCP boundary, and
//! cannot tell you that your frame writer forgot to set the binary opcode. A
//! client that only ever runs against it will ship framing bugs.
//!
//! So [`crate::FakeRelay`] serves both, and both go through
//! [`crate::connection::drive`] — one function, one engine, one set of rules. If
//! the two ever diverge the fake is lying about the thing it exists to prove,
//! which is why `tests/conformance.rs` runs the whole vector suite twice and
//! compares the verdicts rather than trusting that they agree.
//!
//! # The in-process framing is not protocol
//!
//! A WebSocket message is self-delimiting and typed; a byte pipe is neither. So
//! [`duplex`] frames each message as `opcode || length || payload`, mirroring
//! RFC 6455's opcodes closely enough that §4.2's "a text frame is a fatal
//! `ERR_FRAME_TYPE`" is reachable in-process. **This framing exists nowhere in
//! `WIRE.md` and no client should implement it.** It is the moral equivalent of
//! a test double's constructor.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::future::BoxFuture;
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _};

/// One protocol unit as it crosses the seam.
///
/// The variants are RFC 6455's, restricted to what `WIRE.md` uses: §4.1's
/// binary frames, §4.2's rejected text frames, and §2.4's server-driven
/// keepalive.
#[derive(Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum WireMessage {
    /// A relay frame (§4.1). The only kind that carries protocol.
    Binary(Vec<u8>),
    /// A text frame. §4.2: fatal `ERR_FRAME_TYPE`, close with status 1003. The
    /// relay MUST NOT try to decode it, and this crate MUST be able to send
    /// one, or that rule is untested.
    Text(Vec<u8>),
    /// §2.4's server-side Ping. A browser cannot send one, which is why the
    /// relay drives the keepalive.
    Ping(Vec<u8>),
    /// The answer to a Ping. Clients MUST send it; the browser runtime does.
    Pong(Vec<u8>),
    /// A close, carrying RFC 6455's status code.
    Close(u16),
}

// A binary message is a whole relay frame — an `APPEND` payload included — and
// a derived `Debug` would render it as a list of decimal integers. 1 KiB of
// ciphertext becomes 5 KiB of log, written by the operator, at rest, for as
// long as rotation keeps it. The length is public; the bytes are not.
impl std::fmt::Debug for WireMessage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Binary(bytes) => write!(f, "Binary(<redacted; {} bytes>)", bytes.len()),
            Self::Text(bytes) => write!(f, "Text(<redacted; {} bytes>)", bytes.len()),
            Self::Ping(bytes) => write!(f, "Ping(<{} bytes>)", bytes.len()),
            Self::Pong(bytes) => write!(f, "Pong(<{} bytes>)", bytes.len()),
            Self::Close(code) => write!(f, "Close({code})"),
        }
    }
}

impl WireMessage {
    /// The relay-frame bytes, if this is one.
    #[must_use]
    pub fn binary(&self) -> Option<&[u8]> {
        match self {
            Self::Binary(bytes) => Some(bytes),
            _ => None,
        }
    }

    /// The RFC 6455 opcode, as the in-process framing writes it.
    #[must_use]
    pub const fn opcode(&self) -> u8 {
        match self {
            Self::Text(_) => 0x1,
            Self::Binary(_) => 0x2,
            Self::Close(_) => 0x8,
            Self::Ping(_) => 0x9,
            Self::Pong(_) => 0xa,
        }
    }
}

/// The write half of a connection.
///
/// Object-safe rather than `async fn` in a trait, because the relay's writer
/// task holds one behind a `Box<dyn …>` and must not care which transport it
/// got.
pub trait TransportSink: Send {
    /// Write one message.
    fn send(&mut self, message: WireMessage) -> BoxFuture<'_, io::Result<()>>;

    /// Close the connection with an RFC 6455 status code.
    fn close(&mut self, code: u16) -> BoxFuture<'_, io::Result<()>>;
}

/// The read half of a connection.
pub trait TransportStream: Send {
    /// Read the next message, or `None` at end of stream.
    fn recv(&mut self) -> BoxFuture<'_, io::Result<Option<WireMessage>>>;
}

/// A connection, split so a writer task and a reader loop can hold one half
/// each.
pub struct Transport {
    /// The write half.
    pub sink: Box<dyn TransportSink>,
    /// The read half.
    pub stream: Box<dyn TransportStream>,
}

impl Transport {
    /// Pair a sink and a stream.
    #[must_use]
    pub fn new(sink: Box<dyn TransportSink>, stream: Box<dyn TransportStream>) -> Self {
        Self { sink, stream }
    }

    /// Split into the two halves.
    #[must_use]
    pub fn split(self) -> (Box<dyn TransportSink>, Box<dyn TransportStream>) {
        (self.sink, self.stream)
    }
}

impl std::fmt::Debug for Transport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Transport { .. }")
    }
}

// ---------------------------------------------------------------------------
// The in-process framing.
// ---------------------------------------------------------------------------

/// The in-process frame header: one opcode byte, then a big-endian `u32`
/// length. Testkit-only; see the module note.
const HEADER_LEN: usize = 5;

/// The largest in-process message, so a corrupt length prefix cannot ask for an
/// unbounded allocation. Well above §4.1's 1 MiB default `max_frame_bytes`, so
/// the relay's own limit is what a test observes rather than this one.
const MAX_IN_PROCESS_MESSAGE: usize = 16 * 1024 * 1024;

/// The write half of an in-process connection.
pub struct DuplexSink<W> {
    writer: W,
}

impl<W: AsyncWrite + Unpin + Send> DuplexSink<W> {
    /// Wrap a writer.
    pub const fn new(writer: W) -> Self {
        Self { writer }
    }

    async fn write_message(&mut self, message: WireMessage) -> io::Result<()> {
        let (opcode, payload) = match message {
            WireMessage::Binary(bytes) => (0x2u8, bytes),
            WireMessage::Text(bytes) => (0x1, bytes),
            WireMessage::Ping(bytes) => (0x9, bytes),
            WireMessage::Pong(bytes) => (0xa, bytes),
            WireMessage::Close(code) => (0x8, code.to_be_bytes().to_vec()),
        };
        let len = u32::try_from(payload.len())
            .map_err(|_| io::Error::other("message longer than the in-process framing allows"))?;
        let mut header = [0u8; HEADER_LEN];
        if let Some(first) = header.first_mut() {
            *first = opcode;
        }
        if let Some(slot) = header.get_mut(1..HEADER_LEN) {
            slot.copy_from_slice(&len.to_be_bytes());
        }
        self.writer.write_all(&header).await?;
        self.writer.write_all(&payload).await?;
        self.writer.flush().await
    }
}

impl<W: AsyncWrite + Unpin + Send> TransportSink for DuplexSink<W> {
    fn send(&mut self, message: WireMessage) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(self.write_message(message))
    }

    fn close(&mut self, code: u16) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            // A best-effort close frame, then a real shutdown. The frame is
            // what carries §4.2's status 1003; the shutdown is what makes the
            // peer's read return `None`.
            let _ = self.write_message(WireMessage::Close(code)).await;
            self.writer.shutdown().await
        })
    }
}

/// The read half of an in-process connection.
pub struct DuplexStream<R> {
    reader: R,
}

impl<R: AsyncRead + Unpin + Send> DuplexStream<R> {
    /// Wrap a reader.
    pub const fn new(reader: R) -> Self {
        Self { reader }
    }

    async fn read_message(&mut self) -> io::Result<Option<WireMessage>> {
        let mut header = [0u8; HEADER_LEN];
        match self.reader.read_exact(&mut header).await {
            Ok(_) => {}
            Err(error) if is_eof(&error) => return Ok(None),
            Err(error) => return Err(error),
        }
        let opcode = header.first().copied().unwrap_or(0);
        let mut length = [0u8; 4];
        match header.get(1..HEADER_LEN) {
            Some(slice) => length.copy_from_slice(slice),
            None => return Err(io::Error::other("short in-process header")),
        }
        let len = usize::try_from(u32::from_be_bytes(length))
            .map_err(|_| io::Error::other("in-process length does not fit in usize"))?;
        if len > MAX_IN_PROCESS_MESSAGE {
            return Err(io::Error::other("in-process message length is implausible"));
        }
        let mut payload = vec![0u8; len];
        match self.reader.read_exact(&mut payload).await {
            Ok(_) => {}
            Err(error) if is_eof(&error) => return Ok(None),
            Err(error) => return Err(error),
        }
        Ok(Some(match opcode {
            0x1 => WireMessage::Text(payload),
            0x2 => WireMessage::Binary(payload),
            0x8 => {
                let code = payload
                    .get(..2)
                    .and_then(|bytes| <[u8; 2]>::try_from(bytes).ok())
                    .map_or(1000, u16::from_be_bytes);
                WireMessage::Close(code)
            }
            0x9 => WireMessage::Ping(payload),
            0xa => WireMessage::Pong(payload),
            other => {
                return Err(io::Error::other(format!(
                    "unknown in-process opcode {other:#x}"
                )));
            }
        }))
    }
}

impl<R: AsyncRead + Unpin + Send> TransportStream for DuplexStream<R> {
    fn recv(&mut self) -> BoxFuture<'_, io::Result<Option<WireMessage>>> {
        Box::pin(self.read_message())
    }
}

fn is_eof(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
    )
}

/// A bidirectional in-memory pipe: the two ends of one connection.
///
/// `capacity` is the pipe's buffer. It is deliberately generous so a test does
/// not deadlock on backpressure it did not mean to test — a relay writer and a
/// client writer that both block on a full pipe is a bug in the test, not a
/// finding about the protocol.
#[must_use]
pub fn duplex(capacity: usize) -> (Transport, Transport) {
    let (left, right) = tokio::io::duplex(capacity);
    (wrap_duplex(left), wrap_duplex(right))
}

fn wrap_duplex(stream: tokio::io::DuplexStream) -> Transport {
    let (reader, writer) = tokio::io::split(stream);
    Transport::new(
        Box::new(DuplexSink::new(writer)),
        Box::new(DuplexStream::new(reader)),
    )
}

/// A stream that yields nothing and never ends, for a half that is not used.
pub struct PendingStream;

impl TransportStream for PendingStream {
    fn recv(&mut self) -> BoxFuture<'_, io::Result<Option<WireMessage>>> {
        Box::pin(Pending)
    }
}

struct Pending;

impl std::future::Future for Pending {
    type Output = io::Result<Option<WireMessage>>;

    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_message_kind_round_trips_in_process() {
        let (mut left, mut right) = duplex(64 * 1024);
        let sent = [
            WireMessage::Binary(vec![1, 2, 3]),
            WireMessage::Text(b"not protocol".to_vec()),
            WireMessage::Ping(vec![]),
            WireMessage::Pong(vec![7]),
        ];
        for message in &sent {
            left.sink.send(message.clone()).await.unwrap();
        }
        for message in &sent {
            assert_eq!(right.stream.recv().await.unwrap(), Some(message.clone()));
        }
    }

    #[tokio::test]
    async fn a_closed_peer_reads_as_end_of_stream() {
        let (mut left, mut right) = duplex(1024);
        left.sink.send(WireMessage::Binary(vec![9])).await.unwrap();
        left.sink.close(1000).await.unwrap();
        assert_eq!(
            right.stream.recv().await.unwrap(),
            Some(WireMessage::Binary(vec![9]))
        );
        assert_eq!(
            right.stream.recv().await.unwrap(),
            Some(WireMessage::Close(1000))
        );
        assert_eq!(right.stream.recv().await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_large_frame_survives_the_pipe_buffer() {
        // The relay's own `max_frame_bytes` must be what refuses an oversize
        // frame (§4.1), not the harness's pipe.
        let (mut left, mut right) = duplex(8 * 1024);
        let big = WireMessage::Binary(vec![0u8; 512 * 1024]);
        let writer = tokio::spawn(async move { left.sink.send(big).await });
        let received = right.stream.recv().await.unwrap();
        writer.await.unwrap().unwrap();
        assert_eq!(
            received.and_then(|m| m.binary().map(<[u8]>::len)),
            Some(524_288)
        );
    }
}
