//! One connection, from accept to close (§2.4, §2.5, §1.3).
//!
//! # Why the writer is a separate task
//!
//! §4.3 says a relay *"MAY complete a cheap `PING` before an expensive `READ`
//! issued earlier, and will"*, and §6.4 lets a push arrive at any moment. A loop
//! that read a frame and wrote its answer before reading again could do neither:
//! a push would have to wait for the next request, and a slow `APPEND` would
//! hold up every response behind it. So frames leave through a bounded channel
//! that one writer task drains, and the read loop never blocks on the socket's
//! write half.
//!
//! The channel is **bounded** on purpose. §13.1 subjects a subscriber that
//! cannot keep up to backpressure "not to unbounded server-side buffering"; a
//! full channel drops the *push* ([`crate::subscriptions`]) and never the
//! message, which is still in the queue for the reader's next `READ`.
//!
//! # The two deadlines
//!
//! - §2.5: the time between accept and a valid `HELLO` is capped
//!   (`handshake_timeout_ms`, default 10 000) and the connection closes on
//!   expiry. After `HELLO` there is no read deadline at all, because a
//!   subscribed client on a quiet queue legitimately sends nothing for hours.
//! - §2.4: the relay sends a Ping every `ws_ping_interval_seconds` and closes
//!   after two consecutive missed Pongs. Server-driven rather than
//!   client-driven, because the browser WebSocket API cannot send a Ping frame
//!   at all — a client-side keepalive would be a second mechanism only one of
//!   the two clients has.
//!
//! Both are the only mechanisms that **release** a §13.1 layer 1 connection
//! permit, and until issue #678 both could be deleted with the whole suite
//! green. `tests/connection_deadlines.rs` drives each one over a real socket
//! and asserts the permit goes back.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use crate::abuse::SourceKey;
use crate::engine::Relay;
use crate::outbound::Outbound;
use crate::transport::{CLOSE_GOING_AWAY, Transport, TransportSink, WireMessage};

/// Serve one connection until either end closes.
pub async fn drive(
    relay: Arc<Relay>,
    transport: Transport,
    binding: f2z_codec::types::ChannelBinding,
    source: SourceKey,
    mut shutdown: watch::Receiver<bool>,
) {
    let (sink, mut stream) = transport.split();
    let capacity = usize::try_from(relay.config().limits.max_outbound_queue).unwrap_or(256);
    let (outbound_tx, outbound_rx) = mpsc::channel::<Outbound>(capacity.max(1));
    let (closed_tx, mut closed_rx) = watch::channel(false);

    let mut connection = relay.open_connection(outbound_tx.clone(), binding, source);
    let writer = tokio::spawn(writer_task(sink, outbound_rx, closed_tx));

    let handshake_timeout =
        Duration::from_millis(u64::from(relay.config().listen.handshake_timeout_ms));
    let ping_interval = Duration::from_secs(u64::from(
        relay.config().listen.ping_interval_seconds.max(1),
    ));
    let missed_pongs_before_close = relay.config().listen.missed_pongs_before_close;
    let mut missed_pongs = 0u32;
    let mut ping = tokio::time::interval(ping_interval);
    // An `interval`'s first tick fires immediately; a Ping before the client has
    // even said HELLO is noise, not keepalive.
    ping.tick().await;

    loop {
        let waiting_for_hello = !connection.hello_done;
        let received = tokio::select! {
            biased;
            _ = closed_rx.changed() => break,
            _ = shutdown.changed() => {
                let _ = outbound_tx.send(Outbound::close(CLOSE_GOING_AWAY)).await;
                break;
            }
            _ = ping.tick(), if !waiting_for_hello => {
                missed_pongs = missed_pongs.saturating_add(1);
                if missed_pongs > missed_pongs_before_close {
                    let _ = outbound_tx.send(Outbound::close(CLOSE_GOING_AWAY)).await;
                    break;
                }
                if outbound_tx.send(Outbound::ping()).await.is_err() {
                    break;
                }
                continue;
            }
            message = read_with_deadline(&mut stream, waiting_for_hello, handshake_timeout) => message,
        };

        let message = match received {
            Ok(Some(message)) => message,
            // End of stream, a transport error, or §2.5's handshake deadline.
            Ok(None) | Err(()) => break,
        };

        match message {
            WireMessage::Binary(bytes) => {
                let now = crate::now_ms();
                let mut broken = false;
                for outbound in relay.handle_binary(&mut connection, now, &bytes).await {
                    if outbound_tx.send(outbound).await.is_err() {
                        broken = true;
                        break;
                    }
                }
                if broken {
                    break;
                }
            }
            WireMessage::Text => {
                // §4.2, and nothing else: no decode attempt, no UTF-8
                // validation of our own, no treating it as an accidental binary
                // frame. The transport does not even hand the bytes over.
                for outbound in Relay::handle_text() {
                    let _ = outbound_tx.send(outbound).await;
                }
                break;
            }
            WireMessage::Ping(payload) => {
                let _ = outbound_tx.send(Outbound::pong(payload)).await;
            }
            WireMessage::Pong(_) => missed_pongs = 0,
            WireMessage::Close(_) => break,
        }
    }

    relay.close_connection(&connection);
    // Both senders, or the writer never ends. `Connection` carries its own
    // clone of `outbound_tx` (`Connection::pushes`, which is what a subscription
    // and a spawned `APPEND` are handed), so dropping only the local one leaves
    // `outbound.recv()` with a live sender and it parks forever. The writer then
    // never returns, `writer.await` never returns, `drive` never returns — and
    // the §13.1 layer 1 permit the listener drops after `drive` is never
    // released. That is invisible on every path that ends by *sending* a close
    // (§1.3's fatal errors, §4.2's text frame, §2.4's keepalive close), because
    // the frame itself wakes the writer; it is the whole story on every path
    // that ends in silence — §2.5's handshake deadline, a client hanging up, a
    // transport error. Dropping the connection here rather than at the end of
    // scope also keeps §1.3's ordering: a task still answering an `APPEND` holds
    // its own clone, so its response is written before the writer sees `None`.
    drop(connection);
    drop(outbound_tx);
    let _ = writer.await;
}

async fn read_with_deadline(
    stream: &mut Box<dyn crate::transport::TransportStream>,
    waiting_for_hello: bool,
    timeout: Duration,
) -> Result<Option<WireMessage>, ()> {
    let read = stream.recv();
    if waiting_for_hello {
        match tokio::time::timeout(timeout, read).await {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(_)) | Err(_) => Err(()),
        }
    } else {
        read.await.map_err(|_| ())
    }
}

/// The only place frames are put on the wire.
///
/// §1.3's "send the response, then close" is this function's `close_after`
/// branch, and it is the only close path for a fatal error — so the ordering
/// cannot be got wrong in one command handler and right in another.
async fn writer_task(
    mut sink: Box<dyn TransportSink>,
    mut outbound: mpsc::Receiver<Outbound>,
    closed: watch::Sender<bool>,
) {
    while let Some(frame) = outbound.recv().await {
        if let Some(message) = frame.message
            && sink.send(message).await.is_err()
        {
            break;
        }
        if let Some(status) = frame.close_after {
            let _ = sink.close(status).await;
            let _ = closed.send(true);
            return;
        }
    }
    let _ = sink.close(crate::transport::CLOSE_NORMAL).await;
    let _ = closed.send(true);
}
