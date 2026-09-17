//! `POST /kt/v1/submit` — carrying a submission somebody else signed, and
//! refusing a receipt that does not promise what was asked.
//!
//! # This does not make the client a submitter
//!
//! [`crate::client`]'s note still holds: a directory client does not *build*
//! submissions, because building one needs the seed-derived `DirectoryAuthKey`
//! and `IdentitySigningKey`, and those belong to the application that owns the
//! wallet seed (`f2z_msg_identity::AccountKeys::sign_directory_submission`).
//! What lives here is the half that needs no key: moving the signed bytes and
//! checking the log's answer (ADR 0017).
//!
//! # What a receipt must say before it is kept
//!
//! `KT.md` §5.3 makes a receipt the client's evidence that the log promised to
//! merge an entry by a deadline. Evidence of the wrong promise is worse than
//! none, so [`submit`] refuses a receipt that verifies under the pinned log key
//! but names another handle, another version, or another entry hash — each is a
//! log answering a question that was not asked.

use f2z_codec::canonical::decode_canonical;
use f2z_codec::types::{Digest, PublicKey};
use f2z_kt_core::KtError;
use f2z_kt_core::receipt::SubmissionReceipt;
use f2z_kt_core::types::{Handle, LogId};

use crate::error::{ClientError, Result};

/// `POST /kt/v1/submit`.
pub const PATH_SUBMIT: &str = "/kt/v1/submit";

/// How a submission reaches a log.
///
/// Separate from [`crate::Transport`] on purpose: that trait is the read side
/// every client needs, and only the seed-holding application ever submits.
pub trait SubmitTransport {
    /// `POST /kt/v1/submit` with a canonical `SubmissionEnvelope`; the raw
    /// response body.
    ///
    /// # Errors
    ///
    /// [`ClientError::Unreachable`] if the log did not answer,
    /// [`ClientError::Refused`] if it answered with a §9.5 error body.
    fn submit(&self, envelope: &[u8]) -> Result<Vec<u8>>;
}

/// What the receipt has to promise.
#[derive(Clone, Copy, Debug)]
pub struct Expected<'a> {
    /// The log the submission went to.
    pub log_id: &'a LogId,
    /// The log signing key this client pins for that log.
    pub log_pk: &'a PublicKey,
    /// The handle submitted for.
    pub handle: &'a Handle,
    /// The version submitted.
    pub entry_version: u32,
    /// `H("free2z/kt/v1/value", tls_codec(entry))`.
    pub entry_digest: &'a Digest,
}

/// Submit, then verify the receipt against the pinned log key and against what
/// was submitted.
///
/// # Errors
///
/// The transport's error; [`ClientError::Protocol`] if the receipt does not
/// decode canonically, does not verify ([`KtError::BadSignature`],
/// [`KtError::WrongLog`]) or promises something other than what was submitted
/// ([`KtError::ValueMismatch`]).
pub fn submit<T: SubmitTransport + ?Sized>(
    transport: &T,
    envelope: &[u8],
    expected: &Expected<'_>,
) -> Result<SubmissionReceipt> {
    let bytes = transport.submit(envelope)?;
    let receipt = decode_canonical::<SubmissionReceipt>(&bytes)?.into_value();
    receipt.verify(expected.log_id, expected.log_pk)?;
    let promised = &receipt.receipt;
    if promised.handle != *expected.handle
        || promised.entry_version != expected.entry_version
        || promised.entry_hash != *expected.entry_digest
    {
        return Err(ClientError::Protocol(KtError::ValueMismatch));
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use f2z_authority::SigningKey;
    use f2z_codec::Canonical as _;
    use f2z_kt_core::receipt::SubmissionReceiptTBS;

    use super::*;

    struct Canned(Vec<u8>);

    impl SubmitTransport for Canned {
        fn submit(&self, _envelope: &[u8]) -> Result<Vec<u8>> {
            Ok(self.0.clone())
        }
    }

    /// A log key, and the log id and public key a client would pin for it.
    struct TestLog {
        key: SigningKey,
        log_id: LogId,
        log_pk: PublicKey,
    }

    impl TestLog {
        fn new() -> Self {
            let key = SigningKey::from_seed(&[0x31; 32]);
            let log_pk = key.public_key();
            Self {
                log_id: f2z_kt_core::labels::log_id(&log_pk),
                log_pk,
                key,
            }
        }

        const fn log_id(&self) -> &LogId {
            &self.log_id
        }

        const fn log_pk(&self) -> &PublicKey {
            &self.log_pk
        }

        fn receipt(&self, entry_hash: Digest, entry_version: u32) -> SubmissionReceipt {
            let receipt = SubmissionReceiptTBS {
                label: SubmissionReceiptTBS::label_bytes().unwrap(),
                kt_version: f2z_kt_core::KT_VERSION,
                log_id: self.log_id,
                handle: Handle::new(b"alice".to_vec()).unwrap(),
                entry_version,
                entry_hash,
                received_at_ms: 1_000,
                merge_by_ms: 3_601_000,
            };
            let signature = self.key.sign(&receipt.signing_bytes().unwrap());
            SubmissionReceipt { receipt, signature }
        }
    }

    fn fixture() -> (TestLog, Handle, Digest) {
        (
            TestLog::new(),
            Handle::new(b"alice".to_vec()).unwrap(),
            Digest::new([4u8; 32]),
        )
    }

    fn receipt_bytes(log: &TestLog, digest: Digest, version: u32) -> Vec<u8> {
        log.receipt(digest, version).encode_canonical().unwrap()
    }

    #[test]
    fn a_receipt_for_what_was_submitted_is_kept() {
        let (log, handle, digest) = fixture();
        let transport = Canned(receipt_bytes(&log, digest, 3));
        let receipt = submit(
            &transport,
            b"envelope",
            &Expected {
                log_id: log.log_id(),
                log_pk: log.log_pk(),
                handle: &handle,
                entry_version: 3,
                entry_digest: &digest,
            },
        )
        .unwrap();
        assert_eq!(receipt.receipt.merge_by_ms, 3_601_000);
    }

    #[test]
    fn a_receipt_under_another_key_is_refused() {
        let (log, handle, digest) = fixture();
        let transport = Canned(receipt_bytes(&log, digest, 3));
        let stranger = PublicKey::new([0x77; 32]);
        assert!(matches!(
            submit(
                &transport,
                b"envelope",
                &Expected {
                    log_id: log.log_id(),
                    log_pk: &stranger,
                    handle: &handle,
                    entry_version: 3,
                    entry_digest: &digest,
                },
            ),
            Err(ClientError::Protocol(_))
        ));
    }

    #[test]
    fn a_receipt_promising_another_entry_or_version_is_refused() {
        let (log, handle, digest) = fixture();
        let other = Digest::new([5u8; 32]);
        for (bytes, version, entry) in [
            (receipt_bytes(&log, other, 3), 3, digest),
            (receipt_bytes(&log, digest, 2), 3, digest),
        ] {
            assert_eq!(
                submit(
                    &Canned(bytes),
                    b"envelope",
                    &Expected {
                        log_id: log.log_id(),
                        log_pk: log.log_pk(),
                        handle: &handle,
                        entry_version: version,
                        entry_digest: &entry,
                    },
                )
                .unwrap_err()
                .to_string(),
                ClientError::Protocol(KtError::ValueMismatch).to_string()
            );
        }
    }

    #[test]
    fn a_trailing_byte_is_not_a_receipt() {
        let (log, handle, digest) = fixture();
        let mut bytes = receipt_bytes(&log, digest, 3);
        bytes.push(0);
        assert!(
            submit(
                &Canned(bytes),
                b"envelope",
                &Expected {
                    log_id: log.log_id(),
                    log_pk: log.log_pk(),
                    handle: &handle,
                    entry_version: 3,
                    entry_digest: &digest,
                },
            )
            .is_err()
        );
    }
}
