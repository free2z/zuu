//! `--log-level trace` must not become a directory of who talks to whom.
//!
//! This crate holds three things worth keeping out of a log file: an issuing
//! **private key**, an **identity key**, and a **handle**. The first is
//! obvious. The other two are the social graph: `THREAT-MODEL.md` §4.1 bounds
//! "who asked about whom" rather than removing it, and a debug print that
//! records every handle a client resolved hands the operator back exactly what
//! the bound was supposed to cost them.
//!
//! The checks are `f2z-codec`'s, applied to this crate's types, and they are
//! deliberately paranoid: absence of lowercase hex is not enough. Base16 in
//! either case, base64url, a **decimal byte list** and any long run of
//! hex-looking characters are all checked.
//!
//! The decimal case is the one that catches real leaks and is the trap
//! `f2z-codec` documents: `tls_codec`'s own byte vectors derive `Debug` and
//! print `TlsByteVecU8 { vec: [222, 222, …] }` — a complete dump containing no
//! hex at all, so a hex-only assertion passes while everything leaks. Every
//! structure below is checked against all four encodings for that reason.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the log's submission path is a remote denial
// of service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_authority::{
    AssertionNonce, AuthorityConfig, AuthorityId, AuthorityKey, AuthoritySet, Handle,
    HandleAssertionTBS, Intent, LogId, NonceLedger, SigningKey, Submission, Vouch,
};
use f2z_codec::types::{Digest, PublicKey, Signature};

/// A byte pattern distinctive enough that any encoding of it is recognisable.
const MARKER: u8 = 0xde;

fn base16_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn base16_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn decimal_list(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| b.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut buffer = [0u8; 3];
        buffer[..chunk.len()].copy_from_slice(chunk);
        let value =
            (u32::from(buffer[0]) << 16) | (u32::from(buffer[1]) << 8) | u32::from(buffer[2]);
        let count = chunk.len() + 1;
        for index in 0..count {
            let shift = 18 - 6 * index;
            out.push(char::from(ALPHABET[((value >> shift) & 0x3f) as usize]));
        }
    }
    out
}

/// Assert that `rendered` contains no encoding of `secret`, in any of the four
/// forms a careless `Debug` produces.
fn assert_absent(rendered: &str, secret: &[u8], what: &str) {
    for (form, encoded) in [
        ("base16 lower", base16_lower(secret)),
        ("base16 upper", base16_upper(secret)),
        ("decimal list", decimal_list(secret)),
        ("base64url", base64url(secret)),
    ] {
        assert!(
            !rendered.contains(&encoded),
            "{what} leaked as {form}: {rendered}"
        );
    }
    // And no long run of hex-looking characters at all, which catches an
    // encoding nobody thought of.
    let mut run = 0usize;
    for character in rendered.chars() {
        if character.is_ascii_hexdigit() {
            run += 1;
            assert!(run < 24, "{what}: a 24-character hex run in {rendered}");
        } else {
            run = 0;
        }
    }
}

#[test]
fn the_fixed_newtypes_redact() {
    let bytes = [MARKER; 32];
    for rendered in [
        format!("{:?}", AuthorityId::new(bytes)),
        format!("{:?}", LogId::new(bytes)),
        format!("{:?}", f2z_authority::HandleId::new(bytes)),
        format!("{:?}", AssertionNonce::new([MARKER; 16])),
    ] {
        assert_absent(&rendered, &bytes, "a fixed newtype");
        assert!(rendered.contains("<redacted>"), "{rendered}");
    }
}

#[test]
fn a_handle_does_not_render_its_text() {
    let handle = Handle::parse(b"alice").unwrap();
    let rendered = format!("{handle:?}");
    assert!(!rendered.contains("alice"), "{rendered}");
    assert_eq!(rendered, "Handle(<redacted; 5 bytes>)");
    // …and `as_str` is the deliberate way out, for a caller that has decided to
    // render one.
    assert_eq!(handle.as_str(), "alice");
}

#[test]
fn a_signing_key_renders_nothing_at_all() {
    let key = SigningKey::from_seed(&[MARKER; 32]);
    let rendered = format!("{key:?}");
    assert_eq!(rendered, "SigningKey(<redacted>)");
    assert_absent(&rendered, &[MARKER; 32], "an issuing private key");
}

#[test]
fn a_whole_assertion_renders_no_key_and_no_handle() {
    let authority = SigningKey::from_seed(&[MARKER; 32]);
    let identity = SigningKey::from_seed(&[0xad; 32]);
    let assertion = HandleAssertionTBS::new(
        &authority.public_key(),
        LogId::new([MARKER; 32]),
        Handle::parse(b"alice").unwrap(),
        identity.public_key(),
        Intent::Bind,
        1,
        1_000,
        2_000,
        AssertionNonce::new([MARKER; 16]),
    )
    .unwrap()
    .sign(&authority)
    .unwrap();

    let rendered = format!("{assertion:?}");
    assert!(!rendered.contains("alice"), "{rendered}");
    assert_absent(&rendered, identity.public_key().as_bytes(), "identity_pk");
    assert_absent(&rendered, &[MARKER; 32], "the log id and nonce");
    // The label is the one field that must render: it is the domain separator,
    // it is a constant, and hiding it would make a `Debug` useless for the one
    // thing a reader wants from it.
    assert!(
        rendered.contains("free2z/kt/v1/handle-assertion"),
        "{rendered}"
    );
}

#[test]
fn an_admitted_handle_renders_no_handle_and_no_key() {
    let authority = SigningKey::from_seed(&[MARKER; 32]);
    let identity = SigningKey::from_seed(&[0xad; 32]);
    let log_id = LogId::new([0x11; 32]);
    let handle = Handle::parse(b"alice").unwrap();
    let entry_digest = Digest::new([0x44; 32]);
    let config = AuthorityConfig::with_defaults(
        log_id,
        AuthoritySet::single(authority.public_key()).unwrap(),
    )
    .unwrap();

    let assertion = HandleAssertionTBS::new(
        &authority.public_key(),
        log_id,
        handle.clone(),
        identity.public_key(),
        Intent::Bind,
        1,
        1_000,
        2_000,
        AssertionNonce::new([0x55; 16]),
    )
    .unwrap()
    .sign(&authority)
    .unwrap();
    let bytes = f2z_codec::canonical::encode(&assertion).unwrap();
    let signature = config
        .binding(
            &handle,
            &identity.public_key(),
            Some(&assertion),
            &entry_digest,
        )
        .unwrap()
        .sign(&identity)
        .unwrap();

    let admitted = config
        .admit(
            &Submission {
                assertion: Some(&bytes),
                handle: &handle,
                identity_pk: &identity.public_key(),
                entry_version: 1,
                entry_digest: &entry_digest,
                identity_signature: &signature,
                previous_identity_pk: None,
                previous_account_epoch: None,
            },
            1_500,
            &mut NonceLedger::new(8, f2z_authority::DEFAULT_CLOCK_SKEW_MS),
        )
        .unwrap();

    let rendered = format!("{admitted:?}");
    assert!(!rendered.contains("alice"), "{rendered}");
    assert_absent(&rendered, identity.public_key().as_bytes(), "identity_pk");
    // The verdict itself must be readable: it is the thing an operator is
    // looking at the log line for, and `Vouch` carries no bytes worth hiding
    // beyond the authority id, which redacts on its own.
    assert!(rendered.contains("By("), "{rendered}");
}

#[test]
fn the_configuration_renders_no_key_material() {
    let authority = SigningKey::from_seed(&[MARKER; 32]);
    let config = AuthorityConfig::with_defaults(
        LogId::new([MARKER; 32]),
        AuthoritySet::new(vec![AuthorityKey::new(authority.public_key())]).unwrap(),
    )
    .unwrap();
    let rendered = format!("{config:?}");
    assert_absent(
        &rendered,
        authority.public_key().as_bytes(),
        "an issuing key",
    );
    assert_absent(&rendered, &[MARKER; 32], "the log id");
}

#[test]
fn a_submission_renders_neither_the_assertion_bytes_nor_the_signature() {
    let identity_pk = PublicKey::new([0xad; 32]);
    let handle = Handle::parse(b"alice").unwrap();
    let signature = Signature::new([MARKER; 64]);
    let entry_digest = Digest::new([MARKER; 32]);
    let assertion = vec![MARKER; 48];

    let submission = Submission {
        assertion: Some(&assertion),
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 1,
        entry_digest: &entry_digest,
        identity_signature: &signature,
        previous_identity_pk: None,
        previous_account_epoch: None,
    };
    let rendered = format!("{submission:?}");

    assert!(!rendered.contains("alice"), "{rendered}");
    assert_absent(&rendered, &[MARKER; 32], "the entry digest");
    assert_absent(&rendered, identity_pk.as_bytes(), "identity_pk");
    // `assertion` is a bare `&[u8]`. A derived `Debug` renders one as a list of
    // decimal integers — the documented trap, and the reason `Submission` has a
    // hand-written `Debug`. This assertion is what keeps it hand-written.
    assert_absent(&rendered, &assertion, "the assertion bytes");
    assert!(
        rendered.contains("Some(<redacted; 48 bytes>)"),
        "{rendered}"
    );
}

#[test]
fn the_unvouched_verdict_says_so_in_words_that_survive_a_log_line() {
    assert_eq!(Vouch::Unvouched.to_string(), "UNVOUCHED");
    assert_eq!(format!("{:?}", Vouch::Unvouched), "Unvouched");
}
