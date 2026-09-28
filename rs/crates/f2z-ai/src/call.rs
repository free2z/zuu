//! A started call: the upstream read and the delivery to the client, kept
//! apart.
//!
//! chat-api.md §2.4 and ADR 0001: **client backpressure never reaches the
//! provider.** So a call is two things that only share a bounded buffer:
//!
//! * **The reader** — a detached task per call (`run`). It reads the
//!   [`Upstream`] at provider speed, to its end, whatever the client is
//!   doing, encodes each event as an SSE frame and pushes it into the call's
//!   delivery buffer. When the upstream ends it hands the call to the settler
//!   with the usage the upstream reported. It never waits for the client.
//! * **The delivery** — the HTTP response body ([`DeliveryBody`]). It pops
//!   frames from the buffer as fast as the client takes them. It is the only
//!   thing a slow or vanished client affects.
//!
//! The buffer is bounded (`delivery_buffer_bytes`, 256 KiB of event payload).
//! Two things end **delivery** early while the read and the settlement carry
//! on unchanged: the buffer filling, and `delivery_stall_secs` (30 s) with
//! frames waiting and none taken. Both replace whatever is buffered with one
//! best-effort `error` event — `code: "delivery_aborted"`,
//! `settlement: "pending"` — and end the body, with the connection told to
//! close once that response is flushed, so it is never reused for another
//! request (chat-api.md §2.4: "then closes the connection"). If the client is
//! not reading even that, one stall period after the abort the connection is
//! dropped ([`crate::serve::ConnectionKill`]): a
//! client that is not reading would otherwise hold its socket, and the bytes
//! queued in it, for as long as it liked — a body nobody polls cannot end
//! itself.
//! A client that disconnects ends delivery the same way minus the event. None
//! of these touches the upstream.
//!
//! # What a call holds, and until when
//!
//! The call's concurrency slot is shared by the settlement and the delivery,
//! and is released when **both** are over: the settle has returned *and*
//! delivery has ended (delivered, client gone, aborted and its connection
//! dropped, or cut). The first half is chat-api.md §2.4's "a drained call still counts
//! until it settles"; the second keeps a slow reader's buffer and socket
//! inside `max_concurrent_calls` too, instead of outliving its slot.
//!
//! # Settlement ownership starts before `start`
//!
//! The settle guard exists before the backend's `start` runs, so a call is
//! handed to the settler exactly once even if `start` fails, times out, or is
//! cancelled by a drain — as [`UpstreamEnd::NotStarted`]. A Wave 2 backend
//! takes its hold inside `start`; the settler can then always release it.
//!
//! **Drain.** Calls keep reading their upstream through the drain window. At
//! the window's end the gateway aborts the rest: the reader stops, the body
//! is **cut** (it fails, so the client sees a truncated stream rather than one
//! that looks complete), and the call reaches the settler as
//! [`UpstreamEnd::Drained`].
//!
//! The `delivery_aborted` frame is `f2z_ai_proto`'s own
//! [`ErrorCode::DeliveryAborted`] with `settlement: pending` and no amounts.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use f2z_ai_proto::chat::ChatRequest;
use f2z_ai_proto::event::ErrorEvent;
use f2z_ai_proto::settlement::Settlement;
use f2z_ai_proto::{ErrorCode, Event};
use http_body::Frame;
use tokio::sync::oneshot;

use crate::admission::{CallHandle, InFlight, Slot};
use crate::catalog::VerifiedCatalog;
use crate::chat::ChatBackend;
use crate::error::ApiFailure;
use crate::serve::ConnectionKill;
use crate::settle::{self, CallRecord, Delivery, UpstreamEnd};

/// A started provider stream, as unified events.
///
/// Wave 2's adapters implement this over a provider's stream. The reader
/// calls [`Upstream::next`] in a loop until it returns `None`; it must return
/// `None` once the provider's stream has ended (after its usage frame, if it
/// sends one). Dropping an `Upstream` must abort the provider request — the
/// reader only drops one early when a drain aborts the call.
///
/// **`next` must be cancel-safe.** The reader polls it in a `select!` beside
/// the stall tick and the drain signal, so a `next` future is dropped
/// whenever one of those fires first — every 250 ms on a quiet stream. An
/// implementation keeps its in-flight request and its deadlines on `self`,
/// never in the future (`crate::provider::upstream`).
#[async_trait]
pub trait Upstream: Send + 'static {
    /// An idempotent replay is a JSON receipt, with no provider stream.
    fn replay_record(&self) -> Option<serde_json::Value> {
        None
    }
    /// Durable call ID for the response header.
    fn call_id(&self) -> Option<String> {
        None
    }
    /// The next event, or `None` at the end of the stream.
    async fn next(&mut self) -> Option<Event>;

    /// How the provider call ended — finish reason, failure, and the usage
    /// or its explicit absence — once `next` has returned `None`. Handed to
    /// the settler in [`crate::settle::CallRecord::outcome`]. `None` from an
    /// upstream that does not know (or has not ended).
    fn outcome(&mut self) -> Option<crate::provider::ProviderOutcome> {
        None
    }

    /// Take the request body's share of the gateway-wide upload budget. An
    /// upstream that still holds the request's bytes after `start` keeps it
    /// until it drops them, so request memory stays inside
    /// `max_upload_buffer_bytes`. The default releases it at once.
    fn keep_upload_reservation(&mut self, reservation: tokio::sync::OwnedSemaphorePermit) {
        drop(reservation);
    }
}

/// How often the watchers check the stall limit.
const STALL_CHECK: Duration = Duration::from_millis(250);

/// The per-call limits.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub(crate) buffer_bytes: usize,
    pub(crate) stall: Duration,
    pub(crate) start_timeout: Duration,
}

/// Delivery's state, shared by the reader and the body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Open,
    Delivered,
    ClientGone,
    /// `delivery_aborted` queued (the only frame left), then the body ends
    /// and the connection closes after it.
    Aborted(Delivery),
    /// Drain: the body fails at its next poll.
    Cut,
}

#[derive(Debug)]
struct Buffer {
    frames: VecDeque<Bytes>,
    bytes: usize,
    state: State,
    upstream_done: bool,
    /// The body has returned its terminal error (cut, or after the abort
    /// frame); the connection is closing and nothing more is polled.
    error_reported: bool,
    /// When the buffer last went from empty to non-empty, or a frame was
    /// last taken — whichever is later. Only meaningful while frames wait.
    last_progress: Instant,
    /// When delivery was aborted.
    aborted_at: Option<Instant>,
    /// The connection was dropped because nothing took the abort frame.
    killed: bool,
    /// A `delta` or `tool_call` was produced.
    output_seen: bool,
    waker: Option<Waker>,
}

/// The buffer plus what it reports into.
#[derive(Debug)]
struct Shared {
    buffer: Mutex<Buffer>,
    inflight: Arc<InFlight>,
    kill: Option<ConnectionKill>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Buffer> {
        self.buffer.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wake(waker: Option<Waker>) {
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    /// Discard everything buffered.
    fn clear(&self, buffer: &mut Buffer) {
        if !matches!(buffer.state, State::Aborted(_)) {
            self.inflight.sub_buffered(buffer.bytes);
        }
        buffer.frames.clear();
        buffer.bytes = 0;
    }

    /// End delivery with `delivery_aborted`, keeping the upstream read going.
    fn abort_delivery(&self, buffer: &mut Buffer, reason: Delivery, now: Instant) {
        self.clear(buffer);
        // Not counted in `bytes`: it is the one frame an aborted delivery
        // still owes, and it replaces everything that was.
        buffer
            .frames
            .push_back(delivery_aborted_frame(reason, buffer.output_seen));
        buffer.state = State::Aborted(reason);
        buffer.aborted_at = Some(now);
        // No further request on this connection: it closes once this response
        // is flushed. The kill below is then the only thing that can reach it,
        // and it can only reach this response.
        if let Some(kill) = &self.kill {
            kill.close_after_response();
        }
        self.inflight.metrics().record_delivery_aborted(reason);
        tracing::info!(
            delivery = reason.label(),
            "delivery aborted; the upstream read continues"
        );
    }

    /// The reader's push. Never blocks, never waits for the client.
    fn push(&self, frame: Bytes, output: bool, limit: usize, stall: Duration) {
        let waker = {
            let mut buffer = self.lock();
            // `partial` in a later `delivery_aborted` is conservative: output
            // was produced, whether or not the client got all of it.
            buffer.output_seen |= output;
            if buffer.state != State::Open {
                // The client is gone or delivery ended: the event is read and
                // dropped. The upstream read is unaffected.
                return;
            }
            let now = Instant::now();
            if buffer.frames.is_empty() {
                buffer.last_progress = now;
            }
            if buffer.bytes.saturating_add(frame.len()) > limit {
                self.abort_delivery(&mut buffer, Delivery::BufferFull, now);
            } else {
                self.inflight.add_buffered(frame.len());
                buffer.bytes = buffer.bytes.saturating_add(frame.len());
                buffer.frames.push_back(frame);
                self.check(&mut buffer, now, stall);
            }
            buffer.waker.take()
        };
        Self::wake(waker);
    }

    /// The stall rule, and the kill for an abort frame nobody takes.
    fn check(&self, buffer: &mut Buffer, now: Instant, stall: Duration) {
        if buffer.state == State::Open
            && !buffer.frames.is_empty()
            && now.saturating_duration_since(buffer.last_progress) >= stall
        {
            self.abort_delivery(buffer, Delivery::Stalled, now);
        }
        // hyper takes frames into its own write buffer whether or not the
        // socket drains, so "the abort frame was taken" says nothing about
        // whether the client got it. The connection of an aborted delivery
        // is therefore always dropped one stall period after the abort: time
        // enough for a client that is reading to receive the frame.
        if let (State::Aborted(_), Some(at)) = (buffer.state, buffer.aborted_at)
            && !buffer.killed
            && now.saturating_duration_since(at) >= stall
        {
            buffer.killed = true;
            buffer.frames.clear();
            if let Some(kill) = &self.kill {
                kill.kill();
            }
        }
    }

    fn tick(&self, stall: Duration) {
        let waker = {
            let mut buffer = self.lock();
            self.check(&mut buffer, Instant::now(), stall);
            buffer.waker.take()
        };
        Self::wake(waker);
    }

    /// Whether delivery needs nothing more from the gateway.
    fn delivery_over(&self) -> bool {
        let buffer = self.lock();
        match buffer.state {
            State::Delivered | State::ClientGone | State::Cut => true,
            // Over only once the kill timer has run: whether the abort frame
            // ever left hyper's write buffer is not observable from here.
            State::Aborted(_) => buffer.killed || self.kill.is_none(),
            State::Open => buffer.upstream_done && buffer.frames.is_empty(),
        }
    }

    /// The upstream ended (or was aborted); returns delivery's state then.
    fn finish(&self, cut: bool) -> Delivery {
        let (delivery, waker) = {
            let mut buffer = self.lock();
            buffer.upstream_done = true;
            if cut && matches!(buffer.state, State::Open | State::Aborted(_)) {
                self.clear(&mut buffer);
                buffer.state = State::Cut;
            }
            let delivery = match buffer.state {
                State::Open => Delivery::Open,
                State::Delivered => Delivery::Delivered,
                State::ClientGone => Delivery::ClientGone,
                State::Aborted(reason) => reason,
                State::Cut => Delivery::Cut,
            };
            (delivery, buffer.waker.take())
        };
        Self::wake(waker);
        delivery
    }
}

fn delivery_aborted_frame(reason: Delivery, partial: bool) -> Bytes {
    let message = match reason {
        Delivery::Stalled => {
            "no delivery progress within the stall limit; the call continues upstream and settles"
        }
        _ => "the per-stream delivery buffer filled; the call continues upstream and settles",
    };
    // `pending`: the call is still running upstream, so every amount is
    // absent (chat-api.md §2.4).
    let event = Event::Error(ErrorEvent {
        code: ErrorCode::DeliveryAborted,
        message: message.to_owned(),
        settlement: Settlement::Pending,
        charged_2z: None,
        receipt_id: None,
        collected_milli_2z: None,
        shortfall_milli_2z: None,
        partial,
    });
    Bytes::from(event.to_sse().unwrap_or_default())
}

/// Why a delivery body failed — deliberately, so the client sees a
/// truncated stream rather than one that looks complete.
#[derive(Debug)]
pub enum DeliveryEnded {
    /// The drain window closed.
    Cut,
}

impl std::fmt::Display for DeliveryEnded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Cut => "stream cut: the gateway instance finished draining",
        })
    }
}

impl std::error::Error for DeliveryEnded {}

/// The HTTP response body of a streamed call: delivery only.
#[derive(Debug)]
pub struct DeliveryBody {
    pub(crate) replay: Option<serde_json::Value>,
    pub(crate) call_id: Option<String>,
    shared: Arc<Shared>,
}

impl http_body::Body for DeliveryBody {
    type Data = Bytes;
    type Error = DeliveryEnded;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, DeliveryEnded>>> {
        let shared = &self.shared;
        let mut buffer = shared.lock();
        if buffer.error_reported {
            return Poll::Ready(None);
        }
        if buffer.state == State::Cut {
            buffer.error_reported = true;
            return Poll::Ready(Some(Err(DeliveryEnded::Cut)));
        }
        if let Some(frame) = buffer.frames.pop_front() {
            if !matches!(buffer.state, State::Aborted(_)) {
                shared.inflight.sub_buffered(frame.len());
                buffer.bytes = buffer.bytes.saturating_sub(frame.len());
            }
            buffer.last_progress = Instant::now();
            return Poll::Ready(Some(Ok(Frame::data(frame))));
        }
        match buffer.state {
            // After the abort frame: a clean end, so hyper flushes the frame.
            // The connection was already told to close after this response
            // (`abort_delivery`), so it is never reused.
            State::Aborted(_) | State::ClientGone | State::Delivered => Poll::Ready(None),
            State::Open if buffer.upstream_done => {
                buffer.state = State::Delivered;
                Poll::Ready(None)
            }
            State::Open | State::Cut => {
                buffer.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        let buffer = self.shared.lock();
        buffer.frames.is_empty()
            && (matches!(buffer.state, State::Delivered)
                || (buffer.state == State::Open && buffer.upstream_done))
    }
}

impl Drop for DeliveryBody {
    fn drop(&mut self) {
        let mut buffer = self.shared.lock();
        match buffer.state {
            State::Open
                if self
                    .shared
                    .kill
                    .as_ref()
                    .is_some_and(ConnectionKill::write_stalled) =>
            {
                // The socket deadline may beat the delivery task's periodic
                // stall check. Keep its outcome/metric, rather than reporting
                // an ordinary client disconnect just because that timer won.
                self.shared
                    .abort_delivery(&mut buffer, Delivery::Stalled, Instant::now());
                buffer.frames.clear();
                buffer.killed = true;
            }
            State::Open if buffer.upstream_done && buffer.frames.is_empty() => {
                buffer.state = State::Delivered;
            }
            State::Open => {
                // The client went away. Only delivery stops.
                self.shared.clear(&mut buffer);
                buffer.state = State::ClientGone;
            }
            State::Aborted(_) => buffer.frames.clear(),
            State::Delivered | State::ClientGone | State::Cut => {}
        }
    }
}

/// Everything a call's task needs.
pub(crate) struct Start {
    pub(crate) backend: Arc<dyn ChatBackend>,
    pub(crate) request: ChatRequest,
    pub(crate) catalog: Arc<VerifiedCatalog>,
    pub(crate) call: CallHandle,
    pub(crate) slot: Slot,
    pub(crate) kill: Option<ConnectionKill>,
    /// The request body's share of the upload budget, held until `start`
    /// has consumed the request.
    pub(crate) upload: tokio::sync::OwnedSemaphorePermit,
    pub(crate) limits: Limits,
}

/// The call's task: start the backend (bounded, abortable), hand the delivery
/// body to the handler through `head`, read the upstream to its end, settle,
/// and watch delivery until it is over. Runs detached: the handler going away
/// changes nothing here except that nobody is delivered to.
pub(crate) async fn run(start: Start, head: oneshot::Sender<Result<DeliveryBody, ApiFailure>>) {
    let Start {
        backend,
        request,
        catalog,
        call,
        slot,
        kill,
        upload,
        limits,
    } = start;
    let inflight = Arc::clone(call.inflight());
    let mut abort = inflight.abort_signal();
    let slot = Arc::new(slot);
    let shared = Arc::new(Shared {
        buffer: Mutex::new(Buffer {
            frames: VecDeque::new(),
            bytes: 0,
            state: State::Open,
            upstream_done: false,
            error_reported: false,
            last_progress: Instant::now(),
            aborted_at: None,
            killed: false,
            output_seen: false,
            waker: None,
        }),
        inflight: Arc::clone(&inflight),
        kill,
    });

    // Settlement ownership starts here, before the backend can take a hold:
    // from this line the call reaches the settler exactly once, on every path
    // — `start` failing, timing out, being cancelled, or this task dropped.
    let mut guard = SettleGuard {
        record: CallRecord {
            id: call.id(),
            upstream: UpstreamEnd::NotStarted,
            delivery: Delivery::None,
            usage: None,
            outcome: None,
            elapsed: Duration::ZERO,
        },
        started: call.started(),
        shared: Arc::clone(&shared),
        inflight: Arc::clone(&inflight),
        slot: Some(Arc::clone(&slot)),
        state: GuardState::Starting,
    };

    let started = tokio::select! {
        // The deadline is the request's, counted from admission — the same
        // instant the client's request timeout counts from — and this task is
        // the only thing that enforces it. So the one path that answers "the
        // call did not start in time" is also the path that settles it as
        // `NotStarted`: a client never gets a `500` for a call that then
        // started and was charged (a retry would pay twice).
        started = tokio::time::timeout_at(
            tokio::time::Instant::from_std(call.started())
                .checked_add(limits.start_timeout)
                .unwrap_or_else(tokio::time::Instant::now),
            backend.start(request, catalog, &call),
        ) => started,
        () = crate::shutdown::raised(&mut abort) => {
            let _ = head.send(Err(ApiFailure::new(
                ErrorCode::Unavailable,
                "this gateway instance finished draining before the call started",
            )
            .detail("reason", "draining")));
            return;
        }
    };
    let mut upstream = match started {
        Ok(Ok(mut upstream)) => {
            // The request's share of the upload budget follows the request:
            // an upstream that keeps the bytes (to send them, or to retry)
            // holds the reservation until it lets them go.
            upstream.keep_upload_reservation(upload);
            upstream
        }
        Ok(Err(failure)) => {
            // Refused before any stream: an HTTP error. The guard still
            // reports the call, as not started.
            let _ = head.send(Err(failure));
            return;
        }
        Err(_) => {
            let _ = head.send(Err(ApiFailure::new(
                ErrorCode::Internal,
                "the call did not start within the gateway's request timeout",
            )));
            return;
        }
    };
    guard.state = GuardState::Reading;

    // If the handler is gone the body comes back in the error and is dropped
    // at once, which is exactly "the client went away".
    drop(head.send(Ok(DeliveryBody {
        replay: upstream.replay_record(),
        call_id: upstream.call_id(),
        shared: Arc::clone(&shared),
    })));

    let mut tick = tokio::time::interval(STALL_CHECK.min(limits.stall));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let drained = loop {
        tokio::select! {
            event = upstream.next() => {
                let Some(event) = event else { break false };
                if let Event::Usage(usage) = &event {
                    guard.record.usage = Some(usage.usage);
                }
                let output = matches!(event, Event::Delta(_) | Event::ToolCall(_));
                if let Ok(frame) = event.to_sse() {
                    shared.push(Bytes::from(frame), output, limits.buffer_bytes, limits.stall);
                }
            }
            _ = tick.tick() => shared.tick(limits.stall),
            () = crate::shutdown::raised(&mut abort) => break true,
        }
    };
    guard.record.outcome = upstream.outcome();
    // On a drain this drops the provider request (the `Upstream` contract).
    drop(upstream);
    guard.record.upstream = if drained {
        UpstreamEnd::Drained
    } else {
        UpstreamEnd::Finished
    };
    guard.record.delivery = shared.finish(drained);
    guard.state = GuardState::Done;
    drop(guard); // hands the call to the settler now; delivery may go on

    // Delivery can outlive the upstream: a slow client is still draining the
    // buffer. Keep the stall rule running, and keep the slot, until it is
    // over — or until a drain cuts it.
    while !shared.delivery_over() {
        tokio::select! {
            _ = tick.tick() => shared.tick(limits.stall),
            () = crate::shutdown::raised(&mut abort) => {
                shared.finish(true);
                break;
            }
        }
    }
    drop(slot);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GuardState {
    Starting,
    Reading,
    Done,
}

/// Hands the call to the settler when dropped, however the task ends.
struct SettleGuard {
    record: CallRecord,
    started: Instant,
    shared: Arc<Shared>,
    inflight: Arc<InFlight>,
    slot: Option<Arc<Slot>>,
    state: GuardState,
}

impl Drop for SettleGuard {
    fn drop(&mut self) {
        match self.state {
            GuardState::Starting | GuardState::Reading if std::thread::panicking() => {
                // A gateway (or backend/upstream) bug, not a drain: say so.
                self.record.upstream = UpstreamEnd::Panicked;
                self.record.delivery = if self.state == GuardState::Reading {
                    self.shared.finish(true)
                } else {
                    Delivery::None
                };
                tracing::error!(
                    call = self.record.id,
                    "call task panicked; handed to the settler as panicked"
                );
            }
            GuardState::Starting => {
                self.record.upstream = UpstreamEnd::NotStarted;
                self.record.delivery = Delivery::None;
            }
            GuardState::Reading => {
                // The task was dropped mid-read (a runtime shutting down):
                // treat it as the drain it is.
                self.record.upstream = UpstreamEnd::Drained;
                self.record.delivery = self.shared.finish(true);
            }
            GuardState::Done => {}
        }
        self.record.elapsed = self.started.elapsed();
        if let Some(slot) = self.slot.take() {
            self.inflight.settle(settle::Settlement {
                record: self.record.clone(),
                slot,
            });
        }
    }
}
