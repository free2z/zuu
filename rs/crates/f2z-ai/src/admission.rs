//! Admission: the tower layer between a connection and the router.
//!
//! Three jobs, in order, for every request on the public listener:
//!
//! 1. **Draining?** Refuse with `503 unavailable`, `details.reason:
//!    "draining"`, `Retry-After`, and `Connection: close` — errors.md §2's
//!    exact case. The instance is still accepting connections while the load
//!    balancer notices `/readyz`, and a clean retryable 503 is kinder to a
//!    client than a refused connection.
//! 2. **Full?** Take a permit from a semaphore of `max_concurrent_calls`, or
//!    refuse with `503 unavailable` and `Retry-After`.
//! 3. **Hold the slot.** The permit and one unit of the in-flight count form a
//!    [`Slot`], parked on the request's [`CallHandle`]. A call that starts
//!    ([`crate::call`]) takes the slot with it and keeps it **until its
//!    settle returns** — through a slow client, a disconnected client, and a
//!    drain. A request that never starts a call (a `400`, a `413`, a `501`)
//!    leaves the slot parked, and this layer releases it when the response
//!    body ends.
//!
//! # Why not `tower::limit::ConcurrencyLimit`
//!
//! Because it releases its permit when the service's future resolves — when
//! the response *head* is ready. For a streamed chat that is the moment the
//! stream *starts*, so a limit of 100 would admit unboundedly many streams,
//! each holding a provider connection and a hold. Here the permit lives as
//! long as the call does.
//!
//! # The drain race
//!
//! A request increments the in-flight count **before** it checks the draining
//! flag, and a drain sets the flag **before** it reads the count. Both go
//! through the same `watch` lock, so either the drain sees the request's
//! increment and waits for it, or the request sees the flag and refuses.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, Response};
use axum::response::IntoResponse;
use bytes::Bytes;
use f2z_ai_proto::ErrorCode;
use http_body::Frame;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tower::{Layer, Service};

use crate::error::ApiFailure;
use crate::metrics::{Metrics, Rejection};
use crate::settle::Settlement;

/// Shared state of every call in flight.
#[derive(Debug)]
pub struct InFlight {
    count: watch::Sender<usize>,
    draining: AtomicBool,
    abort: watch::Sender<bool>,
    permits: Arc<Semaphore>,
    next_id: AtomicU64,
    settle: mpsc::UnboundedSender<Settlement>,
    buffered_bytes: AtomicU64,
    retry_after_secs: u32,
    metrics: Arc<Metrics>,
}

impl InFlight {
    /// A tracker admitting at most `max` calls at once, handing finished
    /// calls to `settle`.
    pub(crate) fn new(
        max: usize,
        retry_after_secs: u32,
        settle: mpsc::UnboundedSender<Settlement>,
        metrics: Arc<Metrics>,
    ) -> Self {
        Self {
            count: watch::Sender::new(0),
            draining: AtomicBool::new(false),
            abort: watch::Sender::new(false),
            permits: Arc::new(Semaphore::new(max.min(Semaphore::MAX_PERMITS))),
            next_id: AtomicU64::new(1),
            settle,
            buffered_bytes: AtomicU64::new(0),
            retry_after_secs,
            metrics,
        }
    }

    /// Requests and calls holding a slot: admitted and not yet settled.
    #[must_use]
    pub fn active(&self) -> usize {
        *self.count.borrow()
    }

    /// Undelivered event bytes across every stream — what ADR 0001 budgets at
    /// 10k × 256 KiB.
    #[must_use]
    pub fn buffered_bytes(&self) -> u64 {
        self.buffered_bytes.load(Ordering::Relaxed)
    }

    pub(crate) fn add_buffered(&self, bytes: usize) {
        self.buffered_bytes
            .fetch_add(u64::try_from(bytes).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    pub(crate) fn sub_buffered(&self, bytes: usize) {
        let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
        let _ = self
            .buffered_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |b| {
                Some(b.saturating_sub(bytes))
            });
    }

    pub(crate) fn metrics(&self) -> &Metrics {
        &self.metrics
    }

    /// Whether a drain has begun.
    #[must_use]
    pub fn draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    /// Begin draining: every request from now on is refused.
    pub fn start_draining(&self) {
        self.draining.store(true, Ordering::SeqCst);
        // Touch the count under its lock, so that the store above is ordered
        // before any increment that follows (see "The drain race").
        self.count.send_modify(|_| {});
    }

    /// Wait until nothing holds a slot.
    pub async fn wait_idle(&self) {
        let mut rx = self.count.subscribe();
        let _ = rx.wait_for(|n| *n == 0).await;
    }

    /// Abort every call still running: its upstream read stops, its body is
    /// cut, and it reaches the settler as drained.
    pub fn abort_all(&self) {
        self.abort.send_replace(true);
    }

    pub(crate) fn abort_signal(&self) -> watch::Receiver<bool> {
        self.abort.subscribe()
    }

    /// Hand a finished call to the settler.
    pub(crate) fn settle(&self, settlement: Settlement) {
        if let Err(mpsc::error::SendError(settlement)) = self.settle.send(settlement) {
            // The settler has already stopped: shutdown outlived its grace.
            // Loud, because in Wave 2 this is a hold nobody will settle —
            // the ledger's expiry releases it (metering.md §5.6).
            tracing::error!(
                call = settlement.record.id,
                "call ended after the settler stopped; it was not handed over"
            );
        }
    }

    fn admit(self: &Arc<Self>) -> Result<(u64, Slot), ApiFailure> {
        // Count first, then look at the flag — the order is the proof.
        self.count.send_modify(|n| *n = n.saturating_add(1));
        let ticket = Ticket(Arc::clone(self));
        if self.draining() {
            drop(ticket);
            self.metrics.record_rejection(Rejection::Draining);
            return Err(ApiFailure::new(
                ErrorCode::Unavailable,
                "this gateway instance is draining; retry and the load balancer will route \
                 elsewhere",
            )
            .detail("reason", "draining")
            .retry_after(self.retry_after_secs)
            .closing());
        }
        let Ok(permit) = Arc::clone(&self.permits).try_acquire_owned() else {
            drop(ticket);
            self.metrics.record_rejection(Rejection::Overloaded);
            return Err(ApiFailure::new(
                ErrorCode::Unavailable,
                "this gateway instance is at its concurrent call limit",
            )
            .retry_after(self.retry_after_secs));
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        Ok((
            id,
            Slot {
                _permit: permit,
                _ticket: ticket,
            },
        ))
    }
}

/// One unit of the in-flight count; decrements on drop.
#[derive(Debug)]
struct Ticket(Arc<InFlight>);

impl Drop for Ticket {
    fn drop(&mut self) {
        self.0.count.send_modify(|n| *n = n.saturating_sub(1));
    }
}

/// A concurrency permit and an in-flight count, released together on drop.
#[derive(Debug)]
pub struct Slot {
    _permit: OwnedSemaphorePermit,
    _ticket: Ticket,
}

#[derive(Debug)]
struct CallState {
    id: u64,
    started: Instant,
    inflight: Arc<InFlight>,
    slot: Mutex<Option<Slot>>,
}

/// The handler's view of an admitted request. Inserted into its extensions.
#[derive(Clone, Debug)]
pub struct CallHandle(Arc<CallState>);

impl CallHandle {
    /// Process-local call number.
    #[must_use]
    pub fn id(&self) -> u64 {
        self.0.id
    }

    /// When the request was admitted.
    #[must_use]
    pub fn started(&self) -> Instant {
        self.0.started
    }

    pub(crate) fn inflight(&self) -> &Arc<InFlight> {
        &self.0.inflight
    }

    /// Take the slot: the caller now keeps the request counted until it
    /// drops the slot. `None` if it was already taken.
    pub(crate) fn take_slot(&self) -> Option<Slot> {
        self.0
            .slot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

/// A response body that keeps a parked slot until it ends or is dropped.
struct SlotBody {
    inner: Body,
    _slot: Slot,
}

impl http_body::Body for SlotBody {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

/// The layer. See the module docs.
#[derive(Clone, Debug)]
pub struct AdmissionLayer {
    inflight: Arc<InFlight>,
}

impl AdmissionLayer {
    /// Admit through `inflight`.
    #[must_use]
    pub const fn new(inflight: Arc<InFlight>) -> Self {
        Self { inflight }
    }
}

impl<S> Layer<S> for AdmissionLayer {
    type Service = Admission<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Admission {
            inner,
            inflight: Arc::clone(&self.inflight),
        }
    }
}

/// The service [`AdmissionLayer`] produces.
#[derive(Clone, Debug)]
pub struct Admission<S> {
    inner: S,
    inflight: Arc<InFlight>,
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

impl<S> Service<Request<Body>> for Admission<S>
where
    S: Service<Request<Body>, Response = Response<Body>> + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = BoxFuture<Result<Response<Body>, S::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut request: Request<Body>) -> Self::Future {
        let (id, slot) = match self.inflight.admit() {
            Ok(admitted) => admitted,
            Err(refusal) => {
                return Box::pin(std::future::ready(Ok(refusal.into_response())));
            }
        };
        let handle = CallHandle(Arc::new(CallState {
            id,
            started: Instant::now(),
            inflight: Arc::clone(&self.inflight),
            slot: Mutex::new(Some(slot)),
        }));
        request.extensions_mut().insert(handle.clone());
        let future = self.inner.call(request);
        Box::pin(async move {
            // If this future is dropped before the head is ready — the client
            // hung up — `handle` drops here; a parked slot is released, and a
            // started call's slot is with its task.
            let response = future.await?;
            Ok(match handle.take_slot() {
                Some(slot) => response.map(|inner| Body::new(SlotBody { inner, _slot: slot })),
                None => response,
            })
        })
    }
}
