//! The durable backend: SQLite, WAL, `synchronous = FULL`, `secure_delete = ON`.
//!
//! Native only. `rusqlite` links SQLite's C amalgamation, which is a native
//! build by construction, so this module is behind the `sqlite` feature and the
//! browser build turns it off. `.github/workflows/rs.yml`'s wasm job builds
//! this crate with `--no-default-features` for that reason.
//!
//! # Why the same three pragmas as `f2z-relay-store`
//!
//! Because the invariant is the same one, seen from the other end. The relay
//! deletes its copy of a message when the client acknowledges
//! ([`ARCHITECTURE.md` §6.4][s64]), so for the window between "the client
//! decrypted it" and "the client's disk knows about it" the client's store is
//! the only copy in the system. The relay-side reasoning transfers verbatim:
//!
//! - **`synchronous = FULL`** — `NORMAL` in WAL mode fsyncs only at
//!   checkpoints, which is exactly the mode in which a just-acknowledged
//!   message evaporates on power loss.
//! - **WAL** — one sequential fsync per commit rather than a database-file
//!   sync, and readers that do not block the writer.
//! - **`secure_delete = ON`** — a freed page is zero-filled rather than merely
//!   unreferenced. This store holds *group secrets and plaintext*, so the
//!   difference is whether deleting a conversation deletes it or merely unlinks
//!   it for anyone who images the disk. The same caveat applies as on the relay:
//!   `secure_delete` does not scrub WAL frames written before the delete, so an
//!   operator whose threat model includes disk imaging must checkpoint, and
//!   [`SqliteBackend::checkpoint`] is that operation.
//!
//! All three are **verified after being set**, not assumed. A pragma that
//! silently did not take produces a client that believes it is durable while it
//! is not, and `CLIENT-CONTRACT.md` §3.1 puts that belief in front of the user
//! as `DurabilityMode`.
//!
//! # The `rusqlite 0.37` singleton, and why `openmls_sqlite_storage` is not here
//!
//! `AGENTS.md` records that `libsqlite3-sys` declares `links = "sqlite3"` and
//! that Cargo refuses outright to build a graph with two versions of a `links`
//! package — a hard error, not a warning. Everything under `wallet/` reaches
//! SQLite through `tauri-plugin-zcash`'s `rusqlite = "0.37"`, so 0.37 is a
//! repository-wide singleton.
//!
//! `openmls_sqlite_storage 0.2.0` — the newest *release* compatible with the
//! audited `openmls 0.8.1` — requires `rusqlite ^0.32` and is therefore
//! unusable here; #385 reproduced the exact resolver error rather than trusting
//! the note. Its `0.3.0-rc` line moved to `^0.37` and would fit, but it
//! requires `openmls_traits ^0.6.0-rc`, i.e. an unreleased `openmls 0.9.0-rc`.
//! That is the whole reason this crate exists.
//!
//! # Schema
//!
//! One table. The access pattern is exact-key get and exact-key put — see
//! [`crate::backend`] on why the trait offers no iteration — so there is
//! nothing to index beyond the key itself:
//!
//! ```sql
//! CREATE TABLE mls_kv (k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID;
//! ```
//!
//! `WITHOUT ROWID` stores the value *in* the primary-key index, so a get is one
//! B-tree descent rather than an index probe into a separate heap.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};

use crate::backend::{Durability, Op, StorageBackend};
use crate::error::{Result, StoreError};

/// A durable [`StorageBackend`] over one SQLite database.
pub struct SqliteBackend {
    connection: Mutex<Connection>,
    /// Carried rather than hardcoded, because [`SqliteBackend::open_in_memory`]
    /// is a real SQLite database with real transactions and **no disk at all**.
    /// Reporting `Durable` for it would be the exact lie this field exists to
    /// prevent: `CLIENT-CONTRACT.md` §11.2 lets a client `ACK` on a durable
    /// store, and acknowledging out of a database that lives in RAM destroys
    /// the relay's copy for nothing.
    durability: Durability,
}

impl core::fmt::Debug for SqliteBackend {
    /// Names the type and nothing else. There is nothing safe to print: the
    /// rows are group secrets, and even the key set leaks which groups exist.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SqliteBackend")
            .field("rows", &format_args!("<redacted>"))
            .finish()
    }
}

/// The pragmas, and the value each must read back as.
///
/// A list rather than three statements, so that "set it" and "check it" cannot
/// drift apart — which is the only way a durability check ever fails to catch
/// anything.
///
/// `journal_mode` is not here. It is the one pragma whose correct value depends
/// on whether there is a file: SQLite refuses WAL for an in-memory database and
/// answers `memory`, so a single expected value would either fail every
/// in-memory open or accept a file-backed database that quietly stayed in
/// rollback-journal mode. It is checked separately, against the mode the
/// storage actually admits of.
const PRAGMAS: &[(&str, &str)] = &[
    ("synchronous", "2"), // FULL
    ("secure_delete", "1"),
];

impl SqliteBackend {
    /// Open (creating if absent) the database at `path`, apply the pragmas, and
    /// verify every one of them.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] if the file cannot be opened or the schema cannot
    /// be created, and [`StoreError::Backend`] if a pragma did not take —
    /// which is a refusal to open rather than a warning, because the whole
    /// point of the type is that holding one means the writes are durable.
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Self::from_connection(connection, Durability::Durable)
    }

    /// An in-memory database.
    ///
    /// It is a real SQLite database with real transactions, so the atomicity
    /// this crate depends on is genuinely exercised — which is why the tests
    /// use it. It reports [`Durability::None`], because it has no disk, and a
    /// client on it must not `ACK`. Use [`SqliteBackend::open`] for anything a
    /// user's messages go into.
    ///
    /// # Errors
    ///
    /// As [`SqliteBackend::open`], minus the file.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?, Durability::None)
    }

    fn from_connection(connection: Connection, durability: Durability) -> Result<Self> {
        // WAL is what makes `synchronous = FULL` affordable, and it is only
        // available where there is a file. An in-memory database answers
        // `memory` and cannot be talked out of it, so the expected value is the
        // one the storage admits of — and a *file* that came back anything
        // other than `wal` is a refusal to open, not a warning.
        let expected_journal_mode = match durability {
            Durability::Durable => "wal",
            Durability::None => "memory",
        };
        connection.execute_batch(&format!("PRAGMA journal_mode = {expected_journal_mode};"))?;
        let journal_mode: String =
            connection.query_row("PRAGMA journal_mode;", [], |row| row.get::<_, String>(0))?;
        if journal_mode.to_ascii_lowercase() != expected_journal_mode {
            return Err(StoreError::Backend("open: journal_mode did not take"));
        }

        for (pragma, expected) in PRAGMAS {
            connection.execute_batch(&format!("PRAGMA {pragma} = {expected};"))?;

            let actual: String = connection.query_row(&format!("PRAGMA {pragma};"), [], |row| {
                // Pragmas answer as text or integer depending on which one.
                row.get::<_, rusqlite::types::Value>(0)
                    .map(|value| match value {
                        rusqlite::types::Value::Text(text) => text.to_ascii_lowercase(),
                        rusqlite::types::Value::Integer(integer) => integer.to_string(),
                        other => format!("{other:?}"),
                    })
            })?;

            if actual != *expected {
                return Err(StoreError::Backend(match *pragma {
                    "synchronous" => "open: synchronous did not become FULL",
                    _ => "open: secure_delete did not become ON",
                }));
            }
        }

        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS mls_kv (
                 k BLOB PRIMARY KEY,
                 v BLOB NOT NULL
             ) WITHOUT ROWID;",
        )?;

        Ok(Self {
            connection: Mutex::new(connection),
            durability,
        })
    }

    /// Retire the write-ahead log, so `secure_delete`'s zeroing covers what the
    /// log still holds. See the module note on what `secure_delete` does not do
    /// on its own.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] if the checkpoint failed, [`StoreError::Poisoned`]
    /// if another thread panicked while holding the connection.
    pub fn checkpoint(&self) -> Result<()> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        Ok(())
    }

    /// How many keys the store holds. For tests and diagnostics.
    ///
    /// # Errors
    ///
    /// [`StoreError::Sqlite`] on a query failure, [`StoreError::Poisoned`] if
    /// another thread panicked while holding the connection.
    pub fn len(&self) -> Result<u64> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM mls_kv", [], |row| row.get(0))?;
        Ok(count.unsigned_abs())
    }

    /// Whether the store holds no keys.
    ///
    /// # Errors
    ///
    /// As [`SqliteBackend::len`].
    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
}

impl StorageBackend for SqliteBackend {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare_cached("SELECT v FROM mls_kv WHERE k = ?1")?;
        let mut rows = statement.query([key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    fn apply(&self, ops: &[Op]) -> Result<()> {
        if ops.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;

        // **This transaction is the reason this crate exists.** OpenMLS has no
        // transaction API, so a `process_message` + `merge_staged_commit` run
        // arrives here as one batch and either all of it is on the disk or none
        // of it is. `rusqlite`'s `Transaction` rolls back on drop, so an early
        // return on any error below leaves the database untouched.
        let transaction = connection.transaction()?;
        {
            let mut put = transaction
                .prepare_cached("INSERT OR REPLACE INTO mls_kv (k, v) VALUES (?1, ?2)")?;
            let mut remove = transaction.prepare_cached("DELETE FROM mls_kv WHERE k = ?1")?;
            for op in ops {
                match op {
                    Op::Put { key, value } => {
                        put.execute(rusqlite::params![key, value])?;
                    }
                    Op::Delete { key } => {
                        remove.execute(rusqlite::params![key])?;
                    }
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn durability(&self) -> Durability {
        self.durability
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_in_memory_store_is_empty_and_refuses_to_call_itself_durable() {
        let backend = SqliteBackend::open_in_memory().unwrap();
        assert!(backend.is_empty().unwrap());
        assert_eq!(backend.durability(), Durability::None);
        assert!(!backend.durability().may_acknowledge());
    }

    #[test]
    fn a_file_backed_store_is_wal_and_durable() {
        let dir = tempfile::tempdir().unwrap();
        let backend = SqliteBackend::open(&dir.path().join("mls.sqlite")).unwrap();
        assert_eq!(backend.durability(), Durability::Durable);
        assert!(backend.durability().may_acknowledge());
    }

    #[test]
    fn a_batch_round_trips() {
        let backend = SqliteBackend::open_in_memory().unwrap();
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
        assert_eq!(backend.get(b"missing").unwrap(), None);
    }

    #[test]
    fn a_put_then_a_delete_of_the_same_key_in_one_batch_leaves_nothing() {
        let backend = SqliteBackend::open_in_memory().unwrap();
        backend
            .apply(&[
                Op::Put {
                    key: b"k".to_vec(),
                    value: b"v".to_vec(),
                },
                Op::Delete { key: b"k".to_vec() },
            ])
            .unwrap();
        assert_eq!(backend.get(b"k").unwrap(), None);
    }

    #[test]
    fn deleting_an_absent_key_is_not_an_error() {
        let backend = SqliteBackend::open_in_memory().unwrap();
        backend
            .apply(&[Op::Delete {
                key: b"nope".to_vec(),
            }])
            .unwrap();
    }

    #[test]
    fn an_empty_batch_succeeds_and_touches_nothing() {
        let backend = SqliteBackend::open_in_memory().unwrap();
        backend.apply(&[]).unwrap();
        assert!(backend.is_empty().unwrap());
    }

    #[test]
    fn a_file_backed_store_survives_being_closed_and_reopened() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mls.sqlite");
        {
            let backend = SqliteBackend::open(&path).unwrap();
            backend
                .apply(&[Op::Put {
                    key: b"k".to_vec(),
                    value: b"v".to_vec(),
                }])
                .unwrap();
            backend.checkpoint().unwrap();
        }
        let reopened = SqliteBackend::open(&path).unwrap();
        assert_eq!(reopened.get(b"k").unwrap(), Some(b"v".to_vec()));
    }

    #[test]
    fn debug_prints_nothing_about_the_rows() {
        let backend = SqliteBackend::open_in_memory().unwrap();
        backend
            .apply(&[Op::Put {
                key: b"k".to_vec(),
                value: vec![0xAB, 0xCD, 0xEF, 0x12],
            }])
            .unwrap();
        let rendered = format!("{backend:?}");
        assert!(!rendered.contains("abcdef12"), "{rendered}");
        assert!(!rendered.contains("171, 205, 239, 18"), "{rendered}");
    }
}
