//! The storage boundary.
//!
//! # What the boundary is for
//!
//! Every method below takes addresses, keys, byte strings and integers. None
//! takes a frame, a command code, a request id or a signature. That is the
//! whole design: a storage backend that cannot see a frame cannot decide to
//! answer one, cannot grow a fast path that skips a check, and cannot become a
//! second, divergent implementation of `WIRE.md` living underneath the first.
//!
//! The rules that *are* here are the ones that must be applied inside the same
//! transaction as the write they guard, because applying them outside it is a
//! race:
//!
//! - **Authorization** (§5.1 step 5, §6.2, §6.3). The caller verifies the
//!   signature; the store compares the recovered signer against the key
//!   registered for the address, atomically with the mutation. Checking it a
//!   statement earlier would let a `DELETE_QUEUE` land in between.
//! - **Quota admission** (§13.1 layer 2). "Is there room" and "take the room"
//!   are one decision or they are neither.
//! - **Index allocation and the acknowledgement watermark** (§8). Two
//!   concurrent appends must not be handed the same index, and a range delete
//!   must not run against a watermark that has since moved.
//!
//! # Group commit is a requirement, not an optimization
//!
//! [`SqliteStore`] runs `synchronous = FULL`, so a transaction costs an fsync,
//! and a commodity VPS's disk does on the order of 50-200 of those a second.
//! One transaction per append therefore caps the relay at roughly one append
//! per fsync — a ceiling low enough that the design does not work.
//!
//! [`RelayStore::append_batch`] is the answer, and it is the *primitive* rather
//! than a convenience wrapper: N appends collected over a small window commit
//! together, cost one fsync between them, and every one of them is durable
//! before any result is returned. The window itself — how long to wait, how
//! many to gather — is a scheduling decision that belongs to the server crate
//! with its runtime and its clock. What belongs here is the shape that makes
//! the decision available, and [`RelayStore::append`] is the batch of one.
//!
//! Batching does not weaken durability, and the distinction matters because
//! §11.1 publishes it: deferring the fsync past the response is `batched`;
//! amortizing one fsync across many responses that all wait for it is still
//! `fsync-per-append`.
//!
//! [`SqliteStore`]: crate::SqliteStore

use f2z_codec::types::{PublicKey, QueueAddress};
use f2z_relay_proto::queue::AckOutcome;

use crate::durability::{Committed, Durability};
use crate::error::Result;
use crate::record::{
    Append, Appended, Deleted, ExpiryReport, QueueRecord, QueueSpec, ReadPage, ReadWindow,
    SendAuth, StoreStats,
};

/// Queue storage for a relay.
///
/// See the module documentation for what this boundary refuses to carry and
/// why. Implementations live in this crate only: every mutating method returns
/// a [`Committed`], whose constructor is crate-private, so durability is
/// something the code that performed the fsync hands out rather than something
/// a backend asserts about itself.
pub trait RelayStore {
    /// What this store's [`Committed`] means — `WIRE.md` §11.1's
    /// `durability_mode`. A relay MUST publish this value.
    fn durability(&self) -> Durability;

    /// Create a queue at caller-chosen addresses (§7.1, §12.2).
    ///
    /// # Errors
    ///
    /// - [`StoreError::AddressCollision`] if either address is in use. §7.1's
    ///   answer is to draw again from the relay's CSPRNG.
    /// - [`StoreError::Backend`] on storage failure.
    ///
    /// [`StoreError::AddressCollision`]: crate::StoreError::AddressCollision
    /// [`StoreError::Backend`]: crate::StoreError::Backend
    fn create_queue(&self, spec: &QueueSpec) -> Result<Committed<QueueRecord>>;

    /// Bind the send side, once and forever (§7.3).
    ///
    /// **`signer` is the key that gets bound, and there is only one argument
    /// because there is only one key.** §5.1 step 5 — "the signer must be the
    /// key registered for the address" — is inapplicable to `BIND_SEND`, since
    /// no key is registered yet; `f2z-relay-proto` resolves that by requiring
    /// `signer_key == send_key`, without which §7.4's bind-once theft
    /// protection costs an attacker nothing (anyone could bind anyone's key).
    /// Taking the two as separate parameters here would make it possible to
    /// pass them differently.
    ///
    /// # Errors
    ///
    /// - `ERR_UNAVAILABLE` if there is no such send address. §6.3: absent and
    ///   present-but-refused must not be distinguishable to a writer.
    /// - `ERR_NOT_PERMITTED` on a contact address (§12.2), "always, for
    ///   everyone" — and deliberately *not* collapsed into `ERR_UNAVAILABLE`,
    ///   because a contact address is **published** in a directory entry and
    ///   therefore leaks no queue state that its finder did not already have.
    /// - `ERR_ALREADY_BOUND` if the send side is bound, with any key including
    ///   the same key. §7.4: to a client that just received a fresh advert this
    ///   is a loud, non-dismissible failure, not a retry.
    fn bind_send(
        &self,
        send_addr: &QueueAddress,
        signer: &PublicKey,
        now_ms: u64,
    ) -> Result<Committed<()>>;

    /// Look a queue up by its receive address and authorize the signer.
    ///
    /// # Errors
    ///
    /// `ERR_NO_ACCESS`, whether the address does not exist or exists and this
    /// signer does not authorize it. §10's existence-oracle rule: one code, so
    /// that sweeping the address space learns nothing.
    fn queue_by_recv(&self, recv_addr: &QueueAddress, signer: &PublicKey) -> Result<QueueRecord>;

    /// Look a queue up by its send address and authorize the writer.
    ///
    /// # Errors
    ///
    /// `ERR_UNAVAILABLE`, whether the address does not exist, is a contact
    /// address presented with a signature, is an ordinary address presented
    /// without one, or is bound to a different key (§6.3).
    fn queue_by_send(&self, send_addr: &QueueAddress, auth: &SendAuth) -> Result<QueueRecord>;

    /// Append a batch in one transaction, at the cost of one fsync (§6.3, §12.2).
    ///
    /// The outer result fails only if the *transaction* could not run. A
    /// per-append refusal — unknown address, wrong key, quota exhausted — is an
    /// `Err` in the returned vector at that append's position, and does not
    /// stop the others: one writer hitting its cap must not undo an unrelated
    /// queue's durable write. The vector is the same length as `appends` and in
    /// the same order.
    ///
    /// §13.2 is the rule this method must never break: **under no circumstance
    /// does a relay delete an unacknowledged message to make room.** A full
    /// queue refuses; it does not evict.
    ///
    /// # Errors
    ///
    /// [`StoreError::Backend`] if the transaction failed. Nothing in the batch
    /// was written in that case.
    ///
    /// [`StoreError::Backend`]: crate::StoreError::Backend
    fn append_batch(&self, appends: &[Append<'_>]) -> Result<Committed<Vec<Result<Appended>>>>;

    /// Append one message — the batch of one.
    ///
    /// # Errors
    ///
    /// Whatever [`RelayStore::append_batch`] would have put at position zero,
    /// or its transaction-level failure.
    fn append(&self, append: &Append<'_>) -> Result<Committed<Appended>> {
        let committed = self.append_batch(core::slice::from_ref(append))?;
        let durability = committed.durability();
        let mut results = committed.into_inner();
        let first = results.pop().unwrap_or_else(|| {
            Err(crate::StoreError::Corrupt(
                "append_batch returned no result for a batch of one",
            ))
        });
        Ok(Committed::seal(durability, first?))
    }

    /// Read a window of messages. Never mutates a message (§6.2).
    ///
    /// Returns no [`Committed`], because nothing durable happened: `READ` is
    /// the operation delete-on-ack is careful *not* to couple to deletion.
    /// It does record activity against §7.7's idle timer, which is best-effort
    /// by design — see [`RelayStore::touch`].
    ///
    /// # Errors
    ///
    /// `ERR_NO_ACCESS` if the address does not exist or this signer does not
    /// authorize it.
    fn read(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        window: ReadWindow,
        now_ms: u64,
    ) -> Result<ReadPage>;

    /// Acknowledge cumulatively, and delete what that authorizes (§8).
    ///
    /// The watermark advance and the range delete are one transaction. That is
    /// the crash-safety invariant this crate is tested against: after any
    /// crash, there is no index at or below the persisted watermark whose
    /// message is still stored, and no message above it that has been removed.
    ///
    /// # Errors
    ///
    /// - `ERR_NO_ACCESS` if the address does not exist or this signer does not
    ///   authorize it.
    /// - `ERR_ACK_TOO_HIGH` if `up_to_index` is above the highest index ever
    ///   appended (§8.2). The watermark does not move. Without this a reader
    ///   could pre-ack and black-hole its own queue while senders kept seeing
    ///   successful, empty `APPEND` responses.
    fn ack(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
        up_to_index: u64,
        now_ms: u64,
    ) -> Result<Committed<AckOutcome>>;

    /// Delete the queue, both addresses and every message it holds,
    /// acknowledged or not (§6.2, §7.6). Irreversible, and no tombstone.
    ///
    /// # Errors
    ///
    /// `ERR_NO_ACCESS` if the address does not exist or this signer does not
    /// authorize it — which is also what both addresses answer afterwards,
    /// forever.
    fn delete_queue(
        &self,
        recv_addr: &QueueAddress,
        signer: &PublicKey,
    ) -> Result<Committed<Deleted>>;

    /// Record activity against §7.7's idle timer without writing durably.
    ///
    /// §7.7 resets the idle TTL on `APPEND`, `READ`, `ACK` **and `SUBSCRIBE`*,
    /// and `SUBSCRIBE` is otherwise a pure connection-scoped registration. This
    /// is the method for it.
    ///
    /// **Best-effort on purpose.** The idle TTL defaults to 90 days; fsyncing
    /// every `SUBSCRIBE` and every `READ` to move a 90-day deadline would spend
    /// the relay's entire fsync budget on a timer whose resolution is months.
    /// A crash can therefore lose activity recorded since the last durable
    /// write, which ages a queue's idle deadline by at most that interval — and
    /// [`RelayStore::expire`] flushes pending activity before it sweeps, so the
    /// exposure is bounded by the sweep period rather than by uptime.
    ///
    /// # Errors
    ///
    /// `ERR_NO_ACCESS` if the address does not exist or this signer does not
    /// authorize it.
    fn touch(&self, recv_addr: &QueueAddress, signer: &PublicKey, now_ms: u64) -> Result<()>;

    /// Run both of §7.7's timers.
    ///
    /// Idle-expired queues go first and go entirely; then messages past their
    /// per-message TTL are dropped from whatever remains. Message expiry does
    /// **not** move the acknowledgement watermark: an expired message was never
    /// acknowledged, and moving the watermark would acknowledge it on the
    /// reader's behalf.
    ///
    /// The report names every affected queue so the caller can push
    /// `QUEUE_EVENT` (§6.4) to whichever of them a reader is subscribed to.
    /// Expiry is silent to a writer.
    ///
    /// # Errors
    ///
    /// [`StoreError::Backend`] on storage failure.
    ///
    /// [`StoreError::Backend`]: crate::StoreError::Backend
    fn expire(&self, now_ms: u64) -> Result<Committed<ExpiryReport>>;

    /// What the store is holding — §13.1 layer 4's input.
    ///
    /// # Errors
    ///
    /// [`StoreError::Backend`] on storage failure.
    ///
    /// [`StoreError::Backend`]: crate::StoreError::Backend
    fn stats(&self) -> Result<StoreStats>;
}
