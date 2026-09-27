//! Rate limits and the per-user concurrency lease (chat-api.md §1, §8).
//!
//! Two layers, checked in this order for every authenticated call:
//!
//! 1. **Local, per pod, always.** A per-user count of open calls (the
//!    concurrency limit, 4) and a GCRA per (app, user) and per app with the
//!    configured rates. Free — no I/O — so a client hammering one pod is shed
//!    before the shared store is asked anything.
//! 2. **Shared, in Redis.** One Lua script takes a token from the per-(app,
//!    user) and the per-app bucket and adds the call to the user's lease set,
//!    atomically, or refuses without taking anything
//!    ([`super::store::Store::admit`]).
//!
//! **If Redis is down, the local layer is the whole limit** — `N` pods then
//! admit up to `N` times the shared rate, and a user's streams are bounded
//! per pod rather than globally. That is the documented degradation for
//! *limits only*. Revocation never falls back to "allow"
//! ([`super::revocation`]).
//!
//! # The lease counts until the call is settled
//!
//! A [`Lease`] is attached to the call's admission slot
//! ([`crate::admission::CallHandle::attach_lease`]), and the slot is dropped
//! only after the settler has returned for the call **and** its delivery has
//! ended — so a drained call, a call whose client disconnected while its
//! upstream is still being read, and a call whose task panicked all keep
//! counting until they are settled, and stop counting then. Dropping the
//! lease decrements the local count at once and removes the call from the
//! Redis set in the background; if that removal is lost (a pod killed, Redis
//! unreachable at that moment) the member expires after `lease_ttl`, the
//! same way chat-api.md §1 says a dead gateway's call stops counting when
//! its hold expires.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderName;
use f2z_ai_proto::ErrorCode;

use super::jwt::Claims;
use super::store::{Admission, AdmitRequest, Rate, Refusal, Store};
use crate::error::ApiFailure;

/// Keys tracked by one local GCRA before new keys go untracked (and are
/// admitted by the local layer; the shared layer still applies). Bounds the
/// map's memory against a flood of distinct valid tokens.
pub const MAX_LOCAL_KEYS: usize = 100_000;

/// The limits' configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimitsConfig {
    /// Per (app, user).
    pub user: Rate,
    /// Per app, across its users.
    pub app: Rate,
    /// Open calls per user (chat-api.md §1: 4).
    pub concurrency: u32,
    /// How long a lease survives in Redis without a release.
    pub lease_ttl: Duration,
}

/// A local GCRA (the generic cell rate algorithm): per key, the theoretical
/// arrival time of the next request.
#[derive(Debug)]
struct Gcra {
    /// Emission interval: one request per `interval`.
    interval: Duration,
    /// `burst × interval`: how far ahead of now the TAT may run.
    window: Duration,
    tat: Mutex<HashMap<String, Instant>>,
}

enum Local {
    Allowed,
    Refused(Duration),
}

impl Gcra {
    fn new(rate: Rate) -> Self {
        let interval = Duration::from_secs(60)
            .checked_div(rate.per_minute.max(1))
            .unwrap_or(Duration::from_secs(60));
        Self {
            interval,
            window: interval.saturating_mul(rate.burst.max(1)),
            tat: Mutex::new(HashMap::new()),
        }
    }

    fn check(&self, key: &str, now: Instant) -> Local {
        let mut map = self
            .tat
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let tat = map.get(key).copied().unwrap_or(now).max(now);
        let new_tat = tat.checked_add(self.interval).unwrap_or(tat);
        // Allowed iff new_tat - window <= now.
        let ahead = new_tat.saturating_duration_since(now);
        if ahead > self.window {
            return Local::Refused(ahead.saturating_sub(self.window));
        }
        if !map.contains_key(key) && map.len() >= MAX_LOCAL_KEYS {
            map.retain(|_, t| *t > now);
            if map.len() >= MAX_LOCAL_KEYS {
                return Local::Allowed;
            }
        }
        map.insert(key.to_owned(), new_tat);
        Local::Allowed
    }
}

/// The per-user open-call counts of this pod.
type Counts = Arc<Mutex<HashMap<String, u32>>>;

/// A held concurrency lease. Dropping it ends the lease.
pub struct Lease {
    counts: Counts,
    user: String,
    remote: Option<(Arc<dyn Store>, String, String)>,
}

impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lease")
            .field("remote", &self.remote.is_some())
            .finish_non_exhaustive()
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        {
            let mut counts = self
                .counts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(n) = counts.get_mut(&self.user) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    counts.remove(&self.user);
                }
            }
        }
        if let Some((store, key, member)) = self.remote.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                if store.release(&key, &member).await.is_err() {
                    tracing::warn!("concurrency lease release failed; it will expire by TTL");
                }
            });
        }
    }
}

/// The limits.
pub struct Limits {
    config: LimitsConfig,
    user: Gcra,
    app: Gcra,
    counts: Counts,
    store: Option<Arc<dyn Store>>,
    namespace: String,
    instance: u64,
    next: AtomicU64,
}

impl std::fmt::Debug for Limits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Limits")
            .field("config", &self.config)
            .field("store", &self.store.is_some())
            .finish_non_exhaustive()
    }
}

fn retry_secs(wait: Duration) -> u32 {
    let millis = wait.as_millis();
    u32::try_from(millis.div_ceil(1000))
        .unwrap_or(u32::MAX)
        .max(1)
}

fn now_unix() -> u64 {
    crate::catalog::now_unix()
}

impl Limits {
    /// Limits with `config`, shared through `store` under `namespace` when
    /// one is configured.
    #[must_use]
    pub fn new(config: LimitsConfig, store: Option<Arc<dyn Store>>, namespace: String) -> Self {
        let mut instance = [0u8; 8];
        // A lease member must be unique across pods; a failed OS RNG falls
        // back to the clock, which is unique enough for a member name.
        let instance =
            if ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut instance)
                .is_ok()
            {
                u64::from_le_bytes(instance)
            } else {
                u64::try_from(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos(),
                )
                .unwrap_or(0)
            };
        Self {
            user: Gcra::new(config.user),
            app: Gcra::new(config.app),
            config,
            counts: Arc::new(Mutex::new(HashMap::new())),
            store,
            namespace,
            instance,
            next: AtomicU64::new(1),
        }
    }

    /// This pod's open calls for `sub`.
    #[must_use]
    pub fn open_calls(&self, sub: &str) -> u32 {
        self.counts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(sub)
            .copied()
            .unwrap_or(0)
    }

    fn concurrency_limited(&self, retry: Duration) -> ApiFailure {
        ApiFailure::new(
            ErrorCode::ConcurrencyLimit,
            "this user already has the maximum number of open streams",
        )
        .detail("limit", self.config.concurrency)
        .retry_after(retry_secs(retry))
    }

    fn rate_limited(&self, rate: Rate, remaining: u32, retry: Duration) -> ApiFailure {
        let secs = retry_secs(retry);
        ApiFailure::new(
            ErrorCode::RateLimited,
            "too many requests for this app and user; retry after Retry-After",
        )
        .retry_after(secs)
        .header(
            HeaderName::from_static("x-f2z-ratelimit-limit"),
            &rate.per_minute.to_string(),
        )
        .header(
            HeaderName::from_static("x-f2z-ratelimit-remaining"),
            &remaining.to_string(),
        )
        .header(
            HeaderName::from_static("x-f2z-ratelimit-reset"),
            &now_unix().saturating_add(u64::from(secs)).to_string(),
        )
    }

    /// Admit a call for `claims`, or refuse it with `429`.
    ///
    /// # Errors
    ///
    /// `429 concurrency_limit` or `429 rate_limited`, with `Retry-After`.
    pub async fn admit(&self, claims: &Claims) -> Result<Lease, ApiFailure> {
        // 1. Local concurrency: take the lease locally first, so that two
        //    racing calls on one pod cannot both see three.
        {
            let mut counts = self
                .counts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let open = counts.entry(claims.sub.clone()).or_insert(0);
            if *open >= self.config.concurrency {
                return Err(self.concurrency_limited(Duration::from_secs(1)));
            }
            *open = open.saturating_add(1);
        }
        let mut lease = Lease {
            counts: Arc::clone(&self.counts),
            user: claims.sub.clone(),
            remote: None,
        };

        // 2. Local rates.
        let now = Instant::now();
        let pair = format!("{}:{}", claims.client_id, claims.sub);
        if let Local::Refused(wait) = self.user.check(&pair, now) {
            return Err(self.rate_limited(self.config.user, 0, wait));
        }
        if let Local::Refused(wait) = self.app.check(&claims.client_id, now) {
            return Err(self.rate_limited(self.config.app, 0, wait));
        }

        // 3. Shared.
        let Some(store) = &self.store else {
            return Ok(lease);
        };
        let ns = &self.namespace;
        let request = AdmitRequest {
            user_bucket: format!("{ns}:ai:rl:u:{}:{}", claims.client_id, claims.sub),
            app_bucket: format!("{ns}:ai:rl:a:{}", claims.client_id),
            lease_key: format!("{ns}:ai:cc:{}", claims.sub),
            member: format!(
                "{:016x}:{}",
                self.instance,
                self.next.fetch_add(1, Ordering::Relaxed)
            ),
            user_rate: self.config.user,
            app_rate: self.config.app,
            lease_limit: self.config.concurrency,
            lease_ttl: self.config.lease_ttl,
        };
        // The script may have added the member even when its answer never
        // arrives (a timeout after Redis ran it) or this future is dropped
        // mid-call (the client hung up). So the lease owns the member's
        // removal from *before* the call: whatever happens, dropping the
        // lease removes it. A `ZREM` of a member that was never added is
        // harmless; a member nobody removes would count against the user for
        // `lease_ttl` on every pod.
        lease.remote = Some((
            Arc::clone(store),
            request.lease_key.clone(),
            request.member.clone(),
        ));
        match store.admit(&request).await {
            Ok(Admission::Admitted { .. }) => Ok(lease),
            Ok(Admission::Refused { by, retry_after_ms }) => {
                // A definite refusal added nothing: no removal is owed.
                lease.remote = None;
                let wait = Duration::from_millis(retry_after_ms);
                Err(match by {
                    Refusal::User => self.rate_limited(self.config.user, 0, wait),
                    Refusal::App => self.rate_limited(self.config.app, 0, wait),
                    Refusal::Concurrency => self.concurrency_limited(wait),
                })
            }
            Err(_) => {
                // Limits only: the local layer above already applied. The
                // remote member stays owned, in case the script did run.
                tracing::warn!("shared rate limits unavailable; local limits only");
                Ok(lease)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcra_allows_the_burst_then_one_per_interval() {
        let g = Gcra::new(Rate {
            per_minute: 60,
            burst: 3,
        });
        let t0 = Instant::now();
        for _ in 0..3 {
            assert!(matches!(g.check("k", t0), Local::Allowed));
        }
        let Local::Refused(wait) = g.check("k", t0) else {
            panic!("fourth in the same instant must be refused");
        };
        assert!(wait <= Duration::from_secs(1), "{wait:?}");
        // Another key is independent.
        assert!(matches!(g.check("other", t0), Local::Allowed));
        // One interval later, exactly one more.
        let t1 = t0 + Duration::from_secs(1);
        assert!(matches!(g.check("k", t1), Local::Allowed));
        assert!(matches!(g.check("k", t1), Local::Refused(_)));
    }

    #[test]
    fn retry_after_is_whole_seconds_at_least_one() {
        assert_eq!(retry_secs(Duration::ZERO), 1);
        assert_eq!(retry_secs(Duration::from_millis(1)), 1);
        assert_eq!(retry_secs(Duration::from_millis(1001)), 2);
    }
}
