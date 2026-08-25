//! The plugin's adapter over `f2z-msg-dag`, and the three codepoints it had to
//! allocate.
//!
//! `ARCHITECTURE.md` §7's framing, `msg_id`, causal order, gap detection and
//! repair all live in `rs/crates/f2z-msg-dag` — a `no_std` crate that reaches
//! `wasm32-unknown-unknown`, so ZUULI and the browser client share one
//! implementation (ADR 0001). This module is the thin layer between it and the
//! engine: hex on the wire to the frontend, bytes everywhere below.
//!
//! # This file used to be an implementation, and that is worth recording
//!
//! `f2z-msg-dag` did not exist when this plugin was started, so `src/framing.rs`
//! was §7 written narrowly enough to be deleted. It is deleted. The crate
//! landed while this was in flight (#732), and adopting it fixed a real defect
//! rather than merely removing duplication: `framing.rs` linearised a
//! conversation by the sort key **alone**, and `f2z_msg_dag::order` documents
//! exactly what that costs —
//!
//! > Applying the sort key on its own … puts replies above the messages they
//! > reply to … in every one-to-one conversation where the replier holds the
//! > lower leaf index, which is half of them.
//!
//! §7's rule has two halves, and the causal partial order is the primary one;
//! `(epoch, sender_leaf_index, msg_id)` breaks ties between messages the DAG
//! leaves **incomparable**. Two independent readings of the same paragraph
//! landed on the wrong half, which is a good argument for one crate.
//!
//! The same defect is live in `wallet/zuuli/src/lib/messaging/types.ts`'s
//! `compareMessages`, and `f2z-msg-dag`'s `tests/typescript_parity.rs` pins the
//! disagreement deliberately. See the plugin README.
//!
//! # The three codepoints
//!
//! `MessageType` is open — an unrecognised `u8` round-trips — and the crate
//! names seven: `CHAT`, `RECEIPT`, `GAP_REQUEST`, `GAP_RESPONSE`, `CEREMONY`,
//! `QUEUE_ADVERT`, `WEBRTC_OFFER`. Those are `ARCHITECTURE.md` §7's list.
//!
//! `CLIENT-CONTRACT.md` asks for three payloads §7's list does not name: §3.8's
//! ephemeral hint, and §3.9's purge request and its acknowledgement. They have
//! to travel inside MLS — a hint is only meaningful because it is confidential,
//! authenticated and **attributable** — so they need codepoints, and the crate
//! has none for them. The three below continue the sequence rather than reusing
//! anything, and they are stated here rather than passed around as literals so
//! that registering them upstream is one diff.

pub use f2z_msg_dag::{
    AppMessage, AppMessageTbs, DagEntry, DagError, GapRequest, GapResponse, GapState, Insertion,
    MessageDag, MessageType, MsgId, Parents, RepairEntry, RepairRefusal, RetentionClass, SentAt,
};

use f2z_codec::types::Body;

use crate::error::{Error, Result};

/// §3.8's ephemeral hint. **Plugin-allocated**, pending registration in
/// `f2z-msg-dag`.
pub const EPHEMERAL_HINT: MessageType = MessageType::new(8);
/// §3.9's purge request. **Plugin-allocated**, pending registration.
pub const PURGE_REQUEST: MessageType = MessageType::new(9);
/// §3.9's `PurgeAck`. **Plugin-allocated**, pending registration.
pub const PURGE_ACK: MessageType = MessageType::new(10);

/// Whether a message type is part of the **persisted transcript**, and
/// therefore a vertex the causal DAG tracks.
///
/// §7's `type` list names `receipt`, `gap_request`, `gap_response` and
/// `queue_advert` alongside `chat`, and every one of them is an `AppMessage`
/// carrying `parents`. Being an `AppMessage` does not make it *history*, and
/// this function is where that distinction is drawn:
///
/// * **Carried:** every one of them carries `parents`, so a receiver can notice
///   a hole in the chat history *before* acting on a hint or a purge request.
/// * **Not tracked:** a control payload does not become a head and is not
///   inserted into the DAG on either side.
///
/// # Why, concretely
///
/// A vertex has to survive a restart or it manufactures gaps. This plugin
/// persists the transcript and rebuilds the DAG from it, so a vertex with no
/// store record is a vertex that disappears — and the next message referencing
/// it produces a dangling parent for something that was never lost. The
/// two-process harness found exactly that: the joiner's `queue_advert` became
/// a head, the initiator's first chat referenced it, and the joiner reported a
/// gap for its own message.
///
/// The alternative is to persist control payloads as transcript records the UI
/// then has to filter. That trades a real hazard for a cosmetic one, and it
/// makes `gap_response` a thing that can itself be repaired. The cost of the
/// choice here is stated rather than hidden: **a lost `queue_advert` or
/// ephemeral hint is undetectable.** For the advert that is fine — it shows up
/// immediately as a conversation that cannot send, which is louder than a gap
/// marker — and for a hint it is exactly what §3.8 already says a hint is: a
/// courtesy signal with no delivery guarantee anyone can check.
#[must_use]
pub const fn is_transcript_vertex(message_type: MessageType) -> bool {
    !matches!(
        message_type.code(),
        // RECEIPT, GAP_REQUEST, GAP_RESPONSE, QUEUE_ADVERT
        2 | 3 | 4 | 6
        // EPHEMERAL_HINT, PURGE_REQUEST, PURGE_ACK
        | 8 | 9 | 10
    )
}

/// Build and seal a §7 envelope.
///
/// `parents` is handed over unsorted; [`Parents::new`] puts it in the strictly
/// ascending order the crate requires, because a head *set* has to encode one
/// way or `msg_id` is not a function of the content.
///
/// `sender_leaf_index` is this device's own MLS leaf. It is a hashed field
/// rather than something the receiver reads off the framing — see the field's
/// documentation on [`AppMessageTbs`] — so passing the wrong one produces a
/// message the peer refuses with `DagError::LeafIndexMismatch` rather than one
/// that quietly sorts to the wrong place.
///
/// # Errors
///
/// `internal` when the body or the parent list is longer than its length prefix
/// can describe — §9 says chunk above a bucket, and chunking is the
/// application's job rather than this layer's.
pub fn seal(
    message_type: MessageType,
    parents: &[MsgId],
    epoch: u64,
    sender_leaf_index: u32,
    sent_at_ms: i64,
    retention_class: RetentionClass,
    body: &[u8],
) -> Result<AppMessage> {
    let tbs = AppMessageTbs {
        message_type,
        parents: Parents::new(parents.to_vec()).map_err(dag_error)?,
        epoch,
        // Hashed, and authoritative (#734). The MLS framing carries the same
        // value on a direct delivery and `DagEntry::from_delivered` refuses a
        // message where the two disagree — one source of truth, cross-checked.
        // It has to be in the preimage because repair delivers a message
        // outside the framing it was authored in, and a sort key readable only
        // off the delivery gave two receivers who learned one message by
        // different routes different transcripts.
        sender_leaf_index,
        // Advisory, and the type says so: `SentAt` implements neither `Ord` nor
        // `PartialOrd`, so nothing downstream can order by it even by accident.
        sent_at: SentAt::new(u64::try_from(sent_at_ms).unwrap_or_default()),
        retention_class,
        body: Body::new(body.to_vec())
            .map_err(|error| Error::internal(format!("body: {error:?}")))?,
    };
    AppMessage::seal(tbs).map_err(dag_error)
}

/// The hex form the contract carries on the wire.
#[must_use]
pub fn to_hex(msg_id: MsgId) -> String {
    msg_id.to_lower_hex()
}

/// Parse the contract's hex form.
///
/// # Errors
///
/// `internal` if it is not 64 hex characters.
pub fn from_hex(text: &str) -> Result<MsgId> {
    let bytes = hex::decode(text).map_err(|_| Error::internal("a msg_id is not hex"))?;
    MsgId::from_slice(&bytes).map_err(|_| Error::internal("a msg_id is not 32 bytes"))
}

/// The string `CLIENT-CONTRACT.md` §3.4's `{ kind: "unsupported"; typeTag }`
/// shows. Stable across builds, so a bug report quotes something findable.
#[must_use]
pub fn type_tag(message_type: MessageType) -> String {
    match message_type {
        MessageType::CHAT => "chat".into(),
        MessageType::RECEIPT => "receipt".into(),
        MessageType::GAP_REQUEST => "gap_request".into(),
        MessageType::GAP_RESPONSE => "gap_response".into(),
        MessageType::CEREMONY => "ceremony".into(),
        MessageType::QUEUE_ADVERT => "queue_advert".into(),
        MessageType::WEBRTC_OFFER => "webrtc_offer".into(),
        EPHEMERAL_HINT => "ephemeral_hint".into(),
        PURGE_REQUEST => "purge_request".into(),
        PURGE_ACK => "purge_ack".into(),
        other => format!("unknown/{:#04x}", other.code()),
    }
}

/// A `Body` from bytes, for the crate's `to_body`/`from_body` pairs.
///
/// # Errors
///
/// `internal` when the bytes are longer than a 24-bit length prefix.
pub fn body(bytes: &[u8]) -> Result<Body> {
    Body::new(bytes.to_vec()).map_err(|error| Error::internal(format!("body: {error:?}")))
}

/// `f2z-msg-dag`'s errors, mapped into §8's union.
///
/// All of them are `internal`, and that is the right answer rather than a
/// shortcut: every one describes *our own* encoding or a peer's payload that
/// MLS already authenticated. None of them is something a relay or a log chose,
/// so none may reach a code that means an attack (§8.1's note).
pub fn dag_error(error: DagError) -> Error {
    Error::internal(format!("§7 framing: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_allocated_codepoints_do_not_collide_with_the_crates() {
        for named in [
            MessageType::CHAT,
            MessageType::RECEIPT,
            MessageType::GAP_REQUEST,
            MessageType::GAP_RESPONSE,
            MessageType::CEREMONY,
            MessageType::QUEUE_ADVERT,
            MessageType::WEBRTC_OFFER,
        ] {
            for allocated in [EPHEMERAL_HINT, PURGE_REQUEST, PURGE_ACK] {
                assert_ne!(
                    named.code(),
                    allocated.code(),
                    "a plugin codepoint took a registered one"
                );
            }
        }
        // And they are distinct from each other.
        let mut codes = [
            EPHEMERAL_HINT.code(),
            PURGE_REQUEST.code(),
            PURGE_ACK.code(),
        ];
        codes.sort_unstable();
        assert_eq!(codes, [8, 9, 10]);
    }

    #[test]
    fn every_codepoint_this_build_sends_has_a_stable_tag() {
        for message_type in [
            MessageType::CHAT,
            MessageType::GAP_REQUEST,
            MessageType::GAP_RESPONSE,
            MessageType::QUEUE_ADVERT,
            EPHEMERAL_HINT,
            PURGE_REQUEST,
            PURGE_ACK,
        ] {
            assert!(!type_tag(message_type).starts_with("unknown/"));
        }
        assert_eq!(type_tag(MessageType::new(0x42)), "unknown/0x42");
    }

    #[test]
    fn chat_and_anything_unrecognised_are_transcript_vertices() {
        assert!(is_transcript_vertex(MessageType::CHAT));
        assert!(is_transcript_vertex(MessageType::CEREMONY));
        // An unknown codepoint is rendered as `{ kind: "unsupported" }` (§3.4)
        // and is therefore history: it occupies a place in the transcript, so
        // losing it is a hole a receiver should notice.
        assert!(is_transcript_vertex(MessageType::new(0x42)));

        for control in [
            MessageType::RECEIPT,
            MessageType::GAP_REQUEST,
            MessageType::GAP_RESPONSE,
            MessageType::QUEUE_ADVERT,
            EPHEMERAL_HINT,
            PURGE_REQUEST,
            PURGE_ACK,
        ] {
            assert!(!is_transcript_vertex(control), "{}", type_tag(control));
        }
    }

    #[test]
    fn a_sealed_envelope_round_trips_and_recomputes_its_own_id() {
        let message = seal(
            MessageType::CHAT,
            &[],
            3,
            0,
            1_700_000_000_000,
            RetentionClass::Chat,
            b"hello",
        )
        .expect("seal");
        let encoded = message.encode().expect("encode");
        let decoded = AppMessage::decode(&encoded).expect("decode");
        assert_eq!(decoded.msg_id(), message.msg_id());
        assert_eq!(decoded.tbs().body.as_slice(), b"hello");
    }

    #[test]
    fn parents_are_canonicalised_so_a_head_set_encodes_one_way() {
        let a = seal(MessageType::CHAT, &[], 1, 0, 0, RetentionClass::Chat, b"a")
            .expect("seal")
            .msg_id();
        let b = seal(MessageType::CHAT, &[], 1, 0, 0, RetentionClass::Chat, b"b")
            .expect("seal")
            .msg_id();

        // The same head set handed over in either order must produce the same
        // `msg_id`, or the id is a function of iteration order rather than of
        // content — and two clients would disagree about the name of the same
        // message.
        let one = seal(
            MessageType::CHAT,
            &[a, b],
            1,
            0,
            0,
            RetentionClass::Chat,
            b"x",
        )
        .expect("seal");
        let other = seal(
            MessageType::CHAT,
            &[b, a],
            1,
            0,
            0,
            RetentionClass::Chat,
            b"x",
        )
        .expect("seal");
        assert_eq!(one.msg_id(), other.msg_id());
    }

    #[test]
    fn a_msg_id_round_trips_through_the_contracts_hex_form() {
        let id = seal(MessageType::CHAT, &[], 1, 0, 0, RetentionClass::Chat, b"x")
            .expect("seal")
            .msg_id();
        assert_eq!(from_hex(&to_hex(id)).expect("hex"), id);
        assert!(from_hex("nope").is_err());
    }
}
