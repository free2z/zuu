//! Fixtures for this crate's unit tests.
//!
//! `#[cfg(test)]`, so none of it is compiled into anything a wallet links. The
//! integration suite has its own copy in `tests/common/mod.rs` — Cargo builds
//! each integration test as a separate crate, which cannot see a private
//! `#[cfg(test)]` module, and exporting this one behind a feature would put
//! fixture constructors on the public API of a crate whose public API is a
//! security boundary.

use alloc::vec;
use alloc::vec::Vec;

use f2z_codec::canonical::Canonical;
use f2z_codec::types::{Body, ShortBytes};

use crate::wire::{
    ExecutePaymentRequestV1, Intent, IntentRequestV1, IssueDeviceCredentialRequestV1, RequestId,
    SignChallengeRequestV1,
};

/// A fixed wall-clock instant the fixtures are dated against.
pub const ISSUED_AT_MS: u64 = 1_700_000_000_000;

/// A `sign-challenge` payload.
pub fn sample_sign_challenge() -> (Intent, Vec<u8>) {
    let body = SignChallengeRequestV1 {
        challenge: Body::new(vec![0x5a; 32]).unwrap(),
    };
    (Intent::SignChallenge, body.encode_canonical().unwrap())
}

/// An `issue-device-credential` payload.
pub fn sample_issue_device_credential() -> (Intent, Vec<u8>) {
    let body = IssueDeviceCredentialRequestV1 {
        handle: ShortBytes::new(b"skylar".to_vec()).unwrap(),
        device_pk: f2z_codec::types::PublicKey::new([0x11; 32]),
        device_kem_pk: Body::new(vec![0x22; 64]).unwrap(),
        not_before_ms: ISSUED_AT_MS,
        not_after_ms: ISSUED_AT_MS + 86_400_000,
    };
    (
        Intent::IssueDeviceCredential,
        body.encode_canonical().unwrap(),
    )
}

/// An `execute-payment` payload.
pub fn sample_execute_payment() -> (Intent, Vec<u8>) {
    let body = ExecutePaymentRequestV1 {
        recipient: ShortBytes::new(b"u1exampleexampleexample".to_vec()).unwrap(),
        amount_zatoshis: 100_000,
        memo: ShortBytes::new(b"thanks for the article".to_vec()).unwrap(),
        fee_zatoshis: 10_000,
    };
    (Intent::ExecutePayment, body.encode_canonical().unwrap())
}

/// Wrap a family payload in a valid version-1 request.
pub fn sample_request((intent, payload): (Intent, Vec<u8>)) -> IntentRequestV1 {
    IntentRequestV1 {
        intent: intent.code(),
        request_id: RequestId::new([0x77; 32]),
        caller: ShortBytes::new(b"cash.free2z.free2z".to_vec()).unwrap(),
        purpose: ShortBytes::new(b"Sign in to free2z".to_vec()).unwrap(),
        issued_at_ms: ISSUED_AT_MS,
        expires_at_ms: ISSUED_AT_MS + 60_000,
        payload: Body::new(payload).unwrap(),
    }
}
