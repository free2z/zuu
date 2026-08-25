//! `DeviceCredential` — the identity→device binding, carried as the MLS
//! `Credential` so every peer validates it during ordinary MLS processing.
//!
//! `ARCHITECTURE.md` §4.2 defines it:
//!
//! ```text
//! DeviceCredential = {
//!   type:          "free2z/device-credential/v1",
//!   identity_pk:   ISK.public,
//!   handle:        "@alice",
//!   device_pk:     DSK.public,
//!   device_kem_pk: DeviceInitKey.public,
//!   not_before, not_after,
//!   signature:     Sign(ISK, canonical(everything above))
//! }
//! ```
//!
//! # Coordination note: this belongs in `f2z-msg-identity`
//!
//! §4.2's key hierarchy — `MSK`, `account_node`, `IdentitySigningKey`,
//! `CeremonySigningKey`, `DirectoryAuthKey`, `BackupWrapKey` — is a sibling
//! crate being written in parallel. **This module is the minimum this engine
//! needs and no more**: it does not derive anything, it holds no seed, and it
//! knows nothing about ZIP 32. When `f2z-msg-identity` lands, this type moves
//! there and this module becomes a re-export; the encoding below is the
//! interface to match, and it is deliberately the one §4.2 specifies rather
//! than a convenience of this crate.
//!
//! What this crate genuinely owns is [`DeviceCredential::validate_for_leaf`] —
//! the check that the credential describes *this* leaf's signature key. That is
//! an MLS-side obligation and stays here wherever the type lives.
//!
//! # Why `CredentialType::Basic`
//!
//! RFC 9420's `BasicCredential` carries an opaque, application-defined identity
//! string, which is exactly what this is. The alternative — a private-use
//! `CredentialType` — would additionally require every member's `Capabilities`
//! to advertise that type, and buys nothing: a peer sending a *bare* handle in
//! a `BasicCredential` fails [`DeviceCredential::parse`] on the leading type tag
//! ([`CredentialError::WrongType`]), so a plain basic credential is rejected
//! either way. The credential type is recorded next to the group by
//! [`ProtocolVersion`](crate::ProtocolVersion), so moving to a registered
//! codepoint later is a migration rather than a fork.
//!
//! # Encoding
//!
//! `tls_codec`, like every other free2z wire structure (`WIRE.md` §1.2), so
//! that "re-encode and compare" is one operation everywhere in this tree. The
//! signature covers the encoding of [`DeviceCredentialTbs`] and nothing else,
//! so the boundary between "signed" and "not signed" is a type boundary rather
//! than a comment.
//!
//! # `Debug`
//!
//! Hand-written, and the trap is decimal: `tls_codec`'s byte vectors derive
//! `Debug` and print a full **decimal** byte list containing no hex at all, so
//! a redaction test that greps for hex passes while everything leaks. See
//! `f2z-codec`'s `tests/redaction.rs`; `tests/redaction.rs` here checks both.

use tls_codec::{DeserializeBytes, SerializeBytes, TlsByteVecU8, TlsByteVecU16};

use crate::error::CredentialError;
use crate::signer::{PUBLIC_LEN, SIGNATURE_LEN, verify};

/// The type tag every `DeviceCredential` starts with.
///
/// A `free2z/` label, swept by `scripts/check-hash-domain-labels.mjs` along with
/// every other label in the tree. It is leafless — `free2z/device-credential/v1`
/// with no `/leaf` — which is the sharpest shape the prefix-free rule exists
/// for, and the checker's own prose names this exact label as one it judges.
pub const DEVICE_CREDENTIAL_TYPE: &[u8] = b"free2z/device-credential/v1";

/// The longest handle `CLIENT-CONTRACT.md` §3.2 admits: 30 characters after
/// lowercasing.
pub const MAX_HANDLE_LEN: usize = 30;

/// The part of a [`DeviceCredential`] the identity key signs.
///
/// A separate type on purpose: the signature covers this encoding exactly, so
/// "what is signed" is decided by the struct definition rather than by a
/// serialisation function that could quietly stop including a field.
#[derive(Clone, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DeviceCredentialTbs {
    /// Always [`DEVICE_CREDENTIAL_TYPE`]. Carried on the wire rather than
    /// assumed, so a credential from a future revision is *rejected* rather
    /// than misread as this one.
    kind: TlsByteVecU8,
    /// `IdentitySigningKey.public` — the long-term account key (§4.2).
    identity_pk: TlsByteVecU8,
    /// The messaging handle, lowercase ASCII (§3.2's `HandleEligibility`).
    handle: TlsByteVecU8,
    /// `DeviceSignatureKey.public` — the MLS leaf `signature_key` (RFC 9420
    /// §7.2). The binding target.
    device_pk: TlsByteVecU8,
    /// `DeviceInitKey.public` — the X-Wing hybrid HPKE init key. 1216 bytes,
    /// hence the `u16` length prefix.
    device_kem_pk: TlsByteVecU16,
    /// Validity start, milliseconds since the Unix epoch.
    not_before: u64,
    /// Validity end, milliseconds since the Unix epoch.
    not_after: u64,
}

/// A signed identity→device binding.
#[derive(Clone, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct DeviceCredential {
    tbs: DeviceCredentialTbs,
    /// `Sign(IdentitySigningKey, canonical(tbs))`, 64 bytes.
    signature: TlsByteVecU8,
}

impl core::fmt::Debug for DeviceCredentialTbs {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // The handle is the one field that is *meant* to be human-readable and
        // is public by construction — it is what a peer looks up in the
        // directory. Everything else renders as a length.
        f.debug_struct("DeviceCredentialTbs")
            .field("handle", &String::from_utf8_lossy(self.handle.as_slice()))
            .field(
                "identity_pk",
                &format_args!("<redacted; {} bytes>", self.identity_pk.as_slice().len()),
            )
            .field(
                "device_pk",
                &format_args!("<redacted; {} bytes>", self.device_pk.as_slice().len()),
            )
            .field(
                "device_kem_pk",
                &format_args!("<redacted; {} bytes>", self.device_kem_pk.as_slice().len()),
            )
            .field("not_before", &self.not_before)
            .field("not_after", &self.not_after)
            .finish()
    }
}

impl core::fmt::Debug for DeviceCredential {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DeviceCredential")
            .field("tbs", &self.tbs)
            .field(
                "signature",
                &format_args!("<redacted; {} bytes>", self.signature.as_slice().len()),
            )
            .finish()
    }
}

impl DeviceCredentialTbs {
    /// Build the signed body.
    ///
    /// # Errors
    ///
    /// [`CredentialError::InvalidHandle`] if the handle is not one
    /// `CLIENT-CONTRACT.md` §3.2 admits.
    pub fn new(
        identity_pk: &[u8; PUBLIC_LEN],
        handle: &str,
        device_pk: &[u8; PUBLIC_LEN],
        device_kem_pk: &[u8],
        not_before: u64,
        not_after: u64,
    ) -> Result<Self, CredentialError> {
        check_handle(handle.as_bytes())?;
        Ok(Self {
            kind: DEVICE_CREDENTIAL_TYPE.into(),
            identity_pk: identity_pk.as_slice().into(),
            handle: handle.as_bytes().into(),
            device_pk: device_pk.as_slice().into(),
            device_kem_pk: device_kem_pk.into(),
            not_before,
            not_after,
        })
    }

    /// The exact bytes the identity key signs.
    ///
    /// # Errors
    ///
    /// [`CredentialError::Malformed`] if the body could not be encoded, which
    /// only a field exceeding its length prefix can cause.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, CredentialError> {
        self.tls_serialize().map_err(|_| CredentialError::Malformed)
    }

    /// The handle, as bytes. Public by construction — it is what a peer looks
    /// up in the directory.
    #[must_use]
    pub fn handle(&self) -> &[u8] {
        self.handle.as_slice()
    }

    /// `IdentitySigningKey.public`.
    #[must_use]
    pub fn identity_pk(&self) -> &[u8] {
        self.identity_pk.as_slice()
    }

    /// `DeviceSignatureKey.public` — the MLS leaf `signature_key`.
    #[must_use]
    pub fn device_pk(&self) -> &[u8] {
        self.device_pk.as_slice()
    }

    /// `DeviceInitKey.public`.
    #[must_use]
    pub fn device_kem_pk(&self) -> &[u8] {
        self.device_kem_pk.as_slice()
    }
}

impl DeviceCredential {
    /// Sign a body with an identity key.
    ///
    /// The signer is passed as raw bytes rather than as a type because the
    /// `IdentitySigningKey` belongs to `f2z-msg-identity` — see the module
    /// note. This crate signs with whatever that crate hands it and never holds
    /// a seed.
    ///
    /// # Errors
    ///
    /// [`CredentialError::Malformed`] if the body could not be encoded,
    /// [`CredentialError::BadSignature`] if libcrux refused to sign.
    pub fn sign(
        tbs: DeviceCredentialTbs,
        identity_private_key: &[u8; 32],
    ) -> Result<Self, CredentialError> {
        let signing_bytes = tbs.signing_bytes()?;
        let signature = libcrux_ed25519::sign(&signing_bytes, identity_private_key)
            .map_err(|_| CredentialError::BadSignature)?;
        Ok(Self {
            tbs,
            signature: signature.as_slice().into(),
        })
    }

    /// Parse a credential out of an MLS `BasicCredential` identity string.
    ///
    /// # Errors
    ///
    /// [`CredentialError::Malformed`] if the bytes are not a credential at all
    /// or carry trailing data, and [`CredentialError::WrongType`] if the
    /// leading type tag is not [`DEVICE_CREDENTIAL_TYPE`].
    pub fn parse(bytes: &[u8]) -> Result<Self, CredentialError> {
        let (credential, rest) =
            Self::tls_deserialize_bytes(bytes).map_err(|_| CredentialError::Malformed)?;
        if !rest.is_empty() {
            // Trailing bytes are a different credential that happens to start
            // like this one. Refusing them is the same rule `WIRE.md` §3.3
            // applies to every frame: exactly one encoding, or nothing.
            return Err(CredentialError::Malformed);
        }
        if credential.tbs.kind.as_slice() != DEVICE_CREDENTIAL_TYPE {
            return Err(CredentialError::WrongType);
        }
        Ok(credential)
    }

    /// The credential's encoding, for the MLS `BasicCredential` identity field.
    ///
    /// # Errors
    ///
    /// [`CredentialError::Malformed`] if it could not be encoded.
    pub fn to_bytes(&self) -> Result<Vec<u8>, CredentialError> {
        self.tls_serialize().map_err(|_| CredentialError::Malformed)
    }

    /// The signed body.
    #[must_use]
    pub const fn tbs(&self) -> &DeviceCredentialTbs {
        &self.tbs
    }

    /// Check everything about this credential that can be checked from the
    /// credential alone: the type tag, the handle, the identity signature and
    /// the validity window.
    ///
    /// This is **not sufficient**. A credential that passes every check here
    /// and describes somebody else's device is exactly the substitution the
    /// binding exists to stop — use [`DeviceCredential::validate_for_leaf`],
    /// which does this and then checks the binding.
    ///
    /// # Errors
    ///
    /// A [`CredentialError`] naming the check that failed.
    pub fn validate(&self, now_ms: u64) -> Result<(), CredentialError> {
        if self.tbs.kind.as_slice() != DEVICE_CREDENTIAL_TYPE {
            return Err(CredentialError::WrongType);
        }
        check_handle(self.tbs.handle.as_slice())?;

        if now_ms < self.tbs.not_before || now_ms > self.tbs.not_after {
            return Err(CredentialError::Expired);
        }

        let identity_pk: &[u8; PUBLIC_LEN] = self
            .tbs
            .identity_pk
            .as_slice()
            .try_into()
            .map_err(|_| CredentialError::Malformed)?;
        let signature: &[u8; SIGNATURE_LEN] = self
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| CredentialError::Malformed)?;

        let signing_bytes = self.tbs.signing_bytes()?;
        verify(&signing_bytes, identity_pk, signature).map_err(|_| CredentialError::BadSignature)
    }

    /// [`DeviceCredential::validate`], **and** the binding: that this
    /// credential's `device_pk` is the leaf's MLS `signature_key`.
    ///
    /// The order matters and is deliberate. The signature is checked before the
    /// binding, so a credential whose `device_pk` was edited to match a leaf
    /// fails on the signature rather than reaching the comparison — and the
    /// caller therefore never sees `DeviceKeyMismatch` for a forgery, only for
    /// a genuine credential presented on the wrong leaf.
    ///
    /// # Errors
    ///
    /// A [`CredentialError`] naming the check that failed;
    /// [`CredentialError::DeviceKeyMismatch`] if the binding does not hold.
    pub fn validate_for_leaf(
        &self,
        leaf_signature_key: &[u8],
        now_ms: u64,
    ) -> Result<(), CredentialError> {
        self.validate(now_ms)?;
        if self.tbs.device_pk.as_slice() != leaf_signature_key {
            return Err(CredentialError::DeviceKeyMismatch);
        }
        Ok(())
    }
}

/// `CLIENT-CONTRACT.md` §3.2's `HandleEligibility`, applied to bytes.
///
/// Lowercase ASCII alphanumeric and `_`, non-empty, at most
/// [`MAX_HANDLE_LEN`]. §3.2 lists the *reasons* a handle is ineligible —
/// punctuation, non-ASCII, over-length — because they differ wildly in
/// prevalence and the UI must say the true specific thing. This function is the
/// engine's side of the same rule and only has to answer yes or no: by the time
/// a credential exists, an ineligible handle is an attack or a bug, not a user
/// typing their username.
fn check_handle(handle: &[u8]) -> Result<(), CredentialError> {
    if handle.is_empty() || handle.len() > MAX_HANDLE_LEN {
        return Err(CredentialError::InvalidHandle);
    }
    if !handle
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
    {
        return Err(CredentialError::InvalidHandle);
    }
    Ok(())
}

// `tls_codec`'s derive macros are brought in by name so the `use` above stays a
// list of what this module actually references.
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signer::DeviceSigner;

    const NOW: u64 = 1_700_000_000_000;

    fn identity() -> ([u8; 32], [u8; 32]) {
        let private = [11u8; 32];
        let mut public = [0u8; 32];
        libcrux_ed25519::secret_to_public(&mut public, &private);
        (private, public)
    }

    fn credential() -> (DeviceCredential, DeviceSigner) {
        let (identity_private, identity_public) = identity();
        let device = DeviceSigner::from_private_key([22u8; 32]);
        let tbs = DeviceCredentialTbs::new(
            &identity_public,
            "alice",
            device.public_key(),
            &[0x5A; 1216],
            NOW - 1000,
            NOW + 1000,
        )
        .unwrap();
        (
            DeviceCredential::sign(tbs, &identity_private).unwrap(),
            device,
        )
    }

    #[test]
    fn a_credential_round_trips_through_its_encoding() {
        let (credential, _) = credential();
        let bytes = credential.to_bytes().unwrap();
        let parsed = DeviceCredential::parse(&bytes).unwrap();
        assert_eq!(parsed, credential);
        assert_eq!(parsed.to_bytes().unwrap(), bytes);
    }

    #[test]
    fn a_valid_credential_validates_against_its_own_leaf_key() {
        let (credential, device) = credential();
        credential
            .validate_for_leaf(device.public_key(), NOW)
            .unwrap();
    }

    #[test]
    fn a_credential_presented_on_another_leaf_is_rejected() {
        let (credential, _) = credential();
        let other = DeviceSigner::from_private_key([33u8; 32]);
        assert_eq!(
            credential.validate_for_leaf(other.public_key(), NOW),
            Err(CredentialError::DeviceKeyMismatch)
        );
    }

    /// A forgery that edits `device_pk` to match a leaf must fail on the
    /// *signature*, not on the binding — see `validate_for_leaf`'s note.
    #[test]
    fn editing_the_device_key_breaks_the_signature_before_it_breaks_the_binding() {
        let (credential, _) = credential();
        let attacker = DeviceSigner::from_private_key([44u8; 32]);

        let mut forged = credential.clone();
        forged.tbs.device_pk = attacker.public_key().as_slice().into();

        assert_eq!(
            forged.validate_for_leaf(attacker.public_key(), NOW),
            Err(CredentialError::BadSignature)
        );
    }

    #[test]
    fn a_credential_outside_its_validity_window_is_rejected() {
        let (credential, device) = credential();
        assert_eq!(
            credential.validate_for_leaf(device.public_key(), NOW - 100_000),
            Err(CredentialError::Expired)
        );
        assert_eq!(
            credential.validate_for_leaf(device.public_key(), NOW + 100_000),
            Err(CredentialError::Expired)
        );
    }

    #[test]
    fn a_bare_handle_in_a_basic_credential_is_not_a_device_credential() {
        assert!(matches!(
            DeviceCredential::parse(b"alice"),
            Err(CredentialError::Malformed | CredentialError::WrongType)
        ));
    }

    #[test]
    fn trailing_bytes_are_refused() {
        let (credential, _) = credential();
        let mut bytes = credential.to_bytes().unwrap();
        bytes.push(0);
        assert_eq!(
            DeviceCredential::parse(&bytes),
            Err(CredentialError::Malformed)
        );
    }

    #[test]
    fn ineligible_handles_are_refused_at_construction() {
        let (_, identity_public) = identity();
        let device = DeviceSigner::from_private_key([22u8; 32]);
        for handle in [
            "",
            "Alice",
            "al.ice",
            "al-ice",
            "al@ice",
            "ålice",
            &"a".repeat(31),
        ] {
            assert_eq!(
                DeviceCredentialTbs::new(
                    &identity_public,
                    handle,
                    device.public_key(),
                    &[0; 1216],
                    0,
                    u64::MAX,
                )
                .err(),
                Some(CredentialError::InvalidHandle),
                "handle {handle:?} should have been refused"
            );
        }
    }

    #[test]
    fn debug_prints_the_handle_and_no_key_in_hex_or_decimal() {
        let (credential, _) = credential();
        let rendered = format!("{credential:?}");
        assert!(rendered.contains("alice"), "{rendered}");
        // The KEM key is 0x5A repeated: hex `5a5a`, decimal `90, 90`.
        assert!(!rendered.contains("5a5a"), "{rendered}");
        assert!(!rendered.contains("90, 90"), "{rendered}");
        assert!(rendered.contains("<redacted; 1216 bytes>"), "{rendered}");
    }
}
