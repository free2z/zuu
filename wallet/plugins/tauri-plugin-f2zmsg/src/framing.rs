//! `ARCHITECTURE.md` §7 — the application envelope, `msg_id`, and the total
//! order. **This module is a seam, and it is meant to be deleted.**
//!
//! # Why it is here and not in a crate
//!
//! §7's framing belongs in `rs/crates/f2z-msg-dag`, alongside gap repair and
//! the plaintext outbox, so that ZUULI and the WASM web client share one
//! implementation (ADR 0001). At the time this plugin was written that crate
//! **did not exist** — not on `main`, not on any remote branch, not in any open
//! pull request — and neither did any code anywhere in the tree that constructs
//! an `AppMessage`, computes a `msg_id`, or tracks `parents`.
//!
//! The plugin cannot wait for it: without an envelope there is no `msg_id`, and
//! without a `msg_id` there is no dedup key, no `parents`, no gap detection and
//! no §7 order — which is to say no `send_message` and no `list_messages`.
//!
//! So this is the smallest correct implementation of §7's *envelope and
//! ordering* and **nothing else**, kept deliberately narrow so that replacing
//! it is a delete-and-reimport rather than a refactor:
//!
//! * It is the only module in this plugin that knows the envelope's shape.
//!   Everything above it takes [`AppMessage`] and [`MsgId`] as opaque.
//! * It performs **no** I/O, holds **no** state, and has no dependency on the
//!   engine, the store or the relay.
//! * The two pieces it deliberately does **not** implement are the ones that
//!   need state and policy, and they are exactly what `f2z-msg-dag` is for:
//!   the bounded-window **plaintext outbox** that makes repair possible, and
//!   the **gap repair protocol** itself. [`crate::engine::gaps`] detects gaps
//!   from `parents` — detection needs no outbox — and refuses repair with
//!   `gap-unrecoverable`, which is a true statement about this build rather
//!   than a stub: with no outbox, the sender genuinely no longer holds the
//!   plaintext.
//!
//! # What is settled here and must not change when the crate lands
//!
//! The `msg_id` preimage. `free2z/msg/v1/msgid` is minted in
//! `ARCHITECTURE.md` §7 and is already in the tree's label namespace, and the
//! encoding below is `f2z-codec`'s canonical TLS presentation encoding with
//! §3.3 re-encode equality on decode — the same rule the wire protocol uses, so
//! there is exactly one canonical encoder in this repository and this is it. A
//! `f2z-msg-dag` that computed `msg_id` differently would not be an
//! implementation of the same protocol.

use f2z_codec::{
    Digest,
    canonical::{decode_canonical, encode},
    error::CodecError,
    hash::hash,
    types::{Body, ShortBytes},
    vec::VecU16,
};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

/// `ARCHITECTURE.md` §7's `msg_id` domain label.
///
/// Minted in the specification, not here. `scripts/check-hash-domain-labels.mjs`
/// holds the whole tree's label set prefix-free, and this constant is inside
/// that scan.
pub const LABEL_MSG_ID: &[u8] = b"free2z/msg/v1/msgid";

/// The envelope version. Present so that a client which cannot parse a future
/// envelope renders `{ kind: "unsupported" }` rather than a blank row
/// (`CLIENT-CONTRACT.md` §3.4).
pub const ENVELOPE_VERSION: u16 = 0x0001;

/// `ARCHITECTURE.md` §7's `type`, as a closed set of wire codes.
///
/// A `u16` rather than a string because a string type tag inside a hashed
/// preimage is a canonicalization question nobody needs to answer twice. The
/// contract's `{ kind: "unsupported"; typeTag }` renders whatever this decodes
/// to but does not recognise, which is why [`AppKind::type_tag`] produces a
/// stable human string for the unknown case too.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum AppKind {
    /// §7 `"chat"`. The only kind a v1 UI renders as a message.
    Chat,
    /// §7 `"receipt"` — the authenticated `DeliveryReceipt` of §6.2's
    /// `device-delivered`. Batched and jittered, never immediate (§3.6).
    Receipt,
    /// §7 `"gap_request"`.
    GapRequest,
    /// §7 `"gap_response"`.
    GapResponse,
    /// §3.8's ephemeral hint. Travels inside MLS so it is attributable; it is
    /// still a courtesy signal and never enforcement.
    EphemeralHint,
    /// §3.9's purge request.
    PurgeRequest,
    /// §3.9's `PurgeAck`.
    PurgeAck,
    /// §7's `queue_advert`: where to write to reach the sender.
    ///
    /// It is in-band and inside MLS because that is the only place it can be
    /// authenticated. The directory publishes the *contact* address, which is
    /// how a stranger reaches you once; the per-conversation send address is
    /// something only a member should learn, and a relay that could read it
    /// could take the write side of the queue (`WIRE.md` §7.4).
    QueueAdvert,
    /// Anything this build does not recognise. Carries the wire code so the
    /// contract's `typeTag` can name it.
    Unknown(u16),
}

impl AppKind {
    const CHAT: u16 = 1;
    const RECEIPT: u16 = 2;
    const GAP_REQUEST: u16 = 3;
    const GAP_RESPONSE: u16 = 4;
    const EPHEMERAL_HINT: u16 = 5;
    const PURGE_REQUEST: u16 = 6;
    const PURGE_ACK: u16 = 7;
    const QUEUE_ADVERT: u16 = 8;

    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::Chat => Self::CHAT,
            Self::Receipt => Self::RECEIPT,
            Self::GapRequest => Self::GAP_REQUEST,
            Self::GapResponse => Self::GAP_RESPONSE,
            Self::EphemeralHint => Self::EPHEMERAL_HINT,
            Self::PurgeRequest => Self::PURGE_REQUEST,
            Self::PurgeAck => Self::PURGE_ACK,
            Self::QueueAdvert => Self::QUEUE_ADVERT,
            Self::Unknown(code) => code,
        }
    }

    #[must_use]
    pub const fn from_code(code: u16) -> Self {
        match code {
            Self::CHAT => Self::Chat,
            Self::RECEIPT => Self::Receipt,
            Self::GAP_REQUEST => Self::GapRequest,
            Self::GAP_RESPONSE => Self::GapResponse,
            Self::EPHEMERAL_HINT => Self::EphemeralHint,
            Self::PURGE_REQUEST => Self::PurgeRequest,
            Self::PURGE_ACK => Self::PurgeAck,
            Self::QUEUE_ADVERT => Self::QueueAdvert,
            other => Self::Unknown(other),
        }
    }

    /// The string `CLIENT-CONTRACT.md` §3.4's `{ kind: "unsupported"; typeTag }`
    /// shows. Stable across builds so a bug report quotes something findable.
    #[must_use]
    pub fn type_tag(self) -> String {
        match self {
            Self::Chat => "chat".into(),
            Self::Receipt => "receipt".into(),
            Self::GapRequest => "gap_request".into(),
            Self::GapResponse => "gap_response".into(),
            Self::EphemeralHint => "ephemeral_hint".into(),
            Self::PurgeRequest => "purge_request".into(),
            Self::PurgeAck => "purge_ack".into(),
            Self::QueueAdvert => "queue_advert".into(),
            Self::Unknown(code) => format!("unknown/{code:#06x}"),
        }
    }
}

/// §8's retention class, on the wire.
///
/// Not the same thing as §3.7's retention *policy*: this rides with the message
/// and says what kind of thing it is, while the policy is local to each device
/// and says how long that device keeps it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionClass {
    Chat,
    /// Retained by default (`ARCHITECTURE.md` §8.5).
    Ceremony,
}

impl RetentionClass {
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Chat => 1,
            Self::Ceremony => 2,
        }
    }

    #[must_use]
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Chat),
            2 => Some(Self::Ceremony),
            _ => None,
        }
    }
}

/// `ARCHITECTURE.md` §7's `msg_id`: BLAKE2b-256 over the labelled canonical
/// encoding of everything in the envelope except the id itself.
///
/// It is **the** dedup key. Not `clientRef`, which is the frontend's own
/// optimistic-row key, and not any tuple involving `sentAt`, which is
/// attacker-controlled. Duplicates are expected — a device may publish queue
/// addresses on *k* relays and senders send to all *k*.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MsgId([u8; 32]);

impl MsgId {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The lowercase hex the contract carries on the wire.
    #[must_use]
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    /// Parse the contract's hex form.
    ///
    /// # Errors
    ///
    /// [`FramingError::MalformedMsgId`] if it is not 64 hex characters.
    pub fn from_hex(text: &str) -> Result<Self, FramingError> {
        let bytes = hex::decode(text).map_err(|_| FramingError::MalformedMsgId)?;
        let array: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| FramingError::MalformedMsgId)?;
        Ok(Self(array))
    }
}

/// Redacted, like every other opaque byte type in this tree. A `msg_id` is not
/// secret, but a derived `Debug` prints 32 decimal integers and this type is
/// held by every receive path.
impl core::fmt::Debug for MsgId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "MsgId({})", self.to_hex())
    }
}

impl From<Digest> for MsgId {
    fn from(digest: Digest) -> Self {
        Self(*digest.as_bytes())
    }
}

/// The hashed preimage: §7's envelope minus `msg_id`.
///
/// Separated from [`AppMessage`] as a type rather than as a convention, so that
/// "canonical(rest)" is a thing the compiler knows about and `msg_id` cannot
/// accidentally be computed over a structure that contains itself.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AppMessageTbs {
    /// [`ENVELOPE_VERSION`].
    pub version: u16,
    /// [`AppKind::code`].
    pub kind: u16,
    /// Every message this sender had received and not yet referenced, at send
    /// time. The DAG.
    pub parents: VecU16<Digest>,
    /// The MLS epoch. Ordering key 1, and protocol-authenticated.
    pub epoch: u64,
    /// **ADVISORY ONLY** (§7, §9 rule 2). It is here because a UI may render
    /// the sender's claim next to a message; it is never used to order, filter,
    /// deduplicate, bound a query, decide whether something is "new", or feed
    /// any security decision.
    pub sent_at: u64,
    /// [`RetentionClass::code`].
    pub retention_class: u8,
    /// The kind's own payload. `opaque body<0..2^24-1>`.
    pub body: Body,
}

/// §7's envelope, wrapped in an MLS `PrivateMessage` by the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppMessage {
    tbs: AppMessageTbs,
    msg_id: MsgId,
    encoded: Vec<u8>,
}

impl AppMessage {
    /// Build an envelope and compute its `msg_id`.
    ///
    /// # Errors
    ///
    /// [`FramingError::Encoding`] if the body exceeds `2^24 - 1` bytes or the
    /// parent set exceeds what a 16-bit byte-length prefix can describe.
    pub fn new(
        kind: AppKind,
        parents: &[MsgId],
        epoch: u64,
        sent_at: u64,
        retention_class: RetentionClass,
        body: &[u8],
    ) -> Result<Self, FramingError> {
        let tbs = AppMessageTbs {
            version: ENVELOPE_VERSION,
            kind: kind.code(),
            parents: VecU16::new(
                parents
                    .iter()
                    .map(|parent| Digest::from(*parent.as_bytes()))
                    .collect(),
            ),
            epoch,
            sent_at,
            retention_class: retention_class.code(),
            body: Body::new(body.to_vec()).map_err(FramingError::Encoding)?,
        };
        Self::seal(tbs)
    }

    fn seal(tbs: AppMessageTbs) -> Result<Self, FramingError> {
        let encoded = encode(&tbs).map_err(FramingError::Encoding)?;
        let msg_id = MsgId::from(hash(LABEL_MSG_ID, &encoded));
        Ok(Self {
            tbs,
            msg_id,
            encoded,
        })
    }

    /// Decode an envelope that arrived inside an MLS `PrivateMessage`, under
    /// `WIRE.md` §3.3's re-encode-equality rule, and recompute its `msg_id`.
    ///
    /// The id is **recomputed, never carried**: a received `msg_id` field would
    /// be a sender-chosen value, and a receiver that trusted it could be made
    /// to store two different messages under one id, or one message under an id
    /// that collides with a parent it is waiting for.
    ///
    /// # Errors
    ///
    /// [`FramingError::Encoding`] on a malformed or non-canonical encoding —
    /// trailing bytes, an over-wide length prefix, a vector whose declared
    /// length exceeds its contents. [`FramingError::UnsupportedVersion`] if the
    /// envelope version is not one this build understands.
    pub fn decode(bytes: &[u8]) -> Result<Self, FramingError> {
        let canonical = decode_canonical::<AppMessageTbs>(bytes).map_err(FramingError::Encoding)?;
        let tbs = canonical.value().clone();
        if tbs.version != ENVELOPE_VERSION {
            return Err(FramingError::UnsupportedVersion(tbs.version));
        }
        Self::seal(tbs)
    }

    /// The canonical bytes to place in the MLS `PrivateMessage`.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.encoded
    }

    #[must_use]
    pub const fn msg_id(&self) -> MsgId {
        self.msg_id
    }

    #[must_use]
    pub fn kind(&self) -> AppKind {
        AppKind::from_code(self.tbs.kind)
    }

    #[must_use]
    pub fn parents(&self) -> Vec<MsgId> {
        self.tbs
            .parents
            .as_slice()
            .iter()
            .map(|digest| MsgId::from_bytes(*digest.as_bytes()))
            .collect()
    }

    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.tbs.epoch
    }

    /// The sender's clock, and nothing more. See [`AppMessageTbs::sent_at`].
    #[must_use]
    pub const fn advisory_sent_at(&self) -> u64 {
        self.tbs.sent_at
    }

    /// `None` for a retention class this build does not recognise, which is
    /// treated as `Chat` by the caller rather than rejected — an unknown class
    /// is a forward-compatibility case, not an attack.
    #[must_use]
    pub fn retention_class(&self) -> Option<RetentionClass> {
        RetentionClass::from_code(self.tbs.retention_class)
    }

    #[must_use]
    pub fn body(&self) -> &[u8] {
        self.tbs.body.as_slice()
    }
}

/// §7's deterministic **total order**: `(epoch, sender_leaf_index, msg_id)`.
///
/// All three fields are protocol-authenticated, which is the whole reason the
/// rule exists: every client applying it to the same set produces the same
/// transcript. The sender's wall clock is not in it and must never be.
///
/// **Insertion is not append.** A message can arrive whose key places it
/// mid-transcript; a list built from this sorts rather than pushes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SortKey {
    pub epoch: u64,
    pub sender_leaf_index: u32,
    pub msg_id: MsgId,
}

impl SortKey {
    #[must_use]
    pub const fn new(epoch: u64, sender_leaf_index: u32, msg_id: MsgId) -> Self {
        Self {
            epoch,
            sender_leaf_index,
            msg_id,
        }
    }

    /// A lexicographically ordered opaque cursor, so `list_messages`'s
    /// `before`/`after` are the same order the transcript is in.
    #[must_use]
    pub fn to_cursor(self) -> String {
        format!(
            "{:016x}{:08x}{}",
            self.epoch,
            self.sender_leaf_index,
            self.msg_id.to_hex()
        )
    }
}

/// The narrow error set this module can produce.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FramingError {
    Encoding(CodecError),
    UnsupportedVersion(u16),
    MalformedMsgId,
}

impl core::fmt::Display for FramingError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Encoding(error) => write!(f, "non-canonical application envelope: {error:?}"),
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported application envelope version {version:#06x}")
            }
            Self::MalformedMsgId => f.write_str("a msg_id is 64 hex characters"),
        }
    }
}

impl core::error::Error for FramingError {}

/// A `ShortBytes` helper the kind-specific bodies share. Kept here so the one
/// module that owns the envelope also owns how its bodies are framed.
///
/// # Errors
///
/// [`FramingError::Encoding`] if the slice is longer than 255 bytes.
pub fn short(bytes: &[u8]) -> Result<ShortBytes, FramingError> {
    ShortBytes::new(bytes.to_vec()).map_err(FramingError::Encoding)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(parents: &[MsgId], body: &[u8]) -> AppMessage {
        AppMessage::new(
            AppKind::Chat,
            parents,
            3,
            1_700_000_000_000,
            RetentionClass::Chat,
            body,
        )
        .expect("envelope")
    }

    #[test]
    fn a_round_trip_recomputes_the_same_msg_id() {
        let message = sample(&[], b"hello");
        let decoded = AppMessage::decode(message.as_bytes()).expect("decode");
        assert_eq!(decoded.msg_id(), message.msg_id());
        assert_eq!(decoded.body(), b"hello");
        assert_eq!(decoded.kind(), AppKind::Chat);
        assert_eq!(decoded.epoch(), 3);
    }

    #[test]
    fn the_msg_id_covers_every_field_of_the_preimage() {
        let base = sample(&[], b"hello");
        // A different body, a different epoch, a different advisory clock and a
        // different parent set must each move the id. The clock is advisory for
        // *ordering*; it is still inside the preimage, which is what stops two
        // identical messages sent twice from colliding.
        assert_ne!(sample(&[], b"hellp").msg_id(), base.msg_id());
        assert_ne!(
            AppMessage::new(
                AppKind::Chat,
                &[],
                4,
                1_700_000_000_000,
                RetentionClass::Chat,
                b"hello"
            )
            .expect("envelope")
            .msg_id(),
            base.msg_id()
        );
        assert_ne!(
            AppMessage::new(
                AppKind::Chat,
                &[],
                3,
                1_700_000_000_001,
                RetentionClass::Chat,
                b"hello"
            )
            .expect("envelope")
            .msg_id(),
            base.msg_id()
        );
        assert_ne!(sample(&[base.msg_id()], b"hello").msg_id(), base.msg_id());
        assert_ne!(
            AppMessage::new(
                AppKind::Receipt,
                &[],
                3,
                1_700_000_000_000,
                RetentionClass::Chat,
                b"hello"
            )
            .expect("envelope")
            .msg_id(),
            base.msg_id()
        );
    }

    #[test]
    fn parents_survive_a_round_trip_in_order() {
        let first = sample(&[], b"1");
        let second = sample(&[], b"2");
        let child = sample(&[first.msg_id(), second.msg_id()], b"3");
        let decoded = AppMessage::decode(child.as_bytes()).expect("decode");
        assert_eq!(decoded.parents(), vec![first.msg_id(), second.msg_id()]);
    }

    #[test]
    fn trailing_bytes_are_refused_rather_than_ignored() {
        // WIRE.md §3.3's re-encode-equality rule, reached through the same
        // decoder the relay protocol uses.
        let mut bytes = sample(&[], b"hello").as_bytes().to_vec();
        bytes.push(0);
        assert!(matches!(
            AppMessage::decode(&bytes),
            Err(FramingError::Encoding(_))
        ));
    }

    #[test]
    fn an_unknown_kind_decodes_and_names_itself() {
        let message = AppMessage::new(
            AppKind::Unknown(0x4242),
            &[],
            1,
            0,
            RetentionClass::Chat,
            b"",
        )
        .expect("envelope");
        let decoded = AppMessage::decode(message.as_bytes()).expect("decode");
        assert_eq!(decoded.kind(), AppKind::Unknown(0x4242));
        assert_eq!(decoded.kind().type_tag(), "unknown/0x4242");
    }

    #[test]
    fn a_future_envelope_version_is_refused_loudly() {
        let mut bytes = sample(&[], b"hello").as_bytes().to_vec();
        bytes[0] = 0xff;
        bytes[1] = 0xff;
        assert_eq!(
            AppMessage::decode(&bytes),
            Err(FramingError::UnsupportedVersion(0xffff))
        );
    }

    #[test]
    fn the_total_order_is_epoch_then_leaf_then_id_and_never_the_clock() {
        let low = MsgId::from_bytes([0x00; 32]);
        let high = MsgId::from_bytes([0xff; 32]);

        assert!(
            SortKey::new(1, 9, high) < SortKey::new(2, 0, low),
            "epoch dominates"
        );
        assert!(
            SortKey::new(2, 0, high) < SortKey::new(2, 1, low),
            "then leaf index"
        );
        assert!(
            SortKey::new(2, 1, low) < SortKey::new(2, 1, high),
            "then msg_id"
        );
    }

    #[test]
    fn a_cursor_sorts_the_same_way_the_transcript_does() {
        let mut keys = [
            SortKey::new(2, 1, MsgId::from_bytes([0xff; 32])),
            SortKey::new(1, 9, MsgId::from_bytes([0x00; 32])),
            SortKey::new(2, 0, MsgId::from_bytes([0x11; 32])),
        ];
        keys.sort_unstable();
        let cursors: Vec<String> = keys.iter().map(|key| key.to_cursor()).collect();
        let mut sorted = cursors.clone();
        sorted.sort();
        assert_eq!(cursors, sorted);
    }

    #[test]
    fn msg_id_hex_round_trips() {
        let id = sample(&[], b"x").msg_id();
        assert_eq!(MsgId::from_hex(&id.to_hex()).expect("hex"), id);
        assert_eq!(MsgId::from_hex("nope"), Err(FramingError::MalformedMsgId));
    }
}
