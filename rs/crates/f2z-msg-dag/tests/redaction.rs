//! Nothing in this crate renders a message's bytes through `Debug`.
//!
//! # The trap, restated because it produces a *passing* test over a leaking type
//!
//! `f2z-codec`'s `tests/redaction.rs` documents it and `f2z-msg-mls`'s repeats
//! it: a derived `Debug` over `Vec<u8>` or `[u8; N]` prints a list of **decimal**
//! integers. `[171, 205, 239, 18]` contains no hex at all, so a redaction check
//! that greps for `abcdef12` sees a clean string while the whole secret sits in
//! the log line.
//!
//! Every assertion below therefore checks base16 in both cases **and** the
//! decimal run, and the decimal one is the one doing the work. The decimal
//! pattern is deliberately unbracketed: a real dump very often starts partway
//! through a buffer — a length prefix comes first — so anchoring on `[` misses
//! exactly the shape the check exists to catch.
//!
//! # Why it matters in this crate specifically
//!
//! This is the layer that holds the **message**. `f2z-codec` redacts
//! ciphertext; `f2z-msg-mls` redacts keys and the decrypted payload; here the
//! plaintext sits in a [`PlaintextOutbox`] for the entire repair window, by
//! design, on the sender's device. An FFI boundary that formats an error, or a
//! client run with tracing on, produces exactly these strings.
//!
//! The source-level half of this — no type in `rs/crates/*/src/` may *derive*
//! `Debug` while holding raw bytes — is `f2z-codec`'s
//! `tests/workspace_debug_scan.rs`, which reaches this crate automatically. The
//! two are complementary: that one fires on a type nobody wrote a fixture for,
//! this one fires on a hand-written `Debug` that renders the bytes anyway.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::Body;
use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, MessageDag, MessageType, MsgId, Parents, PlaintextOutbox,
    RepairEntry, RetentionClass, SentAt,
};

/// A byte pattern that is unmistakable in any encoding a leak might use.
const SECRET: u8 = 0xde;

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// `222, 222, 222, 222` — a derived `Debug` over a byte slice, unbracketed. See
/// the module note for why the brackets are left off.
fn decimal_run(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(alloc_to_string)
        .collect::<Vec<String>>()
        .join(", ")
}

fn alloc_to_string(byte: &u8) -> String {
    byte.to_string()
}

fn assert_no_leak(rendered: &str, secret: &[u8], what: &str) {
    assert!(
        !rendered.contains(&lower_hex(secret)),
        "{what} leaked its bytes as lowercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&upper_hex(secret)),
        "{what} leaked its bytes as uppercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&decimal_run(secret)),
        "{what} leaked its bytes as a decimal list — which contains no hex at all, \
         so a hex-shaped check would have passed: {rendered}"
    );
}

fn secret_message() -> AppMessage {
    AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents: Parents::new(vec![MsgId::new([SECRET; 32])]).unwrap(),
        epoch: 7,
        sender_leaf_index: 1,
        sent_at: SentAt::new(1_700_000_000_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(vec![SECRET; 64]).unwrap(),
    })
    .unwrap()
}

#[test]
fn a_msg_id_does_not_render_its_bytes() {
    let id = MsgId::new([SECRET; 32]);
    let rendered = format!("{id:?}");
    assert_eq!(rendered, "MsgId(<redacted>)");
    assert_no_leak(&rendered, id.as_bytes(), "MsgId");
}

#[test]
fn an_app_message_does_not_render_its_body_or_its_parents() {
    let message = secret_message();
    let rendered = format!("{message:?}");
    assert_no_leak(&rendered, &[SECRET; 64], "AppMessage");
    // The fields that are safe — and useful — are still there.
    assert!(rendered.contains("epoch: 7"));
    assert!(rendered.contains("64 bytes"));
}

#[test]
fn a_repair_entry_does_not_render_the_message_it_carries() {
    let message = secret_message();
    let entry = RepairEntry::supplied(&message).unwrap();
    let rendered = format!("{entry:?}");
    assert_no_leak(&rendered, &[SECRET; 64], "RepairEntry");
    assert_no_leak(&rendered, message.msg_id().as_bytes(), "RepairEntry");
}

#[test]
fn the_outbox_and_its_repair_outcome_do_not_render_the_plaintext() {
    let message = secret_message();
    let plaintext = message.encode().unwrap();

    let mut outbox = PlaintextOutbox::new(60_000, 8);
    outbox.store(message.msg_id(), plaintext, 0);
    assert_no_leak(&format!("{outbox:?}"), &[SECRET; 64], "PlaintextOutbox");

    let outcome = outbox.repair(&message.msg_id(), 0);
    let rendered = format!("{outcome:?}");
    assert_no_leak(&rendered, &[SECRET; 64], "RepairOutcome");
    assert!(
        rendered.contains("bytes"),
        "the length is public and useful; the bytes are not"
    );
}

#[test]
fn the_dag_does_not_render_message_bytes() {
    let message = secret_message();
    let mut dag = MessageDag::new();
    dag.insert(DagEntry::from_delivered(&message, 7, 1).unwrap());
    assert_no_leak(&format!("{dag:?}"), &[SECRET; 32], "MessageDag");
}

/// The negative control. If this ever stops failing, the checks above are
/// checking nothing — which is how a redaction suite rots into decoration.
#[test]
fn the_decimal_check_would_catch_a_real_dump() {
    let leaked = format!("Payload {{ bytes: {:?} }}", vec![SECRET; 8]);
    assert!(
        leaked.contains(&decimal_run(&[SECRET; 8])),
        "the decimal pattern no longer matches a derived Debug over bytes"
    );
    assert!(
        !leaked.contains(&lower_hex(&[SECRET; 8])),
        "and a hex-only check would have passed over it — that is the trap"
    );
}
