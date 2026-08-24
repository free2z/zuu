//! Every way a bad assertion must fail, attacked one rule at a time.
//!
//! `KT.md` §4.4 says the thing this file exists for, about the layer beneath:
//!
//! > `akd` enforces none of it. The library will happily commit any bytes to
//! > any label. […] a log that skips them produces inclusion, history and
//! > append-only proofs that verify **perfectly** for entries nobody
//! > authorized.
//!
//! The same is true one level up. The tree can prove that `@alice`'s key was
//! published and never changed behind anyone's back, and prove it beautifully,
//! for a handle that was taken by someone who was not Alice. Nothing downstream
//! of this crate can detect that, which makes each rule below the last place it
//! can be caught.
//!
//! Assertion-path tests start from a submission that passes the experimental
//! assertion-layer check and break exactly one thing. Routine-path tests are
//! explicit that this crate does not verify §4.4's DirectoryAuthKey signature
//! or RotationProof and that their result is partial.

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
    AssertionLayerCheck, AssertionNonce, AuthorityConfig, AuthorityError, AuthorityId,
    AuthorityKey, AuthoritySet, EntryKind, Handle, HandleAssertion, HandleAssertionTBS, Intent,
    LogId, NonceLedger, NonceSeen, SigningKey, Submission, Vouch, VouchingStatus,
};
use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::types::{Digest, PublicKey, Signature};

const NOW_MS: u64 = 1_700_000_000_000;
const ISSUED_MS: u64 = NOW_MS - 1_000;
const EXPIRES_MS: u64 = NOW_MS + 60_000;

fn log_id() -> LogId {
    LogId::new([0x11; 32])
}

fn authority() -> SigningKey {
    SigningKey::from_seed(&[0x22; 32])
}

fn identity() -> SigningKey {
    SigningKey::from_seed(&[0x33; 32])
}

fn handle() -> Handle {
    Handle::parse(b"alice").unwrap()
}

fn entry_digest() -> Digest {
    Digest::new([0x44; 32])
}

fn config() -> AuthorityConfig {
    AuthorityConfig::with_defaults(
        log_id(),
        AuthoritySet::single(authority().public_key()).unwrap(),
    )
    .unwrap()
}

fn ledger() -> NonceLedger {
    NonceLedger::new(64, f2z_authority::DEFAULT_CLOCK_SKEW_MS)
}

/// A valid assertion body. Every test starts here and breaks one field.
fn body() -> HandleAssertionTBS {
    HandleAssertionTBS::new(
        &authority().public_key(),
        log_id(),
        handle(),
        identity().public_key(),
        Intent::Bind,
        7,
        ISSUED_MS,
        EXPIRES_MS,
        AssertionNonce::new([0x55; 16]),
    )
    .unwrap()
}

/// Sign a body, sign the matching binding, and hand back both.
fn present(body: HandleAssertionTBS) -> (Vec<u8>, Signature) {
    let assertion = body.sign(&authority()).unwrap();
    let binding = config()
        .binding(
            &handle(),
            &identity().public_key(),
            Some(&assertion),
            &entry_digest(),
        )
        .unwrap();
    let signature = binding.sign(&identity()).unwrap();
    (assertion.encode_canonical().unwrap(), signature)
}

fn submission<'a>(
    assertion: &'a [u8],
    identity_signature: &'a Signature,
    identity_pk: &'a PublicKey,
    handle: &'a Handle,
) -> Submission<'a> {
    Submission {
        assertion: Some(assertion),
        kind: EntryKind::InitialBind,
        handle,
        identity_pk,
        entry_version: 1,
        entry_digest: &ENTRY_DIGEST,
        identity_signature,
        previous_identity_pk: None,
        previous_vouch: None,
        previous_account_epoch: None,
    }
}

static ENTRY_DIGEST: Digest = Digest::new([0x44; 32]);

/// Run the default happy-path submission with one field of the assertion
/// changed by `mutate`.
fn check_assertion_with(
    mutate: impl FnOnce(&mut HandleAssertionTBS),
) -> Result<Vouch, AuthorityError> {
    let mut value = body();
    mutate(&mut value);
    let (bytes, signature) = present(value);
    let identity_pk = identity().public_key();
    let handle = handle();
    config()
        .check_assertion_layer(
            &submission(&bytes, &signature, &identity_pk, &handle),
            NOW_MS,
            &mut ledger(),
        )
        .map(|checked| checked.vouch())
}

fn checked_initial_vouch() -> Vouch {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    config()
        .check_assertion_layer(
            &submission(&bytes, &signature, &identity_pk, &handle),
            NOW_MS,
            &mut ledger(),
        )
        .unwrap()
        .vouch()
}

fn historical_vouch(marker: u8) -> Vouch {
    let vouch = Vouch::By(AuthorityId::new([marker; 32]));
    assert_ne!(
        vouch,
        Vouch::By(f2z_authority::authority_id(&authority().public_key())),
        "the predecessor fixture must not be the currently configured authority",
    );
    vouch
}

fn check_key_change(
    previous_vouch: Option<Vouch>,
    previous_account_epoch: Option<u32>,
) -> Result<AssertionLayerCheck, AuthorityError> {
    let incoming = SigningKey::from_seed(&[0x77; 32]);
    let incoming_pk = incoming.public_key();
    let outgoing_pk = identity().public_key();
    let handle = handle();
    let binding = config()
        .binding(&handle, &incoming_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let signature = binding.sign(&incoming).unwrap();
    config().check_assertion_layer(
        &Submission {
            assertion: None,
            kind: EntryKind::KeyChange,
            handle: &handle,
            identity_pk: &incoming_pk,
            entry_version: 5,
            entry_digest: &ENTRY_DIGEST,
            identity_signature: &signature,
            previous_identity_pk: Some(&outgoing_pk),
            previous_vouch,
            previous_account_epoch,
        },
        NOW_MS,
        &mut ledger(),
    )
}

// ----------------------------------------------------------------- the control

#[test]
fn a_correct_asserted_submission_passes_the_partial_check() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    let checked = config()
        .check_assertion_layer(
            &submission(&bytes, &signature, &identity_pk, &handle),
            NOW_MS,
            &mut ledger(),
        )
        .unwrap();

    assert_eq!(
        checked.vouch(),
        Vouch::By(f2z_authority::authority_id(&authority().public_key()))
    );
    assert!(checked.vouch().is_vouched());
    assert_eq!(checked.handle().as_str(), "alice");
    assert_eq!(checked.identity_pk(), &identity().public_key());
    assert_eq!(checked.kind(), EntryKind::InitialBind);
    assert_eq!(checked.intent(), Some(Intent::Bind));
    assert_eq!(checked.account_epoch(), 7);
    assert_eq!(
        config().status(),
        VouchingStatus::Vouched { authorities: 1 }
    );
}

#[test]
fn asserted_bind_and_reset_preserve_each_signed_epoch_and_kind() {
    for account_epoch in [3, 41] {
        let mut asserted = body();
        asserted.account_epoch = account_epoch;
        let (bytes, signature) = present(asserted);
        let identity_pk = identity().public_key();
        let handle = handle();
        let checked = config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap();

        assert_eq!(checked.kind(), EntryKind::InitialBind);
        assert_eq!(checked.account_epoch(), account_epoch);
    }

    for (previous_account_epoch, asserted_account_epoch) in [(5, 19), (53, 89)] {
        let mut asserted = body();
        asserted.intent = Intent::Reset;
        asserted.account_epoch = asserted_account_epoch;
        let (bytes, signature) = present(asserted);
        let identity_pk = identity().public_key();
        let handle = handle();
        let outgoing = PublicKey::new([0x66; 32]);
        let mut reset = submission(&bytes, &signature, &identity_pk, &handle);
        reset.kind = EntryKind::PlatformReset;
        reset.entry_version = 9;
        reset.previous_identity_pk = Some(&outgoing);
        reset.previous_vouch = Some(historical_vouch(0xf6));
        reset.previous_account_epoch = Some(previous_account_epoch);

        let checked = config()
            .check_assertion_layer(&reset, NOW_MS, &mut ledger())
            .unwrap();
        assert_eq!(checked.kind(), EntryKind::PlatformReset);
        assert_eq!(checked.account_epoch(), asserted_account_epoch);
    }
}

#[test]
fn initial_bind_refuses_a_predecessor_epoch_on_both_deployments() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    let mut asserted = submission(&bytes, &signature, &identity_pk, &handle);
    asserted.previous_account_epoch = Some(91);
    assert_eq!(
        config()
            .check_assertion_layer(&asserted, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::UnexpectedPriorAccountEpoch
    );

    let unvouched = AuthorityConfig::with_defaults(log_id(), AuthoritySet::none()).unwrap();
    let unvouched_signature = unvouched
        .binding(&handle, &identity_pk, None, &ENTRY_DIGEST)
        .unwrap()
        .sign(&identity())
        .unwrap();
    let bare = Submission {
        assertion: None,
        kind: EntryKind::InitialBind,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 1,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &unvouched_signature,
        previous_identity_pk: None,
        previous_vouch: None,
        previous_account_epoch: Some(37),
    };
    assert_eq!(
        unvouched
            .check_assertion_layer(&bare, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::UnexpectedPriorAccountEpoch
    );
}

#[test]
fn initial_bind_refuses_a_predecessor_vouch_on_both_deployments() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    let mut asserted = submission(&bytes, &signature, &identity_pk, &handle);
    asserted.previous_vouch = Some(historical_vouch(0x71));
    assert_eq!(
        config()
            .check_assertion_layer(&asserted, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::UnexpectedPriorVouch
    );

    let unvouched = AuthorityConfig::with_defaults(log_id(), AuthoritySet::none()).unwrap();
    let unvouched_signature = unvouched
        .binding(&handle, &identity_pk, None, &ENTRY_DIGEST)
        .unwrap()
        .sign(&identity())
        .unwrap();
    let bare = Submission {
        assertion: None,
        kind: EntryKind::InitialBind,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 1,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &unvouched_signature,
        previous_identity_pk: None,
        previous_vouch: Some(Vouch::Unvouched),
        previous_account_epoch: None,
    };
    assert_eq!(
        unvouched
            .check_assertion_layer(&bare, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::UnexpectedPriorVouch
    );
}

#[test]
fn same_key_check_needs_no_platform_assertion_and_preserves_prior_vouch() {
    let identity = identity();
    let identity_pk = identity.public_key();
    let handle = handle();
    let binding = config()
        .binding(&handle, &identity_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let signature = binding.sign(&identity).unwrap();
    let prior_vouch = historical_vouch(0xa1);
    let submission = Submission {
        assertion: None,
        kind: EntryKind::SameKey,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 5,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &signature,
        previous_identity_pk: Some(&identity_pk),
        previous_vouch: Some(prior_vouch),
        previous_account_epoch: Some(7),
    };

    let checked = config()
        .check_assertion_layer(&submission, NOW_MS, &mut ledger())
        .unwrap();
    assert_eq!(checked.kind(), EntryKind::SameKey);
    assert_eq!(checked.vouch(), prior_vouch);
    assert!(checked.vouch().is_vouched());
    assert_eq!(checked.account_epoch(), 7);

    let mut wrong_shape = submission;
    let different = PublicKey::new([0x99; 32]);
    wrong_shape.previous_identity_pk = Some(&different);
    assert_eq!(
        config()
            .check_assertion_layer(&wrong_shape, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::EntryKindMismatch
    );

    let mut missing_history = submission;
    missing_history.previous_vouch = None;
    assert_eq!(
        config()
            .check_assertion_layer(&missing_history, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::MissingPriorVouch
    );

    let mut missing_epoch = submission;
    missing_epoch.previous_account_epoch = None;
    assert_eq!(
        config()
            .check_assertion_layer(&missing_epoch, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::MissingPriorAccountEpoch
    );
}

#[test]
fn current_authority_configuration_cannot_upgrade_an_unvouched_history() {
    let identity = identity();
    let identity_pk = identity.public_key();
    let handle = handle();
    let unvouched = AuthorityConfig::with_defaults(log_id(), AuthoritySet::none()).unwrap();
    let initial_binding = unvouched
        .binding(&handle, &identity_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let initial_signature = initial_binding.sign(&identity).unwrap();
    let initial = Submission {
        assertion: None,
        kind: EntryKind::InitialBind,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 1,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &initial_signature,
        previous_identity_pk: None,
        previous_vouch: None,
        previous_account_epoch: None,
    };
    let prior = unvouched
        .check_assertion_layer(&initial, NOW_MS, &mut ledger())
        .unwrap()
        .vouch();
    assert_eq!(prior, Vouch::Unvouched);

    let routine_binding = config()
        .binding(&handle, &identity_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let routine_signature = routine_binding.sign(&identity).unwrap();
    let routine = Submission {
        assertion: None,
        kind: EntryKind::SameKey,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 2,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &routine_signature,
        previous_identity_pk: Some(&identity_pk),
        previous_vouch: Some(prior),
        previous_account_epoch: Some(0),
    };
    let checked = config()
        .check_assertion_layer(&routine, NOW_MS, &mut ledger())
        .unwrap();
    assert_eq!(checked.vouch(), Vouch::Unvouched);
    assert!(!checked.vouch().is_vouched());
    assert_eq!(checked.account_epoch(), 0);
}

#[test]
fn attacker_controlled_incoming_key_gets_only_a_partial_key_change_check() {
    let incoming = SigningKey::from_seed(&[0x77; 32]);
    let incoming_pk = incoming.public_key();
    let outgoing_pk = identity().public_key();
    let handle = handle();
    let binding = config()
        .binding(&handle, &incoming_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let signature = binding.sign(&incoming).unwrap();
    let prior_vouch = historical_vouch(0xb2);
    let submission = Submission {
        assertion: None,
        kind: EntryKind::KeyChange,
        handle: &handle,
        identity_pk: &incoming_pk,
        entry_version: 5,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &signature,
        previous_identity_pk: Some(&outgoing_pk),
        previous_vouch: Some(prior_vouch),
        previous_account_epoch: Some(31),
    };

    // Deliberately no outgoing-key RotationProof or DirectoryAuthKey signature
    // exists in this fixture. The incoming key can therefore obtain only the
    // explicitly partial assertion-layer type, never a publish authorization.
    let checked: AssertionLayerCheck = config()
        .check_assertion_layer(&submission, NOW_MS, &mut ledger())
        .unwrap();
    assert_eq!(checked.kind(), EntryKind::KeyChange);
    assert_eq!(checked.vouch(), prior_vouch);
    assert_eq!(checked.account_epoch(), 31);

    let mut wrong_shape = submission;
    wrong_shape.previous_identity_pk = Some(&incoming_pk);
    assert_eq!(
        config()
            .check_assertion_layer(&wrong_shape, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::IdentityUnchanged
    );
}

#[test]
fn key_change_preserves_distinct_predecessor_histories() {
    for (previous_account_epoch, previous_vouch) in
        [(11, historical_vouch(0xc3)), (47, historical_vouch(0xd4))]
    {
        let checked = check_key_change(Some(previous_vouch), Some(previous_account_epoch)).unwrap();
        assert_eq!(checked.kind(), EntryKind::KeyChange);
        assert_eq!(checked.vouch(), previous_vouch);
        assert_eq!(checked.account_epoch(), previous_account_epoch);
    }
}

#[test]
fn key_change_requires_explicit_previous_vouch() {
    assert_eq!(
        check_key_change(None, Some(11)).unwrap_err(),
        AuthorityError::MissingPriorVouch
    );
}

#[test]
fn key_change_requires_explicit_previous_account_epoch() {
    assert_eq!(
        check_key_change(Some(historical_vouch(0xe5)), None).unwrap_err(),
        AuthorityError::MissingPriorAccountEpoch
    );
}

#[test]
fn experimental_unvouched_initial_check_refuses_the_identity_point_forgery() {
    use ed25519_dalek::Verifier as _;

    let mut identity_point = [0u8; 32];
    identity_point[0] = 1;
    let identity_pk = PublicKey::new(identity_point);
    let mut signature_bytes = [0u8; 64];
    signature_bytes[..32].copy_from_slice(&identity_point);
    let forged = Signature::new(signature_bytes);

    // Positive control: these are not merely bad-looking bytes. Plain dalek
    // verification accepts this exact key/signature over the exact transcript
    // that reaches the assertion-layer boundary, so the refusal below depends
    // on strictness.
    let config = AuthorityConfig::with_defaults(log_id(), AuthoritySet::none()).unwrap();
    let handle = handle();
    let binding = config
        .binding(&handle, &identity_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let message = binding.signing_bytes().unwrap();
    let raw = ed25519_dalek::VerifyingKey::from_bytes(&identity_point).unwrap();
    let raw_signature = ed25519_dalek::Signature::from_bytes(forged.as_bytes());
    assert!(raw.verify(&message, &raw_signature).is_ok());

    let submission = Submission {
        assertion: None,
        kind: EntryKind::InitialBind,
        handle: &handle,
        identity_pk: &identity_pk,
        entry_version: 1,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &forged,
        previous_identity_pk: None,
        previous_vouch: None,
        previous_account_epoch: None,
    };
    assert_eq!(
        config
            .check_assertion_layer(&submission, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::BadIdentitySignature
    );
}

#[test]
fn routine_entry_checks_refuse_a_platform_assertion() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let previous = identity_pk;
    let handle = handle();
    for kind in [EntryKind::SameKey, EntryKind::KeyChange] {
        let mut value = submission(&bytes, &signature, &identity_pk, &handle);
        value.kind = kind;
        value.entry_version = 2;
        value.previous_identity_pk = Some(&previous);
        assert_eq!(
            config()
                .check_assertion_layer(&value, NOW_MS, &mut ledger())
                .unwrap_err(),
            AuthorityError::UnexpectedAssertion,
            "{kind:?} accepted a platform assertion"
        );
    }
}

#[test]
fn routine_entry_checks_still_require_the_identity_binding() {
    let current = identity().public_key();
    let prior = PublicKey::new([0x99; 32]);
    let handle = handle();
    for (kind, previous) in [
        (EntryKind::SameKey, &current),
        (EntryKind::KeyChange, &prior),
    ] {
        let submission = Submission {
            assertion: None,
            kind,
            handle: &handle,
            identity_pk: &current,
            entry_version: 5,
            entry_digest: &ENTRY_DIGEST,
            identity_signature: &Signature::new([0u8; 64]),
            previous_identity_pk: Some(previous),
            previous_vouch: Some(Vouch::Unvouched),
            previous_account_epoch: Some(7),
        };
        assert_eq!(
            config()
                .check_assertion_layer(&submission, NOW_MS, &mut ledger())
                .unwrap_err(),
            AuthorityError::BadIdentitySignature,
            "{kind:?} bypassed the identity binding"
        );
    }
}

#[test]
fn platform_reset_requires_its_platform_assertion() {
    let incoming = SigningKey::from_seed(&[0x77; 32]);
    let incoming_pk = incoming.public_key();
    let outgoing_pk = identity().public_key();
    let handle = handle();
    let binding = config()
        .binding(&handle, &incoming_pk, None, &ENTRY_DIGEST)
        .unwrap();
    let signature = binding.sign(&incoming).unwrap();
    let submission = Submission {
        assertion: None,
        kind: EntryKind::PlatformReset,
        handle: &handle,
        identity_pk: &incoming_pk,
        entry_version: 5,
        entry_digest: &ENTRY_DIGEST,
        identity_signature: &signature,
        previous_identity_pk: Some(&outgoing_pk),
        previous_vouch: Some(Vouch::Unvouched),
        previous_account_epoch: Some(7),
    };
    assert_eq!(
        config()
            .check_assertion_layer(&submission, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::MissingAssertion
    );
}

// ---------------------------------------------------- the six named negatives

#[test]
fn an_expired_assertion_is_rejected() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    // One millisecond past `expires_ms`. The boundary is exclusive: at exactly
    // `expires_ms` the assertion is already gone.
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                EXPIRES_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::Expired
    );
    assert!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                EXPIRES_MS - 1,
                &mut ledger(),
            )
            .is_ok()
    );
}

#[test]
fn an_assertion_for_another_log_is_rejected() {
    assert_eq!(
        check_assertion_with(|body| body.log_id = LogId::new([0x99; 32])).unwrap_err(),
        AuthorityError::WrongLog
    );
}

#[test]
fn a_replayed_nonce_is_rejected() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    let mut ledger = ledger();
    let submission = submission(&bytes, &signature, &identity_pk, &handle);

    assert!(
        config()
            .check_assertion_layer(&submission, NOW_MS, &mut ledger)
            .is_ok()
    );
    assert_eq!(
        config()
            .check_assertion_layer(&submission, NOW_MS, &mut ledger)
            .unwrap_err(),
        AuthorityError::ReplayedNonce
    );
}

#[test]
fn an_over_long_validity_is_rejected_by_the_log_not_the_issuer() {
    // The issuer signs whatever it likes; the cap is the log's.
    let over = f2z_authority::DEFAULT_MAX_VALIDITY_MS + 1;
    assert_eq!(
        check_assertion_with(|body| body.expires_ms = body.issued_ms + over).unwrap_err(),
        AuthorityError::ValidityTooLong
    );
    // Exactly at the cap is fine — the bound is inclusive.
    assert!(
        check_assertion_with(|body| {
            body.issued_ms = NOW_MS;
            body.expires_ms = NOW_MS + f2z_authority::DEFAULT_MAX_VALIDITY_MS;
        })
        .is_ok()
    );

    // And a log that publishes a tighter cap gets the tighter cap, over the
    // same bytes an unmodified log accepts.
    let strict = AuthorityConfig::new(
        log_id(),
        AuthoritySet::single(authority().public_key()).unwrap(),
        30_000,
        f2z_authority::DEFAULT_CLOCK_SKEW_MS,
    )
    .unwrap();
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    assert_eq!(
        strict
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::ValidityTooLong
    );
}

#[test]
fn an_assertion_without_a_matching_identity_self_signature_is_rejected() {
    // **The test the whole design exists for.** A thief holds a perfectly good
    // assertion — real authority, real signature, in date, right log, right
    // handle — and cannot produce the one signature that needs the key the
    // assertion is about.
    let assertion = body().sign(&authority()).unwrap();
    let stolen = assertion.encode_canonical().unwrap();
    let identity_pk = identity().public_key();
    let handle = handle();

    // 1. No signature to offer: 64 zero bytes is the best a thief can do.
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&stolen, &Signature::new([0u8; 64]), &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::BadIdentitySignature
    );

    // 2. Signed with the thief's own key instead. The binding names the
    //    assertion's identity_pk, and that is the key it is verified under.
    let thief = SigningKey::from_seed(&[0x66; 32]);
    let binding = config()
        .binding(&handle, &identity_pk, Some(&assertion), &entry_digest())
        .unwrap();
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(
                    &stolen,
                    &binding.sign(&thief).unwrap(),
                    &identity_pk,
                    &handle
                ),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::BadIdentitySignature
    );

    // 3. A real binding, signed by the real identity key, but for a *different*
    //    submission. Replaying the subject's own signature onto other entry
    //    bytes fails too, which is why the binding commits to entry_digest.
    let other = config()
        .binding(
            &handle,
            &identity_pk,
            Some(&assertion),
            &Digest::new([0xee; 32]),
        )
        .unwrap();
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(
                    &stolen,
                    &other.sign(&identity()).unwrap(),
                    &identity_pk,
                    &handle
                ),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::BadIdentitySignature
    );

    // 4. A binding signed for a different log. Cross-log replay of the
    //    submitter's own signature.
    let elsewhere = AuthorityConfig::with_defaults(
        LogId::new([0x77; 32]),
        AuthoritySet::single(authority().public_key()).unwrap(),
    )
    .unwrap();
    let foreign = elsewhere
        .binding(&handle, &identity_pk, Some(&assertion), &entry_digest())
        .unwrap();
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(
                    &stolen,
                    &foreign.sign(&identity()).unwrap(),
                    &identity_pk,
                    &handle
                ),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::BadIdentitySignature
    );
}

#[test]
fn a_non_conforming_handle_never_becomes_a_handle() {
    // The charset is a type invariant, so the attack has to be made at the
    // encoding layer: bytes shaped like an assertion whose handle field is not
    // one. It does not decode, so no verification rule ever sees it.
    let (bytes, _) = present(body());
    let position = bytes
        .windows(5)
        .position(|window| window == b"alice")
        .expect("the fixture handle is in the encoding");

    for replacement in [b'A', b'.', b'-', 0x80] {
        let mut tampered = bytes.clone();
        tampered[position] = replacement;
        assert!(
            decode_canonical::<HandleAssertion>(&tampered).is_err(),
            "a handle containing {replacement:#04x} decoded"
        );
    }

    // And the parser refuses every shape §14.1 excludes, at the front door.
    for candidate in [
        &b""[..],
        b"Alice",
        b"alice.smith",
        b"alice-smith",
        b"alice@free2z",
        "\u{430}lice".as_bytes(),
        &[b'a'; 31],
    ] {
        assert_eq!(
            Handle::parse(candidate).unwrap_err(),
            AuthorityError::HandleCharset
        );
    }
}

// ------------------------------------------------- the rest of the rule table

#[test]
fn an_assertion_from_an_unconfigured_authority_is_rejected() {
    let stranger = SigningKey::from_seed(&[0xaa; 32]);
    let body = HandleAssertionTBS::new(
        &stranger.public_key(),
        log_id(),
        handle(),
        identity().public_key(),
        Intent::Bind,
        7,
        ISSUED_MS,
        EXPIRES_MS,
        AssertionNonce::new([0x55; 16]),
    )
    .unwrap();
    let assertion = body.sign(&stranger).unwrap();
    let bytes = assertion.encode_canonical().unwrap();
    let identity_pk = identity().public_key();
    let handle = handle();
    let binding = config()
        .binding(&handle, &identity_pk, Some(&assertion), &entry_digest())
        .unwrap();
    let signature = binding.sign(&identity()).unwrap();

    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::UnknownAuthority
    );

    // …and adding that key to the set is the whole of what it takes to accept
    // it. Rotation is set membership.
    let widened = AuthorityConfig::with_defaults(
        log_id(),
        AuthoritySet::new(vec![
            AuthorityKey::new(authority().public_key()),
            AuthorityKey::new(stranger.public_key()),
        ])
        .unwrap(),
    )
    .unwrap();
    assert!(
        widened
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .is_ok()
    );
}

#[test]
fn an_assertion_the_authority_did_not_sign_is_rejected() {
    let assertion = body().sign(&SigningKey::from_seed(&[0xbb; 32])).unwrap();
    // Re-label it as the configured authority's. Only the signature is wrong.
    let mut forged = assertion.clone();
    forged.assertion.authority_id = f2z_authority::authority_id(&authority().public_key());
    let bytes = forged.encode_canonical().unwrap();
    let identity_pk = identity().public_key();
    let handle = handle();
    let signature = config()
        .binding(&handle, &identity_pk, Some(&forged), &entry_digest())
        .unwrap()
        .sign(&identity())
        .unwrap();

    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::BadAuthoritySignature
    );
}

#[test]
fn an_assertion_that_disagrees_with_itself_or_its_submission_is_rejected() {
    assert_eq!(
        check_assertion_with(
            |body| body.handle_id = handle().handle_id().as_bytes().map(|b| !b).into()
        )
        .unwrap_err(),
        AuthorityError::HandleIdMismatch
    );
    assert_eq!(
        check_assertion_with(|body| {
            body.handle = Handle::parse(b"bob").unwrap();
            body.handle_id = body.handle.handle_id();
        })
        .unwrap_err(),
        AuthorityError::HandleMismatch
    );
    assert_eq!(
        check_assertion_with(|body| body.identity_pk = PublicKey::new([0xcc; 32])).unwrap_err(),
        AuthorityError::IdentityMismatch
    );
    assert_eq!(
        check_assertion_with(|body| {
            body.label = f2z_codec::types::ShortBytes::new(b"free2z/kt/v1/entry").unwrap();
        })
        .unwrap_err(),
        AuthorityError::WrongLabel
    );
}

#[test]
fn a_backwards_or_empty_validity_window_is_rejected() {
    assert_eq!(
        check_assertion_with(|body| body.expires_ms = body.issued_ms).unwrap_err(),
        AuthorityError::EmptyValidity
    );
    assert_eq!(
        check_assertion_with(|body| body.expires_ms = body.issued_ms - 1).unwrap_err(),
        AuthorityError::EmptyValidity
    );
}

#[test]
fn an_assertion_issued_too_far_in_the_future_is_rejected() {
    let skew = f2z_authority::DEFAULT_CLOCK_SKEW_MS;
    assert_eq!(
        check_assertion_with(|body| {
            body.issued_ms = NOW_MS + skew + 1;
            body.expires_ms = body.issued_ms + 60_000;
        })
        .unwrap_err(),
        AuthorityError::NotYetIssued
    );
    // Exactly at the skew is accepted: the allowance is inclusive.
    assert!(
        check_assertion_with(|body| {
            body.issued_ms = NOW_MS + skew;
            body.expires_ms = body.issued_ms + 60_000;
        })
        .is_ok()
    );
}

#[test]
fn intent_is_tied_to_the_position_in_the_entry_sequence() {
    let identity_pk = identity().public_key();
    let handle = handle();
    let previous = PublicKey::new([0xdd; 32]);

    // A bind assertion on anything but a first entry.
    let (bytes, signature) = present(body());
    let mut later = submission(&bytes, &signature, &identity_pk, &handle);
    later.kind = EntryKind::PlatformReset;
    later.entry_version = 2;
    later.previous_identity_pk = Some(&previous);
    later.previous_vouch = Some(checked_initial_vouch());
    later.previous_account_epoch = Some(7);
    assert_eq!(
        config()
            .check_assertion_layer(&later, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::IntentMismatch
    );

    // A reset assertion on a first entry.
    let mut reset_body = body();
    reset_body.intent = Intent::Reset;
    let (reset_bytes, reset_signature) = present(reset_body);
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&reset_bytes, &reset_signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::IntentMismatch
    );

    // entry_version 0 is not a position at all.
    let mut zeroth = submission(&bytes, &signature, &identity_pk, &handle);
    zeroth.entry_version = 0;
    assert_eq!(
        config()
            .check_assertion_layer(&zeroth, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::EntryKindMismatch
    );

    // A reset that the log has no predecessor for.
    let mut orphan = submission(&reset_bytes, &reset_signature, &identity_pk, &handle);
    orphan.kind = EntryKind::PlatformReset;
    orphan.entry_version = 2;
    orphan.previous_vouch = Some(checked_initial_vouch());
    orphan.previous_account_epoch = Some(7);
    assert_eq!(
        config()
            .check_assertion_layer(&orphan, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::EntryKindMismatch
    );

    // A bind whose handle the log already has an entry for.
    let mut squatted = submission(&bytes, &signature, &identity_pk, &handle);
    squatted.previous_identity_pk = Some(&previous);
    assert_eq!(
        config()
            .check_assertion_layer(&squatted, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::EntryKindMismatch
    );
}

#[test]
fn a_reset_that_keeps_the_key_it_replaces_is_rejected() {
    // The stricter reading of KT.md §4.4 — see AuthorityError::IdentityUnchanged.
    let mut reset_body = body();
    reset_body.intent = Intent::Reset;
    reset_body.account_epoch = 8;
    let (bytes, signature) = present(reset_body);
    let identity_pk = identity().public_key();
    let handle = handle();

    let mut no_op = submission(&bytes, &signature, &identity_pk, &handle);
    no_op.kind = EntryKind::PlatformReset;
    no_op.entry_version = 2;
    no_op.previous_identity_pk = Some(&identity_pk);
    no_op.previous_vouch = Some(checked_initial_vouch());
    no_op.previous_account_epoch = Some(7);
    assert_eq!(
        config()
            .check_assertion_layer(&no_op, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::IdentityUnchanged
    );

    // The same assertion against a predecessor it really does replace is fine.
    let outgoing = PublicKey::new([0xdd; 32]);
    let mut real = no_op;
    real.previous_identity_pk = Some(&outgoing);
    let checked = config()
        .check_assertion_layer(&real, NOW_MS, &mut ledger())
        .unwrap();
    assert_eq!(checked.account_epoch(), 8);
}

#[test]
fn an_account_epoch_that_does_not_advance_is_rejected() {
    let mut reset_body = body();
    reset_body.intent = Intent::Reset;
    let (bytes, signature) = present(reset_body);
    let identity_pk = identity().public_key();
    let handle = handle();
    let outgoing = PublicKey::new([0xdd; 32]);

    let mut base = submission(&bytes, &signature, &identity_pk, &handle);
    base.kind = EntryKind::PlatformReset;
    base.entry_version = 2;
    base.previous_identity_pk = Some(&outgoing);
    base.previous_vouch = Some(checked_initial_vouch());

    assert_eq!(
        config()
            .check_assertion_layer(&base, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::MissingPriorAccountEpoch
    );

    let mut advancing = base;
    advancing.previous_account_epoch = Some(6);
    assert!(
        config()
            .check_assertion_layer(&advancing, NOW_MS, &mut ledger())
            .is_ok()
    );

    // The fixture asserts account_epoch 7. Anything already at or past it is a
    // spent assertion being presented again.
    for previous in [7u32, 8, u32::MAX] {
        let mut replayed = base;
        replayed.previous_account_epoch = Some(previous);
        assert_eq!(
            config()
                .check_assertion_layer(&replayed, NOW_MS, &mut ledger())
                .unwrap_err(),
            AuthorityError::AccountEpochRegression,
            "previous epoch {previous} was accepted"
        );
    }
}

#[test]
fn non_canonical_assertion_bytes_are_rejected() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();

    let mut trailing = bytes.clone();
    trailing.push(0);
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&trailing, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::Malformed
    );

    let truncated = &bytes[..bytes.len() - 1];
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(truncated, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::Malformed
    );
}

#[test]
fn a_failed_submission_never_burns_the_nonce() {
    // If a rejection consumed the nonce, anyone who could make a submission
    // fail could stop the real one — a denial of service on handle
    // registration, delivered by replaying somebody else's assertion badly.
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    let mut ledger = ledger();

    // Fails at the identity binding, which runs before the ledger is touched.
    assert!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &Signature::new([0u8; 64]), &identity_pk, &handle),
                NOW_MS,
                &mut ledger,
            )
            .is_err()
    );
    assert!(ledger.is_empty());

    // The genuine submission still works.
    assert!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger,
            )
            .is_ok()
    );
    assert_eq!(ledger.len(), 1);
}

#[test]
fn a_reused_nonce_across_two_different_assertions_is_still_a_replay() {
    // Keying the ledger on (authority_id, nonce) rather than on the assertion
    // digest is what catches this: two distinct claims that the issuer stamped
    // with one nonce.
    let identity_pk = identity().public_key();
    let handle = handle();
    let mut ledger = ledger();

    let (first, first_signature) = present(body());
    assert!(
        config()
            .check_assertion_layer(
                &submission(&first, &first_signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger,
            )
            .is_ok()
    );

    let mut second_body = body();
    second_body.account_epoch = 9;
    let (second, second_signature) = present(second_body);
    assert_ne!(first, second);
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&second, &second_signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger,
            )
            .unwrap_err(),
        AuthorityError::ReplayedNonce
    );
}

#[test]
fn a_full_ledger_refuses_rather_than_forgetting() {
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    let mut ledger = NonceLedger::new(0, f2z_authority::DEFAULT_CLOCK_SKEW_MS);
    assert_eq!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger,
            )
            .unwrap_err(),
        AuthorityError::LedgerFull
    );
}

// ---------------------------------------------------- the no-authority deployment

#[test]
fn experimental_unvouched_mode_is_reported_and_still_demands_a_self_signature() {
    let config = AuthorityConfig::with_defaults(log_id(), AuthoritySet::none()).unwrap();
    assert_eq!(config.status(), VouchingStatus::Unvouched);
    assert!(
        config.status().to_string().contains("UNVOUCHED"),
        "the status a client renders must say so in words"
    );

    let handle = handle();
    let identity_pk = identity().public_key();
    let signature = config
        .binding(&handle, &identity_pk, None, &entry_digest())
        .unwrap()
        .sign(&identity())
        .unwrap();

    let checked = config
        .check_assertion_layer(
            &Submission {
                assertion: None,
                kind: EntryKind::InitialBind,
                handle: &handle,
                identity_pk: &identity_pk,
                entry_version: 1,
                entry_digest: &ENTRY_DIGEST,
                identity_signature: &signature,
                previous_identity_pk: None,
                previous_vouch: None,
                previous_account_epoch: None,
            },
            NOW_MS,
            &mut ledger(),
        )
        .unwrap();

    assert_eq!(checked.vouch(), Vouch::Unvouched);
    assert!(!checked.vouch().is_vouched());
    assert_eq!(checked.vouch().authority(), None);
    assert_eq!(checked.vouch().to_string(), "UNVOUCHED");
    assert_eq!(checked.account_epoch(), 0);
}

#[test]
fn the_two_deployments_do_not_leak_into_each_other() {
    let vouched = config();
    let unvouched = AuthorityConfig::with_defaults(log_id(), AuthoritySet::none()).unwrap();
    let handle = handle();
    let identity_pk = identity().public_key();
    let (bytes, signature) = present(body());

    // An assertion offered to a log that cannot judge it.
    assert_eq!(
        unvouched
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::UnexpectedAssertion
    );

    // A submission with nothing to show, to a log that requires one.
    let mut bare = submission(&bytes, &signature, &identity_pk, &handle);
    bare.assertion = None;
    assert_eq!(
        vouched
            .check_assertion_layer(&bare, NOW_MS, &mut ledger())
            .unwrap_err(),
        AuthorityError::MissingAssertion
    );

    // And an unvouched binding — the one with an all-zero assertion digest —
    // does not authorize a submission on the vouched log.
    let zeroed = vouched
        .binding(&handle, &identity_pk, None, &entry_digest())
        .unwrap()
        .sign(&identity())
        .unwrap();
    assert_eq!(
        vouched
            .check_assertion_layer(
                &submission(&bytes, &zeroed, &identity_pk, &handle),
                NOW_MS,
                &mut ledger(),
            )
            .unwrap_err(),
        AuthorityError::BadIdentitySignature
    );
}

// ------------------------------------------------------------- the error codes

#[test]
fn every_refusal_carries_a_kt_error_code_that_does_not_blame_the_wrong_party() {
    use f2z_authority::error::{
        ERR_BAD_AUTHORIZATION, ERR_BAD_SIGNATURE, ERR_INTERNAL, ERR_MALFORMED,
        ERR_UNSUPPORTED_VERSION,
    };

    assert_eq!(AuthorityError::Malformed.kt_error_code(), ERR_MALFORMED);
    assert_eq!(
        AuthorityError::WrongLog.kt_error_code(),
        ERR_UNSUPPORTED_VERSION
    );
    assert_eq!(
        AuthorityError::BadIdentitySignature.kt_error_code(),
        ERR_BAD_SIGNATURE
    );
    assert_eq!(
        AuthorityError::Expired.kt_error_code(),
        ERR_BAD_AUTHORIZATION
    );
    assert_eq!(
        AuthorityError::EmptyAuthoritySet.kt_error_code(),
        ERR_INTERNAL
    );
    assert!(!AuthorityError::Expired.is_configuration_fault());
}

#[test]
fn the_ledger_trait_is_what_a_durable_log_implements() {
    // A log keeps the ledger in its database; nothing here assumes otherwise.
    // The property under test is that the assertion-layer check writes through the trait and
    // through nothing else.
    struct Counting {
        inner: NonceLedger,
        writes: usize,
    }
    impl NonceSeen for Counting {
        fn observe(
            &mut self,
            now_ms: u64,
            authority_id: f2z_authority::AuthorityId,
            nonce: AssertionNonce,
            expires_ms: u64,
        ) -> Result<(), AuthorityError> {
            self.writes += 1;
            self.inner.observe(now_ms, authority_id, nonce, expires_ms)
        }
    }

    let mut counting = Counting {
        inner: ledger(),
        writes: 0,
    };
    let (bytes, signature) = present(body());
    let identity_pk = identity().public_key();
    let handle = handle();
    assert!(
        config()
            .check_assertion_layer(
                &submission(&bytes, &signature, &identity_pk, &handle),
                NOW_MS,
                &mut counting,
            )
            .is_ok()
    );
    assert_eq!(counting.writes, 1);
}
