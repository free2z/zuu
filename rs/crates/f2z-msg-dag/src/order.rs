//! §7's ordering: a causal partial order, linearised deterministically.
//!
//! # The rule, quoted, because the two halves get conflated
//!
//! > **Causal ordering:** the DAG's partial order. For display, a deterministic
//! > total order breaks ties by `(epoch, sender_leaf_index, msg_id)`.
//! > Wall-clock timestamps are never used to order, because a clock is an
//! > attacker-controlled input.
//!
//! Two rules, and the first one is primary. The DAG's partial order decides
//! every pair of messages that are causally related. `(epoch,
//! sender_leaf_index, msg_id)` decides the pairs that are **concurrent** — the
//! ones the partial order leaves incomparable. It is the *tie*-break, and a
//! tie is exactly the case where neither message is an ancestor of the other.
//!
//! # Why the tie-break alone is not the order
//!
//! Applying the sort key on its own — sorting the message set by the triple and
//! nothing else — puts replies above the messages they reply to. The
//! counterexample is two lines long and it is not exotic:
//!
//! - Bob is leaf 1. At epoch 7 he sends `A`.
//! - Alice is leaf 0. She receives `A` and replies with `B`, `parents = [A]`,
//!   still at epoch 7.
//!
//! Sort keys: `A = (7, 1, …)`, `B = (7, 0, …)`. `B` sorts first, so the reply
//! renders above the message it answers, in every one-to-one conversation where
//! the replier holds the lower leaf index — which is half of them. `A → B` is a
//! causal edge, and the causal edge is what §7 says decides.
//!
//! This matters beyond aesthetics: [`crate::dag::MessageDag`] detects a gap
//! from a `parents` hash it does not hold, and a transcript that can place a
//! child before its parent makes "the hole is here" unanswerable.
//!
//! **`compareMessages` in `wallet/zuuli/src/lib/messaging/types.ts` implements
//! the tie-break only**, which is what a JavaScript comparator can express — a
//! `.sort()` comparator cannot see the graph. The two implementations therefore
//! disagree on exactly the pairs above, and [`compare_sort_keys`] exists so the
//! disagreement is a testable thing in this tree rather than a discovery
//! somebody makes from a screenshot. See `tests/typescript_parity.rs`.
//!
//! # Determinism
//!
//! [`linearise`] is Kahn's algorithm with a min-heap keyed on [`SortKey`]. At
//! every step the set of ready nodes is fully ordered by the sort key, so the
//! output depends on the *graph and the keys* and on nothing else — not on
//! insertion order, not on iteration order, not on a clock. That is what makes
//! "every client that applies this rule to the same set of messages produces
//! the same transcript" true rather than aspirational, and
//! `tests/properties.rs` asserts it over random shuffles.
//!
//! A parent the receiver does not hold contributes **no** constraint: it is not
//! in the graph, so it cannot be ordered against. The hole is reported
//! separately, by [`crate::dag::MessageDag::detected_gaps`], and
//! `CLIENT-CONTRACT.md` §7 is explicit that "a hole in the sort order is not a
//! hole in the conversation and vice versa".

use alloc::collections::{BTreeMap, BTreeSet, BinaryHeap};
use alloc::vec::Vec;
use core::cmp::Reverse;

use crate::error::DagError;
use crate::message::MsgId;

/// §7's tie-break key: `(epoch, sender_leaf_index, msg_id)`.
///
/// All three components are protocol-authenticated — `epoch` and
/// `sender_leaf_index` come from MLS framing, `msg_id` is a hash commitment
/// over the content. The sender's wall clock is not here and cannot be added:
/// [`crate::message::SentAt`] has no `Ord`.
///
/// The derived `Ord` is field order, which is the specified order. Do not
/// reorder the fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SortKey {
    /// The MLS epoch the message was authored in.
    pub epoch: u64,
    /// The sender's MLS leaf index.
    ///
    /// **Not covered by `msg_id`.** It comes from the framing, not from the
    /// hashed message, so a message learned through gap repair carries the
    /// repairing peer's framing rather than the original sender's. See
    /// [`crate::dag::DagEntry::from_repair`].
    pub sender_leaf_index: u32,
    /// The message's name.
    pub msg_id: MsgId,
}

/// §7's tie-break, applied on its own.
///
/// This is `compareMessages` from `wallet/zuuli/src/lib/messaging/types.ts`,
/// transcribed. It is **not** the display order — see the module note — and it
/// is public for exactly two reasons: [`linearise`] needs it to break ties
/// between concurrent messages, and a test needs to be able to show where the
/// two implementations part company.
#[must_use]
pub fn compare_sort_keys(a: &SortKey, b: &SortKey) -> core::cmp::Ordering {
    a.cmp(b)
}

/// One node of the graph to be ordered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderNode {
    /// The node's sort key.
    pub key: SortKey,
    /// The `msg_id`s this message referenced. Parents not present among the
    /// nodes are ignored, because an absent message cannot be ordered against.
    pub parents: Vec<MsgId>,
}

/// Linearise a set of messages into §7's display order.
///
/// A topological order of the causal DAG, with concurrent messages ordered by
/// [`SortKey`]. Deterministic: the same set produces the same sequence on every
/// client, in any delivery order.
///
/// # Errors
///
/// [`DagError::Cycle`] if the held messages contain a cycle. That requires a
/// BLAKE2b-256 preimage cycle, so in practice it means the caller has fed this
/// function something that is not a message graph. It is an error rather than a
/// silent truncation because dropping messages from a transcript is worse than
/// refusing to render one.
pub fn linearise(nodes: &[OrderNode]) -> Result<Vec<MsgId>, DagError> {
    let held: BTreeMap<MsgId, SortKey> = nodes
        .iter()
        .map(|node| (node.key.msg_id, node.key))
        .collect();

    // parent -> children, and the in-degree counted over *held* parents only.
    let mut children: BTreeMap<MsgId, BTreeSet<MsgId>> = BTreeMap::new();
    let mut indegree: BTreeMap<MsgId, usize> = BTreeMap::new();

    for node in nodes {
        let id = node.key.msg_id;
        let mut degree = 0usize;
        for parent in &node.parents {
            if !held.contains_key(parent) {
                continue;
            }
            if children.entry(*parent).or_default().insert(id) {
                degree = degree.saturating_add(1);
            }
        }
        indegree.insert(id, degree);
    }

    let mut ready: BinaryHeap<Reverse<SortKey>> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .filter_map(|(id, _)| held.get(id).map(|key| Reverse(*key)))
        .collect();

    let mut out = Vec::with_capacity(held.len());
    while let Some(Reverse(key)) = ready.pop() {
        out.push(key.msg_id);
        let Some(dependents) = children.get(&key.msg_id) else {
            continue;
        };
        for child in dependents {
            let Some(degree) = indegree.get_mut(child) else {
                continue;
            };
            *degree = degree.saturating_sub(1);
            if *degree == 0 {
                if let Some(child_key) = held.get(child) {
                    ready.push(Reverse(*child_key));
                }
            }
        }
    }

    if out.len() != held.len() {
        return Err(DagError::Cycle);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn id(byte: u8) -> MsgId {
        MsgId::new([byte; MsgId::LEN])
    }

    fn node(byte: u8, epoch: u64, leaf: u32, parents: &[u8]) -> OrderNode {
        OrderNode {
            key: SortKey {
                epoch,
                sender_leaf_index: leaf,
                msg_id: id(byte),
            },
            parents: parents.iter().copied().map(id).collect(),
        }
    }

    /// The counterexample from the module note, as a test.
    #[test]
    fn a_reply_never_precedes_the_message_it_replies_to() {
        // Bob (leaf 1) sends A; Alice (leaf 0) replies with B, same epoch.
        let a = node(0xaa, 7, 1, &[]);
        let b = node(0xbb, 7, 0, &[0xaa]);

        // The tie-break alone would place the reply first.
        assert!(compare_sort_keys(&b.key, &a.key).is_lt());

        // The causal order does not.
        let order = linearise(&[a.clone(), b.clone()]).unwrap();
        assert_eq!(order, vec![id(0xaa), id(0xbb)]);
    }

    #[test]
    fn concurrent_messages_fall_back_to_the_sort_key() {
        // No edges between them: epoch, then leaf index, then msg_id.
        let older_epoch = node(0xff, 6, 9, &[]);
        let lower_leaf = node(0x01, 7, 0, &[]);
        let higher_leaf = node(0x00, 7, 1, &[]);
        let order = linearise(&[higher_leaf, lower_leaf, older_epoch]).unwrap();
        assert_eq!(order, vec![id(0xff), id(0x01), id(0x00)]);
    }

    #[test]
    fn a_parent_the_receiver_does_not_hold_imposes_no_constraint() {
        let orphan = node(0x01, 7, 0, &[0xee]);
        assert_eq!(linearise(&[orphan]).unwrap(), vec![id(0x01)]);
    }

    #[test]
    fn a_cycle_is_reported_rather_than_truncating_the_transcript() {
        let a = node(0x01, 7, 0, &[0x02]);
        let b = node(0x02, 7, 0, &[0x01]);
        assert_eq!(linearise(&[a, b]), Err(DagError::Cycle));
    }

    #[test]
    fn the_order_is_a_linear_extension_of_a_deep_chain() {
        // A chain built so that every sort key points the *wrong* way: each
        // child has a strictly lower leaf index than its parent, so a
        // key-only sort would reverse the whole conversation.
        let mut nodes = Vec::new();
        for step in 0u8..8 {
            let leaf = u32::from(8u8.saturating_sub(step));
            let parents: Vec<u8> = if step == 0 { vec![] } else { vec![step - 1] };
            nodes.push(node(step, 7, leaf, &parents));
        }
        let expected: Vec<MsgId> = (0u8..8).map(id).collect();
        assert_eq!(linearise(&nodes).unwrap(), expected);
    }
}
