//! `SubmissionReceipt` — `KT.md` §5.3, the RFC 6962 SCT analogue.
//!
//! The log MUST return a receipt on every accepted submission and MUST NOT
//! return one for a submission it rejects. A client MUST store the receipt until
//! it has seen the entry included under a cosigned tree head.
//!
//! # What the receipt proves
//!
//! A `SubmissionReceipt` with `merge_by_ms` in the past, together with the
//! cosigned `SignedTreeHead` chain covering that instant and a non-membership
//! proof for `(handle, entry_version)` at the latest of those roots, is a
//! self-contained, self-authenticating demonstration that the log broke a
//! **signed promise with a deadline**. It needs no trust in the complainant.
//!
//! # What it does not prove, stated because a receipt looks stronger than it is
//!
//! - It does not prove the log *will* publish. It converts a silent failure into
//!   a provable one. That is the whole of its value.
//! - It does not prove anyone else saw the promise. A log can hand a receipt to
//!   one user and to nobody else; the receipt is evidence only once it is
//!   published, which the victim must actually do.
//! - It does not defend against a log that includes the entry in a **fork**. The
//!   entry appears, the receipt is honoured, and the root it appears under is one
//!   only this user is shown.
//! - A log that refuses to issue receipts at all is refusing service — visible,
//!   and not something a receipt can fix.

use f2z_codec::canonical::encode;
use f2z_codec::types::{Digest, PublicKey, ShortBytes, Signature};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::KT_VERSION;
use crate::error::KtError;
use crate::labels::LABEL_RECEIPT;
use crate::sig;
use crate::types::{Handle, LogId, check_label, label_field};

/// The `SubmissionReceiptTBS` of §5.3.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SubmissionReceiptTBS {
    /// Exactly `"free2z/kt/v1/receipt"`.
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The log making the promise.
    pub log_id: LogId,
    /// The handle submitted for.
    pub handle: Handle,
    /// The version submitted.
    pub entry_version: u32,
    /// `AkdValue` — `H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` (§3.3).
    pub entry_hash: Digest,
    /// When the log accepted the submission.
    pub received_at_ms: u64,
    /// `received_at_ms + max_merge_delay_seconds * 1000` (§5.2).
    pub merge_by_ms: u64,
}

impl SubmissionReceiptTBS {
    /// Check the constants and charsets a decoder cannot.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`] or
    /// [`KtError::BadHandle`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_RECEIPT)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        self.handle.validate()
    }

    /// The exact bytes the log signs.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }

    /// Build the `label` field for a receipt.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the constant does not fit, which it does.
    pub fn label_bytes() -> Result<ShortBytes, KtError> {
        label_field(LABEL_RECEIPT)
    }
}

/// A `SubmissionReceipt` (§5.3).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SubmissionReceipt {
    /// The signed promise.
    pub receipt: SubmissionReceiptTBS,
    /// Ed25519 by the log signing key.
    pub signature: Signature,
}

impl SubmissionReceipt {
    /// Verify the log's signature and the constants.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`],
    /// [`KtError::BadHandle`], [`KtError::WrongLog`] or
    /// [`KtError::BadSignature`].
    pub fn verify(&self, log_id: &LogId, log_pk: &PublicKey) -> Result<(), KtError> {
        self.receipt.validate()?;
        if self.receipt.log_id != *log_id {
            return Err(KtError::WrongLog);
        }
        sig::verify(log_pk, &self.receipt.signing_bytes()?, &self.signature)
    }

    /// Whether the promised merge deadline has passed as of `now_ms`.
    ///
    /// This says the deadline is **past**, not that it was **missed**: missing
    /// it also requires a non-membership proof for `(handle, entry_version)` at
    /// a root covering that instant, which is §8.1's business and needs the
    /// network this crate does not have.
    #[must_use]
    pub const fn deadline_passed(&self, now_ms: u64) -> bool {
        now_ms > self.receipt.merge_by_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestLog;
    use f2z_codec::canonical::{Canonical as _, decode_canonical};

    #[test]
    fn a_receipt_verifies_round_trips_and_reports_its_deadline() {
        let log = TestLog::new();
        let receipt = log.receipt(Digest::new([4u8; 32]), 3, 1_000, 3_601_000);
        assert_eq!(receipt.verify(log.log_id(), log.log_pk()), Ok(()));
        assert!(!receipt.deadline_passed(3_601_000));
        assert!(receipt.deadline_passed(3_601_001));

        let bytes = receipt.encode_canonical().unwrap();
        assert_eq!(
            decode_canonical::<SubmissionReceipt>(&bytes)
                .unwrap()
                .value(),
            &receipt
        );
    }

    #[test]
    fn a_tree_head_cannot_be_accepted_as_a_receipt() {
        // The other half of §6.2's argument: one key signs both, so both check
        // their own label first.
        let log = TestLog::new();
        let mut receipt = log.receipt(Digest::new([4u8; 32]), 3, 1_000, 3_601_000);
        receipt.receipt.label = ShortBytes::new(crate::labels::LABEL_STH.to_vec()).unwrap();
        assert_eq!(
            receipt.verify(log.log_id(), log.log_pk()),
            Err(KtError::WrongLabel)
        );
    }
}
