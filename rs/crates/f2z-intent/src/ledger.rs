//! One-use, and what it costs to actually mean it.
//!
//! An intent is a single issuance of authority. Presenting the same bytes
//! twice must produce authority once — otherwise "the user approved a payment"
//! becomes "the user approved a payment, repeatedly, for as long as the
//! attacker keeps replaying the link".
//!
//! # Why a bounded ledger, and why it fails closed when full
//!
//! Remembering every identifier forever is unbounded memory driven by
//! untrusted input, which is a denial of service with extra steps. Remembering
//! the last *N* and evicting the oldest is the obvious fix and is **wrong
//! here**: an attacker who can send N+1 intents evicts the record of the one
//! they want to replay, and the ledger then cheerfully accepts it. That is the
//! shape of `WIRE.md` §5.5's seen-set bound, which answers it the same way
//! this does — by refusing new work rather than forgetting old work.
//!
//! So the bound is enforced in this order:
//!
//! 1. Drop every entry whose declared expiry has passed. An expired intent is
//!    already refused by [`crate::clock::check_request_window`], so its ledger
//!    entry can never authorize anything and dropping it is free.
//! 2. If the ledger is still full, refuse with [`IntentError::LedgerFull`].
//!
//! Because every intent's window is capped at
//! [`crate::wire::MAX_INTENT_LIFETIME_MS`], step 1 always makes progress
//! within five minutes, so a full ledger is a transient refusal rather than a
//! permanent wedge. [`IntentLedger::DEFAULT_CAPACITY`] is sized so that
//! reaching it requires a rate no honest caller comes close to.
//!
//! # What this is not
//!
//! It is not persistence. A ledger lives in the wallet process and is lost on
//! restart, which is deliberate and is the same choice
//! `wallet/zuuli/src/lib/wallet/creator-tip.ts` makes for its pending-intent
//! map: "reloads and fresh deep links intentionally lose this map and fail
//! closed". Losing the ledger cannot resurrect a *confirmed* intent, because
//! the confirmation ([`crate::confirmation`]) lives in the same process and is
//! lost with it. What a restart can do is let an unconfirmed intent be
//! presented again — and an unconfirmed intent is exactly a request the user
//! has not yet approved, so presenting it again shows them the confirmation
//! again. That is the correct behaviour, not a gap.

use alloc::vec::Vec;

use crate::clock::IntentClock;
use crate::error::IntentError;
use crate::wire::RequestId;

/// A claimed identifier and the wall-clock instant its intent expires.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Claim {
    request_id: RequestId,
    expires_at_ms: u64,
}

/// The set of intent identifiers already spent.
#[derive(Clone, Debug)]
pub struct IntentLedger {
    capacity: usize,
    claims: Vec<Claim>,
}

impl IntentLedger {
    /// How many unexpired intents one wallet process tracks at once.
    ///
    /// One thousand and twenty-four. At the five-minute lifetime ceiling that
    /// is roughly three issuances a second sustained, a rate no honest caller
    /// approaches: every one of them requires a human tapping a confirmation.
    pub const DEFAULT_CAPACITY: usize = 1024;

    /// An empty ledger with [`IntentLedger::DEFAULT_CAPACITY`].
    #[must_use]
    pub const fn new() -> Self {
        Self::with_capacity(Self::DEFAULT_CAPACITY)
    }

    /// An empty ledger with an explicit bound. Zero is legal and refuses
    /// everything, which is the correct reading of "remember nothing".
    #[must_use]
    pub const fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            claims: Vec::new(),
        }
    }

    /// How many unexpired claims are held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.claims.len()
    }

    /// Whether nothing is held.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.claims.is_empty()
    }

    /// Drop every claim whose intent has expired by `now`'s wall clock.
    ///
    /// Called by [`IntentLedger::claim`]; public because a wallet that goes
    /// quiet for a while may as well release the memory.
    pub fn prune(&mut self, now: IntentClock) {
        self.claims
            .retain(|claim| claim.expires_at_ms > now.wall_ms);
    }

    /// Spend an identifier, or refuse.
    ///
    /// # Errors
    ///
    /// - [`IntentError::Replay`] if this identifier has already been spent and
    ///   its intent has not yet expired.
    /// - [`IntentError::LedgerFull`] if pruning left no room. Fail closed: see
    ///   the module note on why eviction is not an option.
    pub fn claim(
        &mut self,
        request_id: &RequestId,
        expires_at_ms: u64,
        now: IntentClock,
    ) -> Result<(), IntentError> {
        self.prune(now);
        if self
            .claims
            .iter()
            .any(|claim| claim.request_id == *request_id)
        {
            return Err(IntentError::Replay);
        }
        if self.claims.len() >= self.capacity {
            return Err(IntentError::LedgerFull);
        }
        self.claims.push(Claim {
            request_id: *request_id,
            expires_at_ms,
        });
        Ok(())
    }
}

impl Default for IntentLedger {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: IntentClock = IntentClock::new(1_000, 1_700_000_000_000);

    fn id(byte: u8) -> RequestId {
        RequestId::new([byte; 32])
    }

    #[test]
    fn the_second_presentation_of_one_identifier_is_refused() {
        let mut ledger = IntentLedger::new();
        let expiry = NOW.wall_ms + 60_000;
        assert_eq!(ledger.claim(&id(1), expiry, NOW), Ok(()));
        assert_eq!(
            ledger.claim(&id(1), expiry, NOW),
            Err(IntentError::Replay),
            "one-use is one-use"
        );
        assert_eq!(ledger.claim(&id(2), expiry, NOW), Ok(()));
    }

    #[test]
    fn a_full_ledger_refuses_rather_than_evicting_the_record_it_needs() {
        let mut ledger = IntentLedger::with_capacity(2);
        let expiry = NOW.wall_ms + 60_000;
        assert_eq!(ledger.claim(&id(1), expiry, NOW), Ok(()));
        assert_eq!(ledger.claim(&id(2), expiry, NOW), Ok(()));
        assert_eq!(
            ledger.claim(&id(3), expiry, NOW),
            Err(IntentError::LedgerFull)
        );
        // The point of failing closed: the entry an attacker wanted evicted is
        // still there.
        assert_eq!(ledger.claim(&id(1), expiry, NOW), Err(IntentError::Replay));
    }

    #[test]
    fn expiry_makes_room_and_cannot_resurrect_an_expired_claim() {
        let mut ledger = IntentLedger::with_capacity(1);
        let expiry = NOW.wall_ms + 60_000;
        assert_eq!(ledger.claim(&id(1), expiry, NOW), Ok(()));
        let later = NOW.advanced(60_001);
        assert_eq!(ledger.claim(&id(2), later.wall_ms + 60_000, later), Ok(()));
        assert_eq!(ledger.len(), 1, "the expired claim was pruned, not kept");
        // Re-presenting the expired identifier is not stopped *here* — it is
        // stopped by the window check, which is a different guard with a
        // different error, and pretending otherwise would overstate this one.
        assert_eq!(
            ledger.claim(&id(1), later.wall_ms + 60_000, later),
            Err(IntentError::LedgerFull)
        );
    }

    #[test]
    fn a_zero_capacity_ledger_refuses_everything() {
        let mut ledger = IntentLedger::with_capacity(0);
        assert_eq!(
            ledger.claim(&id(1), NOW.wall_ms + 1, NOW),
            Err(IntentError::LedgerFull)
        );
    }
}
