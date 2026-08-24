//! The volatile store — `WIRE.md` §11.1's `durability_mode = memory`.
//!
//! # What it is for
//!
//! Three things, and the first is the one that matters:
//!
//! 1. **It makes `fsync-per-append` mean something.** A published
//!    `durability_mode` field with one possible value is a field nobody checks.
//!    Every property test in this crate runs against both stores, so a rule
//!    that only holds because SQLite happens to enforce it — a `NOT NULL`, a
//!    `PRIMARY KEY` collision — fails here, where nothing enforces anything
//!    except the code that is supposed to.
//! 2. A relay an operator explicitly wants to be a cache: §8.4 is clear that
//!    "no end-to-end contract breaks in the weaker modes, because `accepted`
//!    never promised anything". The honest requirement is that the relay
//!    *publish* what it is, which [`RelayStore::durability`] makes it able to.
//! 3. Tests of everything above the store, without a filesystem.
//!
//! # What it must never be used for
//!
//! A relay that a stranger's messages pass through. Under delete-on-ack the
//! relay's copy is, for a window, the only copy; here that window ends at the
//! next restart.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

use f2z_codec::types::{Payload, PublicKey, QueueAddress};
use f2z_relay_proto::queue::{AckOutcome, QueueKind, QueueState};

use crate::durability::{Committed, Durability};
use crate::error::{Result, StoreError};
use crate::record::{
    Append, Appended, Deleted, ExpiryReason, ExpiryReport, QueueExpiry, QueueRecord, QueueSpec,
    ReadPage, ReadWindow, SendAuth, StoreStats, StoredMessage, message_deadline,
};
use crate::sqlite::authorize_send;
use crate::store::RelayStore;

#[derive(Clone, Debug)]
struct StoredEntry {
    index: u64,
    received_at_ms: u64,
    expires_at_ms: u64,
    payload: Payload,
}

#[derive(Clone, Debug)]
struct MemoryQueue {
    record: QueueRecord,
    /// Ascending by index, always. `ACK` deletes a prefix and `READ` scans a
    /// suffix, which is the same access pattern the SQLite schema's
    /// `WITHOUT ROWID` `(recv_addr, idx)` key buys.
    messages: Vec<StoredEntry>,
}

#[derive(Debug, Default)]
struct Inner {
    queues: HashMap<QueueAddress, MemoryQueue>,
    /// send address → receive address. The pairing §6.2 admits the relay
    /// necessarily holds: "an APPEND to `QueueSendAddr` has to be delivered
    /// into the message list read from `QueueRecvAddr`".
    by_send: HashMap<QueueAddress, QueueAddress>,
}

/// A store that holds everything in memory and loses it on exit.
#[derive(Debug, Default)]
pub struct MemoryStore {
    inner: Mutex<Inner>,
}

impl MemoryStore {
    /// An empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Inner {
    fn by_recv(&self, recv_addr: &QueueAddress) -> Result<&MemoryQueue> {
        self.queues.get(recv_addr).ok_or_else(StoreError::no_access)
    }

    fn by_recv_mut(&mut self, recv_addr: &QueueAddress) -> Result<&mut MemoryQueue> {
        self.queues
            .get_mut(recv_addr)
            .ok_or_else(StoreError::no_access)
    }

    fn recv_for_send(&self, send_addr: &QueueAddress) -> Result<QueueAddress> {
        self.by_send
            .get(send_addr)
            .copied()
            .ok_or_else(StoreError::unavailable)
    }

    fn drop_queue(&mut self, recv_addr: &QueueAddress) -> Option<MemoryQueue> {
        let queue = self.queues.remove(recv_addr)?;
        self.by_send.remove(&queue.record.send_addr);
        Some(queue)
    }
}

fn totals(queue: &MemoryQueue) -> (u64, u64) {
    let count = u64::try_from(queue.messages.len()).unwrap_or(u64::MAX);
    let bytes = queue.messages.iter().fold(0u64, |sum, entry| {
        sum.saturating_add(u64::try_from(entry.payload.len()).unwrap_or(u64::MAX))
    });
    (count, bytes)
}

fn touch_record(record: &mut QueueRecord, now_ms: u64) {
    if record.last_activity_ms < now_ms {
        record.last_activity_ms = now_ms;
    }
}

impl RelayStore for MemoryStore {
    fn durability(&self) -> Durability {
        Durability::Memory
    }

    fn create_queue(&self, spec: &QueueSpec) -> Result<Committed<QueueRecord>> {
        if spec.recv_addr == spec.send_addr {
            return Err(StoreError::AddressCollision);
        }
        let mut inner = self.lock();
        // Both addresses come out of one 32-byte space, so a collision with
        // either kind of existing address is a collision (§7.1: draw again).
        let taken = |inner: &Inner, address: &QueueAddress| {
            inner.queues.contains_key(address) || inner.by_send.contains_key(address)
        };
        if taken(&inner, &spec.recv_addr) || taken(&inner, &spec.send_addr) {
            return Err(StoreError::AddressCollision);
        }

        let record = QueueRecord {
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
        };
        inner.by_send.insert(spec.send_addr, spec.recv_addr);
        inner.queues.insert(
            spec.recv_addr,
            MemoryQueue {
                record: record.clone(),
                messages: Vec::new(),
            },
        );
        Ok(Committed::seal(self.durability(), record))
    }

    fn bind_send(
        &self,
        send_addr: &QueueAddress,
        signer: &PublicKey,
        now_ms: u64,
    ) -> Result<Committed<()>> {
        let mut inner = self.lock();
        let recv_addr = inner.recv_for_send(send_addr)?;
        let queue = inner.by_recv_mut(&recv_addr)?;
        queue.record.state.bind_send(signer)?;
        touch_record(&mut queue.record, now_ms);
        Ok(Committed::seal(self.durability(), ()))
    }

    fn queue_by_recv(&self, recv_addr: &QueueAddress, signer: &PublicKey) -> Result<QueueRecord> {
        let inner = self.lock();
        let queue = inner.by_recv(recv_addr)?;
        queue.record.state.authorize_recv(signer)?;
        Ok(queue.record.clone())
    }

    fn queue_by_send(&self, send_addr: &QueueAddress, auth: &SendAuth) -> Result<QueueRecord> {
        let inner = self.lock();
        let recv_addr = inner.recv_for_send(send_addr)?;
        let queue = inner
            .queues
            .get(&recv_addr)
            .ok_or_else(StoreError::unavailable)?;
        authorize_send(&queue.record, auth)?;
        Ok(queue.record.clone())
    }

    fn append_batch(&self, appends: &[Append<'_>]) -> Result<Committed<Vec<Result<Appended>>>> {
        let mut inner = self.lock();
        let mut results: Vec<Result<Appended>> = Vec::with_capacity(appends.len());
        for append in appends {
            results.push(append_one(&mut inner, append));
        }
        Ok(Committed::seal(self.durability(), results))
    }

    fn read(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        window: ReadWindow,
        now_ms: u64,
    ) -> Result<ReadPage> {
        let mut inner = self.lock();
        let queue = inner.by_recv_mut(recv_addr)?;
        queue.record.state.authorize_recv(signer)?;

        let floor = queue.record.state.read_from(window.from_index);
        let mut messages = Vec::new();
        let mut fetched = 0usize;
        let mut bytes = 0u64;
        for entry in &queue.messages {
            if entry.index < floor || entry.expires_at_ms <= now_ms {
                continue;
            }
            fetched = fetched.saturating_add(1);
            if messages.len() >= usize::from(window.max_messages) {
                continue;
            }
            let size = u64::try_from(entry.payload.len()).unwrap_or(u64::MAX);
            let next = bytes.saturating_add(size);
            // At least one message, always — see the same comment in `sqlite`.
            if next > u64::from(window.max_bytes) && !messages.is_empty() {
                // ACK is cumulative, so a page must never skip an oversized
                // message and return a later one. Doing so would let the
                // reader ACK the later index and destroy the skipped row.
                break;
            }
            bytes = next;
            messages.push(StoredMessage {
                index: entry.index,
                received_at_ms: entry.received_at_ms,
                payload: entry.payload.clone(),
            });
        }
        let page = ReadPage {
            has_more: fetched > messages.len(),
            messages,
            next_index: queue.record.state.next_index(),
            pending: queue.record.state.pending(),
        };
        touch_record(&mut queue.record, now_ms);
        Ok(page)
    }

    fn ack(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        up_to_index: u64,
        now_ms: u64,
    ) -> Result<Committed<AckOutcome>> {
        let mut inner = self.lock();
        let queue = inner.by_recv_mut(recv_addr)?;
        queue.record.state.authorize_recv(signer)?;
        let outcome = queue.record.state.ack(up_to_index)?;
        if outcome.acknowledged > 0 {
            queue.messages.retain(|entry| entry.index > up_to_index);
            let (count, bytes) = totals(queue);
            queue.record.stored_messages = count;
            queue.record.stored_bytes = bytes;
        }
        touch_record(&mut queue.record, now_ms);
        Ok(Committed::seal(self.durability(), outcome))
    }

    fn delete_queue(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
    ) -> Result<Committed<Deleted>> {
        let mut inner = self.lock();
        let queue = inner.by_recv(recv_addr)?;
        queue.record.state.authorize_recv(signer)?;
        let (messages_deleted, bytes_freed) = totals(queue);
        inner.drop_queue(recv_addr);
        Ok(Committed::seal(
            self.durability(),
            Deleted {
                messages_deleted,
                bytes_freed,
            },
        ))
    }

    fn touch(&self, recv_addr: &QueueAddress, signer: &PublicKey, now_ms: u64) -> Result<()> {
        let mut inner = self.lock();
        let queue = inner.by_recv_mut(recv_addr)?;
        queue.record.state.authorize_recv(signer)?;
        touch_record(&mut queue.record, now_ms);
        Ok(())
    }

    fn expire(&self, now_ms: u64) -> Result<Committed<ExpiryReport>> {
        let mut inner = self.lock();
        let mut report = ExpiryReport::default();

        let idle: Vec<QueueAddress> = inner
            .queues
            .values()
            .filter(|queue| queue.record.idle_expires_at_ms() <= now_ms)
            .map(|queue| queue.record.recv_addr)
            .collect();
        for recv_addr in idle {
            let Some(queue) = inner.drop_queue(&recv_addr) else {
                continue;
            };
            let (messages_expired, bytes_freed) = totals(&queue);
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

        for queue in inner.queues.values_mut() {
            let before = totals(queue);
            queue.messages.retain(|entry| entry.expires_at_ms > now_ms);
            let after = totals(queue);
            let messages_expired = before.0.saturating_sub(after.0);
            if messages_expired == 0 {
                continue;
            }
            let bytes_freed = before.1.saturating_sub(after.1);
            // The watermark deliberately does not move: an expired message was
            // never acknowledged.
            queue.record.stored_messages = after.0;
            queue.record.stored_bytes = after.1;
            report.messages_expired = report.messages_expired.saturating_add(messages_expired);
            report.bytes_freed = report.bytes_freed.saturating_add(bytes_freed);
            report.expired.push(QueueExpiry {
                recv_addr: queue.record.recv_addr,
                reason: ExpiryReason::MessageTtl,
                messages_expired,
                bytes_freed,
            });
        }

        Ok(Committed::seal(self.durability(), report))
    }

    fn stats(&self) -> Result<StoreStats> {
        let inner = self.lock();
        let mut stats = StoreStats::default();
        for queue in inner.queues.values() {
            match queue.record.kind() {
                QueueKind::Standard => stats.queues = stats.queues.saturating_add(1),
                QueueKind::Contact => {
                    stats.contact_queues = stats.contact_queues.saturating_add(1);
                }
            }
            let (count, bytes) = totals(queue);
            stats.messages = stats.messages.saturating_add(count);
            stats.payload_bytes = stats.payload_bytes.saturating_add(bytes);
        }
        // No file, so "what the engine allocated" is the payload plus the
        // records. Reported rather than zeroed, because a caller wiring §13.1
        // layer 4 against a store that always says zero would find out it was
        // wrong in production.
        stats.storage_bytes = stats.payload_bytes.saturating_add(
            stats
                .queues
                .saturating_add(stats.contact_queues)
                .saturating_mul(256),
        );
        Ok(stats)
    }
}

fn append_one(inner: &mut Inner, append: &Append<'_>) -> Result<Appended> {
    let recv_addr = inner.recv_for_send(&append.send_addr)?;
    let queue = inner
        .queues
        .get_mut(&recv_addr)
        .ok_or_else(StoreError::unavailable)?;
    authorize_send(&queue.record, &append.auth)?;

    let payload_bytes =
        u64::try_from(append.payload.len()).map_err(|_| StoreError::unavailable())?;
    queue.record.quota.admit(
        queue.record.stored_messages,
        queue.record.stored_bytes,
        payload_bytes,
    )?;

    let index = queue.record.state.append()?;
    queue.messages.push(StoredEntry {
        index,
        received_at_ms: append.received_at_ms,
        expires_at_ms: message_deadline(append.received_at_ms, queue.record.message_ttl_seconds),
        payload: append.payload.clone(),
    });
    queue.record.stored_messages = queue.record.stored_messages.saturating_add(1);
    queue.record.stored_bytes = queue.record.stored_bytes.saturating_add(payload_bytes);
    touch_record(&mut queue.record, append.received_at_ms);

    Ok(Appended {
        recv_addr,
        index,
        received_at_ms: append.received_at_ms,
    })
}

/// Keeps `idle_deadline` honest across both stores: the SQLite store persists
/// the deadline as a column, this one recomputes it, and they must agree.
#[cfg(test)]
mod tests {
    use crate::record::idle_deadline;

    #[test]
    fn the_idle_deadline_is_the_same_function_in_both_stores() {
        assert_eq!(idle_deadline(10_000, 60), 70_000);
    }
}
