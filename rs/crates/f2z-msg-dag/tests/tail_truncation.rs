//! The limit, asserted as a limit.
//!
//! # Read this before "fixing" the DAG
//!
//! Hash links detect a **dropped middle** and nothing else. If a relay drops
//! the last *k* messages from a sender and no later message arrives, no message
//! ever references them, so there is no dangling parent and there is nothing to
//! notice. This is not an oversight in the implementation below and it is not
//! something a cleverer traversal recovers.
//!
//! `ARCHITECTURE.md` §7:
//!
//! > **What hash links do NOT detect: tail truncation.** If a relay drops the
//! > last *k* messages from a sender and no later message arrives, there is no
//! > dangling parent to notice. Detecting suppression of the tail requires
//! > liveness signals — periodic authenticated heartbeats carrying the sender's
//! > current DAG head — and even then, an adversary that partitions a peer
//! > entirely is indistinguishable from that peer being offline. […] no
//! > protocol fixes this.
//!
//! `THREAT-MODEL.md` §4.4 says the same thing from the adversary's side.
//!
//! So the test below **passes when detection fails**, and it is named for that.
//! A future contributor who reads `has_detected_gaps() == false` here and takes
//! it for a bug will find this file instead of a subtle rewrite of
//! [`MessageDag::insert`], and a change that made the DAG "catch" this case
//! would break this test loudly — which is the point. The only honest fixes are
//! outside this crate: a heartbeat carrying the sender's current head, and a UI
//! that never says "nothing is missing".
//!
//! # What *is* enforced here
//!
//! Two things, and both are real:
//!
//! - `has_detected_gaps()` means "no gap **detected**", and every accessor on
//!   [`MessageDag`] is named so a caller cannot read it as "nothing missing".
//! - One message arriving *after* the truncated tail turns the whole thing into
//!   an ordinary dropped middle, which is detected exactly. The undetectability
//!   is a property of the tail being the tail, not of the messages.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::Body;
use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, MessageDag, MessageType, MsgId, Parents, RetentionClass,
    SentAt,
};

const EPOCH: u64 = 7;
const SENDER_LEAF: u32 = 1;

/// A linear chain of `count` messages, each referencing the one before it.
fn chain(count: usize) -> Vec<AppMessage> {
    let mut out: Vec<AppMessage> = Vec::new();
    for index in 0..count {
        let parents = match out.last() {
            None => Parents::empty(),
            Some(previous) => Parents::new(vec![previous.msg_id()]).unwrap(),
        };
        out.push(
            AppMessage::seal(AppMessageTbs {
                message_type: MessageType::CHAT,
                parents,
                epoch: EPOCH,
                sent_at: SentAt::new(1_700_000_000_000 + index as u64),
                retention_class: RetentionClass::Chat,
                body: Body::new(format!("message {index}").into_bytes()).unwrap(),
            })
            .unwrap(),
        );
    }
    out
}

fn deliver(dag: &mut MessageDag, message: &AppMessage) {
    dag.insert(DagEntry::from_delivered(message, EPOCH, SENDER_LEAF).unwrap());
}

/// **This test asserts that detection FAILS. That is the specification.**
///
/// Do not change it to assert a gap is found. If a change to this crate makes
/// it start finding one, the change is wrong — or the threat model moved, in
/// which case `ARCHITECTURE.md` §7 and `THREAT-MODEL.md` §4.4 move first.
#[test]
fn tail_truncation_is_undetectable_by_design() {
    let messages = chain(10);

    for dropped in 1..=5usize {
        let mut dag = MessageDag::new();
        let kept = messages.len() - dropped;
        for message in messages.iter().take(kept) {
            deliver(&mut dag, message);
        }

        assert_eq!(dag.len(), kept);
        assert!(
            !dag.has_detected_gaps(),
            "dropping the last {dropped} messages left a dangling parent, which cannot \
             happen: nothing the receiver holds references them"
        );
        assert!(dag.detected_gaps().is_empty());
        assert!(dag.take_gap_request().is_empty());
        assert!(dag.unrecoverable_gaps().is_empty());

        // And the transcript renders perfectly happily, which is exactly the
        // failure mode: the receiver has a complete, correctly ordered,
        // internally consistent view of a conversation that has been censored.
        let order = dag.display_order().unwrap();
        assert_eq!(order.len(), kept);
        let expected: Vec<MsgId> = messages.iter().take(kept).map(AppMessage::msg_id).collect();
        assert_eq!(order, expected);
    }
}

/// The complement, and the reason the limit is about the *tail* rather than
/// about the messages: the same drop, with one later message, is caught.
#[test]
fn the_same_drop_is_detected_the_moment_anything_later_arrives() {
    let messages = chain(10);
    let mut dag = MessageDag::new();

    // Everything except messages 7, 8, 9 …
    for message in messages.iter().take(7) {
        deliver(&mut dag, message);
    }
    assert!(!dag.has_detected_gaps(), "still a tail; still invisible");

    // … then one more message, authored after them, referencing message 9.
    let later = AppMessage::seal(AppMessageTbs {
        message_type: MessageType::CHAT,
        parents: Parents::new(vec![messages[9].msg_id()]).unwrap(),
        epoch: EPOCH,
        sent_at: SentAt::new(1_700_000_100_000),
        retention_class: RetentionClass::Chat,
        body: Body::new(b"and one more".to_vec()).unwrap(),
    })
    .unwrap();
    deliver(&mut dag, &later);

    assert_eq!(
        dag.detected_gaps(),
        vec![messages[9].msg_id()],
        "the tail stopped being the tail, so the hole became a dangling parent"
    );
}

/// The naming half of the guarantee. Nothing on [`MessageDag`] offers a caller
/// a way to ask "is anything missing?", because the honest answer is not
/// computable and an API that appeared to answer it would be used.
#[test]
fn nothing_on_the_api_claims_to_know_whether_anything_is_missing() {
    let mut dag = MessageDag::new();
    for message in chain(3) {
        deliver(&mut dag, &message);
    }
    // `has_detected_gaps` — detected. `detected_gaps` — detected.
    // `unrecoverable_gaps` — gaps somebody already knows about. There is no
    // `is_complete`, and there must never be one.
    assert!(!dag.has_detected_gaps());
    assert!(dag.detected_gaps().is_empty());
    assert!(dag.unrecoverable_gaps().is_empty());
}
