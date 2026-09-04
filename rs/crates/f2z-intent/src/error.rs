//! Everything the bridge can refuse to do, and the wire status each refusal
//! becomes.
//!
//! Two rules govern this enum, both taken from `f2z-codec`'s
//! [`ErrorCode`](f2z_codec::ErrorCode):
//!
//! 1. **Status codes are stable forever.** A code's meaning is never changed
//!    and a retired code is never reused, because a client built against
//!    version 1 must still be able to log a refusal it does not recognize.
//! 2. **A refusal carries a code and nothing else.** No free-text detail
//!    crosses the bridge. The caller is, by construction, an app the wallet
//!    does not trust; a diagnostic string is an oracle and a spoofing surface.
//!
//! The variants are deliberately *not* one per internal check. Several
//! distinct failures collapse onto one code — a tampered field, a mismatched
//! confirmation and a wrong-caller intent all end at
//! [`IntentError::Refused`]'s neighbourhood rather than telling a hostile
//! caller which guard it tripped.

use core::fmt;

use f2z_codec::CodecError;

/// A refusal.
///
/// Every variant is a *refusal to act*. There is no variant meaning "acted,
/// with a caveat": the bridge either produced the requested authority or it
/// did not.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum IntentError {
    /// The bytes are not a well-formed envelope, carry trailing data, or
    /// re-encode to something else (`WIRE.md` §3.3).
    Malformed,
    /// The envelope names a protocol version this build does not implement.
    ///
    /// This is the *first* thing checked and it is checked before the body is
    /// looked at, so a future version's body can never be parsed as if it were
    /// a version-1 body. See [`crate::wire::IntentRequestEnvelope`].
    UnsupportedVersion,
    /// The envelope names an intent family this build does not implement.
    ///
    /// Refused rather than passed through: an unrecognized family is, by
    /// definition, authority the wallet cannot render for the user to approve.
    UnknownIntent,
    /// A field decoded but holds a value no version-1 request may hold — an
    /// empty challenge, an inverted validity window, a lifetime longer than
    /// the ceiling, text containing a layout control.
    InvalidValue,
    /// The request's validity window has closed on at least one clock.
    Expired,
    /// The request is dated in the future relative to the verifying clock, or
    /// a clock moved backwards past issuance. Refused rather than waited out.
    NotYetValid,
    /// This `request_id` has already been claimed. One-use is one-use.
    Replay,
    /// The replay ledger is full and pruning freed nothing. Fail closed: a
    /// bridge that forgets what it has seen cannot promise one-use.
    LedgerFull,
    /// A confirmation was presented that does not bind this exact request and
    /// this exact review, or no confirmation was presented at all.
    NotConfirmed,
    /// The caller is not registered, or the platform attested a different
    /// caller than the request claims.
    CallerNotAuthorized,
    /// A response does not correspond to any outstanding request this client
    /// issued.
    Unsolicited,
    /// The wallet accepted the request but could not act on it: no wallet is
    /// open, the payment cannot be funded, the prover or the network is
    /// unavailable, or a broadcast did not complete.
    ///
    /// This is deliberately **not** [`Self::InvalidValue`]. A request the
    /// wallet cannot fund is not a malformed request, and telling an honest
    /// caller its message was invalid is how it "fixes" a message that was
    /// already correct. It carries no detail for the same reason nothing else
    /// here does — the caller is an app the wallet does not trust, and
    /// "insufficient funds" is a balance oracle.
    Unavailable,
}

impl IntentError {
    /// Every refusal, in wire order. Used by the exhaustiveness tests.
    pub const ALL: [Self; 12] = [
        Self::Malformed,
        Self::UnsupportedVersion,
        Self::UnknownIntent,
        Self::InvalidValue,
        Self::Expired,
        Self::NotYetValid,
        Self::Replay,
        Self::LedgerFull,
        Self::NotConfirmed,
        Self::CallerNotAuthorized,
        Self::Unsolicited,
        Self::Unavailable,
    ];

    /// The wire status. `0` means fulfilled and is therefore not a variant.
    #[must_use]
    pub const fn status(self) -> u16 {
        match self {
            Self::Malformed => 1,
            Self::UnsupportedVersion => 2,
            Self::UnknownIntent => 3,
            Self::InvalidValue => 4,
            Self::Expired => 5,
            Self::NotYetValid => 6,
            Self::Replay => 7,
            Self::LedgerFull => 8,
            Self::NotConfirmed => 9,
            Self::CallerNotAuthorized => 10,
            Self::Unsolicited => 11,
            Self::Unavailable => 12,
        }
    }

    /// The refusal this build knows by that status, if any.
    ///
    /// `None` is not an error: statuses are stable so that a client can log a
    /// refusal minted by a newer wallet.
    #[must_use]
    pub const fn from_status(status: u16) -> Option<Self> {
        Some(match status {
            1 => Self::Malformed,
            2 => Self::UnsupportedVersion,
            3 => Self::UnknownIntent,
            4 => Self::InvalidValue,
            5 => Self::Expired,
            6 => Self::NotYetValid,
            7 => Self::Replay,
            8 => Self::LedgerFull,
            9 => Self::NotConfirmed,
            10 => Self::CallerNotAuthorized,
            11 => Self::Unsolicited,
            12 => Self::Unavailable,
            _ => return None,
        })
    }

    /// The stable screaming-snake name, for logs.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Malformed => "INTENT_MALFORMED",
            Self::UnsupportedVersion => "INTENT_UNSUPPORTED_VERSION",
            Self::UnknownIntent => "INTENT_UNKNOWN_INTENT",
            Self::InvalidValue => "INTENT_INVALID_VALUE",
            Self::Expired => "INTENT_EXPIRED",
            Self::NotYetValid => "INTENT_NOT_YET_VALID",
            Self::Replay => "INTENT_REPLAY",
            Self::LedgerFull => "INTENT_LEDGER_FULL",
            Self::NotConfirmed => "INTENT_NOT_CONFIRMED",
            Self::CallerNotAuthorized => "INTENT_CALLER_NOT_AUTHORIZED",
            Self::Unsolicited => "INTENT_UNSOLICITED",
            Self::Unavailable => "INTENT_UNAVAILABLE",
        }
    }
}

impl fmt::Display for IntentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name(), self.status())
    }
}

impl core::error::Error for IntentError {}

impl From<CodecError> for IntentError {
    fn from(error: CodecError) -> Self {
        // Deliberately lossy, for the same reason `f2z-codec` is lossy about
        // `tls_codec::Error`: a refusal carries a code and nothing else, so a
        // decoder detail that cannot be reported must not be carried around as
        // if it could. Every codec failure is, from the caller's side, the same
        // fact: these bytes are not a version-1 intent.
        match error {
            CodecError::Decode | CodecError::NotCanonical | CodecError::Overflow => Self::Malformed,
            _ => Self::InvalidValue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_are_dense_stable_and_never_zero() {
        for (index, error) in IntentError::ALL.iter().enumerate() {
            let expected = u16::try_from(index).unwrap() + 1;
            assert_eq!(error.status(), expected);
            assert_eq!(IntentError::from_status(error.status()), Some(*error));
        }
        assert_eq!(
            IntentError::from_status(0),
            None,
            "0 is `fulfilled`, never a refusal"
        );
        assert_eq!(
            IntentError::from_status(13),
            None,
            "an unknown status must stay unknown rather than map onto a default"
        );
    }

    #[test]
    fn names_are_unique() {
        for (index, error) in IntentError::ALL.iter().enumerate() {
            for other in IntentError::ALL.iter().skip(index + 1) {
                assert_ne!(error.name(), other.name());
            }
        }
    }
}
