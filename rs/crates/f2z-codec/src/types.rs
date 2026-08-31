//! Newtypes for the byte strings the protocol moves around, and the redacting
//! `Debug` that keeps them out of logs.
//!
//! Every type here wraps bytes that are either secret (a payload is
//! ciphertext), capability-bearing (a queue address *is* the capability —
//! `ARCHITECTURE.md` §6.2), or linkable (a per-queue key identifies a
//! conversation to anyone who has seen it elsewhere). None of them may render
//! its contents through `Debug`.
//!
//! That is not a style preference. `--log-level trace` on a relay whose frames
//! derive `Debug` normally produces a plaintext archive of every capability it
//! has ever been shown, written by the operator, to disk, at rest, for as long
//! as log rotation keeps it. The redaction is the mechanism that makes the
//! metadata claims of [ADR 0004] survive contact with an operator who turns
//! logging up while debugging.
//!
//! [ADR 0004]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0004-metadata-ambition.md

use alloc::vec::Vec;
use core::fmt;

use tls_codec::{
    DeserializeBytes, Error as TlsError, SerializeBytes, Size, TlsByteVecU8, TlsByteVecU16,
    TlsByteVecU24,
};

use crate::error::CodecError;

/// Declare a fixed-width byte newtype with a redacting `Debug` and the three
/// `tls_codec` traits delegated to `[u8; N]`.
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

            /// The all-zero value.
            ///
            /// Not a placeholder: `WIRE.md` §5.1 requires 32 zero bytes in the
            /// transcript's `address` for `CREATE_QUEUE`, and §5.3 requires 32
            /// zero bytes for `channel_binding` in `none` mode.
            #[must_use]
            pub const fn zero() -> Self {
                Self([0u8; $len])
            }

            /// Borrow the bytes. Callers that log these have defeated the point
            /// of this module.
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// Whether every byte is zero.
            #[must_use]
            pub fn is_zero(&self) -> bool {
                self.0.iter().all(|byte| *byte == 0)
            }

            /// Wrap a slice of exactly the right length.
            ///
            /// # Errors
            ///
            /// [`CodecError::InvalidValue`] if the slice is a different length.
            pub fn from_slice(bytes: &[u8]) -> Result<Self, CodecError> {
                let array: [u8; $len] = bytes.try_into().map_err(|_| CodecError::InvalidValue)?;
                Ok(Self(array))
            }
        }

        impl From<[u8; $len]> for $name {
            fn from(bytes: [u8; $len]) -> Self {
                Self(bytes)
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }

        // The whole point of this module. Never `{:?}` the bytes, and never
        // offer an escape hatch that renders them either — an alternate
        // formatter would be found and used.
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
    /// A queue address: `QueueSendAddr`, `QueueRecvAddr` or the published
    /// `contact_addr`. `ARCHITECTURE.md` §6.2 — an opaque random identifier,
    /// and the capability itself.
    QueueAddress,
    32
);

opaque_fixed!(
    /// An Ed25519 public key: a queue's `recv_key` or `send_key`, or a relay's
    /// `relay_identity_pk`.
    PublicKey,
    32
);

opaque_fixed!(
    /// An Ed25519 signature, over a [`CommandTranscript`] or over a
    /// `Capabilities` document.
    ///
    /// [`CommandTranscript`]: crate::transcript::CommandTranscript
    Signature,
    64
);

opaque_fixed!(
    /// A per-command CSPRNG nonce (`WIRE.md` §5.1, §5.5). 16 bytes.
    Nonce,
    16
);

opaque_fixed!(
    /// A `HELLO` client nonce, or any other 32-byte one-shot random value.
    Challenge,
    32
);

opaque_fixed!(
    /// A proof-of-work salt (`WIRE.md` §13.1). 16 bytes.
    Salt,
    16
);

opaque_fixed!(
    /// A BLAKE2b-256 digest produced by [`crate::hash`].
    Digest,
    32
);

opaque_fixed!(
    /// `relay_id = H("free2z/relay/v1/relay-id", relay_identity_pk)`
    /// (`WIRE.md` §5.2).
    RelayId,
    32
);

opaque_fixed!(
    /// The TLS 1.3 exporter value of `WIRE.md` §5.3, or 32 zero bytes in
    /// `channel_binding_mode: none`.
    ChannelBinding,
    32
);

/// A variable-length ciphertext payload, `opaque payload<0..2^24-1>`.
///
/// The relay never looks inside one. Its `Debug` reports the length and nothing
/// else — the length is public policy (it must be one of the relay's published
/// `padding_sizes`, `WIRE.md` §9) while the bytes are the thing the whole
/// system exists to keep from the operator.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Payload(TlsByteVecU24);

impl Payload {
    /// The largest payload the `<0..2^24-1>` length prefix can describe.
    pub const MAX_LEN: usize = (1usize << 24) - 1;

    /// Wrap bytes as a payload.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the bytes exceed [`Payload::MAX_LEN`].
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, CodecError> {
        let bytes = bytes.into();
        if bytes.len() > Self::MAX_LEN {
            return Err(CodecError::Overflow);
        }
        Ok(Self(TlsByteVecU24::new(bytes)))
    }

    /// The payload bytes.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    /// The payload length in bytes. This is what [`PaddingBuckets`] judges.
    ///
    /// [`PaddingBuckets`]: crate::padding::PaddingBuckets
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    /// Whether the payload is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }
}

impl fmt::Debug for Payload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The length is published policy; the bytes are not.
        write!(f, "Payload(<redacted; {} bytes>)", self.len())
    }
}

impl Size for Payload {
    fn tls_serialized_len(&self) -> usize {
        self.0.tls_serialized_len()
    }
}

impl SerializeBytes for Payload {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize_bytes()
    }
}

impl DeserializeBytes for Payload {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = TlsByteVecU24::tls_deserialize_bytes(bytes)?;
        Ok((Self(inner), rest))
    }
}

/// A command, response or push body: `opaque body<0..2^24-1>`.
///
/// Opaque at the framing layer — the typed structure inside is decoded
/// separately, and canonically, per §3.3. It is a newtype rather than a bare
/// `TlsByteVecU24` for one reason: `tls_codec`'s own byte vectors derive
/// `Debug` and render their contents as a list of decimal integers, so a frame
/// that contained one would print every byte of an `APPEND` payload the moment
/// anyone logged it. A decimal dump is a dump.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Body(TlsByteVecU24);

impl Body {
    /// The largest body the `<0..2^24-1>` length prefix can describe.
    pub const MAX_LEN: usize = (1usize << 24) - 1;

    /// Wrap body bytes.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the bytes exceed [`Body::MAX_LEN`].
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, CodecError> {
        let bytes = bytes.into();
        if bytes.len() > Self::MAX_LEN {
            return Err(CodecError::Overflow);
        }
        Ok(Self(TlsByteVecU24::new(bytes)))
    }

    /// The body bytes.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    /// The body length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    /// Whether the body is empty. Several commands have empty bodies by rule
    /// (§6.2, §6.3).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Body(<redacted; {} bytes>)", self.len())
    }
}

impl Size for Body {
    fn tls_serialized_len(&self) -> usize {
        self.0.tls_serialized_len()
    }
}

impl SerializeBytes for Body {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize_bytes()
    }
}

impl DeserializeBytes for Body {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = TlsByteVecU24::tls_deserialize_bytes(bytes)?;
        Ok((Self(inner), rest))
    }
}

/// One MLS `KeyPackage`, framed as an `MlsMessage`: `opaque key_package<1..2^16-1>`.
///
/// `WIRE.md` §12.6. The relay stores these and hands one out; it never parses
/// one and could not check it if it tried. **The length prefix is the size
/// cap**: a `u16` prefix cannot describe more than 65 535 bytes, and #385
/// measured a real package under
/// `MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519` at 2 647 bytes, so the
/// encoding itself bounds what a publisher can make a relay hold per package.
/// That is deliberate: a `<0..2^24-1>` prefix would have put a 16 MiB blob
/// behind a single proof-of-work stamp.
///
/// The `Debug` redacts. A key package is public material — it is *published*,
/// and anyone who asks gets one — but it names a device, and §12.6's whole
/// privacy argument is about who learns that a particular device is being
/// contacted. A trace log full of them would be a linkability corpus written by
/// the operator, which is the hazard this module exists for.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct KeyPackage(TlsByteVecU16);

impl KeyPackage {
    /// The largest package the `<1..2^16-1>` length prefix can describe.
    pub const MAX_LEN: usize = (1usize << 16) - 1;

    /// Wrap key-package bytes.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the bytes exceed [`KeyPackage::MAX_LEN`],
    /// [`CodecError::InvalidValue`] if they are empty — the vector is
    /// `<1..2^16-1>`, and an empty package is a publisher telling a relay to
    /// hold nothing while paying nothing for it.
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, CodecError> {
        let bytes = bytes.into();
        if bytes.is_empty() {
            return Err(CodecError::InvalidValue);
        }
        if bytes.len() > Self::MAX_LEN {
            return Err(CodecError::Overflow);
        }
        Ok(Self(TlsByteVecU16::new(bytes)))
    }

    /// The package bytes.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    /// The package length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    /// Whether the package is empty. Only reachable through a decode, which
    /// [`KeyPackage::tls_deserialize_bytes`] refuses.
    ///
    /// [`KeyPackage::tls_deserialize_bytes`]: tls_codec::DeserializeBytes::tls_deserialize_bytes
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }
}

impl fmt::Debug for KeyPackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "KeyPackage(<redacted; {} bytes>)", self.len())
    }
}

impl Size for KeyPackage {
    fn tls_serialized_len(&self) -> usize {
        self.0.tls_serialized_len()
    }
}

impl SerializeBytes for KeyPackage {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize_bytes()
    }
}

impl DeserializeBytes for KeyPackage {
    /// `<1..2^16-1>`, and the lower bound is enforced on decode.
    ///
    /// Without this an empty package decodes, re-encodes to the same bytes, and
    /// therefore passes §3.3's re-encode-equality check — so the zero-length
    /// case has to be refused *here* rather than by a validator somebody
    /// remembers to call.
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = TlsByteVecU16::tls_deserialize_bytes(bytes)?;
        if inner.as_slice().is_empty() {
            return Err(TlsError::DecodingError(alloc::string::String::from(
                "a key package vector is <1..2^16-1>",
            )));
        }
        Ok((Self(inner), rest))
    }
}

/// A short, human-facing, operator-published string: `opaque x<0..255>`.
///
/// Used for the transcript label and for the operator fields of the capability
/// document (§11.1). Not redacted — these are exactly the values the document
/// exists to publish — but still length-checked so a caller cannot build a
/// structure that will not encode.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct ShortBytes(TlsByteVecU8);

impl ShortBytes {
    /// The largest value the `<0..255>` length prefix can describe.
    pub const MAX_LEN: usize = 255;

    /// Wrap bytes.
    ///
    /// # Errors
    ///
    /// [`CodecError::Overflow`] if the bytes exceed [`ShortBytes::MAX_LEN`].
    pub fn new(bytes: impl Into<Vec<u8>>) -> Result<Self, CodecError> {
        let bytes = bytes.into();
        if bytes.len() > Self::MAX_LEN {
            return Err(CodecError::Overflow);
        }
        Ok(Self(TlsByteVecU8::new(bytes)))
    }

    /// The bytes.
    #[must_use]
    pub fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    /// The length in bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.as_slice().len()
    }

    /// Whether the value is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.as_slice().is_empty()
    }
}

impl fmt::Debug for ShortBytes {
    /// Printable ASCII renders; anything else redacts.
    ///
    /// The two uses of this type pull in opposite directions. The capability
    /// document's operator fields (§11.1) exist to be read by a human, and
    /// hiding them would defeat the document. `GET_CHALLENGE`'s `scope` (§6.1)
    /// is a 32-byte contact address. So the rule is on the *content*, not on the
    /// field: text prints, bytes do not — and printing is escaped, so an
    /// operator name containing a newline cannot forge a log line.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let bytes = self.0.as_slice();
        let printable = !bytes.is_empty() && bytes.iter().all(|byte| (0x20..=0x7e).contains(byte));
        if !printable {
            return write!(f, "ShortBytes(<redacted; {} bytes>)", bytes.len());
        }
        f.write_str("ShortBytes(")?;
        for byte in bytes {
            for escaped in core::ascii::escape_default(*byte) {
                f.write_str(core::str::from_utf8(&[escaped]).unwrap_or("?"))?;
            }
        }
        f.write_str(")")
    }
}

impl Size for ShortBytes {
    fn tls_serialized_len(&self) -> usize {
        self.0.tls_serialized_len()
    }
}

impl SerializeBytes for ShortBytes {
    fn tls_serialize_bytes(&self) -> Result<Vec<u8>, TlsError> {
        self.0.tls_serialize_bytes()
    }
}

impl DeserializeBytes for ShortBytes {
    fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
        let (inner, rest) = TlsByteVecU8::tls_deserialize_bytes(bytes)?;
        Ok((Self(inner), rest))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::format;

    #[test]
    fn fixed_newtypes_round_trip() {
        let address = QueueAddress::new([7u8; 32]);
        let encoded = SerializeBytes::tls_serialize_bytes(&address).unwrap();
        assert_eq!(encoded, [7u8; 32]);
        let (decoded, rest) = QueueAddress::tls_deserialize_bytes(&encoded).unwrap();
        assert_eq!(decoded, address);
        assert!(rest.is_empty());
    }

    #[test]
    fn zero_is_the_absent_address_of_section_5_1() {
        assert!(QueueAddress::zero().is_zero());
        assert!(!QueueAddress::new([1u8; 32]).is_zero());
        assert!(ChannelBinding::zero().is_zero());
    }

    #[test]
    fn payload_rejects_more_than_the_prefix_can_describe() {
        assert_eq!(Payload::new(alloc::vec![0u8; 8]).unwrap().len(), 8);
        assert_eq!(
            ShortBytes::new(alloc::vec![0u8; 256]),
            Err(CodecError::Overflow)
        );
    }

    #[test]
    fn debug_never_renders_bytes() {
        assert_eq!(
            format!("{:?}", QueueAddress::new([0xabu8; 32])),
            "QueueAddress(<redacted>)"
        );
        assert_eq!(
            format!("{:?}", Payload::new(alloc::vec![0xcdu8; 1024]).unwrap()),
            "Payload(<redacted; 1024 bytes>)"
        );
    }
}
