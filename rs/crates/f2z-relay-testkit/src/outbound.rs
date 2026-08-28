//! What the engine hands the writer.
//!
//! One type for responses, pushes and keepalives, because the writer applies
//! fault effects uniformly and a second shape would be a second place for them
//! to be forgotten.

use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{PushEvent, QueuedMessage};
use f2z_codec::frame::{Push, RelayFrame, Response};
use f2z_codec::types::QueueAddress;
use f2z_codec::{ErrorCode, commands::MsgPush};

use crate::faults::Effect;

/// What kind of frame this is, and what the writer must know about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutKind {
    /// A response. The effect was already resolved by the engine, which is
    /// where [`Effect::Stall`] has to be decided: a stalled response must leave
    /// its `request_id` outstanding in §4.3's window, and only the engine holds
    /// that.
    Response {
        /// The delivery effect, if a fault selected one.
        effect: Option<Effect>,
    },
    /// An unsolicited push (§6.4). The writer resolves its effect, because a
    /// push is generated deep inside the state under a lock.
    Push {
        /// The event, for the fault lookup. `None` for a code this build does
        /// not know, which cannot happen from our own engine.
        event: Option<PushEvent>,
    },
    /// §2.4's server-driven keepalive. Never faulted: a fault that could stop
    /// the keepalive would look like a hung relay rather than like the fault it
    /// is.
    Keepalive,
    /// A frame whose fault has already been applied — a delayed one coming back
    /// round. Written as-is, so a rule cannot fire twice on one frame.
    Ready,
}

/// One frame on its way out.
#[derive(Clone)]
pub struct Outbound {
    /// The canonical frame bytes (§3.3): the relay encodes once, here.
    pub bytes: Vec<u8>,
    /// What the writer needs to know about it.
    pub kind: OutKind,
    /// Close the connection after writing, with this RFC 6455 status.
    ///
    /// `WIRE.md` §1.3 defines a fatal error as "send the response, then close
    /// the WebSocket connection" and §4.2 fixes status 1003 for a text frame.
    /// It names no status for the other fatal codes; 1002 (protocol error) is
    /// the reading used here and is listed as an ambiguity call.
    pub close_after: Option<u16>,
}

// `bytes` is an encoded relay frame, and for a `MSG` push that is the whole of
// somebody's ciphertext. Reported by length, like `f2z-codec`'s `Payload`.
impl core::fmt::Debug for Outbound {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Outbound")
            .field(
                "bytes",
                &format_args!("<redacted; {} bytes>", self.bytes.len()),
            )
            .field("kind", &self.kind)
            .field("close_after", &self.close_after)
            .finish()
    }
}

impl Outbound {
    /// A response frame.
    #[must_use]
    pub fn response(request_id: u32, response: Response, effect: Option<Effect>) -> Option<Self> {
        Some(Self {
            bytes: RelayFrame::response(request_id, response)
                .encode_canonical()
                .ok()?,
            kind: OutKind::Response { effect },
            close_after: None,
        })
    }

    /// A response that closes the connection after it (§1.3).
    #[must_use]
    pub fn fatal(request_id: u32, code: ErrorCode, status: u16) -> Option<Self> {
        let mut outbound = Self::response(request_id, Response::error(code), None)?;
        outbound.close_after = Some(status);
        Some(outbound)
    }

    /// The keepalive of §2.4.
    #[must_use]
    pub const fn keepalive() -> Self {
        Self {
            bytes: Vec::new(),
            kind: OutKind::Keepalive,
            close_after: None,
        }
    }
}

/// Encode a push frame (§6.4).
#[must_use]
pub fn push<B: Canonical>(event: PushEvent, body: &B) -> Option<Outbound> {
    let frame = RelayFrame::push(Push::new(event.code(), body.encode_canonical().ok()?).ok()?);
    Some(Outbound {
        bytes: frame.encode_canonical().ok()?,
        kind: OutKind::Push { event: Some(event) },
        close_after: None,
    })
}

/// The `MSG` push of §6.4, which goes only to the receive side, ever.
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

/// RFC 6455 status 1002, "protocol error": the close used for every fatal §10
/// code except §4.2's, which fixes 1003.
pub const CLOSE_PROTOCOL_ERROR: u16 = 1002;

/// RFC 6455 status 1003, "unsupported data": §4.2's text frame.
pub const CLOSE_UNSUPPORTED_DATA: u16 = 1003;

/// RFC 6455 status 1000, "normal closure".
pub const CLOSE_NORMAL: u16 = 1000;

/// RFC 6455 status 1001, "going away": §2.4's keepalive giving up on a
/// connection that stopped answering.
///
/// `WIRE.md` names no status for this, so neither value is non-conforming —
/// but this crate is the second implementation the conformance vectors exist to
/// hold in step with `f2z-relay`, and until issue #678 the constant was not
/// defined here at all. A double that cannot express what production does is a
/// gap in the double, not a difference of opinion, so it is pinned to
/// `f2z_relay::transport::CLOSE_GOING_AWAY`'s value.
pub const CLOSE_GOING_AWAY: u16 = 1001;

#[cfg(test)]
mod tests {
    use super::{CLOSE_GOING_AWAY, CLOSE_NORMAL, CLOSE_PROTOCOL_ERROR, CLOSE_UNSUPPORTED_DATA};

    // `f2z-relay`'s `transport.rs` pins the same four values in the same way.
    // Two crates asserting the numbers separately is the point: neither can be
    // renumbered without the other's test noticing.
    #[test]
    fn the_close_codes_are_the_ones_the_sections_name() {
        assert_eq!(CLOSE_UNSUPPORTED_DATA, 1003);
        assert_eq!(CLOSE_PROTOCOL_ERROR, 1002);
        assert_eq!(CLOSE_NORMAL, 1000);
        assert_eq!(CLOSE_GOING_AWAY, 1001);
    }
}
