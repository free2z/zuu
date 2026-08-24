//! Property tests for `WIRE.md` §3.3 / §4 — re-encode equality.
//!
//! The rule: decode, re-encode, byte-compare, and hash or sign the
//! **re-encoded** bytes. This file is the evidence that the rule holds for
//! arbitrary inputs rather than for the handful a unit test thought of.
//!
//! Four properties, and the fourth is the one that removes the
//! parse-versus-verify gap from the whole system:
//!
//! 1. Any frame this crate can build round-trips to itself, byte for byte.
//! 2. Arbitrary bytes either fail to decode or re-encode to exactly themselves.
//!    There is no third outcome, and a third outcome is precisely the bug: a
//!    decoder that accepts something its encoder would never produce.
//! 3. Mutating any byte of a canonical encoding never yields a value that
//!    re-encodes back to the *original* bytes.
//! 4. A signature computed over the re-encoded bytes by the sender verifies
//!    against the transcript the receiver rebuilds — and a receiver that is
//!    handed non-canonical bytes never reaches the point of computing one.

// See the note in tests/redaction.rs.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::commands::{AppendRequest, Command};
use f2z_codec::error::{CodecError, ErrorCode};
use f2z_codec::frame::{
    CommandAuth, FramePayload, Push, RelayFrame, Request, Response, SignedAuth,
};
use f2z_codec::hash::{LABEL_BODY, hash};
use f2z_codec::transcript::TranscriptBuilder;
use f2z_codec::types::{
    ChannelBinding, Nonce, Payload, PublicKey, QueueAddress, RelayId, Signature,
};
use proptest::prelude::*;

fn arb_array<const N: usize>() -> impl Strategy<Value = [u8; N]> {
    proptest::collection::vec(any::<u8>(), N).prop_map(|bytes| {
        let mut array = [0u8; N];
        array.copy_from_slice(&bytes);
        array
    })
}

fn arb_signed_auth() -> impl Strategy<Value = SignedAuth> {
    (
        arb_array::<32>(),
        arb_array::<32>(),
        any::<u64>(),
        arb_array::<16>(),
        arb_array::<64>(),
    )
        .prop_map(
            |(address, signer_key, timestamp_ms, nonce, signature)| SignedAuth {
                address: QueueAddress::new(address),
                signer_key: PublicKey::new(signer_key),
                timestamp_ms,
                nonce: Nonce::new(nonce),
                signature: Signature::new(signature),
            },
        )
}

fn arb_auth() -> impl Strategy<Value = CommandAuth> {
    prop_oneof![
        Just(CommandAuth::Unsigned),
        arb_signed_auth().prop_map(CommandAuth::Signed),
    ]
}

fn arb_body() -> impl Strategy<Value = Vec<u8>> {
    proptest::collection::vec(any::<u8>(), 0..512)
}

fn arb_frame() -> impl Strategy<Value = RelayFrame> {
    let request = (any::<u32>(), any::<u16>(), arb_auth(), arb_body()).prop_map(
        |(request_id, command, auth, body)| {
            RelayFrame::request(request_id, Request::new(command, auth, body).unwrap())
        },
    );
    let response =
        (any::<u32>(), any::<u16>(), arb_body()).prop_map(|(request_id, status, body)| {
            RelayFrame {
                request_id,
                payload: FramePayload::Response(if status == 0 {
                    Response::ok(body).unwrap()
                } else {
                    Response::error(ErrorCode::from_code(status).unwrap_or(ErrorCode::Internal))
                }),
            }
        });
    let push = (any::<u16>(), arb_body())
        .prop_map(|(event, body)| RelayFrame::push(Push::new(event, body).unwrap()));
    prop_oneof![request, response, push]
}

proptest! {
    /// Property 1: encoding is a total, injective function that decoding
    /// inverts exactly.
    #[test]
    fn every_frame_round_trips_byte_for_byte(frame in arb_frame()) {
        let bytes = frame.encode_canonical().unwrap();
        let decoded = decode_canonical::<RelayFrame>(&bytes).unwrap();
        prop_assert_eq!(decoded.value(), &frame);
        prop_assert_eq!(decoded.bytes(), bytes.as_slice());
        prop_assert_eq!(bytes.len(), tls_codec::Size::tls_serialized_len(&frame));
    }

    /// Property 2, over arbitrary bytes: accept-and-re-encode-identically, or
    /// refuse. Never accept-and-normalize.
    #[test]
    fn arbitrary_bytes_never_decode_to_something_that_re_encodes_differently(
        bytes in proptest::collection::vec(any::<u8>(), 0..2048)
    ) {
        match decode_canonical::<RelayFrame>(&bytes) {
            Ok(decoded) => prop_assert_eq!(decoded.bytes(), bytes.as_slice()),
            Err(error) => prop_assert!(matches!(
                error,
                CodecError::Decode | CodecError::NotCanonical
            )),
        }
    }

    /// Property 2, over bytes that are already *nearly* a frame — a far denser
    /// region of the input space than uniform random bytes reaches.
    #[test]
    fn structured_noise_never_normalizes(
        frame in arb_frame(),
        extra in proptest::collection::vec(any::<u8>(), 0..8)
    ) {
        let mut bytes = frame.encode_canonical().unwrap();
        bytes.extend_from_slice(&extra);
        match decode_canonical::<RelayFrame>(&bytes) {
            Ok(decoded) => prop_assert_eq!(decoded.bytes(), bytes.as_slice()),
            Err(_) => prop_assert!(!extra.is_empty(), "a clean frame must decode"),
        }
    }

    /// Property 3: no mutation of a canonical encoding decodes back to the
    /// original bytes. If one did, two byte strings would carry one signature.
    #[test]
    fn a_mutated_byte_never_re_encodes_to_the_original(
        frame in arb_frame(),
        index in any::<prop::sample::Index>(),
        delta in 1u8..=255
    ) {
        let original = frame.encode_canonical().unwrap();
        let mut mutated = original.clone();
        let position = index.index(mutated.len());
        mutated[position] = mutated[position].wrapping_add(delta);
        prop_assume!(mutated != original);

        if let Ok(decoded) = decode_canonical::<RelayFrame>(&mutated) {
            prop_assert_eq!(decoded.bytes(), mutated.as_slice());
            prop_assert_ne!(decoded.bytes(), original.as_slice());
        }
    }

    /// Property 4: the transcript a receiver rebuilds from the re-encoded bytes
    /// is the transcript the sender signed.
    ///
    /// `sign` here is a stand-in for Ed25519 — this crate has no signing
    /// dependency and does not want one. What is being tested is not the
    /// signature scheme but the *input* to it: that both ends derive the same
    /// bytes, which is the entire content of §3.3 step 4.
    #[test]
    fn a_signature_over_the_re_encoded_bytes_agrees_at_both_ends(
        auth in arb_signed_auth(),
        request_id in 1u32..,
        payload_len in prop::sample::select(vec![1024usize, 4096, 16_384]),
    ) {
        let builder = TranscriptBuilder::new(
            f2z_codec::PROTOCOL_VERSION,
            RelayId::new([0x11; 32]),
            ChannelBinding::new([0x22; 32]),
        );
        let command = Command::Append.code();

        // Sender: encode the body, sign the transcript over those bytes.
        let body = AppendRequest {
            payload: Payload::new(vec![0x5a; payload_len]).unwrap(),
        };
        let body_bytes = body.encode_canonical().unwrap();
        let sender_tag = hash(
            LABEL_BODY,
            &builder
                .signing_bytes_for_auth(command, request_id, &auth, &body_bytes)
                .unwrap(),
        );

        // Wire.
        let frame = RelayFrame::request(
            request_id,
            Request::new(command, CommandAuth::Signed(auth.clone()), body_bytes).unwrap(),
        );
        let wire = frame.encode_canonical().unwrap();

        // Receiver: §3.3 on the frame, then §3.3 again on the body, then the
        // transcript from the *re-encoded* body.
        let received = decode_canonical::<RelayFrame>(&wire).unwrap();
        let FramePayload::Request(request) = &received.value().payload else {
            unreachable!("a request frame decodes as a request")
        };
        let received_body = decode_canonical::<AppendRequest>(request.body()).unwrap();
        let received_auth = request.auth.signed().unwrap();
        let receiver_tag = hash(
            LABEL_BODY,
            &builder
                .signing_bytes_for_auth(
                    request.command,
                    received.value().request_id,
                    received_auth,
                    received_body.bytes(),
                )
                .unwrap(),
        );

        prop_assert_eq!(sender_tag, receiver_tag);
    }
}

/// The same property, stated as the counterexample it exists to prevent: a body
/// with a trailing byte is refused *before* a transcript is built, so there is
/// no moment at which the relay holds a decoded value derived from bytes a
/// signature does not cover.
#[test]
fn a_non_canonical_body_is_refused_before_any_transcript_exists() {
    let body = AppendRequest {
        payload: Payload::new(vec![0u8; 1024]).unwrap(),
    };
    let mut bytes = body.encode_canonical().unwrap();
    bytes.push(0);

    assert_eq!(
        decode_canonical::<AppendRequest>(&bytes),
        Err(CodecError::Decode)
    );
    assert_eq!(
        decode_canonical::<AppendRequest>(&bytes)
            .unwrap_err()
            .error_code(),
        ErrorCode::Malformed
    );
    assert!(ErrorCode::Malformed.is_fatal());
}

/// `CommandAuth`'s `present` byte is the one place a "reasonable" decoder would
/// be tempted to default. It must not.
#[test]
fn an_unknown_auth_discriminant_is_not_treated_as_unsigned() {
    let request = Request::new(Command::Ping.code(), CommandAuth::Unsigned, Vec::new()).unwrap();
    let mut bytes = RelayFrame::request(1, request).encode_canonical().unwrap();
    // kind(1) + request_id(4) + command(2) => the auth discriminant.
    assert_eq!(bytes[7], 0);
    bytes[7] = 7;
    assert!(decode_canonical::<RelayFrame>(&bytes).is_err());
}
