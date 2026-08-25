//! Where this crate and the shipped TypeScript client agree about §7's order,
//! and the one place they do not.
//!
//! # The other implementation
//!
//! `wallet/zuuli/src/lib/messaging/types.ts`:
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
//! and `wallet/zuuli/src/features/messages/Transcript.tsx` applies it as
//! `[...messages].sort(compareMessages)` — that is the entire ordering the UI
//! performs. Nothing there reads `parents`.
//!
//! # Where they agree: the tie-break
//!
//! [`f2z_msg_dag::compare_sort_keys`] is that function, field for field, and
//! the tests below check the agreement includes the parts that are easy to get
//! wrong across a language boundary:
//!
//! - `epoch` first, then `senderLeafIndex`, then `msgId` — and `msgId`
//!   compared as **bytes** here against a **string** there, which agree because
//!   base16 is order-preserving in a single case (`MsgId::to_lower_hex`).
//! - `sentAt` appears in neither. In this crate it *cannot*: [`SentAt`] has no
//!   `Ord`.
//!
//! # Where they disagree: the tie-break is not the order
//!
//! §7's rule has two halves — "the DAG's partial order", and a total order that
//! "breaks **ties**". A tie is a pair of *concurrent* messages, the ones the
//! partial order leaves incomparable. Applying the tie-break to every pair,
//! including causally related ones, is a different rule, and it produces a
//! different transcript.
//!
//! `causal_order_and_the_typescript_comparator_disagree_on_a_reply` below is
//! the smallest case, and it is not a corner: it fires in every one-to-one
//! conversation where the person replying holds the lower MLS leaf index, which
//! is half of them.
//!
//! **This is a defect in the TypeScript client, not a difference of opinion**,
//! and it is reported on the pull request rather than worked around here. A
//! JavaScript `Array.prototype.sort` comparator cannot express a topological
//! order — it only ever sees two elements — so the fix is a pass over the graph
//! before the sort, not a cleverer comparator.

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

/// `compareMessages`, transcribed. Kept as a separate function from
/// [`compare_sort_keys`] so that the transcription is visible rather than
/// assumed, and so a future change to either one shows up as a failing test
/// instead of as a silent convergence.
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

#[test]
fn the_tie_break_agrees_field_for_field() {
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

/// **The disagreement, executable.**
///
/// Bob (leaf 1) sends `A`. Alice (leaf 0) replies with `B`, `parents = [A]`,
/// in the same epoch. `compareMessages` puts the reply first. The causal order
/// does not.
///
/// This test asserting a disagreement is deliberate: it documents a live defect
/// in `wallet/zuuli/src/features/messages/Transcript.tsx`. When that is fixed —
/// a topological pass before the sort — this test should be updated to assert
/// agreement, and not before.
#[test]
fn causal_order_and_the_typescript_comparator_disagree_on_a_reply() {
    let a = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents: Parents::empty(),
        epoch: 7,
        sent_at: SentAt::new(1_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(b"what do you think?".to_vec()).unwrap(),
    })
    .unwrap();

    let b = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents: Parents::new(vec![a.msg_id()]).unwrap(),
        epoch: 7,
        sent_at: SentAt::new(2_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(b"I think yes".to_vec()).unwrap(),
    })
    .unwrap();

    // Bob is leaf 1 and sent A; Alice is leaf 0 and replied with B.
    let a_entry = DagEntry::from_delivered(&a, 7, 1).unwrap();
    let b_entry = DagEntry::from_delivered(&b, 7, 0).unwrap();

    // The tie-break alone — which is what the TypeScript client applies to
    // every pair — puts the reply first.
    assert_eq!(
        typescript_compare_messages(&b_entry.sort_key(), &a_entry.sort_key()),
        Ordering::Less,
        "the transcribed comparator no longer reproduces the shipped one",
    );

    // The causal order does not, because B references A.
    let mut dag = MessageDag::new();
    dag.insert(b_entry);
    dag.insert(a_entry);
    assert_eq!(
        dag.display_order().unwrap(),
        vec![a.msg_id(), b.msg_id()],
        "§7 says the DAG's partial order decides; the tie-break only breaks ties"
    );
}

/// The complement: with no causal edge, the two agree exactly.
///
/// This is what makes the defect above narrow enough to be a real bug rather
/// than a rewrite — the comparator is the right rule applied in too many
/// places, not the wrong rule.
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
