//! The in-flight window of `WIRE.md` §4.3, and the typed correlation that
//! keeps a response attached to the request it answers.
//!
//! §4.3 states four rules and this module is all four:
//!
//! - `request_id` is chosen by the client, is a **nonzero** `uint32`, and MUST
//!   be unique among that connection's currently in-flight requests. It MAY be
//!   reused once its response has been received.
//! - **Responses may arrive out of order.** A client MUST correlate by
//!   `request_id` and MUST NOT assume ordering: a relay may complete a cheap
//!   `PING` before an expensive `READ` issued earlier, "and will".
//! - A bounded window, `max_inflight` (default 32). Exceeding it is a **fatal**
//!   `ERR_TOO_MANY_INFLIGHT`. The bound is an anti-abuse control as much as a
//!   flow-control one (§13.1): it is what stops one connection from making the
//!   relay allocate unbounded per-request state before any quota check has run.
//! - A duplicate in-flight `request_id` is a fatal `ERR_MALFORMED`.
//!
//! # Why the ticket is typed
//!
//! Out-of-order responses mean a client cannot rely on position, so the only
//! thing tying a response to its request is a `uint32` it chose. If that number
//! is all the correlation there is, then decoding a response body is a guess
//! about what the number meant, and a wrong guess decodes an `AckResponse` as a
//! `SubscribeResponse` — same two `uint64` fields, same length, different
//! meaning, no error anywhere.
//!
//! [`Ticket`] closes that. It is created by [`InFlight::issue`], carries the
//! command as a type parameter, is neither `Clone` nor `Copy`, and is consumed
//! by [`InFlight::complete`], which decodes exactly `C::Response`. Correlating
//! the wrong response to a request stops being a runtime hazard and becomes a
//! type error.

use alloc::collections::BTreeMap;
use core::marker::PhantomData;

use f2z_codec::ErrorCode;
use f2z_codec::canonical::decode_canonical;
use f2z_codec::frame::Response;

use crate::command::RelayCommand;
use crate::error::{ProtoError, Result};

/// §4.3's default `max_inflight`.
pub const DEFAULT_MAX_INFLIGHT: u16 = 32;

/// Proof that a request with this id is outstanding, and a record of which
/// command it was.
///
/// Deliberately not `Clone`, not `Copy`, and with no public constructor: one
/// issued request is one ticket is one response.
#[derive(Debug, PartialEq, Eq)]
pub struct Ticket<C> {
    request_id: u32,
    marker: PhantomData<fn() -> C>,
}

impl<C: RelayCommand> Ticket<C> {
    /// The `request_id` this ticket is for. It is also covered by the signing
    /// transcript of a signed command (§5.1), so it cannot be changed after the
    /// request is built.
    #[must_use]
    pub const fn request_id(&self) -> u32 {
        self.request_id
    }
}

/// One connection's outstanding requests.
///
/// Useful in both directions, which is why it is not called a client: a client
/// uses it to correlate responses, and a relay uses it to enforce §4.3's
/// duplicate and window rules on what arrives. The relay side ignores
/// [`Ticket`] and reads [`InFlight::command_for`].
#[derive(Clone, Debug)]
pub struct InFlight {
    /// `request_id` → the command code it was issued for.
    entries: BTreeMap<u32, u16>,
    max_inflight: u16,
}

impl InFlight {
    /// A window of `max_inflight` outstanding requests.
    #[must_use]
    pub const fn new(max_inflight: u16) -> Self {
        Self {
            entries: BTreeMap::new(),
            max_inflight,
        }
    }

    /// The published bound.
    #[must_use]
    pub const fn max_inflight(&self) -> u16 {
        self.max_inflight
    }

    /// How many requests are outstanding.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether nothing is outstanding.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The command code an outstanding `request_id` was issued for.
    #[must_use]
    pub fn command_for(&self, request_id: u32) -> Option<u16> {
        self.entries.get(&request_id).copied()
    }

    /// Claim a `request_id` for command `C`.
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::Malformed`] — fatal — if `request_id` is zero (that is a
    ///   push's id, §4.3) or is already outstanding.
    /// - [`ErrorCode::TooManyInflight`] — fatal — if the window is full.
    pub fn issue<C: RelayCommand>(&mut self, request_id: u32) -> Result<Ticket<C>> {
        if request_id == 0 {
            return Err(ProtoError::Wire(ErrorCode::Malformed));
        }
        if self.entries.contains_key(&request_id) {
            return Err(ProtoError::Wire(ErrorCode::Malformed));
        }
        if self.entries.len() >= usize::from(self.max_inflight) {
            return Err(ProtoError::Wire(ErrorCode::TooManyInflight));
        }
        self.entries.insert(request_id, C::COMMAND.code());
        Ok(Ticket {
            request_id,
            marker: PhantomData,
        })
    }

    /// Release a `request_id` without a response.
    ///
    /// §2.5: an in-flight command whose response was not received has
    /// **unknown** status. This is how a caller records that it has stopped
    /// waiting — it does not mean the command did not happen, and `APPEND` in
    /// particular is not idempotent (§8.3), so the retry rules apply.
    pub fn cancel<C: RelayCommand>(&mut self, ticket: Ticket<C>) {
        self.entries.remove(&ticket.request_id);
    }

    /// Match a response to its ticket and decode the paired body type.
    ///
    /// `frame_request_id` is the id on the received frame; it is checked
    /// against the ticket rather than trusted, so a relay that answers on the
    /// wrong id cannot get a body decoded as something else.
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::Malformed`] if the frame's id is not the ticket's, if the
    ///   ticket is not outstanding, or if a failing response carried a body
    ///   (§4.1 forbids it).
    /// - The relay's own code, when `status != 0`.
    /// - [`ProtoError::UnknownStatus`] for a nonzero status this build does not
    ///   know. §10 keeps codes stable so that an old client can still record
    ///   one it has never heard of.
    /// - [`ErrorCode::Malformed`] if the body is not a canonical `C::Response`
    ///   (§3.3).
    pub fn complete<C: RelayCommand>(
        &mut self,
        ticket: Ticket<C>,
        frame_request_id: u32,
        response: &Response,
    ) -> Result<C::Response> {
        if frame_request_id != ticket.request_id {
            return Err(ProtoError::Wire(ErrorCode::Malformed));
        }
        if self.entries.remove(&ticket.request_id).is_none() {
            return Err(ProtoError::Wire(ErrorCode::Malformed));
        }
        response.validate()?;
        if !response.is_ok() {
            return Err(match response.error_code() {
                Some(code) => ProtoError::Wire(code),
                None => ProtoError::UnknownStatus(response.status),
            });
        }
        Ok(decode_canonical::<C::Response>(response.body())?.into_value())
    }
}

impl Default for InFlight {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_INFLIGHT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::{Empty, ops};
    use alloc::vec;
    use f2z_codec::canonical::Canonical;
    use f2z_codec::commands::{AckResponse, SubscribeResponse};

    #[test]
    fn ids_are_nonzero_unique_and_bounded() {
        let mut inflight = InFlight::new(2);
        let first = inflight.issue::<ops::Ack>(1).unwrap();
        assert_eq!(
            inflight.issue::<ops::Read>(0).map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
        assert_eq!(
            inflight.issue::<ops::Read>(1).map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Malformed)),
            "a duplicate in-flight id is a fatal ERR_MALFORMED"
        );
        let second = inflight.issue::<ops::Read>(2).unwrap();
        assert_eq!(
            inflight.issue::<ops::Ping>(3).map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::TooManyInflight))
        );

        // Reusable once the response has been received.
        let body = AckResponse {
            next_index: 4,
            pending: 0,
        };
        inflight
            .complete(
                first,
                1,
                &Response::ok(body.encode_canonical().unwrap()).unwrap(),
            )
            .unwrap();
        let third = inflight.issue::<ops::Ping>(1).unwrap();
        inflight.cancel(third);
        inflight.cancel(second);
        assert!(inflight.is_empty());
    }

    #[test]
    fn responses_correlate_out_of_order() {
        let mut inflight = InFlight::default();
        let read = inflight.issue::<ops::Read>(10).unwrap();
        let ping = inflight.issue::<ops::Ping>(11).unwrap();
        assert_eq!(inflight.command_for(10), Some(0x0013));

        // The cheap PING completes first, exactly as §4.3 warns.
        assert_eq!(
            inflight.complete(ping, 11, &Response::ok(vec![]).unwrap()),
            Ok(Empty)
        );
        let body = f2z_codec::commands::ReadResponse {
            messages: vec![].into(),
            has_more: 0,
        };
        assert!(
            inflight
                .complete(
                    read,
                    10,
                    &Response::ok(body.encode_canonical().unwrap()).unwrap()
                )
                .is_ok()
        );
    }

    #[test]
    fn a_response_on_the_wrong_id_is_refused() {
        let mut inflight = InFlight::default();
        let ticket = inflight.issue::<ops::Ping>(5).unwrap();
        assert_eq!(
            inflight.complete(ticket, 6, &Response::ok(vec![]).unwrap()),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }

    #[test]
    fn an_error_status_surfaces_the_relays_code() {
        let mut inflight = InFlight::default();
        let ticket = inflight.issue::<ops::Append>(1).unwrap();
        assert_eq!(
            inflight.complete(ticket, 1, &Response::error(ErrorCode::Unavailable)),
            Err(ProtoError::Wire(ErrorCode::Unavailable))
        );
        // …and the slot is freed, so the client can retry on the same id.
        assert!(inflight.is_empty());
    }

    #[test]
    fn an_unknown_status_is_carried_rather_than_flattened() {
        let mut inflight = InFlight::default();
        let ticket = inflight.issue::<ops::Append>(1).unwrap();
        let response = Response {
            status: 4242,
            body: f2z_codec::types::Body::default(),
        };
        assert_eq!(
            inflight.complete(ticket, 1, &response),
            Err(ProtoError::UnknownStatus(4242))
        );
    }

    #[test]
    fn a_failing_response_may_not_carry_a_body() {
        let mut inflight = InFlight::default();
        let ticket = inflight.issue::<ops::Append>(1).unwrap();
        let response = Response {
            status: ErrorCode::Unavailable.code(),
            body: f2z_codec::types::Body::new(vec![1u8]).unwrap(),
        };
        assert_eq!(
            inflight.complete(ticket, 1, &response),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }

    #[test]
    fn an_append_response_may_not_carry_queue_state() {
        // §6.3: the response body is empty, and that is a requirement rather
        // than an omission. A relay that answered with an index would be
        // handing the sender a weak read capability; `Empty` refuses it.
        let mut inflight = InFlight::default();
        let ticket = inflight.issue::<ops::Append>(1).unwrap();
        let sneaky = SubscribeResponse {
            next_index: 7,
            pending: 3,
        };
        assert_eq!(
            inflight.complete(
                ticket,
                1,
                &Response::ok(sneaky.encode_canonical().unwrap()).unwrap()
            ),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }
}
