//! The durable store: SQLite, WAL, `synchronous = FULL`, `secure_delete = ON`.
//!
//! # Why these three settings and not others
//!
//! **`synchronous = FULL`** is not tuning. Under delete-on-ack the relay's copy
//! is the only copy in the system for the whole window between `accepted` and
//! `ACK` ([`ARCHITECTURE.md` §6.4][s64]), so an `APPEND` answered before the
//! bytes reached stable storage is a promise of custody the relay cannot keep.
//! `NORMAL` in WAL mode fsyncs only at checkpoints and is exactly the mode in
//! which a recently-accepted message evaporates on power loss.
//!
//! **WAL** is what makes `FULL` affordable: one sequential fsync of the log per
//! commit rather than a database-file sync, and readers that do not block the
//! writer. `READ`, `ACK` and `DELETE_QUEUE` are the operations §13.1 says must
//! never be refused under load, and a journalling mode where a reader blocks
//! the writer is a journalling mode where a flood of appends starves the
//! operations that make the relay smaller.
//!
//! **`secure_delete = ON`** makes a freed page zero-filled rather than merely
//! unreferenced. That is the difference between "the ciphertext is deleted" and
//! "the ciphertext is unlinked but recoverable by anyone who images the disk",
//! and the second one would make [`THREAT-MODEL.md` §4.5][s45]'s "server-side
//! deletion is auditable" claim vacuous.
//!
//! All three are **verified after being set**, not assumed. A pragma that
//! silently did not take is the failure mode that produces a relay believing it
//! is durable while it is not, and it is one query to rule out.
//!
//! # What `secure_delete` does not cover, stated
//!
//! In WAL mode the pre-deletion image of a page can still exist **in the
//! write-ahead log** until a checkpoint retires it. `secure_delete` zeroes the
//! page in the database file; it does not go back and scrub log frames written
//! before the delete. So an operator whose threat model includes disk imaging
//! must checkpoint, and [`SqliteStore::checkpoint`] is that operation. It is
//! exposed rather than run on every commit because a truncating checkpoint is
//! an fsync of the whole database and doing it per-ACK would give back
//! everything WAL was chosen for.
//!
//! # Schema
//!
//! Two tables, both `WITHOUT ROWID`, and the shape is chosen by the access
//! pattern rather than by habit:
//!
//! ```sql
//! CREATE TABLE message (
//!     recv_addr BLOB, idx INTEGER, ..., payload BLOB,
//!     PRIMARY KEY (recv_addr, idx)
//! ) WITHOUT ROWID;
//! ```
//!
//! `WITHOUT ROWID` stores the row *in* the index, keyed by `(recv_addr, idx)`.
//! One queue's messages are therefore physically contiguous and in index order,
//! which makes `READ` a range scan from the acked watermark and makes `ACK` —
//! cumulative, so always a prefix — a range delete over one contiguous run.
//! With an ordinary rowid table both would be an index probe per row into a
//! heap ordered by insertion across every queue on the relay.
//!
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements
//! [s45]: https://github.com/free2z/zuu/blob/main/docs/e2ee/THREAT-MODEL.md#45-server-side-deletion-is-auditable-not-verifiable

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};

use f2z_codec::types::{KeyPackage, Payload, PublicKey, QueueAddress};
use f2z_relay_proto::queue::{AckOutcome, AppendQuota, QueueKind, QueueState};
use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::durability::{Committed, Durability};
use crate::error::{Result, StoreError};
use crate::record::{
    Append, Appended, ClaimedKeyPackage, Deleted, ExpiryReason, ExpiryReport, KeyPackagePool,
    QueueExpiry, QueueRecord, QueueSpec, ReadPage, ReadWindow, SendAuth, StoreStats, StoredMessage,
    idle_deadline, message_deadline,
};
use crate::store::RelayStore;

use self::counted::{CountedTransaction, WriteConnection};

/// Making the fsync counter's population closed, by type rather than by care.
///
/// # What is being protected
///
/// [`SqliteStore::commits`] counts durable commits, and that number is not
/// decoration: `f2z-relay`'s group-commit writer (`f2z-relay/src/commit.rs`)
/// rests its entire argument on it — "`SqliteStore::commits`, which counts
/// fsyncs so the amortization is checkable rather than asserted" — and
/// `f2z-relay/tests/group_commit.rs`'s
/// `a_hundred_concurrent_appends_do_not_cost_a_hundred_fsyncs` asserts
/// `fsyncs < APPENDS`. A commit that happened without being counted therefore
/// makes that assertion *easier* to satisfy: the evidence for group commit
/// would weaken in the direction that still looks green.
///
/// # Why a type and not a comment
///
/// The counter used to be defended by a sentence saying every commit goes
/// through one helper. That was true, and nothing enforced it — a
/// `tx.commit()?` written next to any transaction site compiled, passed, and
/// silently stopped incrementing the counter. These two newtypes remove the
/// expression rather than warn about it:
///
/// * [`WriteConnection`] derefs to `&Connection` and **never** to
///   `&mut Connection`. `rusqlite::Connection::transaction` needs `&mut self`,
///   so the only way to begin a write transaction is [`WriteConnection::begin`].
///   Reads are unaffected — they only ever needed `&Connection`.
/// * [`CountedTransaction`] owns the `rusqlite::Transaction` in a private field
///   and derefs to `&Transaction`, so the transaction can never be moved back
///   out. `Transaction::commit` consumes `self`, which a shared deref cannot
///   provide. The one reachable commit is
///   [`CountedTransaction::commit`], which increments the counter.
///
/// The pleasant consequence is that the mistake the old comment warned about —
/// writing `tx.commit()?` at a call site — now resolves to the inherent method
/// and *counts*. There is no spelling of "commit without counting" left inside
/// `sqlite.rs`; the only remaining way to add one is to add a method to this
/// module, whose entire purpose is stated above.
mod counted {
    use std::ops::Deref;
    use std::sync::atomic::{AtomicU64, Ordering};

    use rusqlite::{Connection, Transaction};

    /// The store's connection, handed out by shared reference only.
    #[derive(Debug)]
    pub(super) struct WriteConnection(Connection);

    impl WriteConnection {
        pub(super) fn new(connection: Connection) -> Self {
            Self(connection)
        }

        /// Begin the only kind of write transaction this file can express.
        ///
        /// `commits` is the counter the returned transaction will bump, so a
        /// transaction cannot be started without naming what will account for
        /// it.
        pub(super) fn begin<'conn>(
            &'conn mut self,
            commits: &'conn AtomicU64,
        ) -> rusqlite::Result<CountedTransaction<'conn>> {
            Ok(CountedTransaction {
                tx: self.0.transaction()?,
                commits,
            })
        }
    }

    impl Deref for WriteConnection {
        type Target = Connection;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    /// A write transaction whose only commit path increments the fsync counter.
    #[derive(Debug)]
    pub(super) struct CountedTransaction<'conn> {
        tx: Transaction<'conn>,
        commits: &'conn AtomicU64,
    }

    impl CountedTransaction<'_> {
        /// Commit, and count the fsync it cost.
        ///
        /// Dropping without calling this rolls back, as with any
        /// `rusqlite::Transaction`, and correctly counts nothing.
        pub(super) fn commit(self) -> rusqlite::Result<()> {
            let Self { tx, commits } = self;
            tx.commit()?;
            commits.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }

    impl<'conn> Deref for CountedTransaction<'conn> {
        type Target = Transaction<'conn>;

        fn deref(&self) -> &Self::Target {
            &self.tx
        }
    }
}

/// The schema version stamped into `PRAGMA user_version`.
///
/// **2 since §12.6.** Version 1 is the queue-and-message schema; version 2 adds
/// the `key_package` table and nothing else. The change is purely additive, so
/// a version-1 database is upgraded in place by the `CREATE TABLE IF NOT
/// EXISTS` in [`SCHEMA`] plus a stamp — see [`SqliteStore::prepare`]. A version
/// this build does not know is still a hard refusal: opening a newer database
/// read-write is how a downgrade silently drops rows.
const SCHEMA_VERSION: i32 = 2;

/// The first schema version, upgradable in place to [`SCHEMA_VERSION`].
const SCHEMA_VERSION_WITHOUT_KEY_PACKAGES: i32 = 1;

const SCHEMA: &str = "\
CREATE TABLE IF NOT EXISTS queue (
    recv_addr            BLOB    NOT NULL PRIMARY KEY,
    send_addr            BLOB    NOT NULL UNIQUE,
    kind                 INTEGER NOT NULL,
    recv_key             BLOB    NOT NULL,
    send_key             BLOB,
    next_index           INTEGER NOT NULL,
    acked_through        INTEGER,
    message_ttl_seconds  INTEGER NOT NULL,
    idle_ttl_seconds     INTEGER NOT NULL,
    max_messages         INTEGER NOT NULL,
    max_bytes            INTEGER NOT NULL,
    stored_messages      INTEGER NOT NULL,
    stored_bytes         INTEGER NOT NULL,
    created_at_ms        INTEGER NOT NULL,
    last_activity_ms     INTEGER NOT NULL,
    idle_expires_at_ms   INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS queue_idle_expiry ON queue (idle_expires_at_ms);

CREATE TABLE IF NOT EXISTS message (
    recv_addr       BLOB    NOT NULL,
    idx             INTEGER NOT NULL,
    received_at_ms  INTEGER NOT NULL,
    expires_at_ms   INTEGER NOT NULL,
    payload         BLOB    NOT NULL,
    PRIMARY KEY (recv_addr, idx)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS message_expiry ON message (expires_at_ms);

CREATE TABLE IF NOT EXISTS key_package (
    recv_addr    BLOB    NOT NULL,
    seq          INTEGER NOT NULL,
    last_resort  INTEGER NOT NULL,
    package      BLOB    NOT NULL,
    PRIMARY KEY (recv_addr, seq),
    FOREIGN KEY (recv_addr) REFERENCES queue (recv_addr) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS key_package_last_resort
    ON key_package (recv_addr) WHERE last_resort = 1;
";

/// Every column of `queue`, in the order [`record_from_row`] reads them.
const QUEUE_COLUMNS: &str = "recv_addr, send_addr, kind, recv_key, send_key, next_index, \
     acked_through, message_ttl_seconds, idle_ttl_seconds, max_messages, max_bytes, \
     stored_messages, stored_bytes, created_at_ms, last_activity_ms";

/// A relay's durable queue storage.
///
/// `Send + Sync`: the connection is behind a mutex, which is also what
/// serializes the write transactions that group commit depends on. SQLite would
/// serialize writers anyway — this way the queue for the write lock is in Rust,
/// where the batching driver can see it.
#[derive(Debug)]
pub struct SqliteStore {
    connection: Mutex<WriteConnection>,
    /// §7.7 idle-timer activity that has not been written yet. See
    /// [`RelayStore::touch`] for why this is deliberately not durable.
    activity: Mutex<HashMap<QueueAddress, u64>>,
    /// Durable commits performed. See [`SqliteStore::commits`].
    commits: AtomicU64,
}

impl SqliteStore {
    /// Open or create a store at `path`.
    ///
    /// # Errors
    ///
    /// [`StoreError::Backend`] if the file cannot be opened, if any of the
    /// three pragmas did not take, or if the schema cannot be created.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        Self::prepare(connection, Journalling::WriteAheadLog)
    }

    /// Open a store that lives only in this process's memory.
    ///
    /// **Still SQLite, still the same SQL, and still not durable.** This is for
    /// exercising the SQL itself; [`MemoryStore`] is the store that reports
    /// `durability_mode = memory` honestly. Kept because a bug in a `WITHOUT
    /// ROWID` range delete is a bug in the SQL, and finding it should not need
    /// a temporary directory.
    ///
    /// # Errors
    ///
    /// [`StoreError::Backend`] as for [`SqliteStore::open`].
    ///
    /// [`MemoryStore`]: crate::MemoryStore
    pub fn open_in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        Self::prepare(connection, Journalling::None)
    }

    fn prepare(connection: Connection, journalling: Journalling) -> Result<Self> {
        // Ordering matters. `auto_vacuum` is only settable before the first
        // table exists, and `journal_mode` must be WAL before anything is
        // written so that the first transaction is already journalled the way
        // every later one will be.
        connection.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA secure_delete = ON;
             PRAGMA foreign_keys = ON;
             PRAGMA trusted_schema = OFF;
             PRAGMA busy_timeout = 5000;",
        )?;

        // Verified, not assumed: a pragma that silently did not take is how a
        // relay comes to believe it is durable while it is not.
        if matches!(journalling, Journalling::WriteAheadLog) {
            expect_pragma(&connection, "journal_mode", "wal")?;
        }
        expect_pragma(&connection, "synchronous", "2")?;
        expect_pragma(&connection, "secure_delete", "1")?;

        connection.execute_batch(SCHEMA)?;
        let version: i32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        // 0 is a database this process just created. 1 is a pre-§12.6 relay's,
        // and the batch above has already added the one table that separates
        // it from 2, so the upgrade is the stamp. Anything else is refused:
        // opening a database written by a *newer* build read-write is how a
        // downgrade quietly discards rows it does not understand.
        if version == 0 || version == SCHEMA_VERSION_WITHOUT_KEY_PACKAGES {
            connection.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        } else if version != SCHEMA_VERSION {
            return Err(StoreError::Corrupt(
                "database was written by a different schema version of f2z-relay-store",
            ));
        }

        Ok(Self {
            connection: Mutex::new(WriteConnection::new(connection)),
            activity: Mutex::new(HashMap::new()),
            commits: AtomicU64::new(0),
        })
    }

    /// Retire the write-ahead log and return free pages to the filesystem.
    ///
    /// The operation `secure_delete` alone does not perform — see the module
    /// note. An operator whose threat model includes disk imaging should run
    /// this on a timer; every relay should run it occasionally so that a queue
    /// that was drained and deleted actually gives its disk back, which is
    /// ADR 0005's `$5/month VPS` arithmetic.
    ///
    /// # Errors
    ///
    /// [`StoreError::Backend`] on storage failure.
    pub fn checkpoint(&self) -> Result<()> {
        let connection = self.lock_connection();
        connection.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);
             PRAGMA incremental_vacuum;",
        )?;
        Ok(())
    }

    /// Durable commits performed since this store was opened.
    ///
    /// At `synchronous = FULL` a commit is an fsync, and the disk's fsync rate
    /// — on the order of 50-200 a second on the cheap VPS ADR 0005's economics
    /// assume — is the relay's hard write ceiling. This counter is therefore
    /// the number an operator should graph, and it is what makes group commit
    /// *checkable* rather than asserted: a batch of a hundred appends must move
    /// it by one, not by a hundred.
    #[must_use]
    pub fn commits(&self) -> u64 {
        self.commits.load(Ordering::Relaxed)
    }

    /// Commit, and release the activity buffer the commit made durable.
    ///
    /// The counting itself lives one level down, in
    /// [`CountedTransaction::commit`], because that is the only place a
    /// `rusqlite::Transaction` can be committed from — see the [`counted`]
    /// module for why the counter's population is closed by type rather than
    /// by this comment. What is left here is the part that is genuinely a
    /// policy of the store: when the staged touches may be dropped.
    fn commit(
        &self,
        tx: CountedTransaction<'_>,
        mut activity: std::sync::MutexGuard<'_, HashMap<QueueAddress, u64>>,
    ) -> Result<()> {
        tx.commit()?;
        // Keep the touches until the transaction is known to be durable. If
        // any operation returns after staging them, dropping its transaction
        // also drops this guard without clearing the buffer, so the next
        // transaction retries the activity instead of silently losing it.
        activity.clear();
        Ok(())
    }

    /// A poisoned mutex is not a reason to stop serving.
    ///
    /// The lock guards a SQLite connection whose consistency is SQLite's job:
    /// a panic while it was held aborted whatever transaction was open, and the
    /// next `BEGIN` starts from committed state. Refusing every subsequent
    /// request would convert one fault into a permanent outage of `READ` and
    /// `ACK`, which are the two operations §13.1 says must never be refused.
    fn lock_connection(&self) -> std::sync::MutexGuard<'_, WriteConnection> {
        self.connection
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn lock_activity(&self) -> std::sync::MutexGuard<'_, HashMap<QueueAddress, u64>> {
        self.activity.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Buffer an idle-timer touch. Never durable on its own.
    fn record_activity(&self, recv_addr: &QueueAddress, now_ms: u64) {
        let mut activity = self.lock_activity();
        let slot = activity.entry(*recv_addr).or_insert(now_ms);
        if *slot < now_ms {
            *slot = now_ms;
        }
    }

    /// Fold buffered touches into the transaction that is about to commit.
    ///
    /// The returned guard deliberately remains locked until [`Self::commit`].
    /// That makes the buffer transactional without a second durable table:
    /// an error drops the transaction and leaves every touch in the map, while
    /// a successful commit clears exactly the set it held. A concurrent touch
    /// waits rather than racing a newer timestamp against the clear.
    fn flush_activity(
        &self,
        tx: &Transaction<'_>,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<QueueAddress, u64>>> {
        let activity = self.lock_activity();
        let mut statement = tx.prepare_cached(
            "UPDATE queue SET last_activity_ms = ?2, idle_expires_at_ms = ?3 \
             WHERE recv_addr = ?1 AND last_activity_ms < ?2",
        )?;
        for (recv_addr, at_ms) in activity.iter() {
            let ttl: Option<u32> = tx
                .query_row(
                    "SELECT idle_ttl_seconds FROM queue WHERE recv_addr = ?1",
                    [recv_addr.as_ref()],
                    |row| row.get(0),
                )
                .optional()?;
            // The queue may have been deleted or expired since the touch. §7.6
            // forbids a tombstone, so there is nothing to update and nothing to
            // report.
            let Some(ttl) = ttl else { continue };
            statement.execute(rusqlite::params![
                recv_addr.as_ref(),
                to_i64(*at_ms)?,
                to_i64(idle_deadline(*at_ms, ttl))?,
            ])?;
        }
        drop(statement);
        Ok(activity)
    }
}

/// Whether this connection has a file to journal to.
///
/// A `:memory:` database cannot be WAL — there is no file for a write-ahead log
/// — and SQLite silently reports `memory` instead of failing. Asking for the
/// WAL verification only where WAL is possible is what keeps the check strict
/// where it matters instead of being loosened to accommodate the one case where
/// it cannot hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Journalling {
    /// A file-backed store. `journal_mode = wal` is required.
    WriteAheadLog,
    /// A `:memory:` store, which is not durable and does not claim to be.
    None,
}

/// Read a pragma back and insist it says what it was set to.
fn expect_pragma(connection: &Connection, name: &str, expected: &str) -> Result<()> {
    let actual: String = connection.query_row(&format!("PRAGMA {name}"), [], |row| {
        row.get::<_, rusqlite::types::Value>(0)
            .map(|value| match value {
                rusqlite::types::Value::Text(text) => text,
                rusqlite::types::Value::Integer(number) => number.to_string(),
                other => format!("{other:?}"),
            })
    })?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(StoreError::Corrupt(match name {
            "journal_mode" => "PRAGMA journal_mode did not take: this store is not WAL-journalled",
            "synchronous" => {
                "PRAGMA synchronous did not take: an accepted APPEND would not be durable"
            }
            _ => "PRAGMA secure_delete did not take: deleted ciphertext would remain on disk",
        }))
    }
}

fn to_i64(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| StoreError::ValueOutOfRange)
}

fn from_i64(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(|_| StoreError::Corrupt("a stored counter is negative"))
}

fn address(bytes: &[u8]) -> Result<QueueAddress> {
    QueueAddress::from_slice(bytes)
        .map_err(|_| StoreError::Corrupt("a stored address is not 32 bytes"))
}

fn public_key(bytes: &[u8]) -> Result<PublicKey> {
    PublicKey::from_slice(bytes).map_err(|_| StoreError::Corrupt("a stored key is not 32 bytes"))
}

const fn kind_tag(kind: QueueKind) -> i64 {
    match kind {
        QueueKind::Standard => 0,
        QueueKind::Contact => 1,
    }
}

fn kind_from_tag(tag: i64) -> Result<QueueKind> {
    match tag {
        0 => Ok(QueueKind::Standard),
        1 => Ok(QueueKind::Contact),
        _ => Err(StoreError::Corrupt("a stored queue kind is unknown")),
    }
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Result<QueueRecord>> {
    let recv_addr: Vec<u8> = row.get(0)?;
    let send_addr: Vec<u8> = row.get(1)?;
    let kind: i64 = row.get(2)?;
    let recv_key: Vec<u8> = row.get(3)?;
    let send_key: Option<Vec<u8>> = row.get(4)?;
    let next_index: i64 = row.get(5)?;
    let acked_through: Option<i64> = row.get(6)?;
    let message_ttl_seconds: u32 = row.get(7)?;
    let idle_ttl_seconds: u32 = row.get(8)?;
    let max_messages: i64 = row.get(9)?;
    let max_bytes: i64 = row.get(10)?;
    let stored_messages: i64 = row.get(11)?;
    let stored_bytes: i64 = row.get(12)?;
    let created_at_ms: i64 = row.get(13)?;
    let last_activity_ms: i64 = row.get(14)?;

    Ok(build_record(RawQueue {
        recv_addr,
        send_addr,
        kind,
        recv_key,
        send_key,
        next_index,
        acked_through,
        message_ttl_seconds,
        idle_ttl_seconds,
        max_messages,
        max_bytes,
        stored_messages,
        stored_bytes,
        created_at_ms,
        last_activity_ms,
    }))
}

struct RawQueue {
    recv_addr: Vec<u8>,
    send_addr: Vec<u8>,
    kind: i64,
    recv_key: Vec<u8>,
    send_key: Option<Vec<u8>>,
    next_index: i64,
    acked_through: Option<i64>,
    message_ttl_seconds: u32,
    idle_ttl_seconds: u32,
    max_messages: i64,
    max_bytes: i64,
    stored_messages: i64,
    stored_bytes: i64,
    created_at_ms: i64,
    last_activity_ms: i64,
}

fn build_record(raw: RawQueue) -> Result<QueueRecord> {
    let kind = kind_from_tag(raw.kind)?;
    let send_key = match raw.send_key {
        Some(bytes) => Some(public_key(&bytes)?),
        None => None,
    };
    // The acknowledgement arithmetic is `f2z-relay-proto`'s, restored rather
    // than reimplemented: §8.2's anti-pre-ack rule written twice is §8.2's rule
    // written once and violated once.
    let state = QueueState::restore(
        kind,
        public_key(&raw.recv_key)?,
        send_key,
        from_i64(raw.next_index)?,
        raw.acked_through.map(from_i64).transpose()?,
    )?;
    Ok(QueueRecord {
        recv_addr: address(&raw.recv_addr)?,
        send_addr: address(&raw.send_addr)?,
        state,
        message_ttl_seconds: raw.message_ttl_seconds,
        idle_ttl_seconds: raw.idle_ttl_seconds,
        quota: AppendQuota {
            max_messages: from_i64(raw.max_messages)?,
            max_bytes: from_i64(raw.max_bytes)?,
        },
        stored_messages: from_i64(raw.stored_messages)?,
        stored_bytes: from_i64(raw.stored_bytes)?,
        created_at_ms: from_i64(raw.created_at_ms)?,
        last_activity_ms: from_i64(raw.last_activity_ms)?,
    })
}

fn load_by_recv(connection: &Connection, recv_addr: &QueueAddress) -> Result<Option<QueueRecord>> {
    let found = connection
        .query_row(
            &format!("SELECT {QUEUE_COLUMNS} FROM queue WHERE recv_addr = ?1"),
            [recv_addr.as_ref()],
            record_from_row,
        )
        .optional()?;
    found.transpose()
}

fn load_by_send(connection: &Connection, send_addr: &QueueAddress) -> Result<Option<QueueRecord>> {
    let found = connection
        .query_row(
            &format!("SELECT {QUEUE_COLUMNS} FROM queue WHERE send_addr = ?1"),
            [send_addr.as_ref()],
            record_from_row,
        )
        .optional()?;
    found.transpose()
}

/// §6.3 / §12.2: which writers a queue accepts.
pub(crate) fn authorize_send(record: &QueueRecord, auth: &SendAuth) -> Result<()> {
    match (record.kind(), auth) {
        (QueueKind::Standard, SendAuth::Signed(signer)) => record
            .state
            .authorize_send(signer)
            .map_err(StoreError::from),
        // §12.2 point 2: a contact queue "accepts unsigned appends from anyone
        // who presents a valid proof-of-work stamp", which the caller has
        // already verified. There is no key to check because there is
        // deliberately no key at all.
        (QueueKind::Contact, SendAuth::ContactStamp) => Ok(()),
        // A signed APPEND to a published contact address, or an unsigned
        // CONTACT_APPEND to an ordinary send address. Both refuse as
        // ERR_UNAVAILABLE, because a writer must not learn which kind of queue
        // an address is.
        (QueueKind::Standard, SendAuth::ContactStamp)
        | (QueueKind::Contact, SendAuth::Signed(_)) => Err(StoreError::unavailable()),
    }
}

/// Sum and count the messages a range delete is about to remove.
fn range_totals(
    connection: &Connection,
    recv_addr: &QueueAddress,
    through: Option<i64>,
) -> Result<(u64, u64)> {
    let (count, bytes): (i64, i64) = match through {
        Some(through) => connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM message \
             WHERE recv_addr = ?1 AND idx <= ?2",
            rusqlite::params![recv_addr.as_ref(), through],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?,
        None => connection.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM message \
             WHERE recv_addr = ?1",
            [recv_addr.as_ref()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?,
    };
    Ok((from_i64(count)?, from_i64(bytes)?))
}

impl RelayStore for SqliteStore {
    fn durability(&self) -> Durability {
        Durability::FsyncPerAppend
    }

    fn create_queue(&self, spec: &QueueSpec) -> Result<Committed<QueueRecord>> {
        if spec.recv_addr == spec.send_addr {
            return Err(StoreError::AddressCollision);
        }
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        // Both addresses are drawn from one 32-byte space, and a lookup by
        // either must be unambiguous, so a new address colliding with an
        // existing address of *either* kind is a collision. §7.1's answer is to
        // draw again.
        let taken: i64 = tx.query_row(
            "SELECT COUNT(*) FROM queue WHERE recv_addr IN (?1, ?2) OR send_addr IN (?1, ?2)",
            rusqlite::params![spec.recv_addr.as_ref(), spec.send_addr.as_ref()],
            |row| row.get(0),
        )?;
        if taken != 0 {
            return Err(StoreError::AddressCollision);
        }

        let idle_expires = idle_deadline(spec.created_at_ms, spec.idle_ttl_seconds);
        tx.execute(
            "INSERT INTO queue (recv_addr, send_addr, kind, recv_key, send_key, next_index, \
             acked_through, message_ttl_seconds, idle_ttl_seconds, max_messages, max_bytes, \
             stored_messages, stored_bytes, created_at_ms, last_activity_ms, idle_expires_at_ms) \
             VALUES (?1, ?2, ?3, ?4, NULL, 0, NULL, ?5, ?6, ?7, ?8, 0, 0, ?9, ?9, ?10)",
            rusqlite::params![
                spec.recv_addr.as_ref(),
                spec.send_addr.as_ref(),
                kind_tag(spec.kind),
                spec.recv_key.as_ref(),
                spec.message_ttl_seconds,
                spec.idle_ttl_seconds,
                to_i64(spec.quota.max_messages)?,
                to_i64(spec.quota.max_bytes)?,
                to_i64(spec.created_at_ms)?,
                to_i64(idle_expires)?,
            ],
        )?;
        self.commit(tx, activity)?;

        Ok(Committed::seal(
            self.durability(),
            QueueRecord {
                recv_addr: spec.recv_addr,
                send_addr: spec.send_addr,
                state: QueueState::create(spec.kind, spec.recv_key),
                message_ttl_seconds: spec.message_ttl_seconds,
                idle_ttl_seconds: spec.idle_ttl_seconds,
                quota: spec.quota,
                stored_messages: 0,
                stored_bytes: 0,
                created_at_ms: spec.created_at_ms,
                last_activity_ms: spec.created_at_ms,
            },
        ))
    }

    fn bind_send(
        &self,
        send_addr: &QueueAddress,
        signer: &PublicKey,
        now_ms: u64,
    ) -> Result<Committed<()>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        let Some(mut record) = load_by_send(&tx, send_addr)? else {
            return Err(StoreError::unavailable());
        };
        // The bound key *is* the signer: §5.1 step 5 cannot apply when no key is
        // registered yet, and `f2z-relay-proto` closes that by requiring the
        // two to be equal. This call is where bind-once and the contact-queue
        // refusal both live.
        record.state.bind_send(signer)?;

        tx.execute(
            "UPDATE queue SET send_key = ?2, last_activity_ms = MAX(last_activity_ms, ?3), \
             idle_expires_at_ms = MAX(idle_expires_at_ms, ?4) WHERE recv_addr = ?1",
            rusqlite::params![
                record.recv_addr.as_ref(),
                signer.as_ref(),
                to_i64(now_ms)?,
                to_i64(idle_deadline(now_ms, record.idle_ttl_seconds))?,
            ],
        )?;
        self.commit(tx, activity)?;
        Ok(Committed::seal(self.durability(), ()))
    }

    fn queue_by_recv(&self, recv_addr: &QueueAddress, signer: &PublicKey) -> Result<QueueRecord> {
        let connection = self.lock_connection();
        let record = load_by_recv(&connection, recv_addr)?.ok_or_else(StoreError::no_access)?;
        record.state.authorize_recv(signer)?;
        Ok(record)
    }

    fn queue_by_send(&self, send_addr: &QueueAddress, auth: &SendAuth) -> Result<QueueRecord> {
        let connection = self.lock_connection();
        let record = load_by_send(&connection, send_addr)?.ok_or_else(StoreError::unavailable)?;
        authorize_send(&record, auth)?;
        Ok(record)
    }

    fn append_batch(&self, appends: &[Append<'_>]) -> Result<Committed<Vec<Result<Appended>>>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        let mut results: Vec<Result<Appended>> = Vec::with_capacity(appends.len());
        for append in appends {
            match append_one(&tx, append) {
                Ok(appended) => results.push(Ok(appended)),
                // A protocol refusal happens strictly before this append writes
                // anything, so the transaction is still clean and the rest of
                // the batch is unaffected: one writer hitting its cap must not
                // undo an unrelated queue's durable write.
                Err(error @ StoreError::Protocol(_)) => results.push(Err(error)),
                // Anything else means the transaction itself is suspect.
                // Returning here drops it, which rolls the whole batch back.
                Err(other) => return Err(other),
            }
        }

        #[cfg(feature = "crash-injection")]
        crate::crash::fire(crate::crash::CrashPoint::BeforeAppendCommit);
        self.commit(tx, activity)?;
        #[cfg(feature = "crash-injection")]
        crate::crash::fire(crate::crash::CrashPoint::AfterAppendCommit);

        Ok(Committed::seal(self.durability(), results))
    }

    fn read(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        window: ReadWindow,
        now_ms: u64,
    ) -> Result<ReadPage> {
        let page = {
            let connection = self.lock_connection();
            let record = load_by_recv(&connection, recv_addr)?.ok_or_else(StoreError::no_access)?;
            record.state.authorize_recv(signer)?;
            read_page(&connection, &record, window, now_ms)?
        };
        self.record_activity(recv_addr, now_ms);
        Ok(page)
    }

    fn ack(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        up_to_index: u64,
        now_ms: u64,
    ) -> Result<Committed<AckOutcome>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        let mut record = load_by_recv(&tx, recv_addr)?.ok_or_else(StoreError::no_access)?;
        record.state.authorize_recv(signer)?;
        // §8.2 first: a pre-ack must not move the watermark, and must not
        // delete anything on its way to failing.
        let outcome = record.state.ack(up_to_index)?;

        let through = to_i64(up_to_index)?;
        let (removed, bytes_freed) = if outcome.acknowledged == 0 {
            (0, 0)
        } else {
            let totals = range_totals(&tx, recv_addr, Some(through))?;
            // The prefix delete §8.1's cumulative rule makes possible: one
            // contiguous run at the front of this queue's `WITHOUT ROWID`
            // storage.
            tx.execute(
                "DELETE FROM message WHERE recv_addr = ?1 AND idx <= ?2",
                rusqlite::params![recv_addr.as_ref(), through],
            )?;
            totals
        };

        // The watermark advance and the delete are one statement apart inside
        // one transaction. That is the invariant: no crash can leave a message
        // stored at or below the persisted watermark.
        tx.execute(
            "UPDATE queue SET acked_through = ?2, stored_messages = ?3, stored_bytes = ?4, \
             last_activity_ms = MAX(last_activity_ms, ?5), \
             idle_expires_at_ms = MAX(idle_expires_at_ms, ?6) WHERE recv_addr = ?1",
            rusqlite::params![
                recv_addr.as_ref(),
                record.state.acked_through().map(to_i64).transpose()?,
                to_i64(record.stored_messages.saturating_sub(removed))?,
                to_i64(record.stored_bytes.saturating_sub(bytes_freed))?,
                to_i64(now_ms)?,
                to_i64(idle_deadline(now_ms, record.idle_ttl_seconds))?,
            ],
        )?;

        #[cfg(feature = "crash-injection")]
        crate::crash::fire(crate::crash::CrashPoint::BeforeAckCommit);
        self.commit(tx, activity)?;
        #[cfg(feature = "crash-injection")]
        crate::crash::fire(crate::crash::CrashPoint::AfterAckCommit);

        Ok(Committed::seal(self.durability(), outcome))
    }

    fn publish_key_packages(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        packages: &[KeyPackage],
        last_resort: Option<&KeyPackage>,
        max_pool: u32,
        now_ms: u64,
    ) -> Result<Committed<KeyPackagePool>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        let record = load_by_recv(&tx, recv_addr)?.ok_or_else(StoreError::no_access)?;
        record.state.authorize_recv(signer)?;
        if !matches!(record.kind(), QueueKind::Contact) {
            return Err(StoreError::not_permitted());
        }

        // The whole pool, so duplicates are decided against committed state
        // rather than against what this batch happens to have inserted so far.
        let mut held: Vec<Vec<u8>> = tx
            .prepare_cached(
                "SELECT package FROM key_package WHERE recv_addr = ?1 ORDER BY seq ASC",
            )?
            .query_map([recv_addr.as_ref()], |row| row.get::<_, Vec<u8>>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut pool_size = u64::try_from(tx.query_row(
            "SELECT COUNT(*) FROM key_package WHERE recv_addr = ?1 AND last_resort = 0",
            [recv_addr.as_ref()],
            |row| row.get::<_, i64>(0),
        )?)
        .unwrap_or(0);
        let mut next_seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), -1) + 1 FROM key_package WHERE recv_addr = ?1",
                [recv_addr.as_ref()],
                |row| row.get(0),
            )
            .unwrap_or(0);

        let max = u64::from(max_pool);
        for package in packages {
            if pool_size >= max {
                break;
            }
            if held.iter().any(|stored| stored == package.as_slice()) {
                continue;
            }
            tx.prepare_cached(
                "INSERT INTO key_package (recv_addr, seq, last_resort, package) \
                 VALUES (?1, ?2, 0, ?3)",
            )?
            .execute(rusqlite::params![
                recv_addr.as_ref(),
                next_seq,
                package.as_slice()
            ])?;
            held.push(package.as_slice().to_vec());
            pool_size = pool_size.saturating_add(1);
            next_seq = next_seq.saturating_add(1);
        }

        if let Some(package) = last_resort {
            // `held` is the complete pre-transaction state plus every package
            // accepted above. A collision means this init key is already
            // single-use (or is the current fallback), so replacing would
            // either downgrade it to reusable or do needless work. In either
            // case the existing fallback stays exactly as it was.
            if !held.iter().any(|stored| stored == package.as_slice()) {
                tx.execute(
                    "DELETE FROM key_package WHERE recv_addr = ?1 AND last_resort = 1",
                    [recv_addr.as_ref()],
                )?;
                tx.prepare_cached(
                    "INSERT INTO key_package (recv_addr, seq, last_resort, package) \
                     VALUES (?1, ?2, 1, ?3)",
                )?
                .execute(rusqlite::params![
                    recv_addr.as_ref(),
                    next_seq,
                    package.as_slice()
                ])?;
            }
        }
        let has_last_resort: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM key_package WHERE recv_addr = ?1 AND last_resort = 1)",
            [recv_addr.as_ref()],
            |row| row.get(0),
        )?;

        self.commit(tx, activity)?;
        self.record_activity(recv_addr, now_ms);
        Ok(Committed::seal(
            self.durability(),
            KeyPackagePool {
                pool_size: u32::try_from(pool_size).unwrap_or(u32::MAX),
                has_last_resort,
            },
        ))
    }

    fn claim_key_package(
        &self,
        contact_addr: &QueueAddress,
    ) -> Result<Committed<ClaimedKeyPackage>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        // Absent, and not-a-contact-queue, are one refusal — §10's rule holds
        // for a published address exactly as it does for any other.
        let record = load_by_send(&tx, contact_addr)?.ok_or_else(StoreError::unavailable)?;
        if !matches!(record.kind(), QueueKind::Contact) {
            return Err(StoreError::unavailable());
        }
        let recv_addr = record.recv_addr;

        let pooled: Option<(i64, Vec<u8>)> = tx
            .query_row(
                "SELECT seq, package FROM key_package \
                 WHERE recv_addr = ?1 AND last_resort = 0 ORDER BY seq ASC LIMIT 1",
                [recv_addr.as_ref()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let claimed = match pooled {
            Some((seq, package)) => {
                // The delete and the answer are one transaction. A package
                // handed out and not durably removed is handed out twice after
                // a crash, which is the init-key reuse the pool exists to
                // avoid — so the `Committed` this returns is load-bearing.
                tx.execute(
                    "DELETE FROM key_package WHERE recv_addr = ?1 AND seq = ?2",
                    rusqlite::params![recv_addr.as_ref(), seq],
                )?;
                ClaimedKeyPackage {
                    key_package: KeyPackage::new(package)
                        .map_err(|_| StoreError::Corrupt("a stored key package is empty"))?,
                    last_resort: false,
                }
            }
            None => {
                let package: Vec<u8> = tx
                    .query_row(
                        "SELECT package FROM key_package \
                         WHERE recv_addr = ?1 AND last_resort = 1 LIMIT 1",
                        [recv_addr.as_ref()],
                        |row| row.get(0),
                    )
                    .optional()?
                    .ok_or_else(StoreError::unavailable)?;
                // Not deleted. That is the whole of §12.6's exhaustion
                // behaviour and the whole of its cost.
                ClaimedKeyPackage {
                    key_package: KeyPackage::new(package)
                        .map_err(|_| StoreError::Corrupt("a stored key package is empty"))?,
                    last_resort: true,
                }
            }
        };

        self.commit(tx, activity)?;
        Ok(Committed::seal(self.durability(), claimed))
    }

    fn delete_queue(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
    ) -> Result<Committed<Deleted>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        let activity = self.flush_activity(&tx)?;

        let record = load_by_recv(&tx, recv_addr)?.ok_or_else(StoreError::no_access)?;
        record.state.authorize_recv(signer)?;

        let (messages_deleted, bytes_freed) = range_totals(&tx, recv_addr, None)?;
        tx.execute(
            "DELETE FROM message WHERE recv_addr = ?1",
            [recv_addr.as_ref()],
        )?;
        // §7.6: no tombstone. Afterwards both addresses answer exactly as an
        // address that never existed does.
        tx.execute(
            "DELETE FROM queue WHERE recv_addr = ?1",
            [recv_addr.as_ref()],
        )?;
        self.commit(tx, activity)?;

        Ok(Committed::seal(
            self.durability(),
            Deleted {
                messages_deleted,
                bytes_freed,
            },
        ))
    }

    fn touch(&self, recv_addr: &QueueAddress, signer: &PublicKey, now_ms: u64) -> Result<()> {
        {
            let connection = self.lock_connection();
            let record = load_by_recv(&connection, recv_addr)?.ok_or_else(StoreError::no_access)?;
            record.state.authorize_recv(signer)?;
        }
        self.record_activity(recv_addr, now_ms);
        Ok(())
    }

    fn expire(&self, now_ms: u64) -> Result<Committed<ExpiryReport>> {
        let mut connection = self.lock_connection();
        let tx = connection.begin(&self.commits)?;
        // Before the sweep, so a touch that has not been written down yet still
        // saves its queue. This is what bounds `touch`'s best-effort window to
        // the sweep period.
        let activity = self.flush_activity(&tx)?;

        let mut report = ExpiryReport::default();
        let now = to_i64(now_ms)?;

        // Idle first: an idle-expired queue takes its messages with it, so
        // sweeping it now keeps them out of the message-TTL accounting below.
        let idle: Vec<QueueAddress> = {
            let mut statement =
                tx.prepare_cached("SELECT recv_addr FROM queue WHERE idle_expires_at_ms <= ?1")?;
            let rows = statement.query_map([now], |row| row.get::<_, Vec<u8>>(0))?;
            let mut found = Vec::new();
            for row in rows {
                found.push(address(&row?)?);
            }
            found
        };
        for recv_addr in idle {
            let (messages_expired, bytes_freed) = range_totals(&tx, &recv_addr, None)?;
            tx.execute(
                "DELETE FROM message WHERE recv_addr = ?1",
                [recv_addr.as_ref()],
            )?;
            tx.execute(
                "DELETE FROM queue WHERE recv_addr = ?1",
                [recv_addr.as_ref()],
            )?;
            report.queues_expired = report.queues_expired.saturating_add(1);
            report.messages_expired = report.messages_expired.saturating_add(messages_expired);
            report.bytes_freed = report.bytes_freed.saturating_add(bytes_freed);
            report.expired.push(QueueExpiry {
                recv_addr,
                reason: ExpiryReason::IdleTtl,
                messages_expired,
                bytes_freed,
            });
        }

        // Then the per-message TTL over what is left. It removes ciphertext
        // **without moving the watermark**: an expired message was never
        // acknowledged, and advancing the watermark would acknowledge it on the
        // reader's behalf.
        let stale: Vec<(QueueAddress, u64, u64)> = {
            let mut statement = tx.prepare_cached(
                "SELECT recv_addr, COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM message \
                 WHERE expires_at_ms <= ?1 GROUP BY recv_addr",
            )?;
            let rows = statement.query_map([now], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            let mut found = Vec::new();
            for row in rows {
                let (raw, count, bytes) = row?;
                found.push((address(&raw)?, from_i64(count)?, from_i64(bytes)?));
            }
            found
        };
        if !stale.is_empty() {
            tx.execute("DELETE FROM message WHERE expires_at_ms <= ?1", [now])?;
        }
        for (recv_addr, messages_expired, bytes_freed) in stale {
            tx.execute(
                "UPDATE queue SET stored_messages = MAX(0, stored_messages - ?2), \
                 stored_bytes = MAX(0, stored_bytes - ?3) WHERE recv_addr = ?1",
                rusqlite::params![
                    recv_addr.as_ref(),
                    to_i64(messages_expired)?,
                    to_i64(bytes_freed)?,
                ],
            )?;
            report.messages_expired = report.messages_expired.saturating_add(messages_expired);
            report.bytes_freed = report.bytes_freed.saturating_add(bytes_freed);
            report.expired.push(QueueExpiry {
                recv_addr,
                reason: ExpiryReason::MessageTtl,
                messages_expired,
                bytes_freed,
            });
        }

        self.commit(tx, activity)?;
        Ok(Committed::seal(self.durability(), report))
    }

    fn stats(&self) -> Result<StoreStats> {
        let connection = self.lock_connection();
        let mut stats = StoreStats::default();
        {
            let mut statement = connection.prepare_cached(
                "SELECT kind, COUNT(*), COALESCE(SUM(stored_messages), 0), \
                 COALESCE(SUM(stored_bytes), 0) FROM queue GROUP BY kind",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?;
            for row in rows {
                let (tag, count, messages, bytes) = row?;
                match kind_from_tag(tag)? {
                    QueueKind::Standard => stats.queues = from_i64(count)?,
                    QueueKind::Contact => stats.contact_queues = from_i64(count)?,
                }
                stats.messages = stats.messages.saturating_add(from_i64(messages)?);
                stats.payload_bytes = stats.payload_bytes.saturating_add(from_i64(bytes)?);
            }
        }
        let page_count: i64 = connection.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        stats.storage_bytes = from_i64(page_count)?.saturating_mul(from_i64(page_size)?);
        Ok(stats)
    }
}

/// One append inside an open transaction.
///
/// Every refusal is decided **before** the first write, which is what lets
/// [`RelayStore::append_batch`] keep the rest of a batch when one item is
/// refused.
fn append_one(tx: &Transaction<'_>, append: &Append<'_>) -> Result<Appended> {
    let Some(mut record) = load_by_send(tx, &append.send_addr)? else {
        return Err(StoreError::unavailable());
    };
    authorize_send(&record, &append.auth)?;

    let payload_bytes =
        u64::try_from(append.payload.len()).map_err(|_| StoreError::unavailable())?;
    // §13.1 layer 2, and §13.2's other half: a full queue refuses. It never
    // evicts an unacknowledged message to make room.
    record
        .quota
        .admit(record.stored_messages, record.stored_bytes, payload_bytes)?;

    let index = record.state.append()?;
    // SQLite's INTEGER is signed, so this store's index space ends at
    // `i64::MAX` rather than `u64::MAX`. Refusing as a send-side refusal keeps
    // §6.3's collapse intact; the bound is unreachable by any relay that will
    // ever exist.
    let stored_index = to_i64(index).map_err(|_| StoreError::unavailable())?;
    // The counter's *next* value has to fit too, and it has to be checked here
    // — before the insert — so that running off the domain is a clean refusal
    // rather than a half-written batch.
    let stored_next = to_i64(record.state.next_index()).map_err(|_| StoreError::unavailable())?;
    let expires_at = message_deadline(append.received_at_ms, record.message_ttl_seconds);

    tx.prepare_cached(
        "INSERT INTO message (recv_addr, idx, received_at_ms, expires_at_ms, payload) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?
    .execute(rusqlite::params![
        record.recv_addr.as_ref(),
        stored_index,
        to_i64(append.received_at_ms)?,
        to_i64(expires_at)?,
        append.payload.as_slice(),
    ])?;

    tx.prepare_cached(
        "UPDATE queue SET next_index = ?2, stored_messages = stored_messages + 1, \
         stored_bytes = stored_bytes + ?3, last_activity_ms = MAX(last_activity_ms, ?4), \
         idle_expires_at_ms = MAX(idle_expires_at_ms, ?5) WHERE recv_addr = ?1",
    )?
    .execute(rusqlite::params![
        record.recv_addr.as_ref(),
        stored_next,
        to_i64(payload_bytes)?,
        to_i64(append.received_at_ms)?,
        to_i64(idle_deadline(
            append.received_at_ms,
            record.idle_ttl_seconds
        ))?,
    ])?;

    Ok(Appended {
        recv_addr: record.recv_addr,
        index,
        received_at_ms: append.received_at_ms,
    })
}

fn read_page(
    connection: &Connection,
    record: &QueueRecord,
    window: ReadWindow,
    now_ms: u64,
) -> Result<ReadPage> {
    // §6.2: below the watermark returns from the watermark, and never errors,
    // so a client recovering from a crash can ask for everything it might have
    // missed without knowing what it already acknowledged.
    let floor = to_i64(record.state.read_from(window.from_index))?;
    // One more row than asked for, so `has_more` is observed rather than
    // guessed.
    let limit = i64::from(window.max_messages).saturating_add(1);

    let mut statement = connection.prepare_cached(
        "SELECT idx, received_at_ms, payload FROM message \
         WHERE recv_addr = ?1 AND idx >= ?2 AND expires_at_ms > ?3 ORDER BY idx LIMIT ?4",
    )?;
    let rows = statement.query_map(
        rusqlite::params![record.recv_addr.as_ref(), floor, to_i64(now_ms)?, limit],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        },
    )?;

    let mut messages = Vec::new();
    let mut fetched = 0usize;
    let mut bytes = 0u64;
    for row in rows {
        let (index, received_at_ms, payload) = row?;
        fetched = fetched.saturating_add(1);
        if messages.len() >= usize::from(window.max_messages) {
            break;
        }
        let size = u64::try_from(payload.len()).unwrap_or(u64::MAX);
        let next = bytes.saturating_add(size);
        // Always yield at least one message when one exists. A `max_bytes`
        // below the smallest padding bucket would otherwise return an empty
        // page with `has_more = 1` forever, and a reader that cannot make
        // progress cannot acknowledge, which under delete-on-ack is a queue
        // that fills and then refuses its sender.
        if next > u64::from(window.max_bytes) && !messages.is_empty() {
            break;
        }
        bytes = next;
        messages.push(StoredMessage {
            index: from_i64(index)?,
            received_at_ms: from_i64(received_at_ms)?,
            payload: Payload::new(payload).map_err(|_| {
                StoreError::Corrupt("a stored payload is longer than the wire format allows")
            })?,
        });
    }

    Ok(ReadPage {
        has_more: fetched > messages.len(),
        messages,
        next_index: record.state.next_index(),
        pending: record.state.pending(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_relay_proto::queue::AppendQuota;

    fn store() -> SqliteStore {
        SqliteStore::open_in_memory().unwrap()
    }

    /// The three settings this store's durability claim rests on are read back
    /// out of the engine, not out of the source. A pragma that silently did not
    /// take is how a relay comes to publish `fsync-per-append` while running
    /// something weaker, and the failure is invisible until the power goes out.
    #[test]
    fn the_durability_pragmas_are_what_they_claim() {
        let store = store();
        let connection = store.lock_connection();
        // `open_in_memory` cannot be WAL — a memory database has no file to
        // journal to — which is exactly why it is not the durable store. The
        // other two hold everywhere.
        expect_pragma(&connection, "synchronous", "2").unwrap();
        expect_pragma(&connection, "secure_delete", "1").unwrap();
        assert!(
            expect_pragma(&connection, "synchronous", "1").is_err(),
            "the check must be able to fail, or it is checking nothing"
        );
    }

    #[test]
    fn a_file_backed_store_is_wal_journalled() {
        let directory = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(directory.path().join("relay.sqlite3")).unwrap();
        let connection = store.lock_connection();
        expect_pragma(&connection, "journal_mode", "wal").unwrap();
        expect_pragma(&connection, "synchronous", "2").unwrap();
        expect_pragma(&connection, "secure_delete", "1").unwrap();
    }

    /// Group commit, made observable.
    ///
    /// One batch of a hundred appends is **one** fsync; a hundred separate
    /// appends are a hundred. On a disk that manages 100 fsyncs a second that
    /// is the difference between a relay that sustains its offered load and one
    /// that sustains one append per second per writer.
    #[test]
    fn a_batch_of_a_hundred_appends_costs_one_commit() {
        let store = store();
        let recv = QueueAddress::new([1u8; 32]);
        let send = QueueAddress::new([2u8; 32]);
        let recv_key = PublicKey::new([3u8; 32]);
        let send_key = PublicKey::new([4u8; 32]);
        let _ = store
            .create_queue(&QueueSpec {
                kind: QueueKind::Standard,
                recv_addr: recv,
                send_addr: send,
                recv_key,
                message_ttl_seconds: 86_400,
                idle_ttl_seconds: 86_400,
                quota: AppendQuota {
                    max_messages: 1_000,
                    max_bytes: 1 << 24,
                },
                created_at_ms: 1_000,
            })
            .unwrap();
        let _ = store.bind_send(&send, &send_key, 1_000).unwrap();

        let payload = Payload::new(vec![0u8; 64]).unwrap();
        let batch: Vec<Append<'_>> = (0..100)
            .map(|_| Append {
                send_addr: send,
                auth: SendAuth::Signed(send_key),
                payload: &payload,
                received_at_ms: 2_000,
            })
            .collect();

        let before = store.commits();
        let results = store.append_batch(&batch).unwrap().into_inner();
        assert_eq!(results.len(), 100);
        assert!(results.iter().all(Result::is_ok));
        assert_eq!(
            store.commits() - before,
            1,
            "a batch is one transaction, and therefore one fsync"
        );

        let before = store.commits();
        for _ in 0..10 {
            let _ = store
                .append(&Append {
                    send_addr: send,
                    auth: SendAuth::Signed(send_key),
                    payload: &payload,
                    received_at_ms: 3_000,
                })
                .unwrap();
        }
        assert_eq!(
            store.commits() - before,
            10,
            "and the batch of one is still one transaction each"
        );
    }

    #[test]
    fn a_committed_activity_flush_retires_the_buffer() {
        let store = store();
        let recv = QueueAddress::new([1u8; 32]);
        let send = QueueAddress::new([2u8; 32]);
        let key = PublicKey::new([3u8; 32]);
        let _ = store
            .create_queue(&QueueSpec {
                kind: QueueKind::Standard,
                recv_addr: recv,
                send_addr: send,
                recv_key: key,
                message_ttl_seconds: 86_400,
                idle_ttl_seconds: 86_400,
                quota: AppendQuota {
                    max_messages: 4,
                    max_bytes: 1 << 20,
                },
                created_at_ms: 1_000,
            })
            .unwrap();
        store.touch(&recv, &key, 2_000).unwrap();
        assert_eq!(store.lock_activity().get(&recv), Some(&2_000));

        let report = store.expire(3_000).unwrap().into_inner();
        assert!(report.is_empty());
        assert!(
            store.lock_activity().is_empty(),
            "a successful commit must not retain an already-flushed touch"
        );
    }

    #[test]
    fn a_failed_commit_preserves_staged_activity_for_the_next_transaction() {
        let store = store();
        let recv = QueueAddress::new([0x31; 32]);
        let send = QueueAddress::new([0x32; 32]);
        let key = PublicKey::new([0x33; 32]);
        let _ = store
            .create_queue(&QueueSpec {
                kind: QueueKind::Standard,
                recv_addr: recv,
                send_addr: send,
                recv_key: key,
                message_ttl_seconds: 86_400,
                idle_ttl_seconds: 60,
                quota: AppendQuota {
                    max_messages: 4,
                    max_bytes: 1 << 20,
                },
                created_at_ms: 1_000,
            })
            .unwrap();
        store.touch(&recv, &key, 50_000).unwrap();

        // A deferred foreign-key violation is accepted by the statement and
        // rejected only when SQLite executes COMMIT. That reaches the exact
        // boundary this test protects: the real touch has already been folded
        // into the transaction, but durability has not succeeded.
        {
            let connection = store.lock_connection();
            connection
                .execute_batch(
                    "PRAGMA foreign_keys = ON;
                     CREATE TABLE commit_parent (id INTEGER PRIMARY KEY);
                     CREATE TABLE commit_failure (
                         parent_id INTEGER NOT NULL,
                         FOREIGN KEY (parent_id) REFERENCES commit_parent(id)
                             DEFERRABLE INITIALLY DEFERRED
                     );",
                )
                .unwrap();
        }

        let commits_before_failure = store.commits();
        {
            let mut connection = store.lock_connection();
            let tx = connection.begin(&store.commits).unwrap();
            let activity = store.flush_activity(&tx).unwrap();
            tx.execute("INSERT INTO commit_failure (parent_id) VALUES (7)", [])
                .unwrap();
            let error = store
                .commit(tx, activity)
                .expect_err("the deferred constraint fails at COMMIT");
            assert!(matches!(error, StoreError::Backend(_)));
        }

        assert_eq!(
            store.commits(),
            commits_before_failure,
            "a failed COMMIT is not counted as durable"
        );
        assert_eq!(
            store.lock_activity().get(&recv),
            Some(&50_000),
            "the failed transaction must leave the staged touch retryable"
        );
        assert_eq!(
            store.queue_by_recv(&recv, &key).unwrap().last_activity_ms,
            1_000,
            "the failed transaction must not leak its queue update"
        );

        let report = store.expire(80_000).unwrap().into_inner();
        assert!(
            report.is_empty(),
            "the next transaction must retry the touch before sweeping"
        );
        assert!(store.lock_activity().is_empty());
        assert_eq!(
            store.queue_by_recv(&recv, &key).unwrap().last_activity_ms,
            50_000,
            "the retry must durably apply the original touch"
        );
    }

    /// A batch that fails at the transaction level writes nothing at all — the
    /// half-applied batch is the shape that would let one queue's append land
    /// while its own counter did not.
    #[test]
    fn an_index_beyond_the_signed_domain_refuses_as_a_send_side_refusal() {
        // §6.3's collapse has to survive this store's own limits: SQLite's
        // INTEGER is signed, so the index space ends at i64::MAX, and running
        // off it must look to a sender exactly like a full queue.
        let store = store();
        let recv = QueueAddress::new([1u8; 32]);
        let send = QueueAddress::new([2u8; 32]);
        let key = PublicKey::new([3u8; 32]);
        let _ = store
            .create_queue(&QueueSpec {
                kind: QueueKind::Standard,
                recv_addr: recv,
                send_addr: send,
                recv_key: key,
                message_ttl_seconds: 86_400,
                idle_ttl_seconds: 86_400,
                quota: AppendQuota {
                    max_messages: 4,
                    max_bytes: 1 << 20,
                },
                created_at_ms: 1_000,
            })
            .unwrap();
        let _ = store.bind_send(&send, &key, 1_000).unwrap();
        {
            let connection = store.lock_connection();
            connection
                .execute(
                    "UPDATE queue SET next_index = ?2 WHERE recv_addr = ?1",
                    rusqlite::params![recv.as_ref(), i64::MAX],
                )
                .unwrap();
        }
        let payload = Payload::new(vec![0u8; 8]).unwrap();
        let error = store
            .append(&Append {
                send_addr: send,
                auth: SendAuth::Signed(key),
                payload: &payload,
                received_at_ms: 2_000,
            })
            .expect_err("the index space is exhausted");
        assert_eq!(error.error_code(), f2z_codec::ErrorCode::Unavailable);
    }
}
