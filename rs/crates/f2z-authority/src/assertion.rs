//! The two signed structures: what an authority says, and what the identity
//! key it names says back.
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
//!                                      all-zero when the log has no authority */
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
//! `KT.md` requires this pairing. This crate makes it structural: there is no
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
/// Every field is checked by [`AuthorityConfig::admit`] — the type carries no
/// invariant of its own beyond decoding, deliberately, so that a decoded
/// assertion is *data* until a policy has judged it.
///
/// The derived `Debug` is safe because every field that holds bytes is one of
/// the redacting newtypes; `label` renders because [`ShortBytes`] prints
/// printable ASCII and that is the field's entire purpose.
///
/// [`AuthorityConfig::admit`]: crate::authority::AuthorityConfig::admit
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
    /// # Errors
    ///
    /// [`AuthorityError::Malformed`] if the label does not fit `<0..255>`,
    /// which it always does — the check is there so the constructor has no
    /// unwrap in it.
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
/// See the module note. `assertion_digest` is 32 zero bytes when the log has no
/// authority — the "absent value is all-zero" idiom `WIRE.md` §5.1 already
/// uses — so that a log with no directory still requires the submitter to
/// answer for itself, and so that one transcript covers both configurations.
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
