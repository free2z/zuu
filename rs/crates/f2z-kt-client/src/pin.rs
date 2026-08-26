//! Pins — `KT.md` §8.1 step 8, and the rule that a pin is never overwritten
//! silently.
//!
//! # What a pin is for
//!
//! §8.1 step 8: *"Pin `(handle, identity_pk, entry_version, prev_entry_hash,
//! epoch)`."* A pin is what turns a directory answer into something a later
//! answer can contradict. Without one, every lookup is a fresh trust-on-first-
//! use and a substituted key is indistinguishable from the truth.
//!
//! # The rule
//!
//! `CLIENT-CONTRACT.md` §9 rule 9, added by the 2026-08-24 correction:
//!
//! > And if the client already holds a pin for that handle, the answer is a
//! > contradiction it **cannot prove to anyone**: raise an alarm and fail
//! > closed. **Silently dropping the pin would complete the attack.**
//!
//! So [`PinStore`] has no `insert` that overwrites. [`PinStore::pin`] refuses a
//! contradiction, [`PinStore::advance`] takes only a pin that chains forward
//! from the one held, and the one method that replaces a pin across an identity
//! key change is named [`PinStore::accept_key_change`] and is reachable only
//! from `KtClient` after a verified history. There is no `remove`.

use f2z_codec::types::{Digest, PublicKey};
use f2z_kt_core::submit::PublishedEntry;
use f2z_kt_core::types::Handle;

use crate::error::{ClientError, Result};

/// What this client has committed to about one handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandlePin {
    published: PublishedEntry,
    prev_entry_hash: Digest,
    epoch: u64,
}

impl HandlePin {
    /// Build a pin from a published entry and the epoch it was seen in.
    #[must_use]
    pub const fn new(published: PublishedEntry, prev_entry_hash: Digest, epoch: u64) -> Self {
        Self {
            published,
            prev_entry_hash,
            epoch,
        }
    }

    /// The handle.
    #[must_use]
    pub const fn handle(&self) -> &Handle {
        self.published.handle()
    }

    /// The identity key in force — the value a safety number is computed over
    /// and a key change is detected against.
    #[must_use]
    pub const fn identity_pk(&self) -> &PublicKey {
        self.published.identity_pk()
    }

    /// The `entry_version` this pin is at (§4.2).
    #[must_use]
    pub const fn entry_version(&self) -> u32 {
        self.published.entry_version()
    }

    /// The pinned entry's own `prev_entry_hash` — what it chained *from*.
    #[must_use]
    pub const fn prev_entry_hash(&self) -> &Digest {
        &self.prev_entry_hash
    }

    /// `H("free2z/kt/v1/prev", …)` of the pinned entry — what the **next**
    /// entry must chain to.
    #[must_use]
    pub const fn chain_hash(&self) -> &Digest {
        self.published.chain_hash()
    }

    /// The epoch this pin was established or last advanced in.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The published state, for handing to `f2z-kt-core`'s chain checks.
    #[must_use]
    pub const fn published(&self) -> &PublishedEntry {
        &self.published
    }
}

/// Every pin this client holds.
///
/// A `Vec` rather than a map: a client's pinned set is its contact list, which
/// is tens of entries and not thousands, and a linear scan over that is
/// cheaper than the hashing a map would do — while being a shape a reader can
/// check by eye for the one property that matters, which is that nothing
/// overwrites.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PinStore {
    pins: Vec<HandlePin>,
}

impl PinStore {
    /// An empty store.
    #[must_use]
    pub const fn new() -> Self {
        Self { pins: Vec::new() }
    }

    /// Restore a store from persisted pins.
    ///
    /// # Errors
    ///
    /// [`ClientError::PinConflict`] if two pins name the same handle. A
    /// persisted store that already contradicts itself is not something to pick
    /// a winner from.
    pub fn restore(pins: Vec<HandlePin>) -> Result<Self> {
        for (index, pin) in pins.iter().enumerate() {
            if pins
                .iter()
                .skip(index.saturating_add(1))
                .any(|other| other.handle() == pin.handle())
            {
                return Err(ClientError::PinConflict);
            }
        }
        Ok(Self { pins })
    }

    /// Every pin.
    #[must_use]
    pub fn pins(&self) -> &[HandlePin] {
        &self.pins
    }

    /// The pin for a handle, if there is one.
    #[must_use]
    pub fn get(&self, handle: &Handle) -> Option<&HandlePin> {
        self.pins.iter().find(|pin| pin.handle() == handle)
    }

    /// Establish a pin for a handle that has none — §8.1 step 8's first
    /// resolution.
    ///
    /// # Errors
    ///
    /// [`ClientError::PinConflict`] if a pin already exists. Overwriting is not
    /// available from here at any version, in any direction: a caller that
    /// wants to move a pin forward calls [`PinStore::advance`], and one that
    /// wants to cross a key change calls [`PinStore::accept_key_change`].
    pub fn establish(&mut self, pin: HandlePin) -> Result<()> {
        if self.get(pin.handle()).is_some() {
            return Err(ClientError::PinConflict);
        }
        self.pins.push(pin);
        Ok(())
    }

    /// Move a pin forward by exactly one entry, under the **same identity key**.
    ///
    /// This is the ordinary case: a peer added a device or changed a contact
    /// endpoint. §4.4's `same_key` rule authorizes it, the caller has already
    /// checked that authorization, and the pin advances without an alarm.
    ///
    /// # Errors
    ///
    /// [`ClientError::PinConflict`] if no pin exists, if `next` is not
    /// `pinned.entry_version + 1`, if it does not chain to the pinned entry's
    /// `chain_hash`, or if the identity key changed. **The identity check is
    /// here and not only at the call site**: this is the method a future caller
    /// will reach for, and a key change that slipped through it would be the
    /// silent overwrite rule 9 forbids.
    pub fn advance(&mut self, next: HandlePin) -> Result<()> {
        let Some(existing) = self
            .pins
            .iter_mut()
            .find(|pin| pin.handle() == next.handle())
        else {
            return Err(ClientError::PinConflict);
        };
        if next.entry_version() != existing.entry_version().saturating_add(1) {
            return Err(ClientError::PinConflict);
        }
        if next.prev_entry_hash() != existing.chain_hash() {
            return Err(ClientError::PinConflict);
        }
        if next.identity_pk() != existing.identity_pk() {
            return Err(ClientError::PinConflict);
        }
        *existing = next;
        Ok(())
    }

    /// Replace a pin across an identity key change.
    ///
    /// `pub(crate)` on purpose. `KtClient::accept_key_change` is the only
    /// caller, and it reaches this only after fetching the handle's history,
    /// verifying it against a **witnessed** root, checking §4.4's authorization
    /// on every intervening entry, and raising the non-dismissible alarm
    /// §8.2 step 5 requires. A public method here would be an unaudited path to
    /// the one state change this module exists to make difficult.
    ///
    /// # Errors
    ///
    /// [`ClientError::PinConflict`] if no pin exists for the handle, or if the
    /// replacement is not strictly later than the one held.
    pub(crate) fn accept_key_change(&mut self, next: HandlePin) -> Result<()> {
        let Some(existing) = self
            .pins
            .iter_mut()
            .find(|pin| pin.handle() == next.handle())
        else {
            return Err(ClientError::PinConflict);
        };
        if next.entry_version() <= existing.entry_version() {
            return Err(ClientError::PinConflict);
        }
        *existing = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use f2z_codec::types::{Digest, PublicKey};
    use f2z_kt_core::types::Handle;

    use super::{HandlePin, PinStore};

    fn handle() -> Handle {
        Handle::new(b"alice".to_vec()).unwrap()
    }

    /// A pin over a real entry, so `chain_hash` is the real
    /// `H("free2z/kt/v1/prev", …)` and the chaining rules are exercised as they
    /// are in production rather than against numbers a test chose.
    fn pin(version: u32, identity: u8, prev: Digest) -> HandlePin {
        let published = crate::testing::published("alice", version, identity, prev);
        HandlePin::new(published, prev, u64::from(version))
    }

    /// What the next entry after this pin must carry as its `prev_entry_hash`.
    fn next_hash(pin: &HandlePin) -> Digest {
        *pin.chain_hash()
    }

    #[test]
    fn a_pin_is_never_overwritten_by_establishing_a_second_one() {
        let first = pin(1, 0xaa, Digest::zero());
        let mut store = PinStore::new();
        store.establish(first.clone()).unwrap();
        assert!(
            store.establish(pin(2, 0xbb, next_hash(&first))).is_err(),
            "silently dropping the pin would complete the attack"
        );
        assert_eq!(store.get(&handle()).unwrap().entry_version(), 1);
        assert_eq!(
            store.get(&handle()).unwrap().identity_pk(),
            &PublicKey::new([0xaa; 32])
        );
    }

    #[test]
    fn advancing_refuses_an_identity_key_change_even_when_the_chain_is_perfect() {
        let first = pin(1, 0xaa, Digest::zero());
        let mut store = PinStore::new();
        store.establish(first.clone()).unwrap();
        // Version 2, chaining correctly from version 1's chain hash, but under
        // a new identity key. The chain is exactly what a rotation produces, so
        // the only thing standing between this and a silent overwrite is the
        // key comparison.
        assert!(store.advance(pin(2, 0xbb, next_hash(&first))).is_err());
        assert_eq!(
            store.get(&handle()).unwrap().identity_pk(),
            &PublicKey::new([0xaa; 32])
        );
    }

    #[test]
    fn advancing_refuses_a_version_that_does_not_chain() {
        let first = pin(1, 0xaa, Digest::zero());
        let mut store = PinStore::new();
        store.establish(first.clone()).unwrap();
        // Right version, wrong `prev_entry_hash`.
        assert!(
            store
                .advance(pin(2, 0xaa, Digest::new([0x77; 32])))
                .is_err()
        );
        // Right chain, skipped version.
        assert!(store.advance(pin(3, 0xaa, next_hash(&first))).is_err());
        // Both right.
        store.advance(pin(2, 0xaa, next_hash(&first))).unwrap();
        assert_eq!(store.get(&handle()).unwrap().entry_version(), 2);
    }

    #[test]
    fn a_restored_store_that_contradicts_itself_is_refused() {
        let first = pin(1, 0xaa, Digest::zero());
        assert!(PinStore::restore(vec![first.clone(), pin(2, 0xbb, next_hash(&first))]).is_err());
        assert!(PinStore::restore(vec![first]).is_ok());
    }
}
