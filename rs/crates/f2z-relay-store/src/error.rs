//! What a store can refuse, and what a relay is allowed to say about it.
//!
//! Two rules from `WIRE.md` govern this whole module and neither is
//! negotiable:
//!
//! - **§10's existence-oracle rule.** "Either the address does not exist, or it
//!   exists and `signer_key` does not authorize it" is one code,
//!   `ERR_NO_ACCESS`, because a relay that distinguished them would answer an
//!   attacker sweeping the 32-byte address space. The store is the component
//!   that knows whether a row exists, so the collapse has to happen here — a
//!   `NotFound` variant reaching the caller would be the oracle itself, one
//!   `match` arm away from the wire.
//! - **§6.3's send-side collapse.** Absent, deleted, expired, full-by-messages,
//!   full-by-bytes and backpressure are all `ERR_UNAVAILABLE` on the send side,
//!   because otherwise a bound sender learns the queue's state by filling it.
//!   So the *same* missing row is `ERR_NO_ACCESS` when it was looked up by
//!   receive address and `ERR_UNAVAILABLE` when it was looked up by send
//!   address, and the two lookups are separate methods for exactly that reason.
//!
//! Everything else here is a relay fault, and §10 gives relay faults one code
//! that "carries no detail, ever".

use core::fmt;

use f2z_codec::ErrorCode;
use f2z_relay_proto::ProtoError;

/// A store operation's result.
pub type Result<T> = core::result::Result<T, StoreError>;

/// Why a store operation did not happen.
#[derive(Debug)]
#[non_exhaustive]
pub enum StoreError {
    /// A refusal the protocol already has a code for — the queue-lifecycle and
    /// acknowledgement rules of §7 and §8, applied to persisted state.
    Protocol(ProtoError),
    /// `CREATE_QUEUE` was handed an address that is already in use.
    ///
    /// Not a protocol error and never sent: §7.1 has the relay generate both
    /// addresses from its own CSPRNG and "simply retry on collision, which it
    /// will never have to do at 32 bytes". This is the value that tells the
    /// caller to draw again. It is also what a *bug* in the caller's address
    /// generation looks like, which is why it is distinguishable here and
    /// nowhere else.
    AddressCollision,
    /// A value does not fit the storage engine's integer domain.
    ///
    /// SQLite's `INTEGER` is a signed 64-bit value, so this store's index and
    /// byte counters top out at `i64::MAX` rather than `u64::MAX`. Reachable
    /// only by a caller passing an absurd quota; unreachable by appending, at
    /// any rate a relay could sustain, for longer than the species has existed.
    ValueOutOfRange,
    /// The store's own contents contradict the protocol.
    ///
    /// A relay fault. It becomes `ERR_INTERNAL` on the wire, which §10 says
    /// carries no detail — the detail belongs in the operator's alerting, not
    /// in a frame.
    Corrupt(&'static str),
    /// The storage engine failed.
    Backend(rusqlite::Error),
}

impl StoreError {
    /// The §10 code a relay answers with.
    ///
    /// Every non-protocol variant is `ERR_INTERNAL`, including
    /// [`StoreError::AddressCollision`]: a caller that propagates a collision
    /// to the wire instead of redrawing has a bug, and inventing a code for it
    /// would put an implementation detail into a stable protocol field.
    #[must_use]
    pub const fn error_code(&self) -> ErrorCode {
        match self {
            Self::Protocol(ProtoError::Wire(code)) => *code,
            Self::Protocol(_)
            | Self::AddressCollision
            | Self::ValueOutOfRange
            | Self::Corrupt(_)
            | Self::Backend(_) => ErrorCode::Internal,
        }
    }

    /// Whether the relay must close the connection after answering (§1.3).
    #[must_use]
    pub const fn is_fatal(&self) -> bool {
        self.error_code().is_fatal()
    }

    /// The refusal a receive-side lookup makes when there is no such queue.
    ///
    /// §10: the same code an address that never existed gets, and the same code
    /// a wrong key gets. There is no other constructor for "absent" on this
    /// side, so there is no way to accidentally answer something else.
    #[must_use]
    pub(crate) const fn no_access() -> Self {
        Self::Protocol(ProtoError::Wire(ErrorCode::NoAccess))
    }

    /// The refusal every send-side failure makes (§6.3).
    #[must_use]
    pub(crate) const fn unavailable() -> Self {
        Self::Protocol(ProtoError::Wire(ErrorCode::Unavailable))
    }

    /// §10 code 20: the command is not valid for this queue kind.
    ///
    /// Used by `PUBLISH_KEY_PACKAGES` on a standard queue (§12.6), and it is
    /// deliberately **not** collapsed into [`StoreError::no_access`]. The
    /// caller has already proved it holds the receive key for this address, so
    /// nothing it is told here is an oracle about an address it does not
    /// already own — this is the same reasoning §12.2 uses to keep `BIND_SEND`
    /// on a contact address distinguishable.
    #[must_use]
    pub(crate) const fn not_permitted() -> Self {
        Self::Protocol(ProtoError::Wire(ErrorCode::NotPermitted))
    }
}

impl From<ProtoError> for StoreError {
    fn from(error: ProtoError) -> Self {
        Self::Protocol(error)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Backend(error)
    }
}

impl fmt::Display for StoreError {
    /// Renders no payload, no address and no key — see `tests/redaction.rs`.
    ///
    /// This is cheap to keep true because nothing in this crate ever
    /// interpolates a value into SQL: every payload, address and key travels as
    /// a bound parameter, and SQLite's diagnostics name schema objects rather
    /// than echoing the values bound to them. The test exists because "cheap to
    /// keep true" is not the same as "true", and the day someone builds a query
    /// by formatting is the day this stops holding.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "{error}"),
            Self::AddressCollision => f.write_str(
                "the address handed to CREATE_QUEUE is already in use; draw again (§7.1)",
            ),
            Self::ValueOutOfRange => {
                f.write_str("a counter exceeded this store's signed 64-bit integer domain")
            }
            Self::Corrupt(what) => write!(f, "stored state contradicts the protocol: {what}"),
            Self::Backend(error) => write!(f, "storage engine: {error}"),
        }
    }
}

impl core::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn core::error::Error + 'static)> {
        match self {
            Self::Backend(error) => Some(error),
            Self::Protocol(_)
            | Self::AddressCollision
            | Self::ValueOutOfRange
            | Self::Corrupt(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_absent_cases_answer_differently_and_deliberately() {
        assert_eq!(StoreError::no_access().error_code(), ErrorCode::NoAccess);
        assert_eq!(
            StoreError::unavailable().error_code(),
            ErrorCode::Unavailable
        );
    }

    #[test]
    fn every_relay_fault_is_err_internal() {
        assert_eq!(
            StoreError::AddressCollision.error_code(),
            ErrorCode::Internal
        );
        assert_eq!(
            StoreError::ValueOutOfRange.error_code(),
            ErrorCode::Internal
        );
        assert_eq!(StoreError::Corrupt("x").error_code(), ErrorCode::Internal);
    }
}
