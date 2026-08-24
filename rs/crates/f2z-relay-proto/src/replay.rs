//! Anti-replay — `WIRE.md` §5.5: a bounded timestamp window, plus a
//! fail-closed seen-set of `(signer_key, nonce)`.
//!
//! Both halves are pure. **Nothing here reads a clock**: every method that
//! needs the time takes `now_ms` as an argument. That is not a testing
//! convenience, it is the portability requirement — this crate compiles for
//! `wasm32-unknown-unknown`, where `std::time::SystemTime` panics, and it
//! compiles with no async runtime, so there is no timer to hang a sweep on
//! either. The relay owns the clock; this owns the rule.
//!
//! # The seen-set is fail-closed, and that is the whole design
//!
//! §5.5 is explicit: the set is bounded (`antireplay_seen_max`), and when the
//! bound is reached the relay returns `ERR_BACKPRESSURE` and refuses new signed
//! commands until entries age out. It **MUST NOT** evict live entries to make
//! room. An eviction policy that discards unexpired entries silently reopens
//! the replay window at exactly the moment the relay is under load — which is
//! exactly when an attacker would arrange to be. [`SeenSet::observe`] therefore
//! has no eviction path at all; the only way an entry leaves is expiry.
//!
//! # Why the set need not survive a restart, and when that stops being true
//!
//! A restart destroys every TLS session, so every command signed before it
//! carries a `channel_binding` (§5.3) that cannot verify against any new
//! session. The binding has already invalidated the whole pre-restart corpus.
//! **In `channel_binding_mode: none` that argument fails**, because the binding
//! is a constant: such a relay MUST persist the set or publish
//! `antireplay_persistence: volatile` and accept a replay window of
//! `clock_skew_ms` across a restart. This type is in-memory either way; the
//! persistence decision belongs to the relay that owns it.

use alloc::collections::BTreeMap;
use core::fmt;

use f2z_codec::ErrorCode;
use f2z_codec::types::{Nonce, PublicKey};

use crate::error::{ProtoError, Result};

/// The default `clock_skew_ms` of §5.5: ±2 minutes.
pub const DEFAULT_CLOCK_SKEW_MS: u64 = 120_000;

/// §5.5's timestamp window: `timestamp_ms` MUST be within `±clock_skew_ms` of
/// the relay's clock.
///
/// The boundary is **inclusive**. §5.5 says "within `±clock_skew_ms`" and does
/// not say which side of the boundary a value exactly on it falls; an
/// exclusive reading would make a correct client whose offset is exactly the
/// published skew fail intermittently, and the published number is a policy
/// value rather than a security threshold, so the inclusive reading is the one
/// implemented here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimestampWindow {
    skew_ms: u64,
}

impl TimestampWindow {
    /// A window of `±skew_ms`.
    #[must_use]
    pub const fn new(skew_ms: u64) -> Self {
        Self { skew_ms }
    }

    /// The published `clock_skew_ms`.
    #[must_use]
    pub const fn skew_ms(self) -> u64 {
        self.skew_ms
    }

    /// Check a command's `timestamp_ms` against the relay's clock.
    ///
    /// This is step 2 of §5.1's verification order, and it runs before the
    /// signature check because it is cheap and it is one of the two
    /// flood-resistant filters.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::StaleTimestamp`] when the timestamp is outside the window
    /// in either direction. A timestamp in the *future* is refused with the
    /// same code as one in the past: §10 defines one code for the window and
    /// splitting it would tell a caller which way its clock is wrong, which is
    /// a fingerprint of that caller.
    pub fn check(self, now_ms: u64, timestamp_ms: u64) -> Result<()> {
        let distance = now_ms.abs_diff(timestamp_ms);
        if distance <= self.skew_ms {
            Ok(())
        } else {
            Err(ProtoError::Wire(ErrorCode::StaleTimestamp))
        }
    }
}

impl Default for TimestampWindow {
    fn default() -> Self {
        Self::new(DEFAULT_CLOCK_SKEW_MS)
    }
}

/// The seen-set key: `(signer_key, nonce)` (§5.5).
///
/// `nonce` is 16 bytes of client CSPRNG, fresh per command, so the birthday
/// bound is 2^64 *per key* — not reachable inside a two-minute window at any
/// rate a relay would serve. Pairing it with the signing key is what keeps one
/// client's nonce space from colliding with another's.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReplayKey {
    signer_key: PublicKey,
    nonce: Nonce,
}

impl ReplayKey {
    /// Pair a signer key with the nonce it presented.
    #[must_use]
    pub const fn new(signer_key: PublicKey, nonce: Nonce) -> Self {
        Self { signer_key, nonce }
    }

    /// The signing key half.
    #[must_use]
    pub const fn signer_key(&self) -> PublicKey {
        self.signer_key
    }

    /// The nonce half.
    #[must_use]
    pub const fn nonce(&self) -> Nonce {
        self.nonce
    }
}

// Both halves are linkable: a per-queue key identifies a conversation, and a
// nonce identifies a command. Neither renders.
impl fmt::Debug for ReplayKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ReplayKey(<redacted>)")
    }
}

/// §5.5's seen-set: bounded, fail-closed, and expiring.
///
/// A `BTreeMap` rather than a hash map for two reasons: this crate is `no_std`
/// so `HashMap` is not available without pulling a hasher, and a tree has no
/// hash-collision behaviour for an attacker who fully controls both halves of
/// the key to aim at.
///
/// The retention window is separate from the timestamp window on purpose —
/// §11.1 publishes `antireplay_window_ms` and `clock_skew_ms` as two fields —
/// but they are not independent. See [`SeenSet::retention_is_sound`].
#[derive(Clone, Debug)]
pub struct SeenSet {
    /// Value is the instant at which the entry may be dropped.
    entries: BTreeMap<ReplayKey, u64>,
    retention_ms: u64,
    max_entries: usize,
}

impl SeenSet {
    /// A set retaining each entry for `retention_ms` and holding at most
    /// `max_entries` of them.
    ///
    /// `max_entries` is §5.5's `antireplay_seen_max`. It is a bound on memory,
    /// and reaching it is a refusal rather than an eviction.
    #[must_use]
    pub const fn new(retention_ms: u64, max_entries: usize) -> Self {
        Self {
            entries: BTreeMap::new(),
            retention_ms,
            max_entries,
        }
    }

    /// Whether the published `(antireplay_window_ms, clock_skew_ms)` pair
    /// actually closes the window.
    ///
    /// **This is a check `WIRE.md` does not state, and it should.** §11.1
    /// publishes the two values independently and nothing relates them, but a
    /// frame is replayable for as long as its timestamp stays inside the
    /// window: a command stamped `clock_skew_ms` in the future is still
    /// acceptable `clock_skew_ms` *after* the relay first saw it, so an entry
    /// must be retained for `2 × clock_skew_ms` from the moment it was
    /// observed. A relay publishing `antireplay_window_ms < 2 ×
    /// clock_skew_ms` ages entries out while their frames are still valid and
    /// has no seen-set at all for the gap, which is §5.5's stated protection
    /// silently absent. Reported as a specification defect rather than
    /// implemented around.
    #[must_use]
    pub const fn retention_is_sound(&self, clock_skew_ms: u64) -> bool {
        match clock_skew_ms.checked_mul(2) {
            Some(required) => self.retention_ms >= required,
            // A skew that overflows u64 is not a policy anyone can satisfy.
            None => false,
        }
    }

    /// How long an entry is kept.
    #[must_use]
    pub const fn retention_ms(&self) -> u64 {
        self.retention_ms
    }

    /// The bound at which the set fails closed.
    #[must_use]
    pub const fn max_entries(&self) -> usize {
        self.max_entries
    }

    /// How many entries are held right now.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the set is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drop every entry whose retention has elapsed, and report how many went.
    ///
    /// Called by [`SeenSet::observe`] before anything else, so a relay never
    /// has to schedule a sweep. It is public because an idle relay that stops
    /// receiving signed commands would otherwise hold its last entries
    /// forever, and an operator may want to reclaim that.
    pub fn expire(&mut self, now_ms: u64) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, expires_at| *expires_at > now_ms);
        before.saturating_sub(self.entries.len())
    }

    /// Record a `(signer_key, nonce)` pair, or refuse it.
    ///
    /// Step 3 of §5.1's verification order: it runs *before* the signature
    /// check, because it is cheap and flood-resistant.
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::Replay`] if the pair is already held. §5.6 bounds what a
    ///   replay could achieve anyway — duplicate or no-op, at the operator's
    ///   expense — but the bound is the reason it is acceptable, not a reason
    ///   to skip the check.
    /// - [`ErrorCode::Backpressure`] if the set is full of unexpired entries.
    ///   The relay refuses new signed commands until entries age out. It does
    ///   **not** evict.
    pub fn observe(&mut self, now_ms: u64, key: ReplayKey) -> Result<()> {
        self.expire(now_ms);

        if self.entries.contains_key(&key) {
            return Err(ProtoError::Wire(ErrorCode::Replay));
        }
        // Checked after the replay lookup on purpose: a full set that is being
        // handed a genuine replay should say so. Reporting backpressure there
        // would hide an attack behind a capacity message.
        if self.entries.len() >= self.max_entries {
            return Err(ProtoError::Wire(ErrorCode::Backpressure));
        }

        let expires_at = now_ms.saturating_add(self.retention_ms);
        self.entries.insert(key, expires_at);
        Ok(())
    }

    /// Whether the pair is currently held. Does not expire first — call
    /// [`SeenSet::expire`] if that matters.
    #[must_use]
    pub fn contains(&self, key: &ReplayKey) -> bool {
        self.entries.contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> ReplayKey {
        ReplayKey::new(PublicKey::new([byte; 32]), Nonce::new([byte; 16]))
    }

    #[test]
    fn the_window_boundary_is_inclusive_on_both_sides() {
        let window = TimestampWindow::new(1_000);
        let now = 10_000_000;
        assert!(window.check(now, now).is_ok());
        assert!(window.check(now, now + 1_000).is_ok());
        assert!(window.check(now, now - 1_000).is_ok());
        assert_eq!(
            window.check(now, now + 1_001),
            Err(ProtoError::Wire(ErrorCode::StaleTimestamp))
        );
        assert_eq!(
            window.check(now, now - 1_001),
            Err(ProtoError::Wire(ErrorCode::StaleTimestamp))
        );
    }

    #[test]
    fn a_timestamp_near_the_epoch_does_not_underflow() {
        let window = TimestampWindow::default();
        assert!(window.check(0, 0).is_ok());
        assert_eq!(
            window.check(0, u64::MAX),
            Err(ProtoError::Wire(ErrorCode::StaleTimestamp))
        );
    }

    #[test]
    fn a_repeat_inside_the_window_is_a_replay() {
        let mut seen = SeenSet::new(1_000, 8);
        assert!(seen.observe(0, key(1)).is_ok());
        assert_eq!(
            seen.observe(500, key(1)),
            Err(ProtoError::Wire(ErrorCode::Replay))
        );
        // And a different nonce under the same key is not.
        assert!(
            seen.observe(
                500,
                ReplayKey::new(PublicKey::new([1; 32]), Nonce::new([2; 16]))
            )
            .is_ok()
        );
    }

    #[test]
    fn an_entry_survives_for_exactly_its_retention() {
        // Half-open: an entry observed at `t` is held over `[t, t +
        // retention_ms)`. Which end is closed does not matter to the security
        // property, because soundness comes from `retention_ms >= 2 *
        // clock_skew_ms` (`SeenSet::retention_is_sound`) and not from a single
        // millisecond at the boundary; it is pinned by a test so it cannot
        // change unnoticed.
        let mut seen = SeenSet::new(1_000, 8);
        seen.observe(0, key(1)).unwrap();
        assert_eq!(
            seen.observe(999, key(1)),
            Err(ProtoError::Wire(ErrorCode::Replay))
        );
        assert!(seen.observe(1_000, key(1)).is_ok());
    }

    #[test]
    fn a_full_set_refuses_rather_than_evicting() {
        let mut seen = SeenSet::new(10_000, 2);
        seen.observe(0, key(1)).unwrap();
        seen.observe(0, key(2)).unwrap();
        assert_eq!(
            seen.observe(0, key(3)),
            Err(ProtoError::Wire(ErrorCode::Backpressure))
        );
        // The live entries are still live. This is the property: an eviction
        // policy would have reopened the window for key(1) here.
        assert!(seen.contains(&key(1)));
        assert!(seen.contains(&key(2)));
        assert_eq!(
            seen.observe(0, key(1)),
            Err(ProtoError::Wire(ErrorCode::Replay))
        );
        // …and once they age out, the set accepts again.
        assert!(seen.observe(10_001, key(3)).is_ok());
    }

    #[test]
    fn a_replay_is_reported_even_when_the_set_is_full() {
        let mut seen = SeenSet::new(10_000, 1);
        seen.observe(0, key(1)).unwrap();
        assert_eq!(
            seen.observe(0, key(1)),
            Err(ProtoError::Wire(ErrorCode::Replay)),
            "capacity must not mask an attack"
        );
    }

    #[test]
    fn retention_shorter_than_twice_the_skew_is_reported_as_unsound() {
        let skew = DEFAULT_CLOCK_SKEW_MS;
        assert!(!SeenSet::new(skew, 1).retention_is_sound(skew));
        assert!(SeenSet::new(skew * 2, 1).retention_is_sound(skew));
        assert!(SeenSet::new(skew * 3, 1).retention_is_sound(skew));
        assert!(!SeenSet::new(u64::MAX, 1).retention_is_sound(u64::MAX));
    }

    #[test]
    fn expire_reports_what_it_dropped() {
        let mut seen = SeenSet::new(100, 8);
        seen.observe(0, key(1)).unwrap();
        seen.observe(0, key(2)).unwrap();
        assert_eq!(seen.expire(50), 0);
        assert_eq!(seen.len(), 2);
        assert_eq!(seen.expire(101), 2);
        assert!(seen.is_empty());
    }
}
