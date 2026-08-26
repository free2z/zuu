//! Counters, and the labels they deliberately do not carry.
//!
//! # An unconsidered metrics endpoint is a metadata leak
//!
//! The obvious Prometheus design for a relay is
//! `f2z_relay_queue_messages{queue="…"}` and
//! `f2z_relay_connections{remote="…"}`, and both are the whole threat model
//! walking out of the side door. A per-queue series is a per-conversation
//! activity trace with timestamps — exactly what [ADR 0004] refuses to let the
//! protocol disclose — and it survives in the scraper's storage long after the
//! relay has deleted the ciphertext. A per-IP series is a connection log.
//!
//! So there are **no labels here at all**. Every series is a single number about
//! the relay as a whole, and the type system helps: [`Metrics`] has no method
//! that takes a queue address, a peer address or a key, so a per-queue series is
//! not something a future edit forgets to avoid — it is something that does not
//! compile.
//!
//! `/metrics` is also loopback-only ([`crate::config::Admin`]), because "no
//! labels" bounds what one scrape says and does not make totals public.
//!
//! # What `/healthz` may not say
//!
//! `/healthz` is constant, cheap and carries **no numbers**. Reporting queue
//! depth or connection counts there would put the same aggregate on an endpoint
//! whose whole purpose is to be polled every few seconds by something that keeps
//! history — and a load balancer's health-check log is not a place anyone
//! reviews for metadata.
//!
//! [ADR 0004]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0004-metadata-ambition.md

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};

/// Every counter the relay keeps.
#[derive(Debug, Default)]
pub struct Metrics {
    /// Connections accepted since start.
    pub connections_accepted: AtomicU64,
    /// Connections refused by §13.1 layer 1 or layer 4.
    pub connections_refused: AtomicU64,
    /// Connections currently open.
    pub connections_open: AtomicU64,
    /// Frames decoded, whatever they turned out to be.
    pub frames_received: AtomicU64,
    /// Frames written.
    pub frames_sent: AtomicU64,
    /// Commands that returned status 0.
    pub commands_ok: AtomicU64,
    /// Commands that returned a §10 code.
    pub commands_refused: AtomicU64,
    /// Appends admitted and made durable.
    pub appends_committed: AtomicU64,
    /// Store transactions the group-commit writer ran. The ratio of
    /// `appends_committed` to this is the amortization §8.4 is about.
    pub commit_transactions: AtomicU64,
    /// Messages deleted by an `ACK`.
    pub messages_acked: AtomicU64,
    /// Messages dropped by the message TTL (§7.7).
    pub messages_expired: AtomicU64,
    /// Queues removed by the idle TTL (§7.7).
    pub queues_expired: AtomicU64,
    /// Challenges issued (§6.1).
    pub challenges_issued: AtomicU64,
    /// Stamps refused as invalid, expired, misscoped or already spent.
    pub stamps_refused: AtomicU64,
    /// Pushes dropped because a connection's outbound queue was full — the
    /// backpressure signal, and only that. A push to a subscriber whose
    /// receiver is gone is counted by `pushes_to_closed` instead, because the
    /// two call for opposite responses and mixing them made this number lie
    /// during ordinary disconnect churn (zuu#676).
    pub pushes_dropped: AtomicU64,
    /// Pushes dropped because the subscriber's receiver was gone: its writer
    /// task ended and `drop_connection` has not run yet. Not backpressure —
    /// there is no capacity to raise — but a sustained rise is still a signal,
    /// about teardown rather than about the queue.
    pub pushes_to_closed: AtomicU64,
    /// 1 while §13.1 layer 4 is on.
    pub backpressure: AtomicU64,
    /// Messages currently stored, as of the last expiry tick.
    pub stored_messages: AtomicU64,
    /// Payload bytes currently stored, as of the last expiry tick.
    pub stored_payload_bytes: AtomicU64,
    /// Bytes the storage engine has allocated, as of the last expiry tick.
    pub storage_bytes: AtomicU64,
    /// Queues that exist, as of the last expiry tick.
    pub queues: AtomicU64,
    /// Entries in the anti-replay seen-set (§5.5).
    pub antireplay_entries: AtomicU64,
    /// Outstanding challenges.
    pub challenges_outstanding: AtomicU64,
}

impl Metrics {
    /// A fresh set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add to a counter.
    pub fn add(counter: &AtomicU64, delta: u64) {
        counter.fetch_add(delta, Ordering::Relaxed);
    }

    /// Add one.
    pub fn inc(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    /// Subtract one, saturating at zero.
    pub fn dec(counter: &AtomicU64) {
        let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(value.saturating_sub(1))
        });
    }

    /// Overwrite a gauge.
    pub fn set(counter: &AtomicU64, value: u64) {
        counter.store(value, Ordering::Relaxed);
    }

    /// The Prometheus text exposition of every series.
    ///
    /// One `HELP`, one `TYPE` and one unlabelled sample each. There is no code
    /// path here that emits a label, and adding one would need a different
    /// function.
    #[must_use]
    pub fn render(&self) -> String {
        const SERIES: [(&str, &str, &str); 23] = [
            (
                "f2z_relay_connections_accepted_total",
                "counter",
                "Connections accepted since start.",
            ),
            (
                "f2z_relay_connections_refused_total",
                "counter",
                "Connections refused by anti-abuse.",
            ),
            (
                "f2z_relay_connections_open",
                "gauge",
                "Connections currently open.",
            ),
            (
                "f2z_relay_frames_received_total",
                "counter",
                "Binary frames received.",
            ),
            ("f2z_relay_frames_sent_total", "counter", "Frames written."),
            (
                "f2z_relay_commands_ok_total",
                "counter",
                "Commands that returned status 0.",
            ),
            (
                "f2z_relay_commands_refused_total",
                "counter",
                "Commands that returned an error code.",
            ),
            (
                "f2z_relay_appends_committed_total",
                "counter",
                "Appends made durable.",
            ),
            (
                "f2z_relay_commit_transactions_total",
                "counter",
                "Store transactions run by the group-commit writer.",
            ),
            (
                "f2z_relay_messages_acked_total",
                "counter",
                "Messages deleted by an ACK.",
            ),
            (
                "f2z_relay_messages_expired_total",
                "counter",
                "Messages dropped by the message TTL.",
            ),
            (
                "f2z_relay_queues_expired_total",
                "counter",
                "Queues removed by the idle TTL.",
            ),
            (
                "f2z_relay_challenges_issued_total",
                "counter",
                "Challenges issued.",
            ),
            (
                "f2z_relay_stamps_refused_total",
                "counter",
                "Proof-of-work stamps refused.",
            ),
            (
                "f2z_relay_pushes_dropped_total",
                "counter",
                "Pushes dropped for a full outbound queue, not for a gone subscriber.",
            ),
            (
                "f2z_relay_pushes_to_closed_total",
                "counter",
                "Pushes dropped because the subscriber's receiver was gone.",
            ),
            (
                "f2z_relay_backpressure",
                "gauge",
                "1 while global backpressure is on.",
            ),
            (
                "f2z_relay_stored_messages",
                "gauge",
                "Messages stored, at the last sweep.",
            ),
            (
                "f2z_relay_stored_payload_bytes",
                "gauge",
                "Payload bytes stored, at the last sweep.",
            ),
            (
                "f2z_relay_storage_bytes",
                "gauge",
                "Bytes the storage engine has allocated.",
            ),
            (
                "f2z_relay_queues",
                "gauge",
                "Queues that exist, at the last sweep.",
            ),
            (
                "f2z_relay_antireplay_entries",
                "gauge",
                "Entries in the anti-replay seen-set.",
            ),
            (
                "f2z_relay_challenges_outstanding",
                "gauge",
                "Challenges not yet spent or expired.",
            ),
        ];
        let values = [
            &self.connections_accepted,
            &self.connections_refused,
            &self.connections_open,
            &self.frames_received,
            &self.frames_sent,
            &self.commands_ok,
            &self.commands_refused,
            &self.appends_committed,
            &self.commit_transactions,
            &self.messages_acked,
            &self.messages_expired,
            &self.queues_expired,
            &self.challenges_issued,
            &self.stamps_refused,
            &self.pushes_dropped,
            &self.pushes_to_closed,
            &self.backpressure,
            &self.stored_messages,
            &self.stored_payload_bytes,
            &self.storage_bytes,
            &self.queues,
            &self.antireplay_entries,
            &self.challenges_outstanding,
        ];

        let mut out = String::with_capacity(2048);
        for (index, (name, kind, help)) in SERIES.iter().enumerate() {
            let Some(counter) = values.get(index) else {
                continue;
            };
            let _ = writeln!(out, "# HELP {name} {help}");
            let _ = writeln!(out, "# TYPE {name} {kind}");
            let _ = writeln!(out, "{name} {}", counter.load(Ordering::Relaxed));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_series_carries_a_label() {
        let metrics = Metrics::new();
        let rendered = metrics.render();
        for line in rendered.lines() {
            if line.starts_with('#') {
                continue;
            }
            assert!(
                !line.contains('{'),
                "a labelled series would be a metadata leak: {line}"
            );
        }
    }

    #[test]
    fn every_series_is_declared_and_sampled_exactly_once() {
        let rendered = Metrics::new().render();
        let helps = rendered
            .lines()
            .filter(|line| line.starts_with("# HELP"))
            .count();
        let types = rendered
            .lines()
            .filter(|line| line.starts_with("# TYPE"))
            .count();
        let samples = rendered
            .lines()
            .filter(|line| !line.starts_with('#') && !line.is_empty())
            .count();
        assert_eq!(helps, 23);
        assert_eq!(types, 23);
        assert_eq!(samples, 23);
    }

    #[test]
    fn counters_move_and_gauges_saturate() {
        let metrics = Metrics::new();
        Metrics::inc(&metrics.connections_open);
        Metrics::dec(&metrics.connections_open);
        Metrics::dec(&metrics.connections_open);
        assert!(metrics.render().contains("f2z_relay_connections_open 0"));
        Metrics::add(&metrics.appends_committed, 7);
        assert!(
            metrics
                .render()
                .contains("f2z_relay_appends_committed_total 7")
        );
        Metrics::set(&metrics.storage_bytes, 4_096);
        assert!(metrics.render().contains("f2z_relay_storage_bytes 4096"));
    }

    #[test]
    fn the_two_push_drop_causes_are_separate_series() {
        // zuu#676. `SERIES` and `values` are parallel arrays, so this also
        // proves the new name is sampled from the counter it names: a
        // misaligned insert would print the increment under the wrong series.
        let metrics = Metrics::new();
        Metrics::inc(&metrics.pushes_to_closed);
        let rendered = metrics.render();
        assert!(
            rendered.contains("f2z_relay_pushes_to_closed_total 1"),
            "{rendered}"
        );
        assert!(
            rendered.contains("f2z_relay_pushes_dropped_total 0"),
            "{rendered}"
        );
    }
}
