//! `WitnessCosignature` — `KT.md` §7.2.
//!
//! **It signs the contents — `log_id`, `epoch`, `tree_size`, `root_hash` — and
//! not the log's signature over them.** Three consequences, and the design is
//! chosen for all three:
//!
//! 1. **The statement is verifiable by someone who never saw the log's
//!    signature**, and who does not have or trust the log's public key.
//!    "Witness W says the log with id L had root R at epoch E with size S" is a
//!    complete, checkable claim from the cosignature bytes and W's public key
//!    alone. A cosignature over the log's signature bytes would be meaningless
//!    without first obtaining the log's signature *and* its key, from the very
//!    party under suspicion.
//! 2. **Two conflicting statements are directly non-repudiable against the
//!    witness** — see [`VerifiedCosignature::contradicts`]. No third document is
//!    needed to establish the contradiction: the two cosignatures and the
//!    witness's own public key are the whole proof. That is what makes a witness
//!    accountable rather than merely helpful.
//!
//!    Non-repudiation is a property of *signatures*, so the contradiction test
//!    lives on [`VerifiedCosignature`] and not on [`WitnessCosignature`].
//!    Unverified cosignature bytes are a document anyone can author — flip a
//!    byte of a genuine `root_hash` and you hold a "second statement" the
//!    witness never made. A predicate that compared only the statement fields
//!    would call that a contradiction and hand its caller an accusation with no
//!    authentication behind it, which is the one direction this crate must never
//!    let a caller get wrong.
//! 3. **`witness_pk` is inside the signed bytes**, so a cosignature cannot be
//!    re-attributed to another witness, and a witness cannot later claim a
//!    cosignature was someone else's.
//!
//! # What a cosignature does not say
//!
//! It does not say the witness verified the append-only proof (§7.4). It does
//! not say the root is *correct*, only that this witness saw it and that its own
//! history is consistent with it. And a witness that never cosigns at all is
//! indistinguishable from one that is offline; absence is not evidence.

use f2z_codec::canonical::encode;
use f2z_codec::types::{Digest, PublicKey, ShortBytes, Signature};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::KT_VERSION;
use crate::error::KtError;
use crate::labels::LABEL_COSIG;
use crate::sig;
use crate::sth::SignedTreeHead;
use crate::types::{LogId, check_label, label_field};

/// The `WitnessCosignatureTBS` of §7.2.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct WitnessCosignatureTBS {
    /// Exactly `"free2z/kt/v1/cosig"`.
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The log observed.
    pub log_id: LogId,
    /// The epoch observed.
    pub epoch: u64,
    /// The tree size at that epoch.
    pub tree_size: u64,
    /// The root at that epoch.
    pub root_hash: Digest,
    /// The witness making the statement. **Inside** the signed bytes, so the
    /// statement cannot be re-attributed.
    pub witness_pk: PublicKey,
    /// When the witness saw it. Deliberately **excluded** from the
    /// contradiction test — see [`VerifiedCosignature::contradicts`].
    pub observed_at_ms: u64,
}

impl WitnessCosignatureTBS {
    /// Check the constants a decoder cannot.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_COSIG)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        Ok(())
    }

    /// The exact bytes the witness signs.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }

    /// Build the `label` field for a cosignature.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the constant does not fit, which it does.
    pub fn label_bytes() -> Result<ShortBytes, KtError> {
        label_field(LABEL_COSIG)
    }
}

/// A `WitnessCosignature` (§7.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct WitnessCosignature {
    /// The signed statement.
    pub statement: WitnessCosignatureTBS,
    /// Ed25519 by `statement.witness_pk`.
    pub signature: Signature,
}

impl WitnessCosignature {
    /// Verify the signature under the `witness_pk` inside the statement.
    ///
    /// Note there is no key parameter: the key is in the signed bytes, and a
    /// caller who could supply a different one could re-attribute the statement.
    /// Whether that key is a witness the caller *trusts* is
    /// [`crate::witness::verify_threshold`]'s question, not this one's.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`] or
    /// [`KtError::BadSignature`].
    pub fn verify(&self) -> Result<(), KtError> {
        self.statement.validate()?;
        sig::verify(
            &self.statement.witness_pk,
            &self.statement.signing_bytes()?,
            &self.signature,
        )
    }

    /// Whether this cosignature is **about** the tree head `head` — the same
    /// `(log_id, epoch, tree_size, root_hash)`.
    ///
    /// §8.3 requires cosignatures over *exactly* this tuple. A cosignature that
    /// agrees on the epoch and disagrees on the root is not a weaker
    /// endorsement of the head; it is a different statement, and counting it
    /// would be counting a witness's contradiction as its support.
    #[must_use]
    pub fn covers(&self, head: &SignedTreeHead) -> bool {
        self.statement.log_id == head.sth.log_id
            && self.statement.epoch == head.sth.epoch
            && self.statement.tree_size == head.sth.tree_size
            && self.statement.root_hash == head.sth.root_hash
    }

    /// Verify the signature and **carry the proof in the type**.
    ///
    /// The only way to obtain a [`VerifiedCosignature`], and therefore the only
    /// way to reach [`VerifiedCosignature::contradicts`]. Takes `self` so the
    /// unverified value is consumed rather than left beside the verified one.
    ///
    /// # Errors
    ///
    /// Exactly [`WitnessCosignature::verify`]'s: [`KtError::WrongLabel`],
    /// [`KtError::UnsupportedVersion`] or [`KtError::BadSignature`].
    pub fn verified(self) -> Result<VerifiedCosignature, KtError> {
        self.verify()?;
        Ok(VerifiedCosignature { cosignature: self })
    }
}

/// A cosignature whose signature has been checked under the `witness_pk` inside
/// its own signed bytes — a statement the witness provably made.
///
/// It has no public constructor and no `From`.
/// [`WitnessCosignature::verified`] is the only thing that builds one, and it
/// builds one only after [`WitnessCosignature::verify`] has passed, so holding
/// this type *is* the proof that the check ran. That is the same shape as
/// [`crate::witness::AcceptedRoot`] and [`crate::auditor::AppendOnlyVerified`]
/// elsewhere in this crate: the rule is not a step a caller can forget, because
/// the token is the argument the next step needs.
///
/// §7.2's accountability claim is what forces it here. "Verify both, then
/// compare" as a documented precondition is a rule review has to notice; making
/// the compare take two verified values is a rule the compiler notices instead.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCosignature {
    cosignature: WitnessCosignature,
}

impl VerifiedCosignature {
    /// The statement whose signature checked out.
    #[must_use]
    pub const fn statement(&self) -> &WitnessCosignatureTBS {
        &self.cosignature.statement
    }

    /// The cosignature itself — to re-serve, to store, or to publish as the
    /// evidence half of a fault report.
    #[must_use]
    pub const fn as_cosignature(&self) -> &WitnessCosignature {
        &self.cosignature
    }

    /// Whether these two cosignatures are a contradiction on their face (§7.2).
    ///
    /// The test is exactly `(log_id, epoch)` equal and `(tree_size, root_hash)`
    /// differing. **`observed_at_ms` is deliberately excluded**: two
    /// cosignatures over the same root at different times are not a conflict,
    /// they are normal — a witness re-serving its history, or two clients
    /// fetching it at different moments.
    ///
    /// This returns `false` when the two are by different witnesses. Two
    /// witnesses disagreeing about an epoch is evidence against the **log**, not
    /// against either witness, and is [`KtError::Fork`]'s business; the
    /// non-repudiation §7.2 claims is specifically that *one* witness signed two
    /// contradictory statements, which is a fault of that witness and needs no
    /// third document to establish.
    ///
    /// Both sides are [`VerifiedCosignature`]s and neither can be built without
    /// a passing signature check, so "the witness signed this" is not something
    /// this predicate assumes about its arguments — it is something their type
    /// already proved.
    #[must_use]
    pub fn contradicts(&self, other: &Self) -> bool {
        let (this, that) = (self.statement(), other.statement());
        this.witness_pk == that.witness_pk
            && this.log_id == that.log_id
            && this.epoch == that.epoch
            && (this.tree_size != that.tree_size || this.root_hash != that.root_hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestLog;
    use f2z_codec::canonical::{Canonical as _, decode_canonical};

    #[test]
    fn a_cosignature_round_trips_and_verifies_from_its_own_bytes() {
        let log = TestLog::new();
        let head = log.head(4);
        let cosig = log.cosign(&head, 1, 1_700_000_000_000);
        assert_eq!(cosig.verify(), Ok(()));
        assert!(cosig.covers(&head));

        let bytes = cosig.encode_canonical().unwrap();
        let decoded = decode_canonical::<WitnessCosignature>(&bytes).unwrap();
        assert_eq!(decoded.value(), &cosig);
        assert_eq!(decoded.value().verify(), Ok(()));
    }

    #[test]
    fn a_cosignature_cannot_be_reattributed() {
        let log = TestLog::new();
        let head = log.head(4);
        let mut cosig = log.cosign(&head, 1, 1);
        cosig.statement.witness_pk = PublicKey::new([7u8; 32]);
        assert_eq!(
            cosig.verify(),
            Err(KtError::BadSignature),
            "witness_pk is inside the signed bytes",
        );
    }

    #[test]
    fn covers_is_exact_on_all_four_fields() {
        let log = TestLog::new();
        let head = log.head(4);
        let cosig = log.cosign(&head, 1, 1);

        let mut other = head.clone();
        other.sth.root_hash = Digest::new([1u8; 32]);
        assert!(!cosig.covers(&other));

        let mut other = head.clone();
        other.sth.tree_size = head.sth.tree_size.saturating_add(1);
        assert!(!cosig.covers(&other));

        let mut other = head.clone();
        other.sth.epoch = head.sth.epoch.saturating_add(1);
        assert!(!cosig.covers(&other));

        let mut other = head;
        other.sth.log_id = LogId::new([9u8; 32]);
        assert!(!cosig.covers(&other));
    }

    #[test]
    fn two_roots_for_one_epoch_by_one_witness_are_non_repudiable() {
        let log = TestLog::new();
        let head = log.head(4);
        let mut forked = head.clone();
        forked.sth.root_hash = Digest::new([0xaa; 32]);
        let forked = log.resign(forked);

        // Both verify, and saying so is not a separate assertion beside the
        // comparison any more: `verified()` is the only way to reach
        // `contradicts`, so the contradiction below cannot be established on
        // anything the witness did not sign.
        let a = log
            .cosign(&head, 1, 1_700_000_000_000)
            .verified()
            .expect("a genuine cosignature verifies");
        let b = log
            .cosign(&forked, 1, 1_700_000_100_000)
            .verified()
            .expect("a genuine cosignature verifies");
        assert!(a.contradicts(&b));
        assert!(b.contradicts(&a));
        // The contradiction needs no third document, only the two cosignatures
        // and the witness's public key — which is inside them.
        assert_eq!(a.statement().witness_pk, log.witness_pk(1));
    }

    #[test]
    fn an_unsigned_forgery_never_becomes_a_verified_cosignature() {
        let log = TestLog::new();
        let head = log.head(4);
        let genuine = log.cosign(&head, 1, 1_700_000_000_000);
        assert_eq!(genuine.verify(), Ok(()));

        // Anyone holding one genuine cosignature can author this: flip a byte
        // of the root and you have a second "statement" by that witness.
        let mut forged = genuine.clone();
        forged.statement.root_hash = Digest::new([0xcc; 32]);

        assert_eq!(
            forged.verified().err(),
            Some(KtError::BadSignature),
            "the forgery cannot acquire the proof `contradicts` requires",
        );
        // So the accusation is unreachable rather than merely discouraged:
        // `contradicts` exists only on `VerifiedCosignature`, the forgery can
        // never become one, and calling it on two `WitnessCosignature`s does
        // not compile.
        let genuine = genuine.verified().expect("the genuine one verifies");
        assert_eq!(genuine.statement().root_hash, head.sth.root_hash);
    }

    #[test]
    fn a_forged_second_statement_cannot_be_paired_with_a_genuine_one() {
        let log = TestLog::new();
        let head = log.head(4);
        let genuine = log
            .cosign(&head, 1, 1_700_000_000_000)
            .verified()
            .expect("a genuine cosignature verifies");

        // Every field a forger controls, one at a time — each would satisfy
        // `contradicts`'s field test, and none of them can be verified into a
        // value `contradicts` accepts.
        let mut wrong_root = genuine.as_cosignature().clone();
        wrong_root.statement.root_hash = Digest::new([0xcc; 32]);
        let mut wrong_size = genuine.as_cosignature().clone();
        wrong_size.statement.tree_size = head.sth.tree_size.saturating_add(1);

        for forgery in [wrong_root, wrong_size] {
            assert_eq!(
                forgery.verified().err(),
                Some(KtError::BadSignature),
                "an accusation may not rest on bytes the witness never signed",
            );
        }
    }

    #[test]
    fn the_same_root_at_two_times_is_not_a_contradiction() {
        let log = TestLog::new();
        let head = log.head(4);
        let a = log
            .cosign(&head, 1, 1_700_000_000_000)
            .verified()
            .expect("a genuine cosignature verifies");
        let b = log
            .cosign(&head, 1, 1_700_009_999_999)
            .verified()
            .expect("a genuine cosignature verifies");
        assert_ne!(
            a.statement().observed_at_ms,
            b.statement().observed_at_ms,
            "the two really were observed at different times",
        );
        assert!(
            !a.contradicts(&b),
            "observed_at_ms is excluded from the test on purpose",
        );
    }

    #[test]
    fn two_witnesses_disagreeing_is_not_one_witness_contradicting_itself() {
        let log = TestLog::new();
        let head = log.head(4);
        let mut forked = head.clone();
        forked.sth.root_hash = Digest::new([0xbb; 32]);
        let forked = log.resign(forked);

        let a = log
            .cosign(&head, 1, 1)
            .verified()
            .expect("a genuine cosignature verifies");
        let b = log
            .cosign(&forked, 2, 1)
            .verified()
            .expect("a genuine cosignature verifies");
        assert_ne!(
            a.statement().witness_pk,
            b.statement().witness_pk,
            "two different witnesses, both genuine",
        );
        assert!(!a.contradicts(&b), "that is evidence against the log");
    }
}
