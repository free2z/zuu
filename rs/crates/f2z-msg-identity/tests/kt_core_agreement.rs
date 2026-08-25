//! **The acceptance test for #311's client half.**
//!
//! A `DeviceCredential` issued by this crate, inside a `DirectoryEntry`
//! authorized by this crate's `DirectoryAuthKey`, put through
//! `f2z_kt_core::validate_submission` — the same function the key-transparency
//! log server runs before it hands anything to `akd`.
//!
//! # Why this is the test that matters
//!
//! `ARCHITECTURE.md` §4.2 defines a `DeviceCredential`; `KT.md` §4.1 fixes its
//! bytes; `f2z-kt-core` §4.4 rule 8 decides whether one is acceptable. Three
//! documents and two crates, and the only thing standing between them is
//! whether the construction side and the validation side agree byte for byte.
//! A unit test in this crate can only prove that this crate agrees with itself.
//!
//! §4.4 rule 8 is the specific rule under test:
//!
//! > Every `DeviceCredential` signature verifies under **this entry's**
//! > `identity_pk` — under the entry's key, not under the key the credential
//! > carries, or a credential could authenticate itself. The two are then
//! > required to be equal, because an MLS peer validating the credential in a
//! > `LeafNode` has no directory access and will use the embedded key.
//!
//! That is exactly why [`IdentitySigningKey::issue_device_credential`] takes
//! `identity_pk` from the signing key rather than from its request argument:
//! there is no way to build a credential here that fails rule 8 there.
//!
//! [`IdentitySigningKey::issue_device_credential`]: f2z_msg_identity::IdentitySigningKey::issue_device_credential

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::canonical::Canonical as _;
use f2z_codec::types::{Digest, PublicKey, ShortBytes};
use f2z_codec::vec::VecU16;
use f2z_kt_core::entry::{
    DeviceCredential, DirectoryEntry, DirectoryEntryTBS, EntryAuthorization, EntryKind,
};
use f2z_kt_core::labels::LABEL_ENTRY;
use f2z_kt_core::submit::{LogPolicy, PublishedEntry, SubmissionContext, validate_submission};
use f2z_kt_core::types::{Handle, KemPublicKey, LogId};
use f2z_kt_core::{KT_VERSION, KtError};
use f2z_msg_identity::account::AccountKeys;
use f2z_msg_identity::credential::DeviceCredentialRequest;
use f2z_msg_identity::device::DeviceSignatureKey;

/// BIP-39's published seed for the all-`abandon` mnemonic — the same fixture
/// `tests/derivation_vectors.rs` pins, so a failure here and a failure there
/// are about the same identity.
const SEED: [u8; 64] = [
    0x5e, 0xb0, 0x0b, 0xbd, 0xdc, 0xf0, 0x69, 0x08, 0x48, 0x89, 0xa8, 0xab, 0x91, 0x55, 0x56, 0x81,
    0x65, 0xf5, 0xc4, 0x53, 0xcc, 0xb8, 0x5e, 0x70, 0x81, 0x1a, 0xae, 0xd6, 0xf6, 0xda, 0x5f, 0xc1,
    0x9a, 0x5a, 0xc4, 0x0b, 0x38, 0x9c, 0xd3, 0x70, 0xd0, 0x86, 0x20, 0x6d, 0xec, 0x8a, 0xa6, 0xc4,
    0x3d, 0xae, 0xa6, 0x69, 0x0f, 0x20, 0xad, 0x3d, 0x8d, 0x48, 0xb2, 0xd2, 0xce, 0x9e, 0x38, 0xe4,
];

const NOW_MS: u64 = 1_767_225_600_000;

/// A counter, not a CSPRNG. `CryptoRng` is a promise a test may make and
/// production code may not; see `device.rs`'s module note.
struct CountingRng(u64);

impl rand_core::TryRng for CountingRng {
    type Error = core::convert::Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Ok(self.try_next_u64()? as u32)
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        Ok(self.0)
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        for byte in dst.iter_mut() {
            *byte = self.try_next_u64()? as u8;
        }
        Ok(())
    }
}

impl rand_core::TryCryptoRng for CountingRng {}

fn policy() -> LogPolicy {
    // The log's identity is not what is under test, so the values are fixtures.
    // `log_id` has to match the entry's, and it does because both read this.
    LogPolicy::new(LogId::new([0x11; 32]), PublicKey::new([0x22; 32]), 604_800)
}

/// Issue a credential for one device of the `alice` account.
fn credential(keys: &AccountKeys, device: &DeviceSignatureKey) -> DeviceCredential {
    keys.identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(b"alice".to_vec()).unwrap(),
            device_pk: device.public(),
            // X-Wing's public key width. The bytes are filler because this
            // crate does not generate them (see `device.rs`); the length is
            // real, so the `<1..2^16-1>` prefix is the one a live credential
            // carries.
            device_kem_pk: KemPublicKey::new(vec![0xab; 1216]).unwrap(),
            not_before_ms: NOW_MS - 1_000,
            not_after_ms: NOW_MS + 31_536_000_000,
        })
        .unwrap()
}

/// Build and authorize a `same_key` entry carrying `devices`.
fn entry(
    keys: &AccountKeys,
    devices: Vec<DeviceCredential>,
    entry_version: u32,
    prev_entry_hash: Digest,
) -> DirectoryEntry {
    let tbs = DirectoryEntryTBS {
        label: ShortBytes::new(LABEL_ENTRY.to_vec()).unwrap(),
        kt_version: KT_VERSION,
        log_id: LogId::new([0x11; 32]),
        handle: Handle::new(b"alice".to_vec()).unwrap(),
        entry_version,
        kind: EntryKind::SameKey,
        identity_pk: keys.identity.public(),
        directory_auth_pk: keys.directory_auth.public(),
        devices: VecU16::new(devices),
        revocations: VecU16::new(Vec::new()),
        contact_endpoints: VecU16::new(Vec::new()),
        prev_entry_hash,
        no_reset: 0,
        created_at_ms: NOW_MS,
    };
    // §4.4: `auth_signature` is Ed25519 over `tls_codec(DirectoryEntryTBS)` by
    // the `DirectoryAuthKey` — never by the ISK. `DirectoryAuthKey` is the only
    // key in this crate that can produce it, which is the separation `KT.md`
    // §4.4 narrows §4.2's overlapping table into.
    let auth_signature = keys.directory_auth.sign_directory_entry(&tbs).unwrap();
    DirectoryEntry {
        entry: tbs,
        authorization: EntryAuthorization::SameKey { auth_signature },
    }
}

/// **The acceptance test.** A credential this crate issued, accepted by the
/// log's own validator.
#[test]
fn a_credential_issued_here_is_accepted_by_the_kt_validator() {
    let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
    let device = DeviceSignatureKey::generate(&mut CountingRng(1));
    let entry = entry(&keys, vec![credential(&keys, &device)], 1, Digest::zero());

    let bytes = entry.encode_canonical().unwrap();
    let policy = policy();
    let accepted = validate_submission(
        &bytes,
        &SubmissionContext {
            policy: &policy,
            previous: None,
            pending_in_epoch: false,
            now_ms: NOW_MS,
        },
    );

    assert!(
        accepted.is_ok(),
        "f2z-kt-core rejected a credential this crate issued: {:?}",
        accepted.err()
    );
}

/// Rule 8's second half, from the other direction: the entry's `identity_pk`
/// and the credential's must be equal, and this crate cannot produce a pair
/// where they are not.
///
/// The test mutates the entry to break the equality on purpose, and asserts the
/// validator says so. Without this, the test above would pass for an
/// implementation that never checked rule 8 at all.
#[test]
fn a_credential_signed_by_a_different_identity_is_rejected() {
    let alice = AccountKeys::from_seed(&SEED, 0).unwrap();
    let mallory = AccountKeys::from_seed(&SEED, 1).unwrap();
    let device = DeviceSignatureKey::generate(&mut CountingRng(2));

    // Mallory's identity issues the credential; Alice's entry carries it.
    let entry = entry(
        &alice,
        vec![credential(&mallory, &device)],
        1,
        Digest::zero(),
    );

    let bytes = entry.encode_canonical().unwrap();
    let policy = policy();
    assert_eq!(
        validate_submission(
            &bytes,
            &SubmissionContext {
                policy: &policy,
                previous: None,
                pending_in_epoch: false,
                now_ms: NOW_MS,
            }
        )
        .err(),
        Some(KtError::BadAuthorization),
        "§4.4 rule 8 did not fire; the acceptance test above proves nothing"
    );
}

/// The multi-device shape `ADR 0002` requires from day one: one identity, two
/// devices, both credentials in one entry, all accepted.
#[test]
fn two_devices_of_one_account_are_accepted_together() {
    let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
    let mut rng = CountingRng(3);
    let first = DeviceSignatureKey::generate(&mut rng);
    let second = DeviceSignatureKey::generate(&mut rng);
    assert_ne!(first.public(), second.public());

    let entry = entry(
        &keys,
        vec![credential(&keys, &first), credential(&keys, &second)],
        1,
        Digest::zero(),
    );
    let bytes = entry.encode_canonical().unwrap();
    let policy = policy();
    assert!(
        validate_submission(
            &bytes,
            &SubmissionContext {
                policy: &policy,
                previous: None,
                pending_in_epoch: false,
                now_ms: NOW_MS,
            }
        )
        .is_ok()
    );
}

/// A second entry, chained to the first — the `same_key`, `entry_version >= 2`
/// row of §4.4's table, where the signature is checked against the
/// `directory_auth_pk` published in the **previous** entry.
///
/// This is what proves the `DirectoryAuthKey` is stable across a routine
/// update: it is seed-derived, so the key in entry 2 is the key entry 1
/// published, and adding a device never touches the identity key a peer pins.
#[test]
fn a_chained_second_entry_is_authorized_by_the_same_seed_derived_key() {
    let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
    let mut rng = CountingRng(4);
    let first_device = DeviceSignatureKey::generate(&mut rng);
    let second_device = DeviceSignatureKey::generate(&mut rng);

    let first = entry(
        &keys,
        vec![credential(&keys, &first_device)],
        1,
        Digest::zero(),
    );
    let first_bytes = first.encode_canonical().unwrap();
    let published = PublishedEntry::from_entry(&first).unwrap();

    let second = entry(
        &keys,
        vec![
            credential(&keys, &first_device),
            credential(&keys, &second_device),
        ],
        2,
        f2z_kt_core::submit::chain_hash_of(&first_bytes),
    );
    let bytes = second.encode_canonical().unwrap();
    let policy = policy();
    let accepted = validate_submission(
        &bytes,
        &SubmissionContext {
            policy: &policy,
            previous: Some(&published),
            pending_in_epoch: false,
            now_ms: NOW_MS,
        },
    );
    assert!(
        accepted.is_ok(),
        "adding a device to a published handle was rejected: {:?}",
        accepted.err()
    );
}

/// The `RotationProof` half of the ISK's job (`KT.md` §4.4, `key_change`).
///
/// Not a full rotation — building one needs a second identity and §4.4's whole
/// rule 6 — but the proof this crate signs must at least verify under the
/// outgoing identity key that `f2z-kt-core` will check it against.
#[test]
fn a_rotation_proof_signed_here_verifies_under_the_outgoing_identity_key() {
    use f2z_kt_core::entry::RotationProofTBS;
    use f2z_kt_core::labels::LABEL_ROTATION;

    let outgoing = AccountKeys::from_seed(&SEED, 0).unwrap();
    let incoming = AccountKeys::from_seed(&SEED, 1).unwrap();

    let tbs = RotationProofTBS {
        label: ShortBytes::new(LABEL_ROTATION.to_vec()).unwrap(),
        log_id: LogId::new([0x11; 32]),
        handle: Handle::new(b"alice".to_vec()).unwrap(),
        entry_version: 2,
        old_identity_pk: outgoing.identity.public(),
        new_identity_pk: incoming.identity.public(),
        prev_entry_hash: Digest::new([0x33; 32]),
        created_at_ms: NOW_MS,
    };
    let proof = outgoing.identity.sign_rotation_proof(&tbs).unwrap();

    assert_eq!(proof.proof, tbs);
    assert_eq!(
        f2z_kt_core::sig::verify(
            &outgoing.identity.public(),
            &proof.proof.signing_bytes().unwrap(),
            &proof.signature,
        ),
        Ok(()),
        "the ISK's rotation signature is not what §4.4 checks"
    );
    assert_eq!(
        f2z_kt_core::sig::verify(
            &incoming.identity.public(),
            &proof.proof.signing_bytes().unwrap(),
            &proof.signature,
        ),
        Err(KtError::BadSignature),
        "the incoming key must not be able to authorize its own installation"
    );
}
