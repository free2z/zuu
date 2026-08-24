//! The tick: §7.7's two timers, §5.5's seen-set, and §13.1 layer 4's
//! measurement.
//!
//! # Why expiry is a timer and not a lazy check
//!
//! A relay could sweep on every command, as `f2z-relay-testkit` does — that is
//! the right choice for a harness whose clock a test steers, because it makes
//! the consequence of moving time visible on the very next request. It is the
//! wrong choice for a server: the sweep is a range scan over an index, and
//! paying for it on every `READ` puts a cost proportional to the *whole store*
//! on the path of an operation §13.1 says must never be refused.
//!
//! So it runs on a period, and the honest consequence is that a message lives
//! for up to `expiry_tick_seconds` past its TTL. That is a policy statement
//! about a seven-day timer, not a correctness one: §7.7's guarantee is that
//! undelivered ciphertext is dropped after the TTL, and dropping it a minute
//! late does not break anything the TTL protects.
//!
//! # What the tick also does
//!
//! - **Ages the seen-set** (§5.5). It is bounded and fail-closed — on reaching
//!   `antireplay_seen_max` the relay refuses new signed commands rather than
//!   evicting — so a relay that never aged entries out would be a relay that
//!   stopped accepting signatures after a while. Aging is what keeps the bound
//!   a bound rather than a ceiling.
//! - **Drops expired challenges**, for the same reason.
//! - **Measures the store and sets §13.1 layer 4.** The high-water mark is
//!   compared against what the storage engine has actually allocated, not
//!   against what the relay believes it wrote: page overhead, free pages and the
//!   write-ahead log are all real disk, and an operator's disk fills with all
//!   three.
//! - **Announces expiry to subscribed readers** as `QUEUE_EVENT` (§6.4). Expiry
//!   is silent to a writer, always.

use std::sync::Arc;
use std::time::Duration;

use f2z_relay_store::ExpiryReason;
use tokio::sync::watch;

use crate::engine::Relay;
use crate::metrics::Metrics;

/// Run the tick until `shutdown` flips.
pub async fn run(relay: Arc<Relay>, mut shutdown: watch::Receiver<bool>) {
    let period = Duration::from_secs(u64::from(relay.config().queues.expiry_tick_seconds.max(1)));
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick fires immediately, which is what we want: a relay that has
    // just restarted after an outage may be holding a great deal that expired
    // while it was down.
    loop {
        tokio::select! {
            biased;
            _ = shutdown.changed() => return,
            _ = ticker.tick() => {}
        }
        tick(&relay);
    }
}

/// One sweep. Public so a test can run it without waiting for a period.
pub fn tick(relay: &Arc<Relay>) {
    let now = crate::now_ms();
    let metrics = relay.metrics();

    match relay.store().expire(now) {
        Ok(committed) => {
            let report = committed.into_inner();
            if !report.is_empty() {
                Metrics::add(&metrics.messages_expired, report.messages_expired);
                Metrics::add(&metrics.queues_expired, report.queues_expired);
                crate::log_debug!(
                    "expiry sweep",
                    "queues" = u32::try_from(report.queues_expired).unwrap_or(u32::MAX),
                    "messages" = u32::try_from(report.messages_expired).unwrap_or(u32::MAX),
                );
            }
            for expired in report.expired {
                // §6.4: reason 2 for an idle-expired queue, reason 3 for
                // TTL-expired messages. Both go to a subscribed **reader**;
                // §7.7 makes expiry silent to a writer.
                relay.subscriptions().notify_queue_event(
                    expired.recv_addr,
                    match expired.reason {
                        ExpiryReason::IdleTtl => 2,
                        ExpiryReason::MessageTtl => 3,
                    },
                    metrics,
                );
            }
        }
        Err(_) => {
            // §10's code 21 carries no detail on the wire; the operator's log is
            // where a failing sweep is said, and it is said without the error's
            // own text, which could name a value.
            crate::log_error!("expiry sweep failed");
        }
    }

    let (seen_entries, challenges) = relay.sweep_memory(now);
    Metrics::set(
        &metrics.antireplay_entries,
        u64::try_from(seen_entries).unwrap_or(u64::MAX),
    );
    Metrics::set(
        &metrics.challenges_outstanding,
        u64::try_from(challenges).unwrap_or(u64::MAX),
    );
    let dropped = relay.abuse().sweep(now);
    if dropped > 0 {
        crate::log_trace!(
            "rate-limiter rows dropped",
            "rows" = u32::try_from(dropped).unwrap_or(u32::MAX)
        );
    }

    // §13.1 layer 4, measured rather than assumed.
    if let Ok(stats) = relay.store().stats() {
        Metrics::set(&metrics.stored_messages, stats.messages);
        Metrics::set(&metrics.stored_payload_bytes, stats.payload_bytes);
        Metrics::set(&metrics.storage_bytes, stats.storage_bytes);
        Metrics::set(
            &metrics.queues,
            stats.queues.saturating_add(stats.contact_queues),
        );

        let high_water = relay.config().limits.storage_high_water_bytes;
        let over = high_water > 0 && stats.storage_bytes >= high_water;
        if relay.abuse().set_backpressure(over) {
            // Logged on the transition, not on the level: a relay that has been
            // backpressured for an hour should not have written 3,600 lines
            // saying so.
            if over {
                crate::log_warn!("backpressure on: storage at or above the high-water mark");
            } else {
                crate::log_info!("backpressure off");
            }
        }
        Metrics::set(&metrics.backpressure, u64::from(over));
    }
}
