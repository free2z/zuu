//! What this crate can refuse to do, and which of those refusals travel.
//!
//! There are exactly two kinds, and keeping them apart is the point of this
//! module:
//!
//! - A **wire refusal** is one a relay answers with a `uint16` from
//!   [`WIRE.md` §10][s10]. It carries an [`ErrorCode`] and nothing else,
//!   because §4.1 forbids a free-text field on the unauthenticated path.
//! - A **client refusal** is a decision a *client* makes about a relay —
//!   §2.5's `relay_id` mismatch, §11.3's capability checks. It never travels;
//!   the client simply does not connect, or disconnects. Giving these their own
//!   type is what stops one of them from being reported to a peer as though it
//!   were a protocol error.
//!
//! [s10]: https://github.com/free2z/zuu/blob/main/docs/e2ee/WIRE.md

use core::fmt;

use f2z_codec::{CodecError, ErrorCode};

/// Anything this crate refuses to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProtoError {
    /// A refusal with a §10 code. On a relay this is what goes in the
    /// [`Response`]; on a client it is the code that came back.
    ///
    /// [`Response`]: f2z_codec::frame::Response
    Wire(ErrorCode),
    /// A client's decision about a relay (§2.5, §5.2, §11.3). Never sent.
    Refused(Refusal),
    /// A response carried a nonzero `status` this build does not know.
    ///
    /// Not a failure of the peer. §10 keeps codes stable forever precisely so
    /// that "a client in the field, a log archive, and a bug report from two
    /// years ago must all still mean the same thing", which means a client
    /// older than a code must be able to carry it around and log it rather than
    /// flatten it into something it is not.
    UnknownStatus(u16),
}

impl ProtoError {
    /// The §10 code a relay would put on the wire, if this refusal has one.
    ///
    /// [`Refusal`] deliberately has none: a client that declines a relay owes
    /// that relay no explanation, and inventing a code for it would put a
    /// client-side policy decision into a protocol field.
    #[must_use]
    pub const fn wire_code(self) -> Option<ErrorCode> {
        match self {
            Self::Wire(code) => Some(code),
            Self::Refused(_) | Self::UnknownStatus(_) => None,
        }
    }

    /// Whether a relay answering this must also close the connection (§1.3).
    #[must_use]
    pub const fn is_fatal(self) -> bool {
        match self {
            Self::Wire(code) => code.is_fatal(),
            Self::Refused(_) | Self::UnknownStatus(_) => false,
        }
    }
}

impl From<ErrorCode> for ProtoError {
    fn from(code: ErrorCode) -> Self {
        Self::Wire(code)
    }
}

impl From<Refusal> for ProtoError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<CodecError> for ProtoError {
    /// Every codec failure already knows its own wire code — §3.3's re-encode
    /// mismatch is `ERR_MALFORMED`, a bad payload length is `ERR_BAD_SIZE` —
    /// so this conversion never has to choose one.
    fn from(error: CodecError) -> Self {
        Self::Wire(error.error_code())
    }
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Wire(code) => write!(f, "{code}"),
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::UnknownStatus(status) => {
                write!(
                    f,
                    "relay answered with status {status}, which this build does not know"
                )
            }
        }
    }
}

impl core::error::Error for ProtoError {}

/// A client's reason for refusing a relay.
///
/// Every variant is a MUST or a SHOULD from the specification, and each one
/// names the section it comes from. None of them is a wire code: they are the
/// answers to "should this client talk to this relay at all", asked before and
/// during a connection, and the only action they support is refusing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Refusal {
    /// §2.5 / §5.2: the relay's `relay_id` is not the one the peer's in-band
    /// advert named. Fatal, and MUST be surfaced rather than retried against —
    /// the relay was substituted at the DNS or TLS layer.
    RelayIdMismatch,
    /// §6.1: `relay_id` is not `H("free2z/relay/v1/relay-id",
    /// relay_identity_pk)`. The relay contradicted itself in one frame.
    RelayIdNotDerived,
    /// §5.2: `relay_proof` did not verify, so the relay has not proved
    /// possession of the identity key it claims. Without this proof the
    /// `relay_id` binding is decoration.
    RelayProofInvalid,
    /// §5.2: the relay's identity key is not a valid Ed25519 public key.
    RelayKeyInvalid,
    /// §2.5 / §3.5: the relay selected a version outside the range the client
    /// offered, or one it does not implement.
    VersionNotOffered,
    /// §5.3: `channel_binding_mode` is `tls-exporter` but the value handed in
    /// is 32 zero bytes, or it is `none` and the value is not.
    ChannelBindingMismatch,
    /// §2.3: `transport_security = none` without the explicit per-relay user
    /// opt-in that section requires.
    InsecureTransport,
    /// §5.3 / §11.3 step 3: `channel_binding_mode = none` under a strict
    /// client policy.
    NoChannelBinding,
    /// §5.5: `antireplay_persistence = volatile` under a strict client policy —
    /// a restart reopens a replay window of `clock_skew_ms`.
    VolatileAntiReplay,
    /// §5.5 / §11.1: `antireplay_window_ms` is shorter than `2 ×
    /// clock_skew_ms`, so seen-set entries age out while the frames they cover
    /// are still inside the timestamp window.
    ///
    /// **`WIRE.md` does not state this relation and it should** — see
    /// [`SeenSet::retention_is_sound`]. Reported as a client-side refusal
    /// rather than as a document-validity failure, because the document is
    /// exactly what the specification permits; it is the specification that is
    /// missing the constraint.
    ///
    /// [`SeenSet::retention_is_sound`]: crate::replay::SeenSet::retention_is_sound
    AntiReplayWindowTooShort,
    /// §11.3 step 4: the relay's `padding_sizes` is not a superset of the
    /// sizes this client emits.
    PaddingNotSuperset,
    /// §9 / §11.3 step 4: the relay's `padding_sizes` is fine-grained enough
    /// to be indistinguishable from a covert length channel.
    PaddingImplausible,
    /// §11.3 step 5: `max_message_ttl_seconds` exceeds the architecture's
    /// 30-day ceiling. The relay is claiming a policy the architecture forbids.
    TtlCeilingExceeded,
    /// §11.1: the capability document is internally inconsistent — a mode byte
    /// outside its defined range, a TTL band whose default sits outside its own
    /// clamps, a `padding_sizes` that is not ascending.
    CapabilitiesInconsistent,
    /// §11.1: the document's signature does not verify under
    /// `relay_identity_pk`.
    CapabilitiesSignatureInvalid,
    /// §6.1 / §11.2: `capabilities_digest` does not match the document the
    /// relay served. Either the two representations disagree (§11.2) or the
    /// document changed under the client mid-connection.
    CapabilitiesDigestMismatch,
    /// §13.1: the relay demands a proof-of-work algorithm v1 does not define,
    /// so no conforming client can create a queue on it.
    PowAlgorithmUnknown,
    /// §13.1: `queue_creation_mode = token`. Not invalid — a token is an
    /// operator-issued bearer credential and a closed deployment may want one —
    /// but it is an identifier that links every queue created with it, so a
    /// client whose policy is unlinkability refuses.
    QueueCreationTokenGated,
}

impl Refusal {
    /// The section of `WIRE.md` this refusal comes from, for logs and UI.
    #[must_use]
    pub const fn section(self) -> &'static str {
        match self {
            Self::RelayIdMismatch => "§2.5, §5.2",
            Self::RelayIdNotDerived | Self::CapabilitiesDigestMismatch => "§6.1",
            Self::RelayProofInvalid | Self::RelayKeyInvalid => "§5.2",
            Self::VersionNotOffered => "§3.5",
            Self::ChannelBindingMismatch | Self::NoChannelBinding => "§5.3",
            Self::InsecureTransport => "§2.3",
            Self::VolatileAntiReplay | Self::AntiReplayWindowTooShort => "§5.5",
            Self::PaddingNotSuperset | Self::PaddingImplausible => "§9",
            Self::TtlCeilingExceeded => "§11.3",
            Self::CapabilitiesInconsistent | Self::CapabilitiesSignatureInvalid => "§11.1",
            Self::PowAlgorithmUnknown | Self::QueueCreationTokenGated => "§13.1",
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::RelayIdMismatch => "relay_id does not match the peer's advert",
            Self::RelayIdNotDerived => "relay_id is not the digest of relay_identity_pk",
            Self::RelayProofInvalid => "the relay did not prove possession of its identity key",
            Self::RelayKeyInvalid => "relay_identity_pk is not a valid Ed25519 public key",
            Self::VersionNotOffered => "the relay selected a protocol version we did not offer",
            Self::ChannelBindingMismatch => "channel_binding_mode disagrees with the binding value",
            Self::InsecureTransport => "the relay serves without TLS and was not opted into",
            Self::NoChannelBinding => "the relay cannot bind commands to the TLS session",
            Self::VolatileAntiReplay => "the relay's seen-set does not survive a restart",
            Self::AntiReplayWindowTooShort => {
                "antireplay_window_ms is shorter than twice clock_skew_ms"
            }
            Self::PaddingNotSuperset => "padding_sizes does not cover the sizes this client emits",
            Self::PaddingImplausible => "padding_sizes is fine-grained enough to leak length",
            Self::TtlCeilingExceeded => "max_message_ttl_seconds exceeds the 30-day ceiling",
            Self::CapabilitiesInconsistent => "the capability document contradicts itself",
            Self::CapabilitiesSignatureInvalid => "the capability document's signature is invalid",
            Self::CapabilitiesDigestMismatch => "capabilities_digest does not match the document",
            Self::PowAlgorithmUnknown => "the relay demands a proof-of-work v1 does not define",
            Self::QueueCreationTokenGated => "the relay gates queue creation on a linkable token",
        };
        write!(f, "refused the relay ({}): {text}", self.section())
    }
}

impl core::error::Error for Refusal {}

/// The result of everything in this crate.
pub type Result<T> = core::result::Result<T, ProtoError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_failures_keep_the_code_the_codec_chose() {
        assert_eq!(
            ProtoError::from(CodecError::NotCanonical).wire_code(),
            Some(ErrorCode::Malformed)
        );
        assert_eq!(
            ProtoError::from(CodecError::BadSize).wire_code(),
            Some(ErrorCode::BadSize)
        );
    }

    #[test]
    fn a_client_refusal_has_no_wire_code_and_is_not_fatal_to_a_peer() {
        let refusal = ProtoError::from(Refusal::RelayIdMismatch);
        assert_eq!(refusal.wire_code(), None);
        assert!(!refusal.is_fatal());
    }

    #[test]
    fn fatality_comes_from_the_code_not_from_this_type() {
        assert!(ProtoError::from(ErrorCode::Malformed).is_fatal());
        assert!(!ProtoError::from(ErrorCode::BadSize).is_fatal());
    }
}
