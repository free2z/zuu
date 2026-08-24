//! The signing transcript — `WIRE.md` §5.
//!
//! ```text
//! struct {
//!     opaque label<0..255>;      /* exactly "free2z/relay/v1/cmd"           */
//!     uint16 protocol_version;
//!     opaque relay_id[32];       /* §5.2                                    */
//!     opaque channel_binding[32];/* §5.3                                    */
//!     uint16 command;
//!     uint32 request_id;
//!     opaque address[32];
//!     opaque signer_key[32];
//!     uint64 timestamp_ms;
//!     opaque nonce[16];
//!     opaque body_hash[32];      /* H("free2z/relay/v1/body", body)         */
//! } CommandTranscript;
//! ```
//!
//! Two of these fields are the whole security argument and neither is
//! transmitted:
//!
//! - **`relay_id`** (§5.2) makes a signature valid at exactly one relay. Without
//!   it, relay A can take a signed `APPEND` verbatim and submit it to relay B,
//!   which verifies it happily — and worse, can replay the recipient's
//!   cumulative `ACK` to B so that **B deletes ciphertext the recipient never
//!   received from B**. Silent, permanent message loss, using only bytes the
//!   victim itself signed.
//! - **`channel_binding`** (§5.3) is the TLS 1.3 exporter, computed
//!   independently by both ends. A relay behind a TLS-terminating proxy cannot
//!   compute it, MUST publish `channel_binding_mode: "none"`, and MUST use 32
//!   zero bytes — [`ChannelBinding::zero`].
//!
//! The relay reconstructs the transcript from *its own* values for both, so a
//! signature made for another relay or on another TLS session simply fails to
//! verify. That is why [`TranscriptBuilder`] takes them once, at construction,
//! and why nothing here accepts them per-command.

// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;
use alloc::vec::Vec;

use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::canonical::encode;
use crate::error::CodecError;
use crate::frame::SignedAuth;
use crate::hash::{LABEL_COMMAND, body_hash};
use crate::types::{ChannelBinding, Digest, Nonce, PublicKey, QueueAddress, RelayId, ShortBytes};

/// The fixed-shape structure every signed command is authenticated over
/// (`WIRE.md` §5.1).
///
/// Encoded with `tls_codec` and signed directly — Ed25519 is not prehashed and
/// the transcript is small. It carries `body_hash` rather than the body so that
/// it stays fixed-length and the signature stays independent of body size.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct CommandTranscript {
    /// Exactly `"free2z/relay/v1/cmd"`. Checked by [`CommandTranscript::validate`].
    pub label: ShortBytes,
    /// The version selected for the connection in `HELLO` (§3.5).
    pub protocol_version: u16,
    /// The relay's identity binding (§5.2).
    pub relay_id: RelayId,
    /// The TLS exporter, or 32 zero bytes in `none` mode (§5.3).
    pub channel_binding: ChannelBinding,
    /// The command code (§6).
    pub command: u16,
    /// The frame's `request_id`.
    pub request_id: u32,
    /// The queue address acted on; zeros where none.
    pub address: QueueAddress,
    /// The key claimed to authorize this command.
    pub signer_key: PublicKey,
    /// Client clock, milliseconds since the Unix epoch.
    pub timestamp_ms: u64,
    /// Client CSPRNG, fresh per command.
    pub nonce: Nonce,
    /// `H("free2z/relay/v1/body", body)` over the **re-encoded** body (§3.3).
    pub body_hash: Digest,
}

impl CommandTranscript {
    /// The exact bytes to sign or verify.
    ///
    /// # Errors
    ///
    /// [`CodecError`] if the structure cannot be encoded.
    pub fn signing_bytes(&self) -> Result<Vec<u8>, CodecError> {
        encode(self)
    }

    /// Check the invariants a decoder cannot: that `label` is exactly the
    /// specified ASCII bytes.
    ///
    /// A transcript is normally built, not received, so this exists for the
    /// test vectors and for any implementation that parses one.
    ///
    /// # Errors
    ///
    /// [`CodecError::InvalidValue`] if `label` is anything but
    /// `"free2z/relay/v1/cmd"`.
    pub fn validate(&self) -> Result<(), CodecError> {
        if self.label.as_slice() == LABEL_COMMAND {
            Ok(())
        } else {
            Err(CodecError::InvalidValue)
        }
    }
}

/// The four per-command fields a [`SignedAuth`] carries besides the signature
/// itself.
///
/// This exists because the signature is computed *from* the other four, so
/// there is a moment — on the sending side — when they exist and the signature
/// does not. Modelling that moment is better than filling in a placeholder
/// signature and hoping nobody sends it: build an `AuthContext`, hand it to
/// [`TranscriptBuilder::build`], sign the result, and call
/// [`AuthContext::into_auth`] with the signature you got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthContext {
    /// The queue address acted on; [`QueueAddress::zero`] where none (§5.1).
    pub address: QueueAddress,
    /// The Ed25519 public key claimed to authorize this command.
    pub signer_key: PublicKey,
    /// Client clock, milliseconds since the Unix epoch (§5.5).
    pub timestamp_ms: u64,
    /// Client CSPRNG, fresh per command (§5.5).
    pub nonce: Nonce,
}

impl AuthContext {
    /// The fields of a received authenticator.
    #[must_use]
    pub const fn from_auth(auth: &SignedAuth) -> Self {
        Self {
            address: auth.address,
            signer_key: auth.signer_key,
            timestamp_ms: auth.timestamp_ms,
            nonce: auth.nonce,
        }
    }

    /// Complete the authenticator with the signature over the transcript these
    /// fields produced.
    #[must_use]
    pub const fn into_auth(self, signature: crate::types::Signature) -> SignedAuth {
        SignedAuth {
            address: self.address,
            signer_key: self.signer_key,
            timestamp_ms: self.timestamp_ms,
            nonce: self.nonce,
            signature,
        }
    }
}

/// Builds transcripts for one connection to one relay.
///
/// Holds the three values that are constant for the life of a connection — the
/// negotiated `protocol_version`, the relay's `relay_id`, and this session's
/// `channel_binding` — so that no call site can pass a per-command value for
/// any of them. §5.2's replay-across-relays attack and §5.3's
/// replay-across-sessions attack are both closed by those three being fixed,
/// and a builder is how that becomes a type-level property instead of a
/// convention.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranscriptBuilder {
    protocol_version: u16,
    relay_id: RelayId,
    channel_binding: ChannelBinding,
}

impl TranscriptBuilder {
    /// Bind to a negotiated version, a relay identity and a TLS session.
    ///
    /// Pass [`ChannelBinding::zero`] — and only that — when the relay published
    /// `channel_binding_mode: "none"` (§5.3).
    #[must_use]
    pub const fn new(
        protocol_version: u16,
        relay_id: RelayId,
        channel_binding: ChannelBinding,
    ) -> Self {
        Self {
            protocol_version,
            relay_id,
            channel_binding,
        }
    }

    /// The negotiated protocol version.
    #[must_use]
    pub const fn protocol_version(&self) -> u16 {
        self.protocol_version
    }

    /// This connection's relay identity binding.
    #[must_use]
    pub const fn relay_id(&self) -> RelayId {
        self.relay_id
    }

    /// This connection's channel binding.
    #[must_use]
    pub const fn channel_binding(&self) -> ChannelBinding {
        self.channel_binding
    }

    /// Build the transcript for one command.
    ///
    /// `reencoded_body` MUST be the output of §3.3's re-encode step — the bytes
    /// [`Canonicalized::bytes`] returns — not the bytes that arrived on the
    /// wire. On the sending side the two are the same by construction; on the
    /// receiving side they are the same only because §3.3 has already proved
    /// it, and using the received bytes would reintroduce exactly the gap that
    /// rule closes.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] can only arise from the fixed label, so in
    /// practice this does not fail.
    ///
    /// [`Canonicalized::bytes`]: crate::canonical::Canonicalized::bytes
    pub fn build(
        &self,
        command: u16,
        request_id: u32,
        context: &AuthContext,
        reencoded_body: &[u8],
    ) -> Result<CommandTranscript, CodecError> {
        Ok(CommandTranscript {
            label: ShortBytes::new(LABEL_COMMAND)?,
            protocol_version: self.protocol_version,
            relay_id: self.relay_id,
            channel_binding: self.channel_binding,
            command,
            request_id,
            address: context.address,
            signer_key: context.signer_key,
            timestamp_ms: context.timestamp_ms,
            nonce: context.nonce,
            body_hash: body_hash(reencoded_body),
        })
    }

    /// Rebuild the transcript a received frame claims to have been signed over.
    ///
    /// This is verification step 4 of §5.1, and the ordering it encodes is the
    /// point: `relay_id` and `channel_binding` come from `self` — the relay's
    /// own values — while everything else comes from the frame. A caller cannot
    /// accidentally take the peer's word for either.
    ///
    /// # Errors
    ///
    /// As [`TranscriptBuilder::build`].
    pub fn rebuild_from_auth(
        &self,
        command: u16,
        request_id: u32,
        auth: &SignedAuth,
        reencoded_body: &[u8],
    ) -> Result<CommandTranscript, CodecError> {
        self.build(
            command,
            request_id,
            &AuthContext::from_auth(auth),
            reencoded_body,
        )
    }

    /// Build the transcript and return the bytes to sign or verify.
    ///
    /// # Errors
    ///
    /// As [`TranscriptBuilder::build`].
    pub fn signing_bytes_for_auth(
        &self,
        command: u16,
        request_id: u32,
        auth: &SignedAuth,
        reencoded_body: &[u8],
    ) -> Result<Vec<u8>, CodecError> {
        self.rebuild_from_auth(command, request_id, auth, reencoded_body)?
            .signing_bytes()
    }
}

/// The wire length of a `CommandTranscript`, in bytes.
///
/// `1 + 19` label, `2` version, `32` relay id, `32` channel binding, `2`
/// command, `4` request id, `32` address, `32` signer key, `8` timestamp, `16`
/// nonce, `32` body hash.
pub const TRANSCRIPT_LEN: usize = 1 + 19 + 2 + 32 + 32 + 2 + 4 + 32 + 32 + 8 + 16 + 32;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::decode_canonical;
    use crate::commands::Command;
    use crate::types::Signature;
    use alloc::vec;

    fn builder() -> TranscriptBuilder {
        TranscriptBuilder::new(
            crate::PROTOCOL_VERSION,
            RelayId::new([0x11; 32]),
            ChannelBinding::new([0x22; 32]),
        )
    }

    fn auth() -> SignedAuth {
        SignedAuth {
            address: QueueAddress::new([0x33; 32]),
            signer_key: PublicKey::new([0x44; 32]),
            timestamp_ms: 1_700_000_000_000,
            nonce: Nonce::new([0x55; 16]),
            signature: Signature::new([0x66; 64]),
        }
    }

    #[test]
    fn transcript_is_fixed_length_and_starts_with_the_label() {
        let transcript = builder()
            .build(
                Command::Append.code(),
                7,
                &AuthContext {
                    address: QueueAddress::new([1u8; 32]),
                    signer_key: PublicKey::new([2u8; 32]),
                    timestamp_ms: 1,
                    nonce: Nonce::new([3u8; 16]),
                },
                b"body",
            )
            .unwrap();
        let bytes = transcript.signing_bytes().unwrap();
        assert_eq!(bytes.len(), TRANSCRIPT_LEN);
        assert_eq!(bytes[0], LABEL_COMMAND.len() as u8);
        assert_eq!(&bytes[1..1 + LABEL_COMMAND.len()], LABEL_COMMAND);
        assert!(transcript.validate().is_ok());

        // And it is canonical like every other structure here.
        assert_eq!(
            decode_canonical::<CommandTranscript>(&bytes)
                .unwrap()
                .value(),
            &transcript
        );
    }

    #[test]
    fn a_transcript_with_the_wrong_label_is_refused() {
        let mut transcript = builder()
            .build(1, 1, &AuthContext::from_auth(&auth()), b"")
            .unwrap();
        transcript.label = ShortBytes::new(b"free2z/relay/v1/cmd2".to_vec()).unwrap();
        assert_eq!(transcript.validate(), Err(CodecError::InvalidValue));
    }

    #[test]
    fn relay_id_binding_changes_the_signed_bytes() {
        // §5.2: the same signed command replayed at a second relay must not
        // verify there. That property is exactly "the transcripts differ".
        let a = builder();
        let b = TranscriptBuilder::new(
            crate::PROTOCOL_VERSION,
            RelayId::new([0x99; 32]),
            a.channel_binding(),
        );
        let auth = auth();
        assert_ne!(
            a.signing_bytes_for_auth(Command::Ack.code(), 5, &auth, b"body")
                .unwrap(),
            b.signing_bytes_for_auth(Command::Ack.code(), 5, &auth, b"body")
                .unwrap()
        );
    }

    #[test]
    fn channel_binding_changes_the_signed_bytes() {
        // §5.3: a frame captured on one TLS session is useless on another.
        let a = builder();
        let b = TranscriptBuilder::new(
            crate::PROTOCOL_VERSION,
            a.relay_id(),
            ChannelBinding::zero(),
        );
        let auth = auth();
        assert_ne!(
            a.signing_bytes_for_auth(Command::Read.code(), 5, &auth, b"")
                .unwrap(),
            b.signing_bytes_for_auth(Command::Read.code(), 5, &auth, b"")
                .unwrap()
        );
    }

    #[test]
    fn the_body_is_covered_by_its_hash() {
        let builder = builder();
        let auth = auth();
        let short = builder
            .signing_bytes_for_auth(Command::Append.code(), 1, &auth, b"one")
            .unwrap();
        let long = builder
            .signing_bytes_for_auth(Command::Append.code(), 1, &auth, &vec![0u8; 65536])
            .unwrap();
        assert_ne!(short, long);
        // Fixed length regardless of body size — the reason §5.1 carries a hash.
        assert_eq!(short.len(), long.len());
    }

    #[test]
    fn rebuild_takes_relay_values_from_the_builder_not_the_frame() {
        let builder = builder();
        let auth = auth();
        let rebuilt = builder
            .rebuild_from_auth(Command::Subscribe.code(), 2, &auth, b"")
            .unwrap();
        assert_eq!(rebuilt.relay_id, builder.relay_id());
        assert_eq!(rebuilt.channel_binding, builder.channel_binding());
        assert_eq!(rebuilt.address, auth.address);
        assert_eq!(rebuilt.signer_key, auth.signer_key);
        assert_eq!(rebuilt.nonce, auth.nonce);
    }
}
