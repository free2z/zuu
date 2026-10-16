//! Public-API and storage migration regression controls for issue #903.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use f2z_msg_mls::{CIPHERSUITE, DeviceCredential, DeviceSigner, MlsEngine};
use f2z_msg_store::{
    Durability, F2zStorageProvider, MemoryBackend, Op, SqliteBackend, StorageBackend,
};
use openmls::prelude::tls_codec::Serialize as _;
use openmls::prelude::{BasicCredential, CredentialWithKey, GroupId, KeyPackage, MlsGroup};
use openmls_libcrux_crypto::CryptoProvider;
use openmls_traits::OpenMlsProvider;

mod common;

const SEALED_PREFIX: &[u8] = b"\0f2z-mls-sealed-v1/";
const OLD_VISIBLE_PREFIX: &[u8] = b"f2z/mls/store/v1/";

#[derive(Clone)]
struct SharedBackend {
    inner: Arc<MemoryBackend>,
    observed: Arc<Mutex<BTreeMap<Vec<u8>, Vec<u8>>>>,
}

impl SharedBackend {
    fn new() -> Self {
        Self {
            inner: Arc::new(MemoryBackend::new()),
            observed: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    fn observed_snapshot(&self) -> BTreeMap<Vec<u8>, Vec<u8>> {
        self.observed.lock().unwrap().clone()
    }
}

impl StorageBackend for SharedBackend {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }

    fn apply(&self, ops: &[Op]) -> f2z_msg_store::Result<()> {
        self.inner.apply(ops)?;
        let mut observed = self.observed.lock().unwrap();
        for op in ops {
            match op {
                Op::Put { key, value } => {
                    observed.insert(key.clone(), value.clone());
                }
                Op::Delete { key } => {
                    observed.remove(key);
                }
            }
        }
        Ok(())
    }

    fn atomic_rewrite(
        &self,
        marker_key: &[u8],
        marker_value: &[u8],
        rewrite: &mut f2z_msg_store::RowRewrite<'_>,
    ) -> f2z_msg_store::Result<()> {
        let mut observed = self.observed.lock().unwrap();
        let mut recording_rewrite = |key: &[u8], value: &[u8]| {
            let replacement = rewrite(key, value)?;
            if let Some((new_key, new_value)) = &replacement {
                observed.insert(new_key.clone(), new_value.clone());
            }
            Ok(replacement)
        };
        self.inner
            .atomic_rewrite(marker_key, marker_value, &mut recording_rewrite)?;
        observed.insert(marker_key.to_vec(), marker_value.to_vec());
        Ok(())
    }

    fn durability(&self) -> Durability {
        self.inner.durability()
    }
}

/// The pre-seal provider shape: ordinary OpenMLS crypto over raw storage.
struct LegacyProvider<B: StorageBackend> {
    crypto: CryptoProvider,
    storage: F2zStorageProvider<B>,
}

impl<B: StorageBackend> LegacyProvider<B> {
    fn new(backend: B) -> Self {
        Self {
            crypto: CryptoProvider::new().unwrap(),
            storage: F2zStorageProvider::new(backend),
        }
    }
}

impl<B: StorageBackend> OpenMlsProvider for LegacyProvider<B> {
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
        &self.crypto
    }
}

fn credential_with_key(credential: &DeviceCredential, signer: &DeviceSigner) -> CredentialWithKey {
    CredentialWithKey {
        credential: BasicCredential::new(f2z_codec::canonical::encode(credential).unwrap()).into(),
        signature_key: signer.public_key().as_slice().into(),
    }
}

#[derive(Clone)]
struct SnapshotBackend(Arc<BTreeMap<Vec<u8>, Vec<u8>>>);

impl StorageBackend for SnapshotBackend {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        Ok(self.0.get(key).cloned())
    }

    fn apply(&self, _ops: &[Op]) -> f2z_msg_store::Result<()> {
        Err(f2z_msg_store::StoreError::Backend(
            "read-only attacker snapshot",
        ))
    }

    fn atomic_rewrite(
        &self,
        _marker_key: &[u8],
        _marker_value: &[u8],
        _rewrite: &mut f2z_msg_store::RowRewrite<'_>,
    ) -> f2z_msg_store::Result<()> {
        Err(f2z_msg_store::StoreError::Backend(
            "read-only attacker snapshot",
        ))
    }

    fn durability(&self) -> Durability {
        Durability::None
    }
}

#[test]
fn a_retained_backend_observer_cannot_reconstruct_an_equivalent_openmls_store() {
    let (credential, signer) = common::issue_credential(
        "alice",
        11,
        111,
        common::NOW - 1_000_000,
        common::NOW + 1_000_000,
    );
    let retained_signer = signer.clone();
    let backend = SharedBackend::new();
    let alice = MlsEngine::new(backend.clone(), signer, credential, common::NOW).unwrap();
    let group = alice.create_group(b"public-bypass").unwrap();
    assert_eq!(
        retained_signer.public_key(),
        alice.credential().credential.device_pk.as_bytes()
    );

    // The retained backend observes the physical keys and values the engine
    // actually wrote, then reconstructs its own exact-key storage adapter.
    let snapshot = backend.observed_snapshot();
    assert!(!snapshot.is_empty());
    assert!(snapshot.keys().all(|key| key.starts_with(SEALED_PREFIX)));
    assert!(snapshot.values().all(|value| value.first() == Some(&1)));
    let reconstructed = F2zStorageProvider::new(SnapshotBackend(Arc::new(snapshot)));
    let raw_group = MlsGroup::load(&reconstructed, &GroupId::from_slice(group.group_id())).unwrap();
    assert!(
        raw_group.is_none(),
        "observed ciphertext must not load as MLS state"
    );

    // A plain provider over the retained shared backend likewise has no raw
    // group keys. The handle API remains able to load the durable group.
    let ordinary = F2zStorageProvider::new(backend);
    assert!(
        MlsGroup::load(&ordinary, &GroupId::from_slice(group.group_id()))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        alice.load_group(group.group_id()).unwrap().unwrap().epoch(),
        0
    );
}

#[test]
fn a_pre_seal_sqlite_store_migrates_atomically_and_remains_usable_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let alice_path = dir.path().join("legacy-alice.sqlite");
    let bob_path = dir.path().join("legacy-bob.sqlite");
    let (alice_credential, alice_signer) = common::issue_credential(
        "alice",
        11,
        111,
        common::NOW - 1_000_000,
        common::NOW + 1_000_000,
    );
    let (bob_credential, bob_signer) = common::issue_credential(
        "bob",
        22,
        222,
        common::NOW - 1_000_000,
        common::NOW + 1_000_000,
    );

    let alice_legacy = LegacyProvider::new(SqliteBackend::open(&alice_path).unwrap());
    let bob_legacy = LegacyProvider::new(SqliteBackend::open(&bob_path).unwrap());
    let mut alice_group = MlsGroup::builder()
        .ciphersuite(CIPHERSUITE)
        .with_group_id(GroupId::from_slice(b"legacy-group"))
        .use_ratchet_tree_extension(true)
        .build(
            &alice_legacy,
            &alice_signer,
            credential_with_key(&alice_credential, &alice_signer),
        )
        .unwrap();
    let bob_package = KeyPackage::builder()
        .build(
            CIPHERSUITE,
            &bob_legacy,
            &bob_signer,
            credential_with_key(&bob_credential, &bob_signer),
        )
        .unwrap();
    // This is the raw pre-#903 Add route used only to populate the legacy
    // durable fixture; the current public API has no corresponding capability.
    let (_commit, welcome, _group_info) = alice_group
        .add_members(
            &alice_legacy,
            &alice_signer,
            &[bob_package.key_package().clone()],
        )
        .unwrap();
    alice_group.merge_pending_commit(&alice_legacy).unwrap();
    let welcome_wire = welcome.tls_serialize_detached().unwrap();
    alice_legacy
        .storage
        .put_app(b"f2z/version/legacy-group", &[1])
        .unwrap();
    bob_legacy
        .storage
        .put_app(b"f2z/handled/legacy-delivery", b"handled")
        .unwrap();
    alice_legacy
        .storage
        .put_app(b"f2zmsg/identity", b"plugin identity")
        .unwrap();
    drop(alice_group);
    drop(bob_package);
    drop(alice_legacy);
    drop(bob_legacy);

    // First-open migration atomically replaces raw rows with authenticated
    // ciphertext. Alice loads the old group; Bob joins through the private
    // KeyPackageBundle secret written by the legacy provider.
    let alice_backend = SqliteBackend::open(&alice_path).unwrap();
    let bob_backend = SqliteBackend::open(&bob_path).unwrap();
    let alice = MlsEngine::new(
        alice_backend,
        alice_signer.clone(),
        alice_credential.clone(),
        common::NOW,
    )
    .unwrap();
    let bob = MlsEngine::new(
        bob_backend,
        bob_signer.clone(),
        bob_credential.clone(),
        common::NOW,
    )
    .unwrap();
    let plugin_records = F2zStorageProvider::new(SqliteBackend::open(&alice_path).unwrap());
    assert_eq!(
        plugin_records.get_app(b"f2zmsg/identity").unwrap(),
        Some(b"plugin identity".to_vec()),
        "legacy upgrade preserves the Tauri plugin's separate application rows"
    );
    let mut alice_group = alice.load_group(b"legacy-group").unwrap().unwrap();
    let mut bob_group = bob.join_from_welcome(&welcome_wire, common::NOW).unwrap();
    assert_eq!(alice_group.group_id(), bob_group.group_id());
    assert_eq!(alice_group.epoch(), bob_group.epoch());

    let wire = alice.send(&mut alice_group, b"after migration").unwrap();
    let received = bob
        .receive(
            &mut bob_group,
            &wire,
            b"post-migration-delivery",
            common::NOW,
        )
        .unwrap();
    assert!(matches!(
        received,
        f2z_msg_mls::Received::Application { .. }
    ));
    let reply = bob.send(&mut bob_group, b"restart still works").unwrap();
    let received = alice
        .receive(
            &mut alice_group,
            &reply,
            b"post-restart-delivery",
            common::NOW,
        )
        .unwrap();
    assert!(matches!(
        received,
        f2z_msg_mls::Received::Application { .. }
    ));

    drop(alice_group);
    drop(bob_group);
    drop(alice);
    drop(bob);
    let alice_reopened = MlsEngine::new(
        SqliteBackend::open(&alice_path).unwrap(),
        alice_signer,
        alice_credential,
        common::NOW,
    )
    .unwrap();
    let bob_reopened = MlsEngine::new(
        SqliteBackend::open(&bob_path).unwrap(),
        bob_signer,
        bob_credential,
        common::NOW,
    )
    .unwrap();
    let alice_group = alice_reopened.load_group(b"legacy-group").unwrap().unwrap();
    let bob_group = bob_reopened.load_group(b"legacy-group").unwrap().unwrap();
    assert_eq!(alice_group.epoch(), bob_group.epoch());
    assert!(alice_group.epoch() >= 1);
}

#[test]
fn failed_legacy_migration_leaves_the_only_raw_group_copy_loadable() {
    let (credential, signer) = common::issue_credential(
        "alice",
        11,
        111,
        common::NOW - 1_000_000,
        common::NOW + 1_000_000,
    );
    let backend = SharedBackend::new();
    let legacy = LegacyProvider::new(backend.clone());
    let group = MlsGroup::builder()
        .ciphersuite(CIPHERSUITE)
        .with_group_id(GroupId::from_slice(b"faulted-legacy-group"))
        .use_ratchet_tree_extension(true)
        .build(&legacy, &signer, credential_with_key(&credential, &signer))
        .unwrap();
    drop(group);
    drop(legacy);

    let refusing = RefuseMigrationOnce {
        inner: backend.clone(),
        refuse: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    };
    assert!(MlsEngine::new(refusing, signer.clone(), credential.clone(), common::NOW).is_err());
    let raw = F2zStorageProvider::new(backend.clone());
    assert!(
        MlsGroup::load(&raw, &GroupId::from_slice(b"faulted-legacy-group"))
            .unwrap()
            .is_some()
    );

    let recovered = MlsEngine::new(backend, signer, credential, common::NOW).unwrap();
    assert!(
        recovered
            .load_group(b"faulted-legacy-group")
            .unwrap()
            .is_some()
    );
}

#[derive(Clone)]
struct RefuseMigrationOnce {
    inner: SharedBackend,
    refuse: Arc<std::sync::atomic::AtomicBool>,
}

impl StorageBackend for RefuseMigrationOnce {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }

    fn apply(&self, ops: &[Op]) -> f2z_msg_store::Result<()> {
        self.inner.apply(ops)
    }

    fn atomic_rewrite(
        &self,
        marker_key: &[u8],
        marker_value: &[u8],
        rewrite: &mut f2z_msg_store::RowRewrite<'_>,
    ) -> f2z_msg_store::Result<()> {
        if self.refuse.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err(f2z_msg_store::StoreError::Backend(
                "injected atomic migration refusal",
            ));
        }
        self.inner.atomic_rewrite(marker_key, marker_value, rewrite)
    }

    fn durability(&self) -> Durability {
        self.inner.durability()
    }
}

#[test]
fn visible_prefix_only_storage_is_reconstructible_by_a_backend_clone() {
    let (credential, signer) = common::issue_credential(
        "alice",
        11,
        111,
        common::NOW - 1_000_000,
        common::NOW + 1_000_000,
    );
    let backend = SharedBackend::new();
    let legacy = LegacyProvider::new(backend.clone());
    let group = MlsGroup::builder()
        .ciphersuite(CIPHERSUITE)
        .with_group_id(GroupId::from_slice(b"prefix-only-bypass"))
        .use_ratchet_tree_extension(true)
        .build(&legacy, &signer, credential_with_key(&credential, &signer))
        .unwrap();
    drop(group);
    drop(legacy);

    // Recreate the previous prefix-only format from the raw rows. Its prefix
    // and plaintext values are visible to any retained backend observer.
    let mut prefix_rows = BTreeMap::new();
    let mut visible_prefix = OLD_VISIBLE_PREFIX.to_vec();
    visible_prefix.extend_from_slice(&[7; 32]);
    let mut copy_rows = |key: &[u8], value: &[u8]| {
        prefix_rows.insert([visible_prefix.as_slice(), key].concat(), value.to_vec());
        Ok(None)
    };
    // MemoryBackend's atomic rewrite provides a consistent read-only walk by
    // returning None for each row; this deliberately writes a marker only to a
    // throwaway key in a freshly constructed source database.
    let raw_rows = backend.clone();
    raw_rows
        .atomic_rewrite(b"fixture-walk-marker", b"fixture", &mut copy_rows)
        .unwrap();

    struct StripVisiblePrefix {
        rows: Arc<BTreeMap<Vec<u8>, Vec<u8>>>,
        prefix: Vec<u8>,
    }
    impl StorageBackend for StripVisiblePrefix {
        fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
            Ok(self
                .rows
                .get(&[self.prefix.as_slice(), key].concat())
                .cloned())
        }
        fn apply(&self, _ops: &[Op]) -> f2z_msg_store::Result<()> {
            Ok(())
        }
        fn atomic_rewrite(
            &self,
            _marker_key: &[u8],
            _marker_value: &[u8],
            _rewrite: &mut f2z_msg_store::RowRewrite<'_>,
        ) -> f2z_msg_store::Result<()> {
            Ok(())
        }
        fn durability(&self) -> Durability {
            Durability::None
        }
    }
    let stripped_storage = F2zStorageProvider::new(StripVisiblePrefix {
        rows: Arc::new(prefix_rows),
        prefix: visible_prefix,
    });
    let mut reconstructed = MlsGroup::load(
        &stripped_storage,
        &GroupId::from_slice(b"prefix-only-bypass"),
    )
    .unwrap()
    .expect("stripping the visible namespace restores the raw group");
    let (bob_credential, bob_signer) = common::issue_credential(
        "bob",
        22,
        222,
        common::NOW - 1_000_000,
        common::NOW + 1_000_000,
    );
    let bob_legacy = LegacyProvider::new(SharedBackend::new());
    let bob_package = KeyPackage::builder()
        .build(
            CIPHERSUITE,
            &bob_legacy,
            &bob_signer,
            credential_with_key(&bob_credential, &bob_signer),
        )
        .unwrap();
    let stripped_provider = LegacyProvider {
        crypto: CryptoProvider::new().unwrap(),
        storage: stripped_storage,
    };
    reconstructed
        .add_members(
            &stripped_provider,
            &signer,
            &[bob_package.key_package().clone()],
        )
        .unwrap();
    assert!(reconstructed.pending_commit().is_some());
    reconstructed
        .merge_pending_commit(&stripped_provider)
        .unwrap();
    assert_eq!(reconstructed.epoch().as_u64(), 1);
}
