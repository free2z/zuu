//! §7's order has one implementation, and this file is why.
//!
//! # What this file used to be, and what happened to it
//!
//! `wallet/e2e2z/src/lib/messaging/types.ts` used to export a second
//! implementation of §7's ordering:
//!
//! ```text
//! export function compareMessages(a: Message, b: Message): number {
//!   if (a.epoch !== b.epoch) return a.epoch - b.epoch;
//!   if (a.senderLeafIndex !== b.senderLeafIndex) {
//!     return a.senderLeafIndex - b.senderLeafIndex;
//!   }
//!   return a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0;
//! }
//! ```
//!
//! and `wallet/e2e2z/src/features/messages/Transcript.tsx` applied it as
//! `[...messages].sort(compareMessages)` — the entire ordering the UI
//! performed. Nothing there read `parents`, so it implemented §7's **tie-break**
//! and called it the order.
//!
//! This file pinned that disagreement as executable fact. It has since been
//! resolved, and not by porting the graph pass into TypeScript:
//! [`CLIENT-CONTRACT.md` §7 and §5.2's 2026-08-25 corrections](https://github.com/free2z/zuu/issues/733)
//! moved display order out of the UI entirely. `msg_list_messages` returns
//! messages already in §7's order, computed here; the UI renders the sequence it
//! is given; `compareMessages` is deleted rather than fixed. That is ADR 0001's
//! rule — one Rust core, no second implementation — applied to a protocol rule
//! that had quietly acquired one.
//!
//! # What is still worth pinning, and why this file was not deleted with it
//!
//! Two things outlive the comparator:
//!
//! 1. **The FFI's spelling of `msgId`.** A `msg_id` is 32 bytes here and a
//!    string across the boundary, and the tie-break's third component is a
//!    comparison. Lowercase base16 is order-preserving over the bytes; base64 is
//!    not, and mixed case is not. Nothing downstream sorts on it today, but the
//!    contract still declares a `msgId` and something will compare two of them
//!    eventually. `hex_string_ordering_reproduces_byte_ordering_over_the_whole_range`
//!    is where a change to that spelling fails.
//!
//! 2. **The counterexample itself.** The tie-break applied on its own is not a
//!    near-miss for §7's order; it puts a reply above the message it answers in
//!    every one-to-one conversation where the replier holds the lower leaf
//!    index, which is half of them.
//!    `the_tie_break_alone_puts_a_reply_above_its_parent` keeps that concrete, so
//!    a future contributor who is tempted to reintroduce a client-side sort has
//!    the failure in front of them rather than in a changelog.
//!
//! `typescript_compare_messages` below is therefore kept as a **transcription of
//! deleted code**, used only to demonstrate what it got wrong. It is not a
//! parity target any more, and nothing in the tree implements it.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use core::cmp::Ordering;

use f2z_codec::types::Body;
use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, MessageDag, MessageType, MsgId, Parents, RetentionClass,
    SentAt, SortKey, compare_sort_keys,
};

/// `compareMessages`, transcribed from the TypeScript that was deleted by
/// `CLIENT-CONTRACT.md` §7's 2026-08-25 correction. Kept as a separate function
/// from [`compare_sort_keys`] so the rule being demonstrated is visible rather
/// than assumed.
fn typescript_compare_messages(a: &SortKey, b: &SortKey) -> Ordering {
    if a.epoch != b.epoch {
        return a.epoch.cmp(&b.epoch);
    }
    if a.sender_leaf_index != b.sender_leaf_index {
        return a.sender_leaf_index.cmp(&b.sender_leaf_index);
    }
    // `msgId` is a hex string there and 32 bytes here. See the module note.
    a.msg_id.to_lower_hex().cmp(&b.msg_id.to_lower_hex())
}

fn key(epoch: u64, leaf: u32, msg_id: MsgId) -> SortKey {
    SortKey {
        epoch,
        sender_leaf_index: leaf,
        msg_id,
    }
}

fn id(byte: u8) -> MsgId {
    MsgId::new([byte; 32])
}

/// The tie-break itself is unchanged by the correction: what moved is *where*
/// it may be applied, not what it says. This pins the rule field for field, so
/// a change to [`compare_sort_keys`]'s field order or comparison is caught.
#[test]
fn the_tie_break_is_epoch_then_leaf_then_msg_id() {
    let cases = [
        (key(1, 0, id(0xff)), key(2, 0, id(0x00))),
        (key(2, 0, id(0xff)), key(2, 1, id(0x00))),
        (key(2, 1, id(0x01)), key(2, 1, id(0x02))),
        (key(0, 0, id(0x00)), key(0, 0, id(0x00))),
        (
            key(u64::MAX, u32::MAX, id(0xff)),
            key(u64::MAX, u32::MAX, id(0xff)),
        ),
    ];
    for (left, right) in cases {
        assert_eq!(
            compare_sort_keys(&left, &right),
            typescript_compare_messages(&left, &right),
            "the two implementations of §7's tie-break disagree on {left:?} vs {right:?}"
        );
        assert_eq!(
            compare_sort_keys(&right, &left),
            typescript_compare_messages(&right, &left),
        );
    }
}

/// The byte-versus-string question, isolated.
///
/// A hex string comparison and a byte comparison agree because ASCII `0`..`9`
/// precedes `a`..`f` and the mapping is monotone. They would **not** agree for
/// base64 — `+` and `/` sort below the digits — and they would not agree for
/// mixed case. If the FFI ever changes how a `msgId` is spelled, this test is
/// where it fails.
#[test]
fn hex_string_ordering_reproduces_byte_ordering_over_the_whole_range() {
    for low in 0u8..=254 {
        let high = low + 1;
        let a = MsgId::new([low; 32]);
        let b = MsgId::new([high; 32]);
        assert!(a < b);
        assert!(a.to_lower_hex() < b.to_lower_hex(), "{low} vs {high}");
    }
    // And a boundary that a naive check would miss: the digit/letter seam.
    assert!(MsgId::new([0x09; 32]) < MsgId::new([0x0a; 32]));
    assert!(MsgId::new([0x09; 32]).to_lower_hex() < MsgId::new([0x0a; 32]).to_lower_hex());
}

/// **Why the UI no longer sorts, executable.**
///
/// Bob (leaf 1) sends `A`. Alice (leaf 0) replies with `B`, `parents = [A]`, in
/// the same epoch. The tie-break puts the reply first. The causal order does
/// not, and the causal order is what §7 says decides.
///
/// This used to assert a live defect in
/// `wallet/e2e2z/src/features/messages/Transcript.tsx`. It now asserts the
/// reason that file does no sorting at all.
#[test]
fn the_tie_break_alone_puts_a_reply_above_its_parent() {
    let a = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents: Parents::empty(),
        epoch: 7,
        sender_leaf_index: 1,
        sent_at: SentAt::new(1_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(b"what do you think?".to_vec()).unwrap(),
    })
    .unwrap();

    let b = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents: Parents::new(vec![a.msg_id()]).unwrap(),
        epoch: 7,
        sender_leaf_index: 0,
        sent_at: SentAt::new(2_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(b"I think yes".to_vec()).unwrap(),
    })
    .unwrap();

    // Bob is leaf 1 and sent A; Alice is leaf 0 and replied with B.
    let a_entry = DagEntry::from_delivered(&a, 7, 1).unwrap();
    let b_entry = DagEntry::from_delivered(&b, 7, 0).unwrap();

    // The tie-break alone — which is what the deleted comparator applied to
    // every pair — puts the reply first.
    assert_eq!(
        typescript_compare_messages(&b_entry.sort_key(), &a_entry.sort_key()),
        Ordering::Less,
        "the transcription no longer reproduces the comparator it records",
    );

    // The engine's order does not, because B references A.
    let mut dag = MessageDag::new();
    dag.insert(b_entry);
    dag.insert(a_entry);
    assert_eq!(
        dag.display_order().unwrap(),
        vec![a.msg_id(), b.msg_id()],
        "§7 says the DAG's partial order decides; the tie-break only breaks ties"
    );
}

/// The complement: with no causal edge, the tie-break *is* the order.
///
/// This is what made the deleted comparator a scope bug rather than a wrong
/// rule — it was the right rule applied in too many places. It is also why
/// `compare_sort_keys` is still what [`f2z_msg_dag::linearise`] uses to
/// separate concurrent messages.
#[test]
fn with_no_causal_edge_the_two_orders_are_identical() {
    let mut messages = Vec::new();
    for (index, (epoch, leaf)) in [(7u64, 1u32), (7, 0), (8, 3), (6, 2), (7, 1)]
        .into_iter()
        .enumerate()
    {
        let message = AppMessage::seal(AppMessageTbs {
            message_type: MessageType::CHAT,
            parents: Parents::empty(),
            epoch,
            sender_leaf_index: leaf,
            sent_at: SentAt::new(9_999 - index as u64),
            retention_class: RetentionClass::Chat,
            body: Body::new(format!("m{index}").into_bytes()).unwrap(),
        })
        .unwrap();
        messages.push((message, epoch, leaf));
    }

    let mut dag = MessageDag::new();
    for (message, epoch, leaf) in &messages {
        dag.insert(DagEntry::from_delivered(message, *epoch, *leaf).unwrap());
    }

    let mut expected: Vec<SortKey> = messages
        .iter()
        .map(|(message, epoch, leaf)| key(*epoch, *leaf, message.msg_id()))
        .collect();
    expected.sort_by(typescript_compare_messages);

    assert_eq!(
        dag.display_order().unwrap(),
        expected.iter().map(|k| k.msg_id).collect::<Vec<MsgId>>()
    );
}
