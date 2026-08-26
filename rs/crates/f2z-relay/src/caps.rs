//! The capability document (§11.1): what this relay publishes about itself.
//!
//! # The document is the configuration, not a description of it
//!
//! §11.3 has a client *decide whether to talk to a relay at all* from this
//! structure, so every field here is read out of [`crate::config::Config`] and
//! the same values are what the engine enforces. There is no second copy of a
//! policy number anywhere in this crate: `max_queue_messages` is published from
//! `limits.max_queue_messages` and admitted against `limits.max_queue_messages`.
//! A relay whose document and conduct disagree is the one thing a client cannot
//! defend against, and the cheapest way to guarantee they agree is to have one
//! value.
//!
//! # `.well-known` is deliberately not served here
//!
//! §11.2 asks for a second representation — the same document, as JSON, over
//! plain HTTPS at `/.well-known/free2z-relay/v1/capabilities` — so that a human,
//! a journalist or a researcher can read a relay's policy without a client. The
//! affordance is worth having and this relay does **not** serve it. The reason
//! is §2.2's, applied honestly:
//!
//! > *a second transport is a second parser and a second fuzz target … The relay
//! > is an unauthenticated network listener that anyone on the internet may
//! > speak to before any signature is checked. Its attack surface is its
//! > parser.*
//!
//! Serving that URL from this process means an HTTP request parser on the
//! public port. The WebSocket upgrade's own HTTP parse does not help: it runs
//! only for requests that already carry `Upgrade: websocket` and
//! `Sec-WebSocket-Key`, so a plain `GET` is rejected before any route callback
//! sees it. Reaching it needs a request-line reader of our own, on the
//! unauthenticated path, for an affordance aimed at humans rather than at
//! clients.
//!
//! What is kept instead is the *property* §11.2 exists for. [`to_json`] renders
//! exactly the document this relay serves over the protocol, signature and
//! digest included, and `f2z-relay --print-capabilities` writes it to stdout. An
//! operator publishes that file from whatever already serves their website, and
//! §11.2's substance survives intact: the same values, the same signature, the
//! same `capabilities_digest`, at a URL anyone can poll and diff, so a quiet
//! policy change stays an observable one. What does not survive is the
//! convenience of the relay hosting it, and that is the trade being made.
//!
//! A JSON **encoder** is not a JSON parser: it turns our own values into text
//! and never consumes attacker input. That asymmetry is the whole argument, and
//! it is why the encoder is here while a parser is not.

use f2z_codec::commands::{Capabilities, SignedCapabilities};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{ALGORITHM_BLAKE2B_LEADING_ZERO_BITS, PowParams};
use f2z_codec::types::{Digest, PublicKey, ShortBytes};
use f2z_relay_proto::capabilities::{
    self, AntiReplayPersistence, ChannelBindingMode, DurabilityMode, QueueCreationMode,
    TransportSecurity,
};
use f2z_relay_proto::key::SigningKey;
use f2z_relay_store::Durability;

use crate::config::{Config, CreationMode};

/// Why a document could not be built or signed.
#[derive(Debug)]
pub enum CapabilitiesError {
    /// A configured value cannot be represented in the document.
    Field(&'static str),
    /// The assembled document does not satisfy §11.1's own consistency rules.
    Invalid(f2z_relay_proto::ProtoError),
    /// The document could not be encoded for signing.
    Encode,
}

impl std::fmt::Display for CapabilitiesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Field(key) => write!(f, "{key} cannot be published as configured"),
            Self::Invalid(error) => write!(f, "the capability document is not valid: {error}"),
            Self::Encode => f.write_str("the capability document could not be encoded"),
        }
    }
}

impl std::error::Error for CapabilitiesError {}

/// The published policy, plus the signature and digest a client checks.
#[derive(Clone)]
pub struct Published {
    /// The signed document `GET_CAPABILITIES` returns.
    pub signed: SignedCapabilities,
    /// `H("free2z/relay/v1/caps", tls_codec(Capabilities))`, which `HELLO`
    /// carries so a client can detect a policy change without refetching.
    pub digest: Digest,
    /// The canonical bytes, encoded once.
    pub encoded: Vec<u8>,
}

// `encoded` is the canonical document, and a derived `Debug` would render a
// kilobyte of it as a decimal byte list. The bytes are public — that is the
// point of the document — but a log line is still not where they belong, and
// the rule this workspace enforces is that no type derives `Debug` over raw
// bytes, without an exception for the ones that happen to be harmless.
impl core::fmt::Debug for Published {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Published")
            .field("digest", &self.digest)
            .field("encoded", &format_args!("<{} bytes>", self.encoded.len()))
            .finish_non_exhaustive()
    }
}

impl Published {
    /// The document itself.
    #[must_use]
    pub const fn capabilities(&self) -> &Capabilities {
        &self.signed.capabilities
    }
}

/// Build the document this configuration describes.
///
/// # Errors
///
/// [`CapabilitiesError`] if a field does not fit, or if the assembled document
/// fails §11.1's consistency rules — which is a configuration bug caught at
/// startup rather than a document served to a client that will refuse it.
pub fn build(
    config: &Config,
    identity: &PublicKey,
    durability: Durability,
    published_at_ms: u64,
) -> Result<Capabilities, CapabilitiesError> {
    let mode = config
        .creation_mode()
        .map_err(|_| CapabilitiesError::Field("antiabuse.queue_creation_mode"))?;

    // §2.3 obligations 1 and 2 travel together: no TLS session means no
    // exporter to derive a binding from, and a document that claimed otherwise
    // would be lying in a signed structure.
    let (transport, binding) = if config.tls_enabled() {
        (TransportSecurity::Tls, ChannelBindingMode::TlsExporter)
    } else {
        (TransportSecurity::None, ChannelBindingMode::None)
    };

    let padding = PaddingBuckets::new(config.padding.sizes.clone())
        .map_err(|_| CapabilitiesError::Field("padding.sizes"))?;

    let creation_pow = match mode {
        CreationMode::Open | CreationMode::Token => PowParams::none(),
        CreationMode::Pow => PowParams {
            algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
            difficulty_bits: config.antiabuse.queue_creation_pow_bits,
            challenge_ttl_ms: config.antiabuse.challenge_ttl_ms,
        },
    };
    let contact_pow = if config.antiabuse.contact_queues_enabled {
        PowParams {
            algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
            difficulty_bits: config.antiabuse.contact_append_pow_bits,
            challenge_ttl_ms: config.antiabuse.challenge_ttl_ms,
        }
    } else {
        PowParams::none()
    };

    let claim_pow = if config.antiabuse.key_packages_enabled {
        PowParams {
            algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
            difficulty_bits: config.antiabuse.claim_key_package_pow_bits,
            challenge_ttl_ms: config.antiabuse.challenge_ttl_ms,
        }
    } else {
        PowParams::none()
    };

    let capabilities = Capabilities {
        protocol_versions: alloc_versions(),

        relay_identity_pk: *identity,
        relay_id: f2z_codec::hash::relay_id(identity),

        transport_security: transport.code(),
        channel_binding_mode: binding.code(),
        max_frame_bytes: config.limits.max_frame_bytes,
        max_inflight: config.limits.max_inflight,
        ws_ping_interval_seconds: config.listen.ping_interval_seconds,
        handshake_timeout_ms: config.listen.handshake_timeout_ms,

        clock_skew_ms: config.limits.clock_skew_ms,
        antireplay_window_ms: config.limits.antireplay_window_ms,
        // §5.5: the seen-set lives in memory, because a restart destroys every
        // TLS session and the channel binding has already invalidated the whole
        // pre-restart corpus. §5.3's exception is why this is *published*: in
        // `channel_binding_mode: none` the argument does not hold, and a client
        // reads this field and may refuse.
        antireplay_persistence: AntiReplayPersistence::Volatile.code(),

        padding_sizes: padding.sizes().to_vec().into(),
        max_chunk_bytes: config.padding.max_chunk_bytes,

        min_message_ttl_seconds: config.queues.min_message_ttl_seconds,
        max_message_ttl_seconds: config.queues.max_message_ttl_seconds,
        default_message_ttl_seconds: config.queues.default_message_ttl_seconds,
        min_idle_ttl_seconds: config.queues.min_idle_ttl_seconds,
        max_idle_ttl_seconds: config.queues.max_idle_ttl_seconds,
        default_idle_ttl_seconds: config.queues.default_idle_ttl_seconds,
        max_queue_messages: config.limits.max_queue_messages,
        max_queue_bytes: config.limits.max_queue_bytes,

        queue_creation_mode: match mode {
            CreationMode::Open => QueueCreationMode::Open.code(),
            CreationMode::Pow => QueueCreationMode::Pow.code(),
            CreationMode::Token => QueueCreationMode::Token.code(),
        },
        queue_creation_pow: creation_pow,
        contact_queues_enabled: u8::from(config.antiabuse.contact_queues_enabled),
        contact_max_pending: config.antiabuse.contact_max_pending,
        contact_max_bytes: config.antiabuse.contact_max_bytes,
        contact_append_pow: contact_pow,
        key_packages_enabled: u8::from(config.antiabuse.key_packages_enabled),
        contact_max_key_packages: config.antiabuse.contact_max_key_packages,
        claim_key_package_pow: claim_pow,
        per_source_limits: u8::from(config.antiabuse.per_source_limits),
        durability_mode: match durability {
            Durability::Memory => DurabilityMode::Memory.code(),
            Durability::Batched => DurabilityMode::Batched.code(),
            // Group commit is **not** `batched`: it amortizes one fsync across
            // many responses that all wait for it. Deferring the fsync past the
            // response is what would make this weaker.
            Durability::FsyncPerAppend => DurabilityMode::FsyncPerAppend.code(),
        },

        operator_name: short("operator.name", &config.operator.name)?,
        operator_contact: short("operator.contact", &config.operator.contact)?,
        operator_abuse_contact: short("operator.abuse_contact", &config.operator.abuse_contact)?,
        operator_jurisdiction: short("operator.jurisdiction", &config.operator.jurisdiction)?,
        operator_policy_url: short("operator.policy_url", &config.operator.policy_url)?,

        source_repo_url: short(
            "provenance.source_repo_url",
            &config.provenance.source_repo_url,
        )?,
        source_commit: short("provenance.source_commit", &config.provenance.source_commit)?,
        build_digest: short("provenance.build_digest", &config.provenance.build_digest)?,

        published_at_ms,
    };

    capabilities::validate(&capabilities).map_err(CapabilitiesError::Invalid)?;
    Ok(capabilities)
}

/// Sign a document and precompute what `HELLO` and `GET_CAPABILITIES` need.
///
/// # Errors
///
/// [`CapabilitiesError::Encode`] if the document cannot be encoded.
pub fn publish(
    identity: &SigningKey,
    capabilities: Capabilities,
) -> Result<Published, CapabilitiesError> {
    let encoded =
        capabilities::signing_bytes(&capabilities).map_err(|_| CapabilitiesError::Encode)?;
    let digest = capabilities::digest(&capabilities).map_err(|_| CapabilitiesError::Encode)?;
    let signed =
        capabilities::sign(identity, capabilities).map_err(|_| CapabilitiesError::Encode)?;
    Ok(Published {
        signed,
        digest,
        encoded,
    })
}

fn alloc_versions() -> f2z_codec::vec::VecU8<u16> {
    vec![f2z_codec::PROTOCOL_VERSION].into()
}

fn short(key: &'static str, text: &str) -> Result<ShortBytes, CapabilitiesError> {
    ShortBytes::new(text.as_bytes().to_vec()).map_err(|_| CapabilitiesError::Field(key))
}

// ---------------------------------------------------------------------------
// §11.2's representation, for an operator to publish.
// ---------------------------------------------------------------------------

/// The document as the JSON of §11.2 — the same values, the same signature
/// (base64url, unpadded), the same digest.
///
/// This is an **encoder**. It writes our own values and consumes nothing from
/// the network, which is the entire reason it is acceptable here while an HTTP
/// parser on the public port is not (see the module documentation).
#[must_use]
pub fn to_json(published: &Published) -> String {
    use std::fmt::Write as _;
    let capabilities = published.capabilities();
    let mut out = String::with_capacity(2048);
    out.push_str("{\n");
    let _ = writeln!(
        out,
        "  \"protocol_versions\": {:?},",
        versions(capabilities)
    );
    let _ = writeln!(
        out,
        "  \"relay_identity_pk\": \"{}\",",
        base64url(capabilities.relay_identity_pk.as_bytes())
    );
    let _ = writeln!(
        out,
        "  \"relay_id\": \"{}\",",
        base64url(capabilities.relay_id.as_bytes())
    );
    let _ = writeln!(
        out,
        "  \"transport_security\": {},",
        capabilities.transport_security
    );
    let _ = writeln!(
        out,
        "  \"channel_binding_mode\": {},",
        capabilities.channel_binding_mode
    );
    let _ = writeln!(
        out,
        "  \"max_frame_bytes\": {},",
        capabilities.max_frame_bytes
    );
    let _ = writeln!(out, "  \"max_inflight\": {},", capabilities.max_inflight);
    let _ = writeln!(
        out,
        "  \"ws_ping_interval_seconds\": {},",
        capabilities.ws_ping_interval_seconds
    );
    let _ = writeln!(
        out,
        "  \"handshake_timeout_ms\": {},",
        capabilities.handshake_timeout_ms
    );
    let _ = writeln!(out, "  \"clock_skew_ms\": {},", capabilities.clock_skew_ms);
    let _ = writeln!(
        out,
        "  \"antireplay_window_ms\": {},",
        capabilities.antireplay_window_ms
    );
    let _ = writeln!(
        out,
        "  \"antireplay_persistence\": {},",
        capabilities.antireplay_persistence
    );
    let _ = writeln!(
        out,
        "  \"padding_sizes\": {:?},",
        capabilities.padding_sizes.as_slice()
    );
    let _ = writeln!(
        out,
        "  \"max_chunk_bytes\": {},",
        capabilities.max_chunk_bytes
    );
    let _ = writeln!(
        out,
        "  \"min_message_ttl_seconds\": {},",
        capabilities.min_message_ttl_seconds
    );
    let _ = writeln!(
        out,
        "  \"max_message_ttl_seconds\": {},",
        capabilities.max_message_ttl_seconds
    );
    let _ = writeln!(
        out,
        "  \"default_message_ttl_seconds\": {},",
        capabilities.default_message_ttl_seconds
    );
    let _ = writeln!(
        out,
        "  \"min_idle_ttl_seconds\": {},",
        capabilities.min_idle_ttl_seconds
    );
    let _ = writeln!(
        out,
        "  \"max_idle_ttl_seconds\": {},",
        capabilities.max_idle_ttl_seconds
    );
    let _ = writeln!(
        out,
        "  \"default_idle_ttl_seconds\": {},",
        capabilities.default_idle_ttl_seconds
    );
    let _ = writeln!(
        out,
        "  \"max_queue_messages\": {},",
        capabilities.max_queue_messages
    );
    let _ = writeln!(
        out,
        "  \"max_queue_bytes\": {},",
        capabilities.max_queue_bytes
    );
    let _ = writeln!(
        out,
        "  \"queue_creation_mode\": {},",
        capabilities.queue_creation_mode
    );
    let _ = writeln!(
        out,
        "  \"queue_creation_pow\": {},",
        pow_json(&capabilities.queue_creation_pow)
    );
    let _ = writeln!(
        out,
        "  \"contact_queues_enabled\": {},",
        capabilities.contact_queues_enabled
    );
    let _ = writeln!(
        out,
        "  \"contact_max_pending\": {},",
        capabilities.contact_max_pending
    );
    let _ = writeln!(
        out,
        "  \"contact_max_bytes\": {},",
        capabilities.contact_max_bytes
    );
    let _ = writeln!(
        out,
        "  \"contact_append_pow\": {},",
        pow_json(&capabilities.contact_append_pow)
    );
    let _ = writeln!(
        out,
        "  \"per_source_limits\": {},",
        capabilities.per_source_limits
    );
    let _ = writeln!(
        out,
        "  \"durability_mode\": {},",
        capabilities.durability_mode
    );
    let _ = writeln!(
        out,
        "  \"operator_name\": {},",
        json_string(capabilities.operator_name.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"operator_contact\": {},",
        json_string(capabilities.operator_contact.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"operator_abuse_contact\": {},",
        json_string(capabilities.operator_abuse_contact.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"operator_jurisdiction\": {},",
        json_string(capabilities.operator_jurisdiction.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"operator_policy_url\": {},",
        json_string(capabilities.operator_policy_url.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"source_repo_url\": {},",
        json_string(capabilities.source_repo_url.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"source_commit\": {},",
        json_string(capabilities.source_commit.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"build_digest\": {},",
        json_string(capabilities.build_digest.as_slice())
    );
    let _ = writeln!(
        out,
        "  \"published_at_ms\": {},",
        capabilities.published_at_ms
    );
    let _ = writeln!(
        out,
        "  \"capabilities_digest\": \"{}\",",
        base64url(published.digest.as_bytes())
    );
    let _ = writeln!(
        out,
        "  \"signature\": \"{}\"",
        base64url(published.signed.signature.as_bytes())
    );
    out.push_str("}\n");
    out
}

fn versions(capabilities: &Capabilities) -> Vec<u16> {
    capabilities.protocol_versions.as_slice().to_vec()
}

fn pow_json(params: &PowParams) -> String {
    format!(
        "{{ \"algorithm\": {}, \"difficulty_bits\": {}, \"challenge_ttl_ms\": {} }}",
        params.algorithm, params.difficulty_bits, params.challenge_ttl_ms
    )
}

/// An operator string as JSON. The bytes are operator-authored ASCII from a
/// configuration file, but they are still escaped, because a document a third
/// party is meant to fetch and diff must not be breakable by a quotation mark.
fn json_string(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_add(2));
    out.push('"');
    for byte in bytes {
        match *byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(char::from(*byte)),
            other => {
                use std::fmt::Write as _;
                let _ = write!(out, "\\u{:04x}", u32::from(other));
            }
        }
    }
    out.push('"');
    out
}

/// base64url without padding — §3.4's representation for bytes in documents.
#[must_use]
pub fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(
        bytes
            .len()
            .saturating_mul(4)
            .saturating_div(3)
            .saturating_add(4),
    );
    for chunk in bytes.chunks(3) {
        let first = chunk.first().copied().unwrap_or(0);
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        let bits = (u32::from(first) << 16) | (u32::from(second) << 8) | u32::from(third);
        let indices = [
            (bits >> 18) & 0x3f,
            (bits >> 12) & 0x3f,
            (bits >> 6) & 0x3f,
            bits & 0x3f,
        ];
        let keep = chunk.len().saturating_add(1);
        for index in indices.iter().take(keep) {
            let position = usize::try_from(*index).unwrap_or(0);
            if let Some(byte) = ALPHABET.get(position) {
                out.push(char::from(*byte));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_relay_proto::capabilities::ClientPolicy;

    fn identity() -> SigningKey {
        SigningKey::from_seed(&[7u8; 32])
    }

    fn document(config: &Config) -> Capabilities {
        build(
            config,
            &identity().public_key(),
            Durability::FsyncPerAppend,
            1_800_000_000_000,
        )
        .unwrap()
    }

    #[test]
    fn the_default_configuration_publishes_a_document_a_strict_client_accepts() {
        let capabilities = document(&Config::default());
        assert!(capabilities::validate(&capabilities).is_ok());
        // Defaults bind loopback with no TLS, so a client still has to opt in
        // to the insecure transport — §2.3 obligation 3, working.
        let policy = ClientPolicy {
            allow_insecure_transport: true,
            ..ClientPolicy::default()
        };
        assert!(policy.accept(&capabilities).is_ok());
    }

    #[test]
    fn configured_control_bytes_fail_before_the_relay_can_publish_them() {
        let mut config = Config::default();
        config.operator.name = "line\u{001f}break".to_owned();
        assert!(matches!(
            build(
                &config,
                &identity().public_key(),
                Durability::FsyncPerAppend,
                1_800_000_000_000,
            ),
            Err(CapabilitiesError::Invalid(
                f2z_relay_proto::ProtoError::Refused(
                    f2z_relay_proto::Refusal::CapabilitiesInconsistent
                )
            ))
        ));
    }

    #[test]
    fn tls_publishes_the_exporter_binding_and_nothing_else_does() {
        let mut config = Config::default();
        assert_eq!(
            document(&config).channel_binding_mode,
            ChannelBindingMode::None.code()
        );
        config.listen.tls_cert = "cert.pem".to_owned();
        config.listen.tls_key = "key.pem".to_owned();
        let capabilities = document(&config);
        assert_eq!(
            capabilities.transport_security,
            TransportSecurity::Tls.code()
        );
        assert_eq!(
            capabilities.channel_binding_mode,
            ChannelBindingMode::TlsExporter.code()
        );
    }

    #[test]
    fn the_document_restates_the_limits_the_engine_enforces() {
        let mut config = Config::default();
        config.limits.max_queue_messages = 7;
        config.limits.max_queue_bytes = 4_096;
        config.limits.max_inflight = 3;
        let capabilities = document(&config);
        assert_eq!(capabilities.max_queue_messages, 7);
        assert_eq!(capabilities.max_queue_bytes, 4_096);
        assert_eq!(capabilities.max_inflight, 3);
    }

    #[test]
    fn the_durability_mode_is_the_stores_and_not_a_claim() {
        let config = Config::default();
        let volatile = build(
            &config,
            &identity().public_key(),
            Durability::Memory,
            1_800_000_000_000,
        )
        .unwrap();
        assert_eq!(volatile.durability_mode, DurabilityMode::Memory.code());
    }

    #[test]
    fn open_mode_publishes_no_proof_of_work_parameters() {
        let mut config = Config::default();
        config.antiabuse.queue_creation_mode = "open".to_owned();
        let capabilities = document(&config);
        assert!(!capabilities.queue_creation_pow.is_required());
        // Contact queues still demand one — §12.3 requires all four caps.
        assert!(capabilities.contact_append_pow.is_required());
    }

    #[test]
    fn the_signature_verifies_against_the_key_hello_proves() {
        let published = publish(&identity(), document(&Config::default())).unwrap();
        assert!(capabilities::verify(&published.signed, &identity().public_key()).is_ok());
        assert!(capabilities::check_digest(published.capabilities(), &published.digest).is_ok());
    }

    #[test]
    fn the_json_carries_the_same_digest_and_signature_as_the_protocol_copy() {
        let published = publish(&identity(), document(&Config::default())).unwrap();
        let json = to_json(&published);
        assert!(json.contains(&base64url(published.digest.as_bytes())));
        assert!(json.contains(&base64url(published.signed.signature.as_bytes())));
        assert!(json.contains("\"max_queue_messages\": 4096"));
    }

    #[test]
    fn base64url_matches_rfc_4648_section_5_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"foob"), "Zm9vYg");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn an_operator_string_cannot_break_the_document_it_appears_in() {
        let mut config = Config::default();
        config.operator.name = "a \"quoted\" name\\with a slash".to_owned();
        let published = publish(&identity(), document(&config)).unwrap();
        let json = to_json(&published);
        assert!(json.contains("a \\\"quoted\\\" name\\\\with a slash"));
    }
}
