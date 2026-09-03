//! `OpenMlsProvider` — the libcrux crypto core over the free2z store.
//!
//! `openmls_libcrux_crypto::Provider` bundles the libcrux `CryptoProvider` with
//! `openmls_memory_storage::MemoryStorage`, which is not a store a client can
//! keep messages in. This is the same crypto with
//! [`F2zStorageProvider`](f2z_msg_store::F2zStorageProvider) underneath.
//!
//! # One crypto core, and this is it
//!
//! ADR 0001 requires one Rust crypto core shared by ZUULI and the web client.
//! `openmls_libcrux_crypto::CryptoProvider` serves as **both** the crypto and
//! the randomness provider — that is upstream's own arrangement, not a shortcut
//! here — and [`crate::DeviceSigner`] signs through the same libcrux
//! primitives, so there is no second implementation of any primitive in this
//! graph. [#385](https://github.com/free2z/zuu/issues/385) verified this core
//! against NIST ACVP ML-KEM vectors, RFC 7748, RFC 8032 and
//! draft-connolly-cfrg-xwing-06 Appendix C on nine targets.

use f2z_msg_store::{F2zStorageProvider, StorageBackend};
use openmls_libcrux_crypto::CryptoProvider;
use openmls_traits::OpenMlsProvider;

use crate::error::{EngineError, Result};

/// The provider handed to every OpenMLS call.
pub struct F2zProvider<B: StorageBackend> {
    crypto: CryptoProvider,
    storage: F2zStorageProvider<B>,
}

impl<B: StorageBackend> core::fmt::Debug for F2zProvider<B> {
    /// Hand-written because `CryptoProvider` has no `Debug` — and would not be
    /// safe to derive one for if it did: it owns the RNG state.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("F2zProvider")
            .field("crypto", &format_args!("libcrux"))
            .field("storage", &self.storage)
            .finish()
    }
}

impl<B: StorageBackend> F2zProvider<B> {
    /// Build a provider over a storage backend.
    ///
    /// # Errors
    ///
    /// [`EngineError::Mls`] if the libcrux provider could not be instantiated,
    /// which on the targets #385 measured means the platform's randomness
    /// source is unavailable.
    pub fn new(backend: B) -> Result<Self> {
        Ok(Self {
            // `CryptoProvider::new` rather than `Default`: upstream's `Default`
            // `unwrap()`s the same call, and this workspace does not have a
            // panicking construction path in a crypto core.
            crypto: CryptoProvider::new().map_err(|_| EngineError::Mls("crypto provider init"))?,
            storage: F2zStorageProvider::new(backend),
        })
    }

    /// The store, for the transaction the engine drives and for the durability
    /// a client has to report (`CLIENT-CONTRACT.md` §3.1).
    pub const fn store(&self) -> &F2zStorageProvider<B> {
        &self.storage
    }
}

impl<B: StorageBackend> OpenMlsProvider for F2zProvider<B> {
    type CryptoProvider = CryptoProvider;
    type RandProvider = CryptoProvider;
    type StorageProvider = F2zStorageProvider<B>;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        // Upstream's arrangement: the libcrux `CryptoProvider` is both. Named
        // here rather than left to be discovered, because "the RNG is the
        // crypto provider" is the kind of fact a reader should not have to go
        // and check.
        &self.crypto
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_msg_store::MemoryBackend;
    use openmls_traits::crypto::OpenMlsCrypto;
    use openmls_traits::random::OpenMlsRand;

    #[test]
    fn the_provider_supports_the_ciphersuite_the_architecture_requires() {
        let provider = F2zProvider::new(MemoryBackend::new()).unwrap();
        provider.crypto().supports(crate::CIPHERSUITE).unwrap();
    }

    /// `rs/deny.toml` cites this test by name. Three RustSec advisories against
    /// `libcrux-aesgcm` (RUSTSEC-2026-0209, -0210, -0211) are accepted there on
    /// the grounds that AES-GCM is linked but never selected — so the moment
    /// that stops being true, this fails and the reasoning is revisited rather
    /// than inherited.
    #[test]
    fn the_ciphersuite_uses_chacha20poly1305_and_not_aes_gcm() {
        use openmls_traits::types::{AeadType, HpkeAeadType};

        assert_eq!(
            crate::CIPHERSUITE.aead_algorithm(),
            AeadType::ChaCha20Poly1305
        );
        assert_eq!(
            crate::CIPHERSUITE.hpke_aead_algorithm(),
            HpkeAeadType::ChaCha20Poly1305
        );
    }

    /// The other half of the same argument: `signature_key_gen` is the function
    /// RUSTSEC-2026-0075 is about, and nothing in this tree calls it. What this
    /// test can check is that the engine's signing path does not need it — a
    /// `DeviceSigner` is built from a key its caller already has.
    #[test]
    fn a_device_signer_is_built_from_a_key_rather_than_generating_one() {
        let signer = crate::DeviceSigner::from_private_key([9u8; 32]).unwrap();
        let mut expected = [0u8; 32];
        libcrux_ed25519::secret_to_public(&mut expected, &[9u8; 32]);
        assert_eq!(signer.public_key(), &expected);
    }

    #[test]
    fn the_randomness_provider_produces_distinct_values() {
        let provider = F2zProvider::new(MemoryBackend::new()).unwrap();
        let a: [u8; 32] = provider.rand().random_array().unwrap();
        let b: [u8; 32] = provider.rand().random_array().unwrap();
        assert_ne!(a, b);
    }
}
