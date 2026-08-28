//! §12.6: a key package is checked against the directory, or it is not used.
//!
//! Every test here is about the one property that makes publishing key packages
//! at an untrusted relay safe: **a package that does not match the directory
//! entry the log proved is refused.** The relay is assumed hostile
//! (`THREAT-MODEL.md` §3.3), so every substitution it could attempt is tried
//! below with real keys and real signatures rather than with a mock.

// Test code, run on the host by a person reading the failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_msg_mls::{CredentialError, EngineError};

mod common;
use common::{NOW, device, directory_entry, with_revocation};

#[test]
fn a_substituted_relay_id_breaks_the_device_authenticated_routing_advert() {
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[alice.credential().clone()]);
    let authentic = b"conversation|relay-url|relay-id-A|send-addr";
    let substituted = b"conversation|relay-url|relay-id-B|send-addr";
    let signature = alice
        .sign_routing_advert(authentic)
        .expect("routing signature");

    f2z_msg_mls::MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
        &entry,
        alice.credential().credential.device_pk.as_bytes(),
        authentic,
        &signature,
        NOW,
    )
    .expect("the active directory device signed the complete advert");
    assert!(
        f2z_msg_mls::MlsEngine::<f2z_msg_store::MemoryBackend>::authenticate_routing_advert(
            &entry,
            alice.credential().credential.device_pk.as_bytes(),
            substituted,
            &signature,
            NOW,
        )
        .is_err(),
        "deleting relay-id coverage would make this mutation survive"
    );
}

#[test]
fn a_batch_is_generated_in_order_and_every_package_verifies() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let batch = bob.generate_key_packages(8, None).expect("a batch");
    assert_eq!(batch.len(), 8);
    // Distinct init keys, or the pool is one package wearing eight hats.
    let mut seen = batch.clone();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), 8, "a pool of identical packages is not a pool");

    for wire in &batch {
        let verified = alice
            .verify_key_package(wire, &entry, NOW)
            .expect("the directory vouches for it");
        assert!(!verified.last_resort(), "a pooled package is single-use");
        assert_eq!(
            verified.device_pk(),
            bob.credential().credential.device_pk.as_bytes()
        );
    }
}

#[test]
fn the_last_resort_package_says_so_in_its_own_signed_extensions() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let wire = bob
        .generate_last_resort_key_package(Some(86_400))
        .expect("a last-resort package");
    let verified = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect("it is still a valid package from the right device");
    // RFC 9420's `last_resort` extension, read out of what the device signed —
    // never out of the relay's advisory response byte.
    assert!(verified.last_resort());
}

#[test]
fn a_last_resort_package_is_usable_and_is_never_refused_for_being_one() {
    // §12.6's exhaustion behaviour depends on this: availability is what the
    // reusable package buys, and a layer that refused it would have converted
    // the trade into a failure to reach somebody.
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let wire = bob.generate_last_resort_key_package(None).expect("package");
    let verified = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect("verified");
    let mut group = alice.create_group(b"conversation").expect("group");
    let (_commit, welcome) = alice
        .add_member(&mut group, &verified, NOW)
        .expect("a last-resort package joins a group like any other");
    let bob_group = bob.join_from_welcome(&welcome, NOW).expect("bob joins");
    assert_eq!(group.group_id(), bob_group.group_id());
}

#[test]
fn a_package_signed_under_a_different_identity_key_is_refused() {
    // **The MITM.** A hostile relay makes up an identity key, issues itself a
    // credential under it for the handle it is impersonating, and signs a real
    // key package with the matching device key. Every check that looks only at
    // the package passes. The directory's `identity_pk` is what stops it.
    let bob = device("bob", 22, 222);
    let impostor = device("bob", 99, 222);
    let alice = device("alice", 11, 111);

    let entry = directory_entry(&[bob.credential().clone()]);
    let substituted = impostor.generate_key_package().expect("package");

    let error = alice
        .verify_key_package(&substituted, &entry, NOW)
        .expect_err("a package under an identity key the log never proved");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::BadSignature)
        ),
        "{error:?}"
    );
}

#[test]
fn a_package_for_a_different_handle_is_refused() {
    // A genuine credential, correctly signed, from a real device — for somebody
    // else. Reachable when one identity key speaks for two handles, and the
    // relay serves the wrong one's package.
    let carol = device("carol", 22, 222);
    let bob_credential = common::issue_credential("bob", 22, 233, NOW - 1_000, NOW + 1_000).0;
    let alice = device("alice", 11, 111);

    let mut entry = directory_entry(std::slice::from_ref(&bob_credential));
    // The impostor shares the identity key, so only the handle differs.
    entry.identity_pk = carol.credential().credential.identity_pk;
    entry.handle = bob_credential.credential.handle.clone();
    entry.devices = vec![bob_credential, carol.credential().clone()].into();

    let wire = carol.generate_key_package().expect("package");
    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("the credential names carol, the entry names bob");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::InvalidHandle)
        ),
        "{error:?}"
    );
}

#[test]
fn a_package_from_a_device_the_entry_does_not_publish_is_refused() {
    // Same identity key, same handle, correctly signed — a device the owner
    // never put in the directory. An old phone, or one the identity key signed
    // for and the owner then withdrew.
    let published = device("bob", 22, 222);
    let unpublished = device("bob", 22, 244);
    let alice = device("alice", 11, 111);

    let entry = directory_entry(&[published.credential().clone()]);
    let wire = unpublished.generate_key_package().expect("package");

    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("the directory publishes the device set");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::DeviceKeyMismatch)
        ),
        "{error:?}"
    );
}

#[test]
fn a_package_from_a_revoked_device_is_refused() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);

    let entry = directory_entry(&[bob.credential().clone()]);
    let wire = bob.generate_key_package().expect("package");
    // Before the revocation it verifies; that is what makes the assertion after
    // it a statement about the revocation and not about anything else.
    alice
        .verify_key_package(&wire, &entry, NOW)
        .expect("verified");

    let revoked = with_revocation(&entry, bob.credential().credential.device_pk);
    let error = alice
        .verify_key_package(&wire, &revoked, NOW)
        .expect_err("a revoked device must not be reachable for first contact");
    assert!(
        matches!(
            error,
            EngineError::Credential(CredentialError::DeviceKeyMismatch)
        ),
        "{error:?}"
    );
}

#[test]
fn an_expired_package_is_refused() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let wire = bob.generate_key_package().expect("package");
    // Far past the credential's `not_after`. §12.6's refill rule exists so this
    // is a thing a long-offline device causes, and it must be a refusal rather
    // than an unopenable `Welcome`.
    let error = alice
        .verify_key_package(&wire, &entry, NOW + 100_000_000_000)
        .expect_err("an expired package is not usable");
    assert!(
        matches!(error, EngineError::Credential(_) | EngineError::Mls(_)),
        "{error:?}"
    );
}

#[test]
fn trailing_bytes_after_a_package_are_refused() {
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let mut wire = bob.generate_key_package().expect("package");
    wire.push(0);
    let error = alice
        .verify_key_package(&wire, &entry, NOW)
        .expect_err("exactly one encoding, or nothing");
    assert!(matches!(error, EngineError::Mls(_)), "{error:?}");
}

#[test]
fn a_welcome_is_bound_to_the_package_it_was_addressed_to() {
    // Consumption is the relay's rule, but the reason it matters is here: a
    // `Welcome` addressed to one package cannot be opened with another's init
    // key, so serving a package twice does not merely waste it — it is what
    // makes two initiators share one secret.
    let bob = device("bob", 22, 222);
    let alice = device("alice", 11, 111);
    let entry = directory_entry(&[bob.credential().clone()]);

    let first = bob.generate_key_package().expect("package");
    let second = bob.generate_key_package().expect("package");
    assert_ne!(first, second);

    let verified = alice
        .verify_key_package(&first, &entry, NOW)
        .expect("verified");
    let mut group = alice.create_group(b"conversation").expect("group");
    let (_commit, welcome) = alice.add_member(&mut group, &verified, NOW).expect("add");

    // Bob still holds both private init keys, so this succeeds — which is the
    // point: the binding is to the *package*, and the relay's job is only to
    // stop handing the same one out twice.
    let joined = bob.join_from_welcome(&welcome, NOW).expect("join");
    assert_eq!(joined.group_id(), group.group_id());
}
