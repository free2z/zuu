//! Hash-linked application framing — `docs/e2ee/ARCHITECTURE.md` §7.
//!
//! Every application payload carries the hashes of its predecessors. That one
//! choice makes ordering and gap detection **transport-independent**: it works
//! identically whether a message arrived over the relay, over WebRTC or over
//! anything added later, so the transports can interleave freely and no
//! sequencing authority exists to be trusted, subpoenaed or wrong.
//!
//! ```text
//! AppMessage = { type, msg_id, parents, epoch, sender_leaf_index, sent_at,
//!                retention_class, body }
//! msg_id     = BLAKE2b-256("free2z/msg/v1/msgid" || canonical(rest))
//! ```
//!
//! # What this crate is
//!
//! The framing, the commitment, the order, the gap signal and the repair
//! bookkeeping — and nothing else. There is no MLS here, no relay, no storage,
//! no clock and no randomness. [`PlaintextOutbox::repair`] hands back a
//! *plaintext* for the caller's MLS engine to re-encrypt; it never produces a
//! ciphertext, because §7's forward-secrecy argument depends on repair going
//! through the current epoch's keys and a crate that could return a stored
//! ciphertext would be one refactor away from replaying it.
//!
//! Every time-dependent decision takes `now_ms` as a parameter. That is what
//! makes an expiry test a test instead of a wait, and it is why this crate
//! reaches `wasm32-unknown-unknown` for the browser client (ADR 0001).
//!
//! # The four properties, and where each is asserted
//!
//! 1. **Causal order first, sort key second.** [`order`] linearises the DAG and
//!    breaks ties between *concurrent* messages by
//!    `(epoch, sender_leaf_index, msg_id)`. Applying the tie-break alone puts
//!    replies above the messages they answer; the module note carries the
//!    two-line counterexample. This crate is the **only** implementation of
//!    that order — `CLIENT-CONTRACT.md` §7's 2026-08-25 correction moved
//!    display order out of the UI and into the engine, which is what ADR 0001
//!    asked for all along.
//!
//! 1b. **The sort key is a property of the message, not of the delivery.**
//!    `msg_id` commits to `epoch` **and** `sender_leaf_index`, so a message
//!    learned through repair — outside the framing it was authored in — sorts
//!    exactly where it would have if it had arrived directly.
//!    `tests/two_routes.rs` asserts that over two receivers who learned one
//!    message by different routes.
//!
//! 2. **`sent_at` cannot order anything.** [`SentAt`] implements neither `Ord`
//!    nor `PartialOrd`. §7 calls the field advisory; a doc comment saying so is
//!    a convention, and a missing trait is a compile error.
//!
//! 3. **A gap is certain, and incomplete.** A `parents` hash the receiver does
//!    not hold is proof — server-independent, authenticated inside MLS — that
//!    something is missing. It detects a dropped *middle* and nothing else:
//!    tail truncation leaves no dangling parent and is undetectable, which
//!    `tests/tail_truncation.rs` asserts as a limit rather than papering over.
//!
//! 4. **Dedup is by `msg_id`.** §9.4's *k*-relay fan-out means receiving one
//!    message *k* times is the normal case.
//!
//! # Where this crate had to decide something §7 does not say
//!
//! Written down because the alternative is a second implementation quietly
//! deciding differently:
//!
//! - **The wire encoding.** §7 gives a structure, not a serialization.
//!   [`AppMessage::encode`] is `msg_id || canonical(rest)`, so the hashed bytes
//!   are a contiguous suffix. See [`message`].
//! - **`parents` is strictly ascending.** A head *set* has to encode one way or
//!   `msg_id` is not a function of the content. See [`Parents`].
//! - **`type` is open, `retention_class` is closed.** See [`RetentionClass`].
//! - **The framing epoch and leaf index must agree with the message's own**
//!   for a directly delivered message. §7 says the hashed fields are
//!   authoritative and the framing is a cross-check; it does not say what to do
//!   when they disagree. Refusing is the safe reading. See
//!   [`DagEntry::from_delivered`].
//!
//! # Example
//!
//! ```
//! use f2z_codec::types::Body;
//! use f2z_msg_dag::{
//!     AppMessage, AppMessageTbs, DagEntry, Insertion, MessageDag, MessageType, Parents,
//!     RetentionClass, SentAt,
//! };
//!
//! # fn main() -> Result<(), Box<dyn core::error::Error>> {
//! let mut dag = MessageDag::new();
//!
//! // The first message a peer sends: no parents.
//! let first = AppMessage::seal(AppMessageTbs {
//!     message_type: MessageType::CHAT,
//!     parents: Parents::empty(),
//!     epoch: 7,
//!     sender_leaf_index: 1, // hashed, and cross-checked against the framing
//!     sent_at: SentAt::new(1_700_000_000_000), // advisory; orders nothing
//!     retention_class: RetentionClass::Chat,
//!     body: Body::new(b"hello".to_vec())?,
//! })?;
//!
//! // A second message referencing it — which never arrives.
//! let dropped = AppMessage::seal(AppMessageTbs {
//!     message_type: MessageType::CHAT,
//!     parents: Parents::new(vec![first.msg_id()])?,
//!     epoch: 7,
//!     sender_leaf_index: 1,
//!     sent_at: SentAt::new(1_700_000_001_000),
//!     retention_class: RetentionClass::Chat,
//!     body: Body::new(b"are you there?".to_vec())?,
//! })?;
//!
//! // A third, referencing the second.
//! let third = AppMessage::seal(AppMessageTbs {
//!     message_type: MessageType::CHAT,
//!     parents: Parents::new(vec![dropped.msg_id()])?,
//!     epoch: 7,
//!     sender_leaf_index: 1,
//!     sent_at: SentAt::new(1_700_000_002_000),
//!     retention_class: RetentionClass::Chat,
//!     body: Body::new(b"still here".to_vec())?,
//! })?;
//!
//! // The framing's `epoch` and leaf index, authenticated by MLS, are passed
//! // in to be checked against the message's own hashed values.
//! dag.insert(DagEntry::from_delivered(&first, 7, 1)?);
//! let outcome = dag.insert(DagEntry::from_delivered(&third, 7, 1)?);
//!
//! // The hole is certain, and it names itself.
//! assert_eq!(
//!     outcome,
//!     Insertion::Accepted { newly_missing: vec![dropped.msg_id()] }
//! );
//! assert_eq!(dag.take_gap_request(), vec![dropped.msg_id()]);
//! assert!(dag.take_gap_request().is_empty(), "one gap, one signal");
//! # Ok(())
//! # }
//! ```

#![no_std]
#![forbid(unsafe_code)]
// The workspace denies these because a panic in a client's message pipeline is
// a crash of the client. Neither hazard exists in a test harness run on the
// host by a person reading the failure, and the same `cfg_attr` sits at the
// root of `f2z-codec` and `f2z-msg-mls`.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )
)]

extern crate alloc;

pub mod dag;
pub mod error;
pub mod labels;
pub mod message;
pub mod order;
pub mod outbox;
pub mod repair;

pub use dag::{DagEntry, GapState, Insertion, MessageDag, Provenance};
pub use error::DagError;
pub use labels::{LABEL_MSG_ID, LABELS};
pub use message::{
    AppMessage, AppMessageTbs, MessageType, MsgId, Parents, RetentionClass, SentAt, msg_id_of,
};
pub use order::{OrderNode, SortKey, compare_sort_keys, linearise};
pub use outbox::{PlaintextOutbox, RepairOutcome, Unrecoverable};
pub use repair::{
    GAP_REQUEST_TYPE, GAP_RESPONSE_TYPE, GapRequest, GapResponse, RepairEntry, RepairRefusal,
};
