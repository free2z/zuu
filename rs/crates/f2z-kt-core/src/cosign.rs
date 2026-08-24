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
//!    witness** — see [`WitnessCosignature::contradicts`]. No third document is
//!    needed to establish the contradiction. That is what makes a witness
//!    accountable rather than merely helpful.
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
    /// contradiction test — see [`WitnessCosignature::contradicts`].
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
    #[must_use]
    pub fn contradicts(&self, other: &Self) -> bool {
        self.statement.witness_pk == other.statement.witness_pk
            && self.statement.log_id == other.statement.log_id
            && self.statement.epoch == other.statement.epoch
            && (self.statement.tree_size != other.statement.tree_size
                || self.statement.root_hash != other.statement.root_hash)
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

        let a = log.cosign(&head, 1, 1_700_000_000_000);
        let b = log.cosign(&forked, 1, 1_700_000_100_000);
        assert!(a.contradicts(&b));
        assert!(b.contradicts(&a));
        // Both verify. That is the point: the contradiction needs no third
        // document, only the two cosignatures and the witness's public key.
        assert_eq!(a.verify(), Ok(()));
        assert_eq!(b.verify(), Ok(()));
    }

    #[test]
    fn the_same_root_at_two_times_is_not_a_contradiction() {
        let log = TestLog::new();
        let head = log.head(4);
        let a = log.cosign(&head, 1, 1_700_000_000_000);
        let b = log.cosign(&head, 1, 1_700_009_999_999);
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

        let a = log.cosign(&head, 1, 1);
        let b = log.cosign(&forked, 2, 1);
        assert!(!a.contradicts(&b), "that is evidence against the log");
    }
}
