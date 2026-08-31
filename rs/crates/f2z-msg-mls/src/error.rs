//! What the engine can refuse, and how it maps to what the UI is allowed to say.
//!
//! `CLIENT-CONTRACT.md` §8 defines a **closed** `ErrorCode` union and §8.1 is
//! what makes the word honest: every code has a target and the frontend never
//! sees a number. This type is the engine's half of that mapping. It carries no
//! key material and no plaintext, and its `Debug` reaches whatever log the
//! application installs — so it names *what* failed and never *with what*.

use core::fmt;

/// An engine operation's result.
pub type Result<T> = core::result::Result<T, EngineError>;

/// Why an engine operation did not happen.
#[derive(Debug)]
#[non_exhaustive]
pub enum EngineError {
    /// A signature would not verify, or could not be produced.
    ///
    /// Deliberately one variant for both directions. A caller that could
    /// distinguish "your key is bad" from "the peer's signature is bad" would
    /// be tempted to retry one of them, and neither is retryable.
    Signature,
    /// A [`DeviceCredential`](crate::DeviceCredential) failed to parse, or
    /// failed validation.
    ///
    /// The peer's identity→device binding did not hold. `CLIENT-CONTRACT.md`
    /// §8 has no softer code for this than `internal`, and that is correct:
    /// there is no user action, and it must not be presented as a network
    /// problem.
    Credential(CredentialError),
    /// The local store refused.
    Storage(f2z_msg_store::StoreError),
    /// OpenMLS refused. The `&'static str` is the operation, never the data.
    ///
    /// OpenMLS's own error types are numerous, deeply generic over the storage
    /// provider, and mostly not actionable by a client. Collapsing them costs
    /// nothing a caller could have used and keeps this type nameable in an FFI
    /// boundary — `CLIENT-CONTRACT.md` §8's `internal` "carries no detail by
    /// design".
    Mls(&'static str),
    /// A first-contact envelope named a different conversation than the MLS
    /// `Welcome` actually joins. The peer signs both values, so accepting the
    /// contradiction would persist a group that cannot be reloaded by the
    /// conversation identifier after restart.
    GroupIdMismatch,
    /// A message arrived for an epoch this device has already moved past, or
    /// has not reached yet.
    ///
    /// Distinguished from [`EngineError::Mls`] because it is the one MLS
    /// failure that is **expected** in normal operation and must not be
    /// reported as a defect: the relay may reorder freely
    /// (`WIRE.md` §5.4), so an out-of-order commit is a transport event.
    OutOfOrder,
    /// A message this device has already processed arrived again.
    ///
    /// Also expected rather than exceptional: a device may publish queue
    /// addresses on *k* relays and senders send to all *k*
    /// (`ARCHITECTURE.md` §9.4), so duplicates are routine and the correct
    /// response is to drop, not to fail.
    Duplicate,
}

/// Why a device credential was not accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum CredentialError {
    /// The bytes are not a `free2z/device-credential/v1` structure at all.
    Malformed,
    /// It parsed, but the leading type tag is not
    /// `free2z/device-credential/v1`.
    ///
    /// Its own variant because this is what a *plain* MLS `BasicCredential`
    /// looks like from here — a peer that put a bare handle in the identity
    /// field rather than a credential — and the two failures want different
    /// words in a bug report.
    WrongType,
    /// The `IdentitySigningKey` signature over the credential body does not
    /// verify.
    BadSignature,
    /// `not_before`/`not_after` do not bracket the time it was checked at.
    Expired,
    /// The credential's `device_pk` is not the leaf's `signature_key`.
    ///
    /// **This is the binding.** A credential that is internally valid but
    /// describes a different device is precisely the substitution the
    /// identity→device binding exists to stop, and it is the one check that
    /// cannot be done by looking at the credential alone.
    DeviceKeyMismatch,
    /// The handle is not a valid messaging handle: not lowercase ASCII
    /// alphanumeric-plus-underscore, empty, or over 30 characters
    /// (`CLIENT-CONTRACT.md` §3.2's `HandleEligibility`).
    InvalidHandle,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Malformed => "the credential could not be parsed",
            Self::WrongType => "the credential is not a free2z/device-credential/v1",
            Self::BadSignature => "the identity signature over the credential does not verify",
            Self::Expired => "the credential is not valid at this time",
            Self::DeviceKeyMismatch => "the credential does not describe this leaf's device key",
            Self::InvalidHandle => "the credential's handle is not a valid messaging handle",
        })
    }
}

impl core::error::Error for CredentialError {}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Signature => {
                f.write_str("an Ed25519 signature could not be produced or verified")
            }
            Self::Credential(error) => write!(f, "device credential rejected: {error}"),
            Self::Storage(error) => write!(f, "the local store refused: {error}"),
            Self::Mls(operation) => write!(f, "MLS refused during {operation}"),
            Self::GroupIdMismatch => {
                f.write_str("the Welcome group id does not match the conversation id")
            }
            Self::OutOfOrder => f.write_str("the message is for a different epoch"),
            Self::Duplicate => f.write_str("the message has already been processed"),
        }
    }
}

impl core::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn core::error::Error + 'static)> {
        match self {
            Self::Credential(error) => Some(error),
            Self::Storage(error) => Some(error),
            _ => None,
        }
    }
}

impl From<f2z_msg_store::StoreError> for EngineError {
    fn from(error: f2z_msg_store::StoreError) -> Self {
        Self::Storage(error)
    }
}

impl From<CredentialError> for EngineError {
    fn from(error: CredentialError) -> Self {
        Self::Credential(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_displays_without_panicking_and_without_bytes() {
        let errors = [
            EngineError::Signature,
            EngineError::Credential(CredentialError::DeviceKeyMismatch),
            EngineError::Mls("process_message"),
            EngineError::GroupIdMismatch,
            EngineError::OutOfOrder,
            EngineError::Duplicate,
        ];
        for error in &errors {
            let rendered = format!("{error}");
            assert!(!rendered.is_empty());
            assert!(!rendered.contains('['), "{rendered}");
        }
    }

    #[test]
    fn a_credential_error_is_reachable_through_source() {
        let error = EngineError::from(CredentialError::Expired);
        assert!(core::error::Error::source(&error).is_some());
    }
}
