//! The OpenMLS `StorageProvider` for free2z messaging — one implementation,
//! two backends, and the transaction OpenMLS does not give you.
//!
//! # Why this crate exists at all
//!
//! OpenMLS ships a SQLite storage provider. We cannot use it, and the reason is
//! not a preference:
//!
//! - `openmls_sqlite_storage 0.2.0`, the newest **release** compatible with the
//!   audited `openmls 0.8.1`, requires `rusqlite ^0.32`.
//! - `libsqlite3-sys` declares `links = "sqlite3"`, and Cargo **hard-errors**
//!   on a graph containing two versions of a `links` package.
//! - Everything under `wallet/` reaches SQLite through `tauri-plugin-zcash`'s
//!   `rusqlite = "0.37"`, so **0.37 is a repository-wide singleton**
//!   (`AGENTS.md`, "What NOT to do").
//! - The `0.3.0-rc` line does fit `^0.37` — and drags in `openmls 0.9.0-rc`, an
//!   unreleased OpenMLS.
//!
//! [#385](https://github.com/free2z/zuu/issues/385) reproduced the resolver
//! error rather than trusting the note. So: implement it.
//!
//! # The shape
//!
//! ```text
//!   OpenMLS  ──57 generic methods──▶  F2zStorageProvider<B>  ──▶  StorageBackend
//!                                          │                        ├── MemoryBackend
//!                                          │                        ├── SqliteBackend (native)
//!                                     Transaction                   └── IndexedDB (browser, later)
//! ```
//!
//! All 57 trait methods collapse to a labelled key/value map — every one of them
//! is generic over serde, and nothing in the trait is specific to a storage
//! engine. They are implemented **once**, in [`storage_impl`], in the upstream
//! trait's declaration order so a reviewer can diff them against
//! `openmls_traits::storage` and against `openmls_memory_storage 0.5.0` side by
//! side. The backend seam is three methods with no generics.
//!
//! The seam exists now, before the browser needs it, because ADR 0001 requires
//! one Rust core shared by ZUULI and the web client, and retrofitting a
//! backend boundary through 57 methods later is how the second implementation
//! ends up being the one with the bug in it.
//!
//! # Atomicity is the thing this crate gets right
//!
//! OpenMLS issues many storage calls per logical operation and has **no
//! transaction API**. `process_message` → `merge_staged_commit` → the
//! application's own row is seven or more separate writes, and a crash in the
//! middle leaves a group whose tree is from one epoch and whose secrets are
//! from another.
//!
//! Under delete-on-ack ([`ARCHITECTURE.md` §6.4][s64]) that is data loss, not
//! inconvenience: the relay deleted its copy when the client acknowledged.
//!
//! [`F2zStorageProvider::begin`] returns a [`Transaction`] that journals every
//! write and applies the whole set through [`StorageBackend::apply`] in one
//! atomic step. It **rolls back on drop**, because a lost operation is
//! redelivered and a half-applied one is not.
//!
//! ```
//! use f2z_msg_store::{F2zStorageProvider, MemoryBackend};
//!
//! let provider = F2zStorageProvider::new(MemoryBackend::new());
//! let tx = provider.begin()?;
//! // … OpenMLS writes here, none of it durable yet …
//! tx.commit()?;
//! # Ok::<(), f2z_msg_store::StoreError>(())
//! ```
//!
//! # Debug is redacted, and the trap is decimal
//!
//! Every type here that can hold key material has a hand-written `Debug`. The
//! reason is the one `f2z-codec`'s `tests/redaction.rs` documents: a derived
//! `Debug` on a `Vec<u8>` prints a **decimal** byte list, which contains no hex
//! at all — so a redaction test that greps for hex passes while the entire
//! secret is in the log. `tests/redaction.rs` here checks both bases, and the
//! decimal check is the one that matters.
//!
//! # What is deliberately not here
//!
//! - **The IndexedDB backend.** The seam is built for it; the implementation is
//!   not in this pull request.
//! - **Iteration, prefix scan, key enumeration.** The trait's access pattern is
//!   exact-key, and offering more would invite a provider method to depend on
//!   it — which the browser backend would then have to reimplement in a shape
//!   where a prefix scan over an object store is a different thing entirely.
//! - **Anything that knows what MLS is.** This crate does not depend on
//!   `openmls`, only on `openmls_traits`. That is what lets the browser build
//!   the store without the crypto core, and it keeps the diff against the
//!   reference implementation honest.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements

#![forbid(unsafe_code)]

mod backend;
#[cfg(feature = "crash-injection")]
pub mod crash;
mod error;
mod keys;
mod memory;
mod provider;
mod storage_impl;
#[cfg(feature = "sqlite")]
mod sqlite;

pub use backend::{Durability, Op, StorageBackend};
pub use error::{Result, StoreError};
pub use memory::MemoryBackend;
pub use provider::{F2zStorageProvider, Transaction};
#[cfg(feature = "sqlite")]
pub use sqlite::SqliteBackend;

/// The storage version this provider implements — OpenMLS's
/// `openmls_traits::storage::CURRENT_VERSION`.
///
/// Re-exported so that a caller can name it without depending on
/// `openmls_traits` directly.
pub use openmls_traits::storage::CURRENT_VERSION;
