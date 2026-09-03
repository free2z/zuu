//! `--log-level trace` must never become a ciphertext archive, and this layer
//! adds the two values whose disclosure is worst: a signing key, and a decoded
//! command that has been verified and is about to be acted on.
//!
//! The checks are the ones `f2z-codec`'s own redaction test arrived at, applied
//! to this crate's types, and they are deliberately paranoid: absence of the
//! obvious lowercase hex is not enough. Base16 in either case, base64url, a
//! **decimal byte list** and any long run of hex-looking characters are all
//! checked.
//!
//! The decimal case is the one that catches real leaks. `tls_codec`'s own byte
//! vectors derive `Debug` and print `TlsByteVecU24 { vec: [222, 222, 222, …] }`
//! — a complete dump containing no hex at all, so a hex-only assertion passes
//! while everything leaks. Every structure below is checked against all four
//! encodings for exactly that reason.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::commands::{AppendRequest, ContactAppendRequest, HelloRequest};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::PowStamp;
use f2z_codec::types::{Challenge, ChannelBinding, Nonce, Payload, PublicKey, QueueAddress};
use f2z_relay_proto::capabilities::{self, ChannelBindingMode, ClientPolicy, TransportSecurity};
use f2z_relay_proto::command::{CommandVerifier, RelayCommand, SignedCommand, ops};
use f2z_relay_proto::hello::{RelayAnnouncement, hello_response, verify_hello_response};
use f2z_relay_proto::key::SigningKey;
use f2z_relay_proto::queue::{QueueKind, QueueState};
use f2z_relay_proto::replay::{ReplayKey, SeenSet, TimestampWindow};

/// A byte pattern that is unmistakable in any encoding a leak might use.
const SECRET: u8 = 0xde;

const NOW: u64 = 1_800_000_000_000;

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// `[222, 222, 222, …]` — a derived `Debug` on a byte slice.
fn decimal_list(bytes: &[u8]) -> String {
    let joined: Vec<String> = bytes.iter().map(|byte| byte.to_string()).collect();
    format!("[{}]", joined.join(", "))
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut buffer = [0u8; 3];
        buffer[..chunk.len()].copy_from_slice(chunk);
        let value =
            (u32::from(buffer[0]) << 16) | (u32::from(buffer[1]) << 8) | u32::from(buffer[2]);
        let symbols = match chunk.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };
        for index in 0..symbols {
            let shift = 18 - 6 * index;
            let symbol = ((value >> shift) & 0x3f) as usize;
            out.push(ALPHABET[symbol] as char);
        }
    }
    out
}

/// The longest run of characters that could be a hex dump.
///
/// A run of pure decimal digits does not count: these types legitimately print
/// millisecond timestamps and indices, and treating `1800000000000` as a hex
/// dump would make the check fire on correct output instead of on a leak.
fn longest_hex_run(text: &str) -> usize {
    let mut longest = 0usize;
    let mut current = 0usize;
    let mut has_alpha = false;
    for character in text.chars() {
        if character.is_ascii_hexdigit() {
            current += 1;
            has_alpha |= character.is_ascii_alphabetic();
            if has_alpha {
                longest = longest.max(current);
            }
        } else {
            current = 0;
            has_alpha = false;
        }
    }
    longest
}

fn assert_no_leak(label: &str, rendered: &str, secret: &[u8]) {
    assert!(
        !rendered.contains(&lower_hex(secret)),
        "{label} leaked lowercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&upper_hex(secret)),
        "{label} leaked uppercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&base64url(secret)),
        "{label} leaked base64url: {rendered}"
    );
    assert!(
        !rendered.contains(&decimal_list(secret)),
        "{label} leaked a decimal byte list: {rendered}"
    );
    // A prefix of a decimal dump convicts on its own: no correct output of this
    // crate ever prints four consecutive byte values.
    assert!(
        !rendered.contains(&decimal_list(&secret[..secret.len().min(4)])),
        "{label} leaked the start of a decimal byte list: {rendered}"
    );
    assert!(
        longest_hex_run(rendered) < 16,
        "{label} contains a {}-character hex-looking run: {rendered}",
        longest_hex_run(rendered)
    );
}

fn signing_key() -> SigningKey {
    SigningKey::from_seed(&[SECRET; 32])
}

fn verifier(relay_id: f2z_codec::types::RelayId) -> CommandVerifier {
    CommandVerifier::new(
        f2z_codec::transcript::TranscriptBuilder::new(
            f2z_relay_proto::PROTOCOL_VERSION,
            relay_id,
            ChannelBinding::new([SECRET; 32]),
        ),
        TimestampWindow::default(),
        SeenSet::new(240_000, 64),
        PaddingBuckets::default(),
    )
}

#[test]
fn a_signing_key_never_renders_anything_about_itself() {
    let key = signing_key();
    let rendered = format!("{key:?}");
    assert_eq!(rendered, "SigningKey(<redacted>)");
    // The seed, and the public half derived from it, are both absent.
    assert_no_leak("SigningKey", &rendered, &[SECRET; 32]);
    assert_no_leak("SigningKey", &rendered, key.public_key().as_bytes());

    let public = key.verifying_key();
    let rendered = format!("{public:?}");
    assert_no_leak("VerifyingKey", &rendered, key.public_key().as_bytes());
}

#[test]
fn a_seen_set_does_not_render_the_keys_and_nonces_it_holds() {
    let mut seen = SeenSet::new(240_000, 8);
    let key = ReplayKey::new(PublicKey::new([SECRET; 32]), Nonce::new([SECRET; 16]));
    seen.commit(NOW, key).unwrap();

    assert_no_leak("ReplayKey", &format!("{key:?}"), &[SECRET; 32]);
    assert_no_leak("ReplayKey", &format!("{key:?}"), &[SECRET; 16]);
    // The set itself renders its entries; a derived `Debug` on the map would
    // print every key it holds, which is a per-command log of who spoke.
    assert_no_leak("SeenSet", &format!("{seen:?}"), &[SECRET; 32]);
    assert_no_leak("SeenSet", &format!("{seen:?}"), &[SECRET; 16]);
}

#[test]
fn a_signed_command_does_not_render_its_payload_or_its_authenticator() {
    let key = signing_key();
    let relay_id = f2z_codec::hash::relay_id(&key.public_key());
    let payload = vec![SECRET; 1024];
    let signed = SignedCommand::<ops::Append>::create(
        &f2z_codec::transcript::TranscriptBuilder::new(
            f2z_relay_proto::PROTOCOL_VERSION,
            relay_id,
            ChannelBinding::new([SECRET; 32]),
        ),
        1,
        QueueAddress::new([SECRET; 32]),
        NOW,
        Nonce::new([SECRET; 16]),
        &key,
        &AppendRequest {
            payload: Payload::new(payload.clone()).unwrap(),
        },
    )
    .unwrap();

    let rendered = format!("{signed:?}");
    assert_no_leak("SignedCommand payload", &rendered, &payload);
    assert_no_leak("SignedCommand address", &rendered, &[SECRET; 32]);
    assert_no_leak("SignedCommand nonce", &rendered, &[SECRET; 16]);
    assert_no_leak(
        "SignedCommand signature",
        &rendered,
        signed.auth().signature.as_bytes(),
    );
    assert_no_leak("SignedCommand body", &rendered, signed.body());
}

#[test]
fn a_verified_command_does_not_render_what_it_carries() {
    let key = signing_key();
    let relay_id = f2z_codec::hash::relay_id(&key.public_key());
    let payload = vec![SECRET; 4096];
    let signed = SignedCommand::<ops::Append>::create(
        &f2z_codec::transcript::TranscriptBuilder::new(
            f2z_relay_proto::PROTOCOL_VERSION,
            relay_id,
            ChannelBinding::new([SECRET; 32]),
        ),
        1,
        QueueAddress::new([SECRET; 32]),
        NOW,
        Nonce::new([SECRET; 16]),
        &key,
        &AppendRequest {
            payload: Payload::new(payload.clone()).unwrap(),
        },
    )
    .unwrap();

    let mut verifier = verifier(relay_id);
    let verified = verifier
        .verify::<ops::Append>(NOW, 1, &signed.request().unwrap())
        .unwrap();
    let rendered = format!("{verified:?}");
    assert_no_leak("Verified payload", &rendered, &payload);
    assert_no_leak("Verified address", &rendered, &[SECRET; 32]);
    assert_no_leak("Verified signer", &rendered, key.public_key().as_bytes());

    // And the verifier itself, which now holds the seen-set entry.
    assert_no_leak("CommandVerifier", &format!("{verifier:?}"), &[SECRET; 32]);
    assert_no_leak("CommandVerifier", &format!("{verifier:?}"), &[SECRET; 16]);
}

#[test]
fn an_unsigned_contact_append_does_not_render_a_strangers_ciphertext() {
    let key = signing_key();
    let relay_id = f2z_codec::hash::relay_id(&key.public_key());
    let payload = vec![SECRET; 1024];
    let request = f2z_codec::frame::Request::new(
        <ops::ContactAppend as RelayCommand>::COMMAND.code(),
        f2z_codec::frame::CommandAuth::Unsigned,
        f2z_codec::canonical::Canonical::encode_canonical(&ContactAppendRequest {
            contact_addr: QueueAddress::new([SECRET; 32]),
            payload: Payload::new(payload.clone()).unwrap(),
            stamp: PowStamp {
                challenge: Challenge::new([SECRET; 32]),
                salt: f2z_codec::types::Salt::new([SECRET; 16]),
                counter: 7,
            },
        })
        .unwrap(),
    )
    .unwrap();

    let verified = verifier(relay_id)
        .accept_unsigned::<ops::ContactAppend>(&request)
        .unwrap();
    let rendered = format!("{verified:?}");
    assert_no_leak("ContactAppend payload", &rendered, &payload);
    assert_no_leak("ContactAppend challenge", &rendered, &[SECRET; 32]);
}

#[test]
fn queue_state_does_not_render_the_keys_that_authorize_it() {
    let mut queue = QueueState::create(QueueKind::Standard, PublicKey::new([SECRET; 32]));
    queue.bind_send(&PublicKey::new([SECRET; 32])).unwrap();
    queue.append().unwrap();
    assert_no_leak("QueueState", &format!("{queue:?}"), &[SECRET; 32]);
}

#[test]
fn a_relay_session_does_not_render_its_binding_or_its_identity() {
    let identity = signing_key();
    let binding = ChannelBinding::new([SECRET; 32]);
    let offer = HelloRequest {
        min_version: 1,
        max_version: 1,
        client_nonce: Challenge::new([SECRET; 32]),
    };
    let published = capabilities::defaults(&identity.public_key(), NOW).unwrap();
    let response = hello_response(
        &identity,
        &RelayAnnouncement {
            protocol_version: 1,
            relay_time_ms: NOW,
            channel_binding_mode: ChannelBindingMode::TlsExporter,
            transport_security: TransportSecurity::Tls,
            capabilities_digest: capabilities::digest(&published).unwrap(),
        },
        &binding,
        &offer.client_nonce,
    )
    .unwrap();
    let session =
        verify_hello_response(&response, &offer, &binding, None, &ClientPolicy::default()).unwrap();

    let rendered = format!("{session:?}");
    assert_no_leak("RelaySession binding", &rendered, &[SECRET; 32]);
    assert_no_leak(
        "RelaySession identity",
        &rendered,
        identity.public_key().as_bytes(),
    );
    assert_no_leak(
        "RelaySession relay_id",
        &rendered,
        session.relay_id().as_bytes(),
    );

    // The `HELLO` frame the relay sent is a `f2z-codec` structure, but it is
    // this crate that builds it, so it is checked here too.
    assert_no_leak(
        "HelloResponse proof",
        &format!("{response:?}"),
        response.relay_proof.as_bytes(),
    );
}

#[test]
fn the_capability_document_still_publishes_what_it_exists_to_publish() {
    // The mirror image of every other test in this file. §11.1's operator block
    // is the point of the document — a redaction that swallowed
    // `operator_jurisdiction` would defeat the reason it is published at all.
    let identity = signing_key();
    let mut capabilities = capabilities::defaults(&identity.public_key(), NOW).unwrap();
    capabilities.operator_jurisdiction =
        f2z_codec::types::ShortBytes::new(&b"Iceland"[..]).unwrap();
    let rendered = format!("{capabilities:?}");
    assert!(
        rendered.contains("Iceland"),
        "the operator block must remain readable: {rendered}"
    );
    assert_no_leak(
        "Capabilities identity",
        &rendered,
        identity.public_key().as_bytes(),
    );
}
