//! Ed25519, verified strictly, and signing for the issuer.
//!
//! **Strict verification.** Both verifications in this crate go through
//! `verify_strict`, which additionally rejects small-order public keys and
//! small-order `R` components. Plain Ed25519 verification does not, and the
//! consequence is that a signature can verify under more than one key — and
//! that a key can exist under which *every* signature verifies. This crate's
//! entire job is to decide that a specific authority vouched for a specific
//! handle and that a specific identity key answered for it, so a key that
//! verifies everything is a key that claims every handle. The cost is one extra
//! point check.
//!
//! **Redaction.** [`SigningKey`] holds the issuer's private key; its `Debug`
//! prints nothing about it, not even a fingerprint.

use core::fmt;

use ed25519_dalek::Signer as _;
use f2z_codec::types::{PublicKey, Signature};

use crate::error::{AuthorityError, Result};

/// An Ed25519 public key that has been decompressed and is ready to verify.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct VerifyingKey(ed25519_dalek::VerifyingKey);

impl VerifyingKey {
    /// Decompress a wire public key.
    ///
    /// # Errors
    ///
    /// The `bad_signature` argument, so that a caller decides *whose*
    /// signature the failure belongs to. "Your key is not a key" and "your
    /// signature is not a signature" are the same event from outside — the
    /// thing was not authorized — and this crate reports the party rather than
    /// the mechanism.
    pub fn from_public_key(key: &PublicKey, bad_signature: AuthorityError) -> Result<Self> {
        ed25519_dalek::VerifyingKey::from_bytes(key.as_bytes())
            .map(Self)
            .map_err(|_| bad_signature)
    }

    /// The wire form.
    #[must_use]
    pub fn to_public_key(self) -> PublicKey {
        PublicKey::new(self.0.to_bytes())
    }

    /// Verify a signature over `message`, strictly (see the module note).
    ///
    /// # Errors
    ///
    /// The `bad_signature` argument.
    pub fn verify(
        self,
        message: &[u8],
        signature: &Signature,
        bad_signature: AuthorityError,
    ) -> Result<()> {
        let signature = ed25519_dalek::Signature::from_bytes(signature.as_bytes());
        self.0
            .verify_strict(message, &signature)
            .map_err(|_| bad_signature)
    }
}

// Public, but linkable: an identity key names a person to anyone who has seen
// it elsewhere. Same rule as `f2z-codec`'s newtypes, and no alternate formatter
// that renders the bytes — an escape hatch would be found and used.
impl fmt::Debug for VerifyingKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VerifyingKey(<redacted>)")
    }
}

/// An Ed25519 signing key — an authority's issuing key, or an identity key
/// answering for itself.
///
/// This crate never generates one: it has no clock, no randomness and no I/O,
/// because it compiles for `wasm32-unknown-unknown`. `f2z-assert` owns the
/// seed.
#[derive(Clone)]
pub struct SigningKey(ed25519_dalek::SigningKey);

impl SigningKey {
    /// Adopt a 32-byte seed.
    ///
    /// The seed is secret key material and the caller owns its lifetime; this
    /// type zeroizes its own copy on drop but cannot reach the caller's.
    #[must_use]
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self(ed25519_dalek::SigningKey::from_bytes(seed))
    }

    /// The public half, in wire form.
    #[must_use]
    pub fn public_key(&self) -> PublicKey {
        PublicKey::new(self.0.verifying_key().to_bytes())
    }

    /// Sign a message. The transcripts here are small, so nothing is prehashed.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> Signature {
        Signature::new(self.0.sign(message).to_bytes())
    }
}

// The one value in this crate whose disclosure is unrecoverable.
impl fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SigningKey(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    /// The canonical Ed25519 identity point. With `R = A` and `s = 0`, plain
    /// verification accepts every message while strict verification rejects
    /// the small-order public key. Other small-order encodings accept only
    /// message-dependent residue classes and are therefore softer fixtures.
    const FORGERY_KEY: [u8; 32] = [
        0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0,
    ];

    #[test]
    fn a_signature_verifies_only_over_the_message_it_covers() {
        let key = SigningKey::from_seed(&[7u8; 32]);
        let verifier =
            VerifyingKey::from_public_key(&key.public_key(), AuthorityError::BadAuthoritySignature)
                .unwrap();
        let signature = key.sign(b"the message");
        assert!(
            verifier
                .verify(
                    b"the message",
                    &signature,
                    AuthorityError::BadAuthoritySignature
                )
                .is_ok()
        );
        assert_eq!(
            verifier.verify(
                b"the messagf",
                &signature,
                AuthorityError::BadAuthoritySignature
            ),
            Err(AuthorityError::BadAuthoritySignature)
        );
    }

    #[test]
    fn the_identity_point_forgery_is_plainly_accepted_and_strictly_refused() {
        use ed25519_dalek::Verifier as _;

        let mut signature = [0u8; 64];
        signature
            .get_mut(..32)
            .unwrap()
            .copy_from_slice(&FORGERY_KEY);
        let forged = Signature::new(signature);
        let key = PublicKey::new(FORGERY_KEY);
        let verifier =
            VerifyingKey::from_public_key(&key, AuthorityError::BadIdentitySignature).unwrap();
        let raw = ed25519_dalek::VerifyingKey::from_bytes(&FORGERY_KEY).unwrap();
        assert!(
            raw.is_weak(),
            "the fixture stopped being a small-order point"
        );
        let dalek_signature = ed25519_dalek::Signature::from_bytes(forged.as_bytes());

        for byte in 0..64u8 {
            let message = [byte; 7];
            assert!(
                raw.verify(&message, &dalek_signature).is_ok(),
                "message {byte}: plain verification refused the fixture, so the test no longer proves strictness matters"
            );
            assert_eq!(
                verifier.verify(&message, &forged, AuthorityError::BadIdentitySignature),
                Err(AuthorityError::BadIdentitySignature),
                "message {byte}: strict verification accepted a universal forgery"
            );
        }
    }

    #[test]
    fn a_key_that_is_not_a_curve_point_never_verifies_anything() {
        // Whether a given 32 bytes is refused at decompression or at
        // verification is `ed25519-dalek`'s business and has moved between its
        // versions. What this crate needs is the property that survives either
        // answer: bytes that are not a usable key cannot make a signature
        // verify. Asserting only that is what stops the test from being a
        // restatement of the dependency's current internals.
        for candidate in [[0xffu8; 32], [0x01u8; 32], [0x00u8; 32]] {
            let key = PublicKey::new(candidate);
            let outcome = VerifyingKey::from_public_key(&key, AuthorityError::BadIdentitySignature)
                .and_then(|verifier| {
                    verifier.verify(
                        b"anything",
                        &Signature::new([0u8; 64]),
                        AuthorityError::BadIdentitySignature,
                    )
                });
            assert_eq!(outcome, Err(AuthorityError::BadIdentitySignature));
        }
    }

    #[test]
    fn neither_key_type_renders_its_bytes() {
        let key = SigningKey::from_seed(&[1u8; 32]);
        assert_eq!(format!("{key:?}"), "SigningKey(<redacted>)");
        let verifier =
            VerifyingKey::from_public_key(&key.public_key(), AuthorityError::BadIdentitySignature)
                .unwrap();
        assert_eq!(format!("{verifier:?}"), "VerifyingKey(<redacted>)");
    }
}
