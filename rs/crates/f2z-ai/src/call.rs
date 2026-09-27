//! A started call: the upstream read and the delivery to the client, kept
//! apart.
//!
//! chat-api.md §2.4 and ADR 0001: **client backpressure never reaches the
//! provider.** So a call is two things that only share a bounded buffer:
//!
//! * **The reader** — a detached task per call ([`run`]). It reads the
//!   [`Upstream`] at provider speed, to its end, whatever the client is
//!   doing, encodes each event as an SSE frame and pushes it into the call's
//!   delivery buffer. When the upstream ends it hands the call to the settler
//!   — with the usage the upstream reported — and only then releases the
//!   call's concurrency slot. It never waits for the client.
//! * **The delivery** — the HTTP response body ([`DeliveryBody`]). It pops
//!   frames from the buffer as fast as the client takes them. It is the only
//!   thing a slow or vanished client affects.
//!
//! The buffer is bounded (`delivery_buffer_bytes`, 256 KiB of event payload).
//! Two things end **delivery** early while the read and the settlement carry
//! on unchanged: the buffer filling, and `delivery_stall_secs` (30 s) with
//! frames waiting and none taken. Both replace whatever is buffered with one
//! best-effort `error` event — `code: "delivery_aborted"`,
//! `settlement: "pending"` — and end the body. A client that disconnects ends
//! delivery the same way minus the event. None of these touches the upstream.
//!
//! **Drain.** Calls keep reading their upstream through the drain window. At
//! the window's end the gateway aborts the rest: the reader stops, the body
//! is **cut** (it fails, so the client sees a truncated stream rather than one
//! that looks complete), and the call reaches the settler as
//! [`UpstreamEnd::Drained`].
//!
//! `delivery_aborted` is not yet an `f2z_ai_proto::ErrorCode` (the crate's
//! v0.x follow-up, zuu#1052), so that one frame is written here by hand.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bytes::Bytes;
use f2z_ai_proto::chat::ChatRequest;
use f2z_ai_proto::{ErrorCode, Event};
use http_body::Frame;
use tokio::sync::oneshot;

use crate::admission::{CallHandle, InFlight, Slot};
use crate::catalog::VerifiedCatalog;
use crate::chat::ChatBackend;
use crate::error::ApiFailure;
use crate::settle::{CallRecord, Delivery, Settlement, UpstreamEnd};

/// A started provider stream, as unified events.
///
/// Wave 2's adapters implement this over a provider's stream. The reader
/// calls [`Upstream::next`] in a loop until it returns `None`; it must return
/// `None` once the provider's stream has ended (after its usage frame, if it
/// sends one). Dropping an `Upstream` must abort the provider request — the
/// reader only drops one early when a drain aborts the call.
#[async_trait]
pub trait Upstream: Send + 'static {
    /// The next event, or `None` at the end of the stream.
    async fn next(&mut self) -> Option<Event>;
}

/// How often the reader checks the stall limit while nothing else happens.
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
    /// `delivery_aborted` queued (the only frame left), then the body ends.
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
    cut_reported: bool,
    /// When the buffer last went from empty to non-empty, or a frame was
    /// last taken — whichever is later. Only meaningful while frames wait.
    last_progress: Instant,
    waker: Option<Waker>,
}

/// The buffer plus the gateway-wide byte gauge it reports into.
#[derive(Debug)]
struct Shared {
    buffer: Mutex<Buffer>,
    inflight: Arc<InFlight>,
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

    /// Discard everything buffered; returns the waker to wake.
    fn clear(&self, buffer: &mut Buffer) {
        self.inflight.sub_buffered(buffer.bytes);
        buffer.frames.clear();
        buffer.bytes = 0;
    }

    /// End delivery with `delivery_aborted`, keeping the upstream read going.
    fn abort_delivery(&self, buffer: &mut Buffer, reason: Delivery) {
        self.clear(buffer);
        buffer.frames.push_back(delivery_aborted_frame(reason));
        buffer.state = State::Aborted(reason);
        self.inflight.metrics().record_delivery_aborted(reason);
        tracing::info!(
            delivery = reason.label(),
            "delivery aborted; the upstream read continues"
        );
    }

    /// The reader's push. Never blocks, never waits for the client.
    fn push(&self, frame: Bytes, limit: usize, stall: Duration) {
        let waker = {
            let mut buffer = self.lock();
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
                self.abort_delivery(&mut buffer, Delivery::BufferFull);
            } else {
                self.inflight.add_buffered(frame.len());
                buffer.bytes = buffer.bytes.saturating_add(frame.len());
                buffer.frames.push_back(frame);
                self.check_stall(&mut buffer, now, stall);
            }
            buffer.waker.take()
        };
        Self::wake(waker);
    }

    fn check_stall(&self, buffer: &mut Buffer, now: Instant, stall: Duration) {
        if buffer.state == State::Open
            && !buffer.frames.is_empty()
            && now.saturating_duration_since(buffer.last_progress) >= stall
        {
            self.abort_delivery(buffer, Delivery::Stalled);
        }
    }

    fn tick(&self, stall: Duration) {
        let waker = {
            let mut buffer = self.lock();
            self.check_stall(&mut buffer, Instant::now(), stall);
            buffer.waker.take()
        };
        Self::wake(waker);
    }

    /// The upstream ended (or was aborted); returns delivery's state then.
    fn finish(&self, cut: bool) -> Delivery {
        let (delivery, waker) = {
            let mut buffer = self.lock();
            buffer.upstream_done = true;
            if cut && matches!(buffer.state, State::Open) {
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

fn delivery_aborted_frame(reason: Delivery) -> Bytes {
    let message = match reason {
        Delivery::Stalled => {
            "no delivery progress within the stall limit; the call continues upstream and settles"
        }
        _ => "the per-stream delivery buffer filled; the call continues upstream and settles",
    };
    let data = serde_json::json!({
        "code": "delivery_aborted",
        "message": message,
        "settlement": "pending",
    });
    Bytes::from(format!("event: error\ndata: {data}\n\n"))
}

/// The error a cut body fails with.
#[derive(Debug)]
pub struct DrainCut;

impl std::fmt::Display for DrainCut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("stream cut: the gateway instance finished draining")
    }
}

impl std::error::Error for DrainCut {}

/// The HTTP response body of a streamed call: delivery only.
#[derive(Debug)]
pub struct DeliveryBody {
    shared: Arc<Shared>,
}

impl http_body::Body for DeliveryBody {
    type Data = Bytes;
    type Error = DrainCut;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, DrainCut>>> {
        let shared = &self.shared;
        let mut buffer = shared.lock();
        if buffer.state == State::Cut {
            if buffer.cut_reported {
                return Poll::Ready(None);
            }
            buffer.cut_reported = true;
            return Poll::Ready(Some(Err(DrainCut)));
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
        if buffer.state == State::Open {
            if buffer.upstream_done && buffer.frames.is_empty() {
                buffer.state = State::Delivered;
            } else {
                // The client went away. Only delivery stops.
                self.shared.clear(&mut buffer);
                buffer.state = State::ClientGone;
            }
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
    pub(crate) limits: Limits,
}

/// The call's task: start the backend (bounded, abortable), hand the delivery
/// body to the handler through `head`, then read the upstream to its end and
/// settle. Runs detached: the handler going away changes nothing here except
/// that nobody is delivered to.
pub(crate) async fn run(start: Start, head: oneshot::Sender<Result<DeliveryBody, ApiFailure>>) {
    let Start {
        backend,
        request,
        catalog,
        call,
        slot,
        limits,
    } = start;
    let inflight = Arc::clone(call.inflight());
    let mut abort = inflight.abort_signal();

    let started = tokio::select! {
        started = tokio::time::timeout(
            limits.start_timeout,
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
        Ok(Ok(upstream)) => upstream,
        Ok(Err(failure)) => {
            // Refused before any stream: an HTTP error, nothing to settle.
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

    // From here the call is started: it will be settled exactly once, by the
    // guard below, on every path — including this task being aborted.
    let shared = Arc::new(Shared {
        buffer: Mutex::new(Buffer {
            frames: VecDeque::new(),
            bytes: 0,
            state: State::Open,
            upstream_done: false,
            cut_reported: false,
            last_progress: Instant::now(),
            waker: None,
        }),
        inflight: Arc::clone(&inflight),
    });
    let mut guard = SettleGuard {
        record: CallRecord {
            id: call.id(),
            upstream: UpstreamEnd::Drained,
            delivery: Delivery::Cut,
            usage: None,
            elapsed: Duration::ZERO,
        },
        started: call.started(),
        shared: Arc::clone(&shared),
        inflight: Arc::clone(&inflight),
        slot: Some(slot),
        finished: false,
    };
    // If the handler is gone the body comes back in the error and is dropped
    // at once, which is exactly "the client went away".
    drop(head.send(Ok(DeliveryBody {
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
                if let Ok(frame) = event.to_sse() {
                    shared.push(Bytes::from(frame), limits.buffer_bytes, limits.stall);
                }
            }
            _ = tick.tick() => shared.tick(limits.stall),
            () = crate::shutdown::raised(&mut abort) => break true,
        }
    };
    // On a drain this drops the provider request (the `Upstream` contract).
    drop(upstream);
    guard.record.upstream = if drained {
        UpstreamEnd::Drained
    } else {
        UpstreamEnd::Finished
    };
    guard.record.delivery = shared.finish(drained);
    guard.finished = true;
}

/// Hands the call to the settler when the task ends, however it ends.
struct SettleGuard {
    record: CallRecord,
    started: Instant,
    shared: Arc<Shared>,
    inflight: Arc<InFlight>,
    slot: Option<Slot>,
    finished: bool,
}

impl Drop for SettleGuard {
    fn drop(&mut self) {
        if !self.finished {
            // The task was dropped mid-read (a runtime shutting down): treat
            // it as the drain it is.
            self.record.upstream = UpstreamEnd::Drained;
            self.record.delivery = self.shared.finish(true);
        }
        self.record.elapsed = self.started.elapsed();
        if let Some(slot) = self.slot.take() {
            self.inflight.settle(Settlement {
                record: self.record.clone(),
                slot,
            });
        }
    }
}
