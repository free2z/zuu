//! The `HELLO` exchange — `WIRE.md` §2.5 and §5.2 — and the session it
//! establishes.
//!
//! §2.5's connection lifecycle puts three checks between "the socket opened"
//! and "a signed command may be sent", and all three are here:
//!
//! 1. A version is selected, once, for the whole connection.
//! 2. The client **MUST** verify `relay_proof` before sending any signed
//!    command. Without it, §5.2's `relay_id` binding is decoration: any relay
//!    could claim another's identity, and the whole point of the binding is
//!    that it does not let a signed `ACK` be replayed at a second relay to make
//!    that relay delete ciphertext the recipient never received from it.
//! 3. The client **MUST** recompute `relay_id` from `relay_identity_pk` and
//!    compare it against any value it obtained from an in-band advert (§7.2).
//!    A mismatch is fatal and MUST be surfaced, not retried against — a relay
//!    substituted at the DNS or TLS layer presents a different `relay_id`, and
//!    the identifying material comes from inside the authenticated channel,
//!    never from the infrastructure being authenticated.
//!
//! [`verify_hello_response`] returns a [`RelaySession`], and a `RelaySession`
//! is the only thing in this crate that hands out a [`TranscriptBuilder`]. That
//! is deliberate: it makes "the proof was checked" a precondition of being able
//! to sign anything, rather than a step someone remembers.

use f2z_codec::commands::{HelloRequest, HelloResponse};
use f2z_codec::hash;
use f2z_codec::transcript::TranscriptBuilder;
use f2z_codec::types::{Challenge, ChannelBinding, Digest, PublicKey, RelayId, Signature};

use crate::capabilities::{ChannelBindingMode, ClientPolicy, TransportSecurity};
use crate::error::{ProtoError, Refusal, Result};
use crate::key::{SigningKey, VerifyingKey};

/// The bytes a relay signs to prove possession of its identity key (§5.2):
/// `"free2z/relay/v1/hello" || channel_binding || client_nonce`.
///
/// Note that this is a signing *prefix*, not an argument to `H` — the proof is
/// over the concatenation directly.
#[must_use]
pub fn relay_proof(
    identity: &SigningKey,
    channel_binding: &ChannelBinding,
    client_nonce: &Challenge,
) -> Signature {
    identity.sign(&hash::hello_proof_message(channel_binding, client_nonce))
}

/// What a relay announces about itself in `HELLO` (§6.1).
///
/// Grouped rather than passed as loose arguments because every field is a
/// policy value the relay also publishes in its capability document, and the
/// two MUST agree: `capabilities_digest` is what a client compares to detect
/// that they do not (§11.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelayAnnouncement {
    /// The version selected for this connection (§3.5).
    pub protocol_version: u16,
    /// The relay's clock, for clients whose own is unreliable (§5.5).
    pub relay_time_ms: u64,
    /// Whether the relay can bind commands to the TLS session (§5.3).
    pub channel_binding_mode: ChannelBindingMode,
    /// Whether the connection is carried by TLS at all (§2.3).
    pub transport_security: TransportSecurity,
    /// `H("free2z/relay/v1/caps", tls_codec(Capabilities))` (§6.1).
    pub capabilities_digest: Digest,
}

/// Build the `HelloResponse` a relay answers with (§6.1).
///
/// `relay_id` is recomputed here rather than taken as an argument so that a
/// relay cannot publish one that is not the digest of its own key.
#[must_use]
pub fn hello_response(
    identity: &SigningKey,
    announcement: &RelayAnnouncement,
    channel_binding: &ChannelBinding,
    client_nonce: &Challenge,
) -> HelloResponse {
    let relay_identity_pk = identity.public_key();
    HelloResponse {
        protocol_version: announcement.protocol_version,
        relay_identity_pk,
        relay_id: hash::relay_id(&relay_identity_pk),
        relay_proof: relay_proof(identity, channel_binding, client_nonce),
        relay_time_ms: announcement.relay_time_ms,
        channel_binding_mode: announcement.channel_binding_mode.code(),
        transport_security: announcement.transport_security.code(),
        capabilities_digest: announcement.capabilities_digest,
    }
}

/// A connection whose relay has proved who it is.
///
/// Holds the three values that are constant for the connection and that §5.2
/// and §5.3 require be the *relay's own*, never the frame's: the negotiated
/// version, the relay identity, and this session's channel binding.
#[derive(Clone, Debug)]
pub struct RelaySession {
    transcripts: TranscriptBuilder,
    relay_identity_pk: PublicKey,
    relay_time_ms: u64,
    channel_binding_mode: ChannelBindingMode,
    transport_security: TransportSecurity,
    capabilities_digest: Digest,
}

impl RelaySession {
    /// The transcript builder every signed command on this connection is built
    /// and verified through.
    #[must_use]
    pub const fn transcripts(&self) -> &TranscriptBuilder {
        &self.transcripts
    }

    /// The version selected for this connection (§3.5: negotiation happens
    /// once, in `HELLO`, and applies to the whole connection).
    #[must_use]
    pub const fn protocol_version(&self) -> u16 {
        self.transcripts.protocol_version()
    }

    /// The relay's identity binding.
    #[must_use]
    pub const fn relay_id(&self) -> RelayId {
        self.transcripts.relay_id()
    }

    /// The relay's long-term public key, proved in `HELLO`. This is what a
    /// capability document must be signed by (§11.3 step 1).
    #[must_use]
    pub const fn relay_identity_pk(&self) -> PublicKey {
        self.relay_identity_pk
    }

    /// The relay's clock at `HELLO`.
    ///
    /// §5.5: a client with an unreliable clock learns the relay's time here and
    /// applies the offset locally. It **MUST NOT** set its system clock from
    /// it.
    #[must_use]
    pub const fn relay_time_ms(&self) -> u64 {
        self.relay_time_ms
    }

    /// The channel-binding mode this connection is operating in.
    #[must_use]
    pub const fn channel_binding_mode(&self) -> ChannelBindingMode {
        self.channel_binding_mode
    }

    /// Whether the connection is carried by TLS at all (§2.3).
    #[must_use]
    pub const fn transport_security(&self) -> TransportSecurity {
        self.transport_security
    }

    /// The digest of the capability document in force when the connection
    /// opened. Compare with [`crate::capabilities::check_digest`] after
    /// fetching, and again on `NOTICE(3)` (§6.4).
    #[must_use]
    pub const fn capabilities_digest(&self) -> Digest {
        self.capabilities_digest
    }

    /// The client's own estimate of the relay's clock, `elapsed_ms` after the
    /// `HELLO` response arrived.
    ///
    /// This is the value to put in a signed command's `timestamp_ms` (§5.5).
    /// Taking the elapsed time as an argument keeps the crate clock-free.
    #[must_use]
    pub const fn relay_time_after(&self, elapsed_ms: u64) -> u64 {
        self.relay_time_ms.saturating_add(elapsed_ms)
    }
}

/// Verify a `HELLO` response and open a session (§2.5 steps 2-3, §5.2).
///
/// `channel_binding` is the value **this client computed from its own TLS
/// state** — [`ChannelBinding::zero`] when the relay published
/// `channel_binding_mode: none`. It is never transmitted; both ends derive it
/// and the transcript binds to it, which is what makes a captured frame useless
/// on any other connection.
///
/// `expected_relay_id` is the value from the peer's in-band advert (§7.2), when
/// there is one. First contact via a directory entry has one too (§12.5 step
/// 3): the contact endpoint carries `relay_id` beside `contact_addr`, covered
/// by the directory's authorization signature.
///
/// # Errors
///
/// - [`Refusal::VersionNotOffered`] if the selected version is outside the
///   offered range, or is one this build does not implement.
/// - [`Refusal::RelayIdNotDerived`] if `relay_id` is not the digest of
///   `relay_identity_pk`.
/// - [`Refusal::RelayIdMismatch`] if it is not the one the advert named. This
///   is the fatal one — the relay was substituted.
/// - [`Refusal::ChannelBindingMismatch`] if the published mode and the supplied
///   binding disagree.
/// - [`Refusal::RelayKeyInvalid`] or [`Refusal::RelayProofInvalid`] if the
///   proof of possession does not hold.
/// - [`Refusal::InsecureTransport`] if the relay serves without TLS and the
///   policy has not opted in.
/// - [`Refusal::NoChannelBinding`] under a strict policy against a relay that
///   cannot bind.
pub fn verify_hello_response(
    response: &HelloResponse,
    offer: &HelloRequest,
    channel_binding: &ChannelBinding,
    expected_relay_id: Option<&RelayId>,
    policy: &ClientPolicy,
) -> Result<RelaySession> {
    // §3.5: one version, selected once, for the whole connection.
    if response.protocol_version < offer.min_version
        || response.protocol_version > offer.max_version
        || response.protocol_version != f2z_codec::PROTOCOL_VERSION
    {
        return Err(ProtoError::Refused(Refusal::VersionNotOffered));
    }

    // §6.1: `relay_id` MUST equal H("free2z/relay/v1/relay-id",
    // relay_identity_pk). A relay that publishes anything else has contradicted
    // itself inside one frame.
    if hash::relay_id(&response.relay_identity_pk) != response.relay_id {
        return Err(ProtoError::Refused(Refusal::RelayIdNotDerived));
    }
    // §2.5 step 3 and §5.2. Checked before the proof so that a substituted
    // relay is reported as a substitution rather than as a bad signature — the
    // two failures call for very different things from a user.
    if let Some(expected) = expected_relay_id
        && *expected != response.relay_id
    {
        return Err(ProtoError::Refused(Refusal::RelayIdMismatch));
    }

    let binding_mode = ChannelBindingMode::from_code(response.channel_binding_mode)
        .map_err(|_| ProtoError::Refused(Refusal::ChannelBindingMismatch))?;
    let transport = TransportSecurity::from_code(response.transport_security)
        .map_err(|_| ProtoError::Refused(Refusal::InsecureTransport))?;

    // §5.3: `none` mode MUST use 32 zero bytes. The converse is checked too: a
    // relay claiming an exporter while the client derived nothing means the two
    // ends disagree about what the transcript covers, and a signature made
    // under that disagreement fails later, obscurely. Fail now, clearly.
    //
    // A genuine exporter output of 32 zero bytes has probability 2^-256, so
    // treating zero as "absent" costs nothing real and removes the sentinel
    // ambiguity.
    let binding_is_zero = channel_binding.is_zero();
    let binding_ok = match binding_mode {
        ChannelBindingMode::None => binding_is_zero,
        ChannelBindingMode::TlsExporter => !binding_is_zero,
    };
    if !binding_ok {
        return Err(ProtoError::Refused(Refusal::ChannelBindingMismatch));
    }

    // §2.3 obligation 3 and §5.3's strict mode. Policy, not validity.
    if matches!(transport, TransportSecurity::None) && !policy.allow_insecure_transport {
        return Err(ProtoError::Refused(Refusal::InsecureTransport));
    }
    if matches!(binding_mode, ChannelBindingMode::None) && policy.require_channel_binding {
        return Err(ProtoError::Refused(Refusal::NoChannelBinding));
    }

    // §5.2: proof of possession, over this session's binding and this client's
    // nonce, so it cannot be replayed from another connection.
    let identity = VerifyingKey::from_public_key(&response.relay_identity_pk)
        .map_err(|_| ProtoError::Refused(Refusal::RelayKeyInvalid))?;
    identity
        .verify(
            &hash::hello_proof_message(channel_binding, &offer.client_nonce),
            &response.relay_proof,
        )
        .map_err(|_| ProtoError::Refused(Refusal::RelayProofInvalid))?;

    Ok(RelaySession {
        transcripts: TranscriptBuilder::new(
            response.protocol_version,
            response.relay_id,
            *channel_binding,
        ),
        relay_identity_pk: response.relay_identity_pk,
        relay_time_ms: response.relay_time_ms,
        channel_binding_mode: binding_mode,
        transport_security: transport,
        capabilities_digest: response.capabilities_digest,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capabilities;

    const NOW: u64 = 1_800_000_000_000;

    fn offer() -> HelloRequest {
        HelloRequest {
            min_version: 1,
            max_version: 1,
            client_nonce: Challenge::new([0x5a; 32]),
        }
    }

    fn binding() -> ChannelBinding {
        ChannelBinding::new([0x33; 32])
    }

    fn relay() -> SigningKey {
        SigningKey::from_seed(&[0x44; 32])
    }

    fn announcement(
        identity: &SigningKey,
        channel_binding_mode: ChannelBindingMode,
        transport_security: TransportSecurity,
    ) -> RelayAnnouncement {
        let capabilities = capabilities::defaults(&identity.public_key(), NOW).unwrap();
        RelayAnnouncement {
            protocol_version: 1,
            relay_time_ms: NOW,
            channel_binding_mode,
            transport_security,
            capabilities_digest: capabilities::digest(&capabilities).unwrap(),
        }
    }

    fn response(identity: &SigningKey, binding: &ChannelBinding) -> HelloResponse {
        hello_response(
            identity,
            &announcement(
                identity,
                ChannelBindingMode::TlsExporter,
                TransportSecurity::Tls,
            ),
            binding,
            &offer().client_nonce,
        )
    }

    #[test]
    fn a_well_formed_hello_opens_a_session() {
        let identity = relay();
        let response = response(&identity, &binding());
        let session = verify_hello_response(
            &response,
            &offer(),
            &binding(),
            Some(&hash::relay_id(&identity.public_key())),
            &ClientPolicy::default(),
        )
        .unwrap();
        assert_eq!(session.protocol_version(), 1);
        assert_eq!(session.relay_identity_pk(), identity.public_key());
        assert_eq!(session.relay_time_after(1_500), NOW + 1_500);
        assert_eq!(session.transcripts().channel_binding(), binding());
    }

    #[test]
    fn a_substituted_relay_is_caught_by_the_advert() {
        let identity = relay();
        let response = response(&identity, &binding());
        assert_eq!(
            verify_hello_response(
                &response,
                &offer(),
                &binding(),
                Some(&RelayId::new([0u8; 32])),
                &ClientPolicy::default(),
            )
            .map(|_| ()),
            Err(ProtoError::Refused(Refusal::RelayIdMismatch))
        );
    }

    #[test]
    fn a_relay_id_that_is_not_the_digest_of_the_key_is_caught_without_an_advert() {
        let identity = relay();
        let mut response = response(&identity, &binding());
        response.relay_id = RelayId::new([1u8; 32]);
        assert_eq!(
            verify_hello_response(
                &response,
                &offer(),
                &binding(),
                None,
                &ClientPolicy::default()
            )
            .map(|_| ()),
            Err(ProtoError::Refused(Refusal::RelayIdNotDerived))
        );
    }

    #[test]
    fn a_proof_from_another_session_does_not_verify() {
        let identity = relay();
        // The relay signed over a different TLS session's exporter.
        let response = response(&identity, &ChannelBinding::new([0x99; 32]));
        assert_eq!(
            verify_hello_response(
                &response,
                &offer(),
                &binding(),
                None,
                &ClientPolicy::default()
            )
            .map(|_| ()),
            Err(ProtoError::Refused(Refusal::RelayProofInvalid))
        );
    }

    #[test]
    fn a_proof_for_another_clients_nonce_does_not_verify() {
        let identity = relay();
        let response = response(&identity, &binding());
        let replayed_at = HelloRequest {
            client_nonce: Challenge::new([0x5b; 32]),
            ..offer()
        };
        assert_eq!(
            verify_hello_response(
                &response,
                &replayed_at,
                &binding(),
                None,
                &ClientPolicy::default()
            )
            .map(|_| ()),
            Err(ProtoError::Refused(Refusal::RelayProofInvalid))
        );
    }

    #[test]
    fn a_relay_that_claims_an_exporter_we_do_not_have_is_refused() {
        let identity = relay();
        let response = response(&identity, &ChannelBinding::zero());
        assert_eq!(
            verify_hello_response(
                &response,
                &offer(),
                &ChannelBinding::zero(),
                None,
                &ClientPolicy::default()
            )
            .map(|_| ()),
            Err(ProtoError::Refused(Refusal::ChannelBindingMismatch))
        );
    }

    #[test]
    fn none_mode_requires_the_zero_binding_and_works_with_it() {
        let identity = relay();
        let zero = ChannelBinding::zero();
        let response = hello_response(
            &identity,
            &announcement(&identity, ChannelBindingMode::None, TransportSecurity::Tls),
            &zero,
            &offer().client_nonce,
        );
        let session =
            verify_hello_response(&response, &offer(), &zero, None, &ClientPolicy::default())
                .unwrap();
        assert_eq!(session.channel_binding_mode(), ChannelBindingMode::None);

        let strict = ClientPolicy {
            require_channel_binding: true,
            ..ClientPolicy::default()
        };
        assert_eq!(
            verify_hello_response(&response, &offer(), &zero, None, &strict).map(|_| ()),
            Err(ProtoError::Refused(Refusal::NoChannelBinding))
        );
    }

    #[test]
    fn a_version_outside_the_offer_is_refused() {
        let identity = relay();
        let mut response = response(&identity, &binding());
        response.protocol_version = 2;
        assert_eq!(
            verify_hello_response(
                &response,
                &offer(),
                &binding(),
                None,
                &ClientPolicy::default()
            )
            .map(|_| ()),
            Err(ProtoError::Refused(Refusal::VersionNotOffered))
        );
    }

    #[test]
    fn a_plaintext_relay_needs_an_explicit_opt_in() {
        let identity = relay();
        let zero = ChannelBinding::zero();
        let response = hello_response(
            &identity,
            &announcement(&identity, ChannelBindingMode::None, TransportSecurity::None),
            &zero,
            &offer().client_nonce,
        );
        assert_eq!(
            verify_hello_response(&response, &offer(), &zero, None, &ClientPolicy::default())
                .map(|_| ()),
            Err(ProtoError::Refused(Refusal::InsecureTransport))
        );
        let opted_in = ClientPolicy {
            allow_insecure_transport: true,
            ..ClientPolicy::default()
        };
        assert!(verify_hello_response(&response, &offer(), &zero, None, &opted_in).is_ok());
    }
}
