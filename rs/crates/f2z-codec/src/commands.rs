//! The command set — `WIRE.md` §6, §11 and §12.2 — as `tls_codec` structures.
//!
//! Command and event codes are `uint16` and are **stable forever** (§6, §10).
//! They are carried on the wire as raw integers by [`Request`] and [`Push`];
//! [`Command`] and [`PushEvent`] are the resolution of a code this build knows,
//! never a decoding step. See [`crate::frame::Request::command`] for why that
//! distinction is load-bearing.
//!
//! [`Request`]: crate::frame::Request
//! [`Push`]: crate::frame::Push

// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;
use alloc::vec::Vec;

use tls_codec::{
    DeserializeBytes, Error as TlsError, TlsDeserializeBytes, TlsSerializeBytes, TlsSize,
};

use crate::error::CodecError;
use crate::pow::{PowParams, PowStamp};
use crate::types::{Challenge, Digest, Payload, PublicKey, QueueAddress, ShortBytes, Signature};
use crate::vec::{VecU8, VecU16, VecU24};

/// A relay command code (`WIRE.md` §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum Command {
    /// `0x0001`, unsigned. MUST be the first frame.
    Hello,
    /// `0x0002`, unsigned.
    GetCapabilities,
    /// `0x0003`, unsigned.
    GetChallenge,
    /// `0x0004`, unsigned.
    Ping,
    /// `0x0010`, signed by the recv key; transcript address is zeros.
    CreateQueue,
    /// `0x0011`, signed by the recv key.
    Subscribe,
    /// `0x0012`, signed by the recv key.
    Unsubscribe,
    /// `0x0013`, signed by the recv key.
    Read,
    /// `0x0014`, signed by the recv key.
    Ack,
    /// `0x0015`, signed by the recv key.
    DeleteQueue,
    /// `0x0020`, signed by the send key. Once-only and irreversible (§7.3).
    BindSend,
    /// `0x0021`, signed by the send key.
    Append,
    /// `0x0030`, signed by the recv key; transcript address is zeros.
    CreateContactQueue,
    /// `0x0031`, unsigned; gated by proof of work (§12.2).
    ContactAppend,
}

/// Which key authorizes a command (`WIRE.md` §6's table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Auth {
    /// No signature. `CONTACT_APPEND` is here too: it is gated by proof of
    /// work, not by a key, because the whole internet is meant to write to a
    /// contact queue (§12.2).
    None,
    /// Signed by the queue's receive-side key.
    RecvKey,
    /// Signed by the queue's send-side key.
    SendKey,
}

/// What the transcript's `address` field holds for a command (§6's table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptAddress {
    /// The command is unsigned; there is no transcript.
    None,
    /// 32 zero bytes — the queue does not exist yet (`CREATE_QUEUE`,
    /// `CREATE_CONTACT_QUEUE`).
    Zeros,
    /// The queue's receive address.
    RecvAddr,
    /// The queue's send address.
    SendAddr,
}

impl Command {
    /// Every command, in code order.
    pub const ALL: [Self; 14] = [
        Self::Hello,
        Self::GetCapabilities,
        Self::GetChallenge,
        Self::Ping,
        Self::CreateQueue,
        Self::Subscribe,
        Self::Unsubscribe,
        Self::Read,
        Self::Ack,
        Self::DeleteQueue,
        Self::BindSend,
        Self::Append,
        Self::CreateContactQueue,
        Self::ContactAppend,
    ];

    /// The wire code.
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::Hello => 0x0001,
            Self::GetCapabilities => 0x0002,
            Self::GetChallenge => 0x0003,
            Self::Ping => 0x0004,
            Self::CreateQueue => 0x0010,
            Self::Subscribe => 0x0011,
            Self::Unsubscribe => 0x0012,
            Self::Read => 0x0013,
            Self::Ack => 0x0014,
            Self::DeleteQueue => 0x0015,
            Self::BindSend => 0x0020,
            Self::Append => 0x0021,
            Self::CreateContactQueue => 0x0030,
            Self::ContactAppend => 0x0031,
        }
    }

    /// Resolve a code this build knows.
    ///
    /// `None` means `ERR_UNKNOWN_COMMAND` — non-fatal (§3.5, §10).
    #[must_use]
    pub const fn from_code(code: u16) -> Option<Self> {
        Some(match code {
            0x0001 => Self::Hello,
            0x0002 => Self::GetCapabilities,
            0x0003 => Self::GetChallenge,
            0x0004 => Self::Ping,
            0x0010 => Self::CreateQueue,
            0x0011 => Self::Subscribe,
            0x0012 => Self::Unsubscribe,
            0x0013 => Self::Read,
            0x0014 => Self::Ack,
            0x0015 => Self::DeleteQueue,
            0x0020 => Self::BindSend,
            0x0021 => Self::Append,
            0x0030 => Self::CreateContactQueue,
            0x0031 => Self::ContactAppend,
            _ => return None,
        })
    }

    /// Which key must sign this command.
    #[must_use]
    pub const fn auth(self) -> Auth {
        match self {
            Self::Hello
            | Self::GetCapabilities
            | Self::GetChallenge
            | Self::Ping
            | Self::ContactAppend => Auth::None,
            Self::CreateQueue
            | Self::Subscribe
            | Self::Unsubscribe
            | Self::Read
            | Self::Ack
            | Self::DeleteQueue
            | Self::CreateContactQueue => Auth::RecvKey,
            Self::BindSend | Self::Append => Auth::SendKey,
        }
    }

    /// What the transcript's `address` field holds.
    #[must_use]
    pub const fn transcript_address(self) -> TranscriptAddress {
        match self {
            Self::Hello
            | Self::GetCapabilities
            | Self::GetChallenge
            | Self::Ping
            | Self::ContactAppend => TranscriptAddress::None,
            Self::CreateQueue | Self::CreateContactQueue => TranscriptAddress::Zeros,
            Self::Subscribe | Self::Unsubscribe | Self::Read | Self::Ack | Self::DeleteQueue => {
                TranscriptAddress::RecvAddr
            }
            Self::BindSend | Self::Append => TranscriptAddress::SendAddr,
        }
    }
}

/// A server push event (`WIRE.md` §6.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum PushEvent {
    /// `0x0080` — a message arrived on a subscribed queue. Receive side only,
    /// always: a push to a sender would tell it something about queue state,
    /// which §6.3 forbids.
    Msg,
    /// `0x0081` — the queue was deleted, expired, or hit a quota.
    QueueEvent,
    /// `0x0082` — the relay is draining, shutting down, or has changed its
    /// capability document.
    Notice,
}

impl PushEvent {
    /// Every event, in code order.
    pub const ALL: [Self; 3] = [Self::Msg, Self::QueueEvent, Self::Notice];

    /// The wire code.
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::Msg => 0x0080,
            Self::QueueEvent => 0x0081,
            Self::Notice => 0x0082,
        }
    }

    /// Resolve a code this build knows. `None` means "ignore this push".
    #[must_use]
    pub const fn from_code(code: u16) -> Option<Self> {
        Some(match code {
            0x0080 => Self::Msg,
            0x0081 => Self::QueueEvent,
            0x0082 => Self::Notice,
            _ => return None,
        })
    }
}

// ---------------------------------------------------------------------------
// §6.1 — unsigned commands
// ---------------------------------------------------------------------------

/// `HELLO` request (§6.1).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct HelloRequest {
    /// Lowest protocol version this client supports.
    pub min_version: u16,
    /// Highest protocol version this client supports.
    pub max_version: u16,
    /// Fresh client randomness, covered by `relay_proof` (§5.2).
    pub client_nonce: Challenge,
}

/// `HELLO` response (§6.1).
///
/// The client MUST verify `relay_proof`, MUST recompute `relay_id` from
/// `relay_identity_pk` ([`crate::hash::relay_id`]), and MUST compare `relay_id`
/// against any value it obtained from an in-band advert (§7.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct HelloResponse {
    /// The version selected for this connection.
    pub protocol_version: u16,
    /// The relay's long-term Ed25519 public key.
    pub relay_identity_pk: PublicKey,
    /// MUST equal `H("free2z/relay/v1/relay-id", relay_identity_pk)`.
    pub relay_id: crate::types::RelayId,
    /// Proof of possession of `relay_identity_pk` (§5.2).
    pub relay_proof: Signature,
    /// The relay's clock, for clients whose own clock is unreliable (§5.5).
    pub relay_time_ms: u64,
    /// 0 = none, 1 = tls-exporter (§5.3).
    pub channel_binding_mode: u8,
    /// 0 = none, 1 = tls (§2.3).
    pub transport_security: u8,
    /// `H("free2z/relay/v1/caps", tls_codec(Capabilities))` (§6.1).
    pub capabilities_digest: Digest,
}

/// `ChallengePurpose` (§6.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChallengePurpose {
    /// `0` — the client only wants the relay's clock.
    Clock,
    /// `1` — a stamp for `CREATE_QUEUE` / `CREATE_CONTACT_QUEUE`.
    QueueCreate,
    /// `2` — a stamp for `CONTACT_APPEND`; `scope` is the target
    /// `contact_addr`.
    ContactAppend,
}

impl ChallengePurpose {
    /// The wire byte.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Clock => 0,
            Self::QueueCreate => 1,
            Self::ContactAppend => 2,
        }
    }

    /// Parse the wire byte.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] for anything but 0, 1 or 2.
    pub const fn from_code(code: u8) -> Result<Self, CodecError> {
        Ok(match code {
            0 => Self::Clock,
            1 => Self::QueueCreate,
            2 => Self::ContactAppend,
            _ => return Err(CodecError::InvalidValue),
        })
    }
}

/// `GET_CHALLENGE` request (§6.1).
///
/// `purpose` is a raw `u8` for the same reason command codes are raw: `(255)`
/// fixes the width, and preserving the value lets the relay answer an unknown
/// purpose with §6.1's fatal `ERR_MALFORMED` on the request's id. Resolve it
/// with [`ChallengeRequest::purpose`].
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ChallengeRequest {
    /// The `ChallengePurpose` byte.
    pub purpose: u8,
    /// For `contact_append`: exactly the 32-byte target `contact_addr`. Empty
    /// for `clock` and `queue_create`.
    pub scope: ShortBytes,
}

impl ChallengeRequest {
    /// The purpose, if this build knows it.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] for an unknown purpose byte.
    pub const fn purpose(&self) -> Result<ChallengePurpose, CodecError> {
        ChallengePurpose::from_code(self.purpose)
    }
}

/// `GET_CHALLENGE` response (§6.1).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ChallengeResponse {
    /// The relay's clock in milliseconds. Clients apply the offset locally and
    /// MUST NOT set their system clock from it (§5.5).
    pub relay_time_ms: u64,
    /// Single-use, expiring challenge for a [`PowStamp`].
    pub challenge: Challenge,
    /// When the challenge stops being accepted.
    pub expires_at_ms: u64,
    /// Current PoW parameters; zeroed when no PoW is required (§13.1).
    pub pow: PowParams,
}

// ---------------------------------------------------------------------------
// §6.2 — commands signed by the receive-side queue key
// ---------------------------------------------------------------------------

/// `CREATE_QUEUE` request (§6.2).
///
/// The transcript's `address` is 32 zero bytes and `signer_key` MUST equal
/// `recv_key`, so the request is self-authenticating: it proves possession of
/// the key the new queue will be bound to.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct CreateQueueRequest {
    /// The Ed25519 key authorizing the recv side.
    pub recv_key: PublicKey,
    /// Requested message TTL; clamped by the relay (§7.7).
    pub req_message_ttl_seconds: u32,
    /// Requested idle TTL; clamped by the relay (§7.7).
    pub req_idle_ttl_seconds: u32,
    /// Reserved; MUST be 0 in v1.
    pub flags: u16,
    /// Empty when `queue_creation_mode = open` (§13.1).
    pub stamp: PowStamp,
}

impl CreateQueueRequest {
    /// Check the "MUST be 0 in v1" rule on `flags`.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] when `flags != 0`.
    pub const fn validate(&self) -> Result<(), CodecError> {
        if self.flags == 0 {
            Ok(())
        } else {
            Err(CodecError::InvalidValue)
        }
    }
}

/// `CREATE_QUEUE` response (§6.2). Both addresses are generated by the relay
/// from its own CSPRNG (§7.1).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct CreateQueueResponse {
    /// The receive address: `READ`, `ACK`, `DELETE_QUEUE`.
    pub recv_addr: QueueAddress,
    /// The send address: `BIND_SEND`, then `APPEND`.
    pub send_addr: QueueAddress,
    /// Granted message TTL, after clamping.
    pub message_ttl_seconds: u32,
    /// Granted idle TTL, after clamping.
    pub idle_ttl_seconds: u32,
    /// Relay clock at creation.
    pub created_at_ms: u64,
}

/// `SUBSCRIBE` response (§6.2).
///
/// `pending` is disclosed to the **reader** only. There is no equivalent for a
/// sender, ever (§6.3).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SubscribeResponse {
    /// The index the next appended message will receive.
    pub next_index: u64,
    /// Messages present and not yet acked.
    pub pending: u64,
}

/// `READ` request (§6.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ReadRequest {
    /// Start index. Below the acked watermark returns from the watermark; the
    /// relay MUST NOT error, so a client recovering from a crash can simply ask
    /// for everything it might have missed.
    pub from_index: u64,
    /// Client-side cap on the number of messages returned.
    pub max_messages: u16,
    /// Client-side cap on the bytes returned.
    pub max_bytes: u32,
}

/// One stored message (§6.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct QueuedMessage {
    /// The queue index this message was appended at.
    pub index: u64,
    /// Relay clock when the message was accepted.
    pub received_at_ms: u64,
    /// The opaque ciphertext.
    pub payload: Payload,
}

/// `READ` response (§6.2). `READ` never mutates.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes)]
pub struct ReadResponse {
    /// The messages, `<0..2^24-1>` bytes of them.
    pub messages: VecU24<QueuedMessage>,
    /// 1 when more messages remain past the last one returned; 0 otherwise.
    pub has_more: u8,
}

impl DeserializeBytes for ReadResponse {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (messages, rest) = VecU24::<QueuedMessage>::tls_deserialize_bytes(bytes)?;
        let (has_more, rest) = u8::tls_deserialize_bytes(rest)?;
        if has_more > 1 {
            return Err(TlsError::UnknownValue(u64::from(has_more)));
        }
        Ok((Self { messages, has_more }, rest))
    }
}

/// `ACK` request (§6.2). Cumulative, monotone, idempotent, never selective
/// (§8).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AckRequest {
    /// Inclusive, cumulative. Beyond the highest appended index is
    /// `ERR_ACK_TOO_HIGH` (§8.2).
    pub up_to_index: u64,
}

/// `ACK` response (§6.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AckResponse {
    /// The index the next appended message will receive.
    pub next_index: u64,
    /// Messages present and not yet acked.
    pub pending: u64,
}

// ---------------------------------------------------------------------------
// §6.3 — commands signed by the send-side queue key
// ---------------------------------------------------------------------------

/// `BIND_SEND` request (§6.3). The response is empty **by rule**.
///
/// Binding is once-only and irreversible (§7.3): a second `BIND_SEND` on the
/// same address, with any key including the same key, is `ERR_ALREADY_BOUND`.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct BindSendRequest {
    /// The Ed25519 key that will authorize `APPEND`.
    pub send_key: PublicKey,
}

/// `APPEND` request (§6.3).
///
/// **The response body is empty. It carries no index, no queue depth, no
/// timestamp and no queue state of any kind** — an index would tell the sender
/// how many messages the queue has ever held, a depth would tell it whether the
/// recipient has read, and a server timestamp would give it a clock to
/// correlate against. Each converts the send capability into a weak read
/// capability, which is the escalation the two-address split exists to prevent.
///
/// The same rule governs errors: every send-side refusal that would distinguish
/// queue state collapses to [`ErrorCode::Unavailable`].
///
/// [`ErrorCode::Unavailable`]: crate::error::ErrorCode::Unavailable
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AppendRequest {
    /// Length MUST be exactly one of the relay's `padding_sizes` (§9).
    pub payload: Payload,
}

// ---------------------------------------------------------------------------
// §6.4 — push bodies
// ---------------------------------------------------------------------------

/// `MSG` push body (§6.4).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct MsgPush {
    /// The subscribed receive address.
    pub recv_addr: QueueAddress,
    /// The message that arrived.
    pub msg: QueuedMessage,
}

/// `QUEUE_EVENT` push body (§6.4).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct QueueEventPush {
    /// The receive address the event is about.
    pub recv_addr: QueueAddress,
    /// 1 = deleted, 2 = idle-expired, 3 = messages TTL-expired, 4 = quota
    /// reached.
    pub reason: u8,
}

/// `NOTICE` push body (§6.4).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct NoticePush {
    /// 1 = draining (stop sending), 2 = shutdown at `at_ms`, 3 = capability
    /// document changed.
    pub kind: u8,
    /// The moment the notice refers to.
    pub at_ms: u64,
}

// ---------------------------------------------------------------------------
// §12.2 — contact queues
// ---------------------------------------------------------------------------

/// `CREATE_CONTACT_QUEUE` request (§12.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct CreateContactQueueRequest {
    /// The Ed25519 key authorizing the recv side.
    pub recv_key: PublicKey,
    /// Requested message TTL; clamped (§7.7).
    pub req_message_ttl_seconds: u32,
    /// Requested idle TTL; clamped (§7.7).
    pub req_idle_ttl_seconds: u32,
    /// Required in `pow` mode, which is the default (§13.1).
    pub stamp: PowStamp,
}

/// `CREATE_CONTACT_QUEUE` response (§12.2).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct CreateContactQueueResponse {
    /// The ordinary receive address: `READ`, `ACK`, `DELETE_QUEUE`.
    pub recv_addr: QueueAddress,
    /// The published address; never bindable. `BIND_SEND` on it is
    /// `ERR_NOT_PERMITTED`, always, for everyone.
    pub contact_addr: QueueAddress,
    /// Granted message TTL.
    pub message_ttl_seconds: u32,
    /// Granted idle TTL.
    pub idle_ttl_seconds: u32,
    /// Granted pending-message cap (§12.3).
    pub max_pending: u32,
    /// Granted byte cap (§12.3).
    pub max_bytes: u64,
}

/// `CONTACT_APPEND` request (§12.2). Unsigned; the stamp is the gate.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ContactAppendRequest {
    /// The published contact address being written to.
    pub contact_addr: QueueAddress,
    /// Length MUST be in `padding_sizes` (§9).
    pub payload: Payload,
    /// Over a relay-issued challenge scoped to `contact_addr` (§12.3).
    pub stamp: PowStamp,
}

// ---------------------------------------------------------------------------
// §11.1 — the capability document
// ---------------------------------------------------------------------------

/// A relay's entire externally-relevant policy, in one signed structure
/// (`WIRE.md` §11.1).
///
/// The operator and provenance blocks at the end are not decoration.
/// `operator_jurisdiction` and the contact fields make a user's choice among
/// *k* relays an informed one; `source_commit` and `build_digest` are what turn
/// "open source and self-hostable" into something a third party can check.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct Capabilities {
    /// `uint16 protocol_versions<1..255>` — supported versions.
    pub protocol_versions: VecU8<u16>,

    /// The relay's long-term Ed25519 public key.
    pub relay_identity_pk: PublicKey,
    /// `H("free2z/relay/v1/relay-id", relay_identity_pk)`.
    pub relay_id: crate::types::RelayId,

    /// 0 = none (the §2.3 override), 1 = tls.
    pub transport_security: u8,
    /// 0 = none, 1 = tls-exporter.
    pub channel_binding_mode: u8,
    /// Largest accepted frame; default 1 MiB (§4.1).
    pub max_frame_bytes: u32,
    /// In-flight request window; default 32 (§4.3).
    pub max_inflight: u16,
    /// WebSocket Ping interval; operators MUST set any front-end idle timeout
    /// to at least 3x this (§2.4).
    pub ws_ping_interval_seconds: u16,
    /// Handshake deadline (§2.5).
    pub handshake_timeout_ms: u32,

    /// Timestamp window; default 120000 (§5.5).
    pub clock_skew_ms: u32,
    /// Seen-set retention window (§5.5).
    pub antireplay_window_ms: u32,
    /// 0 = volatile, 1 = durable (§5.3, §5.5).
    pub antireplay_persistence: u8,

    /// `uint32 padding_sizes<1..2^16-1>`, ascending (§9).
    pub padding_sizes: VecU16<u32>,
    /// Client-side chunk unit; default 64 KiB (§9).
    pub max_chunk_bytes: u32,

    /// Lower clamp on a requested message TTL.
    pub min_message_ttl_seconds: u32,
    /// Upper clamp. MUST be <= 2592000 ([`crate::MAX_MESSAGE_TTL_SECONDS`]).
    pub max_message_ttl_seconds: u32,
    /// Granted when the client expresses no preference.
    pub default_message_ttl_seconds: u32,
    /// Lower clamp on a requested idle TTL.
    pub min_idle_ttl_seconds: u32,
    /// Upper clamp on a requested idle TTL.
    pub max_idle_ttl_seconds: u32,
    /// Granted when the client expresses no preference.
    pub default_idle_ttl_seconds: u32,
    /// Per-queue message cap (§13.1 layer 2).
    pub max_queue_messages: u32,
    /// Per-queue byte cap (§13.1 layer 2).
    pub max_queue_bytes: u64,

    /// 0 = open, 1 = pow (the default), 2 = token (§13.1).
    pub queue_creation_mode: u8,
    /// PoW parameters for `CREATE_QUEUE` / `CREATE_CONTACT_QUEUE`.
    pub queue_creation_pow: PowParams,
    /// Nonzero when the relay offers contact queues (§12).
    pub contact_queues_enabled: u8,
    /// Contact-queue pending cap; default 64 (§12.3).
    pub contact_max_pending: u32,
    /// Contact-queue byte cap; default 256 KiB (§12.3).
    pub contact_max_bytes: u64,
    /// PoW parameters for `CONTACT_APPEND`.
    pub contact_append_pow: PowParams,
    /// 0 = off, 1 = on (§13.3).
    pub per_source_limits: u8,
    /// 0 = memory, 1 = batched, 2 = fsync-per-append.
    pub durability_mode: u8,

    /// Operator name.
    pub operator_name: ShortBytes,
    /// How to reach a human.
    pub operator_contact: ShortBytes,
    /// Where to report abuse.
    pub operator_abuse_contact: ShortBytes,
    /// Where the operator and the hardware sit.
    pub operator_jurisdiction: ShortBytes,
    /// The operator's published policy.
    pub operator_policy_url: ShortBytes,

    /// Where the running code comes from.
    pub source_repo_url: ShortBytes,
    /// The commit it was built from.
    pub source_commit: ShortBytes,
    /// Reproducible-build digest of the running binary.
    pub build_digest: ShortBytes,

    /// When this document was published.
    pub published_at_ms: u64,
}

/// `Capabilities` plus the relay's signature over its canonical encoding
/// (§11.1).
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignedCapabilities {
    /// The document.
    pub capabilities: Capabilities,
    /// Ed25519 by `relay_identity_pk` over `tls_codec(capabilities)`.
    pub signature: Signature,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::{Canonical, decode_canonical};
    use alloc::vec;

    #[test]
    fn command_codes_are_the_table_in_section_6() {
        let expected = [
            (Command::Hello, 0x0001u16),
            (Command::GetCapabilities, 0x0002),
            (Command::GetChallenge, 0x0003),
            (Command::Ping, 0x0004),
            (Command::CreateQueue, 0x0010),
            (Command::Subscribe, 0x0011),
            (Command::Unsubscribe, 0x0012),
            (Command::Read, 0x0013),
            (Command::Ack, 0x0014),
            (Command::DeleteQueue, 0x0015),
            (Command::BindSend, 0x0020),
            (Command::Append, 0x0021),
            (Command::CreateContactQueue, 0x0030),
            (Command::ContactAppend, 0x0031),
        ];
        assert_eq!(expected.len(), Command::ALL.len());
        for (command, code) in expected {
            assert_eq!(command.code(), code);
            assert_eq!(Command::from_code(code), Some(command));
        }
        assert_eq!(Command::from_code(0x0000), None);
        assert_eq!(Command::from_code(0x0032), None);
    }

    #[test]
    fn auth_and_transcript_address_match_section_6() {
        assert_eq!(Command::Hello.auth(), Auth::None);
        assert_eq!(Command::ContactAppend.auth(), Auth::None);
        assert_eq!(Command::CreateQueue.auth(), Auth::RecvKey);
        assert_eq!(Command::Append.auth(), Auth::SendKey);
        assert_eq!(Command::BindSend.auth(), Auth::SendKey);

        assert_eq!(
            Command::CreateQueue.transcript_address(),
            TranscriptAddress::Zeros
        );
        assert_eq!(
            Command::CreateContactQueue.transcript_address(),
            TranscriptAddress::Zeros
        );
        assert_eq!(
            Command::Read.transcript_address(),
            TranscriptAddress::RecvAddr
        );
        assert_eq!(
            Command::Append.transcript_address(),
            TranscriptAddress::SendAddr
        );
        assert_eq!(Command::Ping.transcript_address(), TranscriptAddress::None);
    }

    #[test]
    fn push_event_codes_are_the_table_in_section_6_4() {
        assert_eq!(PushEvent::Msg.code(), 0x0080);
        assert_eq!(PushEvent::QueueEvent.code(), 0x0081);
        assert_eq!(PushEvent::Notice.code(), 0x0082);
        for event in PushEvent::ALL {
            assert_eq!(PushEvent::from_code(event.code()), Some(event));
        }
        assert_eq!(PushEvent::from_code(0x0083), None);
    }

    #[test]
    fn read_response_round_trips() {
        let message = QueuedMessage {
            index: 42,
            received_at_ms: 1_700_000_000_000,
            payload: Payload::new(vec![7u8; 1024]).unwrap(),
        };
        let response = ReadResponse {
            messages: vec![message.clone(), message].into(),
            has_more: 1,
        };
        let bytes = response.encode_canonical().unwrap();
        assert_eq!(
            decode_canonical::<ReadResponse>(&bytes).unwrap().value(),
            &response
        );
    }

    #[test]
    fn read_response_rejects_non_boolean_has_more_bytes() {
        // An empty `VecU24` is three zero length bytes. Keep these bodies
        // hand-authored so the expected value does not come from the encoder
        // under test.
        for valid in [0x00, 0x01] {
            let body = [0x00, 0x00, 0x00, valid];
            assert_eq!(
                decode_canonical::<ReadResponse>(&body)
                    .unwrap()
                    .value()
                    .has_more,
                valid
            );
        }
        for invalid in [0x02, 0xff] {
            let body = [0x00, 0x00, 0x00, invalid];
            assert_eq!(
                decode_canonical::<ReadResponse>(&body).unwrap_err(),
                CodecError::Decode
            );
        }
    }

    #[test]
    fn create_queue_flags_must_be_zero_in_v1() {
        let mut request = CreateQueueRequest {
            recv_key: PublicKey::zero(),
            req_message_ttl_seconds: 86_400,
            req_idle_ttl_seconds: 86_400,
            flags: 0,
            stamp: PowStamp::empty(),
        };
        assert!(request.validate().is_ok());
        request.flags = 1;
        assert_eq!(request.validate(), Err(CodecError::InvalidValue));
    }

    #[test]
    fn challenge_purpose_rejects_unknown_bytes() {
        assert_eq!(ChallengePurpose::from_code(0), Ok(ChallengePurpose::Clock));
        assert_eq!(
            ChallengePurpose::from_code(3),
            Err(CodecError::InvalidValue)
        );
    }
}
