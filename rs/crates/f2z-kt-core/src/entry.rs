//! `DirectoryEntry` and everything that authorizes one — `KT.md` §4.
//!
//! This module holds the **shapes**. The rules that decide whether a shape may
//! enter the log live in [`crate::submit`], and they are not reachable from
//! here: nothing in this module verifies a signature, and no `validate` below
//! does more than check the constants, charsets and ranges a `tls_codec` decode
//! cannot express.
//!
//! That separation is deliberate and it is the whole architecture of the crate.
//! §4.4's rules are the only thing standing between `akd` and an entry nobody
//! authorized, so they must be impossible to satisfy by accident — which means
//! they cannot be a method on the type a caller already holds.
//!
//! # `DeviceCredential` repeats itself on purpose
//!
//! It carries `identity_pk` and `handle` that the enclosing entry also carries
//! (§4.1). It is the MLS `Credential` in a member's `LeafNode`
//! (`ARCHITECTURE.md` §4.2), validated by peers who have no directory access at
//! all, so it cannot depend on its envelope for meaning. Deduplicating those two
//! fields would save 40 bytes and break the only property that makes the
//! structure useful outside the directory.

use f2z_codec::canonical::{Canonical as _, encode};
use f2z_codec::types::{Digest, PublicKey, QueueAddress, RelayId, ShortBytes, Signature};
use f2z_codec::vec::VecU16;
use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsDeserializeBytes,
    TlsSerializeBytes, TlsSize,
};

use crate::KT_VERSION;
use crate::error::KtError;
use crate::labels::{
    LABEL_DEVICE_CREDENTIAL, LABEL_ENTRY, LABEL_RESET, LABEL_ROTATION, prev_entry_hash,
};
use crate::types::{Handle, KemPublicKey, LogId, check_label, label_field};

/// The fixed v1 tolerance for verifier-clock disagreement: two minutes.
///
/// This is deliberately a protocol constant rather than log-published policy.
/// A log must not be able to extend the useful lifetime of a credential, and
/// an offline MLS peer must be able to apply the same rule without consulting
/// the directory.
pub const DEVICE_CREDENTIAL_CLOCK_SKEW_MS: u64 = 120_000;

/// A device credential's status under the common v1 verifier-time rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum CredentialValidity {
    /// The verifier is earlier than `not_before_ms`, even after the fixed skew
    /// allowance.
    NotYetValid,
    /// The verifier's clock falls inside the skew-expanded inclusive interval.
    Valid,
    /// The verifier is later than `not_after_ms`, even after the fixed skew
    /// allowance.
    Expired,
}

/// The `DeviceCredentialTBS` of §4.1 — what the user's `IdentitySigningKey`
/// signs.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DeviceCredentialTBS {
    /// Exactly `"free2z/device-credential/v1"`.
    pub label: ShortBytes,
    /// `ISK.public` (`ARCHITECTURE.md` §4.2).
    pub identity_pk: PublicKey,
    /// The handle this device speaks for.
    pub handle: Handle,
    /// `DSK.public`, the MLS leaf `signature_key`.
    pub device_pk: PublicKey,
    /// X-Wing hybrid (X25519 + ML-KEM-768).
    pub device_kem_pk: KemPublicKey,
    /// Validity start, milliseconds since the Unix epoch.
    pub not_before_ms: u64,
    /// Validity end, milliseconds since the Unix epoch.
    pub not_after_ms: u64,
}

impl DeviceCredentialTBS {
    /// Check the invariants a decoder cannot express.
    ///
    /// # Errors
    ///
    /// - [`KtError::WrongLabel`] if `label` is not the §6.2 constant.
    /// - [`KtError::BadHandle`] if `handle` is outside `[a-z0-9_]{1,30}`.
    /// - [`KtError::Malformed`] if `device_kem_pk` is empty (`<1..2^16-1>`) or
    ///   the validity window is inverted.
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_DEVICE_CREDENTIAL)?;
        self.handle.validate()?;
        if self.device_kem_pk.is_empty() {
            return Err(KtError::Malformed);
        }
        // §4.1: an empty or inverted interval has no valid instant and is
        // malformed rather than merely inactive.
        if self.not_after_ms <= self.not_before_ms {
            return Err(KtError::Malformed);
        }
        Ok(())
    }

    /// The exact bytes the `IdentitySigningKey` signs.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }

    /// Classify this credential at a verifier's local Unix time.
    ///
    /// Both interval endpoints and both skew boundaries are inclusive. The
    /// additions saturate so values near the Unix-time representation's ends
    /// fail safely without wrapping into the opposite side of the interval.
    #[must_use]
    pub const fn validity_at(&self, verifier_time_ms: u64) -> CredentialValidity {
        if verifier_time_ms.saturating_add(DEVICE_CREDENTIAL_CLOCK_SKEW_MS) < self.not_before_ms {
            CredentialValidity::NotYetValid
        } else if verifier_time_ms
            > self
                .not_after_ms
                .saturating_add(DEVICE_CREDENTIAL_CLOCK_SKEW_MS)
        {
            CredentialValidity::Expired
        } else {
            CredentialValidity::Valid
        }
    }
}

/// A `DeviceCredential` (§4.1): the signed binding of an identity key to a
/// device key.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DeviceCredential {
    /// The signed contents.
    pub credential: DeviceCredentialTBS,
    /// Ed25519 by `credential.identity_pk`.
    pub signature: Signature,
}

/// A published device revocation (§4.1).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DeviceRevocation {
    /// The `DSK.public` being revoked.
    pub device_pk: PublicKey,
    /// When, by the submitter's clock.
    pub revoked_at_ms: u64,
    /// Human-readable, advisory, **never parsed**.
    pub reason: ShortBytes,
}

/// A contact endpoint (§4.1): where first contact for this handle is delivered.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ContactEndpoint {
    /// `wss://…/relay/v1`.
    pub relay_url: ShortBytes,
    /// `WIRE.md` §5.2.
    pub relay_id: RelayId,
    /// `WIRE.md` §12.2.
    pub contact_addr: QueueAddress,
}

impl ContactEndpoint {
    /// Check the one invariant a decoder cannot: `relay_url` is `<1..255>`.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if `relay_url` is empty.
    pub fn validate(&self) -> Result<(), KtError> {
        if self.relay_url.is_empty() {
            return Err(KtError::Malformed);
        }
        Ok(())
    }
}

/// What kind of change an entry makes (§4.1), and therefore what authorizes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum EntryKind {
    /// Adding or revoking a device, or updating contact endpoints. The identity
    /// key is unchanged (ADR 0014 case 1).
    SameKey,
    /// Rotating to a new identity key while still holding the old one
    /// (ADR 0014 case 2).
    KeyChange,
    /// A platform-authority reset, for a user who cannot sign with the outgoing
    /// key at all (ADR 0014 case 3).
    PlatformReset,
}

impl EntryKind {
    /// Every kind, in wire order.
    pub const ALL: [Self; 3] = [Self::SameKey, Self::KeyChange, Self::PlatformReset];

    /// The wire value.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::SameKey => 1,
            Self::KeyChange => 2,
            Self::PlatformReset => 3,
        }
    }

    /// The kind this build knows by that value.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] for anything else. Note this is **not** the
    /// forgiving treatment `WIRE.md` §10 gives an unknown *error code*: an
    /// unknown `EntryKind` is a variant whose authorization rule this build does
    /// not know, and mapping it to a default is exactly the silent-variant
    /// hazard the re-encode-equality rule exists to forbid.
    pub const fn from_code(code: u8) -> Result<Self, KtError> {
        Ok(match code {
            1 => Self::SameKey,
            2 => Self::KeyChange,
            3 => Self::PlatformReset,
            _ => return Err(KtError::Malformed),
        })
    }
}

impl Size for EntryKind {
    fn tls_serialized_len(&self) -> usize {
        1
    }
}

impl SerializeBytes for EntryKind {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        Ok(vec![self.code()])
    }
}

impl DeserializeBytes for EntryKind {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (code, rest) = u8::tls_deserialize_bytes(bytes)?;
        let kind = Self::from_code(code).map_err(|_| {
            TlsError::DecodingError(format!(
                "EntryKind {code} is not one of same_key(1), key_change(2), platform_reset(3)"
            ))
        })?;
        Ok((kind, rest))
    }
}

/// The `RotationProofTBS` of §4.4 — signed by the **outgoing** identity key.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct RotationProofTBS {
    /// Exactly `"free2z/kt/v1/rotation"`.
    pub label: ShortBytes,
    /// The log this proof is valid at.
    pub log_id: LogId,
    /// The handle being rotated.
    pub handle: Handle,
    /// The version this proof authorizes.
    pub entry_version: u32,
    /// The identity key in force before the rotation.
    pub old_identity_pk: PublicKey,
    /// The identity key in force after it.
    pub new_identity_pk: PublicKey,
    /// The hash of the previous entry, binding this proof to one history.
    pub prev_entry_hash: Digest,
    /// Submitter's clock. Authenticated, and not trustworthy (§4.2).
    pub created_at_ms: u64,
}

impl RotationProofTBS {
    /// Check the constants and charsets.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::BadHandle`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_ROTATION)?;
        self.handle.validate()
    }

    /// The exact bytes the outgoing `IdentitySigningKey` signs.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }
}

/// A `RotationProof` (§4.4).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct RotationProof {
    /// The signed contents.
    pub proof: RotationProofTBS,
    /// Ed25519 by `proof.old_identity_pk`.
    pub signature: Signature,
}

/// The `ResetAuthorizationTBS` of §4.4 — signed by the pinned reset authority.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ResetAuthorizationTBS {
    /// Exactly `"free2z/kt/v1/reset"`.
    pub label: ShortBytes,
    /// The log this authorization is valid at.
    pub log_id: LogId,
    /// The handle being reset.
    pub handle: Handle,
    /// The version this authorization covers.
    pub entry_version: u32,
    /// The identity key being displaced.
    pub old_identity_pk: PublicKey,
    /// The identity key being installed.
    pub new_identity_pk: PublicKey,
    /// When the authority signed.
    pub created_at_ms: u64,
    /// `>= created_at_ms + cooldown` (ADR 0014). The log MUST NOT publish the
    /// entry before this instant.
    pub effective_at_ms: u64,
}

impl ResetAuthorizationTBS {
    /// Check the constants and charsets.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::BadHandle`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_RESET)?;
        self.handle.validate()
    }

    /// The exact bytes the reset authority signs.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }
}

/// A `ResetAuthorization` (§4.4).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ResetAuthorization {
    /// The signed contents.
    pub reset: ResetAuthorizationTBS,
    /// Ed25519 by the **pinned** reset authority key. A reset authority key a
    /// client learns from the log is a key the log chooses, which is no
    /// authority at all (§9.1).
    pub reset_signature: Signature,
}

/// What authorizes an entry (§4.4).
///
/// The `select (EntryAuthorization.kind)` of §4.4, as a Rust enum. The wire
/// encoding is `kind` as one byte followed by the selected body, and the
/// `tls_codec` traits are hand-written because the presentation language's
/// discriminated union has no derive.
///
/// **A key change carries two signatures and neither alone is sufficient**
/// (ADR 0014). That is why [`EntryAuthorization::KeyChange`] has no constructor
/// that omits the `RotationProof`: the outgoing signature stops the log operator
/// from swapping a key, and the incoming signature stops a stolen or
/// mis-transcribed new key from being installed without proof of possession.
/// Neither is optional, and there is no representation of a key change carrying
/// only one.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum EntryAuthorization {
    /// `same_key`: one signature, by the `directory_auth_pk` **published in the
    /// previous entry**.
    SameKey {
        /// Ed25519 over `tls_codec(DirectoryEntryTBS)`.
        auth_signature: Signature,
    },
    /// `key_change`: a `RotationProof` by the outgoing ISK, **plus** a signature
    /// by the `directory_auth_pk` in **this** entry.
    KeyChange {
        /// Signed by the outgoing `identity_pk`.
        rotation: RotationProof,
        /// Ed25519 over `tls_codec(DirectoryEntryTBS)` by the new
        /// `directory_auth_pk`.
        auth_signature: Signature,
    },
    /// `platform_reset`: a `ResetAuthorization` by the pinned reset authority,
    /// **plus** a signature by the `directory_auth_pk` in this entry.
    PlatformReset {
        /// Signed by the pinned reset authority key.
        reset: ResetAuthorization,
        /// Ed25519 over `tls_codec(DirectoryEntryTBS)`.
        auth_signature: Signature,
    },
}

impl EntryAuthorization {
    /// The `kind` this authorization is for. §4.4 requires it to equal
    /// `entry.kind`.
    #[must_use]
    pub const fn kind(&self) -> EntryKind {
        match self {
            Self::SameKey { .. } => EntryKind::SameKey,
            Self::KeyChange { .. } => EntryKind::KeyChange,
            Self::PlatformReset { .. } => EntryKind::PlatformReset,
        }
    }

    /// The signature over `tls_codec(DirectoryEntryTBS)`, whichever variant.
    #[must_use]
    pub const fn auth_signature(&self) -> &Signature {
        match self {
            Self::SameKey { auth_signature }
            | Self::KeyChange { auth_signature, .. }
            | Self::PlatformReset { auth_signature, .. } => auth_signature,
        }
    }
}

impl Size for EntryAuthorization {
    fn tls_serialized_len(&self) -> usize {
        let body = match self {
            Self::SameKey { auth_signature } => auth_signature.tls_serialized_len(),
            Self::KeyChange {
                rotation,
                auth_signature,
            } => rotation
                .tls_serialized_len()
                .saturating_add(auth_signature.tls_serialized_len()),
            Self::PlatformReset {
                reset,
                auth_signature,
            } => reset
                .tls_serialized_len()
                .saturating_add(auth_signature.tls_serialized_len()),
        };
        body.saturating_add(1)
    }
}

impl SerializeBytes for EntryAuthorization {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        let mut out = vec![self.kind().code()];
        match self {
            Self::SameKey { auth_signature } => {
                out.extend_from_slice(&auth_signature.tls_serialize_bytes()?);
            }
            Self::KeyChange {
                rotation,
                auth_signature,
            } => {
                out.extend_from_slice(&rotation.tls_serialize_bytes()?);
                out.extend_from_slice(&auth_signature.tls_serialize_bytes()?);
            }
            Self::PlatformReset {
                reset,
                auth_signature,
            } => {
                out.extend_from_slice(&reset.tls_serialize_bytes()?);
                out.extend_from_slice(&auth_signature.tls_serialize_bytes()?);
            }
        }
        Ok(out)
    }
}

impl DeserializeBytes for EntryAuthorization {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (kind, rest) = EntryKind::tls_deserialize_bytes(bytes)?;
        match kind {
            EntryKind::SameKey => {
                let (auth_signature, rest) = Signature::tls_deserialize_bytes(rest)?;
                Ok((Self::SameKey { auth_signature }, rest))
            }
            EntryKind::KeyChange => {
                let (rotation, rest) = RotationProof::tls_deserialize_bytes(rest)?;
                let (auth_signature, rest) = Signature::tls_deserialize_bytes(rest)?;
                Ok((
                    Self::KeyChange {
                        rotation,
                        auth_signature,
                    },
                    rest,
                ))
            }
            EntryKind::PlatformReset => {
                let (reset, rest) = ResetAuthorization::tls_deserialize_bytes(rest)?;
                let (auth_signature, rest) = Signature::tls_deserialize_bytes(rest)?;
                Ok((
                    Self::PlatformReset {
                        reset,
                        auth_signature,
                    },
                    rest,
                ))
            }
        }
    }
}

/// The `DirectoryEntryTBS` of §4.1 — what the user's `DirectoryAuthKey` signs.
///
/// Note what is **not** in it: no display name, no avatar, no profile field, no
/// relay list beyond contact endpoints, and no `KeyPackage`. A directory entry
/// is an append-only public record that every peer of the user will fetch; every
/// field added to it is a field published forever about everyone.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DirectoryEntryTBS {
    /// Exactly `"free2z/kt/v1/entry"`.
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The log this entry belongs to (§6.1).
    pub log_id: LogId,
    /// The handle.
    pub handle: Handle,
    /// The `akd` version for this label; starts at 1 and increases by exactly 1
    /// (§4.2).
    pub entry_version: u32,
    /// What kind of change this is, and therefore what must authorize it.
    pub kind: EntryKind,
    /// `ISK.public` in force from here on.
    pub identity_pk: PublicKey,
    /// `DirectoryAuthKey.public` in force from here on (§4.4).
    pub directory_auth_pk: PublicKey,
    /// The device credentials in force.
    pub devices: VecU16<DeviceCredential>,
    /// The revocations published so far.
    pub revocations: VecU16<DeviceRevocation>,
    /// Where first contact is delivered.
    pub contact_endpoints: VecU16<ContactEndpoint>,
    /// `H("free2z/kt/v1/prev", tls_codec(previous DirectoryEntry))`; all-zero at
    /// `entry_version` 1 (§4.2).
    pub prev_entry_hash: Digest,
    /// ADR 0014's opt-out: 1 means the platform reset path does not apply to
    /// this handle, ever.
    pub no_reset: u8,
    /// The **submitter's** clock. Signed, therefore authenticated; not
    /// trustworthy. Ordering is established by `entry_version` and by the epoch
    /// the entry appears in, never by this field (§4.2).
    pub created_at_ms: u64,
}

impl DirectoryEntryTBS {
    /// Check every invariant a `tls_codec` decode cannot express.
    ///
    /// This is shape only. It says nothing about whether the entry is
    /// **authorized** — that is [`crate::submit::validate_submission`], and the
    /// distinction is §4.4's central point.
    ///
    /// # Errors
    ///
    /// - [`KtError::WrongLabel`] if `label` is not `"free2z/kt/v1/entry"`.
    /// - [`KtError::UnsupportedVersion`] if `kt_version` is not [`KT_VERSION`].
    /// - [`KtError::BadHandle`] if `handle` is outside the charset, or if a
    ///   device credential names a different handle.
    /// - [`KtError::VersionConflict`] if `entry_version` is 0, or if the
    ///   all-zero `prev_entry_hash` rule of §4.2 is broken in either direction.
    /// - [`KtError::Malformed`] for a bad `no_reset`, an inner structure that
    ///   fails its own `validate`, or two credentials sharing a `device_pk`.
    pub fn validate(&self) -> Result<(), KtError> {
        // §6.2: the label first, before anything else.
        check_label(&self.label, LABEL_ENTRY)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        self.handle.validate()?;

        // §4.2: versions start at 1. Version 0 has no meaning in `akd` either.
        if self.entry_version == 0 {
            return Err(KtError::VersionConflict);
        }
        // §4.2: "all-zero at entry_version 1". Read as an iff — a version-1
        // entry with a non-zero predecessor hash claims a history that cannot
        // exist, and a later entry with an all-zero one claims to be a genesis
        // it is not. Both are rejected here rather than left to the submission
        // path, because both are self-contradictory on the bytes alone.
        if (self.entry_version == 1) != self.prev_entry_hash.is_zero() {
            return Err(KtError::VersionConflict);
        }

        // Invented here: ADR 0014 gives `no_reset` as a flag and KT.md §4.1 as a
        // `uint8`, with no statement about other values. Accepting 2 would mean
        // two distinct byte strings with one meaning inside a structure that is
        // hashed and signed, which is exactly what re-encode equality exists to
        // prevent elsewhere. 0 and 1 only.
        if self.no_reset > 1 {
            return Err(KtError::Malformed);
        }

        for credential in self.devices.as_slice() {
            credential.credential.validate()?;
            // A credential is self-contained (§4.1), so it *can* disagree with
            // its envelope. If it did, the MLS peers who validate it without
            // directory access and the directory clients who validate it with
            // would reach different conclusions about the same device.
            if credential.credential.handle != self.handle {
                return Err(KtError::BadHandle);
            }
        }
        // §4.4 rule 8: no two credentials share a `device_pk`. Two credentials
        // for one device key are two different validity windows and two
        // different KEM keys for the same MLS leaf.
        for (index, credential) in self.devices.as_slice().iter().enumerate() {
            for other in self.devices.as_slice().iter().skip(index.saturating_add(1)) {
                if credential.credential.device_pk == other.credential.device_pk {
                    return Err(KtError::Malformed);
                }
            }
        }

        // §4.4: one immutable revocation record per device key. Two records for
        // one key either repeat an event or disagree about its time/reason; in
        // both cases there is no canonical cumulative history to carry forward.
        for (index, revocation) in self.revocations.as_slice().iter().enumerate() {
            for other in self
                .revocations
                .as_slice()
                .iter()
                .skip(index.saturating_add(1))
            {
                if revocation.device_pk == other.device_pk {
                    return Err(KtError::Malformed);
                }
            }
        }

        for endpoint in self.contact_endpoints.as_slice() {
            endpoint.validate()?;
        }
        Ok(())
    }

    /// Whether this entry records `device_pk` as permanently revoked.
    #[must_use]
    pub fn is_revoked(&self, device_pk: &PublicKey) -> bool {
        self.revocations
            .as_slice()
            .iter()
            .any(|revocation| &revocation.device_pk == device_pk)
    }

    /// The published credential for `device_pk`, only when it is usable now.
    ///
    /// This is the shared selection rule for directory lookup and first
    /// contact: the credential must be present, inside the common validity
    /// window, and absent from the cumulative revocation set.
    #[must_use]
    pub fn active_device_at(
        &self,
        device_pk: &PublicKey,
        verifier_time_ms: u64,
    ) -> Option<&DeviceCredential> {
        if self.is_revoked(device_pk) {
            return None;
        }
        self.devices.as_slice().iter().find(|credential| {
            &credential.credential.device_pk == device_pk
                && credential.credential.validity_at(verifier_time_ms) == CredentialValidity::Valid
        })
    }

    /// Every published credential usable at `verifier_time_ms`.
    pub fn active_devices_at(
        &self,
        verifier_time_ms: u64,
    ) -> impl Iterator<Item = &DeviceCredential> {
        self.devices.as_slice().iter().filter(move |credential| {
            self.active_device_at(&credential.credential.device_pk, verifier_time_ms)
                .is_some()
        })
    }

    /// The exact bytes the `DirectoryAuthKey` signs (§4.4).
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, KtError> {
        encode(self).map_err(KtError::from)
    }
}

/// A `DirectoryEntry` (§4.1): the contents plus what authorized them.
///
/// The tree commits to `H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` —
/// **this whole structure, authorization included** — so an entry cannot be
/// re-authorized after publication (§3.3).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DirectoryEntry {
    /// The signed contents.
    pub entry: DirectoryEntryTBS,
    /// §4.4.
    pub authorization: EntryAuthorization,
}

impl DirectoryEntry {
    /// Shape validation, including §4.4's `authorization.kind == entry.kind`.
    ///
    /// # Errors
    ///
    /// As [`DirectoryEntryTBS::validate`], plus [`KtError::BadAuthorization`] if
    /// the two kinds disagree, and [`KtError::WrongLabel`] /
    /// [`KtError::BadHandle`] from the inner proof structures.
    pub fn validate(&self) -> Result<(), KtError> {
        self.entry.validate()?;
        // §4.4 rule 5, first half. The kind is encoded twice — once in the
        // contents the user signed and once in the authorization envelope — and
        // a mismatch means the bytes that were signed describe a different
        // operation from the one being performed.
        if self.authorization.kind() != self.entry.kind {
            return Err(KtError::BadAuthorization);
        }
        match &self.authorization {
            EntryAuthorization::SameKey { .. } => {}
            EntryAuthorization::KeyChange { rotation, .. } => rotation.proof.validate()?,
            EntryAuthorization::PlatformReset { reset, .. } => reset.reset.validate()?,
        }
        Ok(())
    }

    /// `H("free2z/kt/v1/prev", tls_codec(self))` — what the **next** entry's
    /// `prev_entry_hash` must equal (§4.2).
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the structure cannot be encoded.
    pub fn chain_hash(&self) -> Result<Digest, KtError> {
        Ok(prev_entry_hash(&self.encode_canonical()?))
    }
}

/// Build a `<0..255>` label field for a `DirectoryEntryTBS`.
///
/// # Errors
///
/// [`KtError::Malformed`] if the constant does not fit, which it does.
pub fn entry_label() -> Result<ShortBytes, KtError> {
    label_field(LABEL_ENTRY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{TestDirectory, signing_key};
    use f2z_codec::canonical::decode_canonical;

    #[test]
    fn entry_kind_rejects_a_value_this_build_does_not_know() {
        assert_eq!(EntryKind::from_code(0), Err(KtError::Malformed));
        assert_eq!(EntryKind::from_code(4), Err(KtError::Malformed));
        assert_eq!(EntryKind::from_code(255), Err(KtError::Malformed));
        for kind in EntryKind::ALL {
            assert_eq!(EntryKind::from_code(kind.code()), Ok(kind));
        }
    }

    #[test]
    fn an_entry_round_trips_under_re_encode_equality() {
        let directory = TestDirectory::new();
        let entry = directory.genesis();
        let bytes = entry.encode_canonical().unwrap();
        let decoded = decode_canonical::<DirectoryEntry>(&bytes).unwrap();
        assert_eq!(decoded.value(), &entry);
        assert_eq!(decoded.bytes(), bytes.as_slice());

        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode_canonical::<DirectoryEntry>(&trailing).is_err());
    }

    #[test]
    fn every_authorization_variant_round_trips() {
        let directory = TestDirectory::new();
        let genesis = directory.genesis();
        let rotated = directory.key_change(&genesis, &signing_key(40), &signing_key(41));
        let reset = directory.platform_reset(&genesis, &signing_key(50), &signing_key(51), 0);
        for entry in [genesis, rotated, reset] {
            let bytes = entry.encode_canonical().unwrap();
            assert_eq!(
                decode_canonical::<DirectoryEntry>(&bytes).unwrap().value(),
                &entry
            );
        }
    }

    #[test]
    fn an_unknown_kind_byte_fails_to_decode_rather_than_defaulting() {
        let directory = TestDirectory::new();
        let mut bytes = directory.genesis().encode_canonical().unwrap();
        // The `kind` byte inside DirectoryEntryTBS: label(1+18) + kt_version(2)
        // + log_id(32) + handle(1+5) + entry_version(4) = 63.
        let offset = 1 + LABEL_ENTRY.len() + 2 + 32 + 1 + 5 + 4;
        assert_eq!(bytes.get(offset), Some(&EntryKind::SameKey.code()));
        if let Some(byte) = bytes.get_mut(offset) {
            *byte = 9;
        }
        assert!(decode_canonical::<DirectoryEntry>(&bytes).is_err());
    }

    #[test]
    fn shape_validation_catches_what_the_decoder_cannot() {
        let directory = TestDirectory::new();

        let mut entry = directory.genesis();
        entry.entry.no_reset = 2;
        assert_eq!(entry.entry.validate(), Err(KtError::Malformed));

        let mut entry = directory.genesis();
        entry.entry.kt_version = 2;
        assert_eq!(entry.entry.validate(), Err(KtError::UnsupportedVersion));

        let mut entry = directory.genesis();
        entry.entry.label = ShortBytes::new(b"free2z/kt/v1/sth".to_vec()).unwrap();
        assert_eq!(entry.entry.validate(), Err(KtError::WrongLabel));

        // §4.2's all-zero rule, both directions.
        let mut entry = directory.genesis();
        entry.entry.prev_entry_hash = Digest::new([7u8; 32]);
        assert_eq!(entry.entry.validate(), Err(KtError::VersionConflict));

        let mut entry = directory.genesis();
        entry.entry.entry_version = 2;
        assert_eq!(entry.entry.validate(), Err(KtError::VersionConflict));
    }

    #[test]
    fn two_credentials_for_one_device_key_are_refused() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        let credential = entry
            .entry
            .devices
            .as_slice()
            .first()
            .expect("the genesis entry has one device")
            .clone();
        entry.entry.devices = VecU16::new(vec![credential.clone(), credential]);
        assert_eq!(entry.entry.validate(), Err(KtError::Malformed));
    }

    #[test]
    fn credential_time_boundaries_include_exactly_the_fixed_skew() {
        let directory = TestDirectory::new();
        let entry = directory.genesis();
        let mut credential = entry.entry.devices.as_slice()[0].credential.clone();
        credential.not_before_ms = 1_000_000;
        credential.not_after_ms = 2_000_000;
        let skew = DEVICE_CREDENTIAL_CLOCK_SKEW_MS;

        assert_eq!(
            credential.validity_at(credential.not_before_ms - skew - 1),
            CredentialValidity::NotYetValid
        );
        assert_eq!(
            credential.validity_at(credential.not_before_ms - skew),
            CredentialValidity::Valid
        );
        assert_eq!(
            credential.validity_at(credential.not_before_ms),
            CredentialValidity::Valid
        );
        assert_eq!(
            credential.validity_at(credential.not_after_ms),
            CredentialValidity::Valid
        );
        assert_eq!(
            credential.validity_at(credential.not_after_ms + skew),
            CredentialValidity::Valid
        );
        assert_eq!(
            credential.validity_at(credential.not_after_ms + skew + 1),
            CredentialValidity::Expired
        );
    }

    #[test]
    fn empty_or_inverted_credential_intervals_are_malformed() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        let mut devices = entry.entry.devices.clone().into_vec();
        devices[0].credential.not_after_ms = devices[0].credential.not_before_ms;
        entry.entry.devices = VecU16::new(devices.clone());
        assert_eq!(entry.entry.validate(), Err(KtError::Malformed));

        devices[0].credential.not_after_ms = devices[0].credential.not_before_ms.saturating_sub(1);
        entry.entry.devices = VecU16::new(devices);
        assert_eq!(entry.entry.validate(), Err(KtError::Malformed));
    }

    #[test]
    fn duplicate_or_contradictory_revocations_are_malformed() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        let device_pk = entry.entry.devices.as_slice()[0].credential.device_pk;
        let first = DeviceRevocation {
            device_pk,
            revoked_at_ms: 1_700_000_000_000,
            reason: ShortBytes::new(b"lost".to_vec()).unwrap(),
        };
        let contradictory = DeviceRevocation {
            device_pk,
            revoked_at_ms: first.revoked_at_ms + 1,
            reason: ShortBytes::new(b"stolen".to_vec()).unwrap(),
        };
        entry.entry.revocations = VecU16::new(vec![first, contradictory]);
        assert_eq!(entry.entry.validate(), Err(KtError::Malformed));
    }

    #[test]
    fn active_device_selection_combines_lifetime_and_revocation() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        let device_pk = entry.entry.devices.as_slice()[0].credential.device_pk;
        let inside = entry.entry.devices.as_slice()[0].credential.not_before_ms;
        assert!(entry.entry.active_device_at(&device_pk, inside).is_some());
        assert_eq!(entry.entry.active_devices_at(inside).count(), 1);

        entry.entry.revocations = VecU16::new(vec![DeviceRevocation {
            device_pk,
            revoked_at_ms: inside,
            reason: ShortBytes::new(b"compromised".to_vec()).unwrap(),
        }]);
        assert!(entry.entry.active_device_at(&device_pk, inside).is_none());
        assert_eq!(entry.entry.active_devices_at(inside).count(), 0);

        entry.entry.revocations = VecU16::new(Vec::new());
        let expired = entry.entry.devices.as_slice()[0]
            .credential
            .not_after_ms
            .saturating_add(DEVICE_CREDENTIAL_CLOCK_SKEW_MS)
            .saturating_add(1);
        assert!(entry.entry.active_device_at(&device_pk, expired).is_none());
    }

    #[test]
    fn a_credential_naming_another_handle_is_refused() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        if let Some(credential) = entry.entry.devices.as_slice().first() {
            let mut credential = credential.clone();
            credential.credential.handle = Handle::new(b"mallory".to_vec()).unwrap();
            entry.entry.devices = VecU16::new(vec![credential]);
        }
        assert_eq!(entry.entry.validate(), Err(KtError::BadHandle));
    }

    #[test]
    fn a_kind_that_disagrees_with_its_authorization_is_refused() {
        let directory = TestDirectory::new();
        let mut entry = directory.genesis();
        entry.entry.kind = EntryKind::KeyChange;
        assert_eq!(entry.validate(), Err(KtError::BadAuthorization));
    }
}
