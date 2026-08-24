//! Per-endpoint-class rate limiting.
//!
//! `KT.md` §9.3 makes one specific demand and this module exists to meet it:
//! *"`/kt/v1/audit` can return megabytes. It MUST be rate-limited separately
//! from every other endpoint."* Separately, because a shared bucket lets one
//! auditor pulling a 3.9 MB proof starve every lookup on the log.
//!
//! # What this is not
//!
//! It is a **global** token bucket per class, not a per-client one. It cannot
//! be per-client, because this process sits behind a TLS terminator and the
//! only client identity available to it is whatever that terminator chose to
//! put in a header — which an attacker can also put in a header. A limiter that
//! keyed on a spoofable identity would be a limiter an attacker resets at will,
//! and worse, would let one client evict another's bucket.
//!
//! So the honest statement is: this bounds **total** work per class, which is
//! what protects the log's availability and its signing key from a flood. Fair
//! sharing between clients belongs to the ingress, which is the component that
//! actually knows who a client is.

use std::sync::Mutex;

/// The endpoint classes that get their own bucket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[non_exhaustive]
pub enum Class {
    /// `/kt/v1/audit` — megabytes per response (`KT.md` §10). Its own bucket
    /// is §9.3's explicit requirement.
    Audit,
    /// `/kt/v1/lookup` and `/kt/v1/history`.
    Query,
    /// `/kt/v1/submit`. Cheap in bytes and expensive in signatures: every
    /// accepted submission costs an `fsync` and a receipt signature, and on a
    /// `kms`-backed log a process spawn.
    Submit,
    /// `/kt/v1/cosign`.
    Cosign,
}

impl Class {
    /// Every class, so a caller cannot configure a limiter that silently omits
    /// one.
    pub const ALL: [Self; 4] = [Self::Audit, Self::Query, Self::Submit, Self::Cosign];

    const fn index(self) -> usize {
        match self {
            Self::Audit => 0,
            Self::Query => 1,
            Self::Submit => 2,
            Self::Cosign => 3,
        }
    }
}

/// One bucket's shape.
#[derive(Clone, Copy, Debug)]
pub struct Bucket {
    /// The most requests that can be spent at once.
    pub burst: u32,
    /// How many tokens are added per second.
    pub per_second: u32,
}

#[derive(Debug)]
struct Live {
    burst: u32,
    per_second: u32,
    tokens: u32,
    last_ms: u64,
}

/// A token bucket per [`Class`].
#[derive(Debug)]
pub struct RateLimiter {
    buckets: Mutex<[Live; 4]>,
}

impl RateLimiter {
    /// Build a limiter. The defaults are deliberately conservative and are a
    /// starting point for measurement, not a measured answer — `KT.md` §12
    /// leaves the operating numbers open and this is one of them.
    #[must_use]
    pub fn new(audit: Bucket, query: Bucket, submit: Bucket, cosign: Bucket) -> Self {
        let live = |bucket: Bucket| Live {
            burst: bucket.burst,
            per_second: bucket.per_second,
            tokens: bucket.burst,
            last_ms: 0,
        };
        Self {
            buckets: Mutex::new([live(audit), live(query), live(submit), live(cosign)]),
        }
    }

    /// The shipped defaults.
    #[must_use]
    pub fn defaults() -> Self {
        Self::new(
            // An audit range is the expensive one: a handful an hour is what an
            // honest witness needs at a 600 s cadence.
            Bucket {
                burst: 8,
                per_second: 1,
            },
            Bucket {
                burst: 256,
                per_second: 64,
            },
            Bucket {
                burst: 32,
                per_second: 4,
            },
            Bucket {
                burst: 64,
                per_second: 8,
            },
        )
    }

    /// Spend a token, or refuse.
    ///
    /// `now_ms` is passed in rather than read so that a test can stand at an
    /// instant, and so that this module has no clock of its own.
    ///
    /// A poisoned lock refuses rather than panicking: the workspace denies
    /// `unwrap`/`panic` on the unauthenticated path for exactly this reason,
    /// and failing closed on a limiter is the safe direction.
    #[must_use]
    pub fn allow(&self, class: Class, now_ms: u64) -> bool {
        let Ok(mut buckets) = self.buckets.lock() else {
            return false;
        };
        let Some(bucket) = buckets.get_mut(class.index()) else {
            return false;
        };
        let elapsed_ms = now_ms.saturating_sub(bucket.last_ms);
        if bucket.last_ms == 0 || elapsed_ms >= 1_000 {
            let seconds = elapsed_ms / 1_000;
            let refill = u64::from(bucket.per_second).saturating_mul(seconds);
            let refill = u32::try_from(refill).unwrap_or(u32::MAX);
            bucket.tokens = bucket.tokens.saturating_add(refill).min(bucket.burst);
            bucket.last_ms = now_ms;
        }
        if bucket.tokens == 0 {
            return false;
        }
        bucket.tokens = bucket.tokens.saturating_sub(1);
        true
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::defaults()
    }
}

#[cfg(test)]
mod tests {
    use super::{Bucket, Class, RateLimiter};

    #[test]
    fn a_burst_is_spent_then_refused_then_refilled() {
        let limiter = RateLimiter::new(
            Bucket {
                burst: 2,
                per_second: 1,
            },
            Bucket {
                burst: 100,
                per_second: 100,
            },
            Bucket {
                burst: 100,
                per_second: 100,
            },
            Bucket {
                burst: 100,
                per_second: 100,
            },
        );
        assert!(limiter.allow(Class::Audit, 1_000));
        assert!(limiter.allow(Class::Audit, 1_000));
        assert!(!limiter.allow(Class::Audit, 1_000));
        assert!(limiter.allow(Class::Audit, 2_500), "one token a second");
    }

    #[test]
    fn exhausting_audit_does_not_touch_lookup() {
        // This is the whole reason §9.3 asks for separate limits: one auditor
        // pulling megabytes must not be able to stop anyone resolving a handle.
        let limiter = RateLimiter::new(
            Bucket {
                burst: 1,
                per_second: 0,
            },
            Bucket {
                burst: 4,
                per_second: 0,
            },
            Bucket {
                burst: 4,
                per_second: 0,
            },
            Bucket {
                burst: 4,
                per_second: 0,
            },
        );
        assert!(limiter.allow(Class::Audit, 1_000));
        assert!(!limiter.allow(Class::Audit, 1_000));
        assert!(limiter.allow(Class::Query, 1_000));
        assert!(limiter.allow(Class::Submit, 1_000));
        assert!(limiter.allow(Class::Cosign, 1_000));
    }

    #[test]
    fn every_class_has_a_bucket() {
        let limiter = RateLimiter::defaults();
        for class in Class::ALL {
            assert!(limiter.allow(class, 1_000), "{class:?} has no bucket");
        }
    }
}
