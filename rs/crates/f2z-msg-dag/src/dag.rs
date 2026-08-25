//! The receiver's view: dedup, gap detection, heads, and the display order.
//!
//! # What a gap is, and what it is not
//!
//! §7: "a receiver that sees a `parents` hash it does not hold knows, with
//! certainty and without any server assistance, that it is missing a message."
//! That is the whole mechanism, and its two properties are worth separating:
//!
//! - **It is certain.** A dangling parent is not a heuristic about latency or a
//!   suspicion about a relay. The sender committed to that hash, inside MLS, in
//!   an authenticated message. Either the receiver holds it or it does not.
//! - **It is incomplete.** Hash links detect a *dropped middle*, and nothing
//!   else. If a relay drops the last `k` messages from a sender and nothing
//!   later arrives, no message ever references them and there is no dangling
//!   parent to notice. `tests/tail_truncation.rs` asserts that limit as a
//!   limit; `THREAT-MODEL.md` §4.4 and §7 both state it; no protocol fixes it.
//!
//! So [`MessageDag::has_detected_gaps`] returning `false` means "no detected
//! gap", never "nothing is missing", and `CLIENT-CONTRACT.md` §3.5 forbids any
//! string that implies the latter.
//!
//! # Dedup is by `msg_id` and by nothing else
//!
//! `ARCHITECTURE.md` §9.4: a device may publish queue addresses on *k* relays
//! and a sender sends to all *k*, so receiving the identical message *k* times
//! is the normal case rather than an anomaly. `msg_id` is a hash commitment
//! over the content, so two arrivals of one message are byte-identical by
//! construction. Deduplicating on anything else — a client reference, a
//! `(sender, sent_at)` tuple — would either miss real duplicates or collapse
//! two genuinely distinct messages, and `sent_at` in particular is
//! attacker-chosen.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

use crate::error::DagError;
use crate::message::{AppMessage, MsgId, RetentionClass, SentAt};
use crate::order::{OrderNode, SortKey, linearise};

/// Where a message came from.
///
/// It no longer decides how the sort key was obtained — since §7's 2026-08-25
/// correction both components of the key that are not `msg_id` are hashed
/// fields, so the key is identical whichever arm produced the entry. What
/// provenance still records is what the *framing* authenticated, which is a
/// different fact and is worth keeping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum Provenance {
    /// Delivered inside its own MLS framing, which authenticated the sender
    /// and agreed with the message's own `epoch` and `sender_leaf_index`.
    Delivered,
    /// Reconstructed from a `gap_response` (§7's repair). The message content
    /// is verified against the `msg_id` that was requested — a hash commitment
    /// — but the framing that carried it was the *repairing* peer's, so it
    /// authenticates the repairer and not the author.
    Repaired,
}

/// A message as the DAG holds it: its name, its edges, and its sort key.
///
/// Deliberately not the whole [`AppMessage`]: the body is the application's
/// business and the store's, not the ordering layer's. Keeping the plaintext
/// out of this structure also keeps it out of every `Debug` line the ordering
/// layer could produce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DagEntry {
    key: SortKey,
    parents: Vec<MsgId>,
    retention_class: RetentionClass,
    sent_at: SentAt,
    provenance: Provenance,
}

impl DagEntry {
    /// Admit a message that arrived inside its own MLS framing.
    ///
    /// `epoch` and `sender_leaf_index` here are the **framing's** — they come
    /// from `f2z_msg_mls::Received::Application` and are authenticated by MLS.
    /// They are not what the sort key is built from: since §7's 2026-08-25
    /// correction the message carries both, `msg_id` commits to both, and the
    /// message's own values are authoritative. The framing values are passed
    /// in so they can be **cross-checked**, which is the whole reason the
    /// correction chose one authoritative field over two sources of truth.
    ///
    /// Both mismatches are fatal, for the same reason. The fields are inside
    /// the hash and the framing is not, so a disagreement is a sender claiming
    /// to have authored somewhere it did not encrypt from. Accepting either
    /// would let a sender place its message anywhere in the transcript it
    /// liked, which is precisely the power §7 takes away from the clock.
    ///
    /// # Errors
    ///
    /// - [`DagError::EpochMismatch`] if the two epochs disagree.
    /// - [`DagError::LeafIndexMismatch`] if the two leaf indices disagree.
    pub fn from_delivered(
        message: &AppMessage,
        epoch: u64,
        sender_leaf_index: u32,
    ) -> Result<Self, DagError> {
        if message.tbs().epoch != epoch {
            return Err(DagError::EpochMismatch);
        }
        if message.tbs().sender_leaf_index != sender_leaf_index {
            return Err(DagError::LeafIndexMismatch);
        }
        Ok(Self {
            key: SortKey {
                epoch,
                sender_leaf_index,
                msg_id: message.msg_id(),
            },
            parents: message.tbs().parents.as_slice().to_vec(),
            retention_class: message.tbs().retention_class,
            sent_at: message.tbs().sent_at,
            provenance: Provenance::Delivered,
        })
    }

    /// Admit a message reconstructed from a `gap_response`.
    ///
    /// **Both** the epoch and the leaf index come from the message's own
    /// hashed fields, never from the framing that carried the repair. §7's
    /// repair re-encrypts the original plaintext under the *current* epoch, so
    /// a repair's framing describes the repair rather than the message: its
    /// epoch is later than the message's by construction, and its leaf index is
    /// the repairer's. Reading either off the framing would move the message in
    /// the transcript.
    ///
    /// # This is the function §7's 2026-08-25 correction was made for
    ///
    /// It used to take `original_sender_leaf_index` as a parameter, because
    /// `msg_id` did not commit to it and a repaired message therefore had no
    /// leaf index it could prove. The caller had to supply one, and the only
    /// value it could honestly supply was the repairing peer's own — which is
    /// correct exactly while §7's "*the sender* re-encrypts the original
    /// plaintext" holds, and silently wrong the moment a third member answers
    /// a `gap_request`. Two receivers who learned one message by different
    /// routes would then compute different sort keys for the same `msg_id` and
    /// render different transcripts while agreeing on every message.
    ///
    /// With the leaf index inside the hash the parameter has nothing to be:
    /// the message carries the author's index, `msg_id` commits to it, and
    /// `RepairEntry::accept` has already checked the bytes against the
    /// requested `msg_id`. A third-party repair therefore yields byte-identical
    /// entries to a first-party one — asserted in `tests/two_routes.rs`.
    #[must_use]
    pub fn from_repair(message: &AppMessage) -> Self {
        Self {
            key: SortKey {
                epoch: message.tbs().epoch,
                sender_leaf_index: message.tbs().sender_leaf_index,
                msg_id: message.msg_id(),
            },
            parents: message.tbs().parents.as_slice().to_vec(),
            retention_class: message.tbs().retention_class,
            sent_at: message.tbs().sent_at,
            provenance: Provenance::Repaired,
        }
    }

    /// The message's name.
    #[must_use]
    pub const fn msg_id(&self) -> MsgId {
        self.key.msg_id
    }

    /// §7's sort key for this message.
    #[must_use]
    pub const fn sort_key(&self) -> SortKey {
        self.key
    }

    /// The `msg_id`s this message referenced.
    #[must_use]
    pub fn parents(&self) -> &[MsgId] {
        &self.parents
    }

    /// §8's retention class.
    #[must_use]
    pub const fn retention_class(&self) -> RetentionClass {
        self.retention_class
    }

    /// The sender's claim about when it sent. Advisory; see [`SentAt`].
    #[must_use]
    pub const fn sent_at(&self) -> SentAt {
        self.sent_at
    }

    /// How this message reached the receiver.
    #[must_use]
    pub const fn provenance(&self) -> Provenance {
        self.provenance
    }
}

/// What one gap is doing, mirroring `CLIENT-CONTRACT.md`'s `GapState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum GapState {
    /// A dangling parent has been seen; no repair has been asked for yet.
    Detected,
    /// A `gap_request` naming this hash has been emitted.
    RepairRequested,
    /// The sender no longer holds the plaintext, or said so.
    ///
    /// §8.4: this is surfaced to the user as an explicit "this message could
    /// not be recovered" marker rather than a silent hole. It is terminal, and
    /// it is deliberately *not* removed from the gap set — a hole the user was
    /// told about is the whole point.
    Unrecoverable,
}

/// The result of admitting a message.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Insertion {
    /// The message is new to this device.
    Accepted {
        /// Parents this message referenced that the receiver has never held.
        ///
        /// Newly discovered only: a hash already in the gap set is not repeated,
        /// so *n* messages all referencing one missing parent produce one gap.
        newly_missing: Vec<MsgId>,
    },
    /// Already held. §9.4 makes this routine — the same message arrives once
    /// per relay the recipient publishes a queue address on.
    Duplicate,
}

/// A device's view of one conversation's message graph.
///
/// No clock, no I/O, no storage: every time-dependent decision in this crate is
/// a parameter. That is what makes the ordering testable and what lets the same
/// code run in a browser.
#[derive(Clone, Debug, Default)]
pub struct MessageDag {
    entries: BTreeMap<MsgId, DagEntry>,
    /// Parent -> children, including parents not held. This is what makes a
    /// repaired message able to close the gap it was fetched for.
    referenced_by: BTreeMap<MsgId, BTreeSet<MsgId>>,
    gaps: BTreeMap<MsgId, GapState>,
}

impl MessageDag {
    /// An empty conversation.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How many messages are held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether nothing is held.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Whether this `msg_id` is held.
    #[must_use]
    pub fn contains(&self, msg_id: &MsgId) -> bool {
        self.entries.contains_key(msg_id)
    }

    /// Look one up.
    #[must_use]
    pub fn get(&self, msg_id: &MsgId) -> Option<&DagEntry> {
        self.entries.get(msg_id)
    }

    /// Admit a message, deduplicating on `msg_id` and reporting new gaps.
    ///
    /// Idempotent: inserting the same `msg_id` again is a [`Insertion::Duplicate`]
    /// and changes nothing, including the gap set. That is the property
    /// `ARCHITECTURE.md` §9.4's *k*-relay fan-out depends on.
    pub fn insert(&mut self, entry: DagEntry) -> Insertion {
        let id = entry.msg_id();
        if self.entries.contains_key(&id) {
            return Insertion::Duplicate;
        }

        let mut newly_missing = Vec::new();
        for parent in entry.parents() {
            self.referenced_by.entry(*parent).or_default().insert(id);
            if self.entries.contains_key(parent) {
                continue;
            }
            // Already known missing — one gap, however many messages point at
            // it. `Unrecoverable` is terminal and is not reopened by a later
            // reference either.
            if self.gaps.contains_key(parent) {
                continue;
            }
            self.gaps.insert(*parent, GapState::Detected);
            newly_missing.push(*parent);
        }

        // This message may itself be one somebody was missing.
        self.gaps.remove(&id);
        self.entries.insert(id, entry);

        Insertion::Accepted { newly_missing }
    }

    /// The hashes of every message known to be missing and not yet resolved.
    ///
    /// Ascending by `msg_id`, so the list is stable across runs.
    #[must_use]
    pub fn detected_gaps(&self) -> Vec<MsgId> {
        self.gaps
            .iter()
            .filter(|(_, state)| **state != GapState::Unrecoverable)
            .map(|(id, _)| *id)
            .collect()
    }

    /// Whether any gap has been **detected**.
    ///
    /// Never "whether anything is missing" — see the module note on tail
    /// truncation. `CLIENT-CONTRACT.md` §3.5 requires the distinction to
    /// survive into the UI copy.
    #[must_use]
    pub fn has_detected_gaps(&self) -> bool {
        self.gaps
            .values()
            .any(|state| *state != GapState::Unrecoverable)
    }

    /// The state of one gap, if there is one.
    #[must_use]
    pub fn gap_state(&self, msg_id: &MsgId) -> Option<GapState> {
        self.gaps.get(msg_id).copied()
    }

    /// Every gap that has been given up on, ascending.
    ///
    /// §8.4's explicit "this message could not be recovered" set. A caller that
    /// renders a transcript must render these; dropping them is the silent hole
    /// §8.4 forbids.
    #[must_use]
    pub fn unrecoverable_gaps(&self) -> Vec<MsgId> {
        self.gaps
            .iter()
            .filter(|(_, state)| **state == GapState::Unrecoverable)
            .map(|(id, _)| *id)
            .collect()
    }

    /// Take the gaps that have not yet been asked about, marking them asked.
    ///
    /// This is the body of §7's `gap_request{hashes}`. Emptying the *detected*
    /// set as it emits is what makes "every dropped middle message produces
    /// exactly one gap signal" true — a caller that polls this in a loop does
    /// not re-ask, and a message that keeps arriving with the same dangling
    /// parent does not re-trigger.
    ///
    /// Returns an empty vector when there is nothing new to ask for.
    pub fn take_gap_request(&mut self) -> Vec<MsgId> {
        let pending: Vec<MsgId> = self
            .gaps
            .iter()
            .filter(|(_, state)| **state == GapState::Detected)
            .map(|(id, _)| *id)
            .collect();
        for id in &pending {
            self.gaps.insert(*id, GapState::RepairRequested);
        }
        pending
    }

    /// Record that a gap can never be filled (§8.4).
    ///
    /// Called when the sender answers that its plaintext outbox no longer holds
    /// the message — see [`crate::outbox::RepairOutcome`] — or when the caller
    /// gives up. Terminal.
    pub fn mark_unrecoverable(&mut self, msg_id: &MsgId) {
        if self.entries.contains_key(msg_id) {
            return;
        }
        self.gaps.insert(*msg_id, GapState::Unrecoverable);
    }

    /// The current heads: held messages nothing held references.
    ///
    /// This is §7's "every message this sender had delivered and not yet
    /// referenced, at send time" — the `parents` of the next message this
    /// device sends. Ascending by `msg_id`, so two devices with the same view
    /// build the same list and therefore, given the same content, the same
    /// `msg_id`.
    #[must_use]
    pub fn heads(&self) -> Vec<MsgId> {
        self.entries
            .keys()
            .filter(|id| {
                self.referenced_by
                    .get(*id)
                    .is_none_or(alloc::collections::BTreeSet::is_empty)
            })
            .copied()
            .collect()
    }

    /// §7's display order over everything held.
    ///
    /// # Errors
    ///
    /// [`DagError::Cycle`] — see [`linearise`].
    pub fn display_order(&self) -> Result<Vec<MsgId>, DagError> {
        let nodes: Vec<OrderNode> = self
            .entries
            .values()
            .map(|entry| OrderNode {
                key: entry.sort_key(),
                parents: entry.parents().to_vec(),
            })
            .collect();
        linearise(&nodes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{AppMessageTbs, MessageType, Parents};
    use alloc::vec;
    use f2z_codec::types::Body;

    fn message(parents: Vec<MsgId>, epoch: u64, body: &[u8]) -> AppMessage {
        message_from(parents, epoch, 0, body)
    }

    fn message_from(parents: Vec<MsgId>, epoch: u64, leaf: u32, body: &[u8]) -> AppMessage {
        AppMessage::seal(AppMessageTbs {
            message_type: MessageType::CHAT,
            parents: Parents::new(parents).unwrap(),
            epoch,
            sender_leaf_index: leaf,
            sent_at: SentAt::new(0),
            retention_class: RetentionClass::Chat,
            body: Body::new(body.to_vec()).unwrap(),
        })
        .unwrap()
    }

    fn delivered(message: &AppMessage) -> DagEntry {
        DagEntry::from_delivered(
            message,
            message.tbs().epoch,
            message.tbs().sender_leaf_index,
        )
        .unwrap()
    }

    #[test]
    fn the_same_message_arriving_k_times_is_held_once() {
        let mut dag = MessageDag::new();
        let one = message(vec![], 7, b"hello");
        assert!(matches!(
            dag.insert(delivered(&one)),
            Insertion::Accepted { .. }
        ));
        for _ in 0..4 {
            assert_eq!(dag.insert(delivered(&one)), Insertion::Duplicate);
        }
        assert_eq!(dag.len(), 1);
    }

    #[test]
    fn a_dangling_parent_is_one_gap_however_many_messages_point_at_it() {
        let missing = message(vec![], 7, b"missing").msg_id();
        let mut dag = MessageDag::new();

        let first = message(vec![missing], 7, b"a");
        let Insertion::Accepted { newly_missing } = dag.insert(delivered(&first)) else {
            panic!("expected acceptance");
        };
        assert_eq!(newly_missing, vec![missing]);

        let second = message(vec![missing], 7, b"b");
        let Insertion::Accepted { newly_missing } = dag.insert(delivered(&second)) else {
            panic!("expected acceptance");
        };
        assert!(newly_missing.is_empty(), "one hole is one gap");
        assert_eq!(dag.detected_gaps(), vec![missing]);
    }

    #[test]
    fn a_gap_request_is_emitted_once() {
        let missing = message(vec![], 7, b"missing").msg_id();
        let mut dag = MessageDag::new();
        dag.insert(delivered(&message(vec![missing], 7, b"a")));

        assert_eq!(dag.take_gap_request(), vec![missing]);
        assert!(
            dag.take_gap_request().is_empty(),
            "a gap already asked about must not be re-asked"
        );
        assert_eq!(dag.gap_state(&missing), Some(GapState::RepairRequested));
    }

    #[test]
    fn the_missing_message_arriving_closes_the_gap() {
        let missing = message(vec![], 7, b"missing");
        let mut dag = MessageDag::new();
        dag.insert(delivered(&message(vec![missing.msg_id()], 7, b"a")));
        assert!(dag.has_detected_gaps());

        dag.insert(delivered(&missing));
        assert!(!dag.has_detected_gaps());
        assert!(dag.detected_gaps().is_empty());
    }

    #[test]
    fn an_unrecoverable_gap_stays_visible_and_is_not_reopened() {
        let missing = message(vec![], 7, b"missing").msg_id();
        let mut dag = MessageDag::new();
        dag.insert(delivered(&message(vec![missing], 7, b"a")));
        dag.take_gap_request();
        dag.mark_unrecoverable(&missing);

        assert_eq!(dag.unrecoverable_gaps(), vec![missing]);
        assert!(!dag.has_detected_gaps(), "it is no longer outstanding");

        // Another message pointing at the same hole must not resurrect it as a
        // fresh gap: the user has already been told it cannot be recovered.
        let Insertion::Accepted { newly_missing } =
            dag.insert(delivered(&message(vec![missing], 7, b"b")))
        else {
            panic!("expected acceptance");
        };
        assert!(newly_missing.is_empty());
        assert_eq!(dag.unrecoverable_gaps(), vec![missing]);
    }

    #[test]
    fn heads_are_the_messages_nothing_references() {
        let root = message(vec![], 7, b"root");
        let child = message(vec![root.msg_id()], 7, b"child");
        let sibling = message(vec![root.msg_id()], 7, b"sibling");

        let mut dag = MessageDag::new();
        dag.insert(delivered(&root));
        dag.insert(delivered(&child));
        dag.insert(delivered(&sibling));

        let mut heads = dag.heads();
        heads.sort_unstable();
        let mut expected = vec![child.msg_id(), sibling.msg_id()];
        expected.sort_unstable();
        assert_eq!(heads, expected);
    }

    #[test]
    fn the_framing_epoch_and_the_claimed_epoch_must_agree() {
        let one = message(vec![], 7, b"hello");
        assert_eq!(
            DagEntry::from_delivered(&one, 8, 0),
            Err(DagError::EpochMismatch)
        );
    }

    #[test]
    fn the_framing_leaf_index_and_the_claimed_leaf_index_must_agree() {
        // §7's 2026-08-25 correction: the hashed field is authoritative and
        // the framing is the cross-check. Two sources of truth is the thing
        // the correction exists to avoid, so a disagreement is fatal.
        let one = message_from(vec![], 7, 3, b"hello");
        assert_eq!(
            DagEntry::from_delivered(&one, 7, 4),
            Err(DagError::LeafIndexMismatch)
        );
        assert_eq!(
            DagEntry::from_delivered(&one, 7, 3).unwrap().sort_key(),
            SortKey {
                epoch: 7,
                sender_leaf_index: 3,
                msg_id: one.msg_id(),
            }
        );
    }

    #[test]
    fn a_repaired_entry_takes_its_whole_sort_key_from_the_message() {
        // The repair arrives in the repairing peer's framing at a later epoch.
        // Neither of those may reach the sort key.
        let original = message_from(vec![], 7, 3, b"the missing one");
        let repaired = DagEntry::from_repair(&original);
        assert_eq!(repaired.sort_key(), delivered(&original).sort_key());
        assert_eq!(repaired.provenance(), Provenance::Repaired);
    }
}
