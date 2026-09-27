//! The shared store: what the gateway asks the platform's Redis, as a trait.
//!
//! Three operations, each one round trip:
//!
//! | Operation | Keys | Used for |
//! |---|---|---|
//! | [`Store::counters`] | `<ns>:aep:<sub>`, `<ns>:agen:<client_id>:<sub>` (`MGET`) | Revocation. Written by the IdP (`dj.apps.oidc.epoch_publish`): plain decimal strings, raised only by compare-and-set, 300 s TTL |
//! | [`Store::admit`] | `<ns>:ai:rl:u:<client_id>:<sub>`, `<ns>:ai:rl:a:<client_id>`, `<ns>:ai:cc:<sub>` (one Lua script) | The per-(app, user) and per-app token buckets and the per-user concurrency lease |
//! | [`Store::release`] | `<ns>:ai:cc:<sub>` (`ZREM`) | Ending a lease |
//!
//! [`RedisStore`] is the implementation. Every call is bounded by a short
//! timeout, and after a failure the store is skipped for [`BACKOFF`] so that
//! a Redis outage costs each request nothing rather than a timeout: the
//! callers then fall back — the limits to their local copies, revocation to
//! the IdP's internal epoch endpoint, **never** to "allow".
//!
//! The admit script is multi-key, so it needs a single Redis (not Cluster),
//! which is what the platform runs.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use secrecy::{ExposeSecret as _, SecretString};

/// How long the store is skipped after a failure.
pub const BACKOFF: Duration = Duration::from_secs(1);

/// The store failed, timed out, or is backing off. Carries no detail: a
/// Redis error message can quote a key, and a key carries a user id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoreError;

/// A token bucket's shape: `per_minute` sustained, `burst` at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rate {
    /// Requests per minute, sustained. At least 1.
    pub per_minute: u32,
    /// Bucket capacity. At least 1.
    pub burst: u32,
}

/// One admission against the shared limits.
#[derive(Clone, Debug)]
pub struct AdmitRequest {
    /// The per-(app, user) bucket's key.
    pub user_bucket: String,
    /// The per-app bucket's key.
    pub app_bucket: String,
    /// The per-user lease set's key.
    pub lease_key: String,
    /// This call's member in the lease set.
    pub member: String,
    /// The per-(app, user) rate.
    pub user_rate: Rate,
    /// The per-app rate.
    pub app_rate: Rate,
    /// Open leases allowed per user.
    pub lease_limit: u32,
    /// How long a lease lives in Redis if nobody releases it.
    pub lease_ttl: Duration,
}

/// Which limit refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The per-(app, user) bucket is empty.
    User,
    /// The per-app bucket is empty.
    App,
    /// The user has `lease_limit` open leases.
    Concurrency,
}

/// The answer to an [`AdmitRequest`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    /// Admitted: a token was taken from both buckets and the lease is held.
    /// `remaining` is what is left in the per-(app, user) bucket.
    Admitted {
        /// Whole tokens left in the per-(app, user) bucket.
        remaining: u32,
    },
    /// Refused; nothing was taken.
    Refused {
        /// Which limit.
        by: Refusal,
        /// When a retry could succeed, in milliseconds.
        retry_after_ms: u64,
    },
}

/// The shared store.
#[async_trait]
pub trait Store: Send + Sync + 'static {
    /// `MGET` of two counters: each a decimal string, or `None` when absent.
    async fn counters(&self, keys: [&str; 2]) -> Result<[Option<String>; 2], StoreError>;
    /// Take a token from both buckets and a lease, atomically, or none.
    async fn admit(&self, request: &AdmitRequest) -> Result<Admission, StoreError>;
    /// Drop `member` from the lease set.
    async fn release(&self, lease_key: &str, member: &str) -> Result<(), StoreError>;
}

/// KEYS: user bucket, app bucket, lease set.
/// ARGV: user per_minute, user burst, app per_minute, app burst, lease limit,
/// lease ttl ms, member.
/// Returns `{status, retry_after_ms, remaining}`; status 0 admitted, 1 user
/// bucket, 2 app bucket, 3 concurrency.
///
/// Buckets are hashes of milli-tokens (`t`) and the last refill time in ms
/// (`ts`), refilled at `per_minute / 60` milli-tokens per millisecond. The
/// clock is Redis's own `TIME`, so pods with skewed clocks share one.
const ADMIT_LUA: &str = r"
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local lease_limit = tonumber(ARGV[5])
local lease_ttl = tonumber(ARGV[6])

redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
if redis.call('ZCARD', KEYS[3]) >= lease_limit then
  local first = redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
  local retry = 1000
  if first[2] then retry = math.max(1, tonumber(first[2]) - now) end
  return {3, math.min(retry, 1000), 0}
end

local function level(key, per_minute, burst)
  local cap = burst * 1000
  local s = redis.call('HMGET', key, 't', 'ts')
  local tokens = tonumber(s[1])
  local ts = tonumber(s[2])
  if tokens == nil or ts == nil then return cap end
  if now > ts then
    tokens = math.min(cap, tokens + math.floor((now - ts) * per_minute / 60))
  end
  return tokens
end

local upm, ub = tonumber(ARGV[1]), tonumber(ARGV[2])
local apm, ab = tonumber(ARGV[3]), tonumber(ARGV[4])
local ut = level(KEYS[1], upm, ub)
local at = level(KEYS[2], apm, ab)
if ut < 1000 then
  return {1, math.ceil((1000 - ut) * 60 / upm), 0}
end
if at < 1000 then
  return {2, math.ceil((1000 - at) * 60 / apm), 0}
end
ut = ut - 1000
at = at - 1000
redis.call('HSET', KEYS[1], 't', ut, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(ub * 60000 / upm) + 1000)
redis.call('HSET', KEYS[2], 't', at, 'ts', now)
redis.call('PEXPIRE', KEYS[2], math.ceil(ab * 60000 / apm) + 1000)
redis.call('ZADD', KEYS[3], now + lease_ttl, ARGV[7])
redis.call('PEXPIRE', KEYS[3], lease_ttl)
return {0, 0, math.floor(ut / 1000)}
";

/// The platform's Redis.
pub struct RedisStore {
    connection: ConnectionManager,
    admit: redis::Script,
    timeout: Duration,
    skip_until: Mutex<Option<Instant>>,
}

impl std::fmt::Debug for RedisStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisStore")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

impl RedisStore {
    /// A store on `url` (`redis://…`). Connects lazily: a Redis that is down
    /// at start-up is a fallback, not a failed start.
    ///
    /// # Errors
    ///
    /// The URL is not a Redis URL.
    pub fn new(url: &SecretString, timeout: Duration) -> Result<Self, String> {
        let client = redis::Client::open(url.expose_secret())
            .map_err(|_| "the Redis URL is not a valid redis:// URL".to_owned())?;
        let config = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(timeout))
            .set_response_timeout(Some(timeout))
            .set_number_of_retries(1)
            .set_max_delay(Duration::from_millis(500));
        let connection = ConnectionManager::new_lazy_with_config(client, config)
            .map_err(|_| "the Redis client could not be created".to_owned())?;
        Ok(Self {
            connection,
            admit: redis::Script::new(ADMIT_LUA),
            timeout,
            skip_until: Mutex::new(None),
        })
    }

    fn backing_off(&self) -> bool {
        let skip = self
            .skip_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        skip.is_some_and(|until| Instant::now() < until)
    }

    fn failed(&self) -> StoreError {
        *self
            .skip_until
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Instant::now().checked_add(BACKOFF);
        StoreError
    }

    async fn run<T, F>(&self, op: F) -> Result<T, StoreError>
    where
        F: Future<Output = redis::RedisResult<T>>,
    {
        if self.backing_off() {
            return Err(StoreError);
        }
        match tokio::time::timeout(self.timeout, op).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => {
                tracing::warn!(kind = ?error.kind(), "redis call failed");
                Err(self.failed())
            }
            Err(_) => {
                tracing::warn!("redis call timed out");
                Err(self.failed())
            }
        }
    }
}

#[async_trait]
impl Store for RedisStore {
    async fn counters(&self, keys: [&str; 2]) -> Result<[Option<String>; 2], StoreError> {
        let mut connection = self.connection.clone();
        let values: Vec<Option<String>> = self
            .run(async move {
                redis::cmd("MGET")
                    .arg(keys[0])
                    .arg(keys[1])
                    .query_async(&mut connection)
                    .await
            })
            .await?;
        let mut values = values.into_iter();
        match (values.next(), values.next(), values.next()) {
            (Some(a), Some(b), None) => Ok([a, b]),
            _ => Err(StoreError),
        }
    }

    async fn admit(&self, request: &AdmitRequest) -> Result<Admission, StoreError> {
        let mut connection = self.connection.clone();
        let ttl_ms = u64::try_from(request.lease_ttl.as_millis()).unwrap_or(u64::MAX);
        let mut invocation = self.admit.prepare_invoke();
        invocation
            .key(&request.user_bucket)
            .key(&request.app_bucket)
            .key(&request.lease_key)
            .arg(request.user_rate.per_minute)
            .arg(request.user_rate.burst)
            .arg(request.app_rate.per_minute)
            .arg(request.app_rate.burst)
            .arg(request.lease_limit)
            .arg(ttl_ms)
            .arg(&request.member);
        let reply: Vec<i64> = self
            .run(async move { invocation.invoke_async(&mut connection).await })
            .await?;
        let field = |i: usize| reply.get(i).copied().ok_or(StoreError);
        let retry_after_ms = u64::try_from(field(1)?).unwrap_or(0);
        Ok(match field(0)? {
            0 => Admission::Admitted {
                remaining: u32::try_from(field(2)?).unwrap_or(0),
            },
            1 => Admission::Refused {
                by: Refusal::User,
                retry_after_ms,
            },
            2 => Admission::Refused {
                by: Refusal::App,
                retry_after_ms,
            },
            3 => Admission::Refused {
                by: Refusal::Concurrency,
                retry_after_ms,
            },
            _ => return Err(StoreError),
        })
    }

    async fn release(&self, lease_key: &str, member: &str) -> Result<(), StoreError> {
        let mut connection = self.connection.clone();
        // Not skipped while backing off: a release is best-effort anyway (the
        // lease's TTL is the backstop), and it runs off the request path.
        match tokio::time::timeout(
            self.timeout,
            redis::cmd("ZREM")
                .arg(lease_key)
                .arg(member)
                .query_async::<i64>(&mut connection),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            _ => Err(StoreError),
        }
    }
}
