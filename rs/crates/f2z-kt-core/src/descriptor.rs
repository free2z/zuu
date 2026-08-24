//! `LogDescriptor` — `KT.md` §9.1, a log's entire externally-relevant policy in
//! one signed document that a human can read before trusting it.
//!
//! `reset_authority_pk` being published here does **not** discharge ADR 0014's
//! requirement that it be **pinned in clients**. A reset authority key a client
//! learns from the log is a key the log chooses, which is no authority at all.
//! The published copy exists so a human can compare it against the pinned one,
//! which is why [`LogDescriptor::matches_pinned_reset_authority`] takes the
//! pinned key as an argument and why nothing in this crate ever reads
//! `reset_authority_pk` out of a descriptor to verify with.

use f2z_codec::canonical::encode;
use f2z_codec::types::{PublicKey, ShortBytes, Signature};
use f2z_codec::vec::VecU8;
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::KT_VERSION;
use crate::error::KtError;
use crate::labels::log_id as derive_log_id;
use crate::sig;
use crate::types::LogId;

/// The `akd` configuration a log is built on (§3.2).
///
/// **The choice is not changeable later.** The configuration determines every
/// label and every commitment in the tree, so changing it invalidates every
/// proof ever issued and every root ever cosigned. Migrating means standing up a
/// new log with a new `log_id` and having clients re-pin, which is a
/// distinguishable event and not a silent upgrade.
pub const CONFIGURATION_WHATSAPP_V1: u8 = 1;

/// The `LogDescriptor` of §9.1.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct LogDescriptor {
    /// The `kt_version`s this log serves.
    pub kt_versions: VecU8<u16>,
    /// `H("free2z/kt/v1/log-id", genesis_log_pk)`.
    pub log_id: LogId,
    /// The key currently signing tree heads (§6.4 for succession).
    pub log_signing_pk: PublicKey,
    /// The key `log_id` is derived from, forever.
    pub genesis_log_pk: PublicKey,
    /// The ECVRF key labels are derived under.
    pub vrf_public_key: PublicKey,
    /// [`CONFIGURATION_WHATSAPP_V1`].
    pub configuration: u8,
    /// The published cadence (§5.1).
    pub epoch_interval_seconds: u32,
    /// The published merge promise (§5.2).
    pub max_merge_delay_seconds: u32,
    /// ADR 0014's reset cooldown.
    pub reset_cooldown_seconds: u32,
    /// The reset authority key, published for comparison against the **pinned**
    /// one and for no other purpose.
    pub reset_authority_pk: PublicKey,
    /// Who runs this log.
    pub operator_name: ShortBytes,
    /// How to reach them.
    pub operator_contact: ShortBytes,
    /// Under whose law they operate.
    pub operator_jurisdiction: ShortBytes,
    /// Their published policy.
    pub operator_policy_url: ShortBytes,
    /// Where the code is.
    pub source_repo_url: ShortBytes,
    /// Which commit is deployed.
    pub source_commit: ShortBytes,
    /// The reproducible-build digest of that commit.
    pub build_digest: ShortBytes,
    /// When this descriptor was published.
    pub published_at_ms: u64,
}

impl LogDescriptor {
    /// Check the invariants a decoder cannot.
    ///
    /// # Errors
    ///
    /// - [`KtError::UnsupportedVersion`] if this build's [`KT_VERSION`] is not
    ///   among `kt_versions`.
    /// - [`KtError::WrongLog`] if `log_id` is not the digest of
    ///   `genesis_log_pk` — a log that publishes an unrelated pair is claiming
    ///   an identity it cannot derive.
    /// - [`KtError::Malformed`] if `configuration` is not
    ///   [`CONFIGURATION_WHATSAPP_V1`].
    pub fn validate(&self) -> Result<(), KtError> {
        if !self.kt_versions.as_slice().contains(&KT_VERSION) {
            return Err(KtError::UnsupportedVersion);
        }
        if self.log_id != derive_log_id(&self.genesis_log_pk) {
            return Err(KtError::WrongLog);
        }
        // §3.2 fixes WhatsAppV1 and calls the choice permanent. A descriptor
        // announcing anything else is announcing a tree whose labels and
        // commitments this build cannot verify, so it is refused rather than
        // ignored.
        if self.configuration != CONFIGURATION_WHATSAPP_V1 {
            return Err(KtError::Malformed);
        }
        Ok(())
    }

    /// Whether the published reset authority key equals the one the client has
    /// **pinned** (ADR 0014).
    ///
    /// A `false` here is not a decode failure and not necessarily an attack — a
    /// reset authority key rotation is §12's named open gap, and there is no
    /// specified path for one. It is a fact a human must be shown.
    #[must_use]
    pub fn matches_pinned_reset_authority(&self, pinned: &PublicKey) -> bool {
        self.reset_authority_pk == *pinned
    }

    /// The exact bytes the log signs.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }
}

/// A `SignedLogDescriptor` (§9.1).
///
/// Served at `GET /.well-known/free2z-kt/v1/log` as `tls_codec` bytes **and** as
/// JSON with the same values and the same signature. Nothing forces the two
/// representations to agree except the operator; what makes divergence costly is
/// that both are signed by the same key.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignedLogDescriptor {
    /// The signed policy.
    pub descriptor: LogDescriptor,
    /// Ed25519 by `descriptor.log_signing_pk`.
    pub signature: Signature,
}

impl SignedLogDescriptor {
    /// Verify the descriptor's shape and the log's signature over it.
    ///
    /// # Errors
    ///
    /// As [`LogDescriptor::validate`], plus [`KtError::BadSignature`].
    pub fn verify(&self) -> Result<(), KtError> {
        self.descriptor.validate()?;
        sig::verify(
            &self.descriptor.log_signing_pk,
            &self.descriptor.signing_bytes()?,
            &self.signature,
        )
    }

    /// The `log_id` a client should pin from this descriptor.
    ///
    /// Derived from `genesis_log_pk` rather than read out of the `log_id` field,
    /// so a descriptor whose two fields disagree cannot install the field's
    /// value. [`LogDescriptor::validate`] already refuses that case; deriving
    /// here means the refusal is not the only thing standing between the two.
    #[must_use]
    pub fn derived_log_id(&self) -> LogId {
        derive_log_id(&self.descriptor.genesis_log_pk)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestLog;

    #[test]
    fn a_descriptor_verifies_and_derives_its_own_log_id() {
        let log = TestLog::new();
        let descriptor = log.descriptor();
        assert_eq!(descriptor.verify(), Ok(()));
        assert_eq!(&descriptor.derived_log_id(), log.log_id());
    }

    #[test]
    fn a_log_id_that_is_not_the_digest_of_the_genesis_key_is_refused() {
        let log = TestLog::new();
        let mut descriptor = log.descriptor();
        descriptor.descriptor.log_id = LogId::new([1u8; 32]);
        assert_eq!(descriptor.descriptor.validate(), Err(KtError::WrongLog));
    }

    #[test]
    fn an_experimental_configuration_is_refused() {
        let log = TestLog::new();
        let mut descriptor = log.descriptor();
        descriptor.descriptor.configuration = 2;
        assert_eq!(descriptor.descriptor.validate(), Err(KtError::Malformed));
    }

    #[test]
    fn the_published_reset_authority_is_compared_never_trusted() {
        let log = TestLog::new();
        let descriptor = log.descriptor();
        assert!(
            descriptor
                .descriptor
                .matches_pinned_reset_authority(log.reset_authority_pk())
        );
        assert!(
            !descriptor
                .descriptor
                .matches_pinned_reset_authority(&PublicKey::new([2u8; 32]))
        );
    }
}
