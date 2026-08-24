//! The relay's storage, and the parts of `WIRE.md` §7, §8 and §12 that are
//! about *holding* things rather than about rules.
//!
//! `f2z-relay-proto::queue` already owns every rule that can lose a message:
//! bind-once, cumulative-monotone-idempotent acknowledgement, and the anti-
//! pre-ack bound. None of it is re-implemented here. What is here is the state
//! those rules are applied to — a `BTreeMap` of ciphertext, a subscriber list,
//! and the challenge table — plus the two behaviours that only exist once
//! something is stored: TTL expiry (§7.7) and the quota admission of §13.1
//! layer 2.
//!
//! # In-memory, and that is published
//!
//! §11.1's `durability_mode` has three values and this is `memory`: an `APPEND`
//! that returned 0 does not survive the process. §8.4 says no end-to-end
//! contract breaks in the weaker modes because `accepted` never promised
//! anything — which is true, and is also exactly why a client must not treat
//! `accepted` as delivery. A test harness that silently offered durability
//! would hide that.
//!
//! # The one rule that is *not* here, restated because it is the important one
//!
//! §13.2: **under no circumstance does a relay delete an unacknowledged message
//! to free space.** Not the oldest, not the largest, not from the fullest
//! queue. When it runs out of room it refuses new writes. There is no eviction
//! path in this module, and the absence is deliberate rather than an omission:
//! the only deletions are acknowledgement (§8), TTL expiry (§7.7) and
//! `DELETE_QUEUE` (§7.6).

use std::collections::{BTreeMap, BTreeSet};

use f2z_codec::ErrorCode;
use f2z_codec::commands::{NoticePush, PushEvent, QueueEventPush, QueuedMessage};
use f2z_codec::types::{Challenge, Payload, PublicKey, QueueAddress};
use f2z_relay_proto::ProtoError;
use f2z_relay_proto::queue::{AckOutcome, AppendQuota, QueueKind, QueueState};
use f2z_relay_proto::replay::SeenSet;
use tokio::sync::mpsc::UnboundedSender;

use crate::error::Result;
use crate::faults::PolicyFaults;
use crate::outbound::Outbound;
use crate::rng::Csprng;

/// `QUEUE_EVENT` reason 1 (§6.4): the queue was deleted.
pub const QUEUE_EVENT_DELETED: u8 = 1;
/// `QUEUE_EVENT` reason 2 (§6.4): the queue's idle TTL elapsed.
pub const QUEUE_EVENT_IDLE_EXPIRED: u8 = 2;
/// `QUEUE_EVENT` reason 3 (§6.4): stored messages hit their TTL.
pub const QUEUE_EVENT_MESSAGES_EXPIRED: u8 = 3;
/// `QUEUE_EVENT` reason 4 (§6.4): a quota was reached.
pub const QUEUE_EVENT_QUOTA: u8 = 4;

/// `NOTICE` kind 3 (§6.4): the capability document changed.
pub const NOTICE_CAPABILITIES_CHANGED: u8 = 3;

/// One stored ciphertext.
#[derive(Clone, Debug)]
pub struct Stored {
    /// The index it was appended at.
    pub index: u64,
    /// The opaque payload. The relay never looks inside one.
    pub payload: Payload,
    /// Relay clock at acceptance — `QueuedMessage.received_at_ms`.
    pub received_at_ms: u64,
    /// When §7.7's message TTL drops it.
    pub expires_at_ms: u64,
}

impl Stored {
    fn as_message(&self) -> QueuedMessage {
        QueuedMessage {
            index: self.index,
            received_at_ms: self.received_at_ms,
            payload: self.payload.clone(),
        }
    }
}

/// One queue: the rules from `f2z-relay-proto`, plus what it holds.
#[derive(Clone, Debug)]
pub struct Queue {
    /// Standard or contact (§12.2).
    pub kind: QueueKind,
    /// Authorization and acknowledgement state — the rules, not re-derived.
    pub state: QueueState,
    /// The receive address: `SUBSCRIBE`, `READ`, `ACK`, `DELETE_QUEUE`.
    pub recv_addr: QueueAddress,
    /// The second address: bindable `send_addr` for a standard queue, published
    /// and never bindable `contact_addr` for a contact queue.
    pub second_addr: QueueAddress,
    /// Stored ciphertext, by index.
    pub messages: BTreeMap<u64, Stored>,
    /// Bytes currently held, for §13.1 layer 2's byte cap.
    pub bytes: u64,
    /// The granted message TTL (§7.7), after clamping.
    pub message_ttl_seconds: u32,
    /// The granted idle TTL (§7.7), after clamping.
    pub idle_ttl_seconds: u32,
    /// Relay clock at creation.
    pub created_at_ms: u64,
    /// Last successful `APPEND`, `READ`, `ACK` or `SUBSCRIBE` — §7.7's idle
    /// reset list, exactly as written.
    pub last_activity_ms: u64,
    /// The per-queue caps this queue is admitted against.
    pub quota: AppendQuota,
}

impl Queue {
    /// Messages present and not yet acknowledged — §6.2's `pending`.
    ///
    /// Counted from storage rather than from the index arithmetic, because TTL
    /// expiry removes messages without moving the watermark and the index-space
    /// count is only an upper bound. `f2z-relay-proto::queue` says so and hands
    /// the decision here, which is where the storage is.
    #[must_use]
    pub fn pending(&self) -> u64 {
        u64::try_from(self.messages.len()).unwrap_or(u64::MAX)
    }

    /// Touch §7.7's idle timer.
    pub fn touch(&mut self, now_ms: u64) {
        self.last_activity_ms = now_ms;
    }

    fn idle_deadline(&self, faults: PolicyFaults) -> u64 {
        match faults.expire_queue_after {
            Some(after) => self
                .last_activity_ms
                .saturating_add(u64::try_from(after.as_millis()).unwrap_or(u64::MAX)),
            None => self
                .last_activity_ms
                .saturating_add(u64::from(self.idle_ttl_seconds).saturating_mul(1_000)),
        }
    }

    fn message_deadline(&self, stored: &Stored, faults: PolicyFaults) -> u64 {
        match faults.expire_messages_after {
            Some(after) => stored
                .received_at_ms
                .saturating_add(u64::try_from(after.as_millis()).unwrap_or(u64::MAX)),
            None => stored.expires_at_ms,
        }
    }

    fn effective_quota(&self, faults: PolicyFaults) -> AppendQuota {
        AppendQuota {
            max_messages: faults
                .max_queue_messages
                .map_or(self.quota.max_messages, u64::from),
            max_bytes: faults.max_queue_bytes.unwrap_or(self.quota.max_bytes),
        }
    }
}

/// A connection that asked for `MSG` pushes on a queue (§6.2, §6.4).
#[derive(Clone, Debug)]
struct Subscriber {
    connection: u64,
    sender: UnboundedSender<Outbound>,
}

/// A challenge the relay issued and has not yet consumed (§6.1, §12.3).
#[derive(Clone)]
struct Issued {
    purpose: u8,
    scope: Vec<u8>,
    expires_at_ms: u64,
}

// `scope` is a published contact address for a `contact_append` challenge —
// public by design, but still a capability, and §12.2 point 3 makes it the one
// address in the system meant to be looked up rather than logged.
impl core::fmt::Debug for Issued {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Issued")
            .field("purpose", &self.purpose)
            .field(
                "scope",
                &format_args!("<redacted; {} bytes>", self.scope.len()),
            )
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

/// Everything one relay holds.
#[derive(Debug)]
pub struct RelayState {
    rng: Csprng,
    queues: BTreeMap<QueueAddress, Queue>,
    /// `send_addr` or `contact_addr` → `recv_addr`.
    second_index: BTreeMap<QueueAddress, QueueAddress>,
    challenges: BTreeMap<Challenge, Issued>,
    subscribers: BTreeMap<QueueAddress, Vec<Subscriber>>,
    /// §5.5's seen-set, relay-wide rather than per connection. In
    /// `channel_binding_mode: none` — which is what a `ws://` test double
    /// publishes — the binding is a constant, so a frame captured on one
    /// connection verifies on another and a per-connection set would not close
    /// the window at all.
    seen: SeenSet,
    next_connection_id: u64,
}

impl RelayState {
    /// A fresh, empty relay.
    #[must_use]
    pub fn new(rng_seed: [u8; 32], seen: SeenSet) -> Self {
        Self {
            rng: Csprng::from_seed(rng_seed),
            queues: BTreeMap::new(),
            second_index: BTreeMap::new(),
            challenges: BTreeMap::new(),
            subscribers: BTreeMap::new(),
            seen,
            next_connection_id: 1,
        }
    }

    /// Take the seen-set out for one verification, leaving a placeholder.
    ///
    /// `CommandVerifier` owns its seen-set because §5.1's ordering — window,
    /// then seen-set, then signature — has to live in one function. Moving the
    /// real set in and out per command is what lets that single implementation
    /// be reused while the set stays relay-wide.
    pub fn take_seen(&mut self) -> SeenSet {
        let placeholder = SeenSet::new(self.seen.retention_ms(), self.seen.max_entries());
        core::mem::replace(&mut self.seen, placeholder)
    }

    /// Put the seen-set back after a verification.
    pub fn put_seen(&mut self, seen: SeenSet) {
        self.seen = seen;
    }

    /// The seen-set, for assertions.
    #[must_use]
    pub const fn seen(&self) -> &SeenSet {
        &self.seen
    }

    /// A connection identifier, so a subscription can be dropped when its
    /// connection goes (§6.2: "a subscription is scoped to the connection and
    /// dies with it").
    pub fn next_connection_id(&mut self) -> u64 {
        let id = self.next_connection_id;
        self.next_connection_id = self.next_connection_id.saturating_add(1);
        id
    }

    /// How many queues exist, for §13.1's creation quota.
    #[must_use]
    pub fn queue_count(&self) -> usize {
        self.queues.len()
    }

    /// The relay's own CSPRNG (§7.1). See [`crate::rng`] for what it is not.
    pub const fn rng(&mut self) -> &mut Csprng {
        &mut self.rng
    }

    // -- queues ------------------------------------------------------------

    /// Create a queue, generating both addresses from the relay's own generator
    /// (§7.1).
    pub fn create_queue(
        &mut self,
        kind: QueueKind,
        recv_key: PublicKey,
        message_ttl_seconds: u32,
        idle_ttl_seconds: u32,
        quota: AppendQuota,
        now_ms: u64,
    ) -> (QueueAddress, QueueAddress) {
        // §7.1: 32 uniformly random bytes each, independent of one another and
        // of any key, retried on collision — which at 32 bytes never happens,
        // but the retry is what makes that a fact rather than a hope.
        let recv_addr = self.fresh_address();
        let second_addr = self.fresh_address();
        let queue = Queue {
            kind,
            state: QueueState::create(kind, recv_key),
            recv_addr,
            second_addr,
            messages: BTreeMap::new(),
            bytes: 0,
            message_ttl_seconds,
            idle_ttl_seconds,
            created_at_ms: now_ms,
            last_activity_ms: now_ms,
            quota,
        };
        self.queues.insert(recv_addr, queue);
        self.second_index.insert(second_addr, recv_addr);
        (recv_addr, second_addr)
    }

    fn fresh_address(&mut self) -> QueueAddress {
        loop {
            let candidate = self.rng.next_address();
            if candidate.is_zero() {
                continue;
            }
            if !self.queues.contains_key(&candidate) && !self.second_index.contains_key(&candidate)
            {
                return candidate;
            }
        }
    }

    /// The queue a receive address names, if any.
    #[must_use]
    pub fn queue_by_recv(&mut self, recv_addr: &QueueAddress) -> Option<&mut Queue> {
        self.queues.get_mut(recv_addr)
    }

    /// The queue a send or contact address names, if any.
    #[must_use]
    pub fn queue_by_second(&mut self, second_addr: &QueueAddress) -> Option<&mut Queue> {
        let recv = self.second_index.get(second_addr).copied()?;
        self.queues.get_mut(&recv)
    }

    /// Whether an address is a queue's second address at all.
    #[must_use]
    pub fn is_second_address(&self, address: &QueueAddress) -> bool {
        self.second_index.contains_key(address)
    }

    /// Delete a queue, its addresses and every message it holds (§7.6).
    ///
    /// Leaves no tombstone: §7.6 forbids retaining anything that distinguishes
    /// "deleted" from "never existed" in an externally observable way, so the
    /// record is dropped rather than flagged.
    pub fn delete_queue(&mut self, recv_addr: &QueueAddress) -> bool {
        let Some(queue) = self.queues.remove(recv_addr) else {
            return false;
        };
        self.second_index.remove(&queue.second_addr);
        self.notify_queue_event(recv_addr, QUEUE_EVENT_DELETED);
        self.subscribers.remove(recv_addr);
        true
    }

    /// Append a payload, after the caller has authorized it and admitted it
    /// against the quota.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Unavailable`] if the index space is exhausted — a send-side
    /// refusal like every other (§6.3).
    pub fn append(
        &mut self,
        recv_addr: &QueueAddress,
        payload: Payload,
        now_ms: u64,
    ) -> std::result::Result<u64, ProtoError> {
        let Some(queue) = self.queues.get_mut(recv_addr) else {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        };
        let index = queue.state.append()?;
        let expires_at_ms =
            now_ms.saturating_add(u64::from(queue.message_ttl_seconds).saturating_mul(1_000));
        let stored = Stored {
            index,
            payload,
            received_at_ms: now_ms,
            expires_at_ms,
        };
        queue.bytes = queue
            .bytes
            .saturating_add(u64::try_from(stored.payload.len()).unwrap_or(u64::MAX));
        let message = stored.as_message();
        queue.messages.insert(index, stored);
        queue.touch(now_ms);
        self.notify_message(recv_addr, &message);
        Ok(index)
    }

    /// Admit one payload against a queue's caps (§13.1 layer 2, §12.3).
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Unavailable`], never a code that says which cap was hit.
    pub fn admit(
        &mut self,
        recv_addr: &QueueAddress,
        payload_bytes: u64,
        faults: PolicyFaults,
    ) -> std::result::Result<(), ProtoError> {
        let Some(queue) = self.queues.get(recv_addr) else {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        };
        let quota = queue.effective_quota(faults);
        let admitted = quota.admit(queue.pending(), queue.bytes, payload_bytes);
        if admitted.is_err() {
            self.notify_queue_event(recv_addr, QUEUE_EVENT_QUOTA);
        }
        admitted
    }

    /// Read from `from_index`, clamped to the acked watermark (§6.2).
    ///
    /// Returns the messages and whether more remain past the last one.
    #[must_use]
    pub fn read(
        &mut self,
        recv_addr: &QueueAddress,
        from_index: u64,
        max_messages: u16,
        max_bytes: u32,
        now_ms: u64,
    ) -> Option<(Vec<QueuedMessage>, bool)> {
        let queue = self.queues.get_mut(recv_addr)?;
        queue.touch(now_ms);
        let start = queue.state.read_from(from_index);

        // §6.2 gives no meaning to a zero limit, and the reading that keeps a
        // queue drainable is "no client-side limit" — the same reading
        // f2z-relay-proto takes for a zero TTL. A zero that meant "return
        // nothing" would make a client that forgot to set the field loop
        // forever against a queue it can never empty.
        let message_limit = if max_messages == 0 {
            usize::MAX
        } else {
            usize::from(max_messages)
        };
        let byte_limit = if max_bytes == 0 {
            u64::MAX
        } else {
            u64::from(max_bytes)
        };

        let mut messages = Vec::new();
        let mut bytes = 0u64;
        let mut has_more = false;
        for stored in queue.messages.range(start..).map(|(_, stored)| stored) {
            let size = u64::try_from(stored.payload.len()).unwrap_or(u64::MAX);
            if !messages.is_empty()
                && (messages.len() >= message_limit || bytes.saturating_add(size) > byte_limit)
            {
                has_more = true;
                break;
            }
            bytes = bytes.saturating_add(size);
            messages.push(stored.as_message());
        }
        Some((messages, has_more))
    }

    /// Apply an `ACK` and delete what it acknowledges (§8).
    ///
    /// # Errors
    ///
    /// [`ErrorCode::AckTooHigh`] from §8.2's anti-pre-ack rule, or
    /// [`ErrorCode::NoAccess`] if the queue is gone.
    pub fn ack(
        &mut self,
        recv_addr: &QueueAddress,
        up_to_index: u64,
        now_ms: u64,
    ) -> std::result::Result<(AckOutcome, u64), ProtoError> {
        let Some(queue) = self.queues.get_mut(recv_addr) else {
            return Err(ProtoError::Wire(ErrorCode::NoAccess));
        };
        let outcome = queue.state.ack(up_to_index)?;
        // The watermark moved (or did not, idempotently). Either way the
        // messages at or below it are gone: §8.1, "the relay deletes them and
        // advances the queue's acked watermark".
        let acknowledged: Vec<u64> = queue
            .messages
            .range(..=up_to_index)
            .map(|(index, _)| *index)
            .collect();
        for index in acknowledged {
            if let Some(stored) = queue.messages.remove(&index) {
                queue.bytes = queue
                    .bytes
                    .saturating_sub(u64::try_from(stored.payload.len()).unwrap_or(0));
            }
        }
        queue.touch(now_ms);
        Ok((outcome, queue.pending()))
    }

    // -- subscriptions -----------------------------------------------------

    /// Register a connection for `MSG` pushes on a receive address (§6.2).
    pub fn subscribe(
        &mut self,
        recv_addr: QueueAddress,
        connection: u64,
        sender: UnboundedSender<Outbound>,
    ) {
        let entries = self.subscribers.entry(recv_addr).or_default();
        if entries
            .iter()
            .any(|subscriber| subscriber.connection == connection)
        {
            return;
        }
        entries.push(Subscriber { connection, sender });
    }

    /// Drop one connection's subscription to one address.
    pub fn unsubscribe(&mut self, recv_addr: &QueueAddress, connection: u64) {
        if let Some(entries) = self.subscribers.get_mut(recv_addr) {
            entries.retain(|subscriber| subscriber.connection != connection);
            if entries.is_empty() {
                self.subscribers.remove(recv_addr);
            }
        }
    }

    /// Drop every subscription a connection holds — §6.2's "dies with it".
    pub fn drop_connection(&mut self, connection: u64, addresses: &BTreeSet<QueueAddress>) {
        for address in addresses {
            self.unsubscribe(address, connection);
        }
    }

    fn notify_message(&self, recv_addr: &QueueAddress, message: &QueuedMessage) {
        let Some(entries) = self.subscribers.get(recv_addr) else {
            return;
        };
        for subscriber in entries {
            let push = crate::outbound::msg_push(*recv_addr, message);
            if let Some(outbound) = push {
                let _ = subscriber.sender.send(outbound);
            }
        }
    }

    fn notify_queue_event(&self, recv_addr: &QueueAddress, reason: u8) {
        let Some(entries) = self.subscribers.get(recv_addr) else {
            return;
        };
        let body = QueueEventPush {
            recv_addr: *recv_addr,
            reason,
        };
        for subscriber in entries {
            if let Some(outbound) = crate::outbound::push(PushEvent::QueueEvent, &body) {
                let _ = subscriber.sender.send(outbound);
            }
        }
    }

    /// Send a `NOTICE` to every subscribed connection (§6.4).
    pub fn notify_all(&self, kind: u8, at_ms: u64) {
        let body = NoticePush { kind, at_ms };
        for entries in self.subscribers.values() {
            for subscriber in entries {
                if let Some(outbound) = crate::outbound::push(PushEvent::Notice, &body) {
                    let _ = subscriber.sender.send(outbound);
                }
            }
        }
    }

    // -- expiry ------------------------------------------------------------

    /// Apply §7.7's two timers. Called before every command, so a test that
    /// moves the clock sees the consequence on its next request.
    pub fn expire(&mut self, now_ms: u64, faults: PolicyFaults) {
        let mut messages_expired: Vec<QueueAddress> = Vec::new();
        let mut idle_expired: Vec<QueueAddress> = Vec::new();

        for (recv_addr, queue) in &mut self.queues {
            if queue.idle_deadline(faults) <= now_ms {
                idle_expired.push(*recv_addr);
                continue;
            }
            let expired: Vec<u64> = queue
                .messages
                .iter()
                .filter(|(_, stored)| queue.message_deadline(stored, faults) <= now_ms)
                .map(|(index, _)| *index)
                .collect();
            if expired.is_empty() {
                continue;
            }
            for index in expired {
                if let Some(stored) = queue.messages.remove(&index) {
                    queue.bytes = queue
                        .bytes
                        .saturating_sub(u64::try_from(stored.payload.len()).unwrap_or(0));
                }
            }
            messages_expired.push(*recv_addr);
        }

        for recv_addr in messages_expired {
            self.notify_queue_event(&recv_addr, QUEUE_EVENT_MESSAGES_EXPIRED);
        }
        for recv_addr in idle_expired {
            if let Some(queue) = self.queues.remove(&recv_addr) {
                self.second_index.remove(&queue.second_addr);
            }
            self.notify_queue_event(&recv_addr, QUEUE_EVENT_IDLE_EXPIRED);
            self.subscribers.remove(&recv_addr);
        }
    }

    // -- challenges --------------------------------------------------------

    /// Issue a single-use, expiring challenge (§6.1, §12.3).
    pub fn issue_challenge(&mut self, purpose: u8, scope: &[u8], expires_at_ms: u64) -> Challenge {
        let challenge = self.rng.next_challenge();
        self.challenges.insert(
            challenge,
            Issued {
                purpose,
                scope: scope.to_vec(),
                expires_at_ms,
            },
        );
        challenge
    }

    /// Consume a challenge, checking purpose, scope and expiry (§12.3).
    ///
    /// Binding the stamp to the target address and to a relay-issued challenge
    /// is what means stamps cannot be precomputed before a campaign, cannot be
    /// reused, and cannot be computed for one victim and spent on another. All
    /// three properties are this one function.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::PowInvalid`] — §10 code 17 covers "invalid, expired, for
    /// the wrong challenge, or already consumed" with one code, so none of the
    /// four is distinguishable from outside.
    pub fn consume_challenge(
        &mut self,
        challenge: &Challenge,
        purpose: u8,
        scope: &[u8],
        now_ms: u64,
    ) -> std::result::Result<(), ProtoError> {
        let Some(issued) = self.challenges.remove(challenge) else {
            return Err(ProtoError::Wire(ErrorCode::PowInvalid));
        };
        if issued.purpose != purpose
            || issued.expires_at_ms <= now_ms
            || (!scope.is_empty() && issued.scope != scope)
        {
            return Err(ProtoError::Wire(ErrorCode::PowInvalid));
        }
        Ok(())
    }

    /// Drop expired challenges. Cheap, and keeps a long-lived relay's table
    /// from growing without bound.
    pub fn expire_challenges(&mut self, now_ms: u64) {
        self.challenges
            .retain(|_, issued| issued.expires_at_ms > now_ms);
    }
}

/// A convenience for callers that want the whole state guarded.
pub type SharedResult<T> = Result<T>;

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::types::Payload;

    fn state() -> RelayState {
        RelayState::new([3u8; 32], SeenSet::new(240_000, 1024))
    }

    fn quota() -> AppendQuota {
        AppendQuota {
            max_messages: 8,
            max_bytes: 64 * 1024,
        }
    }

    #[test]
    fn a_created_queue_has_two_distinct_nonzero_addresses() {
        let mut state = state();
        let (recv, send) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            600,
            3_600,
            quota(),
            1_000,
        );
        assert_ne!(recv, send);
        assert!(!recv.is_zero());
        assert!(!send.is_zero());
        assert!(state.queue_by_recv(&recv).is_some());
        assert!(state.queue_by_second(&send).is_some());
    }

    #[test]
    fn deleting_a_queue_leaves_no_tombstone() {
        let mut state = state();
        let (recv, send) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            600,
            3_600,
            quota(),
            1_000,
        );
        assert!(state.delete_queue(&recv));
        assert!(state.queue_by_recv(&recv).is_none());
        assert!(state.queue_by_second(&send).is_none());
        assert!(!state.is_second_address(&send));
        // A second delete is indistinguishable from deleting one that never
        // existed, which is exactly §7.6.
        assert!(!state.delete_queue(&recv));
    }

    #[test]
    fn acking_deletes_and_read_never_resurrects() {
        let mut state = state();
        let (recv, _) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            600,
            3_600,
            quota(),
            1_000,
        );
        for _ in 0..3 {
            state
                .append(&recv, Payload::new(vec![0u8; 1024]).unwrap(), 1_000)
                .unwrap();
        }
        let (outcome, pending) = state.ack(&recv, 1, 1_000).unwrap();
        assert_eq!(outcome.acknowledged, 2);
        assert_eq!(pending, 1);

        // §6.2: a READ from below the watermark starts at the watermark and
        // does not error.
        let (messages, has_more) = state.read(&recv, 0, 0, 0, 1_000).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages.first().map(|m| m.index), Some(2));
        assert!(!has_more);
    }

    #[test]
    fn a_read_always_returns_at_least_one_message() {
        // A byte limit below the first message must not stall the queue
        // forever: the client would never be able to drain it, and there is no
        // other way out because READ never mutates.
        let mut state = state();
        let (recv, _) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            600,
            3_600,
            quota(),
            1_000,
        );
        state
            .append(&recv, Payload::new(vec![0u8; 4096]).unwrap(), 1_000)
            .unwrap();
        state
            .append(&recv, Payload::new(vec![0u8; 4096]).unwrap(), 1_000)
            .unwrap();
        let (messages, has_more) = state.read(&recv, 0, 0, 1, 1_000).unwrap();
        assert_eq!(messages.len(), 1);
        assert!(has_more);
    }

    #[test]
    fn ttl_expiry_removes_messages_without_moving_the_watermark() {
        let mut state = state();
        let (recv, _) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            60,
            3_600,
            quota(),
            1_000,
        );
        state
            .append(&recv, Payload::new(vec![0u8; 1024]).unwrap(), 1_000)
            .unwrap();
        state.expire(1_000 + 60_001, PolicyFaults::default());
        let queue = state.queue_by_recv(&recv).unwrap();
        assert_eq!(queue.messages.len(), 0);
        assert_eq!(queue.state.acked_through(), None);
        assert_eq!(queue.state.next_index(), 1);
        // And the reader can still not pre-ack past what was appended.
        assert!(state.ack(&recv, 5, 1_000).is_err());
    }

    #[test]
    fn an_idle_queue_disappears_with_both_its_addresses() {
        let mut state = state();
        let (recv, send) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            60,
            3_600,
            quota(),
            1_000,
        );
        state.expire(1_000 + 3_600_001, PolicyFaults::default());
        assert!(state.queue_by_recv(&recv).is_none());
        assert!(!state.is_second_address(&send));
    }

    #[test]
    fn a_challenge_is_single_use_and_scoped() {
        let mut state = state();
        let scope = [9u8; 32];
        let challenge = state.issue_challenge(2, &scope, 10_000);
        assert!(
            state
                .consume_challenge(&challenge, 2, &[8u8; 32], 1_000)
                .is_err(),
            "a stamp computed for one victim must not be spendable on another"
        );
        // …and the wrong-scope attempt still consumed it, which is what makes
        // a challenge single-use rather than single-*success*.
        let challenge = state.issue_challenge(2, &scope, 10_000);
        assert!(
            state
                .consume_challenge(&challenge, 2, &scope, 1_000)
                .is_ok()
        );
        assert!(
            state
                .consume_challenge(&challenge, 2, &scope, 1_000)
                .is_err()
        );
    }

    #[test]
    fn an_expired_challenge_is_refused() {
        let mut state = state();
        let challenge = state.issue_challenge(1, &[], 10_000);
        assert!(state.consume_challenge(&challenge, 1, &[], 10_001).is_err());
    }

    #[test]
    fn there_is_no_eviction_path() {
        // §13.2: the relay refuses new writes rather than deleting an
        // unacknowledged message. Asserted by admitting past the cap and
        // checking that nothing already stored moved.
        let mut state = state();
        let (recv, _) = state.create_queue(
            QueueKind::Standard,
            PublicKey::new([1u8; 32]),
            600,
            3_600,
            AppendQuota {
                max_messages: 1,
                max_bytes: 64 * 1024,
            },
            1_000,
        );
        state
            .append(&recv, Payload::new(vec![0u8; 1024]).unwrap(), 1_000)
            .unwrap();
        assert!(state.admit(&recv, 1024, PolicyFaults::default()).is_err());
        assert_eq!(
            state.queue_by_recv(&recv).map(|queue| queue.messages.len()),
            Some(1)
        );
    }
}
