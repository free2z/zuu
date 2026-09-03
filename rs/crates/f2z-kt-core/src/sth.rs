//! `SignedTreeHead`, its monotonicity rules, and log signing-key rotation —
//! `KT.md` §6.
//!
//! # The rules a client can run unaided
//!
//! §6.3's checks are the only part of the log's honesty a client can verify
//! with no proof, no witness and no network beyond the heads it already holds.
//! They are cheap, they are mandatory for clients as well as witnesses, and
//! rules 3 and 8 together are the **rollback** and **fork** tests. [`LogView`]
//! is where they live, and it is the only way to advance a pinned view of a log
//! in this crate.
//!
//! # Why a gap is an error and not a fetch
//!
//! §6.3 rule 7 says that if the new head is more than one epoch ahead, the
//! verifier MUST fetch every intervening head and check the chain link by link,
//! and **MUST NOT skip**. This crate has no network, so [`LogView::accept`]
//! answers a gap with [`KtError::EpochGap`] rather than silently accepting one:
//! *a gap accepted on trust is a branch accepted on trust*. A caller that has
//! fetched the intervening heads hands them to [`LogView::accept_chain`], which
//! walks them in order. There is no third method, and no flag that turns the
//! check off.

use f2z_codec::canonical::{Canonical as _, encode};
use f2z_codec::types::{Digest, PublicKey, ShortBytes, Signature};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::KT_VERSION;
use crate::error::KtError;
use crate::labels::{LABEL_LOG_KEY_TRANSITION, LABEL_STH, sth_hash};
use crate::sig;
use crate::types::{LogId, check_label, label_field};

/// The `SignedTreeHeadTBS` of §6.1 — the log's periodic statement about itself.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignedTreeHeadTBS {
    /// Exactly `"free2z/kt/v1/sth"`.
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// `H("free2z/kt/v1/log-id", genesis_log_pk)`. **Never changes**, including
    /// across a signing-key rotation (§6.4).
    pub log_id: LogId,
    /// Increments by exactly 1 per published epoch, empty epochs included.
    pub epoch: u64,
    /// Total `(label, version)` insertions committed.
    pub tree_size: u64,
    /// The `akd` `Azks` root at this epoch.
    pub root_hash: Digest,
    /// `H("free2z/kt/v1/tree-head-hash", tls_codec(prev SignedTreeHeadTBS))`.
    pub prev_sth_hash: Digest,
    /// The ECVRF key labels are derived under. **MUST NOT** change within a
    /// `log_id` (§6.1).
    pub vrf_public_key: PublicKey,
    /// The log's clock.
    pub published_at_ms: u64,
    /// Platform resets in this epoch (ADR 0014). In the signed contents, so an
    /// abnormal rate is visible to anyone tracking tree heads without a single
    /// per-handle lookup.
    pub reset_count: u32,
    /// The published cadence (§5.1).
    pub epoch_interval_seconds: u32,
    /// The published merge promise (§5.2).
    pub max_merge_delay_seconds: u32,
    /// All-zero = none (§6.4).
    pub successor_log_pk: PublicKey,
}

impl SignedTreeHeadTBS {
    /// Check the constants a decoder cannot.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_STH)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        Ok(())
    }

    /// The exact bytes the log signs — encoded and signed directly, not
    /// prehashed (§6.2).
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }

    /// `H("free2z/kt/v1/tree-head-hash", tls_codec(self))` — what the **next** head's
    /// `prev_sth_hash` must equal (§6.1).
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn chain_hash(&self) -> Result<Digest, KtError> {
        Ok(sth_hash(&self.signing_bytes()?))
    }

    /// Whether this head announces a successor signing key (§6.4).
    #[must_use]
    pub fn announces_successor(&self) -> bool {
        !self.successor_log_pk.is_zero()
    }

    /// Build the `label` field for a tree head.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the constant does not fit, which it does.
    pub fn label_bytes() -> Result<ShortBytes, KtError> {
        label_field(LABEL_STH)
    }
}

/// A `SignedTreeHead` (§6.1).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignedTreeHead {
    /// The signed contents.
    pub sth: SignedTreeHeadTBS,
    /// Ed25519 over `tls_codec(sth)`.
    pub signature: Signature,
}

impl SignedTreeHead {
    /// Verify the signature under a log key, having first checked the label,
    /// version and `log_id` constants (§6.3 rules 1 and 2).
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`],
    /// [`KtError::WrongLog`] or [`KtError::BadSignature`].
    pub fn verify(&self, log_id: &LogId, log_pk: &PublicKey) -> Result<(), KtError> {
        self.sth.validate()?;
        if self.sth.log_id != *log_id {
            return Err(KtError::WrongLog);
        }
        sig::verify(log_pk, &self.sth.signing_bytes()?, &self.signature)
    }
}

/// A pinned view of one log: the state §7.1 says a witness holds durably, and
/// the state §8.1 step 7 says a client pins.
///
/// A few hundred bytes. Advancing it is [`LogView::accept`] and there is no
/// other way, so §6.3's rules cannot be skipped by a caller that forgot them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogView {
    log_id: LogId,
    accepted_log_pk: PublicKey,
    /// The canonical value that passed verification most recently. Keeping the
    /// decoded structure means repeat equality uses the protocol type itself,
    /// not a second encoding or a hand-maintained subset of its fields.
    last_head: SignedTreeHead,
    epoch: u64,
    tree_size: u64,
    root_hash: Digest,
    sth_hash: Digest,
    vrf_public_key: PublicKey,
    published_at_ms: u64,
}

impl LogView {
    /// Pin a log from the first tree head this party has ever seen, having
    /// verified its signature under the key it trusts for this `log_id`.
    ///
    /// **This is trust on first use and nothing more.** The first head cannot be
    /// checked against anything; §6.3's rules are all relative. What makes the
    /// pin worth having is every head after it.
    ///
    /// # Errors
    ///
    /// As [`SignedTreeHead::verify`].
    pub fn pin(
        log_id: LogId,
        accepted_log_pk: PublicKey,
        head: &SignedTreeHead,
    ) -> Result<Self, KtError> {
        head.verify(&log_id, &accepted_log_pk)?;
        Ok(Self {
            log_id,
            accepted_log_pk,
            last_head: head.clone(),
            epoch: head.sth.epoch,
            tree_size: head.sth.tree_size,
            root_hash: head.sth.root_hash,
            sth_hash: head.sth.chain_hash()?,
            vrf_public_key: head.sth.vrf_public_key,
            published_at_ms: head.sth.published_at_ms,
        })
    }

    /// The pinned `log_id`.
    #[must_use]
    pub const fn log_id(&self) -> &LogId {
        &self.log_id
    }

    /// The log signing key currently accepted for this `log_id` (§6.4).
    #[must_use]
    pub const fn accepted_log_pk(&self) -> &PublicKey {
        &self.accepted_log_pk
    }

    /// The last accepted epoch.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The last accepted tree size.
    #[must_use]
    pub const fn tree_size(&self) -> u64 {
        self.tree_size
    }

    /// The last accepted root hash.
    #[must_use]
    pub const fn root_hash(&self) -> &Digest {
        &self.root_hash
    }

    /// `H("free2z/kt/v1/tree-head-hash", …)` of the last accepted head.
    #[must_use]
    pub const fn sth_hash(&self) -> &Digest {
        &self.sth_hash
    }

    /// The VRF key every label in the tree is derived under.
    #[must_use]
    pub const fn vrf_public_key(&self) -> &PublicKey {
        &self.vrf_public_key
    }

    /// Apply §6.3 in full and, for a later epoch, advance to `head`.
    ///
    /// The eight rules, in §6.3's order:
    ///
    /// 1. the signature verifies under the currently accepted log key;
    /// 2. `label`, `kt_version` and `log_id` are exact;
    /// 3. an older epoch is a rollback; at the same epoch only the complete
    ///    previously accepted [`SignedTreeHead`] is an idempotent no-op;
    /// 4. `tree_size >= last.tree_size`;
    /// 5. `published_at_ms > last.published_at_ms`;
    /// 6. `vrf_public_key == last.vrf_public_key`;
    /// 7. the `prev_sth_hash` chain connects, with **no skipping** over a gap;
    /// 8. any other valid head at the same epoch is fork evidence.
    ///
    /// # Errors
    ///
    /// - [`KtError::Fork`] — rule 8, and it is fatal. The two heads are the
    ///   complete evidence (§8.4).
    /// - [`KtError::Rollback`] — rules 3, 4 or 5.
    /// - [`KtError::VrfKeyChange`] — rule 6. Treat as a fork, never as an
    ///   update (§6.1).
    /// - [`KtError::EpochGap`] — rule 7 with a gap. Fetch the intervening heads
    ///   and use [`LogView::accept_chain`].
    /// - [`KtError::ChainBreak`] — rule 7 with a broken link.
    /// - [`KtError::BadSignature`], [`KtError::WrongLog`],
    ///   [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`] — rules 1
    ///   and 2.
    pub fn accept(&mut self, head: &SignedTreeHead) -> Result<(), KtError> {
        // Rules 1 and 2.
        head.verify(&self.log_id, &self.accepted_log_pk)?;

        // Rule 8 first among the ordering rules. Equality is over the canonical
        // protocol value itself: every TBS field and the signature, with no
        // alternate encoding and no subset that can drift as fields are added.
        // kt-sth-repeat-runtime:start
        if head.sth.epoch == self.epoch {
            return if head == &self.last_head {
                Ok(())
            } else {
                Err(KtError::Fork)
            };
        }
        // kt-sth-repeat-runtime:end
        // Rule 3.
        if head.sth.epoch < self.epoch {
            return Err(KtError::Rollback);
        }
        // Rule 4.
        if head.sth.tree_size < self.tree_size {
            return Err(KtError::Rollback);
        }
        // Rule 5.
        if head.sth.published_at_ms <= self.published_at_ms {
            return Err(KtError::Rollback);
        }
        // Rule 6.
        if head.sth.vrf_public_key != self.vrf_public_key {
            return Err(KtError::VrfKeyChange);
        }
        // Rule 7. `epoch > self.epoch` here, so the only two cases are the
        // direct link and a gap; there is no branch that advances without one.
        if head.sth.epoch != self.epoch.saturating_add(1) {
            return Err(KtError::EpochGap);
        }
        if head.sth.prev_sth_hash != self.sth_hash {
            return Err(KtError::ChainBreak);
        }

        self.last_head = head.clone();
        self.epoch = head.sth.epoch;
        self.tree_size = head.sth.tree_size;
        self.root_hash = head.sth.root_hash;
        self.sth_hash = head.sth.chain_hash()?;
        self.published_at_ms = head.sth.published_at_ms;
        Ok(())
    }

    /// Walk a contiguous run of tree heads, applying [`LogView::accept`] to
    /// each in turn.
    ///
    /// This is how §6.3 rule 7's *"fetch every intervening tree head and check
    /// the chain link by link"* is satisfied. The view is advanced only as far
    /// as the run verified: on failure the caller holds a view pinned to the
    /// last head that passed, which is the state a witness must persist before
    /// it halts (§7.1).
    ///
    /// # Errors
    ///
    /// As [`LogView::accept`], for the first head that fails.
    pub fn accept_chain(&mut self, heads: &[SignedTreeHead]) -> Result<(), KtError> {
        for head in heads {
            self.accept(head)?;
        }
        Ok(())
    }

    /// Install a successor log signing key (§6.4).
    ///
    /// All four conditions must hold, and the caller supplies the evidence for
    /// the first:
    ///
    /// 1. the **announcing** head was observed and carried ≥ *t* valid
    ///    cosignatures from the caller's own witness set — proved by handing in
    ///    an [`AcceptedRoot`] for it;
    /// 2. `effective_epoch > announce_epoch`, with at least one full epoch of
    ///    separation;
    /// 3. the transition's `announce_sth_hash` matches that head and **both**
    ///    signatures verify;
    /// 4. the first head signed by the successor chains to the last one signed
    ///    by the outgoing key and satisfies §6.3 in full — which is the caller's
    ///    next [`LogView::accept`], now against the new key.
    ///
    /// **The cosignature requirement is not optional.** A party that accepts a
    /// new signing key on the strength of a signature by that same new key
    /// accepts any key from any attacker; a party that accepts it on the
    /// outgoing key alone is safe only until the outgoing key is the thing that
    /// was compromised — which is the most likely reason to be rotating.
    /// Requiring that the announcement was itself witnessed means an attacker
    /// must have already defeated the threshold, at which point they did not
    /// need the rotation path. That is why this method takes an
    /// [`AcceptedRoot`], which only [`crate::witness::verify_threshold`]
    /// constructs.
    ///
    /// # Errors
    ///
    /// [`KtError::BadKeyTransition`] if any structural condition fails,
    /// [`KtError::BadSignature`] if either signature does not verify,
    /// [`KtError::WrongLabel`] if the transition is not a transition, and
    /// [`KtError::WrongLog`] if it is another log's.
    ///
    /// [`AcceptedRoot`]: crate::witness::AcceptedRoot
    pub fn accept_log_key_transition(
        &mut self,
        announcing: &SignedTreeHead,
        announcing_root: &crate::witness::AcceptedRoot,
        transition: &LogKeyTransition,
    ) -> Result<(), KtError> {
        // §6.2, before anything else.
        check_label(&transition.transition.label, LABEL_LOG_KEY_TRANSITION)?;
        if transition.transition.log_id != self.log_id {
            return Err(KtError::WrongLog);
        }
        // Condition 1: the cosigned root and the announcing head are the same
        // head. `AcceptedRoot` cannot be built without meeting the threshold, so
        // this comparison is what binds that evidence to *this* announcement.
        if announcing_root.log_id() != &self.log_id
            || announcing_root.epoch() != announcing.sth.epoch
            || announcing_root.root_hash() != &announcing.sth.root_hash
            || announcing_root.tree_size() != announcing.sth.tree_size
        {
            return Err(KtError::BadKeyTransition);
        }
        announcing.verify(&self.log_id, &self.accepted_log_pk)?;
        if !announcing.sth.announces_successor() {
            return Err(KtError::BadKeyTransition);
        }
        if announcing.sth.successor_log_pk != transition.transition.successor_log_pk {
            return Err(KtError::BadKeyTransition);
        }
        if transition.transition.outgoing_log_pk != self.accepted_log_pk {
            return Err(KtError::BadKeyTransition);
        }
        if transition.transition.announce_epoch != announcing.sth.epoch {
            return Err(KtError::BadKeyTransition);
        }
        // Condition 3, the hash half.
        if transition.transition.announce_sth_hash != announcing.sth.chain_hash()? {
            return Err(KtError::BadKeyTransition);
        }
        // Condition 2: strictly later, and at least one full epoch of
        // separation, so the announcement is visible before it takes effect.
        // "> announce_epoch, with at least one full epoch of separation" reads
        // as effective_epoch >= announce_epoch + 2: `announce_epoch + 1` is the
        // very next epoch, which leaves no epoch in between for anyone to see
        // the announcement in.
        if transition.transition.effective_epoch < announcing.sth.epoch.saturating_add(2) {
            return Err(KtError::BadKeyTransition);
        }
        // Condition 3, the signature half: BOTH keys, outgoing and successor.
        let bytes = transition.transition.signing_bytes()?;
        sig::verify(
            &transition.transition.outgoing_log_pk,
            &bytes,
            &transition.outgoing_signature,
        )?;
        sig::verify(
            &transition.transition.successor_log_pk,
            &bytes,
            &transition.successor_signature,
        )?;

        // Condition 4 is the caller's next `accept`, which now runs against the
        // successor key. `log_id` is deliberately untouched: it is derived from
        // the *genesis* key and never changes (§6.1).
        self.accepted_log_pk = transition.transition.successor_log_pk;
        Ok(())
    }
}

/// The `LogKeyTransitionTBS` of §6.4.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct LogKeyTransitionTBS {
    /// Exactly `"free2z/kt/v1/log-key-transition"`.
    pub label: ShortBytes,
    /// The log whose key is changing. Unchanged by the rotation (§6.1).
    pub log_id: LogId,
    /// The epoch of the announcing tree head.
    pub announce_epoch: u64,
    /// `H("free2z/kt/v1/tree-head-hash", tls_codec(announcing sth))`.
    pub announce_sth_hash: Digest,
    /// The key being retired.
    pub outgoing_log_pk: PublicKey,
    /// The key being installed.
    pub successor_log_pk: PublicKey,
    /// The first epoch signed by the successor.
    pub effective_epoch: u64,
}

impl LogKeyTransitionTBS {
    /// The exact bytes **both** log keys sign.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }
}

/// A `LogKeyTransition` (§6.4): dual-signed, published, and delayed.
///
/// Deliberately the same shape as ADR 0014's user key change — dual signature,
/// plus published evidence, plus a delay.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct LogKeyTransition {
    /// The signed contents.
    pub transition: LogKeyTransitionTBS,
    /// Ed25519 by `transition.outgoing_log_pk`.
    pub outgoing_signature: Signature,
    /// Ed25519 by `transition.successor_log_pk`.
    pub successor_signature: Signature,
}

impl LogKeyTransition {
    /// The canonical bytes, for publication alongside the announcing head.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn to_bytes(&self) -> Result<Vec<u8>, KtError> {
        self.encode_canonical().map_err(KtError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestLog;

    #[test]
    fn a_clean_chain_advances() {
        let log = TestLog::new();
        let head0 = log.head(0);
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &head0).unwrap();
        assert_eq!(view.epoch(), 0);
        for epoch in 1..=5 {
            assert_eq!(view.accept(&log.head(epoch)), Ok(()));
            assert_eq!(view.epoch(), epoch);
        }
    }

    #[test]
    fn the_same_complete_head_twice_is_idempotent() {
        let log = TestLog::new();
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        view.accept(&log.head(1)).unwrap();
        assert_eq!(view.accept(&log.head(1)), Ok(()));
    }

    #[test]
    fn every_mutable_signed_field_is_part_of_same_epoch_equality() {
        type Mutation = (&'static str, fn(&mut SignedTreeHeadTBS));

        // kt-sth-repeat-field-tests:start
        let mutations: [Mutation; 9] = [
            ("tree_size", |sth| {
                sth.tree_size = sth.tree_size.saturating_add(1)
            }),
            ("root_hash", |sth| sth.root_hash = Digest::new([0xaa; 32])),
            ("prev_sth_hash", |sth| {
                sth.prev_sth_hash = Digest::new([0xbb; 32])
            }),
            ("vrf_public_key", |sth| {
                sth.vrf_public_key = PublicKey::new([0xcc; 32])
            }),
            ("published_at_ms", |sth| {
                sth.published_at_ms = sth.published_at_ms.saturating_add(1);
            }),
            ("reset_count", |sth| {
                sth.reset_count = sth.reset_count.saturating_add(1)
            }),
            ("epoch_interval_seconds", |sth| {
                sth.epoch_interval_seconds = sth.epoch_interval_seconds.saturating_add(1);
            }),
            ("max_merge_delay_seconds", |sth| {
                sth.max_merge_delay_seconds = sth.max_merge_delay_seconds.saturating_add(1);
            }),
            ("successor_log_pk", |sth| {
                sth.successor_log_pk = PublicKey::new([0xdd; 32]);
            }),
        ];
        // kt-sth-repeat-field-tests:end

        for (field, mutate) in mutations {
            let log = TestLog::new();
            let accepted = log.head(1);
            let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
            view.accept(&accepted).unwrap();

            let mut alternative = accepted.clone();
            mutate(&mut alternative.sth);
            let alternative = log.resign(alternative);
            assert_eq!(
                view.accept(&alternative),
                Err(KtError::Fork),
                "same-epoch mutation of {field} escaped complete-head equality",
            );
            assert_eq!(
                view.accept(&accepted),
                Ok(()),
                "{field} mutation changed the view"
            );
        }
    }

    #[test]
    fn same_epoch_type_identity_and_signature_are_verified_before_equality() {
        let log = TestLog::new();
        let accepted = log.head(1);
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        view.accept(&accepted).unwrap();

        let mut wrong_label = accepted.clone();
        wrong_label.sth.label = ShortBytes::new(b"free2z/kt/v1/not-sth".to_vec()).unwrap();
        assert_eq!(
            view.accept(&log.resign(wrong_label)),
            Err(KtError::WrongLabel)
        );

        let mut wrong_version = accepted.clone();
        wrong_version.sth.kt_version = KT_VERSION.saturating_add(1);
        assert_eq!(
            view.accept(&log.resign(wrong_version)),
            Err(KtError::UnsupportedVersion)
        );

        let mut wrong_log = accepted.clone();
        wrong_log.sth.log_id = LogId::new([0xee; 32]);
        assert_eq!(view.accept(&log.resign(wrong_log)), Err(KtError::WrongLog));

        let mut bad_signature = accepted.clone();
        bad_signature.signature = Signature::new([0xff; 64]);
        assert_eq!(view.accept(&bad_signature), Err(KtError::BadSignature));

        assert_eq!(view.accept(&accepted), Ok(()));
    }

    #[test]
    fn a_rollback_is_refused_in_every_field_that_can_roll_back() {
        let log = TestLog::new();
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        view.accept(&log.head(1)).unwrap();
        view.accept(&log.head(2)).unwrap();

        assert_eq!(view.accept(&log.head(1)), Err(KtError::Rollback));

        let mut shrunk = log.head(3);
        shrunk.sth.tree_size = 0;
        assert_eq!(view.accept(&log.resign(shrunk)), Err(KtError::Rollback));

        let mut stale = log.head(3);
        stale.sth.published_at_ms = 0;
        assert_eq!(view.accept(&log.resign(stale)), Err(KtError::Rollback));
    }

    #[test]
    fn a_gap_is_never_skipped() {
        let log = TestLog::new();
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        // Epoch 3 is signed, chains correctly to epoch 2, and is still refused:
        // the verifier has not seen 1 or 2.
        assert_eq!(view.accept(&log.head(3)), Err(KtError::EpochGap));
        assert_eq!(view.epoch(), 0, "a refused head must not advance the view");

        let intervening = [log.head(1), log.head(2), log.head(3)];
        assert_eq!(view.accept_chain(&intervening), Ok(()));
        assert_eq!(view.epoch(), 3);
    }

    #[test]
    fn a_broken_chain_link_is_refused() {
        let log = TestLog::new();
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        let mut broken = log.head(1);
        broken.sth.prev_sth_hash = Digest::new([1u8; 32]);
        assert_eq!(view.accept(&log.resign(broken)), Err(KtError::ChainBreak));
    }

    #[test]
    fn a_changed_vrf_key_is_a_fork_not_an_update() {
        let log = TestLog::new();
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        let mut swapped = log.head(1);
        swapped.sth.vrf_public_key = PublicKey::new([9u8; 32]);
        assert_eq!(
            view.accept(&log.resign(swapped)),
            Err(KtError::VrfKeyChange),
            "it determines every label in the tree; a change invalidates every prior proof",
        );
    }

    #[test]
    fn another_logs_head_and_another_key_are_both_refused() {
        let log = TestLog::new();
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();

        let mut foreign = log.head(1);
        foreign.sth.log_id = LogId::new([3u8; 32]);
        assert_eq!(view.accept(&log.resign(foreign)), Err(KtError::WrongLog));

        // An unsigned edit: the contents changed and the signature did not.
        let mut tampered = log.head(1);
        tampered.sth.reset_count = 41;
        assert_eq!(view.accept(&tampered), Err(KtError::BadSignature));
    }

    #[test]
    fn a_receipt_cannot_be_accepted_as_a_tree_head() {
        // §6.2's stated reason for the label field: the log's signing key signs
        // tree heads, receipts and key transitions, so a verifier that accepts
        // "a signature from the log" over bytes it did not type-check is one
        // field-alignment coincidence away from this.
        let log = TestLog::new();
        let mut head = log.head(1);
        head.sth.label = ShortBytes::new(crate::labels::LABEL_RECEIPT.to_vec()).unwrap();
        let head = log.resign(head);
        let mut view = LogView::pin(*log.log_id(), *log.log_pk(), &log.head(0)).unwrap();
        assert_eq!(view.accept(&head), Err(KtError::WrongLabel));
    }
}
