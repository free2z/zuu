//! Framing — `WIRE.md` §4 — and the `CommandAuth` of §5.1.
//!
//! One binary WebSocket frame carries exactly one request, response or push.
//! There is no in-frame batching and no message that spans frames.
//!
//! ```text
//! enum { request(1), response(2), push(3), (255) } FrameKind;
//!
//! struct {
//!     FrameKind kind;
//!     uint32    request_id;
//!     select (RelayFrame.kind) {
//!         case request:  Request;
//!         case response: Response;
//!         case push:     Push;
//!     } payload;
//! } RelayFrame;
//! ```
//!
//! The `select` is hand-encoded rather than derived: `tls_codec`'s derive would
//! want an enum with its own discriminant, and that would put the tag on the
//! wire twice. `kind` *is* the discriminant.

// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;
use alloc::vec::Vec;

use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsDeserializeBytes,
    TlsSerializeBytes, TlsSize,
};

use crate::commands::Command;
use crate::error::{CodecError, ErrorCode};
use crate::types::{Body, Nonce, PublicKey, QueueAddress, Signature};

/// `enum { request(1), response(2), push(3), (255) } FrameKind;`
///
/// The `(255)` in the specification fixes the width at one byte; it is not a
/// variant. An unrecognized value is a fatal `ERR_MALFORMED`, because it
/// selects a body this build cannot parse — unlike an unknown *command* code,
/// which is a non-fatal `ERR_UNKNOWN_COMMAND` (§3.5) precisely because its body
/// is still well-formed framing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FrameKind {
    /// A client-issued request.
    Request,
    /// A relay's response, correlated by `request_id`.
    Response,
    /// An unsolicited server push. `request_id` is 0 (§4.3).
    Push,
}

impl FrameKind {
    /// The wire byte.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Request => 1,
            Self::Response => 2,
            Self::Push => 3,
        }
    }

    /// Parse the wire byte.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] for anything other than 1, 2 or 3.
    pub const fn from_code(code: u8) -> Result<Self, CodecError> {
        Ok(match code {
            1 => Self::Request,
            2 => Self::Response,
            3 => Self::Push,
            _ => return Err(CodecError::InvalidValue),
        })
    }
}

/// ```text
/// struct {
///     uint16      command;
///     CommandAuth auth;
///     opaque      body<0..2^24-1>;
/// } Request;
/// ```
///
/// `command` is a raw `u16`, not an enum. §3.5 requires a relay to answer an
/// unknown command code with a *non-fatal* `ERR_UNKNOWN_COMMAND`; decoding it
/// as an enum would turn that into a fatal decode failure and would break
/// re-encode equality for a frame that is, at the framing layer, perfectly
/// well-formed. Use [`Request::command`] to resolve it when this build knows it.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct Request {
    /// The command code (§6). Raw, so unknown codes survive the round trip.
    pub command: u16,
    /// Unsigned, or an Ed25519 `SignedAuth` over the §5.1 transcript.
    pub auth: CommandAuth,
    /// The command body, encoded per §6. Opaque at this layer.
    pub body: Body,
}

impl Request {
    /// Build a request.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the body exceeds `2^24 - 1` bytes.
    pub fn new(
        command: u16,
        auth: CommandAuth,
        body: impl Into<Vec<u8>>,
    ) -> Result<Self, CodecError> {
        Ok(Self {
            command,
            auth,
            body: Body::new(body)?,
        })
    }

    /// The command, if this build knows the code.
    ///
    /// `None` means `ERR_UNKNOWN_COMMAND` (non-fatal), not `ERR_MALFORMED`.
    #[must_use]
    pub const fn command(&self) -> Option<Command> {
        Command::from_code(self.command)
    }

    /// The body bytes.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        self.body.as_slice()
    }
}

/// ```text
/// struct {
///     uint16 status;            /* 0 = ok; otherwise an error code from §10 */
///     opaque body<0..2^24-1>;   /* MUST be empty when status != 0 */
/// } Response;
/// ```
///
/// §4.1: error responses carry a code and nothing else. There is no
/// human-readable message field, deliberately — a free-text field on an
/// unauthenticated path is a covert channel out of the relay, a fingerprinting
/// surface, and a place where implementations leak internal state by accident.
///
/// The "MUST be empty when status != 0" rule is a *validity* rule, not an
/// encoding rule: [`Response::validate`] enforces it, and the decoder does not,
/// so a non-conforming response from a peer is rejected by the same
/// `ERR_MALFORMED` path as everything else rather than being unrepresentable.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct Response {
    /// 0 for success, otherwise an [`ErrorCode`] from §10.
    pub status: u16,
    /// The response body. Empty whenever `status != 0`.
    pub body: Body,
}

impl Response {
    /// A successful response carrying `body`.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the body exceeds `2^24 - 1` bytes.
    pub fn ok(body: impl Into<Vec<u8>>) -> Result<Self, CodecError> {
        Ok(Self {
            status: 0,
            body: Body::new(body)?,
        })
    }

    /// An error response: a code and nothing else (§4.1).
    #[must_use]
    pub fn error(code: ErrorCode) -> Self {
        Self {
            status: code.code(),
            body: Body::default(),
        }
    }

    /// Whether this response reports success.
    #[must_use]
    pub const fn is_ok(&self) -> bool {
        self.status == 0
    }

    /// The error code, if this build knows it and the status is not 0.
    #[must_use]
    pub const fn error_code(&self) -> Option<ErrorCode> {
        if self.status == 0 {
            None
        } else {
            ErrorCode::from_code(self.status)
        }
    }

    /// The response body.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        self.body.as_slice()
    }

    /// Check §4.1's "body MUST be empty when status != 0".
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] when a failing response carries a body.
    pub fn validate(&self) -> Result<(), CodecError> {
        if self.status != 0 && !self.body.is_empty() {
            return Err(CodecError::InvalidValue);
        }
        Ok(())
    }
}

/// ```text
/// struct {
///     uint16 event;
///     opaque body<0..2^24-1>;
/// } Push;
/// ```
///
/// `event` is raw for the same reason [`Request::command`] is: a client that
/// does not know an event must ignore it, not tear down the connection.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct Push {
    /// The event code (§6.4).
    pub event: u16,
    /// The event body, encoded per §6.4.
    pub body: Body,
}

impl Push {
    /// Build a push frame body.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the body exceeds `2^24 - 1` bytes.
    pub fn new(event: u16, body: impl Into<Vec<u8>>) -> Result<Self, CodecError> {
        Ok(Self {
            event,
            body: Body::new(body)?,
        })
    }

    /// The event, if this build knows the code.
    #[must_use]
    pub const fn event(&self) -> Option<crate::commands::PushEvent> {
        crate::commands::PushEvent::from_code(self.event)
    }

    /// The body bytes.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        self.body.as_slice()
    }
}

/// The body of a [`RelayFrame`], selected by its [`FrameKind`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FramePayload {
    /// `case request: Request;`
    Request(Request),
    /// `case response: Response;`
    Response(Response),
    /// `case push: Push;`
    Push(Push),
}

impl FramePayload {
    /// The `FrameKind` that selects this payload.
    #[must_use]
    pub const fn kind(&self) -> FrameKind {
        match self {
            Self::Request(_) => FrameKind::Request,
            Self::Response(_) => FrameKind::Response,
            Self::Push(_) => FrameKind::Push,
        }
    }
}

/// One protocol unit: exactly one binary WebSocket frame (`WIRE.md` §4.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayFrame {
    /// Client-chosen, nonzero, unique among in-flight requests (§4.3). Zero on
    /// pushes.
    pub request_id: u32,
    /// The framed request, response or push.
    pub payload: FramePayload,
}

impl RelayFrame {
    /// A request frame.
    #[must_use]
    pub const fn request(request_id: u32, request: Request) -> Self {
        Self {
            request_id,
            payload: FramePayload::Request(request),
        }
    }

    /// A response frame.
    #[must_use]
    pub const fn response(request_id: u32, response: Response) -> Self {
        Self {
            request_id,
            payload: FramePayload::Response(response),
        }
    }

    /// A push frame. §4.3: pushes use `request_id = 0`.
    #[must_use]
    pub const fn push(push: Push) -> Self {
        Self {
            request_id: 0,
            payload: FramePayload::Push(push),
        }
    }

    /// This frame's kind.
    #[must_use]
    pub const fn kind(&self) -> FrameKind {
        self.payload.kind()
    }

    /// Check §4.3's `request_id` rules: nonzero on requests and responses, zero
    /// on pushes.
    ///
    /// Separate from decoding on purpose. A relay answers a bad `request_id`
    /// with `ERR_MALFORMED`, and it can only do that if it decoded the frame
    /// far enough to know which `request_id` to answer on.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] when the rule is broken.
    pub const fn validate(&self) -> Result<(), CodecError> {
        let ok = match self.payload {
            FramePayload::Push(_) => self.request_id == 0,
            FramePayload::Request(_) | FramePayload::Response(_) => self.request_id != 0,
        };
        if ok {
            Ok(())
        } else {
            Err(CodecError::InvalidValue)
        }
    }
}

impl Size for RelayFrame {
    fn tls_serialized_len(&self) -> usize {
        let payload = match &self.payload {
            FramePayload::Request(request) => request.tls_serialized_len(),
            FramePayload::Response(response) => response.tls_serialized_len(),
            FramePayload::Push(push) => push.tls_serialized_len(),
        };
        // 1 byte kind + 4 byte request_id + payload.
        payload.saturating_add(5)
    }
}

impl SerializeBytes for RelayFrame {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        let mut out = Vec::with_capacity(self.tls_serialized_len());
        out.push(self.kind().code());
        out.extend_from_slice(&self.request_id.to_be_bytes());
        match &self.payload {
            FramePayload::Request(request) => {
                out.extend_from_slice(&request.tls_serialize_bytes()?)
            }
            FramePayload::Response(response) => {
                out.extend_from_slice(&response.tls_serialize_bytes()?)
            }
            FramePayload::Push(push) => out.extend_from_slice(&push.tls_serialize_bytes()?),
        }
        Ok(out)
    }
}

impl DeserializeBytes for RelayFrame {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (kind, rest) = u8::tls_deserialize_bytes(bytes)?;
        let kind =
            FrameKind::from_code(kind).map_err(|_| TlsError::UnknownValue(u64::from(kind)))?;
        let (request_id, rest) = u32::tls_deserialize_bytes(rest)?;
        let (payload, rest) = match kind {
            FrameKind::Request => {
                let (value, rest) = Request::tls_deserialize_bytes(rest)?;
                (FramePayload::Request(value), rest)
            }
            FrameKind::Response => {
                let (value, rest) = Response::tls_deserialize_bytes(rest)?;
                (FramePayload::Response(value), rest)
            }
            FrameKind::Push => {
                let (value, rest) = Push::tls_deserialize_bytes(rest)?;
                (FramePayload::Push(value), rest)
            }
        };
        Ok((
            Self {
                request_id,
                payload,
            },
            rest,
        ))
    }
}

/// ```text
/// struct {
///     opaque address[32];
///     opaque signer_key[32];
///     uint64 timestamp_ms;
///     opaque nonce[16];
///     opaque signature[64];
/// } SignedAuth;
/// ```
///
/// `WIRE.md` §5.1. The signature is over a [`CommandTranscript`], which is not
/// transmitted: the relay reconstructs it from its own `relay_id`, its own
/// computed `channel_binding`, and these fields.
///
/// [`CommandTranscript`]: crate::transcript::CommandTranscript
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignedAuth {
    /// The queue address acted on; zeros where none (§5.1, `CREATE_QUEUE`).
    pub address: QueueAddress,
    /// The Ed25519 public key claimed to authorize this command.
    pub signer_key: PublicKey,
    /// Client clock, milliseconds since the Unix epoch. Checked against
    /// `clock_skew_ms` (§5.5).
    pub timestamp_ms: u64,
    /// Client CSPRNG, fresh per command. Half of the seen-set key (§5.5).
    pub nonce: Nonce,
    /// Ed25519 over the transcript.
    pub signature: Signature,
}

/// ```text
/// struct {
///     uint8 present;                 /* 0 = unsigned command, 1 = signed */
///     select (CommandAuth.present) {
///         case 0: struct {};
///         case 1: SignedAuth;
///     } auth;
/// } CommandAuth;
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CommandAuth {
    /// `present = 0`. `HELLO`, `GET_CAPABILITIES`, `GET_CHALLENGE`, `PING` and
    /// `CONTACT_APPEND` (which is gated by proof of work instead, §12.2).
    Unsigned,
    /// `present = 1`.
    Signed(SignedAuth),
}

impl CommandAuth {
    /// The `present` byte.
    #[must_use]
    pub const fn present(&self) -> u8 {
        match self {
            Self::Unsigned => 0,
            Self::Signed(_) => 1,
        }
    }

    /// The signed authenticator, if there is one.
    #[must_use]
    pub const fn signed(&self) -> Option<&SignedAuth> {
        match self {
            Self::Unsigned => None,
            Self::Signed(auth) => Some(auth),
        }
    }
}

impl Size for CommandAuth {
    fn tls_serialized_len(&self) -> usize {
        match self {
            Self::Unsigned => 1,
            Self::Signed(auth) => auth.tls_serialized_len().saturating_add(1),
        }
    }
}

impl SerializeBytes for CommandAuth {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        let mut out = Vec::with_capacity(self.tls_serialized_len());
        out.push(self.present());
        if let Self::Signed(auth) = self {
            out.extend_from_slice(&auth.tls_serialize_bytes()?);
        }
        Ok(out)
    }
}

impl DeserializeBytes for CommandAuth {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (present, rest) = u8::tls_deserialize_bytes(bytes)?;
        match present {
            0 => Ok((Self::Unsigned, rest)),
            1 => {
                let (auth, rest) = SignedAuth::tls_deserialize_bytes(rest)?;
                Ok((Self::Signed(auth), rest))
            }
            // Not "default to unsigned". §3.3 names exactly this — an unknown
            // variant byte silently mapped to a default — as the class of bug
            // re-encode equality exists to kill.
            other => Err(TlsError::UnknownValue(u64::from(other))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::{Canonical, decode_canonical};
    use alloc::vec;

    fn signed_auth() -> SignedAuth {
        SignedAuth {
            address: QueueAddress::new([1u8; 32]),
            signer_key: PublicKey::new([2u8; 32]),
            timestamp_ms: 1_700_000_000_000,
            nonce: Nonce::new([3u8; 16]),
            signature: Signature::new([4u8; 64]),
        }
    }

    #[test]
    fn frame_kind_rejects_unknown_bytes() {
        for code in [0u8, 4, 255] {
            assert!(FrameKind::from_code(code).is_err());
        }
        let mut bytes = RelayFrame::response(1, Response::error(ErrorCode::Quota))
            .encode_canonical()
            .unwrap();
        bytes[0] = 9;
        assert_eq!(
            decode_canonical::<RelayFrame>(&bytes),
            Err(CodecError::Decode)
        );
    }

    #[test]
    fn command_auth_present_byte_has_exactly_two_values() {
        let unsigned = CommandAuth::Unsigned.encode_canonical().unwrap();
        assert_eq!(unsigned, vec![0]);
        let signed = CommandAuth::Signed(signed_auth())
            .encode_canonical()
            .unwrap();
        assert_eq!(signed.len(), 1 + 32 + 32 + 8 + 16 + 64);
        assert_eq!(signed[0], 1);

        // present = 2 must not become "unsigned with trailing junk".
        assert_eq!(
            decode_canonical::<CommandAuth>(&[2]),
            Err(CodecError::Decode)
        );
    }

    #[test]
    fn frames_round_trip_canonically() {
        let request =
            Request::new(0x0021, CommandAuth::Signed(signed_auth()), vec![9u8; 64]).unwrap();
        let frame = RelayFrame::request(17, request);
        let bytes = frame.encode_canonical().unwrap();
        let decoded = decode_canonical::<RelayFrame>(&bytes).unwrap();
        assert_eq!(decoded.value(), &frame);
        assert_eq!(decoded.bytes(), bytes.as_slice());
        assert_eq!(bytes.len(), frame.tls_serialized_len());
    }

    #[test]
    fn request_id_rules_of_section_4_3() {
        assert!(
            RelayFrame::push(Push::new(0x0082, vec![]).unwrap())
                .validate()
                .is_ok()
        );
        let bad_push = RelayFrame {
            request_id: 1,
            payload: FramePayload::Push(Push::new(0x0082, vec![]).unwrap()),
        };
        assert_eq!(bad_push.validate(), Err(CodecError::InvalidValue));
        assert_eq!(
            RelayFrame::response(0, Response::error(ErrorCode::Internal)).validate(),
            Err(CodecError::InvalidValue)
        );
    }

    #[test]
    fn an_error_response_may_not_carry_a_body() {
        assert!(Response::error(ErrorCode::Unavailable).validate().is_ok());
        assert!(Response::ok(vec![1, 2, 3]).unwrap().validate().is_ok());
        let bad = Response {
            status: ErrorCode::Unavailable.code(),
            body: Body::new(vec![1]).unwrap(),
        };
        assert_eq!(bad.validate(), Err(CodecError::InvalidValue));
    }

    #[test]
    fn an_unknown_command_code_still_round_trips() {
        // §3.5: unknown command => non-fatal ERR_UNKNOWN_COMMAND, which is only
        // possible if the frame decoded and re-encoded cleanly first.
        let request = Request::new(0xbeef, CommandAuth::Unsigned, vec![]).unwrap();
        assert_eq!(request.command(), None);
        let bytes = RelayFrame::request(3, request).encode_canonical().unwrap();
        assert!(decode_canonical::<RelayFrame>(&bytes).is_ok());
    }
}
