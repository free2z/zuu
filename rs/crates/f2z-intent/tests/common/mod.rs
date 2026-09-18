//! Fixtures shared by this crate's integration tests.
//!
//! Cargo builds each file directly under `tests/` as its own crate, so a
//! `#[cfg(test)]` module inside `src/` is invisible here. `tests/common/mod.rs`
//! is the standard answer: it is not a top-level file, so it is not itself a
//! test target, and both suites declare it with `mod common;`.

// Every suite uses a different subset, and each integration test is its own
// crate, so what one does not call is dead code there.
#![allow(dead_code)]
// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in a parser reachable from untrusted input is a
// denial of service; neither hazard exists in a fixture builder.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use f2z_codec::canonical::Canonical;
use f2z_codec::types::{Body, PublicKey, QueueAddress, RelayId, ShortBytes};
use f2z_intent::{
    CallerRegistry, ExecutePaymentRequestV1, Intent, IntentClock, IntentGate, IntentRequestV1,
    IssueDeviceCredentialRequestV1, IssueDeviceCredentialRequestV2, RegisteredCaller, RequestId,
    SignChallengeRequestV1, SigningCertDigest, VisibleText,
};

/// The wall-clock instant every fixture is dated against.
pub const ISSUED_AT_MS: u64 = 1_700_000_000_000;

/// The monotonic reading paired with it. Deliberately unrelated to the wall
/// clock: a monotonic counter has no epoch, and a test that assumed one would
/// be testing an assumption the platform does not make.
pub const MONOTONIC_MS: u64 = 42_000;

/// The registered caller every fixture claims to be.
pub const CALLER: &str = "cash.free2z.free2z";

/// The signing certificate the registry knows for it.
pub const CALLER_CERT: [u8; 32] = [0xAB; 32];

/// A clock reading at issuance.
#[must_use]
pub fn now() -> IntentClock {
    IntentClock::new(MONOTONIC_MS, ISSUED_AT_MS)
}

/// Bridge text, or a panic naming the fixture that is wrong.
#[must_use]
pub fn text(value: &str) -> VisibleText {
    VisibleText::new(value.as_bytes()).unwrap()
}

/// A registry holding exactly [`CALLER`].
#[must_use]
pub fn registry() -> CallerRegistry {
    let mut registry = CallerRegistry::new();
    registry
        .register(RegisteredCaller {
            identifier: text(CALLER),
            display_name: text("free2z"),
            signing_certs: vec![SigningCertDigest::new(CALLER_CERT)],
        })
        .unwrap();
    registry
}

/// A gate over [`registry`].
#[must_use]
pub fn gate() -> IntentGate {
    IntentGate::new(registry())
}

/// The canonical `sign-challenge` family payload.
#[must_use]
pub fn sign_challenge_payload() -> Vec<u8> {
    SignChallengeRequestV1 {
        challenge: Body::new(vec![0x5a; 32]).unwrap(),
    }
    .encode_canonical()
    .unwrap()
}

/// The canonical `issue-device-credential` family payload.
#[must_use]
pub fn issue_device_credential_payload() -> Vec<u8> {
    IssueDeviceCredentialRequestV1 {
        handle: ShortBytes::new(b"skylar".to_vec()).unwrap(),
        device_pk: PublicKey::new([0x11; 32]),
        device_kem_pk: Body::new(vec![0x22; 64]).unwrap(),
        not_before_ms: ISSUED_AT_MS,
        not_after_ms: ISSUED_AT_MS + 86_400_000,
    }
    .encode_canonical()
    .unwrap()
}

/// The canonical `issue-device-credential-v2` family payload.
#[must_use]
pub fn issue_device_credential_v2_payload() -> Vec<u8> {
    credential_vector_v2().encode_canonical().unwrap()
}

/// `tests/wire_vectors.rs`'s version-1 credential body.
#[must_use]
pub fn credential_vector_v1() -> IssueDeviceCredentialRequestV1 {
    IssueDeviceCredentialRequestV1 {
        handle: ShortBytes::new(b"alice".to_vec()).unwrap(),
        device_pk: PublicKey::new([0x11; 32]),
        device_kem_pk: Body::new(vec![0x22; 4]).unwrap(),
        not_before_ms: ISSUED_AT_MS,
        not_after_ms: ISSUED_AT_MS + 86_400_000,
    }
}

/// `tests/wire_vectors.rs`'s version-2 credential body: version 1's, plus an
/// endpoint.
#[must_use]
pub fn credential_vector_v2() -> IssueDeviceCredentialRequestV2 {
    let v1 = credential_vector_v1();
    IssueDeviceCredentialRequestV2 {
        handle: v1.handle,
        device_pk: v1.device_pk,
        device_kem_pk: v1.device_kem_pk,
        not_before_ms: v1.not_before_ms,
        not_after_ms: v1.not_after_ms,
        contact_relay_url: ShortBytes::new(b"wss://relay.example".to_vec()).unwrap(),
        contact_relay_id: RelayId::new([0x33; 32]),
        contact_addr: QueueAddress::new([0x44; 32]),
    }
}

/// The request both credential vectors wrap their payload in: e2e2z's own
/// caller and purpose.
#[must_use]
pub fn credential_vector_request(intent: Intent, payload: Vec<u8>) -> IntentRequestV1 {
    IntentRequestV1 {
        intent: intent.code(),
        request_id: RequestId::new([0x77; 32]),
        caller: ShortBytes::new(b"cash.free2z.e2e2z".to_vec()).unwrap(),
        purpose: ShortBytes::new(b"Issue this device a messaging credential".to_vec()).unwrap(),
        issued_at_ms: ISSUED_AT_MS,
        expires_at_ms: ISSUED_AT_MS + 60_000,
        payload: Body::new(payload).unwrap(),
    }
}

/// The canonical `execute-payment` family payload.
#[must_use]
pub fn execute_payment_payload() -> Vec<u8> {
    ExecutePaymentRequestV1 {
        recipient: ShortBytes::new(b"u1exampleexampleexample".to_vec()).unwrap(),
        amount_zatoshis: 100_000,
        memo: ShortBytes::new(b"thanks for the article".to_vec()).unwrap(),
        fee_zatoshis: 10_000,
    }
    .encode_canonical()
    .unwrap()
}

/// A valid version-1 request, with an explicit identifier so a test can build
/// two that differ only there.
#[must_use]
pub fn request_with_id(intent: Intent, payload: Vec<u8>, request_id: [u8; 32]) -> IntentRequestV1 {
    IntentRequestV1 {
        intent: intent.code(),
        request_id: RequestId::new(request_id),
        caller: ShortBytes::new(CALLER.as_bytes().to_vec()).unwrap(),
        purpose: ShortBytes::new(b"Sign in to free2z".to_vec()).unwrap(),
        issued_at_ms: ISSUED_AT_MS,
        expires_at_ms: ISSUED_AT_MS + 60_000,
        payload: Body::new(payload).unwrap(),
    }
}

/// The canonical fixture request: `sign-challenge`, identifier `0x77…`.
///
/// The exact bytes `tests/wire_vectors.rs` pins and the TypeScript client's
/// conformance suite reproduces.
#[must_use]
pub fn canonical_request() -> IntentRequestV1 {
    request_with_id(Intent::SignChallenge, sign_challenge_payload(), [0x77; 32])
}
