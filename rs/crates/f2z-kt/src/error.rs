//! The log's own error type, and the one place a `KT.md` §9.5 wire code is
//! decided.
//!
//! # Two populations of error, kept apart on purpose
//!
//! A submission that fails `KT.md` §4.4 is the **client's** fault and its code
//! says so precisely, because the submitter needs to know what to fix. A disk
//! that will not write is the **log's** fault, and §9.5 is blunt about what a
//! client learns from it: `ERR_INTERNAL` *"carries no detail, ever."*
//!
//! [`LogError::wire_code`] is the only function that assigns a code, so the two
//! populations cannot drift apart, and [`LogError::wire_detail`] is what a
//! response body may say — which for an internal fault is nothing at all. The
//! full text goes to the operator's log and stops there.

use core::fmt;

use f2z_authority::AuthorityError;
use f2z_kt_core::{ErrorCode, KtError};

/// The log server's result alias.
pub type Result<T> = core::result::Result<T, LogError>;

/// Everything that can go wrong inside the log server.
#[derive(Debug)]
#[non_exhaustive]
pub enum LogError {
    /// A rule in `KT.md` §4 rejected a submission.
    Kt(KtError),
    /// `f2z-authority` refused a handle claim (`KT.md` §4.4's unspecified
    /// first-entry case; see zuu#594).
    Authority(AuthorityError),
    /// A submission carried an assertion where the log's rules do not admit
    /// one. Distinct from [`LogError::Authority`] because the boundary is
    /// **this crate's**, not `f2z-authority`'s: the log admits an assertion at
    /// `entry_version == 1` and refuses one anywhere else.
    AssertionOutOfPlace,
    /// The request body did not decode, re-encoded differently, or was larger
    /// than the endpoint's cap.
    Malformed,
    /// The requested epoch or audit range is outside the served horizon
    /// (`KT.md` §9.3).
    EpochUnavailable,
    /// An audit range above the published maximum (`KT.md` §9.3).
    RangeTooWide,
    /// The caller exceeded an endpoint's rate limit.
    RateLimited,
    /// A cosignature arrived from a key this log does not recognise. Advisory
    /// only — §9.5 is explicit that the log's opinion of who is a witness has
    /// no bearing on a client's configured set.
    NotAWitness,
    /// The signing backend refused or was unreachable.
    Signer(String),
    /// Durable storage refused, or came back inconsistent.
    Storage(String),
    /// `akd` returned an error.
    Akd(String),
    /// The log is misconfigured. Never reaches a client as anything but
    /// `ERR_INTERNAL`; it reaches the operator as the text.
    Config(String),
}

impl LogError {
    /// The `KT.md` §9.5 code this travels as.
    ///
    /// Every internal fault collapses to `ERR_INTERNAL`, which is the point:
    /// "the disk is full" and "the signing key is unreachable" are the same
    /// eleven to a client, and telling them apart is an oracle for the log's
    /// operational state.
    #[must_use]
    pub const fn wire_code(&self) -> ErrorCode {
        match self {
            Self::Kt(error) => error.error_code(),
            // `AuthorityError::kt_error_code` already returns a §9.5 number;
            // going back through `ErrorCode` keeps one enum on the wire.
            Self::Authority(error) => match ErrorCode::from_code(error.kt_error_code()) {
                Some(code) => code,
                None => ErrorCode::Internal,
            },
            Self::AssertionOutOfPlace => ErrorCode::BadAuthorization,
            Self::Malformed => ErrorCode::Malformed,
            Self::EpochUnavailable => ErrorCode::EpochUnavailable,
            Self::RangeTooWide => ErrorCode::RangeTooWide,
            Self::RateLimited => ErrorCode::RateLimited,
            Self::NotAWitness => ErrorCode::NotAWitness,
            Self::Signer(_) | Self::Storage(_) | Self::Akd(_) | Self::Config(_) => {
                ErrorCode::Internal
            }
        }
    }

    /// What a **response** may say beyond the code.
    ///
    /// `None` for anything that maps to `ERR_INTERNAL`. §9.5: it carries no
    /// detail, ever.
    #[must_use]
    pub fn wire_detail(&self) -> Option<&'static str> {
        match self.wire_code() {
            ErrorCode::Internal => None,
            code => Some(code.name()),
        }
    }

    /// Whether this is the log's fault rather than the caller's.
    ///
    /// Used for one thing: deciding what goes to the operator's log at `error`
    /// level. A client sending garbage is not an incident; a log that cannot
    /// sign is.
    #[must_use]
    pub const fn is_log_fault(&self) -> bool {
        matches!(
            self,
            Self::Signer(_) | Self::Storage(_) | Self::Akd(_) | Self::Config(_)
        )
    }
}

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Kt(error) => write!(f, "{error}"),
            Self::Authority(error) => write!(f, "{error}"),
            Self::AssertionOutOfPlace => {
                f.write_str("an assertion is admitted only for a handle's first entry")
            }
            Self::Malformed => f.write_str("malformed request"),
            Self::EpochUnavailable => f.write_str("epoch outside the served horizon"),
            Self::RangeTooWide => f.write_str("audit range above the published maximum"),
            Self::RateLimited => f.write_str("rate limited"),
            Self::NotAWitness => f.write_str("cosignature from an unrecognised key"),
            Self::Signer(detail) => write!(f, "signer: {detail}"),
            Self::Storage(detail) => write!(f, "storage: {detail}"),
            Self::Akd(detail) => write!(f, "akd: {detail}"),
            Self::Config(detail) => write!(f, "configuration: {detail}"),
        }
    }
}

impl core::error::Error for LogError {}

impl From<KtError> for LogError {
    fn from(error: KtError) -> Self {
        Self::Kt(error)
    }
}

impl From<AuthorityError> for LogError {
    fn from(error: AuthorityError) -> Self {
        Self::Authority(error)
    }
}

impl From<f2z_codec::CodecError> for LogError {
    fn from(_: f2z_codec::CodecError) -> Self {
        Self::Malformed
    }
}

impl From<tls_codec::Error> for LogError {
    fn from(_: tls_codec::Error) -> Self {
        Self::Malformed
    }
}

#[cfg(test)]
mod tests {
    use f2z_kt_core::{ErrorCode, KtError};

    use super::LogError;

    #[test]
    fn every_internal_fault_is_eleven_and_says_nothing_else() {
        for error in [
            LogError::Signer("the HSM is on fire".to_owned()),
            LogError::Storage("/var/lib/f2z-kt is full".to_owned()),
            LogError::Akd("azks missing".to_owned()),
            LogError::Config("no witness configured".to_owned()),
        ] {
            assert_eq!(error.wire_code(), ErrorCode::Internal);
            assert_eq!(
                error.wire_detail(),
                None,
                "ERR_INTERNAL carries no detail, ever (KT.md §9.5)"
            );
            assert!(error.is_log_fault());
        }
    }

    #[test]
    fn a_clients_own_mistake_keeps_its_precise_code() {
        assert_eq!(
            LogError::Kt(KtError::BadAuthorization).wire_code(),
            ErrorCode::BadAuthorization
        );
        assert_eq!(
            LogError::Kt(KtError::VersionConflict).wire_code(),
            ErrorCode::VersionConflict
        );
        assert_eq!(
            LogError::Kt(KtError::Cooldown).wire_code(),
            ErrorCode::Cooldown
        );
        assert!(!LogError::Kt(KtError::Cooldown).is_log_fault());
    }

    #[test]
    fn the_four_codes_no_library_emits_are_reachable_from_here() {
        // KT.md §9.5 defines them; nothing in f2z-kt-core produces them. If the
        // server does not, they are dead letters in a table that promises to be
        // stable forever.
        assert_eq!(
            LogError::EpochUnavailable.wire_code(),
            ErrorCode::EpochUnavailable
        );
        assert_eq!(LogError::RangeTooWide.wire_code(), ErrorCode::RangeTooWide);
        assert_eq!(LogError::RateLimited.wire_code(), ErrorCode::RateLimited);
        assert_eq!(LogError::NotAWitness.wire_code(), ErrorCode::NotAWitness);
    }
}
