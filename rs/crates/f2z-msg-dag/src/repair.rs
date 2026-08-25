//! `gap_request` and `gap_response` — the bodies of §7's repair exchange.
//!
//! These are the `body` of an [`AppMessage`] whose `type` is
//! [`MessageType::GAP_REQUEST`] or [`MessageType::GAP_RESPONSE`]. They travel
//! inside MLS like everything else, so they are confidential and authenticated
//! by the sender's leaf key.
//!
//! # The check that makes repair safe to accept
//!
//! A repaired message arrives outside its original framing: MLS authenticated
//! the `gap_response`, not the message inside it. What stops a peer answering
//! "here is the message you missed" with something the original sender never
//! wrote is not the framing — it is that the requester **already knows the
//! name** of what it is missing. A dangling parent *is* a `msg_id`, `msg_id` is
//! a BLAKE2b-256 commitment over the content, and
//! [`GapResponse::accept`] refuses anything that does not hash to the id that
//! was asked for.
//!
//! That is a real property and it is worth stating precisely, because it is
//! narrower than it first looks. It proves the **content** is the content the
//! original sender committed to. It does not prove who is repairing, and it
//! does not recover the original `sender_leaf_index` — see
//! [`crate::dag::DagEntry::from_repair`] for the ordering consequence, which is
//! the one open question §7 leaves here.
//!
//! # Every hash gets an answer
//!
//! §8.4 requires an unrecoverable gap to become an explicit marker rather than
//! a silent hole, so a [`GapResponse`] answers *every* requested hash: either
//! with the original message or with [`RepairEntry::Unrecoverable`]. A
//! responder that simply omits what it cannot supply leaves the requester
//! unable to distinguish "gone" from "still in flight", which is the
//! distinction §8.4 exists to preserve.

use alloc::vec::Vec;
use core::fmt;

use f2z_codec::canonical::Canonical;
use f2z_codec::types::Body;
use f2z_codec::vec::VecU16;
use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsDeserializeBytes,
    TlsSerializeBytes, TlsSize,
};

use crate::error::DagError;
use crate::message::{AppMessage, MessageType, MsgId};
use crate::outbox::Unrecoverable;

// `tls_codec`'s derive macros build their error strings with `format!`.
use alloc::format;

/// §7's `gap_request{hashes}`.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct GapRequest {
    hashes: VecU16<MsgId>,
}

impl GapRequest {
    /// The most hashes one request may carry, capped by the length prefix.
    pub const MAX: usize = 2047;

    /// Build a request over a set of missing hashes.
    ///
    /// Sorted and deduplicated, for the same reason
    /// [`crate::message::Parents`] is: this is the body of a message whose
    /// `msg_id` hashes it, so the same missing set must produce the same bytes.
    ///
    /// # Errors
    ///
    /// [`DagError::TooManyParents`] above [`GapRequest::MAX`].
    pub fn new(mut hashes: Vec<MsgId>) -> Result<Self, DagError> {
        hashes.sort_unstable();
        hashes.dedup();
        if hashes.len() > Self::MAX {
            return Err(DagError::TooManyParents);
        }
        Ok(Self {
            hashes: VecU16::new(hashes),
        })
    }

    /// The requested hashes, ascending.
    #[must_use]
    pub fn hashes(&self) -> &[MsgId] {
        self.hashes.as_slice()
    }

    /// Encode as the `body` of a `gap_request` message.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if the structure exceeds a length prefix.
    pub fn to_body(&self) -> Result<Body, DagError> {
        Ok(Body::new(self.encode_canonical()?)?)
    }

    /// Decode from a `gap_request` body, with re-encode equality.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if the bytes are not a canonical `GapRequest`.
    pub fn from_body(body: &Body) -> Result<Self, DagError> {
        Ok(f2z_codec::decode_canonical::<Self>(body.as_slice())?.into_value())
    }
}

/// Why a responder could not supply a message, on the wire.
///
/// A separate type from [`Unrecoverable`] on purpose: that one is the local
/// outbox's private bookkeeping and includes `Evicted`, which tells a requester
/// something about the responder's memory pressure that it has no business
/// knowing. This is the reduced set that goes over the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum RepairRefusal {
    /// The responder no longer holds the plaintext (§8.4).
    NoLongerHeld,
    /// The responder never held it — it was not the sender.
    NotMine,
}

impl RepairRefusal {
    /// The wire codepoint.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::NoLongerHeld => 1,
            Self::NotMine => 2,
        }
    }

    /// Resolve a codepoint.
    #[must_use]
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::NoLongerHeld),
            2 => Some(Self::NotMine),
            _ => None,
        }
    }

    /// The refusal a local [`Unrecoverable`] becomes on the wire.
    ///
    /// `Evicted` and `WindowExpired` collapse to one code deliberately. Both
    /// mean "gone"; telling a peer *which* leaks the responder's local
    /// retention setting and its buffer pressure, and `THREAT-MODEL.md`'s
    /// metadata ambition does not spend anything on distinctions the requester
    /// cannot act on.
    #[must_use]
    pub const fn from_local(reason: Unrecoverable) -> Self {
        match reason {
            Unrecoverable::WindowExpired | Unrecoverable::Evicted => Self::NoLongerHeld,
            Unrecoverable::NeverHeld => Self::NotMine,
        }
    }
}

impl Size for RepairRefusal {
    fn tls_serialized_len(&self) -> usize {
        1
    }
}

impl SerializeBytes for RepairRefusal {
    fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
        self.code().tls_serialize()
    }
}

impl DeserializeBytes for RepairRefusal {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (code, rest) = u8::tls_deserialize_bytes(bytes)?;
        let refusal = Self::from_code(code).ok_or(TlsError::UnknownValue(u64::from(code)))?;
        Ok((refusal, rest))
    }
}

/// One answer inside a [`GapResponse`].
#[derive(Clone, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct RepairEntry {
    msg_id: MsgId,
    /// The re-encoded original message, or empty when `refusal` is set.
    original: Body,
    /// `0` for "supplied", otherwise a [`RepairRefusal`] code.
    ///
    /// Spelled as a raw `u8` rather than an `Option<RepairRefusal>` because
    /// `tls_codec`'s derive has no optional; `0` is not a valid refusal code,
    /// so the two states cannot be confused.
    refusal: u8,
}

/// Hand-written: `original` is a `Body`, which redacts itself, but this type
/// would otherwise be one field edit away from a derived `Debug` over raw
/// bytes. Stated explicitly so the redaction is a decision.
impl fmt::Debug for RepairEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RepairEntry")
            .field("msg_id", &self.msg_id)
            .field(
                "original",
                &format_args!("<redacted; {} bytes>", self.original.len()),
            )
            .field("refusal", &RepairRefusal::from_code(self.refusal))
            .finish()
    }
}

impl RepairEntry {
    /// The message this entry answers for.
    #[must_use]
    pub const fn msg_id(&self) -> MsgId {
        self.msg_id
    }

    /// A supplied message: the **re-encoded original**, which the responder
    /// has just re-encrypted under the current epoch by sending this at all.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if the message exceeds a length prefix.
    pub fn supplied(message: &AppMessage) -> Result<Self, DagError> {
        Ok(Self {
            msg_id: message.msg_id(),
            original: Body::new(message.encode()?)?,
            refusal: 0,
        })
    }

    /// A refusal (§8.4).
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] never, in practice; the empty body cannot overflow.
    pub fn unrecoverable(msg_id: MsgId, refusal: RepairRefusal) -> Result<Self, DagError> {
        Ok(Self {
            msg_id,
            original: Body::new(Vec::new())?,
            refusal: refusal.code(),
        })
    }

    /// The refusal, if this entry is one.
    #[must_use]
    pub const fn refusal(&self) -> Option<RepairRefusal> {
        RepairRefusal::from_code(self.refusal)
    }

    /// Verify and take the repaired message.
    ///
    /// The `msg_id` the entry claims must be the one that was requested, and
    /// the bytes must hash to it. Both checks, in that order, because the
    /// second is the expensive one and the first is what makes the response
    /// *solicited*.
    ///
    /// # Errors
    ///
    /// - [`DagError::UnsolicitedRepair`] if this entry answers a hash that was
    ///   not requested.
    /// - [`DagError::RepairRefused`] if the responder said it cannot supply it.
    ///   That is §8.4 working, not a violation: the caller's next step is
    ///   [`crate::dag::MessageDag::mark_unrecoverable`], not a retry.
    /// - [`DagError::MsgIdMismatch`] if the supplied bytes do not hash to it.
    /// - [`DagError::Codec`] if they are not a canonical `AppMessage`.
    pub fn accept(&self, requested: &MsgId) -> Result<AppMessage, DagError> {
        if self.msg_id != *requested {
            return Err(DagError::UnsolicitedRepair);
        }
        if let Some(refusal) = self.refusal() {
            return Err(DagError::RepairRefused(refusal));
        }
        if self.refusal != 0 {
            // A refusal code this build does not recognise. Not a message, and
            // not something to guess at.
            return Err(DagError::UnsolicitedRepair);
        }
        // `AppMessage::decode` re-checks the commitment against the bytes, so
        // the equality below is what binds it to the *requested* id rather than
        // to whatever id the responder chose to put in the entry.
        let message = AppMessage::decode(self.original.as_slice())?;
        if message.msg_id() != *requested {
            return Err(DagError::MsgIdMismatch);
        }
        Ok(message)
    }
}

/// §7's `gap_response`: one entry per requested hash.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct GapResponse {
    entries: VecU16<RepairEntry>,
}

impl GapResponse {
    /// Build a response.
    #[must_use]
    pub fn new(entries: Vec<RepairEntry>) -> Self {
        Self {
            entries: VecU16::new(entries),
        }
    }

    /// The entries.
    #[must_use]
    pub fn entries(&self) -> &[RepairEntry] {
        self.entries.as_slice()
    }

    /// Encode as the `body` of a `gap_response` message.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if the structure exceeds a length prefix.
    pub fn to_body(&self) -> Result<Body, DagError> {
        Ok(Body::new(self.encode_canonical()?)?)
    }

    /// Decode from a `gap_response` body, with re-encode equality.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if the bytes are not a canonical `GapResponse`.
    pub fn from_body(body: &Body) -> Result<Self, DagError> {
        Ok(f2z_codec::decode_canonical::<Self>(body.as_slice())?.into_value())
    }

    /// Find the entry answering one requested hash.
    #[must_use]
    pub fn entry_for(&self, msg_id: &MsgId) -> Option<&RepairEntry> {
        self.entries
            .as_slice()
            .iter()
            .find(|entry| entry.msg_id() == *msg_id)
    }
}

/// Which [`MessageType`] carries a [`GapRequest`].
pub const GAP_REQUEST_TYPE: MessageType = MessageType::GAP_REQUEST;

/// Which [`MessageType`] carries a [`GapResponse`].
pub const GAP_RESPONSE_TYPE: MessageType = MessageType::GAP_RESPONSE;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{AppMessageTbs, Parents, RetentionClass, SentAt};
    use alloc::vec;

    fn message(body: &[u8]) -> AppMessage {
        AppMessage::seal(AppMessageTbs {
            message_type: MessageType::CHAT,
            parents: Parents::empty(),
            epoch: 7,
            sender_leaf_index: 0,
            sent_at: SentAt::new(0),
            retention_class: RetentionClass::Chat,
            body: Body::new(body.to_vec()).unwrap(),
        })
        .unwrap()
    }

    #[test]
    fn a_gap_request_round_trips_through_a_body() {
        let request = GapRequest::new(vec![MsgId::new([2; 32]), MsgId::new([1; 32])]).unwrap();
        assert_eq!(
            request.hashes(),
            &[MsgId::new([1; 32]), MsgId::new([2; 32])],
            "sorted, so the same missing set produces the same bytes"
        );
        let body = request.to_body().unwrap();
        assert_eq!(GapRequest::from_body(&body).unwrap(), request);
    }

    #[test]
    fn a_repeated_hash_is_collapsed_rather_than_asked_for_twice() {
        let id = MsgId::new([3; 32]);
        assert_eq!(GapRequest::new(vec![id, id, id]).unwrap().hashes(), &[id]);
    }

    #[test]
    fn a_supplied_entry_verifies_against_the_requested_hash() {
        let original = message(b"the missing one");
        let entry = RepairEntry::supplied(&original).unwrap();
        assert_eq!(entry.accept(&original.msg_id()).unwrap(), original);
    }

    #[test]
    fn a_substituted_message_is_refused_even_though_it_is_well_formed() {
        // The whole point of the commitment: a peer answering with a *valid*
        // message that is not the one asked for gets nowhere.
        let asked_for = message(b"the missing one");
        let substituted = message(b"something else entirely");

        let mut entry = RepairEntry::supplied(&substituted).unwrap();
        // Pretend the responder relabelled it with the requested id.
        entry.msg_id = asked_for.msg_id();
        assert_eq!(
            entry.accept(&asked_for.msg_id()),
            Err(DagError::MsgIdMismatch)
        );
    }

    #[test]
    fn an_answer_to_a_hash_nobody_asked_about_is_refused() {
        let original = message(b"unsolicited");
        let entry = RepairEntry::supplied(&original).unwrap();
        assert_eq!(
            entry.accept(&MsgId::new([9; 32])),
            Err(DagError::UnsolicitedRepair)
        );
    }

    #[test]
    fn a_refusal_round_trips_and_never_yields_a_message() {
        let id = MsgId::new([4; 32]);
        let entry = RepairEntry::unrecoverable(id, RepairRefusal::NoLongerHeld).unwrap();
        assert_eq!(entry.refusal(), Some(RepairRefusal::NoLongerHeld));
        assert_eq!(
            entry.accept(&id),
            Err(DagError::RepairRefused(RepairRefusal::NoLongerHeld)),
            "§8.4's answer is an answer, not a protocol violation"
        );

        let response = GapResponse::new(vec![entry]);
        let body = response.to_body().unwrap();
        let decoded = GapResponse::from_body(&body).unwrap();
        assert_eq!(
            decoded.entry_for(&id).unwrap().refusal(),
            Some(RepairRefusal::NoLongerHeld)
        );
    }

    #[test]
    fn the_wire_refusal_does_not_distinguish_expiry_from_eviction() {
        assert_eq!(
            RepairRefusal::from_local(Unrecoverable::WindowExpired),
            RepairRefusal::from_local(Unrecoverable::Evicted)
        );
        assert_eq!(
            RepairRefusal::from_local(Unrecoverable::NeverHeld),
            RepairRefusal::NotMine
        );
    }
}
