//! Durability as a value you are handed, not a rule you are asked to remember.
//!
//! # The problem this module exists for
//!
//! [`ARCHITECTURE.md` §6.3][s63] defines four delivery states, and the relay
//! implements two of them: `accepted` (an `APPEND` that returned status 0) and
//! `queue-delivered` (an `ACK`, at which instant the relay **deletes**). Under
//! delete-on-ack the relay's copy is, for a window, the only copy in the
//! system — [`ARCHITECTURE.md` §6.4][s64] says it plainly: "a lost ACK now
//! means a permanently lost message, because the relay's copy is gone or was
//! never taken."
//!
//! So a relay that answers `accepted` before the write has reached stable
//! storage has told the sender it took custody of something it can still lose
//! to a power cut. [`WIRE.md` §8.4][s84] publishes exactly this as
//! `durability_mode`, and the honest reading of that field is that it is a
//! promise an operator makes about its own code.
//!
//! # How this crate keeps that promise mechanically
//!
//! [`Committed<T>`] is the result of every mutating [`RelayStore`] operation,
//! and it **cannot be constructed outside this crate**. The only code that
//! mints one is the code that has just finished the transaction that made it
//! true. A caller therefore cannot write "reply `accepted`" without first
//! holding a value that only a completed commit could have produced — the
//! ordering is a borrow-checked fact rather than a comment in a review.
//!
//! [`Committed`] is `#[must_use]` for the mirror reason: silently dropping the
//! receipt is how a batch loses track of which of its appends actually landed.
//!
//! # The cost, stated
//!
//! Because the constructor is crate-private, a `RelayStore` implementation
//! **outside this crate cannot exist**. That is a deliberate v1 trade and it is
//! recorded rather than hidden: durability is the one property a storage
//! backend cannot be trusted to assert about itself, and an
//! `assert_durable(...)` escape hatch would restore precisely the convention
//! this type replaces. Opening it later is a one-item change — a default-off
//! feature exposing a loudly-named constructor — and it should be made when
//! there is a real second backend, not in advance of one.
//!
//! [s63]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#63-what-delivered-means
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements
//! [s84]: https://github.com/free2z/zuu/blob/main/docs/e2ee/WIRE.md#84-where-this-sits-in-the-four-delivery-states
//! [`RelayStore`]: crate::RelayStore

use core::fmt;

/// What a store's `Committed` actually promises — `WIRE.md` §11.1's
/// `durability_mode`, as a type.
///
/// The wire encoding is a `uint8` and the three values are §11.1's, unchanged.
/// A relay MUST publish the value its store reports; a client SHOULD prefer a
/// durable relay, and §8.4 says the field exists so that it can.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Durability {
    /// `0` — nothing survives the process. [`MemoryStore`] is this, and no
    /// end-to-end contract breaks: `accepted` never promised anything (§8.4).
    /// It is for tests, for a private relay that is explicitly a cache, and for
    /// making the *other* two values mean something by contrast.
    ///
    /// [`MemoryStore`]: crate::MemoryStore
    Memory,
    /// `1` — the write is acknowledged before it is flushed. This crate does
    /// not implement it, and the variant exists so that a store reporting a
    /// mode can name every mode the capability document can carry.
    ///
    /// **Group commit is not this.** Batching many appends into one
    /// transaction still fsyncs before any of them returns; deferring the fsync
    /// past the response is what makes a store `batched`.
    Batched,
    /// `2` — an `APPEND` that returned 0 survives a crash. [`SqliteStore`] is
    /// this: WAL journalling with `synchronous = FULL`, verified at open rather
    /// than assumed.
    ///
    /// [`SqliteStore`]: crate::SqliteStore
    FsyncPerAppend,
}

impl Durability {
    /// The `uint8` a relay publishes in `Capabilities.durability_mode` (§11.1).
    #[must_use]
    pub const fn wire_value(self) -> u8 {
        match self {
            Self::Memory => 0,
            Self::Batched => 1,
            Self::FsyncPerAppend => 2,
        }
    }

    /// Whether an `APPEND` that returned 0 through this store survives a crash.
    ///
    /// This is the question §8.4 tells a client to ask, and the only one a
    /// caller should branch on.
    #[must_use]
    pub const fn survives_crash(self) -> bool {
        matches!(self, Self::FsyncPerAppend)
    }
}

impl fmt::Display for Durability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Memory => "memory",
            Self::Batched => "batched",
            Self::FsyncPerAppend => "fsync-per-append",
        };
        write!(f, "{name} ({})", self.wire_value())
    }
}

/// The outcome of a store operation, together with the proof that the operation
/// reached the store's published durability level before this value existed.
///
/// Every mutating [`RelayStore`] method returns one. See the module
/// documentation for why the constructor is crate-private and what that buys.
///
/// [`RelayStore`]: crate::RelayStore
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use = "this is the evidence that the write is durable; dropping it discards \
              the only thing that distinguishes `accepted` from a hope"]
pub struct Committed<T> {
    durability: Durability,
    value: T,
}

impl<T> Committed<T> {
    /// Mint a proof. Callable only from inside this crate, and only from the
    /// code that has just completed the durable write.
    pub(crate) const fn seal(durability: Durability, value: T) -> Self {
        Self { durability, value }
    }

    /// The durability level this write actually reached.
    #[must_use]
    pub const fn durability(&self) -> Durability {
        self.durability
    }

    /// Borrow the outcome.
    #[must_use]
    pub const fn get(&self) -> &T {
        &self.value
    }

    /// Take the outcome, discarding the proof.
    ///
    /// Named to be visible in review: after this call the value is an ordinary
    /// one and nothing distinguishes it from a value that was never committed.
    #[must_use]
    pub fn into_inner(self) -> T {
        self.value
    }

    /// Transform the outcome, carrying the proof across unchanged.
    ///
    /// The proof is about the *write*, not about the shape of the value, so
    /// projecting a field out of a batch result does not weaken it.
    pub fn map<U, F: FnOnce(T) -> U>(self, function: F) -> Committed<U> {
        Committed {
            durability: self.durability,
            value: function(self.value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_values_are_section_11_1s() {
        assert_eq!(Durability::Memory.wire_value(), 0);
        assert_eq!(Durability::Batched.wire_value(), 1);
        assert_eq!(Durability::FsyncPerAppend.wire_value(), 2);
    }

    #[test]
    fn only_fsync_per_append_survives_a_crash() {
        assert!(!Durability::Memory.survives_crash());
        assert!(!Durability::Batched.survives_crash());
        assert!(Durability::FsyncPerAppend.survives_crash());
    }

    #[test]
    fn the_proof_travels_through_map() {
        let committed = Committed::seal(Durability::FsyncPerAppend, 7u64);
        assert_eq!(*committed.get(), 7);
        let mapped = committed.map(|value| value + 1);
        assert_eq!(mapped.durability(), Durability::FsyncPerAppend);
        assert_eq!(mapped.into_inner(), 8);
    }
}
