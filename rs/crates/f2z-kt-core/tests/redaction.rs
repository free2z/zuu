//! `--log-level trace` on a directory server must not become a downloadable
//! copy of the social graph.
//!
//! A `DirectoryEntry` is public by design, so this is not confidentiality. It is
//! the operational property `f2z-codec`'s own redaction test protects: a derived
//! `Debug` on the structures a server holds, plus an operator turning logging up
//! while debugging, writes every device key and every contact address of every
//! user to disk, at rest, for as long as log rotation keeps it. That is a very
//! different artefact from a directory that answers one lookup at a time, and
//! the difference is worth a newtype per field.
//!
//! **The decimal case is the one that matters and it is not hypothetical.**
//! `tls_codec`'s own byte vectors derive `Debug` and print
//! `TlsByteVecU16 { vec: [222, 222, 222, …] }` — a complete dump that contains no
//! hex at all, so a test that only looked for hex would pass over it. Every
//! variable-length field in this crate is therefore a newtype with a
//! hand-written `Debug`, and the assertions below check base16 in both cases,
//! base64url, a decimal byte list, and any long hex-looking run.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in a parser is a remote denial of service;
// neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::{Digest, PublicKey, QueueAddress, RelayId, ShortBytes, Signature};
use f2z_codec::vec::VecU16;
use f2z_kt_core::entry::{
    ContactEndpoint, DeviceCredential, DeviceCredentialTBS, DeviceRevocation, DirectoryEntry,
    DirectoryEntryTBS, EntryAuthorization, EntryKind,
};
use f2z_kt_core::types::{Handle, KemPublicKey, LogId};
use f2z_kt_core::{KT_VERSION, labels};

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
/// millisecond timestamps and byte lengths. A run has to contain at least one
/// `a`-`f` to be evidence of base16.
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
    assert!(
        !rendered.contains(&decimal_list(&secret[..secret.len().min(4)])),
        "{label} leaked a decimal byte list prefix: {rendered}"
    );
    assert!(
        !rendered.contains(&lower_hex(&secret[..secret.len().min(4)])),
        "{label} leaked a hex prefix: {rendered}"
    );
    assert!(
        longest_hex_run(rendered) < 8,
        "{label} contains an 8+ character hex-looking run: {rendered}"
    );
}

fn short(bytes: &[u8]) -> ShortBytes {
    ShortBytes::new(bytes.to_vec()).unwrap()
}

/// A structurally complete entry whose every opaque field is `0xde`.
fn loaded_entry() -> DirectoryEntry {
    let credential = DeviceCredential {
        credential: DeviceCredentialTBS {
            label: short(labels::LABEL_DEVICE_CREDENTIAL),
            identity_pk: PublicKey::new([SECRET; 32]),
            handle: Handle::new(b"alice".to_vec()).unwrap(),
            device_pk: PublicKey::new([SECRET; 32]),
            device_kem_pk: KemPublicKey::new(vec![SECRET; 1216]).unwrap(),
            not_before_ms: 1_600_000_000_000,
            not_after_ms: 1_900_000_000_000,
        },
        signature: Signature::new([SECRET; 64]),
    };
    DirectoryEntry {
        entry: DirectoryEntryTBS {
            label: short(labels::LABEL_ENTRY),
            kt_version: KT_VERSION,
            log_id: LogId::new([SECRET; 32]),
            handle: Handle::new(b"alice".to_vec()).unwrap(),
            entry_version: 1,
            kind: EntryKind::SameKey,
            identity_pk: PublicKey::new([SECRET; 32]),
            directory_auth_pk: PublicKey::new([SECRET; 32]),
            devices: VecU16::new(vec![credential]),
            revocations: VecU16::new(vec![DeviceRevocation {
                device_pk: PublicKey::new([SECRET; 32]),
                revoked_at_ms: 1_700_000_000_000,
                reason: short(b"rotated"),
            }]),
            contact_endpoints: VecU16::new(vec![ContactEndpoint {
                relay_url: short(b"wss://relay.example/relay/v1"),
                relay_id: RelayId::new([SECRET; 32]),
                contact_addr: QueueAddress::new([SECRET; 32]),
            }]),
            prev_entry_hash: Digest::zero(),
            no_reset: 0,
            created_at_ms: 1_700_000_000_000,
        },
        authorization: EntryAuthorization::SameKey {
            auth_signature: Signature::new([SECRET; 64]),
        },
    }
}

#[test]
fn a_whole_directory_entry_renders_without_a_single_secret_byte() {
    // The realistic disaster: a server derives Debug on its request types and
    // an operator turns trace logging on in production.
    let rendered = format!("{:?}", loaded_entry());
    assert_no_leak("DirectoryEntry", &rendered, &[SECRET; 32]);
    assert_no_leak("DirectoryEntry", &rendered, &[SECRET; 64]);
    // The X-Wing KEM key is 1.2 KB and is the field a bare `TlsByteVecU16`
    // would have dumped in full.
    assert_no_leak("DirectoryEntry", &rendered, &[SECRET; 1216]);
    assert!(rendered.contains("<redacted"), "got {rendered}");
}

#[test]
fn a_kem_key_reports_its_length_and_nothing_else() {
    let key = KemPublicKey::new(vec![SECRET; 1216]).unwrap();
    let rendered = format!("{key:?}");
    assert_eq!(rendered, "KemPublicKey(<redacted; 1216 bytes>)");
    assert_no_leak("KemPublicKey", &rendered, &[SECRET; 1216]);
}

#[test]
fn a_log_id_redacts() {
    let rendered = format!("{:?}", LogId::new([SECRET; 32]));
    assert_eq!(rendered, "LogId(<redacted>)");
    assert_no_leak("LogId", &rendered, &[SECRET; 32]);
}

#[test]
fn a_handle_renders_because_it_is_the_one_field_that_must() {
    // The exception, and it is deliberate: a handle is what the directory
    // exists to publish, and redacting it would make a log's diagnostics
    // useless while protecting something already public.
    let handle = Handle::new(b"alice_2".to_vec()).unwrap();
    assert_eq!(format!("{handle:?}"), "Handle(alice_2)");
    // The charset admits no control characters, so a handle cannot forge a log
    // line — which is why rendering it is safe in the first place.
    assert!(Handle::new(b"a\nb".to_vec()).is_err());
    assert!(!format!("{handle:?}").contains('\n'));
}
