//! The capability document — `WIRE.md` §11: signing it, verifying it,
//! checking it against itself, and deciding whether to talk to the relay that
//! published it.
//!
//! §11.1 calls this "a relay's entire externally-relevant policy, in one signed
//! structure … the document a client reads to decide whether to use a relay at
//! all, and the document a human reads to decide whether to trust its
//! operator." Both of those readers are served here, and they are separated on
//! purpose:
//!
//! - [`validate`] asks whether the document is a *valid* one — whether it
//!   contradicts itself or claims a policy the architecture forbids. Every
//!   check in it is a MUST that `WIRE.md` states.
//! - [`ClientPolicy::accept`] asks whether *this* client will use *this* relay.
//!   Its checks are the client-side decisions in §11.3's numbered list, after
//!   [`validate`] has rejected documents that no conforming relay may publish.
//!
//! Collapsing the two would mean a client's strictness setting deciding what
//! counts as a conforming relay, which is exactly backwards.
//!
//! # The honest note §11.2 makes, restated
//!
//! The document is served twice: canonically over the protocol, and as JSON at
//! `/.well-known/free2z-relay/v1/capabilities` so that a human, a journalist or
//! a researcher can read a relay's policy without a client. **Nothing forces
//! the two representations to agree except the operator.** What makes
//! divergence costly is that both are signed by the same key and both carry the
//! same digest, so a client that fetches the well-known document and compares
//! digests detects it. That comparison is [`check_digest`]; the fetching is not
//! this crate's business, because this crate has no I/O.

use alloc::vec::Vec;

use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{Capabilities, SignedCapabilities};
use f2z_codec::hash;
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{ALGORITHM_BLAKE2B_LEADING_ZERO_BITS, PowParams};
use f2z_codec::types::{Digest, PublicKey, ShortBytes};

use crate::error::{ProtoError, Refusal, Result};
use crate::key::{SigningKey, VerifyingKey, keys_equal};
use crate::queue::{
    DEFAULT_IDLE_TTL_SECONDS, DEFAULT_MESSAGE_TTL_SECONDS, MAX_IDLE_TTL_SECONDS,
    MAX_MESSAGE_TTL_SECONDS, TtlPolicy,
};

/// `transport_security` (§2.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportSecurity {
    /// `0` — the `--insecure-listen` override. The relay MUST publish this; a
    /// relay that lies here is lying in its signed capability document, which
    /// is the point of publishing it.
    None,
    /// `1` — TLS 1.3, the only conforming transport.
    Tls,
}

/// `channel_binding_mode` (§5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelBindingMode {
    /// `0` — the relay cannot compute a TLS exporter, most often because TLS
    /// is terminated at a load balancer, a CDN or an ingress controller. The
    /// transcript uses 32 zero bytes and §5.5's restart argument stops holding.
    None,
    /// `1` — RFC 8446 §7.5 exporter, computed independently at both ends and
    /// never transmitted.
    TlsExporter,
}

/// `antireplay_persistence` (§5.3, §5.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AntiReplayPersistence {
    /// `0` — the seen-set is lost on restart. Sound when the channel binding is
    /// a TLS exporter, because a restart destroys every session; **not** sound
    /// in `channel_binding_mode: none`, where the binding is a constant.
    Volatile,
    /// `1` — the seen-set survives a restart.
    Durable,
}

/// `queue_creation_mode` (§13.1 layer 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueCreationMode {
    /// `0` — no gate. Appropriate only for a private relay on a closed network.
    Open,
    /// `1` — the default: a `PowStamp` over a relay-issued challenge.
    Pow,
    /// `2` — reserved. The name is retained so a client can identify and report
    /// the formerly specified token mode, but §13.1 forbids a relay from
    /// publishing it and forbids a client override.
    Token,
}

/// `durability_mode` (§8.4, §11.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DurabilityMode {
    /// `0` — an `APPEND` that returned 0 may not survive a crash.
    Memory,
    /// `1` — batched writes; same caveat, smaller window.
    Batched,
    /// `2` — an `APPEND` that returned 0 survives a crash.
    FsyncPerAppend,
}

macro_rules! byte_enum {
    ($name:ident, $($value:expr => $variant:ident),+ $(,)?) => {
        impl $name {
            /// The published byte.
            #[must_use]
            pub const fn code(self) -> u8 {
                match self {
                    $(Self::$variant => $value,)+
                }
            }

            /// Resolve a published byte.
            ///
            /// # Errors
            ///
            /// [`Refusal::CapabilitiesInconsistent`] for a value §11.1 does not
            /// define. A mode byte outside its range is not a forward-compatible
            /// extension: §3.5 is explicit that v1 has no "ignore what you do
            /// not know", and a client that guessed would be guessing about the
            /// relay's security posture.
            pub const fn from_code(code: u8) -> Result<Self> {
                Ok(match code {
                    $($value => Self::$variant,)+
                    _ => return Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent)),
                })
            }
        }
    };
}

byte_enum!(TransportSecurity, 0 => None, 1 => Tls);
byte_enum!(ChannelBindingMode, 0 => None, 1 => TlsExporter);
byte_enum!(AntiReplayPersistence, 0 => Volatile, 1 => Durable);
byte_enum!(QueueCreationMode, 0 => Open, 1 => Pow, 2 => Token);
byte_enum!(DurabilityMode, 0 => Memory, 1 => Batched, 2 => FsyncPerAppend);

/// The exact bytes a relay signs, and the exact bytes a client verifies.
///
/// # Errors
///
/// [`f2z_codec::CodecError`] if the document cannot be encoded — in practice,
/// an operator string longer than its length prefix can describe.
pub fn signing_bytes(capabilities: &Capabilities) -> Result<Vec<u8>> {
    Ok(capabilities.encode_canonical()?)
}

/// `capabilities_digest = H("free2z/relay/v1/caps", tls_codec(Capabilities))`
/// (§6.1).
///
/// # Errors
///
/// As [`signing_bytes`].
pub fn digest(capabilities: &Capabilities) -> Result<Digest> {
    Ok(hash::capabilities_digest(&signing_bytes(capabilities)?))
}

/// Sign a capability document.
///
/// The key MUST be the relay's long-term identity key — the one whose public
/// half is `relay_identity_pk` in the document itself. That is checked here
/// rather than assumed, because a document signed by any other key is one that
/// no client can ever verify and every client will refuse.
///
/// # Errors
///
/// - [`Refusal::CapabilitiesInconsistent`] if `capabilities.relay_identity_pk`
///   is not this key's public half.
/// - As [`signing_bytes`].
pub fn sign(key: &SigningKey, capabilities: Capabilities) -> Result<SignedCapabilities> {
    if !keys_equal(&capabilities.relay_identity_pk, &key.public_key()) {
        return Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent));
    }
    let signature = key.sign(&signing_bytes(&capabilities)?);
    Ok(SignedCapabilities {
        capabilities,
        signature,
    })
}

/// Verify a document's signature under the key it names (§11.3 step 1).
///
/// `proven_identity` is the `relay_identity_pk` the relay proved possession of
/// in `HELLO` (§5.2). Passing it is what makes this a check rather than a
/// tautology: a document is self-signed, so verifying it against its own
/// embedded key proves only that whoever wrote the key also wrote the
/// signature. The binding to a *particular* relay comes from `HELLO`.
///
/// # Errors
///
/// - [`Refusal::CapabilitiesInconsistent`] if the document names a key other
///   than the one proven in `HELLO`.
/// - [`Refusal::CapabilitiesSignatureInvalid`] if the signature does not
///   verify.
/// - [`Refusal::RelayKeyInvalid`] if the key is not a curve point.
pub fn verify(signed: &SignedCapabilities, proven_identity: &PublicKey) -> Result<()> {
    if !keys_equal(&signed.capabilities.relay_identity_pk, proven_identity) {
        return Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent));
    }
    let key = VerifyingKey::from_public_key(proven_identity)
        .map_err(|_| ProtoError::Refused(Refusal::RelayKeyInvalid))?;
    key.verify(&signing_bytes(&signed.capabilities)?, &signed.signature)
        .map_err(|_| ProtoError::Refused(Refusal::CapabilitiesSignatureInvalid))
}

/// Compare a document against the `capabilities_digest` a `HELLO` carried
/// (§6.1, §11.2).
///
/// §6.1's reason for the field: a client can detect a policy change
/// mid-connection without refetching. §11.2's reason: a client that also
/// fetches the well-known JSON document can detect a relay serving one policy
/// to humans and another to clients. Clients SHOULD do the second on first use
/// of a relay and MUST refuse on mismatch.
///
/// # Errors
///
/// [`Refusal::CapabilitiesDigestMismatch`].
pub fn check_digest(capabilities: &Capabilities, expected: &Digest) -> Result<()> {
    if digest(capabilities)? == *expected {
        Ok(())
    } else {
        Err(ProtoError::Refused(Refusal::CapabilitiesDigestMismatch))
    }
}

/// Is this document a valid one at all? (§11.1)
///
/// Every check here is a MUST the specification states, and none of them is a
/// preference. A document that fails one is not a relay this client dislikes;
/// it is a relay contradicting the protocol it claims to speak.
///
/// # Errors
///
/// - [`Refusal::RelayIdNotDerived`] if `relay_id` is not the digest of
///   `relay_identity_pk` (§5.2).
/// - [`Refusal::TtlCeilingExceeded`] if `max_message_ttl_seconds` is above the
///   architecture's 30-day ceiling (§11.3 step 6).
/// - [`Refusal::PowAlgorithmUnknown`] if a `PowParams` names an algorithm v1
///   does not define (§13.1).
/// - [`Refusal::QueueCreationTokenGated`] if `queue_creation_mode` is reserved
///   value 2 (§13.1).
/// - [`Refusal::CapabilitiesInconsistent`] for everything else: an undefined
///   mode byte, an empty version or padding list, a padding set that is not
///   strictly ascending, a TTL band whose default sits outside its own clamps,
///   a frame cap below the relay's own largest padding bucket, a `none`
///   transport that still claims a channel binding, a `pow` creation mode with
///   no parameters, or contact queues offered without the proof of work §12.3
///   requires, or operator/provenance text outside printable ASCII.
pub fn validate(capabilities: &Capabilities) -> Result<()> {
    let inconsistent = ProtoError::Refused(Refusal::CapabilitiesInconsistent);

    // §5.2: the identity binding must actually be the digest of the identity.
    if hash::relay_id(&capabilities.relay_identity_pk) != capabilities.relay_id {
        return Err(ProtoError::Refused(Refusal::RelayIdNotDerived));
    }

    // `uint16 protocol_versions<1..255>` — the lower bound is 1.
    if capabilities.protocol_versions.is_empty() {
        return Err(inconsistent);
    }

    let transport = TransportSecurity::from_code(capabilities.transport_security)?;
    let binding = ChannelBindingMode::from_code(capabilities.channel_binding_mode)?;
    AntiReplayPersistence::from_code(capabilities.antireplay_persistence)?;
    let creation = QueueCreationMode::from_code(capabilities.queue_creation_mode)?;
    // §13.1's 2026-08-24 correction: value 2 is permanently reserved because
    // v1 has no field in which a client could present the token. This is a
    // document-conformance failure, not a preference a client may relax.
    if matches!(creation, QueueCreationMode::Token) {
        return Err(ProtoError::Refused(Refusal::QueueCreationTokenGated));
    }
    DurabilityMode::from_code(capabilities.durability_mode)?;
    let contact_queues = flag(capabilities.contact_queues_enabled)?;
    flag(capabilities.per_source_limits)?;

    // §2.3 obligation 2: no TLS session, so no exporter to derive from.
    if matches!(transport, TransportSecurity::None) && !matches!(binding, ChannelBindingMode::None)
    {
        return Err(inconsistent);
    }

    if capabilities.max_inflight == 0 {
        return Err(inconsistent);
    }

    // §9: `uint32 padding_sizes<1..2^16-1>`, ascending. `PaddingBuckets`
    // refuses anything else, including duplicates and a zero-length bucket.
    let buckets = PaddingBuckets::new(capabilities.padding_sizes.as_slice().to_vec())
        .map_err(|_| inconsistent)?;
    // A relay whose frame cap cannot carry its own largest bucket has published
    // a set no client can use. This is a necessary condition, not a sufficient
    // one — the frame also carries an auth block and a body prefix.
    if u64::from(capabilities.max_frame_bytes) < u64::from(buckets.largest()) {
        return Err(inconsistent);
    }

    if capabilities.max_message_ttl_seconds > MAX_MESSAGE_TTL_SECONDS {
        return Err(ProtoError::Refused(Refusal::TtlCeilingExceeded));
    }
    if !ttl_policy(capabilities).is_consistent() {
        return Err(inconsistent);
    }

    validate_pow(&capabilities.queue_creation_pow)?;
    validate_pow(&capabilities.contact_append_pow)?;
    // §13.1: `pow` mode without parameters is a gate with nothing behind it.
    if matches!(creation, QueueCreationMode::Pow) && !capabilities.queue_creation_pow.is_required()
    {
        return Err(inconsistent);
    }
    // §12.3: a relay MUST enforce all four contact-queue caps, and proof of
    // work is one of them. Offering contact queues without it is offering an
    // unsigned, unmetered write endpoint to the whole internet.
    if contact_queues && !capabilities.contact_append_pow.is_required() {
        return Err(inconsistent);
    }

    // §11.1: these are the eight human-facing strings a client surfaces. They
    // are inert text, not markup, and arbitrary control/non-ASCII bytes are not
    // a conforming capability document. Keep this scoped here: `ShortBytes`
    // also carries challenge scopes, whose 32 address bytes are intentionally
    // arbitrary.
    let human_text = [
        &capabilities.operator_name,
        &capabilities.operator_contact,
        &capabilities.operator_abuse_contact,
        &capabilities.operator_jurisdiction,
        &capabilities.operator_policy_url,
        &capabilities.source_repo_url,
        &capabilities.source_commit,
        &capabilities.build_digest,
    ];
    if human_text.iter().any(|text| {
        !text
            .as_slice()
            .iter()
            .all(|byte| (0x20..=0x7e).contains(byte))
    }) {
        return Err(inconsistent);
    }

    Ok(())
}

/// A relay's §7.7 clamps, lifted out of its capability document.
#[must_use]
pub fn ttl_policy(capabilities: &Capabilities) -> TtlPolicy {
    TtlPolicy {
        min_message_ttl_seconds: capabilities.min_message_ttl_seconds,
        max_message_ttl_seconds: capabilities.max_message_ttl_seconds,
        default_message_ttl_seconds: capabilities.default_message_ttl_seconds,
        min_idle_ttl_seconds: capabilities.min_idle_ttl_seconds,
        max_idle_ttl_seconds: capabilities.max_idle_ttl_seconds,
        default_idle_ttl_seconds: capabilities.default_idle_ttl_seconds,
    }
}

fn validate_pow(params: &PowParams) -> Result<()> {
    params
        .validate()
        .map_err(|_| ProtoError::Refused(Refusal::PowAlgorithmUnknown))
}

fn flag(byte: u8) -> Result<bool> {
    match byte {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent)),
    }
}

/// What *this* client requires of a relay (§11.3).
///
/// Defaults are the conservative reading of §11.3: refuse a plaintext relay
/// and refuse an implausible padding set. Reserved capability values are
/// rejected unconditionally by [`validate`]. The two that §5.3 and §5.5
/// describe as a *strict mode* — requiring a channel binding and requiring a
/// durable seen-set — default to off, because a relay behind a TLS-terminating
/// proxy is "a common and legitimate deployment" and refusing every one of
/// them by default would be a stricter policy than the specification's.
#[derive(Clone, Debug)]
pub struct ClientPolicy {
    /// §2.3: connect to a relay serving without TLS. MUST be an explicit,
    /// per-relay user opt-in, and the UI must state that message ciphertext is
    /// protected by MLS but that connection metadata, queue addresses and
    /// commands travel in the clear.
    pub allow_insecure_transport: bool,
    /// §5.3's strict mode: refuse `channel_binding_mode: none`.
    pub require_channel_binding: bool,
    /// §5.5: refuse `antireplay_persistence: volatile`.
    pub require_durable_antireplay: bool,
    /// Refuse a relay whose seen-set retention is shorter than twice its own
    /// clock skew. See [`Refusal::AntiReplayWindowTooShort`] and `WIRE.md` §5.5.
    pub require_sound_antireplay_window: bool,
    /// §9: refuse an implausibly fine-grained padding set.
    pub require_plausible_padding: bool,
    /// §11.3 step 5: the sizes this client will emit. The relay's set MUST be a
    /// superset.
    pub emitted_padding: PaddingBuckets,
}

impl Default for ClientPolicy {
    fn default() -> Self {
        Self {
            allow_insecure_transport: false,
            require_channel_binding: false,
            require_durable_antireplay: false,
            require_sound_antireplay_window: true,
            require_plausible_padding: true,
            emitted_padding: PaddingBuckets::default(),
        }
    }
}

impl ClientPolicy {
    /// §11.3's checklist, in order, over a document that has already been
    /// signature-verified.
    ///
    /// # Errors
    ///
    /// [`validate`]'s errors, then the [`Refusal`] naming the policy the relay
    /// failed.
    pub fn accept(&self, capabilities: &Capabilities) -> Result<()> {
        validate(capabilities)?;

        // Step 2.
        if matches!(
            TransportSecurity::from_code(capabilities.transport_security)?,
            TransportSecurity::None
        ) && !self.allow_insecure_transport
        {
            return Err(ProtoError::Refused(Refusal::InsecureTransport));
        }
        // Step 3.
        if matches!(
            ChannelBindingMode::from_code(capabilities.channel_binding_mode)?,
            ChannelBindingMode::None
        ) && self.require_channel_binding
        {
            return Err(ProtoError::Refused(Refusal::NoChannelBinding));
        }
        if matches!(
            AntiReplayPersistence::from_code(capabilities.antireplay_persistence)?,
            AntiReplayPersistence::Volatile
        ) && self.require_durable_antireplay
        {
            return Err(ProtoError::Refused(Refusal::VolatileAntiReplay));
        }
        // Step 4.
        if self.require_sound_antireplay_window
            && u64::from(capabilities.antireplay_window_ms)
                < u64::from(capabilities.clock_skew_ms).saturating_mul(2)
        {
            return Err(ProtoError::Refused(Refusal::AntiReplayWindowTooShort));
        }
        // Step 5.
        let buckets = PaddingBuckets::new(capabilities.padding_sizes.as_slice().to_vec())
            .map_err(|_| ProtoError::Refused(Refusal::CapabilitiesInconsistent))?;
        if !buckets.is_superset_of(&self.emitted_padding) {
            return Err(ProtoError::Refused(Refusal::PaddingNotSuperset));
        }
        if self.require_plausible_padding && !buckets.is_plausible() {
            return Err(ProtoError::Refused(Refusal::PaddingImplausible));
        }
        Ok(())
    }
}

/// A capability document carrying every default `WIRE.md` publishes, for a
/// relay that has not been configured yet.
///
/// The operator and provenance blocks are **empty**, and that is not something
/// to ship: §11.1 is explicit that `operator_jurisdiction`, the contact fields,
/// `source_commit` and `build_digest` are the point of the document — they are
/// what turns "open source and self-hostable" into something a third party can
/// check, and what makes a user's choice among *k* relays an informed one. A
/// relay that publishes this unedited is publishing a document that answers
/// none of the questions it exists to answer.
///
/// # Errors
///
/// [`f2z_codec::CodecError`] cannot actually arise here; the signature is
/// fallible only because the empty operator strings are constructed through the
/// same length-checked constructor as any other.
pub fn defaults(relay_identity_pk: &PublicKey, published_at_ms: u64) -> Result<Capabilities> {
    let empty = ShortBytes::new(&b""[..])?;
    Ok(Capabilities {
        protocol_versions: alloc::vec![f2z_codec::PROTOCOL_VERSION].into(),

        relay_identity_pk: *relay_identity_pk,
        relay_id: hash::relay_id(relay_identity_pk),

        transport_security: TransportSecurity::Tls.code(),
        channel_binding_mode: ChannelBindingMode::TlsExporter.code(),
        // §4.1 default.
        max_frame_bytes: 1024 * 1024,
        // §4.3 default.
        max_inflight: crate::inflight::DEFAULT_MAX_INFLIGHT,
        // §2.4: operators MUST set any front-end idle timeout to at least 3x.
        ws_ping_interval_seconds: 25,
        // §2.5 default.
        handshake_timeout_ms: 10_000,

        // §5.5 default: ±2 minutes.
        clock_skew_ms: 120_000,
        // Twice the skew. Equality is sound because §5.5 requires seen-set
        // entries to remain live through their expiration instant.
        antireplay_window_ms: 240_000,
        antireplay_persistence: AntiReplayPersistence::Volatile.code(),

        padding_sizes: PaddingBuckets::default().sizes().to_vec().into(),
        // §9 default.
        max_chunk_bytes: f2z_codec::padding::DEFAULT_MAX_CHUNK_BYTES,

        min_message_ttl_seconds: 60,
        max_message_ttl_seconds: MAX_MESSAGE_TTL_SECONDS,
        default_message_ttl_seconds: DEFAULT_MESSAGE_TTL_SECONDS,
        min_idle_ttl_seconds: 3_600,
        max_idle_ttl_seconds: MAX_IDLE_TTL_SECONDS,
        default_idle_ttl_seconds: DEFAULT_IDLE_TTL_SECONDS,
        max_queue_messages: 4_096,
        max_queue_bytes: 64 * 1024 * 1024,

        // §13.1: `pow` is the default.
        queue_creation_mode: QueueCreationMode::Pow.code(),
        queue_creation_pow: PowParams {
            algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
            difficulty_bits: 20,
            challenge_ttl_ms: 60_000,
        },
        contact_queues_enabled: 1,
        contact_max_pending: 64,
        contact_max_bytes: 256 * 1024,
        contact_append_pow: PowParams {
            algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
            difficulty_bits: 20,
            challenge_ttl_ms: 60_000,
        },
        per_source_limits: 1,
        durability_mode: DurabilityMode::FsyncPerAppend.code(),

        operator_name: empty.clone(),
        operator_contact: empty.clone(),
        operator_abuse_contact: empty.clone(),
        operator_jurisdiction: empty.clone(),
        operator_policy_url: empty.clone(),

        source_repo_url: empty.clone(),
        source_commit: empty.clone(),
        build_digest: empty,

        published_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn identity() -> SigningKey {
        SigningKey::from_seed(&[0x21; 32])
    }

    fn document() -> Capabilities {
        defaults(&identity().public_key(), 1_800_000_000_000).unwrap()
    }

    #[derive(Clone, Copy, Debug)]
    enum HumanTextField {
        OperatorName,
        OperatorContact,
        OperatorAbuseContact,
        OperatorJurisdiction,
        OperatorPolicyUrl,
        SourceRepoUrl,
        SourceCommit,
        BuildDigest,
    }

    const HUMAN_TEXT_FIELDS: [HumanTextField; 8] = [
        HumanTextField::OperatorName,
        HumanTextField::OperatorContact,
        HumanTextField::OperatorAbuseContact,
        HumanTextField::OperatorJurisdiction,
        HumanTextField::OperatorPolicyUrl,
        HumanTextField::SourceRepoUrl,
        HumanTextField::SourceCommit,
        HumanTextField::BuildDigest,
    ];

    fn set_human_text(capabilities: &mut Capabilities, field: HumanTextField, bytes: &[u8]) {
        let value = ShortBytes::new(bytes.to_vec()).unwrap();
        match field {
            HumanTextField::OperatorName => capabilities.operator_name = value,
            HumanTextField::OperatorContact => capabilities.operator_contact = value,
            HumanTextField::OperatorAbuseContact => capabilities.operator_abuse_contact = value,
            HumanTextField::OperatorJurisdiction => capabilities.operator_jurisdiction = value,
            HumanTextField::OperatorPolicyUrl => capabilities.operator_policy_url = value,
            HumanTextField::SourceRepoUrl => capabilities.source_repo_url = value,
            HumanTextField::SourceCommit => capabilities.source_commit = value,
            HumanTextField::BuildDigest => capabilities.build_digest = value,
        }
    }

    #[test]
    fn all_operator_and_provenance_fields_are_printable_ascii() {
        for field in HUMAN_TEXT_FIELDS {
            for accepted in [b"".as_slice(), b" ", b"~", b"\"", b"\\"] {
                let mut capabilities = document();
                set_human_text(&mut capabilities, field, accepted);
                assert_eq!(validate(&capabilities), Ok(()), "{field:?}: {accepted:?}");
            }
            for rejected in [b"\x1f".as_slice(), b"\x7f", b"\x80"] {
                let mut capabilities = document();
                set_human_text(&mut capabilities, field, rejected);
                assert_eq!(
                    validate(&capabilities),
                    Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent)),
                    "{field:?}: {rejected:?}"
                );
            }
        }
    }

    #[test]
    fn a_valid_signature_does_not_make_invalid_operator_text_acceptable() {
        let key = identity();
        let mut capabilities = document();
        capabilities.operator_name = ShortBytes::new(b"line\x1fbreak".to_vec()).unwrap();
        let signed = sign(&key, capabilities).unwrap();

        assert_eq!(verify(&signed, &key.public_key()), Ok(()));
        assert_eq!(
            ClientPolicy::default().accept(&signed.capabilities),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );
    }

    #[test]
    fn the_published_defaults_are_a_valid_document() {
        let capabilities = document();
        assert!(validate(&capabilities).is_ok());
        assert!(ClientPolicy::default().accept(&capabilities).is_ok());
    }

    #[test]
    fn a_document_verifies_only_against_the_key_hello_proved() {
        let key = identity();
        let signed = sign(&key, document()).unwrap();
        assert!(verify(&signed, &key.public_key()).is_ok());

        let impostor = SigningKey::from_seed(&[0x22; 32]);
        assert_eq!(
            verify(&signed, &impostor.public_key()),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );

        // A document whose bytes changed after signing.
        let mut tampered = signed.clone();
        tampered.capabilities.max_queue_messages += 1;
        assert_eq!(
            verify(&tampered, &key.public_key()),
            Err(ProtoError::Refused(Refusal::CapabilitiesSignatureInvalid))
        );
    }

    #[test]
    fn signing_with_the_wrong_key_is_refused_at_the_source() {
        let impostor = SigningKey::from_seed(&[0x23; 32]);
        assert_eq!(
            sign(&impostor, document()).map(|_| ()),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );
    }

    #[test]
    fn the_digest_detects_a_document_that_changed_under_us() {
        let capabilities = document();
        let expected = digest(&capabilities).unwrap();
        assert!(check_digest(&capabilities, &expected).is_ok());

        let mut changed = capabilities;
        changed.min_idle_ttl_seconds += 1;
        assert_eq!(
            check_digest(&changed, &expected),
            Err(ProtoError::Refused(Refusal::CapabilitiesDigestMismatch))
        );
    }

    #[test]
    fn a_relay_id_that_is_not_the_digest_of_the_key_is_refused() {
        let mut capabilities = document();
        capabilities.relay_id = f2z_codec::types::RelayId::new([0u8; 32]);
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::RelayIdNotDerived))
        );
    }

    #[test]
    fn a_ttl_above_the_architectures_ceiling_is_refused() {
        let mut capabilities = document();
        capabilities.max_message_ttl_seconds = MAX_MESSAGE_TTL_SECONDS + 1;
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::TtlCeilingExceeded))
        );
    }

    #[test]
    fn a_plaintext_relay_must_also_declare_no_channel_binding() {
        let mut capabilities = document();
        capabilities.transport_security = TransportSecurity::None.code();
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent)),
            "§2.3: there is no TLS session to export from"
        );

        capabilities.channel_binding_mode = ChannelBindingMode::None.code();
        assert!(validate(&capabilities).is_ok());
        assert_eq!(
            ClientPolicy::default().accept(&capabilities),
            Err(ProtoError::Refused(Refusal::InsecureTransport))
        );
        let opted_in = ClientPolicy {
            allow_insecure_transport: true,
            ..ClientPolicy::default()
        };
        assert!(opted_in.accept(&capabilities).is_ok());
        let strict = ClientPolicy {
            allow_insecure_transport: true,
            require_channel_binding: true,
            ..ClientPolicy::default()
        };
        assert_eq!(
            strict.accept(&capabilities),
            Err(ProtoError::Refused(Refusal::NoChannelBinding))
        );
    }

    #[test]
    fn undefined_mode_bytes_are_refused_rather_than_guessed() {
        for mutate in [
            (|c: &mut Capabilities| c.transport_security = 2) as fn(&mut Capabilities),
            |c| c.channel_binding_mode = 2,
            |c| c.antireplay_persistence = 2,
            |c| c.queue_creation_mode = 3,
            |c| c.durability_mode = 3,
            |c| c.per_source_limits = 2,
            |c| c.contact_queues_enabled = 2,
        ] {
            let mut capabilities = document();
            mutate(&mut capabilities);
            assert_eq!(
                validate(&capabilities),
                Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
            );
        }
    }

    #[test]
    fn a_padding_set_that_is_not_ascending_is_refused() {
        let mut capabilities = document();
        capabilities.padding_sizes = vec![4096u32, 1024].into();
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );
    }

    #[test]
    fn a_frame_cap_below_the_relays_own_largest_bucket_is_refused() {
        // A relay advertising a bucket its frame cap cannot carry has
        // published a size no client can ever send it: the padding is the
        // §9 privacy mechanism, so a client that trims to fit is a client
        // whose message length is informative again.
        //
        // The boundary is asserted from `largest()` rather than from a
        // literal, so the test cannot drift away from the default bucket set
        // it is describing.
        let largest = PaddingBuckets::new(document().padding_sizes.as_slice().to_vec())
            .unwrap()
            .largest();

        let mut capabilities = document();
        capabilities.max_frame_bytes = largest - 1;
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );

        // Equality is the accepted edge: the check is `<`, and a frame that
        // is exactly one bucket long is the necessary condition. It is not a
        // sufficient one — the frame also carries an auth block and a body
        // length prefix — which is why this is the boundary the document
        // states and not the one a relay should actually publish.
        capabilities.max_frame_bytes = largest;
        assert!(validate(&capabilities).is_ok());
    }

    #[test]
    fn a_client_refuses_a_relay_that_cannot_carry_its_own_sizes() {
        let capabilities = document();
        let finer = ClientPolicy {
            emitted_padding: PaddingBuckets::new(vec![1024, 2048]).unwrap(),
            ..ClientPolicy::default()
        };
        assert_eq!(
            finer.accept(&capabilities),
            Err(ProtoError::Refused(Refusal::PaddingNotSuperset))
        );
    }

    #[test]
    fn an_implausibly_fine_grained_relay_set_is_refused() {
        let mut capabilities = document();
        capabilities.padding_sizes = vec![1024u32, 1280, 4096, 16_384, 65_536].into();
        assert!(validate(&capabilities).is_ok(), "ascending, so it is valid");
        assert_eq!(
            ClientPolicy::default().accept(&capabilities),
            Err(ProtoError::Refused(Refusal::PaddingImplausible)),
            "…but a client SHOULD still refuse it"
        );
    }

    #[test]
    fn reserved_token_mode_is_unconditionally_refused() {
        let mut capabilities = document();
        capabilities.queue_creation_mode = QueueCreationMode::Token.code();
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::QueueCreationTokenGated))
        );
        let otherwise_lenient = ClientPolicy {
            allow_insecure_transport: true,
            require_channel_binding: false,
            require_durable_antireplay: false,
            require_sound_antireplay_window: false,
            require_plausible_padding: false,
            ..ClientPolicy::default()
        };
        assert_eq!(
            otherwise_lenient.accept(&capabilities),
            Err(ProtoError::Refused(Refusal::QueueCreationTokenGated)),
            "a reserved wire value is not a user-overridable policy choice"
        );
    }

    #[test]
    fn pow_mode_without_parameters_is_a_gate_with_nothing_behind_it() {
        let mut capabilities = document();
        capabilities.queue_creation_pow = PowParams::none();
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );
    }

    #[test]
    fn contact_queues_without_proof_of_work_are_refused() {
        let mut capabilities = document();
        capabilities.contact_append_pow = PowParams::none();
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::CapabilitiesInconsistent))
        );
        // Turning contact queues off makes the same document valid again.
        capabilities.contact_queues_enabled = 0;
        assert!(validate(&capabilities).is_ok());
    }

    #[test]
    fn an_unknown_pow_algorithm_is_refused() {
        let mut capabilities = document();
        capabilities.contact_append_pow.algorithm = 9;
        assert_eq!(
            validate(&capabilities),
            Err(ProtoError::Refused(Refusal::PowAlgorithmUnknown))
        );
    }

    #[test]
    fn a_seen_set_window_shorter_than_twice_the_skew_is_refused_by_default() {
        let mut capabilities = document();
        capabilities.antireplay_window_ms = capabilities.clock_skew_ms;
        assert!(
            validate(&capabilities).is_ok(),
            "policy refusal must preserve the signed document as a valid artifact"
        );
        assert_eq!(
            ClientPolicy::default().accept(&capabilities),
            Err(ProtoError::Refused(Refusal::AntiReplayWindowTooShort))
        );
        let lenient = ClientPolicy {
            require_sound_antireplay_window: false,
            ..ClientPolicy::default()
        };
        assert!(lenient.accept(&capabilities).is_ok());
    }
}
