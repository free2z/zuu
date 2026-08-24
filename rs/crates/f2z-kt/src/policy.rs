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

use f2z_authority::authority::{AuthorityConfig, VouchingStatus};
use f2z_codec::Canonical as _;
use f2z_codec::types::{PublicKey, ShortBytes, Signature};
use f2z_codec::vec::VecU16;
use f2z_kt_core::types::{LogId, check_label, label_field};
use f2z_kt_core::{KT_VERSION, KtError, sig};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::error::{LogError, Result};
use crate::signer::LogSigner;

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
    pub fn signing_bytes(&self) -> core::result::Result<Vec<u8>, KtError> {
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
    pub fn validate(&self) -> core::result::Result<(), KtError> {
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
    pub fn verify(
        &self,
        log_id: &LogId,
        log_pk: &PublicKey,
    ) -> core::result::Result<(), KtError> {
        self.policy.validate()?;
        if &self.policy.log_id != log_id {
            return Err(KtError::WrongLog);
        }
        sig::verify(log_pk, &self.policy.signing_bytes()?, &self.signature)
    }
}

/// Build and sign the policy document from the log's live configuration.
///
/// Derived from the same [`AuthorityConfig`] the submission path uses, so the
/// document cannot describe a policy the log is not actually applying — the
/// failure mode that would make publishing it worse than not publishing it.
///
/// # Errors
///
/// [`LogError::Signer`] if signing failed, [`LogError::Malformed`] if the
/// structure will not encode.
pub fn sign_policy(
    authority: &AuthorityConfig,
    log_id: LogId,
    signer: &dyn LogSigner,
    published_at_ms: u64,
) -> Result<SignedAuthorityPolicy> {
    let (vouching, authorities) = match authority.status() {
        VouchingStatus::Vouched { .. } => (
            VOUCHING_VOUCHED,
            authority
                .authorities()
                .keys()
                .iter()
                .map(|key| key.key())
                .collect::<Vec<_>>(),
        ),
        VouchingStatus::Unvouched => (VOUCHING_UNVOUCHED, Vec::new()),
    };

    let policy = AuthorityPolicyTBS {
        label: label_field(LABEL_AUTHORITY_POLICY).map_err(LogError::Kt)?,
        kt_version: KT_VERSION,
        log_id,
        vouching,
        authorities: VecU16::new(authorities),
        max_validity_ms: authority.max_validity_ms(),
        clock_skew_ms: authority.clock_skew_ms(),
        asserted_versions: VecU16::new(vec![1]),
        published_at_ms,
    };
    policy.validate().map_err(LogError::Kt)?;
    let signature = signer.sign(&policy.signing_bytes().map_err(LogError::Kt)?)?;
    Ok(SignedAuthorityPolicy { policy, signature })
}

#[cfg(test)]
mod tests {
    use f2z_authority::authority::{AuthoritySet, AuthorityConfig};
    use f2z_codec::types::PublicKey;
    use f2z_kt_core::types::LogId;

    use super::{VOUCHING_UNVOUCHED, VOUCHING_VOUCHED, sign_policy};
    use crate::signer::{FileSigner, LogSigner as _};

    fn config(set: AuthoritySet) -> AuthorityConfig {
        AuthorityConfig::with_defaults(f2z_authority::types::LogId::new([5u8; 32]), set).unwrap()
    }

    #[test]
    fn a_log_with_no_authority_says_so_in_a_document_a_client_can_verify() {
        let signer = FileSigner::from_seed(&[1u8; 32]);
        let log_id = LogId::new([5u8; 32]);
        let signed = sign_policy(&config(AuthoritySet::none()), log_id, &signer, 1_700).unwrap();

        signed.verify(&log_id, &signer.public_key()).unwrap();
        assert_eq!(signed.policy.vouching, VOUCHING_UNVOUCHED);
        assert!(!signed.policy.vouches());
        assert!(signed.policy.authorities.is_empty());
    }

    #[test]
    fn a_vouching_log_publishes_its_authority_keys_and_its_validity_cap() {
        let signer = FileSigner::from_seed(&[2u8; 32]);
        let log_id = LogId::new([5u8; 32]);
        let authority_pk = PublicKey::new([9u8; 32]);
        let signed = sign_policy(
            &config(AuthoritySet::single(authority_pk).unwrap()),
            log_id,
            &signer,
            1_700,
        )
        .unwrap();

        signed.verify(&log_id, &signer.public_key()).unwrap();
        assert_eq!(signed.policy.vouching, VOUCHING_VOUCHED);
        assert_eq!(signed.policy.authorities.as_slice(), &[authority_pk]);
        assert_eq!(
            signed.policy.max_validity_ms,
            f2z_authority::authority::DEFAULT_MAX_VALIDITY_MS
        );
        assert_eq!(signed.policy.asserted_versions.as_slice(), &[1]);
    }

    #[test]
    fn a_policy_signed_for_one_log_does_not_verify_for_another() {
        let signer = FileSigner::from_seed(&[3u8; 32]);
        let signed = sign_policy(
            &config(AuthoritySet::none()),
            LogId::new([5u8; 32]),
            &signer,
            1,
        )
        .unwrap();
        assert!(
            signed
                .verify(&LogId::new([6u8; 32]), &signer.public_key())
                .is_err()
        );
    }
}
