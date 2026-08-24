//! Queue lifecycle — `WIRE.md` §7, §8 and §12.2 — as pure functions.
//!
//! Nothing here stores a message, reads a clock or allocates an address. What
//! it holds is the part of a queue that is a *rule*: which key authorizes which
//! side, that binding happens once and never again, and the acknowledgement
//! arithmetic that decides when ciphertext is destroyed.
//!
//! Three of those rules are the ones that lose messages when they are wrong,
//! and each is stated here next to its test:
//!
//! - **Bind-once** (§7.3). There is no rebind, no unbind, and no reset by the
//!   recv key. A queue whose send side is bound to the wrong key is dead and is
//!   replaced (§7.5). Letting the recv key rebind was rejected because it turns
//!   the recv key — the one that can drain the queue — into a control over the
//!   send side as well.
//! - **Cumulative, monotone, idempotent acknowledgement** (§8.1, §8.3). An
//!   `ACK` below the watermark is accepted and does nothing; the watermark
//!   never moves backwards; a retry after a lost response is safe, which is
//!   what makes the connection-loss case tractable at all.
//! - **No pre-acking** (§8.2). `up_to_index` above the highest index ever
//!   appended is `ERR_ACK_TOO_HIGH`. Without that rule a reader could set the
//!   watermark to a huge value and every future `APPEND` would be deleted the
//!   instant it landed, while the sender kept receiving successful, empty
//!   `APPEND` responses — a device black-holing its own queue silently and
//!   indefinitely, indistinguishable from being offline.
//!
//! # What this deliberately does not model
//!
//! TTL expiry (§7.7) removes stored messages **without moving the watermark**,
//! so `pending` as computed here is the number of unacknowledged *indices*,
//! which is an upper bound on the number of messages actually held. A relay
//! that expires messages MUST answer `SUBSCRIBE` and `ACK` from its storage,
//! not from this count. Saying so is better than modelling storage in a crate
//! that has none.

use alloc::string::String;
use alloc::vec::Vec;

use f2z_codec::ErrorCode;
use f2z_codec::types::{PublicKey, QueueAddress, RelayId};

use crate::error::{ProtoError, Result};
use crate::key::keys_equal;

/// §7.7's message-TTL ceiling: 30 days. A relay MUST NOT grant more.
pub const MAX_MESSAGE_TTL_SECONDS: u32 = f2z_codec::MAX_MESSAGE_TTL_SECONDS;

/// §7.7's default message TTL: 7 days.
pub const DEFAULT_MESSAGE_TTL_SECONDS: u32 = 604_800;

/// §7.7's idle-TTL ceiling: 365 days.
pub const MAX_IDLE_TTL_SECONDS: u32 = 31_536_000;

/// §7.7's default idle TTL: 90 days.
pub const DEFAULT_IDLE_TTL_SECONDS: u32 = 7_776_000;

/// Which flavour of queue this is (§12.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueKind {
    /// An ordinary queue: two addresses, the send side bindable exactly once.
    Standard,
    /// A contact queue. Its send side is **never** bound, it accepts unsigned
    /// appends from anyone with a valid stamp, its address is published in the
    /// owner's directory entry, and it is hard-capped because of all three.
    Contact,
}

/// A queue's authorization and acknowledgement state.
///
/// Deletion is not a state. §7.6 requires that a relay "MUST NOT retain a
/// tombstone that distinguishes deleted from never existed in any externally
/// observable way", so a deleted queue is one that no longer exists — dropping
/// the value is the model, and adding a `deleted` flag would be modelling the
/// thing the specification forbids.
#[derive(Clone, Debug)]
pub struct QueueState {
    kind: QueueKind,
    recv_key: PublicKey,
    send_key: Option<PublicKey>,
    next_index: u64,
    acked_through: Option<u64>,
}

impl QueueState {
    /// A fresh queue, created by the recipient (§7.1).
    ///
    /// The send side of a standard queue starts **unbound**: no key authorizes
    /// `APPEND` until the peer that received the advert calls `BIND_SEND`.
    #[must_use]
    pub const fn create(kind: QueueKind, recv_key: PublicKey) -> Self {
        Self {
            kind,
            recv_key,
            send_key: None,
            next_index: 0,
            acked_through: None,
        }
    }

    /// Rehydrate a queue whose state was written down somewhere and read back.
    ///
    /// A relay's storage outlives its process, so the acknowledgement
    /// arithmetic of §8 has to be applied to state that was loaded rather than
    /// accumulated. Without this constructor a store would have to re-derive
    /// that arithmetic against its own persisted columns, which is the one
    /// duplication this crate exists to prevent: §8.2's anti-pre-ack rule
    /// implemented twice is §8.2's rule implemented once and violated once.
    ///
    /// The arguments are exactly the fields [`QueueState`] persists, and the
    /// checks below are the invariants a store cannot restore its way out of.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Internal`] — and it is deliberately that code rather than
    /// anything a peer could provoke. Every rejection here means the relay's
    /// own storage contradicts the protocol, which is a relay fault; §10 says
    /// `ERR_INTERNAL` "carries no detail, ever", and there is nothing a client
    /// did that a more specific code would describe.
    ///
    /// - A contact queue with a bound send key. §12.2: a contact queue's send
    ///   side is **never** bound, "always, for everyone".
    /// - `acked_through >= next_index`, i.e. a watermark at or above the index
    ///   the next append will take. That is the pre-acked state §8.2 exists to
    ///   make unreachable, and restoring into it would black-hole the queue.
    pub fn restore(
        kind: QueueKind,
        recv_key: PublicKey,
        send_key: Option<PublicKey>,
        next_index: u64,
        acked_through: Option<u64>,
    ) -> Result<Self> {
        if matches!(kind, QueueKind::Contact) && send_key.is_some() {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        if let Some(watermark) = acked_through
            && watermark >= next_index
        {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        Ok(Self {
            kind,
            recv_key,
            send_key,
            next_index,
            acked_through,
        })
    }

    /// Standard or contact.
    #[must_use]
    pub const fn kind(&self) -> QueueKind {
        self.kind
    }

    /// The key that authorizes `SUBSCRIBE`, `READ`, `ACK` and `DELETE_QUEUE`.
    #[must_use]
    pub const fn recv_key(&self) -> PublicKey {
        self.recv_key
    }

    /// The bound send key, if `BIND_SEND` has succeeded.
    #[must_use]
    pub const fn send_key(&self) -> Option<PublicKey> {
        self.send_key
    }

    /// Whether the send side is bound.
    #[must_use]
    pub const fn is_bound(&self) -> bool {
        self.send_key.is_some()
    }

    /// The index the next appended message will receive.
    ///
    /// Indices start at zero and only ever increase, as `WIRE.md` §6.2 now
    /// states. `next_index == 0` is the unambiguous sentinel for “nothing has
    /// ever been appended”.
    #[must_use]
    pub const fn next_index(&self) -> u64 {
        self.next_index
    }

    /// The acknowledgement watermark: the highest index acknowledged, if any.
    #[must_use]
    pub const fn acked_through(&self) -> Option<u64> {
        self.acked_through
    }

    /// The lowest index that has not been acknowledged.
    #[must_use]
    pub const fn first_unacked(&self) -> u64 {
        match self.acked_through {
            Some(watermark) => watermark.saturating_add(1),
            None => 0,
        }
    }

    /// The number of unacknowledged indices — §6.2's `pending`, as an upper
    /// bound (see the module note on TTL expiry).
    #[must_use]
    pub const fn pending(&self) -> u64 {
        self.next_index.saturating_sub(self.first_unacked())
    }

    /// Check a receive-side signer against the registered key (§5.1 step 5).
    ///
    /// # Errors
    ///
    /// [`ErrorCode::NoAccess`] — the same code an address that never existed
    /// gets. §10's existence-oracle rule requires that: if the two differed,
    /// the relay would tell an attacker sweeping the address space which
    /// 32-byte values are live queues.
    pub fn authorize_recv(&self, signer: &PublicKey) -> Result<()> {
        if keys_equal(&self.recv_key, signer) {
            Ok(())
        } else {
            Err(ProtoError::Wire(ErrorCode::NoAccess))
        }
    }

    /// Check a send-side signer against the bound key.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Unavailable`], always — never a distinguishable code.
    /// §6.3: "every send-side refusal that would distinguish queue state
    /// collapses to the single code `ERR_UNAVAILABLE`", because if "queue full"
    /// and "no such queue" differed, a bound sender could learn the queue's
    /// state by filling it. An unbound send side and a wrong key are both
    /// refusals a sender must not be able to tell apart from a full queue.
    pub fn authorize_send(&self, signer: &PublicKey) -> Result<()> {
        match self.send_key {
            Some(bound) if keys_equal(&bound, signer) => Ok(()),
            _ => Err(ProtoError::Wire(ErrorCode::Unavailable)),
        }
    }

    /// Bind the send side, once and forever (§7.3).
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::NotPermitted`] on a contact queue. §12.2: `BIND_SEND` on
    ///   a contact address returns this "always, for everyone" — there is no
    ///   key that authorizes writing to it, which means there is no key that
    ///   can be stolen, squatted or lost.
    /// - [`ErrorCode::AlreadyBound`] if the send side is already bound, **with
    ///   any key, including the same key**. §7.4 is explicit about what this
    ///   code means to a client that has just received a fresh advert: a loud,
    ///   non-dismissible failure, because the most likely cause is that the
    ///   relay operator read `send_addr` out of its own database and bound
    ///   first. This does not prevent the theft; it makes it noisy.
    pub fn bind_send(&mut self, send_key: &PublicKey) -> Result<()> {
        if matches!(self.kind, QueueKind::Contact) {
            return Err(ProtoError::Wire(ErrorCode::NotPermitted));
        }
        if self.send_key.is_some() {
            return Err(ProtoError::Wire(ErrorCode::AlreadyBound));
        }
        self.send_key = Some(*send_key);
        Ok(())
    }

    /// Take the next index for an accepted append.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Unavailable`] if the index space is exhausted — a send-side
    /// refusal like every other.
    pub fn append(&mut self) -> Result<u64> {
        let index = self.next_index;
        self.next_index = self
            .next_index
            .checked_add(1)
            .ok_or(ProtoError::Wire(ErrorCode::Unavailable))?;
        Ok(index)
    }

    /// Where a `READ` actually starts (§6.2).
    ///
    /// "`from_index` below the current acked watermark returns from the
    /// watermark; the relay MUST NOT resurrect deleted messages and MUST NOT
    /// error", so that a client recovering from a crash can simply ask for
    /// everything it might have missed. Note that this is not an error path: a
    /// `READ` from zero on a fully drained queue is a legitimate, successful,
    /// empty read.
    #[must_use]
    pub const fn read_from(&self, from_index: u64) -> u64 {
        let floor = self.first_unacked();
        if from_index < floor {
            floor
        } else {
            from_index
        }
    }

    /// Apply an `ACK` (§8).
    ///
    /// # Errors
    ///
    /// [`ErrorCode::AckTooHigh`] if `up_to_index` is above the highest index
    /// ever appended — §8.2's anti-pre-ack rule. The watermark does not move.
    pub fn ack(&mut self, up_to_index: u64) -> Result<AckOutcome> {
        // "Ever appended" is the whole point: the bound is `next_index`, which
        // never decreases, not the set of messages currently stored. Comparing
        // against what is stored would let a reader ack past the end of a queue
        // it had just drained.
        let highest = match self.next_index.checked_sub(1) {
            Some(highest) => highest,
            // Nothing has ever been appended, so no index exists to acknowledge.
            None => return Err(ProtoError::Wire(ErrorCode::AckTooHigh)),
        };
        if up_to_index > highest {
            return Err(ProtoError::Wire(ErrorCode::AckTooHigh));
        }

        let previous = self.acked_through;
        let advanced = match previous {
            // Monotone: below the watermark is accepted and is a no-op.
            Some(watermark) if up_to_index <= watermark => 0,
            Some(watermark) => up_to_index.saturating_sub(watermark),
            None => up_to_index.saturating_add(1),
        };
        if advanced > 0 {
            self.acked_through = Some(up_to_index);
        }

        Ok(AckOutcome {
            acknowledged: advanced,
            next_index: self.next_index,
            pending: self.pending(),
        })
    }
}

/// What an `ACK` did.
///
/// `acknowledged` is zero for the idempotent case — a retry after a lost
/// response, or a replay (§5.6 lists `ACK` as a no-op for exactly this reason).
/// It counts index-space advancement, not stored rows: TTL expiry may already
/// have removed some of those rows. A relay deletes every stored message at or
/// below the accepted watermark and nothing above it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AckOutcome {
    /// How many indices the watermark advanced by.
    pub acknowledged: u64,
    /// `AckResponse.next_index`.
    pub next_index: u64,
    /// `AckResponse.pending`, as an index-space upper bound.
    pub pending: u64,
}

/// §7.7's two timers, with the clamps a relay publishes in §11.1.
///
/// Both are requested at creation, both are clamped by relay policy, and both
/// granted values are returned in the create response so the client knows what
/// it actually got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TtlPolicy {
    /// Lower clamp on a requested message TTL.
    pub min_message_ttl_seconds: u32,
    /// Upper clamp. MUST be <= [`MAX_MESSAGE_TTL_SECONDS`].
    pub max_message_ttl_seconds: u32,
    /// Granted when the client expresses no preference.
    pub default_message_ttl_seconds: u32,
    /// Lower clamp on a requested idle TTL.
    pub min_idle_ttl_seconds: u32,
    /// Upper clamp on a requested idle TTL.
    pub max_idle_ttl_seconds: u32,
    /// Granted when the client expresses no preference.
    pub default_idle_ttl_seconds: u32,
}

impl TtlPolicy {
    /// Grant a message TTL for a request (§7.7).
    ///
    /// **A requested value of zero means "no preference".** §7.7 has both a
    /// requested value and a published default and never says how the two meet;
    /// a TTL of zero seconds would mean a message expires before it is stored,
    /// which is not a policy any client can want, so zero is the only value
    /// free to carry the meaning. Stated as an interpretation, not a rule.
    ///
    /// The 30-day ceiling is applied last and unconditionally: a relay MUST NOT
    /// grant more than [`MAX_MESSAGE_TTL_SECONDS`] even if its own configured
    /// maximum says otherwise.
    #[must_use]
    pub const fn grant_message_ttl(&self, requested: u32) -> u32 {
        let granted = if requested == 0 {
            self.default_message_ttl_seconds
        } else {
            clamp(
                requested,
                self.min_message_ttl_seconds,
                self.max_message_ttl_seconds,
            )
        };
        if granted > MAX_MESSAGE_TTL_SECONDS {
            MAX_MESSAGE_TTL_SECONDS
        } else {
            granted
        }
    }

    /// Grant an idle TTL for a request (§7.7).
    ///
    /// Zero means "no preference", as for the message TTL.
    #[must_use]
    pub const fn grant_idle_ttl(&self, requested: u32) -> u32 {
        let granted = if requested == 0 {
            self.default_idle_ttl_seconds
        } else {
            clamp(
                requested,
                self.min_idle_ttl_seconds,
                self.max_idle_ttl_seconds,
            )
        };
        if granted > MAX_IDLE_TTL_SECONDS {
            MAX_IDLE_TTL_SECONDS
        } else {
            granted
        }
    }

    /// Whether the policy is self-consistent: each band ordered, each default
    /// inside its own band, and the message ceiling respected.
    #[must_use]
    pub const fn is_consistent(&self) -> bool {
        self.min_message_ttl_seconds <= self.default_message_ttl_seconds
            && self.default_message_ttl_seconds <= self.max_message_ttl_seconds
            && self.max_message_ttl_seconds <= MAX_MESSAGE_TTL_SECONDS
            && self.min_idle_ttl_seconds <= self.default_idle_ttl_seconds
            && self.default_idle_ttl_seconds <= self.max_idle_ttl_seconds
            && self.max_idle_ttl_seconds <= MAX_IDLE_TTL_SECONDS
    }
}

impl Default for TtlPolicy {
    /// §7.7's table.
    fn default() -> Self {
        Self {
            min_message_ttl_seconds: 60,
            max_message_ttl_seconds: MAX_MESSAGE_TTL_SECONDS,
            default_message_ttl_seconds: DEFAULT_MESSAGE_TTL_SECONDS,
            min_idle_ttl_seconds: 3_600,
            max_idle_ttl_seconds: MAX_IDLE_TTL_SECONDS,
            default_idle_ttl_seconds: DEFAULT_IDLE_TTL_SECONDS,
        }
    }
}

/// `u32::clamp` without the panic on an inverted range, which the workspace
/// lints forbid anywhere near the relay's request path.
const fn clamp(value: u32, low: u32, high: u32) -> u32 {
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

/// §13.1 layer 2's per-queue quotas, and §12.3's contact-queue caps — the same
/// shape, applied to the same decision.
///
/// This is a pure admission test over counters the relay keeps; nothing here
/// stores a message. The refusal is [`ErrorCode::Unavailable`] in both cases,
/// never a code that says which cap was hit (§6.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppendQuota {
    /// `max_queue_messages`, or `contact_max_pending` for a contact queue.
    pub max_messages: u64,
    /// `max_queue_bytes`, or `contact_max_bytes` for a contact queue.
    pub max_bytes: u64,
}

impl AppendQuota {
    /// Whether one more payload of `payload_bytes` fits.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Unavailable`]. §13.2 is the other half of this rule and it
    /// is not expressible as a return value: **under no circumstance does a
    /// relay delete an unacknowledged message to free space.** When it runs out
    /// of room it refuses new writes. Refusal is loud, immediate, and lands on
    /// the party that can do something about it; silently dropping an accepted
    /// message is quiet, delayed, and lands on someone who cannot.
    pub const fn admit(
        &self,
        stored_messages: u64,
        stored_bytes: u64,
        payload_bytes: u64,
    ) -> Result<()> {
        if stored_messages >= self.max_messages {
            return Err(ProtoError::Wire(ErrorCode::Unavailable));
        }
        match stored_bytes.checked_add(payload_bytes) {
            Some(total) if total <= self.max_bytes => Ok(()),
            _ => Err(ProtoError::Wire(ErrorCode::Unavailable)),
        }
    }
}

/// §12.3's contact-queue defaults: 64 pending messages, 256 KiB.
pub const CONTACT_QUOTA: AppendQuota = AppendQuota {
    max_messages: 64,
    max_bytes: 256 * 1024,
};

/// One relay's coordinates for one queue, as they travel inside a
/// `queue_advert` (§7.2).
///
/// `relay_id` travels with the address because §5.2 needs it: it is what lets
/// the sender detect that it is talking to a different relay than the one the
/// recipient chose. The identifying material comes from inside the
/// authenticated channel, never from the infrastructure being authenticated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueEndpoint {
    /// `wss://` URL of the relay (§2.1).
    pub relay_url: String,
    /// The relay identity this address is valid at (§5.2).
    pub relay_id: RelayId,
    /// The send address the peer may bind and then append to.
    pub send_addr: QueueAddress,
}

/// The in-band advert of §7.2, as a value.
///
/// **This type has no wire encoding, and that is deliberate.** §7.2 shows the
/// advert as an object with named fields and never gives it a `tls_codec`
/// structure, because a relay never sees one: it travels as an MLS
/// `PrivateMessage` inside the group, indistinguishable to the relay from any
/// other payload. Inventing an encoding here would be inventing protocol.
/// What the type is for is the *check* — carrying `(relay_url, relay_id,
/// send_addr)` from the group to [`crate::hello::verify_hello_response`], which
/// is where §5.2's substitution attack is actually caught.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueAdvert {
    /// One entry per relay, for ADR 0005's redundancy factor *k*.
    pub endpoints: Vec<QueueEndpoint>,
    /// The epoch from which the sender should use these addresses.
    pub valid_from_epoch: u64,
    /// The addresses this advert retires.
    pub replaces: Vec<QueueAddress>,
}

/// Where a rotation (§7.5) has got to.
///
/// There is no `ROTATE` command and there should not be one: rotation is
/// create, advertise, bind, drain, delete. The stages exist so the one ordering
/// constraint that can lose messages is checkable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RotationStage {
    /// Step 1: the replacement queue exists.
    Created,
    /// Step 2: the replacement was advertised in-band.
    Advertised,
    /// Steps 3-4: the peer has bound the new send address and switched to it at
    /// `valid_from_epoch`. The old queue is still readable and still being
    /// drained — a message in flight during the switch lands in the old queue
    /// and is read from it.
    Switched,
    /// Step 5: the old queue was deleted.
    Retired,
}

/// A queue rotation in progress (§7.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rotation {
    stage: RotationStage,
}

impl Rotation {
    /// Begin a rotation: the replacement queue has been created.
    #[must_use]
    pub const fn started() -> Self {
        Self {
            stage: RotationStage::Created,
        }
    }

    /// The current stage.
    #[must_use]
    pub const fn stage(self) -> RotationStage {
        self.stage
    }

    /// Advance to the next stage. Stages never go backwards.
    pub const fn advance(&mut self, stage: RotationStage) {
        if stage as u8 > self.stage as u8 {
            self.stage = stage;
        }
    }

    /// Whether the old queue may now be deleted.
    ///
    /// §7.5: "the old queue MUST remain readable until the recipient has
    /// drained it. The sender switches at `valid_from_epoch`; the recipient
    /// deletes only after the old queue is empty and acknowledged." Both halves
    /// are required — deleting a drained queue before the peer has switched
    /// destroys whatever it appends next, and deleting after the switch but
    /// before draining destroys what is already there.
    #[must_use]
    pub fn may_retire_old(self, old: &QueueState) -> bool {
        self.stage >= RotationStage::Switched && old.pending() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn key(byte: u8) -> PublicKey {
        PublicKey::new([byte; 32])
    }

    fn queue() -> QueueState {
        QueueState::create(QueueKind::Standard, key(1))
    }

    #[test]
    fn restore_round_trips_a_live_queue_and_refuses_the_impossible_ones() {
        let mut original = queue();
        original.bind_send(&key(2)).unwrap();
        original.append().unwrap();
        original.append().unwrap();
        original.ack(0).unwrap();

        let mut restored = QueueState::restore(
            original.kind(),
            original.recv_key(),
            original.send_key(),
            original.next_index(),
            original.acked_through(),
        )
        .unwrap();
        assert_eq!(restored.next_index(), original.next_index());
        assert_eq!(restored.acked_through(), original.acked_through());
        assert_eq!(restored.pending(), original.pending());
        assert_eq!(
            restored.bind_send(&key(9)),
            Err(ProtoError::Wire(ErrorCode::AlreadyBound)),
            "bind-once survives a restart; it is not a property of one process"
        );

        assert_eq!(
            QueueState::restore(QueueKind::Contact, key(1), Some(key(2)), 0, None)
                .err()
                .unwrap(),
            ProtoError::Wire(ErrorCode::Internal),
            "§12.2: a contact queue's send side is never bound"
        );
        assert!(
            QueueState::restore(QueueKind::Standard, key(1), None, 2, Some(2)).is_err(),
            "§8.2: a watermark at next_index is the pre-acked state itself"
        );
        assert!(
            QueueState::restore(QueueKind::Standard, key(1), None, 0, Some(0)).is_err(),
            "§8.2: nothing has ever been appended, so index 0 cannot be acked"
        );
        assert!(QueueState::restore(QueueKind::Standard, key(1), None, 1, Some(0)).is_ok());
    }

    #[test]
    fn binding_happens_once_and_never_again() {
        let mut queue = queue();
        assert!(!queue.is_bound());
        assert!(queue.bind_send(&key(2)).is_ok());
        assert_eq!(queue.send_key(), Some(key(2)));
        assert_eq!(
            queue.bind_send(&key(3)),
            Err(ProtoError::Wire(ErrorCode::AlreadyBound))
        );
        assert_eq!(
            queue.bind_send(&key(2)),
            Err(ProtoError::Wire(ErrorCode::AlreadyBound)),
            "§7.3: with any key, including the same key"
        );
        assert_eq!(queue.send_key(), Some(key(2)));
    }

    #[test]
    fn a_contact_queue_can_never_be_bound() {
        let mut contact = QueueState::create(QueueKind::Contact, key(1));
        assert_eq!(
            contact.bind_send(&key(2)),
            Err(ProtoError::Wire(ErrorCode::NotPermitted))
        );
        assert!(!contact.is_bound());
    }

    #[test]
    fn send_side_refusals_all_look_the_same() {
        let mut queue = queue();
        // Unbound.
        assert_eq!(
            queue.authorize_send(&key(2)),
            Err(ProtoError::Wire(ErrorCode::Unavailable))
        );
        queue.bind_send(&key(2)).unwrap();
        // Bound to someone else.
        assert_eq!(
            queue.authorize_send(&key(3)),
            Err(ProtoError::Wire(ErrorCode::Unavailable))
        );
        assert!(queue.authorize_send(&key(2)).is_ok());
    }

    #[test]
    fn the_recv_side_uses_the_existence_oracle_code() {
        let queue = queue();
        assert!(queue.authorize_recv(&key(1)).is_ok());
        assert_eq!(
            queue.authorize_recv(&key(2)),
            Err(ProtoError::Wire(ErrorCode::NoAccess))
        );
    }

    #[test]
    fn acking_before_anything_is_appended_is_too_high() {
        let mut queue = queue();
        assert_eq!(
            queue.ack(0),
            Err(ProtoError::Wire(ErrorCode::AckTooHigh)),
            "there is no index 0 until something is appended"
        );
        assert_eq!(queue.acked_through(), None);
    }

    #[test]
    fn acking_past_the_highest_appended_index_is_refused() {
        let mut queue = queue();
        assert_eq!(queue.append().unwrap(), 0);
        assert_eq!(queue.append().unwrap(), 1);
        assert_eq!(
            queue.ack(2),
            Err(ProtoError::Wire(ErrorCode::AckTooHigh)),
            "§8.2: pre-acking would black-hole every future append"
        );
        assert_eq!(queue.acked_through(), None, "the watermark does not move");
        assert!(queue.ack(1).is_ok());
    }

    #[test]
    fn acknowledgement_is_cumulative_monotone_and_idempotent() {
        let mut queue = queue();
        for _ in 0..5 {
            queue.append().unwrap();
        }
        let first = queue.ack(2).unwrap();
        assert_eq!(first.acknowledged, 3, "cumulative: 0, 1 and 2");
        assert_eq!(first.pending, 2);

        let repeat = queue.ack(2).unwrap();
        assert_eq!(repeat.acknowledged, 0, "idempotent");
        assert_eq!(queue.acked_through(), Some(2));

        let backwards = queue.ack(0).unwrap();
        assert_eq!(backwards.acknowledged, 0, "monotone");
        assert_eq!(queue.acked_through(), Some(2));

        let rest = queue.ack(4).unwrap();
        assert_eq!(rest.acknowledged, 2);
        assert_eq!(rest.pending, 0);
    }

    #[test]
    fn a_read_below_the_watermark_starts_at_the_watermark() {
        let mut queue = queue();
        for _ in 0..4 {
            queue.append().unwrap();
        }
        queue.ack(1).unwrap();
        assert_eq!(queue.read_from(0), 2, "never resurrect, never error");
        assert_eq!(queue.read_from(3), 3);
        assert_eq!(queue.first_unacked(), 2);
    }

    #[test]
    fn ttls_are_clamped_and_the_thirty_day_ceiling_is_absolute() {
        let policy = TtlPolicy::default();
        assert!(policy.is_consistent());
        assert_eq!(policy.grant_message_ttl(0), DEFAULT_MESSAGE_TTL_SECONDS);
        assert_eq!(policy.grant_message_ttl(1), 60);
        assert_eq!(policy.grant_message_ttl(86_400), 86_400);
        assert_eq!(
            policy.grant_message_ttl(u32::MAX),
            MAX_MESSAGE_TTL_SECONDS,
            "§7.7: a relay MUST NOT grant more than 30 days"
        );

        // Even a relay whose own configured maximum is too high is held to it.
        let greedy = TtlPolicy {
            max_message_ttl_seconds: u32::MAX,
            ..TtlPolicy::default()
        };
        assert!(!greedy.is_consistent());
        assert_eq!(greedy.grant_message_ttl(u32::MAX), MAX_MESSAGE_TTL_SECONDS);

        assert_eq!(policy.grant_idle_ttl(0), DEFAULT_IDLE_TTL_SECONDS);
        assert_eq!(policy.grant_idle_ttl(u32::MAX), MAX_IDLE_TTL_SECONDS);
    }

    #[test]
    fn quotas_refuse_rather_than_making_room() {
        let quota = CONTACT_QUOTA;
        assert!(quota.admit(0, 0, 1024).is_ok());
        assert!(quota.admit(63, 0, 1024).is_ok());
        assert_eq!(
            quota.admit(64, 0, 1024),
            Err(ProtoError::Wire(ErrorCode::Unavailable))
        );
        assert_eq!(
            quota.admit(0, 256 * 1024, 1),
            Err(ProtoError::Wire(ErrorCode::Unavailable))
        );
        assert_eq!(
            quota.admit(0, u64::MAX, 1),
            Err(ProtoError::Wire(ErrorCode::Unavailable)),
            "the byte total must not wrap into acceptance"
        );
    }

    #[test]
    fn the_old_queue_is_retired_only_after_the_switch_and_the_drain() {
        let mut old = queue();
        old.bind_send(&key(2)).unwrap();
        old.append().unwrap();

        let mut rotation = Rotation::started();
        assert!(!rotation.may_retire_old(&old));
        rotation.advance(RotationStage::Advertised);
        assert!(!rotation.may_retire_old(&old));
        rotation.advance(RotationStage::Switched);
        assert!(
            !rotation.may_retire_old(&old),
            "switched, but the old queue still holds a message"
        );
        old.ack(0).unwrap();
        assert!(rotation.may_retire_old(&old));

        // Stages never go backwards.
        rotation.advance(RotationStage::Created);
        assert_eq!(rotation.stage(), RotationStage::Switched);
    }

    #[test]
    fn an_advert_carries_the_relay_id_that_makes_section_5_2_checkable() {
        let advert = QueueAdvert {
            endpoints: vec![QueueEndpoint {
                relay_url: String::from("wss://relay.example/relay/v1"),
                relay_id: RelayId::new([9u8; 32]),
                send_addr: QueueAddress::new([8u8; 32]),
            }],
            valid_from_epoch: 42,
            replaces: vec![QueueAddress::new([7u8; 32])],
        };
        assert_eq!(advert.endpoints.len(), 1);
        assert_eq!(advert.replaces.len(), 1);
    }
}
