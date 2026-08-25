//! `CLIENT-CONTRACT.md` §6.1's state machine, and §11.2's ACK rule, without a
//! relay.
//!
//! The two-process harness proves the whole path and needs a socket to do it.
//! This proves the transitions that happen *before* one exists — the ones a
//! frontend hits on a cold start, on a locked wallet, and on a wallet that was
//! never enrolled — which is where a user actually spends the first minute.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_store::MemoryBackend;
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall};
use tauri_plugin_f2zmsg::events::{EventSink, NullSink};
use tauri_plugin_f2zmsg::models::{EngineState, ErrorCode, IneligibilityReason, Platform};

const NOW: i64 = 1_800_000_000_000;

fn engine() -> Engine<MemoryBackend> {
    Engine::new(
        MemoryBackend::new(),
        Arc::new(NullSink) as Arc<dyn EventSink>,
        Platform::ZuuliDesktop,
    )
    .expect("engine")
}

/// Enrollment as the app crate performs it (§2.2): the seed stays here, and
/// only public material reaches the engine.
async fn enroll(engine: &Engine<MemoryBackend>, handle: &str, seed: u8) -> [u8; 32] {
    let device = engine.prepare_device().await.expect("device keys");
    let account = AccountKeys::from_seed(&[seed; 64], 0).expect("§4.2 keys");
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(handle.as_bytes().to_vec()).expect("handle"),
            device_pk: PublicKey::new(device.device_pk),
            device_kem_pk: KemPublicKey::new(device.device_kem_pk).expect("kem key"),
            not_before_ms: 0,
            not_after_ms: u64::MAX / 2,
        })
        .expect("credential");
    let wrap_key = *account.backup_wrap.as_bytes();
    engine
        .install_identity(IdentityInstall {
            handle: handle.to_owned(),
            identity_pk: hex::encode(account.identity.public().as_bytes()),
            credential: f2z_msg_mls::credential::encode(&credential).expect("encode"),
            wrap_key,
            submitted_at: NOW,
        })
        .await
        .expect("install");
    wrap_key
}

#[tokio::test]
async fn an_unenrolled_engine_refuses_to_start_and_says_which_way_to_go() {
    let engine = engine();
    let status = engine.status().await.expect("status");
    assert_eq!(status.state, EngineState::Uninitialized);
    assert!(!status.enrolled);
    assert_eq!(status.handle, None);

    // §8: `not-enrolled` routes to enrollment, which is an app-crate command
    // and not something this plugin can perform.
    let refused = engine.start().await.expect_err("must refuse");
    assert_eq!(refused.code(), ErrorCode::NotEnrolled);
    assert_eq!(
        engine.status().await.expect("status").state,
        EngineState::NotEnrolled
    );

    // And every command that needs a device says so rather than answering with
    // a shape full of defaults.
    assert_eq!(
        engine.device_info().await.expect_err("no device").code(),
        ErrorCode::NotEnrolled
    );
}

#[tokio::test]
async fn enrolling_leaves_the_submission_unmerged_and_says_why() {
    let engine = engine();
    enroll(&engine, "alice", 1).await;

    let enrollment = engine.enrollment_status().await.expect("enrollment");
    assert!(enrollment.enrolled);
    assert_eq!(enrollment.handle.as_deref(), Some("alice"));
    // §3.2: a directory submission does not take effect instantly, and the UI
    // shows "submitted" rather than "active" until the log merges it.
    assert_eq!(enrollment.merged_at_epoch, None);
    assert_eq!(enrollment.submitted_at, Some(NOW));
    // In this build it will never merge, and the reason is reported rather than
    // left as an unexplained "submitted".
    assert_eq!(enrollment.blocked, Some(ErrorCode::DirectoryUnreachable));

    assert_eq!(
        engine.status().await.expect("status").state,
        EngineState::Enrolling
    );
}

#[tokio::test]
async fn a_wrong_wrap_key_is_indistinguishable_from_an_absent_one() {
    let engine = engine();
    let wrap_key = enroll(&engine, "alice", 1).await;

    // §6.1's `locked`: enrolled, but local history is wrapped under
    // `BackupWrapKey` and cannot be decrypted. A wrong key and no key are the
    // same thing to a user, and the code says the same thing about both.
    let wrong = engine.unlock(&[0xab; 32]).await.expect_err("must refuse");
    assert_eq!(wrong.code(), ErrorCode::EngineLocked);

    let status = engine.unlock(&wrap_key).await.expect("unlock");
    assert_eq!(status.state, EngineState::Stopped);
    assert!(status.enrolled);
    assert_eq!(status.handle.as_deref(), Some("alice"));
}

#[tokio::test]
async fn an_in_memory_store_reports_no_durability_and_a_desktop_platform() {
    let engine = engine();
    let wrap_key = enroll(&engine, "alice", 1).await;
    engine.unlock(&wrap_key).await.expect("unlock");

    let device = engine.device_info().await.expect("device");
    assert_eq!(device.platform, Platform::ZuuliDesktop);
    // §11.2: a client that cannot promise durability must not ACK, and this is
    // where the UI learns it is in no-ACK mode. The shipping plugin opens
    // SQLite and reports `durable`; a store opened in memory must not claim it.
    assert_eq!(
        device.durability,
        tauri_plugin_f2zmsg::models::DurabilityMode::None
    );
    assert!(!device.device_fingerprint.is_empty());
    assert!(!device.identity_fingerprint.is_empty());
}

#[tokio::test]
async fn first_contact_fails_closed_rather_than_resolving_an_unverified_key() {
    let engine = engine();
    let wrap_key = enroll(&engine, "alice", 1).await;
    engine.unlock(&wrap_key).await.expect("unlock");

    // §6.4's first row and §9 rule 5. This is the #133 moment: an unverified
    // key at first contact *is* the MITM, so the refusal is the behaviour and
    // not a placeholder.
    let refused = engine
        .start_conversation("bob")
        .await
        .expect_err("must refuse");
    assert_eq!(refused.code(), ErrorCode::WitnessThresholdUnmet);

    let resolved = engine.resolve_handle("bob").await.expect_err("must refuse");
    assert_eq!(resolved.code(), ErrorCode::WitnessThresholdUnmet);

    // A string that cannot be a handle at all is a different thing entirely:
    // no lookup is made, so no proof exists and no threshold is consulted.
    let ineligible = engine
        .resolve_handle("Bob.Smith")
        .await
        .expect_err("must refuse");
    assert_eq!(ineligible.code(), ErrorCode::HandleIneligible);
}

#[tokio::test]
async fn safety_number_verification_is_available_regardless_of_directory_state() {
    // §3.10 and §8: manual safety-number verification is always available and
    // is the strongest check in the system regardless of the directory's state.
    // It must never be gated behind engine, relay or witness health — which is
    // exactly what makes it the thing the UI offers when everything above
    // refuses. There is no conversation here to compute one over, so what this
    // asserts is the *reason* a caller is turned away: a missing conversation,
    // never `witness-threshold-unmet` or `engine-not-running`.
    let engine = engine();
    let wrap_key = enroll(&engine, "alice", 1).await;
    engine.unlock(&wrap_key).await.expect("unlock");

    let refused = engine
        .safety_number("no-such-conversation")
        .await
        .expect_err("no conversation");
    assert_eq!(refused.code(), ErrorCode::Internal);
}

#[tokio::test]
async fn handle_eligibility_is_answerable_before_anything_is_running() {
    // §11.3: callable before enrollment and before the engine runs, so the UI
    // can decide what to render without provoking a failure.
    let engine = engine();
    let eligible = engine.check_handle_eligibility("SkylarSaveland");
    assert!(eligible.eligible);
    assert_eq!(eligible.candidate.as_deref(), Some("skylarsaveland"));

    let punctuated = engine.check_handle_eligibility("skylar.saveland");
    assert!(!punctuated.eligible);
    assert_eq!(punctuated.reason, Some(IneligibilityReason::Punctuation));
    assert_eq!(punctuated.candidate, None);
}

#[tokio::test]
async fn the_global_retention_policy_is_settable_and_forward_only() {
    use tauri_plugin_f2zmsg::models::{RetentionMode, RetentionScope};

    let engine = engine();
    let before = engine.retention_policy(None).await.expect("policy");
    assert_eq!(before.mode, RetentionMode::Keep);

    let set = engine
        .set_retention_policy(
            RetentionScope::Global,
            RetentionMode::Expire,
            Some(300),
            None,
        )
        .await
        .expect("set");
    assert_eq!(set.scope, RetentionScope::Global);
    assert_eq!(set.ttl_seconds, Some(300));
    // Forward only. Nothing here is retroactive in either direction, and
    // `effectiveFrom` exists so the UI can say so instead of implying otherwise.
    assert!(set.effective_from > 0);

    assert_eq!(
        engine
            .retention_policy(None)
            .await
            .expect("policy")
            .ttl_seconds,
        Some(300)
    );

    // §3.7: passing a conversation id with `scope: "global"` is a client bug and
    // is rejected rather than guessed at, and so is omitting one for a
    // per-conversation policy.
    assert!(
        engine
            .set_retention_policy(
                RetentionScope::Global,
                RetentionMode::Keep,
                None,
                Some("conv-1")
            )
            .await
            .is_err()
    );
    assert!(
        engine
            .set_retention_policy(
                RetentionScope::Conversation,
                RetentionMode::Keep,
                None,
                None
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_witness_set_with_no_independent_member_keeps_its_disclaimer() {
    use tauri_plugin_f2zmsg::models::WitnessInput;

    let engine = engine();
    let state = engine
        .set_witness_set(
            &[
                WitnessInput::Id("0f2c8a41".into()),
                WitnessInput::Named {
                    witness_id: "aabbccdd".into(),
                    name: "free2z".into(),
                },
            ],
            2,
        )
        .await
        .expect("set");

    assert_eq!(state.configured, 2);
    // §3.11 and `KT.md` §8.3: independence is computed by a rule that does not
    // exist yet, so `false` is the only honest value — and while it holds, the
    // UI must state plainly that no independent witness exists rather than
    // render a reassuring "2 of 2".
    assert_eq!(state.independent, 0);
    assert!(!state.threshold_met);
    assert!(state.bootstrap_disclaimer);

    // Both argument encodings survived: §3.11's object form keeps its name, and
    // `bridge.ts`'s bare-string form leaves it empty rather than being refused.
    let witnesses = engine.list_witnesses().await.expect("list");
    assert_eq!(witnesses.len(), 2);
    assert_eq!(witnesses[0].witness_id, "0f2c8a41");
    assert_eq!(witnesses[0].name, "");
    assert_eq!(witnesses[1].name, "free2z");
}

#[tokio::test]
async fn unenrolling_requires_a_typed_confirmation_and_then_forgets_everything() {
    let engine = engine();
    enroll(&engine, "alice", 1).await;

    assert!(engine.unenroll("  ").await.is_err(), "empty confirmation");

    let after = engine.unenroll("I MEAN IT").await.expect("unenroll");
    assert!(!after.enrolled);
    assert_eq!(after.handle, None);
    assert_eq!(
        engine.status().await.expect("status").state,
        EngineState::NotEnrolled
    );
}
