//! One connection, driven identically over a pipe and over a socket.
//!
//! [`drive`] is the only connection loop in this crate. `FakeRelay::connect`
//! hands it one end of a `tokio::io::duplex`; the `ws://` listener hands it a
//! WebSocket. Everything below this line — the handshake deadline of §2.5, the
//! keepalive of §2.4, the fatal-close rule of §1.3, and every fault effect — is
//! written once and therefore cannot differ between the two.
//!
//! # Why the writer is a separate task
//!
//! Three of the fault effects are about *time*, not about content: a delay, a
//! reorder, and a stall. None of them is expressible in a loop that reads a
//! frame and writes its answer before reading again, because the answer to
//! request 2 has to be able to overtake the answer to request 1. §4.3 says a
//! relay "MAY complete a cheap `PING` before an expensive `READ` issued
//! earlier, and will" — so a fake that could not do that would be a fake that
//! quietly promised ordering the protocol denies.
//!
//! The split also makes the in-flight accounting honest. A dropped response is
//! one the relay *sent*, so its `request_id` is released; a stalled response is
//! one the relay never produced, so its id stays outstanding and §4.3's window
//! fills. That distinction is decided in the engine, before the frame reaches
//! the writer, and is the reason [`crate::faults::Effect::Stall`] and
//! [`crate::faults::Effect::Drop`] are two effects rather than one.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use crate::engine::Relay;
use crate::faults::{Effect, FaultInjector};
use crate::outbound::{CLOSE_GOING_AWAY, CLOSE_NORMAL, CLOSE_PROTOCOL_ERROR, OutKind, Outbound};
use crate::transport::{Transport, TransportSink, WireMessage};

/// Serve one connection until either end closes or the server shuts down.
pub async fn drive(
    relay: Arc<Relay>,
    transport: Transport,
    mut server_shutdown: watch::Receiver<bool>,
) {
    let (sink, mut stream) = transport.split();
    let (outbound_tx, outbound_rx) = mpsc::unbounded_channel::<Outbound>();
    let (writer_finished_tx, mut writer_finished_rx) = watch::channel(false);

    let mut connection = relay.open_connection(outbound_tx.clone());
    let faults = relay.faults().clone();
    let writer = tokio::spawn(writer_task(sink, outbound_rx, faults, writer_finished_tx));

    let handshake_timeout = relay.config().handshake_timeout;
    let ping_interval = relay.config().ping_interval;
    let missed_pongs_before_close = relay.config().missed_pongs_before_close;
    let mut missed_pongs = 0u32;
    let mut ping = tokio::time::interval(ping_interval);
    // The first tick of an `interval` fires immediately; a Ping before the
    // client has even said HELLO is noise, not keepalive.
    ping.tick().await;

    loop {
        let waiting_for_hello = !connection.hello_done;
        let received = tokio::select! {
            biased;
            // The writer has already sent any close frame for this path.
            _ = writer_finished_rx.changed() => break,
            // Server shutdown is a different event: production sends 1001
            // before it winds an established connection down, so the test
            // double must make that observable too. This is alignment with
            // production rather than a `WIRE.md` conformance requirement.
            _ = server_shutdown.changed() => {
                let _ = outbound_tx.send(close_now(CLOSE_GOING_AWAY));
                break;
            }
            _ = ping.tick(), if !waiting_for_hello => {
                // §2.4: the relay sends a Ping every `ws_ping_interval_seconds`
                // and closes after two consecutive missed Pongs. Server-driven
                // rather than client-driven because the browser WebSocket API
                // cannot send a Ping frame at all, so a client-side keepalive
                // would be a second mechanism only one of the two clients has.
                missed_pongs = missed_pongs.saturating_add(1);
                if missed_pongs > missed_pongs_before_close {
                    // 1001, "going away", the same status `f2z-relay` sends.
                    // Issue #678: this said 1000 while production said 1001, and
                    // nothing could notice, because the constant did not exist
                    // in this crate.
                    let _ = outbound_tx.send(close_now(CLOSE_GOING_AWAY));
                    break;
                }
                let _ = outbound_tx.send(Outbound::keepalive());
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
                for outbound in relay.handle_binary(&mut connection, &bytes) {
                    if outbound_tx.send(outbound).is_err() {
                        break;
                    }
                }
            }
            WireMessage::Text(_) => {
                // §4.2, and nothing else: no decode attempt, no UTF-8
                // validation of our own, no treating it as an accidental
                // binary frame.
                for outbound in relay.handle_text() {
                    let _ = outbound_tx.send(outbound);
                }
                break;
            }
            WireMessage::Ping(payload) => {
                let _ = outbound_tx.send(pong(payload));
            }
            WireMessage::Pong(_) => {
                missed_pongs = 0;
            }
            WireMessage::Close(_) => break,
        }
    }

    relay.close_connection(&connection);
    // Both senders, or the writer never ends. `Connection` carries its own
    // clone of `outbound_tx` (`Connection::pushes`), so dropping only the local
    // one leaves `outbound.recv()` with a live sender and it parks forever.
    // `f2z-relay`'s loop had the identical shape and the identical bug, found
    // by issue #678's tests: every path that ends in silence rather than in a
    // close frame — §2.5's handshake deadline, a client hanging up, a transport
    // error — leaked its writer task. Fixed in both, because this loop exists
    // to be the same loop.
    drop(connection);
    drop(outbound_tx);
    let _ = writer.await;
}

async fn read_with_deadline(
    stream: &mut Box<dyn crate::transport::TransportStream>,
    waiting_for_hello: bool,
    timeout: Duration,
) -> Result<Option<WireMessage>, ()> {
    // §2.5: "A relay MUST cap the time between TCP accept and a valid `HELLO`
    // (`handshake_timeout_ms`, default 10 000) and close on expiry." The cap
    // applies only until HELLO; after that a subscribed client on a quiet queue
    // legitimately sends nothing for hours, and §2.4's keepalive is what
    // notices a dead one.
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

fn pong(payload: Vec<u8>) -> Outbound {
    Outbound {
        bytes: payload,
        kind: OutKind::Keepalive,
        close_after: None,
    }
}

fn close_now(status: u16) -> Outbound {
    Outbound {
        bytes: Vec::new(),
        kind: OutKind::Response { effect: None },
        close_after: Some(status),
    }
}

/// The writer: the only place frames are actually put on the wire, and the only
/// place delivery faults are applied.
///
/// It is a small scheduler rather than a loop, because a delay that blocked the
/// frames behind it would not be a delay — it would be a stall of the whole
/// connection, and §4.3's "responses may arrive out of order … and will" would
/// be untestable. A delayed frame is parked with a deadline and the writer goes
/// back to serving whatever else is ready.
async fn writer_task(
    mut sink: Box<dyn TransportSink>,
    mut outbound: mpsc::UnboundedReceiver<Outbound>,
    faults: FaultInjector,
    writer_finished: watch::Sender<bool>,
) {
    // §4.3's reordering, as a one-frame hold. Held frames are flushed when the
    // connection ends, so a reorder rule that never sees a second frame
    // degrades to a delay rather than to a silent drop — a fake that lost a
    // frame here would be teaching a client the wrong lesson.
    let mut held: Option<Outbound> = None;
    let mut parked: Vec<(tokio::time::Instant, Outbound)> = Vec::new();
    let mut inbound_open = true;

    loop {
        let due = parked.iter().map(|(deadline, _)| *deadline).min();

        let frame = tokio::select! {
            biased;
            () = wait_until(due) => {
                let Some(index) = earliest(&parked) else { continue };
                if index >= parked.len() {
                    continue;
                }
                let (_, mut frame) = parked.remove(index);
                frame.kind = OutKind::Ready;
                frame
            }
            received = outbound.recv(), if inbound_open => {
                match received {
                    Some(frame) => frame,
                    None => {
                        inbound_open = false;
                        if parked.is_empty() {
                            break;
                        }
                        continue;
                    }
                }
            }
        };

        let effect = match frame.kind {
            OutKind::Response { effect } => effect,
            OutKind::Push { event } => faults.take_push_effect(event),
            // Never faulted: a suppressed keepalive presents as a hung relay
            // rather than as the fault it is. A parked frame has already had
            // its rule applied.
            OutKind::Keepalive | OutKind::Ready => None,
        };

        match effect {
            Some(Effect::Drop | Effect::Stall) => continue,
            Some(Effect::Delay(duration)) => {
                let deadline = tokio::time::Instant::now()
                    .checked_add(duration)
                    // A delay longer than the runtime's clock can express is a
                    // configuration mistake, not a fault worth honouring; the
                    // frame goes out now rather than never.
                    .unwrap_or_else(tokio::time::Instant::now);
                parked.push((deadline, frame));
                continue;
            }
            Some(Effect::Reorder) => {
                if held.is_none() {
                    held = Some(frame);
                    continue;
                }
            }
            Some(Effect::CloseBefore) => {
                let _ = sink.close(CLOSE_PROTOCOL_ERROR).await;
                let _ = writer_finished.send(true);
                return;
            }
            // A refusal never reaches the writer: it was applied in the engine,
            // before the command ran, and arrived here as an ordinary error
            // response.
            Some(Effect::Close | Effect::Refuse(_)) | None => {}
        }

        let closing = frame.close_after;
        let close_after_effect = matches!(effect, Some(Effect::Close));
        if write(&mut sink, frame).await.is_err() {
            break;
        }
        if let Some(waiting) = held.take()
            && write(&mut sink, waiting).await.is_err()
        {
            break;
        }
        if let Some(status) = closing {
            let _ = sink.close(status).await;
            let _ = writer_finished.send(true);
            return;
        }
        if close_after_effect {
            let _ = sink.close(CLOSE_NORMAL).await;
            let _ = writer_finished.send(true);
            return;
        }
        if !inbound_open && parked.is_empty() {
            break;
        }
    }

    if let Some(waiting) = held.take() {
        let _ = write(&mut sink, waiting).await;
    }
    let _ = sink.close(CLOSE_NORMAL).await;
    let _ = writer_finished.send(true);
}

/// Sleep until `deadline`, or forever when there is nothing parked.
async fn wait_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

fn earliest(parked: &[(tokio::time::Instant, Outbound)]) -> Option<usize> {
    let mut best: Option<(usize, tokio::time::Instant)> = None;
    for (index, (deadline, _)) in parked.iter().enumerate() {
        match best {
            Some((_, current)) if current <= *deadline => {}
            _ => best = Some((index, *deadline)),
        }
    }
    best.map(|(index, _)| index)
}

async fn write(sink: &mut Box<dyn TransportSink>, frame: Outbound) -> std::io::Result<()> {
    match frame.kind {
        // A keepalive with an empty body is §2.4's Ping; one with a body is the
        // Pong that answers a client's own Ping.
        OutKind::Keepalive if frame.bytes.is_empty() => {
            sink.send(WireMessage::Ping(Vec::new())).await
        }
        OutKind::Keepalive => sink.send(WireMessage::Pong(frame.bytes)).await,
        // An empty-bodied response is not a frame at all: it is the bare close
        // of a fatal error whose `request_id` could not be recovered (§4.2, and
        // the unreadable-header case of §4.1).
        OutKind::Response { .. } | OutKind::Push { .. } | OutKind::Ready
            if frame.bytes.is_empty() =>
        {
            Ok(())
        }
        OutKind::Response { .. } | OutKind::Push { .. } | OutKind::Ready => {
            sink.send(WireMessage::Binary(frame.bytes)).await
        }
    }
}
