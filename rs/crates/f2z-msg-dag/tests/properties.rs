//! Properties over random interleavings, not worked examples.
//!
//! A worked example proves the code does the right thing on the graph its
//! author drew. The interesting failures in a causal-ordering layer are the
//! graphs nobody would draw: a message whose parents span three senders and two
//! epochs, delivered fifth, after the message that depends on it, twice, from
//! two relays. So every property below is generated — a random DAG, a random
//! delivery order, a random set of drops — and asserted over the whole space.
//!
//! Each `proptest!` block below is one of the acceptance criteria for
//! `ARCHITECTURE.md` §7.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use std::collections::{BTreeMap, BTreeSet};

use f2z_codec::types::Body;
use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, Insertion, MessageDag, MessageType, MsgId, Parents,
    RetentionClass, SentAt,
};
use proptest::prelude::*;

/// One authored message plus the framing facts a receiver would learn from MLS.
#[derive(Clone, Debug)]
struct Authored {
    message: AppMessage,
    epoch: u64,
    leaf: u32,
}

impl Authored {
    fn entry(&self) -> DagEntry {
        DagEntry::from_delivered(&self.message, self.epoch, self.leaf).unwrap()
    }

    fn msg_id(&self) -> MsgId {
        self.message.msg_id()
    }
}

/// Build a random causal DAG.
///
/// Each message picks its parents from *earlier* messages only, which is what
/// causality means and is what a real sender's head set produces. Epochs are
/// non-decreasing along the authoring order for the same reason: a sender
/// cannot author in an epoch it has not reached.
///
/// The leaf indices are deliberately drawn to make the sort key fight the
/// causal order as often as possible — a reply from a low leaf index to a high
/// one is the case where the tie-break alone gets the transcript wrong.
fn authored_dag(count: usize) -> impl Strategy<Value = Vec<Authored>> {
    let plan = proptest::collection::vec((0u32..4, 0u64..3, any::<u64>(), 0u8..100), count);
    plan.prop_map(|rows| {
        let mut out: Vec<Authored> = Vec::new();
        let mut epoch = 0u64;
        for (index, (leaf, epoch_step, sent_at, parent_dice)) in rows.into_iter().enumerate() {
            epoch = epoch.saturating_add(epoch_step);

            // Parents: a subset of the messages authored so far, chosen so that
            // roughly a third of messages fork and the rest chain.
            let mut parents: Vec<MsgId> = Vec::new();
            if !out.is_empty() {
                let take = usize::from(parent_dice % 3)
                    .saturating_add(1)
                    .min(out.len());
                for step in 0..take {
                    let at = out
                        .len()
                        .saturating_sub(1)
                        .saturating_sub(step.saturating_mul(usize::from(parent_dice % 2) + 1));
                    if let Some(candidate) = out.get(at)
                        && !parents.contains(&candidate.msg_id())
                    {
                        parents.push(candidate.msg_id());
                    }
                }
            }

            let message = AppMessage::seal(AppMessageTbs {
                message_type: MessageType::CHAT,
                parents: Parents::new(parents).unwrap(),
                epoch,
                // Deliberately random and deliberately unordered. If anything
                // in this crate started ordering by it, these properties would
                // fail — which is the second line of defence behind `SentAt`
                // having no `Ord` at all.
                sent_at: SentAt::new(sent_at),
                retention_class: RetentionClass::Chat,
                body: Body::new(format!("m{index}").into_bytes()).unwrap(),
            })
            .unwrap();

            out.push(Authored {
                message,
                epoch,
                leaf,
            });
        }
        out
    })
}

/// A permutation of `0..len`, for shuffling the delivery order.
fn permutation(len: usize) -> impl Strategy<Value = Vec<usize>> {
    Just((0..len).collect::<Vec<usize>>()).prop_shuffle()
}

fn ancestors(authored: &[Authored]) -> BTreeMap<MsgId, BTreeSet<MsgId>> {
    let mut out: BTreeMap<MsgId, BTreeSet<MsgId>> = BTreeMap::new();
    for item in authored {
        let mut set: BTreeSet<MsgId> = BTreeSet::new();
        for parent in item.message.tbs().parents.as_slice() {
            set.insert(*parent);
            if let Some(grand) = out.get(parent) {
                set.extend(grand.iter().copied());
            }
        }
        out.insert(item.msg_id(), set);
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// **Ordering is deterministic and total across shuffled delivery orders.**
    ///
    /// The same set of messages, delivered in any order, produces the same
    /// transcript. This is §7's "every client that applies this rule to the
    /// same set of messages produces the same transcript" — the property that
    /// makes the DAG an ordering rule rather than a suggestion.
    #[test]
    fn the_display_order_does_not_depend_on_the_delivery_order(
        authored in authored_dag(12),
        first in permutation(12),
        second in permutation(12),
    ) {
        let mut one = MessageDag::new();
        for at in &first {
            one.insert(authored[*at].entry());
        }
        let mut other = MessageDag::new();
        for at in &second {
            other.insert(authored[*at].entry());
        }

        let left = one.display_order().unwrap();
        let right = other.display_order().unwrap();
        prop_assert_eq!(&left, &right);
        prop_assert_eq!(left.len(), authored.len());

        // Total: no repeats, everything present.
        let unique: BTreeSet<MsgId> = left.iter().copied().collect();
        prop_assert_eq!(unique.len(), left.len());
    }

    /// **The display order is a linear extension of the causal order.**
    ///
    /// Every ancestor precedes every descendant. This is the half of §7 that a
    /// sort-key-only comparator does not have — see `typescript_parity.rs`.
    #[test]
    fn every_ancestor_precedes_every_descendant(
        authored in authored_dag(12),
        order in permutation(12),
    ) {
        let mut dag = MessageDag::new();
        for at in &order {
            dag.insert(authored[*at].entry());
        }

        let transcript = dag.display_order().unwrap();
        let position: BTreeMap<MsgId, usize> = transcript
            .iter()
            .enumerate()
            .map(|(at, id)| (*id, at))
            .collect();

        for (id, forebears) in ancestors(&authored) {
            for forebear in forebears {
                prop_assert!(
                    position[&forebear] < position[&id],
                    "a descendant rendered above its ancestor"
                );
            }
        }
    }

    /// **Every dropped middle message produces exactly one gap signal.**
    ///
    /// One dropped message, however many later messages reference it, and
    /// however many times each of those arrives, yields one hash in one
    /// `gap_request` — and never a second one.
    #[test]
    fn a_dropped_middle_message_produces_exactly_one_gap_signal(
        authored in authored_dag(12),
        order in permutation(12),
        drop_at in 0usize..12,
        repeats in 1usize..4,
    ) {
        let dropped = authored[drop_at].msg_id();
        let mut dag = MessageDag::new();

        let mut signalled: Vec<MsgId> = Vec::new();
        for at in &order {
            if *at == drop_at {
                continue;
            }
            for _ in 0..repeats {
                if let Insertion::Accepted { newly_missing } = dag.insert(authored[*at].entry()) {
                    signalled.extend(newly_missing);
                }
            }
        }

        let referenced = authored
            .iter()
            .enumerate()
            .any(|(at, item)| {
                at != drop_at && item.message.tbs().parents.as_slice().contains(&dropped)
            });

        if referenced {
            prop_assert_eq!(
                signalled.iter().filter(|id| **id == dropped).count(),
                1,
                "one hole must produce one signal, not one per referrer"
            );
            // A shuffled delivery order also produces *transient* gaps — a
            // child arriving before its parent — and those close by themselves
            // when the parent lands. What must survive to the end is exactly
            // the one message that never arrives.
            prop_assert_eq!(dag.detected_gaps(), vec![dropped]);
            prop_assert_eq!(dag.take_gap_request(), vec![dropped]);
            prop_assert!(
                dag.take_gap_request().is_empty(),
                "a gap already asked about must never be asked about twice"
            );
        } else {
            // Nothing references it: this is the tail-truncation case, and it
            // is undetectable. See `tail_truncation.rs`.
            prop_assert!(!signalled.contains(&dropped));
            prop_assert!(dag.detected_gaps().is_empty());
        }
    }

    /// **Dedup holds when the same `msg_id` arrives *k* times.**
    ///
    /// §9.4's *k*-relay fan-out. The transcript, the gap set and the head set
    /// must all be identical to the single-delivery case.
    #[test]
    fn k_deliveries_of_the_same_message_are_indistinguishable_from_one(
        authored in authored_dag(10),
        order in permutation(10),
        k in 2usize..6,
    ) {
        let mut once = MessageDag::new();
        for at in &order {
            once.insert(authored[*at].entry());
        }

        let mut many = MessageDag::new();
        let mut duplicates = 0usize;
        for at in &order {
            for round in 0..k {
                let outcome = many.insert(authored[*at].entry());
                if round > 0 {
                    prop_assert_eq!(outcome, Insertion::Duplicate);
                    duplicates += 1;
                }
            }
        }

        prop_assert_eq!(duplicates, authored.len() * (k - 1));
        prop_assert_eq!(many.len(), once.len());
        prop_assert_eq!(many.display_order().unwrap(), once.display_order().unwrap());
        prop_assert_eq!(many.heads(), once.heads());
        prop_assert_eq!(many.detected_gaps(), once.detected_gaps());
    }

    /// **A repaired message closes the gap and lands in the right place.**
    ///
    /// The message the receiver missed, admitted through the repair path, must
    /// produce the same transcript as if it had never been dropped — because
    /// the repairing peer here *is* the original sender, which is the case §7
    /// specifies.
    #[test]
    fn a_repaired_message_restores_the_transcript_exactly(
        authored in authored_dag(10),
        order in permutation(10),
        drop_at in 0usize..10,
    ) {
        let mut complete = MessageDag::new();
        for at in &order {
            complete.insert(authored[*at].entry());
        }

        let mut repaired = MessageDag::new();
        for at in &order {
            if *at != drop_at {
                repaired.insert(authored[*at].entry());
            }
        }
        // Repair arrives last, out of order, as it would in practice.
        repaired.insert(DagEntry::from_repair(
            &authored[drop_at].message,
            authored[drop_at].leaf,
        ));

        prop_assert!(!repaired.has_detected_gaps());
        prop_assert_eq!(
            repaired.display_order().unwrap(),
            complete.display_order().unwrap()
        );
    }

    /// **An adversarial clock cannot reorder a causally ordered conversation.**
    ///
    /// The sharpest thing a lying `sent_at` could buy an attacker is a message
    /// of theirs rendered above one it actually answers. Here the conversation
    /// is a chain — every message references the one before it — so causality
    /// decides every pair, and the claimed clock is drawn adversarially:
    /// ascending, descending, all-identical, and uniformly random. The
    /// transcript is the chain in all four cases.
    ///
    /// The ids differ between the four runs, because `sent_at` is *inside* the
    /// hash — advisory means "never ordered by", not "not committed to" — so
    /// the assertion is over authoring positions rather than over ids.
    #[test]
    fn an_adversarial_clock_cannot_reorder_a_causal_chain(
        leaves in proptest::collection::vec(0u32..4, 8),
        epoch_steps in proptest::collection::vec(0u64..3, 8),
        noise in proptest::collection::vec(any::<u64>(), 8),
        order in permutation(8),
    ) {
        let chain = |clock: &dyn Fn(usize) -> u64| -> Vec<Authored> {
            let mut out: Vec<Authored> = Vec::new();
            let mut epoch = 0u64;
            for index in 0..8usize {
                epoch = epoch.saturating_add(epoch_steps[index]);
                let parents = match out.last() {
                    None => Parents::empty(),
                    Some(previous) => Parents::new(vec![previous.msg_id()]).unwrap(),
                };
                let message = AppMessage::seal(AppMessageTbs {
                    message_type: MessageType::CHAT,
                    parents,
                    epoch,
                    sent_at: SentAt::new(clock(index)),
                    retention_class: RetentionClass::Chat,
                    body: Body::new(format!("m{index}").into_bytes()).unwrap(),
                })
                .unwrap();
                out.push(Authored { message, epoch, leaf: leaves[index] });
            }
            out
        };

        let transcript = |set: &[Authored]| -> Vec<usize> {
            let mut dag = MessageDag::new();
            for at in &order {
                dag.insert(set[*at].entry());
            }
            dag.display_order()
                .unwrap()
                .iter()
                .map(|id| set.iter().position(|item| item.msg_id() == *id).unwrap())
                .collect()
        };

        let authoring_order: Vec<usize> = (0..8).collect();

        let ascending: &dyn Fn(usize) -> u64 = &|index| 1_000u64.saturating_add(index as u64);
        let descending: &dyn Fn(usize) -> u64 = &|index| 1_000_000u64.saturating_sub(index as u64);
        let frozen: &dyn Fn(usize) -> u64 = &|_| 0;
        let random: &dyn Fn(usize) -> u64 = &|index| noise[index];

        prop_assert_eq!(transcript(&chain(ascending)), authoring_order.clone());
        prop_assert_eq!(transcript(&chain(descending)), authoring_order.clone());
        prop_assert_eq!(transcript(&chain(frozen)), authoring_order.clone());
        prop_assert_eq!(transcript(&chain(random)), authoring_order.clone());
    }

    /// **Two concurrent messages are separated by the sort key, never by the
    /// clock.**
    ///
    /// The other half of the previous property. With no causal edge between
    /// them, §7 says `(epoch, sender_leaf_index, msg_id)` decides — and the
    /// claimed clock, however it is drawn, does not appear in that tuple.
    #[test]
    fn two_concurrent_messages_are_separated_by_the_sort_key(
        left_leaf in 0u32..4,
        right_leaf in 0u32..4,
        left_epoch in 0u64..3,
        right_epoch in 0u64..3,
        left_clock in any::<u64>(),
        right_clock in any::<u64>(),
        swap in any::<bool>(),
    ) {
        let make = |epoch: u64, clock: u64, tag: &str| {
            AppMessage::seal(AppMessageTbs {
                message_type: MessageType::CHAT,
                parents: Parents::empty(),
                epoch,
                sent_at: SentAt::new(clock),
                retention_class: RetentionClass::Chat,
                body: Body::new(tag.as_bytes().to_vec()).unwrap(),
            })
            .unwrap()
        };

        let left = Authored { message: make(left_epoch, left_clock, "left"), epoch: left_epoch, leaf: left_leaf };
        let right = Authored { message: make(right_epoch, right_clock, "right"), epoch: right_epoch, leaf: right_leaf };

        let mut dag = MessageDag::new();
        if swap {
            dag.insert(right.entry());
            dag.insert(left.entry());
        } else {
            dag.insert(left.entry());
            dag.insert(right.entry());
        }

        let transcript = dag.display_order().unwrap();
        let expected_first = if left.entry().sort_key() < right.entry().sort_key() {
            left.msg_id()
        } else {
            right.msg_id()
        };
        prop_assert_eq!(transcript[0], expected_first);
    }
}
