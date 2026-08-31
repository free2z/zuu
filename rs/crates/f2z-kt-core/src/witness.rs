//! The threshold rule, fail-closed acceptance, and fault evidence — `KT.md`
//! §7.3, §7.5 and §8.3.
//!
//! # The threshold rule, and why the witness set is the caller's
//!
//! §8.3: a client accepts a `SignedTreeHead` only if it carries ≥ *t* valid
//! `WitnessCosignature`s **from distinct witnesses in its own configured
//! witness set**, over exactly this `(log_id, epoch, tree_size, root_hash)`.
//! Cosignatures from witnesses the client did not configure are ignored — not
//! weighed, not counted, not displayed as reassurance. **A witness list supplied
//! by the log is a list chosen by the party the witnesses exist to audit**, so
//! [`WitnessSet`] is always constructed by the caller and this crate ships no
//! default one.
//!
//! # Failing closed is the default and there is no other path
//!
//! [`verify_threshold`] returns an [`AcceptedRoot`] or it returns
//! [`KtError::ThresholdUnmet`]. There is no "accept anyway" flag and no partial
//! result carrying a count, because the owner decision on
//! [#311](https://github.com/free2z/zuu/issues/311) is that *"proceeding
//! silently would overclaim and must not be the default."* Which operations may
//! continue when the threshold is unmet is a product decision §8.3 tabulates —
//! an established conversation continues, resolving a **new** handle does not —
//! and it is made by the caller holding the `Err`, never by weakening this
//! function.
//!
//! # The bootstrap statement, which is the honest part
//!
//! At launch free2z operates the log and every witness, and witnesses free2z
//! operates are not independent witnesses. **Whatever *t* is configured, the
//! cryptographic value of meeting it is zero** until at least two witnesses are
//! run by parties outside free2z. [`WitnessSet::independent_count`] exists so a
//! UI can display the number §8.3 requires it to display — the count of
//! *independent* witnesses — rather than the number of configured ones, which
//! would be a reassuring number for a property the client does not have.

use f2z_codec::canonical::encode;
use f2z_codec::types::{Digest, PublicKey, ShortBytes, Signature};
use f2z_codec::vec::VecU24;
use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsDeserializeBytes,
    TlsSerializeBytes, TlsSize,
};

use crate::KT_VERSION;
use crate::cosign::WitnessCosignature;
use crate::error::KtError;
use crate::labels::LABEL_FAULT;
use crate::sig;
use crate::sth::SignedTreeHead;
use crate::types::{LogId, check_label, label_field};

/// One witness in a client's configured set, and whether the client considers
/// it **independent**.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfiguredWitness {
    /// The witness's Ed25519 public key.
    pub public_key: PublicKey,
    /// Whether this witness is operated by a party outside the party that
    /// operates the log.
    ///
    /// A social fact, not a cryptographic one
    /// (`THREAT-MODEL.md` §3.9), so it is the caller's assertion and this crate
    /// never infers it. It is carried here only so §8.3's display requirement
    /// has something to read.
    pub independent: bool,
}

impl ConfiguredWitness {
    /// A witness the caller operates itself, or otherwise does not count as
    /// independent.
    #[must_use]
    pub const fn dependent(public_key: PublicKey) -> Self {
        Self {
            public_key,
            independent: false,
        }
    }

    /// A witness the caller asserts is run by an outside party.
    #[must_use]
    pub const fn independent(public_key: PublicKey) -> Self {
        Self {
            public_key,
            independent: true,
        }
    }
}

/// A client's own witness policy: who it will count, and how many it needs.
///
/// `KT.md` §12 leaves the default *t* and the shipped witness list open
/// ([§13-Q](https://github.com/free2z/zuu/issues/311)). This crate fixes the
/// **rule** and the **failure behaviour** and ships no numbers, which is why
/// there is no `Default` implementation: a default witness set would be this
/// crate inventing the answer §12 declines to invent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WitnessSet {
    witnesses: Vec<ConfiguredWitness>,
    threshold: usize,
}

impl WitnessSet {
    /// Configure a witness set and a threshold *t*.
    ///
    /// # Errors
    ///
    /// [`KtError::ThresholdUnmet`] if `threshold` is 0, or is larger than the
    /// number of distinct witnesses configured. A threshold of 0 accepts any
    /// root from nobody, which is the fail-open behaviour §8.3 forbids; a
    /// threshold larger than the set can never be met, which is a
    /// misconfiguration that would otherwise present as a permanently broken
    /// directory. Duplicate keys are refused for the same reason: §8.3 counts
    /// **distinct** witnesses, and a set listing one key twice would claim a
    /// redundancy it does not have.
    pub fn new(witnesses: Vec<ConfiguredWitness>, threshold: usize) -> Result<Self, KtError> {
        if threshold == 0 || threshold > witnesses.len() {
            return Err(KtError::ThresholdUnmet);
        }
        for (index, witness) in witnesses.iter().enumerate() {
            for other in witnesses.iter().skip(index.saturating_add(1)) {
                if witness.public_key == other.public_key {
                    return Err(KtError::ThresholdUnmet);
                }
            }
        }
        Ok(Self {
            witnesses,
            threshold,
        })
    }

    /// The threshold *t*.
    #[must_use]
    pub const fn threshold(&self) -> usize {
        self.threshold
    }

    /// Every configured witness.
    #[must_use]
    pub fn witnesses(&self) -> &[ConfiguredWitness] {
        &self.witnesses
    }

    /// How many configured witnesses the caller has asserted are independent.
    ///
    /// **§8.3 requires the UI to display this number and not
    /// [`WitnessSet::len`]**, and to state plainly when it is zero. A client
    /// that displays "3 of 3 witnesses" while this returns 0 is displaying a
    /// reassuring number for a property it does not have, which is worse than
    /// displaying nothing.
    #[must_use]
    pub fn independent_count(&self) -> usize {
        self.witnesses
            .iter()
            .filter(|witness| witness.independent)
            .count()
    }

    /// How many witnesses are configured.
    #[must_use]
    pub fn len(&self) -> usize {
        self.witnesses.len()
    }

    /// Whether the set is empty — unreachable through [`WitnessSet::new`],
    /// which refuses a threshold of 0.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.witnesses.is_empty()
    }

    /// Whether this key is one the caller configured.
    #[must_use]
    pub fn contains(&self, public_key: &PublicKey) -> bool {
        self.witnesses
            .iter()
            .any(|witness| witness.public_key == *public_key)
    }
}

/// A root that met the threshold: the only value in this crate that says "this
/// `(log_id, epoch, tree_size, root_hash)` is safe to verify a proof against."
///
/// It has no public constructor. [`verify_threshold`] is the only thing that
/// builds one, and every operation that must not proceed on an unwitnessed root
/// — [`crate::verify::verify_lookup`], [`crate::verify::verify_key_history`],
/// [`crate::sth::LogView::accept_log_key_transition`] — takes one by reference.
/// The threshold rule is therefore not a step a caller can forget; it is the
/// only way to obtain the argument the next step needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedRoot {
    log_id: LogId,
    epoch: u64,
    tree_size: u64,
    root_hash: Digest,
    vrf_public_key: PublicKey,
    cosignature_count: usize,
    independent_cosignature_count: usize,
}

impl AcceptedRoot {
    /// The log this root belongs to.
    #[must_use]
    pub const fn log_id(&self) -> &LogId {
        &self.log_id
    }

    /// The epoch.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The tree size at this epoch.
    #[must_use]
    pub const fn tree_size(&self) -> u64 {
        self.tree_size
    }

    /// The `akd` root hash to verify proofs against.
    #[must_use]
    pub const fn root_hash(&self) -> &Digest {
        &self.root_hash
    }

    /// The VRF key labels in this tree are derived under, taken from the
    /// **verified tree head** and never from a proof or a log assertion
    /// (§8.1 step 5).
    #[must_use]
    pub const fn vrf_public_key(&self) -> &PublicKey {
        &self.vrf_public_key
    }

    /// How many distinct configured witnesses cosigned this exact root.
    #[must_use]
    pub const fn cosignature_count(&self) -> usize {
        self.cosignature_count
    }

    /// How many of those the caller asserts are independent (§8.3).
    ///
    /// This, not [`AcceptedRoot::cosignature_count`], is what a UI displays.
    #[must_use]
    pub const fn independent_cosignature_count(&self) -> usize {
        self.independent_cosignature_count
    }
}

/// Apply §8.3's threshold rule to a tree head and the cosignatures served with
/// it.
///
/// The head must **already** have been accepted into a [`LogView`] — §6.3's
/// monotonicity and chain rules are a client's own responsibility and are not
/// re-run here — and this function adds the second, independent question: did
/// enough parties the caller trusts say they saw this same root?
///
/// Counting is by **distinct `witness_pk` in the configured set**. A duplicate
/// cosignature from one witness counts once; a cosignature from a witness the
/// caller did not configure is ignored entirely, including when it verifies.
///
/// # Errors
///
/// - [`KtError::WrongLog`] if the head is not for `log_id`.
/// - [`KtError::ThresholdUnmet`] if fewer than *t* distinct configured
///   witnesses produced a valid cosignature over exactly this root. **This is
///   the fail-closed path and it carries no partial result.**
///
/// [`LogView`]: crate::sth::LogView
pub fn verify_threshold(
    head: &SignedTreeHead,
    cosignatures: &[WitnessCosignature],
    set: &WitnessSet,
    log_id: &LogId,
) -> Result<AcceptedRoot, KtError> {
    if head.sth.log_id != *log_id {
        return Err(KtError::WrongLog);
    }
    head.sth.validate()?;

    let mut counted: Vec<PublicKey> = Vec::new();
    let mut independent = 0usize;
    for cosignature in cosignatures {
        // Exactly this `(log_id, epoch, tree_size, root_hash)`, first: a
        // signature check on a statement about a different root is wasted work
        // and, worse, invites a caller to read "it verified" as "it agreed".
        if !cosignature.covers(head) {
            continue;
        }
        let Some(configured) = set
            .witnesses()
            .iter()
            .find(|witness| witness.public_key == cosignature.statement.witness_pk)
        else {
            // Not weighed, not counted, not displayed as reassurance.
            continue;
        };
        if counted.contains(&configured.public_key) {
            continue;
        }
        if cosignature.verify().is_err() {
            continue;
        }
        counted.push(configured.public_key);
        if configured.independent {
            independent = independent.saturating_add(1);
        }
    }

    if counted.len() < set.threshold() {
        return Err(KtError::ThresholdUnmet);
    }

    Ok(AcceptedRoot {
        log_id: head.sth.log_id,
        epoch: head.sth.epoch,
        tree_size: head.sth.tree_size,
        root_hash: head.sth.root_hash,
        vrf_public_key: head.sth.vrf_public_key,
        cosignature_count: counted.len(),
        independent_cosignature_count: independent,
    })
}

/// What a witness found (§7.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum FaultKind {
    /// Epoch or root moved backwards.
    Rollback,
    /// Same epoch, different root or size.
    Fork,
    /// `prev_sth_hash` does not connect.
    ChainBreak,
    /// A tree-head or key-transition signature is invalid.
    BadSignature,
    /// `audit_verify` rejected.
    AppendOnlyFailure,
    /// `vrf_public_key` changed within a `log_id`.
    VrfKeyChange,
    /// A receipt's `merge_by_ms` passed unmet.
    MergeDelayExceeded,
}

impl FaultKind {
    /// Every kind, in wire order.
    pub const ALL: [Self; 7] = [
        Self::Rollback,
        Self::Fork,
        Self::ChainBreak,
        Self::BadSignature,
        Self::AppendOnlyFailure,
        Self::VrfKeyChange,
        Self::MergeDelayExceeded,
    ];

    /// The wire value.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Rollback => 1,
            Self::Fork => 2,
            Self::ChainBreak => 3,
            Self::BadSignature => 4,
            Self::AppendOnlyFailure => 5,
            Self::VrfKeyChange => 6,
            Self::MergeDelayExceeded => 7,
        }
    }

    /// The kind this build knows by that value.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] for anything else.
    pub const fn from_code(code: u8) -> Result<Self, KtError> {
        Ok(match code {
            1 => Self::Rollback,
            2 => Self::Fork,
            3 => Self::ChainBreak,
            4 => Self::BadSignature,
            5 => Self::AppendOnlyFailure,
            6 => Self::VrfKeyChange,
            7 => Self::MergeDelayExceeded,
            _ => return Err(KtError::Malformed),
        })
    }

    /// Whether a third party can check this report from its bytes alone (§7.3).
    ///
    /// **Six of the seven are.** The evidence is two or more tree heads signed
    /// by the log's own key, or a log-signed receipt: anyone with the log's
    /// public key checks it in milliseconds and needs to trust nobody.
    ///
    /// [`FaultKind::AppendOnlyFailure`] is **not**. The claim is "this proof does
    /// not verify," and a third party must re-run `audit_verify` on the bytes in
    /// `detail` to see it. A witness could report this falsely, and a log could
    /// serve a bad proof to one witness only. It is a **prompt to check**, not a
    /// verdict — and §9.4 explains why it cannot be made self-authenticating:
    /// protobuf is not canonical, so no part of this specification hashes or
    /// compares a proof.
    #[must_use]
    pub const fn is_self_authenticating(self) -> bool {
        !matches!(self, Self::AppendOnlyFailure)
    }
}

impl Size for FaultKind {
    fn tls_serialized_len(&self) -> usize {
        1
    }
}

impl SerializeBytes for FaultKind {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        Ok(vec![self.code()])
    }
}

impl DeserializeBytes for FaultKind {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (code, rest) = u8::tls_deserialize_bytes(bytes)?;
        let kind = Self::from_code(code)
            .map_err(|_| TlsError::DecodingError(format!("FaultKind {code} is not in §7.3")))?;
        Ok((kind, rest))
    }
}

/// The `FaultReportTBS` of §7.3.
///
/// The witness's own signature on a report binds it to the accusation, which is
/// the point: a witness that cries wolf is on the record too.
///
/// Where fault reports are published, and who is expected to act on one, is not
/// specified — it is a social and operational question (§12). What the format
/// guarantees is that the evidence is **portable**.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct FaultReportTBS {
    /// Exactly `"free2z/kt/v1/fault"`.
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The log accused.
    pub log_id: LogId,
    /// What was found.
    pub kind: FaultKind,
    /// The witness making the accusation.
    pub witness_pk: PublicKey,
    /// The tree heads the witness holds, in order.
    pub a: VecU24<SignedTreeHead>,
    /// The conflicting ones; empty where not applicable.
    pub b: VecU24<SignedTreeHead>,
    /// Proof bytes, or a `SubmissionReceipt`.
    pub detail: f2z_codec::types::Payload,
    /// When the witness observed the fault.
    pub observed_at_ms: u64,
}

impl FaultReportTBS {
    /// Check the constants a decoder cannot.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_FAULT)?;
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

    /// Build the `label` field for a fault report.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the constant does not fit, which it does.
    pub fn label_bytes() -> Result<ShortBytes, KtError> {
        label_field(LABEL_FAULT)
    }
}

/// A `FaultReport` (§7.3).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct FaultReport {
    /// The signed accusation.
    pub report: FaultReportTBS,
    /// Ed25519 by `report.witness_pk`.
    pub signature: Signature,
}

impl FaultReport {
    /// Verify the witness's signature over its own accusation.
    ///
    /// This says the named witness made the claim. Whether the claim is *true*
    /// depends on [`FaultKind::is_self_authenticating`]: for six of the seven
    /// kinds the enclosed tree heads settle it under the log's own key, and for
    /// `append_only_failure` a third party must re-run the auditor.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`] or
    /// [`KtError::BadSignature`].
    pub fn verify(&self) -> Result<(), KtError> {
        self.report.validate()?;
        sig::verify(
            &self.report.witness_pk,
            &self.report.signing_bytes()?,
            &self.signature,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestLog;

    fn set_of(log: &TestLog, seeds: &[u8], threshold: usize) -> WitnessSet {
        let witnesses = seeds
            .iter()
            .map(|seed| ConfiguredWitness::dependent(log.witness_pk(*seed)))
            .collect();
        WitnessSet::new(witnesses, threshold).expect("a well-formed witness policy")
    }

    #[test]
    fn a_threshold_of_zero_or_more_than_the_set_is_refused() {
        let log = TestLog::new();
        let one = vec![ConfiguredWitness::dependent(log.witness_pk(1))];
        assert_eq!(
            WitnessSet::new(one.clone(), 0),
            Err(KtError::ThresholdUnmet)
        );
        assert_eq!(
            WitnessSet::new(one.clone(), 2),
            Err(KtError::ThresholdUnmet)
        );
        assert!(WitnessSet::new(one, 1).is_ok());

        let duplicated = vec![
            ConfiguredWitness::dependent(log.witness_pk(1)),
            ConfiguredWitness::dependent(log.witness_pk(1)),
        ];
        assert_eq!(
            WitnessSet::new(duplicated, 2),
            Err(KtError::ThresholdUnmet),
            "§8.3 counts distinct witnesses",
        );
    }

    #[test]
    fn the_threshold_is_met_by_distinct_configured_witnesses() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = set_of(&log, &[1, 2, 3], 2);
        let cosigs = [log.cosign(&head, 1, 10), log.cosign(&head, 2, 11)];
        let root = verify_threshold(&head, &cosigs, &set, log.log_id()).unwrap();
        assert_eq!(root.epoch(), 7);
        assert_eq!(root.cosignature_count(), 2);
        assert_eq!(root.root_hash(), &head.sth.root_hash);
        assert_eq!(root.vrf_public_key(), &head.sth.vrf_public_key);
    }

    #[test]
    fn one_witness_cosigning_twice_counts_once() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = set_of(&log, &[1, 2], 2);
        let cosigs = [log.cosign(&head, 1, 10), log.cosign(&head, 1, 20)];
        assert_eq!(
            verify_threshold(&head, &cosigs, &set, log.log_id()),
            Err(KtError::ThresholdUnmet),
        );
    }

    #[test]
    fn a_witness_the_client_did_not_configure_is_ignored_not_weighed() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = set_of(&log, &[1], 1);
        // Valid cosignatures, by keys the client never chose. §8.3: a witness
        // list supplied by the log is a list chosen by the party the witnesses
        // exist to audit.
        let cosigs = [
            log.cosign(&head, 50, 10),
            log.cosign(&head, 51, 11),
            log.cosign(&head, 52, 12),
        ];
        for cosig in &cosigs {
            assert_eq!(cosig.verify(), Ok(()));
        }
        assert_eq!(
            verify_threshold(&head, &cosigs, &set, log.log_id()),
            Err(KtError::ThresholdUnmet),
        );
    }

    #[test]
    fn a_cosignature_over_another_root_does_not_count_for_this_one() {
        let log = TestLog::new();
        let head = log.head(7);
        let other = log.head(8);
        let set = set_of(&log, &[1, 2], 1);
        let cosigs = [log.cosign(&other, 1, 10), log.cosign(&other, 2, 11)];
        assert_eq!(
            verify_threshold(&head, &cosigs, &set, log.log_id()),
            Err(KtError::ThresholdUnmet),
        );
    }

    #[test]
    fn a_forged_cosignature_from_a_configured_key_does_not_count() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = set_of(&log, &[1, 2], 2);
        let good = log.cosign(&head, 1, 10);
        let mut forged = log.cosign(&head, 2, 11);
        forged.signature = f2z_codec::types::Signature::new([0u8; 64]);
        assert_eq!(
            verify_threshold(&head, &[good, forged], &set, log.log_id()),
            Err(KtError::ThresholdUnmet),
        );
    }

    #[test]
    fn no_cosignatures_at_all_fails_closed() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = set_of(&log, &[1], 1);
        assert_eq!(
            verify_threshold(&head, &[], &set, log.log_id()),
            Err(KtError::ThresholdUnmet),
        );
    }

    #[test]
    fn independence_is_the_callers_assertion_and_is_reported_separately() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = WitnessSet::new(
            vec![
                ConfiguredWitness::dependent(log.witness_pk(1)),
                ConfiguredWitness::independent(log.witness_pk(2)),
            ],
            2,
        )
        .unwrap();
        assert_eq!(set.independent_count(), 1);
        let cosigs = [log.cosign(&head, 1, 1), log.cosign(&head, 2, 2)];
        let root = verify_threshold(&head, &cosigs, &set, log.log_id()).unwrap();
        assert_eq!(root.cosignature_count(), 2);
        assert_eq!(
            root.independent_cosignature_count(),
            1,
            "§8.3: the UI displays this number, not the configured count",
        );
    }

    #[test]
    fn a_head_from_another_log_is_refused_before_anything_is_counted() {
        let log = TestLog::new();
        let head = log.head(7);
        let set = set_of(&log, &[1], 1);
        assert_eq!(
            verify_threshold(
                &head,
                &[log.cosign(&head, 1, 1)],
                &set,
                &LogId::new([9u8; 32])
            ),
            Err(KtError::WrongLog),
        );
    }

    #[test]
    fn append_only_failure_is_the_only_kind_that_is_not_self_authenticating() {
        for kind in FaultKind::ALL {
            assert_eq!(
                kind.is_self_authenticating(),
                kind != FaultKind::AppendOnlyFailure,
            );
            assert_eq!(FaultKind::from_code(kind.code()), Ok(kind));
        }
        assert_eq!(FaultKind::from_code(0), Err(KtError::Malformed));
        assert_eq!(FaultKind::from_code(8), Err(KtError::Malformed));
    }
}
