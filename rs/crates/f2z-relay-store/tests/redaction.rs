//! `--log-level trace` on a relay must not become a ciphertext archive.
//!
//! # The trap this file is written around
//!
//! `f2z-codec`'s own redaction tests document it: **`tls_codec`'s byte vectors
//! derive `Debug` and print a list of decimal integers** — `[222, 222, 222, …]`
//! — which is a complete dump containing no hex whatsoever. A leak check that
//! greps for base16 therefore passes with flying colours while every byte of
//! every payload is in the log file.
//!
//! So each assertion below rejects four encodings of the same secret: lowercase
//! hex, uppercase hex, base64url, and an unbracketed **decimal run**. The
//! decimal run is unbracketed on purpose, exactly as in `f2z-codec`: a real
//! dump very often does not start at the beginning of the list, because a wire
//! buffer opens with a length prefix, so anchoring on `[` misses the shape the
//! check exists to catch.
//!
//! # What is checked
//!
//! Every type this crate puts in front of a caller: the records, the read
//! results, the reports, and — the one that is easy to forget — the **error
//! type**, which is what actually reaches a log line on the unhappy path.

// Test code, run on the host by a person reading the failure.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::{Payload, PublicKey, QueueAddress};
use f2z_relay_proto::queue::{AppendQuota, QueueKind};
use f2z_relay_store::{
    Append, MemoryStore, QueueSpec, ReadWindow, RelayStore, SendAuth, SqliteStore, StoreError,
};

/// Unmistakable in any encoding a leak might use.
const SECRET: u8 = 0xde;
const SECRET_LEN: usize = 64;

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// `222, 222, 222, …` — a derived `Debug` on a byte slice, without the
/// brackets. See the module note on why the brackets are deliberately absent.
fn decimal_run(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
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

/// Assert that `rendered` cannot be turned back into `secret`.
///
/// A four-byte prefix is enough: a dump that contained the whole value
/// contains its prefix, and matching on a prefix catches a truncated dump too.
fn assert_no_leak(rendered: &str, secret: &[u8], what: &str) {
    let probe = &secret[..4];
    for (encoding, needle) in [
        ("lowercase hex", lower_hex(probe)),
        ("uppercase hex", upper_hex(probe)),
        ("base64url", base64url(probe)),
        ("decimal byte list", decimal_run(probe)),
    ] {
        assert!(
            !rendered.contains(&needle),
            "{what} leaked its bytes as {encoding}: {rendered}"
        );
    }
}

fn secret_address() -> QueueAddress {
    QueueAddress::new([SECRET; 32])
}

fn secret_key() -> PublicKey {
    PublicKey::new([SECRET; 32])
}

fn secret_payload() -> Payload {
    Payload::new(vec![SECRET; SECRET_LEN]).unwrap()
}

fn spec() -> QueueSpec {
    QueueSpec {
        kind: QueueKind::Standard,
        recv_addr: secret_address(),
        send_addr: QueueAddress::new([SECRET ^ 0x01; 32]),
        recv_key: secret_key(),
        message_ttl_seconds: 86_400,
        idle_ttl_seconds: 86_400,
        quota: AppendQuota {
            max_messages: 8,
            max_bytes: 512,
        },
        created_at_ms: 1_000,
    }
}

#[test]
fn nothing_a_store_hands_back_renders_its_bytes() {
    let store = MemoryStore::new();
    let spec = spec();
    let record = store.create_queue(&spec).unwrap();
    assert_no_leak(&format!("{record:?}"), &[SECRET; 32], "QueueRecord");
    assert_no_leak(&format!("{spec:?}"), &[SECRET; 32], "QueueSpec");

    let committed = store
        .bind_send(&spec.send_addr, &secret_key(), 1_000)
        .unwrap();
    assert_no_leak(&format!("{committed:?}"), &[SECRET; 32], "Committed<()>");

    let payload = secret_payload();
    let append = Append {
        send_addr: spec.send_addr,
        auth: SendAuth::Signed(secret_key()),
        payload: &payload,
        received_at_ms: 2_000,
    };
    assert_no_leak(&format!("{append:?}"), &[SECRET; SECRET_LEN], "Append");
    assert_no_leak(&format!("{payload:?}"), &[SECRET; SECRET_LEN], "Payload");

    let accepted = store.append(&append).unwrap();
    assert_no_leak(
        &format!("{accepted:?}"),
        &[SECRET; 32],
        "Committed<Appended>",
    );

    let page = store
        .read(
            &spec.recv_addr,
            &secret_key(),
            ReadWindow {
                from_index: 0,
                max_messages: 8,
                max_bytes: 4_096,
            },
            3_000,
        )
        .unwrap();
    // The one that matters most: a read result holds the ciphertext itself.
    assert_no_leak(&format!("{page:?}"), &[SECRET; SECRET_LEN], "ReadPage");
    assert_no_leak(
        &format!("{:?}", page.messages[0]),
        &[SECRET; SECRET_LEN],
        "StoredMessage",
    );

    let outcome = store.ack(&spec.recv_addr, &secret_key(), 0, 4_000).unwrap();
    assert_no_leak(
        &format!("{outcome:?}"),
        &[SECRET; 32],
        "Committed<AckOutcome>",
    );

    let report = store.expire(u64::MAX).unwrap();
    assert_no_leak(&format!("{report:?}"), &[SECRET; 32], "ExpiryReport");
}

#[test]
fn an_error_renders_neither_the_address_that_caused_it_nor_the_payload() {
    // The unhappy path is the one that actually reaches a log line, and a
    // storage error is the value a relay is most likely to print verbatim.
    let store = MemoryStore::new();
    let error = store
        .queue_by_recv(&secret_address(), &secret_key())
        .expect_err("nothing exists yet");
    assert_no_leak(&format!("{error:?}"), &[SECRET; 32], "StoreError (Debug)");
    assert_no_leak(&format!("{error}"), &[SECRET; 32], "StoreError (Display)");

    let payload = secret_payload();
    let error = store
        .append(&Append {
            send_addr: secret_address(),
            auth: SendAuth::Signed(secret_key()),
            payload: &payload,
            received_at_ms: 1,
        })
        .expect_err("nothing exists yet");
    assert_no_leak(
        &format!("{error:?}"),
        &[SECRET; SECRET_LEN],
        "StoreError from an append (Debug)",
    );
}

#[test]
fn a_backend_error_carries_no_bound_value_into_its_message() {
    // The property that makes the rest of this file cheap to keep true:
    // nothing here interpolates a value into SQL, so SQLite's diagnostics name
    // schema objects and never echo what was bound to them. Provoke a real
    // backend error and check.
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteStore::open(directory.path().join("relay.sqlite3")).unwrap();
    let spec = spec();
    let _ = store.create_queue(&spec).unwrap();

    let payload = secret_payload();
    // The quota is 512 bytes; the ninth 64-byte payload crosses it. That is a
    // protocol refusal rather than a backend one, which is itself the point:
    // the errors a relay actually logs are these.
    let _ = store
        .bind_send(&spec.send_addr, &secret_key(), 1_000)
        .unwrap();
    let mut last: Option<StoreError> = None;
    for _ in 0..16 {
        if let Err(error) = store.append(&Append {
            send_addr: spec.send_addr,
            auth: SendAuth::Signed(secret_key()),
            payload: &payload,
            received_at_ms: 2_000,
        }) {
            last = Some(error);
            break;
        }
    }
    let error = last.expect("the quota refuses eventually");
    assert_no_leak(
        &format!("{error:?} {error}"),
        &[SECRET; SECRET_LEN],
        "a quota refusal from the SQLite store",
    );

    // And a genuine backend failure: a schema-version mismatch, which is the
    // one error path that renders a string this crate wrote itself.
    let stats = store.stats().unwrap();
    assert_no_leak(&format!("{stats:?}"), &[SECRET; 32], "StoreStats");
}

#[test]
fn the_decimal_check_would_actually_catch_a_leak() {
    // A negative control. Without this, every assertion above could be passing
    // because the probe never matches anything, and the file would be a very
    // convincing no-op — which is precisely the failure mode `f2z-codec`'s
    // redaction tests warn about.
    let leaked = format!("payload = {:?}", vec![SECRET; SECRET_LEN]);
    let probe = decimal_run(&[SECRET; 4]);
    assert!(
        leaked.contains(&probe),
        "the decimal probe must match a derived Debug on a byte vector, or it \
         is checking nothing"
    );
    let hex_leak = lower_hex(&[SECRET; 32]);
    assert!(hex_leak.contains(&lower_hex(&[SECRET; 4])));
}
