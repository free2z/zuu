//! The provider: one implementation of OpenMLS's 57 storage methods, over any
//! [`StorageBackend`], plus the transaction OpenMLS does not have.
//!
//! The 57 methods themselves are in [`crate::storage_impl`], in the upstream
//! trait's order so they can be diffed against it. This module is the part with
//! decisions in it.
//!
//! # The transaction, and why it has to live here
//!
//! OpenMLS issues many storage calls per logical operation and offers **no
//! transaction API**. `MlsGroup::process_message` followed by
//! `merge_staged_commit` writes the tree, the group context, the interim
//! transcript hash, the confirmation tag, the epoch secrets, the message
//! secrets and the proposal queue as separate calls; the application then wants
//! to record the decrypted message in the same breath. A crash anywhere in that
//! run leaves a group whose tree is from epoch *n+1* and whose secrets are from
//! epoch *n* — unusable, and unrepairable, because under delete-on-ack the
//! relay's copy of the message that caused it is gone
//! ([`ARCHITECTURE.md` §6.4][s64]).
//!
//! The only place that can make the run atomic is the storage provider, because
//! it is the only component that sees every call. So:
//!
//! ```text
//!   let tx = provider.storage().begin()?;      // writes start being journalled
//!   group.process_message(&provider, msg)?;    // OpenMLS writes, none of it durable
//!   group.merge_staged_commit(&provider, sc)?; // more writes, still journalled
//!   provider.storage().put_app(key, record)?;  // the application's own row
//!   tx.commit()?;                              // one atomic apply
//! ```
//!
//! Reads inside the transaction see the journal, so OpenMLS's own
//! read-after-write within one operation behaves exactly as it does without
//! one.
//!
//! # Rollback is the default, and that is on purpose
//!
//! [`Transaction`] rolls back on `Drop`. Forgetting to commit therefore loses
//! the operation, which is recoverable — the message is still on the relay,
//! un-acknowledged, and will be redelivered. The opposite default (commit on
//! drop) would make an early `?` return silently commit a half-finished epoch
//! change, which is not recoverable. When the two failure modes are "do it
//! again" and "the group is broken forever", the default belongs on the first.
//!
//! Nesting is refused rather than reference-counted ([`StoreError::TransactionAlreadyOpen`]):
//! an inner `commit` that could still be undone by an outer rollback is a
//! receipt that lies, and a caller that acknowledged on it would have destroyed
//! the message.
//!
//! # Outside a transaction
//!
//! Every write applies immediately, as a batch of one. That keeps the provider
//! usable in the plain OpenMLS style — no ceremony for key-package generation
//! or a signature-key write — and it is still atomic per call, which is all a
//! single-call operation needs.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements
//! [`StorageBackend`]: crate::StorageBackend
//! [`StoreError::TransactionAlreadyOpen`]: crate::StoreError

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::Serialize;

use crate::backend::{Durability, Op, StorageBackend};
use crate::error::{Result, StoreError};
use crate::keys::{APP_RECORD_LABEL, build_key_from_vec, label_name};

/// The staged write set of an open transaction.
///
/// `BTreeMap` rather than `HashMap` so that the [`Op`] sequence handed to a
/// backend is a deterministic function of the write set. A backend is not
/// allowed to care about order — [`StorageBackend::apply`] is atomic — but a
/// test that has to explain a failure very much does.
///
/// `None` is a tombstone: the key was deleted in this transaction and must read
/// as absent even though the backend still holds it.
type Journal = BTreeMap<Vec<u8>, Option<Vec<u8>>>;

/// The OpenMLS [`StorageProvider`] for free2z messaging.
///
/// [`StorageProvider`]: openmls_traits::storage::StorageProvider
pub struct F2zStorageProvider<B: StorageBackend> {
    backend: B,
    /// `None` when no transaction is open.
    journal: Mutex<Option<Journal>>,
}

impl<B: StorageBackend> core::fmt::Debug for F2zStorageProvider<B> {
    /// Hand-written. A derived `Debug` would print the journal, which holds
    /// serialised epoch secrets, as a decimal byte list — the trap
    /// `f2z-codec`'s `tests/redaction.rs` documents, where a hex-only leak
    /// check passes while everything leaks.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let staged = match self.journal.lock() {
            Ok(guard) => guard.as_ref().map(BTreeMap::len),
            Err(_) => return f.write_str("F2zStorageProvider { <poisoned> }"),
        };
        f.debug_struct("F2zStorageProvider")
            .field("durability", &self.backend.durability())
            .field("transaction_open", &staged.is_some())
            .field("staged_keys", &staged.unwrap_or(0))
            .field("journal", &format_args!("<redacted>"))
            .finish()
    }
}

impl<B: StorageBackend> F2zStorageProvider<B> {
    /// Wrap a backend.
    pub const fn new(backend: B) -> Self {
        Self {
            backend,
            journal: Mutex::new(None),
        }
    }

    /// The backend, for whatever a caller needs that this trait does not cover
    /// (a checkpoint, a size report).
    pub const fn backend(&self) -> &B {
        &self.backend
    }

    /// What surviving a crash means for this store.
    ///
    /// `CLIENT-CONTRACT.md` §3.1 puts this in front of the user, and §11.2
    /// makes a non-durable store enter no-ACK mode. See [`Durability`].
    pub fn durability(&self) -> Durability {
        self.backend.durability()
    }

    /// Open a transaction. Every write until [`Transaction::commit`] is staged
    /// and none of it reaches the backend.
    ///
    /// # Errors
    ///
    /// [`StoreError::TransactionAlreadyOpen`] if one is already open on this
    /// provider — see the module note on why nesting is refused rather than
    /// counted. [`StoreError::Poisoned`] if another thread panicked while
    /// holding the journal.
    pub fn begin(&self) -> Result<Transaction<'_, B>> {
        let mut journal = self.journal.lock().map_err(|_| StoreError::Poisoned)?;
        if journal.is_some() {
            return Err(StoreError::TransactionAlreadyOpen);
        }
        *journal = Some(Journal::new());
        drop(journal);
        Ok(Transaction {
            provider: self,
            settled: false,
        })
    }

    /// Whether a transaction is currently open.
    ///
    /// # Errors
    ///
    /// [`StoreError::Poisoned`] if another thread panicked while holding the
    /// journal.
    pub fn in_transaction(&self) -> Result<bool> {
        Ok(self
            .journal
            .lock()
            .map_err(|_| StoreError::Poisoned)?
            .is_some())
    }

    // --- the application's own namespace ------------------------------------
    //
    // OpenMLS owns 19 labels; this is the twentieth, and it is the reason the
    // transaction is usable at all. Under delete-on-ack the message is
    // acknowledged — and the relay's copy destroyed — only once the client has
    // durably recorded that it handled it. That record has to land in the *same*
    // atomic write as the epoch change that decrypted it, so it has to go
    // through this provider rather than into a database beside it.
    //
    // It is a flat byte-keyed map on purpose: this crate knows nothing about
    // what a message id is, and a schema here would be a second place for
    // `ARCHITECTURE.md` §7's framing to be defined.

    /// Write an application record.
    ///
    /// # Errors
    ///
    /// Whatever the backend refused with, or [`StoreError::Poisoned`].
    pub fn put_app(&self, key: &[u8], value: &[u8]) -> Result<()> {
        self.write::<{ openmls_traits::storage::CURRENT_VERSION }>(
            APP_RECORD_LABEL,
            key,
            value.to_vec(),
        )
    }

    /// Read an application record. `Ok(None)` means there is none.
    ///
    /// # Errors
    ///
    /// Whatever the backend refused with, or [`StoreError::Poisoned`].
    pub fn get_app(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.get_raw(&build_key_from_vec::<
            { openmls_traits::storage::CURRENT_VERSION },
        >(APP_RECORD_LABEL, key.to_vec()))
    }

    /// Whether an application record exists.
    ///
    /// The duplicate check: `CLIENT-CONTRACT.md` §7 makes `msgId` the dedup
    /// key, and a device may receive the same message from *k* relays
    /// (`ARCHITECTURE.md` §9.4), so this is a routine question rather than an
    /// exceptional one.
    ///
    /// # Errors
    ///
    /// Whatever the backend refused with, or [`StoreError::Poisoned`].
    pub fn has_app(&self, key: &[u8]) -> Result<bool> {
        Ok(self.get_app(key)?.is_some())
    }

    /// Delete an application record. Deleting an absent one is not an error.
    ///
    /// # Errors
    ///
    /// Whatever the backend refused with, or [`StoreError::Poisoned`].
    pub fn delete_app(&self, key: &[u8]) -> Result<()> {
        self.delete_raw(build_key_from_vec::<
            { openmls_traits::storage::CURRENT_VERSION },
        >(APP_RECORD_LABEL, key.to_vec()))
    }

    // --- the raw primitives every one of the 57 methods reduces to ----------

    /// Read one storage key, journal first.
    pub(crate) fn get_raw(&self, storage_key: &[u8]) -> Result<Option<Vec<u8>>> {
        {
            let journal = self.journal.lock().map_err(|_| StoreError::Poisoned)?;
            if let Some(staged) = journal.as_ref() {
                if let Some(entry) = staged.get(storage_key) {
                    return Ok(entry.clone());
                }
            }
        }
        self.backend.get(storage_key)
    }

    /// Stage or apply one put.
    pub(crate) fn put_raw(&self, storage_key: Vec<u8>, value: Vec<u8>) -> Result<()> {
        let mut journal = self.journal.lock().map_err(|_| StoreError::Poisoned)?;
        if let Some(staged) = journal.as_mut() {
            staged.insert(storage_key, Some(value));
            return Ok(());
        }
        drop(journal);
        self.backend.apply(&[Op::Put {
            key: storage_key,
            value,
        }])
    }

    /// Stage or apply one delete.
    pub(crate) fn delete_raw(&self, storage_key: Vec<u8>) -> Result<()> {
        let mut journal = self.journal.lock().map_err(|_| StoreError::Poisoned)?;
        if let Some(staged) = journal.as_mut() {
            staged.insert(storage_key, None);
            return Ok(());
        }
        drop(journal);
        self.backend.apply(&[Op::Delete { key: storage_key }])
    }

    // --- the helpers the 57 methods are written in terms of -----------------
    //
    // Named after `openmls_memory_storage`'s, and doing the same thing, so the
    // provider below can be diffed against it line by line.

    pub(crate) fn write<const VERSION: u16>(
        &self,
        label: &[u8],
        key: &[u8],
        value: Vec<u8>,
    ) -> Result<()> {
        self.put_raw(build_key_from_vec::<VERSION>(label, key.to_vec()), value)
    }

    pub(crate) fn append<const VERSION: u16>(
        &self,
        label: &[u8],
        key: &[u8],
        value: Vec<u8>,
    ) -> Result<()> {
        let storage_key = build_key_from_vec::<VERSION>(label, key.to_vec());
        let mut list = self.read_raw_list(&storage_key, label)?;
        list.push(value);
        self.put_raw(storage_key, encode_list(&list, label)?)
    }

    pub(crate) fn remove_item<const VERSION: u16>(
        &self,
        label: &[u8],
        key: &[u8],
        value: &[u8],
    ) -> Result<()> {
        let storage_key = build_key_from_vec::<VERSION>(label, key.to_vec());
        let mut list = self.read_raw_list(&storage_key, label)?;
        if let Some(position) = list.iter().position(|stored| stored == value) {
            list.remove(position);
        }
        self.put_raw(storage_key, encode_list(&list, label)?)
    }

    pub(crate) fn read<const VERSION: u16, V: serde::de::DeserializeOwned>(
        &self,
        label: &[u8],
        key: &[u8],
    ) -> Result<Option<V>> {
        let storage_key = build_key_from_vec::<VERSION>(label, key.to_vec());
        let Some(value) = self.get_raw(&storage_key)? else {
            return Ok(None);
        };
        serde_json::from_slice(&value)
            .map(Some)
            .map_err(|_| StoreError::Serialization {
                label: label_name(label),
            })
    }

    pub(crate) fn read_list<const VERSION: u16, V: serde::de::DeserializeOwned>(
        &self,
        label: &[u8],
        key: &[u8],
    ) -> Result<Vec<V>> {
        let storage_key = build_key_from_vec::<VERSION>(label, key.to_vec());
        self.read_raw_list(&storage_key, label)?
            .iter()
            .map(|element| {
                serde_json::from_slice(element).map_err(|_| StoreError::Serialization {
                    label: label_name(label),
                })
            })
            .collect()
    }

    pub(crate) fn delete<const VERSION: u16>(&self, label: &[u8], key: &[u8]) -> Result<()> {
        self.delete_raw(build_key_from_vec::<VERSION>(label, key.to_vec()))
    }

    /// A list-valued entry as its raw elements. An absent key is an empty list,
    /// which is what the trait's list getters are documented to return.
    fn read_raw_list(&self, storage_key: &[u8], label: &[u8]) -> Result<Vec<Vec<u8>>> {
        let Some(bytes) = self.get_raw(storage_key)? else {
            return Ok(Vec::new());
        };
        serde_json::from_slice(&bytes).map_err(|_| StoreError::Serialization {
            label: label_name(label),
        })
    }
}

/// Serialise a value, naming the label rather than the value in the error.
pub(crate) fn encode<T: Serialize + ?Sized>(value: &T, label: &[u8]) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| StoreError::Serialization {
        label: label_name(label),
    })
}

fn encode_list(list: &[Vec<u8>], label: &[u8]) -> Result<Vec<u8>> {
    encode(list, label)
}

/// An open transaction. Commit it, or it rolls back.
///
/// See the module note: rollback-on-drop is deliberate, because a lost
/// operation is redelivered and a half-applied one is not.
#[must_use = "a transaction that is dropped without `commit` rolls back"]
pub struct Transaction<'a, B: StorageBackend> {
    provider: &'a F2zStorageProvider<B>,
    settled: bool,
}

impl<B: StorageBackend> core::fmt::Debug for Transaction<'_, B> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Transaction")
            .field("settled", &self.settled)
            .finish_non_exhaustive()
    }
}

impl<B: StorageBackend> Transaction<'_, B> {
    /// Apply the whole staged write set to the backend, atomically.
    ///
    /// # Errors
    ///
    /// [`StoreError::Poisoned`] if another thread panicked while holding the
    /// journal, or whatever the backend refused with. On an error the staged
    /// set is discarded and the backend is unchanged: a failed commit is a
    /// rollback, never a partial application.
    pub fn commit(mut self) -> Result<()> {
        self.settled = true;

        let staged = {
            let mut journal = self
                .provider
                .journal
                .lock()
                .map_err(|_| StoreError::Poisoned)?;
            journal.take().ok_or(StoreError::Backend("commit"))?
        };

        let ops: Vec<Op> = staged
            .into_iter()
            .map(|(key, value)| match value {
                Some(value) => Op::Put { key, value },
                None => Op::Delete { key },
            })
            .collect();

        #[cfg(feature = "crash-injection")]
        crate::crash::fire(crate::crash::CrashPoint::BeforeCommit);

        self.provider.backend.apply(&ops)?;

        #[cfg(feature = "crash-injection")]
        crate::crash::fire(crate::crash::CrashPoint::AfterCommit);

        Ok(())
    }

    /// Discard the staged write set explicitly.
    ///
    /// Identical to dropping it; it exists so that an intentional abandon reads
    /// as one at the call site rather than as a forgotten `commit`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Poisoned`] if another thread panicked while holding the
    /// journal.
    pub fn rollback(mut self) -> Result<()> {
        self.settled = true;
        let mut journal = self
            .provider
            .journal
            .lock()
            .map_err(|_| StoreError::Poisoned)?;
        *journal = None;
        Ok(())
    }
}

impl<B: StorageBackend> Drop for Transaction<'_, B> {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        // A poisoned lock here means another thread panicked mid-write. There
        // is nothing to do about it in a destructor and nothing to report to;
        // the next `begin` will surface it. What must not happen is a panic
        // inside `drop`, which would abort the process during unwinding.
        if let Ok(mut journal) = self.provider.journal.lock() {
            *journal = None;
        }
    }
}
