use crate::{Event, Payment, PaymentRecord, chain::ObservedBlock, config::Config, now};
use anyhow::{Result, ensure};
use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};

pub struct StateLock(File);
impl StateLock {
    pub fn acquire(dir: &Path) -> Result<Self> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        fs::create_dir_all(dir)?;
        let m = fs::symlink_metadata(dir)?;
        ensure!(
            m.is_dir() && !m.file_type().is_symlink() && m.uid() == unsafe { libc::geteuid() },
            "state directory must be owned by daemon user and not a symlink"
        );
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join("writer.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| anyhow::anyhow!("another writer owns this state directory"))?;
        Ok(Self(lock))
    }
}
impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

pub struct Journal {
    db: Connection,
    network: String,
    floor: u32,
    readiness_lease_seconds: i64,
}
#[derive(Clone, Debug)]
pub struct Delivery {
    pub event: Event,
    pub attempts: u32,
}
impl Journal {
    pub fn open(c: &Config, ufvk: &str) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = c.state_dir.join("journal.sqlite");
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        let db = Connection::open(path)?;
        // Preserve writer contention grace; only readonly proof connections use
        // a short busy timeout to keep their overall evidence deadline bounded.
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,hash TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,payment TEXT NOT NULL,height INTEGER NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,active INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS consumers(id TEXT PRIMARY KEY,active INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS subscriptions(consumer TEXT NOT NULL,payment_id TEXT NOT NULL,PRIMARY KEY(consumer,payment_id));
          CREATE TABLE IF NOT EXISTS deliveries(consumer TEXT NOT NULL,event_id TEXT NOT NULL,seq INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(consumer,event_id),FOREIGN KEY(event_id) REFERENCES events(id));
          CREATE INDEX IF NOT EXISTS pending_delivery ON deliveries(consumer,seq) WHERE acked=0;
          CREATE INDEX IF NOT EXISTS payment_subscribers ON subscriptions(payment_id,consumer);
          CREATE INDEX IF NOT EXISTS block_receipts ON receipts(height) WHERE active=1;")?;
        // Additive migration: all pre-observation receipts were confirmed.
        for (table, column, ddl) in [
            (
                "receipts",
                "confirmed",
                "ALTER TABLE receipts ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 1",
            ),
            (
                "consumers",
                "observe_unconfirmed",
                "ALTER TABLE consumers ADD COLUMN observe_unconfirmed INTEGER NOT NULL DEFAULT 0",
            ),
        ] {
            let present: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                params![table, column],
                |r| r.get(0),
            )?;
            if !present {
                db.execute_batch(ddl)?;
            }
        }
        let identity = json!({"network":c.network,"ufvk_sha256":hex::encode(Sha256::digest(ufvk)),"birthday":c.birthday_height,"floor":c.automation_start_height,"confirmations":c.confirmations}).to_string();
        let existing: Option<String> = db
            .query_row("SELECT value FROM meta WHERE key='identity'", [], |r| {
                r.get(0)
            })
            .optional()?;
        ensure!(
            existing.as_ref().is_none_or(|v| v == &identity),
            "state configuration or viewing key changed; use a new state directory"
        );
        db.execute(
            "INSERT OR IGNORE INTO meta VALUES('identity',?1)",
            [&identity],
        )?;
        if c.consumers.iter().any(|c| c.observe_unconfirmed) {
            // Once a canonical tail is tracked, removing a consumer must not
            // manufacture chain revocations by discarding that tail.
            db.execute(
                "INSERT OR IGNORE INTO meta VALUES('scan_unconfirmed','true')",
                [],
            )?;
        }
        db.execute("UPDATE consumers SET active=0", [])?;
        for consumer in &c.consumers {
            let old: Option<bool> = db
                .query_row(
                    "SELECT observe_unconfirmed FROM consumers WHERE id=?1",
                    [&consumer.id],
                    |r| r.get(0),
                )
                .optional()?;
            ensure!(
                old.is_none_or(|v| v == consumer.observe_unconfirmed),
                "observation policy changed for existing consumer; choose a new consumer ID"
            );
            db.execute(
                "INSERT INTO consumers(id,active,observe_unconfirmed) VALUES(?1,1,?2) ON CONFLICT(id) DO UPDATE SET active=1",
                params![consumer.id, consumer.observe_unconfirmed],
            )?;
        }
        Ok(Self {
            db,
            network: c.network.clone(),
            floor: c.automation_start_height,
            readiness_lease_seconds: (c.poll_seconds + 30) as i64,
        })
    }
    pub fn inspect(c: &Config) -> Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::geteuid() };
        let dir = fs::symlink_metadata(&c.state_dir)?;
        ensure!(
            dir.is_dir()
                && !dir.file_type().is_symlink()
                && dir.uid() == uid
                && dir.mode() & 0o777 == 0o700,
            "journal directory must be private and owned by observer user"
        );
        let path = c.state_dir.join("journal.sqlite");
        let file = fs::symlink_metadata(&path)?;
        ensure!(
            file.is_file()
                && !file.file_type().is_symlink()
                && file.uid() == uid
                && file.mode() & 0o777 == 0o600,
            "journal must be private and owned by observer user"
        );
        // SQLite uses path-based WAL discovery. Trusted private directories
        // prevent another user swapping that path between inspection and open.
        // Root-owned sticky /tmp is acceptable for tests/private scratch state.
        let canonical_dir = fs::canonicalize(&c.state_dir)?;
        let pinned_dir = fs::symlink_metadata(&canonical_dir)?;
        ensure!(
            pinned_dir.is_dir()
                && pinned_dir.uid() == uid
                && pinned_dir.mode() & 0o777 == 0o700
                && pinned_dir.dev() == dir.dev()
                && pinned_dir.ino() == dir.ino(),
            "journal directory changed during inspection"
        );
        for ancestor in canonical_dir.ancestors().skip(1) {
            let m = fs::metadata(ancestor)?;
            ensure!(
                (m.uid() == uid || m.uid() == 0)
                    && (m.mode() & 0o022 == 0 || (m.uid() == 0 && m.mode() & 0o1000 != 0)),
                "journal parent directory is writable by another user"
            );
        }
        let pinned_path = canonical_dir.join("journal.sqlite");
        let pinned_file = fs::symlink_metadata(&pinned_path)?;
        ensure!(
            pinned_file.is_file()
                && pinned_file.uid() == uid
                && pinned_file.mode() & 0o777 == 0o600
                && pinned_file.dev() == file.dev()
                && pinned_file.ino() == file.ino(),
            "journal file changed during inspection"
        );
        let db =
            Connection::open_with_flags(pinned_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.busy_timeout(std::time::Duration::from_secs(1))?;
        Ok(Self {
            db,
            network: c.network.clone(),
            floor: c.automation_start_height,
            readiness_lease_seconds: (c.poll_seconds + 30) as i64,
        })
    }
    pub fn ready(&self, _c: &Config) -> Result<bool> {
        self.ready_internal()
    }
    pub fn scans_unconfirmed(&self) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT value='true' FROM meta WHERE key='scan_unconfirmed'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    /// Read-only provenance binding, including historical revocation lineage.
    pub fn proof_event(&self, c: &Config, ufvk: &str, event_id: &str) -> Result<Event> {
        let tx = self.db.unchecked_transaction()?;
        let identity: String =
            tx.query_row("SELECT value FROM meta WHERE key='identity'", [], |r| {
                r.get(0)
            })?;
        let expected = json!({"network":c.network,"ufvk_sha256":hex::encode(Sha256::digest(ufvk)),"birthday":c.birthday_height,"floor":c.automation_start_height,"confirmations":c.confirmations});
        ensure!(
            serde_json::from_str::<Value>(&identity)? == expected,
            "journal identity differs from observer configuration"
        );
        let body: String =
            tx.query_row("SELECT body FROM events WHERE id=?1", [event_id], |r| {
                r.get(0)
            })?;
        let event: Event = serde_json::from_str(&body)?;
        ensure!(
            event.schema_version == 1 && event.network == c.network && event.event_id == event_id,
            "unsupported journal event identity"
        );
        let (payment, height, hash, revision, active, confirmed): (
            String,
            u32,
            String,
            u32,
            bool,
            bool,
        ) = tx.query_row(
            "SELECT payment,height,hash,revision,active,confirmed FROM receipts WHERE id=?1",
            [&event.payment.id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )?;
        ensure!(
            serde_json::from_str::<Payment>(&payment)? == event.payment,
            "journal payment changed"
        );
        match event.kind.as_str() {
            "payment.confirmed" | "payment.observed" => {
                ensure!(
                    active
                        && revision == event.revision
                        && height == event.block_height
                        && hash == event.block_hash,
                    "payment observation is superseded or revoked"
                );
                ensure!(
                    event.kind != "payment.confirmed" || confirmed,
                    "payment lost confirmation depth"
                );
                let block_hash: String =
                    tx.query_row("SELECT hash FROM blocks WHERE height=?1", [height], |r| {
                        r.get(0)
                    })?;
                ensure!(block_hash == hash, "payment is outside journal chain");
                ensure!(
                    self.ready_internal()?,
                    "scanner evidence is unavailable or expired"
                );
            }
            "payment.revoked" => {
                // A later re-mining (even returning to the same hash) cannot
                // erase this immutable record of intervening confirmation loss.
                ensure!(
                    (revision == event.revision && !active) || revision > event.revision,
                    "revocation lineage is inconsistent"
                );
            }
            _ => anyhow::bail!("unsupported lifecycle event"),
        }
        Ok(event)
    }

    /// Read a current receipt without creating events below the automation floor.
    pub fn proof_payment(&self, c: &Config, ufvk: &str, payment_id: &str) -> Result<PaymentRecord> {
        let tx = self.db.unchecked_transaction()?;
        let identity: String =
            tx.query_row("SELECT value FROM meta WHERE key='identity'", [], |r| {
                r.get(0)
            })?;
        let expected = json!({"network":c.network,"ufvk_sha256":hex::encode(Sha256::digest(ufvk)),"birthday":c.birthday_height,"floor":c.automation_start_height,"confirmations":c.confirmations});
        ensure!(
            serde_json::from_str::<Value>(&identity)? == expected,
            "journal identity differs from observer configuration"
        );
        let (body, height, hash, revision, active, confirmed): (
            String,
            u32,
            String,
            u32,
            bool,
            bool,
        ) = tx.query_row(
            "SELECT payment,height,hash,revision,active,confirmed FROM receipts WHERE id=?1",
            [payment_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )?;
        let payment: Payment = serde_json::from_str(&body)?;
        ensure!(
            active && payment.id == payment_id && self.ready_internal()?,
            "receipt is inactive or scanner evidence expired"
        );
        let canonical: String =
            tx.query_row("SELECT hash FROM blocks WHERE height=?1", [height], |r| {
                r.get(0)
            })?;
        ensure!(canonical == hash, "receipt is outside journal chain");
        Ok(PaymentRecord {
            network: c.network.clone(),
            payment,
            block_height: height,
            block_hash: hash,
            revision,
            confirmed,
        })
    }
    /// Bounded private inventory; cursor is the stable payment identity.
    pub fn payments(&self, after: &str, limit: u32) -> Result<Vec<String>> {
        ensure!(
            (1..=1000).contains(&limit),
            "payment inventory limit must be 1..1000"
        );
        let mut s = self
            .db
            .prepare("SELECT id FROM receipts WHERE active=1 AND id>?1 ORDER BY id LIMIT ?2")?;
        Ok(s.query_map(params![after, limit], |r| r.get(0))?
            .collect::<Result<_, _>>()?)
    }
    fn ready_internal(&self) -> Result<bool> {
        let health: Option<String> = self
            .db
            .query_row("SELECT value FROM meta WHERE key='scanner'", [], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(health) = health else {
            return Ok(false);
        };
        let h: Value = serde_json::from_str(&health)?;
        Ok(h["ok"] == true
            && h["ready"] == true
            && h["fresh_until"].as_i64().is_some_and(|t| now() <= t)
            && h["checked_at"]
                .as_i64()
                .is_some_and(|t| t <= now() && now() - t <= self.readiness_lease_seconds))
    }
    pub fn cursor(&self) -> Result<Option<(u32, String)>> {
        Ok(self
            .db
            .query_row(
                "SELECT height,hash FROM blocks ORDER BY height DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    pub fn append(&mut self, block: &ObservedBlock) -> Result<usize> {
        self.append_state(block, true)
    }
    pub fn observe(&mut self, block: &ObservedBlock) -> Result<usize> {
        self.append_state(block, false)
    }
    fn append_state(&mut self, block: &ObservedBlock, confirmed: bool) -> Result<usize> {
        if let Some((height, hash)) = self.cursor()? {
            ensure!(
                block.height == height + 1 && block.previous_hash == hash,
                "block does not extend journal chain"
            );
        }
        let tx = self.db.transaction()?;
        let mut count = 0;
        for p in &block.payments {
            ensure!(
                p.memo_hex.len() == 1024 && hex::decode(&p.memo_hex).is_ok(),
                "receipt requires a complete hydrated 512-byte memo"
            );
            let old: Option<(u32, bool)> = tx
                .query_row(
                    "SELECT revision,active FROM receipts WHERE id=?1",
                    [&p.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            ensure!(
                old.is_none_or(|(_, active)| !active),
                "payment already active in canonical chain"
            );
            let revision = old.map_or(1, |(r, _)| r + 1);
            tx.execute("INSERT INTO receipts(id,payment,height,hash,revision,active,confirmed) VALUES(?1,?2,?3,?4,?5,1,?6) ON CONFLICT(id) DO UPDATE SET payment=excluded.payment,height=excluded.height,hash=excluded.hash,revision=excluded.revision,active=1,confirmed=excluded.confirmed",params![p.id,serde_json::to_string(p)?,block.height,block.hash,revision,confirmed])?;
            if block.height >= self.floor {
                let event = Event {
                    schema_version: 1,
                    journal_sequence: 0,
                    event_id: format!(
                        "{}:{revision}:{}",
                        p.id,
                        if confirmed { "confirmed" } else { "observed" }
                    ),
                    kind: if confirmed {
                        "payment.confirmed"
                    } else {
                        "payment.observed"
                    }
                    .into(),
                    network: self.network.clone(),
                    payment: p.clone(),
                    block_height: block.height,
                    block_hash: block.hash.clone(),
                    revision,
                };
                publish(&tx, &event)?;
                count += 1;
            }
        }
        tx.execute(
            "INSERT INTO blocks VALUES(?1,?2)",
            params![block.height, block.hash],
        )?;
        tx.commit()?;
        Ok(count)
    }
    pub fn rollback_one(&mut self) -> Result<()> {
        let Some((height, _)) = self.cursor()? else {
            return Ok(());
        };
        let tx = self.db.transaction()?;
        let entries: Vec<(String, String, u32)> = {
            let mut s = tx.prepare(
                "SELECT payment,hash,revision FROM receipts WHERE height=?1 AND active=1",
            )?;
            s.query_map([height], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?
        };
        for (body, hash, revision) in entries {
            let payment: Payment = serde_json::from_str(&body)?;
            tx.execute("UPDATE receipts SET active=0 WHERE id=?1", [&payment.id])?;
            if height >= self.floor {
                // Do not perform a stale confirmation that has not been delivered yet.
                for phase in ["confirmed", "observed"] {
                    tx.execute("UPDATE deliveries SET acked=1,last_error='superseded by reorg' WHERE event_id=?1 AND acked=0",[format!("{}:{revision}:{phase}",payment.id)])?;
                }
                let event = Event {
                    schema_version: 1,
                    journal_sequence: 0,
                    event_id: format!("{}:{revision}:revoked", payment.id),
                    kind: "payment.revoked".into(),
                    network: self.network.clone(),
                    payment,
                    block_height: height,
                    block_hash: hash,
                    revision,
                };
                publish(&tx, &event)?;
            }
        }
        tx.execute("DELETE FROM blocks WHERE height=?1", [height])?;
        tx.commit()?;
        Ok(())
    }
    /// Advance or revoke confirmation depth without discarding canonical blocks.
    pub fn reconcile_confirmations(&mut self, safe: u32) -> Result<usize> {
        let tx = self.db.transaction()?;
        let entries: Vec<(String, u32, String, u32, bool)> = {
            let mut s = tx.prepare("SELECT payment,height,hash,revision,confirmed FROM receipts WHERE active=1 AND confirmed!=(height<=?1)")?;
            s.query_map([safe], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<_, _>>()?
        };
        let mut count = 0;
        for (body, height, hash, revision, was_confirmed) in entries {
            let payment: Payment = serde_json::from_str(&body)?;
            if was_confirmed {
                for phase in ["confirmed", "observed"] {
                    tx.execute("UPDATE deliveries SET acked=1,last_error='superseded by depth loss' WHERE event_id=?1 AND acked=0",[format!("{}:{revision}:{phase}",payment.id)])?;
                }
                if height >= self.floor {
                    publish(
                        &tx,
                        &Event {
                            schema_version: 1,
                            journal_sequence: 0,
                            event_id: format!("{}:{revision}:revoked", payment.id),
                            kind: "payment.revoked".into(),
                            network: self.network.clone(),
                            payment: payment.clone(),
                            block_height: height,
                            block_hash: hash.clone(),
                            revision,
                        },
                    )?;
                }
            }
            let revision = if was_confirmed {
                revision + 1
            } else {
                revision
            };
            tx.execute(
                "UPDATE receipts SET confirmed=?2,revision=?3 WHERE id=?1",
                params![payment.id, !was_confirmed, revision],
            )?;
            if height >= self.floor {
                let phase = if was_confirmed {
                    "observed"
                } else {
                    "confirmed"
                };
                publish(
                    &tx,
                    &Event {
                        schema_version: 1,
                        journal_sequence: 0,
                        event_id: format!("{}:{revision}:{phase}", payment.id),
                        kind: format!("payment.{phase}"),
                        network: self.network.clone(),
                        payment,
                        block_height: height,
                        block_hash: hash,
                        revision,
                    },
                )?;
                count += 1;
            }
        }
        tx.commit()?;
        Ok(count)
    }
    pub fn next(&self, consumer: &str, time: i64) -> Result<Option<Delivery>> {
        // Preserve lifecycle order per consumer: poison work stalls this consumer only.
        let row: Option<(String,u32,i64)> = self.db.query_row("SELECT e.body,d.attempts,d.next_attempt FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.consumer=?1 AND d.acked=0 ORDER BY d.seq LIMIT 1",[consumer],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        match row {
            Some((body, attempts, due)) if due <= time => Ok(Some(Delivery {
                event: serde_json::from_str(&body)?,
                attempts,
            })),
            _ => Ok(None),
        }
    }
    /// Positive work pauses when scanner evidence is unavailable. Corrections
    /// already recorded in this journal must still reach consumers: an unrelated
    /// positive head cannot hide them. Preserve sequence/backoff among revocations
    /// and leave paused positive deliveries and their retry/ACK state untouched.
    pub fn next_for_automation(&self, consumer: &str, time: i64) -> Result<Option<Delivery>> {
        if self.ready_internal()? {
            return self.next(consumer, time);
        }
        let row: Option<(String, u32, i64)> = self.db.query_row(
            "SELECT e.body,d.attempts,d.next_attempt FROM deliveries d JOIN events e ON e.id=d.event_id WHERE d.consumer=?1 AND d.acked=0 AND json_extract(e.body,'$.kind')='payment.revoked' ORDER BY d.seq LIMIT 1",
            [consumer], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).optional()?;
        match row {
            Some((body, attempts, due)) if due <= time => Ok(Some(Delivery {
                event: serde_json::from_str(&body)?,
                attempts,
            })),
            _ => Ok(None),
        }
    }
    pub fn acknowledge(&self, consumer: &str, event: &str) -> Result<()> {
        self.db.execute(
            "UPDATE deliveries SET acked=1,last_error=NULL WHERE consumer=?1 AND event_id=?2",
            params![consumer, event],
        )?;
        Ok(())
    }
    pub fn failed(&self, consumer: &str, d: &Delivery, reason: &str) -> Result<()> {
        let delay = 2_i64.pow((d.attempts + 1).min(10)).min(3600);
        self.db.execute("UPDATE deliveries SET attempts=attempts+1,next_attempt=?3,last_error=?4 WHERE consumer=?1 AND event_id=?2 AND acked=0",params![consumer,d.event.event_id,now()+delay,reason])?;
        Ok(())
    }
    /// Explicit stopped-writer handoff. Inserts missing queue work only; unlike
    /// replay, it never resets ACKs or retry metadata. Requires an existing,
    /// migrated journal and the caller's exclusive StateLock.
    pub fn enqueue_missing(
        lock: &StateLock,
        c: &Config,
        ufvk: &str,
        max_receipts: u32,
        max_events: u32,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        Self::handoff(lock, c, ufvk, max_receipts, max_events, timeout, true)
    }
    /// Private read-only inventory of eligible unacknowledged revocations.
    /// Includes already queued work so a retry cannot bypass reconciliation.
    pub fn handoff_revocations(
        lock: &StateLock,
        c: &Config,
        ufvk: &str,
        max_receipts: u32,
        max_events: u32,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        Self::handoff(lock, c, ufvk, max_receipts, max_events, timeout, false)
    }
    #[allow(clippy::too_many_arguments)]
    fn handoff(
        lock: &StateLock,
        c: &Config,
        ufvk: &str,
        max_receipts: u32,
        max_events: u32,
        timeout: std::time::Duration,
        apply: bool,
    ) -> Result<Value> {
        ensure!(
            (1..=10_000).contains(&max_receipts),
            "receipt cap must be 1..10000"
        );
        ensure!(
            (1..=50_000).contains(&max_events),
            "event cap must be 1..50000"
        );
        ensure!(
            !timeout.is_zero() && timeout <= std::time::Duration::from_secs(120),
            "handoff deadline must be positive and at most 120 seconds"
        );
        ensure!(
            !c.consumers.is_empty() && c.consumers.len() <= 16,
            "handoff requires 1..16 consumers"
        );
        c.validate()?;
        use std::os::unix::fs::MetadataExt;
        let started = std::time::Instant::now();
        let held = lock.0.metadata()?;
        let expected_lock = fs::symlink_metadata(c.state_dir.join("writer.lock"))?;
        ensure!(
            expected_lock.is_file()
                && !expected_lock.file_type().is_symlink()
                && held.dev() == expected_lock.dev()
                && held.ino() == expected_lock.ino(),
            "handoff lock does not own this journal"
        );
        // inspect pins the private canonical namespace and refuses missing state.
        let mut journal = Self::inspect(c)?;
        journal.db = Connection::open_with_flags(
            fs::canonicalize(&c.state_dir)?.join("journal.sqlite"),
            if apply {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            } else {
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            },
        )?;
        let remaining = timeout
            .checked_sub(started.elapsed())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| anyhow::anyhow!("handoff deadline exceeded"))?;
        journal.db.busy_timeout(remaining)?;
        let watchdog = InterruptDeadline::new(journal.db.get_interrupt_handle(), remaining);
        if apply {
            journal
                .db
                .execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        }
        let check = || -> Result<()> {
            ensure!(started.elapsed() < timeout, "handoff deadline exceeded");
            Ok(())
        };
        let tx = journal.db.transaction_with_behavior(if apply {
            rusqlite::TransactionBehavior::Immediate
        } else {
            rusqlite::TransactionBehavior::Deferred
        })?;
        let identity: String =
            tx.query_row("SELECT value FROM meta WHERE key='identity'", [], |r| {
                r.get(0)
            })?;
        let expected = json!({"network":c.network,"ufvk_sha256":hex::encode(Sha256::digest(ufvk)),"birthday":c.birthday_height,"floor":c.automation_start_height,"confirmations":c.confirmations});
        ensure!(
            serde_json::from_str::<Value>(&identity)? == expected,
            "handoff journal identity mismatch"
        );
        let consumers: Vec<_> = c
            .consumers
            .iter()
            .map(|v| (v.id.clone(), v.observe_unconfirmed))
            .collect();
        let plan = handoff_plan(
            &tx,
            &c.network,
            c.automation_start_height,
            &consumers,
            &expected,
            (max_receipts, max_events),
            &check,
        )?;
        if !apply {
            ensure!(
                plan.revocations.len() <= 1000,
                "private revocation cap exceeded"
            );
            let refs: Vec<_> = plan
                .revocations
                .values()
                .map(|e| {
                    json!({
                        "network":e.network,"txid":e.payment.txid,"pool":e.payment.pool,
                        "output_index":e.payment.output_index,"event_id":e.event_id,
                        "revision":e.revision,"journal_sequence":e.journal_sequence
                    })
                })
                .collect();
            let mut proof = plan.proof;
            proof["eligible_unacked_revocations"] = json!(refs.len());
            proof["revocations"] = json!(refs);
            ensure!(
                serde_json::to_vec(&proof)?.len() <= 512 * 1024,
                "private revocation byte cap exceeded"
            );
            check()?;
            return Ok(proof);
        }
        // Nothing above changes any row. The complete, bounded inventory has
        // been validated before registration or insertion starts.
        tx.execute("UPDATE consumers SET active=0", [])?;
        for consumer in &c.consumers {
            check()?;
            tx.execute("INSERT INTO consumers(id,active,observe_unconfirmed) VALUES(?1,1,?2) ON CONFLICT(id) DO UPDATE SET active=1", params![consumer.id,consumer.observe_unconfirmed])?;
        }
        if c.consumers.iter().any(|v| v.observe_unconfirmed) {
            tx.execute(
                "INSERT OR IGNORE INTO meta VALUES('scan_unconfirmed','true')",
                [],
            )?;
        }
        let mut inserted_subscriptions = 0_u64;
        for (consumer, payment) in &plan.subscriptions {
            check()?;
            inserted_subscriptions += tx.execute(
                "INSERT OR IGNORE INTO subscriptions(consumer,payment_id) VALUES(?1,?2)",
                params![consumer, payment],
            )? as u64;
        }
        for (consumer, _, event, seq) in &plan.missing {
            check()?;
            tx.execute(
                "INSERT INTO deliveries(consumer,event_id,seq) VALUES(?1,?2,?3)",
                params![consumer, event, seq],
            )?;
        }
        check()?;
        tx.commit()?;
        drop(watchdog);
        let mut proof = plan.proof;
        proof["inserted_deliveries"] = json!(plan.missing.len());
        proof["inserted_subscriptions"] = json!(inserted_subscriptions);
        proof["missing_deliveries_after"] = json!(0);
        Ok(proof)
    }
    pub fn replay(&mut self, consumer: &str, event: &str) -> Result<()> {
        let registered: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM consumers WHERE id=?1 AND active=1)",
            [consumer],
            |r| r.get(0),
        )?;
        ensure!(registered, "replay consumer is not active/configured");
        let body: String =
            self.db
                .query_row("SELECT body FROM events WHERE id=?1", [event], |r| r.get(0))?;
        let e: Event = serde_json::from_str(&body)?;
        if e.kind == "payment.observed" {
            let opted_in: bool = self.db.query_row(
                "SELECT observe_unconfirmed FROM consumers WHERE id=?1",
                [consumer],
                |r| r.get(0),
            )?;
            ensure!(opted_in, "consumer did not opt into observations");
        }
        let expected_active = i64::from(e.kind != "payment.revoked");
        let valid: bool = self.db.query_row(
            "SELECT active=?3 AND revision=?2 AND (?4!='payment.confirmed' OR confirmed=1) FROM receipts WHERE id=?1",
            params![e.payment.id, e.revision, expected_active, e.kind],
            |r| r.get(0),
        )?;
        ensure!(valid, "cannot replay superseded payment lifecycle event");
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO subscriptions VALUES(?1,?2)",
            params![consumer, e.payment.id],
        )?;
        tx.execute("INSERT INTO deliveries(consumer,event_id,seq) SELECT ?1,id,seq FROM events WHERE id=?2 ON CONFLICT(consumer,event_id) DO UPDATE SET acked=0,next_attempt=0,last_error='operator replay'",params![consumer,event])?;
        tx.commit()?;
        Ok(())
    }
    pub fn status(&self, c: &Config) -> Result<Value> {
        let timeout = std::time::Duration::from_secs(2);
        let started = std::time::Instant::now();
        let _watchdog = InterruptDeadline::new(self.db.get_interrupt_handle(), timeout);
        let tx = self.db.unchecked_transaction()?;
        let policies: Vec<_> = c
            .consumers
            .iter()
            .map(|v| (v.id.clone(), v.observe_unconfirmed))
            .collect();
        let expected: Value = serde_json::from_str(&tx.query_row::<String, _, _>(
            "SELECT value FROM meta WHERE key='identity'",
            [],
            |r| r.get(0),
        )?)?;
        ensure!(
            expected["network"] == self.network && expected["floor"] == self.floor,
            "status journal identity mismatch"
        );
        let plan = handoff_plan(
            &tx,
            &self.network,
            self.floor,
            &policies,
            &expected,
            (10_000, 50_000),
            &|| {
                ensure!(
                    started.elapsed() < timeout,
                    "status inventory deadline exceeded"
                );
                Ok(())
            },
        );
        let missing = plan.as_ref().ok().map(|p| p.missing.len());
        let inventory_verified = plan.is_ok();
        let inventory_error = if inventory_verified {
            None
        } else {
            Some(
                "delivery inventory unavailable; inspect lifecycle, configured consumers, caps and deadline",
            )
        };
        // Preserve ordinary health diagnostics even when lifetime inventory has
        // outgrown the finite handoff cap. Never call an unknown count zero.
        drop(tx);
        drop(_watchdog);
        let _diagnostic_deadline = InterruptDeadline::new(
            self.db.get_interrupt_handle(),
            std::time::Duration::from_secs(2),
        );
        let pending: i64 = self.db.query_row("SELECT count(*) FROM deliveries d JOIN consumers c ON c.id=d.consumer WHERE d.acked=0 AND c.active=1",[],|r|r.get(0))?;
        let failed: i64 = self.db.query_row("SELECT count(*) FROM deliveries d JOIN consumers c ON c.id=d.consumer WHERE d.acked=0 AND c.active=1 AND d.attempts>0",[],|r|r.get(0))?;
        let receipts: i64 =
            self.db
                .query_row("SELECT count(*) FROM receipts WHERE active=1", [], |r| {
                    r.get(0)
                })?;
        let valid_inventory_json: bool = self.db.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM events WHERE NOT json_valid(body))",
            [],
            |r| r.get(0),
        )?;
        let inventory_event_count: i64 =
            self.db
                .query_row("SELECT count(*) FROM events", [], |r| r.get(0))?;
        // Relevant receipt and byte totals cannot be established from malformed
        // event JSON. Preserve scanner/queue diagnostics and expose unknown.
        let (inventory_receipt_count, inventory_bytes) = if valid_inventory_json {
            let receipts: i64 = self.db.query_row("SELECT count(*) FROM receipts WHERE height>=?1 OR id IN (SELECT json_extract(body,'$.payment.id') FROM events WHERE json_extract(body,'$.block_height')>=?1)", [self.floor], |r| r.get(0))?;
            let bytes: i64 = self.db.query_row("SELECT (SELECT coalesce(sum(length(CAST(id AS BLOB))+length(CAST(body AS BLOB))),0) FROM events)+(SELECT coalesce(sum(length(CAST(id AS BLOB))+length(CAST(payment AS BLOB))),0) FROM receipts WHERE height>=?1 OR id IN (SELECT json_extract(body,'$.payment.id') FROM events WHERE json_extract(body,'$.block_height')>=?1))", [self.floor], |r| r.get(0))?;
            (Some(receipts), Some(bytes))
        } else {
            (None, None)
        };
        let health: Option<String> = self
            .db
            .query_row("SELECT value FROM meta WHERE key='scanner'", [], |r| {
                r.get(0)
            })
            .optional()?;
        let consumers: Vec<Value> = {
            let mut q = self.db.prepare("SELECT c.id,(SELECT count(*) FROM deliveries d WHERE d.consumer=c.id AND d.acked=0),(SELECT count(*) FROM deliveries d WHERE d.consumer=c.id AND d.acked=0 AND d.attempts>0) FROM consumers c WHERE c.active=1 ORDER BY c.id")?;
            let rows: Vec<(String, i64, i64)> = q
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            rows.into_iter().map(|(id,pending,failed)| {
                let head: Option<(String,u32,i64,Option<String>)> = self.db.query_row("SELECT event_id,attempts,next_attempt,last_error FROM deliveries WHERE consumer=?1 AND acked=0 ORDER BY seq LIMIT 1",[&id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
                Ok(json!({"id":id,"pending":pending,"failed":failed,"head":head.map(|(event_id,attempts,next_attempt,last_error)|json!({"event_id":event_id,"attempts":attempts,"next_attempt":next_attempt,"last_error":last_error}))}))
            }).collect::<Result<_>>()?
        };
        Ok(
            json!({"cursor":self.cursor()?,"active_receipts":receipts,"pending_deliveries":pending,"failed_deliveries":failed,"missing_deliveries":missing,"inventory_receipt_count":inventory_receipt_count,"inventory_event_count":inventory_event_count,"inventory_bytes":inventory_bytes,"inventory_byte_limit":67108864,"inventory_receipt_limit":10000,"inventory_event_limit":50000,"delivery_inventory_verified":inventory_verified,"delivery_inventory_error":inventory_error,"consumers":consumers,"effective_ready":self.ready_internal()?,"scanner":health.map(|h|serde_json::from_str::<Value>(&h)).transpose()?}),
        )
    }
    pub fn scanner_health(
        &self,
        tip: Option<u32>,
        success: bool,
        ready: bool,
        fresh_until: Option<i64>,
    ) -> Result<()> {
        let v = json!({"checked_at":now(),"tip":tip,"ok":success,"ready":ready,"fresh_until":fresh_until,"scan_height":self.cursor()?.map(|c|c.0)}).to_string();
        self.db.execute("INSERT INTO meta VALUES('scanner',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[v])?;
        Ok(())
    }
    pub fn events(&self, after: u64, limit: u32) -> Result<Vec<Event>> {
        let mut s = self
            .db
            .prepare("SELECT body FROM events WHERE seq>?1 ORDER BY seq LIMIT ?2")?;
        let bodies: Vec<String> = s
            .query_map(params![after, limit.min(1000)], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        bodies
            .into_iter()
            .map(|b| Ok(serde_json::from_str(&b)?))
            .collect()
    }
}
fn publish(tx: &rusqlite::Transaction<'_>, event: &Event) -> Result<()> {
    tx.execute(
        "INSERT INTO events(id,body) VALUES(?1,'')",
        [&event.event_id],
    )?;
    let mut event = event.clone();
    event.journal_sequence = tx.last_insert_rowid() as u64;
    tx.execute(
        "UPDATE events SET body=?2 WHERE id=?1",
        params![event.event_id, serde_json::to_string(&event)?],
    )?;
    if event.kind == "payment.confirmed" || event.kind == "payment.observed" {
        tx.execute("INSERT OR IGNORE INTO subscriptions(consumer,payment_id) SELECT id,?1 FROM consumers WHERE active=1 AND (?2!='payment.observed' OR observe_unconfirmed=1)",params![event.payment.id,event.kind])?;
    }
    tx.execute("INSERT INTO deliveries(consumer,event_id,seq) SELECT s.consumer,e.id,e.seq FROM subscriptions s JOIN consumers c ON c.id=s.consumer,events e WHERE e.id=?1 AND s.payment_id=?2 AND (?3!='payment.observed' OR c.observe_unconfirmed=1)",params![event.event_id,event.payment.id,event.kind])?;
    Ok(())
}

// Interrupt long SQLite VM work as well as checking the finite Rust loops.
// Drop cancels and joins the watchdog before the connection can be reused.
struct InterruptDeadline {
    signal: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl InterruptDeadline {
    fn new(interrupt: rusqlite::InterruptHandle, timeout: std::time::Duration) -> Self {
        let signal = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let waiting = signal.clone();
        let thread = std::thread::spawn(move || {
            let (mutex, changed) = &*waiting;
            let (cancelled, result) = changed
                .wait_timeout_while(mutex.lock().unwrap(), timeout, |done| !*done)
                .unwrap();
            if result.timed_out() && !*cancelled {
                interrupt.interrupt();
            }
        });
        Self {
            signal,
            thread: Some(thread),
        }
    }
}
impl Drop for InterruptDeadline {
    fn drop(&mut self) {
        let (mutex, changed) = &*self.signal;
        *mutex.lock().unwrap() = true;
        changed.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct HandoffPlan {
    missing: Vec<(String, String, String, u64)>,
    subscriptions: std::collections::BTreeSet<(String, String)>,
    proof: Value,
    revocations: std::collections::BTreeMap<String, Event>,
}
// One bounded lifecycle eligibility implementation serves both the stopped
// handoff and read-only health. Caller holds a coherent SQLite transaction.
fn handoff_plan(
    tx: &rusqlite::Transaction<'_>,
    network: &str,
    floor: u32,
    consumers: &[(String, bool)],
    expected: &Value,
    caps: (u32, u32),
    check: &impl Fn() -> Result<()>,
) -> Result<HandoffPlan> {
    use std::collections::HashMap;
    let (max_receipts, max_events) = caps;
    ensure!(consumers.len() <= 16, "handoff consumer cap exceeded");
    for (consumer_id, observe_unconfirmed) in consumers {
        check()?;
        let old_policy: Option<bool> = tx
            .query_row(
                "SELECT observe_unconfirmed FROM consumers WHERE id=?1",
                [consumer_id],
                |r| r.get(0),
            )
            .optional()?;
        ensure!(
            old_policy.is_none_or(|v| v == *observe_unconfirmed),
            "handoff consumer policy changed"
        );
    }
    let mut inventory_bytes = 0_usize;
    let mut digest = Sha256::new();
    digest.update(serde_json::to_vec(expected)?);
    digest.update(serde_json::to_vec(&consumers)?);
    let mut events = HashMap::new();
    let mut boundary = 0_u64;
    {
        let mut q = tx.prepare("SELECT seq,CASE WHEN length(id)<=2048 THEN id END,CASE WHEN length(body)<=16384 THEN body END FROM events ORDER BY seq LIMIT ?1")?;
        let mut rows = q.query([max_events + 1])?;
        while let Some(row) = rows.next()? {
            check()?;
            ensure!(
                events.len() < max_events as usize,
                "handoff event cap exceeded"
            );
            let seq: u64 = row.get(0)?;
            let id: String = row.get(1)?;
            let body: String = row.get(2)?;
            ensure!(body.len() <= 16_384, "oversized handoff event");
            inventory_bytes += id.len() + body.len();
            ensure!(
                inventory_bytes <= 64 * 1024 * 1024,
                "handoff inventory byte cap exceeded"
            );
            let event: Event = serde_json::from_str(&body)?;
            ensure!(
                event.schema_version == 1
                    && event.journal_sequence == seq
                    && event.event_id == id
                    && event.network == network,
                "invalid handoff event identity"
            );
            ensure!(
                matches!(
                    event.kind.as_str(),
                    "payment.observed" | "payment.confirmed" | "payment.revoked"
                ),
                "invalid handoff event kind"
            );
            let phase = event.kind.strip_prefix("payment.").unwrap();
            ensure!(
                id == format!("{}:{}:{phase}", event.payment.id, event.revision),
                "invalid handoff event lineage"
            );
            digest.update(serde_json::to_vec(&(seq, &id, &body))?);
            boundary = seq;
            events.insert(id, event);
        }
    }
    let mut receipts = Vec::new();
    {
        let mut q = tx.prepare("SELECT CASE WHEN length(id)<=2048 THEN id END,CASE WHEN length(payment)<=16384 THEN payment END,height,hash,revision,active,confirmed FROM receipts WHERE height>=?1 OR id IN (SELECT json_extract(body,'$.payment.id') FROM events WHERE json_extract(body,'$.block_height')>=?1) ORDER BY id LIMIT ?2")?;
        let mut rows = q.query(params![floor, max_receipts + 1])?;
        while let Some(row) = rows.next()? {
            check()?;
            ensure!(
                receipts.len() < max_receipts as usize,
                "handoff receipt cap exceeded"
            );
            let id: String = row.get(0)?;
            let body: String = row.get(1)?;
            ensure!(body.len() <= 16_384, "oversized handoff receipt");
            inventory_bytes += id.len() + body.len();
            ensure!(
                inventory_bytes <= 64 * 1024 * 1024,
                "handoff inventory byte cap exceeded"
            );
            let payment: Payment = serde_json::from_str(&body)?;
            ensure!(payment.id == id, "invalid handoff receipt identity");
            let height: u32 = row.get(2)?;
            let hash: String = row.get(3)?;
            let revision: u32 = row.get(4)?;
            let active: bool = row.get(5)?;
            let confirmed: bool = row.get(6)?;
            digest.update(serde_json::to_vec(&(
                &id, &body, height, &hash, revision, active, confirmed,
            ))?);
            receipts.push((payment, height, hash, revision, active, confirmed));
        }
    }
    let mut positive = HashMap::<&str, Vec<&Event>>::new();
    for event in events.values().filter(|e| e.kind != "payment.revoked") {
        positive.entry(&event.payment.id).or_default().push(event);
    }
    let mut revoked = HashMap::<&str, Vec<&Event>>::new();
    for event in events.values().filter(|e| e.kind == "payment.revoked") {
        revoked.entry(&event.payment.id).or_default().push(event);
    }
    let mut planned = Vec::new();
    let mut subscriptions = std::collections::BTreeSet::new();
    let mut eligible = 0_u64;
    let mut existing = 0_u64;
    let mut existing_acked = 0_u64;
    let mut revocations = std::collections::BTreeMap::new();
    for (payment, height, hash, revision, active, confirmed) in &receipts {
        check()?;
        let lookup = |rev: u32, phase: &str| events.get(&format!("{}:{rev}:{phase}", payment.id));
        for prior in positive
            .get(payment.id.as_str())
            .into_iter()
            .flatten()
            .filter(|e| e.revision < *revision)
        {
            check()?;
            let revoke = lookup(prior.revision, "revoked")
                .ok_or_else(|| anyhow::anyhow!("prior positive lifecycle lost its revocation"))?;
            ensure!(
                prior.payment == *payment && revoke.payment == *payment,
                "prior lifecycle payment mismatch"
            );
        }
        let phase = if !active {
            "revoked"
        } else if *confirmed {
            "confirmed"
        } else {
            "observed"
        };
        let current = if *height >= floor {
            Some(
                lookup(*revision, phase)
                    .ok_or_else(|| anyhow::anyhow!("current receipt lifecycle event missing"))?,
            )
        } else {
            None
        };
        if let Some(current) = current {
            ensure!(
                current.payment == *payment
                    && current.block_height == *height
                    && current.block_hash == *hash,
                "current receipt lifecycle event mismatch"
            );
            if *active {
                let canonical: String =
                    tx.query_row("SELECT hash FROM blocks WHERE height=?1", [height], |r| {
                        r.get(0)
                    })?;
                ensure!(canonical == *hash, "handoff receipt outside journal chain");
            }
        }
        for (consumer_id, observe_unconfirmed) in consumers {
            let mut selected = Vec::new();
            if let Some(current) = current {
                if *active {
                    if *observe_unconfirmed && let Some(observed) = lookup(*revision, "observed") {
                        ensure!(
                            observed.payment == *payment
                                && observed.block_height == *height
                                && observed.block_hash == *hash,
                            "current observation mismatch"
                        );
                        selected.push(observed);
                    }
                    if *confirmed {
                        selected.push(current);
                    }
                } else {
                    let entitled: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM subscriptions WHERE consumer=?1 AND payment_id=?2)", params![consumer_id, payment.id], |r| r.get(0))?;
                    if lookup(*revision, "confirmed").is_some()
                        || (*observe_unconfirmed && lookup(*revision, "observed").is_some())
                        || entitled
                    {
                        selected.push(current);
                    }
                }
            }
            // Preserve missing historical revocations for a consumer that
            // had positive work or a stored confirmed lineage for that revision.
            // Legacy automation may already have issued even when these new
            // daemon consumer IDs have no previous delivery rows. Never enqueue superseded
            // positive events just to manufacture entitlement.
            for event in revoked
                .get(payment.id.as_str())
                .into_iter()
                .flatten()
                .filter(|e| e.revision < *revision)
            {
                check()?;
                let entitled: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM deliveries WHERE consumer=?1 AND event_id IN (?2,?3))", params![consumer_id, format!("{}:{}:confirmed",payment.id,event.revision), format!("{}:{}:observed",payment.id,event.revision)], |r| r.get(0))?;
                if entitled
                    || lookup(event.revision, "confirmed").is_some()
                    || (*observe_unconfirmed && lookup(event.revision, "observed").is_some())
                {
                    selected.push(event);
                }
            }
            selected.sort_by_key(|e| e.journal_sequence);
            for event in selected {
                check()?;
                eligible += 1;
                subscriptions.insert((consumer_id.clone(), payment.id.clone()));
                let acked: Option<bool> = tx
                    .query_row(
                        "SELECT acked FROM deliveries WHERE consumer=?1 AND event_id=?2",
                        params![consumer_id, event.event_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if event.kind == "payment.revoked" && acked != Some(true) {
                    revocations.insert(event.event_id.clone(), event.clone());
                }
                if let Some(acked) = acked {
                    existing += 1;
                    existing_acked += u64::from(acked);
                } else {
                    ensure!(planned.len() < 100_000, "handoff delivery cap exceeded");
                    planned.push((
                        consumer_id.clone(),
                        payment.id.clone(),
                        event.event_id.clone(),
                        event.journal_sequence,
                    ));
                }
            }
        }
    }
    Ok(HandoffPlan {
        missing: planned,
        subscriptions,
        revocations,
        proof: json!({"schema":1,"identity_sha256":hex::encode(Sha256::digest(serde_json::to_vec(expected)?)),"inventory_sha256":hex::encode(digest.finalize()),"boundary_sequence":boundary,"receipt_count":receipts.len(),"event_count":events.len(),"inventory_bytes":inventory_bytes,"configured_consumers":consumers.len(),"eligible_deliveries":eligible,"existing_deliveries":existing,"existing_acked":existing_acked,"existing_pending":existing-existing_acked}),
    })
}
