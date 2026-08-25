//! `--log-level trace` on a client must not become a copy of the user's
//! identity.
//!
//! Unlike `f2z-kt-core`'s neighbouring test, this one *is* confidentiality. A
//! `DirectoryEntry` is public by design; an `IdentitySigningKey` is the thing
//! that makes a handle mean anything, a `BackupWrapKey` decrypts the local
//! history archive, and a `DeviceSignatureKey` is the MLS leaf key. Any of them
//! in a log file is a total compromise of the account, and unlike a leaked
//! ciphertext it cannot be rotated away from without `KT.md` §4.4's rotation
//! ceremony — which needs the leaked key to sign the proof.
//!
//! # The decimal case is the one that matters, and it is not hypothetical
//!
//! `f2z-codec` records the trap and this file is written around it: a **derived**
//! `Debug` over `[u8; 32]` or a `tls_codec` byte vector prints
//! `[222, 222, 222, …]` — a complete dump containing **no hex at all**. A
//! redaction test that greps for hex passes while every byte is on disk. So
//! every assertion below checks base16 in both cases, base64url, a full decimal
//! byte list, short prefixes of each, and any long hex-looking run.
//!
//! # And the source scan that this file cannot replace
//!
//! `f2z-codec/tests/workspace_debug_scan.rs` walks every `.rs` file under every
//! crate in `rs/crates/` and fails on any `#[derive(…, Debug, …)]` over a raw
//! byte field. That is the control; this is the fixture. The scan exists
//! because #563 got in through a type nobody wrote a fixture for. Both are
//! needed and neither substitutes for the other.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_kt_core::types::{Handle, KemPublicKey};
use f2z_msg_identity::account::AccountKeys;
use f2z_msg_identity::credential::DeviceCredentialRequest;
use f2z_msg_identity::device::{DeviceKeys, DeviceSignatureKey, QueueKey};
use f2z_msg_identity::node::{HardenedIndex, ckd_hardened, master_node};

const SEED: [u8; 64] = [0x2a; 64];

/// A counter, not a CSPRNG.
struct CountingRng(u64);

impl rand_core::TryRng for CountingRng {
    type Error = core::convert::Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Ok(self.try_next_u64()? as u32)
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        Ok(self.0)
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        for byte in dst.iter_mut() {
            *byte = self.try_next_u64()? as u8;
        }
        Ok(())
    }
}

impl rand_core::TryCryptoRng for CountingRng {}

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// `[222, 222, 222, …]` — what a derived `Debug` on a byte slice prints.
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
            out.push(ALPHABET[((value >> shift) & 0x3f) as usize] as char);
        }
    }
    out
}

/// The longest run that could be a hex dump. A run of pure decimal digits does
/// not count — timestamps and lengths are legitimate output — so a run has to
/// contain at least one `a`-`f`.
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

#[test]
fn no_account_key_renders_its_bytes_in_any_encoding() {
    let keys = AccountKeys::from_seed(&SEED, 0).unwrap();

    // The public halves are the values a leak would be *checked* against; the
    // secret we can name from outside is the backup key, whose bytes are the
    // key. Both are asserted, because a `Debug` that printed the public key
    // would still be a `Debug` that had been given raw bytes to print.
    let secrets: [(&str, Vec<u8>); 4] = [
        ("identity", keys.identity.public().as_bytes().to_vec()),
        ("ceremony", keys.ceremony.public().as_bytes().to_vec()),
        (
            "directory_auth",
            keys.directory_auth.public().as_bytes().to_vec(),
        ),
        ("backup_wrap", keys.backup_wrap.as_bytes().to_vec()),
    ];

    let renders = [
        ("IdentitySigningKey", format!("{:?}", keys.identity)),
        ("CeremonySigningKey", format!("{:?}", keys.ceremony)),
        ("DirectoryAuthKey", format!("{:?}", keys.directory_auth)),
        ("BackupWrapKey", format!("{:?}", keys.backup_wrap)),
        ("AccountKeys", format!("{keys:?}")),
    ];

    for (label, rendered) in &renders {
        assert!(
            rendered.contains("<redacted>"),
            "{label} does not say it redacted anything: {rendered}"
        );
        for (name, secret) in &secrets {
            assert_no_leak(&format!("{label} (vs {name})"), rendered, secret);
        }
    }
}

#[test]
fn no_device_key_renders_its_bytes() {
    let mut rng = CountingRng(1);
    let device = DeviceSignatureKey::generate(&mut rng);
    let queue = QueueKey::generate(&mut rng);
    let bundle = DeviceKeys::generate(&mut rng);

    for (label, rendered, secret) in [
        (
            "DeviceSignatureKey",
            format!("{device:?}"),
            device.public().as_bytes().to_vec(),
        ),
        (
            "QueueKey",
            format!("{queue:?}"),
            queue.public().as_bytes().to_vec(),
        ),
        (
            "DeviceKeys",
            format!("{bundle:?}"),
            bundle.signature.public().as_bytes().to_vec(),
        ),
    ] {
        assert!(rendered.contains("<redacted>"), "{label}: {rendered}");
        assert_no_leak(label, &rendered, &secret);
    }
}

#[test]
fn an_extended_node_never_renders_its_halves() {
    // The worst case in the crate: an `ExtendedNode` is 64 bytes from which the
    // whole subtree derives, and it is the type a derived `Debug` would have
    // rendered as two 32-element decimal lists.
    let master = master_node(&SEED).unwrap();
    let child = ckd_hardened(&master, HardenedIndex::new(32).unwrap());

    for (label, node) in [("master", &master), ("child", &child)] {
        let rendered = format!("{node:?}");
        assert_eq!(rendered, "ExtendedNode(<redacted>)");
        assert_no_leak(label, &rendered, node.to_secret_bytes().as_slice());
    }
}

#[test]
fn a_device_credential_request_does_not_render_a_kem_key() {
    // The one type in this crate that derives `Debug`. It holds no secret — a
    // handle, two public keys and two timestamps — but it *does* hold a 1216
    // byte KEM key, and a derived `Debug` over a raw `Vec<u8>` there would put
    // 1216 decimal integers in a log line. It is safe because every field is a
    // newtype whose own `Debug` redacts; this asserts that rather than assuming
    // it.
    let request = DeviceCredentialRequest {
        handle: Handle::new(b"alice".to_vec()).unwrap(),
        device_pk: f2z_codec::types::PublicKey::new([0xde; 32]),
        device_kem_pk: KemPublicKey::new(vec![0xde; 1216]).unwrap(),
        not_before_ms: 1_000,
        not_after_ms: 2_000,
    };
    let rendered = format!("{request:?}");
    assert_no_leak("DeviceCredentialRequest", &rendered, &[0xde; 32]);
    assert!(
        rendered.len() < 512,
        "the rendering is {} bytes long, which is a dump: {rendered}",
        rendered.len()
    );
    // The handle is deliberately visible: `f2z-kt-core`'s `Handle` renders,
    // because a handle's whole purpose is to be public and human-readable, and
    // hiding it makes diagnostics useless while protecting nothing.
    assert!(rendered.contains("alice"), "{rendered}");
}

#[test]
fn an_issued_credential_does_not_render_its_signature() {
    let keys = AccountKeys::from_seed(&SEED, 0).unwrap();
    let device = DeviceSignatureKey::generate(&mut CountingRng(9));
    let credential = keys
        .identity
        .issue_device_credential(&DeviceCredentialRequest {
            handle: Handle::new(b"alice".to_vec()).unwrap(),
            device_pk: device.public(),
            device_kem_pk: KemPublicKey::new(vec![0xde; 1216]).unwrap(),
            not_before_ms: 1_000,
            not_after_ms: 2_000,
        })
        .unwrap();

    let rendered = format!("{credential:?}");
    assert_no_leak(
        "DeviceCredential",
        &rendered,
        credential.signature.as_bytes(),
    );
    assert_no_leak(
        "DeviceCredential (identity_pk)",
        &rendered,
        keys.identity.public().as_bytes(),
    );
}

#[test]
fn the_error_type_carries_no_key_material() {
    // `IdentityError` derives `Debug`, which is correct: it is a fieldless enum
    // and there is nothing in it to leak. Asserted because "it has no fields
    // today" is the assumption a future variant would break.
    use f2z_msg_identity::IdentityError;
    for error in [
        IdentityError::SeedLength,
        IdentityError::IndexOutOfRange,
        IdentityError::MalformedCredential,
    ] {
        let rendered = format!("{error:?}");
        assert!(rendered.len() < 64, "{rendered}");
        assert!(longest_hex_run(&rendered) < 8, "{rendered}");
    }
}
