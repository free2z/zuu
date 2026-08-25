//! The provider, exercised through the trait OpenMLS actually calls.
//!
//! These use purpose-built key and entity types rather than OpenMLS's, because
//! this crate deliberately does not depend on `openmls` — see the crate note.
//! The marker traits in `openmls_traits::storage::traits` are open, so a test
//! type can satisfy them, and what is under test here is the *storage*
//! behaviour: does a write land under the key the matching read looks at, does
//! a list append and remove, does a delete delete, and does a transaction hold.
//!
//! `f2z-msg-mls`'s tests are what exercise the same provider under real MLS.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in a crypto core is a crash of the client;
// neither hazard exists in a test harness.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_msg_store::{F2zStorageProvider, MemoryBackend, StoreError};
use openmls_traits::storage::{CURRENT_VERSION, Entity, Key, StorageProvider, traits};
use serde::{Deserialize, Serialize};

// --- fixtures ---------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
struct Gid(Vec<u8>);
impl Key<CURRENT_VERSION> for Gid {}
impl traits::GroupId<CURRENT_VERSION> for Gid {}
impl Key<CURRENT_VERSION> for &Gid {}
impl traits::GroupId<CURRENT_VERSION> for &Gid {}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
struct Blob(Vec<u8>);
impl Entity<CURRENT_VERSION> for Blob {}
impl traits::TreeSync<CURRENT_VERSION> for Blob {}
impl traits::GroupContext<CURRENT_VERSION> for Blob {}
impl traits::MlsGroupJoinConfig<CURRENT_VERSION> for Blob {}
impl traits::LeafNode<CURRENT_VERSION> for Blob {}
impl traits::QueuedProposal<CURRENT_VERSION> for Blob {}
impl traits::GroupEpochSecrets<CURRENT_VERSION> for Blob {}
impl traits::MessageSecrets<CURRENT_VERSION> for Blob {}
impl traits::ConfirmationTag<CURRENT_VERSION> for Blob {}
impl traits::InterimTranscriptHash<CURRENT_VERSION> for Blob {}
impl traits::ResumptionPskStore<CURRENT_VERSION> for Blob {}
impl traits::GroupState<CURRENT_VERSION> for Blob {}
impl traits::LeafNodeIndex<CURRENT_VERSION> for Blob {}
impl traits::KeyPackage<CURRENT_VERSION> for Blob {}
impl traits::SignatureKeyPair<CURRENT_VERSION> for Blob {}
impl traits::HpkeKeyPair<CURRENT_VERSION> for Blob {}
impl traits::PskBundle<CURRENT_VERSION> for Blob {}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
struct Ref(u32);
impl Key<CURRENT_VERSION> for Ref {}
impl Entity<CURRENT_VERSION> for Ref {}
impl traits::ProposalRef<CURRENT_VERSION> for Ref {}
impl traits::HashReference<CURRENT_VERSION> for Ref {}
impl traits::SignaturePublicKey<CURRENT_VERSION> for Ref {}
impl traits::EncryptionKey<CURRENT_VERSION> for Ref {}
impl traits::PskId<CURRENT_VERSION> for Ref {}
impl traits::EpochKey<CURRENT_VERSION> for Ref {}

fn provider() -> F2zStorageProvider<MemoryBackend> {
    F2zStorageProvider::new(MemoryBackend::new())
}

fn gid() -> Gid {
    Gid(b"conversation-1".to_vec())
}

// --- single-valued entries --------------------------------------------------

#[test]
fn every_single_valued_entry_round_trips_and_deletes() {
    let store = provider();
    let group = gid();
    let value = Blob(vec![7; 32]);

    macro_rules! round_trip {
        ($write:ident, $read:ident, $delete:ident) => {
            store.$write(&group, &value).unwrap();
            assert_eq!(
                store.$read::<Gid, Blob>(&group).unwrap(),
                Some(value.clone()),
                concat!(stringify!($read), " did not read back what ", stringify!($write), " wrote")
            );
            store.$delete(&group).unwrap();
            assert_eq!(store.$read::<Gid, Blob>(&group).unwrap(), None);
        };
    }

    round_trip!(write_tree, tree, delete_tree);
    round_trip!(write_context, group_context, delete_context);
    round_trip!(
        write_interim_transcript_hash,
        interim_transcript_hash,
        delete_interim_transcript_hash
    );
    round_trip!(
        write_confirmation_tag,
        confirmation_tag,
        delete_confirmation_tag
    );
    round_trip!(
        write_message_secrets,
        message_secrets,
        delete_message_secrets
    );
    round_trip!(
        write_resumption_psk_store,
        resumption_psk_store,
        delete_all_resumption_psk_secrets
    );
    round_trip!(write_own_leaf_index, own_leaf_index, delete_own_leaf_index);
    round_trip!(
        write_group_epoch_secrets,
        group_epoch_secrets,
        delete_group_epoch_secrets
    );
    round_trip!(
        write_mls_join_config,
        mls_group_join_config,
        delete_group_config
    );
}

#[test]
fn group_state_round_trips_and_deletes() {
    // `write_group_state`'s generics are declared in the opposite order to
    // every other writer's, so it does not fit the macro above. That asymmetry
    // is upstream's and is worth a test of its own rather than a workaround.
    let store = provider();
    let group = gid();
    let value = Blob(vec![3; 8]);

    store.write_group_state(&group, &value).unwrap();
    assert_eq!(
        store.group_state::<Blob, Gid>(&group).unwrap(),
        Some(value.clone())
    );
    store.delete_group_state(&group).unwrap();
    assert_eq!(store.group_state::<Blob, Gid>(&group).unwrap(), None);
}

#[test]
fn a_missing_entry_is_none_rather_than_an_error() {
    let store = provider();
    assert_eq!(store.tree::<Gid, Blob>(&gid()).unwrap(), None);
    assert!(store.own_leaf_nodes::<Gid, Blob>(&gid()).unwrap().is_empty());
    assert!(
        store
            .queued_proposal_refs::<Gid, Ref>(&gid())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn deleting_something_that_is_not_there_succeeds() {
    let store = provider();
    store.delete_tree(&gid()).unwrap();
    store.delete_own_leaf_nodes(&gid()).unwrap();
    store.delete_psk(&Ref(9)).unwrap();
}

// --- crypto objects ---------------------------------------------------------

#[test]
fn crypto_objects_round_trip_under_their_own_keys() {
    let store = provider();
    let key = Ref(1);
    let value = Blob(vec![9; 16]);

    store.write_signature_key_pair(&key, &value).unwrap();
    assert_eq!(
        store.signature_key_pair::<Ref, Blob>(&key).unwrap(),
        Some(value.clone())
    );
    store.delete_signature_key_pair(&key).unwrap();
    assert_eq!(store.signature_key_pair::<Ref, Blob>(&key).unwrap(), None);

    store.write_encryption_key_pair(&key, &value).unwrap();
    assert_eq!(
        store.encryption_key_pair::<Blob, Ref>(&key).unwrap(),
        Some(value.clone())
    );
    store.delete_encryption_key_pair(&key).unwrap();
    assert_eq!(store.encryption_key_pair::<Blob, Ref>(&key).unwrap(), None);

    store.write_key_package(&key, &value).unwrap();
    assert_eq!(
        store.key_package::<Ref, Blob>(&key).unwrap(),
        Some(value.clone())
    );
    store.delete_key_package(&key).unwrap();
    assert_eq!(store.key_package::<Ref, Blob>(&key).unwrap(), None);

    store.write_psk(&key, &value).unwrap();
    assert_eq!(store.psk::<Blob, Ref>(&key).unwrap(), Some(value.clone()));
    store.delete_psk(&key).unwrap();
    assert_eq!(store.psk::<Blob, Ref>(&key).unwrap(), None);
}

#[test]
fn epoch_key_pairs_are_keyed_by_group_epoch_and_leaf() {
    let store = provider();
    let group = gid();
    let pairs = vec![Blob(vec![1]), Blob(vec![2])];

    store
        .write_encryption_epoch_key_pairs(&group, &Ref(5), 3, &pairs)
        .unwrap();

    assert_eq!(
        store
            .encryption_epoch_key_pairs::<Gid, Ref, Blob>(&group, &Ref(5), 3)
            .unwrap(),
        pairs
    );
    // A different leaf index is a different entry, not the same one.
    assert!(
        store
            .encryption_epoch_key_pairs::<Gid, Ref, Blob>(&group, &Ref(5), 4)
            .unwrap()
            .is_empty()
    );
    // …and so is a different epoch.
    assert!(
        store
            .encryption_epoch_key_pairs::<Gid, Ref, Blob>(&group, &Ref(6), 3)
            .unwrap()
            .is_empty()
    );

    store
        .delete_encryption_epoch_key_pairs(&group, &Ref(5), 3)
        .unwrap();
    assert!(
        store
            .encryption_epoch_key_pairs::<Gid, Ref, Blob>(&group, &Ref(5), 3)
            .unwrap()
            .is_empty()
    );
}

// --- list-valued entries ----------------------------------------------------

#[test]
fn own_leaf_nodes_append_in_order_and_delete_together() {
    let store = provider();
    let group = gid();

    store.append_own_leaf_node(&group, &Blob(vec![1])).unwrap();
    store.append_own_leaf_node(&group, &Blob(vec![2])).unwrap();

    assert_eq!(
        store.own_leaf_nodes::<Gid, Blob>(&group).unwrap(),
        vec![Blob(vec![1]), Blob(vec![2])]
    );

    store.delete_own_leaf_nodes(&group).unwrap();
    assert!(store.own_leaf_nodes::<Gid, Blob>(&group).unwrap().is_empty());
}

#[test]
fn a_queued_proposal_is_reachable_by_reference_and_by_group() {
    let store = provider();
    let group = gid();

    store
        .queue_proposal(&group, &Ref(1), &Blob(vec![0xA1]))
        .unwrap();
    store
        .queue_proposal(&group, &Ref(2), &Blob(vec![0xA2]))
        .unwrap();

    assert_eq!(
        store.queued_proposal_refs::<Gid, Ref>(&group).unwrap(),
        vec![Ref(1), Ref(2)]
    );
    assert_eq!(
        store.queued_proposals::<Gid, Ref, Blob>(&group).unwrap(),
        vec![(Ref(1), Blob(vec![0xA1])), (Ref(2), Blob(vec![0xA2]))]
    );
}

#[test]
fn removing_one_proposal_leaves_the_other() {
    let store = provider();
    let group = gid();

    store
        .queue_proposal(&group, &Ref(1), &Blob(vec![0xA1]))
        .unwrap();
    store
        .queue_proposal(&group, &Ref(2), &Blob(vec![0xA2]))
        .unwrap();

    store.remove_proposal(&group, &Ref(1)).unwrap();

    assert_eq!(
        store.queued_proposal_refs::<Gid, Ref>(&group).unwrap(),
        vec![Ref(2)]
    );
    assert_eq!(
        store.queued_proposals::<Gid, Ref, Blob>(&group).unwrap(),
        vec![(Ref(2), Blob(vec![0xA2]))]
    );
}

/// The defect this crate fixes relative to `openmls_memory_storage 0.5.0`.
///
/// Upstream's `clear_proposal_queue` removes a map key that nothing was ever
/// stored under — `serde_json::to_vec(&(group_id, proposal_ref))` with no label
/// prefix and no version suffix — so the reference list is deleted and every
/// serialised proposal body is left in the store forever. Ported faithfully
/// that is an unbounded leak in every client's local database.
///
/// This test is what would fail if someone "restored fidelity" with upstream.
#[test]
fn clearing_the_queue_removes_the_proposal_bodies_and_not_only_the_references() {
    let store = provider();
    let group = gid();

    store
        .queue_proposal(&group, &Ref(1), &Blob(vec![0xA1]))
        .unwrap();
    store
        .queue_proposal(&group, &Ref(2), &Blob(vec![0xA2]))
        .unwrap();

    let before = store.backend().len().unwrap();
    assert!(before >= 3, "expected two proposals and a refs list");

    store.clear_proposal_queue::<Gid, Ref>(&group).unwrap();

    assert!(
        store.queued_proposal_refs::<Gid, Ref>(&group).unwrap().is_empty(),
        "the references must be gone"
    );
    assert_eq!(
        store.backend().len().unwrap(),
        0,
        "the proposal bodies must be gone too — this is the upstream bug"
    );

    // And re-queuing the same reference after a clear must not resurrect the
    // old body, which is the observable symptom of the leak.
    store
        .queue_proposal(&group, &Ref(1), &Blob(vec![0xFF]))
        .unwrap();
    assert_eq!(
        store.queued_proposals::<Gid, Ref, Blob>(&group).unwrap(),
        vec![(Ref(1), Blob(vec![0xFF]))]
    );
}

/// A queue reference whose body is missing is a corrupt store. Upstream
/// `unwrap()`s it and panics in the middle of message processing; here it is an
/// error the caller can report.
///
/// The corrupt state is built by writing the reference list straight into the
/// backend, in exactly the layout the crate uses, because no sequence of public
/// calls can produce it — which is the point: it is what a *crash between the
/// two writes of `queue_proposal`* would leave behind on a store with no
/// transaction.
#[test]
fn a_dangling_proposal_reference_is_an_error_and_not_a_panic() {
    use f2z_msg_store::{Op, StorageBackend};

    let store = provider();
    let group = gid();

    // `label || serde_json(key) || version_be`, the one layout in `keys.rs`.
    let mut refs_key = b"ProposalQueueRefs".to_vec();
    refs_key.extend_from_slice(&serde_json::to_vec(&group).unwrap());
    refs_key.extend_from_slice(&u16::to_be_bytes(CURRENT_VERSION));

    let list = vec![serde_json::to_vec(&Ref(1)).unwrap()];
    store
        .backend()
        .apply(&[Op::Put {
            key: refs_key,
            value: serde_json::to_vec(&list).unwrap(),
        }])
        .unwrap();

    // The reference is visible…
    assert_eq!(
        store.queued_proposal_refs::<Gid, Ref>(&group).unwrap(),
        vec![Ref(1)]
    );
    // …and resolving it fails rather than aborting the process.
    assert!(
        store.queued_proposals::<Gid, Ref, Blob>(&group).is_err(),
        "a reference with no body must be an error"
    );
}

// --- the transaction --------------------------------------------------------

#[test]
fn a_committed_transaction_is_visible_and_an_abandoned_one_is_not() {
    let store = provider();
    let group = gid();

    {
        let tx = store.begin().unwrap();
        store.write_tree(&group, &Blob(vec![1])).unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(
        store.tree::<Gid, Blob>(&group).unwrap(),
        Some(Blob(vec![1]))
    );

    {
        let _tx = store.begin().unwrap();
        store.write_tree(&group, &Blob(vec![2])).unwrap();
        // dropped without commit
    }
    assert_eq!(
        store.tree::<Gid, Blob>(&group).unwrap(),
        Some(Blob(vec![1])),
        "a dropped transaction must roll back"
    );
}

#[test]
fn reads_inside_a_transaction_see_the_staged_writes() {
    let store = provider();
    let group = gid();

    let tx = store.begin().unwrap();
    store.write_tree(&group, &Blob(vec![42])).unwrap();
    assert_eq!(
        store.tree::<Gid, Blob>(&group).unwrap(),
        Some(Blob(vec![42])),
        "OpenMLS reads back what it just wrote within one operation"
    );
    // …including through the list helpers, which read-modify-write.
    store.append_own_leaf_node(&group, &Blob(vec![1])).unwrap();
    store.append_own_leaf_node(&group, &Blob(vec![2])).unwrap();
    assert_eq!(store.own_leaf_nodes::<Gid, Blob>(&group).unwrap().len(), 2);
    tx.commit().unwrap();

    assert_eq!(store.own_leaf_nodes::<Gid, Blob>(&group).unwrap().len(), 2);
}

#[test]
fn a_delete_staged_in_a_transaction_reads_as_absent_before_it_commits() {
    let store = provider();
    let group = gid();
    store.write_tree(&group, &Blob(vec![1])).unwrap();

    let tx = store.begin().unwrap();
    store.delete_tree(&group).unwrap();
    assert_eq!(
        store.tree::<Gid, Blob>(&group).unwrap(),
        None,
        "a tombstone must shadow the backend"
    );
    tx.rollback().unwrap();

    assert_eq!(
        store.tree::<Gid, Blob>(&group).unwrap(),
        Some(Blob(vec![1])),
        "a rolled-back delete must not have happened"
    );
}

#[test]
fn nesting_a_transaction_is_refused() {
    let store = provider();
    let _outer = store.begin().unwrap();
    assert!(matches!(
        store.begin(),
        Err(StoreError::TransactionAlreadyOpen)
    ));
}

#[test]
fn a_transaction_can_be_opened_again_after_the_previous_one_settles() {
    let store = provider();
    {
        let tx = store.begin().unwrap();
        tx.commit().unwrap();
    }
    assert!(!store.in_transaction().unwrap());
    {
        let tx = store.begin().unwrap();
        tx.rollback().unwrap();
    }
    assert!(!store.in_transaction().unwrap());
    let tx = store.begin().unwrap();
    assert!(store.in_transaction().unwrap());
    drop(tx);
    assert!(!store.in_transaction().unwrap());
}

#[test]
fn outside_a_transaction_every_write_is_immediately_durable_to_the_backend() {
    let store = provider();
    store.write_tree(&gid(), &Blob(vec![1])).unwrap();
    assert_eq!(store.backend().len().unwrap(), 1);
}

/// The whole point, stated as a test: a multi-write logical operation either
/// happens or does not. `queue_proposal` is the smallest one in the trait — it
/// writes the body and appends the reference — so a rollback in the middle must
/// leave neither.
#[test]
fn a_multi_write_operation_leaves_nothing_behind_when_it_is_abandoned() {
    let store = provider();
    let group = gid();

    {
        let _tx = store.begin().unwrap();
        store
            .queue_proposal(&group, &Ref(1), &Blob(vec![0xA1]))
            .unwrap();
        store.write_tree(&group, &Blob(vec![2])).unwrap();
        store.write_context(&group, &Blob(vec![3])).unwrap();
    }

    assert_eq!(
        store.backend().len().unwrap(),
        0,
        "not one of the five writes may have reached the backend"
    );
    assert!(
        store
            .queued_proposal_refs::<Gid, Ref>(&group)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.tree::<Gid, Blob>(&group).unwrap(), None);
}

#[test]
fn the_provider_reports_the_backends_durability() {
    use f2z_msg_store::Durability;
    assert_eq!(provider().durability(), Durability::None);
    assert!(!provider().durability().may_acknowledge());
}
