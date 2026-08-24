//! Ed25519 verification, and the one policy decision inside it.
//!
//! Every signature `KT.md` §6.2's table names is Ed25519 over the canonical
//! `tls_codec` encoding of a `*TBS` structure, **signed directly, not
//! prehashed** (§6.2): the structures are small and fixed-shape, the same
//! reasoning `WIRE.md` §5.1 uses for the command transcript.
//!
//! # This crate verifies and never signs
//!
//! There is no signing function here and there is no key type that holds a
//! secret. The log's signing key, a witness's key and a user's
//! `DirectoryAuthKey` live in the processes that hold them; what this crate
//! does is say whether a byte string is a valid signature by a **public** key,
//! which is a pure function and needs no secrets, no randomness and no clock.
//! `f2z-codec` draws the same line for the same reason.
//!
//! # `verify_strict`, not `verify`
//!
//! [`ed25519_dalek::VerifyingKey::verify_strict`] rejects small-order public
//! keys and non-canonical `R`/`s` encodings; plain `verify` does not. The
//! difference matters here more than in most places, because §7.2's whole
//! accountability argument is that **two conflicting cosignatures verifying
//! under one `witness_pk` are a contradiction on their face**. Under
//! non-strict verification a signature can be malleated into a second distinct
//! byte string that still verifies, so "the witness signed two things" and "an
//! attacker re-encoded one thing" stop being distinguishable, and the
//! non-repudiation §7.2 claims quietly becomes an accusation instead of a
//! proof. The same argument covers `LogKeyTransition`'s dual signature and
//! every `prev_entry_hash`-chained authorization.

use ed25519_dalek::{Signature as DalekSignature, VerifyingKey};
use f2z_codec::types::{PublicKey, Signature};

use crate::error::KtError;

/// Verify an Ed25519 signature over `message` under `public_key`.
///
/// # Errors
///
/// [`KtError::BadSignature`] if the key is not a valid Ed25519 point, if the
/// signature is not a canonical encoding, or if it does not verify. The three
/// are one verdict on purpose: a caller that could tell them apart would be a
/// caller that could be asked which one happened.
pub fn verify(
    public_key: &PublicKey,
    message: &[u8],
    signature: &Signature,
) -> Result<(), KtError> {
    let key = VerifyingKey::from_bytes(public_key.as_bytes()).map_err(|_| KtError::BadSignature)?;
    let signature = DalekSignature::from_bytes(signature.as_bytes());
    key.verify_strict(message, &signature)
        .map_err(|_| KtError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    /// A deterministic key, so the tests carry no randomness.
    pub(crate) fn signing_key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    pub(crate) fn public_key_of(key: &SigningKey) -> PublicKey {
        PublicKey::new(key.verifying_key().to_bytes())
    }

    pub(crate) fn sign(key: &SigningKey, message: &[u8]) -> Signature {
        Signature::new(key.sign(message).to_bytes())
    }

    #[test]
    fn a_valid_signature_verifies_and_a_flipped_bit_does_not() {
        let key = signing_key(1);
        let public = public_key_of(&key);
        let message = b"free2z/kt/v1/sth ...";
        let signature = sign(&key, message);
        assert_eq!(verify(&public, message, &signature), Ok(()));

        let mut tampered = *signature.as_bytes();
        tampered[0] ^= 0x01;
        assert_eq!(
            verify(&public, message, &Signature::new(tampered)),
            Err(KtError::BadSignature)
        );

        assert_eq!(
            verify(&public, b"a different message", &signature),
            Err(KtError::BadSignature)
        );
    }

    #[test]
    fn another_key_does_not_verify() {
        let signer = signing_key(1);
        let other = public_key_of(&signing_key(2));
        let message = b"one message";
        assert_eq!(
            verify(&other, message, &sign(&signer, message)),
            Err(KtError::BadSignature)
        );
    }

    #[test]
    fn a_key_that_is_not_a_point_is_refused_rather_than_panicking() {
        // All-zero is not a valid compressed Edwards point in `verify_strict`'s
        // sense; the important property is that it is a verdict, not a panic.
        let key = signing_key(3);
        let message = b"m";
        assert_eq!(
            verify(&PublicKey::zero(), message, &sign(&key, message)),
            Err(KtError::BadSignature)
        );
    }
}
