//! The memory backend: a `HashMap` behind an `RwLock`.
//!
//! Atomicity here is free and is still worth stating, because the property the
//! provider relies on has to hold at *every* backend: [`apply`] takes the write
//! lock once and applies the whole batch under it, so no reader can observe a
//! strict subset of one call's ops. It is the same guarantee `SqliteBackend`
//! buys with a transaction, obtained from a mutex.
//!
//! It survives nothing, and [`Durability::None`] says so rather than leaving a
//! caller to guess. `CLIENT-CONTRACT.md` §11.2 turns that into a product rule:
//! a client whose store cannot survive a restart **must not `ACK`**, because
//! the relay deletes on acknowledgement.
//!
//! [`apply`]: StorageBackend::apply

use std::collections::HashMap;
use std::sync::RwLock;

use crate::backend::{Durability, Op, StorageBackend};
use crate::error::{Result, StoreError};

/// An in-memory [`StorageBackend`].
///
/// `Debug` is hand-written: the map's values are serialised group secrets.
#[derive(Default)]
pub struct MemoryBackend {
    values: RwLock<HashMap<Vec<u8>, Vec<u8>>>,
}

impl core::fmt::Debug for MemoryBackend {
    /// Entry count and nothing else. A derived `Debug` would print every
    /// serialised entity as a decimal byte list — see the module note in
    /// [`crate::backend`].
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let entries = match self.values.read() {
            Ok(values) => values.len(),
            Err(_) => return f.write_str("MemoryBackend { <poisoned> }"),
        };
        f.debug_struct("MemoryBackend")
            .field("entries", &entries)
            .field("values", &format_args!("<redacted>"))
            .finish()
    }
}

impl MemoryBackend {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// How many keys the store holds.
    ///
    /// For tests and for the engine's own diagnostics. Deliberately not an
    /// iterator: see [`crate::backend`] on why the trait offers no enumeration.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Poisoned`] if another thread panicked while
    /// holding the lock.
    pub fn len(&self) -> Result<usize> {
        Ok(self.values.read().map_err(|_| StoreError::Poisoned)?.len())
    }

    /// Whether the store holds no keys.
    ///
    /// # Errors
    ///
    /// Returns [`StoreError::Poisoned`] if another thread panicked while
    /// holding the lock.
    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
}

impl StorageBackend for MemoryBackend {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let values = self.values.read().map_err(|_| StoreError::Poisoned)?;
        Ok(values.get(key).cloned())
    }

    fn apply(&self, ops: &[Op]) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        // One acquisition for the whole batch. Taking the lock per op would
        // make this backend's atomicity weaker than the SQLite backend's, and
        // the provider is written against the stronger of the two.
        let mut values = self.values.write().map_err(|_| StoreError::Poisoned)?;
        for op in ops {
            match op {
                Op::Put { key, value } => {
                    values.insert(key.clone(), value.clone());
                }
                Op::Delete { key } => {
                    values.remove(key);
                }
            }
        }
        Ok(())
    }

    fn durability(&self) -> Durability {
        Durability::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_batch_is_visible_all_at_once() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[
                Op::Put {
                    key: b"a".to_vec(),
                    value: b"1".to_vec(),
                },
                Op::Put {
                    key: b"b".to_vec(),
                    value: b"2".to_vec(),
                },
            ])
            .expect("apply");

        assert_eq!(backend.get(b"a").expect("get"), Some(b"1".to_vec()));
        assert_eq!(backend.get(b"b").expect("get"), Some(b"2".to_vec()));
        assert_eq!(backend.len().expect("len"), 2);
    }

    #[test]
    fn deleting_an_absent_key_is_not_an_error() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[Op::Delete {
                key: b"missing".to_vec(),
            }])
            .expect("delete of an absent key must succeed");
        assert!(backend.is_empty().expect("is_empty"));
    }

    #[test]
    fn an_empty_batch_succeeds() {
        let backend = MemoryBackend::new();
        backend.apply(&[]).expect("empty batch");
        assert!(backend.is_empty().expect("is_empty"));
    }

    #[test]
    fn a_later_op_in_one_batch_overwrites_an_earlier_one() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[
                Op::Put {
                    key: b"k".to_vec(),
                    value: b"first".to_vec(),
                },
                Op::Put {
                    key: b"k".to_vec(),
                    value: b"second".to_vec(),
                },
                Op::Delete {
                    key: b"gone".to_vec(),
                },
            ])
            .expect("apply");
        assert_eq!(backend.get(b"k").expect("get"), Some(b"second".to_vec()));
    }

    #[test]
    fn the_memory_backend_reports_that_it_survives_nothing() {
        assert_eq!(MemoryBackend::new().durability(), Durability::None);
        assert!(!MemoryBackend::new().durability().may_acknowledge());
    }

    #[test]
    fn debug_prints_a_count_and_not_the_values() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[Op::Put {
                key: b"k".to_vec(),
                value: vec![0xAB, 0xCD, 0xEF, 0x12],
            }])
            .expect("apply");
        let rendered = format!("{backend:?}");
        assert!(rendered.contains("entries: 1"), "{rendered}");
        assert!(!rendered.contains("abcdef12"), "{rendered}");
        assert!(!rendered.contains("171, 205, 239, 18"), "{rendered}");
    }
}
