//! Nothing that holds key material may render it through `Debug`.
//!
//! # The trap this file exists for
//!
//! `f2z-codec`'s `tests/redaction.rs` documents it and it is worth restating,
//! because getting it wrong produces a **passing** test over a leaking type:
//! `tls_codec`'s byte vectors — and `Vec<u8>` generally — derive `Debug` and
//! print a full **decimal** byte list. `[171, 205, 239, 18]` contains no hex at
//! all, so a redaction check that greps for `abcdef12` sees a clean string
//! while the entire secret is in the log.
//!
//! Every assertion below therefore checks **both** bases, and it is the decimal
//! one that does the work.
//!
//! # Why this matters here specifically
//!
//! An MLS engine's `Debug` output is not a curiosity. A client run with tracing
//! on, or an FFI boundary that formats an error, produces exactly these strings
//! — and the values in reach are the device signing key, the epoch secrets in
//! the storage journal, and the identity key inside a credential. The redaction
//! is the mechanism that makes `THREAT-MODEL.md`'s claims survive contact with
//! a developer who turns logging up while debugging.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_msg_mls::DeviceSigner;
use f2z_msg_store::{F2zStorageProvider, MemoryBackend};

mod common;
use common::{NOW, issue_credential};

/// A byte pattern with a distinctive rendering in every base a leak could use.
const SECRET: [u8; 4] = [0xAB, 0xCD, 0xEF, 0x12];

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// `171, 205, 239, 18` — what a derived `Debug` on a byte slice prints, with no
/// surrounding brackets so that a *mid-buffer* dump is caught too. Anchoring on
/// the opening `[` is the mistake that lets a leak through when the bytes are a
/// field rather than the whole value.
fn decimal_run(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

#[track_caller]
fn assert_redacted(label: &str, rendered: &str, secret: &[u8]) {
    assert!(
        !rendered.contains(&hex_lower(secret)),
        "{label} leaked lowercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&hex_upper(secret)),
        "{label} leaked uppercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&decimal_run(secret)),
        "{label} leaked a decimal byte run: {rendered}"
    );
}

/// The negative control. If these three checks could not fire, every assertion
/// in this file would be decoration. Each of the three renderings below is what
/// a leak actually looks like, and each must be caught.
#[test]
fn the_checks_fire_on_a_rendering_that_leaks() {
    for leak in [
        format!("X({})", hex_lower(&SECRET)),
        format!("X({})", hex_upper(&SECRET)),
        format!("X([{}])", decimal_run(&SECRET)),
        // The mid-buffer case a bracket-anchored check would miss.
        format!("X([1, 2, {}, 9])", decimal_run(&SECRET)),
    ] {
        let caught = std::panic::catch_unwind(|| assert_redacted("control", &leak, &SECRET));
        assert!(caught.is_err(), "the check failed to fire on {leak}");
    }
}

#[test]
fn a_device_signer_redacts_both_keys() {
    let signer = DeviceSigner::from_private_key([0xAB; 32]);
    assert_redacted(
        "DeviceSigner",
        &format!("{signer:?}"),
        &SECRET[..1].repeat(4),
    );
    // And explicitly against the real private key bytes.
    assert_redacted("DeviceSigner", &format!("{signer:?}"), &[0xABu8; 4]);
    assert_redacted("DeviceSigner", &format!("{signer:?}"), signer.public_key());
}

#[test]
fn a_device_credential_redacts_every_key_and_the_signature() {
    // Issued by the real issuer, so this checks the `Debug` of the structure
    // that actually ships rather than of a local stand-in.
    let (credential, signer) = issue_credential("alice", 0xCD, 0xAB, 0, NOW * 2);

    let rendered = format!("{credential:?}");

    assert_redacted(
        "DeviceCredential identity_pk",
        &rendered,
        credential.credential.identity_pk.as_bytes(),
    );
    assert_redacted("DeviceCredential device_pk", &rendered, signer.public_key());
    // `device_kem_pk` is 1216 bytes of the device seed, so a dump of it renders
    // as a long run of the same value in either base.
    assert_redacted("DeviceCredential device_kem_pk", &rendered, &[0xABu8; 8]);
    assert_redacted(
        "DeviceCredential signature",
        &rendered,
        &credential.signature.as_bytes()[..8],
    );

    // The handle is the one field that is meant to be readable — it is public
    // by construction and is what a peer looks up in the directory. A `Debug`
    // that redacted it would be useless for diagnosis and would protect
    // nothing.
    assert!(rendered.contains("alice"), "{rendered}");
}

#[test]
fn the_storage_provider_redacts_its_journal() {
    let store = F2zStorageProvider::new(MemoryBackend::new());
    let transaction = store.begin().expect("begin");
    store.put_app(b"k", &[0xAB; 64]).expect("put");

    let rendered = format!("{store:?}");
    assert_redacted("F2zStorageProvider", &rendered, &[0xABu8; 4]);
    assert!(
        rendered.contains("staged_keys: 1"),
        "the count is what a diagnostic actually needs: {rendered}"
    );
    transaction.rollback().expect("rollback");
}

#[test]
fn the_engine_redacts_everything_it_holds() {
    let engine = common::device("alice", 0xCD, 0xAB);
    let credential = engine.credential().clone();

    let rendered = format!("{engine:?}");
    assert_redacted("MlsEngine device private key", &rendered, &[0xABu8; 4]);
    assert_redacted(
        "MlsEngine identity key",
        &rendered,
        credential.credential.identity_pk.as_bytes(),
    );
    assert_redacted(
        "MlsEngine device key",
        &rendered,
        credential.credential.device_pk.as_bytes(),
    );
    assert!(rendered.contains("alice"), "{rendered}");
}

/// The decrypted plaintext of a user's message is the sharpest thing in this
/// crate that a derived `Debug` would dump. `f2z-codec`'s
/// `workspace_debug_scan` catches the *shape*; this catches the bytes.
#[test]
fn a_received_application_message_does_not_render_its_plaintext() {
    use f2z_msg_mls::Received;

    let received = Received::Application {
        payload: b"meet me at the usual place".to_vec(),
        sender: 3,
        epoch: 7,
    };
    let rendered = format!("{received:?}");
    assert!(!rendered.contains("meet me"), "{rendered}");
    assert_redacted("Received", &rendered, &SECRET);
    assert_redacted("Received", &rendered, b"meet");
    // The two protocol-authenticated fields that order the transcript
    // (`CLIENT-CONTRACT.md` §7) are what a diagnostic needs and are safe.
    assert!(rendered.contains("sender: 3"), "{rendered}");
    assert!(rendered.contains("epoch: 7"), "{rendered}");
    assert!(rendered.contains("<redacted; 26 bytes>"), "{rendered}");
}

/// An error's `Debug` reaches whatever log the application installs, from a
/// path nobody reviews because it only runs when something is already wrong.
#[test]
fn errors_carry_no_bytes() {
    use f2z_msg_mls::{CredentialError, EngineError};

    for error in [
        EngineError::Signature,
        EngineError::Credential(CredentialError::BadSignature),
        EngineError::Mls("process message"),
        EngineError::OutOfOrder,
        EngineError::Duplicate,
    ] {
        let rendered = format!("{error:?} {error}");
        assert_redacted("EngineError", &rendered, &SECRET);
        assert!(!rendered.contains('['), "{rendered}");
    }
}
