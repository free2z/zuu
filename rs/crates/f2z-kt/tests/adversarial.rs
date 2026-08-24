//! **Nothing reaches `publish()` that did not go through the choke point.**
//!
//! `KT.md` §4.4's closing paragraph is the reason this file exists:
//!
//! > `akd` enforces none of it. The library will happily commit any bytes to
//! > any label. Every rule above lives in our submission path, and a log that
//! > skips them produces inclusion, history and append-only proofs that verify
//! > **perfectly** for entries nobody authorized. […] This is the integration
//! > NCC declined to review, and it is the highest-value target in the system
//! > for our own testing.
//!
//! So every test here is a well-formed submission with exactly one thing wrong,
//! sent through the same `LogService::submit` a network client reaches, and
//! every one of them asserts two things: the submission was refused **with the
//! right `KT.md` §9.5 code**, and the tree did not move.
//!
//! The second assertion is the one that matters. A refusal that still left the
//! entry in the pending batch would publish it on the next tick, and a test
//! that only checked the return value would never see it.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in a parser is a remote denial of service, and
// neither hazard exists here: a fixture that indexes past the end of a fixture
// is a failing test, which is what a test is for.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::Canonical as _;
use f2z_codec::types::{Digest, Signature};
use f2z_kt::testing::{EntryBuilder, Harness, Identity, entry_bytes, envelope_without_claim};
use f2z_kt::wire::{Presence, SubmissionEnvelope};
use f2z_kt_core::entry::EntryKind;
use f2z_kt_core::{ErrorCode, labels};

const NOW: u64 = 1_700_000_100_000;

/// The §9.5 code a submission was refused with.
fn refusal(result: Result<f2z_kt_core::SubmissionReceipt, f2z_kt::LogError>) -> ErrorCode {
    match result {
        Ok(_) => panic!("the log accepted a submission it must refuse"),
        Err(error) => error.wire_code(),
    }
}

/// Publish an epoch and return how many entries the tree gained beyond the
/// per-epoch heartbeat.
async fn publish_and_count(harness: &Harness) -> u64 {
    let before = harness
        .log
        .latest_bundle()
        .await
        .map(|b| b.head.sth.tree_size);
    let head = harness.log.publish_epoch(NOW).await.unwrap();
    match before {
        Ok(before) => head.sth.tree_size.saturating_sub(before).saturating_sub(1),
        // The genesis epoch: one heartbeat and nothing else.
        Err(_) => head.sth.tree_size.saturating_sub(1),
    }
}

// ---------------------------------------------------------------------------
// zuu#594 — what authorizes a handle's FIRST entry.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_first_entry_with_no_authority_assertion_is_refused() {
    // The whole of zuu#594 in one test. `KT.md` §4.4's table has no case for
    // `entry_version == 1`, so a literal implementation accepts this and hands
    // `@alice` to whoever sent it. This log does not.
    let harness = Harness::vouched("adv-no-assertion").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice)
        .device(0x10, &alice.isk)
        .same_key(&alice.dak);

    // Structurally perfect under §4.4: every signature verifies, the version is
    // 1, `prev_entry_hash` is all-zero. The only thing missing is the thing
    // §4.4 forgot to require.
    let envelope = envelope_without_claim(&entry);

    assert_eq!(
        refusal(harness.log.submit(&envelope, NOW).await),
        ErrorCode::BadAuthorization
    );
    assert_eq!(harness.log.pending_count().await, 0);
    assert_eq!(
        publish_and_count(&harness).await,
        0,
        "the tree did not move"
    );
}

#[tokio::test]
async fn a_first_entry_with_an_assertion_for_a_different_handle_is_refused() {
    let harness = Harness::vouched("adv-wrong-handle").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    // The assertion is issued for `bob`; the entry claims `alice`.
    let bob_entry = EntryBuilder::first(harness.log_id, "bob", &alice).same_key(&alice.dak);
    let alice_entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);

    let bob_envelope = harness.first_envelope(&bob_entry, &alice, NOW);
    let decoded = f2z_codec::decode_canonical::<SubmissionEnvelope>(&bob_envelope)
        .unwrap()
        .into_value();

    // Splice bob's assertion onto alice's entry. The identity signature is
    // re-derived so that only the handle mismatch is wrong.
    let alice_bytes = entry_bytes(&alice_entry);
    let spliced = SubmissionEnvelope::new(
        &alice_bytes,
        decoded.assertion_bytes(),
        decoded.identity_signature,
    )
    .unwrap()
    .encode_canonical()
    .unwrap();

    assert_eq!(
        refusal(harness.log.submit(&spliced, NOW).await),
        ErrorCode::BadAuthorization
    );
    assert_eq!(publish_and_count(&harness).await, 0);
}

#[tokio::test]
async fn a_stolen_assertion_is_useless_without_the_identity_key() {
    // The rule that makes the whole assertion design sound: the submission must
    // also be signed by the identity key the assertion is about. An attacker
    // who intercepts an assertion holds a document about somebody else's key.
    let harness = Harness::vouched("adv-stolen").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    let honest = harness.first_envelope(&entry, &alice, NOW);
    let decoded = f2z_codec::decode_canonical::<SubmissionEnvelope>(&honest)
        .unwrap()
        .into_value();

    let forged = SubmissionEnvelope::new(
        decoded.entry.as_slice(),
        decoded.assertion_bytes(),
        // Anything but the real binding signature.
        Signature::new([0x5a; 64]),
    )
    .unwrap()
    .encode_canonical()
    .unwrap();

    assert_eq!(
        refusal(harness.log.submit(&forged, NOW).await),
        ErrorCode::BadSignature
    );
    assert_eq!(publish_and_count(&harness).await, 0);
}

#[tokio::test]
async fn an_assertion_presented_above_version_one_is_refused_rather_than_ignored() {
    // The log admits an assertion at exactly `entry_version == 1`. Admitting one
    // later would give the platform a second way to authorize a change to a
    // live handle, which is the power ADR 0014 spent a cooldown and an alarm to
    // constrain.
    let harness = Harness::vouched("adv-late-assertion").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let first = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.first_envelope(&first, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();

    let prev_hash = labels::prev_entry_hash(&entry_bytes(&first));
    let second = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .prev_entry_hash(prev_hash)
        .same_key(&alice.dak);

    // A correct v2 submission, plus claim fields that have no business being
    // there.
    let with_claim = harness.first_envelope(&second, &alice, NOW);
    assert_eq!(
        refusal(harness.log.submit(&with_claim, NOW).await),
        ErrorCode::BadAuthorization
    );

    // And the same entry with the claim fields absent is accepted, so the test
    // is about the claim fields and nothing else.
    harness
        .log
        .submit(&envelope_without_claim(&second), NOW)
        .await
        .unwrap();
    assert_eq!(publish_and_count(&harness).await, 1);
}

#[tokio::test]
async fn an_unvouched_log_reports_itself_as_unvouched_and_still_demands_the_identity_key() {
    // zuu#594's other half: the no-authority mode is a real, supported
    // configuration for self-hosters — and it is *reported*, so a client can
    // see that handles on this log are unvouched rather than discovering it
    // after somebody takes their name.
    let harness = Harness::unvouched("adv-unvouched").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let policy = f2z_kt::sign_policy(
        harness.log.authority(),
        harness.log_id,
        harness.log.signer(),
        NOW,
    )
    .unwrap();
    policy
        .verify(&harness.log_id, &harness.log.log_public_key())
        .unwrap();
    assert!(
        !policy.policy.vouches(),
        "a client MUST be able to see that handles here are unvouched"
    );

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);

    // Even here the identity key must sign the binding: proof of possession is
    // the whole of the check when nobody is vouching.
    assert_eq!(
        refusal(
            harness
                .log
                .submit(&envelope_without_claim(&entry), NOW)
                .await
        ),
        ErrorCode::BadSignature
    );

    harness
        .log
        .submit(&harness.first_envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();
    assert_eq!(publish_and_count(&harness).await, 1);
}

// ---------------------------------------------------------------------------
// KT.md §4.4's numbered rules.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_wrong_prev_entry_hash_is_refused() {
    // §4.4 rule 4. The chain is redundant with the tree on purpose: it means a
    // client holding a sequence of entries can check their order and
    // completeness without the log.
    let harness = Harness::vouched("adv-prev-hash").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let first = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.first_envelope(&first, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();

    let second = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .prev_entry_hash(Digest::new([0xcc; 32]))
        .same_key(&alice.dak);

    assert_eq!(
        refusal(
            harness
                .log
                .submit(&envelope_without_claim(&second), NOW)
                .await
        ),
        ErrorCode::VersionConflict
    );
    assert_eq!(publish_and_count(&harness).await, 0);
}

#[tokio::test]
async fn a_key_change_carrying_only_one_of_the_two_signatures_is_refused() {
    // §4.4 rule 6, stated in the specification as a MUST in bold: "A key change
    // carrying only one of the two signatures MUST be rejected." The envelope
    // signature alone proves possession of the *new* directory-auth key, which
    // is exactly what an attacker who has just generated one has.
    let harness = Harness::vouched("adv-one-signature").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let first = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.first_envelope(&first, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();
    let prev_hash = labels::prev_entry_hash(&entry_bytes(&first));

    let attacker = Identity::from_byte(2);
    let rotation = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .kind(EntryKind::KeyChange)
        .identity_pk(attacker.isk.public)
        .directory_auth_pk(attacker.dak.public)
        .prev_entry_hash(prev_hash)
        // The rotation proof is signed by the **attacker's** new identity key
        // rather than by the outgoing one: one signature where two are
        // required.
        .key_change(&attacker.isk, alice.isk.public, &attacker.dak);

    assert_eq!(
        refusal(
            harness
                .log
                .submit(&envelope_without_claim(&rotation), NOW)
                .await
        ),
        ErrorCode::BadSignature
    );
    assert_eq!(publish_and_count(&harness).await, 0);

    // And the same rotation with the outgoing identity key's signature is
    // accepted, so the test is about the missing signature and nothing else.
    let honest = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .kind(EntryKind::KeyChange)
        .identity_pk(attacker.isk.public)
        .directory_auth_pk(attacker.dak.public)
        .prev_entry_hash(prev_hash)
        .key_change(&alice.isk, alice.isk.public, &attacker.dak);
    harness
        .log
        .submit(&envelope_without_claim(&honest), NOW)
        .await
        .unwrap();
    assert_eq!(publish_and_count(&harness).await, 1);
}

#[tokio::test]
async fn a_platform_reset_before_its_cooldown_is_refused() {
    // §4.4 rule 7: "the log MUST NOT publish the entry before `effective_at_ms`",
    // and `effective_at_ms - created_at_ms` must be at least the published
    // cooldown. ADR 0014 makes the reset path loud, delayed and permanently
    // counted; a reset that took effect immediately would be none of those.
    let harness = Harness::vouched("adv-cooldown").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let first = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.first_envelope(&first, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();
    let prev_hash = labels::prev_entry_hash(&entry_bytes(&first));

    let recovered = Identity::from_byte(3);
    // The harness configures a 60-second cooldown. This one asks for 10.
    let too_soon = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .kind(EntryKind::PlatformReset)
        .identity_pk(recovered.isk.public)
        .directory_auth_pk(recovered.dak.public)
        .prev_entry_hash(prev_hash)
        .created_at_ms(NOW)
        .platform_reset(
            &harness.reset_authority,
            alice.isk.public,
            NOW + 10_000,
            &recovered.dak,
        );

    assert_eq!(
        refusal(
            harness
                .log
                .submit(&envelope_without_claim(&too_soon), NOW)
                .await
        ),
        ErrorCode::Cooldown
    );

    // A reset that observes the cooldown but whose `effective_at_ms` has not
    // arrived yet is *also* refused — the second half of rule 7, and the half
    // that makes the delay real rather than decorative.
    let not_yet = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .kind(EntryKind::PlatformReset)
        .identity_pk(recovered.isk.public)
        .directory_auth_pk(recovered.dak.public)
        .prev_entry_hash(prev_hash)
        .created_at_ms(NOW)
        .platform_reset(
            &harness.reset_authority,
            alice.isk.public,
            NOW + 120_000,
            &recovered.dak,
        );
    assert_eq!(
        refusal(
            harness
                .log
                .submit(&envelope_without_claim(&not_yet), NOW)
                .await
        ),
        ErrorCode::Cooldown
    );
    assert_eq!(publish_and_count(&harness).await, 0);

    // Once the clock passes `effective_at_ms`, the same bytes are accepted and
    // the epoch counts the reset (ADR 0014, §6.1's `reset_count`).
    let later = NOW + 130_000;
    harness
        .log
        .submit(&envelope_without_claim(&not_yet), later)
        .await
        .unwrap();
    let head = harness.log.publish_epoch(later).await.unwrap();
    assert_eq!(head.sth.reset_count, 1, "resets are counted per epoch");
}

#[tokio::test]
async fn a_reset_signed_by_anyone_but_the_pinned_authority_is_refused() {
    let harness = Harness::vouched("adv-reset-key").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let first = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.first_envelope(&first, &alice, NOW), NOW)
        .await
        .unwrap();
    harness.log.publish_epoch(NOW).await.unwrap();
    let prev_hash = labels::prev_entry_hash(&entry_bytes(&first));

    let impostor = f2z_kt::testing::Key::from_byte(0xee);
    let recovered = Identity::from_byte(3);
    let forged = EntryBuilder::first(harness.log_id, "alice", &alice)
        .version(2)
        .kind(EntryKind::PlatformReset)
        .identity_pk(recovered.isk.public)
        .directory_auth_pk(recovered.dak.public)
        .prev_entry_hash(prev_hash)
        .created_at_ms(NOW)
        .platform_reset(&impostor, alice.isk.public, NOW + 120_000, &recovered.dak);

    assert_eq!(
        refusal(
            harness
                .log
                .submit(&envelope_without_claim(&forged), NOW + 130_000)
                .await
        ),
        ErrorCode::BadSignature
    );
    assert_eq!(publish_and_count(&harness).await, 0);
}

#[tokio::test]
async fn a_device_credential_signed_by_the_wrong_identity_key_is_refused() {
    // §4.4 rule 8. A `DeviceCredential` is carried as the MLS `Credential` in a
    // member's `LeafNode` and validated by peers who have no directory access
    // at all, so a credential the directory admitted under the wrong signature
    // is a device those peers will accept.
    let harness = Harness::vouched("adv-device").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let mallory = Identity::from_byte(2);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice)
        // Signed by mallory's identity key, inside alice's entry.
        .device(0x20, &mallory.isk)
        .same_key(&alice.dak);

    assert_eq!(
        refusal(
            harness
                .log
                .submit(&harness.first_envelope(&entry, &alice, NOW), NOW)
                .await
        ),
        ErrorCode::BadSignature
    );
    assert_eq!(publish_and_count(&harness).await, 0);
}

#[tokio::test]
async fn a_second_entry_for_one_handle_in_one_epoch_is_refused() {
    // §4.3, and it is not a convenience rule: NCC Group's Medium-severity
    // finding against `akd` was "multiple key updates during epoch results in
    // invalid state" — `publish()` with duplicate labels in one batch left a
    // dangling interior node and no valid key for the user. The library defect
    // is fixed; the property that a caller must not hand `publish()` duplicate
    // labels is a property of the integration, which is the region NCC said its
    // review did not cover.
    let harness = Harness::vouched("adv-duplicate").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let first = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    harness
        .log
        .submit(&harness.first_envelope(&first, &alice, NOW), NOW)
        .await
        .unwrap();

    // Same handle, same epoch, before the first one has been published.
    let again = EntryBuilder::first(harness.log_id, "alice", &alice)
        .created_at_ms(NOW + 1)
        .same_key(&alice.dak);
    assert_eq!(
        refusal(
            harness
                .log
                .submit(&harness.first_envelope(&again, &alice, NOW), NOW)
                .await
        ),
        ErrorCode::VersionConflict
    );

    assert_eq!(
        publish_and_count(&harness).await,
        1,
        "exactly one entry for the handle reached the batch"
    );
}

#[tokio::test]
async fn an_entry_for_another_log_is_refused() {
    // §4.4 rule 2. Without it a submission collected from one log is replayable
    // against another, which is how a handle gets claimed on a log its owner
    // has never heard of.
    let harness = Harness::vouched("adv-wrong-log").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let elsewhere = f2z_kt_core::types::LogId::new([0x77; 32]);
    let entry = EntryBuilder::first(elsewhere, "alice", &alice).same_key(&alice.dak);

    assert_eq!(
        refusal(
            harness
                .log
                .submit(&harness.first_envelope(&entry, &alice, NOW), NOW)
                .await
        ),
        ErrorCode::UnsupportedVersion
    );
    assert_eq!(publish_and_count(&harness).await, 0);
}

#[tokio::test]
async fn bytes_that_are_not_a_submission_are_refused_without_panicking() {
    // The unauthenticated entry point. The workspace denies the arithmetic and
    // unwrap families precisely because a panic here is a remote denial of
    // service; this is the coarse check that the denial holds through the
    // server's own layer as well as the library's.
    let harness = Harness::vouched("adv-garbage").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    for garbage in [
        vec![],
        vec![0u8; 1],
        vec![0xffu8; 64],
        b"free2z/kt/v1/submission".to_vec(),
        vec![0x00, 0x01, 0xff, 0xff, 0xff],
    ] {
        let code = refusal(harness.log.submit(&garbage, NOW).await);
        assert!(
            matches!(code, ErrorCode::Malformed),
            "unexpected code {code:?}"
        );
    }
    assert_eq!(publish_and_count(&harness).await, 0);
}

// ---------------------------------------------------------------------------
// What the log serves after all of that.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_handle_nobody_registered_is_answered_as_unproved_absence() {
    // `KT.md` §8.1 requires a **proof** of non-membership and `akd` 0.13 has no
    // API that produces one. Rather than dress the gap up, the log labels the
    // answer as unproved — see `f2z_kt::wire::Presence` and the pull request.
    let harness = Harness::vouched("adv-absent").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let handle = f2z_kt_core::types::Handle::new(b"nobody".to_vec()).unwrap();
    let response = harness.log.lookup(&handle).await.unwrap();
    response.validate().unwrap();
    assert_eq!(
        Presence::from_code(response.presence).unwrap(),
        Presence::AbsentUnproved
    );
    assert!(response.proof.as_slice().is_empty());
}

#[tokio::test]
async fn a_receipt_is_issued_only_for_an_accepted_submission_and_it_verifies() {
    // §5.3: the log MUST return a receipt on every accepted submission and MUST
    // NOT return one for a submission it rejects. Without it, "the log accepted
    // my entry and never published it" is a complaint rather than a breach of a
    // signed promise with a deadline.
    let harness = Harness::vouched("adv-receipt").await;
    harness.log.publish_epoch(NOW).await.unwrap();

    let alice = Identity::from_byte(1);
    let entry = EntryBuilder::first(harness.log_id, "alice", &alice).same_key(&alice.dak);
    let receipt = harness
        .log
        .submit(&harness.first_envelope(&entry, &alice, NOW), NOW)
        .await
        .unwrap();

    receipt
        .verify(&harness.log_id, &harness.log.log_public_key())
        .unwrap();
    assert_eq!(receipt.receipt.entry_version, 1);
    assert_eq!(receipt.receipt.received_at_ms, NOW);
    assert!(
        receipt.receipt.merge_by_ms > receipt.receipt.received_at_ms,
        "a merge promise with no deadline is not a promise"
    );
    assert!(!receipt.deadline_passed(NOW));
}
