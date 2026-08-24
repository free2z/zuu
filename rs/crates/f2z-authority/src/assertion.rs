//! The two signed structures: what an authority says, and what the identity
//! key it names says back.
//!
//! **Experimental proposal, not `KT.md` v1 wire format.** `KT.md` leaves
//! first-entry authorization unresolved in #594 and defines none of these
//! structures or no-authority semantics. The presentation below and the byte
//! vectors in this module pin this crate's candidate layout for review only.
//!
//! ```text
//! struct {
//!     opaque label<0..255>;      /* exactly "free2z/kt/v1/handle-assertion" */
//!     opaque authority_id[32];   /* H("free2z/kt/v1/authority-id", authority_pk) */
//!     opaque log_id[32];
//!     opaque handle<1..30>;
//!     opaque handle_id[32];      /* H("free2z/kt/v1/handle-id", handle)          */
//!     opaque identity_pk[32];    /* ISK.public — the key this vouches for        */
//!     uint8  intent;             /* bind(1), reset(2)                            */
//!     uint32 account_epoch;
//!     uint64 issued_ms;
//!     uint64 expires_ms;
//!     opaque nonce[16];
//! } HandleAssertionTBS;
//!
//! struct {
//!     HandleAssertionTBS assertion;
//!     opaque             signature[64];   /* Ed25519 by authority_id's key */
//! } HandleAssertion;
//!
//! struct {
//!     opaque label<0..255>;      /* exactly "free2z/kt/v1/assertion-binding" */
//!     opaque log_id[32];
//!     opaque handle<1..30>;
//!     opaque identity_pk[32];
//!     opaque assertion_digest[32];  /* H(".../assertion-digest", tls_codec(HandleAssertion));
//!                                      all-zero when this entry carries none */
//!     opaque entry_digest[32];      /* the submission's AkdValue, KT.md §3.3 */
//! } AssertionBindingTBS;
//! ```
//!
//! # Why there are two, and not one
//!
//! An assertion is a **bearer** document: it is bytes an authority signed,
//! served over a network, sitting in a log's request queue and in whatever
//! debugging archive the operator kept. Anyone who obtains a copy holds
//! everything the authority said. If holding it were enough to submit under the
//! handle it names, then intercepting one — from a TLS-terminating proxy, from
//! a log's access log, from a stolen backup — would be a handle takeover, and
//! the authority would have no way to tell the thief from the subject.
//!
//! [`AssertionBindingTBS`] closes that. It is signed by the **identity private
//! key the assertion is about**, and it commits to the exact submission the
//! assertion is being presented with. A thief holding the assertion cannot
//! produce it, because producing it needs the key the assertion vouches *for* —
//! which is the key the thief was trying to replace. The stolen assertion is
//! worthless.
//!
//! This proposal requires this pairing. This crate makes it structural: there is no
//! function here or in [`crate::authority`] that checks an authority's
//! signature without also checking the binding, so a caller cannot arrive at a
//! verified assertion by a route that skipped it.
//!
//! Including `entry_digest` rather than only the assertion is what stops the
//! *subject's own* binding from being reusable: a binding signed for one
//! submission does not authorize a second, so a log that saw one cannot resubmit
//! it against different entry bytes. Including `log_id` rather than relying on
//! the digest to carry it is one field for a whole class of cross-log replay.

use alloc::vec::Vec;
// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;

use f2z_codec::canonical::Canonical;
use f2z_codec::hash::hash;
use f2z_codec::types::{Digest, PublicKey, ShortBytes, Signature};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::error::{AuthorityError, Result};
use crate::key::SigningKey;
use crate::labels::{LABEL_ASSERTION_BINDING_TBS, LABEL_ASSERTION_DIGEST, LABEL_ASSERTION_TBS};
use crate::types::{AssertionNonce, AuthorityId, Handle, HandleId, Intent, LogId, authority_id};

/// What an authority signs.
///
/// Every field is checked by [`AuthorityConfig::check_assertion_layer`] — the type carries no
/// invariant of its own beyond decoding, deliberately, so that a decoded
/// assertion is *data* until a policy has judged it.
///
/// The derived `Debug` is safe because every field that holds bytes is one of
/// the redacting newtypes; `label` renders because [`ShortBytes`] prints
/// printable ASCII and that is the field's entire purpose.
///
/// [`AuthorityConfig::check_assertion_layer`]: crate::authority::AuthorityConfig::check_assertion_layer
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct HandleAssertionTBS {
    /// Exactly [`LABEL_ASSERTION_TBS`]. The domain-separated signing prefix.
    pub label: ShortBytes,
    /// Which authority is speaking.
    pub authority_id: AuthorityId,
    /// Which log this is for.
    pub log_id: LogId,
    /// The handle being vouched for.
    pub handle: Handle,
    /// `H("free2z/kt/v1/handle-id", handle)`.
    pub handle_id: HandleId,
    /// The identity key (ISK.public) the handle is being bound to.
    pub identity_pk: PublicKey,
    /// Bind, or reset.
    pub intent: Intent,
    /// The authority's counter for the *account* behind the handle. It
    /// increments whenever the account changes hands or is recovered, which is
    /// the only thing that justifies a reset.
    pub account_epoch: u32,
    /// When the authority issued this, in milliseconds since the Unix epoch.
    pub issued_ms: u64,
    /// When it stops being usable.
    pub expires_ms: u64,
    /// 16 bytes of issuer CSPRNG, fresh per assertion.
    pub nonce: AssertionNonce,
}

impl HandleAssertionTBS {
    /// Build an assertion body, deriving `authority_id` and `handle_id` rather
    /// than accepting them.
    ///
    /// Deriving both here is why a hand-built assertion cannot contradict
    /// itself in the two ways that would otherwise be easy: naming one
    /// authority while being signed by another, and naming one handle while
    /// being indexed under another.
    ///
    /// It also refuses to *mint* what the log would refuse to admit: an
    /// `account_epoch` at or above [`ACCOUNT_EPOCH_CEILING`] is a clock rather
    /// than the durable counter `KT.md` §4.5.4 requires, and the failure this
    /// crate exists to prevent is an issuer that reaches for `now / 1000`
    /// because a counter was inconvenient. Refusing here means the issuer finds
    /// out at its own keyboard rather than at somebody else's log.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the label does not fit `<0..255>`,
    /// which it always does — the check is there so the constructor has no
    /// unwrap in it. [`AuthorityError::AccountEpochNotACounter`] for a
    /// clock-shaped `account_epoch`.
    ///
    /// [`ACCOUNT_EPOCH_CEILING`]: crate::authority::ACCOUNT_EPOCH_CEILING
    // Nine arguments, and deliberately not a builder. Every one of them is a
    // field of a structure that is about to be signed, and a builder would make
    // each one omissible: forgetting `expires_ms` on a builder yields a
    // compiling program that mints an assertion with a zero expiry, while
    // forgetting it here does not compile. `authority_id` and `handle_id` are
    // the two fields that are *not* arguments, because they are derived.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        authority_pk: &PublicKey,
        log_id: LogId,
        handle: Handle,
        identity_pk: PublicKey,
        intent: Intent,
        account_epoch: u32,
        issued_ms: u64,
        expires_ms: u64,
        nonce: AssertionNonce,
    ) -> Result<Self> {
        if account_epoch >= crate::authority::ACCOUNT_EPOCH_CEILING {
            return Err(AuthorityError::AccountEpochNotACounter);
        }
        let handle_id = handle.handle_id();
        Ok(Self {
            label: ShortBytes::new(LABEL_ASSERTION_TBS).map_err(AuthorityError::from)?,
            authority_id: authority_id(authority_pk),
            log_id,
            handle,
            handle_id,
            identity_pk,
            intent,
            account_epoch,
            issued_ms,
            expires_ms,
            nonce,
        })
    }

    /// The exact bytes the authority signs.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(self.encode_canonical()?)
    }

    /// Sign this body, producing the assertion an issuer hands out.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the structure cannot be encoded.
    pub fn sign(self, key: &SigningKey) -> Result<HandleAssertion> {
        let signature = key.sign(&self.signing_bytes()?);
        Ok(HandleAssertion {
            assertion: self,
            signature,
        })
    }
}

/// A signed assertion: the bearer document.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct HandleAssertion {
    /// What was signed.
    pub assertion: HandleAssertionTBS,
    /// Ed25519 over `tls_codec(HandleAssertionTBS)`, by the key whose digest is
    /// `assertion.authority_id`.
    pub signature: Signature,
}

impl HandleAssertion {
    /// `H("free2z/kt/v1/assertion-digest", tls_codec(HandleAssertion))` — what
    /// the identity key's binding commits to.
    ///
    /// Over the assertion **including its signature**, on `KT.md` §4.2's
    /// reasoning for `prev_entry_hash`: committing to the authorization as well
    /// as the contents means an assertion cannot be re-signed after the subject
    /// has bound itself to it.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the structure cannot be encoded.
    pub fn digest(&self) -> Result<Digest> {
        Ok(hash(LABEL_ASSERTION_DIGEST, &self.encode_canonical()?))
    }
}

/// What the identity key signs: this assertion, for this submission, on this
/// log.
///
/// See the module note. `assertion_digest` is 32 zero bytes when the entry
/// carries no assertion — the proposed unvouched mode and routine entries — so
/// the submitter still answers for this exact entry.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AssertionBindingTBS {
    /// Exactly [`LABEL_ASSERTION_BINDING_TBS`].
    pub label: ShortBytes,
    /// The log the submission is going to.
    pub log_id: LogId,
    /// The handle being claimed.
    pub handle: Handle,
    /// The identity key doing the claiming — and the key that signs this.
    pub identity_pk: PublicKey,
    /// [`HandleAssertion::digest`], or 32 zero bytes on a log with no
    /// authority.
    pub assertion_digest: Digest,
    /// The submission's `AkdValue`:
    /// `H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` (`KT.md` §3.3).
    pub entry_digest: Digest,
}

impl AssertionBindingTBS {
    /// The binding for a submission that carries an assertion.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the label does not fit `<0..255>`.
    pub fn for_assertion(
        log_id: LogId,
        handle: Handle,
        identity_pk: PublicKey,
        assertion_digest: Digest,
        entry_digest: Digest,
    ) -> Result<Self> {
        Ok(Self {
            label: ShortBytes::new(LABEL_ASSERTION_BINDING_TBS).map_err(AuthorityError::from)?,
            log_id,
            handle,
            identity_pk,
            assertion_digest,
            entry_digest,
        })
    }

    /// The binding for a submission to a log with **no** authority, where there
    /// is no assertion to commit to.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the label does not fit `<0..255>`.
    pub fn unvouched(
        log_id: LogId,
        handle: Handle,
        identity_pk: PublicKey,
        entry_digest: Digest,
    ) -> Result<Self> {
        Self::for_assertion(log_id, handle, identity_pk, Digest::zero(), entry_digest)
    }

    /// The exact bytes the identity key signs.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(self.encode_canonical()?)
    }

    /// Sign this binding with the identity key it names.
    ///
    /// Nothing checks here that `key` *is* `identity_pk`; the verifier does,
    /// because it is the verifier's job and a signing-side check would be
    /// advice rather than a rule.
    ///
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the structure cannot be encoded.
    pub fn sign(&self, key: &SigningKey) -> Result<Signature> {
        Ok(key.sign(&self.signing_bytes()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::canonical::decode_canonical;

    struct Field {
        bytes: Vec<u8>,
    }

    fn declared_encoded_width(declaration: &str, bytes: &[u8]) -> usize {
        if let Some(bits) = declaration
            .split_whitespace()
            .next()
            .and_then(|kind| kind.strip_prefix("uint"))
        {
            let bits: usize = bits.parse().unwrap();
            assert_eq!(bits % 8, 0, "`{declaration}` is not byte-aligned");
            return bits / 8;
        }

        if let Some((_, width)) = declaration
            .strip_suffix(']')
            .and_then(|without_close| without_close.rsplit_once('['))
        {
            assert!(
                declaration.starts_with("opaque "),
                "unsupported fixed-width declaration `{declaration}`"
            );
            return width.parse().unwrap();
        }

        if let Some((_, bounds)) = declaration
            .strip_suffix('>')
            .and_then(|without_close| without_close.rsplit_once('<'))
        {
            assert!(
                declaration.starts_with("opaque "),
                "unsupported variable-width declaration `{declaration}`"
            );
            let (min, max) = bounds.split_once("..").unwrap();
            let min: usize = min.parse().unwrap();
            let max: usize = max.parse().unwrap();
            let (&encoded_len, payload) = bytes.split_first().unwrap();
            assert_eq!(
                usize::from(encoded_len),
                payload.len(),
                "`{declaration}` length prefix says {encoded_len} bytes but the literal supplies {}",
                payload.len()
            );
            assert!(
                (min..=max).contains(&payload.len()),
                "`{declaration}` permits {min}..{max} bytes but the literal supplies {}",
                payload.len()
            );
            return bytes.len();
        }

        assert_eq!(
            declaration, "HandleAssertionTBS assertion",
            "unsupported wire declaration `{declaration}`"
        );
        bytes.len()
    }

    fn field(declaration: &'static str, bytes: impl AsRef<[u8]>) -> Field {
        let bytes = bytes.as_ref().to_vec();
        let width = declared_encoded_width(declaration, &bytes);
        assert_eq!(
            bytes.len(),
            width,
            "`{declaration}` says {width} bytes but the literal supplies {}",
            bytes.len()
        );
        Field { bytes }
    }

    fn fill(byte: u8, width: usize) -> Vec<u8> {
        alloc::vec![byte; width]
    }

    fn hand_derived(fields: &[Field]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in fields {
            bytes.extend_from_slice(&value.bytes);
        }
        bytes
    }

    #[test]
    #[should_panic(
        expected = "`opaque authority_id[31]` says 31 bytes but the literal supplies 32"
    )]
    fn the_wire_declaration_width_is_a_live_guard() {
        let _ = field("opaque authority_id[31]", fill(0x11, 32));
    }

    #[test]
    #[should_panic(expected = "`uint64 account_epoch` says 8 bytes but the literal supplies 4")]
    fn the_integer_declaration_drives_its_encoded_width() {
        let _ = field("uint64 account_epoch", [0u8; 4]);
    }

    #[test]
    #[should_panic(
        expected = "`opaque handle<1..30>` length prefix says 4 bytes but the literal supplies 5"
    )]
    fn the_variable_opaque_declaration_checks_its_length_prefix() {
        let _ = field("opaque handle<1..30>", b"\x04alice");
    }

    fn vector_tbs() -> HandleAssertionTBS {
        HandleAssertionTBS {
            label: ShortBytes::new(b"free2z/kt/v1/handle-assertion").unwrap(),
            authority_id: AuthorityId::new([0x11; 32]),
            log_id: LogId::new([0x22; 32]),
            handle: Handle::parse(b"alice").unwrap(),
            handle_id: HandleId::new([0x33; 32]),
            identity_pk: PublicKey::new([0x44; 32]),
            intent: Intent::Bind,
            account_epoch: 0x0102_0304,
            issued_ms: 0x0102_0304_0506_0708,
            expires_ms: 0x1112_1314_1516_1718,
            nonce: AssertionNonce::new([0x55; 16]),
        }
    }

    fn tbs_fields() -> Vec<Field> {
        alloc::vec![
            field("opaque label<0..255>", b"\x1dfree2z/kt/v1/handle-assertion",),
            field("opaque authority_id[32]", fill(0x11, 32)),
            field("opaque log_id[32]", fill(0x22, 32)),
            field("opaque handle<1..30>", b"\x05alice"),
            field("opaque handle_id[32]", fill(0x33, 32)),
            field("opaque identity_pk[32]", fill(0x44, 32)),
            field("uint8 intent", [0x01]),
            field("uint32 account_epoch", [0x01, 0x02, 0x03, 0x04]),
            field("uint64 issued_ms", [1, 2, 3, 4, 5, 6, 7, 8]),
            field(
                "uint64 expires_ms",
                [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18],
            ),
            field("opaque nonce[16]", fill(0x55, 16)),
        ]
    }

    fn tbs() -> HandleAssertionTBS {
        let authority = SigningKey::from_seed(&[1u8; 32]);
        HandleAssertionTBS::new(
            &authority.public_key(),
            LogId::new([9u8; 32]),
            Handle::parse(b"alice").unwrap(),
            PublicKey::new([2u8; 32]),
            Intent::Bind,
            0,
            1_000,
            2_000,
            AssertionNonce::new([3u8; 16]),
        )
        .unwrap()
    }

    #[test]
    fn the_constructor_derives_both_ids() {
        let authority = SigningKey::from_seed(&[1u8; 32]);
        let value = tbs();
        assert_eq!(value.authority_id, authority_id(&authority.public_key()));
        assert_eq!(value.handle_id, value.handle.handle_id());
        assert_eq!(value.label.as_slice(), LABEL_ASSERTION_TBS);
    }

    #[test]
    fn an_assertion_round_trips_canonically() {
        let signed = tbs().sign(&SigningKey::from_seed(&[1u8; 32])).unwrap();
        let bytes = signed.encode_canonical().unwrap();
        assert_eq!(
            decode_canonical::<HandleAssertion>(&bytes).unwrap().value(),
            &signed
        );

        // A trailing byte is not slack.
        let mut tampered = bytes.clone();
        tampered.push(0);
        assert!(decode_canonical::<HandleAssertion>(&tampered).is_err());
    }

    #[test]
    fn the_signing_prefix_is_the_label_field() {
        let bytes = tbs().signing_bytes().unwrap();
        let mut expected = alloc::vec::Vec::new();
        // `opaque label<0..255>`: one length byte, then the bytes.
        expected.push(u8::try_from(LABEL_ASSERTION_TBS.len()).unwrap());
        expected.extend_from_slice(LABEL_ASSERTION_TBS);
        assert!(bytes.starts_with(&expected));
    }

    #[test]
    fn proposal_handle_assertion_tbs_has_the_literal_candidate_field_order() {
        assert_eq!(
            vector_tbs().signing_bytes().unwrap(),
            hand_derived(&tbs_fields())
        );
    }

    #[test]
    fn proposal_signed_assertion_has_the_literal_candidate_field_order() {
        let actual = HandleAssertion {
            assertion: vector_tbs(),
            signature: Signature::new([0x66; 64]),
        }
        .encode_canonical()
        .unwrap();
        let fields = alloc::vec![
            field("HandleAssertionTBS assertion", hand_derived(&tbs_fields()),),
            field("opaque signature[64]", fill(0x66, 64)),
        ];
        assert_eq!(actual, hand_derived(&fields));
    }

    #[test]
    fn proposal_binding_tbs_has_the_literal_candidate_field_order() {
        let binding = AssertionBindingTBS {
            label: ShortBytes::new(b"free2z/kt/v1/assertion-binding").unwrap(),
            log_id: LogId::new([0x22; 32]),
            handle: Handle::parse(b"alice").unwrap(),
            identity_pk: PublicKey::new([0x44; 32]),
            assertion_digest: Digest::new([0x77; 32]),
            entry_digest: Digest::new([0x88; 32]),
        };
        let fields = alloc::vec![
            field(
                "opaque label<0..255>",
                b"\x1efree2z/kt/v1/assertion-binding",
            ),
            field("opaque log_id[32]", fill(0x22, 32)),
            field("opaque handle<1..30>", b"\x05alice"),
            field("opaque identity_pk[32]", fill(0x44, 32)),
            field("opaque assertion_digest[32]", fill(0x77, 32)),
            field("opaque entry_digest[32]", fill(0x88, 32)),
        ];
        assert_eq!(binding.signing_bytes().unwrap(), hand_derived(&fields));
    }

    #[test]
    fn the_digest_covers_the_signature_too() {
        let body = tbs();
        let one = body
            .clone()
            .sign(&SigningKey::from_seed(&[1u8; 32]))
            .unwrap();
        let mut two = one.clone();
        two.signature = Signature::new([0u8; 64]);
        assert_ne!(one.digest().unwrap(), two.digest().unwrap());
    }

    #[test]
    fn assertion_digest_matches_the_independent_nonuniform_canonical_vector() {
        // This is the literal tls_codec byte sequence for one signed
        // assertion. Its BLAKE2b-256 expectation was derived independently as
        // b2sum -l 256(label || these 265 bytes), not by this crate's hash or
        // encoding helpers.
        let mut canonical = b"\x1dfree2z/kt/v1/handle-assertion".to_vec();
        canonical.extend_from_slice(&[
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
            0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
            0x1c, 0x1d, 0x1e, 0x1f,
        ]);
        canonical.extend_from_slice(&[
            0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d,
            0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b,
            0x3c, 0x3d, 0x3e, 0x3f,
        ]);
        canonical.extend_from_slice(b"\x05a1_b2");
        canonical.extend_from_slice(&[
            0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d,
            0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b,
            0x5c, 0x5d, 0x5e, 0x5f,
        ]);
        canonical.extend_from_slice(&[
            0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d,
            0x6e, 0x6f, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b,
            0x7c, 0x7d, 0x7e, 0x7f,
        ]);
        canonical.extend_from_slice(&[
            0x02, 0x01, 0x23, 0x45, 0x67, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x11,
            0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        ]);
        canonical.extend_from_slice(&[
            0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d,
            0x8e, 0x8f,
        ]);
        canonical.extend(0x90..=0xcf);
        assert_eq!(canonical.len(), 265);

        let assertion = decode_canonical::<HandleAssertion>(&canonical)
            .unwrap()
            .value()
            .clone();
        assert_eq!(assertion.encode_canonical().unwrap(), canonical);
        assert_eq!(
            assertion.digest().unwrap().as_bytes(),
            &[
                0x1e, 0x3f, 0x8c, 0x54, 0x9c, 0x81, 0x6a, 0xbd, 0x45, 0x0a, 0xe7, 0x9a, 0xbb, 0xac,
                0x86, 0xcc, 0xa7, 0xda, 0x04, 0xd9, 0x3e, 0x47, 0x89, 0x1e, 0xc8, 0x6a, 0x5c, 0x1e,
                0x1e, 0xc1, 0x00, 0x67,
            ]
        );
    }

    #[test]
    fn an_unvouched_binding_carries_a_zero_assertion_digest() {
        let binding = AssertionBindingTBS::unvouched(
            LogId::new([9u8; 32]),
            Handle::parse(b"alice").unwrap(),
            PublicKey::new([2u8; 32]),
            Digest::new([4u8; 32]),
        )
        .unwrap();
        assert_eq!(binding.assertion_digest, Digest::zero());
        let bytes = binding.encode_canonical().unwrap();
        assert_eq!(
            decode_canonical::<AssertionBindingTBS>(&bytes)
                .unwrap()
                .value(),
            &binding
        );
    }
}
