//! Real note encryption fixtures with deliberately invalid authorization data.
//! NEVER submit these transactions. They test parsing and viewing-key decryption;
//! consensus validation remains the responsibility of the trusted Zakura node.
//!
//! Dependency versions are declared in this project's Cargo.toml.

use nonempty::NonEmpty;
use orchard::{
    Action, Anchor, Bundle, Note, NoteVersion, Proof,
    bundle::{Authorized as OrchardAuthorized, BundleVersion},
    note::{ExtractedNoteCommitment, Nullifier, RandomSeed, Rho, TransmittedNoteCiphertext},
    note_encryption::{
        IronwoodDomain, IronwoodNoteEncryption, OrchardDomain, OrchardNoteEncryption,
    },
    primitives::redpallas,
    value::{NoteValue, ValueCommitment},
};
use rand::{SeedableRng, rngs::StdRng};
use std::collections::HashMap;
use zcash_client_backend::{TransferType, decrypt_transaction};
use zcash_keys::keys::{UnifiedFullViewingKey, UnifiedSpendingKey};
use zcash_note_encryption::Domain;
use zcash_primitives::transaction::{Authorized, Transaction, TransactionData};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, MAIN_NETWORK},
    value::ZatBalance,
};
use zip32::{AccountId, Scope};

const HEIGHT: u32 = 3_500_000;
const VALUE: u64 = 1_234_567; // Deliberately synthetic fixture amount.

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
    sapling_bundle_with_recovery_key(ufvk, scope, memo, ufvk)
}

fn sapling_bundle_with_recovery_key(
    ufvk: &UnifiedFullViewingKey,
    scope: Scope,
    memo: [u8; 512],
    recovery_key: &UnifiedFullViewingKey,
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
        Some(recovery_key.sapling().unwrap().fvk().ovk),
        note,
        memo,
        &mut rng,
    );
    let epk = sapling::note_encryption::SaplingDomain::epk_bytes(encryptor.epk());
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

fn orchard_bundle(
    ufvk: &UnifiedFullViewingKey,
    scope: Scope,
    memo: [u8; 512],
    ironwood: bool,
) -> Bundle<OrchardAuthorized, ZatBalance> {
    orchard_bundle_with_recovery_key(ufvk, scope, memo, ironwood, ufvk)
}

fn orchard_bundle_with_recovery_key(
    ufvk: &UnifiedFullViewingKey,
    scope: Scope,
    memo: [u8; 512],
    ironwood: bool,
    recovery_key: &UnifiedFullViewingKey,
) -> Bundle<OrchardAuthorized, ZatBalance> {
    let fvk = ufvk.orchard().unwrap();
    let recipient = fvk.address_at(0u32, scope);
    let nf = Nullifier::from_bytes(&[0; 32]).unwrap();
    let rho = Rho::from_bytes(&nf.to_bytes()).unwrap();
    let note = Note::from_parts(
        recipient,
        NoteValue::from_raw(VALUE),
        rho,
        RandomSeed::from_bytes([42; 32], &rho).unwrap(),
        if ironwood {
            NoteVersion::V3
        } else {
            NoteVersion::V2
        },
    )
    .unwrap();
    let cv = ValueCommitment::from_bytes(&[0; 32]).unwrap();
    let cmx = ExtractedNoteCommitment::from(note.commitment());
    let mut rng = StdRng::seed_from_u64(456);
    let encrypted_note = if ironwood {
        let encryptor = IronwoodNoteEncryption::new(
            Some(recovery_key.orchard().unwrap().to_ovk(Scope::External)),
            note,
            memo,
        );
        TransmittedNoteCiphertext {
            epk_bytes: IronwoodDomain::epk_bytes(encryptor.epk()).0,
            enc_ciphertext: encryptor.encrypt_note_plaintext(),
            out_ciphertext: encryptor.encrypt_outgoing_plaintext(&cv, &cmx, &mut rng),
        }
    } else {
        let encryptor = OrchardNoteEncryption::new(
            Some(recovery_key.orchard().unwrap().to_ovk(Scope::External)),
            note,
            memo,
        );
        TransmittedNoteCiphertext {
            epk_bytes: OrchardDomain::epk_bytes(encryptor.epk()).0,
            enc_ciphertext: encryptor.encrypt_note_plaintext(),
            out_ciphertext: encryptor.encrypt_outgoing_plaintext(&cv, &cmx, &mut rng),
        }
    };
    // Valid point encoding; dummy signatures and proof are intentionally invalid.
    let rk = redpallas::VerificationKey::from(
        &redpallas::SigningKey::<redpallas::SpendAuth>::try_from([1; 32]).unwrap(),
    );
    let action = Action::from_parts(nf, rk, cmx, encrypted_note, cv, [0; 64].into()).unwrap();
    let version = if ironwood {
        BundleVersion::ironwood_v3()
    } else {
        BundleVersion::orchard_v3()
    };
    Bundle::try_from_parts(
        NonEmpty::new(action),
        version.default_flags(),
        ZatBalance::from_i64(-(VALUE as i64)).unwrap(),
        Anchor::empty_tree(),
        OrchardAuthorized::from_parts(
            Proof::new(vec![0; Proof::expected_proof_size(1)]),
            [0; 64].into(),
        ),
        version,
    )
    .unwrap()
}

fn encrypted_transaction(
    ufvk: &UnifiedFullViewingKey,
    scope: Scope,
    memo: [u8; 512],
    height: u32,
) -> Transaction {
    let tx = TransactionData::<Authorized>::from_parts_v6(
        BranchId::for_height(&MAIN_NETWORK, height.into()),
        0,
        BlockHeight::from_u32(height + 40),
        None,
        Some(sapling_bundle(ufvk, scope, memo)),
        Some(orchard_bundle(ufvk, scope, memo, false)),
        Some(orchard_bundle(ufvk, scope, memo, true)),
    )
    .freeze()
    .unwrap();
    // Exercise the same serialization/parser boundary as the node observer.
    let mut raw = vec![];
    tx.write(&mut raw).unwrap();
    Transaction::read(
        raw.as_slice(),
        BranchId::for_height(&MAIN_NETWORK, height.into()),
    )
    .unwrap()
}

#[test]
fn full_transaction_decrypts_all_pools_exactly_and_rejects_wrong_key() {
    let ufvk = test_ufvk(1);
    // Includes zeroes and non-UTF8: preserve exactly 512 bytes, do not trim the raw event memo.
    let mut memo = [0xff; 512];
    let text = b"{\"act\":\"fixture\",\"id\":\"synthetic\"}\0";
    memo[..text.len()].copy_from_slice(text);
    let tx = encrypted_transaction(&ufvk, Scope::External, memo, HEIGHT);
    let keys = HashMap::from([(7u32, ufvk.clone())]);
    let decrypted = decrypt_transaction(&MAIN_NETWORK, Some(HEIGHT.into()), None, &tx, &keys);
    assert_eq!(decrypted.sapling_outputs().len(), 1);
    assert_eq!(decrypted.orchard_outputs().len(), 1);
    assert_eq!(decrypted.ironwood_outputs().len(), 1);
    let sapling = &decrypted.sapling_outputs()[0];
    assert_eq!(sapling.transfer_type(), TransferType::Incoming);
    assert_eq!(sapling.note_value().into_u64(), VALUE);
    assert_eq!(sapling.memo().as_array(), &memo);
    assert_eq!(
        sapling.note().recipient(),
        ufvk.sapling().unwrap().default_address().1
    );
    for output in decrypted
        .orchard_outputs()
        .iter()
        .chain(decrypted.ironwood_outputs())
    {
        assert_eq!(output.transfer_type(), TransferType::Incoming);
        assert_eq!(output.note().0.value().inner(), VALUE);
        assert_eq!(output.memo().as_array(), &memo);
        assert_eq!(
            output.note().0.recipient(),
            ufvk.orchard().unwrap().address_at(0u32, Scope::External)
        );
        assert_eq!(output.index(), 0);
        assert_eq!(output.account(), &7);
    }
    let wrong_keys = HashMap::from([(7u32, test_ufvk(2))]);
    let wrong = decrypt_transaction(&MAIN_NETWORK, Some(HEIGHT.into()), None, &tx, &wrong_keys);
    assert!(!wrong.has_decrypted_outputs());
}

#[test]
fn full_transaction_distinguishes_internal_change() {
    let ufvk = test_ufvk(1);
    let tx = encrypted_transaction(&ufvk, Scope::Internal, [0; 512], HEIGHT);
    let keys = HashMap::from([(7u32, ufvk)]);
    let decrypted = decrypt_transaction(&MAIN_NETWORK, Some(HEIGHT.into()), None, &tx, &keys);
    assert_eq!(
        decrypted.sapling_outputs()[0].transfer_type(),
        TransferType::AccountInternal
    );
    assert_eq!(
        decrypted.orchard_outputs()[0].transfer_type(),
        TransferType::AccountInternal
    );
    assert_eq!(
        decrypted.ironwood_outputs()[0].transfer_type(),
        TransferType::AccountInternal
    );
}

/// A parseable raw block with genuine note ciphertexts, but fake proof/PoW/auth.
/// The fake block is a hermetic fixture, never a candidate for publication.
fn encrypted_block_fixture(
    ufvk: &UnifiedFullViewingKey,
    scope: Scope,
    memo: [u8; 512],
    height: u32,
) -> (Vec<u8>, String) {
    raw_block_from_transaction(encrypted_transaction(ufvk, scope, memo, height), height)
}

fn raw_block_from_transaction(tx: Transaction, height: u32) -> (Vec<u8>, String) {
    use sha2::{Digest, Sha256};
    use transparent::{
        address::Script,
        bundle::{
            Authorized as TransparentAuthorized, Bundle as TransparentBundle, OutPoint, TxIn, TxOut,
        },
    };
    use zcash_primitives::block::{BlockHash, BlockHeaderData};
    use zcash_protocol::value::Zatoshis;
    let script = Script(zcash_script::script::Code(vec![
        3,
        height as u8,
        (height >> 8) as u8,
        (height >> 16) as u8,
    ]));
    let coinbase = TransactionData::<Authorized>::from_parts_v6(
        BranchId::for_height(&MAIN_NETWORK, height.into()),
        0,
        BlockHeight::from_u32(height),
        Some(TransparentBundle {
            vin: vec![TxIn::from_parts(OutPoint::NULL, script, u32::MAX)],
            vout: vec![TxOut::new(Zatoshis::ZERO, Script::default())],
            authorization: TransparentAuthorized,
        }),
        None,
        None,
        None,
    )
    .freeze()
    .unwrap();
    let mut leaves = Vec::with_capacity(64);
    leaves.extend_from_slice(coinbase.txid().as_ref());
    leaves.extend_from_slice(tx.txid().as_ref());
    let merkle_root: [u8; 32] = Sha256::digest(Sha256::digest(&leaves)).into();
    let header = BlockHeaderData {
        version: 4,
        prev_block: BlockHash([1; 32]),
        merkle_root,
        final_sapling_root: [0; 32],
        time: 1_791_670_000,
        bits: 0x1f07ffff,
        nonce: [0; 32],
        solution: vec![0; 1344],
    }
    .freeze()
    .unwrap();
    let expected_hash = header.hash().to_string();
    let mut raw = vec![];
    header.write(&mut raw).unwrap();
    raw.push(2); // CompactSize transaction count, bounded hermetic fixture.
    coinbase.write(&mut raw).unwrap();
    tx.write(&mut raw).unwrap();
    (raw, expected_hash)
}

#[test]
fn observer_extracts_real_ciphertexts_and_excludes_change_from_raw_blocks() {
    use zcash_paymentd::chain::decrypt_block;
    use zcash_protocol::consensus::Network;
    for height in [HEIGHT, 3_543_405] {
        let ufvk = test_ufvk(1);
        let keys = HashMap::from([(7u32, ufvk.clone())]);
        let memo = [0x07; 512];
        let (raw, hash) = encrypted_block_fixture(&ufvk, Scope::External, memo, height);
        let observed =
            decrypt_block(&Network::MainNetwork, "main", &keys, height, &hash, &raw).unwrap();
        assert_eq!(observed.payments.len(), 3);
        for payment in &observed.payments {
            assert_eq!(payment.value_zatoshis, VALUE);
            assert_eq!(payment.memo_hex, hex::encode(memo));
            assert_eq!(payment.output_index, 0);
            let expected_receiver = match payment.pool.as_str() {
                "sapling" => ufvk.sapling().unwrap().default_address().1.to_bytes(),
                "orchard" | "ironwood" => ufvk
                    .orchard()
                    .unwrap()
                    .address_at(0u32, Scope::External)
                    .to_raw_address_bytes(),
                _ => panic!("unexpected pool"),
            };
            assert_eq!(payment.recipient_hex, hex::encode(expected_receiver));
        }
        assert_eq!(
            observed
                .payments
                .iter()
                .map(|p| &p.id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3
        );
        let wrong_keys = HashMap::from([(7u32, test_ufvk(2))]);
        assert!(
            decrypt_block(
                &Network::MainNetwork,
                "main",
                &wrong_keys,
                height,
                &hash,
                &raw
            )
            .unwrap()
            .payments
            .is_empty()
        );
        let (raw, hash) = encrypted_block_fixture(&ufvk, Scope::Internal, memo, height);
        assert!(
            decrypt_block(&Network::MainNetwork, "main", &keys, height, &hash, &raw)
                .unwrap()
                .payments
                .is_empty()
        );
    }
}

#[test]
fn observer_rejects_transaction_body_not_committed_by_header() {
    use zcash_paymentd::chain::decrypt_block;
    use zcash_protocol::consensus::Network;
    let ufvk = test_ufvk(1);
    let keys = HashMap::from([(7u32, ufvk.clone())]);
    let (mut raw, hash) = encrypted_block_fixture(&ufvk, Scope::External, [7; 512], HEIGHT);
    // Change transaction lock_time after the header is fixed. The transaction
    // remains parseable/decryptable, but its txid no longer matches the header.
    // V6's lock_time starts 12 bytes after version/group-id/consensus-branch-id.
    // Locate the final transaction start by constructing its standalone bytes.
    let mut tx_bytes = vec![];
    encrypted_transaction(&ufvk, Scope::External, [7; 512], HEIGHT)
        .write(&mut tx_bytes)
        .unwrap();
    let offset = raw.len() - tx_bytes.len();
    raw[offset + 12] ^= 1;
    assert!(decrypt_block(&Network::MainNetwork, "main", &keys, HEIGHT, &hash, &raw).is_err());
}

#[test]
fn observer_excludes_outgoing_payments_recovered_with_ovk() {
    use zcash_paymentd::chain::decrypt_block;
    use zcash_protocol::consensus::Network;
    let observer_ufvk = test_ufvk(1);
    let recipient_ufvk = test_ufvk(2);
    let memo = [0x07; 512];
    let tx = TransactionData::<Authorized>::from_parts_v6(
        BranchId::Nu6_3,
        0,
        BlockHeight::from_u32(HEIGHT + 40),
        None,
        Some(sapling_bundle_with_recovery_key(
            &recipient_ufvk,
            Scope::External,
            memo,
            &observer_ufvk,
        )),
        Some(orchard_bundle_with_recovery_key(
            &recipient_ufvk,
            Scope::External,
            memo,
            false,
            &observer_ufvk,
        )),
        Some(orchard_bundle_with_recovery_key(
            &recipient_ufvk,
            Scope::External,
            memo,
            true,
            &observer_ufvk,
        )),
    )
    .freeze()
    .unwrap();
    let observer_keys = HashMap::from([(7u32, observer_ufvk)]);
    let decoded = decrypt_transaction(
        &MAIN_NETWORK,
        Some(HEIGHT.into()),
        None,
        &tx,
        &observer_keys,
    );
    // Demonstrate this fixture truly exercises the OVK path before asserting
    // the automation observer drops it. Wrong-key/no-decryption is insufficient.
    assert_eq!(decoded.sapling_outputs().len(), 1);
    assert_eq!(decoded.orchard_outputs().len(), 1);
    assert_eq!(decoded.ironwood_outputs().len(), 1);
    assert_eq!(
        decoded.sapling_outputs()[0].transfer_type(),
        TransferType::Outgoing
    );
    assert_eq!(
        decoded.orchard_outputs()[0].transfer_type(),
        TransferType::Outgoing
    );
    assert_eq!(
        decoded.ironwood_outputs()[0].transfer_type(),
        TransferType::Outgoing
    );
    let (raw, hash) = raw_block_from_transaction(tx, HEIGHT);
    assert!(
        decrypt_block(
            &Network::MainNetwork,
            "main",
            &observer_keys,
            HEIGHT,
            &hash,
            &raw
        )
        .unwrap()
        .payments
        .is_empty()
    );
    let recipient_keys = HashMap::from([(7u32, recipient_ufvk)]);
    assert_eq!(
        decrypt_block(
            &Network::MainNetwork,
            "main",
            &recipient_keys,
            HEIGHT,
            &hash,
            &raw
        )
        .unwrap()
        .payments
        .len(),
        3
    );
}

#[test]
fn observer_rejects_known_but_wrong_network_upgrade_branch() {
    use zcash_paymentd::chain::decrypt_block;
    use zcash_protocol::consensus::Network;
    let ufvk = test_ufvk(1);
    let tx = TransactionData::<Authorized>::from_parts_v6(
        BranchId::Nu6_2,
        0,
        BlockHeight::from_u32(HEIGHT + 40),
        None,
        Some(sapling_bundle(&ufvk, Scope::External, [0; 512])),
        Some(orchard_bundle(&ufvk, Scope::External, [0; 512], false)),
        Some(orchard_bundle(&ufvk, Scope::External, [0; 512], true)),
    )
    .freeze()
    .unwrap();
    let (raw, hash) = raw_block_from_transaction(tx, HEIGHT);
    assert!(
        decrypt_block(
            &Network::MainNetwork,
            "main",
            &HashMap::from([(0, test_ufvk(1))]),
            HEIGHT,
            &hash,
            &raw
        )
        .is_err()
    );
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
    use zcash_paymentd::wallet_recovery::apply_response;
    use zcash_protocol::consensus::Network;
    let temp = tempfile::tempdir().unwrap();
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
    let mut db =
        zcash_paymentd::wallet_recovery::open_recovery_wallet(&path, Network::MainNetwork).unwrap(); // restart with shipping schema/network gate
    assert!(
        zcash_paymentd::wallet_recovery::open_recovery_wallet(&path, Network::TestNetwork).is_err()
    );
    assert!(
        zcash_paymentd::wallet_recovery::validate_received(&db, &[99; 32], HEIGHT.into()).is_err()
    );
    assert!(
        zcash_paymentd::wallet_recovery::validate_received(&db, txid.as_ref(), (HEIGHT + 1).into())
            .is_err()
    );
    conn.execute(
        "INSERT INTO transactions(txid,mined_height,min_observed_height) VALUES(?1,?2,?2)",
        rusqlite::params![[98u8; 32].as_slice(), HEIGHT],
    )
    .unwrap();
    assert!(
        zcash_paymentd::wallet_recovery::validate_received(&db, &[98; 32], HEIGHT.into()).is_err()
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
    let path = temp.path().join("incompatible.sqlite");
    let conn = rusqlite::Connection::open(&path).unwrap();
    // Existing public structural fixture, no operational data. This is not
    // evidence of compatibility with the exact deployed pre-release binary.
    conn.execute_batch(include_str!(
        "../../../py/free2z/zcashrpc/testdata/wallet-schema.sql"
    ))
    .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(
        zcash_paymentd::wallet_recovery::open_recovery_wallet(
            &path,
            zcash_protocol::consensus::Network::MainNetwork
        )
        .is_err()
    );
    assert_eq!(before, std::fs::read(&path).unwrap());
}
