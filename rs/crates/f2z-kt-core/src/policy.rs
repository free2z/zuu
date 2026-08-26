//! The signed handle-authority policy — how a client finds out whether handles
//! on this log are vouched at all.
//!
//! # Why this document exists
//!
//! [zuu#594]'s acceptance criteria include: *"The no-authority mode is
//! specified **and required to be reported**, so a client connecting to a
//! self-hosted log can see that handles there are unvouched."*
//!
//! `KT.md` §9.1's `LogDescriptor` has no field for it — it predates the
//! question. Adding one would be a change to a merged normative structure, made
//! unilaterally, in a crate; instead this is a **separate signed document**
//! alongside the descriptor, at `GET /.well-known/free2z-kt/v1/authority`, and
//! it is offered as a proposal the specification should absorb rather than as
//! ratified encoding.
//!
//! Everything about its shape follows §6.2's rules for the documents that
//! *are* ratified: a distinct, versioned constant in the first field of the
//! signed bytes, signed directly rather than prehashed, by the log signing key.
//! The label is new, so it is stated here as an addition to §6.2's "closed"
//! set — which it is, and a reader should notice that.
//!
//! # What it is not
//!
//! It is **not** a way to learn who the authorities are and trust them. An
//! authority key a client learns from the log is a key the log chose, exactly
//! as `KT.md` §9.1 says of `reset_authority_pk`. What the document gives a
//! client is the one thing it cannot get anywhere else: **whether this log
//! claims any handle vouching at all**, so that "unvouched" is a visible
//! property of a directory rather than something a user discovers after
//! someone takes their name.
//!
//! [zuu#594]: https://github.com/free2z/zuu/issues/594
//!
//! # Why the structure is here and the signing is not
//!
//! Moved out of the log server for `KT.md` §8.1 step 7, which is a **client**
//! obligation: *"Fetch §4.6's `SignedAuthorityPolicy` for this `log_id` and
//! verify it under the log key already accepted in step 2."* While the type
//! lived in `f2z-kt` — AGPL-3.0, a server binary — no client could discharge
//! that step without relicensing itself, and the only other way to do it would
//! have been a second decoder for a signed structure. §11.4's *one crate, three
//! consumers* is exactly the rule that forbids the second decoder, so the
//! structure came here instead.
//!
//! What stayed behind is `f2z_kt::policy::sign_policy`, which derives the
//! document from the log's live `AuthorityConfig` and signs it with the log's
//! `LogSigner`. Neither of those types belongs on a client, and this crate
//! signs nothing.

use f2z_codec::Canonical as _;
use f2z_codec::types::{PublicKey, ShortBytes, Signature};
use f2z_codec::vec::VecU16;
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::error::KtError;
use crate::types::{LogId, check_label};
use crate::{KT_VERSION, sig};

/// The signing label for [`AuthorityPolicyTBS`]. **An addition to `KT.md`
/// §6.2's table**, and marked as one: the set there is closed as of v1, and
/// this document is a proposal against zuu#594.
pub const LABEL_AUTHORITY_POLICY: &[u8] = b"free2z/kt/v1/authority-policy";

/// This log vouches for handles: an authority must sign a `HandleAssertion`
/// before a first entry is accepted.
pub const VOUCHING_VOUCHED: u8 = 1;

/// This log does **not** vouch for handles. Anyone who can prove possession of
/// an identity key may claim any unregistered handle, first come first served.
pub const VOUCHING_UNVOUCHED: u8 = 0;

/// What a log says about who is allowed to claim a handle on it.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AuthorityPolicyTBS {
    /// Exactly [`LABEL_AUTHORITY_POLICY`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The log this policy is for. A policy without it could be replayed
    /// against another log.
    pub log_id: LogId,
    /// [`VOUCHING_VOUCHED`] or [`VOUCHING_UNVOUCHED`]. **The field zuu#594 asks
    /// for.** A client that reads `0` here knows that a handle on this log is a
    /// name somebody typed, not a name anybody attested.
    pub vouching: u8,
    /// The authority public keys, for a human to compare against whatever they
    /// were told out of band. Empty when `vouching` is
    /// [`VOUCHING_UNVOUCHED`]. **Not a trust root** — see the module note.
    pub authorities: VecU16<PublicKey>,
    /// The log's own cap on `expires_ms - issued_ms` for an assertion, in
    /// milliseconds. Published because it bounds the blast radius of a
    /// compromised issuer, and a bound nobody can see is a bound nobody can
    /// check.
    pub max_validity_ms: u64,
    /// The clock skew the log allows an issuer, in milliseconds.
    pub clock_skew_ms: u64,
    /// `entry_version` values at which an assertion is required. Exactly `[1]`
    /// in this implementation — see [`crate::admit`] for why later versions are
    /// authorized by `KT.md` §4.4's own chain and admit no assertion at all.
    pub asserted_versions: VecU16<u32>,
    /// The log's clock when this was signed.
    pub published_at_ms: u64,
}

impl AuthorityPolicyTBS {
    /// The bytes the signature covers.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure will not encode.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        self.encode_canonical().map_err(Into::into)
    }

    /// Check the constants and the internal agreement between `vouching` and
    /// `authorities`.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`], or
    /// [`KtError::Malformed`] for a policy that contradicts itself — an
    /// unvouched log listing authorities, or a vouched one listing none.
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_AUTHORITY_POLICY)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        match self.vouching {
            VOUCHING_VOUCHED if !self.authorities.is_empty() => Ok(()),
            VOUCHING_UNVOUCHED if self.authorities.is_empty() => Ok(()),
            _ => Err(KtError::Malformed),
        }
    }

    /// Whether this log vouches for its handles.
    #[must_use]
    pub const fn vouches(&self) -> bool {
        self.vouching == VOUCHING_VOUCHED
    }
}

/// [`AuthorityPolicyTBS`] plus the log's signature over it.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignedAuthorityPolicy {
    /// The policy.
    pub policy: AuthorityPolicyTBS,
    /// Ed25519 over `tls_codec(AuthorityPolicyTBS)` by the log signing key.
    pub signature: Signature,
}

impl SignedAuthorityPolicy {
    /// Verify the label, the version, the internal agreement, and the
    /// signature.
    ///
    /// # Errors
    ///
    /// As [`AuthorityPolicyTBS::validate`], plus [`KtError::BadSignature`].
    pub fn verify(&self, log_id: &LogId, log_pk: &PublicKey) -> Result<(), KtError> {
        self.policy.validate()?;
        if &self.policy.log_id != log_id {
            return Err(KtError::WrongLog);
        }
        sig::verify(log_pk, &self.policy.signing_bytes()?, &self.signature)
    }
}
