//! What the engine hands the writer task.
//!
//! One type for responses, pushes and keepalives, because the writer's rules —
//! write it, then close if the frame said to — should exist once.

use f2z_codec::ErrorCode;
use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{MsgPush, PushEvent, QueuedMessage};
use f2z_codec::frame::{Push, RelayFrame, Response};
use f2z_codec::types::QueueAddress;

use crate::transport::WireMessage;

/// One frame on its way out.
#[derive(Clone)]
pub struct Outbound {
    /// What to write. `None` for a frame that is only a close — see
    /// [`Outbound::close`].
    pub message: Option<WireMessage>,
    /// Close the connection after writing, with this RFC 6455 status (§1.3).
    pub close_after: Option<u16>,
}

// `message` is an encoded frame, and for a `MSG` push that is the whole of
// somebody's ciphertext. `WireMessage`'s own `Debug` redacts it; this delegates.
impl core::fmt::Debug for Outbound {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Outbound")
            .field("message", &self.message)
            .field("close_after", &self.close_after)
            .finish()
    }
}

impl Outbound {
    /// A response frame.
    ///
    /// `None` for a zero `request_id`: §4.3 gives zero to pushes and requires a
    /// response to carry the nonzero id of the request it answers. The guard
    /// lives here rather than at each caller because this is the one place a
    /// response becomes bytes — [`Outbound::fatal`] already refused it on the
    /// error path while the success path passed the client's id straight
    /// through (zuu#716). Callers that cannot build a response fall back to
    /// their fatal path, which closes the connection when the id is unusable.
    #[must_use]
    pub fn response(request_id: u32, response: Response) -> Option<Self> {
        if request_id == 0 {
            return None;
        }
        Some(Self {
            message: Some(WireMessage::Binary(
                RelayFrame::response(request_id, response)
                    .encode_canonical()
                    .ok()?,
            )),
            close_after: None,
        })
    }

    /// A response that closes the connection after it (§1.3).
    #[must_use]
    pub fn fatal(request_id: u32, code: ErrorCode, status: u16) -> Option<Self> {
        let mut outbound = Self::response(request_id, Response::error(code))?;
        outbound.close_after = Some(status);
        Some(outbound)
    }

    /// A bare close, for a frame whose `request_id` could not be recovered.
    ///
    /// §1.3 says a fatal error sends the response and then closes; §4.3 forbids
    /// a zero `request_id` on a response frame. For a frame under five bytes,
    /// or a text frame, there is no value satisfying both. This relay closes
    /// with no response frame, which is the reading `f2z-relay-testkit` also
    /// took — recorded as an ambiguity call, and tracked in
    /// [#586](https://github.com/free2z/zuu/issues/586).
    #[must_use]
    pub const fn close(status: u16) -> Self {
        Self {
            message: None,
            close_after: Some(status),
        }
    }

    /// §2.4's keepalive.
    #[must_use]
    pub const fn ping() -> Self {
        Self {
            message: Some(WireMessage::Ping(Vec::new())),
            close_after: None,
        }
    }

    /// The answer to a client's own Ping.
    #[must_use]
    pub const fn pong(payload: Vec<u8>) -> Self {
        Self {
            message: Some(WireMessage::Pong(payload)),
            close_after: None,
        }
    }
}

/// Encode a push frame (§6.4).
#[must_use]
pub fn push<B: Canonical>(event: PushEvent, body: &B) -> Option<Outbound> {
    let frame = RelayFrame::push(Push::new(event.code(), body.encode_canonical().ok()?).ok()?);
    Some(Outbound {
        message: Some(WireMessage::Binary(frame.encode_canonical().ok()?)),
        close_after: None,
    })
}

/// The `MSG` push of §6.4, which goes only to the receive side, ever.
///
/// §6.4: *"There is no push to a sender, ever — a push to a sender would be a
/// channel that tells it something about queue state, which §6.3 forbids."*
/// This function takes a `recv_addr` and there is no sender-side counterpart to
/// call by mistake.
#[must_use]
pub fn msg_push(recv_addr: QueueAddress, message: &QueuedMessage) -> Option<Outbound> {
    push(
        PushEvent::Msg,
        &MsgPush {
            recv_addr,
            msg: message.clone(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_codec::canonical::decode_canonical;
    use f2z_codec::frame::FramePayload;
    use f2z_codec::types::Payload;

    #[test]
    fn a_fatal_response_carries_the_code_and_then_closes() {
        let outbound = Outbound::fatal(7, ErrorCode::Malformed, 1002).unwrap();
        assert_eq!(outbound.close_after, Some(1002));
        let Some(WireMessage::Binary(bytes)) = &outbound.message else {
            panic!("expected a binary frame");
        };
        let frame = decode_canonical::<RelayFrame>(bytes).unwrap().into_value();
        assert_eq!(frame.request_id, 7);
        let FramePayload::Response(response) = frame.payload else {
            panic!("expected a response");
        };
        assert_eq!(response.error_code(), Some(ErrorCode::Malformed));
        // §4.1: an error response carries a code and nothing else.
        assert!(response.body().is_empty());
    }

    #[test]
    fn an_unrecoverable_frame_closes_without_a_response() {
        let outbound = Outbound::close(1003);
        assert!(outbound.message.is_none());
        assert_eq!(outbound.close_after, Some(1003));
    }

    #[test]
    fn a_message_push_never_renders_the_ciphertext() {
        let message = QueuedMessage {
            index: 0,
            received_at_ms: 1,
            payload: Payload::new(vec![0xde, 0xad, 0xbe, 0xef]).unwrap(),
        };
        let outbound = msg_push(QueueAddress::new([1u8; 32]), &message).unwrap();
        let rendered = format!("{outbound:?}");
        assert!(rendered.contains("<redacted"));
        assert!(!rendered.contains("222"));
    }

    #[test]
    fn a_response_may_never_carry_a_pushs_request_id() {
        // zuu#716. §4.3 reserves zero for pushes. `fatal()` refused it on the
        // error path; the success path handed the client's id straight to
        // `response`, so a request arriving with `request_id = 0` would have
        // been answered on a frame `outbound.rs`'s own comment calls forbidden.
        // Refused where a response becomes bytes, so both paths inherit it.
        assert!(Outbound::response(0, Response::ok(vec![]).unwrap()).is_none());
        assert!(
            Outbound::fatal(
                0,
                ErrorCode::Malformed,
                crate::transport::CLOSE_PROTOCOL_ERROR
            )
            .is_none()
        );

        // …and a real id still works, so the guard is the id and not the frame.
        assert!(Outbound::response(1, Response::ok(vec![]).unwrap()).is_some());
    }

    #[test]
    fn a_push_frame_uses_request_id_zero() {
        let outbound = push(
            PushEvent::Notice,
            &f2z_codec::commands::NoticePush { kind: 3, at_ms: 9 },
        )
        .unwrap();
        let Some(WireMessage::Binary(bytes)) = &outbound.message else {
            panic!("expected a binary frame");
        };
        let frame = decode_canonical::<RelayFrame>(bytes).unwrap().into_value();
        assert_eq!(frame.request_id, 0);
        assert!(frame.validate().is_ok());
    }
}
