//! The settler hook: where every started call ends up, exactly once, off the
//! request's future — and the point at which the call stops counting.
//!
//! ADR 0001 of `docs/free2z/ai-gateway`: *settlement never runs on the request
//! future. A guard hands the call to a detached settler task on completion,
//! cancellation or error, so a client going away cannot prevent a settle, and
//! a settle cannot delay the next request.* A call here is started by
//! [`crate::call`]'s detached task, which reads the upstream to its end at
//! provider speed and then hands a [`CallRecord`] over — from its `Drop`, so
//! the handover happens on every path, including a task aborted by a drain.
//!
//! **A call counts** — against `max_concurrent_calls`, and in `/metrics`'s
//! `f2z_ai_active_streams`, and for the drain — **from admission until its
//! settle returns and its delivery has ended**: the call's concurrency slot
//! travels inside the handover and is released only after
//! [`Settler::settle`] completes (and after delivery, see [`crate::call`]). That is the README's "counted from hold to
//! settlement (a drained, disconnected call still counts)" for the
//! gateway-wide limit; the per-user limit of Wave 2 hangs off the same slot.
//!
//! In this skeleton nothing is held, so nothing is settled: [`LogSettler`]
//! records the disposition and returns. Wave 2's settler turns a record into
//! the ledger's `settle` or `release` (metering.md §3).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use f2z_ai_proto::chat::Usage;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinSet;

use crate::admission::Slot;
use crate::metrics::Metrics;

/// How the upstream read ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpstreamEnd {
    /// The backend's `start` failed, timed out, or was cancelled by a drain:
    /// no stream. Handed over anyway, because `start` may have taken a hold
    /// the settler must release.
    NotStarted,
    /// The upstream was read to its end — the normal case, whatever the
    /// client did (metering.md §5.3).
    Finished,
    /// The drain window closed with the upstream still being read, and the
    /// gateway aborted it. Wave 2 settles from what is known or releases.
    Drained,
    /// The call's task panicked — a bug in the gateway, a backend or an
    /// upstream adapter, never an operational event. Distinct from
    /// [`UpstreamEnd::Drained`] so a settler and `/metrics` can tell them apart.
    Panicked,
}

impl UpstreamEnd {
    /// The metrics label.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::NotStarted => "not_started",
            Self::Finished => "finished",
            Self::Drained => "drained",
            Self::Panicked => "panicked",
        }
    }
}

/// The state of delivery to the client when the upstream ended.
///
/// Delivery and the upstream are independent (chat-api.md §2.4): every
/// variant other than [`Delivery::Cut`] is compatible with
/// [`UpstreamEnd::Finished`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// No stream was started, so nothing was ever delivered.
    None,
    /// Still delivering: the client is connected and the buffer is draining
    /// to it (or has just drained).
    Open,
    /// Every event had been delivered and the body ended.
    Delivered,
    /// The client went away; the upstream was read to its end regardless.
    ClientGone,
    /// The per-stream buffer filled; delivery ended with `delivery_aborted`.
    BufferFull,
    /// No delivery progress for the stall limit; delivery ended with
    /// `delivery_aborted`.
    Stalled,
    /// The drain aborted the call; the body was cut mid-stream.
    Cut,
}

impl Delivery {
    /// The metrics label of a `delivery_aborted` reason.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Open => "open",
            Self::Delivered => "delivered",
            Self::ClientGone => "client_gone",
            Self::BufferFull => "buffer_full",
            Self::Stalled => "stalled",
            Self::Cut => "cut",
        }
    }
}

/// One started call's terminal disposition. Identifiers, counts and timings
/// only — never a prompt, a completion or a token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallRecord {
    /// Process-local call number. Wave 2 replaces it with the `call_id`
    /// (UUIDv7) of chat-api.md §1.
    pub id: u64,
    /// How the upstream read ended.
    pub upstream: UpstreamEnd,
    /// Where delivery stood when it did.
    pub delivery: Delivery,
    /// The usage the upstream reported in its `usage` event, if it did.
    /// `None` is metering.md §5.4's estimate case (Wave 2).
    ///
    /// **Metering settles from this field, not from `outcome.usage`.** They
    /// can disagree: a provider that fails before any content may still
    /// report usage (a Responses `response.failed` with `usage`). That usage
    /// is kept in `outcome` for the record, but the call produced nothing,
    /// no `usage` event was delivered, and metering.md §5.2 charges it `0`
    /// — so it is not here.
    pub usage: Option<Usage>,
    /// How the provider call ended, from an upstream that knows
    /// ([`crate::call::Upstream::outcome`]): the finish reason, the failure
    /// and its phase, and the usage **or its explicit absence**
    /// ([`crate::provider::UsageReport::Missing`]). `None` when the call did
    /// not start, was drained mid-read, or its upstream cannot say.
    pub outcome: Option<crate::provider::ProviderOutcome>,
    /// Admission to upstream end.
    pub elapsed: Duration,
}

/// Where a finished call is handed. The gateway sends each call once; the
/// ledger operation behind a real settler is what makes a retry safe.
#[async_trait]
pub trait Settler: Send + Sync + 'static {
    /// Settle, release, or record `record`. Runs on a detached task. The call
    /// keeps counting against the concurrency limit until this returns, and
    /// shutdown bounds it by `settle_grace`.
    async fn settle(&self, record: CallRecord);
}

/// The stub: log the disposition, do nothing else.
#[derive(Clone, Copy, Debug, Default)]
pub struct LogSettler;

#[async_trait]
impl Settler for LogSettler {
    async fn settle(&self, record: CallRecord) {
        let elapsed_ms = u64::try_from(record.elapsed.as_millis()).unwrap_or(u64::MAX);
        match record.upstream {
            UpstreamEnd::Drained | UpstreamEnd::Panicked => tracing::warn!(
                call = record.id,
                upstream = record.upstream.label(),
                delivery = record.delivery.label(),
                usage_reported = record.usage.is_some(),
                elapsed_ms,
                "call aborted by drain; handed to settler"
            ),
            UpstreamEnd::Finished | UpstreamEnd::NotStarted => tracing::debug!(
                call = record.id,
                upstream = record.upstream.label(),
                delivery = record.delivery.label(),
                usage_reported = record.usage.is_some(),
                elapsed_ms,
                "call settled"
            ),
        }
    }
}

/// A record plus the concurrency slot it keeps occupied until settled.
#[derive(Debug)]
pub(crate) struct Settlement {
    pub(crate) record: CallRecord,
    /// Shared with the call's delivery; released when both are done.
    pub(crate) slot: Arc<Slot>,
}

/// The detached settler task: receive settlements, run the settler on each
/// concurrently (releasing each slot when its settle returns), and at `stop`
/// refuse new ones, finish the queue and wait for every settle in progress.
pub(crate) async fn run(
    settler: Arc<dyn Settler>,
    metrics: Arc<Metrics>,
    mut queue: mpsc::UnboundedReceiver<Settlement>,
    mut stop: watch::Receiver<bool>,
) {
    let mut running = JoinSet::new();
    let spawn = |running: &mut JoinSet<()>, settlement: Settlement| {
        metrics.record_settled(settlement.record.upstream);
        let settler = Arc::clone(&settler);
        running.spawn(async move {
            let Settlement { record, slot } = settlement;
            settler.settle(record).await;
            drop(slot);
        });
    };
    loop {
        tokio::select! {
            settlement = queue.recv() => {
                let Some(settlement) = settlement else { break };
                spawn(&mut running, settlement);
            }
            Some(_) = running.join_next(), if !running.is_empty() => {}
            () = crate::shutdown::raised(&mut stop) => break,
        }
    }
    // No settlement is accepted from here on; one sent after this is
    // reported by its sender (`call`), not lost silently.
    queue.close();
    while let Some(settlement) = queue.recv().await {
        spawn(&mut running, settlement);
    }
    while running.join_next().await.is_some() {}
}
