//! The witness's error type.
//!
//! Split three ways on purpose, because the three populations demand different
//! behaviour and conflating them is how a witness ends up doing the wrong one:
//!
//! - [`WitnessError::Fault`] — **the log did something wrong.** Refuse, write
//!   evidence, halt. `KT.md` §7.3.
//! - [`WitnessError::Transport`] — the network. Retry on the next poll. A log
//!   that is unreachable is not a log that equivocated, and treating it as one
//!   would fill the evidence directory with reports about somebody's wifi.
//! - [`WitnessError::Local`] — this daemon's own state, keys or disk. Report
//!   and stop; there is nothing to accuse anyone of.

use core::fmt;

use f2z_kt_core::{FaultKind, KtError};

/// The witness's result alias.
pub type Result<T> = core::result::Result<T, WitnessError>;

/// What can go wrong in the poll loop.
#[derive(Debug)]
#[non_exhaustive]
pub enum WitnessError {
    /// The log misbehaved. Carries the `KT.md` §7.3 kind that names it.
    Fault(FaultKind, KtError),
    /// The log could not be reached, or answered something undecodable.
    Transport(String),
    /// A local failure: the state file, the key, the evidence directory.
    Local(String),
}

impl WitnessError {
    /// The fault kind, if this is an accusation against the log.
    #[must_use]
    pub const fn fault(&self) -> Option<FaultKind> {
        match self {
            Self::Fault(kind, _) => Some(*kind),
            _ => None,
        }
    }

    /// Whether the next poll should simply try again.
    ///
    /// Only for transport. A fault is permanent by design — §7.1: *"A witness
    /// MUST NOT 'catch up' past a fault. Once halted it stays halted until a
    /// human looks at the evidence. An automatic resync is an automatic way to
    /// erase the only record of the thing the witness exists to find."*
    #[must_use]
    pub const fn is_retryable(&self) -> bool {
        matches!(self, Self::Transport(_))
    }
}

impl fmt::Display for WitnessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fault(kind, error) => write!(f, "fault {kind:?}: {error}"),
            Self::Transport(detail) => write!(f, "transport: {detail}"),
            Self::Local(detail) => write!(f, "local: {detail}"),
        }
    }
}

impl core::error::Error for WitnessError {}

impl From<f2z_codec::CodecError> for WitnessError {
    fn from(error: f2z_codec::CodecError) -> Self {
        Self::Transport(format!("undecodable response: {error}"))
    }
}
