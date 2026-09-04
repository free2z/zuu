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
