//! §7's repair, against a real MLS group.
//!
//! # Why this is not a stub cipher
//!
//! The claim being tested is a claim about **forward secrecy**:
//!
//! > the sender re-encrypts the original plaintext under the *current* epoch
//! > and replies `gap_response`. It does not replay old ciphertext, so repair
//! > does not undermine forward secrecy.
//!
//! A fake cipher would have proved that a fake cipher produces different bytes
//! under a different key. What has to be true is that *MLS* does — that the
//! epoch really advanced, that the repaired ciphertext really is not the
//! original, and that it really decrypts on the other side under the new epoch.
//! So this file drives two `f2z_msg_mls::MlsEngine`s that share nothing but
//! byte strings, exactly as `f2z-msg-mls`'s own `two_instances.rs` does, with
//! credentials issued by the real `f2z-msg-identity` issuer.
//!
//! That makes this the coordination test between §7's framing and §5's engine.
//! If the two ever stop composing — an epoch that does not advance, a payload
//! the engine will not carry — it fails here rather than on a phone.
//!
//! # What each test asserts
//!
//! - `a_repair_is_re_encrypted_under_the_current_epoch_and_is_not_a_replay`:
//!   the epoch advanced, the repaired ciphertext differs byte for byte from the
//!   original, and Bob decrypts it in the new epoch.
//! - `the_original_ciphertext_no_longer_decrypts_after_the_epoch_advanced`:
//!   the reason replay would be wrong, made concrete.
//! - `a_repaired_message_carries_its_original_msg_id_unchanged`: the repair is
//!   the same message, not a new one — which is what lets it close a gap.
//! - `an_expired_outbox_window_produces_an_explicit_unrecoverable_state`: §8.4,
//!   end to end, from an outbox that has forgotten to a `MessageDag` that says
//!   so.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::{Body, PublicKey};
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, GapRequest, GapResponse, MessageDag, MessageType, MsgId,
    Parents, PlaintextOutbox, Provenance, RepairEntry, RepairOutcome, RepairRefusal,
    RetentionClass, SentAt,
};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_mls::{DeviceSigner, MlsEngine, Received};
use f2z_msg_store::MemoryBackend;

const NOW: u64 = 1_700_000_000_000;
const GROUP_ID: &[u8] = b"conversation-alice-bob";
/// Alice creates the group, so she is leaf 0; Bob joins and is leaf 1.
const ALICE_LEAF: u32 = 0;
const BOB_LEAF: u32 = 1;

/// One device, built the way enrollment builds one.
fn device(handle: &str, account_seed: u8, device_seed: u8) -> MlsEngine<MemoryBackend> {
    let seed = [account_seed; 64];
    let account = AccountKeys::from_seed(&seed, 0).unwrap();
    let signer = DeviceSigner::from_private_key([device_seed; 32]);
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(handle.as_bytes().to_vec()).unwrap(),
            device_pk: PublicKey::new(*signer.public_key()),
            device_kem_pk: KemPublicKey::new(vec![device_seed; 1216]).unwrap(),
            not_before_ms: NOW - 1_000_000,
            not_after_ms: NOW + 1_000_000,
        })
        .unwrap();
    MlsEngine::new(MemoryBackend::new(), signer, credential, NOW).unwrap()
}

/// Alice creates the group and adds Bob; Bob joins from the `Welcome`.
///
/// A macro rather than a function so this crate does not have to declare
/// `openmls` as a dependency merely to name `MlsGroup` in a return type. The
/// engines and groups are two devices that share nothing but the byte strings
/// a relay would carry — a `KeyPackage`, a `Welcome`, a commit, a
/// `PrivateMessage` — which is what makes the assertions below about two
/// parties rather than about one process talking to itself.
macro_rules! paired {
    ($alice:ident, $alice_group:ident, $bob:ident, $bob_group:ident) => {
        let $alice = device("alice", 11, 111);
        let $bob = device("bob", 22, 222);
        let bob_key_package = $bob.generate_key_package().unwrap();
        let mut $alice_group = $alice.create_group(GROUP_ID).unwrap();
        let (_commit, welcome) = $alice
            .add_member(&mut $alice_group, &bob_key_package, NOW)
            .unwrap();
        let mut $bob_group = $bob.join_from_welcome(&welcome, NOW).unwrap();
    };
}

/// Alice authors at leaf 0, Bob at leaf 1 — the indices the paired group above
/// actually assigns. The value is hashed now, so it has to be the real one.
fn chat_from(parents: Parents, epoch: u64, leaf: u32, body: &[u8]) -> AppMessage {
    AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents,
        epoch,
        sender_leaf_index: leaf,
        sent_at: SentAt::new(NOW),
        retention_class: RetentionClass::Chat,
        body: Body::new(body.to_vec()).unwrap(),
    })
    .unwrap()
}

/// Alice's leaf, which is 0 in every group she creates.
fn chat(parents: Parents, epoch: u64, body: &[u8]) -> AppMessage {
    chat_from(parents, epoch, ALICE_LEAF, body)
}

/// The acceptance criterion.
#[test]
fn a_repair_is_re_encrypted_under_the_current_epoch_and_is_not_a_replay() {
    paired!(alice, alice_group, bob, bob_group);
    let original_epoch = alice_group.epoch().as_u64();

    // Alice authors a message and keeps the plaintext against a repair request.
    let message = chat(Parents::empty(), original_epoch, b"the one that got lost");
    let plaintext = message.encode().unwrap();
    let mut outbox = PlaintextOutbox::new(60_000, 32);
    outbox.store(message.msg_id(), plaintext.clone(), NOW);

    // She sends it. Bob never receives this ciphertext — the relay dropped it.
    let original_ciphertext = alice.send(&mut alice_group, &plaintext).unwrap();

    // Time passes and the group ratchets forward.
    let commit = alice.update(&mut alice_group).unwrap();
    let processed = bob
        .receive(&mut bob_group, &commit, b"commit-1", NOW)
        .unwrap();
    let current_epoch = bob_group.epoch().as_u64();
    assert_eq!(
        processed,
        Received::EpochChanged {
            epoch: current_epoch
        }
    );
    assert!(
        current_epoch > original_epoch,
        "the epoch must actually advance or this test proves nothing"
    );

    // Bob notices the hole and asks for it.
    let later = chat_from(
        Parents::new(vec![message.msg_id()]).unwrap(),
        current_epoch,
        BOB_LEAF,
        b"did you say something?",
    );
    let mut bob_dag = MessageDag::new();
    bob_dag.insert(DagEntry::from_delivered(&later, current_epoch, BOB_LEAF).unwrap());
    let missing = bob_dag.take_gap_request();
    assert_eq!(missing, vec![message.msg_id()]);
    let request = GapRequest::new(missing).unwrap();

    // Alice repairs: the outbox hands back the **plaintext**, and she puts it
    // through the ordinary current-epoch send path. There is no API here that
    // could hand back the stored ciphertext.
    let requested = request.hashes()[0];
    let RepairOutcome::Reencrypt(recovered) = outbox.repair(&requested, NOW + 1_000) else {
        panic!("the window has not elapsed; this must be repairable");
    };
    assert_eq!(recovered, plaintext.as_slice());

    let entry = RepairEntry::supplied(&AppMessage::decode(recovered).unwrap()).unwrap();
    let response = GapResponse::new(vec![entry]);
    let envelope = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::GAP_RESPONSE,
        parents: Parents::empty(),
        epoch: current_epoch,
        sender_leaf_index: ALICE_LEAF,
        sent_at: SentAt::new(NOW + 1_000),
        retention_class: RetentionClass::Chat,
        body: response.to_body().unwrap(),
    })
    .unwrap();
    let repair_ciphertext = alice
        .send(&mut alice_group, &envelope.encode().unwrap())
        .unwrap();

    // ---- the two assertions this test exists for --------------------------

    assert_ne!(
        repair_ciphertext, original_ciphertext,
        "the repair must be a fresh encryption, not the stored ciphertext replayed"
    );

    let received = bob
        .receive(&mut bob_group, &repair_ciphertext, b"repair-1", NOW)
        .unwrap();
    let Received::Application {
        payload,
        sender,
        epoch,
    } = received
    else {
        panic!("expected an application message");
    };
    assert_eq!(
        epoch, current_epoch,
        "the repair must decrypt under the CURRENT epoch key"
    );

    // ---- and the repaired message closes the gap --------------------------

    let envelope = AppMessage::decode(&payload).unwrap();
    assert_eq!(envelope.tbs().message_type, MessageType::GAP_RESPONSE);
    let response = GapResponse::from_body(&envelope.tbs().body).unwrap();
    let repaired = response
        .entry_for(&requested)
        .unwrap()
        .accept(&requested)
        .unwrap();

    assert_eq!(repaired, message, "the repair is the same message");
    assert_eq!(
        repaired.tbs().epoch,
        original_epoch,
        "the message keeps the epoch it was authored in; only the framing moved"
    );

    let entry = DagEntry::from_repair(&repaired);
    assert_eq!(
        entry.provenance(),
        Provenance::Repaired,
        "the receiver must still be able to tell what the framing authenticated"
    );
    assert_eq!(
        entry.sort_key().sender_leaf_index,
        ALICE_LEAF,
        "the sort key is the AUTHOR's leaf index, read out of the hashed message"
    );
    assert_eq!(
        sender, ALICE_LEAF,
        "here the repairer is the author, so the framing agrees — which is \
         exactly the coincidence §7's correction stopped depending on"
    );
    bob_dag.insert(entry);
    assert!(!bob_dag.has_detected_gaps());
    assert_eq!(
        bob_dag.display_order().unwrap(),
        vec![message.msg_id(), later.msg_id()],
        "and it lands before the message that referenced it"
    );
}

/// The reason replay would be wrong, made concrete rather than asserted in
/// prose: once the group has ratcheted, the old ciphertext is not something
/// this engine will accept any more. A repair that replayed it would be asking
/// the recipient to keep — and to use — key material the ratchet exists to
/// destroy.
#[test]
fn the_original_ciphertext_no_longer_decrypts_after_the_epoch_advanced() {
    paired!(alice, alice_group, bob, bob_group);
    let epoch = alice_group.epoch().as_u64();

    let message = chat(Parents::empty(), epoch, b"the one that got lost");
    let original_ciphertext = alice
        .send(&mut alice_group, &message.encode().unwrap())
        .unwrap();

    let commit = alice.update(&mut alice_group).unwrap();
    bob.receive(&mut bob_group, &commit, b"commit-1", NOW)
        .unwrap();

    assert!(
        bob.receive(&mut bob_group, &original_ciphertext, b"replay", NOW)
            .is_err(),
        "an old-epoch ciphertext delivered after the ratchet is not a repair path"
    );
}

#[test]
fn a_repaired_message_carries_its_original_msg_id_unchanged() {
    paired!(alice, alice_group, bob, bob_group);
    let epoch = alice_group.epoch().as_u64();
    let message = chat(Parents::empty(), epoch, b"stable identity");
    let bytes = message.encode().unwrap();

    // Send it twice, under two different epochs. The framing differs; the name
    // does not, because `msg_id` commits to the message and not to the framing.
    let first = alice.send(&mut alice_group, &bytes).unwrap();
    let commit = alice.update(&mut alice_group).unwrap();
    bob.receive(&mut bob_group, &commit, b"commit-1", NOW)
        .unwrap();
    let second = alice.send(&mut alice_group, &bytes).unwrap();

    assert_ne!(first, second);
    let Received::Application { payload, .. } = bob
        .receive(&mut bob_group, &second, b"repair", NOW)
        .unwrap()
    else {
        panic!("expected an application message");
    };
    assert_eq!(
        AppMessage::decode(&payload).unwrap().msg_id(),
        message.msg_id()
    );
}

/// §8.4, end to end. A short local TTL is a legitimate per-user choice (§8.1),
/// and its consequence must reach the requester as a statement rather than as
/// silence.
#[test]
fn an_expired_outbox_window_produces_an_explicit_unrecoverable_state() {
    paired!(alice, alice_group, bob, bob_group);
    let epoch = alice_group.epoch().as_u64();

    let message = chat(Parents::empty(), epoch, b"gone forever");
    let mut outbox = PlaintextOutbox::new(5_000, 32);
    outbox.store(message.msg_id(), message.encode().unwrap(), NOW);

    // Bob asks, well after Alice's window elapsed.
    let later = chat_from(
        Parents::new(vec![message.msg_id()]).unwrap(),
        epoch,
        BOB_LEAF,
        b"and then?",
    );
    let mut bob_dag = MessageDag::new();
    bob_dag.insert(DagEntry::from_delivered(&later, epoch, BOB_LEAF).unwrap());
    let requested: MsgId = bob_dag.take_gap_request()[0];

    let RepairOutcome::Unrecoverable(reason) = outbox.repair(&requested, NOW + 60_000) else {
        panic!("the window elapsed; the plaintext must be gone");
    };

    // Alice says so, in band, rather than saying nothing.
    let refusal = RepairEntry::unrecoverable(requested, RepairRefusal::from_local(reason)).unwrap();
    let envelope = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::GAP_RESPONSE,
        parents: Parents::empty(),
        epoch,
        sender_leaf_index: ALICE_LEAF,
        sent_at: SentAt::new(NOW + 60_000),
        retention_class: RetentionClass::Chat,
        body: GapResponse::new(vec![refusal]).to_body().unwrap(),
    })
    .unwrap();
    let wire = alice
        .send(&mut alice_group, &envelope.encode().unwrap())
        .unwrap();

    let Received::Application { payload, .. } =
        bob.receive(&mut bob_group, &wire, b"refusal", NOW).unwrap()
    else {
        panic!("expected an application message");
    };
    let response =
        GapResponse::from_body(&AppMessage::decode(&payload).unwrap().tbs().body).unwrap();
    let entry = response.entry_for(&requested).unwrap();
    assert_eq!(entry.refusal(), Some(RepairRefusal::NoLongerHeld));

    bob_dag.mark_unrecoverable(&requested);
    assert_eq!(
        bob_dag.unrecoverable_gaps(),
        vec![requested],
        "§8.4: an explicit 'could not be recovered' marker, never a silent hole"
    );
    assert!(
        !bob_dag.has_detected_gaps(),
        "it is answered, not outstanding — but it is still visible"
    );
}
