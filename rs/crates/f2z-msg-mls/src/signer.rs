//! `DeviceSignatureKey` — the MLS leaf signature key, signing through the
//! libcrux core, including the domain-separated routing bootstrap MLS needs.
//!
//! # Why this exists: #693 and ADR 0001's "one crypto core"
//!
//! `openmls_basic_credential 0.5.0` is the obvious thing to use here and it is
//! the wrong thing. Its `SignatureKeyPair::sign` calls **`ed25519-dalek`** and
//! **`p256`** directly (`src/lib.rs:15,51,55-58`), not the libcrux provider —
//! so signature *generation* bypasses the verified core entirely while
//! signature *verification* goes through it, and RustCrypto's `sha2`,
//! `cpufeatures` and `curve25519-dalek` get linked into every ZUULI binary
//! alongside libcrux. [#385](https://github.com/free2z/zuu/issues/385) found
//! it; [#693](https://github.com/free2z/zuu/issues/693) records it.
//!
//! ADR 0001's argument for one Rust core is that a second implementation of the
//! same primitive is a whole bug class — sign with one and verify with the
//! other and the disagreement is a signature that validates for one peer and
//! not another. If that argument is meant literally, the fix is about twenty
//! lines, and this is them.
//!
//! `libcrux_ed25519::sign` is the *same function* `openmls_libcrux_crypto`'s
//! `CryptoProvider::sign` calls. This crate does not add a dependency; it
//! removes two.
//!
//! # Key material and `Debug`
//!
//! [`DeviceSigner`] holds a 32-byte Ed25519 seed. Its `Debug` is hand-written
//! and prints the public key's length and nothing else. The trap being avoided
//! is the one `f2z-codec`'s `tests/redaction.rs` documents: a derived `Debug`
//! renders bytes as a **decimal** list, which contains no hex at all, so a leak
//! check that greps for hex passes while the key is in the log.

use openmls_traits::signatures::{Signer, SignerError};
use openmls_traits::types::SignatureScheme;

use crate::error::EngineError;

/// The length of an Ed25519 private key, in bytes.
const PRIVATE_LEN: usize = 32;
/// The length of an Ed25519 public key, in bytes.
pub const PUBLIC_LEN: usize = 32;
/// The length of an Ed25519 signature, in bytes.
pub const SIGNATURE_LEN: usize = 64;

/// An Ed25519 signing key that signs through libcrux.
///
/// This is `ARCHITECTURE.md` §4.2's `DeviceSignatureKey` (DSK): generated
/// on-device from the OS CSPRNG, **never seed-derived**, never exported, and
/// used for the MLS leaf `signature_key` (RFC 9420 §7.2) and the one
/// domain-separated first-routing advert needed to bootstrap MLS delivery.
/// §5.6's key-context separation is the reason it signs only MLS framing and
/// the explicitly domain-separated routing bootstrap that enables that MLS
/// framing to travel: a
/// FROST transcript must never be replayable as chat evidence, and the way that
/// is guaranteed is that the key which signs one cannot sign the other.
#[derive(Clone)]
pub struct DeviceSigner {
    private: [u8; PRIVATE_LEN],
    public: [u8; PUBLIC_LEN],
}

impl core::fmt::Debug for DeviceSigner {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DeviceSigner")
            .field("private", &format_args!("<redacted; 32 bytes>"))
            .field("public", &format_args!("<redacted; 32 bytes>"))
            .finish()
    }
}

impl DeviceSigner {
    /// Wrap a private key, deriving the public key from it.
    ///
    /// The public key is **derived**, never supplied, so a caller cannot
    /// construct a signer whose advertised public key does not verify its own
    /// signatures — which is a credential that no peer can validate and a
    /// failure that only shows up on someone else's machine.
    #[must_use]
    pub fn from_private_key(private: [u8; PRIVATE_LEN]) -> Self {
        let mut public = [0u8; PUBLIC_LEN];
        libcrux_ed25519::secret_to_public(&mut public, &private);
        Self { private, public }
    }

    /// The public key: the MLS leaf `signature_key`, and `device_pk` in a
    /// [`DeviceCredential`](crate::DeviceCredential).
    #[must_use]
    pub const fn public_key(&self) -> &[u8; PUBLIC_LEN] {
        &self.public
    }

    /// Sign, returning the error type this crate uses rather than OpenMLS's.
    ///
    /// # Errors
    ///
    /// [`EngineError::Signature`] if libcrux refused.
    pub fn sign_bytes(&self, payload: &[u8]) -> Result<[u8; SIGNATURE_LEN], EngineError> {
        libcrux_ed25519::sign(payload, &self.private).map_err(|_| EngineError::Signature)
    }
}

// There is deliberately no `verify` function in this module.
//
// Two reasons, and the second is the one that matters. First, this crate never
// verifies an MLS framing signature itself: OpenMLS does, through
// `openmls_libcrux_crypto`'s `verify_signature`, which calls the same libcrux
// primitive `sign` above does — so a verifier here would be a third caller of
// a function that already has exactly the two it needs. Second, a
// device-credential signature is an *identity*-domain signature and
// `f2z-kt-core::sig::verify` owns it, using `verify_strict` so that small-order
// keys and non-canonical encodings are refused; an MLS peer and the
// transparency log answering differently about the same credential is a fork
// nobody would see. `f2z-codec`'s `workspace_strict_verification_scan` requires
// every `fn verify` in the tree to be registered with a statement of what makes
// it strict, and the honest statement for one here would be "it duplicates one
// of those two".

impl Signer for DeviceSigner {
    fn sign(&self, payload: &[u8]) -> Result<Vec<u8>, SignerError> {
        libcrux_ed25519::sign(payload, &self.private)
            .map(|signature| signature.to_vec())
            .map_err(|_| SignerError::SigningError)
    }

    fn signature_scheme(&self) -> SignatureScheme {
        // The only scheme `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519` uses,
        // and the only one `openmls_libcrux_crypto` supports — its `sign`,
        // `verify_signature` and `signature_key_gen` all reject anything else.
        SignatureScheme::ED25519
    }
}

#[cfg(test)]
mod tests {
    use openmls_libcrux_crypto::CryptoProvider;
    use openmls_traits::crypto::OpenMlsCrypto as _;

    use super::*;

    fn signer() -> DeviceSigner {
        DeviceSigner::from_private_key([7u8; PRIVATE_LEN])
    }

    /// Verification goes through the **production** verifier — the libcrux
    /// provider OpenMLS itself calls — rather than through a helper this module
    /// exports. See the note above on why there is no `verify` here.
    fn verifies(payload: &[u8], public: &[u8; PUBLIC_LEN], signature: &[u8]) -> bool {
        CryptoProvider::new()
            .unwrap()
            .verify_signature(SignatureScheme::ED25519, payload, public, signature)
            .is_ok()
    }

    #[test]
    fn a_signature_verifies_against_the_derived_public_key() {
        let signer = signer();
        let signature = signer.sign_bytes(b"transcript").unwrap();
        assert!(verifies(b"transcript", signer.public_key(), &signature));
    }

    #[test]
    fn a_flipped_bit_is_rejected() {
        let signer = signer();
        let mut signature = signer.sign_bytes(b"transcript").unwrap();
        signature[0] ^= 0x01;
        assert!(!verifies(b"transcript", signer.public_key(), &signature));
    }

    #[test]
    fn a_different_payload_is_rejected() {
        let signer = signer();
        let signature = signer.sign_bytes(b"transcript").unwrap();
        assert!(!verifies(b"transcripT", signer.public_key(), &signature));
    }

    #[test]
    fn a_different_key_is_rejected() {
        let signer = signer();
        let other = DeviceSigner::from_private_key([8u8; PRIVATE_LEN]);
        let signature = signer.sign_bytes(b"transcript").unwrap();
        assert!(!verifies(b"transcript", other.public_key(), &signature));
    }

    /// The `Signer` impl OpenMLS calls and [`DeviceSigner::sign_bytes`] must be
    /// the same operation. If they ever diverged, MLS framing would be signed
    /// by one path and our credentials by the other — which is exactly the
    /// two-implementations hazard this module exists to remove.
    #[test]
    fn the_openmls_signer_and_the_direct_path_agree() {
        let signer = signer();
        let via_trait = Signer::sign(&signer, b"payload").unwrap();
        let direct = signer.sign_bytes(b"payload").unwrap();
        assert_eq!(via_trait, direct.to_vec());
        assert_eq!(signer.signature_scheme(), SignatureScheme::ED25519);
    }

    #[test]
    fn debug_prints_neither_key_in_hex_or_in_decimal() {
        let signer = DeviceSigner::from_private_key([0xAB; PRIVATE_LEN]);
        let rendered = format!("{signer:?}");
        assert!(!rendered.contains("abab"), "{rendered}");
        assert!(!rendered.contains("171, 171"), "{rendered}");
        assert!(rendered.contains("<redacted; 32 bytes>"), "{rendered}");
    }
}
