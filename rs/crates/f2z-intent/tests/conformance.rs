//! The conformance suite of `#905`: every guard, proven to be load-bearing.
//!
//! # The rule this file was written under
//!
//! Every case below was **mutation-verified**: the guard it names was deleted
//! or inverted in `src/`, this suite was run and watched to fail with a named
//! assertion, and the guard was restored. A test that passes both with and
//! without the code it claims to test is the `#589`/`#603` inert-fixture
//! defect, and this repository has already been bitten by it twice. The
//! mutations and the failures they produced are recorded in
//! `docs/intent-bridge/CONFORMANCE.md`.
//!
//! # The cases
//!
//! | `#905` requirement | Test |
//! |---|---|
//! | replayed intent refused | [`a_replayed_intent_is_refused`] |
//! | expired intent refused | [`an_expired_intent_is_refused`] |
//! | field-tampered intent refused | [`a_tampered_field_breaks_the_confirmation_binding`] |
//! | unknown version refused | [`an_unknown_version_is_refused_before_the_body_is_read`] |
//! | malformed input refused | [`malformed_input_is_refused_at_every_shape`] |
//! | wrong-caller intent refused | [`a_wrong_caller_intent_is_refused`] |
//! | forged response detected | [`a_response_to_a_question_nobody_asked_is_refused`] |

// Test code, run on the host by a person reading the failure.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use f2z_codec::canonical::Canonical;
use f2z_codec::types::{Body, Digest, ShortBytes};
use f2z_intent::{
    CONFIRMATION_TTL_MS, CallerAttestation, ConfirmationAuthorization, ConfirmationToken, Intent,
    IntentClock, IntentError, IntentGate, IntentLedger, IntentRequest, IntentRequestEnvelope,
    IntentRequestV1, IntentResponseV1, IntentSession, MAX_CHALLENGE_BYTES, PROTOCOL_VERSION,
    RequestId, SignChallengeRequestV1, SigningCertDigest, encode_request, encode_response,
};

mod common;

use common::{
    CALLER, CALLER_CERT, ISSUED_AT_MS, canonical_request, execute_payment_payload, gate,
    issue_device_credential_payload, now, registry, request_with_id, sign_challenge_payload,
};

/// The wallet's own re-derivation of what it rendered. Opaque to this crate.
fn review_digest() -> Digest {
    Digest::new([0x02; 32])
}

fn token() -> ConfirmationToken {
    ConfirmationToken::new([0x03; 32])
}

/// The attestation an Android build supplies for the fixture caller.
fn attested() -> CallerAttestation<'static> {
    CallerAttestation::Platform {
        package: CALLER.as_bytes(),
        signing_cert: SigningCertDigest::new(CALLER_CERT),
    }
}

// ---------------------------------------------------------------------------
// The control. Without this passing, every refusal below could be vacuous.
// ---------------------------------------------------------------------------

#[test]
fn the_whole_happy_path_works_end_to_end() {
    let mut gate = gate();
    let bytes = encode_request(&canonical_request()).unwrap();

    let admitted = gate.admit(&bytes, attested(), now()).unwrap();
    assert_eq!(admitted.request().intent(), Intent::SignChallenge);
    assert!(admitted.caller().trust().is_attested());
    assert_eq!(
        admitted.caller().display_name().as_str(),
        "free2z",
        "the confirmation names the caller from OUR registry"
    );

    let authorization = ConfirmationAuthorization::issue(
        &admitted.request_digest(),
        &review_digest(),
        &token(),
        now(),
        CONFIRMATION_TTL_MS,
    )
    .unwrap();

    assert_eq!(
        authorization.consume(
            &admitted.request_digest(),
            &review_digest(),
            &token(),
            now().advanced(5_000),
        ),
        Ok(())
    );
}

#[test]
fn every_family_is_admitted_by_the_same_gate() {
    for (intent, payload) in [
        (Intent::SignChallenge, sign_challenge_payload()),
        (
            Intent::IssueDeviceCredential,
            issue_device_credential_payload(),
        ),
        (Intent::ExecutePayment, execute_payment_payload()),
    ] {
        let mut gate = gate();
        let request = request_with_id(intent, payload, [intent.code() as u8; 32]);
        let bytes = encode_request(&request).unwrap();
        let admitted = gate.admit(&bytes, attested(), now()).unwrap();
        assert_eq!(admitted.request().intent(), intent);
    }
}

// ---------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------

#[test]
fn a_replayed_intent_is_refused() {
    let mut gate = gate();
    let bytes = encode_request(&canonical_request()).unwrap();

    assert!(gate.admit(&bytes, attested(), now()).is_ok());
    assert_eq!(
        gate.admit(&bytes, attested(), now()).unwrap_err(),
        IntentError::Replay,
        "the identical link, presented twice, must produce authority once"
    );
    // Still refused later inside the window, which is the whole attack: an
    // observer of a link replays it a minute afterwards.
    assert_eq!(
        gate.admit(&bytes, attested(), now().advanced(30_000))
            .unwrap_err(),
        IntentError::Replay
    );
}

#[test]
fn a_full_ledger_refuses_rather_than_forgetting_what_it_must_refuse() {
    // The eviction hazard, end to end: an attacker who can flood the gate must
    // not be able to make room by pushing the record they want to replay out.
    let mut gate = IntentGate::with_parts(registry(), IntentLedger::with_capacity(2), 0);
    let target = encode_request(&request_with_id(
        Intent::SignChallenge,
        sign_challenge_payload(),
        [0x01; 32],
    ))
    .unwrap();
    assert!(gate.admit(&target, attested(), now()).is_ok());

    for filler in 2u8..8 {
        let bytes = encode_request(&request_with_id(
            Intent::SignChallenge,
            sign_challenge_payload(),
            [filler; 32],
        ))
        .unwrap();
        let _ = gate.admit(&bytes, attested(), now());
    }
    assert_eq!(
        gate.admit(&target, attested(), now()).unwrap_err(),
        IntentError::Replay,
        "flooding must not evict the record that refuses the replay"
    );
}

// ---------------------------------------------------------------------------
// Expiry, on both clocks.
// ---------------------------------------------------------------------------

#[test]
fn an_expired_intent_is_refused() {
    let mut gate = gate();
    let request = canonical_request();
    let bytes = encode_request(&request).unwrap();

    let expired = IntentClock::new(0, request.expires_at_ms);
    assert_eq!(
        gate.admit(&bytes, attested(), expired).unwrap_err(),
        IntentError::Expired,
        "the expiry instant itself is outside the window"
    );
    // One millisecond earlier, the same bytes are fine — so the refusal above
    // is about the clock and not about the fixture.
    let inside = IntentClock::new(0, request.expires_at_ms - 1);
    assert!(gate.admit(&bytes, attested(), inside).is_ok());
}

#[test]
fn an_intent_dated_far_in_the_future_is_refused() {
    let mut gate = gate();
    let bytes = encode_request(&canonical_request()).unwrap();
    let long_before = IntentClock::new(0, ISSUED_AT_MS - 600_000);
    assert_eq!(
        gate.admit(&bytes, attested(), long_before).unwrap_err(),
        IntentError::NotYetValid
    );
}

#[test]
fn a_confirmation_cannot_be_extended_by_suspend_or_by_the_clock() {
    let admitted_digest = {
        let mut gate = gate();
        let bytes = encode_request(&canonical_request()).unwrap();
        gate.admit(&bytes, attested(), now())
            .unwrap()
            .request_digest()
    };
    let issue = || {
        ConfirmationAuthorization::issue(
            &admitted_digest,
            &review_digest(),
            &token(),
            now(),
            CONFIRMATION_TTL_MS,
        )
        .unwrap()
    };

    // Both clocks advanced past the deadline.
    assert_eq!(
        issue()
            .consume(
                &admitted_digest,
                &review_digest(),
                &token(),
                now().advanced(CONFIRMATION_TTL_MS)
            )
            .unwrap_err(),
        IntentError::Expired
    );
    // Suspend: the monotonic counter stalls while the wall clock runs on. Only
    // the WALL deadline catches this; a monotonic-only deadline would still be
    // inside its window, and a two-minute approval would span a night.
    let suspended = IntentClock::new(now().monotonic_ms, now().wall_ms + CONFIRMATION_TTL_MS);
    assert_eq!(
        issue()
            .consume(&admitted_digest, &review_digest(), &token(), suspended)
            .unwrap_err(),
        IntentError::Expired
    );
    // The wall clock held just after issuance while real time passes — an app
    // or a user with the settings screen can simply do this. Only the
    // MONOTONIC deadline catches it: the wall reading is inside the window and
    // is not a rollback, so both of the other two checks pass.
    let held_back = IntentClock::new(now().monotonic_ms + CONFIRMATION_TTL_MS, now().wall_ms + 1);
    assert_eq!(
        issue()
            .consume(&admitted_digest, &review_digest(), &token(), held_back)
            .unwrap_err(),
        IntentError::Expired
    );
    // Rollback past issuance: caught by neither deadline, only by comparing
    // against the instant the approval was recorded.
    let rolled_back = IntentClock::new(now().monotonic_ms + 1, now().wall_ms - 1);
    assert_eq!(
        issue()
            .consume(&admitted_digest, &review_digest(), &token(), rolled_back)
            .unwrap_err(),
        IntentError::NotYetValid
    );
}

// ---------------------------------------------------------------------------
// Field tampering.
// ---------------------------------------------------------------------------

#[test]
fn a_tampered_field_breaks_the_confirmation_binding() {
    // The attack: the user approves a 100 000-zatoshi payment, and the request
    // that reaches execution says 100 000 000. The confirmation binds the
    // request digest, so the substituted request cannot spend the approval.
    let approved = request_with_id(
        Intent::ExecutePayment,
        execute_payment_payload(),
        [0x0a; 32],
    );
    let approved_bytes = encode_request(&approved).unwrap();
    let approved_digest = IntentRequest::parse(&approved_bytes).unwrap().digest();

    let authorization = ConfirmationAuthorization::issue(
        &approved_digest,
        &review_digest(),
        &token(),
        now(),
        CONFIRMATION_TTL_MS,
    )
    .unwrap();

    let tampered_bytes = encode_request(&IntentRequestV1 {
        payload: Body::new(
            f2z_intent::ExecutePaymentRequestV1 {
                recipient: ShortBytes::new(b"u1exampleexampleexample".to_vec()).unwrap(),
                amount_zatoshis: 100_000_000,
                memo: ShortBytes::new(b"thanks for the article".to_vec()).unwrap(),
                fee_zatoshis: 10_000,
            }
            .encode_canonical()
            .unwrap(),
        )
        .unwrap(),
        ..approved
    })
    .unwrap();
    let tampered_digest = IntentRequest::parse(&tampered_bytes).unwrap().digest();

    assert_ne!(approved_digest, tampered_digest);
    assert_eq!(
        authorization
            .consume(&tampered_digest, &review_digest(), &token(), now())
            .unwrap_err(),
        IntentError::NotConfirmed,
        "an approval must not travel to a different request"
    );
}

#[test]
fn every_request_field_is_inside_the_digest() {
    // A weaker digest — over the family payload only, say — would still pass
    // the test above. This one walks each field and requires the digest to
    // move, so a narrowed binding fails here rather than silently.
    let base = canonical_request();
    let base_digest = IntentRequest::parse(&encode_request(&base).unwrap())
        .unwrap()
        .digest();

    let variants = [
        (
            "request_id",
            IntentRequestV1 {
                request_id: RequestId::new([0x78; 32]),
                ..base.clone()
            },
        ),
        (
            "caller",
            IntentRequestV1 {
                caller: ShortBytes::new(b"cash.free2z.e2e2z".to_vec()).unwrap(),
                ..base.clone()
            },
        ),
        (
            "purpose",
            IntentRequestV1 {
                purpose: ShortBytes::new(b"Sign in to free2Z".to_vec()).unwrap(),
                ..base.clone()
            },
        ),
        (
            "issued_at_ms",
            IntentRequestV1 {
                issued_at_ms: base.issued_at_ms - 1,
                ..base.clone()
            },
        ),
        (
            "expires_at_ms",
            IntentRequestV1 {
                expires_at_ms: base.expires_at_ms - 1,
                ..base.clone()
            },
        ),
        (
            "payload",
            IntentRequestV1 {
                payload: Body::new(
                    SignChallengeRequestV1 {
                        challenge: Body::new(vec![0x5b; 32]).unwrap(),
                    }
                    .encode_canonical()
                    .unwrap(),
                )
                .unwrap(),
                ..base.clone()
            },
        ),
    ];

    for (field, variant) in variants {
        let digest = IntentRequest::parse(&encode_request(&variant).unwrap())
            .unwrap()
            .digest();
        assert_ne!(
            base_digest, digest,
            "changing {field} must change the confirmation binding"
        );
    }
}

#[test]
fn a_layout_control_cannot_reach_the_confirmation() {
    // U+202E RIGHT-TO-LEFT OVERRIDE inside a purpose string: the classic way
    // to make a rendered line say something other than what it contains.
    let mut request = canonical_request();
    request.purpose = ShortBytes::new("Sign in\u{202e} to free2z".as_bytes().to_vec()).unwrap();
    let bytes = encode_request(&request).unwrap();
    assert_eq!(
        IntentRequest::parse(&bytes).unwrap_err(),
        IntentError::InvalidValue
    );
}

#[test]
fn an_oversized_challenge_is_refused_so_signing_is_not_an_oracle() {
    let payload = SignChallengeRequestV1 {
        challenge: Body::new(vec![0u8; MAX_CHALLENGE_BYTES + 1]).unwrap(),
    }
    .encode_canonical()
    .unwrap();
    let bytes =
        encode_request(&request_with_id(Intent::SignChallenge, payload, [0x0b; 32])).unwrap();
    assert_eq!(
        IntentRequest::parse(&bytes).unwrap_err(),
        IntentError::InvalidValue
    );
}

// ---------------------------------------------------------------------------
// Versioning.
// ---------------------------------------------------------------------------

#[test]
fn an_unknown_version_is_refused_before_the_body_is_read() {
    // The body is a perfectly valid version-1 request. Only the version
    // differs, so anything but a refusal here is a best guess.
    let body = canonical_request().encode_canonical().unwrap();
    for version in [0u16, 2, 7, u16::MAX] {
        let envelope = IntentRequestEnvelope {
            version,
            body: Body::new(body.clone()).unwrap(),
        };
        let bytes = envelope.encode_canonical().unwrap();
        assert_eq!(
            IntentRequest::parse(&bytes).unwrap_err(),
            IntentError::UnsupportedVersion,
            "version {version} must be refused, not interpreted as version {PROTOCOL_VERSION}"
        );
    }
}

#[test]
fn a_future_version_body_is_never_parsed_as_version_one() {
    // A hypothetical version-2 request that appended a field. Under a flat
    // structure this would decode as version 1 plus trailing bytes; under the
    // opaque-body envelope the version gate fires first and the extra field is
    // never even reached.
    let mut body = canonical_request().encode_canonical().unwrap();
    body.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
    let bytes = IntentRequestEnvelope {
        version: 2,
        body: Body::new(body).unwrap(),
    }
    .encode_canonical()
    .unwrap();
    assert_eq!(
        IntentRequest::parse(&bytes).unwrap_err(),
        IntentError::UnsupportedVersion
    );
}

#[test]
fn an_unknown_intent_family_is_refused_rather_than_reinterpreted() {
    let mut request = canonical_request();
    for code in [0u16, 4, 9, u16::MAX] {
        request.intent = code;
        let bytes = encode_request(&request).unwrap();
        assert_eq!(
            IntentRequest::parse(&bytes).unwrap_err(),
            IntentError::UnknownIntent,
            "family {code} carries authority this build cannot render"
        );
    }
}

// ---------------------------------------------------------------------------
// Malformed input.
// ---------------------------------------------------------------------------

#[test]
fn malformed_input_is_refused_at_every_shape() {
    let good = encode_request(&canonical_request()).unwrap();

    // Empty.
    assert_eq!(
        IntentRequest::parse(&[]).unwrap_err(),
        IntentError::Malformed
    );
    // Truncated at every length. Not one arbitrary cut: a decoder that reads
    // past its input usually does so at exactly one boundary.
    for cut in 0..good.len() {
        assert_eq!(
            IntentRequest::parse(&good[..cut]).unwrap_err(),
            IntentError::Malformed,
            "a {cut}-byte prefix is not a request"
        );
    }
    // Trailing data — the `WIRE.md` §3.3 case, named by hand there.
    let mut trailing = good.clone();
    trailing.push(0);
    assert_eq!(
        IntentRequest::parse(&trailing).unwrap_err(),
        IntentError::Malformed
    );
    // A declared length that exceeds the bytes present.
    let mut overlong = good.clone();
    overlong[2] = 0xff;
    assert_eq!(
        IntentRequest::parse(&overlong).unwrap_err(),
        IntentError::Malformed
    );
    // Every single-byte corruption either decodes to a different valid request
    // or is refused; none of them may panic. This is the property that keeps a
    // parser reachable from untrusted input out of the denial-of-service
    // business.
    for index in 0..good.len() {
        let mut corrupted = good.clone();
        corrupted[index] ^= 0xff;
        let _ = IntentRequest::parse(&corrupted);
    }
}

#[test]
fn a_non_utf8_caller_or_purpose_is_refused() {
    let mut request = canonical_request();
    request.caller = ShortBytes::new(vec![0xff, 0xfe, 0xfd]).unwrap();
    assert_eq!(
        IntentRequest::parse(&encode_request(&request).unwrap()).unwrap_err(),
        IntentError::InvalidValue
    );

    let mut request = canonical_request();
    request.purpose = ShortBytes::new(vec![0xc3, 0x28]).unwrap();
    assert_eq!(
        IntentRequest::parse(&encode_request(&request).unwrap()).unwrap_err(),
        IntentError::InvalidValue
    );
}

// ---------------------------------------------------------------------------
// Caller.
// ---------------------------------------------------------------------------

#[test]
fn a_wrong_caller_intent_is_refused() {
    let mut gate = gate();
    let mut request = canonical_request();
    request.caller = ShortBytes::new(b"com.attacker.app".to_vec()).unwrap();
    let bytes = encode_request(&request).unwrap();

    // Unregistered, with no attestation (the iOS shape).
    assert_eq!(
        gate.admit(&bytes, CallerAttestation::None, now())
            .unwrap_err(),
        IntentError::CallerNotAuthorized
    );
    // Unregistered, with a truthful attestation (the Android shape).
    assert_eq!(
        gate.admit(
            &bytes,
            CallerAttestation::Platform {
                package: b"com.attacker.app",
                signing_cert: SigningCertDigest::new([0xAB; 32]),
            },
            now(),
        )
        .unwrap_err(),
        IntentError::CallerNotAuthorized
    );
}

#[test]
fn an_android_impersonator_is_caught_by_the_platform_and_by_the_certificate() {
    let good = encode_request(&canonical_request()).unwrap();

    // The request claims the registered caller; the OS says otherwise.
    let mut impersonated_package = gate();
    assert_eq!(
        impersonated_package
            .admit(
                &good,
                CallerAttestation::Platform {
                    package: b"com.attacker.app",
                    signing_cert: SigningCertDigest::new(CALLER_CERT),
                },
                now(),
            )
            .unwrap_err(),
        IntentError::CallerNotAuthorized,
        "getCallingPackage() disagreeing with the claim is a refusal"
    );

    // The OS agrees about the package — a side-loaded build with the same
    // package name — but the signing certificate is not ours.
    let mut wrong_certificate = gate();
    assert_eq!(
        wrong_certificate
            .admit(
                &good,
                CallerAttestation::Platform {
                    package: CALLER.as_bytes(),
                    signing_cert: SigningCertDigest::new([0x00; 32]),
                },
                now(),
            )
            .unwrap_err(),
        IntentError::CallerNotAuthorized
    );
}

#[test]
fn an_unattested_caller_is_admitted_but_never_reported_as_verified() {
    // The honest iOS outcome, and the one the design document is careful
    // about: the request proceeds, and the confirmation must say the caller is
    // unverified.
    let mut gate = gate();
    let bytes = encode_request(&canonical_request()).unwrap();
    let admitted = gate.admit(&bytes, CallerAttestation::None, now()).unwrap();
    assert!(
        !admitted.caller().trust().is_attested(),
        "there is no iOS API that would justify claiming otherwise"
    );
}

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

fn fulfilled_response(request_id: [u8; 32], intent: Intent) -> Vec<u8> {
    encode_response(&IntentResponseV1 {
        request_id: RequestId::new(request_id),
        intent: intent.code(),
        status: 0,
        payload: Body::new(vec![0x01; 96]).unwrap(),
    })
    .unwrap()
}

#[test]
fn a_response_to_a_question_nobody_asked_is_refused() {
    let mut session = IntentSession::new();
    let _ = session.issue(&canonical_request(), now()).unwrap();

    // A different identifier: an app that never saw the outbound link cannot
    // guess 32 CSPRNG bytes, which is exactly what this refusal encodes.
    assert_eq!(
        session
            .accept(
                &fulfilled_response([0xaa; 32], Intent::SignChallenge),
                now()
            )
            .unwrap_err(),
        IntentError::Unsolicited
    );

    // The right identifier, the wrong family: a forged answer to a different
    // question is not an answer to this one.
    assert_eq!(
        session
            .accept(
                &fulfilled_response([0x77; 32], Intent::ExecutePayment),
                now()
            )
            .unwrap_err(),
        IntentError::Unsolicited
    );
}

#[test]
fn a_response_is_accepted_exactly_once() {
    let mut session = IntentSession::new();
    let _ = session.issue(&canonical_request(), now()).unwrap();
    let response = fulfilled_response([0x77; 32], Intent::SignChallenge);

    assert!(session.accept(&response, now()).is_ok());
    assert_eq!(
        session.accept(&response, now()).unwrap_err(),
        IntentError::Unsolicited,
        "the replay of an observed response link must find nothing outstanding"
    );
}

#[test]
fn a_response_after_the_window_closes_is_refused() {
    let mut session = IntentSession::new();
    let request = canonical_request();
    let _ = session.issue(&request, now()).unwrap();
    let late = IntentClock::new(0, request.expires_at_ms);
    assert_eq!(
        session
            .accept(&fulfilled_response([0x77; 32], Intent::SignChallenge), late)
            .unwrap_err(),
        IntentError::Expired,
        "an answer that arrives after the question expired is not an answer"
    );
    // And the question is gone either way, so a second attempt inside a
    // rewound clock cannot pick it back up.
    assert_eq!(
        session
            .accept(
                &fulfilled_response([0x77; 32], Intent::SignChallenge),
                now()
            )
            .unwrap_err(),
        IntentError::Unsolicited
    );
}

#[test]
fn a_refusal_status_reaches_the_client_as_that_refusal() {
    let mut session = IntentSession::new();
    let _ = session.issue(&canonical_request(), now()).unwrap();
    let refusal = encode_response(&IntentResponseV1 {
        request_id: RequestId::new([0x77; 32]),
        intent: Intent::SignChallenge.code(),
        status: IntentError::CallerNotAuthorized.status(),
        payload: Body::new(Vec::new()).unwrap(),
    })
    .unwrap();
    assert_eq!(
        session.accept(&refusal, now()).unwrap_err(),
        IntentError::CallerNotAuthorized
    );
}

#[test]
fn an_unrecognized_status_is_never_reported_as_success() {
    let mut session = IntentSession::new();
    let _ = session.issue(&canonical_request(), now()).unwrap();
    let unknown = encode_response(&IntentResponseV1 {
        request_id: RequestId::new([0x77; 32]),
        intent: Intent::SignChallenge.code(),
        status: 60_000,
        payload: Body::new(Vec::new()).unwrap(),
    })
    .unwrap();
    assert_eq!(
        session.accept(&unknown, now()).unwrap_err(),
        IntentError::Malformed
    );
}

#[test]
fn a_response_naming_an_unknown_version_is_refused() {
    let mut session = IntentSession::new();
    let _ = session.issue(&canonical_request(), now()).unwrap();
    let body = IntentResponseV1 {
        request_id: RequestId::new([0x77; 32]),
        intent: Intent::SignChallenge.code(),
        status: 0,
        payload: Body::new(vec![0x01; 96]).unwrap(),
    }
    .encode_canonical()
    .unwrap();
    let bytes = f2z_intent::IntentResponseEnvelope {
        version: PROTOCOL_VERSION + 1,
        body: Body::new(body).unwrap(),
    }
    .encode_canonical()
    .unwrap();
    assert_eq!(
        session.accept(&bytes, now()).unwrap_err(),
        IntentError::UnsupportedVersion
    );
}
