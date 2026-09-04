//! The `AppMessage` of `ARCHITECTURE.md` §7, and the hash that names it.
//!
//! ```text
//! AppMessage = {
//!   type, msg_id, parents, epoch, sender_leaf_index, sent_at,
//!   retention_class, body
//! }
//! msg_id = BLAKE2b-256("free2z/msg/v1/msgid" || canonical(rest))
//! ```
//!
//! # `sender_leaf_index` is inside the hash
//!
//! §7's correction of 2026-08-25. The field used to live only in MLS framing,
//! which meant `msg_id` did not commit to it while §7's sort key depended on
//! it — and repair delivers a message *outside* its original framing. It is
//! now a hashed field, so the sort key is a property of the **message** rather
//! than of the delivery that happened to carry it. See
//! [`crate::dag::DagEntry::from_delivered`] for the cross-check against the
//! framing, and [`crate::dag::DagEntry::from_repair`] for what it buys.
//!
//! # `rest` is a type, not a comment
//!
//! `canonical(rest)` means "every field except `msg_id`", and getting that set
//! wrong is a silent interoperability break rather than a crash: two clients
//! that disagree about which bytes are hashed simply compute two different
//! names for one message and never dedup it. So `rest` is [`AppMessageTbs`] —
//! a type that *is* the hashed set — and [`AppMessage`] is that type plus its
//! digest. There is no path that hashes a hand-assembled byte string.
//!
//! # The wire order, and why `msg_id` comes first
//!
//! §7 lists `type` first. That listing is a **structure**, not a wire encoding:
//! §7 defines no concrete serialization, because the message travels as the
//! opaque payload of an MLS `PrivateMessage` and MLS does not care what is
//! inside it. Some concrete encoding still has to exist for `canonical(rest)`
//! to be a byte string, and this crate defines it:
//!
//! ```text
//! encode(AppMessage) == msg_id || encode(AppMessageTbs)
//! ```
//!
//! `msg_id` first buys one property worth having: the hashed bytes are a
//! **contiguous suffix** of the encoded message, so verifying the commitment
//! needs no re-assembly and cannot pick up a field the encoder placed
//! somewhere else. [`AppMessage::decode`] verifies against that suffix
//! directly.
//!
//! This is an ambiguity in §7 that had to be resolved to write any code at all,
//! and it is resolved *here*, which means it has to be reflected back into §7
//! before a second implementation exists. It is listed in the pull request.
//!
//! # `sent_at` has no `Ord`, and that is the point
//!
//! [`SentAt`] deliberately implements neither `Ord` nor `PartialOrd`. §7 says
//! the field is advisory and never orders anything; a comment saying so is a
//! convention, and a missing trait is a compile error. Sorting a transcript by
//! `sent_at` does not produce a subtly wrong transcript in this crate — it
//! produces `error[E0277]: the trait bound `SentAt: Ord` is not satisfied`.

// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;
use alloc::vec::Vec;
use core::fmt;

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};
use f2z_codec::CodecError;
use f2z_codec::canonical::Canonical;
use f2z_codec::types::Body;
use f2z_codec::vec::VecU16;
use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsDeserializeBytes,
    TlsSerializeBytes, TlsSize,
};

use crate::error::DagError;
use crate::labels::LABEL_MSG_ID;

type Blake2b256 = Blake2b<U32>;

// ---------------------------------------------------------------------------
// msg_id
// ---------------------------------------------------------------------------

/// A message's name: `BLAKE2b-256("free2z/msg/v1/msgid" || canonical(rest))`.
///
/// This is the protocol's dedup key and the third component of §7's total
/// order. `Ord` is derived over the raw bytes, which is the ordering
/// `CLIENT-CONTRACT.md` §7's `msgId` string comparison reproduces exactly as
/// long as the string is base16 in a **single** case — see
/// [`MsgId::to_lower_hex`].
///
/// `Debug` is hand-written. A `msg_id` is not secret in the sense a key is —
/// anyone holding the message can recompute it — but it is a stable,
/// conversation-linkable identifier that survives forever in a log file, and
/// the derived `Debug` over `[u8; 32]` would render it as a decimal byte list
/// that no hex-shaped leak check would ever notice.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MsgId([u8; MsgId::LEN]);

impl MsgId {
    /// The width of a `msg_id`, in bytes. BLAKE2b-**256**.
    pub const LEN: usize = 32;

    /// Wrap 32 bytes.
    #[must_use]
    pub const fn new(bytes: [u8; Self::LEN]) -> Self {
        Self(bytes)
    }

    /// Borrow the bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; Self::LEN] {
        &self.0
    }

    /// Wrap a slice of exactly 32 bytes.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] if the slice is a different length.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, CodecError> {
        let array: [u8; Self::LEN] = bytes.try_into().map_err(|_| CodecError::InvalidValue)?;
        Ok(Self(array))
    }

    /// Lowercase base16, which is the spelling `CLIENT-CONTRACT.md` §7's
    /// `msgId` carries across the FFI boundary.
    ///
    /// The case matters and the *consistency* of the case matters more. Base16
    /// is order-preserving in either case on its own — ASCII `0`..`9` precedes
    /// both `A`..`F` and `a`..`f` — so a client that lexicographically compares
    /// all-lowercase hex strings, as `compareMessages` in
    /// `wallet/e2e2z/src/lib/messaging/types.ts` does, reproduces this type's
    /// byte ordering exactly. **Mixed** case does not, and base64 does not
    /// either: `+` and `/` sort below the digits and the alphabet is not
    /// monotone in the underlying bytes. This function exists so the FFI has
    /// one spelling to use and no reason to invent another.
    #[must_use]
    pub fn to_lower_hex(&self) -> alloc::string::String {
        let mut out = alloc::string::String::with_capacity(Self::LEN.saturating_mul(2));
        for byte in &self.0 {
            const DIGITS: &[u8; 16] = b"0123456789abcdef";
            let high = usize::from(byte >> 4);
            let low = usize::from(byte & 0x0f);
            out.push(char::from(*DIGITS.get(high).unwrap_or(&b'0')));
            out.push(char::from(*DIGITS.get(low).unwrap_or(&b'0')));
        }
        out
    }
}

impl fmt::Debug for MsgId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("MsgId(<redacted>)")
    }
}

impl Size for MsgId {
    fn tls_serialized_len(&self) -> usize {
        Self::LEN
    }
}

impl SerializeBytes for MsgId {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize_bytes()
    }
}

impl DeserializeBytes for MsgId {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (array, rest) = <[u8; MsgId::LEN]>::tls_deserialize_bytes(bytes)?;
        Ok((Self(array), rest))
    }
}

// ---------------------------------------------------------------------------
// type
// ---------------------------------------------------------------------------

/// The `type` field of §7.
///
/// A transparent `u8` rather than a closed enum, because §7's list ends in
/// `...` — the set is open by specification. A closed enum would have to map
/// an unrecognised byte to something, and mapping an unknown variant to a
/// default is the silent-variant hazard `WIRE.md` §3.3 exists to forbid: the
/// message would re-encode to a *different* byte and fail re-encode equality,
/// or, worse, be silently reinterpreted. `CLIENT-CONTRACT.md`'s `MessageBody`
/// already has an `unsupported` arm carrying a `typeTag`, which is the
/// behaviour this admits.
///
/// **The codepoints are this crate's assignment.** §7 names the types and gives
/// no numbers; these are allocated in the order §7 lists them, starting at 1,
/// with 0 left unassigned so that an all-zero buffer is not a valid `chat`.
/// Listed in the pull request as an ambiguity that has to go back into §7.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    TlsSize,
    TlsSerializeBytes,
    TlsDeserializeBytes,
)]
pub struct MessageType(u8);

impl MessageType {
    /// A user-visible chat message.
    pub const CHAT: Self = Self(1);
    /// A `DeliveryReceipt` (`CLIENT-CONTRACT.md` §6.2's `device-delivered`).
    pub const RECEIPT: Self = Self(2);
    /// `gap_request{hashes}` — §7's gap signal.
    pub const GAP_REQUEST: Self = Self(3);
    /// `gap_response` — the repair, re-encrypted under the current epoch.
    pub const GAP_RESPONSE: Self = Self(4);
    /// A FROST/DKG ceremony payload (§11), which carries its own signature in
    /// addition to MLS framing.
    pub const CEREMONY: Self = Self(5);
    /// A queue advert (`WIRE.md` §12.2).
    pub const QUEUE_ADVERT: Self = Self(6);
    /// A WebRTC offer (§10).
    pub const WEBRTC_OFFER: Self = Self(7);

    /// Wrap a raw codepoint, including one this build has never heard of.
    #[must_use]
    pub const fn new(code: u8) -> Self {
        Self(code)
    }

    /// The raw codepoint.
    #[must_use]
    pub const fn code(self) -> u8 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// retention_class
// ---------------------------------------------------------------------------

/// §8's retention class, and a **closed** set.
///
/// The asymmetry with [`MessageType`] is deliberate and is the interesting
/// decision in this file. `type` drives dispatch, and a client that does not
/// recognise a type can honestly render "unsupported message". `retention_class`
/// drives a *retention decision* — §8.5 retains `CEREMONY` by default and §8.2's
/// ephemeral hint expires `CHAT` — and there is no honest default for a value
/// nobody recognises. Silently treating an unknown class as `CHAT` would expire
/// a ceremony transcript the participant is keeping as their own evidence;
/// silently treating it as `CEREMONY` would retain something a user asked to be
/// ephemeral. So an unknown value is a decode error, loudly, at the boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum RetentionClass {
    /// §8.2's ephemeral-hint-eligible class.
    Chat,
    /// §8.5: retained by default, because the participant wants the evidence.
    Ceremony,
}

impl RetentionClass {
    /// The wire codepoint.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Chat => 1,
            Self::Ceremony => 2,
        }
    }

    /// Resolve a codepoint this build knows.
    #[must_use]
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Chat),
            2 => Some(Self::Ceremony),
            _ => None,
        }
    }
}

impl Size for RetentionClass {
    fn tls_serialized_len(&self) -> usize {
        1
    }
}

impl SerializeBytes for RetentionClass {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        self.code().tls_serialize_bytes()
    }
}

impl DeserializeBytes for RetentionClass {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (code, rest) = u8::tls_deserialize_bytes(bytes)?;
        let class = Self::from_code(code).ok_or(TlsError::UnknownValue(u64::from(code)))?;
        Ok((class, rest))
    }
}

// ---------------------------------------------------------------------------
// sent_at
// ---------------------------------------------------------------------------

/// The sender's claimed wall clock, in milliseconds. **Advisory only.**
///
/// §7: "sender-claimed; ADVISORY ONLY, never used for ordering or security
/// decisions". `CLIENT-CONTRACT.md` §7 enumerates the prohibition: it must not
/// order, filter, deduplicate, bound a query, decide whether something is
/// "new", drive a day separator that changes ordering, or feed any security
/// decision.
///
/// **This type implements neither `Ord` nor `PartialOrd`, and that is load
/// bearing.** Every messaging client that has ever got this wrong got it wrong
/// by sorting on a field that happened to be comparable. Here the mistake does
/// not compile. `PartialEq` is kept — a re-encode-equality test has to compare
/// whole messages — but equality is not ordering and cannot be used to place
/// anything in a transcript.
///
/// It is also not usable for dedup even where it would appear to work:
/// [`crate::dag::MessageDag`] dedups on [`MsgId`] only.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, TlsSize, TlsSerializeBytes, TlsDeserializeBytes,
)]
pub struct SentAt(u64);

impl SentAt {
    /// Wrap a sender-claimed millisecond timestamp.
    #[must_use]
    pub const fn new(millis: u64) -> Self {
        Self(millis)
    }

    /// The claimed value, for **rendering** beside a message and nothing else.
    ///
    /// The name says "claimed" because that is all it is: an attacker-supplied
    /// integer. Anything that takes this and compares it to another one has
    /// re-created the ordering hazard this type exists to prevent.
    #[must_use]
    pub const fn claimed_millis(self) -> u64 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// parents
// ---------------------------------------------------------------------------

/// §7's `parents`: every message this sender had delivered and not yet
/// referenced, at send time.
///
/// # Strictly ascending, and why that is not tidiness
///
/// A sender's heads are a *set*. Any encoding of a set has to pick an order,
/// and `msg_id` hashes the encoding — so if the order were free, two senders
/// holding the identical head set would mint two different names for the
/// identical message. Content addressing that depends on iteration order is not
/// content addressing. So this type admits only strictly ascending sequences:
/// sorted, and therefore also duplicate-free.
///
/// Rejecting duplicates has a second effect worth naming: a `parents` list of
/// the same hash repeated 2000 times would otherwise be a cheap way to make a
/// receiver do 2000 lookups per message.
///
/// §7 does not state this rule. It is this crate's canonicalisation decision
/// and it is listed in the pull request.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes)]
pub struct Parents(VecU16<MsgId>);

impl Parents {
    /// The most parents one message may reference.
    ///
    /// The `<0..2^16-1>` length prefix already caps this at 2047 whole
    /// `msg_id`s; the constant is spelled out so the limit is a decision rather
    /// than an artefact of a prefix width.
    pub const MAX: usize = 2047;

    /// Wrap a head set, sorting and validating it.
    ///
    /// The input need not already be sorted — sorting is this constructor's
    /// job, because a caller assembling its heads from a `BTreeSet` should not
    /// have to know the rule. Duplicates are an error rather than something to
    /// quietly collapse: a caller that produced one has a bug in its head
    /// tracking and should hear about it.
    ///
    /// # Errors
    ///
    /// - [`DagError::TooManyParents`] above [`Parents::MAX`].
    /// - [`DagError::ParentsNotCanonical`] if the same `msg_id` appears twice.
    pub fn new(mut ids: Vec<MsgId>) -> Result<Self, DagError> {
        if ids.len() > Self::MAX {
            return Err(DagError::TooManyParents);
        }
        ids.sort_unstable();
        if ids.windows(2).any(|pair| pair.first() == pair.get(1)) {
            return Err(DagError::ParentsNotCanonical);
        }
        Ok(Self(VecU16::new(ids)))
    }

    /// The empty head set — a conversation's first message.
    #[must_use]
    pub fn empty() -> Self {
        Self(VecU16::new(Vec::new()))
    }

    /// The parent ids, ascending.
    #[must_use]
    pub fn as_slice(&self) -> &[MsgId] {
        self.0.as_slice()
    }

    /// How many parents.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether there are none.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn validate(&self) -> Result<(), DagError> {
        let ids = self.0.as_slice();
        if ids.len() > Self::MAX {
            return Err(DagError::TooManyParents);
        }
        let ascending = ids
            .windows(2)
            .all(|pair| match (pair.first(), pair.get(1)) {
                (Some(low), Some(high)) => low < high,
                _ => true,
            });
        if !ascending {
            return Err(DagError::ParentsNotCanonical);
        }
        Ok(())
    }
}

impl DeserializeBytes for Parents {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = VecU16::<MsgId>::tls_deserialize_bytes(bytes)?;
        let parents = Self(inner);
        // A received list that is not strictly ascending is refused here rather
        // than sorted, because sorting it would change the bytes `msg_id`
        // commits to. §3.3's rule again: the decoder must not be more
        // permissive than the encoder.
        parents
            .validate()
            .map_err(|_| TlsError::InvalidVectorLength)?;
        Ok((parents, rest))
    }
}

// ---------------------------------------------------------------------------
// the message
// ---------------------------------------------------------------------------

/// `rest`: every field of §7's `AppMessage` except `msg_id`.
///
/// This is the exact input to the hash, as a type. See the module note.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AppMessageTbs {
    /// §7's `type`.
    pub message_type: MessageType,
    /// §7's `parents`.
    pub parents: Parents,
    /// §7's `epoch`: the MLS epoch this message was authored in.
    pub epoch: u64,
    /// §7's `sender_leaf_index`: the author's MLS leaf index, and the second
    /// component of §7's total order.
    ///
    /// **Authoritative, and hashed.** The MLS framing carries the same value
    /// for a directly delivered message and
    /// [`crate::dag::DagEntry::from_delivered`] refuses a message where the
    /// two disagree — one source of truth, cross-checked, rather than two.
    ///
    /// It sits here rather than only in the framing because §7's ordering
    /// guarantee is over a *set of messages*, and repair delivers a message
    /// outside the framing it was authored in. A sort key that could only be
    /// read off the delivery made two receivers who learned one message by
    /// different routes render different transcripts. Committing to it costs
    /// nothing in metadata: every group member could already read it off the
    /// framing, and the relay sees only ciphertext either way.
    ///
    /// `u32` because that is MLS's leaf index width (RFC 9420 §7.1).
    pub sender_leaf_index: u32,
    /// §7's `sent_at`. Advisory. See [`SentAt`].
    pub sent_at: SentAt,
    /// §7's `retention_class`.
    pub retention_class: RetentionClass,
    /// §7's `body`, opaque at this layer.
    pub body: Body,
}

/// A framed application message: §7's structure, with its commitment.
///
/// Construct one with [`AppMessage::seal`], which computes `msg_id`, or decode
/// one with [`AppMessage::decode`], which verifies it. There is no constructor
/// that takes both halves without checking they agree, because a message whose
/// name does not match its content is the one thing this framing exists to make
/// impossible.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppMessage {
    msg_id: MsgId,
    tbs: AppMessageTbs,
}

impl AppMessage {
    /// Compute `msg_id` over `tbs` and bind the two together.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if `tbs` cannot be encoded — in practice a `parents`
    /// list or `body` longer than its length prefix can describe.
    pub fn seal(tbs: AppMessageTbs) -> Result<Self, DagError> {
        let encoded = tbs.encode_canonical()?;
        Ok(Self {
            msg_id: msg_id_of(&encoded),
            tbs,
        })
    }

    /// The message's name, and the protocol's dedup key.
    #[must_use]
    pub const fn msg_id(&self) -> MsgId {
        self.msg_id
    }

    /// The hashed fields.
    #[must_use]
    pub const fn tbs(&self) -> &AppMessageTbs {
        &self.tbs
    }

    /// `msg_id || encode(tbs)`. See the module note on the field order.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] if the structure exceeds a length prefix.
    pub fn encode(&self) -> Result<Vec<u8>, DagError> {
        let tbs = self.tbs.encode_canonical()?;
        let mut out = Vec::with_capacity(MsgId::LEN.saturating_add(tbs.len()));
        out.extend_from_slice(self.msg_id.as_bytes());
        out.extend_from_slice(&tbs);
        Ok(out)
    }

    /// Decode a message and verify its commitment.
    ///
    /// Three checks, in this order, and all three are fatal:
    ///
    /// 1. the bytes decode as a version-1 `AppMessage`;
    /// 2. they re-encode to themselves (`WIRE.md` §3.3);
    /// 3. `msg_id` is the hash of the remaining bytes.
    ///
    /// # Errors
    ///
    /// [`DagError::Codec`] for 1 and 2, [`DagError::MsgIdMismatch`] for 3.
    pub fn decode(bytes: &[u8]) -> Result<Self, DagError> {
        let claimed = bytes
            .get(..MsgId::LEN)
            .ok_or(DagError::Codec(CodecError::Decode))?;
        let rest = bytes
            .get(MsgId::LEN..)
            .ok_or(DagError::Codec(CodecError::Decode))?;
        let claimed = MsgId::from_slice(claimed)?;

        // Re-encode equality on the hashed suffix. `decode_canonical` is the
        // only place in this tree that performs it, and the bytes it hands back
        // are the *re-encoded* ones — so step 3 below cannot be fed the
        // received bytes by accident.
        let canonical = f2z_codec::decode_canonical::<AppMessageTbs>(rest)?;
        if msg_id_of(canonical.bytes()) != claimed {
            return Err(DagError::MsgIdMismatch);
        }

        Ok(Self {
            msg_id: claimed,
            tbs: canonical.into_value(),
        })
    }
}

/// `BLAKE2b-256("free2z/msg/v1/msgid" || canonical_rest)` — §7's construction,
/// with the label applied exactly as `WIRE.md` §1.3's `H(label, x)` does: label
/// bytes, then the message, no separator and no terminator.
#[must_use]
pub fn msg_id_of(canonical_rest: &[u8]) -> MsgId {
    let mut hasher = Blake2b256::new();
    hasher.update(LABEL_MSG_ID);
    hasher.update(canonical_rest);
    MsgId::new(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn tbs(parents: Parents, epoch: u64, body: &[u8]) -> AppMessageTbs {
        AppMessageTbs {
            message_type: MessageType::CHAT,
            parents,
            epoch,
            sender_leaf_index: 1,
            sent_at: SentAt::new(1_700_000_000_000),
            retention_class: RetentionClass::Chat,
            body: Body::new(body.to_vec()).unwrap(),
        }
    }

    fn id(byte: u8) -> MsgId {
        MsgId::new([byte; MsgId::LEN])
    }

    #[test]
    fn a_sealed_message_round_trips_and_its_commitment_verifies() {
        let message = AppMessage::seal(tbs(Parents::empty(), 7, b"hello")).unwrap();
        let wire = message.encode().unwrap();
        assert_eq!(AppMessage::decode(&wire).unwrap(), message);
        assert_eq!(
            wire.get(..MsgId::LEN).unwrap(),
            message.msg_id().as_bytes(),
            "the hashed bytes must be the suffix after msg_id"
        );
    }

    #[test]
    fn the_hashed_bytes_are_exactly_the_suffix_of_the_encoding() {
        let message = AppMessage::seal(tbs(Parents::empty(), 7, b"hello")).unwrap();
        let wire = message.encode().unwrap();
        let suffix = wire.get(MsgId::LEN..).unwrap();
        assert_eq!(msg_id_of(suffix), message.msg_id());
    }

    #[test]
    fn editing_any_hashed_field_changes_the_name() {
        let base = AppMessage::seal(tbs(Parents::empty(), 7, b"hello")).unwrap();

        let other_epoch = AppMessage::seal(tbs(Parents::empty(), 8, b"hello")).unwrap();
        assert_ne!(base.msg_id(), other_epoch.msg_id());

        let other_body = AppMessage::seal(tbs(Parents::empty(), 7, b"hellp")).unwrap();
        assert_ne!(base.msg_id(), other_body.msg_id());

        let mut ceremony = tbs(Parents::empty(), 7, b"hello");
        ceremony.retention_class = RetentionClass::Ceremony;
        assert_ne!(base.msg_id(), AppMessage::seal(ceremony).unwrap().msg_id());

        // `sent_at` is advisory, but it is still *hashed* — §7 puts it inside
        // `rest`. Advisory means "never ordered by", not "not committed to".
        let mut later = tbs(Parents::empty(), 7, b"hello");
        later.sent_at = SentAt::new(0);
        assert_ne!(base.msg_id(), AppMessage::seal(later).unwrap().msg_id());

        // §7's 2026-08-25 correction: the sort key's second component is a
        // property of the message, so changing it must change its name.
        let mut other_leaf = tbs(Parents::empty(), 7, b"hello");
        other_leaf.sender_leaf_index = 2;
        assert_ne!(
            base.msg_id(),
            AppMessage::seal(other_leaf).unwrap().msg_id(),
            "msg_id must commit to sender_leaf_index"
        );
    }

    #[test]
    fn a_tampered_body_fails_the_commitment_rather_than_decoding() {
        let message = AppMessage::seal(tbs(Parents::empty(), 7, b"hello")).unwrap();
        let mut wire = message.encode().unwrap();
        let last = wire.len().checked_sub(1).unwrap();
        *wire.get_mut(last).unwrap() ^= 0xff;
        assert_eq!(AppMessage::decode(&wire), Err(DagError::MsgIdMismatch));
    }

    #[test]
    fn trailing_bytes_are_rejected() {
        let message = AppMessage::seal(tbs(Parents::empty(), 7, b"hello")).unwrap();
        let mut wire = message.encode().unwrap();
        wire.push(0);
        assert_eq!(
            AppMessage::decode(&wire),
            Err(DagError::Codec(CodecError::Decode))
        );
    }

    #[test]
    fn parents_are_sorted_by_the_constructor_so_a_head_set_has_one_name() {
        let one = Parents::new(vec![id(3), id(1), id(2)]).unwrap();
        let other = Parents::new(vec![id(1), id(2), id(3)]).unwrap();
        assert_eq!(one, other);
        assert_eq!(
            AppMessage::seal(tbs(one, 7, b"x")).unwrap().msg_id(),
            AppMessage::seal(tbs(other, 7, b"x")).unwrap().msg_id(),
            "the same head set must mint the same msg_id"
        );
    }

    #[test]
    fn a_repeated_parent_is_refused() {
        assert_eq!(
            Parents::new(vec![id(1), id(1)]),
            Err(DagError::ParentsNotCanonical)
        );
    }

    #[test]
    fn a_descending_parents_list_on_the_wire_is_refused_rather_than_sorted() {
        // Hand-assemble the encoding with the parents out of order. Sorting on
        // receipt would change the bytes msg_id commits to, so this must be an
        // error and not a repair.
        let ascending =
            AppMessage::seal(tbs(Parents::new(vec![id(1), id(2)]).unwrap(), 7, b"x")).unwrap();
        let wire = ascending.encode().unwrap();

        // Swap the two 32-byte parent ids in place. They sit after msg_id, the
        // one-byte type and the two-byte vector prefix.
        let at = MsgId::LEN + 1 + 2;
        let mut swapped = wire.clone();
        for offset in 0..MsgId::LEN {
            let low = at + offset;
            let high = at + MsgId::LEN + offset;
            swapped.swap(low, high);
        }
        assert_ne!(swapped, wire);
        assert!(matches!(
            AppMessage::decode(&swapped),
            Err(DagError::Codec(_) | DagError::MsgIdMismatch)
        ));
    }

    #[test]
    fn an_unknown_retention_class_is_a_decode_error_and_not_a_default() {
        let message = AppMessage::seal(tbs(Parents::empty(), 7, b"hello")).unwrap();
        let wire = message.encode().unwrap();
        // retention_class sits after msg_id, type, the empty parents prefix,
        // epoch, sender_leaf_index and sent_at.
        let at = MsgId::LEN + 1 + 2 + 8 + 4 + 8;
        assert_eq!(*wire.get(at).unwrap(), RetentionClass::Chat.code());
        let mut unknown = wire;
        *unknown.get_mut(at).unwrap() = 0x7f;
        assert_eq!(
            AppMessage::decode(&unknown),
            Err(DagError::Codec(CodecError::Decode)),
            "an unrecognised retention class must not silently become CHAT"
        );
    }

    #[test]
    fn an_unknown_message_type_round_trips_because_the_set_is_open() {
        let mut open = tbs(Parents::empty(), 7, b"hello");
        open.message_type = MessageType::new(0xfe);
        let message = AppMessage::seal(open).unwrap();
        let decoded = AppMessage::decode(&message.encode().unwrap()).unwrap();
        assert_eq!(decoded.tbs().message_type.code(), 0xfe);
    }

    #[test]
    fn lower_hex_is_order_preserving_over_the_bytes() {
        // The property `CLIENT-CONTRACT.md` §7's string comparison depends on.
        let low = MsgId::new([0x09; MsgId::LEN]);
        let high = MsgId::new([0xa0; MsgId::LEN]);
        assert!(low < high);
        assert!(low.to_lower_hex() < high.to_lower_hex());
        assert_eq!(low.to_lower_hex().len(), 64);
    }

    #[test]
    fn the_label_is_applied_with_no_separator() {
        // §7's construction spelled out by hand, so the code below cannot
        // silently start framing the label.
        let tbs = tbs(Parents::empty(), 7, b"hello");
        let encoded = tbs.encode_canonical().unwrap();
        let mut hasher = Blake2b256::new();
        hasher.update(b"free2z/msg/v1/msgid");
        hasher.update(&encoded);
        let expected: [u8; 32] = hasher.finalize().into();
        assert_eq!(
            AppMessage::seal(tbs).unwrap().msg_id().as_bytes(),
            &expected
        );
    }
}
