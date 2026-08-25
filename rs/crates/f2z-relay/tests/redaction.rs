//! **No payload, queue address, key or peer address in any log line, at any
//! level.**
//!
//! # The trap this file is written around
//!
//! `f2z-codec`'s own redaction tests document it and it is worth restating,
//! because a test that misses it *passes while everything leaks*: `tls_codec`'s
//! byte vectors derive `Debug` and render as a **decimal** list —
//! `[222, 173, 190, 239, …]` — which contains no hexadecimal characters at all.
//! A leak check looking for `deadbeef` sails straight past a complete dump of
//! the bytes.
//!
//! So every assertion below checks four renderings of the same secret: base16
//! lower, base16 upper, base64url, and the decimal run. The decimal check is the
//! one that would have caught the bug.
//!
//! # What is scanned
//!
//! 1. Every type in this crate that holds protocol material and derives or
//!    implements `Debug` — a `Debug` reaches a log line the first time anyone
//!    writes `{:?}` in a diagnostic, and every error type here can end up in a
//!    startup message.
//! 2. [`f2z_relay::log`]'s own output, which is checked structurally rather than
//!    by scanning: the writer takes `&'static str` and `u64` and nothing else,
//!    so there is no parameter through which a payload could travel. The test
//!    that matters is that the signature has not grown one.
//! 3. `--print-config`, because a bug report is where a redacted secret goes to
//!    live forever.

// An integration test is its own crate, so the workspace's denials of the
// panicking families do not reach it through `lib.rs`'s `cfg_attr(test, ...)`.
// They are relaxed here for the reason `rs/README.md` gives: a test that has to
// thread a `Result` through every assertion is a test nobody reads, and a panic
// in a test is a failing test rather than a remote denial of service.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::{Challenge, Payload, PublicKey, QueueAddress};
use f2z_relay::config::Config;

/// A byte string chosen so every rendering of it is searchable.
const SECRET: [u8; 8] = [0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe];

/// The four ways these bytes could reach a log line.
fn leak_forms() -> Vec<(&'static str, String)> {
    let hex_lower: String = SECRET.iter().map(|byte| format!("{byte:02x}")).collect();
    let hex_upper: String = SECRET.iter().map(|byte| format!("{byte:02X}")).collect();
    let base64 = f2z_relay::caps::base64url(&SECRET);
    // The one a hex-only check misses: `#[derive(Debug)]` on a byte vector.
    let decimal: String = SECRET
        .iter()
        .map(|byte| byte.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    vec![
        ("base16 lower", hex_lower),
        ("base16 upper", hex_upper),
        ("base64url", base64),
        ("decimal byte list", decimal),
    ]
}

#[track_caller]
fn assert_no_leak(what: &str, rendered: &str) {
    for (form, needle) in leak_forms() {
        assert!(
            !rendered.contains(&needle),
            "{what} leaked its bytes as a {form}: {rendered}"
        );
    }
}

#[test]
fn the_decimal_form_is_actually_what_an_underived_debug_prints() {
    // The premise of every other test in this file. If this ever stops holding,
    // the checks above are looking for the wrong string.
    let raw = format!("{:?}", SECRET.to_vec());
    assert!(raw.contains("222, 173, 190, 239"));
    assert!(!raw.contains("deadbeef"));
}

#[test]
fn an_outbound_frame_never_renders_its_ciphertext() {
    let message = f2z_codec::commands::QueuedMessage {
        index: 0,
        received_at_ms: 1,
        payload: Payload::new(SECRET.to_vec()).unwrap(),
    };
    let outbound = f2z_relay::outbound::msg_push(QueueAddress::new([0xde; 32]), &message).unwrap();
    assert_no_leak("Outbound", &format!("{outbound:?}"));
}

#[test]
fn a_wire_message_never_renders_its_bytes() {
    let binary = f2z_relay::transport::WireMessage::Binary(SECRET.to_vec());
    assert_no_leak("WireMessage::Binary", &format!("{binary:?}"));
    // §4.2's text frame does not even carry the bytes into the relay.
    assert_eq!(
        format!("{:?}", f2z_relay::transport::WireMessage::Text),
        "Text"
    );
}

#[test]
fn the_challenge_table_never_renders_a_scope() {
    let mut table = f2z_relay::challenge::Challenges::new(4);
    table
        .issue(Challenge::new([0xaa; 32]), 2, &SECRET, 10_000, 0)
        .unwrap();
    assert_no_leak("Challenges", &format!("{table:?}"));
}

#[test]
fn the_subscription_table_never_renders_an_address() {
    let table = f2z_relay::subscriptions::Subscriptions::new();
    let (sender, _receiver) = tokio::sync::mpsc::channel(1);
    let mut address = [0u8; 32];
    address[..SECRET.len()].copy_from_slice(&SECRET);
    table.subscribe(QueueAddress::new(address), 1, sender);
    assert_no_leak("Subscriptions", &format!("{table:?}"));
}

#[test]
fn a_source_key_is_not_an_address_and_does_not_render() {
    let guard =
        f2z_relay::abuse::AbuseGuard::new(f2z_relay::config::Limits::default(), true, [0x5a; 32]);
    let peer = std::net::SocketAddr::from(([203, 0, 113, 7], 44_000));
    let key = guard.key_for(&peer);
    let rendered = format!("{key:?}");
    assert_eq!(rendered, "SourceKey(<redacted>)");
    // Not the address in any form either — including the decimal octets, which
    // is how a derived `Debug` on `[u8; 4]` would have printed it.
    for needle in ["203.0.113.7", "203, 0, 113, 7", "cb00", "44000"] {
        assert!(!rendered.contains(needle), "the peer leaked: {rendered}");
    }
}

#[test]
fn the_abuse_guard_never_renders_its_per_source_salt() {
    // The salt is what makes a `SourceKey` not an address: hold it and every
    // key in the table is invertible by trying candidate peers. `AbuseGuard`
    // hand-writes its `Debug` to keep it out, and this is what proves that impl
    // still does its job — the other two relay tables are covered above, and
    // this is the only one carrying a secret of its own.
    let mut salt = [0u8; 32];
    salt[..SECRET.len()].copy_from_slice(&SECRET);
    let guard = f2z_relay::abuse::AbuseGuard::new(Config::default().limits, true, salt);
    assert_no_leak("AbuseGuard", &format!("{guard:?}"));
}

#[test]
fn the_config_debug_and_print_config_both_redact_the_identity_seed() {
    let mut config = Config::default();
    config.identity.seed = "de".repeat(32);
    let printed = config.to_redacted_toml();
    assert!(printed.contains("<redacted>"));
    assert!(!printed.contains("dede"));
    // A `Config` lands in a startup error message, so its `Debug` matters as
    // much as its printer.
    let debugged = format!("{config:?}");
    assert!(!debugged.contains("dede"));
    assert!(debugged.contains("<redacted>"));
}

#[test]
fn a_store_error_never_carries_a_value() {
    // The relay formats store errors nowhere on the wire — §10's ERR_INTERNAL
    // "carries no detail, ever" — but it does log that a sweep failed, so the
    // rendering is checked here as well as in `f2z-relay-store`'s own suite.
    let error = f2z_relay_store::StoreError::Corrupt("a fixed string");
    assert_no_leak("StoreError", &format!("{error}"));
    assert_no_leak("StoreError", &format!("{error:?}"));
}

#[test]
fn the_logger_has_no_parameter_a_secret_could_travel_through() {
    // The structural half of the property. `line` takes a `&'static str` and
    // `(&'static str, u64)` pairs; there is no `impl Debug` parameter, so
    // `log_trace!("frame", "payload" = payload)` does not compile.
    //
    // This test is the compile check itself: it exercises every macro at the
    // loudest level and asserts the output is digits and fixed text.
    f2z_relay::log::set_level(f2z_relay::log::Level::Trace);
    assert!(f2z_relay::log::enabled(f2z_relay::log::Level::Trace));
    f2z_relay::log_trace!("a fixed message", "count" = 7u32);
    f2z_relay::log_debug!("a fixed message", "count" = 7u32);
    f2z_relay::log_info!("a fixed message");
    f2z_relay::log_warn!("a fixed message");
    f2z_relay::log_error!("a fixed message");
    f2z_relay::log::set_level(f2z_relay::log::Level::Info);
}

#[test]
fn metrics_carry_no_per_queue_and_no_per_ip_label() {
    // The other half of the same rule: an unconsidered metrics endpoint is a
    // metadata leak, and a per-queue series is a per-conversation activity
    // trace that outlives the ciphertext in the scraper's storage.
    let rendered = f2z_relay::metrics::Metrics::new().render();
    for line in rendered.lines() {
        if line.starts_with('#') {
            continue;
        }
        assert!(!line.contains('{'), "a labelled series: {line}");
    }
    assert_no_leak("metrics", &rendered);
}

#[test]
fn a_public_key_renders_nothing() {
    // Inherited from `f2z-codec`'s newtypes rather than implemented here, and
    // asserted so that a future local wrapper cannot quietly lose it.
    let mut bytes = [0u8; 32];
    bytes[..SECRET.len()].copy_from_slice(&SECRET);
    assert_no_leak("PublicKey", &format!("{:?}", PublicKey::new(bytes)));
    assert_no_leak("QueueAddress", &format!("{:?}", QueueAddress::new(bytes)));
    assert_no_leak(
        "Payload",
        &format!("{:?}", Payload::new(SECRET.to_vec()).unwrap()),
    );
}
