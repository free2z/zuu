//! A device with nowhere to hold a `DeviceWrapKey` refuses to enroll (#937).
//!
//! ADR 0016 §3.5 states the rule and flags it as **inferred from this tree's
//! fail-closed doctrine rather than read anywhere**, with §9 option F offering
//! the alternative — degrade instead of refusing. `src/custody.rs`'s module
//! header §3 records which was chosen and why. This file is the part of that
//! decision a future edit cannot quietly undo.
//!
//! # What is actually at stake, restated where the assertions are
//!
//! It is *not* the strength of the seal. Per ADR 0016's Fact 6 the seal covers
//! only the signing key and the queue seed, and the MLS group state and message
//! plaintext sit unencrypted beside it (`store.rs:40-50`). The thing a refusal
//! prevents is the other failure: an app that enrolls without durable custody
//! cannot reopen its seal on the next launch, and the only way forward from
//! there is to enroll again. Every one of those mints a device, a credential
//! and a directory entry, and `ARCHITECTURE.md:318-322` requires each new
//! device entry to be surfaced to the user as a possible wiretap. The
//! notification storm is the visible symptom; the append-only log full of one
//! user's phantom devices is the durable one. So the refusal is cheap and the
//! alternative is permanent, which is why it is a refusal.
//!
//! # Why this is a real test and not a tautology
//!
//! Three things are asserted rather than one, because "it returned an error" is
//! satisfied by an engine that is broken for any reason at all:
//!
//! 1. Custody being absent is what refuses — the *same* enrollment succeeds
//!    against the *same* engine construction with working custody.
//! 2. The refusal happens before anything is minted, so a refused enrollment
//!    leaves the engine exactly as unenrolled as it found it.
//! 3. The refusal is `durability-unavailable`, the §8 code whose contract is
//!    non-retryable and "there is no degraded mode to enter". A retryable code
//!    here would invite the UI to loop, which is the failure this whole rule is
//!    about.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::{AccountKeys, DeviceCredentialRequest};
use f2z_msg_store::MemoryBackend;
use tauri_plugin_f2zmsg::custody::{CustodyKind, WrapKeyCustody};
use tauri_plugin_f2zmsg::engine::{Engine, IdentityInstall};
use tauri_plugin_f2zmsg::events::{EventSink, NullSink};
use tauri_plugin_f2zmsg::models::{EngineState, ErrorCode, Platform};

const NOW: i64 = 1_800_000_000_000;

/// An engine with the custody it is given, and nothing else different.
///
/// The two arms of every assertion below differ in exactly this argument, which
/// is what makes the comparison mean anything.
fn engine(custody: WrapKeyCustody) -> Engine<MemoryBackend> {
    Engine::new(
        MemoryBackend::new(),
        Arc::new(NullSink) as Arc<dyn EventSink>,
        Platform::ZuuliDesktop,
    )
    .expect("engine")
    .with_wrap_key_custody(custody)
}

/// Enrollment as the app crate performs it (§2.2).
async fn enroll(engine: &Engine<MemoryBackend>, handle: &str) -> tauri_plugin_f2zmsg::Result<()> {
    let device = engine.prepare_device().await?;
    let account = AccountKeys::from_seed(&[7; 64], 0).expect("§4.2 keys");
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
    engine
        .install_identity(IdentityInstall {
            credential: f2z_msg_mls::credential::encode(&credential).expect("encode"),
            // The handle this enrollment asked for, which is what the engine
            // compares the credential's own handle against (#936). It is the
            // helper's argument rather than anything read back out of the
            // credential, so the comparison stays a real one.
            expected_handle: handle.to_owned(),
            wrap_key: *account.backup_wrap.as_bytes(),
            submitted_at: NOW,
        })
        .await?;
    Ok(())
}

/// The platforms #937 is about: iOS and Android before this change, and a Linux
/// desktop with no Secret Service daemon after it. All three reach the engine
/// as custody that refuses.
fn no_secret_store() -> WrapKeyCustody {
    WrapKeyCustody::unavailable("this device has no OS secret store")
}

#[tokio::test]
async fn a_device_with_no_secret_store_refuses_to_enroll() {
    let engine = engine(no_secret_store());
    assert_eq!(engine.wrap_key_custody().kind(), CustodyKind::Unavailable);

    let refused = enroll(&engine, "someone").await.expect_err(
        "a device that cannot hold a wrap key must refuse to enroll, not enroll into a state it \
         cannot reopen (ADR 0016 §3.5)",
    );

    // §8: non-retryable, and the UI is told there is no degraded mode. A
    // retryable code would invite exactly the re-enrollment loop this refusal
    // exists to prevent.
    assert_eq!(refused.code(), ErrorCode::DurabilityUnavailable);
    assert!(
        !refused.code().retryable(),
        "a retryable refusal would have the UI mint a directory entry per attempt"
    );
}

#[tokio::test]
async fn the_refusal_is_custodys_and_not_the_engines() {
    // The load-bearing half. If this test passed with working custody too, the
    // one above would be measuring an engine that cannot enroll for some other
    // reason, and would keep passing after someone deleted the preflight.
    let engine = engine(WrapKeyCustody::in_memory());
    enroll(&engine, "someone")
        .await
        .expect("the identical enrollment must succeed when custody works");

    let status = engine.status().await.expect("status");
    assert!(status.enrolled);
}

#[tokio::test]
async fn a_refused_enrollment_mints_nothing() {
    // The property the refusal is actually for: nothing was created, so there
    // is no credential to revoke, no directory entry to explain, and no wiretap
    // notification to send. Refusing costs one refusal.
    let engine = engine(no_secret_store());
    enroll(&engine, "someone").await.expect_err("must refuse");

    let status = engine.status().await.expect("status");
    assert!(!status.enrolled, "a refused enrollment must enroll nothing");
    assert_eq!(status.state, EngineState::Uninitialized);
    assert_eq!(status.handle, None);

    // And it did not half-enroll: `install_identity` without a completed
    // `prepare_device` has no pending device to consume.
    //
    // The credential here is well-formed and attests the handle being asked
    // for, deliberately. `install_identity` parses the credential and compares
    // its handle *before* it looks for the pending device (#936), so a stub
    // credential would fail on the parse and this assertion would pass without
    // ever reaching the property it names.
    let account = AccountKeys::from_seed(&[7; 64], 0).expect("§4.2 keys");
    let credential = account
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(b"someone".to_vec()).expect("handle"),
            // No device was prepared, so there is no leaf key to bind. Any
            // well-formed key does here: the refusal under test happens before
            // the binding is checked.
            device_pk: PublicKey::new([3; 32]),
            device_kem_pk: KemPublicKey::new(vec![4; 32]).expect("kem key"),
            not_before_ms: 0,
            not_after_ms: u64::MAX / 2,
        })
        .expect("credential");
    let orphaned = engine
        .install_identity(IdentityInstall {
            credential: f2z_msg_mls::credential::encode(&credential).expect("encode"),
            expected_handle: "someone".to_owned(),
            wrap_key: *account.backup_wrap.as_bytes(),
            submitted_at: NOW,
        })
        .await
        .expect_err("no device was prepared, so none can be installed");
    assert_eq!(orphaned.code(), ErrorCode::Internal);
    // §8 sends `internal` to the frontend with no detail, so the code alone
    // cannot say *which* internal refusal this was — and every earlier check in
    // `install_identity` also reports `internal`. Pinning the context is what
    // keeps this assertion measuring the missing pending device rather than a
    // credential that never got that far.
    assert!(
        orphaned.context().contains("without prepare_device"),
        "refused before reaching the pending-device check: {}",
        orphaned.context()
    );
}

#[tokio::test]
async fn a_store_that_accepts_writes_and_loses_them_is_not_good_enough() {
    // The reason the preflight is a round trip rather than a platform check
    // (`src/custody.rs` §4). A backend that returns `Ok` from a write and then
    // has nothing is indistinguishable from a working one until the next
    // launch — which is the launch that would re-enroll.
    let engine = engine(WrapKeyCustody::with_store(
        tauri_plugin_f2zmsg::custody::WrapKeyNamespace::new("cash.free2z.e2e2z.f2zmsg.wrap.v1")
            .expect("namespace"),
        Arc::new(Amnesiac),
    ));

    let refused = enroll(&engine, "someone")
        .await
        .expect_err("a store that forgets must refuse before enrollment, not after");
    assert_eq!(refused.code(), ErrorCode::DurabilityUnavailable);
}

/// Accepts every write and holds nothing.
struct Amnesiac;

impl tauri_plugin_f2zmsg::custody::WrapKeyStore for Amnesiac {
    fn put(&self, _: &str, _: &str) -> Result<(), tauri_plugin_f2zmsg::custody::CustodyError> {
        Ok(())
    }
    fn get(
        &self,
        _: &str,
    ) -> Result<zeroize::Zeroizing<String>, tauri_plugin_f2zmsg::custody::CustodyError> {
        Err(tauri_plugin_f2zmsg::custody::CustodyError::NotFound)
    }
    fn delete(&self, _: &str) -> Result<(), tauri_plugin_f2zmsg::custody::CustodyError> {
        Ok(())
    }
}
