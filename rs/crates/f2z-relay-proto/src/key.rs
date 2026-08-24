//! Ed25519 keys, signatures, and the two properties `WIRE.md` asks of them
//! that a naive wrapper would miss.
//!
//! **Strict verification.** Everything here verifies with `verify_strict`,
//! which additionally rejects small-order public keys and small-order `R`
//! components. Plain Ed25519 verification does not, and the consequence is
//! signature *malleability*: a signature can verify under more than one key,
//! and a key can exist under which every signature verifies. This protocol
//! treats a verifying signature as proof that a specific key authorized a
//! specific command — [`WIRE.md` §5.1][s5] step 5 compares `signer_key`
//! against the key registered for an address — so a key that verifies
//! everything is a key that steals every queue it is registered against. The
//! cost of `verify_strict` is one extra point check.
//!
//! **Redaction.** [`SigningKey`] holds the one genuinely secret value in the
//! system; its `Debug` prints nothing about it, not even a fingerprint.
//! [`VerifyingKey`] is public but linkable — a per-queue key identifies a
//! conversation to anyone who has seen it elsewhere ([ADR 0004]) — so it
//! redacts too, exactly as `f2z-codec`'s newtypes do.
//!
//! [s5]: https://github.com/free2z/zuu/blob/main/docs/e2ee/WIRE.md
//! [ADR 0004]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0004-metadata-ambition.md

use core::fmt;

use ed25519_dalek::Signer as _;
use f2z_codec::ErrorCode;
use f2z_codec::types::{PublicKey, Signature};
use subtle::ConstantTimeEq as _;

use crate::error::{ProtoError, Result};

/// An Ed25519 public key that has been decompressed and is ready to verify.
///
/// Constructing one is the only place a malformed key is rejected, so a
/// [`VerifyingKey`] in hand is a key that decodes to a curve point. It is not a
/// promise that the point is safe: that check belongs to each verification, and
/// [`VerifyingKey::verify`] makes it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct VerifyingKey(ed25519_dalek::VerifyingKey);

impl VerifyingKey {
    /// Decompress a wire public key.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::BadSignature`] if the bytes are not a curve point. That is
    /// the same code a bad signature gets, deliberately: from a peer's side
    /// "your key is not a key" and "your signature is not a signature" are the
    /// same event — the command was not authorized — and splitting them would
    /// tell an unauthenticated caller which half of its guess was wrong.
    pub fn from_public_key(key: &PublicKey) -> Result<Self> {
        ed25519_dalek::VerifyingKey::from_bytes(key.as_bytes())
            .map(Self)
            .map_err(|_| ProtoError::Wire(ErrorCode::BadSignature))
    }

    /// The wire form.
    #[must_use]
    pub fn to_public_key(&self) -> PublicKey {
        PublicKey::new(self.0.to_bytes())
    }

    /// Verify a signature over `message`, strictly (see the module note).
    ///
    /// # Errors
    ///
    /// [`ErrorCode::BadSignature`].
    pub fn verify(&self, message: &[u8], signature: &Signature) -> Result<()> {
        let signature = ed25519_dalek::Signature::from_bytes(signature.as_bytes());
        self.0
            .verify_strict(message, &signature)
            .map_err(|_| ProtoError::Wire(ErrorCode::BadSignature))
    }
}

// Public, but linkable. Same rule as `f2z-codec`'s newtypes, and no alternate
// formatter that renders the bytes — an escape hatch would be found and used.
impl fmt::Debug for VerifyingKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VerifyingKey(<redacted>)")
    }
}

/// An Ed25519 signing key: a relay identity key, or a per-queue send or
/// receive key.
///
/// This crate never generates one. Randomness is the caller's — a client draws
/// queue keys from the MLS exporter of `ARCHITECTURE.md` §5.4, and this crate
/// has no runtime, no clock and no CSPRNG by design.
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

    /// The public half.
    #[must_use]
    pub fn verifying_key(&self) -> VerifyingKey {
        VerifyingKey(self.0.verifying_key())
    }

    /// The public half in wire form — what goes in `signer_key`, `recv_key`,
    /// `send_key` or `relay_identity_pk`.
    #[must_use]
    pub fn public_key(&self) -> PublicKey {
        PublicKey::new(self.0.verifying_key().to_bytes())
    }

    /// Sign a message.
    ///
    /// `WIRE.md` §5.1: Ed25519 is not prehashed here and the transcript is
    /// small, so the message is signed directly.
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

/// Compare two public keys in constant time.
///
/// `WIRE.md` §10 requires this where a key comparison decides whether an
/// address authorizes a caller: a data-dependent comparison there is a
/// byte-at-a-time oracle on a value the relay is trying not to confirm.
#[must_use]
pub fn keys_equal(left: &PublicKey, right: &PublicKey) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}

/// A verification against a fixed key that always fails, for §10's absent path.
///
/// `WIRE.md` §10 requires a relay that is about to answer `ERR_NO_ACCESS` for
/// an address it does not hold to "perform a dummy Ed25519 verification against
/// a fixed key so that the dominant CPU cost is present in both paths", and to
/// not short-circuit before it. That is what this is for, and the return value
/// exists so the call cannot be optimized away — a caller MUST consume it.
///
/// Read this as exactly what §10 says it is: a narrowing, not a closure. The
/// storage-layer difference between an index miss and an index hit remains, and
/// the specification states that residual rather than papering over it.
#[must_use]
pub fn dummy_verify() -> bool {
    // A fixed, deliberately public key and an all-zero signature. The
    // verification fails; the point is the arithmetic it does first.
    let key = SigningKey::from_seed(&[0x11; 32]).verifying_key();
    key.verify(b"free2z/relay/v1/dummy", &Signature::zero())
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    #[test]
    fn a_signature_verifies_under_its_own_key_and_no_other() {
        let key = SigningKey::from_seed(&[7u8; 32]);
        let other = SigningKey::from_seed(&[8u8; 32]);
        let signature = key.sign(b"transcript");
        assert!(
            key.verifying_key()
                .verify(b"transcript", &signature)
                .is_ok()
        );
        assert_eq!(
            other.verifying_key().verify(b"transcript", &signature),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
        assert_eq!(
            key.verifying_key().verify(b"transcripT", &signature),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
    }

    #[test]
    fn the_public_key_round_trips_through_the_wire_form() {
        let key = SigningKey::from_seed(&[3u8; 32]);
        let wire = key.public_key();
        let decoded = VerifyingKey::from_public_key(&wire).unwrap();
        assert_eq!(decoded.to_public_key(), wire);
        assert_eq!(decoded, key.verifying_key());
    }

    #[test]
    fn a_key_that_is_not_a_curve_point_is_refused_as_a_bad_signature() {
        // Roughly half of all 32-byte strings decompress to a curve point and
        // half do not, so the property is searched for rather than asserted
        // about one hand-picked constant — a constant would be a claim about
        // curve25519-dalek's encoding rules that this test cannot check.
        let mut candidate = [0u8; 32];
        let refused = (0..64u8).any(|byte| {
            candidate[0] = byte;
            VerifyingKey::from_public_key(&PublicKey::new(candidate))
                == Err(ProtoError::Wire(ErrorCode::BadSignature))
        });
        assert!(refused, "no 32-byte string in the sample was refused");
    }

    #[test]
    fn small_order_keys_are_rejected_by_strict_verification() {
        // The canonical small-order point of order 8. Under non-strict
        // verification a signature can be made to verify under a key like
        // this; §5.1 step 5 then reads a queue as authorized by a key nobody
        // possesses.
        let small_order = PublicKey::new([
            0xc7, 0x17, 0x6a, 0x70, 0x3d, 0x4d, 0xd8, 0x4f, 0xba, 0x3c, 0x0b, 0x76, 0x0d, 0x10,
            0x67, 0x0f, 0x2a, 0x20, 0x53, 0xfa, 0x2c, 0x39, 0xcc, 0xc6, 0x4e, 0xc7, 0xfd, 0x77,
            0x92, 0xac, 0x03, 0x7a,
        ]);
        let key = VerifyingKey::from_public_key(&small_order).unwrap();
        assert_eq!(
            key.verify(b"anything", &Signature::new([0u8; 64])),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
    }

    #[test]
    fn keys_equal_agrees_with_equality() {
        let a = SigningKey::from_seed(&[1u8; 32]).public_key();
        let b = SigningKey::from_seed(&[2u8; 32]).public_key();
        assert!(keys_equal(&a, &a));
        assert!(!keys_equal(&a, &b));
    }

    #[test]
    fn the_dummy_verification_does_work_and_fails() {
        assert!(!dummy_verify());
    }

    #[test]
    fn keys_never_render_their_bytes() {
        let key = SigningKey::from_seed(&[0xde; 32]);
        assert_eq!(format!("{key:?}"), "SigningKey(<redacted>)");
        assert_eq!(
            format!("{:?}", key.verifying_key()),
            "VerifyingKey(<redacted>)"
        );
    }
}
