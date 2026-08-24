//! Wire error codes (`WIRE.md` §10) and this crate's own failure type.

use core::fmt;

/// A relay error code.
///
/// `WIRE.md` §10: codes are `uint16` and **stable forever** — a code's meaning
/// is never changed and a retired code is never reused. `0` is success and is
/// therefore not a variant here.
///
/// This is deliberately *not* a `tls_codec` enum. [`Response::status`] carries
/// the raw `u16` so that a code this build has never heard of round-trips
/// through re-encode equality instead of failing to decode. Mapping an unknown
/// code to a default is exactly the silent-variant hazard §3.3 exists to
/// forbid.
///
/// [`Response::status`]: crate::frame::Response::status
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum ErrorCode {
    /// Decode failure, re-encode mismatch (§3.3), oversize frame, or a
    /// duplicate in-flight `request_id`. Fatal.
    Malformed,
    /// No common protocol version, or a frame before `HELLO`. Fatal.
    UnsupportedVersion,
    /// A text WebSocket frame (§4.2). Fatal.
    FrameType,
    /// `max_inflight` exceeded (§4.3). Fatal.
    TooManyInflight,
    /// Unknown command code.
    UnknownCommand,
    /// Signature verification failed (§5.1 step 4).
    BadSignature,
    /// Outside `clock_skew_ms` (§5.5).
    StaleTimestamp,
    /// `(signer_key, nonce)` already seen (§5.5).
    Replay,
    /// Reserved for a future binding-mode mismatch; unused in v1.
    ChannelBinding,
    /// Either the address does not exist, or it exists and `signer_key` does
    /// not authorize it. §10's existence-oracle rule requires one code for
    /// both.
    NoAccess,
    /// `BIND_SEND` on an already-bound send address (§7.3).
    AlreadyBound,
    /// Payload length not in `padding_sizes` (§9).
    BadSize,
    /// `up_to_index` above the highest appended index (§8.2).
    AckTooHigh,
    /// A recv-side quota was exceeded (queue count, creation rate).
    Quota,
    /// Send side only. Absent, deleted, expired, full-by-messages,
    /// full-by-bytes, or relay backpressure — collapsed into one code (§6.3).
    Unavailable,
    /// A stamp is required and was absent (§13.1).
    PowRequired,
    /// Stamp invalid, expired, for the wrong challenge, or already consumed.
    PowInvalid,
    /// Global resource limit; retry later (§13.1). Also the seen-set bound
    /// (§5.5).
    Backpressure,
    /// Per-connection or per-source rate limit.
    RateLimited,
    /// The command is not valid for this queue kind — e.g. `BIND_SEND` on a
    /// contact queue (§12.2).
    NotPermitted,
    /// Relay fault. Carries no detail, ever.
    Internal,
}

impl ErrorCode {
    /// Every code, in wire order. Used by the exhaustiveness tests.
    pub const ALL: [Self; 21] = [
        Self::Malformed,
        Self::UnsupportedVersion,
        Self::FrameType,
        Self::TooManyInflight,
        Self::UnknownCommand,
        Self::BadSignature,
        Self::StaleTimestamp,
        Self::Replay,
        Self::ChannelBinding,
        Self::NoAccess,
        Self::AlreadyBound,
        Self::BadSize,
        Self::AckTooHigh,
        Self::Quota,
        Self::Unavailable,
        Self::PowRequired,
        Self::PowInvalid,
        Self::Backpressure,
        Self::RateLimited,
        Self::NotPermitted,
        Self::Internal,
    ];

    /// The wire code.
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::Malformed => 1,
            Self::UnsupportedVersion => 2,
            Self::FrameType => 3,
            Self::TooManyInflight => 4,
            Self::UnknownCommand => 5,
            Self::BadSignature => 6,
            Self::StaleTimestamp => 7,
            Self::Replay => 8,
            Self::ChannelBinding => 9,
            Self::NoAccess => 10,
            Self::AlreadyBound => 11,
            Self::BadSize => 12,
            Self::AckTooHigh => 13,
            Self::Quota => 14,
            Self::Unavailable => 15,
            Self::PowRequired => 16,
            Self::PowInvalid => 17,
            Self::Backpressure => 18,
            Self::RateLimited => 19,
            Self::NotPermitted => 20,
            Self::Internal => 21,
        }
    }

    /// The code this build knows by that number, if any.
    ///
    /// `None` is not an error: §10 keeps codes stable so that an old client can
    /// still log a code it does not recognize.
    #[must_use]
    pub const fn from_code(code: u16) -> Option<Self> {
        Some(match code {
            1 => Self::Malformed,
            2 => Self::UnsupportedVersion,
            3 => Self::FrameType,
            4 => Self::TooManyInflight,
            5 => Self::UnknownCommand,
            6 => Self::BadSignature,
            7 => Self::StaleTimestamp,
            8 => Self::Replay,
            9 => Self::ChannelBinding,
            10 => Self::NoAccess,
            11 => Self::AlreadyBound,
            12 => Self::BadSize,
            13 => Self::AckTooHigh,
            14 => Self::Quota,
            15 => Self::Unavailable,
            16 => Self::PowRequired,
            17 => Self::PowInvalid,
            18 => Self::Backpressure,
            19 => Self::RateLimited,
            20 => Self::NotPermitted,
            21 => Self::Internal,
            _ => return None,
        })
    }

    /// Whether the responder must close the connection after sending this code
    /// (`WIRE.md` §1.3, §10).
    #[must_use]
    pub const fn is_fatal(self) -> bool {
        matches!(
            self,
            Self::Malformed | Self::UnsupportedVersion | Self::FrameType | Self::TooManyInflight
        )
    }

    /// The stable screaming-snake name from §10's table, for logs.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Malformed => "ERR_MALFORMED",
            Self::UnsupportedVersion => "ERR_UNSUPPORTED_VERSION",
            Self::FrameType => "ERR_FRAME_TYPE",
            Self::TooManyInflight => "ERR_TOO_MANY_INFLIGHT",
            Self::UnknownCommand => "ERR_UNKNOWN_COMMAND",
            Self::BadSignature => "ERR_BAD_SIGNATURE",
            Self::StaleTimestamp => "ERR_STALE_TIMESTAMP",
            Self::Replay => "ERR_REPLAY",
            Self::ChannelBinding => "ERR_CHANNEL_BINDING",
            Self::NoAccess => "ERR_NO_ACCESS",
            Self::AlreadyBound => "ERR_ALREADY_BOUND",
            Self::BadSize => "ERR_BAD_SIZE",
            Self::AckTooHigh => "ERR_ACK_TOO_HIGH",
            Self::Quota => "ERR_QUOTA",
            Self::Unavailable => "ERR_UNAVAILABLE",
            Self::PowRequired => "ERR_POW_REQUIRED",
            Self::PowInvalid => "ERR_POW_INVALID",
            Self::Backpressure => "ERR_BACKPRESSURE",
            Self::RateLimited => "ERR_RATE_LIMITED",
            Self::NotPermitted => "ERR_NOT_PERMITTED",
            Self::Internal => "ERR_INTERNAL",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.name(), self.code())
    }
}

// `core::error::Error`, not `std::error::Error`: this crate is `no_std`, and a
// caller that is not should still be able to put these in a `Box<dyn Error>`.
impl core::error::Error for ErrorCode {}

/// Everything this crate can refuse to do.
///
/// Each variant carries the [`ErrorCode`] a relay would put on the wire, so a
/// caller never has to re-derive it — and never has to invent one. §6.3 and §10
/// make the choice of code a security property, not a diagnostic nicety.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum CodecError {
    /// The bytes did not decode as the expected structure.
    Decode,
    /// The bytes decoded, but re-encoding them produced different bytes
    /// (`WIRE.md` §3.3). Always fatal, always before any state changes.
    NotCanonical,
    /// A field carried a value no version-1 structure may hold — an unknown
    /// `FrameKind`, an out-of-range `CommandAuth.present`, an oversize vector.
    InvalidValue,
    /// A payload's length is not exactly one of the relay's `padding_sizes`
    /// (`WIRE.md` §9).
    BadSize,
    /// The structure is larger than its length prefixes can describe.
    Overflow,
}

impl CodecError {
    /// The wire code a relay sends for this failure.
    #[must_use]
    pub const fn error_code(self) -> ErrorCode {
        match self {
            Self::BadSize => ErrorCode::BadSize,
            Self::Decode | Self::NotCanonical | Self::InvalidValue | Self::Overflow => {
                ErrorCode::Malformed
            }
        }
    }
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Decode => "frame did not decode",
            Self::NotCanonical => "re-encoding produced different bytes (WIRE.md §3.3)",
            Self::InvalidValue => "field value is not valid in protocol version 1",
            Self::BadSize => "payload length is not a published padding size (WIRE.md §9)",
            Self::Overflow => "structure exceeds the length its prefix can describe",
        };
        write!(f, "{text}: {}", self.error_code())
    }
}

impl core::error::Error for CodecError {}

impl From<tls_codec::Error> for CodecError {
    fn from(_: tls_codec::Error) -> Self {
        // Deliberately lossy. §4.1: an error response carries a code and
        // nothing else, so a decoder detail that cannot be reported must not be
        // carried around as if it could.
        Self::Decode
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_the_table_in_wire_md_section_10() {
        for (index, code) in ErrorCode::ALL.iter().enumerate() {
            assert_eq!(code.code(), (index as u16) + 1);
            assert_eq!(ErrorCode::from_code(code.code()), Some(*code));
        }
        assert_eq!(
            ErrorCode::from_code(0),
            None,
            "0 is success, never an error"
        );
        assert_eq!(ErrorCode::from_code(22), None);
    }

    #[test]
    fn exactly_four_codes_are_fatal() {
        let fatal: alloc::vec::Vec<_> = ErrorCode::ALL
            .iter()
            .filter(|code| code.is_fatal())
            .collect();
        assert_eq!(
            fatal,
            [
                &ErrorCode::Malformed,
                &ErrorCode::UnsupportedVersion,
                &ErrorCode::FrameType,
                &ErrorCode::TooManyInflight
            ]
        );
    }
}
