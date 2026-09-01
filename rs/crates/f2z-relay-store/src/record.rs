//! The values that cross the storage boundary: addresses, keys, byte strings
//! and counters. No frames, no commands, no request ids.
//!
//! Every type here is deliberately made of [`f2z_codec`] newtypes rather than
//! of `[u8; 32]` and `Vec<u8>`, and the reason is `Debug`. A derived `Debug`
//! delegates to its fields', so a record built from raw byte arrays would
//! render every address and every byte of ciphertext the first time anyone
//! logged one — and it would do it in **decimal**, which is the trap
//! `f2z-codec`'s own redaction tests are written around: `tls_codec`'s byte
//! vectors print `[222, 222, …]`, a complete dump containing no hex at all, so
//! a hex-only check passes while everything leaks. Building on the redacting
//! newtypes makes the property structural instead of remembered.

use f2z_codec::types::{KeyPackage, Payload, PublicKey, QueueAddress};
use f2z_relay_proto::queue::{AppendQuota, QueueKind, QueueState};

/// What `CREATE_QUEUE` (§6.2) or `CREATE_CONTACT_QUEUE` (§12.2) asks the store
/// to write down.
///
/// **The store does not choose the addresses.** §7.1 requires the relay to
/// generate both from its own CSPRNG, and randomness is not this crate's job:
/// a store with a CSPRNG is a store that can be asked to produce a *predictable*
/// address by a caller that gets its seeding wrong, and the collision retry
/// §7.1 describes belongs next to the generator. The caller draws;
/// [`StoreError::AddressCollision`] tells it to draw again.
///
/// [`StoreError::AddressCollision`]: crate::StoreError::AddressCollision
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QueueSpec {
    /// Standard, or the contact queue of §12.2 whose send side is never
    /// bindable.
    pub kind: QueueKind,
    /// The address that authorizes `SUBSCRIBE`, `READ`, `ACK` and
    /// `DELETE_QUEUE`.
    pub recv_addr: QueueAddress,
    /// The address that authorizes `APPEND` — or, on a contact queue, the
    /// published `contact_addr` that authorizes nothing and accepts
    /// `CONTACT_APPEND` from anyone with a stamp.
    pub send_addr: QueueAddress,
    /// The Ed25519 public key that authorizes the receive side. §6.2 makes
    /// `CREATE_QUEUE` self-authenticating by requiring the signer to be this
    /// key; the store records it and never learns anything else about its
    /// holder.
    pub recv_key: PublicKey,
    /// The **granted** message TTL, after §7.7's clamping. The store applies
    /// it; it does not decide it.
    pub message_ttl_seconds: u32,
    /// The **granted** idle TTL, after §7.7's clamping.
    pub idle_ttl_seconds: u32,
    /// §13.1 layer 2's per-queue caps, or §12.3's contact-queue caps.
    pub quota: AppendQuota,
    /// `CreateQueueResponse.created_at_ms`, and the initial activity stamp from
    /// which the idle TTL runs.
    pub created_at_ms: u64,
}

/// A queue as the store holds it.
///
/// There is no `deleted` field and there will not be one. §7.6: a relay "MUST
/// NOT retain a tombstone that distinguishes deleted from never existed in any
/// externally observable way", so a deleted queue is a row that is gone.
#[derive(Clone, Debug)]
pub struct QueueRecord {
    /// The receive address.
    pub recv_addr: QueueAddress,
    /// The send address, or a contact queue's published `contact_addr`.
    pub send_addr: QueueAddress,
    /// The authorization and acknowledgement state, owned by
    /// [`f2z_relay_proto`] so that §8's arithmetic exists once in the system.
    pub state: QueueState,
    /// The granted message TTL (§7.7).
    pub message_ttl_seconds: u32,
    /// The granted idle TTL (§7.7).
    pub idle_ttl_seconds: u32,
    /// The per-queue caps this queue is admitted against.
    pub quota: AppendQuota,
    /// Messages currently stored — **not** the same as
    /// [`QueueState::pending`], which counts unacknowledged *indices* and is an
    /// upper bound: TTL expiry (§7.7) removes messages without moving the
    /// watermark.
    pub stored_messages: u64,
    /// Bytes of payload currently stored. Judged against
    /// [`AppendQuota::max_bytes`].
    pub stored_bytes: u64,
    /// When `CREATE_QUEUE` returned.
    pub created_at_ms: u64,
    /// The last successful `APPEND`, `READ`, `ACK` or `SUBSCRIBE` (§7.7's idle
    /// TTL resets on all four).
    pub last_activity_ms: u64,
}

impl QueueRecord {
    /// Standard or contact.
    #[must_use]
    pub const fn kind(&self) -> QueueKind {
        self.state.kind()
    }

    /// When the idle TTL will retire this queue if nothing else happens.
    ///
    /// Saturating rather than wrapping, so an operator's absurd idle TTL means
    /// "effectively never" instead of "immediately".
    #[must_use]
    pub const fn idle_expires_at_ms(&self) -> u64 {
        idle_deadline(self.last_activity_ms, self.idle_ttl_seconds)
    }
}

/// §7.7's idle deadline, computed the one way.
pub(crate) const fn idle_deadline(last_activity_ms: u64, idle_ttl_seconds: u32) -> u64 {
    last_activity_ms.saturating_add((idle_ttl_seconds as u64).saturating_mul(1_000))
}

/// §7.7's per-message deadline, computed the one way.
pub(crate) const fn message_deadline(received_at_ms: u64, message_ttl_seconds: u32) -> u64 {
    received_at_ms.saturating_add((message_ttl_seconds as u64).saturating_mul(1_000))
}

/// How a writer proves it may append (§6.3, §12.2).
///
/// The distinction is not decoration: `APPEND` on a contact address and
/// `CONTACT_APPEND` on an ordinary send address are both refusals, and both
/// collapse to `ERR_UNAVAILABLE` because a writer must not learn which kind of
/// queue an address is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendAuth {
    /// `APPEND` (§6.3): the caller has verified a signature by this key. The
    /// store checks it against the bound send key.
    Signed(PublicKey),
    /// `CONTACT_APPEND` (§12.2): unsigned. The caller has already verified the
    /// proof-of-work stamp against a relay-issued, single-use, expiring
    /// challenge scoped to this `contact_addr` (§13.1) — the store neither
    /// hashes nor issues challenges, and this variant asserts that the check
    /// happened.
    ContactStamp,
}

/// One append, as handed to [`RelayStore::append_batch`].
///
/// [`RelayStore::append_batch`]: crate::RelayStore::append_batch
#[derive(Clone, Copy, Debug)]
pub struct Append<'a> {
    /// The address the writer presented.
    pub send_addr: QueueAddress,
    /// How it proved it may write.
    pub auth: SendAuth,
    /// The ciphertext. The caller has already checked its length against the
    /// relay's published `padding_sizes` (§9); the store stores bytes and does
    /// not have a bucket list.
    pub payload: &'a Payload,
    /// The relay's clock at acceptance. Becomes `QueuedMessage.received_at_ms`
    /// and starts the message TTL.
    pub received_at_ms: u64,
}

/// What an accepted append produced.
///
/// **None of this may be sent to the writer.** §6.3: `APPEND`'s response body
/// "carries no index, no queue depth, no timestamp and no queue state of any
/// kind", because an index tells the sender how many messages the queue has
/// ever held and a timestamp gives it a clock to correlate against. These
/// fields exist for the `MSG` push (§6.4), which goes only to a subscribed
/// **reader**.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Appended {
    /// The queue the send address resolved to. The reader's address — the
    /// pairing §6.2 admits the relay necessarily holds.
    pub recv_addr: QueueAddress,
    /// The index assigned.
    pub index: u64,
    /// The stamp recorded.
    pub received_at_ms: u64,
}

/// A `READ` window (§6.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReadWindow {
    /// `ReadRequest.from_index`. Below the acked watermark it is silently
    /// raised to the watermark: §6.2 requires that a relay "MUST NOT resurrect
    /// deleted messages and MUST NOT error", so a client recovering from a
    /// crash can ask for everything it might have missed.
    pub from_index: u64,
    /// `ReadRequest.max_messages`.
    pub max_messages: u16,
    /// `ReadRequest.max_bytes`, counted over payload bytes.
    pub max_bytes: u32,
}

/// One stored message, as `READ` and the `MSG` push carry it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredMessage {
    /// `QueuedMessage.index`.
    pub index: u64,
    /// `QueuedMessage.received_at_ms`.
    pub received_at_ms: u64,
    /// `QueuedMessage.payload`.
    pub payload: Payload,
}

/// A page of `READ` results.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadPage {
    /// The messages, in ascending index order.
    pub messages: Vec<StoredMessage>,
    /// `ReadResponse.has_more`.
    pub has_more: bool,
    /// `SubscribeResponse.next_index` / `AckResponse.next_index`, so a caller
    /// that just read does not need a second round trip to learn it.
    pub next_index: u64,
    /// Unacknowledged indices — the `pending` §6.2 discloses to the **reader
    /// only**. No equivalent is ever disclosed to a writer.
    pub pending: u64,
}

/// What `DELETE_QUEUE` removed (§6.2, §7.6).
///
/// Returned so the caller can subtract from whatever it is watching for §13.1
/// layer 4 without re-querying. It is **not** sent to anyone: `DELETE_QUEUE`'s
/// response is empty, and the sender "learns nothing except that its next
/// `APPEND` fails with `ERR_UNAVAILABLE`".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Deleted {
    /// Messages destroyed, acknowledged or not.
    pub messages_deleted: u64,
    /// Payload bytes freed.
    pub bytes_freed: u64,
}

/// Why a queue or a message went away on its own (§7.7).
///
/// Both surface to a subscribed reader as `QUEUE_EVENT` (§6.4) and both are
/// silent to a writer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExpiryReason {
    /// `QUEUE_EVENT` reason `2`: the queue itself is gone, nothing having
    /// touched it for `idle_ttl_seconds`. §7.7 states the cost plainly — a user
    /// offline longer than the idle TTL loses their queues and the pair must
    /// re-establish.
    IdleTtl,
    /// `QUEUE_EVENT` reason `3`: the queue survives; messages older than
    /// `message_ttl_seconds` were dropped. §13.2's one permitted deletion that
    /// is not a refusal.
    MessageTtl,
}

impl ExpiryReason {
    /// The `uint8` a `QUEUE_EVENT` push carries (§6.4).
    #[must_use]
    pub const fn queue_event_reason(self) -> u8 {
        match self {
            Self::IdleTtl => 2,
            Self::MessageTtl => 3,
        }
    }
}

/// One queue affected by a sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QueueExpiry {
    /// The reader's address, which is who a `QUEUE_EVENT` is pushed to.
    pub recv_addr: QueueAddress,
    /// Which timer fired.
    pub reason: ExpiryReason,
    /// Messages removed from this queue.
    pub messages_expired: u64,
    /// Payload bytes freed from this queue.
    pub bytes_freed: u64,
}

/// What one sweep did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExpiryReport {
    /// One entry per affected queue, so the caller can push `QUEUE_EVENT` to
    /// whichever of them has a live subscription.
    pub expired: Vec<QueueExpiry>,
    /// Queues removed outright by the idle timer.
    pub queues_expired: u64,
    /// Messages removed by either timer.
    pub messages_expired: u64,
    /// Payload bytes freed by either timer.
    pub bytes_freed: u64,
}

impl ExpiryReport {
    /// Whether the sweep changed anything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.expired.is_empty()
    }
}

/// What the store is currently holding — §13.1 layer 4's input.
///
/// Layer 4 refuses `CREATE_QUEUE` first, then `APPEND`, then new connections,
/// and never refuses `READ`, `ACK` or `DELETE_QUEUE`, "because they are the
/// operations that make the relay smaller and refusing them under load is a
/// deadlock". Deciding that needs a measurement, and this is it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StoreStats {
    /// Standard queues.
    pub queues: u64,
    /// Contact queues (§12.2), counted separately because their caps and their
    /// abuse profile are separate (§12.3).
    pub contact_queues: u64,
    /// Messages held across every queue.
    pub messages: u64,
    /// Payload bytes held across every queue. ADR 0005's economics are stated
    /// in this number: ~4 MB per 1,000 DAU, because there is no archive.
    pub payload_bytes: u64,
    /// Bytes the storage engine has actually allocated, which is the number an
    /// operator's high-water mark is really about — page overhead, free pages
    /// and the write-ahead log are all real disk.
    pub storage_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadlines_saturate_instead_of_wrapping() {
        assert_eq!(idle_deadline(1_000, 1), 2_000);
        assert_eq!(idle_deadline(u64::MAX, 1), u64::MAX);
        assert_eq!(message_deadline(0, u32::MAX), 4_294_967_295_000);
    }

    #[test]
    fn queue_event_reasons_are_section_6_4s() {
        assert_eq!(ExpiryReason::IdleTtl.queue_event_reason(), 2);
        assert_eq!(ExpiryReason::MessageTtl.queue_event_reason(), 3);
    }
}

/// What a contact queue's key-package pool holds after a publish (§12.6).
///
/// Reported to the **owner** only, and only in the response to a command that
/// owner signed. §6.3's rule that a response must carry no queue state is about
/// a *sender* escalating into a reader; it does not apply to a device asking
/// after its own pool, and there is no other way for one to know when to refill.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyPackagePool {
    /// Single-use packages held.
    pub pool_size: u32,
    /// Whether a package of last resort is stored.
    pub has_last_resort: bool,
}

/// One package handed to a claimer (§12.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimedKeyPackage {
    /// The package. Consumed if it came from the pool.
    pub key_package: KeyPackage,
    /// Whether this is the reusable package of last resort, which is to say
    /// whether the pool was empty.
    pub last_resort: bool,
}
