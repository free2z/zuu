//! Signing the handle-authority policy — the log's half of `KT.md` §4.6.
//!
//! # The structure moved; the signing did not
//!
//! [`AuthorityPolicyTBS`] and [`SignedAuthorityPolicy`] now live in
//! [`f2z_kt_core::policy`] and are re-exported here, so that every caller that
//! named them through this module still compiles.
//!
//! They moved because `KT.md` §8.1 step 7 is a **client** obligation — *"Fetch
//! §4.6's `SignedAuthorityPolicy` for this `log_id` and verify it under the log
//! key already accepted in step 2"* — and this crate is AGPL-3.0: a client that
//! linked it to decode the document would be relicensed by doing so, and the
//! only alternative was a second decoder for a signed structure, which §11.4's
//! *one crate, three consumers* exists to forbid.
//!
//! [`sign_policy`] stays here because it is the half that cannot leave: it
//! reads the log's live [`AuthorityConfig`] — the same one the submission path
//! applies, so the document cannot describe a policy the log is not actually
//! enforcing — and signs with the log's [`LogSigner`]. `f2z-kt-core` holds no
//! configuration and signs nothing.

use f2z_authority::authority::{AuthorityConfig, VouchingStatus};
use f2z_codec::vec::VecU16;
use f2z_kt_core::KT_VERSION;
use f2z_kt_core::types::{LogId, label_field};

pub use f2z_kt_core::policy::{
    AuthorityPolicyTBS, LABEL_AUTHORITY_POLICY, SignedAuthorityPolicy, VOUCHING_UNVOUCHED,
    VOUCHING_VOUCHED,
};

use crate::error::{LogError, Result};
use crate::signer::LogSigner;

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
    use f2z_authority::authority::{AuthorityConfig, AuthoritySet};
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
