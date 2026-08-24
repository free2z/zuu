//! The nonce ledger: bounded, fail-closed, and expiring.
//!
//! An assertion is replayable for as long as it is inside its own validity
//! window. Everything else in [`crate::authority`] is a stateless check on the
//! bytes, so this is the one rule that needs memory — and the one an
//! implementation is most likely to get subtly wrong in the two ways below.
//!
//! **It refuses; it does not evict.** Discarding an unexpired entry to make
//! room silently reopens the replay window at exactly the moment the log is
//! under load, which is exactly when an attacker would arrange to be. Reaching
//! [`NonceLedger::max_entries`] is therefore [`AuthorityError::LedgerFull`] —
//! `ERR_RATE_LIMITED` — and the only way an entry leaves is expiry. This
//! follows `f2z-relay-proto`'s `SeenSet`, which took the same decision for
//! `WIRE.md` §5.5 and reported the missing spec sentence rather than inventing
//! a policy.
//!
//! **Retention is derived, not published.** `f2z-relay-proto` had to reject
//! operator-published values that did not cover their own window (#586). Here
//! there is nothing to publish: the entry expires when the *assertion* does,
//! plus the clock skew the verifier already allows, so the retention can never
//! be shorter than the window it protects. That is not extra strictness, it is
//! the one arrangement in which the bug cannot be configured.
//!
//! **`(authority_id, nonce)`, not the assertion digest.** Keying on the digest
//! would only catch a byte-identical replay. Keying on the pair also catches an
//! issuer that reused a nonce across two *different* assertions — an issuer bug
//! or a compromised issuer trying to make two claims look like one — which is
//! the case worth failing on.

use alloc::collections::BTreeMap;
use core::fmt;

use crate::error::{AuthorityError, Result};
use crate::types::{AssertionNonce, AuthorityId};

/// Where an admitted assertion's nonce is recorded so it cannot be presented
/// twice.
///
/// A trait so a log with durable storage can keep the ledger in its database
/// (a restart must not reopen the window: unlike a relay's seen-set, nothing
/// here is invalidated by a lost TLS session) while a client verifying a served
/// assertion uses [`NonceLedger`] in memory.
pub trait NonceSeen {
    /// Record `(authority_id, nonce)` as admitted, or refuse it.
    ///
    /// `expires_ms` is the assertion's own expiry; the implementation MUST
    /// retain the entry at least that long.
    ///
    /// # Errors
    ///
    /// - [`AuthorityError::ReplayedNonce`] if the pair is already held.
    /// - [`AuthorityError::LedgerFull`] if the store is full of unexpired
    ///   entries. Refuse; never evict.
    fn observe(
        &mut self,
        now_ms: u64,
        authority_id: AuthorityId,
        nonce: AssertionNonce,
        expires_ms: u64,
    ) -> Result<()>;
}

/// The ledger key.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct NonceKey {
    authority_id: AuthorityId,
    nonce: AssertionNonce,
}

// Both halves are linkable — an authority id names an issuer, a nonce names one
// user's assertion. Neither renders.
impl fmt::Debug for NonceKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NonceKey(<redacted>)")
    }
}

/// An in-memory [`NonceSeen`].
///
/// A `BTreeMap` rather than a hash map for two reasons: this crate is `no_std`
/// so `HashMap` is not available without pulling a hasher, and a tree has no
/// hash-collision behaviour for an attacker who controls a nonce to aim at.
#[derive(Clone, Debug)]
pub struct NonceLedger {
    entries: BTreeMap<NonceKey, u64>,
    max_entries: usize,
    skew_ms: u64,
}

impl NonceLedger {
    /// A ledger holding at most `max_entries`, retaining each until its
    /// assertion's `expires_ms` plus `skew_ms`.
    ///
    /// `skew_ms` must be the same value the [`AuthorityConfig`] uses, so that
    /// an entry never ages out while the assertion it covers would still be
    /// accepted.
    ///
    /// [`AuthorityConfig`]: crate::authority::AuthorityConfig
    #[must_use]
    pub const fn new(max_entries: usize, skew_ms: u64) -> Self {
        Self {
            entries: BTreeMap::new(),
            max_entries,
            skew_ms,
        }
    }

    /// The bound at which the ledger fails closed.
    #[must_use]
    pub const fn max_entries(&self) -> usize {
        self.max_entries
    }

    /// How many entries are held right now.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the ledger is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Drop every entry whose assertion can no longer be accepted, and report
    /// how many went.
    ///
    /// Called by [`NonceSeen::observe`] first, so nothing has to schedule a
    /// sweep — this crate has no runtime and no timer. Public because an idle
    /// log would otherwise hold its last entries forever.
    pub fn expire(&mut self, now_ms: u64) -> usize {
        let before = self.entries.len();
        self.entries.retain(|_, drop_after| *drop_after > now_ms);
        before.saturating_sub(self.entries.len())
    }
}

impl NonceSeen for NonceLedger {
    fn observe(
        &mut self,
        now_ms: u64,
        authority_id: AuthorityId,
        nonce: AssertionNonce,
        expires_ms: u64,
    ) -> Result<()> {
        self.expire(now_ms);

        let key = NonceKey {
            authority_id,
            nonce,
        };
        if self.entries.contains_key(&key) {
            return Err(AuthorityError::ReplayedNonce);
        }
        // Checked after the replay lookup on purpose: a full ledger that is
        // handed a genuine replay should say so. Reporting capacity there would
        // hide an attack behind a load message.
        if self.entries.len() >= self.max_entries {
            return Err(AuthorityError::LedgerFull);
        }

        self.entries
            .insert(key, expires_ms.saturating_add(self.skew_ms));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    fn id(byte: u8) -> AuthorityId {
        AuthorityId::new([byte; 32])
    }

    fn nonce(byte: u8) -> AssertionNonce {
        AssertionNonce::new([byte; 16])
    }

    #[test]
    fn the_same_pair_twice_is_a_replay() {
        let mut ledger = NonceLedger::new(8, 0);
        assert!(ledger.observe(0, id(1), nonce(1), 1_000).is_ok());
        assert_eq!(
            ledger.observe(500, id(1), nonce(1), 1_000),
            Err(AuthorityError::ReplayedNonce)
        );
        // A different nonce under the same authority is not.
        assert!(ledger.observe(500, id(1), nonce(2), 1_000).is_ok());
        // Nor is the same nonce under a different authority.
        assert!(ledger.observe(500, id(2), nonce(1), 1_000).is_ok());
    }

    #[test]
    fn an_entry_outlives_the_assertion_it_covers_by_the_skew() {
        let mut ledger = NonceLedger::new(8, 100);
        assert!(ledger.observe(0, id(1), nonce(1), 1_000).is_ok());
        // Still held right up to `expires_ms + skew`. The assertion itself
        // stopped being acceptable at `expires_ms` — 100 ms earlier — so the
        // entry outliving it is the margin, which is the direction that has to
        // be true.
        assert_eq!(
            ledger.observe(1_099, id(1), nonce(1), 1_000),
            Err(AuthorityError::ReplayedNonce)
        );
        // Released once nothing it covers could be accepted anyway.
        assert!(ledger.observe(1_100, id(1), nonce(1), 1_000).is_ok());
    }

    #[test]
    fn a_full_ledger_refuses_and_does_not_evict() {
        let mut ledger = NonceLedger::new(2, 0);
        assert!(ledger.observe(0, id(1), nonce(1), 1_000).is_ok());
        assert!(ledger.observe(0, id(1), nonce(2), 1_000).is_ok());
        assert_eq!(
            ledger.observe(0, id(1), nonce(3), 1_000),
            Err(AuthorityError::LedgerFull)
        );
        // …and the entries that were already there are still there.
        assert_eq!(
            ledger.observe(0, id(1), nonce(1), 1_000),
            Err(AuthorityError::ReplayedNonce)
        );
        assert_eq!(ledger.len(), 2);
    }

    #[test]
    fn a_full_ledger_still_names_a_replay_a_replay() {
        let mut ledger = NonceLedger::new(1, 0);
        assert!(ledger.observe(0, id(1), nonce(1), 1_000).is_ok());
        assert_eq!(
            ledger.observe(0, id(1), nonce(1), 1_000),
            Err(AuthorityError::ReplayedNonce)
        );
    }

    #[test]
    fn expiry_reclaims_and_reports() {
        let mut ledger = NonceLedger::new(8, 0);
        assert!(ledger.observe(0, id(1), nonce(1), 100).is_ok());
        assert!(ledger.observe(0, id(1), nonce(2), 200).is_ok());
        assert_eq!(ledger.expire(150), 1);
        assert_eq!(ledger.len(), 1);
        assert!(!ledger.is_empty());
    }

    #[test]
    fn the_key_never_renders_its_bytes() {
        let key = NonceKey {
            authority_id: id(1),
            nonce: nonce(1),
        };
        assert_eq!(format!("{key:?}"), "NonceKey(<redacted>)");
    }
}
