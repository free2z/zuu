//! Byte-level wire vectors for every structure in `docs/e2ee/WIRE.md`.
//!
//! # Why this file exists, and what makes it different from every other test
//!
//! `tests/reencode_equality.rs` proves §3.3: decode, re-encode, byte-compare.
//! That is the right test for a *decoder-slack* property and it must stay. It
//! is not a **format** test. Every `TlsSerializeBytes`/`TlsDeserializeBytes`
//! derive pair moves together, so swapping two fields of a struct, or widening
//! a length prefix, changes the bytes on the wire and every round-trip stays
//! green. Measured: 11 of 20 real mutations to the encoding passed the whole
//! suite (#564).
//!
//! So the assertions below are **encode-side and one-directional**. Each one
//! pins what a structure's bytes *are*, against a value written out here by
//! hand.
//!
//! # The rule this file is written under
//!
//! **Every expected byte below was derived by hand from the `WIRE.md` spec
//! text — not by printing what the implementation emits.** Generating the
//! expectations from the code would lock in whatever bug is already there and
//! make the problem worse, which is exactly the defect class #564 is about.
//!
//! The derivation is visible: each field carries the specification's own
//! declaration (`opaque address[32]`, `uint64 timestamp_ms`, …), the width that
//! declaration fixes, and the bytes that width holds for this fixture.
//! [`vector`] asserts the stated width and the supplied bytes agree before it
//! compares anything, so a derivation whose arithmetic is wrong fails on its
//! own terms rather than quietly agreeing with the code.
//!
//! Fixture integers are chosen so the big-endian encoding is self-evident:
//! `0x0102_0304_0506_0708` encodes as `01 02 03 04 05 06 07 08`, and a reviewer
//! can check it without running anything. Adjacent same-width fields are given
//! *different* values on purpose — a swap is only detectable if the two values
//! differ.
//!
//! The BLAKE2b known answers were computed with two tools that are not this
//! crate — `python3 -c 'hashlib.blake2b(data, digest_size=32)'` and
//! `b2sum -l 256` — which agree with each other.
//!
//! # Encoding rules used throughout, from the spec
//!
//! - §1.3: "All integers are unsigned and **big-endian** (network byte order)."
//! - §3.4: `opaque x[n]` is `n` raw bytes with no prefix; `opaque x<0..2^k-1>`
//!   is a `k`-bit length prefix followed by the bytes; `struct { … }` is fixed
//!   field order with no padding.
//! - §3.4: `T x<0..2^k-1>` for a non-byte element type prefixes the number of
//!   **bytes** the elements occupy (RFC 8446 §3.4), not the element count.
//! - §3.1: "A value of a given type has exactly one encoding." There is no
//!   alignment, no padding and no optional field anywhere below.

// Test code, read by a person looking at a failure. The workspace denies these
// because a panic in the relay's parser is a remote denial of service; that
// hazard does not exist in a test binary. `clippy::panic` is allowed because
// `assert_wire` reports which spec field the first divergent byte falls in,
// which `assert_eq!` cannot do.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{
    AckRequest, AckResponse, AppendRequest, BindSendRequest, Capabilities, ChallengePurpose,
    ChallengeRequest, ChallengeResponse, Command, ContactAppendRequest, CreateContactQueueRequest,
    CreateContactQueueResponse, CreateQueueRequest, CreateQueueResponse, HelloRequest,
    HelloResponse, MsgPush, NoticePush, PushEvent, QueueEventPush, QueuedMessage, ReadRequest,
    ReadResponse, SignedCapabilities, SubscribeResponse,
};
use f2z_codec::frame::{CommandAuth, FrameKind, Push, RelayFrame, Request, Response, SignedAuth};
use f2z_codec::hash::{
    LABEL_BODY, LABEL_CAPS, LABEL_COMMAND, LABEL_HELLO, LABEL_POW, LABEL_RELAY_ID, LABELS,
    body_hash, capabilities_digest, hash, hash2, relay_id,
};
use f2z_codec::pow::{PowParams, PowStamp};
use f2z_codec::transcript::{
    AuthContext, HELLO_PROOF_TRANSCRIPT_LEN, HelloProofTranscript, TRANSCRIPT_LEN,
    TranscriptBuilder,
};
use f2z_codec::types::{
    Body, Challenge, ChannelBinding, Digest, Nonce, Payload, PublicKey, QueueAddress, RelayId,
    Salt, ShortBytes, Signature,
};
use f2z_codec::vec::{VecU8, VecU16, VecU24};

// ---------------------------------------------------------------------------
// The derivation harness
// ---------------------------------------------------------------------------

/// One field of a hand-derived expectation.
struct Field {
    /// The specification's own declaration for this field, copied from
    /// `WIRE.md` so a reviewer can diff the list against the spec struct.
    decl: &'static str,
    /// The width in bytes that declaration fixes. Stated separately from the
    /// bytes so the two can be checked against each other.
    width: usize,
    /// The bytes this fixture puts in that width, big-endian per §1.3.
    bytes: Vec<u8>,
}

/// Declare a field: its spec declaration, the width that declaration fixes,
/// and the bytes.
fn f(decl: &'static str, width: usize, bytes: impl AsRef<[u8]>) -> Field {
    Field {
        decl,
        width,
        bytes: bytes.as_ref().to_vec(),
    }
}

/// `n` copies of `byte` — for `opaque x[n]` fields, where a distinct fill value
/// per field is what makes a field swap visible.
fn fill(byte: u8, n: usize) -> Vec<u8> {
    vec![byte; n]
}

/// Concatenate a hand-derived field list, checking each field's stated width
/// against the bytes supplied for it.
fn vector(name: &str, fields: &[Field]) -> Vec<u8> {
    let mut out = Vec::new();
    for field in fields {
        assert_eq!(
            field.bytes.len(),
            field.width,
            "{name}: the derivation of `{}` declares width {} but supplies {} bytes — \
             the hand-derivation is wrong, independently of what the code does",
            field.decl,
            field.width,
            field.bytes.len()
        );
        out.extend_from_slice(&field.bytes);
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Assert that `actual` is exactly the concatenation of the hand-derived field
/// list, and say which spec field the first divergence lands in.
fn assert_wire(name: &str, actual: &[u8], fields: &[Field]) {
    let expected = vector(name, fields);
    if actual == expected {
        return;
    }

    let divergence = actual
        .iter()
        .zip(expected.iter())
        .position(|(a, b)| a != b)
        .unwrap_or(actual.len().min(expected.len()));

    let mut offset = 0usize;
    let mut culprit = String::from("<past the end of the derived vector>");
    for field in fields {
        if divergence < offset + field.width {
            culprit = format!(
                "`{}` at offset {offset} (+{} into the field)",
                field.decl,
                divergence - offset
            );
            break;
        }
        offset += field.width;
    }

    panic!(
        "{name}: encoded bytes do not match the vector derived from WIRE.md.\n\
         first divergence at byte {divergence}, in {culprit}\n\
         expected ({} bytes): {}\n\
         actual   ({} bytes): {}",
        expected.len(),
        hex(&expected),
        actual.len(),
        hex(actual)
    );
}

/// Assert a whole structure encodes to a hand-derived vector.
fn assert_encodes<T: Canonical>(name: &str, value: &T, fields: &[Field]) {
    let actual = value.encode_canonical().unwrap();
    assert_wire(name, &actual, fields);
}

// ---------------------------------------------------------------------------
// Fixture values.
//
// Every integer is written so that its big-endian encoding can be read off the
// literal. Every fixed-width opaque field gets its own fill byte, so that two
// fields swapping places changes the bytes.
// ---------------------------------------------------------------------------

/// `uint64` fixture: `01 02 03 04 05 06 07 08`.
const U64_A: u64 = 0x0102_0304_0506_0708;
const U64_A_BE: [u8; 8] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];

/// A second `uint64`, distinct from the first: `11 12 13 14 15 16 17 18`.
const U64_B: u64 = 0x1112_1314_1516_1718;
const U64_B_BE: [u8; 8] = [0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18];

/// `uint32` fixture: `0a 0b 0c 0d`.
const U32_A: u32 = 0x0a0b_0c0d;
const U32_A_BE: [u8; 4] = [0x0a, 0x0b, 0x0c, 0x0d];

/// A second `uint32`: `1a 1b 1c 1d`.
const U32_B: u32 = 0x1a1b_1c1d;
const U32_B_BE: [u8; 4] = [0x1a, 0x1b, 0x1c, 0x1d];

/// The payload every fixture that needs one carries: 8 bytes of `0x77`.
const PAYLOAD_FILL: u8 = 0x77;
const PAYLOAD_LEN: usize = 8;

/// `AppendRequest{payload = 8 x 0x77}` on the wire, derived in
/// [`append_request_is_a_three_byte_length_prefix_then_the_payload`]:
/// `opaque payload<0..2^24-1>` is a 3-byte length prefix (`00 00 08`) followed
/// by the 8 bytes. This is the body used by the framing and transcript
/// vectors below, so those tests depend on this one being right.
const APPEND_BODY: [u8; 11] = [
    0x00, 0x00, 0x08, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77,
];

fn payload() -> Payload {
    Payload::new(vec![PAYLOAD_FILL; PAYLOAD_LEN]).unwrap()
}

/// The 3-byte length prefix `opaque x<0..2^24-1>` puts before 8 bytes.
/// 8 = `0x000008`.
const LEN24_OF_8: [u8; 3] = [0x00, 0x00, 0x08];

// ---------------------------------------------------------------------------
// §1.3 — `H(label, x)`, and the labels
//
// There is no known-answer vector for `H` anywhere else in the tree, so
// `H(label, x)` could be turned into `H(x, label)` — inverting the construction
// from a prefix to a suffix — and `hash::tests::labels_are_prefix_free` would
// then be asserting the wrong invariant with nothing noticing (#564 M21).
//
// The digests below were produced by two tools outside this crate:
//
//   python3 -c 'import hashlib,sys; print(hashlib.blake2b(LABEL+MSG, digest_size=32).hexdigest())'
//   printf ... | b2sum -l 256
//
// which agree with each other. WIRE.md:67-69 defines
// `H(label, x) = BLAKE2b-256(label || x)` — no separator, no terminator — so
// the input to each is the label's ASCII bytes immediately followed by the
// message's, and nothing else.
// ---------------------------------------------------------------------------

/// The message every label known-answer is taken over: `01 02 03 04 05 06 07 08`.
///
/// Deliberately non-empty and non-palindromic. With an empty message
/// `H(label, x)` and `H(x, label)` are the same value, so an empty message
/// could not detect an inverted construction.
const KAT_MESSAGE: [u8; 8] = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];

fn from_hex(text: &str) -> [u8; 32] {
    assert_eq!(text.len(), 64, "a BLAKE2b-256 digest is 64 hex characters");
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).unwrap();
    }
    out
}

#[test]
fn every_label_is_exactly_the_ascii_the_spec_prints() {
    // WIRE.md:409, :419, :446, :473, :654, :1641. A one-byte change to any of
    // these is a silent domain-separation change: every digest and every
    // signature moves and no round-trip notices.
    assert_eq!(LABEL_COMMAND, b"free2z/relay/v1/cmd".as_slice());
    assert_eq!(LABEL_BODY, b"free2z/relay/v1/body".as_slice());
    assert_eq!(LABEL_RELAY_ID, b"free2z/relay/v1/relay-id".as_slice());
    assert_eq!(LABEL_CAPS, b"free2z/relay/v1/caps".as_slice());
    assert_eq!(LABEL_HELLO, b"free2z/relay/v1/hello".as_slice());
    assert_eq!(LABEL_POW, b"free2z/relay/v1/pow".as_slice());

    // The transcript's `label<0..255>` field is these exact bytes, and its
    // length is what the 1-byte prefix carries: 19 = 0x13.
    assert_eq!(LABEL_COMMAND.len(), 19);
    assert_eq!(LABEL_BODY.len(), 20);
    assert_eq!(LABEL_RELAY_ID.len(), 24);
    assert_eq!(LABEL_CAPS.len(), 20);
    assert_eq!(LABEL_HELLO.len(), 21);
    assert_eq!(LABEL_POW.len(), 19);

    assert_eq!(LABELS.len(), 6);
}

#[test]
fn h_is_blake2b_256_of_label_then_message_and_the_digests_are_known_answers() {
    // Each of these is `BLAKE2b-256(label || 01 02 03 04 05 06 07 08)`,
    // computed outside this crate. They pin two things at once: that the label
    // bytes have not changed, and that `H` prefixes rather than suffixes.
    let cases: [(&[u8], &str); 6] = [
        (
            LABEL_COMMAND,
            "4bc151a976ac6f79d6ee7a4cf2dc17beb11a9d548be94ef264bc027e09e3d123",
        ),
        (
            LABEL_BODY,
            "a7e3812152f4b53d83fc39e8f1bb8491ba9ab6326c746f3a7ac30e171a0e1827",
        ),
        (
            LABEL_RELAY_ID,
            "ea9f075070b908622b9c8bf338107edd9668efd8061681630961c86d75567f53",
        ),
        (
            LABEL_CAPS,
            "c3e91853eeb30976b317362d87fdfb1287fe9123822a9e1d494fcf3e6f474b58",
        ),
        (
            LABEL_HELLO,
            "346966d976fe23d44adf35fd0d390b4c852cf8325cf27c282bc033e616fc5258",
        ),
        (
            LABEL_POW,
            "fb9185a4f4127e391d8029011c757b6501e086ba81969f55fc7e7e41f047e050",
        ),
    ];

    for (label, expected) in cases {
        let actual = hash(label, &KAT_MESSAGE);
        assert_eq!(
            actual.as_bytes(),
            &from_hex(expected),
            "H({:?}, 01..08) is not the known answer",
            core::str::from_utf8(label)
        );
    }
}

#[test]
fn hash2_is_the_same_construction_with_the_message_in_two_pieces() {
    // WIRE.md §5.2 and §13.1 both hash a label over a concatenation.
    // `BLAKE2b-256("free2z/relay/v1/pow" || "aa" || "bb")`, computed outside
    // this crate.
    assert_eq!(
        hash2(LABEL_POW, b"aa", b"bb").as_bytes(),
        &from_hex("747efbe531ef92e3e76c205ff141d6e88ae197c8d1865cae6fbae6cd565b19d2")
    );
    // …and the split is not observable, which is the property §5.2 relies on.
    assert_eq!(hash2(LABEL_POW, b"aa", b"bb"), hash(LABEL_POW, b"aabb"));
}

#[test]
fn relay_id_is_a_known_answer_over_the_identity_key() {
    // WIRE.md:446 — `relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)`.
    // `BLAKE2b-256("free2z/relay/v1/relay-id" || a1 x 32)`, computed outside
    // this crate.
    let key = PublicKey::new([0xa1; 32]);
    assert_eq!(
        relay_id(&key).as_bytes(),
        &from_hex("507bf541b79bc24df2f313606e858c19e8166dca62274336f95f245683eda48e")
    );
}

#[test]
fn body_hash_is_a_known_answer_over_the_re_encoded_body() {
    // WIRE.md:419 — `body_hash = H("free2z/relay/v1/body", body)`, over the
    // §3.3 re-encoded bytes. The body here is `APPEND_BODY`, whose own
    // derivation is one test below.
    // `BLAKE2b-256("free2z/relay/v1/body" || 00 00 08 77 77 77 77 77 77 77 77)`.
    assert_eq!(
        body_hash(&APPEND_BODY).as_bytes(),
        &from_hex("a0a5cdf686d12c0f701cf3e6573c6498af130d090da8f8a5c53ac2140363ccab")
    );
}

#[test]
fn capabilities_digest_is_a_known_answer() {
    // WIRE.md:654 — `H("free2z/relay/v1/caps", tls_codec(Capabilities))`. The
    // digest is over whatever bytes it is handed, so the known answer is taken
    // over the same fixed message as the other labels; the `Capabilities`
    // encoding itself is pinned separately below.
    assert_eq!(
        capabilities_digest(&KAT_MESSAGE).as_bytes(),
        &from_hex("c3e91853eeb30976b317362d87fdfb1287fe9123822a9e1d494fcf3e6f474b58")
    );
}

#[test]
fn hello_proof_transcript_covers_the_complete_announcement_in_spec_order() {
    // WIRE.md §5.2. Derived field-by-field from the printed TLS structure,
    // independently of the derive implementation this test judges.
    let transcript = HelloProofTranscript {
        label: ShortBytes::new(LABEL_HELLO).unwrap(),
        channel_binding: ChannelBinding::new([0xa1; 32]),
        client_nonce: Challenge::new([0xb2; 32]),
        protocol_version: 1,
        relay_identity_pk: PublicKey::new([0xc3; 32]),
        relay_id: RelayId::new([0xd4; 32]),
        relay_time_ms: 0x0102_0304_0506_0708,
        channel_binding_mode: 1,
        transport_security: 0,
        capabilities_digest: Digest::new([0xe5; 32]),
    };
    let message = transcript.signing_bytes().unwrap();
    assert_wire(
        "HelloProofTranscript",
        &message,
        &[
            f("uint8 label length = 21", 1, [21]),
            f("label", 21, b"free2z/relay/v1/hello"),
            f("channel_binding[32]", 32, fill(0xa1, 32)),
            f("client_nonce[32]", 32, fill(0xb2, 32)),
            f("protocol_version", 2, [0, 1]),
            f("relay_identity_pk[32]", 32, fill(0xc3, 32)),
            f("relay_id[32]", 32, fill(0xd4, 32)),
            f("relay_time_ms", 8, [1, 2, 3, 4, 5, 6, 7, 8]),
            f("channel_binding_mode", 1, [1]),
            f("transport_security", 1, [0]),
            f("capabilities_digest[32]", 32, fill(0xe5, 32)),
        ],
    );
    assert_eq!(message.len(), HELLO_PROOF_TRANSCRIPT_LEN);
}

#[test]
fn labels_are_prefix_free_over_the_bytes_the_spec_prints() {
    // `hash::tests::labels_are_prefix_free` asserts this too, but through
    // `LABELS`. Restated here over the literal ASCII, because the invariant is
    // only meaningful given that `H` is a *prefix* construction — which the
    // known answers above are what actually pin.
    let spelled: [&[u8]; 6] = [
        b"free2z/relay/v1/cmd",
        b"free2z/relay/v1/body",
        b"free2z/relay/v1/relay-id",
        b"free2z/relay/v1/caps",
        b"free2z/relay/v1/hello",
        b"free2z/relay/v1/pow",
    ];
    for (i, a) in spelled.iter().enumerate() {
        for (j, b) in spelled.iter().enumerate() {
            assert!(
                i == j || !b.starts_with(a),
                "{:?} is a prefix of {:?}",
                core::str::from_utf8(a),
                core::str::from_utf8(b)
            );
        }
    }
}

// ---------------------------------------------------------------------------
// §3.4 — the primitives everything else is built out of
// ---------------------------------------------------------------------------

#[test]
fn a_fixed_opaque_field_is_raw_bytes_with_no_prefix() {
    // §3.4: `opaque x[n]` — fixed-length byte string. No length, no padding.
    assert_wire(
        "QueueAddress",
        &QueueAddress::new([0xa1; 32]).encode_canonical().unwrap(),
        &[f("opaque address[32]", 32, fill(0xa1, 32))],
    );
    assert_wire(
        "Signature",
        &Signature::new([0xd4; 64]).encode_canonical().unwrap(),
        &[f("opaque signature[64]", 64, fill(0xd4, 64))],
    );
    assert_wire(
        "Nonce",
        &Nonce::new([0xc3; 16]).encode_canonical().unwrap(),
        &[f("opaque nonce[16]", 16, fill(0xc3, 16))],
    );
}

#[test]
fn a_variable_opaque_field_is_a_length_prefix_of_the_declared_width() {
    // §3.4: `opaque x<0..2^k-1>` — a k-bit length prefix. `<0..255>` is one
    // byte; `<0..2^24-1>` is three.
    assert_wire(
        "ShortBytes",
        &ShortBytes::new(b"free2z".to_vec())
            .unwrap()
            .encode_canonical()
            .unwrap(),
        &[
            f("uint8 length = 6", 1, [0x06]),
            f("\"free2z\"", 6, b"free2z"),
        ],
    );
    assert_wire(
        "Payload",
        &payload().encode_canonical().unwrap(),
        &[
            f("uint24 length = 8", 3, LEN24_OF_8),
            f("8 payload bytes", 8, fill(PAYLOAD_FILL, 8)),
        ],
    );
    assert_wire(
        "Body",
        &Body::new(vec![0x5a; 3])
            .unwrap()
            .encode_canonical()
            .unwrap(),
        &[
            f("uint24 length = 3", 3, [0x00, 0x00, 0x03]),
            f("3 body bytes", 3, fill(0x5a, 3)),
        ],
    );
    // The empty body several commands have by rule (§6.2, §6.3) is the prefix
    // and nothing else.
    assert_eq!(
        Body::default().encode_canonical().unwrap(),
        vec![0x00, 0x00, 0x00]
    );
}

#[test]
fn a_vector_of_non_byte_elements_prefixes_bytes_not_elements() {
    // §3.4 / RFC 8446 §3.4: the prefix on `T x<0..2^k-1>` is the number of
    // bytes the elements occupy. Two `uint16`s are four bytes, not two
    // elements.
    assert_wire(
        "VecU8<u16> (as `uint16 protocol_versions<1..255>`)",
        &VecU8::<u16>::from(vec![0x0001u16, 0x0002])
            .encode_canonical()
            .unwrap(),
        &[
            f("uint8 byte length = 4", 1, [0x04]),
            f("uint16 = 0x0001", 2, [0x00, 0x01]),
            f("uint16 = 0x0002", 2, [0x00, 0x02]),
        ],
    );
    assert_wire(
        "VecU16<u32> (as `uint32 padding_sizes<1..2^16-1>`)",
        &VecU16::<u32>::from(vec![U32_A]).encode_canonical().unwrap(),
        &[
            f("uint16 byte length = 4", 2, [0x00, 0x04]),
            f("uint32 = 0x0a0b0c0d", 4, U32_A_BE),
        ],
    );
    assert_wire(
        "VecU24<u32>",
        &VecU24::<u32>::from(vec![U32_A]).encode_canonical().unwrap(),
        &[
            f("uint24 byte length = 4", 3, [0x00, 0x00, 0x04]),
            f("uint32 = 0x0a0b0c0d", 4, U32_A_BE),
        ],
    );
}

// ---------------------------------------------------------------------------
// §4 — framing
// ---------------------------------------------------------------------------

#[test]
fn frame_kind_is_one_byte_with_the_values_the_spec_assigns() {
    // §4.1: `enum { request(1), response(2), push(3), (255) } FrameKind;` —
    // the `(255)` fixes the width at one byte and is not a variant.
    assert_eq!(FrameKind::Request.code(), 1);
    assert_eq!(FrameKind::Response.code(), 2);
    assert_eq!(FrameKind::Push.code(), 3);
}

#[test]
fn a_request_frame_is_kind_request_id_command_auth_body() {
    // §4.1:
    //   struct { FrameKind kind; uint32 request_id; ... } RelayFrame;
    //   struct { uint16 command; CommandAuth auth; opaque body<0..2^24-1>; } Request;
    let frame = RelayFrame::request(
        U32_A,
        Request::new(
            Command::Append.code(),
            CommandAuth::Unsigned,
            APPEND_BODY.to_vec(),
        )
        .unwrap(),
    );
    assert_encodes(
        "RelayFrame(request)",
        &frame,
        &[
            f("FrameKind kind = request(1)", 1, [0x01]),
            f("uint32 request_id = 0x0a0b0c0d", 4, U32_A_BE),
            f("uint16 command = APPEND (0x0021)", 2, [0x00, 0x21]),
            f("CommandAuth.present = 0 (unsigned)", 1, [0x00]),
            f("uint24 body length = 11", 3, [0x00, 0x00, 0x0b]),
            f("AppendRequest body", 11, APPEND_BODY),
        ],
    );
}

#[test]
fn a_response_frame_is_kind_request_id_status_body() {
    // §4.1: `struct { uint16 status; opaque body<0..2^24-1>; } Response;`
    // §10: an error response carries a code and nothing else, so the body is
    // an empty `<0..2^24-1>` — a zero prefix, not zero bytes.
    assert_encodes(
        "RelayFrame(response, ERR_UNAVAILABLE)",
        &RelayFrame::response(U32_A, Response::error(f2z_codec::ErrorCode::Unavailable)),
        &[
            f("FrameKind kind = response(2)", 1, [0x02]),
            f("uint32 request_id = 0x0a0b0c0d", 4, U32_A_BE),
            f("uint16 status = ERR_UNAVAILABLE (15)", 2, [0x00, 0x0f]),
            f("uint24 body length = 0", 3, [0x00, 0x00, 0x00]),
        ],
    );

    assert_encodes(
        "RelayFrame(response, ok)",
        &RelayFrame::response(U32_B, Response::ok(vec![0x5a, 0x5b]).unwrap()),
        &[
            f("FrameKind kind = response(2)", 1, [0x02]),
            f("uint32 request_id = 0x1a1b1c1d", 4, U32_B_BE),
            f("uint16 status = 0 (success)", 2, [0x00, 0x00]),
            f("uint24 body length = 2", 3, [0x00, 0x00, 0x02]),
            f("body", 2, [0x5a, 0x5b]),
        ],
    );
}

#[test]
fn a_push_frame_is_kind_zero_request_id_event_body() {
    // §4.1: `struct { uint16 event; opaque body<0..2^24-1>; } Push;`
    // §4.3: "Push frames use `request_id = 0`."
    assert_encodes(
        "RelayFrame(push)",
        &RelayFrame::push(Push::new(PushEvent::Notice.code(), vec![0x03]).unwrap()),
        &[
            f("FrameKind kind = push(3)", 1, [0x03]),
            f("uint32 request_id = 0", 4, [0x00, 0x00, 0x00, 0x00]),
            f("uint16 event = NOTICE (0x0082)", 2, [0x00, 0x82]),
            f("uint24 body length = 1", 3, [0x00, 0x00, 0x01]),
            f("body", 1, [0x03]),
        ],
    );
}

// ---------------------------------------------------------------------------
// §5.1 — the signing transcript.
//
// These two are the highest-blast-radius vectors in the file: `SignedAuth`'s
// and `CommandTranscript`'s field order is what every Ed25519 signature in the
// protocol commits to. Swapping `address` and `signer_key` in either changes
// the signed bytes and changes nothing a round-trip can see.
// ---------------------------------------------------------------------------

fn signed_auth() -> SignedAuth {
    SignedAuth {
        address: QueueAddress::new([0xa1; 32]),
        signer_key: PublicKey::new([0xb2; 32]),
        timestamp_ms: U64_A,
        nonce: Nonce::new([0xc3; 16]),
        signature: Signature::new([0xd4; 64]),
    }
}

/// `SignedAuth`'s fields, in the order `WIRE.md:400-406` prints them.
///
/// ```text
/// struct {
///     opaque address[32];        /* the queue address acted on; zeros where none */
///     opaque signer_key[32];     /* Ed25519 public key claimed to authorize this */
///     uint64 timestamp_ms;       /* client clock, milliseconds since Unix epoch  */
///     opaque nonce[16];          /* client CSPRNG, fresh per command             */
///     opaque signature[64];      /* Ed25519 over CommandTranscript               */
/// } SignedAuth;
/// ```
fn signed_auth_fields() -> Vec<Field> {
    vec![
        f("opaque address[32]", 32, fill(0xa1, 32)),
        f("opaque signer_key[32]", 32, fill(0xb2, 32)),
        f("uint64 timestamp_ms = 0x0102030405060708", 8, U64_A_BE),
        f("opaque nonce[16]", 16, fill(0xc3, 16)),
        f("opaque signature[64]", 64, fill(0xd4, 64)),
    ]
}

#[test]
fn signed_auth_is_address_then_signer_key_then_timestamp_nonce_signature() {
    // Widths: 32 + 32 + 8 + 16 + 64 = 152.
    let encoded = signed_auth().encode_canonical().unwrap();
    assert_eq!(encoded.len(), 152);
    assert_wire("SignedAuth", &encoded, &signed_auth_fields());

    // Said the other way, because this is the field order the whole signature
    // scheme rests on: the *first* 32 bytes are the address, and the address
    // fixture is 0xa1.
    assert_eq!(&encoded[..32], &[0xa1u8; 32]);
    assert_eq!(&encoded[32..64], &[0xb2u8; 32]);
}

#[test]
fn command_auth_is_a_present_byte_then_the_authenticator_if_present() {
    // §5.1:
    //   struct {
    //       uint8 present;   /* 0 = unsigned command, 1 = signed */
    //       select (CommandAuth.present) { case 0: struct {}; case 1: SignedAuth; } auth;
    //   } CommandAuth;
    //
    // `case 0: struct {}` is the empty structure: the present byte and nothing
    // after it.
    assert_wire(
        "CommandAuth::Unsigned",
        &CommandAuth::Unsigned.encode_canonical().unwrap(),
        &[f("uint8 present = 0", 1, [0x00])],
    );

    let mut fields = vec![f("uint8 present = 1", 1, [0x01])];
    fields.extend(signed_auth_fields());
    let encoded = CommandAuth::Signed(signed_auth())
        .encode_canonical()
        .unwrap();
    assert_eq!(encoded.len(), 1 + 152);
    assert_wire("CommandAuth::Signed", &encoded, &fields);
}

#[test]
fn the_command_transcript_is_the_eleven_fields_of_section_5_1_in_order() {
    // WIRE.md:408-420:
    //
    // ```text
    // struct {
    //     opaque label<0..255>;      /* exactly "free2z/relay/v1/cmd"    */
    //     uint16 protocol_version;
    //     opaque relay_id[32];       /* §5.2                             */
    //     opaque channel_binding[32];/* §5.3                             */
    //     uint16 command;
    //     uint32 request_id;
    //     opaque address[32];
    //     opaque signer_key[32];
    //     uint64 timestamp_ms;
    //     opaque nonce[16];
    //     opaque body_hash[32];      /* H("free2z/relay/v1/body", body)  */
    // } CommandTranscript;
    // ```
    //
    // Widths: (1 + 19) + 2 + 32 + 32 + 2 + 4 + 32 + 32 + 8 + 16 + 32 = 212.
    let builder = TranscriptBuilder::new(
        0x0001,
        RelayId::new([0xe5; 32]),
        ChannelBinding::new([0xf6; 32]),
    );
    let context = AuthContext {
        address: QueueAddress::new([0xa1; 32]),
        signer_key: PublicKey::new([0xb2; 32]),
        timestamp_ms: U64_A,
        nonce: Nonce::new([0xc3; 16]),
    };
    let transcript = builder
        .build(Command::Append.code(), U32_A, &context, &APPEND_BODY)
        .unwrap();

    let signing_bytes = transcript.signing_bytes().unwrap();
    assert_eq!(signing_bytes.len(), 212);
    assert_eq!(signing_bytes.len(), TRANSCRIPT_LEN);

    assert_wire(
        "CommandTranscript",
        &signing_bytes,
        &[
            f("uint8 label length = 19", 1, [0x13]),
            f("\"free2z/relay/v1/cmd\"", 19, b"free2z/relay/v1/cmd"),
            f("uint16 protocol_version = 1", 2, [0x00, 0x01]),
            f("opaque relay_id[32]", 32, fill(0xe5, 32)),
            f("opaque channel_binding[32]", 32, fill(0xf6, 32)),
            f("uint16 command = APPEND (0x0021)", 2, [0x00, 0x21]),
            f("uint32 request_id = 0x0a0b0c0d", 4, U32_A_BE),
            f("opaque address[32]", 32, fill(0xa1, 32)),
            f("opaque signer_key[32]", 32, fill(0xb2, 32)),
            f("uint64 timestamp_ms = 0x0102030405060708", 8, U64_A_BE),
            f("opaque nonce[16]", 16, fill(0xc3, 16)),
            f(
                "opaque body_hash[32] = H(\"free2z/relay/v1/body\", APPEND_BODY)",
                32,
                from_hex("a0a5cdf686d12c0f701cf3e6573c6498af130d090da8f8a5c53ac2140363ccab"),
            ),
        ],
    );

    // §5.1: the label is `exactly` those bytes, and nothing else validates.
    assert!(transcript.validate().is_ok());
    let mut wrong = transcript;
    wrong.label = ShortBytes::new(b"free2z/relay/v1/cmX".to_vec()).unwrap();
    assert!(wrong.validate().is_err());
}

#[test]
fn rebuilding_the_transcript_from_a_received_auth_gives_the_same_bytes() {
    // §5.1 step 4: the relay reconstructs the transcript from *its own*
    // `relay_id` and `channel_binding` and the frame's remaining fields. The
    // reconstruction must land on the identical byte string or every signature
    // fails, so it is pinned against the same hand-derived vector.
    let builder = TranscriptBuilder::new(
        0x0001,
        RelayId::new([0xe5; 32]),
        ChannelBinding::new([0xf6; 32]),
    );
    let rebuilt = builder
        .signing_bytes_for_auth(Command::Append.code(), U32_A, &signed_auth(), &APPEND_BODY)
        .unwrap();
    assert_eq!(
        hex(&rebuilt[..20]),
        "1366726565327a2f72656c61792f76312f636d64"
    );
    assert_eq!(rebuilt.len(), TRANSCRIPT_LEN);
    // `address` starts at byte 92 and `signer_key` at 124:
    // (1 + 19) label + 2 version + 32 relay_id + 32 channel_binding
    // + 2 command + 4 request_id = 92.
    assert_eq!(&rebuilt[92..124], &[0xa1u8; 32], "address");
    assert_eq!(&rebuilt[124..156], &[0xb2u8; 32], "signer_key");
}

// ---------------------------------------------------------------------------
// §6.1 — unsigned commands
// ---------------------------------------------------------------------------

#[test]
fn hello_request_is_min_version_max_version_client_nonce() {
    // WIRE.md:623-627:
    //   struct { uint16 min_version; uint16 max_version; opaque client_nonce[32]; } HelloRequest;
    // Widths: 2 + 2 + 32 = 36.
    assert_encodes(
        "HelloRequest",
        &HelloRequest {
            min_version: 0x0001,
            max_version: 0x0002,
            client_nonce: Challenge::new([0xa1; 32]),
        },
        &[
            f("uint16 min_version = 1", 2, [0x00, 0x01]),
            f("uint16 max_version = 2", 2, [0x00, 0x02]),
            f("opaque client_nonce[32]", 32, fill(0xa1, 32)),
        ],
    );
}

#[test]
fn hello_response_puts_channel_binding_mode_before_transport_security() {
    // WIRE.md:629-638:
    //
    // ```text
    // struct {
    //     uint16 protocol_version;
    //     opaque relay_identity_pk[32];
    //     opaque relay_id[32];
    //     opaque relay_proof[64];
    //     uint64 relay_time_ms;
    //     uint8  channel_binding_mode;    /* 0 = none, 1 = tls-exporter */
    //     uint8  transport_security;      /* 0 = none, 1 = tls */
    //     opaque capabilities_digest[32];
    // } HelloResponse;
    // ```
    //
    // The two `uint8`s are adjacent and mean different things, so the fixture
    // gives them different values: a relay that swapped them would publish
    // "TLS but no channel binding" as "channel binding but no TLS".
    // Widths: 2 + 32 + 32 + 64 + 8 + 1 + 1 + 32 = 172.
    assert_encodes(
        "HelloResponse",
        &HelloResponse {
            protocol_version: 0x0001,
            relay_identity_pk: PublicKey::new([0xa1; 32]),
            relay_id: RelayId::new([0xb2; 32]),
            relay_proof: Signature::new([0xc3; 64]),
            relay_time_ms: U64_A,
            channel_binding_mode: 1,
            transport_security: 0,
            capabilities_digest: Digest::new([0xd4; 32]),
        },
        &[
            f("uint16 protocol_version = 1", 2, [0x00, 0x01]),
            f("opaque relay_identity_pk[32]", 32, fill(0xa1, 32)),
            f("opaque relay_id[32]", 32, fill(0xb2, 32)),
            f("opaque relay_proof[64]", 64, fill(0xc3, 64)),
            f("uint64 relay_time_ms = 0x0102030405060708", 8, U64_A_BE),
            f("uint8 channel_binding_mode = 1 (tls-exporter)", 1, [0x01]),
            f("uint8 transport_security = 0 (none)", 1, [0x00]),
            f("opaque capabilities_digest[32]", 32, fill(0xd4, 32)),
        ],
    );
}

#[test]
fn challenge_request_is_a_purpose_byte_then_a_short_scope() {
    // WIRE.md:642-647:
    //   enum { clock(0), queue_create(1), contact_append(2), (255) } ChallengePurpose;
    //   struct { ChallengePurpose purpose; opaque scope<0..255>; } ChallengeRequest;
    //
    // §12.3: for `contact_append` the scope is the target `contact_addr`, so
    // the fixture's scope is 32 bytes and its prefix is 0x20.
    assert_eq!(ChallengePurpose::Clock.code(), 0);
    assert_eq!(ChallengePurpose::QueueCreate.code(), 1);
    assert_eq!(ChallengePurpose::ContactAppend.code(), 2);

    assert_encodes(
        "ChallengeRequest",
        &ChallengeRequest {
            purpose: ChallengePurpose::ContactAppend.code(),
            scope: ShortBytes::new(vec![0xa1; 32]).unwrap(),
        },
        &[
            f("ChallengePurpose purpose = contact_append(2)", 1, [0x02]),
            f("uint8 scope length = 32", 1, [0x20]),
            f("scope = contact_addr", 32, fill(0xa1, 32)),
        ],
    );

    // The empty scope of a `clock` challenge is the prefix alone.
    assert_encodes(
        "ChallengeRequest(clock)",
        &ChallengeRequest {
            purpose: ChallengePurpose::Clock.code(),
            scope: ShortBytes::default(),
        },
        &[
            f("ChallengePurpose purpose = clock(0)", 1, [0x00]),
            f("uint8 scope length = 0", 1, [0x00]),
        ],
    );
}

#[test]
fn challenge_response_puts_the_challenge_before_the_expiry() {
    // WIRE.md:648-653:
    //
    // ```text
    // struct {
    //     uint64    relay_time_ms;
    //     opaque    challenge[32];
    //     uint64    expires_at_ms;
    //     PowParams pow;           /* §13.1; zeroed when no PoW is required */
    // } ChallengeResponse;
    // ```
    //
    // Widths: 8 + 32 + 8 + (1 + 1 + 4) = 54.
    assert_encodes(
        "ChallengeResponse",
        &ChallengeResponse {
            relay_time_ms: U64_A,
            challenge: Challenge::new([0xa1; 32]),
            expires_at_ms: U64_B,
            pow: PowParams {
                algorithm: 1,
                difficulty_bits: 20,
                challenge_ttl_ms: 60_000,
            },
        },
        &[
            f("uint64 relay_time_ms = 0x0102030405060708", 8, U64_A_BE),
            f("opaque challenge[32]", 32, fill(0xa1, 32)),
            f("uint64 expires_at_ms = 0x1112131415161718", 8, U64_B_BE),
            f("PowParams.algorithm = 1", 1, [0x01]),
            f("PowParams.difficulty_bits = 20", 1, [0x14]),
            f(
                "PowParams.challenge_ttl_ms = 60000 = 0x0000ea60",
                4,
                [0x00, 0x00, 0xea, 0x60],
            ),
        ],
    );
}

// ---------------------------------------------------------------------------
// §6.2 — commands signed by the receive-side queue key
// ---------------------------------------------------------------------------

#[test]
fn create_queue_request_is_key_two_ttls_flags_stamp() {
    // WIRE.md:700-707:
    //
    // ```text
    // struct {
    //     opaque    recv_key[32];
    //     uint32    req_message_ttl_seconds;
    //     uint32    req_idle_ttl_seconds;
    //     uint16    flags;                  /* reserved; MUST be 0 in v1 */
    //     PowStamp  stamp;
    // } CreateQueueRequest;
    // ```
    //
    // Widths: 32 + 4 + 4 + 2 + (32 + 16 + 8) = 98.
    // §7.7 defaults: message TTL 604 800 = 0x0009_3A80,
    //                idle TTL    7 776 000 = 0x0076_A700.
    assert_encodes(
        "CreateQueueRequest",
        &CreateQueueRequest {
            recv_key: PublicKey::new([0xa1; 32]),
            req_message_ttl_seconds: 604_800,
            req_idle_ttl_seconds: 7_776_000,
            flags: 0,
            stamp: PowStamp {
                challenge: Challenge::new([0xb2; 32]),
                salt: Salt::new([0xc3; 16]),
                counter: U64_A,
            },
        },
        &[
            f("opaque recv_key[32]", 32, fill(0xa1, 32)),
            f(
                "uint32 req_message_ttl_seconds = 604800 = 0x00093a80",
                4,
                [0x00, 0x09, 0x3a, 0x80],
            ),
            f(
                "uint32 req_idle_ttl_seconds = 7776000 = 0x0076a700",
                4,
                [0x00, 0x76, 0xa7, 0x00],
            ),
            f("uint16 flags = 0", 2, [0x00, 0x00]),
            f("PowStamp.challenge[32]", 32, fill(0xb2, 32)),
            f("PowStamp.salt[16]", 16, fill(0xc3, 16)),
            f("PowStamp.counter = 0x0102030405060708", 8, U64_A_BE),
        ],
    );

    // §13.1's "empty when queue_creation_mode = open": the structure is
    // fixed-width, so an empty stamp is 56 zero bytes, not zero bytes.
    let open = CreateQueueRequest {
        recv_key: PublicKey::zero(),
        req_message_ttl_seconds: 0,
        req_idle_ttl_seconds: 0,
        flags: 0,
        stamp: PowStamp::empty(),
    };
    assert_eq!(open.encode_canonical().unwrap(), vec![0u8; 98]);
}

#[test]
fn create_queue_response_puts_recv_addr_before_send_addr() {
    // WIRE.md:709-715:
    //
    // ```text
    // struct {
    //     opaque recv_addr[32];
    //     opaque send_addr[32];
    //     uint32 message_ttl_seconds;       /* granted, after clamping (§7.7) */
    //     uint32 idle_ttl_seconds;          /* granted, after clamping (§7.7) */
    //     uint64 created_at_ms;
    // } CreateQueueResponse;
    // ```
    //
    // The order is the security-relevant part. `recv_addr` is the read
    // capability and stays on the recipient's device; `send_addr` is handed to
    // a peer in an advert (§7.2). A client that read them in the wrong order
    // would publish its own read capability to its peer.
    // Widths: 32 + 32 + 4 + 4 + 8 = 80.
    assert_encodes(
        "CreateQueueResponse",
        &CreateQueueResponse {
            recv_addr: QueueAddress::new([0xa1; 32]),
            send_addr: QueueAddress::new([0xb2; 32]),
            message_ttl_seconds: 604_800,
            idle_ttl_seconds: 7_776_000,
            created_at_ms: U64_A,
        },
        &[
            f("opaque recv_addr[32]", 32, fill(0xa1, 32)),
            f("opaque send_addr[32]", 32, fill(0xb2, 32)),
            f(
                "uint32 message_ttl_seconds = 604800 = 0x00093a80",
                4,
                [0x00, 0x09, 0x3a, 0x80],
            ),
            f(
                "uint32 idle_ttl_seconds = 7776000 = 0x0076a700",
                4,
                [0x00, 0x76, 0xa7, 0x00],
            ),
            f("uint64 created_at_ms = 0x0102030405060708", 8, U64_A_BE),
        ],
    );
}

#[test]
fn subscribe_response_is_next_index_then_pending() {
    // WIRE.md:723-726:
    //   struct { uint64 next_index; uint64 pending; } SubscribeResponse;
    assert_encodes(
        "SubscribeResponse",
        &SubscribeResponse {
            next_index: U64_A,
            pending: U64_B,
        },
        &[
            f("uint64 next_index = 0x0102030405060708", 8, U64_A_BE),
            f("uint64 pending = 0x1112131415161718", 8, U64_B_BE),
        ],
    );
}

#[test]
fn read_request_is_from_index_max_messages_max_bytes() {
    // WIRE.md:736-740:
    //   struct { uint64 from_index; uint16 max_messages; uint32 max_bytes; } ReadRequest;
    // Widths: 8 + 2 + 4 = 14. Note the `uint16` sits between two wider fields,
    // with no alignment padding — §3.4's "no padding".
    assert_encodes(
        "ReadRequest",
        &ReadRequest {
            from_index: U64_A,
            max_messages: 0x0102,
            max_bytes: U32_A,
        },
        &[
            f("uint64 from_index = 0x0102030405060708", 8, U64_A_BE),
            f("uint16 max_messages = 0x0102", 2, [0x01, 0x02]),
            f("uint32 max_bytes = 0x0a0b0c0d", 4, U32_A_BE),
        ],
    );
    assert_eq!(
        ReadRequest {
            from_index: U64_A,
            max_messages: 0x0102,
            max_bytes: U32_A,
        }
        .encode_canonical()
        .unwrap()
        .len(),
        14
    );
}

fn queued_message() -> QueuedMessage {
    QueuedMessage {
        index: U64_A,
        received_at_ms: U64_B,
        payload: payload(),
    }
}

/// `QueuedMessage`'s fields (`WIRE.md:742-746`), 8 + 8 + (3 + 8) = 27 bytes.
fn queued_message_fields() -> Vec<Field> {
    vec![
        f("uint64 index = 0x0102030405060708", 8, U64_A_BE),
        f("uint64 received_at_ms = 0x1112131415161718", 8, U64_B_BE),
        f("uint24 payload length = 8", 3, LEN24_OF_8),
        f("payload bytes", 8, fill(PAYLOAD_FILL, 8)),
    ]
}

#[test]
fn a_queued_message_is_index_timestamp_payload() {
    // WIRE.md:742-746:
    //   struct { uint64 index; uint64 received_at_ms; opaque payload<0..2^24-1>; } QueuedMessage;
    let encoded = queued_message().encode_canonical().unwrap();
    assert_eq!(encoded.len(), 27);
    assert_wire("QueuedMessage", &encoded, &queued_message_fields());
}

#[test]
fn read_response_uses_a_three_byte_vector_prefix() {
    // WIRE.md:748-751:
    //   struct { QueuedMessage messages<0..2^24-1>; uint8 has_more; } ReadResponse;
    //
    // `<0..2^24-1>` is a **three**-byte prefix. Narrowing it to two would cap a
    // READ response at 64 KiB and desynchronise every other implementation —
    // and, because the prefix counts bytes, two 27-byte messages here occupy
    // 54 = 0x000036, which a two-byte prefix would render as `00 36`.
    let response = ReadResponse {
        messages: vec![queued_message(), queued_message()].into(),
        has_more: 1,
    };

    let mut fields = vec![f(
        "uint24 messages byte length = 2 x 27 = 54 = 0x000036",
        3,
        [0x00, 0x00, 0x36],
    )];
    fields.extend(queued_message_fields());
    fields.extend(queued_message_fields());
    fields.push(f("uint8 has_more = 1", 1, [0x01]));

    let encoded = response.encode_canonical().unwrap();
    assert_eq!(encoded.len(), 3 + 54 + 1);
    assert_wire("ReadResponse", &encoded, &fields);

    // An empty READ response is the three-byte zero prefix and the flag.
    assert_eq!(
        ReadResponse {
            messages: Vec::new().into(),
            has_more: 0,
        }
        .encode_canonical()
        .unwrap(),
        vec![0x00, 0x00, 0x00, 0x00]
    );
}

#[test]
fn ack_request_and_response_are_bare_indices() {
    // WIRE.md:759-766:
    //   struct { uint64 up_to_index; } AckRequest;
    //   struct { uint64 next_index; uint64 pending; } AckResponse;
    assert_encodes(
        "AckRequest",
        &AckRequest { up_to_index: U64_A },
        &[f("uint64 up_to_index = 0x0102030405060708", 8, U64_A_BE)],
    );
    assert_encodes(
        "AckResponse",
        &AckResponse {
            next_index: U64_A,
            pending: U64_B,
        },
        &[
            f("uint64 next_index = 0x0102030405060708", 8, U64_A_BE),
            f("uint64 pending = 0x1112131415161718", 8, U64_B_BE),
        ],
    );
}

// ---------------------------------------------------------------------------
// §6.3 — commands signed by the send-side queue key
// ---------------------------------------------------------------------------

#[test]
fn bind_send_request_is_one_bare_key() {
    // WIRE.md:786-788: `struct { opaque send_key[32]; } BindSendRequest;`
    // The response is empty **by rule** (§6.3), which is the zero-length body
    // pinned in the response-frame vector above.
    assert_encodes(
        "BindSendRequest",
        &BindSendRequest {
            send_key: PublicKey::new([0xa1; 32]),
        },
        &[f("opaque send_key[32]", 32, fill(0xa1, 32))],
    );
}

#[test]
fn append_request_is_a_three_byte_length_prefix_then_the_payload() {
    // WIRE.md:798-800: `struct { opaque payload<0..2^24-1>; } AppendRequest;`
    // This is where `APPEND_BODY` comes from, and the transcript's `body_hash`
    // known answer is taken over exactly these 11 bytes.
    let encoded = AppendRequest { payload: payload() }
        .encode_canonical()
        .unwrap();
    assert_wire(
        "AppendRequest",
        &encoded,
        &[
            f("uint24 payload length = 8", 3, LEN24_OF_8),
            f("payload bytes", 8, fill(PAYLOAD_FILL, 8)),
        ],
    );
    assert_eq!(encoded, APPEND_BODY.to_vec());
}

// ---------------------------------------------------------------------------
// §6.4 — push bodies
// ---------------------------------------------------------------------------

#[test]
fn push_event_codes_and_bodies_are_the_table_in_section_6_4() {
    // WIRE.md:857-861: MSG 0x0080, QUEUE_EVENT 0x0081, NOTICE 0x0082.
    assert_eq!(PushEvent::Msg.code(), 0x0080);
    assert_eq!(PushEvent::QueueEvent.code(), 0x0081);
    assert_eq!(PushEvent::Notice.code(), 0x0082);

    // `MSG`: `opaque recv_addr[32]; QueuedMessage msg;`
    let mut msg_fields = vec![f("opaque recv_addr[32]", 32, fill(0xa1, 32))];
    msg_fields.extend(queued_message_fields());
    assert_encodes(
        "MsgPush",
        &MsgPush {
            recv_addr: QueueAddress::new([0xa1; 32]),
            msg: queued_message(),
        },
        &msg_fields,
    );

    // `QUEUE_EVENT`: `opaque recv_addr[32]; uint8 reason;`
    // 1 = deleted, 2 = idle-expired, 3 = messages TTL-expired, 4 = quota.
    assert_encodes(
        "QueueEventPush",
        &QueueEventPush {
            recv_addr: QueueAddress::new([0xa1; 32]),
            reason: 2,
        },
        &[
            f("opaque recv_addr[32]", 32, fill(0xa1, 32)),
            f("uint8 reason = 2 (idle-expired)", 1, [0x02]),
        ],
    );

    // `NOTICE`: `uint8 kind; uint64 at_ms;` — the byte comes first.
    assert_encodes(
        "NoticePush",
        &NoticePush {
            kind: 3,
            at_ms: U64_A,
        },
        &[
            f("uint8 kind = 3 (capability document changed)", 1, [0x03]),
            f("uint64 at_ms = 0x0102030405060708", 8, U64_A_BE),
        ],
    );
}

// ---------------------------------------------------------------------------
// §12.2 — contact queues
// ---------------------------------------------------------------------------

#[test]
fn create_contact_queue_request_has_no_flags_field() {
    // WIRE.md:1408-1413:
    //
    // ```text
    // struct {
    //     opaque    recv_key[32];
    //     uint32    req_message_ttl_seconds;
    //     uint32    req_idle_ttl_seconds;
    //     PowStamp  stamp;
    // } CreateContactQueueRequest;
    // ```
    //
    // Note against `CreateQueueRequest`: no `flags`. Widths: 32 + 4 + 4 + 56 = 96.
    assert_encodes(
        "CreateContactQueueRequest",
        &CreateContactQueueRequest {
            recv_key: PublicKey::new([0xa1; 32]),
            req_message_ttl_seconds: 604_800,
            req_idle_ttl_seconds: 7_776_000,
            stamp: PowStamp {
                challenge: Challenge::new([0xb2; 32]),
                salt: Salt::new([0xc3; 16]),
                counter: U64_A,
            },
        },
        &[
            f("opaque recv_key[32]", 32, fill(0xa1, 32)),
            f(
                "uint32 req_message_ttl_seconds = 604800 = 0x00093a80",
                4,
                [0x00, 0x09, 0x3a, 0x80],
            ),
            f(
                "uint32 req_idle_ttl_seconds = 7776000 = 0x0076a700",
                4,
                [0x00, 0x76, 0xa7, 0x00],
            ),
            f("PowStamp.challenge[32]", 32, fill(0xb2, 32)),
            f("PowStamp.salt[16]", 16, fill(0xc3, 16)),
            f("PowStamp.counter = 0x0102030405060708", 8, U64_A_BE),
        ],
    );
}

#[test]
fn create_contact_queue_response_puts_recv_addr_before_contact_addr() {
    // WIRE.md:1415-1423:
    //
    // ```text
    // struct {
    //     opaque recv_addr[32];
    //     opaque contact_addr[32];      /* the published address; never bindable */
    //     uint32 message_ttl_seconds;
    //     uint32 idle_ttl_seconds;
    //     uint32 max_pending;           /* granted cap */
    //     uint64 max_bytes;             /* granted cap */
    // } CreateContactQueueResponse;
    // ```
    //
    // `contact_addr` is *published* in a directory entry and `recv_addr` is
    // not, so reading them in the wrong order publishes the read capability.
    // Widths: 32 + 32 + 4 + 4 + 4 + 8 = 84.
    // §12.3 defaults: contact_max_pending 64 = 0x00000040,
    //                 contact_max_bytes 256 KiB = 262 144 = 0x0000000000040000.
    assert_encodes(
        "CreateContactQueueResponse",
        &CreateContactQueueResponse {
            recv_addr: QueueAddress::new([0xa1; 32]),
            contact_addr: QueueAddress::new([0xb2; 32]),
            message_ttl_seconds: 604_800,
            idle_ttl_seconds: 7_776_000,
            max_pending: 64,
            max_bytes: 262_144,
        },
        &[
            f("opaque recv_addr[32]", 32, fill(0xa1, 32)),
            f("opaque contact_addr[32]", 32, fill(0xb2, 32)),
            f(
                "uint32 message_ttl_seconds = 604800 = 0x00093a80",
                4,
                [0x00, 0x09, 0x3a, 0x80],
            ),
            f(
                "uint32 idle_ttl_seconds = 7776000 = 0x0076a700",
                4,
                [0x00, 0x76, 0xa7, 0x00],
            ),
            f(
                "uint32 max_pending = 64 = 0x00000040",
                4,
                [0x00, 0x00, 0x00, 0x40],
            ),
            f(
                "uint64 max_bytes = 262144 = 0x0000000000040000",
                8,
                [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00],
            ),
        ],
    );
}

#[test]
fn contact_append_request_is_address_payload_stamp() {
    // WIRE.md:1425-1429:
    //
    // ```text
    // struct {
    //     opaque    contact_addr[32];
    //     opaque    payload<0..2^24-1>;
    //     PowStamp  stamp;
    // } ContactAppendRequest;
    // ```
    //
    // The stamp comes *after* a variable-length field, so its offset moves with
    // the payload — which is exactly the shape a hand-rolled parser gets wrong.
    // Widths: 32 + (3 + 8) + 56 = 99.
    assert_encodes(
        "ContactAppendRequest",
        &ContactAppendRequest {
            contact_addr: QueueAddress::new([0xa1; 32]),
            payload: payload(),
            stamp: PowStamp {
                challenge: Challenge::new([0xb2; 32]),
                salt: Salt::new([0xc3; 16]),
                counter: U64_A,
            },
        },
        &[
            f("opaque contact_addr[32]", 32, fill(0xa1, 32)),
            f("uint24 payload length = 8", 3, LEN24_OF_8),
            f("payload bytes", 8, fill(PAYLOAD_FILL, 8)),
            f("PowStamp.challenge[32]", 32, fill(0xb2, 32)),
            f("PowStamp.salt[16]", 16, fill(0xc3, 16)),
            f("PowStamp.counter = 0x0102030405060708", 8, U64_A_BE),
        ],
    );
}

// ---------------------------------------------------------------------------
// §13.1 — proof of work
// ---------------------------------------------------------------------------

#[test]
fn pow_params_and_pow_stamp_encode_as_declared() {
    // WIRE.md:1622-1633:
    //   struct { uint8 algorithm; uint8 difficulty_bits; uint32 challenge_ttl_ms; } PowParams;
    //   struct { opaque challenge[32]; opaque salt[16]; uint64 counter; } PowStamp;
    assert_encodes(
        "PowParams",
        &PowParams {
            algorithm: 1,
            difficulty_bits: 20,
            challenge_ttl_ms: 60_000,
        },
        &[
            f("uint8 algorithm = 1 (blake2b-leading-zero-bits)", 1, [0x01]),
            f("uint8 difficulty_bits = 20 = 0x14", 1, [0x14]),
            f(
                "uint32 challenge_ttl_ms = 60000 = 0x0000ea60",
                4,
                [0x00, 0x00, 0xea, 0x60],
            ),
        ],
    );
    assert_eq!(PowParams::none().encode_canonical().unwrap(), vec![0u8; 6]);

    assert_encodes(
        "PowStamp",
        &PowStamp {
            challenge: Challenge::new([0xa1; 32]),
            salt: Salt::new([0xb2; 16]),
            counter: U64_A,
        },
        &[
            f("opaque challenge[32]", 32, fill(0xa1, 32)),
            f("opaque salt[16]", 16, fill(0xb2, 16)),
            f("uint64 counter = 0x0102030405060708", 8, U64_A_BE),
        ],
    );
    assert_eq!(PowStamp::empty().encode_canonical().unwrap(), vec![0u8; 56]);
}

#[test]
fn the_pow_digest_is_a_known_answer_with_a_big_endian_counter() {
    // WIRE.md:1640-1642: a stamp is valid iff
    // `H("free2z/relay/v1/pow", challenge || salt || counter)` has at least
    // `difficulty_bits` leading zero bits.
    //
    // §1.3 makes `counter` big-endian like every other integer. This is the one
    // number a relay and a client must agree on byte-for-byte: if the two ends
    // disagree about the counter's endianness every stamp fails verification,
    // and nothing but a known answer detects it.
    //
    // `BLAKE2b-256("free2z/relay/v1/pow" || a1 x 32 || b2 x 16 || 01 02 03 04 05 06 07 08)`,
    // computed outside this crate.
    let stamp = PowStamp {
        challenge: Challenge::new([0xa1; 32]),
        salt: Salt::new([0xb2; 16]),
        counter: U64_A,
    };
    assert_eq!(
        stamp.digest().as_bytes(),
        &from_hex("659018a6e5b82a415b23f69f62e2a747c8cc83f402eb3d07924b38a2a8896467")
    );

    // The little-endian reading of the same counter has a different digest —
    // stated so the assertion above is visibly load-bearing rather than
    // incidentally true.
    assert_ne!(
        stamp.digest().as_bytes(),
        &from_hex("6ce45f2d37e3706991237386d55de04bfe5d0fe464bbee9bea3e347d83a9c8d7")
    );
}

// ---------------------------------------------------------------------------
// §11.1 — the capability document
// ---------------------------------------------------------------------------

fn capabilities() -> Capabilities {
    Capabilities {
        protocol_versions: vec![0x0001u16].into(),
        relay_identity_pk: PublicKey::new([0xa1; 32]),
        relay_id: RelayId::new([0xb2; 32]),
        transport_security: 1,
        channel_binding_mode: 0,
        max_frame_bytes: 1_048_576,
        max_inflight: 32,
        ws_ping_interval_seconds: 25,
        handshake_timeout_ms: 10_000,
        clock_skew_ms: 120_000,
        antireplay_window_ms: 240_000,
        antireplay_persistence: 1,
        padding_sizes: vec![1024u32, 4096].into(),
        max_chunk_bytes: 65_536,
        min_message_ttl_seconds: 3_600,
        max_message_ttl_seconds: 2_592_000,
        default_message_ttl_seconds: 604_800,
        min_idle_ttl_seconds: 86_400,
        max_idle_ttl_seconds: 31_536_000,
        default_idle_ttl_seconds: 7_776_000,
        max_queue_messages: 10_000,
        max_queue_bytes: U64_A,
        queue_creation_mode: 1,
        queue_creation_pow: PowParams {
            algorithm: 1,
            difficulty_bits: 20,
            challenge_ttl_ms: 60_000,
        },
        contact_queues_enabled: 1,
        contact_max_pending: 64,
        contact_max_bytes: 262_144,
        contact_append_pow: PowParams {
            algorithm: 1,
            difficulty_bits: 22,
            challenge_ttl_ms: 30_000,
        },
        per_source_limits: 1,
        durability_mode: 2,
        operator_name: ShortBytes::new(b"Example Relay Co".to_vec()).unwrap(),
        operator_contact: ShortBytes::new(b"ops@example.org".to_vec()).unwrap(),
        operator_abuse_contact: ShortBytes::new(b"abuse@example.org".to_vec()).unwrap(),
        operator_jurisdiction: ShortBytes::new(b"IS".to_vec()).unwrap(),
        operator_policy_url: ShortBytes::new(b"https://example.org/policy".to_vec()).unwrap(),
        source_repo_url: ShortBytes::new(b"https://example.org/relay".to_vec()).unwrap(),
        source_commit: ShortBytes::new(b"a1162ca".to_vec()).unwrap(),
        build_digest: ShortBytes::new(b"sha256:00".to_vec()).unwrap(),
        published_at_ms: U64_B,
    }
}

/// The frozen v1 fields of `Capabilities`, in the order §11.1 prints them.
fn capabilities_fields() -> Vec<Field> {
    vec![
        // uint16 protocol_versions<1..255> — a one-byte *byte* length, then the
        // uint16 elements. One version is two bytes, so the prefix is 0x02.
        f("uint8 protocol_versions byte length = 2", 1, [0x02]),
        f("uint16 protocol_versions[0] = 1", 2, [0x00, 0x01]),
        // identity
        f("opaque relay_identity_pk[32]", 32, fill(0xa1, 32)),
        f("opaque relay_id[32]", 32, fill(0xb2, 32)),
        // transport
        f("uint8 transport_security = 1 (tls)", 1, [0x01]),
        f("uint8 channel_binding_mode = 0 (none)", 1, [0x00]),
        f(
            "uint32 max_frame_bytes = 1048576 = 0x00100000",
            4,
            [0x00, 0x10, 0x00, 0x00],
        ),
        f("uint16 max_inflight = 32 = 0x0020", 2, [0x00, 0x20]),
        f(
            "uint16 ws_ping_interval_seconds = 25 = 0x0019",
            2,
            [0x00, 0x19],
        ),
        f(
            "uint32 handshake_timeout_ms = 10000 = 0x00002710",
            4,
            [0x00, 0x00, 0x27, 0x10],
        ),
        // anti-replay
        f(
            "uint32 clock_skew_ms = 120000 = 0x0001d4c0",
            4,
            [0x00, 0x01, 0xd4, 0xc0],
        ),
        f(
            "uint32 antireplay_window_ms = 240000 = 0x0003a980",
            4,
            [0x00, 0x03, 0xa9, 0x80],
        ),
        f("uint8 antireplay_persistence = 1 (durable)", 1, [0x01]),
        // padding — uint32 padding_sizes<1..2^16-1>: a two-byte *byte* length,
        // then the uint32 elements. Two entries are eight bytes: 0x0008.
        f("uint16 padding_sizes byte length = 8", 2, [0x00, 0x08]),
        f(
            "uint32 padding_sizes[0] = 1024 = 0x00000400",
            4,
            [0x00, 0x00, 0x04, 0x00],
        ),
        f(
            "uint32 padding_sizes[1] = 4096 = 0x00001000",
            4,
            [0x00, 0x00, 0x10, 0x00],
        ),
        f(
            "uint32 max_chunk_bytes = 65536 = 0x00010000",
            4,
            [0x00, 0x01, 0x00, 0x00],
        ),
        // queues
        f(
            "uint32 min_message_ttl_seconds = 3600 = 0x00000e10",
            4,
            [0x00, 0x00, 0x0e, 0x10],
        ),
        f(
            "uint32 max_message_ttl_seconds = 2592000 = 0x00278d00",
            4,
            [0x00, 0x27, 0x8d, 0x00],
        ),
        f(
            "uint32 default_message_ttl_seconds = 604800 = 0x00093a80",
            4,
            [0x00, 0x09, 0x3a, 0x80],
        ),
        f(
            "uint32 min_idle_ttl_seconds = 86400 = 0x00015180",
            4,
            [0x00, 0x01, 0x51, 0x80],
        ),
        f(
            "uint32 max_idle_ttl_seconds = 31536000 = 0x01e13380",
            4,
            [0x01, 0xe1, 0x33, 0x80],
        ),
        f(
            "uint32 default_idle_ttl_seconds = 7776000 = 0x0076a700",
            4,
            [0x00, 0x76, 0xa7, 0x00],
        ),
        f(
            "uint32 max_queue_messages = 10000 = 0x00002710",
            4,
            [0x00, 0x00, 0x27, 0x10],
        ),
        f("uint64 max_queue_bytes = 0x0102030405060708", 8, U64_A_BE),
        // anti-abuse
        f("uint8 queue_creation_mode = 1 (pow)", 1, [0x01]),
        f("PowParams queue_creation_pow.algorithm = 1", 1, [0x01]),
        f(
            "PowParams queue_creation_pow.difficulty_bits = 20 = 0x14",
            1,
            [0x14],
        ),
        f(
            "PowParams queue_creation_pow.challenge_ttl_ms = 60000 = 0x0000ea60",
            4,
            [0x00, 0x00, 0xea, 0x60],
        ),
        f("uint8 contact_queues_enabled = 1", 1, [0x01]),
        f(
            "uint32 contact_max_pending = 64 = 0x00000040",
            4,
            [0x00, 0x00, 0x00, 0x40],
        ),
        f(
            "uint64 contact_max_bytes = 262144 = 0x0000000000040000",
            8,
            [0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00],
        ),
        f("PowParams contact_append_pow.algorithm = 1", 1, [0x01]),
        f(
            "PowParams contact_append_pow.difficulty_bits = 22 = 0x16",
            1,
            [0x16],
        ),
        f(
            "PowParams contact_append_pow.challenge_ttl_ms = 30000 = 0x00007530",
            4,
            [0x00, 0x00, 0x75, 0x30],
        ),
        f("uint8 per_source_limits = 1 (on)", 1, [0x01]),
        f("uint8 durability_mode = 2 (fsync-per-append)", 1, [0x02]),
        // operator — every one is `opaque x<0..255>`: a one-byte length, then
        // the ASCII.
        f("uint8 operator_name length = 16", 1, [0x10]),
        f("\"Example Relay Co\"", 16, b"Example Relay Co"),
        f("uint8 operator_contact length = 15", 1, [0x0f]),
        f("\"ops@example.org\"", 15, b"ops@example.org"),
        f("uint8 operator_abuse_contact length = 17", 1, [0x11]),
        f("\"abuse@example.org\"", 17, b"abuse@example.org"),
        f("uint8 operator_jurisdiction length = 2", 1, [0x02]),
        f("\"IS\"", 2, b"IS"),
        f("uint8 operator_policy_url length = 26", 1, [0x1a]),
        f(
            "\"https://example.org/policy\"",
            26,
            b"https://example.org/policy",
        ),
        // provenance
        f("uint8 source_repo_url length = 25", 1, [0x19]),
        f(
            "\"https://example.org/relay\"",
            25,
            b"https://example.org/relay",
        ),
        f("uint8 source_commit length = 7", 1, [0x07]),
        f("\"a1162ca\"", 7, b"a1162ca"),
        f("uint8 build_digest length = 9", 1, [0x09]),
        f("\"sha256:00\"", 9, b"sha256:00"),
        f("uint64 published_at_ms = 0x1112131415161718", 8, U64_B_BE),
    ]
}

#[test]
fn the_capability_document_encodes_field_for_field_as_section_11_1_declares() {
    // WIRE.md:1270-1330. This is the document a client parses to decide whether
    // to use a relay at all and a human reads at
    // `/.well-known/free2z-relay/v1/capabilities`; §11.2 requires the two
    // representations to carry the same `capabilities_digest`, so the byte
    // layout is the thing both sides have to agree on.
    assert_encodes("Capabilities", &capabilities(), &capabilities_fields());
}

#[test]
fn signed_capabilities_is_the_document_then_a_signature() {
    // WIRE.md:1332-1335:
    //   struct { Capabilities capabilities; opaque signature[64]; } SignedCapabilities;
    let mut fields = capabilities_fields();
    fields.push(f("opaque signature[64]", 64, fill(0xd4, 64)));
    assert_encodes(
        "SignedCapabilities",
        &SignedCapabilities {
            capabilities: capabilities(),
            signature: Signature::new([0xd4; 64]),
        },
        &fields,
    );
}

// ---------------------------------------------------------------------------
// §6, §10 — the code tables, as the numbers they are on the wire
// ---------------------------------------------------------------------------

#[test]
fn every_command_code_is_the_uint16_the_table_assigns() {
    // WIRE.md:598-613. Codes are `uint16` and are **stable forever**, so they
    // are pinned as the two bytes they occupy rather than as integers.
    let expected: [(Command, [u8; 2]); 18] = [
        (Command::Hello, [0x00, 0x01]),
        (Command::GetCapabilities, [0x00, 0x02]),
        (Command::GetChallenge, [0x00, 0x03]),
        (Command::Ping, [0x00, 0x04]),
        (Command::CreateQueue, [0x00, 0x10]),
        (Command::Subscribe, [0x00, 0x11]),
        (Command::Unsubscribe, [0x00, 0x12]),
        (Command::Read, [0x00, 0x13]),
        (Command::Ack, [0x00, 0x14]),
        (Command::DeleteQueue, [0x00, 0x15]),
        (Command::BindSend, [0x00, 0x20]),
        (Command::Append, [0x00, 0x21]),
        (Command::CreateContactQueue, [0x00, 0x30]),
        (Command::ContactAppend, [0x00, 0x31]),
        (Command::PublishKeyPackages, [0x00, 0x32]),
        (Command::ClaimKeyPackage, [0x00, 0x33]),
        (Command::GetKeyPackagePolicy, [0x00, 0x34]),
        (Command::GetClaimKeyPackageChallenge, [0x00, 0x35]),
    ];
    assert_eq!(expected.len(), Command::ALL.len());
    for (command, bytes) in expected {
        let request = Request::new(command.code(), CommandAuth::Unsigned, Vec::new()).unwrap();
        let encoded = request.encode_canonical().unwrap();
        assert_eq!(
            &encoded[..2],
            &bytes,
            "{command:?} does not encode as the table's code"
        );
    }
}

#[test]
fn every_error_code_is_the_uint16_the_table_assigns() {
    // WIRE.md:1201-1223. A code's meaning is never changed and a retired code
    // is never reused, so each one is pinned as the status field's two bytes.
    use f2z_codec::ErrorCode;
    let expected: [(ErrorCode, [u8; 2]); 21] = [
        (ErrorCode::Malformed, [0x00, 0x01]),
        (ErrorCode::UnsupportedVersion, [0x00, 0x02]),
        (ErrorCode::FrameType, [0x00, 0x03]),
        (ErrorCode::TooManyInflight, [0x00, 0x04]),
        (ErrorCode::UnknownCommand, [0x00, 0x05]),
        (ErrorCode::BadSignature, [0x00, 0x06]),
        (ErrorCode::StaleTimestamp, [0x00, 0x07]),
        (ErrorCode::Replay, [0x00, 0x08]),
        (ErrorCode::ChannelBinding, [0x00, 0x09]),
        (ErrorCode::NoAccess, [0x00, 0x0a]),
        (ErrorCode::AlreadyBound, [0x00, 0x0b]),
        (ErrorCode::BadSize, [0x00, 0x0c]),
        (ErrorCode::AckTooHigh, [0x00, 0x0d]),
        (ErrorCode::Quota, [0x00, 0x0e]),
        (ErrorCode::Unavailable, [0x00, 0x0f]),
        (ErrorCode::PowRequired, [0x00, 0x10]),
        (ErrorCode::PowInvalid, [0x00, 0x11]),
        (ErrorCode::Backpressure, [0x00, 0x12]),
        (ErrorCode::RateLimited, [0x00, 0x13]),
        (ErrorCode::NotPermitted, [0x00, 0x14]),
        (ErrorCode::Internal, [0x00, 0x15]),
    ];
    for (code, bytes) in expected {
        let encoded = Response::error(code).encode_canonical().unwrap();
        assert_eq!(
            &encoded[..2],
            &bytes,
            "{code:?} does not encode as the table's code"
        );
        // §4.1: an error response carries a code and nothing else.
        assert_eq!(&encoded[2..], &[0x00, 0x00, 0x00]);
    }
}
