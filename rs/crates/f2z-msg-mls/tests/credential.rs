//! `DeviceCredential`, checked against credentials the **real issuer** produced.
//!
//! An integration test rather than a unit test, and deliberately: every
//! credential here comes from `f2z-msg-identity`'s
//! `IdentitySigningKey::issue_device_credential` (see `common/mod.rs`), which
//! makes this file the coordination test between #694's crate, `f2z-kt-core`'s
//! structure, and this engine's validator. A unit test could only have checked
//! the engine against its own idea of a credential, which is the failure mode
//! having one definition of the bytes exists to prevent.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::{PublicKey, ShortBytes};
use f2z_msg_mls::credential::{encode, parse, validate_at, validate_for_leaf};
use f2z_msg_mls::{CredentialError, DeviceSigner};

mod common;
use common::{NOW, issue_credential};

#[test]
fn a_credential_from_the_real_issuer_round_trips_through_its_encoding() {
    let (credential, _) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let bytes = encode(&credential).unwrap();
    let parsed = parse(&bytes).unwrap();
    assert_eq!(parsed, credential);
    assert_eq!(
        encode(&parsed).unwrap(),
        bytes,
        "canonical encoding must be a fixed point"
    );
}

#[test]
fn a_credential_from_the_real_issuer_validates_against_its_own_leaf_key() {
    let (credential, device) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    validate_at(&credential, NOW).unwrap();
    validate_for_leaf(&credential, device.public_key(), NOW).unwrap();
}

/// The binding. A credential can be entirely genuine and still be the wrong
/// credential for the leaf it arrived in.
#[test]
fn a_credential_presented_on_another_leaf_is_rejected() {
    let (credential, _) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let other = DeviceSigner::from_private_key([99u8; 32]).unwrap();
    assert_eq!(
        validate_for_leaf(&credential, other.public_key(), NOW),
        Err(CredentialError::DeviceKeyMismatch)
    );
}

/// A forgery that edits `device_pk` to match a leaf must fail on the
/// **signature**, not on the binding — so `DeviceKeyMismatch` never means
/// "somebody tampered", only "this is the wrong leaf for a real credential".
#[test]
fn editing_the_device_key_breaks_the_signature_before_it_breaks_the_binding() {
    let (credential, _) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let attacker = DeviceSigner::from_private_key([99u8; 32]).unwrap();

    let mut forged = credential.clone();
    forged.credential.device_pk = PublicKey::new(*attacker.public_key());

    assert_eq!(
        validate_for_leaf(&forged, attacker.public_key(), NOW),
        Err(CredentialError::BadSignature)
    );
}

#[test]
fn a_credential_outside_its_validity_window_is_rejected_at_both_ends() {
    let (credential, device) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    assert_eq!(
        validate_for_leaf(&credential, device.public_key(), NOW - 100_000),
        Err(CredentialError::Expired)
    );
    assert_eq!(
        validate_for_leaf(&credential, device.public_key(), NOW + 100_000),
        Err(CredentialError::Expired)
    );
    // The boundaries themselves are inside the window.
    validate_for_leaf(&credential, device.public_key(), NOW - 1000).unwrap();
    validate_for_leaf(&credential, device.public_key(), NOW + 1000).unwrap();
}

/// What a peer that put a bare handle in a `BasicCredential` looks like from
/// here. It must be refused, not read as a credential with an odd handle.
#[test]
fn a_bare_handle_in_a_basic_credential_is_not_a_device_credential() {
    assert!(matches!(
        parse(b"alice"),
        Err(CredentialError::Malformed | CredentialError::WrongType)
    ));
    assert!(matches!(
        parse(b""),
        Err(CredentialError::Malformed | CredentialError::WrongType)
    ));
}

/// `WIRE.md` §3.3's rule, applied to a credential: exactly one encoding, or
/// nothing.
#[test]
fn trailing_bytes_are_refused() {
    let (credential, _) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let mut bytes = encode(&credential).unwrap();
    bytes.push(0);
    assert_eq!(parse(&bytes), Err(CredentialError::Malformed));
}

#[test]
fn a_truncated_credential_is_refused() {
    let (credential, _) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let bytes = encode(&credential).unwrap();
    assert_eq!(
        parse(&bytes[..bytes.len() - 1]),
        Err(CredentialError::Malformed)
    );
}

/// The label is what separates a `DeviceCredential` from any other opaque
/// identity string, and both doors have to check it: the engine reads a
/// credential out of a `LeafNode`, so it can reach validation without having
/// come through `parse`.
#[test]
fn a_credential_with_the_wrong_label_is_refused_by_both_doors() {
    let (credential, device) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let mut wrong = credential.clone();
    wrong.credential.label = ShortBytes::new(b"free2z/device-credential/v2".to_vec()).unwrap();

    assert_eq!(
        validate_for_leaf(&wrong, device.public_key(), NOW),
        Err(CredentialError::Malformed)
    );
    assert_eq!(
        parse(&encode(&wrong).unwrap()),
        Err(CredentialError::WrongType)
    );
}

/// Two devices of the same account share an identity key and differ in the
/// device key — which is what makes the binding, rather than the identity,
/// the thing an MLS peer has to check.
#[test]
fn two_devices_of_one_account_share_an_identity_and_not_a_device_key() {
    let (first, first_device) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let (second, second_device) = issue_credential("alice", 11, 222, NOW - 1000, NOW + 1000);

    assert_eq!(
        first.credential.identity_pk, second.credential.identity_pk,
        "one account, one identity key"
    );
    assert_ne!(first.credential.device_pk, second.credential.device_pk);

    validate_for_leaf(&first, first_device.public_key(), NOW).unwrap();
    validate_for_leaf(&second, second_device.public_key(), NOW).unwrap();
    // …and neither is valid in the other's leaf.
    assert_eq!(
        validate_for_leaf(&first, second_device.public_key(), NOW),
        Err(CredentialError::DeviceKeyMismatch)
    );
}

/// Different accounts must not produce the same identity key, or the binding
/// would bind everyone to one identity.
#[test]
fn different_account_seeds_give_different_identity_keys() {
    let (alice, _) = issue_credential("alice", 11, 111, NOW - 1000, NOW + 1000);
    let (bob, _) = issue_credential("bob", 22, 222, NOW - 1000, NOW + 1000);
    assert_ne!(alice.credential.identity_pk, bob.credential.identity_pk);
}
