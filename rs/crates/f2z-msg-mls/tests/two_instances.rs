//! Two independent engines exchange a message.
//!
//! **Two handles in one test are not two devices.** Everything below runs on
//! two [`MlsEngine`]s that share nothing: separate storage, separate device
//! signing keys, separate identity keys, separate credentials. The only things
//! that cross between them are byte strings that would go over a relay — a
//! `KeyPackage`, a `Welcome`, a commit, a `PrivateMessage`. If any state were
//! accidentally shared, deleting one engine's store would not break the other,
//! and `two_engines_share_no_state` is the test that would notice.
//!
//! Run with `cargo test -p f2z-msg-mls`.

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

use f2z_msg_mls::{EngineError, ExportLabel, MlsEngine, ProtocolVersion, Received};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use f2z_msg_store::{Durability, MemoryBackend, Op, StorageBackend, StoreError};

mod common;
use common::{NOW, device, directory_entry, issue_credential};

const GROUP_ID: &[u8] = b"conversation-alice-bob";
const TEST_AAD: &[u8] = b"free2z/test/non-empty-aad";

/// Alice creates the group and adds Bob; Bob joins from the `Welcome`.
fn paired() -> (
    MlsEngine<MemoryBackend>,
    openmls::prelude::MlsGroup,
    MlsEngine<MemoryBackend>,
    openmls::prelude::MlsGroup,
) {
    let alice = device("alice", 11, 111);
    let bob = device("bob", 22, 222);

    let bob_key_package = bob.generate_key_package().expect("key package");
    // §12.6: the package is checked against the directory entry before it can
    // become an argument to `add_member` at all. There is no other constructor.
    let bob_entry = directory_entry(&[bob.credential().clone()]);
    let bob_key_package = alice
        .verify_key_package(&bob_key_package, &bob_entry, NOW)
        .expect("the directory vouches for this package");

    let mut alice_group = alice.create_group(GROUP_ID).expect("create group");
    let (_commit, welcome) = alice
        .add_member(&mut alice_group, &bob_key_package, NOW)
        .expect("add member");

    let bob_group = bob.join_from_welcome(&welcome, NOW).expect("join");

    (alice, alice_group, bob, bob_group)
}

#[derive(Clone, Debug)]
struct FailableBackend {
    inner: Arc<MemoryBackend>,
    fail_apply: Arc<AtomicBool>,
    fail_restore_get_after_apply: Arc<AtomicBool>,
    fail_next_get: Arc<AtomicBool>,
}

impl FailableBackend {
    fn new() -> Self {
        Self {
            inner: Arc::new(MemoryBackend::new()),
            fail_apply: Arc::new(AtomicBool::new(false)),
            fail_restore_get_after_apply: Arc::new(AtomicBool::new(false)),
            fail_next_get: Arc::new(AtomicBool::new(false)),
        }
    }

    fn set_fail_apply(&self, fail: bool) {
        self.fail_apply.store(fail, Ordering::SeqCst);
    }

    fn fail_apply_and_restore_get_once(&self) {
        self.fail_restore_get_after_apply
            .store(true, Ordering::SeqCst);
        self.fail_apply.store(true, Ordering::SeqCst);
    }
}

impl StorageBackend for FailableBackend {
    fn get(&self, key: &[u8]) -> f2z_msg_store::Result<Option<Vec<u8>>> {
        if self.fail_next_get.swap(false, Ordering::SeqCst) {
            return Err(StoreError::Backend("injected restore get failure"));
        }
        self.inner.get(key)
    }

    fn apply(&self, ops: &[Op]) -> f2z_msg_store::Result<()> {
        if self.fail_apply.load(Ordering::SeqCst) {
            if self
                .fail_restore_get_after_apply
                .swap(false, Ordering::SeqCst)
            {
                self.fail_next_get.store(true, Ordering::SeqCst);
            }
            return Err(StoreError::Backend("injected apply failure"));
        }
        self.inner.apply(ops)
    }

    fn durability(&self) -> Durability {
        self.inner.durability()
    }
}

fn paired_with_bob_backend<B: StorageBackend>(
    bob_backend: B,
    bob_not_after_ms: u64,
) -> (
    MlsEngine<MemoryBackend>,
    openmls::prelude::MlsGroup,
    MlsEngine<B>,
    openmls::prelude::MlsGroup,
) {
    let alice = device("alice", 11, 111);
    let (bob_credential, bob_signer) =
        issue_credential("bob", 22, 222, NOW - 1_000_000, bob_not_after_ms);
    let bob = MlsEngine::new(bob_backend, bob_signer, bob_credential, NOW).expect("bob engine");

    let bob_key_package = bob.generate_key_package().expect("key package");
    let mut alice_group = alice.create_group(GROUP_ID).expect("create group");
    let (_commit, welcome) = alice
        .add_member(&mut alice_group, &bob_key_package, NOW)
        .expect("add member");
    let bob_group = bob.join_from_welcome(&welcome, NOW).expect("join");

    (alice, alice_group, bob, bob_group)
}

// --- the acceptance criterion -----------------------------------------------

#[test]
fn two_engines_exchange_a_message_in_both_directions() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    assert_eq!(alice_group.group_id(), bob_group.group_id());
    assert_eq!(alice_group.epoch(), bob_group.epoch());

    let wire = alice.send(&mut alice_group, b"hello, bob").expect("send");
    let received = bob
        .receive(&mut bob_group, &wire, b"msg-1", NOW)
        .expect("receive");
    assert_eq!(received.payload(), Some(b"hello, bob".as_slice()));

    let reply = bob.send(&mut bob_group, b"hello, alice").expect("send");
    let received = alice
        .receive(&mut alice_group, &reply, b"msg-2", NOW)
        .expect("receive");
    assert_eq!(received.payload(), Some(b"hello, alice".as_slice()));
}

#[test]
fn an_update_advances_both_sides_to_the_same_epoch() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();
    let before = alice_group.epoch().as_u64();

    // §5.1's post-compromise security: a fresh leaf key, committed.
    let commit = alice.update(&mut alice_group).expect("update");
    let received = bob
        .receive(&mut bob_group, &commit, b"commit-1", NOW)
        .expect("process commit");

    assert_eq!(
        received,
        Received::EpochChanged {
            epoch: bob_group.epoch().as_u64()
        }
    );
    assert_eq!(
        alice_group.epoch(),
        bob_group.epoch(),
        "both sides must agree on the new epoch"
    );
    assert!(alice_group.epoch().as_u64() > before);

    // …and the group still works afterwards, which is the property an Update
    // that merely appeared to succeed would not have.
    let wire = alice
        .send(&mut alice_group, b"after the update")
        .expect("send");
    assert_eq!(
        bob.receive(&mut bob_group, &wire, b"msg-3", NOW)
            .expect("receive")
            .payload(),
        Some(b"after the update".as_slice())
    );
}

#[test]
fn bob_can_update_too_and_alice_follows() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let commit = bob.update(&mut bob_group).expect("update");
    alice
        .receive(&mut alice_group, &commit, b"commit-1", NOW)
        .expect("process commit");

    assert_eq!(alice_group.epoch(), bob_group.epoch());
}

#[test]
fn both_sides_derive_the_same_bytes_for_every_exporter_label() {
    let (alice, alice_group, bob, bob_group) = paired();

    for label in ExportLabel::ALL {
        let context = b"ceremony-or-session-or-conversation";
        let from_alice = alice
            .export_secret(&alice_group, *label, context, 32)
            .expect("export");
        let from_bob = bob
            .export_secret(&bob_group, *label, context, 32)
            .expect("export");
        assert_eq!(from_alice, from_bob, "{label} disagreed across devices");
        assert_eq!(from_alice.len(), 32);
    }
}

#[test]
fn different_exporter_labels_and_contexts_give_different_bytes() {
    let (alice, alice_group, _bob, _bob_group) = paired();

    let frost = alice
        .export_secret(&alice_group, ExportLabel::Frost, b"c", 32)
        .expect("export");
    let webrtc = alice
        .export_secret(&alice_group, ExportLabel::Webrtc, b"c", 32)
        .expect("export");
    let frost_other_context = alice
        .export_secret(&alice_group, ExportLabel::Frost, b"d", 32)
        .expect("export");

    assert_ne!(frost, webrtc, "the label must separate the domains");
    assert_ne!(frost, frost_other_context, "the context must matter");
}

/// Forward secrecy, as far as the exporter can show it: the epoch's material
/// changes when the epoch does.
#[test]
fn an_update_changes_the_exported_material() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let before = alice
        .export_secret(&alice_group, ExportLabel::History, b"conv", 32)
        .expect("export");

    let commit = alice.update(&mut alice_group).expect("update");
    bob.receive(&mut bob_group, &commit, b"commit-1", NOW)
        .expect("process commit");

    let after = alice
        .export_secret(&alice_group, ExportLabel::History, b"conv", 32)
        .expect("export");
    assert_ne!(before, after);
    assert_eq!(
        after,
        bob.export_secret(&bob_group, ExportLabel::History, b"conv", 32)
            .expect("export")
    );
}

#[test]
fn two_engines_share_no_state() {
    let (alice, _alice_group, bob, _bob_group) = paired();

    // Each store holds its own group, and neither is empty — if they were the
    // same store, the counts would be identical for a trivial reason.
    assert!(alice.provider().store().backend().len().expect("len") > 0);
    assert!(bob.provider().store().backend().len().expect("len") > 0);
    assert_ne!(
        alice.credential().credential.device_pk,
        bob.credential().credential.device_pk
    );
    assert_ne!(
        alice.credential().credential.identity_pk,
        bob.credential().credential.identity_pk
    );
}

#[test]
fn both_sides_record_the_protocol_version_beside_the_group() {
    let (alice, _alice_group, bob, _bob_group) = paired();
    assert_eq!(
        alice.protocol_version(GROUP_ID).expect("version"),
        Some(ProtocolVersion::CURRENT)
    );
    assert_eq!(
        bob.protocol_version(GROUP_ID).expect("version"),
        Some(ProtocolVersion::CURRENT)
    );
    assert_eq!(
        alice
            .protocol_version(b"a group nobody created")
            .expect("version"),
        None
    );
}

// --- the failure paths ------------------------------------------------------
//
// These are where delete-on-ack turns a bug into data loss, so they get the
// same attention as the happy path.

/// A device may publish queue addresses on *k* relays and senders send to all
/// *k* (`ARCHITECTURE.md` §9.4), so the same message arriving twice is routine.
/// A device's own `PrivateMessage`, handed back by the relay, is an outcome and
/// not an error.
///
/// # This is a behaviour change the 0.9 migration brought with it
///
/// `ARCHITECTURE.md` §9.4 makes it routine rather than exotic: a device may
/// publish queue addresses on *k* relays and a sender sends to all *k*, so a
/// device that is also a member sees its own traffic come back. Under
/// `openmls 0.8.1` that failed to decrypt — the own sender ratchet is
/// encryption-only — and [`MlsEngine::receive`] returned `EngineError::Mls`,
/// which put the caller in the position of having to distinguish "the relay
/// echoed me" from "something is wrong with this group" by guessing.
///
/// `openmls 0.9` surfaces it as `ProcessedMessageContent::OwnPrivateMessage`,
/// and this engine maps it to [`Received::Own`]. The consequences the test
/// pins are the ones that matter under delete-on-ack (§6.4):
///
/// * the plaintext is **not** returned — `payload()` is `None`, because the
///   content of our own message is the caller's and the engine has nothing to
///   decrypt;
/// * the durable "handled" record **is** written, so the caller may `ACK` and
///   the relay may drop its copy. That is the whole reason for surfacing it
///   rather than failing: an echo that always errored would be an echo that
///   could never be acknowledged, and the relay would keep redelivering it.
#[test]
fn a_devices_own_message_handed_back_is_an_outcome_and_not_an_error() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let wire = alice.send(&mut alice_group, b"hello, bob").expect("send");

    // The relay hands Alice her own message back.
    let received = alice
        .receive(&mut alice_group, &wire, b"echo-1", NOW)
        .expect("an echo is not an error");
    assert_eq!(received, Received::Own);
    assert_eq!(received.payload(), None);

    // The record was written in the same transaction, so a second delivery of
    // the same echo is a duplicate rather than a second `Own`. This is what
    // makes the `ACK` safe.
    assert!(matches!(
        alice.receive(&mut alice_group, &wire, b"echo-1", NOW),
        Err(EngineError::Duplicate)
    ));

    // Neither side moved, and the group still works in both directions.
    assert_eq!(alice_group.epoch(), bob_group.epoch());
    assert_eq!(
        bob.receive(&mut bob_group, &wire, b"msg-1", NOW)
            .expect("bob still decrypts it")
            .payload(),
        Some(b"hello, bob".as_slice())
    );
    let reply = bob.send(&mut bob_group, b"hello, alice").expect("send");
    assert_eq!(
        alice
            .receive(&mut alice_group, &reply, b"msg-2", NOW)
            .expect("receive")
            .payload(),
        Some(b"hello, alice".as_slice())
    );
}

#[test]
fn a_duplicate_delivery_is_refused_and_changes_nothing() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let wire = alice.send(&mut alice_group, b"once").expect("send");
    assert_eq!(
        bob.receive(&mut bob_group, &wire, b"msg-1", NOW)
            .expect("first delivery")
            .payload(),
        Some(b"once".as_slice())
    );

    let epoch_before = bob_group.epoch();
    assert!(matches!(
        bob.receive(&mut bob_group, &wire, b"msg-1", NOW),
        Err(EngineError::Duplicate)
    ));
    assert_eq!(bob_group.epoch(), epoch_before);

    // …and the group is undamaged: the next real message still decrypts.
    let next = alice.send(&mut alice_group, b"twice").expect("send");
    assert_eq!(
        bob.receive(&mut bob_group, &next, b"msg-2", NOW)
            .expect("second message")
            .payload(),
        Some(b"twice".as_slice())
    );
}

/// The relay may reorder freely (`WIRE.md` §5.4), so a commit for an epoch this
/// device has already left is a transport event, not a defect — and it must not
/// damage the group.
#[test]
fn an_out_of_order_commit_is_refused_and_leaves_the_group_usable() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    // Alice commits twice. Bob is handed the *second* one first.
    let first = alice.update(&mut alice_group).expect("update");
    let second = alice.update(&mut alice_group).expect("update");

    let epoch_before = bob_group.epoch();
    let outcome = bob.receive(&mut bob_group, &second, b"commit-2", NOW);
    assert!(
        matches!(outcome, Err(EngineError::OutOfOrder | EngineError::Mls(_))),
        "a commit from a future epoch must be refused, got {outcome:?}"
    );
    assert_eq!(
        bob_group.epoch(),
        epoch_before,
        "a refused commit must not have advanced the epoch"
    );

    // Applying them in order still works, which is what "refused, not damaged"
    // has to mean.
    bob.receive(&mut bob_group, &first, b"commit-1", NOW)
        .expect("first commit");
    bob.receive(&mut bob_group, &second, b"commit-2b", NOW)
        .expect("second commit");
    assert_eq!(alice_group.epoch(), bob_group.epoch());
}

/// A refused delivery must not leave a "handled" record behind, or the
/// redelivery the relay is about to make would be dropped as a duplicate — and
/// under delete-on-ack that message is then gone.
#[test]
fn a_refused_delivery_leaves_no_handled_record() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let first = alice.update(&mut alice_group).expect("update");
    let second = alice.update(&mut alice_group).expect("update");

    let _ = bob.receive(&mut bob_group, &second, b"commit-2", NOW);

    // Same record key, correct order this time: it must be processed, not
    // rejected as already handled.
    bob.receive(&mut bob_group, &first, b"commit-1", NOW)
        .expect("first commit");
    bob.receive(&mut bob_group, &second, b"commit-2", NOW)
        .expect("the redelivery must not have been swallowed as a duplicate");
    assert_eq!(alice_group.epoch(), bob_group.epoch());
}

#[test]
fn an_apply_failure_after_merging_restores_memory_and_redelivery_succeeds() {
    let bob_backend = FailableBackend::new();
    let (alice, mut alice_group, bob, mut bob_group) =
        paired_with_bob_backend(bob_backend.clone(), NOW + 1_000_000);

    alice_group.set_aad(TEST_AAD.to_vec());
    bob_group.set_aad(TEST_AAD.to_vec());
    let commit = alice.update(&mut alice_group).expect("update");
    let epoch_before = bob_group.epoch();

    bob_backend.set_fail_apply(true);
    let outcome = bob.receive(&mut bob_group, &commit, b"commit-apply", NOW);
    assert!(
        matches!(
            outcome,
            Err(EngineError::Storage(StoreError::Backend(
                "injected apply failure"
            )))
        ),
        "the injected durable-store failure must be returned, got {outcome:?}"
    );
    assert_eq!(
        bob_group.epoch(),
        epoch_before,
        "a commit refused after merge must restore the caller's group"
    );
    assert_eq!(
        bob_group.aad(),
        TEST_AAD,
        "durable MLS state omits ephemeral AAD, so rollback must restore it explicitly"
    );

    bob_backend.set_fail_apply(false);
    let redelivery = bob
        .receive(&mut bob_group, &commit, b"commit-apply", NOW)
        .expect("the unhandled commit must remain applicable after storage recovers");
    assert_eq!(
        redelivery,
        Received::EpochChanged {
            epoch: bob_group.epoch().as_u64()
        }
    );
    assert_eq!(alice_group.epoch(), bob_group.epoch());
}

#[test]
fn an_application_apply_failure_restores_the_receive_ratchet_for_redelivery() {
    let bob_backend = FailableBackend::new();
    let (alice, mut alice_group, bob, mut bob_group) =
        paired_with_bob_backend(bob_backend.clone(), NOW + 1_000_000);
    alice_group.set_aad(TEST_AAD.to_vec());
    bob_group.set_aad(TEST_AAD.to_vec());
    let wire = alice
        .send(&mut alice_group, b"ratchet rollback")
        .expect("send");

    bob_backend.set_fail_apply(true);
    let outcome = bob.receive(&mut bob_group, &wire, b"application-apply", NOW);
    assert!(
        matches!(
            outcome,
            Err(EngineError::Storage(StoreError::Backend(
                "injected apply failure"
            )))
        ),
        "the injected durable-store failure must be returned, got {outcome:?}"
    );
    assert_eq!(
        bob_group.aad(),
        TEST_AAD,
        "application rollback must preserve non-empty AAD"
    );

    bob_backend.set_fail_apply(false);
    let redelivery = bob
        .receive(&mut bob_group, &wire, b"application-apply", NOW)
        .expect("the restored receive ratchet must accept redelivery");
    assert_eq!(redelivery.payload(), Some(b"ratchet rollback".as_slice()));
}

#[test]
fn a_restore_read_failure_requires_a_fresh_group_before_redelivery() {
    let bob_backend = FailableBackend::new();
    let (alice, mut alice_group, bob, mut bob_group) =
        paired_with_bob_backend(bob_backend.clone(), NOW + 1_000_000);
    alice_group.set_aad(TEST_AAD.to_vec());
    bob_group.set_aad(TEST_AAD.to_vec());
    let commit = alice.update(&mut alice_group).expect("update");
    let group_id = bob_group.group_id().clone();

    bob_backend.fail_apply_and_restore_get_once();
    let outcome = bob.receive(&mut bob_group, &commit, b"restore-read", NOW);
    match outcome {
        Err(EngineError::GroupStateUnavailable { operation, reload }) => {
            assert!(matches!(
                operation.as_ref(),
                EngineError::Storage(StoreError::Backend("injected apply failure"))
            ));
            assert!(matches!(
                reload.as_ref(),
                EngineError::Storage(StoreError::Backend("injected restore get failure"))
            ));
        }
        other => panic!("the caller must be told to discard the group, got {other:?}"),
    }

    // The handle passed above may contain the uncommitted epoch and is never
    // reused. This is the same fresh durable load the ZUULI caller performs
    // when it sees GroupStateUnavailable.
    bob_backend.set_fail_apply(false);
    let mut restored = openmls::prelude::MlsGroup::load(bob.provider().store(), &group_id)
        .expect("fresh durable load")
        .expect("durable pre-transaction group");
    restored.set_aad(TEST_AAD.to_vec());
    let redelivery = bob
        .receive(&mut restored, &commit, b"restore-read", NOW)
        .expect("redelivery through the freshly loaded group");
    assert_eq!(
        redelivery,
        Received::EpochChanged {
            epoch: restored.epoch().as_u64()
        }
    );
    assert_eq!(alice_group.epoch(), restored.epoch());
}

#[test]
fn post_merge_credential_failure_restores_memory_for_redelivery() {
    let (alice, mut alice_group, bob, mut bob_group) =
        paired_with_bob_backend(MemoryBackend::new(), NOW + 1);
    let commit = alice.update(&mut alice_group).expect("update");
    let epoch_before = bob_group.epoch();
    let after_bob_expired = NOW + 2;

    for attempt in 1..=2 {
        let outcome = bob.receive(
            &mut bob_group,
            &commit,
            b"commit-expired-member",
            after_bob_expired,
        );
        assert!(
            matches!(
                outcome,
                Err(EngineError::Credential(
                    f2z_msg_mls::CredentialError::Expired
                ))
            ),
            "redelivery {attempt} must reach post-merge credential validation, got {outcome:?}"
        );
        assert_eq!(
            bob_group.epoch(),
            epoch_before,
            "redelivery {attempt} must restore the caller's pre-commit epoch"
        );
    }
}

#[test]
fn a_truncated_message_is_refused_and_leaves_the_group_usable() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let wire = alice.send(&mut alice_group, b"hello").expect("send");
    let truncated = &wire[..wire.len() - 1];

    assert!(
        bob.receive(&mut bob_group, truncated, b"msg-1", NOW)
            .is_err()
    );

    let good = alice.send(&mut alice_group, b"hello again").expect("send");
    assert_eq!(
        bob.receive(&mut bob_group, &good, b"msg-2", NOW)
            .expect("receive")
            .payload(),
        Some(b"hello again".as_slice())
    );
}

/// A flipped ciphertext byte must be a refusal, not a crash.
///
/// # This used to be gated on `not(debug_assertions)`, and no longer is
///
/// `openmls 0.8.1`'s `private_message_in.rs:136` ran
/// `debug_assert!(false, "Ciphertext decryption failed")` on the AEAD-open
/// failure path — a path any peer, or any relay that flips one byte, can reach
/// at will. The assertion compiled out in release and the function correctly
/// returned `MessageDecryptionError::AeadError`, but in a **debug** build,
/// which is what `cargo test` produces, the process aborted. The property was
/// therefore true of what shipped and unassertable by the suite CI ran, so the
/// case was gated and CI ran it in a separate `--release` step.
///
/// **0.9.0 removed that path**: both AEAD-open failures in
/// `private_message_in.rs` are now `log::error!` followed by a returned
/// `MessageDecryptionError::AeadError`, with no `debug_assert` anywhere in
/// `src/framing/` except an unrelated key-package version check. The gate and
/// the extra CI step both came off with #723 — verified by running this case in
/// an ordinary debug `cargo test`, not by reading the changelog.
///
/// It is left as its own named case rather than folded into
/// `a_truncated_message_is_refused_…` because the two exercise different
/// refusals: a truncation fails to parse, and this one parses and fails to
/// open.
#[test]
fn a_corrupted_ciphertext_is_refused_and_leaves_the_group_usable() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();

    let mut wire = alice.send(&mut alice_group, b"hello").expect("send");
    let last = wire.len() - 1;
    wire[last] ^= 0xFF;

    assert!(bob.receive(&mut bob_group, &wire, b"msg-1", NOW).is_err());

    let good = alice.send(&mut alice_group, b"hello again").expect("send");
    assert_eq!(
        bob.receive(&mut bob_group, &good, b"msg-2", NOW)
            .expect("receive")
            .payload(),
        Some(b"hello again".as_slice())
    );
}

#[test]
fn trailing_bytes_after_a_message_are_refused() {
    let (alice, mut alice_group, bob, mut bob_group) = paired();
    let mut wire = alice.send(&mut alice_group, b"hello").expect("send");
    wire.push(0);
    assert!(bob.receive(&mut bob_group, &wire, b"msg-1", NOW).is_err());
}

/// The identity→device binding, at the point it actually matters: a credential
/// that describes somebody else's device must not produce a working engine.
///
/// The credential itself is genuine — issued by a real `IdentitySigningKey`
/// through `f2z-msg-identity` — and it is the *pairing* that is wrong. That is
/// the substitution §4.2's binding exists to stop, and the earliest point it can
/// be caught is here, on the device that would otherwise publish a KeyPackage
/// nobody else will accept.
#[test]
fn a_credential_that_describes_another_device_cannot_build_an_engine() {
    let alice = device("alice", 11, 111);

    // Mallory's credential names device key 44; her engine would sign with 55.
    let (credential, _real_device) = issue_credential("mallory", 33, 44, NOW - 1000, NOW + 1000);
    let other_signer = f2z_msg_mls::DeviceSigner::from_private_key([55u8; 32]);

    assert!(matches!(
        MlsEngine::new(MemoryBackend::new(), other_signer, credential, NOW),
        Err(EngineError::Credential(_))
    ));

    // And nothing about Alice changed.
    let mut group = alice.create_group(GROUP_ID).expect("create group");
    assert!(alice.validate_members(&group, NOW).is_ok());
    let _ = alice.send(&mut group, b"still fine").expect("send");
}

#[test]
fn an_expired_credential_is_refused() {
    let engine = device("alice", 11, 111);
    assert!(matches!(
        engine.validate_members(
            &engine.create_group(GROUP_ID).expect("group"),
            NOW + 10_000_000
        ),
        Err(EngineError::Credential(_))
    ));
}

#[test]
fn a_key_package_cannot_be_parsed_as_a_welcome() {
    let bob = device("bob", 22, 222);
    let key_package = bob.generate_key_package().expect("key package");
    assert!(bob.join_from_welcome(&key_package, NOW).is_err());
}
