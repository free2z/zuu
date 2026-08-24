//! Queue storage for a free2z relay: addresses and bytes, never wire frames.
//!
//! This crate is the bottom of the relay. Above it sit [`f2z_relay_proto`],
//! which owns the protocol rules, and [`f2z_codec`], which owns the canonical
//! encoding. Nothing here parses a frame, verifies a signature, reads a clock
//! or generates a random number. What it owns is the one question those layers
//! cannot answer: **is it actually on the disk.**
//!
//! # Why that question is the whole crate
//!
//! [`ARCHITECTURE.md` §6.3][s63] separates four delivery states, and warns that
//! conflating them is how delete-on-ack loses messages. The relay implements
//! two:
//!
//! | State | Here |
//! |---|---|
//! | `accepted` | An `APPEND` the store took. Says nothing about the recipient — §6.3 makes sure of it. |
//! | `queue-delivered` | An `ACK`. **The store deletes at this instant.** |
//!
//! Between those two instants the relay's copy is the only copy of that
//! ciphertext anywhere in the system. So an `accepted` answered before the
//! write reached stable storage is a promise of custody that a power cut
//! breaks, and [`ARCHITECTURE.md` §6.4][s64] is blunt about the consequence: a
//! lost message under delete-on-ack is permanent.
//!
//! The crate's answer is [`Committed<T>`]: every mutating operation returns
//! one, and its constructor is private to this crate. A caller cannot write the
//! code that reports `accepted` without first holding a value that only a
//! completed commit could have produced. Durability is a returned fact rather
//! than a convention someone has to remember during review.
//!
//! # The three storage decisions
//!
//! - **`synchronous = FULL` over WAL**, verified at open rather than assumed.
//! - **Group commit is required, not an optimization.** At `FULL` a commit
//!   costs an fsync and a cheap VPS does 50-200 of those a second, so one
//!   transaction per append caps the whole relay at that. [`RelayStore::append_batch`]
//!   is therefore the primitive and [`RelayStore::append`] is the batch of one;
//!   the window over which a server gathers a batch is the server's decision,
//!   and the shape that makes it possible is this crate's.
//! - **`secure_delete = ON`.** Deleted ciphertext is zeroed, not merely
//!   unlinked. See [`SqliteStore::checkpoint`] for the part `secure_delete`
//!   alone does not cover.
//!
//! # Nothing here is loggable
//!
//! Every address, key and payload that crosses this boundary is an
//! [`f2z_codec`] newtype with a redacting `Debug`, and the records built from
//! them inherit it — a derived `Debug` delegates to its fields'. The trap that
//! makes this worth stating is documented in `f2z-codec`'s own redaction tests:
//! `tls_codec`'s byte vectors print a **decimal** list, `[222, 222, …]`, which
//! contains no hex at all, so a leak check that only looks for hex passes while
//! everything leaks. `tests/redaction.rs` here checks base16 in both cases,
//! base64url and the decimal run.
//!
//! # Example
//!
//! ```
//! use f2z_codec::types::{Payload, PublicKey, QueueAddress};
//! use f2z_relay_proto::queue::{AppendQuota, QueueKind};
//! use f2z_relay_store::{
//!     Append, MemoryStore, QueueSpec, ReadWindow, RelayStore, SendAuth,
//! };
//!
//! # fn main() -> Result<(), Box<dyn core::error::Error>> {
//! let store = MemoryStore::new();
//! let recv_addr = QueueAddress::new([1u8; 32]);
//! let send_addr = QueueAddress::new([2u8; 32]);
//! let recv_key = PublicKey::new([3u8; 32]);
//! let send_key = PublicKey::new([4u8; 32]);
//!
//! store.create_queue(&QueueSpec {
//!     kind: QueueKind::Standard,
//!     recv_addr,
//!     send_addr,
//!     recv_key,
//!     message_ttl_seconds: 604_800,
//!     idle_ttl_seconds: 7_776_000,
//!     quota: AppendQuota { max_messages: 1_000, max_bytes: 1 << 20 },
//!     created_at_ms: 1_000,
//! })?;
//!
//! // §7.3: the send side is bound once, by the key that signed the request.
//! store.bind_send(&send_addr, &send_key, 1_000)?;
//!
//! let payload = Payload::new(vec![0u8; 1024])?;
//! let accepted = store.append(&Append {
//!     send_addr,
//!     auth: SendAuth::Signed(send_key),
//!     payload: &payload,
//!     received_at_ms: 2_000,
//! })?;
//! // Only now may the relay answer `accepted` — and §6.3 forbids it from
//! // putting the index, or anything else, in that answer.
//! let index = accepted.into_inner().index;
//!
//! let page = store.read(&recv_addr, &recv_key, ReadWindow {
//!     from_index: 0,
//!     max_messages: 16,
//!     max_bytes: 65_536,
//! }, 3_000)?;
//! assert_eq!(page.messages.len(), 1);
//!
//! // §8: cumulative, and the relay deletes at this instant.
//! store.ack(&recv_addr, &recv_key, index, 4_000)?;
//! assert_eq!(store.stats()?.messages, 0);
//! # Ok(())
//! # }
//! ```
//!
//! [s63]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#63-what-delivered-means
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements

#![forbid(unsafe_code)]
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

#[cfg(feature = "crash-injection")]
pub mod crash;
pub mod durability;
pub mod error;
pub mod memory;
pub mod record;
pub mod sqlite;
pub mod store;

pub use durability::{Committed, Durability};
pub use error::{Result, StoreError};
pub use memory::MemoryStore;
pub use record::{
    Append, Appended, Deleted, ExpiryReason, ExpiryReport, QueueExpiry, QueueRecord, QueueSpec,
    ReadPage, ReadWindow, SendAuth, StoreStats, StoredMessage,
};
pub use sqlite::SqliteStore;
pub use store::RelayStore;
