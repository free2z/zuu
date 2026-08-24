//! The relay's clock, made steerable.
//!
//! `f2z-relay-proto` is deliberately clock-free: every rule that needs the time
//! takes it as an argument, because the same code has to run in a browser. That
//! leaves somebody holding the clock, and in a test harness it should be the
//! test.
//!
//! Three things in `WIRE.md` are only reachable by moving time:
//!
//! - `ERR_STALE_TIMESTAMP` (§5.5) needs a client and a relay that disagree by
//!   more than `clock_skew_ms`.
//! - Message TTL and queue idle TTL (§7.7) are seven days and ninety days.
//!   Nobody tests those by waiting.
//! - The seen-set ages entries out on a wall-clock schedule (§5.5), and the
//!   `antireplay_window_ms < 2 × clock_skew_ms` defect of [#586] is a statement
//!   about exactly that schedule.
//!
//! So [`Clock::manual`] freezes time and lets a test step it, and
//! [`Clock::system`] follows the wall clock with an adjustable offset for the
//! cases where a real listener wants real time. Both are cheap to clone and
//! shared by every connection of one relay, because a relay has one clock.
//!
//! [#586]: https://github.com/free2z/zuu/issues/586

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// A relay clock, in milliseconds since the Unix epoch.
#[derive(Clone, Debug)]
pub struct Clock {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    /// `Some` for a frozen clock: the current value, stepped by `advance`.
    frozen: Option<AtomicU64>,
    /// Applied to both modes, so a system-time relay can also be nudged.
    offset_ms: AtomicI64,
}

impl Clock {
    /// A clock that follows the host's wall clock.
    ///
    /// This is what `f2z-fakerelay` runs on: a client developer pointing a real
    /// application at the endpoint expects `relay_time_ms` to be the real time,
    /// because their own `timestamp_ms` will be.
    #[must_use]
    pub fn system() -> Self {
        Self {
            inner: Arc::new(Inner {
                frozen: None,
                offset_ms: AtomicI64::new(0),
            }),
        }
    }

    /// A clock frozen at `now_ms`, moved only by [`Clock::advance`] and
    /// [`Clock::set`].
    ///
    /// Frozen is the default for the in-process relay. A test that asserts on a
    /// timestamp window or a TTL must not also be a test of how long the CI
    /// runner took to schedule a task.
    #[must_use]
    pub fn manual(now_ms: u64) -> Self {
        Self {
            inner: Arc::new(Inner {
                frozen: Some(AtomicU64::new(now_ms)),
                offset_ms: AtomicI64::new(0),
            }),
        }
    }

    /// The current relay time, in milliseconds since the Unix epoch.
    #[must_use]
    pub fn now_ms(&self) -> u64 {
        let base = match &self.inner.frozen {
            Some(frozen) => frozen.load(Ordering::SeqCst),
            None => u64::try_from(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |since| since.as_millis()),
            )
            .unwrap_or(u64::MAX),
        };
        let offset = self.inner.offset_ms.load(Ordering::SeqCst);
        if offset >= 0 {
            base.saturating_add(u64::try_from(offset).unwrap_or(0))
        } else {
            base.saturating_sub(offset.unsigned_abs())
        }
    }

    /// Move time forward by `millis`.
    ///
    /// Works in both modes: on a frozen clock it steps the value, on a system
    /// clock it moves the offset, so a test can make a relay's clock disagree
    /// with its own by a known amount without touching the host.
    pub fn advance(&self, millis: u64) {
        match &self.inner.frozen {
            Some(frozen) => {
                let _ = frozen.fetch_add(millis, Ordering::SeqCst);
            }
            None => {
                let step = i64::try_from(millis).unwrap_or(i64::MAX);
                let _ = self.inner.offset_ms.fetch_add(step, Ordering::SeqCst);
            }
        }
    }

    /// Move time backward by `millis`. A relay whose clock went backwards is a
    /// real operational event, and `ERR_STALE_TIMESTAMP` has a future half.
    pub fn rewind(&self, millis: u64) {
        match &self.inner.frozen {
            Some(frozen) => {
                let _ = frozen.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                    Some(current.saturating_sub(millis))
                });
            }
            None => {
                let step = i64::try_from(millis).unwrap_or(i64::MAX);
                let _ = self.inner.offset_ms.fetch_sub(step, Ordering::SeqCst);
            }
        }
    }

    /// Set a frozen clock to an absolute time. A no-op on a system clock, whose
    /// base is not ours to set.
    pub fn set(&self, now_ms: u64) {
        if let Some(frozen) = &self.inner.frozen {
            frozen.store(now_ms, Ordering::SeqCst);
        }
    }

    /// Whether this clock is frozen.
    #[must_use]
    pub fn is_manual(&self) -> bool {
        self.inner.frozen.is_some()
    }
}

impl Default for Clock {
    /// Frozen at a fixed, arbitrary instant in 2027, so that a default-built
    /// relay produces the same timestamps on every run and in every timezone.
    fn default() -> Self {
        Self::manual(DEFAULT_EPOCH_MS)
    }
}

/// The instant [`Clock::default`] freezes at: 2027-01-01T00:00:00Z.
///
/// Any fixed value would do. It is in the future rather than the past so that a
/// test which subtracts a TTL from it does not underflow into 1970.
pub const DEFAULT_EPOCH_MS: u64 = 1_798_761_600_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frozen_clock_does_not_move_on_its_own() {
        let clock = Clock::manual(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(500);
        assert_eq!(clock.now_ms(), 1_500);
        clock.rewind(2_000);
        assert_eq!(clock.now_ms(), 0);
        clock.set(42);
        assert_eq!(clock.now_ms(), 42);
    }

    #[test]
    fn clones_share_one_clock() {
        let clock = Clock::manual(0);
        let other = clock.clone();
        clock.advance(7);
        assert_eq!(other.now_ms(), 7);
    }

    #[test]
    fn a_system_clock_can_still_be_nudged() {
        let clock = Clock::system();
        let before = clock.now_ms();
        clock.advance(60_000);
        assert!(clock.now_ms() >= before.saturating_add(60_000));
        assert!(!clock.is_manual());
    }

    #[test]
    fn the_default_is_frozen_and_reproducible() {
        assert_eq!(Clock::default().now_ms(), DEFAULT_EPOCH_MS);
        assert!(Clock::default().is_manual());
    }
}
