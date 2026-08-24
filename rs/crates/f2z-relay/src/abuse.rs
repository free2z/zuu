//! §13.1's four layers, in the order the section states them.
//!
//! | Layer | What it bounds | Where it lives |
//! |---|---|---|
//! | 1 — connections | concurrent and new connections per source, per-connection command rate, `GET_CHALLENGE` rate | here |
//! | 2 — per-queue quotas | `max_queue_messages`, `max_queue_bytes` | `f2z-relay-store`, inside the append transaction |
//! | 3 — queue creation | `open` / `pow`, and the queue-count ceiling | here and [`crate::challenge`] |
//! | 4 — global backpressure | storage against a high-water mark | here |
//!
//! # The source address is counted and never stored
//!
//! Per-source limits need to count what an address has done recently. What they
//! must not do is give the relay a record of who connected: a table keyed by IP
//! that outlives the window is a connection log, which is precisely the metadata
//! `THREAT-MODEL.md` §3.3 assumes an operator has and the rest of the design
//! spends its effort not adding to.
//!
//! So the counters here are keyed by a **BLAKE2b digest of the address under a
//! per-process random salt**, the salt never leaves the process, and an entry
//! whose window has passed is dropped rather than retained. The digest is not a
//! privacy claim against the operator — the kernel knows the peer address and so
//! does the socket — it is a claim about *this* data structure and about what
//! ends up in a core dump, a heap profile, or a `Debug` rendering.
//!
//! §13.3 is honest that the whole layer harms the people who most need the
//! system: a Tor exit, a CGNAT block, a university NAT and a shared VPN egress
//! all present as one source carrying many legitimate users. There is no good
//! answer without an identity the relay deliberately lacks. What an operator can
//! do is turn the layer off and publish that they did, which is what
//! `per_source_limits` in the capability document is for.
//!
//! # Order matters in layer 4
//!
//! §13.1: on crossing a high-water mark the relay refuses **creation first**,
//! then **appends**, then **new connections** — and `READ`, `ACK` and
//! `DELETE_QUEUE` are *never* refused, "because they are the operations that
//! make the relay smaller, and refusing them under load is a deadlock".

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::config::Limits;

/// A source address, reduced to something that is not an address.
///
/// 16 bytes of a keyed digest: enough that two live sources will not collide,
/// short enough that the table is small, and not invertible without the salt.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct SourceKey([u8; 16]);

// Even the digest is not printed. It is a stable per-process identifier for a
// peer, and a log line carrying one is a log line that can be correlated across
// connections.
impl core::fmt::Debug for SourceKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SourceKey(<redacted>)")
    }
}

/// What a source has been doing lately.
#[derive(Clone, Copy, Debug, Default)]
struct SourceState {
    /// Currently open connections.
    open: u32,
    /// Connections accepted in the current one-second bucket.
    accepted: u32,
    /// The bucket, in whole seconds.
    accept_second: u64,
    /// Challenges issued in the current one-minute bucket.
    challenges: u32,
    /// The bucket, in whole minutes.
    challenge_minute: u64,
}

impl SourceState {
    const fn is_idle(&self) -> bool {
        self.open == 0 && self.accepted == 0 && self.challenges == 0
    }
}

/// Why an accept was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// §13.1 layer 1: the relay is at `max_connections`.
    TooManyConnections,
    /// §13.1 layer 1: this source is at `max_connections_per_source`.
    TooManyFromSource,
    /// §13.1 layer 1: this source is opening connections too fast.
    ConnectingTooFast,
    /// §13.1 layer 4 step 3: new connections are refused at accept.
    Backpressure,
}

/// The per-relay anti-abuse state.
pub struct AbuseGuard {
    limits: Limits,
    per_source: bool,
    salt: [u8; 32],
    sources: Mutex<HashMap<SourceKey, SourceState>>,
    connections: AtomicU64,
    /// §13.1 layer 4. Recomputed by the expiry tick from the store's own
    /// numbers, so it follows what is actually on the disk rather than what the
    /// relay believes it wrote.
    backpressure: AtomicBool,
}

// `salt` is what makes a [`SourceKey`] not an address: it never leaves the
// process, and a derived `Debug` would render it as a decimal byte dump —
// after which every key in the table is invertible by anyone holding the log.
// The counters are reported as totals, exactly as `/metrics` reports them.
impl core::fmt::Debug for AbuseGuard {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("AbuseGuard")
            .field("per_source", &self.per_source)
            .field("salt", &"<redacted>")
            .field("connections", &self.open_connections())
            .field("backpressure", &self.backpressured())
            .finish_non_exhaustive()
    }
}

impl AbuseGuard {
    /// Build a guard.
    ///
    /// `salt` should come from [`crate::rng::seed`]; it never leaves the
    /// process and is what makes [`SourceKey`] not an address.
    #[must_use]
    pub fn new(limits: Limits, per_source: bool, salt: [u8; 32]) -> Self {
        Self {
            limits,
            per_source,
            salt,
            sources: Mutex::new(HashMap::new()),
            connections: AtomicU64::new(0),
            backpressure: AtomicBool::new(false),
        }
    }

    /// Reduce a peer address to a counter key.
    #[must_use]
    pub fn key_for(&self, peer: &std::net::SocketAddr) -> SourceKey {
        // The **address only**, never the port: two connections from one host
        // are the thing being counted, and a port would make every connection
        // its own source.
        let bytes = match peer.ip() {
            std::net::IpAddr::V4(v4) => v4.octets().to_vec(),
            std::net::IpAddr::V6(v6) => v6.octets().to_vec(),
        };
        let digest = f2z_codec::hash::hash2(b"f2z-relay/v1/source", &self.salt, &bytes);
        let mut key = [0u8; 16];
        if let Some(slice) = digest.as_bytes().get(..16) {
            key.copy_from_slice(slice);
        }
        SourceKey(key)
    }

    /// Whether §13.1 layer 4 is currently on.
    #[must_use]
    pub fn backpressured(&self) -> bool {
        self.backpressure.load(Ordering::Relaxed)
    }

    /// Set layer 4 from a fresh measurement of the store.
    ///
    /// Returns whether the state changed, so the caller can log the transition
    /// rather than the level.
    pub fn set_backpressure(&self, on: bool) -> bool {
        self.backpressure.swap(on, Ordering::Relaxed) != on
    }

    /// How many connections are open. `/metrics` publishes this as a total.
    #[must_use]
    pub fn open_connections(&self) -> u64 {
        self.connections.load(Ordering::Relaxed)
    }

    /// Admit a connection, or say why not (§13.1 layer 1, and layer 4 step 3).
    ///
    /// # Errors
    ///
    /// A [`Refusal`]. The caller closes the socket without speaking protocol:
    /// there is no `HELLO` yet, so there is no frame to answer with.
    pub fn accept(
        self: &Arc<Self>,
        key: SourceKey,
        now_ms: u64,
    ) -> Result<ConnectionPermit, Refusal> {
        // Layer 4 refuses new connections *last*, after creation and appends,
        // because an open connection that is only reading is helping.
        if self.backpressured() {
            return Err(Refusal::Backpressure);
        }
        if self.connections.load(Ordering::Relaxed) >= u64::from(self.limits.max_connections) {
            return Err(Refusal::TooManyConnections);
        }
        if self.per_source {
            let mut sources = self.lock();
            let second = now_ms / 1_000;
            let state = sources.entry(key).or_default();
            if state.accept_second != second {
                state.accept_second = second;
                state.accepted = 0;
            }
            if state.open >= self.limits.max_connections_per_source {
                return Err(Refusal::TooManyFromSource);
            }
            if state.accepted >= self.limits.new_connections_per_source_per_second {
                return Err(Refusal::ConnectingTooFast);
            }
            state.open = state.open.saturating_add(1);
            state.accepted = state.accepted.saturating_add(1);
        }
        self.connections.fetch_add(1, Ordering::Relaxed);
        Ok(ConnectionPermit {
            guard: Arc::clone(self),
            key,
        })
    }

    /// Take one `GET_CHALLENGE` from this source's minute budget (§6.1).
    ///
    /// Returns `false` when the budget is spent; the caller answers
    /// `ERR_RATE_LIMITED`.
    #[must_use]
    pub fn take_challenge(&self, key: SourceKey, now_ms: u64) -> bool {
        if !self.per_source {
            return true;
        }
        let minute = now_ms / 60_000;
        let mut sources = self.lock();
        let state = sources.entry(key).or_default();
        if state.challenge_minute != minute {
            state.challenge_minute = minute;
            state.challenges = 0;
        }
        if state.challenges >= self.limits.challenges_per_source_per_minute {
            return false;
        }
        state.challenges = state.challenges.saturating_add(1);
        true
    }

    fn release(&self, key: SourceKey) {
        self.connections.fetch_sub(1, Ordering::Relaxed);
        if !self.per_source {
            return;
        }
        let mut sources = self.lock();
        if let Some(state) = sources.get_mut(&key) {
            state.open = state.open.saturating_sub(1);
            // A source with nothing outstanding leaves no row behind. The table
            // is a rate limiter, not a connection log.
            if state.is_idle() {
                sources.remove(&key);
            }
        }
    }

    /// Drop rows whose windows have passed. Called by the expiry tick.
    ///
    /// Returns how many rows went.
    pub fn sweep(&self, now_ms: u64) -> usize {
        if !self.per_source {
            return 0;
        }
        let second = now_ms / 1_000;
        let minute = now_ms / 60_000;
        let mut sources = self.lock();
        let before = sources.len();
        sources.retain(|_, state| {
            if state.accept_second != second {
                state.accepted = 0;
            }
            if state.challenge_minute != minute {
                state.challenges = 0;
            }
            !state.is_idle()
        });
        before.saturating_sub(sources.len())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<SourceKey, SourceState>> {
        self.sources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// A connection's claim on the connection budget, released on drop.
///
/// Dropping is the only way to release it, so a path that returns early — a
/// failed TLS handshake, a refused upgrade, a panic in a task — cannot leak a
/// slot. A counter that only goes up is a relay that stops accepting after an
/// uptime rather than under a load.
#[derive(Debug)]
pub struct ConnectionPermit {
    guard: Arc<AbuseGuard>,
    key: SourceKey,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.guard.release(self.key);
    }
}

/// A per-connection command rate limiter (§13.1 layer 1).
///
/// One second of budget, refilled on the second. Deliberately not a token
/// bucket with a burst allowance: §4.3's in-flight window is already the burst
/// control, and two overlapping burst policies are two numbers an operator has
/// to reason about together.
#[derive(Debug)]
pub struct CommandRate {
    per_second: u32,
    used: u32,
    second: u64,
}

impl CommandRate {
    /// A limiter at `per_second` commands. Zero means unlimited.
    #[must_use]
    pub const fn new(per_second: u32) -> Self {
        Self {
            per_second,
            used: 0,
            second: 0,
        }
    }

    /// Take one command's budget. `false` means `ERR_RATE_LIMITED`.
    #[must_use]
    pub const fn take(&mut self, now_ms: u64) -> bool {
        if self.per_second == 0 {
            return true;
        }
        let second = now_ms / 1_000;
        if self.second != second {
            self.second = second;
            self.used = 0;
        }
        if self.used >= self.per_second {
            return false;
        }
        self.used = self.used.saturating_add(1);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            max_connections: 4,
            max_connections_per_source: 2,
            new_connections_per_source_per_second: 3,
            challenges_per_source_per_minute: 2,
            ..Limits::default()
        }
    }

    fn peer(last: u8) -> std::net::SocketAddr {
        std::net::SocketAddr::from(([10, 0, 0, last], 4000))
    }

    #[test]
    fn a_source_key_is_the_address_and_not_the_port() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [1u8; 32]));
        let first = guard.key_for(&std::net::SocketAddr::from(([10, 0, 0, 1], 1)));
        let second = guard.key_for(&std::net::SocketAddr::from(([10, 0, 0, 1], 2)));
        assert_eq!(first, second);
        assert_ne!(first, guard.key_for(&peer(2)));
    }

    #[test]
    fn a_source_key_is_not_the_address() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [2u8; 32]));
        let key = guard.key_for(&peer(1));
        let rendered = format!("{key:?}");
        assert_eq!(rendered, "SourceKey(<redacted>)");
        // And two relays with different salts do not agree on it, so a key is
        // not a stable identifier anyone can precompute.
        let other = Arc::new(AbuseGuard::new(limits(), true, [3u8; 32]));
        assert_ne!(key, other.key_for(&peer(1)));
    }

    #[test]
    fn concurrent_connections_from_one_source_are_capped() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [4u8; 32]));
        let key = guard.key_for(&peer(1));
        let first = guard.accept(key, 0).unwrap();
        let second = guard.accept(key, 0).unwrap();
        assert_eq!(
            guard.accept(key, 0).unwrap_err(),
            Refusal::TooManyFromSource
        );
        drop(first);
        drop(second);
        assert!(guard.accept(key, 0).is_ok());
    }

    #[test]
    fn a_permit_releases_on_drop_even_from_an_early_return() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [5u8; 32]));
        let key = guard.key_for(&peer(1));
        // A second apart, so the per-second accept budget is not what this test
        // is measuring; the relay-wide counter is.
        for second in 0..100u64 {
            let permit = guard.accept(key, second.saturating_mul(1_000)).unwrap();
            drop(permit);
        }
        assert_eq!(guard.open_connections(), 0);
    }

    #[test]
    fn the_relay_wide_cap_holds_across_sources() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [6u8; 32]));
        let mut held = Vec::new();
        for source in 1..=2u8 {
            for _ in 0..2 {
                held.push(guard.accept(guard.key_for(&peer(source)), 0).unwrap());
            }
        }
        assert_eq!(
            guard.accept(guard.key_for(&peer(9)), 0).unwrap_err(),
            Refusal::TooManyConnections
        );
    }

    #[test]
    fn connecting_too_fast_is_refused_and_the_bucket_rolls() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [7u8; 32]));
        let key = guard.key_for(&peer(1));
        let a = guard.accept(key, 0).unwrap();
        let b = guard.accept(key, 0).unwrap();
        drop(a);
        drop(b);
        let c = guard.accept(key, 0).unwrap();
        drop(c);
        assert_eq!(
            guard.accept(key, 0).unwrap_err(),
            Refusal::ConnectingTooFast
        );
        assert!(guard.accept(key, 1_000).is_ok());
    }

    #[test]
    fn backpressure_refuses_new_connections_last() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [8u8; 32]));
        assert!(!guard.backpressured());
        assert!(guard.set_backpressure(true));
        assert!(!guard.set_backpressure(true));
        assert_eq!(
            guard.accept(guard.key_for(&peer(1)), 0).unwrap_err(),
            Refusal::Backpressure
        );
    }

    #[test]
    fn challenge_issuance_is_rate_limited_per_source() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [9u8; 32]));
        let key = guard.key_for(&peer(1));
        assert!(guard.take_challenge(key, 0));
        assert!(guard.take_challenge(key, 0));
        assert!(!guard.take_challenge(key, 0));
        assert!(guard.take_challenge(key, 60_000));
    }

    #[test]
    fn turning_per_source_limits_off_turns_them_off() {
        let guard = Arc::new(AbuseGuard::new(limits(), false, [10u8; 32]));
        let key = guard.key_for(&peer(1));
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(guard.accept(key, 0).unwrap());
        }
        // The relay-wide cap still holds; only the per-source layer is off.
        assert!(guard.accept(key, 0).is_err());
        assert!(guard.take_challenge(key, 0));
        assert!(guard.take_challenge(key, 0));
        assert!(guard.take_challenge(key, 0));
    }

    #[test]
    fn an_idle_source_leaves_no_row_behind() {
        let guard = Arc::new(AbuseGuard::new(limits(), true, [11u8; 32]));
        let key = guard.key_for(&peer(1));
        drop(guard.accept(key, 0).unwrap());
        assert_eq!(guard.sweep(1_000), 1);
        assert_eq!(guard.sweep(1_000), 0);
    }

    #[test]
    fn the_command_rate_refills_on_the_second() {
        let mut rate = CommandRate::new(2);
        assert!(rate.take(0));
        assert!(rate.take(500));
        assert!(!rate.take(999));
        assert!(rate.take(1_000));
    }

    #[test]
    fn a_zero_command_rate_is_unlimited() {
        let mut rate = CommandRate::new(0);
        for _ in 0..1_000 {
            assert!(rate.take(0));
        }
    }
}
