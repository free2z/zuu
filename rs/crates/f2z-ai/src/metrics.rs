//! Prometheus text exposition, hand-rolled.
//!
//! Hand-rolled for the reason `f2z-relay/src/metrics.rs` is: the whole of it
//! is a few atomics and a formatter, and the constraint that matters — **every
//! label value comes from a closed set** — is easier to hold when a label can
//! only be one of this module's own enums. There is no method here that takes
//! a model id, an app id, a user or a path, so a per-user or per-app series is
//! not something a later edit forgets to avoid; it is something that does not
//! compile. Those series belong in the ledger, which is authoritative for them,
//! not in a scraper's retention.
//!
//! | Series | Type | Meaning |
//! |---|---|---|
//! | `f2z_ai_requests_total{route,status}` | counter | Public requests by route (`chat`, `other`) and HTTP status |
//! | `f2z_ai_active_streams` | gauge | Admitted and not yet settled — a disconnected call still counts until its settle returns; what a drain waits for |
//! | `f2z_ai_delivery_buffered_bytes` | gauge | Undelivered event bytes across every stream (ADR 0001 budgets 10k × 256 KiB) |
//! | `f2z_ai_delivery_aborted_total{reason}` | counter | Delivery ended early while the upstream read continued: `buffer_full`, `stalled` |
//! | `f2z_ai_overhead_seconds` | histogram | Request received → response head. With no provider behind it this is the gateway's whole cost; once adapters land it becomes request → first upstream byte (the README's p50 < 8 ms, p99 < 25 ms) |
//! | `f2z_ai_rejected_total{reason}` | counter | Refused: `overloaded`, `draining` (at admission), `upload_budget` (before a body is read) |
//! | `f2z_ai_calls_settled_total{upstream}` | counter | Calls handed to the settler, by how the upstream read ended: `finished`, `drained`, `not_started`, `panicked` (a bug, never operational) |
//! | `f2z_ai_ready` / `f2z_ai_draining` | gauge | 1 or 0 |
//! | `f2z_ai_catalog_version` | gauge | The verified catalogue in use; 0 when there is none |
//! | `f2z_ai_catalog_replays_total` | counter | Catalogues refused as a replay: `issued_at` more than `catalog_version_regression_bound_secs` (420, the producer's bound) below the newest catalogue installed (`catalog::State::install`). The platform's own version dips stay inside the bound and never count, so **alert on any increase** — it means a replay, or a producer that broke its bound |

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::settle::{Delivery, UpstreamEnd};

/// The public route a request matched. A closed set: the raw path is never a
/// label, because a scanner requesting ten thousand distinct paths would
/// otherwise mint ten thousand series.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// `POST /v1/chat`.
    Chat,
    /// Anything else on the public listener.
    Other,
}

impl Route {
    /// Classify a request path.
    #[must_use]
    pub fn of(path: &str) -> Self {
        if path == "/v1/chat" {
            Self::Chat
        } else {
            Self::Other
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Other => "other",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Chat => 0,
            Self::Other => 1,
        }
    }
}

/// Why admission refused a request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rejection {
    /// `max_concurrent_calls` reached.
    Overloaded,
    /// The instance is draining.
    Draining,
    /// The gateway-wide budget for request bodies being read is spent.
    UploadBudget,
}

/// The statuses counted individually. Anything else is counted under `other`
/// — the set is closed so that the series count is too.
const STATUSES: [u16; 14] = [
    200, 400, 401, 402, 403, 404, 405, 409, 413, 429, 500, 501, 503, 504,
];
const STATUS_SLOTS: usize = STATUSES.len() + 1;
const ROUTES: [Route; 2] = [Route::Chat, Route::Other];

/// Upper bounds of the overhead histogram, in microseconds. Dense around the
/// README's 8 ms / 25 ms budget.
const BUCKETS_US: [u64; 12] = [
    500, 1_000, 2_500, 5_000, 8_000, 10_000, 25_000, 50_000, 100_000, 250_000, 1_000_000, 5_000_000,
];

/// Every counter the gateway keeps.
#[derive(Debug)]
pub struct Metrics {
    requests: [[AtomicU64; STATUS_SLOTS]; 2],
    overhead_buckets: [AtomicU64; BUCKETS_US.len()],
    overhead_count: AtomicU64,
    overhead_sum_us: AtomicU64,
    rejected_overloaded: AtomicU64,
    rejected_draining: AtomicU64,
    rejected_upload_budget: AtomicU64,
    settled: [AtomicU64; 4],
    delivery_aborted: [AtomicU64; 2],
    catalog_version: AtomicU64,
    catalog_replays: AtomicU64,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            requests: std::array::from_fn(|_| std::array::from_fn(|_| AtomicU64::new(0))),
            overhead_buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            overhead_count: AtomicU64::new(0),
            overhead_sum_us: AtomicU64::new(0),
            rejected_overloaded: AtomicU64::new(0),
            rejected_draining: AtomicU64::new(0),
            rejected_upload_budget: AtomicU64::new(0),
            settled: std::array::from_fn(|_| AtomicU64::new(0)),
            delivery_aborted: std::array::from_fn(|_| AtomicU64::new(0)),
            catalog_version: AtomicU64::new(0),
            catalog_replays: AtomicU64::new(0),
        }
    }
}

/// The values [`Metrics::render`] reads from elsewhere at scrape time.
#[derive(Clone, Copy, Debug)]
pub struct Gauges {
    /// Calls admitted and not yet settled.
    pub active_streams: usize,
    /// Undelivered event bytes across every stream.
    pub buffered_bytes: u64,
    /// Whether `/readyz` would answer 200.
    pub ready: bool,
    /// Whether a drain has begun.
    pub draining: bool,
}

fn status_slot(status: u16) -> usize {
    STATUSES
        .iter()
        .position(|s| *s == status)
        .unwrap_or(STATUSES.len())
}

const fn upstream_slot(end: UpstreamEnd) -> usize {
    match end {
        UpstreamEnd::Finished => 0,
        UpstreamEnd::Drained => 1,
        UpstreamEnd::NotStarted => 2,
        UpstreamEnd::Panicked => 3,
    }
}

const ABORT_REASONS: [Delivery; 2] = [Delivery::BufferFull, Delivery::Stalled];

impl Metrics {
    /// Count one finished request (response head sent) and its overhead.
    pub fn record_request(&self, route: Route, status: u16, overhead: Duration) {
        if let Some(slot) = self
            .requests
            .get(route.index())
            .and_then(|row| row.get(status_slot(status)))
        {
            slot.fetch_add(1, Ordering::Relaxed);
        }
        if route != Route::Chat {
            return;
        }
        let us = u64::try_from(overhead.as_micros()).unwrap_or(u64::MAX);
        for (bound, bucket) in BUCKETS_US.iter().zip(&self.overhead_buckets) {
            if us <= *bound {
                bucket.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.overhead_count.fetch_add(1, Ordering::Relaxed);
        self.overhead_sum_us.fetch_add(us, Ordering::Relaxed);
    }

    /// Count one admission refusal.
    pub fn record_rejection(&self, why: Rejection) {
        match why {
            Rejection::Overloaded => &self.rejected_overloaded,
            Rejection::Draining => &self.rejected_draining,
            Rejection::UploadBudget => &self.rejected_upload_budget,
        }
        .fetch_add(1, Ordering::Relaxed);
    }

    /// Count one call handed to the settler.
    pub fn record_settled(&self, end: UpstreamEnd) {
        if let Some(slot) = self.settled.get(upstream_slot(end)) {
            slot.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Count one delivery ended early. Only `BufferFull` and `Stalled` are
    /// counted; any other value is ignored.
    pub fn record_delivery_aborted(&self, reason: Delivery) {
        if let Some(slot) = ABORT_REASONS
            .iter()
            .position(|r| *r == reason)
            .and_then(|i| self.delivery_aborted.get(i))
        {
            slot.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Count one catalogue refused as a replay (`catalog::Installed::Older`).
    pub fn record_catalog_replay(&self) {
        self.catalog_replays.fetch_add(1, Ordering::Relaxed);
    }

    /// Record the catalogue version now in use (0: none).
    pub fn set_catalog_version(&self, version: u64) {
        self.catalog_version.store(version, Ordering::Relaxed);
    }

    /// The Prometheus text exposition (format 0.0.4).
    #[must_use]
    pub fn render(&self, gauges: Gauges) -> String {
        let mut out = String::new();
        let load = |a: &AtomicU64| a.load(Ordering::Relaxed);

        out.push_str("# HELP f2z_ai_requests_total Public requests by route and HTTP status.\n");
        out.push_str("# TYPE f2z_ai_requests_total counter\n");
        for route in ROUTES {
            let Some(row) = self.requests.get(route.index()) else {
                continue;
            };
            for (slot, counter) in row.iter().enumerate() {
                let status = STATUSES
                    .get(slot)
                    .map_or_else(|| "other".to_owned(), u16::to_string);
                let _ = writeln!(
                    out,
                    "f2z_ai_requests_total{{route=\"{}\",status=\"{status}\"}} {}",
                    route.label(),
                    load(counter)
                );
            }
        }

        out.push_str("# HELP f2z_ai_active_streams Calls whose response body has not ended.\n");
        out.push_str("# TYPE f2z_ai_active_streams gauge\n");
        let _ = writeln!(out, "f2z_ai_active_streams {}", gauges.active_streams);
        out.push_str("# HELP f2z_ai_delivery_buffered_bytes Undelivered event bytes.\n");
        out.push_str("# TYPE f2z_ai_delivery_buffered_bytes gauge\n");
        let _ = writeln!(
            out,
            "f2z_ai_delivery_buffered_bytes {}",
            gauges.buffered_bytes
        );
        out.push_str(
            "# HELP f2z_ai_delivery_aborted_total Deliveries ended early; the upstream read went on.\n",
        );
        out.push_str("# TYPE f2z_ai_delivery_aborted_total counter\n");
        for (reason, counter) in ABORT_REASONS.iter().zip(&self.delivery_aborted) {
            let _ = writeln!(
                out,
                "f2z_ai_delivery_aborted_total{{reason=\"{}\"}} {}",
                reason.label(),
                load(counter)
            );
        }

        out.push_str(
            "# HELP f2z_ai_overhead_seconds /v1/chat: request received to response head.\n",
        );
        out.push_str("# TYPE f2z_ai_overhead_seconds histogram\n");
        for (bound, bucket) in BUCKETS_US.iter().zip(&self.overhead_buckets) {
            let _ = writeln!(
                out,
                "f2z_ai_overhead_seconds_bucket{{le=\"{}\"}} {}",
                micros_as_seconds(*bound),
                load(bucket)
            );
        }
        let count = load(&self.overhead_count);
        let _ = writeln!(out, "f2z_ai_overhead_seconds_bucket{{le=\"+Inf\"}} {count}");
        let _ = writeln!(
            out,
            "f2z_ai_overhead_seconds_sum {}",
            micros_as_seconds(load(&self.overhead_sum_us))
        );
        let _ = writeln!(out, "f2z_ai_overhead_seconds_count {count}");

        out.push_str("# HELP f2z_ai_rejected_total Requests refused at admission.\n");
        out.push_str("# TYPE f2z_ai_rejected_total counter\n");
        let _ = writeln!(
            out,
            "f2z_ai_rejected_total{{reason=\"overloaded\"}} {}",
            load(&self.rejected_overloaded)
        );
        let _ = writeln!(
            out,
            "f2z_ai_rejected_total{{reason=\"draining\"}} {}",
            load(&self.rejected_draining)
        );
        let _ = writeln!(
            out,
            "f2z_ai_rejected_total{{reason=\"upload_budget\"}} {}",
            load(&self.rejected_upload_budget)
        );

        out.push_str("# HELP f2z_ai_calls_settled_total Calls handed to the settler.\n");
        out.push_str("# TYPE f2z_ai_calls_settled_total counter\n");
        for end in [
            UpstreamEnd::Finished,
            UpstreamEnd::Drained,
            UpstreamEnd::NotStarted,
            UpstreamEnd::Panicked,
        ] {
            let value = self.settled.get(upstream_slot(end)).map_or(0, load);
            let _ = writeln!(
                out,
                "f2z_ai_calls_settled_total{{upstream=\"{}\"}} {value}",
                end.label()
            );
        }

        out.push_str("# HELP f2z_ai_ready 1 when /readyz answers 200.\n");
        out.push_str("# TYPE f2z_ai_ready gauge\n");
        let _ = writeln!(out, "f2z_ai_ready {}", u8::from(gauges.ready));
        out.push_str("# HELP f2z_ai_draining 1 once a drain has begun.\n");
        out.push_str("# TYPE f2z_ai_draining gauge\n");
        let _ = writeln!(out, "f2z_ai_draining {}", u8::from(gauges.draining));
        out.push_str("# HELP f2z_ai_catalog_version The verified catalogue in use; 0 if none.\n");
        out.push_str("# TYPE f2z_ai_catalog_version gauge\n");
        let _ = writeln!(
            out,
            "f2z_ai_catalog_version {}",
            load(&self.catalog_version)
        );
        out.push_str(
            "# HELP f2z_ai_catalog_replays_total Catalogues refused as a replay of an older one.\n",
        );
        out.push_str("# TYPE f2z_ai_catalog_replays_total counter\n");
        let _ = writeln!(
            out,
            "f2z_ai_catalog_replays_total {}",
            load(&self.catalog_replays)
        );
        out
    }
}

/// `1500` µs → `"0.0015"`, exactly, with integer arithmetic only.
fn micros_as_seconds(us: u64) -> String {
    let whole = us.checked_div(1_000_000).unwrap_or(0);
    let frac = us.checked_rem(1_000_000).unwrap_or(0);
    if frac == 0 {
        return whole.to_string();
    }
    let digits = format!("{frac:06}");
    format!("{whole}.{}", digits.trim_end_matches('0'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_render_exactly() {
        assert_eq!(micros_as_seconds(500), "0.0005");
        assert_eq!(micros_as_seconds(8_000), "0.008");
        assert_eq!(micros_as_seconds(1_000_000), "1");
        assert_eq!(micros_as_seconds(1_250_000), "1.25");
        assert_eq!(micros_as_seconds(0), "0");
    }

    #[test]
    fn a_histogram_observation_lands_in_every_bucket_at_or_above_it() {
        let m = Metrics::default();
        m.record_request(Route::Chat, 501, Duration::from_millis(7));
        let text = m.render(Gauges {
            active_streams: 0,
            buffered_bytes: 0,
            ready: true,
            draining: false,
        });
        assert!(
            text.contains("f2z_ai_overhead_seconds_bucket{le=\"0.005\"} 0"),
            "{text}"
        );
        assert!(
            text.contains("f2z_ai_overhead_seconds_bucket{le=\"0.008\"} 1"),
            "{text}"
        );
        assert!(
            text.contains("f2z_ai_overhead_seconds_bucket{le=\"+Inf\"} 1"),
            "{text}"
        );
        assert!(text.contains("f2z_ai_overhead_seconds_sum 0.007"), "{text}");
        assert!(
            text.contains("f2z_ai_requests_total{route=\"chat\",status=\"501\"} 1"),
            "{text}"
        );
    }

    #[test]
    fn an_uncounted_status_falls_into_other_rather_than_minting_a_series() {
        let m = Metrics::default();
        m.record_request(Route::Other, 418, Duration::ZERO);
        let text = m.render(Gauges {
            active_streams: 0,
            buffered_bytes: 0,
            ready: false,
            draining: false,
        });
        assert!(
            text.contains("f2z_ai_requests_total{route=\"other\",status=\"other\"} 1"),
            "{text}"
        );
        assert!(!text.contains("418"), "{text}");
    }

    #[test]
    fn route_classification_never_uses_the_raw_path_as_a_label() {
        assert_eq!(Route::of("/v1/chat"), Route::Chat);
        assert_eq!(Route::of("/v1/chat/"), Route::Other);
        assert_eq!(Route::of("/../../etc/passwd"), Route::Other);
    }
}
