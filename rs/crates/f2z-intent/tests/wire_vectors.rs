//! Byte vectors, derived by hand from the specification.
//!
//! # Why a hand-derived vector and not a round trip
//!
//! `#564`'s lesson, restated: a re-encode of a re-decode stays green through a
//! format change, because the encoder and the decoder move together. Every
//! other test in this crate would pass unchanged if `tls_codec` silently
//! altered a length prefix tomorrow. This file is the independent half — the
//! expected bytes are laid out below field by field from
//! `docs/intent-bridge/PROTOCOL.md` §3, not read out of the encoder — so a
//! wire-format break fails *here*, loudly, instead of shipping.
//!
//! # The same vector is pinned in TypeScript
//!
//! `wallet/shared/src/intent/wire.test.ts` asserts the identical hex string
//! and the identical digest. Two implementations agreeing with themselves
//! proves nothing; two implementations agreeing with the *same written
//! constant* is what makes "one wire format" true rather than aspirational.

#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use f2z_codec::Canonical as _;
use f2z_intent::{IntentRequest, encode_request};

mod common;

use common::canonical_request;

/// The canonical fixture request, byte by byte.
///
/// ```text
/// IntentRequestEnvelope
///   0001                       version = 1
///   00007d                     body length = 125
///   IntentRequestV1
///     0001                     intent = 1 (sign-challenge)
///     77 x32                   request_id
///     12                       caller length = 18
///     "cash.free2z.free2z"
///     11                       purpose length = 17
///     "Sign in to free2z"
///     0000018bcfe56800         issued_at_ms  = 1_700_000_000_000
///     0000018bcfe65260         expires_at_ms = 1_700_000_060_000
///     000023                   payload length = 35
///     SignChallengeRequestV1
///       000020                 challenge length = 32
///       5a x32
/// ```
///
/// 2 + 3 + 125 = 130 bytes.
const CANONICAL_REQUEST_HEX: &str = concat!(
    "0001",
    "00007d",
    "0001",
    "7777777777777777777777777777777777777777777777777777777777777777",
    "12",
    "636173682e66726565327a2e66726565327a",
    "11",
    "5369676e20696e20746f2066726565327a",
    "0000018bcfe56800",
    "0000018bcfe65260",
    "000023",
    "000020",
    "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
);

/// `H("free2z/intent/v1/request", CANONICAL_REQUEST_HEX)`, i.e.
/// `BLAKE2b-256("free2z/intent/v1/request" || envelope)` with no separator —
/// `WIRE.md` §1.3's construction, which is why
/// `scripts/check-hash-domain-labels.mjs` has to hold the whole label set
/// prefix-free.
const CANONICAL_REQUEST_DIGEST_HEX: &str =
    "2e23dfbdfa0ad8da3036bac0756e9191b29f8d7aac3e46b192934c7ddf09affb";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn the_canonical_request_encodes_to_the_specified_bytes() {
    let encoded = encode_request(&canonical_request()).unwrap();
    assert_eq!(
        hex(&encoded),
        CANONICAL_REQUEST_HEX,
        "the encoder no longer produces the bytes the specification describes"
    );
    assert_eq!(encoded.len(), 130);
}

#[test]
fn the_canonical_request_digest_is_the_specified_value() {
    let bytes = encode_request(&canonical_request()).unwrap();
    let request = IntentRequest::parse(&bytes).unwrap();
    assert_eq!(
        hex(request.digest().as_bytes()),
        CANONICAL_REQUEST_DIGEST_HEX,
        "the confirmation binding is computed over different bytes than before"
    );
}

#[test]
fn the_hand_written_vector_is_itself_parseable() {
    // Guards against the vector and the encoder drifting *together* — the
    // failure mode where somebody updates this constant from a debug print
    // instead of from the specification.
    let bytes: Vec<u8> = (0..CANONICAL_REQUEST_HEX.len() / 2)
        .map(|index| {
            u8::from_str_radix(&CANONICAL_REQUEST_HEX[index * 2..index * 2 + 2], 16).unwrap()
        })
        .collect();
    let request = IntentRequest::parse(&bytes).unwrap();
    assert_eq!(request.purpose().as_str(), "Sign in to free2z");
    assert_eq!(request.claimed_caller().as_str(), "cash.free2z.free2z");
    assert_eq!(request.issued_at_ms(), 1_700_000_000_000);
    assert_eq!(request.expires_at_ms(), 1_700_000_060_000);
}

// ---------------------------------------------------------------------------
// The `issue-device-credential` vectors, one per payload version.
//
// Version 1 is **frozen**: e2e2z builds already in testers' hands send it, and
// ZUULI still answers it. Version 2 (ADR 0017 §4.1) is selected by its own
// family code, so the version-1 bytes below must keep parsing, as version 1,
// for as long as the family exists. Both are laid out by hand from
// `PROTOCOL.md` §3.3, and both digests were computed with Python's `hashlib`
// (`blake2b(label + envelope, digest_size=32)`), not by this crate.
// ---------------------------------------------------------------------------

/// The request prefix both credential vectors share, up to the payload length.
///
/// ```text
///   0001                       version = 1
///   0000ad / 000101            body length = 173 / 257
///   0002 / 0004                intent = 2 (v1) / 4 (v2)
///   77 x32                     request_id
///   11 "cash.free2z.e2e2z"     caller, 17 bytes
///   28 "Issue this device a messaging credential"   purpose, 40 bytes
///   0000018bcfe56800           issued_at_ms  = 1_700_000_000_000
///   0000018bcfe65260           expires_at_ms = 1_700_000_060_000
/// ```
macro_rules! credential_request_head {
    ($body_len:literal, $intent:literal) => {
        concat!(
            "0001",
            $body_len,
            $intent,
            "7777777777777777777777777777777777777777777777777777777777777777",
            "11",
            "636173682e66726565327a2e653265327a",
            "28",
            "49737375652074686973206465766963652061206d6573736167696e672063726564656e7469616c",
            "0000018bcfe56800",
            "0000018bcfe65260",
        )
    };
}

/// ```text
///   00003d                     payload length = 61
///   IssueDeviceCredentialRequestV1
///     05 "alice"               handle
///     11 x32                   device_pk
///     000004 22222222          device_kem_pk
///     0000018bcfe56800         not_before_ms = 1_700_000_000_000
///     0000018bd50bc400         not_after_ms  = 1_700_086_400_000
/// ```
///
/// 2 + 3 + 173 = 178 bytes.
const CREDENTIAL_V1_REQUEST_HEX: &str = concat!(
    credential_request_head!("0000ad", "0002"),
    "00003d",
    "05",
    "616c696365",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "000004",
    "22222222",
    "0000018bcfe56800",
    "0000018bd50bc400",
);

const CREDENTIAL_V1_REQUEST_DIGEST_HEX: &str =
    "cc07333d57f7fab0e26fca4a3987dcca8916c61b121fb1f53b874f0f2f953451";

/// Version 1's payload, then the endpoint.
///
/// ```text
///   000091                     payload length = 145
///   IssueDeviceCredentialRequestV2
///     …version 1's 61 bytes…
///     13 "wss://relay.example" contact_relay_url, 19 bytes
///     33 x32                   contact_relay_id
///     44 x32                   contact_addr
/// ```
///
/// 2 + 3 + 257 = 262 bytes.
const CREDENTIAL_V2_REQUEST_HEX: &str = concat!(
    credential_request_head!("000101", "0004"),
    "000091",
    "05",
    "616c696365",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "000004",
    "22222222",
    "0000018bcfe56800",
    "0000018bd50bc400",
    "13",
    "7773733a2f2f72656c61792e6578616d706c65",
    "3333333333333333333333333333333333333333333333333333333333333333",
    "4444444444444444444444444444444444444444444444444444444444444444",
);

const CREDENTIAL_V2_REQUEST_DIGEST_HEX: &str =
    "a6a763c9b6a631f1e81220eeb303caf10cf90a2d3df512d4faf110ff96e42170";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|index| u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap())
        .collect()
}

#[test]
fn the_credential_vectors_encode_to_the_specified_bytes() {
    let v1 = encode_request(&common::credential_vector_request(
        f2z_intent::Intent::IssueDeviceCredential,
        common::credential_vector_v1().encode_canonical().unwrap(),
    ))
    .unwrap();
    assert_eq!(hex(&v1), CREDENTIAL_V1_REQUEST_HEX);
    assert_eq!(v1.len(), 178);

    let v2 = encode_request(&common::credential_vector_request(
        f2z_intent::Intent::IssueDeviceCredentialV2,
        common::credential_vector_v2().encode_canonical().unwrap(),
    ))
    .unwrap();
    assert_eq!(hex(&v2), CREDENTIAL_V2_REQUEST_HEX);
    assert_eq!(v2.len(), 262);
}

/// **The version-1 guard.** Adding version 2 must not change what the frozen
/// version-1 bytes mean: they still parse, as family 2, to version 1's body,
/// under the same digest a confirmation bound before version 2 existed.
#[test]
fn the_frozen_v1_credential_request_still_parses_as_v1() {
    let request = IntentRequest::parse(&unhex(CREDENTIAL_V1_REQUEST_HEX)).unwrap_or_else(|error| {
        panic!("a version-1 credential request must keep parsing: {error}")
    });
    assert_eq!(request.intent(), f2z_intent::Intent::IssueDeviceCredential);
    assert_eq!(
        request.body(),
        &f2z_intent::IntentBody::IssueDeviceCredential(common::credential_vector_v1())
    );
    assert_eq!(
        hex(request.digest().as_bytes()),
        CREDENTIAL_V1_REQUEST_DIGEST_HEX
    );
}

#[test]
fn the_v2_credential_request_parses_to_the_specified_endpoint() {
    let request = IntentRequest::parse(&unhex(CREDENTIAL_V2_REQUEST_HEX)).unwrap();
    assert_eq!(
        request.intent(),
        f2z_intent::Intent::IssueDeviceCredentialV2
    );
    let f2z_intent::IntentBody::IssueDeviceCredentialV2(body) = request.body() else {
        panic!("family 4 must resolve to the version-2 body");
    };
    assert_eq!(body, &common::credential_vector_v2());
    assert_eq!(body.contact_relay_url.as_slice(), b"wss://relay.example");
    assert_eq!(body.contact_addr.as_bytes(), &[0x44; 32]);
    assert_eq!(
        hex(request.digest().as_bytes()),
        CREDENTIAL_V2_REQUEST_DIGEST_HEX
    );
}
