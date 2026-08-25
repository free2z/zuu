//! Two receivers, one message, two routes — and one transcript.
//!
//! This is the acceptance criterion of
//! [#734](https://github.com/free2z/zuu/issues/734), and the reason `ARCHITECTURE.md`
//! §7 moved `sender_leaf_index` inside the hashed `AppMessage` on 2026-08-25.
//!
//! # The defect this file rules out
//!
//! §7's guarantee is that *every client that applies this rule to the same set
//! of messages produces the same transcript*. That is a claim about a **set of
//! messages**, and it is only true if a message's sort key is a property of the
//! message rather than of the delivery that happened to carry it.
//!
//! It used not to be. `sender_leaf_index` lived only in MLS framing, `msg_id`
//! did not commit to it, and §7's repair path delivers a message **outside** its
//! original framing: the responder re-encrypts the plaintext under the current
//! epoch, so the framing that arrives with a repair is the responder's. The old
//! `DagEntry::from_repair` therefore had to be *told* a leaf index, and the only
//! one a caller could honestly supply was the responder's own. That was sound
//! for exactly one reason — §7 said only the original sender repairs — and §7
//! never forbade third-party repair, which is the obvious optimisation past two
//! members.
//!
//! Had that landed, the two receivers below would have computed different sort
//! keys for the same `msg_id` and rendered different transcripts while agreeing
//! on every message. Now they cannot: `from_repair` takes no leaf index, because
//! there is nowhere else for one to come from.
//!
//! # What is asserted, and what is deliberately not
//!
//! Asserted: both receivers hold the same set, both derive the same sort key for
//! the repaired message, and both produce the same transcript — including the
//! case where the tie-break, applied on its own, would order the two messages
//! the other way round.
//!
//! Not asserted: that third-party repair is *permitted*. §7 still specifies
//! first-party repair, and this crate's [`PlaintextOutbox`] only ever holds a
//! device's own sends. What the correction removes is the reason it could not
//! be permitted; whether to permit it is a separate decision.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::Body;
use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, MessageDag, MessageType, Parents, RetentionClass, SentAt,
    compare_sort_keys,
};

const EPOCH: u64 = 7;
/// Bob authored the message that gets lost.
const AUTHOR_LEAF: u32 = 1;
/// Alice replied to it, from the *lower* leaf index — the case where the
/// tie-break alone would put the reply first.
const REPLIER_LEAF: u32 = 0;
/// Carol was not involved in either message, and is the third party who
/// answers the `gap_request` in the second route.
const THIRD_PARTY_LEAF: u32 = 2;

fn chat(parents: Parents, leaf: u32, body: &[u8]) -> AppMessage {
    AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents,
        epoch: EPOCH,
        sender_leaf_index: leaf,
        sent_at: SentAt::new(1_700_000_000_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(body.to_vec()).unwrap(),
    })
    .unwrap()
}

/// The acceptance criterion of #734.
#[test]
fn two_receivers_who_learned_one_message_by_different_routes_agree() {
    let authored = chat(Parents::empty(), AUTHOR_LEAF, b"what do you think?");
    let reply = chat(
        Parents::new(vec![authored.msg_id()]).unwrap(),
        REPLIER_LEAF,
        b"I think yes",
    );

    // Receiver one got both messages directly, in their own framing.
    let mut direct = MessageDag::new();
    direct.insert(DagEntry::from_delivered(&authored, EPOCH, AUTHOR_LEAF).unwrap());
    direct.insert(DagEntry::from_delivered(&reply, EPOCH, REPLIER_LEAF).unwrap());

    // Receiver two missed the first message, noticed the hole from the reply's
    // dangling parent, and had it repaired by Carol — a third party, whose
    // framing carries HER leaf index and a LATER epoch. Neither reaches the
    // sort key.
    let mut repaired = MessageDag::new();
    repaired.insert(DagEntry::from_delivered(&reply, EPOCH, REPLIER_LEAF).unwrap());
    assert_eq!(repaired.take_gap_request(), vec![authored.msg_id()]);
    repaired.insert(DagEntry::from_repair(&authored));

    // Same set.
    assert_eq!(direct.len(), repaired.len());
    assert!(!repaired.has_detected_gaps());

    // Same sort key for the message that travelled differently. This is the
    // assertion the whole correction exists for: before it, this one was
    // AUTHOR_LEAF on the left and THIRD_PARTY_LEAF on the right.
    let left = direct.get(&authored.msg_id()).unwrap().sort_key();
    let right = repaired.get(&authored.msg_id()).unwrap().sort_key();
    assert_eq!(left, right);
    assert_eq!(left.sender_leaf_index, AUTHOR_LEAF);
    assert_ne!(
        THIRD_PARTY_LEAF, AUTHOR_LEAF,
        "the third party must differ from the author or this test is vacuous"
    );

    // And therefore the same transcript.
    assert_eq!(
        direct.display_order().unwrap(),
        repaired.display_order().unwrap()
    );
    assert_eq!(
        direct.display_order().unwrap(),
        vec![authored.msg_id(), reply.msg_id()],
        "the reply must render below the message it answers"
    );

    // The tie-break on its own would have ordered these two the other way
    // round, which is what makes the causal half of §7 load-bearing here.
    assert!(
        compare_sort_keys(
            &repaired.get(&reply.msg_id()).unwrap().sort_key(),
            &repaired.get(&authored.msg_id()).unwrap().sort_key(),
        )
        .is_lt()
    );
}

/// The same message admitted by both routes into *one* dag is a duplicate, not
/// a second entry — which is only true because both routes name it identically
/// and derive the same key.
#[test]
fn a_message_learned_twice_by_two_routes_is_one_message() {
    let authored = chat(Parents::empty(), AUTHOR_LEAF, b"heard twice");

    let mut dag = MessageDag::new();
    dag.insert(DagEntry::from_repair(&authored));
    let before = dag.get(&authored.msg_id()).unwrap().sort_key();

    dag.insert(DagEntry::from_delivered(&authored, EPOCH, AUTHOR_LEAF).unwrap());
    assert_eq!(dag.len(), 1);
    assert_eq!(dag.get(&authored.msg_id()).unwrap().sort_key(), before);
}
