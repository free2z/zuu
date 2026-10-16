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

//! Storage keys and values are sealed before they cross the public
//! `StorageBackend` boundary. On the first open, the backend atomically rewrites
//! legacy OpenMLS rows and the engine-owned version/delivery markers, leaving
//! unrelated application records untouched. The migration marker is written in
//! the same transaction; an interrupted or refused rewrite leaves the old rows
//! intact. This protects against a caller that retains only a backend clone and
//! opaque `DeviceSigner`.
//! It does not protect against a caller that already holds the signing secret,
//! which is sufficient to derive the storage key.

use f2z_msg_store::{Durability, F2zStorageProvider, Op, StorageBackend};
use openmls_libcrux_crypto::CryptoProvider;
use openmls_traits::{OpenMlsProvider, crypto::OpenMlsCrypto, random::OpenMlsRand};
use std::sync::Arc;

use crate::error::{EngineError, Result};

/// The provider handed to every OpenMLS call.
pub(crate) struct F2zProvider<B: StorageBackend> {
    crypto: Arc<CryptoProvider>,
    storage: F2zStorageProvider<SealedBackend<B>>,
}

const SEALED_PREFIX: &[u8] = b"\0f2z-mls-sealed-v1/";
const MARKER_LOGICAL_KEY: &[u8] = b"f2z/mls/sealed-storage-migration/v1";
const MARKER_PLAINTEXT: &[u8] = b"f2z-mls-sealed-storage-v1";
const VALUE_VERSION: u8 = 1;
const LEGACY_OPENMLS_LABELS: &[&[u8]] = &[
    b"KeyPackage",
    b"Psk",
    b"EncryptionKeyPair",
    b"SignatureKeyPair",
    b"EpochKeyPairs",
    b"Tree",
    b"GroupContext",
    b"ApplicationExportTree",
    b"InterimTranscriptHash",
    b"ConfirmationTag",
    b"MlsGroupJoinConfig",
    b"OwnLeafNodes",
    b"GroupState",
    b"QueuedProposal",
    b"ProposalQueueRefs",
    b"OwnLeafNodeIndex",
    b"EpochSecrets",
    b"ResumptionPsk",
    b"MessageSecrets",
];

fn is_legacy_mls_row(key: &[u8]) -> bool {
    // The plugin's f2zmsg/ application records share this SQLite table and
    // must remain readable by its independent record provider. Only migrate
    // OpenMLS labels plus the MLS engine's own AppRecord rows.
    LEGACY_OPENMLS_LABELS
        .iter()
        .any(|label| key.starts_with(label))
        || (key.starts_with(b"AppRecord")
            && (key.starts_with(b"AppRecordf2z/version/")
                || key.starts_with(b"AppRecordf2z/handled/")))
}

/// Encrypts storage keys and values before handing them to the caller-owned
/// backend. The backend can observe access patterns and ciphertext sizes, but
/// cannot reconstruct an OpenMLS store from a retained backend clone without
/// the signer secret.
#[doc(hidden)]
pub struct SealedBackend<B: StorageBackend> {
    backend: B,
    root_key: [u8; 32],
    encryption_key: Vec<u8>,
    crypto: Arc<CryptoProvider>,
}

impl<B: StorageBackend> SealedBackend<B> {
    fn new(
        backend: B,
        root_key: [u8; 32],
        crypto: Arc<CryptoProvider>,
    ) -> f2z_msg_store::Result<Self> {
        let mut result = Self {
            backend,
            root_key,
            encryption_key: Vec::new(),
            crypto,
        };
        result.encryption_key = result.derive(b"free2z/mls/storage-value-key/v1")?;
        result.migrate_legacy_rows()?;
        Ok(result)
    }

    fn derive(&self, purpose_and_key: &[u8]) -> f2z_msg_store::Result<Vec<u8>> {
        self.crypto
            .hmac(
                crate::CIPHERSUITE.hash_algorithm(),
                &self.root_key,
                purpose_and_key,
            )
            .map(|secret| secret.as_slice().to_vec())
            .map_err(|_| f2z_msg_store::StoreError::Backend("derive MLS storage key"))
    }

    fn sealed_key(&self, key: &[u8]) -> f2z_msg_store::Result<Vec<u8>> {
        let mut input = b"free2z/mls/storage-key-id/v1".to_vec();
        input.extend_from_slice(key);
        let id = self.derive(&input)?;
        let mut output = SEALED_PREFIX.to_vec();
        output.extend_from_slice(&id);
        Ok(output)
    }

    fn seal(&self, key: &[u8], value: &[u8]) -> f2z_msg_store::Result<Vec<u8>> {
        let nonce_len = crate::CIPHERSUITE.aead_nonce_length();
        let nonce = self
            .crypto
            .random_vec(nonce_len)
            .map_err(|_| f2z_msg_store::StoreError::Backend("generate MLS storage nonce"))?;
        let ciphertext = self
            .crypto
            .aead_encrypt(
                crate::CIPHERSUITE.aead_algorithm(),
                &self.encryption_key,
                value,
                &nonce,
                key,
            )
            .map_err(|_| f2z_msg_store::StoreError::Backend("seal MLS storage value"))?;
        let capacity = nonce
            .len()
            .checked_add(ciphertext.len())
            .and_then(|length| length.checked_add(1))
            .ok_or(f2z_msg_store::StoreError::Backend(
                "sealed MLS storage value too large",
            ))?;
        let mut output = Vec::with_capacity(capacity);
        output.push(VALUE_VERSION);
        output.extend_from_slice(&nonce);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn unseal(&self, key: &[u8], value: &[u8]) -> f2z_msg_store::Result<Vec<u8>> {
        let nonce_len = crate::CIPHERSUITE.aead_nonce_length();
        let nonce_end = 1usize
            .checked_add(nonce_len)
            .ok_or(f2z_msg_store::StoreError::Backend(
                "invalid sealed MLS storage nonce length",
            ))?;
        if value.len() <= nonce_end || value.first() != Some(&VALUE_VERSION) {
            return Err(f2z_msg_store::StoreError::Backend(
                "invalid sealed MLS storage value",
            ));
        }
        let ciphertext = value
            .get(nonce_end..)
            .ok_or(f2z_msg_store::StoreError::Backend(
                "invalid sealed MLS storage value",
            ))?;
        let nonce = value
            .get(1..nonce_end)
            .ok_or(f2z_msg_store::StoreError::Backend(
                "invalid sealed MLS storage value",
            ))?;
        self.crypto
            .aead_decrypt(
                crate::CIPHERSUITE.aead_algorithm(),
                &self.encryption_key,
                ciphertext,
                nonce,
                key,
            )
            .map_err(|_| f2z_msg_store::StoreError::Backend("open sealed MLS storage value"))
    }

    fn migrate_legacy_rows(&self) -> f2z_msg_store::Result<()> {
        let marker_key = self.sealed_key(MARKER_LOGICAL_KEY)?;
        let marker_value = self.seal(MARKER_LOGICAL_KEY, MARKER_PLAINTEXT)?;
        self.backend
            .atomic_rewrite(&marker_key, &marker_value, &mut |old_key, old_value| {
                // Rows already sealed by another signer root key and the
                // plugin's independent AppRecord rows must remain untouched.
                if old_key.starts_with(SEALED_PREFIX) || !is_legacy_mls_row(old_key) {
                    return Ok(None);
                }
                Ok(Some((
                    self.sealed_key(old_key)?,
                    self.seal(old_key, old_value)?,
                )))
            })?;
        let persisted_marker =
            self.backend
                .get(&marker_key)?
                .ok_or(f2z_msg_store::StoreError::Backend(
                    "MLS storage migration marker missing",
                ))?;
        if self.unseal(MARKER_LOGICAL_KEY, &persisted_marker)? != MARKER_PLAINTEXT {
            return Err(f2z_msg_store::StoreError::Backend(
                "MLS storage migration marker invalid",
            ));
        }
        Ok(())
    }
}

impl<B: StorageBackend> StorageBackend for SealedBackend<B> {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        self.backend
            .get(&self.sealed_key(key)?)?
            .map(|value| self.unseal(key, &value))
            .transpose()
    }

    fn apply(&self, ops: &[Op]) -> f2z_msg_store::Result<()> {
        let qualified = ops
            .iter()
            .map(|op| match op {
                Op::Put { key, value } => Ok(Op::Put {
                    key: self.sealed_key(key)?,
                    value: self.seal(key, value)?,
                }),
                Op::Delete { key } => Ok(Op::Delete {
                    key: self.sealed_key(key)?,
                }),
            })
            .collect::<f2z_msg_store::Result<Vec<_>>>()?;
        self.backend.apply(&qualified)
    }

    fn atomic_rewrite(
        &self,
        _marker_key: &[u8],
        _marker_value: &[u8],
        _rewrite: &mut f2z_msg_store::RowRewrite<'_>,
    ) -> f2z_msg_store::Result<()> {
        Err(f2z_msg_store::StoreError::Backend(
            "nested MLS storage migration is not supported",
        ))
    }

    fn durability(&self) -> Durability {
        self.backend.durability()
    }
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
    pub(crate) fn new(backend: B, root_key: [u8; 32]) -> Result<Self> {
        let crypto =
            Arc::new(CryptoProvider::new().map_err(|_| EngineError::Mls("crypto provider init"))?);
        Ok(Self {
            crypto: crypto.clone(),
            storage: F2zStorageProvider::new(
                SealedBackend::new(backend, root_key, crypto).map_err(EngineError::Storage)?,
            ),
        })
    }

    /// The store, for the transaction the engine drives and for the durability
    /// a client has to report (`CLIENT-CONTRACT.md` §3.1).
    pub(crate) const fn store(&self) -> &F2zStorageProvider<SealedBackend<B>> {
        &self.storage
    }
}

impl<B: StorageBackend> OpenMlsProvider for F2zProvider<B> {
    type CryptoProvider = CryptoProvider;
    type RandProvider = CryptoProvider;
    type StorageProvider = F2zStorageProvider<SealedBackend<B>>;

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
    use f2z_msg_store::{F2zStorageProvider, MemoryBackend};
    use openmls_traits::crypto::OpenMlsCrypto;
    use openmls_traits::random::OpenMlsRand;

    #[derive(Clone)]
    struct SharedMemory(Arc<MemoryBackend>);

    impl StorageBackend for SharedMemory {
        fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
            self.0.get(key)
        }

        fn apply(&self, ops: &[Op]) -> f2z_msg_store::Result<()> {
            self.0.apply(ops)
        }

        fn atomic_rewrite(
            &self,
            marker_key: &[u8],
            marker_value: &[u8],
            rewrite: &mut f2z_msg_store::RowRewrite<'_>,
        ) -> f2z_msg_store::Result<()> {
            self.0.atomic_rewrite(marker_key, marker_value, rewrite)
        }

        fn durability(&self) -> Durability {
            self.0.durability()
        }
    }

    #[test]
    fn the_provider_supports_the_ciphersuite_the_architecture_requires() {
        let provider = F2zProvider::new(MemoryBackend::new(), [0; 32]).unwrap();
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
        let provider = F2zProvider::new(MemoryBackend::new(), [0; 32]).unwrap();
        let a: [u8; 32] = provider.rand().random_array().unwrap();
        let b: [u8; 32] = provider.rand().random_array().unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn migration_preserves_legacy_version_and_handled_delivery_records() {
        let backend = SharedMemory(Arc::new(MemoryBackend::new()));
        let legacy = F2zStorageProvider::new(backend.clone());
        legacy.put_app(b"f2z/version/legacy", &[1]).unwrap();
        legacy
            .put_app(b"f2z/handled/legacy-delivery", b"handled")
            .unwrap();
        legacy
            .put_app(b"f2zmsg/identity", b"plugin identity")
            .unwrap();

        let sealed = F2zProvider::new(backend, [0x5a; 32]).unwrap();
        assert_eq!(
            sealed.store().get_app(b"f2z/version/legacy").unwrap(),
            Some(vec![1])
        );
        assert_eq!(
            sealed
                .store()
                .get_app(b"f2z/handled/legacy-delivery")
                .unwrap(),
            Some(b"handled".to_vec())
        );
        assert_eq!(legacy.get_app(b"f2z/version/legacy").unwrap(), None);
        assert_eq!(
            legacy.get_app(b"f2z/handled/legacy-delivery").unwrap(),
            None
        );
        assert_eq!(
            legacy.get_app(b"f2zmsg/identity").unwrap(),
            Some(b"plugin identity".to_vec()),
            "migration must preserve the plugin's separate application records"
        );
    }
}
