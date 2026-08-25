//! This crate's failure type.

use core::fmt;

use f2z_codec::CodecError;

/// Everything that can go wrong framing, admitting or ordering a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DagError {
    /// The bytes did not decode, did not re-encode to themselves, or carried a
    /// value no version-1 structure may hold. `WIRE.md` §3.3's rule applies to
    /// application framing for the same reason it applies to relay framing:
    /// `msg_id` covers the canonical bytes, so a decoder that is more
    /// permissive than its encoder is a parse-versus-verify gap.
    Codec(CodecError),

    /// `parents` was not strictly ascending, or repeated a `msg_id`.
    ///
    /// See [`crate::message::Parents`]. Without this rule two senders holding
    /// the *same* set of heads can mint two different `msg_id`s for the same
    /// message, and a content-addressed identifier that depends on the order
    /// somebody happened to iterate a set is not content-addressed.
    ParentsNotCanonical,

    /// `parents` exceeded [`crate::message::Parents::MAX`].
    TooManyParents,

    /// The `msg_id` on the message is not the hash of the rest of it.
    ///
    /// Fatal and never retried. `msg_id` is a commitment; a message whose
    /// commitment does not check is not a corrupted message, it is a different
    /// message wearing a name.
    MsgIdMismatch,

    /// The `epoch` field disagrees with the MLS epoch the message was framed
    /// in.
    ///
    /// See [`crate::dag::DagEntry::from_delivered`]. Only a directly delivered
    /// message is held to this; a repaired one carries its *original* epoch by
    /// construction (§7's repair re-encrypts under the current epoch, which
    /// changes the framing and must not change the message).
    EpochMismatch,

    /// The `sender_leaf_index` field disagrees with the MLS leaf index the
    /// message was framed by.
    ///
    /// §7's 2026-08-25 correction put the leaf index inside the hash and made
    /// it authoritative; the framing value is the cross-check, and a
    /// disagreement is a sender claiming an authorship position it did not
    /// encrypt from. Like [`DagError::EpochMismatch`], only a directly
    /// delivered message is held to this — a repair's framing belongs to the
    /// repairing peer.
    LeafIndexMismatch,

    /// A `gap_response` carried a message that is not the one that was asked
    /// for.
    ///
    /// The requester knows the `msg_id` it is missing — that is what a dangling
    /// parent *is* — and `msg_id` is a hash commitment, so a repairing peer
    /// cannot substitute content for it. This is the check that makes repair
    /// safe to accept from a peer whose framing does not authenticate the
    /// original sender.
    UnsolicitedRepair,

    /// The responder answered, and the answer was "I cannot supply it".
    ///
    /// Distinct from [`DagError::UnsolicitedRepair`] because it is not a
    /// protocol violation and not an attack — it is §8.4 working: the
    /// responder's plaintext outbox window elapsed, and saying so is the
    /// behaviour the specification asks for. The caller's next step is
    /// [`crate::dag::MessageDag::mark_unrecoverable`], not a retry.
    RepairRefused(crate::repair::RepairRefusal),

    /// The held graph contains a cycle.
    ///
    /// Cryptographically infeasible: a child's `msg_id` commits to its
    /// parents' `msg_id`s, so a cycle is a hash preimage cycle. Reported
    /// rather than ignored because the alternative is an ordering routine that
    /// silently drops messages.
    Cycle,
}

impl From<CodecError> for DagError {
    fn from(error: CodecError) -> Self {
        Self::Codec(error)
    }
}

impl From<tls_codec::Error> for DagError {
    fn from(_: tls_codec::Error) -> Self {
        Self::Codec(CodecError::Decode)
    }
}

impl fmt::Display for DagError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Codec(inner) => write!(f, "{inner}"),
            Self::ParentsNotCanonical => {
                f.write_str("parents must be strictly ascending msg_ids (ARCHITECTURE.md §7)")
            }
            Self::TooManyParents => f.write_str("parents exceeds the maximum this framing admits"),
            Self::MsgIdMismatch => f.write_str("msg_id is not the hash of the rest of the message"),
            Self::EpochMismatch => {
                f.write_str("the epoch field disagrees with the MLS epoch of the framing")
            }
            Self::LeafIndexMismatch => f.write_str(
                "the sender_leaf_index field disagrees with the MLS leaf index of the framing",
            ),
            Self::UnsolicitedRepair => {
                f.write_str("a gap_response carried a message that was not requested")
            }
            Self::RepairRefused(reason) => {
                write!(f, "the responder cannot supply that message: {reason:?}")
            }
            Self::Cycle => f.write_str("the message graph contains a cycle"),
        }
    }
}

impl core::error::Error for DagError {}
