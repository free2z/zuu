//! The version-1 wire format — `docs/intent-bridge/PROTOCOL.md` §3.
//!
//! # Why this reuses `f2z-codec` rather than defining an encoding
//!
//! The bridge could have been JSON over a deep-link query string, which is
//! what every ad-hoc app-to-app handoff turns into. It is not, for three
//! reasons, and the first is the one that decided it:
//!
//! 1. **Re-encode equality.** `WIRE.md` §3.3 requires every received structure
//!    to be decoded, re-encoded and byte-compared, and requires the
//!    *re-encoded* bytes — never the received ones — to be what a hash covers.
//!    The intent bridge needs exactly that property for exactly the same
//!    reason: [`IntentRequest::digest`] is what a native confirmation binds
//!    to, so a request that decodes two ways is a request whose confirmation
//!    means two things. `f2z_codec::decode_canonical` is the only
//!    implementation of that rule in this tree, and it stays the only one.
//! 2. **One decoder in the audit scope.** The client half of this bridge ships
//!    inside apps that already carry `f2z-codec` for messaging. A second
//!    encoding would be a second parser in the same binary, reachable from the
//!    same untrusted input, for no property the first one lacks.
//! 3. **The TLS presentation language has exactly one encoding per value.**
//!    JSON has several for most values — key order, number formatting,
//!    whitespace, duplicate keys — so "the bytes the user approved" and "the
//!    bytes the wallet executed" are only the same string by convention.
//!
//! # The shape, and where the version check sits
//!
//! ```text
//! struct {
//!     uint16 version;             // 1
//!     opaque body<0..2^24-1>;     // IntentRequestV1, when version == 1
//! } IntentRequestEnvelope;
//!
//! struct {
//!     uint16 intent;              // the family; 0 is not a family
//!     opaque request_id[32];      // CSPRNG. The one-use key AND the correlator.
//!     opaque caller<0..255>;      // CLAIMED. Not authenticated by this structure.
//!     opaque purpose<0..255>;     // shown inside ZUULI's own rendering
//!     uint64 issued_at_ms;
//!     uint64 expires_at_ms;
//!     opaque payload<0..2^24-1>;  // the family request, decoded once `intent` is known
//! } IntentRequestV1;
//!
//! struct {
//!     opaque request_id[32];      // echoes the request
//!     uint16 intent;              // echoes the request
//!     uint16 status;              // 0 fulfilled, else an IntentError status
//!     opaque payload<0..2^24-1>;  // the family result, empty on refusal
//! } IntentResponseV1;
//! ```
//!
//! **The body is opaque at the envelope layer, and that is the whole
//! version-refusal mechanism.** [`IntentRequest::parse`] reads `version`,
//! compares it against [`crate::PROTOCOL_VERSION`], and returns
//! [`IntentError::UnsupportedVersion`] *before any byte of `body` is
//! interpreted*. A version-2 body therefore cannot be parsed as a version-1
//! request whose trailing fields happen to be absent, which is the
//! best-guessing failure `#905` names. Had `version` and the v1 fields sat in
//! one flat structure, a v2 request that merely appended a field would decode
//! as a v1 request plus trailing bytes — and a decoder one line less strict
//! than this one would accept it.
//!
//! The same reasoning applies one level down and is why `intent` selects an
//! opaque `payload` rather than a `tls_codec` enum: an unknown family is
//! refused with [`IntentError::UnknownIntent`] rather than decoded into
//! whatever the first known family's fields happen to match.
//!
//! # What is *not* here
//!
//! No signature over the request, and none over the response. The bridge's
//! authenticity story is the transport (verified App Links / Universal Links,
//! `#461`) plus the native confirmation, and inventing a key here would be a
//! second, weaker identity for the same apps. See
//! `docs/intent-bridge/CALLER-AUTHENTICATION.md`, which states what that does
//! and does not buy.

// `tls_codec`'s derive macros build their error strings with `format!` and
// return `Vec<u8>`; both need to be in scope in a `no_std` crate.
use alloc::format;
use alloc::vec::Vec;
use core::fmt;

use f2z_codec::canonical::{Canonical, Canonicalized, decode_canonical};
use f2z_codec::hash::hash;
use f2z_codec::types::{Body, Digest, PublicKey, ShortBytes, Signature};
use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsDeserializeBytes,
    TlsSerializeBytes, TlsSize,
};

use crate::error::IntentError;
use crate::text::VisibleText;

/// Declare a fixed-width opaque newtype with a redacting `Debug`.
///
/// A near-copy of `f2z-codec`'s `opaque_fixed!`, and deliberately so: that
/// macro is private to that crate, and the alternative — deriving `Debug` on a
/// `[u8; 32]` field — is exactly what
/// `f2z-codec/tests/workspace_debug_scan.rs` refuses across this workspace.
macro_rules! opaque_fixed {
    ($(#[$meta:meta])* $name:ident, $len:expr) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name([u8; $len]);

        impl $name {
            #[doc = concat!("The wire width of a `", stringify!($name), "`, in bytes.")]
            pub const LEN: usize = $len;

            #[doc = concat!("Wrap ", stringify!($len), " bytes.")]
            #[must_use]
            pub const fn new(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }

            /// Borrow the bytes.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// Wrap a slice of exactly the right length.
            ///
            /// # Errors
            ///
            /// [`IntentError::InvalidValue`] if the slice is a different length.
            pub fn from_slice(bytes: &[u8]) -> Result<Self, IntentError> {
                let array: [u8; $len] =
                    bytes.try_into().map_err(|_| IntentError::InvalidValue)?;
                Ok(Self(array))
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(concat!(stringify!($name), "(<redacted>)"))
            }
        }

        impl Size for $name {
            fn tls_serialized_len(&self) -> usize {
                $len
            }
        }

        impl SerializeBytes for $name {
            fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
                self.0.tls_serialize_bytes()
            }
        }

        impl DeserializeBytes for $name {
            fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
                let (array, rest) = <[u8; $len]>::tls_deserialize_bytes(bytes)?;
                Ok((Self(array), rest))
            }
        }
    };
}

opaque_fixed!(
    /// The 32 CSPRNG bytes that identify one issuance.
    ///
    /// It does three jobs at once, and all three depend on it being
    /// unguessable: it is the key the one-use ledger records
    /// ([`crate::ledger`]), it is what a response echoes so a client can
    /// recognize an answer to a question it actually asked, and it is part of
    /// the bytes a native confirmation binds to.
    ///
    /// Redacted in `Debug`. It is a bearer correlator: an app that learns one
    /// before the wallet answers can attempt to pre-empt the response.
    RequestId,
    32
);

opaque_fixed!(
    /// A Zcash transaction identifier, as returned by a fulfilled
    /// `execute-payment`.
    TxId,
    32
);

/// The intent families version 1 defines.
///
/// Not a `tls_codec` enum: the wire field is a raw `u16` so that an unknown
/// family survives re-encode equality and is refused by *policy*
/// ([`IntentError::UnknownIntent`]) rather than by a decode failure that would
/// make a well-framed request indistinguishable from a corrupt one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum Intent {
    /// Prove control of the wallet's identity over caller-supplied bytes.
    /// Returns a signature. Spends nothing.
    SignChallenge,
    /// Issue a `DeviceCredential` (`docs/e2ee/ARCHITECTURE.md` §4.2) over
    /// device **public** keys the caller generated locally and never exports.
    IssueDeviceCredential,
    /// Send ZEC. ZUULI re-derives and shows its **own** payment review.
    ExecutePayment,
}

impl Intent {
    /// Every family, in wire order.
    pub const ALL: [Self; 3] = [
        Self::SignChallenge,
        Self::IssueDeviceCredential,
        Self::ExecutePayment,
    ];

    /// The wire code. `0` is not a family.
    #[must_use]
    pub const fn code(self) -> u16 {
        match self {
            Self::SignChallenge => 1,
            Self::IssueDeviceCredential => 2,
            Self::ExecutePayment => 3,
        }
    }

    /// Resolve a wire code.
    ///
    /// # Errors
    ///
    /// [`IntentError::UnknownIntent`] for anything else, `0` included.
    pub const fn from_code(code: u16) -> Result<Self, IntentError> {
        Ok(match code {
            1 => Self::SignChallenge,
            2 => Self::IssueDeviceCredential,
            3 => Self::ExecutePayment,
            _ => return Err(IntentError::UnknownIntent),
        })
    }

    /// The stable name, for logs and for the confirmation heading ZUULI
    /// renders itself.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::SignChallenge => "sign-challenge",
            Self::IssueDeviceCredential => "issue-device-credential",
            Self::ExecutePayment => "execute-payment",
        }
    }
}

/// `struct { uint16 version; opaque body<0..2^24-1>; } IntentRequestEnvelope;`
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct IntentRequestEnvelope {
    /// The protocol version. Raw, so an unknown version round-trips instead of
    /// failing to decode — and is then refused by policy.
    pub version: u16,
    /// The versioned request. Opaque here; see the module note.
    pub body: Body,
}

/// `struct { uint16 version; opaque body<0..2^24-1>; } IntentResponseEnvelope;`
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct IntentResponseEnvelope {
    /// The protocol version.
    pub version: u16,
    /// The versioned response. Opaque here.
    pub body: Body,
}

/// The version-1 request body.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct IntentRequestV1 {
    /// The family code. Raw; resolved by [`Intent::from_code`].
    pub intent: u16,
    /// The one-use identifier.
    pub request_id: RequestId,
    /// The caller's **claimed** identity — an Android package name or an iOS
    /// bundle identifier. A deep link does not authenticate its sender, so
    /// this field is a lookup key into a registry, never a credential. See
    /// [`crate::caller`].
    pub caller: ShortBytes,
    /// Why the caller wants this, in the caller's words, for ZUULI to render
    /// inside its own confirmation.
    pub purpose: ShortBytes,
    /// Issuance, milliseconds since the Unix epoch, by the caller's clock.
    pub issued_at_ms: u64,
    /// Expiry, milliseconds since the Unix epoch, by the caller's clock.
    pub expires_at_ms: u64,
    /// The family request.
    pub payload: Body,
}

/// The version-1 response body.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct IntentResponseV1 {
    /// Echoes the request's identifier. A client that did not issue this
    /// identifier has no outstanding request for it.
    pub request_id: RequestId,
    /// Echoes the request's family.
    pub intent: u16,
    /// `0` when fulfilled; otherwise an [`IntentError`] status.
    pub status: u16,
    /// The family result, or empty on refusal.
    pub payload: Body,
}

/// `sign-challenge` request: the bytes to be signed.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignChallengeRequestV1 {
    /// Caller-chosen challenge bytes. Bounded by
    /// [`MAX_CHALLENGE_BYTES`]: a challenge is a nonce, not a document, and an
    /// unbounded one is a signing oracle over arbitrary content.
    pub challenge: Body,
}

/// `sign-challenge` result.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SignChallengeResultV1 {
    /// The public key the signature verifies under.
    pub signer_pk: PublicKey,
    /// Ed25519 over the domain-separated challenge transcript.
    pub signature: Signature,
}

/// `issue-device-credential` request: device **public** keys only.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct IssueDeviceCredentialRequestV1 {
    /// The handle the device will speak for.
    pub handle: ShortBytes,
    /// `DSK.public` (`docs/e2ee/ARCHITECTURE.md` §4.1). Generated by the
    /// caller from the OS CSPRNG; the private half never leaves that app.
    pub device_pk: PublicKey,
    /// The X-Wing hybrid KEM public key.
    pub device_kem_pk: Body,
    /// Requested validity start, milliseconds since the Unix epoch.
    pub not_before_ms: u64,
    /// Requested validity end, milliseconds since the Unix epoch.
    pub not_after_ms: u64,
}

/// `issue-device-credential` result.
///
/// The credential is carried as opaque bytes on purpose: it is a
/// `f2z_kt_core::DeviceCredential`, defined once in that crate, and a second
/// definition here would be a second chance to disagree about the bytes the
/// whole directory is built on.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct IssueDeviceCredentialResultV1 {
    /// The canonical encoding of a `DeviceCredential`.
    pub credential: Body,
}

/// `execute-payment` request.
///
/// **These fields are a proposal, not an instruction.** ZUULI re-derives its
/// own payment review from its own wallet state and shows that; the values
/// here only have to survive comparison against it.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ExecutePaymentRequestV1 {
    /// The recipient address, as text.
    pub recipient: ShortBytes,
    /// The amount, in zatoshis.
    pub amount_zatoshis: u64,
    /// The memo, as text. May be empty.
    pub memo: ShortBytes,
    /// The fee the caller expects, in zatoshis. Advisory: the wallet's own fee
    /// rule decides, and a mismatch is shown in the review.
    pub fee_zatoshis: u64,
}

/// `execute-payment` result.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ExecutePaymentResultV1 {
    /// The broadcast transaction's identifier.
    pub txid: TxId,
}

/// The longest challenge `sign-challenge` will carry, in bytes.
///
/// 512 is generous for a nonce and far short of a document. The bound exists
/// because the wallet signs what it is given: an unbounded field turns a
/// login attestation into a general-purpose signing oracle, and the user
/// cannot audit what they are signing by looking at a kilobyte of base64.
pub const MAX_CHALLENGE_BYTES: usize = 512;

/// The longest an intent may be valid for, in milliseconds.
///
/// Five minutes. `#904` is explicit that "nothing here is a continuous grant";
/// a caller that could mint a one-hour intent would have minted exactly that.
/// The ceiling is enforced on the *declared window*, so it binds even when the
/// verifying clock is wrong.
pub const MAX_INTENT_LIFETIME_MS: u64 = 5 * 60 * 1000;

/// The domain label for the request digest a confirmation binds to.
pub const LABEL_INTENT_REQUEST: &[u8] = b"free2z/intent/v1/request";

/// A version-1 family request, resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum IntentBody {
    /// [`Intent::SignChallenge`].
    SignChallenge(SignChallengeRequestV1),
    /// [`Intent::IssueDeviceCredential`].
    IssueDeviceCredential(IssueDeviceCredentialRequestV1),
    /// [`Intent::ExecutePayment`].
    ExecutePayment(ExecutePaymentRequestV1),
}

impl IntentBody {
    /// The family this body belongs to.
    #[must_use]
    pub const fn intent(&self) -> Intent {
        match self {
            Self::SignChallenge(_) => Intent::SignChallenge,
            Self::IssueDeviceCredential(_) => Intent::IssueDeviceCredential,
            Self::ExecutePayment(_) => Intent::ExecutePayment,
        }
    }
}

/// A parsed, validated version-1 request, together with the canonical bytes it
/// re-encodes to.
///
/// There is no constructor that skips [`IntentRequest::parse`], and the
/// canonical bytes are never handed out alongside the *received* bytes — the
/// same structural guarantee `f2z_codec::canonical::Canonicalized` gives, for
/// the same reason: [`IntentRequest::digest`] must cover what the wallet
/// re-encoded, not what arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntentRequest {
    envelope: Canonicalized<IntentRequestEnvelope>,
    request: IntentRequestV1,
    caller: VisibleText,
    purpose: VisibleText,
    body: IntentBody,
}

impl IntentRequest {
    /// Parse an envelope: canonical decode, version refusal, family
    /// resolution, field validation.
    ///
    /// The order is the contract. `version` is checked before `body` is
    /// touched, and `intent` is resolved before `payload` is touched, so an
    /// unknown version or family can never be interpreted as something this
    /// build does know.
    ///
    /// This does **not** check freshness, replay, caller authorization or
    /// confirmation. Those need state or a clock, which this function has
    /// neither of; see [`crate::clock`], [`crate::ledger`], [`crate::caller`]
    /// and [`crate::confirmation`].
    ///
    /// # Errors
    ///
    /// - [`IntentError::Malformed`] for bytes that are not a canonical
    ///   envelope, including trailing data.
    /// - [`IntentError::UnsupportedVersion`] for any version but
    ///   [`crate::PROTOCOL_VERSION`].
    /// - [`IntentError::UnknownIntent`] for an unrecognized family.
    /// - [`IntentError::InvalidValue`] for a field a version-1 request may not
    ///   hold.
    pub fn parse(bytes: &[u8]) -> Result<Self, IntentError> {
        let envelope = decode_canonical::<IntentRequestEnvelope>(bytes)?;
        // THE version gate. Before `body`. See the module note.
        if envelope.value().version != crate::PROTOCOL_VERSION {
            return Err(IntentError::UnsupportedVersion);
        }
        let request =
            decode_canonical::<IntentRequestV1>(envelope.value().body.as_slice())?.into_value();
        // THE family gate. Before `payload`.
        let intent = Intent::from_code(request.intent)?;
        let caller = VisibleText::new(request.caller.as_slice())?;
        let purpose = VisibleText::new(request.purpose.as_slice())?;
        // A window that has no valid instant is malformed rather than merely
        // closed, and a window longer than the ceiling is a continuous grant
        // wearing an intent's clothes.
        if request.expires_at_ms <= request.issued_at_ms {
            return Err(IntentError::InvalidValue);
        }
        let lifetime = request
            .expires_at_ms
            .checked_sub(request.issued_at_ms)
            .ok_or(IntentError::InvalidValue)?;
        if lifetime > MAX_INTENT_LIFETIME_MS {
            return Err(IntentError::InvalidValue);
        }
        let body = decode_family(intent, request.payload.as_slice())?;
        Ok(Self {
            envelope,
            request,
            caller,
            purpose,
            body,
        })
    }

    /// The family.
    #[must_use]
    pub const fn intent(&self) -> Intent {
        self.body.intent()
    }

    /// The one-use identifier.
    #[must_use]
    pub const fn request_id(&self) -> &RequestId {
        &self.request.request_id
    }

    /// The caller's **claimed** identity. Never a credential.
    #[must_use]
    pub const fn claimed_caller(&self) -> &VisibleText {
        &self.caller
    }

    /// The caller's stated purpose, safe to render.
    #[must_use]
    pub const fn purpose(&self) -> &VisibleText {
        &self.purpose
    }

    /// Issuance, milliseconds since the Unix epoch.
    #[must_use]
    pub const fn issued_at_ms(&self) -> u64 {
        self.request.issued_at_ms
    }

    /// Expiry, milliseconds since the Unix epoch.
    #[must_use]
    pub const fn expires_at_ms(&self) -> u64 {
        self.request.expires_at_ms
    }

    /// The resolved family request.
    #[must_use]
    pub const fn body(&self) -> &IntentBody {
        &self.body
    }

    /// `H("free2z/intent/v1/request", canonical envelope bytes)`.
    ///
    /// Over the **re-encoded** envelope, per `WIRE.md` §3.3 step 4. This is
    /// the value a native confirmation binds to, so every field above — the
    /// family, the identifier, the caller, the purpose, the window and the
    /// whole family payload — is inside it. Change any one of them and the
    /// confirmation stops matching.
    #[must_use]
    pub fn digest(&self) -> Digest {
        hash(LABEL_INTENT_REQUEST, self.envelope.bytes())
    }
}

/// Decode and validate a family payload.
fn decode_family(intent: Intent, payload: &[u8]) -> Result<IntentBody, IntentError> {
    Ok(match intent {
        Intent::SignChallenge => {
            let body = decode_canonical::<SignChallengeRequestV1>(payload)?.into_value();
            let length = body.challenge.len();
            if length == 0 || length > MAX_CHALLENGE_BYTES {
                return Err(IntentError::InvalidValue);
            }
            IntentBody::SignChallenge(body)
        }
        Intent::IssueDeviceCredential => {
            let body = decode_canonical::<IssueDeviceCredentialRequestV1>(payload)?.into_value();
            // The handle is text a wallet renders, so it goes through the same
            // gate as every other rendered field. Its *charset* rule belongs to
            // `f2z_kt_core::Handle` and is applied there, at issuance, rather
            // than restated here where it could drift.
            VisibleText::new(body.handle.as_slice())?;
            if body.device_kem_pk.is_empty() || body.not_after_ms <= body.not_before_ms {
                return Err(IntentError::InvalidValue);
            }
            IntentBody::IssueDeviceCredential(body)
        }
        Intent::ExecutePayment => {
            let body = decode_canonical::<ExecutePaymentRequestV1>(payload)?.into_value();
            // A recipient is rendered, so it is gated. An empty memo is legal
            // and is the common case, so it is gated only when present.
            VisibleText::new(body.recipient.as_slice())?;
            if !body.memo.is_empty() {
                VisibleText::new(body.memo.as_slice())?;
            }
            if body.amount_zatoshis == 0 {
                return Err(IntentError::InvalidValue);
            }
            IntentBody::ExecutePayment(body)
        }
    })
}

/// Wrap a version-1 request body in its envelope and encode it.
///
/// The client side of the bridge. Kept here rather than in the client crate so
/// that the encoder and the decoder cannot drift apart.
///
/// # Errors
///
/// [`IntentError::Malformed`] if the body exceeds what its length prefix can
/// describe.
pub fn encode_request(request: &IntentRequestV1) -> Result<Vec<u8>, IntentError> {
    let body = request.encode_canonical()?;
    let envelope = IntentRequestEnvelope {
        version: crate::PROTOCOL_VERSION,
        body: Body::new(body)?,
    };
    Ok(envelope.encode_canonical()?)
}

/// Wrap a version-1 response body in its envelope and encode it.
///
/// # Errors
///
/// As [`encode_request`].
pub fn encode_response(response: &IntentResponseV1) -> Result<Vec<u8>, IntentError> {
    let body = response.encode_canonical()?;
    let envelope = IntentResponseEnvelope {
        version: crate::PROTOCOL_VERSION,
        body: Body::new(body)?,
    };
    Ok(envelope.encode_canonical()?)
}

/// Decode a response envelope with the same version gate the request side
/// uses.
///
/// # Errors
///
/// - [`IntentError::Malformed`] for non-canonical bytes.
/// - [`IntentError::UnsupportedVersion`] for any version but
///   [`crate::PROTOCOL_VERSION`], decided before the body is interpreted.
/// - [`IntentError::UnknownIntent`] if the echoed family is not one this build
///   implements.
pub fn decode_response(bytes: &[u8]) -> Result<IntentResponseV1, IntentError> {
    let envelope = decode_canonical::<IntentResponseEnvelope>(bytes)?;
    if envelope.value().version != crate::PROTOCOL_VERSION {
        return Err(IntentError::UnsupportedVersion);
    }
    let response =
        decode_canonical::<IntentResponseV1>(envelope.value().body.as_slice())?.into_value();
    Intent::from_code(response.intent)?;
    // A refusal carries a status and nothing else; a payload attached to one
    // is a channel that has no defined meaning, so it is refused rather than
    // ignored.
    if response.status != 0 && !response.payload.is_empty() {
        return Err(IntentError::Malformed);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        sample_execute_payment, sample_issue_device_credential, sample_request,
        sample_sign_challenge,
    };

    #[test]
    fn intent_codes_are_dense_and_zero_is_not_a_family() {
        for (index, intent) in Intent::ALL.iter().enumerate() {
            assert_eq!(intent.code(), u16::try_from(index).unwrap() + 1);
            assert_eq!(Intent::from_code(intent.code()), Ok(*intent));
        }
        assert_eq!(Intent::from_code(0), Err(IntentError::UnknownIntent));
        assert_eq!(Intent::from_code(4), Err(IntentError::UnknownIntent));
    }

    #[test]
    fn a_request_round_trips_and_its_digest_covers_every_field() {
        let request = sample_request(sample_sign_challenge());
        let bytes = encode_request(&request).unwrap();
        let parsed = IntentRequest::parse(&bytes).unwrap();
        assert_eq!(parsed.intent(), Intent::SignChallenge);
        assert_eq!(parsed.purpose().as_str(), "Sign in to free2z");

        let mut altered = request.clone();
        altered.purpose = ShortBytes::new(b"Sign in to free2Z".to_vec()).unwrap();
        let altered_bytes = encode_request(&altered).unwrap();
        let altered_parsed = IntentRequest::parse(&altered_bytes).unwrap();
        assert_ne!(
            parsed.digest(),
            altered_parsed.digest(),
            "a one-character purpose change must change the confirmation binding"
        );
    }

    #[test]
    fn every_family_round_trips() {
        for (family, sample) in [
            (Intent::SignChallenge, sample_sign_challenge()),
            (
                Intent::IssueDeviceCredential,
                sample_issue_device_credential(),
            ),
            (Intent::ExecutePayment, sample_execute_payment()),
        ] {
            let bytes = encode_request(&sample_request(sample)).unwrap();
            let parsed = IntentRequest::parse(&bytes).unwrap();
            assert_eq!(parsed.intent(), family);
            assert_eq!(parsed.body().intent(), family);
        }
    }

    #[test]
    fn a_family_payload_from_the_wrong_family_is_refused() {
        // The `intent` code selects which structure `payload` is decoded as,
        // so a payment payload announced as a challenge must not decode into
        // whatever the challenge decoder is willing to accept.
        let (_, payment) = sample_execute_payment();
        let mut request = sample_request((Intent::SignChallenge, payment));
        request.intent = Intent::SignChallenge.code();
        let bytes = encode_request(&request).unwrap();
        assert!(matches!(
            IntentRequest::parse(&bytes),
            Err(IntentError::Malformed | IntentError::InvalidValue)
        ));
    }

    #[test]
    fn trailing_bytes_are_malformed() {
        let mut bytes = encode_request(&sample_request(sample_sign_challenge())).unwrap();
        bytes.push(0);
        assert_eq!(IntentRequest::parse(&bytes), Err(IntentError::Malformed));
    }

    #[test]
    fn a_refusal_may_not_carry_a_payload() {
        let response = IntentResponseV1 {
            request_id: RequestId::new([7u8; 32]),
            intent: Intent::SignChallenge.code(),
            status: IntentError::Expired.status(),
            payload: Body::new(b"anything".to_vec()).unwrap(),
        };
        let bytes = encode_response(&response).unwrap();
        assert_eq!(decode_response(&bytes), Err(IntentError::Malformed));
    }

    #[test]
    fn an_over_long_window_is_refused_regardless_of_the_verifying_clock() {
        let mut request = sample_request(sample_sign_challenge());
        request.expires_at_ms = request.issued_at_ms + MAX_INTENT_LIFETIME_MS + 1;
        let bytes = encode_request(&request).unwrap();
        assert_eq!(IntentRequest::parse(&bytes), Err(IntentError::InvalidValue));
    }
}
