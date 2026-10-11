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

use crate::backend::{Durability, Op, RowRewrite, StorageBackend};
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

    fn atomic_rewrite(
        &self,
        marker_key: &[u8],
        marker_value: &[u8],
        rewrite: &mut RowRewrite<'_>,
    ) -> Result<()> {
        let mut values = self.values.write().map_err(|_| StoreError::Poisoned)?;
        if values.contains_key(marker_key) {
            return Ok(());
        }

        // Complete all potentially-failing work before mutating the map. The
        // single write lock keeps a concurrent apply from changing the source
        // rows between this snapshot and the replacement.
        let mut replacements = Vec::new();
        for (old_key, old_value) in values.iter() {
            if let Some((new_key, new_value)) = rewrite(old_key, old_value)? {
                if new_key != *old_key && values.contains_key(&new_key) {
                    return Err(StoreError::Backend("migration key collision"));
                }
                replacements.push((old_key.clone(), new_key, new_value));
            }
        }

        for (old_key, new_key, new_value) in replacements {
            values.remove(&old_key);
            values.insert(new_key, new_value);
        }
        values.insert(marker_key.to_vec(), marker_value.to_vec());
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
            .unwrap();

        assert_eq!(backend.get(b"a").unwrap(), Some(b"1".to_vec()));
        assert_eq!(backend.get(b"b").unwrap(), Some(b"2".to_vec()));
        assert_eq!(backend.len().unwrap(), 2);
    }

    #[test]
    fn deleting_an_absent_key_is_not_an_error() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[Op::Delete {
                key: b"missing".to_vec(),
            }])
            .unwrap();
        assert!(backend.is_empty().unwrap());
    }

    #[test]
    fn an_empty_batch_succeeds() {
        let backend = MemoryBackend::new();
        backend.apply(&[]).unwrap();
        assert!(backend.is_empty().unwrap());
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
            .unwrap();
        assert_eq!(backend.get(b"k").unwrap(), Some(b"second".to_vec()));
    }

    #[test]
    fn the_memory_backend_reports_that_it_survives_nothing() {
        assert_eq!(MemoryBackend::new().durability(), Durability::None);
        assert!(!MemoryBackend::new().durability().may_acknowledge());
    }

    #[test]
    fn a_failed_atomic_rewrite_keeps_every_legacy_row_and_the_marker_absent() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[
                Op::Put {
                    key: b"legacy/a".to_vec(),
                    value: b"secret-a".to_vec(),
                },
                Op::Put {
                    key: b"legacy/b".to_vec(),
                    value: b"secret-b".to_vec(),
                },
            ])
            .unwrap();
        let mut calls = 0;
        let result = backend.atomic_rewrite(b"sealed/marker", b"done", &mut |key, value| {
            calls += 1;
            if calls == 2 {
                return Err(StoreError::Backend("injected transform failure"));
            }
            Ok(Some((
                [b"sealed/".as_slice(), key].concat(),
                value.to_vec(),
            )))
        });
        assert!(result.is_err());
        assert_eq!(
            backend.get(b"legacy/a").unwrap(),
            Some(b"secret-a".to_vec())
        );
        assert_eq!(
            backend.get(b"legacy/b").unwrap(),
            Some(b"secret-b".to_vec())
        );
        assert_eq!(backend.get(b"sealed/marker").unwrap(), None);
        assert_eq!(backend.get(b"sealed/legacy/a").unwrap(), None);
    }

    #[test]
    fn debug_prints_a_count_and_not_the_values() {
        let backend = MemoryBackend::new();
        backend
            .apply(&[Op::Put {
                key: b"k".to_vec(),
                value: vec![0xAB, 0xCD, 0xEF, 0x12],
            }])
            .unwrap();
        let rendered = format!("{backend:?}");
        assert!(rendered.contains("entries: 1"), "{rendered}");
        assert!(!rendered.contains("abcdef12"), "{rendered}");
        assert!(!rendered.contains("171, 205, 239, 18"), "{rendered}");
    }
}
