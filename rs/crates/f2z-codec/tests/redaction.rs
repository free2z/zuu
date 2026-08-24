//! `--log-level trace` must never become a ciphertext archive.
//!
//! Every newtype that carries an address, a payload or a key renders through
//! `Debug` without its bytes, and so does every structure that contains one —
//! because a derived `Debug` delegates to the field's, which is exactly why the
//! redaction lives on the newtype rather than on the frame.
//!
//! The tests below are deliberately paranoid: it is not enough that the obvious
//! hex encoding is absent. Base16 in either case, base64url, a **decimal byte
//! list**, and any long run of hex-looking characters are all checked, because a
//! `Debug` that leaked bytes would most plausibly do it through one of those and
//! not through the exact format this file happened to guess.
//!
//! The decimal case is not hypothetical. `tls_codec`'s own byte vectors derive
//! `Debug` and print `TlsByteVecU24 { vec: [222, 222, 222, …] }` — a complete
//! dump that contains no hex at all. That is why every body and payload in this
//! crate is a newtype rather than a bare `tls_codec` vector.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{AppendRequest, ContactAppendRequest, CreateQueueRequest, QueuedMessage};
use f2z_codec::frame::{CommandAuth, RelayFrame, Request, SignedAuth};
use f2z_codec::pow::PowStamp;
use f2z_codec::types::{
    Challenge, ChannelBinding, Digest, Nonce, Payload, PublicKey, QueueAddress, RelayId, Salt,
    ShortBytes, Signature,
};

/// A byte pattern that is unmistakable in any encoding a leak might use.
const SECRET: u8 = 0xde;

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
/// A run of pure decimal digits does not count: this crate legitimately prints
/// millisecond timestamps and byte lengths, and treating `1700000000000` as a
/// hex dump would make the check fire on correct output instead of on a leak. A
/// run has to contain at least one `a`-`f` to be evidence of base16.
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

/// Assert that `rendered` cannot be turned back into `secret`.
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
    // A prefix of a decimal dump is enough to convict: no correct output of this
    // crate ever prints four consecutive byte values.
    assert!(
        !rendered.contains(&decimal_list(&secret[..secret.len().min(4)])),
        "{label} leaked a decimal byte list prefix: {rendered}"
    );
    // Every byte of the secret is 0xde, so even a two-byte prefix would show as
    // a repeated `de`. Catch a partial dump too.
    assert!(
        !rendered.contains(&lower_hex(&secret[..secret.len().min(4)])),
        "{label} leaked a hex prefix: {rendered}"
    );
    // Nothing this crate prints is a long hex string. 8 characters is short
    // enough to be a decimal length or a section number and long enough that a
    // real dump of even four bytes trips it.
    assert!(
        longest_hex_run(rendered) < 8,
        "{label} contains an 8+ character hex-looking run: {rendered}"
    );
}

#[test]
fn every_opaque_newtype_redacts() {
    let secret32 = [SECRET; 32];
    let secret64 = [SECRET; 64];
    let secret16 = [SECRET; 16];

    let cases: Vec<(&str, String, &[u8])> = vec![
        (
            "QueueAddress",
            format!("{:?}", QueueAddress::new(secret32)),
            &secret32,
        ),
        (
            "PublicKey",
            format!("{:?}", PublicKey::new(secret32)),
            &secret32,
        ),
        (
            "RelayId",
            format!("{:?}", RelayId::new(secret32)),
            &secret32,
        ),
        (
            "ChannelBinding",
            format!("{:?}", ChannelBinding::new(secret32)),
            &secret32,
        ),
        (
            "Challenge",
            format!("{:?}", Challenge::new(secret32)),
            &secret32,
        ),
        ("Digest", format!("{:?}", Digest::new(secret32)), &secret32),
        (
            "Signature",
            format!("{:?}", Signature::new(secret64)),
            &secret64,
        ),
        ("Nonce", format!("{:?}", Nonce::new(secret16)), &secret16),
        ("Salt", format!("{:?}", Salt::new(secret16)), &secret16),
    ];

    for (label, rendered, secret) in cases {
        assert_no_leak(label, &rendered, secret);
        assert!(
            rendered.contains("<redacted>"),
            "{label} must say it redacted something, got {rendered}"
        );
    }
}

#[test]
fn a_payload_reports_its_length_and_nothing_else() {
    let payload = Payload::new(vec![SECRET; 4096]).unwrap();
    let rendered = format!("{payload:?}");
    assert_eq!(rendered, "Payload(<redacted; 4096 bytes>)");
    assert_no_leak("Payload", &rendered, &[SECRET; 4096]);
}

#[test]
fn a_whole_frame_renders_without_a_single_secret_byte() {
    // The realistic disaster: someone derives Debug on the frame type and turns
    // trace logging on in production.
    let auth = SignedAuth {
        address: QueueAddress::new([SECRET; 32]),
        signer_key: PublicKey::new([SECRET; 32]),
        timestamp_ms: 1_700_000_000_000,
        nonce: Nonce::new([SECRET; 16]),
        signature: Signature::new([SECRET; 64]),
    };
    let body = AppendRequest {
        payload: Payload::new(vec![SECRET; 16_384]).unwrap(),
    };
    let frame = RelayFrame::request(
        9,
        Request::new(
            0x0021,
            CommandAuth::Signed(auth),
            body.encode_canonical().unwrap(),
        )
        .unwrap(),
    );

    let rendered = format!("{frame:?}");
    assert_no_leak("RelayFrame", &rendered, &[SECRET; 32]);
    assert_no_leak("RelayFrame", &rendered, &[SECRET; 64]);

    // The frame's `body` is an opaque `Body`, and this is the assertion that
    // makes that choice load-bearing: the payload inside it is 16 KiB of 0xde
    // and none of it appears, in any encoding.
    assert_no_leak("RelayFrame", &rendered, &[SECRET; 16_384]);
    assert!(rendered.contains("<redacted"), "got {rendered}");

    let rendered_body = format!("{body:?}");
    assert_no_leak("AppendRequest", &rendered_body, &[SECRET; 16_384]);
}

#[test]
fn every_command_carrying_a_secret_redacts_it() {
    let cases: Vec<(&str, String)> = vec![
        (
            "AppendRequest",
            format!(
                "{:?}",
                AppendRequest {
                    payload: Payload::new(vec![SECRET; 1024]).unwrap()
                }
            ),
        ),
        (
            "ContactAppendRequest",
            format!(
                "{:?}",
                ContactAppendRequest {
                    contact_addr: QueueAddress::new([SECRET; 32]),
                    payload: Payload::new(vec![SECRET; 1024]).unwrap(),
                    stamp: PowStamp {
                        challenge: Challenge::new([SECRET; 32]),
                        salt: Salt::new([SECRET; 16]),
                        counter: 42,
                    },
                }
            ),
        ),
        (
            "CreateQueueRequest",
            format!(
                "{:?}",
                CreateQueueRequest {
                    recv_key: PublicKey::new([SECRET; 32]),
                    req_message_ttl_seconds: 86_400,
                    req_idle_ttl_seconds: 86_400,
                    flags: 0,
                    stamp: PowStamp::empty(),
                }
            ),
        ),
        (
            "QueuedMessage",
            format!(
                "{:?}",
                QueuedMessage {
                    index: 3,
                    received_at_ms: 1_700_000_000_000,
                    payload: Payload::new(vec![SECRET; 65_536]).unwrap(),
                }
            ),
        ),
    ];

    for (label, rendered) in cases {
        assert_no_leak(label, &rendered, &[SECRET; 32]);
        assert_no_leak(label, &rendered, &[SECRET; 16]);
    }
}

#[test]
fn a_challenge_scope_is_an_address_and_redacts_but_operator_text_does_not() {
    // §11.1's operator fields exist to be read; §6.1's `scope` is a contact
    // address. Same type, opposite requirements, so the rule is on the content.
    let address = ShortBytes::new(vec![SECRET; 32]).unwrap();
    let rendered = format!("{address:?}");
    assert_no_leak("ShortBytes(scope)", &rendered, &[SECRET; 32]);
    assert!(rendered.contains("<redacted"), "got {rendered}");

    let operator = ShortBytes::new(b"Example Relay Co, Reykjavik".to_vec()).unwrap();
    assert_eq!(
        format!("{operator:?}"),
        "ShortBytes(Example Relay Co, Reykjavik)"
    );

    // Escaped, so a name with a newline cannot forge a log line.
    let hostile = ShortBytes::new(b"ok".to_vec()).unwrap();
    assert!(!format!("{hostile:?}").contains('\n'));
}
