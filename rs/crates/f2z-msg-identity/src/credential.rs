//! `DeviceCredential` issuance — `ARCHITECTURE.md` §4.2, encoded by `KT.md`
//! §4.1.
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
//! This is the join between the two halves of §4.2 — the seed-derived account
//! and the CSPRNG-generated device — and it is carried as the MLS `Credential`
//! in the member's `LeafNode`, so **every MLS peer validates the
//! identity→device binding as part of ordinary MLS processing**, with no
//! directory access at all.
//!
//! # There is exactly one definition of these bytes, and it is not here
//!
//! [`DeviceCredentialTBS`] is `f2z-kt-core`'s, re-exported rather than
//! restated, and the signature covers `f2z-codec`'s canonical encoding of it —
//! the same `encode` the log's validator re-runs. That is deliberate to the
//! point of being the design: a construction crate that owned its *own* copy of
//! the structure would be one field-order edit away from issuing credentials
//! the directory rejects, and the failure would land on users rather than on
//! CI. `tests/kt_core_agreement.rs` puts a credential issued here through
//! `f2z_kt_core::validate_submission` and is the acceptance test for #311's
//! client half.
//!
//! # What this module refuses to build
//!
//! `KT.md` §4.1's `validate` rules are checked at *issuance*, not only at
//! submission: an empty `device_kem_pk`, a handle outside `[a-z0-9_]{1,30}`, or
//! a validity window that is empty or inverted. A credential that can never be
//! valid at any instant is one an MLS peer would reject after it had already
//! been published to an append-only log, and an append-only log is a bad place
//! to discover a typo.

use ed25519_dalek::Signer as _;
use f2z_codec::types::{ShortBytes, Signature};
use f2z_kt_core::entry::{DeviceCredential, DeviceCredentialTBS};
use f2z_kt_core::labels::LABEL_DEVICE_CREDENTIAL;
use f2z_kt_core::types::{Handle, KemPublicKey};

use crate::account::IdentitySigningKey;
use crate::error::IdentityError;

/// What the caller supplies about a device, before the identity key binds it.
///
/// A struct rather than five positional arguments: `device_pk` and
/// `device_kem_pk` are both keys and `not_before_ms` and `not_after_ms` are
/// both `u64`, so a positional call is two silent transpositions waiting to
/// happen — and a transposed validity window is a credential that is valid
/// never, while transposed keys are a credential that binds the wrong device.
#[derive(Clone, Debug)]
pub struct DeviceCredentialRequest {
    /// The handle this device speaks for, `[a-z0-9_]{1,30}` (`WIRE.md` §14).
    ///
    /// Without the `@`: `KT.md` §4.1 declares `opaque handle<1..30>` over the
    /// charset, and the `@` in `ARCHITECTURE.md` §4.2's `"@alice"` is display
    /// sugar. [`Handle`] enforces the charset, so a `@` cannot reach the bytes.
    pub handle: Handle,
    /// `DSK.public` — the MLS leaf `signature_key`.
    pub device_pk: f2z_codec::types::PublicKey,
    /// The X-Wing hybrid public key, as opaque bytes.
    ///
    /// Opaque here, and opaque in `KT.md` §4.1's `<1..2^16-1>`, because the
    /// party that interprets it is the MLS layer's HPKE implementation. See
    /// [`crate::device`] for why this crate does not generate it.
    pub device_kem_pk: KemPublicKey,
    /// Validity start, milliseconds since the Unix epoch.
    ///
    /// This crate has no clock — it is `no_std` with no I/O — so the window is
    /// the caller's to choose, and `KT.md` §4.1's only structural rule is that
    /// it is non-empty and forward-ordered.
    pub not_before_ms: u64,
    /// Validity end, milliseconds since the Unix epoch. Must be strictly after
    /// [`DeviceCredentialRequest::not_before_ms`].
    pub not_after_ms: u64,
}

impl IdentitySigningKey {
    /// Issue and sign a `DeviceCredential` binding this identity to a device.
    ///
    /// `identity_pk` is taken from *this* key rather than from the request, so
    /// the credential cannot claim an identity its signer does not hold —
    /// `f2z-kt-core`'s §4.4 rule 8 requires `credential.identity_pk` to equal
    /// the entry's `identity_pk` and the signature to verify under it, and a
    /// request that could carry its own `identity_pk` would be a way to build a
    /// credential that fails that rule at submission time instead of here.
    ///
    /// # Errors
    ///
    /// [`IdentityError::MalformedCredential`] if the request violates `KT.md`
    /// §4.1 — an empty KEM key, a handle outside the charset, or a validity
    /// window that is empty or inverted — or if the structure cannot be
    /// encoded.
    pub fn issue_device_credential(
        &self,
        request: &DeviceCredentialRequest,
    ) -> Result<DeviceCredential, IdentityError> {
        let credential = DeviceCredentialTBS {
            // §4.1: "exactly `free2z/device-credential/v1`", and the one label
            // in the protocol that is not under `free2z/kt/v1/` — a
            // `DeviceCredential` is validated by MLS peers who are not
            // key-transparency clients, so it does not carry the directory's
            // version.
            label: ShortBytes::new(LABEL_DEVICE_CREDENTIAL.to_vec())
                .map_err(|_| IdentityError::MalformedCredential)?,
            identity_pk: self.public(),
            handle: request.handle.clone(),
            device_pk: request.device_pk,
            device_kem_pk: request.device_kem_pk.clone(),
            not_before_ms: request.not_before_ms,
            not_after_ms: request.not_after_ms,
        };

        // The log's own rules, run before anything is signed rather than after
        // it is published. See the module note.
        credential
            .validate()
            .map_err(|_| IdentityError::MalformedCredential)?;

        Ok(DeviceCredential {
            signature: self.sign_credential_bytes(
                &credential
                    .signing_bytes()
                    .map_err(|_| IdentityError::MalformedCredential)?,
            ),
            credential,
        })
    }

    /// Sign the canonical `DeviceCredentialTBS` bytes.
    ///
    /// Private, and takes bytes that [`IdentitySigningKey::issue_device_credential`]
    /// has already produced from a validated structure. Exposing it would turn
    /// the identity key into a general signing oracle, which is the thing
    /// `account.rs`'s table exists to prevent.
    fn sign_credential_bytes(&self, bytes: &[u8]) -> Signature {
        Signature::new(self.signing_key().sign(bytes).to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::AccountKeys;
    use crate::device::DeviceSignatureKey;
    use f2z_codec::canonical::Canonical as _;
    use f2z_codec::types::PublicKey;

    const SEED: [u8; 64] = [0x2a; 64];

    fn request() -> DeviceCredentialRequest {
        DeviceCredentialRequest {
            handle: Handle::new(b"alice".to_vec()).unwrap(),
            device_pk: PublicKey::new([7u8; 32]),
            device_kem_pk: KemPublicKey::new(alloc::vec![0xab; 1216]).unwrap(),
            not_before_ms: 1_000,
            not_after_ms: 2_000,
        }
    }

    #[test]
    fn the_credential_carries_the_signers_identity_key() {
        let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
        let credential = keys.identity.issue_device_credential(&request()).unwrap();
        assert_eq!(credential.credential.identity_pk, keys.identity.public());
        assert_eq!(
            credential.credential.label.as_slice(),
            LABEL_DEVICE_CREDENTIAL
        );
    }

    #[test]
    fn the_issued_credential_round_trips_canonically() {
        // `WIRE.md` §3.3: what a peer hashes is the re-encoding, so a structure
        // this crate builds must be one that survives decode-and-re-encode.
        let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
        let credential = keys.identity.issue_device_credential(&request()).unwrap();
        let bytes = credential.encode_canonical().unwrap();
        let decoded = DeviceCredential::decode_canonical(&bytes).unwrap();
        assert_eq!(decoded.value(), &credential);
    }

    #[test]
    fn an_inverted_validity_window_is_refused_before_it_is_signed() {
        let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
        let mut bad = request();
        core::mem::swap(&mut bad.not_before_ms, &mut bad.not_after_ms);
        assert_eq!(
            keys.identity.issue_device_credential(&bad).err(),
            Some(IdentityError::MalformedCredential)
        );
    }

    #[test]
    fn an_instantaneous_window_is_refused() {
        let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
        let mut bad = request();
        bad.not_after_ms = bad.not_before_ms;
        assert_eq!(
            keys.identity.issue_device_credential(&bad).err(),
            Some(IdentityError::MalformedCredential)
        );
    }

    #[test]
    fn two_devices_of_one_account_share_an_identity_key() {
        // The property `ADR 0002` needs: per-device fan-out from day one, with
        // one identity above it.
        let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
        let mut first = request();
        first.device_pk = PublicKey::new([1u8; 32]);
        let mut second = request();
        second.device_pk = PublicKey::new([2u8; 32]);

        let a = keys.identity.issue_device_credential(&first).unwrap();
        let b = keys.identity.issue_device_credential(&second).unwrap();
        assert_eq!(a.credential.identity_pk, b.credential.identity_pk);
        assert_ne!(a.credential.device_pk, b.credential.device_pk);
        assert_ne!(a.signature, b.signature);
    }

    #[test]
    fn a_device_key_from_the_generator_is_accepted_as_a_device_pk() {
        // The two halves of §4.2 meeting: a CSPRNG device key and a
        // seed-derived identity key in one credential.
        struct Zeros;
        impl rand_core::TryRng for Zeros {
            type Error = core::convert::Infallible;
            fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
                Ok(1)
            }
            fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
                Ok(1)
            }
            fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
                dst.fill(9);
                Ok(())
            }
        }
        impl rand_core::TryCryptoRng for Zeros {}

        let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
        let device = DeviceSignatureKey::generate(&mut Zeros);
        let mut request = request();
        request.device_pk = device.public();
        let credential = keys.identity.issue_device_credential(&request).unwrap();
        assert_eq!(credential.credential.device_pk, device.public());
    }
}
