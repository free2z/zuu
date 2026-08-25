//! The seam: what a storage backend has to be able to do, which is very little.
//!
//! # Why the trait is this small
//!
//! `openmls_traits::storage::StorageProvider` is 57 methods and one associated
//! type, every method generic over serde. Nothing in it is specific to a
//! storage engine — the generics collapse to *"put these bytes under this
//! label and this key"* — so implementing the whole trait per backend would be
//! 57 methods of identical transcription per backend, and the second copy would
//! be the one with the bug in it. [`StorageBackend`] is the part that actually
//! differs: three methods, no generics, no serde.
//!
//! The provider ([`crate::F2zStorageProvider`]) implements all 57 once, over
//! any backend.
//!
//! # Why `apply` takes a batch
//!
//! **This is the whole reason the seam exists in this shape.** OpenMLS issues
//! many storage calls per logical operation and has **no transaction API**: a
//! `process_message` followed by `merge_pending_commit` writes the tree, the
//! group context, the interim transcript hash, the confirmation tag, the epoch
//! secrets, the message secrets and the proposal queue as seven or more
//! separate calls. A backend that committed each one independently would let a
//! crash land in the middle and leave a group whose tree is from epoch *n+1*
//! and whose secrets are from epoch *n*.
//!
//! Under delete-on-ack ([`ARCHITECTURE.md` §6.4][s64]) that is not an
//! inconvenience. The relay deletes its copy when the client acknowledges, so a
//! half-applied group is a message nobody has any more.
//!
//! [`apply`] therefore takes the entire write set of one logical operation and
//! is required to be **all-or-nothing**. The provider buffers into it; the
//! backend commits it once.
//!
//! # What a backend is NOT asked to do
//!
//! No iteration, no prefix scan, no key enumeration, no schema. The trait's
//! access pattern is exact-key lookup and exact-key write, and a backend that
//! offered more would invite a provider method to depend on it — which would
//! then have to be re-implemented by the IndexedDB backend the browser needs
//! ([ADR 0001][adr1]), where a prefix scan over an object store is a different
//! shape entirely.
//!
//! [`apply`]: StorageBackend::apply
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements
//! [adr1]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0001-platform-priority.md

use crate::error::Result;

/// One entry in an atomic write set.
///
/// `Debug` is derived on the discriminant only through [`Op::label_len`] and
/// friends — the type itself does **not** derive `Debug`, because `value` is
/// a serialised group secret and a derived `Debug` would print it as a decimal
/// byte list. See [`crate`]'s note on that trap.
pub enum Op {
    /// Replace whatever is under `key` with `value`.
    Put {
        /// The fully-built storage key: label, serialised key, version.
        key: Vec<u8>,
        /// The serialised entity.
        value: Vec<u8>,
    },
    /// Remove whatever is under `key`. Removing an absent key is not an error;
    /// OpenMLS deletes unconditionally and expects idempotence.
    Delete {
        /// The fully-built storage key.
        key: Vec<u8>,
    },
}

impl core::fmt::Debug for Op {
    /// Hand-written, and the reason is the one `f2z-codec` documents: a derived
    /// `Debug` on a `Vec<u8>` prints a **decimal** byte list, which contains no
    /// hex, so a redaction test that only looks for hex passes while the whole
    /// secret is in the log. Keys are structural and safe to print as lengths;
    /// values never appear at all.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Put { key, value } => f
                .debug_struct("Put")
                .field("key_len", &key.len())
                .field("value", &format_args!("<redacted; {} bytes>", value.len()))
                .finish(),
            Self::Delete { key } => f
                .debug_struct("Delete")
                .field("key_len", &key.len())
                .finish(),
        }
    }
}

/// A labelled key/value map with an atomic multi-key write.
///
/// Implementations live in [`crate::MemoryBackend`] and, on native targets
/// only, [`crate::SqliteBackend`]. The browser's IndexedDB backend is
/// deliberately **not** in this crate yet; the seam exists so that adding it
/// is a new type here and not a second copy of the 57 methods.
pub trait StorageBackend {
    /// Read one key. `Ok(None)` means "no error, and no value".
    ///
    /// # Errors
    ///
    /// Returns a [`crate::StoreError`] if the underlying store failed. It must
    /// **not** return an error for an absent key.
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>>;

    /// Apply a write set atomically: either every [`Op`] is durable, or none is.
    ///
    /// "Durable" is the backend's own published level — [`MemoryBackend`]
    /// survives nothing and says so, [`SqliteBackend`] survives a power cut.
    /// What is *not* negotiable, at either level, is the atomicity: a reader
    /// after a crash must never see a strict subset of one call's ops.
    ///
    /// An empty batch is a no-op and must succeed without touching the store.
    ///
    /// # Errors
    ///
    /// Returns a [`crate::StoreError`] if the write set could not be applied.
    /// On error the backend must be unchanged.
    ///
    /// [`MemoryBackend`]: crate::MemoryBackend
    /// [`SqliteBackend`]: crate::SqliteBackend
    fn apply(&self, ops: &[Op]) -> Result<()>;

    /// What surviving a crash means for this backend.
    fn durability(&self) -> Durability;
}

/// Whether a committed write set outlives the process.
///
/// This is not decoration. `CLIENT-CONTRACT.md` §3.1 exposes
/// `DurabilityMode` to the UI and §11.2 makes the browser enter **no-ACK
/// mode** when durability is unavailable, because acknowledging a message the
/// relay will then delete, out of a store that cannot survive a reload, is how
/// delete-on-ack loses data. A client asks its store this question and answers
/// honestly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Durability {
    /// Nothing survives the process. [`crate::MemoryBackend`] is this.
    ///
    /// Maps to `CLIENT-CONTRACT.md` §3.1's `"none"`. A client on this backend
    /// must not `ACK`.
    None,
    /// A committed write set survives an unplanned stop of the process and of
    /// the machine. [`crate::SqliteBackend`] is this: WAL journalling with
    /// `synchronous = FULL`, verified at open rather than assumed.
    ///
    /// Maps to `CLIENT-CONTRACT.md` §3.1's `"durable"`.
    Durable,
}

impl Durability {
    /// The `DurabilityMode` string `CLIENT-CONTRACT.md` §3.1 puts on the wire.
    #[must_use]
    pub const fn contract_name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Durable => "durable",
        }
    }

    /// Whether a client backed by this store is permitted to `ACK`.
    ///
    /// The one question a caller should branch on. `CLIENT-CONTRACT.md` §11.2:
    /// "Do not ACK."
    #[must_use]
    pub const fn may_acknowledge(self) -> bool {
        matches!(self, Self::Durable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_op_debug_never_prints_the_value_in_any_base() {
        let secret = vec![0xAB, 0xCD, 0xEF, 0x12];
        let rendered = format!(
            "{:?}",
            Op::Put {
                key: vec![1, 2, 3],
                value: secret.clone(),
            }
        );

        // Hex, in both cases.
        assert!(!rendered.contains("abcdef12"), "{rendered}");
        assert!(!rendered.contains("ABCDEF12"), "{rendered}");
        // And the decimal list a derived `Debug` would have produced. This is
        // the case a hex-only check waves through.
        assert!(!rendered.contains("171, 205, 239, 18"), "{rendered}");
        assert!(rendered.contains("<redacted; 4 bytes>"), "{rendered}");
    }

    #[test]
    fn only_a_durable_backend_may_acknowledge() {
        assert!(!Durability::None.may_acknowledge());
        assert!(Durability::Durable.may_acknowledge());
        assert_eq!(Durability::None.contract_name(), "none");
        assert_eq!(Durability::Durable.contract_name(), "durable");
    }
}
