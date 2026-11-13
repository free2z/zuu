//! These call the shipping library compiled WITHOUT cfg(test). Native OS dialogs
//! and device keys still require hardware evidence; these fixtures prove real
//! SQLite/ZIP32 recovery, persistence, metadata matching and refusal semantics.
use secrecy::SecretVec;
use std::sync::Arc;
use tauri_plugin_zcash::wallet::{
    WalletState,
    keychain::{SecureStore, SecureStoreError, SeedStore},
    phone, storage,
};
use zcash_client_backend::data_api::{AccountBirthday, WalletRead, chain::ChainState};
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::{BlockHeight, Network};
use zeroize::Zeroizing;

struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("zuuli-phone-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
struct Absent;
impl SecureStore for Absent {
    fn inspect(&self, _: &str) -> &'static str {
        "missingKey"
    }
    fn store(&self, _: &str, _: &str) -> Result<(), SecureStoreError> {
        panic!("no implicit custody creation")
    }
    fn get(&self, _: &str) -> Result<Zeroizing<String>, SecureStoreError> {
        Err(SecureStoreError::NotFound)
    }
    fn delete(&self, _: &str) -> Result<(), SecureStoreError> {
        panic!("no implicit custody deletion")
    }
}
fn birthday(height: u32) -> AccountBirthday {
    AccountBirthday::from_parts(
        ChainState::empty(BlockHeight::from_u32(height - 1), BlockHash([0; 32])),
        Some(BlockHeight::from_u32(height + 100)),
    )
}

#[test]
fn production_restore_keeps_sparse_derivations_birthdays_addresses_across_restart() {
    let dir = Directory::new();
    let path = dir.0.join("wallet_fixture.sqlite");
    let network = Network::MainNetwork;
    let seed = SecretVec::new(vec![73; 64]);
    let mut db = storage::init_wallet_db(&path, network).unwrap();
    let accounts = [
        (100, birthday(419230)),
        (0, birthday(419200)),
        (7, birthday(419220)),
    ];
    phone::import_accounts(&mut db, &seed, &accounts).unwrap();
    use zcash_client_backend::data_api::Account;
    let primary = tauri_plugin_zcash::wallet::accounts::ordered_account_ids(&db).unwrap()[0];
    assert_eq!(
        u32::from(
            db.get_account(primary)
                .unwrap()
                .unwrap()
                .source()
                .key_derivation()
                .unwrap()
                .account_index()
        ),
        0
    );
    let original = phone::read_plan(&db, &path, network).unwrap();
    assert_eq!(
        original
            .accounts
            .iter()
            .map(|a| a.index)
            .collect::<Vec<_>>(),
        [0, 7, 100]
    );
    assert_eq!(
        original
            .accounts
            .iter()
            .map(|a| a.birthday)
            .collect::<Vec<_>>(),
        [419200, 419220, 419230]
    );
    original.validate_seed(&[73; 64], network).unwrap();
    assert!(original.validate_seed(&[74; 64], network).is_err());
    assert!(original.validate(Network::TestNetwork).is_err());
    assert!(phone::import_accounts(&mut db, &seed, &accounts).is_err());
    assert_eq!(
        db.get_account_ids().unwrap().len(),
        3,
        "retry cannot add duplicate accounts"
    );
    drop(db);
    let reopened = storage::open_existing_wallet_db(&path, network).unwrap();
    assert!(original.matches(&phone::read_plan(&reopened, &path, network).unwrap()));
    let restore_path = dir.0.join("wallet_recovered.sqlite");
    let mut restored = storage::init_wallet_db(&restore_path, network).unwrap();
    phone::import_accounts(&mut restored, &seed, &accounts).unwrap();
    let restored_plan = phone::read_plan(&restored, &restore_path, network).unwrap();
    assert!(original.matches(&restored_plan));
    let mut missing = restored_plan.clone();
    missing.accounts.pop();
    assert!(!original.matches(&missing));
    let mut wrong_birthday = restored_plan.clone();
    wrong_birthday.accounts[1].birthday += 1;
    assert!(!original.matches(&wrong_birthday));
    let mut unknown_version = original.clone();
    unknown_version.version = 2;
    assert!(unknown_version.validate(network).is_err());
    let mut unsupported_primary = original.clone();
    unsupported_primary.accounts.remove(0);
    assert!(unsupported_primary.validate(network).is_err());
    let mut duplicate = original.clone();
    duplicate.accounts.push(duplicate.accounts[0].clone());
    assert!(duplicate.validate(network).is_err());
    let mut expected_history = original.clone();
    expected_history.history.push("ab".repeat(32));
    assert!(
        !expected_history.matches(&restored_plan),
        "empty target history is not recovery proof"
    );
    // A copied DB with reordered creation history uses the same explicit
    // ordering contract as native readers and production send callers.
    use zcash_client_backend::data_api::WalletWrite;
    let unordered_path = dir.0.join("wallet_unordered.sqlite");
    let mut unordered = storage::init_wallet_db(&unordered_path, network).unwrap();
    for index in [7, 0] {
        unordered
            .import_account_hd(
                "Fixture",
                &seed,
                zip32::AccountId::try_from(index).unwrap(),
                &birthday(419200),
                None,
            )
            .unwrap();
    }
    assert!(phone::read_plan(&unordered, &unordered_path, network).is_ok());
    // Real shipping WalletState readers on a mainnet-encoded, three-account
    // fixture. No network or native secret read is permitted by this fixture.
    std::fs::write(dir.0.join("wallets.json"), serde_json::to_vec(&serde_json::json!({
        "wallets": [{"id":"00000000-0000-4000-8000-000000000001","name":"Fixture","db_filename":"wallet_fixture.sqlite","birthday_height":419200,"created_at":"fixture"}],
        "active_wallet_id":"00000000-0000-4000-8000-000000000001"
    })).unwrap()).unwrap();
    let native = WalletState::new(
        dir.0.clone(),
        network,
        SeedStore::new(dir.0.clone(), Arc::new(Absent)),
    )
    .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let listed = tauri_plugin_zcash::wallet::accounts::list_accounts(&native)
            .await
            .unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|a| a.name.as_deref().unwrap())
                .collect::<Vec<_>>(),
            ["Account 0", "Account 7", "Account 100"]
        );
        let _guard = native.lock_wallet_transition().await;
        let snapshot = phone::snapshot(&native, false).await.unwrap();
        assert!(original.matches(&snapshot.plan));
        assert!(
            !snapshot.sync_current,
            "a recovered custody/database fixture is not full synchronization proof"
        );
        assert!(
            !snapshot.recovery_usable,
            "a read-only snapshot cannot attest custody"
        );
    });
}

#[tokio::test]
async fn corrupt_manifest_startup_preserves_data_and_refuses_an_empty_wallet_snapshot() {
    let dir = Directory::new();
    let bytes = b"corrupt original wallet manifest";
    std::fs::write(dir.0.join("wallets.json"), bytes).unwrap();
    std::fs::write(
        dir.0.join("pending-send-original"),
        b"unknown-payment-fixture",
    )
    .unwrap();
    let state = WalletState::new(
        dir.0.clone(),
        Network::MainNetwork,
        SeedStore::new(dir.0.clone(), Arc::new(Absent)),
    )
    .unwrap();
    assert!(state.startup_blocked);
    assert!(!state.is_initialized().await);
    assert!(phone::snapshot(&state, false).await.is_err());
    assert_eq!(std::fs::read(dir.0.join("wallets.json")).unwrap(), bytes);
    assert_eq!(
        std::fs::read(dir.0.join("pending-send-original")).unwrap(),
        b"unknown-payment-fixture"
    );
}

#[test]
fn custody_errors_do_not_echo_backend_diagnostics() {
    let private = "private diagnostic recovery contents";
    let error = tauri_plugin_zcash::Error::from(SecureStoreError::Backend(private.into()));
    assert!(!error.to_string().contains(private));
    for state in [
        SecureStoreError::NotFound,
        SecureStoreError::Locked,
        SecureStoreError::Corrupt,
        SecureStoreError::AuthenticationFailed,
        SecureStoreError::AuthCancelled,
    ] {
        assert!(
            tauri_plugin_zcash::Error::from(state)
                .to_string()
                .starts_with("key derivation error: secure custody:")
        );
    }
}

#[cfg(feature = "production-route-probe")]
#[tokio::test]
async fn real_received_note_history_cannot_be_mistaken_for_an_empty_restore() {
    use zcash_client_backend::data_api::testing::{orchard::OrchardPoolTester, pool::dsl::TestDsl};
    use zcash_client_sqlite::testing::{BlockCache, db::TestDbFactory};
    use zcash_protocol::value::Zatoshis;
    let mut fixture =
        TestDsl::with_sapling_birthday_account(TestDbFactory::file_backed(), BlockCache::new())
            .build::<OrchardPoolTester>();
    let sibling_seed = SecretVec::new(fixture.test_seed().unwrap().expose_secret().clone());
    let sibling_birthday = fixture.get_account().birthday().clone();
    phone::import_accounts(
        fixture.wallet_mut(),
        &sibling_seed,
        &[(7, sibling_birthday.clone())],
    )
    .unwrap();
    fixture
        .wallet_mut()
        .conn_mut()
        .execute(
            "UPDATE accounts SET uuid = ?1 WHERE hd_account_index = 7",
            [[0_u8; 16].as_slice()],
        )
        .unwrap();
    fixture.add_a_single_note_checking_balance(Zatoshis::const_from_u64(90_000));
    fixture.add_empty_blocks(10);
    use zcash_client_backend::data_api::Account;
    let account = fixture.get_account();
    assert!(
        account.source().key_derivation().is_some(),
        "fixture HD derivation"
    );
    assert!(account.ufvk().is_some(), "fixture viewing authority");
    let conn = fixture.wallet().conn();
    let _: u32 = conn
        .query_row(
            "SELECT COUNT(*) FROM v_transactions WHERE COALESCE(expired_unmined,0)=0",
            [],
            |row| row.get(0),
        )
        .expect("history view query");
    let path = std::path::Path::new(conn.path().unwrap());
    let original = phone::read_plan(fixture.wallet(), path, Network::TestNetwork).unwrap();
    assert_eq!(
        original.history.len(),
        1,
        "real received funds create real history in the shipping view"
    );
    let mut empty = original.clone();
    empty.history.clear();
    assert!(!original.matches(&empty));
    assert!(original.matches(&original));
    // A real new database reimports native root custody and rescans retained
    // controlled blocks. The original database handle remains alive throughout.
    use secrecy::ExposeSecret;
    use zcash_client_backend::data_api::WalletWrite;
    let seed = SecretVec::new(fixture.test_seed().unwrap().expose_secret().clone());
    let birthday = account.birthday().clone();
    let start = birthday.height();
    let tip = fixture.wallet().chain_height().unwrap().unwrap();
    let _original_wallet = fixture.reset();
    // Upstream Reset deliberately selects an in-memory store even when the
    // source factory was file-backed. Production history uses a sibling read
    // connection, so the restored fixture must explicitly be file-backed too.
    use zcash_client_backend::data_api::testing::DataStoreFactory;
    let replacement = TestDbFactory::file_backed()
        .new_data_store(*fixture.network(), None, None)
        .unwrap();
    *fixture.wallet_mut() = replacement;
    phone::import_accounts(
        fixture.wallet_mut(),
        &seed,
        &[(7, sibling_birthday), (0, birthday)],
    )
    .unwrap();
    fixture.wallet_mut().update_chain_tip(tip).unwrap();
    let restored_path = std::path::PathBuf::from(fixture.wallet().conn().path().unwrap());
    let before_scan =
        phone::read_plan(fixture.wallet(), &restored_path, Network::TestNetwork).unwrap();
    assert!(
        !original.matches(&before_scan),
        "custody import alone cannot satisfy history recovery"
    );
    fixture.scan_cached_blocks(start, (u32::from(tip) - u32::from(start) + 1) as usize);
    let after_scan =
        phone::read_plan(fixture.wallet(), &restored_path, Network::TestNetwork).unwrap();
    assert!(original.matches(&after_scan));
    let recovered_value: i64 = fixture
        .wallet()
        .conn()
        .query_row(
            "SELECT SUM(account_balance_delta) FROM v_transactions",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(recovered_value, 90_000);
    // Exercise shipping WalletState account/history readers on the recovered
    // funded database, not only the metadata helper or a synthetic SQL view.
    let native_dir = Directory::new();
    let native_path = native_dir.0.join("wallet_native.sqlite");
    fixture
        .wallet()
        .conn()
        .execute("VACUUM INTO ?1", [native_path.to_str().unwrap()])
        .unwrap();
    // The DSL uses regtest; WalletState supports main/test only. Re-encode
    // fixture UFVKs with the testnet HRP using the library, not new keys. This
    // proves native readers, not chain interoperability or real-device restore.
    let native_connection = rusqlite::Connection::open(&native_path).unwrap();
    for id in fixture.wallet().get_account_ids().unwrap() {
        let account = fixture.wallet().get_account(id).unwrap().unwrap();
        let index = u32::from(account.source().key_derivation().unwrap().account_index());
        native_connection
            .execute(
                "UPDATE accounts SET ufvk = ?1 WHERE hd_account_index = ?2",
                rusqlite::params![account.ufvk().unwrap().encode(&Network::TestNetwork), index],
            )
            .unwrap();
    }
    drop(native_connection);
    std::fs::write(native_dir.0.join("wallets.json"), serde_json::to_vec(&serde_json::json!({
        "wallets": [{"id":"00000000-0000-4000-8000-000000000001","name":"Fixture","db_filename":"wallet_native.sqlite","birthday_height":1,"created_at":"fixture"}],
        "active_wallet_id":"00000000-0000-4000-8000-000000000001"
    })).unwrap()).unwrap();
    let native = WalletState::new(
        native_dir.0.clone(),
        Network::TestNetwork,
        SeedStore::new(native_dir.0.clone(), Arc::new(Absent)),
    )
    .unwrap();
    assert!(native.is_initialized().await);
    let primary_history =
        tauri_plugin_zcash::wallet::history::get_transaction_history(&native, 0, 0, 20)
            .await
            .unwrap();
    assert_eq!(primary_history.len(), 1);
    assert_eq!(primary_history[0].value, 90_000);
    assert!(
        tauri_plugin_zcash::wallet::history::get_transaction_history(&native, 1, 0, 20)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn missing_manifest_database_blocks_creation_without_replacing_any_file() {
    let dir = Directory::new();
    let manifest = serde_json::json!({
        "wallets": [{"id":"00000000-0000-4000-8000-000000000001","name":"Fixture","db_filename":"wallet_missing.sqlite","birthday_height":419200,"created_at":"fixture"}],
        "active_wallet_id":"00000000-0000-4000-8000-000000000001"
    });
    let bytes = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(dir.0.join("wallets.json"), &bytes).unwrap();
    let state = WalletState::new(
        dir.0.clone(),
        Network::MainNetwork,
        SeedStore::new(dir.0.clone(), Arc::new(Absent)),
    )
    .unwrap();
    assert!(state.startup_blocked);
    assert!(!dir.0.join("wallet_missing.sqlite").exists());
    assert_eq!(std::fs::read(dir.0.join("wallets.json")).unwrap(), bytes);
}

#[tokio::test]
async fn orphaned_recovery_files_without_a_manifest_never_become_a_new_empty_wallet() {
    let dir = Directory::new();
    std::fs::create_dir(dir.0.join(".seeds")).unwrap();
    let path = dir.0.join(".seeds/fixture.enc");
    std::fs::write(&path, b"opaque encrypted recovery fixture").unwrap();
    let state = WalletState::new(
        dir.0.clone(),
        Network::MainNetwork,
        SeedStore::new(dir.0.clone(), Arc::new(Absent)),
    )
    .unwrap();
    assert!(state.startup_blocked);
    assert!(!dir.0.join("wallets.json").exists());
    assert_eq!(
        std::fs::read(path).unwrap(),
        b"opaque encrypted recovery fixture"
    );
}

#[tokio::test]
async fn native_ciphertext_inventory_without_any_wallet_file_blocks_empty_startup() {
    struct RestoredNativeInventory;
    impl SecureStore for RestoredNativeInventory {
        fn inventory(&self) -> &'static str {
            "present"
        }
        fn store(&self, _: &str, _: &str) -> Result<(), SecureStoreError> {
            panic!("no replacement custody")
        }
        fn get(&self, _: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            panic!("inventory must never read custody")
        }
        fn delete(&self, _: &str) -> Result<(), SecureStoreError> {
            panic!("no deletion of restored ciphertext")
        }
    }
    let dir = Directory::new();
    let state = WalletState::new(
        dir.0.clone(),
        Network::MainNetwork,
        SeedStore::new(dir.0.clone(), Arc::new(RestoredNativeInventory)),
    )
    .unwrap();
    assert!(state.startup_blocked);
    assert!(std::fs::read_dir(&dir.0).unwrap().next().is_none());
}

#[test]
fn native_relink_never_overwrites_or_deletes_existing_recovery_material() {
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    struct NativeFixture {
        record: Mutex<Option<String>>,
        writes: AtomicUsize,
    }
    impl SecureStore for NativeFixture {
        fn store(&self, _: &str, phrase: &str) -> Result<(), SecureStoreError> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            *self.record.lock().unwrap() = Some(phrase.into());
            Ok(())
        }
        fn get(&self, _: &str) -> Result<Zeroizing<String>, SecureStoreError> {
            self.record
                .lock()
                .unwrap()
                .clone()
                .map(Zeroizing::new)
                .ok_or(SecureStoreError::NotFound)
        }
        fn delete(&self, _: &str) -> Result<(), SecureStoreError> {
            panic!("relink must not delete custody")
        }
    }
    let dir = Directory::new();
    let backend = Arc::new(NativeFixture {
        record: Mutex::new(Some("opaque-preserved-native-record".into())),
        writes: AtomicUsize::new(0),
    });
    let store = SeedStore::new(dir.0.clone(), backend.clone());
    let id = "00000000-0000-4000-8000-000000000001";
    assert!(
        store
            .relink_seed_preserving_existing(id, "replacement-fixture")
            .is_err()
    );
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
    assert!(backend.record.lock().unwrap().as_deref() == Some("opaque-preserved-native-record"));
    store
        .relink_seed_preserving_existing(id, "opaque-preserved-native-record")
        .unwrap();
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
    *backend.record.lock().unwrap() = None;
    store
        .relink_seed_preserving_existing(id, "replacement-fixture")
        .unwrap();
    store
        .relink_seed_preserving_existing(id, "replacement-fixture")
        .unwrap();
    assert_eq!(
        backend.writes.load(Ordering::SeqCst),
        1,
        "repeated imports do not replace native custody"
    );
}
