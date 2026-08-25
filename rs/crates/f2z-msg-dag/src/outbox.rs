//! The bounded-window plaintext outbox that makes §7's repair possible.
//!
//! # Why the sender has to keep the plaintext
//!
//! §7: "the sender re-encrypts the original plaintext under the *current* epoch
//! and replies `gap_response`. It does not replay old ciphertext, so repair
//! does not undermine forward secrecy."
//!
//! That sentence is the whole design and it is worth reading twice. Replaying
//! the original ciphertext would be trivial to implement and would quietly undo
//! MLS's forward secrecy: an old ciphertext is decryptable by whoever holds the
//! old epoch secrets, and the point of ratcheting is that nobody should still
//! be able to use them. Re-encrypting means the repaired copy is protected by
//! the *current* epoch's keys, exactly like a message sent today.
//!
//! The cost is that the sender must still have the plaintext. That is what this
//! type is, and it is bounded on both axes: a time window and a count.
//!
//! # The interaction with §8, which is a trade-off and not a bug
//!
//! §8.1 makes retention a per-user local choice, and §8.4 states the
//! consequence: "a short local TTL shortens the plaintext outbox window used
//! for gap repair (§7), which means some detected gaps become unrecoverable.
//! That is surfaced to the user as an explicit 'this message could not be
//! recovered' marker rather than a silent hole."
//!
//! So [`RepairOutcome::Unrecoverable`] is a first-class answer here, not an
//! error path. It carries *why*, because "I deleted it" and "I never had it"
//! are different facts about a peer and only one of them is about retention.
//! [`crate::dag::MessageDag::mark_unrecoverable`] is where it lands on the
//! requester's side.
//!
//! # No clock
//!
//! Every method that depends on time takes `now_ms`. The crate reads no clock,
//! which is what makes an expiry test a test rather than a wait, and what lets
//! this compile for `wasm32-unknown-unknown`.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::fmt;

use crate::message::MsgId;

/// Why a message cannot be repaired.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum Unrecoverable {
    /// The outbox window elapsed and the plaintext was dropped. §8.4's case:
    /// the person who chose the short TTL made this trade-off.
    WindowExpired,
    /// The outbox was full and this entry was evicted to make room for newer
    /// ones.
    Evicted,
    /// This device never held that message. Either it was not the sender, or
    /// the requester is asking for something that does not exist.
    NeverHeld,
}

impl fmt::Display for Unrecoverable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::WindowExpired => "the plaintext outbox window elapsed (ARCHITECTURE.md §8.4)",
            Self::Evicted => "the plaintext was evicted when the outbox filled",
            Self::NeverHeld => "this device never held that message",
        })
    }
}

/// The answer to one `gap_request` hash.
///
/// `Reencrypt` hands back the **plaintext**, not a ciphertext, and that is the
/// point: the caller must put it through the MLS engine's current-epoch send
/// path. There is deliberately no variant carrying stored ciphertext, so a
/// future contributor cannot implement replay without first adding one and
/// having to explain why.
#[derive(Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RepairOutcome<'a> {
    /// Re-encrypt these bytes under the current epoch and send them as a
    /// `gap_response`.
    Reencrypt(&'a [u8]),
    /// §8.4: tell the requester, explicitly, that this one is gone.
    Unrecoverable(Unrecoverable),
}

/// Hand-written: the `Reencrypt` arm holds a user's plaintext, and a derived
/// `Debug` would render it as a list of decimal integers — which contains no
/// hex, so a leak check that greps for hex would walk straight past a complete
/// dump of the message. That is `f2z-codec`'s stated trap, and this is the one
/// type in this crate that holds the message itself.
impl fmt::Debug for RepairOutcome<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Reencrypt(plaintext) => {
                write!(f, "Reencrypt(<redacted; {} bytes>)", plaintext.len())
            }
            Self::Unrecoverable(reason) => f.debug_tuple("Unrecoverable").field(reason).finish(),
        }
    }
}

/// One stored plaintext and when it was stored.
#[derive(Clone, PartialEq, Eq)]
struct OutboxEntry {
    plaintext: Vec<u8>,
    stored_at_ms: u64,
}

/// Hand-written for the same reason as [`RepairOutcome`]'s.
impl fmt::Debug for OutboxEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OutboxEntry")
            .field(
                "plaintext",
                &format_args!("<redacted; {} bytes>", self.plaintext.len()),
            )
            .field("stored_at_ms", &self.stored_at_ms)
            .finish()
    }
}

/// The sender's bounded-window store of plaintexts it may be asked to repair.
///
/// Bounded twice, on purpose:
///
/// - **In time**, by `window_ms`, which is the retention decision of §8.4. A
///   window of `0` is legitimate and means "never repairable"; that is what a
///   user who chose an aggressive local TTL has asked for.
/// - **In count**, by `capacity`. Without it a chatty conversation is an
///   unbounded plaintext buffer, which is a poor thing to leave on a phone
///   whatever the TTL says. Eviction is oldest-first, and it is
///   [`Unrecoverable::Evicted`] rather than a silent drop so the requester
///   still gets a definite answer.
#[derive(Clone, Debug)]
pub struct PlaintextOutbox {
    window_ms: u64,
    capacity: usize,
    entries: BTreeMap<MsgId, OutboxEntry>,
    /// Everything this device has stored and no longer holds, with why. The
    /// requester is owed an answer, and "I do not have it" without a reason is
    /// how a silent hole starts.
    forgotten: BTreeMap<MsgId, Unrecoverable>,
}

impl PlaintextOutbox {
    /// A new outbox with a repair window and a capacity.
    #[must_use]
    pub fn new(window_ms: u64, capacity: usize) -> Self {
        Self {
            window_ms,
            capacity,
            entries: BTreeMap::new(),
            forgotten: BTreeMap::new(),
        }
    }

    /// The repair window, in milliseconds.
    #[must_use]
    pub const fn window_ms(&self) -> u64 {
        self.window_ms
    }

    /// How many plaintexts are held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether nothing is held.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Keep a plaintext against a possible repair request.
    ///
    /// Called by the sender for every message it sends. Storing also expires
    /// anything already past the window, so a caller that never calls
    /// [`PlaintextOutbox::expire`] still does not grow without bound.
    pub fn store(&mut self, msg_id: MsgId, plaintext: Vec<u8>, now_ms: u64) {
        self.expire(now_ms);
        self.entries.insert(
            msg_id,
            OutboxEntry {
                plaintext,
                stored_at_ms: now_ms,
            },
        );
        self.evict_to_capacity();
    }

    /// Drop everything stored more than `window_ms` before `now_ms`.
    ///
    /// Returns how many entries were dropped. The boundary is inclusive of the
    /// window: an entry stored at `t` survives until `t + window_ms` and is
    /// dropped at `t + window_ms + 1`, so a window of `0` keeps a message only
    /// for the instant it was stored in.
    pub fn expire(&mut self, now_ms: u64) -> usize {
        let cutoff = now_ms.saturating_sub(self.window_ms);
        let stale: Vec<MsgId> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.stored_at_ms < cutoff)
            .map(|(id, _)| *id)
            .collect();
        for id in &stale {
            self.entries.remove(id);
            self.forgotten.insert(*id, Unrecoverable::WindowExpired);
        }
        stale.len()
    }

    /// Answer one `gap_request` hash (§7's repair).
    ///
    /// Expiry is applied first, so a caller cannot repair from a window that
    /// has already elapsed merely by not having called [`PlaintextOutbox::expire`].
    #[must_use]
    pub fn repair(&mut self, msg_id: &MsgId, now_ms: u64) -> RepairOutcome<'_> {
        self.expire(now_ms);
        // Resolved before the entry lookup so the returned borrow of
        // `self.entries` is the last thing this function touches.
        let reason = self
            .forgotten
            .get(msg_id)
            .copied()
            .unwrap_or(Unrecoverable::NeverHeld);
        match self.entries.get(msg_id) {
            Some(entry) => RepairOutcome::Reencrypt(&entry.plaintext),
            None => RepairOutcome::Unrecoverable(reason),
        }
    }

    fn evict_to_capacity(&mut self) {
        while self.entries.len() > self.capacity {
            // Oldest first, ties broken by `msg_id` so eviction is
            // deterministic rather than dependent on map iteration luck.
            let Some(oldest) = self
                .entries
                .iter()
                .min_by(|left, right| {
                    left.1
                        .stored_at_ms
                        .cmp(&right.1.stored_at_ms)
                        .then_with(|| left.0.cmp(right.0))
                })
                .map(|(id, _)| *id)
            else {
                break;
            };
            self.entries.remove(&oldest);
            self.forgotten.insert(oldest, Unrecoverable::Evicted);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn id(byte: u8) -> MsgId {
        MsgId::new([byte; MsgId::LEN])
    }

    #[test]
    fn a_message_inside_the_window_is_repairable() {
        let mut outbox = PlaintextOutbox::new(60_000, 8);
        outbox.store(id(1), b"hello".to_vec(), 1_000);
        assert_eq!(
            outbox.repair(&id(1), 60_000),
            RepairOutcome::Reencrypt(b"hello")
        );
    }

    #[test]
    fn an_expired_window_is_an_explicit_unrecoverable_state() {
        let mut outbox = PlaintextOutbox::new(60_000, 8);
        outbox.store(id(1), b"hello".to_vec(), 1_000);
        assert_eq!(
            outbox.repair(&id(1), 61_002),
            RepairOutcome::Unrecoverable(Unrecoverable::WindowExpired),
            "§8.4 requires the requester to be told, not left with a hole"
        );
    }

    #[test]
    fn a_message_this_device_never_sent_is_distinguished_from_an_expired_one() {
        let mut outbox = PlaintextOutbox::new(60_000, 8);
        assert_eq!(
            outbox.repair(&id(9), 1_000),
            RepairOutcome::Unrecoverable(Unrecoverable::NeverHeld)
        );
    }

    #[test]
    fn a_zero_window_means_nothing_is_repairable_after_the_instant_it_was_sent() {
        let mut outbox = PlaintextOutbox::new(0, 8);
        outbox.store(id(1), b"hello".to_vec(), 1_000);
        assert_eq!(
            outbox.repair(&id(1), 1_001),
            RepairOutcome::Unrecoverable(Unrecoverable::WindowExpired)
        );
    }

    #[test]
    fn the_outbox_is_bounded_by_count_as_well_as_by_time() {
        let mut outbox = PlaintextOutbox::new(u64::MAX, 2);
        outbox.store(id(1), b"one".to_vec(), 10);
        outbox.store(id(2), b"two".to_vec(), 20);
        outbox.store(id(3), b"three".to_vec(), 30);
        assert_eq!(outbox.len(), 2);
        assert_eq!(
            outbox.repair(&id(1), 30),
            RepairOutcome::Unrecoverable(Unrecoverable::Evicted)
        );
        assert_eq!(outbox.repair(&id(3), 30), RepairOutcome::Reencrypt(b"three"));
    }

    #[test]
    fn debug_never_renders_the_plaintext_in_any_base() {
        let secret = vec![0xdeu8; 16];
        let mut outbox = PlaintextOutbox::new(u64::MAX, 4);
        outbox.store(id(1), secret.clone(), 0);

        let rendered = alloc::format!("{outbox:?}");
        let hex: alloc::string::String =
            secret.iter().map(|b| alloc::format!("{b:02x}")).collect();
        let decimal = "222, 222, 222, 222";
        assert!(!rendered.contains(&hex));
        assert!(!rendered.contains(decimal), "a decimal dump is a dump");

        let outcome = outbox.repair(&id(1), 0);
        let rendered = alloc::format!("{outcome:?}");
        assert!(!rendered.contains(&hex));
        assert!(!rendered.contains(decimal));
        assert!(rendered.contains("16 bytes"));
    }
}
