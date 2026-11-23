use rand::{SeedableRng, rngs::StdRng};
use sapling::note_encryption::SaplingDomain;
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_note_encryption::Domain;
use zcash_primitives::transaction::{Authorized, TransactionData};
use zcash_protocol::{
    consensus::{BranchId, MAIN_NETWORK},
    value::ZatBalance,
};
use zip32::{AccountId, Scope};

const HEIGHT: u32 = 3_500_000;
const VALUE: u64 = 1_234_567;

fn test_ufvk(seed_byte: u8) -> UnifiedFullViewingKey {
    UnifiedSpendingKey::from_seed(&MAIN_NETWORK, &[seed_byte; 32], AccountId::ZERO)
        .unwrap()
        .to_unified_full_viewing_key()
}

fn sapling_bundle(
    ufvk: &UnifiedFullViewingKey,
    scope: Scope,
    memo: [u8; 512],
) -> sapling::Bundle<sapling::bundle::Authorized, ZatBalance> {
    let dfvk = ufvk.sapling().unwrap();
    let recipient = match scope {
        Scope::External => dfvk.default_address().1,
        Scope::Internal => dfvk.change_address().1,
    };
    let note = sapling::Note::from_parts(
        recipient,
        sapling::value::NoteValue::from_raw(VALUE),
        sapling::Rseed::AfterZip212([42; 32]),
    );
    let cv = sapling::value::ValueCommitment::derive(
        note.value(),
        sapling::value::ValueCommitTrapdoor::from_bytes([0; 32]).unwrap(),
    );
    let cmu = note.cmu();
    let mut rng = StdRng::seed_from_u64(123);
    let encryptor = sapling::note_encryption::sapling_note_encryption(
        Some(dfvk.fvk().ovk),
        note,
        memo,
        &mut rng,
    );
    let epk = SaplingDomain::epk_bytes(encryptor.epk());
    let output = sapling::bundle::OutputDescription::from_parts(
        cv.clone(),
        cmu,
        epk,
        encryptor.encrypt_note_plaintext().0,
        encryptor.encrypt_outgoing_plaintext(&cv, &cmu, &mut rng),
        [0; 192],
    );
    sapling::Bundle::from_parts(
        vec![],
        vec![output],
        ZatBalance::from_i64(-(VALUE as i64)).unwrap(),
        sapling::bundle::Authorized {
            binding_sig: [0; 64].into(),
        },
    )
    .unwrap()
}

#[test]
fn consumed_enhancement_recovers_full_memo_through_production_api() {
    let mut memo = [0; 512];
    memo[..16].copy_from_slice(b"synthetic memo!!");
    consumed_enhancement_fixture(memo, b"synthetic memo!!");
    let mut no_memo = [0; 512];
    no_memo[0] = 0xf6;
    consumed_enhancement_fixture(no_memo, &[0xf6]);
}

fn consumed_enhancement_fixture(memo: [u8; 512], expected: &[u8]) {
    use rand::{rand_core::UnwrapErr, rngs::SysRng};
    use zcash_client_backend::{
        data_api::{
            AccountBirthday, AccountPurpose, TransactionDataRequest, TransactionStatus, WalletRead,
            WalletWrite, chain::ChainState,
        },
        proto::service::RawTransaction,
    };
    use zcash_client_sqlite::{WalletDb, util::SystemClock, wallet::init::init_wallet_db};
    use zcash_protocol::consensus::Network;
    use zcash_wallet_recovery::wallet_recovery::apply_response;
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = temp.path().join("wallet.sqlite");
    let open =
        || WalletDb::for_path(&path, Network::MainNetwork, SystemClock, UnwrapErr(SysRng)).unwrap();
    let mut db = open();
    init_wallet_db(&mut db, None).unwrap();
    let ufvk = test_ufvk(7);
    let birthday = AccountBirthday::from_parts(
        ChainState::empty(
            (HEIGHT - 1).into(),
            zcash_primitives::block::BlockHash([0; 32]),
        ),
        None,
    );
    db.import_account_ufvk("fixture", &ufvk, &birthday, AccountPurpose::ViewOnly, None)
        .unwrap();
    db.update_chain_tip(HEIGHT.into()).unwrap();
    // A non-coinbase input with an unknown prevout keeps fee derivation
    // unavailable, as it is for a normal received shielding transaction.
    // These synthetic authorization bytes must never be broadcast.
    let tx = TransactionData::<Authorized>::from_parts_v6(
        BranchId::for_height(&MAIN_NETWORK, HEIGHT.into()),
        0,
        (HEIGHT + 40).into(),
        Some(transparent::bundle::Bundle {
            vin: vec![transparent::bundle::TxIn::from_parts(
                transparent::bundle::OutPoint::new([91; 32], 0),
                transparent::address::Script::default(),
                u32::MAX,
            )],
            vout: vec![],
            authorization: transparent::bundle::Authorized,
        }),
        Some(sapling_bundle(&ufvk, Scope::External, memo)),
        None,
        None,
    )
    .freeze()
    .unwrap();
    let txid = tx.txid();
    // Seed the compact-scan transaction/request fixture. Test SQL is never
    // used for recovery: the production function below only uses wallet APIs.
    let conn = rusqlite::Connection::open(&path).unwrap();
    // Build compact-scan-equivalent fixture state from a real received note.
    // This fixture setup SQL is never part of production recovery.
    zcash_client_backend::data_api::wallet::decrypt_and_store_transaction(
        &Network::MainNetwork,
        &mut db,
        &tx,
        Some(HEIGHT.into()),
    )
    .unwrap();
    conn.execute(
        "UPDATE transactions SET raw=NULL WHERE txid=?1",
        [txid.as_ref()],
    )
    .unwrap();
    conn.execute("UPDATE sapling_received_notes SET memo=NULL", [])
        .unwrap();
    conn.execute(
        "INSERT INTO tx_retrieval_queue(txid,query_type) VALUES(?1,1)",
        [txid.as_ref()],
    )
    .unwrap();
    assert!(
        db.transaction_data_requests()
            .unwrap()
            .contains(&TransactionDataRequest::Enhancement(txid))
    );
    // This is the selected devtool's exact NotFound branch, not our repair.
    db.set_transaction_status(txid, TransactionStatus::TxidNotRecognized)
        .unwrap();
    assert!(
        !db.transaction_data_requests()
            .unwrap()
            .contains(&TransactionDataRequest::Enhancement(txid))
    );
    assert!(
        !apply_response(
            &mut db,
            Network::MainNetwork,
            txid.as_ref(),
            HEIGHT.into(),
            Err(tonic::Status::not_found("fixture"))
        )
        .unwrap()
    );
    drop(db);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut db =
        zcash_wallet_recovery::wallet_recovery::open_recovery_wallet(&path, Network::MainNetwork)
            .unwrap(); // restart with shipping schema/network gate
    assert!(
        zcash_wallet_recovery::wallet_recovery::open_recovery_wallet(&path, Network::TestNetwork)
            .is_err()
    );
    assert!(
        zcash_wallet_recovery::wallet_recovery::validate_received(&db, &[99; 32], HEIGHT.into())
            .is_err()
    );
    assert!(
        zcash_wallet_recovery::wallet_recovery::validate_received(
            &db,
            txid.as_ref(),
            (HEIGHT + 1).into()
        )
        .is_err()
    );
    conn.execute(
        "INSERT INTO transactions(txid,mined_height,min_observed_height) VALUES(?1,?2,?2)",
        rusqlite::params![[98u8; 32].as_slice(), HEIGHT],
    )
    .unwrap();
    assert!(
        zcash_wallet_recovery::wallet_recovery::validate_received(&db, &[98; 32], HEIGHT.into())
            .is_err()
    );
    let mut raw = vec![];
    tx.write(&mut raw).unwrap();
    assert!(
        apply_response(
            &mut db,
            Network::MainNetwork,
            &[99; 32],
            HEIGHT.into(),
            Ok(RawTransaction {
                data: raw.clone(),
                height: u64::from(HEIGHT)
            })
        )
        .is_err()
    );
    assert!(
        apply_response(
            &mut db,
            Network::MainNetwork,
            txid.as_ref(),
            HEIGHT.into(),
            Ok(RawTransaction {
                data: raw.clone(),
                height: u64::from(HEIGHT + 1)
            })
        )
        .is_err()
    );
    for _ in 0..2 {
        // duplicate provider delivery uses the actual shipping caller
        assert!(
            apply_response(
                &mut db,
                Network::MainNetwork,
                txid.as_ref(),
                HEIGHT.into(),
                Ok(RawTransaction {
                    data: raw.clone(),
                    height: u64::from(HEIGHT)
                })
            )
            .unwrap()
        );
    }
    let (stored, count): (Vec<u8>, i64) = conn
        .query_row(
            "SELECT memo,(SELECT count(*) FROM sapling_received_notes) FROM sapling_received_notes",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, expected);
    assert_eq!(count, 1);
    assert!(db.transaction_data_requests().unwrap().is_empty());
}

#[test]
fn recovery_rejects_captured_prerelease_schema_without_migration_or_writes() {
    let temp = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = temp.path().join("incompatible.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    // Existing public structural fixture, no operational data. This is not
    // evidence of compatibility with the exact deployed pre-release binary.
    conn.execute_batch(include_str!(
        "../../../py/free2z/zcashrpc/testdata/wallet-schema.sql"
    ))
    .unwrap();
    drop(conn);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    assert!(
        zcash_wallet_recovery::wallet_recovery::open_recovery_wallet(
            &path,
            zcash_protocol::consensus::Network::MainNetwork
        )
        .is_err()
    );
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[cfg(unix)]
#[test]
fn recovery_rejects_wallet_paths_writable_by_less_trusted_users() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = temp.path().join("wallet.sqlite");
    rusqlite::Connection::open(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        zcash_wallet_recovery::wallet_recovery::open_recovery_wallet(
            &path,
            zcash_protocol::consensus::Network::MainNetwork
        )
        .is_err()
    );

    std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        zcash_wallet_recovery::wallet_recovery::open_recovery_wallet(
            &path,
            zcash_protocol::consensus::Network::MainNetwork
        )
        .is_err()
    );

    let writable_ancestor = temp.path().join("writable-ancestor");
    std::fs::create_dir(&writable_ancestor).unwrap();
    std::fs::set_permissions(&writable_ancestor, std::fs::Permissions::from_mode(0o777)).unwrap();
    let private_child = writable_ancestor.join("wallet");
    std::fs::create_dir(&private_child).unwrap();
    std::fs::set_permissions(&private_child, std::fs::Permissions::from_mode(0o700)).unwrap();
    let nested_wallet = private_child.join("wallet.sqlite");
    rusqlite::Connection::open(&nested_wallet).unwrap();
    std::fs::set_permissions(&nested_wallet, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        zcash_wallet_recovery::wallet_recovery::open_recovery_wallet(
            &nested_wallet,
            zcash_protocol::consensus::Network::MainNetwork
        )
        .is_err()
    );
}
