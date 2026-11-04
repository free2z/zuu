//! Retries and the circuit breaker, per provider.
//!
//! **When a retry is allowed at all** is the call's business, not this
//! module's: only before the first content event — before anything reached
//! the client and before the gateway committed to the model (the ADR table in
//! `docs/free2z/ai-gateway/README.md`). This module decides **whether one more** is
//! affordable:
//!
//! * [`RetryPolicy`] — per call: at most `max_retries` retries, exponential
//!   backoff with jitter, a provider `retry-after` honoured only up to
//!   `max_retry_after` (a longer one is not waited out on a user's call —
//!   `fallback` is the client-visible way round it).
//! * [`RetryBudget`] — per provider: retries may add at most `ratio` of the
//!   primary traffic, plus a small floor so a quiet gateway can still retry.
//!   Without it a provider brown-out is multiplied by `1 + max_retries`
//!   exactly when the provider can least take it.
//! * [`CircuitBreaker`] — per provider: `failure_threshold` consecutive
//!   provider failures open it for `open_for`; while open, a call fails at
//!   once with `unavailable` (`details.reason: provider_circuit_open`,
//!   errors.md §2) instead of waiting out a connect timeout; then one probe is
//!   let through, and its result closes or re-opens it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Per-call retry rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Retries after the first attempt.
    pub max_retries: u32,
    /// The first backoff; doubled per retry.
    pub base_backoff: Duration,
    /// The largest backoff.
    pub max_backoff: Duration,
    /// The longest provider `retry-after` the gateway waits out.
    pub max_retry_after: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            base_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(1),
            max_retry_after: Duration::from_secs(2),
        }
    }
}

impl RetryPolicy {
    /// The wait before retry number `retry` (1-based), or `None` when the
    /// provider asked for longer than [`RetryPolicy::max_retry_after`].
    /// Jitter is "equal jitter": half fixed, half spread by `seed`.
    #[must_use]
    pub fn backoff(
        &self,
        retry: u32,
        retry_after: Option<Duration>,
        seed: u64,
    ) -> Option<Duration> {
        if let Some(after) = retry_after {
            return (after <= self.max_retry_after).then_some(after);
        }
        let exp = self
            .base_backoff
            .saturating_mul(
                1u32.checked_shl(retry.saturating_sub(1))
                    .unwrap_or(u32::MAX),
            )
            .min(self.max_backoff);
        let half = exp.checked_div(2).unwrap_or_default();
        let spread = u64::try_from(half.as_micros()).unwrap_or(u64::MAX);
        let jitter = seed.checked_rem(spread.saturating_add(1)).unwrap_or(0);
        Some(half.saturating_add(Duration::from_micros(jitter)))
    }
}

/// A token bucket for retries, in thousandths of a retry.
#[derive(Debug)]
pub struct RetryBudget {
    milli: AtomicU64,
    /// Deposited per primary attempt: `ratio × 1000`.
    deposit: u64,
    /// The bucket's ceiling.
    max: u64,
}

impl RetryBudget {
    /// A budget of `ratio_percent`% of primary attempts, holding at most
    /// `burst` retries and starting full.
    #[must_use]
    pub fn new(ratio_percent: u64, burst: u64) -> Self {
        let max = burst.saturating_mul(1000);
        Self {
            milli: AtomicU64::new(max),
            deposit: ratio_percent.saturating_mul(10),
            max,
        }
    }

    /// A primary attempt was made.
    pub fn deposit(&self) {
        let _ = self
            .milli
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                Some(n.saturating_add(self.deposit).min(self.max))
            });
    }

    /// Take one retry, if the budget has one.
    pub fn withdraw(&self) -> bool {
        self.milli
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_sub(1000))
            .is_ok()
    }

    /// Retries currently available, in thousandths.
    #[must_use]
    pub fn available_milli(&self) -> u64 {
        self.milli.load(Ordering::Acquire)
    }
}

impl Default for RetryBudget {
    /// 10 % of traffic, bursting to 20 retries.
    fn default() -> Self {
        Self::new(10, 20)
    }
}

/// The breaker's tuning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BreakerPolicy {
    /// Consecutive provider failures that open the breaker.
    pub failure_threshold: u32,
    /// How long it stays open before a probe.
    pub open_for: Duration,
}

impl Default for BreakerPolicy {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            open_for: Duration::from_secs(10),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BreakerState {
    Closed {
        failures: u32,
    },
    Open {
        until: Instant,
    },
    /// One probe is out; everyone else is refused until it reports.
    HalfOpen,
}

/// A consecutive-failure circuit breaker.
#[derive(Debug)]
pub struct CircuitBreaker {
    policy: BreakerPolicy,
    state: Mutex<BreakerState>,
}

/// How an attempt went, for the breaker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The provider answered and streamed to its end.
    Success,
    /// A provider-side failure: connect, timeout, 5xx, overload, a cut
    /// stream.
    Failure,
    /// Says nothing about the provider's health: a request it refused (4xx
    /// other than 408/429), or an attempt abandoned by a drain.
    Neutral,
}

/// Permission to make one attempt. Report the result with
/// [`Permit::record`]; dropping it unreported is [`Verdict::Neutral`].
#[derive(Debug)]
pub struct Permit {
    breaker: Arc<CircuitBreaker>,
    probe: bool,
    done: bool,
}

impl CircuitBreaker {
    /// A closed breaker.
    #[must_use]
    pub fn new(policy: BreakerPolicy) -> Self {
        Self {
            policy,
            state: Mutex::new(BreakerState::Closed { failures: 0 }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BreakerState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Whether an attempt may go out now.
    pub fn try_acquire(self: &Arc<Self>, now: Instant) -> Option<Permit> {
        let mut state = self.lock();
        match *state {
            BreakerState::Closed { .. } => Some(Permit {
                breaker: Arc::clone(self),
                probe: false,
                done: false,
            }),
            BreakerState::Open { until } if now >= until => {
                *state = BreakerState::HalfOpen;
                Some(Permit {
                    breaker: Arc::clone(self),
                    probe: true,
                    done: false,
                })
            }
            BreakerState::Open { .. } | BreakerState::HalfOpen => None,
        }
    }

    /// Whether the breaker is refusing attempts now.
    #[must_use]
    pub fn is_open(&self, now: Instant) -> bool {
        match *self.lock() {
            BreakerState::Closed { .. } => false,
            BreakerState::Open { until } => now < until,
            BreakerState::HalfOpen => true,
        }
    }

    fn report(&self, probe: bool, verdict: Verdict, now: Instant) {
        let mut state = self.lock();
        *state = match (verdict, *state) {
            // Only the probe closes a tripped breaker. A success from an
            // attempt that started before it tripped is stale: it says
            // nothing about the provider now, and letting it close the
            // breaker would skip the cooldown while the outage is live.
            (Verdict::Success, BreakerState::Closed { .. }) => BreakerState::Closed { failures: 0 },
            (Verdict::Success, BreakerState::HalfOpen) if probe => {
                BreakerState::Closed { failures: 0 }
            }
            (Verdict::Failure, BreakerState::Closed { failures }) => {
                let failures = failures.saturating_add(1);
                if failures >= self.policy.failure_threshold {
                    tracing::warn!(failures, "provider circuit breaker opened");
                    BreakerState::Open {
                        until: now.checked_add(self.policy.open_for).unwrap_or(now),
                    }
                } else {
                    BreakerState::Closed { failures }
                }
            }
            (Verdict::Failure, BreakerState::HalfOpen) if probe => BreakerState::Open {
                until: now.checked_add(self.policy.open_for).unwrap_or(now),
            },
            // A neutral probe frees the half-open slot for the next caller.
            (Verdict::Neutral, BreakerState::HalfOpen) if probe => {
                BreakerState::Open { until: now }
            }
            (_, other) => other,
        };
    }
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(BreakerPolicy::default())
    }
}

impl Permit {
    /// Whether this is the half-open breaker's single probe.
    #[must_use]
    pub const fn is_probe(&self) -> bool {
        self.probe
    }

    /// Report the attempt's result.
    pub fn record(mut self, verdict: Verdict) {
        self.done = true;
        self.breaker.report(self.probe, verdict, Instant::now());
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        if !self.done {
            self.breaker
                .report(self.probe, Verdict::Neutral, Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_caps_retries_at_its_ratio_after_the_burst() {
        let budget = RetryBudget::new(10, 2);
        assert!(budget.withdraw());
        assert!(budget.withdraw());
        assert!(!budget.withdraw(), "the burst is spent");
        for _ in 0..9 {
            budget.deposit();
        }
        assert!(!budget.withdraw(), "nine primaries buy 0.9 of a retry");
        budget.deposit();
        assert!(budget.withdraw(), "ten buy one");
    }

    #[test]
    fn the_breaker_opens_probes_and_closes() {
        let breaker = Arc::new(CircuitBreaker::new(BreakerPolicy {
            failure_threshold: 2,
            open_for: Duration::from_secs(10),
        }));
        let t0 = Instant::now();
        breaker.try_acquire(t0).unwrap().record(Verdict::Failure);
        breaker.try_acquire(t0).unwrap().record(Verdict::Neutral);
        assert!(!breaker.is_open(t0), "neutral results do not count");
        breaker.try_acquire(t0).unwrap().record(Verdict::Failure);
        assert!(
            breaker.try_acquire(t0).is_none(),
            "two consecutive failures open it"
        );

        let later = t0 + Duration::from_secs(11);
        let probe = breaker.try_acquire(later).unwrap();
        assert!(breaker.try_acquire(later).is_none(), "one probe at a time");
        drop(probe);
        let probe = breaker
            .try_acquire(later)
            .expect("an abandoned probe frees the slot");
        probe.record(Verdict::Success);
        assert!(!breaker.is_open(later));
    }

    #[test]
    fn a_stale_success_does_not_close_a_tripped_breaker() {
        let breaker = Arc::new(CircuitBreaker::new(BreakerPolicy {
            failure_threshold: 1,
            open_for: Duration::from_secs(10),
        }));
        let t0 = Instant::now();
        let slow = breaker.try_acquire(t0).unwrap();
        breaker.try_acquire(t0).unwrap().record(Verdict::Failure);
        slow.record(Verdict::Success);
        assert!(
            breaker.is_open(t0),
            "an old success must not skip the cooldown"
        );

        let later = t0 + Duration::from_secs(11);
        let probe = breaker.try_acquire(later).unwrap();
        assert!(breaker.is_open(later));
        probe.record(Verdict::Success);
        assert!(!breaker.is_open(later), "the probe's success closes it");
    }

    #[test]
    fn a_long_retry_after_is_not_waited_out() {
        let policy = RetryPolicy::default();
        assert_eq!(policy.backoff(1, Some(Duration::from_secs(30)), 0), None);
        assert_eq!(
            policy.backoff(1, Some(Duration::from_secs(1)), 0),
            Some(Duration::from_secs(1))
        );
        let b = policy.backoff(3, None, u64::MAX).unwrap();
        assert!(b <= policy.max_backoff, "{b:?}");
    }
}
