//! What the harness itself can fail at, as opposed to what the protocol can
//! refuse.
//!
//! The distinction matters more here than it looks. `f2z-relay-proto` already
//! separates a **wire refusal** (a §10 code the relay answers with) from a
//! **client refusal** (a decision a client makes about a relay). This crate
//! adds a third thing that is neither: the harness lost the connection, or the
//! test's own timeout elapsed, or the configuration was nonsense. A test that
//! collapses those into a protocol error will report "the relay answered
//! `ERR_INTERNAL`" when what actually happened is that the socket closed, and
//! the client author will go looking in the wrong place.

use std::fmt;

use f2z_codec::ErrorCode;
use f2z_relay_proto::ProtoError;

/// Anything this crate can fail at.
#[derive(Debug)]
#[non_exhaustive]
pub enum TestkitError {
    /// The protocol refused — a §10 code from the relay, or a client-side
    /// refusal of the relay. Carries `f2z-relay-proto`'s own type unchanged, so
    /// the code and its fatality survive.
    Protocol(ProtoError),
    /// The transport failed: the socket closed, the duplex peer went away, the
    /// WebSocket handshake was rejected.
    Transport(String),
    /// The peer closed while a request was outstanding. §2.5: the command's
    /// status is **unknown**, and the retry rules of §7.3 and §8.3 apply.
    Closed,
    /// A read waited longer than the caller allowed. Not a protocol event: the
    /// relay may still answer.
    Timeout,
    /// The configuration cannot produce a conforming relay.
    Config(&'static str),
    /// A conformance vector's expectation did not hold.
    Expectation(String),
}

impl TestkitError {
    /// The §10 code, when the failure was a wire refusal.
    #[must_use]
    pub fn wire_code(&self) -> Option<ErrorCode> {
        match self {
            Self::Protocol(error) => error.wire_code(),
            _ => None,
        }
    }

    /// Whether this is the relay answering `code`.
    #[must_use]
    pub fn is_wire(&self, code: ErrorCode) -> bool {
        self.wire_code() == Some(code)
    }
}

impl fmt::Display for TestkitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(f, "{error}"),
            Self::Transport(detail) => write!(f, "transport failure: {detail}"),
            Self::Closed => f.write_str(
                "the connection closed with a request outstanding; \
                 its status is unknown (WIRE.md §2.5)",
            ),
            Self::Timeout => f.write_str("timed out waiting for the relay"),
            Self::Config(detail) => write!(f, "invalid relay configuration: {detail}"),
            Self::Expectation(detail) => write!(f, "expectation not met: {detail}"),
        }
    }
}

impl std::error::Error for TestkitError {}

impl From<ProtoError> for TestkitError {
    fn from(error: ProtoError) -> Self {
        Self::Protocol(error)
    }
}

impl From<f2z_codec::CodecError> for TestkitError {
    fn from(error: f2z_codec::CodecError) -> Self {
        Self::Protocol(ProtoError::from(error))
    }
}

impl From<ErrorCode> for TestkitError {
    fn from(code: ErrorCode) -> Self {
        Self::Protocol(ProtoError::Wire(code))
    }
}

impl From<std::io::Error> for TestkitError {
    fn from(error: std::io::Error) -> Self {
        Self::Transport(error.to_string())
    }
}

/// The result of everything in this crate.
pub type Result<T> = std::result::Result<T, TestkitError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wire_refusal_keeps_its_code_and_a_transport_failure_has_none() {
        let refused = TestkitError::from(ErrorCode::Unavailable);
        assert!(refused.is_wire(ErrorCode::Unavailable));
        assert!(!refused.is_wire(ErrorCode::NoAccess));
        assert_eq!(TestkitError::Closed.wire_code(), None);
        assert_eq!(TestkitError::Timeout.wire_code(), None);
    }

    #[test]
    fn a_lost_connection_says_the_status_is_unknown() {
        assert!(TestkitError::Closed.to_string().contains("unknown"));
    }
}
